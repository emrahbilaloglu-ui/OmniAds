#!/usr/bin/env node
// CDC daily integrity check (read-only) - Codex review recommendation.
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/creative-decision-center/cdc-daily-integrity-check.ts [--asOf=YYYY-MM-DD]
//
// Three current-version assertions, exit non-zero on violation:
// 1. raw_label coverage: every current-version snapshot for asOf carries a
//    raw_label.
// 2. producer health: no failed/running engine job rows for asOf.
// 3. suppression resolution: no creative held (label <> raw_label) for two
//    or more consecutive days - hysteresis must confirm or revert next day.
import { getDb, resetDbClientCache } from "@/lib/db";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

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
  const violations: string[] = [];

  const coverage = await db.query<Record<string, unknown>>(
    `
    SELECT COUNT(*)::int AS rows,
      COUNT(*) FILTER (WHERE raw_label IS NULL)::int AS missing_raw
    FROM engine_v3_decision_snapshots_daily
    WHERE engine_version = $1 AND as_of_date = $2::date
    `,
    [ENGINE_VERSION, asOf],
  );
  const rows = Number(coverage[0]?.rows ?? 0);
  const missingRaw = Number(coverage[0]?.missing_raw ?? 0);
  if (missingRaw > 0) {
    violations.push(`raw_label coverage: ${missingRaw}/${rows} snapshots missing raw_label`);
  }

  const producers = await db.query<Record<string, unknown>>(
    `
    SELECT job_name, status, COUNT(*)::int AS n
    FROM engine_v3_job_runs
    WHERE as_of_date = $1::date AND status IN ('failed', 'running')
    GROUP BY job_name, status
    `,
    [asOf],
  );
  for (const row of producers) {
    violations.push(`producer health: ${row.job_name} has ${row.n} ${row.status} run(s)`);
  }

  const stuckSuppressions = await db.query<Record<string, unknown>>(
    `
    WITH held AS (
      SELECT business_ref_id, creative_id, as_of_date
      FROM engine_v3_decision_snapshots_daily
      WHERE engine_version = $1 AND label <> raw_label
        AND as_of_date >= ($2::date - INTERVAL '7 days')
    )
    SELECT a.business_ref_id::text AS business, a.creative_id,
      a.as_of_date::text AS first_day
    FROM held a
    JOIN held b
      ON b.business_ref_id = a.business_ref_id
     AND b.creative_id = a.creative_id
     AND b.as_of_date = a.as_of_date + 1
    `,
    [ENGINE_VERSION, asOf],
  );
  for (const row of stuckSuppressions) {
    violations.push(
      `stuck suppression: ${row.business} creative ${row.creative_id} held two consecutive days from ${row.first_day}`,
    );
  }

  const pass = violations.length === 0;
  console.log(
    JSON.stringify(
      {
        asOf,
        engineVersion: ENGINE_VERSION,
        readOnly: true,
        snapshotRows: rows,
        pass,
        violations,
      },
      null,
      2,
    ),
  );
  if (!pass) process.exitCode = 1;
  await resetDbClientCache();
}

withOperationalStartupLogsSilenced(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
