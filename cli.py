#!/usr/bin/env python3
"""claude-qa: read and update this pane's Q&A (current session) through the local panel server.

  claude-qa [list] [--open]             questions with id and status
  claude-qa set <id> answered|partial|unanswered|auto
  claude-qa archive <id> | restore <id>
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from i18n import t  # noqa: E402

PORT = os.environ.get("CLAUDE_PANEL_PORT", "47821")
STATUSES = ("answered", "partial", "unanswered")


def pane_key():
    raw = os.environ.get("CMUX_PANEL_ID") or os.environ.get("ORCA_PANE_KEY") or os.environ.get("CLAUDE_PANEL_KEY") or ""
    return re.sub(r"[^A-Za-z0-9_.-]", "_", raw)[-80:]


def call(method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "X-Claude-Panel": "1"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        sys.exit(json.load(exc).get("error") or str(exc))
    except urllib.error.URLError:
        sys.exit(t("server_down"))


def main():
    key = pane_key()
    if not key:
        sys.exit(t("no_pane"))
    args = sys.argv[1:] or ["list"]
    cmd = args[0]
    if cmd == "list":
        only_open = "--open" in args
        data = call("GET", f"/api/{key}/qa")
        for turn in reversed(data.get("turns", [])):
            items = [i for i in turn.get("items", []) if not i.get("archived") and (not only_open or i["status"] != "answered")]
            if not items:
                continue
            print(f"\n# {turn.get('prompt', '')[:70]}")
            for i in items:
                flag = t("manual") if i.get("manual") else ""
                print(f"  {i['id']}  {t('st_' + i['status']) if i['status'] in STATUSES else i['status']}{flag}  {i['question']}")
    elif cmd == "set" and len(args) == 3 and args[2] in (*STATUSES, "auto"):
        call("POST", f"/api/{key}/qa/override", {"id": args[1], "status": None if args[2] == "auto" else args[2]})
        print(f"{args[1]} -> {args[2]}")
    elif cmd in ("archive", "restore") and len(args) == 2:
        call("POST", f"/api/{key}/qa/override", {"id": args[1], "archived": cmd == "archive"})
        print(f"{args[1]} {cmd}d")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
