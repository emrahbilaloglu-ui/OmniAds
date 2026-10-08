import type { DecisionPredicateBlocker } from "@/lib/creative-decision-engine/types";

/** Display-only lineage. This module never chooses or authorizes an action. */
export interface MetaDecisionCalibrationEvidence {
  rowId: string; batchId: string; contractVersion: string;
  cellScope: string; objective: string; funnelCohort: string; optimizationContext: string;
  windowStart: string; windowEnd: string; asOfCutoff: string;
  inputManifestHash: string; batchInputManifestHash: string; sourceManifestHash: string;
  currency: string | null; targetRoas: number | null; breakEvenRoas: number | null;
  metaAov: number | null; metaAovPurchases: number | null; baseSpendUnit: number | null;
  metaAovWindowStart: string | null; metaAovWindowEnd: string | null;
  spendUnitBasis: string | null;
  readiness: Partial<Record<"scale" | "refresh", { observed: number; required: number; ready: boolean }>>;
}

export interface MetaDecisionEvidenceRequirement {
  predicate: string; label: string;
  observed: string | number | null; required: string | number | null;
  unit: "ad_calibration_observations" | "ad_roas_ratio_observations" | "purchases" | "currency" | "roas" | "unknown";
  currency: string | null;
  status: "passed" | "failed" | "missing";
  source: "persisted_evaluation" | "referenced_native_calibration";
  sourceId: string | null;
  window: { startDate: string; endDate: string } | null;
  cell: { scope: string; objective: string; cohort: string; optimizationContext: string } | null;
  owner: "system";
  recheck: string;
}

export interface MetaDecisionConfidenceBasis {
  rule: "missing_data_cap" | "score_band";
  missingData: string[];
}

// Both joins are primary-key lookups on the SELECTED snapshot's reference.
// Never replace this with latest-cell or a history scan. A batch mismatch makes
// the optional explanation unknown; it does not select a substitute profile.
export const NATIVE_CALIBRATION_PRESENTATION_JOIN_SQL = `
 LEFT JOIN engine_v3_ad_account_calibration_daily explanation_cell
   ON explanation_cell.id = snapshot.calibration_row_id
  AND explanation_cell.business_ref_id = snapshot.business_ref_id
  AND explanation_cell.business_id = snapshot.business_id
  AND explanation_cell.provider_account_ref_id = snapshot.provider_account_ref_id
  AND explanation_cell.provider_account_id = snapshot.provider_account_id
  AND explanation_cell.as_of_date = snapshot.as_of_date
  AND explanation_cell.engine_version = snapshot.engine_version
 LEFT JOIN engine_v3_ad_account_calibration_batches explanation_batch
   ON explanation_batch.id = explanation_cell.batch_id
  AND explanation_batch.business_ref_id = explanation_cell.business_ref_id
  AND explanation_batch.business_id = explanation_cell.business_id
  AND explanation_batch.provider = explanation_cell.provider
  AND explanation_batch.provider_account_ref_id = explanation_cell.provider_account_ref_id
  AND explanation_batch.provider_account_id = explanation_cell.provider_account_id
  AND explanation_batch.as_of_date = explanation_cell.as_of_date
  AND explanation_batch.as_of_cutoff = explanation_cell.as_of_cutoff
  AND explanation_batch.engine_version = explanation_cell.engine_version
  AND explanation_batch.policy_version = explanation_cell.policy_version
  AND explanation_batch.contract_version = explanation_cell.contract_version
  AND explanation_batch.input_manifest_hash = explanation_cell.batch_input_manifest_hash
  AND explanation_batch.source_manifest_hash = explanation_cell.source_manifest_hash
  AND explanation_batch.completeness_status = 'complete'
  AND explanation_batch.completed_at IS NOT NULL
`;

export const NATIVE_CALIBRATION_PRESENTATION_JSON_SQL = `CASE WHEN explanation_batch.id IS NOT NULL THEN jsonb_build_object(
 'rowId', explanation_cell.id, 'batchId', explanation_cell.batch_id,
 'contractVersion', explanation_cell.contract_version,
 'cellScope', explanation_cell.cell_scope, 'objective', explanation_cell.objective,
 'funnelCohort', explanation_cell.funnel_cohort, 'optimizationContext', explanation_cell.optimization_context,
 'windowStart', explanation_cell.sample_window_start::text, 'windowEnd', explanation_cell.sample_window_end::text,
 'asOfCutoff', explanation_cell.as_of_cutoff::text,
 'inputManifestHash', explanation_cell.input_manifest_hash,
 'batchInputManifestHash', explanation_cell.batch_input_manifest_hash,
 'sourceManifestHash', explanation_cell.source_manifest_hash,
 'currency', explanation_cell.account_currency, 'targetRoas', explanation_cell.target_roas,
 'breakEvenRoas', explanation_cell.break_even_roas,
 'metaAov', explanation_cell.meta_attributed_aov_mean_90d,
 'metaAovPurchases', explanation_cell.meta_attributed_aov_purchase_count_90d,
 'actionReadiness', jsonb_build_object(
   'scale', explanation_cell.action_readiness_json->'scale',
   'refresh', explanation_cell.action_readiness_json->'refresh',
   'spendUnitAuthority', jsonb_build_object(
     'basis', explanation_cell.action_readiness_json#>'{spendUnitAuthority,basis}',
     'baseSpendUnit', explanation_cell.action_readiness_json#>'{spendUnitAuthority,baseSpendUnit}',
     'accountAovEvidence', jsonb_build_object(
       'sampleWindowStart', explanation_cell.action_readiness_json#>'{spendUnitAuthority,accountAovEvidence,sampleWindowStart}',
       'sampleWindowEnd', explanation_cell.action_readiness_json#>'{spendUnitAuthority,accountAovEvidence,sampleWindowEnd}'
     )
   )
 )
) ELSE NULL END`;

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
const numeric = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const day = (v: unknown): string | null => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

export function readMetaDecisionCalibrationEvidence(value: unknown): MetaDecisionCalibrationEvidence | null {
  const r = object(value);
  if (!r) return null;
  const required = ["rowId", "batchId", "contractVersion", "cellScope", "objective", "funnelCohort", "optimizationContext", "asOfCutoff", "inputManifestHash", "batchInputManifestHash", "sourceManifestHash"] as const;
  if (required.some((key) => !text(r[key])) || !day(r.windowStart) || !day(r.windowEnd) || String(r.windowStart) > String(r.windowEnd)) return null;
  if (!["inputManifestHash", "batchInputManifestHash", "sourceManifestHash"].every((key) => /^[0-9a-f]{64}$/.test(String(r[key])))) return null;
  if (!/^engine-v3-native-ad-calibration\.v[1-7]$/.test(String(r.contractVersion))) return null;
  const actions = object(r.actionReadiness);
  const authority = object(actions?.spendUnitAuthority);
  const readiness: MetaDecisionCalibrationEvidence["readiness"] = {};
  for (const action of ["scale", "refresh"] as const) {
    const entry = object(actions?.[action]);
    const observed = numeric(entry?.observedSampleCount), requiredCount = numeric(entry?.requiredSampleCount);
    if (entry && observed !== null && requiredCount !== null && Number.isInteger(observed) && Number.isInteger(requiredCount) && typeof entry.ready === "boolean") {
      readiness[action] = { observed, required: requiredCount, ready: entry.ready };
    }
  }
  return {
    rowId: String(r.rowId), batchId: String(r.batchId), contractVersion: String(r.contractVersion),
    cellScope: String(r.cellScope), objective: String(r.objective), funnelCohort: String(r.funnelCohort), optimizationContext: String(r.optimizationContext),
    windowStart: String(r.windowStart), windowEnd: String(r.windowEnd), asOfCutoff: String(r.asOfCutoff),
    inputManifestHash: String(r.inputManifestHash), batchInputManifestHash: String(r.batchInputManifestHash), sourceManifestHash: String(r.sourceManifestHash),
    currency: text(r.currency), targetRoas: numeric(r.targetRoas), breakEvenRoas: numeric(r.breakEvenRoas),
    metaAov: numeric(r.metaAov), metaAovPurchases: numeric(r.metaAovPurchases),
    metaAovWindowStart: day(object(authority?.accountAovEvidence)?.sampleWindowStart),
    metaAovWindowEnd: day(object(authority?.accountAovEvidence)?.sampleWindowEnd),
    baseSpendUnit: numeric(authority?.baseSpendUnit), spendUnitBasis: text(authority?.basis), readiness,
  };
}

const CATALOG: Record<string, { label: string; unit: MetaDecisionEvidenceRequirement["unit"] }> = {
  scale_account_benchmark_ready: { label: "Scale calibration sample", unit: "ad_calibration_observations" },
  scale_spend_depth: { label: "Scale spend evidence", unit: "currency" },
  scale_recent_sample_depth: { label: "Recent spend evidence", unit: "currency" },
  scale_purchase_depth: { label: "Scale purchase evidence", unit: "purchases" },
  scale_recent_hold: { label: "Recent ROAS", unit: "roas" },
  expanded_cut_recent_recovery_evidence: { label: "Recent recovery spend evidence", unit: "currency" },
};

export function projectMetaDecisionEvidenceRequirements(input: {
  blockers: readonly DecisionPredicateBlocker[];
  calibration: MetaDecisionCalibrationEvidence | null;
  heldAction: "scale" | "cut" | "refresh" | null;
  currency: string | null; evaluationId: string | null;
  window?: { startDate: string; endDate: string } | null;
}): MetaDecisionEvidenceRequirement[] {
  const recheck = "Re-evaluate after the stated evidence is available and an eligible decision run completes. Other independent checks must also pass.";
  // Only typed, catalogued predicates become quantitative buyer copy.
  // Producer reason/observed prose is never a display label or measurement.
  const requirements: MetaDecisionEvidenceRequirement[] = input.blockers.flatMap((b) => {
    const entry = CATALOG[b.predicate];
    if (!entry) return [];
    const winnerBenchmark = b.predicate === "scale_account_benchmark_ready" && typeof b.threshold !== "number";
    const c = winnerBenchmark ? input.calibration : null;
    return [{
      predicate: b.predicate, label: winnerBenchmark ? "Account winner purchase benchmark" : entry.label,
      observed: numeric(b.observed), required: winnerBenchmark ? "positive winner purchase P50" : numeric(b.threshold),
      unit: winnerBenchmark ? "purchases" : entry.unit,
      currency: input.currency, status: b.status, source: "persisted_evaluation" as const, sourceId: input.evaluationId,
      window: winnerBenchmark ? c ? { startDate: c.windowStart, endDate: c.windowEnd } : null : input.window ?? null,
      cell: c ? { scope: c.cellScope, objective: c.objective, cohort: c.funnelCohort, optimizationContext: c.optimizationContext } : null,
      owner: "system" as const, recheck,
    }];
  });
  const action = input.heldAction;
  if (action === "scale" || action === "refresh") {
    const c = input.calibration, entry = c?.readiness[action];
    const predicate = action === "scale" ? "scale_account_benchmark_ready" : "refresh_calibration_sample";
    // A persisted non-numeric Scale blocker is the missing winner-P50 case,
    // not a thin sample. Never replace that reason with a sample-count claim.
    const existing = requirements.find((r) => r.predicate === predicate);
    if (action === "refresh" || !existing || (typeof existing.observed === "number" && typeof existing.required === "number")) {
      const consistent = !existing || !entry || (existing.observed === entry.observed && existing.required === entry.required);
      const requirement: MetaDecisionEvidenceRequirement = {
        predicate, label: consistent ? `${action === "scale" ? "Scale" : "Refresh"} calibration sample` : "Calibration evidence is inconsistent",
        observed: consistent ? entry?.observed ?? existing?.observed ?? null : null,
        required: consistent ? entry?.required ?? existing?.required ?? null : null,
        unit: action === "scale" ? "ad_calibration_observations" : "ad_roas_ratio_observations",
        currency: input.currency, status: !consistent ? "missing" : entry ? entry.ready ? "passed" : "failed" : existing?.status ?? "missing",
        source: c && entry ? "referenced_native_calibration" : "persisted_evaluation", sourceId: c && entry ? c.rowId : input.evaluationId,
        window: c ? { startDate: c.windowStart, endDate: c.windowEnd } : null,
        cell: c ? { scope: c.cellScope, objective: c.objective, cohort: c.funnelCohort, optimizationContext: c.optimizationContext } : null,
        owner: "system", recheck,
      };
      if (existing) requirements[requirements.indexOf(existing)] = requirement;
      else requirements.push(requirement);
    }
  }
  return requirements;
}

export function metaDecisionRequirementText(r: MetaDecisionEvidenceRequirement, includeRecheck = true): string {
  const value = (v: string | number | null) => typeof v === "number" && Number.isFinite(v) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(v) : "unknown";
  const unit = { ad_calibration_observations: "Ad calibration observations", ad_roas_ratio_observations: "Ad ROAS-ratio observations", purchases: "purchases", currency: r.currency ?? "currency unknown", roas: "ROAS", unknown: "units unknown" }[r.unit];
  const friendly = (v: string) => v.toLowerCase().replaceAll("_", " ");
  const cell = r.cell ? ` · ${friendly(r.cell.objective)} / ${friendly(r.cell.cohort)} / ${friendly(r.cell.optimizationContext)}` : " · calibration cell unknown";
  if (r.predicate === "scale_account_benchmark_ready" && typeof r.required === "string") {
    return `${r.label}: ${value(r.observed)} purchases observed; a positive winner purchase P50 is required${r.window ? ` · calibration ${r.window.startDate}–${r.window.endDate}` : " · sample period unknown"}.${includeRecheck ? ` ${r.recheck}` : ""}`;
  }
  return `${r.label}: ${value(r.observed)} / ${value(r.required)} ${unit}${r.window ? ` · ${r.window.startDate}–${r.window.endDate}` : " · sample period unknown"}${r.unit.startsWith("ad_") ? cell : ""}.${includeRecheck ? ` ${r.status === "passed" ? "This requirement is met; other checks still apply." : r.recheck}` : ""}`;
}

export function metaDecisionConfidenceBasisText(basis: MetaDecisionConfidenceBasis | undefined, band: string, score: number | null): string {
  const labels: Record<string, string> = { data_health: "data quality", truth: "commercial authority", tracking: "tracking", freshness: "fresh data", stale_evidence: "fresh evidence", delivery_proof: "delivery proof", scale_calibration: "Scale calibration" };
  return `Confidence ${band} · score ${score ?? "unknown"}. ${!basis ? "Confidence basis unknown." : basis.rule === "missing_data_cap"
    ? `Missing ${basis.missingData.map((code) => labels[code] ?? "required decision evidence").join(", ")} caps the confidence band.`
    : "Band follows the recorded score; action authority and remaining blockers are checked separately."}`;
}

export function metaDecisionCommercialBasisText(c: MetaDecisionCalibrationEvidence | null | undefined): string {
  if (!c) return "Commercial basis receipt unavailable; no replacement source is assumed.";
  const n = (v: number | null) => v === null ? "unknown" : v.toFixed(2);
  const currency = c.currency ?? "currency unknown";
  const basis = c.spendUnitBasis === "physical_account_purchase_aov_90d"
    ? `Meta platform AOV ${n(c.metaAov)} ${currency} / Target ROAS ${n(c.targetRoas)}`
    : c.spendUnitBasis === "target_cpa" ? "Configured Target CPA" : "Historical or unavailable commercial basis";
  return `${basis} → recorded spend unit ${n(c.baseSpendUnit)} ${currency}. Meta AOV sample: ${c.metaAovPurchases ?? "unknown"} attributed purchases, ${c.metaAovWindowStart && c.metaAovWindowEnd ? `${c.metaAovWindowStart}–${c.metaAovWindowEnd}` : "period unknown"}.${c.breakEvenRoas !== null ? ` Explicit break-even ROAS ${n(c.breakEvenRoas)} is context, not a replacement target.` : ""}`;
}
