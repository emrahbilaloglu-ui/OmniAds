// @vitest-environment jsdom

/**
 * THE PHONE'S ARCHIVE NOTE, ON REAL MOUNTED DOM.
 *
 * ── ROUND 11, ITEM 2 ────────────────────────────────────────────────────────
 * `inactiveAdNote` reaches two surfaces from one string. The desktop Archive
 * prints it in the note column; the mobile queue maps `archiveRows[].note` onto
 * the row's `meta` line (`mobileQueueRowsForLane`, lane `archive`). So the
 * sentence "Withheld from the live queue: …" was on a media buyer's phone too,
 * and the sibling sweep in
 * `components/meta/decision-center/buyer-language-dom.test.tsx` could not see
 * it — that file mounts `MetaDecisionCenterExact`, which has no mobile subtree.
 *
 * WHY A FULL PAGE MOUNT. The mobile screen is not exported; it exists only
 * inside `MetaPlatformPage`, which renders it as a sibling of the desktop tree
 * and lets the stylesheet show one or the other. The existing mobile tests in
 * this directory assert on the FILE'S SOURCE TEXT, which cannot prove that a
 * string reaches the DOM. This one mounts the page and reads
 * `document.body`, scoped to the mobile subtree by its own test id.
 *
 * Both directions are asserted: the buyer sentence is present in the mobile
 * subtree, and the shared `INTERNAL_VOCABULARY` list is absent from it.
 */
import React from "react";
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INTERNAL_VOCABULARY } from "@/lib/meta/buyer-copy";

const state: {
  search: string;
  pathname: string;
  workspace: Record<string, unknown> | null;
} = { search: "window=28d&lane=archive", pathname: "/platforms/meta", workspace: null };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (input: unknown) => unknown) =>
    selector({ businesses: [], selectBusiness: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: (input: { queryKey: unknown[] }) => {
    const key = String(input.queryKey[0]);
    const data =
      key === "meta-decisions-workspace"
        ? state.workspace
        : key === "meta-provider-accounts"
          ? [{ id: "act_1", name: "Main Meta", currency: "USD", timezone: "UTC" }]
          : key === "meta-anomalies"
            ? { anomalies: [], snapshotDate: "2026-08-16", count: 0 }
            : null;
    return {
      data,
      isLoading: false,
      isPending: false,
      isError: false,
      error: null,
      status: "success",
      fetchStatus: "idle",
      refetch: vi.fn(),
    };
  },
}));

/** The withheld Ad decision, exactly as `decisionReadModel` files it. */
function inactiveAd() {
  return {
    decisionId: "inactive_1",
    sourceSnapshotId: "snapshot_9",
    identityGrain: "ad",
    parentChain: {
      account: { id: "act_1", name: "Account" },
      campaign: { id: "cmp_9", name: "Retired Campaign" },
      adset: { id: "ads_9", name: "Retired Ad set" },
      ad: { id: "ad_9", name: "Cat-Guarantee" },
      creative: { id: "crt_9", name: "Cat-Guarantee creative" },
    },
    deliveryScope: {
      state: "inactive",
      campaignStatus: "NOT_ACTIVE",
      adsetStatus: "NOT_ACTIVE",
      adStatus: "NOT_ACTIVE",
      reason: "hierarchy_not_active",
    },
    sourceAuthority: {
      status: "native_exact",
      actionEligible: false,
      reviewOnlyReason: "current_hierarchy_is_not_active",
      authorizedAction: null,
    },
    classification: {
      buyerLabel: "Cut this creative",
      decisionState: "act",
      heldAction: "cut",
    },
    sourceDecision: { label: "cut", reason: "ROAS below target" },
    metrics: { spend: 699.34, purchases: 2, roas: 1.1 },
  };
}

function workspacePayload() {
  return {
    businessId: "biz_1",
    window: "28d",
    startDate: "2026-07-21",
    endDate: "2026-08-17",
    pulse: {
      businessId: "biz_1",
      window: "28d",
      startDate: "2026-07-21",
      endDate: "2026-08-17",
      pacing: { mtdSpend: 0, mtdTarget: 0, dayPace: 0 },
      roas: {
        selected: Number.NaN,
        d7: Number.NaN,
        d14: Number.NaN,
        d28: Number.NaN,
        target: null,
        median: null,
        target_source: "none",
      },
      spend: { current: 0, prev: 0 },
      revenue: { current: 0, prev: 0 },
      cpa: { current: null, prev: null },
      matureCampaigns: 0,
      learningCampaigns: 0,
      operatingMode: "",
      seasonalRegime: "",
      engineLastRun: null,
      engineVersion: "server-engine-v1",
      trackingHealth: { status: "unknown", detail: "" },
      lastSyncAt: null,
      currency: "USD",
    },
    lanes: {
      businessId: "biz_1",
      startDate: "2026-07-21",
      endDate: "2026-08-17",
      sourceModel: "snapshot_persistent",
      snapshotDate: "2026-08-16",
      actionNow: [],
      watching: [],
      healthy: [],
      nonSales: [],
      archive: [],
      deferredIds: [],
      watchingSegments: [],
      counts: {
        actionNow: 0,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 1,
      },
    },
    queue: {
      groups: [],
      actionStates: {
        executablePause: 0,
        executableBid: 0,
        executableResume: 0,
        launchpadRoutes: 0,
        reviewOnly: 0,
        missingActionKind: 0,
      },
    },
    system: {
      trackingBlocked: false,
      laneSnapshotDate: "2026-08-16",
      engineVersion: "server-engine-v1",
      currency: "USD",
      killSwitchEngaged: false,
      killSwitchReason: null,
    },
    viewer: null,
    banners: [],
    digest: {
      snapshotDate: "2026-08-16",
      unavailableReason: null,
      labelFlips: { count: 0, publishedCount: 0, items: [] },
      actions: { verifiedCount: 0, silentFailureCount: 0, items: [] },
      anomalies: { openedCount: 0, items: [] },
      deferrals: { dueCount: 0, items: [] },
    },
    decisionReadModel: {
      scope: {
        businessId: "biz_1",
        providerAccountId: "act_1",
        decisionMode: "current",
      },
      source: {
        authority: "native_ad",
        status: "available",
        fallbackReason: null,
        snapshotAsOf: "2026-08-16",
        engineVersion: "server-engine-v1",
      },
      capabilities: {},
      queue: { sections: {}, inactiveAssets: { items: [inactiveAd()], count: 1 } },
    },
    os: {
      source: {
        adsSource: "native_ad_decision",
        structureSource: "meta_recommendations",
        health: "healthy",
        fallbackReason: null,
      },
      // `items` is read unguarded by the page (`os.ads.items.length`), so the
      // served-empty case is an empty array, not an absent key.
      ads: { pendingInventoryCount: 0, items: [], heldCounts: null },
      limitations: [],
      structure: { groups: [] },
    },
  };
}

afterEach(cleanup);
beforeEach(() => {
  state.search = "window=28d&lane=archive";
  state.workspace = workspacePayload();
});

/** The mobile subtree, and only it. The desktop tree is a sibling in the DOM. */
function mobileText() {
  const stage = document.querySelector('[data-testid="meta-mobile-decisions"]');
  expect(stage, "the mobile decision stage must be mounted").toBeTruthy();
  return (stage?.textContent ?? "").replace(/\s+/g, " ").toLowerCase();
}

describe("the mobile Archive row states why the ad is not in Action now", () => {
  it("renders the buyer sentence in the mobile subtree", async () => {
    const { MetaPlatformPage } = await import("./MetaPlatformPage");
    render(<MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />);

    const text = mobileText();
    // PRESENT: the phone says the same thing the desktop says.
    expect(text).toContain(
      "not included in action now because this ad is inactive.",
    );
    // And the provider's own status list survives the rewrite.
    expect(text).toContain("current status — campaign not_active");
  });

  it("never says 'withheld from the live queue' on a phone", async () => {
    const { MetaPlatformPage } = await import("./MetaPlatformPage");
    render(<MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />);
    expect(mobileText()).not.toContain("withheld from the live queue");
  });

  it("carries no internal vocabulary anywhere in the mobile subtree", async () => {
    const { MetaPlatformPage } = await import("./MetaPlatformPage");
    render(<MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />);
    const text = mobileText();
    for (const term of INTERNAL_VOCABULARY) {
      expect(
        text,
        `the mobile Archive rendered the internal term "${term}"`,
      ).not.toContain(term.toLowerCase());
    }
  });

  it("would FAIL if the note were passed through unmapped", () => {
    /*
      The control. The sentence this replaced is asserted to contain forbidden
      vocabulary, so the three cases above prove a MAPPING rather than a
      fixture that happened to read cleanly either way.
    */
    const raw =
      "Withheld from the live queue: the current campaign / ad set / ad hierarchy is not active.";
    expect(
      INTERNAL_VOCABULARY.filter((term) =>
        raw.toLowerCase().includes(term.toLowerCase()),
      ),
    ).not.toHaveLength(0);
  });
});
