# Contributing

Chromex is a pnpm workspace for Linux. You need Node.js 24.11 or newer and pnpm; the `Dockerfile`
pins the pnpm version that CI uses.

1. Read [`docs/architecture.md`](docs/architecture.md) and change only the package that owns the
   behavior. [`docs/development.md`](docs/development.md) lists commands and the change checklist.
2. Keep the extension ID, manifest `key`, native-host name, protocol version, socket
   authentication, and lease checks unless the change explicitly migrates them.
3. Test behavior that agents can see, through the built MCP server and real Chromium
   (`packages/mcp/test/e2e/`). Use a unit test only for a pure function. Do not add fakes.
4. Update `docs/` and `skills/` when commands, tools, permissions, or workflow change, and add a
   line to the top section of [`CHANGELOG.md`](CHANGELOG.md) (`Unreleased`, or the version being prepared).
5. Run `pnpm lint:fix`, then `pnpm verify` (lint, duplicate scan, types, build, tests).
   For packaging or container changes, also run `docker compose run --rm -T verify`.

Do not include tokens, browser profiles, personal paths, or private page content in issues, logs,
screenshots, or commits. Report vulnerabilities privately as described in
[`SECURITY.md`](SECURITY.md).

Contributions are accepted under the [MIT license](LICENSE).
