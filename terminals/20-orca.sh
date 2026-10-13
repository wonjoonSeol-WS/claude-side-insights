# Orca: the panel page in a browser tab. Orca has no command to close a tab.
PANE_ENV=ORCA_PANE_KEY
CHILD_ENV_PREFIX=ORCA_

term_detect() { [ -n "${ORCA_PANE_KEY:-}" ] && command -v orca >/dev/null 2>&1; }

term_open() { orca tab create --url "$2" --json >/dev/null 2>&1; }

term_find() {
  orca tab list --json 2>/dev/null | grep -qE "/p/$(printf '%s' "$1" | sed 's/\./\\./g')([?\"]|$)" && printf '%s\n' "$1"
}
