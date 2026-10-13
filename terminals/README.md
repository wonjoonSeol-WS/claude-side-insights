# Adding a terminal

Each terminal is one shell file in `terminals/`, tried in file-name order; the first whose `term_detect` succeeds is used. Copy `terminals/30-ghostty.sh` and change it. The smallest working adapter looks like this:

```sh
# terminals/50-myterm.sh
PANE_ENV=MYTERM_PANE_ID

term_detect() { [ "${TERM_PROGRAM:-}" = myterm ]; }

term_open() { myterm split --right -- $(panel_view_command "$1"); }
```

Every name it can define:

| Name | Required | What it does |
|---|---|---|
| `term_detect` | yes | Succeeds when the current shell runs in this terminal (check its environment variables) |
| `term_open <key> <url>` | yes | Opens the panel for pane `<key>`. Show `<url>` in a browser view if the terminal has one, or run `$(panel_view_command <key>)` in a split |
| `term_find <key>` | no | Prints one handle per line for each open panel of `<key>`. Without it the panel may open twice |
| `term_close <handle>` | no | Closes one panel. Without it `claude-panel` can only open |
| `PANE_ENV=<VAR>` | no | An environment variable that names this pane. Without it panels are keyed by the Claude session id |
| `CHILD_ENV_PREFIX=<PREFIX>` | no | Variables with this prefix are removed before the background analysis runs |

A split that runs `panel_view_command` sets its title to `$(panel_view_title <key>)`, so `term_find` can look for that title. Test with `bash -c '. shell/key.sh; panel_terminal; panel_term find "$(panel_key "{}")"'`.
