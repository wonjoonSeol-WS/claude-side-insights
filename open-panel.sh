#!/bin/bash
# Claude Code SessionStart hook (also run by `claude-panel`): start the panel server and attach the
# panel to the right of the current cmux panel, or as a browser tab in Orca. Idempotent per pane.
set -u
[ -z "${CLAUDE_ACTIVITY_CHILD:-}" ] || exit 0
if [ "${1:-}" != "--force" ]; then
  [ "$(/usr/bin/python3 "$HOME/.claude/activity-panel/config.py" get panel_auto 2>/dev/null)" != "0" ] || exit 0
fi

base="$HOME/.claude/activity-panel"
input=""
[ -t 0 ] || input=$(cat)
. "$base/key.sh"
key=$(panel_key "$input")
[ -n "$key" ] || exit 0

{
  ensure_panel_server
  url="http://127.0.0.1:$(panel_port)/p/$key"

  if [ -n "${CMUX_SURFACE_ID:-}" ] && command -v cmux >/dev/null 2>&1; then
    [ -n "$(cmux_panel_surfaces "$key")" ] && exit 0
    cmux browser open-split "$url" >/dev/null 2>&1
  elif [ -n "${ORCA_PANE_KEY:-}" ] && command -v orca >/dev/null 2>&1; then
    orca tab list --json 2>/dev/null | grep -q "/p/$key" && exit 0
    orca tab create --url "$url" --json >/dev/null 2>&1
  fi
} >/dev/null 2>&1

exit 0
