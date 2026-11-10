// Freigaben auf DIESEM Rechner: Modus (ordner|benutzer), freigegebene Ordner, Sandbox (bubblewrap).
// Nur der Linux-Nutzer selbst ändert das (m3dusa modus / m3dusa ordner) — Aufträge vom Haupt-PC können es nicht.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { dirs, expandHome, HOME, within } from './core.mjs'

export const modeOf = cfg => (cfg.mode === 'benutzer' ? 'benutzer' : 'ordner')
export const foldersOf = cfg => (Array.isArray(cfg.folders) ? cfg.folders.filter(f => typeof f === 'string') : [])
export const NO_FOLDERS = 'Auf dem Linux-PC ist noch kein Ordner freigegeben. Dort ausführen: m3dusa ordner add ~/projekte  (oder: m3dusa modus benutzer)'

function realParent(p) {
  const rest = []
  let cur = p
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()) } catch (e) {
      if (e.code !== 'ENOENT') throw e
      const up = path.dirname(cur)
      if (up === cur) throw e
      rest.push(path.basename(cur)); cur = up
    }
  }
}
const realOr = d => { try { return fs.realpathSync(d) } catch { return d } }

/**
 * Freigaben für einen GAST: Hat sein Zugang Ordner (rights.folders), gelten nur noch diese — und nur, soweit sie auch hier
 * freigegeben sind (Teilmenge der lokalen Freigaben; im Modus „benutzer“ gelten sie unverändert). Ohne Ordner im Zugang
 * gilt die lokale Einstellung wie beim Besitzer. Ein Gast mit Ordnern läuft immer im Ordner-Modus (also mit Sandbox).
 */
export function guestCfg(cfg, rights) {
  if (!Array.isArray(rights?.folders) || !rights.folders.length) return cfg
  const local = foldersOf(cfg).map(realOr), mode = modeOf(cfg)
  const out = new Set()
  for (const f of rights.folders) {
    const e = expandHome(f.trim())
    if (!path.isAbsolute(e)) continue
    let r; try { r = fs.realpathSync(e) } catch { continue }
    if (mode !== 'ordner') { out.add(r); continue }
    for (const l of local) { if (within(r, l)) out.add(r); else if (within(l, r)) out.add(l) } // Schnittmenge: der engere Ordner
  }
  if (!out.size) throw new Error('Keiner der Ordner dieses Gastzugangs ist auf dem Linux-PC freigegeben (Außerhalb der freigegebenen Ordner). Besitzer: m3dusa ordner add <pfad>')
  return { ...cfg, mode: 'ordner', folders: [...out] }
}

/** Pfad aus einem Auftrag auflösen und gegen die Freigaben prüfen. Gibt den echten Pfad zurück. */
export function resolveTarget(cfg, input, { mustExist = false } = {}) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('Pfad fehlt.')
  const mode = modeOf(cfg), fl = foldersOf(cfg)
  if (mode === 'ordner' && !fl.length) throw new Error(NO_FOLDERS)
  let p = expandHome(input.trim())
  if (!path.isAbsolute(p)) p = path.resolve(mode === 'ordner' ? fl[0] : HOME, p)
  let real, missing = false
  try { real = fs.realpathSync(p) } catch (e) {
    if (e.code !== 'ENOENT') throw e
    missing = true
    real = realParent(p)
  }
  // Erst die Freigabe prüfen, dann „gibt es nicht“ — sonst verrät die Antwort, was außerhalb existiert
  for (const d of Object.values(dirs())) if (within(real, realOr(d))) throw new Error('Gesperrt: die Einstellungen von m3dusa sind für Aufträge nicht erreichbar.')
  if (mode === 'ordner' && !fl.some(f => within(real, realOr(f)))) throw new Error(`Außerhalb der freigegebenen Ordner: ${real}\nFreigegeben: ${fl.join(', ')}\nAuf dem Linux-PC: m3dusa ordner add <pfad>  oder  m3dusa modus benutzer`)
  if (missing && mustExist) throw new Error('Nicht gefunden: ' + p)
  return real
}

/** Arbeitsordner eines Befehls. Ordner-Modus: muss in einer Freigabe liegen (Standard: erste Freigabe). */
export function resolveCwd(cfg, cwd) {
  const fl = foldersOf(cfg)
  if (!cwd) {
    if (modeOf(cfg) === 'ordner') { if (!fl.length) throw new Error(NO_FOLDERS); return realOr(fl[0]) }
    return HOME
  }
  const r = resolveTarget(cfg, cwd, { mustExist: true })
  if (!fs.statSync(r).isDirectory()) throw new Error('Kein Ordner: ' + r)
  return r
}

// ─── Sandbox ──────────────────────────────────────────────────────────────────
function onPath(name) {
  for (const d of (process.env.PATH || '').split(':').filter(Boolean)) {
    const f = path.join(d, name)
    try { fs.accessSync(f, fs.constants.X_OK); return f } catch { /* weiter */ }
  }
  return null
}
let probe = { at: 0, ok: false, why: '' }
export function sandboxStatus(force = false) {
  if (!force && Date.now() - probe.at < 10 * 60e3) return probe
  const b = process.env.M3DUSA_BWRAP === '0' ? null : onPath('bwrap')
  if (!b) probe = { at: Date.now(), ok: false, why: 'bubblewrap fehlt — installieren: sudo apt install bubblewrap (Fedora: sudo dnf install bubblewrap, Arch: sudo pacman -S bubblewrap)' }
  else {
    const r = spawnSync(b, ['--unshare-pid', '--unshare-ipc', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', HOME, 'true'], { timeout: 10000 })
    probe = r.status === 0 ? { at: Date.now(), ok: true, why: '', bin: b }
      : { at: Date.now(), ok: false, why: 'bubblewrap startet nicht: ' + String(r.stderr || r.error?.message || '').trim().slice(0, 300) + ' (Ubuntu ≥ 23.10: AppArmor-Profil für bwrap bzw. kernel.apparmor_restrict_unprivileged_userns prüfen)' }
  }
  return probe
}

// Lesend wieder eingeblendet, damit Programme im Benutzerordner (nvm, ~/.local/bin, claude, codex …) laufen.
const RUNTIME_RO = ['.local/bin', '.local/lib', '.local/share/claude', '.local/share/m3dusa', '.local/share/pnpm', '.nvm', '.npm-global', '.bun', '.cargo', '.rustup', '.volta', '.deno', '.pyenv', '.profile', '.bashrc', '.bash_profile', '.gitconfig', '.config/git']
// Für KI-Aufträge zusätzlich schreibbar (Anmeldung + Sitzungen von Claude Code / Codex).
const AGENT_RW = ['.claude', '.claude.json', '.codex', '.config/claude']

/**
 * Befehl im Ordner-Modus einsperren: System nur lesend, Benutzerordner leer (außer Programmen),
 * schreibbar nur die freigegebenen Ordner; die Einstellungen von m3dusa (Schlüssel) sind unsichtbar.
 */
export function wrapSandbox(cfg, argv, { cwd, agent = false, extraRo = [] }) {
  const st = sandboxStatus()
  if (!st.ok) throw new Error('Ordner-Modus braucht die Sandbox: ' + st.why + '\nOder auf dem Linux-PC: m3dusa modus benutzer')
  // Eigene PID-/IPC-Namensräume: keine Sicht auf (und kein ptrace an) Prozesse des Benutzers außerhalb
  const a = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', HOME]
  // Steuer-Sockets ausblenden: über den Sitzungsbus (systemd-run --user), den Systembus oder Docker ließe sich
  // ein Prozess AUSSERHALB der Sandbox starten — ein schreibgeschützter Mount verhindert Socket-Verbindungen nicht.
  const uid = process.getuid ? process.getuid() : null
  for (const d of [uid != null ? `/run/user/${uid}` : '', '/run/dbus', '/run/containerd', '/run/podman', '/run/screen', '/run/tmux', '/var/run/dbus']) if (d && fs.existsSync(d)) a.push('--tmpfs', d)
  for (const s of ['/run/docker.sock', '/var/run/docker.sock', '/run/snapd.socket', '/run/snapd-snap.socket']) if (fs.existsSync(s)) a.push('--ro-bind', '/dev/null', s)
  for (const r of RUNTIME_RO) a.push('--ro-bind-try', path.join(HOME, r), path.join(HOME, r))
  // 1.4.0: Ordner des gefundenen Agenten (z. B. eigenes npm-Präfix im Home) lesend einblenden
  for (const d of extraRo) if (typeof d === 'string' && path.isAbsolute(d) && within(d, HOME) && d !== HOME) a.push('--ro-bind-try', d, d)
  if (agent) for (const r of AGENT_RW) a.push('--bind-try', path.join(HOME, r), path.join(HOME, r))
  for (const f of foldersOf(cfg)) { const r = realOr(f); a.push('--bind', r, r) }
  // Nach ALLEN Freigaben: Einstellungen von m3dusa (Schlüssel, Gerätecode) wieder ausblenden — auch wenn ein
  // freigegebener Ordner sie enthält (z. B. ganzes Home freigegeben)
  for (const d of Object.values(dirs())) a.push('--tmpfs', d)
  a.push('--unsetenv', 'DBUS_SESSION_BUS_ADDRESS', '--unsetenv', 'DISPLAY', '--unsetenv', 'WAYLAND_DISPLAY', '--unsetenv', 'XDG_RUNTIME_DIR', '--unsetenv', 'SSH_AUTH_SOCK')
  a.push('--setenv', 'HOME', HOME, '--chdir', cwd, '--')
  return [st.bin, [...a, ...argv]]
}
