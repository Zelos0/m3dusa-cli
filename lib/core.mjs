// Gemeinsame Grundlagen: Pfade, Konfiguration, Fingerabdruck, signierte Aufträge prüfen.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const VERSION = '1.3.0'
export const DEFAULT_SERVER = 'https://m3dusa.zelosam.de'
export const HOME = os.homedir()

/**
 * Uhr dieses Programms. Nur für Tests: M3DUSA_TEST_CLOCK_FILE zeigt auf eine Datei mit einer Zahl (Millisekunden Vorsprung);
 * so lässt sich der Ablauf eines Gastzugangs prüfen, ohne die Systemuhr zu verstellen.
 */
export function clock() {
  const f = process.env.M3DUSA_TEST_CLOCK_FILE
  if (f) { try { const n = Number(fs.readFileSync(f, 'utf8').trim()); if (Number.isFinite(n)) return Date.now() + n } catch { /* keine Datei = keine Verschiebung */ } }
  return Date.now()
}

/** Konfiguration (Schlüssel, Kopplung, Freigaben) und Zustand (Protokoll). M3DUSA_HOME nur für Tests. */
export function dirs() {
  const base = process.env.M3DUSA_HOME
  return {
    conf: base ? path.join(base, 'config') : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'm3dusa'),
    state: base ? path.join(base, 'state') : path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state'), 'm3dusa'),
  }
}
export function ensureDirs() { for (const d of Object.values(dirs())) fs.mkdirSync(d, { recursive: true, mode: 0o700 }) }
const cfgFile = () => path.join(dirs().conf, 'config.json')

export function writeAtomic(file, data, mode = 0o600) {
  const t = file + '.' + randomBytes(4).toString('hex') + '.tmp'
  fs.writeFileSync(t, data, { mode })
  // Windows (nur Tests) sperrt frisch geschriebene Dateien kurz (Virenschutz, Indexer) → rename mit EBUSY/EPERM; wie hub/server.mjs wiederholen
  for (let i = 0; ; i++) {
    try { fs.renameSync(t, file); return } catch (e) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(e?.code) || i >= 8) { try { fs.unlinkSync(t) } catch { /* nichts zu räumen */ } throw e }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1))
    }
  }
}
export function readCfg() {
  try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return {}
    throw new Error('Konfiguration beschädigt: ' + cfgFile())
  }
}
export function writeCfg(c) { ensureDirs(); writeAtomic(cfgFile(), JSON.stringify(c, null, 1)) }
export function updateCfg(fn) { const c = readCfg(); const n = fn(c) || c; writeCfg(n); return n }
export const isPaired = c => !!(c && c.server && c.nodeId && c.token && c.controllerKey)

export const expandHome = p => (p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p)
export function within(p, root) { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) }

// ─── Kopplungscode + Fingerabdruck (Crockford-Base32) ─────────────────────────
const ALPH = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export function b32(buf) {
  let bits = 0, val = 0, out = ''
  for (const b of buf) { val = ((val << 8) | b) & 0xffff; bits += 8; while (bits >= 5) { out += ALPH[(val >>> (bits - 5)) & 31]; bits -= 5 } }
  if (bits > 0) out += ALPH[(val << (5 - bits)) & 31]
  return out
}
/** 16 Zeichen = 80 Bit aus SHA-256 des öffentlichen Schlüssels (SPKI/DER, Base64). Gleich in M3DUSA › nodes.ts. */
export const fingerprint = spkiB64 => b32(createHash('sha256').update(Buffer.from(spkiB64, 'base64')).digest()).slice(0, 16)
/** Code aus M3DUSA: 12 Zeichen Einmal-Code (für den Server) + 16 Zeichen Fingerabdruck (bleibt auf diesem Rechner). */
export function parseCode(x) {
  const s = String(x || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (!/^[0-9A-HJKMNP-TV-Z]{28}$/.test(s)) throw new Error('Kopplungscode ungültig — er hat 28 Zeichen (7 Vierergruppen) und steht in M3DUSA unter Erweiterungen › Geräte.')
  const claim = s.slice(0, 12)
  return { claim: claim.match(/.{4}/g).join('-'), fp: s.slice(12) }
}
export const groups = s => s.match(/.{1,4}/g).join('-')

// ─── Signierte Aufträge ───────────────────────────────────────────────────────
/** Prüft Unterschrift (Ed25519, Schlüssel des Haupt-PCs), Gerät, Gültigkeit. Wirft mit verständlichem Grund. */
export function openEnvelope(env, cfg) {
  if (!env || typeof env.payload !== 'string' || typeof env.sig !== 'string') throw new Error('Auftrag unvollständig.')
  // 1.2.0: Umschlag eines Gastes ({payload, sig, grant, grantSig}) — Zugang auf Zeit, vom Besitzer unterschrieben
  if (env.grant !== undefined || env.grantSig !== undefined) return openGuestEnvelope(env, cfg)
  const data = Buffer.from(env.payload, 'base64url')
  const key = createPublicKey({ key: Buffer.from(cfg.controllerKey, 'base64'), format: 'der', type: 'spki' })
  let ok = false
  try { ok = verify(null, data, key, Buffer.from(env.sig, 'base64url')) } catch { ok = false }
  if (!ok) throw new Error('Unterschrift ungültig — der Auftrag stammt nicht von deinem gekoppelten Haupt-PC.')
  let p
  try { p = JSON.parse(data.toString('utf8')) } catch { throw new Error('Auftrag nicht lesbar.') }
  delete p.guest // „guest“ setzt nur dieses Programm selbst (openGuestEnvelope)
  const now = clock()
  if (p.v !== 1) throw new Error('Unbekanntes Auftragsformat (m3dusa update?).')
  if (p.nodeId !== cfg.nodeId) throw new Error('Auftrag ist für ein anderes Gerät.')
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(p.jobId || '')) throw new Error('Auftragskennung ungültig.')
  if (env.jid && env.jid !== p.jobId) throw new Error('Auftragskennung passt nicht zur Unterschrift.')
  if (!(p.typ === 'job' || p.typ === 'cancel')) throw new Error('Unbekannte Auftragsart.')
  if (!(typeof p.expiresAt === 'number' && p.expiresAt > now)) throw new Error('Auftrag abgelaufen.')
  if (!(typeof p.issuedAt === 'number' && p.issuedAt <= now + 5 * 60e3)) throw new Error('Zeitstempel liegt in der Zukunft — Uhr dieses Rechners prüfen.')
  if (p.expiresAt - p.issuedAt > 24 * 3600e3) throw new Error('Gültigkeit des Auftrags zu lang.')
  return p
}

// ─── Gastzugänge (1.2.0) ──────────────────────────────────────────────────────
// Der Besitzer-Desktop unterschreibt ein Grant {v:1, typ:'grant', grantId, nodeId, guestKey, guestName, notBefore, expiresAt,
// rights:{kinds, sudo, folders?}}. Der Gast unterschreibt seine Aufträge mit SEINEM Schlüssel und legt das Grant bei.
// Dieses Programm prüft alles selbst — dem Hub wird nicht vertraut. Sperren (typ:'revoke') merkt es sich dauerhaft.
export const GRANT_RE = /^g_[a-f0-9]{12}$/
const KINDS = ['exec', 'read', 'write', 'list', 'agent', 'info']
const MAX_GRANT_MS = 7 * 24 * 3600e3 + 60e3
function verifySig(data, sigB64, keyB64) {
  try {
    const key = createPublicKey({ key: Buffer.from(String(keyB64), 'base64'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519' && verify(null, data, key, Buffer.from(String(sigB64), 'base64url'))
  } catch { return false }
}
/** Grant lesen und seine Unterschrift gegen den gekoppelten Haupt-PC prüfen (Zeitfenster prüft der Aufrufer). */
export function parseGrant(payload, sig, cfg) {
  if (typeof payload !== 'string' || typeof sig !== 'string' || payload.length > 8192) throw new Error('Zugangsbescheinigung unvollständig.')
  const data = Buffer.from(payload, 'base64url')
  if (!verifySig(data, sig, cfg.controllerKey)) throw new Error('Zugangsbescheinigung ungültig — nicht von deinem gekoppelten Haupt-PC unterschrieben.')
  let g
  try { g = JSON.parse(data.toString('utf8')) } catch { throw new Error('Zugangsbescheinigung nicht lesbar.') }
  if (g?.v !== 1 || g.typ !== 'grant') throw new Error('Unbekanntes Format der Zugangsbescheinigung (m3dusa update?).')
  if (g.nodeId !== cfg.nodeId) throw new Error('Zugangsbescheinigung ist für ein anderes Gerät.')
  if (!GRANT_RE.test(g.grantId || '')) throw new Error('Zugangskennung ungültig.')
  if (typeof g.guestKey !== 'string') throw new Error('Gast-Schlüssel fehlt.')
  try { if (createPublicKey({ key: Buffer.from(g.guestKey, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType !== 'ed25519') throw 0 } catch { throw new Error('Gast-Schlüssel ungültig.') }
  if (!(Number.isFinite(g.notBefore) && Number.isFinite(g.expiresAt) && g.expiresAt > g.notBefore && g.expiresAt - g.notBefore <= MAX_GRANT_MS)) throw new Error('Laufzeit des Zugangs ungültig (höchstens 7 Tage).')
  const r = g.rights
  if (!r || !Array.isArray(r.kinds) || !r.kinds.length || r.kinds.some(k => !KINDS.includes(k)) || typeof r.sudo !== 'boolean') throw new Error('Rechte des Zugangs ungültig.')
  if (r.folders !== undefined && !(Array.isArray(r.folders) && r.folders.length <= 20 && r.folders.every(f => typeof f === 'string' && f && f.length <= 300 && !f.includes('\0')))) throw new Error('Ordner des Zugangs ungültig.')
  return { grantId: g.grantId, guestKey: g.guestKey, guestName: String(g.guestName || 'Gast').replace(/[\x00-\x1f]/g, ' ').slice(0, 40), notBefore: g.notBefore, expiresAt: g.expiresAt, rights: { kinds: [...new Set(r.kinds)], sudo: r.sudo, ...(r.folders ? { folders: r.folders } : {}) } }
}

function openGuestEnvelope(env, cfg) {
  if (typeof env.grant !== 'string' || typeof env.grantSig !== 'string') throw new Error('Zugangsbescheinigung fehlt.')
  const g = parseGrant(env.grant, env.grantSig, cfg)
  const t = clock()
  if (g.notBefore > t + 5 * 60e3) throw new Error('Der Zugang beginnt erst später — Uhr dieses Rechners prüfen.')
  if (g.expiresAt <= t) throw new Error('Der Gastzugang ist abgelaufen.')
  if (isRevoked(g.grantId)) throw new Error('Der Gastzugang wurde widerrufen.')
  const data = Buffer.from(env.payload, 'base64url')
  if (!verifySig(data, env.sig, g.guestKey)) throw new Error('Unterschrift ungültig — der Auftrag stammt nicht vom Gast dieses Zugangs.')
  let p
  try { p = JSON.parse(data.toString('utf8')) } catch { throw new Error('Auftrag nicht lesbar.') }
  if (p.v !== 1) throw new Error('Unbekanntes Auftragsformat (m3dusa update?).')
  if (p.nodeId !== cfg.nodeId) throw new Error('Auftrag ist für ein anderes Gerät.')
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(p.jobId || '')) throw new Error('Auftragskennung ungültig.')
  if (env.jid && env.jid !== p.jobId) throw new Error('Auftragskennung passt nicht zur Unterschrift.')
  if (!(p.typ === 'job' || p.typ === 'cancel')) throw new Error('Unbekannte Auftragsart.')
  if (p.grantId !== g.grantId) throw new Error('Der Auftrag gehört zu einem anderen Zugang.')
  if (!(typeof p.expiresAt === 'number' && p.expiresAt > t)) throw new Error('Auftrag abgelaufen.')
  if (!(typeof p.issuedAt === 'number' && p.issuedAt <= t + 5 * 60e3)) throw new Error('Zeitstempel liegt in der Zukunft — Uhr dieses Rechners prüfen.')
  if (p.expiresAt - p.issuedAt > 24 * 3600e3) throw new Error('Gültigkeit des Auftrags zu lang.')
  if (p.expiresAt > g.expiresAt) throw new Error('Der Auftrag würde länger gelten als der Gastzugang.')
  if (p.typ === 'job') {
    if (!g.rights.kinds.includes(p.kind)) throw new Error(`Die Auftragsart „${String(p.kind).slice(0, 20)}“ ist für diesen Gastzugang nicht erlaubt.`)
    if (p.args && typeof p.args === 'object' && p.args.sudo && !g.rights.sudo) throw new Error('Gäste dürfen sudo nicht nutzen.')
  }
  p.guest = { grantId: g.grantId, name: g.guestName, guestKey: g.guestKey, notBefore: g.notBefore, expiresAt: g.expiresAt, rights: g.rights }
  return p
}

const revFile = () => path.join(dirs().state, 'revoked-grants.json')
const readJsonOr = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return def } }
/** Gesperrte Zugänge: {grantId: {at, until, by}} — bleibt dauerhaft (nur nach dem möglichen Ablauf aufgeräumt). */
export const revokedGrants = () => readJsonOr(revFile(), {})
export const isRevoked = grantId => !!revokedGrants()[grantId]
export function addRevoked(grantId, at, by) {
  if (!GRANT_RE.test(grantId)) throw new Error('Zugangskennung ungültig (Format g_ + 12 Zeichen).')
  const m = revokedGrants(), t = clock()
  for (const [k, v] of Object.entries(m)) if (v.until + 24 * 3600e3 < t) delete m[k]
  if (!m[grantId]) { m[grantId] = { at, until: at + 8 * 24 * 3600e3, by }; ensureDirs(); writeAtomic(revFile(), JSON.stringify(m, null, 1)); return true }
  return false
}
/** Sperre vom Server: nur mit gültiger Unterschrift des Haupt-PCs. Gibt die Zugangskennung zurück (oder null). */
export function acceptRevoke(x, cfg) {
  if (!x || typeof x.payload !== 'string' || typeof x.sig !== 'string' || x.payload.length > 4096) return null
  const data = Buffer.from(x.payload, 'base64url')
  if (!verifySig(data, x.sig, cfg.controllerKey)) return null
  let p
  try { p = JSON.parse(data.toString('utf8')) } catch { return null }
  if (p?.v !== 1 || p.typ !== 'revoke' || p.nodeId !== cfg.nodeId || !GRANT_RE.test(p.grantId || '')) return null
  addRevoked(p.grantId, Number.isFinite(p.issuedAt) ? p.issuedAt : clock(), 'Besitzer')
  return p.grantId
}
const guestsFile = () => path.join(dirs().state, 'guests.json')
/** Bekannte Gastzugänge (nur zur Anzeige: m3dusa gaeste). `used` = ein Auftrag wurde angenommen. */
export function rememberGuest(g, used = false) {
  const m = readJsonOr(guestsFile(), {}), t = clock()
  for (const [k, v] of Object.entries(m)) if (v.expiresAt + 3 * 24 * 3600e3 < t) delete m[k]
  const old = m[g.grantId]
  m[g.grantId] = { guestName: g.guestName ?? g.name, guestFp: fingerprint(g.guestKey), notBefore: g.notBefore, expiresAt: g.expiresAt, rights: g.rights, firstSeen: old?.firstSeen || t, lastUsed: used ? t : old?.lastUsed || null, jobs: (old?.jobs || 0) + (used ? 1 : 0) }
  ensureDirs(); writeAtomic(guestsFile(), JSON.stringify(m, null, 1))
}
export function knownGuests() {
  const m = readJsonOr(guestsFile(), {}), rv = revokedGrants(), t = clock()
  return Object.entries(m).map(([grantId, v]) => ({ grantId, ...v, state: rv[grantId] ? 'widerrufen' : v.expiresAt <= t ? 'abgelaufen' : 'aktiv' })).sort((a, b) => b.expiresAt - a.expiresAt)
}

/** Wiederholungsschutz: jede Auftragskennung wird nur einmal angenommen (gespeichert bis zum Ablauf). */
export function seenOnce(key, expiresAt) {
  const f = path.join(dirs().state, 'seen.json')
  let m = {}
  try { m = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { m = {} }
  const now = clock()
  for (const [k, v] of Object.entries(m)) if (v < now - 60e3) delete m[k]
  if (m[key]) return false
  m[key] = expiresAt
  ensureDirs(); writeAtomic(f, JSON.stringify(m))
  return true
}

export function logJob(entry) {
  try { ensureDirs(); fs.appendFileSync(path.join(dirs().state, 'jobs.log'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 }) } catch { /* Protokoll ist Zusatz */ }
}

export function cleanServer(x) {
  let u
  try { u = new URL(String(x).includes('://') ? String(x) : 'https://' + x) } catch { throw new Error('Server-Adresse ungültig.') }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('Server-Adresse muss mit https:// beginnen.')
  return u.origin
}

export async function hubCall(cfg, method, p, body, { timeoutMs = 20000, token } = {}) {
  const t = token === undefined ? cfg.token : token
  let r
  try {
    r = await fetch(cfg.server + p, {
      method,
      headers: { ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const err = new Error(e?.name === 'TimeoutError' ? 'Server antwortet nicht.' : 'Server nicht erreichbar (' + (e?.cause?.code || e?.message || 'Netz') + ').')
    err.status = 0
    throw err
  }
  const j = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; throw e }
  return j
}
