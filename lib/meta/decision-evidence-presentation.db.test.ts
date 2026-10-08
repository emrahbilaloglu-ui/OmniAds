import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NATIVE_CALIBRATION_PRESENTATION_JOIN_SQL, NATIVE_CALIBRATION_PRESENTATION_JSON_SQL, readMetaDecisionCalibrationEvidence } from "./decision-evidence-presentation";

describe.runIf(process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1")("original calibration explanation joins on real PostgreSQL", () => {
  let client: import("pg").Client;
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const common = { business_ref_id: id(1), business_id: id(1), provider: "meta", provider_account_ref_id: id(2), provider_account_id: "act_1",
    as_of_date: "2026-10-07", as_of_cutoff: "2026-10-07T14:00:00Z", engine_version: "current", policy_version: "policy",
    contract_version: "engine-v3-native-ad-calibration.v7", input_manifest_hash: "a".repeat(64), source_manifest_hash: "b".repeat(64) };
  const cell = { ...common, id: id(3), batch_id: id(4), batch_input_manifest_hash: common.input_manifest_hash,
    cell_scope: "objective_cohort_context", objective: "sales", funnel_cohort: "purchase", optimization_context: "purchase",
    sample_window_start: "2026-09-08", sample_window_end: "2026-10-06", account_currency: "USD", target_roas: 2, break_even_roas: 1.7,
    meta_attributed_aov_mean_90d: 236.51, meta_attributed_aov_purchase_count_90d: 15,
    action_readiness_json: { scale: { observedSampleCount: 5, requiredSampleCount: 30, ready: false },
      spendUnitAuthority: { basis: "physical_account_purchase_aov_90d", baseSpendUnit: 98.23452569169956,
        accountAovEvidence: { status: "ready", scope: "business_provider_account_currency",
          businessId: common.business_id, providerAccountRefId: common.provider_account_ref_id,
          providerAccountId: common.provider_account_id, accountCurrency: "USD", asOfCutoff: common.as_of_cutoff,
          sampleWindowStart: "2026-07-10", sampleWindowEnd: "2026-10-07",
          meanAov: 196.46905138339912, observedPurchaseCount: 1012 } } } };
  const query = `SELECT ${NATIVE_CALIBRATION_PRESENTATION_JSON_SQL} AS evidence FROM engine_v3_ad_decision_snapshots_daily snapshot ${NATIVE_CALIBRATION_PRESENTATION_JOIN_SQL}`;
  const insert = async (table: string, data: unknown) => client.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(data)]);
  beforeAll(async () => {
    const { Client } = await import("pg"); client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
    await client.query(`
      CREATE TEMP TABLE engine_v3_ad_account_calibration_daily (
        id uuid PRIMARY KEY, batch_id uuid, business_ref_id uuid, business_id text, provider text, provider_account_ref_id uuid, provider_account_id text,
        as_of_date date, as_of_cutoff timestamptz, engine_version text, policy_version text, contract_version text,
        input_manifest_hash text, batch_input_manifest_hash text, source_manifest_hash text, cell_scope text, objective text, funnel_cohort text,
        optimization_context text, sample_window_start date, sample_window_end date, account_currency text, target_roas float8, break_even_roas float8,
        meta_attributed_aov_mean_90d float8, meta_attributed_aov_purchase_count_90d integer, action_readiness_json jsonb);
      CREATE TEMP TABLE engine_v3_ad_account_calibration_batches (
        id uuid PRIMARY KEY, business_ref_id uuid, business_id text, provider text, provider_account_ref_id uuid, provider_account_id text,
        as_of_date date, as_of_cutoff timestamptz, engine_version text, policy_version text, contract_version text,
        input_manifest_hash text, source_manifest_hash text, completeness_status text, completed_at timestamptz);
      CREATE TEMP TABLE engine_v3_ad_decision_snapshots_daily (
        calibration_row_id uuid, business_ref_id uuid, business_id text, provider_account_ref_id uuid, provider_account_id text, as_of_date date, engine_version text);
    `);
  });
  beforeEach(async () => {
    await client.query("TRUNCATE engine_v3_ad_account_calibration_daily,engine_v3_ad_account_calibration_batches,engine_v3_ad_decision_snapshots_daily");
    await insert("engine_v3_ad_account_calibration_daily", cell);
    await insert("engine_v3_ad_account_calibration_batches", { ...common, id: id(4), completeness_status: "complete", completed_at: common.as_of_cutoff });
    await insert("engine_v3_ad_decision_snapshots_daily", { ...common, calibration_row_id: id(3) });
  });
  afterAll(async () => { await client?.end(); });
  it("uses the original cell even when a later same-day batch has 99 samples", async () => {
    await insert("engine_v3_ad_account_calibration_daily", { ...cell, id: id(5), batch_id: id(6), action_readiness_json: { scale: { observedSampleCount: 99, requiredSampleCount: 30, ready: true } } });
    await insert("engine_v3_ad_account_calibration_batches", { ...common, id: id(6), completeness_status: "complete", completed_at: "2026-10-07T16:00:00Z" });
    const value = readMetaDecisionCalibrationEvidence((await client.query(query)).rows[0].evidence);
    expect(value).toMatchObject({ rowId: id(3), batchId: id(4), readiness: { scale: { observed: 5, required: 30, ready: false } } });
    expect(value).toMatchObject({ metaAov: 196.46905138339912, metaAovPurchases: 1012,
      metaAovWindowStart: "2026-07-10", metaAovWindowEnd: "2026-10-07" });
    expect(value!.metaAov! / value!.targetRoas!).toBeCloseTo(value!.baseSpendUnit!, 10);
  });
  it("keeps a missing physical-account receipt unknown while the calibration sample remains readable", async () => {
    await client.query("UPDATE engine_v3_ad_account_calibration_daily SET action_readiness_json=action_readiness_json #- '{spendUnitAuthority,accountAovEvidence}'");
    const value = readMetaDecisionCalibrationEvidence((await client.query(query)).rows[0].evidence);
    expect(value).toMatchObject({ metaAov: null, metaAovPurchases: null, readiness: { scale: { observed: 5, required: 30 } } });
  });
  it("never borrows another account's referenced cell", async () => {
    await client.query("UPDATE engine_v3_ad_account_calibration_daily SET provider_account_id='act_foreign'");
    expect((await client.query(query)).rows[0].evidence).toBeNull();
  });
  it("refuses mismatched batch hash, cutoff, contract or incomplete publication", async () => {
    for (const [column, bad, good] of [
      ["input_manifest_hash", "c".repeat(64), common.input_manifest_hash],
      ["as_of_cutoff", "2026-10-07T16:00:00Z", common.as_of_cutoff],
      ["contract_version", "different", common.contract_version],
      ["completeness_status", "writing", "complete"],
    ]) {
      await client.query(`UPDATE engine_v3_ad_account_calibration_batches SET ${column}=$1`, [bad]);
      expect((await client.query(query)).rows[0].evidence).toBeNull();
      await client.query(`UPDATE engine_v3_ad_account_calibration_batches SET ${column}=$1`, [good]);
    }
  });
  it("keeps absent references unknown rather than choosing any current cell", async () => {
    await client.query("UPDATE engine_v3_ad_decision_snapshots_daily SET calibration_row_id=NULL");
    expect((await client.query(query)).rows[0].evidence).toBeNull();
  });
});
