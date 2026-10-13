# Ghostty 1.3+: the terminal panel (si-activity) in a split to the right, through Ghostty's AppleScript.
# The split opens next to the focused terminal, which is the one that just started Claude.

term_detect() { [ "${TERM_PROGRAM:-}" = ghostty ] && [ -z "${CMUX_SURFACE_ID:-}" ] && { [ -d /Applications/Ghostty.app ] || [ -d "$HOME/Applications/Ghostty.app" ]; }; }

term_open() {
  osascript - "$(panel_view_command "$1")" <<'OSA' >/dev/null 2>&1
on run argv
  tell application "Ghostty"
    set cfg to new surface configuration
    set command of cfg to item 1 of argv
    split (focused terminal of selected tab of front window) direction right with configuration cfg
  end tell
end run
OSA
}

term_find() {
  osascript - "$(panel_view_title "$1")" <<'OSA' 2>/dev/null
on run argv
  set found to {}
  tell application "Ghostty"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in terminals of t
          if name of s is item 1 of argv then set end of found to (id of s as text)
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
  tell application "Ghostty"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in terminals of t
          if (id of s as text) is item 1 of argv then close s
        end repeat
      end repeat
    end repeat
  end tell
end run
OSA
}
