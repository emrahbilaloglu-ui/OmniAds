import { describe, expect, it } from "vitest";
import { pairedActionStratifiedPermutationTest } from "./stratified-permutation";

describe("pairedActionStratifiedPermutationTest", () => {
  it("is deterministic and detects candidate actions aligned with support", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: `row-${String(index).padStart(2, "0")}`,
      stratumId: `account-${Math.floor(index / 10)}`,
      baselineEmitted: false,
      candidateEmitted: index % 10 < 5,
      outcomeSupported: index % 10 < 5,
    }));
    const first = pairedActionStratifiedPermutationTest(rows, {
      seed: "aligned",
      iterations: 2_000,
    });
    const second = pairedActionStratifiedPermutationTest(rows, {
      seed: "aligned",
      iterations: 2_000,
    });

    expect(second).toEqual(first);
    expect(first.observedNetCorrectDelta).toBe(20);
    expect(first.observedMeanDelta).toBe(1);
    expect(first.oneSidedPValue).toBeLessThan(0.01);
  });

  it("returns an unavailable test when policies never disagree", () => {
    expect(
      pairedActionStratifiedPermutationTest(
        [
          {
            id: "same",
            stratumId: "account-week",
            baselineEmitted: true,
            candidateEmitted: true,
            outcomeSupported: true,
          },
        ],
        { seed: "same" },
      ),
    ).toMatchObject({
      discordantActionCount: 0,
      observedMeanDelta: null,
      oneSidedPValue: null,
    });
  });

  it("rejects duplicate observation identities", () => {
    expect(() =>
      pairedActionStratifiedPermutationTest(
        [
          {
            id: "duplicate",
            stratumId: "one",
            baselineEmitted: false,
            candidateEmitted: true,
            outcomeSupported: true,
          },
          {
            id: "duplicate",
            stratumId: "one",
            baselineEmitted: true,
            candidateEmitted: false,
            outcomeSupported: false,
          },
        ],
        { seed: "duplicate" },
      ),
    ).toThrow("observation ids must be unique");
  });
});
