#!/usr/bin/env python3
"""Build a logic-flow document for the last Claude turn in a transcript.

usage: python3 -m side_insights flow <pane> <transcript_path> <cwd> [--force]
Skips turns that edited no files unless --force.
"""
import os
import re
import sys
import time
import uuid

from side_insights import config
from side_insights.analysis import flow_store
from side_insights.analysis.runner import Pending, run_claude
from side_insights.i18n import language_instruction
from side_insights.records import RecordStatus, StepKind
from side_insights.paths import EDIT_TOOLS, atomic_write_json, data_dir, json_files, read_json
from side_insights.transcript import (assistant_blocks, prompt_text, clip, load_entries, queued_prompt, text_of, tool_results, turn_end, turn_start,
                        wait_until_written)

KEEP_FLOWS = 30
MAX_CONTEXT = 70000
TIMEOUT = 1200
MAX_TURNS = 40
TEXT_LIMIT = 2500
EDIT_LIMIT = 2000
WRITE_LIMIT = 4000
COMMAND_LIMIT = 600
RESULT_TAIL = 600
BRIEF_LIMIT = 200
PROMPT_LIMIT = 3000
ERROR_LIMIT = 1000
RECORD_PROMPT_LIMIT = 500
_QUOTED = re.compile(r"'[^']*'|\"(?:\\.|[^\"\\])*\"")
_SCRATCH = r"(?:/tmp/|/private/tmp/|/dev/|\$TMPDIR|\$\{TMPDIR)"
WRITES_FILES = re.compile(
    r"(?:^|[\s;&|])(?:&>|>\||>{1,2})\s*(?!" + _SCRATCH + r"|&)[\w~./$]"
    r"|\bsed\s+(?:-\w+\s+)*-[a-zA-Z]*i|--in-place\b|\bperl\s+-[a-z]*i|\btee\s+(?:-a\s+)?(?!" + _SCRATCH + r")[\w~./$]"
    r"|\bcurl\b[^|;&]*\s-o\s*(?!" + _SCRATCH + r")[\w~./$]"
    r"|\bgit\s+(?:apply|mv|rm|checkout|reset|merge|stash|restore|switch|pull|rebase|cherry-pick|revert)\b"
    r"|\.write\(|\bopen\([^)]*['\"][wa]['\"]|\b(?:mv|cp|patch|rm|touch)\s+(?:-[\w-]+\s+)*(?!" + _SCRATCH + r")[\w~./$]")
_MESSAGE_HEREDOC = re.compile(r"\b(?:git\s+(?:commit|tag)|gh\s+(?:pr|issue|release|api))\b")


def writes_files(command):
    """Heuristic for shell commands that change files outside scratch space; quoted text and message bodies are ignored."""
    head, _, heredoc_body = command.partition("<<")
    if _MESSAGE_HEREDOC.search(head):
        heredoc_body = ""
    return bool(WRITES_FILES.search(_QUOTED.sub("''", command)) or (heredoc_body and WRITES_FILES.search(heredoc_body)))


CHECK_STATUSES = ["pass", "fail", "unknown"]

SCHEMA = {
    "type": "object",
    "required": ["same_change", "title", "summary", "example", "steps", "changes"],
    "properties": {
        "same_change": {"type": "boolean",
                        "description": "True when this turn continues the previous flow's logical change (refines, fixes or extends the same feature)"},
        "title": {"type": "string", "description": "The work in 3 to 6 words"},
        "example": {"type": "string", "description": "One concrete input traced through every step, e.g. a request with its values"},
        "summary": {"type": "string", "description": "What changed and why, 2 sentences"},
        "steps": {
            "type": "array", "minItems": 2, "maxItems": 14,
            "items": {
                "type": "object",
                "required": ["title", "location", "kind", "changed", "explanation"],
                "properties": {
                    "title": {"type": "string"},
                    "location": {"type": "string", "description": "file / function names"},
                    "kind": {"type": "string", "enum": [kind.value for kind in StepKind]},
                    "changed": {"type": "boolean", "description": "Did this turn's edits touch this step's code"},
                    "explanation": {"type": "string", "description": "One sentence per line, separated by \\n"},
                    "code": {"type": "string", "description": "Real code excerpt, at most 12 lines"},
                    "highlight": {"type": "array", "items": {"type": "string"}, "description": "Substrings of the changed lines in code"},
                    "data": {
                        "type": "array",
                        "description": "State of the traced example that this step reads or changes, with concrete values",
                        "items": {"type": "object", "required": ["name", "after"],
                                  "properties": {"name": {"type": "string"}, "before": {"type": "string"}, "after": {"type": "string"}}},
                    },
                },
            },
        },
        "changes": {"type": "array", "items": {"type": "object", "required": ["file", "what"],
                                                "properties": {"file": {"type": "string", "description": "path relative to the working directory, or absolute when the file is outside it"},
                                                               "what": {"type": "string"}}}},
        "checks": {"type": "array", "items": {"type": "object", "required": ["label", "status"],
                                               "properties": {"label": {"type": "string"}, "status": {"type": "string", "enum": CHECK_STATUSES},
                                                              "steps": {"type": "array", "items": {"type": "integer"},
                                                                        "description": "1-based numbers of the steps this check exercises"}}}},
    },
}

SYSTEM = """You write a "logic flow" of the work a coding agent just finished, for a developer of this codebase.
List the steps in the order data moves through the changed feature when it runs (entry point, processing, external calls or storage, result).
- Include the steps before and after the changed ones when they are needed to follow the flow; keep unchanged steps short.
- Set changed to true only for steps this turn's edits actually touched.
- explanation: 2 to 5 sentences, one per line. The first line says what the step does; the following lines say what changed and why. Use lines starting with "- " for details. Mark guesses as guesses.
- Wrap function, variable and file names and commands in `backticks`, also in summary and changes.what.
- Put one or two key words per line in **bold** and mark caveats or changed behaviour with ==highlight==. Do not overuse either.
- Trace the one concrete example from "example" through every step. In each step's data list the state names (variables, fields, rows, response codes) this step reads or changes and their concrete values for that example; give "before" only when the step changes the value. Use the same name for the same state in every step so it can be followed across steps.
- code must be a real excerpt you confirmed with Read. Never invent symbols. Use kind "test" for test files.
- When a previous flow is given and this turn continues the same logical change (it refines, fixes or extends the same feature), set same_change to true and write one flow for the whole change as it stands now: the steps of both turns, changed set for steps either turn touched, and changes from both. Otherwise set same_change to false and describe only this turn.
- checks: only tests, builds or checks that actually ran in the conversation. Empty if none. Set steps to the 1-based numbers of the steps a check exercises; leave it empty when it covers the whole change.
Write for a person skimming the panel, not for a machine:
- Lead with the point in one short sentence, then add detail only if it helps.
- Use plain, everyday words and natural phrasing for the output language; avoid stiff or translated-sounding sentences.
- Leave out internal ids, hashes, uuids, session or turn ids, transcript entry numbers, character counts and timestamps unless the reader needs them to act.
- Name code (functions, files, commands) only when it helps the reader find or understand something.
- Do not use the em dash (U+2014) or the middle dot (U+00B7); use a hyphen, comma or slash."""


def _describe_edit(name, path, inp):
    if name == "Write":
        return [f"[Write {path}]\n{clip(inp.get('content', ''), WRITE_LIMIT)}"]
    if name == "NotebookEdit":
        return [f"[NotebookEdit {path} {inp.get('edit_mode', 'replace')}]\n{clip(inp.get('new_source', ''), EDIT_LIMIT)}"]
    edits = inp.get("edits") if name == "MultiEdit" else [inp]
    return [f"[Edit {path}]\n- {clip(e.get('old_string', ''), EDIT_LIMIT)}\n+ {clip(e.get('new_string', ''), EDIT_LIMIT)}"
            for e in edits or []]


def _describe_result(result):
    if not result:
        return ""
    output = result.get("content")
    output = text_of(output) if isinstance(output, list) else output if isinstance(output, str) else ""
    return f"\n  result (tail): {output[-RESULT_TAIL:]}" + (" [error]" if result.get("is_error") else "")


def extract_turn(path):
    entries = load_entries(path)
    start = turn_start(entries)
    if start is None:
        return None
    turn = entries[start + 1:turn_end(entries, start)]
    results = tool_results(turn)
    parts, edited, shell_writes = [], [], []
    for e in turn:
        queued = queued_prompt(e)
        if queued:
            parts.append(f"[user, sent while the agent worked] {clip(queued, EDIT_LIMIT)}")
        for b in assistant_blocks([e]):
            if b["type"] == "text":
                if b.get("text", "").strip():
                    parts.append(f"[agent] {clip(b['text'], TEXT_LIMIT)}")
                continue
            name, inp = b.get("name"), b.get("input") or {}
            if name in EDIT_TOOLS:
                file_path = inp.get("file_path") or inp.get("notebook_path")
                edited.append(file_path)
                parts += _describe_edit(name, file_path, inp)
            elif name == "Bash":
                if writes_files(inp.get("command", "")):
                    shell_writes.append(inp.get("description") or clip(inp.get("command", ""), BRIEF_LIMIT))
                parts.append(f"[Bash] {inp.get('description', '')}: {clip(inp.get('command', ''), COMMAND_LIMIT)}"
                             + _describe_result(results.get(b.get("id"))))
            else:
                brief = inp.get("file_path") or inp.get("pattern") or inp.get("query") or inp.get("description") or ""
                parts.append(f"[{name}] {clip(brief, BRIEF_LIMIT)}")
    body = "\n\n".join(parts)
    if len(body) > MAX_CONTEXT:
        body = body[:MAX_CONTEXT // 3] + "\n\n...(middle omitted)...\n\n" + body[-(MAX_CONTEXT * 2 // 3):]
    return {"turn_id": entries[start].get("uuid"), "prompt": prompt_text(entries[start]),
            "body": body, "edited": [f for f in dict.fromkeys(edited) if f], "shell_writes": shell_writes}


def new_flow_id():
    now = time.time()
    return f"{time.strftime('%Y%m%d-%H%M%S', time.localtime(now))}-{int(now * 1e6) % 1000000:06d}-{uuid.uuid4().hex[:6]}"


def _turns_of(record):
    return record.get("turn_ids") or ([record["turn_id"]] if record.get("turn_id") else [])


def _same_folder(a, b):
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def _previous_flow(pane, turn_id, cwd):
    """The flow this turn may continue: a merged flow that already covers it, else the newest earlier flow if it
    finished in the same folder (a record without a folder counts as the same)."""
    for rec in flow_store.records(pane):
        finished = rec.get("status") == RecordStatus.OK.value and isinstance(rec.get("flow"), dict)
        turns = _turns_of(rec)
        if turn_id in turns:
            if finished and len(turns) > 1:
                return rec
            continue
        return rec if finished and _same_folder(rec.get("cwd") or cwd, cwd) else None
    return None


def _previous_section(previous, turn_id):
    if not previous:
        return ""
    flow = previous["flow"]
    steps = "\n".join(f"{n + 1}. {s.get('title', '')} ({s.get('location', '')})" for n, s in enumerate(flow.get("steps") or []))
    changes = "\n".join(f"- {c.get('file', '')}: {c.get('what', '')}" for c in flow.get("changes") or [])
    heading = ("Flow of the earlier turns, which also holds an older analysis of this turn" if turn_id in _turns_of(previous)
               else "Previous flow, from an earlier turn")
    return (f"\n\n## {heading}\nTitle: {flow.get('title', '')}\nSummary: {flow.get('summary', '')}\n"
            f"Steps:\n{steps}\nChanges:\n{changes}")


def _without_turn(record, turn_id):
    """The record left to cover its other turns once turn_id gets a flow of its own."""
    rest = [t for t in _turns_of(record) if t != turn_id]
    out = {**record, "turn_id": rest[-1]}
    if len(rest) > 1:
        out["turn_ids"] = rest
    else:
        out.pop("turn_ids", None)
    return out


def _prune(out_dir, keep_id, turn_id):
    for path in json_files(out_dir):
        if os.path.basename(path) != f"{keep_id}.json" and turn_id and (read_json(path) or {}).get("turn_id") == turn_id:
            _remove(path)
    for old in sorted(json_files(out_dir))[:-KEEP_FLOWS]:
        _remove(old)


def _remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 3:
        sys.exit(__doc__)
    pane, transcript, cwd = args
    force = "--force" in sys.argv
    only_new = "--if-new" in sys.argv
    settings = config.load(pane)
    if not config.runs("flow", pane) and not force:
        return
    if not force:
        wait_until_written(transcript)
    turn = extract_turn(transcript)
    out_dir = data_dir("flows", pane)
    if not turn:
        if force:
            flow_id = new_flow_id()
            atomic_write_json(os.path.join(out_dir, f"{flow_id}.json"),
                              {"id": flow_id, "ts": time.time(), "status": RecordStatus.ERROR.value, "error": "no turn found in the transcript"})
        return
    if not turn["edited"] and not turn["shell_writes"] and (not force or only_new):
        return
    flow_id = new_flow_id()
    record = {"turn_id": turn["turn_id"], "model": settings["model"], "id": flow_id, "ts": time.time(), "cwd": cwd,
              "prompt": turn["prompt"][:RECORD_PROMPT_LIMIT], "edited": turn["edited"]}
    shell = ("\nShell commands that may have changed files:\n" + "\n".join(f"- {c}" for c in turn["shell_writes"])
             if turn["shell_writes"] else "")
    with Pending(os.path.join(out_dir, "pending"), id=flow_id):
        if only_new and any(turn["turn_id"] in _turns_of(rec) and rec.get("status") == RecordStatus.OK.value for rec in flow_store.records(pane)):
            return
        previous = _previous_flow(pane, turn["turn_id"], cwd)
        message = (f"Working directory: {cwd}\nFiles edited this turn:\n" + "\n".join(f"- {f}" for f in turn["edited"]) + shell +
                   f"\n\n## User request\n{clip(turn['prompt'], PROMPT_LIMIT)}\n\n## What happened this turn\n{turn['body']}\n\n"
                   "Check the current code with Read/Grep/Glob where needed, then write the logic flow in the schema." + _previous_section(previous, turn["turn_id"]))
        try:
            flow, cost = run_claude(SYSTEM + language_instruction(pane), SCHEMA, message, settings["model"],
                                    tools=("Read", "Grep", "Glob"), cwd=cwd, timeout=TIMEOUT, max_turns=MAX_TURNS)
            record.update(flow=flow, cost=cost, status=RecordStatus.OK.value)
            if previous and flow.get("same_change"):
                earlier = [t for t in _turns_of(previous) if t != turn["turn_id"]]
                record.update(turn_ids=[*earlier, turn["turn_id"]], merged_from=previous["id"],
                              edited=list(dict.fromkeys([*(previous.get("edited") or []), *turn["edited"]])))
        except Exception as exc:  # noqa: BLE001
            record.update(status=RecordStatus.ERROR.value, error=str(exc)[:ERROR_LIMIT])
        atomic_write_json(os.path.join(out_dir, f"{flow_id}.json"), record)
        if record["status"] == RecordStatus.OK.value:
            if record.get("merged_from"):
                _remove(os.path.join(out_dir, f"{record['merged_from']}.json"))
            elif previous and turn["turn_id"] in _turns_of(previous):
                atomic_write_json(os.path.join(out_dir, f"{previous['id']}.json"), _without_turn(previous, turn["turn_id"]))
            _prune(out_dir, flow_id, turn["turn_id"])


if __name__ == "__main__":
    main()
