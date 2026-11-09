// sudo-Zeitfenster: Du gibst EINMAL dein Passwort im Terminal ein (sudo selbst fragt, m3dusa sieht es nie).
// Danach liegt /etc/sudoers.d/m3dusa-<benutzer> mit NOPASSWD bis zum Ablauf (NOTAFTER, von sudo selbst
// durchgesetzt) — zusätzlich löscht ein systemd-Zeitgeber die Datei. „immer" = ohne Ablauf.
// Wichtig: In diesem Fenster darf JEDES Programm deines Benutzers sudo ohne Passwort nutzen, nicht nur m3dusa.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirs, ensureDirs, writeAtomic } from './core.mjs'

const user = () => os.userInfo().username
const target = () => `/etc/sudoers.d/m3dusa-${user().replace(/[^A-Za-z0-9_-]/g, '_')}`
const unit = () => `m3dusa-sudo-${user().replace(/[^A-Za-z0-9_-]/g, '_')}`
const recFile = () => path.join(dirs().state, 'sudo.json')

export const DURATIONS = { '15m': 15 * 60, '30m': 30 * 60, '1h': 3600, '2h': 7200, '4h': 4 * 3600, '8h': 8 * 3600, '12h': 12 * 3600, '1d': 86400, tag: 86400 }

/** Ende eines Zeitfensters: Dauer (30m, 1h …), „heute" (bis 23:59 Ortszeit) oder „immer" (null). */
export function parseWindow(x) {
  const s = String(x || '').toLowerCase()
  if (s === 'immer' || s === 'always' || s === 'forever') return null
  if (s === 'heute' || s === 'today') { const d = new Date(); d.setHours(23, 59, 0, 0); return d.getTime() }
  if (DURATIONS[s]) return Date.now() + DURATIONS[s] * 1000
  const m = /^(\d{1,4})(m|h|d)$/.exec(s)
  if (m) return Date.now() + Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2]] * 1000
  throw new Error('Dauer: 30m, 1h, 2h, 8h, 1d, heute oder immer')
}
const genTime = t => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') // YYYYMMDDHHMMSSZ

/** Wirklich aktiv? sudo selbst fragen (ohne Passwort, ohne Terminal). */
export function sudoActive() {
  if (process.getuid && process.getuid() === 0) return true
  const r = spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 8000 })
  return r.status === 0
}
export function sudoStatus() {
  let rec = null
  try { rec = JSON.parse(fs.readFileSync(recFile(), 'utf8')) } catch { rec = null }
  const active = sudoActive()
  return { active, root: !!(process.getuid && process.getuid() === 0), until: rec && active ? rec.until : null, forever: !!(rec && active && rec.until === null), setAt: rec?.setAt || null }
}

function sudoSh(script, args) {
  return spawnSync('sudo', ['sh', '-c', script, 'm3dusa-sudo', ...args], { stdio: 'inherit' })
}

export function grant(until) {
  if (process.getuid && process.getuid() === 0) throw new Error('Läuft als root — kein Zeitfenster nötig.')
  const u = user()
  ensureDirs()
  const tmp = path.join(dirs().state, 'sudoers.tmp')
  const head = `# Angelegt von m3dusa (${new Date().toISOString()}). Beenden: m3dusa sudo aus\n`
  const secs = until === null ? '' : String(Math.max(60, Math.round((until - Date.now()) / 1000)))
  // Zeitgeber vorher stoppen, Datei prüfen (visudo), einspielen, ggf. neuen Zeitgeber setzen — ein sudo-Aufruf
  const script = 'systemctl stop "$4.timer" 2>/dev/null; systemctl reset-failed "$4.service" "$4.timer" 2>/dev/null; ' +
    'visudo -cf "$1" >/dev/null || exit 3; install -o root -g root -m 0440 "$1" "$2" || exit 4; ' +
    // Befristet ohne NOTAFTER ($5 = ohne-notafter): dann MUSS der Zeitgeber klappen, sonst Regel sofort wieder weg
    'if [ -n "$3" ]; then systemd-run --quiet --unit="$4" --on-active="$3" /bin/rm -f "$2" || { if [ "$5" = ohne-notafter ]; then rm -f "$2"; exit 5; fi; echo "Hinweis: kein systemd-Zeitgeber — Ablauf nur über NOTAFTER (von sudo durchgesetzt)." >&2; }; fi'
  const tries = until === null ? [`${u} ALL=(ALL:ALL) NOPASSWD: ALL\n`] : [`${u} ALL=(ALL:ALL) NOTAFTER=${genTime(until)} NOPASSWD: ALL\n`, `${u} ALL=(ALL:ALL) NOPASSWD: ALL\n`]
  let r
  for (const [i, line] of tries.entries()) {
    writeAtomic(tmp, head + line, 0o600)
    fs.chmodSync(tmp, 0o644) // root liest die Datei (auch bei root_squash/fremdem Besitzer)
    r = sudoSh(script, [tmp, target(), secs, unit(), i === 1 ? 'ohne-notafter' : 'mit-notafter'])
    if (r.status === 0) {
      if (i === 1) process.stderr.write('Hinweis: Dieses sudo kennt NOTAFTER nicht — das Fenster endet über den systemd-Zeitgeber.\n')
      break
    }
    if (r.status !== 3) break
  }
  fs.rmSync(tmp, { force: true })
  if (r.status !== 0) throw new Error(r.status === 3 ? 'visudo hat die Regel abgelehnt — nichts geändert.' : r.status === 5 ? 'Dieses System kann ein befristetes Fenster nicht sicher beenden (sudo ohne NOTAFTER, kein systemd-Zeitgeber) — Regel wieder entfernt. Möglich ist nur: m3dusa sudo immer (und später m3dusa sudo aus).' : 'sudo abgebrochen oder fehlgeschlagen — nichts geändert.')
  writeAtomic(recFile(), JSON.stringify({ until, setAt: new Date().toISOString() }))
}

export function revoke() {
  if (process.getuid && process.getuid() === 0) return
  const r = sudoSh('rm -f "$1"; systemctl stop "$2.timer" 2>/dev/null; systemctl reset-failed "$2.service" "$2.timer" 2>/dev/null; true', [target(), unit()])
  fs.rmSync(recFile(), { force: true })
  if (r.status !== 0) throw new Error('sudo abgebrochen — Regel wurde nicht entfernt.')
}
export const sudoTarget = target
