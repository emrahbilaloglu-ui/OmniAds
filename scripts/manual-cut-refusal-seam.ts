/** Called only by the isolated native-ad PostgreSQL seam, never a live task. */
import assert from "node:assert/strict";
import type { Client } from "pg";
import type { DbClient } from "@/lib/db";
import { buildCanonicalEvaluationProvenance, canonicalSha256 } from "@/lib/creative-decision-engine/canonical-evaluation";
import { buildAdCanonicalEvaluationProvenance, persistAdDecisionEvaluations, INSERT_AD_EVALUATION_CONTEXT_QUERY, INSERT_AD_DECISION_EVALUATIONS_QUERY, INSERT_AD_DECISION_INPUT_EVIDENCE_QUERY } from "@/lib/creative-decision-engine/evaluation-store";
import { makeAccountDecisionProfile, makeCreativeInput, makeDataHealth } from "@/lib/creative-decision-engine/__tests__/helpers";
import { EMPTY_HYDRATED_CONFIG_AUTHORITY } from "@/lib/creative-decision-engine/native-ad-hydration-authority";
import { NATIVE_AD_ENGINE_VERSION, type DecisionOutput } from "@/lib/creative-decision-engine/types";
import { upsertNativeAdDecisionSnapshots, type NativeSnapshotPayloadRow } from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { readNativeSnapshotRows, buildNativeMetaCanonicalDecisionInventory } from "@/lib/meta/decisions-workspace-read-model";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";

export async function verifyManualCutRefusalRoundTrip(input: {
  client: Client; db: DbClient; businessId: string; accountId: string; accountRefId: string; asOf: string; cutoff: string;
  snapshotFactory: (input: { jobRunId: string; adId: string; evaluationId: string; inputHash: string; decisionHash: string; label: "cut" }) => NativeSnapshotPayloadRow;
}) {
  const { client, db, businessId, accountId, accountRefId, asOf, cutoff } = input;
  // Complete only the presentation columns absent from this seam's minimal
  // hydration schema, then execute the actual production snapshot reader.
  await client.query(`
    CREATE TABLE IF NOT EXISTS meta_creative_media (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE IF NOT EXISTS meta_campaign_dimensions (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE IF NOT EXISTS meta_adset_dimensions (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
    ALTER TABLE meta_creative_dimensions ADD COLUMN thumbnail_url TEXT, ADD COLUMN source_updated_at TIMESTAMPTZ;
    ALTER TABLE engine_v3_creative_lifecycle_daily ADD COLUMN business_id TEXT;
    ALTER TABLE meta_creative_media ADD COLUMN business_id TEXT, ADD COLUMN provider_account_id TEXT,
      ADD COLUMN creative_id TEXT, ADD COLUMN date DATE, ADD COLUMN updated_at TIMESTAMPTZ,
      ADD COLUMN table_thumbnail_url TEXT, ADD COLUMN thumbnail_url TEXT, ADD COLUMN card_preview_url TEXT,
      ADD COLUMN poster_url TEXT, ADD COLUMN image_url TEXT, ADD COLUMN preview_url TEXT,
      ADD COLUMN video_url TEXT, ADD COLUMN payload_json JSONB;
    ALTER TABLE meta_campaign_dimensions ADD COLUMN business_id TEXT, ADD COLUMN provider_account_id TEXT,
      ADD COLUMN campaign_id TEXT, ADD COLUMN campaign_name_current TEXT, ADD COLUMN campaign_name_historical TEXT,
      ADD COLUMN updated_at TIMESTAMPTZ;
    ALTER TABLE meta_adset_dimensions ADD COLUMN business_id TEXT, ADD COLUMN provider_account_id TEXT,
      ADD COLUMN adset_id TEXT, ADD COLUMN adset_name_current TEXT, ADD COLUMN adset_name_historical TEXT,
      ADD COLUMN updated_at TIMESTAMPTZ;
  `);
  const jobRunId = "00000000-0000-4000-8000-000000000994";
  await client.query(`INSERT INTO engine_v3_job_runs (id, job_name, business_ref_id, business_id, as_of_date, engine_version, status)
    VALUES ($1, 'manual-refusal-seam', $2::uuid, $2, $3, $4, 'success')`, [jobRunId, businessId, asOf, NATIVE_AD_ENGINE_VERSION]);
  const profile = makeAccountDecisionProfile({ businessId, asOfDate: asOf, scope: { type: "account", id: accountId } });
  const build = (adId: string) => {
    const creativeInput = makeCreativeInput({ businessId, creativeId: `creative-${adId}` });
    const decision: DecisionOutput = {
      creativeId: creativeInput.creativeId, creativeName: "Refused Cut seam", label: "cut",
      preAuthorityLabel: "cut", authorityBlocker: null, reason: "Recorded Cut with missing configuration proof",
      confidence: 60, truthSource: "commercial_truth", effectiveTargetRoas: 2, ratioToTarget: 0.3, badges: [],
      metrics: { spend: 100, purchases: 2, roas: 0.6, recent7dRoas: 0.6 }, engineVersion: NATIVE_AD_ENGINE_VERSION, generatedAt: cutoff,
    };
    const base = buildCanonicalEvaluationProvenance({ engineVersion: NATIVE_AD_ENGINE_VERSION, accountProfile: profile,
      dataHealth: makeDataHealth(), flags: { businessId, enabled: true, surfaceVisible: false, shadowOnly: true, presetOverride: null,
        source: { enabled: "env", surfaceVisible: "env", shadowOnly: "env", presetOverride: null }, envDefaults: { enabled: true, surfaceVisible: false, shadowOnly: true } },
      scope: profile.scope, creativeInput, campaignContext: { mode: "automatic", source: "system_inferred", campaignId: creativeInput.campaignId, kind: null, testDimension: null, contextTrust: null },
      decision, rawLabel: "cut", publishedLabel: "cut", hysteresisSuppressed: false, evaluatedAt: cutoff });
    return buildAdCanonicalEvaluationProvenance({ base,
      identity: { decisionEntityType: "ad", decisionEntityId: adId, adId, creativeId: creativeInput.creativeId, providerAccountRefId: accountRefId, providerAccountId: accountId },
      adEvidence: { customConversionId: null, configAuthority: {
        ...EMPTY_HYDRATED_CONFIG_AUTHORITY,
        decisionEconomics: { fullyVerified: false, economicDayCount: 2, unverifiedEconomicDayCount: 1, receiptManifest: null,
          economicDays: [{ date: "2026-07-11", dayClass: "none", spend: 19 }, { date: "2026-07-12", dayClass: "decision_authority", spend: 23 }] },
        counts: { ...EMPTY_HYDRATED_CONFIG_AUTHORITY.counts, noneSpend: 19, noneDays: 1, decisionAuthorityDays: 1, decisionAuthoritySpend: 23 },
      } }, manualCutAdvisoryRefusal: "current_config_unobserved" });
  };
  const newAd = "120000000000990001", oldAd = "120000000000990002";
  const current = build(newAd);
  const stored = [...(await persistAdDecisionEvaluations({ businessId, asOf, engineVersion: NATIVE_AD_ENGINE_VERSION,
    scope: profile.scope, jobRunId, evaluatedAt: cutoff, evaluations: [current] }, db)).values()][0]!;

  // A genuine previous-encoding fixture: remove the new field and rehash all
  // three v19 envelopes. Do not relabel v20 hashes as v19 compatibility proof.
  const seed = build(oldAd), version = "engine-v3-canonical-ad-evaluation.v19";
  const contextPayload: Record<string, unknown> = { ...seed.contextPayload, contractVersion: version };
  const contextHash = canonicalSha256(contextPayload);
  const config = { ...(seed.inputPayload.configEvidence as Record<string, unknown>) };
  delete config.manualCutAdvisoryRefusal;
  delete (config.decisionEconomics as Record<string, unknown>).economicDays;
  const inputPayload = { ...seed.inputPayload, contractVersion: version, contextHash, configEvidence: config };
  const inputHash = canonicalSha256(inputPayload);
  const decisionPayload: Record<string, unknown> = { ...seed.decisionPayload, contractVersion: version, contextHash, inputHash };
  const decisionHash = canonicalSha256(decisionPayload);
  const context = await client.query<{ id: string }>(INSERT_AD_EVALUATION_CONTEXT_QUERY, [businessId, businessId, accountRefId, accountId, asOf, NATIVE_AD_ENGINE_VERSION, "account", accountId, version,
    JSON.stringify(contextPayload), JSON.stringify(contextPayload.accountProfile), JSON.stringify(contextPayload.dataHealth), JSON.stringify(contextPayload.flags), contextHash, jobRunId, cutoff]);
  await client.query(INSERT_AD_DECISION_INPUT_EVIDENCE_QUERY, [JSON.stringify([{ contract_version: version, input_hash: inputHash,
    input_evidence_json: { configEvidence: config, metricContract: seed.inputPayload.metricContract } }])]);
  const legacy = await client.query<{ id: string }>(INSERT_AD_DECISION_EVALUATIONS_QUERY, [JSON.stringify([{
    context_id: context.rows[0]!.id, business_ref_id: businessId, business_id: businessId, provider_account_ref_id: accountRefId, provider_account_id: accountId,
    decision_entity_type: "ad", decision_entity_id: oldAd, ad_id: oldAd, creative_id: seed.identity.creativeId, as_of_date: asOf,
    engine_version: NATIVE_AD_ENGINE_VERSION, scope_type: "account", scope_id: accountId, contract_version: version,
    creative_input_json: seed.inputPayload.creativeInput, campaign_context_json: seed.inputPayload.campaignContext,
    prior_hysteresis_json: seed.inputPayload.priorHysteresis, decision_output_json: decisionPayload.decision, raw_label: "cut",
    hysteresis_suppressed: false, input_hash: inputHash, decision_hash: decisionHash, job_run_id: jobRunId, evaluated_at: cutoff,
  }])]);
  const payloads = [
    { adId: newAd, evaluationId: stored.evaluationId, inputHash: stored.inputHash, decisionHash: stored.decisionHash },
    { adId: oldAd, evaluationId: legacy.rows[0]!.id, inputHash, decisionHash },
  ].map((lineage) => ({ ...input.snapshotFactory({ jobRunId, label: "cut", ...lineage }),
    creative_id: `creative-${lineage.adId}`, confidence: 60, authority_blocker: "config_source_authority" as const,
    blocked_action_type: "cut" as const, authorized_action: null }));
  await upsertNativeAdDecisionSnapshots(payloads, db);
  const generation = { jobRunId, asOfDate: asOf, providerAccountRefId: accountRefId, expectedAdCount: 2,
    manifestHash: hashAdDecisionIdentityManifest({ businessId, providerAccountId: accountId, asOfDate: asOf, adIds: [newAd, oldAd] }) };
  const snapshotRows = await readNativeSnapshotRows({ businessId, providerAccountId: accountId, generation }, db);
  const inventory = buildNativeMetaCanonicalDecisionInventory({ businessId, providerAccountId: accountId, generation, snapshotRows, generatedAt: cutoff });
  assert.equal(inventory.status, "available", JSON.stringify(inventory));
  assert.equal(inventory.items.find((item) => item.parentChain.ad?.id === newAd)?.manualCutRefusal?.code, "current_config_unobserved");
  assert.equal(inventory.items.find((item) => item.parentChain.ad?.id === oldAd)?.manualCutRefusal?.code, "not_recorded");
  assert.deepEqual(inventory.items.find((item) => item.parentChain.ad?.id === newAd)?.configEvidence?.historyCoverage,
    { economicDayCount: 2, unverifiedEconomicDayCount: 1, unverifiedSpend: 19, unverifiedDates: ["2026-07-11"] });
  assert.equal(inventory.items.find((item) => item.parentChain.ad?.id === oldAd)?.configEvidence?.historyCoverage?.unverifiedDates, null);
  for (const item of inventory.items) {
    assert.equal(item.sourceAuthority?.actionEligible, false);
    assert.equal(item.sourceAuthority?.authorizedAction, null);
    assert.equal(item.manualCutAdvisory, null);
  }
  console.log("[native-ad-seam] PASS v20 persisted refusal and dated config gaps, genuine v19 absence through production snapshot reader and canonical inventory");
}
