/**
 * 飞书 (Feishu/Lark) Adapter for Claude Code Desktop
 *
 * 基于 @larksuiteoapi/node-sdk 的轻量飞书 Bot，直连服务端 /ws/:sessionId。
 * 使用 WebSocket 长连接接收事件，无需公网地址。
 *
 * 启动：FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx bun run feishu/index.ts
 */

import * as Lark from '@larksuiteoapi/node-sdk'
import * as path from 'node:path'
import { WsBridge, type ServerMessage } from '../common/ws-bridge.js'
import { MessageBuffer } from '../common/message-buffer.js'
import { MessageDedup } from '../common/message-dedup.js'
import { enqueue } from '../common/chat-queue.js'
import { loadConfig } from '../common/config.js'
import {
  formatImHelp,
  formatImStatus,
  splitMessage,
  truncateInput,
} from '../common/format.js'
import { SessionStore } from '../common/session-store.js'
import { AdapterHttpClient, type RecentProject } from '../common/http-client.js'
import { isAllowedUser, tryPair } from '../common/pairing.js'

// ---------- init ----------

const config = loadConfig()
if (!config.feishu.appId || !config.feishu.appSecret) {
  console.error('[Feishu] Missing FEISHU_APP_ID / FEISHU_APP_SECRET. Set env or ~/.claude/adapters.json')
  process.exit(1)
}

const larkClient = new Lark.Client({
  appId: config.feishu.appId,
  appSecret: config.feishu.appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
})

const bridge = new WsBridge(config.serverUrl, 'feishu')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const httpClient = new AdapterHttpClient(config.serverUrl)

// Track state per chat
type ChatState = {
  cardId?: string
  sequence: number
  replyMessageId?: string
}
const chatStates = new Map<string, ChatState>()
const buffers = new Map<string, MessageBuffer>()
const accumulatedText = new Map<string, string>()
const pendingProjectSelection = new Map<string, boolean>()
const runtimeStates = new Map<string, ChatRuntimeState>()

// Bot's own open_id (resolved on first message)
let botOpenId: string | null = null
// WSClient reference for graceful shutdown
let wsClient: InstanceType<typeof Lark.WSClient> | null = null

type ChatRuntimeState = {
  state: 'idle' | 'thinking' | 'streaming' | 'tool_executing' | 'permission_pending'
  verb?: string
  model?: string
  pendingPermissionCount: number
}

// ---------- helpers ----------

function getChatState(chatId: string): ChatState {
  let state = chatStates.get(chatId)
  if (!state) {
    state = { sequence: 0 }
    chatStates.set(chatId, state)
  }
  return state
}

function getBuffer(chatId: string): MessageBuffer {
  let buf = buffers.get(chatId)
  if (!buf) {
    buf = new MessageBuffer(async (text, isComplete) => {
      await flushToFeishu(chatId, text, isComplete)
    })
    buffers.set(chatId, buf)
  }
  return buf
}

function getRuntimeState(chatId: string): ChatRuntimeState {
  let state = runtimeStates.get(chatId)
  if (!state) {
    state = { state: 'idle', pendingPermissionCount: 0 }
    runtimeStates.set(chatId, state)
  }
  return state
}

function clearTransientChatState(chatId: string): void {
  chatStates.delete(chatId)
  accumulatedText.delete(chatId)
  buffers.get(chatId)?.reset()
  const runtime = getRuntimeState(chatId)
  runtime.state = 'idle'
  runtime.verb = undefined
  runtime.pendingPermissionCount = 0
}

async function ensureExistingSession(chatId: string): Promise<{ sessionId: string; workDir: string } | null> {
  const stored = sessionStore.get(chatId)
  if (!stored) return null

  if (!bridge.hasSession(chatId)) {
    bridge.connectSession(chatId, stored.sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) return null
  }

  return stored
}

async function buildStatusText(chatId: string): Promise<string> {
  const stored = await ensureExistingSession(chatId)
  if (!stored) return formatImStatus(null)

  const runtime = getRuntimeState(chatId)
  let projectName = path.basename(stored.workDir) || stored.workDir
  let branch: string | null = null

  try {
    const gitInfo = await httpClient.getGitInfo(stored.sessionId)
    projectName = gitInfo.repoName || path.basename(gitInfo.workDir) || projectName
    branch = gitInfo.branch
  } catch {
    // Ignore git lookup failures and fall back to stored workDir
  }

  let taskCounts:
    | {
        total: number
        pending: number
        inProgress: number
        completed: number
      }
    | undefined

  try {
    const tasks = await httpClient.getTasksForSession(stored.sessionId)
    if (tasks.length > 0) {
      taskCounts = {
        total: tasks.length,
        pending: tasks.filter((task) => task.status === 'pending').length,
        inProgress: tasks.filter((task) => task.status === 'in_progress').length,
        completed: tasks.filter((task) => task.status === 'completed').length,
      }
    }
  } catch {
    // Ignore task lookup failures in IM status summary
  }

  return formatImStatus({
    sessionId: stored.sessionId,
    projectName,
    branch,
    model: runtime.model,
    state: runtime.state,
    verb: runtime.verb,
    pendingPermissionCount: runtime.pendingPermissionCount,
    taskCounts,
  })
}

/** Send a text message (post format). */
async function sendText(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
  const content = JSON.stringify({
    zh_cn: { content: [[{ tag: 'md', text }]] },
  })

  try {
    if (replyToMessageId) {
      const resp = await larkClient.im.message.reply({
        path: { message_id: replyToMessageId },
        data: { content, msg_type: 'post' },
      })
      return resp.data?.message_id
    }
    const resp = await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'post' as const,
        content,
      },
    })
    return resp.data?.message_id
  } catch (err) {
    console.error('[Feishu] Send text error:', err)
    return undefined
  }
}

/** Send an interactive card (for permission requests). */
async function sendCard(chatId: string, card: Record<string, unknown>): Promise<string | undefined> {
  try {
    const resp = await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
    return resp.data?.message_id
  } catch (err) {
    console.error('[Feishu] Send card error:', err)
    return undefined
  }
}

/** Build a simple streaming text card (Schema 1.0, patchable via im.message.patch). */
function buildStreamingCard(text: string): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    elements: [
      { tag: 'markdown', content: text || ' ' },
    ],
  }
}

/** Update a streaming card message's content (patch).
 *  Note: im.message.patch only works on interactive cards, so the source
 *  message MUST have been sent via sendCard(buildStreamingCard(...)). */
async function patchMessage(messageId: string, text: string): Promise<void> {
  try {
    await larkClient.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(buildStreamingCard(text)),
      },
    })
  } catch (err) {
    // patch may fail (rate limit, message expired, etc.) — log and ignore
    console.error('[Feishu] patchMessage error:', err instanceof Error ? err.message : err)
  }
}

/** Pretty-print an absolute path for IM display.
 *  - Replace $HOME with `~`
 *  - Middle-truncate if it's still very long, keeping the project tail visible */
function prettyPath(realPath: string, maxLen = 64): string {
  const home = process.env.HOME
  let p = realPath
  if (home) {
    if (p === home) return '~'
    if (p.startsWith(`${home}/`)) p = `~${p.slice(home.length)}`
  }
  if (p.length <= maxLen) return p
  // Project name lives at the tail — keep more of the tail than the head.
  const tailLen = Math.floor(maxLen * 0.65)
  const headLen = maxLen - tailLen - 1
  return `${p.slice(0, headLen)}…${p.slice(-tailLen)}`
}

/** Build an interactive project picker card — mobile-first layout.
 *
 *  Design: one column_set per project with exactly 2 columns:
 *    - Col 1 (weighted): project info (title markdown + small grey path)
 *    - Col 2 (auto):     "选择" button, vertically centered
 *
 *  Only 2 columns with one weighted + one auto means the weight distribution
 *  is trivial (auto takes its natural width, weighted takes the rest). This
 *  avoids the layout issues seen in 3-column attempts. */
function buildProjectPickerCard(projects: RecentProject[]): Record<string, unknown> {
  const items = projects.slice(0, 10)
  const total = projects.length
  const subtitleText =
    total > items.length
      ? `共 ${total} 个最近项目，显示前 ${items.length}`
      : `共 ${total} 个最近项目`

  const rows = items.map((p, i) => {
    const branch = p.branch ? `  ·  *${p.branch}*` : ''
    return {
      tag: 'column_set',
      flex_mode: 'stretch',
      horizontal_spacing: '8px',
      margin: i === 0 ? '0px 0 0 0' : '10px 0 0 0',
      columns: [
        // Col 1 — project info (title + notation path, stacked)
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'center',
          elements: [
            {
              tag: 'markdown',
              content: `**${p.projectName}**${branch}`,
            },
            {
              tag: 'markdown',
              content: prettyPath(p.realPath, 56),
              text_size: 'notation',
              margin: '2px 0 0 0',
            },
          ],
        },
        // Col 2 — action button (auto width, vertically centered)
        {
          tag: 'column',
          width: 'auto',
          vertical_align: 'center',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '选择' },
              type: i === 0 ? 'primary' : 'default',
              size: 'small',
              value: {
                action: 'pick_project',
                realPath: p.realPath,
                projectName: p.projectName,
              },
            },
          ],
        },
      ],
    }
  })

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: { tag: 'plain_text', content: '📁 选择项目' },
      subtitle: { tag: 'plain_text', content: subtitleText },
      template: 'blue',
    },
    body: {
      elements: [
        ...rows,
        { tag: 'hr', margin: '14px 0 0 0' },
        {
          tag: 'markdown',
          content: '💡 点击右侧 **选择** 按钮，或发送 `/new <项目名>`',
          text_size: 'notation',
          margin: '6px 0 0 0',
        },
      ],
    },
  }
}

/** Build a permission request card. */
function buildPermissionCard(toolName: string, input: unknown, requestId: string): Record<string, unknown> {
  const truncated = truncateInput(input, 300)

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔐 需要权限确认' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'markdown',
        content: `**工具**: ${toolName}\n**内容**:\n\`\`\`\n${truncated}\n\`\`\``,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 允许' },
            type: 'primary',
            value: { action: 'permit', requestId, allowed: true },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { action: 'permit', requestId, allowed: false },
          },
        ],
      },
    ],
  }
}

async function flushToFeishu(chatId: string, newText: string, isComplete: boolean): Promise<void> {
  const prev = accumulatedText.get(chatId) ?? ''
  const fullText = prev + newText
  accumulatedText.set(chatId, fullText)

  const state = getChatState(chatId)

  if (state.replyMessageId) {
    const displayText = fullText + (isComplete ? '' : ' ▍')
    await patchMessage(state.replyMessageId, displayText)
  }

  if (isComplete) {
    if (!state.replyMessageId && fullText.trim()) {
      const chunks = splitMessage(fullText, 30000)
      for (const chunk of chunks) {
        await sendText(chatId, chunk)
      }
    }
    accumulatedText.delete(chatId)
    chatStates.delete(chatId)
    buffers.get(chatId)?.reset()
  }
}

// ---------- session management ----------

async function ensureSession(chatId: string): Promise<boolean> {
  if (bridge.hasSession(chatId)) return true

  const stored = sessionStore.get(chatId)
  if (stored) {
    bridge.connectSession(chatId, stored.sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    return await bridge.waitForOpen(chatId)
  }

  const workDir = config.defaultProjectDir
  if (workDir) {
    return await createSessionForChat(chatId, workDir)
  }

  await showProjectPicker(chatId)
  return false
}

async function createSessionForChat(chatId: string, workDir: string): Promise<boolean> {
  try {
    const sessionId = await httpClient.createSession(workDir)
    sessionStore.set(chatId, sessionId, workDir)
    bridge.connectSession(chatId, sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) {
      await sendText(chatId, '⚠️ 连接服务器超时，请重试。')
      return false
    }
    return true
  } catch (err) {
    await sendText(chatId, `❌ 无法创建会话: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function showProjectPicker(chatId: string): Promise<void> {
  try {
    const projects = await httpClient.listRecentProjects()
    if (projects.length === 0) {
      await sendText(chatId,
        '没有找到最近的项目。请先在 Desktop App 中打开一个项目，或在设置中配置默认项目。')
      return
    }
    pendingProjectSelection.set(chatId, true)
    const cardId = await sendCard(chatId, buildProjectPickerCard(projects))
    if (!cardId) {
      // Fallback to text picker if card delivery failed (permissions, etc.)
      const lines = projects.slice(0, 10).map((p, i) =>
        `${i + 1}. **${p.projectName}**${p.branch ? ` (${p.branch})` : ''}\n   ${p.realPath}`
      )
      await sendText(chatId, `选择项目（回复编号）：\n\n${lines.join('\n\n')}\n\n💡 下次可直接 /new <编号或名称> 快速新建会话`)
    }
  } catch (err) {
    await sendText(chatId, `❌ 无法获取项目列表: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function startNewSession(chatId: string, query?: string): Promise<void> {
  bridge.resetSession(chatId)
  sessionStore.delete(chatId)
  chatStates.delete(chatId)
  accumulatedText.delete(chatId)
  buffers.get(chatId)?.reset()
  buffers.delete(chatId)
  pendingProjectSelection.delete(chatId)
  runtimeStates.delete(chatId)

  if (query) {
    try {
      const { project, ambiguous } = await httpClient.matchProject(query)
      if (project) {
        const ok = await createSessionForChat(chatId, project.realPath)
        if (ok) {
          await sendText(chatId,
            `✅ 已新建会话：**${project.projectName}**${project.branch ? ` (${project.branch})` : ''}`)
        }
        return
      }
      if (ambiguous) {
        const list = ambiguous.map((p, i) => `${i + 1}. **${p.projectName}** — ${p.realPath}`).join('\n')
        await sendText(chatId, `匹配到多个项目，请更精确：\n\n${list}`)
        return
      }
      await sendText(chatId, `未找到匹配 "${query}" 的项目。发送 /projects 查看完整列表。`)
    } catch (err) {
      await sendText(chatId, `❌ ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    const workDir = config.defaultProjectDir
    if (workDir) {
      const ok = await createSessionForChat(chatId, workDir)
      if (ok) {
        await sendText(chatId, '✅ 已新建会话，可以开始对话了。')
      }
    } else {
      await showProjectPicker(chatId)
    }
  }
}

// ---------- server message handler ----------

async function handleServerMessage(chatId: string, msg: ServerMessage): Promise<void> {
  const buf = getBuffer(chatId)
  const state = getChatState(chatId)
  const runtime = getRuntimeState(chatId)

  switch (msg.type) {
    case 'connected':
      break

    case 'status':
      runtime.state = msg.state
      runtime.verb = typeof msg.verb === 'string' ? msg.verb : undefined
      if (msg.state === 'thinking' && !state.replyMessageId) {
        const mid = await sendCard(chatId, buildStreamingCard('💭 思考中...'))
        if (mid) {
          state.replyMessageId = mid
          accumulatedText.set(chatId, '')
        }
      }
      break

    case 'content_start':
      if (msg.blockType === 'text') {
        if (!state.replyMessageId) {
          const mid = await sendCard(chatId, buildStreamingCard('▍'))
          if (mid) {
            state.replyMessageId = mid
            accumulatedText.set(chatId, '')
          }
        }
      } else if (msg.blockType === 'tool_use') {
        // Finalize current text before tool calls,
        // so text after tools gets a fresh message
        await buf.complete()
        // If reply still exists (buffer was already empty), clean up directly
        if (state.replyMessageId) {
          const text = accumulatedText.get(chatId)
          if (text?.trim()) {
            await patchMessage(state.replyMessageId, text)
          }
          accumulatedText.delete(chatId)
          chatStates.delete(chatId)
          buffers.get(chatId)?.reset()
        }
      }
      break

    case 'content_delta':
      if (msg.text) {
        buf.append(msg.text)
      }
      break

    case 'thinking':
      if (state.replyMessageId) {
        await patchMessage(state.replyMessageId, `💭 ${msg.text.slice(0, 500)}...`)
      }
      break

    case 'tool_use_complete':
      // Tool details are noise for IM users; visible in Desktop if needed.
      break

    case 'tool_result':
      // Tool errors are handled internally by the AI (retries etc.)
      // No need to notify the user for every failed attempt.
      break

    case 'permission_request': {
      runtime.pendingPermissionCount += 1
      runtime.state = 'permission_pending'
      const card = buildPermissionCard(msg.toolName, msg.input, msg.requestId)
      await sendCard(chatId, card)
      break
    }

    case 'message_complete':
      runtime.state = 'idle'
      runtime.verb = undefined
      await buf.complete()
      // Ensure state is always cleaned up even if buffer was already empty
      if (state.replyMessageId) {
        const text = accumulatedText.get(chatId)
        if (text?.trim()) {
          await patchMessage(state.replyMessageId, text)
        }
        accumulatedText.delete(chatId)
        chatStates.delete(chatId)
        buffers.get(chatId)?.reset()
      }
      break

    case 'error':
      runtime.state = 'idle'
      runtime.verb = undefined
      await sendText(chatId, `❌ ${msg.message}`)
      break

    case 'system_notification':
      if (msg.subtype === 'init' && msg.data && typeof msg.data === 'object') {
        const model = (msg.data as Record<string, unknown>).model
        if (typeof model === 'string' && model.trim()) {
          runtime.model = model
        }
      }
      break
  }
}

// ---------- extract message text ----------

function extractText(content: string, msgType: string): string | null {
  try {
    const parsed = JSON.parse(content)
    if (msgType === 'text') {
      return parsed.text ?? null
    }
    if (msgType === 'post') {
      const zhContent = parsed.zh_cn?.content ?? parsed.en_us?.content ?? []
      return zhContent
        .flat()
        .filter((n: any) => n.tag === 'text' || n.tag === 'md')
        .map((n: any) => n.text ?? n.content ?? '')
        .join('')
        .trim() || null
    }
    return null
  } catch {
    return null
  }
}

function isBotMentioned(mentions?: Array<{ id?: { open_id?: string } }>): boolean {
  if (!mentions || !botOpenId) return false
  return mentions.some((m) => m.id?.open_id === botOpenId)
}

function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, '').trim()
}

// ---------- event handlers ----------

async function handleMessage(data: any): Promise<void> {
  const event = data as {
    sender?: { sender_id?: { open_id?: string } }
    message?: {
      message_id?: string
      chat_id?: string
      chat_type?: string
      content?: string
      message_type?: string
      mentions?: Array<{ id?: { open_id?: string }; name?: string }>
    }
  }

  const messageId = event.message?.message_id
  const chatId = event.message?.chat_id
  const senderOpenId = event.sender?.sender_id?.open_id
  const chatType = event.message?.chat_type
  const content = event.message?.content
  const msgType = event.message?.message_type

  if (!messageId || !chatId || !senderOpenId || !content || !msgType) return

  if (!dedup.tryRecord(messageId)) return

  // 只处理私聊
  if (chatType === 'p2p') {
    if (!isAllowedUser('feishu', senderOpenId)) {
      // 尝试配对
      const pairText = extractText(content, msgType)
      if (pairText) {
        const success = tryPair(pairText.trim(), { userId: senderOpenId, displayName: 'Feishu User' }, 'feishu')
        if (success) {
          await sendText(chatId, '✅ 配对成功！现在可以开始聊天了。\n\n发送消息即可与 Claude 对话。')
        } else {
          await sendText(chatId, '🔒 未授权。请在 Claude Code 桌面端生成配对码后发送给我。')
        }
      }
      return
    }
  } else {
    // 群聊不处理
    return
  }

  let text = extractText(content, msgType)
  if (!text) return

  text = stripMentions(text)
  if (!text) return

  // Handle commands
  if (text === '/new' || text === '新会话' || text.startsWith('/new ')) {
    const arg = text.startsWith('/new ') ? text.slice(5).trim() : ''
    await startNewSession(chatId, arg || undefined)
    return
  }
  if (text === '/help' || text === '帮助') {
    await sendText(chatId, formatImHelp())
    return
  }
  if (text === '/status' || text === '状态') {
    await sendText(chatId, await buildStatusText(chatId))
    return
  }
  if (text === '/clear' || text === '清空') {
    const stored = await ensureExistingSession(chatId)
    if (!stored) {
      await sendText(chatId, formatImStatus(null))
      return
    }
    clearTransientChatState(chatId)
    const sent = bridge.sendUserMessage(chatId, '/clear')
    if (!sent) {
      await sendText(chatId, '⚠️ 无法发送 /clear，请先发送 /new 重新连接会话。')
      return
    }
    await sendText(chatId, '🧹 已清空当前会话上下文。')
    return
  }
  if (text === '/stop' || text === '停止') {
    const stored = await ensureExistingSession(chatId)
    if (!stored) {
      await sendText(chatId, formatImStatus(null))
      return
    }
    bridge.sendStopGeneration(chatId)
    await sendText(chatId, '⏹ 已发送停止信号。')
    return
  }
  if (text === '/projects' || text === '项目列表') {
    await showProjectPicker(chatId)
    return
  }

  // Check if user is responding to project selection
  if (pendingProjectSelection.has(chatId)) {
    await startNewSession(chatId, text.trim())
    return
  }

  // Normal message flow
  enqueue(chatId, async () => {
    const ready = await ensureSession(chatId)
    if (ready) {
      const sent = bridge.sendUserMessage(chatId, text!)
      if (!sent) {
        await sendText(chatId, '⚠️ 消息发送失败，连接可能已断开。请发送 /new 重新开始。')
      }
    }
  })
}

async function handleCardAction(data: any): Promise<any> {
  const event = data as {
    operator?: { open_id?: string }
    action?: {
      value?: {
        action?: string
        requestId?: string
        allowed?: boolean
        realPath?: string
        projectName?: string
      }
    }
    context?: { open_chat_id?: string }
  }

  const action = event.action?.value?.action
  const chatId = event.context?.open_chat_id
  if (!chatId) return

  if (action === 'permit') {
    const requestId = event.action?.value?.requestId
    const allowed = event.action?.value?.allowed ?? false
    if (!requestId) return

    bridge.sendPermissionResponse(chatId, requestId, allowed)
    const runtime = getRuntimeState(chatId)
    runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)

    const statusText = allowed ? '✅ 已允许' : '❌ 已拒绝'
    await sendText(chatId, statusText)
    return { toast: { type: 'info', content: statusText } }
  }

  if (action === 'pick_project') {
    const realPath = event.action?.value?.realPath
    const projectName = event.action?.value?.projectName ?? realPath ?? '(unknown)'
    if (!realPath) return

    pendingProjectSelection.delete(chatId)
    // createSessionForChat handles its own error messaging on failure
    const ok = await createSessionForChat(chatId, realPath)
    if (ok) {
      await sendText(chatId, `✅ 已新建会话：**${projectName}**`)
    }
    return { toast: { type: 'info', content: `📁 ${projectName}` } }
  }
}

// ---------- resolve bot identity ----------

async function resolveBotOpenId(retries = 3): Promise<void> {
  // Feishu has no "me" user_id literal — use /open-apis/bot/v3/info to fetch
  // the bot's identity via tenant_access_token. Response shape:
  //   { code: 0, msg: 'ok', bot: { open_id: 'ou_xxx', ... } }
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await (larkClient as any).request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      })
      const openId = resp?.bot?.open_id ?? resp?.data?.bot?.open_id ?? null
      if (openId) {
        botOpenId = openId
        console.log(`[Feishu] Bot open_id: ${botOpenId}`)
        return
      }
    } catch (err) {
      if (i < retries - 1) {
        console.warn(
          `[Feishu] Could not resolve bot open_id, retrying (${i + 1}/${retries})...`,
          err instanceof Error ? err.message : err,
        )
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)))
      }
    }
  }
  console.warn('[Feishu] Could not resolve bot open_id (group @mention check may not work)')
}

// ---------- start ----------

async function start(): Promise<void> {
  console.log('[Feishu] Starting bot...')
  console.log(`[Feishu] Server: ${config.serverUrl}`)
  console.log(`[Feishu] App ID: ${config.feishu.appId}`)

  await resolveBotOpenId()

  const dispatcher = new Lark.EventDispatcher({
    encryptKey: config.feishu.encryptKey,
    verificationToken: config.feishu.verificationToken,
  })

  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      try {
        await handleMessage(data)
      } catch (err) {
        console.error('[Feishu] Message handler error:', err)
      }
    },
    'card.action.trigger': async (data: any) => {
      try {
        return await handleCardAction(data)
      } catch (err) {
        console.error('[Feishu] Card action error:', err)
      }
    },
  } as any)

  wsClient = new Lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
  })

  await wsClient.start({ eventDispatcher: dispatcher })
  console.log('[Feishu] Bot is running! (WebSocket connected)')
}

start().catch((err) => {
  console.error('[Feishu] Failed to start:', err)
  process.exit(1)
})

process.on('SIGINT', () => {
  console.log('[Feishu] Shutting down...')
  bridge.destroy()
  dedup.destroy()
  process.exit(0)
})
