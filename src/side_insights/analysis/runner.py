"""Running a headless `claude -p` for the analyses, and the marker that shows one is in progress."""
import json
import os
import signal
import subprocess
import time

import fcntl

from side_insights.paths import CHILD_ENV, atomic_write_json, process_alive, read_json, terminal_settings

STALE_AFTER = 1800
_PARENT_PREFIXES = ("CLAUDE_CODE_MESSAGING_", *terminal_settings("CHILD_ENV_PREFIX"))
_PARENT_VARS = {*terminal_settings("PANE_ENV"), "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_BRIDGE_SESSION_ID",
                "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SSE_PORT", "CLAUDE_PID", "CLAUDE_EFFORT"}


def run_claude(system, schema, message, model, tools, cwd, timeout, max_turns):
    """Returns (structured_output, cost). Raises RuntimeError when no structured output came back."""
    env = {k: v for k, v in os.environ.items() if k not in _PARENT_VARS and not k.startswith(_PARENT_PREFIXES)}
    env[CHILD_ENV] = "1"
    tool_list = ",".join(tools)
    cmd = ["claude", "-p", "--model", model, "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
           "--system-prompt", system, "--no-session-persistence", "--output-format", "json", "--tools", tool_list,
           "--max-turns", str(max_turns), "--json-schema", json.dumps(schema, ensure_ascii=False)]
    if tools:
        cmd += ["--allowedTools", tool_list]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            cwd=cwd if cwd and os.path.isdir(cwd) else None, env=env, start_new_session=True)
    try:
        out, err = proc.communicate(message, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.communicate()
        raise RuntimeError(f"timed out after {timeout}s")
    try:
        result = json.loads(out or "{}")
    except ValueError:
        result = {}
    result = result if isinstance(result, dict) else {}
    data = result.get("structured_output")
    if not isinstance(data, dict):
        detail = " ".join(str(x) for x in (result.get("subtype"), result.get("result")) if x)
        raise RuntimeError(detail or err[-500:] or "no structured output")
    return data, result.get("total_cost_usd")


class Pending:
    """A marker file that exists while an analysis runs. Readers treat it as stale if its process is gone."""

    def __init__(self, path, **info):
        self.path = path
        self.info = info
        self.lock = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        self.lock = open(self.path + ".lock", "w")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX)
        except BaseException:
            self.lock.close()
            raise
        atomic_write_json(self.path, {"pid": os.getpid(), "since": time.time(), **self.info})
        return self

    def __exit__(self, *_):
        marker = read_json(self.path, {})
        if isinstance(marker, dict) and marker.get("pid") == os.getpid():
            try:
                os.remove(self.path)
            except OSError:
                pass
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.lock.close()

    @staticmethod
    def claim(path, pid):
        atomic_write_json(path, {"pid": pid, "since": time.time()})

    @staticmethod
    def active(path):
        marker = read_json(path)
        if not isinstance(marker, dict):
            return None
        try:
            fresh = time.time() - float(marker.get("since") or 0) < STALE_AFTER
        except (TypeError, ValueError):
            return None
        return marker if fresh and process_alive(marker.get("pid")) else None
