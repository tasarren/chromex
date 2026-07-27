// End-to-end Phase 3 verification against the assembled plugin and a real Chromium process.
// Usage: node .orchestrator/scripts/verification/managed-phase3-smoke.mjs
import { createServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PACKAGED_DIST = join(
  REPOSITORY_ROOT,
  "packages/plugin/dist/chrome-browser-bridge/dist",
);
const MCP_SERVER = join(PACKAGED_DIST, "mcp-server.mjs");
const PACKAGED_EXTENSION = join(PACKAGED_DIST, "extension");
const BROWSER = process.env.CHROMEX_BROWSER || "/usr/bin/chromium";
const SOURCE_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), ".config");
const SOURCE_FLAGS = join(SOURCE_CONFIG_HOME, "chromium-flags.conf");

const results = [];
const sessions = new Set();
let workDirectory;
let httpServer;

try {
  await Promise.all([
    access(MCP_SERVER),
    access(join(PACKAGED_EXTENSION, "manifest.json")),
    access(BROWSER),
  ]);
  const sourceFlags = await readFile(SOURCE_FLAGS, "utf8");
  record(
    "user GPU flags include Vulkan and WebGPU",
    sourceFlags.includes("--enable-unsafe-webgpu") &&
      /--enable-features=.*Vulkan/.test(sourceFlags),
  );

  const temporaryRoot = join(REPOSITORY_ROOT, ".orchestrator/tmp");
  await mkdir(temporaryRoot, { recursive: true });
  workDirectory = await mkdtemp(join(temporaryRoot, "p3-"));
  const projectDirectory = join(workDirectory, "project");
  const runtimeRoot = join(workDirectory, "runtime");
  const dataHome = join(workDirectory, "data");
  await Promise.all([
    mkdir(projectDirectory),
    mkdir(runtimeRoot),
    mkdir(dataHome),
  ]);

  httpServer = createTestServer();
  const port = await listen(httpServer);
  const origin = `http://127.0.0.1:${port}`;
  const sessionEnvironment = environment({
    CHROMEX_BROWSER: BROWSER,
    XDG_CONFIG_HOME: SOURCE_CONFIG_HOME,
    XDG_DATA_HOME: dataHome,
    XDG_RUNTIME_DIR: runtimeRoot,
  });

  await verifyTemporaryProfile({
    dataHome,
    origin,
    projectDirectory,
    runtimeRoot,
    sessionEnvironment,
    sourceFlags,
  });
  await verifyPersistentProfiles({
    dataHome,
    origin,
    projectDirectory,
    runtimeRoot,
    sessionEnvironment,
  });
} finally {
  for (const session of [...sessions]) await closeSession(session);
  if (httpServer) await new Promise((resolveClose) => httpServer.close(resolveClose));
  if (workDirectory) await rm(workDirectory, { force: true, recursive: true });

  console.log("\n=== MANAGED PHASE 3 RESULTS ===");
  for (const line of results) console.log(line);
  const passed = results.filter((line) => line.startsWith("PASS")).length;
  console.log(`${passed}/${results.length} passed`);
  if (passed !== results.length) process.exitCode = 1;
}

async function verifyTemporaryProfile({
  origin,
  projectDirectory,
  runtimeRoot,
  sessionEnvironment,
  sourceFlags,
}) {
  const session = await startSession("phase3-temporary", sessionEnvironment);
  const first = await callJson(session, "chrome_open", {
    profile: "temporary-smoke",
    project: projectDirectory,
    temporary: true,
    url: `${origin}/?temporary=1`,
  });
  await callText(session, "chrome_wait", { text: "GPU_RESULT", timeoutMs: 30_000 });

  const status = await callJson(session, "chrome_status", {});
  const tabs = await callJson(session, "chrome_tabs", {});
  record("temporary session enters Managed mode", status.mode === "managed");
  record(
    "bootstrap tab is adopted instead of opening a second tab",
    tabs.length === 1 && tabs[0]?.id === first.id && status.selectedTabId === first.id,
    `tabs=${tabs.map((tab) => tab.id).join(",")}`,
  );

  const descriptor = await waitForDescriptor(runtimeRoot, (value) => value.temporary === true);
  const browserPid = descriptor.browserPid;
  const commandLine = await readCommandLine(browserPid);
  record(
    "browser command line owns the profile and packaged extension",
    commandLine.includes("--user-data-dir=") &&
      commandLine.includes(`--load-extension=${PACKAGED_EXTENSION}`) &&
      commandLine.includes(`--disable-extensions-except=${PACKAGED_EXTENSION}`),
  );

  const copiedFlagsPath = join(dirname(descriptor.configPath), "config", "chromium-flags.conf");
  record(
    "private Chromium config contains an exact copy of the user flags",
    (await readFile(copiedFlagsPath, "utf8")) === sourceFlags,
  );

  const pageText = await callText(session, "chrome_text", { maxChars: 20_000 });
  record("page reports a WebGPU adapter", /"adapter":\{/.test(pageText), pageText);
  record("page renderer is not SwiftShader", !/SwiftShader/i.test(pageText), pageText);

  const gpu = await waitForGpuProcess(browserPid);
  record("Managed Chromium starts a GPU process", gpu.pids.length > 0, gpu.detail);
  record(
    "GPU process does not use the SwiftShader software mapping set",
    gpu.swiftShaderMappings < 50,
    `${gpu.swiftShaderMappings} libvk_swiftshader.so mappings`,
  );

  await callText(session, "chrome_release", {});
  const reopened = await callJson(session, "chrome_open", {
    url: `${origin}/?temporary=2`,
  });
  record("Managed release/open reuses the same primary tab", reopened.id === first.id);

  const runtimeDirectory = dirname(descriptor.configPath);
  const mcpPid = session.transport.pid;
  await closeSession(session);
  await waitForMissing(runtimeDirectory);
  await waitForProcessExit(browserPid);
  if (mcpPid !== null) await waitForProcessExit(mcpPid);
  record("temporary shutdown removes its private runtime", !(await exists(runtimeDirectory)));
  record("temporary shutdown terminates Chromium", !isProcessAlive(browserPid));
  record("temporary shutdown terminates the MCP server", mcpPid === null || !isProcessAlive(mcpPid));
  record(
    "temporary shutdown removes its registry descriptor",
    !(await exists(join(runtimeRoot, "chromex/registry", basename(descriptor.__path)))),
  );
}

async function verifyPersistentProfiles({
  dataHome,
  origin,
  projectDirectory,
  runtimeRoot,
  sessionEnvironment,
}) {
  const token = `phase3-${Date.now()}`;
  const primary = await startSession("phase3-persistent-primary", sessionEnvironment);
  await callJson(primary, "chrome_open", {
    profile: "persistent-smoke",
    project: projectDirectory,
    url: `${origin}/?set=${encodeURIComponent(token)}`,
  });
  await callText(primary, "chrome_wait", {
    text: `COOKIE:${token}`,
    timeoutMs: 30_000,
  });
  const primaryDescriptor = await waitForDescriptor(
    runtimeRoot,
    (value) => value.profile === "persistent-smoke",
  );
  const primaryCommandLine = await readCommandLine(primaryDescriptor.browserPid);
  const profileDirectory = argumentValue(primaryCommandLine, "--user-data-dir=");
  record("persistent profile uses the isolated Chromex data root", profileDirectory?.startsWith(dataHome));

  const conflicting = await startSession("phase3-persistent-conflict", sessionEnvironment);
  let conflictMessage = "";
  try {
    await callJson(conflicting, "chrome_open", {
      profile: "persistent-smoke",
      project: projectDirectory,
      url: `${origin}/?conflict=1`,
    });
  } catch (cause) {
    conflictMessage = cause instanceof Error ? cause.message : String(cause);
  }
  record(
    "concurrent use of the same project/profile is refused",
    /profile is active|another profile name/i.test(conflictMessage),
    conflictMessage,
  );
  await closeSession(conflicting);

  const named = await startSession("phase3-persistent-named", sessionEnvironment);
  await callJson(named, "chrome_open", {
    profile: "parallel-smoke",
    project: projectDirectory,
    url: `${origin}/?parallel=1`,
  });
  const namedDescriptor = await waitForDescriptor(
    runtimeRoot,
    (value) => value.profile === "parallel-smoke",
  );
  record(
    "another named profile launches concurrently",
    namedDescriptor.browserPid !== primaryDescriptor.browserPid,
  );
  await closeSession(named);

  await delay(750);
  await closeSession(primary);
  if (profileDirectory) {
    await access(profileDirectory);
    record("persistent profile directory remains after shutdown", true);
  } else {
    record("persistent profile directory remains after shutdown", false);
  }

  const restarted = await startSession("phase3-persistent-restart", sessionEnvironment);
  await callJson(restarted, "chrome_open", {
    profile: "persistent-smoke",
    project: projectDirectory,
    url: `${origin}/?read=1`,
  });
  await callText(restarted, "chrome_wait", {
    text: `PERSISTED:${token}`,
    timeoutMs: 30_000,
  });
  const restoredText = await callText(restarted, "chrome_text", { maxChars: 20_000 });
  record(
    "local storage survives a persistent-profile restart",
    restoredText.includes(`LOCAL:${token}`),
    restoredText,
  );
  record(
    "cookies survive a persistent-profile restart",
    restoredText.includes(`COOKIE:${token}`),
    restoredText,
  );
  await closeSession(restarted);

  await waitForEmptyDirectory(join(runtimeRoot, "chromex/registry"));
  const locks = await filesUnder(join(dataHome, "chromex/locks"));
  record("all persistent profile locks are released", locks.length === 0, locks.join(", "));
  record(
    "all Managed registry descriptors are removed",
    (await filesUnder(join(runtimeRoot, "chromex/registry"))).length === 0,
  );
}

function createTestServer() {
  return createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname !== "/") {
      response.writeHead(404).end("not found");
      return;
    }
    const headers = {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    };
    const cookieSeed = requestUrl.searchParams.get("set");
    if (cookieSeed) {
      headers["Set-Cookie"] =
        `chromex-phase3=${encodeURIComponent(cookieSeed)}; Max-Age=3600; Path=/; SameSite=Lax`;
    }
    response.writeHead(200, headers);
    response.end(`<!doctype html>
<meta charset="utf-8">
<title>Chromex Managed Phase 3</title>
<main>
  <h1>Chromex Managed Phase 3</h1>
  <p id="persistence"></p>
  <p id="gpu">GPU_PENDING</p>
</main>
<script>
const params = new URLSearchParams(location.search);
const seed = params.get("set");
if (seed) {
  localStorage.setItem("chromex-phase3", seed);
  document.cookie =
    "chromex-phase3=" + encodeURIComponent(seed) + "; Max-Age=3600; Path=/; SameSite=Lax";
}
const local = localStorage.getItem("chromex-phase3") || "missing";
const cookie = document.cookie.match(/(?:^|; )chromex-phase3=([^;]*)/)?.[1] || "missing";
document.querySelector("#persistence").textContent =
  "PERSISTED:" + local + " LOCAL:" + local + " COOKIE:" + decodeURIComponent(cookie);
(async () => {
  let adapter = null;
  try {
    const value = await navigator.gpu?.requestAdapter();
    if (value) {
      const info = value.info || {};
      adapter = {
        architecture: info.architecture || null,
        description: info.description || null,
        device: info.device || null,
        isFallbackAdapter: info.isFallbackAdapter ?? value.isFallbackAdapter ?? null,
        vendor: info.vendor || null,
      };
    }
  } catch (error) {
    adapter = { error: String(error) };
  }
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl");
  const debug = gl?.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null;
  document.querySelector("#gpu").textContent =
    "GPU_RESULT " + JSON.stringify({ adapter, renderer });
})();
</script>`);
  });
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server has no TCP address");
  return address.port;
}

async function startSession(label, env) {
  const transport = new StdioClientTransport({
    args: [MCP_SERVER],
    command: process.execPath,
    cwd: REPOSITORY_ROOT,
    env: { ...env, CHROMEX_LABEL: label },
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));
  const client = new Client(
    { name: "chromex-phase3-verifier", version: "1.0.0" },
    { capabilities: {} },
  );
  const session = { client, label, stderr, transport };
  sessions.add(session);
  try {
    await client.connect(transport);
    return session;
  } catch (cause) {
    await closeSession(session);
    throw cause;
  }
}

async function closeSession(session) {
  if (!sessions.delete(session)) return;
  try {
    await session.client.close();
  } catch (cause) {
    console.error(`Failed to close ${session.label}:`, cause);
  }
}

async function callJson(session, name, args) {
  return JSON.parse(await callText(session, name, args));
}

async function callText(session, name, args) {
  const result = await session.client.callTool({ arguments: args, name });
  const value = (result.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (result.isError) {
    const diagnostics = session.stderr.join("").trim();
    throw new Error(`${value}${diagnostics ? `\n${diagnostics}` : ""}`);
  }
  return value;
}

async function waitForDescriptor(runtimeRoot, predicate) {
  const registry = join(runtimeRoot, "chromex/registry");
  return await waitFor(async () => {
    for (const path of await filesUnder(registry)) {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (predicate(value)) return { ...value, __path: path };
    }
    return null;
  }, "Managed registry descriptor");
}

async function waitForGpuProcess(browserPid) {
  return await waitFor(async () => {
    const descendants = await descendantProcesses(browserPid);
    const pids = descendants
      .filter((processInfo) => processInfo.commandLine.includes("--type=gpu-process"))
      .map((processInfo) => processInfo.pid);
    if (pids.length === 0) return null;
    let swiftShaderMappings = 0;
    for (const pid of pids) {
      try {
        const maps = await readFile(`/proc/${pid}/maps`, "utf8");
        swiftShaderMappings += maps
          .split("\n")
          .filter((line) => line.includes("libvk_swiftshader.so")).length;
      } catch {}
    }
    return {
      detail: `gpu pids=${pids.join(",")} swiftshader mappings=${swiftShaderMappings}`,
      pids,
      swiftShaderMappings,
    };
  }, "Chromium GPU process");
}

async function descendantProcesses(rootPid) {
  const entries = await readdir("/proc", { withFileTypes: true });
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const [commandLine, rawStat] = await Promise.all([
        readCommandLine(pid),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      const fields = rawStat.slice(rawStat.lastIndexOf(")") + 2).split(" ");
      processes.push({ commandLine, pid, ppid: Number(fields[1]) });
    } catch {}
  }
  const descendants = [];
  const parents = new Set([rootPid]);
  let added = true;
  while (added) {
    added = false;
    for (const processInfo of processes) {
      if (!parents.has(processInfo.ppid) || parents.has(processInfo.pid)) continue;
      parents.add(processInfo.pid);
      descendants.push(processInfo);
      added = true;
    }
  }
  return descendants;
}

async function readCommandLine(pid) {
  return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ").trim();
}

function argumentValue(commandLine, prefix) {
  return commandLine
    .split(" ")
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

async function waitForMissing(path) {
  await waitFor(async () => (!(await exists(path)) ? true : null), `removal of ${path}`);
}

async function waitForProcessExit(pid) {
  await waitFor(async () => (!isProcessAlive(pid) ? true : null), `process ${pid} exit`);
}

async function waitForEmptyDirectory(path) {
  await waitFor(async () => ((await filesUnder(path)).length === 0 ? true : null), `empty ${path}`);
}

async function waitFor(action, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (value) return value;
    } catch (cause) {
      lastError = cause;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

async function filesUnder(root) {
  const files = [];
  if (!(await exists(root))) return files;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(path);
  }
  return files;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function environment(overrides) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(([, value]) => value !== undefined),
  );
}

function record(name, pass, detail = "") {
  results.push(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
