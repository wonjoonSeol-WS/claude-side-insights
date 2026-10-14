"""End-to-end check that the /si Q&A jump scrolls the real chat, including the fallback after a refused first target.

It starts Claude Code in a pseudo terminal on a throwaway pane, sends one prompt and a long paste (two short model
calls, each interrupted), stores a Q&A record whose turn id does not exist, opens /si and presses m. It passes when
the prompt is back at the top of the chat. It needs the panel server running and a trusted folder (CAPTURE_CWD).

usage: jump_probe.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("SIDE_INSIGHTS_DATA") or os.path.expanduser("~/.claude/side-insights")
PORT = os.environ.get("SIDE_INSIGHTS_PORT") or "47821"
PANE = "jumpprobe"
PROMPT = "jump fallback probe seven, please ignore"
FILLER = "".join(f"filler line {i}\\n" for i in range(70))
CHAT_COLUMNS = 90


def configure(value):
    with open(os.path.join(DATA, "token")) as fh:
        token = fh.read().strip()
    request = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/config?pane={PANE}", method="POST",
                                     data=json.dumps({"qa_auto": value, "flow_auto": value}).encode(),
                                     headers={"X-Side-Insights": token, "Content-Type": "application/json"})
    urllib.request.urlopen(request, timeout=5).read()


def record(sid):
    folder = os.path.join(DATA, "qa", PANE, sid)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "probe.json"), "w") as fh:
        json.dump({"turn_id": str(uuid.UUID(int=9)), "sid": sid, "ts": 1, "model": "probe", "scope": "turn", "status": "ok",
                   "prompt": PROMPT, "items": [{"question": PROMPT, "kind": "request", "status": "partial", "from": "prompt",
                                                "answer": "Probe answer."}]}, fh)


def run(press_m):
    sid = str(uuid.uuid4())
    record(sid)
    out = os.path.join(tempfile.mkdtemp(), "screen.json")
    keys = [PROMPT, "\\r", "sleep:2", "\\x1b", "sleep:3", f"\\x1b[200~{FILLER}\\x1b[201~", "sleep:1", "\\r", "sleep:2", "\\x1b",
            "sleep:10", "/si", "sleep:1", "\\r", "sleep:5", "3", "sleep:2", "m" if press_m else "sleep:0.1", "sleep:3"]
    env = dict(os.environ, CLAUDE_ARGS=f"--session-id {sid}")
    subprocess.run([sys.executable, os.path.join(HERE, "drive.py"), "200", "50", PANE, out, *keys], env=env, check=True)
    with open(out) as fh:
        rows = ["".join(cell[0] for cell in row)[:CHAT_COLUMNS] for row in json.load(fh)]
    return any(PROMPT in row for row in rows[:5])


def cleanup():
    configure(None)
    shutil.rmtree(os.path.join(DATA, "qa", PANE), ignore_errors=True)
    for path in (os.path.join(DATA, "logs", f"{PANE}.jsonl"), os.path.join(DATA, "turns", f"{PANE}.json")):
        if os.path.exists(path):
            os.remove(path)


if __name__ == "__main__":
    configure(False)
    try:
        before, after = run(False), run(True)
    finally:
        cleanup()
    print(f"prompt at the top without m: {before}, after m: {after}")
    sys.exit(0 if after and not before else 1)
