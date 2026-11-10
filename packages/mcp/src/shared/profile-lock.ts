import { randomUUID } from "node:crypto"
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"

const LockOwnerSchema = z.object({ pid: z.number().int(), sessionId: z.string() })
export type LockOwner = z.infer<typeof LockOwnerSchema>

/** How long a release waits for another process's short guarded removal. */
const GUARD_WAIT_MS = 2_000

/**
 * Take the profile lock for one session. The returned function releases it only while this session
 * still owns it.
 *
 * The lock is the file `<lockPath>.owner` holding its owner, published with `link`, which never
 * replaces an existing path (file, directory or anything else). Every removal, by its owner's release
 * or of a dead owner's lock, holds `<lockPath>.owner.takeover`, published the same way, from the owner
 * check to the unlink.
 * Nothing else removes a lock, so a checked owner cannot change before its removal. Anything that is
 * not a readable owner file, at the lock or at the guard, is ambiguous: it is refused, never removed.
 */
export async function acquireProfileLock(
  lockPath: string,
  sessionId: string,
  pid: number,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { mode: 0o700, recursive: true })
  // Earlier candidate builds used a directory at `lockPath` and remove ownerless or aged entries
  // there recursively, so this format lives at its own path, which they never touch. While one of
  // their directories exists, refuse. ponytail: the two formats do not exclude each other, so an
  // earlier build that takes its lock after this check is not refused; stop earlier builds first.
  if ((await readLockOwner(lockPath)) !== undefined) {
    throw new Error(
      `An earlier Chromex build holds ${lockPath}; Chromex never removes it automatically. ` +
        "Stop that build or use another profile name",
    )
  }
  const held = `${lockPath}.owner`
  const self = { pid, sessionId }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await publish(held, self)) {
      // Single flight: concurrent and later calls share one removal, so none of them can run after
      // the next owner published. A failed removal is forgotten so the caller can retry it.
      let released: Promise<void> | undefined
      return () =>
        (released ??= removeIfOwner(held, self, self, GUARD_WAIT_MS).catch((cause: unknown) => {
          released = undefined
          throw cause
        }))
    }
    const current = await readLockOwner(held)
    if (current === undefined) continue
    if (current === null) throw ambiguous(held)
    if (isPidAlive(current.pid)) {
      throw new Error("This managed profile is active; choose another profile name")
    }
    await removeIfOwner(held, current, self, 0)
  }
  throw new Error("This managed profile is active; retry shortly")
}

/** In-process removals of one guard run one at a time, so this process knows which guard is in flight. */
const localRemovals = new Map<string, Promise<void>>()
/** Guards this process published and failed to unlink, with the owner they hold. */
const leftGuards = new Map<string, LockOwner>()

/**
 * Under the guard, unlink `lockPath` only if it still names `expected`; a dead `expected` must
 * still be dead. A release or takeover that finds another owner leaves it untouched.
 */
async function removeIfOwner(lockPath: string, expected: LockOwner, self: LockOwner, waitMs: number): Promise<void> {
  const guard = `${lockPath}.takeover`
  const removal = (localRemovals.get(guard) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => removeGuarded(lockPath, guard, expected, self, waitMs))
  localRemovals.set(guard, removal)
  try {
    await removal
  } finally {
    if (localRemovals.get(guard) === removal) localRemovals.delete(guard)
  }
}

async function removeGuarded(
  lockPath: string,
  guard: string,
  expected: LockOwner,
  self: LockOwner,
  waitMs: number,
): Promise<void> {
  const deadline = Date.now() + waitMs
  // The guard's actual owner: `self` when this removal published it, the recorded owner when adopted.
  // A recorded owner can be stale (an unlink that reported failure after removing the guard), so a
  // freshly published guard always records `self`.
  let owner = self
  while (!(await publish(guard, self))) {
    const holder = await readLockOwner(guard)
    if (holder === undefined) continue
    // A guard this process left when its unlink failed is adopted; it is recorded with its exact
    // owner, and removals of one guard run one at a time here. Any other guard is never taken.
    const left = leftGuards.get(guard)
    if (holder && left && holder.pid === left.pid && holder.sessionId === left.sessionId) {
      owner = left
      break
    }
    if (holder === null || !isPidAlive(holder.pid)) {
      throw new Error(
        `A profile lock removal did not finish (${guard}); Chromex never removes it automatically. ` +
          "Use another profile name and report this state",
      )
    }
    if (Date.now() >= deadline) throw new Error("This managed profile is active; retry shortly")
    await delay(20)
  }
  let failure: Error | undefined
  try {
    const current = await readLockOwner(lockPath)
    const same = current?.sessionId === expected.sessionId && current.pid === expected.pid
    const removable = expected.sessionId === self.sessionId || !isPidAlive(expected.pid)
    if (same && removable) await unlinkMissingOk(lockPath)
  } catch(cause) {
    failure = asError(cause)
  }
  // Nothing else removes this guard, so it is still ours. A failed unlink is recorded so the next
  // removal in this process adopts it; both failures reach the caller.
  try {
    await unlinkMissingOk(guard)
    leftGuards.delete(guard)
  } catch(cause) {
    leftGuards.set(guard, owner)
    if (failure === undefined) throw cause
    throw new AggregateError([failure, cause], `${failure.message}; the removal guard ${guard} also stayed`, {
      cause,
    })
  }
  if (failure !== undefined) throw failure
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}


/** Publish `path` holding `owner`. False when anything already exists at `path`. */
async function publish(path: string, owner: LockOwner): Promise<boolean> {
  const staged = join(dirname(path), `.${basename(path)}.${randomUUID()}`)
  await writeFile(staged, JSON.stringify(owner), { flag: "wx", mode: 0o600 })
  let published: boolean
  try {
    await link(staged, path)
    published = true
  } catch(cause) {
    if (!isErrno(cause, "EEXIST")) {
      await unlink(staged).catch(() => undefined)
      throw cause
    }
    published = false
  }
  // The outcome is the link's. A staged file that cannot be removed stays: it is dot-named and
  // nothing reads it as a lock.
  await unlink(staged).catch(() => undefined)
  return published
}

async function unlinkMissingOk(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch(cause) {
    if (!isErrno(cause, "ENOENT")) throw cause
  }
}

function ambiguous(lockPath: string): Error {
  return new Error(
    `The profile lock ${lockPath} has no readable owner; Chromex never removes it automatically. ` +
      "Use another profile name and report this state",
  )
}

/**
 * The lock owner; undefined when nothing is at the path, null when something is there that is not a
 * readable owner file (a directory, empty, malformed or wrong-shape content).
 */
export async function readLockOwner(lockPath: string): Promise<LockOwner | null | undefined> {
  let text: string
  try {
    text = await readFile(lockPath, "utf8")
  } catch(cause) {
    if (isErrno(cause, "ENOENT")) return undefined
    if (isErrno(cause, "EISDIR")) return null
    throw cause
  }
  try {
    const owner = LockOwnerSchema.safeParse(JSON.parse(text))
    return owner.success ? owner.data : null
  } catch {
    return null
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch(cause) {
    return isErrno(cause, "EPERM")
  }
}

export function isErrno(cause: unknown, ...codes: string[]): boolean {
  return cause instanceof Error && "code" in cause && codes.includes(String(cause.code))
}
