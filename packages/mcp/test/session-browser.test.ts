import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolveManagedProject, SessionBrowser } from "../src/mcp/session-browser.js";

test("Managed resolves canonical roots, falls back to cwd, and rejects ambiguous roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chromex-project-"));
  const project = join(directory, "project");
  try {
    await mkdir(project);
    await symlink(project, join(directory, "alias"));
    assert.equal(await resolveManagedProject(undefined, []), await realpath(process.cwd()));
    assert.equal(
      await resolveManagedProject(
        undefined,
        [project, join(directory, "alias")].map((path) => ({ uri: pathToFileURL(path).href })),
      ),
      project,
    );
    await assert.rejects(
      resolveManagedProject(
        undefined,
        [project, directory].map((path) => ({ uri: pathToFileURL(path).href })),
      ),
      /multiple MCP roots/,
    );
    assert.equal(await resolveManagedProject(project, []), project);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("release and close need no browser; diagnostics and closed sessions fail clearly", async () => {
  const session = new SessionBrowser(async () => ({ roots: [] }));
  await session.initialize();
  await session.release();
  await assert.rejects(
    session.processOutput({ maxChars: 20_000, stream: "all" }),
    /No Managed Chromium process diagnostics/,
  );
  await session.close();
  await assert.rejects(session.status(), /Browser session closed/);
});
