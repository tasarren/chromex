# Browser Tools

Chromex exposes high-level MCP tools. Call `chrome_help` for the list and its count at runtime; it is generated from the registered tools, so it cannot drift.

## Read Tools

| Tool | Purpose |
| --- | --- |
| `chrome_help` | List every tool with its parameters and the recommended call order. |
| `chrome_snapshot` | Return an indented accessibility tree with refs on interactive elements. |
| `chrome_text` | Read the page's visible text, truncated to a character budget. |
| `chrome_measure` | Read viewport, document overflow, focus, selected CSS boxes and computed styles. |
| `chrome_console` | Read buffered console output and uncaught exceptions. |
| `chrome_network` | Read buffered request activity, failed and non-2xx by default. |
| `chrome_process_output` | Read bounded stdout/stderr diagnostics from the latest Managed Chromium launch. |
| `chrome_wait` | Wait for page load or specified body text. |

## Mutation Tools

| Tool | Purpose |
| --- | --- |
| `chrome_status` | Start/join this workspace's Managed browser by default; report browserId, workspace, mode, connectivity, selection, and `joinedExisting`. |
| `chrome_tabs` | Start/join Managed and list tabs with `controlled` lease state; Observe lists only popup-enabled tabs. |
| `chrome_use_tab` | Claim an available tab by `tabId`; a temporary browser handoff also passes `browserId`. |
| `chrome_open` | Select Managed and navigate the selected tab, or create one. Accepts `browserId` (same workspace only), `profile`, and `temporary`; reports `joinedExisting`. |
| `chrome_extension_install` | Load an unpacked extension directory into the Managed profile now and at every later launch; a listed path reloads. |
| `chrome_extension_list` | List loaded unpacked extensions and the profile's launch list. |
| `chrome_extension_remove` | Uninstall an unpacked extension by `path` or `id` and drop it from the launch list. |
| `chrome_navigate` | Navigate to any URL, or move `back`/`forward`/`reload`. |
| `chrome_viewport` | Request CSS width/height (DPR 1) and read actual dimensions; omit both to read. |
| `chrome_screenshot` | Capture the visible viewport as PNG plus one metadata line; optionally save a new file at an absolute `path`, or hide the agent cursor with `clean`. |
| `chrome_click` | Click one ref or one viewport `{x, y}` with `button` and `count`; the agent cursor travels to the point and the result is the pointer state line. The tab is not brought to the front. |
| `chrome_mouse_down` | Travel to one ref or viewport `{x, y}`, press `button` and keep it held. Refused while this client already holds a button. |
| `chrome_mouse_move` | Move along an eased path to one ref or viewport `{x, y}`. Drags while this client holds a button. |
| `chrome_mouse_up` | Release the held button at its last confirmed point. Takes no arguments. |
| `chrome_mouse_cancel` | Release a held button now and free the tab. Takes no arguments. Does nothing when no button is held. |
| `chrome_type` | Focus a ref, optionally clear it, and insert text. |
| `chrome_press` | Send a key or chord such as `Enter`, `Tab`, or `Ctrl+A`. |
| `chrome_scroll` | Scroll a ref into view, or wheel at a viewport `{x, y}` (the cursor travels there), or wheel at the cursor. Answers the pointer state line. |
| `chrome_select` | Choose a `<select>` option by value, label, or visible text. |
| `chrome_hover` | Move the pointer over a ref to reveal hover-only UI. Shows the agent cursor at the point and answers the pointer state line. |
| `chrome_release` | Detach and free the tab lease for another agent; leave the tab open. |
| `chrome_close_tab` | Close this client's created tab and release its lease; refuse claimed/user tabs. |

## Input and Desktop Focus

`chrome_click`, `chrome_hover`, `chrome_mouse_down`, `chrome_mouse_move`, `chrome_mouse_up`,
`chrome_mouse_cancel`, `chrome_type`, `chrome_press` and `chrome_scroll` send real CDP input to a tab
that is not selected, with focus emulation enabled on it, and never call `Page.bringToFront`.
When the Managed target tab is selected, Chromex briefly selects an idle `about:blank` tab in the same
window (it creates one if needed and nobody else may claim or adopt it meanwhile), sends the input,
then disables emulation and restores the previous selection unless someone selected another tab in the
meantime. The visible tab changes for that moment. Other clients' tabs are never claimed, navigated,
closed or sent input for this. `chrome://` tabs use the same selection around commands sent over the
browser pipe.

Observe never changes the user's tab selection and never opens or selects tabs. Input goes to a granted
tab as it is, whether or not the person has it selected: the popup grant is the consent.

Measured on Chromium 156 with Openbox on an X11 Xvfb display: desktop focus, window stacking and the
X pointer did not change, and click, key, type, hover and wheel took effect on active and inactive
targets. A wheel on a tab that was never selected was received while hidden and did not scroll, so
Managed wheel input on an unselected tab first selects that tab once, then the blank tab, and
keeps focus emulation on for two frames after the wheel. Observe wheel input on an unselected tab is
not measured. Other builds, window managers, Wayland and other platforms are not measured; treat this as
observed behaviour, not a guarantee. Focus emulation changes page-visible focus state while it is on;
`document.hasFocus()` may still read `true` after it is disabled.

## Mouse Gestures and the Agent Cursor

`chrome_mouse_down`, `chrome_mouse_move`, `chrome_mouse_up` and `chrome_mouse_cancel` work in Managed and
on a popup-granted Observe tab, with the same arguments and results.
`chrome_mouse_down` and `chrome_mouse_move` take one `ref` or one complete viewport `{x, y}`;
`chrome_mouse_down` also takes a `button` (`left` by default, or `right`). `chrome_mouse_up` and
`chrome_mouse_cancel` take no arguments. No tool takes a `contextId`, `sequence` or `gestureId`:
Chromex keeps at most one held gesture per client and finds it for you. Unknown fields are refused.

`chrome_mouse_down` travels to the target, presses and keeps the button held. A second
`chrome_mouse_down` from the same client is refused. `chrome_mouse_move` drags while this client
holds a button and only moves the pointer otherwise. `chrome_mouse_up` releases at the last confirmed
point. `chrome_mouse_cancel` also releases a held button at that point and frees the tab for the next
controller; it does nothing and still answers the state line when nothing is held. `chrome_click`
always ends released, and is refused while this client holds a button. Another client's hold in the
same browser makes a down answer `POINTER_BUSY`.

### Pointer State Line

Every pointer result, in Managed and Observe, is one line, in this order:

```text
cursor 512,300 held left viewport 1440x901 scroll 0,320
```

The grammar is `cursor <x>,<y>|none held left|right|none viewport <w>x<h> scroll <x>,<y>`. Coordinates are CSS pixels of the main-frame viewport, rounded to integers.
`cursor none` means no point has been drawn on this document yet. `held` names the button this client
holds, or `none`. A second line carries the executor's warning when a step was not fully confirmed.
`chrome_click`, `chrome_hover`, `chrome_scroll`, the four mouse tools and the `pointer` field of
`chrome_status` all use it. A refused step is an
error whose text ends with the current line when the page can be read, so an agent sees where the
pointer is without a screenshot. A stale ref is refused before any input: take a new `chrome_snapshot`.

An idle hold is released after 120 seconds without admitted owning movement or page inspection.
`chrome_status` polling does not renew it. An MCP client disconnect releases the button immediately. If
the original executor is gone, the reservation is cleared and the result reports that no release was
sent. A document replacement after a possible press ends the hold: the next move or up is refused once
with the reason, the line shows `held none`, and Chromex sends no blind release to the replacement
document. A cancel or expiry during an HTML drag over an accepting target can complete a drop.

Every pointer action (the mouse verbs, `chrome_click`, `chrome_hover` and `chrome_scroll`) shows an agent
cursor on the page, in Managed and on a granted Observe tab. It is drawn in an isolated world, is `aria-hidden`, and does not appear in
`chrome_snapshot` or `chrome_text`. It does appear in `chrome_screenshot` images. It marks only points
whose input Chromium confirmed. On the same document it travels along an eased path of real
mouse-move input. The first action on a new document lands directly. The idle cursor is a blue arrow;
the held state is a red arrow with a ring. It stays visible after the action until the tab is released.
If the cursor cannot be shown, a move, click or press is refused before input; a release does not wait
for the cursor. Reduced motion does not change the pointer input. The cursor works on web pages and on
`chrome://` pages such as `chrome://version`, and is removed from both when the tab is released.

### Observe

On a popup-granted Observe tab the pointer tools work as in Managed: `chrome_click` (left or right, count
1 or 2, ref or `{x, y}`), `chrome_hover`, `chrome_scroll`, the four mouse tools, the agent cursor and the
state and screenshot lines. The grant is the lease. Revoking the grant in the popup, or closing the tab,
while this client holds a button releases the button through the executor that pressed it, even when
the person has since selected that tab, and the line then reads `held none`. A tab that was not granted
is refused with the existing grant error (`Observe access disabled`), and Observe never starts a Managed browser. A granted tab takes input
whether or not it is the selected tab; Observe never opens or selects tabs. Observe does not drive
`chrome://` pages.

### Limits

- Chromex does not prove that a cancelled or expired HTML drag performs no drop. Do not hold a button
  over a drop target you cannot accept.
- Observe pointer behavior is covered by the test-owned browser in `packages/mcp/test/e2e/observe.test.ts`
  (click, right click, move, cursor, screenshot line, revoke during a hold). Through the real harness MCP
  on the owner's Chromium, Observe passed at 390, 1440 and 1920 px: clicks, hover, scroll at a point,
  drag, cancel and the screenshot line, and revoking the grant during a hold released the button. Observe
  keeps the desktop scale factor, so on a desktop with fractional scaling the 390 px screenshot line can
  still read `mapping none`; convert nothing then. Observe wheel input on a granted tab that was never selected is not measured.
- Chromex does not bind a screenshot to a pointer point. Take the screenshot after the action
  returns; the cursor shows where the last confirmed point was.
- Measured on Chromium 156 on Linux with a Managed profile at 390, 1440 and 1920 px wide (actual
  viewports 391×844, 1440×901 and 1920×1080). Other builds and platforms are not measured.

## Modes, Profiles, and Tab Reuse

Managed is default. `chrome_status`, `chrome_tabs`, and `chrome_use_tab` accept `browserId`, `profile`, `temporary`, and `observe`. `observe: true` selects the user's browser; `observe: false` or explicit Managed options select Managed. Switching releases the current lease. Observe cannot be combined with Managed options.

Observe requires the user to enable **Allow agents on this tab** in the extension popup. Only enabled tabs are listed or claimable. Revocation detaches immediately; grants expire when the tab or browser closes. Agents cannot enable Observe grants.

Managed lazily starts or joins one browser per profile. Chromium starts with no window; the first `chrome_open` creates an unfocused window, so launching a browser does not take desktop focus. The server default profile is `default`, or the `--profile` argument / `CHROMEX_PROFILE` environment variable. A `profile` tool argument overrides it for this session. Names such as `admin` or `buyer` select separate identities. The browser ID of a persistent profile is the profile name.

### Workspaces

Persistent profiles belong to one workspace: a project directory or a Git worktree. The server resolves the workspace on the first Managed request and keeps it for its lifetime. Trusted sources:

- `--workspace <absolute-directory>` on the server command line.
- Claude Code's `CLAUDE_PROJECT_DIR`, only when the server's working directory resolves to the same root.

The plain working directory is not trusted. Without a trusted source, Managed requests fail with an error that asks for `--workspace <absolute-directory>` in a project-scoped registration. After an explicit `browserId`, `profile` or `temporary` selection fails, a later call that gives no selector fails with `The last Managed browser selection failed; pass browserId, profile or temporary to choose one` instead of falling back to the default. An explicit selection or `observe: true` clears that failure. Observe and diagnostics keep working. Managed is also refused when:

- the `--workspace` path is invalid (there is no fallback);
- `--workspace` conflicts with `CLAUDE_PROJECT_DIR`;
- `--workspace` names a different Git worktree than the server's working directory, for example through a registration inherited from a parent directory;
- the workspace is the home directory or `/`.

Inside Git, a path resolves to its containing worktree root. Subdirectories share that workspace; linked worktrees are separate workspaces. A damaged nearest `.git` or a failing Git command refuses the workspace; it is never treated as a non-Git directory. Outside Git, the workspace is the exact canonical directory.

Data lives under `${XDG_DATA_HOME:-~/.local/share}/chromex/workspaces/<key>/`. `<key>` is the sanitized workspace directory name, `-`, and the first 12 hex digits of the SHA-256 of the canonical root.

| Item | Path under `workspaces/<key>/` |
| --- | --- |
| Workspace marker | `@workspace.json` (`{version: 1, root}`) |
| Profile | `profiles/<profile>` |
| Profile lock | `locks/<profile>.lock.owner` |
| Service descriptor | `services/<browserId>.json` |

The first server for a workspace writes the marker before anything else in that directory. An existing `workspaces/<key>/` without a matching marker is refused and left untouched; inspect it by hand. Two servers starting for a workspace that has never been used can refuse each other while the creator publishes its marker, and a creator that dies between creating the directory and writing the marker leaves a directory that stays refused. Both need a manual check of that directory; Chromex never retries, adopts or deletes it. A `browserId` is looked up only in the bound workspace's service directory, so another worktree's browser cannot be joined. The descriptor must name the same browser ID, and a `profile` or `temporary` value given with it must match the descriptor. `chrome_status` reports the canonical root as `managed.workspace`.

Released installs from before workspace binding keep their data in `chromex/profiles`, `chromex/locks` and `chromex/services` (global names and the older per-project layout). This layout does not read, migrate or delete it, so those profiles stay on disk unused. Earlier uncommitted workspace-candidate builds are a separate case: they lock with a directory at `locks/<profile>.lock` and at the descriptor lock, which this build refuses while it exists, and the two formats do not exclude each other.

### Sharing and Handoff

Agents in one workspace share a profile's browser. Each tab has one controlling agent. `chrome_release` frees that tab's lease and leaves the tab open; it does not close the browser.

The browser and its tabs stay open after a client disconnects. The next agent joins it (`joinedExisting: true`). `chrome_status` and `chrome_tabs` do not select or create a tab. `chrome_open` reuses the selected tab, or creates and claims an unleased blank tab.

While A controls a tab, B reads it with `chrome_use_tab({tabId, inspect: true})` (add `browserId` to join A's browser). Snapshot, text, screenshot, measure, viewport without a size, wait, console and network work. Input, navigation and other control are refused. Console and network contain only events since inspection began. Each read is re-admitted before every command and before its result, so a handoff, revoke or close stops it midway and returns nothing. A pipe read covers only `chrome:`, `chrome-untrusted:` and `chrome-extension:` pages; a parked ordinary tab refuses with `Debugger is not attached`. Inspection ends when the controller releases or the tab closes, and also when B disconnects, inspects again, or the tab is closed or its Observe grant revoked.

Handoff: A calls `chrome_release` and passes `browserId` plus the tab ID; B calls `chrome_use_tab({browserId, tabId})`, then takes a fresh snapshot.

`temporary: true` creates a separate browser with a random `browserId` whose data is deleted when it closes. A named profile is a separate persistent browser; its data stays after it closes. Both follow the same workspace rule and the same per-tab lease.

Live DOM state survives handoff; refs are client-local. Close Chromium to end the runtime; persistent cookies/storage remain, temporary profiles are deleted after cleanup.

## Server Configuration

| Argument | Environment | Effect |
| --- | --- | --- |
| `--workspace <dir>` | `CLAUDE_PROJECT_DIR` (Claude Code only, must match the working directory's root) | Absolute project or worktree directory that scopes Managed profiles. Without either, Managed is refused. |
| `--profile <name>` | `CHROMEX_PROFILE` | Default Managed profile for this server. The argument wins. |
| `--extension <dir>` (repeatable) | `CHROMEX_EXTENSIONS` (`:`-separated) | Unpacked extension directories installed into the workspace's default profile on its first use, whether or not its browser is already running. Arguments replace the variable. |

```json
{
  "mcpServers": {
    "chromex": {
      "command": "node",
      "args": [
        "./dist/mcp-server.mjs",
        "--workspace", "/home/me/src/my-project",
        "--profile", "endeavour",
        "--extension", "/home/me/src/my-extension/dist"
      ]
    }
  }
}
```

Adding a listed directory again changes nothing. An extension directory that is missing, relative,
contains a comma or has no `manifest.json` is skipped with a `chromex: skipped extension` line on
stderr; the server still starts. A transient filesystem error (for example `EACCES`) is not treated
as invalid: the server reports `extension setup failed, will retry` and retries on the next browser
operation. Configured directories are installed through the profile's shared
service, so they reach a browser that is already running, and the service is the only writer of the
list. A directory that is already loaded is not reloaded for a joining agent; if the service call
fails, the server reports it and retries on the next browser operation.

## Unpacked Extensions

Each persistent profile keeps its launch list in `chromex/workspaces/<key>/profiles/<profile>/Chromex/extensions.json`
(absolute directories). Chromium loads Chromex and every listed directory that still has a
`manifest.json` with `--load-extension` at launch.

- `chrome_extension_install({path})` loads the directory into the running browser without a restart
  and adds it to the list. Calling it again for a listed path reloads the extension after source edits.
- `chrome_extension_list({})` returns the loaded unpacked extensions (`extensions`) and the list (`listed`).
- `chrome_extension_remove({path} | {id})` uninstalls the extension and drops it from the list. Chromex itself cannot be removed.

Install and remove change the profile for every agent in it; results name the other connected
clients in `otherClients`. A `profile` argument switches this session to that profile and drops its
selected tab. An unpacked extension ID depends on its directory path: moving the directory gives a
new ID and new extension storage. Packed CRX files, Web Store and URL sources are not supported.

## Internal Pages

Managed agents may open any address, including LAN hosts, `file://` and `chrome://` pages such as
`chrome://extensions/`. Chromium refuses extension debugger access to `chrome://` pages, so Chromex
drives those tabs through the Managed browser's private CDP pipe. Snapshot, text, click, type and the
other page tools work there. `chrome_console` and `chrome_network` return no entries on these pages.
Observe has no pipe and cannot drive `chrome://` pages.

Known limit: `back` or `forward` into a `chrome://` page from an extension-attached tab
(`chrome_navigate({action: "back"})`) detaches the debugger and parks the tab, so the call fails and
the tab needs recovery. Call `chrome_open` with the internal URL instead.

Browser operations recover exited Managed Chromium automatically. Selection and refs are cleared; call `chrome_tabs` and `chrome_use_tab`, or `chrome_open`. Persistent profile data survives; live page state and old tab IDs are not guaranteed. `chrome_process_output` does not restart Chromium.

`chrome_close_tab({})` closes only the selected tab created/adopted by this client's `chrome_open`.
It rejects tabs selected with `chrome_use_tab`, including a claimed tab later reused by `chrome_open`.
Use it before releasing an owned test tab. It does not close other tabs or terminate Chromium.
Closing the last tab creates one unleased `about:blank` tab first, preserving the shared process.
Observe cannot close tabs. A lost/detached lease requires recovery before closing.

## Viewport and Layout Evidence

```js
chrome_viewport({width: 1440, height: 900})
chrome_viewport({})
chrome_snapshot({})
chrome_measure({
  refs: ["e1"],
  selectors: [":root", "#addon-panel"],
  styles: ["color", "background-color", "outline-width", "--host-accent"]
})
chrome_screenshot({path: "/absolute/evidence/desktop.png"})
chrome_viewport({width: 360, height: 740})
chrome_snapshot({})
chrome_press({key: "Tab"})
chrome_measure({styles: ["outline-style", "outline-width", "outline-color"]})
chrome_screenshot({path: "/absolute/evidence/mobile.png"})
```

Viewport dimensions are integer CSS pixels, 1–4096 each. Supply both or neither. Resizing keeps
the browser and tab identity and clears refs. This uses desktop CSS viewport emulation with DPR 1,
not mobile touch or user-agent emulation. Readback includes `tabId`, `viewport.width/height`,
`devicePixelRatio`, visual viewport dimensions/scale, and document client/scroll dimensions.
Setter results also include `requested: {width, height}` and `matchesRequested`. Native display
scaling or browser zoom can round CSS dimensions (for example, 1440×900 requested, 1440×901 actual).
Use actual readback and PNG dimensions as evidence; a successful call does not imply exact size.
If a test requires exact pixels, check `matchesRequested` before accepting it.

`chrome_measure` defaults to no element/style requests. `refs` and `selectors` each accept at most
20 entries. Refs use the latest snapshot. Each CSS selector (1–500 characters) returns its first
top-document match, or `null`; it does not enter frames or shadow roots. `styles` accepts at most
20 CSS property names (at most 100 characters), including custom properties. Values are capped at
1024 characters. Results include `document.overflowX/overflowY`, scroll position, current `focus`,
and `refs`/`elements` with tag, ID, role, aria-label, focused/focus-visible flags, viewport-relative
border rectangles and requested computed styles. Reading does not focus or scroll elements.
Use `rect.width/height` for 44px target checks. No caller JavaScript is accepted.

`chrome_screenshot` always returns an MCP PNG image and one text line:

```text
png 1440x901 css 1440x901 scale 1 scroll 0,320 cursor 512,300 held none
```

The grammar is `png <w>x<h> css <w>x<h> scale <s> scroll <x>,<y> cursor <x>,<y>|none held left|right|none`.
`png` is the image size in pixels. `css` is the page viewport (`innerWidth` by `innerHeight`), `scroll` the
page scroll offset, and `cursor` the agent cursor point, all read in the same inspection as the capture. `scale`
is `png width / css width`, rounded to three decimals; it is exactly `1` when the PNG and CSS sizes differ by at
most one pixel on both axes (rounding of a fractional viewport). Managed launches force device scale factor 1, so
desktop display scaling does not change the line. To act on a pixel `(px, py)` of the image, send
`x = px / scale` and `y = py / scale` to `chrome_click`, `chrome_mouse_move` or `chrome_scroll`. When the PNG and
CSS sizes still do not map after that rule (aspect ratios differ by more than one pixel), the line has no `scale` and ends with `mapping none`: do not
convert; measure with `chrome_measure` instead. `held` is the button this client holds; an inspector (`chrome_use_tab`
with `inspect: true`) always reads `none`.

An optional absolute `.png` `path` writes the same bytes and appends ` path <file> bytes <n>` to the line.
The parent directory must exist. The file is created with mode `0600`; existing files and symlinks are refused
rather than replaced. Omit `path` to capture without saving. Its tool annotation is a mutation because saving
writes a file.

`clean: true` (default `false`) hides only the agent cursor for this capture and shows it again afterwards, so the
image has no cursor but `cursor` in the line still reports where it is. If the cursor cannot be shown again, the
call is an error saying the cursor stays hidden; the next pointer call draws it again.

`chrome_scroll` has three targets. A `ref` scrolls that element into view and ignores `direction` and `amount`.
A complete `x` and `y` moves the cursor there along the eased path, then sends one wheel at that point; a point
outside the viewport is refused, not clamped, and giving only one of `x` and `y` or giving a `ref` with a point is
refused. With no target it wheels at the cursor, or at the viewport center before the first pointer action. It is
refused while this client holds a mouse button (`Release the held button before scrolling`); release or cancel first.
Managed and Observe answer the pointer state line.

## Orphaned Pipe Input

Input to a Managed `chrome://` tab is admitted by the extension and executed by the shared service.
If that service dies, the browser pipe may still run the dispatched commands, so Chromex does not
send input or restore the previous tab selection. The admission is recorded in session storage, so
even a restarted extension worker keeps failing closed. `chrome_status` then reports
`orphanedInput: {tabId, token}` while other browser operations wait. A restarted extension worker that
restored an uncertain debugger release also refuses every new control request, because a
reconnect does not prove that in-flight commands never ran; inspection reads stay open.
If session recovery itself fails, `chrome_status` reports `recoveryError` and holds mutations for the
same reason. Restart the Managed Chromium window to recover; reloading the extension alone does not
stop the service pipe.

The uncertain-release rule also applies to Observe. If detaching the debugger fails with an error
that is not a confirmed "not attached" reply, leases and grants stay blocked until the person
restarts their own browser. That fails closed on purpose; Chromex cannot tell what a failed detach
left attached.

## Managed Process Diagnostics

Chromex continuously drains Managed Chromium's stdout and stderr into a chronological in-memory
buffer capped at 1 MiB. Browser output is never inherited onto MCP stdout, never persisted to disk,
and is retained by the shared service across MCP sessions. The private bridge token is always redacted. URL
user names and passwords are removed; the rest of each URL stays visible.

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

Attaching to a tab enables the `Runtime`, `Log`, `Network`, and `Page` CDP domains. Console entries and request records accumulate in fixed 200-entry buffers. Bridge navigation (including reload), attachment and release clear the buffers. Reads do not consume entries.

After an action that should have changed something, call `chrome_console` to see what the page reported and `chrome_network` to see which requests failed. Response bodies are never captured.

For refused-operation/no-replay evidence, retain `chrome_network({status: "all"})` immediately
after the refusal and before `chrome_navigate({action: "reload"})`. Retain a second result after
the page is ready and at the end of a stated observation interval. Compare requests for the exact
operation URL/method: one refusal before reload, none in the post-reload window. The earlier result
is the retained history; the live buffer does not preserve bridge reload history. Record interval
start/end and keep traffic below the 200-request capacity; a full buffer cannot prove no eviction.
This demonstrates no replay only within the observed interval, not indefinitely.

## Key Chords

`chrome_press` accepts a key name or a chord: `Enter`, `Escape`, `Shift+Tab`, `Ctrl+A`, `Meta+K`. Modifiers are `Ctrl`, `Shift`, `Alt`, and `Meta` (aliases `Cmd`, `Super`, `Option`, `Control`). Use `Ctrl+A` before `chrome_type` to replace a field's contents rather than appending.

## Recommended Sequence

```text
chrome_status -> chrome_tabs

Managed: chrome_open(profile?, temporary?, browserId?) -> chrome_snapshot -> act/read -> chrome_release
Managed drag: chrome_mouse_down(ref | x,y) -> chrome_mouse_move(ref | x,y)... -> chrome_mouse_up; check `held` in each result line; chrome_mouse_cancel releases a held button
Extensions: chrome_extension_install(path) -> chrome_extension_list
Handoff (persistent): A disconnects; B chrome_use_tab(tabId) -> fresh chrome_snapshot
Handoff (temporary): A chrome_release; B chrome_use_tab(browserId, tabId) -> fresh chrome_snapshot
Observe: user enables popup grant -> chrome_tabs(observe:true) -> chrome_use_tab -> chrome_snapshot

After changes: chrome_wait -> fresh chrome_snapshot
When unexpected: chrome_console -> chrome_network
When Managed launch fails: chrome_process_output
```

Refs belong to the latest snapshot and are invalid after navigation or significant DOM changes.
