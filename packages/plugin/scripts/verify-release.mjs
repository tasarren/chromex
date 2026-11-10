#!/usr/bin/env node
/* eslint-disable no-console -- CLI output goes to stdout for workflow steps. */
// Release guards for .github/workflows/release.yml. Read-only: never edits files, refs, or tags.
// Usage: node packages/plugin/scripts/verify-release.mjs preflight
//        node packages/plugin/scripts/verify-release.mjs candidate <dir>
// Inputs come from the environment (GitHub variables plus RELEASE_* and CANDIDATE_SHA256).
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { lstat, readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageName = "@tasarren/chromex"
const repositoryUrl = "git+https://github.com/tasarren/chromex.git"
const modes = ["verify", "rehearse-stage"]
const plugin = "package/dist/chromex"
const versionedMembers = [
  "package/package.json",
  `${plugin}/.codex-plugin/plugin.json`,
  `${plugin}/dist/extension/manifest.json`,
]
const manifests = [
  "package.json",
  "packages/extension/package.json",
  "packages/mcp/package.json",
  "packages/protocol/package.json",
  "packages/plugin/package.json",
  "packages/extension/static/manifest.json",
  "packages/plugin/src/chromex/.codex-plugin/plugin.json",
]
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

async function checkVersions(root, tag) {
  const versions = await Promise.all(
    manifests.map(async(path) => {
      const manifest = JSON.parse(await readFile(resolve(root, path), "utf8"))
      return { path, version: manifest.version }
    }),
  )
  const expected = versions[0]?.version
  if (versions.some(({ version }) => version !== expected)) {
    throw new Error(`Chromex version mismatch: ${JSON.stringify(versions)}`)
  }
  if (typeof expected !== "string" || !stableVersion.test(expected)) {
    throw new Error(`Chromex version must be stable MAJOR.MINOR.PATCH: ${JSON.stringify(expected)}`)
  }
  if (tag !== undefined && tag !== `v${expected}`) {
    throw new Error(`Release tag ${JSON.stringify(tag)} must be v${expected}`)
  }
  return expected
}

const git = (root, ...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim()

function refCommit(root, ref, message) {
  try {
    return git(root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)
  } catch {
    throw new Error(message)
  }
}

function hasDatedSection(changelog, version) {
  const escaped = version.replaceAll(".", "\\.")
  const match = changelog.match(
    new RegExp(`^## \\[?${escaped}\\]? - (\\d{4}-\\d{2}-\\d{2})$`, "m"),
  )
  const date = match && new Date(`${match[1]}T00:00:00Z`)
  return Boolean(date) && !Number.isNaN(date.getTime()) && date.toISOString().startsWith(match[1])
}

export async function preflight(root, env) {
  const event = env.GITHUB_EVENT_NAME
  const head = git(root, "rev-parse", "HEAD")
  if (head !== env.GITHUB_SHA) {
    throw new Error(`Checked-out commit ${head} is not the event commit ${env.GITHUB_SHA}`)
  }
  if (git(root, "status", "--porcelain", "--untracked-files=all") !== "") {
    throw new Error("Release checkout has changed or untracked files")
  }
  const main = refCommit(root, "refs/remotes/origin/main", "origin/main is not fetched")
  let version
  let needsDate
  if (event === "release") {
    const tag = env.RELEASE_TAG ?? ""
    if (env.RELEASE_PRERELEASE !== "false") throw new Error("Only stable releases are staged")
    if (env.GITHUB_REF !== `refs/tags/${tag}`) {
      throw new Error(`Release ref ${env.GITHUB_REF} does not match tag ${tag}`)
    }
    version = await checkVersions(root, tag)
    if (refCommit(root, `refs/tags/${tag}`, `Tag ${tag} is not fetched`) !== head) {
      throw new Error(`Tag ${tag} does not point to ${head}`)
    }
    try {
      git(root, "merge-base", "--is-ancestor", head, main)
    } catch {
      throw new Error(`Tag ${tag} is not on main`)
    }
    needsDate = true
  } else if (event === "workflow_dispatch") {
    if (!modes.includes(env.RELEASE_MODE)) throw new Error(`Unknown mode ${env.RELEASE_MODE}`)
    if (env.GITHUB_REF !== "refs/heads/main") throw new Error("Dispatch must run on main")
    if (head !== main) throw new Error(`Dispatch commit ${head} is not current main ${main}`)
    version = await checkVersions(root)
    needsDate = env.RELEASE_MODE === "rehearse-stage"
  } else {
    throw new Error(`Unsupported release event ${event}`)
  }
  const manifest = JSON.parse(await readFile(join(root, "packages/plugin/package.json"), "utf8"))
  if (manifest.name !== packageName || manifest.repository?.url !== repositoryUrl) {
    throw new Error(`Package identity must be ${packageName} at ${repositoryUrl}`)
  }
  if (needsDate && !hasDatedSection(await readFile(join(root, "CHANGELOG.md"), "utf8"), version)) {
    throw new Error(`CHANGELOG.md has no dated ${version} section`)
  }
  return version
}

// Same locale and time zone as the ci.yml producer, so the listing compares literally.
export const listingEnv = { ...process.env, LC_ALL: "C", TZ: "UTC" }

export async function checkCandidate(dir, env) {
  const version = env.RELEASE_VERSION ?? ""
  const digest = env.CANDIDATE_SHA256 ?? ""
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Bad preflight version ${version}`)
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Producer digest is missing or malformed")
  const tarball = `tasarren-chromex-${version}.tgz`
  const names = ["SHA256SUMS", "identity.txt", "inventory.txt", tarball].sort()
  assert.deepEqual((await readdir(dir)).sort(), names, "Candidate artifact file set")
  for (const name of names) {
    assert.ok((await lstat(join(dir, name))).isFile(), `${name} must be a regular file`)
  }
  const path = join(dir, tarball)
  const actual = createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
  assert.equal(actual, digest, "Tarball digest must equal the producer output")
  assert.equal(await readFile(join(dir, "SHA256SUMS"), "utf8"), `${digest}  ./${tarball}\n`)
  assert.equal(
    await readFile(join(dir, "inventory.txt"), "utf8"),
    execFileSync("tar", ["-tvzf", path], { encoding: "utf8", env: listingEnv }),
    "Inventory must equal the tarball listing",
  )
  const identity = Object.fromEntries(
    (await readFile(join(dir, "identity.txt"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2)),
  )
  assert.equal(identity.source_sha, env.GITHUB_SHA, "Candidate source commit")
  assert.equal(identity.run_id, env.GITHUB_RUN_ID, "Candidate workflow run")
  for (const member of versionedMembers) {
    const json = JSON.parse(execFileSync("tar", ["-xOzf", path, member], { encoding: "utf8" }))
    assert.equal(json.version, version, `${member} version`)
  }
  return tarball
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && realpathSync(process.argv[1]) === self) {
  const [command, dir, extra] = process.argv.slice(2)
  if (command === "preflight" && dir === undefined) {
    console.log(`version=${await preflight(resolve(dirname(self), "../../.."), process.env)}`)
  } else if (command === "candidate" && dir && extra === undefined) {
    console.log(`tarball=${await checkCandidate(dir, process.env)}`)
  } else {
    console.error(
      "Usage: node packages/plugin/scripts/verify-release.mjs preflight | candidate <dir>",
    )
    process.exitCode = 2
  }
}
