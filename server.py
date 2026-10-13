#!/usr/bin/env python3
"""Local web server for the Claude activity / logic-flow panel. Binds 127.0.0.1 only."""
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402
from i18n import DEFAULT, current as current_language, messages, t  # noqa: E402
from language import Language  # noqa: E402
from viewer import State, tool_label  # noqa: E402

BASE = os.path.expanduser("~/.claude/activity-panel")
PORT = int(os.environ.get("CLAUDE_PANEL_PORT", "47821"))
KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
FLOW_RE = re.compile(r"^[0-9-]{1,40}$")


class Activity:
    def __init__(self, key):
        self.path = os.path.join(BASE, "logs", f"{key}.jsonl")
        self.state, self.pos, self.inode, self.buf = State(), 0, None, ""
        self.lock = threading.Lock()

    def snapshot(self):
        with self.lock:
            try:
                st = os.stat(self.path)
                if st.st_ino != self.inode or st.st_size < self.pos:
                    self.state, self.pos, self.inode, self.buf = State(), 0, st.st_ino, ""
                if st.st_size > self.pos:
                    with open(self.path, encoding="utf-8", errors="replace") as fh:
                        fh.seek(self.pos)
                        self.buf += fh.read()
                        self.pos = fh.tell()
                    *lines, self.buf = self.buf.split("\n")
                    for line in lines:
                        try:
                            self.state.apply(json.loads(line))
                        except ValueError:
                            pass
            except FileNotFoundError:
                pass
            s = self.state
            tools = list(s.tools.values())[-200:]
            return {
                "sid": s.sid, "cwd": s.cwd, "busy": s.busy,
                "tools": [{
                    "tool": t["tool"], "label": tool_label(t["tool"]), "summary": t["summary"],
                    "file": s.rel(t["file"]) if t["file"] else None,
                    "state": t["state"], "start": t["start"], "end": t["end"],
                } for t in tools],
                "files": [{"path": s.rel(p), "count": f["count"], "created": f["created"], "last": f["last"]}
                          for p, f in sorted(s.files.items(), key=lambda kv: -kv[1]["last"])],
            }


ACTIVITIES = {}
ACT_LOCK = threading.Lock()


def activity(key):
    with ACT_LOCK:
        if key not in ACTIVITIES:
            ACTIVITIES[key] = Activity(key)
        return ACTIVITIES[key]


def flows_meta(key):
    d = os.path.join(BASE, "flows", key)
    out, pending = [], None
    if os.path.isdir(d):
        for name in sorted(os.listdir(d), reverse=True):
            if not name.endswith(".json") or name.startswith("."):
                continue
            try:
                with open(os.path.join(d, name), encoding="utf-8") as fh:
                    r = json.load(fh)
                out.append({"id": r["id"], "ts": r.get("ts"), "status": r.get("status"),
                            "title": (r.get("flow") or {}).get("title") or r.get("prompt", "")[:30]})
            except (OSError, ValueError, KeyError):
                pass
        p = os.path.join(d, "pending")
        if os.path.exists(p):
            try:
                with open(p, encoding="utf-8") as fh:
                    pending = json.load(fh)
            except (OSError, ValueError):
                pending = {}
    return out, pending


def qa_sessions(key):
    """Every session that has Q&A in this pane, newest first."""
    d = os.path.join(BASE, "qa", key)
    out = []
    if os.path.isdir(d):
        for sid in os.listdir(d):
            sd = os.path.join(d, sid)
            if not os.path.isdir(sd):
                continue
            names = [n for n in os.listdir(sd) if n.endswith(".json") and not n.startswith(".")]
            if names:
                out.append({"sid": sid, "turns": len(names), "last": max(os.path.getmtime(os.path.join(sd, n)) for n in names)})
    return sorted(out, key=lambda x: -x["last"])


def qa_records(key, sid=None):
    """All turns of one session (every session when sid is None), newest first."""
    d = os.path.join(BASE, "qa", key)
    out, pending = [], os.path.exists(os.path.join(d, "pending"))
    dirs = [os.path.join(d, sid)] if sid else [os.path.join(d, x["sid"]) for x in qa_sessions(key)]
    for sd in dirs:
        if not os.path.isdir(sd):
            continue
        for name in os.listdir(sd):
            if not name.endswith(".json") or name.startswith("."):
                continue
            try:
                with open(os.path.join(sd, name), encoding="utf-8") as fh:
                    out.append(json.load(fh))
            except (OSError, ValueError):
                pass
    out.sort(key=lambda r: -(r.get("ts") or 0))
    return out, pending


STATUSES = {"answered", "partial", "unanswered"}
OVR_LOCK = threading.Lock()


def item_key(turn_id, question):
    return f"{turn_id}::{' '.join(str(question).split())}"


def item_id(turn_id, question):
    return hashlib.sha1(item_key(turn_id, question).encode("utf-8")).hexdigest()[:6]


def overrides_path(key):
    return os.path.join(BASE, "qa", key, "overrides.json")


def load_overrides(key):
    try:
        with open(overrides_path(key), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def apply_overrides(key, records):
    ovr = load_overrides(key)
    for r in records:
        for item in r.get("items", []):
            item["id"] = item_id(r.get("turn_id"), item.get("question", ""))
            o = ovr.get(item_key(r.get("turn_id"), item.get("question", "")), {})
            item["auto_status"] = item.get("status")
            if o.get("status") in STATUSES:
                item["status"] = o["status"]
                item["manual"] = True
            item["archived"] = bool(o.get("archived"))
    return records


def config_payload(values, locked):
    return {**values, "locked": locked, "models": list(config.MODELS),
            "langs": [{"code": lang.code, "label": lang.label} for lang in Language]}


def known_keys():
    keys = {}
    for sub in ("logs", "flows"):
        d = os.path.join(BASE, sub)
        if os.path.isdir(d):
            for name in os.listdir(d):
                k = name[:-6] if name.endswith(".jsonl") else name
                if KEY_RE.match(k):
                    keys[k] = max(keys.get(k, 0), os.path.getmtime(os.path.join(d, name)))
    return sorted(keys.items(), key=lambda kv: -kv[1])


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def query(self):
        raw = self.path.split("?", 1)[1] if "?" in self.path else ""
        return dict(q.split("=", 1) if "=" in q else (q, "") for q in raw.split("&") if q)

    def json(self, obj, code=200):
        self.send(code, json.dumps(obj, ensure_ascii=False))

    def page(self, key):
        with open(os.path.join(BASE, "app.html"), encoding="utf-8") as fh:
            html = fh.read()
        lang = Language.from_code(self.query().get("lang"), current_language())
        i18n_data = {"lang": lang.code, "messages": messages(lang), "fallback": messages(DEFAULT)}
        html = html.replace("__PANEL_KEY__", json.dumps(key)).replace("__PANEL_I18N__", json.dumps(i18n_data, ensure_ascii=False))
        self.send(200, html, "text/html; charset=utf-8")

    def do_GET(self):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if not parts:
            return self.page(None)
        if parts == ["api", "config"]:
            values, locked = config.load()
            return self.json(config_payload(values, locked))
        if parts == ["health"]:
            return self.json({"ok": True, "pid": os.getpid()})
        if parts == ["api", "keys"]:
            out = []
            for k, mtime in known_keys()[:40]:
                snap = activity(k).snapshot()
                flows, pending = flows_meta(k)
                out.append({"key": k, "mtime": mtime, "cwd": snap["cwd"], "busy": snap["busy"],
                            "tools": len(snap["tools"]), "files": len(snap["files"]),
                            "flow": flows[0]["title"] if flows else None, "pending": bool(pending)})
            return self.json(out)
        if len(parts) == 2 and parts[0] == "p" and KEY_RE.match(parts[1]):
            return self.page(parts[1])
        if len(parts) >= 3 and parts[0] == "api" and KEY_RE.match(parts[1]):
            key = parts[1]
            if parts[2] == "state":
                flows, pending = flows_meta(key)
                return self.json({"activity": activity(key).snapshot(), "flows": flows, "pending": pending})
            if parts[2] == "qa":
                sid = activity(key).snapshot()["sid"]
                records, pending = qa_records(key, sid) if sid else ([], False)
                return self.json({"sid": sid, "turns": apply_overrides(key, records), "pending": pending})
            if parts[2] == "flow" and len(parts) == 4 and FLOW_RE.match(parts[3]):
                p = os.path.join(BASE, "flows", key, f"{parts[3]}.json")
                if os.path.exists(p):
                    with open(p, encoding="utf-8") as fh:
                        return self.send(200, fh.read())
        self.json({"error": "not found"}, 404)

    def do_POST(self):
        parts = [p for p in self.path.split("?")[0].split("/") if p]
        if self.headers.get("X-Claude-Panel") != "1":
            return self.json({"error": "forbidden"}, 403)
        if parts == ["api", "config"]:
            try:
                values, locked = config.save(json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}"))
            except (ValueError, TypeError, AttributeError) as exc:
                return self.json({"error": str(exc)}, 400)
            return self.json(config_payload(values, locked))
        if len(parts) == 4 and parts[0] == "api" and KEY_RE.match(parts[1]) and parts[2:] == ["qa", "override"]:
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if body.get("id"):
                    sid = activity(parts[1]).snapshot()["sid"]
                    records, _ = qa_records(parts[1], sid) if sid else ([], False)
                    match = next(((r["turn_id"], i["question"]) for r in records for i in r.get("items", [])
                                  if item_id(r.get("turn_id"), i.get("question", "")) == body["id"]), None)
                    if not match:
                        return self.json({"error": t("err_no_id", body["id"])}, 404)
                    body["turn_id"], body["question"] = match
                k = item_key(body["turn_id"], body["question"])
            except (ValueError, KeyError, TypeError):
                return self.json({"error": t("err_need_id")}, 400)
            with OVR_LOCK:
                ovr = load_overrides(parts[1])
                o = ovr.get(k, {})
                if "status" in body:
                    if body["status"] in STATUSES:
                        o["status"] = body["status"]
                    else:
                        o.pop("status", None)
                if "archived" in body:
                    o["archived"] = bool(body["archived"])
                if o.get("status") or o.get("archived"):
                    ovr[k] = o
                else:
                    ovr.pop(k, None)
                os.makedirs(os.path.dirname(overrides_path(parts[1])), exist_ok=True)
                tmp = overrides_path(parts[1]) + ".tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(ovr, fh, ensure_ascii=False, indent=1)
                os.replace(tmp, overrides_path(parts[1]))
            return self.json({"ok": True})
        if len(parts) == 3 and parts[0] == "api" and KEY_RE.match(parts[1]) and parts[2] == "open":
            subprocess.Popen(["/usr/bin/open", f"http://127.0.0.1:{PORT}/p/{parts[1]}?full=1"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return self.json({"ok": True})
        if len(parts) == 3 and parts[0] == "api" and KEY_RE.match(parts[1]) and parts[2] == "regen":
            turn = os.path.join(BASE, "turns", f"{parts[1]}.json")
            if not os.path.exists(turn):
                return self.json({"error": t("err_no_turn")}, 409)
            with open(turn, encoding="utf-8") as fh:
                t = json.load(fh)
            query = self.path.split("?", 1)[-1] if "?" in self.path else ""
            turn_id = next((v for k, v in (q.split("=", 1) for q in query.split("&") if "=" in q) if k == "turn"), None)
            if turn_id:
                if not re.match(r"^[A-Za-z0-9-]{1,64}$", turn_id):
                    return self.json({"error": "bad turn id"}, 400)
                records, _ = qa_records(parts[1])
                rec = next((r for r in records if r.get("turn_id") == turn_id), {})
                script = ["qa.py", parts[1], rec.get("transcript") or t["transcript"], turn_id]
            elif "qa" in query:
                script = ["qa.py", parts[1], t["transcript"]]
            else:
                script = ["flow.py", parts[1], t["transcript"], t["cwd"]]
            subprocess.Popen([sys.executable, os.path.join(BASE, script[0]), *script[1:], "--force"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            return self.json({"ok": True})
        self.json({"error": "not found"}, 404)


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
