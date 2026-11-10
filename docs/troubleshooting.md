# Troubleshooting

## Extension Shows Disconnected

1. For an unpacked extension, confirm the path is `~/plugins/chromex/dist/extension`.
2. Open the extension card and inspect service-worker errors.
3. Confirm the native-host manifest exists at `~/.config/chromium/NativeMessagingHosts/io.tasarren.chromex.json` (use the folder of your browser from [Browsers](installation.md#browsers)) and that its `allowed_origins` lists your extension's origin. A browser started with a custom `--user-data-dir` reads it from `<user-data-dir>/NativeMessagingHosts/` instead; copy the file there.
4. Run `npx @tasarren/chromex setup` again (`pnpm install:local` from source) if its executable path is stale or the browser was not picked.

## `chrome_status` Cannot Connect

Managed is default. For explicit Observe (`observe: true`):

- Confirm `/run/user/$UID/bridge.sock` exists while Chromium is running.
- Check that the bridge config and socket have mode `0600`.
- Reload the extension to restart the native host.
- Start a new agent session after reinstalling.
- Enable **Allow agents on this tab** in the popup. Empty tab lists are expected until a tab is enabled.

For Managed mode:

- Confirm the assembled plugin contains `dist/extension/manifest.json`, `dist/mcp-server.mjs`, `dist/managed-service.mjs`, and `dist/native-host.mjs`.
- If `chrome_open` reports that no graphical display is available, rerun `npx @tasarren/chromex setup`
  (`pnpm install:local` from source) from the graphical Linux session. Confirm `dist/managed-environment.json` contains `DISPLAY` or
  `WAYLAND_DISPLAY`; do not place unrelated variables or secrets in that file.
- Set `CHROMEX_BROWSER` to Chromium or Chrome for Testing when it is not on `PATH`; Chrome-branded builds reject command-line unpacked extensions.
- Remove ownership flags such as `--user-data-dir`, `--load-extension`, or `--remote-debugging-*` from `chromium-flags.conf`.
- A running profile is joined automatically (`joinedExisting: true`). If a tab is controlled by another client, have that agent release it, then claim its `browserId` and `tabId`.

## Managed Chromium Exits During Launch

`chrome_open` includes the Chromium exit code or signal and a bounded process-output tail when the
dedicated browser exits before its packaged extension connects. Call `chrome_process_output` without
a cursor for the newest retained stdout/stderr page. Pass its `olderCursor` back as `cursor` to page
toward earlier output.

The output metadata shows the exact executable and arguments used by Chromex. The buffer is capped
at 1 MiB; `truncatedBefore: true` means older data was evicted. Bridge tokens are always redacted,
and no process logs are persisted to disk.

## Tools Fail After Release or Browser Closure

`chrome_release` frees the lease and leaves the tab open. Resume with `chrome_use_tab` or `chrome_open`. Browser operations automatically recover exited Managed Chromium; selection and refs reset, so select a fresh tab afterward. `chrome_process_output` reads exit diagnostics without restarting Chromium, for up to 60 seconds. Persistent profile data survives; temporary profiles restart empty. Agent disconnect does not close the shared browser.

Managed checks bridge readiness before returning a controller, waiting for the native host to
reconnect without closing live tabs. If `ENOENT` persists for a private
`chromex/sessions/.../bridge.sock`, call `chrome_status` with the existing browser ID once and collect
`chrome_process_output`. Install the current build and restart that client's MCP connection if needed.
Opening the user's normal Chromium does not restore a private Managed socket.

## Navigation Fails on a Local URL

`net::ERR_CONNECTION_REFUSED` means the web server is not listening on the target address/port.
Keep the server process alive, verify its address, then retry `chrome_open` on the same browser.
Other `net::ERR_*` errors report Chromium's navigation failure directly. `chrome_network` and
`chrome_console` stay readable on the error page. Page-reading tools report the failure instead of
reading the internal error page.

## Debugger Attach Fails

Chromium permits only one debugger owner per tab. Close DevTools or another automation connection for that tab, release it, and retry.

`Cannot access a chrome:// URL` under Observe is Chromium's limit; Observe cannot drive `chrome://`
pages. Use Managed, which drives them through its CDP pipe.

## Mouse Tools Refuse or Leave a Button Held

- `Observe access disabled` for a tab: it has no popup grant. Ask the user to enable **Allow agents on this tab**.
- `Unknown element ref`: the page changed since the snapshot. Nothing was sent. Take a new `chrome_snapshot`.
- `The held gesture ended` or `held none` in the state line during a drag: the document changed or the hold
  expired, and the button was released. Start the drag again.
- `POINTER_BUSY` or `already` held: another client holds the mouse in this browser, or you hold one. Call
  `chrome_mouse_up` or `chrome_mouse_cancel`, or wait for the other client.
- `The agent cursor cannot be shown`: the page refused the indicator. Nothing was sent. Retry on another page
  and report the page if it repeats.
- A forgotten held button: call `chrome_mouse_cancel`. Without a call, Chromex releases it after 120
  seconds without admitted owning movement, or at once when the MCP client disconnects. `chrome_status`
  polling does not extend the 120 seconds.
- A cancel or expiry over an accepting HTML drop target can complete the drop. Chromex does not prove
  no-drop cancellation.
- `Managed browser is in use (another client); release it first`: an admitted shutdown is refused while
  another MCP client is connected to the browser. Once the agent that used the browser has disconnected, an
  admitted shutdown closes it and the service exits.
- `No trusted workspace for a Managed profile`: start the server inside a Git worktree, or pass
  `--workspace <absolute-directory>`. A server whose working directory is not in a Git worktree, is your
  home directory or is `/` is still refused.
- `Debugger is not attached to tab` after `chrome_navigate` from a `chrome://` page: Chromex versions before
  this fix could not leave an internal page on the same tab. Update; `chrome_navigate` now returns to a web
  URL.

## Unpacked Extension Does Not Load

- `chrome_extension_install` needs an absolute directory that contains `manifest.json` and has no
  comma in its path.
- A `chromex: skipped extension <path>` line on the MCP server's stderr names a bad `--extension`
  or `CHROMEX_EXTENSIONS` entry; the server starts without it.
- `chrome_extension_list` shows the loaded extensions and the profile's launch list. Listed
  directories that no longer have `manifest.json` are skipped at launch.

## Old Per-Project Profiles

Profiles now live in `chromex/workspaces/<key>/profiles/<profile>`. Earlier releases used
`chromex/profiles/<projectKey>/<profile>` and later `chromex/profiles/<profile>`. Chromex does not
read, migrate or delete those old directories. Delete them by hand when their cookies
and storage are no longer needed.

## Plugin Update Is Not Visible

A shared Managed service keeps its old runtime, and a browser call within 60 seconds of the browser
closing restarts Chromium inside it. Stop every agent session that uses Chromex Managed browsers,
close the Chromium windows Chromex started (not unrelated Chromium), and wait more than 60 seconds.
Then run `pnpm verify` and `pnpm install:local`, and start new agent sessions. Setup refreshes the
Codex plugin when the CLI supports plugin commands; otherwise it updates the native
`codex mcp add chromex -- <node> <runtime>` entry.

## Agent MCP Registration Fails

Check each installed client independently:

```bash
codex mcp list
claude mcp get chromex
opencode mcp list
grok mcp list
```

`claude mcp get` and `opencode mcp list` start the server to check health; setup never runs them.

Each client you registered should resolve the installed runtime under
`~/plugins/chromex/dist/mcp-server.mjs`. Rerun `npx @tasarren/chromex setup --no-open` after
upgrading or reinstalling a client CLI. Setup skips a missing CLI but exits nonzero when a
detected client cannot be configured. Setup replaces an existing `chromex` entry in the scope you chose,
so an update needs no manual edit. A project-scope entry (`./.mcp.json`, `./opencode.json[c]`,
`./.codex/config.toml`) only applies inside that project; check which `--scope` you used. An
`opencode.json` or `opencode.jsonc` that cannot be parsed fails only OpenCode and names the file: fix
it and rerun setup. Setup reads `opencode.jsonc` with comments and trailing commas ignored, and
`opencode mcp add` keeps your comments. OpenCode cannot remove the legacy `chrome-browser-bridge`
entry from earlier builds; delete that key from your OpenCode config as reported. Codex loads a
project `.codex/config.toml` only for a trusted project.

## Extension ID Mismatch

Do not delete or replace the `key` in `packages/extension/static/manifest.json`. It fixes the bundled extension's ID at `enbcklgjkjddndpkedgfhoeagcbogfdb`, and Managed mode needs that ID in the native-host allowlist. The Chrome Web Store zip is built without `key` and gets the store's own ID; setup lists both origins in `allowed_origins`. If Observe stays disconnected with the store extension, check that the native-host file lists the store extension's origin, then rerun setup.
