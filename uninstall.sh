#!/bin/bash
# Removes the hooks, the ~/.zshrc block and the commands. Keeps recorded data unless --purge.
set -euo pipefail

settings="$HOME/.claude/settings.json"
if [ -f "$settings" ]; then
  cp "$settings" "$settings.bak-activity-panel.$(date +%Y%m%d%H%M%S)"
  /usr/bin/python3 - "$settings" <<'PY'
import json, os, sys
path = sys.argv[1]
with open(path) as fh:
    data = json.load(fh)
hooks = data.get("hooks", {})
for event in list(hooks):
    kept = [e for e in hooks[event] if not any("activity-panel" in h.get("command", "") for h in e.get("hooks", []))]
    if kept:
        hooks[event] = kept
    else:
        del hooks[event]
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
os.replace(tmp, path)
PY
fi

zshrc="$HOME/.zshrc"
if [ -f "$zshrc" ] && grep -q '>>> claude-activity-panel >>>' "$zshrc"; then
  /usr/bin/python3 - "$zshrc" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
text = re.sub(r"\n?# >>> claude-activity-panel >>>.*?# <<< claude-activity-panel <<<\n?", "\n", text, flags=re.S)
open(path, "w").write(text)
PY
fi

rm -f "$HOME/.local/bin/claude-panel" "$HOME/.local/bin/claude-flow" "$HOME/.local/bin/claude-qa"
. "$HOME/.claude/activity-panel/key.sh" && stop_panel_server

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$HOME/.claude/activity-panel"/{logs,flows,qa,turns,opened,viewers}
  echo "Uninstalled and removed recorded data."
else
  echo "Uninstalled. Recorded data kept in ~/.claude/activity-panel (run with --purge to delete it)."
fi
