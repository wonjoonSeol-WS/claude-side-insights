#!/usr/bin/env python3
"""Live activity of one pane as a terminal UI.

usage: python3 -m side_insights activity [pane]   (default: this pane)
"""
import os
import signal
import sys
import time
import unicodedata

from side_insights.live.activity import ERR, OK, RUN, ActivityTail, tool_label
from side_insights.paths import EDIT_TOOLS, pane_key
from side_insights.i18n import t

SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
POLL_SECONDS = 0.1
ANIMATE_SECONDS = 0.2
IDLE_REDRAW_SECONDS = 5
FILES_SHARE = 0.4
MIN_FILE_ROWS = 3
NAME_MIN, NAME_MAX = 6, 14
CLOCK_WIDTH = 9
VIEW_TITLE = "claude-panel:"
RIGHT_MARGIN = 1

DIM, BOLD, RESET = "\033[2m", "\033[1m", "\033[0m"
RED, GREEN, YELLOW, BLUE, CYAN, MAGENTA = (f"\033[3{n}m" for n in (1, 2, 3, 4, 6, 5))


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


def fmt_secs(seconds):
    if seconds < 1:
        return f"{int(seconds * 1000)}ms"
    if seconds < 60:
        return f"{seconds:.1f}s"
    return f"{int(seconds // 60)}m{int(seconds % 60):02d}s"


def _tool_line(tool, st, tick, now, cols):
    state = tool["state"]
    icon = {RUN: f"{YELLOW}{SPINNER[tick % len(SPINNER)]}{RESET}", OK: f"{GREEN}✓{RESET}", ERR: f"{RED}✗{RESET}"}.get(state, f"{DIM}-{RESET}")
    end = now if state == RUN else tool["end"]
    dur = fmt_secs(end - tool["start"]) if tool["start"] and end else ""
    clock = time.strftime("%H:%M:%S", time.localtime(tool["start"])) if tool["start"] else "--:--:--"
    name = tool_label(tool["tool"])
    color = MAGENTA if tool["tool"] in EDIT_TOOLS else CYAN if (tool["tool"] or "").startswith("mcp__") else BLUE
    name_w = min(NAME_MAX, max(NAME_MIN, width(name)))
    rest = cols - 2 - CLOCK_WIDTH - name_w - 1 - width(dur) - 1
    summary = fit_left(st.rel(tool["file"]), rest) if tool["file"] else fit(tool["summary"], rest)
    return f"{icon} {DIM}{clock}{RESET} {color}{fit(name, name_w)}{RESET} {summary}{DIM}{dur}{RESET}"


def render(st, tick):
    cols, rows = os.get_terminal_size()
    cols -= RIGHT_MARGIN
    status = f"{YELLOW}{SPINNER[tick % len(SPINNER)]} {t('busy', pane=st.pane)}{RESET}" if st.busy else f"{DIM}○ {t('idle', pane=st.pane)}{RESET}"
    where = os.path.basename((st.cwd or "").rstrip("/")) or "-"
    session = (st.sid or "-")[:8]
    lines = [f"{BOLD}{t('term_title', pane=st.pane)}{RESET}  {status}", f"{DIM}{fit(where + '  /  ' + session, cols)}{RESET}"]

    def rule(label):
        return f"{DIM}── {RESET}{BOLD}{label}{RESET} {DIM}{'─' * max(0, cols - width(label) - 4)}{RESET}"

    files = sorted(st.files.items(), key=lambda kv: -kv[1]["last"])
    tools = list(st.tools.values())
    body = rows - len(lines) - 2
    file_rows = min(len(files), max(MIN_FILE_ROWS, int(body * FILES_SHARE))) if files else 1
    shown = files if len(files) <= file_rows else files[:file_rows - 1]
    lines.append(rule(t("term_files", len(files), pane=st.pane)))
    if not files:
        lines.append(f"{DIM}  {t('term_none', pane=st.pane)}{RESET}")
    for path, changed in shown:
        mark = f"{GREEN}A{RESET}" if changed["created"] else f"{YELLOW}M{RESET}"
        count = f"×{changed['count']}" if changed["count"] > 1 else ""
        lines.append(f" {mark} {fit_left(st.rel(path), cols - 4 - width(count))}{DIM}{count}{RESET}")
    if len(files) > len(shown):
        lines.append(f"{DIM}   {t('term_more', len(files) - len(shown), pane=st.pane)}{RESET}")
    lines.append(rule(t("term_tools", len(tools), pane=st.pane)))
    if not tools:
        lines.append(f"{DIM}  {t('term_not_yet', pane=st.pane)}{RESET}")
    now = time.time()
    lines += [_tool_line(tool, st, tick, now, cols) for tool in tools[-max(1, body - file_rows):]]

    visible = lines[:rows]
    sys.stdout.write("\033[H" + "\r\n".join(line + "\033[K" for line in visible) + "\033[J")
    sys.stdout.flush()


def main():
    pane = sys.argv[1] if len(sys.argv) > 1 else pane_key()
    if not pane:
        sys.exit(__doc__)
    tail = ActivityTail(pane)

    def restore_terminal(*_):
        sys.stdout.write("\033[?25h\033[0m\r\n")
        sys.stdout.flush()
        sys.exit(0)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, restore_terminal)
    resized = [True]
    signal.signal(signal.SIGWINCH, lambda *_: resized.__setitem__(0, True))
    sys.stdout.write(f"\033]2;{VIEW_TITLE}{pane}\007\033[?25l\033[2J")
    tick, last_draw = 0, 0.0
    while True:
        changed = tail.refresh()
        st = tail.state
        animating = st.busy or any(tool["state"] == RUN for tool in st.tools.values())
        since = time.time() - last_draw
        if changed or resized[0] or (animating and since > ANIMATE_SECONDS) or since > IDLE_REDRAW_SECONDS:
            resized[0] = False
            tick += 1
            try:
                render(st, tick)
            except OSError:
                pass
            last_draw = time.time()
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
