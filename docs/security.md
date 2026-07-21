# Security Model

## Trust Boundaries

- Chromium launches only the registered native host for the fixed extension origin.
- The native host accepts only that origin and creates an owner-only Unix socket.
- MCP clients authenticate with a random token stored in a `0600` configuration file.
- The extension leases each controlled tab to one authenticated client.
- Codex receives high-level tools rather than arbitrary CDP access.

## Origin Policy

`about:blank`, `localhost`, `127.0.0.1`, and `[::1]` are implicitly allowed. Other pages require an exact normalized HTTP(S) origin. Paths do not widen a grant, and non-web schemes remain denied.

Unapproved tabs expose neither title nor full URL. The tab listing may show the origin so the user can decide whether to grant it. Persistent grants are stored separately from session grants and should be used only when requested.

Navigation verifies both the requested URL and the final URL after redirects. A redirect to a new origin does not inherit the source grant.

## Agent Approval Policy

Status, tab listing, snapshots, screenshots, and waits are annotated as read operations. Origin changes, tab claims, opening, navigation, clicks, typing, key presses, and release are annotated as mutations so Codex can request appropriate approval.

Agents must still obtain explicit authorization for consequential actions such as submitting forms, sending messages, purchases, or entering secrets.
