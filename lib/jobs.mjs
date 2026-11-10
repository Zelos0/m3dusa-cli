// Ausführung geprüfter Aufträge: exec (Shell), read/write/list (Dateien), agent (Claude/Codex), info.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { HOME, logJob, VERSION, writeAtomic } from './core.mjs'
import { foldersOf, guestCfg, modeOf, resolveCwd, resolveTarget, sandboxStatus, wrapSandbox } from './policy.mjs'
import { sudoActive, sudoStatus } from './sudo.mjs'
import { agentArgv, agentsAvailable, AGENTS, readAgentLine, viaLoginShell } from './agents.mjs'

export class Rejected extends Error {}
const MAX_FILE = 8 * 1024 * 1024
const num = (x, def, min, max) => { const n = Number(x); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def }
const text = (x, max, what) => { if (typeof x !== 'string' || !x.trim()) throw new Rejected(what + ' fehlt.'); if (x.length > max) throw new Rejected(what + ' ist zu lang.'); return x }

// Gast OHNE sudo-Recht: der Prozess darf auch INNERHALB seines Befehls keine Rechte gewinnen. Die Prüfung von `a.sudo`
// allein reicht nicht — bei offenem sudo-Zeitfenster des Besitzers (NOPASSWD) liefe sonst `sudo -n …` im Gastbefehl als root.
// `setpriv --no-new-privs` sperrt setuid-Programme (sudo, su, pkexec) für den ganzen Prozessbaum. Läuft das Programm
// selbst als root, hilft das nicht → Gäste ohne sudo-Recht dürfen dort nichts ausführen.
let setprivOk
const hasSetpriv = () => (setprivOk ??= spawnSync('setpriv', ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0)
/** Läuft das Programm als root, hätte ein Gast ohne sudo-Recht über JEDE Auftragsart root-Rechte (auch Lesen/Schreiben
 *  geschieht dann als root) → alles außer `info` ablehnen. */
export function guestRootCheck(guest, o = {}) {
  if (!guest || guest.rights?.sudo === true || (o.platform ?? process.platform) !== 'linux') return
  if (o.root ?? process.getuid?.() === 0) throw new Rejected('Das Linux-Programm läuft als root — Gäste ohne sudo-Recht können hier nichts lesen, schreiben oder ausführen.')
}
export function guestConfine(argv, guest, o = {}) {
  const platform = o.platform ?? process.platform
  if (!guest || guest.rights?.sudo === true || platform !== 'linux') return argv
  guestRootCheck(guest, o)
  if (!(o.setpriv ?? hasSetpriv)()) throw new Rejected('Auf dem Linux-PC fehlt „setpriv“ (Paket util-linux) — ohne es lässt sich das sudo-Verbot für Gäste nicht durchsetzen.')
  return ['setpriv', '--no-new-privs', '--', ...argv]
}

let distro = ''
function osName() {
  if (!distro) { try { distro = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(fs.readFileSync('/etc/os-release', 'utf8'))?.[1] || '' } catch { distro = '' } }
  return distro || `${os.type()} ${os.release()}`
}
export function nodeInfo(cfg, running = 0) {
  const sb = sandboxStatus()
  return {
    version: VERSION, hostname: os.hostname(), os: osName(), arch: os.arch(), user: os.userInfo().username,
    mode: modeOf(cfg), folders: foldersOf(cfg), sandbox: { ok: sb.ok, why: sb.why || '' },
    sudo: sudoStatus(), agents: agentsAvailable(), running,
  }
}

export function createRunner({ cfgNow }) {
  const running = new Map()

  function spawnJob(jobId, argv, { cwd, stdin, timeoutSec, sudo, rep, onOut }) {
    return new Promise(resolve => {
      let child
      try {
        child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, TERM: 'dumb', M3DUSA_JOB: jobId } })
      } catch (e) { return resolve({ exit: null, error: e.message }) }
      let timedOut = false, cancelled = false, killer
      const kill = sig => {
        try { process.kill(-child.pid, sig) } catch { /* schon weg */ }
        if (sudo) spawnSync('sudo', ['-n', 'kill', '-' + sig, '--', '-' + child.pid], { stdio: 'ignore', timeout: 5000 })
      }
      const stop = () => { kill('SIGTERM'); killer = setTimeout(() => kill('SIGKILL'), 3000) }
      running.set(jobId, { cancel: () => { cancelled = true; stop() } })
      const timer = setTimeout(() => { timedOut = true; stop() }, timeoutSec * 1000)
      for (const [s, name] of [[child.stdout, 'out'], [child.stderr, 'err']]) {
        const dec = new StringDecoder('utf8')
        s.on('data', b => (onOut ? onOut(name, dec.write(b)) : rep.out(name, dec.write(b))))
        s.on('end', () => { const t = dec.end(); if (t) (onOut ? onOut(name, t) : rep.out(name, t)) })
      }
      if (stdin != null) { child.stdin.on('error', () => {}); child.stdin.end(stdin) }
      child.on('error', e => rep.out('err', 'Start fehlgeschlagen: ' + e.message + '\n'))
      child.on('close', (code, signal) => {
        clearTimeout(timer); clearTimeout(killer); running.delete(jobId)
        resolve({ exit: code, signal: signal || undefined, timedOut, cancelled })
      })
    })
  }

  async function run(p, rep) {
    let cfg = cfgNow()
    const a = p.args && typeof p.args === 'object' ? p.args : {}
    const t0 = Date.now()
    let mode = modeOf(cfg)
    let summary = ''
    const finish = (status, result = {}) => {
      logJob({ jobId: p.jobId, kind: p.kind, status, mode, ...(p.guest ? { gast: p.guest.name, zugang: p.guest.grantId } : {}), what: summary.slice(0, 300), ms: Date.now() - t0, ...(result.exit !== undefined ? { exit: result.exit } : {}), ...(result.error ? { error: String(result.error).slice(0, 300) } : {}) })
      rep.finish(status, { ...result, ms: Date.now() - t0 })
    }
    try {
      // Gast: Ordner seines Zugangs ∩ lokale Freigaben (policy.mjs › guestCfg); sudo nie ohne Recht im Zugang
      if (p.guest) { cfg = guestCfg(cfg, p.guest.rights); mode = modeOf(cfg) }
      if (p.kind === 'info') { summary = 'info'; return finish('done', { info: nodeInfo(cfg, running.size) }) }
      guestRootCheck(p.guest) // gilt für list/read/write genauso wie für exec/agent (Codex-Review 0.13.1)

      if (p.kind === 'list') {
        const dir = resolveTarget(cfg, a.path || (mode === 'ordner' ? foldersOf(cfg)[0] || '.' : HOME), { mustExist: true })
        summary = 'list ' + dir
        const depth = num(a.depth, 1, 1, 4), limit = num(a.limit, 500, 1, 5000), hidden = a.hidden === true
        const out = []
        const walk = (d, lvl) => {
          let es = []
          try { es = fs.readdirSync(d, { withFileTypes: true }) } catch (e) { out.push({ path: path.relative(dir, d) || '.', error: e.code }); return }
          es.sort((x, y) => x.name.localeCompare(y.name))
          for (const e of es) {
            if (out.length >= limit) return
            if (!hidden && e.name.startsWith('.')) continue
            const f = path.join(d, e.name)
            let st; try { st = fs.lstatSync(f) } catch { continue }
            const type = e.isSymbolicLink() ? 'l' : e.isDirectory() ? 'd' : 'f'
            out.push({ path: path.relative(dir, f), type, size: type === 'f' ? st.size : undefined, mtime: st.mtime.toISOString() })
            if (type === 'd' && lvl < depth) walk(f, lvl + 1)
          }
        }
        walk(dir, 1)
        return finish('done', { dir, entries: out, truncated: out.length >= limit })
      }

      if (p.kind === 'read') {
        const f = resolveTarget(cfg, a.path, { mustExist: true })
        summary = 'read ' + f
        const st = fs.statSync(f)
        if (!st.isFile()) throw new Rejected('Keine Datei: ' + f)
        const max = num(a.maxBytes, 1024 * 1024, 1, MAX_FILE)
        const fd = fs.openSync(f, 'r')
        const buf = Buffer.alloc(Math.min(max, st.size))
        try { fs.readSync(fd, buf, 0, buf.length, 0) } finally { fs.closeSync(fd) }
        const asText = a.encoding === 'utf8' || (a.encoding !== 'base64' && !buf.includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf))
        return finish('done', { path: f, size: st.size, truncated: st.size > buf.length, ...(asText ? { text: buf.toString('utf8') } : { b64: buf.toString('base64') }) })
      }

      if (p.kind === 'write') {
        const f = resolveTarget(cfg, a.path)
        summary = 'write ' + f
        const hasT = typeof a.text === 'string', hasB = typeof a.b64 === 'string'
        if (hasT === hasB) throw new Rejected('Inhalt fehlt (text oder b64).')
        const buf = hasT ? Buffer.from(a.text, 'utf8') : Buffer.from(a.b64, 'base64')
        if (buf.length > MAX_FILE) throw new Rejected('Datei zu groß (höchstens 8 MB).')
        const exists = fs.existsSync(f)
        if (exists && fs.statSync(f).isDirectory()) throw new Rejected('Ziel ist ein Ordner: ' + f)
        if (exists && !a.overwrite && !a.append) throw new Rejected('Datei existiert schon (overwrite: true zum Ersetzen): ' + f)
        if (!fs.existsSync(path.dirname(f))) {
          if (!a.mkdirs) throw new Rejected('Ordner fehlt (mkdirs: true zum Anlegen): ' + path.dirname(f))
          fs.mkdirSync(path.dirname(f), { recursive: true })
          resolveTarget(cfg, f) // nach dem Anlegen erneut prüfen (Verknüpfungen)
        }
        if (a.append) fs.appendFileSync(f, buf)
        else writeAtomic(f, buf, exists ? fs.statSync(f).mode & 0o777 : 0o644)
        return finish('done', { path: f, bytes: buf.length, created: !exists })
      }

      if (p.kind === 'exec') {
        const cmd = text(a.cmd, 100000, 'Befehl')
        const cwd = resolveCwd(cfg, a.cwd)
        summary = (a.sudo ? 'sudo ' : '') + cmd
        const timeoutSec = num(a.timeoutSec, 600, 1, 86400)
        let argv
        if (a.sudo) {
          if (p.guest && !p.guest.rights.sudo) throw new Rejected('Gäste dürfen sudo nicht nutzen.')
          if (!sudoActive()) throw new Rejected('sudo ist auf dem Linux-PC nicht freigegeben. Dort im Terminal: m3dusa sudo 1h  (oder 30m, heute, immer)')
          argv = process.getuid?.() === 0 ? ['bash', '-lc', cmd] : ['sudo', '-n', '--', 'bash', '-lc', cmd]
        } else {
          argv = guestConfine(['bash', '-lc', cmd], p.guest)
          if (mode === 'ordner') argv = (([b, r]) => [b, ...r])(wrapSandbox(cfg, argv, { cwd }))
        }
        rep.out('info', `$ ${cmd}\n(${cwd}${a.sudo ? ', sudo' : mode === 'ordner' ? ', Sandbox' : ''})\n`)
        const r = await spawnJob(p.jobId, argv, { cwd, stdin: typeof a.stdin === 'string' ? a.stdin : null, timeoutSec, sudo: !!a.sudo, rep })
        if (r.error) return finish('failed', { error: r.error })
        return finish(r.cancelled ? 'cancelled' : r.timedOut ? 'failed' : 'done', { exit: r.exit, signal: r.signal, ...(r.timedOut ? { error: `Zeitlimit ${timeoutSec} s überschritten — abgebrochen.` } : {}) })
      }

      if (p.kind === 'agent') {
        const kind = AGENTS.includes(a.agent) ? a.agent : null
        if (!kind) throw new Rejected('agent: claude oder codex.')
        const prompt = text(a.prompt, 200000, 'Auftrag')
        const cwd = resolveCwd(cfg, a.cwd)
        summary = `${kind}: ${prompt.slice(0, 200)}`
        if (!agentsAvailable()[kind]) throw new Rejected(kind === 'claude' ? 'Claude Code ist auf dem Linux-PC nicht installiert. Dort: npm i -g @anthropic-ai/claude-code und einmal `claude` zum Anmelden starten.' : 'Codex ist auf dem Linux-PC nicht installiert. Dort: npm i -g @openai/codex und `codex login`.')
        const model = typeof a.model === 'string' && /^[\w.:\-/[\]]{1,80}$/.test(a.model) ? a.model : undefined
        let argv = guestConfine(viaLoginShell(agentArgv(kind, { model })), p.guest)
        if (mode === 'ordner') argv = (([b, r]) => [b, ...r])(wrapSandbox(cfg, argv, { cwd, agent: true }))
        const timeoutSec = num(a.timeoutSec, 3600, 10, 86400)
        rep.out('info', `${kind === 'claude' ? 'Claude Code' : 'Codex'} startet in ${cwd}${mode === 'ordner' ? ' (Sandbox)' : ''} …\n`)
        let pending = '', final, last, failed = false
        const onOut = (stream, t) => {
          if (stream === 'err') return rep.out('err', t)
          pending += t
          let i
          while ((i = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, i); pending = pending.slice(i + 1)
            const r = readAgentLine(kind, line)
            if (r.show) rep.out('agent', r.show + '\n')
            if (r.final !== undefined) final = r.final
            if (r.last) last = r.last
            if (r.error) failed = true
          }
        }
        const r = await spawnJob(p.jobId, argv, { cwd, stdin: prompt, timeoutSec, rep, onOut })
        if (pending.trim()) onOut('out', '\n')
        if (r.error) return finish('failed', { error: r.error })
        const ok = r.exit === 0 && !failed
        return finish(r.cancelled ? 'cancelled' : ok ? 'done' : 'failed', { exit: r.exit, text: final ?? last ?? '', ...(r.timedOut ? { error: `Zeitlimit ${timeoutSec} s überschritten.` } : !ok && !r.cancelled ? { error: 'Agent meldet einen Fehler (Ausgabe prüfen).' } : {}) })
      }

      throw new Rejected('Unbekannte Auftragsart: ' + p.kind)
    } catch (e) {
      return finish(e instanceof Rejected || /freigegeben|Gesperrt|Außerhalb|Sandbox|Nicht gefunden|Kein Ordner|Pfad fehlt/.test(e.message) ? 'rejected' : 'failed', { error: e.message })
    }
  }

  return {
    run,
    count: () => running.size,
    cancel(jobId) { const r = running.get(jobId); if (!r) return false; r.cancel(); return true },
    cancelAll() { for (const r of running.values()) r.cancel() },
  }
}
