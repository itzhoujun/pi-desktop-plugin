# Run Deck

A project's launch commands, one click away, inside the main window.

Run Deck contributes a **work-panel view** (`contributes.views`), so the UI
lives as a tab in the host's work panel, scoped to the current session — which
makes it per-project for free. There is no `open` command: the tab is opened
from the work panel's own view picker, next to Review and the other plugin
views, exactly like `git-workbench` does it. It is not a floating OS window:
the host gives plugins no way to anchor or clip a panel window to the main
window.

## What it does

- **Launch** = `{ name, command, cwd?, env? }`, and every project has its own
  list — there is no shared or global list to switch between.
- Start / stop a launch, watch its output in a read-only xterm terminal, see
  the port it announced, clear the buffer.
- Double-clicking a row starts it (stop while it runs); the start/stop icon in
  the row does the same. The pencil icon opens the editor dialog — the same
  dialog that ＋ uses for a new launch. The command box is multi-line (Enter
  adds a line, `Cmd`/`Ctrl`+`Enter` saves) because a real launch is often a
  short script, not one command. `Esc`, a click on the dimmed area, or Cancel
  closes the dialog without saving; a run's row still shows the command on one
  line. The dialog belongs to the project it was opened in — switching project
  closes it, and re-emitting `workspace:changed` for the same project does not.
- Starting a launch opens its output panel below automatically (taking over
  whichever launch was expanded before). A failed start leaves it closed.
- Max 8 concurrent processes, one process per launch.
- Agent tools (CRUD only, the agent cannot start anything):
  `run_deck_list`, `run_deck_create`, `run_deck_update`, `run_deck_delete`.
  `create` and `update` also take `cwd` (string) and `env` (flat
  `{KEY: "value"}` object); passing an empty value clears the field.
- The output panel is remembered per project: switching project hides it (that
  launch belongs to the other project), switching back reopens the same launch.
  Closing it yourself — or deleting the launch — is what forgets it.

## Where a launch runs

**Directory**: the launch's own `cwd` when set — `~`, `~/sub` and absolute paths
are taken as written, a relative path is resolved against the project — else the
project the launch belongs to (its workspace realpath), then `$HOME`. A missing
directory refuses to start (`NO_CWD`) instead of silently running somewhere else.

**Environment**: `env` is merged over the inherited environment and handed to
`spawn` directly, never through a shell, so a value with spaces or `$` stays
literally what was entered.

**PATH**: a GUI-launched app inherits launchd's minimal PATH, and `$SHELL -lc`
(login, non-interactive) never reads `.zshrc` — so `uv` in `~/.local/bin`,
`cargo` in `~/.cargo/bin`, nvm, asdf and pyenv all look "not installed".
Run Deck therefore asks the user's own login shell once per plugin load
(`$SHELL -ilc`, sentinel-marked so rc chatter cannot corrupt the answer, 5 s
cap) and prepends that PATH to the inherited one. If the probe fails or times
out, the inherited PATH is used unchanged. `deck.snapshot` reports the result
as `environment: {shell, source: "login-shell" | "inherited", path}`.

## Storage

Config is plugin-private, never in the workspace:
`~/.pi-desktop/plugins/data/local.run-deck/launches.json`

The path comes from the host (`pi.plugin.getDataPath()`); the plugin never uses
`localStorage`, `IndexedDB` or any other browser storage, and never writes into
the workspace.

```json
{
  "version": 3,
  "projects": {
    "<workspace realpath>": [
      {
        "id": "…",
        "name": "API",
        "command": "uv run python main.py",
        "cwd": "~/code/backend",
        "env": { "ENABLE_SCHEDULER": "False" },
        "createdAt": 0,
        "updatedAt": 0
      }
    ]
  }
}
```

`cwd` and `env` are optional and written only when set. **`env` values are
stored in plain text** in that file — they are conveniences like
`ENABLE_SCHEDULER=False`, not a secret store. Files from the older flat-list
layout are migrated once and left behind as `launches.json.v1-backup`.

`runs.json` holds only orphan hints (pid + name) from a previous session; it is
never used to kill anything automatically, because pids get reused.

## Execution

No PTY in v0.1 — output only, via `child_process.spawn`:

```js
spawn(shell, ["-lc", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
```

with `TERM=xterm-256color`, `FORCE_COLOR=3`, `CLICOLOR_FORCE=1`,
`PYTHONUNBUFFERED=1` so colours and line buffering behave without a tty.
(`script`/`unbuffer` were tried and rejected: `tcgetattr: Operation not
supported on socket`, `stty size` → `0 0`.) Windows uses `cmd /d /s /c`.

Stop escalates `SIGINT` → 3 s → `SIGTERM` → 2 s → `SIGKILL`, against the
process group when detached. `onUnload` stops everything.

Output is kept in a per-process ring buffer (1500 chunks / 200k chars, monotonic
`seq`) and streamed to the panel by long-polling (`deck.poll`, ≤ 10 s per call,
under the host's 30 s panel-channel budget).

## Styling

A plugin page is its own webContents, so the host's stylesheet never reaches it.
To keep the tab pixel-consistent with the app, the host's own design system is
vendored instead of approximated:

- `renderer/host-tokens.css` — the host's `--gray-*` scale, type scale, radii,
  motion, and the full `--ds-*` semantic set for dark and light, copied from
  `out/renderer/assets/index-*.css`.
- `renderer/host-controls.css` — the host's `.btn`, `.btn-primary`,
  `.btn-secondary`, `.btn-ghost`, `.icon-btn`, `.icon-btn-square` rules verbatim,
  plus the preflight subset they rely on and a `.field` input built from the same
  tokens as the host's own search fields.
- `renderer/deck.css` — layout only. No colour, radius or size is invented here.

Theme and language come from the host API, not from CSS:
`pluginBridge.invoke("app.getAppearance")` returns `{ theme, base, locale }` and
`pluginBridge.on("appearance:changed", …)` pushes later changes (switching the
app theme, the system appearance, or the interface language). `app.js` writes
`data-theme="light|dark"` on `<html>` to pick the token block and re-themes xterm
from `--ds-bg-inset` / `--ds-text-primary`. There is no `--pi-plugin-panel-theme`
CSS variable, and an embedded view has no `pi-plugin-panel-chrome` element, so an
unknown appearance falls back to `prefers-color-scheme`, never to a hard-coded
dark. Strings live in one `STRINGS = { en, zh }` table: `zh*` locales read
Chinese, everything else reads English. `workspace:changed` is also subscribed,
so switching project refills the list immediately.

The full rules (and the signals that look right but are not) are in
[`../AGENTS.md`](../AGENTS.md).

When the host stylesheet changes, re-copy those two files.

## Manifest

```json
"contributes": {
  "views": [
    {
      "id": "deck",
      "title": { "en": "Run Deck", "zh-CN": "启动台" },
      "icon": "terminal",
      "entry": "renderer/index.html",
      "order": 20
    }
  ]
},
"permissions": ["ui.view", "agent.tool.register"]
```

No `contributes.commands`: like `git-workbench`, the view is reachable from the
work panel's own picker (`pi.desktop.plugin/views` → `{title, icon, pluginName}`),
so the plugin does not need to open anything itself.

`ui.view` requires the plugin being active in the current project; the view is a
per-session tab, so the same plugin shows a different list in each project.
`title` and `icon` are optional — `title` accepts an i18n object, `icon` must be
one of the host's view icon tokens (an unknown one renders as a letter tile).

## Development

`DevPluginWatcher` reloads the plugin on any edit under this directory. Rapid
successive saves can race an unload and leave the plugin unloaded
(`plugin.reload.error: Plugin host process is no longer active`) — reload it from
the Plugins page if the tab stops responding.
