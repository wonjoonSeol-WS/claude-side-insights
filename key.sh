
PANEL_DIR="$HOME/.claude/activity-panel"

# panel_key <hook-json>: the first PANE_ENV set by a terminal adapter, else the Claude session id. Same rule as common.pane_key.
panel_key() {
  local raw="" f
  for f in "$PANEL_DIR"/terminals/*.sh; do
    [ -n "$raw" ] && break
    raw=$(PANE_ENV=""; . "$f"; [ -n "$PANE_ENV" ] && eval "printf '%s' \"\${$PANE_ENV:-}\"")
  done
  [ -n "$raw" ] || raw=$(printf '%s' "$1" | jq -r '.session_id // empty' 2>/dev/null)
  [ -n "$raw" ] || return 0
  printf '%s' "$raw" | LC_ALL=C tr -c 'A-Za-z0-9_.-' '_' | tail -c 80 | sed 's/^[.-]/_/'
}

panel_port() { printf '%s' "${CLAUDE_PANEL_PORT:-47821}"; }

panel_server_pid() {
  curl -s -m 1 "http://127.0.0.1:$(panel_port)/health" 2>/dev/null | jq -r 'select(.app == "claude-panel") | .pid' 2>/dev/null
}

panel_token() { cat "$PANEL_DIR/token" 2>/dev/null; }

panel_url() { printf 'http://127.0.0.1:%s/p/%s?t=%s' "$(panel_port)" "$1" "$(panel_token)"; }

ensure_panel_server() {
  [ -n "$(panel_server_pid)" ] && return 0
  (umask 077; /usr/bin/python3 "$PANEL_DIR/detach.py" server.py </dev/null >> "$PANEL_DIR/server.log" 2>&1 &)
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
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

panel_view_title() { printf 'claude-panel:%s' "$1"; }

panel_view_command() { printf '/usr/bin/python3 %s/viewer.py %s' "$PANEL_DIR" "$1"; }

# panel_terminal: the adapter file for the terminal this shell runs in; fails when none matches.
panel_terminal() {
  local f
  for f in "$PANEL_DIR"/terminals/*.sh; do
    ( . "$f"; term_detect ) && { printf '%s' "$f"; return 0; }
  done
  return 1
}

# panel_term <action> [args]: runs term_<action> of this terminal's adapter. 2 = no adapter, 3 = adapter lacks the action.
panel_term() {
  local f
  f=$(panel_terminal) || return 2
  ( . "$f"; type "term_$1" >/dev/null 2>&1 || exit 3; action="term_$1"; shift; "$action" "$@" )
}

panel_term_has() {
  local f
  f=$(panel_terminal) || return 1
  ( . "$f"; type "term_$1" >/dev/null 2>&1 )
}
