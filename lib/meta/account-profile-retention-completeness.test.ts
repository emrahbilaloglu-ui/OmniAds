/**
 * WHETHER A RETAINED ACCOUNT-DAY VERDICT IS COMPLETE, OR MERELY STARTED.
 *
 * `produceRetainedAccountProfileOutputs` writes one row per action in
 * `D086_PROFILE_ACTIONS`, each as its own statement, and opens no transaction:
 * a `scale` row that lands before a later write fails is committed and kept.
 * `ensureRetainedAccountProfileOutputs` — the read-through step the budget
 * loader calls, and the only production caller that would ever write the rest —
 * used to probe with `LIMIT 1`, so the committed `scale` row reported the whole
 * identity as materialised, production was skipped on every later call, and
 * `budget-proposal-source-loader.ts` found no `cut` row for the action it was
 * proposing. The candidate was then refused with
 * `profile_not_retained` for as long as the identity did not move.
 *
 * What this file pins is the repair: a partially retained identity is PRODUCED
 * AGAIN until every action of the set exists, and a complete one is left alone.
 * The real projector and the real upsert loop run here; only the warehouse
 * reads and the canonical resolver are stubbed, because the subject is what the
 * probe concludes from the rows and not what the engine decided.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const businessId = "d0000000-0000-4000-8000-000000000501";
  const providerAccountId = "act_5000000000041";
  const asOfDate = "2026-09-04";
  return {
    businessId,
    providerAccountId,
    asOfDate,
    // Pinned so the capture clocks are the test's, not the wall clock's.
    nowIso: "2026-09-04T12:00:00.000Z",
    targetPack: {
      targetCpa: null,
      targetRoas: 2.2,
      breakEvenCpa: null,
      breakEvenRoas: 1.8,
      operatorAovAssumption: null,
      defaultRiskPosture: "balanced" as const,
      updatedAt: "2026-09-04T00:00:00.000Z",
      freshness: "fresh" as const,
    },
    calibration: {
      businessId,
      computedAt: "2026-09-04T03:00:00.000Z",
      campaignKind: "all" as const,
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
      metaAovQuality: "ready" as const,
    },
    /*
      The resolver's own verdict, stubbed: all three actions authorised, so
      every action the projector is handed is retainable and a missing row can
      only mean a write that did not happen.
    */
    profile: {
      businessId,
      asOfDate,
      spendUnit: 40,
      hardActionEligibility: {
        scale: true,
        cut: true,
        refresh: true,
        reason: null,
        reasons: { scale: null, cut: null, refresh: null },
        codes: { scale: null, cut: null, refresh: null },
        anchor: {
          source: "target_roas",
          confidence: "high",
          provenance: "operator_target",
        },
      },
    },
  };
});

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
// The store's evidence is business-level and not the subject; stubbed absent.
vi.mock("@/lib/creative-decision-engine/shopify-aov-source", () => ({
  resolveObservedShopifyAov: vi.fn(async () => null),
  observedShopifyAovIsUsable: () => false,
}));
vi.mock("@/lib/creative-decision-engine/account-decision-profile", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/creative-decision-engine/account-decision-profile")
  >();
  return {
    ...actual,
    resolveAccountDecisionProfile: vi.fn(
      async () => fixture.profile as unknown as
        Awaited<ReturnType<typeof actual.resolveAccountDecisionProfile>>,
    ),
  };
});
vi.mock("@/lib/creative-decision-engine/data-source", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/creative-decision-engine/data-source")
  >();
  /*
    The account's facts, answered directly. `materialised` is what keeps
    `accountProfileMeasuredScopeHold` from refusing before anything is probed,
    which is the state every healthy account is in once the calibration job has
    run for it.
  */
  class StubWarehouseDataSource {
    async readAccountScopeCalibrationMaterialisation() {
      return "materialised" as const;
    }
    async getBusinessTargetPack() {
      return fixture.targetPack;
    }
    async getDecisionCalibrationProfile() {
      return null;
    }
    async getAccountCalibration() {
      return fixture.calibration;
    }
    async getAccountFunnelCalibration() {
      return { campaignKind: "all" as const, byFormat: {} };
    }
    async getMetaAttributedAov() {
      return {
        aovMean: 58,
        purchaseCount: 32,
        totalRevenue: 1856,
        windowStart: "2026-06-07",
        windowEnd: fixture.asOfDate,
      };
    }
  }
  return {
    ...actual,
    WarehouseDataSource:
      StubWarehouseDataSource as unknown as typeof actual.WarehouseDataSource,
  };
});

import * as db from "@/lib/db";
import {
  ensureRetainedAccountProfileOutputs,
} from "@/lib/meta/account-profile-output-producer";
import { D086_PROFILE_ACTIONS } from "@/lib/meta/budget-readiness-retention";

interface RetainedRow {
  business_id: unknown;
  provider_account_id: unknown;
  action: string;
  engine_epoch: unknown;
  engine_version: unknown;
  input_fingerprint: unknown;
  source_fingerprint: unknown;
  as_of_date: unknown;
  /** How many times this exact row has been written, upsert included. */
  observations: number;
}

/**
 * The retained table, as rows rather than as a canned answer.
 *
 * The probe is served by FILTERING the stored rows on the seven identity
 * parameters both the old `LIMIT 1` probe and the complete-set probe pass in
 * the same positions, so this fake answers either one honestly and the failure
 * it shows is the probe's conclusion, not the fixture's.
 */
function fakeWarehouse() {
  const rows: RetainedRow[] = [];
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const failWrites = new Set<string>();
  const query = async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    if (sql.includes("FROM business_provider_accounts")) return [{ currency: "USD" }];
    if (sql.includes("INSERT INTO engine_v3_account_profile_output")) {
      const action = String(params[4]);
      if (failWrites.has(action)) {
        failWrites.delete(action);
        throw new Error("Connection terminated unexpectedly");
      }
      /*
        The table's own UNIQUE key, honoured rather than ignored: a re-run of an
        action that is already retained is `DO UPDATE SET recorded_at = now()`
        and not a second row, which is what makes re-production of a partial
        identity harmless for the actions that did land.
      */
      const existing = rows.find((row) =>
        row.business_id === params[2]
        && row.provider_account_id === params[3]
        && row.action === action
        && row.engine_epoch === params[5]
        && row.engine_version === params[6]
        && row.input_fingerprint === params[7]
        && row.source_fingerprint === params[8]
        && row.as_of_date === params[15]);
      if (existing) existing.observations += 1;
      else {
        rows.push({
          business_id: params[2],
          provider_account_id: params[3],
          action,
          engine_epoch: params[5],
          engine_version: params[6],
          input_fingerprint: params[7],
          source_fingerprint: params[8],
          as_of_date: params[15],
          observations: 1,
        });
      }
      return [{ action }];
    }
    if (sql.includes("FROM engine_v3_account_profile_output")) {
      return rows.filter((row) =>
        row.business_id === params[0]
        && row.provider_account_id === params[1]
        && row.as_of_date === params[2]
        && row.engine_epoch === params[3]
        && row.engine_version === params[4]
        && row.input_fingerprint === params[5]
        && row.source_fingerprint === params[6]);
    }
    return [];
  };
  vi.mocked(db.getDb).mockReturnValue(
    { query } as unknown as ReturnType<typeof db.getDb>,
  );
  return {
    rows,
    statements,
    failWrites,
    retainedActions: () => rows.map((row) => row.action).sort(),
    writes: () =>
      statements.filter((statement) =>
        statement.sql.includes("INSERT INTO engine_v3_account_profile_output")),
  };
}

const scope = {
  businessId: fixture.businessId,
  providerAccountId: fixture.providerAccountId,
  asOfDate: fixture.asOfDate,
  nowIso: fixture.nowIso,
};

describe("the retained verdict a later call treats as already materialised", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("completes an identity whose first run committed one action and then failed", async () => {
    const warehouse = fakeWarehouse();
    // The concrete failure: `scale` commits, the `cut` write fails, `refresh`
    // is never reached, and the loop is not transactional so `scale` stays.
    warehouse.failWrites.add("cut");

    await expect(ensureRetainedAccountProfileOutputs(scope)).rejects.toThrow(
      /Connection terminated unexpectedly/,
    );
    expect(warehouse.retainedActions()).toEqual(["scale"]);

    // The next call is the only thing that can finish it.
    const identity = await ensureRetainedAccountProfileOutputs(scope);
    expect(identity).not.toBeNull();
    expect(warehouse.retainedActions()).toEqual([...D086_PROFILE_ACTIONS].sort());
    // The action that had landed is re-observed, never duplicated.
    expect(warehouse.rows.filter((row) => row.action === "scale")).toHaveLength(1);
  });

  it("leaves a complete identity alone rather than producing it again", async () => {
    const warehouse = fakeWarehouse();

    const first = await ensureRetainedAccountProfileOutputs(scope);
    expect(warehouse.retainedActions()).toEqual([...D086_PROFILE_ACTIONS].sort());
    const writesAfterProduction = warehouse.writes().length;
    expect(writesAfterProduction).toBe(D086_PROFILE_ACTIONS.length);

    // Same day, same facts: one probe, and nothing resolved or written.
    const second = await ensureRetainedAccountProfileOutputs(scope);
    expect(second).toEqual(first);
    expect(warehouse.writes()).toHaveLength(writesAfterProduction);
  });
});
