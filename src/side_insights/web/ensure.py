"""usage: python3 -m side_insights ensure-server

Starts the panel server unless one from this copy of the code already answers, replacing one from another copy."""
import json
import os
import subprocess
import sys
import time
import urllib.request

from side_insights.launch import child_env, command_line
from side_insights.paths import APP_NAME, DATA, PORT, ROOT
from side_insights.system import spawn_detached, terminate

LEGACY_APP = "claude-panel"
HEALTH_TIMEOUT = 1
WAIT_STEP = 0.1
STOP_WAIT = 2
START_WAIT = 5


def health():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=HEALTH_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _normal(path):
    return os.path.normcase(os.path.realpath(path))


def same_root(root):
    return isinstance(root, str) and _normal(root) == _normal(ROOT)


def wait(done, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if done():
            return True
        time.sleep(WAIT_STEP)
    return done()


def ensure():
    found = health()
    if found and found.get("app") in (APP_NAME, LEGACY_APP):
        if same_root(found.get("root")):
            return True
        terminate(found.get("pid"))
        wait(lambda: health() is None, STOP_WAIT)
    os.makedirs(DATA, mode=0o700, exist_ok=True)
    with open(os.path.join(DATA, "server.log"), "a") as log:
        spawn_detached(command_line("server", []), env=child_env(), stdin=subprocess.DEVNULL, stdout=log, stderr=log)
    return wait(lambda: (health() or {}).get("app") == APP_NAME, START_WAIT)


if __name__ == "__main__":
    sys.exit(0 if ensure() else 1)
