# One tool call

`chrome_click` is the example: it is a two-step gesture (press, release), so it shows every hop. Other
page tools take the same path with one broker request instead of two (`cdp.command`, or
`input.run` for typing and keys).

The diagrams start after the MCP server has joined a browser. The first call in a session also runs
the start-up in [Processes](processes.md#who-starts-what).

## Which route a tab takes

```mermaid
flowchart TD
  A["Controller selects a tab<br/>cdp.attach"] --> B{"Extension can attach<br/>chrome.debugger?"}
  B -->|"yes: web page"| W["Worker route<br/>the extension sends CDP"]
  B -->|"no: chrome:// page"| P["Pipe route<br/>the Managed service sends CDP"]
  N["chrome_open to chrome:// or data:"] -->|"detach, then bind pipe target"| P
  P -->|"navigate to a web URL"| W
```

The pipe route exists only in Managed mode, because only the service holds Chromium's pipe. In
Observe there is no service, and `chrome://` pages are not reachable.

## Managed, web page (worker route)

```mermaid
sequenceDiagram
  participant T as chrome_click
  participant K as BrowserController
  participant B as Native host
  participant X as Extension worker
  participant A as GestureAuthority
  participant P as Page via chrome.debugger
  T->>K: pointerClick(target, count)
  Note over K,P: press, then release, each is one pointerStep
  K->>B: gesture.status {tabId}
  B->>X: forwarded with clientId and role
  X-->>K: context, next sequence, held button
  K->>B: gesture.reserve {kind down, contextId, sequence, target}
  B->>X: forwarded, host overwrites clientId and role
  X->>A: reserve: check lease, document, sequence
  A->>A: store intent in chrome.storage.session
  A-->>X: step token, executor is this worker
  X->>A: admit(token)
  X->>P: Input.dispatchMouseEvent along an eased path
  X->>A: complete(token, dispatched, point)
  A->>A: store outcome
  X-->>K: receipt, point, warning
  K->>B: gesture.status, then gesture.reserve {kind up}
  X->>P: mouseReleased
  X-->>K: receipt outcome released
  K->>B: cdp.command, measure the cursor element
  B->>X: forwarded
  K-->>T: pointer state line
```

- The host adds `clientId` and `clientRole` to every forwarded request and removes any the caller
  sent. Only methods in its allow-list pass.
- The authority stores a step before it runs. If the worker restarts, it finds the record, marks the
  gesture ended and sends no release.
- A document change between the check and the event turns the step into an uncertain one. The
  authority then holds the button and asks the executor to release it.

## Managed, `chrome://` page (pipe route)

```mermaid
sequenceDiagram
  participant K as BrowserController
  participant B as Native host
  participant X as Extension worker
  participant V as Managed service
  participant C as Chromium via CDP pipe
  K->>V: POST /gesture bind {tabId, targetId}
  V->>C: attach session, Page.enable, read document
  V->>B: gesture.bind {document, sessionId, tabId, targetId}
  B->>X: forwarded, service role only
  X->>X: record the binding, executor is the service
  K->>B: gesture.reserve {kind down}
  B->>X: forwarded
  X-->>K: receipt outcome pending, token
  K->>V: POST /gesture run {token}
  V->>B: gesture.admit {token}
  B->>X: forwarded
  X-->>V: step arguments
  V->>B: gesture.edge begin
  X->>X: select a blank helper tab so the page stays unfocused
  V->>C: Input.dispatchMouseEvent on the bound session
  V->>B: gesture.edge end
  V->>B: gesture.complete {dispatched, point}
  X-->>V: receipt
  V-->>K: step answer
```

- The service executes only the step the extension reserved. It never chooses a tab or a target.
- It counts document replacement and detach events for each bound session and reports them with
  `gesture.invalidate`. The extension then ends the binding.
- Plain commands on this route (snapshot reads, typing) use `input.reserve` and then
  `POST /cdp` or `POST /input` with the returned token. The service runs the one reserved command
  inside a fence, and the extension keeps the tab hidden from other clients until it ends.

## Observe, granted tab

```mermaid
sequenceDiagram
  participant U as You
  participant O as Extension popup
  participant K as BrowserController
  participant B as Native host
  participant X as Extension worker
  participant P as Page via chrome.debugger
  U->>O: Allow agents on this tab
  O->>X: popup.observe
  X->>X: add tab to the granted set, save it
  K->>B: tabs.claim {tabId}
  B->>X: forwarded
  X->>X: refuse unless granted, then take the lease
  K->>B: cdp.attach
  X->>P: chrome.debugger.attach
  K->>B: gesture.status, gesture.reserve
  B->>X: forwarded
  X->>X: store the step, then admit it as the worker executor
  X->>P: Input.dispatchMouseEvent
  X-->>K: receipt, same handshake as the worker route above
  U->>O: switch the grant off
  O->>X: popup.observe false
  X->>X: release a held button, detach, drop the lease
```

- Every request on an ungranted tab fails with `Observe access disabled`.
- Observe cannot create windows or tabs, close tabs, or use the pipe route.
- Turning the grant off ends the lease at once. A held button is released through the executor that
  pressed it before the debugger detaches.

## Source

- `packages/mcp/src/server/tools.ts` (`chrome_click`, `pointer()`)
- `packages/mcp/src/server/browser-controller.ts` (`pointerClick`, `pointerStep`, `attach`, `cdp`, `input`)
- `packages/mcp/src/server/shared-browser.ts` (`callService`, `bind`, `gesture`, `cdp`, `input`)
- `packages/mcp/src/service/managed-service.ts` (`/gesture`, `/cdp`, `/input`, `bindGesture`, `watchPipe`)
- `packages/mcp/src/service/pipe-input.ts` (`ServiceGestureExecutor`)
- `packages/mcp/src/native-host/host.ts` (`FORWARDED_METHODS`, `fromClient`)
- `packages/extension/src/browser-bridge.ts` (`route`, `gesture`, `runWorkerStep`, `setObserve`)
- `packages/extension/src/gesture-authority.ts`
- `packages/protocol/src/pointer.ts` (`runPointerStep`, `executeStep`)
