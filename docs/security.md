# Security Model

## Trust Boundaries

- Chromium launches only the registered native host for the fixed extension origin.
- The native host accepts only that origin and creates an owner-only Unix socket.
- MCP clients authenticate with a random token stored in a `0600` configuration file.
- The extension leases each controlled tab to one authenticated client.
- Observe grants come only from the extension popup, per tab. The extension enforces grants on listing, claiming, and every debugger operation; revocation releases the lease and detaches.
- Managed mode comes from the native host's private configuration, never the client's mode hint. The host rejects client attempts to invoke `bridge.configure` or client lifecycle methods.
- Shared service descriptors and Unix control sockets are owner-only; requests require a separate random bearer token. Browser IDs alone do not authorize another OS user.
- Codex receives high-level tools rather than arbitrary CDP access.

## Origin Policy

`about:blank`, `localhost`, `127.0.0.1`, and `[::1]` are implicitly allowed. Other pages require an exact normalized HTTP(S) origin. Paths do not widen a grant, and non-web schemes remain denied.

Unapproved tabs expose neither title nor full URL. The tab listing may show the origin so the user can decide whether to grant it. Persistent grants are stored separately from session grants and should be used only when requested.

Navigation verifies both the requested URL and the final URL after redirects. A redirect to a new origin does not inherit the source grant.

## Page Activity

Console and network buffers are readable only while their origin is allowed, and are cleared on navigation and release. Request records carry method, URL, status, type, and duration. Response bodies are never captured, so page content cannot leave through the network tool.

On Chromium's internal navigation-error page, diagnostic access checks the top frame's failed target
URL against the same policy. This does not approve the internal scheme or allow reading its DOM.

## Managed Process Output

Managed Chromium stdout and stderr are drained into a 1 MiB in-memory ring buffer. They are never
written to disk or inherited onto MCP stdout. The per-session bridge token is redacted before data
enters the buffer, so neither automatic launch errors nor `chrome_process_output` can expose it.

Before process output becomes tool-visible, HTTP(S) URLs are checked against the same exact-origin
policy as browser tools. Unapproved URLs expose only their origin. File and browser-internal URLs
are redacted. Eviction and cursor metadata describe retained output without weakening these rules.

## Managed Launch Environment

The installer saves only the allowlisted display, Xauthority, runtime-directory, and session-bus
variables required to launch Managed Chromium. The snapshot is stored beside the installed MCP
runtime with mode `0600`; arbitrary environment variables and secrets are not copied. The current
MCP process environment overrides saved values.

## Agent Approval Policy

Status and tab listing are mutations because they can start or recover Managed Chromium. Snapshots, page text, screenshots, console, network, process output, and waits are annotated as read operations; page reads can recover an exited browser but require a newly selected tab afterward. Origin changes, tab claims, opening, navigation, clicks, typing, key presses, scrolling, selection, hovering, and release are mutations.

Agents must still obtain explicit authorization for consequential actions such as submitting forms, sending messages, purchases, or entering secrets.
