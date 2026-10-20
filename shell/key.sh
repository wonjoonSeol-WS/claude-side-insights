# Sourced by the hooks, the bin/ commands and the terminal adapters.
: "${PANEL_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}"
case "${OSTYPE:-}" in
  msys*|cygwin*) PANEL_OS=windows ;;
  darwin*) PANEL_OS=mac ;;
  *) PANEL_OS=other ;;
esac
if [ "$PANEL_OS" = windows ]; then
  PANEL_DATA=$(cygpath -u "${SIDE_INSIGHTS_DATA:-${USERPROFILE:-$HOME}/.claude/side-insights}")
  PANEL_PATHSEP=';'
else
  PANEL_DATA="${SIDE_INSIGHTS_DATA:-$HOME/.claude/side-insights}"
  PANEL_PATHSEP=':'
fi
PANEL_DEFAULT_PORT=47821
PANEL_JQ="${SIDE_INSIGHTS_JQ:-jq}"
PANEL_PYTHON_CACHE="$PANEL_DATA/python-path"
PANEL_PYTHON_RETRY_MINUTES=10
PANEL_PYTHON_OK='import sys; sys.exit(sys.version_info < (3, 9))'
PANEL_PYTHON_WHERE='import sys; sys.exit(1) if sys.version_info < (3, 9) else print(sys.executable)'
PANEL_PYTHON="${SIDE_INSIGHTS_PYTHON:-}"

panel_native() { if [ "$PANEL_OS" = windows ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
PANEL_SRC=$(panel_native "$PANEL_ROOT/src")

# The Microsoft Store `python3` placeholder fails the version check and is skipped.
panel_find_python() {
  local candidate found
  if [ "$PANEL_OS" = mac ]; then
    xcode-select -p >/dev/null 2>&1 && /usr/bin/python3 -c "$PANEL_PYTHON_OK" 2>/dev/null && printf /usr/bin/python3
    return 0
  fi
  if [ -f "$PANEL_PYTHON_CACHE" ]; then
    found=$(cat "$PANEL_PYTHON_CACHE" 2>/dev/null)
    if [ "$found" = - ]; then
      [ -n "$(find "$PANEL_PYTHON_CACHE" -mmin -"$PANEL_PYTHON_RETRY_MINUTES" 2>/dev/null)" ] && return 0
    elif [ -n "$found" ] && [ -x "$found" ]; then
      printf '%s' "$found"
      return 0
    fi
  fi
  found=""
  for candidate in python py python3; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    if [ "$candidate" = py ]; then
      found=$(PYTHONUTF8=1 py -3 -c "$PANEL_PYTHON_WHERE" 2>/dev/null) || continue
    else
      found=$(PYTHONUTF8=1 "$candidate" -c "$PANEL_PYTHON_WHERE" 2>/dev/null) || continue
    fi
    found=$(printf '%s' "$found" | tr -d '\r')
    [ -n "$found" ] || continue
    [ "$PANEL_OS" = windows ] && found=$(cygpath -u "$found")
    break
  done
  mkdir -p -m 700 "$PANEL_DATA" 2>/dev/null && printf '%s' "${found:--}" > "$PANEL_PYTHON_CACHE.${BASHPID:-$$}" && mv -f "$PANEL_PYTHON_CACHE.${BASHPID:-$$}" "$PANEL_PYTHON_CACHE"
  printf '%s' "$found"
}

panel_python() { [ -n "$PANEL_PYTHON" ] || PANEL_PYTHON=$(panel_find_python); }

panel_py() {
  panel_python
  PYTHONUTF8=1 PYTHONPATH="$PANEL_SRC${PYTHONPATH:+$PANEL_PATHSEP$PYTHONPATH}" "$PANEL_PYTHON" -m side_insights "$@"
}

panel_has_jq() { command -v "$PANEL_JQ" >/dev/null 2>&1; }

panel_missing() {
  panel_python
  [ -n "$PANEL_PYTHON" ] && return 0
  case "$PANEL_OS" in
    mac) printf 'python3 (xcode-select --install, or set SIDE_INSIGHTS_PYTHON to a Homebrew python3)' ;;
    windows) printf 'Python 3.9+ (winget install Python.Python.3.12, or python.org)' ;;
    *) printf 'Python 3.9+ (your package manager, for example sudo apt install python3)' ;;
  esac
}

panel_require_python() {
  panel_python
  [ -n "$PANEL_PYTHON" ] || { echo "side-insights needs: $(panel_missing)" >&2; exit 1; }
}

# Must sanitise the same way as side_insights.paths.pane_key and paneKey in hooks/mod/data.ts.
panel_key() {
  local raw="" name
  for name in $(sed -n 's/^PANE_ENV=\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*$/\1/p' "$PANEL_ROOT"/terminals/*.sh); do
    eval "raw=\"\${$name:-}\""
    [ -n "$raw" ] && break
  done
  if [ -z "$raw" ] && panel_has_jq; then
    raw=$(printf '%s' "$1" | "$PANEL_JQ" -r '.session_id // empty' 2>/dev/null | tr -d '\r')
  fi
  [ -n "$raw" ] || raw=$(panel_json_field session_id "$1")
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

panel_token() { cat "$PANEL_DATA/token" 2>/dev/null; }

panel_url() { printf 'http://127.0.0.1:%s/p/%s?t=%s' "$(panel_port)" "$1" "$(panel_token)"; }

# Once the pane has a log, the server accepts a 16-character key prefix.
panel_link() {
  local key="$1"
  [ -f "$PANEL_DATA/logs/$key.jsonl" ] && key=$(printf '%s' "$key" | cut -c1-16)
  printf '%s&full=1' "$(panel_url "$key")"
}

ensure_panel_server() {
  panel_python
  [ -n "$PANEL_PYTHON" ] || return 1
  (umask 077; panel_py ensure-server </dev/null)
}

panel_open_url() { panel_py open-url "$1" </dev/null >/dev/null 2>&1; }

# A top-level string field of a hook payload, without needing jq.
panel_json_field() {
  printf '%s' "$2" | tr -d '\n' | grep -o '"'"$1"'"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*:[[:space:]]*"\(.*\)"$/\1/'
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
