// @vitest-environment jsdom
//
// D078 correction 3 (C3.2) — the ACTIONABLE-CONTROL half of the CTA proof.
//
// The sibling `route.lattice-cta.db.test.tsx` (node environment) proves
// what the ACTUAL `/api/meta/decisions-workspace` GET serves against the
// seeded ephemeral DB — real cookie auth, real posture read, freshness
// derived by the shipped 12-hour evaluator, zero network — and hands its
// EXACT captured route response (plus the actual accounts-route response
// and the two exact ad ids) to this file through a runner-owned handoff
// file inside the ephemeral cluster's temp directory. This split exists
// because the jsdom web transform cannot import server modules (pg, route
// handlers); the payload driven here IS the actual route's payload, from
// the same runner invocation, unmodified.
//
// What this file proves, in a real DOM: the real operator action path the
// deployed P0 fix lives in — real `MetaPlatformPage` wiring, real
// `MetaDecisionCenterExact` queue, real exact adapter, real
// `onCreativeReview` drill, real `authorizeMetaNativeAdPause` gate, real
// `CreativeEvidenceWindowExact` drawer, real `MetaNativeAdPauseDialog`
// ceremony. Correction 2 stopped at action-label text on the queue and
// scoped its "no enabled Cut" check to a selector that does not exist;
// every helper here THROWS on an absent region.
//
// Honest mock ledger (complete — no data/provider boundary is mocked in
// this file at all):
// 1. Global fetch — a throwing recorder: any attempted call throws (so no
//    network I/O can occur); assertions allow ONLY the fire-and-forget
//    `/api/instrumentation/event` beacon (whose synchronous throw the
//    emitter swallows) and prove no provider/mutation URL was ever tried.
// 2. jsdom framework harness mocks with no data semantics:
//    `next/navigation` (router/pathname/searchParams), `@/store/app-store`,
//    `@/lib/zero-base/language`, and the repo's established
//    `@tanstack/react-query` mounting stub — the workspace data that stub
//    serves IS the captured actual-route response, and the
//    provider-accounts data IS the captured actual accounts-route
//    response.
//
// Runs only when the D078 runner/harness set D078_CTA_HANDOFF to the
// capture written by the node route proof; otherwise every test skips.
import fs from "node:fs";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const HANDOFF_PATH = process.env.D078_CTA_HANDOFF ?? "";
const RUNNABLE = Boolean(HANDOFF_PATH) && fs.existsSync(HANDOFF_PATH);

const harness = vi.hoisted(() => ({
  search: "window=28d",
  workspaceData: undefined as unknown,
  providerAccounts: [] as unknown[],
}));

const searchParamsCache = new Map<string, URLSearchParams>();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/platforms/meta",
  useSearchParams: () => {
    const cached = searchParamsCache.get(harness.search);
    if (cached) return cached;
    const params = new URLSearchParams(harness.search);
    searchParamsCache.set(harness.search, params);
    return params;
  },
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (input: unknown) => unknown) =>
    selector({ businesses: [], selectBusiness: vi.fn() }),
}));
vi.mock("@/lib/zero-base/language", () => ({
  useZeroBaseLanguage: () => "en",
}));
vi.mock("@tanstack/react-query", () => {
  // Result identities are STABLE per query key: the page keeps effects
  // keyed on query results, and a fresh object per render is an infinite
  // render loop in the harness, not a product defect.
  const resultCache = new Map<string, unknown>();
  return {
    keepPreviousData: Symbol.for("keepPreviousData"),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
    useQuery: (input: { queryKey: unknown[] }) => {
      const key = JSON.stringify(input.queryKey);
      const cached = resultCache.get(key);
      if (cached) return cached;
      const root = String(input.queryKey[0]);
      const data =
        root === "meta-decisions-workspace"
          ? harness.workspaceData
          : root === "meta-provider-accounts"
            ? harness.providerAccounts
            : root === "meta-anomalies"
              ? { anomalies: [], snapshotDate: "2026-08-16", count: 0 }
              : root === "triage-state"
                ? { rows: [], deferredCount: 0 }
                : undefined;
      const result = {
        data,
        isLoading: false,
        isFetching: false,
        isError: false,
        error: null,
        fetchStatus: "idle" as const,
        refetch: () => Promise.resolve({ data: undefined }),
      };
      resultCache.set(key, result);
      return result;
    },
  };
});

const fetchAttempts: string[] = [];
const networkSpy = vi.fn((...args: unknown[]) => {
  fetchAttempts.push(String(args[0]));
  throw new Error("network access is forbidden in the drawer CTA proof");
});

type OsRow = {
  id: string;
  adId: string;
  adName: string;
  action: { label: string; providerMutation: string | null; scopeNote: string };
};

describe.skipIf(!RUNNABLE)(
  "actual-route → actual drawer/action proof (D078 C3.2, jsdom over the captured route payload)",
  () => {
    let staleRow: OsRow;
    let freshRow: OsRow;
    let businessId = "";
    let container: HTMLDivElement | null = null;
    let root: Root | null = null;
    let MetaPlatformPage: (props: {
      businessId: string;
      businessName: string;
    }) => React.ReactElement;

    beforeAll(async () => {
      vi.stubGlobal("fetch", networkSpy);
      const handoff = JSON.parse(fs.readFileSync(HANDOFF_PATH, "utf8")) as {
        payload: Record<string, unknown>;
        accounts: unknown[];
        staleAdId: string;
        freshAdId: string;
        businessId: string;
        mainAccountId: string;
      };
      harness.workspaceData = handoff.payload;
      harness.providerAccounts = handoff.accounts;
      businessId = handoff.businessId;
      harness.search = `providerAccountId=${handoff.mainAccountId}&scope=creatives&window=28d`;

      const items = (
        handoff.payload as unknown as { os: { ads: { items: OsRow[] } } }
      ).os.ads.items;
      staleRow = items.find((item) => item.adId === handoff.staleAdId)!;
      freshRow = items.find((item) => item.adId === handoff.freshAdId)!;
      expect(staleRow).toBeTruthy();
      expect(freshRow).toBeTruthy();

      MetaPlatformPage = (
        await import("@/components/meta/redesign/MetaPlatformPage")
      ).MetaPlatformPage;
    }, 60_000);

    afterEach(() => {
      if (root) act(() => root!.unmount());
      container?.remove();
      root = null;
      container = null;
    });

    /** Query that THROWS on zero matches — no `?? ""` region may pass. */
    function mustQuery(scope: ParentNode, selector: string): HTMLElement {
      const node = scope.querySelector<HTMLElement>(selector);
      if (!node) throw new Error(`required selector matched zero nodes: ${selector}`);
      return node;
    }

    function mount(): HTMLDivElement {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      act(() => {
        root!.render(
          <MetaPlatformPage businessId={businessId} businessName="TheSwaf" />,
        );
      });
      return container;
    }

    async function openDrawer(row: OsRow): Promise<HTMLElement> {
      const dom = mount();
      const article = mustQuery(
        dom,
        `article[data-meta-exact-creative-row="${row.id}"]`,
      );
      const review = mustQuery(
        article,
        'button[data-meta-exact-creative-review="true"]',
      );
      expect(review.hasAttribute("disabled")).toBe(false);
      await act(async () => {
        review.click();
        await Promise.resolve();
      });
      return mustQuery(dom, '[data-testid="creative-evidence-window"]');
    }

    function drawerButtons(drawer: HTMLElement, label: RegExp) {
      return Array.from(drawer.querySelectorAll("button")).filter((button) =>
        label.test(button.textContent?.trim() ?? ""),
      );
    }

    it("renders both exact rows from the route payload; the drawer does NOT exist until a row is opened (would-have-failed probe)", () => {
      const dom = mount();
      mustQuery(dom, `article[data-meta-exact-creative-row="${staleRow.id}"]`);
      mustQuery(dom, `article[data-meta-exact-creative-row="${freshRow.id}"]`);
      // The helper genuinely throws on an absent region.
      expect(() => mustQuery(dom, '[data-testid="creative-evidence-window"]')).toThrow(
        /matched zero nodes/,
      );
      expect(() =>
        mustQuery(dom, 'article[data-meta-exact-creative-row="no_such_row"]'),
      ).toThrow(/matched zero nodes/);
    });

    it("STALE row → real drawer: visible stale evidence, review-only Refresh Decision, no enabled pause/Cut control, no ceremony", async () => {
      expect(staleRow.action.providerMutation).toBeNull();
      const drawer = await openDrawer(staleRow);
      // Scoped to the exact ad: this drawer is the stale ad's, not the fresh one's.
      expect(drawer.textContent).toContain(staleRow.adName);
      expect(drawer.textContent).not.toContain(freshRow.adName);
      // Stale evidence is visible in the authority section.
      expect(drawer.textContent).toMatch(/stale/i);
      // The primary is the served review-only action and is NOT clickable.
      const primary = drawerButtons(drawer, /^Refresh Decision$/)[0];
      if (!primary) throw new Error("Refresh Decision primary not rendered");
      expect(primary.hasAttribute("disabled")).toBe(true);
      // C3.2.7 probe: a fresh-style enabled Cut/pause control must NOT exist.
      expect(drawerButtons(drawer, /^Cut$/)).toHaveLength(0);
      expect(drawerButtons(drawer, /^Pause\b/)).toHaveLength(0);
      expect(
        document.querySelector("[data-meta-native-ad-pause-dialog]"),
      ).toBeNull();
    });

    it("FRESH row → real drawer: supervised Cut ENABLED with live-preflight copy; clicking opens ONLY the confirmation ceremony — zero provider mutation", async () => {
      expect(freshRow.action.providerMutation).toBe("pause");
      const drawer = await openDrawer(freshRow);
      expect(drawer.textContent).toContain(freshRow.adName);
      expect(drawer.textContent).not.toContain(staleRow.adName);
      // The explicit live-preflight copy is visible in the drawer.
      expect(drawer.textContent).toMatch(/live preflight/i);
      const cut = drawerButtons(drawer, /^Cut$/)[0];
      if (!cut) throw new Error("supervised Cut primary not rendered");
      // Would-have-failed probe (C3.2.7): the control must be OFFERED —
      // an absent or disabled Cut is a wiring failure, not a pass.
      expect(cut.hasAttribute("disabled")).toBe(false);
      const mutationsBefore = fetchAttempts.filter(
        (url) => !url.includes("/api/instrumentation/event"),
      );
      await act(async () => {
        cut.click();
        await Promise.resolve();
      });
      // The click opened the real confirmation/preflight ceremony…
      const dialog = mustQuery(
        document.body,
        "[data-meta-native-ad-pause-dialog]",
      );
      expect(dialog.textContent).toContain("Pause this exact Meta Ad?");
      expect(dialog.textContent).toContain(
        "re-read the immutable decision lineage and live hierarchy before one provider attempt",
      );
      mustQuery(dialog, "[data-meta-native-ad-pause-confirm]");
      // …and performed ZERO provider mutation: no non-instrumentation fetch
      // was even attempted (and every attempted fetch threw, so nothing left
      // this process at all).
      const mutationsAfter = fetchAttempts.filter(
        (url) => !url.includes("/api/instrumentation/event"),
      );
      expect(mutationsAfter).toEqual(mutationsBefore);
      expect(mutationsAfter).toEqual([]);
    });

    it("zero provider/network calls across the whole surface", () => {
      expect(
        fetchAttempts.filter(
          (url) => !url.includes("/api/instrumentation/event"),
        ),
      ).toEqual([]);
    });
  },
);

describe.skipIf(RUNNABLE)("drawer CTA proof placeholder", () => {
  it("is skipped without the runner-provided actual-route capture", () => {
    expect(RUNNABLE).toBe(false);
  });
});
