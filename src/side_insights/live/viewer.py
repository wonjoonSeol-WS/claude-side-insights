#!/usr/bin/env python3
"""Flow, live activity and Q&A of one pane as a terminal UI.

usage: python3 -m side_insights activity [pane]   (default: this pane)
keys: 1 Flow, 2 Live, 3 Q&A, ←/→ flow steps, ↑/↓ scroll, o open the full panel in the browser, q quit
"""
import enum
import os
import re
import select
import signal
import subprocess
import sys
import termios
import time
import tty
import unicodedata

from side_insights.analysis import flow_store, qa_store
from side_insights.analysis.runner import Pending
from side_insights.i18n import t
from side_insights.live.activity import ERR, OK, RUN, ActivityTail, tool_label
from side_insights.paths import EDIT_TOOLS, PORT, pane_key, read_token

SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
POLL_SECONDS = 0.1
ANIMATE_SECONDS = 0.2
IDLE_REDRAW_SECONDS = 1
FILES_SHARE = 0.4
MIN_FILE_ROWS = 3
NAME_MIN, NAME_MAX = 6, 14
CLOCK_WIDTH = 9
VIEW_TITLE = "claude-panel:"
RIGHT_MARGIN = 1
SCROLL_STEP = 3
CODE_LINES = 12

DIM, BOLD, RESET, REVERSE = "\033[2m", "\033[1m", "\033[0m", "\033[7m"
RED, GREEN, YELLOW, BLUE, CYAN, MAGENTA = (f"\033[3{n}m" for n in (1, 2, 3, 4, 6, 5))
STATUS_COLOR = {qa_store.Status.ANSWERED.value: GREEN, qa_store.Status.PARTIAL.value: YELLOW,
                qa_store.Status.UNANSWERED.value: RED}
HIGHLIGHT = re.compile(r"==(.+?)==")
MARKUP = re.compile(r"\*\*|`")
ARROWS = {"A": "up", "B": "down", "C": "right", "D": "left"}


class Tab(enum.Enum):
    FLOW = "flow"
    LIVE = "live"
    QA = "qa"


TAB_KEYS = {"1": Tab.FLOW, "2": Tab.LIVE, "3": Tab.QA}


def width(text):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 0 if unicodedata.combining(c) else 1 for c in text)


def _cut(chars, limit):
    out, used = [], 0
    for c in chars:
        if used + width(c) > limit:
            break
        out.append(c)
        used += width(c)
    return out, used


def fit(text, cols):
    if cols <= 0:
        return ""
    if width(text) <= cols:
        return text + " " * (cols - width(text))
    out, used = _cut(text, cols - 1)
    return "".join(out) + "…" + " " * (cols - used - 1)


def fit_left(text, cols):
    if cols <= 0:
        return ""
    if width(text) <= cols:
        return text + " " * (cols - width(text))
    out, used = _cut(reversed(text), cols - 1)
    return "…" + "".join(reversed(out)) + " " * (cols - used - 1)


def wrap(text, cols):
    """Breaks at the last space when there is one, else anywhere (CJK text has no spaces to break at)."""
    lines = []
    for paragraph in (text or "").split("\n"):
        line = ""
        for c in paragraph:
            if width(line + c) > cols and line:
                cut = line.rfind(" ")
                word = line[cut + 1:] + c
                if cut > 0 and width(word) == len(word) and len(word) < cols // 2:
                    lines.append(line[:cut])
                    line = line[cut + 1:]
                else:
                    lines.append(line)
                    line = ""
            line += c
        lines.append(line)
    return lines


def plain(text):
    return MARKUP.sub("", text or "")


def marked(text, cols, indent, color=""):
    """Wraps text; lines that carried ==highlight== markup are shown in yellow."""
    out = []
    for paragraph in plain(text).split("\n"):
        highlighted = bool(HIGHLIGHT.search(paragraph))
        for line in wrap(HIGHLIGHT.sub(r"\1", paragraph), cols - indent):
            out.append(" " * indent + (YELLOW if highlighted else color) + line + RESET)
    return out


def bullets(text, cols):
    out = []
    for line in (text or "").split("\n"):
        line = line.strip().lstrip("-• ").strip()
        if line:
            wrapped = marked(line, cols, 2)
            out += ["• " + wrapped[0][2:], *wrapped[1:]]
    return out


def fmt_secs(seconds):
    if seconds < 1:
        return f"{int(seconds * 1000)}ms"
    if seconds < 60:
        return f"{seconds:.1f}s"
    return f"{int(seconds // 60)}m{int(seconds % 60):02d}s"


def clock(ts):
    return time.strftime("%H:%M", time.localtime(ts)) if ts else "--:--"


def rule(label, cols):
    return f"{DIM}── {RESET}{BOLD}{label}{RESET} {DIM}{'─' * max(0, cols - width(label) - 4)}{RESET}"


def _tool_line(tool, st, tick, now, cols):
    state = tool["state"]
    icon = {RUN: f"{YELLOW}{SPINNER[tick % len(SPINNER)]}{RESET}", OK: f"{GREEN}✓{RESET}", ERR: f"{RED}✗{RESET}"}.get(state, f"{DIM}-{RESET}")
    end = now if state == RUN else tool["end"]
    dur = fmt_secs(end - tool["start"]) if tool["start"] and end else ""
    stamp = time.strftime("%H:%M:%S", time.localtime(tool["start"])) if tool["start"] else "--:--:--"
    name = tool_label(tool["tool"])
    color = MAGENTA if tool["tool"] in EDIT_TOOLS else CYAN if (tool["tool"] or "").startswith("mcp__") else BLUE
    name_w = min(NAME_MAX, max(NAME_MIN, width(name)))
    rest = cols - 2 - CLOCK_WIDTH - name_w - 1 - width(dur) - 1
    summary = fit_left(st.rel(tool["file"]), rest) if tool["file"] else fit(tool["summary"], rest)
    return f"{icon} {DIM}{stamp}{RESET} {color}{fit(name, name_w)}{RESET} {summary}{DIM}{dur}{RESET}"


def live_lines(st, tick, cols, rows):
    lines = []
    files = sorted(st.files.items(), key=lambda kv: -kv[1]["last"])
    tools = list(st.tools.values())
    file_rows = min(len(files), max(MIN_FILE_ROWS, int(rows * FILES_SHARE))) if files else 1
    shown = files if len(files) <= file_rows else files[:file_rows - 1]
    lines.append(rule(t("term_files", len(files), pane=st.pane), cols))
    if not files:
        lines.append(f"{DIM}  {t('term_none', pane=st.pane)}{RESET}")
    for path, changed in shown:
        mark = f"{GREEN}A{RESET}" if changed["created"] else f"{YELLOW}M{RESET}"
        count = f"×{changed['count']}" if changed["count"] > 1 else ""
        lines.append(f" {mark} {fit_left(st.rel(path), cols - 4 - width(count))}{DIM}{count}{RESET}")
    if len(files) > len(shown):
        lines.append(f"{DIM}   {t('term_more', len(files) - len(shown), pane=st.pane)}{RESET}")
    lines.append(rule(t("term_tools", len(tools), pane=st.pane), cols))
    if not tools:
        lines.append(f"{DIM}  {t('term_not_yet', pane=st.pane)}{RESET}")
    now = time.time()
    lines += [_tool_line(tool, st, tick, now, cols) for tool in reversed(tools)]
    return lines


def qa_lines(st, cols):
    pane = st.pane
    lines = []
    if Pending.active(qa_store.pending_path(pane)):
        lines.append(f"{YELLOW}⟳ {t('qa_checking', pane=pane)}{RESET}")
    turns = qa_store.with_overrides(pane, qa_store.records(pane, st.sid)) if st.sid else []
    if not turns:
        return lines + [f"{BOLD}{t('qa_empty_t', pane=pane)}{RESET}", *marked(t("qa_empty_d", pane=pane), cols, 0, DIM)]
    for turn in turns:
        lines.append(f"{DIM}{clock(turn.get('ts'))}{RESET} {fit(plain(turn.get('prompt')), cols - 6)}")
        if turn.get("status") != "ok":
            lines.append(f"  {RED}{t('qa_fail', pane=pane)}{RESET}")
        items = [i for i in turn.get("items") or [] if not i.get("archived")]
        if turn.get("status") == "ok" and not items:
            lines.append(f"  {DIM}{t('qa_noq', pane=pane)}{RESET}")
        for item in items:
            status = item.get("status")
            label = t("st_" + status, pane=pane) if status in STATUS_COLOR else status or "-"
            lines.append(f"  {STATUS_COLOR.get(status, DIM)}{label}{RESET}")
            lines += [f"  {BOLD}{line}{RESET}" for line in wrap(plain(item.get("question")), cols - 2)]
            if item.get("answer"):
                lines += marked(item["answer"], cols, 4, DIM)
            lines.append("")
        lines.append(f"{DIM}{'─' * cols}{RESET}")
    return lines


def flow_lines(st, step, cols):
    pane = st.pane
    lines = []
    if Pending.active(os.path.join(flow_store.flow_dir(pane), "pending")):
        lines.append(f"{YELLOW}⟳ {t('flow_gen', pane=pane)}{RESET}")
    rec = next(iter(flow_store.records(pane)), None)
    if not rec:
        return lines + [f"{BOLD}{t('flow_empty_t', pane=pane)}{RESET}", *marked(t("flow_empty_d", pane=pane), cols, 0, DIM)], 0
    if rec.get("status") != "ok":
        return lines + [f"{RED}{t('flow_fail', pane=pane)}{RESET}", *marked(rec.get("error"), cols, 0, DIM)], 0
    flow = rec.get("flow") or {}
    steps = flow.get("steps") or []
    step = max(0, min(step, len(steps) - 1))
    lines.append(f"{BOLD}{plain(flow.get('title'))}{RESET} {DIM}{clock(rec.get('ts'))}{RESET}")
    if flow.get("example"):
        lines += marked(f"{t('example_label', pane=pane)}: {flow['example']}", cols, 0, DIM)
    lines.append("")
    for i, s in enumerate(steps):
        pointer = f"{BLUE}▶{RESET}" if i == step else " "
        changed = f" {YELLOW}*{RESET}" if s.get("changed") else ""
        lines.append(f"{pointer} {i + 1}. {fit(plain(s.get('title')), cols - 9)}{changed}")
    if steps:
        s = steps[step]
        lines += ["", rule(f"{step + 1}/{len(steps)} {plain(s.get('title'))}", cols), f"{DIM}{s.get('location', '')}{RESET}"]
        lines += bullets(s.get("explanation"), cols)
        code = (s.get("code") or "").split("\n")[:CODE_LINES]
        if code != [""]:
            lines += ["", f"{DIM}{t('code', pane=pane)}{RESET}"]
            for line in code:
                hit = any(h and h in line for h in s.get("highlight") or [])
                lines.append(f"  {YELLOW if hit else CYAN}{fit(line, cols - 2).rstrip()}{RESET}")
        data = s.get("data") or []
        if data:
            lines += ["", f"{DIM}{t('state_title', pane=pane)}{RESET}"]
            for d in data:
                before = f"{d['before']} → " if d.get("before") not in (None, "", d.get("after")) else ""
                lines += marked(f"{d.get('name')}: {before}{d.get('after')}", cols, 2)
    if flow.get("summary"):
        lines += ["", *marked(flow["summary"], cols, 0, DIM)]
    return lines, step


class Screen:
    def __init__(self, pane):
        self.pane = pane
        self.tail = ActivityTail(pane)
        self.tab = Tab.LIVE
        self.step = 0
        self.scroll = {tab: 0 for tab in Tab}
        self.tick = 0

    def header(self, cols):
        st = self.tail.state
        tabs = " ".join(f"{REVERSE if tab == self.tab else DIM} {key} {t('mode_' + tab.value, pane=self.pane)} {RESET}"
                        for key, tab in TAB_KEYS.items())
        status = f"{YELLOW}{SPINNER[self.tick % len(SPINNER)]} {t('busy', pane=self.pane)}{RESET}" if st.busy \
            else f"{DIM}○ {t('idle', pane=self.pane)}{RESET}"
        where = os.path.basename((st.cwd or "").rstrip("/")) or "-"
        return [f"{tabs}  {status}", f"{DIM}{fit(where + '  /  ' + (st.sid or '-')[:8], cols)}{RESET}"]

    def body(self, cols, rows):
        st = self.tail.state
        if self.tab == Tab.LIVE:
            return live_lines(st, self.tick, cols, rows)
        if self.tab == Tab.QA:
            return qa_lines(st, cols)
        lines, self.step = flow_lines(st, self.step, cols)
        return lines

    def draw(self):
        cols, rows = os.get_terminal_size()
        cols -= RIGHT_MARGIN
        head = self.header(cols)
        foot = f"{DIM}{fit(t('term_keys', pane=self.pane), cols)}{RESET}"
        space = max(1, rows - len(head) - 1)
        body = self.body(cols, space)
        top = max(0, min(self.scroll[self.tab], len(body) - space))
        self.scroll[self.tab] = top
        visible = (head + body[top:top + space] + [""] * space)[:rows - 1] + [foot]
        sys.stdout.write("\033[H" + "\r\n".join(line + "\033[K" for line in visible) + "\033[J")
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
            subprocess.Popen(["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elif key == "q":
            raise SystemExit(0)
        else:
            return False
        return True


def read_keys(fd):
    data = os.read(fd, 32).decode("utf-8", "ignore")
    keys, i = [], 0
    while i < len(data):
        if data[i] == "\033" and data[i + 1:i + 2] == "[" and data[i + 2:i + 3] in ARROWS:
            keys.append(ARROWS[data[i + 2]])
            i += 3
        else:
            keys.append(data[i])
            i += 1
    return keys


def main():
    pane = sys.argv[1] if len(sys.argv) > 1 else pane_key()
    if not pane:
        sys.exit(__doc__)
    screen = Screen(pane)
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd) if os.isatty(fd) else None

    def restore_terminal(*_):
        if saved:
            termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        sys.stdout.write("\033[?25h\033[0m\r\n")
        sys.stdout.flush()
        os._exit(0)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, restore_terminal)
    resized = [True]
    signal.signal(signal.SIGWINCH, lambda *_: resized.__setitem__(0, True))
    if saved:
        tty.setcbreak(fd)
    sys.stdout.write(f"\033]2;{VIEW_TITLE}{pane}\007\033[?25l\033[2J")
    last_draw = 0.0
    try:
        while True:
            changed = screen.tail.refresh()
            ready = select.select([fd], [], [], POLL_SECONDS)[0] if saved else time.sleep(POLL_SECONDS)
            pressed = any(screen.key(k) for k in read_keys(fd)) if ready else False
            st = screen.tail.state
            animating = st.busy or any(tool["state"] == RUN for tool in st.tools.values())
            since = time.time() - last_draw
            if pressed or changed or resized[0] or (animating and since > ANIMATE_SECONDS) or since > IDLE_REDRAW_SECONDS:
                resized[0] = False
                screen.tick += 1
                try:
                    screen.draw()
                except OSError:
                    pass
                last_draw = time.time()
    except SystemExit:
        restore_terminal()


if __name__ == "__main__":
    main()
