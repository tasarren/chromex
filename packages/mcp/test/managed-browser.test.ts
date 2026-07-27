import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  acquireProfileLock,
  copyChromiumFlags,
  findConflictingChromiumFlag,
  ManagedBrowser,
  ManagedBrowserLaunchError,
  managedProjectKey,
  resolveManagedEnvironment,
  validateProfileName,
} from "../src/mcp/managed-browser.js";
import { NATIVE_HOST_NAME } from "../src/protocol/schema.js";

test("managed project keys are readable and path-stable", () => {
  const first = managedProjectKey("/work/acme");
  assert.match(first, /^acme-[a-f0-9]{12}$/);
  assert.equal(first, managedProjectKey("/work/acme"));
  assert.notEqual(first, managedProjectKey("/other/acme"));
});

test("managed profile names cannot escape their project directory", () => {
  assert.equal(validateProfileName("buyer-2.test"), "buyer-2.test");
  for (const invalid of ["", ".", "..", "../buyer", "buyer/admin", "has space", "x".repeat(65)]) {
    assert.throws(() => validateProfileName(invalid), /profile name/i);
  }
});

test("managed Chromium rejects flags that take ownership of its session", () => {
  for (const flag of [
    "--user-data-dir=/tmp/other",
    "--load-extension=/tmp/other",
    "--disable-extensions-except=/tmp/other",
    "--remote-debugging-port=9222",
    "--remote-debugging-pipe",
  ]) {
    assert.equal(findConflictingChromiumFlag(`# comment\n${flag}\n`), flag);
  }
  assert.equal(
    findConflictingChromiumFlag(
      "--enable-features=Vulkan,VaapiVideoDecoder\n--disable-vulkan-surface\n",
    ),
    null,
  );
});

test("managed Chromium copies the user's GPU flag file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chromex-flags-"));
  const source = join(directory, "source");
  const target = join(directory, "target");
  const flags = "--enable-unsafe-webgpu\n--enable-features=Vulkan,VaapiVideoDecoder\n";
  try {
    await mkdir(source);
    await writeFile(join(source, "chromium-flags.conf"), flags);
    assert.equal(await copyChromiumFlags(source, target), true);
    assert.equal(await readFile(join(target, "chromium-flags.conf"), "utf8"), flags);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("managed environment snapshots are allowlisted and current values win", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chromex-managed-environment-"));
  const snapshotPath = join(directory, "managed-environment.json");
  try {
    await writeFile(
      snapshotPath,
      JSON.stringify({
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        DISPLAY: ":77",
        SECRET_TOKEN: "must-not-load",
        WAYLAND_DISPLAY: "wayland-7",
        XAUTHORITY: "/tmp/saved-xauthority",
      }),
    );
    const resolved = await resolveManagedEnvironment(
      { DISPLAY: ":88", HOME: "/tmp/home" },
      snapshotPath,
    );
    assert.equal(resolved.DISPLAY, ":88");
    assert.equal(resolved.WAYLAND_DISPLAY, "wayland-7");
    assert.equal(resolved.XAUTHORITY, "/tmp/saved-xauthority");
    assert.equal(resolved.SECRET_TOKEN, undefined);

    await writeFile(snapshotPath, "not-json");
    assert.deepEqual(await resolveManagedEnvironment({ DISPLAY: ":99" }, snapshotPath), {
      DISPLAY: ":99",
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("profile locks reject live owners and recover stale owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chromex-lock-"));
  const lockPath = join(directory, "default.lock");
  try {
    const release = await acquireProfileLock(lockPath, "first", process.pid);
    await assert.rejects(
      acquireProfileLock(lockPath, "second", process.pid),
      /another profile name/i,
    );
    await release();

    await mkdir(lockPath);
    await assert.rejects(acquireProfileLock(lockPath, "racing", process.pid), /retry shortly/);
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647, sessionId: "stale" }),
    );
    const releaseRecovered = await acquireProfileLock(lockPath, "recovered", process.pid);
    assert.equal(basename(lockPath), "default.lock");
    await releaseRecovered();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("ManagedBrowser launches with a private bridge and inherited GPU flags", async () => {
  const fixture = await managedFixture();
  let browser: ManagedBrowser | undefined;
  try {
    browser = await ManagedBrowser.launch(
      { profile: "default", projectPath: fixture.project, temporary: false },
      fixture.dependencies,
    );
    const launch = JSON.parse(await waitForFile(fixture.capture)) as {
      args: string[];
      configHome: string;
    };
    assert(launch.args.includes(`--user-data-dir=${browser.profileDirectory}`));
    assert(launch.args.includes(`--load-extension=${fixture.extension}`));
    assert(launch.args.includes("--disable-background-mode"));
    assert.equal(
      await readFile(join(launch.configHome, "chromium-flags.conf"), "utf8"),
      fixture.flags,
    );
    const registry = JSON.parse(await readFile(browser.registryPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(registry.profile, "default");
    assert.equal("token" in registry, false);
    const nativeManifestPath = join(
      browser.profileDirectory,
      "NativeMessagingHosts",
      `${NATIVE_HOST_NAME}.json`,
    );
    const nativeManifest = JSON.parse(await readFile(nativeManifestPath, "utf8")) as {
      path?: string;
    };
    assert.equal(nativeManifest.path?.startsWith(browser.runtimeDirectory), true);
    const runtimeDirectory = browser.runtimeDirectory;
    const profileDirectory = browser.profileDirectory;
    await browser.close();
    browser = undefined;
    await assert.rejects(access(runtimeDirectory), /ENOENT/);
    await assert.rejects(access(nativeManifestPath), /ENOENT/);
    await access(profileDirectory);
  } finally {
    await browser?.close();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("ManagedBrowser restores a filtered graphical environment from the installed snapshot", async () => {
  const fixture = await managedFixture();
  const managedEnvironmentPath = join(fixture.directory, "managed-environment.json");
  const environment: NodeJS.ProcessEnv = { ...fixture.dependencies.env };
  delete environment.DISPLAY;
  delete environment.WAYLAND_DISPLAY;
  delete environment.XAUTHORITY;
  let browser: ManagedBrowser | undefined;
  try {
    await writeFile(
      managedEnvironmentPath,
      JSON.stringify({
        DISPLAY: ":77",
        SECRET_TOKEN: "must-not-load",
        XAUTHORITY: "/tmp/saved-xauthority",
      }),
    );
    browser = await ManagedBrowser.launch(
      { projectPath: fixture.project, temporary: true },
      { ...fixture.dependencies, env: environment, managedEnvironmentPath },
    );
    const launch = JSON.parse(await waitForFile(fixture.capture)) as {
      display?: string;
      secret?: string;
      xauthority?: string;
    };
    assert.equal(launch.display, ":77");
    assert.equal(launch.xauthority, "/tmp/saved-xauthority");
    assert.equal(launch.secret, undefined);
  } finally {
    await browser?.close();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("ManagedBrowser reports how to restore a missing graphical environment", async () => {
  const fixture = await managedFixture();
  const environment: NodeJS.ProcessEnv = { ...fixture.dependencies.env };
  delete environment.DISPLAY;
  delete environment.WAYLAND_DISPLAY;
  try {
    await assert.rejects(
      ManagedBrowser.launch(
        { projectPath: fixture.project },
        {
          ...fixture.dependencies,
          env: environment,
          managedEnvironmentPath: join(fixture.directory, "missing-environment.json"),
        },
      ),
      /Re-run pnpm install:local.*DISPLAY or WAYLAND_DISPLAY/i,
    );
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("ManagedBrowser rejects Chrome-branded executables", async () => {
  const fixture = await managedFixture();
  const branded = join(fixture.directory, "google-chrome");
  try {
    await writeFile(branded, "");
    await chmod(branded, 0o700);
    await assert.rejects(
      ManagedBrowser.launch(
        { projectPath: fixture.project },
        { ...fixture.dependencies, browserPath: branded },
      ),
      /Chrome-branded builds/i,
    );
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("ManagedBrowser reports retained Chromium output when launch exits early", async () => {
  const fixture = await managedFixture();
  try {
    await writeFile(
      fixture.browserPath,
      `#!${process.execPath}
import { readFile } from "node:fs/promises";
process.stdout.write("fixture stdout\\n");
process.stderr.write(await readFile(process.env.CHROME_BROWSER_BRIDGE_CONFIG, "utf8"));
process.stderr.write("fixture stderr\\n");
process.exit(23);
`,
    );
    await chmod(fixture.browserPath, 0o700);
    await assert.rejects(
      ManagedBrowser.launch(
        { projectPath: fixture.project, temporary: true },
        { ...fixture.dependencies, ready: undefined },
      ),
      (cause: unknown) => {
        assert.ok(cause instanceof ManagedBrowserLaunchError);
        assert.match(cause.message, /exit code 23/);
        assert.match(cause.message, /fixture stderr/);
        assert.match(cause.message, /\[REDACTED\]/);
        assert.doesNotMatch(cause.message, /"token":"[a-f0-9]{64}"/);
        const output = cause.diagnostics.read({ maxChars: 20_000, stream: "all" });
        assert.equal(output.process.exitCode, 23);
        assert.equal(output.process.state, "failed");
        assert.match(output.output.entries.map((entry) => entry.text).join(""), /fixture stdout/);
        return true;
      },
    );
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("ManagedBrowser removes temporary profiles on close", async () => {
  const fixture = await managedFixture();
  let browser: ManagedBrowser | undefined;
  try {
    browser = await ManagedBrowser.launch(
      { profile: "clean", projectPath: fixture.project, temporary: true },
      fixture.dependencies,
    );
    const profileDirectory = browser.profileDirectory;
    await browser.close();
    browser = undefined;
    await assert.rejects(access(profileDirectory), /ENOENT/);
  } finally {
    await browser?.close();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("ManagedBrowser locks persistent profiles but allows another name", async () => {
  const fixture = await managedFixture();
  let first: ManagedBrowser | undefined;
  let named: ManagedBrowser | undefined;
  try {
    first = await ManagedBrowser.launch(
      { profile: "default", projectPath: fixture.project, temporary: false },
      fixture.dependencies,
    );
    await assert.rejects(
      ManagedBrowser.launch(
        { profile: "default", projectPath: fixture.project, temporary: false },
        fixture.dependencies,
      ),
      /another profile name/i,
    );
    named = await ManagedBrowser.launch(
      { profile: "buyer", projectPath: fixture.project, temporary: false },
      { ...fixture.dependencies, env: { ...fixture.dependencies.env, CHROMEX_TEST_CAPTURE: "" } },
    );
    assert.notEqual(first.profileDirectory, named.profileDirectory);
  } finally {
    await named?.close();
    await first?.close();
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

async function managedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "chromex-managed-"));
  const project = join(directory, "project");
  const configHome = join(directory, "user-config");
  const extension = join(directory, "extension");
  const nativeHost = join(directory, "native-host.mjs");
  const browserPath = join(directory, "fake-chromium.mjs");
  const capture = join(directory, "launch.json");
  const flags = "--enable-unsafe-webgpu\n--enable-features=Vulkan,VaapiVideoDecoder\n";
  await Promise.all([mkdir(project), mkdir(configHome), mkdir(extension)]);
  await writeFile(join(configHome, "chromium-flags.conf"), flags);
  await writeFile(nativeHost, "");
  await writeFile(
    browserPath,
    `#!${process.execPath}\nimport { writeFile } from "node:fs/promises";\nconst capture = process.env.CHROMEX_TEST_CAPTURE;\nif (capture) await writeFile(capture, JSON.stringify({ args: process.argv.slice(2), configHome: process.env.XDG_CONFIG_HOME, display: process.env.DISPLAY, secret: process.env.SECRET_TOKEN, xauthority: process.env.XAUTHORITY }));\nsetInterval(() => {}, 1000);\n`,
  );
  await chmod(browserPath, 0o700);
  return {
    browserPath,
    capture,
    directory,
    extension,
    flags,
    nativeHost,
    project,
    dependencies: {
      browserPath,
      env: {
        ...process.env,
        CHROMEX_TEST_CAPTURE: capture,
        DISPLAY: ":test",
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: join(directory, "data"),
        XDG_RUNTIME_DIR: join(directory, "runtime"),
      },
      extensionPath: extension,
      nativeHostPath: nativeHost,
      ready: async () => undefined,
      shutdownGraceMs: 0,
    },
  };
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
