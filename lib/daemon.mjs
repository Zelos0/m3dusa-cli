// Hintergrunddienst: fragt den M3DUSA-Server nach Aufträgen (lange Abfrage, nur ausgehende Verbindung),
// prüft jede Unterschrift selbst und meldet Ausgabe/Ergebnis zurück. Konfiguration wird bei jeder Runde
// neu gelesen (m3dusa ordner/modus wirken sofort, ohne Neustart).
import { acceptRevoke, clock, hubCall, isPaired, isRevoked, openEnvelope, parseGrant, readCfg, rememberGuest, seenOnce } from './core.mjs'
import { createRunner, nodeInfo } from './jobs.mjs'

const MAX_PARALLEL = 4
const MAX_OUT = 4 * 1024 * 1024
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString(), ...a)

// Wie lange ein Bündel wiederholt wird, wenn der Server nicht antwortet (Update, Netz weg). M3DUSA_REPORT_* nur für Tests.
const KEEP_OUT_MS = Number(process.env.M3DUSA_REPORT_OUT_MS) || 10 * 60e3
const KEEP_FINAL_MS = Number(process.env.M3DUSA_REPORT_FINAL_MS) || 30 * 60e3
const RETRY_STEP_MS = Number(process.env.M3DUSA_REPORT_STEP_MS) || 1000

/**
 * Sammelt Ausgabe und schickt sie gebündelt (alle 300 ms) an den Server.
 * 1.1.0: Es ist immer nur EIN Bündel unterwegs. Antwortet der Server nicht, wird genau dieses Bündel wiederholt
 * (mit wachsender Pause), während neue Ausgabe im Speicher weiter gesammelt wird — nichts geht verloren und nichts
 * kommt doppelt an (jedes Bündel trägt eine laufende Nummer, die der Server ab 1.3.0 nur einmal annimmt).
 */
function reporter(cfgNow, jid) {
  const url = `/api/v1/node/jobs/${encodeURIComponent(jid)}/events`
  let buf = [], bytes = 0, cut = false, timer, final = null, seq = 0, busy = false, closed = false, lost = false
  let settle
  const settled = new Promise(r => { settle = r })

  /** true = angekommen, false = aufgegeben, 'refused' = vom Server abgelehnt (nicht wiederholen). */
  async function deliver(body, keepMs) {
    const until = Date.now() + keepMs
    for (let i = 0; ; i++) {
      try { await hubCall(cfgNow(), 'POST', url, body, { timeoutMs: 60000 }); return true } catch (e) {
        if (e.status && e.status < 500 && e.status !== 429 && e.status !== 408) return e
        const pause = Math.min(15000, RETRY_STEP_MS * 2 ** Math.min(i, 4))
        if (Date.now() + pause > until) return false
        if (i === 0) log('Server nicht erreichbar — Rückmeldung zu', jid, 'wird wiederholt.')
        await sleep(pause)
      }
    }
  }
  async function pump() {
    if (busy || closed) return
    busy = true
    try {
      while (buf.length || final) {
        clearTimeout(timer); timer = undefined
        const events = buf; buf = []
        const fin = final
        if (lost) { events.unshift({ s: 'info', d: '\n[Ein Teil der Ausgabe ging verloren — Server war zu lange nicht erreichbar]\n' }); lost = false }
        const r = await deliver({ seq: ++seq, events, ...(fin || {}) }, fin ? KEEP_FINAL_MS : KEEP_OUT_MS)
        if (fin) {
          // Abschluss nie verlieren: zu großes/abgelehntes Ergebnis → knapper Abschluss mit Grund
          if (r !== true && r !== false) await deliver({ seq: ++seq, events: [], fallback: true, status: fin.status === 'done' ? 'failed' : fin.status, result: { error: `Ergebnis konnte nicht übertragen werden (Server: ${r.message}).` } }, 60e3)
          if (r === false) log('Abschluss von', jid, 'konnte nicht übermittelt werden (Server zu lange nicht erreichbar).')
          closed = true; buf = []; settle()
          return
        }
        if (r !== true) lost = true
      }
    } finally { busy = false }
  }
  return {
    out(stream, t) {
      if (!t || closed || final) return
      if (bytes + t.length > MAX_OUT) { if (!cut) { cut = true; buf.push({ s: 'info', d: '\n[Ausgabe gekürzt — mehr als 4 MB]\n' }) } return }
      bytes += t.length
      const last = buf.at(-1)
      if (last && last.s === stream && last.d.length < 64 * 1024) last.d += t; else buf.push({ s: stream, d: t })
      if (!timer && !busy) timer = setTimeout(pump, 300)
    },
    finish(status, result) { if (!final && !closed) { final = { status, result }; void pump() } return settled },
    running() { return hubCall(cfgNow(), 'POST', url, { events: [], status: 'running' }).catch(() => {}) },
  }
}

export async function runDaemon({ once = false } = {}) {
  const cfgNow = () => readCfg()
  const runner = createRunner({ cfgNow })
  const queue = []
  const guestJobs = new Map() // jobId → {grantId, expiresAt} für wartende/laufende Gast-Aufträge
  let active = 0, info = null, infoAt = 0, backoff = 1000, lastState = ''
  const pump = () => {
    while (active < MAX_PARALLEL && queue.length) {
      const { p, rep } = queue.shift()
      active++
      void rep.running()
      runner.run(p, rep).finally(() => { active--; guestJobs.delete(p.jobId); pump() })
    }
  }
  /** Gast-Aufträge beenden, sobald ihr Zugang abgelaufen oder gesperrt ist (auch lokal per `m3dusa gaeste sperren`). */
  const sweep = () => {
    const t = clock()
    for (const [jobId, g] of [...guestJobs]) {
      if (g.expiresAt > t && !isRevoked(g.grantId)) continue
      const why = isRevoked(g.grantId) ? 'Zugang widerrufen.' : 'Zugang abgelaufen.'
      const i = queue.findIndex(q => q.p.jobId === jobId)
      if (i >= 0) { const [q] = queue.splice(i, 1); guestJobs.delete(jobId); void q.rep.finish('cancelled', { error: why }) }
      else if (runner.cancel(jobId)) log('Gast-Auftrag', jobId, 'beendet:', why)
      else guestJobs.delete(jobId)
    }
  }
  if (!once) setInterval(sweep, 5000).unref()
  const stopAll = () => { runner.cancelAll(); setTimeout(() => process.exit(0), 3500).unref() }
  process.on('SIGTERM', stopAll); process.on('SIGINT', stopAll)
  log('m3dusa-Dienst gestartet')

  for (;;) {
    const cfg = cfgNow()
    if (!isPaired(cfg)) {
      if (lastState !== 'unpaired') { log('Nicht gekoppelt — warte auf `m3dusa login <Code>`.'); lastState = 'unpaired' }
      if (once) return
      await sleep(5000); continue
    }
    if (!info || Date.now() - infoAt > 60e3) { info = nodeInfo(cfg, active); infoAt = Date.now() }
    let r
    try {
      r = await hubCall(cfg, 'POST', '/api/v1/node/poll', { info: { ...info, running: active }, wait: once ? 0 : 25 }, { timeoutMs: 45000 })
      if (lastState !== 'online') { log(`Verbunden mit ${cfg.server} (Gerät ${cfg.name || cfg.nodeId}).`); lastState = 'online' }
      backoff = 1000
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404) {
        if (lastState !== 'revoked') { log('Server kennt dieses Gerät nicht mehr (entfernt?). Neu koppeln: m3dusa login <Code>'); lastState = 'revoked' }
        if (once) return
        await sleep(60e3); continue
      }
      if (lastState !== 'offline') { log('Server nicht erreichbar:', e.message); lastState = 'offline' }
      if (once) return
      await sleep(backoff); backoff = Math.min(60e3, backoff * 2); continue
    }
    // 1.2.0: Sperren (nur mit Unterschrift des Haupt-PCs) und gültige Zugänge (zur Anzeige) vom Server
    for (const x of r.revokes || []) { try { acceptRevoke(x, cfg) } catch (e) { log('Sperre nicht gespeichert:', e.message) } }
    for (const x of r.grants || []) { try { rememberGuest(parseGrant(x.payload, x.sig, cfg)) } catch { /* ungültig → ignorieren */ } }
    sweep()
    for (const env of r.items || []) {
      const rep = reporter(cfgNow, env.jid)
      let p
      try { p = openEnvelope(env, cfg) } catch (e) {
        log(env.typ === 'cancel' ? 'Abbruch abgelehnt:' : 'Auftrag abgelehnt:', env.jid, e.message)
        if (env.typ !== 'cancel') void rep.finish('rejected', { error: e.message })
        continue
      }
      // Wiederholungsschutz: Besitzer „typ:jobId“; Gast „grantId:jobId“ (Abbruch „cancel:grantId:jobId“)
      const seenKey = p.guest ? (p.typ === 'cancel' ? `cancel:${p.guest.grantId}:${p.jobId}` : `${p.guest.grantId}:${p.jobId}`) : p.typ + ':' + p.jobId
      if (!seenOnce(seenKey, p.expiresAt)) {
        if (p.typ === 'job') void rep.finish('rejected', { error: 'Auftrag wurde schon einmal ausgeführt (Wiederholung abgelehnt).' })
        continue
      }
      if (p.guest) { try { rememberGuest(p.guest, p.typ === 'job') } catch { /* nur Anzeige */ } }
      if (p.typ === 'cancel') {
        // Ein Gast darf nur seine eigenen Aufträge abbrechen; der Besitzer alle
        const mine = q => !p.guest || q.p.guest?.grantId === p.guest.grantId
        const i = queue.findIndex(q => q.p.jobId === p.jobId && mine(q))
        if (i >= 0) { const [q] = queue.splice(i, 1); void q.rep.finish('cancelled', { error: 'Vor dem Start abgebrochen.' }) }
        const own = !p.guest || guestJobs.get(p.jobId)?.grantId === p.guest.grantId
        log('Abbruch', p.jobId, p.guest ? `(Gast ${p.guest.name})` : '', i >= 0 ? '(wartete noch)' : own && runner.cancel(p.jobId) ? '(läuft → beendet)' : '(nicht mehr aktiv)')
        continue
      }
      log('Auftrag', p.jobId, p.kind, p.guest ? `(Gast ${p.guest.name})` : '')
      if (p.guest) guestJobs.set(p.jobId, { grantId: p.guest.grantId, expiresAt: p.guest.expiresAt })
      queue.push({ p, rep }); pump()
    }
    if (r.items?.length) infoAt = 0
    if (once) { while (active || queue.length) await sleep(100); await sleep(400); return }
  }
}
