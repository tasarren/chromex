import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

// The browser project uses the system Chromium, the same one Managed runs, not a Playwright download.
const executablePath = process.env.CHROMEX_BROWSER ?? "/usr/bin/chromium"
// A capability-less CI container cannot start the Chromium sandbox; only this test-owned browser skips it.
const args = process.env.CI && process.env.CHROMEX_HEADLESS === "1" ? ["--no-sandbox"] : []

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/*/test/unit/**/*.test.ts"] } },
      {
        test: {
          name: "e2e",
          include: ["packages/*/test/e2e/**/*.test.ts"],
          globalSetup: ["packages/mcp/test/e2e/setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "browser",
          include: ["packages/*/test/browser/**/*.test.ts"],
          api: { host: "127.0.0.1" },
          browser: {
            enabled: true,
            provider: playwright({ launchOptions: { args, executablePath } }),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
})
