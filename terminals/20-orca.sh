# Orca: the live view (claude-activity) in a split next to Claude, through the orca CLI.
PANE_ENV=ORCA_PANE_KEY
CHILD_ENV_PREFIX=ORCA_

term_detect() { [ -n "${ORCA_TERMINAL_HANDLE:-}" ] && command -v orca >/dev/null 2>&1; }

term_open() {
  orca terminal split --terminal "$ORCA_TERMINAL_HANDLE" --direction horizontal --command "$(panel_view_command "$1")" --json >/dev/null 2>&1
}

term_find() {
  orca terminal list --json 2>/dev/null | jq -r --arg title "$(panel_view_title "$1")" \
    '.result.terminals[] | select(.title == $title and .connected) | .handle'
}

term_close() { orca terminal close --terminal "$1" --json >/dev/null 2>&1; }
