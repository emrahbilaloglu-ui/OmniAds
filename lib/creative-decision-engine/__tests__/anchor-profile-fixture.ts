/**
 * Shared harness for resolving a REAL `AccountDecisionProfile` in tests.
 *
 * Tests that assert on the commercial-anchor explanation must exercise the
 * production resolver rather than a helper that mirrors its predicates: the
 * rejected design was a second resolver that agreed with a mirror and
 * disagreed with the engine. Both the server-projection tests and the
 * Decision Center adapter tests resolve through this.
 */
import { resolveAccountDecisionProfile } from "../account-decision-profile";
import type {
  BusinessTargetPack,
  CampaignCalibrationLookup,
  CreativeDecisionDataSource,
  DecisionCalibrationProfileConfig,
} from "../data-source";
import type { EngineV3Flags } from "../feature-flags";
import type { OperatorResponseResult } from "../operator-response-detection";
import type {
  AccountCalibration,
  AccountDecisionProfile,
  CreativeInput,
  DataHealth,
  FunnelDiagnosis,
} from "../types";
import {
  makeAccountCalibration,
  makeAccountFunnelCalibration,
  makeDataHealth,
} from "./helpers";

export class AnchorProfileDataSource implements CreativeDecisionDataSource {
  constructor(
    private readonly targetPack: BusinessTargetPack | null,
    private readonly calibration: AccountCalibration = makeAccountCalibration(),
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
    };
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
    };
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
      windowStart: "2026-02-05",
      windowEnd: "2026-05-04",
    };
  }
}

export function makeAnchorFlags(
  overrides: Partial<EngineV3Flags> = {},
): EngineV3Flags {
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

export function makeAnchorTargetPack(
  overrides: Partial<BusinessTargetPack> = {},
): BusinessTargetPack {
  return {
    targetCpa: null,
    targetRoas: 3,
    breakEvenCpa: null,
    breakEvenRoas: 2,
    operatorAovAssumption: null,
    defaultRiskPosture: "balanced",
    updatedAt: "2026-05-04T02:00:00.000Z",
    freshness: "fresh",
    ...overrides,
  };
}

/** Resolves the production profile for one anchor regime. */
export async function resolveAnchorProfileFixture(input: {
  targetPack: BusinessTargetPack | null;
  calibration?: AccountCalibration;
  shadowOnly?: boolean;
}): Promise<AccountDecisionProfile> {
  return resolveAccountDecisionProfile({
    businessId: "biz-1",
    asOf: "2026-05-04",
    dataSource: new AnchorProfileDataSource(
      input.targetPack,
      input.calibration ?? makeAccountCalibration(),
    ),
    flags: makeAnchorFlags({ shadowOnly: input.shadowOnly ?? false }),
  });
}
