import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DbClient } from "../../lib/db";
import { buildCanonicalEvaluationProvenance } from "../../lib/creative-decision-engine/canonical-evaluation";
import { buildAdCanonicalEvaluationProvenance, persistAdDecisionEvaluations } from "../../lib/creative-decision-engine/evaluation-store";
import { makeAccountDecisionProfile, makeCreativeInput, makeDataHealth, makeDataLayerHealth } from "../../lib/creative-decision-engine/__tests__/helpers";
import { EMPTY_HYDRATED_CONFIG_AUTHORITY } from "../../lib/creative-decision-engine/native-ad-hydration-authority";
import { NATIVE_AD_ENGINE_VERSION, type DecisionOutput } from "../../lib/creative-decision-engine/types";
import { AD_CALIBRATION_JOB_NAME, NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
  computeNativeAdCalibrationCellSetHash } from "../../lib/creative-decision-engine/jobs/ad-calibration-job";
import { NATIVE_JOB, ident } from "./common";

/** OWNED fixture only (never imported by the executor). Seeds generic native
 * generations through the ACTUAL producer (persistAdDecisionEvaluations) into an
 * owned database migrated by the real run-migrations: a new random tenant,
 * different counts/contexts per generation, real calibration parents. */
const FLAG = "ENGINE_V3_NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITES_ENABLED";
/** ADDED REAL-PRODUCTION INDEX PREREQUISITE (owned sandbox databases only). The
 * exact definition observed read-only in the actual PG16 production catalog
 * (OID 94977158 on table 23020920, valid/ready/live, 1,024,851,968 B; metadata-once
 * receipt sha256 15e1d5d408331da676cfc0e95234551890aead52a8f10936188d183cf69cb21a).
 * run-migrations does NOT create it. D150's global NOT EXISTS refuses without a
 * verified (contract_version,input_hash) index, so owned fixtures add exactly this
 * DDL after run-migrations. No operator path ever executes it anywhere. */
export const OBSERVED_PRODUCTION_REFERENCE_INDEX_DDL =
  "CREATE INDEX idx_engine_v3_ad_evaluations_contract_input ON public.engine_v3_ad_decision_evaluations USING btree (contract_version, input_hash)";
export async function addObservedProductionReferenceIndex(db: Client) {
  await db.query(OBSERVED_PRODUCTION_REFERENCE_INDEX_DDL);
  return { added: "idx_engine_v3_ad_evaluations_contract_input", source: "observed-production-catalog", createdByRunMigrations: false as const };
}
async function insert(db: Client, table: string, row: Record<string, unknown>) {
  const names = Object.keys(row);
  await db.query(`INSERT INTO public.${ident(table)} (${names.map(ident).join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
}
export interface OwnedTenant { business: string; accounts: { ref: string; id: string }[] }
export async function seedTenant(db: Client, accounts = 2): Promise<OwnedTenant> {
  const user = randomUUID(), business = randomUUID();
  await insert(db, "users", { id: user, name: "Owned batch fixture", email: `${user}@example.invalid`, password_hash: "owned-fixture-only" });
  await insert(db, "businesses", { id: business, name: "Owned batch fixture", owner_id: user });
  const out: OwnedTenant = { business, accounts: [] };
  for (let i = 0; i < accounts; i++) {
    const ref = randomUUID(), id = `act_nsb_${ref.slice(0, 8)}`;
    await insert(db, "provider_accounts", { id: ref, provider: "meta", external_account_id: id });
    await insert(db, "business_provider_accounts", { business_id: business, provider: "meta", provider_account_ref_id: ref, provider_account_id: id, is_selected: true });
    out.accounts.push({ ref, id });
  }
  return out;
}
/** One closed calibration producer job + complete batch per account/day. */
export async function seedCalibration(db: Client, t: OwnedTenant, date: string, clock: string) {
  const producer = randomUUID(), hash = "c".repeat(64), epoch = NATIVE_AD_ENGINE_VERSION;
  await insert(db, "engine_v3_job_runs", { id: producer, job_name: AD_CALIBRATION_JOB_NAME, business_ref_id: t.business, business_id: t.business,
    as_of_date: date, engine_version: epoch, status: "success", started_at: clock, finished_at: clock, created_at: clock, row_count: t.accounts.length });
  for (const account of t.accounts) {
    const batch = randomUUID(), cell = randomUUID();
    const common = { business_ref_id: t.business, business_id: t.business, provider: "meta", provider_account_ref_id: account.ref,
      provider_account_id: account.id, as_of_date: date, as_of_cutoff: clock, computed_at: clock, engine_version: epoch,
      policy_version: "owned-batch-fixture", contract_version: NATIVE_AD_CALIBRATION_CONTRACT_VERSION, source_manifest_hash: hash,
      job_run_id: producer, created_at: clock };
    const parentCell = { ...common, id: cell, batch_id: batch, account_timezone: "UTC", account_currency: "USD",
      cell_scope: "objective_cohort_context" as const, objective: "sales", funnel_cohort: "purchase" as const, optimization_context: "0",
      sample_window_start: "2026-06-26", sample_window_end: date, sample_window_days: 90, source_ad_count: 1, source_day_count: 1,
      eligible_ad_count: 1, mature_ad_count: 1, zero_conversion_ad_count: 0, account_cpa_sample_count: 1,
      meta_attributed_aov_purchase_count_90d: 1, meta_attributed_revenue_90d: 100, meta_aov_quality: "low_sample",
      funnel_calibration_json: {}, metric_sample_counts_json: {}, action_readiness_json: {}, quality_counts_json: {},
      config_authority_counts_json: {}, quality_status: "low_sample", target_authority_status: "missing", target_authority_hash: hash,
      batch_input_manifest_hash: hash, input_manifest_hash: hash };
    const cellSet = computeNativeAdCalibrationCellSetHash([{ key: { businessId: t.business, providerAccountRefId: account.ref,
      providerAccountId: account.id, accountTimezone: "UTC", accountCurrency: "USD", cellScope: "objective_cohort_context",
      objective: "sales", cohort: "purchase", optimizationContext: "0" }, inputManifestHash: hash, sourceManifestHash: hash }]);
    await db.query("BEGIN");
    await insert(db, "engine_v3_ad_account_calibration_batches", { ...common, id: batch, transaction_isolation: "repeatable read",
      source_mode: "current_transaction_snapshot", source_provenance_json: { mode: "current_transaction_snapshot", transactionCutoff: clock,
        transactionIsolation: "repeatable read" }, expected_cell_count: 1, generation_content_hash: hash, input_manifest_hash: hash,
      cell_set_hash: cellSet, completeness_status: "writing" });
    await insert(db, "engine_v3_ad_account_calibration_daily", parentCell);
    await db.query("UPDATE engine_v3_ad_account_calibration_batches SET completeness_status='complete',completed_at=$2 WHERE id=$1", [batch, clock]);
    await db.query("COMMIT");
  }
  return producer;
}
/** One native generation through the actual producer, one context per account. */
export async function seedGeneration(db: Client, t: OwnedTenant, input: { date: string; clock: string; finishedAt: string;
  producer: string; perAccount: number[]; snapshots?: boolean; tag: string; engineVersion?: string }) {
  // A non-current engine is only for owned eligibility fixtures: the same actual producer writes its exact receipt epoch.
  const job = randomUUID(), epoch = input.engineVersion ?? NATIVE_AD_ENGINE_VERSION;
  const total = input.perAccount.reduce((a, b) => a + b, 0);
  await insert(db, "engine_v3_job_runs", { id: job, job_name: NATIVE_JOB, business_ref_id: t.business, business_id: t.business,
    as_of_date: input.date, engine_version: epoch, status: "success", started_at: input.clock, finished_at: input.finishedAt,
    created_at: input.clock, row_count: total, dependency_run_id: input.producer });
  const previous = process.env[FLAG]; process.env[FLAG] = "true";
  try {
    for (const [a, count] of input.perAccount.entries()) {
      if (!count) continue;
      const account = t.accounts[a]!;
      const profile = makeAccountDecisionProfile({ businessId: t.business, asOfDate: input.date, scope: { type: "account", id: account.id } });
      const health = makeDataHealth({ calibration: makeDataLayerHealth({ asOfDate: input.date, computedAt: input.clock }) });
      const evaluations = Array.from({ length: count }, (_, index) => {
        const creative = makeCreativeInput({ businessId: t.business, creativeId: `nsb_${input.tag}_${a}_${index}`, campaignId: `nsb_campaign_${index % 3}` });
        creative.creativeName = `Owned batch ${input.tag} İstanbul şğı 🚀 ${index}: ${"Özgün metin 🚀 ".repeat(48)}`;
        const decision: DecisionOutput = { creativeId: creative.creativeId, creativeName: "Owned batch fixture", label: "keep",
          preAuthorityLabel: "keep", authorityBlocker: null, reason: "Owned finite batch fixture", confidence: 40,
          truthSource: "commercial_truth", effectiveTargetRoas: 2, ratioToTarget: 1, badges: [], metrics: { spend: 10, purchases: 1, roas: 2, recent7dRoas: 2 },
          engineVersion: epoch, generatedAt: input.clock };
        const source = `nsb_ctx_${input.tag}_${index % 3}`;
        const base = buildCanonicalEvaluationProvenance({ engineVersion: epoch, accountProfile: profile, dataHealth: health, scope: profile.scope,
          creativeInput: creative, flags: { businessId: t.business, enabled: true, surfaceVisible: false, shadowOnly: true, presetOverride: null,
            source: { enabled: "env", surfaceVisible: "env", shadowOnly: "env", presetOverride: null }, envDefaults: { enabled: true, surfaceVisible: false, shadowOnly: true } },
          campaignContext: { mode: "automatic", source: "system_inferred", campaignId: creative.campaignId, kind: "main", testDimension: null,
            contextTrust: "high", sourceRecordType: "engine_v3_campaign_context_daily", sourceRecordId: source, sourceAsOfDate: input.date,
            sourceUpdatedAt: input.clock, sourceHash: createHash("sha256").update(source, "utf8").digest("hex") },
          decision, rawLabel: "keep", publishedLabel: "keep", hysteresisSuppressed: false, evaluatedAt: input.clock });
        return buildAdCanonicalEvaluationProvenance({ base, identity: { decisionEntityType: "ad", decisionEntityId: `nsb_ad_${input.tag}_${a}_${index}`,
          adId: `nsb_ad_${input.tag}_${a}_${index}`, creativeId: creative.creativeId, providerAccountRefId: account.ref, providerAccountId: account.id },
          adEvidence: { customConversionId: null, configAuthority: EMPTY_HYDRATED_CONFIG_AUTHORITY } });
      });
      const adapter = { query: async (sql: string, values?: unknown[]) => (await db.query(sql, values)).rows } as unknown as DbClient;
      await db.query("BEGIN"); await db.query("SET LOCAL statement_timeout='30000ms'");
      try {
        const stored = await persistAdDecisionEvaluations({ businessId: t.business, asOf: input.date, engineVersion: epoch, scope: profile.scope,
          jobRunId: job, evaluatedAt: input.clock, evaluations }, adapter);
        if (stored.size !== count) throw new Error("OWNED_PRODUCER_LOST_ROWS");
        await db.query("COMMIT");
      } catch (error) { await db.query("ROLLBACK"); throw error; }
    }
  } finally { if (previous === undefined) delete process.env[FLAG]; else process.env[FLAG] = previous; }
  if (input.snapshots) await db.query(`INSERT INTO engine_v3_ad_decision_snapshots_daily
      (business_ref_id,business_id,provider_account_ref_id,provider_account_id,decision_entity_type,decision_entity_id,ad_id,
      creative_id,as_of_date,engine_version,scope_type,scope_id,label,raw_label,confidence,truth_source,effective_target_roas,
      badges,reason,job_run_id,calibration_row_id,evaluation_id,input_hash,decision_hash,computed_at)
      SELECT e.business_ref_id,e.business_id,e.provider_account_ref_id,e.provider_account_id,e.decision_entity_type,e.decision_entity_id,e.ad_id,
      e.creative_id,e.as_of_date,e.engine_version,e.scope_type,e.scope_id,'keep','keep',40,'commercial_truth',2,'[]'::jsonb,
      'Owned batch fixture',e.job_run_id,(SELECT d.id FROM engine_v3_ad_account_calibration_daily d WHERE d.provider_account_ref_id=e.provider_account_ref_id AND d.as_of_date=e.as_of_date LIMIT 1),
      e.id,e.input_hash,e.decision_hash,e.evaluated_at FROM engine_v3_ad_decision_evaluations e WHERE e.job_run_id=$1`, [job]);
  return { jobRunId: job, evaluations: total, contexts: input.perAccount.filter(Boolean).length };
}
