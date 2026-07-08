import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3107";
const port = new URL(baseURL).port || "3107";
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results/full-ui-redesign";
const reportDir = process.env.PLAYWRIGHT_REPORT_DIR ?? "playwright-report/full-ui-redesign";

export default defineConfig({
  testDir: "./playwright/tests",
  fullyParallel: false,
  workers: 1,
  timeout: 900_000,
  expect: {
    timeout: 20_000,
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: reportDir }],
  ],
  outputDir,
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "full-ui-desktop",
      testMatch: /full-ui-redesign-smoke\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "full-ui-mobile",
      testMatch: /full-ui-redesign-smoke\.spec\.ts/,
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: `./node_modules/.bin/next dev --webpack --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
