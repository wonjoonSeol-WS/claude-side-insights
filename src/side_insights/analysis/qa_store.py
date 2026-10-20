"""Where Q&A records live and how items are identified, overridden and re-judged."""
import hashlib
import os
import threading
import time
from contextlib import contextmanager
from enum import Enum

from side_insights.paths import DATA, atomic_write_json, json_files, read_json, safe_name
from side_insights.system import FileLock


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
    return os.path.join(DATA, "qa", pane)


def session_dir(pane, sid):
    return os.path.join(pane_dir(pane), safe_name(sid))


def record_path(pane, sid, turn_id):
    return os.path.join(session_dir(pane, sid), f"{safe_name(turn_id)}.json")


def cursor_path(pane, sid):
    return os.path.join(session_dir(pane, sid), "cursor")


def read_cursor(pane, sid):
    try:
        with open(cursor_path(pane, sid), encoding="utf-8") as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def write_cursor(pane, sid, entry_uuid):
    os.makedirs(session_dir(pane, sid), mode=0o700, exist_ok=True)
    tmp = cursor_path(pane, sid) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(entry_uuid)
    os.replace(tmp, cursor_path(pane, sid))


def pending_path(pane):
    return os.path.join(pane_dir(pane), "pending")


def item_key(turn_id, question):
    return f"{turn_id}::{' '.join(str(question).split())}"


def item_id(turn_id, question):
    return hashlib.sha1(item_key(turn_id, question).encode("utf-8")).hexdigest()[:8]


def turn_time(record):
    """When the turn behind a record started, else when it was checked."""
    return record.get("turn_ts") or record.get("ts") or 0


def records(pane, sid):
    found = [r for r in (read_json(p) for p in json_files(session_dir(pane, sid))) if isinstance(r, dict)]
    return sorted(found, key=lambda r: -turn_time(r))


def item_overrides(pane):
    data = read_json(os.path.join(pane_dir(pane), "overrides.json"), {})
    return data if isinstance(data, dict) else {}


def with_overrides(pane, recs):
    """Copies of the records with id, auto_status, manual and archived filled in per item."""
    ovr = item_overrides(pane)
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


def get_item(pane, sid, wanted_id):
    for rec in records(pane, sid):
        for item in rec.get("items") or []:
            if item_id(rec.get("turn_id"), item.get("question", "")) == wanted_id:
                return rec, item
    return None


def set_override(pane, turn_id, question, status=..., archived=None):
    """status: a Status value, None to return to the model's verdict, or ... to leave it unchanged."""
    key = item_key(turn_id, question)
    path = os.path.join(pane_dir(pane), "overrides.json")
    with _OVERRIDES_LOCK:
        data = dict(item_overrides(pane))
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
    with FileLock(os.path.join(directory, ".lock")):
        yield


def open_items(pane, sid, current_turn, limit=None):
    """Unanswered or partial items from earlier turns, minus archived or manually set ones, newest first."""
    ovr = item_overrides(pane)
    found = []
    for rec in records(pane, sid):
        if rec.get("turn_id") == current_turn:
            continue
        for item in rec.get("items") or []:
            key = item_key(rec.get("turn_id"), item.get("question", ""))
            if item.get("status") in (Status.PARTIAL.value, Status.UNANSWERED.value) and not ovr.get(key):
                found.append({"turn_id": rec["turn_id"], "key": key, "item": item})
    return found[:limit]


def counts(overridden_records):
    """Answered, partial, unanswered, open and total counts over the non-archived items of records from with_overrides."""
    items = [i for rec in overridden_records for i in rec.get("items") or [] if not i.get("archived")]
    by = {s: sum(1 for i in items if i.get("status") == s.value) for s in Status}
    return {"answered": by[Status.ANSWERED], "partial": by[Status.PARTIAL], "unanswered": by[Status.UNANSWERED],
            "open": by[Status.PARTIAL] + by[Status.UNANSWERED], "total": len(items)}


def all_open_items(pane, sid):
    """Every unanswered or partial item of the session, minus archived or manually set ones, oldest turn first."""
    started = {rec.get("turn_id"): turn_time(rec) for rec in records(pane, sid)}
    return sorted(open_items(pane, sid, None), key=lambda c: started.get(c["turn_id"], 0))


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
            current = Status.parse(item.get("status"))
            if change and (current is None or change[0].rank > current.rank):
                _set_status(item, *change)
                item["resolved_in"], item["resolved_at"] = resolved_in, time.time()
        atomic_write_json(path, rec)


def _set_status(item, status, answer):
    item.setdefault("first_status", item.get("status"))
    item["status"] = status.value
    if answer:
        item["answer"] = answer


def set_verdict(pane, sid, turn_id, question, status, answer, upgrade_only=False):
    path = record_path(pane, sid, turn_id)
    rec = read_json(path)
    if not isinstance(rec, dict):
        return
    key = item_key(turn_id, question)
    for item in rec.get("items") or []:
        current = Status.parse(item.get("status"))
        if item_key(turn_id, item.get("question", "")) == key and not (upgrade_only and current and status.rank <= current.rank):
            _set_status(item, status, answer)
            item["rechecked_at"] = time.time()
            item.pop("resolved_in", None)
    atomic_write_json(path, rec)
