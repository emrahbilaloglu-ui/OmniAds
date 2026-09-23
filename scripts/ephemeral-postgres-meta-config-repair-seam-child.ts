/**
 * Runs only as a child of ephemeral-postgres-migrations-check. Proves that the
 * reviewed config repair uses the migrated audit table and real PostgreSQL
 * transaction/CAS semantics without rewriting metric facts or their clocks.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getDb } from "@/lib/db";
import {
  applyMetaConfigRepairChanges,
  type MetaConfigRepairWriteChange,
  verifyPreviouslyAppliedMetaConfigRepair,
} from "@/lib/meta/config-repair-write";

const LABEL = "meta-config-repair-seam";
const BUSINESS_ID = "meta_config_repair_ephemeral";
const ACCOUNT_ID = "act_meta_config_repair_ephemeral";
const DAY = "2026-07-25";
const CAMPAIGN_ID = "campaign_meta_config_repair_ephemeral";
const ADSET_ID = "adset_meta_config_repair_ephemeral";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[${LABEL}] ${message}`);
}

function assertEphemeralDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert(process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1", "ephemeral seam marker missing");
  assert(url.hostname === "127.0.0.1", "database must be loopback");
  assert(url.port !== "5432" && url.port !== "15432" && Number(url.port) > 0,
    "database port must be a random safe ephemeral port");
}

function source() {
  return {
    kind: "meta_raw_snapshots" as const,
    id: "00000000-0000-4000-8000-000000000e01",
    sourceSnapshotId: "00000000-0000-4000-8000-000000000e01",
    corroboratingSourceSnapshotId: "00000000-0000-4000-8000-000000000e02",
    corroboratingObservedAt: "2026-07-26T12:00:00.000Z",
  };
}

function change(
  scope: MetaConfigRepairWriteChange["scope"], entityId: string,
  field: string, oldValue: unknown, newValue: unknown,
): MetaConfigRepairWriteChange {
  return {
    scope, businessId: BUSINESS_ID, providerAccountId: ACCOUNT_ID,
    date: DAY, accountTimezone: "UTC", entityId, field,
    oldValue, newValue, source: source(),
  };
}

function auditFor(changes: MetaConfigRepairWriteChange[]) {
  return {
    manifestHash: createHash("sha256")
      .update(JSON.stringify(changes)).digest("hex"),
    businessId: BUSINESS_ID, startDate: DAY, endDate: DAY,
  };
}

async function readRows() {
  const sql = getDb();
  const campaign = await sql.query<{
    objective: string | null; daily_budget: number | null;
    spend: number; conversions: number; revenue: number;
    created_at: string; updated_at: string;
  }>(`
    SELECT objective, daily_budget, spend, conversions, revenue,
           created_at::text AS created_at, updated_at::text AS updated_at
    FROM meta_campaign_daily
    WHERE business_id = $1 AND provider_account_id = $2
      AND date = $3::date AND campaign_id = $4
  `, [BUSINESS_ID, ACCOUNT_ID, DAY, CAMPAIGN_ID]);
  const adset = await sql.query<{
    optimization_goal: string | null;
    promoted_object_json: Record<string, unknown> | null;
    spend: number; conversions: number; revenue: number;
    created_at: string; updated_at: string;
  }>(`
    SELECT optimization_goal, promoted_object_json, spend, conversions, revenue,
           created_at::text AS created_at, updated_at::text AS updated_at
    FROM meta_adset_daily
    WHERE business_id = $1 AND provider_account_id = $2
      AND date = $3::date AND adset_id = $4
  `, [BUSINESS_ID, ACCOUNT_ID, DAY, ADSET_ID]);
  assert(campaign.length === 1 && adset.length === 1, "expected one seeded row per grain");
  return { campaign: campaign[0]!, adset: adset[0]! };
}

async function auditRows() {
  return getDb().query<{
    manifest_hash: string; rows_updated: number;
    start_date: string; end_date: string;
    changes_json: MetaConfigRepairWriteChange[];
    applied_at: string;
  }>(`
    SELECT manifest_hash, rows_updated, start_date::text AS start_date,
           end_date::text AS end_date, changes_json,
           applied_at::text AS applied_at
    FROM meta_config_repair_audits WHERE business_id = $1
    ORDER BY applied_at, id
  `, [BUSINESS_ID]);
}

async function seed() {
  const sql = getDb();
  await sql.query(`
    INSERT INTO meta_campaign_daily (
      business_id, provider_account_id, date, campaign_id,
      account_timezone, account_currency, spend, conversions, revenue,
      created_at, updated_at
    ) VALUES ($1, $2, $3::date, $4, 'UTC', 'TRY', 42.15, 3, 99.45,
      '2026-07-26T00:00:00Z'::timestamptz,
      '2026-07-26T00:00:00Z'::timestamptz
    )
  `, [BUSINESS_ID, ACCOUNT_ID, DAY, CAMPAIGN_ID]);
  await sql.query(`
    INSERT INTO meta_adset_daily (
      business_id, provider_account_id, date, campaign_id, adset_id,
      account_timezone, account_currency, spend, conversions, revenue,
      created_at, updated_at
    ) VALUES ($1, $2, $3::date, $4, $5, 'UTC', 'TRY', 21.75, 2, 55.25,
      '2026-07-26T00:00:00Z'::timestamptz,
      '2026-07-26T00:00:00Z'::timestamptz
    )
  `, [BUSINESS_ID, ACCOUNT_ID, DAY, CAMPAIGN_ID, ADSET_ID]);
}

async function main() {
  assertEphemeralDatabase();
  await seed();
  const original = await readRows();
  const changes = [
    change("campaign_daily", CAMPAIGN_ID, "objective", null, "OUTCOME_SALES"),
    change("campaign_daily", CAMPAIGN_ID, "dailyBudget", null, 123.45),
    change("adset_daily", ADSET_ID, "optimizationGoal", null, "VALUE"),
    change("adset_daily", ADSET_ID, "promotedObjectJson", null,
      { pixel_id: "pixel-1", custom_event_type: "PURCHASE" }),
  ];
  const audit = auditFor(changes);
  const applied = await applyMetaConfigRepairChanges(changes, audit);
  assert(applied.rowsUpdated === 2, "expected one guarded update per daily row");
  const written = await readRows();
  assert(written.campaign.objective === "OUTCOME_SALES" &&
    written.campaign.daily_budget === 123.45, "campaign config repair did not land");
  assert(written.adset.optimization_goal === "VALUE" &&
    written.adset.promoted_object_json?.pixel_id === "pixel-1",
  "adset config repair did not land");
  for (const key of ["spend", "conversions", "revenue", "created_at", "updated_at"] as const) {
    assert(written.campaign[key] === original.campaign[key], `campaign ${key} changed`);
    assert(written.adset[key] === original.adset[key], `adset ${key} changed`);
  }
  const audits = await auditRows();
  assert(audits.length === 1 && audits[0]?.manifest_hash === audit.manifestHash,
    "reviewed manifest hash was not recorded exactly once");
  assert(audits[0]?.rows_updated === 2 && audits[0]?.start_date === DAY &&
    audits[0]?.end_date === DAY && Boolean(audits[0]?.applied_at),
  "audit scope/row count/application clock missing");
  assert(isDeepStrictEqual(audits[0]?.changes_json, changes),
    "audit lost source identity or pre/post manifest values");
  const repeated = await verifyPreviouslyAppliedMetaConfigRepair(audit);
  assert(repeated?.alreadyApplied === true && repeated.rowsUpdated === 0,
    "reviewed manifest did not repeat as a verified no-op");

  // A new, conflicting manifest must still fail its second CAS, rolling back
  // the first update AND leaving no audit. A mocked query cannot prove this.
  const conflicting = [
    change("campaign_daily", CAMPAIGN_ID, "objective", "OUTCOME_SALES", "OUTCOME_LEADS"),
    change("adset_daily", ADSET_ID, "optimizationGoal", "LINK_CLICKS", "PURCHASE"),
  ];
  await expectFailure(() => applyMetaConfigRepairChanges(conflicting, auditFor(conflicting)),
    "meta_config_repair_preimage_changed");
  assert(JSON.stringify(await readRows()) === JSON.stringify(written),
    "failed multi-row repair changed a daily fact/config row");
  assert((await auditRows()).length === 1, "failed transaction inserted an audit");

  // The low-level writer refuses the old preimage. The command first calls the
  // verified-audit read above, which is the idempotent replay path.
  await expectFailure(() => applyMetaConfigRepairChanges(changes, audit),
    "meta_config_repair_preimage_changed");
  assert(JSON.stringify(await readRows()) === JSON.stringify(written),
    "manifest replay was not a storage no-op");
  assert((await auditRows()).length === 1, "manifest replay inserted a second audit");

  const sql = getDb();
  await sql.query(`DELETE FROM meta_config_repair_audits WHERE business_id = $1`, [BUSINESS_ID]);
  await sql.query(`DELETE FROM meta_adset_daily WHERE business_id = $1`, [BUSINESS_ID]);
  await sql.query(`DELETE FROM meta_campaign_daily WHERE business_id = $1`, [BUSINESS_ID]);

  console.log(`[${LABEL}] PASS: guarded campaign/adset repair, durable source manifest, unchanged metric clocks/facts, atomic rollback and replay no-op.`);
}

async function expectFailure(operation: () => Promise<unknown>, message: string) {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(message),
      `unexpected error: ${String(error)}`);
    return;
  }
  throw new Error(`[${LABEL}] expected failure: ${message}`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
