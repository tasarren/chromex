# Build and release

One source tree produces two artifacts for two audiences: an npm tarball that `chromex setup`
installs, and a zip of the extension without its manifest `key`, kept for a possible Chrome Web Store
listing. Both come from one build, so the zip is the same code as the one setup copies.

## Build outputs

```mermaid
flowchart TD
  P["packages/protocol<br/>source export, no build"]
  X["packages/extension<br/>vite build"]
  M["packages/mcp<br/>tsdown"]
  L["packages/plugin<br/>tsdown, copies the others"]
  XD["extension/dist<br/>manifest WITH key"]
  MD["mcp/dist<br/>mcp-server, managed-service,<br/>native-host, THIRD_PARTY_NOTICES"]
  PD["plugin/dist/chromex<br/>assembled runtime"]
  CLI["plugin/dist/cli.mjs<br/>the chromex command"]
  T["tasarren-chromex-VERSION.tgz<br/>npm pack of packages/plugin"]
  Z["chromex-VERSION-chromium.zip<br/>manifest WITHOUT key"]
  P -->|"bundled into"| X
  P -->|"bundled into"| M
  P -->|"bundled into"| L
  X --> XD
  M --> MD
  XD -->|"copied as dist/extension"| PD
  MD -->|"copied as dist"| PD
  S["skills/chromex<br/>LICENSE<br/>src/chromex plugin metadata"] -->|"copied"| PD
  L --> CLI
  PD --> T
  CLI --> T
  XD -->|"scripts/package.ts<br/>drops key"| Z
```

| Output | Contains | Used by |
| --- | --- | --- |
| `packages/extension/dist` | The extension with the manifest `key`, which fixes the bundled extension's ID | Managed mode, and the unpacked Observe install |
| `packages/plugin/dist/chromex` | `dist/` with `mcp-server.mjs`, `managed-service.mjs`, `native-host.mjs`, `extension/`; `skills/chromex`; plugin metadata; `LICENSE`; third-party notices | Copied to `~/plugins/chromex` by setup |
| `packages/plugin/dist/cli.mjs` | The `chromex` command | `npx @tasarren/chromex` |
| `tasarren-chromex-<version>.tgz` | The two rows above | npm |
| `chromex-<version>-chromium.zip` | The extension files, with the manifest rewritten without `key` | A later store listing |

The store rejects a manifest `key`, and gives its item its own ID. The bundled copy keeps the `key`
because Managed mode loads it from disk and needs a known origin. The native-host file lists both
origins once the store ID is set.

## Release pipeline

```mermaid
flowchart TD
  R["GitHub release published<br/>(stable, tag v VERSION)"] --> PF["preflight<br/>event, tag, commit on main,<br/>all manifests equal,<br/>dated CHANGELOG section"]
  PF --> CI["ci: export-candidate<br/>docker build --target artifact:<br/>lint, duplicates, types, unit tests, build, npm pack.<br/>Same job: docker compose run verify, e2e"]
  CI -->|"artifact candidate:<br/>tgz, SHA256SUMS,<br/>inventory.txt, identity.txt"| ST["stage<br/>environment npm-release, OIDC<br/>verify candidate, npm stage publish"]
  ST -->|"npm approval by a person"| NPM["npm: @tasarren/chromex"]
  ST --> AT["attach<br/>verify candidate again,<br/>unpack tgz, run package.ts,<br/>upload only missing assets"]
  AT --> GH["GitHub release assets:<br/>tgz, SHA256SUMS, inventory, identity,<br/>chromium.zip, SHA256SUMS.txt"]
```

- `stage` and `attach` each re-check the downloaded candidate against the producer's SHA-256, so the
  bytes that were tested are the bytes that publish.
- A green `stage` means *awaiting npm approval*, not published.
- `attach` builds the store zip from the **tarball's** extension folder, not from a fresh build, so the
  zip matches what npm users get.
- `attach` never replaces an asset. An existing asset must be byte-equal to the candidate.
- A manual `workflow_dispatch` runs the same `preflight` and `ci` (`verify`), and with
  `rehearse-stage` also `stage`, but never `attach`.

## Store listing later

There is no Chrome Web Store item for now. Observe users load the unpacked extension. The release
still attaches the store zip so a listing can be created later from the same bytes; nothing uploads
it. The first item, its listing and its privacy answers would be created by hand in the store
dashboard. [Release](../release.md#chrome-web-store) says what changes if that happens.

## Variables and secrets

| Name | Kind | Workflow | Where |
| --- | --- | --- | --- |
| `npm-release` | environment | `release.yml` `stage` | Publishes with an OIDC token. The approval gate is on npm, not in GitHub |

## Source

- `Dockerfile` (`app-build`, `artifact`)
- `.github/workflows/ci.yml`, `release.yml`
- `packages/plugin/scripts/verify-release.mjs`
- `packages/plugin/tsdown.config.ts`, `packages/mcp/tsdown.config.ts`, `packages/extension/vite.config.ts`
- `packages/extension/scripts/package.ts`
- `packages/protocol/src/rpc.ts` (`EXTENSION_ID`, `STORE_EXTENSION_ID`)
