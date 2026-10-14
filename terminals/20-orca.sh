# Orca: the terminal panel (si-activity) in a split next to Claude, through the orca CLI.
PANE_ENV=ORCA_PANE_KEY
CHILD_ENV_PREFIX=ORCA_

term_detect() { [ -n "${ORCA_TERMINAL_HANDLE:-}" ] && command -v orca >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; }

_orca_saved() { printf '%s/terminals/orca-%s' "$PANEL_DATA" "$1"; }

term_open() {
  local handle
  handle=$(orca terminal split --terminal "$ORCA_TERMINAL_HANDLE" --direction vertical \
    --command "$(panel_view_command "$1")" --json 2>/dev/null | jq -r '.result.split.handle // empty')
  [ -n "$handle" ] || return 1
  mkdir -p "$PANEL_DATA/terminals"
  printf '%s\n' "$handle" > "$(_orca_saved "$1")"
}

term_find() {
  local saved found
  saved=$(cat "$(_orca_saved "$1")" 2>/dev/null)
  found=$(orca terminal list --json 2>/dev/null | jq -r --arg saved "$saved" --arg title "$(panel_view_title "$1")" \
    '(.result.terminals // [])[] | select(.connected and (.handle == $saved or .title == $title)) | .handle' 2>/dev/null)
  [ -n "$saved" ] && ! printf '%s\n' "$found" | grep -qxF "$saved" && rm -f "$(_orca_saved "$1")"
  [ -n "$found" ] && printf '%s\n' "$found"
  return 0
}

term_close() { orca terminal close --terminal "$1" --json >/dev/null 2>&1; }
