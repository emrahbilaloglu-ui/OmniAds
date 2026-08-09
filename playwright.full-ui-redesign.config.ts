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
  // The truthful light matrix. 320 is the narrowest width the product claims to
  // support; the rest are the breakpoints the layout actually changes at.
  //
  // There are deliberately no dark projects. The stylesheet carries a `.dark`
  // variant, but nothing applies it: there is no theme toggle, no theme
  // provider, and no `prefers-color-scheme` rule, so Playwright's colorScheme
  // preference changes nothing and a "dark" run would render light while
  // claiming to prove dark. `visual-dark-mode.test.ts` asserts that absence, so
  // the day a real mechanism is added this matrix has to be revisited.
  { name: "full-ui-narrow", width: 320, height: 844, mobile: true },
  { name: "full-ui-tablet", width: 768, height: 1024, mobile: false },
  { name: "full-ui-compact", width: 1280, height: 900, mobile: false },
  { name: "full-ui-wide", width: 1728, height: 1000, mobile: false },
].map((project) => ({
  name: project.name,
  testMatch: /full-ui-redesign-smoke\.spec\.ts/,
  use: {
    ...(project.mobile ? devices["Pixel 5"] : devices["Desktop Chrome"]),
    viewport: { width: project.width, height: project.height },
    colorScheme: "light" as const,
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
