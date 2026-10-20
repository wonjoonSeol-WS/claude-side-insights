import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights.web import ensure  # noqa: E402


class BusyLock:
    def __init__(self, *_, **__):
        pass

    def __enter__(self):
        raise TimeoutError

    def __exit__(self, *_):
        return False


class LockTimeoutTest(unittest.TestCase):
    def run_timed_out(self, found):
        with tempfile.TemporaryDirectory() as data, mock.patch.object(ensure, "DATA", data), \
                mock.patch.object(ensure, "FileLock", BusyLock), mock.patch.object(ensure, "health", lambda: found):
            return ensure.ensure()

    def test_another_session_still_starting_counts_only_a_server_from_this_copy(self):
        self.assertTrue(self.run_timed_out({"app": ensure.APP_NAME, "root": ensure.ROOT}))
        self.assertFalse(self.run_timed_out({"app": ensure.APP_NAME, "root": "/old/plugin/0.12.3"}))
        self.assertFalse(self.run_timed_out(None))


if __name__ == "__main__":
    unittest.main()
