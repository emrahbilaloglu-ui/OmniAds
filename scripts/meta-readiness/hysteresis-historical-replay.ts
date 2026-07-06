#!/usr/bin/env node
// Meta v1 decision-state hysteresis: historical replay (read-only).
//
// Usage:
//   node --env-file=.env.local --import tsx scripts/meta-readiness/hysteresis-historical-replay.ts
//
// The act-boundary hysteresis (lib/meta/decision-stability.ts, shipped
// 2026-07-06) is unit- and pipeline-tested but was never validated against
// the live snapshot history. This script reads every persisted v1
// recommendation row through the prod tunnel (SELECT only), measures the
// OBSERVED decision-state churn per stability key, and replays the
// hysteresis rule over the raw day-sequences to report what it would have
// suppressed. Nothing is written.
//
// Honest limits:
// - Rows written before 2026-07-06 are raw engine states (pre-hysteresis);
//   rows from 2026-07-06 on carry signal_quality.stability - where present
//   the raw state is used so the replay chains true engine outputs.
// - "Prevented round-trip" = a suppressed flip whose raw state reverted on
//   the key's next appearance (the hold was correct). "Delayed
//   confirmation" = the raw state held and published one snapshot later
//   (the cost of the rule).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  applyMetaStateHysteresis,
  type PreviousPublishedState,
} from "@/lib/meta/decision-stability";
import { META_RECOMMENDATION_ENGINE_VERSION } from "@/lib/meta/recommendations";
import type { MetaDecisionState } from "@/lib/meta/recommendations";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";

type SnapshotRow = {
  business_id: string;
  snapshot_date: string;
  scope_type: string;
  scope_id: string;
  rec_type: string;
  decision_state: MetaDecisionState;
  signal_quality: unknown;
};

function rawStateOf(row: SnapshotRow): MetaDecisionState {
  // signal_quality column is pre-projected to ->'stability' in the query.
  const raw = (row.signal_quality as { raw_decision_state?: unknown } | null)?.raw_decision_state;
  return raw === "act" || raw === "test" || raw === "watch"
    ? raw
    : row.decision_state;
}

const isAct = (state: MetaDecisionState) => state === "act";

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const db = getDb();

  // One query per snapshot date: the full-history single query exceeds the
  // pool's 8s statement timeout once signal_quality jsonb is included.
  const dateRows = (await db.query(
    `
    SELECT DISTINCT snapshot_date::text AS snapshot_date
    FROM meta_decision_snapshots_daily
    WHERE kind = 'recommendation'
      AND engine_version = $1
    ORDER BY snapshot_date ASC
    `,
    [META_RECOMMENDATION_ENGINE_VERSION],
  )) as Array<{ snapshot_date: string }>;
  const snapshotDates = dateRows.map((row) => row.snapshot_date);

  const rows: SnapshotRow[] = [];
  for (const snapshotDate of snapshotDates) {
    const dayRows = (await db.query(
      `
      SELECT
        business_id,
        snapshot_date::text AS snapshot_date,
        scope_type,
        scope_id,
        rec_type,
        decision_state,
        signal_quality->'stability' AS signal_quality
      FROM meta_decision_snapshots_daily
      WHERE kind = 'recommendation'
        AND engine_version = $1
        AND scope_type IN ('campaign', 'adset')
        AND snapshot_date = $2::date
      `,
      [META_RECOMMENDATION_ENGINE_VERSION, snapshotDate],
    )) as SnapshotRow[];
    rows.push(...dayRows);
  }
  rows.sort(
    (left, right) =>
      left.business_id.localeCompare(right.business_id) ||
      left.scope_type.localeCompare(right.scope_type) ||
      left.scope_id.localeCompare(right.scope_id) ||
      left.rec_type.localeCompare(right.rec_type) ||
      left.snapshot_date.localeCompare(right.snapshot_date),
  );
  const sequences = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const key = `${row.business_id}|${row.scope_type}|${row.scope_id}|${row.rec_type}`;
    sequences.set(key, [...(sequences.get(key) ?? []), row]);
  }

  // Observed churn (what actually published, pre-hysteresis for most days).
  let observedTransitions = 0;
  let observedActBoundaryTransitions = 0;
  let observedRoundTrips = 0; // A -> B -> A across consecutive appearances
  let observedActRoundTrips = 0;
  // Replay of the hysteresis rule over raw states.
  let replaySuppressed = 0;
  let replayPreventedRoundTrips = 0;
  let replayDelayedConfirmations = 0;
  let replayPendingAtEnd = 0;
  const perKeyChurn: Array<{ key: string; actBoundaryTransitions: number; appearances: number }> =
    [];

  for (const [key, sequence] of sequences) {
    let actBoundary = 0;
    for (let index = 1; index < sequence.length; index += 1) {
      const previous = rawStateOf(sequence[index - 1]!);
      const current = rawStateOf(sequence[index]!);
      if (previous !== current) {
        observedTransitions += 1;
        if (isAct(previous) || isAct(current)) {
          observedActBoundaryTransitions += 1;
          actBoundary += 1;
        }
        const next = sequence[index + 1] ? rawStateOf(sequence[index + 1]!) : null;
        if (next !== null && next === previous) {
          observedRoundTrips += 1;
          if (isAct(previous) || isAct(current)) observedActRoundTrips += 1;
        }
      }
    }
    if (actBoundary > 0) {
      perKeyChurn.push({ key, actBoundaryTransitions: actBoundary, appearances: sequence.length });
    }

    // Replay: chain the production rule over the raw sequence, mirroring
    // the reader (previous = most recent prior appearance, any gap).
    let memory: PreviousPublishedState | null = null;
    for (let index = 0; index < sequence.length; index += 1) {
      const raw = rawStateOf(sequence[index]!);
      const result = applyMetaStateHysteresis(raw, memory);
      if (result.suppressed) {
        replaySuppressed += 1;
        const next = sequence[index + 1] ? rawStateOf(sequence[index + 1]!) : null;
        if (next === null) {
          replayPendingAtEnd += 1;
        } else if (next === result.publishedState) {
          replayPreventedRoundTrips += 1; // raw flip reverted: hold was right
        } else if (next === raw) {
          replayDelayedConfirmations += 1; // raw flip held: publish 1 day late
        } else {
          replayPendingAtEnd += 1; // flipped to a third state; neither bucket
        }
      }
      memory = { publishedState: result.publishedState, rawState: result.rawState };
    }
  }

  perKeyChurn.sort((left, right) => right.actBoundaryTransitions - left.actBoundaryTransitions);

  const report = {
    generatedAt: new Date().toISOString(),
    liveStatus: {
      source: "live_db_tunnel",
      tunnelHost: "127.0.0.1",
      tunnelPort: 15432,
      readOnly: true,
    },
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    coverage: {
      rows: rows.length,
      stabilityKeys: sequences.size,
      snapshotDates: snapshotDates.length,
      firstSnapshotDate: snapshotDates[0] ?? null,
      lastSnapshotDate: snapshotDates[snapshotDates.length - 1] ?? null,
      businesses: new Set(rows.map((row) => row.business_id)).size,
    },
    observedChurn: {
      transitions: observedTransitions,
      actBoundaryTransitions: observedActBoundaryTransitions,
      roundTrips: observedRoundTrips,
      actBoundaryRoundTrips: observedActRoundTrips,
    },
    hysteresisReplay: {
      suppressed: replaySuppressed,
      preventedRoundTrips: replayPreventedRoundTrips,
      delayedConfirmations: replayDelayedConfirmations,
      unresolvedOrThirdState: replayPendingAtEnd,
      note:
        "prevented = raw flip reverted next appearance (hold correct); delayed = raw flip confirmed (1-snapshot publish cost)",
    },
    topChurnKeys: perKeyChurn.slice(0, 15),
  };

  const outPath = resolve(
    process.cwd(),
    "docs/meta-readiness/hysteresis-historical-replay.json",
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[hysteresis-replay] report written to ${outPath}`);
  await resetDbClientCache();
}

void withOperationalStartupLogsSilenced(() =>
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  }),
);
