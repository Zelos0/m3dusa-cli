// Claude Code / Codex auf diesem Rechner finden und starten (müssen hier installiert und angemeldet sein).
// Der Auftrag geht über stdin (taucht nicht in `ps` auf). Start über eine Login-Shell (PATH aus ~/.profile / nvm),
// aber mit dem GEFUNDENEN absoluten Pfad — auf Kali (zsh) steht codex oft nur in ~/.zshrc im PATH.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const AGENTS = ['claude', 'codex']
export const INSTALL = { claude: 'npm i -g @anthropic-ai/claude-code', codex: 'npm i -g @openai/codex' }
/** Sitzungskennungen sind UUIDs o. Ä. — alles andere wird nie als Argument weitergereicht. */
export const SESSION_RE = /^[\w-]{6,80}$/
export const MODEL_RE = /^[\w.:/\-[\]]{1,80}$/
export const EFFORT_RE = /^[a-z][a-z-]{1,15}$/
/** Laut `claude --help`: --effort <level> (low, medium, high, xhigh, max). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/** Rückfall, wenn `codex app-server` › model/list keine Stufen liefert (-c model_reasoning_effort=…). */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh']
/** Aliasse, die `claude --model` annimmt. */
export const CLAUDE_MODELS = [
  { value: 'fable', desc: 'größtes Modell' }, { value: 'opus', desc: 'stark, ausgewogen' },
  { value: 'sonnet', desc: 'schnell, günstiger' }, { value: 'haiku', desc: 'am schnellsten' },
]

/**
 * `resume`: Kennung einer früheren Sitzung (Terminal-Modus, Folgeauftrag mit Kontext).
 * Geprüft per `claude --help` (-r/--resume <id>, --effort <level>) und `codex exec [resume] --help` (-m, -c key=value; `-` = stdin).
 */
export function agentArgv(kind, { model, resume, effort } = {}) {
  const rs = resume && SESSION_RE.test(resume) ? resume : null
  const m = model && MODEL_RE.test(model) ? model : null
  const ef = effort && EFFORT_RE.test(effort) ? effort : null
  if (kind === 'claude') return ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...(m ? ['--model', m] : []), ...(ef ? ['--effort', ef] : []), ...(rs ? ['--resume', rs] : [])]
  if (kind === 'codex') {
    const opts = [...(m ? ['-m', m] : []), ...(ef ? ['-c', `model_reasoning_effort=${ef}`] : [])]
    if (rs) return ['codex', 'exec', 'resume', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...opts, rs, '-']
    return ['codex', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...opts, '-']
  }
  throw new Error('Agent: claude oder codex')
}

/** Sitzungskennung aus einer JSON-Zeile (claude: session_id, codex: thread.started → thread_id), sonst undefined. */
export function sessionOf(kind, line) {
  if (!line || line[0] !== '{') return undefined
  let o
  try { o = JSON.parse(line) } catch { return undefined }
  const id = kind === 'codex' ? (o.type === 'thread.started' ? o.thread_id : o.session_id) : o.session_id
  return typeof id === 'string' && SESSION_RE.test(id) ? id : undefined
}

/**
 * Login-Shell, die das Programm mit unveränderten Argumenten startet. Mit `dir` (Ordner des gefundenen Programms)
 * steht dieser Ordner vorn im PATH — /etc/profile setzt PATH auf Debian/Kali neu, und npm-Starter brauchen `node`
 * (nvm: liegt im selben Ordner). Das eigene Node von m3dusa hängt als letzter Rückfall hinten an.
 */
export function viaLoginShell(argv, dir) {
  if (!dir) return ['bash', '-lc', 'exec "$@"', 'm3dusa', ...argv]
  return ['bash', '-lc', 'export PATH="$1:$PATH:$2"; shift 2; exec "$@"', 'm3dusa', dir, path.dirname(process.execPath), ...argv]
}
/** argv aus agentArgv (o. Ä.) mit dem gefundenen absoluten Pfad starten. */
export function launchArgv(argv, loc) {
  if (!loc?.path) return viaLoginShell(argv)
  return viaLoginShell([loc.path, ...argv.slice(1)], path.dirname(loc.path))
}

/** { cmd, args, shell } zum Starten — unter Windows (nur Entwicklung/Tests) über die Shell (claude.cmd/.ps1). */
export function spawnSpec(argv, loc) {
  if (process.platform === 'win32') return { cmd: argv[0], args: argv.slice(1), shell: true }
  const a = launchArgv(argv, loc)
  return { cmd: a[0], args: a.slice(1), shell: false }
}

// ─── Programm finden ──────────────────────────────────────────────────────────────────────────
const isWin = () => process.platform === 'win32'
function execFile(f) {
  try { if (!fs.statSync(f).isFile()) return false; if (!isWin()) fs.accessSync(f, fs.constants.X_OK); return true } catch { return false }
}
function findIn(dirs, name, env = process.env) {
  const exts = isWin() ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(e => e.toLowerCase()).filter(Boolean)] : ['']
  for (const d of dirs) {
    if (!d) continue
    for (const e of exts) { const f = path.join(d, name + e); if (execFile(f)) return f }
  }
  return null
}
const verKey = v => v.replace(/^v/, '').split('.').map(n => Number.parseInt(n, 10) || 0)
const byVersionDesc = (a, b) => { const x = verKey(a), y = verKey(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] || 0) - (x[i] || 0); return 0 }
const subdirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(byVersionDesc) } catch { return [] } }

/**
 * Übliche Installationsordner (Reihenfolge = Suchreihenfolge). `M3DUSA_AGENT_SEARCH_DIRS` (durch path.delimiter getrennt)
 * kommt zuerst, `M3DUSA_AGENT_HOME` ersetzt den Benutzerordner (beides für Tests).
 */
export function knownDirs(env = process.env, home = env.M3DUSA_AGENT_HOME || os.homedir()) {
  const h = (...p) => path.join(home, ...p)
  const nvmDir = env.NVM_DIR && path.isAbsolute(env.NVM_DIR) ? env.NVM_DIR : h('.nvm')
  return [
    ...(env.M3DUSA_AGENT_SEARCH_DIRS || '').split(path.delimiter).filter(Boolean),
    h('.npm-global', 'bin'), h('.local', 'bin'),
    ...subdirs(path.join(nvmDir, 'versions', 'node')).map(v => path.join(nvmDir, 'versions', 'node', v, 'bin')),
    ...subdirs(h('.local', 'share', 'fnm', 'node-versions')).map(v => h('.local', 'share', 'fnm', 'node-versions', v, 'installation', 'bin')),
    h('.volta', 'bin'), h('.bun', 'bin'), h('.cargo', 'bin'), h('.local', 'share', 'pnpm'), h('.yarn', 'bin'), h('.npm-packages', 'bin'),
    '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/snap/bin',
  ]
}
const tilde = (p, home) => (home && (p === home || p.startsWith(home + path.sep)) ? '~' + p.slice(home.length) : p)
const MARK_A = '__M3DUSA_A__', MARK_E = '__M3DUSA_E__'
/** Ausgabe einer interaktiven Login-Shell: nur der Teil zwischen den Markern zählt (Begrüßungen, Warnungen u. Ä. fallen weg). */
export function parseMarked(out) {
  const m = String(out || '').match(new RegExp(MARK_A + '([^\\n]*?)' + MARK_E))
  if (!m) return null
  const [cmd, prefix] = m[1].split('|')
  return { cmd: (cmd || '').trim(), prefix: (prefix || '').trim() }
}
/** Erste Zeile, die ein absoluter, ausführbarer Pfad ist (command -v liefert bei Aliasen/Funktionen anderes). */
const absExec = s => String(s || '').split(/\r?\n/).map(x => x.trim()).find(x => path.isAbsolute(x) && execFile(x)) || null

/**
 * Suchschritte als Generator: gibt Befehle aus ({cmd,args,timeout}), bekommt {code,stdout} zurück; Ende = Ergebnis
 * { path|null, via, searched[] }. So teilen sich die synchrone (Dienst, pruefen) und die asynchrone Fassung (Terminal-Modus)
 * dieselbe Logik.
 */
function* locateSteps(kind, { env = process.env, home = env.M3DUSA_AGENT_HOME || os.homedir(), shell = env.M3DUSA_AGENT_NO_SHELL !== '1' } = {}) {
  const searched = []
  const hit = (p, via) => ({ path: p, via, searched })
  searched.push('PATH dieses Programms')
  const p1 = findIn((env.PATH || '').split(path.delimiter), kind, env)
  if (p1) return hit(p1, 'PATH')
  let npmPrefix = ''
  if (shell && !isWin()) {
    searched.push('bash -lc')
    const r2 = yield { cmd: 'bash', args: ['-lc', `command -v ${kind}`], timeout: 10000 }
    const p2 = absExec(r2.stdout)
    if (p2) return hit(p2, 'bash -lc')
    // Login-Shell des Nutzers interaktiv (liest ~/.zshrc / ~/.bashrc — dort setzen nvm & Co. den PATH)
    const sh = env.SHELL && path.isAbsolute(env.SHELL) && execFile(env.SHELL) ? env.SHELL : '/bin/bash'
    searched.push(`${path.basename(sh)} -lic`)
    const r3 = yield { cmd: sh, args: ['-lic', `printf '\\n${MARK_A}%s|%s${MARK_E}\\n' "$(command -v ${kind} 2>/dev/null)" "$(npm config get prefix 2>/dev/null)"`], timeout: 12000 }
    const m = parseMarked(r3.stdout)
    const p3 = m && absExec(m.cmd)
    if (p3) return hit(p3, `${path.basename(sh)} -lic`)
    npmPrefix = m?.prefix || ''
  }
  for (const d of knownDirs(env, home)) {
    searched.push(tilde(d, home))
    const p = findIn([d], kind, env)
    if (p) return hit(p, 'Suchordner')
  }
  if (shell && !npmPrefix && !isWin() && findIn((env.PATH || '').split(path.delimiter), 'npm', env)) {
    const r5 = yield { cmd: 'npm', args: ['config', 'get', 'prefix'], timeout: 10000 }
    npmPrefix = String(r5.stdout || '').trim().split(/\r?\n/).pop() || ''
  }
  if (npmPrefix && path.isAbsolute(npmPrefix)) {
    const d = path.join(npmPrefix, 'bin')
    searched.push(tilde(d, home) + ' (npm prefix)')
    const p = findIn([d], kind, env)
    if (p) return hit(p, 'npm prefix')
  }
  return { path: null, via: '', searched }
}
const stepEnv = () => ({ ...process.env, TERM: 'dumb' })
function runStepSync(s) {
  const r = spawnSync(s.cmd, s.args, { encoding: 'utf8', timeout: s.timeout, stdio: ['ignore', 'pipe', 'ignore'], env: stepEnv(), killSignal: 'SIGKILL' })
  return { code: r.status, stdout: r.stdout || '' }
}
function runStep(s) {
  return new Promise(res => {
    let p, out = '', done = false
    const fin = code => { if (done) return; done = true; clearTimeout(t); res({ code, stdout: out }) }
    // Eigene Sitzung (setsid): eine interaktive Shell greift so nie nach dem Terminal des Terminal-Modus
    const t = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL') } catch { try { p?.kill('SIGKILL') } catch { /* weg */ } } fin(null) }, s.timeout)
    try { p = spawn(s.cmd, s.args, { stdio: ['ignore', 'pipe', 'ignore'], env: stepEnv(), detached: !isWin() }) } catch { return fin(null) }
    p.stdout.on('data', b => { out += b })
    p.on('error', () => fin(null))
    p.on('close', c => fin(c))
  })
}
const cache = new Map()
const fresh = c => c && Date.now() - c.at < (c.v.path ? 5 * 60e3 : 20e3) // Gefundenes 5 min merken, Fehlendes nur 20 s
/** Synchron (Dienst, `m3dusa pruefen`). o: { env, home, shell, fresh } */
export function locateAgentSync(kind, o = {}) {
  const c = cache.get(kind)
  if (!o.fresh && !o.env && c && !c.p && fresh(c)) return c.v
  const g = locateSteps(kind, o)
  let r = g.next()
  while (!r.done) r = g.next(runStepSync(r.value))
  if (!o.env) cache.set(kind, { at: Date.now(), v: r.value })
  return r.value
}
/** Asynchron (Terminal-Modus: die Animation läuft weiter). */
export async function locateAgent(kind, o = {}) {
  const c = cache.get(kind)
  if (!o.fresh && !o.env && c && fresh(c)) return c.p || c.v
  const p = (async () => {
    const g = locateSteps(kind, o)
    let r = g.next()
    while (!r.done) r = g.next(await runStep(r.value))
    return r.value
  })()
  if (!o.env) cache.set(kind, { at: Date.now(), p, v: { path: null, searched: [] } })
  const v = await p
  if (!o.env) cache.set(kind, { at: Date.now(), v })
  return v
}
/** { claude: bool, codex: bool } — Form wie bisher (geht als nodeInfo.agents an den Haupt-PC). */
export function agentsAvailable() {
  const v = {}
  for (const a of AGENTS) v[a] = !!locateAgentSync(a).path
  return v
}

// ─── Anmeldung ────────────────────────────────────────────────────────────────────────────────
/** Nur die Programme selbst fragen — nie deren Anmeldedateien lesen. */
export const authArgv = kind => (kind === 'claude' ? ['claude', 'auth', 'status', '--json'] : ['codex', 'login', 'status'])
/** → 'yes' | 'no' | 'unknown'. Lieber „unbekannt“ als eine falsche Aussage. */
export function parseAuth(kind, code, out) {
  const t = String(out || '')
  if (kind === 'claude') {
    const m = t.match(/\{[\s\S]*\}/)
    if (m) { try { const j = JSON.parse(m[0]); if (j.loggedIn === true) return 'yes'; if (j.loggedIn === false) return 'no' } catch { /* kein JSON */ } }
    if (/not logged in|not authenticated|please (log|sign) in/i.test(t)) return 'no'
    return 'unknown'
  }
  if (/not logged in|logged out|no credentials/i.test(t)) return 'no'
  if (code === 0 && /logged in/i.test(t)) return 'yes'
  return 'unknown'
}
/** Kein Bildschirm/Browser hier? (SSH-Sitzung oder Linux ohne DISPLAY/WAYLAND_DISPLAY) */
export const isHeadless = (env = process.env, platform = process.platform) => !!(env.SSH_CONNECTION || env.SSH_TTY) || (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)
/**
 * Anmeldebefehl (läuft im selben Terminal, stdio geerbt). Codex kennt `codex login --device-auth` (Gerätecode, ohne
 * Browser an diesem Rechner) — ohne Bildschirm wird das zuerst angeboten.
 */
export function loginPlan(kind, { env = process.env, platform = process.platform, device } = {}) {
  const headless = isHeadless(env, platform)
  if (kind === 'claude') return { argv: ['claude', 'auth', 'login'], headless, options: [] }
  const dev = device ?? headless
  return {
    argv: dev ? ['codex', 'login', '--device-auth'] : ['codex', 'login'], headless,
    options: [{ value: 'device', label: 'Gerätecode', argv: ['codex', 'login', '--device-auth'], desc: 'ohne Browser hier: Code auf Handy/PC eingeben' }, { value: 'browser', label: 'Browser', argv: ['codex', 'login'], desc: 'öffnet die Anmeldeseite an diesem Rechner' }],
  }
}

// ─── Codex-Modelle (codex app-server › model/list) ────────────────────────────────────────────
/** Antwort von model/list → [{ value, label, desc, efforts[], isDefault, defaultEffort }] (versteckte entfallen). */
export function parseModelList(result) {
  const data = Array.isArray(result?.data) ? result.data : Array.isArray(result?.models) ? result.models : []
  const out = []
  for (const m of data) {
    if (!m || typeof m !== 'object' || m.hidden) continue
    const value = String(m.model || m.id || '')
    if (!MODEL_RE.test(value)) continue
    const efforts = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []).map(e => (typeof e === 'string' ? e : e?.reasoningEffort)).filter(e => typeof e === 'string' && EFFORT_RE.test(e))
    out.push({ value, label: String(m.displayName || value), desc: typeof m.description === 'string' ? m.description.replace(/\s+/g, ' ').slice(0, 120) : '', efforts, isDefault: m.isDefault === true, defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : undefined })
  }
  return out
}
/**
 * Modellliste von Codex über JSON-RPC (wie src/server/providers/codex.ts: initialize → initialized → model/list).
 * Kein Modellaufruf. o: { loc (gefundenes Programm), argv (nur Tests: Ersatzprogramm), timeoutMs }
 */
export function codexModels({ loc, argv, timeoutMs = 15000, version = '' } = {}) {
  return new Promise((resolve, reject) => {
    const a = argv || (process.platform === 'win32' ? null : launchArgv(['codex', 'app-server'], loc))
    let p
    try {
      p = a ? spawn(a[0], a.slice(1), { stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' }) : spawn('codex app-server', { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (e) { return reject(e) }
    let buf = '', done = false
    const end = (err, v) => {
      if (done) return; done = true; clearTimeout(t)
      try { p.stdin.end() } catch { /* zu */ }
      try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill() } catch { /* weg */ } }
      err ? reject(err) : resolve(v)
    }
    const t = setTimeout(() => end(new Error(`Codex antwortet nicht (${Math.round(timeoutMs / 1000)} s)`)), timeoutMs)
    const send = o => { try { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n') } catch { /* zu */ } }
    p.on('error', e => end(e))
    p.on('close', c => end(new Error('codex app-server beendet (Code ' + c + ')')))
    p.stdin.on('error', () => { /* früh geschlossen */ })
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        let m; try { m = JSON.parse(line) } catch { continue }
        if (m.method && m.id != null) { send({ id: m.id, error: { code: -32601, message: 'nicht unterstützt' } }); continue } // Rückfragen ablehnen
        if (m.id === 1) {
          if (m.error) return end(new Error(m.error.message || 'initialize abgelehnt'))
          send({ method: 'initialized' }); send({ id: 2, method: 'model/list', params: {} })
        } else if (m.id === 2) {
          if (m.error) return end(new Error(m.error.message || 'model/list abgelehnt'))
          return end(null, parseModelList(m.result))
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'm3dusa-cli', title: 'm3dusa', version } } })
  })
}

// ─── Ausgabe der Agenten ──────────────────────────────────────────────────────────────────────
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
const cnt = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0)
const usd = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
/**
 * Token aus dem Claude-`result`-Ereignis. modelUsage (je Modell) hat Vorrang; fehlt es, gilt usage (Modell unbekannt).
 * Haltedauer des Cache-Schreibens (usage.cache_creation.ephemeral_5m/1h_input_tokens) nur, wenn sie eindeutig zu einem Modell passt.
 */
export function claudeUsage(o) {
  const u = o.usage && typeof o.usage === 'object' ? o.usage : {}
  const items = []
  if (o.modelUsage && typeof o.modelUsage === 'object') {
    for (const [model, x] of Object.entries(o.modelUsage)) {
      if (!x || typeof x !== 'object') continue
      items.push({ model, inputTokens: cnt(x.inputTokens ?? x.input_tokens), outputTokens: cnt(x.outputTokens ?? x.output_tokens), cacheReadTokens: cnt(x.cacheReadInputTokens ?? x.cache_read_input_tokens), cacheWriteTokens: cnt(x.cacheCreationInputTokens ?? x.cache_creation_input_tokens), ...(usd(x.costUSD) !== undefined ? { costUsd: usd(x.costUSD) } : {}) })
    }
  }
  if (!items.length && ['input_tokens', 'output_tokens'].some(k => Number.isSafeInteger(u[k]))) {
    items.push({ model: null, inputTokens: cnt(u.input_tokens), outputTokens: cnt(u.output_tokens), cacheReadTokens: cnt(u.cache_read_input_tokens), cacheWriteTokens: cnt(u.cache_creation_input_tokens) })
  }
  if (!items.length) return undefined
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null
  if (cc) {
    const ttl = {}
    for (const [k, v] of Object.entries(cc)) { const m = /^ephemeral_(\w+?)_input_tokens$/.exec(k); if (m && Number.isSafeInteger(v) && v >= 0) ttl[m[1]] = v }
    const sum = Object.values(ttl).reduce((s, n) => s + n, 0)
    const target = items.length === 1 ? items[0] : items.filter(x => x.cacheWriteTokens === sum && sum > 0).length === 1 ? items.find(x => x.cacheWriteTokens === sum) : null
    if (target && sum > 0 && target.cacheWriteTokens === sum) target.cacheWriteByTtl = ttl
  }
  return { items, ...(usd(o.total_cost_usd) !== undefined ? { costUsd: usd(o.total_cost_usd) } : {}), ...(cnt(o.duration_ms) ? { durationMs: cnt(o.duration_ms) } : {}) }
}
/** Token aus Codex `turn.completed` › usage. input_tokens enthält den Cache-Anteil → abziehen (wie codex.ts). Cache-Schreiben meldet Codex hier nicht. */
export function codexUsage(o) {
  const u = o.usage && typeof o.usage === 'object' ? o.usage : null
  if (!u || !['input_tokens', 'output_tokens'].some(k => Number.isSafeInteger(u[k]))) return undefined
  const cached = cnt(u.cached_input_tokens)
  const cw = Number.isSafeInteger(u.cache_write_input_tokens) && u.cache_write_input_tokens >= 0 ? u.cache_write_input_tokens : null
  return { items: [{ model: null, inputTokens: Math.max(0, cnt(u.input_tokens) - cached), outputTokens: cnt(u.output_tokens), cacheReadTokens: cached, cacheWriteTokens: cw }] }
}

/**
 * Eine Zeile JSON-Ausgabe → { show?: Text für die Anzeige, final?: Schlusstext, usage?, model? }. Unbekanntes wird ignoriert.
 */
export function readAgentLine(kind, line) {
  let o
  try { o = JSON.parse(line) } catch { return line.trim() ? { show: line } : {} }
  if (!o || typeof o !== 'object') return {}
  if (kind === 'claude') {
    if (o.type === 'system' && o.subtype === 'init' && typeof o.model === 'string') return { model: o.model }
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      const parts = []
      for (const c of o.message.content) {
        if (c.type === 'text' && c.text) parts.push(c.text)
        else if (c.type === 'tool_use') parts.push(`→ ${c.name}: ${clip(JSON.stringify(c.input || {}), 200)}`)
      }
      return parts.length ? { show: parts.join('\n') } : {}
    }
    if (o.type === 'result') {
      const usage = claudeUsage(o)
      return { final: typeof o.result === 'string' ? o.result : '', error: o.is_error === true || o.subtype?.startsWith?.('error'), ...(usage ? { usage } : {}) }
    }
    return {}
  }
  // codex exec --json
  const it = o.item || o.msg
  if (o.type === 'item.completed' && it) {
    if (it.type === 'agent_message' && it.text) return { show: it.text, last: it.text }
    if (it.type === 'command_execution') return { show: `$ ${clip(String(it.command || ''), 300)}${it.exit_code != null ? `  (Exit ${it.exit_code})` : ''}` }
    if (it.type === 'file_change' && Array.isArray(it.changes)) return { show: it.changes.map(c => `✎ ${c.kind || ''} ${c.path || ''}`).join('\n') }
    return {}
  }
  if (o.type === 'turn.completed') { const usage = codexUsage(o); return usage ? { usage } : {} }
  if (o.type === 'turn.failed' || o.type === 'error') return { show: 'Fehler: ' + (o.error?.message || o.message || 'unbekannt'), error: true }
  if (o.type === 'agent_message' && o.message) return { show: o.message, last: o.message }
  return {}
}
