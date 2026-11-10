# Development

## Prerequisites

- Node.js 24.11 or newer (24 LTS)
- pnpm (the `Dockerfile` pins the version CI uses)
- Chromium or Chrome for Testing for the e2e and browser tests; see [Installation](installation.md#requirements)
- Codex CLI when its registration should be installed; setup uses its plugin commands when
  available and otherwise `codex mcp add`
- Claude Code, OpenCode, Grok and Cursor when their MCP registrations should be installed

## Workspace Commands

Run commands from `chromex`.

Use `pnpm` directly with your installed local tools. The Dockerfile pins Node and pnpm for
reproducible verification; local commands need no agent-toolchain wrapper.

| Command | Result |
| --- | --- |
| `pnpm install` | Install all workspace dependencies from named catalogs. |
| `pnpm dev` | Start the loopback Vite popup preview with sample data. |
| `pnpm dev:pointer` | Serve the development fixture (`packages/extension/dev/serve.ts`) on `http://127.0.0.1:5174/` (`POINTER_FIXTURE_PORT` overrides). |
| `pnpm lint:fix` | Apply safe ESLint fixes to TypeScript and JavaScript. |
| `pnpm check:code:density` | Report source density and concentration per package (`agent-loader codebase-audit`). |
| `pnpm check:code:duplicity` | Run the jscpd clone scan (4 minimum lines, 70 tokens); an empty scan or any clone fails. |
| `pnpm typecheck` | Type-check all four packages. |
| `pnpm test` | `vitest run`: the `unit`, `e2e` and `browser` projects. Run `pnpm build` first; see [Tests](#tests). |
| `pnpm inspect` | Start the Inspector web UI against the built MCP runtime; run `pnpm build` first. |
| `pnpm build` | `pnpm -r build`: Vite extension and tsdown MCP runtime, then tsdown plugin assembly. Each build cleans its `dist`. |
| `pnpm verify` | Run lint, duplicate scan, types, build, then tests. |
| `pnpm install:local` | Run `chromex setup` from the build: install the runtime and configure detected agent clients. |
| `pnpm install:local -- --no-open` | Perform the same setup without opening the store page. Other setup options (`--browsers`, `--scope`, `--skills`) follow `--` the same way; see [Installation](installation.md#install). |

ESLint fixes TypeScript and JavaScript only. It does not format JSON, CSS, YAML, or Markdown; the
version check and builds parse their JSON inputs, and unrelated file types keep their existing
tooling.

The shared ESLint rules match the Harness baseline: no semicolons, two-space indentation,
double quotes, automatic unused-import removal, and no console calls in TypeScript. Chromex retains
its browser/runtime import restrictions and separate browser/test TypeScript projects.

Relative TypeScript source imports use `.ts`, with `allowImportingTsExtensions` and `noEmit` enabled.
Package imports use their published export names (for example, the MCP SDK's `.js` subpaths).
Vite and tsdown produce the JavaScript paths used by the shipped runtime.

ESLint, jscpd, Vitest, Playwright, Vite, tsdown, TypeScript and the Inspector are development-only;
none enters a shipped artifact. The MCP build bundles its SDK and Zod closure, the extension build bundles browser code,
and the plugin bundles the CLI plus the assembled runtime.

## Develop the Popup UI

Run `pnpm dev` from the workspace root. Vite opens
`http://127.0.0.1:5173/popup.html` and listens only on `127.0.0.1`. Port 5173 must be free;
the server exits rather than silently switching ports. Stop it with Ctrl+C.

This serves the existing popup HTML, CSS and renderer in a regular browser. The visible
**Popup preview — sample data only** banner offers Observe, Managed and Empty / disconnected
samples. The selection is also available as `?sample=observe`, `?sample=managed` or `?sample=empty`.
Observe and release controls update only the sample in this page; they do not grant access,
contact an installed extension or control real tabs. Reloading or changing samples resets state.
CSS edits update in place; TypeScript and HTML edits reload the page through Vite. The sample
module and banner are excluded from production builds.

To test the actual extension, run `pnpm build`, then explicitly run `pnpm install:local` when
ready to replace the installed runtime. Reload the Observe extension at `chrome://extensions`.
Existing Managed browsers and MCP sessions keep their loaded code: follow the
[update sequence](installation.md#update), including closing only Chromex-managed windows,
waiting for their old service to exit and starting new agent sessions. The Vite preview does
not hot-reload installed extension workers or MCP processes.

## Fixture Pages

`pnpm dev:pointer` serves the pointer page in `packages/extension/dev/pointer/` and the pages in `packages/extension/dev/pages/` on `127.0.0.1` port 5174, and on `::1`
with the same port when IPv6 loopback exists. It serves a fixed file allowlist; other paths get
404, malformed targets 400 and non-GET 405. Stop it with Ctrl+C. The page is development-only: it
is not a Vite input and no build copies it.

Each section shows its state as `key=value` text and has its own reset button. **Reset all cases**
restores every case, including card order, the frame and highlight styles. The sections cover:

- movement and buttons;
- a range slider;
- a canvas stroke;
- native text selection;
- cards. The page records raw facts only and never decides whether a drag succeeded. The parent
  source and the frame's own card each record their starts, ends, active and last drag token, and
  `dropEffect`. Each target records its own drop count: a reorder within the source list, a local
  target, a pending-drop target, the frame, and a parent target for the reverse direction. Each drag
  carries a unique token tied to the current reset generation. A drop counts only for its source's
  active or last drag; a drop whose source has not reported yet waits as `uncorrelated` and counts
  only when that start arrives. Frame reports are bound to the current frame load and document, so a
  report from an earlier generation, load or document counts as `stale`. A frame drag cut off by a
  reload or a new load counts as `lost`, not as ended. A same-URL reload keeps the frame's window
  and load, so the page cannot order the two documents' reports: it shows `frame=reloaded-uncertain`
  and counts every report from that load as `stale` until the next load. An unknown or oversized payload counts as
  `rejected`. **Use cross-site frame** loads the frame from `localhost` instead of `127.0.0.1`;
- a file drop zone. It counts drops and files only and never reads, names or opens a file. An
  exact-byte payload check is not available yet;
- layout shift, geometry and document replacement.

The page only observes input. It never creates events or uses the clipboard, and it prevents the
default drop action only inside its drop zones. `trusted=` shows the browser's `isTrusted` value, not
who produced the input.

## Tests

`pnpm test` (`vitest run`) runs three Vitest projects from `vitest.config.ts`:

| Project | Files | What it proves |
| --- | --- | --- |
| `unit` | `packages/*/test/unit/` | Pure functions only: framing, key mapping, snapshot text, cursor path maths, version agreement. |
| `e2e` | `packages/*/test/e2e/` | The built plugin as an agent uses it: a real stdio MCP server, real Chromium with the extension, and the fixture pages. Files are grouped by behavior (browsers, tabs, navigation, reading, input, mouse, cursor, expiry, workspace, screenshots, extensions, packed install). |
| `browser` | `packages/*/test/browser/` | The page-side cursor script in Vitest's browser mode. No extension. |

The e2e project runs against `packages/plugin/dist/chromex/dist/`. Run `pnpm build`
first; the global setup (`packages/mcp/test/e2e/setup.ts`) stops with `Run pnpm build first` when the
build is missing. It then serves the fixture, creates one disposable root under the scratch area and,
at the end, closes every browser through the service shutdown and fails if a process that names the
root is still running. Each test file gets its own Git workspace, so files run in parallel without
sharing browsers, profiles or locks. Each file first checks that `chrome_status` reports extension
the manifest version and the protocol version. The oracle is what an agent or the page can see, not a receipt.

Environment:

- `CHROMEX_HEADLESS`: the e2e setup defaults it to `1`, so tests run without a window and do not take
  desktop focus. `CHROMEX_HEADLESS=0 pnpm exec vitest run --project e2e` opens a real window so you can
  watch. Managed also accepts `CHROMEX_HEADLESS=1` outside tests.
- `CHROMEX_BROWSER`: absolute path of Chromium when it is not on `PATH`. The `browser` project uses the
  same executable.
- `CHROMEX_TMP`: optional folder for the disposable fixtures the tests create. The default is the system
  temp folder.
- `CI`: with `CI` set and `CHROMEX_HEADLESS=1`, Managed adds `--no-sandbox` because a container without
  capabilities cannot start the Chromium sandbox. This applies only to a browser the tests launch.

Run one project or file with `pnpm exec vitest run --project e2e mouse`. A behavior that a later task
still has to build is a `test.todo` that names the task; todo items do not pass.

The fixture server is `packages/extension/dev/serve.ts`. It serves a fixed allowlist from
`packages/extension/dev/` (the pointer page and its frame, plus `pages/`) and nothing else. The tests call
its `serveFixture()` on a free port.

The agent-driven check of the mouse tools uses the real MCP tools loaded in an agent session, not a
runner. Serve the page with `pnpm dev:pointer`, select Managed, and for each of 390, 1440 and 1920 px
(`chrome_viewport`) run `chrome_status`, `chrome_mouse_move`, `chrome_click` (left, right, double),
`chrome_hover`, a held `chrome_mouse_down`, `chrome_mouse_move` and `chrome_mouse_up`, and a down
followed by `chrome_mouse_cancel`. Confirm that `chrome_snapshot` and `chrome_text` do not contain the
cursor and that `chrome_screenshot` shows it. Repeat move, down and up once on `chrome://version`.
Keep the page free of an accepting drop target. The 120-second expiry and controller loss are
covered by the recorded TASK-05 run and are not repeated per width.

## Inspect the MCP Server

The pinned development dependency is MCP Inspector `2.11.0`. It inspects the assembled stdio
runtime; it does not build, run setup, or register clients. Build first, then start the web UI:

```bash
pnpm build
pnpm inspect
```

`inspect` runs `mcp-inspector` against
`packages/plugin/dist/chromex/dist/mcp-server.mjs`. Inspector prints a tokenized URL
such as `http://127.0.0.1:6274?MCP_INSPECTOR_API_TOKEN=...` and opens it unless
`MCP_AUTO_OPEN_ENABLED=false`. Open that printed URL and do not paste or share the token. The UI
lists the ad-hoc server `node` (**STDIO**) as disconnected; click its connect toggle, then confirm
server `chromex` with the version from `packages/mcp/package.json`, the negotiated MCP protocol
version, the tool list, and `chrome_help` (its result starts "Managed is default" and lists every tool).
Managed browser tools start or join Chromium on first use, and Observe still needs its per-tab popup
grant. Stop the Inspector with Ctrl+C in the terminal; closing the browser tab does not stop it.
Ctrl+C stops the Inspector and its MCP client, not a shared Managed Chromium or its detached service
that browser tools started. The CLI probes below only initialize, list and call help, so they create
neither browser nor service. For a repeatable UI check, run under an isolated `HOME`/`XDG` directory
and set `MCP_INSPECTOR_SECRET_STORE=memory`; the ordinary `pnpm inspect` example above stays as is.

The scriptable CLI uses the same server path:

```bash
pnpm exec mcp-inspector --cli node packages/plugin/dist/chromex/dist/mcp-server.mjs --method initialize
pnpm exec mcp-inspector --cli node packages/plugin/dist/chromex/dist/mcp-server.mjs --method tools/list
pnpm exec mcp-inspector --cli node packages/plugin/dist/chromex/dist/mcp-server.mjs --method tools/call --tool-name chrome_help
```

These print one JSON result and exit. `initialize` reports server `chromex` with the package version
from `packages/mcp/package.json` and the negotiated MCP protocol version; `tools/list` returns every
registered tool; `chrome_help` returns each tool's signature (name, parameters, read/write kind) and the
recommended workflow. Names are sorted alphabetically, not in registration order. Use an isolated
`HOME`/`XDG` directory for repeatable checks, as the development tests do.

## Dependency Versions

Declare reusable versions under the named `runtime` or `tooling` catalog in `pnpm-workspace.yaml`. Package manifests reference them with `catalog:runtime` or `catalog:tooling`. Do not repeat numeric dependency versions in leaf manifests.

All Chromex manifests share one stable `MAJOR.MINOR.PATCH` project version. `packages/plugin/test/unit/versions.test.ts` (part of `pnpm test`) checks the root, package manifests, extension manifest and plugin manifest. `node packages/plugin/scripts/verify-release.mjs preflight` runs the same check in the release workflow, with the release tag taken from the event environment. Both only read files. Record completed changes in `CHANGELOG.md`; `PROTOCOL_VERSION` in `packages/protocol/src/rpc.ts` changes independently.

## Package and Release Artifact

`packages/plugin` is the one public package, `@tasarren/chromex`; the root, `@chromex/extension`,
`@chromex/mcp` and `@chromex/protocol` stay private build inputs (plugin `devDependencies` only).
Its `chromex` bin is `dist/cli.mjs`, bundled by tsdown from `src/cli.ts`: `cli.ts` parses the
command, `setup.ts` performs the installation, and `clients.ts` registers Codex, Claude Code,
OpenCode, Grok and Cursor. Shared constants are bundled; the CLI imports only Node built-ins. Builds emit no source
maps.
`packages/mcp/tsdown.config.ts` bundles the SDK and Zod; `deps.onlyBundle` lists their exact
bundled closure and `deps.onlyImport` allows only Node built-ins, so a new runtime package fails the
build until it is listed. The MCP build writes `THIRD_PARTY_NOTICES.md` from the modules tsdown
actually bundled, and `packages/plugin/tsdown.config.ts` copies it with the root `LICENSE`, plugin
metadata, the skill, runtime and extension into the assembled plugin. The root `LICENSE` is the only
tracked copy; the package ships it at `dist/chromex/LICENSE`.

Build and pack the tarball in the container, or pack a local build:

```bash
docker build --target artifact --output type=local,dest=build .   # build/tasarren-chromex-<version>.tgz, build/SHA256SUMS
pnpm verify && (cd packages/plugin && npm pack --pack-destination <dir>)
```

`packages/plugin/test/e2e/packed.test.ts` packs the plugin, installs the tarball with npm into a
temporary prefix and HOME, runs `chromex setup --no-open`, and starts the installed MCP server over
stdio. It runs with `pnpm test`.

The package has no lifecycle scripts, so packing and installing do not change the host.

## Clean-Room Verification and CI

The `Dockerfile` is the one pipeline for local runs and CI. Its stages, in order: `node-base` (Node,
pnpm, Chromium), `manifests` (frozen-lockfile install), `sources`, `app-build` (version check, lint,
duplicate scan, typecheck, the `unit` project, build, `npm pack` and `SHA256SUMS` into `/app/build`),
`artifact` (only `/app/build`), `verify` and `agent`. Needs Docker with Compose.

```bash
docker build --target artifact --output type=local,dest=build .   # tarball and SHA256SUMS in ./build
docker compose run --rm -T verify                                   # e2e and browser projects
docker compose run agent                                            # report only: build/agent/report.md
```

`verify` runs the `e2e` and `browser` projects with `CHROMEX_HEADLESS=1` and the container's
`/usr/bin/chromium`, with no network, all capabilities dropped and a 1 GB shared-memory limit
(`compose.yaml`). `agent` installs the packed tarball, starts OpenCode against it and records what the
tools returned; it is a report, not a gate. Build output and `.git` are kept out of the image by
`.dockerignore`.

`sh .github/scripts/scan-secrets.sh` scans full Git history and the tracked tree with pinned Gitleaks
8.30.1 (digest-checked) and `.gitleaks.toml`, printing only redacted rule/file/line results. The
config allows only the public extension key in its two known files. It downloads Gitleaks unless
`GITLEAKS_TARBALL` names a local copy.

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, and `workflow_call`, with a
read-only token and no persisted checkout credentials. Jobs: `verify` (the artifact build, then
`docker compose run --rm -T --build verify`), `privacy` (`scan-secrets.sh`), and
`dependency-review` (pull requests only; fails on high-severity advisories). The workflow defines an
aggregate `check` job; it becomes required when the repository ruleset is applied. `check` fails
unless `verify` and `privacy` succeed and `dependency-review` succeeds on pull
requests (skipped otherwise). Only the release workflow asks `verify` to export a candidate; see
[Release](release.md). Lint the workflows with the pinned actionlint image:

```bash
docker run --rm --network none -v "$PWD:/repo:ro" -w /repo \
  rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
```

Dependabot proposes weekly grouped npm, Actions, and Docker updates; nothing merges automatically.

## Change Checklist

1. Change the owning package only.
2. Change shared wire constants, types and envelope parsing only in `packages/protocol`.
3. Add tests for policy or framing changes.
4. Update `docs` and `skills` when commands, tools, permissions, or workflow changes.
5. Run `pnpm verify`.
6. When the Codex `plugin-creator` and `skill-creator` system skills are available locally,
   validate the assembled plugin (optional; setup itself does not need them):

   ```bash
   python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" \
     packages/plugin/dist/chromex
   ```

7. Validate both repository skills:

   ```bash
   python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" skills/chromex
   python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" skills/chromex-development
   ```
