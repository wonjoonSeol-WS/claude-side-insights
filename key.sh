# Shared by the hooks and shell commands.

# panel_key <hook-json>: cmux panel id, else Orca pane key, else the Claude session id. Same rule as common.pane_key.
panel_key() {
  local raw="${CMUX_PANEL_ID:-}"
  [ -n "$raw" ] || raw="${ORCA_PANE_KEY:-}"
  [ -n "$raw" ] || raw=$(printf '%s' "$1" | jq -r '.session_id // empty' 2>/dev/null)
  [ -n "$raw" ] || return 0
  printf '%s' "$raw" | LC_ALL=C tr -c 'A-Za-z0-9_.-' '_' | tail -c 80 | sed 's/^\./_/'
}

panel_port() { printf '%s' "${CLAUDE_PANEL_PORT:-47821}"; }

panel_server_pid() {
  curl -s -m 1 "http://127.0.0.1:$(panel_port)/health" 2>/dev/null \
    | sed -n 's/.*"pid": *\([0-9][0-9]*\).*"app": *"claude-panel".*/\1/p'
}

ensure_panel_server() {
  [ -n "$(panel_server_pid)" ] && return 0
  /usr/bin/python3 "$HOME/.claude/activity-panel/detach.py" server.py </dev/null >> "$HOME/.claude/activity-panel/server.log" 2>&1 &
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [ -n "$(panel_server_pid)" ] && return 0
    sleep 0.1
  done
  return 1
}

stop_panel_server() {
  local pid
  pid=$(panel_server_pid)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  return 0
}

# cmux_panel_surfaces <key>: refs of browser surfaces in this cmux workspace that show that pane's panel.
cmux_panel_surfaces() {
  local pattern
  pattern="/p/$(printf '%s' "$1" | sed 's/\./\\./g')([?/[:space:]]|$)"
  cmux tree ${CMUX_WORKSPACE_ID:+--workspace "$CMUX_WORKSPACE_ID"} 2>/dev/null \
    | grep '\[browser\]' | grep -E "$pattern" \
    | sed -n 's/.*surface \(surface:[0-9][0-9]*\) .*/\1/p'
}
