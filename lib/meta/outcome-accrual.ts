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
//   downstream analysis can stratify. These rows are review-only and cannot
//   satisfy the controlled-causal automation gate.
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
import { META_OBSERVATIONAL_EVIDENCE_CLASS } from "@/lib/meta/empirical-outcomes";
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

/**
 * The identity of one accrued outcome.
 *
 * It gained a physical-account segment (D-M011/D-M012), because two assigned
 * accounts may legitimately hold the same scope id, rec type and snapshot date
 * — and without the account those two collapse to ONE fingerprint, so the
 * `NOT EXISTS` idempotency guard below would let account A's outcome suppress
 * account B's forever.
 *
 * ## Appended, never inserted
 *
 * The segment is APPENDED and only when an account is known, so a row whose
 * lineage is null keeps a byte-identical fingerprint to the one it was written
 * with before this change. That is what makes the upgrade safe: an already
 * accrued legacy outcome is still found by the guard and is not written twice,
 * while a new account-scoped outcome gets its own identity.
 *
 * A null account is NOT rendered as an empty segment for the same reason — that
 * would change every legacy fingerprint and re-accrue every legacy snapshot.
 */
export function metaOutcomeFingerprint(input: {
  businessId: string;
  scopeType: string;
  scopeId: string;
  recType: string;
  snapshotDate: string;
  providerAccountId?: string | null;
}): string {
  const base = `meta_v1|${input.businessId}|${input.scopeType}|${input.scopeId}|${input.recType}|${input.snapshotDate}`;
  const account = input.providerAccountId?.trim() || null;
  return account ? `${base}|${account}` : base;
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
  /**
   * The account the recommendation was COMPUTED for (D-M011), or null for a
   * row written before snapshots carried a lineage. Null is preserved as
   * unknown and never resolved into an account: a legacy row is business-wide
   * evidence, and stamping it with whichever account happens to be assigned
   * today would manufacture attribution the row never had.
   */
  provider_account_id: string | null;
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

/**
 * The map key for one scope's KPI window.
 *
 * Keyed by ACCOUNT and scope id, not scope id alone. Meta entity ids are
 * globally unique in practice, but this map is what decides which numbers a
 * given candidate is labelled from — and a key that cannot express two
 * accounts is a key that silently pools them the first time an id repeats.
 * The NUL separator cannot appear in either half.
 */
function kpiWindowKey(providerAccountId: string | null, scopeId: string) {
  return `${providerAccountId ?? ""}\u0000${scopeId}`;
}

async function readKpiWindows(input: {
  businessId: string;
  /**
   * The account whose spend and revenue may be counted. Non-null narrows the
   * read to that account BEFORE the sums are taken; null reads every account
   * this business has, which is what a legacy unattributed candidate means and
   * exactly what it measured before this change.
   */
  providerAccountId: string | null;
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
      AND ($7::text IS NULL OR provider_account_id = $7)
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
      input.providerAccountId,
    ],
  )) as KpiRow[];
  return new Map(
    rows.map((row) => [
      kpiWindowKey(input.providerAccountId, row.scope_id),
      {
        spendBefore: toNumber(row.spend_before),
        revenueBefore: toNumber(row.revenue_before),
        spendAfter: toNumber(row.spend_after),
        revenueAfter: toNumber(row.revenue_after),
      },
    ]),
  );
}

/**
 * Did an operator act on these recommendations, IN THIS ACCOUNT?
 *
 * Both sources persist the physical account, so both are matched on it
 * DIRECTLY — no inference, and nothing derived from the rec id:
 *
 *   `meta_decision_responses.provider_account_id` (D-M012).
 *   `meta_ads_action_log.provider_account_id`, written by
 *   `insertMetaAdsActionLog` alongside `provider_account_ref_id`.
 *
 * Rec ids may now repeat across accounts, so a row whose own lineage is null
 * is NOT admitted into an account-scoped read. That is the fail-closed
 * direction, and the alternative was considered and rejected: resolving the
 * account from the ad through `meta_ad_dimensions` would be both an inference
 * where a persisted fact exists and an incomplete one, because this log also
 * records campaign, ad-set and launch actions that no ad dimension resolves.
 *
 * A null account means the CANDIDATE itself is legacy and business-wide, and
 * both halves then read exactly what they read before this change.
 */
async function readOperatorActedRecIds(input: {
  businessId: string;
  providerAccountId: string | null;
  recIds: string[];
  snapshotDate: string;
}): Promise<Set<string>> {
  if (input.recIds.length === 0) return new Set();
  const sql = getDb();
  const account = input.providerAccountId?.trim() || null;
  const windowEnd = addDaysToISO(input.snapshotDate, 8);
  const rows = (await sql`
    SELECT rec_id
    FROM meta_decision_responses
    WHERE business_id = ${input.businessId}
      AND (${account}::text IS NULL OR provider_account_id = ${account})
      AND action = 'acted'
      AND rec_id = ANY(${input.recIds}::text[])
      AND timestamp >= ${input.snapshotDate}::date
      AND timestamp < ${windowEnd}::date
    UNION
    SELECT rec_id_origin AS rec_id
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND (${account}::text IS NULL OR provider_account_id = ${account})
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
      snapshot.provider_account_id,
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
      /*
       * Idempotency, PER ACCOUNT.
       *
       * Two instruments, either of which alone would separate two accounts,
       * and together a fingerprint collision still cannot suppress across
       * them: the stored lineage must match the candidate's exactly
       * (IS NOT DISTINCT FROM, so a legacy null outcome answers for a legacy
       * null candidate and for nothing else), and the fingerprint carries the
       * account as an appended segment.
       *
       * The COALESCE reproduces metaOutcomeFingerprint exactly, including
       * its rule that a null account appends NOTHING —
       * which is what keeps an already accrued legacy outcome findable and
       * stops this rerunning every legacy snapshot.
       */
      AND NOT EXISTS (
        SELECT 1
        FROM meta_decision_action_outcome_logs log
        WHERE log.action_type = 'outcome'
          AND log.provider_account_id IS NOT DISTINCT FROM snapshot.provider_account_id
          AND log.recommendation_fingerprint =
            'meta_v1|' || snapshot.business_id || '|' || snapshot.scope_type || '|' ||
            snapshot.scope_id || '|' || snapshot.rec_type || '|' || snapshot.snapshot_date::text ||
            COALESCE('|' || snapshot.provider_account_id, '')
      )
  `) as CandidateRow[];

  if (candidates.length === 0) {
    return { businessId, snapshotDate, candidates: 0, written: 0 };
  }

  /*
   * Read PER ACCOUNT, not once for the business.
   *
   * One business-wide read cannot answer an account-scoped question: its KPI
   * map is keyed by scope id, so two accounts holding the same campaign id
   * would pool their spend into whichever row won the key — and its acted-set
   * is keyed by rec id, so one account's operator response would mark the
   * other's recommendation as acted on. Both are the same defect, and both are
   * closed by narrowing before the read rather than filtering after it.
   *
   * A legacy candidate with no lineage forms its own null group and reads
   * business-wide, exactly as it did before.
   */
  const accountKeys = Array.from(
    new Set(candidates.map((row) => row.provider_account_id ?? "")),
  );
  const kpiByScope = new Map<string, KpiWindowTotals>();
  const actedRecIdsByAccount = new Map<string, Set<string>>();
  await Promise.all(
    accountKeys.map(async (accountKey) => {
      const providerAccountId = accountKey || null;
      const forAccount = candidates.filter(
        (row) => (row.provider_account_id ?? "") === accountKey,
      );
      const [campaignKpis, adsetKpis, acted] = await Promise.all([
        readKpiWindows({
          businessId,
          providerAccountId,
          scopeType: "campaign",
          scopeIds: forAccount
            .filter((row) => row.scope_type === "campaign")
            .map((row) => row.scope_id),
          snapshotDate,
        }),
        readKpiWindows({
          businessId,
          providerAccountId,
          scopeType: "adset",
          scopeIds: forAccount
            .filter((row) => row.scope_type === "adset")
            .map((row) => row.scope_id),
          snapshotDate,
        }),
        readOperatorActedRecIds({
          businessId,
          providerAccountId,
          recIds: forAccount.map((row) => row.rec_id),
          snapshotDate,
        }),
      ]);
      for (const [key, totals] of [...campaignKpis, ...adsetKpis]) {
        kpiByScope.set(key, totals);
      }
      actedRecIdsByAccount.set(accountKey, acted);
    }),
  );

  let written = 0;
  for (const candidate of candidates) {
    const totals =
      kpiByScope.get(
        kpiWindowKey(candidate.provider_account_id ?? null, candidate.scope_id),
      ) ?? { spendBefore: 0, revenueBefore: 0, spendAfter: 0, revenueAfter: 0 };
    const outcomeStatus = classifyKpiOutcome(totals);
    const operatorActed =
      actedRecIdsByAccount
        .get(candidate.provider_account_id ?? "")
        ?.has(candidate.rec_id) ?? false;
    const roasBefore = totals.spendBefore > 0 ? totals.revenueBefore / totals.spendBefore : null;
    const roasAfter = totals.spendAfter > 0 ? totals.revenueAfter / totals.spendAfter : null;
    await appendMetaDecisionActionOutcomeLog({
      businessId,
      // Persisted, so the read side can prove which account an outcome belongs
      // to instead of correlating on a rec id two accounts may share. Null
      // stays null: a legacy candidate is not given a lineage it never had.
      providerAccountId: candidate.provider_account_id ?? null,
      recommendationFingerprint: metaOutcomeFingerprint({
        businessId,
        providerAccountId: candidate.provider_account_id,
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
        evidenceClass: META_OBSERVATIONAL_EVIDENCE_CLASS,
        causalDesign: null,
        treatmentReceipt: null,
        snapshotDate: candidate.snapshot_date,
        // The evidence says which account it measured, and says so explicitly
        // when it could not tell — a reader must not have to infer that from
        // the absence of a field.
        providerAccountId: candidate.provider_account_id ?? null,
        accountAttribution: candidate.provider_account_id
          ? ("exact" as const)
          : ("unattributed_legacy" as const),
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
