#!/usr/bin/env python3
"""Live side panel: tools Claude used and files it changed, for one cmux panel (or session)."""
import json
import os
import signal
import sys
import time
import unicodedata
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i18n import t  # noqa: E402

BASE = os.path.expanduser("~/.claude/activity-panel")
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
MAX_TOOLS = 500

DIM, BOLD, RESET = "\033[2m", "\033[1m", "\033[0m"
RED, GREEN, YELLOW, BLUE, CYAN, MAGENTA = (f"\033[3{n}m" for n in (1, 2, 3, 4, 6, 5))


def width(s):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 0 if unicodedata.combining(c) else 1 for c in s)


def fit(s, w):
    if w <= 0:
        return ""
    if width(s) <= w:
        return s + " " * (w - width(s))
    out, used = [], 0
    for c in s:
        cw = width(c)
        if used + cw > w - 1:
            break
        out.append(c)
        used += cw
    return "".join(out) + "…" + " " * (w - used - 1)


def fit_left(s, w):
    """Truncate from the left, keeping the end (file names)."""
    if width(s) <= w:
        return s + " " * (w - width(s))
    out, used = [], 0
    for c in reversed(s):
        cw = width(c)
        if used + cw > w - 1:
            break
        out.append(c)
        used += cw
    return "…" + "".join(reversed(out)) + " " * (w - used - 1)


def tool_label(name):
    if name and name.startswith("mcp__"):
        parts = name.split("__")
        server = parts[1].replace("claude_ai_", "").replace("plugin_", "")
        return f"{server}:{parts[-1]}"
    return name or "?"


def fmt_secs(s):
    if s is None:
        return ""
    if s < 1:
        return f"{int(s * 1000)}ms"
    if s < 60:
        return f"{s:.1f}s"
    return f"{int(s // 60)}m{int(s % 60):02d}s"


class State:
    def __init__(self):
        self.reset(None)

    def reset(self, sid):
        self.sid = sid
        self.cwd = None
        self.tools = OrderedDict()
        self.files = {}
        self.busy = False
        self.seq = 0

    def apply(self, e):
        sid = e.get("sid")
        if sid and sid != self.sid and e.get("ev") in ("SessionStart", "UserPromptSubmit", "PreToolUse"):
            self.reset(sid)
        if e.get("cwd"):
            self.cwd = e["cwd"]
        ev = e.get("ev")
        if ev == "UserPromptSubmit":
            self.busy = True
        elif ev in ("Stop", "SessionEnd"):
            self.busy = False
            for t in self.tools.values():
                if t["state"] == "run":
                    t["state"] = "lost"
        elif ev == "PreToolUse":
            self.busy = True
            self.seq += 1
            key = e.get("id") or f"anon-{self.seq}"
            self.tools[key] = {
                "tool": e.get("tool"), "summary": e.get("summary") or "", "file": e.get("file"),
                "start": e.get("ts"), "end": None, "state": "run",
            }
            while len(self.tools) > MAX_TOOLS:
                self.tools.popitem(last=False)
        elif ev in ("PostToolUse", "PostToolUseFailure"):
            key = e.get("id")
            t = self.tools.get(key) if key else None
            if t is None:
                t = next((v for v in reversed(self.tools.values())
                          if v["state"] == "run" and v["tool"] == e.get("tool")), None)
            if t is None:
                self.seq += 1
                t = self.tools[key or f"anon-{self.seq}"] = {
                    "tool": e.get("tool"), "summary": e.get("summary") or "", "file": e.get("file"),
                    "start": e.get("ts"), "end": None, "state": "run",
                }
            t["end"] = e.get("ts")
            t["state"] = "err" if e.get("error") else "ok"
            if e.get("tool") in EDIT_TOOLS and e.get("file") and not e.get("error"):
                f = self.files.setdefault(e["file"], {"count": 0, "created": False, "last": 0})
                f["count"] += 1
                f["last"] = e.get("ts") or time.time()
                if e.get("kind") == "create":
                    f["created"] = True

    def rel(self, path):
        if self.cwd and path.startswith(self.cwd.rstrip("/") + "/"):
            return path[len(self.cwd.rstrip("/")) + 1:]
        home = os.path.expanduser("~")
        return "~" + path[len(home):] if path.startswith(home) else path


def render(st, key, tick):
    cols, rows = os.get_terminal_size()
    now = time.time()
    lines = []

    status = f"{YELLOW}{SPINNER[tick % len(SPINNER)]} {t('busy')}{RESET}" if st.busy else f"{DIM}○ {t('idle')}{RESET}"
    title = f"{BOLD}Claude activity{RESET}  {status}"
    lines.append(title)
    where = os.path.basename((st.cwd or "").rstrip("/")) or "-"
    sid = (st.sid or "-")[:8]
    lines.append(f"{DIM}{fit(f'{where}  /  {sid}', cols)}{RESET}")

    files = sorted(st.files.items(), key=lambda kv: -kv[1]["last"])
    tools = list(st.tools.values())
    body = rows - len(lines) - 2
    file_rows = min(len(files), max(3, body * 2 // 5)) if files else 1
    tool_rows = max(1, body - file_rows)

    def rule(label):
        return f"{DIM}── {RESET}{BOLD}{label}{RESET} {DIM}{'─' * max(0, cols - width(label) - 4)}{RESET}"

    lines.append(rule(t("term_files", len(files))))
    if not files:
        lines.append(f"{DIM}  {t('term_none')}{RESET}")
    shown = files[:file_rows] if len(files) <= file_rows else files[:file_rows - 1]
    for path, f in shown:
        mark = f"{GREEN}A{RESET}" if f["created"] else f"{YELLOW}M{RESET}"
        count = f"×{f['count']}" if f["count"] > 1 else ""
        name_w = cols - 4 - width(count)
        lines.append(f" {mark} {fit_left(st.rel(path), name_w)}{DIM}{count}{RESET}")
    if len(files) > len(shown):
        lines.append(f"{DIM}   {t('term_more', len(files) - len(shown))}{RESET}")

    lines.append(rule(t("term_tools", len(tools))))
    visible = tools[-tool_rows:] if tools else []
    if not tools:
        lines.append(f"{DIM}  {t('term_not_yet')}{RESET}")
    for t in visible:
        state = t["state"]
        if state == "run":
            icon = f"{YELLOW}{SPINNER[tick % len(SPINNER)]}{RESET}"
            dur = fmt_secs(now - t["start"]) if t["start"] else ""
        elif state == "ok":
            icon = f"{GREEN}✓{RESET}"
            dur = fmt_secs(t["end"] - t["start"]) if t["start"] and t["end"] else ""
        elif state == "err":
            icon = f"{RED}✗{RESET}"
            dur = fmt_secs(t["end"] - t["start"]) if t["start"] and t["end"] else ""
        else:
            icon = f"{DIM}-{RESET}"
            dur = ""
        clock = time.strftime("%H:%M:%S", time.localtime(t["start"])) if t["start"] else "--:--:--"
        name = tool_label(t["tool"])
        name_color = MAGENTA if t["tool"] in EDIT_TOOLS else CYAN if (t["tool"] or "").startswith("mcp__") else BLUE
        name_w = min(14, max(6, width(name)))
        summary = st.rel(t["file"]) if t["file"] else t["summary"]
        rest = cols - 2 - 9 - name_w - 1 - width(dur) - 1
        summary_txt = fit_left(summary, rest) if t["file"] else fit(summary, rest)
        lines.append(f"{icon} {DIM}{clock}{RESET} {name_color}{fit(name, name_w)}{RESET} {summary_txt}{DIM}{dur}{RESET}")

    out = ["\033[H"]
    for i, line in enumerate(lines[:rows]):
        out.append(line + "\033[K" + ("\r\n" if i < min(len(lines), rows) - 1 else ""))
    out.append("\033[J")
    sys.stdout.write("".join(out))
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        print("usage: viewer.py <cmux-panel-id|session-id>", file=sys.stderr)
        sys.exit(2)
    key = sys.argv[1]
    log = os.path.join(BASE, "logs", f"{key}.jsonl")
    pid_dir = os.path.join(BASE, "viewers")
    os.makedirs(pid_dir, exist_ok=True)
    pid_file = os.path.join(pid_dir, f"{key}.pid")
    with open(pid_file, "w") as fh:
        fh.write(str(os.getpid()))

    def cleanup(*_):
        sys.stdout.write("\033[?25h\033[0m\r\n")
        sys.stdout.flush()
        try:
            if open(pid_file).read().strip() == str(os.getpid()):
                os.remove(pid_file)
        except OSError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGHUP, cleanup)
    resized = [True]
    signal.signal(signal.SIGWINCH, lambda *_: resized.__setitem__(0, True))

    sys.stdout.write("\033[?25l\033[2J")
    if os.environ.get("CMUX_SURFACE_ID"):
        sys.stdout.write("\033]0;Claude activity\007")
    st = State()
    pos, inode, buf, tick, last_draw = 0, None, "", 0, 0.0
    while True:
        changed = False
        try:
            stat = os.stat(log)
            if stat.st_ino != inode or stat.st_size < pos:
                inode, pos, buf = stat.st_ino, 0, ""
                st.reset(None)
                changed = True
            if stat.st_size > pos:
                with open(log, "r", encoding="utf-8", errors="replace") as fh:
                    fh.seek(pos)
                    buf += fh.read()
                    pos = fh.tell()
                *complete, buf = buf.split("\n")
                for line in complete:
                    try:
                        st.apply(json.loads(line))
                        changed = True
                    except ValueError:
                        pass
        except FileNotFoundError:
            pass
        animating = st.busy or any(t["state"] == "run" for t in st.tools.values())
        if changed or resized[0] or (animating and time.time() - last_draw > 0.2) or time.time() - last_draw > 5:
            resized[0] = False
            tick += 1
            try:
                render(st, key, tick)
            except OSError:
                pass
            last_draw = time.time()
        time.sleep(0.1)


if __name__ == "__main__":
    main()
