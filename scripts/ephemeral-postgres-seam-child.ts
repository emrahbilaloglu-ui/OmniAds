// Child of ephemeral-postgres-migrations-check: exercises the hysteresis
// DB seam against the freshly-migrated ephemeral database. DATABASE_URL is
// pre-set by the parent to the ephemeral server (never the prod tunnel).
//
// The seam under test is exactly the class the adversarial review caught in
// the campaign-context job: state persisted by the production write query
// must round-trip through the production reader. Here: snapshots written via
// UPSERT_DECISION_SNAPSHOTS_QUERY -> readPreviousPublishedLabels.
import { randomUUID } from "node:crypto";
import { getDb, resetDbClientCache } from "@/lib/db";
import { UPSERT_DECISION_SNAPSHOTS_QUERY } from "@/lib/creative-decision-engine/jobs/decisions-job";
import {
  applyDailyHysteresis,
  parseHysteresisState,
  UPSERT_CONTEXT_QUERY,
} from "@/lib/creative-decision-engine/jobs/campaign-context-job";
import { readPreviousPublishedLabels } from "@/lib/creative-decision-engine/decision-stability";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

function snapshotRow(input: {
  businessRefId: string;
  creativeId: string;
  asOfDate: string;
  label: string;
  rawLabel: string;
  truthSource?: "commercial_truth" | "commercial_truth_stale";
  blockedActionType?: "scale" | "cut" | "refresh" | null;
}) {
  return {
    business_ref_id: input.businessRefId,
    business_id: input.businessRefId,
    creative_id: input.creativeId,
    as_of_date: input.asOfDate,
    engine_version: ENGINE_VERSION,
    scope_type: "account",
    scope_id: "*",
    label: input.label,
    raw_label: input.rawLabel,
    confidence: 70,
    truth_source: input.truthSource ?? "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 0.5,
    badges: [],
    reason: "seam check",
    spend: 100,
    purchases: 1,
    roas: 1,
    recent7d_roas: null,
    label_transform: null,
    blocked_action_type: input.blockedActionType ?? null,
    job_run_id: null,
    lifecycle_row_id: null,
    calibration_row_id: null,
    computed_at: new Date().toISOString(),
  };
}

async function main() {
  if (process.env.DATABASE_URL?.includes("15432")) {
    throw new Error("seam check refused: DATABASE_URL points at the prod tunnel");
  }
  const db = getDb();
  const businessRefId = randomUUID();

  // Day 1: suppressed transition persisted (published cut, raw keep).
  await db.query(UPSERT_DECISION_SNAPSHOTS_QUERY, [
    JSON.stringify([
      snapshotRow({
        businessRefId,
        creativeId: "seam-creative",
        asOfDate: "2026-07-01",
        label: "cut",
        rawLabel: "keep",
        truthSource: "commercial_truth_stale",
        blockedActionType: "cut",
      }),
    ]),
  ]);

  // Day 2 read: production reader must return published cut with raw keep.
  const day2 = await readPreviousPublishedLabels({
    businessId: businessRefId,
    asOf: "2026-07-02",
    creativeIds: ["seam-creative"],
  });
  const memory = day2.get("seam-creative");
  if (!memory || memory.publishedLabel !== "cut" || memory.rawLabel !== "keep") {
    throw new Error(
      `hysteresis seam FAILED: expected published=cut raw=keep, got ${JSON.stringify(memory ?? null)}`,
    );
  }
  const [heldActionRow] = await db.query<{ blocked_action_type: string | null }>(
    `SELECT blocked_action_type
     FROM engine_v3_decision_snapshots_daily
     WHERE business_ref_id = $1::uuid AND creative_id = 'seam-creative'`,
    [businessRefId],
  );
  if (heldActionRow?.blocked_action_type !== "cut") {
    throw new Error(
      `snapshot metadata seam FAILED: expected blocked_action_type=cut, got ${JSON.stringify(heldActionRow ?? null)}`,
    );
  }

  // Same-day rerun must NOT see its own output (strictly before asOf).
  const sameDay = await readPreviousPublishedLabels({
    businessId: businessRefId,
    asOf: "2026-07-01",
    creativeIds: ["seam-creative"],
  });
  if (sameDay.has("seam-creative")) {
    throw new Error(
      "hysteresis seam FAILED: same-day rerun read its own snapshot (must be strictly before asOf)",
    );
  }

  // Upsert conflict path: same day rewrite updates label and raw_label.
  await db.query(UPSERT_DECISION_SNAPSHOTS_QUERY, [
    JSON.stringify([
      snapshotRow({
        businessRefId,
        creativeId: "seam-creative",
        asOfDate: "2026-07-01",
        label: "keep",
        rawLabel: "keep",
      }),
    ]),
  ]);
  const afterRerun = await readPreviousPublishedLabels({
    businessId: businessRefId,
    asOf: "2026-07-02",
    creativeIds: ["seam-creative"],
  });
  const rerunMemory = afterRerun.get("seam-creative");
  if (!rerunMemory || rerunMemory.publishedLabel !== "keep" || rerunMemory.rawLabel !== "keep") {
    throw new Error(
      `hysteresis seam FAILED after rerun upsert: got ${JSON.stringify(rerunMemory ?? null)}`,
    );
  }

  console.log(
    "[seam-check] PASS: snapshot write accepts commercial_truth_stale and readPreviousPublishedLabels round-trips label, raw_label, blocked_action_type, strict-before-asOf, and rerun upsert.",
  );

  // --- Campaign-context hysteresis state seam: the exact class that broke
  // once (fields persisted but dropped on read). Chain two days through the
  // REAL table using the production write query and production parser.
  let state = applyDailyHysteresis(null, "main", "high").state;
  state = applyDailyHysteresis(state, null, "unknown").state; // grace day 1
  state = applyDailyHysteresis(state, null, "conflict").state; // conflict day 1
  await db.query(UPSERT_CONTEXT_QUERY, [
    businessRefId,
    "seam-campaign",
    "Seam Campaign",
    "2026-07-01",
    "main",
    0.8,
    "medium",
    "behavioral",
    "seam-check",
    JSON.stringify({}),
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify(state),
    JSON.stringify({}),
    null,
  ]);
  const persisted = await db.query<{ hysteresis_state_json: unknown }>(
    `SELECT hysteresis_state_json FROM engine_v3_campaign_context_daily
     WHERE business_id = $1 AND campaign_id = 'seam-campaign' AND as_of_date = '2026-07-01'`,
    [businessRefId],
  );
  const roundTripped = parseHysteresisState(persisted[0]?.hysteresis_state_json);
  if (
    roundTripped.stableKind !== state.stableKind ||
    roundTripped.stableClass !== state.stableClass ||
    (roundTripped.graceDaysUsed ?? 0) !== (state.graceDaysUsed ?? 0) ||
    (roundTripped.pendingConflictCount ?? 0) !== (state.pendingConflictCount ?? 0) ||
    roundTripped.pendingCount !== state.pendingCount
  ) {
    throw new Error(
      `context state seam FAILED: wrote ${JSON.stringify(state)}, read back ${JSON.stringify(roundTripped)}`,
    );
  }
  // Continuing the chain from the round-tripped state must behave as if it
  // never left memory: a second conflict day confirms (counter was 1).
  const nextDay = applyDailyHysteresis(roundTripped, null, "conflict");
  if (nextDay.publishedKind !== null || nextDay.publishedClass !== "conflict") {
    throw new Error(
      `context state seam FAILED: second consecutive conflict did not confirm after DB round trip (got ${nextDay.publishedKind}/${nextDay.publishedClass})`,
    );
  }
  console.log(
    "[seam-check] PASS: context hysteresis state round-trips through the real table with counters intact; conflict confirmation survives persistence.",
  );

  // Runtime decision-math seam: target truth must come from bitemporal history,
  // fatigue must compare the latest 14 days with the directly preceding 14,
  // and raw frequency pressure must be account-relative rather than a global
  // 2.5 cliff.
  const ownerId = randomUUID();
  await db.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1::uuid, 'Decision Seam', $2, 'not-used')`,
    [ownerId, `decision-seam-${ownerId}@example.test`],
  );
  await db.query(
    `INSERT INTO businesses (id, name, owner_id, currency)
     VALUES ($1::uuid, 'Decision Seam', $2::uuid, 'USD')`,
    [businessRefId, ownerId],
  );
  await db.query(
    `INSERT INTO business_target_pack_history (
       business_id, business_ref_id, target_roas, break_even_roas,
       default_risk_posture, operation, effective_at, recorded_at
     ) VALUES
       ($1::uuid, $1::uuid, 2.0, 1.5, 'balanced', 'upsert',
        '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z'),
       ($1::uuid, $1::uuid, 9.0, 8.0, 'balanced', 'upsert',
        '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z')`,
    [businessRefId],
  );
  await db.query(
    `INSERT INTO meta_creative_daily (
       business_id, business_ref_id, provider_account_id, date,
       campaign_id, adset_id, ad_id, creative_id, creative_name,
       account_timezone, account_currency, spend, impressions, clicks,
       conversions, revenue, roas, ctr, link_clicks, frequency,
       effective_status, objective, optimization_goal, payload_json,
       first_seen_at, first_spend_at
     )
     SELECT
       $1::text, $1::uuid, 'act_seam', day::date,
       CASE creative_no WHEN 1 THEN 'campaign-a' ELSE 'campaign-' || creative_no::text END,
       CASE creative_no WHEN 1 THEN 'adset-a' ELSE 'adset-' || creative_no::text END,
       CASE creative_no WHEN 1 THEN 'ad-a' ELSE 'ad-' || creative_no::text END,
       CASE creative_no WHEN 1 THEN 'creative-a' ELSE 'creative-' || creative_no::text END,
       CASE creative_no WHEN 1 THEN 'Creative A' ELSE 'Creative ' || creative_no::text END,
       'UTC', 'USD', 20, 1000,
       CASE
         WHEN creative_no = 1 AND day < '2026-06-22'::date THEN 30
         WHEN creative_no = 1 THEN 10
         ELSE 25
       END,
       CASE
         WHEN creative_no = 1 AND day < '2026-06-22'::date THEN 2
         WHEN creative_no = 1 THEN 1
         ELSE 2
       END,
       CASE
         WHEN creative_no = 1 AND day < '2026-06-22'::date THEN 120
         WHEN creative_no = 1 THEN 40
         ELSE 100
       END,
       0, NULL,
       CASE
         WHEN creative_no = 1 AND day < '2026-06-22'::date THEN 30
         WHEN creative_no = 1 THEN 10
         ELSE 25
       END,
       CASE creative_no WHEN 1 THEN 1.2 ELSE 4.0 END,
       'ACTIVE', 'OUTCOME_SALES', 'OFFSITE_CONVERSIONS',
       '{"custom_event_type":"PURCHASE","format":"video"}'::jsonb,
       '2026-06-08T00:00:00Z', '2026-06-08T00:00:00Z'
     FROM generate_series('2026-06-08'::date, '2026-07-05'::date, '1 day') day
     CROSS JOIN generate_series(1, 8) creative_no`,
    [businessRefId],
  );

  const warehouse = new WarehouseDataSource();
  const targetPack = await warehouse.getBusinessTargetPack({
    businessId: businessRefId,
    asOf: "2026-07-05",
  });
  if (targetPack?.targetRoas !== 2 || targetPack.breakEvenRoas !== 1.5) {
    throw new Error(
      `target-history seam FAILED: future target leaked into 2026-07-05 (${JSON.stringify(targetPack)})`,
    );
  }
  const creative = await warehouse.getCreativeInput({
    businessId: businessRefId,
    creativeId: "creative-a",
    asOf: "2026-07-05",
  });
  if (!creative) {
    throw new Error("runtime decision seam FAILED: creative-a did not hydrate");
  }
  if (creative.fatigueStatus !== "none") {
    throw new Error(
      `runtime decision seam FAILED: account-relative frequency falsely produced fatigue=${creative.fatigueStatus}`,
    );
  }
  if (
    creative.contextGrain?.providerAccountCount !== 1 ||
    creative.contextGrain.campaignCount !== 1 ||
    creative.contextGrain.adsetCount !== 1 ||
    creative.contextGrain.optimizationContextCount !== 1
  ) {
    throw new Error(
      `runtime decision seam FAILED: pure context grain did not survive hydration (${JSON.stringify(creative.contextGrain)})`,
    );
  }
  console.log(
    "[seam-check] PASS: bitemporal target cutoff, disjoint prior14 hydration, account-relative frequency pressure, and pure context grain execute against real PostgreSQL.",
  );
  await resetDbClientCache();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
