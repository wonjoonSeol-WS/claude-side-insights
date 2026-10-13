# Shared helpers for the hooks, the bin/ commands and the terminal adapters. Sourced, not run.
: "${PANEL_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}"
PANEL_DATA="${SIDE_INSIGHTS_DATA:-$HOME/.claude/side-insights}"
PANEL_PYTHON=/usr/bin/python3
PANEL_APP=side-insights
PANEL_DEFAULT_PORT=47821

panel_py() { PYTHONPATH="$PANEL_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" "$PANEL_PYTHON" -m side_insights "$@"; }

# panel_missing: names of required tools that are not installed, space separated; empty when all are there.
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

# panel_key <hook-json>: the first PANE_ENV set by a terminal adapter, else the hook's session id, else
# CLAUDE_CODE_SESSION_ID. Sanitised the same way as side_insights.paths.pane_key.
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

# panel_link <key>: a link to the full panel. Once the pane has a log, a 16-character prefix is enough for the server.
panel_link() {
  local key="$1"
  [ -f "$PANEL_DATA/logs/$key.jsonl" ] && key=$(printf '%s' "$key" | cut -c1-16)
  printf '%s&full=1' "$(panel_url "$key")"
}

# ensure_panel_server: starts the server, or restarts one that runs code from another install of the plugin.
ensure_panel_server() {
  local health pid root i
  health=$(panel_health)
  pid=$(printf '%s' "$health" | jq -r 'select(.app == "side-insights" or .app == "claude-panel") | .pid // empty' 2>/dev/null)
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
    [ -n "$(panel_health | jq -r 'select(.app == "side-insights") | .pid // empty' 2>/dev/null)" ] && return 0
    sleep 0.1
  done
  return 1
}

panel_view_title() { printf 'claude-panel:%s' "$1"; }

panel_view_command() { printf '%q %q' "$PANEL_ROOT/bin/claude-activity" "$1"; }

# panel_terminal: the adapter file for the terminal this shell runs in; fails when none matches.
panel_terminal() {
  local f
  for f in "$PANEL_ROOT"/terminals/*.sh; do
    ( . "$f"; term_detect ) && { printf '%s' "$f"; return 0; }
  done
  return 1
}

# panel_adapter <adapter-file> <action> [args]: runs term_<action> of that adapter. 3 = the adapter lacks the action.
panel_adapter() {
  local f="$1"
  shift
  ( . "$f"; type "term_$1" >/dev/null 2>&1 || exit 3; action="term_$1"; shift; "$action" "$@" )
}

# panel_term <action> [args]: the same, for this terminal's adapter. 2 = no adapter.
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
