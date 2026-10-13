#!/bin/bash
# Claude Code hook (PreToolUse/PostToolUse/UserPromptSubmit/Stop): append one line per event for the activity panel.
# Keyed by the host pane (cmux panel / Orca pane) so the panel follows whichever session lives there.
# On Stop, starts the logic-flow summary for the finished turn in the background.
set -u
[ -z "${CLAUDE_ACTIVITY_CHILD:-}" ] || exit 0

base="$HOME/.claude/activity-panel"
mkdir -p "$base/logs" "$base/turns" 2>/dev/null || exit 0

input=$(cat)
. "$base/key.sh"
key=$(panel_key "$input")
[ -n "$key" ] || exit 0

printf '%s' "$input" | jq -c --arg ts "$(perl -MTime::HiRes=time -e 'printf "%.3f", time')" \
  -f "$base/record.jq" >> "$base/logs/$key.jsonl" 2>/dev/null

case "$input" in
  *'"Stop"'*)
    transcript=$(printf '%s' "$input" | jq -r 'select(.hook_event_name == "Stop") | .transcript_path // empty' 2>/dev/null)
    cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
    if [ -n "$transcript" ]; then
      jq -n --arg t "$transcript" --arg c "$cwd" '{transcript: $t, cwd: $c}' > "$base/turns/$key.json" 2>/dev/null
      nohup /usr/bin/python3 "$base/flow.py" "$key" "$transcript" "$cwd" >> "$base/flow.log" 2>&1 &
      nohup /usr/bin/python3 "$base/qa.py" "$key" "$transcript" >> "$base/flow.log" 2>&1 &
    fi
    ;;
esac
exit 0
