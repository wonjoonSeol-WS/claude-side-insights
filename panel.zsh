# claude-panel, claude-flow, claude-activity. Sourced from ~/.zshrc by install.sh.

_claude_panel_dir="$HOME/.claude/activity-panel"

_claude_panel_say() {
  /usr/bin/python3 "$_claude_panel_dir/i18n.py" "$@"
}

_claude_panel_key() {
  ( . "$_claude_panel_dir/key.sh"; panel_key "{}" )
}

_claude_panel_term() {
  ( . "$_claude_panel_dir/key.sh"; panel_term "$@" )
}

claude-panel() {
  local key handles h
  key=$(_claude_panel_key)
  [[ -n "$key" ]] || { _claude_panel_say no_pane >&2; return 1 }
  handles=$(_claude_panel_term find "$key")
  if [[ -n "$handles" ]] && ( . "$_claude_panel_dir/key.sh"; panel_term_has close ); then
    for h in ${(f)handles}; do _claude_panel_term close "$h"; done
    _claude_panel_say panel_hidden
    return
  fi
  "$_claude_panel_dir/open-panel.sh" --force </dev/null
  if ! ( . "$_claude_panel_dir/key.sh"; panel_term_has find ); then
    _claude_panel_say panel_requested
  elif [[ -n "$(_claude_panel_term find "$key")" ]]; then
    _claude_panel_say panel_shown
  else
    _claude_panel_say panel_failed >&2
    return 1
  fi
}

claude-flow() {
  local key
  ( . "$_claude_panel_dir/key.sh"; ensure_panel_server )
  key=$(_claude_panel_key)
  if [[ "$1" == all || -z "$key" ]]; then
    open "$( . "$_claude_panel_dir/key.sh"; printf 'http://127.0.0.1:%s/?t=%s' "$(panel_port)" "$(panel_token)" )"
  else
    open "$( . "$_claude_panel_dir/key.sh"; panel_url "$key" )&full=1"
  fi
}

claude-activity() {
  /usr/bin/python3 "$_claude_panel_dir/viewer.py" "$@"
}
