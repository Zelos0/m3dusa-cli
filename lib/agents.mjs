// Claude Code / Codex auf diesem Rechner starten (müssen hier installiert und angemeldet sein).
// Der Auftrag geht über stdin (taucht nicht in `ps` auf). Start über eine Login-Shell, damit PATH aus
// ~/.profile / nvm gilt.
import { spawnSync } from 'node:child_process'

export const AGENTS = ['claude', 'codex']

/** Sitzungskennungen sind UUIDs o. Ä. — alles andere wird nie als Argument weitergereicht. */
export const SESSION_RE = /^[\w-]{6,80}$/

/**
 * `resume`: Kennung einer früheren Sitzung (Terminal-Modus, Folgeauftrag mit Kontext).
 * Geprüft per `claude --help` (-r/--resume <id>) und `codex exec resume --help` ([SESSION_ID] [PROMPT], `-` = stdin).
 */
export function agentArgv(kind, { model, resume } = {}) {
  const rs = resume && SESSION_RE.test(resume) ? resume : null
  if (kind === 'claude') return ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...(model ? ['--model', model] : []), ...(rs ? ['--resume', rs] : [])]
  if (kind === 'codex') {
    if (rs) return ['codex', 'exec', 'resume', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...(model ? ['-m', model] : []), rs, '-']
    return ['codex', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...(model ? ['-m', model] : []), '-']
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
/** Login-Shell, die das Programm mit unveränderten Argumenten startet. */
export const viaLoginShell = argv => ['bash', '-lc', 'exec "$@"', 'm3dusa', ...argv]

let cache = { at: 0, v: null }
export function agentsAvailable() {
  if (cache.v && Date.now() - cache.at < 5 * 60e3) return cache.v
  const v = {}
  for (const a of AGENTS) {
    const r = spawnSync('bash', ['-lc', `command -v ${a}`], { encoding: 'utf8', timeout: 8000 })
    v[a] = r.status === 0 && !!r.stdout.trim()
  }
  cache = { at: Date.now(), v }
  return v
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
/**
 * Eine Zeile JSON-Ausgabe → { show?: Text für die Anzeige, final?: Schlusstext }. Unbekanntes wird ignoriert.
 */
export function readAgentLine(kind, line) {
  let o
  try { o = JSON.parse(line) } catch { return line.trim() ? { show: line } : {} }
  if (kind === 'claude') {
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      const parts = []
      for (const c of o.message.content) {
        if (c.type === 'text' && c.text) parts.push(c.text)
        else if (c.type === 'tool_use') parts.push(`→ ${c.name}: ${clip(JSON.stringify(c.input || {}), 200)}`)
      }
      return parts.length ? { show: parts.join('\n') } : {}
    }
    if (o.type === 'result') return { final: typeof o.result === 'string' ? o.result : '', error: o.is_error === true || o.subtype?.startsWith?.('error') }
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
  if (o.type === 'turn.failed' || o.type === 'error') return { show: 'Fehler: ' + (o.error?.message || o.message || 'unbekannt'), error: true }
  if (o.type === 'agent_message' && o.message) return { show: o.message, last: o.message }
  return {}
}
