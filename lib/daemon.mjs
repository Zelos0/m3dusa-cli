// Hintergrunddienst: fragt den M3DUSA-Server nach Aufträgen (lange Abfrage, nur ausgehende Verbindung),
// prüft jede Unterschrift selbst und meldet Ausgabe/Ergebnis zurück. Konfiguration wird bei jeder Runde
// neu gelesen (m3dusa ordner/modus wirken sofort, ohne Neustart).
import { hubCall, isPaired, openEnvelope, readCfg, seenOnce } from './core.mjs'
import { createRunner, nodeInfo } from './jobs.mjs'

const MAX_PARALLEL = 4
const MAX_OUT = 4 * 1024 * 1024
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString(), ...a)

/** Sammelt Ausgabe und schickt sie gebündelt (alle 300 ms) an den Server. */
function reporter(cfgNow, jid) {
  let buf = [], bytes = 0, cut = false, timer, final, sending = Promise.resolve()
  const flush = () => {
    clearTimeout(timer); timer = undefined
    const events = buf; buf = []
    const body = { events, ...(final ? final : {}) }
    if (!events.length && !final) return sending
    const isFinal = !!final
    sending = sending.then(async () => {
      for (let i = 0; i < (isFinal ? 8 : 3); i++) {
        try { await hubCall(cfgNow(), 'POST', `/api/v1/node/jobs/${encodeURIComponent(jid)}/events`, body, { timeoutMs: 60000 }); return } catch (e) {
          if (e.status && e.status < 500 && e.status !== 429) {
            // Abschluss nie verlieren: zu großes/abgelehntes Ergebnis → knapper Abschluss mit Grund
            if (isFinal && !body.fallback) {
              await hubCall(cfgNow(), 'POST', `/api/v1/node/jobs/${encodeURIComponent(jid)}/events`, { events: [], fallback: true, status: body.status === 'done' ? 'failed' : body.status, result: { error: `Ergebnis konnte nicht übertragen werden (Server: ${e.message}).` } }).catch(() => {})
            }
            return
          }
          await sleep(1000 * (i + 1))
        }
      }
    })
    return sending
  }
  return {
    out(stream, t) {
      if (!t) return
      if (bytes + t.length > MAX_OUT) { if (!cut) { cut = true; buf.push({ s: 'info', d: '\n[Ausgabe gekürzt — mehr als 4 MB]\n' }) } return }
      bytes += t.length
      const last = buf.at(-1)
      if (last && last.s === stream && last.d.length < 64 * 1024) last.d += t; else buf.push({ s: stream, d: t })
      if (!timer) timer = setTimeout(flush, 300)
    },
    finish(status, result) { final = { status, result }; return flush() },
    running() { return hubCall(cfgNow(), 'POST', `/api/v1/node/jobs/${encodeURIComponent(jid)}/events`, { events: [], status: 'running' }).catch(() => {}) },
  }
}

export async function runDaemon({ once = false } = {}) {
  const cfgNow = () => readCfg()
  const runner = createRunner({ cfgNow })
  const queue = []
  let active = 0, info = null, infoAt = 0, backoff = 1000, lastState = ''
  const pump = () => {
    while (active < MAX_PARALLEL && queue.length) {
      const { p, rep } = queue.shift()
      active++
      void rep.running()
      runner.run(p, rep).finally(() => { active--; pump() })
    }
  }
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
    for (const env of r.items || []) {
      const rep = reporter(cfgNow, env.jid)
      let p
      try { p = openEnvelope(env, cfg) } catch (e) {
        log(env.typ === 'cancel' ? 'Abbruch abgelehnt:' : 'Auftrag abgelehnt:', env.jid, e.message)
        if (env.typ !== 'cancel') void rep.finish('rejected', { error: e.message })
        continue
      }
      if (!seenOnce(p.typ + ':' + p.jobId, p.expiresAt)) {
        if (p.typ === 'job') void rep.finish('rejected', { error: 'Auftrag wurde schon einmal ausgeführt (Wiederholung abgelehnt).' })
        continue
      }
      if (p.typ === 'cancel') {
        const i = queue.findIndex(q => q.p.jobId === p.jobId)
        if (i >= 0) { const [q] = queue.splice(i, 1); void q.rep.finish('cancelled', { error: 'Vor dem Start abgebrochen.' }) }
        log('Abbruch', p.jobId, i >= 0 ? '(wartete noch)' : runner.cancel(p.jobId) ? '(läuft → beendet)' : '(nicht mehr aktiv)')
        continue
      }
      log('Auftrag', p.jobId, p.kind)
      queue.push({ p, rep }); pump()
    }
    if (r.items?.length) infoAt = 0
    if (once) { while (active || queue.length) await sleep(100); await sleep(400); return }
  }
}
