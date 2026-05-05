import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

const profileMocks = vi.hoisted(() => ({
  resolveAccountDecisionProfile: vi.fn(),
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
const JOB_NAMES = [
  CALIBRATION_JOB_NAME,
  LIFECYCLE_JOB_NAME,
  DECISIONS_JOB_NAME,
  OPERATOR_RESPONSE_JOB_NAME,
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
    fixture = makeFixture();
    mockAdmin();
    dbMocks.query.mockImplementation(handleQuery);
    vi.mocked(
      accountDecisionProfile.resolveAccountDecisionProfile,
    ).mockResolvedValue(makeProfile() as never);
  });

  afterEach(() => {
    restoreEnv();
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
      }),
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
});
