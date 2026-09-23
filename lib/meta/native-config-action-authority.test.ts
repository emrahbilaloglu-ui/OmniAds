import { describe, expect, it } from "vitest";
import {
  hasVerifiedNativeConfigActionEvidence,
  nativeConfigActionAuthoritySql,
} from "./native-config-action-authority";
import { validNativeConfigInputEvidence } from "./native-config-action-authority.fixture";
import { CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY } from "./ads-action-log";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  NATIVE_AD_PAUSE_PROJECTION_SQL,
  currentNativeAdDecisionSourcePredicate,
} from "./automation-proposals";

describe("current native hard-action config authority", () => {
  it("accepts exact selected receipts and a verified economic-window manifest", () => {
    expect(hasVerifiedNativeConfigActionEvidence(validNativeConfigInputEvidence())).toBe(true);
  });

  it("withholds when the selected receipt or economic-window record is missing or changed", () => {
    const invalidReceipt = validNativeConfigInputEvidence();
    invalidReceipt.configEvidence.currentValueEvidence.refs.objective.observationId =
      "mutated-after-evaluation";
    const missingReceipt = validNativeConfigInputEvidence();
    missingReceipt.configEvidence.currentValueEvidence.refs.objective.observationId =
      null as never;
    const incompleteEconomics = validNativeConfigInputEvidence();
    incompleteEconomics.configEvidence.decisionEconomics.fullyVerified = false;
    const malformedManifestCount = validNativeConfigInputEvidence();
    malformedManifestCount.configEvidence.decisionEconomics.receiptManifest.economicDayCount =
      "unreadable" as never;
    const conflictingManifest = validNativeConfigInputEvidence();
    conflictingManifest.configEvidence.decisionEconomics.receiptManifest.incoherentDayCount = 1;

    for (const value of [
      null,
      invalidReceipt,
      missingReceipt,
      incompleteEconomics,
      malformedManifestCount,
      conflictingManifest,
    ]) {
      expect(hasVerifiedNativeConfigActionEvidence(value)).toBe(false);
    }
  });

  it("binds SQL checks to the exact hashed input and casts malformed counts safely", () => {
    const predicate = nativeConfigActionAuthoritySql("snapshot");
    expect(predicate).toContain(`snapshot.engine_version = '${NATIVE_AD_ENGINE_VERSION}'`);
    expect(predicate).toContain("config_evaluation.id = snapshot.evaluation_id");
    expect(predicate).toContain("config_evaluation.input_hash = snapshot.input_hash");
    expect(predicate).toContain("config_input.input_hash = config_evaluation.input_hash");
    expect(predicate).toContain("config_current->'observed' = 'true'::jsonb");
    expect(predicate).toContain("config_economics->'fullyVerified' = 'true'::jsonb");
    expect(predicate).toContain("config_refs.objective_ref");
    expect(predicate).toContain("config_refs.custom_conversion_id_ref");
    expect(predicate).toContain("THEN (config_economics->'receiptManifest'->>'economicDayCount')::numeric ELSE NULL END");
    expect(predicate).not.toMatch(/AND\s+\(config_economics->'receiptManifest'->>'economicDayCount'\)::numeric/);
    expect(() => nativeConfigActionAuthoritySql("unsafe.alias")).toThrow();
  });

  it("rechecks config authority at claim, native proposal offer, and proposal approval", () => {
    const marker = "config_input.input_hash = config_evaluation.input_hash";
    expect(CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY).toContain(marker);
    expect(NATIVE_AD_PAUSE_PROJECTION_SQL).toContain(marker);
    expect(currentNativeAdDecisionSourcePredicate("proposal", true)).toContain(marker);
  });

  it("selects the latest account-scoped verdict before filtering the current epoch", () => {
    const latest = NATIVE_AD_PAUSE_PROJECTION_SQL.split(
      "), decisions AS MATERIALIZED (",
    )[0]!;
    const decisions = NATIVE_AD_PAUSE_PROJECTION_SQL.split(
      "), decisions AS MATERIALIZED (",
    )[1]!;
    expect(latest).toContain("d.business_ref_id = $1::uuid");
    expect(latest).not.toContain("d.engine_version =");
    expect(decisions).toContain("d.engine_version =");
  });
});
