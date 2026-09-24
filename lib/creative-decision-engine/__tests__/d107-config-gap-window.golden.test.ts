import { describe, expect, it } from "vitest";

import { decideCreative } from "../engine";
import {
  cumulativePeriodLabel,
  recentPeriodLabel,
} from "../gates/reason-format";
import type { CreativeInput, DecisionEvidenceWindow } from "../types";
import { makeAccountDecisionProfile, makeCreativeInput } from "./helpers";

/*
  ADR D107 golden cases — docs/creative-decision-center/GOLDEN_CASES.md,
  "D107 config-gap window (golden cases)".

  The window RULE lives in SQL and in calibration and is pinned against real
  PostgreSQL by native-ad-admitted-window.db.test.ts. These cases pin what the
  resolver does with the input that rule now produces. D107-01/02 use the
  inputs the D107 hydration actually admitted in the read-only production
  replay (Grandmix, as-of 2026-09-24, cutoff 10:02Z): the run 2026-09-09..
  2026-09-23 with 2026-09-21 bridged. Its older edge (before 09-09) has no
  readable objective under the source contract and is not bridged.

    D107-01  Grandmix 120247883891620316 — old strong performer whose run a
             NULL-objective day used to collapse to one day ($35, 0 purchases,
             soft Cut). Admitted run: $381.42, 7 purchases, ROAS 6.75.
    D107-02  Grandmix 120247018755120316 — a real loser. Admitted run:
             $3,332.16, 7 purchases, ROAS 0.47; last 6 days $1,555.06 at 0.
    D107-03  A real, provider-observed configuration change: the short run
             after it is a valid decision window.
    D107-04  Zero-purchase TheSwaf-shaped test ads at $163–176 against the
             TRUSTED floors (maturity 147.88, zero-conversion 197.17): no Cut
             and no pre-authority Cut from that threshold family.
    D107-05  Reason text states the admitted window it summed.
*/

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** A window as the hydration SQL emits it, for a lookback ending `asOf`. */
function window(
  startDate: string,
  endDate: string,
  overrides: Partial<DecisionEvidenceWindow> & { asOf?: string } = {},
): DecisionEvidenceWindow {
  const { asOf = "2026-09-23", ...rest } = overrides;
  const span =
    Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) -
        Date.parse(`${startDate}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  const bandStart = shiftDay(asOf, -6);
  const recentStart = startDate > bandStart ? startDate : bandStart;
  const recentEnd = endDate < asOf ? endDate : asOf;
  return {
    startDate,
    endDate,
    calendarDaySpan: span,
    observedDayCount: span,
    economicDayCount: span,
    bridgedUnresolvedDayCount: 0,
    lookbackStartDate: shiftDay(asOf, -27),
    lookbackEndDate: asOf,
    recentStartDate: recentStart <= recentEnd ? recentStart : null,
    recentEndDate: recentStart <= recentEnd ? recentEnd : null,
    ...rest,
  };
}

/** The run the D107 hydration admitted for Grandmix at the 2026-09-24 replay. */
const GRANDMIX_RUN = window("2026-09-09", "2026-09-23", {
  asOf: "2026-09-24",
  bridgedUnresolvedDayCount: 1,
});

/** No funnel or click evidence, so rows are judged on economics alone. */
const NO_FUNNEL = {
  ctr: null,
  impressions: null,
  linkClicks: null,
  outboundClicks: null,
  landingPageViews: null,
  addToCart: null,
  initiateCheckout: null,
  thumbstop: null,
} satisfies Partial<CreativeInput>;

describe("D107 config-gap window golden cases", () => {
  it("D107-01: an old strong performer is judged on its whole run, not the day after a gap", () => {
    const profile = makeAccountDecisionProfile();
    const input = makeCreativeInput({
      ...NO_FUNNEL,
      spend: 381.42,
      purchases: 7,
      purchaseValue: 381.42 * 6.75,
      roas: 6.75,
      cpa: 381.42 / 7,
      recent7dSpend: 193.99,
      recent7dPurchases: 3,
      recent7dRoas: 8.29,
      ageDays: 131,
      targetRoas: 2.2,
      breakevenRoas: 1.8,
      decisionWindow: GRANDMIX_RUN,
    });
    const decision = decideCreative(input, profile);
    expect(decision.label).not.toBe("cut");
    expect(decision.preAuthorityLabel).not.toBe("cut");
    expect(decision.badges.map((badge) => badge.type)).not.toContain(
      "cut_candidate",
    );
    expect(decision.reason).not.toContain("0 purchases");
    expect(decision.reason).toContain("ROAS 6.75 (15d 2026-09-09..2026-09-23)");
  });

  it("D107-02: a real loser keeps its Cut verdict on the whole run", () => {
    const profile = makeAccountDecisionProfile();
    const decision = decideCreative(
      makeCreativeInput({
        ...NO_FUNNEL,
        spend: 3332.16,
        purchases: 7,
        purchaseValue: 3332.16 * 0.47,
        roas: 0.47,
        cpa: 3332.16 / 7,
        recent7dSpend: 1555.06,
        recent7dPurchases: 0,
        recent7dRoas: 0,
        ageDays: 144,
        targetRoas: 2.2,
        breakevenRoas: 1.8,
        decisionWindow: GRANDMIX_RUN,
      }),
      profile,
    );
    // The economic verdict is not thrown to review. Whether it may be EXECUTED
    // is the native authority boundary's question: a bridged day is unverified
    // config, so D098 withholds the action (ad-decisions-job).
    expect(decision.label).toBe("cut");
    expect(decision.reason).toContain("ROAS 0.47 (15d 2026-09-09..2026-09-23)");
  });

  it("D107-03: a short run after an observed configuration change is a valid window", () => {
    const profile = makeAccountDecisionProfile({
      thresholds: {
        commercialMaturitySpend: 200,
        zeroConvBurnerSpend: 300,
        cutCandidateSpend: 400,
      },
    });
    const postChange = window("2026-09-19", "2026-09-23");
    const mature = decideCreative(
      makeCreativeInput({
        ...NO_FUNNEL,
        spend: 520,
        purchases: 0,
        purchaseValue: 0,
        roas: 0,
        cpa: null,
        recent7dSpend: 520,
        recent7dPurchases: 0,
        recent7dRoas: 0,
        ageDays: 20,
        decisionWindow: postChange,
      }),
      profile,
    );
    expect(mature.label).toBe("cut");
    expect(mature.reason).toBe(
      "0 purchases on 520 spend (5d 2026-09-19..2026-09-23 cumulative, age 20d) — sustained zero-conversion burn past CPA-anchored maturity threshold 300.",
    );

    const thin = decideCreative(
      makeCreativeInput({
        ...NO_FUNNEL,
        spend: 250,
        purchases: 0,
        purchaseValue: 0,
        roas: 0,
        cpa: null,
        recent7dSpend: 250,
        recent7dPurchases: 0,
        recent7dRoas: 0,
        ageDays: 20,
        decisionWindow: postChange,
      }),
      profile,
    );
    expect(thin.label).toBe("test_more");
    expect(thin.preAuthorityLabel).not.toBe("cut");
  });

  it("D107-04: against the trusted floors, zero purchases below the zero-conversion floor is no Cut of any kind", () => {
    const profile = makeAccountDecisionProfile({
      spendUnit: 65.72,
      thresholds: {
        commercialMaturitySpend: 147.88,
        zeroConvBurnerSpend: 197.17,
        cutCandidateSpend: 400,
        sustainedLoserSpend: 197.17,
        hardCutSpend: 400,
      },
    });
    for (const spend of [163.73, 166.21, 170.95, 176.35]) {
      const decision = decideCreative(
        makeCreativeInput({
          ...NO_FUNNEL,
          spend,
          purchases: 0,
          purchaseValue: 0,
          roas: 0,
          cpa: null,
          recent7dSpend: spend,
          recent7dPurchases: 0,
          recent7dRoas: 0,
          ageDays: 10,
          targetRoas: 2,
          breakevenRoas: 1.71,
          decisionWindow: window("2026-09-14", "2026-09-23"),
        }),
        profile,
      );
      expect(decision.label).not.toBe("cut");
      expect(decision.preAuthorityLabel).not.toBe("cut");
    }
  });

  it("D107-05: reason text names the admitted window it summed", () => {
    const profile = makeAccountDecisionProfile();
    const base = {
      ...NO_FUNNEL,
      spend: 1_200,
      purchases: 4,
      purchaseValue: 480,
      roas: 0.4,
      cpa: 300,
      recent7dSpend: 300,
      recent7dPurchases: 1,
      recent7dRoas: 0.3,
      ageDays: 30,
    } satisfies Partial<CreativeInput>;

    const legacy = decideCreative(makeCreativeInput(base), profile);
    expect(legacy.reason).toContain("(28d)");

    const short = decideCreative(
      makeCreativeInput({
        ...base,
        decisionWindow: window("2026-09-22", "2026-09-23"),
      }),
      profile,
    );
    expect(short.reason).not.toContain("(28d)");
    expect(short.reason).toContain("(2d 2026-09-22..2026-09-23)");
  });
});

describe("period labels (ADR D107)", () => {
  it("keep the conventional labels when the figures span the full lookback", () => {
    const full = window("2026-08-27", "2026-09-23");
    expect(cumulativePeriodLabel({ decisionWindow: full })).toBe("28d");
    expect(recentPeriodLabel({ decisionWindow: full })).toBe("7d");
    expect(cumulativePeriodLabel({})).toBe("28d");
    expect(recentPeriodLabel({ decisionWindow: null })).toBe("7d");
  });

  it("name the start, end and day count of a shorter run", () => {
    const short = window("2026-09-22", "2026-09-23");
    expect(cumulativePeriodLabel({ decisionWindow: short })).toBe(
      "2d 2026-09-22..2026-09-23",
    );
    expect(recentPeriodLabel({ decisionWindow: short })).toBe(
      "2d 2026-09-22..2026-09-23",
    );
  });

  it("clip the recent band to a run that ends early", () => {
    const early = window("2026-08-27", "2026-09-20", {
      recentStartDate: "2026-09-17",
      recentEndDate: "2026-09-20",
    });
    expect(cumulativePeriodLabel({ decisionWindow: early })).toBe(
      "25d 2026-08-27..2026-09-20",
    );
    expect(recentPeriodLabel({ decisionWindow: early })).toBe(
      "4d 2026-09-17..2026-09-20",
    );
  });
});
