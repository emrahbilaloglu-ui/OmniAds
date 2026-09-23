/**
 * The current native hard-action config gate at server write boundaries.
 *
 * The snapshot's `authorized_action` is a recorded verdict, not proof that its
 * selected config receipt references and manifest still parse. Both the
 * in-process preflight and SQL claims read the exact hash-keyed evaluation
 * input; neither borrows current warehouse config nor reconstructs a missing
 * historical observation.
 */
import {
  META_CONFIG_EVIDENCE_FIELDS,
  META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION,
  META_CONFIG_RECEIPT_MANIFEST_VERSION,
  configFieldEvidenceRefCoherentSql,
  parseConfigFieldEvidenceRef,
  parseConfigReceiptWindowManifest,
} from "@/lib/meta/config-field-evidence-ref";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Same current-value and economic-window bar used by the served D100 reader. */
export function hasVerifiedNativeConfigActionEvidence(inputEvidence: unknown): boolean {
  const envelope = record(inputEvidence);
  const config = record(envelope?.configEvidence);
  const current = record(config?.currentValueEvidence);
  const economics = record(config?.decisionEconomics);
  const refs = record(current?.refs);
  const refusals = record(current?.refRefusals);
  const manifest = record(economics?.receiptManifest);
  if (
    current?.observed !== true ||
    economics?.fullyVerified !== true ||
    current?.lineageSupplied !== true ||
    !refs ||
    !manifest ||
    manifest.manifestVersion !== META_CONFIG_RECEIPT_MANIFEST_VERSION ||
    manifest.refContractVersion !== META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION
  ) {
    return false;
  }
  for (const field of META_CONFIG_EVIDENCE_FIELDS) {
    if (typeof refusals?.[field] === "string" && refusals[field].trim()) {
      return false;
    }
    if (!parseConfigFieldEvidenceRef(refs[field], field).ok) return false;
  }
  const parsedManifest = parseConfigReceiptWindowManifest({
    manifestVersion: manifest.manifestVersion,
    refContractVersion: manifest.refContractVersion,
    hash: manifest.hash,
    economicDayCount: manifest.economicDayCount,
    nullObservationIdCount: manifest.nullObservationIdCount,
    incoherentDayCount: manifest.incoherentDayCount,
  });
  return parsedManifest !== null &&
    parsedManifest.economicDayCount > 0 &&
    parsedManifest.incoherentDayCount === 0;
}

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * SQL twin for atomic inserts, proposal projection, and proposal claim/read.
 * Prior producer epochs cannot authorize a new write. The source is joined
 * through the snapshot's exact evaluation and its
 * `(contract_version, input_hash)` evidence mapping. The existing field-ref
 * SQL parser is reused, so a malformed selected reference loses eligibility.
 * This checks the stored lineage shape, not the original provider row's
 * authenticity after a valid-looking database replacement.
 */
export function nativeConfigActionAuthoritySql(snapshotAlias: string): string {
  if (!SQL_ALIAS.test(snapshotAlias)) {
    throw new Error("native_config_action_snapshot_alias_invalid");
  }
  const coherentRefs = META_CONFIG_EVIDENCE_FIELDS.map((field) =>
    configFieldEvidenceRefCoherentSql(`config_refs.${field}_ref`, field),
  ).join("\n          AND ");
  const noRefusals = META_CONFIG_EVIDENCE_FIELDS.map(
    (field) =>
      `(jsonb_typeof(config_current->'refRefusals'->'${field}') IS DISTINCT FROM 'string' OR BTRIM(config_current->'refRefusals'->>'${field}') = '')`,
  ).join("\n          AND ");
  const manifest = "config_economics->'receiptManifest'";
  // A corrupt JSON number must fail the predicate, never throw while an
  // atomic claim is running. PostgreSQL may reorder separate AND terms, so
  // the cast lives inside the CASE that proves its bounded integer syntax.
  const safeCount = (key: string) =>
    `(CASE WHEN ${manifest}->>'${key}' ~ '^[0-9]{1,12}$'
            THEN (${manifest}->>'${key}')::numeric ELSE NULL END)`;

  return `(${snapshotAlias}.engine_version = '${NATIVE_AD_ENGINE_VERSION}' AND EXISTS (
    SELECT 1
      FROM engine_v3_ad_decision_evaluations config_evaluation
      JOIN engine_v3_ad_decision_input_evidence config_input
        ON config_input.contract_version = config_evaluation.contract_version
       AND config_input.input_hash = config_evaluation.input_hash
      CROSS JOIN LATERAL (
        SELECT config_input.input_evidence_json #> '{configEvidence,currentValueEvidence,refs,objective}' AS objective_ref,
               config_input.input_evidence_json #> '{configEvidence,currentValueEvidence,refs,optimization_goal}' AS optimization_goal_ref,
               config_input.input_evidence_json #> '{configEvidence,currentValueEvidence,refs,custom_event_type}' AS custom_event_type_ref,
               config_input.input_evidence_json #> '{configEvidence,currentValueEvidence,refs,custom_conversion_id}' AS custom_conversion_id_ref
      ) config_refs
      CROSS JOIN LATERAL (
        SELECT config_input.input_evidence_json #> '{configEvidence,currentValueEvidence}' AS config_current,
               config_input.input_evidence_json #> '{configEvidence,decisionEconomics}' AS config_economics
      ) config_parts
     WHERE config_evaluation.id = ${snapshotAlias}.evaluation_id
       AND config_evaluation.business_ref_id = ${snapshotAlias}.business_ref_id
       AND config_evaluation.business_id = ${snapshotAlias}.business_id
       AND config_evaluation.provider_account_ref_id = ${snapshotAlias}.provider_account_ref_id
       AND config_evaluation.provider_account_id = ${snapshotAlias}.provider_account_id
       AND config_evaluation.decision_entity_type = ${snapshotAlias}.decision_entity_type
       AND config_evaluation.decision_entity_id = ${snapshotAlias}.decision_entity_id
       AND config_evaluation.ad_id = ${snapshotAlias}.ad_id
       AND config_evaluation.as_of_date = ${snapshotAlias}.as_of_date
       AND config_evaluation.engine_version = ${snapshotAlias}.engine_version
       AND config_evaluation.scope_type = ${snapshotAlias}.scope_type
       AND config_evaluation.scope_id = ${snapshotAlias}.scope_id
       AND config_evaluation.input_hash = ${snapshotAlias}.input_hash
       AND config_evaluation.decision_hash = ${snapshotAlias}.decision_hash
       AND config_current->'observed' = 'true'::jsonb
       AND config_current->'lineageSupplied' = 'true'::jsonb
       AND config_economics->'fullyVerified' = 'true'::jsonb
       AND ${noRefusals}
       AND ${coherentRefs}
       AND jsonb_typeof(${manifest}) = 'object'
       AND ${manifest}->>'manifestVersion' = '${META_CONFIG_RECEIPT_MANIFEST_VERSION}'
       AND ${manifest}->>'refContractVersion' = '${META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION}'
       AND ${manifest}->>'hash' ~ '^[0-9a-f]{64}$'
       AND ${safeCount("economicDayCount")} > 0
       AND ${safeCount("incoherentDayCount")} = 0
       AND ${safeCount("nullObservationIdCount")} <=
           ${safeCount("economicDayCount")} * ${META_CONFIG_EVIDENCE_FIELDS.length}
  ))`;
}
