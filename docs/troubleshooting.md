# Troubleshooting

## Extension Shows Disconnected

1. Confirm the unpacked path is `~/plugins/chrome-browser-bridge/dist/extension`.
2. Open the extension card and inspect service-worker errors.
3. Confirm the native-host manifest exists at `~/.config/chromium/NativeMessagingHosts/io.codex.chrome_bridge.json`.
4. Run `pnpm install:local` again if its executable path is stale.

## `chrome_status` Cannot Connect

Managed is default. For explicit Observe (`observe: true`):

- Confirm `/run/user/$UID/bridge.sock` exists while Chromium is running.
- Check that the bridge config and socket have mode `0600`.
- Reload the extension to restart the native host.
- Start a new Codex thread after plugin reinstall.
- Enable **Allow agents on this tab** in the popup. Empty tab lists are expected until a tab is enabled; origin approval alone does not enable Observe.

For Managed mode:

- Confirm the assembled plugin contains `dist/extension/manifest.json`, `dist/mcp-server.mjs`, `dist/managed-service.mjs`, and `dist/native-host.mjs`.
- If `chrome_open` reports that no graphical display is available, rerun `pnpm install:local` from
  the graphical Linux session. Confirm `dist/managed-environment.json` contains `DISPLAY` or
  `WAYLAND_DISPLAY`; do not place unrelated variables or secrets in that file.
- Set `CHROMEX_BROWSER` to Chromium or Chrome for Testing when it is not on `PATH`; Chrome-branded builds reject command-line unpacked extensions.
- Remove ownership flags such as `--user-data-dir`, `--load-extension`, or `--remote-debugging-*` from `chromium-flags.conf`.
- Active project/profiles are joined automatically. If a tab is controlled by another client, have that agent release it, then claim its `browserId` and `tabId`.

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

## Navigation Fails on an Allowed Local URL

`net::ERR_CONNECTION_REFUSED` means the web server is not listening on the target address/port.
Keep the server process alive, verify its address, then retry `chrome_open` on the same browser.
Other `net::ERR_*` errors report Chromium's navigation failure directly.

Older builds incorrectly report `Only HTTP(S) origins can be allowed` when Chromium displays
`chrome-error://chromewebdata/` after failed navigation. Loopback already has permission;
`chrome_allow_origin` cannot fix a failed server connection. Current builds report the navigation
failure and let `chrome_network`/`chrome_console` inspect diagnostics for an allowed failed target.
Internal error pages remain unavailable to page-reading tools.

## Debugger Attach Fails

Chromium permits only one debugger owner per tab. Close DevTools or another automation connection for that tab, release it, and retry.

## Tab Is Redacted

This is expected for an unapproved origin. Ask the user, call `chrome_allow_origin` with the exact origin, then list or select the tab again. Browser-internal and file URLs cannot be approved.

## Plugin Update Is Not Visible

Run `pnpm verify` and `pnpm install:local`, then start a new Codex thread. The installer performs the
plugin-creator cachebuster and `codex plugin add` steps.

## Agent MCP Registration Fails

Check each installed client independently:

```bash
codex plugin list
claude mcp get chrome-browser-bridge
opencode mcp list
```

All three should resolve the installed runtime under
`~/plugins/chrome-browser-bridge/dist/mcp-server.mjs`. Rerun `pnpm install:local -- --no-open` after
upgrading or reinstalling a client CLI. The installer skips a missing CLI but exits nonzero when a
detected client cannot be configured.

## Extension ID Mismatch

Do not delete or replace the `key` in `packages/extension/static/manifest.json`. The generated ID must remain `enbcklgjkjddndpkedgfhoeagcbogfdb` or Chromium will reject the native-host allowlist.
