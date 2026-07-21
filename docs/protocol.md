# Protocol

## Native Messaging

Chromium and the native host exchange UTF-8 JSON frames prefixed by a four-byte little-endian payload length. Extension-to-host frames may be large enough for screenshots; host-to-extension requests are capped at Chromium's native-messaging limit.

The extension sends a `bridge.hello` JSON-RPC notification containing its ID, name, version, and protocol version. The native host rejects any caller origin other than the fixed extension origin.

## Broker Socket

The native host binds the configured Unix socket with mode `0600`. A client must send this first frame:

```json
{ "kind": "hello", "clientId": "uuid", "token": "user-only token" }
```

Subsequent broker frames use `request`, `response`, and `notification` kinds. The native host replaces broker IDs with host-side JSON-RPC IDs and injects the authenticated `clientId` into every extension request.

## Extension Methods

- `bridge.status`
- `tabs.list`, `tabs.create`, `tabs.claim`, `tabs.release`
- `client.release`
- `cdp.attach`, `cdp.detach`, `cdp.command`

Only the internal broker can call these methods. MCP clients receive the high-level tools documented in [browser-tools.md](browser-tools.md).

## Leases

A tab is leased to one broker client ID. Attach, detach, CDP command, and release requests must match that owner. Client disconnect releases all of its tabs. Closing a tab clears its lease and emits a targeted notification.
