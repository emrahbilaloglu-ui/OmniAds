import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  metaAnomaly,
  metaHealthy,
  metaLanePayload,
  metaPulse,
  metaRec,
} from "@/components/meta/redesign/test-fixtures";
import {
  MetaPlatformPage,
  campaignKindMatchesMetaLabelFilter,
  metaActionFailureMessage,
  metaAdsetPauseNotice,
  metaBidApplyNotice,
  isTrackingWriteBlocked,
  metaEvidenceSourceNotice,
  metaSilentActionFailureNotice,
  trackingConfirmLabelForRec,
  metaRecSearchMatch,
  resolveMetaDecisionMoneyCurrency,
  interpretMetaSnapshotRunResponse,
  sortMetaRecs,
} from "@/components/meta/redesign/MetaPlatformPage";
import type {
  MetaOsAdDecision,
  MetaOsDecisionsPresentation,
  MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";
import type { MetaStructureInventoryEntity } from "@/components/meta/redesign/types";

/**
 * One row of the server's account census.
 *
 * Deliberately a plain inventory record: `MetaStructureInventoryEntity`
 * carries no action tuple, no lane and no decision label, which is exactly why
 * it is the contract the inventory panel reads. Anything a test can build here
 * is something an inventory row could never inherit a verdict from.
 */
function metaStructureInventoryEntity(
  input: Partial<MetaStructureInventoryEntity> & {
    id: string;
    level: "campaign" | "adset";
  },
): MetaStructureInventoryEntity {
  return {
    name: `entity ${input.id}`,
    campaignId: input.level === "campaign" ? input.id : "camp_a",
    campaignName: input.level === "campaign" ? `entity ${input.id}` : "Parent",
    campaignKind: "main",
    status: "PAUSED",
    statusLabel: "Paused 1045d",
    metrics: {
      spend: 0,
      purchases: 0,
      roas: 0,
      cpa: null,
      ctr: null,
      frequency: null,
    },
    entityConfiguration: {
      source:
        input.level === "campaign"
          ? "account_scoped_campaign_row"
          : "account_scoped_adset_row",
      budgetOwner: "campaign",
      budgetMode: "campaign_budget",
      controlOwner: "campaign",
      status: "PAUSED",
      optimizationGoal: "Offsite Conversions",
      bidStrategyType: "lowest_cost",
      bidStrategyLabel: "Lowest Cost",
      dailyBudget: 1_000_000,
      lifetimeBudget: null,
      budgetUtilization: null,
    },
    ...input,
  };
}

const state = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  queryKeys: [] as unknown[][],
  lanePayload: null as any,
  pulsePayload: null as any,
  labelCampaigns: [] as any[],
  campaignLabels: [] as any[],
  search: "window=28d",
  pathname: "/platforms/meta",
  storeBusinesses: [] as Array<{ id: string; name: string; currency: string }>,
  workspaceBanners: [] as any[],
  /**
   * Overrides `workspacePayload()`'s built-in digest. `null` keeps the
   * built-in one, so every existing test keeps the exact payload it had.
   */
  workspaceDigest: null as any,
  workspaceViewer: null as any,
  providerAccounts: [
    {
      id: "act_1",
      name: "Main Meta",
      currency: "USD",
      timezone: "Europe/Istanbul",
    },
  ] as any[],
  decisionReadModel: null as any,
  osSource: null as any,
  osPresentation: null as MetaOsDecisionsPresentation | null,
  exactScope: null as "structure" | "creatives" | null,
  exactProps: null as any,
  selectBusiness: vi.fn(),
  queryOverrides: {} as Record<
    string,
    { data?: unknown; isLoading?: boolean; error?: Error | null }
  >,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function queryState(
  data: unknown,
  override?: { data?: unknown; isLoading?: boolean; error?: Error | null },
) {
  const hasDataOverride =
    override && Object.prototype.hasOwnProperty.call(override, "data");
  const error = override?.error ?? null;
  return {
    data: hasDataOverride ? override?.data : data,
    isLoading: override?.isLoading ?? false,
    isError: Boolean(error),
    error,
  };
}

describe("resolveMetaDecisionMoneyCurrency", () => {
  it("prefers the cutoff-safe decision currency over mutable provider metadata", () => {
    expect(resolveMetaDecisionMoneyCurrency("TRY", "USD")).toBe("TRY");
  });

  it("uses provider metadata only when the decision payload has no currency", () => {
    expect(resolveMetaDecisionMoneyCurrency(null, "EUR")).toBe("EUR");
    expect(resolveMetaDecisionMoneyCurrency("   ", " GBP ")).toBe("GBP");
    expect(resolveMetaDecisionMoneyCurrency(undefined, undefined)).toBeNull();
  });
});

describe("interpretMetaSnapshotRunResponse", () => {
  it.each(["ran", "cooldown", "already_running"] as const)(
    "accepts the typed %s success status",
    (status) => {
      expect(
        interpretMetaSnapshotRunResponse(true, { ok: true, status }),
      ).toEqual({ ok: true, status });
    },
  );

  it("fails closed for an empty or untyped 2xx payload", () => {
    expect(interpretMetaSnapshotRunResponse(true, null)).toEqual({
      ok: false,
      message: "Snapshot refresh returned an invalid response.",
    });
    expect(
      interpretMetaSnapshotRunResponse(true, { ok: true, status: "unknown" }),
    ).toEqual({
      ok: false,
      message: "Snapshot refresh returned an invalid response.",
    });
  });

  it("preserves a server failure reason without treating it as success", () => {
    expect(
      interpretMetaSnapshotRunResponse(false, {
        ok: false,
        status: "failed",
        message: "Provider scope is unavailable.",
      }),
    ).toEqual({ ok: false, message: "Provider scope is unavailable." });
  });

  /*
   * The route answers in TWO shapes. Its own validation failure is flat, but
   * every guard it delegates to — the reviewer guard, and now the demo
   * authority — answers `{ok:false, error:{code, message}}`. Reading only the
   * top level meant the reviewer's own sentence reached the operator as the
   * generic "Snapshot refresh failed.", and a refusal nobody can read is a
   * refusal they will retry.
   */
  it("reads a nested guard refusal rather than falling back to the generic sentence", () => {
    expect(
      interpretMetaSnapshotRunResponse(false, {
        ok: false,
        error: {
          code: "demo_business_read_only",
          message: "Demo workspaces have zero Meta write authority.",
        },
      }),
    ).toEqual({
      ok: false,
      message: "Demo workspaces have zero Meta write authority.",
    });

    expect(
      interpretMetaSnapshotRunResponse(false, {
        ok: false,
        error: {
          code: "reviewer_read_only",
          message:
            "Reviewer access is read-only; write actions are unavailable for this workspace.",
        },
      }),
    ).toEqual({
      ok: false,
      message:
        "Reviewer access is read-only; write actions are unavailable for this workspace.",
    });
  });

  it("prefers the top-level sentence when a payload carries both", () => {
    expect(
      interpretMetaSnapshotRunResponse(false, {
        ok: false,
        message: "Top level.",
        error: { code: "x", message: "Nested." },
      }),
    ).toEqual({ ok: false, message: "Top level." });
  });

  it("still falls back when neither shape carries a sentence", () => {
    expect(
      interpretMetaSnapshotRunResponse(false, {
        ok: false,
        error: "missing_business_id",
      }),
    ).toEqual({ ok: false, message: "Snapshot refresh failed." });
  });
});

function workspacePayload() {
  const pulse = state.pulsePayload ?? metaPulse();
  const lanes = state.lanePayload ?? metaLanePayload();
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
        { key: "watching", label: "Watching", count: lanes.counts.watching },
        { key: "healthy", label: "Healthy", count: lanes.counts.healthy },
        { key: "nonSales", label: "Non-sales", count: lanes.counts.nonSales },
        { key: "archive", label: "Archive", count: lanes.counts.archive },
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
      trackingBlocked:
        pulse.trackingAnomalyActive === true ||
        pulse.trackingHealth.status === "blocked" ||
        pulse.trackingHealth.status === "degraded",
      dataReadiness: pulse.dataReadiness ?? null,
      snapshotHealth: pulse.snapshotHealth ?? lanes.snapshotHealth ?? null,
      laneSnapshotDate: lanes.snapshotDate,
      laneSnapshotCreatedAt: lanes.snapshotCreatedAt ?? null,
      engineVersion: pulse.engineVersion,
      currency: pulse.currency ?? null,
      killSwitchEngaged: false,
      killSwitchReason: null,
    },
    viewer: state.workspaceViewer,
    banners: state.workspaceBanners,
    digest: state.workspaceDigest ?? {
      snapshotDate: lanes.snapshotDate,
      unavailableReason: null,
      labelFlips: {
        count: 2,
        publishedCount: 2,
        items: [
          {
            id: "flip_1",
            title: "Retargeting 30d",
            previousLabel: "watch",
            currentLabel: "act",
            status: "published",
            occurredAt: "2026-05-07",
          },
        ],
      },
      actions: {
        verifiedCount: 1,
        silentFailureCount: 1,
        items: [
          {
            id: "action_1",
            action: "pause",
            target: "Broad LAL 2",
            actor: "Autopilot",
            status: "verified",
            occurredAt: "2026-05-07T06:41:00.000Z",
            detail: null,
          },
          {
            id: "action_2",
            action: "pause",
            target: "Broad Test 01",
            actor: "Deniz",
            status: "silent_failure",
            occurredAt: "2026-05-07T06:52:00.000Z",
            detail: "Meta verification disagreed.",
          },
        ],
      },
      anomalies: {
        openedCount: 1,
        items: [
          {
            id: "anom_1",
            title: "Purchase-event drop",
            status: "open",
            occurredAt: "2026-05-07T05:12:00.000Z",
          },
        ],
      },
      deferrals: {
        dueCount: 1,
        items: [
          {
            id: "rec_deferred",
            title: "Creator Test 03",
            dueAt: "2026-05-07T06:00:00.000Z",
            detail: "let_cook_24h",
          },
        ],
      },
    },
    decisionReadModel:
      state.decisionReadModel ?? emptyCanonicalDecisionReadModel(),
    os:
      state.osPresentation ??
      (state.osSource ? { source: state.osSource } : undefined),
  };
}

function emptyCanonicalSection(key: string): any {
  return {
    key,
    label: key,
    topN: 5,
    preCapCount: 0,
    selectedCount: 0,
    rankablePreCapCount: 0,
    unrankablePreCapCount: 0,
    items: [],
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
      preCapCount: 0,
      selectedCount: 0,
      suppressedCount: 0,
      reasons: [],
    },
  };
}

function emptyCanonicalDecisionReadModel(): any {
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
      fallbackReason: "native_generation_unavailable",
      generation: null,
    },
    queue: {
      deduplicationGrain: "creative",
      sourcePreCapCount: 0,
      queuedPreCapCount: 0,
      sections: {
        integrity_fires: emptyCanonicalSection("integrity_fires"),
        money_moves: emptyCanonicalSection("money_moves"),
        creative_rotation: emptyCanonicalSection("creative_rotation"),
      },
      omittedFromQueue: { count: 0, reasons: [] },
    },
    capabilities: {},
  };
}

function exactNativeAdDecision(
  over: Partial<MetaOsAdDecision> = {},
): MetaOsAdDecision {
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
    action: {
      code: "promote_to_main",
      label: "Scale · Promote To Main",
      intent: "review",
      targetLevel: "ad",
      providerMutation: null,
      scopeNote: "Canonical review only",
    },
    lane: "act",
    priority: {
      band: "high",
      rank: 1,
      version: "meta-os-decisions.presentation.v5",
    },
    assessment: "proven_winner",
    confidence: "high",
    confidenceScore: 87,
    riskTier: null,
    confirmationCeremony: "highest",
    whyNow: "Fresh commercial truth supports the call.",
    blockers: [],
    resolution: null,
    metrics: {
      spend: 250,
      purchases: 6,
      roas: 3.2,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: 2.4,
      ratioToTarget: 1.33,
      currency: "USD",
      attribution: "meta_attributed",
      grain: "ad",
    },
    rawLabel: "scale",
    publishedLabel: "scale",
    engineVersion: "v3-test",
    snapshotAsOf: "2026-07-10",
    sourceGrain: "ad",
    decisionAvailability: "available",
    ...over,
  };
}

function exactStructureNode(
  overrides: Partial<MetaOsStructureNode> = {},
): MetaOsStructureNode {
  return {
    id: "structure_1",
    sourceRecommendationId: "rec_blocked",
    level: "campaign",
    providerEntityId: "cmp_1",
    campaignId: "cmp_1",
    campaignName: "Blocked campaign",
    name: "Blocked campaign",
    lifecycleRole: "main",
    budgetOwner: "campaign",
    budgetMode: "campaign_budget",
    controlOwner: "campaign",
    status: "ACTIVE",
    optimizationGoal: "PURCHASE",
    action: {
      code: "review_budget",
      label: "Review campaign budget",
      intent: "review",
      targetLevel: "campaign",
      providerMutation: null,
      scopeNote: "Review only.",
    },
    lane: "blocked",
    priority: {
      band: "high",
      rank: 1,
      version: "meta-os-decisions.presentation.v5",
    },
    urgency: { level: "high", rank: 3, label: "High", reason: null },
    confidence: "low",
    assessment: "Needs safety review",
    whyNow: "A fresh safety check is required.",
    expectedImpact: "No change until the check passes.",
    evidence: [],
    metrics: {
      spend: 1_180,
      purchases: 28,
      roas: 2.36,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: 2.5,
      ratioToTarget: 0.94,
      currency: "USD",
      attribution: "meta_attributed",
      grain: "campaign_or_adset",
    },
    suppressedAlternativeCount: 0,
    ...overrides,
  };
}

function exactOsPresentation(
  items: MetaOsAdDecision[],
): MetaOsDecisionsPresentation {
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

vi.mock(
  "@/components/meta/decision-center/MetaDecisionCenterExact",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/meta/decision-center/MetaDecisionCenterExact")
      >();
    return {
      ...actual,
      MetaDecisionCenterExact: (props: any) => {
        state.exactProps = props;
        return React.createElement(actual.MetaDecisionCenterExact, {
          ...props,
          ...(state.exactScope ? { scope: state.exactScope } : {}),
        });
      },
    };
  },
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.routerPush, replace: state.routerReplace }),
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (input: unknown) => unknown) =>
    selector({
      businesses: state.storeBusinesses,
      selectBusiness: state.selectBusiness,
    }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  /**
   * The real sentinel's identity is all the page uses: it hands it to
   * `placeholderData` so a window change keeps the previous rows on screen
   * rather than blanking the queue to a skeleton. This mock never reads it, so
   * a stand-in with the same name is enough for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: (input: { queryKey: unknown[] }) => {
    state.queryKeys.push(input.queryKey);
    const key = String(input.queryKey[0]);
    const override = state.queryOverrides[key];
    if (key === "meta-decisions-workspace")
      return queryState(workspacePayload(), override);
    if (key === "meta-provider-accounts")
      return queryState(state.providerAccounts, override);
    if (key === "meta-anomalies") {
      return queryState(
        { anomalies: [metaAnomaly()], snapshotDate: "2026-05-07", count: 1 },
        override,
      );
    }
    if (key === "meta-campaigns-for-labels")
      return queryState({ rows: state.labelCampaigns }, override);
    if (key === "meta-campaign-labels")
      return queryState({ labels: state.campaignLabels }, override);
    if (key === "triage-state")
      return queryState({ rows: [], deferredCount: 0 }, override);
    return queryState(null, override);
  },
}));

function countText(html: string, text: string) {
  return html.split(text).length - 1;
}

function quietWorkspaceDigest() {
  return {
    snapshotDate: "2026-05-07",
    unavailableReason: null,
    labelFlips: { count: 0, publishedCount: 0, items: [] },
    actions: { verifiedCount: 0, silentFailureCount: 0, items: [] },
    anomalies: { openedCount: 0, items: [] },
    deferrals: { dueCount: 0, items: [] },
  };
}

function exactArticleHtml(html: string, attribute: string) {
  const attributeIndex = html.indexOf(attribute);
  if (attributeIndex < 0) return "";
  const start = html.lastIndexOf("<article", attributeIndex);
  const end = html.indexOf("</article>", attributeIndex);
  return html.slice(start, end < 0 ? undefined : end + "</article>".length);
}

describe("MetaPlatformPage", () => {
  beforeEach(() => {
    state.queryKeys = [];
    state.lanePayload = null;
    state.pulsePayload = null;
    state.labelCampaigns = [];
    state.campaignLabels = [];
    state.search = "window=28d";
    state.pathname = "/platforms/meta";
    state.storeBusinesses = [];
    state.workspaceBanners = [];
    state.workspaceViewer = {
      role: "collaborator",
      isReviewer: false,
      readOnly: false,
      readOnlyReason: null,
    };
    state.providerAccounts = [
      {
        id: "act_1",
        name: "Main Meta",
        currency: "USD",
        timezone: "Europe/Istanbul",
      },
    ];
    state.decisionReadModel = null;
    state.osSource = null;
    state.osPresentation = null;
    state.exactScope = null;
    state.exactProps = null;
    state.queryOverrides = {};
    state.selectBusiness.mockClear();
    state.routerPush.mockClear();
    state.routerReplace.mockClear();
  });

  it("renders the exact Decision Center desktop anatomy without legacy chrome", () => {
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain("Meta · ");
    expect(html).toContain("<h1>Decision Center</h1>");
    expect(html).toContain("Some recent changes need review.");
    expect(html).not.toContain("Policy delivery block");
    expect(html).toContain('data-screen-label="Meta Decision Center"');
    expect(html).toContain('data-meta-exact-section="kpis"');
    expect(html).toContain("Spend · 2026-05-07");
    expect(html).toContain("ROAS · 28d");
    expect(html).toContain("$401");
    expect(html).toContain("+15%");
    expect(html).toContain('data-meta-exact-scope="structure"');
    expect(html).toContain('data-meta-exact-scope="creatives"');
    expect(html).toContain('data-meta-exact-lane="action"');
    expect(html).toContain('data-meta-exact-lane="watching"');
    expect(html).toContain('data-meta-exact-lane="healthy"');
    expect(html).not.toContain('data-meta-exact-lane="nonsales"');
    expect(html).not.toContain('data-meta-exact-lane="archive"');
    expect(html).toContain('data-meta-exact-action-row="rec_1"');
    expect(html).toContain('data-meta-exact-workspace="true"');
    expect(html).toContain('data-meta-exact-inspector="true"');
    expect(html).toContain('aria-label="Sort decisions"');
    expect(html).toContain('aria-label="Find entities"');
    expect(html).toContain("Refresh decisions");
    expect(html).not.toContain("+ New campaign");
    expect(html).not.toContain('data-testid="meta-business-strip"');
    expect(html).not.toContain('data-testid="meta-overnight-digest"');
    expect(html).not.toContain("Since last snapshot");
    expect(html).not.toContain('data-testid="meta-decision-board"');
    expect(html).not.toContain("suppression receipt");
    expect(html).toContain('data-testid="meta-mobile-decisions"');
    // RESTATED LAW: the mobile act-now tally is the SAME number the desktop
    // lane chip shows, because both read `lanes.counts.actionNow` from one
    // payload. This assertion used to expect 2 — the old mobile screen added
    // `anomalies.length` to the recommendation count, so one payload produced
    // "Act now 2" on the phone and "Action Now 1" on the desktop. Anomalies are
    // still on the phone; they are listed as their own rows (asserted below)
    // rather than folded into a decision tally they are not part of.
    expect(html).toContain("TheSwaf · Act now 1");
    expect(html).toContain('data-meta-exact-lane="action"');
    expect(html).not.toContain("A policy issue is blocking delivery");
    expect(html).toContain("ASC Prospecting");
    expect(html).not.toContain(
      "the same manual action sheet the desktop carries",
    );
    expect(html).not.toContain("Mobile diagnostic summary unavailable");
    expect(state.queryKeys).toContainEqual([
      "meta-decisions-workspace",
      "biz_1",
      "act_1",
      "28d",
      "active",
      expect.any(String),
      expect.any(String),
      60,
    ]);
    expect(state.queryKeys.map((key) => key[0])).not.toContain(
      "meta-account-pulse",
    );
    expect(state.queryKeys.map((key) => key[0])).not.toContain("meta-lanes");
  });

  it("posts one exact Run snapshot request when writable and zero when read-only", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, status: "ran" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    expect(state.exactProps.onRunSnapshot).toEqual(expect.any(Function));
    state.exactProps.onRunSnapshot();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/meta/snapshot/run-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ businessId: "biz_1" }),
    });

    fetchMock.mockClear();
    state.workspaceViewer = {
      role: "collaborator",
      isReviewer: true,
      readOnly: true,
      readOnlyReason: "Read-only fixture",
    };
    renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    expect(state.exactProps.onRunSnapshot).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    state.workspaceViewer = null;
    renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    expect(state.exactProps.onRunSnapshot).toBeUndefined();
    expect(state.exactProps.onNewCampaign).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    await Promise.resolve();
  });

  // Law: "+ New campaign" must actually start a new campaign.
  //
  // These three cases used to pin `fromMetaBriefing=true&mode=duplicate`.
  // Launchpad reads those as decision lineage and deliberately fails that
  // closed (hasServerAuthorizedLaunchpadHandoff() is always false: URL
  // identifiers are not execution authority), and the handoff then suppresses
  // launchpadMode/launchpadStep — so the button landed on "Source & mode"
  // announcing missing lineage with the Duplicate card disabled and started
  // nothing at all. The gate is correct; the caller was wrong. A manual start
  // sends no handoff params, so the wizard opens where the button's own label
  // promises. A real Duplicate still needs a server-authorized lineage
  // contract, which this button does not have and must not fake.
  // Law (window half): picking a window states the DATES on the URL, not just
  // the preset key.
  //
  // These cases used to pin `?window=14d` alone, and that was the defect one
  // layer up: a bare key is a question, and each reader downstream answered it
  // against its own clock — the shell writer expanded it to completed days,
  // this page re-expanded it with `includeCurrentDay: true`, and
  // `/api/meta/decisions-workspace` resolved an end date of its own. One click
  // measured three different weeks while the caption named one. The URL now
  // carries the answer: `window` is the label, `startDate`/`endDate` are the
  // window. See `DATE_WINDOW_INCLUDES_CURRENT_DAY` in
  // `lib/dashboard/date-window-url`.
  //
  // The clock is pinned because the dates below are resolved against the
  // provider account's timezone (Europe/Istanbul), and an assertion on a
  // rolling window is otherwise only true on the day it was written.
  const WINDOW_CLOCK = new Date("2026-08-18T06:00:00.000Z"); // 09:00 in Istanbul
  const FOURTEEN_DAYS = "startDate=2026-08-04&endDate=2026-08-17";

  it.each([
    {
      pathname: "/platforms/meta",
      decisions: `/platforms/meta?window=14d&${FOURTEEN_DAYS}`,
      launchpad:
        "/platforms/meta/launchpad?providerAccountId=act_1&launchpadMode=new_campaign&launchpadStep=source",
      creativeStudio: "/platforms/meta/creatives?providerAccountId=act_1",
    },
    {
      pathname: "/app/meta/decisions",
      decisions: `/app/meta/decisions?window=14d&${FOURTEEN_DAYS}`,
      launchpad:
        "/app/meta/launchpad?providerAccountId=act_1&launchpadMode=new_campaign&launchpadStep=source",
      creativeStudio: "/app/creative/performance?providerAccountId=act_1",
    },
    {
      pathname: "/c/biz_1/meta/decisions",
      decisions: `/c/biz_1/meta/decisions?window=14d&${FOURTEEN_DAYS}`,
      launchpad:
        "/c/biz_1/meta/launchpad?providerAccountId=act_1&launchpadMode=new_campaign&launchpadStep=source",
      creativeStudio: "/c/biz_1/creative/performance?providerAccountId=act_1",
    },
  ])(
    "keeps CTA navigation inside $pathname",
    ({ pathname, launchpad, creativeStudio }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(WINDOW_CLOCK);
      try {
        state.pathname = pathname;
        renderToStaticMarkup(
          <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
        );

        // The in-page window control is gone — the shell topbar picker owns the
        // window, and this header carrying its own was a second writer for one
        // value. What this case still protects is that a CTA never navigates
        // OUT of the route family the operator is in.
        state.exactProps.onNewCampaign();
        state.exactProps.onOpenCreativeStudio();
      } finally {
        vi.useRealTimers();
      }

      expect(state.routerPush).toHaveBeenNthCalledWith(1, launchpad);
      expect(state.routerPush).toHaveBeenNthCalledWith(2, creativeStudio);
      // The two params Launchpad fails closed on must not come back.
      expect(state.routerPush.mock.calls[0]?.[0]).not.toContain(
        "fromMetaBriefing",
      );
      expect(state.routerPush.mock.calls[0]?.[0]).not.toContain(
        "mode=duplicate",
      );
    },
  );

  // The degraded-source banner was removed from the screen on request. The
  // authority it announced is unchanged and still server-side: when the read
  // model's authority is not `native_ad`, the served action tuples stay
  // review-only and `os.limitations` carries `legacy_creative_review_only`, so
  // no exact Ad write can be minted from a legacy source. What went away is the
  // explanation, not the block.

  it("renders a served creative row and joins its canonical envelope by key", () => {
    const model = emptyCanonicalDecisionReadModel();
    model.queue.sections.creative_rotation = {
      ...emptyCanonicalSection("creative_rotation"),
      preCapCount: 8,
      selectedCount: 1,
      rankablePreCapCount: 7,
      unrankablePreCapCount: 1,
      items: [
        {
          decisionId: "mdd_1",
          episodeId: "mde_1",
          episodeStartedAt: "2026-07-08",
          providerAccountId: "act_1",
          identityGrain: "creative",
          sourceSnapshotId: "snapshot_1",
          sourceDecision: {
            label: "scale",
            rawLabel: "scale",
            reason: "Fresh commercial truth supports the call.",
            confidence: 87,
            confidenceBand: "high",
            truthSource: "commercial_truth",
            engineVersion: "v3-test",
            snapshotAsOf: "2026-07-10",
            computedAt: "2026-07-10T05:00:00.000Z",
            badges: [],
            provenance: {},
          },
          parentChain: {
            account: { id: "act_1", name: "Main Meta" },
            campaign: { id: "cmp_1", name: "Prospecting" },
            adset: { id: "adset_1", name: "Broad" },
            ad: { id: "ad_1", name: "UGC 1" },
            creative: { id: "creative_1", name: "Hook Variant A" },
            provenance: {},
          },
          media: {
            state: "missing",
            missingMedia: true,
            thumbnail: { state: "missing", url: null },
            provenance: {},
          },
          classification: {
            overlayVersion: "meta-decisions-classification-overlay.v4",
            queueSection: "creative_rotation",
            lifecycleRole: { value: "test" },
            assessment: { value: "proven_winner" },
            buyerAction: "scale",
            buyerLabel: "Scale",
            executionAction: "promote_to_main",
            blockers: [],
            provenance: {},
          },
          riskTier: null,
          confirmationCeremony: "highest",
          riskTierProvenance: {},
          promotionBasis: {},
          metrics: {
            spend: 250,
            purchases: 6,
            roas: 3.2,
            recent7dRoas: 3.4,
            effectiveTargetRoas: 2.4,
            ratioToTarget: 1.33,
            currency: "USD",
            attribution: "meta_attributed",
            provenance: {},
          },
          exposure: null,
          exposureUnavailableReason: null,
          history: {
            responses: { status: "unavailable" },
            providerWrites: { status: "unavailable" },
          },
        },
      ],
      suppressionReceipt: {
        ...emptyCanonicalSection("creative_rotation").suppressionReceipt,
        preCapCount: 8,
        selectedCount: 1,
        suppressedCount: 7,
      },
    };
    state.decisionReadModel = model;
    state.osPresentation = exactOsPresentation([exactNativeAdDecision()]);
    state.exactScope = "creatives";

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    const creative = exactArticleHtml(
      html,
      'data-meta-exact-creative-row="os_ad_1"',
    );
    expect(creative).toContain("Hook Variant A");
    expect(creative).toContain(">Scale</span>");
    expect(creative).toContain("Review decision");
    expect(creative).toContain(">Review evidence</button>");
    expect(creative).not.toContain("Promote To Main");
    expect(creative).toContain("$250 · ROAS 3.20");
    expect(html).not.toContain("Server selected 1 of 8");
    expect(html).not.toContain("87% confidence");
    expect(html).not.toContain("suppression receipt");
    expect(state.queryKeys.map((key) => key[0])).not.toContain(
      "meta-decisions-creative-engine",
    );
  });

  /**
   * LAW: section membership is a RANKING, not a visibility gate.
   *
   * The Creatives scope used to intersect `os.ads.items` with
   * `queue.sections.creative_rotation` — a compact operator queue capped at
   * five — and render only the overlap. Measured on Grandmix
   * (act_805150454596350) the payload carried 60 Ads in `os.ads.items`, the
   * section carried 5 `out_of_scope` decisions, the two sets did not intersect
   * at all, and the scope rendered ZERO rows out of 60 served.
   *
   * The Ads the server serves as blocked/pending are the ones that vanished
   * hardest: they are live Ads with no exact Ad-grain decision snapshot yet, so
   * they carry no canonical section key by construction. This pins that they
   * render, that they say what they are, and that they are not dressed up as
   * ordinary recommendations.
   */
  it("renders every served Ad, including ones no canonical section ranked", () => {
    const model = emptyCanonicalDecisionReadModel();
    // The section ranks exactly one Ad. The payload serves three.
    model.queue.sections.creative_rotation = {
      ...emptyCanonicalSection("creative_rotation"),
      preCapCount: 1,
      selectedCount: 1,
      items: [],
    };
    state.decisionReadModel = model;
    state.osPresentation = exactOsPresentation([
      exactNativeAdDecision(),
      exactNativeAdDecision({
        id: "os_ad_pending_1",
        decisionId: "inventory:120000000000000002",
        sourceSnapshotId: "inventory:120000000000000002:2026-07-10",
        adId: "120000000000000002",
        adName: "Live Ad Without A Decision",
        lane: "blocked",
        decisionAvailability: "pending_native_evidence",
        publishedLabel: "not_evaluated",
        rawLabel: null,
        assessment: "Ad-grain evidence pending",
        whyNow:
          "Meta confirms this Ad is ACTIVE, but the exact Ad-grain decision snapshot is not available.",
        action: {
          code: "await_ad_grain_evidence",
          label: "Evidence pending",
          intent: "review",
          targetLevel: "ad",
          providerMutation: null,
          scopeNote:
            "The Ad is live, but no exact Ad-grain decision snapshot can authorize an action yet",
        },
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
          nextStep:
            "Complete the native Ad decision schema and producer lineage gate.",
        },
      }),
      exactNativeAdDecision({
        id: "os_ad_monitor_1",
        decisionId: "mdd_monitor_1",
        sourceSnapshotId: "snapshot_monitor_1",
        adId: "120000000000000003",
        adName: "Still Learning",
        lane: "monitor",
        publishedLabel: "test_more",
        assessment: "Learning",
        whyNow:
          "Below commercial maturity — let the creative accumulate signal.",
        action: {
          code: "watch",
          label: "Watch",
          intent: "none",
          targetLevel: "ad",
          providerMutation: null,
          scopeNote: "Re-evaluates with the next eligible snapshot",
        },
      }),
    ]);
    state.exactScope = "creatives";

    state.search = "window=28d&scope=creatives";
    const actionHtml = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    state.search =
      "window=28d&scope=creatives&area=monitor&segment=needs_resolution";
    const blockedHtml = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    state.search = "window=28d&scope=creatives&area=monitor";
    const monitorHtml = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );

    // Every served row remains reachable in its own lane; section ranking does
    // not hide it and the lane controls no longer open the same flat list.
    expect(actionHtml).toContain('data-meta-exact-creative-row="os_ad_1"');
    expect(actionHtml).not.toContain(
      'data-meta-exact-creative-row="os_ad_pending_1"',
    );
    expect(blockedHtml).toContain(
      'data-meta-exact-creative-row="os_ad_pending_1"',
    );
    expect(monitorHtml).toContain(
      'data-meta-exact-creative-row="os_ad_monitor_1"',
    );
    const pending = exactArticleHtml(
      blockedHtml,
      'data-meta-exact-creative-row="os_ad_pending_1"',
    );
    expect(pending).toContain("Live Ad Without A Decision");
    // The blocked group carries the state; the row states one next step.
    expect(pending).not.toContain("Decision pending");
    expect(pending).not.toContain("Decision evidence is still being prepared.");
    expect(pending).toContain("Wait for the next completed ad-level decision.");
    expect(pending.match(/data-meta-exact-creative-next-step/g)).toHaveLength(
      1,
    );
    expect(pending).not.toContain("schema and producer lineage");
    // The served state is on the row, not pooled away.
    expect(pending).toContain('data-meta-exact-creative-state="Blocked"');
    /*
     * LAW: a blocked row's evidence is REACHABLE, and what it opens is a
     * read-only window.
     *
     * This used to assert `disabled` — i.e. that a row with no canonical
     * envelope offered no control at all — and on a real account that rule
     * silenced everything: Grandmix serves 60 ads, every one of them
     * `pending_native_evidence` with no envelope, so no row on the account
     * could open the window that exists to explain exactly this state.
     *
     * The control now offers a clear evidence review action. The row still
     * names its blocked state, the blocker, and the next step. Provider-write
     * authority remains refused when no canonical envelope exists.
     */
    expect(pending).toContain(
      'aria-label="Review evidence — Live Ad Without A Decision"',
    );
    expect(pending).toContain('type="button"');
    expect(pending).not.toContain("disabled");
    // It is a review affordance, never a provider mutation dressed as one.
    expect(pending).not.toContain("Pause");
    expect(pending).not.toContain("Resume");

    // The three served states are three routes, not one flat list.
    expect(actionHtml).toContain('data-meta-exact-creative-group="act"');
    expect(blockedHtml).toContain('data-meta-exact-creative-group="blocked"');
    expect(monitorHtml).toContain('data-meta-exact-creative-group="monitor"');
    expect(actionHtml).toContain(
      "Open a decision for details, or use Creative Studio to compare performance.",
    );
    expect(actionHtml).not.toContain("Ad-level calls served for this account");
    expect(actionHtml).not.toContain("only three ad-level calls");
  });

  it("renders native decisions Ad-first when creative grouping is unavailable", () => {
    const model = emptyCanonicalDecisionReadModel();
    model.source = {
      ...model.source,
      authority: "native_ad",
      table: "engine_v3_ad_decision_snapshots_daily",
      engineVersion: "v3-ad-test",
      fallbackReason: null,
      generation: {
        jobRunId: "run_1",
        providerAccountRefId: "account_ref_1",
        manifestHash: "a".repeat(64),
        expectedAdCount: 1,
      },
    };
    model.queue.deduplicationGrain = "ad";
    model.queue.sections.creative_rotation = {
      ...emptyCanonicalSection("creative_rotation"),
      preCapCount: 1,
      selectedCount: 1,
      rankablePreCapCount: 1,
      items: [
        {
          decisionId: "native_ad_decision_1",
          episodeId: "native_episode_1",
          episodeStartedAt: "2026-07-12",
          providerAccountId: "act_1",
          identityGrain: "ad",
          sourceSnapshotId: "native_snapshot_1",
          sourceAuthority: {
            status: "native_exact",
            actionEligible: true,
            realAdId: "120000000000000001",
            authorizedAction: "cut",
          },
          sourceDecision: {
            label: "cut",
            rawLabel: "cut",
            reason: "Exact Ad evidence is below target.",
            confidence: 91,
            confidenceBand: "high",
            truthSource: "commercial_truth",
            engineVersion: "v3-ad-test",
            snapshotAsOf: "2026-07-12",
            computedAt: "2026-07-12T05:00:00.000Z",
            badges: [],
            provenance: {},
          },
          parentChain: {
            account: { id: "act_1", name: "Main Meta" },
            campaign: { id: "cmp_1", name: "Prospecting" },
            adset: { id: "adset_1", name: "Broad" },
            ad: { id: "120000000000000001", name: "UGC Winner Ad" },
            creative: null,
            provenance: {},
          },
          media: {
            state: "unavailable",
            missingMedia: null,
            thumbnail: { state: "unavailable", url: null },
            provenance: {},
          },
          classification: {
            overlayVersion: "meta-decisions-classification-overlay.v4",
            queueSection: "creative_rotation",
            lifecycleRole: { value: "main" },
            assessment: { value: "below_target" },
            buyerAction: "cut",
            buyerLabel: "Cut",
            executionAction: null,
            blockers: [],
            provenance: {},
          },
          riskTier: null,
          confirmationCeremony: "highest",
          riskTierProvenance: {},
          promotionBasis: {},
          metrics: {
            spend: 125,
            purchases: 1,
            roas: 0.8,
            recent7dRoas: 0.7,
            effectiveTargetRoas: 2,
            ratioToTarget: 0.4,
            currency: "USD",
            attribution: "meta_attributed",
            provenance: {},
          },
          exposure: null,
          exposureUnavailableReason: null,
          history: {
            responses: { status: "unavailable", reason: "not_accrued" },
            providerWrites: { status: "unavailable", reason: "not_observed" },
          },
        },
      ],
    };
    state.decisionReadModel = model;
    state.osPresentation = exactOsPresentation([
      exactNativeAdDecision({
        id: "os_native_ad_1",
        decisionId: "native_ad_decision_1",
        sourceSnapshotId: "native_snapshot_1",
        adId: "120000000000000001",
        adName: "UGC Winner Ad",
        creativeId: null,
        creativeName: null,
        action: {
          code: "review_cut",
          label: "Cut",
          intent: "review",
          targetLevel: "ad",
          providerMutation: null,
          scopeNote: "Exact Ad review only",
        },
        publishedLabel: "cut",
        rawLabel: "cut",
        metrics: {
          ...exactNativeAdDecision().metrics,
          spend: 125,
          purchases: 1,
          roas: 0.8,
          effectiveTargetRoas: 2,
          ratioToTarget: 0.4,
        },
      }),
    ]);
    state.exactScope = "creatives";

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    const creative = exactArticleHtml(
      html,
      'data-meta-exact-creative-row="os_native_ad_1"',
    );
    expect(creative).toContain("UGC Winner Ad");
    expect(creative).toContain("Ad");
    expect(creative).toContain("$125 · ROAS 0.80");
    expect(creative).not.toContain("Hook Variant A");
    expect(html).not.toContain("Creative grouping unavailable");
  });

  it("offers account recovery on both legacy surfaces and keeps canonical selection in the shell", () => {
    state.providerAccounts = [
      { id: "act_1", name: "US", currency: "USD", timezone: "UTC" },
      { id: "act_2", name: "EU", currency: "EUR", timezone: "UTC" },
    ];

    const unscoped = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        accountSelection="local"
      />,
    );
    expect(unscoped).toContain('data-testid="meta-account-required"');
    expect(unscoped).toContain('data-mobile-read-state="account-required"');
    expect(unscoped).toContain(
      'aria-label="Meta ad account for Decisions mobile"',
    );
    expect(unscoped).toContain(
      "Select the account whose decisions you want to review.",
    );
    expect(unscoped).toContain("US · ID act_1 · USD");
    expect(unscoped).toContain("EU · ID act_2 · EUR");

    const canonical = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        accountSelection="shared"
      />,
    );
    expect(canonical).not.toContain('data-testid="meta-account-required"');
    expect(canonical).not.toContain(
      'aria-label="Meta ad account for Decisions mobile"',
    );

    state.search = "window=28d&providerAccountId=act_2";
    renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    expect(state.queryKeys).toContainEqual([
      "meta-decisions-workspace",
      "biz_1",
      "act_2",
      "28d",
      "active",
      expect.any(String),
      expect.any(String),
      60,
    ]);
  });

  it("withholds false summary zeros while the pulse and lane briefing are loading", () => {
    state.queryOverrides = {
      "meta-decisions-workspace": { data: undefined, isLoading: true },
      "meta-anomalies": { data: undefined, isLoading: true },
    };

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-briefing-loading"');
    expect(html).toContain("Loading decision data.");
    expect(html).not.toContain("data-meta-structure-inventory");
    expect(html).not.toContain('data-meta-exact-section="kpis"');
    expect(countText(html, ">—<")).toBeLessThanOrEqual(1);
    expect(html).not.toContain("$0");
    expect(html).not.toContain(">0.00<");
    expect(html).not.toContain("snapshot 0");
  });

  it("surfaces workspace query errors before rendering briefing summaries", () => {
    state.queryOverrides = {
      "meta-decisions-workspace": {
        data: undefined,
        error: new Error("workspace request failed"),
      },
    };

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-briefing-error"');
    expect(html).toContain(
      "We could not load Meta decisions. Please try again.",
    );
    expect(html).not.toContain("workspace request failed");
    expect(html).not.toContain('data-meta-exact-section="kpis"');
    expect(countText(html, ">—<")).toBeLessThanOrEqual(1);
    expect(html).not.toContain("$0");
    expect(html).not.toContain(">0.00<");
  });

  it("surfaces anomaly query errors without hiding a healthy pulse and lane briefing", () => {
    state.queryOverrides = {
      "meta-anomalies": {
        data: undefined,
        error: new Error("anomaly scan failed"),
      },
    };

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-anomaly-error"');
    expect(html).toContain("Spend · 2026-05-07");
    expect(html).toContain("$401");
    expect(html).toContain("Some checks are unavailable.");
    expect(html).toContain("The decisions below are still available.");
    expect(html).not.toContain("anomaly scan failed");
    expect(html).not.toContain('data-testid="meta-briefing-error"');
    expect(html).toContain('data-meta-exact-action-row="rec_1"');
  });

  it("fails an injected legacy execute action closed to review on decision rows", () => {
    state.lanePayload = metaLanePayload({
      actionNow: [
        metaRec({
          id: "rec_pause",
          level: "adset",
          adsetId: "adset_1",
          adsetName: "Cold Prospecting - Broad",
          type: "adset_cut_spend",
          actionKind: "execute_pause",
          primaryActionLabel: "Pause adset",
          automationReadiness: {
            contractVersion: "meta-automation-readiness.v1",
            tier: "manual_review",
            autoExecuteEligible: false,
            operatorReviewRequired: true,
            decisionLabel: "cut",
            blockers: ["missing_live_preflight"],
            missingEvidence: ["live_preflight"],
            requiredEvidence: ["commercial_anchor", "live_preflight"],
            reason: "Live preflight is required before execution.",
          },
          evidenceTrail: {
            roas_history: [0.8, 0.7, 0.6],
            peer_comparison: { p10: 0.5, p50: 1.2, p90: 2.2, this_value: 0.6 },
            regime_stability: 0.7,
            age_days: 9,
            recent_changes: [],
          },
        }),
      ],
      watching: [],
      counts: {
        actionNow: 1,
        watching: 0,
        healthy: 1,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    // Even a stale/injected execute_* value cannot manufacture write authority
    // in the client; the evidence drawer remains the only primary destination.
    const row = exactArticleHtml(
      html,
      'data-meta-exact-action-row="rec_pause"',
    );
    expect(row).toContain("Cold Prospecting - Broad");
    expect(row).toMatch(
      /<button[^>]*disabled=""[^>]*>Review recommendation<\/button>/,
    );
    expect(row).not.toContain("Pause adset");
    expect(html).not.toContain('data-action-authority="execute"');
    expect(html).not.toContain('data-action-kind="execute_pause"');
    expect(html).toContain("Cold Prospecting - Broad");
  });

  it("contains no recommendation-card POST path for legacy pause, resume, or bid writes", () => {
    const source = readFileSync(
      "components/meta/redesign/MetaPlatformPage.tsx",
      "utf8",
    );
    expect(source).not.toContain(
      "/api/meta/adsets/${encodeURIComponent(rec.adsetId)}/pause",
    );
    expect(source).not.toContain(
      "/api/meta/adsets/${encodeURIComponent(rec.adsetId)}/apply-bid",
    );
    expect(source).not.toContain("resumeEndpointForEntity");
    expect(source).not.toContain("<MetaDrillDrawer");
  });

  it("keeps campaign-role diagnostics out without mounting scope management", () => {
    state.pulsePayload = metaPulse({
      campaignRoleCoverage: {
        activeCampaigns: 2,
        classifiedCampaigns: 1,
        unresolvedCampaigns: 1,
        latestUpdatedAt: "2026-05-15T10:00:00.000Z",
      },
    });
    state.labelCampaigns = [
      {
        id: "cmp_main",
        accountId: "act_1",
        name: "Main ASC",
        status: "ACTIVE",
        spend: 1200,
        roas: 3.1,
      },
      {
        id: "cmp_test",
        accountId: "act_1",
        name: "Creative Test",
        status: "ACTIVE",
        spend: 240,
        roas: 1.4,
      },
    ];
    state.campaignLabels = [
      {
        businessId: "biz_1",
        campaignId: "cmp_main",
        kind: "main",
        testDimension: null,
        source: "user",
        providerAccountId: "act_1",
        campaignName: "Main ASC",
        labeledBy: "user_1",
        labeledAt: "2026-05-15T10:00:00.000Z",
        updatedAt: "2026-05-15T10:00:00.000Z",
      },
    ];

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-meta-exact-section="kpis"');
    expect(html).not.toContain(">1/2 ");
    expect(html).not.toContain(">50%</span>");
    expect(html).not.toContain("Campaign roles");
    expect(html).not.toContain("Automatic inference");
    expect(html).not.toContain("Review exceptions");
    expect(html).not.toContain(
      'aria-label="Review campaign context exceptions"',
    );
    expect(html).not.toContain('href="#campaign-labels"');
    expect(html).not.toContain("data-meta-campaign-labels-section");
    expect(html).not.toContain("data-meta-label-management-modal");
    expect(html).not.toContain("Main ASC");
    expect(html).not.toContain("Creative Test");
    expect(html).not.toContain("automatic context · 1 overrides");
    expect(state.queryKeys.map((key) => key[0])).not.toContain(
      "meta-campaigns-for-labels",
    );
    expect(state.queryKeys.map((key) => key[0])).not.toContain(
      "meta-campaign-labels",
    );
  });

  it("formats verified ad set pause success without duplicating the action name", () => {
    expect(metaAdsetPauseNotice("PAUSED")).toBe("Ad set paused in Meta.");
    expect(metaAdsetPauseNotice(undefined)).toBe("Ad set paused in Meta.");
    expect(metaAdsetPauseNotice("ACTIVE")).toBe(
      "Ad set pause verified with status ACTIVE.",
    );
    expect(metaAdsetPauseNotice("ACTIVE", true)).toBe(
      "Dry run: ad set would pause.",
    );
  });

  it("keeps apply-bid dry-run feedback distinct from a real write", () => {
    expect(metaBidApplyNotice({ dryRun: true, bidAmountMinor: 2200 })).toEqual({
      tone: "info",
      title: "Dry run: bid cap would apply at 22 (Currency unavailable).",
      detail: "No Meta write was performed; Meta verification completed.",
    });
    expect(metaBidApplyNotice({ bidAmountMinor: 2200 }, "USD")).toEqual({
      tone: "success",
      title: "Bid cap applied at $22.00.",
      detail: "Meta verified the ad set bid.",
    });
  });

  it("surfaces kill-switch failures with operator-specific copy", () => {
    expect(
      metaActionFailureMessage(
        {
          error: {
            code: "kill_switch_engaged",
            message: "Meta writes are disabled by kill switch.",
          },
        },
        "Action failed.",
      ),
    ).toBe(
      "Meta writes are temporarily disabled (kill switch). Try again later.",
    );
  });

  it("matches Main/Test/Mixed filters from campaignKind instead of recommendation text", () => {
    expect(campaignKindMatchesMetaLabelFilter("main", "main")).toBe(true);
    expect(campaignKindMatchesMetaLabelFilter("test", "main")).toBe(false);
    expect(campaignKindMatchesMetaLabelFilter("mixed", "mixed")).toBe(true);
    expect(campaignKindMatchesMetaLabelFilter(null, "mixed")).toBe(false);
    expect(campaignKindMatchesMetaLabelFilter(null, "main")).toBe(false);
  });

  it("renders persisted acted recommendations without manufacturing resume authority", () => {
    state.lanePayload = metaLanePayload({
      actionNow: [
        metaRec({
          id: "rec_acted",
          level: "adset",
          adsetId: "adset_1",
          adsetName: "Paused Adset",
          type: "adset_cut_spend",
          operatorResponseState: "acted",
        }),
      ],
      watching: [],
      counts: {
        actionNow: 1,
        watching: 0,
        healthy: 1,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    const row = exactArticleHtml(
      html,
      'data-meta-exact-action-row="rec_acted"',
    );
    expect(row).toContain("Paused Adset");
    expect(row).not.toContain("Resume");
    expect(html).not.toContain('data-operator-response="acted"');
    expect(html).not.toContain("Resume adset");
  });

  it("pins Decisions to active status even when a legacy URL requests all", () => {
    state.search = "window=28d&status_filter=all";

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).not.toContain('data-status-filter-option="all"');
    expect(state.queryKeys).toContainEqual([
      "meta-decisions-workspace",
      "biz_1",
      "act_1",
      "28d",
      "active",
      expect.any(String),
      expect.any(String),
      60,
    ]);
  });

  it("uses endpoint-provided selected ROAS for custom ranges", () => {
    state.search = "window=custom&startDate=2026-05-01&endDate=2026-05-07";
    state.pulsePayload = metaPulse({
      window: "custom",
      startDate: "2026-05-01",
      endDate: "2026-05-07",
      roas: {
        selected: 4.2,
        d7: 1.4,
        d14: 1.2,
        d28: 1.1,
        target: 2.5,
        median: 2.1,
        target_source: "commercial_truth",
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain("ROAS · selected range");
    expect(html).toContain(">4.20 ");
    expect(html).not.toContain(">1.10 ");
    expect(state.queryKeys).toContainEqual([
      "meta-decisions-workspace",
      "biz_1",
      "act_1",
      "custom",
      "active",
      "2026-05-01",
      "2026-05-07",
      60,
    ]);
  });

  it("surfaces target age as advisory without claiming reduced authority", () => {
    state.pulsePayload = metaPulse({
      roas: {
        selected: 3.2,
        d7: 2.8,
        d14: 3,
        d28: 3.2,
        target: 2.5,
        median: 2.1,
        target_source: "commercial_truth_stale",
        targetFreshness: "stale",
        targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
      targetAnchor: {
        configured: true,
        source: "configured_targets",
        targetRoas: 2.5,
        breakEvenRoas: 1.7,
        targetCpa: null,
        breakEvenCpa: null,
        freshness: "stale",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );

    expect(html).toContain("target 2.50 · stale");
    expect(html).not.toContain("reduced authority");
    expect(html).not.toContain("freshness unknown");
  });

  it("withholds authority when a configured target timestamp is unavailable", () => {
    state.pulsePayload = metaPulse({
      roas: {
        selected: 3.2,
        d7: 2.8,
        d14: 3,
        d28: 3.2,
        target: 2.5,
        median: 2.1,
        target_source: "commercial_truth_stale",
        targetFreshness: "unknown",
        targetUpdatedAt: null,
      },
      targetAnchor: {
        configured: true,
        source: "configured_targets",
        targetRoas: 2.5,
        breakEvenRoas: 1.7,
        targetCpa: null,
        breakEvenCpa: null,
        freshness: "unknown",
        updatedAt: null,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );

    expect(html).toContain("target 2.50 · freshness unknown");
    expect(html).not.toContain("authority unchanged");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Review recommendation<\/button>/,
    );
  });

  it("routes closed structures to the additive History surface", () => {
    state.search = "window=28d&lane=archive";
    state.lanePayload = metaLanePayload({
      archive: [
        {
          id: "cmp_paused",
          level: "campaign",
          name: "Paused ASC",
          status: "PAUSED",
          statusLabel: "Paused 12d",
          spend: 640,
          roas: 1.4,
          cpa: 91,
          purchases: 7,
          lastKnownWindow: "28d",
          diagnosticNote: null,
        },
        {
          id: "adset_archived",
          level: "adset",
          name: "Archived Adset",
          campaignId: "cmp_paused",
          campaignName: "Paused ASC",
          status: "ARCHIVED",
          statusLabel: "Archived",
          spend: 0,
          roas: 0,
          cpa: null,
          purchases: 0,
          lastKnownWindow: "28d",
          diagnosticNote: null,
        },
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 0,
        archive: 2,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-meta-exact-lane="archive"');
    expect(html).toContain('data-meta-exact-archive="true"');
    expect(html).toContain("Entity");
    expect(html).toContain("Status");
    expect(html).toContain("Spend · 28d");
    expect(html).toContain("Note");
    expect(html).toContain("Paused ASC");
    expect(html).toContain("Archived Adset");
    /*
     * "Inactive assets" is now a phrase with exactly one home: the advisory
     * strip that OPENS this lane. What must stay gone is the quiet inline row
     * — a closed structure smuggled back into a live lane as a dimmed line.
     */
    expect(html).not.toContain('data-meta-exact-inactive-strip="true"');
    expect(html).not.toContain('data-quiet-row="inactive-structure"');
  });

  /**
   * The archive lane carries the withheld Ad decisions, at their own grain.
   *
   * The page built `inactiveViewItems` from the served archive rows AND from
   * `decisionReadModel.queue.inactiveAssets`, then handed the exact adapter
   * `item.kind === "structure" ? [item.row] : []` — so every Ad it had just
   * fetched and filtered was discarded. Measured on the live dev server:
   * Grandmix (act_805150454596350) served 83 inactive Ads and rendered 0;
   * TheSwaf (act_822913786458311) served 319 and rendered 0. One Grandmix row
   * carried $699.34 of spend and appeared nowhere in the product.
   *
   * LAW: these rows are advisory only. The read model rewrites them with
   * `actionEligible: false` and `authorizedAction: null` before filing them
   * under `inactiveAssets`, so the lane shows them as evidence and never as a
   * recommendation with an action.
   */
  it("shows the withheld Ad decisions in the archive lane without lending them a verdict", () => {
    state.search = "window=28d&lane=archive";
    state.lanePayload = metaLanePayload({
      archive: [
        {
          id: "cmp_paused",
          level: "campaign",
          name: "Paused ASC",
          status: "PAUSED",
          statusLabel: "Paused 12d",
          spend: 640,
          roas: 1.4,
          cpa: 91,
          purchases: 7,
          lastKnownWindow: "28d",
          diagnosticNote: null,
        },
      ],
      counts: {
        actionNow: 0,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 1,
      },
    });
    const model = emptyCanonicalDecisionReadModel();
    model.queue.inactiveAssets = {
      preCapCount: 1,
      inactiveCount: 1,
      unknownCount: 0,
      items: [
        {
          decisionId: "mdd_inactive_1",
          sourceSnapshotId: "snapshot_inactive_1",
          identityGrain: "ad",
          parentChain: {
            account: { id: "act_1", name: "Account" },
            campaign: { id: "cmp_paused", name: "Paused ASC" },
            adset: { id: "adset_1", name: "Broad" },
            ad: { id: "120000000000000009", name: "Cat-Guarantee" },
            creative: { id: "creative_9", name: "Cat-Guarantee" },
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
          classification: { buyerLabel: "Cut this creative" },
          sourceDecision: { label: "cut", reason: "ROAS below target" },
          metrics: { spend: 699.34, purchases: 2, roas: 1.1 },
        },
      ],
    };
    state.decisionReadModel = model;

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-meta-exact-archive="true"');
    // The Ad reaches the screen at all — this is the row that used to vanish.
    expect(html).toContain("Cat-Guarantee");
    expect(html).toContain("$699.34");
    // Each grain says which it is, so an ad is not mistaken for an ad set.
    expect(html).toContain("Campaign · Paused 12d");
    expect(html).toContain("Ad · Not Active");
    // The chip counts the whole lane, both grains: 1 structure + 1 Ad.
    expect(html).toContain(">Archive<span>2</span>");
    // The served verdict stays out of the archive. A withheld decision that
    // reads like an ordinary recommendation is the invariant this must not
    // break (docs/creative-decision-center/INVARIANTS.md).
    expect(html).not.toContain("Cut this creative");
    expect(html).not.toContain("ROAS below target");
  });

  it("renders the Out of Sales Scope lane when nonSales entries are present", () => {
    state.search = "window=28d&lane=nonSales";
    state.lanePayload = metaLanePayload({
      nonSales: [
        metaRec({
          id: "rec_upper",
          campaignId: "cmp_upper",
          campaignName: "Video Views",
          title: "Video Views is out of sales scope",
          cohort: "upper_funnel",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 1,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain('data-meta-exact-lane="nonsales"');
    expect(html).toContain('data-meta-exact-nonsales="true"');
    expect(html).toContain("Non-sales");
    expect(html).toContain("Video Views");
    expect(html).not.toContain('type="checkbox"');
  });

  it("renders an empty Out of Sales Scope lane with a zero count", () => {
    state.search = "window=28d&lane=nonSales";
    state.lanePayload = metaLanePayload({
      nonSales: [],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain('data-meta-exact-lane="nonsales"');
    expect(html).toContain("Non-sales<span>0</span>");
    expect(html).toContain('data-meta-exact-nonsales="true"');
    expect(countText(html, ">—<")).toBeGreaterThanOrEqual(5);
    expect(html).not.toContain(
      "No out-of-sales-scope entities match the current filters.",
    );
  });

  it("renders nonSales entries without selection controls", () => {
    state.search = "window=28d&lane=nonSales";
    state.lanePayload = metaLanePayload({
      nonSales: [
        metaRec({
          id: "rec_upper",
          campaignId: "cmp_upper",
          campaignName: "Video Views",
          cohort: "upper_funnel",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 1,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain('data-meta-exact-nonsales="true"');
    expect(html).toContain("Video Views");
    expect(html).not.toContain('type="checkbox"');
  });

  it("renders upper-funnel nonSales entries as informational cards", () => {
    state.search = "window=28d&lane=nonSales";
    state.lanePayload = metaLanePayload({
      nonSales: [
        metaRec({
          id: "rec_upper",
          level: "adset",
          campaignId: "cmp_upper",
          campaignName: "Video Views",
          adsetId: "adset_upper",
          adsetName: "ThruPlay Broad",
          cohort: "upper_funnel",
          targetValue: {
            spend: 84,
            impressions: 1000,
            thruplayActions: 42,
            videoViews3s: 100,
            frequency: 1.7,
          },
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 1,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain("ThruPlay Broad");
    expect(html).toContain('data-meta-exact-nonsales="true"');
    expect(html).toContain("Upper funnel · informational");
    expect(html).toContain("Thruplay");
    expect(html).toContain("CPM · acct p50");
    expect(html).toContain("Reach · 28d");
    expect(html).not.toContain('type="checkbox"');
  });

  it("renders non-upper-funnel nonSales entries as evidence cards", () => {
    state.search = "window=28d&lane=nonSales";
    state.lanePayload = metaLanePayload({
      nonSales: [
        metaRec({
          id: "rec_mid",
          level: "adset",
          campaignId: "cmp_mid",
          campaignName: "ATC",
          adsetId: "adset_mid",
          adsetName: "ATC Broad",
          cohort: "mid_funnel",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 1,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain('data-meta-exact-nonsales="true"');
    expect(html).toContain("ATC Broad");
    expect(html).toContain("Mid Funnel · informational");
    expect(html).not.toContain("Upper funnel · informational");
    expect(html).not.toContain('data-card="meta-upper-funnel-informational"');
  });

  it("renders each mixed ad set as its own decision card", () => {
    state.lanePayload = metaLanePayload({
      actionNow: [
        metaRec({
          id: "rec_cut",
          level: "adset",
          campaignId: "cmp_mixed",
          campaignName: "Mixed Campaign",
          adsetId: "adset_cut",
          adsetName: "Weak Adset",
          type: "adset_cut_spend",
          title: "Cut weak adset",
        }),
        metaRec({
          id: "rec_scale",
          level: "adset",
          campaignId: "cmp_mixed",
          campaignName: "Mixed Campaign",
          adsetId: "adset_scale",
          adsetName: "Strong Adset",
          type: "adset_scale_budget",
          title: "Scale strong adset",
        }),
      ],
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(countText(html, "data-meta-exact-action-row=")).toBe(2);
    expect(html).toContain('data-meta-exact-action-row="rec_cut"');
    expect(html).toContain('data-meta-exact-action-row="rec_scale"');
    expect(html).toContain("Weak Adset");
    expect(html).toContain("Strong Adset");
    expect(html).not.toContain('data-card="cross-adset-rollup"');
  });

  it("renders a healthy campaign and its adsets in one exact group", () => {
    state.search = "window=28d&lane=healthy";
    state.lanePayload = metaLanePayload({
      healthy: [
        {
          id: "cmp_parent",
          level: "campaign",
          name: "Parent Campaign",
          spend: 476,
          roas: 1.99,
          cpa: 22,
          status: "ACTIVE",
        },
        {
          id: "adset_child_a",
          level: "adset",
          name: "Bathroom-USA-BC",
          campaignId: "cmp_parent",
          campaignName: "Parent Campaign",
          spend: 188,
          roas: 0.79,
          cpa: 31,
          status: "ACTIVE",
        },
        {
          id: "adset_child_b",
          level: "adset",
          name: "Claude-MAF-G1-LP",
          campaignId: "cmp_parent",
          campaignName: "Parent Campaign",
          spend: 168,
          roas: 0.8,
          cpa: 28,
          status: "ACTIVE",
        },
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 3,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(countText(html, "data-meta-exact-healthy-group=")).toBe(1);
    expect(html).toContain('data-meta-exact-healthy-group="cmp_parent"');
    expect(html).toContain("Parent Campaign");
    expect(html).toContain("Bathroom-USA-BC");
    expect(html).toContain("Claude-MAF-G1-LP");
    expect(html.indexOf("Parent Campaign")).toBeLessThan(
      html.indexOf("Bathroom-USA-BC"),
    );
  });

  it("keeps every healthy entity inside its exact campaign group", () => {
    state.search = "window=28d&lane=healthy";
    state.lanePayload = metaLanePayload({
      healthy: [
        metaHealthy({
          id: "cmp_uniform",
          level: "campaign",
          name: "Uniform Campaign",
          spend: 210,
          customEventType: "PURCHASE",
          bidStrategyType: "cost_cap",
          bidStrategyLabel: "Cost Cap",
          bidValue: 3000,
          bidValueFormat: "currency",
        }),
        metaHealthy({
          id: "adset_uniform_a",
          level: "adset",
          name: "Uniform Adset A",
          campaignId: "cmp_uniform",
          campaignName: "Uniform Campaign",
          spend: 101,
          customEventType: "PURCHASE",
          bidStrategyType: "cost_cap",
          bidStrategyLabel: "Cost Cap",
          bidValue: 3000,
          bidValueFormat: "currency",
        }),
        metaHealthy({
          id: "adset_uniform_b",
          level: "adset",
          name: "Uniform Adset B",
          campaignId: "cmp_uniform",
          campaignName: "Uniform Campaign",
          spend: 102,
          customEventType: "PURCHASE",
          bidStrategyType: "cost_cap",
          bidStrategyLabel: "Cost Cap",
          bidValue: 3000,
          bidValueFormat: "currency",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 3,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(countText(html, "data-meta-exact-healthy-group=")).toBe(1);
    expect(html).toContain('data-meta-exact-healthy-group="cmp_uniform"');
    expect(html).toContain("Uniform Campaign");
    expect(html).toContain("Uniform Adset A");
    expect(html).toContain("Uniform Adset B");
  });

  it("keeps mixed-optimization adsets in the exact healthy group", () => {
    state.search = "window=28d&lane=healthy";
    state.lanePayload = metaLanePayload({
      healthy: [
        metaHealthy({
          id: "cmp_mixed_events",
          level: "campaign",
          name: "Mixed Event Campaign",
          customEventType: null,
          isCustomEventTypeMixed: true,
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
        }),
        metaHealthy({
          id: "adset_purchase",
          level: "adset",
          name: "Purchase Adset",
          campaignId: "cmp_mixed_events",
          campaignName: "Mixed Event Campaign",
          customEventType: "PURCHASE",
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
        }),
        metaHealthy({
          id: "adset_atc",
          level: "adset",
          name: "ATC Adset",
          campaignId: "cmp_mixed_events",
          campaignName: "Mixed Event Campaign",
          customEventType: "ADD_TO_CART",
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 3,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(countText(html, "data-meta-exact-healthy-group=")).toBe(1);
    expect(html).toContain('data-meta-exact-healthy-group="cmp_mixed_events"');
    expect(html).toContain("Mixed Event Campaign");
    expect(html).toContain("Purchase Adset");
    expect(html).toContain("ATC Adset");
  });

  it("keeps mixed-bid adsets in the exact healthy group", () => {
    state.search = "window=28d&lane=healthy";
    state.lanePayload = metaLanePayload({
      healthy: [
        metaHealthy({
          id: "cmp_mixed_bid",
          level: "campaign",
          name: "Mixed Bid Campaign",
          customEventType: "PURCHASE",
          bidStrategyType: null,
          bidStrategyLabel: null,
          isBidStrategyMixed: true,
        }),
        metaHealthy({
          id: "adset_cost_cap",
          level: "adset",
          name: "Cost Cap Adset",
          campaignId: "cmp_mixed_bid",
          campaignName: "Mixed Bid Campaign",
          customEventType: "PURCHASE",
          bidStrategyType: "cost_cap",
          bidStrategyLabel: "Cost Cap",
          bidValue: 3000,
          bidValueFormat: "currency",
        }),
        metaHealthy({
          id: "adset_bid_cap",
          level: "adset",
          name: "Bid Cap Adset",
          campaignId: "cmp_mixed_bid",
          campaignName: "Mixed Bid Campaign",
          customEventType: "PURCHASE",
          bidStrategyType: "bid_cap",
          bidStrategyLabel: "Bid Cap",
          bidValue: 2400,
          bidValueFormat: "currency",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 3,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(countText(html, "data-meta-exact-healthy-group=")).toBe(1);
    expect(html).toContain('data-meta-exact-healthy-group="cmp_mixed_bid"');
    expect(html).toContain("Mixed Bid Campaign");
    expect(html).toContain("Cost Cap Adset");
    expect(html).toContain("Bid Cap Adset");
  });

  it("renders an orphan healthy adset once under its campaign context", () => {
    state.search = "window=28d&lane=healthy";
    state.lanePayload = metaLanePayload({
      healthy: [
        metaHealthy({
          id: "adset_atc_only",
          level: "adset",
          name: "25Video",
          campaignId: "cmp_adtc",
          campaignName: "ADTC",
          spend: 541,
          roas: 0.13,
          customEventType: "ADD_TO_CART",
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="IwaStore"
        currency="USD"
      />,
    );

    // No synthetic campaign header: the orphan ad set remains a single row.
    expect(html).not.toContain("data-healthy-synthetic-campaign");
    expect(countText(html, "data-meta-exact-healthy-group=")).toBe(1);
    expect(html).toContain('data-meta-exact-healthy-group="cmp_adtc"');
    expect(html).toContain("25Video");
    expect(html).toContain("ADTC");
  });
});

describe("concise header freshness", () => {
  beforeEach(() => {
    state.lanePayload = null;
    state.pulsePayload = null;
    state.search = "window=28d";
    state.storeBusinesses = [];
  });

  it("surfaces the real sync age without backend snapshot metadata", () => {
    state.pulsePayload = metaPulse({ lastSyncAt: "2020-01-01T00:00:00.000Z" });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-screen-label="Meta Decision Center"');
    expect(html).toMatch(/Updated: synced \d+d ago/);
    expect(html).not.toContain("snapshot 2026-05-07");
    expect(html).not.toContain("engine v3-test");
    expect(html).not.toContain("engine v3.6.0-meta-taxonomy");
  });

  it("renders sync unknown when ingest freshness is absent, never a fabricated time", () => {
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain(">Updated: synced —<");
    expect(html).not.toContain("snapshot 2026-05-07");
    expect(html).not.toContain("engine v3-test");
    expect(html).not.toContain("sync unknown");
  });

  it("does not expose the old queue-scope diagnostic note", () => {
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).not.toContain("queue reflects snapshot");
    expect(html).not.toContain('data-testid="meta-queue-scope-note"');
  });
});

describe("decision row sort and search", () => {
  it("renders the sort control and free-text search over the lanes", () => {
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain('aria-label="Sort decisions"');
    expect(html).toContain('aria-label="Find entities"');
    expect(html).not.toContain('data-testid="meta-row-sort"');
    expect(html).not.toContain('data-testid="meta-row-search"');
  });

  it("sorts by money at stake and keeps missing-metric rows last", () => {
    const rows = [
      metaRec({ id: "a", metrics: { spend: 100 } }),
      metaRec({ id: "b", metrics: null }),
      metaRec({ id: "c", metrics: { spend: 900 } }),
      metaRec({ id: "d", metrics: { spend: 400 } }),
    ];
    const ids = sortMetaRecs(rows, "money").map((rec) => rec.id);
    expect(ids).toEqual(["c", "d", "a", "b"]);
  });

  it("sorts by priority with unknown priority last and stable ties", () => {
    const rows = [
      metaRec({ id: "lo", priority: "low" }),
      metaRec({ id: "hi1", priority: "high" }),
      metaRec({ id: "mid", priority: "medium" }),
      metaRec({ id: "hi2", priority: "high" }),
    ];
    expect(sortMetaRecs(rows, "priority").map((rec) => rec.id)).toEqual([
      "hi1",
      "hi2",
      "mid",
      "lo",
    ]);
  });

  it("matches search across entity name, campaign, and decision label", () => {
    const rec = metaRec({
      campaignName: "Prospecting ASC",
      adsetName: "Broad EU",
      decisionLabel: "cut",
    });
    expect(metaRecSearchMatch(rec, "")).toBe(true);
    expect(metaRecSearchMatch(rec, "broad")).toBe(true);
    expect(metaRecSearchMatch(rec, "CUT")).toBe(true);
    expect(metaRecSearchMatch(rec, "nonsense-token")).toBe(false);
  });
});

describe("tracking write gate (regression: dismissal must not unlock writes)", () => {
  it("blocks on server verdict and takes no dismissal input at all", () => {
    expect(
      isTrackingWriteBlocked({
        trackingAnomalyActive: true,
        trackingHealth: { status: "healthy", detail: "" },
      }),
    ).toBe(true);
    expect(
      isTrackingWriteBlocked({
        trackingAnomalyActive: undefined as never,
        trackingHealth: { status: "blocked", detail: "" },
      }),
    ).toBe(true);
    expect(
      isTrackingWriteBlocked({
        trackingAnomalyActive: false,
        trackingHealth: { status: "blocked", detail: "" },
      }),
    ).toBe(true);
    expect(isTrackingWriteBlocked(null)).toBe(false);
    // Signature-level proof: the gate accepts only the server payload -
    // client dismissal state cannot influence it.
    expect(isTrackingWriteBlocked.length).toBe(1);
  });
});

describe("data readiness banner", () => {
  it("surfaces not-ready data instead of silent zeros", () => {
    state.workspaceDigest = quietWorkspaceDigest();
    state.pulsePayload = metaPulse({
      dataReadiness: {
        status: "no_accounts_assigned",
        isPartial: false,
        notReadyReason: "No Meta ad account is assigned to this workspace.",
        evidenceSource: "unknown",
      },
    });
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain("Recent data is still loading.");
    expect(html).toContain("The recommendations shown here may update.");
    expect(html).not.toContain("No Meta ad account is assigned");
  });
});

/**
 * THE DEMO ARM: healthy readiness, fabricated numbers, and — until now — total
 * silence.
 *
 * `lib/meta/campaigns-source.ts:65-72` short-circuits a demo business to
 * `{ status: "ok", isPartial: false, evidenceSource: "demo" }` around
 * `getDemoMetaCampaigns().rows`, and `app/api/meta/account-pulse/route.ts:855`
 * copies that onto `pulse.dataReadiness`. The readiness banner's gate is
 * `status !== "ok" || isPartial`, so in the ONE arm where every number is
 * fabricated the gate reads healthy and nothing fires. Nothing upstream covers
 * it either — the demo `PostureNotice` lives in the zero-base shell, and this
 * page renders under `app/(dashboard)/layout.tsx`.
 *
 * These tests pin both halves: the disclosure appears when the evidence is not
 * a measurement, and it stays away when it is.
 */
describe("evidence-source disclosure", () => {
  beforeEach(() => {
    state.lanePayload = null;
    state.pulsePayload = null;
    state.workspaceBanners = [];
    state.workspaceDigest = quietWorkspaceDigest();
    state.search = "window=28d";
    state.storeBusinesses = [];
  });

  afterEach(() => {
    state.pulsePayload = null;
    state.workspaceBanners = [];
    state.workspaceDigest = null;
  });

  function renderWithEvidence(evidenceSource: string) {
    state.pulsePayload = metaPulse({
      dataReadiness: {
        // The demo arm's own values: nothing here is "not ready".
        status: "ok",
        isPartial: false,
        notReadyReason: null,
        evidenceSource,
      },
    });
    // The digest is silenced so this block reads only the evidence banner.
    state.workspaceDigest = {
      snapshotDate: "2026-05-07",
      unavailableReason: null,
      labelFlips: { count: 0, publishedCount: 0, items: [] },
      actions: { verifiedCount: 0, silentFailureCount: 0, items: [] },
      anomalies: { openedCount: 0, items: [] },
      deferrals: { dueCount: 0, items: [] },
    };
    return renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
  }

  it("classifies the whole served vocabulary, and only the measured tokens pass silently", () => {
    // Measured: a live read, the warehouse rollup of the same rows, and a
    // stored snapshot. `MetaEvidenceSource` (lib/meta/operator-policy.ts:35)
    // plus the pulse route's "warehouse" (account-pulse/route.ts:602, :639).
    expect(metaEvidenceSourceNotice("live")).toBeNull();
    expect(metaEvidenceSourceNotice("warehouse")).toBeNull();
    expect(metaEvidenceSourceNotice("snapshot")).toBeNull();
    expect(metaEvidenceSourceNotice("  LIVE  ")).toBeNull();

    expect(metaEvidenceSourceNotice("demo")?.kind).toBe("demonstration");
    expect(metaEvidenceSourceNotice("fallback")?.kind).toBe("fallback");
    expect(metaEvidenceSourceNotice("unknown")?.kind).toBe("unnamed");
    expect(metaEvidenceSourceNotice("")?.kind).toBe("unnamed");
    expect(metaEvidenceSourceNotice(null)?.kind).toBe("unnamed");

    // The hole this function exists to close must not reopen for token seven:
    // an unrecognised source is NAMED, never assumed measured.
    const future = metaEvidenceSourceNotice("federated_export");
    expect(future?.kind).toBe("unreadable");
    expect(future?.detail).toContain("federated_export");
  });

  it("maps demonstration provenance to concise buyer-facing status", () => {
    const html = renderWithEvidence("demo");
    expect(html).toContain('data-banner-id="readiness_evidence_source"');
    expect(html).toContain("Performance figures need verification.");
    expect(html).toContain("sample or unverified data");
    expect(html).toContain("not confirmed measurements for this Meta account");
    expect(html).not.toContain(
      "These are demonstration numbers, not measurements.",
    );
    expect(html).not.toContain(
      "sample values, not readings of this ad account",
    );
    // The readiness banner still cannot fire here - that is the whole defect.
    expect(html).not.toContain('data-banner-id="data_readiness"');
    // It reports; it does not act. No control, no decision, no write.
    const banner = html.slice(
      html.indexOf('data-banner-id="readiness_evidence_source"'),
    );
    expect(banner.slice(0, banner.indexOf("</div>"))).not.toContain("<button");
  });

  it("does not expose an unrecognised backend source token", () => {
    const html = renderWithEvidence("federated_export");
    expect(html).toContain('data-banner-id="readiness_evidence_source"');
    expect(html).toContain("Performance figures need verification.");
    expect(html).toContain("sample or unverified data");
    expect(html).not.toContain("federated_export");
    expect(html).not.toContain("cannot read");
  });

  it("stays silent when the evidence IS a measurement", () => {
    for (const source of ["live", "warehouse", "snapshot"]) {
      const html = renderWithEvidence(source);
      expect(html).not.toContain('data-banner-id="readiness_evidence_source"');
    }
  });

  it("does not repeat the readiness banner when the source is merely unnamed", () => {
    // `campaigns-source.ts` returns "unknown" for an empty range, the same
    // event that fills `notReadyReason`. There the readiness banner really
    // does state the consequence, and two warnings for one fact is wallpaper.
    state.pulsePayload = metaPulse({
      dataReadiness: {
        status: "ok",
        isPartial: true,
        notReadyReason: "Campaign warehouse data is still being prepared.",
        evidenceSource: "unknown",
      },
    });
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain('data-banner-id="data_readiness"');
    expect(html).not.toContain('data-banner-id="readiness_evidence_source"');
  });

  it("keeps evidence truth inside one prioritized status when a served banner is also present", () => {
    // The regression this guards: `served.length > 0` replaces the whole
    // fallback list, so a demo account with any served banner used to go back
    // to drawing fabricated numbers in silence.
    state.workspaceBanners = [
      {
        id: "snapshot_health",
        tone: "warning",
        title: "Decision snapshot is not fresh.",
        detail: "served",
        blocking: false,
      },
    ];
    const html = renderWithEvidence("demo");
    expect(html).toContain('data-banner-id="snapshot_health"');
    expect(html).not.toContain('data-banner-id="readiness_evidence_source"');
    expect(html).toContain('data-critical-evidence="true"');
    expect(countText(html, 'class="meta-posture-banner ')).toBe(1);
    expect(html).toContain("Decisions are updating.");
    expect(html).toContain("sample or unverified data");
    expect(html).not.toContain("These are demonstration numbers");
  });

  it("sanitizes a served banner with the same evidence id", () => {
    state.workspaceBanners = [
      {
        id: "readiness_evidence_source",
        tone: "warning",
        title: "Served evidence disclosure.",
        detail: "served detail",
        blocking: false,
      },
    ];
    const html = renderWithEvidence("demo");
    expect(html).not.toContain("Served evidence disclosure.");
    expect(html).toContain("Performance figures need verification.");
    expect(html).toContain("sample or unverified data");
    expect(html).not.toContain(
      "These are demonstration numbers, not measurements.",
    );
  });

  it("reaches the phone as well as the desk", () => {
    const html = renderWithEvidence("demo");
    expect(html).toContain('data-mobile-banner="readiness_evidence_source"');
  });
});

/**
 * A COUNT OF SILENT FAILURES MUST NOT ITSELF BE SILENT.
 *
 * `digest.actions.silentFailureCount`
 * (app/api/meta/decisions-workspace/route.ts:948-951) counts action-log rows
 * written as `silent_failure`, which is the status the write paths use for an
 * AMBIGUOUS provider outcome (launch/route.ts:106-113,
 * bulk-ad-status/route.ts:154-160): the write may have landed at Meta, retry is
 * suppressed, and nobody was told. Before this round the entire repo referenced
 * the field exactly twice - the route that computes it and the type that
 * declares it.
 */
describe("silent action failure disclosure", () => {
  beforeEach(() => {
    state.lanePayload = null;
    state.pulsePayload = null;
    state.workspaceBanners = [];
    state.workspaceDigest = null;
    state.search = "window=28d";
    state.storeBusinesses = [];
  });

  afterEach(() => {
    state.workspaceDigest = null;
    state.workspaceBanners = [];
  });

  function digest(actions: {
    verifiedCount: number;
    silentFailureCount: number;
    unavailableReason?: string | null;
    snapshotDate?: string | null;
    countedRowCap?: number | null;
    countsTruncated?: boolean;
  }) {
    return {
      snapshotDate:
        actions.snapshotDate === undefined
          ? "2026-05-07"
          : actions.snapshotDate,
      unavailableReason: actions.unavailableReason ?? null,
      labelFlips: { count: 0, publishedCount: 0, items: [] },
      actions: {
        verifiedCount: actions.verifiedCount,
        silentFailureCount: actions.silentFailureCount,
        countedRowCap:
          actions.countedRowCap === undefined ? 20 : actions.countedRowCap,
        countsTruncated: actions.countsTruncated ?? false,
        items: [],
      },
      anomalies: { openedCount: 0, items: [] },
      deferrals: { dueCount: 0, items: [] },
    };
  }

  it("states the count with verifiedCount as its denominator", () => {
    const notice = metaSilentActionFailureNotice(
      digest({ verifiedCount: 3, silentFailureCount: 2 }),
    );
    expect(notice?.title).toBe(
      "2 recorded actions ended without a verified outcome.",
    );
    expect(notice?.detail).toContain("since 2026-05-07");
    expect(notice?.detail).toContain("5 recorded actions: 3 verified, 2 not");
    // The outcome is unknown, and the sentence says so rather than asserting
    // that the account did or did not change.
    expect(notice?.detail).toContain("may or may not have landed at Meta");
  });

  it("agrees with the language on a single failure", () => {
    const notice = metaSilentActionFailureNotice(
      digest({ verifiedCount: 0, silentFailureCount: 1 }),
    );
    expect(notice?.title).toBe(
      "1 recorded action ended without a verified outcome.",
    );
    expect(notice?.detail).toContain("1 recorded action: 0 verified, 1 not");
  });

  it("names no window when the digest carries no snapshot date", () => {
    const notice = metaSilentActionFailureNotice(
      digest({ verifiedCount: 1, silentFailureCount: 1, snapshotDate: null }),
    );
    expect(notice?.detail).toContain("action digest carries");
    expect(notice?.detail).not.toContain("since");
  });

  it("keeps a measured zero off the screen", () => {
    expect(
      metaSilentActionFailureNotice(
        digest({ verifiedCount: 9, silentFailureCount: 0 }),
      ),
    ).toBeNull();
    state.workspaceDigest = digest({
      verifiedCount: 9,
      silentFailureCount: 0,
    });
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).not.toContain('data-banner-id="silent_action_failures"');
  });

  it("never renders an unavailable digest as an empty success", () => {
    // A read failure is never an empty success. Every arm that sets
    // `unavailableReason` returns the UNTOUCHED `emptyDecisionDigest` zeros
    // beside it (route.ts:736, :976, :1336), so the `> 0` gate withholds them
    // - and this notice has no all-clear rendering to fall into anyway.
    expect(
      metaSilentActionFailureNotice(
        digest({
          verifiedCount: 0,
          silentFailureCount: 0,
          unavailableReason: "Digest source tables are not available.",
        }),
      ),
    ).toBeNull();
    // ...and `unavailableReason` is NOT a second gate. A positive count only
    // exists because the action-log query returned those rows; withholding it
    // on a sibling flag would render a measurement as nothing.
    expect(
      metaSilentActionFailureNotice(
        digest({
          verifiedCount: 0,
          silentFailureCount: 4,
          unavailableReason: "Digest source tables are not available.",
        }),
      )?.title,
    ).toBe("4 recorded actions ended without a verified outcome.");
    // The compact workspace surface omits `digest` entirely.
    expect(metaSilentActionFailureNotice(null)).toBeNull();
    expect(metaSilentActionFailureNotice(undefined)).toBeNull();
  });

  it("puts a concise review status on the desk and phone", () => {
    state.workspaceDigest = digest({
      verifiedCount: 1,
      silentFailureCount: 2,
    });
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain('data-banner-id="silent_action_failures"');
    expect(html).toContain('data-mobile-banner="silent_action_failures"');
    expect(html).toContain("Some recent changes need review.");
    expect(html).toContain("Open History to check them.");
    expect(html).not.toContain(
      "2 recorded actions ended without a verified outcome.",
    );
    expect(html).toContain('data-banner-blocking="false"');
    const banner = html.slice(
      html.indexOf('data-banner-id="silent_action_failures"'),
    );
    expect(banner.slice(0, banner.indexOf("</div>"))).not.toContain("<button");
  });

  it("does not let a stronger operating gate hide an uncertain action outcome", () => {
    state.workspaceBanners = [
      {
        id: "pipeline_blocker",
        tone: "warning",
        title: "Internal pipeline blocker detail.",
        detail: "raw_producer_reason",
        blocking: true,
      },
    ];
    state.workspaceDigest = digest({
      verifiedCount: 1,
      silentFailureCount: 2,
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-banner-id="pipeline_blocker"');
    expect(html).toContain('data-mobile-banner="pipeline_blocker"');
    expect(html).toContain('data-critical-unverified-action="true"');
    expect(html).toContain("Actions are temporarily unavailable.");
    expect(html).toContain("One or more recent Meta changes");
    expect(html).toContain("have an unverified result");
    expect(html).not.toContain("Internal pipeline blocker detail.");
    expect(html).not.toContain("raw_producer_reason");
    expect(countText(html, ">Open History</a>")).toBe(2);
    expect(countText(html, 'class="meta-posture-banner ')).toBe(1);
  });

  /**
   * THE CAP IS PART OF THE MEASUREMENT, SO IT IS PART OF THE SENTENCE.
   *
   * Both counts come from filtering the rows the BOUNDED action-log query
   * returned (route.ts, `META_ACTION_DIGEST_ROW_CAP`), so once the window
   * holds more qualifying rows than the cap allows they describe the newest
   * page and not the window - while "this account's action digest since
   * <date> carries M recorded actions" reads as the window's total. Nothing
   * here is fabricated, which is exactly why it was easy to leave: the numbers
   * were measured and the FRAME around them was too wide. Same family as the
   * null status read as "archived" that erased 95% of an account's spend.
   */
  it("states a floor, not a total, when the digest read a full page", () => {
    const notice = metaSilentActionFailureNotice(
      digest({
        verifiedCount: 17,
        silentFailureCount: 3,
        countedRowCap: 20,
        countsTruncated: true,
      }),
    );
    // A floor, because three is what the newest twenty contained and the
    // window may hold more behind them.
    expect(notice?.title).toBe(
      "At least 3 recorded actions ended without a verified outcome.",
    );
    // The count is framed as the page it came from...
    expect(notice?.detail).toContain(
      "counts only its 20 most recent recorded actions",
    );
    // ...the 20 is explained rather than left as a riddle...
    expect(notice?.detail).toContain("the most a 20-row cap lets it read");
    // ...and the window's real total is refused, not guessed.
    expect(notice?.detail).toContain(
      "The window may hold more recorded actions than this count covers",
    );
    expect(notice?.detail).toContain(
      "whether it does, and how many, is unavailable here",
    );
    // The old, too-wide frame is gone.
    expect(notice?.detail).not.toContain("carries 20 recorded actions");
  });

  /*
   * The boundary is the whole reason this sentence hedges.
   *
   * `countsTruncated` is `rows.length >= cap`. A window holding EXACTLY the cap
   * was read out completely, and the flag cannot tell it from one holding four
   * thousand. An earlier draft asserted "The window holds more recorded actions
   * than this count covers" — an unmeasured positive claim, in the very
   * sentence that exists to stop a measured count reading wider than its
   * measurement. The floor in the title stays exact; the fourth sentence may
   * only be as strong as `>=` actually is.
   */
  it("never asserts more rows exist, because a full page may be the whole window", () => {
    const notice = metaSilentActionFailureNotice(
      digest({
        verifiedCount: 18,
        silentFailureCount: 2,
        countedRowCap: 20,
        countsTruncated: true,
      }),
    );
    expect(notice?.title).toBe(
      "At least 2 recorded actions ended without a verified outcome.",
    );
    for (const claim of [
      "The window holds more",
      "there are more",
      "more actions exist",
    ]) {
      expect(notice?.detail).not.toContain(claim);
    }
    expect(notice?.detail).toContain("may hold more recorded actions");
  });

  it("keeps the untruncated sentence exactly as wide as before", () => {
    const notice = metaSilentActionFailureNotice(
      digest({
        verifiedCount: 3,
        silentFailureCount: 2,
        countedRowCap: 20,
        countsTruncated: false,
      }),
    );
    expect(notice?.title).toBe(
      "2 recorded actions ended without a verified outcome.",
    );
    expect(notice?.detail).toContain("5 recorded actions: 3 verified, 2 not");
    expect(notice?.title).not.toContain("At least");
    expect(notice?.detail).not.toContain("cap");
  });

  it("names no cap the payload did not serve", () => {
    // Truncation without a served cap still gets the floor and the warning.
    // Filling the gap with a plausible 20 would put a fabricated number where
    // a measured one belongs, which is the defect wearing the other face.
    const notice = metaSilentActionFailureNotice(
      digest({
        verifiedCount: 5,
        silentFailureCount: 1,
        countedRowCap: null,
        countsTruncated: true,
      }),
    );
    expect(notice?.title).toBe(
      "At least 1 recorded action ended without a verified outcome.",
    );
    expect(notice?.detail).toContain(
      "counts only its 6 most recent recorded actions",
    );
    expect(notice?.detail).not.toContain("-row cap");
    expect(notice?.detail).toContain(
      "The window may hold more recorded actions than this count covers",
    );
  });

  it("names no window on a truncated digest with no snapshot date", () => {
    const notice = metaSilentActionFailureNotice(
      digest({
        verifiedCount: 4,
        silentFailureCount: 1,
        countedRowCap: 5,
        countsTruncated: true,
        snapshotDate: null,
      }),
    );
    expect(notice?.detail).toContain("action digest counts only");
    expect(notice?.detail).not.toContain("since");
  });

  it("keeps a measured zero silent even when the read was truncated", () => {
    expect(
      metaSilentActionFailureNotice(
        digest({
          verifiedCount: 20,
          silentFailureCount: 0,
          countedRowCap: 20,
          countsTruncated: true,
        }),
      ),
    ).toBeNull();
  });

  /**
   * AN ALARM THAT NAMES NOWHERE TO TAKE IT.
   *
   * The banner said "nothing on this page can tell which" - true of this page,
   * false of the product. `/platforms/meta/history` labels each
   * `meta_ads_action_log` row `Silent failure` or `Verified`
   * (history-view.tsx:88-97,140-146; history-read-model.ts:502) over a
   * GET-only route (app/api/meta/history/route.ts exports `dynamic` and `GET`
   * and nothing else), so pointing at it creates NO provider-write authority.
   * The strip already does this: `meta_write_kill_switch` carries a System
   * Status link.
   */
  it("sends the reader to the screen that can tell the two apart", () => {
    state.workspaceDigest = digest({
      verifiedCount: 1,
      silentFailureCount: 2,
    });
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    // Named in words, so every surface carries the destination even where a
    // control would not.
    expect(html).toContain("Open History to check them.");
    // And reachable, scoped to the same business and account this page is
    // answering for rather than whichever one the journal would pick.
    expect(html).toContain(
      'href="/platforms/meta/history?businessId=biz_1&amp;providerAccountId=act_1"',
    );
    const desktop = html.slice(
      html.indexOf('data-banner-id="silent_action_failures"'),
    );
    const desktopBanner = desktop.slice(0, desktop.indexOf("</div>"));
    expect(desktopBanner).toContain(">Open History</a>");
    const mobile = html.slice(
      html.indexOf('data-mobile-banner="silent_action_failures"'),
    );
    expect(mobile.slice(0, mobile.indexOf("</article>"))).toContain(
      ">Open History</a>",
    );
  });

  it("reports and never acts", () => {
    state.workspaceDigest = digest({
      verifiedCount: 1,
      silentFailureCount: 2,
      countedRowCap: 3,
      countsTruncated: true,
    });
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    const desktop = html.slice(
      html.indexOf('data-banner-id="silent_action_failures"'),
    );
    const desktopBanner = desktop.slice(0, desktop.indexOf("</div>"));
    const mobile = html.slice(
      html.indexOf('data-mobile-banner="silent_action_failures"'),
    );
    const mobileBanner = mobile.slice(0, mobile.indexOf("</article>"));
    // A destination is not a control. The outcome is unknown; nothing here may
    // offer to change it, and this page holds no write authority to try.
    for (const element of [desktopBanner, mobileBanner]) {
      expect(element).not.toContain("<button");
      for (const verb of [
        "Retry",
        "Resume",
        "Pause",
        "Apply",
        "Fix",
        "Undo",
        "Rerun",
        "Reconcile",
      ]) {
        expect(element).not.toContain(verb);
      }
    }
  });

  it("sanitizes a served silent-failure banner with the same id", () => {
    state.workspaceBanners = [
      {
        id: "silent_action_failures",
        tone: "danger",
        title: "Served silent-failure recap.",
        detail: "served detail",
        blocking: false,
      },
    ];
    state.workspaceDigest = digest({
      verifiedCount: 1,
      silentFailureCount: 2,
    });
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).not.toContain("Served silent-failure recap.");
    expect(html).toContain("Some recent changes need review.");
    expect(html).not.toContain(
      "2 recorded actions ended without a verified outcome.",
    );
  });
});

/**
 * THE LAW: the phone and the desk read the same payload the same way.
 *
 * Below 720px the stylesheet shows `.meta-mobile-decision-stage` and hides every
 * sibling with `display: none !important`, so whatever the mobile subtree does
 * not render is invisible to a phone. The old subtree rendered its own reduced
 * truth: legacy recommendation rows only, `.slice(0, 2)`, one anomaly, and no
 * blocked/monitor decisions, no inactive Ads, no capabilities, no source
 * limitations and no viewer authority. Two surfaces, one backend, two answers.
 *
 * What must NOT change is write authority: mobile stays read-only. That is a
 * product law, not a gap — so these tests pin both halves. The mobile subtree
 * carries the same rows and the same counts as the desktop, and it carries no
 * write control at all.
 */
describe("mobile decision surface parity", () => {
  beforeEach(() => {
    state.queryKeys = [];
    state.lanePayload = null;
    state.pulsePayload = null;
    state.labelCampaigns = [];
    state.campaignLabels = [];
    state.search = "window=28d";
    state.pathname = "/platforms/meta";
    state.storeBusinesses = [];
    state.workspaceBanners = [];
    state.workspaceViewer = {
      role: "collaborator",
      isReviewer: false,
      readOnly: false,
      readOnlyReason: null,
    };
    state.providerAccounts = [
      { id: "act_1", name: "Main Meta", currency: "USD", timezone: "UTC" },
    ];
    state.decisionReadModel = null;
    state.osSource = null;
    state.osPresentation = null;
    state.exactScope = null;
    state.exactProps = null;
    state.queryOverrides = {};
    state.routerReplace.mockClear();
  });

  function mobileHtml(html: string): string {
    const start = html.indexOf('<section class="meta-mobile-decision-stage"');
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf(
      "</section>",
      html.indexOf("ad-mobile-desktop-note"),
    );
    return html.slice(start, end);
  }

  it("renders every action row the desktop lane renders, uncapped", () => {
    state.lanePayload = metaLanePayload({
      actionNow: [
        metaRec({ id: "rec_1", title: "Row One", campaignName: "Row One" }),
        metaRec({ id: "rec_2", title: "Row Two", campaignName: "Row Two" }),
        metaRec({ id: "rec_3", title: "Row Three", campaignName: "Row Three" }),
        metaRec({ id: "rec_4", title: "Row Four", campaignName: "Row Four" }),
      ],
      watching: [],
      counts: {
        actionNow: 4,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    const mobile = mobileHtml(html);
    for (const id of ["rec_1", "rec_2", "rec_3", "rec_4"]) {
      expect(mobile).toContain(`data-mobile-row-id="${id}"`);
    }
    // The pre-fix surface sliced at two. Four served rows, four rendered rows.
    expect(mobile.match(/data-mobile-row-id=/g)?.length).toBe(4);
    expect(mobile).toContain("TheSwaf · Act now 4");
  });

  it("keeps mixed context and commercial blockers aligned across desktop, mobile, and inspector", () => {
    const rec = metaRec({
      id: "rec_blocked",
      campaignId: "cmp_1",
      campaignName: "Blocked campaign",
      decisionLabel: "cut",
      proposedAction: { kind: "pause" },
      automationReadiness: {
        contractVersion: "meta-automation-readiness.v1",
        tier: "manual_review",
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        decisionLabel: "cut",
        blockers: [
          "diagnostic_or_watch_state",
          "campaign_context_unresolved",
          "missing_commercial_anchor",
        ],
        missingEvidence: [
          "automatic_campaign_context_authority",
          "commercial_target_or_breakeven",
        ],
        requiredEvidence: [
          "automatic_campaign_context_authority",
          "commercial_target_or_breakeven",
        ],
        reason: "Campaign context and commercial authority require review.",
      },
    });
    const node = exactStructureNode({
      action: {
        code: "review_commercial_truth",
        label: "Review Commercial Truth",
        intent: "review",
        targetLevel: "campaign",
        providerMutation: null,
        scopeNote: "Current target ROAS authority is unavailable.",
      },
    });
    const os = exactOsPresentation([]);
    state.lanePayload = metaLanePayload({
      actionNow: [rec],
      watching: [],
      counts: {
        actionNow: 1,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    });
    state.osPresentation = {
      ...os,
      structure: {
        groups: [
          {
            id: "group_1",
            campaign: node,
            adsets: [],
            highestPriority: node.priority,
            highestUrgency: node.urgency,
            urgentAdsetCount: 0,
          },
        ],
        actCount: 0,
        blockedCount: 1,
        monitorCount: 0,
        suppressedAlternativeCount: 0,
      },
    };
    state.search = "window=28d&area=monitor&segment=needs_resolution";

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        mutationUiEnabled
      />,
    );
    const mobile = mobileHtml(html);
    const rowStart = mobile.indexOf('data-mobile-row-id="rec_blocked"');
    const row = mobile.slice(rowStart, mobile.indexOf("</article>", rowStart));
    const desktopRow = exactArticleHtml(
      html,
      'data-meta-exact-needsres-row="rec_blocked"',
    );
    const nextStep = "Confirm the ROAS target before acting.";

    expect(rowStart).toBeGreaterThan(-1);
    expect(countText(row, nextStep)).toBe(1);
    expect(countText(row, "Read evidence")).toBe(1);
    expect(countText(desktopRow, nextStep)).toBe(1);
    expect(state.exactProps.viewModel.inspector).toMatchObject({
      serverVerdict: "Confirm commercial target",
      contractDetail: nextStep,
      reasons: ["A valid performance target is required."],
      actionLabel: "Confirm commercial target",
      manualAction: null,
    });
    expect(state.exactProps.viewModel.inspector).not.toHaveProperty(
      "onPrimary",
    );
    expect(html).not.toContain(">Confirm commercial target</button>");
    expect(html).not.toContain(">Review change</button>");
    expect(html).not.toContain('data-mobile-apply="rec_blocked"');
    expect(html).not.toContain(">Review campaign context</button>");
  });

  it("offers evidence on every row, and a write only where the server named one", () => {
    state.lanePayload = metaLanePayload({
      actionNow: [metaRec({ id: "rec_1", title: "Row One" })],
      counts: {
        actionNow: 1,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    });

    const mobile = mobileHtml(
      renderToStaticMarkup(
        <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
      ),
    );
    const rowStart = mobile.indexOf('data-mobile-row-id="rec_1"');
    const row = mobile.slice(rowStart, mobile.indexOf("</article>", rowStart));
    expect(row).toContain("Read evidence →");
    /*
      RESTATED LAW. This used to assert that mobile offered exactly one control
      and that the stage said "Writes are desktop-only". It no longer does: a
      row whose server payload names an `operatorApply` verb now carries the
      SAME manual action sheet the desktop carries, under the same
      `manual_operator_v1` authority and the same typed confirmation.

      `rec_1` is a campaign row with no `proposedAction`, so
      `serverOperatorApplyForRec` returns null for it and no apply control is
      drawn — which is what this case still pins: the control follows the
      server's verb, not the device. The positive case, the STOP case and the
      guest case are driven in
      components/meta/redesign/mobile-card-apply-ceremony.test.tsx.
    */
    expect(row).not.toContain("Pause");
    expect(row).not.toContain("Apply ·");
    expect(row).not.toContain("Resume");
    expect(row).not.toContain("data-mobile-apply=");
    expect(mobile).not.toContain("Writes are desktop-only");
    expect(mobile).not.toContain(
      "the same manual action sheet the desktop carries",
    );
  });

  it("maps read-only authority to one useful status without source diagnostics", () => {
    state.workspaceDigest = quietWorkspaceDigest();
    state.workspaceViewer = {
      role: "guest",
      isReviewer: true,
      readOnly: true,
      readOnlyReason: "Reviewer access is read-only.",
    };
    const model = emptyCanonicalDecisionReadModel();
    model.capabilities = {
      providerAccountScope: { status: "available", reason: null },
      responseAttribution: {
        status: "unavailable",
        reason: "legacy_response_journal_not_keyed_by_decision_episode",
      },
      providerWriteLinkage: {
        status: "unavailable",
        reason: "provider_write_journal_not_keyed_by_decision_episode",
      },
    };
    model.queue.inactiveAssets = {
      preCapCount: 83,
      inactiveCount: 83,
      unknownCount: 0,
      items: [],
    };
    model.queue.adCandidates = {
      selectionVersion: "meta-decisions-ad-candidate-selection.v2",
      limit: 60,
      preCapCount: 71,
      eligiblePreCapCount: 71,
      selectedCount: 2,
      stateCounts: {
        act: { preCapCount: 0, selectedCount: 0 },
        monitor: { preCapCount: 0, selectedCount: 0 },
        blocked: { preCapCount: 2, selectedCount: 2 },
      },
      omittedAmbiguousIdentity: 0,
      omittedWithoutVerifiedAdId: 0,
      omittedNotApplicable: 0,
      items: [],
    };
    state.decisionReadModel = model;
    state.osSource = {
      adsSource: "legacy_creative_review_only",
      health: "degraded",
      structureSource: "meta_recommendations",
      fallbackReason: "native_schema_or_generation_read_failed",
      snapshotAsOf: "2026-08-19",
      engineVersion: "v3-test",
    };
    state.lanePayload = metaLanePayload({
      actionNow: [metaRec({ id: "rec_1", title: "Row One" })],
      counts: {
        actionNow: 1,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    });

    const mobile = mobileHtml(
      renderToStaticMarkup(
        <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
      ),
    );
    expect(mobile).toContain('data-mobile-row-id="rec_1"');
    expect(mobile).toContain("Read-only access.");
    expect(mobile).toContain(
      "You can review recommendations, but you cannot apply changes.",
    );
    expect(mobile).not.toContain("data-mobile-posture");
    expect(mobile).not.toContain("Legacy Creative Review Only");
    expect(mobile).not.toContain("native_schema_or_generation_read_failed");
    expect(mobile).not.toContain("provider_write_journal");
    expect(mobile).not.toContain("83 inactive Ads");
  });

  it("shows one concise anomaly instead of a diagnostic list", () => {
    state.workspaceDigest = quietWorkspaceDigest();
    state.lanePayload = metaLanePayload({
      actionNow: [],
      watching: [],
      counts: {
        actionNow: 0,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    });
    state.queryOverrides["meta-anomalies"] = {
      data: {
        anomalies: [
          metaAnomaly({ id: "anom_1", title: "First anomaly" }),
          metaAnomaly({ id: "anom_2", title: "Second anomaly" }),
        ],
      },
    };

    const mobile = mobileHtml(
      renderToStaticMarkup(
        <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
      ),
    );
    expect(mobile).toContain("A policy issue is blocking delivery");
    expect(countText(mobile, "A policy issue is blocking delivery")).toBe(1);
    expect(mobile).not.toContain("First anomaly");
    expect(mobile).not.toContain("Second anomaly");
  });

  it("renders creative rows on mobile and opens the mobile evidence screen", () => {
    const model = emptyCanonicalDecisionReadModel();
    state.decisionReadModel = model;
    state.osPresentation = exactOsPresentation([exactNativeAdDecision()]);
    state.exactScope = "creatives";
    state.search = "window=28d&scope=creatives";

    const mobile = mobileHtml(
      renderToStaticMarkup(
        <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
      ),
    );
    expect(mobile).toContain('data-mobile-scope="creatives"');
    expect(mobile).toContain('data-mobile-row-id="os_ad_1"');
    expect(mobile).toContain("Hook Variant A");
    // The desktop creative drawer is a sibling of this subtree and is hidden by
    // the mobile stylesheet, so mobile has to own the evidence screen for a
    // creative row. Without it the row's only control opened nothing.
    expect(
      readFileSync("components/meta/redesign/MetaPlatformPage.tsx", "utf8"),
    ).toContain("<MetaMobileCreativeEvidenceScreen");
  });

  it("filters mobile creative rows by the selected decision lane", () => {
    state.decisionReadModel = emptyCanonicalDecisionReadModel();
    state.osPresentation = exactOsPresentation([
      exactNativeAdDecision({
        id: "act-row",
        decisionId: "mdd_act",
        adId: "120000000000000011",
        adName: "Act creative",
        creativeId: "creative_act",
        creativeName: "Act creative",
        lane: "act",
      }),
      exactNativeAdDecision({
        id: "blocked-row",
        decisionId: "mdd_blocked",
        adId: "120000000000000012",
        adName: "Blocked creative",
        creativeId: "creative_blocked",
        creativeName: "Blocked creative",
        lane: "blocked",
        blockers: [
          {
            code: "campaign_role_untrusted",
            label: "Campaign role is not trusted for action",
          },
        ],
      }),
      exactNativeAdDecision({
        id: "monitor-row",
        decisionId: "mdd_monitor",
        adId: "120000000000000013",
        adName: "Monitor creative",
        creativeId: "creative_monitor",
        creativeName: "Monitor creative",
        lane: "monitor",
      }),
    ]);
    state.exactScope = "creatives";

    state.search = "window=28d&scope=creatives";
    const actionMobile = mobileHtml(
      renderToStaticMarkup(
        <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
      ),
    );
    expect(actionMobile).toContain('aria-label="Creative decision lane"');
    expect(actionMobile).toContain("Action 1");
    expect(actionMobile).toContain("Needs Resolution 1");
    expect(actionMobile).toContain("Watching 1");
    expect(actionMobile).toContain('data-mobile-row-id="act-row"');
    expect(actionMobile).not.toContain('data-mobile-row-id="blocked-row"');
    expect(actionMobile).not.toContain('data-mobile-row-id="monitor-row"');

    state.search =
      "window=28d&scope=creatives&area=monitor&segment=needs_resolution";
    const blockedMobile = mobileHtml(
      renderToStaticMarkup(
        <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
      ),
    );
    expect(blockedMobile).not.toContain('data-mobile-row-id="act-row"');
    expect(blockedMobile).toContain('data-mobile-row-id="blocked-row"');
    expect(blockedMobile).not.toContain('data-mobile-row-id="monitor-row"');

    state.search = "window=28d&scope=creatives&area=monitor";
    const monitorMobile = mobileHtml(
      renderToStaticMarkup(
        <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
      ),
    );
    expect(monitorMobile).not.toContain('data-mobile-row-id="act-row"');
    expect(monitorMobile).not.toContain('data-mobile-row-id="blocked-row"');
    expect(monitorMobile).toContain('data-mobile-row-id="monitor-row"');
  });

  it("carries only the useful scope and decision lane chips", () => {
    state.lanePayload = metaLanePayload({
      counts: {
        actionNow: 3,
        watching: 1089,
        healthy: 0,
        nonSales: 30,
        archive: 0,
      },
      structureInventory: [
        metaStructureInventoryEntity({ id: "camp_a", level: "campaign" }),
        metaStructureInventoryEntity({ id: "camp_b", level: "campaign" }),
        metaStructureInventoryEntity({ id: "adset_a", level: "adset" }),
        metaStructureInventoryEntity({ id: "adset_b", level: "adset" }),
      ],
    });

    const mobile = mobileHtml(
      renderToStaticMarkup(
        <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
      ),
    );
    /*
     * The scope chip counts the SCOPE, and this assertion used to read
     * "Campaigns & Ad sets 3" — the lane total for Action Now, printed under a
     * label that names campaigns and ad sets. On Grandmix
     * (act_805150454596350) that made a scope holding 1,230 served entities
     * announce 3, which is how 1,211 of them ended up discoverable only
     * through a lane called Archive. The chip reports the served census now;
     * the lane chips beside it are unchanged, because lane membership is the
     * server's and none of it moved.
     */
    expect(mobile).toContain("Campaigns &amp; Ad sets 4");
    expect(mobile).toContain("Action 3");
    expect(mobile).toContain("Watching 1089");
    expect(mobile).not.toContain("Non-sales 30");
    expect(mobile).not.toContain("Healthy 0");
    expect(mobile).not.toContain("Archive 0");
    expect(mobile).not.toContain("data-mobile-structure-inventory");
    expect(mobile).not.toContain("Account inventory");
    expect(mobile).not.toContain("data-mobile-structure-inventory-row");
  });
});

describe("workspace posture banners", () => {
  beforeEach(() => {
    state.workspaceDigest = quietWorkspaceDigest();
  });

  it.each([
    ["/platforms/meta", "/commercial-truth"],
    ["/app/meta/decisions", "/app/manage/business"],
    ["/c/biz_1/meta/decisions", "/c/biz_1/manage/business"],
  ])(
    "renders the served target-authority action in the %s route family",
    (pathname, expectedHref) => {
      state.pathname = pathname;
      state.workspaceBanners = [
        {
          id: "commercial_target_authority_missing",
          tone: "warning",
          title: "Commercial targets are not configured.",
          detail:
            "Set at least one valid economic anchor before hard Scale/Cut authority can be evaluated.",
          blocking: false,
          scope: "target_hard_actions",
          action: {
            label: "Set commercial truth",
            href: "/commercial-truth",
          },
        },
      ];

      const html = renderToStaticMarkup(
        <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
      );

      expect(html).toContain(
        'data-banner-id="commercial_target_authority_missing"',
      );
      expect(html).toContain(
        'data-mobile-banner="commercial_target_authority_missing"',
      );
      expect(html).toContain("A ROAS target is required.");
      expect(html).toContain(
        "Set the target used to evaluate Scale and Cut recommendations.",
      );
      expect(countText(html, `href="${expectedHref}"`)).toBe(2);
      expect(countText(html, ">Set target</a>")).toBe(2);
    },
  );

  it("renders only the highest-priority posture in buyer language", () => {
    state.pathname = "/platforms/meta";
    state.workspaceBanners = [
      {
        id: "tracking_write_gate",
        tone: "warning",
        title: "Tracking degraded — purchase signal may be incomplete.",
        detail: "Purchase signal is incomplete.",
        blocking: true,
      },
      {
        id: "meta_write_kill_switch",
        tone: "danger",
        title: "Kill switch engaged.",
        detail:
          "All active Meta write endpoints are blocked by META_ADS_WRITE_KILL_SWITCH.",
        blocking: true,
      },
    ];

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-posture-banners"');
    expect(html).toContain('data-banner-id="meta_write_kill_switch"');
    expect(html).not.toContain('data-banner-id="tracking_write_gate"');
    expect(html).toContain("Meta changes are paused.");
    expect(html).not.toContain("Kill switch engaged.");
    expect(html).not.toContain("META_ADS_WRITE_KILL_SWITCH");
    expect(html).toContain('href="/platforms/meta/automation"');
    expect(html).toContain("Open Automation");
  });

  it("shows one blocking status without collapsed technical notes", () => {
    state.workspaceBanners = [
      {
        id: "informational_note",
        tone: "info",
        title: "Informational note.",
        detail: "This note does not block decisions.",
        blocking: false,
      },
      {
        id: "pipeline_blocker",
        tone: "warning",
        title: "Pipeline is not ready.",
        detail: "Decision generation must recover.",
        blocking: true,
      },
      {
        id: "danger_without_blocking_flag",
        tone: "danger",
        title: "Critical provider failure.",
        detail: "Provider state cannot be verified.",
        blocking: false,
      },
    ];

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    expect(html).toContain('data-banner-id="pipeline_blocker"');
    expect(html).toContain("Actions are temporarily unavailable.");
    expect(html).not.toContain("Pipeline is not ready.");
    expect(html).not.toContain("Critical provider failure.");
    expect(html).not.toContain("Informational note.");
    expect(html).not.toContain("meta-posture-banners__details");
  });

  it("downgrades write controls to evidence review when the server marks the viewer read-only", () => {
    state.workspaceViewer = {
      role: "collaborator",
      isReviewer: true,
      readOnly: true,
      readOnlyReason:
        "You have read-only access: all evidence is visible, write controls are downgraded to review.",
    };
    state.workspaceBanners = [
      {
        id: "reviewer_read_only",
        tone: "info",
        title: "Reviewer access is read-only.",
        detail:
          "You have read-only access: all evidence is visible, write controls are downgraded to review.",
        blocking: false,
      },
    ];
    state.lanePayload = metaLanePayload({
      actionNow: [
        metaRec({
          id: "pause-rec",
          actionKind: "execute_pause",
          type: "adset_cut_spend",
          adsetId: "as_1",
          operatorResponseState: "deferred",
        }),
      ],
      watching: [],
      healthy: [],
      nonSales: [],
      archive: [],
      counts: {
        actionNow: 1,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(<MetaPlatformPage businessId="biz_1" />);

    expect(html).toContain('data-banner-id="reviewer_read_only"');
    expect(html).toContain("Read-only access.");
    expect(html).toContain(
      "You can review recommendations, but you cannot apply changes.",
    );
    expect(html).not.toContain("Reviewer access is read-only.");
    expect(html).toContain('data-screen-label="Meta Decision Center"');
    const row = exactArticleHtml(
      html,
      'data-meta-exact-action-row="pause-rec"',
    );
    expect(row).toMatch(
      /<button[^>]*disabled=""[^>]*>Review recommendation<\/button>/,
    );
    expect(html).not.toContain(">Refresh decisions</button>");
    expect(html).not.toContain("+ New campaign");
    expect(html).not.toContain('data-action-authority="execute"');
    expect(html).not.toContain('data-action="undefer"');
    expect(html).not.toContain(">Pause weakest<");
    expect(html).not.toContain(">Resume<");
  });
});

describe("tracking confirm label follows the server actionKind", () => {
  it("does not tracking-gate a review-only apply-bid suggestion", () => {
    const bidRec = metaRec({
      type: "bid_value_guidance",
      level: "adset",
      proposedAction: { kind: "apply_bid", bidAmountMinor: 500 },
    });
    expect(bidRec.actionKind).toBe("review_drill");
    expect(trackingConfirmLabelForRec(bidRec)).toBe("Continue anyway");
    expect(trackingConfirmLabelForRec(bidRec)).not.toBe("Rebuild anyway");
  });

  it("maps every gated action to copy naming what confirming does", () => {
    expect(
      trackingConfirmLabelForRec(metaRec({ type: "adset_cut_spend" })),
    ).toBe("Continue anyway");
    expect(
      trackingConfirmLabelForRec(metaRec({ type: "rebuild_with_constraints" })),
    ).toBe("Rebuild anyway");
    expect(trackingConfirmLabelForRec(null)).toBe("Continue anyway");
  });
});

describe("served structure inventory stays out of the buyer surface", () => {
  it("keeps decision rows visible without mounting the technical census", () => {
    state.lanePayload = metaLanePayload({
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 0,
        archive: 0,
      },
      structureInventory: [
        metaStructureInventoryEntity({
          id: "camp_a",
          level: "campaign",
          name: "Census Campaign",
        }),
        metaStructureInventoryEntity({
          id: "adset_a",
          level: "adset",
          name: "Census Ad set",
        }),
      ],
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-meta-exact-action-row="rec_1"');
    expect(html).not.toContain("data-meta-structure-inventory");
    expect(html).not.toContain("data-mobile-structure-inventory");
    expect(html).not.toContain("Account inventory");
    expect(html).not.toContain("Census Campaign");
    expect(html).not.toContain("Census Ad set");
  });
});
