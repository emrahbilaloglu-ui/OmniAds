/**
 * WP-26 step 10 / gate G11 — vitals on representative leaves.
 *
 * Measured against the built server over HTTP with the browser's own
 * PerformanceObserver, so LCP and CLS are the values the browser reports rather
 * than a proxy derived from the network waterfall.
 *
 * Scope is stated rather than implied. Leaves behind a session cannot be
 * measured without seeded fixtures; they are listed as unmeasured. An average
 * taken over only the cheap public pages would read like whole-product evidence
 * and would be worse than reporting the gap.
 */
import { test, expect } from "@playwright/test";

import {
  CLS_BUDGET,
  FIRST_LOAD_API_CALL_BUDGET,
  LCP_BUDGET_MS,
  TBT_BUDGET_MS,
} from "../../lib/zero-base/performance-budgets";

const BASE = process.env.ZERO_BASE_SMOKE_URL?.trim() || "http://127.0.0.1:3000";

/**
 * Representative reachable leaves.
 *
 * The marketing root and product pages are the heaviest public compositions,
 * and login is the entry point every authenticated session passes through.
 */
const MEASURABLE = [
  { leaf: "L-PUB-ROOT", url: "/" },
  { leaf: "L-PUB-PRODUCT", url: "/product" },
  { leaf: "L-PUB-PRICING", url: "/pricing" },
  { leaf: "L-AUTH-LOGIN", url: "/login" },
];

interface Vitals {
  lcp: number;
  cls: number;
  tbt: number;
  jsBytes: number;
}

async function measure(page: import("@playwright/test").Page, url: string): Promise<Vitals> {
  let jsBytes = 0;
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (type === "script") {
      const length = Number(response.headers()["content-length"] ?? 0);
      if (Number.isFinite(length)) jsBytes += length;
    }
  });

  // `domcontentloaded` plus an explicit settle, not `networkidle`.
  // networkidle never fired on /login here — the page issues 33 static
  // requests including ten font files and a keep-alive connection outlives the
  // idle window. That was a defect in this harness, not in the page: Playwright
  // discourages networkidle precisely because it is not a rendering signal.
  await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });

  return page.evaluate(async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

    let lcp = 0;
    let cls = 0;
    let tbt = 0;

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) lcp = Math.max(lcp, entry.startTime);
    }).observe({ type: "largest-contentful-paint", buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
        if (!shift.hadRecentInput) cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });

    // TBT: time past 50 ms in each long task, which is what blocks input.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tbt += Math.max(0, entry.duration - 50);
    }).observe({ type: "longtask", buffered: true });

    await settle();
    return { lcp, cls, tbt, jsBytes: 0 };
  }).then((vitals) => ({ ...vitals, jsBytes }));
}

test.describe("G11 vitals on representative leaves", () => {
  for (const target of MEASURABLE) {
    test(`${target.leaf} (${target.url}) is within the plan's budgets`, async ({ page }) => {
      const vitals = await measure(page, target.url);

      // Reported before asserting, so a failure carries its measurement.
      console.log(
        `${target.leaf.padEnd(16)} LCP ${vitals.lcp.toFixed(0)}ms  CLS ${vitals.cls.toFixed(3)}  ` +
          `TBT ${vitals.tbt.toFixed(0)}ms  JS ${(vitals.jsBytes / 1024).toFixed(1)}KB`,
      );

      expect(vitals.lcp, `${target.leaf} LCP`).toBeLessThanOrEqual(LCP_BUDGET_MS);
      expect(vitals.cls, `${target.leaf} CLS`).toBeLessThanOrEqual(CLS_BUDGET);
      expect(vitals.tbt, `${target.leaf} TBT`).toBeLessThanOrEqual(TBT_BUDGET_MS);
    });
  }

  test("no page issues an unbounded request fan-out on first load", async ({ page }) => {
    // The "no unbounded N+1" half of G11. A first load that fires dozens of
    // API calls is the query waterfall the step asks to remove.
    for (const target of MEASURABLE) {
      const apiCalls: string[] = [];
      const listener = (request: import("@playwright/test").Request) => {
        const url = request.url();
        if (url.includes("/api/")) apiCalls.push(url);
      };
      page.on("request", listener);
      await page.goto(`${BASE}${target.url}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);
      page.off("request", listener);

      console.log(`${target.leaf.padEnd(16)} ${apiCalls.length} API request(s) on first load`);
      expect(apiCalls.length, `${target.leaf} fans out to ${apiCalls.length} API calls`).toBeLessThanOrEqual(FIRST_LOAD_API_CALL_BUDGET);
    }
  });
});
