#!/bin/bash
# Adds the Claude Code hooks, a ~/.zshrc block and the claude-panel / claude-flow / claude-qa / claude-activity commands.
set -euo pipefail

dir="$HOME/.claude/activity-panel"
here="$(cd "$(dirname "$0")" && pwd -P)"
if [ "$here" != "$(cd "$dir" 2>/dev/null && pwd -P)" ]; then
  echo "Clone or move this repo to $dir first (found at $here)." >&2
  exit 1
fi
/usr/bin/python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null || { echo "missing: /usr/bin/python3 3.9+ (xcode-select --install)" >&2; exit 1; }
for bin in jq curl claude; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing: $bin" >&2; exit 1; }
done

/usr/bin/python3 - "$HOME/.claude/settings.json" <<'PY'
import json, os, shutil, sys, tempfile
path = os.path.realpath(sys.argv[1])
data = {}
if os.path.exists(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
hooks = data.setdefault("hooks", {})
rec = {"type": "command", "command": "\"$HOME/.claude/activity-panel/record.sh\"", "timeout": 5}
opn = {"type": "command", "command": "\"$HOME/.claude/activity-panel/open-panel.sh\"", "timeout": 5}
wanted = [("PreToolUse", {"matcher": "*", "hooks": [rec]}), ("PostToolUse", {"matcher": "*", "hooks": [rec]}),
          ("PostToolUseFailure", {"matcher": "*", "hooks": [rec]}), ("UserPromptSubmit", {"hooks": [rec]}),
          ("Stop", {"hooks": [rec]}), ("SessionStart", {"hooks": [opn]})]
changed = False
for event, entry in wanted:
    commands = {h.get("command") for e in hooks.get(event, []) for h in e.get("hooks", [])}
    if entry["hooks"][0]["command"] not in commands:
        hooks.setdefault(event, []).append(entry)
        changed = True
if changed:
    if os.path.exists(path):
        shutil.copy2(path, path + ".bak-activity-panel")
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    if os.path.exists(path):
        shutil.copymode(path, tmp)
    os.replace(tmp, path)
    print("Added hooks to ~/.claude/settings.json (backup: settings.json.bak-activity-panel)")
PY

zshrc="$HOME/.zshrc"
touch "$zshrc"
if ! grep -q '>>> claude-activity-panel >>>' "$zshrc"; then
  cat >> "$zshrc" <<'ZSH'

# >>> claude-activity-panel >>>
# Settings: the panel's ⚙ Settings dialog (~/.claude/activity-panel/config.json).
[[ -r "$HOME/.claude/activity-panel/panel.zsh" ]] && source "$HOME/.claude/activity-panel/panel.zsh"
# <<< claude-activity-panel <<<
ZSH
  echo "Added a block to ~/.zshrc"
fi

mkdir -p "$HOME/.local/bin"
for cmd in claude-panel claude-flow; do
  printf '#!/bin/zsh\nsource "$HOME/.claude/activity-panel/panel.zsh"\n%s "$@"\n' "$cmd" > "$HOME/.local/bin/$cmd"
done
printf '#!/bin/sh\nexec /usr/bin/python3 "$HOME/.claude/activity-panel/cli.py" "$@"\n' > "$HOME/.local/bin/claude-qa"
printf '#!/bin/sh\nexec /usr/bin/python3 "$HOME/.claude/activity-panel/viewer.py" "$@"\n' > "$HOME/.local/bin/claude-activity"
chmod +x "$HOME/.local/bin"/claude-panel "$HOME/.local/bin"/claude-flow "$HOME/.local/bin"/claude-qa "$HOME/.local/bin"/claude-activity "$dir"/*.sh

echo "Installed. Start Claude Code in a cmux or Orca pane; the panel opens on its own."
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Add ~/.local/bin to PATH to use claude-panel, claude-qa and the others." ;; esac
