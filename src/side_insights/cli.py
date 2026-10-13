#!/usr/bin/env python3
"""claude-qa: read and update this pane's Q&A (current session) through the local panel server.

  claude-qa [list] [--open]             questions with id and status
  claude-qa set <id> answered|partial|unanswered|auto
  claude-qa archive <id> | restore <id>
"""
import http.client
import json
import sys
import urllib.error
import urllib.request

from side_insights.paths import PORT, pane_key, read_token
from side_insights.i18n import t
from side_insights.analysis.qa_store import STATUSES, Status

AUTO = "auto"
TIMEOUT = 5


def call(method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "X-Claude-Panel": read_token() or ""})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        try:
            body = json.load(exc)
        except ValueError:
            body = None
        message = body.get("error") if isinstance(body, dict) else None
        sys.exit(message or str(exc))
    except (urllib.error.URLError, http.client.HTTPException, ConnectionError, ValueError):
        sys.exit(t("server_down"))


def list_items(pane, only_open):
    data = call("GET", f"/api/{pane}/state")
    for turn in reversed(data.get("qa", {}).get("turns", [])):
        items = [i for i in turn.get("items", []) if not i.get("archived") and not (only_open and i.get("status") == Status.ANSWERED.value)]
        if items:
            print(f"\n# {(turn.get('prompt') or '')[:70]}")
        for item in items:
            status = item.get("status")
            label = t("st_" + status, pane=pane) if status in STATUSES else status
            print(f"  {item.get('id')}  {label}{t('manual', pane=pane) if item.get('manual') else ''}  {item.get('question')}")


def main():
    pane = pane_key()
    if not pane:
        sys.exit(t("no_pane"))
    args = sys.argv[1:]
    command = args[0] if args and not args[0].startswith("--") else "list"
    if command == "list":
        list_items(pane, "--open" in args)
    elif command == "set" and len(args) == 3 and args[2] in (*STATUSES, AUTO):
        call("POST", f"/api/{pane}/qa/override", {"id": args[1], "status": None if args[2] == AUTO else args[2]})
        print(t("cli_set", args[1], t("st_" + args[2], pane=pane) if args[2] in STATUSES else args[2], pane=pane))
    elif command in ("archive", "restore") and len(args) == 2:
        call("POST", f"/api/{pane}/qa/override", {"id": args[1], "archived": command == "archive"})
        print(t("cli_" + command + "d", args[1], pane=pane))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
