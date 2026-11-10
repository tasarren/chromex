# Architecture

Chromex has four workspace packages. Managed Chromium is owned by a detached local service per workspace profile. Agents in one workspace share that profile's browser; each tab has one controlling client, and other clients can inspect it read-only.

The diagrams are in the technical section, one page each:

| Question | Page |
| --- | --- |
| Which process starts which, and over what channel? Managed against Observe. | [Processes](tech/processes.md) |
| What happens between a tool call and the page? | [One tool call](tech/requests.md) |
| How does a held mouse button end? | [Held gestures](tech/gestures.md) |
| What does `chromex setup` write? | [Setup](tech/setup.md) |
| How do the npm package and the store zip get built and published? | [Build and release](tech/release.md) |

## Package Ownership

| Package (the three `@chromex/*` names are private workspace packages) | Owns | Build output |
| --- | --- | --- |
| `@chromex/protocol` | Private, browser-safe wire constants, JSON-RPC envelope types and parsers, shared tab data; bundled into both consumers | none (source export) |
| `@chromex/extension` | MV3 service worker (`ExtensionBridge` owns leases, Observe grants and recovery; `NativeConnection` owns the native port and reconnect), typed popup contract, popup, static manifest | `packages/extension/dist` |
| `@chromex/mcp` | MCP server and `BrowserController`, `BrokerClient`, `NativeHost` (`host.ts`), `SharedBrowser`, `CdpPipe`, `ExtensionList`, broker frame schemas, profile-lock, bridge config loader | `packages/mcp/dist` |
| `@tasarren/chromex` (`packages/plugin`) | Public package: the assembled runtime folder (Codex plugin metadata, skill, MCP server, native host, bundled extension), `Installation` (`chromex setup`: runtime copy, browsers, native host, store page, skill) and `ClientRegistrar` | `packages/plugin/dist/chromex` |

## Runtime Lifecycle

1. The agent starts the MCP server over stdio. Managed is the default and launches lazily on first browser operation. Chromium starts with no window; the first `chrome_open` creates an unfocused one, so launching does not take desktop focus.
2. On the first Managed request the server resolves its workspace from `--workspace` or a matching Claude Code `CLAUDE_PROJECT_DIR`, and keeps it for its lifetime; without a trusted source Managed is refused. Inside Git the workspace is the containing worktree root. Clients discover or start one service per workspace profile (`--profile` / `CHROMEX_PROFILE`, else `default`; browser ID = profile name), and look up browser IDs only in that workspace. Every client in the workspace shares that browser and gets its own bridge client; a client that joins a running browser gets `joinedExisting: true`. Each tab has one controlling client. Another client reads it with `chrome_use_tab({tabId, inspect: true})` and gets no control. `temporary: true` starts a separate browser with a random ID whose data is deleted when it closes. A startup lock prevents duplicate services: it is the owner file `<descriptor>.lock.owner`. A release that fails is reported even when the service started, and the same MCP process retries it best-effort when joining and strictly before its next start of that descriptor. A profile lock is the owner file `locks/<profile>.lock.owner`, published with `link` so an existing path is never replaced, and it is removed only under the guard `<lock>.owner.takeover`. Anything at either path that is not a readable owner file is refused and never removed: `The profile lock <path> has no readable owner; Chromex never removes it automatically. Use another profile name and report this state`. A guard left by a dead or unreadable holder is refused the same way: `A profile lock removal did not finish (<path>); Chromex never removes it automatically. Use another profile name and report this state`. A live holder answers `This managed profile is active; retry shortly`. A removal that cannot unlink its own guard keeps it; the same process adopts that guard on its next removal, and after the process exits the guard stays and fails closed. The failure names both the lock and the guard only when the lock read or unlink failed too; a guard unlink that fails alone throws that one failure. Earlier uncommitted builds used a directory at `locks/<profile>.lock` and at `<descriptor>.lock` and delete entries there. This build refuses while such a directory exists (`An earlier Chromex build holds <path>; Chromex never removes it automatically. Stop that build or use another profile name`), but the check is one way: an earlier build can take its lock after the check, so stop earlier builds before sharing a root. Released installs before workspace binding keep their data under the global `chromex/profiles`, `chromex/locks` and `chromex/services`, which this layout does not read. A service whose pid is alive but whose socket does not answer answers `Managed browser service is alive but unavailable; retry shortly` and is not replaced. A descriptor that was valid and then vanishes while waiting for the start lock answers `Managed browser descriptor <id> disappeared while waiting to start it; retry`.
3. The detached service owns Chromium, its private bridge, the browser CDP pipe, profile lock, and diagnostics independently of agent lifetimes. On the first browser operation for the workspace's default profile, the MCP server asks the service to install its `--extension` / `CHROMEX_EXTENSIONS` directories (validated first, invalid entries reported), so an already running browser receives them. The service serializes that install with runtime installs and writes the profile's extension list; launch loads Chromex plus every listed directory.
4. `observe: true` explicitly connects to the user's normal browser; only tabs enabled in the extension popup are visible or claimable.
5. Each bridge verifies the fixed extension origin, binds an owner-only Unix socket, and authenticates the MCP client with a user-only token.
6. Selecting the primary tab creates a client-owned lease before attaching `chrome.debugger`.
7. Release relinquishes the tab lease in either mode and leaves the tab open. Any client in the workspace can then claim that tab by `browserId` and `tabId` and takes a fresh snapshot. While another client still controls it, `inspect: true` reads it without taking the lease.
8. MCP client shutdown releases that client's leases, leaving Chromium and tabs open. The internal service route `/shutdown` (no public tool) closes the Managed browser itself: it is admitted only when no agent holds a lease, an inspection or in-flight work, and a named profile keeps its data. A definite refusal reopens the service; a lost admission answer keeps it closed until a repeated `/shutdown`. A browser that is still running after the forced stop is terminal: the service keeps the profile lock and answers only `/status` and `/output`. Closing Chromium ends the runtime after a 60-second diagnostic grace period; a browser operation during or after that period can restart the same profile. Recovery clears client selection and refs.

Explicit `chrome_close_tab` closes only the client's selected created tab. The extension leaves an
unleased blank tab when closing the last tab, keeping the shared Managed process alive.

The setup command stores an allowlisted graphical-session environment beside the installed MCP
runtime. Managed launch merges that snapshot beneath the environment supplied by the current MCP
harness, so Codex, Claude Code, OpenCode, and other stdio clients use the same launch behavior even
when they filter `DISPLAY` or related variables.

Managed Chromium stdout and stderr are drained into a bounded in-memory diagnostic buffer. Early
launch failures include a concise safe tail, while `chrome_process_output` provides cursor-paged
access to retained output without writing logs to disk or mixing browser output into MCP JSON-RPC.

Neither extension listens on a network port. The MCP server never exposes raw CDP as a tool.

Only the service holds the browser CDP pipe. It uses the pipe for the `Extensions` domain
(runtime unpacked install, reload, remove) and for `chrome://` tabs, where Chromium refuses
`chrome.debugger`. Leases, ownership and refs stay with the extension and controller. Observe has no
pipe and cannot drive `chrome://` pages. The two routes are drawn in
[One tool call](tech/requests.md#which-route-a-tab-takes).

Input (click, type, key, hover, wheel) never fronts the window. The extension first selects a
reserved idle tab in the same window if the target is active, so Chromium does not activate the
window when the input arrives (measured on Chromium 156, Openbox/X11). A wheel target that is not
selected is selected once first, because a never-selected tab did not scroll. It enables
`Emulation.setFocusEmulationEnabled` for the target, sends the commands as one batched request, then
disables emulation and restores the previous selection. For a pipe target the lease holder reserves
the operation (`input.reserve`); the extension admits it with a single-use token and names the
target (`input.begin`), and the Managed service runs the commands over its pipe and ends it
(`input.end`). A begun operation fences the extension request queue until it ends, so a release or
another client cannot overtake admitted input. If the executor is lost during admission, the begin
aborts and the fence clears. If it is lost while input runs, the operation becomes orphaned: the
target stays hidden and the queue stays fenced, because the driver pipe may still execute commands.
The admission is recorded in session storage before the acknowledgement, so a restarted extension
worker restores the orphan instead of forgetting it. `bridge.status` and `client.status` report
`orphanedInput` and stay readable while other mutating requests are held; only a browser restart
recovers, because a worker reload does not stop the service's independent CDP pipe. A restored
controller or an uncertain debugger release likewise refuses effects until a browser restart: a
reconnect or same-ID controller refresh is not proof that earlier commands never ran. A CDP timeout is
not completion: the service ends an admission only after every command succeeds, and otherwise
marks it uncertain so status reports the orphan. An unreadable session store at startup reports
`recoveryError` and holds mutations, because a stored admission may exist. A native
host disconnect treats running input the same way, since no completion can arrive. `sendInput` in `@chromex/protocol` releases every sent mouse or key press on failure, and
`withCleanup` reports cleanup failures with the original error. Observe sends input to a granted
tab as it is and never changes the user's selection.

## Popup

The toolbar popup shows which clients are connected, the window and tab each one controls, and a
feed of recent bridge activity: client connects, window and tab lifecycle, debugger attach and
detach, and top-level navigations.

In the user's normal browser, **Allow agents on this tab** grants or revokes Observe access to the active tab. Managed browsers show their shared mode instead. Popup messages are accepted only from the extension's popup URL; no MCP tool can enable Observe. The checkbox shows the grant the service worker confirmed. A refused command leaves the controls enabled and shows its error.

The feed lives in `chrome.storage.session` rather than in the service worker, because MV3 suspends
the worker after roughly thirty seconds of inactivity and an in-memory log would not survive. Session
storage clears when the browser exits and never reaches disk. Events are written one at a time, so
concurrent events are not lost. Recording an event never blocks or fails a bridge operation.
