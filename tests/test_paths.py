import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights import paths  # noqa: E402


class ReadJsonTest(unittest.TestCase):
    def test_a_rewrite_with_the_same_stamp_is_still_read(self):
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder)
        path = os.path.join(folder, "config.json")
        paths.atomic_write_json(path, {"qa_batch": 10})
        self.assertEqual(paths.read_json(path), {"qa_batch": 10})
        first, real_stat = os.stat(path), os.stat
        paths.atomic_write_json(path, {"qa_batch": 30})

        def same_stamp(target, *args, **kwargs):
            st = real_stat(target, *args, **kwargs)
            return os.stat_result((st.st_mode, first.st_ino, st.st_dev, st.st_nlink, st.st_uid, st.st_gid, st.st_size,
                                   st.st_atime, st.st_mtime, st.st_ctime, st.st_atime, st.st_mtime, st.st_ctime,
                                   st.st_atime_ns, first.st_mtime_ns, st.st_ctime_ns))

        with mock.patch("os.stat", same_stamp):
            self.assertEqual(paths.read_json(path), {"qa_batch": 30})


if __name__ == "__main__":
    unittest.main()
