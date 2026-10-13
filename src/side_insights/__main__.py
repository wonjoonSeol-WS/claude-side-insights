"""usage: python3 -m side_insights <command> [args...]

  server                        local web server for the panels
  flow <pane> <transcript> <cwd> [--force]
  qa <pane> <transcript> [...]  see analysis/qa.py
  activity [pane]               live activity as a terminal UI
  qa-cli [list|set|archive|restore] ...
  config get <name> [pane]
  say <message-key> [args...]
  detach <command> [args...]    run a command in its own session, so it outlives the hook
"""
import os
import runpy
import sys

from side_insights.launch import child_env, command_line

COMMANDS = {
    "server": "side_insights.web.server",
    "flow": "side_insights.analysis.flow",
    "qa": "side_insights.analysis.qa",
    "activity": "side_insights.live.viewer",
    "qa-cli": "side_insights.cli",
    "config": "side_insights.config",
    "say": "side_insights.i18n",
}
DETACHABLE = ("server", "flow", "qa")


def detach(args):
    if not args or args[0] not in DETACHABLE:
        sys.exit(f"usage: python3 -m side_insights detach {{{'|'.join(DETACHABLE)}}} [args...]")
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
