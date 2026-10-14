import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights.web import diff  # noqa: E402


def git(repo, *args):
    subprocess.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", *args], check=True, capture_output=True)


class LoadTest(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.repo = os.path.join(self.root, "repo")
        os.makedirs(os.path.join(self.repo, "app", "[id]"))
        os.makedirs(os.path.join(self.repo, "app", "i"))
        git(self.root, "init", "-q", "repo")
        for path in ("app/[id]/page.tsx", "app/i/page.tsx", "kept.txt"):
            self.write(path, "one\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "first commit")

    def write(self, rel, text):
        with open(os.path.join(self.repo, rel), "w") as fh:
            fh.write(text)
        return os.path.join(self.repo, rel)

    def test_auto_shows_uncommitted_changes_first(self):
        path = self.write("kept.txt", "two\n")
        self.assertEqual(diff.load(path)["source"], diff.WORKING)

    def test_auto_shows_a_new_untracked_file_as_new(self):
        self.assertEqual(diff.load(self.write("fresh.txt", "x\n"))["source"], diff.NEW)

    def test_auto_falls_back_to_the_last_commit_then_explicit_views_win(self):
        path = os.path.join(self.repo, "kept.txt")
        shown = diff.load(path)
        self.assertEqual((shown["source"], shown["commit"].split(" ", 1)[1]), (diff.COMMIT, "first commit"))
        self.write("kept.txt", "two\n")
        self.assertEqual(diff.load(path, diff.COMMIT)["source"], diff.COMMIT)
        self.assertEqual(diff.load(path, diff.FILE), {"source": diff.FILE, "hunks": "", "text": "two", "cut": 0})

    def test_a_file_outside_any_repository_opens_whole(self):
        outside = os.path.join(self.root, "loose.txt")
        with open(outside, "w") as fh:
            fh.write("a\nb\n")
        self.assertEqual(diff.load(outside)["text"], "a\nb")

    def test_brackets_in_a_path_name_one_file_not_a_pattern(self):
        self.write("app/[id]/page.tsx", "two\n")
        self.write("app/i/page.tsx", "two\n")
        hunks = diff.load(os.path.join(self.repo, "app", "[id]", "page.tsx"))["hunks"]
        self.assertEqual(hunks.count("@@ "), 1)

    def test_a_directory_is_not_read_as_a_file(self):
        self.assertEqual(diff.load(os.path.join(self.repo, "app"), diff.FILE)["source"], diff.NONE)

    def test_the_file_view_counts_lines_past_the_limit(self):
        path = self.write("long.txt", "".join(f"{n}\n" for n in range(diff.MAX_DIFF_LINES + 5)))
        shown = diff.load(path, diff.FILE)
        self.assertEqual((len(shown["text"].split("\n")), shown["cut"]), (diff.MAX_DIFF_LINES, 5))


class TrimHunksTest(unittest.TestCase):
    def test_a_long_diff_is_cut_at_a_hunk_boundary(self):
        first = ["@@ -1,3 +1,3 @@"] + [" a"] * 3
        second = ["@@ -10,3 +10,3 @@"] + [" b"] * 3
        hunks, cut = diff.trim_hunks("\n".join(["diff --git a/x b/x", *first, *second]), limit=6)
        self.assertEqual(hunks, "\n".join(first))
        self.assertEqual(cut, len(second))

    def test_a_first_hunk_longer_than_the_limit_gets_a_header_that_matches_what_is_kept(self):
        body = ["@@ -1,6 +1,6 @@", " a", "-b", "+c", " d", "-e", "+f"]
        hunks, cut = diff.trim_hunks("\n".join(body), limit=4)
        self.assertEqual(hunks.split("\n"), ["@@ -1,2 +1,2 @@", " a", "-b", "+c"])
        self.assertEqual(cut, 3)

    def test_a_short_diff_is_kept_whole(self):
        hunks, cut = diff.trim_hunks("header\n@@ -1 +1 @@\n-a\n+b\n")
        self.assertEqual((hunks, cut), ("@@ -1 +1 @@\n-a\n+b", 0))


if __name__ == "__main__":
    unittest.main()
