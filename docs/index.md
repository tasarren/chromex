# Chromex Documentation

Chromex defaults to shared Managed Chromium per profile, with live tab handoff between agents. Observe access to the user's browser requires a per-tab extension-popup grant. No ChatGPT desktop application is required.

Chromex means Chromium Executor. New users start with the root [README](../README.md), then [Installation](installation.md) for requirements, setup options, update, and manual removal. Contributors read [CONTRIBUTING](../CONTRIBUTING.md).

## Guides

- [Architecture](architecture.md) — components, package ownership, and runtime flow.
- Technical diagrams, with the source files each one describes:
  [Processes](tech/processes.md), [One tool call](tech/requests.md), [Held gestures](tech/gestures.md),
  [Setup](tech/setup.md), [Build and release](tech/release.md).
- [Installation](installation.md) — requirements, build, setup, extension loading, update, and manual removal.
- [Browser tools](browser-tools.md) — MCP tool catalog and recommended agent sequence.
- [Development](development.md) — workspace commands, Inspector probes, package changes, verification, and releases.
- [Release](release.md) — release workflow guards, first-release setup, and recovery.
- [Protocol](protocol.md) — native messaging, broker frames, JSON-RPC, leases, and CDP forwarding.
- [Security](security.md) — trust boundaries, CDP pipe, unpacked extensions, approvals, and secret handling.
- [Troubleshooting](troubleshooting.md) — common connection, debugger, extension, and cache failures.

## Agent Workflows

- Use `skills/chromex` for browser operation. Setup installs it with `npx skills add`.
- Use `skills/chromex-development` for repository development and local plugin updates. It is not installed by setup.

The browser skill is copied into the assembled runtime during the `@tasarren/chromex` package build (`packages/plugin`).
