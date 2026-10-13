# cmux: the panel page in a browser split to the right.
PANE_ENV=CMUX_PANEL_ID
CHILD_ENV_PREFIX=CMUX_

term_detect() { [ -n "${CMUX_SURFACE_ID:-}" ] && command -v cmux >/dev/null 2>&1; }

term_open() { cmux browser open-split "$2" >/dev/null 2>&1; }

term_find() {
  local pattern
  pattern="/p/$(printf '%s' "$1" | sed 's/\./\\./g')([?/[:space:]]|$)"
  if [ -n "${CMUX_WORKSPACE_ID:-}" ]; then
    cmux tree --workspace "$CMUX_WORKSPACE_ID" 2>/dev/null
  else
    cmux tree 2>/dev/null
  fi | grep '\[browser\]' | grep -E "$pattern" | sed -n 's/.*surface \(surface:[0-9][0-9]*\) .*/\1/p'
}

term_close() { cmux close-surface --surface "$1" >/dev/null 2>&1; }
