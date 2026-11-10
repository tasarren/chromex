# Chromex agent report

Run these tool calls in order. This is a report, not a test: do not stop on an error.

1. `chrome_help`
2. `chrome_status`
3. `chrome_open` with `url: "data:text/html,<h1>chromex-agent</h1>"`
4. `chrome_snapshot`
5. `chrome_text`
6. `chrome_release`

For each call, print the tool name, the first line of its result, and whether it returned an error.
