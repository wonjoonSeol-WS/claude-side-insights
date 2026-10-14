#!/usr/bin/env python3
"""Flow, live activity and Q&A of one pane as a terminal UI.

usage: python3 -m side_insights activity [pane]   (default: this pane)
keys: press ? in the panel for the full list
"""
import enum
import os
import select
import signal
import sys
import termios
import time
import tty

from side_insights.analysis import flow_store
from side_insights.analysis.qa_store import Status
from side_insights.i18n import t
from side_insights.live import client, views
from side_insights.live.activity import RUN, ActivityTail
from side_insights.live.term import GREEN, MUTED, ORANGE, RED, RESET, TEXT, box, inner_width, key_cap, paint, styled, visible_width
from side_insights.paths import KEY_RE, PORT, pane_key, read_token
from side_insights.system import open_url

POLL_SECONDS = 0.1
ANIMATE_SECONDS = 0.15
IDLE_REDRAW_SECONDS = 1
VIEW_TITLE = "si-panel:"
MARGIN = 2
RIGHT_MARGIN = 1
SCROLL_STEP = 3
TOAST_SECONDS = 2.5
CONFIRM_SECONDS = 3
AUTOPLAY_SECONDS = 2.5
ARROWS = {"A": "up", "B": "down", "C": "right", "D": "left"}
ESC = "esc"
ALT_SCREEN_ON, ALT_SCREEN_OFF = "\033[?1049h", "\033[?1049l"
STATUS_CYCLE = {Status.ANSWERED.value: Status.PARTIAL.value, Status.PARTIAL.value: Status.UNANSWERED.value,
                Status.UNANSWERED.value: Status.ANSWERED.value}
SCOPE_OPEN = "open"
HELP_OPEN = ("h", "?")
HELP_KEYS = [("1 2 3", "k_tabs"), ("h  ?", "k_help"), ("Esc", "k_escape"), ("q", "term_h_quit"), ("o", "term_h_open"),
             ("↑↓  j k", "term_h_scroll"), ("[ ]", "term_h_flows"), ("← →", "k_steps"), ("p", "term_h_autoplay"),
             ("r", "term_h_recheck"), ("s", "term_h_status"), ("S", "term_h_auto"), ("a", "term_h_archive"),
             ("c", "term_h_copy"), ("R", "term_h_recheck_open"), ("f", "term_h_filter_open"), ("v", "term_h_archived")]


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
        self.flow = 0
        self.scroll = {tab: 0 for tab in Tab}
        self.tick = 0
        self.help = False
        self.selected = None
        self.rows = []
        self.open_only = False
        self.show_archived = False
        self.toast = None
        self.confirm = None
        self.playing_since = None

    def say(self, text, color=TEXT):
        self.toast = (text, color, time.time() + TOAST_SECONDS)

    def body(self, cols, rows):
        st = self.tail.state
        if self.tab == Tab.LIVE:
            return views.live_lines(st, self.tick, cols, rows)
        if self.tab == Tab.QA:
            lines, self.rows = views.qa_lines(st, self.tick, cols, self.selected, self.open_only, self.show_archived)
            return lines
        lines, self.flow, self.step = views.flow_lines(st, self.flow, self.step, self.tick, cols)
        return lines

    def help_lines(self, cols):
        key_w = max(visible_width(k) for k, _ in HELP_KEYS) + 3
        rows = []
        for k, label in HELP_KEYS:
            text = styled(t(label, pane=self.pane), inner_width(cols), TEXT, indent=key_w)
            rows += [key_cap(k) + text[0][visible_width(k) + 2:], *text[1:]]
        return box(rows, cols, MUTED, paint(t("help_keys", pane=self.pane), TEXT, bold=True))

    def keep_selection_visible(self, space):
        row = next((r for r in self.rows if r.key == self.selected), None)
        if row:
            top = self.scroll[Tab.QA]
            if row.start < top:
                self.scroll[Tab.QA] = row.start
            elif row.end > top + space:
                self.scroll[Tab.QA] = max(row.start, row.end - space)

    def draw(self):
        cols, rows = os.get_terminal_size()
        cols -= RIGHT_MARGIN + 2 * MARGIN
        head = views.header(TAB_KEYS, self.tab, self.tail.state, self.tick, cols)
        toast = self.toast[:2] if self.toast and self.toast[2] > time.time() else None
        space = max(1, rows - len(head) - 1)
        body = self.help_lines(cols) if self.help else self.body(cols, space)
        hidden = views.idle_keys(self.tab.value, len(flow_store.records(self.pane)), self.rows)
        foot = views.footer(self.pane, cols, self.tab.value, toast, hidden)
        if self.tab == Tab.QA and not self.help:
            self.keep_selection_visible(space)
        top = max(0, min(self.scroll[self.tab], len(body) - space))
        if not self.help:
            self.scroll[self.tab] = top
        visible = [" " * MARGIN + line for line in (head + body[(0 if self.help else top):][:space] + [""] * space)[:rows - 1] + [foot]]
        sys.stdout.write("\033[H" + "\r\n".join(line + RESET + "\033[K" for line in visible) + "\033[J")
        sys.stdout.flush()

    def selected_row(self):
        return next((r for r in self.rows if r.key == self.selected), None)

    def move_selection(self, delta):
        if not self.rows:
            return False
        keys = [r.key for r in self.rows]
        index = keys.index(self.selected) + delta if self.selected in keys else (0 if delta > 0 else len(keys) - 1)
        self.selected = keys[max(0, min(index, len(keys) - 1))]
        return True

    def confirmed(self, key):
        """Paid actions run on the second press within CONFIRM_SECONDS."""
        if self.confirm and self.confirm[0] == key and self.confirm[1] > time.time():
            self.confirm = None
            return True
        self.confirm = (key, time.time() + CONFIRM_SECONDS)
        self.say(t("term_confirm", key, pane=self.pane), ORANGE)
        return False

    def run(self, action, done_text):
        try:
            action()
            self.say(done_text, GREEN)
        except client.ServerError as exc:
            self.say(t("term_failed", exc.message or t("server_down", pane=self.pane), pane=self.pane), RED)

    def qa_key(self, key):
        row = self.selected_row()
        item = row.item if row else None
        if key == "f":
            self.open_only = not self.open_only
            self.say(f"{t('qa_open_only', pane=self.pane)}: {t('on' if self.open_only else 'off', pane=self.pane)}")
        elif key == "v":
            self.show_archived = not self.show_archived
            self.say(f"{t('qa_archived', pane=self.pane)}: {t('on' if self.show_archived else 'off', pane=self.pane)}")
        elif key == "R":
            if self.confirmed(key):
                turns = list(dict.fromkeys(r.turn.get("turn_id") for r in self.rows if r.turn.get("turn_id")))
                self.run(lambda: client.regen(self.pane, "qa", scope=SCOPE_OPEN, turns=turns), t("qa_checking", pane=self.pane))
        elif not row:
            self.say(t("term_no_item", pane=self.pane), ORANGE)
        elif key == "r":
            if self.confirmed(key):
                if item:
                    self.run(lambda: client.regen(self.pane, "qa", item=item["id"]), t("qa_checking", pane=self.pane))
                else:
                    self.run(lambda: client.regen(self.pane, "qa", turn=row.turn.get("turn_id")), t("qa_checking", pane=self.pane))
        elif not item:
            self.say(t("term_no_item", pane=self.pane), ORANGE)
        elif key == "s":
            status = STATUS_CYCLE.get(item.get("status"), Status.ANSWERED.value)
            self.run(lambda: client.set_status(self.pane, item["id"], status),
                     t("term_status_set", t("st_" + status, pane=self.pane), pane=self.pane))
        elif key == "S":
            self.run(lambda: client.set_status(self.pane, item["id"], None), t("term_status_auto", pane=self.pane))
        elif key == "a":
            archived = not item.get("archived")
            self.run(lambda: client.set_archived(self.pane, item["id"], archived),
                     t("term_archived" if archived else "term_restored", pane=self.pane))
        elif key == "c":
            ok = client.copy_question(self.pane, item.get("question"))
            self.say(t("copy_done" if ok else "copy_failed", pane=self.pane), GREEN if ok else RED)
        else:
            return False
        return True

    def flow_key(self, key):
        if key in ("[", "]"):
            self.flow += 1 if key == "]" else -1
            self.step, self.scroll[Tab.FLOW] = 0, 0
        elif key in ("left", "right"):
            self.step += 1 if key == "right" else -1
            self.scroll[Tab.FLOW] = 0
        elif key == "p":
            self.playing_since = None if self.playing_since else time.time()
        elif key == "r":
            if self.confirmed(key):
                self.run(lambda: client.regen(self.pane, "flow"), t("flow_started", pane=self.pane))
        else:
            return False
        return True

    def autoplay(self):
        """Advances one step every AUTOPLAY_SECONDS; stops after the last step."""
        if not self.playing_since or self.tab != Tab.FLOW or time.time() - self.playing_since < AUTOPLAY_SECONDS:
            return False
        records = flow_store.records(self.pane)
        steps = ((records[min(self.flow, len(records) - 1)].get("flow") or {}).get("steps") or []) if records else []
        if self.step + 1 >= len(steps):
            self.playing_since = None
            return False
        self.step += 1
        self.scroll[Tab.FLOW] = 0
        self.playing_since = time.time()
        return True

    def key(self, key):
        if key != "p":
            self.playing_since = None
        if self.help:
            if key in (*HELP_OPEN, ESC, "q"):
                self.help = False
                return True
            return False
        if key in HELP_OPEN:
            self.help = True
        elif key in TAB_KEYS:
            self.tab = TAB_KEYS[key]
        elif key in ("up", "k", "down", "j"):
            down = key in ("down", "j")
            if not (self.tab == Tab.QA and self.move_selection(1 if down else -1)):
                self.scroll[self.tab] = max(0, self.scroll[self.tab] + (SCROLL_STEP if down else -SCROLL_STEP))
        elif key == "o":
            url = f"http://127.0.0.1:{PORT}/p/{self.pane}?t={read_token() or ''}&full=1&mode={self.tab.value}"
            try:
                open_url(url)
            except OSError:
                pass
        elif key == "q":
            raise SystemExit(0)
        elif self.tab == Tab.QA:
            return self.qa_key(key)
        elif self.tab == Tab.FLOW:
            return self.flow_key(key)
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
            if data[i:] == "\033":
                keys.append(ESC)
                break
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
            stepped = screen.autoplay()
            animating = st.busy or screen.playing_since or (screen.toast and screen.toast[2] > time.time()) \
                or any(tool["state"] == RUN for tool in st.tools.values())
            since = time.time() - last_draw
            if pressed or changed or stepped or resized[0] or (animating and since > ANIMATE_SECONDS) or since > IDLE_REDRAW_SECONDS:
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
