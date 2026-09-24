import { describe, expect, it } from "vitest";
import { receiptRef } from "@/lib/meta/config-field-evidence-ref.fixtures";
import {
  CREATIVE_DAY_CONFIG_PROOF_SQL,
  buildCertifiedConfigPayload,
  evaluateCreativeDayConfigProof,
  sameCertifiedConfigEvidence,
  type CreativeDayConfigProofRow,
} from "@/lib/meta/creative-day-config-proof";

const cutoff = "2026-09-22T12:00:00.000Z";
const certified = "2026-09-24T12:00:00.000Z";
const ref = (field: string) => receiptRef({ field });
const source = (): CreativeDayConfigProofRow => ({
  creative_id: "creative-1", account_timezone: "America/Chicago",
  existing_objective: "Outcome Sales", existing_optimization_goal: "Offsite Conversions",
  existing_custom_event_type: "PURCHASE", existing_custom_conversion_id: null,
  existing_historical_config_provenance: "unverified",
  objective: "OUTCOME_SALES", objective_tier: "provider_receipt_day_bracketed",
  objective_readiness: "decision_authority", objective_ref: ref("objective"),
  optimization_goal: "OFFSITE_CONVERSIONS",
  optimization_goal_tier: "provider_receipt_day_bracketed",
  optimization_goal_readiness: "decision_authority",
  optimization_goal_ref: ref("optimization_goal"),
  custom_event_type: "PURCHASE", custom_event_type_tier: "provider_receipt_day_bracketed",
  custom_event_type_readiness: "decision_authority",
  custom_event_type_ref: ref("custom_event_type"),
  custom_conversion_id: null, custom_conversion_id_tier: "observed_absent",
  custom_conversion_id_readiness: "none", custom_conversion_id_ref: receiptRef({
    field: "custom_conversion_id", tier: "observed_absent", readiness: "none",
    corroboratingSnapshotId: null, corroboratingObservationId: null,
    corroboratingObservedAt: null,
  }),
});

describe("creative-day config receipt certification", () => {
  it("certifies a purchase context only from same-day bracketed receipts with agreement", () => {
    const verdict = evaluateCreativeDayConfigProof(source(), cutoff, certified);
    expect(verdict.status).toBe("verified");
    if (verdict.status !== "verified") return;
    expect(verdict.proof.historical_config_provenance).toBe("provider_receipt_day_bracketed");
    expect(verdict.proof.historical_config_proof).toMatchObject({
      knowledge_cutoff_at: cutoff,
      certified_at: certified,
      last_receipt_observed_at: "2026-09-21T01:00:00.000Z",
      objective: "OUTCOME_SALES", optimization_goal: "OFFSITE_CONVERSIONS",
      custom_event_type: "PURCHASE", custom_conversion_id: null,
    });
  });

  it("keeps a repeated receipt proof and its first certification clocks unchanged", () => {
    const verdict = evaluateCreativeDayConfigProof(source(), cutoff, certified);
    if (verdict.status !== "verified") throw new Error("fixture_not_verified");
    const payload = buildCertifiedConfigPayload({}, verdict.proof);
    const later = evaluateCreativeDayConfigProof(source(), "2026-09-23T12:00:00.000Z",
      "2026-09-25T12:00:00.000Z");
    if (later.status !== "verified") throw new Error("later_fixture_not_verified");
    expect(sameCertifiedConfigEvidence(payload, "OUTCOME_SALES",
      "OFFSITE_CONVERSIONS", later.proof)).toBe(true);
    expect(sameCertifiedConfigEvidence({ ...payload, custom_event_type: "LEAD" },
      "OUTCOME_SALES", "OFFSITE_CONVERSIONS", later.proof)).toBe(false);
    expect(sameCertifiedConfigEvidence(payload, "OUTCOME_TRAFFIC",
      "OFFSITE_CONVERSIONS", later.proof)).toBe(false);
  });

  it("replaces only historical config keys and preserves unrelated source payload", () => {
    const verdict = evaluateCreativeDayConfigProof(source(), cutoff, certified);
    if (verdict.status !== "verified") throw new Error("fixture_not_verified");
    const payload = buildCertifiedConfigPayload({ spend: 12.34,
      source_ad_ids: ["ad-1"], customEventType: "LEAD",
      historical_config_provenance: "unverified" }, verdict.proof);
    expect(payload).toMatchObject({ spend: 12.34, source_ad_ids: ["ad-1"],
      objective: "OUTCOME_SALES", optimization_goal: "OFFSITE_CONVERSIONS",
      custom_event_type: "PURCHASE", customEventType: "PURCHASE",
      historical_config_provenance: "provider_receipt_day_bracketed" });
  });

  it("corrects unverified mutable current-GET values from a bracketed receipt", () => {
    const verdict = evaluateCreativeDayConfigProof({ ...source(),
      existing_objective: "OUTCOME_TRAFFIC", existing_optimization_goal: "LINK_CLICKS",
      existing_custom_event_type: "LEAD" }, cutoff, certified);
    expect(verdict).toMatchObject({ status: "verified",
      proof: { historical_config_proof: { objective: "OUTCOME_SALES",
        optimization_goal: "OFFSITE_CONVERSIONS", custom_event_type: "PURCHASE" } } });
  });

  it("keeps a contradictory prior receipt certification unverified", () => {
    const verdict = evaluateCreativeDayConfigProof({ ...source(),
      existing_historical_config_provenance: "provider_receipt_day_bracketed",
      existing_objective: "OUTCOME_TRAFFIC" }, cutoff, certified);
    expect(verdict).toMatchObject({ status: "unverified", reason: "warehouse_config_value_disagrees_with_receipt" });
  });

  it("does not turn a certified absent event or conversion ID into a valued field", () => {
    const event = evaluateCreativeDayConfigProof({ ...source(),
      existing_historical_config_provenance: "provider_receipt_day_bracketed",
      existing_custom_event_type: null }, cutoff, certified);
    expect(event).toMatchObject({ status: "unverified",
      reason: "warehouse_config_value_disagrees_with_receipt" });

    const conversion = source();
    conversion.existing_historical_config_provenance = "provider_receipt_day_bracketed";
    conversion.custom_conversion_id = "12345";
    conversion.custom_conversion_id_tier = "provider_receipt_day_bracketed";
    conversion.custom_conversion_id_readiness = "decision_authority";
    conversion.custom_conversion_id_ref = ref("custom_conversion_id");
    expect(evaluateCreativeDayConfigProof(conversion, cutoff, certified)).toMatchObject({
      status: "unverified", reason: "warehouse_config_value_disagrees_with_receipt",
    });
  });

  it("does not borrow a corroboration from after the historical knowledge cutoff", () => {
    const verdict = evaluateCreativeDayConfigProof(source(), "2026-09-20T20:00:00.000Z", certified);
    expect(verdict).toMatchObject({ status: "unverified", reason: "objective_receipt_after_cutoff" });
  });

  it("refuses a point observation and an event that does not establish purchase", () => {
    const point = source();
    point.custom_event_type_tier = "provider_receipt_point_in_day";
    point.custom_event_type_readiness = "review_only";
    expect(evaluateCreativeDayConfigProof(point, cutoff, certified)).toMatchObject({
      status: "unverified", reason: "custom_event_type_not_day_bracketed",
    });
    const other = source();
    other.custom_event_type = "OTHER";
    other.existing_custom_event_type = "OTHER";
    expect(evaluateCreativeDayConfigProof(other, cutoff, certified)).toMatchObject({
      status: "unverified", reason: "config_semantics_custom_event_type",
    });
  });

  it("holds a purchase target naming only a custom conversion until its event is known", () => {
    const custom = source();
    custom.custom_event_type = null;
    custom.existing_custom_event_type = null;
    custom.custom_event_type_tier = "observed_absent";
    custom.custom_event_type_readiness = "none";
    custom.custom_event_type_ref = receiptRef({
      field: "custom_event_type", tier: "observed_absent", readiness: "none",
      corroboratingSnapshotId: null, corroboratingObservationId: null,
      corroboratingObservedAt: null,
    });
    custom.custom_conversion_id = "12345";
    custom.custom_conversion_id_tier = "provider_receipt_day_bracketed";
    custom.custom_conversion_id_readiness = "decision_authority";
    custom.custom_conversion_id_ref = ref("custom_conversion_id");
    expect(evaluateCreativeDayConfigProof(custom, cutoff, certified)).toMatchObject({
      status: "unverified", reason: "config_semantics_custom_conversion_id",
    });
  });

  it("scopes receipt SQL by exact account, day, v2 membership and knowledge cutoff", () => {
    expect(CREATIVE_DAY_CONFIG_PROOF_SQL).toContain("c.provider_account_id = $2 AND c.date = $3::date");
    expect(CREATIVE_DAY_CONFIG_PROOF_SQL).toContain("source_parent_grain_complete' = 'true'");
    expect(CREATIVE_DAY_CONFIG_PROOF_SQL).toContain("source_creative_ids' = jsonb_build_array(c.creative_id)");
    expect(CREATIVE_DAY_CONFIG_PROOF_SQL).toContain("ad.account_timezone IS DISTINCT FROM c.account_timezone");
    expect(CREATIVE_DAY_CONFIG_PROOF_SQL).toContain("ad.campaign_id IS DISTINCT FROM c.campaign_id");
    expect(CREATIVE_DAY_CONFIG_PROOF_SQL).toContain("associated_ads_count' = jsonb_array_length");
    expect(CREATIVE_DAY_CONFIG_PROOF_SQL).toContain("ad.truth_state IS DISTINCT FROM 'finalized'");
    expect(CREATIVE_DAY_CONFIG_PROOF_SQL).toContain("ad.validation_status IS DISTINCT FROM 'passed'");
    expect(CREATIVE_DAY_CONFIG_PROOF_SQL).toContain("ad.finalized_at >= $4::timestamptz");
    expect(CREATIVE_DAY_CONFIG_PROOF_SQL).toContain("$4::timestamptz");
    expect(CREATIVE_DAY_CONFIG_PROOF_SQL).toContain("meta_raw_snapshot_observations");
  });
});
