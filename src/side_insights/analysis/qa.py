#!/usr/bin/env python3
"""List every question and request the user sent in a turn and whether Claude answered it.

usage: python3 -m side_insights qa <pane> <transcript_path> [turn_id] [--item=<id> | --open-items[=turn,turn...] | --older=<turn_id>] [--force]
Without turn_id: everything since the previous check (prompts, messages sent mid-turn and replies), plus a re-check of
earlier open items against the new replies.
With turn_id: that turn, judged against every reply up to the end of the transcript.
With --item: only that item of the turn, judged against every reply up to the end of the transcript.
With --open-items[=turn,turn...]: every open item of the session (or of those turns), each judged against every reply after it.
With --older=<turn_id>: the next turns that the check recorded under turn_id skipped, at most 10 per run.
Without turn_id, a check covers at most the 10 latest unchecked turns; older ones are noted on that record for --older.
"""
import sys
import time

from side_insights import config
from side_insights.analysis import qa_store
from side_insights.analysis.runner import Pending, run_claude
from side_insights.i18n import language_instruction
from side_insights.records import RecordStatus, Source
from side_insights.paths import EDIT_TOOLS, atomic_write_json, read_json
from side_insights.transcript import (assistant_blocks, clip, is_prompt, load_entries, prompt_text, queued_prompt, turn_start,
                        wait_until_written)

MAX_REPLY = 60000
REPLY_PER_TURN = 4000
MIN_WINDOW = 2000
MAX_WINDOW = 8000
MAX_FOLLOWUPS = 60
PROMPT_PREVIEW = 2000
ERROR_LIMIT = 1000
FOLLOWUP_LIMIT = 160
MAX_OPEN_RECHECK = 40
MAX_PENDING_TURNS = 30
TIMEOUT = 600
MAX_TURNS = 3
USER_LIMIT = 3000
MARKER_LIMIT = 300
ACTION_LIMIT = 120
MAX_ACTIONS = 80
SCOPE_TURN, SCOPE_THROUGH_END = "turn", "through-end"
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
                    "answer": {"type": "string", "description": "At most two short sentences on what the agent said or did; for partial or unanswered, what is missing"},
                    "from": {"type": "string", "enum": [Source.PROMPT.value, Source.MID_TURN.value]},
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
3. answer: at most two short sentences, based only on what the agent actually said and did. Do not invent anything. For partial or unanswered, say plainly what is missing.
4. If there is an "Earlier open questions" list, judge each one only against this turn's replies and actions and put it in followups. Check whether what the earlier note said was missing is now covered. If this turn does not address it, keep the earlier status and leave answer empty.
Put the conclusion in **bold**, what is missing in ==highlight==, and identifiers in `backticks`.
Write for a person skimming the panel, not for a machine:
- Lead with the point in one short sentence, then add detail only if it helps.
- Use plain, everyday words and natural phrasing for the output language; avoid stiff or translated-sounding sentences.
- Leave out internal ids, hashes, uuids, session or turn ids, transcript entry numbers, character counts and timestamps unless the reader needs them to act.
- Name code (functions, files, commands) only when it helps the reader find or understand something.
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
                users.append((Source.PROMPT if text else Source.MID_TURN, text or queued))
                first_uuid = first_uuid or e.get("uuid")
            replies.append((True, f"(the user sent a message here: {clip(text or queued, MARKER_LIMIT)})"))
            continue
        for b in assistant_blocks([e]):
            inp = b.get("input") or {}
            if b["type"] == "text" and b.get("text", "").strip():
                replies.append((False, b["text"].strip()))
            elif b.get("name") in EDIT_TOOLS:
                actions.append(f"{b['name']} {inp.get('file_path') or inp.get('notebook_path')}")
            elif b.get("name") == "Bash":
                actions.append(f"Bash: {inp.get('description') or clip(inp.get('command', ''), ACTION_LIMIT)}")
    reply_text = _fit_replies(replies, max(MAX_REPLY, len(users) * REPLY_PER_TURN))
    sid = next((e.get("sessionId") for e in reversed(entries) if e.get("sessionId")), None)
    last_uuid = next((e.get("uuid") for e in reversed(entries[:end]) if e.get("uuid")), None)
    return {"turn_id": first_uuid, "sid": sid, "users": users, "replies": reply_text,
            "actions": actions[-MAX_ACTIONS:], "last_uuid": last_uuid}


def _fit_replies(replies, budget=MAX_REPLY):
    """Keeps every user marker, the replies right after each one, and the latest replies; drops the rest."""
    full = "\n\n".join(text for _, text in replies)
    if len(full) <= budget:
        return full
    markers = [i for i, (is_marker, _) in enumerate(replies) if is_marker]
    window = max(MIN_WINDOW, min(MAX_WINDOW, budget // (len(markers) + 2)))
    keep = set(markers)
    for start in markers:
        used = 0
        for i in range(start + 1, len(replies)):
            if replies[i][0] or used >= window:
                break
            keep.add(i)
            used += len(replies[i][1])
    used = sum(len(replies[i][1]) for i in keep)
    for i in range(len(replies) - 1, -1, -1):
        if used >= budget:
            break
        if i not in keep:
            keep.add(i)
            used += len(replies[i][1])
    out, skipped = [], False
    for i, (_, text) in enumerate(replies):
        if i in keep:
            out.append(clip(text, window) if not replies[i][0] else text)
            skipped = False
        elif not skipped:
            out.append("...(omitted)...")
            skipped = True
    return "\n\n".join(out)


def extract_since(path, cursor, limit=MAX_PENDING_TURNS):
    """Everything after the entry `cursor` (the whole session without one), at most its last `limit` prompts."""
    entries = load_entries(path)
    if not entries:
        return None
    after = next((i + 1 for i, e in enumerate(entries) if cursor and e.get("uuid") == cursor), 0)
    prompts = [i for i in range(after, len(entries)) if is_prompt(entries[i]) and prompt_text(entries[i])]
    skipped = max(0, len(prompts) - limit)
    seg = _segment(entries, prompts[skipped] if skipped else after, len(entries), marker_for_later_prompts=False)
    return {**seg, "skipped": skipped, "skipped_after": cursor}


def build_message(turn, candidates):
    users = "\n\n".join(f"[{'request' if kind == Source.PROMPT else 'sent while the agent worked'}]\n{clip(text, USER_LIMIT)}"
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
        candidates = [c for c in qa_store.all_open_items(pane, sid)
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
                if status:
                    qa_store.set_verdict(pane, sid, cand["turn_id"], cand["item"].get("question", ""), status,
                                         verdict.get("answer"), upgrade_only=True)


def _record(turn_id, sid, model, transcript, scope, users):
    return {"turn_id": turn_id, "sid": sid, "ts": time.time(), "model": model, "transcript": transcript,
            "scope": scope, "prompt": users[0][1][:PROMPT_PREVIEW] if users else ""}


def _judge_into(record, pane, message, model):
    try:
        data, cost = _judge(pane, message, model)
        record.update(items=data.get("items", []), cost=cost, status=RecordStatus.OK.value)
        return data
    except Exception as exc:  # noqa: BLE001
        record.update(items=[], status=RecordStatus.ERROR.value, error=str(exc)[:ERROR_LIMIT])
        return {}


def judge_since_cursor(pane, transcript, model, started=None):
    """started: when the turn ended, to record how long the check took; None for manual runs."""
    wait_until_written(transcript)
    sid = (extract_since(transcript, None) or {}).get("sid")
    if not sid:
        return
    with Pending(qa_store.pending_path(pane)):
        with qa_store.session_lock(pane, sid):
            seg = extract_since(transcript, qa_store.read_cursor(pane, sid), config.load(pane)["qa_batch"])
            candidates = qa_store.open_items(pane, sid, seg and seg["turn_id"], MAX_FOLLOWUPS)
        if not seg or not seg["last_uuid"]:
            return
        if not seg["users"] and (not candidates or not seg["replies"]):
            with qa_store.session_lock(pane, sid):
                qa_store.write_cursor(pane, sid, seg["last_uuid"])
            return
        record = _record(seg["turn_id"], sid, model, transcript, SCOPE_TURN, seg["users"])
        if seg.get("skipped"):
            record.update(skipped_turns=seg["skipped"], skipped_after=seg.get("skipped_after"))
        data = _judge_into(record, pane, build_message(seg, candidates), model)
        with qa_store.session_lock(pane, sid):
            if seg["users"]:
                if started and record["status"] == RecordStatus.OK.value:
                    record["seconds"] = round(time.time() - started, 1)
                atomic_write_json(qa_store.record_path(pane, sid, seg["turn_id"]), record)
            if record["status"] == RecordStatus.OK.value:
                qa_store.apply_followups(pane, sid, candidates, data.get("followups"), seg["turn_id"] or seg["last_uuid"])
                qa_store.write_cursor(pane, sid, seg["last_uuid"])


def judge_older(pane, transcript, turn_id, model, limit=MAX_PENDING_TURNS):
    """Checks the next `limit` turns that an earlier check of turn_id skipped, nearest first."""
    entries = load_entries(transcript)
    end = turn_start(entries, turn_id)
    sid = next((e.get("sessionId") for e in reversed(entries) if e.get("sessionId")), None)
    newer = read_json(qa_store.record_path(pane, sid, turn_id)) if sid and end is not None else None
    if not isinstance(newer, dict) or not newer.get("skipped_turns"):
        return
    cursor = newer.get("skipped_after")
    start = next((i + 1 for i, e in enumerate(entries[:end]) if cursor and e.get("uuid") == cursor), 0)
    prompts = [i for i in range(start, end) if is_prompt(entries[i]) and prompt_text(entries[i])]
    chunk = prompts[-limit:]
    if chunk:
        seg = _segment(entries, chunk[0], end, marker_for_later_prompts=False)
        record = _record(seg["turn_id"], sid, model, transcript, SCOPE_TURN, seg["users"])
        if len(prompts) > len(chunk):
            record.update(skipped_turns=len(prompts) - len(chunk), skipped_after=cursor)
        with Pending(qa_store.pending_path(pane), older=turn_id):
            _judge_into(record, pane, build_message(seg, []), model)
    with qa_store.session_lock(pane, sid):
        if chunk:
            atomic_write_json(qa_store.record_path(pane, sid, record["turn_id"]), record)
        newer.pop("skipped_turns", None)
        newer.pop("skipped_after", None)
        atomic_write_json(qa_store.record_path(pane, sid, turn_id), newer)


def judge_turn(pane, transcript, turn_id, model):
    turn = extract(transcript, turn_id)
    if not turn or not turn["users"]:
        return
    record = _record(turn_id, turn["sid"], model, transcript, SCOPE_THROUGH_END, turn["users"])
    with Pending(qa_store.pending_path(pane)):
        _judge_into(record, pane, build_message(turn, []), model)
        with qa_store.session_lock(pane, turn["sid"]):
            atomic_write_json(qa_store.record_path(pane, turn["sid"], turn_id), record)


def main():
    started = time.time()
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    open_flag = next((a for a in sys.argv[1:] if a == "--open-items" or a.startswith("--open-items=")), None)
    item = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--item=")), None)
    older = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--older=")), None)
    if len(args) not in (2, 3) or (item and len(args) != 3) or (open_flag and (item or len(args) != 2)) or (older and len(args) != 2):
        sys.exit(__doc__)
    pane, transcript = args[0], args[1]
    turn_id = args[2] if len(args) == 3 else None
    settings = config.load(pane)
    if not config.runs("qa", pane) and "--force" not in sys.argv:
        return
    if older:
        judge_older(pane, transcript, older, settings["model"], settings["qa_batch"])
    elif open_flag:
        turns = {tid for tid in open_flag.partition("=")[2].split(",") if tid}
        recheck_open(pane, transcript, settings["model"], turns or None)
    elif item:
        recheck_item(pane, transcript, turn_id, item, settings["model"])
    elif turn_id:
        judge_turn(pane, transcript, turn_id, settings["model"])
    else:
        judge_since_cursor(pane, transcript, settings["model"], None if "--force" in sys.argv else started)


if __name__ == "__main__":
    main()
