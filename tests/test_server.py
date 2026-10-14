import os
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights.web.server import _allowed_path  # noqa: E402


def remove_tree(path):
    def writable(func, target, _):
        os.chmod(target, stat.S_IWRITE)
        func(target)
    shutil.rmtree(path, onerror=writable)


class AllowedPathTest(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(remove_tree, self.root)
        self.cwd = os.path.join(self.root, "repo")
        self.other = os.path.join(self.root, "other")
        os.makedirs(os.path.join(self.cwd, "src"))
        os.makedirs(self.other)

    def test_files_under_the_working_directory_are_allowed(self):
        snap = {"cwd": self.cwd, "files": []}
        self.assertEqual(_allowed_path("src/a.py", snap), os.path.join(self.cwd, "src", "a.py"))

    def test_an_edited_file_outside_the_working_directory_is_allowed_but_its_neighbour_is_not(self):
        edited = os.path.join(self.other, "edited.md")
        snap = {"cwd": self.cwd, "files": [{"path": edited}]}
        self.assertEqual(_allowed_path(edited, snap), edited)
        self.assertIsNone(_allowed_path(os.path.join(self.other, "secret.md"), snap))

    def test_a_home_relative_edited_file_is_matched_after_expanding_home(self):
        edited = os.path.join(self.other, "notes.md")
        with mock.patch.dict(os.environ, {"HOME": self.root, "USERPROFILE": self.root}):
            snap = {"cwd": self.cwd, "files": [{"path": "~/other/notes.md"}]}
            self.assertEqual(_allowed_path(edited, snap), edited)

    def test_a_flow_from_an_earlier_session_vouches_for_its_own_edited_files(self):
        edited = os.path.join(self.other, "old.md")
        snap = {"cwd": self.cwd, "files": []}
        self.assertIsNone(_allowed_path(edited, snap))
        self.assertEqual(_allowed_path(edited, snap, {"cwd": self.cwd, "edited": [edited]}), edited)

    def test_climbing_out_of_the_working_directory_is_refused(self):
        snap = {"cwd": self.cwd, "files": []}
        self.assertIsNone(_allowed_path("../other/x", snap))
        self.assertIsNone(_allowed_path(self.cwd + "-evil/x", snap))

    def test_a_link_out_of_the_working_directory_is_refused(self):
        try:
            os.symlink(self.other, os.path.join(self.cwd, "link"))
        except OSError:
            self.skipTest("this account cannot make links")
        self.assertIsNone(_allowed_path("link/secret.md", {"cwd": self.cwd, "files": []}))

    def test_a_directory_absolute_path_outside_or_empty_is_refused(self):
        snap = {"cwd": self.cwd, "files": []}
        self.assertIsNone(_allowed_path("src", snap))
        self.assertIsNone(_allowed_path("/etc/hosts", snap))
        self.assertIsNone(_allowed_path("", snap))

    def test_a_session_at_the_filesystem_root_still_reaches_its_files(self):
        self.assertEqual(_allowed_path(os.path.join(self.cwd, "a.py"), {"cwd": "/", "files": []}), os.path.join(self.cwd, "a.py"))


if __name__ == "__main__":
    unittest.main()
