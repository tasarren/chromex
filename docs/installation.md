# Installation and Updates

## Build and Install

From `chromex`:

```bash
pnpm install
pnpm verify
pnpm install:local
```

The installer is safe to run again after every build. It:

1. Validates and stages the assembled plugin before replacing `~/plugins/chrome-browser-bridge`.
2. Creates or preserves the token in `~/.config/chrome-browser-bridge/config.json` with mode `0600`.
3. Saves the graphical-session variables required by Managed Chromium in
   `~/plugins/chrome-browser-bridge/dist/managed-environment.json` with mode `0600`.
4. Registers `io.codex.chrome_bridge` for each detected Chromium or Google Chrome installation.
5. Installs or refreshes the personal Codex plugin through the supported marketplace/cachebuster flow.
6. Registers the installed stdio MCP runtime in Claude Code and OpenCode when their CLIs are present.
7. Links `~/.agents/skills/chrome-browser` to `~/plugins/chrome-browser-bridge/skills/chrome-browser`. Reinstalls refresh the target; an existing different skill or link is preserved and reported.

Missing client CLIs are reported and skipped. A configuration failure for an installed client is
reported after the installer attempts the remaining clients, and the command exits nonzero.

For a headless install that must not open a browser window:

```bash
pnpm install:local -- --no-open
```

`CI=true` also disables the browser launch automatically.

## Load the Observe Extension

The installer opens `chrome://extensions` when it runs in an interactive graphical session.

1. Open `chrome://extensions` manually if it is not already open.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `~/plugins/chrome-browser-bridge/dist/extension`.

The fixed manifest key produces extension ID `enbcklgjkjddndpkedgfhoeagcbogfdb`, matching the native-host allowlist.

Observe remains disabled until the user enables **Allow agents on this tab** in the toolbar popup. Agents then select `observe: true`; exact-origin approval still applies.

Managed is default and needs no manual extension loading. The assembled plugin includes `dist/managed-service.mjs` and `dist/extension`. The first browser operation starts or joins a shared project/profile Chromium process with a private native-host manifest and bridge. After updating protocol versions, close old Managed browsers and restart MCP clients; reload the Observe extension.

Run the installer from the graphical Linux session that Managed mode should use. It records only
`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`, and
`DBUS_SESSION_BUS_ADDRESS`. At launch, values supplied by the current MCP harness take precedence;
the saved values are a client-independent fallback. Rerun the installer after changing graphical
sessions or display servers.

## Agent Registrations

The installer uses one stable runtime path for all clients:

- **Codex** receives the complete personal plugin, including the browser skill and MCP definition.
- **Claude Code** receives a user-scoped `chrome-browser-bridge` stdio MCP entry.
- **OpenCode** receives a global `chrome-browser-bridge` stdio MCP entry.

Only an existing `chrome-browser-bridge` registration is replaced. Other marketplace and MCP entries
are left unchanged.

Do not edit `~/.agents/plugins/marketplace.json` or Codex configuration by hand. The installer uses
the plugin-creator helpers and Codex CLI for initial installation and updates. Start a new Codex
thread after reinstalling so refreshed skills and MCP tools are loaded.

Start a new agent session to discover the shared browser skill under `~/.agents/skills`. Its quick start and recovery table cover browser IDs, temporary profiles, local-server failures, handoff, and Observe consent.

Check the resulting registrations with:

```bash
codex plugin list
claude mcp get chrome-browser-bridge
opencode mcp list
```
