// Serves development-only fixture pages on loopback. Not part of any build or package.
import { readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const fixtureRoot = fileURLToPath(new URL("./", import.meta.url))

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
}

// Fixed allowlist: the server never maps a request path onto the filesystem.
const files = new Map([
  ["/", "pointer/index.html"],
  ["/index.html", "pointer/index.html"],
  ["/frame.html", "pointer/frame.html"],
  ["/pointer.mjs", "pointer/pointer.mjs"],
  ["/model.mjs", "pointer/model.mjs"],
  ["/pages/form.html", "pages/form.html"],
  ["/pages/read.html", "pages/read.html"],
  ["/pages/storage.html", "pages/storage.html"],
  ["/pages/scroll.html", "pages/scroll.html"],
  ["/pages/hover.html", "pages/hover.html"],
  ["/pages/wait.html", "pages/wait.html"],
  ["/pages/errors.html", "pages/errors.html"],
  ["/pages/screenshot.html", "pages/screenshot.html"],
  ["/pages/second.html", "pages/second.html"],
])

export type FixtureServer = {
  readonly url: string
  readonly crossSiteUrl: string
  readonly port: number
  readonly stacks: readonly string[]
  close(): Promise<void>
}

function fail(res: import("node:http").ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message)
}

/** Resolve a request to an allowlisted file name, or an HTTP status for the refusal. */
export function routeRequest(method: string | undefined, url: string | undefined): { status: number; name?: string } {
  if (method !== "GET") return { status: 405 }
  let pathname: string
  try {
    pathname = new URL(url ?? "/", "http://fixture.invalid").pathname
  } catch {
    return { status: 400 }
  }
  const name = files.get(pathname)
  return name === undefined ? { status: 404 } : { status: 200, name }
}

function listenOn(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const route = routeRequest(req.method, req.url)
      if (route.status !== 200 || route.name === undefined) {
        fail(res, route.status, "refused")
        return
      }
      void readFile(join(fixtureRoot, route.name)).then(
        (body) => {
          res.writeHead(200, {
            "cache-control": "no-store",
            "content-type": contentTypes[extname(route.name ?? "")] ?? "application/octet-stream",
          }).end(body)
        },
        () => { fail(res, 500, "fixture file unavailable") },
      )
    })
    server.once("error", reject)
    server.listen(port, host, () => { resolve(server) })
  })
}

/**
 * Start the fixture server on 127.0.0.1, and on ::1 with the same port when IPv6 loopback exists, so
 * `localhost` reaches it on either stack. Port 0 picks a free port. Resolves once listening.
 */
export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const servers = [await listenOn("127.0.0.1", port)]
  const address = servers[0]?.address()
  if (address === null || address === undefined || typeof address === "string") {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
    throw new Error("fixture server bound without a TCP port")
  }
  const actual = address.port
  const stacks = ["127.0.0.1"]
  try {
    servers.push(await listenOn("::1", actual))
    stacks.push("::1")
  } catch(cause) {
    // No IPv6 loopback on this host; `localhost` then resolves to 127.0.0.1 only.
    const code = (cause as NodeJS.ErrnoException).code
    if (code !== "EADDRNOTAVAIL" && code !== "EAFNOSUPPORT") {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
      throw cause
    }
  }
  return {
    url: `http://127.0.0.1:${actual}/`,
    crossSiteUrl: `http://localhost:${actual}/`,
    port: actual,
    stacks,
    close: () => Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }))).then(() => undefined),
  }
}

export async function serveFixture(port = 0): Promise<FixtureServer> {
  return await startFixtureServer(port)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await serveFixture(Number(process.env.POINTER_FIXTURE_PORT ?? 5174))
  process.stdout.write(`fixture: ${fixture.url} (cross-site ${fixture.crossSiteUrl}, stacks ${fixture.stacks.join(", ")})\n`)
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void fixture.close().then(() => { process.exit(0) }) })
}
