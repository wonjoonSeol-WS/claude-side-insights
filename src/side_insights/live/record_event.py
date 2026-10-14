"""usage: python3 -m side_insights record-event < hook.json

The same lines hooks/record.jq prints, for machines without jq: the event JSON, and for a Stop with a transcript
the turn JSON, the transcript path and the working folder."""
import json
import re
import sys
import time

SUMMARY_KEYS = ("description", "command", "pattern", "url", "query", "prompt", "skill", "file_path", "path")
SUMMARY_MAX = 300
REASON_MAX = 600
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
SPACES = re.compile(r"\s+")


def _first(*values):
    return next((v for v in values if v is not None and v is not False), None)


def _text(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _clean(value, limit):
    text = SPACES.sub(" ", CONTROL.sub(" ", _text(value)))
    return text[:limit] + "…" if len(text) > limit else text


def _failed(response):
    if not isinstance(response, dict):
        return False
    return any(v is True or (isinstance(v, str) and v) for v in (response.get("is_error"), response.get("error")))


def lines(hook, now=None):
    tool_input = hook.get("tool_input") or {}
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    response = hook.get("tool_response")
    event = hook.get("hook_event_name")
    if event == "PostToolUseFailure":
        error, reason = True, _first(hook.get("error"), "")
    elif event == "PostToolUse":
        error = _failed(response)
        reason = _first(response.get("error"), response.get("stderr"), "") if isinstance(response, dict) else ""
    else:
        error, reason = None, ""
    record = {
        "ts": time.time() if now is None else now,
        "ev": event,
        "sid": hook.get("session_id"),
        "cwd": hook.get("cwd"),
        "transcript": hook.get("transcript_path"),
        "id": hook.get("tool_use_id"),
        "tool": hook.get("tool_name"),
        "file": _first(tool_input.get("file_path"), tool_input.get("notebook_path")),
        "summary": _clean(_first(*(tool_input.get(k) for k in SUMMARY_KEYS), ""), SUMMARY_MAX),
        "kind": _first(response.get("type")) if isinstance(response, dict) else None,
        "error": error,
        "reason": _clean(reason, REASON_MAX),
    }
    out = [json.dumps(record, ensure_ascii=False, separators=(",", ":"))]
    transcript = _first(hook.get("transcript_path"), "")
    if event == "Stop" and transcript != "":
        turn = {"transcript": transcript, "cwd": _first(hook.get("cwd"), "")}
        out += [json.dumps(turn, ensure_ascii=False, separators=(",", ":")), str(turn["transcript"]), str(turn["cwd"])]
    return out


if __name__ == "__main__":
    try:
        hook = json.load(sys.stdin)
    except ValueError:
        sys.exit(1)
    if not isinstance(hook, dict):
        sys.exit(1)
    sys.stdout.write("\n".join(lines(hook)) + "\n")
