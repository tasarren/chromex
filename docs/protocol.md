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

Each shared Managed service launches Chromium with a private runtime directory, socket, random token, bridge config (`managed: true`), and native-host launcher. Its manifest lives under the active profile's `NativeMessagingHosts` directory. Chromium receives `--user-data-dir`, `--load-extension=<chromex>,<listed dirs...>`, `--no-first-run`, `--no-default-browser-check`, `--disable-background-mode`, `--remote-debugging-pipe`, `--enable-unsafe-extension-debugging`, and `--no-startup-window` through `spawn`, without a shell. The service holds the CDP pipe on file descriptors 3 and 4; no debugging port opens. Agent disconnect does not stop the service or browser.

Each workspace keeps its data under `${XDG_DATA_HOME:-~/.local/share}/chromex/workspaces/<key>/`: persistent profiles in `profiles/<profile>`, locked by the owner file `locks/<profile>.lock.owner`; the browser ID is the profile name. `<key>` is the sanitized workspace directory name, `-`, and the first 12 hex digits of the SHA-256 of the canonical workspace root. `@workspace.json` (`{version: 1, root}`) is written by the directory's creator before anything else; a directory without a matching marker is refused before any lock, profile or descriptor is written. Clients reach the same service; among processes using this lock format, on a filesystem where `link` refuses an existing path, the lock prevents a second Chromium process from using that directory. An earlier uncommitted build uses a different lock format, and the two do not exclude each other. Each profile's unpacked extension list is `<profile>/Chromex/extensions.json`. Temporary profiles live in the session runtime directory, get a random browser ID, and are deleted on service cleanup. Earlier global paths are not read.

Owner-only service descriptors live under `chromex/workspaces/<key>/services/<browserId>.json`. They include routing, browser ID, profile, workspace root, service PID, and a separate control token. A client looks up browser IDs only in its workspace's directory and, before contacting the service, refuses a record with a different workspace or browser ID, or one whose profile or temporary flag differs from a value the caller gave. The detached `managed-service.mjs` accepts bounded authenticated HTTP requests over a `0600` Unix socket; no TCP port is opened. Routes: `/status`, `/ensure` (start or recover), `/output` (process output), `/extensionInstall`, `/extensionList`, `/extensionRemove`, `/extensionConfigure` (Extensions CDP domain plus the profile list; changes run inside a `profile` fence), `/cdp` and `/input` (each takes `{token}` reserved by the lease holder and runs its commands over the pipe), `/gesture` (internal; `bind` records the service tab target, session and document, `run` executes a reserved gesture token, `cleanup` releases a held button through the same executor after cancel, idle expiry, controller loss or an uncertain step), `/inspect` (a single-use token for a read of an internal page, run outside the service queue; the service re-admits it before every CDP command and before returning the result, and a refusal invalidates the token and returns nothing), and `/shutdown` (internal; no public tool: asks the extension to admit `bridge.close`, then sends CDP `Browser.close` and waits up to 15 seconds for the service's own browser child. It answers only after the socket closes, the descriptor is published with pid 0 and the runtime directory is removed: `{browserPid, clean, cleanupError, exitCode, exited, forced, profile, signal, teardownErrors, temporary}`. `clean` is true only for the service's own child exiting with code 0, no signal, not forced, with no `cleanupError` and no `teardownErrors`; `forced` means the child had not exited within the timeout. While it runs, every route except `/status`, `/output` and a repeated `/shutdown` is refused with `Managed browser service is closing`. A definite refusal while the browser is still alive reopens the service; a lost admission answer keeps it closed, and only a repeated `/shutdown` reconciles it. A browser still running after `Browser.close` and a forced stop of the service's own child is terminal: `/shutdown` and every retry answer at once that the process is still running and the profile lock is kept, the descriptor stays live so no second browser starts, and only `/status` and `/output` answer. A temporary profile is deleted; a named profile keeps its data). There is no profile-wide claim and no `x-chromex-claim` header. An unresolved pipe input or an uncertain debugger release fences control requests; inspection stays readable. Startup is serialized by a lock. Descriptors survive service exit so browser IDs can recover the same profile. Output is kept in memory for 60 seconds after exit/failure. Page control uses a separate broker connection and lease per MCP client.

The launcher's private `XDG_CONFIG_HOME` receives an exact copy of the user's `chromium-flags.conf`, preserving their Vulkan/WebGPU/VAAPI pipeline. Flags that override user-data, extension ownership, or remote debugging are rejected.

## Extension Methods

- `bridge.configure` (native host only), `bridge.status`, `client.status`
- `client.hello`
- `window.ensure`
- `tabs.list`, `tabs.create`, `tabs.claim`, `tabs.park`, `tabs.release`, `tabs.close`,
  `tabs.target` (debugger target ID of a leased tab)
- `client.release`
- `cdp.attach`, `cdp.detach`, `cdp.command`
- `input.run` (selects another tab when needed, enables focus emulation, runs Input commands, restores)
- `cdp.ownerInspect` (fixed read by the tab's lease holder: an attached tab reads directly, while a
  pipe-driven internal page issues an inspection token. It needs the current lease and stays available
  during a held gesture. `cdp.inspect` is the separate observer route below.)
- `tabs.inspect`, `tabs.uninspect`, `cdp.inspect`, `inspect.begin`, `inspect.step`, `inspect.end`
  (read a tab another client controls; `cdp.inspect` accepts only the closed set `url`, `text`,
  `ready`, `snapshot`, `screenshot`, `measure`). A pipe read is issued only for a
  `chrome:`, `chrome-untrusted:` or `chrome-extension:` page; a parked ordinary tab refuses with
  `Debugger is not attached`. The service calls `inspect.step` before each command and `inspect.end`
  before returning, and each rechecks the inspector, the grant and the same controller. Any refusal
  deletes the token. A token also dies on uninspect, observer disconnect, a new inspect, controller
  release, claim or close, tab close and Observe revoke. One inspector holds at most 4 pending tokens.
- `gesture.status`, `gesture.reserve`, `gesture.admit`, `gesture.complete`,
  `gesture.uncertain`, `gesture.cancel`, `gesture.bind`, `gesture.edge`, `gesture.invalidate`
  (internal, no public tool: one held pointer gesture per browser, implemented in
  `packages/extension/src/gesture-authority.ts`, persisted by `gesture-storage.ts`. `gesture.status` returns the caller's gesture and,
  when the caller holds that tab's lease and the tab is readable, issues a `contextId` with the next
  sequence bound to owner, tab lease, generation and document epoch. `gesture.reserve` compares an
  exact duplicate of the retained step by public arguments after owner and live-context validation
  and before target or ref preparation; a match returns its pending or settled receipt without
  dispatch, while different arguments at the same sequence, a stale context and an out-of-order
  sequence are refused before any effect. A second distinct step answers
  `POINTER_BUSY` rather than waiting. The intent is written to the session-storage key
  `bridgeGesture` before the step can be admitted; a failed write consumes no sequence.
  `gesture.cancel` needs no context, sequence or busy admission, so it still reaches a stalled step:
  it latches cancellation promptly, and once the in-flight step settles the original executor is
  offered a `cancel` step, which must confirm it. A confirmed up stays `released`, never `cancelled`.
  Cancel, a 120-second idle expiry and controller loss release a held button through the original
  executor and free the tab. An uncertain step stops new admission and offers the same release; it
  keeps no retained uncertain reservation. A terminal up keeps its tab reserved only until its
  outcome write finishes. `gesture.bind` records a service-executed tab's target, session and document
  identity; `gesture.edge` selects and restores the helper around one press or release edge;
  `gesture.invalidate` ends a binding after replacement or detach. These methods bypass the request
  queue and the pipe fence, so status and cancellation answer during a stalled step. `gesture.admit`
  refuses a non-cleanup step at or after the stored deadline. A stored unfinished gesture becomes
  terminal with a warning and no release, not an uncertain retained hold. A malformed record is
  ignored. The native host forwards these methods only when its config is Managed. The ordinary MCP
  catalog includes the four Managed mouse verbs and an extended `chrome_click`; Observe refuses the
  new verbs. `chrome_help` lists the catalog.)
- `bridge.close` (internal, Managed only: admits a close when the service's own broker is the only
  client and nothing is leased, inspected or in flight, then `bridge.status` reports `closing`.
  Every later request is refused with `Managed browser is closing` except `bridge.close`,
  `bridge.status`, `client.status`, `client.release`, `input.end` and `input.uncertain`. A refusal
  changes nothing. Observe, an uncertain release, a recovery error and a running fence are refused)
- `input.reserve`, `input.begin`, `input.end`, `input.uncertain` (pipe transport, kind `input`,
  `cdp` or `profile`: the lease holder, or the service for `profile`, reserves a single-use token
  and operation; the service begins it, runs the commands over its pipe, and ends
  it. A begun operation fences the request queue until `input.end`, which bypasses the fence. An
  `input` or `cdp` operation ends after success, or after Chromium answered one page command with an
  error. A `profile` operation is composite: a later failure leaves it uncertain and the error names
  the steps that already happened. Paths and argument shapes are validated before the fence is
  reserved, so a refused request ends cleanly and can be retried. An
  executor lost during admission aborts that admission; one lost while input runs leaves the
  operation orphaned and the queue fenced, because commands may still be executing. An admission
  marker is persisted in session storage, so a restarted extension worker restores the orphan.
  `bridge.status` and `client.status` stay readable and report `orphanedInput` while other mutating
  requests stay held; only a browser restart clears it, because reloading the worker does not stop
  the service's independent CDP pipe. A token ended before its begin is cancelled, which recovers an
  uncertain begin reply. When a command fails or times out, the service marks it with
  `input.uncertain` instead of ending it, so status reports the orphan the fence holds.)

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

`window.ensure` returns the calling client's window. Managed callers request bootstrap adoption first: the extension claims the dedicated process's existing unleased `about:blank` tab/window rather than creating a second blank window. Managed Chromium starts with no window at all; when none exists, `window.ensure` creates an unfocused window so the launch does not take desktop focus.

Window preference is identified by broker client ID. `client.release` clears that preference but leaves the window open. Observe cannot call `window.ensure` or create tabs; its selected tab remains in its original window.

`chrome_release` uses `tabs.release` in both modes. Internal `tabs.park` retains a detached lease.
`chrome_close_tab` uses `tabs.close` only for this client's selected created tab. The extension
requires a lease and Managed mode, and creates an unleased blank tab before closing the last tab
to keep Chromium alive. Viewport and bounded measurement use existing `cdp.command`; no wire
method or protocol version changed.
