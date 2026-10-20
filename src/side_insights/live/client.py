"""Requests to the local panel server, shared by the terminal panel and si-qa."""
import http.client
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

from side_insights.config import ALL_SESSIONS
from side_insights.i18n import t
from side_insights.paths import PORT, TOKEN_HEADER, read_token
from side_insights.system import copy_text, local_urlopen

TIMEOUT = 5


class ServerError(Exception):
    """message is the server's own error text, or None when the server could not be reached."""

    def __init__(self, message=None):
        super().__init__(message or "")
        self.message = message


def call(method, path, body=None, params=None):
    query = f"?{urllib.parse.urlencode(params)}" if params else ""
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}{query}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", TOKEN_HEADER: read_token() or ""})
    try:
        with local_urlopen(req, timeout=TIMEOUT) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        try:
            payload = json.load(exc)
        except ValueError:
            payload = None
        raise ServerError((payload.get("error") if isinstance(payload, dict) else None) or str(exc)) from None
    except (urllib.error.URLError, http.client.HTTPException, ConnectionError, ValueError):
        raise ServerError() from None


def set_status(pane, item_id, status):
    """status: a status value, or None to go back to the automatic verdict."""
    return call("POST", f"/api/{pane}/qa/override", {"id": item_id, "status": status})


def set_archived(pane, item_id, archived):
    return call("POST", f"/api/{pane}/qa/override", {"id": item_id, "archived": archived})


def regen(pane, target, item=None, turn=None, scope=None, turns=None, new=False):
    params = {k: v for k, v in (("target", target), ("item", item), ("turn", turn), ("scope", scope),
                                ("turns", ",".join(turns) if turns else None), ("new", "1" if new else None)) if v}
    return call("POST", f"/api/{pane}/regen", params=params)


def copy_question(pane, question):
    return copy_text(t("ask_message", " ".join(str(question or "").split()), pane=pane))


def enable(pane):
    """Switch the pane's analysis on, as opening /si does, and check what is already there unless every session is analyzed."""
    before = call("GET", "/api/config", params={"pane": pane})
    if (before.get("pane") or {}).get("enabled") is True:
        return
    call("POST", "/api/config", {"enabled": True}, params={"pane": pane})
    shared = before.get("global") or {}
    if shared.get("analyze") == ALL_SESSIONS:
        return
    for target in ("qa", "flow"):
        if shared.get(f"{target}_auto"):
            try:
                regen(pane, target, new=target == "flow")
            except ServerError:
                pass


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "enable":
        sys.exit("usage: python3 -m side_insights client enable <pane>")
    try:
        enable(sys.argv[2])
    except ServerError as exc:
        sys.exit(exc.message or t("server_down"))
