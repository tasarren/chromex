---
name: chromex-development
description: Build, modify, test, document, package, install, or troubleshoot the Chromex pnpm workspace and its Chromium extension, MCP/native-host runtime, and Codex plugin. Use for changes under chromex/, dependency catalog updates, protocol changes, releases, local plugin reinstalls, or extension/native-host connection diagnosis.
---

# Chromex Development

Work from the `chromex` workspace root. Keep package boundaries explicit and keep the root documentation synchronized with behavior.

## Route Changes

- Put MV3 service-worker, popup, extension protocol, and manifest changes in `packages/extension`.
- Put MCP tools, the native host, broker framing, CDP controller, policy, and tests in `packages/mcp`.
- Put Codex plugin metadata, assembly, and local installation in `packages/plugin`.
- Put human-facing explanations in `docs` and reusable agent instructions in `skills`.
- Define shared dependency versions only in the named catalogs in `pnpm-workspace.yaml`.

Read the relevant document before changing a boundary:

- Architecture and ownership: `docs/architecture.md`
- Commands and change workflow: `docs/development.md`
- Protocol behavior: `docs/protocol.md`
- Origin and trust policy: `docs/security.md`
- Installation and update flow: `docs/installation.md`
- Failure diagnosis: `docs/troubleshooting.md`

## Implementation Workflow

1. Search the affected package and protocol callers before editing.
2. Preserve the extension ID, native-host name, protocol version, socket authentication, lease ownership, and exact-origin checks unless the requested change explicitly migrates them.
3. Add or update tests in `packages/mcp/test` for framing or policy behavior.
4. Update documentation and the relevant skill when commands, tools, installation, or safety behavior changes.
5. Run `pnpm lint:fix` after editing.
6. Run `pnpm verify`; do not hand off a build that fails any stage.
7. Validate the assembled plugin and each changed skill with the repository's documented validation commands.

## Local Plugin Update

After a successful build:

1. Run `pnpm install:local` from the workspace root.
2. Run the Codex plugin-creator cachebuster helper against `~/plugins/chrome-browser-bridge`.
3. Read the personal marketplace name with the plugin-creator helper.
4. Reinstall with `codex plugin add chrome-browser-bridge@<marketplace>`.
5. Ask the user to start a new Codex thread.

Do not edit the personal marketplace JSON or Codex configuration by hand.

## Extension Handoff

If the unpacked output path or extension manifest changes, tell the user to load or reload `packages/extension/dist` from `chrome://extensions`. Loading an unpacked extension is the only required GUI step.
