#!/bin/bash
# SessionStart hook, also run by `si-panel --force` (which falls back to the default browser).
set -u
[ -z "${SIDE_INSIGHTS_CHILD:-}" ] || exit 0
umask 077
PANEL_ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$PANEL_ROOT/shell/key.sh"
force=0
[ "${1:-}" = "--force" ] && force=1

input=""
[ -t 0 ] || input=$(cat)
key=$(panel_key "$input")
[ -n "$key" ] || exit 0
adapter=$(panel_terminal)
if [ "$force" = 0 ]; then
  [ "$(uname -s)" = Darwin ] && [ -n "$adapter" ] || exit 0
fi

missing=$(panel_missing)
if [ -n "$missing" ]; then
  [ "$force" = 1 ] && echo "side-insights needs: $missing" >&2 \
    || printf '{"systemMessage": "side-insights needs: %s. Install it, then restart Claude Code."}\n' "$missing"
  exit 0
fi

if [ "$force" = 0 ]; then
  [ "$(panel_py config get panel_auto "$key" 2>/dev/null)" = "1" ] || exit 0
fi

{
  ensure_panel_server || exit 0
  url=$(panel_url "$key")
  if [ -z "$adapter" ]; then
    /usr/bin/open "$url&full=1"
    exit 0
  fi
  [ -n "$(panel_adapter "$adapter" find "$key")" ] && exit 0
  panel_adapter "$adapter" open "$key" "$url"
} >/dev/null 2>&1
exit 0
