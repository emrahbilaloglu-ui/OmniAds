/**
 * WHICH ACCOUNT'S FACTS A RETAINED VERDICT IS BUILT FROM.
 *
 * `engine_v3_account_profile_output` rows are keyed on one
 * `provider_account_id`, and their two fingerprints are the identity every
 * later reader re-derives before it will let a write proceed. The producer
 * nevertheless read the measured half at the warehouse default — which is the
 * whole BUSINESS — so a business holding several Meta ad accounts had one
 * account's samples setting another's percentiles, moving another's identity,
 * and supplying an account that had never run an ad with a benchmark.
 *
 * The end-to-end proof of that is in
 * `scripts/ephemeral-postgres-economics-bid-chain-seam-child.ts`, against a real
 * cluster and three real accounts. What this file pins is the seam that made it
 * possible: which reads carry the account and which deliberately do not. A
 * regression here is silent — the code still runs, the row is still written,
 * and it is simply about the wrong population.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/creative-decision-engine/feature-flags", () => ({
  resolveEngineV3Flags: vi.fn(async (businessId: string) => ({
    businessId,
    enabled: true,
    surfaceVisible: true,
    shadowOnly: false,
    presetOverride: null,
    source: {
      enabled: "env", surfaceVisible: "env", shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: { enabled: true, surfaceVisible: true, shadowOnly: false },
  })),
}));
vi.mock("@/lib/creative-decision-engine/shopify-aov-source", () => ({
  /*
    The store is business-level commerce truth and stays that way: its orders
    are the merchant's, not an ad account's, and it is already bound to one
    store and refused unless its currency matches THIS account's. It is stubbed
    absent here so the subject stays the two ad-account reads.
  */
  resolveObservedShopifyAov: vi.fn(async () => null),
  observedShopifyAovIsUsable: () => false,
}));

import * as db from "@/lib/db";
import {
  accountProfileRetentionIdentity,
  readAccountProfileRetentionInputs,
} from "@/lib/meta/account-profile-output-producer";
import type { CreativeDecisionDataSource } from "@/lib/creative-decision-engine/data-source";
import type { AccountCalibration } from "@/lib/creative-decision-engine/types";

const BIZ = "d0000000-0000-4000-8000-000000000501";
const ACCOUNT_A = "act_5000000000011";
const ACCOUNT_B = "act_5000000000012";
const AS_OF = "2026-09-04";

/** The only statement the producer issues itself: this account's currency. */
function withCurrency(currency: string | null) {
  vi.mocked(db.getDb).mockReturnValue({
    query: vi.fn(async () => (currency === null ? [] : [{ currency }])),
  } as unknown as ReturnType<typeof db.getDb>);
}

const calibration = (over: Partial<AccountCalibration>): AccountCalibration => ({
  businessId: BIZ,
  computedAt: "2026-09-04T03:00:00.000Z",
  campaignKind: "all",
  matureCreativeCount: 32,
  roasP75: 3.9,
  roasP60: 3.1,
  refreshRatioP10: 0.8,
  lowCtrP10: 0.9,
  accountCpaP50: 10,
  accountCpaSampleCount: 32,
  metaAttributedAovMean90d: 36,
  metaAttributedAovPurchaseCount90d: 32,
  metaAttributedRevenue90d: 1152,
  matureSpendP50: 10,
  matureSpendP75: 10,
  winnerSpendP25: 10,
  winnerSpendP50: 10,
  winnerPurchaseP50: 1,
  roasRatioP10: 1.6,
  roasRatioP25: 1.6,
  roasRatioP50: 1.6,
  roasRatioP75: 1.6,
  metaAovQuality: "ready",
  ...over,
});

/**
 * A data source that answers PER ACCOUNT and records what it was asked.
 *
 * The measured readers throw when they are asked without an account, which is
 * how this file states the rule positively: a business-wide reading is not a
 * quieter answer here, it is a missing one.
 */
function recordingDataSource(byAccount: Record<string, AccountCalibration>) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const measured = (method: string, input: { providerAccountId?: string | null }) => {
    calls.push({ method, input: input as Record<string, unknown> });
    const account = input.providerAccountId;
    if (typeof account !== "string" || account === "") {
      throw new Error(`${method} was asked without an account`);
    }
    return account;
  };
  const source = {
    async getBusinessTargetPack(input: Record<string, unknown>) {
      calls.push({ method: "getBusinessTargetPack", input });
      return {
        targetCpa: null,
        targetRoas: 2.2,
        breakEvenCpa: null,
        breakEvenRoas: 1.8,
        operatorAovAssumption: null,
        defaultRiskPosture: "balanced" as const,
        updatedAt: "2026-09-04T00:00:00.000Z",
        freshness: "fresh" as const,
      };
    },
    async getDecisionCalibrationProfile(input: Record<string, unknown>) {
      calls.push({ method: "getDecisionCalibrationProfile", input });
      return null;
    },
    async getAccountCalibration(input: { providerAccountId?: string | null }) {
      const account = measured("getAccountCalibration", input);
      return byAccount[account] ?? calibration({ matureCreativeCount: 0 });
    },
    async getAccountFunnelCalibration(input: { providerAccountId?: string | null }) {
      measured("getAccountFunnelCalibration", input);
      return { campaignKind: "all" as const, byFormat: {} };
    },
  };
  return {
    calls,
    dataSource: source as unknown as CreativeDecisionDataSource,
  };
}

describe("the facts a retained account verdict is read from", () => {
  it("asks for the MEASURED calibration by account, and the CONFIGURED policy by business", async () => {
    withCurrency("USD");
    const { calls, dataSource } = recordingDataSource({
      [ACCOUNT_A]: calibration({ metaAttributedAovMean90d: 36 }),
    });

    const inputs = await readAccountProfileRetentionInputs(
      { businessId: BIZ, providerAccountId: ACCOUNT_A, asOfDate: AS_OF },
      dataSource,
    );
    expect(inputs).not.toBeNull();

    const measured = calls.filter((call) =>
      call.method === "getAccountCalibration"
      || call.method === "getAccountFunnelCalibration");
    expect(measured).toHaveLength(2);
    for (const call of measured) {
      expect(call.input.providerAccountId).toBe(ACCOUNT_A);
    }

    /*
      The other half of the split, asserted rather than assumed. Target ROAS,
      break-even ROAS and the calibration profile are the OPERATOR's settings
      for the business; scoping them to an account would fragment one commercial
      policy into several and is not what this change does.
    */
    const configured = calls.filter((call) =>
      call.method === "getBusinessTargetPack"
      || call.method === "getDecisionCalibrationProfile");
    expect(configured).toHaveLength(2);
    for (const call of configured) {
      expect(call.input).not.toHaveProperty("providerAccountId");
    }
  });

  it("carries the account's own calibration, not a sibling's", async () => {
    withCurrency("USD");
    const { dataSource } = recordingDataSource({
      [ACCOUNT_A]: calibration({ metaAttributedAovMean90d: 36, roasP75: 3.9 }),
      [ACCOUNT_B]: calibration({ metaAttributedAovMean90d: 200, roasP75: 12 }),
    });

    const a = await readAccountProfileRetentionInputs(
      { businessId: BIZ, providerAccountId: ACCOUNT_A, asOfDate: AS_OF }, dataSource);
    const b = await readAccountProfileRetentionInputs(
      { businessId: BIZ, providerAccountId: ACCOUNT_B, asOfDate: AS_OF }, dataSource);

    expect(a!.accountCalibration.metaAttributedAovMean90d).toBe(36);
    expect(b!.accountCalibration.metaAttributedAovMean90d).toBe(200);
    // Two accounts of one business are two identities, on both halves.
    const identityA = accountProfileRetentionIdentity(a!);
    const identityB = accountProfileRetentionIdentity(b!);
    expect(identityB.sourceFingerprint).not.toBe(identityA.sourceFingerprint);
    expect(identityB.inputFingerprint).not.toBe(identityA.inputFingerprint);
  });

  it("leaves one account's identity alone when another account's samples move", async () => {
    withCurrency("USD");
    const before = recordingDataSource({
      [ACCOUNT_A]: calibration({ metaAttributedAovMean90d: 36 }),
      [ACCOUNT_B]: calibration({ metaAttributedAovMean90d: 12 }),
    });
    const after = recordingDataSource({
      [ACCOUNT_A]: calibration({ metaAttributedAovMean90d: 36 }),
      // B alone moves, by an order of magnitude.
      [ACCOUNT_B]: calibration({ metaAttributedAovMean90d: 200, matureCreativeCount: 46 }),
    });

    const identity = async (source: CreativeDecisionDataSource) =>
      accountProfileRetentionIdentity(
        (await readAccountProfileRetentionInputs(
          { businessId: BIZ, providerAccountId: ACCOUNT_A, asOfDate: AS_OF },
          source,
        ))!,
      );

    expect(await identity(after.dataSource)).toEqual(await identity(before.dataSource));
  });

  it("reads UNKNOWN as unknown when the account's own currency cannot be read", async () => {
    /*
      Not a borrow either: with no assignment row for this account there is no
      currency to check a benchmark against, the read fails closed, and the
      caller retains nothing rather than falling back to the business setting.
    */
    withCurrency(null);
    const { dataSource } = recordingDataSource({
      [ACCOUNT_A]: calibration({ metaAttributedAovMean90d: 36 }),
    });
    const inputs = await readAccountProfileRetentionInputs(
      { businessId: BIZ, providerAccountId: ACCOUNT_A, asOfDate: AS_OF }, dataSource);
    expect(inputs?.accountCurrency ?? null).toBeNull();
  });
});
