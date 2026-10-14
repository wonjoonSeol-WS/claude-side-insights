import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights.live import views  # noqa: E402


class FooterTest(unittest.TestCase):
    def test_keys_with_nothing_to_act_on_are_left_out(self):
        self.assertEqual(views.idle_keys("flow", 2, []), set())
        self.assertEqual(views.idle_keys("flow", 1, []), {"[ ]"})
        self.assertIn("r", views.idle_keys("flow", 0, []))
        self.assertIn("r", views.idle_keys("qa", 3, []))
        self.assertEqual(views.idle_keys("qa", 0, ["row"]), set())
        label = views.t("term_k_rebuild", pane="p")
        self.assertIn(label, views.footer("p", 200, "flow"))
        self.assertNotIn(label, views.footer("p", 200, "flow", hidden={"r"}))


if __name__ == "__main__":
    unittest.main()
