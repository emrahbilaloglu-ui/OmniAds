import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What the date picker on Decisions is allowed to call itself.
 *
 * The canonical read model types the scope as
 * `metricsRangeAffectsDecisionSnapshot: false` — changing the range changes
 * which metrics and evidence are shown, and does not change the verdict, the
 * snapshot, or any authority derived from it. The control was labelled
 * "Decision date range", which says the opposite: it invites an operator to
 * believe that widening the window produces different decisions, and to
 * distrust the verdict when it does not move.
 *
 * This is a labelling contract, not a resolver change. Nothing here touches
 * `buyerAction`, confidence, thresholds, authority or snapshot semantics.
 */
const view = readFileSync(
  "components/meta/decision-center/MetaDecisionCenterExact.tsx",
  "utf8",
);
const contract = readFileSync(
  "lib/meta/decisions-workspace-contract.ts",
  "utf8",
);

describe("the range control names what it actually changes", () => {
  it("the contract still says the range does not move the snapshot", () => {
    // If this ever flips, the label below has to be revisited rather than
    // silently left behind.
    expect(contract).toContain("metricsRangeAffectsDecisionSnapshot: false");
  });

  it("does not call itself a decision range", () => {
    expect(
      /label="Decision date range"/.test(view),
      'the control is labelled "Decision date range" while the contract says the range does not affect the decision snapshot',
    ).toBe(false);
  });

  it("names the metrics/evidence window instead", () => {
    expect(view).toMatch(/`(Metrics|Evidence)[^`]*window /);
  });

  it("states in the UI that the range scopes metrics, not decisions", () => {
    // The label alone is not enough: an operator who already believes the old
    // meaning needs to be told, once, beside the queue the window sits above.
    expect(view).toMatch(/the date range scopes metrics, not\s+decisions/);
  });
});
