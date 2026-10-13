# Adding a terminal

Each terminal is one shell file in `terminals/`, tried in file-name order; the first whose `term_detect` succeeds is used. Copy `terminals/20-orca.sh` or `terminals/40-iterm.sh` and change it. The smallest working adapter looks like this:

```sh
# terminals/50-myterm.sh
PANE_ENV=MYTERM_PANE_ID

term_detect() { [ "${TERM_PROGRAM:-}" = myterm ]; }

term_open() { myterm split --right --command "$(panel_view_command "$1")"; }
```

Every name it can define:

| Name | Required | What it does |
|---|---|---|
| `term_detect` | yes | Succeeds when the current shell runs in this terminal (check its environment variables) |
| `term_open <key> <url>` | yes | Opens the panel for pane `<key>`. Show `<url>` in a browser view if the terminal has one, or run `$(panel_view_command <key>)` in a split |
| `term_find <key>` | no | Prints one handle per line for each open panel of `<key>`. A handle is any string your `term_close` understands. Without it the panel may open twice |
| `term_close <handle>` | no | Closes one panel. Without it `claude-panel` can only open |
| `PANE_ENV=<VAR>` | no | An environment variable that names this pane. Without it panels are keyed by the Claude session id |
| `CHILD_ENV_PREFIX=<PREFIX>` | no | Variables with this prefix are removed before the background analysis runs |

Write `PANE_ENV` and `CHILD_ENV_PREFIX` bare, as `NAME=VALUE` with no quotes and no `export`: the Python side reads them with a simple pattern.

`panel_view_command` prints one shell-quoted command line; pass it to your terminal as a single string. The split it starts sets its title to `$(panel_view_title <key>)`, so `term_find` can look for that title.

To test, run this from the repo root: `bash -c '. shell/key.sh; panel_terminal; panel_term find "$(panel_key "{}")"'`.
