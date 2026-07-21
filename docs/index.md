# Chromex Documentation

Chromex connects Codex to a user's existing Chromium session on Linux without depending on the ChatGPT desktop application.

## Guides

- [Architecture](architecture.md) — components, package ownership, and runtime flow.
- [Installation](installation.md) — build, native-host registration, extension loading, and plugin activation.
- [Browser tools](browser-tools.md) — MCP tool catalog and recommended agent sequence.
- [Development](development.md) — workspace commands, package changes, verification, and releases.
- [Protocol](protocol.md) — native messaging, broker frames, JSON-RPC, leases, and CDP forwarding.
- [Security](security.md) — trust boundaries, exact-origin policy, approvals, and secret handling.
- [Troubleshooting](troubleshooting.md) — common connection, debugger, origin, and cache failures.

## Agent Workflows

- Use `skills/chrome-browser` for browser operation.
- Use `skills/chromex-development` for repository development and local plugin updates.

The browser skill is copied into the assembled Codex plugin during `@chromex/plugin`'s build.
