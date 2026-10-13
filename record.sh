#!/bin/bash
# Hook for PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit and Stop.
set -u
[ -z "${CLAUDE_ACTIVITY_CHILD:-}" ] || exit 0
umask 077

base="$HOME/.claude/activity-panel"
mkdir -p "$base/logs" "$base/turns" 2>/dev/null || exit 0
input=$(cat)
. "$base/key.sh"
key=$(panel_key "$input")
[ -n "$key" ] || exit 0

out=$(printf '%s' "$input" | jq -r -f "$base/record.jq" 2>/dev/null) || exit 0
printf '%s\n' "$out" | sed -n 1p >> "$base/logs/$key.jsonl"
stop_line=$(printf '%s\n' "$out" | sed -n 2p)
if [ -n "$stop_line" ]; then
  IFS=$'\t' read -r _ transcript cwd <<< "$stop_line"
  turn_file="$base/turns/$key.json"
  jq -n --arg t "$transcript" --arg c "$cwd" '{transcript: $t, cwd: $c}' > "$turn_file.tmp" && mv "$turn_file.tmp" "$turn_file"
  /usr/bin/python3 "$base/detach.py" flow.py "$key" "$transcript" "$cwd" </dev/null >> "$base/flow.log" 2>&1 &
  /usr/bin/python3 "$base/detach.py" qa.py "$key" "$transcript" </dev/null >> "$base/flow.log" 2>&1 &
fi
exit 0
