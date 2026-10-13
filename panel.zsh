# Claude activity / logic-flow panel helpers (cmux + Orca).
#   claude-panel              show/hide the right-hand panel for this pane (toggle)
#   claude-flow [all]         open this pane's panel (or the all-panes index) full page in the default browser
#   claude-activity           live tool/file view as a terminal UI in this pane

_claude_panel_dir="$HOME/.claude/activity-panel"

_claude_panel_key() {
  ( . "$_claude_panel_dir/key.sh"; panel_key "{}" )
}

claude-panel() {
  local key surfaces s
  key=$(_claude_panel_key)
  if [[ -n "${CMUX_SURFACE_ID:-}" ]]; then
    surfaces=$( . "$_claude_panel_dir/key.sh"; cmux_panel_surfaces "$key" )
    if [[ -n "$surfaces" ]]; then
      for s in ${(f)surfaces}; do cmux close-surface --surface "$s" >/dev/null; done
      print "panel hidden (run claude-panel to show)"
      return
    fi
    "$_claude_panel_dir/open-panel.sh" --force </dev/null
    surfaces=$( . "$_claude_panel_dir/key.sh"; cmux_panel_surfaces "$key" )
    [[ -n "$surfaces" ]] && print "panel shown" || { print -u2 "could not open the panel"; return 1 }
    return
  fi
  "$_claude_panel_dir/open-panel.sh" --force </dev/null && print "panel requested (Orca tab)"
}

claude-flow() {
  ( . "$_claude_panel_dir/key.sh"; ensure_panel_server )
  local port="${CLAUDE_PANEL_PORT:-47821}" key
  key=$(_claude_panel_key)
  if [[ "$1" == all || -z "$key" ]]; then
    open "http://127.0.0.1:$port/"
  else
    open "http://127.0.0.1:$port/p/$key"
  fi
}

claude-activity() {
  /usr/bin/python3 "$_claude_panel_dir/viewer.py" "${1:-$(_claude_panel_key)}"
}
