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


    def test_a_cursor_gone_from_the_file_checks_the_latest_turns_and_offers_the_rest(self):
        seg = qa.extract_since(self.path, "gone", 10)
        self.assertEqual(asked(seg), [f"question {n}" for n in range(16, 26)])
        self.assertEqual((seg["skipped"], seg["skipped_after"]), (15, "gone"))


class StoredChecksTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.folder)
        self.path = transcript(self.folder)
        self.judged = []
        patch = mock.patch.object(qa_store, "DATA", os.path.join(self.folder, "data"))
        patch.start()
        self.addCleanup(patch.stop)
        os.makedirs(qa_store.session_dir("p1", "s1"))

    def judge(self, pane, message, model):
        self.judged.append(message)
        return {"items": [{"question": "q", "kind": "question", "status": "answered", "answer": "a"}], "followups": []}, 0.01

    def write(self, turn_id, record):
        qa_store.atomic_write_json(qa_store.record_path("p1", "s1", turn_id), {"turn_id": turn_id, "sid": "s1", **record})

    def read(self, turn_id):
        return qa_store.read_json(qa_store.record_path("p1", "s1", turn_id))

    def test_a_failed_check_older_keeps_the_offer_and_writes_nothing(self):
        self.write("u16", {"status": "ok", "items": [], "skipped_turns": 15, "skipped_after": None})

        def fail(*_):
            raise RuntimeError("model down")

        with mock.patch.object(qa, "_judge", fail):
            qa.judge_older("p1", self.path, "u16", "haiku", 10)
        self.assertEqual(self.read("u16")["skipped_turns"], 15)
        self.assertIsNone(self.read("u6"))

    def test_a_failed_batch_is_checked_again_over_its_own_turns_after_a_later_check_moved_on(self):
        self.write("u11", {"status": "error", "items": [], "prompt_count": 5, "after": "a10", "start_uuid": "u11", "end_uuid": "a15"})
        qa_store.write_cursor("p1", "s1", "a25")
        failed = qa._failed_batch("p1", "s1", "u11")
        self.assertIsNotNone(failed)
        with mock.patch.object(qa, "_judge", self.judge):
            qa.judge_batch_again("p1", self.path, qa.load_entries(self.path), "s1", "u11", failed, "haiku")
        self.assertIn("question 11", self.judged[0])
        self.assertIn("question 15", self.judged[0])
        self.assertNotIn("question 16", self.judged[0])
        record = self.read("u11")
        self.assertEqual((record["status"], record["prompt_count"]), ("ok", 5))
        self.assertEqual(qa_store.read_cursor("p1", "s1"), "a25")

    def test_a_failed_batch_moves_the_cursor_when_no_later_check_did(self):
        self.write("u11", {"status": "error", "items": [], "prompt_count": 5, "after": "a10", "start_uuid": "u11", "end_uuid": "a15"})
        qa_store.write_cursor("p1", "s1", "a10")
        with mock.patch.object(qa, "_judge", self.judge):
            qa.judge_batch_again("p1", self.path, qa.load_entries(self.path), "s1", "u11", qa._failed_batch("p1", "s1", "u11"), "haiku")
        self.assertEqual(qa_store.read_cursor("p1", "s1"), "a15")

    def test_a_failed_check_of_one_turn_since_the_cursor_moves_the_cursor_when_checked_again(self):
        self.write("u11", {"status": "error", "items": [], "scope": "turn", "prompt_count": 1, "after": "a10", "start_uuid": "u11", "end_uuid": "a11"})
        self.write("u12", {"status": "error", "items": [], "scope": "through-end", "prompt_count": 1})
        qa_store.write_cursor("p1", "s1", "a10")
        self.assertIsNone(qa._failed_batch("p1", "s1", "u12"))
        with mock.patch.object(qa, "_judge", self.judge):
            qa.judge_batch_again("p1", self.path, qa.load_entries(self.path), "s1", "u11", qa._failed_batch("p1", "s1", "u11"), "haiku")
        self.assertEqual(qa_store.read_cursor("p1", "s1"), "a11")

    def test_a_failed_batch_checked_again_settles_earlier_open_questions(self):
        self.write("u3", {"status": "ok", "items": [{"question": "open q", "kind": "question", "status": "unanswered"}]})
        self.write("u11", {"status": "error", "items": [], "prompt_count": 5, "after": "a10", "start_uuid": "u11", "end_uuid": "a15"})

        def judge(pane, message, model):
            self.judged.append(message)
            return {"items": [], "followups": [{"id": "p1", "status": "answered", "answer": "later"}]}, 0.01

        with mock.patch.object(qa, "_judge", judge):
            qa.judge_batch_again("p1", self.path, qa.load_entries(self.path), "s1", "u11", qa._failed_batch("p1", "s1", "u11"), "haiku")
        self.assertIn("open q", self.judged[0])
        self.assertEqual(self.read("u3")["items"][0]["status"], "answered")

    def test_a_batch_check_records_the_range_it_covered(self):
        qa_store.write_cursor("p1", "s1", "a20")
        with mock.patch.object(qa, "_judge", self.judge), mock.patch.object(qa.config, "load", lambda pane=None: {"qa_batch": 10}):
            qa.judge_since_cursor("p1", self.path, "haiku")
        record = self.read("u21")
        self.assertEqual((record["after"], record["start_uuid"], record["end_uuid"], record["prompt_count"]), ("a20", "u21", "a25", 5))

    def test_a_turn_checked_alone_is_dated_by_its_own_start(self):
        stamped = os.path.join(self.folder, "stamped.jsonl")
        with open(self.path, encoding="utf-8") as src, open(stamped, "w", encoding="utf-8") as out:
            for n, line in enumerate(src):
                entry = json.loads(line)
                entry["timestamp"] = f"2026-01-01T00:{n:02d}:00Z"
                out.write(json.dumps(entry) + "\n")
        with mock.patch.object(qa, "_judge", self.judge):
            qa.judge_turn("p1", stamped, "u3", "haiku")
        self.assertEqual(self.read("u3")["turn_ts"], qa._entry_time({"timestamp": "2026-01-01T00:04:00Z"}))


if __name__ == "__main__":
    unittest.main()
