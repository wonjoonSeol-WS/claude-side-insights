"""Reading Claude Code transcript JSONL: which entries are the user's prompts and what each turn contains."""
import json
import re

SKILL_PREAMBLE = "Base directory for this skill"
_WRAPPER_RE = re.compile(r"^<(command-|local-command-|bash-|task-notification|system-reminder|user-prompt-submit-hook)")
_NOT_A_PROMPT_PREFIXES = ("[Request interrupted", SKILL_PREAMBLE)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _is_user_text(text):
    stripped = text.strip()
    return bool(stripped) and not _WRAPPER_RE.match(stripped) and not stripped.startswith(_NOT_A_PROMPT_PREFIXES)


def is_prompt(entry):
    if entry.get("type") != "user" or any(entry.get(f) for f in ("isMeta", "isSidechain", "isCompactSummary", "isVisibleInTranscriptOnly")):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        return False
    return _is_user_text(text_of(content))


def queued_prompt(entry):
    """Text of a message the user typed while Claude was working (a queued_command attachment)."""
    att = entry.get("attachment") if entry.get("type") == "attachment" else None
    if not isinstance(att, dict) or att.get("type") != "queued_command" or (att.get("origin") or {}).get("kind") != "human":
        return None
    text = text_of(att.get("prompt")).strip()
    return text if _is_user_text(text) else None


def load_entries(path):
    entries = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                entries.append(json.loads(line))
            except ValueError:
                pass
    return entries


def turn_start(entries, turn_id=None):
    """Index of the prompt that starts the given turn, or of the last turn."""
    if turn_id:
        return next((i for i, e in enumerate(entries) if e.get("uuid") == turn_id and is_prompt(e)), None)
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
    """(type, block) for each text and tool_use block Claude wrote, skipping subagent entries."""
    for e in entries:
        content = (e.get("message") or {}).get("content")
        if e.get("type") == "assistant" and not e.get("isSidechain") and isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") in ("text", "tool_use"):
                    yield b
