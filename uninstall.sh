#!/bin/bash
# Removes the hooks, the ~/.zshrc block and the commands. --purge also deletes recorded data and settings.
set -uo pipefail

dir="$HOME/.claude/activity-panel"
/usr/bin/python3 - "$HOME/.claude/settings.json" <<'PY'
import json, os, shutil, sys, tempfile
path = os.path.realpath(sys.argv[1])
if not os.path.exists(path):
    sys.exit(0)
with open(path, encoding="utf-8") as fh:
    data = json.load(fh)
hooks = data.get("hooks", {})
ours = ("\"$HOME/.claude/activity-panel/record.sh\"", "\"$HOME/.claude/activity-panel/open-panel.sh\"")
changed = False
for event in list(hooks):
    kept = [e for e in hooks[event] if not any(h.get("command") in ours for h in e.get("hooks", []))]
    if len(kept) != len(hooks[event]):
        changed = True
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
if changed:
    shutil.copy2(path, path + ".bak-activity-panel")
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    shutil.copymode(path, tmp)
    os.replace(tmp, path)
PY

zshrc="$HOME/.zshrc"
if [ -f "$zshrc" ] && grep -q '>>> claude-activity-panel >>>' "$zshrc"; then
  /usr/bin/python3 - "$zshrc" <<'PY'
import os, re, sys
path = os.path.realpath(sys.argv[1])
with open(path, encoding="utf-8") as fh:
    text = fh.read()
text = re.sub(r"\n?# >>> claude-activity-panel >>>.*?# <<< claude-activity-panel <<<\n?", "\n", text, flags=re.S)
with open(path, "w", encoding="utf-8") as fh:
    fh.write(text)
PY
fi

rm -f "$HOME/.local/bin"/claude-panel "$HOME/.local/bin"/claude-flow "$HOME/.local/bin"/claude-qa "$HOME/.local/bin"/claude-activity
[ -r "$dir/key.sh" ] && . "$dir/key.sh" && stop_panel_server

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$dir"/logs "$dir"/flows "$dir"/qa "$dir"/turns "$dir"/config.json "$dir"/*.log
  echo "Uninstalled and deleted recorded data and settings."
else
  echo "Uninstalled. Recorded data and settings are kept in $dir (run with --purge to delete them)."
fi
