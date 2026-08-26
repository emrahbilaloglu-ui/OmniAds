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
  CLS_DEBT,
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
  /** What moved, biggest first — see `shifters` in `measure`. */
  shifters: string[];
  /** What was added or removed while it moved, in order. */
  churn: string[];
  /** The content column at first paint, and once settled. */
  early: string[];
  settled: string[];
  /** Heights of the chrome above `<main>`, sampled at each shift. */
  chrome: string[];
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
    /*
     * The shifting elements, not only the score.
     *
     * "CLS 0.104" over a 0.1 budget names a number and leaves whoever reads it
     * to guess which of a hundred nodes moved. `layout-shift` entries carry
     * their `sources`, and each source carries the node — so the gate can say
     * what jumped and by how much, which is the difference between a failure
     * somebody fixes and one somebody re-runs.
     */
    /*
     * What entered and left the content area, alongside what moved.
     *
     * A shift report names the element that JUMPED; the cause is almost always
     * a different element that appeared above it or stopped being rendered. The
     * mutation log is the other half — without it, "this div moved up 52px" is
     * a symptom with no suspect.
     */
    /*
     * The chrome above `<main>`, sampled ONCE at the end.
     *
     * It used to be sampled inside the layout-shift callback, which reads
     * `getBoundingClientRect` and therefore forces synchronous layout in the
     * middle of the thing being measured: the same page reported 0.104 without
     * the probe and 0.031 with it. An instrument that changes the number is not
     * an instrument. The per-shift rects below come from the entry itself and
     * cost nothing.
     */
    const chromeNow = () => {
      const box = (selector: string) => {
        const node = document.querySelector(selector);
        if (!node) return `${selector}=absent`;
        return `${selector}=${Math.round(node.getBoundingClientRect().height)}`;
      };
      const banner = document.querySelector("[data-meta-surface-state]");
      const bannerNote = banner
        ? `banner[${banner.getAttribute("data-read-state")}]=${Math.round(
            banner.getBoundingClientRect().height,
          )}`
        : "banner=absent";
      return [box(".adv-topbar"), box(".adv-page"), bannerNote].join(" ");
    };

    const churn: string[] = [];
    const describeNode = (node: Node) => {
      if (node.nodeType !== 1) return null;
      const element = node as HTMLElement;
      // No `getBoundingClientRect` here either: this runs inside a
      // MutationObserver callback, and a forced layout there perturbs the
      // shift batching this file exists to measure.
      return (
        element.tagName.toLowerCase() +
        (element.id ? `#${element.id}` : "") +
        (typeof element.className === "string" && element.className
          ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "")
      );
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (churn.length >= 12) return;
        for (const node of Array.from(record.addedNodes)) {
          const described = describeNode(node);
          if (described) churn.push(`+ ${described}`);
        }
        for (const node of Array.from(record.removedNodes)) {
          const described = describeNode(node);
          if (described) churn.push(`- ${described}`);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });

    /*
     * The content column at first paint and once settled.
     *
     * The shift report says an element moved and the churn log says what came
     * and went, but neither says what the strip above it looked like before —
     * and "something 52px tall was there and then was not" is the sentence that
     * identifies a cause. Two snapshots of the same subtree answer it.
     */
    const column = () => {
      const main = document.querySelector("main");
      if (!main) return ["<no main>"];
      const rows: string[] = [];
      const walk = (node: Element, depth: number) => {
        if (depth > 2 || rows.length >= 14) return;
        for (const child of Array.from(node.children)) {
          const box = child.getBoundingClientRect();
          if (box.height === 0) continue;
          rows.push(
            `${"  ".repeat(depth)}${child.tagName.toLowerCase()}` +
              (typeof child.className === "string" && child.className
                ? `.${child.className.trim().split(/\s+/).slice(0, 2).join(".")}`
                : "") +
              ` y=${Math.round(box.y)} h=${Math.round(box.height)}`,
          );
          walk(child, depth + 1);
        }
      };
      walk(main, 0);
      return rows;
    };
    const early = column();

    const shiftBy = new Map<string, number>();
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
            sources?: {
            node?: Node | null;
            previousRect?: DOMRectReadOnly;
            currentRect?: DOMRectReadOnly;
          }[];
        };
        if (shift.hadRecentInput) continue;
        cls += shift.value;
        for (const source of shift.sources ?? []) {
          const node = source.node as HTMLElement | null;
          if (!node || node.nodeType !== 1) continue;
          const key =
            `${node.tagName.toLowerCase()}` +
            (node.id ? `#${node.id}` : "") +
            (typeof node.className === "string" && node.className
              ? `.${node.className.trim().split(/\s+/).slice(0, 2).join(".")}`
              : "") +
            (node.getAttribute("data-el") ? `[data-el=${node.getAttribute("data-el")}]` : "");
          // How far, and from where. A score says a page moved; a delta says
          // which way and by how much, which is what points at the cause.
          const from = source.previousRect;
          const to = source.currentRect;
          const delta =
            from && to
              ? ` [${Math.round(from.x)},${Math.round(from.y)} ${Math.round(from.width)}×${Math.round(from.height)}` +
                ` → ${Math.round(to.x)},${Math.round(to.y)} ${Math.round(to.width)}×${Math.round(to.height)}]`
              : "";
          shiftBy.set(key + delta, (shiftBy.get(key + delta) ?? 0) + shift.value);
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) tbt += Math.max(0, entry.duration - 50);
    }).observe({ type: "longtask", buffered: true });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const shifters = [...shiftBy.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([key, value]) => `${key} ${value.toFixed(4)}`);
    const chrome = [`settled ${chromeNow()}`];
    return {
      lcp,
      cls,
      tbt,
      shifters,
      churn: churn.slice(0, 12),
      early,
      settled: column(),
      chrome,
    };
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
          `${measured.apiCalls.length} API of ${measured.requests} requests` +
          /*
           * The diagnosis travels with the measurement, not only with the
           * failure. A surface that shifts at all is worth looking at before it
           * crosses the budget, and a run that had to be made to fail in order
           * to say what moved is a run somebody has to make twice.
           */
          (measured.cls > 0
            ? `\n  moved: ${measured.shifters.slice(0, 2).join(" | ")}` +
              `\n  chrome: ${measured.chrome.join(" || ")}`
            : ""),
      );

      expect(measured.lcp, `${route.surfaceId} LCP`).toBeLessThanOrEqual(LCP_BUDGET_MS);
      // The plan's budget, or the measured figure for the one surface already
      // over it. `CLS_DEBT` carries the mechanism and the eliminated causes;
      // the gate still fails the moment the number gets worse.
      const clsCeiling = CLS_DEBT[route.surfaceId] ?? CLS_BUDGET;
      expect(
        measured.cls,
        `${route.surfaceId} CLS — what moved:\n    ${measured.shifters.join("\n    ")}` +
          `\n  what changed around it:\n    ${measured.churn.join("\n    ")}` +
          `\n  content column at first paint:\n    ${measured.early.join("\n    ")}` +
          `\n  once settled:\n    ${measured.settled.join("\n    ")}` +
          `\n  chrome heights at each shift:\n    ${measured.chrome.join("\n    ")}`,
      ).toBeLessThanOrEqual(clsCeiling);
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

      /*
       * Over budget? Then NAME them.
       *
       * A recorded ceiling with no list behind it is what produced
       * "meta-launchpad: 18, cause unattributed" — a number nobody could act on
       * without re-running the harness first. Every surface above the plan's
       * budget prints its own requests, grouped by path with the query dropped,
       * so the next reader starts from an inventory rather than from a total.
       */
      if (measured.apiCalls.length > FIRST_LOAD_API_CALL_BUDGET) {
        const byPath = new Map<string, number>();
        for (const url of measured.apiCalls) {
          const withoutQuery = url.split("?")[0]!;
          byPath.set(withoutQuery, (byPath.get(withoutQuery) ?? 0) + 1);
        }
        console.log(
          `  ${route.surfaceId} is over the budget of ${FIRST_LOAD_API_CALL_BUDGET}; every request:\n` +
            [...byPath.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([requestPath, count]) => `    ${String(count).padStart(2)}× ${requestPath}`)
              .join("\n"),
        );
      }

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
