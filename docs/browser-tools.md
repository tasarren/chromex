# Browser Tools

Chromex exposes 22 high-level MCP tools. Call `chrome_help` for the list at runtime; it is generated from the registered tools, so it cannot drift.

## Read Tools

| Tool | Purpose |
| --- | --- |
| `chrome_help` | List every tool with its parameters and the recommended call order. |
| `chrome_snapshot` | Return an indented accessibility tree with refs on interactive elements. |
| `chrome_text` | Read the page's visible text, truncated to a character budget. |
| `chrome_screenshot` | Capture the visible viewport as PNG. |
| `chrome_console` | Read buffered console output and uncaught exceptions. |
| `chrome_network` | Read buffered request activity, failed and non-2xx by default. |
| `chrome_process_output` | Read bounded stdout/stderr diagnostics from the latest Managed Chromium launch. |
| `chrome_wait` | Wait for page load or specified body text. |

## Mutation Tools

| Tool | Purpose |
| --- | --- |
| `chrome_status` | Start/join Managed by default; report browserId, mode, connectivity, selection, and origins. |
| `chrome_tabs` | Start/join Managed and list tabs with `controlled` lease state; Observe lists only popup-enabled tabs. |
| `chrome_allow_origin` | Grant session or persistent access to one exact HTTP(S) origin. |
| `chrome_revoke_origin` | Remove an exact origin from both allowlists. |
| `chrome_use_tab` | Claim an available allowed tab; accepts `browserId` and `tabId` for handoff. |
| `chrome_open` | Select Managed and navigate the selected tab, or create one. Accepts `browserId`, `project`, `profile`, and `temporary`. |
| `chrome_navigate` | Navigate to an approved URL, or move `back`/`forward`/`reload`. |
| `chrome_click` | Click a ref, scrolling it into view first. |
| `chrome_type` | Focus a ref, optionally clear it, and insert text. |
| `chrome_press` | Send a key or chord such as `Enter`, `Tab`, or `Ctrl+A`. |
| `chrome_scroll` | Scroll a ref into view, or scroll the page by an amount. |
| `chrome_select` | Choose a `<select>` option by value, label, or visible text. |
| `chrome_hover` | Move the pointer over a ref to reveal hover-only UI. |
| `chrome_release` | Detach and free the tab lease for another agent; leave the tab open. |

## Modes, Profiles, and Tab Reuse

Managed is default. `chrome_status`, `chrome_tabs`, and `chrome_use_tab` accept `browserId`, `project`, `profile`, `temporary`, and `observe`. `observe: true` selects the user's browser; `observe: false` or explicit Managed options select Managed. Switching releases the current lease. Observe cannot be combined with Managed options.

Observe requires the user to enable **Allow agents on this tab** in the extension popup. Only enabled tabs are listed or claimable. Revocation detaches immediately; grants expire when the tab or browser closes. Exact-origin checks still apply. Agents cannot enable Observe grants.

Managed lazily starts or joins one browser per canonical project/profile. One local MCP root selects the project; without roots, the MCP working directory is used. Multiple roots require explicit `project`. Persistent profiles default to `default`; names such as `admin` or `buyer` select separate identities. `temporary: true` creates an isolated profile shareable through its returned `browserId`.

`chrome_open` reuses the currently selected tab. Release and MCP shutdown free leases but leave browser and tabs open. To hand off, A calls `chrome_release`, passes `managed.browserId` from status plus the tab ID, and B calls `chrome_use_tab({browserId, tabId})`, then takes a fresh snapshot. Live DOM state survives; refs and origin grants are client-local. Close Chromium to end the runtime; persistent cookies/storage remain, temporary profiles are deleted after cleanup.

Browser operations recover exited Managed Chromium automatically. Selection and refs are cleared; call `chrome_tabs` and `chrome_use_tab`, or `chrome_open`. Persistent profile data survives; live page state and old tab IDs are not guaranteed. `chrome_process_output` does not restart Chromium.

## Managed Process Diagnostics

Chromex continuously drains Managed Chromium's stdout and stderr into a chronological in-memory
buffer capped at 1 MiB. Browser output is never inherited onto MCP stdout, never persisted to disk,
and is retained by the shared service across MCP sessions. The private bridge token is always redacted. HTTP(S) URLs
from unapproved origins expose only their origin; file and browser-internal URLs are redacted.

When Chromium exits before the extension connects, `chrome_open` reports its exit code or signal and
includes a concise output tail. Call `chrome_process_output` for more:

- `stream` selects `all`, `stdout`, or `stderr`.
- `maxChars` controls the page size from 500 to 100,000 characters.
- Omitting `cursor` returns the newest page.
- Passing the returned `olderCursor` pages backward through retained entries.
- `truncatedBefore` and `droppedBytes` report whether older output was evicted.

The tool also reports the executable, launch arguments, PID, process state, spawn error, exit code,
and signal. Failed/exited diagnostics remain available for 60 seconds before the service exits, or until a new launch replaces them.

## Snapshots

`chrome_snapshot` walks the accessibility tree and keeps only nodes worth acting on or navigating by. Wrapper elements are dropped and their children hoisted, so a deep `div` chain collapses to one line. Refs are assigned only to interactive nodes. The header line reports the URL, title, and how much content remains below the fold.

Pass `filter: "all"` to include decorative nodes. Use `chrome_text` when you need prose rather than structure — the two are complements.

## Reading Page Activity

Attaching to a tab enables the `Runtime`, `Log`, `Network`, and `Page` CDP domains. Console entries and request records accumulate in fixed 200-entry buffers, cleared on navigation and on release.

After an action that should have changed something, call `chrome_console` to see what the page reported and `chrome_network` to see which requests failed. Response bodies are never captured.

## Key Chords

`chrome_press` accepts a key name or a chord: `Enter`, `Escape`, `Shift+Tab`, `Ctrl+A`, `Meta+K`. Modifiers are `Ctrl`, `Shift`, `Alt`, and `Meta` (aliases `Cmd`, `Super`, `Option`, `Control`). Use `Ctrl+A` before `chrome_type` to replace a field's contents rather than appending.

## Recommended Sequence

```text
chrome_status -> chrome_tabs -> chrome_allow_origin (only when needed and approved)

Managed: chrome_open(project?, profile?, temporary?, browserId?) -> chrome_snapshot -> act/read -> chrome_release
Handoff: A chrome_release; B chrome_use_tab(browserId, tabId) -> fresh chrome_snapshot
Observe: user enables popup grant -> chrome_tabs(observe:true) -> chrome_use_tab -> chrome_snapshot

After changes: chrome_wait -> fresh chrome_snapshot
When unexpected: chrome_console -> chrome_network
When Managed launch fails: chrome_process_output
```

Refs belong to the latest snapshot and are invalid after navigation or significant DOM changes. A redirect does not automatically approve its destination origin.
