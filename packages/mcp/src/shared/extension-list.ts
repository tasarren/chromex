import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { errorMessage } from "@chromex/protocol"
import { z } from "zod"
import { isErrno } from "./profile-lock.ts"

/** CDP `Extensions.ExtensionInfo`. */
export const UnpackedExtensionSchema = z.object({
  enabled: z.boolean(),
  id: z.string(),
  name: z.string(),
  path: z.string(),
  version: z.string(),
})

/** Answers of the Managed service extension methods. */
export const extensionResults = {
  extensionConfigure: z.object({
    installed: z.array(z.string()),
    skipped: z.array(z.string()),
  }),
  extensionInstall: z.object({
    id: z.string(),
    otherClients: z.array(z.string()),
    path: z.string(),
    reloaded: z.boolean(),
  }),
  extensionList: z.object({
    extensions: z.array(UnpackedExtensionSchema),
    listed: z.array(z.string()),
  }),
  extensionRemove: z.object({
    id: z.string().nullable(),
    otherClients: z.array(z.string()),
    path: z.string().nullable(),
  }),
}

/** Unpacked extension directories a profile loads at every launch. CDP installs do not persist. */
export class ExtensionList {
  readonly path: string

  constructor(profileDirectory: string) {
    // Chromium ignores unknown directories in its user-data-dir.
    this.path = join(profileDirectory, "Chromex", "extensions.json")
  }

  async read(): Promise<string[]> {
    try {
      return z.array(z.string()).parse(JSON.parse(await readFile(this.path, "utf8")))
    } catch(cause) {
      if (isErrno(cause, "ENOENT")) return []
      throw cause
    }
  }

  /** Listed directories that still hold a manifest; a moved or deleted one is skipped. */
  async present(): Promise<string[]> {
    const listed = await this.read()
    const found = await Promise.all(
      listed.map((directory) =>
        access(join(directory, "manifest.json")).then(() => true, () => false),
      ),
    )
    return listed.filter((_, index) => found[index])
  }

  /** Add directories not yet listed. Returns true when the file changed. */
  async add(...directories: string[]): Promise<boolean> {
    const listed = await this.read()
    const added = directories.filter((directory, index) =>
      !listed.includes(directory) && directories.indexOf(directory) === index)
    if (added.length === 0) return false
    await this.write([...listed, ...added])
    return true
  }

  async remove(directory: string): Promise<boolean> {
    const listed = await this.read()
    if (!listed.includes(directory)) return false
    await this.write(listed.filter((entry) => entry !== directory))
    return true
  }

  private async write(directories: string[]): Promise<void> {
    await mkdir(dirname(this.path), { mode: 0o700, recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(directories, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
  }
}

/**
 * A configured or agent-supplied directory that cannot be used at all: relative, missing, a symlink
 * loop, containing a comma, or without a manifest. Other filesystem errors are retryable.
 */
export class InvalidExtensionDirectory extends Error {
  override name = "InvalidExtensionDirectory"
}

/** Validate an agent- or user-supplied unpacked extension directory and return its real path. */
export async function resolveExtensionDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new InvalidExtensionDirectory(`Extension path must be absolute: ${path}`)
  let directory: string
  try {
    directory = await realpath(path)
  } catch(cause) {
    if (isErrno(cause, "ENOENT") || isErrno(cause, "ENOTDIR") || isErrno(cause, "ELOOP")) {
      throw new InvalidExtensionDirectory(`Extension directory is missing: ${path}`)
    }
    throw cause
  }
  // --load-extension separates directories with commas.
  if (directory.includes(",")) {
    throw new InvalidExtensionDirectory(`Extension path must not contain a comma: ${directory}`)
  }
  try {
    await access(join(directory, "manifest.json"))
  } catch(cause) {
    if (isErrno(cause, "ENOENT") || isErrno(cause, "ENOTDIR")) {
      throw new InvalidExtensionDirectory(`Extension directory has no manifest.json: ${directory}`)
    }
    throw cause
  }
  return directory
}

/** `--extension <dir>` values win over `CHROMEX_EXTENSIONS` (`:`-separated, like `PATH`). */
export function configuredExtensions(args: string[] | undefined, env: string | undefined): string[] {
  return args?.length ? args : (env ?? "").split(":").filter(Boolean)
}

/**
 * Resolve configured directories before the first browser launch. An invalid one is reported and
 * dropped; a transient filesystem error keeps the requested path, so the service retries it on the
 * next browser operation.
 */
export async function prepareConfiguredExtensions(
  paths: readonly string[],
  resolve: (path: string) => Promise<string>,
  report: (message: string) => void,
): Promise<string[]> {
  const prepared: string[] = []
  for (const path of new Set(paths)) {
    try {
      prepared.push(await resolve(path))
    } catch(cause) {
      if (cause instanceof InvalidExtensionDirectory) {
        report(`chromex: skipped extension ${path}: ${cause.message}`)
        continue
      }
      report(`chromex: extension setup failed, will retry: ${path}: ${errorMessage(cause)}`)
      prepared.push(path)
    }
  }
  return prepared
}

/** Side effects the configured-extension step needs; tests inject failures through them. */
export type ConfigureExtensionAdapters = {
  add: (path: string) => Promise<unknown>
  load: (path: string) => Promise<void>
  loaded: () => Promise<readonly string[]>
  resolve: (path: string) => Promise<string>
  /** Reports each confirmed mutation, so a later failure can name what already happened. */
  step?: (step: string) => void
}

/**
 * Validate configured directories without touching the browser. Callers reserve a profile fence
 * only after this succeeds, so a mistyped path cannot orphan a fence.
 */
export async function resolveConfiguredExtensions(
  paths: readonly string[],
  resolve: (path: string) => Promise<string>,
): Promise<{ ready: string[]; skipped: string[] }> {
  const ready: string[] = []
  const skipped: string[] = []
  for (const requested of new Set(paths)) {
    try {
      ready.push(await resolve(requested))
    } catch(cause) {
      if (!(cause instanceof InvalidExtensionDirectory)) throw cause
      skipped.push(requested)
    }
  }
  return { ready, skipped }
}

/**
 * Install already validated directories without reloading a loaded one. A CDP load or list-write
 * failure is thrown, so the caller retries the whole list; the write is attempted even for an
 * already loaded path, because a previous call may have loaded it and then failed to persist it.
 */
export async function installConfiguredExtensions(
  ready: readonly string[],
  adapters: ConfigureExtensionAdapters,
): Promise<{ installed: string[]; skipped: string[] }> {
  const loaded = new Set(await adapters.loaded())
  const installed: string[] = []
  for (const path of ready) {
    if (!loaded.has(path)) {
      await adapters.load(path)
      loaded.add(path)
      installed.push(path)
      adapters.step?.(`loaded ${path}`)
    }
    await adapters.add(path)
    adapters.step?.(`listed ${path}`)
  }
  return { installed, skipped: [] }
}

/**
 * Validate and then install configured directories. Invalid directories are reported as skipped.
 * Duplicate configured paths run once.
 */
export async function configureExtensionDirectories(
  paths: readonly string[],
  adapters: ConfigureExtensionAdapters,
): Promise<{ installed: string[]; skipped: string[] }> {
  const { ready, skipped } = await resolveConfiguredExtensions(paths, adapters.resolve)
  const installed = await installConfiguredExtensions(ready, adapters)
  return { installed: installed.installed, skipped }
}

/**
 * Install configured extensions through one serialized service call. On a transport or service
 * failure the paths are returned unchanged so the next browser operation retries them.
 */
export async function applyConfiguredExtensions(
  paths: readonly string[],
  configure: (paths: readonly string[]) => Promise<{ skipped: readonly string[] }>,
  report: (message: string) => void,
): Promise<readonly string[]> {
  try {
    const { skipped } = await configure(paths)
    for (const path of skipped) report(`chromex: skipped extension ${path}: not installed by Chromium`)
    return []
  } catch(cause) {
    report(`chromex: extension setup failed, will retry: ${errorMessage(cause)}`)
    return paths
  }
}
