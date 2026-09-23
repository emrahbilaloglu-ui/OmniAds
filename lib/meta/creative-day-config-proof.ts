/**
 * Certify a v2 creative-day's HISTORICAL configuration from the same D098
 * provider receipts used by native Ad decisions. This is a narrow positive
 * lane: a current Ad detail response or a dated Insights result is never a
 * historical configuration receipt. The caller persists a returned proof only
 * together with its returned values, and the decision reader must also compare
 * the proof's certification/receipt clocks with its evaluation cutoff.
 */
import { getDb, runDbTransaction } from "@/lib/db";
import {
  buildMetaAdsetConfigFieldSourceSql,
  buildMetaConfigFieldSourceSql,
  type MetaConfigFieldTier,
} from "@/lib/meta/config-field-source-contract";
import {
  parseConfigFieldEvidenceRef,
  type ConfigFieldEvidenceRef,
} from "@/lib/meta/config-field-evidence-ref";
import { resolveNativeAdConfigAuthority } from "@/lib/meta/config-field-readiness";
import { resolveMetaFunnelCohortFromConfigOnly } from "@/lib/meta/funnel-cohort";
import { META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION } from "@/lib/meta/creatives-types";

const BRACKETED = new Set<MetaConfigFieldTier>([
  "provider_receipt_day_bracketed",
  "provider_receipt_legacy_bracketed",
]);

const campaign = buildMetaConfigFieldSourceSql({
  dayExpression: "d.date", timezoneExpression: "d.account_timezone",
  businessParam: "$1::text", accountExpression: "d.provider_account_id",
  campaignExpression: "d.campaign_id", scopeStartParam: "$3", scopeEndParam: "$3",
  evaluationCutoffParam: "$4", accountScopeSql: "SELECT $2::text",
  campaignScopeSql: "SELECT DISTINCT campaign_id FROM candidates",
  scopeRelationSql: "SELECT DISTINCT provider_account_id, campaign_id, date, account_timezone FROM candidates",
  aliasPrefix: "creative_proof_campaign",
});
const adset = buildMetaAdsetConfigFieldSourceSql({
  dayExpression: "d.date", timezoneExpression: "d.account_timezone",
  businessParam: "$1::text", accountExpression: "d.provider_account_id",
  adsetExpression: "d.adset_id", scopeStartParam: "$3", scopeEndParam: "$3",
  evaluationCutoffParam: "$4", accountScopeSql: "SELECT $2::text",
  adsetScopeSql: "SELECT DISTINCT adset_id FROM candidates",
  scopeRelationSql: "SELECT DISTINCT provider_account_id, adset_id, date, account_timezone FROM candidates",
  aliasPrefix: "creative_proof_adset",
});

/** One account/day per call, bounded by the passed knowledge cutoff. */
export const CREATIVE_DAY_CONFIG_PROOF_SQL = `WITH candidates AS MATERIALIZED (
  SELECT creative_id, provider_account_id, date, account_timezone,
    campaign_id, adset_id, objective AS existing_objective,
    optimization_goal AS existing_optimization_goal,
    COALESCE(payload_json->>'custom_event_type', payload_json->>'customEventType')
      AS existing_custom_event_type,
    COALESCE(payload_json->>'custom_conversion_id', payload_json->>'customConversionId')
      AS existing_custom_conversion_id,
    payload_json->>'historical_config_provenance' AS existing_historical_config_provenance
  FROM meta_creative_daily c
  WHERE c.business_id = $1 AND c.provider_account_id = $2 AND c.date = $3::date
    AND c.payload_json->>'source_identity_version' = '${META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION}'
    AND c.payload_json->>'source_parent_grain_complete' = 'true'
    AND c.payload_json->>'source_ad_ids_complete' = 'true'
    AND c.payload_json->'source_creative_ids' = jsonb_build_array(c.creative_id)
    AND NULLIF(BTRIM(c.campaign_id), '') IS NOT NULL
    AND NULLIF(BTRIM(c.adset_id), '') IS NOT NULL
    AND NULLIF(BTRIM(c.account_timezone), '') IS NOT NULL
    AND jsonb_typeof(c.payload_json->'source_ad_ids') = 'array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(c.payload_json->'source_ad_ids') = 'array'
      THEN c.payload_json->'source_ad_ids' ELSE '[]'::jsonb END) > 0
    AND c.payload_json->>'associated_ads_count' = jsonb_array_length(CASE
      WHEN jsonb_typeof(c.payload_json->'source_ad_ids') = 'array'
      THEN c.payload_json->'source_ad_ids' ELSE '[]'::jsonb END)::text
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(CASE
        WHEN jsonb_typeof(c.payload_json->'source_ad_ids') = 'array'
        THEN c.payload_json->'source_ad_ids' ELSE '[]'::jsonb END) member(ad_id)
      LEFT JOIN meta_ad_daily ad
        ON ad.business_id=c.business_id AND ad.provider_account_id=c.provider_account_id
       AND ad.date=c.date AND ad.ad_id=member.ad_id
      WHERE ad.ad_id IS NULL
        OR ad.account_timezone IS DISTINCT FROM c.account_timezone
        OR ad.campaign_id IS DISTINCT FROM c.campaign_id
        OR ad.adset_id IS DISTINCT FROM c.adset_id
        OR ad.truth_state IS DISTINCT FROM 'finalized'
        OR ad.validation_status IS DISTINCT FROM 'passed'
        OR ad.source_snapshot_id IS NULL OR ad.source_run_id IS NULL
        OR ad.finalized_at IS NULL OR ad.finalized_at >= $4::timestamptz
        OR ad.created_at IS NULL OR ad.created_at >= $4::timestamptz
        OR ad.updated_at IS NULL OR ad.updated_at >= $4::timestamptz
    )
    AND (SELECT COUNT(*) = COUNT(DISTINCT member.ad_id)
      FROM jsonb_array_elements_text(CASE
        WHEN jsonb_typeof(c.payload_json->'source_ad_ids') = 'array'
        THEN c.payload_json->'source_ad_ids' ELSE '[]'::jsonb END) member(ad_id))
),
${campaign.withSql},
${adset.withSql}
SELECT d.creative_id, d.account_timezone, d.existing_objective,
  d.existing_optimization_goal, d.existing_custom_event_type,
  d.existing_custom_conversion_id, d.existing_historical_config_provenance,
  ${campaign.valueSql("objective")} AS objective,
  ${campaign.tierSql("objective")} AS objective_tier,
  ${campaign.readinessSql("objective")} AS objective_readiness,
  ${campaign.evidenceRefSql("objective")} AS objective_ref,
  ${adset.valueSql("optimization_goal")} AS optimization_goal,
  ${adset.tierSql("optimization_goal")} AS optimization_goal_tier,
  ${adset.readinessSql("optimization_goal")} AS optimization_goal_readiness,
  ${adset.evidenceRefSql("optimization_goal")} AS optimization_goal_ref,
  ${adset.valueSql("custom_event_type")} AS custom_event_type,
  ${adset.tierSql("custom_event_type")} AS custom_event_type_tier,
  ${adset.readinessSql("custom_event_type")} AS custom_event_type_readiness,
  ${adset.evidenceRefSql("custom_event_type")} AS custom_event_type_ref,
  ${adset.valueSql("custom_conversion_id")} AS custom_conversion_id,
  ${adset.tierSql("custom_conversion_id")} AS custom_conversion_id_tier,
  ${adset.readinessSql("custom_conversion_id")} AS custom_conversion_id_readiness,
  ${adset.evidenceRefSql("custom_conversion_id")} AS custom_conversion_id_ref
FROM candidates d
${campaign.lateralSql}
${adset.lateralSql}
ORDER BY d.creative_id`;

export interface CreativeDayConfigProofRow {
  creative_id: string;
  account_timezone: string | null;
  existing_objective: string | null;
  existing_optimization_goal: string | null;
  existing_custom_event_type: string | null;
  existing_custom_conversion_id: string | null;
  existing_historical_config_provenance: string | null;
  objective: string | null;
  objective_tier: string | null;
  objective_readiness: string | null;
  objective_ref: unknown;
  optimization_goal: string | null;
  optimization_goal_tier: string | null;
  optimization_goal_readiness: string | null;
  optimization_goal_ref: unknown;
  custom_event_type: string | null;
  custom_event_type_tier: string | null;
  custom_event_type_readiness: string | null;
  custom_event_type_ref: unknown;
  custom_conversion_id: string | null;
  custom_conversion_id_tier: string | null;
  custom_conversion_id_readiness: string | null;
  custom_conversion_id_ref: unknown;
}

export interface CreativeDayConfigProof {
  historical_config_provenance:
    | "provider_receipt_day_bracketed"
    | "provider_receipt_legacy_bracketed";
  historical_config_proof: {
    knowledge_cutoff_at: string;
    certified_at: string;
    last_receipt_observed_at: string;
    objective: string;
    optimization_goal: string;
    custom_event_type: string | null;
    custom_conversion_id: string | null;
    receipt_refs: {
      objective: ConfigFieldEvidenceRef;
      optimization_goal: ConfigFieldEvidenceRef;
      custom_event_type: ConfigFieldEvidenceRef;
      custom_conversion_id: ConfigFieldEvidenceRef;
    };
  };
}

export type CreativeDayConfigProofVerdict =
  | { creativeId: string; status: "verified"; proof: CreativeDayConfigProof }
  | { creativeId: string; status: "unverified"; reason: string };

function token(value: string | null): string | null {
  const text = value?.trim().toUpperCase().replace(/[\s-]+/g, "_") ?? "";
  return text || null;
}

function exactId(value: string | null): string | null {
  return value?.trim() || null;
}

function atOrBefore(value: string | null, cutoff: string): boolean {
  return value !== null && Number.isFinite(Date.parse(value)) &&
    Date.parse(value) <= Date.parse(cutoff);
}

/** Pure fail-closed check; useful for a reviewed repair manifest and tests. */
export function evaluateCreativeDayConfigProof(
  row: CreativeDayConfigProofRow,
  knowledgeCutoffAt: string,
  certifiedAt: string,
): CreativeDayConfigProofVerdict {
  const reject = (reason: string): CreativeDayConfigProofVerdict => ({
    creativeId: row.creative_id, status: "unverified", reason,
  });
  if (!Number.isFinite(Date.parse(knowledgeCutoffAt)) ||
      !Number.isFinite(Date.parse(certifiedAt)) ||
      Date.parse(certifiedAt) < Date.parse(knowledgeCutoffAt)) {
    return reject("invalid_proof_clock");
  }
  if (!row.account_timezone?.trim()) return reject("provider_timezone_missing");
  const existingPositive = row.existing_historical_config_provenance ===
    "provider_receipt_day_bracketed" || row.existing_historical_config_provenance ===
    "provider_receipt_legacy_bracketed";
  if (!existingPositive && row.existing_historical_config_provenance !== "unverified") {
    return reject("existing_config_origin_unknown");
  }
  const fields = ["objective", "optimization_goal", "custom_event_type", "custom_conversion_id"] as const;
  const refs = {} as Record<(typeof fields)[number], ConfigFieldEvidenceRef>;
  for (const field of fields) {
    const value = row[field];
    const tier = row[`${field}_tier`];
    const absent = !value &&
      (field === "custom_event_type" || field === "custom_conversion_id") &&
      tier === "observed_absent" && row[`${field}_readiness`] === "none";
    if (!absent && (!value || !BRACKETED.has(tier as MetaConfigFieldTier) ||
        row[`${field}_readiness`] !== "decision_authority")) {
      return reject(`${field}_not_day_bracketed`);
    }
    const parsed = parseConfigFieldEvidenceRef(row[`${field}_ref`], field);
    if (!parsed.ok || parsed.ref.tier !== tier ||
        parsed.ref.readiness !== row[`${field}_readiness`] ||
        parsed.ref.pitClass !== "as_of_known") {
      return reject(`${field}_receipt_incoherent`);
    }
    if (!atOrBefore(parsed.ref.observedAt, knowledgeCutoffAt) ||
        (!absent && !atOrBefore(parsed.ref.corroboratingObservedAt, knowledgeCutoffAt))) {
      return reject(`${field}_receipt_after_cutoff`);
    }
    refs[field] = parsed.ref;
  }
  /* Unverified creative-day values came from mutable current Ad detail. The
     receipt corrects them; they must not veto a source-backed repair. A value
     already certified by a receipt, however, may never be silently replaced by
     a contradictory receipt under the same authority marker. */
  if (existingPositive && (
      token(row.existing_objective) && token(row.existing_objective) !== token(row.objective) ||
      token(row.existing_optimization_goal) && token(row.existing_optimization_goal) !== token(row.optimization_goal) ||
      token(row.existing_custom_event_type) && token(row.existing_custom_event_type) !== token(row.custom_event_type) ||
      exactId(row.existing_custom_conversion_id) &&
        exactId(row.existing_custom_conversion_id) !== exactId(row.custom_conversion_id))) {
    return reject("warehouse_config_value_disagrees_with_receipt");
  }
  const cohort = resolveMetaFunnelCohortFromConfigOnly({
    objective: row.objective, optimizationGoal: row.optimization_goal,
    customEventType: row.custom_event_type,
  });
  if (cohort === "unknown") return reject("config_cohort_unknown");
  const authority = resolveNativeAdConfigAuthority({
    cohort, objectiveTier: row.objective_tier,
    objectiveReadiness: row.objective_readiness,
    optimizationGoalTier: row.optimization_goal_tier,
    optimizationGoalReadiness: row.optimization_goal_readiness,
    customEventTypeTier: row.custom_event_type_tier,
    customEventTypeReadiness: row.custom_event_type_readiness,
    customEventType: row.custom_event_type,
    customConversionId: row.custom_conversion_id,
    customConversionIdReadiness: row.custom_conversion_id_readiness,
  });
  if (authority.readiness !== "decision_authority") {
    return reject(`config_semantics_${authority.blockingField ?? "unknown"}`);
  }
  const typedRefs = refs as {
    objective: ConfigFieldEvidenceRef; optimization_goal: ConfigFieldEvidenceRef;
    custom_event_type: ConfigFieldEvidenceRef; custom_conversion_id: ConfigFieldEvidenceRef;
  };
  const latest = [typedRefs.objective, typedRefs.optimization_goal,
    typedRefs.custom_event_type, typedRefs.custom_conversion_id]
    .flatMap((ref) => [ref.observedAt, ref.corroboratingObservedAt])
    .filter((value): value is string => value !== null).sort().at(-1);
  if (!latest) return reject("receipt_clock_missing");
  const legacy = [typedRefs.objective, typedRefs.optimization_goal,
    typedRefs.custom_event_type, typedRefs.custom_conversion_id]
    .some((ref) => ref.tier === "provider_receipt_legacy_bracketed");
  return { creativeId: row.creative_id, status: "verified", proof: {
    historical_config_provenance: legacy
      ? "provider_receipt_legacy_bracketed" : "provider_receipt_day_bracketed",
    historical_config_proof: {
      knowledge_cutoff_at: knowledgeCutoffAt, certified_at: certifiedAt,
      last_receipt_observed_at: latest,
      objective: row.objective!, optimization_goal: row.optimization_goal!,
      custom_event_type: row.custom_event_type,
      custom_conversion_id: row.custom_conversion_id,
      receipt_refs: typedRefs,
    },
  } };
}

export async function readCreativeDayConfigProofs(input: {
  businessId: string; providerAccountId: string; day: string;
  knowledgeCutoffAt: string; certifiedAt?: string;
}): Promise<CreativeDayConfigProofVerdict[]> {
  const certifiedAt = input.certifiedAt ?? new Date().toISOString();
  const rows = await getDb().query<CreativeDayConfigProofRow>(
    CREATIVE_DAY_CONFIG_PROOF_SQL,
    [input.businessId, input.providerAccountId, input.day, input.knowledgeCutoffAt],
  );
  return rows.map((row) => evaluateCreativeDayConfigProof(
    row, input.knowledgeCutoffAt, certifiedAt,
  ));
}

/** Keep the proof and the values it certifies on the same physical row. */
export function buildCertifiedConfigPayload(
  oldPayload: unknown, proof: CreativeDayConfigProof,
): Record<string, unknown> {
  const payload = oldPayload && typeof oldPayload === "object" && !Array.isArray(oldPayload)
    ? oldPayload as Record<string, unknown> : {};
  const config = proof.historical_config_proof;
  return {
    ...payload,
    objective: config.objective,
    optimization_goal: config.optimization_goal,
    custom_event_type: config.custom_event_type,
    customEventType: config.custom_event_type,
    custom_conversion_id: config.custom_conversion_id,
    customConversionId: config.custom_conversion_id,
    historical_config_provenance: proof.historical_config_provenance,
    historical_config_proof: config,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

/** A repeated receipt must not rewrite the row merely because sync ran again. */
export function sameCertifiedConfigEvidence(
  oldPayload: unknown,
  oldObjective: string | null,
  oldGoal: string | null,
  proof: CreativeDayConfigProof,
): boolean {
  if (!oldPayload || typeof oldPayload !== "object" || Array.isArray(oldPayload)) return false;
  const payload = oldPayload as Record<string, unknown>;
  const previous = payload.historical_config_proof;
  if (!previous || typeof previous !== "object" || Array.isArray(previous) ||
      payload.historical_config_provenance !== proof.historical_config_provenance) return false;
  const old = previous as Record<string, unknown>;
  const next = proof.historical_config_proof;
  const keys = ["last_receipt_observed_at", "objective", "optimization_goal",
    "custom_event_type", "custom_conversion_id", "receipt_refs"] as const;
  if (oldObjective !== next.objective || oldGoal !== next.optimization_goal ||
      payload.custom_event_type !== next.custom_event_type ||
      payload.custom_conversion_id !== next.custom_conversion_id) return false;
  return keys.every((key) =>
    JSON.stringify(canonical(old[key])) === JSON.stringify(canonical(next[key])));
}

/**
 * Automatic positive path for normal sync, after v2 membership has been
 * persisted. This touches only one account/day, holds row locks while proving
 * and writing, and leaves every non-bracketed or contradictory row unverified.
 * Historical batch repair uses the separately reviewed manifest script.
 */
export async function certifyCreativeDayConfigFromReceipts(input: {
  businessId: string; providerAccountId: string; day: string;
  knowledgeCutoffAt: string;
}): Promise<{ verified: number; unverified: number }> {
  return runDbTransaction(async () => {
    const sql = getDb();
    await sql.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `meta_creative_daily:${input.businessId}:${input.providerAccountId}:${input.day}`,
    ]);
    const locked = await sql.query<{ creative_id: string; objective: string | null;
      optimization_goal: string | null; payload_json: unknown }>(
      `SELECT creative_id, objective, optimization_goal, payload_json FROM meta_creative_daily
       WHERE business_id=$1 AND provider_account_id=$2 AND date=$3::date
         AND payload_json->>'source_identity_version'=$4
         AND payload_json->>'source_parent_grain_complete'='true'
       ORDER BY creative_id FOR UPDATE`,
      [input.businessId, input.providerAccountId, input.day,
        META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION],
    );
    if (locked.length === 0) return { verified: 0, unverified: 0 };
    const verdicts = await readCreativeDayConfigProofs(input);
    const lockedById = new Map(locked.map((row) => [row.creative_id, row]));
    let verified = 0;
    for (const verdict of verdicts) {
      if (verdict.status !== "verified") continue;
      const old = lockedById.get(verdict.creativeId);
      if (!old) throw new Error(`creative_config_proof_candidate_drift:${verdict.creativeId}`);
      if (sameCertifiedConfigEvidence(old.payload_json, old.objective,
          old.optimization_goal, verdict.proof)) {
        verified += 1;
        continue;
      }
      const config = verdict.proof.historical_config_proof;
      const payload = buildCertifiedConfigPayload(old.payload_json, verdict.proof);
      const updated = await sql.query<{ creative_id: string }>(
        `UPDATE meta_creative_daily
         SET objective=$5, optimization_goal=$6, payload_json=$7::jsonb,
           updated_at=now()
         WHERE business_id=$1 AND provider_account_id=$2 AND date=$3::date
           AND creative_id=$4 RETURNING creative_id`,
        [input.businessId, input.providerAccountId, input.day, verdict.creativeId,
          config.objective, config.optimization_goal, JSON.stringify(payload)],
      );
      if (updated.length !== 1) throw new Error(`creative_config_proof_update_failed:${verdict.creativeId}`);
      verified += 1;
    }
    return { verified, unverified: locked.length - verified };
  });
}
