"""What differs between macOS, Linux and Windows: processes, file locks, the browser and the clipboard."""
import errno
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
import webbrowser

WINDOWS = os.name == "nt"
MAC = sys.platform == "darwin"
COPY_TIMEOUT = 5
LOCK_RETRY = 0.05
_STILL_ACTIVE = 259
_QUERY_LIMITED_INFORMATION = 0x1000
_ACCESS_DENIED = 5
_BREAKAWAY_FROM_JOB = 0x01000000
_LOCK_BUSY = (errno.EACCES, errno.EDEADLK)
_LINUX_COPY = (["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"])

if WINDOWS:
    import ctypes
    import msvcrt
    from ctypes import wintypes

    _KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _KERNEL32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _KERNEL32.OpenProcess.restype = wintypes.HANDLE
    _KERNEL32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    _KERNEL32.CloseHandle.argtypes = (wintypes.HANDLE,)
else:
    import fcntl


def process_alive(pid):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if WINDOWS:
        return _windows_alive(pid)
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    try:
        return os.waitpid(pid, os.WNOHANG) == (0, 0)
    except ChildProcessError:
        return True


def _windows_alive(pid):
    handle = _KERNEL32.OpenProcess(_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ctypes.get_last_error() == _ACCESS_DENIED
    try:
        code = wintypes.DWORD()
        return bool(_KERNEL32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == _STILL_ACTIVE
    finally:
        _KERNEL32.CloseHandle(handle)


def detached(breakaway=True):
    """Popen keyword arguments for a child that outlives this process and its terminal."""
    if not WINDOWS:
        return {"start_new_session": True}
    flags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    return {"creationflags": flags | (_BREAKAWAY_FROM_JOB if breakaway else 0)}


def spawn_detached(argv, **kwargs):
    try:
        return subprocess.Popen(argv, **kwargs, **detached())
    except OSError:
        if not WINDOWS:
            raise
        return subprocess.Popen(argv, **kwargs, **detached(breakaway=False))


def kill_tree(proc):
    """Ends a child started with detached() and everything it started."""
    try:
        if WINDOWS:
            done = subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, timeout=COPY_TIMEOUT)
            if done.returncode == 0:
                return
        else:
            os.killpg(proc.pid, signal.SIGKILL)
            return
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        proc.kill()
    except OSError:
        pass


def terminate(pid):
    try:
        if WINDOWS:
            subprocess.run(["taskkill", "/F", "/PID", str(int(pid))], capture_output=True, timeout=COPY_TIMEOUT)
        else:
            os.kill(int(pid), signal.SIGTERM)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        pass


class FileLock:
    """An exclusive lock on a file, held across processes until the block ends."""

    def __init__(self, path, timeout=None):
        self.path = path
        self.timeout = timeout
        self.fh = None

    def _try(self):
        try:
            if WINDOWS:
                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno not in (*_LOCK_BUSY, errno.EAGAIN):
                raise
            return False
        return True

    def __enter__(self):
        self.fh = open(self.path, "a+")
        try:
            if self.timeout is None and not WINDOWS:
                fcntl.flock(self.fh, fcntl.LOCK_EX)
            else:
                deadline = None if self.timeout is None else time.monotonic() + self.timeout
                while not self._try():
                    if deadline is not None and time.monotonic() >= deadline:
                        raise TimeoutError(f"lock held: {self.path}")
                    time.sleep(LOCK_RETRY)
        except BaseException:
            self.fh.close()
            raise
        return self

    def __exit__(self, *_):
        try:
            if WINDOWS:
                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(self.fh, fcntl.LOCK_UN)
        finally:
            self.fh.close()


def open_url(url):
    if MAC:
        subprocess.Popen(["/usr/bin/open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    return webbrowser.open(url)


def copy_text(text):
    if MAC:
        commands, data = [["/usr/bin/pbcopy"]], text.encode("utf-8")
    elif WINDOWS:
        commands, data = [["clip"]], b"\xff\xfe" + text.encode("utf-16-le")
    else:
        commands, data = [c for c in _LINUX_COPY if shutil.which(c[0])], text.encode("utf-8")
    for command in commands:
        try:
            if subprocess.run(command, input=data, timeout=COPY_TIMEOUT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                return True
        except (OSError, subprocess.SubprocessError):
            continue
    return False


def _npm_target(shim):
    package = os.path.join(os.path.dirname(shim), "node_modules", "@anthropic-ai", "claude-code")
    try:
        with open(os.path.join(package, "package.json"), encoding="utf-8") as fh:
            bin_field = json.load(fh).get("bin")
    except (OSError, ValueError, AttributeError):
        bin_field = None
    target = bin_field.get("claude") if isinstance(bin_field, dict) else bin_field
    return os.path.join(package, target if isinstance(target, str) and target else "cli.js")


def claude_command():
    """The argv prefix that starts Claude Code. An npm .cmd shim goes through cmd.exe, which re-parses quotes and newlines in the arguments."""
    found = (WINDOWS and shutil.which("claude.exe")) or shutil.which("claude")
    if not found:
        return ["claude"]
    if WINDOWS and found.lower().endswith(".cmd"):
        target = _npm_target(found)
        if os.path.isfile(target):
            if not target.lower().endswith((".js", ".mjs", ".cjs")):
                return [target]
            node = shutil.which("node")
            if node:
                return [node, target]
    return [found]


_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def local_urlopen(request, timeout):
    """urlopen for the panel server on 127.0.0.1, never through an HTTP proxy from the environment."""
    return _LOCAL.open(request, timeout=timeout)
