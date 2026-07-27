import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "chrome-browser-bridge";
const nativeHostName = "io.codex.chrome_bridge";
const extensionId = "enbcklgjkjddndpkedgfhoeagcbogfdb";
const extensionOrigin = `chrome-extension://${extensionId}/`;
const chromeIdAlphabet = "abcdefghijklmnop";
const managedEnvironmentNames = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];

const browserCandidates = [
  { command: "chromium", configDirectory: "chromium" },
  { command: "chromium-browser", configDirectory: "chromium" },
  { command: "google-chrome-stable", configDirectory: "google-chrome" },
  { command: "google-chrome", configDirectory: "google-chrome" },
  { command: "google-chrome-beta", configDirectory: "google-chrome-beta" },
  { command: "google-chrome-unstable", configDirectory: "google-chrome-unstable" },
];

export class CommandError extends Error {
  constructor(command, args, cause) {
    const detail = [cause.stderr, cause.stdout, cause.message]
      .find((value) => typeof value === "string" && value.trim())
      ?.trim();
    super(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
    this.name = "CommandError";
    this.command = command;
    this.args = args;
    this.cause = cause;
  }
}

async function defaultRunCommand(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(new CommandError(command, args, error));
          return;
        }
        resolvePromise({ stderr, stdout });
      },
    );
  });
}

async function defaultFindCommand(command, environment) {
  const candidates = [];
  if (isAbsolute(command) || command.includes("/")) {
    candidates.push(resolve(command));
  } else {
    for (const directory of (environment.PATH ?? "").split(delimiter)) {
      if (directory) candidates.push(resolve(directory, command));
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function defaultLaunchBrowser(executable, args, environment) {
  const child = spawn(executable, args, {
    detached: true,
    env: environment,
    stdio: "ignore",
  });
  child.unref();
}

function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  let id = "";
  for (const byte of digest) {
    id += chromeIdAlphabet[byte >> 4];
    id += chromeIdAlphabet[byte & 0x0f];
  }
  return id;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function validateArtifact(artifactRoot) {
  const requiredPaths = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "dist/mcp-server.mjs",
    "dist/managed-service.mjs",
    "dist/native-host.mjs",
    "dist/extension/manifest.json",
    "skills/chrome-browser/SKILL.md",
  ];
  for (const relativePath of requiredPaths) {
    const path = resolve(artifactRoot, relativePath);
    const details = await stat(path);
    if (!details.isFile()) throw new Error(`Required artifact is not a file: ${path}`);
  }

  const pluginManifest = await readJson(resolve(artifactRoot, ".codex-plugin/plugin.json"));
  if (pluginManifest.name !== pluginName) {
    throw new Error(`Plugin manifest name must be ${pluginName}`);
  }

  const extensionManifest = await readJson(resolve(artifactRoot, "dist/extension/manifest.json"));
  if (
    typeof extensionManifest.key !== "string" ||
    extensionIdFromKey(extensionManifest.key) !== extensionId
  ) {
    throw new Error(`Packaged extension key must produce extension ID ${extensionId}`);
  }
}

async function replaceInstalledPlugin(artifactRoot, installRoot) {
  const installParent = dirname(installRoot);
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const stagingRoot = resolve(installParent, `.${pluginName}.staging-${suffix}`);
  const backupRoot = resolve(installParent, `.${pluginName}.backup-${suffix}`);
  let movedExisting = false;
  let installedStaging = false;

  await mkdir(installParent, { recursive: true });
  try {
    await cp(artifactRoot, stagingRoot, { recursive: true });
    await validateArtifact(stagingRoot);
    await chmod(resolve(stagingRoot, "dist/native-host.mjs"), 0o700);

    try {
      await rename(installRoot, backupRoot);
      movedExisting = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    try {
      await rename(stagingRoot, installRoot);
      installedStaging = true;
    } catch (error) {
      if (movedExisting) await rename(backupRoot, installRoot);
      throw error;
    }

    if (movedExisting) await rm(backupRoot, { force: true, recursive: true });
  } finally {
    if (!installedStaging) await rm(stagingRoot, { force: true, recursive: true });
  }
}

async function readExistingToken(configPath) {
  try {
    const existing = await readJson(configPath);
    if (typeof existing.token === "string" && existing.token.length >= 32) return existing.token;
  } catch {}
  return randomBytes(32).toString("hex");
}

async function writeBridgeConfig({ configHome, runtimeDirectory }) {
  const configDirectory = resolve(configHome, "chrome-browser-bridge");
  const configPath = resolve(configDirectory, "config.json");
  await mkdir(configDirectory, { mode: 0o700, recursive: true });
  await chmod(configDirectory, 0o700);
  await mkdir(runtimeDirectory, { mode: 0o700, recursive: true });
  await chmod(runtimeDirectory, 0o700);

  const config = {
    extensionOrigin,
    socketPath: resolve(runtimeDirectory, "bridge.sock"),
    token: await readExistingToken(configPath),
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  return { config, configPath };
}

async function writeManagedEnvironment({ environment, installRoot }) {
  const snapshot = {};
  for (const name of managedEnvironmentNames) {
    const value = environment[name];
    if (typeof value === "string" && value.length > 0) snapshot[name] = value;
  }
  const path = resolve(installRoot, "dist/managed-environment.json");
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function browserConfigDirectory(command) {
  const executableName = basename(command);
  if (executableName.includes("beta")) return "google-chrome-beta";
  if (executableName.includes("unstable")) return "google-chrome-unstable";
  if (executableName.includes("google-chrome") || executableName.includes("chrome")) {
    return "google-chrome";
  }
  return "chromium";
}

async function detectBrowsers({ environment, findCommand }) {
  const browsers = [];
  const seenExecutables = new Set();

  if (environment.CHROMEX_BROWSER) {
    const executable = await findCommand(environment.CHROMEX_BROWSER, environment);
    if (!executable) {
      throw new Error(`CHROMEX_BROWSER is not executable: ${environment.CHROMEX_BROWSER}`);
    }
    browsers.push({
      configDirectory: browserConfigDirectory(executable),
      executable,
    });
    seenExecutables.add(executable);
  }

  for (const candidate of browserCandidates) {
    const executable = await findCommand(candidate.command, environment);
    if (!executable || seenExecutables.has(executable)) continue;
    browsers.push({ configDirectory: candidate.configDirectory, executable });
    seenExecutables.add(executable);
  }
  return browsers;
}

async function registerNativeHosts({ browsers, configHome, installRoot }) {
  const configDirectories = new Set(browsers.map((browser) => browser.configDirectory));
  if (configDirectories.size === 0) configDirectories.add("chromium");

  const manifest = {
    allowed_origins: [extensionOrigin],
    description: "Local native messaging host for the Chromex browser bridge",
    name: nativeHostName,
    path: resolve(installRoot, "dist/native-host.mjs"),
    type: "stdio",
  };
  const manifestPaths = [];
  for (const configDirectory of configDirectories) {
    const path = resolve(
      configHome,
      configDirectory,
      "NativeMessagingHosts",
      `${nativeHostName}.json`,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    await chmod(path, 0o644);
    manifestPaths.push(path);
  }
  return manifestPaths;
}

async function marketplaceContainsPlugin(marketplacePath) {
  try {
    const marketplace = await readJson(marketplacePath);
    if (!Array.isArray(marketplace.plugins)) {
      throw new Error(`${marketplacePath} must contain a plugins array`);
    }
    return marketplace.plugins.some((entry) => entry?.name === pluginName);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function registerCodex({
  codex,
  environment,
  findCommand,
  homeDirectory,
  installRoot,
  pluginCreatorRoot,
  runCommand,
}) {
  const python = await findCommand("python3", environment);
  if (!python) throw new Error("python3 is required to configure the Codex plugin");

  const scriptsDirectory = resolve(pluginCreatorRoot, "scripts");
  const createScript = resolve(scriptsDirectory, "create_basic_plugin.py");
  const updateScript = resolve(scriptsDirectory, "update_plugin_cachebuster.py");
  const readNameScript = resolve(scriptsDirectory, "read_marketplace_name.py");
  await Promise.all([access(createScript), access(updateScript), access(readNameScript)]);

  const marketplacePath = resolve(homeDirectory, ".agents/plugins/marketplace.json");
  if (!(await marketplaceContainsPlugin(marketplacePath))) {
    const sourceManifest = await readFile(
      resolve(installRoot, ".codex-plugin/plugin.json"),
      "utf8",
    );
    try {
      await runCommand(python, [createScript, pluginName, "--with-marketplace", "--force"], {
        env: environment,
      });
    } finally {
      await writeFile(resolve(installRoot, ".codex-plugin/plugin.json"), sourceManifest);
    }
  }

  await runCommand(python, [updateScript, installRoot], { env: environment });
  const marketplaceResult = await runCommand(python, [readNameScript], { env: environment });
  const marketplaceName = marketplaceResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!marketplaceName) throw new Error("Could not resolve the personal Codex marketplace name");

  await runCommand(codex, ["plugin", "add", `${pluginName}@${marketplaceName}`, "--json"], {
    env: environment,
  });
}

async function registerClaude({ claude, environment, installRoot, nodePath, runCommand }) {
  try {
    await runCommand(claude, ["mcp", "remove", pluginName, "--scope", "user"], {
      env: environment,
    });
  } catch {}

  const definition = JSON.stringify({
    args: [resolve(installRoot, "dist/mcp-server.mjs")],
    command: nodePath,
    type: "stdio",
  });
  await runCommand(claude, ["mcp", "add-json", "--scope", "user", pluginName, definition], {
    env: environment,
  });
}

async function registerOpenCode({ environment, installRoot, nodePath, opencode, runCommand }) {
  const help = await runCommand(opencode, ["mcp", "add", "--help"], { env: environment });
  const args = ["mcp", "add", pluginName];
  if (`${help.stdout}\n${help.stderr}`.includes("--global")) args.push("--global");
  args.push("--", nodePath, resolve(installRoot, "dist/mcp-server.mjs"));
  await runCommand(opencode, args, { env: environment });
}

async function configureClients(options) {
  const clients = [
    {
      configure: registerCodex,
      name: "Codex",
      command: "codex",
      arguments: (executable) => ({ ...options, codex: executable }),
    },
    {
      configure: registerClaude,
      name: "Claude Code",
      command: "claude",
      arguments: (executable) => ({ ...options, claude: executable }),
    },
    {
      configure: registerOpenCode,
      name: "OpenCode",
      command: "opencode",
      arguments: (executable) => ({ ...options, opencode: executable }),
    },
  ];
  const results = [];

  for (const client of clients) {
    const executable = await options.findCommand(client.command, options.environment);
    if (!executable) {
      results.push({ client: client.name, status: "skipped" });
      continue;
    }
    try {
      await client.configure(client.arguments(executable));
      results.push({ client: client.name, status: "configured" });
    } catch (error) {
      results.push({ client: client.name, error, status: "failed" });
    }
  }
  return results;
}

function shouldOpenExtensions({ environment, interactive, noOpen }) {
  if (noOpen || !interactive || environment.CI === "true") return false;
  return Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}

export async function installChromex(options = {}) {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const configHome = environment.XDG_CONFIG_HOME || resolve(homeDirectory, ".config");
  const runtimeDirectory =
    environment.XDG_RUNTIME_DIR || resolve(tmpdir(), `chrome-browser-bridge-${process.getuid()}`);
  const artifactRoot = options.artifactRoot ?? resolve(packageRoot, "dist", pluginName);
  const installRoot = options.installRoot ?? resolve(homeDirectory, "plugins", pluginName);
  const findCommand = options.findCommand ?? defaultFindCommand;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const launchBrowser = options.launchBrowser ?? defaultLaunchBrowser;
  const logger = options.logger ?? console;
  const nodePath = options.nodePath ?? process.execPath;
  const codexHome = environment.CODEX_HOME || resolve(homeDirectory, ".codex");
  const pluginCreatorRoot =
    options.pluginCreatorRoot ?? resolve(codexHome, "skills/.system/plugin-creator");

  if ((options.platform ?? process.platform) !== "linux") {
    throw new Error("The Chromex local installer currently supports Linux only");
  }

  await validateArtifact(artifactRoot);
  await replaceInstalledPlugin(artifactRoot, installRoot);
  const skillPath = resolve(homeDirectory, ".agents/skills/chrome-browser");
  const skillTarget = resolve(installRoot, "skills/chrome-browser");
  await mkdir(dirname(skillPath), { recursive: true });
  try {
    await symlink(skillTarget, skillPath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await readlink(skillPath).catch(() => null)) !== skillTarget) {
      logger.warn(
        `Browser skill path already exists; preserved ${skillPath}. Installed skill: ${skillTarget}`,
      );
    }
  }
  const managedEnvironmentPath = await writeManagedEnvironment({ environment, installRoot });
  const bridge = await writeBridgeConfig({ configHome, runtimeDirectory });
  const browsers = await detectBrowsers({ environment, findCommand });
  const nativeHostPaths = await registerNativeHosts({ browsers, configHome, installRoot });
  const clientResults = await configureClients({
    environment,
    findCommand,
    homeDirectory,
    installRoot,
    nodePath,
    pluginCreatorRoot,
    runCommand,
  });

  const extensionPath = resolve(installRoot, "dist/extension");
  let openedExtensionsPage = false;
  if (
    shouldOpenExtensions({
      environment,
      interactive: options.interactive ?? Boolean(process.stdout.isTTY),
      noOpen: options.noOpen ?? false,
    })
  ) {
    const browser = browsers[0];
    if (browser) {
      await launchBrowser(browser.executable, ["chrome://extensions/"], environment);
      openedExtensionsPage = true;
    } else {
      logger.warn(
        "No supported Chrome/Chromium executable was found; open chrome://extensions manually.",
      );
    }
  }

  logger.log(`Installed Chromex plugin: ${installRoot}`);
  logger.log(`Bridge config: ${bridge.configPath}`);
  logger.log(`Managed environment: ${managedEnvironmentPath}`);
  logger.log(`Browser skill: ${skillTarget}`);
  for (const path of nativeHostPaths) logger.log(`Native host: ${path}`);
  for (const result of clientResults) {
    if (result.status === "configured") logger.log(`${result.client}: configured`);
    if (result.status === "skipped") {
      logger.warn(`${result.client}: CLI not found; skipped MCP registration`);
    }
    if (result.status === "failed") logger.error(`${result.client}: ${result.error.message}`);
  }
  logger.log(`Observe extension: ${extensionPath}`);
  logger.log("In chrome://extensions, enable Developer mode and choose Load unpacked.");

  return {
    bridge,
    browsers,
    clientResults,
    extensionPath,
    installRoot,
    managedEnvironmentPath,
    nativeHostPaths,
    openedExtensionsPage,
  };
}

function parseArguments(argumentsList) {
  let noOpen = false;
  for (const argument of argumentsList) {
    if (argument === "--") continue;
    if (argument === "--no-open") {
      noOpen = true;
      continue;
    }
    throw new Error(`Unknown installer option: ${argument}`);
  }
  return { noOpen };
}

export async function main(argumentsList = process.argv.slice(2)) {
  try {
    const result = await installChromex(parseArguments(argumentsList));
    if (result.clientResults.some((client) => client.status === "failed")) process.exitCode = 1;
  } catch (error) {
    console.error(`Chromex installation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
