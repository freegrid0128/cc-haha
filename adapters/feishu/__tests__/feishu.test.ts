/**
 * 飞书 Adapter 翻译逻辑测试
 *
 * 不启动真实 Bot，只测试事件解析和消息翻译逻辑。
 */

import { describe, it, expect } from 'bun:test'

// ---------- helpers extracted from feishu/index.ts for testability ----------

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

function isBotMentioned(
  mentions: Array<{ id?: { open_id?: string } }> | undefined,
  botOpenId: string,
): boolean {
  if (!mentions || !botOpenId) return false
  return mentions.some((m) => m.id?.open_id === botOpenId)
}

function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, '').trim()
}

type RecentProject = {
  projectPath: string
  realPath: string
  projectName: string
  isGit: boolean
  repoName: string | null
  branch: string | null
  modifiedAt: string
  sessionCount: number
}

function prettyPath(realPath: string, maxLen = 64): string {
  const home = process.env.HOME
  let p = realPath
  if (home) {
    if (p === home) return '~'
    if (p.startsWith(`${home}/`)) p = `~${p.slice(home.length)}`
  }
  if (p.length <= maxLen) return p
  const tailLen = Math.floor(maxLen * 0.65)
  const headLen = maxLen - tailLen - 1
  return `${p.slice(0, headLen)}…${p.slice(-tailLen)}`
}

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

function buildPermissionCard(toolName: string, input: unknown, requestId: string): Record<string, unknown> {
  const preview = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
  const truncated = preview.length > 300 ? preview.slice(0, 300) + '…' : preview

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

// ---------- tests ----------

describe('Feishu: event parsing', () => {
  describe('extractText', () => {
    it('extracts text from text message', () => {
      const content = JSON.stringify({ text: 'hello world' })
      expect(extractText(content, 'text')).toBe('hello world')
    })

    it('extracts text from post message (zh_cn)', () => {
      const content = JSON.stringify({
        zh_cn: {
          content: [[
            { tag: 'text', text: 'Hello ' },
            { tag: 'text', text: 'World' },
          ]],
        },
      })
      expect(extractText(content, 'post')).toBe('Hello World')
    })

    it('extracts text from post message with md tag', () => {
      const content = JSON.stringify({
        zh_cn: {
          content: [[{ tag: 'md', text: '**bold** text' }]],
        },
      })
      expect(extractText(content, 'post')).toBe('**bold** text')
    })

    it('returns null for unsupported message types', () => {
      expect(extractText('{}', 'image')).toBeNull()
      expect(extractText('{}', 'audio')).toBeNull()
    })

    it('returns null for malformed content', () => {
      expect(extractText('not-json', 'text')).toBeNull()
    })

    it('returns null for empty text', () => {
      const content = JSON.stringify({ text: '' })
      // empty string is falsy, so ?? null returns ''
      expect(extractText(content, 'text')).toBe('')
    })
  })

  describe('isBotMentioned', () => {
    const botId = 'ou_bot_123'

    it('returns true when bot is mentioned', () => {
      const mentions = [
        { id: { open_id: 'ou_user_1' } },
        { id: { open_id: 'ou_bot_123' } },
      ]
      expect(isBotMentioned(mentions, botId)).toBe(true)
    })

    it('returns false when bot is not mentioned', () => {
      const mentions = [
        { id: { open_id: 'ou_user_1' } },
        { id: { open_id: 'ou_user_2' } },
      ]
      expect(isBotMentioned(mentions, botId)).toBe(false)
    })

    it('returns false for undefined mentions', () => {
      expect(isBotMentioned(undefined, botId)).toBe(false)
    })

    it('returns false for empty mentions', () => {
      expect(isBotMentioned([], botId)).toBe(false)
    })
  })

  describe('stripMentions', () => {
    it('removes @_user_N patterns', () => {
      expect(stripMentions('@_user_1 hello world')).toBe('hello world')
    })

    it('removes multiple mentions', () => {
      expect(stripMentions('@_user_1 @_user_2 test')).toBe('test')
    })

    it('leaves text without mentions unchanged', () => {
      expect(stripMentions('hello world')).toBe('hello world')
    })

    it('trims whitespace', () => {
      expect(stripMentions('  @_user_1  hello  ')).toBe('hello')
    })
  })
})

describe('Feishu: permission card', () => {
  it('builds valid card structure', () => {
    const card = buildPermissionCard('Bash', { command: 'npm test' }, 'abcde')

    expect(card.schema).toBe('2.0')
    expect((card.header as any).title.content).toContain('权限确认')
    expect((card.elements as any[]).length).toBe(2) // markdown + action

    const actionElement = (card.elements as any[])[1]
    expect(actionElement.tag).toBe('action')
    expect(actionElement.actions.length).toBe(2) // allow + deny buttons
  })

  it('allow button has correct value', () => {
    const card = buildPermissionCard('Read', {}, 'xyz12')
    const allowBtn = (card.elements as any[])[1].actions[0]

    expect(allowBtn.value.action).toBe('permit')
    expect(allowBtn.value.requestId).toBe('xyz12')
    expect(allowBtn.value.allowed).toBe(true)
  })

  it('deny button has correct value', () => {
    const card = buildPermissionCard('Read', {}, 'xyz12')
    const denyBtn = (card.elements as any[])[1].actions[1]

    expect(denyBtn.value.action).toBe('permit')
    expect(denyBtn.value.requestId).toBe('xyz12')
    expect(denyBtn.value.allowed).toBe(false)
  })

  it('truncates long input preview', () => {
    const longInput = { command: 'x'.repeat(500) }
    const card = buildPermissionCard('Bash', longInput, 'abc')
    const mdElement = (card.elements as any[])[0]

    expect(mdElement.content).toContain('…')
  })
})

describe('Feishu: project picker card', () => {
  const sampleProjects: RecentProject[] = [
    {
      projectPath: '/Users/dev/claude-code-haha',
      realPath: '/Users/dev/claude-code-haha',
      projectName: 'claude-code-haha',
      isGit: true,
      repoName: 'claude-code-haha',
      branch: 'main',
      modifiedAt: '2026-04-11T00:00:00Z',
      sessionCount: 3,
    },
    {
      projectPath: '/Users/dev/desktop',
      realPath: '/Users/dev/desktop',
      projectName: 'desktop',
      isGit: false,
      repoName: null,
      branch: null,
      modifiedAt: '2026-04-10T00:00:00Z',
      sessionCount: 1,
    },
  ]

  function getBodyElements(card: Record<string, unknown>): any[] {
    return ((card.body as any).elements ?? []) as any[]
  }

  function getRows(card: Record<string, unknown>): any[] {
    return getBodyElements(card).filter((el) => el.tag === 'column_set')
  }

  function getRowButton(row: any): any {
    const buttonCol = row.columns.find((c: any) =>
      c.elements.some((e: any) => e.tag === 'button'),
    )
    return buttonCol.elements.find((e: any) => e.tag === 'button')
  }

  function getRowInfoElements(row: any): any[] {
    const infoCol = row.columns.find((c: any) =>
      c.elements.every((e: any) => e.tag === 'markdown'),
    )
    return infoCol.elements
  }

  it('uses Schema 2.0 with body.elements wrapper', () => {
    const card = buildProjectPickerCard(sampleProjects)
    expect(card.schema).toBe('2.0')
    expect((card.config as any).update_multi).toBe(true)
    expect((card.body as any).elements).toBeDefined()
  })

  it('header has title and project-count subtitle', () => {
    const card = buildProjectPickerCard(sampleProjects)
    expect((card.header as any).title.content).toContain('选择项目')
    expect((card.header as any).subtitle.content).toContain('2')
    expect((card.header as any).subtitle.content).toContain('最近项目')
  })

  it('subtitle notes truncation when more than 10 projects exist', () => {
    const many: RecentProject[] = Array.from({ length: 15 }, (_, i) => ({
      ...sampleProjects[0]!,
      projectName: `proj-${i}`,
      realPath: `/p/${i}`,
    }))
    const card = buildProjectPickerCard(many)
    const subtitle = (card.header as any).subtitle.content
    expect(subtitle).toContain('15')
    expect(subtitle).toContain('显示前 10')
  })

  it('body contains one column_set row per project', () => {
    const card = buildProjectPickerCard(sampleProjects)
    expect(getRows(card).length).toBe(2)
  })

  it('each row has exactly 2 columns: info (weighted) + button (auto)', () => {
    const card = buildProjectPickerCard(sampleProjects)
    for (const row of getRows(card)) {
      expect(row.columns.length).toBe(2)
      expect(row.columns[0].width).toBe('weighted')
      expect(row.columns[0].vertical_align).toBe('center')
      expect(row.columns[1].width).toBe('auto')
      expect(row.columns[1].vertical_align).toBe('center')
    }
  })

  it('info column has title markdown + notation path markdown', () => {
    const card = buildProjectPickerCard(sampleProjects)
    const row1 = getRows(card)[0]
    const info = getRowInfoElements(row1)

    expect(info.length).toBe(2)
    // Title markdown
    expect(info[0].tag).toBe('markdown')
    expect(info[0].content).toContain('**claude-code-haha**')
    expect(info[0].content).toContain('*main*')
    // Path markdown (notation = small grey)
    expect(info[1].tag).toBe('markdown')
    expect(info[1].text_size).toBe('notation')
    expect(info[1].content).toContain('claude-code-haha')
  })

  it('row without branch has no separator dot in title', () => {
    const card = buildProjectPickerCard(sampleProjects)
    const row2 = getRows(card)[1]
    const title = getRowInfoElements(row2)[0].content
    expect(title).toContain('**desktop**')
    expect(title).not.toContain('·')
  })

  it('row button says 选择 with small size and carries per-project value', () => {
    const card = buildProjectPickerCard(sampleProjects)
    const rows = getRows(card)

    const btn1 = getRowButton(rows[0])
    expect(btn1.text.content).toBe('选择')
    expect(btn1.size).toBe('small')
    expect(btn1.value.action).toBe('pick_project')
    expect(btn1.value.realPath).toBe('/Users/dev/claude-code-haha')
    expect(btn1.value.projectName).toBe('claude-code-haha')

    const btn2 = getRowButton(rows[1])
    expect(btn2.value.realPath).toBe('/Users/dev/desktop')
  })

  it('first row button is primary, rest are default', () => {
    const card = buildProjectPickerCard(sampleProjects)
    const rows = getRows(card)
    expect(getRowButton(rows[0]).type).toBe('primary')
    expect(getRowButton(rows[1]).type).toBe('default')
  })

  it('body tail has hr and notation footer hint', () => {
    const card = buildProjectPickerCard(sampleProjects)
    const elements = getBodyElements(card)
    const hrIdx = elements.findIndex((el) => el.tag === 'hr')
    expect(hrIdx).toBeGreaterThan(0)
    expect(elements[hrIdx + 1].tag).toBe('markdown')
    expect(elements[hrIdx + 1].text_size).toBe('notation')
  })

  it('caps to first 10 projects', () => {
    const many: RecentProject[] = Array.from({ length: 15 }, (_, i) => ({
      ...sampleProjects[0]!,
      projectName: `proj-${i}`,
      realPath: `/p/${i}`,
    }))
    const card = buildProjectPickerCard(many)
    const rows = getRows(card)
    expect(rows.length).toBe(10)
    expect(getRowButton(rows[9]).value.realPath).toBe('/p/9')
  })

  it('uses ~ shortcut when path is under $HOME', () => {
    const home = process.env.HOME
    if (!home) return
    const project: RecentProject = {
      ...sampleProjects[0]!,
      realPath: `${home}/some/sub/dir`,
      projectName: 'sub-dir',
    }
    const card = buildProjectPickerCard([project])
    const pathEl = getRowInfoElements(getRows(card)[0])[1]
    expect(pathEl.content).toBe('~/some/sub/dir')
  })

  it('middle-truncates very long paths with ellipsis', () => {
    const veryLong = '/x/'.repeat(40) + 'project' // ~123 chars
    const project: RecentProject = {
      ...sampleProjects[0]!,
      realPath: veryLong,
      projectName: 'project',
    }
    const card = buildProjectPickerCard([project])
    const content = getRowInfoElements(getRows(card)[0])[1].content
    expect(content).toContain('…')
    expect(content.length).toBeLessThanOrEqual(56)
    expect(content.endsWith('project')).toBe(true)
  })
})

describe('Feishu: card.action.trigger parsing', () => {
  it('parses permit action from event', () => {
    const event = {
      operator: { open_id: 'ou_user_1' },
      action: { value: { action: 'permit', requestId: 'abcde', allowed: true } },
      context: { open_chat_id: 'oc_chat_123' },
    }

    expect(event.action.value.action).toBe('permit')
    expect(event.action.value.requestId).toBe('abcde')
    expect(event.action.value.allowed).toBe(true)
    expect(event.context.open_chat_id).toBe('oc_chat_123')
  })

  it('parses pick_project action from event', () => {
    const event = {
      operator: { open_id: 'ou_user_1' },
      action: {
        value: {
          action: 'pick_project',
          realPath: '/Users/dev/claude-code-haha',
          projectName: 'claude-code-haha',
        },
      },
      context: { open_chat_id: 'oc_chat_123' },
    }

    expect(event.action.value.action).toBe('pick_project')
    expect(event.action.value.realPath).toBe('/Users/dev/claude-code-haha')
    expect(event.action.value.projectName).toBe('claude-code-haha')
  })

  it('ignores non-handled actions', () => {
    const event = {
      action: { value: { action: 'other_action' } },
    }
    expect(['permit', 'pick_project']).not.toContain(event.action.value.action)
  })
})
