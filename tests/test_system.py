import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from side_insights import system  # noqa: E402

HOLD = "import sys, time; sys.path.insert(0, sys.argv[1]); from side_insights.system import FileLock\nwith FileLock(sys.argv[2]):\n    print('held', flush=True); time.sleep(float(sys.argv[3]))"
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")


def remove_tree(path):
    def writable(func, target, _):
        os.chmod(target, stat.S_IWRITE)
        func(target)
    shutil.rmtree(path, onerror=writable)


class ProcessTest(unittest.TestCase):
    def test_this_process_is_alive_and_a_finished_one_is_not(self):
        self.assertTrue(system.process_alive(os.getpid()))
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait()
        self.assertFalse(system.process_alive(child.pid))
        self.assertFalse(system.process_alive("not a pid"))
        self.assertFalse(system.process_alive(None))

    def test_checking_a_running_child_does_not_end_it(self):
        child = system.spawn_detached([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            self.assertTrue(system.process_alive(child.pid))
            self.assertIsNone(child.poll())
        finally:
            system.kill_tree(child)
            child.wait(timeout=10)
        self.assertFalse(system.process_alive(child.pid))


class FileLockTest(unittest.TestCase):
    def test_a_second_process_waits_for_the_lock(self):
        folder = tempfile.mkdtemp()
        self.addCleanup(remove_tree, folder)
        path = os.path.join(folder, "x.lock")
        holder = subprocess.Popen([sys.executable, "-c", HOLD, SRC, path, "1.5"], stdout=subprocess.PIPE, text=True)
        self.assertEqual(holder.stdout.readline().strip(), "held")
        start = time.time()
        with system.FileLock(path):
            waited = time.time() - start
        holder.wait(timeout=10)
        self.assertGreater(waited, 0.5)


if __name__ == "__main__":
    unittest.main()
