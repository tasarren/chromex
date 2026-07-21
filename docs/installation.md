# Installation and Updates

## Build and Install

From `chromex`:

```bash
pnpm install
pnpm verify
pnpm install:local
```

The installer performs four local actions:

1. Copies the assembled plugin to `~/plugins/chrome-browser-bridge`.
2. Creates or preserves the token in `~/.config/chrome-browser-bridge/config.json` with mode `0600`.
3. Registers `io.codex.chrome_bridge` under Chromium's `NativeMessagingHosts` directory.
4. Points the native-host manifest at the installed plugin runtime.

## Load the Extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `chromex/packages/extension/dist`.

The fixed manifest key produces extension ID `enbcklgjkjddndpkedgfhoeagcbogfdb`, matching the native-host allowlist.

## Refresh the Codex Plugin

For an existing personal installation, use the plugin-creator update workflow:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py" \
  ~/plugins/chrome-browser-bridge
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/read_marketplace_name.py"
codex plugin add chrome-browser-bridge@personal
```

Do not edit `~/.agents/plugins/marketplace.json` or Codex configuration by hand. Start a new Codex thread after reinstalling so new skills and MCP tools are loaded.
