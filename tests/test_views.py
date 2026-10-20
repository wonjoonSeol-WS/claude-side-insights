import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights.live import activity, views  # noqa: E402


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



class FolderTest(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        activity._REPOS.clear()
        for folder in ("session/src", "shop/.git", "shop/hooks/mod", "loose/notes"):
            os.makedirs(os.path.join(self.root, folder))
        self.st = activity.State.__new__(activity.State)
        self.st.cwd = os.path.join(self.root, "session")

    def folder(self, *parts):
        return self.st.folder(os.path.join(self.root, *parts))

    def test_a_file_in_the_session_folder_shows_the_folder_inside_it(self):
        self.assertEqual(self.folder("session", "src", "a.py"), "src")
        self.assertEqual(self.folder("session", "a.py"), "")

    def test_a_file_in_another_repo_shows_the_repo_name_and_the_folder_inside_it(self):
        self.assertEqual(self.folder("shop", "hooks", "mod", "views.tsx"), "shop/hooks/mod")
        self.assertEqual(self.folder("shop", "README.md"), "shop")

    def test_a_file_in_no_repo_shows_its_path_from_home_or_in_full(self):
        notes = os.path.join(self.root, "loose", "notes").replace("\\", "/")
        for home, shown in ((self.root, "~/loose/notes"), (self.st.cwd, notes)):
            with mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home}):
                self.assertEqual(self.folder("loose", "notes", "a.md"), shown)

    def test_a_folder_too_long_for_the_line_goes_under_the_name(self):
        self.assertEqual(len(views._file_lines("views.tsx", "~/a/b", 60, "")), 1)
        narrow = views._file_lines("views.tsx", "~/personal/claude-side-insights/hooks/mod", 30, "")
        self.assertEqual(len(narrow), 2)
        self.assertIn("views.tsx", narrow[0])

    def test_a_folder_that_becomes_a_repo_later_shows_as_one(self):
        self.assertNotEqual(self.folder("loose", "notes", "a.md"), "loose/notes")
        os.makedirs(os.path.join(self.root, "loose", ".git"))
        self.assertNotEqual(self.folder("loose", "notes", "a.md"), "loose/notes", "a miss is kept for a while")
        with mock.patch.object(activity, "REPO_RECHECK", 0):
            self.assertEqual(self.folder("loose", "notes", "a.md"), "loose/notes")

    def test_control_characters_in_a_name_or_folder_never_reach_the_terminal(self):
        for line in views._file_lines("a\x1b[2Jb\n.py", "src\nx\x07", 60, "") + views._file_lines("a\x1b.py", "f" * 80, 30, ""):
            self.assertNotIn("\n", line)
            self.assertNotIn("\x07", line)
            self.assertNotIn("\x1b[2J", line)

if __name__ == "__main__":
    unittest.main()
