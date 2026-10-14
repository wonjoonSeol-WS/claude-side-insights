"""Run a real Claude Code in a pseudo terminal, send keys, and save the screen as JSON for paint.py.

usage: drive.py COLS ROWS PANE_KEY OUT.json [keys...]
Keys are sent as typed; "sleep:N" waits N seconds. Escapes like \\r and \\x1b work.
Env: CLAUDE_ARGS (extra arguments, space separated), CAPTURE_CWD (working folder, default the current one), CLAUDE_BIN (default ~/.local/bin/claude, else `claude`).
"""
import fcntl
import json
import os
import pty
import select
import struct
import sys
import termios
import time

import pyte

cols, rows, key, out, keys = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5:]
base = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE_CODE_", "CMUX", "ORCA", "ITERM"))}
env = dict(base, CMUX_PANEL_ID=key, TERM="xterm-256color", COLORTERM="truecolor", COLUMNS=str(cols), LINES=str(rows))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(os.environ.get("CAPTURE_CWD", os.getcwd()))
    os.execvpe(os.environ.get("CLAUDE_BIN") or next((p for p in [os.path.expanduser("~/.local/bin/claude")] if os.path.exists(p)), "claude"), ["claude", *os.environ.get("CLAUDE_ARGS", "").split()], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
screen = pyte.Screen(cols, rows)
stream = pyte.ByteStream(screen)


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                stream.feed(os.read(fd, 65536))
            except OSError:
                return


pump(8)
for k in keys:
    if k.startswith("sleep:"):
        pump(float(k[6:]))
        continue
    try:
        os.write(fd, k.encode().decode("unicode_escape").encode() if k.isascii() else k.encode("utf-8"))
    except OSError:
        print("claude exited before all keys were sent", file=sys.stderr)
        break
    pump(0.4)
pump(4)
cells = [[[c.data, c.fg, c.bg, c.bold, c.reverse] for c in (screen.buffer[y][x] for x in range(cols))] for y in range(rows)]
with open(out, "w") as fh:
    json.dump(cells, fh)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
