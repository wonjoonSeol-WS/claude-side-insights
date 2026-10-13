# Claude activity panel

**English** | [한국어](README.ko.md) | [日本語](README.ja.md)

**Did Claude answer everything I asked? And what did it actually change?**

In a long coding session, your questions get buried under pages of output, and "Done" doesn't tell you how the changed code works now. This panel sits next to each [Claude Code](https://claude.com/claude-code) pane and answers both questions after every turn:

- **Q&A check**: lists every question and request you sent in the turn, including messages you typed while Claude was working. Each one is marked answered, partial or unanswered based on what Claude actually said and did, and the missing part is highlighted. Open items are checked again when later turns answer them. You can change a status or archive an item on the page or with `claude-qa`. For an open item, **⧉ Copy question** copies a message that asks it again, ready to paste into Claude.
- **Logic flow**: after a turn that edited files, walks through the changed feature in execution order. You get a pipeline of steps, what each step does and what changed in it, real code excerpts with the changed lines highlighted, the changed files and the checks that ran.
- **Live activity**: shows every tool Claude calls (running, succeeded, failed, how long it took) and the files it changed, as it happens.

The panel and its analysis are available in English, Korean and Japanese.

## Screenshots

*Sample data from a made-up project.*

**Q&A check**: each question with its status, a short summary of the answer, and the missing part highlighted.

![Q&A tab](docs/qa.png)

**Logic flow**: the changed feature as steps in execution order, with real code and the changed lines highlighted. One concrete example is followed through every step. The state panel shows its values up to the current step and highlights what this step changed. The model infers these values from the code; they are not captured at runtime.

![Logic flow tab](docs/flow.png)

**Live activity**: tools as they run, and the files they changed.

![Live tab](docs/live.png)

**Settings** (⚙) and **Help** (`?`).

![Settings dialog](docs/settings.png)

![Help dialog](docs/help.png)

## Supported terminals

| Terminal | What opens next to Claude | `claude-panel` can hide it | Tested |
|---|---|---|---|
| [cmux](https://cmux.dev) | The full panel (Flow, Live, Q&A) in a browser split | yes | yes |
| Orca | The full panel in a browser tab | no | no |
| Ghostty 1.3+ | The live view in a split. Open Flow and Q&A with `claude-flow` | yes | yes |
| iTerm2 | The live view in a split. Open Flow and Q&A with `claude-flow` | yes | no |
| Anything else (VS Code, Terminal.app, tmux, Warp, ...) | Nothing opens on its own. `claude-panel` opens the panel in your browser, and `claude-activity` shows the live view in any terminal | - | yes |

Ghostty and iTerm2 are driven through AppleScript, so macOS asks once for permission to control them.

To add a terminal, see [terminals/README.md](terminals/README.md); it is one small shell file.

## Requirements

macOS, Claude Code, `jq`, `curl`, `/usr/bin/python3` (3.9+, standard library only; `xcode-select --install` provides it) and zsh.

## Install

```sh
git clone https://github.com/wonjoonSeol-WS/claude-side-insights.git ~/.claude/activity-panel
~/.claude/activity-panel/install.sh
```

`install.sh` does three things:

- adds the hooks to `~/.claude/settings.json` (only if something is missing, and it saves a backup next to the file first)
- appends a marked block to `~/.zshrc`
- puts `claude-panel`, `claude-flow`, `claude-qa` and `claude-activity` in `~/.local/bin`

Running it again is safe; nothing changes.

## Commands

Run these in a terminal, or inside Claude Code with a leading `!` (for example `! claude-panel`).

| Command | What it does |
|---|---|
| `claude-panel` | Show or hide this pane's panel (see [Supported terminals](#supported-terminals)) |
| `claude-flow` / `claude-flow all` | Open this pane's panel, or the list of all panels, full page in the default browser |
| `claude-qa list [--open]` | List the current session's questions with id and status |
| `claude-qa set <id> answered\|partial\|unanswered\|auto` | Set a status yourself (`auto` goes back to the model's verdict) |
| `claude-qa archive <id>` / `restore <id>` | Hide an item, or bring it back |
| `claude-activity` | Show live activity as a terminal UI in this pane |

Keyboard shortcuts in the panel: `1` `2` `3` switch between Flow, Live and Q&A, `←` `→` move between flow steps, `?` opens help with every command and setting, and `Esc` closes it.

## Settings

Click **⚙ Settings** at the top right of the panel. Changes are saved to `~/.claude/activity-panel/config.json` and apply from the next analysis, with no restart.

**Apply to** sets the scope. **All panels** changes the default. **This panel only** overrides it for this pane and whichever Claude session runs in it, so you can, say, use Japanese in one pane and Korean in another. The dialog marks per-panel values, and you can reset each one to follow the global setting.

| Setting | Default | Meaning |
|---|---|---|
| Analysis model | `opus` | `opus`, `sonnet` or `haiku` (set a full model id in config.json) |
| Language (UI and analysis) | `en` | English, 한국어, 日本語 |
| Build a flow when a turn ends | on | When off, flows are built only with the ↻ button |
| Check Q&A when a turn ends | on | When off, Q&A is checked only with the ↻ buttons |
| Open the panel when a session starts | on | When off, the panel opens only with `claude-panel` |

The only environment variable is `CLAUDE_PANEL_PORT` (default `47821`).

## FAQ

**How many extra Claude calls does this make?**
At most two per finished turn: one Q&A check every turn, plus one logic flow if the turn edited files. The live view, status changes and archiving make no calls. `!` shell commands are not turns, so they trigger nothing. Each press of a ↻ button is one more call.

**What does it cost?**
Measured so far: $0.04 to $0.11 per Q&A check on Opus, and $0.16 to $0.17 per logic flow on Sonnet (Opus not measured yet). A flow costs more the more code it reads. These are Claude Code's list-price estimates. On a subscription they probably count toward your plan's usage instead, but we have not verified that. To spend less, switch the model to `sonnet` or `haiku`, or turn off the automatic runs.

**Does Claude write HTML every turn?**
No. There is a single page template. The analysis returns JSON, and the page renders it.

**Do ↻ Rebuild flow, ↻ Re-check open and ↻ Re-check this question call an agent?**
Yes. Each starts the same headless `claude -p` run as the automatic one, at the same cost. That run can only read files; it cannot edit them or run commands.

**Will it slow down my session or fill up its context?**
No. The analysis runs in a separate process after the turn ends and adds nothing to your session's context.

**Does the logic flow work for code logic?**
That is what it is for. It lays out the changed feature as runtime steps and shows real excerpts from the current files. It runs on its own only after turns that edited files; for a turn that only explained something, press ↻.

**A question was answered in a later turn, but it still shows as partial.**
Each check covers everything since the previous check, including messages you sent while Claude was working. Open items from earlier turns in the same session (up to 60) are checked against those new replies and upgraded if they were answered. For older items, press **↻ Re-check open** at the top (re-checks up to 40 open questions from the turns on the current page in one call), press **↻ Re-check this question** on a single item, or set the status yourself. If the check for a turn failed, that turn shows **↻ Re-check this turn**.

**How do I hide the panel or turn it off?**
`claude-panel` hides or shows it. To stop it from opening on its own, turn off "Open the panel when a session starts". To remove it completely, run `uninstall.sh` (add `--purge` to also delete recorded data and settings).

**Where is everything stored?**
Under `~/.claude/activity-panel/`:

- `config.json`: settings
- `token`: the secret the panel page and `claude-qa` send to the server
- `logs/`: tool activity
- `turns/`: where the current turn started, per pane
- `flows/`: logic flows
- `qa/<pane>/<session>/`: Q&A, kept per session
- `qa/<pane>/overrides.json`: statuses you changed

None of it is committed to git. Each pane's page is at `http://127.0.0.1:47821/p/<pane>?t=<token>`, and all panes are listed at `http://127.0.0.1:47821/?t=<token>`. `claude-flow` opens these with the token filled in.

## How it works

```
Claude Code hooks ──► record.sh ──► logs/<pane>.jsonl ──┐
   (tool calls, prompt, stop)                           ├─► server.py (127.0.0.1:47821) ──► app.html in a browser pane
Stop hook ──► flow.py / qa.py ──► flows/, qa/ (JSON) ───┘
                 └─ headless `claude -p` (read-only tools, no MCP servers or hooks)
```

- The live view is free: hooks append JSON lines, and the page polls the local server every second.
- Flow and Q&A each run as a separate headless `claude -p` after the turn ends, so they never touch your session's context. A flow runs only for turns that edited files (with Edit/Write, or a shell command that writes files), and it can read code with Read/Grep/Glob. Q&A reads the conversation text and the list of tools Claude used, not the files.
- Each panel is keyed by the pane id your terminal provides (see [Supported terminals](#supported-terminals)), or else by the session id. Q&A is stored per session and shows only the current one.

## Data and privacy

Everything stays on your machine, in files only your user can read. The server listens on 127.0.0.1 and accepts only requests addressed to `127.0.0.1` or `localhost`, so a web page cannot reach it through DNS rebinding. Every page needs the token from `~/.claude/activity-panel/token` in its URL, and every API call needs it in the `X-Claude-Panel` header. Other web pages and other users on the machine cannot read your activity, change your settings or start paid runs.

## Uninstall

```sh
~/.claude/activity-panel/uninstall.sh          # keeps recorded data and settings
~/.claude/activity-panel/uninstall.sh --purge  # also deletes them
```

## License

[MIT](LICENSE)
