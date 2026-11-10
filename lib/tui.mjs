// Terminal-Modus: `m3dusa` ohne Argumente in einem echten Terminal (oder `m3dusa chat`).
// Start-Animation → Statusfeld → Eingabeschleife; Freitext geht an den aktiven Agenten (claude/codex)
// im aktuellen Ordner, Ausgabe wird live gezeigt. Keine Alternate-Screen-Übernahme: alles bleibt im Scrollback.
// 1.4.0: „/“-Vorschläge beim Tippen, Modell-/Aufwand-Auswahl (Claude + Codex), Anmeldestatus + Login, Token/Kosten.
//
// Test-Schalter (wie M3DUSA_TEST_CLOCK_FILE im Bestand):
//   M3DUSA_TUI_FAKE_AGENT=<skript.mjs>  startet statt claude/codex `node <skript> <agent-argv…>` (kein Kontingent) —
//                                       auch für die Anmeldung (`node <skript> codex login …`)
//   M3DUSA_TUI_FAKE_AUTH=claude=yes,codex=no   Anmeldestatus im Testmodus (Standard: yes)
//   M3DUSA_TUI_FAKE_CODEX_MODELS=<skript.mjs>  Ersatz für `codex app-server` (model/list) im Testmodus
//   M3DUSA_TUI_FORCE=1                  Terminal-Modus auch ohne TTY (liest Zeilen von stdin)
//   M3DUSA_NO_ANIM=1 / --no-anim        keine Animation, nur ruhiges Banner
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { expandHome, HOME, hubCall, isPaired, readCfg, VERSION } from './core.mjs'
import { modeOf } from './policy.mjs'
import { agentArgv, AGENTS, authArgv, CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS, codexModels, INSTALL, locateAgent, loginPlan, MODEL_RE, parseAuth, readAgentLine, sessionOf, spawnSpec } from './agents.mjs'
import { estimate, fmtInt, fmtUsd } from './prices.mjs'

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
    if (!text) continue
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

/** Eine Agenten-Zeile im Statusfeld: Version, Anmeldestatus (angemeldet ✓ / nicht angemeldet / fehlt / unbekannt). */
function agentRow(k, a) {
  if (!a || a.state === 'wait') return [['… prüft', 'dim']]
  if (a.state === 'broken') return [['● gefunden, startet nicht', 'err'], ['  m3dusa pruefen', 'dim']]
  if (a.state !== 'ok') return [['○ fehlt', 'err'], ['  ' + INSTALL[k], 'dim']]
  const auth = a.auth === 'yes' ? [['  angemeldet ✓', 'ok']]
    : a.auth === 'no' ? [['  nicht angemeldet', 'warn'], [`  /${k} login`, 'dim']]
    : a.auth === 'unknown' ? [['  Anmeldung unbekannt', 'dim']] : [['  Anmeldung …', 'dim']]
  return [['● ', 'ok'], [a.text || '', 'b'], ...auth]
}

/**
 * Reine Funktion: Statusfeld als String (Box-Rahmen, alle Zeilen gleich sichtbar breit, ≤ cols).
 * info: { version, node, device, host, hub:{state,text,server}, service:{state,text}, agents:{claude:{state,text,auth},codex:{…}},
 *         cwd, agent, model, effort, mode }   state: ok | off | err | warn | wait | none | missing | broken; auth: yes | no | unknown | wait
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
  const rows = [
    ['Version', [[String(info.version || VERSION), 'b'], [`  ·  Node ${info.node || process.versions.node}`, 'dim']]],
    ['Gerät', [[String(info.device || os.hostname()), ''], ...(info.host && info.host !== info.device ? [[`  (${info.host})`, 'dim']] : [])]],
    ['Hub', hub],
    ['Dienst', svc],
    ['Claude', agentRow('claude', info.agents?.claude)],
    ['Codex', agentRow('codex', info.agents?.codex)],
    ['Ordner', [[shortPath(info.cwd || process.cwd(), VW), '']]],
    ['Aktiv', [[info.agent || 'claude', 'acc'], ['  ·  Modell ', 'dim'], [info.model || 'Standard', ''], ['  ·  Aufwand ', 'dim'], [info.effort || 'Standard', '']]],
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

// ─── Befehle, Vorschläge, Auswahllisten (reine Funktionen) ───────────────────────────────────
/** Alle Befehle des Terminal-Modus (Reihenfolge = Vorschlagsliste). needs: Argument nötig (Enter übernimmt nur). */
export const COMMAND_LIST = [
  { name: '/modell', args: '[name]', desc: 'Modell wählen — Liste mit Claude & Codex', group: 'Agent & Modell', aliases: ['/model'] },
  { name: '/aufwand', args: '[stufe]', desc: 'Denkaufwand (low … max) für den aktiven Agenten', group: 'Agent & Modell', aliases: ['/effort'] },
  { name: '/claude', args: '[login]', desc: 'zu Claude Code wechseln · „login“ meldet an', group: 'Agent & Modell' },
  { name: '/codex', args: '[login]', desc: 'zu Codex wechseln · „login“ meldet an', group: 'Agent & Modell' },
  { name: '/login', args: 'claude|codex', desc: 'Agent anmelden (im selben Terminal)', group: 'Agent & Modell' },
  { name: '/kosten', desc: 'Tokens + API-Vergleichspreis dieser Sitzung', group: 'Sitzung', aliases: ['/tokens'] },
  { name: '/neu', desc: 'Kontext vergessen, nächster Auftrag startet frisch', group: 'Sitzung', aliases: ['/new', '/clear'] },
  { name: '/ordner', args: '<pfad>', desc: 'Arbeitsordner wechseln (Tab ergänzt Ordner)', group: 'Sitzung', needs: true, aliases: ['/cd'] },
  { name: '/status', desc: 'Statusfeld neu (Hub, Dienst, Agenten, Anmeldung)', group: 'System' },
  { name: '/gaeste', args: '[alle]', desc: 'Gastzugänge — wie m3dusa gaeste', group: 'System' },
  { name: '/dienst', args: '[aktion]', desc: 'status · start · stop · neustart · logs', group: 'System' },
  { name: '/hilfe', desc: 'alle Befehle', group: 'Allgemein', aliases: ['/help', '/?'] },
  { name: '/ende', desc: 'beenden (auch Strg+D oder zweimal Strg+C)', group: 'Allgemein', aliases: ['/exit', '/quit', '/beenden'] },
]
export const COMMANDS = COMMAND_LIST.map(c => c.name)
const SUBS = { '/dienst': ['status', 'start', 'stop', 'neustart', 'logs'], '/gaeste': ['alle', 'sperren'], '/login': ['claude', 'codex'], '/claude': ['login'], '/codex': ['login'] }

/**
 * Vorschläge für die Eingabezeile: nur solange sie mit „/“ beginnt und noch kein Leerzeichen hat.
 * Zuerst Befehle (oder Aliasse), die mit der Eingabe beginnen, danach solche, die sie enthalten (ab 3 Zeichen nach „/“).
 */
export function filterCommands(line, list = COMMAND_LIST) {
  if (typeof line !== 'string' || !line.startsWith('/') || /\s/.test(line)) return []
  const q = line.toLowerCase(), pre = [], sub = []
  for (const c of list) {
    const names = [c.name, ...(c.aliases || [])]
    const p = names.find(n => n.startsWith(q))
    if (p) { pre.push(p === c.name ? c : { ...c, name: p, aliasOf: c.name }); continue }
    if (q.length > 3 && names.some(n => n.includes(q.slice(1)))) sub.push(c)
  }
  return [...pre, ...sub]
}

/** Vorschlagsliste unter der Eingabe: Zeilen, jede sichtbar ≤ cols-1 (kein Umbruch → Cursor-Rechnung stimmt). */
export function renderSuggestions(items, sel = 0, cols = 80, color = false, max = 8) {
  const level = color === true ? 'truecolor' : color || false
  const W = Math.max(4, Math.floor(cols) - 1)
  if (!items.length) return []
  const h = Math.max(1, Math.min(max, items.length))
  const start = clamp(sel - Math.floor(h / 2), 0, Math.max(0, items.length - h))
  const nameW = Math.min(22, Math.max(...items.map(c => visibleWidth(c.name + (c.args ? ' ' + c.args : '')))))
  const lines = []
  for (let i = start; i < start + h; i++) {
    const c = items[i], on = i === sel
    const nm = (c.name + (c.args ? ' ' + c.args : '')).padEnd(nameW)
    lines.push(segs([['  ' + (on ? '❯ ' : '  '), on ? 'acc' : ''], [nm, on ? 'acc' : 'b'], [W >= 34 ? '  ' + c.desc : '', 'dim']], W, !!level).s)
  }
  if (items.length > h) lines.push(segs([[`    … ${items.length} Befehle · ↑/↓`, 'dim']], W, !!level).s)
  return lines
}

/**
 * Auswahlliste (Modell, Aufwand, Anmeldung): Kopfzeile, Einträge (Gruppen-Überschriften: header, ausgegraut: disabled,
 * aktuell: current), Hinweiszeile. Jede Zeile sichtbar ≤ cols-1; höchstens maxRows Zeilen (Fenster um die Auswahl).
 */
export function renderPicker({ title, items, sel = -1, cols = 80, color = false, maxRows = 20, hint = '↑/↓ wählen · Enter übernimmt · Esc bricht ab' }) {
  const level = color === true ? 'truecolor' : color || false
  const W = Math.max(6, Math.floor(cols) - 1)
  const labW = Math.min(24, Math.max(4, ...items.filter(x => !x.header).map(x => visibleWidth(x.label || ''))))
  const row = (it, i) => {
    if (it.header) return segs([['  ' + it.label, it.disabled ? 'dim' : 'b'], [it.note ? '  ' + it.note : '', it.disabled ? 'dim' : 'warn']], W, !!level).s
    if (it.disabled) return segs([['      ' + it.label, 'dim']], W, !!level).s
    const on = i === sel
    return segs([['  ' + (on ? '❯ ' : '  '), on ? 'acc' : ''], [String(it.label).padEnd(labW), on ? 'acc' : ''], [it.current ? ' ●' : '  ', 'ok'], [W >= 40 && it.desc ? '  ' + it.desc : '', 'dim']], W, !!level).s
  }
  const body = items.map(row)
  const h = Math.max(1, maxRows - 2)
  let start = 0
  if (body.length > h) start = clamp((sel < 0 ? 0 : sel) - Math.floor(h / 2), 0, body.length - h)
  const shown = body.slice(start, start + h)
  const more = body.length > h ? `  ·  ${start + 1}–${start + shown.length} von ${body.length}` : ''
  return [segs([[title, 'b']], W, !!level).s, ...shown, segs([['  ' + hint + more, 'dim']], W, !!level).s]
}

/** /hilfe als gruppierte Tabelle. */
export function helpLines(cols = 80, color = false) {
  const level = color === true ? 'truecolor' : color || false
  const W = Math.max(10, Math.floor(cols) - 1)
  const nameW = Math.min(22, Math.max(...COMMAND_LIST.map(c => visibleWidth(c.name + (c.args ? ' ' + c.args : '')))))
  const out = ['', segs([['  Befehle', 'b'], ['   „/“ tippen zeigt sie beim Schreiben', 'dim']], W, !!level).s]
  for (const g of [...new Set(COMMAND_LIST.map(c => c.group))]) {
    out.push(segs([['  ' + g, 'acc']], W, !!level).s)
    for (const c of COMMAND_LIST.filter(x => x.group === g)) {
      const nm = (c.name + (c.args ? ' ' + c.args : '')).padEnd(nameW)
      const al = c.aliases?.length ? `  (${c.aliases.join(' ')})` : ''
      out.push(segs([['    ' + nm, 'b'], ['  ' + c.desc, ''], [al, 'dim']], W, !!level).s)
    }
  }
  out.push('', segs([['  Alles andere geht als Auftrag an den aktiven Agenten im aktuellen Ordner.', 'dim']], W, !!level).s)
  out.push(segs([['  \\ am Zeilenende = weiterschreiben · ↑/↓ Verlauf · Tab ergänzt · Strg+C bricht einen Lauf ab.', 'dim']], W, !!level).s)
  out.push(segs([['  Folgeaufträge behalten den Kontext (claude --resume / codex exec resume).', 'dim']], W, !!level).s, '')
  return out
}

/** Zu welchem Agenten gehört ein frei eingegebener Modellname? (Wahl über /modell <name> wechselt den Agenten mit.) */
export function agentForModel(name, current = 'claude', codexList = []) {
  const n = String(name || '').toLowerCase()
  if (CLAUDE_MODELS.some(m => m.value === n) || n.startsWith('claude')) return 'claude'
  if (codexList.some(m => m.value.toLowerCase() === n) || /^(gpt|o\d|codex)/.test(n)) return 'codex'
  return current
}
const EFFORT_DESC = { minimal: 'kaum Nachdenken', low: 'schnell, wenig Nachdenken', medium: 'ausgewogen', high: 'gründlich', xhigh: 'sehr gründlich', max: 'maximal — langsam, teuer' }

// ─── Token & Kosten (reine Funktionen) ───────────────────────────────────────────────────────
/**
 * Token-Meldungen eines Laufs (readAgentLine › usage) → Einträge je Modell mit Schätzung.
 * fallbackModel: Modell, wenn der Agent keins meldet (Codex: gewähltes bzw. Standardmodell).
 */
export function runRecords(usages, { agent, fallbackModel, runId = 0, entries } = {}) {
  const recs = []
  for (const u of usages || []) {
    for (const it of u.items || []) {
      const model = it.model || fallbackModel || null
      const tok = { inputTokens: it.inputTokens || 0, outputTokens: it.outputTokens || 0, cacheReadTokens: it.cacheReadTokens || 0, cacheWriteTokens: it.cacheWriteTokens ?? null, ...(it.cacheWriteByTtl ? { cacheWriteByTtl: it.cacheWriteByTtl } : {}) }
      recs.push({ runId, agent, model, ...tok, est: estimate(model, tok, entries) })
    }
  }
  return recs
}
const priceOf = x => {
  if (x.unknown && !x.priced) return 'unbekannt'
  const v = x.min === x.max ? fmtUsd(x.min) : fmtUsd(x.min) + '–' + fmtUsd(x.max).slice(1)
  return (x.lowerBound ? 'ab ' : '') + v + (x.unknown ? ' + ?' : '')
}
/** Summen je Agent+Modell und gesamt (für /kosten). */
export function sessionTotals(records) {
  const blank = () => ({ runs: new Set(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, min: 0, max: 0, unknown: 0, priced: 0, lowerBound: false })
  const add = (x, r) => {
    x.runs.add(r.runId); x.input += r.inputTokens; x.output += r.outputTokens; x.cacheRead += r.cacheReadTokens; x.cacheWrite += r.cacheWriteTokens || 0
    if (r.est && !r.est.unknown) { x.min += r.est.min; x.max += r.est.max; x.priced++; if (r.est.lowerBound) x.lowerBound = true } else x.unknown++
  }
  const map = new Map(), total = blank()
  for (const r of records) {
    const key = r.agent + ' ' + (r.model || '?')
    if (!map.has(key)) map.set(key, { agent: r.agent, model: r.model || '?', ...blank() })
    add(map.get(key), r); add(total, r)
  }
  const fin = x => ({ ...x, runs: x.runs.size, price: priceOf(x) })
  return { rows: [...map.values()].map(fin), total: fin(total) }
}
/** Zeile nach einem Auftrag: { tokens, price, note } (Klartext; die Farbe setzt der Aufrufer). */
export function usageSummary(records) {
  const t = sessionTotals(records).total
  const unknownWhy = records.find(r => r.est?.unknown)?.est.unknown
  const unknownModel = records.find(r => r.est?.unknown)?.model
  return {
    tokens: `Eingabe ${fmtInt(t.input)} · Ausgabe ${fmtInt(t.output)} · Cache ${fmtInt(t.cacheRead)} gelesen` + (t.cacheWrite ? ` / ${fmtInt(t.cacheWrite)} geschrieben` : ''),
    price: t.priced ? `entspräche API-Preis ≈ ${t.price}` : 'API-Preis unbekannt',
    note: (t.unknown ? `${unknownModel || 'Modell'}: ${unknownWhy}` : '') + (t.lowerBound ? (t.unknown ? '; ' : '') + 'Cache-Schreiben nicht gemeldet → Untergrenze' : ''),
  }
}
/** /kosten als kleine Tabelle (passt sich der Breite an). */
export function costTable(records, cols = 80, color = false) {
  const level = color === true ? 'truecolor' : color || false
  const W = Math.max(20, Math.floor(cols) - 1)
  const { rows, total } = sessionTotals(records)
  const wide = W >= 86, mid = W >= 56
  const head = ['Agent · Modell', 'Läufe', 'Eingabe', 'Ausgabe', ...(wide ? ['Cache lesen', 'Cache schreib.'] : []), '≈ API-Preis']
  const cells = x => [`${x.agent} · ${x.model}`, String(x.runs), fmtInt(x.input), fmtInt(x.output), ...(wide ? [fmtInt(x.cacheRead), fmtInt(x.cacheWrite)] : []), x.price]
  const body = rows.map(cells)
  const sum = cells({ ...total, agent: 'Summe', model: 'Sitzung' }); sum[0] = 'Summe'
  const all = [head, ...body, sum]
  const pick = r => (mid ? r : [r[0], r[r.length - 1]])
  const tab = all.map(pick)
  const widths = tab[0].map((_, i) => Math.max(...tab.map(r => visibleWidth(r[i]))))
  widths[0] = Math.min(widths[0], Math.max(10, W - 2 - widths.slice(1).reduce((s, w) => s + w + 2, 0)))
  const fmtRow = (r, st) => segs([['  ', ''], ...r.map((c, i) => [(i === 0 ? clipPlain(c, widths[0]).padEnd(widths[0]) : c.padStart(widths[i])) + (i < r.length - 1 ? '  ' : ''), st])], W, !!level).s
  const lines = ['', fmtRow(tab[0], 'dim'), ...tab.slice(1, -1).map(r => fmtRow(r, '')), segs([['  ' + '─'.repeat(Math.min(W - 2, widths.reduce((s, w) => s + w + 2, -2))), 'dim']], W, !!level).s, fmtRow(tab[tab.length - 1], 'b')]
  lines.push(segs([['  Abo: nur Vergleichswert — so viel kostete es über die API (Preise: lib/prices.json).', 'dim']], W, !!level).s, '')
  return lines
}

// ─── Proben (Hub, Dienst, Agenten, Anmeldung) ─────────────────────────────────────────────────
const fakeAuth = k => { const m = new RegExp('(?:^|,)\\s*' + k + '=(\\w+)').exec(process.env.M3DUSA_TUI_FAKE_AUTH || ''); return m ? m[1] : 'yes' }
/** Programm starten, stdout+stderr sammeln (Zeitlimit). */
function runCapture(argv, loc, timeout) {
  return new Promise(res => {
    let p, out = '', done = false
    const fin = code => { if (done) return; done = true; clearTimeout(t); res({ code, out }) }
    const t = setTimeout(() => { try { p?.kill('SIGKILL') } catch { /* weg */ } fin(null) }, timeout)
    const sp = spawnSpec(argv, loc)
    try { p = spawn(sp.cmd, sp.args, { shell: sp.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } }) } catch { return fin(null) }
    p.stdout.on('data', b => { out += b }); p.stderr.on('data', b => { out += b })
    p.on('error', () => fin(null))
    p.on('close', code => fin(code))
  })
}
const verCache = {}
/** Agent finden (gemeinsame Erkennung, agents.mjs) + Version. → { state: ok|missing|broken, text, loc, searched } */
function probeAgent(kind, { fresh = false } = {}) {
  if (process.env.M3DUSA_TUI_FAKE_AGENT) return Promise.resolve({ state: 'ok', text: 'Testskript', loc: null })
  if (!fresh && verCache[kind]) return verCache[kind]
  const pr = verCache[kind] = (async () => {
    const loc = process.platform === 'win32' ? null : await locateAgent(kind, { fresh })
    if (loc && !loc.path) return { state: 'missing', searched: loc.searched }
    const r = await runCapture([kind, '--version'], loc, 15000) // nur --version: kein Modellaufruf
    const m = r.out.match(/\d+\.\d+(?:\.\d+)?[\w.-]*/)
    if (r.code === 0 && m) return { state: 'ok', text: m[0], loc }
    return loc ? { state: 'broken', loc, searched: loc.searched } : { state: 'missing', searched: [] }
  })()
  pr.then(v => { if (v.state !== 'ok' && verCache[kind] === pr) delete verCache[kind] })
  return pr
}
/** Anmeldung über das Programm selbst (`claude auth status`, `codex login status`) → yes | no | unknown */
async function probeAuth(kind, loc) {
  if (process.env.M3DUSA_TUI_FAKE_AGENT) return fakeAuth(kind)
  const r = await runCapture(authArgv(kind), loc, 20000)
  return r.code === null ? 'unknown' : parseAuth(kind, r.code, r.out)
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
/** Info-Objekt anlegen und Proben im Hintergrund starten; die Proben schreiben ins Objekt (und in st.found/st.auth). */
function gather(st, { hub = true, fresh = false } = {}) {
  let cfg = {}
  try { cfg = readCfg() } catch { /* unlesbar → wie nicht gekoppelt */ }
  const paired = isPaired(cfg)
  const info = {
    version: VERSION, node: process.versions.node, device: cfg.name || os.hostname(), host: os.hostname(),
    hub: paired ? { state: 'wait', server: cfg.server } : { state: 'off' }, service: probeService(),
    agents: { claude: { state: 'wait' }, codex: { state: 'wait' } }, cwd: st.cwd, agent: st.agent, model: st.model, effort: st.effort, mode: modeOf(cfg),
  }
  const jobs = AGENTS.map(k => probeAgent(k, { fresh }).then(async v => {
    st.found[k] = v
    info.agents[k] = { ...v, auth: v.state === 'ok' ? 'wait' : undefined }
    if (v.state !== 'ok') return
    const a = await probeAuth(k, v.loc)
    st.auth[k] = a; info.agents[k] = { ...info.agents[k], auth: a }
  }))
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

function complete(st, line) {
  if (!line.startsWith('/')) return [[], line]
  const sp = line.indexOf(' ')
  if (sp < 0) { const hits = COMMANDS.filter(c => c.startsWith(line)); return [hits.length ? hits : COMMANDS, line] }
  const cmd = line.slice(0, sp), arg = line.slice(sp + 1)
  if (cmd === '/ordner' || cmd === '/cd') {
    const cut = Math.max(arg.lastIndexOf('/'), process.platform === 'win32' ? arg.lastIndexOf('\\') : -1)
    const dirPart = cut >= 0 ? arg.slice(0, cut + 1) : ''
    const base = arg.slice(cut + 1)
    const dir = path.resolve(st.cwd, expandHome(dirPart || '.'))
    let names = []
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith(base) && (base.startsWith('.') || !d.name.startsWith('.'))).map(d => dirPart + d.name + '/') } catch { /* kein Ordner */ }
    return [names.sort(), arg]
  }
  const pool = cmd === '/modell' || cmd === '/model' ? ['standard', ...CLAUDE_MODELS.map(m => m.value), ...(st.codexModels || []).map(m => m.value)]
    : cmd === '/aufwand' || cmd === '/effort' ? ['standard', ...(st.agent === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS)]
    : SUBS[cmd] || []
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
  const st = { agent: 'claude', model: null, effort: null, cwd: process.cwd(), sessions: {}, history: [], run: null, used: false, found: {}, auth: {}, usage: [], runs: 0, codexModels: undefined, codexDefault: null }
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
  const pending = g.info.hub.state === 'wait' || Object.values(g.info.agents).some(a => a.state === 'wait' || a.auth === 'wait')
  say(C.dim(`  Schreib einfach los — dein Auftrag geht an ${st.agent} in diesem Ordner.  „/“ zeigt alle Befehle.`))
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
      case '/': case '/hilfe': case '/help': case '/?': for (const l of helpLines(cols(), level)) say(l); return
      case '/ende': case '/exit': case '/quit': case '/beenden': return 'exit'
      case '/claude': case '/codex': {
        const k = cmd.slice(1)
        if (/^(login|anmelden)$/i.test(args[0] || '')) return doLogin(k, args[1])
        const a = await probeAgent(k)
        if (a.state !== 'ok') return say(C.err('  ✗ ') + `${k} ist hier nicht ${a.state === 'broken' ? 'startbar' : 'installiert'}. ` + (a.state === 'broken' ? C.dim('m3dusa pruefen zeigt Details.') : 'Installieren: ' + C.b(INSTALL[k]) + C.dim('  · m3dusa pruefen zeigt, wo gesucht wurde')))
        if (st.agent !== k) { switchAgent(k); say(C.ok('  ✓ ') + `Agent: ${C.acc(k)}` + C.dim(' ' + a.text) + C.dim('  · Modell + Aufwand zurück auf Standard')) }
        else say(C.dim(`  ${k} ist schon aktiv.`))
        if (st.auth[k] === undefined) st.auth[k] = await probeAuth(k, a.loc)
        if (st.auth[k] === 'no') {
          const ch = await input.pick({ title: `${k} ist nicht angemeldet. Jetzt anmelden?`, items: [{ label: 'Ja, jetzt anmelden', value: 'ja' }, { label: 'Nein, später', value: 'nein', desc: `/${k} login` }] })
          if (ch?.value === 'ja') return doLogin(k)
        }
        return
      }
      case '/login': case '/anmelden': {
        let k = (args[0] || '').toLowerCase()
        if (!AGENTS.includes(k)) {
          const ch = await input.pick({ title: 'Welchen Agenten anmelden?', items: AGENTS.map(x => ({ label: x, value: x, desc: st.auth[x] === 'yes' ? 'angemeldet ✓' : st.auth[x] === 'no' ? 'nicht angemeldet' : '' })) })
          if (!ch) return say(C.dim('  abgebrochen.'))
          k = ch.value
        }
        return doLogin(k, args[1])
      }
      case '/modell': case '/model': {
        if (!arg) return modelPicker()
        if (/^(standard|default)$/i.test(arg)) { st.model = null; return say(C.ok('  ✓ ') + `Modell für ${st.agent}: Standard`) }
        if (!MODEL_RE.test(arg)) return say(C.err('  ✗ ') + 'Ungültiger Modellname.')
        const k = agentForModel(arg, st.agent, st.codexModels || [])
        if (k !== st.agent) { const a = await probeAgent(k); if (a.state !== 'ok') return say(C.err('  ✗ ') + `„${arg}“ gehört zu ${k}, und ${k} ist hier nicht installiert (${INSTALL[k]}).`) }
        setModel(k, arg)
        return
      }
      case '/aufwand': case '/effort': {
        if (!arg) return effortPicker(st.agent === 'codex' ? (st.codexModels || []).find(m => m.value === (st.model || st.codexDefault)) : null)
        const levels = effortLevels(st.agent)
        if (/^(standard|default)$/i.test(arg)) { st.effort = null; return say(C.ok('  ✓ ') + `Aufwand für ${st.agent}: Standard`) }
        if (!levels.includes(arg.toLowerCase())) return say(C.err('  ✗ ') + `Stufe für ${st.agent}: ${levels.join(' · ')} · standard`)
        st.effort = arg.toLowerCase()
        return say(C.ok('  ✓ ') + `Aufwand für ${st.agent}: ${C.b(st.effort)}` + C.dim(` (gilt ab dem nächsten Auftrag, ${st.agent === 'claude' ? '--effort' : '-c model_reasoning_effort'})`))
      }
      case '/kosten': case '/tokens': case '/kosten:': {
        if (!st.usage.length) return say(C.dim(st.runs ? '  Die Agenten haben in dieser Sitzung keine Token gemeldet.' : '  Noch keine Aufträge in dieser Sitzung.'))
        for (const l of costTable(st.usage, cols(), level)) say(l)
        return
      }
      case '/status': {
        const s = gather(st, { fresh: true })
        if (s.info.hub.state === 'wait' || Object.values(s.info.agents).some(a => a.state === 'wait')) out.write(C.dim('  prüft …'))
        await Promise.race([s.done, sleep(8000)])
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
      default: {
        const hint = filterCommands(cmd)[0]
        return say(C.warn('  ? ') + `Unbekannter Befehl ${cmd0}. ` + C.dim(hint ? `Meintest du ${hint.name}? ` : '') + C.dim('„/“ zeigt alle Befehle.'))
      }
    }
  }

  function switchAgent(k) {
    if (st.agent === k) return
    st.agent = k; st.model = null; st.effort = null
  }
  function effortLevels(k, model) {
    if (k === 'claude') return CLAUDE_EFFORTS
    const m = model || (st.codexModels || []).find(x => x.value === (st.model || st.codexDefault))
    return m?.efforts?.length ? m.efforts : CODEX_EFFORTS
  }
  function setModel(k, model) {
    const switched = st.agent !== k
    if (switched) switchAgent(k)
    st.model = model
    if (st.effort && !effortLevels(k).includes(st.effort)) st.effort = null
    say(C.ok('  ✓ ') + (switched ? `Agent: ${C.acc(k)} · ` : '') + `Modell für ${k}: ${C.b(model || 'Standard')}` + C.dim(model ? ` (gilt ab dem nächsten Auftrag, ${k === 'claude' ? '--model' : '-m'})` : ''))
  }
  async function codexList() {
    if (st.codexModels !== undefined) return st.codexModels
    const fake = process.env.M3DUSA_TUI_FAKE_AGENT
    const fakeSrv = process.env.M3DUSA_TUI_FAKE_CODEX_MODELS
    if (fake && !fakeSrv) return (st.codexModels = [])
    if (tty) out.write(C.dim('  lade Codex-Modelle …'))
    try {
      const a = fake ? null : await probeAgent('codex')
      st.codexModels = await codexModels({ loc: a?.loc, argv: fakeSrv ? [process.execPath, path.resolve(fakeSrv)] : undefined, timeoutMs: 15000, version: VERSION })
    } catch (e) { st.codexModels = []; st.codexModelsErr = e.message }
    if (tty) out.write('\r\x1b[2K')
    st.codexDefault = st.codexModels.find(m => m.isDefault)?.value || null
    return st.codexModels
  }
  async function modelPicker() {
    const items = []
    const cur = (k, v) => st.agent === k && (st.model || '') === v
    for (const k of AGENTS) {
      const a = await probeAgent(k)
      const name = k === 'claude' ? 'Claude' : 'Codex'
      if (a.state !== 'ok') { items.push({ header: true, disabled: true, label: name, note: (a.state === 'broken' ? 'startet nicht — m3dusa pruefen' : 'fehlt — ' + INSTALL[k]) }); continue }
      items.push({ header: true, label: name, note: st.auth[k] === 'no' ? `nicht angemeldet — /${k} login` : '' })
      if (k === 'claude') {
        items.push({ agent: 'claude', value: '', label: 'Standard', desc: 'Einstellung von Claude Code', current: cur('claude', '') })
        for (const m of CLAUDE_MODELS) items.push({ agent: 'claude', value: m.value, label: m.value, desc: m.desc, current: cur('claude', m.value) })
      } else {
        const list = await codexList()
        const def = list.find(m => m.isDefault)
        items.push({ agent: 'codex', value: '', label: 'Standard', desc: def ? 'laut Codex: ' + def.label : 'Einstellung von Codex', current: cur('codex', ''), efforts: def?.efforts })
        for (const m of list) items.push({ agent: 'codex', value: m.value, label: m.value, desc: [m.label !== m.value ? m.label : '', m.desc].filter(Boolean).join(' · '), efforts: m.efforts, current: cur('codex', m.value) })
        if (!list.length) items.push({ disabled: true, label: 'Modellliste nicht abrufbar' + (st.codexModelsErr ? ` (${st.codexModelsErr.slice(0, 60)})` : '') + ' — eigener Name: /modell <name>' })
      }
    }
    if (!items.some(x => !x.header && !x.disabled)) { for (const it of items) say('  ' + it.label + (it.note ? '  ' + C.dim(it.note) : '')); return }
    const ch = await input.pick({ title: 'Modell wählen', items, initial: items.findIndex(x => x.current) })
    if (!ch) return say(C.dim('  Modell unverändert.'))
    setModel(ch.agent, ch.value || null)
    return effortPicker(ch)
  }
  async function effortPicker(model) {
    const k = st.agent
    const levels = effortLevels(k, model?.efforts?.length ? model : null)
    const items = [{ value: '', label: 'Standard', desc: 'Voreinstellung des Agenten', current: !st.effort }, ...levels.map(l => ({ value: l, label: l, desc: EFFORT_DESC[l] || '', current: st.effort === l }))]
    const ch = await input.pick({ title: `Aufwand für ${k}${st.model ? ' · ' + st.model : ''}`, items, initial: items.findIndex(x => x.current) })
    if (!ch) return say(C.dim('  Aufwand unverändert: ' + (st.effort || 'Standard')))
    st.effort = ch.value || null
    say(C.ok('  ✓ ') + `Aufwand für ${k}: ${C.b(st.effort || 'Standard')}`)
  }

  /** Programm im selben Terminal laufen lassen (stdio geerbt). Strg+C trifft dann das Programm, nicht m3dusa. */
  function runInherit(argv, loc) {
    return new Promise(res => {
      const fake = process.env.M3DUSA_TUI_FAKE_AGENT
      const sp = fake ? { cmd: process.execPath, args: [path.resolve(fake), ...argv], shell: false } : spawnSpec(argv, loc)
      let p
      st.run = { abort: () => { /* das Programm bekommt Strg+C selbst */ } }
      try { p = spawn(sp.cmd, sp.args, { stdio: 'inherit', shell: sp.shell, cwd: st.cwd }) } catch (e) { st.run = null; say(C.err('  ✗ ') + e.message); return res(127) }
      p.on('error', e => { say(C.err('  ✗ ') + e.message) })
      p.on('close', code => { st.run = null; res(code) })
    })
  }
  async function doLogin(k, how) {
    if (!AGENTS.includes(k)) return say(C.err('  ✗ ') + 'Aufruf: /login claude|codex')
    const a = await probeAgent(k)
    if (a.state !== 'ok') return say(C.err('  ✗ ') + `${k} ist hier nicht installiert. Zuerst: ` + C.b(INSTALL[k]) + C.dim(`  — danach /${k} login`))
    const plan = loginPlan(k)
    let argv = plan.argv
    if (k === 'codex') {
      if (/^(geraet|gerät|device|code)$/i.test(how || '')) argv = plan.options[0].argv
      else if (/^browser$/i.test(how || '')) argv = plan.options[1].argv
      else if (plan.headless) {
        const ch = await input.pick({ title: 'Codex anmelden — hier ist kein Bildschirm/Browser erkannt', items: plan.options.map(o => ({ ...o, desc: o.desc + (o.value === 'device' ? ' (empfohlen)' : '') })) })
        if (!ch) return say(C.dim('  abgebrochen.'))
        argv = ch.argv
      }
    } else if (plan.headless) say(C.dim('  Kein Browser hier: Claude zeigt eine Adresse — auf Handy/PC öffnen und den Code hier einfügen.'))
    say(C.dim('  → ') + argv.join(' ') + C.dim('   (Anmeldung durch das Programm selbst — m3dusa sieht keine Zugangsdaten)'))
    const code = await runInherit(argv, a.loc)
    const now = await probeAuth(k, a.loc)
    st.auth[k] = now
    if (now === 'yes') say(C.ok('  ✓ ') + `${k} ist angemeldet.`)
    else if (now === 'no') say(C.warn('  ! ') + `${k} ist noch nicht angemeldet` + (code ? C.dim(` (Exit ${code})`) : '') + C.dim(k === 'codex' ? ' — ohne Browser: /codex login geraet' : ''))
    else say(C.dim(`  Anmeldestatus von ${k} unbekannt — /status prüft erneut.`))
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
    let a = null
    if (!fake) {
      a = await probeAgent(kind)
      if (a.state !== 'ok') return say(C.err('  ✗ ') + (kind === 'claude' ? 'Claude Code fehlt: ' : 'Codex fehlt: ') + INSTALL[kind] + (kind === 'claude' ? ', dann /claude login.' : ', dann /codex login.') + C.dim('  (m3dusa pruefen zeigt, wo gesucht wurde)'))
    }
    if (st.auth[kind] === 'no') say(C.warn('  ! ') + `${kind} ist nicht angemeldet — der Lauf scheitert vermutlich. ` + C.dim(`/${kind} login`))
    const resume = st.sessions[kind]
    const argv = agentArgv(kind, { model: st.model, resume, effort: st.effort })
    let cmd, args, opts = { cwd: st.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    if (fake) { cmd = process.execPath; args = [path.resolve(fake), ...argv] }
    else { const sp = spawnSpec(argv, a.loc); cmd = sp.cmd; args = sp.args; if (sp.shell) opts.shell = true } // Windows: claude.cmd/.ps1; Argumente sind geprüft
    // Eigene Prozessgruppe (nicht Windows): ein Abbruch erreicht so auch die Werkzeugprozesse des Agenten.
    if (process.platform !== 'win32') opts.detached = true

    const W = cols()
    say()
    say('  ' + C.acc('●') + ' ' + C.b(kind) + C.dim(' · ') + tildify(st.cwd) + (st.model ? C.dim(' · ' + st.model) : '') + (st.effort ? C.dim(' · Aufwand ' + st.effort) : '') + (resume ? C.dim('  ↺ Fortsetzung') : ''))
    const gut = C.vio('  │ ')
    const t0 = Date.now()
    let p
    try { p = spawn(cmd, args, opts) } catch (e) { return say(C.err('  ✗ ') + 'Start fehlgeschlagen: ' + e.message) }
    let aborted = false, lastOut = Date.now(), spinOn = false, spinI = 0, shown = 0, final, sawErr = false, initModel = null
    const usages = []
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
      if (r.usage) usages.push(r.usage)
      if (r.model) initModel = r.model
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
    st.runs++
    if (!shown && final) emit(final)
    const ms = Date.now() - t0
    const dur = fmtDur(ms)
    if (aborted) say(C.warn('  ■ abgebrochen') + C.dim(' · ' + dur))
    else if (code === 0 && !sawErr) say(C.ok('  ✓ fertig') + C.dim(' · ' + dur + (st.sessions[kind] ? '  · Kontext bleibt (/neu vergisst ihn)' : '')))
    else {
      say(C.err(`  ✗ ${code === 0 ? 'Fehler' : 'Exit ' + code}`) + C.dim(' · ' + dur))
      if (resume && !shown) { delete st.sessions[kind]; say(C.dim('  Fortsetzung hat nicht geklappt — der nächste Auftrag startet frisch.')) }
    }
    // Token + Vergleichspreis (Felder defensiv gelesen; fehlt alles, bleibt die Zeile weg)
    if (usages.length) {
      const fallbackModel = kind === 'claude' ? initModel || st.model : st.model || st.codexDefault
      const recs = runRecords(usages, { agent: kind, fallbackModel, runId: st.runs })
      st.usage.push(...recs)
      const u = usageSummary(recs)
      const abo = '  (Abo: nur Vergleichswert)'
      if (visibleWidth(`  ↯ ${u.tokens} · ${dur} · ${u.price}${abo}`) <= W - 1) say(C.dim(`  ↯ ${u.tokens} · ${dur} · `) + C.acc(u.price) + C.dim(abo))
      else { // schmal: Token in Zeile 1, Dauer + Preis in Zeile 2
        say(C.dim(clipPlain(`  ↯ ${u.tokens}`, W - 1)))
        say(segs([[`    ${dur} · `, 'dim'], [u.price, 'acc'], [abo, 'dim']], W - 1, !!level).s)
      }
      if (u.note) say(C.dim(clipPlain('    ' + u.note, W - 1)))
    } else if (!aborted && code === 0) say(C.dim(`  ↯ ${kind} hat keine Token gemeldet · ${dur}`))
    if (kind === 'codex' && code === 0 && !st.sessions.codex) say(C.dim('  (codex hat keine Sitzungskennung geliefert — der nächste Auftrag startet ohne Kontext)'))
    say()
  }
}

const indent = s => s.split('\n').map(l => '  ' + l).join('\n')
function promptStr(st, level) {
  const a = level ? fg(CY, level) + st.agent + RST : st.agent
  const extra = [st.model, st.effort].filter(Boolean).join('·')
  const x = extra ? ' ' + (level ? SGR.dim + extra + RST : extra) : ''
  const d = path.basename(st.cwd) || st.cwd
  const arrow = level ? '\x1b[1m' + fg(V, level) + '❯' + RST : '❯'
  return `${a}${x} ${level ? SGR.dim + d + RST : d} ${arrow} `
}

/** Auswahlliste im echten Terminal (Rohmodus, ↑/↓/Enter/Esc, Ziffern springen). Zeichnet an Ort und Stelle neu. */
function ttyPick(out, level, { title, items, initial = -1, hint }) {
  return new Promise(resolve => {
    const ok = i => !!items[i] && !items[i].header && !items[i].disabled
    const idx = items.map((_, i) => i).filter(ok)
    const render = sel => renderPicker({ title, items, sel, cols: Math.max(10, out.columns || 80), color: level, maxRows: Math.max(4, Math.min(24, (out.rows || 24) - 3)), ...(hint ? { hint } : {}) })
    if (!idx.length) { out.write(render(-1).join('\n') + '\n'); return resolve(null) }
    let sel = ok(initial) ? initial : idx[0], drawn = 0
    const draw = () => {
      const lines = render(sel)
      out.write(HIDE + (drawn ? `\x1b[${drawn}A` : '') + '\r\x1b[J' + lines.join('\r\n') + '\r\n')
      drawn = lines.length
    }
    const move = d => { const k = idx.indexOf(sel); sel = idx[(k + d + idx.length) % idx.length]; draw() }
    let fin = false
    const finish = v => {
      if (fin) return; fin = true
      process.stdin.off('keypress', onKey); out.off?.('resize', draw)
      try { process.stdin.setRawMode(false) } catch { /* egal */ }
      process.stdin.pause()
      out.write((drawn ? `\x1b[${drawn}A` : '') + '\r\x1b[J' + SHOW)
      resolve(v)
    }
    const onKey = (s, key = {}) => {
      if ((key.ctrl && (key.name === 'c' || key.name === 'd')) || key.name === 'escape' || s === 'q') return finish(null)
      if (key.name === 'up' || s === 'k' || (key.shift && key.name === 'tab')) return move(-1)
      if (key.name === 'down' || s === 'j' || key.name === 'tab') return move(1)
      if (key.name === 'return' || key.name === 'enter') return finish(items[sel])
      if (/^[1-9]$/.test(s || '') && idx[Number(s) - 1] !== undefined) { sel = idx[Number(s) - 1]; draw() }
    }
    readline.emitKeypressEvents(process.stdin)
    try { process.stdin.setRawMode(true) } catch { /* egal */ }
    process.stdin.on('keypress', onKey); process.stdin.resume(); out.on?.('resize', draw)
    draw()
  })
}

/**
 * Eingabe im echten Terminal: readline je Prompt (zwischen den Läufen gehört stdin dem Lauf).
 * Tasten laufen über einen Zwischenstrom: beginnt die Zeile mit „/“, erscheint darunter die Befehlsliste; solange sie offen
 * ist, bedienen ↑/↓/Tab/Enter/Esc die Liste statt readline (Verlauf). Neu gezeichnet wird in EINEM write (kein Flackern).
 */
function ttyInput(st, C, out) {
  const level = colorLevel(out)
  readline.emitKeypressEvents(process.stdin)
  return {
    pick: o => ttyPick(out, level, o),
    read: () => new Promise(resolve => {
      const proxy = new EventEmitter()
      Object.assign(proxy, {
        isTTY: true,
        setRawMode: m => { try { process.stdin.setRawMode(m) } catch { /* egal */ } return true },
        resume: () => { process.stdin.resume(); return proxy },
        pause: () => { process.stdin.pause(); return proxy },
      })
      const rl = readline.createInterface({ input: proxy, output: out, terminal: true, history: st.history, historySize: 500, removeHistoryDuplicates: true, completer: l => complete(st, l), tabSize: 2 })
      let buf = [], done = false, lastInt = 0
      const menu = { items: [], sel: 0, shown: 0, closedFor: null }
      const geo = () => {
        const cols = Math.max(10, out.columns || 80)
        const cur = rl.getCursorPos()
        const w = visibleWidth(rl.getPrompt()) + visibleWidth(rl.line || '')
        return { row: cur.rows, col: cur.cols, endRow: Math.floor(w / cols), endCol: w % cols }
      }
      const toEnd = g => (g.endRow > g.row ? `\x1b[${g.endRow - g.row}B` : '') + `\x1b[${g.endCol + 1}G`
      const back = (g, below) => { const up = below + g.endRow - g.row; return (up > 0 ? `\x1b[${up}A` : '') + `\x1b[${g.col + 1}G` }
      const hide = () => {
        if (menu.shown) { const g = geo(); out.write(HIDE + toEnd(g) + '\x1b[J' + back(g, 0) + SHOW) }
        menu.shown = 0; menu.items = []
      }
      const draw = () => {
        const g = geo()
        const lines = renderSuggestions(menu.items, menu.sel, out.columns || 80, level, Math.max(1, Math.min(8, (out.rows || 24) - 4)))
        out.write(HIDE + toEnd(g) + '\x1b[J\r\n' + lines.join('\r\n') + back(g, lines.length) + SHOW)
        menu.shown = lines.length
      }
      const update = () => {
        if (done) return
        const line = rl.line || ''
        if (menu.closedFor !== null && menu.closedFor !== line) menu.closedFor = null
        const items = !buf.length && menu.closedFor === null ? filterCommands(line) : []
        if (!items.length) return hide()
        const prev = menu.items[menu.sel]?.name
        menu.items = items
        const k = items.findIndex(x => x.name === prev)
        menu.sel = k >= 0 ? k : 0
        draw()
      }
      const setLine = t => { rl.write(null, { ctrl: true, name: 'e' }); rl.write(null, { ctrl: true, name: 'u' }); rl.write(t) }
      const onKey = (s, key = {}) => {
        if (done) return
        if (menu.items.length) {
          const n = menu.items.length
          if (key.name === 'up' || key.name === 'down') { menu.sel = (menu.sel + (key.name === 'up' ? -1 : 1) + n) % n; draw(); return }
          if (key.name === 'escape') { menu.closedFor = rl.line; hide(); return }
          if (key.name === 'tab' || key.name === 'return' || key.name === 'enter') {
            const it = menu.items[menu.sel]
            const typed = (rl.line || '').trim()
            hide()
            if (key.name !== 'tab' && typed === it.name) { proxy.emit('keypress', s, key); return }
            if (key.name === 'tab' || it.needs) { setLine(it.name + ' '); update(); return }
            setLine(it.name); proxy.emit('keypress', s, key); return
          }
        }
        proxy.emit('keypress', s, key)
        update()
      }
      const onResize = () => setImmediate(update)
      const prompt = () => { rl.setPrompt(buf.length ? C.dim('  … ') : promptStr(st, level)); rl.prompt() }
      const finish = v => {
        if (done) return
        hide(); done = true
        process.stdin.off('keypress', onKey); out.off('resize', onResize)
        st.history = rl.history || st.history; rl.close(); resolve(v)
      }
      rl.on('line', l => {
        if (l.endsWith('\\')) { buf.push(l.slice(0, -1)); prompt(); return }
        buf.push(l); finish(buf.join('\n'))
      })
      rl.on('SIGINT', () => {
        hide()
        if (rl.line || buf.length) { rl.write(null, { ctrl: true, name: 'e' }); rl.write(null, { ctrl: true, name: 'u' }); buf = []; out.write(C.dim('^C') + '\n'); prompt(); return }
        if (Date.now() - lastInt < 2500) { out.write('\n'); return finish('\0EXIT') }
        lastInt = Date.now()
        out.write('\n' + C.dim('  (Nochmal Strg+C zum Beenden — oder /ende)') + '\n'); prompt()
      })
      rl.on('close', () => { if (!done) { done = true; process.stdin.off('keypress', onKey); out.off('resize', onResize); out.write('\n'); resolve(null) } })
      process.stdin.on('keypress', onKey); out.on('resize', onResize)
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
    /** Auswahl ohne Rohmodus: nummerierte Liste, Nummer oder Name eingeben (leer = abbrechen). */
    async pick({ title, items }) {
      out.write(title + '\n')
      const map = []
      for (const it of items) {
        if (it.header) out.write('  ' + it.label + (it.note ? '  ' + it.note : '') + '\n')
        else if (it.disabled) out.write('      ' + it.label + '\n')
        else { map.push(it); out.write(`  ${String(map.length).padStart(2)}) ${it.label}${it.current ? ' ●' : ''}${it.desc ? '  — ' + it.desc : ''}\n`) }
      }
      if (!map.length) return null
      out.write('  Nummer oder Name (leer = abbrechen): ')
      const l = await next()
      out.write((l ?? '') + '\n')
      const t = (l || '').trim().toLowerCase()
      if (!t) return null
      const k = Number(t)
      const hit = Number.isInteger(k) && k >= 1 && k <= map.length ? map[k - 1] : map.find(x => String(x.value).toLowerCase() === t || String(x.label).toLowerCase() === t)
      if (!hit) out.write('  ? keine passende Wahl\n')
      return hit || null
    },
  }
}
