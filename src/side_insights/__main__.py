"""usage: python3 -m side_insights <command> [args...]

  server                        local web server for the panels
  flow <pane> <transcript> <cwd> [--force]
  qa <pane> <transcript> [...]  see analysis/qa.py
  activity [pane]               live activity as a terminal UI
  qa-cli [list|set|archive|restore] ...
  config get <name> [pane]
  config opens-panel <pane>     1 when a session start there opens the panel
  client enable <pane>          switch the pane's analysis on, as opening /si does
  say <message-key> [args...]
  detach <command> [args...]    run a command in its own session, so it outlives the hook
  ensure-server                 start the server unless this copy of the code already serves
  record-event                  turn one hook payload on stdin into log lines (when jq is missing)
  open-url <url>                open a page in the default browser
"""
import os
import runpy
import subprocess
import sys

from side_insights.launch import child_env, command_line
from side_insights.system import WINDOWS, spawn_detached

COMMANDS = {
    "server": "side_insights.web.server",
    "flow": "side_insights.analysis.flow",
    "qa": "side_insights.analysis.qa",
    "activity": "side_insights.live.viewer",
    "qa-cli": "side_insights.cli",
    "config": "side_insights.config",
    "client": "side_insights.live.client",
    "say": "side_insights.i18n",
    "ensure-server": "side_insights.web.ensure",
    "record-event": "side_insights.live.record_event",
    "open-url": "side_insights.web.open_url",
}
DETACHABLE = ("server", "flow", "qa")


def detach(args):
    if not args or args[0] not in DETACHABLE:
        sys.exit(f"usage: python3 -m side_insights detach {{{'|'.join(DETACHABLE)}}} [args...]")
    if WINDOWS:
        spawn_detached(command_line(args[0], args[1:]), env=child_env(), stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=sys.stderr)
        return
    try:
        os.setsid()
    except OSError:
        pass
    os.execve(sys.executable, command_line(args[0], args[1:]), child_env())


def main():
    command, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else (None, [])
    if command == "detach":
        return detach(args)
    if command not in COMMANDS:
        sys.exit(__doc__)
    sys.argv[1:] = args
    runpy.run_module(COMMANDS[command], run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
