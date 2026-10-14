"""Requests to the local panel server, shared by the terminal panel and si-qa."""
import http.client
import json
import urllib.error
import urllib.parse
import urllib.request

from side_insights.i18n import t
from side_insights.paths import PORT, TOKEN_HEADER, read_token
from side_insights.system import copy_text

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
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
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


def regen(pane, target, item=None, turn=None, scope=None, turns=None):
    params = {k: v for k, v in (("target", target), ("item", item), ("turn", turn), ("scope", scope),
                                ("turns", ",".join(turns) if turns else None)) if v}
    return call("POST", f"/api/{pane}/regen", params=params)


def copy_question(pane, question):
    return copy_text(t("ask_message", " ".join(str(question or "").split()), pane=pane))
