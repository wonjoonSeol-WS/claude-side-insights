import json
import os
import shutil
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights.live.record_event import lines  # noqa: E402

JQ_FILTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "record.jq")
LONG = "x" * 400
HOOKS = [
    {"hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/repo", "transcript_path": "/t.jsonl", "tool_use_id": "u1",
     "tool_name": "Bash", "tool_input": {"command": "echo one\n\ttwo  three", "description": None}},
    {"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "Edit", "tool_input": {"file_path": "C:\\repo\\a.ts", "old_string": "a"}},
    {"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "Task", "tool_input": {"prompt": LONG}},
    {"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "X", "tool_input": {"query": {"nested": [1, "가"]}}},
    {"hook_event_name": "PostToolUse", "session_id": "s1", "tool_name": "Write", "tool_input": {"file_path": "/a"},
     "tool_response": {"type": "create", "error": ""}},
    {"hook_event_name": "PostToolUse", "session_id": "s1", "tool_name": "Bash", "tool_input": {"command": "false"},
     "tool_response": {"is_error": True, "stderr": "bad\nthing " + LONG + LONG}},
    {"hook_event_name": "PostToolUse", "session_id": "s1", "tool_name": "Read", "tool_input": {}, "tool_response": "plain text"},
    {"hook_event_name": "PostToolUseFailure", "session_id": "s1", "tool_name": "Bash", "tool_input": {"command": "x"}, "error": "exit 1"},
    {"hook_event_name": "UserPromptSubmit", "session_id": "s1", "prompt": "한국어 질문"},
    {"hook_event_name": "Stop", "session_id": "s1", "cwd": "/repo", "transcript_path": "/t.jsonl"},
    {"hook_event_name": "Stop", "session_id": "s1", "transcript_path": ""},
]


def without_time(out):
    first = json.loads(out[0])
    first.pop("ts")
    return [first, *out[1:]]


class RecordEventTest(unittest.TestCase):
    def test_a_stop_also_gives_the_turn_the_transcript_and_the_folder(self):
        out = lines(HOOKS[-2], now=1)
        self.assertEqual(out[1:], ['{"transcript":"/t.jsonl","cwd":"/repo"}', "/t.jsonl", "/repo"])
        self.assertEqual(len(lines(HOOKS[-1], now=1)), 1)

    def test_long_text_is_cut_and_control_characters_become_spaces(self):
        self.assertEqual(json.loads(lines(HOOKS[0], now=1)[0])["summary"], "echo one two three")
        summary = json.loads(lines(HOOKS[2], now=1)[0])["summary"]
        self.assertEqual((len(summary), summary[-1]), (301, "…"))

    def test_a_failed_post_tool_use_keeps_its_reason(self):
        record = json.loads(lines(HOOKS[5], now=1)[0])
        self.assertEqual((record["error"], record["reason"][:9]), (True, "bad thing"))

    @unittest.skipUnless(shutil.which("jq"), "jq is not installed")
    def test_every_payload_matches_the_jq_filter(self):
        for hook in HOOKS:
            done = subprocess.run(["jq", "-r", "-f", JQ_FILTER], input=json.dumps(hook), capture_output=True, text=True, encoding="utf-8", check=True)
            with self.subTest(hook=hook.get("hook_event_name"), tool=hook.get("tool_name")):
                self.assertEqual(without_time(lines(hook)), without_time(done.stdout.rstrip("\n").split("\n")))


if __name__ == "__main__":
    unittest.main()
