# Sourced by the hooks, the bin/ commands and the terminal adapters.
: "${PANEL_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}"
PANEL_DATA="${SIDE_INSIGHTS_DATA:-$HOME/.claude/side-insights}"
PANEL_PYTHON=/usr/bin/python3
PANEL_APP=side-insights
PANEL_DEFAULT_PORT=47821

panel_py() { PYTHONPATH="$PANEL_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" "$PANEL_PYTHON" -m side_insights "$@"; }

panel_missing() {
  local missing=""
  # Without the Command Line Tools, macOS /usr/bin/python3 is a stub that pops an install dialog, so check first.
  if [ "$(uname -s)" = Darwin ]; then
    if ! xcode-select -p >/dev/null 2>&1 || ! "$PANEL_PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
      missing="python3 (xcode-select --install)"
    fi
  elif ! "$PANEL_PYTHON" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
    missing="python3 3.9+ at $PANEL_PYTHON"
  fi
  command -v jq >/dev/null 2>&1 || missing="${missing:+$missing, }jq"
  command -v curl >/dev/null 2>&1 || missing="${missing:+$missing, }curl"
  printf '%s' "$missing"
}

# Must sanitise the same way as side_insights.paths.pane_key and paneKey in hooks/mod/data.ts.
panel_key() {
  local raw="" name
  for name in $(sed -n 's/^PANE_ENV=\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*$/\1/p' "$PANEL_ROOT"/terminals/*.sh); do
    eval "raw=\"\${$name:-}\""
    [ -n "$raw" ] && break
  done
  [ -n "$raw" ] || raw=$(printf '%s' "$1" | jq -r '.session_id // empty' 2>/dev/null)
  [ -n "$raw" ] || raw="${CLAUDE_CODE_SESSION_ID:-}"
  [ -n "$raw" ] || return 0
  printf '%s' "$raw" | LC_ALL=C tr -c 'A-Za-z0-9_.-' '_' | tail -c 80 | sed 's/^[.-]/_/'
}

panel_port() {
  local port="${SIDE_INSIGHTS_PORT:-${CLAUDE_PANEL_PORT:-}}"
  case "$port" in
    ''|*[!0-9]*) port=$PANEL_DEFAULT_PORT ;;
  esac
  { [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; } && port=$PANEL_DEFAULT_PORT
  printf '%s' "$port"
}

panel_health() { curl -s -m 1 "http://127.0.0.1:$(panel_port)/health" 2>/dev/null; }

panel_token() { cat "$PANEL_DATA/token" 2>/dev/null; }

panel_url() { printf 'http://127.0.0.1:%s/p/%s?t=%s' "$(panel_port)" "$1" "$(panel_token)"; }

# Once the pane has a log, the server accepts a 16-character key prefix.
panel_link() {
  local key="$1"
  [ -f "$PANEL_DATA/logs/$key.jsonl" ] && key=$(printf '%s' "$key" | cut -c1-16)
  printf '%s&full=1' "$(panel_url "$key")"
}

ensure_panel_server() {
  local health pid root i
  health=$(panel_health)
  pid=$(printf '%s' "$health" | jq -r --arg app "$PANEL_APP" 'select(.app == $app or .app == "claude-panel") | .pid // empty' 2>/dev/null)
  root=$(printf '%s' "$health" | jq -r '.root // empty' 2>/dev/null)
  [ -n "$pid" ] && [ "$root" = "$PANEL_ROOT" ] && return 0
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    for i in 1 2 3 4 5 6 7 8 9 10; do
      [ -z "$(panel_health)" ] && break
      sleep 0.2
    done
  fi
  mkdir -p "$PANEL_DATA" && chmod 700 "$PANEL_DATA"
  (umask 077; panel_py detach server </dev/null >> "$PANEL_DATA/server.log" 2>&1 &)
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    [ -n "$(panel_health | jq -r --arg app "$PANEL_APP" 'select(.app == $app) | .pid // empty' 2>/dev/null)" ] && return 0
    sleep 0.1
  done
  return 1
}

panel_view_title() { printf 'si-panel:%s' "$1"; }

panel_view_command() { printf '%q %q' "$PANEL_ROOT/bin/si-activity" "$1"; }

panel_terminal() {
  local f
  for f in "$PANEL_ROOT"/terminals/*.sh; do
    ( . "$f"; term_detect ) && { printf '%s' "$f"; return 0; }
  done
  return 1
}

# Exit 3: the adapter has no term_<action>.
panel_adapter() {
  local f="$1"
  shift
  ( . "$f"; type "term_$1" >/dev/null 2>&1 || exit 3; action="term_$1"; shift; "$action" "$@" )
}

# Exit 2: no adapter matches this terminal.
panel_term() {
  local f
  f=$(panel_terminal) || return 2
  panel_adapter "$f" "$@"
}

panel_term_has() {
  local f
  f=$(panel_terminal) || return 1
  ( . "$f"; type "term_$1" >/dev/null 2>&1 )
}
