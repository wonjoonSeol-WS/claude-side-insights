#!/bin/bash
# SessionEnd hook: close this pane's panel when Claude exits. On /clear the session ends and a new one starts in the same pane, so the panel stays.
set -u
[ -z "${SIDE_INSIGHTS_CHILD:-}" ] || exit 0
PANEL_ROOT=$(cd "$(dirname "${0//\\//}")/.." && pwd)
. "$PANEL_ROOT/shell/key.sh"
input=""
[ -t 0 ] || input=$(cat)
[ "$(panel_json_field reason "$input")" = "clear" ] && exit 0
key=$(panel_key "$input")
[ -n "$key" ] || exit 0
adapter=$(panel_terminal) || exit 0
panel_adapter "$adapter" find "$key" 2>/dev/null | while IFS= read -r handle; do
  panel_adapter "$adapter" close "$handle"
done
exit 0
