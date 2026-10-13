"""Running a headless `claude -p` for the analyses, and the marker that shows one is in progress."""
import json
import os
import signal
import subprocess
import time

from common import atomic_write_json, process_alive, read_json
from i18n import current

STALE_AFTER = 1800


def language_instruction(pane):
    name = current(pane).prompt_name
    return f"\n\nWrite every text field in {name}. Keep code excerpts, identifiers, file names and commands as they are."


def run_claude(system, schema, message, model, tools=(), cwd=None, timeout=600, max_turns=40):
    """Returns (structured_output, cost). Raises RuntimeError when no structured output came back."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CMUX_", "ORCA_"))}
    env["CLAUDE_ACTIVITY_CHILD"] = "1"
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
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        raise RuntimeError(f"timed out after {timeout}s")
    try:
        result = json.loads(out or "{}")
    except ValueError:
        result = {}
    data = result.get("structured_output")
    if not data:
        raise RuntimeError(result.get("result") or err[-500:] or "no structured output")
    return data, result.get("total_cost_usd")


class Pending:
    """A marker file that exists while an analysis runs. Readers treat it as stale if its process is gone."""

    def __init__(self, path, **info):
        self.path = path
        self.info = info

    def __enter__(self):
        atomic_write_json(self.path, {"pid": os.getpid(), "since": time.time(), **self.info})
        return self

    def __exit__(self, *_):
        current_marker = read_json(self.path, {})
        if current_marker.get("pid") == os.getpid():
            try:
                os.remove(self.path)
            except OSError:
                pass

    @staticmethod
    def active(path):
        marker = read_json(path)
        if not isinstance(marker, dict):
            return None
        fresh = time.time() - float(marker.get("since") or 0) < STALE_AFTER
        return marker if fresh and process_alive(marker.get("pid")) else None
