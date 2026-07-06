#!/usr/bin/env node
// Meta v1 confidence thresholds vs realized KPI movement (read-only).
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/meta-readiness/confidence-outcome-validation.ts
//   node --env-file=.env.local --import tsx scripts/meta-readiness/confidence-outcome-validation.ts --max-snapshot-dates=20
//
// The 0.7 (act) / 0.55 (medium) confidence cuts gate decision states,
// labels, and automation readiness but have never been compared against
// realized outcomes (meta_decision_action_outcome_logs has no historical
// rows - the accrual writer ships 2026-07-07). This script reconstructs
// the comparison directly: for every persisted campaign/adset
// recommendation old enough to have a full 7d-after window, it joins the
// scope's 7d-before vs 7d-after ROAS from the daily fact tables and
// reports outcome rates per confidence bucket and decision state.
//
// Honest limits, stated up front:
// - CORRELATIONAL: KPI movement after a recommendation is not caused by
//   it; operators acted on an unknown subset (operator-response join is
//   reported alongside as acted-share per bucket).
// - decision_state for pre-2026-07-06 rows is the raw engine state; later
//   rows use signal_quality.stability.raw_decision_state where present.
// - confidence_score is multi-modal: label-only recommendations carry
//   stamped defaults (0.85/0.6/0.4), so bucket populations mix formula
//   scores with defaults; the per-bucket n makes this visible.
// - The same +-5% ROAS bands and $50/window spend floor as the accrual
//   rule (auto_kpi_7d.v1) are used, so future accrued outcomes are
//   directly comparable.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  META_CONFIDENCE_ACT_THRESHOLD,
  META_CONFIDENCE_MEDIUM_THRESHOLD,
  metaConfidenceBucket,
} from "@/lib/meta/confidence-thresholds";
import { classifyKpiOutcome, META_OUTCOME_MIN_WINDOW_SPEND } from "@/lib/meta/outcome-accrual";
import { META_RECOMMENDATION_ENGINE_VERSION } from "@/lib/meta/recommendations";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

type DecisionRow = {
  business_id: string;
  snapshot_date: string;
  scope_type: "campaign" | "adset";
  scope_id: string;
  rec_type: string;
  rec_id: string;
  decision_state: "act" | "test" | "watch";
  raw_state: string | null;
  confidence_score: string | number | null;
  spend_before: string | number | null;
  revenue_before: string | number | null;
  spend_after: string | number | null;
  revenue_after: string | number | null;
  operator_acted: boolean;
};

type ScriptOptions = {
  maxSnapshotDates: number;
  queryTimeoutMs: number;
  maxRuntimeMs: number;
};

const DEFAULT_MAX_SNAPSHOT_DATES = 20;
const DEFAULT_QUERY_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RUNTIME_MS = 90_000;

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readOption(args: string[], name: string) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseOptions(args = process.argv.slice(2)): ScriptOptions {
  return {
    maxSnapshotDates: parsePositiveInteger(
      readOption(args, "max-snapshot-dates") ?? process.env.META_CONFIDENCE_VALIDATION_MAX_DATES,
      DEFAULT_MAX_SNAPSHOT_DATES,
    ),
    queryTimeoutMs: parsePositiveInteger(
      readOption(args, "query-timeout-ms") ?? process.env.META_CONFIDENCE_VALIDATION_QUERY_TIMEOUT_MS,
      DEFAULT_QUERY_TIMEOUT_MS,
    ),
    maxRuntimeMs: parsePositiveInteger(
      readOption(args, "max-runtime-ms") ?? process.env.META_CONFIDENCE_VALIDATION_MAX_RUNTIME_MS,
      DEFAULT_MAX_RUNTIME_MS,
    ),
  };
}

function toNumber(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

type BucketStats = {
  n: number;
  improved: number;
  regressed: number;
  flat: number;
  inconclusive: number;
  actedN: number;
  roasDeltas: number[];
};

function emptyBucket(): BucketStats {
  return { n: 0, improved: 0, regressed: 0, flat: 0, inconclusive: 0, actedN: 0, roasDeltas: [] };
}

function median(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function summarizeBucket(stats: BucketStats) {
  const judged = stats.improved + stats.regressed;
  return {
    n: stats.n,
    improved: stats.improved,
    regressed: stats.regressed,
    flat: stats.flat,
    inconclusive: stats.inconclusive,
    improvedShareOfJudged: judged > 0 ? Number((stats.improved / judged).toFixed(3)) : null,
    improvedShareOfConclusive:
      stats.n - stats.inconclusive > 0
        ? Number((stats.improved / (stats.n - stats.inconclusive)).toFixed(3))
        : null,
    operatorActedShare: stats.n > 0 ? Number((stats.actedN / stats.n).toFixed(3)) : null,
    medianRoasDelta: median(stats.roasDeltas),
  };
}

async function main() {
  const options = parseOptions();
  const deadlineMs = Date.now() + options.maxRuntimeMs;
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const db = getDb();
  await db.query(`SET statement_timeout = ${Math.max(1_000, options.queryTimeoutMs)}`);

  // Chunked by snapshot date to stay under the pool's query timeout: per
  // date we read the decisions, then join the KPI windows per distinct
  // scope and the operator responses per rec_id. The default intentionally
  // samples the most recent fully-accrued days; the report states when
  // older days were not included instead of silently pretending this is a
  // complete-history proof.
  const dateRows = (await db.query(
    `
    SELECT DISTINCT snapshot_date::text AS snapshot_date
    FROM meta_decision_snapshots_daily
    WHERE kind = 'recommendation'
      AND engine_version = $1
      AND snapshot_date <= (CURRENT_DATE - INTERVAL '8 days')
    ORDER BY snapshot_date DESC
    LIMIT $2
    `,
    [META_RECOMMENDATION_ENGINE_VERSION, options.maxSnapshotDates + 1],
  )) as Array<{ snapshot_date: string }>;
  const historyTruncated = dateRows.length > options.maxSnapshotDates;
  const selectedDateRows = dateRows.slice(0, options.maxSnapshotDates);

  const rows: DecisionRow[] = [];
  let stoppedEarly = false;
  for (const { snapshot_date: snapshotDate } of selectedDateRows) {
    if (Date.now() > deadlineMs) {
      stoppedEarly = true;
      break;
    }
    const decisions = (await db.query(
      `
      SELECT
        business_id,
        snapshot_date::text AS snapshot_date,
        scope_type,
        scope_id,
        rec_type,
        rec_id,
        decision_state,
        signal_quality->'stability'->>'raw_decision_state' AS raw_state,
        confidence_score
      FROM meta_decision_snapshots_daily
      WHERE kind = 'recommendation'
        AND engine_version = $1
        AND scope_type IN ('campaign', 'adset')
        AND snapshot_date = $2::date
      `,
      [META_RECOMMENDATION_ENGINE_VERSION, snapshotDate],
    )) as Array<Omit<DecisionRow, "spend_before" | "revenue_before" | "spend_after" | "revenue_after" | "operator_acted">>;
    if (decisions.length === 0) continue;

    const kpiByScope = new Map<string, Record<string, string | number | null>>();
    for (const scopeType of ["campaign", "adset"] as const) {
      const businessScopes = new Map<string, Set<string>>();
      for (const decision of decisions) {
        if (decision.scope_type !== scopeType) continue;
        const set = businessScopes.get(decision.business_id) ?? new Set<string>();
        set.add(decision.scope_id);
        businessScopes.set(decision.business_id, set);
      }
      const table = scopeType === "campaign" ? "meta_campaign_daily" : "meta_adset_daily";
      const idColumn = scopeType === "campaign" ? "campaign_id" : "adset_id";
      for (const [businessId, scopeIds] of businessScopes) {
        if (Date.now() > deadlineMs) {
          stoppedEarly = true;
          break;
        }
        const kpiRows = (await db.query(
          `
          SELECT
            ${idColumn} AS scope_id,
            COALESCE(SUM(spend) FILTER (WHERE date BETWEEN $3::date - 6 AND $3::date), 0) AS spend_before,
            COALESCE(SUM(revenue) FILTER (WHERE date BETWEEN $3::date - 6 AND $3::date), 0) AS revenue_before,
            COALESCE(SUM(spend) FILTER (WHERE date BETWEEN $3::date + 1 AND $3::date + 7), 0) AS spend_after,
            COALESCE(SUM(revenue) FILTER (WHERE date BETWEEN $3::date + 1 AND $3::date + 7), 0) AS revenue_after
          FROM ${table}
          WHERE business_id = $1
            AND ${idColumn} = ANY($2::text[])
            AND date BETWEEN $3::date - 6 AND $3::date + 7
          GROUP BY ${idColumn}
          `,
          [businessId, [...scopeIds], snapshotDate],
        )) as Array<Record<string, string | number | null> & { scope_id: string }>;
        for (const kpi of kpiRows) {
          kpiByScope.set(`${businessId}|${scopeType}|${kpi.scope_id}`, kpi);
        }
      }
      if (stoppedEarly) break;
    }
    if (stoppedEarly) break;

    const actedKeys = new Set<string>();
    const recIdsByBusiness = new Map<string, Set<string>>();
    for (const decision of decisions) {
      const set = recIdsByBusiness.get(decision.business_id) ?? new Set<string>();
      set.add(decision.rec_id);
      recIdsByBusiness.set(decision.business_id, set);
    }
    for (const [businessId, recIds] of recIdsByBusiness) {
      if (Date.now() > deadlineMs) {
        stoppedEarly = true;
        break;
      }
      const actedRows = (await db.query(
        `
        SELECT DISTINCT rec_id
        FROM meta_decision_responses
        WHERE business_id = $1
          AND action = 'acted'
          AND rec_id = ANY($2::text[])
          AND timestamp >= $3::date
          AND timestamp < $3::date + 8
        `,
        [businessId, [...recIds], snapshotDate],
      )) as Array<{ rec_id: string }>;
      for (const acted of actedRows) actedKeys.add(`${businessId}|${acted.rec_id}`);
    }
    if (stoppedEarly) break;

    for (const decision of decisions) {
      const kpi = kpiByScope.get(
        `${decision.business_id}|${decision.scope_type}|${decision.scope_id}`,
      );
      rows.push({
        ...decision,
        spend_before: kpi?.spend_before ?? 0,
        revenue_before: kpi?.revenue_before ?? 0,
        spend_after: kpi?.spend_after ?? 0,
        revenue_after: kpi?.revenue_after ?? 0,
        operator_acted: actedKeys.has(`${decision.business_id}|${decision.rec_id}`),
      });
    }
  }

  const byConfidence = new Map<string, BucketStats>();
  const byState = new Map<string, BucketStats>();
  const byStateActed = new Map<string, BucketStats>();
  const scoreHistogram = new Map<string, number>();

  for (const row of rows) {
    const score = toNumber(row.confidence_score);
    const bucket = metaConfidenceBucket(score);
    const state =
      row.raw_state === "act" || row.raw_state === "test" || row.raw_state === "watch"
        ? row.raw_state
        : row.decision_state;
    const totals = {
      spendBefore: toNumber(row.spend_before),
      revenueBefore: toNumber(row.revenue_before),
      spendAfter: toNumber(row.spend_after),
      revenueAfter: toNumber(row.revenue_after),
    };
    const outcome = classifyKpiOutcome(totals);
    const roasBefore = totals.spendBefore > 0 ? totals.revenueBefore / totals.spendBefore : null;
    const roasAfter = totals.spendAfter > 0 ? totals.revenueAfter / totals.spendAfter : null;

    const scoreKey = score.toFixed(2);
    scoreHistogram.set(scoreKey, (scoreHistogram.get(scoreKey) ?? 0) + 1);

    const targets = [
      [byConfidence, bucket],
      [byState, state],
      ...(row.operator_acted ? [[byStateActed, state] as const] : []),
    ] as const;
    for (const [map, key] of targets) {
      const stats = map.get(key) ?? emptyBucket();
      stats.n += 1;
      stats[outcome] += 1;
      if (row.operator_acted) stats.actedN += 1;
      if (roasBefore !== null && roasAfter !== null && outcome !== "inconclusive") {
        stats.roasDeltas.push(roasAfter - roasBefore);
      }
      map.set(key, stats);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    liveStatus: {
      source: "live_db_tunnel",
      tunnelHost: "127.0.0.1",
      tunnelPort: 15432,
      readOnly: true,
    },
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    thresholds: {
      act: META_CONFIDENCE_ACT_THRESHOLD,
      medium: META_CONFIDENCE_MEDIUM_THRESHOLD,
      outcomeRule: "auto_kpi_7d.v1 bands (+-5% ROAS, $" + META_OUTCOME_MIN_WINDOW_SPEND + "/window floor)",
    },
    coverage: {
      decisions: rows.length,
      businesses: new Set(rows.map((row) => row.business_id)).size,
      snapshotDates: new Set(rows.map((row) => row.snapshot_date)).size,
      firstSnapshotDate:
        rows.length > 0 ? [...new Set(rows.map((row) => row.snapshot_date))].sort()[0] : null,
      lastSnapshotDate:
        rows.length > 0 ? [...new Set(rows.map((row) => row.snapshot_date))].sort().at(-1) : null,
      maxSnapshotDates: options.maxSnapshotDates,
      historyTruncated,
      stoppedEarly,
      queryTimeoutMs: options.queryTimeoutMs,
      maxRuntimeMs: options.maxRuntimeMs,
    },
    byConfidenceBucket: Object.fromEntries(
      ["high", "medium", "low"].map((key) => [
        key,
        summarizeBucket(byConfidence.get(key) ?? emptyBucket()),
      ]),
    ),
    byRawDecisionState: Object.fromEntries(
      ["act", "test", "watch"].map((key) => [
        key,
        summarizeBucket(byState.get(key) ?? emptyBucket()),
      ]),
    ),
    byRawDecisionStateOperatorActedOnly: Object.fromEntries(
      ["act", "test", "watch"].map((key) => [
        key,
        summarizeBucket(byStateActed.get(key) ?? emptyBucket()),
      ]),
    ),
    confidenceScoreHistogram: Object.fromEntries(
      [...scoreHistogram.entries()].sort((a, b) => Number(a[0]) - Number(b[0])),
    ),
  };

  const outPath = resolve(
    process.cwd(),
    "docs/meta-readiness/confidence-outcome-validation.json",
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        generatedAt: report.generatedAt,
        engineVersion: report.engineVersion,
        thresholds: report.thresholds,
        coverage: report.coverage,
        byConfidenceBucket: report.byConfidenceBucket,
        byRawDecisionState: report.byRawDecisionState,
        byRawDecisionStateOperatorActedOnly: report.byRawDecisionStateOperatorActedOnly,
        outputPath: outPath,
      },
      null,
      2,
    ),
  );
  await resetDbClientCache();
}

void withOperationalStartupLogsSilenced(() =>
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }),
);
