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

    def run_flow(self, turn, same, *flags, cwd="/repo"):
        def claude(system, schema, message, *args, **kwargs):
            self.calls.append(message)
            return {"same_change": same, "title": f"flow {turn}", "summary": "s", "example": "e", "steps": [], "changes": []}, 0.1
        with mock.patch.object(flow, "run_claude", claude), mock.patch.object(sys, "argv", ["flow", "p1", transcript(self.folder, turn), cwd, "--force", *flags]):
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

    def test_rebuilding_the_latest_turn_of_a_merged_flow_keeps_one_flow_for_both_turns(self):
        self.run_flow("t1", False)
        self.run_flow("t2", True)
        records = self.run_flow("t2", True)
        self.assertEqual((len(records), records[0]["turn_ids"]), (1, ["t1", "t2"]))
        self.assertIn("## Flow of the earlier turns, which also holds an older analysis of this turn", self.calls[2])
        self.assertNotIn("## Previous flow, from an earlier turn", self.calls[2])

    def test_a_rebuild_that_is_no_longer_the_same_change_leaves_the_earlier_turn_its_flow(self):
        self.run_flow("t1", False)
        self.run_flow("t2", True)
        records = self.run_flow("t2", False)
        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["turn_id"], "t2")
        self.assertEqual((records[1]["turn_id"], records[1].get("turn_ids")), ("t1", None))

    def test_a_turn_in_another_folder_does_not_continue_the_flow(self):
        self.run_flow("t1", False, cwd="/repo")
        records = self.run_flow("t2", True, cwd="/other")
        self.assertEqual(len(records), 2)
        self.assertNotIn("## Previous flow", self.calls[1])

    def test_the_same_folder_spelled_differently_continues_the_flow(self):
        self.run_flow("t1", False, cwd="/repo")
        records = self.run_flow("t2", True, cwd="/repo/")
        self.assertEqual((len(records), records[0]["turn_ids"]), (1, ["t1", "t2"]))

    def test_a_flow_saved_without_a_folder_can_be_continued(self):
        self.run_flow("t1", False)
        first = flow_store.records("p1")[0]
        path = os.path.join(self.folder, "flows", "p1", f"{first['id']}.json")
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        data.pop("cwd")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        records = self.run_flow("t2", True, cwd="/other")
        self.assertEqual((len(records), records[0]["turn_ids"]), (1, ["t1", "t2"]))

    def test_only_new_skips_a_turn_that_already_has_a_flow(self):
        self.run_flow("t1", False)
        self.run_flow("t1", False, "--if-new")
        self.assertEqual(len(self.calls), 1)


if __name__ == "__main__":
    unittest.main()
