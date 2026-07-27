# Protocol

## Native Messaging

Chromium and the native host exchange UTF-8 JSON frames prefixed by a four-byte little-endian payload length. Extension-to-host frames may be large enough for screenshots; host-to-extension requests are capped at Chromium's native-messaging limit.

The extension sends a `bridge.hello` JSON-RPC notification containing its ID, name, version, and protocol version. The native host rejects any caller origin other than the fixed extension origin.

## Broker Socket

The native host binds the configured Unix socket with mode `0600`. A client must send this first frame:

```json
{ "kind": "hello", "clientId": "uuid", "label": "chromex (pid 4821)", "mode": "managed", "token": "user-only token" }
```

`label` and `mode` are optional. The MCP server derives the label from its working directory and process ID, or from `CHROMEX_LABEL` when set. The native host ignores the client's mode hint and derives `managed` or `observe` from its private config. It sends `bridge.configure` after the extension handshake and `client.hello` after authentication. Broker callers cannot invoke these configuration/lifecycle methods.

Subsequent broker frames use `request`, `response`, and `notification` kinds. The native host replaces broker IDs with host-side JSON-RPC IDs and injects the authenticated `clientId` into every extension request.

## Managed Session Bridge

Each shared Managed service launches Chromium with a private runtime directory, socket, random token, bridge config (`managed: true`), and native-host launcher. Its manifest lives under the active profile's `NativeMessagingHosts` directory. Chromium receives `--user-data-dir`, `--load-extension`, `--disable-extensions-except`, and `--disable-background-mode` through `spawn`, without a shell or remote-debugging transport. Agent disconnect does not stop the service or browser.

Persistent profiles live under `${XDG_DATA_HOME:-~/.local/share}/chromex/profiles/<project-key>/<profile>`. Clients join the same service; a profile lock prevents a second Chromium process from using that directory. Temporary profiles live in the session runtime directory and are deleted on service cleanup.

Owner-only service descriptors live under `${XDG_DATA_HOME:-~/.local/share}/chromex/services/<browserId>.json`. They include routing, project/profile, service PID, and a separate control token. The detached `managed-service.mjs` accepts bounded authenticated HTTP requests over a `0600` Unix socket for status, ensure/recovery, and process output; no TCP port is opened. Startup is serialized by a lock. Descriptors survive service exit so browser IDs can recover the same profile. Output is kept in memory for 60 seconds after exit/failure. Page control uses a separate broker connection and lease per MCP client.

The launcher's private `XDG_CONFIG_HOME` receives an exact copy of the user's `chromium-flags.conf`, preserving their Vulkan/WebGPU/VAAPI pipeline. Flags that override user-data, extension ownership, or remote debugging are rejected. Runtime registry descriptors contain safe routing metadata and config/socket paths, but never the bridge token.

## Extension Methods

- `bridge.configure` (native host only), `bridge.status`, `client.status`
- `client.hello`
- `window.ensure`
- `tabs.list`, `tabs.create`, `tabs.claim`, `tabs.park`, `tabs.release`, `tabs.close`
- `client.release`
- `cdp.attach`, `cdp.detach`, `cdp.command`

Only the internal broker can call these methods. MCP clients receive the high-level tools documented in [browser-tools.md](browser-tools.md).

## Recovery

Protocol version 3 adds native-host-enforced mode, popup-only Observe grants, and shared lifetime. Clients, window preferences, leases, attachments, Managed mode, and Observe tab grants survive worker suspension in `chrome.storage.session`. The extension reconciles against current tabs/windows before RPCs. Browser restart clears tab grants. A worker restart preserves leases; broker-client disconnect releases them.

`bridge.status` and `client.status` include a reconciliation generation. The MCP client rejects an extension using a different protocol version and closes that broker connection.

## CDP Domains and Events

Attaching to a tab enables the `Runtime`, `Log`, `Network`, and `Page` domains. A domain that refuses to enable is skipped rather than failing the attach.

The extension forwards each `chrome.debugger` event to the leasing client as a `cdp.event` notification carrying `tabId`, `method`, and `params`. The MCP server buffers console and network events for the selected tab and discards the rest.

## Leases

A tab is leased to one broker client ID. RPCs and popup grant changes are serialized to prevent concurrent claim races. Attach, detach, CDP command, and release requests require that owner and, in Observe, an active popup grant. Revocation detaches and notifies the owner. Disconnect releases leases without closing tabs/windows.

## Windows

`window.ensure` returns the calling client's window. Managed callers request bootstrap adoption first: the extension claims the dedicated process's existing unleased `about:blank` tab/window rather than creating a second blank window. If no bootstrap exists, it creates an unfocused window.

Window preference is identified by broker client ID. `client.release` clears that preference but leaves the window open. Observe cannot call `window.ensure` or create tabs; its selected tab remains in its original window.

`chrome_release` uses `tabs.release` in both modes. Internal `tabs.park` retains a detached lease; `tabs.close` remains available internally for explicit teardown.
