// Gemeinsame Grundlagen: Pfade, Konfiguration, Fingerabdruck, signierte Aufträge prüfen.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const VERSION = '1.0.0'
export const DEFAULT_SERVER = 'https://m3dusa.zelosam.de'
export const HOME = os.homedir()

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
  fs.renameSync(t, file)
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
  const data = Buffer.from(env.payload, 'base64url')
  const key = createPublicKey({ key: Buffer.from(cfg.controllerKey, 'base64'), format: 'der', type: 'spki' })
  let ok = false
  try { ok = verify(null, data, key, Buffer.from(env.sig, 'base64url')) } catch { ok = false }
  if (!ok) throw new Error('Unterschrift ungültig — der Auftrag stammt nicht von deinem gekoppelten Haupt-PC.')
  let p
  try { p = JSON.parse(data.toString('utf8')) } catch { throw new Error('Auftrag nicht lesbar.') }
  const now = Date.now()
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

/** Wiederholungsschutz: jede Auftragskennung wird nur einmal angenommen (gespeichert bis zum Ablauf). */
export function seenOnce(key, expiresAt) {
  const f = path.join(dirs().state, 'seen.json')
  let m = {}
  try { m = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { m = {} }
  const now = Date.now()
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
