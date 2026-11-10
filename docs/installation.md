# Installation and Updates

## Requirements

- Linux. Managed mode needs a graphical session (X11 or Wayland).
- Node.js 24.11 or newer; pnpm to build from source. Use installed local tools directly;
  the Docker verification image pins Node and pnpm for reproducible checks.
- Managed mode: `chromium`, `chromium-browser`, or `chrome-for-testing` on `PATH`, or
  `CHROMEX_BROWSER` set to the executable. Google Chrome is rejected for Managed mode because it
  blocks command-line unpacked extensions.
- Observe mode: Chromium, Chrome (stable, Beta, Dev), Brave, Edge, or Vivaldi with the Chromex
  extension loaded unpacked (Developer mode). A Chrome Web Store listing may come later.
- Optional clients: Codex CLI, Claude Code, OpenCode v2, Grok, Cursor. Codex uses its plugin commands
  when present (observed with 0.163.0); a CLI without them gets a native `codex mcp add` entry.

Node resolution differs by client. Claude Code, OpenCode, Grok, Cursor, and native Codex entries record the
absolute Node path that ran setup. The Codex plugin and the Observe native host use `node` from
`PATH` (`#!/usr/bin/env node` for the host). Rerun setup after you move or replace your Node
installation.

## Install

```bash
npx @tasarren/chromex setup [--browsers all|none|<name,...>] [--scope project|global] [--skills none] [--no-open]
```

The package is on npm as `@tasarren/chromex` (the project is pre-1.0).

To run a checkout instead (from source), build it and run the same command through pnpm:

```bash
git clone https://github.com/tasarren/chromex.git
cd chromex
pnpm install
pnpm verify
pnpm install:local              # options follow `--`
```

`pnpm install:local` runs `chromex setup` from the workspace build and takes the same options after
`--`. In a headless session use, for example,
`pnpm install:local -- --browsers none --scope global --skills none --no-open`.

Setup is safe to rerun. It first asks, on a terminal, `Install for this project or globally?
[project/global] [global]`; see [Scope](#scope). Then it prints each step as `[n/N] <action>...`
with a result line (see [Progress output](#progress-output)) and:

1. Validates and stages the assembled plugin before replacing `~/plugins/chromex`. This stable path
   is the one every client and browser uses, so the install does not depend on the `npx` cache.
2. Creates or preserves the token in `~/.config/chromex/config.json` with mode `0600`.
   `CHROMEX_CONFIG` names another config file for the server.
3. Saves the graphical-session variables required by Managed Chromium in
   `~/plugins/chromex/dist/managed-environment.json` with mode `0600`.
4. Finds browsers and writes native host `io.tasarren.chromex` for the ones you pick (below).
5. Registers `chromex` with Codex, Claude Code, OpenCode, Grok and Cursor when they are present, in the chosen
   scope (see [Agent Registrations](#agent-registrations)).
7. Prints where the extension is, `~/plugins/chromex/dist/extension`, for you to load unpacked. If a
   Chrome Web Store ID is ever set, it opens that page in each picked browser instead.
8. Installs the skill: `npx --yes skills@1.7.6 add ~/plugins/chromex --skill chromex -y`, plus `-g`
   for a global scope. `--skills none` skips it. The skills CLI needs Node 22.20 or newer. A failure
   here is a warning and does not change the exit status.
9. Removes what earlier builds wrote under the old names (see [Earlier versions](#earlier-versions)).

Missing client CLIs are reported and skipped. A configuration failure for an installed client is
reported after setup attempts the remaining clients, and the command exits nonzero.

### Browsers

| Name | Commands searched on `PATH` | Native-host folder under `~/.config/` |
| --- | --- | --- |
| `chromium` | `chromium`, `chromium-browser` | `chromium/NativeMessagingHosts` |
| `chrome` | `google-chrome-stable`, `google-chrome` | `google-chrome/NativeMessagingHosts` |
| `chrome-beta` | `google-chrome-beta` | `google-chrome-beta/NativeMessagingHosts` |
| `chrome-dev` | `google-chrome-unstable` | `google-chrome-unstable/NativeMessagingHosts` |
| `brave` | `brave-browser`, `brave` | `BraveSoftware/Brave-Browser/NativeMessagingHosts` |
| `edge` | `microsoft-edge-stable`, `microsoft-edge` | `microsoft-edge/NativeMessagingHosts` |
| `vivaldi` | `vivaldi-stable`, `vivaldi` | `vivaldi/NativeMessagingHosts` |

`CHROMEX_BROWSER` adds that executable as a `custom` browser. `--browsers` takes `all`, `none`, or a
comma-separated list of the names above; a name that is not installed is skipped with a warning.
Without `--browsers`, a terminal prompt asks (default `all`); without a terminal, setup uses `all`.
`$XDG_CONFIG_HOME` replaces `~/.config` when set. Setup does not support browsers installed as Snap or
Flatpak packages.

### Options

| Option | Effect |
| --- | --- |
| `--browsers all\|none\|<name,...>` | Browsers that get the native-host file. |
| `--scope project\|global` | Where to register `chromex` and install the skill. Skips the question. |
| `--skills none` | Do not install the skill. Registration still follows `--scope`. |
| `--no-open` | Only matters once a store page exists: print its address instead of launching a browser. `CI=true` or a session without `DISPLAY`/`WAYLAND_DISPLAY` does the same. |

### Scope

On a terminal, setup asks once: `Install for this project or globally? [project/global] [global]:`.
Without a terminal it uses `global`. `--scope` answers the question in advance. The answer controls
both the MCP registration and the skill.

| | `global` | `project` (the current directory) |
| --- | --- | --- |
| Claude Code | `claude mcp add-json --scope user`, in `~/.claude.json` | `./.mcp.json`, written once by setup (`type: stdio`, `command`, `args`). Claude Code asks you to approve it in the first session. |
| OpenCode | `opencode mcp add chromex --global`, in `opencode.json` or `opencode.jsonc` under `~/.config/opencode` | `opencode mcp add chromex`, run in the project; writes `./opencode.jsonc` when it exists, else `./opencode.json` |
| Codex | Plugin (`codex plugin add`) when the CLI has plugin commands, else `codex mcp add chromex` | A `[mcp_servers.chromex]` table in `./.codex/config.toml`. Codex loads it only for a trusted project. |
| Grok | `grok mcp add -s user chromex`, in `~/.grok/config.toml` | Reads `./.mcp.json`; setup reports `covered by .mcp.json` |
| Cursor | The `mcpServers.chromex` entry (`command`, `args`) in `~/.cursor/mcp.json`; other keys stay | Not registered: Cursor has no project target in this version |
| Skill | `npx skills add ... -g` | `npx skills add ...` |

An existing `chromex` entry in the chosen scope is replaced, because it may be an older install.
Setup reports `added`, `updated` or `already current` for each client. Other entries and the comments
in your config files stay as they are. A client whose CLI is not found shows `skipped: CLI not found`.
A client whose config setup cannot parse (`~/.cursor/mcp.json`, `opencode.jsonc`) is reported as failed
and skipped; an unreadable project `./.mcp.json` stops setup, because it is the file several clients
share.

### Progress output

Each step prints a line `[n/N] <action>...` and then a result indented by two spaces: `done`,
`skipped: <reason>`, or `warning: <text>` (a failed client shows `failed: <text>`). The steps are:
Copy the Chromex runtime; Remove the old install; Write the bridge configuration; Write the native
host for each picked browser (one step per browser, or `skipped: no browser selected`); Open the
extension page; Write the project .mcp.json (project scope only); Register Codex, Claude Code, OpenCode,
Grok and Cursor (one step each for the clients found, `skipped: CLI not found` for the others);
Install the Chromex skill.
On a terminal, the slow steps (client CLIs and the skill install) show a spinner. With no terminal, or
with `CI=true`, there is no spinner. The summary lines at the end list the install folder, the config
file, the native-host files and each client's result.

## Install the Observe Extension

Managed mode loads its bundled extension itself. Observe needs the extension in your own browser.

Load it unpacked. Setup prints its folder at the end of the extension step.

1. Open `chrome://extensions` in the browser you want to use (Brave: `brave://extensions`, Edge:
   `edge://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `~/plugins/chromex/dist/extension`.

The bundled copy carries a manifest `key` that fixes its extension ID,
`enbcklgjkjddndpkedgfhoeagcbogfdb`, and the native-host file setup writes allows that origin. There is
no Chrome Web Store item yet; a listing may come later, and it would get its own ID, which setup would
add to the native-host file. Reload the unpacked extension after every update.

Observe remains disabled until the user enables **Allow agents on this tab** in the Chromex toolbar popup. Agents then select `observe: true`. Switch the toggle off, or choose **Release all tabs**, to revoke access.

Setup writes the native-host manifest to `~/.config/<browser>/NativeMessagingHosts/`, which is where the browser's default profile looks. A browser started with a custom `--user-data-dir` reads `<user-data-dir>/NativeMessagingHosts/` instead: copy `io.tasarren.chromex.json` there, or Observe stays disconnected.

Managed is default and needs no manual extension loading. The assembled plugin includes `dist/managed-service.mjs` and `dist/extension`. The first browser operation starts or joins one Chromium process per workspace profile, with a private native-host manifest and bridge. Managed needs a trusted workspace; see [Project Workspaces](#project-workspaces). After updating protocol versions, close old Managed browsers and restart MCP clients; reload an unpacked Observe extension.

Run setup from the graphical Linux session that Managed mode should use. It records only
`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`, and
`DBUS_SESSION_BUS_ADDRESS`. At launch, values supplied by the current MCP harness take precedence;
the saved values are a client-independent fallback. Rerun setup after changing graphical
sessions or display servers.

## Agent Registrations

Setup uses one stable runtime path, `~/plugins/chromex`, for all clients, in the [scope](#scope) you
chose (the table there lists the files each client writes). Globally:

- **Codex** receives the complete plugin from the `chromex` marketplace, including the browser
  skill and MCP definition, when the CLI has plugin commands. Otherwise it receives a native
  `chromex` stdio MCP entry that runs the installed runtime.
- **Claude Code** receives a user-scoped `chromex` stdio MCP entry.
- **OpenCode** receives a global `chromex` stdio MCP entry.
- **Grok** receives a user-scoped `chromex` entry through `grok mcp add`.
- **Cursor** receives a `chromex` entry in `~/.cursor/mcp.json`.

Setup reads each target config without starting any server: `~/.claude.json` (or
`$CLAUDE_CONFIG_DIR/.claude.json`); `opencode.json` or `opencode.jsonc`, with comments and trailing
commas ignored when reading; `./.codex/config.toml`; `~/.cursor/mcp.json`; `./.mcp.json`;
`grok mcp list --json`; and `codex mcp list --json`. It then calls the client's own command
(`claude mcp add-json`, `opencode mcp add`, `codex mcp add`, `grok mcp add`), so the client writes its
file and keeps your comments. Setup itself edits three files: Codex's project table, Cursor's
`mcp.json` and the project `./.mcp.json`. It keeps every other key in the last two.

- No `chromex` entry: setup adds one (`added`).
- A `chromex` entry that already runs this install's Node and `dist/mcp-server.mjs` with no extra
  options: left as is (`already current`).
- Any other `chromex` entry, including one with extra options such as `env`, `environment`, or
  `disabled`: replaced (`updated`), because it may be an older install. Claude Code restores the old
  entry if the new one cannot be added. Other MCP entries are left unchanged.
- A malformed config, a malformed `codex mcp list`/`codex plugin list` output, a failed plugin-list read
  on a CLI that advertises the plugin command, or a config file that cannot be parsed fails that
  client with a message and changes nothing for it. Other clients still run. Setup then exits nonzero;
  steps and clients that already succeeded stay in place.

Do not edit setup's global Codex entries by hand. Start a new agent session after setup so refreshed
skills and MCP tools are loaded.

The skill is installed by the skills CLI, not by a symlink from setup. A project scope puts it in
the agent skill folders of the current directory; a global scope puts it under your home folder.
The skills CLI chooses the agent folders. Its quick start and recovery table cover browser IDs,
workspaces, temporary profiles, local-server failures, handoff, and Observe consent.

### Earlier versions

Earlier builds used the name `chrome-browser-bridge`. Setup removes these, only when it owns them:

| Old item | Rule |
| --- | --- |
| `~/plugins/chrome-browser-bridge` | Removed after the new install is in place. |
| Native-host files `io.codex.chrome_bridge.json` | Removed when the file's `name` is that host. Any other file is kept with a warning. |
| `~/.agents/skills/chrome-browser` | Removed only when it is a symlink into the old install. Any other path is kept with a warning. |
| Client entry `chrome-browser-bridge` | Setup adds `chromex` first, then removes the old entry only when it launches this install: Claude Code through `claude mcp remove`, Codex by removing the old personal-marketplace plugin. |

A native Codex legacy entry is removed only when it is a default stdio entry with this Node and
runtime; custom `env_vars`, `cwd`, tool filters, timeouts or a disabled entry are kept, and setup
reports the `codex mcp remove chrome-browser-bridge` step so you can check them first. OpenCode has no
remove command, so the OpenCode step ends with `updated; warning: remove
mcp.servers["chrome-browser-bridge"] from <path> by hand`, and setup still exits 0. Delete that entry
yourself. The config folder `~/.config/chrome-browser-bridge/` is not read any more;
delete it when you no longer need it. Saved per-server tool approvals are keyed by server name;
approve `chromex` tools again.

## Project Workspaces

Managed profiles belong to one workspace: a project directory or Git worktree. Setup does not add
`--workspace`. A server started with a Git worktree as its working directory, as OpenCode starts one per
project, uses that worktree. A server started elsewhere (not in Git, your home directory or `/`) refuses
Managed requests until it has a trusted workspace. Observe works without one. In that case add a
project-scoped registration that passes `--workspace <absolute-directory>`:

- **Claude Code**: run `claude mcp add --scope local chromex -- <node> ~/plugins/chromex/dist/mcp-server.mjs --workspace <project>`
  from the project. Claude Code started in the project also works without `--workspace`, through
  `CLAUDE_PROJECT_DIR`.
- **OpenCode**: needs no `--workspace` inside a Git worktree. Outside Git, add a `chromex` entry to the
  project's `opencode.json` with `--workspace` in its command. It replaces the whole global `chromex`
  entry, so repeat global options such as `--extension`. A nested worktree without its own entry inherits
  the parent's entry and is refused.
- **Codex**: add a `chromex` server with `--workspace` to a trusted project's `.codex/config.toml`.

Without a trusted workspace Managed refuses every tool, including the mouse tools, with `No trusted
workspace for a Managed profile`. Observe works without one, including the mouse tools on a granted tab.

Each linked Git worktree is a separate workspace and needs its own entry. Profiles from earlier
versions, stored under `~/.local/share/chromex/profiles/`, are no longer used.

Check the resulting registrations with:

```bash
codex mcp list
codex plugin list   # only when the CLI has the plugin command
claude mcp get chromex
opencode mcp list
```

`claude mcp get` and `opencode mcp list` may start the server to check its health.

## Update

A shared Managed service outlives agent sessions. After its browser closes it waits 60 seconds,
then exits. A browser call during that wait restarts Chromium inside the old service, which keeps
the old runtime. Update in this order:

1. Stop every agent session that uses Chromex Managed browsers.
2. Close the Chromium windows that Chromex started. Do not close or kill unrelated Chromium.
3. Wait more than 60 seconds so each old service exits.
4. Run `npx @tasarren/chromex@latest setup`. From source: `git pull`, `pnpm install`, `pnpm verify`,
   then `pnpm install:local`. The token, Managed profiles, and unrelated client entries are kept.
5. Start new agent sessions. Reload the unpacked Observe extension in `chrome://extensions`. Setup runs
   the skill install again, which refreshes the skill.

## Manual Removal

There is no uninstall command. Stop agent sessions and close Chromex-managed Chromium first.
For each row, run the removal only when the check matches; otherwise the item belongs to something
else, so leave it. Paths assume default `XDG_CONFIG_HOME` and `XDG_DATA_HOME`. First set:

```bash
INSTALL="$HOME/plugins/chromex"
```

In the checks, `INSTALL` means that absolute path. For the native-host row, set `FILE` to one
absolute manifest path at a time, for example
`FILE="$HOME/.config/chromium/NativeMessagingHosts/io.tasarren.chromex.json"`.

| Item | Check | Removal |
| --- | --- | --- |
| Codex | `codex mcp list --json` shows `chromex` with `command` INSTALL-node and `args` `[INSTALL/dist/mcp-server.mjs]`, or (with plugin support) `codex plugin marketplace list --json` shows `chromex` with `root` `INSTALL` and `codex plugin list --json` shows `chromex@chromex` with `source.path` `INSTALL` | `codex mcp remove chromex` for the native entry; otherwise `codex plugin remove chromex@chromex`, then `codex plugin marketplace remove chromex` |
| Claude Code | `mcpServers.chromex` in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set) runs Node with the single argument `INSTALL/dist/mcp-server.mjs` | `claude mcp remove --scope user chromex` |
| OpenCode | `mcp.servers.chromex.command` in `~/.config/opencode/opencode.json` is `[<node>, "INSTALL/dist/mcp-server.mjs"]` | Delete that key by hand; OpenCode has no remove command |
| Grok | `grok mcp list --json` shows `chromex` running Node with `INSTALL/dist/mcp-server.mjs` | `grok mcp remove chromex` |
| Cursor | `mcpServers.chromex` in `~/.cursor/mcp.json` has `args` `["INSTALL/dist/mcp-server.mjs"]` | Delete that key by hand |
| Project files | `./.mcp.json`, `./opencode.json[c]`, `./.codex/config.toml` hold a `chromex` entry for `INSTALL` | Delete the `chromex` entry in each project that has one |
| Native host | For each `~/.config/*/NativeMessagingHosts/io.tasarren.chromex.json` (including `BraveSoftware/Brave-Browser`), `node -p 'require(process.argv[1]).path' "$FILE"` prints exactly `INSTALL/dist/native-host.mjs` | `rm -- "$FILE"` |
| Skill | `npx skills list` (add `-g` for a global install) shows `chromex` | `npx skills remove chromex` (add `-g` for a global install) |
| Runtime | All rows above are done | `rm -r -- "$INSTALL"` |
| Observe extension | ID `enbcklgjkjddndpkedgfhoeagcbogfdb` (unpacked) or the store ID in `chrome://extensions` | Remove it there |

Kept unless you delete them explicitly:

- `~/.config/chromex/`: bridge token.
- `~/.local/share/chromex/`: Managed browser profiles per workspace (cookies, sign-ins, history,
  unpacked extension lists), locks, and service records, plus unused profiles from earlier versions.
