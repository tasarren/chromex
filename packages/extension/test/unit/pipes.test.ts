import { expect, test } from "vitest"
import type { BackgroundSelection, PipeInput } from "../../src/bridge/params.ts"
import { PipeAdmissions } from "../../src/bridge/pipes.ts"

function admissions(leaseHeld = true) {
  const stored: Record<string, unknown> = {}
  const finished: (BackgroundSelection | null)[] = []
  const pipes = new PipeAdmissions({
    assertSettled: () => {},
    blockRecovery: () => {},
    leases: new Map(leaseHeld ? [[7, "client"]] : []),
    storage: {
      get: async(keys) => {
        const list = typeof keys === "string" ? [keys] : keys
        return Object.fromEntries(list.map((key) => [key, stored[key]]))
      },
      set: async(items) => { Object.assign(stored, items) },
    },
    targets: async() => [{ attached: true, id: "target", tabId: 7 }],
    background: {
      addHelper: () => {},
      beginBackgroundInput: async() => null,
      finishBackgroundInput: async(state) => { finished.push(state) },
    },
  })
  return { pipes, stored, finished }
}

function reservation(): PipeInput {
  return {
    aborted: false,
    client: "client",
    executor: null,
    kind: "cdp",
    operation: { commands: [] },
    phase: "reserved",
    profileOperation: null,
    selection: null,
    tabId: 7,
  }
}

test("admitted pipe input holds the fence until its executor ends it", async() => {
  const { pipes, stored } = admissions()
  pipes.reserve("token", reservation())

  expect(await pipes.beginPipeInput("token", "client"))
    .toEqual({ kind: "cdp", operation: { commands: [] }, targetId: "target" })
  expect(pipes.fenceValue).not.toBeNull()
  expect(pipes.hasInput()).toBe(true)
  expect(stored).toHaveProperty("bridgeAdmittedPipeInput")

  expect(await pipes.endPipeInput("token", "client")).toEqual({})
  expect(pipes.fenceValue).toBeNull()
  expect(pipes.hasInput()).toBe(false)
  expect(stored).toHaveProperty("bridgeAdmittedPipeInput", null)
})

test("an executor lost during admission aborts it and releases the fence", async() => {
  const { pipes } = admissions()
  pipes.reserve("token", reservation())

  const started = pipes.beginPipeInput("token", "client")
  expect(pipes.abandon("client")).toBe("starting")
  await expect(started).rejects.toThrow("Pipe input executor was lost during admission")
  expect(pipes.fenceValue).toBeNull()
  expect(pipes.hasInput()).toBe(false)
})

test("a reservation that never began cannot outlive its owner", async() => {
  const { pipes } = admissions()
  pipes.reserve("token", reservation())

  pipes.dropReserved("client")

  expect(pipes.size).toBe(0)
  await expect(pipes.beginPipeInput("token", "client"))
    .rejects.toThrow("Pipe input is not reserved, already began, or its tab was released")
})
