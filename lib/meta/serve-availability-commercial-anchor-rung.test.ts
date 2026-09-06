/**
 * The store's own average order value is a commercial anchor, and the served
 * panel must say so.
 *
 * ROAS is the only commercial target this product requires; a target CPA and an
 * operator AOV assumption are optional and their absence is never a blocker,
 * because the average order value is read from the merchant's Shopify orders
 * and the CPA benchmark is derived from it. The `observed_shopify_aov` rung in
 * `resolveSpendUnit` already implements exactly that.
 *
 * What the availability matrix measured was the panel denying it: the served
 * `system.commercialAnchor` reported
 * `status: "blocked_missing_owner_anchor"`, `spendUnitSource: "insufficient"`
 * and `missingInputs: ["target_cpa", "operator_aov_assumption"]` while the
 * account's own retained `engine_v3_account_profile_output` rows carried a
 * resolved spend unit of 26.36 (58.00 ÷ 2.20) with cut and refresh eligible.
 *
 * These cases pin the resolution the panel is built from, both ways: the store
 * evidence resolves the anchor and reports its OWN provenance, and its absence
 * still refuses. Nothing here lowers a threshold — the eligibility predicates
 * are untouched and the second case proves the refusal still happens.
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

class ProfileDataSource implements CreativeDecisionDataSource {
  constructor(
    private readonly targetPack: BusinessTargetPack | null,
    private readonly calibration: AccountCalibration = makeAccountCalibration({
      // No Meta-attributed sample at all, so the ONLY rung that can answer
      // below `operator_aov` is the store's. Without it the ladder must fall
      // through to `insufficient`, which is what makes the pair a controlled
      // comparison rather than a coincidence.
      metaAttributedAovMean90d: null,
      metaAttributedAovPurchaseCount90d: 0,
      metaAttributedRevenue90d: 0,
      metaAovQuality: "unavailable",
      accountCpaP50: null,
      accountCpaSampleCount: 0,
    }),
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
) {
  const profile = await resolveAccountDecisionProfile({
    businessId: "00000000-0000-4000-8000-000000000901",
    asOf: "2026-09-04",
    dataSource: new ProfileDataSource(targetPack),
    flags: makeFlags(),
    observedShopifyAov,
  });
  const anchor = profile.hardActionEligibility.anchor;
  // The profile always builds one; a missing anchor is a contract breach, not a
  // case these tests should quietly skip.
  if (!anchor) throw new Error("hardActionEligibility.anchor was not produced");
  return anchor;
}

describe("commercial anchor from observed store orders", () => {
  it("resolves the anchor from the store's own average order value and names that source", async () => {
    const anchor = await resolve(provenStoreAov());

    expect(anchor.status).toBe("eligible_observed_shopify_aov");
    expect(anchor.spendUnitSource).toBe("observed_shopify_aov");
    expect(anchor.spendUnitConfidence).toBe("high");
    expect(anchor.thresholdEligible).toBe(true);
    // 58.00 / 2.20 — the derived CPA benchmark, not a typed one.
    expect(anchor.spendUnit).toBeCloseTo(26.3636, 4);
    // The lineage rows the panel prints are unchanged by this fix: the store's
    // own number is not among them yet, and the panel names its rung through
    // `spendUnitSource` instead. Adding a lineage row needs the adapter and the
    // payload-coverage census to move with it; that is handed off, not done
    // here.
    expect(anchor.lineage.targetRoas).toBe(2.2);
    // The two OPTIONAL inputs must not be demanded once a unit exists.
    expect(anchor.missingInputs).toEqual([]);
    expect(anchor.actions.cut).toMatchObject({
      eligible: true,
      blockerCode: null,
    });
    expect(anchor.actions.refresh).toMatchObject({
      eligible: true,
      blockerCode: null,
    });
    // Scale still answers to its own calibration gate, untouched here.
    expect(anchor.actions.scale.blockerCode).not.toBe(
      "commercial_anchor_missing",
    );
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

  it("never reaches the store when an operator already typed an AOV assumption", async () => {
    const anchor = await resolve(provenStoreAov(), {
      ...TARGET_PACK,
      operatorAovAssumption: 40,
    });

    expect(anchor.spendUnitSource).toBe("operator_aov");
    expect(anchor.status).toBe("eligible_operator_aov");
  });

  it("withholds the unit when the store evidence is not an observation", async () => {
    const anchor = await resolve(
      provenStoreAov({ status: "sample_thin", orderCount: 4 }),
    );

    expect(anchor.spendUnitSource).toBe("insufficient");
    expect(anchor.status).toBe("blocked_missing_owner_anchor");
  });

  it("demotes the store rung when the target pack it divides by has no trusted provenance", async () => {
    const anchor = await resolve(provenStoreAov(), {
      ...TARGET_PACK,
      updatedAt: null,
    });

    // The rung is still chosen — the store's number is real — but the pack it
    // is divided by cannot be trusted, so the confidence is demoted and the
    // threshold gate refuses. This is the guard that `observed_shopify_aov`
    // used to sit outside of.
    expect(anchor.spendUnitSource).toBe("observed_shopify_aov");
    expect(anchor.spendUnitConfidence).toBe("low");
    expect(anchor.thresholdEligible).toBe(false);
    expect(anchor.status).toBe("blocked_provenance_unverified");
  });
});
