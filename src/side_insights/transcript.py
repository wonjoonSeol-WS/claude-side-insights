"""Reading Claude Code transcript JSONL: which entries are the user's prompts and what each turn contains."""
import json
import os
import re
import time

_SKILL_PREAMBLE = "Base directory for this skill"
_WRAPPER_RE = re.compile(r"^<(command-|local-command-|bash-|task-notification|system-reminder|user-prompt-submit-hook)")
_NOT_A_PROMPT_PREFIXES = ("[Request interrupted", _SKILL_PREAMBLE)
_COMMAND_RE = re.compile(r"^\s*<command-name>\s*(/?[^<\s]+)\s*</command-name>.*?<command-args>(.*?)</command-args>", re.S)
_LOCAL_OUTPUT = "<local-command-stdout>"
LOCAL_COMMANDS = {"/add-dir", "/agents", "/clear", "/compact", "/config", "/context", "/cost", "/doctor", "/exit",
                  "/help", "/hooks", "/ide", "/login", "/logout", "/mcp", "/memory", "/model", "/permissions",
                  "/plugin", "/resume", "/rewind", "/status", "/statusline", "/theme", "/vim"}


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def prompt_text(entry):
    """What the user typed: plain text, or "/command args" for a slash command typed with arguments."""
    text = text_of((entry.get("message") or {}).get("content")).strip()
    command = _COMMAND_RE.search(text)
    if command and command.group(2).strip():
        name = command.group(1) if command.group(1).startswith("/") else "/" + command.group(1)
        return f"{name} {command.group(2).strip()}"
    return text


def _is_user_text(text):
    stripped = text.strip()
    return bool(stripped) and not _WRAPPER_RE.match(stripped) and not stripped.startswith(_NOT_A_PROMPT_PREFIXES)


def is_prompt(entry):
    if entry.get("type") != "user" or any(entry.get(f) for f in ("isMeta", "isSidechain", "isCompactSummary", "isVisibleInTranscriptOnly")):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        return False
    return _is_user_text(prompt_text(entry))


def queued_prompt(entry):
    """Text of a message the user typed while Claude was working (a queued_command attachment)."""
    att = entry.get("attachment") if entry.get("type") == "attachment" else None
    if not isinstance(att, dict) or att.get("type") != "queued_command" or (att.get("origin") or {}).get("kind") != "human":
        return None
    if att.get("commandMode", "prompt") != "prompt":
        return None
    text = text_of(att.get("prompt")).strip()
    return text if _is_user_text(text) else None


def _has_reply(entries):
    start = turn_start(entries)
    return start is not None and any(True for _ in assistant_blocks(entries[start + 1:]))


def wait_until_written(path, quiet=1.0, limit=15.0, poll=0.25):
    """Claude Code can fire the Stop hook before the final reply reaches the file. Waits for a reply and a quiet file."""
    deadline = time.time() + limit
    checked_mtime = None
    while time.time() < deadline:
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            return
        if time.time() - mtime >= quiet and mtime != checked_mtime:
            if _has_reply(load_entries(path)):
                return
            checked_mtime = mtime
        time.sleep(poll)


def load_entries(path):
    entries = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict):
                    entries.append(entry)
    except OSError:
        return []
    _drop_local_commands(entries)
    return entries


def command_name(entry):
    if entry.get("type") != "user":
        return None
    command = _COMMAND_RE.search(text_of((entry.get("message") or {}).get("content")) or "")
    return command.group(1) if command else None


def is_local_output(entry):
    return _LOCAL_OUTPUT in text_of((entry.get("message") or {}).get("content"))


def is_local_command(entry, following=None):
    """Slash commands Claude Code runs itself (/model, /plugin ...) are followed by local output, not by Claude."""
    name = command_name(entry)
    return bool(name) and (name in LOCAL_COMMANDS or (following is not None and is_local_output(following)))


def _drop_local_commands(entries):
    for i, entry in enumerate(entries):
        if is_local_command(entry, entries[i + 1] if i + 1 < len(entries) else None):
            entry["isMeta"] = True


def turn_start(entries, turn_id=None):
    """Index of the prompt that starts the given turn, or of the last turn."""
    if turn_id:
        return next((i for i, e in enumerate(entries) if e.get("uuid") == turn_id), None)
    return max((i for i, e in enumerate(entries) if is_prompt(e)), default=None)


def turn_end(entries, start):
    return next((i for i in range(start + 1, len(entries)) if is_prompt(entries[i])), len(entries))


def clip(value, limit):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= limit else f"{text[:limit]}\n...(+{len(text) - limit} chars)"


def tool_results(entries):
    results = {}
    for e in entries:
        content = (e.get("message") or {}).get("content")
        if e.get("type") == "user" and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    results[b.get("tool_use_id")] = b
    return results


def assistant_blocks(entries):
    for e in entries:
        content = (e.get("message") or {}).get("content")
        if e.get("type") == "assistant" and not e.get("isSidechain") and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") in ("text", "tool_use"):
                    yield b
