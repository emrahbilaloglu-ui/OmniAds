#!/usr/bin/env node
// D033 Automatic Campaign Context day-1/day-N readiness check (read-only).
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/creative-decision-center/campaign-context-day1-check.ts [--asOf=YYYY-MM-DD]
//
// Reports: context job coverage, table row counts by business/kind/confidence,
// unknown/conflict collapse detection, suppressed-flip counts, producer chain
// regressions, and the daily hard-flip counter. Never writes.
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

type Row = Record<string, unknown>;

function arg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  return (
    process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ??
    fallback
  );
}

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const asOf = arg("asOf", new Date().toISOString().slice(0, 10));
  const db = getDb();

  const jobRuns = await db.query<Row>(
    `
    SELECT b.name, r.status, r.row_count, r.duration_ms, r.error_message
    FROM engine_v3_job_runs r
    JOIN businesses b ON b.id::text = r.business_ref_id::text
    WHERE r.job_name = 'engine_v3_campaign_context_job' AND r.as_of_date = $1::date
    ORDER BY b.name
    `,
    [asOf],
  );

  const distribution = await db.query<Row>(
    `
    SELECT b.name,
      COALESCE(c.inferred_kind, 'unknown') AS kind,
      c.confidence_class,
      COUNT(*)::int AS campaigns,
      COUNT(*) FILTER (
        WHERE (c.hysteresis_state_json->>'pendingCount')::int > 0
      )::int AS suppressed_flips
    FROM engine_v3_campaign_context_daily c
    JOIN businesses b ON b.id::text = c.business_id
    WHERE c.as_of_date = $1::date
    GROUP BY b.name, COALESCE(c.inferred_kind, 'unknown'), c.confidence_class
    ORDER BY b.name, campaigns DESC
    `,
    [asOf],
  );

  const collapse = await db.query<Row>(
    `
    SELECT b.name,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE c.confidence_class IN ('unknown','conflict'))::int AS unresolved
    FROM engine_v3_campaign_context_daily c
    JOIN businesses b ON b.id::text = c.business_id
    WHERE c.as_of_date = $1::date
    GROUP BY b.name
    HAVING COUNT(*) > 0
    ORDER BY b.name
    `,
    [asOf],
  );

  const producers = await db.query<Row>(
    `
    SELECT job_name, status, COUNT(*)::int AS runs
    FROM engine_v3_job_runs
    WHERE as_of_date = $1::date
      AND job_name IN (
        'engine_v3_campaign_context_job', 'engine_v3_calibration_job',
        'engine_v3_lifecycle_job', 'engine_v3_decisions_job',
        'engine_v3_decision_outcomes_job'
      )
    GROUP BY job_name, status
    ORDER BY job_name, status
    `,
    [asOf],
  );

  const stuck = await db.query<Row>(
    `
    SELECT job_name, business_ref_id::text AS business, started_at::text AS started_at
    FROM engine_v3_job_runs
    WHERE status IN ('failed', 'running') AND as_of_date = $1::date
    `,
    [asOf],
  );

  const hardFlips = await db.query<Row>(
    `
    SELECT b.name, e.creative_id,
      e.previous_label, e.current_label, e.event_date::text AS event_date
    FROM engine_v3_decision_events e
    JOIN businesses b ON b.id::text = e.business_ref_id::text
    WHERE e.event_type = 'decision_changed'
      AND e.event_date = $1::date
      AND (
        e.previous_label IN ('cut', 'scale') OR e.current_label IN ('cut', 'scale')
      )
    ORDER BY b.name, e.creative_id
    `,
    [asOf],
  );

  console.log(
    JSON.stringify(
      {
        asOf,
        readOnly: true,
        contextJobRuns: jobRuns,
        contextDistribution: distribution,
        unresolvedCollapse: collapse.map((row) => ({
          ...row,
          collapseWarning:
            Number(row.unresolved) === Number(row.total) && Number(row.total) > 3,
        })),
        producerRunsByStatus: producers,
        failedOrRunning: stuck,
        hardLabelChangeEvents: hardFlips,
        hardLabelChangeCount: hardFlips.length,
      },
      null,
      2,
    ),
  );
  await resetDbClientCache();
}

withOperationalStartupLogsSilenced(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
