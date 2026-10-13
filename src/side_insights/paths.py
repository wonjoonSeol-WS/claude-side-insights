"""Where code and data live, ids, and file helpers shared by the server, the turn workers and the CLI."""
import copy
import glob
import json
import os
import re
import secrets
import tempfile
import threading

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(PACKAGE_DIR))
DATA = os.environ.get("SIDE_INSIGHTS_DATA") or os.path.join(os.path.expanduser("~"), ".claude", "side-insights")
DEFAULT_PORT = 47821
_port = os.environ.get("SIDE_INSIGHTS_PORT") or os.environ.get("CLAUDE_PANEL_PORT", "")
PORT = int(_port) if _port.isdigit() and 1024 <= int(_port) <= 65535 else DEFAULT_PORT
KEY_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$")
TURN_ID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}$")
ITEM_ID_RE = re.compile(r"^[0-9a-f]{8}$")
TOKEN_PATH = os.path.join(DATA, "token")
APP_NAME = "side-insights"
CHILD_ENV = "SIDE_INSIGHTS_CHILD"
TOKEN_HEADER = "X-Side-Insights"
ANALYSIS_LOG = os.path.join(DATA, "analysis.log")
EDIT_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit"})
_KEY_BYTES = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")


def last_turn_path(pane):
    """Transcript path and cwd of the pane's last finished turn, written by hooks/record.sh."""
    return os.path.join(DATA, "turns", f"{pane}.json")


def data_dir(*parts):
    path = os.path.join(DATA, *parts)
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


_ADAPTER_SETTING = re.compile(r"^(PANE_ENV|CHILD_ENV_PREFIX)=(\w+)\s*$", re.M)


def terminal_settings(name):
    """Values of PANE_ENV or CHILD_ENV_PREFIX declared by the adapters in terminals/, in adapter order."""
    values = []
    for path in sorted(glob.glob(os.path.join(ROOT, "terminals", "*.sh"))):
        with open(path, encoding="utf-8") as fh:
            values += [value for key, value in _ADAPTER_SETTING.findall(fh.read()) if key == name]
    return values


def pane_key(raw=None):
    """Same sanitising as key.sh panel_key: bytes outside [A-Za-z0-9_.-] become _, last 80, no leading dot or dash.
    Without raw it reads the adapters' PANE_ENV, then CLAUDE_CODE_SESSION_ID (the hooks use the hook's session_id instead)."""
    if raw is None:
        raw = next((os.environ[var] for var in terminal_settings("PANE_ENV") if os.environ.get(var)),
                   os.environ.get("CLAUDE_CODE_SESSION_ID", ""))
    raw_bytes = raw.encode("utf-8", "surrogateescape")
    key = bytes(b if b in _KEY_BYTES else ord("_") for b in raw_bytes)[-80:].decode("ascii")
    return "_" + key[1:] if key[:1] in (".", "-") else key


def read_token():
    try:
        with open(TOKEN_PATH, encoding="utf-8") as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def api_token():
    """Reads the token, creating it on first use; concurrent first runs agree on one file."""
    token = read_token()
    if token:
        return token
    os.makedirs(DATA, mode=0o700, exist_ok=True)
    os.chmod(DATA, 0o700)
    try:
        fd = os.open(TOKEN_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return read_token()
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(secrets.token_urlsafe(24))
    return read_token()


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
        with _CACHE_LOCK:
            _CACHE.pop(path, None)
        return default
    stamp = (st.st_mtime_ns, st.st_size)
    with _CACHE_LOCK:
        hit = _CACHE.get(path)
        if hit and hit[0] == stamp:
            return copy.deepcopy(hit[1])
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
    except (OSError, ValueError):
        return default
    with _CACHE_LOCK:
        _CACHE[path] = (stamp, value)
    return copy.deepcopy(value)


def json_files(directory):
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    return [os.path.join(directory, n) for n in names if n.endswith(".json") and not n.startswith(".")]


def process_alive(pid):
    try:
        pid = int(pid)
        os.kill(pid, 0)
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False
    try:
        return os.waitpid(pid, os.WNOHANG) == (0, 0)
    except ChildProcessError:
        return True
