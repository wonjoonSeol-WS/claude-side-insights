import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights import config  # noqa: E402


class ConfigTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder)
        patch = mock.patch.object(config, "PATH", os.path.join(folder, "config.json"))
        patch.start()
        self.addCleanup(patch.stop)

    def test_turns_per_check_starts_at_20(self):
        self.assertEqual(config.load()["qa_batch"], 20)

    def test_changing_the_model_resets_turns_per_check_to_that_model_default(self):
        config.save({"qa_batch": 30})
        self.assertEqual(config.save({"model": "sonnet"})["qa_batch"], 10)
        self.assertEqual(config.save({"model": "claude-haiku-5-5"})["qa_batch"], 5)
        self.assertEqual(config.save({"model": "opus"})["qa_batch"], 20)

    def test_a_value_chosen_after_the_model_stays(self):
        config.save({"model": "sonnet"})
        self.assertEqual(config.save({"qa_batch": 30})["qa_batch"], 30)
        self.assertEqual(config.save({"lang": "ko"})["qa_batch"], 30)

    def test_a_panel_only_counts_when_it_is_open_unless_every_session_is_analyzed(self):
        self.assertFalse(config.runs("qa", "p1"))
        config.save({"enabled": True}, "p1")
        self.assertTrue(config.runs("qa", "p1"))
        self.assertFalse(config.runs("qa", "p2"))
        config.save({"analyze": "all"})
        self.assertTrue(config.runs("qa", "p2"))
        config.save({"qa_auto": False})
        self.assertFalse(config.runs("qa", "p1"))


    def test_a_panel_saves_only_enabled_and_the_shared_settings_never_do(self):
        with self.assertRaises(ValueError):
            config.save({"lang": "ko"}, "p1")
        with self.assertRaises(ValueError):
            config.save({"enabled": True})
        with self.assertRaises(ValueError):
            config.save({"qa_batch": "20"})
        config.save({"lang": "ja"})
        self.assertEqual(config.load("p1")["lang"], "ja")
        self.assertFalse(config.load("p2").get("enabled"))
        config.save({"enabled": True}, "p1")
        self.assertTrue(config.load("p1")["enabled"])
        self.assertFalse(config.load("p2").get("enabled"))


    def test_a_session_start_opens_the_panel_only_where_it_is_analyzed(self):
        self.assertFalse(config.opens_panel("p1"))
        config.save({"enabled": True}, "p1")
        self.assertTrue(config.opens_panel("p1"))
        self.assertFalse(config.opens_panel("p2"))
        config.save({"analyze": "all"})
        self.assertTrue(config.opens_panel("p2"))
        config.save({"panel_auto": False})
        self.assertFalse(config.opens_panel("p1"))


if __name__ == "__main__":
    unittest.main()
