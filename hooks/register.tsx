import { atom, read, update } from 'claude-code'
import type { ContextBreakdownDetail, EngineInterface, Register, SessionContextBreakdown, SessionUsage, Timer } from 'claude-code'

import type { Consumer, Details, Gauge, Segment } from '../types'

const gauge = atom({ plugin: 'context-gauge', key: 'gauge' } as const, null)
const details = atom({ plugin: 'context-gauge', key: 'details' } as const, null)
const lastResponseAt = atom({ plugin: 'context-gauge', key: 'lastResponseAt' } as const, null)
const now = atom({ plugin: 'context-gauge', key: 'now' } as const, 0)
const warnedAt = atom({ plugin: 'context-gauge', key: 'warnedAt' } as const, null)

const PANE = 'context-gauge'
const PAD = 1
const MIN = 60_000
const GLYPH = { used: '█', free: '░', buffer: '▒' } as const

// Short Polish labels for the legend; a category /context adds later keeps its own name.
const LABEL: Record<string, string> = {
  'System prompt': 'system',
  'System tools': 'narzędzia',
  'MCP tools': 'MCP',
  'Custom agents': 'agenci',
  'Memory files': 'pamięć',
  Skills: 'skille',
  Messages: 'wiadomości',
  'Free space': 'wolne',
  'Autocompact buffer': 'bufor',
}

export const label = (name: string) => LABEL[name] ?? name

const trim = (x: number) => String(Math.round(x * 10) / 10)

export const fmt = (n: number): string => {
  if (n >= 999_500) return `${trim(n / 1e6)}M`
  if (n >= 10_000) return `${Math.round(n / 1e3)}k`
  if (n >= 1_000) return `${trim(n / 1e3)}k`
  return String(Math.round(n))
}

// Splits `width` cells between the segments by their tokens, largest remainder first.
export const cells = (segments: Segment[], width: number): number[] => {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.tokens), 0) || 1
  const raw = segments.map(s => (Math.max(0, s.tokens) / total) * width)
  const out = raw.map(Math.floor)
  let left = width - out.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    out[i]! += 1
    left -= 1
  }
  return out
}

export const cacheView = (last: number | null, t: number, ttlMs: number) => {
  if (last === null) return { text: '◷ —', tone: 'inactive' }
  const left = last + ttlMs - t
  if (left <= 0) return { text: '◌ 0:00', tone: 'inactive' }
  const s = Math.ceil(left / 1000)
  const time = left >= 10 * MIN ? `${Math.floor(left / MIN)} min` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const tone = left < 2 * MIN ? 'error' : left < 10 * MIN ? 'warning' : 'success'
  return { text: `◷ ${time}`, tone }
}

const segmentsOf = (b: SessionContextBreakdown): Segment[] =>
  b.categories.flatMap(c => (c.kind === 'deferred' ? [] : [{ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }]))

const gaugeOf = (u: SessionUsage): Gauge => {
  const b = u.context.breakdown
  if (b) return { used: b.totalTokens, max: b.rawMaxTokens, segments: segmentsOf(b) }
  const used = u.context.tokens ?? 0
  const max = u.context.window
  return {
    used,
    max,
    segments: [
      { name: 'Kontekst', tokens: used, color: 'claude', kind: 'used' },
      { name: 'Wolne', tokens: Math.max(0, max - used), color: 'subtle', kind: 'free' },
    ],
  }
}

const sorted = (items: Consumer[]) => items.filter(x => x.tokens > 0).sort((a, b) => b.tokens - a.tokens)

const shortPath = (path: string) => path.split(/[\\/]/).slice(-2).join('/')

const detailsOf = (b: SessionContextBreakdown, isFull: boolean): Details => {
  const servers = new Map<string, number>()
  for (const tool of b.mcpTools) {
    if (tool.isLoaded) servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + tool.tokens)
  }
  const groups = [
    { title: 'Pliki pamięci', items: sorted(b.memoryFiles.map(f => ({ name: shortPath(f.path), tokens: f.tokens }))) },
    { title: 'Serwery MCP', items: sorted([...servers].map(([name, tokens]) => ({ name, tokens }))) },
    { title: 'Skille', items: sorted((b.skills?.skillFrontmatter ?? []).map(s => ({ name: s.name, tokens: s.tokens }))) },
    { title: 'Agenci', items: sorted(b.agents.map(a => ({ name: a.agentType, tokens: a.tokens }))) },
  ].filter(g => g.items.length > 0)
  return { model: b.model, isFull, used: b.totalTokens, max: b.rawMaxTokens, segments: segmentsOf(b), groups }
}

let isWorking = false

async function refresh($: EngineInterface) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    await update($, gauge, () => gaugeOf(u))
    const b = u.context.breakdown
    if (b && (await read($, details)) !== null) await update($, details, () => detailsOf(b, false))
  } catch {
    // No session bound yet: the band waits for the next turn.
  }
}

async function loadDetails($: EngineInterface, detail: ContextBreakdownDetail) {
  const u = await $.session.usage({ breakdown: detail })
  const b = u.context.breakdown
  if (b) await update($, details, () => detailsOf(b, detail === 'full'))
  await update($, gauge, () => gaugeOf(u))
}

async function openPane($: EngineInterface) {
  await loadDetails($, 'summary')
  await $.ui.open({ id: PANE, title: 'Kontekst' })
}

// Writes `now` only when the countdown text would change, so the band redraws once a minute, then once a second.
async function tick($: EngineInterface, ttlMs: number, warnMs: number) {
  const t = await $.clock.now()
  const last = await read($, lastResponseAt)
  const before = cacheView(last, await read($, now), ttlMs).text
  if (cacheView(last, t, ttlMs).text !== before) await update($, now, () => t)

  if (warnMs === 0 || last === null || isWorking) return
  const left = last + ttlMs - t
  if (left > 0 && left <= warnMs && (await read($, warnedAt)) !== last) {
    await update($, warnedAt, () => last)
    const g = await read($, gauge)
    const size = g ? ` (${fmt(g.used)} tokenów)` : ''
    $.ui.toast(`Cache wygaśnie za ${Math.ceil(left / MIN)} min. Napisz coś teraz, żeby nie przecachowywać kontekstu${size}.`)
  }
}

export const register: Register = (on, options) => {
  const ttlMs = options.cacheTtl === '5m' ? 5 * MIN : 60 * MIN
  const warnMs = Math.max(0, Number(options.warnMinutes ?? 5)) * MIN
  let ticker: Timer | undefined

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({ name: 'ctx', description: 'Pokaż, co zajmuje kontekst' })
    await update($, now, () => 0)
    ticker?.cancel()
    ticker = $.clock.every(1000, () => void tick($, ttlMs, warnMs))
    await tick($, ttlMs, warnMs)
    await refresh($)
    return ran
  })

  on('classic.SessionStart', async ($, e, next) => {
    const ran = await next(e)
    if (e.source === 'clear' || e.source === 'compact') {
      await update($, lastResponseAt, () => null)
    } else if (e.seconds_since_last_response !== undefined) {
      const seconds = e.seconds_since_last_response
      const t = await $.clock.now()
      await update($, lastResponseAt, () => t - seconds * 1000)
    }
    await refresh($)
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    isWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      isWorking = false
      if (e.usage !== undefined) {
        const t = await $.clock.now()
        await update($, lastResponseAt, () => t)
        await update($, now, () => t)
      }
      await refresh($)
    }
    return ran
  })

  on('command.run', { command: 'ctx' }, async $ => {
    await openPane($)
    return { text: 'Otwarto panel kontekstu.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const g = await read($, gauge)
    const inner = await next(e)
    if (g === null || g.max <= 0) return inner

    const { Box, Text, Button } = $.ui.resolve(e)
    const cache = e.props.isWorking
      ? { text: '◷ ●', tone: 'success' }
      : cacheView(await read($, lastResponseAt), await read($, now), ttlMs)
    const pct = Math.round((g.used / g.max) * 100)
    const tone = pct >= 90 ? 'error' : pct >= 70 ? 'warning' : undefined

    const figures = ` ${fmt(g.used)}/${fmt(g.max)} ${pct}%`
    const tail = `  ${cache.text}  `
    const room = e.props.bodyColumns - 2 * PAD - figures.length - tail.length
    const hasButton = room - 1 >= 12
    const width = Math.max(4, hasButton ? room - 1 : room)
    const widths = cells(g.segments, width)

    return (
      <Box flexDirection="column">
        {inner}
        <Box paddingX={PAD} paddingTop={1}>
          {g.segments.map((s, i) =>
            widths[i] ? (
              <Text key={`seg-${i}`} color={s.color}>
                {GLYPH[s.kind].repeat(widths[i]!)}
              </Text>
            ) : null,
          )}
          <Text bold> {fmt(g.used)}/{fmt(g.max)} </Text>
          <Text color={tone} bold={tone !== undefined}>{pct}%</Text>
          <Text color={cache.tone}>{tail}</Text>
          {hasButton ? (
            <Button key="details" plain onPress={() => openPane($)}>
              <Text color="claude">≡</Text>
            </Button>
          ) : null}
        </Box>
        <Box paddingX={PAD} flexWrap="wrap" columnGap={2}>
          {g.segments.map((s, i) =>
            s.tokens > 0 ? (
              <Box key={`legend-${i}`}>
                <Text color={s.color}>{s.kind === 'used' ? '■' : GLYPH[s.kind]} </Text>
                <Text dimColor>
                  {label(s.name)} {fmt(s.tokens)}
                </Text>
              </Box>
            ) : null,
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const d = await read($, details)
    if (d === null) return <Text dimColor>Liczę…</Text>

    const columns = e.props.bodyColumns - 2 * PAD
    const nameWidth = Math.min(28, Math.max(...d.segments.map(s => s.name.length)))
    const barWidth = Math.max(4, columns - nameWidth - 1 - 7 - 5)
    const name = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s.padEnd(w))

    return (
      <Box flexDirection="column" paddingX={PAD}>
        <Box>
          <Text bold>{fmt(d.used)} / {fmt(d.max)} </Text>
          <Text dimColor>
            · {Math.round((d.used / d.max) * 100)}% · {d.model} · {d.isFull ? 'dokładnie' : 'szacunek'}
          </Text>
          <Box flexGrow={1} />
          <Button key="full" label="Policz dokładnie" onPress={() => loadDetails($, 'full')} />
          <Text> </Text>
          <Button key="refresh" label="Odśwież" onPress={() => loadDetails($, 'summary')} />
        </Box>
        <Box flexDirection="column" paddingTop={1}>
          {d.segments.map((s, i) => {
            const filled = Math.min(barWidth, Math.round((s.tokens / d.max) * barWidth))
            return (
              <Box key={`row-${i}`}>
                <Text color={s.kind === 'used' ? undefined : 'inactive'}>{name(s.name, nameWidth)} </Text>
                <Text color={s.color}>{GLYPH[s.kind].repeat(filled)}</Text>
                <Text>{' '.repeat(barWidth - filled)}</Text>
                <Text>{fmt(s.tokens).padStart(7)}</Text>
                <Text dimColor>{`${Math.round((s.tokens / d.max) * 100)}%`.padStart(5)}</Text>
              </Box>
            )
          })}
        </Box>
        {d.groups.map(g => (
          <Box key={`group-${g.title}`} flexDirection="column" paddingTop={1}>
            <Box>
              <Text bold color="claude">{g.title} </Text>
              <Text dimColor>
                · {g.items.length} · {fmt(g.items.reduce((sum, item) => sum + item.tokens, 0))}
              </Text>
            </Box>
            {g.items.map((item, i) => (
              <Box key={`item-${g.title}-${i}`}>
                <Text wrap="truncate-end"> {name(item.name, columns - 8)}</Text>
                <Text>{fmt(item.tokens).padStart(7)}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
