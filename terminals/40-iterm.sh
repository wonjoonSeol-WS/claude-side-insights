# iTerm2: the live view (claude-activity) in a split to the right, through iTerm's AppleScript.
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
  osascript - "$(panel_view_title "$1")" <<'OSA' 2>/dev/null
on run argv
  set found to {}
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if name of s contains item 1 of argv then set end of found to unique id of s
        end repeat
      end repeat
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  return found as text
end run
OSA
}

term_close() {
  osascript - "$1" <<'OSA' >/dev/null 2>&1
on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if unique id of s is item 1 of argv then close s
        end repeat
      end repeat
    end repeat
  end tell
end run
OSA
}
