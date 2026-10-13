#!/usr/bin/env python3
"""List every question and request the user sent in a turn and whether Claude answered it.

usage: qa.py <pane> <transcript_path> [turn_id] [--item=<id>] [--force]
Without turn_id: the last turn, judged against its own replies, plus a re-check of earlier open items.
With turn_id: that turn, judged against every reply up to the end of the transcript.
With --item: only that item of the turn, judged against every reply up to the end of the transcript.
With --open-items: every open item of the session, each judged against every reply after it.
"""
import os
import sys
import time

import config
import qa_store
from claude_run import Pending, language_instruction, run_claude
from common import EDIT_TOOLS, atomic_write_json
from transcript import assistant_blocks, clip, is_prompt, load_entries, queued_prompt, text_of, turn_end, turn_start

MAX_REPLY = 40000
MAX_FOLLOWUPS = 20
MAX_OPEN_RECHECK = 40
TIMEOUT = 600
MAX_TURNS = 3
USER_LIMIT = 3000
MARKER_LIMIT = 300
ACTION_LIMIT = 120
MAX_ACTIONS = 80
FROM_PROMPT, FROM_MID_TURN = "prompt", "mid-turn"
STATUS_SCHEMA = {"type": "string", "enum": qa_store.STATUSES}

SCHEMA = {
    "type": "object",
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["question", "kind", "status", "answer"],
                "properties": {
                    "question": {"type": "string", "description": "One thing the user asked or requested, short, in the user's words"},
                    "kind": {"type": "string", "enum": ["question", "request"]},
                    "status": STATUS_SCHEMA,
                    "answer": {"type": "string", "description": "1 to 3 lines on what the agent said or did; for partial or unanswered, what is missing"},
                    "from": {"type": "string", "enum": [FROM_PROMPT, FROM_MID_TURN]},
                },
            },
        },
        "followups": {
            "type": "array",
            "description": "A new verdict for each item under 'Earlier open questions'. Empty if there are none",
            "items": {
                "type": "object",
                "required": ["id", "status", "answer"],
                "properties": {
                    "id": {"type": "string"},
                    "status": STATUS_SCHEMA,
                    "answer": {"type": "string", "description": "1 to 3 lines on the answer in this turn; empty if this turn did not address it"},
                },
            },
        },
    },
}

SYSTEM = """You check one turn of a conversation between a user and a coding agent, so that the user's questions do not get lost in long output.
1. From the user's messages (the first request and any messages sent while the agent worked) extract every question and request, one per item. Split a message that asks several things. Leave out reactions like "ok" or "thanks".
2. Judge each item from what the agent said and actually did. If the reply log continues into later turns, answers given there count too.
   - answered: the agent answered the question directly, or did the request and said so.
   - partial: only part was answered, or the work was done but the confirmation or explanation is missing.
   - unanswered: not mentioned, or the agent talked about something else.
   Be strict. If related work was done but no sentence answers what the user asked, it is partial.
3. answer summarizes in 1 to 3 lines, based only on what the agent actually said and did. Do not invent anything.
4. If there is an "Earlier open questions" list, judge each one only against this turn's replies and actions and put it in followups. Check whether what the earlier note said was missing is now covered. If this turn does not address it, keep the earlier status and leave answer empty.
Put the conclusion in **bold**, what is missing in ==highlight==, and identifiers in `backticks`.
Do not use the em dash (U+2014) or the middle dot (U+00B7)."""


def extract(path, turn_id=None):
    entries = load_entries(path)
    start = turn_start(entries, turn_id)
    if start is None:
        return None
    end = len(entries) if turn_id else turn_end(entries, start)
    first = entries[start]
    users = [(FROM_PROMPT, text_of(first["message"]["content"]))]
    replies, actions, in_later_turn = [], [], False
    for e in entries[start + 1:end]:
        if is_prompt(e):
            in_later_turn = True
            replies.append(f"(the user sent the next request here: {clip(text_of(e['message']['content']), MARKER_LIMIT)})")
            continue
        queued = queued_prompt(e)
        if queued:
            if not in_later_turn:
                users.append((FROM_MID_TURN, queued))
            replies.append(f"(the user sent a message here: {clip(queued, MARKER_LIMIT)})")
            continue
        for b in assistant_blocks([e]):
            inp = b.get("input") or {}
            if b["type"] == "text" and b.get("text", "").strip():
                replies.append(b["text"].strip())
            elif b.get("name") in EDIT_TOOLS:
                actions.append(f"{b['name']} {inp.get('file_path') or inp.get('notebook_path')}")
            elif b.get("name") == "Bash":
                actions.append(f"Bash: {inp.get('description') or clip(inp.get('command', ''), ACTION_LIMIT)}")
    reply_text = "\n\n".join(replies)
    if len(reply_text) > MAX_REPLY:
        reply_text = reply_text[:MAX_REPLY // 2] + "\n...(middle omitted)...\n" + reply_text[-MAX_REPLY // 2:]
    return {"turn_id": first.get("uuid"), "sid": first.get("sessionId"), "users": users,
            "replies": reply_text, "actions": actions[-MAX_ACTIONS:]}


def build_message(turn, candidates):
    users = "\n\n".join(f"[{'first request' if kind == FROM_PROMPT else 'sent while the agent worked'}]\n{clip(text, USER_LIMIT)}"
                        for kind, text in turn["users"])
    message = (f"## User messages\n{users}\n\n## What the agent did (tool calls)\n" + "\n".join(f"- {a}" for a in turn["actions"]) +
               f"\n\n## The agent's replies, in order\n{turn['replies']}")
    if candidates:
        message += "\n\n## Earlier open questions\n" + "\n".join(
            f"- id=p{n + 1} [{c['item'].get('status')}] {clip(c['item'].get('question', ''), MARKER_LIMIT)}\n"
            f"  earlier note: {clip(c['item'].get('answer', ''), MARKER_LIMIT)}" for n, c in enumerate(candidates))
    return message


def recheck_item(pane, transcript, turn_id, wanted_id, model):
    turn = extract(transcript, turn_id)
    found = turn and qa_store.get_item(pane, turn["sid"], wanted_id)
    if not found:
        return
    item = found[1]
    candidate = {"turn_id": turn_id, "key": qa_store.item_key(turn_id, item.get("question", "")), "item": item}
    message = build_message(turn, [candidate]) + (
        "\n\nOnly re-judge the earlier open question p1, against all replies above including later turns. Return items as an empty list.")
    with Pending(qa_store.pending_path(pane), item=wanted_id):
        try:
            data, _ = run_claude(SYSTEM + language_instruction(pane), SCHEMA, message, model, timeout=TIMEOUT, max_turns=MAX_TURNS)
        except (RuntimeError, OSError):
            return
        verdict = next((f for f in data.get("followups") or [] if isinstance(f, dict) and f.get("id") == "p1"), None)
        status = qa_store.Status.parse((verdict or {}).get("status"))
        if status:
            with qa_store.session_lock(pane, turn["sid"]):
                qa_store.set_verdict(pane, turn["sid"], turn_id, item.get("question", ""), status, verdict.get("answer"))


def recheck_open(pane, transcript, model):
    sid = (extract(transcript) or {}).get("sid")
    if not sid:
        return
    with qa_store.session_lock(pane, sid):
        candidates = qa_store.all_open_items(pane, sid, MAX_OPEN_RECHECK)
    if not candidates:
        return
    turn = extract(transcript, candidates[0]["turn_id"])
    if not turn:
        return
    message = build_message(turn, candidates) + (
        "\n\nOnly re-judge the earlier open questions, each against every reply that came after it, including later turns. "
        "Return items as an empty list.")
    with Pending(qa_store.pending_path(pane), scope="open"):
        try:
            data, _ = run_claude(SYSTEM + language_instruction(pane), SCHEMA, message, model, timeout=TIMEOUT, max_turns=MAX_TURNS)
        except (RuntimeError, OSError):
            return
        verdicts = {f.get("id"): f for f in data.get("followups") or [] if isinstance(f, dict)}
        with qa_store.session_lock(pane, sid):
            for n, cand in enumerate(candidates):
                verdict = verdicts.get(f"p{n + 1}") or {}
                status = qa_store.Status.parse(verdict.get("status"))
                if status and (status.value != cand["item"].get("status") or verdict.get("answer")):
                    qa_store.set_verdict(pane, sid, cand["turn_id"], cand["item"].get("question", ""), status, verdict.get("answer"))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) not in (2, 3):
        sys.exit(__doc__)
    pane, transcript = args[0], args[1]
    turn_id = args[2] if len(args) == 3 else None
    settings = config.load(pane)
    if not settings["qa_auto"] and "--force" not in sys.argv:
        return
    if "--open-items" in sys.argv:
        return recheck_open(pane, transcript, settings["model"])
    item = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--item=")), None)
    if item and turn_id:
        return recheck_item(pane, transcript, turn_id, item, settings["model"])
    turn = extract(transcript, turn_id)
    if not turn or not turn["turn_id"] or not any(text.strip() for _, text in turn["users"]):
        return
    record = {"turn_id": turn["turn_id"], "sid": turn["sid"], "ts": time.time(), "model": settings["model"],
              "transcript": transcript, "scope": "through-end" if turn_id else "turn", "prompt": turn["users"][0][1][:300]}
    os.makedirs(qa_store.pane_dir(pane), mode=0o700, exist_ok=True)
    with Pending(qa_store.pending_path(pane), turn=turn["turn_id"]):
        with qa_store.session_lock(pane, turn["sid"]):
            candidates = [] if turn_id else qa_store.open_items(pane, turn["sid"], turn["turn_id"], MAX_FOLLOWUPS)
        try:
            data, cost = run_claude(SYSTEM + language_instruction(pane), SCHEMA, build_message(turn, candidates),
                                    settings["model"], timeout=TIMEOUT, max_turns=MAX_TURNS)
            record.update(items=data.get("items", []), cost=cost, status="ok")
        except (RuntimeError, OSError) as exc:
            data = {}
            record.update(items=[], status="error", error=str(exc)[:1000])
        with qa_store.session_lock(pane, turn["sid"]):
            atomic_write_json(qa_store.record_path(pane, turn["sid"], turn["turn_id"]), record)
            if candidates and record["status"] == "ok":
                qa_store.apply_followups(pane, turn["sid"], candidates, data.get("followups"), turn["turn_id"])


if __name__ == "__main__":
    main()
