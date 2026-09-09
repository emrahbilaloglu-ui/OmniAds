/**
 * The store's own average order value is NOT a commercial anchor for a META
 * decision, and the served panel must say so.
 *
 * THE CANONICAL RULE. The hard-decision spend unit for a Meta action is the
 * META PLATFORM AOV — Meta's own attributed purchase revenue over its own
 * attributed purchase count — divided by the Target ROAS. The merchant's
 * settled Shopify orders are a different book: dividing Meta spend by them
 * sizes Meta money from revenue Meta never attributed, and it made the served
 * and native surfaces answer "what is a purchase worth" with two different
 * numbers for the same account.
 *
 * WHAT THIS FILE USED TO PIN, AND WHY IT IS REVERSED. It asserted the opposite
 * premise — that a proven store AOV resolves the anchor as
 * `eligible_observed_shopify_aov` with `spendUnitSource: "observed_shopify_aov"`
 * at HIGH confidence and a spend unit of 26.36 (58.00 / 2.20). That rung has
 * been removed from `resolveSpendUnit`'s ladder: `observed_shopify_aov` remains
 * in `SpendUnitSource` so profiles persisted while it was a rung still parse,
 * but it is never minted again.
 *
 * WHAT IT PINS NOW, both ways, so nothing here is a one-directional relaxation:
 *
 *   - The store's number, however well proven, sizes and authorises NOTHING.
 *     An account with a Target ROAS, a proven 58.00 store AOV and no Meta
 *     purchase sample HOLDS, and the hold names the Meta purchase sample rather
 *     than telling the operator to type a CPA or an AOV.
 *   - The hold is not permanent and the panel is not dead: the same account
 *     with Meta purchases attributed resolves through `meta_derived_aov` and
 *     demands nothing.
 *   - Shopify changes no decision input. The Meta-anchored resolution is
 *     byte-identical with the store evidence present and absent.
 *   - The provenance guard still bites on the rung that now exists: an
 *     untrusted target pack demotes a ready Meta-derived unit and the threshold
 *     gate refuses.
 */
import { describe, expect, it } from "vitest";
import { resolveAccountDecisionProfile } from "@/lib/creative-decision-engine/account-decision-profile";
import type {
  BusinessTargetPack,
  CampaignCalibrationLookup,
  CreativeDecisionDataSource,
  DecisionCalibrationProfileConfig,
} from "@/lib/creative-decision-engine/data-source";
import type {
  AccountCalibration,
  AccountFunnelCalibration,
  CalibrationCampaignKind,
  CreativeInput,
  DataHealth,
  FunnelDiagnosis,
} from "@/lib/creative-decision-engine/types";
import type { OperatorResponseResult } from "@/lib/creative-decision-engine/operator-response-detection";
import type { ObservedShopifyAovEvidence } from "@/lib/creative-decision-engine/shopify-aov-source";
import type { EngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import {
  makeAccountCalibration,
  makeAccountFunnelCalibration,
  makeDataHealth,
} from "@/lib/creative-decision-engine/__tests__/helpers";

/**
 * The fixture's commercial truth: a Target ROAS and a break-even ROAS, and
 * deliberately NO target CPA and NO operator AOV assumption.
 */
const TARGET_PACK: BusinessTargetPack = {
  targetCpa: null,
  targetRoas: 2.2,
  breakEvenCpa: null,
  breakEvenRoas: 1.8,
  operatorAovAssumption: null,
  defaultRiskPosture: "balanced",
  updatedAt: "2026-08-07T00:00:00.000Z",
  freshness: "fresh",
};

/** 58.00 USD over 60 settled orders in a proven, closed 28-day window. */
function provenStoreAov(
  overrides: Partial<ObservedShopifyAovEvidence> = {},
): ObservedShopifyAovEvidence {
  return {
    contract: "meta.observed-shopify-aov.v1",
    status: "observed",
    source: "shopify_revenue_ledger",
    providerAccountId: "shop_1",
    revenueBasis: "net_ledger",
    window: { from: "2026-08-08", to: "2026-09-04" },
    zoneName: "UTC",
    orderCount: 60,
    currency: "USD",
    currencyExponent: 2,
    revenueMinor: 348_000,
    aovMinor: 5_800,
    observedAt: "2026-09-04T00:00:00.000Z",
    knowledgeAsOf: "2026-09-04T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * No Meta-attributed sample, and no account-history rung either.
 *
 * This is the controlled half of every pair below: with nothing on the Meta
 * side the ladder can only answer from a configured rung, so whatever the store
 * evidence does — or, now, does not do — is visible without a second cause.
 */
function noMetaPurchases(): AccountCalibration {
  return makeAccountCalibration({
    metaAttributedAovMean90d: null,
    metaAttributedAovPurchaseCount90d: 0,
    metaAttributedRevenue90d: 0,
    metaAovQuality: "unavailable",
    accountCpaP50: null,
    accountCpaSampleCount: 0,
  });
}

/**
 * The canonical basis: 71.00 of Meta-attributed revenue per Meta-attributed
 * purchase, over a sample the ladder calls `ready` (>= 20 purchases).
 */
function metaPlatformAov(): AccountCalibration {
  return makeAccountCalibration({
    metaAttributedAovMean90d: 71,
    metaAttributedAovPurchaseCount90d: 400,
    metaAttributedRevenue90d: 28_400,
    metaAovQuality: "ready",
    accountCpaP50: null,
    accountCpaSampleCount: 0,
  });
}

class ProfileDataSource implements CreativeDecisionDataSource {
  constructor(
    private readonly targetPack: BusinessTargetPack | null,
    private readonly calibration: AccountCalibration = noMetaPurchases(),
  ) {}

  async getCreativeInput(): Promise<CreativeInput | null> {
    return null;
  }
  async getAccountCalibration() {
    return this.calibration;
  }
  async getAccountCalibrationAllKinds() {
    return {
      all: { ...this.calibration, campaignKind: "all" as const },
      main: null,
      test: null,
      mixed: null,
    } as Record<CalibrationCampaignKind, AccountCalibration | null>;
  }
  async getCampaignCalibration(): Promise<CampaignCalibrationLookup> {
    return { calibration: null, matureCreativeCount: null };
  }
  async getAccountFunnelCalibration() {
    return makeAccountFunnelCalibration();
  }
  async getAccountFunnelCalibrationAllKinds() {
    return {
      all: makeAccountFunnelCalibration({ campaignKind: "all" }),
      main: null,
      test: null,
      mixed: null,
    } as Record<CalibrationCampaignKind, AccountFunnelCalibration | null>;
  }
  async listCreativeInputs(): Promise<CreativeInput[]> {
    return [];
  }
  async getDataHealth(): Promise<DataHealth> {
    return makeDataHealth();
  }
  async getLatestFunnelDiagnosis(): Promise<FunnelDiagnosis | null> {
    return null;
  }
  async getLatestOperatorResponse(): Promise<OperatorResponseResult | null> {
    return null;
  }
  async getBusinessTargetPack(): Promise<BusinessTargetPack | null> {
    return this.targetPack;
  }
  async getDecisionCalibrationProfile(): Promise<DecisionCalibrationProfileConfig | null> {
    return null;
  }
  async getMetaAttributedAov() {
    return {
      aovMean: this.calibration.metaAttributedAovMean90d,
      purchaseCount: this.calibration.metaAttributedAovPurchaseCount90d,
      totalRevenue: this.calibration.metaAttributedRevenue90d,
      windowStart: "2026-06-06",
      windowEnd: "2026-09-04",
    };
  }
}

function makeFlags(overrides: Partial<EngineV3Flags> = {}): EngineV3Flags {
  return {
    businessId: "biz-1",
    enabled: true,
    surfaceVisible: false,
    shadowOnly: false,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: { enabled: true, surfaceVisible: false, shadowOnly: true },
    ...overrides,
  };
}

async function resolve(
  observedShopifyAov: ObservedShopifyAovEvidence | null,
  targetPack: BusinessTargetPack | null = TARGET_PACK,
  calibration: AccountCalibration = noMetaPurchases(),
) {
  const profile = await resolveAccountDecisionProfile({
    businessId: "00000000-0000-4000-8000-000000000901",
    asOf: "2026-09-04",
    dataSource: new ProfileDataSource(targetPack, calibration),
    flags: makeFlags(),
    observedShopifyAov,
  });
  const anchor = profile.hardActionEligibility.anchor;
  // The profile always builds one; a missing anchor is a contract breach, not a
  // case these tests should quietly skip.
  if (!anchor) throw new Error("hardActionEligibility.anchor was not produced");
  return anchor;
}

describe("commercial anchor is the Meta platform AOV, never the store's", () => {
  it("refuses to size a Meta action from a proven store average order value", async () => {
    const anchor = await resolve(provenStoreAov());

    // The store number is real, proven and in the account's own currency, and
    // it still authorises nothing.
    expect(anchor.status).toBe("blocked_missing_owner_anchor");
    expect(anchor.spendUnitSource).toBe("insufficient");
    expect(anchor.thresholdEligible).toBe(false);
    expect(anchor.spendUnit).toBeNull();
    // 58.00 / 2.20 — the number this file used to assert. It must not appear.
    expect(anchor.spendUnit).not.toBeCloseTo(26.3636, 4);
    expect(anchor.actions.cut).toMatchObject({
      eligible: false,
      blockerCode: "commercial_anchor_missing",
    });
    expect(anchor.actions.refresh).toMatchObject({
      eligible: false,
      blockerCode: "commercial_anchor_missing",
    });
  });

  it("names the Meta purchase sample as the absence, not a CPA or an AOV", async () => {
    const anchor = await resolve(provenStoreAov());

    /*
      A Target ROAS is configured, and with one the canonical unit is Meta's own
      attributed AOV divided by it. So the operator is told what is actually
      missing — Meta's attributed purchases — instead of being sent to type one
      of the two numbers this product does not require.
    */
    expect(anchor.missingInputs).toEqual(["meta_attributed_purchase_sample"]);
    expect(anchor.lineage.targetRoas).toBe(2.2);
    expect(anchor.lineage.metaAttributedAovPurchaseCount90d).toBe(0);
  });

  it("still refuses when the store supplies nothing", async () => {
    const anchor = await resolve(null);

    expect(anchor.status).toBe("blocked_missing_owner_anchor");
    expect(anchor.spendUnitSource).toBe("insufficient");
    expect(anchor.thresholdEligible).toBe(false);
    expect(anchor.actions.cut).toMatchObject({
      eligible: false,
      blockerCode: "commercial_anchor_missing",
    });
  });

  it("resolves the unit from the Meta platform AOV once purchases exist", async () => {
    /*
      THE GUARD AGAINST OVER-CORRECTING. Retiring the store rung must not turn
      the panel into a permanent hold: the same target pack, with Meta purchases
      attributed, mints a unit through the canonical rung. 71.00 / 2.20.
    */
    const anchor = await resolve(null, TARGET_PACK, metaPlatformAov());

    expect(anchor.status).toBe("eligible_meta_derived_aov");
    expect(anchor.spendUnitSource).toBe("meta_derived_aov");
    expect(anchor.thresholdEligible).toBe(true);
    expect(anchor.spendUnit).toBeCloseTo(71 / 2.2, 4);
    expect(anchor.missingInputs).toEqual([]);
    expect(anchor.actions.cut).toMatchObject({
      eligible: true,
      blockerCode: null,
    });
  });

  it("is not moved by the store evidence in either direction", async () => {
    /*
      Shopify is diagnostic and contextual only: it must change no decision
      input. Same account, same targets, same Meta sample — once with a proven
      58.00 store AOV beside it and once with none — and the resolved anchor is
      identical, so no hash built from it can move either.
    */
    const withStore = await resolve(provenStoreAov(), TARGET_PACK, metaPlatformAov());
    const withoutStore = await resolve(null, TARGET_PACK, metaPlatformAov());

    expect(withStore).toEqual(withoutStore);
    // And specifically NOT the store's own 58.00 / 2.20.
    expect(withStore.spendUnit).toBeCloseTo(71 / 2.2, 4);
  });

  it("still reaches the sampled rung when an operator already typed an AOV assumption", async () => {
    // RE-PINNED. This asserted `operator_aov` / `eligible_operator_aov`: the
    // operator's assumption used to outrank the platform AOV. With a Target
    // ROAS configured the basis is Meta's own attributed AOV over that ratio,
    // so the typed 40.00 is carried as lineage and decides nothing.
    const anchor = await resolve(
      provenStoreAov(),
      { ...TARGET_PACK, operatorAovAssumption: 40 },
      metaPlatformAov(),
    );

    expect(anchor.spendUnitSource).toBe("meta_derived_aov");
    expect(anchor.status).toBe("eligible_meta_derived_aov");
    expect(anchor.spendUnit).toBeCloseTo(71 / 2.2, 4);
    expect(anchor.spendUnit).not.toBeCloseTo(40 / 2.2, 4);
    expect(anchor.lineage.operatorAovAssumption).toBe(40);
  });

  it("withholds the unit when the store evidence is not an observation", async () => {
    const anchor = await resolve(
      provenStoreAov({ status: "sample_thin", orderCount: 4 }),
    );

    expect(anchor.spendUnitSource).toBe("insufficient");
    expect(anchor.status).toBe("blocked_missing_owner_anchor");
  });

  it("demotes the Meta rung when the target pack it divides by has no trusted provenance", async () => {
    /*
      The provenance guard, re-pinned onto the rung that now exists. The Meta
      sample is `ready` and the unit is real, but the pack it is divided by
      carries no verifiable timestamp, so the confidence is demoted and the
      threshold gate refuses — and the operator is told to re-save the target
      rather than to invent economics.
    */
    const anchor = await resolve(
      provenStoreAov(),
      { ...TARGET_PACK, updatedAt: null },
      metaPlatformAov(),
    );

    expect(anchor.spendUnitSource).toBe("meta_derived_aov");
    expect(anchor.spendUnitConfidence).toBe("low");
    expect(anchor.thresholdEligible).toBe(false);
    expect(anchor.status).toBe("blocked_provenance_unverified");
    expect(anchor.missingInputs).toEqual(["commercial_target_provenance"]);
  });
});
