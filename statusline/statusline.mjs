#!/usr/bin/env node
// One-line status line for Claude Code, in the colours of the CLI theme.
//
// Also:
// - hands its input on to another status line command (`--chain "<command>"`),
//   so a tool that reads it, such as ClaudeWidget, keeps working; that
//   command's own output is dropped;
// - writes the engine's prompt-cache figures for the context-gauge mod, whose
//   countdown then reads the real expiry instead of estimating it.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLAUDE = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

const input = readFileSync(0, 'utf8')
let data = {}
try {
  data = JSON.parse(input)
} catch {
  // An empty or broken input still draws what it can.
}


function chain(command, text) {
  if (!command) return
  try {
    spawnSync(command, { input: text, shell: true, timeout: 3000, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
  } catch {
    // The chained command is someone else's: its failure never blanks this line.
  }
}

function shareCache({ session_id: id, prompt_cache: cache }) {
  if (!id || !cache) return
  try {
    const dir = join(CLAUDE, 'context-gauge')
    mkdirSync(dir, { recursive: true })
    const shared = {
      warm: cache.warm === true,
      ttl: cache.ttl,
      expiresAt: typeof cache.expires_at === 'number' ? cache.expires_at * 1000 : null,
      hitRatio: cache.hit_ratio ?? null,
      recacheTokens: cache.recache_tokens_if_cold ?? null,
      writtenAt: Date.now(),
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(shared))
  } catch {
    // Without the file the mod estimates the expiry itself.
  }
}

// --- theme ---------------------------------------------------------------

// Built-in themes' colours, close to what Claude Code draws with them.
const BUILT_IN = {
  dark: { text: '#ffffff', subtle: '#505050', inactive: '#999999', claude: '#d77757', success: '#4eba65', warning: '#ffc107', error: '#ff6b80', suggestion: '#b1b9f9', planMode: '#48968c', permission: '#b1b9f9' },
  light: { text: '#000000', subtle: '#afafaf', inactive: '#666666', claude: '#d77757', success: '#2c7a39', warning: '#966c1e', error: '#ab2b3f', suggestion: '#5769f7', planMode: '#006666', permission: '#5769f7' },
}

function palette() {
  let theme = 'dark'
  try {
    theme = JSON.parse(readFileSync(join(CLAUDE, 'settings.json'), 'utf8')).theme ?? 'dark'
  } catch {
    // No settings: the dark theme's colours.
  }
  if (theme.endsWith('-ansi')) return null
  const base = theme.startsWith('light') ? BUILT_IN.light : BUILT_IN.dark
  if (!theme.startsWith('custom:')) return base
  try {
    const custom = JSON.parse(readFileSync(join(CLAUDE, 'themes', `${theme.slice(7)}.json`), 'utf8'))
    return { ...(custom.base === 'light' ? BUILT_IN.light : BUILT_IN.dark), ...custom.overrides }
  } catch {
    return base
  }
}

const ANSI = { text: 39, subtle: 90, inactive: 37, claude: 33, success: 32, warning: 33, error: 31, suggestion: 34, planMode: 36, permission: 35 }

function paint(colors, key, text, bold = false) {
  const weight = bold ? '\x1b[1m' : ''
  if (colors === null) return `${weight}\x1b[${ANSI[key] ?? 39}m${text}\x1b[0m`
  const hex = colors[key] ?? colors.text
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  return `${weight}\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`
}

// --- the line ------------------------------------------------------------

const WINDOW = { five_hour: 5 * 3600, seven_day: 7 * 24 * 3600 }

function line(d, colors) {
  const c = (key, text, bold) => paint(colors, key, text, bold)
  const sep = c('subtle', ' │ ')
  const parts = []

  const model = (d.model?.display_name ?? '').replace(/\s*\(.*\)$/, '')
  if (model) {
    const effort = d.effort?.level
    const tone = { low: 'warning', medium: 'success', high: 'suggestion', xhigh: 'permission', max: 'claude' }[effort]
    parts.push(c('claude', model, true) + (effort ? ' ' + c(tone ?? 'inactive', effort) : ''))
  }

  for (const [key, label] of [['five_hour', '5h'], ['seven_day', 'tydz']]) {
    const limit = d.rate_limits?.[key]
    if (limit) parts.push(meter(c, label, limit, WINDOW[key]))
  }

  const git = branch(d.workspace?.current_dir ?? d.cwd)
  if (git) parts.push(git(c))

  return parts.join(sep)
}

// A limit's bar, coloured by where the pace leads: past 100% before the reset is a warning.
function meter(c, label, { used_percentage: used = 0, resets_at: resetsAt }, windowSeconds) {
  const width = 8
  const filled = Math.max(0, Math.min(width, Math.round((used / 100) * width)))
  const left = resetsAt ? resetsAt - Date.now() / 1000 : 0
  const elapsed = windowSeconds - left
  const pace = elapsed > windowSeconds * 0.05 ? (used / elapsed) * windowSeconds : used
  const tone = used >= 90 || pace >= 130 ? 'error' : pace >= 100 ? 'warning' : 'success'
  const reset = left > 0 ? c('subtle', ` ↻ ${duration(left)}`) : ''
  return `${c('inactive', label)} ${c(tone, '━'.repeat(filled))}${c('subtle', '─'.repeat(width - filled))} ${c(tone, `${Math.round(used)}%`)}${reset}`
}

function duration(seconds) {
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

function branch(dir) {
  if (!dir) return null
  const git = args => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 1500, windowsHide: true })
  const name = git(['branch', '--show-current'])
  if (name.status !== 0) return null
  const stat = git(['diff', 'HEAD', '--shortstat']).stdout ?? ''
  const added = /(\d+) insertion/.exec(stat)?.[1]
  const removed = /(\d+) deletion/.exec(stat)?.[1]
  return c =>
    c('planMode', `⎇ ${name.stdout.trim() || 'detached'}`) +
    (added ? ' ' + c('success', `+${added}`) : '') +
    (removed ? ' ' + c('error', `−${removed}`) : '')
}

// --- main ----------------------------------------------------------------

const at = process.argv.indexOf('--chain')
chain(at > 0 ? process.argv[at + 1] : undefined, input)
shareCache(data)
process.stdout.write(line(data, palette()))
