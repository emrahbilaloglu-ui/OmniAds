import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { getDb, resetDbClientCache, runDbTransaction } from "@/lib/db";
import {
  JOB_NAME as CALIBRATION_JOB_NAME,
  runCalibrationJob,
} from "../../jobs/calibration-job";
import {
  dedupeDecisionComputations,
  decisionsJobAdvisoryLockKey,
  JOB_NAME,
  runDecisionsJob,
} from "../../jobs/decisions-job";
import {
  JOB_NAME as LIFECYCLE_JOB_NAME,
  runLifecycleJob,
} from "../../jobs/lifecycle-job";
import { WarehouseDataSource } from "../../data-source";
import {
  ENGINE_VERSION,
  type AccountCalibration,
  type AccountFunnelCalibration,
  type CreativeInput,
  type DataHealth,
  type DecisionLabel,
  type DecisionOutput,
} from "../../types";
import { makeCreativeInput } from "../helpers";

const AS_OF = "2026-05-04";
const PREVIOUS_AS_OF = "2026-05-03";
const THESWAF_BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const IWASTORE_BUSINESS_ID = "f8a3b5ac-588c-462f-8702-11cd24ff3cd2";
const FAILURE_BUSINESS_ID = "00000000-0000-4000-8000-000000000551";
const PERSISTED_GUARD_BUSINESS_ID =
  "00000000-0000-4000-8000-000000000552";
const PERSISTED_NO_CAMPAIGN_GUARD_BUSINESS_ID =
  "00000000-0000-4000-8000-000000000555";
const LABEL_TRANSFORM_BUSINESS_ID =
  "00000000-0000-4000-8000-000000000553";
const UNKNOWN_BUSINESS_ID = "00000000-0000-4000-8000-000000000554";
const TEST_BUSINESS_IDS = [
  THESWAF_BUSINESS_ID,
  IWASTORE_BUSINESS_ID,
  FAILURE_BUSINESS_ID,
  PERSISTED_GUARD_BUSINESS_ID,
  PERSISTED_NO_CAMPAIGN_GUARD_BUSINESS_ID,
  LABEL_TRANSFORM_BUSINESS_ID,
  UNKNOWN_BUSINESS_ID,
];

type CountRow = Record<string, unknown> & {
  count: unknown;
};

type IdRow = Record<string, unknown> & {
  id: unknown;
};

type SnapshotLinkageCountRow = Record<string, unknown> & {
  missing_lifecycle_count: unknown;
  missing_calibration_count: unknown;
};

type JobRunRow = Record<string, unknown> & {
  status: unknown;
  row_count: unknown;
  dependency_run_id: unknown;
  error_message: unknown;
  error_json: unknown;
};

type DecisionSnapshotFixtureRow = Record<string, unknown> & {
  id: unknown;
  business_id: unknown;
  creative_id: unknown;
  scope_type: unknown;
  scope_id: unknown;
  label: unknown;
  raw_label: unknown;
  pre_authority_label: unknown;
  authority_blocker: unknown;
  confidence: unknown;
  truth_source: unknown;
  effective_target_roas: unknown;
  ratio_to_target: unknown;
  badges: unknown;
  reason: unknown;
  spend: unknown;
  purchases: unknown;
  roas: unknown;
  recent7d_roas: unknown;
  label_transform: unknown;
  blocked_action_type: unknown;
};

type DecisionEventRow = Record<string, unknown> & {
  creative_id: unknown;
  previous_label: unknown;
  current_label: unknown;
  operator_evidence: unknown;
};

function toNumber(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function toString(value: unknown) {
  return typeof value === "string" ? value : String(value ?? "");
}

function toDecisionLabel(value: unknown): DecisionLabel {
  const text = toString(value);
  if (
    text === "scale" ||
    text === "keep" ||
    text === "refresh" ||
    text === "cut" ||
    text === "test_more" ||
    text === "diagnose" ||
    text === "out_of_scope"
  ) {
    return text;
  }
  throw new Error(`Unexpected decision label in fixture row: ${text}`);
}

function alternateLabel(label: DecisionLabel): DecisionLabel {
  return label === "diagnose" ? "test_more" : "diagnose";
}

function changeEventCountMetadata(value: unknown) {
  return metadataNumber(value, "change_event_count");
}

function jobRunMetadata(value: unknown) {
  if (value === null || typeof value !== "object") return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (metadata === null || typeof metadata !== "object") return null;
  return metadata as Record<string, unknown>;
}

function metadataNumber(value: unknown, key: string) {
  const metadata = jobRunMetadata(value);
  if (metadata === null) return null;
  const count = metadata[key];
  return typeof count === "number" ? count : null;
}

describe("decisions job SQL contracts", () => {
  it("links snapshots to the canonical all-kind calibration row", () => {
    const source = readFileSync(
      "lib/creative-decision-engine/jobs/decisions-job.ts",
      "utf8",
    );
    const calibrationLookup = source.match(
      /async function findLatestCalibrationRowId[\s\S]*?LIMIT 1/,
    )?.[0];

    expect(calibrationLookup).toContain("campaign_kind = 'all'");
    expect(calibrationLookup).toContain("creative_format = 'overall'");
  });

  it("persists authority provenance, raw label, and held-action diagnostics in the snapshot upsert contract", () => {
    const source = readFileSync(
      "lib/creative-decision-engine/jobs/decisions-job.ts",
      "utf8",
    );
    const snapshotUpsert = source.match(
      /const UPSERT_DECISION_SNAPSHOTS_QUERY = `[\s\S]*?RETURNING id, creative_id, label, confidence/,
    )?.[0];
    const mapper = source.match(
      /function toSnapshotPayloadRow[\s\S]*?label_transform: input\.decision\.labelTransform \?\? null,[\s\S]*?};/,
    )?.[0];

    expect(snapshotUpsert).toContain("label_transform text");
    expect(snapshotUpsert).toContain("label_transform,");
    expect(snapshotUpsert).toContain(
      "label_transform = EXCLUDED.label_transform",
    );
    expect(snapshotUpsert).toContain("blocked_action_type text");
    expect(snapshotUpsert).toContain("blocked_action_type,");
    expect(snapshotUpsert).toContain(
      "blocked_action_type = EXCLUDED.blocked_action_type",
    );
    expect(snapshotUpsert).toContain("pre_authority_label text");
    expect(snapshotUpsert).toContain("authority_blocker text");
    expect(snapshotUpsert).toContain(
      "pre_authority_label = EXCLUDED.pre_authority_label",
    );
    expect(snapshotUpsert).toContain(
      "authority_blocker = EXCLUDED.authority_blocker",
    );
    expect(mapper).toContain(
      "label_transform: input.decision.labelTransform ?? null",
    );
    expect(mapper).toContain("blocked_action_type:");
    expect(mapper).toContain("input.decision.blockedActionType");
    expect(mapper).toContain(
      "pre_authority_label: input.decision.preAuthorityLabel",
    );
    expect(mapper).toContain(
      "authority_blocker: input.decision.authorityBlocker",
    );
  });

  it("prunes only stale current-day decision materialization for the same scope", () => {
    const source = readFileSync(
      "lib/creative-decision-engine/jobs/decisions-job.ts",
      "utf8",
    );
    const pruneQuery = source.match(
      /const PRUNE_STALE_DECISION_SNAPSHOTS_QUERY = `[\s\S]*?`;/,
    )?.[0];

    expect(pruneQuery).toContain("as_of_date = $2::date");
    expect(pruneQuery).toContain("engine_version = $3");
    expect(pruneQuery).toContain("scope_type = $4");
    expect(pruneQuery).toContain("scope_id = $5");
    expect(pruneQuery).toContain(
      "AND NOT (creative_id = ANY($6::text[]))",
    );
    expect(pruneQuery).toContain(
      "RETURNING snapshots.id, snapshots.creative_id",
    );
    expect(pruneQuery).toContain("DELETE FROM engine_v3_decision_events");
    expect(pruneQuery).toContain("USING deleted_snapshots snapshots");
    expect(pruneQuery).toContain("events.event_type = 'decision_changed'");
    expect(pruneQuery).toContain(
      "DELETE FROM engine_v3_decision_snapshots_daily",
    );
  });

  it("guards empty decision payloads before pruning and records prune metadata", () => {
    const source = readFileSync(
      "lib/creative-decision-engine/jobs/decisions-job.ts",
      "utf8",
    );
    const pruneHelper = source.match(
      /async function pruneStaleDecisionSnapshots[\s\S]*?skippedBecauseEmptyPayload: false,[\s\S]*?};\n}/,
    )?.[0];
    const successMetadata = source.match(
      /metadata: \{[\s\S]*?prune_skipped_empty_payload:[\s\S]*?\},/,
    )?.[0];

    expect(pruneHelper).toContain("input.currentCreativeIds.length === 0");
    expect(pruneHelper).toContain("skippedBecauseEmptyPayload: true");
    expect(successMetadata).toContain("pruned_snapshot_count");
    expect(successMetadata).toContain("pruned_event_count");
    expect(successMetadata).toContain("prune_skipped_empty_payload");
  });

  it("documents why stale decision change events are explicitly pruned", () => {
    const source = readFileSync(
      "lib/creative-decision-engine/jobs/decisions-job.ts",
      "utf8",
    );
    const migrations = readFileSync("lib/migrations.ts", "utf8");

    expect(source).toContain(
      "decision_snapshot_id uses ON DELETE SET NULL for events",
    );
    expect(migrations).toContain(
      "decision_snapshot_id       UUID REFERENCES engine_v3_decision_snapshots_daily(id) ON DELETE SET NULL",
    );
  });
});

function makeDecisionOutput(
  label: DecisionLabel,
  overrides: Partial<DecisionOutput> = {},
): DecisionOutput {
  return {
    creativeId: "creative-1",
    creativeName: "Creative 1",
    label,
    reason: `${label} reason`,
    confidence: 70,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 1,
    badges: [],
    metrics: {
      spend: 100,
      purchases: 1,
      roas: 2,
      recent7dRoas: 2,
    },
    preAuthorityLabel: label,
    authorityBlocker: null,
    engineVersion: ENGINE_VERSION,
    generatedAt: "2026-05-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("dedupeDecisionComputations", () => {
  it("keeps one deterministic snapshot candidate per creative and prefers higher-risk labels", () => {
    const lowerRisk = {
      input: makeCreativeInput({
        creativeId: "creative-dup",
        campaignId: "campaign-a",
        spend: 900,
      }),
      decision: makeDecisionOutput("keep", {
        creativeId: "creative-dup",
        confidence: 90,
      }),
    };
    const higherRisk = {
      input: makeCreativeInput({
        creativeId: "creative-dup",
        campaignId: "campaign-b",
        spend: 300,
      }),
      decision: makeDecisionOutput("cut", {
        creativeId: "creative-dup",
        confidence: 70,
      }),
    };

    const result = dedupeDecisionComputations([lowerRisk, higherRisk]);

    expect(result).toHaveLength(1);
    expect(result[0]?.decision.label).toBe("cut");
    expect(result[0]?.input.campaignId).toBe("campaign-b");
  });
});

async function cleanupEngineRows() {
  const db = getDb();
  await db.query(
    `
    DELETE FROM meta_campaign_labels
    WHERE business_id = ANY($1::text[])
    `,
    [TEST_BUSINESS_IDS],
  );
  await db.query(
    `
    DELETE FROM business_engine_v3_flags
    WHERE business_id = ANY($1::uuid[])
    `,
    [TEST_BUSINESS_IDS],
  );
  await db.query(
    `
    DELETE FROM engine_v3_decision_events
    WHERE business_ref_id = ANY($1::uuid[])
      AND event_type = 'decision_changed'
      AND event_date BETWEEN $2::date AND $3::date
    `,
    [TEST_BUSINESS_IDS, PREVIOUS_AS_OF, AS_OF],
  );
  await db.query(
    `
    DELETE FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = ANY($1::uuid[])
      AND engine_version = $2
    `,
    [TEST_BUSINESS_IDS, ENGINE_VERSION],
  );
  await db.query(
    `
    DELETE FROM engine_v3_creative_lifecycle_daily
    WHERE business_ref_id = ANY($1::uuid[])
      AND engine_version = $2
    `,
    [TEST_BUSINESS_IDS, ENGINE_VERSION],
  );
  await db.query(
    `
    DELETE FROM engine_v3_account_calibration_daily
    WHERE business_ref_id = ANY($1::uuid[])
      AND engine_version = $2
    `,
    [TEST_BUSINESS_IDS, ENGINE_VERSION],
  );
  await db.query(
    `
    DELETE FROM engine_v3_job_runs
    WHERE business_ref_id = ANY($1::uuid[])
      AND engine_version = $2
      AND job_name = ANY($3::text[])
    `,
    [
      TEST_BUSINESS_IDS,
      ENGINE_VERSION,
      [JOB_NAME, LIFECYCLE_JOB_NAME, CALIBRATION_JOB_NAME],
    ],
  );
}

const FRESH_DATA_HEALTH: DataHealth = {
  calibration: {
    asOfDate: AS_OF,
    computedAt: `${AS_OF}T00:00:00.000Z`,
    sourceFreshnessHours: 1,
    staleTier: "none",
    fallbackMode: "precomputed",
    note: null,
  },
  lifecycle: {
    asOfDate: AS_OF,
    computedAt: `${AS_OF}T00:00:00.000Z`,
    sourceFreshnessHours: 1,
    staleTier: "none",
    fallbackMode: "precomputed",
    note: null,
  },
  decisions: {
    asOfDate: AS_OF,
    computedAt: `${AS_OF}T00:00:00.000Z`,
    sourceFreshnessHours: 1,
    staleTier: "none",
    fallbackMode: "precomputed",
    note: null,
  },
  worstTier: "none",
  degraded: false,
};

const READY_ACCOUNT_CALIBRATION: AccountCalibration = {
  businessId: PERSISTED_GUARD_BUSINESS_ID,
  computedAt: `${AS_OF}T00:00:00.000Z`,
  matureCreativeCount: 35,
  roasP75: 2.4,
  roasP60: 2,
  refreshRatioP10: 0.8,
  lowCtrP10: 0.7,
  accountCpaP50: 50,
  accountCpaSampleCount: 35,
  metaAttributedAovMean90d: 50,
  metaAttributedAovPurchaseCount90d: 35,
  metaAttributedRevenue90d: 1750,
  matureSpendP50: 250,
  matureSpendP75: 400,
  winnerSpendP25: 150,
  winnerSpendP50: 300,
  winnerPurchaseP50: 5,
  roasRatioP10: 0.4,
  roasRatioP25: 0.7,
  roasRatioP50: 1,
  roasRatioP75: 1.25,
  metaAovQuality: "ready",
};

const READY_FUNNEL_CALIBRATION: AccountFunnelCalibration = {
  byFormat: {
    overall: {
      creativeFormat: "overall",
      ctrP25: 0.8,
      ctrP50: 1.2,
      cpmP50: 12,
      cpmP75: 18,
      thumbstopP25: 15,
      thumbstopP50: 25,
      linkToLpvP25: 60,
      linkToLpvP50: 75,
      linkToAtcP25: 8,
      linkToAtcP50: 12,
      lpvToAtcP25: 10,
      lpvToAtcP50: 16,
      atcToIcP25: 35,
      atcToIcP50: 50,
      icToPurchaseP25: 20,
      icToPurchaseP50: 30,
      clickToPurchaseP25: 0.8,
      clickToPurchaseP50: 1.2,
      sampleSize: 35,
      qualityStatus: "ready",
    },
  },
};

function scalingCreativeInput(input: {
  businessId: string;
  campaignId: string | null;
}): CreativeInput {
  return {
    creativeId: "persisted-guard-scale-creative",
    creativeName: "Persisted Guard Scale Creative",
    businessId: input.businessId,
    campaignId: input.campaignId,
    objective: "OUTCOME_SALES",
    effectiveCohort: "purchase",
    spend: 500,
    purchases: 10,
    purchaseValue: 1500,
    impressions: 50000,
    linkClicks: 800,
    roas: 3,
    cpa: 50,
    ctr: 1.6,
    frequency: 1.5,
    recent7dSpend: 150,
    recent7dPurchases: 3,
    recent7dRoas: 3,
    recent7dImpressions: 15000,
    effectiveStatus: "ACTIVE",
    ageDays: 21,
    lastSpendAt: AS_OF,
    policyReason: null,
    dataFreshnessHours: 1,
    fatigueStatus: "none",
    targetRoas: 2,
    breakevenRoas: 1,
    lifecyclePosition: "rising",
    daysSincePeak: 1,
    peakRoas30d: 3.2,
    peakConfidence: 0.8,
    spendTrajectory30d: "rising",
    spendSlope7d: 1,
    spendSlope30d: 1,
    roasSlope7d: 0.1,
    roasSlope30d: 0.1,
    cpm: 10,
    outboundClicks: 760,
    landingPageViews: 700,
    addToCart: 120,
    initiateCheckout: 60,
    thumbstop: 30,
    video25Rate: 20,
    video50Rate: 12,
    video75Rate: 8,
    video100Rate: 4,
    qualityRanking: "average",
    engagementRateRanking: "average",
    conversionRateRanking: "average",
    creativeFormat: "video",
  };
}

function refreshCreativeInput(input: {
  businessId: string;
  campaignId: string;
}): CreativeInput {
  return {
    ...scalingCreativeInput(input),
    creativeId: "persisted-label-transform-refresh-creative",
    creativeName: "Persisted Label Transform Refresh Creative",
    spend: 600,
    purchases: 6,
    purchaseValue: 990,
    roas: 1.65,
    cpa: 100,
    recent7dSpend: 80,
    recent7dPurchases: 1,
    recent7dRoas: 1,
    fatigueStatus: "fatigued",
    linkClicks: 400,
    landingPageViews: 320,
    addToCart: 50,
    initiateCheckout: 25,
  };
}

function cuttingCreativeInput(input: {
  businessId: string;
  campaignId: string;
}): CreativeInput {
  return {
    ...scalingCreativeInput(input),
    creativeId: "persisted-authority-cut-creative",
    creativeName: "Persisted Authority Cut Creative",
    spend: 300,
    purchases: 0,
    purchaseValue: 0,
    roas: 0,
    cpa: null,
    linkClicks: 0,
    landingPageViews: 0,
    addToCart: 0,
    initiateCheckout: 0,
    ctr: 0.2,
    thumbstop: 5,
    ageDays: 14,
    recent7dSpend: 100,
    recent7dPurchases: 0,
    recent7dRoas: 0,
  };
}

function mockWarehouseForSingleCreative(creativeInput: CreativeInput) {
  vi.spyOn(
    WarehouseDataSource.prototype,
    "getBusinessTargetPack",
  ).mockResolvedValue({
    targetCpa: 50,
    targetRoas: 2,
    breakEvenCpa: 60,
    breakEvenRoas: 1,
    operatorAovAssumption: null,
    defaultRiskPosture: "balanced",
    freshness: "fresh",
    updatedAt: `${AS_OF}T00:00:00.000Z`,
  });
  vi.spyOn(
    WarehouseDataSource.prototype,
    "getDecisionCalibrationProfile",
  ).mockResolvedValue(null);
  vi.spyOn(
    WarehouseDataSource.prototype,
    "getAccountCalibration",
  ).mockResolvedValue({
    ...READY_ACCOUNT_CALIBRATION,
    businessId: creativeInput.businessId,
  });
  vi.spyOn(
    WarehouseDataSource.prototype,
    "getAccountFunnelCalibration",
  ).mockResolvedValue(READY_FUNNEL_CALIBRATION);
  vi.spyOn(
    WarehouseDataSource.prototype,
    "getMetaAttributedAov",
  ).mockResolvedValue({
    aovMean: 50,
    purchaseCount: 35,
    totalRevenue: 1750,
    windowStart: "2026-02-05",
    windowEnd: AS_OF,
  });
  vi.spyOn(WarehouseDataSource.prototype, "getDataHealth").mockResolvedValue(
    FRESH_DATA_HEALTH,
  );
  vi.spyOn(WarehouseDataSource.prototype, "listCreativeInputs").mockResolvedValue(
    [creativeInput],
  );
}

function mockWarehouseForNoCreatives(businessId: string) {
  vi.spyOn(
    WarehouseDataSource.prototype,
    "getBusinessTargetPack",
  ).mockResolvedValue({
    targetCpa: null,
    targetRoas: 2,
    breakEvenCpa: null,
    breakEvenRoas: 1,
    operatorAovAssumption: null,
    defaultRiskPosture: "balanced",
    freshness: "fresh",
    updatedAt: `${AS_OF}T00:00:00.000Z`,
  });
  vi.spyOn(
    WarehouseDataSource.prototype,
    "getDecisionCalibrationProfile",
  ).mockResolvedValue(null);
  vi.spyOn(
    WarehouseDataSource.prototype,
    "getAccountCalibration",
  ).mockResolvedValue({
    ...READY_ACCOUNT_CALIBRATION,
    businessId,
  });
  vi.spyOn(
    WarehouseDataSource.prototype,
    "getAccountFunnelCalibration",
  ).mockResolvedValue(READY_FUNNEL_CALIBRATION);
  vi.spyOn(
    WarehouseDataSource.prototype,
    "getMetaAttributedAov",
  ).mockResolvedValue({
    aovMean: 50,
    purchaseCount: 35,
    totalRevenue: 1750,
    windowStart: "2026-02-05",
    windowEnd: AS_OF,
  });
  vi.spyOn(WarehouseDataSource.prototype, "getDataHealth").mockResolvedValue(
    FRESH_DATA_HEALTH,
  );
  vi.spyOn(
    WarehouseDataSource.prototype,
    "listCreativeInputs",
  ).mockResolvedValue([]);
}

async function insertCampaignLabel(input: {
  businessId: string;
  campaignId: string;
  campaignKind: "main" | "test" | "mixed";
}) {
  await getDb().query(
    `
    INSERT INTO meta_campaign_labels (
      business_id,
      campaign_id,
      campaign_kind,
      source,
      labeled_by
    )
    VALUES (
      $1,
      $2,
      $3,
      'user',
      'decisions-job-test'
    )
    ON CONFLICT (business_id, campaign_id) DO UPDATE SET
      campaign_kind = EXCLUDED.campaign_kind,
      source = EXCLUDED.source,
      labeled_by = EXCLUDED.labeled_by,
      updated_at = now()
    `,
    [input.businessId, input.campaignId, input.campaignKind],
  );
}

async function prepareUpstream(businessId: string) {
  const calibration = await runCalibrationJob({ businessId, asOf: AS_OF });
  expect(calibration.status).toBe("success");

  const lifecycle = await runLifecycleJob({ businessId, asOf: AS_OF });
  expect(lifecycle.status).toBe("success");
  expect(lifecycle.rowsWritten).toBeGreaterThan(0);

  return { calibration, lifecycle };
}

async function countDecisionSnapshots(businessId: string) {
  const [row] = await getDb().query<CountRow>(
    `
    SELECT COUNT(*) AS count
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
      AND engine_version = $3
    `,
    [businessId, AS_OF, ENGINE_VERSION],
  );
  return toNumber(row?.count);
}

async function countDecisionEvents(businessId: string) {
  const [row] = await getDb().query<CountRow>(
    `
    SELECT COUNT(*) AS count
    FROM engine_v3_decision_events
    WHERE business_ref_id = $1::uuid
      AND event_date = $2::date
      AND event_type = 'decision_changed'
    `,
    [businessId, AS_OF],
  );
  return toNumber(row?.count);
}

async function countDecisionEventsForCreative(input: {
  businessId: string;
  creativeId: string;
}) {
  const [row] = await getDb().query<CountRow>(
    `
    SELECT COUNT(*) AS count
    FROM engine_v3_decision_events
    WHERE business_ref_id = $1::uuid
      AND creative_id = $2
      AND event_date = $3::date
      AND event_type = 'decision_changed'
    `,
    [input.businessId, input.creativeId, AS_OF],
  );
  return toNumber(row?.count);
}

async function snapshotLinkageCounts(businessId: string) {
  const [row] = await getDb().query<SnapshotLinkageCountRow>(
    `
    SELECT
      COUNT(*) FILTER (WHERE lifecycle_row_id IS NULL) AS missing_lifecycle_count,
      COUNT(*) FILTER (WHERE calibration_row_id IS NULL) AS missing_calibration_count
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
      AND engine_version = $3
    `,
    [businessId, AS_OF, ENGINE_VERSION],
  );
  return {
    missingLifecycleCount: toNumber(row?.missing_lifecycle_count),
    missingCalibrationCount: toNumber(row?.missing_calibration_count),
  };
}

async function countDecisionJobRuns(businessId: string) {
  const [row] = await getDb().query<CountRow>(
    `
    SELECT COUNT(*) AS count
    FROM engine_v3_job_runs
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
      AND engine_version = $3
      AND job_name = $4
    `,
    [businessId, AS_OF, ENGINE_VERSION, JOB_NAME],
  );
  return toNumber(row?.count);
}

async function fetchJobRun(jobRunId: string) {
  const [row] = await getDb().query<JobRunRow>(
    `
    SELECT status, row_count, dependency_run_id, error_message, error_json
    FROM engine_v3_job_runs
    WHERE id = $1::uuid
    `,
    [jobRunId],
  );
  return row;
}

async function fetchDecisionSnapshots(input: {
  businessId: string;
  limit: number;
}) {
  return getDb().query<DecisionSnapshotFixtureRow>(
    `
    SELECT
      id,
      business_id,
      creative_id,
      scope_type,
      scope_id,
      label,
      raw_label,
      pre_authority_label,
      authority_blocker,
      confidence,
      truth_source,
      effective_target_roas,
      ratio_to_target,
      badges,
      reason,
      spend,
      purchases,
      roas,
      recent7d_roas,
      label_transform,
      blocked_action_type
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
      AND engine_version = $3
    ORDER BY creative_id ASC
    LIMIT $4::integer
    `,
    [input.businessId, AS_OF, ENGINE_VERSION, input.limit],
  );
}

async function fetchDecisionSnapshotByCreative(input: {
  businessId: string;
  creativeId: string;
}) {
  const [row] = await getDb().query<DecisionSnapshotFixtureRow>(
    `
    SELECT
      id,
      business_id,
      creative_id,
      scope_type,
      scope_id,
      label,
      raw_label,
      pre_authority_label,
      authority_blocker,
      confidence,
      truth_source,
      effective_target_roas,
      ratio_to_target,
      badges,
      reason,
      spend,
      purchases,
      roas,
      recent7d_roas,
      label_transform,
      blocked_action_type
    FROM engine_v3_decision_snapshots_daily
    WHERE business_ref_id = $1::uuid
      AND creative_id = $2
      AND as_of_date = $3::date
      AND engine_version = $4
    LIMIT 1
    `,
    [input.businessId, input.creativeId, AS_OF, ENGINE_VERSION],
  );
  return row;
}

async function insertDecisionSnapshotFixture(input: {
  businessId: string;
  creativeId: string;
  label?: DecisionLabel;
}) {
  const [row] = await getDb().query<IdRow>(
    `
    INSERT INTO engine_v3_decision_snapshots_daily (
      business_ref_id,
      business_id,
      creative_id,
      as_of_date,
      engine_version,
      scope_type,
      scope_id,
      label,
      confidence,
      truth_source,
      effective_target_roas,
      ratio_to_target,
      badges,
      reason,
      spend,
      purchases,
      roas,
      recent7d_roas,
      computed_at
    )
    VALUES (
      $1::uuid,
      $2,
      $3,
      $4::date,
      $5,
      'account',
      '*',
      $6,
      50,
      'commercial_truth',
      2,
      1,
      '[]'::jsonb,
      'test stale snapshot',
      100,
      1,
      2,
      2,
      now()
    )
    RETURNING id
    `,
    [
      input.businessId,
      input.businessId,
      input.creativeId,
      AS_OF,
      ENGINE_VERSION,
      input.label ?? "diagnose",
    ],
  );
  return toString(row?.id);
}

async function insertDecisionChangedEvent(input: {
  businessId: string;
  creativeId: string;
  decisionSnapshotId: string;
}) {
  await getDb().query(
    `
    INSERT INTO engine_v3_decision_events (
      business_ref_id,
      business_id,
      creative_id,
      event_date,
      event_type,
      previous_label,
      current_label,
      previous_confidence,
      current_confidence,
      operator_evidence,
      decision_snapshot_id
    )
    VALUES (
      $1::uuid,
      $2,
      $3,
      $4::date,
      'decision_changed',
      'diagnose',
      'test_more',
      40,
      60,
      jsonb_build_object('inserted_by', 'decisions-job-test'),
      $5::uuid
    )
    `,
    [
      input.businessId,
      input.businessId,
      input.creativeId,
      AS_OF,
      input.decisionSnapshotId,
    ],
  );
}

async function insertPreviousSnapshotFromCurrent(input: {
  businessId: string;
  current: DecisionSnapshotFixtureRow;
  label: DecisionLabel;
}) {
  await getDb().query(
    `
    INSERT INTO engine_v3_decision_snapshots_daily (
      business_ref_id,
      business_id,
      creative_id,
      as_of_date,
      engine_version,
      label,
      confidence,
      truth_source,
      effective_target_roas,
      ratio_to_target,
      badges,
      reason,
      spend,
      purchases,
      roas,
      recent7d_roas,
      computed_at
    )
    VALUES (
      $1::uuid,
      $2,
      $3,
      $4::date,
      $5,
      $6,
      $7::integer,
      $8,
      $9::double precision,
      $10::double precision,
      $11::jsonb,
      $12,
      $13::double precision,
      $14::double precision,
      $15::double precision,
      $16::double precision,
      now()
    )
    `,
    [
      input.businessId,
      toString(input.current.business_id) || input.businessId,
      toString(input.current.creative_id),
      PREVIOUS_AS_OF,
      ENGINE_VERSION,
      input.label,
      toNumber(input.current.confidence),
      toString(input.current.truth_source),
      toNumber(input.current.effective_target_roas),
      input.current.ratio_to_target,
      JSON.stringify(input.current.badges ?? []),
      toString(input.current.reason),
      input.current.spend,
      input.current.purchases,
      input.current.roas,
      input.current.recent7d_roas,
    ],
  );
}

describe.skipIf(!process.env.DATABASE_URL)("decisions job", () => {
  beforeEach(async () => {
    await cleanupEngineRows();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupEngineRows();
  });

  afterAll(() => {
    resetDbClientCache();
  });

  it("inserts decision snapshots and marks the job run successful", async () => {
    const businessId = THESWAF_BUSINESS_ID;
    const { lifecycle } = await prepareUpstream(businessId);

    const result = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(result.status).toBe("success");
    expect(result.snapshotsWritten).toBeGreaterThan(0);
    expect(result.changeEventsWritten).toBe(0);
    expect(await countDecisionSnapshots(businessId)).toBe(
      result.snapshotsWritten,
    );

    const jobRun = await fetchJobRun(result.jobRunId);
    expect(jobRun?.status).toBe("success");
    expect(toNumber(jobRun?.row_count)).toBe(result.snapshotsWritten);
    expect(jobRun?.dependency_run_id).toBe(lifecycle.jobRunId);
    expect(changeEventCountMetadata(jobRun?.error_json)).toBe(0);

    const linkage = await snapshotLinkageCounts(businessId);
    expect(linkage.missingLifecycleCount).toBe(0);
    expect(linkage.missingCalibrationCount).toBe(0);

    const [snapshot] = await fetchDecisionSnapshots({ businessId, limit: 1 });
    expect(snapshot?.scope_type).toBe("account");
    expect(snapshot?.scope_id).toBe("*");
    expect(toDecisionLabel(snapshot?.pre_authority_label)).toBeTruthy();
  });

  it("is idempotent for snapshots while recording each invocation", async () => {
    const businessId = IWASTORE_BUSINESS_ID;
    await prepareUpstream(businessId);

    const first = await runDecisionsJob({ businessId, asOf: AS_OF });
    const second = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(await countDecisionSnapshots(businessId)).toBe(
      second.snapshotsWritten,
    );
    expect(await countDecisionEvents(businessId)).toBe(0);
    expect(await countDecisionJobRuns(businessId)).toBe(2);
  });

  it("prunes stale current-day snapshots that are absent from the current payload", async () => {
    const businessId = IWASTORE_BUSINESS_ID;
    const staleCreativeId = "stale-current-day-decision-creative";
    await prepareUpstream(businessId);

    const first = await runDecisionsJob({ businessId, asOf: AS_OF });
    expect(first.status).toBe("success");
    expect(first.snapshotsWritten).toBeGreaterThan(0);

    await insertDecisionSnapshotFixture({
      businessId,
      creativeId: staleCreativeId,
    });
    expect(await countDecisionSnapshots(businessId)).toBe(
      first.snapshotsWritten + 1,
    );

    const second = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(second.status).toBe("success");
    expect(second.snapshotsWritten).toBe(first.snapshotsWritten);
    expect(await countDecisionSnapshots(businessId)).toBe(
      second.snapshotsWritten,
    );
    await expect(
      fetchDecisionSnapshotByCreative({
        businessId,
        creativeId: staleCreativeId,
      }),
    ).resolves.toBeUndefined();

    const jobRun = await fetchJobRun(second.jobRunId);
    expect(jobRunMetadata(jobRun?.error_json)).toMatchObject({
      pruned_snapshot_count: 1,
      pruned_event_count: 0,
    });
    expect(jobRunMetadata(jobRun?.error_json)).not.toHaveProperty(
      "prune_skipped_empty_payload",
    );
  });

  it("does not prune when the current payload is empty", async () => {
    const businessId = PERSISTED_GUARD_BUSINESS_ID;
    const staleCreativeId = "empty-payload-preserved-creative";
    await insertDecisionSnapshotFixture({
      businessId,
      creativeId: staleCreativeId,
    });
    mockWarehouseForNoCreatives(businessId);

    const result = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(result.status).toBe("success");
    expect(result.snapshotsWritten).toBe(0);
    await expect(
      fetchDecisionSnapshotByCreative({
        businessId,
        creativeId: staleCreativeId,
      }),
    ).resolves.toBeDefined();

    const jobRun = await fetchJobRun(result.jobRunId);
    expect(jobRunMetadata(jobRun?.error_json)).toMatchObject({
      pruned_snapshot_count: 0,
      pruned_event_count: 0,
      prune_skipped_empty_payload: true,
    });
  });

  it("prunes same-day decision change events for stale snapshots only", async () => {
    const businessId = THESWAF_BUSINESS_ID;
    const staleCreativeId = "stale-event-pruned-creative";
    await prepareUpstream(businessId);

    const initial = await runDecisionsJob({ businessId, asOf: AS_OF });
    expect(initial.status).toBe("success");
    const [currentSnapshot] = await fetchDecisionSnapshots({
      businessId,
      limit: 1,
    });
    expect(currentSnapshot).toBeDefined();
    const currentCreativeId = toString(currentSnapshot!.creative_id);

    const staleSnapshotId = await insertDecisionSnapshotFixture({
      businessId,
      creativeId: staleCreativeId,
    });
    await insertDecisionChangedEvent({
      businessId,
      creativeId: staleCreativeId,
      decisionSnapshotId: staleSnapshotId,
    });
    await insertDecisionChangedEvent({
      businessId,
      creativeId: currentCreativeId,
      decisionSnapshotId: toString(currentSnapshot!.id),
    });
    expect(
      await countDecisionEventsForCreative({
        businessId,
        creativeId: staleCreativeId,
      }),
    ).toBe(1);
    expect(
      await countDecisionEventsForCreative({
        businessId,
        creativeId: currentCreativeId,
      }),
    ).toBe(1);

    const result = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(result.status).toBe("success");
    expect(
      await countDecisionEventsForCreative({
        businessId,
        creativeId: staleCreativeId,
      }),
    ).toBe(0);
    expect(
      await countDecisionEventsForCreative({
        businessId,
        creativeId: currentCreativeId,
      }),
    ).toBe(1);

    const jobRun = await fetchJobRun(result.jobRunId);
    expect(jobRunMetadata(jobRun?.error_json)).toMatchObject({
      pruned_snapshot_count: 1,
      pruned_event_count: 1,
    });
    expect(jobRunMetadata(jobRun?.error_json)).not.toHaveProperty(
      "prune_skipped_empty_payload",
    );
  });

  it("records skipped when the advisory lock is already held", async () => {
    const businessId = THESWAF_BUSINESS_ID;
    await prepareUpstream(businessId);

    const lockKey = decisionsJobAdvisoryLockKey({ businessId, asOf: AS_OF });
    let releaseLock: () => void = () => undefined;
    let holder: Promise<void> | null = null;
    const locked = new Promise<void>((resolve, reject) => {
      holder = runDbTransaction(async () => {
        await getDb().query("SELECT pg_advisory_xact_lock($1::bigint)", [
          lockKey.toString(),
        ]);
        resolve();
        await new Promise<void>((release) => {
          releaseLock = release;
        });
      }).catch(reject);
    });

    await locked;
    let result: Awaited<ReturnType<typeof runDecisionsJob>> | null = null;
    try {
      result = await runDecisionsJob({ businessId, asOf: AS_OF });
    } finally {
      releaseLock();
      await holder;
    }

    expect(result).not.toBeNull();
    expect(result!.status).toBe("skipped");
    expect(result!.snapshotsWritten).toBe(0);
    expect(result!.changeEventsWritten).toBe(0);

    const jobRun = await fetchJobRun(result!.jobRunId);
    expect(jobRun?.status).toBe("skipped");
    expect(toNumber(jobRun?.row_count)).toBe(0);
  });

  it("returns skipped and writes no snapshots when engine v3 is disabled for the business", async () => {
    const businessId = THESWAF_BUSINESS_ID;
    await getDb().query(
      `
      INSERT INTO business_engine_v3_flags (
        business_id,
        enabled,
        surface_visible,
        shadow_only,
        notes,
        updated_by
      )
      VALUES ($1::uuid, false, NULL, NULL, 'disabled in test', 'vitest')
      ON CONFLICT (business_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        surface_visible = EXCLUDED.surface_visible,
        shadow_only = EXCLUDED.shadow_only,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
      `,
      [businessId],
    );

    const result = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "engine_v3_disabled",
      snapshotsWritten: 0,
      changeEventsWritten: 0,
    });
    expect(result.jobRunId).not.toBe("");
    const jobRun = await fetchJobRun(result.jobRunId);
    expect(jobRun?.status).toBe("skipped");
    expect(toNumber(jobRun?.row_count)).toBe(0);
    expect(jobRun?.error_message).toBe("engine_v3_disabled");
    expect(await countDecisionSnapshots(businessId)).toBe(0);
  });

  it("persists unresolved automatic campaign context before hard-label hysteresis", async () => {
    const businessId = PERSISTED_GUARD_BUSINESS_ID;
    const creativeInput = scalingCreativeInput({
      businessId,
      campaignId: "persisted-guard-unlabeled-campaign",
    });
    mockWarehouseForSingleCreative(creativeInput);

    const result = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(result.status).toBe("success");
    expect(result.snapshotsWritten).toBe(1);

    const [snapshot] = await fetchDecisionSnapshots({ businessId, limit: 1 });
    expect(snapshot?.creative_id).toBe(creativeInput.creativeId);
    expect(snapshot?.label).toBe("keep");
    expect(snapshot?.raw_label).toBe("scale");
    expect(snapshot?.pre_authority_label).toBe("scale");
    expect(snapshot?.authority_blocker).toBe("campaign_context");
    expect(snapshot?.blocked_action_type).toBe("scale");
    expect(toNumber(snapshot?.confidence)).toBeLessThanOrEqual(50);
    expect(snapshot?.reason).toContain("[Pending hard action: scale]");
    expect(snapshot?.reason).toContain("[Campaign context unresolved");
    expect(snapshot?.badges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "campaign_context_unresolved" }),
        expect.objectContaining({ type: "pending_transition" }),
      ]),
    );
    expect(snapshot?.label_transform).toBeNull();
  });

  it("persists the campaign-label guard output for no-campaign hard decisions", async () => {
    const businessId = PERSISTED_NO_CAMPAIGN_GUARD_BUSINESS_ID;
    const creativeInput = scalingCreativeInput({
      businessId,
      campaignId: null,
    });
    mockWarehouseForSingleCreative(creativeInput);

    const result = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(result.status).toBe("success");
    expect(result.snapshotsWritten).toBe(1);

    const [snapshot] = await fetchDecisionSnapshots({ businessId, limit: 1 });
    expect(snapshot?.creative_id).toBe(creativeInput.creativeId);
    expect(snapshot?.label).toBe("diagnose");
    expect(snapshot?.raw_label).toBe("diagnose");
    expect(snapshot?.pre_authority_label).toBe("scale");
    expect(snapshot?.authority_blocker).toBe("campaign_context");
    expect(snapshot?.blocked_action_type).toBe("scale");
    expect(toNumber(snapshot?.confidence)).toBeLessThanOrEqual(50);
    expect(snapshot?.reason).toContain(
      "[Unlabeled campaign - label to enable action]",
    );
    expect(snapshot?.badges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "unlabeled_campaign_context" }),
      ]),
    );
    expect(snapshot?.label_transform).toBeNull();
  });

  it("persists Test cohort refresh-to-cut provenance before hard-label hysteresis", async () => {
    const businessId = LABEL_TRANSFORM_BUSINESS_ID;
    const campaignId = "persisted-label-transform-test-campaign";
    const creativeInput = refreshCreativeInput({ businessId, campaignId });
    mockWarehouseForSingleCreative(creativeInput);
    await insertCampaignLabel({
      businessId,
      campaignId,
      campaignKind: "test",
    });

    const result = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(result.status).toBe("success");
    expect(result.snapshotsWritten).toBe(1);

    const [snapshot] = await fetchDecisionSnapshots({ businessId, limit: 1 });
    expect(snapshot?.creative_id).toBe(creativeInput.creativeId);
    expect(snapshot?.label).toBe("keep");
    expect(snapshot?.raw_label).toBe("cut");
    expect(snapshot?.pre_authority_label).toBe("cut");
    expect(snapshot?.authority_blocker).toBeNull();
    expect(snapshot?.blocked_action_type).toBe("cut");
    expect(snapshot?.label_transform).toBe("test_cohort_refresh_to_cut");
    expect(snapshot?.reason).toContain("[Pending hard action: cut]");
    expect(snapshot?.reason).toContain("[test_cohort: refresh->cut]");
  });

  it("does not turn pre-authority cut evidence into published pause authority", async () => {
    const businessId = PERSISTED_GUARD_BUSINESS_ID;
    const creativeInput = cuttingCreativeInput({
      businessId,
      campaignId: "persisted-authority-unlabeled-cut-campaign",
    });
    mockWarehouseForSingleCreative(creativeInput);

    const result = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(result.status).toBe("success");
    expect(result.snapshotsWritten).toBe(1);

    const [snapshot] = await fetchDecisionSnapshots({ businessId, limit: 1 });
    expect(snapshot?.pre_authority_label).toBe("cut");
    expect(snapshot?.authority_blocker).toBe("campaign_context");
    expect(snapshot?.blocked_action_type).toBe("cut");
    expect(snapshot?.raw_label).toBe("cut");
    expect(snapshot?.label).toBe("keep");
    expect(snapshot?.label).not.toBe("cut");
  });

  it("writes a change event only when the prior snapshot label differs", async () => {
    const businessId = THESWAF_BUSINESS_ID;
    await prepareUpstream(businessId);
    const initial = await runDecisionsJob({ businessId, asOf: AS_OF });
    expect(initial.status).toBe("success");

    const snapshots = await fetchDecisionSnapshots({ businessId, limit: 2 });
    expect(snapshots.length).toBe(2);

    const changedSnapshot = snapshots[0]!;
    const unchangedSnapshot = snapshots[1]!;
    const changedCreativeId = toString(changedSnapshot.creative_id);
    const unchangedCreativeId = toString(unchangedSnapshot.creative_id);
    const changedCurrentLabel = toDecisionLabel(changedSnapshot.label);
    const changedPreviousLabel = alternateLabel(changedCurrentLabel);
    const unchangedLabel = toDecisionLabel(unchangedSnapshot.label);

    await insertPreviousSnapshotFromCurrent({
      businessId,
      current: changedSnapshot,
      label: changedPreviousLabel,
    });
    await insertPreviousSnapshotFromCurrent({
      businessId,
      current: unchangedSnapshot,
      label: unchangedLabel,
    });

    const second = await runDecisionsJob({ businessId, asOf: AS_OF });
    const third = await runDecisionsJob({ businessId, asOf: AS_OF });

    expect(second.status).toBe("success");
    expect(second.changeEventsWritten).toBe(1);
    expect(third.status).toBe("success");
    expect(third.changeEventsWritten).toBe(0);

    const events = await getDb().query<DecisionEventRow>(
      `
      SELECT creative_id, previous_label, current_label, operator_evidence
      FROM engine_v3_decision_events
      WHERE business_ref_id = $1::uuid
        AND event_date = $2::date
        AND event_type = 'decision_changed'
      ORDER BY creative_id ASC
      `,
      [businessId, AS_OF],
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.creative_id).toBe(changedCreativeId);
    expect(events[0]?.creative_id).not.toBe(unchangedCreativeId);
    expect(events[0]?.previous_label).toBe(changedPreviousLabel);
    expect(events[0]?.current_label).toBe(changedCurrentLabel);
    expect(events[0]?.operator_evidence).toMatchObject({
      previous_decision_snapshot_id: expect.any(String),
      current_decision_snapshot_id: expect.any(String),
    });
  });

  it("marks a running job as failed when decision computation errors", async () => {
    const error = new Error("simulated decisions failure");
    vi.spyOn(
      WarehouseDataSource.prototype,
      "getAccountCalibration",
    ).mockRejectedValueOnce(error);

    const result = await runDecisionsJob({
      businessId: FAILURE_BUSINESS_ID,
      asOf: AS_OF,
    });

    expect(result).toMatchObject({
      status: "failed",
      snapshotsWritten: 0,
      changeEventsWritten: 0,
      errorMessage: "simulated decisions failure",
    });

    const jobRun = await fetchJobRun(result.jobRunId);
    expect(jobRun?.status).toBe("failed");
    expect(toNumber(jobRun?.row_count)).toBe(0);
    expect(jobRun?.error_message).toBe("simulated decisions failure");
  });

  it("records a failed job run when the business id does not exist", async () => {
    const result = await runDecisionsJob({
      businessId: UNKNOWN_BUSINESS_ID,
      asOf: AS_OF,
    });

    expect(result).toMatchObject({
      status: "failed",
      snapshotsWritten: 0,
      changeEventsWritten: 0,
      reason: "business_not_found",
      errorMessage: `Business not found: ${UNKNOWN_BUSINESS_ID}`,
    });

    const jobRun = await fetchJobRun(result.jobRunId);
    expect(jobRun?.status).toBe("failed");
    expect(toNumber(jobRun?.row_count)).toBe(0);
    expect(jobRun?.error_message).toBe(
      `Business not found: ${UNKNOWN_BUSINESS_ID}`,
    );
  });
});
