import importlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

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



class LockTimeoutTest(unittest.TestCase):
    def test_a_lock_held_elsewhere_gives_up_after_its_timeout(self):
        folder = tempfile.mkdtemp()
        self.addCleanup(remove_tree, folder)
        path = os.path.join(folder, "x.lock")
        holder = subprocess.Popen([sys.executable, "-c", HOLD, SRC, path, "5"], stdout=subprocess.PIPE, text=True)
        self.addCleanup(holder.wait)
        self.addCleanup(holder.kill)
        self.assertEqual(holder.stdout.readline().strip(), "held")
        began = time.monotonic()
        with self.assertRaises(TimeoutError):
            with system.FileLock(path, timeout=0.3):
                pass
        self.assertLess(time.monotonic() - began, 3)


class Ok(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_):
        pass


class LocalRequestTest(unittest.TestCase):
    def test_a_proxy_in_the_environment_is_not_used_for_the_panel_server(self):
        server = HTTPServer(("127.0.0.1", 0), Ok)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        proxy = {"http_proxy": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9", "no_proxy": "", "NO_PROXY": ""}
        with mock.patch.dict(os.environ, proxy):
            importlib.reload(system)
            self.addCleanup(importlib.reload, system)
            with system.local_urlopen(f"http://127.0.0.1:{server.server_port}/", timeout=5) as resp:
                self.assertEqual(resp.read(), b"ok")


class ClaudeCommandTest(unittest.TestCase):
    def test_an_npm_cmd_shim_on_windows_runs_node_with_the_package_script(self):
        folder = tempfile.mkdtemp()
        self.addCleanup(remove_tree, folder)
        script = os.path.join(folder, "node_modules", "@anthropic-ai", "claude-code", "cli.js")
        os.makedirs(os.path.dirname(script))
        open(script, "w").close()
        found = {"claude": os.path.join(folder, "claude.CMD"), "node": "/bin/node"}
        with mock.patch.object(system, "WINDOWS", True), mock.patch.object(system.shutil, "which", found.get):
            self.assertEqual(system.claude_command(), ["/bin/node", script])
        with mock.patch.object(system, "WINDOWS", False), mock.patch.object(system.shutil, "which", found.get):
            self.assertEqual(system.claude_command(), [found["claude"]])


    def package(self, bin_field=None, script="cli.js"):
        folder = tempfile.mkdtemp()
        self.addCleanup(remove_tree, folder)
        package = os.path.join(folder, "node_modules", "@anthropic-ai", "claude-code")
        os.makedirs(package)
        if bin_field is not None:
            with open(os.path.join(package, "package.json"), "w") as fh:
                json.dump({"bin": bin_field}, fh)
        if script:
            open(os.path.join(package, script), "w").close()
        return folder, package

    def command(self, found):
        with mock.patch.object(system, "WINDOWS", True), mock.patch.object(system.shutil, "which", found.get):
            return system.claude_command()

    def test_the_shim_stays_when_node_or_the_script_is_missing(self):
        folder, _ = self.package(script=None)
        shim = os.path.join(folder, "claude.cmd")
        self.assertEqual(self.command({"claude": shim, "node": "/bin/node"}), [shim])
        folder, _ = self.package()
        shim = os.path.join(folder, "claude.cmd")
        self.assertEqual(self.command({"claude": shim}), [shim])

    def test_the_package_bin_target_wins_over_cli_js(self):
        folder, package = self.package({"claude": "bin/claude.js"}, script=None)
        os.makedirs(os.path.join(package, "bin"))
        open(os.path.join(package, "bin", "claude.js"), "w").close()
        shim = os.path.join(folder, "claude.cmd")
        self.assertEqual(self.command({"claude": shim, "node": "/bin/node"}), ["/bin/node", os.path.join(package, "bin/claude.js")])

    def test_a_native_claude_exe_is_preferred_over_the_npm_shim(self):
        folder, _ = self.package()
        self.assertEqual(self.command({"claude.exe": "/x/claude.exe", "claude": os.path.join(folder, "claude.cmd"), "node": "/bin/node"}),
                         ["/x/claude.exe"])


if __name__ == "__main__":
    unittest.main()
