#!/usr/bin/env python3
"""Build a logic-flow document for the last Claude turn in a transcript.

usage: flow.py <key> <transcript_path> <cwd> [--force]
Writes ~/.claude/activity-panel/flows/<key>/<id>.json. Skips turns that edited no files unless --force.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402
from i18n import output_language_instruction  # noqa: E402

BASE = os.path.expanduser("~/.claude/activity-panel")
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
MAX_CONTEXT = 70000
KEEP_FLOWS = 30

SCHEMA = {
    "type": "object",
    "required": ["title", "summary", "steps", "changes"],
    "properties": {
        "title": {"type": "string", "description": "이번 작업을 12자 안팎으로"},
        "summary": {"type": "string", "description": "무엇을 왜 바꿨는지 2문장"},
        "steps": {
            "type": "array",
            "minItems": 2,
            "maxItems": 14,
            "items": {
                "type": "object",
                "required": ["title", "location", "kind", "changed", "explanation"],
                "properties": {
                    "title": {"type": "string"},
                    "location": {"type": "string", "description": "파일명 / 함수명들"},
                    "kind": {"type": "string", "enum": ["input", "logic", "external", "storage", "output", "config", "test"]},
                    "changed": {"type": "boolean", "description": "이번 턴에 이 단계의 코드가 바뀌었는가"},
                    "explanation": {"type": "string", "description": "한 줄에 한 문장, \\n 으로 구분, 식별자는 `백틱`"},
                    "code": {"type": "string", "description": "실제 코드 발췌 12줄 이하"},
                    "highlight": {"type": "array", "items": {"type": "string"}, "description": "code 안에서 이번에 바뀐 줄의 부분 문자열"},
                    "data": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["name", "after"],
                            "properties": {"name": {"type": "string"}, "before": {"type": "string"}, "after": {"type": "string"}},
                        },
                        "description": "이 단계에서 바뀌는 값/상태 (선택)",
                    },
                },
            },
        },
        "changes": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["file", "what"],
                "properties": {"file": {"type": "string"}, "what": {"type": "string"}},
            },
        },
        "checks": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["label", "status"],
                "properties": {"label": {"type": "string"}, "status": {"type": "string", "enum": ["pass", "fail", "unknown"]}},
            },
        },
    },
}

SYSTEM = """당신은 코딩 에이전트가 방금 끝낸 작업을 '로직 흐름'으로 설명하는 문서를 만든다.
독자는 이 코드베이스의 개발자다. 이번 변경이 들어간 기능이 실행될 때 데이터가 지나가는 순서대로 단계를 나열한다.
- 단계는 실행 순서다 (진입점 -> 처리 -> 외부 호출/저장 -> 결과). 바뀐 단계만이 아니라 흐름 이해에 필요한 앞뒤 단계도 넣되, 바뀌지 않은 단계는 짧게.
- changed 는 이번 턴의 편집이 실제로 닿은 단계만 true.
- explanation 은 2~5문장, 한 줄에 한 문장씩 줄바꿈(\n)으로 나눈다. 첫 줄은 이 단계가 하는 일, 다음 줄부터 바뀐 점과 이유. 세부 항목은 "- " 로 시작하는 줄로. 추측은 '추정' 이라고 쓴다.
- 함수명, 변수, 파일명, 명령은 `백틱` 으로 감싼다. summary 와 changes.what 도 같다.
- 각 줄의 핵심어 한두 개는 **굵게**, 주의할 점이나 동작이 바뀐 부분은 ==강조== 로 표시한다. 남용하지 않는다.
- code 는 Read 로 현재 파일을 확인한 실제 코드 발췌. 없는 심볼을 만들지 않는다. 테스트 파일은 kind=test.
- checks 는 대화에서 실제로 실행된 테스트/빌드/검증 결과만. 없으면 빈 배열.
- em-dash(—)와 가운뎃점(·)은 쓰지 않는다. 하이픈, 쉼표, 슬래시를 쓴다."""


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def is_prompt(entry):
    if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain"):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return not content.startswith("<") and content.strip() != ""
    if isinstance(content, list):
        kinds = {b.get("type") for b in content if isinstance(b, dict)}
        return "tool_result" not in kinds and "text" in kinds and not text_of(content).startswith("Base directory for this skill")
    return False


def queued_prompt(entry):
    """Text of a message the user sent while the agent was working (stored as a queued_command attachment)."""
    att = entry.get("attachment") if entry.get("type") == "attachment" else None
    if not isinstance(att, dict) or att.get("type") != "queued_command" or (att.get("origin") or {}).get("kind") != "human":
        return None
    text = text_of(att.get("prompt"))
    return text.strip() or None


def load_entries(path):
    entries = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                entries.append(json.loads(line))
            except ValueError:
                pass
    return entries


def last_prompt_index(entries):
    return max((i for i, e in enumerate(entries) if is_prompt(e)), default=None)


def clip(s, n):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + f"\n…(+{len(s) - n}자)"


def extract_turn(path):
    entries = load_entries(path)
    start = last_prompt_index(entries)
    if start is None:
        return None
    prompt = text_of(entries[start]["message"]["content"])
    parts, edited, results = [], [], {}
    for e in entries[start + 1:]:
        if e.get("isSidechain"):
            continue
        queued = queued_prompt(e)
        if queued:
            parts.append(f"[사용자 추가 메시지] {clip(queued, 1500)}")
            continue
        content = (e.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict):
                continue
            if e.get("type") == "user" and b.get("type") == "tool_result":
                results[b.get("tool_use_id")] = b
            elif e.get("type") == "user" and b.get("type") == "text" and not b.get("text", "").startswith("Base directory"):
                parts.append(f"[사용자 추가 메시지] {clip(b['text'], 1500)}")
            elif e.get("type") == "assistant" and b.get("type") == "text" and b.get("text", "").strip():
                parts.append(f"[에이전트] {clip(b['text'], 2500)}")
            elif e.get("type") == "assistant" and b.get("type") == "tool_use":
                name, inp = b.get("name"), b.get("input") or {}
                if name in EDIT_TOOLS:
                    f = inp.get("file_path") or inp.get("notebook_path")
                    edited.append(f)
                    if name == "Write":
                        parts.append(f"[Write {f}]\n{clip(inp.get('content', ''), 4000)}")
                    elif name == "MultiEdit":
                        for ed in inp.get("edits", []):
                            parts.append(f"[Edit {f}]\n- {clip(ed.get('old_string', ''), 1500)}\n+ {clip(ed.get('new_string', ''), 1500)}")
                    else:
                        parts.append(f"[{name} {f}]\n- {clip(inp.get('old_string', ''), 2000)}\n+ {clip(inp.get('new_string', ''), 2000)}")
                elif name == "Bash":
                    parts.append(f"[Bash] {inp.get('description', '')}: {clip(inp.get('command', ''), 600)}"
                                 f"{{RESULT:{b.get('id')}}}")
                else:
                    brief = inp.get("file_path") or inp.get("pattern") or inp.get("query") or inp.get("description") or ""
                    parts.append(f"[{name}] {clip(brief, 200)}")
    body = "\n\n".join(parts)
    for tid, r in results.items():
        out = r.get("content")
        out = text_of(out) if isinstance(out, list) else (out or "")
        tail = out[-600:] if isinstance(out, str) else ""
        body = body.replace(f"{{RESULT:{tid}}}", f"\n  결과(끝부분): {tail}" + (" [오류]" if r.get("is_error") else ""))
    body = body.replace("{RESULT:", "{")
    if len(body) > MAX_CONTEXT:
        body = body[:MAX_CONTEXT // 3] + "\n\n…(중략)…\n\n" + body[-(MAX_CONTEXT * 2 // 3):]
    return {"turn_id": entries[start].get("uuid"), "prompt": prompt, "body": body, "edited": [f for f in dict.fromkeys(edited) if f]}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    key, transcript, cwd = args[0], args[1], args[2]
    cfg = config.load()[0]
    if not cfg["flow_auto"] and not force:
        return
    out_dir = os.path.join(BASE, "flows", key)
    os.makedirs(out_dir, exist_ok=True)
    pending = os.path.join(out_dir, "pending")

    turn = extract_turn(transcript)
    if not turn or (not turn["edited"] and not force):
        return
    flow_id = time.strftime("%Y%m%d-%H%M%S")
    with open(pending, "w") as fh:
        json.dump({"id": flow_id, "since": time.time(), "prompt": turn["prompt"][:200]}, fh, ensure_ascii=False)

    user_msg = (
        f"작업 디렉터리: {cwd}\n이번 턴에 편집된 파일:\n" + "\n".join(f"- {f}" for f in turn["edited"]) +
        f"\n\n## 사용자 요청\n{clip(turn['prompt'], 3000)}\n\n## 이번 턴의 진행 기록\n{turn['body']}\n\n"
        "필요하면 Read/Grep/Glob 으로 현재 코드를 확인한 뒤, 스키마에 맞는 로직 흐름 문서를 만들어라."
    )
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CMUX_", "ORCA_"))}
    env["CLAUDE_ACTIVITY_CHILD"] = "1"
    cmd = [
        "claude", "-p", "--model", cfg["model"],
        "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
        "--system-prompt", SYSTEM + output_language_instruction(), "--no-session-persistence", "--output-format", "json",
        "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--max-turns", "40",
        "--json-schema", json.dumps(SCHEMA, ensure_ascii=False),
    ]
    record = {"turn_id": turn["turn_id"], "model": cfg["model"], "id": flow_id, "ts": time.time(), "cwd": cwd, "prompt": turn["prompt"][:500], "edited": turn["edited"]}
    try:
        proc = subprocess.run(cmd, input=user_msg, capture_output=True, text=True, cwd=cwd if os.path.isdir(cwd) else None,
                              env=env, timeout=1200)
        result = json.loads(proc.stdout or "{}")
        flow = result.get("structured_output")
        if not flow:
            raise RuntimeError(result.get("result") or proc.stderr[-500:] or "no structured output")
        record.update(flow=flow, cost=result.get("total_cost_usd"), status="ok")
    except Exception as exc:  # noqa: BLE001 - surfaced in the panel instead of crashing a background job
        record.update(status="error", error=str(exc)[:1000])
    tmp = os.path.join(out_dir, f".{flow_id}.tmp")
    with open(tmp, "w") as fh:
        json.dump(record, fh, ensure_ascii=False)
    os.replace(tmp, os.path.join(out_dir, f"{flow_id}.json"))
    try:
        os.remove(pending)
    except OSError:
        pass
    if turn["turn_id"]:
        for name in os.listdir(out_dir):
            if name.endswith(".json") and name != f"{flow_id}.json":
                try:
                    with open(os.path.join(out_dir, name), encoding="utf-8") as fh:
                        same_turn = json.load(fh).get("turn_id") == turn["turn_id"]
                except (OSError, ValueError):
                    same_turn = False
                if same_turn:
                    os.remove(os.path.join(out_dir, name))
    flows = sorted(f for f in os.listdir(out_dir) if f.endswith(".json"))
    for old in flows[:-KEEP_FLOWS]:
        os.remove(os.path.join(out_dir, old))


if __name__ == "__main__":
    main()
