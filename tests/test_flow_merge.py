import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights.analysis import flow, flow_store  # noqa: E402


def transcript(folder, turn):
    path = os.path.join(folder, f"{turn}.jsonl")
    entries = [
        {"type": "user", "uuid": turn, "sessionId": "s1", "message": {"role": "user", "content": f"change {turn}"}},
        {"type": "assistant", "uuid": f"{turn}-a", "sessionId": "s1", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": f"{turn}-t", "name": "Edit", "input": {"file_path": f"/repo/{turn}.py", "old_string": "a", "new_string": "b"}}]}},
        {"type": "user", "uuid": f"{turn}-r", "sessionId": "s1", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"{turn}-t", "content": "ok"}]}},
        {"type": "assistant", "uuid": f"{turn}-z", "sessionId": "s1", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]}},
    ]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("".join(json.dumps(e) + "\n" for e in entries))
    return path


class FlowMergeTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.folder)
        self.calls = []
        patches = [mock.patch.object(flow_store, "DATA", self.folder), mock.patch("side_insights.paths.DATA", self.folder),
                   mock.patch.object(flow, "data_dir", lambda *parts: self._dir(*parts))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def _dir(self, *parts):
        path = os.path.join(self.folder, *parts)
        os.makedirs(path, exist_ok=True)
        return path

    def run_flow(self, turn, same, *flags):
        def claude(system, schema, message, *args, **kwargs):
            self.calls.append(message)
            return {"same_change": same, "title": f"flow {turn}", "summary": "s", "example": "e", "steps": [], "changes": []}, 0.1
        with mock.patch.object(flow, "run_claude", claude), mock.patch.object(sys, "argv", ["flow", "p1", transcript(self.folder, turn), "/repo", "--force", *flags]):
            flow.main()
        return flow_store.records("p1")

    def test_a_turn_that_continues_the_same_change_replaces_the_previous_flow(self):
        self.run_flow("t1", False)
        records = self.run_flow("t2", True)
        self.assertEqual([r["flow"]["title"] for r in records], ["flow t2"])
        self.assertEqual((records[0]["turn_ids"], records[0]["edited"]), (["t1", "t2"], ["/repo/t1.py", "/repo/t2.py"]))
        self.assertIn("## Previous flow, from an earlier turn\nTitle: flow t1", self.calls[1])

    def test_a_different_change_keeps_both_flows(self):
        self.run_flow("t1", False)
        records = self.run_flow("t2", False)
        self.assertEqual([r["flow"]["title"] for r in records], ["flow t2", "flow t1"])
        self.assertNotIn("turn_ids", records[0])

    def test_a_merged_flow_absorbs_a_third_turn_too(self):
        self.run_flow("t1", False)
        self.run_flow("t2", True)
        records = self.run_flow("t3", True)
        self.assertEqual((len(records), records[0]["turn_ids"]), (1, ["t1", "t2", "t3"]))

    def test_only_new_skips_a_turn_that_already_has_a_flow(self):
        self.run_flow("t1", False)
        self.run_flow("t1", False, "--if-new")
        self.assertEqual(len(self.calls), 1)


if __name__ == "__main__":
    unittest.main()
