/**
 * THE CONFIG-HISTORY READ IS ACCOUNT-SCOPED AND ABSOLUTE.
 *
 * Round 11, item 1. `readConfigHistory` is module-private, so it is driven here
 * through the real `runMetaSignalsBackfillForBusiness` with the database
 * mocked — the SQL text and the bound parameters ARE the contract, and both
 * defects are visible only in them:
 *
 *   - it filtered on `business_id` alone while both config-history tables carry
 *     `provider_account_id`, so a multi-account business pooled every account's
 *     edit history and one account's change could lift another account's
 *     recent-edit veto;
 *   - it bounded a `timestamptz` column with `($3::date ± INTERVAL …)`, which
 *     PostgreSQL resolves using the DB SESSION's `TimeZone` rather than the
 *     advertiser's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
  assertDbSchemaReady: vi.fn(async () => ({ ready: true })),
}));
/*
  The warehouse readers are a separate module; one ad set on the as-of day is
  the smallest input that makes the config-history read happen at all, and it
  carries the physical account whose calendar is under test.
*/
vi.mock("@/lib/meta/warehouse", () => ({
  getMetaCampaignDailyRange: vi.fn(async () => []),
  getMetaAdSetDailyRange: vi.fn(async () => [
    {
      adsetId: "adset_1",
      campaignId: "cmp_1",
      providerAccountId: "act_1",
      date: "2026-09-05",
      spend: 100,
      impressions: 1000,
      clicks: 20,
      reach: 900,
      frequency: 1.1,
      conversions: 5,
      revenue: 500,
    },
  ]),
  getMetaAdDailyRange: vi.fn(async () => []),
  getMetaBreakdownDailyRange: vi.fn(async () => []),
}));

import * as db from "@/lib/db";
import { runMetaSignalsBackfillForBusiness } from "@/lib/meta/entity-signals-backfill";

const BUSINESS = "biz_1";
const AS_OF = "2026-09-05";

interface Call {
  text: string;
  params: unknown[];
}

/** A database that records every query and answers the shapes this path needs. */
function harness(options: { timezone?: string | null } = {}) {
  const calls: Call[] = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    if (text.includes("provider_accounts")) {
      return options.timezone === null || options.timezone === undefined
        ? []
        : [{ provider_account_id: "act_1", timezone: options.timezone }];
    }
    return [];
  });
  const sql = Object.assign(async () => [], { query }) as never;
  vi.mocked(db.getDb).mockReturnValue(sql);
  return { calls, query };
}

const configHistoryCalls = (calls: Call[]) =>
  calls.filter((call) => call.text.includes("_config_history"));

describe("the config-history read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds the provider account and absolute timestamptz bounds", async () => {
    const { calls } = harness({ timezone: "America/Los_Angeles" });
    await runMetaSignalsBackfillForBusiness(BUSINESS, AS_OF).catch(() => undefined);

    const history = configHistoryCalls(calls);
    // The read may be skipped entirely if no entity resolved; that would make
    // every assertion below vacuous, so it is required to have happened.
    expect(history.length, "the config-history read must run").toBeGreaterThan(0);
    for (const call of history) {
      // ACCOUNT SCOPE.
      expect(call.text).toContain(
        "provider_account_id = requested_entities.provider_account_id",
      );
      // ABSOLUTE BOUNDS, and none of the session-relative date arithmetic.
      expect(call.text).toContain("captured_at >= requested_entities.start_inclusive");
      expect(call.text).toContain("captured_at < requested_entities.end_exclusive");
      expect(call.text).not.toContain("::date - INTERVAL");
      expect(call.text).not.toContain("::date + INTERVAL");
      // The bounds are the ADVERTISER's day, bound as instants.
      expect(call.params).toHaveLength(5);
      const [, , accounts, starts, ends] = call.params as [
        string, string[], string[], string[], string[],
      ];
      expect(accounts).toEqual(["act_1"]);
      // 2026-09-05 ends at 07:00Z in Los Angeles (PDT), not at UTC midnight.
      expect(ends[0]).toBe("2026-09-06T07:00:00.000Z");
      expect(ends[0]).not.toBe("2026-09-06T00:00:00.000Z");
      // 60 provider-local days earlier, also absolute.
      expect(starts[0]).toBe("2026-07-07T07:00:00.000Z");
    }
  });

  it("moves the bound when the account's zone moves", async () => {
    /*
      The discriminating half: the same as-of day under a different advertiser
      zone must produce a different absolute bound. If it did not, the value
      would not be coming from the account at all.
    */
    const { calls } = harness({ timezone: "Europe/Istanbul" });
    await runMetaSignalsBackfillForBusiness(BUSINESS, AS_OF).catch(() => undefined);

    const history = configHistoryCalls(calls);
    expect(history.length).toBeGreaterThan(0);
    const ends = (history[0]!.params as unknown[])[4] as string[];
    expect(ends[0]).toBe("2026-09-05T21:00:00.000Z");
  });

  it("does NOT read history at all when the account zone cannot be established", async () => {
    /*
      An unresolvable zone means the advertiser's day cannot be placed, so no
      window is honest and the entity is not requested. Guessing UTC would
      silently hand the account a day boundary that is not its own.

      ── ROUND 12: WHAT THIS TEST DOES *NOT* PROVE ────────────────────────────

      Round 11 wrote here that skipping the read "fails closed", because the
      entity then carries no `lastSignificantEditAt` and `qualityStatusFor`
      would not call it ready. That was FALSE, and this assertion could not see
      it: proving no SQL ran says nothing about the decision that follows.

      `qualityStatusFor` calls a pack ready at any three non-null signals out of
      six, so the pack stayed "ready" without the edit — and both
      `blocksPurchaseHardAction` and `recentEditCooldownActive` test
      `daysSinceSignificantEdit != null && < 7`, which a null passes. The
      withheld window authorised spend.

      The end-to-end proof that the ACTION is actually held now lives in
      `lib/meta/recent-edit-authority.test.ts`, which drives this same backfill
      into the real decision builders. This file keeps its narrower job: the
      SQL text and the bound parameters.
    */
    const { calls } = harness({ timezone: null });
    await runMetaSignalsBackfillForBusiness(BUSINESS, AS_OF).catch(() => undefined);

    expect(configHistoryCalls(calls)).toHaveLength(0);
  });

  it("does NOT read history when the zone is present but not a real IANA zone", async () => {
    // A fixed offset cannot express a DST rule and an abbreviation is
    // ambiguous; both are refused rather than approximated.
    for (const timezone of ["+03:00", "PST", "Mars/Olympus", "   "]) {
      vi.clearAllMocks();
      const { calls } = harness({ timezone });
      await runMetaSignalsBackfillForBusiness(BUSINESS, AS_OF).catch(() => undefined);
      expect(configHistoryCalls(calls), timezone).toHaveLength(0);
    }
  });
});
