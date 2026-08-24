// @vitest-environment jsdom
/**
 * Interactive wiring laws for the Meta Decisions surface.
 *
 * The sibling `MetaPlatformPage.test.tsx` renders to static markup, which is
 * the right tool for "what does this screen say" but cannot press a button or
 * run an effect. Everything here is about what happens *after* a click or a
 * deep link, so it needs a real DOM: Retry has to retry the read that failed,
 * a refused write must not read as a completed one, and a link that names a
 * creative has to open that creative.
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
  metaRec,
} from "@/components/meta/redesign/test-fixtures";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type {
  MetaOsAdDecision,
  MetaOsDecisionAction,
} from "@/lib/meta/decisions-os-contract";

const state = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  search: "window=28d",
  pathname: "/c/biz_1/meta/decisions",
  providerAccounts: [] as any[],
  workspaceData: undefined as unknown,
  canonicalCreatives: [] as any[],
  queryOverrides: {} as Record<
    string,
    { data?: unknown; error?: Error | null; isFetching?: boolean }
  >,
  refetched: [] as string[],
  queryKeys: [] as unknown[][],
  queryOptions: {} as Record<
    string,
    { retry?: unknown; refetchOnWindowFocus?: unknown }
  >,
  adapterInput: null as any,
  exactProps: null as any,
  overlayProps: null as any,
  evidenceProps: null as any,
}));

// `useSearchParams` must hand back a STABLE object across renders, as the real
// hook does. The page keeps an effect keyed on it, so a fresh URLSearchParams
// per render is an infinite render loop in the harness — a fixture defect, not
// a product one.
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
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (input: {
    queryKey: unknown[];
    retry?: unknown;
    refetchOnWindowFocus?: unknown;
  }) => {
    const key = String(input.queryKey[0]);
    state.queryKeys.push(input.queryKey);
    state.queryOptions[key] = {
      retry: input.retry,
      refetchOnWindowFocus: input.refetchOnWindowFocus,
    };
    const override = state.queryOverrides[key];
    const base =
      key === "meta-decisions-workspace"
        ? state.workspaceData
        : key === "meta-provider-accounts"
          ? state.providerAccounts
          : key === "meta-anomalies"
            ? EMPTY_ANOMALIES
            : key === "triage-state"
              ? EMPTY_TRIAGE
              : null;
    const error = override?.error ?? null;
    const hasDataOverride =
      override && Object.prototype.hasOwnProperty.call(override, "data");
    return {
      data: hasDataOverride ? override?.data : base,
      isLoading: false,
      isFetching: override?.isFetching ?? false,
      isError: Boolean(error),
      error,
      refetch: () => {
        state.refetched.push(key);
        return Promise.resolve({ data: undefined });
      },
    };
  },
}));

vi.mock("@/components/meta/decision-center/MetaDecisionCenterExact", () => ({
  MetaDecisionCenterExact: (props: any) => {
    state.exactProps = props;
    return React.createElement("div", {
      "data-stub-exact": "true",
      "data-stub-scope": props.scope,
      "data-stub-lane": props.lane,
    });
  },
}));

vi.mock("@/components/meta/redesign/MetaLaunchpadOverlay", () => ({
  MetaLaunchpadOverlay: (props: any) => {
    state.overlayProps = props;
    return props.open
      ? React.createElement(
          "button",
          {
            type: "button",
            "data-stub-overlay-confirm": "true",
            onClick: props.onConfirm,
          },
          "Confirm",
        )
      : null;
  },
}));

// The real adapter still runs; this only exposes the callbacks the page hands
// it, because those callbacks are the wiring under test and the view model
// only surfaces them on rows the OS structure payload happens to carry.
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

/**
 * Duplicated deliberately from MetaPlatformPage.test.tsx rather than exported
 * from it: importing one test file into another registers its suites twice.
 */
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
      provenance: { source: "engine_v3", asOf: "2026-07-10" },
    },
    parentChain: {
      account: { id: "act_1", name: "Main Meta" },
      campaign: { id: "cmp_1", name: "Prospecting" },
      adset: { id: "adset_1", name: "Broad" },
      ad: { id: "120000000000000001", name: "Hook Variant A" },
      creative: { id: "creative_1", name: "Hook Variant A" },
      provenance: { source: "engine_v3", asOf: "2026-07-10" },
    },
    media: {
      state: "available",
      missingMedia: false,
      thumbnail: { state: "available", url: null },
      provenance: { source: "engine_v3", asOf: "2026-07-10" },
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
      provenance: { source: "engine_v3", asOf: "2026-07-10" },
    },
    /*
     * The authority envelope a real canonical decision always carries.
     *
     * This fixture omitted `sourceAuthority` entirely, which was harmless only
     * while the page decided Launchpad eligibility from a hand-kept list of
     * presentation codes. It now runs `authorizeLaunchpadHandoff` — the same
     * function the mint endpoint runs — and that law reads THIS envelope: a
     * source that is not `native_exact`, `actionEligible` other than true, a
     * missing `authorizedAction`, or an authorized action with no Launchpad
     * mode each refuse the route by name.
     *
     * So the fixture states what the contract requires
     * (`MetaDecisionSourceAuthority`) for a decision that genuinely may route:
     * an exact native source, eligible, with `authorizedAction: "refresh"` —
     * which is what `launchpadModeForAuthorizedAction` maps to the `rebuild`
     * mode this test expects back from the server. Weakening any one of these
     * fields must close the control, and that is the property the sibling test
     * below asserts.
     */
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
      realAdId: "120000000000000001",
      authorizedAction: "refresh",
      jobRunId: "job_1",
    },
    deliveryScope: {
      state: "active",
      campaignStatus: "ACTIVE",
      adsetStatus: "ACTIVE",
      adStatus: "ACTIVE",
      reason: "active_hierarchy",
      provenance: { source: "engine_v3", asOf: "2026-07-10" },
    },
    riskTier: null,
    confirmationCeremony: "highest",
    riskTierProvenance: { source: "engine_v3", asOf: "2026-07-10" },
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

function structureAction(
  over: Partial<MetaOsDecisionAction> = {},
): MetaOsDecisionAction {
  return {
    code: "route_launchpad_rebuild",
    label: "Rebuild in Launchpad",
    intent: "launchpad",
    targetLevel: "campaign",
    providerMutation: null,
    scopeNote: "Opens a PAUSED rebuild draft for this campaign",
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

function osPresentation(items: MetaOsAdDecision[]) {
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
      actCount: items.filter((item) => item.lane === "act").length,
      blockedCount: items.filter((item) => item.lane === "blocked").length,
      monitorCount: items.filter((item) => item.lane === "monitor").length,
      statePreCapCounts: {
        act: items.filter((item) => item.lane === "act").length,
        blocked: items.filter((item) => item.lane === "blocked").length,
        monitor: items.filter((item) => item.lane === "monitor").length,
      },
      eligiblePreCapCount: items.length,
      omittedWithoutVerifiedAdId: 0,
      omittedAmbiguousIdentity: 0,
      omittedNotApplicable: 0,
      sourcePreCapCount: items.length,
    },
    limitations: [],
  };
}

function decisionReadModel(creatives: any[]) {
  return {
    contractVersion: "meta-decisions-workspace.read.v1",
    status: "available",
    generatedAt: "2026-07-10T12:00:00.000Z",
    scope: {
      businessId: "biz_1",
      providerAccountId: "act_1",
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

function workspacePayload(
  laneOverrides: Parameters<typeof metaLanePayload>[0] = {},
) {
  const pulse = metaPulse();
  const lanes = metaLanePayload(laneOverrides);
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
        launchpadRoutes: 1,
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
    decisionReadModel: decisionReadModel(state.canonicalCreatives),
    os: undefined,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(props: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" {...props} />,
    );
  });
  return container;
}

beforeEach(() => {
  state.routerPush.mockClear();
  state.routerReplace.mockClear();
  state.search = "window=28d";
  state.pathname = "/c/biz_1/meta/decisions";
  state.providerAccounts = [
    { id: "act_1", name: "Main Meta", currency: "USD", timezone: "UTC" },
  ];
  state.canonicalCreatives = [];
  state.workspaceData = undefined;
  state.queryOverrides = {};
  state.refetched = [];
  state.queryKeys = [];
  state.queryOptions = {};
  state.adapterInput = null;
  state.exactProps = null;
  state.overlayProps = null;
  state.evidenceProps = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("Decisions error recovery", () => {
  it("does not automatically repeat an expensive failed workspace fan-out", () => {
    render({ serverProviderAccountId: "act_server" });

    expect(state.queryOptions["meta-decisions-workspace"]?.retry).toBe(false);
    expect(
      state.queryOptions["meta-decisions-workspace"]?.refetchOnWindowFocus,
    ).toBe(false);
    expect(state.queryOptions["meta-provider-accounts"]?.retry).toBe(false);
  });

  // Law: Retry must retry the read that failed.
  //
  // The accounts read gates every workspace read, so when /api/meta/history/
  // accounts is the broken one the workspace query is disabled with a null
  // account. Retry always refetched the workspace, which in that state cannot
  // succeed — the operator was left with a dead button and only a full page
  // reload recovered the surface.
  it("refetches the accounts read when that is the read that failed", () => {
    state.queryOverrides = {
      "meta-provider-accounts": {
        data: undefined,
        error: new Error("meta_history_accounts_unavailable"),
      },
    };

    const dom = render();
    const retry = dom.querySelector<HTMLButtonElement>(
      '[data-testid="meta-briefing-retry"]',
    );
    expect(retry).not.toBeNull();
    act(() => retry!.click());

    expect(state.refetched).toContain("meta-provider-accounts");
    expect(state.refetched).not.toContain("meta-decisions-workspace");
  });

  // The other half of the same law: when accounts is healthy and the workspace
  // read is the failure, Retry must still go to the workspace.
  it("refetches the workspace read when accounts resolved and the workspace failed", () => {
    state.queryOverrides = {
      "meta-decisions-workspace": {
        data: undefined,
        error: new Error("workspace request failed"),
      },
    };

    const dom = render();
    act(() =>
      dom
        .querySelector<HTMLButtonElement>(
          '[data-testid="meta-briefing-retry"]',
        )!
        .click(),
    );

    expect(state.refetched).toEqual(["meta-decisions-workspace"]);
  });

  // Law: the server already knows the account, so a failing accounts read must
  // not empty the surface. `serverProviderAccountId` is a fallback only — the
  // server resolver refuses an unassigned id and refuses to choose for a
  // multi-account business, so it cannot widen scope.
  it("reads the workspace through the server-resolved account when the accounts read is down", () => {
    state.queryOverrides = {
      "meta-provider-accounts": {
        data: undefined,
        error: new Error("meta_history_accounts_unavailable"),
      },
    };
    state.workspaceData = workspacePayload();

    render({ serverProviderAccountId: "act_server" });

    // The client's own account list is empty (that read failed), yet the
    // workspace read still went out — against the account the server resolved.
    const workspaceKey = state.queryKeys.find(
      (key) => key[0] === "meta-decisions-workspace",
    );
    expect(workspaceKey).toBeDefined();
    expect(workspaceKey?.[2]).toBe("act_server");
  });
});

describe("Decision queue expansion and auxiliary failures", () => {
  it("asks the server for the next 60 creative decisions without appending locally", () => {
    const presentation = osPresentation([pendingOsDecision()]);
    presentation.ads.eligiblePreCapCount = 140;
    state.workspaceData = {
      ...(workspacePayload() as Record<string, unknown>),
      os: presentation,
    };
    state.search = "providerAccountId=act_1&scope=creatives";
    const dom = render();

    const initialWorkspaceKey = state.queryKeys
      .filter((key) => key[0] === "meta-decisions-workspace")
      .at(-1);
    expect(initialWorkspaceKey?.at(-1)).toBe(60);
    expect(state.adapterInput.overrides.creatives).toHaveLength(1);

    act(() => {
      dom
        .querySelector<HTMLButtonElement>(
          "[data-meta-load-more-creatives] button",
        )!
        .click();
    });

    const expandedWorkspaceKey = state.queryKeys
      .filter((key) => key[0] === "meta-decisions-workspace")
      .at(-1);
    expect(expandedWorkspaceKey?.at(-1)).toBe(120);
    expect(state.adapterInput.overrides.creatives).toHaveLength(1);
  });

  it("keeps the mobile decision queue readable when only anomalies fail", () => {
    state.workspaceData = {
      ...(workspacePayload() as Record<string, unknown>),
      os: osPresentation([pendingOsDecision()]),
    };
    state.queryOverrides["meta-anomalies"] = {
      error: new Error("Anomaly read timed out."),
    };
    const dom = render();

    expect(
      dom.querySelector("[data-mobile-anomaly-error]")?.textContent,
    ).toContain("Anomaly read timed out.");
    expect(dom.textContent).not.toContain("Decision queue unavailable.");
    expect(state.exactProps.viewModel.counts.creatives).toBe(1);
  });
});

describe("Decisions write honesty", () => {
  function actionableRec() {
    return metaRec({ id: "rec_rebuild", type: "rebuild_with_constraints" });
  }

  async function openAndConfirmOverlay() {
    state.workspaceData = workspacePayload();
    const dom = render();
    await act(async () => {
      state.adapterInput.callbacks.onStructurePrimary(
        actionableRec(),
        structureAction(),
      );
    });
    const confirm = dom.querySelector<HTMLButtonElement>(
      "[data-stub-overlay-confirm]",
    );
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm!.click();
      await Promise.resolve();
    });
    return dom;
  }

  it("obeys the served action tuple when a legacy route hint was downgraded to review", async () => {
    state.workspaceData = workspacePayload();
    const dom = render();
    const recommendation = actionableRec();
    await act(async () => {
      state.adapterInput.callbacks.onStructurePrimary(
        recommendation,
        structureAction({
          code: "review_commercial_truth",
          label: "Review Commercial Truth",
          intent: "review",
          providerMutation: null,
          scopeNote:
            "Current target ROAS authority is unavailable; no Scale action is authorized",
        }),
      );
    });

    expect(state.overlayProps.open).toBe(false);
    expect(state.routerPush).not.toHaveBeenCalled();
    const notice = dom.querySelector('[data-testid="meta-decision-notice"]');
    expect(notice?.textContent).toContain("Recommendation is review-only.");
    expect(notice?.textContent).toContain(
      "Current target ROAS authority is unavailable",
    );
    expect(state.adapterInput.selection).toEqual({
      kind: "structure",
      recommendationId: "rec_rebuild",
    });
  });

  // Opening a manual Launchpad wizard is navigation, not an operator outcome.
  // Recording `acted` here contaminated outcome accrual before any launch or
  // provider receipt existed. The decision remains queued until a real action
  // produces its own durable receipt.
  // A campaign/ad-set recommendation has no canonical ad-grain decision behind
  // it, so no server-verified handoff can be minted for it and NO decision
  // lineage travels to Launchpad. The old URL pretended otherwise
  // (`fromMetaBriefing=true&campaignIds=…`), Launchpad refused the pretence and
  // dropped every id, and the operator landed on an empty "Source & mode"
  // screen blaming their own link. The correct law is: route onward, and say
  // out loud what did not come with you. So the notice is now REQUIRED here,
  // and the URL must carry no lineage claim.
  it("routes to manual Launchpad without recording a false acted outcome", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const dom = await openAndConfirmOverlay();

    expect(state.routerPush).toHaveBeenCalledTimes(1);
    const href = String(state.routerPush.mock.calls[0]?.[0]);
    expect(href).toContain("/meta/launchpad?");
    // No fabricated lineage: these are the exact parameters Launchpad reads as
    // a decision handoff and then refuses.
    expect(href).not.toContain("fromMetaBriefing");
    expect(href).not.toContain("sourceDecisionId");
    expect(href).not.toContain("campaignIds");
    expect(href).not.toContain("adsetIds");
    // It does carry the manual start Launchpad can honour.
    expect(href).toContain("launchpadMode=new_campaign");
    expect(
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes("/api/meta/recommendations/respond"),
      ),
    ).toHaveLength(0);

    const notice = dom.querySelector('[data-testid="meta-decision-notice"]');
    expect(notice?.textContent).toContain(
      "Launchpad opened without decision lineage.",
    );
  });
});

describe("Decisions deep links", () => {
  // Law: a link that names a creative opens that creative.
  //
  // `decisionsHrefForCreative` is a live producer of `creativeId` and
  // `row=ad:<adId>` and nothing on this screen read either one, so "Open in
  // Decisions" from a creative row landed on Campaigns & Ad sets with nothing
  // selected — exactly the failure that link's own contract says it guards
  // against.
  it("opens the creatives scope and the named creative's evidence from row=ad:<id>", async () => {
    state.canonicalCreatives = [canonicalDecision()];
    state.workspaceData = workspacePayload();
    state.search =
      "providerAccountId=act_1&creativeId=creative_1&row=ad:120000000000000001";

    const dom = render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(state.exactProps.scope).toBe("creatives");
    expect(dom.querySelector("[data-stub-evidence]")).not.toBeNull();
    expect(state.evidenceProps).not.toBeNull();
  });

  it("restores an OS-only pending-native Ad without inventing a canonical envelope", async () => {
    const pending = pendingOsDecision();
    state.canonicalCreatives = [];
    state.workspaceData = {
      ...(workspacePayload() as Record<string, unknown>),
      os: osPresentation([pending]),
    };
    state.search =
      "providerAccountId=act_1&scope=creatives&creativeId=creative_pending&row=ad:ad_pending";

    const dom = render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(state.exactProps.scope).toBe("creatives");
    expect(dom.querySelector("[data-stub-evidence]")).not.toBeNull();
    expect(state.evidenceProps.viewModel.coverage?.state).toBe("served-only");
    expect(
      state.evidenceProps.viewModel.primaryAction?.onClick,
    ).toBeUndefined();
    expect(
      dom.querySelector('[data-testid="meta-decision-notice"]'),
    ).toBeNull();
  });

  // The same law's honest half: a link naming a creative the served universe
  // does not contain opens no drill at all. Never invent a decision to satisfy
  // a URL.
  it("opens no evidence when the named creative is not in the served universe", async () => {
    state.canonicalCreatives = [canonicalDecision()];
    state.workspaceData = workspacePayload();
    state.search = "providerAccountId=act_1&row=ad:999_not_served";

    const dom = render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(state.exactProps.scope).toBe("creatives");
    expect(dom.querySelector("[data-stub-evidence]")).toBeNull();
  });

  // Law: the retired lane vocabulary (act|test|watch) must be mapped or
  // ignored on purpose, never silently. `lane=watch` used to fall through to
  // the default and render Action Now, so a link that said Watching showed the
  // recipient a different lane.
  it("maps a retired lane=watch link onto the Watching lane", () => {
    state.workspaceData = workspacePayload();
    state.search = "lane=watch";

    render();

    expect(state.exactProps.lane).toBe("watching");
  });
});

/**
 * The deep-link compatibility matrix, one parameter at a time.
 *
 * The retired Decisions contract (lib/zero-base/meta/decisions-url-state.ts)
 * minted `lane`, `levels`, `q` and `row`, and those links are still in
 * circulation. Each parameter gets its own case here because "the link mostly
 * works" is how a dropped filter hides: an operator pastes a link, sees a
 * plausible screen, and never learns that half of what they sent was thrown
 * away.
 *
 * THE LAW: a parameter is either restored, or the screen says what it did
 * instead. There is no third option, and silence always means "restored".
 */
describe("Decisions deep-link compatibility matrix", () => {
  function noticeText(dom: HTMLElement) {
    return (
      dom.querySelector('[data-testid="meta-decision-notice"]')?.textContent ??
      ""
    );
  }

  it("restores lane=act as Action now and says nothing, because nothing was lost", () => {
    state.workspaceData = workspacePayload();
    state.search = "lane=act";
    const dom = render();
    expect(state.exactProps.lane).toBe("action");
    expect(noticeText(dom)).toBe("");
  });

  it("restores lane=watch as Watching and says nothing", () => {
    state.workspaceData = workspacePayload();
    state.search = "lane=watch";
    const dom = render();
    expect(state.exactProps.lane).toBe("watching");
    expect(noticeText(dom)).toBe("");
  });

  // `lane=test` is the one retired lane with no counterpart: this queue serves
  // Action now / Watching / Healthy / Non-sales / Inactive, and test decisions
  // live inside Action now. Collapsing it silently is exactly the failure this
  // matrix exists to prevent.
  it("states that lane=test collapsed into Action now instead of silently defaulting", () => {
    state.workspaceData = workspacePayload();
    state.search = "lane=test";
    const dom = render();
    expect(state.exactProps.lane).toBe("action");
    const text = noticeText(dom);
    expect(text).toContain("could not be restored");
    expect(text).toContain("lane=test");
    expect(text).toContain("no separate Test lane");
  });

  it("states that an unrecognised lane was not honoured", () => {
    state.workspaceData = workspacePayload();
    state.search = "lane=whatever";
    const dom = render();
    expect(state.exactProps.lane).toBe("action");
    expect(noticeText(dom)).toContain("lane=whatever");
  });

  // `levels` has no counterpart at all — this surface shows every level. The
  // old contract let a link say "campaigns only"; honouring the URL silently
  // would show an operator every ad row under a link that promised none.
  it("states that levels was not applied because there is no level filter", () => {
    state.workspaceData = workspacePayload();
    state.search = "levels=campaign,adset";
    const dom = render();
    const text = noticeText(dom);
    expect(text).toContain("levels=campaign,adset");
    expect(text).toContain("no level filter");
  });

  // `q` IS restorable: the queue has a row search. So it is restored, and the
  // matrix stays silent about it.
  it("restores q into the row search and says nothing about it", () => {
    state.workspaceData = workspacePayload({
      actionNow: [
        metaRec({
          id: "rec_keep",
          campaignId: "cmp_keep",
          campaignName: "ASC Prospecting",
          title: "ASC Prospecting needs a cleaner rebuild",
        }),
        metaRec({
          id: "rec_drop",
          campaignId: "cmp_drop",
          campaignName: "Retargeting Warm",
          title: "Retargeting Warm needs a cleaner rebuild",
        }),
      ],
    });
    state.search = "q=Prospecting";
    const dom = render();
    // The restored term is observable where it does its work: the rows the
    // adapter is handed are already filtered by it.
    expect(
      state.adapterInput.overrides.actionNow.map((row: any) => row.id),
    ).toEqual(["rec_keep"]);
    expect(noticeText(dom)).toBe("");
  });

  it("bounds a restored q rather than carrying an unbounded term", () => {
    state.workspaceData = workspacePayload({
      actionNow: [
        metaRec({
          id: "rec_keep",
          campaignName: "ASC Prospecting",
          title: "ASC Prospecting needs a cleaner rebuild",
        }),
      ],
    });
    // An unbounded term is not a search. Bounded at 128, so a 400-character
    // term matches nothing rather than riding on into every link this screen
    // mints back out.
    state.search = `q=${"x".repeat(400)}`;
    render();
    expect(state.adapterInput.overrides.actionNow).toEqual([]);
  });

  // `row` is half-supported: `ad:<id>` names something this queue can open,
  // anything else does not. The supported half is covered by "opens the
  // creatives scope…" above; this is the unsupported half, which must be
  // stated rather than ignored.
  it("states that a non-ad row key selected nothing", () => {
    state.workspaceData = workspacePayload();
    state.search = "row=campaign:cmp_1";
    const dom = render();
    const text = noticeText(dom);
    expect(text).toContain("row=campaign:cmp_1");
    expect(text).toContain("row=ad:<adId>");
  });

  it("states that row=ad: with no id selected nothing", () => {
    state.workspaceData = workspacePayload();
    state.search = "row=ad:";
    const dom = render();
    expect(noticeText(dom)).toContain("names no ad id");
  });

  it("restores scope=creatives and says nothing", () => {
    state.workspaceData = workspacePayload();
    state.search = "scope=creatives";
    const dom = render();
    expect(state.exactProps.scope).toBe("creatives");
    expect(noticeText(dom)).toBe("");
  });

  it("states that an unrecognised scope opened Campaigns & ad sets", () => {
    state.workspaceData = workspacePayload();
    state.search = "scope=budgets";
    const dom = render();
    expect(state.exactProps.scope).toBe("structure");
    expect(noticeText(dom)).toContain("scope=budgets");
  });

  // entity: the restored half. `?entity=<recId>` opens that recommendation's
  // evidence when the workspace served it.
  it("restores entity=<id> by opening the named recommendation", async () => {
    state.workspaceData = workspacePayload({
      actionNow: [metaRec({ id: "rec_entity" })],
    });
    state.search = "entity=rec_entity";
    const dom = render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      dom.querySelector('[data-testid="meta-mobile-evidence"]'),
    ).not.toBeNull();
    expect(noticeText(dom)).toBe("");
  });

  // entity: the unserved half. Refusing to fabricate a row is correct, but
  // refusing SILENTLY looks identical to the parameter being ignored — the
  // operator cannot tell whether the link was wrong, the window was wrong, or
  // the screen was broken.
  it("states that an entity the workspace did not serve opened nothing", async () => {
    state.workspaceData = workspacePayload({
      actionNow: [metaRec({ id: "rec_served" })],
    });
    state.search = "entity=rec_missing";
    const dom = render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      dom.querySelector('[data-testid="meta-mobile-evidence"]'),
    ).toBeNull();
    const text = noticeText(dom);
    expect(text).toContain("entity=rec_missing");
    expect(text).toContain("did not serve that decision");
  });

  it("states that a creative selection the workspace did not serve opened nothing", async () => {
    state.canonicalCreatives = [canonicalDecision()];
    state.workspaceData = workspacePayload();
    state.search = "row=ad:999_not_served&creativeId=creative_missing";
    const dom = render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(dom.querySelector("[data-stub-evidence]")).toBeNull();
    const text = noticeText(dom);
    expect(text).toContain("row=ad:999_not_served");
    expect(text).toContain("creativeId=creative_missing");
  });

  it("says nothing when a creative selection the workspace DID serve opened", async () => {
    state.canonicalCreatives = [canonicalDecision()];
    state.workspaceData = workspacePayload();
    state.search = "creativeId=creative_1&row=ad:120000000000000001";
    const dom = render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(dom.querySelector("[data-stub-evidence]")).not.toBeNull();
    expect(noticeText(dom)).toBe("");
  });
});

/**
 * A metadata read failure must not poison a workspace that can load.
 *
 * `/api/meta/history/accounts` supplies an account's NAME, CURRENCY and TIME
 * ZONE. It does not decide whether the caller may read decisions — that is
 * `serverProviderAccountId`, resolved server-side and assignment-verified.
 * Folding its error into the global briefing state meant one broken metadata
 * read printed "Decision workspace could not load" over a screen whose
 * decisions had already arrived.
 */
describe("Decisions provider-account metadata degradation", () => {
  const accountsDown = {
    "meta-provider-accounts": {
      data: undefined,
      error: new Error("meta_history_accounts_unavailable"),
    },
  };

  it("keeps a loaded workspace readable and shows only a narrow metadata warning", () => {
    state.queryOverrides = { ...accountsDown };
    state.workspaceData = workspacePayload();

    const dom = render({ serverProviderAccountId: "act_server" });

    // Not the blocking banner, and not the mobile full-screen error.
    expect(dom.querySelector('[data-testid="meta-briefing-error"]')).toBeNull();
    expect(dom.textContent).not.toContain("Decision workspace could not load.");
    // The narrow one, which names the account record rather than the workspace.
    const warning = dom.querySelector(
      '[data-testid="meta-account-metadata-warning"]',
    );
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("Account details are unavailable.");
    // The workspace itself still rendered.
    expect(dom.querySelector("[data-stub-exact]")).not.toBeNull();
  });

  // The metadata query is not a source of scope. The workspace read must go
  // out against the server-resolved account even while the metadata read is
  // failing.
  it("still issues the workspace read against the server-resolved account", () => {
    state.queryOverrides = { ...accountsDown };
    state.workspaceData = workspacePayload();

    render({ serverProviderAccountId: "act_server" });

    const workspaceKey = state.queryKeys.find(
      (key) => key[0] === "meta-decisions-workspace",
    );
    expect(workspaceKey?.[2]).toBe("act_server");
  });

  // Missing metadata is an em-dash, never a guess. The account label must not
  // fall back to an invented name and the currency must not fall back to USD.
  it("leaves the account label unnamed rather than inventing one", () => {
    state.queryOverrides = { ...accountsDown };
    state.workspaceData = workspacePayload();

    render({ serverProviderAccountId: "act_server" });

    expect(state.adapterInput.account).toBeNull();
  });

  // The other half: with no account resolved at all there IS no workspace to
  // protect, so the metadata failure is genuinely the reason nothing can load
  // and it stays the blocking answer.
  it("keeps the blocking banner when no account is resolved at all", () => {
    state.queryOverrides = { ...accountsDown };
    state.providerAccounts = [];

    const dom = render();

    expect(
      dom.querySelector('[data-testid="meta-briefing-error"]'),
    ).not.toBeNull();
    expect(
      dom.querySelector('[data-testid="meta-account-metadata-warning"]'),
    ).toBeNull();
    // And it must not offer "No assigned account" as if the read had
    // succeeded and returned nothing.
    expect(
      dom.querySelector('[data-testid="meta-account-required"]'),
    ).toBeNull();
  });

  it("retries the metadata read from its own narrow warning", () => {
    state.queryOverrides = { ...accountsDown };
    state.workspaceData = workspacePayload();

    const dom = render({ serverProviderAccountId: "act_server" });
    act(() =>
      dom
        .querySelector<HTMLButtonElement>(
          '[data-testid="meta-account-metadata-retry"]',
        )!
        .click(),
    );

    expect(state.refetched).toEqual(["meta-provider-accounts"]);
  });
});

describe("mobile served structure inventory", () => {
  it("mounts the complete read-only census only after the operator opens it", () => {
    state.workspaceData = workspacePayload({
      structureInventory: [
        {
          id: "camp_inventory",
          level: "campaign",
          name: "Inventory Campaign",
          campaignId: "camp_inventory",
          campaignName: "Inventory Campaign",
          campaignKind: "main",
          status: "ACTIVE",
          statusLabel: "Active",
          metrics: {
            spend: 120,
            purchases: 4,
            roas: 3.5,
            cpa: 30,
            ctr: 1.25,
            frequency: null,
          },
          entityConfiguration: {
            source: "account_scoped_campaign_row",
            budgetOwner: "campaign",
            budgetMode: "campaign_budget",
            controlOwner: "campaign",
            status: "ACTIVE",
            optimizationGoal: "PURCHASE",
            bidStrategyType: "lowest_cost",
            bidStrategyLabel: "Lowest Cost",
            dailyBudget: null,
            lifetimeBudget: null,
            budgetUtilization: null,
          },
        },
      ],
    });
    const dom = render({ currency: "USD" });
    const disclosure = dom.querySelector<HTMLDetailsElement>(
      "[data-mobile-structure-inventory]",
    )!;

    expect(disclosure).not.toBeNull();
    expect(disclosure.textContent).toContain("1 served");
    expect(
      disclosure.querySelector("[data-mobile-structure-inventory-row]"),
    ).toBeNull();

    act(() => {
      disclosure.open = true;
      disclosure.dispatchEvent(new Event("toggle", { bubbles: true }));
    });

    const row = disclosure.querySelector(
      '[data-mobile-structure-inventory-row="campaign:camp_inventory"]',
    );
    expect(row?.textContent).toContain("Inventory Campaign");
    expect(row?.textContent).toContain("Spend $120");
    expect(row?.textContent).toContain("ROAS 3.50");
    expect(row?.textContent).toContain("Purchases 4");
    expect(row?.textContent).toContain("CPA $30");
    expect(row?.textContent).toContain("CTR 1.25%");
    expect(row?.textContent).toContain("Lowest Cost");
    // Inventory is visibility, not authority.
    expect(disclosure.querySelector("button")).toBeNull();
    expect(disclosure.querySelector("a")).toBeNull();
  });
});

/**
 * The Decisions -> Launchpad handoff, from the click.
 *
 * A URL must not mint authority, so the click asks the server for a handoff
 * record and navigates only on the server's answer.
 */
describe("Decisions to Launchpad handoff", () => {
  /**
   * The evidence window's primary only offers a route for a SERVED action
   * code, so the harness has to serve one. `refresh_creative` is the rebuild
   * case; without this presentation row the primary is inert and a test that
   * clicked it would be asserting against a button that was never wired.
   */
  function servedRefreshPresentation() {
    return {
      id: "os_ad_1",
      decisionId: "mdd_1",
      sourceSnapshotId: "snapshot_1",
      episodeId: "mde_1",
      providerAccountId: "act_1",
      adId: "120000000000000001",
      adName: "Hook Variant A",
      campaignId: "cmp_1",
      campaignName: "Prospecting",
      adsetId: "adset_1",
      adsetName: "Broad",
      creativeId: "creative_1",
      creativeName: "Hook Variant A",
      thumbnailUrl: null,
      lifecycleRole: "test",
      campaignRoleSource: "automatic",
      campaignRoleConfidence: "high",
      campaignRoleTrustedForAction: true,
      /*
       * The action tuple in the shape the contract actually serves
       * (`MetaOsDecisionAction`). This fixture carried `{code, label, kind:
       * "route_launchpad"}` — a `kind` field no producer emits and no consumer
       * reads — while the served tuple has `intent`, `targetLevel`,
       * `providerMutation` and `scopeNote`. It travels to the callback
       * boundary by reference now, so a fixture missing three of its six
       * fields would have proved the carry against a shape that does not
       * exist. `intent: "brief"` is what `decisions-os-presentation.ts` really
       * serves for `refresh_creative`, and it is deliberately NOT what grants
       * the route: eligibility comes from `sourceAuthority`, never from this.
       */
      action: {
        code: "refresh_creative",
        label: "Refresh creative",
        intent: "brief",
        targetLevel: "ad",
        providerMutation: null,
        scopeNote: "Creates a replacement brief; does not pause this ad",
      },
      lane: "act",
      priority: "high",
      assessment: "fatigued_former_winner",
      confidence: "high",
      confidenceScore: 0.9,
      riskTier: "low",
      confirmationCeremony: "standard",
      whyNow: "Fatigue is measurable.",
      blockers: [],
      resolution: null,
      metrics: {},
      rawLabel: "refresh",
      publishedLabel: "Refresh",
    } as any;
  }

  function exactCutCanonical() {
    const base = canonicalDecision();
    return {
      ...base,
      identityResolution: {
        basis: "native_ad_exact",
        candidateAdCount: 1,
        metricsEquivalent: true,
        adActionEligible: true,
      },
      sourceDecision: {
        ...base.sourceDecision,
        label: "cut",
        preAuthorityLabel: "cut",
        rawLabel: "cut",
      },
      classification: {
        ...base.classification,
        assessment: "fatigued_loser",
        legacyBuyerAction: "cut",
        buyerAction: "cut",
        buyerLabel: "Cut",
        executionAction: "pause",
      },
      sourceAuthority: {
        ...base.sourceAuthority,
        authorizedAction: "cut",
        decisionHash: "a".repeat(64),
      },
    };
  }

  function servedCutPresentation(): MetaOsAdDecision {
    return {
      ...(servedRefreshPresentation() as MetaOsAdDecision),
      action: {
        code: "cut",
        label: "Cut",
        intent: "execute",
        targetLevel: "ad",
        providerMutation: "pause",
        scopeNote: "Pauses this exact ad only",
      },
      lane: "act",
      assessment: "fatigued_loser",
      blockers: [],
      resolution: null,
      decisionAvailability: "available",
    };
  }

  async function openExactCutEvidence(
    fetchImpl: unknown,
    options: { trackingBlocked?: boolean } = {},
  ) {
    vi.stubGlobal("fetch", fetchImpl);
    const canonical = exactCutCanonical();
    const decision = servedCutPresentation();
    state.canonicalCreatives = [canonical];
    const workspace = workspacePayload();
    state.workspaceData = {
      ...workspace,
      system: {
        ...workspace.system,
        trackingBlocked: options.trackingBlocked ?? false,
      },
      os: osPresentation([decision]),
    };
    state.search = "providerAccountId=act_1&creativeId=creative_1";
    const dom = render();
    await act(async () => {
      await Promise.resolve();
    });
    const primary = state.evidenceProps?.viewModel?.primaryAction;
    expect(primary?.label).toBe("Cut");
    expect(primary?.onClick).toBeTypeOf("function");
    return { dom, primary };
  }

  async function openEvidenceAndClickPrimary(fetchImpl: unknown) {
    vi.stubGlobal("fetch", fetchImpl);
    state.canonicalCreatives = [canonicalDecision()];
    state.workspaceData = {
      ...(workspacePayload() as Record<string, unknown>),
      os: {
        contractVersion: "meta-os-decisions.presentation.v5",
        generatedAt: "2026-08-17T10:00:00.000Z",
        source: {
          snapshotAsOf: "2026-08-16",
          engineVersion: "server-engine-v1",
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
          items: [servedRefreshPresentation()],
          actCount: 1,
          blockedCount: 0,
          monitorCount: 0,
          statePreCapCounts: { act: 1, blocked: 0, monitor: 0 },
          eligiblePreCapCount: 1,
          omittedWithoutVerifiedAdId: 0,
          omittedAmbiguousIdentity: 0,
          omittedNotApplicable: 0,
          sourcePreCapCount: 1,
        },
        limitations: [],
      },
    };
    state.search = "providerAccountId=act_1&creativeId=creative_1";
    const dom = render();
    await act(async () => {
      await Promise.resolve();
    });
    const onPrimary =
      state.evidenceProps?.viewModel?.primaryAction?.onClick ?? null;
    // No escape hatch: an inert primary is a wiring failure, not a skip.
    expect(onPrimary).toBeTypeOf("function");
    // And it must be a control, not a link — the destination does not exist
    // until the server mints it.
    expect(state.evidenceProps.viewModel.primaryAction.href).toBeNull();
    return { dom, onPrimary: onPrimary as () => void };
  }

  it("does not mint a Scale handoff when the served action is review-only", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const canonical = canonicalDecision({
      sourceAuthority: {
        ...canonicalDecision().sourceAuthority,
        authorizedAction: "scale",
      },
    });
    const decision = {
      ...servedRefreshPresentation(),
      action: {
        code: "protect",
        label: "Keep Running",
        intent: "none",
        targetLevel: "ad",
        providerMutation: null,
        scopeNote: "Main creative remains active",
      },
    } as MetaOsAdDecision;
    state.canonicalCreatives = [canonical];
    state.workspaceData = {
      ...(workspacePayload() as Record<string, unknown>),
      os: osPresentation([decision]),
    };
    state.search = "providerAccountId=act_1&creativeId=creative_1";

    render();
    await act(async () => {
      await Promise.resolve();
    });

    expect(state.evidenceProps?.viewModel?.primaryAction?.label).toBe(
      "Keep Running",
    );
    expect(
      state.evidenceProps?.viewModel?.primaryAction?.onClick,
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mints the handoff server-side and navigates with only the reference", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        handoff: "0f1e2d3c-4b5a-4c7d-8e9f-a0b1c2d3e4f5.tok",
        mode: "rebuild",
      }),
    });
    const { onPrimary } = await openEvidenceAndClickPrimary(fetchMock);
    await act(async () => {
      onPrimary();
      await Promise.resolve();
    });

    const call = fetchMock.mock.calls.find(
      (args) => String(args[0]) === "/api/meta/launchpad-handoff",
    );
    expect(call).toBeDefined();
    expect(String(call![1].method)).toBe("POST");
    // The body NAMES a decision and asserts nothing about it.
    expect(JSON.parse(String(call![1].body))).toEqual({
      businessId: "biz_1",
      providerAccountId: "act_1",
      decisionId: "mdd_1",
      sourceSnapshotId: "snapshot_1",
    });

    const href = String(state.routerPush.mock.calls.at(-1)?.[0]);
    expect(href).toContain("handoff=");
    // None of the old claims travel.
    expect(href).not.toContain("fromMetaBriefing");
    expect(href).not.toContain("sourceDecisionId");
    expect(href).not.toContain("creativeIds");
    expect(href).not.toContain("mode=");
  });

  it("mints only one handoff under rapid double activation", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { onPrimary } = await openEvidenceAndClickPrimary(fetchMock);

    act(() => {
      onPrimary();
      onPrimary();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch?.({
        ok: true,
        status: 200,
        json: async () => ({
          handoff: "0f1e2d3c-4b5a-4c7d-8e9f-a0b1c2d3e4f5.tok",
          mode: "rebuild",
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.routerPush).toHaveBeenCalledTimes(1);
  });

  it("stays put and states the server's reason when the handoff is refused", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: "decision_held",
        message: "The decision is held, so it maps to no launch.",
      }),
    });
    const { dom, onPrimary } = await openEvidenceAndClickPrimary(fetchMock);
    await act(async () => {
      onPrimary();
      await Promise.resolve();
    });

    expect(state.routerPush).not.toHaveBeenCalled();
    const notice = dom.querySelector('[data-testid="meta-decision-notice"]');
    expect(notice?.textContent).toContain("Launchpad handoff refused.");
    expect(notice?.textContent).toContain("held");
    // The refusal names the control that was refused, in the SERVER's words —
    // its label, its code and its intent, straight off the tuple that
    // travelled to this handler. Nothing here is composed from the decision
    // label.
    expect(notice?.textContent).toContain("Refresh creative");
    expect(notice?.textContent).toContain("refresh_creative");
    expect(notice?.textContent).toContain("intent brief");
  });

  it("confirms one exact native Ad pause with immutable lineage and no manual claims", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { dom, primary } = await openExactCutEvidence(fetchMock);

    await act(async () => {
      primary.onClick();
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = dom.querySelector("[data-meta-native-ad-pause-dialog]");
    expect(dialog?.textContent).toContain("Pause this exact Meta Ad?");

    const confirm = dom.querySelector<HTMLButtonElement>(
      "[data-meta-native-ad-pause-confirm]",
    )!;
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/meta/ads/120000000000000001/pause");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      contractVersion: "meta-decision-origin-ad-execution.v1",
      actionOrigin: "native_decision_v1",
      businessId: "biz_1",
      providerAccountId: "act_1",
      adId: "120000000000000001",
      creativeId: "creative_1",
      snapshotId: "snapshot_1",
      evaluationId: "eval_1",
      engineVersion: "v3-test",
      decisionHash: "a".repeat(64),
      action: "pause",
    });
    expect(body.idempotencyKey).toBe(
      `decision-ad-action:biz_1:act_1:120000000000000001:pause:snapshot_1:eval_1:v3-test:${"a".repeat(64)}:execute`,
    );
    expect(body).not.toHaveProperty("actionKind");
    expect(body).not.toHaveProperty("buyerAction");
    expect(body).not.toHaveProperty("confirmation");

    await act(async () => {
      resolveFetch?.({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          action: "pause",
          adId: "120000000000000001",
          status: "PAUSED",
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dom.querySelector("[data-meta-native-ad-pause-dialog]")).toBeNull();
    expect(dom.querySelector("[data-stub-evidence]")).toBeNull();
    expect(
      dom.querySelector('[data-testid="meta-decision-notice"]')?.textContent,
    ).toContain("Exact Ad paused.");
    // Provider execution is not an operator-response shortcut.
    expect(
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).includes("/api/meta/recommendations/response"),
      ),
    ).toHaveLength(0);
  });

  it("requires the tracking interstitial before the exact-Ad pause confirmation", async () => {
    const fetchMock = vi.fn();
    const { dom, primary } = await openExactCutEvidence(fetchMock, {
      trackingBlocked: true,
    });

    await act(async () => {
      primary.onClick();
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dom.querySelector("[data-modal='tracking-confirm']")).not.toBeNull();
    expect(dom.querySelector("[data-meta-native-ad-pause-dialog]")).toBeNull();

    act(() => {
      dom.querySelector<HTMLButtonElement>("[data-tracking-continue]")!.click();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dom.querySelector("[data-modal='tracking-confirm']")).toBeNull();
    expect(
      dom.querySelector("[data-meta-native-ad-pause-dialog]"),
    ).not.toBeNull();
  });

  it("keeps reconciliation visible, makes no retry, and allows cancel with zero writes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        error: {
          code: "provider_outcome_ambiguous",
          message: "Meta accepted the request but verification is incomplete.",
        },
        reconciliationRequired: true,
        retryAllowed: false,
        providerOutcomeAmbiguous: true,
      }),
    });
    const { dom, primary } = await openExactCutEvidence(fetchMock);

    await act(async () => {
      primary.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      dom
        .querySelector<HTMLButtonElement>(
          "[data-meta-native-ad-pause-confirm]",
        )!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const error = dom.querySelector("[data-meta-native-ad-pause-error]");
    expect(error?.textContent).toContain("verification is incomplete");
    expect(error?.textContent).toContain("requires reconciliation");
    expect(error?.textContent).toContain("Do not retry");
    expect(
      dom.querySelector("[data-meta-native-ad-pause-dialog]"),
    ).not.toBeNull();

    act(() => {
      dom
        .querySelector<HTMLButtonElement>(".meta-label-modal .btn--ghost")!
        .click();
    });
    expect(dom.querySelector("[data-meta-native-ad-pause-dialog]")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows verified provider success during receipt reconciliation and locks the same request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        error: {
          code: "provider_verification_persistence_failed",
          message:
            "The prior receipt still requires reconciliation; no new provider write was attempted.",
        },
        reconciliationRequired: true,
        retryAllowed: false,
        providerMutationSucceeded: true,
        providerOutcomeAmbiguous: false,
      }),
    });
    const { dom, primary } = await openExactCutEvidence(fetchMock);

    await act(async () => {
      primary.onClick();
      await Promise.resolve();
    });
    const confirm = dom.querySelector<HTMLButtonElement>(
      "[data-meta-native-ad-pause-confirm]",
    )!;
    await act(async () => {
      confirm.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const error = dom.querySelector("[data-meta-native-ad-pause-error]");
    expect(error?.textContent).toContain("Provider mutation status: succeeded");
    expect(error?.textContent).toContain("requires reconciliation");
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toContain("Await fresh read-back");

    act(() => confirm.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a non-retryable in-flight response from reconciliation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        error: {
          code: "action_in_flight",
          message: "This exact Ad action is already in flight.",
        },
        retryAllowed: false,
      }),
    });
    const { dom, primary } = await openExactCutEvidence(fetchMock);

    await act(async () => {
      primary.onClick();
      await Promise.resolve();
    });
    await act(async () => {
      dom
        .querySelector<HTMLButtonElement>(
          "[data-meta-native-ad-pause-confirm]",
        )!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const error = dom.querySelector("[data-meta-native-ad-pause-error]");
    expect(error?.textContent).toContain("already in flight");
    expect(error?.textContent).toContain("non-retryable");
    expect(error?.textContent).not.toContain("requires reconciliation");
    const confirm = dom.querySelector<HTMLButtonElement>(
      "[data-meta-native-ad-pause-confirm]",
    )!;
    expect(confirm.disabled).toBe(true);
    act(() => confirm.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets Escape close only the pause confirmation before the evidence drawer", async () => {
    const fetchMock = vi.fn();
    const { dom, primary } = await openExactCutEvidence(fetchMock);

    await act(async () => {
      primary.onClick();
      await Promise.resolve();
    });
    expect(
      dom.querySelector("[data-meta-native-ad-pause-dialog]"),
    ).not.toBeNull();
    expect(dom.querySelector("[data-stub-evidence]")).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(dom.querySelector("[data-meta-native-ad-pause-dialog]")).toBeNull();
    expect(dom.querySelector("[data-stub-evidence]")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * THE INVARIANT, asserted on the surface rather than in the contract module.
   *
   * "A blocked / held / pending / review-only decision must never render as an
   * ordinary recommendation and must never map to a Launchpad mode." The page
   * no longer decides this from a list of presentation codes it maintains
   * itself — it runs the server's own `authorizeLaunchpadHandoff` — so the
   * property to pin is that each refusal the server knows closes the control
   * HERE, with the server's own sentence on screen instead of a live-looking
   * button that fails after the click.
   *
   * `refresh_creative` stays the served action throughout: the point is that
   * the SAME presentation code is offered in one case and refused in the
   * others, which the old code-list gate could not express at all.
   */
  it.each([
    [
      "held",
      {
        classification: {
          decisionState: "act",
          heldAction: "refresh",
          blockers: [],
        },
      },
      "held",
    ],
    [
      "blocked",
      {
        classification: {
          decisionState: "blocked",
          heldAction: null,
          blockers: [],
        },
      },
      "blocked",
    ],
    [
      "carrying a blocker",
      {
        classification: {
          decisionState: "act",
          heldAction: null,
          blockers: [
            { code: "risk_tier_unclassified", label: "Risk is unclassified" },
          ],
        },
      },
      "blocked",
    ],
    [
      "review-only at the source",
      {
        sourceAuthority: {
          status: "legacy_review_only",
          actionEligible: false,
          reviewOnlyReason: "legacy_creative_grain_is_not_ad_action_authority",
          snapshotId: "snapshot_1",
          evaluationId: null,
          inputHash: null,
          decisionHash: null,
          providerAccountRefId: null,
          engineVersion: "v3-test",
          realAdId: null,
          authorizedAction: null,
          jobRunId: null,
        },
      },
      "review-only",
    ],
    [
      "authorized for an action with no Launchpad mode",
      {
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
          realAdId: "120000000000000001",
          authorizedAction: "cut",
          jobRunId: "job_1",
        },
      },
      "does not open Launchpad",
    ],
  ])(
    "closes the primary and states why for a decision that is %s",
    async (_name, override, expectedFragment) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const base = canonicalDecision();
      state.canonicalCreatives = [
        {
          ...base,
          ...override,
          classification: {
            ...base.classification,
            ...((override as Record<string, unknown>).classification ?? {}),
          },
        },
      ];
      state.workspaceData = {
        ...(workspacePayload() as Record<string, unknown>),
        os: {
          contractVersion: "meta-os-decisions.presentation.v5",
          generatedAt: "2026-08-17T10:00:00.000Z",
          source: {
            snapshotAsOf: "2026-08-16",
            engineVersion: "server-engine-v1",
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
            items: [servedRefreshPresentation()],
            actCount: 1,
            blockedCount: 0,
            monitorCount: 0,
            statePreCapCounts: { act: 1, blocked: 0, monitor: 0 },
            eligiblePreCapCount: 1,
            omittedWithoutVerifiedAdId: 0,
            omittedAmbiguousIdentity: 0,
            omittedNotApplicable: 0,
            sourcePreCapCount: 1,
          },
          limitations: [],
        },
      };
      state.search = "providerAccountId=act_1&creativeId=creative_1";
      render();
      await act(async () => {
        await Promise.resolve();
      });

      const primary = state.evidenceProps?.viewModel?.primaryAction;
      // Fail-closed: no callback, no destination, nothing to press.
      expect(primary?.onClick).toBeUndefined();
      expect(primary?.href).toBeNull();
      // And no provider round-trip was even attempted.
      expect(
        fetchMock.mock.calls.filter(
          (args) => String(args[0]) === "/api/meta/launchpad-handoff",
        ),
      ).toHaveLength(0);

      // The window says WHY, in the server's own refusal sentence, rather than
      // leaving a dead button to explain itself.
      const route = state.evidenceProps?.viewModel?.authority?.find(
        (row: { id: string }) => row.id === "launchpad-route",
      );
      expect(String(route?.value)).toContain("refused");
      expect(String(route?.value)).toContain(expectedFragment);
    },
  );

  /*
   * Where the "lossless tuple" law is actually proven, and why not here.
   *
   * Reference identity — that the callback receives `decision.action` ITSELF
   * and not a spread or a `{code,label}` narrowing — is a property of the
   * adapter boundary, and it is asserted there, by identity, in
   * `creative-evidence-window-exact-adapter.test.ts` ("hands the callback the
   * served action object itself, not a copy"). It cannot be re-proved from
   * outside the page: the only observable is the notice, and a page that
   * rebuilt the tuple could print the same three strings. Asserting the served
   * object equals itself would be a green test that proves nothing, so the
   * page-level law is stated as what it can actually observe — the refusal
   * above names the SERVED label, code and intent, none of which the page has
   * any other source for.
   */

  // The Launchpad read site sends a refused handoff back here with its code.
  // Landing on Decisions with no explanation would read as "nothing happened".
  it("renders the refusal the Launchpad read site sent back", () => {
    state.workspaceData = workspacePayload();
    state.search = "providerAccountId=act_1&handoffRefused=already_consumed";

    const dom = render();

    const notice = dom.querySelector('[data-testid="meta-decision-notice"]');
    expect(notice?.textContent).toContain("Launchpad handoff refused.");
    expect(notice?.textContent).toContain("already used");
  });

  // The code is validated against the closed refusal vocabulary, never echoed,
  // so a hand-edited link cannot write a sentence onto this screen.
  it("ignores a refusal code this system does not issue", () => {
    state.workspaceData = workspacePayload();
    state.search =
      "providerAccountId=act_1&handoffRefused=your%20session%20is%20now%20admin";

    const dom = render();

    const notice = dom.querySelector('[data-testid="meta-decision-notice"]');
    expect(notice?.textContent ?? "").not.toContain("admin");
  });
});
