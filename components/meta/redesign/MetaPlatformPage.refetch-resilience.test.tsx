// @vitest-environment jsdom
/**
 * Data-lifetime laws for the Meta Decisions surface.
 *
 * React Query keeps the last good response when a refetch of the SAME key
 * fails, stamps every successful response as a new object, and shows another
 * key's rows as placeholder data only while the new key is pending. Each of
 * those facts used to take something away from the operator: the phone's
 * loaded queue, an open evidence drawer, or the whole workspace after a failed
 * "Show more decisions". These tests drive the page through those query states
 * and pin what must survive and what must still close.
 *
 * The query mock below returns React Query's observable result shape per key
 * (status, isFetching, isPlaceholderData, errorUpdatedAt), so a test can state
 * "the raised cap is still loading", "it failed after the click" or "a
 * background refetch failed over loaded rows" exactly.
 */
import React from "react";
import { act } from "react";

// React needs to be told this is an act() environment before anything renders.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  metaLanePayload,
  metaPulse,
} from "@/components/meta/redesign/test-fixtures";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { MetaOsAdDecision } from "@/lib/meta/decisions-os-contract";

type WorkspaceRead = {
  data?: unknown;
  error?: Error | null;
  status?: "pending" | "error" | "success";
  isFetching?: boolean;
  isPlaceholderData?: boolean;
  errorUpdatedAt?: number;
};

const state = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  search: "window=28d",
  pathname: "/c/biz_1/meta/decisions",
  providerAccounts: [] as any[],
  workspaceData: undefined as unknown,
  /** Supplemental Ad-day funnel rows for the open evidence drawer. */
  evidenceAdRows: null as unknown,
  canonicalCreatives: [] as any[],
  /** The workspace read for one exact query key. */
  workspaceRead: null as null | ((key: unknown[]) => WorkspaceRead),
  refetched: [] as string[],
  queryKeys: [] as unknown[][],
  adapterInput: null as any,
  evidenceProps: null as any,
}));

// `useSearchParams` must hand back a STABLE object across renders, as the real
// hook does; the page keeps an effect keyed on it.
const searchParamsCache = new Map<string, URLSearchParams>();
function stableSearchParams(query: string) {
  const cached = searchParamsCache.get(query);
  if (cached) return cached;
  const params = new URLSearchParams(query);
  searchParamsCache.set(query, params);
  return params;
}

// Stable query payload identities, for the same reason.
const EMPTY_ANOMALIES = { anomalies: [], snapshotDate: "2026-05-07", count: 0 };
const EMPTY_TRIAGE = { rows: [], deferredCount: 0 };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.routerPush, replace: state.routerReplace }),
  usePathname: () => state.pathname,
  useSearchParams: () => stableSearchParams(state.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (input: unknown) => unknown) =>
    selector({ businesses: [], selectBusiness: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQueryClient: () => ({
    invalidateQueries: () => Promise.resolve(),
  }),
  useQuery: (input: { queryKey: unknown[] }) => {
    const key = String(input.queryKey[0]);
    state.queryKeys.push(input.queryKey);
    const read: WorkspaceRead =
      key === "meta-decisions-workspace"
        ? (state.workspaceRead?.(input.queryKey) ?? {
            data: state.workspaceData,
          })
        : {
            data:
              key === "meta-creative-evidence-ad-rows"
                ? state.evidenceAdRows
                : key === "meta-provider-accounts"
                ? state.providerAccounts
                : key === "meta-anomalies"
                  ? EMPTY_ANOMALIES
                  : key === "triage-state"
                    ? EMPTY_TRIAGE
                    : null,
          };
    const error = read.error ?? null;
    return {
      data: read.data,
      status: read.status ?? (error ? "error" : "success"),
      fetchStatus: read.isFetching ? "fetching" : "idle",
      isLoading: false,
      isFetching: read.isFetching ?? false,
      isPlaceholderData: read.isPlaceholderData ?? false,
      isError: Boolean(error),
      error,
      errorUpdatedAt: read.errorUpdatedAt ?? 0,
      refetch: () => {
        state.refetched.push(key);
        return Promise.resolve({ data: undefined });
      },
    };
  },
}));

vi.mock("@/components/meta/decision-center/MetaDecisionCenterExact", () => ({
  MetaDecisionCenterExact: () =>
    React.createElement("div", { "data-stub-exact": "true" }),
}));

vi.mock("@/components/meta/redesign/MetaLaunchpadOverlay", () => ({
  MetaLaunchpadOverlay: () => null,
}));

// The real adapter still runs; this only exposes the callbacks the page hands
// it, because opening a creative's evidence is one of them.
vi.mock(
  "@/components/meta/decision-center/meta-decision-center-exact-adapter",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/meta/decision-center/meta-decision-center-exact-adapter")
      >();
    return {
      ...actual,
      buildMetaDecisionCenterExactViewModel: (input: any) => {
        state.adapterInput = input;
        return actual.buildMetaDecisionCenterExactViewModel(input);
      },
    };
  },
);

vi.mock("@/components/creatives/CreativeEvidenceWindowExact", () => ({
  CreativeEvidenceWindowExact: (props: any) => {
    state.evidenceProps = props;
    return React.createElement("div", { "data-stub-evidence": "true" });
  },
}));

const { MetaPlatformPage } =
  await import("@/components/meta/redesign/MetaPlatformPage");

// Fixtures duplicated from MetaPlatformPage.wiring.test.tsx rather than
// imported: importing one test file into another registers its suites twice.
function canonicalSection(key: string, items: any[] = []): any {
  return {
    key,
    label: key,
    topN: 5,
    preCapCount: items.length,
    selectedCount: items.length,
    rankablePreCapCount: items.length,
    unrankablePreCapCount: 0,
    items,
    exposureDigest: {
      basis: "pre_cap",
      byCurrency: [],
      unavailableCount: 0,
      crossCurrencyTotal: null,
    },
    suppressionReceipt: {
      receiptId: `receipt_${key}`,
      selectionVersion: "meta-decisions-section-selection.v1",
      topN: 5,
      preCapCount: items.length,
      selectedCount: items.length,
      suppressedCount: 0,
      reasons: [],
    },
  };
}

function canonicalDecision(over: Partial<MetaCanonicalDecision> = {}): any {
  const provenance = { source: "engine_v3", asOf: "2026-07-10" };
  return {
    decisionId: "mdd_1",
    episodeId: "mde_1",
    episodeStartedAt: "2026-07-01T00:00:00.000Z",
    providerAccountId: "act_1",
    identityGrain: "ad",
    sourceSnapshotId: "snapshot_1",
    sourceDecision: {
      label: "scale",
      preAuthorityLabel: "scale",
      authorityBlocker: null,
      rawLabel: "scale",
      reason: "Fresh commercial truth supports the call.",
      confidence: 0.87,
      confidenceBand: "high",
      truthSource: "engine_v3",
      engineVersion: "v3-test",
      snapshotAsOf: "2026-07-10",
      computedAt: "2026-07-10T06:00:00.000Z",
      badges: [],
      provenance,
    },
    parentChain: {
      account: { id: "act_1", name: "Main Meta" },
      campaign: { id: "cmp_1", name: "Prospecting" },
      adset: { id: "adset_1", name: "Broad" },
      ad: { id: "ad_pending", name: "Canonical ad name" },
      creative: { id: "creative_pending", name: "Pending creative" },
      provenance,
    },
    media: {
      state: "available",
      missingMedia: false,
      thumbnail: { state: "available", url: null },
      provenance,
    },
    classification: {
      overlayVersion: "meta-decisions-classification-overlay.v1",
      queueSection: "creative_rotation",
      lifecycleRole: "test",
      assessment: "proven_winner",
      decisionState: "act",
      heldAction: null,
      legacyBuyerAction: "scale",
      buyerAction: null,
      buyerLabel: "Scale",
      executionAction: null,
      resolution: null,
      blockers: [],
      provenance,
    },
    sourceAuthority: {
      status: "native_exact",
      actionEligible: true,
      reviewOnlyReason: null,
      snapshotId: "snapshot_1",
      evaluationId: "eval_1",
      inputHash: "in_hash_1",
      decisionHash: "dec_hash_1",
      providerAccountRefId: "ref_1",
      engineVersion: "v3-test",
      realAdId: "ad_pending",
      authorizedAction: "refresh",
      executionReadiness: "live_preflight_required",
      jobRunId: "job_1",
    },
    deliveryScope: {
      state: "active",
      campaignStatus: "ACTIVE",
      adsetStatus: "ACTIVE",
      adStatus: "ACTIVE",
      reason: "active_hierarchy",
      provenance,
    },
    riskTier: null,
    confirmationCeremony: "highest",
    riskTierProvenance: provenance,
    metrics: {
      spend: 250,
      purchases: 6,
      roas: 3.2,
      cpa: null,
      ctr: null,
      frequency: null,
      currency: "USD",
      attribution: "meta_attributed",
      grain: "ad",
    },
    ...over,
  };
}

function pendingOsDecision(
  over: Partial<MetaOsAdDecision> = {},
): MetaOsAdDecision {
  return {
    id: "os_pending_ad",
    decisionId: "inventory:ad_pending",
    sourceSnapshotId: "pending-native:2026-07-10",
    episodeId: "inventory:ad_pending",
    providerAccountId: "act_1",
    adId: "ad_pending",
    adName: "Pending native evidence",
    campaignId: "cmp_1",
    campaignName: "Prospecting",
    adsetId: "adset_1",
    adsetName: "Broad",
    creativeId: "creative_pending",
    creativeName: "Pending creative",
    thumbnailUrl: null,
    lifecycleRole: "unknown",
    campaignRoleSource: "unknown",
    campaignRoleConfidence: "unknown",
    campaignRoleTrustedForAction: false,
    action: {
      code: "await_ad_grain_evidence",
      label: "Evidence pending",
      intent: "review",
      targetLevel: "ad",
      providerMutation: null,
      scopeNote: "Exact Ad-grain decision evidence is unavailable",
    },
    lane: "blocked",
    priority: {
      band: "unrankable",
      rank: null,
      version: "meta-os-decisions.presentation.v5",
    },
    assessment: "pending_native_evidence",
    confidence: "low",
    confidenceScore: null,
    riskTier: null,
    confirmationCeremony: "highest",
    whyNow:
      "Meta confirms this Ad is ACTIVE, but exact Ad-grain evidence is pending.",
    blockers: [
      {
        code: "native_ad_decision_unavailable",
        label: "Exact Ad-grain decision evidence is unavailable",
      },
    ],
    resolution: {
      code: "produce_native_ad_decision",
      category: "system",
      owner: "system",
      label: "Produce exact Ad decision",
      nextStep: "Complete native Ad decision lineage.",
    },
    metrics: {
      spend: null,
      purchases: null,
      roas: null,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: null,
      ratioToTarget: null,
      currency: "USD",
      attribution: "meta_attributed",
      grain: "ad",
    },
    rawLabel: null,
    publishedLabel: "Evidence pending",
    engineVersion: "v3-test",
    snapshotAsOf: "2026-07-10",
    sourceGrain: "ad",
    decisionAvailability: "pending_native_evidence",
    ...over,
  };
}

function osPresentation(
  items: MetaOsAdDecision[],
  eligiblePreCapCount = items.length,
) {
  const count = (lane: MetaOsAdDecision["lane"]) =>
    items.filter((item) => item.lane === lane).length;
  return {
    contractVersion: "meta-os-decisions.presentation.v5",
    generatedAt: "2026-07-10T12:00:00.000Z",
    source: {
      snapshotAsOf: "2026-07-10",
      engineVersion: "v3-test",
      structureSource: "meta_recommendations",
      adsSource: "native_ad_decision",
      health: "healthy",
      fallbackReason: null,
    },
    structure: {
      groups: [],
      actCount: 0,
      blockedCount: 0,
      monitorCount: 0,
      suppressedAlternativeCount: 0,
    },
    ads: {
      items,
      actCount: count("act"),
      blockedCount: count("blocked"),
      monitorCount: count("monitor"),
      statePreCapCounts: {
        act: count("act"),
        blocked: count("blocked"),
        monitor: count("monitor"),
      },
      eligiblePreCapCount,
      omittedWithoutVerifiedAdId: 0,
      omittedAmbiguousIdentity: 0,
      omittedNotApplicable: 0,
      sourcePreCapCount: items.length,
    },
    limitations: [],
  };
}

function decisionReadModel(creatives: any[], providerAccountId: string) {
  return {
    contractVersion: "meta-decisions-workspace.read.v1",
    status: "available",
    generatedAt: "2026-07-10T12:00:00.000Z",
    scope: {
      businessId: "biz_1",
      providerAccountId,
      decisionMode: "current",
      metricsRangeAffectsDecisionSnapshot: false,
    },
    unavailable: null,
    source: {
      status: "available",
      authority: "legacy_creative",
      table: "engine_v3_decision_snapshots_daily",
      snapshotAsOf: "2026-05-07",
      computedAt: "2026-05-07T06:00:00.000Z",
      engineVersion: "v3-test",
      fallbackReason: null,
      generation: null,
    },
    queue: {
      deduplicationGrain: "creative",
      sourcePreCapCount: creatives.length,
      queuedPreCapCount: creatives.length,
      sections: {
        integrity_fires: canonicalSection("integrity_fires"),
        money_moves: canonicalSection("money_moves"),
        creative_rotation: canonicalSection("creative_rotation", creatives),
      },
      omittedFromQueue: { count: 0, reasons: [] },
    },
    capabilities: {},
  };
}

/**
 * A fresh workspace RESPONSE: a new object every call, as the server's
 * `os.generatedAt` stamp makes every real response.
 */
function workspaceResponse(input: {
  ads: MetaOsAdDecision[];
  eligiblePreCapCount?: number;
  canonical?: any[];
  providerAccountId?: string;
}) {
  const pulse = metaPulse();
  const lanes = metaLanePayload();
  return {
    businessId: pulse.businessId,
    window: pulse.window,
    statusFilter: pulse.statusFilter,
    startDate: pulse.startDate,
    endDate: pulse.endDate,
    pulse,
    lanes,
    queue: {
      groups: [
        { key: "action", label: "Action Now", count: lanes.counts.actionNow },
      ],
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
      dataReadiness: pulse.dataReadiness ?? null,
      snapshotHealth: pulse.snapshotHealth ?? lanes.snapshotHealth ?? null,
      laneSnapshotDate: lanes.snapshotDate,
      laneSnapshotCreatedAt: lanes.snapshotCreatedAt ?? null,
      engineVersion: pulse.engineVersion,
      currency: pulse.currency ?? null,
      killSwitchEngaged: false,
      killSwitchReason: null,
    },
    viewer: {
      role: "collaborator",
      isReviewer: false,
      readOnly: false,
      readOnlyReason: null,
    },
    banners: [],
    digest: {
      snapshotDate: lanes.snapshotDate,
      unavailableReason: null,
      labelFlips: { count: 0, publishedCount: 0, items: [] },
      actions: { verifiedCount: 0, silentFailureCount: 0, items: [] },
      anomalies: { openedCount: 0, items: [] },
      deferrals: { dueCount: 0, items: [] },
    },
    decisionReadModel: decisionReadModel(
      input.canonical ?? [],
      input.providerAccountId ?? "act_1",
    ),
    os: osPresentation(input.ads, input.eligiblePreCapCount),
  };
}

/** The second served creative, a distinct lineage in the same lane. */
function secondOsDecision() {
  return pendingOsDecision({
    id: "os_pending_ad_2",
    decisionId: "inventory:ad_pending_2",
    episodeId: "inventory:ad_pending_2",
    adId: "ad_pending_2",
    adName: "Second pending ad",
    creativeId: "creative_pending_2",
  });
}

const CREATIVES_NEEDS_RESOLUTION =
  "providerAccountId=act_1&scope=creatives&area=monitor&segment=needs_resolution";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function page() {
  return <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />;
}

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(page());
  });
  return container;
}

function rerender() {
  act(() => {
    root!.render(page());
  });
}

function workspaceKeys() {
  return state.queryKeys.filter((key) => key[0] === "meta-decisions-workspace");
}

function mobileRowIds(dom: HTMLElement) {
  return Array.from(dom.querySelectorAll("[data-mobile-row-id]")).map((row) =>
    row.getAttribute("data-mobile-row-id"),
  );
}

function openCreative(
  dom: HTMLElement,
  decision: MetaOsAdDecision,
  canonical: any = null,
) {
  act(() => state.adapterInput.callbacks.onCreativeReview(decision, canonical));
  expect(dom.querySelector("[data-stub-evidence]")).not.toBeNull();
  expect(
    dom.querySelector('[data-testid="meta-mobile-creative-evidence"]'),
  ).not.toBeNull();
}

function drawerIsOpen(dom: HTMLElement) {
  const desktop = dom.querySelector("[data-stub-evidence]") !== null;
  const mobile =
    dom.querySelector('[data-testid="meta-mobile-creative-evidence"]') !== null;
  // The two surfaces render the same selection; they may never disagree.
  expect(mobile).toBe(desktop);
  return desktop;
}

function mobileEvidenceTitle(dom: HTMLElement) {
  return dom
    .querySelector('[data-testid="meta-mobile-creative-evidence"] h2')
    ?.textContent?.trim();
}

beforeEach(() => {
  state.routerPush.mockClear();
  state.routerReplace.mockClear();
  state.search = CREATIVES_NEEDS_RESOLUTION;
  state.pathname = "/c/biz_1/meta/decisions";
  state.providerAccounts = [
    { id: "act_1", name: "Main Meta", currency: "USD", timezone: "UTC" },
  ];
  state.canonicalCreatives = [];
  state.evidenceAdRows = null;
  state.workspaceData = undefined;
  state.workspaceRead = null;
  state.refetched = [];
  state.queryKeys = [];
  state.adapterInput = null;
  state.evidenceProps = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("mobile queue over a failed background refetch", () => {
  it("keeps the loaded rows and says they are from the last successful load", () => {
    const loaded = workspaceResponse({ ads: [pendingOsDecision()] });
    state.workspaceData = loaded;
    const dom = render();
    expect(mobileRowIds(dom)).toEqual(["os_pending_ad"]);
    expect(dom.querySelector("[data-mobile-decisions-refresh-error]")).toBeNull();
    const headerBefore = dom.querySelector(".ad-mobile-status")?.textContent;
    expect(headerBefore).toMatch(/Act now \d+/);

    // React Query's shape for a failed refetch of the same key: the previous
    // response stays in `data` and the failure sits beside it.
    state.workspaceRead = () => ({
      data: loaded,
      error: new Error("workspace request failed"),
      status: "error",
    });
    rerender();

    expect(mobileRowIds(dom)).toEqual(["os_pending_ad"]);
    expect(dom.querySelector('[data-mobile-read-state="error"]')).toBeNull();
    // The header count stays on the same load as the rows and tabs.
    expect(dom.querySelector(".ad-mobile-status")?.textContent).toBe(headerBefore);
    const notice = dom.querySelector("[data-mobile-decisions-refresh-error]");
    expect(notice?.textContent).toContain("Decisions could not be refreshed.");
    expect(notice?.textContent).toContain(
      "The decisions below are from the last successful load.",
    );
    // The notice sits above the rows it qualifies.
    const firstRow = dom.querySelector("[data-mobile-row-id]")!;
    expect(
      notice!.compareDocumentPosition(firstRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The raw failure text is not buyer copy.
    expect(dom.textContent).not.toContain("workspace request failed");

    act(() =>
      notice!
        .querySelector<HTMLButtonElement>("[data-mobile-decisions-retry]")!
        .click(),
    );
    expect(state.refetched).toEqual(["meta-decisions-workspace"]);
  });

  it("still replaces the screen with the error when the failed read has nothing to show", () => {
    state.workspaceRead = () => ({
      data: undefined,
      error: new Error("workspace request failed"),
      status: "error",
    });
    const dom = render();

    expect(dom.querySelector('[data-mobile-read-state="error"]')).not.toBeNull();
    expect(dom.textContent).toContain("Decision workspace could not load.");
    expect(mobileRowIds(dom)).toEqual([]);
    expect(dom.querySelector("[data-mobile-decisions-refresh-error]")).toBeNull();
  });
});

describe("creative evidence drawer across refetches", () => {
  it("stays open when a successful refetch still serves the decision, and shows the new response's object", () => {
    const first = pendingOsDecision();
    state.workspaceData = workspaceResponse({ ads: [first] });
    const dom = render();
    openCreative(dom, first);
    expect(mobileEvidenceTitle(dom)).toBe("Pending native evidence");

    // Same id + decisionId + sourceSnapshotId, new response object, and a
    // served field that changed — the drawer must show THIS response's value.
    state.workspaceData = workspaceResponse({
      ads: [pendingOsDecision({ adName: "Pending native evidence (renamed)" })],
    });
    rerender();

    expect(drawerIsOpen(dom)).toBe(true);
    expect(mobileEvidenceTitle(dom)).toBe("Pending native evidence (renamed)");
    expect(state.evidenceProps.viewModel.name).toBe(
      "Pending native evidence (renamed)",
    );
  });

  it("rebinds the canonical half to the new response's envelope of the same lineage", () => {
    const decision = pendingOsDecision({
      decisionId: "mdd_1",
      sourceSnapshotId: "snapshot_1",
    });
    const canonical = canonicalDecision();
    state.workspaceData = workspaceResponse({
      ads: [decision],
      canonical: [canonical],
    });
    const dom = render();
    openCreative(dom, decision, canonical);
    expect(mobileEvidenceTitle(dom)).toBe("Canonical ad name");

    const refreshed = canonicalDecision({
      parentChain: {
        ...canonical.parentChain,
        ad: { id: "ad_pending", name: "Canonical ad name (refreshed)" },
      },
    });
    state.workspaceData = workspaceResponse({
      ads: [pendingOsDecision({ decisionId: "mdd_1", sourceSnapshotId: "snapshot_1" })],
      canonical: [refreshed],
    });
    rerender();
    expect(drawerIsOpen(dom)).toBe(true);
    expect(mobileEvidenceTitle(dom)).toBe("Canonical ad name (refreshed)");

    // The envelope leaving the response is not carried over from the old one:
    // the served decision keeps the drawer open, and the half is now absent.
    state.workspaceData = workspaceResponse({
      ads: [pendingOsDecision({ decisionId: "mdd_1", sourceSnapshotId: "snapshot_1" })],
      canonical: [],
    });
    rerender();
    expect(drawerIsOpen(dom)).toBe(true);
    expect(mobileEvidenceTitle(dom)).toBe("Pending native evidence");
  });

  it("closes when the refetched response no longer serves that lineage", () => {
    const first = pendingOsDecision();
    state.workspaceData = workspaceResponse({ ads: [first] });
    const dom = render();
    openCreative(dom, first);

    // Same row id, but a new snapshot: a different decision, not a refresh of
    // the one the operator opened.
    state.workspaceData = workspaceResponse({
      ads: [
        pendingOsDecision({ sourceSnapshotId: "pending-native:2026-07-11" }),
      ],
    });
    rerender();

    expect(drawerIsOpen(dom)).toBe(false);
    // Closed, not merely hidden: the same lineage coming back does not reopen it.
    state.workspaceData = workspaceResponse({ ads: [first] });
    rerender();
    expect(drawerIsOpen(dom)).toBe(false);
  });

  it("stays open on a failed refetch and keeps the last good objects", () => {
    const first = pendingOsDecision();
    const loaded = workspaceResponse({ ads: [first] });
    state.workspaceData = loaded;
    const dom = render();
    openCreative(dom, first);

    state.workspaceRead = () => ({
      data: loaded,
      error: new Error("workspace request failed"),
      status: "error",
    });
    rerender();

    expect(drawerIsOpen(dom)).toBe(true);
    expect(mobileEvidenceTitle(dom)).toBe("Pending native evidence");
  });

  it("does not show a drill over another key's placeholder rows", () => {
    const first = pendingOsDecision();
    const loaded = workspaceResponse({ ads: [first] });
    state.workspaceData = loaded;
    const dom = render();
    openCreative(dom, first);

    // The same rows, but held for a key that is still loading.
    state.workspaceRead = () => ({
      data: loaded,
      status: "success",
      isFetching: true,
      isPlaceholderData: true,
    });
    rerender();

    expect(drawerIsOpen(dom)).toBe(false);
  });
});

describe("Show more decisions", () => {
  function clickShowMore(dom: HTMLElement) {
    act(() =>
      dom
        .querySelector<HTMLButtonElement>(
          "[data-meta-load-more-creatives] button",
        )!
        .click(),
    );
  }

  it("returns to the previous cap when the raised read fails, keeps the rows and says so", () => {
    const initial = workspaceResponse({
      ads: [pendingOsDecision()],
      eligiblePreCapCount: 140,
    });
    let raised: WorkspaceRead = {
      data: initial,
      status: "success",
      isFetching: true,
      isPlaceholderData: true,
    };
    state.workspaceRead = (key) =>
      key.at(-1) === 60 ? { data: initial, status: "success" } : raised;
    const dom = render();
    clickShowMore(dom);

    // In flight: the earlier rows are held, and nothing has failed yet.
    expect(workspaceKeys().at(-1)?.at(-1)).toBe(120);
    expect(mobileRowIds(dom)).toEqual(["os_pending_ad"]);
    expect(dom.querySelector("[data-meta-load-more-failed]")).toBeNull();

    // React Query's shape for the raised key failing: its placeholder is gone.
    raised = {
      data: undefined,
      error: new Error("workspace request failed"),
      status: "error",
      errorUpdatedAt: Date.now(),
    };
    rerender();

    expect(workspaceKeys().at(-1)?.at(-1)).toBe(60);
    expect(mobileRowIds(dom)).toEqual(["os_pending_ad"]);
    expect(dom.querySelector('[data-mobile-read-state="error"]')).toBeNull();
    expect(dom.querySelector('[data-testid="meta-briefing-error"]')).toBeNull();
    expect(
      dom.querySelector("[data-meta-load-more-failed]")?.textContent,
    ).toContain("More decisions could not be loaded.");
    expect(
      dom.querySelector("[data-mobile-load-more-failed]")?.textContent,
    ).toContain("The decisions already loaded are still shown.");

    // Settled once: further renders do not raise the cap again on their own.
    const requestedAfterRevert = workspaceKeys().length;
    rerender();
    rerender();
    expect(
      workspaceKeys()
        .slice(requestedAfterRevert)
        .every((key) => key.at(-1) === 60),
    ).toBe(true);

    // The control is still offered, and a successful retry clears the notice.
    const expanded = workspaceResponse({
      ads: [pendingOsDecision(), secondOsDecision()],
      eligiblePreCapCount: 140,
    });
    raised = { data: expanded, status: "success" };
    clickShowMore(dom);
    expect(workspaceKeys().at(-1)?.at(-1)).toBe(120);
    expect(mobileRowIds(dom)).toEqual(["os_pending_ad", "os_pending_ad_2"]);
    expect(dom.querySelector("[data-meta-load-more-failed]")).toBeNull();
    expect(dom.querySelector("[data-mobile-load-more-failed]")).toBeNull();
  });

  it("does not revert a raise over an error the raised key held before the click", () => {
    const initial = workspaceResponse({
      ads: [pendingOsDecision()],
      eligiblePreCapCount: 140,
    });
    const expanded = workspaceResponse({
      ads: [pendingOsDecision(), secondOsDecision()],
      eligiblePreCapCount: 140,
    });
    state.workspaceRead = (key) =>
      key.at(-1) === 60
        ? { data: initial, status: "success" }
        : // Cached rows for the raised cap, with a failure recorded long
          // before this click.
          {
            data: expanded,
            error: new Error("old failure"),
            status: "error",
            errorUpdatedAt: 1,
          };
    const dom = render();
    clickShowMore(dom);

    expect(workspaceKeys().at(-1)?.at(-1)).toBe(120);
    expect(mobileRowIds(dom)).toEqual(["os_pending_ad", "os_pending_ad_2"]);
    expect(dom.querySelector("[data-meta-load-more-failed]")).toBeNull();
  });

  it("expands when the raised read succeeds", () => {
    const initial = workspaceResponse({
      ads: [pendingOsDecision()],
      eligiblePreCapCount: 140,
    });
    const expanded = workspaceResponse({
      ads: [pendingOsDecision(), secondOsDecision()],
      eligiblePreCapCount: 140,
    });
    state.workspaceRead = (key) => ({
      data: key.at(-1) === 60 ? initial : expanded,
      status: "success",
    });
    const dom = render();
    clickShowMore(dom);
    rerender();

    expect(workspaceKeys().at(-1)?.at(-1)).toBe(120);
    expect(mobileRowIds(dom)).toEqual(["os_pending_ad", "os_pending_ad_2"]);
    expect(dom.querySelector("[data-meta-load-more-failed]")).toBeNull();
    expect(dom.querySelector("[data-mobile-load-more-failed]")).toBeNull();
  });
});

describe("the Show more cap belongs to one account and window", () => {
  it("starts another account, and a return to the first, from the default cap", () => {
    state.providerAccounts.push({
      id: "act_2",
      name: "Second Meta",
      currency: "USD",
      timezone: "UTC",
    });
    const responses = new Map<string, unknown>();
    state.workspaceRead = (key) => {
      const account = String(key[2]);
      const cacheKey = `${account}:${String(key.at(-1))}`;
      if (!responses.has(cacheKey)) {
        responses.set(
          cacheKey,
          workspaceResponse({
            ads: [pendingOsDecision({ providerAccountId: account })],
            eligiblePreCapCount: 140,
            providerAccountId: account,
          }),
        );
      }
      return { data: responses.get(cacheKey), status: "success" };
    };
    const dom = render();
    act(() =>
      dom
        .querySelector<HTMLButtonElement>(
          "[data-meta-load-more-creatives] button",
        )!
        .click(),
    );
    expect(workspaceKeys().at(-1)?.slice(2)).toEqual([
      "act_1",
      "28d",
      "active",
      expect.any(String),
      expect.any(String),
      120,
    ]);

    let firstRequestAfterSwitch = workspaceKeys().length;
    state.search =
      "providerAccountId=act_2&scope=creatives&area=monitor&segment=needs_resolution";
    rerender();
    const secondAccountKeys = workspaceKeys().slice(firstRequestAfterSwitch);
    expect(secondAccountKeys.length).toBeGreaterThan(0);
    // Not one request for the new account asked for the old account's cap.
    expect(secondAccountKeys.every((key) => key[2] === "act_2")).toBe(true);
    expect(secondAccountKeys.every((key) => key.at(-1) === 60)).toBe(true);

    firstRequestAfterSwitch = workspaceKeys().length;
    state.search = CREATIVES_NEEDS_RESOLUTION;
    rerender();
    const returnKeys = workspaceKeys().slice(firstRequestAfterSwitch);
    expect(returnKeys.length).toBeGreaterThan(0);
    expect(returnKeys.every((key) => key[2] === "act_1")).toBe(true);
    expect(returnKeys.every((key) => key.at(-1) === 60)).toBe(true);
  });

  it("starts a new date window from the default cap", () => {
    const initial = workspaceResponse({
      ads: [pendingOsDecision()],
      eligiblePreCapCount: 140,
    });
    state.workspaceRead = () => ({ data: initial, status: "success" });
    const dom = render();
    act(() =>
      dom
        .querySelector<HTMLButtonElement>(
          "[data-meta-load-more-creatives] button",
        )!
        .click(),
    );
    expect(workspaceKeys().at(-1)?.at(-1)).toBe(120);

    const firstRequestAfterSwitch = workspaceKeys().length;
    state.search = `${CREATIVES_NEEDS_RESOLUTION}&window=custom&startDate=2026-08-01&endDate=2026-08-31`;
    rerender();
    const windowKeys = workspaceKeys().slice(firstRequestAfterSwitch);
    expect(windowKeys.length).toBeGreaterThan(0);
    expect(
      windowKeys.every(
        (key) =>
          key[5] === "2026-08-01" && key[6] === "2026-08-31" && key.at(-1) === 60,
      ),
    ).toBe(true);
  });
});

describe("mobile creatives scope when nothing was served", () => {
  function unavailableSource() {
    const response: any = workspaceResponse({ ads: [] });
    response.decisionReadModel.status = "unavailable";
    response.decisionReadModel.source.status = "unavailable";
    response.decisionReadModel.source.fallbackReason = "native_latest_job_failed";
    // The server no longer counts an unreadable source as zero.
    response.os.ads.statePreCapCounts = null;
    response.os.ads.eligiblePreCapCount = null;
    return response;
  }

  it("states an unavailable source once, as the empty state, with unknown counts", () => {
    state.workspaceData = unavailableSource();
    const dom = render();
    const notice = dom.querySelector("[data-mobile-creatives-notice]");
    expect(notice?.textContent).toContain("Current creative decisions could not be verified");
    expect(dom.textContent).not.toContain("No decisions in this view");
    const scopeTabs = Array.from(
      dom.querySelectorAll('nav[aria-label="Decision scope"] button'),
    ).map((button) => button.textContent?.trim());
    expect(scopeTabs).toContain("Creatives —");
    expect(scopeTabs).not.toContain("Creatives 0");
  });

  it("keeps the lane's own empty card for a verified-empty source", () => {
    state.workspaceData = workspaceResponse({ ads: [] });
    const dom = render();
    expect(dom.querySelector("[data-mobile-creatives-notice]")).toBeNull();
    expect(dom.textContent).toContain("No decisions in this view");
  });
});

describe("mobile evidence prints Meta-reported checkout and purchase counts", () => {
  it("shows checkouts 0 and purchases 3 without a rate or an unknown marker", () => {
    const served = pendingOsDecision();
    state.workspaceData = workspaceResponse({ ads: [served] });
    state.evidenceAdRows = [
      {
        id: served.adId,
        adsetId: "adset_1",
        adsetName: "Broad",
        spend: 240,
        purchaseValue: 610,
        roas: 2.54,
        impressions: 20_000,
        linkClicks: 500,
        linkClicksObserved: true,
        landingPageViews: 400,
        landingPageViewsObserved: true,
        addToCart: 12,
        addToCartObserved: true,
        initiateCheckout: 0,
        initiateCheckoutObserved: true,
        purchases: 3,
        purchasesObserved: true,
        thumbstop: null,
        launchDate: "2026-07-01",
      },
    ];
    const dom = render();
    openCreative(dom, served);
    const text = dom
      .querySelector('[data-testid="meta-mobile-creative-evidence"]')!
      .textContent!.replace(/\s+/g, " ");
    expect(text).toContain("Checkout initiated: 0");
    expect(text).toContain("Purchases: 3");
    expect(text).toContain("Add to cart: 12 ATC 3.0%");
    expect(text).not.toContain("Checkout 0.0%");
    expect(text).not.toContain("CVR");
    // An empty rate slot is not an unknown value.
    expect(text).not.toMatch(/Checkout initiated: 0 —|Purchases: 3 —|Impressions: 20,000 —/);
    expect(text).toContain("Meta reports these events separately.");
  });
});
