import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

const profileMocks = vi.hoisted(() => ({
  resolveAccountDecisionProfile: vi.fn(),
}));

const nativeSchemaMocks = vi.hoisted(() => ({
  inspectProducer: vi.fn(),
  inspectOutcomes: vi.fn(),
  inspectControlled: vi.fn(),
}));

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => dbMocks),
}));

vi.mock("@/lib/creative-decision-engine/account-decision-profile", () => ({
  resolveAccountDecisionProfile: profileMocks.resolveAccountDecisionProfile,
}));

vi.mock("@/lib/creative-decision-engine/jobs/native-ad-scheduled", () => ({
  inspectNativeAdShadowSchemaReadiness: nativeSchemaMocks.inspectProducer,
}));

vi.mock("@/lib/creative-decision-engine/jobs/ad-decision-outcomes-job", () => ({
  AD_DECISION_OUTCOMES_JOB_NAME: "engine_v3_ad_decision_outcomes_job",
  inspectAdDecisionOutcomeSchemaCapability: nativeSchemaMocks.inspectOutcomes,
}));

vi.mock("@/lib/meta/controlled-experiment-registry", () => ({
  inspectControlledRegistryCapabilities: nativeSchemaMocks.inspectControlled,
}));

const adminAuth = await import("@/lib/admin-auth");
const accountDecisionProfile = await import(
  "@/lib/creative-decision-engine/account-decision-profile"
);
const { GET } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const BUSINESS_NAME = "TheSwaf";
const CALIBRATION_JOB_NAME = "engine_v3_calibration_job";
const LIFECYCLE_JOB_NAME = "engine_v3_lifecycle_job";
const DECISIONS_JOB_NAME = "engine_v3_decisions_job";
const OPERATOR_RESPONSE_JOB_NAME = "engine_v3_operator_response_job";
const NATIVE_CALIBRATION_JOB_NAME =
  "engine_v3_native_ad_calibration_shadow_job";
const NATIVE_DECISIONS_JOB_NAME = "engine_v3_native_ad_decisions_shadow_job";
const NATIVE_OPERATOR_RESPONSE_JOB_NAME =
  "engine_v3_native_ad_operator_response_shadow_job";
const NATIVE_OUTCOMES_JOB_NAME = "engine_v3_ad_decision_outcomes_job";
const JOB_NAMES = [
  CALIBRATION_JOB_NAME,
  LIFECYCLE_JOB_NAME,
  DECISIONS_JOB_NAME,
  OPERATOR_RESPONSE_JOB_NAME,
  NATIVE_CALIBRATION_JOB_NAME,
  NATIVE_DECISIONS_JOB_NAME,
  NATIVE_OPERATOR_RESPONSE_JOB_NAME,
  NATIVE_OUTCOMES_JOB_NAME,
];

interface FixtureJob {
  last_run_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
}

interface FixtureState {
  business: { id: string; name: string } | null;
  flagOverride: {
    enabled: boolean | null;
    surface_visible: boolean | null;
    shadow_only: boolean | null;
  } | null;
  metaLatestAt: string | null;
  decisionsLatestAt: string | null;
  nativeDecisionsLatestAt: string | null;
  jobs: Record<string, FixtureJob>;
  matureCount: number;
  decisionsSummary: {
    last_24h: number;
    last_7d: number;
    soft_only_count: number;
    hard_action_count: number;
  };
}

const previousEnv = {
  ENGINE_V3_ENABLED: process.env.ENGINE_V3_ENABLED,
  ENGINE_V3_SURFACE_VISIBLE: process.env.ENGINE_V3_SURFACE_VISIBLE,
  ENGINE_V3_SHADOW_ONLY: process.env.ENGINE_V3_SHADOW_ONLY,
  DECISION_ENGINE_V3_ENABLED: process.env.DECISION_ENGINE_V3_ENABLED,
  DECISION_ENGINE_V3_SURFACE_VISIBLE:
    process.env.DECISION_ENGINE_V3_SURFACE_VISIBLE,
  DECISION_ENGINE_V3_SHADOW_ONLY: process.env.DECISION_ENGINE_V3_SHADOW_ONLY,
  DECISION_ENGINE_V3_JOBS_DISABLED:
    process.env.DECISION_ENGINE_V3_JOBS_DISABLED,
};

let fixture: FixtureState;

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function makeJob(hoursSinceSuccess = 2): FixtureJob {
  const lastSuccessAt = hoursAgo(hoursSinceSuccess);
  return {
    last_run_at: lastSuccessAt,
    last_success_at: lastSuccessAt,
    last_failure_at: null,
    last_error: null,
  };
}

function makeFixture(): FixtureState {
  return {
    business: { id: BUSINESS_ID, name: BUSINESS_NAME },
    flagOverride: null,
    metaLatestAt: hoursAgo(2),
    decisionsLatestAt: hoursAgo(2),
    nativeDecisionsLatestAt: hoursAgo(2),
    jobs: Object.fromEntries(
      JOB_NAMES.map((jobName) => [jobName, makeJob()]),
    ) as Record<string, FixtureJob>,
    matureCount: 35,
    decisionsSummary: {
      last_24h: 12,
      last_7d: 64,
      soft_only_count: 8,
      hard_action_count: 4,
    },
  };
}

function makeProfile() {
  return {
    businessId: BUSINESS_ID,
    asOfDate: "2026-05-05",
    channel: "meta",
    objectiveFamily: "sales",
    preset: "balanced",
    presetSource: "target_pack_risk_posture",
    spendUnit: 25,
    spendUnitSource: "meta_derived_aov",
    spendUnitConfidence: "medium",
    spendUnitEvidence: {
      targetCpa: null,
      operatorAovAssumption: null,
      metaAttributedAovMean90d: 55,
      metaAttributedAovPurchaseCount90d: 40,
      metaAttributedRevenue90d: 2200,
      targetRoas: 2.2,
      breakEvenRoas: 1.7,
      accountCpaP50: 60,
      accountCpaSampleCount: 35,
      warnings: [],
    },
    accountBaselines: {
      matureCreativeCount: 35,
    },
    // The readiness response serves the canonical anchor explanation and the
    // per-action codes, so the fixture carries a realistic eligibility block.
    hardActionEligibility: {
      scale: true,
      cut: true,
      refresh: true,
      reason: null,
      reasons: { scale: null, cut: null, refresh: null },
      codes: { scale: null, cut: null, refresh: null },
      anchor: {
        contractVersion: "creative-decision-engine.commercial-anchor.v1",
        status: "eligible_meta_derived_aov",
        thresholdEligible: true,
        spendUnit: 25,
        spendUnitSource: "meta_derived_aov",
        spendUnitConfidence: "medium",
        currency: null,
        targetPackFreshness: "fresh",
        targetPackUpdatedAt: "2026-05-04T02:00:00.000Z",
        metaAovQuality: "ready",
        lineage: {
          targetCpa: null,
          operatorAovAssumption: null,
          targetRoas: 2.2,
          breakEvenRoas: 1.7,
          metaAttributedAovMean90d: 55,
          metaAttributedAovPurchaseCount90d: 40,
          attributionAovAdjustmentMultiplier: 1,
        },
        missingInputs: [],
        actions: {
          scale: { eligible: true, blockerCode: null, operatorCopy: null },
          cut: { eligible: true, blockerCode: null, operatorCopy: null },
          refresh: { eligible: true, blockerCode: null, operatorCopy: null },
        },
      },
    },
    quality: {
      commercialTruthReady: true,
      calibrationReady: true,
      metaAovQuality: "ready",
      thresholdQuality: "ready",
    },
  };
}

async function handleQuery(queryText: string, values?: unknown[]) {
  const normalized = queryText.replace(/\s+/g, " ").trim();

  if (normalized.includes("FROM businesses")) {
    return fixture.business
      ? [{ id: fixture.business.id, name: fixture.business.name }]
      : [];
  }

  if (normalized.includes("FROM business_engine_v3_flags")) {
    return fixture.flagOverride ? [fixture.flagOverride] : [];
  }

  if (
    normalized.includes("FROM meta_creative_daily") &&
    normalized.includes("MAX(updated_at)")
  ) {
    return [{ latest_at: fixture.metaLatestAt }];
  }

  if (
    normalized.includes("FROM engine_v3_decision_snapshots_daily") &&
    normalized.includes("MAX(computed_at)")
  ) {
    return [{ latest_at: fixture.decisionsLatestAt }];
  }

  if (
    normalized.includes("FROM engine_v3_ad_decision_snapshots_daily") &&
    normalized.includes("MAX(computed_at)")
  ) {
    return [{ latest_at: fixture.nativeDecisionsLatestAt }];
  }

  if (normalized.includes("FROM engine_v3_job_runs")) {
    const jobName = String(values?.[0] ?? "");
    return [
      fixture.jobs[jobName] ?? {
        last_run_at: null,
        last_success_at: null,
        last_failure_at: null,
        last_error: null,
      },
    ];
  }

  if (
    normalized.includes("FROM engine_v3_account_calibration_daily") &&
    normalized.includes("mature_creative_count AS mature_count")
  ) {
    expect(normalized).toContain("campaign_kind = 'all'");
    return [{ mature_count: fixture.matureCount }];
  }

  if (
    normalized.includes("FROM engine_v3_decision_snapshots_daily") &&
    normalized.includes("soft_only_count")
  ) {
    return [fixture.decisionsSummary];
  }

  throw new Error(`Unhandled readiness test query: ${normalized}`);
}

function mockAdmin() {
  vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
    session: { user: { id: "admin-1", email: "admin@example.test" } },
  } as never);
}

function mockAuthError(status: 401 | 403) {
  vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
    error: NextResponse.json(
      {
        error: status === 401 ? "auth_error" : "forbidden",
        message:
          status === 401
            ? "Authentication required."
            : "Admin access required.",
      },
      { status },
    ),
  } as never);
}

function readinessRequest(path = `/api/admin/engine-v3/readiness?businessId=${BUSINESS_ID}`) {
  return new NextRequest(`http://localhost${path}`);
}

describe("GET /api/admin/engine-v3/readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreEnv();
    process.env.DECISION_ENGINE_V3_ENABLED = "true";
    process.env.DECISION_ENGINE_V3_SURFACE_VISIBLE = "true";
    process.env.DECISION_ENGINE_V3_SHADOW_ONLY = "false";
    delete process.env.DECISION_ENGINE_V3_JOBS_DISABLED;
    fixture = makeFixture();
    mockAdmin();
    dbMocks.query.mockImplementation(handleQuery);
    vi.mocked(
      accountDecisionProfile.resolveAccountDecisionProfile,
    ).mockResolvedValue(makeProfile() as never);
    nativeSchemaMocks.inspectProducer.mockResolvedValue({
      ready: true,
      issues: [],
      components: {
        calibration: { ready: true, issues: [] },
        decisions: { ready: true, issues: [] },
        operatorResponse: { ready: true, issues: [] },
      },
    });
    nativeSchemaMocks.inspectOutcomes.mockResolvedValue({
      ready: true,
      missing: [],
    });
    nativeSchemaMocks.inspectControlled.mockResolvedValue({
      ready: true,
      issues: [],
    });
  });

  afterEach(() => {
    restoreEnv();
  });

  it("serves a business-scoped, display-only compaction readiness section (D077 hardening)", async () => {
    const response = await GET(readinessRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    const section = payload.stateHistoryCompaction;
    expect(section.contract).toBe(
      "d077.state-history-compaction-readiness.v3",
    );
    // Journal provenance is explicit; a mocked-empty read is honestly ok.
    expect(["ok", "unavailable"]).toContain(section.journalRead);
    expect(section.businessId).toBe(BUSINESS_ID);
    // The journal read is parameterized to this business — never global.
    const journalCall = dbMocks.query.mock.calls.find(([text]) =>
      String(text).includes("meta_state_history_compaction_journal"),
    );
    expect(journalCall).toBeDefined();
    expect(String(journalCall![0])).toContain("$1 = ANY(business_ids)");
    expect(journalCall![1]).toEqual([BUSINESS_ID]);
    // Measured D075 evidence; the withdrawn hard-coded assertion is gone.
    expect(["observed", "not_observed", "unknown"]).toContain(
      section.d075WriterEvidence.state,
    );
    expect(JSON.stringify(section)).not.toContain(
      "d075_delta_manifests_not_deployed",
    );
    // Display-only: no token, no executable plan.
    expect(JSON.stringify(section)).not.toContain(
      "approve-state-history-compaction",
    );
    expect(section.plannedReclaim).toBeNull();
  });

  it("a journal-ONLY read failure serves an explicit unavailable state, never NOT_EXECUTED (correction 3)", async () => {
    // Fence and D075 measurements succeed; only the business-scoped
    // journal query throws.
    dbMocks.query.mockImplementation(async (queryText: string, values?: unknown[]) => {
      if (String(queryText).includes("meta_state_history_compaction_journal")) {
        throw new Error("journal down");
      }
      if (String(queryText).includes("manifest_kind")) {
        return [{ observed: true }];
      }
      return handleQuery(String(queryText), values);
    });

    const response = await GET(readinessRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    const section = payload.stateHistoryCompaction;
    expect(section.contract).toBe(
      "d077.state-history-compaction-readiness.v3",
    );
    expect(section.journalRead).toBe("unavailable");
    expect(section.approvalStatus).toBe("UNKNOWN_JOURNAL_UNAVAILABLE");
    expect(section.blockers).toContain("compaction_journal_read_unavailable");
    // The empty array is unavailable evidence, not proven emptiness — and
    // no factual NOT_EXECUTED claim appears anywhere in the section.
    expect(section.latestJournal).toEqual([]);
    expect(JSON.stringify(section)).not.toContain("NOT_EXECUTED");
    expect(section.d075WriterEvidence.state).toBe("observed");
    // The scoping predicate was still issued with the requested business.
    const journalCall = dbMocks.query.mock.calls.find(([text]) =>
      String(text).includes("meta_state_history_compaction_journal"),
    );
    expect(String(journalCall![0])).toContain("$1 = ANY(business_ids)");
    expect(journalCall![1]).toEqual([BUSINESS_ID]);
  });

  it("returns 401 when no auth session exists", async () => {
    mockAuthError(401);

    const response = await GET(readinessRequest());
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.error).toBe("auth_error");
    expect(dbMocks.query).not.toHaveBeenCalled();
  });

  it("returns 403 when the user is not an admin", async () => {
    mockAuthError(403);

    const response = await GET(readinessRequest());
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe("forbidden");
    expect(dbMocks.query).not.toHaveBeenCalled();
  });

  it("returns 400 when businessId is missing or invalid", async () => {
    const missing = await GET(readinessRequest("/api/admin/engine-v3/readiness"));
    const invalid = await GET(
      readinessRequest("/api/admin/engine-v3/readiness?businessId=not-a-number"),
    );

    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual(
      expect.objectContaining({ error: "invalid_business_id" }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual(
      expect.objectContaining({ error: "invalid_business_id" }),
    );
    expect(adminAuth.requireAdmin).not.toHaveBeenCalled();
  });

  it("returns 404 when businessId references a non-existent business", async () => {
    fixture.business = null;

    const response = await GET(readinessRequest());
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error).toBe("business_not_found");
    expect(
      accountDecisionProfile.resolveAccountDecisionProfile,
    ).not.toHaveBeenCalled();
  });

  it("returns a valid response shape for an enabled business with fresh data", async () => {
    const response = await GET(readinessRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        businessName: BUSINESS_NAME,
        asOfTimestamp: expect.any(String),
        flags: expect.objectContaining({
          enabled: true,
          surfaceVisible: true,
          shadowOnly: false,
          source: {
            enabled: "env",
            surfaceVisible: "env",
            shadowOnly: "env",
            presetOverride: null,
          },
        }),
        dataHealth: expect.objectContaining({
          tier: "fresh",
          metaSyncAgeHours: expect.any(Number),
          decisionsAgeHours: expect.any(Number),
        }),
        jobs: expect.objectContaining({
          calibration: expect.objectContaining({
            lastSuccessAt: expect.any(String),
            isStale: false,
          }),
          lifecycle: expect.any(Object),
          decisions: expect.any(Object),
          operatorResponse: expect.any(Object),
        }),
        accountProfile: expect.objectContaining({
          spendUnit: 25,
          spendUnitSource: "meta_derived_aov",
          presetLabel: "balanced",
          targetRoas: 2.2,
          breakEvenRoas: 1.7,
          aov: 55,
          aovSource: "meta_attributed_90d",
          matureCount: 35,
          quality: {
            commercialTruthReady: true,
            calibrationReady: true,
            metaAovQuality: "high",
            thresholdQuality: "high",
          },
        }),
        decisionsSummary: {
          last24h: 12,
          last7d: 64,
          softOnlyCount: 8,
          hardActionCount: 4,
        },
        gating: {
          canEvaluate: true,
          reasons: [],
        },
        nativeAd: expect.objectContaining({
          shadowOnly: true,
          jobsDisabled: false,
          schema: expect.objectContaining({ allReady: true }),
          evidence: expect.objectContaining({
            latestSnapshotAt: expect.any(String),
            isStale: false,
          }),
          gating: expect.objectContaining({
            canRunShadow: true,
            hasCurrentEvidence: true,
            canMeasureOutcomes: true,
            canUseControlledEvidence: true,
            reasons: [],
          }),
        }),
      }),
    );
  });

  it("reports native readiness separately and never marks missing schema ready", async () => {
    nativeSchemaMocks.inspectProducer.mockResolvedValueOnce({
      ready: false,
      issues: ["decisions:missing_table"],
      components: {
        calibration: { ready: true, issues: [] },
        decisions: { ready: false, issues: ["missing_table"] },
        operatorResponse: { ready: true, issues: [] },
      },
    });
    nativeSchemaMocks.inspectOutcomes.mockResolvedValueOnce({
      ready: false,
      missing: ["outcomes.missing_table"],
    });

    const response = await GET(readinessRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.gating.canEvaluate).toBe(true);
    expect(payload.nativeAd.schema.allReady).toBe(false);
    expect(payload.nativeAd.gating.canRunShadow).toBe(false);
    expect(payload.nativeAd.gating.canMeasureOutcomes).toBe(false);
    expect(payload.nativeAd.gating.reasons).toEqual(
      expect.arrayContaining([
        "native_producer_schema_not_ready",
        "native_outcome_schema_not_ready",
      ]),
    );
  });

  it('returns gating.canEvaluate=false with reason "calibration_stale" when calibration is older than 24h', async () => {
    fixture.jobs[CALIBRATION_JOB_NAME] = makeJob(25);

    const response = await GET(readinessRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.jobs.calibration.isStale).toBe(true);
    expect(payload.gating.canEvaluate).toBe(false);
    expect(payload.gating.reasons).toContain("calibration_stale");
  });

  it('returns dataHealth.tier="missing" when no meta_creative_daily rows exist', async () => {
    fixture.metaLatestAt = null;

    const response = await GET(readinessRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.dataHealth.tier).toBe("missing");
    expect(payload.dataHealth.metaSyncAgeHours).toBeNull();
    expect(payload.gating.canEvaluate).toBe(false);
    expect(payload.gating.reasons).toContain("data_health_missing");
  });

  it("returns flags.enabled=false and gates off when a business override disables v3", async () => {
    fixture.flagOverride = {
      enabled: false,
      surface_visible: true,
      shadow_only: true,
    };

    const response = await GET(readinessRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.flags.enabled).toBe(false);
    expect(payload.flags.shadowOnly).toBe(true);
    expect(payload.flags.source.enabled).toBe("business_override");
    expect(payload.gating.canEvaluate).toBe(false);
    expect(payload.gating.reasons).toContain("engine_v3_disabled");
  });

  it("serves the canonical anchor explanation and per-action codes (D079 correction)", async () => {
    const response = await GET(readinessRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();
    const profile = payload.accountProfile;
    // The explanation is the profile's own object, not a re-derivation.
    expect(profile.commercialAnchor.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.commercialAnchor.spendUnitConfidence).toBe("medium");
    expect(profile.commercialAnchor.status).toBe("eligible_meta_derived_aov");
    expect(
      profile.commercialAnchor.lineage.metaAttributedAovPurchaseCount90d,
    ).toBe(40);
    expect(profile.hardActionEligibility).toMatchObject({
      scale: true,
      cut: true,
      refresh: true,
      codes: { scale: null, cut: null, refresh: null },
    });
  });

  it("degrades to unknown rather than 500 when a profile carries no eligibility", async () => {
    vi.mocked(
      accountDecisionProfile.resolveAccountDecisionProfile,
    ).mockResolvedValueOnce({
      ...makeProfile(),
      hardActionEligibility: undefined,
    } as never);
    const response = await GET(readinessRequest());
    expect(response.status).toBe(200);
    const payload = await response.json();
    // Absence is reported as ineligible with no code — never as eligible.
    expect(payload.accountProfile.commercialAnchor).toBeNull();
    expect(payload.accountProfile.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
  });

});
