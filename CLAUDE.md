# CLAUDE.md

## Keep the surfaces at parity

The same panel ships as the `/si` mod pane (`hooks/mod/`), the browser panel (`src/side_insights/web/app.html`) and the terminal panel (`si-activity`).

- **A feature added or changed on one surface is not done until the browser panel has it too** (the terminal panel where it fits). This covers clicks, filters, toggles, diff views, tags, empty states, counters and settings.
- Before calling it done, list every element of the changed surface (locale keys, buttons, filters, states) and check each one on the other surface. Rendering checks do not catch a missing feature; the browser panel once fell behind the mod pane on diffs and every filter.
- Verify with captures of both surfaces, not by reading the code.
- Known exception: "go to it in the chat" (`m`, or clicking a Q&A answer) is pane-only. A browser click is not input to Claude Code, so the mod API refuses to scroll the chat for it.

## Testing

Run all of these before calling a change done:

- Mod pane: `claude plugin test .` and `claude plugin validate .`
- Python (server, diff, locales): `python3 -m unittest discover -s tests` (on macOS `/usr/bin/python3`, the one the plugin uses). After a locale edit run `/usr/bin/python3 tests/locale_fixture.py` first.
- Browser page: `node --test tests/browser/page.test.mjs` runs the page script against a fake server.
- In a real terminal: `tools/capture/drive.py` starts Claude Code in a pseudo terminal, sends keys and saves the screen; `tools/capture/paint.py` turns it into a PNG. `tools/capture/jump_probe.py` checks that the Q&A jump scrolls the real chat. Use a throwaway pane key, never `demo*`, and a trusted folder (`CAPTURE_CWD`). A prompt sent there is a real model call; interrupt it with `\x1b`.
- Hooks, server and diff end to end: `bash tests/e2e/hooks.sh` (temporary data folder, port 47899).
- The browser page in a real browser: drive headless Chrome over the DevTools protocol against the running server.
