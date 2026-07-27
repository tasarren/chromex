---
name: chrome-browser
description: Use chrome-browser-bridge MCP tools (chrome_status, chrome_open, chrome_snapshot and other chrome_* tools) to control Chromium, test web apps, inspect pages, hand off tabs, or diagnose navigation and connection errors. Covers shared Managed profiles and popup-enabled Observe access.
---

# Chromium Browser

Use the high-level Chromex tools. Never attempt raw CDP calls or bypass the exact-origin policy.

## Quick Start

1. Confirm the web app is running and listening on its stated port. Keep its server process alive throughout browser checks.
2. Call `chrome_status({project: "/absolute/project/path"})`; save `managed.browserId`. Omit `project` when the MCP root is unambiguous.
3. Call `chrome_open({browserId: "<returned ID>", url: "http://127.0.0.1:<port>/"})`. Loopback URLs already have permission; do not add an origin grant.
4. Call `chrome_snapshot({})`, then use returned refs. Page tools operate on this client's selected tab; they do not accept `browserId`.
5. Call `chrome_release({})` when done. This leaves the tab available for another agent.

Prefer the shared default profile. Use `temporary: true` only when isolation is needed; retain its returned `browserId` and reuse that ID for later calls or handoff. A new client specifying `temporary: true` without a browser ID starts a separate browser. Do not switch project/profile while diagnosing the current tab.

## Workflow

0. Call `chrome_help` if you are unsure which tools exist or what order to call them in.
1. Call `chrome_status` to start or join shared Managed Chromium. Pass `project`/`profile` now if needed; retain `managed.browserId` for handoff. This does not require the user's browser to be running.
2. Call `chrome_tabs`. Expect titles and full URLs to be redacted for unapproved origins.
3. For a non-loopback page, obtain user approval before calling `chrome_allow_origin`. Prefer a session grant; set `persist: true` only when requested.
4. Call `chrome_use_tab` to claim an available Managed tab, or `chrome_open` to open a URL. For the user's normal browser, first ask them to enable **Allow agents on this tab** in the extension popup, then call `chrome_tabs` with `observe: true`.
5. Call `chrome_snapshot` before interacting. Use returned refs with `chrome_click` or `chrome_type`.
6. Take a fresh snapshot after navigation or a significant page change because refs expire.
7. When an action does not produce the expected result, call `chrome_console` and `chrome_network` before retrying. A failed request or a thrown exception explains far more than a second screenshot.
8. Call `chrome_release` when browser control is no longer needed.

## Modes and Profiles

Managed is the default. `chrome_status`, `chrome_tabs`, `chrome_use_tab`, and `chrome_open` accept `browserId`, `project`, `profile`, and `temporary`. One local MCP root identifies the project; without roots, the MCP working directory is used. Multiple roots require an explicit `project`.

Observe requires a user-enabled, per-tab popup grant. Only granted tabs are listed or claimable; agents cannot enable grants. Revocation detaches immediately. Grants survive worker restarts but end when revoked, the tab closes, or the browser exits. Origin approval is still required. `observe: true` selects Observe; `observe: false` or Managed options reconnect to Managed. Switching releases the current lease.

Managed shares one running browser per project/profile across agents. Omit `profile` for `default`; use names such as `admin` or `buyer` for separate identities. `temporary: true` creates an isolated browser that can be shared using its `browserId`. Browser and tabs stay open after all MCP clients disconnect. Close the browser to end its runtime; persistent profile data remains, temporary data is deleted.

Calling `chrome_open` again navigates the selected tab. `chrome_release` detaches and fully frees its lease without closing or navigating it. For handoff, A releases and gives B `browserId` plus `tabId`; B calls `chrome_use_tab` with both and takes a fresh snapshot. Page state survives handoff, but refs and origin grants are per client. Never claim a tab marked `controlled: true` until its owner releases it.

Browser operations automatically recover an exited Managed browser using the same project/profile. Recovery clears selection and refs; list tabs and select one again, or call `chrome_open`. Persistent storage survives, but live page state and old tab IDs are not guaranteed after restart. `chrome_process_output` reads diagnostics without restarting Chromium; exited or failed process output is retained for 60 seconds while its service remains alive.

If a tool reports a Managed Chromium launch failure, call `chrome_process_output` before
retrying. Omit `cursor` for the newest bounded stdout/stderr page, then pass `olderCursor` back as
`cursor` when earlier retained output is needed. Process diagnostics redact the private bridge token
and URLs outside the exact-origin policy. If the failure says no graphical display is available,
rerun `pnpm install:local` from the user's graphical Linux session before starting a new agent thread.

## Tool Selection

- Discover the full tool list at runtime with `chrome_help`.
- Inspect connectivity and permissions with `chrome_status`.
- Discover tabs with `chrome_tabs`.
- Grant or remove exact origins with `chrome_allow_origin` and `chrome_revoke_origin`.
- Select or create controlled tabs with `chrome_use_tab` and `chrome_open`.
- Change location with `chrome_navigate`, including `action: "back" | "forward" | "reload"`.
- Read page structure with `chrome_snapshot` and prose with `chrome_text`; capture pixels with `chrome_screenshot`.
- Interact with current refs using `chrome_click`, `chrome_type`, `chrome_select`, and `chrome_hover`.
- Send keys and chords with `chrome_press`, such as `Enter` or `Ctrl+A` to replace field contents.
- Reach off-screen content with `chrome_scroll`; the snapshot header reports how much lies below.
- Diagnose page behaviour with `chrome_console` and `chrome_network`.
- Diagnose Managed browser startup with `chrome_process_output`.
- Synchronize with `chrome_wait` and finish with `chrome_release`.

## Failure Recovery

| Error or symptom | Next action |
| --- | --- |
| `Navigation failed` / `net::ERR_CONNECTION_REFUSED` | Read `chrome_network`; check the app process and port, start/fix the server, then retry `chrome_open` with the same browser ID. |
| `Only HTTP(S) origins can be allowed` after opening a loopback URL (older runtime) | Suspect Chromium's internal error page. Verify server reachability and update Chromex. Never grant `chrome-error://` or other internal schemes. |
| `Origin ... is not allowed` | Ask user approval for that exact HTTP(S) origin, then call `chrome_allow_origin`. Redirect targets need their own approval. |
| Private `bridge.sock` missing / disconnected | Call `chrome_status` with the existing browser ID once. Managed waits for bridge reconnect or recovers an exited browser. If it persists, collect `chrome_process_output` and report; do not loop or start alternate profiles. |
| `No tab selected` after recovery | List tabs using the same browser ID, select an available tab, then take a fresh snapshot. Old refs and tab IDs may be gone. |
| `controlled by another client` | Ask its owner to release. Do not steal the lease. |
| Observe shows no tabs | User must enable **Allow agents on this tab** in the extension popup. Origin grants do not enable Observe. |

`chrome_network` and `chrome_console` remain available on Chromium error pages when the failed target's origin is allowed. Snapshot/text tools report the navigation failure rather than reading the internal page. `chrome_process_output` diagnoses Chromium/bridge startup, not the web app's HTTP server.

## Safety

- Do not approve an origin merely because a redirect requests it. Report the exact origin and ask.
- Treat origin changes, tab claims, navigation, clicks, typing, and key presses as browser mutations.
- Never type secrets unless the user explicitly supplied them for that exact action.
- Require clear authorization before submitting purchases, messages, forms, or other consequential actions.
- If another debugger is attached, ask the user to close DevTools for that tab and retry.
- Stop and report `chrome_status` errors instead of silently switching to another automation path.
