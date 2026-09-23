/** Test-only, producer-shaped config receipt lineage for hard-action guards. */
export function validNativeConfigInputEvidence() {
  const receipt = (field: string) => ({
    refContractVersion: "meta-config-field-evidence-ref.v1",
    field,
    sourceContractVersion: "meta-config-field-source.v1",
    normalizationVersion: 1,
    tier: "provider_receipt_point_in_day",
    readiness: "review_only",
    sourceClass: "modern",
    pitClass: "as_of_known",
    sourceSnapshotId: "11111111-1111-4111-8111-111111111111",
    observationId: "33333333-3333-4333-8333-333333333333",
    observedAt: "2026-07-12T04:00:00.000Z",
    fieldScopeHash: "a".repeat(64),
    corroboratingSnapshotId: null,
    corroboratingObservationId: null,
    corroboratingObservedAt: null,
  });
  const unknown = (field: string) => ({
    refContractVersion: "meta-config-field-evidence-ref.v1",
    field,
    sourceContractVersion: "meta-config-field-source.v1",
    normalizationVersion: null,
    tier: "unknown",
    readiness: "none",
    sourceClass: "none",
    pitClass: null,
    sourceSnapshotId: null,
    observationId: null,
    observedAt: null,
    fieldScopeHash: null,
    corroboratingSnapshotId: null,
    corroboratingObservationId: null,
    corroboratingObservedAt: null,
  });
  return {
    configEvidence: {
      currentValueEvidence: {
        observed: true,
        lineageSupplied: true,
        refRefusals: {},
        refs: {
          objective: receipt("objective"),
          optimization_goal: receipt("optimization_goal"),
          custom_event_type: receipt("custom_event_type"),
          custom_conversion_id: unknown("custom_conversion_id"),
        },
      },
      decisionEconomics: {
        fullyVerified: true,
        receiptManifest: {
          manifestVersion: "meta-config-receipt-window-manifest.v1",
          refContractVersion: "meta-config-field-evidence-ref.v1",
          hash: "c".repeat(64),
          economicDayCount: 3,
          nullObservationIdCount: 0,
          incoherentDayCount: 0,
        },
      },
    },
  };
}
