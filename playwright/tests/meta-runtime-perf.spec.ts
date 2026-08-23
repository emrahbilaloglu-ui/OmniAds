/**
 * WP17 performance, on the mounted Meta routes.
 *
 * `zero-base-perf.spec.ts` measures the public marketing pages and, when a role
 * seed exists, a set of authenticated leaves. Neither list is the Meta package,
 * and the plan's G11 budgets have never been measured on a Meta surface at all.
 *
 * The budgets are the plan's own — LCP ≤ 2.5 s, CLS ≤ 0.1, TBT ≤ 300 ms, no
 * unbounded first-load fan-out. What is added here is the duplicate check: the
 * same API URL requested more than once on a single load is the N+1 the plan
 * names, and a count alone hides it.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

import {
  CLS_BUDGET,
  FIRST_LOAD_API_CALL_BUDGET,
  FIRST_LOAD_API_CALL_DEBT,
  KNOWN_DUPLICATE_FIRST_LOAD_READS,
  LCP_BUDGET_MS,
  TBT_BUDGET_MS,
} from "../../lib/zero-base/performance-budgets";
import { canonicalRoutesFor, runtimeHandle } from "../helpers/meta-runtime";

const handle = runtimeHandle();
const routes = canonicalRoutesFor(handle.businesses.oneAccount);

interface Measurement {
  lcp: number;
  cls: number;
  tbt: number;
  apiCalls: string[];
  requests: number;
}

async function measure(page: Page, path: string): Promise<Measurement> {
  const apiCalls: string[] = [];
  let requests = 0;
  const listener = (request: Request) => {
    requests += 1;
    const url = request.url();
    if (url.includes("/api/")) apiCalls.push(url.replace(handle.baseUrl, ""));
  };
  page.on("request", listener);

  // `domcontentloaded` plus an explicit settle rather than `networkidle`: these
  // surfaces poll, so idle never arrives and the wait would be the timeout.
  await page.goto(`${handle.baseUrl}${path}`, { waitUntil: "domcontentloaded" });
  const vitals = await page.evaluate(async () => {
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
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tbt += Math.max(0, entry.duration - 50);
    }).observe({ type: "longtask", buffered: true });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return { lcp, cls, tbt };
  });
  page.off("request", listener);
  return { ...vitals, apiCalls, requests };
}

test.describe("G11 vitals on the mounted Meta surfaces", () => {
  for (const route of routes) {
    test(`${route.surfaceId} is within the plan's budgets`, async ({ page }) => {
      const measured = await measure(page, route.path);
      // Reported before asserting, so a failure carries its measurement and a
      // pass is a number rather than a tick.
      console.log(
        `${route.surfaceId.padEnd(22)} LCP ${measured.lcp.toFixed(0)}ms  ` +
          `CLS ${measured.cls.toFixed(3)}  TBT ${measured.tbt.toFixed(0)}ms  ` +
          `${measured.apiCalls.length} API of ${measured.requests} requests`,
      );

      expect(measured.lcp, `${route.surfaceId} LCP`).toBeLessThanOrEqual(LCP_BUDGET_MS);
      expect(measured.cls, `${route.surfaceId} CLS`).toBeLessThanOrEqual(CLS_BUDGET);
      expect(measured.tbt, `${route.surfaceId} TBT`).toBeLessThanOrEqual(TBT_BUDGET_MS);
    });
  }
});

test.describe("first load does not fan out", () => {
  for (const route of routes) {
    test(`${route.surfaceId} stays within the API budget and repeats nothing`, async ({ page }) => {
      const measured = await measure(page, route.path);

      const counts = new Map<string, number>();
      for (const url of measured.apiCalls) counts.set(url, (counts.get(url) ?? 0) + 1);
      const repeated = [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([url, count]) => `${count}× ${url}`)
        .sort();

      console.log(
        `${route.surfaceId.padEnd(22)} ${measured.apiCalls.length} API call(s)` +
          (repeated.length ? ` · repeated: ${repeated.join(", ")}` : ""),
      );

      // The plan's budget, or the measured figure for a surface already over it.
      // Recording the number is not waiving it: the gate still fails the moment
      // a surface asks for one more than it asks for today.
      const ceiling = FIRST_LOAD_API_CALL_DEBT[route.surfaceId] ?? FIRST_LOAD_API_CALL_BUDGET;
      expect(
        measured.apiCalls.length,
        `${route.surfaceId} first load: ${measured.apiCalls.join(", ")}`,
      ).toBeLessThanOrEqual(ceiling);

      const unexplained = repeated.filter(
        (entry) =>
          !KNOWN_DUPLICATE_FIRST_LOAD_READS.some((known) => entry.includes(known)),
      );
      expect(unexplained, `${route.surfaceId} repeated a read nothing accounts for`).toEqual([]);
    });
  }
});
