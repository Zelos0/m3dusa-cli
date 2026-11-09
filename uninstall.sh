#!/usr/bin/env bash
# m3dusa entfernen. Einstellungen (~/.config/m3dusa) bleiben, außer mit --alles.
set -uo pipefail
BIN="$HOME/.local/bin/m3dusa"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/m3dusa.service"
if [ -x "$BIN" ]; then "$BIN" logout >/dev/null 2>&1 || true; fi
if [ -e "/etc/sudoers.d/m3dusa-$(id -un)" ]; then
  echo "sudo-Regel entfernen (fragt ggf. dein Passwort):"
  sudo rm -f "/etc/sudoers.d/m3dusa-$(id -un)" || echo "Bitte selbst löschen: /etc/sudoers.d/m3dusa-$(id -un)"
fi
if command -v systemctl >/dev/null 2>&1; then systemctl --user disable --now m3dusa >/dev/null 2>&1 || true; fi
rm -f "$UNIT" "$BIN"
command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1 || true
if [ "${1:-}" = "--alles" ]; then
  rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/m3dusa" "${XDG_STATE_HOME:-$HOME/.local/state}/m3dusa" "${XDG_DATA_HOME:-$HOME/.local/share}/m3dusa"
  echo "✓ m3dusa samt Einstellungen entfernt."
else
  echo "✓ m3dusa entfernt (Einstellungen bleiben; komplett: ./uninstall.sh --alles)."
fi
