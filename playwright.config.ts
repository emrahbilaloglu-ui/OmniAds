import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
// Which env file the local server boots with.
//
// Defaults to `.env.local`, so every existing smoke behaves exactly as before.
// The zero-base local production smoke points this at a committed,
// credential-free file: it proves the production build boots and serves, which
// needs no secrets, and a gate that cannot run without a developer's personal
// `.env.local` is a gate CI can never hold.
const serverEnvFile = process.env.PLAYWRIGHT_SERVER_ENV_FILE ?? ".env.local";
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
      testMatch: /zero-base-(theme-flash|shell-responsive)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // WP-26: accessibility, zoom, reduced motion, keyboard and print run
      // against the generated harness, so they need no server or database.
      name: "zero-base-a11y-chromium",
      testMatch: /zero-base-a11y\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "zero-base-frames-chromium",
      testMatch: /zero-base-frames\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "zero-base-visual-chromium",
      testMatch: /zero-base-visual\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // The only stage that runs the real standalone server. Deliberately has
      // no auth-setup dependency: it must hold on a machine with no
      // credentials at all, which is the whole point of it.
      name: "zero-base-local-production-chromium",
      testMatch: /zero-base-local-production\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Vitals need the built server, so this project is run explicitly
      // against a running instance rather than as part of the harness sweep.
      name: "zero-base-perf-chromium",
      testMatch: /zero-base-perf\.spec\.ts/,
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
        command: `node --env-file=${serverEnvFile} scripts/start-local-smoke-server.mjs`,
        url: baseURL,
        reuseExistingServer,
        timeout: 180_000,
      }
    : undefined,
});
