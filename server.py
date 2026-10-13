#!/usr/bin/env python3
"""Local web server for the panel: app.html plus JSON APIs. Listens on 127.0.0.1 only."""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import config
import qa_store
from activity import ActivityTail, log_path
from claude_run import Pending
from common import BASE, ID_RE, KEY_RE, PORT, read_json
from i18n import current, messages, t
from language import DEFAULT, Language

MAX_BODY = 64 * 1024
MAX_INDEX_PANES = 40
FLOW_ID_RE = re.compile(r"^[0-9a-f-]{1,40}$")
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
CMUX = shutil.which("cmux") or "/Applications/cmux.app/Contents/Resources/bin/cmux"
SEND_TIMEOUT = 5

_tails = {}
_tails_lock = threading.Lock()


def tail(pane):
    """The pane's activity reader, or None when the pane has no log."""
    with _tails_lock:
        if pane not in _tails:
            if not os.path.exists(log_path(pane)):
                return None
            _tails[pane] = ActivityTail(pane)
        return _tails[pane]


def snapshot(pane):
    reader = tail(pane)
    return reader.snapshot() if reader else {"sid": None, "cwd": None, "busy": False, "tools": [], "files": []}


def flows(pane):
    directory = os.path.join(BASE, "flows", pane)
    found = []
    for path in sorted(_json_paths(directory), reverse=True):
        rec = read_json(path)
        if isinstance(rec, dict) and rec.get("id"):
            found.append({"id": rec["id"], "ts": rec.get("ts"), "status": rec.get("status"),
                          "title": (rec.get("flow") or {}).get("title") or (rec.get("prompt") or "")[:30]})
    return found, Pending.active(os.path.join(directory, "pending"))


def _json_paths(directory):
    try:
        return [os.path.join(directory, n) for n in os.listdir(directory) if n.endswith(".json") and not n.startswith(".")]
    except OSError:
        return []


def known_panes():
    stamps = {}
    for sub, suffix in (("logs", ".jsonl"), ("flows", "")):
        directory = os.path.join(BASE, sub)
        try:
            names = os.listdir(directory)
        except OSError:
            continue
        for name in names:
            pane = name[:-len(suffix)] if suffix and name.endswith(suffix) else name
            if KEY_RE.match(pane):
                try:
                    stamps[pane] = max(stamps.get(pane, 0), os.path.getmtime(os.path.join(directory, name)))
                except OSError:
                    pass
    return sorted(stamps.items(), key=lambda kv: -kv[1])[:MAX_INDEX_PANES]


def send_to_cmux(surface, workspace, message):
    """Type the message into the Claude pane and press Enter. False when the pane is unknown or cmux fails."""
    if not surface or not os.path.exists(CMUX):
        return False
    scope = ["--surface", surface] + (["--workspace", workspace] if workspace else [])
    try:
        typed = subprocess.run([CMUX, "send", *scope, "--", message], capture_output=True, timeout=SEND_TIMEOUT)
        entered = typed.returncode == 0 and subprocess.run([CMUX, "send-key", *scope, "enter"], capture_output=True,
                                                           timeout=SEND_TIMEOUT).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False
    return entered


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

    def json(self, obj, code=200):
        self.send(code, json.dumps(obj, ensure_ascii=False))

    def error(self, code, key, *args, pane=None):
        self.json({"error": t(key, *args, pane=pane)}, code)

    def body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if not 0 <= length <= MAX_BODY:
            return None
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def route(self, method):
        if self.headers.get("Host") not in ALLOWED_HOSTS:
            return self.error(403, "err_forbidden")
        if method == "POST" and self.headers.get("X-Claude-Panel") != "1":
            return self.error(403, "err_forbidden")
        url = urlsplit(self.path)
        self.params = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        for route_method, pattern, handler in ROUTES:
            if route_method == method and len(pattern) == len(parts) and all(
                    p == q if isinstance(p, str) else bool(p.match(q)) for p, q in zip(pattern, parts)):
                return handler(self, *[q for p, q in zip(pattern, parts) if not isinstance(p, str)])
        self.error(404, "err_not_found")

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def param(self, name):
        return (self.params.get(name) or [None])[0]

    def get_page(self, pane=None):
        with open(os.path.join(BASE, "app.html"), encoding="utf-8") as fh:
            html = fh.read()
        lang = Language.from_code(self.param("lang"), current(pane))
        i18n_data = {"lang": lang.code, "messages": messages(lang), "fallback": messages(DEFAULT)}
        inject = {"__PANEL_KEY__": pane, "__PANEL_I18N__": i18n_data}
        for marker, value in inject.items():
            html = html.replace(marker, json.dumps(value, ensure_ascii=False).replace("</", "<\\/"))
        self.send(200, html, "text/html; charset=utf-8")

    def get_health(self):
        self.json({"ok": True, "pid": os.getpid(), "app": "claude-panel"})

    def get_config(self):
        self.json(config.payload(self.param("pane") if KEY_RE.match(self.param("pane") or "") else None))

    def post_config(self):
        update = self.body()
        pane = self.param("pane")
        if update is None or (pane is not None and not KEY_RE.match(pane)):
            return self.error(400, "err_bad_request")
        try:
            config.save(update, pane)
        except ValueError as exc:
            return self.json({"error": str(exc)}, 400)
        self.json(config.payload(pane))

    def get_panes(self):
        out = []
        for pane, mtime in known_panes():
            snap = snapshot(pane)
            pane_flows, pending = flows(pane)
            out.append({"key": pane, "mtime": mtime, "cwd": snap["cwd"], "busy": snap["busy"], "tools": len(snap["tools"]),
                        "files": len(snap["files"]), "flow": pane_flows[0]["title"] if pane_flows else None, "pending": bool(pending)})
        self.json(out)

    def get_state(self, pane):
        pane_flows, pending = flows(pane)
        snap = snapshot(pane)
        records = qa_store.with_overrides(pane, qa_store.records(pane, snap["sid"])) if snap["sid"] else []
        qa_pending = Pending.active(qa_store.pending_path(pane))
        self.json({"activity": snap, "flows": pane_flows, "pending": pending,
                   "qa": {"sid": snap["sid"], "turns": records, "pending": bool(qa_pending)}})

    def get_flow(self, pane, flow_id):
        rec = read_json(os.path.join(BASE, "flows", pane, f"{flow_id}.json"))
        if not isinstance(rec, dict):
            return self.error(404, "err_not_found", pane=pane)
        self.json(rec)

    def post_override(self, pane):
        body = self.body()
        if body is None or not isinstance(body.get("id"), str):
            return self.error(400, "err_need_id", pane=pane)
        sid = snapshot(pane)["sid"]
        found = qa_store.find_item(pane, sid, body["id"]) if sid else None
        if not found:
            return self.error(404, "err_no_id", body["id"], pane=pane)
        status = ...
        if "status" in body:
            status = qa_store.Status.parse(body["status"])
            if body["status"] is not None and status is None:
                return self.error(400, "err_bad_request", pane=pane)
        archived = body.get("archived") if isinstance(body.get("archived"), bool) else None
        qa_store.set_override(pane, *found, status=status, archived=archived)
        self.json({"ok": True})

    def post_ask(self, pane):
        body = self.body()
        if body is None or not isinstance(body.get("id"), str):
            return self.error(400, "err_need_id", pane=pane)
        sid = snapshot(pane)["sid"]
        found = qa_store.get_item(pane, sid, body["id"]) if sid else None
        if not found:
            return self.error(404, "err_no_id", body["id"], pane=pane)
        question = " ".join(str(found[1].get("question", "")).replace("\\", " ").split())
        message = t("ask_message", question, pane=pane)
        last = read_json(os.path.join(BASE, "turns", f"{pane}.json")) or {}
        if send_to_cmux(last.get("cmux_surface"), last.get("cmux_workspace"), message):
            return self.json({"sent": True})
        subprocess.run(["/usr/bin/pbcopy"], input=message.encode("utf-8"), check=False)
        self.json({"sent": False, "copied": True})

    def post_open(self, pane):
        subprocess.Popen(["/usr/bin/open", f"http://127.0.0.1:{PORT}/p/{pane}?full=1"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.json({"ok": True})

    def post_regen(self, pane):
        last = read_json(os.path.join(BASE, "turns", f"{pane}.json"))
        if not isinstance(last, dict) or not last.get("transcript"):
            return self.error(409, "err_no_turn", pane=pane)
        target = self.param("target")
        turn_id = self.param("turn")
        item = self.param("item")
        if target not in ("flow", "qa") or any(v is not None and not ID_RE.match(v) for v in (turn_id, item)):
            return self.error(400, "err_bad_request", pane=pane)
        if item:
            sid = snapshot(pane)["sid"]
            found = qa_store.get_item(pane, sid, item) if sid else None
            if not found:
                return self.error(404, "err_no_id", item, pane=pane)
            turn_id = found[0].get("turn_id")
            last = {**last, "transcript": found[0].get("transcript") or last["transcript"]}
        marker = qa_store.pending_path(pane) if target == "qa" else os.path.join(BASE, "flows", pane, "pending")
        if Pending.active(marker):
            return self.error(409, "err_running", pane=pane)
        if target == "flow":
            args = ["flow.py", pane, last["transcript"], last.get("cwd") or ""]
        else:
            args = ["qa.py", pane, last["transcript"]] + ([turn_id] if turn_id else []) + ([f"--item={item}"] if item else [])
        subprocess.Popen([sys.executable, os.path.join(BASE, args[0]), *args[1:], "--force"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        self.json({"ok": True})


ROUTES = [
    ("GET", [], Handler.get_page),
    ("GET", ["p", KEY_RE], Handler.get_page),
    ("GET", ["health"], Handler.get_health),
    ("GET", ["api", "config"], Handler.get_config),
    ("GET", ["api", "panes"], Handler.get_panes),
    ("GET", ["api", KEY_RE, "state"], Handler.get_state),
    ("GET", ["api", KEY_RE, "flow", FLOW_ID_RE], Handler.get_flow),
    ("POST", ["api", "config"], Handler.post_config),
    ("POST", ["api", KEY_RE, "qa", "override"], Handler.post_override),
    ("POST", ["api", KEY_RE, "open"], Handler.post_open),
    ("POST", ["api", KEY_RE, "qa", "ask"], Handler.post_ask),
    ("POST", ["api", KEY_RE, "regen"], Handler.post_regen),
]


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
