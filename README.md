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
| `m3dusa status` | Verbindung, Modus, Ordner, sudo, Sandbox, Claude/Codex |
| `m3dusa ordner add <pfad>` · `m3dusa ordner entfernen <pfad>` | Ordner freigeben bzw. Freigabe entfernen |
| `m3dusa modus ordner` | nur freigegebene Ordner, Befehle laufen in der Sandbox (Standard) |
| `m3dusa modus benutzer` | Aufträge dürfen alles, was dein Benutzer darf |
| `m3dusa sudo 30m` / `1h` / `8h` / `heute` / `1d` / `immer` | sudo-Zeitfenster öffnen; dein Passwort fragt sudo selbst ab |
| `m3dusa sudo aus` · `m3dusa sudo status` | Zeitfenster sofort schließen bzw. anzeigen |
| `m3dusa agent claude "<Auftrag>" --ordner ~/projekte/x` | Claude Code oder Codex lokal starten |
| `m3dusa log` | Protokoll aller Aufträge vom Haupt-PC |
| `m3dusa dienst status` / `start` / `stop` / `neustart` / `logs` | den Dienst steuern |
| `m3dusa dienst autostart` | Dienst läuft auch ohne Anmeldung (`loginctl enable-linger`) |
| `m3dusa update` | neueste Fassung holen (`git pull`) und Dienst neu starten |
| `m3dusa pruefen` | alles prüfen |
| `m3dusa logout` | Kopplung lösen |

Damit Claude Code oder Codex auf dem Linux-PC laufen, müssen sie **dort** installiert und angemeldet sein:

- Claude Code: `npm i -g @anthropic-ai/claude-code`, danach einmal `claude` starten und anmelden.
- Codex: `npm i -g @openai/codex`, danach `codex login`.

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
