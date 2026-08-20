import { describe, expect, it } from "vitest";
import { dedupeReadinessBlockers } from "./meta-decision-center-exact-adapter";

/**
 * The inspector's Blockers line printed every paired requirement twice.
 *
 * Observed live: nineteen tokens where nine were the other ten restated —
 * `missing_rollback_plan · … · rollback_plan`. The server keeps `blockers` and
 * `missingEvidence` as parallel vocabularies, dedupes each only within itself,
 * and the adapter concatenated them.
 */
describe("the two readiness vocabularies print once each", () => {
  it("withholds the bare requirement when the blocker already states it", () => {
    expect(
      dedupeReadinessBlockers(
        ["missing_rollback_plan", "missing_live_preflight"],
        ["rollback_plan", "live_preflight"],
      ),
    ).toEqual(["missing_rollback_plan", "missing_live_preflight"]);
  });

  it("keeps the polarity-carrying spelling, not the bare one", () => {
    // "missing_" is the half that tells the operator which way the fact runs.
    const out = dedupeReadinessBlockers(["missing_operator_enablement"], ["operator_enablement"]);
    expect(out).toEqual(["missing_operator_enablement"]);
  });

  it("leaves a near-miss alone rather than guessing it is a pair", () => {
    // These LOOK paired and are not. Collapsing them would be an inference
    // about engine semantics, which presentation may not make.
    expect(
      dedupeReadinessBlockers(
        ["no_empirical_outcome_model", "insufficient_empirical_sample"],
        ["empirical_outcome_backtest", "empirical_outcome_sample"],
      ),
    ).toEqual([
      "no_empirical_outcome_model",
      "insufficient_empirical_sample",
      "empirical_outcome_backtest",
      "empirical_outcome_sample",
    ]);
  });

  it("keeps a requirement the blockers never mention", () => {
    expect(
      dedupeReadinessBlockers(["missing_rollback_plan"], ["valid_treatment_receipt"]),
    ).toEqual(["missing_rollback_plan", "valid_treatment_receipt"]);
  });

  it("drops nothing when only one list is served", () => {
    expect(dedupeReadinessBlockers(["unsupported_action_class"], [])).toEqual([
      "unsupported_action_class",
    ]);
    expect(dedupeReadinessBlockers([], ["rollback_plan"])).toEqual(["rollback_plan"]);
    expect(dedupeReadinessBlockers(null, undefined)).toEqual([]);
  });

  it("reproduces the observed live case: 19 tokens become 13", () => {
    const out = dedupeReadinessBlockers(
      [
        "no_empirical_outcome_model", "missing_controlled_causal_evidence",
        "missing_valid_treatment_receipt", "missing_valid_random_assignment",
        "missing_valid_control_estimate", "insufficient_empirical_sample",
        "missing_live_preflight", "missing_rollback_plan",
        "missing_operator_enablement", "unsupported_action_class",
      ],
      [
        "empirical_outcome_backtest", "controlled_causal_outcomes",
        "valid_treatment_receipt", "valid_random_assignment",
        "valid_control_estimate", "empirical_outcome_sample",
        "live_preflight", "rollback_plan", "operator_enablement",
      ],
    );
    expect(out).toHaveLength(13);
    // The six exact pairs collapsed…
    expect(out).not.toContain("rollback_plan");
    expect(out).not.toContain("valid_treatment_receipt");
    expect(out).toContain("missing_rollback_plan");
    // …and the three genuinely distinct requirements survived.
    expect(out).toContain("empirical_outcome_backtest");
    expect(out).toContain("controlled_causal_outcomes");
    expect(out).toContain("empirical_outcome_sample");
  });
});

describe("both spellings inside ONE list collapse too", () => {
  /**
   * The first fix only compared the two lists against each other. The server
   * merges both vocabularies into `blockers` itself, so it never fired.
   *
   * Measured on the live Grandmix inspector: seventeen tokens on screen, which
   * is exactly what an across-lists pass returns when everything already sits
   * in one list. Had they truly arrived split it would have returned eleven —
   * that arithmetic is what identified the wrong seam.
   */
  const LIVE_SINGLE_LIST = [
    "missing_controlled_causal_evidence",
    "missing_valid_treatment_receipt",
    "missing_valid_random_assignment",
    "missing_valid_control_estimate",
    "insufficient_empirical_sample",
    "missing_live_preflight",
    "missing_rollback_plan",
    "missing_operator_enablement",
    "unsupported_action_class",
    "controlled_causal_outcomes",
    "valid_treatment_receipt",
    "valid_random_assignment",
    "valid_control_estimate",
    "empirical_outcome_sample",
    "live_preflight",
    "rollback_plan",
    "operator_enablement",
  ];

  it("collapses the live seventeen to eleven", () => {
    const out = dedupeReadinessBlockers(LIVE_SINGLE_LIST, []);
    expect(out).toHaveLength(11);
    expect(out).not.toContain("rollback_plan");
    expect(out).not.toContain("valid_treatment_receipt");
    expect(out).not.toContain("live_preflight");
    expect(out).toContain("missing_rollback_plan");
    expect(out).toContain("missing_live_preflight");
  });

  it("keeps the genuinely distinct requirements the blockers never restate", () => {
    const out = dedupeReadinessBlockers(LIVE_SINGLE_LIST, []);
    // `controlled_causal_outcomes` is NOT `missing_controlled_causal_evidence`,
    // and `empirical_outcome_sample` is NOT `insufficient_empirical_sample`.
    // They look paired and are not; collapsing them would be an inference.
    expect(out).toContain("controlled_causal_outcomes");
    expect(out).toContain("empirical_outcome_sample");
    expect(out).toContain("unsupported_action_class");
  });

  it("prefers the prefixed spelling regardless of arrival order", () => {
    expect(dedupeReadinessBlockers(["rollback_plan", "missing_rollback_plan"], [])).toEqual([
      "missing_rollback_plan",
    ]);
    expect(dedupeReadinessBlockers(["missing_rollback_plan", "rollback_plan"], [])).toEqual([
      "missing_rollback_plan",
    ]);
  });
});
