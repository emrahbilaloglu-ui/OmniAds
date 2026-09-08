import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_META_PROVIDER_ACCOUNT_ID } from "@/lib/demo-business-support";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/recommendations/route";
import { assertMetaRecommendationsPageContract } from "@/lib/meta/page-route-contract.test-helpers";

/*
 * The tri-state posture read, at its one database read.
 *
 * The route no longer asks `isDemoBusiness`, which manufactured "live" from a
 * database it could not read. It asks `readMetaBusinessDataPosture`, which
 * reads `businesses.is_demo_business` through this module and answers
 * `unverified` when it cannot — and `getDb()` throws under vitest, so without
 * this the route would correctly refuse every case in this file.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(async () => "live"),
}));
vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/request-language", () => ({
  resolveRequestLanguage: vi.fn(),
}));

vi.mock("@/lib/meta/breakdowns-source", () => ({
  getMetaBreakdownsForRange: vi.fn(async () => ({
    status: "ok",
    age: [],
    location: [],
    placement: [],
    budget: { campaign: [], adset: [] },
    audience: { available: false, reason: "n/a" },
    products: { available: false, reason: "n/a" },
    isPartial: false,
    notReadyReason: null,
  })),
}));

vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(async () => ({
    status: "ok",
    rows: [],
    isPartial: false,
    notReadyReason: null,
  })),
}));

vi.mock("@/lib/meta/empirical-outcome-integration", () => ({
  attachMetaEmpiricalOutcomeSummariesFromLogs: vi.fn(
    async (input: { recommendations: unknown[] }) => input.recommendations,
  ),
}));
vi.mock("@/lib/meta/snapshot", () => ({
  readMetaDecisionSnapshotForRange: vi.fn(),
}));

vi.mock("@/lib/meta/commercial-targets", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/commercial-targets")>();
  return { ...actual, readMetaCommercialTargets: vi.fn() };
});
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));
vi.mock("@/lib/creative-decision-engine/meta-aov-calculator", () => ({
  computeMetaAttributedAov: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/lib/meta/config-snapshots", () => ({
  readMetaBidRegimeHistorySummaries: vi.fn(),
}));

vi.mock("@/lib/meta/recommendations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/recommendations")>();
  return {
    ...actual,
    buildMetaRecommendations: vi.fn(() => ({
      status: "ok",
      summary: {
        title: "Summary",
        summary: "Summary",
        primaryLens: "volume",
        confidence: "medium",
        recommendationCount: 1,
      },
      recommendations: [
        {
          id: "rec_1",
          level: "campaign",
          campaignId: "cmp_1",
          type: "budget_allocation",
          lens: "volume",
          priority: "high",
          confidence: "medium",
          decisionState: "act",
          decision: "increase budget",
          title: "Raise budget",
          recommendedAction: "Increase the budget on the best campaign.",
          why: "The selected campaign is outperforming peers.",
          summary: "Strong profitability signal.",
          expectedImpact: "More profitable volume.",
          evidence: [{ label: "ROAS", value: "3.20x", tone: "positive" }],
          timeframeContext: {
            coreVerdict: "Strong selected range",
            selectedRangeOverlay: "Selected range is healthy",
            historicalSupport: "History supports the move",
            seasonalityFlag: "none",
            note: null,
          },
          evidenceTrail: {
            roas_history: [2.8, 3.2],
            peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
            regime_stability: 1,
            age_days: 28,
            recent_changes: [],
          },
          campaignRole: "prospecting_scale",
          bidRegime: "lowest_cost",
        },
      ],
    })),
  };
});

const demoAuthority = await import("@/app/api/launchpad/meta/demo-write-authority");
const access = await import("@/lib/access");
const businessMode = await import("@/lib/business-mode.server");
const campaignsSource = await import("@/lib/meta/campaigns-source");
const breakdownsSource = await import("@/lib/meta/breakdowns-source");
const metaRecommendations = await import("@/lib/meta/recommendations");
const snapshot = await import("@/lib/meta/snapshot");
const requestLanguage = await import("@/lib/request-language");
const configSnapshots = await import("@/lib/meta/config-snapshots");
const recommendations = await import("@/lib/meta/recommendations");
const commercialTargetsModule = await import("@/lib/meta/commercial-targets");
const assignmentsModule = await import("@/lib/provider-account-assignments");
const aovModule = await import(
  "@/lib/creative-decision-engine/meta-aov-calculator"
);
const empiricalModule = await import("@/lib/meta/empirical-outcome-integration");

describe("GET /api/meta/recommendations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");
    vi.mocked(requestLanguage.resolveRequestLanguage).mockResolvedValue("en");
    vi.mocked(configSnapshots.readMetaBidRegimeHistorySummaries).mockResolvedValue(new Map());
    // The commercial half of the canonical unit, and the account scope it is
    // read for. Defaults are a ROAS-governed account with one Meta account and
    // a ready sample; individual cases narrow them.
    vi.mocked(commercialTargetsModule.readMetaCommercialTargets).mockResolvedValue({
      source: "configured_targets",
      targetRoas: 2.2,
      breakEvenRoas: 1.5,
      targetCpa: 120,
      breakEvenCpa: 160,
      aovAssumption: null,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: "2026-03-30T00:00:00.000Z",
      metaAttributedAov: null,
    } as never);
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1"],
    } as never);
    vi.mocked(aovModule.computeMetaAttributedAov).mockResolvedValue({
      aovMean: 180,
      purchaseCount: 60,
    } as never);
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      summary: {
        title: "Snapshot summary",
        summary: "Snapshot summary",
        primaryLens: "volume",
        confidence: "medium",
        recommendationCount: 1,
      },
      recommendations: [
        {
          id: "snapshot_rec_1",
          level: "campaign",
          campaignId: "cmp_1",
          type: "budget_allocation",
          lens: "volume",
          priority: "high",
          confidence: "medium",
          confidenceScore: 0.63,
          decisionState: "act",
          decision: "increase budget",
          title: "Persisted budget move",
          recommendedAction: "Increase the budget on the best campaign.",
          why: "The selected campaign is outperforming peers.",
          summary: "Strong profitability signal.",
          expectedImpact: "More profitable volume.",
          evidence: [{ label: "ROAS", value: "3.20x", tone: "positive" }],
          timeframeContext: {
            coreVerdict: "Strong selected range",
            selectedRangeOverlay: "Selected range is healthy",
            historicalSupport: "History supports the move",
            seasonalityFlag: "none",
            note: null,
          },
          evidenceTrail: {
            roas_history: [2.8, 3.2],
            peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
            regime_stability: 1,
            age_days: 28,
            recent_changes: [],
          },
          campaignRole: "prospecting_scale",
          bidRegime: "lowest_cost",
        },
      ],
      sourceModel: "snapshot_persistent",
      analysisSource: {
        system: "snapshot_persistent",
        decisionOsAvailable: false,
        fallbackReason: "meta_engine_v1_snapshot",
      },
    });
  });

  it("withholds recommendations when the workspace posture cannot be read", async () => {
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(
      "unverified",
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-04-01&endDate=2026-04-03",
      ),
    );

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("workspace_posture_unverified");
    // Nothing was read on the way to the refusal — not the snapshot, not the
    // campaign windows, not the breakdowns.
    expect(snapshot.readMetaDecisionSnapshotForRange).not.toHaveBeenCalled();
    expect(campaignsSource.getMetaCampaignsForRange).not.toHaveBeenCalled();
  });

  it("reads persisted snapshot recommendations by default", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("ok");
    assertMetaRecommendationsPageContract(payload);
    expect(payload.analysisSource).toEqual({
      system: "snapshot_persistent",
      decisionOsAvailable: false,
      fallbackReason: "meta_engine_v1_snapshot",
    });
    expect(payload.sourceModel).toBe("snapshot_persistent");
    expect(payload.businessId).toBe("biz");
    expect(payload.startDate).toBe("2026-03-01");
    expect(payload.endDate).toBe("2026-03-31");
    expect(payload.recommendations[0].evidenceTrail).toEqual({
      roas_history: [2.8, 3.2],
      peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
      regime_stability: 1,
      age_days: 28,
      recent_changes: [],
    });
    expect(payload.recommendations[0].campaignRole).toBe("prospecting_scale");
    expect(payload.recommendations[0].bidRegime).toBe("lowest_cost");
    expect(snapshot.readMetaDecisionSnapshotForRange).toHaveBeenCalledWith({
      businessId: "biz",
      // ROUND 6 AUDIT: the persisted read is account-scoped too. The scope
      // block used to sit AFTER this branch's return, so `?live=1` absent meant
      // the reader ran unscoped and served every account's rows.
      providerAccountId: "act_1",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    expect(campaignsSource.getMetaCampaignsForRange).not.toHaveBeenCalled();
    expect(breakdownsSource.getMetaBreakdownsForRange).not.toHaveBeenCalled();
    expect(metaRecommendations.buildMetaRecommendations).not.toHaveBeenCalled();
  });

  it("keeps the intentional live debug path", async () => {
    await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31&live=1",
      ),
    );

    expect(snapshot.readMetaDecisionSnapshotForRange).not.toHaveBeenCalled();
    expect(campaignsSource.getMetaCampaignsForRange).toHaveBeenCalled();
    expect(breakdownsSource.getMetaBreakdownsForRange).toHaveBeenCalled();
    expect(metaRecommendations.buildMetaRecommendations).toHaveBeenCalled();
    expect(configSnapshots.readMetaBidRegimeHistorySummaries).toHaveBeenCalledTimes(1);
    expect(configSnapshots.readMetaBidRegimeHistorySummaries).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        entityLevel: "campaign",
      }),
    );
  });

  it("marks live debug responses as snapshot_live and uses the v1 live debug reason", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31&live=1",
      ),
    );
    const payload = await response.json();

    expect(payload.sourceModel).toBe("snapshot_live");
    expect(payload.analysisSource).toEqual({
      system: "snapshot_live",
      decisionOsAvailable: false,
      fallbackReason: "meta_engine_v1_live_debug",
    });
  });

  it("rejects missing required params before building recommendations", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/meta/recommendations?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("missing_params");
    expect(metaRecommendations.buildMetaRecommendations).not.toHaveBeenCalled();
    expect(snapshot.readMetaDecisionSnapshotForRange).not.toHaveBeenCalled();
  });
});

/*
  CODEX repair 1 — the LIVE route binds the other half of the canonical unit.

  `readMetaCommercialTargets` returns the ratios only. This route handed them
  straight to `buildMetaRecommendations`, so `metaCanonicalSpendUnit` was always
  null on the live path: every ROAS-governed account was judged by something
  other than its own rule — a CPA before this repair, and nothing at all after
  it. The sample must be read here, scoped to the SELECTED account and to the
  same cutoff the recommendation windows close on.
*/
describe("the live route supplies an account- and cutoff-scoped Meta AOV", () => {
  /*
    Its OWN setup: this describe is a sibling of the suite above, so that
    suite's `beforeEach` never runs here. Without this the mocks kept their
    values from the last case of the previous describe and call counts
    accumulated across these cases — a "not called" assertion would have been
    reading someone else's calls.
  */
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue("live");
    vi.mocked(requestLanguage.resolveRequestLanguage).mockResolvedValue("en");
    vi.mocked(configSnapshots.readMetaBidRegimeHistorySummaries).mockResolvedValue(
      new Map(),
    );
    vi.mocked(commercialTargetsModule.readMetaCommercialTargets).mockResolvedValue({
      source: "configured_targets",
      targetRoas: 2.2,
      breakEvenRoas: 1.5,
      targetCpa: 120,
      breakEvenCpa: 160,
      aovAssumption: null,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: "2026-03-30T00:00:00.000Z",
      metaAttributedAov: null,
    } as never);
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1"],
    } as never);
    vi.mocked(aovModule.computeMetaAttributedAov).mockResolvedValue({
      aovMean: 180,
      purchaseCount: 60,
    } as never);
    vi.mocked(empiricalModule.attachMetaEmpiricalOutcomeSummariesFromLogs)
      .mockImplementation(
        async (input: { recommendations: unknown[] }) => input.recommendations as never,
      );
    vi.mocked(snapshot.readMetaDecisionSnapshotForRange).mockResolvedValue({
      status: "ok",
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      summary: {
        title: "Persisted",
        summary: "Persisted",
        primaryLens: "structure",
        confidence: "low",
        recommendationCount: 0,
      },
      recommendations: [],
      sourceModel: "snapshot_persistent",
      analysisSource: {
        system: "snapshot_persistent",
        decisionOsAvailable: false,
        fallbackReason: "meta_engine_v1_snapshot",
      },
    } as never);
  });

  const call = () =>
    GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31&live=1",
      ),
    );

  const targetsArg = () =>
    (vi.mocked(metaRecommendations.buildMetaRecommendations).mock.calls.at(-1)?.[0] ??
      {}) as { commercialTargets?: { metaAttributedAov?: unknown } };

  it("reads the sample for the selected account at the window's end date", async () => {
    await call();
    expect(aovModule.computeMetaAttributedAov).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        providerAccountId: "act_1",
        asOf: "2026-03-31",
      }),
    );
    expect(targetsArg().commercialTargets?.metaAttributedAov).toEqual({
      aovMean: 180,
      purchaseCount: 60,
    });
  });

  it("passes a null sample when the calculator has nothing", async () => {
    vi.mocked(aovModule.computeMetaAttributedAov).mockResolvedValue(null as never);
    await call();
    expect(targetsArg().commercialTargets?.metaAttributedAov).toBeNull();
  });

  it("reads the targets AS OF the same cutoff, not at wall clock", async () => {
    /*
      The ratios and the AOV must describe the same instant. This route read
      `readMetaCommercialTargets(businessId)` with no `asOf`, so a pack saved
      after the window closed divided a purchase value the decision could not
      have seen, and the freshness stamp described "now" rather than the moment
      being decided.
    */
    await call();
    expect(commercialTargetsModule.readMetaCommercialTargets)
      .toHaveBeenCalledWith("biz", { asOf: "2026-03-31" });
  });

  /*
    ── ROUND 8 ITEM 8: A FAILED READ IS NOT A CONFIGURATION FACT ──────────────
  */
  it("returns 503 when the assignments read REJECTS, not a 400 about no account", async () => {
    /*
      `getProviderAccountAssignments(...).catch(() => null)` collapsed a
      rejected query into an empty id list, and the route then answered 400
      `meta_account_scope_required` — "No Meta ad account is selected for this
      business". Two different lies in one response: it told the caller their
      REQUEST was wrong when nothing about it was, and it told the operator a
      settled fact about their configuration that the process had not actually
      read. The operator's remedy would have been to go to a settings page and
      re-select an account that was already selected.
    */
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockRejectedValue(
      new Error("provider_account_assignments read failed"),
    );

    const response = await call();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "meta_account_scope_unavailable",
    });
    // And nothing downstream ran on a scope nobody could establish.
    expect(campaignsSource.getMetaCampaignsForRange).not.toHaveBeenCalled();
    expect(aovModule.computeMetaAttributedAov).not.toHaveBeenCalled();
    expect(metaRecommendations.buildMetaRecommendations).not.toHaveBeenCalled();
  });

  it("still answers 400 when the read SUCCEEDS and finds no assigned account", async () => {
    /*
      The discriminating other half. "The query failed" and "there is genuinely
      no account selected" must not share a status code — the first is ours to
      fix and retryable, the second is the operator's and actionable.
    */
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: [],
    } as never);

    const response = await call();

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "meta_account_scope_required",
      assignedAccountCount: 0,
    });
  });

  it("serves a demo business without ever reading production account assignments", async () => {
    /*
      The demo branch sat BELOW the assignment validation, so a demo workspace
      had to pass a PRODUCTION check before it could be served demo fixtures:
      with no real account assigned it was refused with
      `meta_account_scope_required`, and with one assigned the demo answer was
      scoped by a real provider account it has no relationship to.

      Demo now resolves its own scope from a constant manifest and returns
      first. The assignments table is not queried at all, which is the
      assertion that makes "no production leak" checkable rather than asserted.
    */
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(
      "demo" as never,
    );
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: [],
    } as never);

    const response = await call();

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.analysisSource).toMatchObject({ system: "demo" });
    // THE POINT: no production account read happened, so none could leak.
    expect(
      assignmentsModule.getProviderAccountAssignments,
    ).not.toHaveBeenCalled();
    // Nor did any live provider window.
    expect(campaignsSource.getMetaCampaignsForRange).not.toHaveBeenCalled();
    expect(aovModule.computeMetaAttributedAov).not.toHaveBeenCalled();
  });

  it("accepts a demo request naming the CANONICAL demo account", async () => {
    /*
      ── ROUND 9 ITEM 9 ──────────────────────────────────────────────────────
      The route used to invent `demo:meta-account`, so the one id the demo
      workspace actually publishes — `act_210009998877`, the account
      `getDemoIntegrations()` reports as connected and the demo UI displays —
      was refused by the route meant to serve it.
    */
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(
      "demo" as never,
    );

    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31&providerAccountId=${DEMO_META_PROVIDER_ACCOUNT_ID}`,
      ),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).analysisSource).toMatchObject({
      system: "demo",
    });
    // Still no production read, even for the accepted id.
    expect(
      assignmentsModule.getProviderAccountAssignments,
    ).not.toHaveBeenCalled();
  });

  it("refuses a demo request that names a real provider account", async () => {
    /*
      Answering demo rows under an `act_…` the caller supplied would be the
      surface asserting a scope it does not have. The refusal is explicit
      rather than a silent ignore.
    */
    vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(
      "demo" as never,
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31&providerAccountId=act_1",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "meta_account_not_assigned",
    });
    expect(
      assignmentsModule.getProviderAccountAssignments,
    ).not.toHaveBeenCalled();
  });

  it("refuses, rather than inventing a scope, when several accounts are assigned", async () => {
    /*
      Two accounts and no selection is not a licence to pick one, and it is not
      a licence to pool them either: sizing this account's money from another's
      sample is the borrowing the account-scoped reads exist to prevent. The
      route fails closed instead of answering about a scope nobody named.
    */
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);
    const response = await call();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "meta_account_scope_required",
      assignedAccountCount: 2,
    });
    expect(campaignsSource.getMetaCampaignsForRange).not.toHaveBeenCalled();
    expect(breakdownsSource.getMetaBreakdownsForRange).not.toHaveBeenCalled();
    expect(aovModule.computeMetaAttributedAov).not.toHaveBeenCalled();
    expect(metaRecommendations.buildMetaRecommendations).not.toHaveBeenCalled();
  });

  it("scopes EVERY window, the targets and the sample to the requested second account", async () => {
    /*
      THE CASE THAT PROVES THE SCOPE IS REAL. Two accounts are assigned and the
      SECOND is asked for, so a route that defaulted to the first, ignored the
      parameter, or loaded any window business-wide fails here rather than
      silently answering about the wrong money.
    */
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31&live=1&providerAccountId=act_2",
      ),
    );
    expect(response.status).toBe(200);

    // Eight campaign windows: selected, previous, 3/7/14/30/90-day and all
    // history. Every one of them carries the requested account.
    const windowCalls = vi.mocked(campaignsSource.getMetaCampaignsForRange).mock.calls;
    expect(windowCalls.length).toBe(8);
    for (const [args] of windowCalls) {
      expect(args).toMatchObject({ businessId: "biz", accountId: "act_2" });
    }
    expect(breakdownsSource.getMetaBreakdownsForRange).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_2" }),
    );
    expect(aovModule.computeMetaAttributedAov).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_2", asOf: "2026-03-31" }),
    );
    expect(commercialTargetsModule.readMetaCommercialTargets)
      .toHaveBeenCalledWith("biz", { asOf: "2026-03-31" });
    // And nothing was read for the account that was not asked for.
    expect(aovModule.computeMetaAttributedAov).not.toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_1" }),
    );
  });

  it.each([
    ["act_123", "123", "act_123"],
    ["123", "act_123", "123"],
  ])(
    "matches assigned Meta account %s to request %s and keeps catalog spelling %s",
    async (assignedAccountId, requestedAccountId, expectedAccountId) => {
      vi.mocked(
        assignmentsModule.getProviderAccountAssignments,
      ).mockResolvedValue({ account_ids: [assignedAccountId] } as never);

      const response = await persisted(
        `&live=1&providerAccountId=${requestedAccountId}`,
      );

      expect(response.status).toBe(200);
      const campaignCalls = vi.mocked(
        campaignsSource.getMetaCampaignsForRange,
      ).mock.calls;
      expect(campaignCalls).toHaveLength(8);
      for (const [args] of campaignCalls) {
        expect(args).toMatchObject({ accountId: expectedAccountId });
      }
      expect(breakdownsSource.getMetaBreakdownsForRange).toHaveBeenCalledWith(
        expect.objectContaining({ providerAccountId: expectedAccountId }),
      );
      expect(aovModule.computeMetaAttributedAov).toHaveBeenCalledWith(
        expect.objectContaining({ providerAccountId: expectedAccountId }),
      );
      expect(
        empiricalModule.attachMetaEmpiricalOutcomeSummariesFromLogs,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ providerAccountId: expectedAccountId }),
      );
    },
  );

  it("still rejects an unassigned account after equivalent-spelling matching", async () => {
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_123"],
    } as never);

    const response = await persisted("&live=1&providerAccountId=124");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "meta_account_not_assigned",
    });
    expect(campaignsSource.getMetaCampaignsForRange).not.toHaveBeenCalled();
    expect(breakdownsSource.getMetaBreakdownsForRange).not.toHaveBeenCalled();
  });

  it("refuses an account this business has not selected", async () => {
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31&live=1&providerAccountId=act_someone_else",
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "meta_account_not_assigned",
    });
    expect(campaignsSource.getMetaCampaignsForRange).not.toHaveBeenCalled();
  });

  it("refuses when the business has no selected Meta account at all", async () => {
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: [],
    } as never);
    const response = await call();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "meta_account_scope_required",
      assignedAccountCount: 0,
    });
  });

  it("keeps the unambiguous single-account legacy caller working", async () => {
    // One assigned account and no parameter: safely scoped, so it proceeds.
    const response = await call();
    expect(response.status).toBe(200);
    for (const [args] of vi.mocked(campaignsSource.getMetaCampaignsForRange).mock.calls) {
      expect(args).toMatchObject({ accountId: "act_1" });
    }
  });

  /*
    ── ROUND 6 AUDIT ITEM 1: THE SCOPE IS RESOLVED BEFORE THE MODE BRANCH ────
    The validation block sat after the demo and persisted returns, so the
    persisted mode — the DEFAULT, reached whenever `?live=1` is absent — was
    never scoped and never refused. Two assignments and no choice served
    whichever rows the reader found; an unassigned account was accepted; and
    the reader itself was called with no `providerAccountId`, so the commercial
    guard inside it had no account-scoped Meta sample to hold against.

    Every case below is run in BOTH modes, and each asserts on the helper that
    actually receives the scope rather than only on the status code.
  */
  const persisted = (query = "") =>
    GET(
      new NextRequest(
        `http://localhost/api/meta/recommendations?businessId=biz&startDate=2026-03-01&endDate=2026-03-31${query}`,
      ),
    );

  it("scopes the PERSISTED read to the requested second account", async () => {
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);
    const response = await persisted("&providerAccountId=act_2");
    expect(response.status).toBe(200);
    expect(snapshot.readMetaDecisionSnapshotForRange).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz", providerAccountId: "act_2" }),
    );
    expect(snapshot.readMetaDecisionSnapshotForRange).not.toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_1" }),
    );
  });

  it.each([
    ["persisted", ""],
    ["live", "&live=1"],
  ])("refuses an unassigned explicit account in %s mode", async (_mode, suffix) => {
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);
    const response = await persisted(`${suffix}&providerAccountId=act_elsewhere`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "meta_account_not_assigned",
    });
    // Nothing was read on the way to the refusal, in either mode.
    expect(snapshot.readMetaDecisionSnapshotForRange).not.toHaveBeenCalled();
    expect(campaignsSource.getMetaCampaignsForRange).not.toHaveBeenCalled();
    expect(aovModule.computeMetaAttributedAov).not.toHaveBeenCalled();
  });

  it.each([
    ["persisted", ""],
    ["live", "&live=1"],
  ])("refuses an ambiguous omission in %s mode", async (_mode, suffix) => {
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);
    const response = await persisted(suffix);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "meta_account_scope_required",
      assignedAccountCount: 2,
    });
    expect(snapshot.readMetaDecisionSnapshotForRange).not.toHaveBeenCalled();
    expect(campaignsSource.getMetaCampaignsForRange).not.toHaveBeenCalled();
  });

  it.each([
    ["persisted", ""],
    ["live", "&live=1"],
  ])("refuses when no account is assigned at all in %s mode", async (_mode, suffix) => {
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: [],
    } as never);
    const response = await persisted(suffix);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "meta_account_scope_required",
      assignedAccountCount: 0,
    });
  });

  it("passes the selected account to the empirical outcome read on the live path", async () => {
    /*
      The last unscoped read on the live path. Outcome evidence pooled across
      accounts reintroduces, in the evidence, exactly what the account-scoped
      window reads remove.
    */
    vi.mocked(assignmentsModule.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);
    await persisted("&live=1&providerAccountId=act_2");
    expect(empiricalModule.attachMetaEmpiricalOutcomeSummariesFromLogs)
      .toHaveBeenCalledWith(
        expect.objectContaining({ businessId: "biz", providerAccountId: "act_2" }),
      );
  });

  it("does not pay for the read when no Target ROAS governs", async () => {
    vi.mocked(commercialTargetsModule.readMetaCommercialTargets).mockResolvedValue({
      source: "configured_targets",
      targetRoas: null,
      breakEvenRoas: null,
      targetCpa: 120,
      breakEvenCpa: 160,
      aovAssumption: null,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: "2026-03-30T00:00:00.000Z",
      metaAttributedAov: null,
    } as never);
    await call();
    // The legacy CPA compatibility case: no ratio to divide, so no sample is
    // needed and none is read.
    expect(aovModule.computeMetaAttributedAov).not.toHaveBeenCalled();
  });
});
