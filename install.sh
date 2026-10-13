#!/bin/bash
# Installs the panel: Claude Code hooks, a ~/.zshrc block, and claude-panel / claude-flow / claude-qa commands.
# Safe to run again. Expects this repo at ~/.claude/activity-panel.
set -euo pipefail

dir="$HOME/.claude/activity-panel"
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$here" != "$dir" ]; then
  echo "Clone or move this repo to $dir first (found at $here)." >&2
  exit 1
fi
for bin in jq python3 claude; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing: $bin" >&2; exit 1; }
done

settings="$HOME/.claude/settings.json"
[ -f "$settings" ] || echo '{}' > "$settings"
cp "$settings" "$settings.bak-activity-panel.$(date +%Y%m%d%H%M%S)"
/usr/bin/python3 - "$settings" <<'PY'
import json, os, sys
path = sys.argv[1]
with open(path) as fh:
    data = json.load(fh)
hooks = data.setdefault("hooks", {})
rec = {"type": "command", "command": "\"$HOME/.claude/activity-panel/record.sh\"", "timeout": 5}
opn = {"type": "command", "command": "\"$HOME/.claude/activity-panel/open-panel.sh\"", "timeout": 5}
wanted = [
    ("PreToolUse", {"matcher": "*", "hooks": [rec]}),
    ("PostToolUse", {"matcher": "*", "hooks": [rec]}),
    ("PostToolUseFailure", {"matcher": "*", "hooks": [rec]}),
    ("UserPromptSubmit", {"hooks": [rec]}),
    ("Stop", {"hooks": [rec]}),
    ("SessionStart", {"hooks": [opn]}),
]
for event, entry in wanted:
    entries = hooks.setdefault(event, [])
    if not any("activity-panel" in h.get("command", "") for e in entries for h in e.get("hooks", [])):
        entries.append(entry)
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
os.replace(tmp, path)
PY

zshrc="$HOME/.zshrc"
touch "$zshrc"
if ! grep -q '>>> claude-activity-panel >>>' "$zshrc"; then
  cat >> "$zshrc" <<'ZSH'

# >>> claude-activity-panel >>>
# Settings live in the panel's settings dialog (⚙, saved to ~/.claude/activity-panel/config.json).
# An exported variable below overrides that setting and locks it in the dialog:
# export CLAUDE_FLOW_MODEL=opus   # analysis model: opus | sonnet | haiku | full model id
# export CLAUDE_PANEL_LANG=en     # panel UI and analysis language: ko | en | ja
# export CLAUDE_FLOW_AUTO=1       # 0 = build logic flows only from the button
# export CLAUDE_QA_AUTO=1         # 0 = check Q&A only from the button
# export CLAUDE_PANEL_AUTO=1      # 0 = do not open the panel at session start
[[ -r "$HOME/.claude/activity-panel/panel.zsh" ]] && source "$HOME/.claude/activity-panel/panel.zsh"
# <<< claude-activity-panel <<<
ZSH
fi

mkdir -p "$HOME/.local/bin"
for cmd in claude-panel claude-flow; do
  printf '#!/bin/zsh\nsource "$HOME/.claude/activity-panel/panel.zsh"\n%s "$@"\n' "$cmd" > "$HOME/.local/bin/$cmd"
  chmod +x "$HOME/.local/bin/$cmd"
done
printf '#!/bin/sh\nexec /usr/bin/python3 "$HOME/.claude/activity-panel/cli.py" "$@"\n' > "$HOME/.local/bin/claude-qa"
chmod +x "$HOME/.local/bin/claude-qa" "$dir"/*.sh "$dir"/*.py

echo "Installed. Open a new terminal (or: source ~/.zshrc) and start Claude Code in a cmux or Orca pane."
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Note: add ~/.local/bin to PATH for claude-panel / claude-qa." ;; esac
