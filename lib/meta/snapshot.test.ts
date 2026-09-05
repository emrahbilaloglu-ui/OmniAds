import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import {
  readLatestMetaDecisionSnapshot,
  readMetaDecisionSnapshotForRange,
  runMetaSnapshotForAllBusinesses,
  runMetaSnapshotForBusiness,
} from "@/lib/meta/snapshot";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/sync/active-businesses", () => ({
  getActiveBusinesses: vi.fn(),
}));

vi.mock("@/lib/meta/calibration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/calibration")>();
  return {
    ...actual,
    runMetaCalibrationForBusiness: vi.fn(),
    getMetaCalibrationScope: vi.fn(),
  };
});

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(async () => ({ account_ids: ["act_1"] })),
}));
vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/adsets-source", () => ({
  getMetaAdSetsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/breakdowns-source", () => ({
  getMetaBreakdownsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/config-snapshots", () => ({
  readMetaBidRegimeHistorySummaries: vi.fn(),
}));

vi.mock("@/lib/creative-decision-engine/campaign-context/source", () => ({
  resolveCampaignContextMode: vi.fn(() => "automatic"),
  readCampaignContextLabelMap: vi.fn(async () => new Map()),
}));

vi.mock("@/lib/meta/decision-stability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/decision-stability")>();
  return {
    ...actual,
    readPreviousMetaDecisionStates: vi.fn(async () => new Map()),
  };
});

vi.mock("@/lib/meta/anomalies", () => ({
  // The projection of the delivery_stall detector the bid policy reads. Real,
  // not stubbed: it is a pure filter over whatever the detector returned, and
  // stubbing it would hide the very wiring these suites now exercise.
  deliveryConstrainedAdsetIdsFrom: (anomalies: Array<{ type?: string; scopeType?: string; severity?: string; scopeId?: string }>) =>
    new Set(
      (anomalies ?? [])
        .filter((a) => a?.type === "delivery_stall" && a?.scopeType === "adset"
          && (a?.severity === "high" || a?.severity === "medium"))
        .map((a) => a.scopeId as string),
    ),
  detectAnomaliesForBusiness: vi.fn(),
}));

vi.mock("@/lib/meta/evidence-trail", () => ({
  buildEvidenceTrailsForRecommendations: vi.fn(),
}));

vi.mock("@/lib/meta/entity-signals", () => ({
  readMetaEntityDecisionSignalsDaily: vi.fn(),
}));

vi.mock("@/lib/meta/entity-signals-backfill", () => ({
  runMetaSignalsBackfillForBusiness: vi.fn(),
}));

// The confirmation-queue projection is a collaborator of this pipeline with its
// own tests; mocked here so its statements do not appear in the decision-row
// payloads these tests inspect.
vi.mock("@/lib/meta/automation-proposals", () => ({
  projectMetaAutomationProposals: vi.fn(async () => ({
    projected: 0,
    expired: 0,
    ran: true,
  })),
}));

// Budget proposal projection is another collaborator of the snapshot pipeline.
// Its real SQL/loader/insert path has dedicated production-path tests; keeping
// it mocked here prevents those reads from polluting this suite's captured
// decision-row payloads.
vi.mock("@/lib/meta/budget-proposal-producer", () => ({
  projectMetaBudgetProposals: vi.fn(async () => ({
    ran: true,
    candidates: 0,
    projected: 0,
    refusals: {},
  })),
  insertBudgetProposalRow: vi.fn(async () => null),
}));

// The bid producer is a collaborator on the same chain, mocked for the same
// reason: its own SQL and envelope have dedicated tests, and letting it read
// here would pollute this suite's captured decision rows.
vi.mock("@/lib/meta/bid-proposal-producer", () => ({
  projectMetaBidProposals: vi.fn(async () => ({
    ran: true,
    candidates: 0,
    projected: 0,
    refusals: {},
  })),
  insertBidProposalRow: vi.fn(async () => null),
}));

vi.mock("@/lib/meta/budget-proposal-source-loader", () => ({
  loadBudgetCompositionSourcesForCandidate: vi.fn(async () => null),
}));

vi.mock("@/lib/meta/commercial-targets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/commercial-targets")>();
  return {
    ...actual,
    readMetaCommercialTargets: vi.fn(async () => ({
      source: "configured_targets",
      targetRoas: 2.2,
      breakEvenRoas: 1.5,
      targetCpa: 120,
      breakEvenCpa: 160,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: "2026-05-06T02:00:00.000Z",
    })),
  };
});

/*
 * The empirical-outcome boundary, spied rather than exercised.
 *
 * It is called unconditionally by both snapshot paths — the rec-type early
 * return lives INSIDE it — so a spy here proves which account each caller asks
 * for without the fixture having to produce recommendations first. Recommendations
 * pass through untouched, so nothing else in this file changes behaviour.
 */
vi.mock("@/lib/meta/empirical-outcome-integration", () => ({
  attachMetaEmpiricalOutcomeSummariesFromLogs: vi.fn(
    async (input: { recommendations: unknown[] }) => input.recommendations,
  ),
}));

const db = await import("@/lib/db");
const empirical = await import("@/lib/meta/empirical-outcome-integration");
const decisionStability = await import("@/lib/meta/decision-stability");
const activeBusinesses = await import("@/lib/sync/active-businesses");
const calibration = await import("@/lib/meta/calibration");
const campaignSource = await import("@/lib/meta/campaigns-source");
const adsetsSource = await import("@/lib/meta/adsets-source");
const breakdownsSource = await import("@/lib/meta/breakdowns-source");
const configSnapshots = await import("@/lib/meta/config-snapshots");
const campaignContextSource = await import(
  "@/lib/creative-decision-engine/campaign-context/source"
);
const anomalies = await import("@/lib/meta/anomalies");
const evidenceTrail = await import("@/lib/meta/evidence-trail");
const entitySignals = await import("@/lib/meta/entity-signals");
const entitySignalsBackfill = await import("@/lib/meta/entity-signals-backfill");
const commercialTargets = await import("@/lib/meta/commercial-targets");
const assignments = await import("@/lib/provider-account-assignments");
const automationProposals = await import("@/lib/meta/automation-proposals");

function automaticCampaignContext(
  campaignId: string,
  kind: "main" | "test" | "mixed",
) {
  return new Map([
    [
      campaignId,
      {
        kind,
        testDimension: null,
        contextTrust: "high" as const,
        provenance: {
          mode: "automatic" as const,
          source: "system_inferred" as const,
          campaignId,
          kind,
          testDimension: null,
          contextTrust: "high" as const,
          sourceRecordType: "engine_v3_campaign_context_daily" as const,
          sourceRecordId: "00000000-0000-4000-8000-000000000101",
          sourceAsOfDate: "2026-05-06",
          sourceUpdatedAt: "2026-05-06T02:00:00.000Z",
          sourceHash: "a".repeat(64),
        },
      },
    ],
  ]);
}

function makeSqlMock(tagRows: unknown[] = []) {
  const calls: string[] = [];
  const queryPayloads: unknown[] = [];
  const tag = vi.fn((strings: TemplateStringsArray) => {
    calls.push(strings.join("?"));
    return Promise.resolve(tagRows);
  }) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn((text: string, params?: unknown[]) => {
    calls.push(text);
    queryPayloads.push(params?.[0]);
    return Promise.resolve([]);
  });
  return { tag, calls, queryPayloads };
}

function campaign(overrides: Partial<MetaCampaignRow> = {}) {
  return {
    id: "cmp_1",
    accountId: "act_1",
    name: "Campaign 1",
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    optimizationGoal: "Purchase",
    spend: 1500,
    purchases: 24,
    revenue: 4800,
    roas: 3.2,
    cpa: 62.5,
    ctr: 1.4,
    cpm: 12,
    impressions: 10000,
    clicks: 140,
    isBudgetMixed: false,
    isConfigMixed: false,
    isOptimizationGoalMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
    bidStrategyType: "lowest_cost",
    bidStrategyLabel: "Lowest Cost",
    bidValue: null,
    bidValueFormat: null,
    currency: "USD",
    budgetLevel: "campaign",
    ...overrides,
  } as unknown as MetaCampaignRow;
}


/**
 * The snapshot's persisted rows, out of everything the run happened to query.
 *
 * `queryPayloads` records EVERY parameter the fake connection saw, and the
 * snapshot now also reads guardrails and config history — whose parameters are
 * plain strings, not JSON arrays of rows. Parsing them all and assuming JSON
 * made this helper fail on a business id. It takes what parses as an array of
 * rows and ignores the rest, which is what it was always trying to express.
 */
function persistedRows<T>(payloads: readonly unknown[]): T[] {
  const rows: T[] = [];
  for (const payload of payloads) {
    if (Array.isArray(payload)) {
      rows.push(...(payload as T[]));
      continue;
    }
    if (typeof payload !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (Array.isArray(parsed)) rows.push(...(parsed as T[]));
    } catch {
      // Not a row payload. A business id is not a defect.
    }
  }
  return rows;
}

describe("meta snapshot job", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("CAMPAIGN_CONTEXT_MODE", "legacy_labels");
    vi.clearAllMocks();
    vi.mocked(commercialTargets.readMetaCommercialTargets).mockResolvedValue({
      source: "configured_targets",
      targetRoas: 2.2,
      breakEvenRoas: 1.5,
      targetCpa: 120,
      breakEvenCpa: 160,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: "2026-05-06T02:00:00.000Z",
    });
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(calibration.runMetaCalibrationForBusiness).mockResolvedValue({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
      rowsWritten: 6,
      accountScopes: 1,
      campaignScopes: 1,
      sampleRowsTotal: 6,
      sampleRowsByCohort: {
        purchase: 6,
        mid_funnel: 0,
        lead: 0,
        traffic: 0,
        upper_funnel: 0,
        engagement: 0,
        unknown: 0,
      },
      sampleRowsAfterCohortFilter: 6,
    });
    vi.mocked(calibration.getMetaCalibrationScope).mockResolvedValue({
      thresholds: {
        ...LEGACY_META_CALIBRATION_THRESHOLDS,
        metrics: {
          ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
          roas_28d: {
            p10: 1,
            p25: 1.5,
            p50: 2,
            p75: 2.8,
            p90: 4,
            sampleSize: 12,
          },
        },
        source: "calibrated",
      },
      scope: {
        type: "campaign",
        id: "cmp_1",
        snapshotDate: "2026-05-06",
      },
    });
    vi.mocked(campaignSource.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [campaign()],
      evidenceSource: "live",
    } as never);
    vi.mocked(adsetsSource.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [],
      evidenceSource: "live",
    } as never);
    vi.mocked(breakdownsSource.getMetaBreakdownsForRange).mockResolvedValue({
      status: "ok",
      age: [],
      location: [],
      placement: [],
      budget: { campaign: [], adset: [] },
      audience: { available: false },
      products: { available: false },
    } as never);
    vi.mocked(configSnapshots.readMetaBidRegimeHistorySummaries).mockResolvedValue(new Map());
    vi.mocked(
      campaignContextSource.readCampaignContextLabelMap,
    ).mockResolvedValue(new Map());
    vi.mocked(anomalies.detectAnomaliesForBusiness).mockResolvedValue([]);
    vi.mocked(entitySignals.readMetaEntityDecisionSignalsDaily).mockResolvedValue(new Map());
    vi.mocked(entitySignalsBackfill.runMetaSignalsBackfillForBusiness).mockResolvedValue({
      businessId: "biz_1",
      asOfDate: "2026-05-06",
      rowsWritten: 0,
      campaignSignals: 0,
      adsetSignals: 0,
      signalCounts: {
        frequencyP80: 0,
        ctrDecayPct: 0,
        creativeAgeDaysMax: 0,
        lastSignificantEditAt: 0,
        learningState: 0,
        trackingQualityStatus: 0,
        monthlyPacingStatus: 0,
        placementMix: 0,
      },
    });
    vi.mocked(evidenceTrail.buildEvidenceTrailsForRecommendations).mockImplementation(
      async ({ recommendations }) =>
        Object.fromEntries(
          recommendations.map((recommendation) => [
            recommendation.id,
            {
              roas_history: [2.8, 3.2],
              peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
              regime_stability: 1,
              age_days: 28,
              recent_changes: [],
            },
          ]),
        ),
    );
  });

  it("deletes and rewrites same-day rows on re-run", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");
    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    /*
     * TWO deletes per run, not one, and they are different statements.
     *
     * Generation is per assigned account, so a run first clears this date's
     * UNATTRIBUTED rows once — legacy lineage that no account owns and that a
     * per-account delete can never match — and then replaces each account's own
     * batch. A rerun repeats both, which is what makes it deterministic.
     */
    const deletes = sql.calls.filter((text) =>
      text.includes("DELETE FROM meta_decision_snapshots_daily"),
    );
    expect(deletes).toHaveLength(4);
    expect(
      deletes.filter((text) => text.includes("provider_account_id IS NULL")),
    ).toHaveLength(2);
    expect(
      deletes.filter((text) => text.includes("IS NOT DISTINCT FROM")),
    ).toHaveLength(2);
    expect(sql.calls.filter((text) => text.includes("INSERT INTO meta_decision_snapshots_daily"))).toHaveLength(2);
  });

  /*
   * D-M011: refreshing one account must not erase another.
   *
   * The delete used to take every recommendation row for the business and the
   * date, so under per-account generation account B's refresh would have wiped
   * account A's snapshot a moment after it was written. INVARIANTS states the
   * law for the sibling native path — a per-account run "must not abort or
   * prune unrelated ready" work — and this is that law for this table.
   */
  it("scopes each account's delete to that account", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const scoped = sql.calls.filter(
      (text) =>
        text.includes("DELETE FROM meta_decision_snapshots_daily") &&
        text.includes("provider_account_id IS NOT DISTINCT FROM"),
    );
    // One per assigned account, plus the anomaly epilogue's own batch is
    // written with `replaceRecommendations: false` and issues none.
    expect(scoped).toHaveLength(2);
    // And no statement takes the whole business's recommendations for the day.
    expect(
      sql.calls.filter(
        (text) =>
          text.includes("DELETE FROM meta_decision_snapshots_daily") &&
          text.includes("kind = 'recommendation'") &&
          !text.includes("provider_account_id"),
      ),
    ).toEqual([]);
  });

  it("computes each assigned account separately, and narrows every input", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    /*
     * The point of the change: the ACCOUNT reaches the source BEFORE the
     * numbers are computed. Tagging a row afterwards leaves its spend, ROAS,
     * percentiles and calibration pooled across every assigned account.
     */
    const campaignCalls = vi.mocked(campaignSource.getMetaCampaignsForRange).mock.calls;
    expect(campaignCalls.length).toBeGreaterThan(0);
    expect(campaignCalls.every(([arg]) => "accountId" in (arg as object))).toBe(true);
    expect(
      new Set(campaignCalls.map(([arg]) => (arg as { accountId?: string }).accountId)),
    ).toEqual(new Set(["act_1", "act_2"]));

    const adsetCalls = vi.mocked(adsetsSource.getMetaAdSetsForRange).mock.calls;
    expect(
      new Set(adsetCalls.map(([arg]) => (arg as { accountId?: string }).accountId)),
    ).toEqual(new Set(["act_1", "act_2"]));

    // ...and the two enrichment reads, which were the last inputs still asked
    // business-wide. A learning state or a creative age from the sibling
    // account inside this account's recommendation is the same defect in a
    // quieter place.
    const signalCalls = vi.mocked(
      entitySignals.readMetaEntityDecisionSignalsDaily,
    ).mock.calls;
    expect(
      new Set(
        signalCalls.map(
          ([arg]) => (arg as { providerAccountId?: string | null }).providerAccountId,
        ),
      ),
    ).toEqual(new Set(["act_1", "act_2"]));

    const trailCalls = vi.mocked(
      evidenceTrail.buildEvidenceTrailsForRecommendations,
    ).mock.calls;
    expect(
      new Set(
        trailCalls.map(
          ([arg]) => (arg as { providerAccountId?: string | null }).providerAccountId,
        ),
      ),
    ).toEqual(new Set(["act_1", "act_2"]));

    /*
     * ...and the empirical outcome history, which is the evidence an operator
     * reads as "how this kind of decision has worked out HERE". Asked without
     * an account it is read business-wide, so account A's recommendation would
     * carry account B's track record for the same rec type — a summary that
     * sets a confidence band and an automation-readiness tier.
     */
    const empiricalCalls = vi.mocked(
      empirical.attachMetaEmpiricalOutcomeSummariesFromLogs,
    ).mock.calls;
    expect(
      new Set(
        empiricalCalls.map(
          ([arg]) => (arg as { providerAccountId?: string | null }).providerAccountId,
        ),
      ),
    ).toEqual(new Set(["act_1", "act_2"]));
    // Never business-wide from a per-account run.
    expect(
      empiricalCalls.some(
        ([arg]) => !(arg as { providerAccountId?: string | null }).providerAccountId,
      ),
    ).toBe(false);
  });

  /*
   * The other call site: the SELECTED-account read the Intelligence surface
   * serves. It already withholds rows that are not this account's; serving
   * those rows with outcome evidence pooled across every account would put
   * back, in the evidence, exactly what the row filter removes.
   */
  it("scopes the served snapshot's outcome evidence to the account it read for", async () => {
    // One stored row, so the read gets past "nothing served" and reaches the
    // evidence step this case is about.
    const sql = makeSqlMock([
      {
        scope_type: "campaign",
        scope_id: "cmp_1",
        business_id: "biz_1",
        snapshot_date: "2026-05-06",
        rec_id: "rec_1",
        rec_type: "campaign_budget",
        level: "campaign",
        decision_state: "act",
        confidence_score: 0.8,
        recommended_action: "Scale.",
        reasoning: "Because.",
        engine_version: "v1",
        created_at: "2026-05-06T03:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await readLatestMetaDecisionSnapshot({
      businessId: "biz_1",
      startDate: "2026-05-01",
      endDate: "2026-05-06",
      providerAccountId: "act_1",
    });

    const calls = vi.mocked(
      empirical.attachMetaEmpiricalOutcomeSummariesFromLogs,
    ).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.at(-1)![0]).toMatchObject({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });
  });

  it("refuses an account the workspace no longer has, and computes nothing", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1"],
    } as never);

    const result = await runMetaSnapshotForBusiness("biz_1", "2026-05-06", "act_revoked");

    expect(result.skippedReason).toBe("provider_account_not_assigned");
    expect(result.recommendationsWritten).toBe(0);
    expect(
      sql.calls.filter((text) => text.includes("INSERT INTO meta_decision_snapshots_daily")),
    ).toEqual([]);
  });

  it("re-projects the confirmation queue on every snapshot, after the rows land", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    // This is what "expired proposals re-evaluate on the next snapshot" means
    // mechanically: the projection runs inside the pipeline, for the day whose
    // decisions were just written.
    expect(automationProposals.projectMetaAutomationProposals).toHaveBeenCalledWith(
      { businessId: "biz_1", snapshotDate: "2026-05-06" },
    );
    expect(result.proposals).toEqual({ projected: 0, expired: 0 });
  });

  it("reports an unrun projection as unknown rather than as zero proposals", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(
      automationProposals.projectMetaAutomationProposals,
    ).mockResolvedValueOnce({ projected: 0, expired: 0, ran: false });

    const result = await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    expect(result.proposals).toBeNull();
  });

  it("does not fail the snapshot when the queue projection throws", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(
      automationProposals.projectMetaAutomationProposals,
    ).mockRejectedValueOnce(new Error("projection exploded"));

    const result = await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    // The decisions themselves are already durable; losing the projection must
    // not lose them.
    expect(result.proposals).toBeNull();
    expect(result.snapshotDate).toBe("2026-05-06");
  });

  it("publishes an act-to-watch safety exit immediately in the snapshot path", async () => {
    vi.mocked(decisionStability.readPreviousMetaDecisionStates).mockResolvedValue(new Map());
    const firstRun = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(firstRun.tag);
    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    type PayloadRow = {
      kind: string;
      scope_type: string;
      scope_id: string;
      rec_type: string;
      decision_state: "act" | "test" | "watch";
      state_reason: string | null;
      signal_quality: { stability?: { raw_decision_state: string; suppressed: boolean } };
    };
    const firstRows = persistedRows<PayloadRow>(firstRun.queryPayloads)
      .filter((row) => row?.kind === "recommendation");
    expect(firstRows.length).toBeGreaterThan(0);
    // Every persisted recommendation carries stability memory.
    for (const row of firstRows) {
      expect(row.signal_quality.stability).toEqual({
        raw_decision_state: row.decision_state,
        suppressed: false,
      });
    }

    // Hard-action entry confirmation must never delay a safety exit. Model a
    // previously published act state while today's raw recommendation is watch.
    const target = firstRows.find((row) => row.decision_state === "watch") ?? firstRows[0]!;
    vi.mocked(decisionStability.readPreviousMetaDecisionStates).mockResolvedValue(
      new Map([
        [
          `${target.scope_type}|${target.scope_id}|${target.rec_type}`,
          { publishedState: "act", rawState: "act" },
        ],
      ]),
    );
    const secondRun = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(secondRun.tag);
    await runMetaSnapshotForBusiness("biz_1", "2026-05-07");

    const secondRows = persistedRows<PayloadRow>(secondRun.queryPayloads)
      .filter((row) => row?.kind === "recommendation");
    const held = secondRows.find(
      (row) =>
        row.scope_type === target.scope_type &&
        row.scope_id === target.scope_id &&
        row.rec_type === target.rec_type,
    );
    expect(held).toBeDefined();
    expect(held!.decision_state).toBe(target.decision_state);
    expect(held!.signal_quality.stability).toEqual({
      raw_decision_state: target.decision_state,
      suppressed: false,
    });
    expect(held!.state_reason ?? "").not.toContain("Pending transition");
  });

  it("runs calibration before fetching decision inputs", async () => {
    const order: string[] = [];
    vi.mocked(calibration.runMetaCalibrationForBusiness).mockImplementation(async () => {
      order.push("calibration");
      return {
        businessId: "biz_1",
        snapshotDate: "2026-05-06",
        rowsWritten: 6,
        accountScopes: 1,
        campaignScopes: 1,
        sampleRowsTotal: 6,
        sampleRowsByCohort: {
          purchase: 6,
          mid_funnel: 0,
          lead: 0,
          traffic: 0,
          upper_funnel: 0,
          engagement: 0,
          unknown: 0,
        },
        sampleRowsAfterCohortFilter: 6,
      };
    });
    vi.mocked(campaignSource.getMetaCampaignsForRange).mockImplementation(async () => {
      order.push("campaigns");
      return {
        status: "ok",
        rows: [campaign()],
        evidenceSource: "live",
      } as never;
    });

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    expect(order[0]).toBe("calibration");
    expect(order).toContain("campaigns");
  });

  it("uses allSettled for all business snapshots", async () => {
    vi.mocked(activeBusinesses.getActiveBusinesses).mockResolvedValue([
      { id: "biz_ok", name: "OK" },
      { id: "biz_fail", name: "Fail" },
    ] as never);
    vi.mocked(calibration.runMetaCalibrationForBusiness).mockImplementation(async (businessId: string) => {
      if (businessId === "biz_fail") throw new Error("calibration failed");
      return {
        businessId,
        snapshotDate: "2026-05-06",
        rowsWritten: 6,
        accountScopes: 1,
        campaignScopes: 1,
        sampleRowsTotal: 6,
        sampleRowsByCohort: {
          purchase: 6,
          mid_funnel: 0,
          lead: 0,
          traffic: 0,
          upper_funnel: 0,
          engagement: 0,
          unknown: 0,
        },
        sampleRowsAfterCohortFilter: 6,
      };
    });

    const result = await runMetaSnapshotForAllBusinesses("2026-05-06");

    expect(result.businessCount).toBe(2);
    expect(result.results.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(result.results[1]?.reason).toContain("calibration failed");
  });

  it("persists anomaly rows alongside recommendation rows", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(anomalies.detectAnomaliesForBusiness).mockResolvedValue([
      {
        id: "meta_anomaly_2026-05-06_campaign_cmp_1_roas_drop_sudden",
        type: "roas_drop_sudden",
        scopeType: "campaign",
        scopeId: "cmp_1",
        scopeLabel: "Campaign 1",
        severity: "high",
        kind: "anomaly",
        title: "Sudden ROAS drop",
        detail: "7d ROAS fell sharply.",
        diagnostics: ["Tracking interruption candidate"],
        detectedAt: "2026-05-06T03:00:00.000Z",
      },
    ]);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const anomalyPayload = persistedRows<Record<string, unknown>>(sql.queryPayloads)
      .find((row) => row.kind === "anomaly");

    expect(anomalyPayload).toMatchObject({
      kind: "anomaly",
      rec_type: "roas_drop_sudden",
      decision_label: "diagnose",
      severity: "high",
      diagnostics: ["Tracking interruption candidate"],
      detected_at: "2026-05-06T03:00:00.000Z",
    });
  });

  it("persists evidence_trail for recommendation rows", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const recommendationPayload = sql.queryPayloads
      .filter(Boolean)
      .map((payload) => persistedRows<Record<string, unknown>>([payload]))
      .flat()
      .find((row) => row.kind === "recommendation" && !String(row.rec_type).endsWith("_state"));

    expect(recommendationPayload?.evidence_trail).toEqual({
      roas_history: [2.8, 3.2],
      peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
      regime_stability: 1,
      age_days: 28,
      recent_changes: [],
    });
    expect(recommendationPayload?.campaign_role).toBe("prospecting_validation");
    expect(recommendationPayload?.bid_regime).toBe("lowest_cost");
  });

  it("emits high-priority scenario recommendations through the snapshot path", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(campaignSource.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [campaign({ isBudgetMixed: true })],
      evidenceSource: "live",
    } as never);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const rows = sql.queryPayloads
      .filter(Boolean)
      .map((payload) => persistedRows<Record<string, unknown>>([payload]))
      .flat();

    expect(rows.some((row) => row.rec_type === "scenario_k1_mixed_config_rebuild")).toBe(true);
  });

  it("persists entity state rows for campaign and adset coverage", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(adsetsSource.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "adset_1",
          accountId: "act_1",
          campaignId: "cmp_1",
          name: "Adset 1",
          status: "ACTIVE",
          spend: 100,
          purchases: 1,
          revenue: 100,
          roas: 1,
          cpa: 100,
          ctr: 0.5,
          cpm: 10,
          cpc: 1,
          impressions: 1000,
          clicks: 10,
          frequency: 1.2,
          currency: "USD",
          dailyBudget: 25,
          lifetimeBudget: null,
          optimizationGoal: "Purchase",
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
          manualBidAmount: null,
          bidValue: null,
          bidValueFormat: null,
          isBudgetMixed: false,
          isConfigMixed: false,
        },
      ],
      evidenceSource: "live",
    } as never);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const rows = sql.queryPayloads
      .filter(Boolean)
      .map((payload) => persistedRows<Record<string, unknown>>([payload]))
      .flat();
    const stateRows = rows.filter((row) => String(row.rec_type).endsWith("_state"));

    expect(stateRows).toHaveLength(2);
    expect(stateRows.map((row) => row.scope_type).sort()).toEqual(["adset", "campaign"]);
    expect(stateRows.map((row) => row.rec_type).sort()).toEqual(["adset_state", "campaign_state"]);
    expect(stateRows.every((row) => row.decision_label)).toBe(true);
    expect(stateRows.every((row) => row.state_reason)).toBe(true);
  });

  it("iterates every mature campaign into a state row even when only adsets have action recs", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(campaignSource.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        campaign({ id: "cmp_1", name: "Campaign 1", purchases: 1, roas: 0.8 }),
        campaign({ id: "cmp_2", name: "Campaign 2", purchases: 0, roas: 0 }),
        campaign({ id: "cmp_3", name: "Campaign 3", purchases: 12, roas: 3.6 }),
      ],
      evidenceSource: "live",
    } as never);
    vi.mocked(adsetsSource.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "adset_1",
          accountId: "act_1",
          campaignId: "cmp_1",
          name: "Adset 1",
          status: "ACTIVE",
          spend: 100,
          purchases: 1,
          revenue: 100,
          roas: 1,
          cpa: 100,
          ctr: 0.5,
          cpm: 10,
          cpc: 1,
          impressions: 1000,
          clicks: 10,
          frequency: 1.2,
          currency: "USD",
          dailyBudget: 25,
          lifetimeBudget: null,
          optimizationGoal: "Purchase",
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
          manualBidAmount: null,
          bidValue: null,
          bidValueFormat: null,
          isBudgetMixed: false,
          isConfigMixed: false,
        },
      ],
      evidenceSource: "live",
    } as never);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const rows = sql.queryPayloads
      .filter(Boolean)
      .map((payload) => persistedRows<Record<string, unknown>>([payload]))
      .flat();
    const campaignStateRows = rows.filter((row) => row.scope_type === "campaign" && row.rec_type === "campaign_state");
    const adsetStateRows = rows.filter((row) => row.scope_type === "adset" && row.rec_type === "adset_state");

    expect(campaignStateRows).toHaveLength(3);
    expect(campaignStateRows.map((row) => row.scope_id).sort()).toEqual(["cmp_1", "cmp_2", "cmp_3"]);
    expect(adsetStateRows).toHaveLength(1);
  });

  it("allows campaign state and action recommendations to coexist for the same entity", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const rows = sql.queryPayloads
      .filter(Boolean)
      .map((payload) => persistedRows<Record<string, unknown>>([payload]))
      .flat();
    const campaignRows = rows.filter((row) => row.scope_type === "campaign" && row.scope_id === "cmp_1");
    const recTypes = new Set(campaignRows.map((row) => row.rec_type));

    expect(recTypes.has("campaign_state")).toBe(true);
    expect([...recTypes].some((recType) => recType !== "campaign_state")).toBe(true);
  });

  it("hydrates taxonomy fields from persisted snapshot rows", async () => {
    const sql = makeSqlMock([
      {
        scope_type: "campaign",
        scope_id: "cmp_1",
        business_id: "biz_1",
        snapshot_date: "2026-05-06",
        rec_id: "bid-cmp_1",
        rec_type: "bid_strategy_fit",
        level: "campaign",
        decision_state: "act",
        confidence_score: "0.82",
        evidence: { items: [] },
        recommended_action: "Test Cost Cap",
        target_value: null,
        expected_impact: "Better profit control.",
        reasoning: "Lowest Cost is not protecting profitability.",
        predictive_overlay: "Persisted snapshot.",
        engine_version: "v3.6.0-meta-taxonomy",
        evidence_trail: {},
        campaign_role: "retargeting",
        bid_regime: "lowest_cost",
        created_at: "2026-05-06T03:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await readMetaDecisionSnapshotForRange({
      businessId: "biz_1",
      startDate: "2026-05-01",
      endDate: "2026-05-06",
    });

    expect(result?.recommendations[0]).toMatchObject({
      campaignRole: "retargeting",
      bidRegime: "lowest_cost",
    });
    const latestSnapshotQuery = sql.calls.find((call) =>
      call.includes("WITH latest AS"),
    );
    expect(latestSnapshotQuery).not.toContain("snapshot_date BETWEEN");
  });

  it("preserves a persisted confidence cap instead of re-inflating it from the raw score", async () => {
    const storedRecommendation = {
      id: "watch-cmp_1",
      kind: "state",
      level: "campaign",
      campaignId: "cmp_1",
      type: "campaign_state",
      lens: "structure",
      priority: "medium",
      confidence: "medium",
      confidenceScore: 0.96,
      confidenceReason: "thin_data_watching",
      decisionState: "test",
      decision: "Keep testing",
      title: "Evidence is still forming",
      why: "The confidence label is policy-capped.",
      summary: "Do not act yet.",
      recommendedAction: "Review after more evidence.",
      expectedImpact: "Avoid premature action.",
      evidence: [],
    };
    const sql = makeSqlMock([
      {
        scope_type: "campaign",
        scope_id: "cmp_1",
        business_id: "biz_1",
        snapshot_date: "2026-05-06",
        rec_id: "watch-cmp_1",
        rec_type: "campaign_state",
        level: "campaign",
        decision_state: "test",
        confidence_score: "0.96",
        evidence: { recommendation: storedRecommendation, items: [] },
        recommended_action: "Review after more evidence.",
        target_value: null,
        expected_impact: "Avoid premature action.",
        reasoning: "The confidence label is policy-capped.",
        predictive_overlay: null,
        engine_version: "v1.0.0",
        evidence_trail: {},
        campaign_role: null,
        bid_regime: null,
        created_at: "2026-05-06T03:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await readMetaDecisionSnapshotForRange({
      businessId: "biz_1",
      startDate: "2026-05-01",
      endDate: "2026-05-06",
    });

    expect(result?.recommendations[0]).toMatchObject({
      confidence: "medium",
      confidenceScore: 0.96,
      confidenceReason: "thin_data_watching",
      decisionState: "test",
    });
  });

  it("keeps missing persisted confidence unknown instead of inventing 0.4", async () => {
    const sql = makeSqlMock([
      {
        scope_type: "campaign",
        scope_id: "cmp_1",
        business_id: "biz_1",
        snapshot_date: "2026-05-06",
        rec_id: "watch-cmp_1",
        rec_type: "campaign_state",
        level: "campaign",
        decision_state: "watch",
        confidence_score: null,
        evidence: { items: [] },
        recommended_action: "Review campaign state",
        target_value: null,
        expected_impact: null,
        reasoning: "Confidence evidence is unavailable.",
        predictive_overlay: null,
        engine_version: "v1.0.0",
        evidence_trail: {},
        campaign_role: null,
        bid_regime: null,
        created_at: "2026-05-06T03:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await readMetaDecisionSnapshotForRange({
      businessId: "biz_1",
      startDate: "2026-05-01",
      endDate: "2026-05-06",
    });

    expect(result?.recommendations[0]).toMatchObject({
      confidence: "low",
      confidenceReason: "confidence_score_missing",
      priority: "low",
    });
    expect(result?.recommendations[0]?.confidenceScore).toBeUndefined();
  });

  it("guards pre-existing persisted hard actions at read time when campaign label is missing", async () => {
    const sql = makeSqlMock([
      {
        scope_type: "campaign",
        scope_id: "cmp_1",
        business_id: "biz_1",
        snapshot_date: "2026-05-06",
        rec_id: "scale-cmp_1",
        rec_type: "scale_for_volume",
        level: "campaign",
        decision_state: "act",
        confidence_score: "0.9",
        evidence: { items: [] },
        recommended_action: "Increase budget 10-15%.",
        target_value: null,
        expected_impact: "More volume.",
        reasoning: "Strong scale signal.",
        predictive_overlay: "Persisted snapshot.",
        engine_version: "v1.0.0",
        evidence_trail: {},
        campaign_role: "prospecting_scale",
        bid_regime: "lowest_cost",
        created_at: "2026-05-06T03:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(
      campaignContextSource.readCampaignContextLabelMap,
    ).mockResolvedValue(new Map());

    const result = await readMetaDecisionSnapshotForRange({
      businessId: "biz_1",
      startDate: "2026-05-01",
      endDate: "2026-05-06",
    });

    expect(result?.recommendations[0]).toMatchObject({
      decisionState: "watch",
      decisionLabel: "scale",
      confidence: "low",
      confidenceReason: "automatic_campaign_context_review_only",
      signalQuality: {
        campaign_context_status: "unknown",
        campaign_context_action_authority: "review_only",
      },
    });
  });

  it("keeps persisted hard actions when fresh automatic campaign role is high confidence", async () => {
    const sql = makeSqlMock([
      {
        scope_type: "campaign",
        scope_id: "cmp_1",
        business_id: "biz_1",
        snapshot_date: "2026-05-06",
        rec_id: "scale-cmp_1",
        rec_type: "scale_for_volume",
        level: "campaign",
        decision_state: "act",
        confidence_score: "0.9",
        evidence: { items: [] },
        recommended_action: "Increase budget 10-15%.",
        target_value: null,
        expected_impact: "More volume.",
        reasoning: "Strong scale signal.",
        predictive_overlay: "Persisted snapshot.",
        engine_version: "v1.0.0",
        evidence_trail: {},
        campaign_role: "prospecting_scale",
        bid_regime: "lowest_cost",
        created_at: "2026-05-06T03:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(
      campaignContextSource.readCampaignContextLabelMap,
    ).mockResolvedValue(automaticCampaignContext("cmp_1", "main"));

    const result = await readMetaDecisionSnapshotForRange({
      businessId: "biz_1",
      startDate: "2026-05-01",
      endDate: "2026-05-06",
    });

    expect(result?.recommendations[0]).toMatchObject({
      type: "scale_for_volume",
      decisionState: "act",
      confidence: "high",
    });
    expect(result?.recommendations[0]?.confidenceReason).not.toBe("unlabeled_campaign_soft_only");
  });

  it("preserves persisted spend authority when the current commercial target is old but valid", async () => {
    const sql = makeSqlMock([
      {
        scope_type: "campaign",
        scope_id: "cmp_1",
        business_id: "biz_1",
        snapshot_date: "2026-05-06",
        rec_id: "scale-cmp_1",
        rec_type: "scale_for_volume",
        level: "campaign",
        decision_state: "act",
        confidence_score: "0.9",
        evidence: { items: [] },
        recommended_action: "Increase budget 10-15%.",
        target_value: 15,
        expected_impact: "More volume.",
        reasoning: "Strong scale signal.",
        predictive_overlay: "Persisted snapshot.",
        engine_version: "v1.0.0",
        evidence_trail: {},
        campaign_role: "prospecting_scale",
        bid_regime: "lowest_cost",
        created_at: "2026-05-06T03:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(commercialTargets.readMetaCommercialTargets).mockResolvedValue({
      source: "configured_targets",
      targetRoas: 2.2,
      breakEvenRoas: 1.5,
      targetCpa: 120,
      breakEvenCpa: 160,
      riskPosture: "balanced",
      freshness: "stale",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    vi.mocked(
      campaignContextSource.readCampaignContextLabelMap,
    ).mockResolvedValue(automaticCampaignContext("cmp_1", "main"));

    const result = await readMetaDecisionSnapshotForRange({
      businessId: "biz_1",
      startDate: "2026-05-01",
      endDate: "2026-05-06",
    });

    expect(result?.recommendations[0]).toMatchObject({
      type: "scale_for_volume",
      decisionState: "act",
    });
    expect(
      result?.recommendations[0]?.signalQuality?.hard_action_blocker,
    ).toBeUndefined();
  });

  it("marks previously active anomalies resolved when absent on rerun", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(anomalies.detectAnomaliesForBusiness)
      .mockResolvedValueOnce([
        {
          id: "meta_anomaly_2026-05-06_campaign_cmp_1_roas_drop_sudden",
          type: "roas_drop_sudden",
          scopeType: "campaign",
          scopeId: "cmp_1",
          scopeLabel: "Campaign 1",
          severity: "medium",
          kind: "anomaly",
          title: "Sudden ROAS drop",
          detail: "7d ROAS fell.",
          diagnostics: ["Recent bid change candidate"],
          detectedAt: "2026-05-06T03:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");
    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    expect(
      sql.calls.some(
        (text) =>
          text.includes("SET resolved_at = now()") &&
          text.includes("kind = 'anomaly'") &&
          text.includes("resolved_at IS NULL"),
      ),
    ).toBe(true);
  });
});
