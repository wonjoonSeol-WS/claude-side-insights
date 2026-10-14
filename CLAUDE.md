# CLAUDE.md

## Keep the surfaces at parity

The same panel ships as the `/si` mod pane (`hooks/mod/`), the browser panel (`src/side_insights/web/app.html`) and the terminal panel (`si-activity`).

- **A feature added or changed on one surface is not done until the browser panel has it too** (the terminal panel where it fits). This covers clicks, filters, toggles, diff views, tags, empty states, counters and settings.
- Before calling it done, list every element of the changed surface (locale keys, buttons, filters, states) and check each one on the other surface. Rendering checks do not catch a missing feature; the browser panel once fell behind the mod pane on diffs and every filter.
- Verify with captures of both surfaces, not by reading the code.
- Known exception: "go to it in the chat" (`m`, or clicking a Q&A answer) is pane-only. A browser click is not input to Claude Code, so the mod API refuses to scroll the chat for it.
