#!/bin/sh
# Report-only agent run (DEC-80, DEC-83). Writes setup.log and report.md under /app/reports.
set -eu
mkdir -p /app/reports
chromex setup --no-open --skills none > /app/reports/setup.log 2>&1 || true
# The container has no Git worktree, so register the server's workspace explicitly (ISS-01).
opencode mcp add chromex --global -- \
  "$(command -v node)" "$HOME/plugins/chromex/dist/mcp-server.mjs" \
  --workspace /app >> /app/reports/setup.log 2>&1 || true
opencode run 'Read /app/docker/agent-instructions.md and follow it.' 2>&1 | tee /app/reports/report.md
