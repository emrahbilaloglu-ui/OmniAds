import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3107";
const port = new URL(baseURL).port || "3107";
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results/full-ui-redesign";
const reportDir = process.env.PLAYWRIGHT_REPORT_DIR ?? "playwright-report/full-ui-redesign";
const extendedVisualMatrix = process.env.FULL_UI_SMOKE_EXTENDED === "1";

const baselineProjects = [
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
] as const;

const extendedProjects = [
  { name: "full-ui-mobile-dark", width: 390, height: 844, mobile: true, dark: true },
  { name: "full-ui-tablet", width: 768, height: 1024, mobile: false, dark: false },
  { name: "full-ui-tablet-dark", width: 768, height: 1024, mobile: false, dark: true },
  { name: "full-ui-compact", width: 1280, height: 900, mobile: false, dark: false },
  { name: "full-ui-compact-dark", width: 1280, height: 900, mobile: false, dark: true },
  { name: "full-ui-desktop-dark", width: 1440, height: 1000, mobile: false, dark: true },
  { name: "full-ui-wide", width: 1728, height: 1000, mobile: false, dark: false },
  { name: "full-ui-wide-dark", width: 1728, height: 1000, mobile: false, dark: true },
].map((project) => ({
  name: project.name,
  testMatch: /full-ui-redesign-smoke\.spec\.ts/,
  use: {
    ...(project.mobile ? devices["Pixel 5"] : devices["Desktop Chrome"]),
    viewport: { width: project.width, height: project.height },
    colorScheme: project.dark ? ("dark" as const) : ("light" as const),
  },
}));

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
  projects: extendedVisualMatrix
    ? [...baselineProjects, ...extendedProjects]
    : [...baselineProjects],
  webServer: {
    command: `./node_modules/.bin/next dev --webpack --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
