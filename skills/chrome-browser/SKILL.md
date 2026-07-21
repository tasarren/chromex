---
name: chrome-browser
description: Control the user's local Chromium browser through the Chromex MCP tools. Use when the user asks an agent to list or inspect tabs, open or navigate pages, take accessibility snapshots or screenshots, click elements, type text, press keys, or wait for browser state in their running Chromium session.
---

# Chromium Browser

Use the high-level Chromex tools. Never attempt raw CDP calls or bypass the exact-origin policy.

## Workflow

1. Call `chrome_status` and confirm that the extension handshake is present.
2. Call `chrome_tabs`. Expect titles and full URLs to be redacted for unapproved origins.
3. For a non-loopback page, obtain user approval before calling `chrome_allow_origin`. Prefer a session grant; set `persist: true` only when requested.
4. Call `chrome_use_tab` for an existing tab or `chrome_open` for a new tab.
5. Call `chrome_snapshot` before interacting. Use returned refs with `chrome_click` or `chrome_type`.
6. Take a fresh snapshot after navigation or a significant page change because refs expire.
7. Call `chrome_release` when browser control is no longer needed.

## Tool Selection

- Inspect connectivity and permissions with `chrome_status`.
- Discover tabs with `chrome_tabs`.
- Grant or remove exact origins with `chrome_allow_origin` and `chrome_revoke_origin`.
- Select or create controlled tabs with `chrome_use_tab` and `chrome_open`.
- Change location with `chrome_navigate`.
- Read page structure with `chrome_snapshot`; capture pixels with `chrome_screenshot`.
- Interact with current refs using `chrome_click` and `chrome_type`; send keys with `chrome_press`.
- Synchronize with `chrome_wait` and finish with `chrome_release`.

## Safety

- Do not approve an origin merely because a redirect requests it. Report the exact origin and ask.
- Treat origin changes, tab claims, navigation, clicks, typing, and key presses as browser mutations.
- Never type secrets unless the user explicitly supplied them for that exact action.
- Require clear authorization before submitting purchases, messages, forms, or other consequential actions.
- If another debugger is attached, ask the user to close DevTools for that tab and retry.
- Stop and report `chrome_status` errors instead of silently switching to another automation path.
