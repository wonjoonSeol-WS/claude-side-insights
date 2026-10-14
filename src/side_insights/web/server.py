#!/usr/bin/env python3
"""Local web server for the panel: app.html plus JSON APIs. Listens on 127.0.0.1 only."""
import json
import os
import re
import secrets
import subprocess
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from side_insights import config
from side_insights.analysis import flow_store, qa_store
from side_insights.analysis.runner import Pending
from side_insights.analysis.waiting import Waiting, eta_seconds
from side_insights.i18n import current, messages, t
from side_insights.language import DEFAULT, Language
from side_insights.launch import child_env, command_line
from side_insights.live.activity import ActivityTail, log_path
from side_insights.web import diff
from side_insights.paths import (ANALYSIS_LOG, APP_NAME, DATA, ITEM_ID_RE, KEY_RE, PORT, ROOT, TOKEN_HEADER, TURN_ID_RE, api_token,
                                 last_turn_path, read_json)

MAX_BODY = 64 * 1024
MAX_INDEX_PANES = 40
MAX_CACHED_PANES = 64
TITLE_FALLBACK = 30
REGEN_TARGETS = ("flow", "qa")
SCOPE_OPEN = "open"
LEGACY_TOKEN_HEADER = "X-Claude-Panel"
FLOW_ID_RE = re.compile(r"^[0-9a-f-]{1,40}$")
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
TOKEN = api_token()
REQUEST_TIMEOUT = 10
_spawn_lock = threading.Lock()
_MARKERS = re.compile(r"__PANEL_(KEY|I18N|TOKEN)__")
COPY_TIMEOUT = 5

_tails = OrderedDict()
_waiting = OrderedDict()
_cache_lock = threading.Lock()


def _cached(cache, pane, make):
    """Per-pane readers, keeping only the panes used most recently."""
    with _cache_lock:
        if pane in cache:
            cache.move_to_end(pane)
            return cache[pane]
        value = cache[pane] = make()
        while len(cache) > MAX_CACHED_PANES:
            cache.popitem(last=False)
        return value


def snapshot(pane):
    if not os.path.exists(log_path(pane)):
        return {"sid": None, "cwd": None, "transcript": None, "busy": False, "tools": [], "files": []}
    return _cached(_tails, pane, lambda: ActivityTail(pane)).snapshot()


def waiting_for(pane):
    return _cached(_waiting, pane, Waiting)


def flows(pane):
    found = []
    for rec in flow_store.records(pane):
        title = (rec.get("flow") or {}).get("title") or (rec.get("prompt") or "")[:TITLE_FALLBACK]
        found.append({"id": rec["id"], "ts": rec.get("ts"), "status": rec.get("status"), "title": title})
    return found, Pending.active(flow_store.pending_path(pane))


def known_panes(limit=MAX_INDEX_PANES):
    stamps = {}
    for sub, suffix in (("logs", ".jsonl"), ("flows", "")):
        directory = os.path.join(DATA, sub)
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
    return sorted(stamps.items(), key=lambda kv: -kv[1])[:limit]


def resolve_pane(pane):
    """A unique prefix of a known pane key stands for that pane, so printed links stay short.

    Returns the full key, the pane itself when it is unknown or exact, or None when the prefix is ambiguous."""
    if pane is None:
        return None
    keys = [key for key, _ in known_panes(limit=None)]
    if pane in keys:
        return pane
    matches = [key for key in keys if key.startswith(pane)]
    return matches[0] if len(matches) == 1 else None if matches else pane


class Handler(BaseHTTPRequestHandler):
    timeout = REQUEST_TIMEOUT

    def log_message(self, *_):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
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
        url = urlsplit(self.path)
        self.params = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        page = method == "GET" and (not parts or parts[0] == "p")
        sent = self.param("t") if page else (self.headers.get(TOKEN_HEADER) or self.headers.get(LEGACY_TOKEN_HEADER))
        if parts != ["health"] and not secrets.compare_digest((sent or "").encode(), TOKEN.encode()):
            return self.error(403, "err_forbidden")
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

    def redirect(self, location):
        query = urlsplit(self.path).query
        self.send_response(302)
        self.send_header("Location", location + (f"?{query}" if query else ""))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def get_page(self, pane=None):
        full = resolve_pane(pane)
        if full != pane:
            return self.redirect(f"/p/{full}" if full else "/")
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.html"), encoding="utf-8") as fh:
            html = fh.read()
        lang = Language.from_code(self.param("lang"), current(pane))
        values = {"KEY": pane, "I18N": {"lang": lang.code, "messages": messages(lang), "fallback": messages(DEFAULT)}, "TOKEN": TOKEN}
        html = _MARKERS.sub(lambda m: json.dumps(values[m.group(1)], ensure_ascii=False).replace("</", "<\\/"), html)
        self.send(200, html, "text/html; charset=utf-8")

    def get_health(self):
        self.json({"ok": True, "pid": os.getpid(), "app": APP_NAME, "root": ROOT})

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
        waiting = waiting_for(pane).since(snap["transcript"], qa_store.read_cursor(pane, snap["sid"])) if snap["sid"] else []
        self.json({"activity": snap, "flows": pane_flows, "pending": pending,
                   "qa": {"sid": snap["sid"], "turns": records, "pending": bool(qa_pending), "waiting": waiting,
                          "eta": eta_seconds(records), "auto": config.load(pane)["qa_auto"],
                          "counts": qa_store.counts(records)}})

    def get_flow(self, pane, flow_id):
        rec = read_json(flow_store.record_path(pane, flow_id))
        if not isinstance(rec, dict):
            return self.error(404, "err_not_found", pane=pane)
        self.json(rec)

    def _item_or_error(self, pane, item_id):
        """(record, item) for an item of the current session; sends the error response and returns None otherwise."""
        if not isinstance(item_id, str) or not ITEM_ID_RE.match(item_id):
            self.error(400, "err_need_id", pane=pane)
            return None
        sid = snapshot(pane)["sid"]
        found = qa_store.get_item(pane, sid, item_id) if sid else None
        if not found:
            self.error(404, "err_no_id", item_id, pane=pane)
        return found

    def get_diff(self, pane):
        snap = snapshot(pane)
        path = _allowed_path(self.param("path"), snap)
        view = self.param("view") or "auto"
        if not path or view not in diff.VIEWS:
            return self.error(400, "err_bad_request", pane=pane)
        self.json(diff.load(path, view))

    def post_override(self, pane):
        body = self.body()
        if body is None:
            return self.error(400, "err_bad_request", pane=pane)
        found = self._item_or_error(pane, body.get("id"))
        if not found:
            return
        status = ...
        if "status" in body:
            status = qa_store.Status.parse(body["status"])
            if body["status"] is not None and status is None:
                return self.error(400, "err_bad_request", pane=pane)
        archived = body.get("archived") if isinstance(body.get("archived"), bool) else None
        qa_store.set_override(pane, found[0].get("turn_id"), found[1].get("question", ""), status=status, archived=archived)
        self.json({"ok": True})

    def post_copy_question(self, pane):
        body = self.body()
        if body is None:
            return self.error(400, "err_bad_request", pane=pane)
        found = self._item_or_error(pane, body.get("id"))
        if not found:
            return
        question = " ".join(str(found[1].get("question", "")).split())
        message = t("ask_message", question, pane=pane)
        try:
            copied = subprocess.run(["/usr/bin/pbcopy"], input=message.encode("utf-8"), timeout=COPY_TIMEOUT).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            copied = False
        self.json({"copied": copied})

    def post_open(self, pane):
        mode = self.param("mode") if self.param("mode") in ("flow", "live", "qa") else ""
        subprocess.Popen(["/usr/bin/open", f"http://127.0.0.1:{PORT}/p/{pane}?full=1&t={TOKEN}" + (f"&mode={mode}" if mode else "")],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.json({"ok": True})

    def post_regen(self, pane):
        last = read_json(last_turn_path(pane))
        if not isinstance(last, dict) or not last.get("transcript"):
            return self.error(409, "err_no_turn", pane=pane)
        with _spawn_lock:
            return self._regen(pane, last)

    def _regen(self, pane, last):
        target = self.param("target")
        turn_id = self.param("turn")
        item = self.param("item")
        scope = self.param("scope")
        if not _valid_regen(target, turn_id, item, scope):
            return self.error(400, "err_bad_request", pane=pane)
        if item:
            found = self._item_or_error(pane, item)
            if not found:
                return
            turn_id = found[0].get("turn_id")
            last = {**last, "transcript": found[0].get("transcript") or last["transcript"]}
        marker = qa_store.pending_path(pane) if target == "qa" else flow_store.pending_path(pane)
        if Pending.active(marker):
            return self.error(409, "err_running", pane=pane)
        if target == "flow":
            command, args = "flow", [pane, last["transcript"], last.get("cwd") or ""]
        else:
            command, args = "qa", [pane, last["transcript"]] + ([turn_id] if turn_id else []) + ([f"--item={item}"] if item else [])
            if scope == SCOPE_OPEN:
                only = [tid for tid in (self.param("turns") or "").split(",") if tid]
                if not all(TURN_ID_RE.match(tid) for tid in only):
                    return self.error(400, "err_bad_request", pane=pane)
                args.append("--open-items" + (f"={','.join(only)}" if only else ""))
        with open(ANALYSIS_LOG, "a") as log:
            child = subprocess.Popen(command_line(command, [*args, "--force"]), env=child_env(),
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        Pending.claim(marker, child.pid)
        threading.Thread(target=child.wait, daemon=True).start()
        self.json({"ok": True})


def _absolute(path, cwd):
    path = os.path.expanduser(path)
    return os.path.realpath(path if os.path.isabs(path) or not cwd else os.path.join(cwd, path))


def _allowed_path(path, snap):
    """Only files this pane edited, or files under its working directory."""
    if not isinstance(path, str) or not path or "\0" in path:
        return None
    cwd = snap.get("cwd")
    full = _absolute(path, cwd)
    edited = {_absolute(f["path"], cwd) for f in snap.get("files") or []}
    root = os.path.realpath(cwd) if cwd else None
    return full if full in edited or (root and full.startswith(root + os.sep)) else None


def _valid_regen(target, turn_id, item, scope):
    if target not in REGEN_TARGETS:
        return False
    if (turn_id is not None and not TURN_ID_RE.match(turn_id)) or (item is not None and not ITEM_ID_RE.match(item)):
        return False
    if target == "flow":
        return not (turn_id or item or scope)
    if scope is not None:
        return scope == SCOPE_OPEN and not (turn_id or item)
    return not (turn_id and item)


ROUTES = [
    ("GET", [], Handler.get_page),
    ("GET", ["p", KEY_RE], Handler.get_page),
    ("GET", ["health"], Handler.get_health),
    ("GET", ["api", "config"], Handler.get_config),
    ("GET", ["api", "panes"], Handler.get_panes),
    ("GET", ["api", KEY_RE, "state"], Handler.get_state),
    ("GET", ["api", KEY_RE, "flow", FLOW_ID_RE], Handler.get_flow),
    ("GET", ["api", KEY_RE, "diff"], Handler.get_diff),
    ("POST", ["api", "config"], Handler.post_config),
    ("POST", ["api", KEY_RE, "qa", "override"], Handler.post_override),
    ("POST", ["api", KEY_RE, "open"], Handler.post_open),
    ("POST", ["api", KEY_RE, "qa", "copy"], Handler.post_copy_question),
    ("POST", ["api", KEY_RE, "regen"], Handler.post_regen),
]


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
