#!/bin/bash
# SessionStart hook, also run by `claude-panel`: open this pane's panel once, through the adapter in terminals/.
# With --force and no matching adapter, the page opens in the default browser.
set -u
[ -z "${CLAUDE_ACTIVITY_CHILD:-}" ] || exit 0
umask 077

PANEL_ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$PANEL_ROOT/shell/key.sh"
input=""
[ -t 0 ] || input=$(cat)
key=$(panel_key "$input")
[ -n "$key" ] || exit 0
if [ "${1:-}" != "--force" ]; then
  [ "$(panel_py config get panel_auto "$key" 2>/dev/null)" != "0" ] || exit 0
fi

{
  ensure_panel_server || exit 0
  url=$(panel_url "$key")
  if ! panel_terminal >/dev/null; then
    [ "${1:-}" = "--force" ] && open "$url&full=1"
    exit 0
  fi
  [ -n "$(panel_term find "$key")" ] && exit 0
  panel_term open "$key" "$url"
} >/dev/null 2>&1
exit 0
