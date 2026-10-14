import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights.analysis import qa, qa_store  # noqa: E402

TURNS = 25


def transcript(folder):
    path = os.path.join(folder, "s1.jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        for n in range(1, TURNS + 1):
            fh.write(json.dumps({"type": "user", "uuid": f"u{n}", "sessionId": "s1", "message": {"role": "user", "content": f"question {n}"}}) + "\n")
            fh.write(json.dumps({"type": "assistant", "uuid": f"a{n}", "sessionId": "s1",
                                 "message": {"role": "assistant", "content": [{"type": "text", "text": f"answer {n}"}]}}) + "\n")
    return path


def asked(seg):
    return [text for _, text in seg["users"]]


class PendingTurnsTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.folder)
        self.path = transcript(self.folder)

    def test_a_session_never_checked_checks_its_latest_ten_turns_and_counts_every_older_one(self):
        seg = qa.extract_since(self.path, None, 10)
        self.assertEqual(asked(seg), [f"question {n}" for n in range(16, 26)])
        self.assertEqual((seg["skipped"], seg["skipped_after"], seg["turn_id"]), (15, None, "u16"))

    def test_the_default_batch_covers_the_latest_20_turns(self):
        seg = qa.extract_since(self.path, None)
        self.assertEqual((len(seg["users"]), seg["skipped"]), (20, 5))

    def test_the_reply_budget_grows_with_the_number_of_turns(self):
        replies = [(True, f"q{n}") if n % 2 == 0 else (False, "x" * 9000) for n in range(60)]
        self.assertLess(len(qa._fit_replies(replies)), len(qa._fit_replies(replies, 30 * qa.REPLY_PER_TURN)))

    def test_a_session_checked_before_starts_after_that_check(self):
        seg = qa.extract_since(self.path, "a20", 10)
        self.assertEqual(asked(seg), [f"question {n}" for n in range(21, 26)])
        self.assertEqual(seg["skipped"], 0)

    def test_check_older_walks_back_ten_turns_a_time_until_the_session_start(self):
        data = os.path.join(self.folder, "data")
        judged = []

        def judge(pane, message, model):
            judged.append(message)
            return {"items": [], "followups": []}, 0.01

        with mock.patch.object(qa_store, "DATA", data), mock.patch.object(qa, "_judge", judge):
            os.makedirs(qa_store.session_dir("p1", "s1"))
            qa_store.atomic_write_json(qa_store.record_path("p1", "s1", "u16"), {"turn_id": "u16", "sid": "s1", "status": "ok", "items": [],
                                                                                "skipped_turns": 15, "skipped_after": None})
            qa.judge_older("p1", self.path, "u16", "haiku", 10)
            first = qa_store.read_json(qa_store.record_path("p1", "s1", "u6"))
            self.assertEqual((first["skipped_turns"], first["prompt"]), (5, "question 6"))
            self.assertIn("question 15", judged[0])
            self.assertNotIn("question 16", judged[0])
            self.assertNotIn("skipped_turns", qa_store.read_json(qa_store.record_path("p1", "s1", "u16")))
            qa.judge_older("p1", self.path, "u6", "haiku", 10)
            last = qa_store.read_json(qa_store.record_path("p1", "s1", "u1"))
            self.assertNotIn("skipped_turns", last)
            self.assertIn("[request]\nquestion 1\n", judged[1])
            self.assertIn("question 5", judged[1])
            self.assertNotIn("question 6", judged[1])


if __name__ == "__main__":
    unittest.main()
