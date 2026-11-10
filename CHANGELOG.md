# Changelog

All notable changes to Chromex are recorded here. Versions use `MAJOR.MINOR.PATCH`; tags are
`v<version>`. Before 1.0, a minor version may contain incompatible changes to behavior,
configuration, or tools, and its entry explains the migration. A patch version contains compatible
fixes only. The extension–host protocol version is separate from the project version.

## 0.1.3 - 2026-11-10

This is the first published release (`@tasarren/chromex` on npm). It renames the install, config, native host and
skill, so read **Changed** before you upgrade a build from source.

### Added

- Setup options `--browsers all|none|<name,...>`, `--scope project|global` and `--skills none`. Setup finds
  Chromium, Chrome, Chrome Beta, Chrome Dev, Brave, Edge and Vivaldi, writes the native-host file for
  the ones you pick (a terminal asks; without one, all), prints the folder of the extension to load unpacked,
  and installs the skill with `npx --yes skills@1.7.6 add ~/plugins/chromex --skill chromex -y` (`-g` for
  a global scope). There is no Chrome Web Store item for now; setup would open its page only if a store
  ID is ever set.
- Setup asks whether to install for this project or globally (`--scope` answers in advance; without a
  terminal it uses global). The scope sets where `chromex` is registered and where the skill goes.
  Project scope writes `./.mcp.json` (Claude Code), `./opencode.json` or `./opencode.jsonc` (OpenCode)
  and `./.codex/config.toml` (Codex, trusted projects only).
- Setup prints every step as `[n/N] <action>...` followed by `done`, `skipped: <reason>` or
  `warning: <text>`, with a spinner on a terminal for the slow steps (client CLIs, skill install).
  No spinner without a terminal or with `CI=true`.
- Setup registers `chromex` with five harnesses: Claude Code, Codex, OpenCode, Grok and Cursor. Global
  scope uses each one's own command or user file (`claude mcp add-json --scope user`, Codex plugin or
  `codex mcp add`, `opencode mcp add --global`, `grok mcp add -s user`, `~/.cursor/mcp.json`). Project
  scope writes `./.mcp.json` once, which Claude Code and Grok read, plus `./.codex/config.toml` for Codex
  and the project `opencode.json` or `opencode.jsonc` for OpenCode. Cursor has no project target. Each
  harness prints one result line: `added`, `updated`, `already current`, `covered by .mcp.json`,
  `skipped: CLI not found` or `failed: <reason>`.
- OpenCode `opencode.jsonc` files are read with comments and trailing commas ignored, and registered
  with `opencode mcp add chromex --global`, which keeps your comments.
- Native-host files list the bundled extension and, once its ID is set, the store extension.
- `packages/extension/scripts/package.ts` builds the store zip `chromex-<version>-chromium.zip` (no manifest
  `key`) and `SHA256SUMS.txt`; `release.yml` attaches both to the GitHub release. A store listing may come later.
- `CHROMEX_TMP` names the folder for test fixtures; the default is the system temp folder.

- MIT license, security policy, and changelog.
- Stable-version and release-tag checks in `pnpm versions`.
- Public package `@tasarren/chromex` (from `packages/plugin`) with a `chromex` command:
  `chromex setup [--no-open]` (later releases add more options, above), `--help`, `--version`. Installing the package does not
  configure any application until `chromex setup` runs.
- `THIRD_PARTY_NOTICES.md` generated from the bundled packages and shipped with `LICENSE` in the
  assembled plugin; `packages/plugin/test/e2e/packed.test.ts` installs a packed tarball and starts its server.
- Staged `Dockerfile` pipeline (`docker build --target artifact` for the tarball, `docker compose run
  verify` for the e2e and browser tests); pinned Gitleaks history/tree scan
  (`.github/scripts/scan-secrets.sh`); GitHub CI with
  an aggregate required `check` over `verify` and `privacy`.
- Chromex logo and extension icons (16, 32, 48, 128 px); install-first README with update and
  manual removal steps; `CONTRIBUTING.md`.
- `shared-browser-live.test.ts` accepts `CHROMEX_MCP_SERVER` to test an installed runtime.
- Release workflow (`release.yml`) with read-only guards (`packages/plugin/scripts/verify-release.mjs`) that stages
  the Docker-verified tarball on npm and attaches it to a stable GitHub Release; see
  `docs/release.md`. CI runs one required Node 24 Docker job.
- Development-only MCP Inspector `2.11.0` with an `inspect` script and documented CLI checks for
  initialize, the tool list, and `chrome_help` against the built stdio server.
- Mouse tools: `chrome_mouse_down`, `chrome_mouse_move`, `chrome_mouse_up` and
  `chrome_mouse_cancel`. `chrome_click` accepts a viewport `{x, y}`, `button`
  (`left` or `right`) and `count` (1 or 2). The mouse tools take only a target and `button`; no `contextId`, `sequence` or
  `gestureId`. Every Managed pointer result, and `chrome_status` `pointer`, is one state line such as
  `cursor 512,300 held left viewport 1440x901 scroll 0,320`. Cancel, a 120-second idle expiry and loss of the MCP client release a held button and
  free the tab. A cancel or expiry over an accepting HTML drop target can complete the drop; no-drop
  cancellation is not proved.
- `chrome_screenshot` returns one text line after the image: `png 1440x901 css 1440x901 scale 1 scroll 0,320 cursor 512,300 held none`. `png` is the image
  size, `css` the viewport, `scale` their ratio; send `x = px / scale`, `y = py / scale` to click an image pixel.
  The line ends with `mapping none` (and has no `scale`) when the aspect ratios differ by more than one pixel. With
  `path` it adds `path <file> bytes <n>`, replacing the old `{path, bytes, width, height}` text. New `clean` option
  hides the agent cursor for the capture only.
- `chrome_scroll` accepts a viewport `{x, y}`: the cursor travels there and one wheel is sent at that point. A point
  outside the viewport is refused. With no target it wheels at the cursor; it is refused while a button is held. The
  fixed wheel point (10, 10) is gone.
- A popup-granted Observe tab takes agent input whether or not it is the selected tab; the grant is the consent.
  The `Observe cannot send input to the selected tab without taking desktop focus` refusal no longer exists.
  Observe still never opens or selects tabs, and an ungranted tab is refused (`Observe access disabled`).
- Observe pointer parity: on a popup-granted Observe tab, `chrome_click` (left or right, count 1 or 2, ref or
  `{x, y}`), `chrome_hover`, `chrome_scroll`, the four mouse tools, the agent cursor and the state and
  screenshot lines work as in Managed. Revoking the grant or closing the tab while a button is held releases it.
  An ungranted tab is refused and Observe never starts a Managed browser. Through the real harness MCP on the
  owner's Chromium it passed at 390, 1440 and 1920 px (clicks, hover, scroll at a point, drag, cancel, screenshot
  line; revoke during a hold released the button). The old `Mouse gestures need a Managed browser…` refusal is gone, and so is the
  Observe-only center wheel in `chrome_scroll`.
- Managed agent cursor: every Managed pointer action (`chrome_click`, `chrome_hover` and the mouse
  tools) draws an `aria-hidden` cursor, blue when idle and red with a ring when held. It shows in
  screenshots, not in `chrome_snapshot` or `chrome_text`, and works on `chrome://` pages.
- Development pointer test page (`pnpm dev:pointer`, `pnpm test:pointer`).
- Codex registration falls back to `codex mcp add chromex -- <node> <runtime>` when the root help
  has no `plugin` command. A repeated setup is idempotent; a failed plugin read does not fall back;
  and only a default exact-owned legacy `chrome-browser-bridge` entry is removed after the new entry
  validates. A customized legacy entry is kept and reported for manual removal.
- Global named Managed profiles: `--profile <name>` or `CHROMEX_PROFILE`, one browser per profile,
  and `joinedExisting` in `chrome_status` and `chrome_open` results when an agent joins a running
  profile.
- Runtime unpacked extensions: `chrome_extension_install`, `chrome_extension_list` and
  `chrome_extension_remove`, plus `--extension <dir>` (repeatable) and `CHROMEX_EXTENSIONS`
  (`:`-separated) to preload directories into the default profile. The list persists per profile in
  `Chromex/extensions.json`.
- Managed agents may open any address, including `file://` and `chrome://` pages. Chromium refuses
  extension debugger access to internal pages, so the shared service drives them over the browser's
  CDP pipe.

### Changed

- One product name, Chromex (Chromium Executor), and one set of identifiers. Upgrading from an earlier
  build moves these; setup removes the old ones it wrote and keeps anything else with a warning:

  | Item | Before | Now |
  | --- | --- | --- |
  | Install folder | `~/plugins/chrome-browser-bridge` | `~/plugins/chromex` |
  | Config folder | `~/.config/chrome-browser-bridge` | `~/.config/chromex` |
  | Config path variable | `CHROME_BROWSER_BRIDGE_CONFIG` | `CHROMEX_CONFIG` |
  | Native host | `io.codex.chrome_bridge` | `io.tasarren.chromex` |
  | Codex plugin | `chrome-browser-bridge` | `chromex` |
  | Skill | `chrome-browser`, linked by setup | `chromex`, installed with `npx skills add` |

  The new config folder starts empty: setup creates a new token, and the old folder is left in place.
- Every tool description follows one style: a single imperative sentence, `Managed` and `Observe`
  capitalized, and parameter names that match the schema. Tools with two ways to pick a target answer
  `Provide exactly one of <a> or <b>.` when neither or both are given. `chrome_extension_list` is marked
  read-only. The tool count is stated only by `chrome_help`.
- Every manifest carries version `0.1.3`; the packages `@chromex/*` stay private.
- Setup replaces an existing `chromex` entry in every client and scope, because it may be an older
  install, and reports `added`, `updated` or `already current`. Other entries and comments stay.
- Test fixtures no longer use a folder inside the repository.
- Development guidance names the four workspace packages, the Inspector probes, ESLint/jscpd
  scope, and `chromex setup`; browser docs state the click and profile behavior.
- Managed Chromium launches with `--remote-debugging-pipe --enable-unsafe-extension-debugging` and `--no-startup-window`. Only the shared service holds the pipe, which also serves `chrome://` tabs and the `Extensions` domain. No debugging port opens. The first `chrome_open` creates an unfocused window from the extension, so launching does not take desktop focus.
- Browser input no longer activates the Chromium window (measured on Chromium 156, Openbox/X11). A selected Managed target is made inactive behind a reserved blank tab for the operation, with focus emulation enabled only around the commands; the previous selection is restored, and held mouse buttons and keys are released on failure. Pipe input is reserved by the lease holder and run by the shared service, which fences the extension queue until it ends. A service lost during admission aborts it; one lost while input runs leaves the operation orphaned with the target hidden and the queue fenced until a browser restart. The admission marker survives an extension worker restart, a CDP timeout never counts as completion, and `chrome_status` reports `orphanedInput` (or `recoveryError` when session storage cannot be read) instead of waiting. Observe refuses input to the selected tab instead of switching the user's tabs. Managed wheel input on an unselected tab selects that tab once before the blank tab, so it scrolls.
- Profiles are global: `chromex/profiles/<profile>` with lock `chromex/locks/<profile>.lock`, and the
  browser ID is the profile name. The `project` option, project roots lookup and runtime registry
  descriptors are gone. Old `chromex/profiles/<projectKey>/` directories are not migrated; delete
  them by hand.
- A client that joins a running profile gets its own leased tab in the window another client uses,
  instead of a second Chromium window. `chrome_status` and `chrome_tabs` never select or create a tab.
- Process-output redaction removes URL user names and passwords only. URL paths stay visible.
- `--extension` and `CHROMEX_EXTENSIONS` entries install through the profile's shared service on its
  first use, so a browser that is already running loads them without a restart. An already loaded
  directory is not reloaded for a joining agent, a transient service failure is retried on the next
  browser operation, and concurrent installs from several clients are serialized by the service and
  no longer lose entries.
- Package and plugin metadata name the license, repository, and authors.
- Plugin description reflects Managed Chromium as the default mode.
- The MCP server key and `serverInfo.name` are now `chromex` (was `chrome-browser-bridge`). Setup
  adds `chromex`, then removes an old entry that launches the same install (Claude Code, Codex).
  OpenCode has no remove command: the OpenCode step reports `updated; warning: remove
  mcp.servers["chrome-browser-bridge"] from <path> by hand`, setup still exits 0, and you delete the old
  entry yourself.
  Approve `chromex` tools again where approvals were saved per server.
- Codex registration uses `codex plugin marketplace add` and `codex plugin add` with a dedicated
  `chromex` marketplace. Python and the `plugin-creator` helpers are no longer required.
- Setup inspects Claude Code and OpenCode configuration files instead of running health checks,
  and refuses to replace a `chromex` entry that does not launch Chromex.
- Builds emit no source maps.
- Node 24.11 or newer is required (was 22). The MCP runtime and `chromex` CLI build with tsdown
  and the extension with Vite; root `pnpm build` runs each package build in dependency order.
  Runtime dependencies are bundled from an explicit allowlist. The CLI ships as `dist/cli.mjs`,
  and the assembled plugin no longer contains a nested `package.json`.
- Bundled MCP SDK 1.32.1 and Zod 4.6.7. Extension and native host share one private wire-contract
  package; the bridge config is validated by one loader.
- Extension, popup, and Codex plugin display name is now "Chromex". Extension ID, key,
  permissions, and native-host name are unchanged.
- Copyright, package author, and plugin author are now Tasarren. The package ships one license
  copy, assembled from the repository root.
- The `chromex` CLI is now TypeScript with validated client JSON. `chromex setup [--no-open]`,
  `--help`, and `--version` behave as before.
- Lint uses ESLint with type-aware strict rules and runtime import boundaries; `pnpm verify` also
  fails on any copied block (jscpd, 4 lines / 70 tokens). Biome is removed. ESLint formats JS and
  TS only.

### Fixed

- A screenshot whose PNG and CSS viewport differ by one pixel now reads `scale 1` instead of
  `mapping none`. Managed launches force device scale factor 1, so desktop display scaling no longer
  changes the viewport size. Test-run headless Chromium opens a 1920x1080 window, so wheel input at
  the right edge of a 1440 or 1920 px viewport reaches the page.
- A Managed server started with a Git worktree as its working directory (as OpenCode starts one per
  project) uses that worktree as its workspace without `--workspace`. A working directory outside Git,
  your home directory and `/` are still refused.
- The agent cursor is removed when a tab is released on `chrome://` pages, as it already was on web
  pages.
- `chrome_navigate` returns a `chrome://` tab to a web URL on the same tab instead of failing with
  `Debugger is not attached to tab`.
- An admitted shutdown of a Managed browser now succeeds once the agent that used it has disconnected,
  and the browser and service exit. It is still refused while another client is connected.
- `chrome_click` no longer calls `Page.bringToFront`, which raised Chromium and stole desktop focus;
  input reaches an inactive tab without it.
- Concurrent extension activity events are no longer lost; they are written one at a time.
- After the native host reconnects, a reply to a request from the old connection is dropped instead
  of being sent on the new one.
- The popup shows the Observe grant the extension confirmed. A refused toggle or release shows its
  error and re-enables the controls.
- A broker connection that closes during authentication fails at once instead of waiting for the
  timeout. Native-host, Managed-service and origin-policy data are validated before use; a bad
  client frame closes only that client.

### Removed

- The exact-origin gate: `chrome_allow_origin`, `chrome_revoke_origin`, `origin-policy.ts`,
  `CHROME_BROWSER_BRIDGE_POLICY`, and tab title/URL redaction. Pages run with the profile's
  logged-in sessions, so use `temporary: true` or a dedicated profile for untrusted work.
- Unused personal OpenCode configuration from `packages/plugin`.
- Unreferenced manual verification helpers in `scripts/verification`. Retained live workflows use
  the opt-in tests in `packages/mcp/test`.
