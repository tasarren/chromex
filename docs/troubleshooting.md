# Troubleshooting

## Extension Shows Disconnected

1. Confirm the unpacked path is `chromex/packages/extension/dist`.
2. Open the extension card and inspect service-worker errors.
3. Confirm the native-host manifest exists at `~/.config/chromium/NativeMessagingHosts/io.codex.chrome_bridge.json`.
4. Run `pnpm install:local` again if its executable path is stale.

## `chrome_status` Cannot Connect

- Confirm `/run/user/$UID/bridge.sock` exists while Chromium is running.
- Check that the bridge config and socket have mode `0600`.
- Reload the extension to restart the native host.
- Start a new Codex thread after plugin reinstall.

## Debugger Attach Fails

Chromium permits only one debugger owner per tab. Close DevTools or another automation connection for that tab, release it, and retry.

## Tab Is Redacted

This is expected for an unapproved origin. Ask the user, call `chrome_allow_origin` with the exact origin, then list or select the tab again. Browser-internal and file URLs cannot be approved.

## Plugin Update Is Not Visible

Run `pnpm verify`, `pnpm install:local`, the plugin-creator cachebuster helper, and `codex plugin add chrome-browser-bridge@personal` in that order. Then start a new thread.

## Extension ID Mismatch

Do not delete or replace the `key` in `packages/extension/static/manifest.json`. The generated ID must remain `enbcklgjkjddndpkedgfhoeagcbogfdb` or Chromium will reject the native-host allowlist.
