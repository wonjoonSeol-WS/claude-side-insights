"""File diffs for the browser panel, the same views the /si pane shows: working tree, last commit, whole file."""
import os
import re
import subprocess

MAX_DIFF_LINES = 400
GIT_TIMEOUT = 5
VIEWS = ("auto", "working", "commit", "file")
HUNK = re.compile(r"^@@ ")
HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$")
NOT_A_REPO = re.compile(r"not a git repository", re.I)


def _recount(hunk):
    header = HUNK_HEADER.match(hunk[0] if hunk else "")
    if not header:
        return hunk
    body = hunk[1:]
    old = sum(1 for line in body if not line.startswith(("+", "\\")))
    added = sum(1 for line in body if not line.startswith(("-", "\\")))
    return [f"@@ -{header[1]},{old} +{header[2]},{added} @@{header[3]}", *body]


def trim_hunks(text, limit=MAX_DIFF_LINES):
    lines = text.split("\n")
    start = next((i for i, line in enumerate(lines) if HUNK.match(line)), -1)
    if start < 0:
        return "", 0
    body = lines[start:]
    while body and body[-1] == "":
        body.pop()
    if len(body) <= limit:
        return "\n".join(body), 0
    end = next((i for i in range(limit, 0, -1) if HUNK.match(body[i])), 0)
    if not end:
        return "\n".join(_recount(body[:limit])), len(body) - limit
    return "\n".join(body[:end]), len(body) - end


def _git(cwd, *args):
    try:
        done = subprocess.run(["git", "-C", cwd, "-c", "color.ui=never", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", *args],
                              capture_output=True, text=True, errors="replace", timeout=GIT_TIMEOUT)
        return done.returncode, done.stdout, done.stderr
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, "", str(exc)


def _first_line(text):
    return (text or "").strip().split("\n")[0].strip() or None


def _none(error=None):
    return {"source": "none", "hunks": "", "cut": 0, **({"error": error} if error else {})}


def _file(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().split("\n")
    except OSError as exc:
        return _none(exc.strerror or str(exc))
    return {"source": "file", "hunks": "", "text": "\n".join(lines[:MAX_DIFF_LINES]), "cut": max(0, len(lines) - MAX_DIFF_LINES)}


def _commit(cwd, path):
    code, out, err = _git(cwd, "log", "-1", "--no-ext-diff", "--no-textconv", "-p", "--format=%h %s", "--", path)
    hunks, cut = trim_hunks(out)
    if code == 0 and hunks:
        return {"source": "commit", "commit": _first_line(out), "hunks": hunks, "cut": cut}
    return _none(_first_line(err))


def _changes(cwd, path):
    code, out, err = _git(cwd, "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", path)
    hunks, cut = trim_hunks(out)
    if code == 0 and hunks:
        return {"source": "working", "hunks": hunks, "cut": cut}, False
    tracked_code, _, tracked_err = _git(cwd, "ls-files", "--error-unmatch", "--", path)
    if NOT_A_REPO.search(tracked_err) or NOT_A_REPO.search(err):
        return _none(_first_line(tracked_err or err)), True
    if tracked_code != 0:
        _, added, _ = _git(cwd, "diff", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", path)
        hunks, cut = trim_hunks(added)
        if hunks:
            return {"source": "new", "hunks": hunks, "cut": cut}, False
    return _none(_first_line(err)), False


def load(path, view="auto"):
    """The diff of an absolute path, picked like the /si pane: working changes, else the last commit, else the file."""
    cwd = os.path.dirname(path) or "/"
    if view == "file":
        return _file(path)
    if view == "commit":
        return _commit(cwd, path)
    diff, outside = _changes(cwd, path)
    if view == "working" or diff["source"] != "none":
        return diff
    if outside:
        return _file(path)
    commit = _commit(cwd, path)
    return _none(diff.get("error") or commit.get("error")) if commit["source"] == "none" else commit
