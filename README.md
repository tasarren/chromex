# Chromex

A readable TypeScript monorepo for local Chromium control from Codex on Linux. It contains only the
new bridge implementation; the extracted Web Store extension is not imported or modified.

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

- `packages/extension/dist` — load this directory from `chrome://extensions` in Developer mode.
- `packages/plugin/dist/chrome-browser-bridge` — personal Codex plugin artifact.

## Installation

After building, run `pnpm install:local`. The installer copies the assembled plugin to
`~/plugins/chrome-browser-bridge`, preserves or creates a user-only bridge token, and registers the
Chromium native-messaging host.

The extension ID is `enbcklgjkjddndpkedgfhoeagcbogfdb`. Loopback sites and `about:blank` are
allowed automatically. Every other page is hidden until its exact origin is explicitly allowed.
