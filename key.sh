# Shared by the activity-panel hooks. panel_key <hook-json>: cmux panel, else Orca pane, else Claude session id.
panel_key() {
  local raw="${CMUX_PANEL_ID:-}"
  [ -n "$raw" ] || raw="${ORCA_PANE_KEY:-}"
  [ -n "$raw" ] || raw=$(printf '%s' "$1" | jq -r '.session_id // empty' 2>/dev/null)
  [ -n "$raw" ] || return 0
  printf '%s' "$raw" | tr -c 'A-Za-z0-9_.-' '_' | tail -c 80
}

panel_port() { printf '%s' "${CLAUDE_PANEL_PORT:-47821}"; }

ensure_panel_server() {
  local port; port=$(panel_port)
  if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    nohup /usr/bin/python3 "$HOME/.claude/activity-panel/server.py" >> "$HOME/.claude/activity-panel/server.log" 2>&1 &
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
      (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && return 0
      sleep 0.1
    done
  fi
}

# cmux_panel_surfaces <key>: refs of browser surfaces in this cmux workspace showing that pane's panel.
cmux_panel_surfaces() {
  cmux tree --workspace "${CMUX_WORKSPACE_ID:-}" 2>/dev/null \
    | grep '\[browser\]' | grep -F "/p/$1" \
    | sed -n 's/.*surface \(surface:[0-9][0-9]*\) .*/\1/p'
}

stop_panel_server() {
  local pids
  pids=$(lsof -t -nP -iTCP:"$(panel_port)" -sTCP:LISTEN 2>/dev/null)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  return 0
}
