import type { MetaBreakdownsResponse } from "@/app/api/meta/breakdowns/route";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";
import { getMetaAdSetsForRange } from "@/lib/meta/adsets-source";
import { getMetaBreakdownsForRange } from "@/lib/meta/breakdowns-source";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import { readMetaBidRegimeHistorySummaries } from "@/lib/meta/config-snapshots";
import { META_WAREHOUSE_HISTORY_DAYS } from "@/lib/meta/history";
import {
  getMetaCalibrationScope,
  runMetaCalibrationForBusiness,
  type RunMetaCalibrationResult,
} from "@/lib/meta/calibration";
import { buildMetaAdsetRecommendations } from "@/lib/meta/adset-decisions";
import {
  buildMetaRecommendations,
  META_RECOMMENDATION_ENGINE_VERSION,
  type MetaCalibrationContext,
  type MetaDecisionSummary,
  type MetaRecommendation,
  type MetaRecommendationConfidence,
  type MetaRecommendationLevel,
  type MetaRecommendationLens,
  type MetaRecommendationPriority,
  type MetaRecommendationsResponse,
} from "@/lib/meta/recommendations";

export interface RunMetaSnapshotResult {
  businessId: string;
  snapshotDate: string;
  calibration: RunMetaCalibrationResult;
  recommendationsWritten: number;
}

export interface RunMetaSnapshotAllBusinessesResult {
  snapshotDate: string;
  businessCount: number;
  results: Array<{
    businessId: string;
    status: "fulfilled" | "rejected";
    value?: RunMetaSnapshotResult;
    reason?: string;
  }>;
}

type SnapshotDbRow = {
  scope_type: "account" | "campaign" | "adset";
  scope_id: string;
  business_id: string;
  snapshot_date: string;
  rec_id: string;
  rec_type: string;
  level: MetaRecommendationLevel;
  decision_state: MetaRecommendation["decisionState"];
  confidence_score: unknown;
  evidence: unknown;
  recommended_action: string;
  target_value: unknown;
  expected_impact: string | null;
  reasoning: string;
  predictive_overlay: string | null;
  engine_version: string;
  created_at: string;
};

interface SnapshotPayloadRow {
  scope_type: "account" | "campaign" | "adset";
  scope_id: string;
  business_id: string;
  snapshot_date: string;
  rec_id: string;
  rec_type: string;
  level: MetaRecommendationLevel;
  decision_state: MetaRecommendation["decisionState"];
  confidence_score: number;
  evidence: unknown;
  recommended_action: string;
  target_value: unknown;
  expected_impact: string | null;
  reasoning: string;
  predictive_overlay: string | null;
  engine_version: string;
}

function parseISODate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDaysToISO(value: string, days: number): string {
  const date = parseISODate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeDate(value: string | Date | null | undefined) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function dayDiffInclusive(startDate: string, endDate: string): number {
  const start = parseISODate(startDate).getTime();
  const end = parseISODate(endDate).getTime();
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
}

function confidenceLabel(score: number): MetaRecommendationConfidence {
  if (score >= 0.7) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

function scopeForRecommendation(recommendation: MetaRecommendation, businessId: string) {
  if (recommendation.level === "adset" && recommendation.adsetId) {
    return { scopeType: "adset" as const, scopeId: recommendation.adsetId };
  }
  if (recommendation.level === "campaign" && recommendation.campaignId) {
    return { scopeType: "campaign" as const, scopeId: recommendation.campaignId };
  }
  return { scopeType: "account" as const, scopeId: businessId };
}

function snapshotEvidencePayload(recommendation: MetaRecommendation) {
  return {
    items: recommendation.evidence,
    recommendation,
  };
}

function recommendationToSnapshotRow(
  recommendation: MetaRecommendation,
  businessId: string,
  snapshotDate: string,
): SnapshotPayloadRow {
  const scope = scopeForRecommendation(recommendation, businessId);
  return {
    scope_type: scope.scopeType,
    scope_id: scope.scopeId,
    business_id: businessId,
    snapshot_date: snapshotDate,
    rec_id: recommendation.id,
    rec_type: recommendation.type,
    level: recommendation.level,
    decision_state: recommendation.decisionState,
    confidence_score: recommendation.confidenceScore ?? 0.4,
    evidence: snapshotEvidencePayload(recommendation),
    recommended_action: recommendation.recommendedAction,
    target_value: recommendation.targetValue ?? null,
    expected_impact: recommendation.expectedImpact ?? null,
    reasoning: recommendation.why,
    predictive_overlay:
      recommendation.predictiveOverlay ??
      recommendation.timeframeContext?.selectedRangeOverlay ??
      null,
    engine_version:
      recommendation.engineVersion ?? META_RECOMMENDATION_ENGINE_VERSION,
  };
}

async function upsertSnapshotRows(input: {
  businessId: string;
  snapshotDate: string;
  rows: SnapshotPayloadRow[];
}) {
  const sql = getDb();
  await sql`
    DELETE FROM meta_decision_snapshots_daily
    WHERE business_id = ${input.businessId}
      AND snapshot_date = ${input.snapshotDate}::date
  `;
  if (input.rows.length === 0) return;

  await sql.query(
    `
      WITH payload AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS row(
          scope_type text,
          scope_id text,
          business_id text,
          snapshot_date date,
          rec_id text,
          rec_type text,
          level text,
          decision_state text,
          confidence_score numeric,
          evidence jsonb,
          recommended_action text,
          target_value jsonb,
          expected_impact text,
          reasoning text,
          predictive_overlay text,
          engine_version text
        )
      )
      INSERT INTO meta_decision_snapshots_daily (
        scope_type,
        scope_id,
        business_id,
        snapshot_date,
        rec_id,
        rec_type,
        level,
        decision_state,
        confidence_score,
        evidence,
        recommended_action,
        target_value,
        expected_impact,
        reasoning,
        predictive_overlay,
        engine_version
      )
      SELECT
        scope_type,
        scope_id,
        business_id,
        snapshot_date,
        rec_id,
        rec_type,
        level,
        decision_state,
        confidence_score,
        evidence,
        recommended_action,
        target_value,
        expected_impact,
        reasoning,
        predictive_overlay,
        engine_version
      FROM payload
      ON CONFLICT (scope_type, scope_id, snapshot_date, rec_type)
      DO UPDATE SET
        business_id = EXCLUDED.business_id,
        rec_id = EXCLUDED.rec_id,
        level = EXCLUDED.level,
        decision_state = EXCLUDED.decision_state,
        confidence_score = EXCLUDED.confidence_score,
        evidence = EXCLUDED.evidence,
        recommended_action = EXCLUDED.recommended_action,
        target_value = EXCLUDED.target_value,
        expected_impact = EXCLUDED.expected_impact,
        reasoning = EXCLUDED.reasoning,
        predictive_overlay = EXCLUDED.predictive_overlay,
        engine_version = EXCLUDED.engine_version,
        created_at = now()
    `,
    [JSON.stringify(input.rows)],
  );
}

async function buildCalibrationContexts(input: {
  businessId: string;
  snapshotDate: string;
  campaigns: MetaCampaignRow[];
}) {
  const byCampaignId: Record<string, MetaCalibrationContext> = {};
  for (const campaign of input.campaigns) {
    const scope = await getMetaCalibrationScope(input.businessId, {
      campaignId: campaign.id,
      accountId: campaign.accountId,
      snapshotDate: input.snapshotDate,
    });
    byCampaignId[campaign.id] = {
      thresholds: scope.thresholds,
      scope: scope.scope,
      reason: scope.reason,
    };
  }
  const firstCampaign = input.campaigns[0];
  const accountContext = firstCampaign
    ? byCampaignId[firstCampaign.id] ?? null
    : null;
  return { accountContext, byCampaignId };
}

async function buildSnapshotRecommendations(input: {
  businessId: string;
  snapshotDate: string;
}): Promise<MetaRecommendation[]> {
  const endDate = normalizeDate(input.snapshotDate);
  const startDate = addDaysToISO(endDate, -29);
  const selectedSpanDays = dayDiffInclusive(startDate, endDate);
  const previousEnd = addDaysToISO(startDate, -1);
  const previousStart = addDaysToISO(previousEnd, -(selectedSpanDays - 1));
  const last3Start = addDaysToISO(endDate, -2);
  const last7Start = addDaysToISO(endDate, -6);
  const last14Start = addDaysToISO(endDate, -13);
  const last30Start = addDaysToISO(endDate, -29);
  const last90Start = addDaysToISO(endDate, -89);
  const allHistoryStart = addDaysToISO(endDate, -(META_WAREHOUSE_HISTORY_DAYS - 1));

  const [
    selectedCampaigns,
    previousSelectedCampaigns,
    last3Campaigns,
    last7Campaigns,
    last14Campaigns,
    last30Campaigns,
    last90Campaigns,
    allHistoryCampaigns,
    breakdowns,
  ] = await Promise.all([
    getMetaCampaignsForRange({
      businessId: input.businessId,
      startDate,
      endDate,
      includePrev: true,
    }),
    getMetaCampaignsForRange({
      businessId: input.businessId,
      startDate: previousStart,
      endDate: previousEnd,
    }),
    getMetaCampaignsForRange({
      businessId: input.businessId,
      startDate: last3Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      businessId: input.businessId,
      startDate: last7Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      businessId: input.businessId,
      startDate: last14Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      businessId: input.businessId,
      startDate: last30Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      businessId: input.businessId,
      startDate: last90Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      businessId: input.businessId,
      startDate: allHistoryStart,
      endDate,
    }),
    getMetaBreakdownsForRange({ businessId: input.businessId, startDate, endDate }),
  ]);

  const campaigns = selectedCampaigns.rows ?? [];
  const contexts = await buildCalibrationContexts({
    businessId: input.businessId,
    snapshotDate: endDate,
    campaigns,
  });
  const historicalBidRegimes = Object.fromEntries(
    (
      await readMetaBidRegimeHistorySummaries({
        businessId: input.businessId,
        entityLevel: "campaign",
        entityIds: campaigns.map((row) => row.id),
      })
    ).entries(),
  );

  const campaignRecommendations = buildMetaRecommendations({
    windows: {
      selected: campaigns,
      previousSelected: previousSelectedCampaigns.rows ?? [],
      last3: last3Campaigns.rows ?? [],
      last7: last7Campaigns.rows ?? [],
      last14: last14Campaigns.rows ?? [],
      last30: last30Campaigns.rows ?? [],
      last90: last90Campaigns.rows ?? [],
      allHistory: allHistoryCampaigns.rows ?? [],
    },
    breakdowns: breakdowns as MetaBreakdownsResponse,
    historicalBidRegimes,
    calibrationContext: contexts.accountContext,
    calibrationContextByCampaignId: contexts.byCampaignId,
    language: "en",
  }).recommendations;

  const adsetRows = await getMetaAdSetsForRange({
    businessId: input.businessId,
    startDate,
    endDate,
    campaignIds: campaigns.map((campaign) => campaign.id),
  });
  const adsetRecommendations = buildMetaAdsetRecommendations({
    adsets: adsetRows.rows ?? [],
    campaigns,
    calibrationContext: contexts.accountContext,
    calibrationContextByCampaignId: contexts.byCampaignId,
  });

  return [...campaignRecommendations, ...adsetRecommendations];
}

export async function runMetaSnapshotForBusiness(
  businessId: string,
  snapshotDate: string,
): Promise<RunMetaSnapshotResult> {
  const normalizedSnapshotDate = normalizeDate(snapshotDate);
  const calibration = await runMetaCalibrationForBusiness(
    businessId,
    normalizedSnapshotDate,
  );
  const recommendations = await buildSnapshotRecommendations({
    businessId,
    snapshotDate: normalizedSnapshotDate,
  });
  const rows = recommendations.map((recommendation) =>
    recommendationToSnapshotRow(recommendation, businessId, normalizedSnapshotDate),
  );
  await upsertSnapshotRows({
    businessId,
    snapshotDate: normalizedSnapshotDate,
    rows,
  });
  return {
    businessId,
    snapshotDate: normalizedSnapshotDate,
    calibration,
    recommendationsWritten: rows.length,
  };
}

export async function runMetaSnapshotForAllBusinesses(
  snapshotDate: string,
): Promise<RunMetaSnapshotAllBusinessesResult> {
  const normalizedSnapshotDate = normalizeDate(snapshotDate);
  const businesses = await getActiveBusinesses();
  const settled = await Promise.allSettled(
    businesses.map((business) =>
      runMetaSnapshotForBusiness(business.id, normalizedSnapshotDate),
    ),
  );
  return {
    snapshotDate: normalizedSnapshotDate,
    businessCount: businesses.length,
    results: settled.map((result, index) => {
      const businessId = businesses[index]?.id ?? "unknown";
      if (result.status === "fulfilled") {
        return {
          businessId,
          status: "fulfilled" as const,
          value: result.value,
        };
      }
      return {
        businessId,
        status: "rejected" as const,
        reason:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      };
    }),
  };
}

function decisionWeight(state: MetaRecommendation["decisionState"]) {
  if (state === "act") return 30;
  if (state === "test") return 20;
  return 10;
}

function priorityFromScore(score: number): MetaRecommendationPriority {
  if (score >= 0.7) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

function lensFromLevel(level: MetaRecommendationLevel): MetaRecommendationLens {
  return level === "account" ? "structure" : "profitability";
}

function fallbackTimeframeContext(row: SnapshotDbRow): MetaRecommendation["timeframeContext"] {
  return {
    coreVerdict: row.reasoning,
    selectedRangeOverlay:
      row.predictive_overlay ?? "Persisted daily Meta decision snapshot.",
    historicalSupport:
      row.engine_version === META_RECOMMENDATION_ENGINE_VERSION
        ? "Generated by calibrated Meta snapshot engine."
        : "Generated by persisted Meta snapshot engine.",
    seasonalityFlag: "none",
    note: null,
  };
}

function evidenceItems(value: unknown): MetaRecommendation["evidence"] {
  if (Array.isArray(value)) return value as MetaRecommendation["evidence"];
  if (value && typeof value === "object") {
    const items = (value as { items?: unknown }).items;
    if (Array.isArray(items)) return items as MetaRecommendation["evidence"];
  }
  return [];
}

function storedRecommendation(value: unknown): MetaRecommendation | null {
  if (!value || typeof value !== "object") return null;
  const recommendation = (value as { recommendation?: unknown }).recommendation;
  if (!recommendation || typeof recommendation !== "object") return null;
  return recommendation as MetaRecommendation;
}

function hydrateRecommendation(row: SnapshotDbRow): MetaRecommendation {
  const score = Number(row.confidence_score ?? 0.4);
  const stored = storedRecommendation(row.evidence);
  if (stored) {
    return {
      ...stored,
      id: row.rec_id,
      type: row.rec_type as MetaRecommendation["type"],
      level: row.level,
      decisionState: row.decision_state,
      confidenceScore: score,
      confidence: confidenceLabel(score),
      evidence: evidenceItems(row.evidence),
      recommendedAction: row.recommended_action,
      expectedImpact: row.expected_impact ?? stored.expectedImpact,
      why: row.reasoning,
      predictiveOverlay: row.predictive_overlay ?? stored.predictiveOverlay ?? null,
      engineVersion: row.engine_version,
    };
  }

  return {
    id: row.rec_id,
    level: row.level,
    ...(row.level === "campaign" ? { campaignId: row.scope_id } : {}),
    ...(row.level === "adset" ? { adsetId: row.scope_id } : {}),
    type: row.rec_type as MetaRecommendation["type"],
    lens: lensFromLevel(row.level),
    priority: priorityFromScore(score),
    confidence: confidenceLabel(score),
    confidenceScore: score,
    confidenceReason: null,
    decisionState: row.decision_state,
    decision: row.recommended_action,
    title: row.recommended_action,
    why: row.reasoning,
    summary: row.reasoning,
    recommendedAction: row.recommended_action,
    expectedImpact: row.expected_impact ?? "",
    evidence: evidenceItems(row.evidence),
    timeframeContext: fallbackTimeframeContext(row),
    targetValue: row.target_value,
    predictiveOverlay: row.predictive_overlay,
    engineVersion: row.engine_version,
  };
}

function buildSnapshotSummary(recommendations: MetaRecommendation[]): MetaDecisionSummary {
  if (recommendations.length === 0) {
    return {
      title: "No persisted Meta recommendation snapshot",
      summary: "No daily Meta decision snapshot rows were found for the selected range.",
      primaryLens: "structure",
      confidence: "low",
      recommendationCount: 0,
    };
  }
  const sorted = [...recommendations].sort(
    (left, right) =>
      decisionWeight(right.decisionState) - decisionWeight(left.decisionState) ||
      (right.confidenceScore ?? 0) - (left.confidenceScore ?? 0),
  );
  const top = sorted[0]!;
  const actCount = sorted.filter((item) => item.decisionState === "act").length;
  return {
    title:
      top.decisionState === "act"
        ? "Highest-priority Meta action"
        : "Meta watchlist and tests",
    summary:
      actCount > 0
        ? `${actCount} persisted recommendation${actCount === 1 ? "" : "s"} are strong enough to act on now. Highest priority: ${top.title}.`
        : `No persisted act-now recommendation yet. Strongest current signal: ${top.title}.`,
    primaryLens: top.lens,
    confidence: top.confidence,
    recommendationCount: sorted.length,
    operatingMode: "Calibrated snapshot mode",
    currentRegime: null,
    recommendedMode: null,
  };
}

export async function readMetaDecisionSnapshotForRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<MetaRecommendationsResponse | null> {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_decision_snapshots_daily"],
  }).catch(() => null);
  if (!readiness?.ready) return null;

  const sql = getDb();
  const rows = (await sql`
    WITH latest AS (
      SELECT MAX(snapshot_date) AS snapshot_date
      FROM meta_decision_snapshots_daily
      WHERE business_id = ${input.businessId}
        AND snapshot_date BETWEEN ${normalizeDate(input.startDate)}::date AND ${normalizeDate(input.endDate)}::date
    )
    SELECT
      scope_type,
      scope_id,
      business_id,
      snapshot_date::text AS snapshot_date,
      rec_id,
      rec_type,
      level,
      decision_state,
      confidence_score,
      evidence,
      recommended_action,
      target_value,
      expected_impact,
      reasoning,
      predictive_overlay,
      engine_version,
      created_at::text AS created_at
    FROM meta_decision_snapshots_daily
    WHERE business_id = ${input.businessId}
      AND snapshot_date = (SELECT snapshot_date FROM latest)
    ORDER BY
      CASE decision_state
        WHEN 'act' THEN 3
        WHEN 'test' THEN 2
        ELSE 1
      END DESC,
      confidence_score DESC,
      rec_type ASC
  `) as SnapshotDbRow[];

  if (rows.length === 0) return null;
  const recommendations = rows.map(hydrateRecommendation);
  return {
    status: "ok",
    businessId: input.businessId,
    startDate: normalizeDate(input.startDate),
    endDate: normalizeDate(input.endDate),
    summary: buildSnapshotSummary(recommendations),
    recommendations,
    sourceModel: "snapshot_persistent",
    analysisSource: {
      system: "snapshot_persistent",
      decisionOsAvailable: false,
      fallbackReason: "legacy_decision_os_archived_phase_4_1",
    },
  };
}
