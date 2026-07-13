import { describe, expect, it } from "vitest";
import {
  H12_POLICIES,
  evaluateH12Dataset,
  replayH12Policy,
  selectH12Policy,
  summarizeH12Policy,
  verifyH12PrefixInvariance,
  type H12Observation,
} from "./h12-decision-hysteresis";
import type { DecisionLabel } from "../types";

function rows(labels: DecisionLabel[], start = "2026-06-01"): H12Observation[] {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  return labels.map((rawLabel, index) => ({
    businessId: "b1",
    accountId: "a1",
    entityId: "e1",
    date: new Date(startMs + index * 86_400_000).toISOString().slice(0, 10),
    rawLabel,
    evidenceTier: "restated_ad_daily",
    sourceMode: "fixture",
    outcomeStatus: rawLabel === "cut" ? "supported" : "neutral",
    outcomeComplete: true,
    targetExact: true,
    decisionInputHash: `h${index}`,
  }));
}

describe("H12 bounded policy contract", () => {
  it("predeclares the fixed symmetric, gap-reset, and asymmetric matrix", () => {
    expect(H12_POLICIES).toHaveLength(7);
    expect(new Set(H12_POLICIES.map((policy) => policy.id)).size).toBe(7);
    expect(
      H12_POLICIES.map((policy) => ({
        entryConfirmations: policy.entryConfirmations,
        gapReset: policy.resetPendingAfterCalendarGap,
      })),
    ).toEqual([
      {
        entryConfirmations: { cut: 1, refresh: 1, scale: 1 },
        gapReset: false,
      },
      {
        entryConfirmations: { cut: 2, refresh: 2, scale: 2 },
        gapReset: false,
      },
      {
        entryConfirmations: { cut: 3, refresh: 3, scale: 3 },
        gapReset: false,
      },
      {
        entryConfirmations: { cut: 2, refresh: 2, scale: 2 },
        gapReset: true,
      },
      {
        entryConfirmations: { cut: 1, refresh: 2, scale: 2 },
        gapReset: false,
      },
      {
        entryConfirmations: { cut: 2, refresh: 2, scale: 3 },
        gapReset: false,
      },
      {
        entryConfirmations: { cut: 1, refresh: 2, scale: 3 },
        gapReset: false,
      },
    ]);
  });

  it("publishes hard entries at the declared confirmation count", () => {
    const observations = rows(["keep", "cut", "cut", "cut"]);
    expect(
      H12_POLICIES.slice(0, 3).map((policy) =>
        replayH12Policy({ observations, policy }).map(
          (row) => row.publishedLabel,
        ),
      ),
    ).toEqual([
      ["keep", "cut", "cut", "cut"],
      ["keep", "keep", "cut", "cut"],
      ["keep", "keep", "keep", "cut"],
    ]);
  });

  it("never delays a hard-to-soft safety exit", () => {
    for (const policy of H12_POLICIES) {
      const replay = replayH12Policy({
        observations: rows(["cut", "cut", "diagnose", "keep"]),
        policy,
      });
      expect(replay[2]!.publishedLabel).toBe("diagnose");
      expect(replay[3]!.publishedLabel).toBe("keep");
      expect(
        summarizeH12Policy({
          observations: rows(["cut", "cut", "diagnose"]),
          policy,
        }),
      ).toMatchObject({ safetyExitDelayViolations: 0 });
    }
  });

  it("neutralizes a direct hard switch instead of republishing the old action", () => {
    const replay = replayH12Policy({
      observations: rows(["scale", "scale", "cut", "cut"]),
      policy: H12_POLICIES[1],
    });
    expect(replay.map((row) => row.publishedLabel)).toEqual([
      "keep",
      "scale",
      "keep",
      "cut",
    ]);
    expect(
      summarizeH12Policy({
        observations: rows(["scale", "scale", "cut", "cut"]),
        policy: H12_POLICIES[1],
      }).hardSwitchOldActionRepublished,
    ).toBe(0);
  });

  it("scores calendar-gap reset as an explicit candidate", () => {
    const observations = rows(["cut", "cut"]);
    observations[1] = { ...observations[1]!, date: "2026-06-05" };
    expect(
      replayH12Policy({ observations, policy: H12_POLICIES[1] }).at(-1)!
        .publishedLabel,
    ).toBe("cut");
    expect(
      replayH12Policy({
        observations,
        policy: H12_POLICIES[3],
      }).at(-1)!.publishedLabel,
    ).toBe("keep");
  });

  it("uses action-specific entry confirmation counts without delaying exits", () => {
    const immediateCut = H12_POLICIES.find(
      (policy) => policy.id === "H12_cut1_scale3_refresh2",
    )!;
    expect(
      replayH12Policy({
        observations: rows(["keep", "cut"]),
        policy: immediateCut,
      }).at(-1)?.publishedLabel,
    ).toBe("cut");
    expect(
      replayH12Policy({
        observations: rows(["keep", "scale", "scale", "scale"]),
        policy: immediateCut,
      }).map((row) => row.publishedLabel),
    ).toEqual(["keep", "keep", "keep", "scale"]);
    expect(
      replayH12Policy({
        observations: rows(["scale", "scale", "scale", "diagnose"]),
        policy: immediateCut,
      }).at(-1)?.publishedLabel,
    ).toBe("diagnose");
  });

  it("scores 3d, 7d, and 14d outcomes independently", () => {
    const observations = rows(["keep", "cut", "cut"]).map((row) => ({
      ...row,
      outcomesByWindow: {
        "3": { outcomeStatus: "supported" as const, outcomeComplete: true },
        "7": { outcomeStatus: "refuted" as const, outcomeComplete: true },
        "14": { outcomeStatus: "unknown" as const, outcomeComplete: false },
      },
      outcomeStatus: "unknown" as const,
      outcomeComplete: false,
    }));
    const metrics = summarizeH12Policy({
      observations,
      policy: H12_POLICIES[1],
    });
    expect(metrics.outcomeWindows["3"].outcomePrecision).toBe(1);
    expect(metrics.outcomeWindows["7"].outcomePrecision).toBe(0);
    expect(metrics.outcomeWindows["14"].outcomePrecision).toBeNull();
  });

  it("matures each outcome window against its own locked-test due date", () => {
    const observations = rows(["cut"], "2026-07-04").map((row) => ({
      ...row,
      outcomesByWindow: {
        "3": { outcomeStatus: "supported" as const, outcomeComplete: true },
        "7": { outcomeStatus: "supported" as const, outcomeComplete: true },
        "14": { outcomeStatus: "supported" as const, outcomeComplete: true },
      },
    }));
    const evaluation = evaluateH12Dataset({
      observations,
      evidenceTier: "restated_ad_daily",
      outcomesObservedThrough: "2026-07-11",
    });
    const baseline = evaluation.folds
      .find((fold) => fold.foldId === "locked_test")!
      .policyMetrics.find(
        (metric) => metric.policyId === "H12_no_hard_label_hysteresis",
      )!;
    expect(baseline.outcomeWindows["3"].outcomeKnownPublishedEntries).toBe(1);
    expect(baseline.outcomeWindows["7"].outcomeKnownPublishedEntries).toBe(1);
    expect(baseline.outcomeWindows["14"].outcomeKnownPublishedEntries).toBe(0);
  });

  it("is prefix-causal when every future raw label is mutated", () => {
    const result = verifyH12PrefixInvariance({
      observations: rows(["keep", "cut", "cut", "keep", "scale"]),
      policy: H12_POLICIES[1],
      cutoffDate: "2026-06-03",
    });
    expect(result).toMatchObject({ passed: true, prefixRows: 3 });
    expect(result.baselineHash).toBe(result.mutatedFutureHash);
  });

  it("rejects pooled evidence tiers", () => {
    const observations = rows(["keep", "cut"]);
    observations[1] = {
      ...observations[1]!,
      evidenceTier: "persisted_raw_label",
    };
    expect(() =>
      evaluateH12Dataset({
        observations,
        evidenceTier: "restated_ad_daily",
        outcomesObservedThrough: "2026-07-11",
      }),
    ).toThrow("evidence tiers must not be pooled");
  });

  it("selects two evaluations when it reduces flapping without delaying exits", () => {
    const observations = rows(
      ["keep", "cut", "keep", "keep", "cut", "cut", "cut", "keep"],
      "2026-04-01",
    );
    const metrics = H12_POLICIES.map((policy) =>
      summarizeH12Policy({ observations, policy }),
    );
    expect(selectH12Policy(metrics).selectedPolicyId).toBe(
      "H12_two_consecutive_evaluations",
    );
  });
});
