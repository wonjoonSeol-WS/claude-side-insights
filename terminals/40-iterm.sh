# iTerm2: the terminal panel (claude-activity) in a split to the right, through iTerm's AppleScript.
PANE_ENV=ITERM_SESSION_ID

term_detect() { [ "${TERM_PROGRAM:-}" = iTerm.app ] && [ -n "${ITERM_SESSION_ID:-}" ]; }

term_open() {
  osascript - "${ITERM_SESSION_ID#*:}" "$(panel_view_command "$1")" <<'OSA' >/dev/null 2>&1
on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if unique id of s is item 1 of argv then
            tell s to split vertically with default profile command (item 2 of argv)
            return
          end if
        end repeat
      end repeat
    end repeat
  end tell
end run
OSA
}

term_find() {
  local id tty
  osascript <<'OSA' 2>/dev/null | while read -r id tty; do
tell application "iTerm2"
  set found to {}
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set end of found to (unique id of s) & " " & (tty of s)
      end repeat
    end repeat
  end repeat
  set AppleScript's text item delimiters to linefeed
  return found as text
end tell
OSA
    ps -o command= -t "${tty#/dev/}" 2>/dev/null | awk -v want="side_insights activity $1" \
      'substr($0, length($0) - length(want) + 1) == want { found = 1 } END { exit !found }' && printf '%s\n' "${tty#/dev/}"
  done
}

term_close() {
  ps -o pid=,command= -t "$1" 2>/dev/null | awk '/side_insights activity/ {print $1}' | xargs kill 2>/dev/null
}
