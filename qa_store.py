"""Where Q&A records live and how items are identified, overridden and re-judged."""
import fcntl
import hashlib
import os
import threading
import time
from contextlib import contextmanager
from enum import Enum

from common import BASE, atomic_write_json, json_files, read_json, safe_name


class Status(Enum):
    UNANSWERED = "unanswered"
    PARTIAL = "partial"
    ANSWERED = "answered"

    @property
    def rank(self):
        return list(Status).index(self)

    @classmethod
    def parse(cls, value):
        return next((s for s in cls if s.value == value), None)


STATUSES = [s.value for s in Status]
_OVERRIDES_LOCK = threading.Lock()


def pane_dir(pane):
    return os.path.join(BASE, "qa", pane)


def session_dir(pane, sid):
    return os.path.join(pane_dir(pane), safe_name(sid))


def record_path(pane, sid, turn_id):
    return os.path.join(session_dir(pane, sid), f"{safe_name(turn_id)}.json")


def pending_path(pane):
    return os.path.join(pane_dir(pane), "pending")


def item_key(turn_id, question):
    return f"{turn_id}::{' '.join(str(question).split())}"


def item_id(turn_id, question):
    return hashlib.sha1(item_key(turn_id, question).encode("utf-8")).hexdigest()[:8]


def records(pane, sid):
    found = [r for r in (read_json(p) for p in json_files(session_dir(pane, sid))) if isinstance(r, dict)]
    return sorted(found, key=lambda r: -(r.get("ts") or 0))


def overrides(pane):
    data = read_json(os.path.join(pane_dir(pane), "overrides.json"), {})
    return data if isinstance(data, dict) else {}


def with_overrides(pane, recs):
    """Copies of the records with id, auto_status, manual and archived filled in per item."""
    ovr = overrides(pane)
    out = []
    for rec in recs:
        items = []
        for item in rec.get("items") or []:
            o = ovr.get(item_key(rec.get("turn_id"), item.get("question", "")), {})
            manual = Status.parse(o.get("status"))
            items.append({**item, "id": item_id(rec.get("turn_id"), item.get("question", "")), "auto_status": item.get("status"),
                          "status": manual.value if manual else item.get("status"), "manual": bool(manual),
                          "archived": bool(o.get("archived"))})
        out.append({**rec, "items": items})
    return out


def find_item(pane, sid, wanted_id):
    for rec in records(pane, sid):
        for item in rec.get("items") or []:
            if item_id(rec.get("turn_id"), item.get("question", "")) == wanted_id:
                return rec.get("turn_id"), item.get("question", "")
    return None


def set_override(pane, turn_id, question, status=..., archived=None):
    """status: a Status value, None to return to the model's verdict, or ... to leave it unchanged."""
    key = item_key(turn_id, question)
    path = os.path.join(pane_dir(pane), "overrides.json")
    with _OVERRIDES_LOCK:
        data = dict(overrides(pane))
        entry = dict(data.get(key, {}))
        if status is not ...:
            if status is None:
                entry.pop("status", None)
            else:
                entry["status"] = status.value
        if archived is not None:
            entry["archived"] = archived
        if entry.get("status") or entry.get("archived"):
            data[key] = entry
        else:
            data.pop(key, None)
        atomic_write_json(path, data)


@contextmanager
def session_lock(pane, sid):
    directory = session_dir(pane, sid)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    with open(os.path.join(directory, ".lock"), "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def open_items(pane, sid, current_turn, limit):
    """Unanswered or partial items from earlier turns, minus archived or manually set ones, newest first."""
    ovr = overrides(pane)
    found = []
    for rec in records(pane, sid):
        if rec.get("turn_id") == current_turn:
            continue
        for item in rec.get("items") or []:
            key = item_key(rec.get("turn_id"), item.get("question", ""))
            if item.get("status") in (Status.PARTIAL.value, Status.UNANSWERED.value) and not ovr.get(key):
                found.append({"turn_id": rec["turn_id"], "key": key, "item": item})
    return found[:limit]


def apply_followups(pane, sid, candidates, followups, resolved_in):
    """Raise the status of earlier items that a later turn answered. Never lowers a status."""
    by_id = {f.get("id"): f for f in followups or [] if isinstance(f, dict)}
    upgrades = {}
    for n, cand in enumerate(candidates):
        verdict = by_id.get(f"p{n + 1}")
        new, old = Status.parse((verdict or {}).get("status")), Status.parse(cand["item"].get("status"))
        if new and old and new.rank > old.rank:
            upgrades.setdefault(cand["turn_id"], {})[cand["key"]] = (new, verdict.get("answer"))
    for turn_id, changes in upgrades.items():
        path = record_path(pane, sid, turn_id)
        rec = read_json(path)
        if not isinstance(rec, dict):
            continue
        for item in rec.get("items") or []:
            change = changes.get(item_key(turn_id, item.get("question", "")))
            if change:
                item.setdefault("first_status", item.get("status"))
                item["status"] = change[0].value
                if change[1]:
                    item["answer"] = change[1]
                item["resolved_in"], item["resolved_at"] = resolved_in, time.time()
        atomic_write_json(path, rec)
