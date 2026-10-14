import os
import tempfile
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights.web import diff  # noqa: E402
from side_insights.web.server import _allowed_path  # noqa: E402


class AllowedPathTest(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp())
        self.cwd = os.path.join(self.root, "repo")
        self.other = os.path.join(self.root, "other")
        os.makedirs(self.cwd)
        os.makedirs(self.other)

    def test_files_under_the_working_directory_are_allowed(self):
        snap = {"cwd": self.cwd, "files": []}
        self.assertEqual(_allowed_path("src/a.py", snap), os.path.join(self.cwd, "src/a.py"))

    def test_an_edited_file_outside_the_working_directory_is_allowed_but_its_neighbour_is_not(self):
        edited = os.path.join(self.other, "edited.md")
        snap = {"cwd": self.cwd, "files": [{"path": edited}]}
        self.assertEqual(_allowed_path(edited, snap), edited)
        self.assertIsNone(_allowed_path(os.path.join(self.other, "secret.md"), snap))

    def test_climbing_out_of_the_working_directory_is_refused(self):
        snap = {"cwd": self.cwd, "files": []}
        self.assertIsNone(_allowed_path("../other/x", snap))
        self.assertIsNone(_allowed_path("/etc/hosts", snap))
        self.assertIsNone(_allowed_path("", snap))


class TrimHunksTest(unittest.TestCase):
    def test_a_long_diff_is_cut_at_a_hunk_boundary(self):
        first = ["@@ -1,3 +1,3 @@"] + [" a"] * 3
        second = ["@@ -10,3 +10,3 @@"] + [" b"] * 3
        hunks, cut = diff.trim_hunks("\n".join(["diff --git a/x b/x", *first, *second]), limit=6)
        self.assertEqual(hunks, "\n".join(first))
        self.assertEqual(cut, len(second))

    def test_a_short_diff_is_kept_whole(self):
        hunks, cut = diff.trim_hunks("header\n@@ -1 +1 @@\n-a\n+b\n")
        self.assertEqual((hunks, cut), ("@@ -1 +1 @@\n-a\n+b", 0))


if __name__ == "__main__":
    unittest.main()
