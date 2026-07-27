import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { installChromex } from "../scripts/install.mjs";

const extensionKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArALgXbDD1D94Pd+21zaF+xYPWt7AHII7dtkmvItuI5KyNzHRi7Sh+a1yjrWWiBklxdCRpJOh1prl+LP9BWMoPYBIcccRT86ADLxnNpVPSrHukhCba7dp2mBPJ4/HPkAiApouM0HffIal/pbR8abVAFmxtyvHCzDXSQSWf3jAUjoTjr7UQWxZfmJiZabkSzUqZw+hN1itU/DV0O6nd4GMC/M3JmFAEusRuzmAUoeSpcUpVTzoGgA4DZ7CFQ1Gpzbz94mGzWZKRkur2OK5Ro8mj32PYOKb9ZorOUEqCP5mWdlA9AhuNOCEj/B6y+tcLs9ayiY+cxYh5EfA1AY/ZYRtGQIDAQAB";

async function writeJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createArtifact(root, marker = "first") {
  const artifact = resolve(root, "artifact");
  await writeJson(resolve(artifact, ".codex-plugin/plugin.json"), {
    name: "chrome-browser-bridge",
    version: "0.1.0",
  });
  await writeJson(resolve(artifact, ".mcp.json"), { mcpServers: {} });
  await writeJson(resolve(artifact, "dist/extension/manifest.json"), {
    key: extensionKey,
    manifest_version: 3,
  });
  await mkdir(resolve(artifact, "dist"), { recursive: true });
  await writeFile(resolve(artifact, "dist/mcp-server.mjs"), `// ${marker}\n`);
  await writeFile(resolve(artifact, "dist/managed-service.mjs"), `// ${marker}\n`);
  await writeFile(resolve(artifact, "dist/native-host.mjs"), "#!/usr/bin/env node\n");
  await mkdir(resolve(artifact, "skills/chrome-browser"), { recursive: true });
  await writeFile(resolve(artifact, "skills/chrome-browser/SKILL.md"), `# Browser ${marker}\n`);
  return artifact;
}

async function createPluginCreator(root) {
  const pluginCreatorRoot = resolve(root, "plugin-creator");
  for (const script of [
    "create_basic_plugin.py",
    "read_marketplace_name.py",
    "update_plugin_cachebuster.py",
  ]) {
    const path = resolve(pluginCreatorRoot, "scripts", script);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, "# test fixture\n");
  }
  return pluginCreatorRoot;
}

function createLogger() {
  const messages = { error: [], log: [], warn: [] };
  return {
    logger: {
      error: (message) => messages.error.push(message),
      log: (message) => messages.log.push(message),
      warn: (message) => messages.warn.push(message),
    },
    messages,
  };
}

test("installs the bridge atomically and preserves the token on reinstall", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chromex-install-test-"));
  const homeDirectory = resolve(root, "home");
  const runtimeDirectory = resolve(root, "runtime");
  const configHome = resolve(root, "config");
  const installRoot = resolve(homeDirectory, "plugins/chrome-browser-bridge");
  const environment = {
    PATH: "",
    XDG_CONFIG_HOME: configHome,
    XDG_RUNTIME_DIR: runtimeDirectory,
  };
  const { logger } = createLogger();
  let artifactRoot = await createArtifact(root, "first");

  const first = await installChromex({
    artifactRoot,
    environment,
    findCommand: async () => null,
    homeDirectory,
    installRoot,
    interactive: false,
    logger,
  });
  const firstConfig = JSON.parse(await readFile(first.bridge.configPath, "utf8"));
  assert.match(firstConfig.token, /^[a-f0-9]{64}$/);
  assert.equal((await stat(first.bridge.configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(resolve(installRoot, "dist/native-host.mjs"))).mode & 0o777, 0o700);
  assert.equal((await stat(first.managedEnvironmentPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(first.managedEnvironmentPath, "utf8")), {
    XDG_RUNTIME_DIR: runtimeDirectory,
  });
  assert.equal(await readFile(resolve(installRoot, "dist/mcp-server.mjs"), "utf8"), "// first\n");

  artifactRoot = await createArtifact(root, "second");
  await installChromex({
    artifactRoot,
    environment,
    findCommand: async () => null,
    homeDirectory,
    installRoot,
    interactive: false,
    logger,
  });
  const secondConfig = JSON.parse(await readFile(first.bridge.configPath, "utf8"));
  assert.equal(secondConfig.token, firstConfig.token);
  assert.equal(await readFile(resolve(installRoot, "dist/mcp-server.mjs"), "utf8"), "// second\n");
  const skillPath = resolve(homeDirectory, ".agents/skills/chrome-browser");
  assert.equal(await readlink(skillPath), resolve(installRoot, "skills/chrome-browser"));
  assert.equal(await readFile(resolve(skillPath, "SKILL.md"), "utf8"), "# Browser second\n");
  assert.equal(first.nativeHostPaths.length, 1);
  const hostManifest = JSON.parse(await readFile(first.nativeHostPaths[0], "utf8"));
  assert.equal(hostManifest.name, "io.codex.chrome_bridge");
  assert.deepEqual(hostManifest.allowed_origins, [
    "chrome-extension://enbcklgjkjddndpkedgfhoeagcbogfdb/",
  ]);
  assert.equal(hostManifest.path, resolve(installRoot, "dist/native-host.mjs"));
});

test("captures only the graphical environment and refreshes it on reinstall", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chromex-managed-environment-test-"));
  const artifactRoot = await createArtifact(root);
  const homeDirectory = resolve(root, "home");
  const installRoot = resolve(homeDirectory, "plugins/chrome-browser-bridge");
  const { logger } = createLogger();
  const skillPath = resolve(homeDirectory, ".agents/skills/chrome-browser");
  await mkdir(skillPath, { recursive: true });
  await writeFile(resolve(skillPath, "SKILL.md"), "user skill");
  const baseEnvironment = {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    DISPLAY: ":1",
    PATH: "",
    SECRET_TOKEN: "must-not-persist",
    WAYLAND_DISPLAY: "wayland-1",
    XAUTHORITY: "/tmp/xauthority",
    XDG_CONFIG_HOME: resolve(root, "config"),
    XDG_RUNTIME_DIR: resolve(root, "runtime"),
  };

  const first = await installChromex({
    artifactRoot,
    environment: baseEnvironment,
    findCommand: async () => null,
    homeDirectory,
    installRoot,
    interactive: false,
    logger,
  });
  assert.deepEqual(JSON.parse(await readFile(first.managedEnvironmentPath, "utf8")), {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    DISPLAY: ":1",
    WAYLAND_DISPLAY: "wayland-1",
    XAUTHORITY: "/tmp/xauthority",
    XDG_RUNTIME_DIR: resolve(root, "runtime"),
  });
  assert.equal((await stat(first.managedEnvironmentPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(resolve(skillPath, "SKILL.md"), "utf8"), "user skill");

  const second = await installChromex({
    artifactRoot,
    environment: { ...baseEnvironment, DISPLAY: ":2", WAYLAND_DISPLAY: "" },
    findCommand: async () => null,
    homeDirectory,
    installRoot,
    interactive: false,
    logger,
  });
  assert.deepEqual(JSON.parse(await readFile(second.managedEnvironmentPath, "utf8")), {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    DISPLAY: ":2",
    XAUTHORITY: "/tmp/xauthority",
    XDG_RUNTIME_DIR: resolve(root, "runtime"),
  });
});

test("configures Codex, Claude Code, and OpenCode with global installed paths", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chromex-clients-test-"));
  const homeDirectory = resolve(root, "home");
  const installRoot = resolve(homeDirectory, "plugins/chrome-browser-bridge");
  const artifactRoot = await createArtifact(root);
  const pluginCreatorRoot = await createPluginCreator(root);
  await writeJson(resolve(homeDirectory, ".agents/plugins/marketplace.json"), {
    name: "personal",
    plugins: [{ name: "chrome-browser-bridge" }],
  });
  const commands = new Map([
    ["chromium", "/usr/bin/chromium"],
    ["claude", "/tools/claude"],
    ["codex", "/tools/codex"],
    ["opencode", "/tools/opencode"],
    ["python3", "/usr/bin/python3"],
  ]);
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ args, command });
    if (args.at(-1)?.endsWith("read_marketplace_name.py"))
      return { stderr: "", stdout: "personal\n" };
    if (command === "/tools/opencode" && args.includes("--help")) {
      return { stderr: "", stdout: "Options: --global\n" };
    }
    return { stderr: "", stdout: "" };
  };
  const { logger } = createLogger();

  const result = await installChromex({
    artifactRoot,
    environment: {
      DISPLAY: ":1",
      PATH: "/tools:/usr/bin",
      XDG_CONFIG_HOME: resolve(root, "config"),
      XDG_RUNTIME_DIR: resolve(root, "runtime"),
    },
    findCommand: async (command) => commands.get(command) ?? null,
    homeDirectory,
    installRoot,
    interactive: false,
    logger,
    nodePath: "/usr/bin/node",
    pluginCreatorRoot,
    runCommand,
  });

  assert.deepEqual(
    result.clientResults.map(({ client, status }) => ({ client, status })),
    [
      { client: "Codex", status: "configured" },
      { client: "Claude Code", status: "configured" },
      { client: "OpenCode", status: "configured" },
    ],
  );
  assert.ok(
    calls.some(
      ({ args, command }) =>
        command === "/tools/codex" &&
        args.join(" ") === "plugin add chrome-browser-bridge@personal --json",
    ),
  );
  assert.ok(
    calls.some(
      ({ args, command }) =>
        command === "/tools/claude" &&
        args.slice(0, 5).join(" ") === "mcp add-json --scope user chrome-browser-bridge",
    ),
  );
  assert.ok(
    calls.some(
      ({ args, command }) =>
        command === "/tools/opencode" &&
        args.join(" ") ===
          `mcp add chrome-browser-bridge --global -- /usr/bin/node ${resolve(installRoot, "dist/mcp-server.mjs")}`,
    ),
  );
  assert.equal(result.nativeHostPaths.length, 1);
  assert.match(result.nativeHostPaths[0], /chromium\/NativeMessagingHosts/);
});

test("creates a missing Codex marketplace entry and restores the packaged manifest", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chromex-marketplace-test-"));
  const homeDirectory = resolve(root, "home");
  const installRoot = resolve(homeDirectory, "plugins/chrome-browser-bridge");
  const artifactRoot = await createArtifact(root);
  const pluginCreatorRoot = await createPluginCreator(root);
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ args, command });
    if (args[0].endsWith("create_basic_plugin.py")) {
      await writeJson(resolve(installRoot, ".codex-plugin/plugin.json"), {
        name: "overwritten-scaffold",
      });
    }
    if (args[0].endsWith("read_marketplace_name.py")) return { stderr: "", stdout: "personal\n" };
    return { stderr: "", stdout: "" };
  };
  const { logger } = createLogger();

  await installChromex({
    artifactRoot,
    environment: {
      PATH: "/tools:/usr/bin",
      XDG_CONFIG_HOME: resolve(root, "config"),
      XDG_RUNTIME_DIR: resolve(root, "runtime"),
    },
    findCommand: async (command) => {
      if (command === "codex") return "/tools/codex";
      if (command === "python3") return "/usr/bin/python3";
      return null;
    },
    homeDirectory,
    installRoot,
    interactive: false,
    logger,
    pluginCreatorRoot,
    runCommand,
  });

  assert.ok(calls.some(({ args }) => args[0].endsWith("create_basic_plugin.py")));
  const installedManifest = JSON.parse(
    await readFile(resolve(installRoot, ".codex-plugin/plugin.json"), "utf8"),
  );
  assert.equal(installedManifest.name, "chrome-browser-bridge");
});

test("attempts remaining clients after a registration failure", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chromex-client-failure-test-"));
  const artifactRoot = await createArtifact(root);
  const homeDirectory = resolve(root, "home");
  const installRoot = resolve(homeDirectory, "plugins/chrome-browser-bridge");
  const calls = [];
  const { logger, messages } = createLogger();

  const result = await installChromex({
    artifactRoot,
    environment: {
      PATH: "/tools",
      XDG_CONFIG_HOME: resolve(root, "config"),
      XDG_RUNTIME_DIR: resolve(root, "runtime"),
    },
    findCommand: async (command) => {
      if (command === "claude") return "/tools/claude";
      if (command === "opencode") return "/tools/opencode";
      return null;
    },
    homeDirectory,
    installRoot,
    interactive: false,
    logger,
    runCommand: async (command, args) => {
      calls.push({ args, command });
      if (command === "/tools/claude" && args.includes("add-json")) throw new Error("denied");
      return { stderr: "", stdout: "" };
    },
  });

  assert.deepEqual(
    result.clientResults.map(({ client, status }) => ({ client, status })),
    [
      { client: "Codex", status: "skipped" },
      { client: "Claude Code", status: "failed" },
      { client: "OpenCode", status: "configured" },
    ],
  );
  assert.ok(calls.some(({ command }) => command === "/tools/opencode"));
  assert.ok(messages.error.some((message) => message.includes("Claude Code: denied")));
});

test("opens chrome://extensions only for an interactive graphical install", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chromex-browser-open-test-"));
  const artifactRoot = await createArtifact(root);
  const launches = [];
  const { logger } = createLogger();

  const result = await installChromex({
    artifactRoot,
    environment: {
      DISPLAY: ":1",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: resolve(root, "config"),
      XDG_RUNTIME_DIR: resolve(root, "runtime"),
    },
    findCommand: async (command) => (command === "chromium" ? "/usr/bin/chromium" : null),
    homeDirectory: resolve(root, "home"),
    interactive: true,
    launchBrowser: async (...args) => launches.push(args),
    logger,
  });

  assert.equal(result.openedExtensionsPage, true);
  assert.deepEqual(launches[0].slice(0, 2), ["/usr/bin/chromium", ["chrome://extensions/"]]);

  const noOpen = await installChromex({
    artifactRoot,
    environment: {
      DISPLAY: ":1",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: resolve(root, "config-2"),
      XDG_RUNTIME_DIR: resolve(root, "runtime-2"),
    },
    findCommand: async (command) => (command === "chromium" ? "/usr/bin/chromium" : null),
    homeDirectory: resolve(root, "home-2"),
    interactive: true,
    launchBrowser: async (...args) => launches.push(args),
    logger,
    noOpen: true,
  });
  assert.equal(noOpen.openedExtensionsPage, false);
  assert.equal(launches.length, 1);
});

test("rejects a packaged extension whose key changes the fixed extension ID", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "chromex-extension-id-test-"));
  const artifactRoot = await createArtifact(root);
  await writeJson(resolve(artifactRoot, "dist/extension/manifest.json"), {
    key: Buffer.from("wrong-key").toString("base64"),
    manifest_version: 3,
  });
  const { logger } = createLogger();

  await assert.rejects(
    installChromex({
      artifactRoot,
      environment: {
        PATH: "",
        XDG_CONFIG_HOME: resolve(root, "config"),
        XDG_RUNTIME_DIR: resolve(root, "runtime"),
      },
      findCommand: async () => null,
      homeDirectory: resolve(root, "home"),
      interactive: false,
      logger,
    }),
    /must produce extension ID enbcklgjkjddndpkedgfhoeagcbogfdb/,
  );
});
