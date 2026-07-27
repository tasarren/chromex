# Chromex

A readable TypeScript monorepo for local Chromium control from agents on Linux. Chromex defaults to shared
Managed Chromium per project/profile. Agents can hand off live tabs; user-browser Observe access requires a per-tab popup grant.
It contains only the new bridge implementation; the extracted Web Store extension is not imported or
modified.

## Packages

- `packages/extension` — MV3 Chromium extension using `chrome.debugger` and native messaging.
- `packages/mcp` — authenticated Unix-socket broker, native host, MCP server, and origin policy.
- `packages/plugin` — Codex plugin metadata, browser skill, artifact assembly, and local installer.

Dependency versions are centralized in the named `runtime` and `tooling` catalogs in
`pnpm-workspace.yaml`.

## Documentation and Skills

- Start with [`docs/index.md`](docs/index.md) for architecture, installation, tools, protocol, security, development, and troubleshooting.
- Use [`skills/chrome-browser`](skills/chrome-browser) for safe browser operation.
- Use [`skills/chromex-development`](skills/chromex-development) for workspace maintenance and plugin updates.

## Development

```bash
pnpm install
pnpm verify
```

Build outputs:

- `packages/extension/dist` — extension build input for plugin assembly.
- `packages/plugin/dist/chrome-browser-bridge` — personal Codex plugin artifact, including the extension used by Managed mode.

## Installation

After building, run `pnpm install:local`. The installer copies the assembled plugin to
`~/plugins/chrome-browser-bridge`, preserves or creates a user-only bridge token, and registers the
native-messaging host used by Observe mode. It also installs the Codex plugin and registers the same
MCP runtime globally for installed Claude Code and OpenCode CLIs. Run the installer from the
graphical Linux session Managed mode should use; it saves an owner-only, allowlisted display
environment beside the runtime so every MCP client launches Chromium consistently.

In an interactive desktop session the installer opens `chrome://extensions`. Enable Developer mode,
choose **Load unpacked**, and select `~/plugins/chrome-browser-bridge/dist/extension`. Use
`pnpm install:local -- --no-open` in CI or other headless sessions. Managed mode creates its own
private bridge and loads the packaged extension automatically on the first browser operation, including `chrome_status` or `chrome_tabs`.

Managed browsers outlive MCP clients. To hand off, release the tab and pass `browserId` plus `tabId` to the next agent's `chrome_use_tab`. The next agent takes a fresh snapshot; the page stays live. Close Chromium to end its runtime. For Observe, enable **Allow agents on this tab** in the popup, then use `observe: true`.

If the dedicated browser cannot start, `chrome_open` reports its exit status and a safe process-output
tail. The read-only `chrome_process_output` tool provides cursor-paged access to the latest bounded
stdout/stderr diagnostics without persisting browser logs.

The extension ID is `enbcklgjkjddndpkedgfhoeagcbogfdb`. Loopback sites and `about:blank` are
allowed automatically. Every other page is hidden until its exact origin is explicitly allowed.
