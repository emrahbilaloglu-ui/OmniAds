import { describe, expect, it } from "vitest";
import {
  META_BID_VALUE_UNIT_CONTRACT_VERSION,
  META_TARGET_ROAS_UNIT_CONTRACT_VERSION,
  buildConfigSnapshotPayload,
  metaTargetRoasFromProviderFloor,
  metaBidValueToMinorUnits,
  normalizeBidStrategy,
  normalizeOptimizationGoal,
  stripIncompleteConstrainedBidFields,
  summarizeCampaignConfig,
} from "@/lib/meta/configuration";

describe("meta configuration helpers", () => {
  it("normalizes optimization goals into readable labels", () => {
    expect(normalizeOptimizationGoal("omni_purchase")).toBe("Purchase");
    expect(normalizeOptimizationGoal("LEAD_GENERATION")).toBe("Lead");
  });

  it("normalizes bid strategies into supported labels", () => {
    expect(normalizeBidStrategy("LOWEST_COST_WITH_BID_CAP", null)).toEqual({
      type: "bid_cap",
      label: "Bid Cap",
    });
    expect(normalizeBidStrategy(null, 2500)).toEqual({
      type: "manual_bid",
      label: "Manual Bid",
    });
  });

  it("strips incomplete constrained bid fields before durable storage", () => {
    expect(
      stripIncompleteConstrainedBidFields({
        bidStrategyType: "cost_cap",
        bidValue: null,
        bidValueFormat: "currency",
        isBidValueMixed: true,
      }),
    ).toEqual({
      bidStrategyType: null,
      bidValue: null,
      bidValueFormat: null,
      isBidValueMixed: false,
    });

    expect(
      stripIncompleteConstrainedBidFields({
        bidStrategyType: "lowest_cost",
        bidValue: null,
        bidValueFormat: null,
      }),
    ).toEqual({
      bidStrategyType: "lowest_cost",
      bidValue: null,
      bidValueFormat: null,
    });
  });

  it("builds a single-value campaign summary from matching ad sets", () => {
    const adsets = [
      buildConfigSnapshotPayload({
        campaignId: "cmp_1",
        optimizationGoal: "omni_purchase",
        bidStrategy: "LOWEST_COST_WITH_BID_CAP",
        manualBidAmount: 2400,
        dailyBudget: 5000,
      }),
      buildConfigSnapshotPayload({
        campaignId: "cmp_1",
        optimizationGoal: "omni_purchase",
        bidStrategy: "LOWEST_COST_WITH_BID_CAP",
        manualBidAmount: 2400,
        dailyBudget: 5000,
      }),
    ];

    const summary = summarizeCampaignConfig({
      campaignId: "cmp_1",
      adsets,
      previousAdsets: [{ campaignId: "cmp_1", manualBidAmount: 2000 }],
    });

    expect(summary.optimizationGoal).toBe("Purchase");
    expect(summary.bidStrategyLabel).toBe("Bid Cap");
    expect(summary.manualBidAmount).toBe(2400);
    expect(summary.bidValue).toBe(2400);
    expect(summary.bidValueFormat).toBe("currency");
    expect(summary.previousManualBidAmount).toBe(2000);
    expect(summary.previousBidValue).toBe(2000);
    expect(summary.isConfigMixed).toBe(false);
  });

  it("marks mixed config when ad sets disagree", () => {
    const summary = summarizeCampaignConfig({
      campaignId: "cmp_2",
      adsets: [
        buildConfigSnapshotPayload({
          campaignId: "cmp_2",
          optimizationGoal: "omni_purchase",
          bidStrategy: "LOWEST_COST_WITH_BID_CAP",
          manualBidAmount: 3000,
          dailyBudget: 4000,
        }),
        buildConfigSnapshotPayload({
          campaignId: "cmp_2",
          optimizationGoal: "lead_generation",
          bidStrategy: "COST_CAP",
          manualBidAmount: null,
          dailyBudget: 7000,
        }),
      ],
    });

    expect(summary.optimizationGoal).toBeNull();
    expect(summary.manualBidAmount).toBeNull();
    expect(summary.bidValue).toBe(3000);
    expect(summary.isConfigMixed).toBe(true);
    expect(summary.isBudgetMixed).toBe(true);
  });

  it("rolls up ad set custom events and flags mixed campaigns", () => {
    const purchaseSummary = summarizeCampaignConfig({
      campaignId: "cmp_events",
      adsets: [
        buildConfigSnapshotPayload({
          campaignId: "cmp_events",
          optimizationGoal: "offsite_conversions",
          customEventType: "purchase",
          pixelId: "px_1",
          promotedObject: { pixel_id: "px_1", custom_event_type: "PURCHASE" },
        }),
        buildConfigSnapshotPayload({
          campaignId: "cmp_events",
          optimizationGoal: "offsite_conversions",
          customEventType: "PURCHASE",
          pixelId: "px_1",
          promotedObject: { pixel_id: "px_1", custom_event_type: "PURCHASE" },
        }),
      ],
    });

    expect(purchaseSummary.customEventType).toBe("PURCHASE");
    expect(purchaseSummary.isCustomEventTypeMixed).toBe(false);

    const mixedSummary = summarizeCampaignConfig({
      campaignId: "cmp_mixed_events",
      adsets: [
        buildConfigSnapshotPayload({
          campaignId: "cmp_mixed_events",
          customEventType: "PURCHASE",
        }),
        buildConfigSnapshotPayload({
          campaignId: "cmp_mixed_events",
          customEventType: "ADD_TO_CART",
        }),
      ],
    });

    expect(mixedSummary.customEventType).toBeNull();
    expect(mixedSummary.isCustomEventTypeMixed).toBe(true);
    expect(mixedSummary.isConfigMixed).toBe(true);
  });

  it("uses target roas constraints as bid value", () => {
    /*
      `targetRoas` is Meta's `bid_constraints.roas_average_floor`, and every
      caller hands it over as the raw provider integer — `parseNum` of the
      string, never a pre-divided multiplier (lib/meta/live.ts:296,
      lib/api/meta.ts:931/1071/7126/7311, lib/meta/raw-config-receipts.ts:269).
      This case used to pass 3.4, a value the provider cannot send, and pin the
      magnitude guess that made a floor of exactly 100 read as 100x. A 3.4x
      target is raw 34000.
    */
    const adset = buildConfigSnapshotPayload({
      campaignId: "cmp_3",
      bidStrategy: "LOWEST_COST_WITH_MIN_ROAS",
      targetRoas: 34_000,
    });

    expect(adset.bidStrategyLabel).toBe("Target ROAS");
    expect(adset.bidValue).toBe(3.4);
    expect(adset.bidValueFormat).toBe("roas");
    expect(adset.manualBidAmount).toBeNull();
  });

  it("normalizes target roas values returned in scaled units", () => {
    const adset = buildConfigSnapshotPayload({
      campaignId: "cmp_4",
      bidStrategy: "LOWEST_COST_WITH_MIN_ROAS",
      targetRoas: 25000,
    });

    expect(adset.bidStrategyLabel).toBe("Target ROAS");
    expect(adset.bidValue).toBe(2.5);
    expect(adset.bidValueFormat).toBe("roas");
  });
});

/*
  ── THE BID VALUE UNIT CONTRACT ─────────────────────────────────────────────

  Meta's Ad Set reference, verbatim: "The bid amount's unit is cents for
  currencies like USD, EUR, and the basic unit for currencies like JPY, KRW."
  So `bid_amount` is ISO-4217 MINOR units, `live.ts` stores it unscaled, and
  `warehouse.ts` already THROWS `meta_current_config_history_bid_value_source_mismatch`
  unless the stored `bidValue` equals the raw `bid_amount`.

  One consumer read it as MAJOR and multiplied by `10 ** exponent`. These cases
  pin the corrected contract, and they are written per currency because the bug
  is INVISIBLE on exponent 0 — which is why it survived.
*/
describe("reading a stored bid value as minor units", () => {
  const currency = (bidValue: number, currencyExponent: number | null) =>
    metaBidValueToMinorUnits({ bidValue, bidValueFormat: "currency", currencyExponent });

  it("USD: a $120.00 cap is 12000 minor and stays 12000", () => {
    /* The live case. Graph GET on ad set 120251964734540042 returns a bid
       amount of 120 USD; this warehouse stores 12000. The old reader made it
       1,200,000 — a $12,000.00 cap. */
    const read = currency(12_000, 2);
    expect(read).toEqual({
      ok: true, minorUnits: 12_000,
      contractVersion: META_BID_VALUE_UNIT_CONTRACT_VERSION,
    });
    expect(read.ok && read.minorUnits).not.toBe(Math.round(12_000 * 10 ** 2));
  });

  it("JPY: exponent 0 makes the old bug invisible, and the answer is the same", () => {
    /* 10 ** 0 === 1, so the removed multiply was the identity here. This case
       exists so a future reviewer does not conclude from a passing JPY test
       that the scaling was ever correct. */
    const read = currency(500, 0);
    expect(read.ok && read.minorUnits).toBe(500);
    expect(Math.round(500 * 10 ** 0)).toBe(500);
  });

  it("KWD: exponent 3, where the old bug was 1000x", () => {
    /* Exercises the exponent-3 path. Note KWD is NOT in Meta's published
       currency list, so this is a test of the code at that exponent rather
       than of a currency Meta serves. */
    const read = currency(1_500, 3);
    expect(read.ok && read.minorUnits).toBe(1_500);
    expect(Math.round(1_500 * 10 ** 3)).toBe(1_500_000);
  });

  it("gives the same answer at every exponent, so a wrong exponent cannot move a bid", () => {
    /*
      Meta's own per-currency `offset` disagrees with the ISO-4217 exponent this
      repository resolves — 100x apart on HUF/IDR/TWD/COP, 10x on BHD/JOD — and
      the repository never reads Meta's number. This conversion is immune to
      that because it does not scale: the exponent gates the read, it does not
      change the value. Anything that still multiplies by the exponent is not.
    */
    const answers = [0, 2, 3].map((exponent) => currency(12_000, exponent));
    expect(answers.every((a) => a.ok && a.minorUnits === 12_000)).toBe(true);
  });

  it("refuses a ROAS ratio, which is not a currency amount at any scale", () => {
    /* 2.5 means 2.5x. Read as minor units it would be a two-cent bid cap. */
    expect(metaBidValueToMinorUnits({
      bidValue: 2.5, bidValueFormat: "roas", currencyExponent: 2,
    })).toEqual({ ok: false, refusal: "bid_value_not_a_currency_cap" });
  });

  it("refuses a missing format rather than assuming currency", () => {
    expect(metaBidValueToMinorUnits({
      bidValue: 12_000, bidValueFormat: null, currencyExponent: 2,
    })).toEqual({ ok: false, refusal: "bid_value_not_a_currency_cap" });
  });

  it("refuses an unknown currency scale", () => {
    expect(currency(12_000, null)).toEqual({
      ok: false, refusal: "currency_exponent_unknown",
    });
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a bid value of %s",
    (value) => {
      expect(metaBidValueToMinorUnits({
        bidValue: value as number, bidValueFormat: "currency", currencyExponent: 2,
      })).toEqual({ ok: false, refusal: "bid_value_absent" });
    },
  );

  /*
    THE NO-SILENT-REINTERPRETATION RULE. A fractional value cannot be a whole
    number of provider minor units, so it is refused rather than rounded into
    one. Across 294,991 retained currency bid rows there is not one such value,
    so this costs nothing today; it is what stops a row written under some
    other convention from being read as money.
  */
  it.each([12.5, 12.0001, -1, 0.5])("refuses %s rather than rounding it into minor units", (value) => {
    expect(currency(value, 2)).toEqual({
      ok: false, refusal: "bid_value_not_provider_minor_units",
    });
  });

  it("accepts a whole-number zero and an exact integer float", () => {
    /* 12.00 parses to the integer 12 in JS, and an integer IS admissible - it
       is 12 minor units, not $12.00. The refusal above is for genuine
       fractions, not for a value that merely arrived typed as a float. */
    expect(currency(0, 2).ok).toBe(true);
    expect(currency(12.00, 2)).toEqual({
      ok: true, minorUnits: 12,
      contractVersion: META_BID_VALUE_UNIT_CONTRACT_VERSION,
    });
  });

  it("refuses a value beyond the safe minor-unit range", () => {
    expect(currency(Number.MAX_SAFE_INTEGER, 2)).toEqual({
      ok: false, refusal: "bid_value_not_provider_minor_units",
    });
  });

  it("binds a version, so a stored intent can name the contract it used", () => {
    expect(META_BID_VALUE_UNIT_CONTRACT_VERSION).toBe("meta.bid-value-units.v1");
  });
});

describe("reading Meta's scaled ROAS floor", () => {
  it("divides unconditionally, exactly as the provider documents", () => {
    /* "roas_average_floor = 23300 means 'the minimum roas' = 2.33" */
    expect(metaTargetRoasFromProviderFloor(23_300)).toBe(2.33);
    expect(metaTargetRoasFromProviderFloor(20_000)).toBe(2);
    expect(metaTargetRoasFromProviderFloor(10_000_000)).toBe(1000);
  });

  it("reads the documented minimum as 0.01, not as 100x", () => {
    /*
      The boundary the magnitude guess got wrong. `Math.abs(100) > 100` is
      false, so raw 100 — a floor Meta documents as the smallest it accepts —
      used to be stored as a ROAS target of 100x. An account that really was
      set to a 0.01 floor would have been read as demanding a hundredfold
      return.
    */
    expect(metaTargetRoasFromProviderFloor(100)).toBe(0.01);
  });

  it("refuses a value outside the documented interval instead of scaling it", () => {
    expect(metaTargetRoasFromProviderFloor(99)).toBeNull();
    expect(metaTargetRoasFromProviderFloor(10_000_001)).toBeNull();
    expect(metaTargetRoasFromProviderFloor(0)).toBeNull();
    expect(metaTargetRoasFromProviderFloor(-23_300)).toBeNull();
  });

  it("refuses an absent or non-finite floor", () => {
    expect(metaTargetRoasFromProviderFloor(null)).toBeNull();
    expect(metaTargetRoasFromProviderFloor(undefined)).toBeNull();
    expect(metaTargetRoasFromProviderFloor(Number.NaN)).toBeNull();
  });

  it("is not idempotent, which is why it may only see a RAW floor", () => {
    /*
      This is the property that makes a second application a defect rather
      than a harmless no-op: feeding the OUTPUT back in either refuses it or
      changes it. The old function hid this by branching on magnitude, so a
      second pass looked safe for every value below 100 — which is every value
      the warehouse actually holds. The read path now passes stored ROAS
      through; this case exists so that can never quietly regress.
    */
    const once = metaTargetRoasFromProviderFloor(23_300);
    expect(once).toBe(2.33);
    expect(metaTargetRoasFromProviderFloor(once)).toBeNull();
  });

  it("binds a version to the stored multiplier's meaning", () => {
    expect(META_TARGET_ROAS_UNIT_CONTRACT_VERSION).toBe(
      "meta.target-roas-units.v1",
    );
  });

  it("stamps a target_roas snapshot as a multiplier, divided once", () => {
    const payload = buildConfigSnapshotPayload({
      bidStrategy: "LOWEST_COST_WITH_MIN_ROAS",
      targetRoas: 23_300,
      manualBidAmount: null,
    });
    expect(payload.bidValueFormat).toBe("roas");
    expect(payload.bidValue).toBe(2.33);
  });
});
