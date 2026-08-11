import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const useWebServer = process.env.PLAYWRIGHT_USE_WEBSERVER !== "0";
const reuseExistingServer =
  process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1"
    ? true
    : process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "0"
      ? false
      : !process.env.CI;

export default defineConfig({
  testDir: "./playwright/tests",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  reporter: [
    ["list"],
    ["html", { open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "setup",
      testMatch: /(^|\/)auth\.setup\.ts$/,
    },
    {
      name: "commercial-setup",
      testMatch: /(^|\/)commercial-auth\.setup\.ts$/,
    },
    {
      name: "smoke-chromium",
      testMatch: /reviewer-smoke\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/reviewer.json",
      },
      dependencies: ["setup"],
    },
    {
      // The shell itself: public header and authenticated navigation, on
      // desktop and mobile. Runs against the SAME reviewer fixture as the
      // reviewer smoke, so it needs no credentials of its own.
      name: "shell-smoke-chromium",
      testMatch: /app-shell-smoke\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/reviewer.json",
      },
      dependencies: ["setup"],
    },
    {
      // Zero-base theme first paint. Serves the shipped CSS and no-flash script
      // from an intercepted route, so it needs no server, no database and no
      // auth fixture — and therefore no `setup` dependency.
      name: "zero-base-theme-chromium",
      testMatch: /zero-base-theme-flash\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "commercial-smoke-chromium",
      testMatch: /commercial-truth-smoke\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "playwright/.auth/commercial-operator.json",
      },
      dependencies: ["commercial-setup"],
    },
  ],
  webServer: useWebServer
    ? {
        command:
          "node --env-file=.env.local scripts/start-local-smoke-server.mjs",
        url: baseURL,
        reuseExistingServer,
        timeout: 180_000,
      }
    : undefined,
});
