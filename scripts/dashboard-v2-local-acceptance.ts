import { chromium } from "@playwright/test";

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const routes = [
  "/overview",
  "/platforms/meta",
  "/platforms/meta/creatives",
  "/platforms/meta/launchpad",
  "/platforms/meta/automation",
  "/platforms/google",
  "/platforms/google/advisor",
  "/platforms/google/search",
  "/platforms/google/products",
  "/platforms/google/assets",
  "/platforms/google/plan",
  "/insights",
  "/reports",
  "/commercial-truth",
  "/integrations",
  "/team",
  "/settings",
] as const;

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function main() {
const browser = await chromium.launch({ headless: true });
let failures = 0;

for (const viewport of viewports) {
  const context = await browser.newContext({
    storageState: "playwright/.auth/reviewer.json",
    viewport,
  });

  for (const route of routes) {
    const page = await context.newPage();
    const runtimeErrors: string[] = [];
    const failedReads: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400 && response.url().includes("/api/")) {
        failedReads.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });

    const response = await page.goto(`${baseUrl}${route}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page
      .waitForFunction(
        () => Boolean(document.querySelector("h1")) || location.pathname !== new URL(location.href).pathname,
        undefined,
        { timeout: 15_000 },
      )
      .catch(() => undefined);
    // Desktop carries the full data workspace; let its parallel reads settle so
    // failed API responses are observed instead of being aborted by page close.
    // Mobile is deliberately read-only and has a much smaller request surface.
    await page.waitForTimeout(viewport.name === "desktop" ? 6_000 : 1_200);

    const result = await page.evaluate(() => {
      const main = document.querySelector("main") ?? document.body;
      const text = (main.textContent ?? "").replace(/\s+/g, " ").trim();
      const heading = document.querySelector("h1")?.textContent?.trim() ?? "—";
      return {
        heading,
        textLength: text.length,
        textSample: text.slice(0, 120),
        pathname: location.pathname,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        loginRedirect: location.pathname === "/login",
      };
    });

    const failed =
      !response?.ok() ||
      result.loginRedirect ||
      result.textLength < 80 ||
      runtimeErrors.length > 0 ||
      failedReads.length > 0 ||
      (viewport.name === "mobile" && result.horizontalOverflow);
    if (failed) failures += 1;

    console.log(
      JSON.stringify({
        viewport: viewport.name,
        route,
        status: response?.status() ?? null,
        ...result,
        runtimeErrors,
        failedReads: Array.from(new Set(failedReads)),
        pass: !failed,
      }),
    );
    await page.close();
  }

  await context.close();
}

await browser.close();
if (failures > 0) process.exitCode = 1;
}

void main();
