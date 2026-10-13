#!/usr/bin/env python3
"""List every question and request the user sent in a turn and whether Claude answered it.

usage: qa.py <pane> <transcript_path> [turn_id] [--item=<id> | --open-items[=turn,turn...]] [--force]
Without turn_id: everything since the previous check (prompts, messages sent mid-turn and replies), plus a re-check of
earlier open items against the new replies.
With turn_id: that turn, judged against every reply up to the end of the transcript.
With --item: only that item of the turn, judged against every reply up to the end of the transcript.
With --open-items[=turn,turn...]: every open item of the session (or of those turns), each judged against every reply after it.
"""
import os
import sys
import time

import config
import qa_store
from claude_run import Pending, language_instruction, run_claude
from common import EDIT_TOOLS, atomic_write_json
from transcript import (assistant_blocks, prompt_text, clip, is_prompt, load_entries, queued_prompt, text_of, turn_end, turn_start,
                        wait_until_written)

MAX_REPLY = 40000
MAX_FOLLOWUPS = 60
PROMPT_PREVIEW = 300
ERROR_LIMIT = 1000
FOLLOWUP_LIMIT = 160
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
   - answered: the reply directly answers what was asked, or the request was done and the agent said so. Judge only what the user asked for; do not require evidence, file paths, tool calls or verification the user did not ask for.
   - partial: part of a multi-part question or request is left out, or the answer is vague where the user asked for something specific.
   - unanswered: not mentioned, or the agent talked about something else.
3. answer summarizes in 1 to 3 lines, based only on what the agent actually said and did. Do not invent anything.
4. If there is an "Earlier open questions" list, judge each one only against this turn's replies and actions and put it in followups. Check whether what the earlier note said was missing is now covered. If this turn does not address it, keep the earlier status and leave answer empty.
Put the conclusion in **bold**, what is missing in ==highlight==, and identifiers in `backticks`.
Do not use the em dash (U+2014) or the middle dot (U+00B7)."""


def extract(path, turn_id):
    """The turn starting at entry turn_id, with every reply up to the end of the transcript."""
    entries = load_entries(path)
    start = turn_start(entries, turn_id)
    if start is None:
        return None
    return _segment(entries, start, len(entries), marker_for_later_prompts=True)


def _segment(entries, start, end, marker_for_later_prompts):
    users, replies, actions, first_uuid, in_later_turn = [], [], [], None, False
    for e in entries[start:end]:
        text = prompt_text(e) if is_prompt(e) else None
        queued = None if text else queued_prompt(e)
        if text or queued:
            if marker_for_later_prompts and users and text:
                in_later_turn = True
            if not in_later_turn:
                users.append((FROM_PROMPT if text else FROM_MID_TURN, text or queued))
                first_uuid = first_uuid or e.get("uuid")
            replies.append(f"(the user sent a message here: {clip(text or queued, MARKER_LIMIT)})")
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
    sid = next((e.get("sessionId") for e in reversed(entries) if e.get("sessionId")), None)
    last_uuid = next((e.get("uuid") for e in reversed(entries[:end]) if e.get("uuid")), None)
    return {"turn_id": first_uuid, "sid": sid, "users": users, "replies": reply_text,
            "actions": actions[-MAX_ACTIONS:], "last_uuid": last_uuid}


def extract_since(path, cursor):
    """Everything after the entry `cursor`; without a cursor, everything from the last prompt."""
    entries = load_entries(path)
    after = next((i + 1 for i, e in enumerate(entries) if cursor and e.get("uuid") == cursor), None)
    if after is None:
        after = turn_start(entries)
    return _segment(entries, after or 0, len(entries), marker_for_later_prompts=False) if entries else None


def build_message(turn, candidates):
    users = "\n\n".join(f"[{'request' if kind == FROM_PROMPT else 'sent while the agent worked'}]\n{clip(text, USER_LIMIT)}"
                        for kind, text in turn["users"]) or "(no new user messages; only re-judge the earlier open questions)"
    message = (f"## User messages\n{users}\n\n## What the agent did (tool calls)\n" + "\n".join(f"- {a}" for a in turn["actions"]) +
               f"\n\n## The agent's replies, in order\n{turn['replies']}")
    if candidates:
        message += "\n\n## Earlier open questions\n" + "\n".join(
            f"- id=p{n + 1} [{c['item'].get('status')}] {clip(c['item'].get('question', ''), FOLLOWUP_LIMIT)}\n"
            f"  earlier note: {clip(c['item'].get('answer', ''), FOLLOWUP_LIMIT)}" for n, c in enumerate(candidates))
    return message


def _judge(pane, message, model):
    return run_claude(SYSTEM + language_instruction(pane, keep="the question field"), SCHEMA, message, model,
                      tools=(), cwd=None, timeout=TIMEOUT, max_turns=MAX_TURNS)


def recheck_item(pane, transcript, turn_id, wanted_id, model):
    turn = extract(transcript, turn_id)
    found = turn and qa_store.get_item(pane, turn["sid"], wanted_id)
    if not found:
        return
    item = found[1]
    candidate = {"turn_id": turn_id, "item": item}
    message = build_message(turn, [candidate]) + (
        "\n\nOnly re-judge the earlier open question p1, against all replies above including later turns. Return items as an empty list.")
    with Pending(qa_store.pending_path(pane), item=wanted_id):
        try:
            data, _ = _judge(pane, message, model)
        except Exception as exc:  # noqa: BLE001
            print(f"qa item re-check failed: {exc}", file=sys.stderr)
            return
        verdict = next((f for f in data.get("followups") or [] if isinstance(f, dict) and f.get("id") == "p1"), None)
        status = qa_store.Status.parse((verdict or {}).get("status"))
        if status:
            with qa_store.session_lock(pane, turn["sid"]):
                qa_store.set_verdict(pane, turn["sid"], turn_id, item.get("question", ""), status, verdict.get("answer"))


def recheck_open(pane, transcript, model, turn_ids=None):
    sid = (extract_since(transcript, None) or {}).get("sid")
    if not sid:
        return
    with qa_store.session_lock(pane, sid):
        candidates = [c for c in qa_store.all_open_items(pane, sid, MAX_OPEN_RECHECK * 10)
                      if not turn_ids or c["turn_id"] in turn_ids][:MAX_OPEN_RECHECK]
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
            data, _ = _judge(pane, message, model)
        except Exception as exc:  # noqa: BLE001
            print(f"qa open re-check failed: {exc}", file=sys.stderr)
            return
        verdicts = {f.get("id"): f for f in data.get("followups") or [] if isinstance(f, dict)}
        with qa_store.session_lock(pane, sid):
            for n, cand in enumerate(candidates):
                verdict = verdicts.get(f"p{n + 1}") or {}
                status = qa_store.Status.parse(verdict.get("status"))
                old = qa_store.Status.parse(cand["item"].get("status"))
                if status and old and status.rank > old.rank:
                    qa_store.set_verdict(pane, sid, cand["turn_id"], cand["item"].get("question", ""), status, verdict.get("answer"))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    open_flag = next((a for a in sys.argv[1:] if a == "--open-items" or a.startswith("--open-items=")), None)
    item = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--item=")), None)
    if len(args) not in (2, 3) or (item and len(args) != 3) or (open_flag and (item or len(args) != 2)):
        sys.exit(__doc__)
    pane, transcript = args[0], args[1]
    turn_id = args[2] if len(args) == 3 else None
    settings = config.load(pane)
    if not settings["qa_auto"] and "--force" not in sys.argv:
        return
    if open_flag:
        turns = {t for t in open_flag.partition("=")[2].split(",") if t}
        return recheck_open(pane, transcript, settings["model"], turns or None)
    if item:
        return recheck_item(pane, transcript, turn_id, item, settings["model"])
    if turn_id:
        return judge_turn(pane, transcript, turn_id, settings["model"])
    wait_until_written(transcript)
    sid = (extract_since(transcript, None) or {}).get("sid")
    if not sid:
        return
    with qa_store.session_lock(pane, sid):
        cursor = qa_store.read_cursor(pane, sid)
    seg = extract_since(transcript, cursor)
    if not seg or not seg["last_uuid"]:
        return
    with qa_store.session_lock(pane, sid):
        candidates = qa_store.open_items(pane, sid, seg["turn_id"], MAX_FOLLOWUPS)
    if not seg["users"] and (not candidates or not seg["replies"]):
        with qa_store.session_lock(pane, sid):
            qa_store.write_cursor(pane, sid, seg["last_uuid"])
        return
    record = {"turn_id": seg["turn_id"], "sid": sid, "ts": time.time(), "model": settings["model"], "transcript": transcript,
              "scope": "turn", "prompt": seg["users"][0][1][:PROMPT_PREVIEW] if seg["users"] else ""}
    with Pending(qa_store.pending_path(pane), turn=seg["turn_id"] or ""):
        try:
            data, cost = _judge(pane, build_message(seg, candidates), settings["model"])
            record.update(items=data.get("items", []), cost=cost, status="ok")
        except Exception as exc:  # noqa: BLE001
            data = {}
            record.update(items=[], status="error", error=str(exc)[:ERROR_LIMIT])
        with qa_store.session_lock(pane, sid):
            if seg["users"]:
                atomic_write_json(qa_store.record_path(pane, sid, seg["turn_id"]), record)
            if record["status"] == "ok":
                if candidates:
                    qa_store.apply_followups(pane, sid, candidates, data.get("followups"), seg["turn_id"] or seg["last_uuid"])
                qa_store.write_cursor(pane, sid, seg["last_uuid"])


def judge_turn(pane, transcript, turn_id, model):
    turn = extract(transcript, turn_id)
    if not turn or not turn["users"]:
        return
    record = {"turn_id": turn_id, "sid": turn["sid"], "ts": time.time(), "model": model, "transcript": transcript,
              "scope": "through-end", "prompt": turn["users"][0][1][:PROMPT_PREVIEW]}
    with Pending(qa_store.pending_path(pane), turn=turn_id):
        try:
            data, cost = _judge(pane, build_message(turn, []), model)
            record.update(items=data.get("items", []), cost=cost, status="ok")
        except Exception as exc:  # noqa: BLE001
            record.update(items=[], status="error", error=str(exc)[:ERROR_LIMIT])
        with qa_store.session_lock(pane, turn["sid"]):
            atomic_write_json(qa_store.record_path(pane, turn["sid"], turn_id), record)

if __name__ == "__main__":
    main()
