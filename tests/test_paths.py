import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights import paths  # noqa: E402


def stamped(real_stat, inode_from, mtime_from):
    def fake(target, *args, **kwargs):
        st = real_stat(target, *args, **kwargs)
        ino = (inode_from or st).st_ino
        return os.stat_result((st.st_mode, ino, st.st_dev, st.st_nlink, st.st_uid, st.st_gid, st.st_size,
                               st.st_atime, st.st_mtime, st.st_ctime, st.st_atime, st.st_mtime, st.st_ctime,
                               st.st_atime_ns, mtime_from.st_mtime_ns, st.st_ctime_ns))
    return fake


class ReadJsonTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder)
        self.path = os.path.join(folder, "config.json")

    def test_a_write_through_atomic_write_json_is_read_back_at_once(self):
        path = self.path
        paths.atomic_write_json(path, {"qa_batch": 10})
        self.assertEqual(paths.read_json(path), {"qa_batch": 10})
        first, real_stat = os.stat(path), os.stat
        paths.atomic_write_json(path, {"qa_batch": 30})
        with mock.patch("os.stat", stamped(real_stat, first, first)):
            self.assertEqual(paths.read_json(path), {"qa_batch": 30})

    def test_a_file_replaced_by_another_process_with_the_same_size_and_mtime_is_read_again(self):
        path = self.path
        with open(path, "w") as fh:
            json.dump({"qa_batch": 10}, fh)
        self.assertEqual(paths.read_json(path), {"qa_batch": 10})
        first, real_stat = os.stat(path), os.stat
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
        with os.fdopen(fd, "w") as fh:
            json.dump({"qa_batch": 30}, fh)
        os.replace(tmp, path)
        self.assertNotEqual(os.stat(path).st_ino, first.st_ino)
        with mock.patch("os.stat", stamped(real_stat, None, first)):
            self.assertEqual(paths.read_json(path), {"qa_batch": 30})


if __name__ == "__main__":
    unittest.main()
