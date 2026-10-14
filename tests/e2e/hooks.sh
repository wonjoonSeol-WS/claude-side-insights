#!/bin/bash
# The hook, the server and the diff endpoint end to end, with and without jq. Run from the repository root.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DATA=$(mktemp -d)
NATIVE_DATA=$DATA
command -v cygpath >/dev/null 2>&1 && NATIVE_DATA=$(cygpath -w "$DATA")
export SIDE_INSIGHTS_DATA="$NATIVE_DATA" SIDE_INSIGHTS_PORT="${SIDE_INSIGHTS_PORT:-47899}"
unset CMUX_PANEL_ID ORCA_PANE_KEY ITERM_SESSION_ID CLAUDE_CODE_SESSION_ID
printf '{"flow_auto": false, "qa_auto": false}' > "$DATA/config.json"
failures=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }

. "$ROOT/shell/key.sh"
check "a Python 3.9+ is found" '[ -n "$(panel_python; printf %s "$PANEL_PYTHON")" ]'
check "nothing is reported missing" '[ -z "$(panel_missing)" ]'

repo="$DATA/repo"
mkdir -p "$repo/app/[id]" "$repo/app/i"
git -C "$repo" init -q && printf 'one\n' > "$repo/app/[id]/page.tsx" && printf 'one\n' > "$repo/app/i/page.tsx"
git -C "$repo" add . && git -C "$repo" -c user.name=t -c user.email=t@t commit -qm first
printf 'two\n' > "$repo/app/[id]/page.tsx"
printf 'two\n' > "$repo/app/i/page.tsx"
file=$(panel_native "$repo/app/[id]/page.tsx")
cwd=$(panel_native "$repo")
json_path() { printf '%s' "$1" | sed 's/\\/\\\\/g'; }

hook() {
  printf '{"hook_event_name":"%s","session_id":"e2e-%s","cwd":"%s","transcript_path":"","tool_use_id":"u1","tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"one"},"tool_response":{"type":"update"}}' \
    "$1" "$2" "$(json_path "$cwd")" "$(json_path "$file")" | "$ROOT/hooks/record.sh"
}
hook PreToolUse jq
hook PostToolUse jq
SIDE_INSIGHTS_JQ=no-such-jq hook PreToolUse python
SIDE_INSIGHTS_JQ=no-such-jq hook PostToolUse python
transcript=$(panel_native "$DATA/transcript.jsonl")
: > "$DATA/transcript.jsonl"
stop() {
  printf '{"hook_event_name":"Stop","session_id":"e2e-%s","cwd":"%s","transcript_path":"%s"}' "$1" "$(json_path "$cwd")" "$(json_path "$transcript")" | "$ROOT/hooks/record.sh"
}
stop jq
SIDE_INSIGHTS_JQ=no-such-jq stop python
for pane in e2e-jq e2e-python; do
  [ "$pane" = e2e-jq ] && ! panel_has_jq && continue
  check "$pane: three events logged" '[ "$(wc -l < "$DATA/logs/$pane.jsonl" | tr -d " ")" = 3 ]'
  check "$pane: the edit is recorded" 'grep -q "\"tool\":\"Edit\"" "$DATA/logs/$pane.jsonl"'
  check "$pane: no carriage returns in the log" '! grep -q "$(printf "\r")" "$DATA/logs/$pane.jsonl"'
  check "$pane: the stop writes the turn" 'grep -q "transcript.jsonl" "$DATA/turns/$pane.json"'
done
printf '{"hook_event_name":"PreToolUse","session_id":"e2e-outer","tool_use_id":"u2","tool_name":"Agent","tool_input":{"session_id":"e2e-inner"}}' | "$ROOT/hooks/record.sh"
check "a session id inside the tool input does not pick the pane" '[ -s "$DATA/logs/e2e-outer.jsonl" ] && [ ! -e "$DATA/logs/e2e-inner.jsonl" ]'

check "the server starts" 'ensure_panel_server'
check "a second start reuses it" 'ensure_panel_server'
token=$(cat "$DATA/token")
state=$(curl -s -m 5 -H "X-Side-Insights: $token" "http://127.0.0.1:$SIDE_INSIGHTS_PORT/api/e2e-python/state")
check "the state lists the edited file" 'printf "%s" "$state" | grep -q "page.tsx"'
diff_reply=$(curl -s -m 15 -G -H "X-Side-Insights: $token" --data-urlencode "path=$file" "http://127.0.0.1:$SIDE_INSIGHTS_PORT/api/e2e-python/diff")
check "the diff of a bracketed path is that one file" '[ "$(printf "%s" "$diff_reply" | grep -o "@@ -" | wc -l | tr -d " ")" = 1 ]'
check "the diff shows the change" 'printf "%s" "$diff_reply" | grep -q "+two"'
if command -v node >/dev/null 2>&1; then
  node "$ROOT/tests/e2e/browser.mjs" "http://127.0.0.1:$SIDE_INSIGHTS_PORT/p/e2e-python?t=$token" "page.tsx"
  case $? in 0) echo "ok   the page renders in a real browser" ;; 2) ;; *) echo "FAIL the page renders in a real browser"; failures=$((failures + 1)) ;; esac
fi
refused=$(curl -s -o /dev/null -w '%{http_code}' -G -H "X-Side-Insights: $token" --data-urlencode "path=$(panel_native "$DATA/token")" "http://127.0.0.1:$SIDE_INSIGHTS_PORT/api/e2e-python/diff")
check "a file outside the session is refused" '[ "$refused" = 404 ]'

pid=$(curl -s -m 2 "http://127.0.0.1:$SIDE_INSIGHTS_PORT/health" | sed -n 's/.*"pid": *\([0-9]*\).*/\1/p')
panel_python
PYTHONPATH="$PANEL_SRC" "$PANEL_PYTHON" -c "import sys; from side_insights.system import terminate; terminate(sys.argv[1])" "$pid"
rm -rf "$DATA"
echo "$failures failed"
[ "$failures" = 0 ]
