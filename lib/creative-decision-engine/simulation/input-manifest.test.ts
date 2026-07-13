import { describe, expect, it } from "vitest";
import {
  buildSimulationInputManifest,
  type BuildSimulationInputManifestInput,
  type SimulationIdentityProvenanceMap,
} from "./input-manifest";

function identity(): SimulationIdentityProvenanceMap {
  return {
    account: proof("act_1"),
    campaign: proof("cmp_1"),
    adset: proof("set_1"),
    ad: proof("ad_1"),
    creative: proof("creative_1"),
    goal: proof("purchase"),
    country: proof("US", false),
    currency: proof("USD"),
  };
}

function proof(value: string, required = true) {
  return {
    value,
    required,
    source: "meta_raw_snapshots",
    evidenceClass: "exact_observation" as const,
    sourceId: `source_${value}`,
    observedAt: "2026-07-01T02:45:00.000Z",
  };
}

function exactInput(): BuildSimulationInputManifestInput {
  return {
    sourceMode: "exact_raw_pit",
    cutoff: "2026-07-01T03:00:00.000Z",
    identity: identity(),
    targetProvenance: {
      required: true,
      source: "business_target_pack_history",
      evidenceClass: "bitemporal_observation",
      sourceId: "target_1",
      effectiveAt: "2026-06-01T00:00:00.000Z",
      recordedAt: "2026-06-01T00:01:00.000Z",
    },
    configProvenance: [
      {
        required: true,
        source: "campaign_configs",
        evidenceClass: "exact_observation",
        sourceId: "config_1",
        observedAt: "2026-07-01T02:50:00.000Z",
        effectiveFrom: "2026-06-20",
      },
    ],
    generation: {
      complete: true,
      partitionId: "partition_1",
      runId: "run_1",
      snapshotIds: ["snapshot_2", "snapshot_1"],
      sourceManifestHash: "raw_manifest_hash",
    },
    sourceIds: ["source_b", "source_a"],
    missingFields: [],
    conflictFields: [],
    outcomeCompleteness: {
      status: "complete",
      checkedAt: "2026-07-15T03:00:00.000Z",
      windowDays: [14, 7],
      completeThrough: "2026-07-15",
      sourceIds: ["outcome_2", "outcome_1"],
      missingFields: [],
    },
  };
}

describe("buildSimulationInputManifest", () => {
  it("emits exact PIT eligibility only for complete cutoff-safe evidence", () => {
    const manifest = buildSimulationInputManifest(exactInput());

    expect(manifest.sourceMode).toBe("exact_raw_pit");
    expect(manifest.eligibility).toEqual({
      simulationEligible: true,
      exactPitEligible: true,
      reasons: [],
    });
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("downgrades an asserted exact manifest when required evidence is post-cutoff", () => {
    const input = exactInput();
    input.identity.creative.observedAt = "2026-07-01T03:00:01.000Z";

    const manifest = buildSimulationInputManifest(input);

    expect(manifest.assertedSourceMode).toBe("exact_raw_pit");
    expect(manifest.sourceMode).toBe("unreconstructable");
    expect(manifest.eligibility.exactPitEligible).toBe(false);
    expect(manifest.missingFields).toContain(
      "identity.creative.cutoff_safe_observation",
    );
  });

  it("never upgrades restated evidence even when every proof field is present", () => {
    const input = exactInput();
    input.sourceMode = "restated_ad_daily";

    const manifest = buildSimulationInputManifest(input);

    expect(manifest.sourceMode).toBe("restated_ad_daily");
    expect(manifest.eligibility.simulationEligible).toBe(true);
    expect(manifest.eligibility.exactPitEligible).toBe(false);
    expect(manifest.eligibility.reasons).toContain(
      "restated_source_not_exact_pit",
    );
  });

  it("rejects a current dimension even when its timestamp is cutoff-safe", () => {
    const input = exactInput();
    input.identity.creative.evidenceClass = "current_dimension";

    const manifest = buildSimulationInputManifest(input);

    expect(manifest.sourceMode).toBe("unreconstructable");
    expect(manifest.missingFields).toContain(
      "identity.creative.exact_observation",
    );
  });

  it("produces the same hash for semantically identical unordered receipts", () => {
    const first = exactInput();
    const second = exactInput();
    second.sourceIds.reverse();
    second.generation?.snapshotIds.reverse();
    second.outcomeCompleteness.sourceIds.reverse();
    second.outcomeCompleteness.windowDays.reverse();

    expect(buildSimulationInputManifest(first).sha256).toBe(
      buildSimulationInputManifest(second).sha256,
    );
  });

  it("includes conflicts and outcome completeness in the stable hash", () => {
    const baseline = buildSimulationInputManifest(exactInput());
    const conflictedInput = exactInput();
    conflictedInput.conflictFields = ["identity.ad.hierarchy"];
    const incompleteOutcomeInput = exactInput();
    incompleteOutcomeInput.outcomeCompleteness.status = "censored";

    const conflicted = buildSimulationInputManifest(conflictedInput);
    const incompleteOutcome = buildSimulationInputManifest(
      incompleteOutcomeInput,
    );

    expect(conflicted.sourceMode).toBe("unreconstructable");
    expect(conflicted.sha256).not.toBe(baseline.sha256);
    expect(incompleteOutcome.sha256).not.toBe(baseline.sha256);
  });
});
