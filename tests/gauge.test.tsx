import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { cacheView, cells, expiryOf, fmt } from '../hooks/register'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

const MIN = 60_000

const breakdown = {
  categories: [
    { name: 'System prompt', tokens: 20_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 380_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 50_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { name: 'Free space', tokens: 435_000, color: 'subtle', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 165_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
  ],
  totalTokens: 400_000,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  autocompactSource: 'auto',
  percentage: 40,
  gridRows: [],
  model: 'Opus 5.5',
  memoryFiles: [{ path: 'C:\\Users\\me\\.claude\\CLAUDE.md', type: 'User', tokens: 1_500 }],
  mcpTools: [
    { name: 'mcp__gmail__send', serverName: 'gmail', tokens: 900, isLoaded: true },
    { name: 'mcp__gmail__read', serverName: 'gmail', tokens: 600, isLoaded: true },
  ],
  agents: [],
  skills: {
    totalSkills: 7,
    includedSkills: 7,
    tokens: 2_800,
    skillFrontmatter: Array.from({ length: 7 }, (_, i) => ({ name: `skill-${i + 1}`, source: 'userSettings', tokens: 400 - i * 10 })),
  },
  isAutoCompactEnabled: true,
  apiUsage: null,
}

const usage = () => ({
  startedAt: 0,
  context: { tokens: 400_000, window: 1_000_000, percent: 40, breakdown },
  rateLimits: [],
})

const start = { cwd: '.', surface: 'terminal', isInteractive: true } as const

// The engine beneath the plugin: a session, its turns and its usage figures.
const world = (on: On, read: (path: string) => object = () => ({ deny: 'ENOENT' })) => {
  const toasts: string[] = []
  on('session.start', () => ({ cwd: '.' }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.usage', () => ({ value: usage() }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.read', (_, e) => read(String((e as { path: string }).path)) as never)
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return toasts
}

const complete = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
const cost = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }

test('fmt shortens token counts', () => {
  expect(fmt(950)).toBe('950')
  expect(fmt(1_500)).toBe('1.5k')
  expect(fmt(412_345)).toBe('412k')
  expect(fmt(1_000_000)).toBe('1M')
})

test('cells split the width by tokens and fill it exactly', () => {
  const segs = [
    { name: 'a', tokens: 1, color: 'x', kind: 'used' },
    { name: 'b', tokens: 1, color: 'x', kind: 'used' },
    { name: 'c', tokens: 1, color: 'x', kind: 'free' },
  ] as const
  const out = cells([...segs], 10)
  expect(out.reduce((a, b) => a + b, 0)).toBe(10)
})

test('cacheView counts down in minutes, then seconds, then freezes', () => {
  const at = 60 * MIN
  expect(cacheView(null, 0).text).toMatch(/—/)
  expect(cacheView(at, 13 * MIN)).toEqual({ text: '◷ 47 min', tone: 'success' })
  expect(cacheView(at, 55 * MIN + 30_000)).toEqual({ text: '◷ 4:30', tone: 'warning' })
  expect(cacheView(at, 59 * MIN).tone).toBe('error')
  expect(cacheView(at, 60 * MIN).text).toMatch(/◌ 0:00/)
})

test('expiryOf prefers the engine figure the status line shares, unless it is older than the last response', () => {
  const warm = { warm: true, expiresAt: 3_000_000, writtenAt: 1_000_000 }
  expect(expiryOf(1_000_000, 60 * MIN, warm)).toBe(3_000_000)
  expect(expiryOf(1_000_000, 60 * MIN, { ...warm, warm: false })).toBe(0)
  expect(expiryOf(2_000_000, 60 * MIN, warm)).toBe(2_000_000 + 60 * MIN)
  expect(expiryOf(null, 60 * MIN, null)).toBeNull()
})

test('the band shows usage, theme-coloured segments and the cache countdown', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const toasts = world(on)
  await $.session.start(start)
  await $.turn.complete({ ...complete, usage: cost })

  const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /400k\/1M/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /40%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^█+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^▒+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'wiadomości 380k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'bufor 165k' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /MCP tools/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /◷ (60|59) min/ })).toBeDefined()

  await clock.advance(13 * MIN)
  expect(await ui.find({ type: 'Text', text: /◷ 47 min/ })).toBeDefined()
  expect(toasts).toEqual([])
  await clock.advance(43 * MIN)
  expect(await ui.find({ type: 'Text', text: /◷ 4:00/ })).toBeDefined()
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/400k/)
  await clock.advance(5 * MIN)
  expect(await ui.find({ type: 'Text', text: /◌ 0:00/ })).toBeDefined()
})

test('cacheTtl 5m counts down from five minutes', { options: { cacheTtl: '5m' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  world(on)
  await $.session.start(start)
  await $.turn.complete({ ...complete, usage: cost })
  await clock.advance(MIN)
  const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /◷ 4:00/ })).toBeDefined()
})

test('/ctx opens a pane listing categories and top consumers', async ($, on) => {
  mock.clock(on, { now: 0 })
  world(on)
  await $.session.start(start)
  await $.command.run({ command: 'ctx', args: '' } as never)

  const pane = await $.ui.mount({
    plugin: 'context-gauge',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'context-gauge',
    props: { bodyColumns: 80 },
  } as never)
  expect(await pane.find({ type: 'Text', text: /Messages/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /MCP tools/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /Serwery MCP/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /gmail/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /skill-7/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /· 7 · 2\.6k/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /\.claude\/CLAUDE\.md/ })).toBeDefined()
})

test('the countdown follows the expiry the status line script shares', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  mock.env(on, { USERPROFILE: 'C:/Users/me' })
  const paths: string[] = []
  world(on, path => {
    paths.push(path)
    return { value: JSON.stringify({ warm: true, expiresAt: 20 * MIN, writtenAt: 1_000 }) }
  })
  await $.session.start(start)
  await $.turn.complete({ ...complete, usage: cost })
  await clock.advance(2_000)
  const ui = await $.ui.mount({ plugin: 'context-gauge', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /◷ 19 min/ })).toBeDefined()
  expect(paths[0]?.replaceAll('\\', '/')).toBe('C:/Users/me/.claude/context-gauge/s1.json')
})
