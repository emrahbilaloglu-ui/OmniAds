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
  produceRetainedAccountProfileOutputs,
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
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM business_provider_accounts")) {
      return currency === null ? [] : [{ currency }];
    }
    if (sql.includes("INSERT INTO engine_v3_account_profile_output")) {
      return [{ action: params[4] }];
    }
    return [];
  });
  vi.mocked(db.getDb).mockReturnValue({
    query,
  } as unknown as ReturnType<typeof db.getDb>);
  return query;
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
    async getMetaAttributedAov(input: { providerAccountId?: string | null }) {
      const account = measured("getMetaAttributedAov", input);
      const legacy = byAccount[account] ?? calibration({ matureCreativeCount: 0 });
      const aovMean = legacy.metaAttributedAovMean90d === null
        ? null
        : legacy.metaAttributedAovMean90d + 22;
      const purchaseCount = legacy.metaAttributedAovPurchaseCount90d;
      return {
        aovMean,
        purchaseCount,
        totalRevenue: aovMean === null ? 0 : aovMean * purchaseCount,
        windowStart: "2026-06-07",
        windowEnd: AS_OF,
      };
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

    const strictAov = calls.filter((call) => call.method === "getMetaAttributedAov");
    expect(strictAov).toHaveLength(1);
    expect(strictAov[0]!.input).toMatchObject({
      providerAccountId: ACCOUNT_A,
      asOf: AS_OF,
      windowDays: 90,
    });

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

  it("pins the one strict AOV observation into resolver production without a warehouse reread", async () => {
    const warehouseQuery = withCurrency("USD");
    const { calls, dataSource } = recordingDataSource({
      [ACCOUNT_A]: calibration({ metaAttributedAovMean90d: 36 }),
    });
    const inputs = await readAccountProfileRetentionInputs(
      { businessId: BIZ, providerAccountId: ACCOUNT_A, asOfDate: AS_OF },
      dataSource,
    );
    expect(inputs?.strictMetaAov).toMatchObject({
      status: "resolved",
      value: { aovMean: 58, purchaseCount: 32 },
    });

    const produced = await produceRetainedAccountProfileOutputs({
      businessId: BIZ,
      providerAccountId: ACCOUNT_A,
      asOfDate: AS_OF,
      nowIso: "2026-09-04T12:00:00.000Z",
    }, inputs);

    expect(produced.produced).toBe(true);
    const writes = warehouseQuery.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO engine_v3_account_profile_output"));
    expect(writes).toHaveLength(3);
    expect(writes.map((call) => {
      const params = call[1] as unknown[];
      return { action: params[4], eligible: params[9], spendUnit: params[13] };
    })).toEqual([
      { action: "scale", eligible: true, spendUnit: 58 / 2.2 },
      { action: "cut", eligible: true, spendUnit: 58 / 2.2 },
      { action: "refresh", eligible: true, spendUnit: 58 / 2.2 },
    ]);

    expect(calls.filter((call) => call.method === "getMetaAttributedAov")).toHaveLength(1);
    expect(
      warehouseQuery.mock.calls.some((call) =>
        String(call[0]).includes("FROM meta_ad_daily")),
    ).toBe(false);

    const changedInputs = {
      ...inputs!,
      strictMetaAov: {
        status: "resolved" as const,
        value: {
          aovMean: 80,
          purchaseCount: 19,
          totalRevenue: 1520,
          windowStart: "2026-06-07",
          windowEnd: AS_OF,
        },
      },
    };
    expect(
      accountProfileRetentionIdentity(changedInputs).sourceFingerprint,
    ).not.toBe(accountProfileRetentionIdentity(inputs!).sourceFingerprint);
    await produceRetainedAccountProfileOutputs({
      businessId: BIZ,
      providerAccountId: ACCOUNT_A,
      asOfDate: AS_OF,
      nowIso: "2026-09-04T12:00:00.000Z",
    }, changedInputs);
    const changedWrites = warehouseQuery.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO engine_v3_account_profile_output"))
      .slice(3);
    expect(changedWrites).toHaveLength(3);
    expect(changedWrites.every((call) => {
      const params = call[1] as unknown[];
      return params[9] === false
        && params[10] === "commercial_anchor_sample_insufficient"
        && params[13] === null;
    })).toBe(true);
  });

  it("captures a strict AOV read failure and reproduces the resolver's fail-closed hold", async () => {
    const warehouseQuery = withCurrency("USD");
    const base = recordingDataSource({
      [ACCOUNT_A]: calibration({ metaAttributedAovMean90d: 999 }),
    });
    base.dataSource.getMetaAttributedAov = vi.fn(async () => {
      throw new Error("warehouse timeout");
    });
    const inputs = await readAccountProfileRetentionInputs(
      { businessId: BIZ, providerAccountId: ACCOUNT_A, asOfDate: AS_OF },
      base.dataSource,
    );
    expect(inputs?.strictMetaAov).toEqual({ status: "failed" });

    await produceRetainedAccountProfileOutputs({
      businessId: BIZ,
      providerAccountId: ACCOUNT_A,
      asOfDate: AS_OF,
      nowIso: "2026-09-04T12:00:00.000Z",
    }, inputs);

    const writes = warehouseQuery.mock.calls.filter((call) =>
      String(call[0]).includes("INSERT INTO engine_v3_account_profile_output"));
    expect(writes).toHaveLength(3);
    expect(writes.every((call) => {
      const params = call[1] as unknown[];
      return params[9] === false
        && params[10] === "commercial_anchor_missing"
        && params[13] === null;
    })).toBe(true);
    expect(base.dataSource.getMetaAttributedAov).toHaveBeenCalledTimes(1);
    expect(warehouseQuery.mock.calls.some((call) =>
      String(call[0]).includes("FROM meta_ad_daily"))).toBe(false);
  });

  it("keeps sole-account calibration pooled but reads strict AOV from the physical account", async () => {
    withCurrency("USD");
    const calls: Array<{ method: string; providerAccountId?: string | null }> = [];
    const source = {
      async readAccountScopeCalibrationMaterialisation() {
        return "per_account_scopes_unwritten" as const;
      },
      async readBusinessAccountPopulationBreadth() {
        return "sole_account" as const;
      },
      async getBusinessTargetPack() {
        return recordingDataSource({}).dataSource.getBusinessTargetPack({ businessId: BIZ });
      },
      async getDecisionCalibrationProfile() { return null; },
      async getAccountCalibration(input: { providerAccountId?: string | null }) {
        calls.push({ method: "calibration", ...input });
        return calibration({ metaAttributedAovMean90d: 36 });
      },
      async getAccountFunnelCalibration(input: { providerAccountId?: string | null }) {
        calls.push({ method: "funnel", ...input });
        return { campaignKind: "all" as const, byFormat: {} };
      },
      async getMetaAttributedAov(input: { providerAccountId?: string | null }) {
        calls.push({ method: "strict_aov", ...input });
        return {
          aovMean: 58,
          purchaseCount: 32,
          totalRevenue: 1856,
          windowStart: "2026-06-07",
          windowEnd: AS_OF,
        };
      },
    } as unknown as CreativeDecisionDataSource;

    const result = await readAccountProfileRetentionInputs(
      { businessId: BIZ, providerAccountId: ACCOUNT_A, asOfDate: AS_OF },
      source,
    );
    expect(result).not.toBeNull();
    expect(calls).toEqual([
      {
        method: "calibration", businessId: BIZ, asOf: AS_OF,
        providerAccountId: null,
      },
      {
        method: "funnel", businessId: BIZ, asOf: AS_OF,
        providerAccountId: null,
      },
      {
        method: "strict_aov", businessId: BIZ, asOf: AS_OF,
        providerAccountId: ACCOUNT_A, windowDays: 90,
      },
    ]);
  });

  it("skips strict AOV for complete no-ROAS legacy facts and reads it for the legacy fallback", async () => {
    withCurrency("USD");
    const legacy = recordingDataSource({ [ACCOUNT_A]: calibration({}) });
    legacy.dataSource.getBusinessTargetPack = vi.fn(async () => ({
      targetCpa: 31,
      targetRoas: null,
      breakEvenCpa: null,
      breakEvenRoas: null,
      operatorAovAssumption: null,
      defaultRiskPosture: "balanced" as const,
      updatedAt: "2026-09-04T00:00:00.000Z",
      freshness: "fresh" as const,
    }));
    const legacyInputs = await readAccountProfileRetentionInputs(
      { businessId: BIZ, providerAccountId: ACCOUNT_A, asOfDate: AS_OF },
      legacy.dataSource,
    );
    expect(legacyInputs?.strictMetaAov).toEqual({ status: "not_read" });
    expect(legacy.calls.filter((call) => call.method === "getMetaAttributedAov"))
      .toHaveLength(0);

    const fallback = recordingDataSource({
      [ACCOUNT_A]: calibration({
        metaAttributedAovMean90d: null,
        metaAttributedAovPurchaseCount90d: 0,
        metaAttributedRevenue90d: 0,
        metaAovQuality: "unavailable",
      }),
    });
    fallback.dataSource.getBusinessTargetPack = legacy.dataSource.getBusinessTargetPack;
    fallback.dataSource.getMetaAttributedAov = vi.fn(async () => ({
      aovMean: 73,
      purchaseCount: 19,
      totalRevenue: 1387,
      windowStart: "2026-06-07",
      windowEnd: AS_OF,
    }));
    const fallbackInputs = await readAccountProfileRetentionInputs(
      { businessId: BIZ, providerAccountId: ACCOUNT_A, asOfDate: AS_OF },
      fallback.dataSource,
    );
    expect(fallbackInputs?.strictMetaAov).toMatchObject({
      status: "resolved",
      value: { aovMean: 73, purchaseCount: 19 },
    });
    expect(fallback.dataSource.getMetaAttributedAov).toHaveBeenCalledTimes(1);
  });
});
