/**
 * Shared fixtures for the ConfigFieldEvidenceRef coherence rule: the unit test
 * runs them through the TypeScript parser and the DB seam runs them through
 * the SQL predicate, so the two languages are judged on the same inputs.
 */
import type { MetaConfigEvidenceField } from "@/lib/meta/config-field-evidence-ref";

export function receiptRef(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    refContractVersion: "meta-config-field-evidence-ref.v1",
    field: "objective",
    sourceContractVersion: "meta-config-field-source.v1",
    normalizationVersion: 1,
    tier: "provider_receipt_day_bracketed",
    readiness: "decision_authority",
    sourceClass: "modern",
    pitClass: "as_of_known",
    sourceSnapshotId: "11111111-1111-4111-8111-111111111111",
    observationId: "33333333-3333-4333-8333-333333333333",
    observedAt: "2026-09-20T10:00:00.000Z",
    fieldScopeHash: "a".repeat(64),
    corroboratingSnapshotId: "11111111-1111-4111-8111-111111111111",
    corroboratingObservationId: "55555555-5555-4555-8555-555555555555",
    corroboratingObservedAt: "2026-09-21T01:00:00.000Z",
    ...over,
  };
}

const NO_CORROBORATION = {
  corroboratingSnapshotId: null,
  corroboratingObservationId: null,
  corroboratingObservedAt: null,
};

const NO_IDENTITY = {
  normalizationVersion: null,
  pitClass: null,
  sourceSnapshotId: null,
  observationId: null,
  observedAt: null,
  fieldScopeHash: null,
  ...NO_CORROBORATION,
};

export const COHERENCE_FIXTURES: Array<{
  name: string;
  field: MetaConfigEvidenceField;
  ref: unknown;
  coherent: boolean;
}> = [
  { name: "modern day-bracketed receipt", field: "objective", ref: receiptRef(), coherent: true },
  {
    name: "modern point-in-day receipt",
    field: "objective",
    ref: receiptRef({ tier: "provider_receipt_point_in_day", readiness: "review_only", ...NO_CORROBORATION }),
    coherent: true,
  },
  {
    name: "legacy bracketed receipt closed by a snapshot-only corroborator",
    field: "optimization_goal",
    ref: receiptRef({
      field: "optimization_goal",
      tier: "provider_receipt_legacy_bracketed",
      sourceClass: "legacy_observed",
      corroboratingObservationId: null,
    }),
    coherent: true,
  },
  {
    name: "legacy snapshot-only single page, explicit null observation id",
    field: "objective",
    ref: receiptRef({
      tier: "provider_receipt_legacy_single_page",
      readiness: "review_only",
      sourceClass: "legacy_snapshot_only",
      observationId: null,
      ...NO_CORROBORATION,
    }),
    coherent: true,
  },
  {
    name: "observed absence",
    field: "custom_event_type",
    ref: receiptRef({
      field: "custom_event_type",
      tier: "observed_absent",
      readiness: "none",
      sourceClass: "legacy_observed",
      ...NO_CORROBORATION,
    }),
    coherent: true,
  },
  {
    name: "typed witness, no identity",
    field: "objective",
    ref: receiptRef({ tier: "typed_contemporaneous", readiness: "review_only", sourceClass: "typed_unlinked", ...NO_IDENTITY }),
    coherent: true,
  },
  {
    name: "unknown, no identity",
    field: "custom_conversion_id",
    ref: receiptRef({ field: "custom_conversion_id", tier: "unknown", readiness: "none", sourceClass: "none", ...NO_IDENTITY }),
    coherent: true,
  },
  {
    name: "current fallback is only ever unknown",
    field: "objective",
    ref: receiptRef({ tier: "unknown", readiness: "none", sourceClass: "current_fallback", ...NO_IDENTITY }),
    coherent: true,
  },
  // NEGATIVE CONTROLS.
  { name: "absent", field: "objective", ref: null, coherent: false },
  { name: "not an object", field: "objective", ref: [receiptRef()], coherent: false },
  { name: "unknown ref contract", field: "objective", ref: receiptRef({ refContractVersion: "v0" }), coherent: false },
  { name: "unknown source contract", field: "objective", ref: receiptRef({ sourceContractVersion: "x" }), coherent: false },
  { name: "field mismatch", field: "optimization_goal", ref: receiptRef(), coherent: false },
  { name: "readiness not the tier's", field: "objective", ref: receiptRef({ readiness: "review_only" }), coherent: false },
  { name: "unknown source class", field: "objective", ref: receiptRef({ sourceClass: "guessed" }), coherent: false },
  { name: "receipt tier without a snapshot", field: "objective", ref: receiptRef({ sourceSnapshotId: null }), coherent: false },
  { name: "receipt tier without a clock", field: "objective", ref: receiptRef({ observedAt: null }), coherent: false },
  { name: "receipt tier without a scope hash", field: "objective", ref: receiptRef({ fieldScopeHash: null }), coherent: false },
  { name: "receipt tier without a pit class", field: "objective", ref: receiptRef({ pitClass: null }), coherent: false },
  { name: "unknown normalization version", field: "objective", ref: receiptRef({ normalizationVersion: 2 }), coherent: false },
  { name: "observation class without an observation id", field: "objective", ref: receiptRef({ observationId: null }), coherent: false },
  {
    name: "snapshot-only receipt claiming an observation id",
    field: "objective",
    ref: receiptRef({ tier: "provider_receipt_legacy_single_page", readiness: "review_only", sourceClass: "legacy_snapshot_only", ...NO_CORROBORATION }),
    coherent: false,
  },
  {
    name: "modern-only tier under a legacy class",
    field: "objective",
    ref: receiptRef({ sourceClass: "legacy_snapshot_only", observationId: null }),
    coherent: false,
  },
  {
    name: "point-in-day under a legacy class",
    field: "objective",
    ref: receiptRef({ tier: "provider_receipt_point_in_day", readiness: "review_only", sourceClass: "legacy_observed", ...NO_CORROBORATION }),
    coherent: false,
  },
  {
    name: "bracketed tier without its closing receipt",
    field: "objective",
    ref: receiptRef({ corroboratingSnapshotId: null }),
    coherent: false,
  },
  {
    name: "non-bracketed tier citing a corroborator",
    field: "objective",
    ref: receiptRef({ tier: "provider_receipt_pending_corroboration", readiness: "review_only" }),
    coherent: false,
  },
  { name: "malformed uuid", field: "objective", ref: receiptRef({ observationId: "junk" }), coherent: false },
  { name: "malformed instant", field: "objective", ref: receiptRef({ observedAt: "2026-09-20 10:00" }), coherent: false },
  { name: "malformed scope hash", field: "objective", ref: receiptRef({ fieldScopeHash: "ABC" }), coherent: false },
  {
    name: "current fallback claiming a receipt tier",
    field: "objective",
    ref: receiptRef({ sourceClass: "current_fallback" }),
    coherent: false,
  },
  {
    name: "unknown tier carrying an identity",
    field: "objective",
    ref: receiptRef({ tier: "unknown", readiness: "none", sourceClass: "none", ...NO_CORROBORATION }),
    coherent: false,
  },
  {
    name: "typed witness carrying a pit class",
    field: "objective",
    ref: receiptRef({
      tier: "typed_contemporaneous",
      readiness: "review_only",
      sourceClass: "typed_unlinked",
      ...NO_IDENTITY,
      pitClass: "as_of_known",
    }),
    coherent: false,
  },
  {
    name: "unknown tier carrying a normalization version",
    field: "objective",
    ref: receiptRef({
      tier: "unknown",
      readiness: "none",
      sourceClass: "none",
      ...NO_IDENTITY,
      normalizationVersion: 1,
    }),
    coherent: false,
  },
];
