# m3dusa-cli: M3DUSA auf Linux

Mit diesem Programm wird ein Linux-PC zum **Gerät** deines M3DUSA auf dem Haupt-PC. Danach kannst du:

- **vom Haupt-PC aus** Befehle, Dateien und KI-Aufträge auf dem Linux-PC ausführen, von Hand im Reiter „Geräte“ oder durch deine Agents (Claude, Codex, Grok über die Werkzeuge `remote_*`),
- **auf dem Linux-PC selbst** mit `m3dusa agent claude|codex "…"` arbeiten,
- **selbst festlegen, was erlaubt ist**: entweder nur freigegebene Ordner in einer Sandbox oder alles, was dein Benutzer darf. `sudo` gibt es nur in einem Zeitfenster, das du hier im Terminal mit deinem Passwort öffnest.

Beide Rechner verbinden sich nur **nach außen** mit deinem M3DUSA-Server (z. B. `m3dusa.zelosam.de`). Am Router oder in der Firewall musst du nichts freigeben.

## Installation (ohne root)

```bash
git clone https://github.com/Zelos0/m3dusa-cli.git ~/m3dusa-cli
cd ~/m3dusa-cli && bash install.sh
```

Was das Skript macht:

- Es legt den Befehl `~/.local/bin/m3dusa` an.
- Es richtet den Hintergrunddienst `m3dusa` ein (`systemctl --user`).
- Fehlt Node ≥ 18, lädt es Node nach `~/.local/share/m3dusa/node` und prüft die Prüfsumme gegen nodejs.org.

Fehlt `git`, installierst du es mit `sudo apt install git`.

Für den Ordner-Modus brauchst du außerdem **bubblewrap** (`sudo apt install bubblewrap`).

## Koppeln

1. Auf dem Haupt-PC in M3DUSA: **Erweiterungen › Geräte › „Gerät koppeln“**. Vorher muss M3DUSA unter Skill Library › Server mit dem M3DUSA-Server verbunden sein.
2. Auf dem Linux-PC:

```bash
m3dusa login XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
m3dusa ordner add ~/projekte
```

Der Code ist 10 Minuten gültig und funktioniert nur einmal. Er enthält den **Fingerabdruck** des Haupt-PCs. Darüber prüft der Linux-PC, dass er wirklich mit deinem Haupt-PC gekoppelt wird und nicht mit einem Schlüssel, den ihm jemand unterwegs untergeschoben hat.

## Befehle

| Befehl | Wirkung |
|---|---|
| `m3dusa` · `m3dusa chat` | Terminal-Modus (siehe unten) |
| `m3dusa status` | Verbindung, Modus, Ordner, sudo, Sandbox, Claude/Codex |
| `m3dusa ordner add <pfad>` · `m3dusa ordner entfernen <pfad>` | Ordner freigeben bzw. Freigabe entfernen |
| `m3dusa modus ordner` | nur freigegebene Ordner, Befehle laufen in der Sandbox (Standard) |
| `m3dusa modus benutzer` | Aufträge dürfen alles, was dein Benutzer darf |
| `m3dusa sudo 30m` / `1h` / `8h` / `heute` / `1d` / `immer` | sudo-Zeitfenster öffnen; dein Passwort fragt sudo selbst ab |
| `m3dusa sudo aus` · `m3dusa sudo status` | Zeitfenster sofort schließen bzw. anzeigen |
| `m3dusa agent claude "<Auftrag>" --ordner ~/projekte/x` | Claude Code oder Codex lokal starten (`--modell M`, `--aufwand STUFE`) |
| `m3dusa log` | Protokoll aller Aufträge vom Haupt-PC |
| `m3dusa dienst status` / `start` / `stop` / `neustart` / `logs` | den Dienst steuern |
| `m3dusa dienst autostart` | Dienst läuft auch ohne Anmeldung (`loginctl enable-linger`) |
| `m3dusa update` | neueste Fassung holen (`git pull`) und Dienst neu starten |
| `m3dusa pruefen` | alles prüfen, auch **wo** Claude/Codex gefunden wurden (bzw. wo gesucht wurde) und ob sie angemeldet sind |
| `m3dusa logout` | Kopplung lösen |

## Terminal-Modus

`m3dusa` ohne Argumente startet in einem echten Terminal einen interaktiven Modus, ähnlich wie `claude` oder `codex`. Ausdrücklich geht es auch mit `m3dusa chat`. Ohne Terminal (z. B. in Skripten mit Umleitung) zeigt `m3dusa` wie bisher die Hilfe. Alle anderen Befehle bleiben unverändert.

- **Start:** eine kurze Animation (Logo mit Farbverlauf Violett → Cyan → Grün, Schlangen als Welle), danach ein Statusfeld mit Version, Gerät, Hub-Verbindung, Dienst, je einer Zeile für Claude und Codex (Version und **angemeldet ✓ / nicht angemeldet / fehlt**), Arbeitsordner und aktivem Agenten mit Modell und Aufwand. Ohne Animation: `m3dusa chat --no-anim` oder `M3DUSA_NO_ANIM=1`. Bei `NO_COLOR` oder `TERM=dumb` gibt es nur ein ruhiges Banner ohne Farbe.
- **Freitext** ist ein Auftrag an den aktiven Agenten im aktuellen Ordner. Die Ausgabe erscheint live; solange nichts kommt, läuft ein Spinner. Am Ende stehen die Dauer und die **Token** (Eingabe, Ausgabe, Cache) mit dem Vergleichswert „entspräche API-Preis ≈ $X“. Im Abo zahlst du das nicht; die Zahl zeigt nur, was derselbe Lauf über die API gekostet hätte (Preise: `lib/prices.json`, erzeugt mit `node tools/sync-prices.mjs` aus der Preisliste von M3DUSA). Kennt die Liste das Modell nicht, steht dort „unbekannt“. Codex meldet kein Cache-Schreiben, deshalb ist sein Wert eine Untergrenze („ab“). Folgeaufträge behalten den Kontext (`claude --resume <Sitzung>` bzw. `codex exec resume <Sitzung>`).
- **Tasten:** Sobald die Zeile mit `/` beginnt, erscheint darunter eine gefilterte Befehlsliste mit Kurzbeschreibung: ↑/↓ wählt, Tab oder Enter übernimmt, Esc schließt sie. Sonst: ↑/↓ Verlauf, Tab ergänzt Befehle, Modelle und Ordner, `\` am Zeilenende schreibt in der nächsten Zeile weiter. Strg+C während eines Laufs bricht nur den Lauf ab; am leeren Prompt zweimal Strg+C (oder Strg+D) beendet.
- **Modell und Aufwand:** `/modell` zeigt alle Modelle, getrennt nach **Claude** (Standard, fable, opus, sonnet, haiku) und **Codex** (live aus `codex app-server`, sonst „Standard“; einen eigenen Namen gibst du mit `/modell <name>` an). Fehlt ein Agent, steht dort ein grauer Hinweis. Wählst du ein Modell des anderen Agenten, wechselt der Agent mit. Direkt danach fragt m3dusa nach dem **Aufwand** (Claude: low, medium, high, xhigh, max; Codex: die Stufen des Modells). Er geht als `--effort` bzw. `-c model_reasoning_effort=…` an den Agenten.
- **Anmelden:** `/codex login` bzw. `/claude login` (auch `/login codex`) startet die Anmeldung des Programms selbst im selben Terminal (`codex login` bzw. `claude auth login`). Ohne Bildschirm (SSH, Server) bietet m3dusa für Codex die Anmeldung per Gerätecode an (`codex login --device-auth`, direkt: `/codex login geraet`). Ist ein Agent nicht angemeldet, fragt `/codex` bzw. `/claude`, ob du dich jetzt anmelden willst. m3dusa sieht dabei keine Zugangsdaten und liest keine Anmeldedateien; den Status fragt es mit `claude auth status` und `codex login status` ab.

| Befehl | Wirkung |
|---|---|
| `/modell [name]` | Modell wählen (Liste: Claude & Codex), danach Aufwand; `/modell standard` setzt zurück |
| `/aufwand [stufe]` | Denkaufwand setzen (ohne Stufe: Liste; `standard` setzt zurück) |
| `/claude` · `/codex` | Agent wechseln (bietet die Anmeldung an, falls nötig) |
| `/claude login` · `/codex login [geraet\|browser]` · `/login claude\|codex` | Agent anmelden |
| `/kosten` · `/tokens` | Token und API-Vergleichspreis dieser Sitzung je Agent und Modell |
| `/neu` | Kontext vergessen |
| `/ordner <pfad>` | Arbeitsordner wechseln (beginnt neuen Kontext) |
| `/status` | Statusfeld neu (prüft Agenten und Anmeldung erneut) |
| `/gaeste [alle]` · `/dienst [status\|start\|stop\|neustart\|logs]` | wie `m3dusa gaeste` bzw. `m3dusa dienst` |
| `/hilfe` | alle Befehle, nach Gruppen |
| `/ende` | beenden |

**Agent wird nicht gefunden?** m3dusa sucht in dieser Reihenfolge: PATH des Programms, `bash -lc`, deine Login-Shell interaktiv (`$SHELL -lic`, z. B. zsh auf Kali; liest `~/.zshrc`), dann die üblichen Ordner (`~/.npm-global/bin`, `~/.local/bin`, `~/.nvm/versions/node/*/bin`, `~/.volta/bin`, `~/.bun/bin`, `~/.cargo/bin`, `/usr/local/bin`, `/opt/homebrew/bin` …) und zuletzt `$(npm config get prefix)/bin`. Gestartet wird das gefundene Programm über seinen absoluten Pfad. `m3dusa pruefen` zeigt, wo es gefunden bzw. überall gesucht wurde.

Wie `m3dusa agent` läuft der Agent hier mit den Rechten deines Benutzers (die Freigaben und die Sandbox gelten für Aufträge vom Haupt-PC).

Damit Claude Code oder Codex auf dem Linux-PC laufen, müssen sie **dort** installiert und angemeldet sein:

- Claude Code: `npm i -g @anthropic-ai/claude-code`, danach `claude auth login` (oder im Terminal-Modus `/claude login`).
- Codex: `npm i -g @openai/codex`, danach `codex login` (ohne Browser: `codex login --device-auth`, im Terminal-Modus `/codex login`).

Version: 1.4.0.

## Sicherheit: so funktioniert es

- **Jeder Auftrag ist unterschrieben** (Ed25519). Der Schlüssel liegt nur im Tresor von M3DUSA auf dem Haupt-PC. Der Linux-PC prüft jede Unterschrift selbst. Der Server reicht Aufträge nur weiter: Selbst wer den Server übernimmt, kann auf dem Linux-PC nichts ausführen lassen.
- **Kein Auftrag läuft zweimal.** Jeder Auftrag hat eine eigene Kennung und läuft nach höchstens 24 Stunden ab.
- **Freigaben ändert nur der Linux-PC.** Der Haupt-PC kann weder Modus, Ordner noch sudo ändern. Die Einstellungen von m3dusa mit Schlüssel und Gerätecode sind für Aufträge nicht erreichbar.
- **Ordner-Modus:** Die Sandbox ist bubblewrap.
  - Das System ist darin nur lesbar.
  - Dein Home-Ordner ist leer, nur Programme wie nvm, `~/.local/bin`, claude und codex bleiben sichtbar.
  - Schreiben geht nur in den freigegebenen Ordnern.
  - Steuer-Sockets sind ausgeblendet (Sitzungs- und Systembus, Docker, snapd), damit ein Befehl über `systemd-run --user` o. Ä. nicht aus der Sandbox ausbrechen kann. Eigene Prozess- und IPC-Namensräume verhindern den Zugriff auf deine anderen Programme.
  - Die Einstellungen von m3dusa bleiben auch dann unsichtbar, wenn du einen Ordner freigibst, der sie enthält (z. B. dein ganzes Home).
  - Ohne bubblewrap lehnt der Ordner-Modus Befehle ab, statt ungeschützt zu laufen.
  - **Grenze:** Das Netzwerk bleibt offen (KI-Agenten brauchen es). Auf einem Desktop mit X11 könnte ein gezielt bösartiger Befehl über den abstrakten X11-Socket Tastendrücke an deine Sitzung schicken. Der Ordner-Modus schützt vor Versehen und Übergriffen der KI, ist aber keine Festung gegen absichtlich bösartigen Code. Auf einem Server ohne grafische Sitzung entfällt das.
- **sudo-Zeitfenster:** `m3dusa sudo 1h` legt `/etc/sudoers.d/m3dusa-<benutzer>` an, mit `NOPASSWD` und Ablaufzeit (`NOTAFTER`, sudo setzt sie selbst durch). Zusätzlich löscht ein systemd-Zeitgeber die Datei zum Ablauf. **Wichtig:** Solange das Fenster offen ist, darf *jedes* Programm deines Benutzers sudo ohne Passwort nutzen, nicht nur m3dusa. Schließen kannst du es jederzeit mit `m3dusa sudo aus`.
- **Protokoll:** Jeder Auftrag landet in `~/.local/state/m3dusa/jobs.log`. Anzeigen kannst du ihn mit `m3dusa log`.

## Entfernen

```bash
cd ~/m3dusa-cli && bash uninstall.sh          # Einstellungen bleiben erhalten
bash uninstall.sh --alles                      # entfernt auch die Einstellungen
```

## Voraussetzungen

Linux mit bash, Node ≥ 18 (lädt das Installationsskript selbst) und `systemd --user` (empfohlen).

Ohne systemd startest du den Dienst selbst:

```bash
nohup m3dusa daemon > ~/m3dusa.log 2>&1 &
```

Geprüft auf Ubuntu 24.04. Andere Distributionen sollten genauso funktionieren.
