# @tasarren/chromex

Chromex (Chromium Executor): local Chromium control for coding agents on Linux through an MCP bridge.

This package contains the prebuilt Chromex runtime, the Chromium extension, the `chromex` skill, and
the `chromex` setup command. Installing the package does not configure any application
until you run setup explicitly:

```bash
npx @tasarren/chromex setup [--browsers all|none|<name,...>] [--scope project|global] [--skills none] [--no-open]
npx @tasarren/chromex --help
npx @tasarren/chromex --version
```

`setup` copies the runtime to `~/plugins/chromex`, writes an owner-only bridge token under
`~/.config/chromex`, registers the `chromex` MCP server with each detected Codex, Claude Code, OpenCode, Grok,
and Cursor harness, writes the `io.tasarren.chromex` native messaging host for the browsers you pick,
prints where to load the unpacked extension, and installs the `chromex` skill with `npx skills add`
(for the scope you choose, project or global). Clients that are not installed are skipped. A detected client that
cannot be configured makes setup exit nonzero. A failed skill install is only a warning.

Requirements: Linux, Node.js 24.11 or newer, and Chromium (Managed mode) or a Chromium-based browser
with the Chromex extension (Observe mode).

Documentation: <https://github.com/tasarren/chromex#readme>. License: MIT. Bundled third-party
licenses: `dist/chromex/THIRD_PARTY_NOTICES.md`.
