// Terminal-Modus: `m3dusa` ohne Argumente in einem echten Terminal (oder `m3dusa chat`).
// Start-Animation → Statusfeld → Eingabeschleife; Freitext geht an den aktiven Agenten (claude/codex)
// im aktuellen Ordner, Ausgabe wird live gezeigt. Keine Alternate-Screen-Übernahme: alles bleibt im Scrollback.
//
// Test-Schalter (wie M3DUSA_TEST_CLOCK_FILE im Bestand):
//   M3DUSA_TUI_FAKE_AGENT=<skript.mjs>  startet statt claude/codex `node <skript> <agent-argv…>` (kein Kontingent)
//   M3DUSA_TUI_FORCE=1                  Terminal-Modus auch ohne TTY (liest Zeilen von stdin)
//   M3DUSA_NO_ANIM=1 / --no-anim        keine Animation, nur ruhiges Banner
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { expandHome, HOME, hubCall, isPaired, readCfg, VERSION } from './core.mjs'
import { modeOf } from './policy.mjs'
import { agentArgv, readAgentLine, sessionOf, viaLoginShell } from './agents.mjs'

// ─── Breite & Farbe ───────────────────────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
export const stripAnsi = s => String(s).replace(ANSI_RE, '')
const isWide = cp => cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd))
const charWidth = ch => { const cp = ch.codePointAt(0); if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0; return isWide(cp) ? 2 : 1 }
/** Sichtbare Breite in Terminal-Spalten (ANSI entfernt, breite Zeichen = 2). */
export function visibleWidth(s) { let w = 0; for (const ch of stripAnsi(s)) w += charWidth(ch); return w }
/** Klartext auf n Spalten kürzen (mit …). */
function clipPlain(s, n) {
  if (n <= 0) return ''
  if (visibleWidth(s) <= n) return s
  let out = '', w = 0
  for (const ch of s) { const x = charWidth(ch); if (w + x > n - 1) break; out += ch; w += x }
  return out + '…'
}

const RST = '\x1b[0m'
const V = [139, 92, 246], CY = [34, 211, 238], GR = [52, 211, 153], WH = [255, 255, 255]
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t))
/** Zyklischer Verlauf Violett → Cyan → Grün → Violett, p ∈ [0,1). */
function grad(p) { p = ((p % 1) + 1) % 1; const st = [V, CY, GR, V]; const s = p * 3, i = Math.min(2, Math.floor(s)); return mix(st[i], st[i + 1], s - i) }
const PAL16 = [[95, [190, 110, 255]], [96, [90, 230, 245]], [92, [90, 235, 150]], [97, [250, 250, 250]], [35, [110, 50, 160]], [36, [20, 130, 150]], [32, [20, 130, 70]], [90, [100, 100, 100]], [37, [190, 190, 190]]]
function fg(rgb, level) {
  if (!level) return ''
  if (level === 'truecolor') return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
  if (level === '256') { const q = v => Math.round((v / 255) * 5); return `\x1b[38;5;${16 + 36 * q(rgb[0]) + 6 * q(rgb[1]) + q(rgb[2])}m` }
  let best = PAL16[0], bd = Infinity
  for (const p of PAL16) { const d = (p[1][0] - rgb[0]) ** 2 + (p[1][1] - rgb[1]) ** 2 + (p[1][2] - rgb[2]) ** 2; if (d < bd) { bd = d; best = p } }
  return `\x1b[${best[0]}m`
}
const paint = (s, rgb, level, bold = false) => (level ? (bold ? '\x1b[1m' : '') + fg(rgb, level) + s + RST : s)

/** Farbtiefe des Terminals: 'truecolor' | '256' | '16' | false. */
export function colorLevel(stream = process.stdout, env = process.env) {
  if ('NO_COLOR' in env && env.NO_COLOR !== undefined) return false
  if (env.TERM === 'dumb') return false
  if (env.FORCE_COLOR === '0') return false
  if (!stream.isTTY && !env.FORCE_COLOR) return false
  const ct = (env.COLORTERM || '').toLowerCase()
  if (ct === 'truecolor' || ct === '24bit' || env.WT_SESSION || env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'vscode') return 'truecolor'
  if (/256/.test(env.TERM || '')) return '256'
  if (process.platform === 'win32') return 'truecolor' // Windows 10+ Konsole kann 24 Bit
  return '16'
}

// ─── Logo ─────────────────────────────────────────────────────────────────────────────────────
const BIG = {
  M: ['███╗   ███╗', '████╗ ████║', '██╔████╔██║', '██║╚██╔╝██║', '██║ ╚═╝ ██║', '╚═╝     ╚═╝'],
  3: ['██████╗ ', '╚════██╗', ' █████╔╝', ' ╚═══██╗', '██████╔╝', '╚═════╝ '],
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
  U: ['██╗   ██╗', '██║   ██║', '██║   ██║', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
  S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
}
const SMALL = {
  M: ['█▄ ▄█', '█ ▀ █', '▀   ▀'],
  3: ['▀▀█', ' ▀█', '▀▀▀'],
  D: ['█▀▄', '█ █', '▀▀ '],
  U: ['█ █', '█ █', '▀▀▀'],
  S: ['█▀▀', '▀▀█', '▀▀▀'],
  A: ['▄▀▄', '█▀█', '▀ ▀'],
}
function buildLogo(font) {
  const letters = 'M3DUSA'.split('').map(k => { const rows = font[k]; const w = Math.max(...rows.map(r => [...r].length)); return rows.map(r => r + ' '.repeat(w - [...r].length)) })
  return letters[0].map((_, y) => letters.map(l => l[y]).join(' ').replace(/\s+$/, ''))
}
const SHADOW = new Set([...'╗║╔╝═╚'])
const GLITCH = ['░', '▒', '▓']
const hash = (a, b, c) => { let h = (a * 374761393 + b * 668265263 + c * 2147483647) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return (h ^ (h >>> 16)) >>> 0 }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const easeOut = t => 1 - (1 - t) ** 3

/**
 * Reine Funktion: alle Frames der Start-Animation als Strings (Zeilen mit \n getrennt, gleiche Zeilenzahl).
 * Kein Frame enthält eine Zeile, die sichtbar breiter als `cols` ist. Der letzte Frame ist das Ruhebild.
 * color: false | true | 'truecolor' | '256' | '16'
 */
export function renderFrames({ cols = 80, color = false, frames: N = 30 } = {}) {
  const level = color === true ? 'truecolor' : color || false
  cols = Math.max(1, Math.floor(cols))
  const mode = cols >= 62 ? 'big' : cols >= 30 ? 'small' : 'tiny'
  const logo = mode === 'big' ? buildLogo(BIG) : mode === 'small' ? buildLogo(SMALL) : ['M3DUSA'.slice(0, cols)]
  const cells = logo.map(r => [...r])
  const LW = Math.max(...cells.map(r => r.length))
  const SH = mode === 'big' ? 4 : mode === 'small' ? 2 : 0
  const ind = cols >= LW + 2 ? '  ' : ''
  const avail = cols - ind.length
  const tag = [...clipPlain(mode === 'tiny' ? `v${VERSION}` : `Linux-Knoten  ·  Claude Code & Codex  ·  v${VERSION}`, avail)]
  const snakes = []
  if (SH) for (let bx = mode === 'big' ? 3 : 2, k = 0; bx < LW - 1; bx += mode === 'big' ? 6 : 4, k++) snakes.push({ bx, k })
  const rowsTotal = cells.length
  const out = []
  for (let f = 0; f < N; f++) {
    const t = N === 1 ? 1 : f / (N - 1)
    const tr = clamp(t / 0.55, 0, 1)
    const front = tr * tr * (3 - 2 * tr) * (LW + 2 * rowsTotal + 8) - 3
    const shift = -0.9 * (1 - easeOut(t))
    const shineX = t > 0.45 && t < 1 ? -8 + ((t - 0.45) / 0.55) * (LW + 16) : null
    const grow = Math.round(clamp((t - 0.3) / 0.4, 0, 1) * SH)
    const phase = f * 0.42
    const lines = []
    // Schlangen (Medusa-Haar): Wellen, die nach oben laufen; Kopf ◆ auf der obersten sichtbaren Reihe.
    const grid = Array.from({ length: SH }, () => Array(LW).fill(null))
    for (const s of snakes) {
      const xs = []
      for (let i = 0; i < SH; i++) xs.push(clamp(s.bx + Math.round((0.35 + i * 0.55) * Math.sin(phase + s.k * 1.3 - i * 0.95)), 0, LW - 1))
      for (let i = 0; i < grow; i++) {
        const dx = xs[i] - (i === 0 ? s.bx : xs[i - 1])
        const head = i === grow - 1
        const ch = head ? '◆' : dx > 0 ? '╱' : dx < 0 ? '╲' : '│'
        const rgb = head ? mix(GR, WH, 0.35) : grad(0.36 + 0.3 * (i / Math.max(1, SH - 1)) + shift * 0.3)
        grid[i][xs[i]] = paint(ch, rgb, level, head)
      }
    }
    for (let i = SH - 1; i >= 0; i--) lines.push((ind + grid[i].map(c => c || ' ').join('')).replace(/\s+$/, ''))
    // Logo mit Aufdeck-Kante (diagonal), Verlauf und Glanzstreifen.
    for (let y = 0; y < rowsTotal; y++) {
      let row = ''
      for (let x = 0; x < cells[y].length; x++) {
        const ch = cells[y][x]
        if (ch === ' ') { row += ' '; continue }
        const d = x + 2 * y
        if (d > front + 2) { row += ' '; continue }
        let rgb = grad((x / Math.max(1, LW)) * 0.67 + shift)
        if (d > front - 1) { row += paint(GLITCH[hash(x, y, f) % 3], mix(rgb, WH, 0.5), level); continue }
        if (shineX !== null) { const k = Math.max(0, 1 - Math.abs(x - y * 0.6 - shineX) / 4); if (k) rgb = mix(rgb, WH, k * 0.75) }
        if (SHADOW.has(ch)) rgb = mix(rgb, [0, 0, 0], 0.45)
        row += paint(ch, rgb, level, !SHADOW.has(ch))
      }
      lines.push((ind + row).replace(/\s+$/, ''))
    }
    lines.push('')
    const n = Math.round(clamp((t - 0.5) / 0.38, 0, 1) * tag.length)
    const typed = tag.slice(0, n).join('')
    lines.push(n ? ind + (level ? '\x1b[2m' + fg([200, 200, 215], level) + typed + RST : typed) + (n < tag.length && f % 2 === 0 ? paint('▌', CY, level) : '') : '')
    out.push(lines.join('\n'))
  }
  return out
}

// ─── Statusfeld ───────────────────────────────────────────────────────────────────────────────
const SGR = { b: '\x1b[1m', dim: '\x1b[2m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', acc: '\x1b[36m', vio: '\x1b[35m', '': '' }
/** Segmente [[text, stil], …] auf max Spalten kürzen und färben → { s, w } */
function segs(parts, max, color) {
  let s = '', w = 0
  for (const [text, st] of parts) {
    if (w >= max) break
    const room = max - w
    const t = visibleWidth(text) > room ? clipPlain(text, room) : text
    w += visibleWidth(t)
    s += color && st && SGR[st] ? SGR[st] + t + RST : t
  }
  return { s, w }
}
const tildify = p => (p === HOME ? '~' : p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length).replace(/\\/g, '/') : p)
function shortPath(p, max) {
  const t = tildify(p)
  if (visibleWidth(t) <= max) return t
  const chars = [...t]; return '…' + chars.slice(chars.length - (max - 1)).join('')
}
const hostOf = u => { try { return new URL(u).host } catch { return String(u || '') } }

/**
 * Reine Funktion: Statusfeld als String (Box-Rahmen, alle Zeilen gleich sichtbar breit, ≤ cols).
 * info: { version, node, device, host, hub:{state,text,server}, service:{state,text}, agents:{claude:{state,text},codex:{…}},
 *         cwd, agent, model, mode }   state: ok | off | err | warn | wait | none | missing
 */
export function renderStatus(info, cols = 80, { color = false } = {}) {
  const level = color === true ? 'truecolor' : color || false
  const BW = clamp(Math.min(Math.floor(cols), 78), 12, 78)
  const LBL = BW >= 44 ? 10 : 8
  const VW = Math.max(1, BW - 4 - LBL)
  const bc = s => (level ? fg(V, level) + s + RST : s)
  const st = (x, ok, wait = '… prüft') => x?.state === 'wait' || !x ? [[wait, 'dim']] : ok(x)
  const hub = st(info.hub, h => h.state === 'ok' ? [['● verbunden', 'ok'], ['  ' + hostOf(h.server), 'dim']]
    : h.state === 'off' ? [['○ nicht gekoppelt', 'warn'], ['  m3dusa login <Code>', 'dim']]
    : [['● ' + (h.text || 'Fehler'), h.state === 'err' ? 'err' : 'warn']])
  const svc = st(info.service, s => s.state === 'ok' ? [['● läuft', 'ok']]
    : s.state === 'none' ? [['– ', 'dim'], [s.text || 'kein systemd-Benutzerdienst', 'dim']]
    : [['○ läuft nicht', 'warn'], ['  /dienst start', 'dim']])
  const ag = []
  for (const k of ['claude', 'codex']) {
    const a = info.agents?.[k]
    if (ag.length) ag.push(['   ', ''])
    if (!a || a.state === 'wait') ag.push([k + ' …', 'dim'])
    else if (a.state === 'ok') ag.push([k + ' ', 'b'], [a.text || '', 'dim'], [' ✓', 'ok'])
    else ag.push([k + ' ', 'dim'], ['fehlt', 'err'])
  }
  const rows = [
    ['Version', [[String(info.version || VERSION), 'b'], [`  ·  Node ${info.node || process.versions.node}`, 'dim']]],
    ['Gerät', [[String(info.device || os.hostname()), ''], ...(info.host && info.host !== info.device ? [[`  (${info.host})`, 'dim']] : [])]],
    ['Hub', hub],
    ['Dienst', svc],
    ['Agenten', ag],
    ['Ordner', [[shortPath(info.cwd || process.cwd(), VW), '']]],
    ['Aktiv', [[info.agent || 'claude', 'acc'], ['  ·  Modell ', 'dim'], [info.model || 'Standard', '']]],
  ]
  const title = clipPlain(' M3DUSA · Terminal ', BW - 4)
  const lines = [bc('╭─') + (level ? '\x1b[1m' + fg(CY, level) + title + RST : title) + bc('─'.repeat(BW - 3 - visibleWidth(title)) + '╮')]
  for (const [label, parts] of rows) {
    const lab = clipPlain(label, LBL - 1).padEnd(LBL)
    const v = segs(parts, VW, !!level)
    lines.push(bc('│') + ' ' + (level ? SGR.dim + lab + RST : lab) + v.s + ' '.repeat(VW - v.w) + ' ' + bc('│'))
  }
  lines.push(bc('╰' + '─'.repeat(BW - 2) + '╯'))
  return lines.join('\n')
}

// ─── Proben (Hub, Dienst, Agenten) ────────────────────────────────────────────────────────────
const verCache = {}
function probeAgent(kind) {
  if (process.env.M3DUSA_TUI_FAKE_AGENT) return Promise.resolve({ state: 'ok', text: 'Testskript' })
  if (verCache[kind]) return verCache[kind]
  verCache[kind] = new Promise(res => {
    let p, out = '', done = false
    const fin = v => { if (done) return; done = true; clearTimeout(to); if (v.state !== 'ok') delete verCache[kind]; res(v) }
    const to = setTimeout(() => { try { p?.kill() } catch { /* weg */ } fin({ state: 'missing' }) }, 8000)
    try {
      // nur --version: kein Modellaufruf
      if (process.platform === 'win32') p = spawn(kind, ['--version'], { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      else { const v = viaLoginShell([kind, '--version']); p = spawn(v[0], v.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] }) }
    } catch { return fin({ state: 'missing' }) }
    p.stdout.on('data', b => { out += b })
    p.on('error', () => fin({ state: 'missing' }))
    p.on('close', code => { const m = out.match(/\d+\.\d+(?:\.\d+)?[\w.-]*/); fin(code === 0 && m ? { state: 'ok', text: m[0] } : { state: 'missing' }) })
  })
  return verCache[kind]
}
async function probeHub(cfg) {
  try { await hubCall(cfg, 'POST', '/api/v1/node/poll', { wait: 0, peek: true }, { timeoutMs: 4000 }); return { state: 'ok', server: cfg.server } } catch (e) {
    return e.status === 401 || e.status === 403 || e.status === 404 ? { state: 'err', text: 'vom Server entfernt — neu koppeln', server: cfg.server } : { state: 'warn', text: e.message || 'nicht erreichbar', server: cfg.server }
  }
}
function probeService() {
  if (process.platform !== 'linux') return { state: 'none', text: 'kein systemd (nur Linux)' }
  if (spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 3000 }).status !== 0) return { state: 'none', text: 'kein systemd-Benutzerdienst' }
  const r = spawnSync('systemctl', ['--user', 'is-active', 'm3dusa'], { encoding: 'utf8', timeout: 3000 })
  return (r.stdout || '').trim() === 'active' ? { state: 'ok' } : { state: 'off' }
}
/** Info-Objekt anlegen und Proben im Hintergrund starten; die Proben schreiben ins Objekt. */
function gather(st, { hub = true } = {}) {
  let cfg = {}
  try { cfg = readCfg() } catch { /* unlesbar → wie nicht gekoppelt */ }
  const paired = isPaired(cfg)
  const info = {
    version: VERSION, node: process.versions.node, device: cfg.name || os.hostname(), host: os.hostname(),
    hub: paired ? { state: 'wait', server: cfg.server } : { state: 'off' }, service: probeService(),
    agents: { claude: { state: 'wait' }, codex: { state: 'wait' } }, cwd: st.cwd, agent: st.agent, model: st.model, mode: modeOf(cfg),
  }
  const jobs = ['claude', 'codex'].map(k => probeAgent(k).then(v => { info.agents[k] = v }))
  if (paired && hub) jobs.push(probeHub(cfg).then(v => { info.hub = v }))
  return { info, done: Promise.all(jobs) }
}

// ─── Ausgabe-Helfer ───────────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))
const HIDE = '\x1b[?25l', SHOW = '\x1b[?25h'
let cursorHidden = false
function restoreTerminal() {
  if (cursorHidden) { try { process.stdout.write(SHOW) } catch { /* zu */ } cursorHidden = false }
  try { if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false) } catch { /* zu */ }
}
async function playIntro(out, frames, ms) {
  const h = frames[0].split('\n').length
  out.write(HIDE); cursorHidden = true
  try {
    for (let i = 0; i < frames.length; i++) {
      out.write((i ? `\x1b[${h - 1}A\r` : '') + frames[i].split('\n').map(l => '\x1b[2K' + l).join('\n'))
      await sleep(ms)
    }
    out.write('\n')
  } finally { out.write(SHOW); cursorHidden = false }
}
const fmtDur = ms => ms < 60e3 ? (ms / 1000).toFixed(1).replace('.', ',') + ' s' : `${Math.floor(ms / 60e3)} min ${String(Math.round((ms % 60e3) / 1000)).padStart(2, '0')} s`
/** Steuerzeichen/ANSI aus Agenten-Text entfernen (kein Terminal-Escape von außen), Tabs → 2 Leerzeichen. */
const sanitize = s => stripAnsi(String(s)).replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
function wrapPlain(s, w) {
  if (w < 4) return [s]
  const out = []; let cur = '', cw = 0
  for (const ch of s) { const x = charWidth(ch); if (cw + x > w) { out.push(cur); cur = ''; cw = 0 } cur += ch; cw += x }
  out.push(cur); return out
}

const COMMANDS = ['/hilfe', '/claude', '/codex', '/modell', '/status', '/ordner', '/neu', '/gaeste', '/dienst', '/ende']
const SUBS = { '/dienst': ['status', 'start', 'stop', 'neustart', 'logs'], '/gaeste': ['alle', 'sperren'] }
const CLAUDE_ALIASES = ['standard', 'opus', 'sonnet', 'haiku'] // laut `claude --help`: Alias wie 'sonnet' oder 'opus'
const MODEL_RE = /^[\w.:/\-[\]]{1,80}$/

function complete(st, line) {
  if (!line.startsWith('/')) return [[], line]
  const sp = line.indexOf(' ')
  if (sp < 0) { const hits = COMMANDS.filter(c => c.startsWith(line)); return [hits.length ? hits : COMMANDS, line] }
  const cmd = line.slice(0, sp), arg = line.slice(sp + 1)
  if (cmd === '/ordner') {
    const cut = Math.max(arg.lastIndexOf('/'), process.platform === 'win32' ? arg.lastIndexOf('\\') : -1)
    const dirPart = cut >= 0 ? arg.slice(0, cut + 1) : ''
    const base = arg.slice(cut + 1)
    const dir = path.resolve(st.cwd, expandHome(dirPart || '.'))
    let names = []
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith(base) && (base.startsWith('.') || !d.name.startsWith('.'))).map(d => dirPart + d.name + '/') } catch { /* kein Ordner */ }
    return [names.sort(), arg]
  }
  const pool = cmd === '/modell' ? (st.agent === 'claude' ? CLAUDE_ALIASES : ['standard']) : SUBS[cmd] || []
  const hits = pool.filter(x => x.startsWith(arg))
  return [hits, arg]
}

// ─── Hauptprogramm ────────────────────────────────────────────────────────────────────────────
export async function runTui({ bin, argv = [] } = {}) {
  const out = process.stdout
  const tty = !!(process.stdin.isTTY && out.isTTY)
  const level = colorLevel(out)
  const cols = () => Math.max(20, out.columns || 80)
  const noAnim = !tty || !level || argv.includes('--no-anim') || process.env.M3DUSA_NO_ANIM === '1' || (out.rows && out.rows < 16)
  const st = { agent: 'claude', model: null, cwd: process.cwd(), sessions: {}, history: [], run: null, used: false }
  const C = {
    dim: s => (level ? SGR.dim + s + RST : s), b: s => (level ? SGR.b + s + RST : s),
    ok: s => (level ? fg(GR, level) + s + RST : s), warn: s => (level ? SGR.warn + s + RST : s), err: s => (level ? SGR.err + s + RST : s),
    acc: s => (level ? fg(CY, level) + s + RST : s), vio: s => (level ? fg(V, level) + s + RST : s),
    grad: s => (level ? [...s].map((ch, i, a) => fg(grad((i / Math.max(1, a.length)) * 0.67), level) + ch).join('') + RST : s),
  }
  const say = (s = '') => out.write(s + '\n')

  process.on('exit', restoreTerminal)
  process.on('uncaughtException', e => { restoreTerminal(); console.error('✗ ' + (e?.stack || e)); process.exit(1) })
  process.on('SIGINT', () => { if (st.run) st.run.abort(); else { restoreTerminal(); out.write('\n'); process.exit(130) } })
  process.on('SIGTERM', () => { st.run?.abort(); restoreTerminal(); process.exit(143) })

  // Proben laufen parallel zur Animation.
  const t0 = Date.now()
  const g = gather(st)
  const frames = renderFrames({ cols: cols(), color: level })
  if (noAnim) say(frames[frames.length - 1])
  else await playIntro(out, frames, 50)
  await Promise.race([g.done, sleep(Math.max(500, 2400 - (Date.now() - t0)))])
  if (g.info.agents.claude.state === 'missing' && g.info.agents.codex.state === 'ok') st.agent = g.info.agent = 'codex'
  say('\n' + indent(renderStatus(g.info, cols() - 2, { color: level })))
  const pending = g.info.hub.state === 'wait' || Object.values(g.info.agents).some(a => a.state === 'wait')
  say(C.dim(`  Schreib einfach los — dein Auftrag geht an ${st.agent} in diesem Ordner.  /hilfe zeigt alle Befehle.`))
  if (pending) say(C.dim('  … = Prüfung läuft noch; /status zeigt den neuen Stand.'))
  say()

  const input = tty ? ttyInput(st, C, out) : lineInput(st, C, out)
  for (;;) {
    const line = await input.read()
    if (line === null || line === '\0EXIT') break
    const text = line.trim()
    if (!text) continue
    if (text.startsWith('/')) { if ((await command(text)) === 'exit') break; continue }
    await runAgent(text)
  }
  say(C.dim('  ') + C.grad('Bis bald.') + C.dim('  — m3dusa'))
  restoreTerminal()
  process.exit(0)

  // ── Befehle ──
  async function command(text) {
    const [cmd0, ...args] = text.split(/\s+/)
    const cmd = cmd0.toLowerCase()
    const arg = text.slice(cmd0.length).trim()
    switch (cmd) {
      case '/': case '/hilfe': case '/help': case '/?': return help()
      case '/ende': case '/exit': case '/quit': case '/beenden': return 'exit'
      case '/claude': case '/codex': {
        const k = cmd.slice(1)
        if (st.agent === k) return say(C.dim(`  ${k} ist schon aktiv.`))
        st.agent = k; st.model = null
        const a = await probeAgent(k)
        say(C.ok('  ✓ ') + `Agent: ${C.acc(k)}` + (a.state === 'ok' ? C.dim(' ' + a.text) : C.warn('  (hier nicht gefunden)')) + C.dim('  · Modell zurück auf Standard'))
        return
      }
      case '/modell': case '/model': {
        if (!arg) return say(`  Modell für ${C.acc(st.agent)}: ${st.model ? C.b(st.model) : 'Standard'}` + C.dim(st.agent === 'claude' ? '   (z. B. /modell opus · /modell sonnet · /modell standard)' : '   (/modell <name> · /modell standard)'))
        if (arg === 'standard' || arg === 'default') { st.model = null; return say(C.ok('  ✓ ') + 'Modell: Standard') }
        if (!MODEL_RE.test(arg)) return say(C.err('  ✗ ') + 'Ungültiger Modellname.')
        st.model = arg
        return say(C.ok('  ✓ ') + `Modell für ${st.agent}: ${C.b(arg)}` + C.dim(` (gilt ab dem nächsten Auftrag, ${st.agent === 'claude' ? '--model' : '-m'})`))
      }
      case '/status': {
        const s = gather(st)
        if (s.info.hub.state === 'wait' || Object.values(s.info.agents).some(a => a.state === 'wait')) out.write(C.dim('  prüft …'))
        await Promise.race([s.done, sleep(5000)])
        out.write('\r\x1b[2K')
        say(indent(renderStatus(s.info, cols() - 2, { color: level })))
        return
      }
      case '/ordner': case '/cd': {
        if (!arg) return say('  Ordner: ' + C.b(tildify(st.cwd)))
        const p = path.resolve(st.cwd, expandHome(arg.replace(/^["']|["']$/g, '')))
        let real
        try { real = fs.realpathSync(p) } catch { return say(C.err('  ✗ ') + 'Ordner gibt es nicht: ' + p) }
        if (!fs.statSync(real).isDirectory()) return say(C.err('  ✗ ') + 'Kein Ordner: ' + real)
        st.cwd = real
        const had = Object.keys(st.sessions).length > 0
        st.sessions = {}
        return say(C.ok('  ✓ ') + 'Ordner: ' + C.b(tildify(real)) + (had ? C.dim('  · neuer Kontext (Sitzungen gehören zum Ordner)') : ''))
      }
      case '/neu': case '/new': case '/clear':
        st.sessions = {}
        return say(C.ok('  ✓ ') + 'Kontext vergessen — der nächste Auftrag startet frisch.')
      case '/gaeste': case '/gäste': return sub(['gaeste', ...args])
      case '/dienst': return sub(['dienst', ...(args.length ? args : ['status'])])
      default:
        return say(C.warn('  ? ') + `Unbekannter Befehl ${cmd0}. ` + C.dim('/hilfe zeigt alle Befehle.'))
    }
  }

  function help() {
    const r = (a, b) => say('  ' + C.acc(a.padEnd(22)) + b)
    say(); say('  ' + C.b('Befehle'))
    r('/hilfe', 'diese Übersicht')
    r('/claude · /codex', 'Agent wechseln (aktiv: ' + st.agent + ')')
    r('/modell <name>', 'Modell setzen · ohne Name: anzeigen · „standard“: zurücksetzen')
    r('/status', 'Statusfeld neu (Hub, Dienst, Agenten)')
    r('/ordner <pfad>', 'Arbeitsordner wechseln (Tab ergänzt Ordner)')
    r('/neu', 'Kontext vergessen, nächster Auftrag startet frisch')
    r('/gaeste [alle]', 'Gastzugänge — wie m3dusa gaeste')
    r('/dienst [aktion]', 'status · start · stop · neustart · logs — wie m3dusa dienst')
    r('/ende', 'beenden (auch Strg+D oder zweimal Strg+C)')
    say()
    say('  ' + C.dim('Alles andere geht als Auftrag an den aktiven Agenten im aktuellen Ordner.'))
    say('  ' + C.dim('Zeile mit \\ beenden = weiterschreiben · ↑/↓ Verlauf · Tab ergänzt · Strg+C bricht einen Lauf ab.'))
    say('  ' + C.dim('Folgeaufträge behalten den Kontext (claude --resume / codex exec resume).'))
    say()
  }

  function sub(args) {
    if (!bin) return say(C.err('  ✗ ') + 'Befehl hier nicht verfügbar.')
    const r = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit', cwd: st.cwd })
    if (r.error) say(C.err('  ✗ ') + r.error.message)
  }

  // ── Agentenlauf ──
  async function runAgent(prompt) {
    const kind = st.agent
    const fake = process.env.M3DUSA_TUI_FAKE_AGENT
    if (!fake) {
      const a = await probeAgent(kind)
      if (a.state !== 'ok') return say(C.err('  ✗ ') + (kind === 'claude' ? 'Claude Code fehlt: npm i -g @anthropic-ai/claude-code, dann einmal `claude` (anmelden).' : 'Codex fehlt: npm i -g @openai/codex, dann `codex login`.'))
    }
    const resume = st.sessions[kind]
    const argv = agentArgv(kind, { model: st.model, resume })
    let cmd, args, opts = { cwd: st.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    if (fake) { cmd = process.execPath; args = [path.resolve(fake), ...argv] }
    else if (process.platform === 'win32') { cmd = argv[0]; args = argv.slice(1); opts.shell = true } // claude.cmd/.ps1; Argumente sind geprüft (keine Leerzeichen/Sonderzeichen)
    else { const v = viaLoginShell(argv); cmd = v[0]; args = v.slice(1) }
    // Eigene Prozessgruppe (nicht Windows): ein Abbruch erreicht so auch die Werkzeugprozesse des Agenten.
    if (process.platform !== 'win32') opts.detached = true

    const W = cols()
    say()
    say('  ' + C.acc('●') + ' ' + C.b(kind) + C.dim(' · ') + tildify(st.cwd) + (st.model ? C.dim(' · ' + st.model) : '') + (resume ? C.dim('  ↺ Fortsetzung') : ''))
    const gut = C.vio('  │ ')
    const t0 = Date.now()
    let p
    try { p = spawn(cmd, args, opts) } catch (e) { return say(C.err('  ✗ ') + 'Start fehlgeschlagen: ' + e.message) }
    let aborted = false, lastOut = Date.now(), spinOn = false, spinI = 0, shown = 0, final, sawErr = false
    const SP = level ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['|', '/', '-', '\\']
    const clearSpin = () => { if (spinOn) { out.write('\r\x1b[2K'); spinOn = false } }
    const spin = tty ? setInterval(() => {
      if (Date.now() - lastOut < 350) return
      if (!spinOn) { out.write(HIDE); cursorHidden = true }
      spinOn = true
      out.write('\r\x1b[2K  ' + C.acc(SP[spinI++ % SP.length]) + ' ' + C.dim(`${kind} arbeitet … ${Math.floor((Date.now() - t0) / 1000)} s   (Strg+C bricht ab)`))
    }, 90) : null
    const emit = (text, style) => {
      clearSpin()
      for (const raw of sanitize(text).split('\n')) {
        for (const piece of wrapPlain(raw, W - 6)) {
          const s = style === 'tool' ? C.acc(piece) : style === 'err' ? C.warn(piece) : piece
          say(gut + s)
        }
      }
      shown++; lastOut = Date.now()
    }
    const abort = () => {
      if (aborted) return
      aborted = true
      clearSpin(); say(C.warn('  ■ ') + C.dim('breche ab …'))
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
        else {
          // Ganze Gruppe (negative PID); gibt es sie nicht (mehr), dann nur den Agenten selbst.
          const sig = s => { try { process.kill(-p.pid, s) } catch { try { p.kill(s) } catch { /* weg */ } } }
          sig('SIGINT'); setTimeout(() => sig('SIGTERM'), 2000).unref(); setTimeout(() => sig('SIGKILL'), 5000).unref()
        }
      } catch { /* schon beendet */ }
    }
    st.run = { abort }
    let onKey = null
    if (tty) {
      onKey = b => { if (b.includes(3)) abort() } // Strg+C im Rohmodus
      try { process.stdin.setRawMode(true) } catch { /* egal */ }
      process.stdin.on('data', onKey); process.stdin.resume()
    }
    let pend = '', errPend = ''
    const onLine = line => {
      const sid = sessionOf(kind, line)
      if (sid) st.sessions[kind] = sid
      const r = readAgentLine(kind, line)
      if (r.show) emit(r.show, /^(→ |\$ |✎ )/.test(r.show) ? 'tool' : r.error ? 'err' : '')
      if (r.final !== undefined) final = r.final
      if (r.error) sawErr = true
    }
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8') // Zeichen über Stückgrenzen hinweg ganz lassen
    p.stdout.on('data', b => { pend += b; let i; while ((i = pend.indexOf('\n')) >= 0) { onLine(pend.slice(0, i).replace(/\r$/, '')); pend = pend.slice(i + 1) } })
    p.stderr.on('data', b => { errPend += b; let i; while ((i = errPend.indexOf('\n')) >= 0) { const l = errPend.slice(0, i).replace(/\r$/, ''); errPend = errPend.slice(i + 1); if (l.trim()) emit(l, 'err') } })
    p.stdin.on('error', () => { /* Agent hat stdin früh geschlossen */ })
    p.stdin.end(prompt)
    const code = await new Promise(res => { p.on('error', e => { emit('Start fehlgeschlagen: ' + e.message, 'err'); res(127) }); p.on('close', c => res(c)) })
    if (pend.trim()) onLine(pend)
    if (errPend.trim()) emit(errPend, 'err')
    if (spin) clearInterval(spin)
    clearSpin()
    if (cursorHidden) { out.write(SHOW); cursorHidden = false }
    if (tty) { process.stdin.off('data', onKey); try { process.stdin.setRawMode(false) } catch { /* egal */ } process.stdin.pause() }
    st.run = null
    if (!shown && final) emit(final)
    const dur = fmtDur(Date.now() - t0)
    if (aborted) say(C.warn('  ■ abgebrochen') + C.dim(' · ' + dur))
    else if (code === 0 && !sawErr) say(C.ok('  ✓ fertig') + C.dim(' · ' + dur + (st.sessions[kind] ? '  · Kontext bleibt (/neu vergisst ihn)' : '')))
    else {
      say(C.err(`  ✗ ${code === 0 ? 'Fehler' : 'Exit ' + code}`) + C.dim(' · ' + dur))
      if (resume && !shown) { delete st.sessions[kind]; say(C.dim('  Fortsetzung hat nicht geklappt — der nächste Auftrag startet frisch.')) }
    }
    if (kind === 'codex' && code === 0 && !st.sessions.codex) say(C.dim('  (codex hat keine Sitzungskennung geliefert — der nächste Auftrag startet ohne Kontext)'))
    say()
  }
}

const indent = s => s.split('\n').map(l => '  ' + l).join('\n')
function promptStr(st, level) {
  const a = level ? fg(CY, level) + st.agent + RST : st.agent
  const d = path.basename(st.cwd) || st.cwd
  const arrow = level ? '\x1b[1m' + fg(V, level) + '❯' + RST : '❯'
  return `${a} ${level ? SGR.dim + d + RST : d} ${arrow} `
}

/** Eingabe im echten Terminal: readline je Prompt (zwischen den Läufen gehört stdin dem Lauf). */
function ttyInput(st, C, out) {
  const level = colorLevel(out)
  return {
    read: () => new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true, history: st.history, historySize: 500, removeHistoryDuplicates: true, completer: l => complete(st, l), tabSize: 2 })
      let buf = [], done = false, lastInt = 0
      const prompt = () => { rl.setPrompt(buf.length ? C.dim('  … ') : promptStr(st, level)); rl.prompt() }
      const finish = v => { if (done) return; done = true; st.history = rl.history || st.history; rl.close(); resolve(v) }
      rl.on('line', l => {
        if (l.endsWith('\\')) { buf.push(l.slice(0, -1)); prompt(); return }
        buf.push(l); finish(buf.join('\n'))
      })
      rl.on('SIGINT', () => {
        if (rl.line || buf.length) { rl.write(null, { ctrl: true, name: 'e' }); rl.write(null, { ctrl: true, name: 'u' }); buf = []; out.write(C.dim('^C') + '\n'); prompt(); return }
        if (Date.now() - lastInt < 2500) { out.write('\n'); return finish('\0EXIT') }
        lastInt = Date.now()
        out.write('\n' + C.dim('  (Nochmal Strg+C zum Beenden — oder /ende)') + '\n'); prompt()
      })
      rl.on('close', () => { if (!done) { done = true; out.write('\n'); resolve(null) } })
      prompt()
    }),
  }
}

/** Eingabe ohne TTY (M3DUSA_TUI_FORCE=1 / `m3dusa chat` mit Umleitung): Zeilen von stdin, Prompt + Zeile werden mitgeschrieben. */
function lineInput(st, C, out) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  const queue = [], waiters = []
  let ended = false
  rl.on('line', l => (waiters.length ? waiters.shift()(l) : queue.push(l)))
  rl.on('close', () => { ended = true; while (waiters.length) waiters.shift()(null) })
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : ended ? Promise.resolve(null) : new Promise(r => waiters.push(r)))
  return {
    async read() {
      const buf = []
      for (;;) {
        out.write(buf.length ? '  … ' : promptStr(st, false))
        const l = await next()
        if (l === null) { out.write('\n'); return buf.length ? buf.join('\n') : null }
        out.write(l + '\n')
        if (l.endsWith('\\')) { buf.push(l.slice(0, -1)); continue }
        buf.push(l); return buf.join('\n')
      }
    },
  }
}
