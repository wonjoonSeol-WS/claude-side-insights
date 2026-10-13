#!/bin/bash
# SessionEnd hook: close this pane's panel when Claude exits.
set -u
[ -z "${CLAUDE_ACTIVITY_CHILD:-}" ] || exit 0
PANEL_ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$PANEL_ROOT/shell/key.sh"
input=""
[ -t 0 ] || input=$(cat)
key=$(panel_key "$input")
[ -n "$key" ] && panel_term_has close || exit 0
panel_term find "$key" | while IFS= read -r handle; do
  panel_term close "$handle"
done
exit 0
