import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { bridgePolicyPath } from "../shared/paths.js";

type StoredPolicy = { allowedOrigins: string[] };

export function normalizeOrigin(value: string): string {
  if (value === "about:blank") return value;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) origins can be allowed");
  }
  return url.origin;
}

export function isLocalOrigin(origin: string): boolean {
  if (origin === "about:blank") return true;
  const url = new URL(origin);
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export class OriginPolicy {
  private persistent = new Set<string>();
  private session = new Set<string>();

  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(bridgePolicyPath(), "utf8")) as StoredPolicy;
      this.persistent = new Set(stored.allowedOrigins.map(normalizeOrigin));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  isAllowed(value: string): boolean {
    try {
      const origin = normalizeOrigin(value);
      return isLocalOrigin(origin) || this.session.has(origin) || this.persistent.has(origin);
    } catch {
      return false;
    }
  }

  async allow(value: string, persist: boolean): Promise<string> {
    const origin = normalizeOrigin(value);
    (persist ? this.persistent : this.session).add(origin);
    if (persist) await this.save();
    return origin;
  }

  async revoke(value: string): Promise<string> {
    const origin = normalizeOrigin(value);
    this.session.delete(origin);
    if (this.persistent.delete(origin)) await this.save();
    return origin;
  }

  list(): string[] {
    return [...new Set([...this.persistent, ...this.session])].sort();
  }

  assertAllowed(value: string): string {
    const origin = normalizeOrigin(value);
    if (!this.isAllowed(origin)) {
      throw new Error(`Origin ${origin} is not allowed. Use chrome_allow_origin first.`);
    }
    return origin;
  }

  private async save(): Promise<void> {
    const path = bridgePolicyPath();
    const temporary = `${path}.${process.pid}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(
      temporary,
      `${JSON.stringify({ allowedOrigins: [...this.persistent].sort() }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    await rename(temporary, path);
    await chmod(path, 0o600);
  }
}
