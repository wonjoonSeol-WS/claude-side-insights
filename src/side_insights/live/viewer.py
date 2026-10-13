#!/usr/bin/env python3
"""Flow, live activity and Q&A of one pane as a terminal UI.

usage: python3 -m side_insights activity [pane]   (default: this pane)
keys: 1 Flow, 2 Live, 3 Q&A, ←/→ flow steps, ↑/↓ scroll, o open the full panel in the browser, q quit
"""
import enum
import os
import select
import signal
import subprocess
import sys
import termios
import time
import tty

from side_insights.live import views
from side_insights.live.activity import RUN, ActivityTail
from side_insights.live.term import RESET
from side_insights.paths import KEY_RE, PORT, pane_key, read_token

POLL_SECONDS = 0.1
ANIMATE_SECONDS = 0.15
IDLE_REDRAW_SECONDS = 1
VIEW_TITLE = "claude-panel:"
MARGIN = 2
RIGHT_MARGIN = 1
SCROLL_STEP = 3
ARROWS = {"A": "up", "B": "down", "C": "right", "D": "left"}
OPEN = "/usr/bin/open"
ALT_SCREEN_ON, ALT_SCREEN_OFF = "\033[?1049h", "\033[?1049l"


class Tab(enum.Enum):
    FLOW = "flow"
    LIVE = "live"
    QA = "qa"


TAB_KEYS = {"1": Tab.FLOW, "2": Tab.LIVE, "3": Tab.QA}


class Screen:
    def __init__(self, pane):
        self.pane = pane
        self.tail = ActivityTail(pane)
        self.tab = Tab.LIVE
        self.step = 0
        self.scroll = {tab: 0 for tab in Tab}
        self.tick = 0

    def body(self, cols, rows):
        st = self.tail.state
        if self.tab == Tab.LIVE:
            return views.live_lines(st, self.tick, cols, rows)
        if self.tab == Tab.QA:
            return views.qa_lines(st, self.tick, cols)
        lines, self.step = views.flow_lines(st, self.step, self.tick, cols)
        return lines

    def draw(self):
        cols, rows = os.get_terminal_size()
        cols -= RIGHT_MARGIN + 2 * MARGIN
        head = views.header(TAB_KEYS, self.tab, self.tail.state, self.tick, cols)
        foot = views.footer(self.pane, cols)
        space = max(1, rows - len(head) - 1)
        body = self.body(cols, space)
        top = max(0, min(self.scroll[self.tab], len(body) - space))
        self.scroll[self.tab] = top
        visible = [" " * MARGIN + line for line in (head + body[top:top + space] + [""] * space)[:rows - 1] + [foot]]
        sys.stdout.write("\033[H" + "\r\n".join(line + RESET + "\033[K" for line in visible) + "\033[J")
        sys.stdout.flush()

    def key(self, key):
        if key in TAB_KEYS:
            self.tab = TAB_KEYS[key]
        elif key in ("up", "k"):
            self.scroll[self.tab] = max(0, self.scroll[self.tab] - SCROLL_STEP)
        elif key in ("down", "j"):
            self.scroll[self.tab] += SCROLL_STEP
        elif key in ("left", "right") and self.tab == Tab.FLOW:
            self.step += 1 if key == "right" else -1
            self.scroll[Tab.FLOW] = 0
        elif key == "o":
            url = f"http://127.0.0.1:{PORT}/p/{self.pane}?t={read_token() or ''}&full=1&mode={self.tab.value}"
            try:
                subprocess.Popen([OPEN, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except OSError:
                pass
        elif key == "q":
            raise SystemExit(0)
        else:
            return False
        return True


class Keys:
    """Splits terminal input into keys; an arrow's escape sequence may arrive across two reads."""

    def __init__(self, fd):
        self.fd, self.pending = fd, ""

    def read(self):
        data = self.pending + os.read(self.fd, 32).decode("utf-8", "ignore")
        self.pending, keys, i = "", [], 0
        while i < len(data):
            if data[i] == "\033" and len(data) - i < 3:
                self.pending = data[i:]
                break
            if data[i] == "\033" and data[i + 1] == "[" and data[i + 2] in ARROWS:
                keys.append(ARROWS[data[i + 2]])
                i += 3
            else:
                keys.append(data[i])
                i += 1
        return keys


def main():
    pane = sys.argv[1] if len(sys.argv) > 1 else pane_key()
    if not pane or not KEY_RE.match(pane):
        sys.exit(__doc__)
    screen = Screen(pane)
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd) if os.isatty(fd) else None
    keys = Keys(fd)

    def restore_terminal(*_):
        if saved:
            termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        os.write(sys.stdout.fileno(), f"{ALT_SCREEN_OFF}\033[?25h{RESET}".encode())
        os._exit(0)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, restore_terminal)
    resized = [True]
    signal.signal(signal.SIGWINCH, lambda *_: resized.__setitem__(0, True))
    if saved:
        tty.setcbreak(fd)
    sys.stdout.write(f"\033]2;{VIEW_TITLE}{pane}\007{ALT_SCREEN_ON}\033[?25l\033[2J")
    last_draw = 0.0
    try:
        while True:
            changed = screen.tail.refresh()
            pressed = False
            if saved:
                if select.select([fd], [], [], POLL_SECONDS)[0]:
                    pressed = any(screen.key(k) for k in keys.read())
            else:
                time.sleep(POLL_SECONDS)
            st = screen.tail.state
            animating = st.busy or any(tool["state"] == RUN for tool in st.tools.values())
            since = time.time() - last_draw
            if pressed or changed or resized[0] or (animating and since > ANIMATE_SECONDS) or since > IDLE_REDRAW_SECONDS:
                resized[0] = False
                screen.tick += 1
                try:
                    screen.draw()
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    print(f"side-insights: draw failed: {exc!r}", file=sys.stderr)
                last_draw = time.time()
    finally:
        restore_terminal()


if __name__ == "__main__":
    main()
