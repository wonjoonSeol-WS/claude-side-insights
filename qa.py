#!/usr/bin/env python3
"""List every question/request the user sent in the last turn and whether Claude answered it.

usage: qa.py <key> <transcript_path> [--force]
Writes ~/.claude/activity-panel/qa/<key>/<turn-id>.json.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402
from i18n import output_language_instruction  # noqa: E402
from flow import EDIT_TOOLS, clip, is_prompt, last_prompt_index, load_entries, queued_prompt, text_of  # noqa: E402

BASE = os.path.expanduser("~/.claude/activity-panel")
MAX_REPLY = 40000

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
                    "question": {"type": "string", "description": "사용자가 묻거나 요청한 것 하나, 사용자의 언어로 짧게"},
                    "kind": {"type": "string", "enum": ["question", "request"]},
                    "status": {"type": "string", "enum": ["answered", "partial", "unanswered"]},
                    "answer": {"type": "string", "description": "에이전트의 답 또는 한 일 요약 1~3줄. partial/unanswered 면 무엇이 빠졌는지"},
                    "from": {"type": "string", "enum": ["prompt", "mid-turn"]},
                },
            },
        },
    },
}

FOLLOWUP_SCHEMA = {
    "type": "array",
    "description": "'이전 턴에서 답을 못 받은 질문' 각각에 대한 재판정. 목록이 없으면 빈 배열",
    "items": {
        "type": "object",
        "required": ["id", "status", "answer"],
        "properties": {
            "id": {"type": "string"},
            "status": {"type": "string", "enum": ["answered", "partial", "unanswered"]},
            "answer": {"type": "string", "description": "이번 턴에서 나온 답 요약 1~3줄. 이번 턴에 언급이 없으면 빈 문자열"},
        },
    },
}
SCHEMA["properties"]["followups"] = FOLLOWUP_SCHEMA
STATUS_RANK = {"unanswered": 0, "partial": 1, "answered": 2}
MAX_FOLLOWUPS = 20

SYSTEM = """당신은 사용자와 코딩 에이전트의 대화 한 턴을 점검한다. 사용자의 질문이 긴 출력에 묻혀 답을 못 받는 일을 막는 것이 목적이다.
1. 사용자 메시지(처음 요청과 작업 중에 추가로 보낸 메시지)에서 질문과 요청을 하나씩 빠짐없이 뽑는다. 한 메시지에 여러 개가 있으면 나눈다. "ok", "thanks" 같은 반응은 뺀다.
2. 각 항목마다 에이전트의 답변과 실제로 한 일을 보고 판정한다. 답변 기록에 이후 턴이 이어져 있으면 그 뒤에 나온 답도 인정한다.
   - answered: 질문에 직접 답했거나 요청을 수행하고 그렇다고 밝혔다.
   - partial: 일부만 답했거나, 수행했지만 확인/설명이 빠졌다.
   - unanswered: 언급이 없거나 다른 얘기만 했다.
   엄격하게 판정한다. 관련 작업을 했더라도 사용자가 물은 '질문'에 대한 답이 문장으로 없으면 partial 이다.
3. answer 는 에이전트가 실제로 한 말과 행동만 근거로 1~3줄 요약한다. 지어내지 않는다.
4. '이전 턴에서 답을 못 받은 질문' 목록이 있으면 각각을 이번 턴의 답변과 한 일만 보고 다시 판정해 followups 에 넣는다. 이전 메모에서 빠졌다고 한 부분이 이번 턴에 채워졌는지 본다. 이번 턴에 언급이 없으면 이전 상태를 그대로 쓰고 answer 는 빈 문자열.
   결론은 **굵게**, 빠진 부분은 ==강조==, 식별자는 `백틱` 으로 쓴다.
em-dash(—)와 가운뎃점(·)은 쓰지 않는다."""


def extract(path, turn_id=None):
    """Last turn by default. With turn_id: that turn's messages, judged against replies up to the end of the transcript."""
    entries = load_entries(path)
    if turn_id:
        start = next((i for i, e in enumerate(entries) if e.get("uuid") == turn_id and is_prompt(e)), None)
    else:
        start = last_prompt_index(entries)
    if start is None:
        return None
    prompt_entry = entries[start]
    users = [("prompt", text_of(prompt_entry["message"]["content"]))]
    replies, actions = [], []
    later = False
    for e in entries[start + 1:]:
        if e.get("isSidechain"):
            continue
        if is_prompt(e):
            later = True
            replies.append(f"(여기서 사용자가 다음 요청을 보냄: {clip(text_of(e['message']['content']), 300)})")
            continue
        q = queued_prompt(e)
        if q and later:
            replies.append(f"(여기서 사용자가 추가 메시지를 보냄: {clip(q, 200)})")
            continue
        if q:
            users.append(("mid-turn", q))
            replies.append(f"(여기서 사용자가 추가 메시지를 보냄: {clip(q, 200)})")
            continue
        content = (e.get("message") or {}).get("content")
        if e.get("type") != "assistant" or not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and b.get("text", "").strip():
                replies.append(b["text"].strip())
            elif b.get("type") == "tool_use":
                inp = b.get("input") or {}
                if b.get("name") in EDIT_TOOLS:
                    actions.append(f"{b['name']} {inp.get('file_path') or inp.get('notebook_path')}")
                elif b.get("name") == "Bash":
                    actions.append(f"Bash: {inp.get('description') or clip(inp.get('command', ''), 120)}")
    reply_text = "\n\n".join(replies)
    if len(reply_text) > MAX_REPLY:
        reply_text = reply_text[:MAX_REPLY // 2] + "\n…(중략)…\n" + reply_text[-MAX_REPLY // 2:]
    return {
        "turn_id": prompt_entry.get("uuid") or str(start),
        "sid": prompt_entry.get("sessionId"),
        "users": users,
        "replies": reply_text,
        "actions": actions[-80:],
    }


def item_key(turn_id, question):
    return f"{turn_id}::{' '.join(str(question).split())}"


def session_dir(key, sid):
    safe = "".join(c for c in str(sid or "unknown") if c.isalnum() or c == "-")[:60] or "unknown"
    return os.path.join(BASE, "qa", key, safe)


def open_items(out_dir, sid, current_turn):
    """Unanswered/partial items from earlier turns of this session (out_dir), minus archived or manually set ones."""
    try:
        with open(os.path.join(os.path.dirname(out_dir), "overrides.json"), encoding="utf-8") as fh:
            overrides = json.load(fh)
    except (OSError, ValueError):
        overrides = {}
    found = []
    for name in os.listdir(out_dir):
        if not name.endswith(".json") or name.startswith(".") or name == "overrides.json":
            continue
        try:
            with open(os.path.join(out_dir, name), encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        if rec.get("sid") != sid or rec.get("turn_id") == current_turn:
            continue
        for idx, item in enumerate(rec.get("items", [])):
            o = overrides.get(item_key(rec.get("turn_id"), item.get("question", "")), {})
            if item.get("status") in ("partial", "unanswered") and not o.get("archived") and not o.get("status"):
                found.append({"file": name, "idx": idx, "ts": rec.get("ts") or 0, "item": item})
    found.sort(key=lambda f: -f["ts"])
    return found[:MAX_FOLLOWUPS]


def apply_followups(out_dir, candidates, followups, turn_id):
    by_id = {f.get("id"): f for f in followups or []}
    changed = {}
    for n, cand in enumerate(candidates):
        f = by_id.get(f"p{n + 1}")
        old = cand["item"].get("status")
        if not f or STATUS_RANK.get(f.get("status"), -1) <= STATUS_RANK.get(old, -1):
            continue
        changed.setdefault(cand["file"], []).append((cand["idx"], f, old))
    for name, updates in changed.items():
        path = os.path.join(out_dir, name)
        try:
            with open(path, encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        for idx, f, old in updates:
            if idx >= len(rec.get("items", [])):
                continue
            item = rec["items"][idx]
            item.setdefault("first_status", old)
            item["status"] = f["status"]
            if f.get("answer"):
                item["answer"] = f["answer"]
            item["resolved_in"] = turn_id
            item["resolved_at"] = time.time()
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(rec, fh, ensure_ascii=False)
        os.replace(tmp, path)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    key, transcript = args[0], args[1]
    turn_id = args[2] if len(args) > 2 else None
    if not config.get("qa_auto") and not force:
        return
    turn = extract(transcript, turn_id)
    if not turn or not any(t.strip() for _, t in turn["users"]):
        return
    pane_dir = os.path.join(BASE, "qa", key)
    out_dir = session_dir(key, turn["sid"])
    os.makedirs(out_dir, exist_ok=True)
    safe_id = "".join(c for c in turn["turn_id"] if c.isalnum() or c == "-")[:60]
    pending = os.path.join(pane_dir, "pending")
    with open(pending, "w") as fh:
        json.dump({"since": time.time()}, fh)

    model = os.environ.get("CLAUDE_QA_MODEL") or config.get("model")
    user_block = "\n\n".join(f"[{'처음 요청' if kind == 'prompt' else '작업 중 추가 메시지'}]\n{clip(text, 3000)}" for kind, text in turn["users"])
    candidates = [] if turn_id else open_items(out_dir, turn["sid"], turn["turn_id"])
    followup_block = ""
    if candidates:
        followup_block = "\n\n## 이전 턴에서 답을 못 받은 질문\n" + "\n".join(
            f"- id=p{n + 1} [{c['item'].get('status')}] {clip(c['item'].get('question', ''), 300)}\n  이전 메모: {clip(c['item'].get('answer', ''), 300)}"
            for n, c in enumerate(candidates))
    msg = (f"## 사용자 메시지\n{user_block}\n\n## 에이전트가 한 일 (도구 호출)\n" + "\n".join(f"- {a}" for a in turn["actions"]) +
           f"\n\n## 에이전트의 답변 (시간 순)\n{turn['replies']}{followup_block}")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CMUX_", "ORCA_"))}
    env["CLAUDE_ACTIVITY_CHILD"] = "1"
    cmd = ["claude", "-p", "--model", model, "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
           "--system-prompt", SYSTEM + output_language_instruction(), "--no-session-persistence", "--output-format", "json", "--tools", "",
           "--json-schema", json.dumps(SCHEMA, ensure_ascii=False)]
    record = {"turn_id": turn["turn_id"], "sid": turn["sid"], "ts": time.time(), "model": model,
              "transcript": transcript, "scope": "through-end" if turn_id else "turn",
              "prompt": turn["users"][0][1][:300]}
    try:
        proc = subprocess.run(cmd, input=msg, capture_output=True, text=True, env=env, timeout=600)
        result = json.loads(proc.stdout or "{}")
        data = result.get("structured_output")
        if not data:
            raise RuntimeError(result.get("result") or proc.stderr[-500:] or "no structured output")
        record.update(items=data.get("items", []), cost=result.get("total_cost_usd"), status="ok")
        if candidates:
            apply_followups(out_dir, candidates, data.get("followups"), turn["turn_id"])
            record["followups_checked"] = len(candidates)
    except Exception as exc:  # noqa: BLE001 - shown in the panel
        record.update(items=[], status="error", error=str(exc)[:1000])
    tmp = os.path.join(out_dir, f".{safe_id}.tmp")
    with open(tmp, "w") as fh:
        json.dump(record, fh, ensure_ascii=False)
    os.replace(tmp, os.path.join(out_dir, f"{safe_id}.json"))
    try:
        os.remove(pending)
    except OSError:
        pass


if __name__ == "__main__":
    main()
