"""Paths, ids and file helpers shared by the server, the turn workers and the CLI."""
import json
import os
import re
import tempfile
import threading

BASE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("CLAUDE_PANEL_PORT", "47821"))
KEY_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79}$")
ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
EDIT_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit"})
_KEY_BYTES = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")


def data_dir(*parts):
    path = os.path.join(BASE, *parts)
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def pane_key(raw=None):
    """Same rule as key.sh panel_key: bytes outside [A-Za-z0-9_.-] become _, last 80, no leading dot."""
    raw = raw if raw is not None else (os.environ.get("CMUX_PANEL_ID") or os.environ.get("ORCA_PANE_KEY") or "")
    key = bytes(b if b in _KEY_BYTES else ord("_") for b in raw.encode("utf-8"))[-80:].decode("ascii")
    return "_" + key[1:] if key.startswith(".") else key


def safe_name(value, fallback="unknown"):
    return re.sub(r"[^A-Za-z0-9-]", "", str(value or ""))[:60] or fallback


def atomic_write_json(path, obj):
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


_CACHE = {}
_CACHE_LOCK = threading.Lock()


def read_json(path, default=None):
    """Parsed JSON, re-read only when the file's mtime or size changes."""
    try:
        st = os.stat(path)
    except OSError:
        return default
    stamp = (st.st_mtime_ns, st.st_size)
    with _CACHE_LOCK:
        hit = _CACHE.get(path)
        if hit and hit[0] == stamp:
            return hit[1]
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
    except (OSError, ValueError):
        return default
    with _CACHE_LOCK:
        _CACHE[path] = (stamp, value)
    return value


def json_files(directory):
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    return [os.path.join(directory, n) for n in names if n.endswith(".json") and not n.startswith(".")]


def process_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False
