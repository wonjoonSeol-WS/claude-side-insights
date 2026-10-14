"""How one side_insights command starts another as a separate process."""
import os
import sys

from side_insights.paths import ROOT


def command_line(command, args):
    return [sys.executable, "-m", "side_insights", command, *args]


def child_env():
    src = os.path.join(ROOT, "src")
    return {**os.environ, "PYTHONUTF8": "1", "PYTHONPATH": os.pathsep.join(filter(None, [src, os.environ.get("PYTHONPATH")]))}
