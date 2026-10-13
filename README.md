# Claude activity panel

**English** | [한국어](README.ko.md) | [日本語](README.ja.md)

**Did Claude answer every question I asked, and what did it actually change?**

In long coding sessions your questions get buried under pages of output, and a "done" message rarely shows how the changed code now works. This panel sits next to each [Claude Code](https://claude.com/claude-code) pane in [cmux](https://cmux.dev) or Orca and answers both, turn by turn:

- **Q&A check**: every question and request you sent in a turn, including messages typed while Claude was working, judged answered / partial / unanswered against what Claude actually said and did, with the missing part highlighted. Open items are re-checked as later turns answer them. You can override a status or archive an item, from the page or with `claude-qa`. For an open item, **↩ Ask again** copies a follow-up message to the clipboard to paste into Claude (it is typed into the pane directly when cmux's socket password mode is on, because cmux otherwise only accepts its own child processes).
- **Logic flow**: when a turn that edited files ends, a walkthrough of the changed feature in execution order: a step pipeline, what each step does and what changed, real code excerpts with the changed lines highlighted, changed files and the checks that ran.
- **Live activity**: every tool Claude calls (running, ok, failed, duration) and the files it changed, as it happens.

The panel and the analysis are available in English, Korean and Japanese.

## Screenshots

*Example data from a made-up project.*

**Q&A check**: each question with its status, the answer in short, and what is missing highlighted.

![Q&A tab](docs/qa.png)

**Logic flow**: the changed feature as steps in execution order, with real code and the changed lines highlighted. One concrete example is traced through every step; the state panel shows its values up to the current step, with this step's changes highlighted. These values are inferred from the code by the model, not captured at runtime.

![Logic flow tab](docs/flow.png)

**Live activity**: tools as they run and the files they changed.

![Live tab](docs/live.png)

**Settings** (⚙) and **Help** (`?`).

![Settings dialog](docs/settings.png)

![Help dialog](docs/help.png)

## How it works

```
Claude Code hooks ──► record.sh ──► logs/<pane>.jsonl ──┐
   (tool calls, prompt, stop)                           ├─► server.py (127.0.0.1:47821) ──► app.html in a browser pane
Stop hook ──► flow.py / qa.py ──► flows/, qa/ (JSON) ───┘
                 └─ headless `claude -p` (read-only tools, no MCP/hooks/CLAUDE.md)
```

- The live view costs nothing: hooks append JSON lines and the page polls the local server every second.
- Flow and Q&A are separate headless `claude -p` runs after a turn ends, so they never touch your session's context. A flow runs only for turns that edited files and can read code with Read/Grep/Glob. Q&A reads the conversation text only.
- Panel key: the cmux panel id, else the Orca pane key, else the session id. Q&A is stored per session and shows the current session only.
- In cmux the panel opens as a browser split to the right of the pane. In Orca it opens as a browser tab (Orca has no browser split).

## Requirements

macOS, Claude Code, `jq`, `curl`, `/usr/bin/python3` (3.9+, stdlib only; `xcode-select --install` provides it), zsh, and cmux or Orca.

## Install

```sh
git clone <this repo> ~/.claude/activity-panel
~/.claude/activity-panel/install.sh
```

`install.sh` adds the hooks to `~/.claude/settings.json` (a backup is written next to it, and only when something changes), appends a marked block to `~/.zshrc`, and puts `claude-panel`, `claude-flow`, `claude-qa` and `claude-activity` in `~/.local/bin`. Running it again changes nothing.

## Commands

Run these in a terminal, or inside Claude Code with a leading `!` (for example `! claude-panel`).

| Command | What it does |
|---|---|
| `claude-panel` | Show or hide this pane's panel |
| `claude-flow` / `claude-flow all` | Open this pane's panel / all panes full page in the default browser |
| `claude-qa list [--open]` | Questions in the current session with id and status |
| `claude-qa set <id> answered\|partial\|unanswered\|auto` | Override a status (`auto` returns to the model's verdict) |
| `claude-qa archive <id>` / `restore <id>` | Hide or bring back an item |
| `claude-activity` | Live view as a terminal UI in this pane |

Shortcuts inside the panel: `1` `2` `3` switch between Flow, Live and Q&A, `←` `→` move between flow steps, `?` opens help with all commands and settings.

## Settings

Open **⚙ Settings** at the top right of the panel. Changes are saved to `~/.claude/activity-panel/config.json` and apply from the next analysis; no restart needed.

**Apply to** chooses the scope: **All panels** changes the default, **This panel only** overrides it for this pane (and whichever Claude session runs in it), for example Japanese in one pane and Korean in another. A per-panel value is marked in the dialog and can be reset to follow the global one.

| Setting | Default | Meaning |
|---|---|---|
| Analysis model | `opus` | Model for flow and Q&A analysis (`opus`, `sonnet`, `haiku` or a full model id) |
| Language | `en` | Panel text and analysis output: English, 한국어, 日本語 |
| Build flows automatically | on | Off: build flows only with the ↻ button |
| Check Q&A automatically | on | Off: check Q&A only with the ↻ button |
| Open panel at session start | on | Off: open it only with `claude-panel` |

The only environment variable is `CLAUDE_PANEL_PORT` (default `47821`).

## FAQ

**How many extra Claude calls does this make?**
At most two per finished turn: one Q&A check every turn, plus one logic flow if the turn edited files. The live view makes none, and neither do status changes or archiving. `!` shell commands are not turns, so they trigger nothing. Each ↻ button press is one more call.

**What does it cost?**
Measured: a Q&A check $0.04 to $0.11 on Opus; a logic flow $0.16 to $0.17 on Sonnet (Opus not measured yet). A flow costs more the more code it reads. These are Claude Code's list-price estimates; on a subscription they presumably count toward plan usage instead (not verified). Switch the model to `sonnet` or `haiku`, or turn automatic runs off, to spend less.

**Does Claude write HTML every turn?**
No. There is one page template. The analysis returns JSON and the page renders it.

**Is ↻ Rebuild / ↻ Re-check an agent call?**
Yes. It starts the same headless `claude -p` run as the automatic one, with the same cost. It can only read files; it cannot edit them or run commands.

**Does it slow down or bloat my session?**
No. The analysis runs in a separate process after the turn ends and never adds to your session's context.

**Does the logic flow work for code logic?**
That is what it is for: it lays out the changed feature as runtime steps and shows real excerpts from the current files. It runs automatically only for turns that edited files; for an explain-only turn press ↻.

**A question was answered in a later turn but still shows as partial.**
Each turn is judged against its own replies. When a turn ends, open items from earlier turns in the session (up to 20) are re-checked against it and upgraded if answered. For older items press "↻ Re-check this question" on the item, or set the status yourself.

**How do I hide the panel or turn it off?**
`claude-panel` hides or shows it. To stop it opening on its own, switch off "Open panel at session start". To remove it, run `uninstall.sh` (add `--purge` to delete recorded data and settings too).

**Where is everything stored?**
In `~/.claude/activity-panel/`: `config.json` (settings), `logs/` (tool activity), `flows/` (logic flows), `qa/<pane>/<session>/` (Q&A, kept per session) and `qa/<pane>/overrides.json` (your status changes). None of it is committed to git. The page for a pane is `http://127.0.0.1:47821/p/<pane>`, and all panes are listed at `http://127.0.0.1:47821/`.

## Data and privacy

Everything stays on your machine, in files only your user can read. The server listens on 127.0.0.1, accepts only requests addressed to `127.0.0.1` or `localhost` (so a web page cannot reach it through DNS rebinding), and its POST endpoints require an `X-Claude-Panel` header, so other web pages cannot change settings or trigger paid runs.

## Uninstall

```sh
~/.claude/activity-panel/uninstall.sh          # keeps recorded data and settings
~/.claude/activity-panel/uninstall.sh --purge  # also deletes them
```

## Not verified

The Orca path (`orca tab create`) has not been run end to end.

## License

[MIT](LICENSE)
