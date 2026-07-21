# Browser Tools

Chromex exposes 14 high-level MCP tools.

## Read Tools

| Tool | Purpose |
| --- | --- |
| `chrome_status` | Report extension connectivity, selected tab, socket, and allowed origins. |
| `chrome_tabs` | List tabs while redacting disallowed titles and full URLs. |
| `chrome_snapshot` | Return an accessibility tree with temporary element refs. |
| `chrome_screenshot` | Capture the visible viewport as PNG. |
| `chrome_wait` | Wait for page load or specified body text. |

## Mutation Tools

| Tool | Purpose |
| --- | --- |
| `chrome_allow_origin` | Grant session or persistent access to one exact HTTP(S) origin. |
| `chrome_revoke_origin` | Remove an exact origin from both allowlists. |
| `chrome_use_tab` | Claim and attach to an existing approved tab. |
| `chrome_open` | Create, attach, and navigate a new tab. |
| `chrome_navigate` | Navigate the controlled tab to an approved URL. |
| `chrome_click` | Click a ref from the latest accessibility snapshot. |
| `chrome_type` | Focus a ref, optionally clear it, and insert text. |
| `chrome_press` | Send a keyboard key such as `Enter`, `Tab`, or `Escape`. |
| `chrome_release` | Detach and release the controlled tab without closing it. |

## Recommended Sequence

```text
chrome_status
  -> chrome_tabs
  -> chrome_allow_origin (only when needed and approved)
  -> chrome_use_tab or chrome_open
  -> chrome_snapshot
  -> chrome_click / chrome_type / chrome_press
  -> chrome_wait and a fresh chrome_snapshot
  -> chrome_release
```

Refs belong to the latest snapshot and are invalid after navigation or significant DOM changes. A redirect does not automatically approve its destination origin.
