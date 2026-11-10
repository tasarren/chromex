# Setup

`npx @tasarren/chromex setup` copies a runtime to a fixed folder, then points browsers and agent
harnesses at that copy. Nothing it writes depends on the `npx` cache, so removing the cache or moving
Node's temp folder does not break an install.

## Flow

```mermaid
flowchart TD
  A["Start<br/>validate the packaged artifact"] --> B["Detect browsers on PATH<br/>and CHROMEX_BROWSER"]
  B --> C{"--scope given?"}
  C -->|no, terminal| Q["Ask: project or global<br/>default global"]
  C -->|no, no terminal| G["global"]
  C -->|yes| S["use it"]
  Q --> D
  G --> D
  S --> D
  D{"--browsers given?"} -->|no, terminal| P["Ask which browsers, default all"]
  D -->|no, no terminal| AL["all detected"]
  D -->|yes| PK["all, none or the names listed"]
  P --> R1
  AL --> R1
  PK --> R1
  R1["1 Copy the runtime to ~/plugins/chromex<br/>staged copy, then swap, old copy restored on failure"] --> R2["2 Remove the old install<br/>old folder, old skill link, old native-host files"]
  R2 --> R3["3 Write the bridge configuration<br/>token, socket path, display snapshot"]
  R3 --> R4["4 Write the native host<br/>one step per picked browser"]
  R4 --> R5["5 Open the extension page<br/>store page, or print the unpacked folder"]
  R5 --> R6{"scope"}
  R6 -->|project| M["6 Write ./.mcp.json"]
  R6 -->|global| H
  M --> H["Register each harness found<br/>Claude Code, Codex, OpenCode, Grok, Cursor"]
  H --> K["Install the Chromex skill<br/>npx skills add, -g for global"]
  K --> Z["Summary lines, exit status"]
```

Each box prints `[n/N] <action>...` and then `done`, `skipped: <reason>` or `warning: <text>`. The
total N is 10 (11 in project scope, which adds the `.mcp.json` step) plus one per picked browser, never
fewer than one, so it is known before the first step.

## What setup writes

```mermaid
flowchart LR
  subgraph home["~ (your home)"]
    subgraph plug["plugins/chromex"]
      D1["dist/mcp-server.mjs<br/>dist/managed-service.mjs<br/>dist/native-host.mjs"]
      D2["dist/extension<br/>bundled, manifest with key"]
      D3["dist/managed-environment.json<br/>display variables, mode 0600"]
      D4["skills/chromex<br/>.codex-plugin<br/>.agents/plugins"]
    end
    CF[".config/chromex/config.json<br/>token and socket, mode 0600"]
    NH[".config/BROWSER/NativeMessagingHosts/<br/>io.tasarren.chromex.json"]
  end
  NH -->|"path"| D1
  HX["Agent harness config<br/>global or project"] -->|"node + dist/mcp-server.mjs"| D1
  SK["Skill folders chosen by<br/>npx skills add"] -->|"copied or linked from"| D4
  BR["Browser"] -->|"reads at start"| NH
  CF -->|"read by"| D1
```

| Written | Where | Notes |
| --- | --- | --- |
| Runtime | `~/plugins/chromex` | Replaced whole on every run. Mode of `native-host.mjs` is `0700`. |
| Bridge config | `~/.config/chromex/config.json` | Token is kept across runs when it is valid. `CHROMEX_CONFIG` moves it for the server. |
| Display snapshot | `~/plugins/chromex/dist/managed-environment.json` | `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` |
| Native-host file | `~/.config/<browser>/NativeMessagingHosts/io.tasarren.chromex.json` | One per picked browser; lists the bundled and, once set, the store extension origin |
| Harness entries | See below | Replaced if present |
| Skill | Folders the skills CLI picks | Project or global with `-g` |

## Browsers and native-host files

```mermaid
flowchart LR
  subgraph found["Found on PATH"]
    B1["chromium, chromium-browser"]
    B2["google-chrome-stable, google-chrome"]
    B3["google-chrome-beta"]
    B4["google-chrome-unstable"]
    B5["brave-browser, brave"]
    B6["microsoft-edge-stable, microsoft-edge"]
    B7["vivaldi-stable, vivaldi"]
  end
  B1 --> F1["chromium"]
  B2 --> F2["google-chrome"]
  B3 --> F3["google-chrome-beta"]
  B4 --> F4["google-chrome-unstable"]
  B5 --> F5["BraveSoftware/Brave-Browser"]
  B6 --> F6["microsoft-edge"]
  B7 --> F7["vivaldi"]
  F1 & F2 & F3 & F4 & F5 & F6 & F7 --> N["~/.config/FOLDER/NativeMessagingHosts/<br/>io.tasarren.chromex.json"]
```

`CHROMEX_BROWSER` adds that executable as a `custom` browser; its folder follows the file name
(`beta`, `unstable`, `chrome` or `chromium`). `$XDG_CONFIG_HOME` replaces `~/.config`. A browser started
with its own `--user-data-dir` reads `<user-data-dir>/NativeMessagingHosts/` instead.

## Harness registration by scope

```mermaid
flowchart TD
  SC{"scope"}
  SC -->|global| GL
  SC -->|project| PR
  subgraph GL["global"]
    G1["Claude Code<br/>claude mcp add-json --scope user<br/>~/.claude.json or $CLAUDE_CONFIG_DIR"]
    G2["Codex<br/>plugin install, else codex mcp add<br/>~/.codex or $CODEX_HOME"]
    G3["OpenCode<br/>opencode mcp add chromex --global<br/>opencode.json or opencode.jsonc"]
    G4["Grok<br/>grok mcp add -s user<br/>~/.grok/config.toml"]
    G5["Cursor<br/>file write<br/>~/.cursor/mcp.json"]
  end
  subgraph PR["project (current directory)"]
    P0["./.mcp.json written once<br/>read by Claude Code and Grok"]
    P1["Codex<br/>./.codex/config.toml<br/>trusted projects only"]
    P2["OpenCode<br/>opencode mcp add chromex<br/>./opencode.json or ./opencode.jsonc"]
    P3["Cursor<br/>not registered"]
  end
```

Every entry runs `node ~/plugins/chromex/dist/mcp-server.mjs` with the absolute Node path that ran
setup. For each harness setup reads the target, then:

```mermaid
flowchart TD
  X["Read the harness config<br/>without starting a server"] --> Y{"chromex entry present?"}
  Y -->|no| AD["add<br/>result: added"]
  Y -->|yes, same Node, same runtime, no extra options| KP["leave it<br/>result: already current"]
  Y -->|yes, anything else| RP["replace it<br/>result: updated"]
  X -->|cannot parse| FL["result: failed<br/>other harnesses continue"]
  X -->|CLI not on PATH| SK["result: skipped: CLI not found"]
  AD --> W["the harness's own command writes its file,<br/>comments and other entries stay"]
  RP --> W
```

Exceptions: setup edits Codex's project table, Cursor's `mcp.json` and the project `./.mcp.json`
itself and keeps their other keys. A Grok project entry is reported `covered by .mcp.json`. A project
`./.mcp.json` that cannot be parsed stops setup, because several harnesses share it.

## Exit status

Setup exits nonzero when any found harness fails, or the project `./.mcp.json` fails. A failed
skill install, an unopened store page, a missing CLI and a kept foreign file are warnings and leave
the exit status at zero.

## Source

- `packages/plugin/src/cli.ts` (arguments, usage)
- `packages/plugin/src/setup.ts` (`Installation.run`, `Steps`, `chooseScope`, `detectBrowsers`, `selectBrowsers`, `replaceInstalledPlugin`, `registerNativeHost`, `openStorePage`, `installSkills`)
- `packages/plugin/src/clients.ts` (`harnesses`, `ClientRegistrar.registerAll`, `registerProjectMcpJson`, `planServer`, one method per harness)
- `packages/protocol/src/constants.ts`, `rpc.ts` (`CONFIG_DIRECTORY`, `NATIVE_HOST_NAME`, `EXTENSION_ID`, `STORE_EXTENSION_ID`)
- `packages/plugin/tsdown.config.ts` (what the runtime folder contains)
