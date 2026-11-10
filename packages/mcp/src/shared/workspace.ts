import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"

/** One canonical project or worktree root and the storage key derived from it. */
export type Workspace = { readonly key: string; readonly root: string }

export type WorkspaceSources = {
  readonly claudeProjectDir?: string | undefined
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly explicit?: string | undefined
  readonly git?: string | undefined
  /** Canonical home directory, refused as a workspace. */
  readonly home?: string | undefined
}

type Classified = { readonly kind: "non-git" | "worktree"; readonly root: string }

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError"
}

const GIT_MS = 2_000
const GIT_BYTES = 16_384
const MARKER = "@workspace.json"
const MARKER_VERSION = 1

const FIX = "Start the server inside a Git worktree, or with --workspace <absolute-directory> in a project-scoped registration."

/**
 * Resolve the workspace once from trusted sources only. An explicit value never falls through, and
 * `CLAUDE_PROJECT_DIR` counts only when the process cwd resolves to the same root.
 */
export async function resolveWorkspace(sources: WorkspaceSources): Promise<Workspace> {
  const git = sources.git ?? "git"
  const explicit = sources.explicit === undefined ? undefined : (await classify(sources.explicit, sources.env, git)).root
  const cwd = await classify(sources.cwd, sources.env, git)
  const harness = sources.claudeProjectDir === undefined
    ? undefined
    : (await classify(sources.claudeProjectDir, sources.env, git)).root
  if (harness !== undefined && harness !== cwd.root) {
    throw new WorkspaceError(`CLAUDE_PROJECT_DIR ${harness} does not contain the server cwd. ${FIX}`)
  }
  if (explicit !== undefined && harness !== undefined && explicit !== harness) {
    throw new WorkspaceError(`--workspace ${explicit} conflicts with the harness project ${harness}`)
  }
  // An inherited registration (for example a parent directory's config) must not bind a nested worktree.
  if (explicit !== undefined && cwd.kind === "worktree" && cwd.root !== explicit) {
    throw new WorkspaceError(`--workspace ${explicit} differs from the server's Git worktree ${cwd.root}`)
  }
  // OpenCode starts one server per session with the project as cwd (ISS-01); a non-Git cwd stays refused.
  const root = explicit ?? harness ?? (cwd.kind === "worktree" ? cwd.root : undefined)
  if (root === undefined) throw new WorkspaceError(`No trusted workspace for a Managed profile. ${FIX}`)
  if (root === dirname(root) || (sources.home !== undefined && root === sources.home)) {
    throw new WorkspaceError(`${root} is too broad to be a workspace. ${FIX}`)
  }
  return { key: workspaceKey(root), root }
}

/** The hash is the identity; the basename prefix only makes directories readable. */
export function workspaceKey(root: string): string {
  const label = basename(root).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "root"
  return `${label}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`
}

/** Canonical containing worktree root, or the exact directory when no Git boundary exists. */
export async function classify(input: string, base: NodeJS.ProcessEnv, git = "git"): Promise<Classified> {
  if (!isAbsolute(input) || input.includes("\0")) throw new WorkspaceError(`Workspace must be an absolute directory: ${input}`)
  const directory = await realpath(input).catch((error: unknown) => {
    throw new WorkspaceError(`Workspace is not available: ${input} (${code(error)})`)
  })
  const info = await stat(directory).catch((error: unknown) => {
    throw new WorkspaceError(`Workspace is not readable: ${directory} (${code(error)})`)
  })
  if (!info.isDirectory()) throw new WorkspaceError(`Workspace is not a directory: ${directory}`)
  await access(directory, constants.R_OK | constants.X_OK).catch((error: unknown) => {
    throw new WorkspaceError(`Workspace is not readable: ${directory} (${code(error)})`)
  })
  const env = { ...base }
  const run = (...args: string[]) => native(git, args, directory, env)
  clearRepositoryEnvironment(env, await run("rev-parse", "--local-env-vars"))
  for (let boundary = directory; ; boundary = dirname(boundary)) {
    const dotgit = join(boundary, ".git")
    if (await entry(dotgit)) {
      await run("rev-parse", "--resolve-git-dir", dotgit)
      break
    }
    if (await metadataDirectory(boundary)) throw new WorkspaceError(`Git metadata directory is not a workspace: ${boundary}`)
    if (dirname(boundary) === boundary) return { kind: "non-git", root: directory }
  }
  const reply = await run("rev-parse", "--is-inside-work-tree", "--is-bare-repository", "--is-inside-git-dir",
    "--path-format=absolute", "--show-toplevel")
  const flags = "true\nfalse\nfalse\n"
  if (!reply.startsWith(flags) || !reply.endsWith("\n")) throw new WorkspaceError(`Not inside a Git worktree: ${directory}`)
  const root = await realpath(reply.slice(flags.length, -1)).catch((error: unknown) => {
    throw new WorkspaceError(`Git worktree root is not readable: ${reply.trim()} (${code(error)})`)
  })
  const child = relative(root, directory)
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new WorkspaceError(`Git worktree ${root} does not contain ${directory}`)
  }
  return { kind: "worktree", root }
}

function native(git: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(git, args, { cwd, encoding: "buffer", env, killSignal: "SIGKILL", maxBuffer: GIT_BYTES, timeout: GIT_MS },
      (error, stdout) => {
        if (error) {
          reject(new WorkspaceError(`Git refused ${args[0]} ${args[1] ?? ""} in ${cwd} (${code(error)}); fix the repository or Git setup`))
          return
        }
        try {
          resolve(new TextDecoder("utf-8", { fatal: true }).decode(stdout))
        } catch {
          reject(new WorkspaceError(`Git returned a non-UTF-8 reply in ${cwd}`))
        }
      })
  })
}

function clearRepositoryEnvironment(env: NodeJS.ProcessEnv, names: string): void {
  if (!/^(GIT_[A-Z0-9_]+\n)+$/.test(names)) throw new WorkspaceError("Git returned an invalid environment list")
  for (const name of [...names.slice(0, -1).split("\n"), "GIT_CEILING_DIRECTORIES", "GIT_NAMESPACE", "GIT_REFERENCE_BACKEND"]) {
    Reflect.deleteProperty(env, name)
  }
  Object.assign(env, { GIT_DISCOVERY_ACROSS_FILESYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" })
}

async function metadataDirectory(boundary: string): Promise<boolean> {
  const at = async(name: string, folder: boolean) => {
    const found = await entry(join(boundary, name))
    return !!found && (found.isSymbolicLink() || (folder ? found.isDirectory() : found.isFile()))
  }
  const [head, objects, refs, config, common, back] = await Promise.all([
    at("HEAD", false), at("objects", true), at("refs", true), at("config", false), at("commondir", false), at("gitdir", false),
  ])
  return (head && objects && refs) || (config && Number(head) + Number(objects) + Number(refs) >= 2) || (common && (head || back))
}

async function entry(path: string) {
  try {
    return await lstat(path)
  } catch(error) {
    if (code(error) === "ENOENT") return undefined
    throw error
  }
}

function code(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : String(error)
}

/** Where one workspace keeps its profiles, locks and service descriptors. */
export type WorkspaceStorage = { readonly locks: string; readonly profiles: string; readonly services: string }

/**
 * Open this workspace's storage under `chromex/workspaces/<key>`, a namespace disjoint from the
 * legacy `chromex/profiles`, `locks` and `services` trees, so no earlier data can collide with it.
 * Call it before any other write for the workspace: only its creator publishes the marker, and an
 * existing directory must carry an exactly matching marker. Unknown contents are never adopted.
 * Concurrent first starts agree: the container appears only with its marker.
 */
export async function workspaceStorage(workspace: Workspace, dataHome: string): Promise<WorkspaceStorage> {
  const container = await workspaceContainer(workspace, join(dataHome, "chromex/workspaces"))
  return { locks: join(container, "locks"), profiles: join(container, "profiles"), services: join(container, "services") }
}

/**
 * Publish a new container with its marker already inside: the marker is written into a private
 * staging directory that is renamed into place, so no starter can see the container unmarked.
 * A concurrent creator's rename fails on the now non-empty container and that caller reads its
 * marker instead. ponytail: an empty directory created by hand between the check and the rename
 * is replaced; it holds no data. Use renameat2(RENAME_NOREPLACE) if Node ever exposes it.
 */
async function workspaceContainer(workspace: Workspace, workspaces: string): Promise<string> {
  const container = join(workspaces, workspace.key)
  await mkdir(workspaces, { mode: 0o700, recursive: true })
  if (await entry(container)) {
    await requireMarker(container, workspace)
    return container
  }
  const staging = join(workspaces, `.${workspace.key}.${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  try {
    await writeFile(join(staging, MARKER), `${JSON.stringify({ root: workspace.root, version: MARKER_VERSION })}\n`, { flag: "wx", mode: 0o600 })
    await rename(staging, container)
  } catch(error) {
    await rm(staging, { force: true, recursive: true })
    if (!["EEXIST", "ENOTEMPTY"].includes(code(error))) throw error
    await requireMarker(container, workspace)
  }
  return container
}

/**
 * Read the marker of an existing container. Only an exact root and version match is accepted, so a
 * container Chromex did not create is never adopted. A container is published with its marker, so a
 * missing marker means foreign or damaged contents that need manual inspection.
 */
async function requireMarker(container: string, workspace: Workspace): Promise<void> {
  const refuse = (reason: string) => new WorkspaceError(`Refusing profile container ${container}: ${reason}; inspect it manually`)
  const text = await readFile(join(container, MARKER), "utf8").catch((error: unknown) => {
    throw refuse(code(error) === "ENOENT" ? "no workspace marker" : `unreadable marker (${code(error)})`)
  })
  let marker: unknown
  try {
    marker = JSON.parse(text)
  } catch {
    throw refuse("malformed marker")
  }
  const { root, version } = (marker ?? {}) as { root?: unknown; version?: unknown }
  if (version !== MARKER_VERSION) throw refuse("unknown marker version")
  if (root !== workspace.root) throw refuse(`marker belongs to ${String(root)}`)
}
