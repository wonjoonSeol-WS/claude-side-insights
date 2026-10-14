"""What differs between macOS, Linux and Windows: processes, file locks, the browser and the clipboard."""
import os
import shutil
import signal
import subprocess
import sys
import time
import webbrowser

WINDOWS = os.name == "nt"
MAC = sys.platform == "darwin"
COPY_TIMEOUT = 5
LOCK_RETRY = 0.05
_STILL_ACTIVE = 259
_QUERY_LIMITED_INFORMATION = 0x1000
_ACCESS_DENIED = 5
_DETACHED_PROCESS = 0x00000008
_NEW_PROCESS_GROUP = 0x00000200
_BREAKAWAY_FROM_JOB = 0x01000000
_NO_WINDOW = 0x08000000
_LINUX_COPY = (["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"])

if WINDOWS:
    import ctypes
    import msvcrt
    from ctypes import wintypes
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
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    handle = kernel32.OpenProcess(_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ctypes.get_last_error() == _ACCESS_DENIED
    try:
        code = wintypes.DWORD()
        return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == _STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def detached(breakaway=True):
    """Popen keyword arguments for a child that outlives this process and its terminal."""
    if not WINDOWS:
        return {"start_new_session": True}
    flags = _DETACHED_PROCESS | _NEW_PROCESS_GROUP | _NO_WINDOW
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
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, timeout=COPY_TIMEOUT)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        proc.kill()


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

    def __init__(self, path):
        self.path = path
        self.fh = None

    def __enter__(self):
        self.fh = open(self.path, "a+")
        try:
            if WINDOWS:
                while True:
                    try:
                        self.fh.seek(0)
                        msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError:
                        time.sleep(LOCK_RETRY)
            else:
                fcntl.flock(self.fh, fcntl.LOCK_EX)
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
            if subprocess.run(command, input=data, timeout=COPY_TIMEOUT, capture_output=True).returncode == 0:
                return True
        except (OSError, subprocess.SubprocessError):
            continue
    return False


def claude_command():
    return shutil.which("claude") or "claude"
