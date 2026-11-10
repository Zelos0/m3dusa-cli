#!/usr/bin/env node
// m3dusa — Linux-Knoten für M3DUSA. Hilfe: m3dusa hilfe
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addRevoked, clock, cleanServer, DEFAULT_SERVER, dirs, expandHome, fingerprint, groups, hubCall, isPaired, knownGuests, parseCode, readCfg, updateCfg, VERSION, writeCfg } from '../lib/core.mjs'
import { foldersOf, modeOf, sandboxStatus } from '../lib/policy.mjs'
import { grant, parseWindow, revoke, sudoStatus, sudoTarget } from '../lib/sudo.mjs'
import { agentArgv, agentsAvailable, readAgentLine, viaLoginShell } from '../lib/agents.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const cmd = (argv[0] || 'hilfe').toLowerCase()
const opt = name => { const i = argv.indexOf('--' + name); return i > 0 ? argv[i + 1] : undefined }
const rest = () => argv.slice(1).filter((x, i, a) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')))
const c = process.stdout.isTTY ? { g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` } : { g: s => s, y: s => s, r: s => s, b: s => s, d: s => s }
const die = (msg, code = 1) => { console.error(c.r('✗ ') + msg); process.exit(code) }
const fmtTime = t => new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
const hasSystemd = () => spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0

const HELP = `${c.b('m3dusa')} ${VERSION} — Linux-Knoten für M3DUSA

${c.b('Kopplung')}
  m3dusa login <Code>             mit M3DUSA auf dem Haupt-PC koppeln (Code: Erweiterungen › Geräte)
       [--server URL] [--name NAME]
  m3dusa logout                   Kopplung lösen (Haupt-PC kann nichts mehr ausführen)
  m3dusa status                   Verbindung, Freigaben, sudo, Sandbox, Claude/Codex

${c.b('Freigaben')} (nur hier am Linux-PC änderbar)
  m3dusa ordner                   freigegebene Ordner zeigen
  m3dusa ordner add <pfad>        Ordner freigeben     m3dusa ordner entfernen <pfad>
  m3dusa modus ordner|benutzer    ordner = nur freigegebene Ordner (Sandbox)
                                  benutzer = alles, was dein Benutzer darf
  m3dusa sudo 30m|1h|8h|heute|1d|immer   sudo-Zeitfenster (fragt dein Passwort hier im Terminal)
  m3dusa sudo aus | status

${c.b('Gäste')} (Zugang auf Zeit, vom Besitzer in M3DUSA geteilt)
  m3dusa gaeste [alle]            Gastzugänge zeigen (aktive; "alle" auch beendete)
  m3dusa gaeste sperren <ID>      Zugang hier sofort sperren (ID aus der Liste, z. B. g_1a2b3c4d5e6f)

${c.b('Selbst arbeiten')}
  m3dusa agent claude|codex "<Auftrag>" [--ordner PFAD] [--modell M]
  m3dusa log [Anzahl]             Protokoll der Aufträge vom Haupt-PC

${c.b('Dienst')}
  m3dusa dienst status|start|stop|neustart|logs
  m3dusa dienst autostart         auch ohne Anmeldung laufen (sudo loginctl enable-linger)
  m3dusa update                   neueste Fassung holen (git pull) und Dienst neu starten
  m3dusa pruefen                  alles prüfen (Node, Server, Sandbox, sudo, Claude/Codex)
`

async function main() {
  switch (cmd) {
    case 'hilfe': case 'help': case '-h': case '--help': return console.log(HELP)
    case 'version': case '--version': case '-v': return console.log(VERSION)
    case 'login': return login()
    case 'logout': return logout()
    case 'status': return status()
    case 'ordner': case 'folders': return folders()
    case 'modus': case 'mode': return mode()
    case 'sudo': return sudo()
    case 'gaeste': case 'gäste': case 'guests': return guests()
    case 'agent': return agent()
    case 'log': return showLog()
    case 'dienst': case 'service': return service()
    case 'daemon': { const { runDaemon } = await import('../lib/daemon.mjs'); return runDaemon({ once: argv.includes('--einmal') }) }
    case 'update': return update()
    case 'pruefen': case 'prüfen': case 'doctor': return doctor()
    default: die(`Unbekannter Befehl „${cmd}“. Hilfe: m3dusa hilfe`)
  }
}

async function login() {
  const code = rest()[0]
  if (!code) die('Aufruf: m3dusa login <Code>   (Code in M3DUSA: Erweiterungen › Geräte › „Gerät koppeln“)')
  let parsed
  try { parsed = parseCode(code) } catch (e) { die(e.message) }
  const old = readCfg()
  const server = cleanServer(opt('server') || old.server || DEFAULT_SERVER)
  const name = (opt('name') || os.hostname()).slice(0, 40)
  console.log(`Kopple mit ${server} …`)
  let r
  try {
    r = await hubCall({ server }, 'POST', '/api/v1/node/claim', { code: parsed.claim, name, hostname: os.hostname(), os: `${os.type()} ${os.release()}`, user: os.userInfo().username, version: VERSION }, { token: '' })
  } catch (e) { die('Kopplung fehlgeschlagen: ' + e.message) }
  if (fingerprint(r.controllerKey) !== parsed.fp) {
    await hubCall({ server, token: r.token }, 'POST', '/api/v1/node/bye', {}).catch(() => {})
    die('Fingerabdruck des Haupt-PCs passt nicht zum Code — Kopplung abgebrochen. (Wurde der Code abgetippt? Sonst: Server prüfen.)')
  }
  if (isPaired(old) && old.nodeId !== r.nodeId) await hubCall(old, 'POST', '/api/v1/node/bye', {}).catch(() => {})
  writeCfg({ ...old, server, nodeId: r.nodeId, token: r.token, controllerKey: r.controllerKey, owner: r.owner, name: r.name || name, pairedAt: new Date().toISOString(), mode: old.mode || 'ordner', folders: foldersOf(old) })
  console.log(c.g('✓ ') + `Gekoppelt als „${r.name || name}“ mit dem M3DUSA von ${r.owner}. Fingerabdruck ${groups(parsed.fp)} geprüft.`)
  const cfg = readCfg()
  if (modeOf(cfg) === 'ordner' && !foldersOf(cfg).length) console.log(c.y('! ') + 'Noch kein Ordner freigegeben. Zum Beispiel:  m3dusa ordner add ~/projekte   (oder: m3dusa modus benutzer)')
  if (modeOf(cfg) === 'ordner' && !sandboxStatus(true).ok) console.log(c.y('! ') + sandboxStatus().why)
  const svc = hasSystemd() && spawnSync('systemctl', ['--user', 'is-active', 'm3dusa'], { encoding: 'utf8' }).stdout.trim() === 'active'
  console.log(svc ? c.g('✓ ') + 'Dienst läuft — der Haupt-PC sieht dieses Gerät in wenigen Sekunden.' : c.y('! ') + 'Dienst läuft nicht. Starten: m3dusa dienst start   (ohne systemd: m3dusa daemon &)')
}

async function logout() {
  const cfg = readCfg()
  if (!isPaired(cfg)) return console.log('Nicht gekoppelt.')
  await hubCall(cfg, 'POST', '/api/v1/node/bye', {}).catch(e => console.log(c.y('! ') + 'Server: ' + e.message + ' (lokal trotzdem entkoppelt)'))
  const { server, mode: m, folders: f } = cfg
  writeCfg({ server, mode: m, folders: f })
  console.log(c.g('✓ ') + 'Entkoppelt. Freigaben bleiben gespeichert.')
}

async function status() {
  const cfg = readCfg()
  console.log(c.b('m3dusa ' + VERSION))
  if (!isPaired(cfg)) console.log(c.y('● nicht gekoppelt') + ' — m3dusa login <Code>')
  else {
    let online = c.y('? Server nicht erreichbar')
    try { await hubCall(cfg, 'POST', '/api/v1/node/poll', { wait: 0, peek: true }, { timeoutMs: 8000 }); online = c.g('● verbunden') } catch (e) { online = e.status === 401 || e.status === 403 || e.status === 404 ? c.r('● vom Server entfernt — neu koppeln') : c.y('● ' + e.message) }
    console.log(`${online}  ${cfg.server}  ·  Gerät „${cfg.name}“  ·  Haupt-PC von ${cfg.owner}  ·  Fingerabdruck ${groups(fingerprint(cfg.controllerKey))}`)
  }
  const m = modeOf(cfg), sb = sandboxStatus(true)
  console.log(`Modus: ${c.b(m)} ${m === 'ordner' ? '(nur freigegebene Ordner, Sandbox ' + (sb.ok ? c.g('bereit') : c.r('fehlt')) + ')' : '(alles, was dein Benutzer darf)'}`)
  if (m === 'ordner' && !sb.ok) console.log('  ' + c.y(sb.why))
  const fl = foldersOf(cfg)
  console.log('Ordner: ' + (fl.length ? fl.join(', ') : c.y('keine')))
  const s = sudoStatus()
  console.log('sudo:   ' + (s.root ? 'läuft als root' : s.active ? c.g('frei') + (s.forever ? ' (immer)' : s.until ? ' bis ' + fmtTime(s.until) : ' (eigene sudo-Regel/Zeitstempel)') : 'gesperrt — m3dusa sudo 1h'))
  const ag = agentsAvailable()
  console.log('KI:     ' + ['claude', 'codex'].map(a => `${a} ${ag[a] ? c.g('✓') : c.d('–')}`).join('   '))
  const gn = knownGuests().filter(g => g.state === 'aktiv').length
  if (gn) console.log(`Gäste:  ${c.b(String(gn))} aktiv — m3dusa gaeste`)
  if (hasSystemd()) console.log('Dienst: ' + spawnSync('systemctl', ['--user', 'is-active', 'm3dusa'], { encoding: 'utf8' }).stdout.trim())
}

function folders() {
  const [sub, p] = rest()
  if (!sub || sub === 'liste' || sub === 'list') {
    const fl = foldersOf(readCfg())
    return console.log(fl.length ? fl.join('\n') : 'Keine Ordner freigegeben. m3dusa ordner add <pfad>')
  }
  if (!p) die('Pfad fehlt.')
  const abs = path.resolve(expandHome(p))
  if (sub === 'add' || sub === 'hinzufuegen' || sub === 'hinzufügen') {
    let real
    try { real = fs.realpathSync(abs) } catch { die('Ordner gibt es nicht: ' + abs) }
    if (!fs.statSync(real).isDirectory()) die('Kein Ordner: ' + real)
    if (real === '/' || real === os.homedir()) console.log(c.y('! ') + `Du gibst ${real} komplett frei. Für alles besser: m3dusa modus benutzer`)
    for (const d of Object.values(dirs())) if (real.startsWith(d) || d.startsWith(real + path.sep)) console.log(c.y('! ') + 'Die Einstellungen von m3dusa bleiben trotzdem gesperrt.')
    updateCfg(cfg => { cfg.folders = [...new Set([...foldersOf(cfg), real])] })
    return console.log(c.g('✓ ') + 'Freigegeben: ' + real)
  }
  if (sub === 'entfernen' || sub === 'remove' || sub === 'rm') {
    let real = abs; try { real = fs.realpathSync(abs) } catch { /* evtl. gelöscht */ }
    let hit = false
    updateCfg(cfg => { const before = foldersOf(cfg); cfg.folders = before.filter(f => f !== real && f !== abs); hit = cfg.folders.length !== before.length })
    return console.log(hit ? c.g('✓ ') + 'Entfernt: ' + real : 'War nicht freigegeben: ' + real)
  }
  die('m3dusa ordner [add|entfernen] <pfad>')
}

function mode() {
  const m = rest()[0]
  if (!m) return console.log(modeOf(readCfg()))
  if (m !== 'ordner' && m !== 'benutzer') die('m3dusa modus ordner|benutzer')
  updateCfg(cfg => { cfg.mode = m })
  console.log(c.g('✓ ') + (m === 'ordner' ? 'Modus ordner: Aufträge nur in freigegebenen Ordnern (Sandbox).' : 'Modus benutzer: Aufträge dürfen alles, was dein Benutzer darf (sudo weiterhin nur im Zeitfenster).'))
  if (m === 'ordner' && !sandboxStatus(true).ok) console.log(c.y('! ') + sandboxStatus().why)
}

function sudo() {
  const a = (rest()[0] || 'status').toLowerCase()
  if (a === 'status') {
    const s = sudoStatus()
    return console.log(s.root ? 'Läuft als root.' : s.active ? 'sudo frei' + (s.forever ? ' — dauerhaft' : s.until ? ' bis ' + fmtTime(s.until) : '') : 'sudo gesperrt (Aufträge mit sudo werden abgelehnt).')
  }
  if (a === 'aus' || a === 'off') { try { revoke() } catch (e) { die(e.message) } return console.log(c.g('✓ ') + 'sudo-Fenster beendet.') }
  let until
  try { until = parseWindow(a) } catch (e) { die(e.message) }
  console.log(until === null
    ? c.y('Achtung: ') + 'dauerhaft — jedes Programm deines Benutzers kann dann sudo ohne Passwort nutzen. Beenden: m3dusa sudo aus'
    : `sudo ohne Passwort bis ${fmtTime(until)}. In dieser Zeit gilt das für alle Programme deines Benutzers.`)
  console.log(c.d(`(Regel: ${sudoTarget()} — sudo fragt jetzt einmal nach deinem Passwort)`))
  try { grant(until) } catch (e) { die(e.message) }
  console.log(c.g('✓ ') + 'sudo-Fenster offen.')
}

function guests() {
  const [sub, id] = rest()
  if (sub === 'sperren' || sub === 'revoke') {
    if (!id) die('Aufruf: m3dusa gaeste sperren <ID>   (ID siehe: m3dusa gaeste)')
    let fresh
    try { fresh = addRevoked(id, clock(), 'lokal') } catch (e) { die(e.message) }
    console.log(c.g('✓ ') + (fresh ? `Zugang ${id} gesperrt.` : `Zugang ${id} war schon gesperrt.`) + ' Laufende Aufträge dieses Zugangs beendet der Dienst innerhalb weniger Sekunden.')
    return
  }
  if (sub && sub !== 'alle' && sub !== 'liste') die('m3dusa gaeste [alle] | m3dusa gaeste sperren <ID>')
  const all = knownGuests().filter(g => sub === 'alle' || g.state === 'aktiv')
  if (!all.length) return console.log(sub === 'alle' ? 'Keine Gastzugänge bekannt.' : 'Keine aktiven Gastzugänge. (Sie erscheinen, sobald der Besitzer einen Zugang bestätigt hat und dieser Dienst läuft.)')
  for (const g of all) {
    const col = g.state === 'aktiv' ? c.g : c.y
    const r = g.rights || {}
    console.log(`${c.b(g.grantId)}  ${col(g.state.padEnd(10))} ${g.guestName}  bis ${fmtTime(g.expiresAt)}  ${c.d('Schlüssel ' + groups(g.guestFp))}`)
    console.log(`    Rechte: ${(r.kinds || []).join(', ')}${r.sudo ? ', sudo' : ' (kein sudo)'}${r.folders?.length ? ' · Ordner: ' + r.folders.join(', ') : ''}  ·  Aufträge: ${g.jobs || 0}${g.lastUsed ? ', zuletzt ' + fmtTime(g.lastUsed) : ''}`)
  }
}

async function agent() {
  const [kind, ...words] = rest()
  if (kind !== 'claude' && kind !== 'codex') die('m3dusa agent claude|codex "<Auftrag>" [--ordner PFAD] [--modell M]')
  const prompt = words.join(' ').trim()
  if (!prompt) die('Auftrag fehlt.')
  if (!agentsAvailable()[kind]) die(kind === 'claude' ? 'Claude Code fehlt: npm i -g @anthropic-ai/claude-code, dann einmal `claude` (anmelden).' : 'Codex fehlt: npm i -g @openai/codex, dann `codex login`.')
  const cwd = path.resolve(expandHome(opt('ordner') || process.cwd()))
  const p = spawn(viaLoginShell(agentArgv(kind, { model: opt('modell') }))[0], viaLoginShell(agentArgv(kind, { model: opt('modell') })).slice(1), { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
  p.stdin.end(prompt)
  let pend = '', final
  p.stdout.on('data', b => {
    pend += b.toString('utf8')
    let i
    while ((i = pend.indexOf('\n')) >= 0) {
      const r = readAgentLine(kind, pend.slice(0, i)); pend = pend.slice(i + 1)
      if (r.show) console.log(r.show)
      if (r.final !== undefined) final = r.final
    }
  })
  p.on('close', code => { if (final && kind === 'claude') console.log('\n' + c.b('Ergebnis:') + '\n' + final); process.exit(code ?? 1) })
}

function showLog() {
  const n = Math.max(1, Math.min(500, Number(rest()[0]) || 20))
  let lines = []
  try { lines = fs.readFileSync(path.join(dirs().state, 'jobs.log'), 'utf8').trim().split('\n').filter(Boolean) } catch { return console.log('Noch keine Aufträge.') }
  for (const l of lines.slice(-n)) {
    try {
      const e = JSON.parse(l)
      const col = e.status === 'done' ? c.g : e.status === 'rejected' ? c.r : c.y
      console.log(`${fmtTime(e.at)}  ${col(e.status.padEnd(9))} ${e.kind.padEnd(6)} ${e.what || ''}${e.exit != null ? c.d(' (Exit ' + e.exit + ')') : ''}${e.error ? c.d(' — ' + e.error) : ''}`)
    } catch { /* kaputte Zeile */ }
  }
}

function service() {
  const a = (rest()[0] || 'status').toLowerCase()
  if (a === 'autostart') {
    console.log('Dienst auch ohne Anmeldung laufen lassen (sudo fragt nach deinem Passwort):')
    const r = spawnSync('sudo', ['loginctl', 'enable-linger', os.userInfo().username], { stdio: 'inherit' })
    return r.status === 0 ? console.log(c.g('✓ ') + 'Autostart aktiv.') : die('Nicht geändert.')
  }
  if (!hasSystemd()) die('Kein systemd-Benutzerdienst verfügbar. Stattdessen: nohup m3dusa daemon > ~/m3dusa.log 2>&1 &')
  if (a === 'logs') return spawnSync('journalctl', ['--user', '-u', 'm3dusa', '-n', '80', '--no-pager'], { stdio: 'inherit' })
  const map = { status: ['status', '--no-pager'], start: ['start'], stop: ['stop'], neustart: ['restart'], restart: ['restart'] }
  if (!map[a]) die('m3dusa dienst status|start|stop|neustart|logs|autostart')
  spawnSync('systemctl', ['--user', ...map[a], 'm3dusa'], { stdio: 'inherit' })
}

function update() {
  if (!fs.existsSync(path.join(REPO, '.git'))) die('Kein git-Ordner: ' + REPO)
  const r = spawnSync('git', ['-C', REPO, 'pull', '--ff-only'], { stdio: 'inherit' })
  if (r.status !== 0) die('git pull fehlgeschlagen (eigene Änderungen im Ordner?).')
  if (hasSystemd()) spawnSync('systemctl', ['--user', 'restart', 'm3dusa'], { stdio: 'inherit' })
  console.log(c.g('✓ ') + 'Aktualisiert.')
}

async function doctor() {
  const ok = (b, t, hint) => console.log((b ? c.g('✓ ') : c.r('✗ ')) + t + (b || !hint ? '' : c.d('  → ' + hint)))
  ok(Number(process.versions.node.split('.')[0]) >= 18, 'Node ' + process.versions.node, 'Node ≥ 18 nötig (bash install.sh lädt eins)')
  const cfg = readCfg()
  ok(isPaired(cfg), 'gekoppelt', 'm3dusa login <Code>')
  if (isPaired(cfg)) { let e = null; try { await hubCall(cfg, 'POST', '/api/v1/node/poll', { wait: 0, peek: true }, { timeoutMs: 8000 }) } catch (x) { e = x } ok(!e, 'Server ' + cfg.server, e?.message) }
  const sb = sandboxStatus(true)
  ok(sb.ok, 'Sandbox (bubblewrap)', sb.why)
  ok(modeOf(cfg) === 'benutzer' || foldersOf(cfg).length > 0, 'Freigaben (' + modeOf(cfg) + ')', 'm3dusa ordner add <pfad>')
  const s = sudoStatus(); console.log((s.active ? c.g('● ') : c.d('○ ')) + 'sudo ' + (s.active ? 'frei' : 'gesperrt (normal)'))
  const ag = agentsAvailable()
  ok(ag.claude, 'Claude Code', 'npm i -g @anthropic-ai/claude-code')
  ok(ag.codex, 'Codex', 'npm i -g @openai/codex')
  ok(hasSystemd(), 'systemd-Benutzerdienst', 'ohne systemd: m3dusa daemon im Hintergrund starten')
}

main().catch(e => die(e.message || String(e)))
