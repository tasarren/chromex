# Security Model

## Trust Boundaries

- Chromium launches only the registered native host for the fixed extension origin.
- The native host accepts only that origin and creates an owner-only Unix socket.
- MCP clients authenticate with a random token stored in a `0600` configuration file.
- The extension leases each controlled tab to one authenticated client.
- Observe grants come only from the extension popup, per tab. The extension enforces grants on listing, claiming, and every debugger operation; revocation releases the lease, detaches, and drops every inspector and pending read of that tab.
- Managed mode comes from the native host's private configuration, never the client's mode hint. The host rejects client attempts to invoke `bridge.configure` or client lifecycle methods.
- Shared service descriptors and Unix control sockets are owner-only; requests require a separate random bearer token. Browser IDs alone do not authorize another OS user.
- Agent clients receive high-level tools rather than arbitrary CDP access.
- The bridge transport is local. Page content returned to an agent goes to that agent's client,
  which may send it to its model provider under the client's settings.

## No Origin Gate

Agents may open any address: LAN admin pages, `file://` URLs, and `chrome://` pages such as
`chrome://settings/`. Pages run with the profile's cookies and logged-in sessions. A
prompt-injected agent can therefore read or change anything those sessions can reach. Use
`temporary: true` or a dedicated profile for untrusted sites, and keep personal logins out of
shared agent profiles. Observe access still needs the per-tab popup grant.

## Browser CDP Pipe

Managed Chromium starts with `--remote-debugging-pipe --enable-unsafe-extension-debugging`. The
pipe uses file descriptors 3 and 4 of the Chromium process; no network port opens. Only the
detached `managed-service.mjs` holds the pipe. The second flag enables the `Extensions` CDP domain
(load, reload and uninstall unpacked extensions) for pipe clients only.

The service exposes the pipe through its `/cdp` and `/input` routes. Each takes only a single-use
token that the lease holder reserved with the extension (`input.reserve`, kind `cdp` or `input`); the
service begins it, and the extension supplies the target and commands. Extension install, removal
and configuration run inside a `profile` reservation. `/inspect` takes a single-use token for an internal page and runs outside that queue, so a read
does not wait behind control. The service re-admits the token before every command and before
returning; a refusal invalidates it and returns no result. A parked ordinary tab is not read over the pipe. `/shutdown` uses the same bearer token and closes the Managed browser only after the extension
admits it; a same-user holder of that token can call it. A lost admission answer leaves the service
closed to everything but `/status`, `/output` and a repeated `/shutdown`.
Anyone with the service token (the same OS user) can
still reach the pipe by other means, so these checks order cooperating clients; they are not a
security boundary against the same user.

Per-tab control covers cooperating Chromex clients only. All clients share one bridge token, so a
same-user process can impersonate another client. `bridge.status` lists client IDs, and a same-user
process can read or forge one. Keep untrusted code under another OS user.

## Unpacked Extensions

`chrome_extension_install`, `--extension` and `CHROMEX_EXTENSIONS` load any local unpacked
directory. An unpacked extension gets the access its manifest requests in its profile, which can
include every page and logged-in session. Install, reload and remove affect every agent that uses
the profile, including the shared `default` profile. An unpacked extension ID depends on its
directory path; moving the directory changes the ID and its storage. Load only code you trust.

## Page Activity

Console and network buffers are cleared on bridge navigation, attachment and release. Request records carry method, URL, status, type, and duration. Response bodies are never captured, so page content cannot leave through the network tool.

## Background Input

Chromex sends input to a tab that is not selected, with `Emulation.setFocusEmulationEnabled` on, so
Chromium does not activate the window. For a selected Managed target it briefly selects an idle
`about:blank` tab in the same window, creating one when needed. That helper is reserved: no client can
claim or adopt it until the input ends. The previous selection is restored unless a person or another
client changed it meanwhile; a created helper is removed when it is still an idle blank tab. A begun
pipe operation holds the extension request queue until it ends, so a release or another client cannot
overtake it. If the executing service disconnects mid-operation, the operation is orphaned: the
target stays hidden behind its helper and the queue stays fenced, because the input may still be in
flight. The admission marker survives an extension worker restart, `chrome_status` reports
`orphanedInput`, and recovery is a browser restart; a native-host disconnect is treated the same way.
If the session store cannot be read at startup, the bridge assumes an admission may exist, reports
`recoveryError`, and holds mutations rather than starting clean. The switch changes which
tab is visible for that moment and gives the page a focused state while emulation is on; disabling
does not promise to restore `document.hasFocus()`. Other clients' tabs are never claimed, navigated,
closed, or sent input for this.

A failed command still disables emulation, releases every mouse button and key whose press was sent
(even if its response failed), and restores selection. Cleanup sends releases only, never a second
press. A failed cleanup step is added to the reported error instead of being hidden.

Managed mouse gestures use the same path. A held button is released through the original executor on
`chrome_mouse_cancel`, after 120 seconds without admitted owning movement or page inspection, and when
the controlling MCP client is lost. The release is a release only, sent at the last confirmed point;
the reservation is then cleared and the tab is free. If the executor is gone, the reservation is
cleared and the result says no release was sent. A cancel or expiry over an accepting HTML drop target
can complete the drop; Chromex does not prove a no-drop cancel. Every pointer action draws an
`aria-hidden` cursor in an isolated world. It does not appear in snapshot or text.

Observe never changes the user's selection and never opens or selects tabs. A granted tab takes input
whether or not it is the selected tab: the popup grant is the consent. The pointer tools work on a popup-granted Observe tab only. The grant is the lease: revoking it or closing the
tab releases a button this client holds, through the executor that pressed it, even if the person has selected
that tab since. No grant, no pointer tool; Observe never starts a Managed browser. Results were measured on Chromium 156 with Openbox on X11 (Xvfb); other platforms are
not verified.

## Managed Process Output

Managed Chromium stdout and stderr are drained into a 1 MiB in-memory ring buffer. They are never
written to disk or inherited onto MCP stdout. The per-session bridge token is redacted before data
enters the buffer, so neither automatic launch errors nor `chrome_process_output` can expose it.

Before process output becomes tool-visible, user names and passwords are removed from URLs. The
rest of each URL stays visible.

## Managed Launch Environment

The setup command saves only the allowlisted display, Xauthority, runtime-directory, and session-bus
variables required to launch Managed Chromium. The snapshot is stored beside the installed MCP
runtime with mode `0600`; arbitrary environment variables and secrets are not copied. The current
MCP process environment overrides saved values.

## Agent Approval Policy

Status and tab listing are mutations because they can start or recover Managed Chromium. Snapshots, page text, layout measurement, console, network, process output, and waits are annotated as read operations; page reads can recover an exited browser but require a newly selected tab afterward. Extension install and remove (remove is destructive), tab claims, opening, navigation, viewport changes, screenshots (optional file writes), clicks, mouse gestures (`chrome_mouse_down`, `chrome_mouse_move`, `chrome_mouse_up`, `chrome_mouse_cancel`), typing, key presses, scrolling, selection, hovering, release and owned-tab close are mutations. Close is destructive and only accepts the selected tab created by this client; the extension additionally requires a valid lease and Managed mode.

Layout measurement accepts bounded refs, CSS selectors and property names, never caller JavaScript.
Screenshot paths must be absolute `.png` paths. Exclusive creation refuses overwrite, including
existing symlinks. The caller selects the artifact path; parent directories are not created.

Agents must still obtain explicit authorization for consequential actions such as submitting forms, sending messages, purchases, or entering secrets.
