import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

for (const temporary of [false, true]) {
  test(`real MCP clients recover navigation and share Chromium (temporary: ${temporary})`, {
    skip: process.env.CHROMEX_LIVE_TEST !== "1",
    timeout: 120_000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "chromex-live-"));
    const page = createServer((_req, res) =>
      res.end(
        "<h1>Shared live page</h1><input aria-label=\"Handoff note\"><button onclick=\"document.querySelector('h1').textContent=document.querySelector('input').value\">Save note</button>",
      ),
    );
    page.listen(0, "127.0.0.1");
    await once(page, "listening");
    const url = `http://127.0.0.1:${(page.address() as { port: number }).port}/`;
    const unavailable = createServer();
    unavailable.listen(0, "127.0.0.1");
    await once(unavailable, "listening");
    const failedUrl = `http://127.0.0.1:${(unavailable.address() as { port: number }).port}/consumer`;
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    const clients: Client[] = [];
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    delete env.NODE_TEST_CONTEXT;
    env.XDG_DATA_HOME = directory;
    env.CHROME_BROWSER_BRIDGE_POLICY = join(directory, "policy.json");
    const connect = async () => {
      const client = new Client({ name: "live-sharing-check", version: "1" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("../plugin/dist/chrome-browser-bridge/dist/mcp-server.mjs")],
          cwd: directory,
          env,
          stderr: "inherit",
        }),
      );
      clients.push(client);
      return client;
    };
    const call = async (client: Client, name: string, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { text?: string }[])
        .map((item) => item.text ?? "")
        .join("\n");
      if (result.isError) throw new Error(text);
      return text;
    };
    const json = async (client: Client, name: string, args = {}) =>
      JSON.parse(await call(client, name, args));
    let servicePid: number | undefined;
    let browserPid: number | undefined;
    const stopService = async (pid: number) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      }
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          return;
        }
        await delay(100);
      }
      throw new Error(`Managed service ${pid} did not exit`);
    };
    try {
      const [a, b] = await Promise.all([connect(), connect()]);
      const options = temporary ? { project: directory, profile: "m4-probe", temporary } : {};
      const joined = temporary
        ? undefined
        : await Promise.all([json(a, "chrome_status"), json(b, "chrome_status")]);
      await assert.rejects(
        call(a, "chrome_open", { ...options, url: failedUrl }),
        /net::ERR_CONNECTION_REFUSED/,
      );
      await assert.rejects(call(a, "chrome_snapshot"), /Navigation failed/);
      await assert.rejects(call(a, "chrome_text"), /Navigation failed/);
      assert.match(await call(a, "chrome_network", { status: "all" }), /ERR_CONNECTION_REFUSED/);
      await call(a, "chrome_console");
      const first = await json(a, "chrome_status", options);
      const second = await json(b, "chrome_status", { browserId: first.managed.browserId });
      if (joined) {
        assert.equal(joined[0].managed.browserId, first.managed.browserId);
        assert.equal(joined[1].managed.browserId, first.managed.browserId);
      }
      assert.equal(first.mode, "managed");
      assert.equal(first.managed.browserId, second.managed.browserId);
      const browserId = first.managed.browserId;
      const record = JSON.parse(
        await readFile(join(directory, "chromex/services", `${browserId}.json`), "utf8"),
      );
      servicePid = record.pid;
      const tab = await json(a, "chrome_open", { url });
      assert.equal((await json(a, "chrome_status", options)).managed.browserId, browserId);
      const launcher = join(dirname(record.configPath), "native-host-launcher.mjs");
      const hosts = await Promise.all(
        (await readdir("/proc"))
          .filter((pid) => /^\d+$/.test(pid))
          .map(async (pid) => {
            const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
            return command.split("\0").includes(launcher) ? Number(pid) : null;
          }),
      );
      const hostPid = hosts.find((pid) => pid !== null);
      assert.ok(hostPid, "private native host was not found");
      process.kill(hostPid, "SIGTERM");
      const socketPath = join(dirname(record.configPath), "bridge.sock");
      for (let i = 0; i < 100; i++) {
        if (
          !(await access(socketPath).then(
            () => true,
            () => false,
          ))
        )
          break;
        await delay(10);
      }
      assert.ok(
        (await json(a, "chrome_tabs", options)).some(
          (entry: { id: number }) => entry.id === tab.id,
        ),
      );
      const snapshot = await call(a, "chrome_snapshot");
      const inputRef = snapshot.match(/\[(e\d+)\].*Handoff note/)?.[1];
      assert.ok(inputRef, snapshot);
      await call(a, "chrome_type", { ref: inputRef, text: "State from agent A" });
      await assert.rejects(
        call(b, "chrome_use_tab", { browserId, tabId: tab.id }),
        /another client/,
      );
      await call(a, "chrome_release");
      await call(b, "chrome_use_tab", { browserId, tabId: tab.id });
      const handoff = await call(b, "chrome_snapshot");
      assert.match(handoff, /State from agent A/);
      const buttonRef = handoff.match(/\[(e\d+)\].*Save note/)?.[1];
      assert.ok(buttonRef, handoff);
      await call(b, "chrome_click", { ref: buttonRef });
      await a.close();
      browserPid = (await json(b, "chrome_process_output")).process.pid;
      await b.close();
      const c = await connect();
      const resumed = await json(c, "chrome_status", { browserId });
      assert.equal(resumed.managed.browserId, browserId);
      assert.equal((await json(c, "chrome_process_output")).process.pid, browserPid);
      await call(c, "chrome_use_tab", { tabId: tab.id });
      assert.match(await call(c, "chrome_text"), /State from agent A/);
      process.kill(browserPid as number, "SIGTERM");
      for (let i = 0; i < 100; i++) {
        if ((await json(c, "chrome_process_output")).process.state !== "running") break;
        await delay(100);
      }
      const recovered = await json(c, "chrome_status");
      assert.equal(recovered.selectedTabId, null);
      const nextPid = (await json(c, "chrome_process_output")).process.pid;
      assert.notEqual(nextPid, browserPid);
      browserPid = nextPid;
      await call(c, "chrome_open", { url });
      assert.match(await call(c, "chrome_text"), /Shared live page/);
      await stopService(servicePid as number);
      await c.close();
      const d = await connect();
      const restarted = await json(d, "chrome_status", { browserId });
      assert.equal(restarted.managed.browserId, browserId);
      const restartedRecord = JSON.parse(
        await readFile(join(directory, "chromex/services", `${browserId}.json`), "utf8"),
      );
      assert.notEqual(restartedRecord.pid, servicePid);
      servicePid = restartedRecord.pid;
      await call(d, "chrome_open", { url });
      assert.match(await call(d, "chrome_text"), /Shared live page/);
      console.log(
        `Verified shared browser ${browserId}: live handoff, state after all clients exit, browser recovery PID ${nextPid}, service rediscovery PID ${servicePid}`,
      );
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      for (const name of await readdir(join(directory, "chromex/services")).catch(() => [])) {
        if (!name.endsWith(".json")) continue;
        const record = JSON.parse(
          await readFile(join(directory, "chromex/services", name), "utf8"),
        );
        if (record.pid > 0) await stopService(record.pid);
      }
      page.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
