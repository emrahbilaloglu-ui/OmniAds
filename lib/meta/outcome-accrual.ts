// Auto-labeled KPI outcomes for Meta v1 act recommendations.
//
// meta_decision_action_outcome_logs and its read-side (empirical outcome
// summaries -> automation readiness) existed with ZERO production writers:
// action_type='outcome' rows were never produced, so the whole outcome loop
// was dead plumbing and the 0.7/0.55 confidence thresholds had no evidence
// stream to be validated against. This module is the writer.
//
// Labeling rule auto_kpi_7d.v1 - honest limits, stated up front:
// - CORRELATIONAL, not causal: it measures whether the scope's KPI moved
//   after the engine said "act", regardless of whether the operator acted.
//   The operator's response is recorded alongside (operatorActed) so
//   downstream analysis can stratify.
// - Windows: 7 full days before (snapshot_date-6 .. snapshot_date) vs
//   7 full days after (snapshot_date+1 .. snapshot_date+7), so accrual for
//   a snapshot runs only after day +7 has fully closed (snapshot_date+8).
// - Bands: ROAS +-5% with a $50-per-window spend floor; below the floor
//   the outcome is 'inconclusive' (neutral bucket downstream). Raw deltas
//   ride in payload_json so the bands can be recalibrated without losing
//   history.
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { appendMetaDecisionActionOutcomeLog } from "@/lib/meta/decision-outcomes";
import { META_RECOMMENDATION_ENGINE_VERSION } from "@/lib/meta/recommendations";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";

export const META_OUTCOME_ACCRUAL_RULE = "auto_kpi_7d.v1";
export const META_OUTCOME_MIN_WINDOW_SPEND = 50;
const IMPROVED_RATIO = 1.05;
const REGRESSED_RATIO = 0.95;
const ACCRUAL_LAG_DAYS = 8;

export type MetaKpiOutcomeStatus = "improved" | "regressed" | "flat" | "inconclusive";

export interface KpiWindowTotals {
  spendBefore: number;
  revenueBefore: number;
  spendAfter: number;
  revenueAfter: number;
}

export function metaOutcomeFingerprint(input: {
  businessId: string;
  scopeType: string;
  scopeId: string;
  recType: string;
  snapshotDate: string;
}): string {
  return `meta_v1|${input.businessId}|${input.scopeType}|${input.scopeId}|${input.recType}|${input.snapshotDate}`;
}

export function classifyKpiOutcome(totals: KpiWindowTotals): MetaKpiOutcomeStatus {
  if (
    totals.spendBefore < META_OUTCOME_MIN_WINDOW_SPEND ||
    totals.spendAfter < META_OUTCOME_MIN_WINDOW_SPEND
  ) {
    return "inconclusive";
  }
  const roasBefore = totals.revenueBefore / totals.spendBefore;
  const roasAfter = totals.revenueAfter / totals.spendAfter;
  if (roasBefore <= 0) {
    if (roasAfter > 0) return "improved";
    return "flat";
  }
  if (roasAfter >= roasBefore * IMPROVED_RATIO) return "improved";
  if (roasAfter <= roasBefore * REGRESSED_RATIO) return "regressed";
  return "flat";
}

type CandidateRow = {
  business_id: string;
  scope_type: "campaign" | "adset";
  scope_id: string;
  rec_type: string;
  rec_id: string;
  decision_label: string | null;
  confidence_score: string | number | null;
  snapshot_date: string;
};

type KpiRow = {
  scope_id: string;
  spend_before: string | number | null;
  revenue_before: string | number | null;
  spend_after: string | number | null;
  revenue_after: string | number | null;
};

function toNumber(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addDaysToISO(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function readKpiWindows(input: {
  businessId: string;
  scopeType: "campaign" | "adset";
  scopeIds: string[];
  snapshotDate: string;
}): Promise<Map<string, KpiWindowTotals>> {
  if (input.scopeIds.length === 0) return new Map();
  const sql = getDb();
  const beforeStart = addDaysToISO(input.snapshotDate, -6);
  const afterStart = addDaysToISO(input.snapshotDate, 1);
  const afterEnd = addDaysToISO(input.snapshotDate, 7);
  const table = input.scopeType === "campaign" ? "meta_campaign_daily" : "meta_adset_daily";
  const idColumn = input.scopeType === "campaign" ? "campaign_id" : "adset_id";
  const rows = (await sql.query(
    `
    SELECT
      ${idColumn} AS scope_id,
      COALESCE(SUM(spend) FILTER (WHERE date BETWEEN $3::date AND $4::date), 0) AS spend_before,
      COALESCE(SUM(revenue) FILTER (WHERE date BETWEEN $3::date AND $4::date), 0) AS revenue_before,
      COALESCE(SUM(spend) FILTER (WHERE date BETWEEN $5::date AND $6::date), 0) AS spend_after,
      COALESCE(SUM(revenue) FILTER (WHERE date BETWEEN $5::date AND $6::date), 0) AS revenue_after
    FROM ${table}
    WHERE business_id = $1
      AND ${idColumn} = ANY($2::text[])
      AND date BETWEEN $3::date AND $6::date
    GROUP BY ${idColumn}
    `,
    [
      input.businessId,
      input.scopeIds,
      beforeStart,
      input.snapshotDate,
      afterStart,
      afterEnd,
    ],
  )) as KpiRow[];
  return new Map(
    rows.map((row) => [
      row.scope_id,
      {
        spendBefore: toNumber(row.spend_before),
        revenueBefore: toNumber(row.revenue_before),
        spendAfter: toNumber(row.spend_after),
        revenueAfter: toNumber(row.revenue_after),
      },
    ]),
  );
}

async function readOperatorActedRecIds(input: {
  businessId: string;
  recIds: string[];
  snapshotDate: string;
}): Promise<Set<string>> {
  if (input.recIds.length === 0) return new Set();
  const sql = getDb();
  const windowEnd = addDaysToISO(input.snapshotDate, 8);
  const rows = (await sql`
    SELECT rec_id
    FROM meta_decision_responses
    WHERE business_id = ${input.businessId}
      AND action = 'acted'
      AND rec_id = ANY(${input.recIds}::text[])
      AND timestamp >= ${input.snapshotDate}::date
      AND timestamp < ${windowEnd}::date
    UNION
    SELECT rec_id_origin AS rec_id
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND status = 'success'
      AND rec_id_origin = ANY(${input.recIds}::text[])
      AND created_at >= ${input.snapshotDate}::date
      AND created_at < ${windowEnd}::date
  `) as Array<{ rec_id: string }>;
  return new Set(rows.map((row) => row.rec_id));
}

export async function runMetaOutcomeAccrualForBusiness(
  businessId: string,
  now = new Date(),
): Promise<{ businessId: string; snapshotDate: string; candidates: number; written: number }> {
  const sql = getDb();
  const snapshotDate = addDaysToISO(now.toISOString().slice(0, 10), -ACCRUAL_LAG_DAYS);

  // Act recommendations from exactly one accrual lag ago that have no
  // outcome row yet (idempotent by fingerprint, so reruns are safe).
  const candidates = (await sql`
    SELECT
      snapshot.business_id,
      snapshot.scope_type,
      snapshot.scope_id,
      snapshot.rec_type,
      snapshot.rec_id,
      snapshot.decision_label,
      snapshot.confidence_score,
      snapshot.snapshot_date::text AS snapshot_date
    FROM meta_decision_snapshots_daily snapshot
    WHERE snapshot.business_id = ${businessId}
      AND snapshot.kind = 'recommendation'
      AND snapshot.engine_version = ${META_RECOMMENDATION_ENGINE_VERSION}
      AND snapshot.decision_state = 'act'
      AND snapshot.scope_type IN ('campaign', 'adset')
      AND snapshot.snapshot_date = ${snapshotDate}::date
      AND NOT EXISTS (
        SELECT 1
        FROM meta_decision_action_outcome_logs log
        WHERE log.action_type = 'outcome'
          AND log.recommendation_fingerprint =
            'meta_v1|' || snapshot.business_id || '|' || snapshot.scope_type || '|' ||
            snapshot.scope_id || '|' || snapshot.rec_type || '|' || snapshot.snapshot_date::text
      )
  `) as CandidateRow[];

  if (candidates.length === 0) {
    return { businessId, snapshotDate, candidates: 0, written: 0 };
  }

  const campaignIds = candidates
    .filter((row) => row.scope_type === "campaign")
    .map((row) => row.scope_id);
  const adsetIds = candidates
    .filter((row) => row.scope_type === "adset")
    .map((row) => row.scope_id);
  const [campaignKpis, adsetKpis, actedRecIds] = await Promise.all([
    readKpiWindows({ businessId, scopeType: "campaign", scopeIds: campaignIds, snapshotDate }),
    readKpiWindows({ businessId, scopeType: "adset", scopeIds: adsetIds, snapshotDate }),
    readOperatorActedRecIds({
      businessId,
      recIds: candidates.map((row) => row.rec_id),
      snapshotDate,
    }),
  ]);

  let written = 0;
  for (const candidate of candidates) {
    const totals =
      (candidate.scope_type === "campaign" ? campaignKpis : adsetKpis).get(candidate.scope_id) ??
      { spendBefore: 0, revenueBefore: 0, spendAfter: 0, revenueAfter: 0 };
    const outcomeStatus = classifyKpiOutcome(totals);
    const operatorActed = actedRecIds.has(candidate.rec_id);
    const roasBefore = totals.spendBefore > 0 ? totals.revenueBefore / totals.spendBefore : null;
    const roasAfter = totals.spendAfter > 0 ? totals.revenueAfter / totals.spendAfter : null;
    await appendMetaDecisionActionOutcomeLog({
      businessId,
      recommendationFingerprint: metaOutcomeFingerprint({
        businessId,
        scopeType: candidate.scope_type,
        scopeId: candidate.scope_id,
        recType: candidate.rec_type,
        snapshotDate: candidate.snapshot_date,
      }),
      recId: candidate.rec_id,
      recType: candidate.rec_type,
      decisionLabel: candidate.decision_label,
      actionType: "outcome",
      outcomeStatus,
      summary: `auto_kpi_7d: ${outcomeStatus} (ROAS ${roasBefore?.toFixed(2) ?? "n/a"} -> ${roasAfter?.toFixed(2) ?? "n/a"}, operator ${operatorActed ? "acted" : "did not act"})`,
      payloadJson: {
        rule: META_OUTCOME_ACCRUAL_RULE,
        snapshotDate: candidate.snapshot_date,
        scopeType: candidate.scope_type,
        scopeId: candidate.scope_id,
        confidenceScore: toNumber(candidate.confidence_score),
        windows: {
          before: { start: addDaysToISO(snapshotDate, -6), end: snapshotDate },
          after: { start: addDaysToISO(snapshotDate, 1), end: addDaysToISO(snapshotDate, 7) },
        },
        kpis: {
          spendBefore: totals.spendBefore,
          revenueBefore: totals.revenueBefore,
          roasBefore,
          spendAfter: totals.spendAfter,
          revenueAfter: totals.revenueAfter,
          roasAfter,
        },
        operatorActed,
        minWindowSpend: META_OUTCOME_MIN_WINDOW_SPEND,
      },
    });
    written += 1;
  }
  return { businessId, snapshotDate, candidates: candidates.length, written };
}

export async function runMetaOutcomeAccrualIfDue(now = new Date()) {
  const runDate = now.toISOString().slice(0, 10);
  // 05:00 UTC slot: after the 03:00 snapshot job and the 04:00 ignored
  // marker. Idempotent within the slot via the fingerprint NOT EXISTS.
  if (now.getUTCHours() !== 5) {
    return { skipped: true, reason: "not_due" as const, runDate };
  }
  const readiness = await getDbSchemaReadiness({
    tables: [
      "meta_decision_snapshots_daily",
      "meta_decision_action_outcome_logs",
      "meta_campaign_daily",
      "meta_adset_daily",
    ],
  }).catch(() => null);
  if (!readiness?.ready) {
    return { skipped: true, reason: "schema_not_ready" as const, runDate };
  }
  const businesses = await getActiveBusinesses();
  const results = await Promise.allSettled(
    businesses.map((business) => runMetaOutcomeAccrualForBusiness(business.id, now)),
  );
  return {
    skipped: false as const,
    runDate,
    results: results.map((result, index) => {
      const businessId = businesses[index]?.id ?? "unknown";
      if (result.status === "fulfilled") {
        return { businessId, status: "fulfilled" as const, value: result.value };
      }
      return {
        businessId,
        status: "rejected" as const,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    }),
  };
}
