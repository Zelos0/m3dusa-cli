#!/usr/bin/env bash
# m3dusa installieren (ohne root): Befehl ~/.local/bin/m3dusa + systemd-Benutzerdienst.
# Fehlt Node ≥ 18, wird Node in ~/.local/share/m3dusa/node geladen (Prüfsumme von nodejs.org geprüft).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_VERSION="v24.15.0"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/m3dusa"
BIN="$HOME/.local/bin"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "Nur für Linux."
[ "$(id -u)" -ne 0 ] || warn "Du installierst als root. Empfohlen ist dein normaler Benutzer (Claude Code verweigert als root den Vollzugriff)."

# ─── Node ─────────────────────────────────────────────────────────────────────
NODE=""
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -ge 18 ]; then NODE="$(command -v node)"; ok "Node $(node -v) gefunden"; fi
fi
if [ -z "$NODE" ] && [ -x "$DATA/node/bin/node" ]; then NODE="$DATA/node/bin/node"; ok "Node aus $DATA/node"; fi
if [ -z "$NODE" ]; then
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; armv7l) ARCH=armv7l ;; ppc64le) ARCH=ppc64le ;; s390x) ARCH=s390x ;;
    *) die "Unbekannte Architektur $(uname -m) — bitte Node ≥ 18 selbst installieren." ;;
  esac
  F="node-$NODE_VERSION-linux-$ARCH.tar.xz"
  URL="https://nodejs.org/dist/$NODE_VERSION"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  echo "Lade Node $NODE_VERSION ($ARCH) …"
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$TMP/$F" "$URL/$F"; curl -fsSL -o "$TMP/SHASUMS256.txt" "$URL/SHASUMS256.txt"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$TMP/$F" "$URL/$F"; wget -qO "$TMP/SHASUMS256.txt" "$URL/SHASUMS256.txt"
  else die "Weder curl noch wget gefunden."; fi
  (cd "$TMP" && grep " $F\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "Prüfsumme von Node stimmt nicht — abgebrochen."
  rm -rf "$DATA/node"; mkdir -p "$DATA/node"
  tar -xJf "$TMP/$F" -C "$DATA/node" --strip-components=1
  NODE="$DATA/node/bin/node"
  ok "Node $NODE_VERSION nach $DATA/node (Prüfsumme ok)"
fi

# ─── Befehl ───────────────────────────────────────────────────────────────────
mkdir -p "$BIN"
cat > "$BIN/m3dusa" <<EOF
#!/bin/sh
exec "$NODE" "$REPO/bin/m3dusa.mjs" "\$@"
EOF
chmod 755 "$BIN/m3dusa"
ok "Befehl: $BIN/m3dusa"
case ":$PATH:" in *":$BIN:"*) ;; *) warn "$BIN steht nicht im PATH. Einmal ausführen:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;; esac

# ─── Dienst ───────────────────────────────────────────────────────────────────
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/m3dusa.service" <<EOF
[Unit]
Description=M3DUSA Linux-Knoten (Auftraege vom gekoppelten Haupt-PC)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$NODE $REPO/bin/m3dusa.mjs daemon
Restart=always
RestartSec=5
Environment=PATH=$BIN:$(dirname "$NODE"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now m3dusa >/dev/null 2>&1 && ok "Dienst m3dusa läuft (systemctl --user)" || warn "Dienst konnte nicht starten — m3dusa dienst logs"
  if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'yes'; then
    warn "Der Dienst läuft nur, solange du angemeldet bist. Dauerhaft: m3dusa dienst autostart"
  fi
else
  warn "Kein systemd-Benutzerdienst — Dienst von Hand starten:  nohup m3dusa daemon > ~/m3dusa.log 2>&1 &"
fi

# ─── Sandbox ──────────────────────────────────────────────────────────────────
if command -v bwrap >/dev/null 2>&1; then ok "bubblewrap vorhanden (Sandbox für den Ordner-Modus)"
else
  if command -v apt >/dev/null 2>&1; then H="sudo apt install bubblewrap"
  elif command -v dnf >/dev/null 2>&1; then H="sudo dnf install bubblewrap"
  elif command -v pacman >/dev/null 2>&1; then H="sudo pacman -S bubblewrap"
  elif command -v zypper >/dev/null 2>&1; then H="sudo zypper install bubblewrap"
  else H="Paket „bubblewrap“ installieren"; fi
  warn "bubblewrap fehlt — ohne Sandbox lehnt der Ordner-Modus Befehle ab. Installieren: $H"
fi

echo
echo "Fertig. Nächster Schritt — in M3DUSA auf dem Haupt-PC: Erweiterungen › Geräte › „Gerät koppeln“, dann hier:"
echo "  m3dusa login <Code>"
echo "  m3dusa ordner add ~/projekte      # was der Haupt-PC bearbeiten darf"
