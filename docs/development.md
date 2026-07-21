# Development

## Prerequisites

- Node.js 22 or newer
- pnpm 10.33 or compatible
- Chromium with unpacked-extension support
- Codex CLI with personal plugins enabled

## Workspace Commands

Run commands from `chromex`.

| Command | Result |
| --- | --- |
| `pnpm install` | Install all workspace dependencies from named catalogs. |
| `pnpm lint:fix` | Format and apply safe lint fixes. |
| `pnpm typecheck` | Type-check all three packages. |
| `pnpm test` | Run MCP framing and origin-policy tests. |
| `pnpm build` | Build extension, MCP runtime, then assembled plugin. |
| `pnpm verify` | Run lint, version consistency, types, tests, and build. |
| `pnpm clean` | Remove generated package outputs. |
| `pnpm install:local` | Install the assembled plugin and native-host registration. |

## Dependency Versions

Declare reusable versions under the named `runtime` or `tooling` catalog in `pnpm-workspace.yaml`. Package manifests reference them with `catalog:runtime` or `catalog:tooling`. Do not repeat numeric dependency versions in leaf manifests.

All Chromex manifests share one project version. `pnpm versions` checks the root, package manifests, extension manifest, and plugin manifest.

## Change Checklist

1. Change the owning package only.
2. Update both protocol implementations when a shared constant or wire behavior changes.
3. Add tests for policy or framing changes.
4. Update `docs` and `skills` when commands, tools, permissions, or workflow changes.
5. Run `pnpm verify`.
6. Validate the assembled plugin:

   ```bash
   python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" \
     packages/plugin/dist/chrome-browser-bridge
   ```

7. Validate both repository skills:

   ```bash
   python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" skills/chrome-browser
   python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" skills/chromex-development
   ```
