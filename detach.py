"""Run a sibling script in its own session so it outlives the hook that started it. usage: detach.py <script> [args...]"""
import os
import sys

if __name__ == "__main__":
    try:
        os.setsid()
    except OSError:
        pass
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), sys.argv[1])
    os.execv(sys.executable, [sys.executable, script, *sys.argv[2:]])
