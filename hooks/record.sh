#!/bin/bash
# Hook for PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit and Stop.
set -u
[ -z "${SIDE_INSIGHTS_CHILD:-}" ] || exit 0
umask 077
LOG_MAX_BYTES=5000000
LOG_KEEP_LINES=5000

PANEL_ROOT=$(cd "$(dirname "${0//\\//}")/.." && pwd)
. "$PANEL_ROOT/shell/key.sh"
base="$PANEL_DATA"
mkdir -p "$base/logs" "$base/turns" 2>/dev/null || exit 0
input=$(cat)
key=$(panel_key "$input")
[ -n "$key" ] || exit 0

if panel_has_jq; then
  out=$(printf '%s' "$input" | "$PANEL_JQ" -r -f "$PANEL_ROOT/hooks/record.jq" 2>/dev/null) || exit 0
else
  panel_python
  [ -n "$PANEL_PYTHON" ] || exit 0
  out=$(printf '%s' "$input" | panel_py record-event 2>/dev/null) || exit 0
fi
out=$(printf '%s' "$out" | tr -d '\r')
log="$base/logs/$key.jsonl"
printf '%s\n' "$out" | sed -n 1p >> "$log"
if [ "$(($(wc -c < "$log" 2>/dev/null || echo 0)))" -gt "$LOG_MAX_BYTES" ]; then
  tail -n "$LOG_KEEP_LINES" "$log" > "$log.tmp" && mv "$log.tmp" "$log"
fi
stop_json=$(printf '%s\n' "$out" | sed -n 2p)
panel_python
if [ -n "$stop_json" ] && [ -n "$PANEL_PYTHON" ]; then
  turn_file="$base/turns/$key.json"
  printf '%s\n' "$stop_json" > "$turn_file.tmp" && mv "$turn_file.tmp" "$turn_file"
  transcript=$(printf '%s\n' "$out" | sed -n 3p)
  cwd=$(printf '%s\n' "$out" | sed -n 4p)
  panel_py detach flow "$key" "$transcript" "$cwd" </dev/null >> "$base/analysis.log" 2>&1 &
  panel_py detach qa "$key" "$transcript" </dev/null >> "$base/analysis.log" 2>&1 &
fi
exit 0
