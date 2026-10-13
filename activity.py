"""Live activity of one pane: tools in order, files changed, whether Claude is working. Built from logs/<pane>.jsonl."""
import json
import os
import threading
from collections import OrderedDict

from common import BASE, EDIT_TOOLS

MAX_TOOLS = 500
RUN, OK, ERR, LOST = "run", "ok", "err", "lost"
_STARTS_TURN = ("UserPromptSubmit", "PreToolUse")
_ENDS_TOOL = ("PostToolUse", "PostToolUseFailure")


def log_path(pane):
    return os.path.join(BASE, "logs", f"{pane}.jsonl")


def tool_label(name):
    if name and name.startswith("mcp__"):
        parts = name.split("__")
        server = parts[1].replace("claude_ai_", "").replace("plugin_", "")
        return f"{server}:{parts[-1]}"
    return name or "?"


def _new_tool(e):
    return {"tool": e.get("tool"), "summary": e.get("summary") or "", "file": e.get("file"),
            "start": e.get("ts"), "end": None, "state": RUN}


class State:
    def __init__(self):
        self.reset(None)

    def reset(self, sid):
        self.sid, self.cwd, self.busy, self.seq = sid, None, False, 0
        self.tools = OrderedDict()
        self.files = {}

    def apply(self, e):
        ev, sid = e.get("ev"), e.get("sid")
        if sid and sid != self.sid and ev in _STARTS_TURN:
            self.reset(sid)
        if e.get("cwd"):
            self.cwd = e["cwd"]
        if ev == "UserPromptSubmit":
            self.busy = True
        elif ev == "Stop":
            self.busy = False
            for tool in self.tools.values():
                if tool["state"] == RUN:
                    tool["state"] = LOST
        elif ev == "PreToolUse":
            self.busy = True
            self._add(e.get("id"), _new_tool(e))
        elif ev in _ENDS_TOOL:
            self._finish(e)

    def _add(self, tool_id, tool):
        self.seq += 1
        self.tools[tool_id or f"anon-{self.seq}"] = tool
        while len(self.tools) > MAX_TOOLS:
            self.tools.popitem(last=False)
        return tool

    def _finish(self, e):
        tool = self.tools.get(e.get("id")) if e.get("id") else None
        if tool is None:
            tool = next((v for v in reversed(self.tools.values()) if v["state"] == RUN and v["tool"] == e.get("tool")), None)
        if tool is None:
            tool = self._add(e.get("id"), _new_tool(e))
        failed = bool(e.get("error"))
        tool["end"], tool["state"] = e.get("ts"), ERR if failed else OK
        if e.get("tool") in EDIT_TOOLS and e.get("file") and not failed:
            changed = self.files.setdefault(e["file"], {"count": 0, "created": False, "last": 0})
            changed["count"] += 1
            changed["last"] = e.get("ts") or 0
            changed["created"] = changed["created"] or e.get("kind") == "create"

    def rel(self, path):
        root = (self.cwd or "").rstrip("/")
        if root and path.startswith(root + "/"):
            return path[len(root) + 1:]
        home = os.path.expanduser("~")
        return "~" + path[len(home):] if path.startswith(home) else path


class ActivityTail:
    """Reads only the bytes appended to a pane's log since the last call."""

    def __init__(self, pane):
        self.path = log_path(pane)
        self.state, self.pos, self.inode, self.buf = State(), 0, None, b""
        self.lock = threading.Lock()

    def refresh(self):
        """Applies new events; returns True when anything changed."""
        with self.lock:
            try:
                st = os.stat(self.path)
            except OSError:
                return False
            changed = False
            if st.st_ino != self.inode or st.st_size < self.pos:
                self.state, self.pos, self.inode, self.buf = State(), 0, st.st_ino, b""
                changed = True
            if st.st_size > self.pos:
                with open(self.path, "rb") as fh:
                    fh.seek(self.pos)
                    self.buf += fh.read()
                    self.pos = fh.tell()
                *lines, self.buf = self.buf.split(b"\n")
                for line in lines:
                    try:
                        self.state.apply(json.loads(line.decode("utf-8")))
                        changed = True
                    except ValueError:
                        pass
            return changed

    def snapshot(self, max_tools=200):
        self.refresh()
        s = self.state
        return {
            "sid": s.sid, "cwd": s.cwd, "busy": s.busy,
            "tools": [{"tool": tool["tool"], "label": tool_label(tool["tool"]), "summary": tool["summary"],
                       "file": s.rel(tool["file"]) if tool["file"] else None,
                       "state": tool["state"], "start": tool["start"], "end": tool["end"]}
                      for tool in list(s.tools.values())[-max_tools:]],
            "files": [{"path": s.rel(p), "count": f["count"], "created": f["created"], "last": f["last"]}
                      for p, f in sorted(s.files.items(), key=lambda kv: -kv[1]["last"])],
        }
