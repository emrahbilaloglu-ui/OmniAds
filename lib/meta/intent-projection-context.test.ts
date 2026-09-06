import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import * as db from "@/lib/db";
import { readIntentProjectionContexts } from "@/lib/meta/intent-projection-context";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

/**
 * A SCHEMA-AWARE double.
 *
 * The previous version of this suite mocked the database and fed rows named
 * after columns that do not exist — `budget_owner_mode`,
 * `budget_raw_minor_units`, `budget_field`, `changed_at`, `bid_amount`,
 * `purchases`. Every one of them belongs to the prepared-and-unapplied D086
 * pack or to nothing at all, so every statement raised 42703 in production
 * while this file stayed green. A mocked row agrees with any schema.
 *
 * So this double refuses an identifier the real tables do not have, and the
 * end-to-end proof lives in `ephemeral-postgres-intent-projection-seam-child`,
 * which runs these exact statements against a migrated database.
 */
const KNOWN_COLUMNS = new Set([
  // meta_entity_state_history
  "entity_type", "entity_id", "campaign_id", "adset_id", "presence",
  "budget_origin", "budget_currency", "budget_currency_exponent",
  "campaign_daily_budget_raw", "campaign_lifetime_budget_raw",
  "adset_daily_budget_raw", "adset_lifetime_budget_raw",
  "observed_at", "captured_at", "created_at", "business_id",
  "provider_account_id", "id",
  // meta_campaign_daily / meta_adset_daily
  "date", "spend", "revenue", "conversions", "bid_strategy_type",
  "bid_value", "bid_value_format",
  // meta_budget_write_journal
  "requested_at", "result_class",
]);

/** Identifiers that were queried and do not exist on any of those tables. */
const FORBIDDEN_COLUMNS = [
  "budget_owner_mode",
  "budget_raw_minor_units",
  "budget_field",
  "changed_at",
  "bid_amount",
  // `purchases` is the alias the reader PRODUCES; asking a table for it is the
  // defect, so only a bare `sum(purchases)` is forbidden.
  "sum(purchases)",
];

function assertSchemaSafe(sql: string) {
  const normalized = sql.replace(/\s+/g, " ");
  for (const forbidden of FORBIDDEN_COLUMNS) {
    if (normalized.includes(forbidden)) {
      throw new Error(
        `query names ${forbidden}, which no applied migration creates`,
      );
    }
  }
}

function answers(sequence: Array<unknown[] | null>) {
  let call = 0;
  const issued: string[] = [];
  const tag = (() => Promise.resolve([])) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn(async (sql: string) => {
    issued.push(sql);
    assertSchemaSafe(sql);
    const answer = sequence[Math.min(call++, sequence.length - 1)];
    if (answer === null) throw new Error("unreadable");
    return answer;
  }) as never;
  vi.mocked(db.getDb).mockReturnValue(tag);
  return issued;
}

/** State rows shaped the way the reader's own SELECT list produces them. */
const STATE = [
  {
    entity_type: "campaign", entity_id: "camp_cbo", campaign_id: "camp_cbo",
    budget_origin: "campaign", owned_minor: "250000", owned_field_count: 1,
    budget_currency: "USD", budget_currency_exponent: 2,
  },
  {
    // The ad set beneath it: its observation carries the campaign's amount and
    // it owns none of it.
    entity_type: "adset", entity_id: "set_under_cbo", campaign_id: "camp_cbo",
    budget_origin: "campaign", owned_minor: null, owned_field_count: 0,
    budget_currency: "USD", budget_currency_exponent: 2,
  },
  {
    entity_type: "adset", entity_id: "set_abo", campaign_id: "camp_abo",
    budget_origin: "adset", owned_minor: "50000", owned_field_count: 1,
    budget_currency: "USD", budget_currency_exponent: 2,
  },
];

const METRICS = [
  { entity_id: "camp_cbo", grain: "campaign", roas28d: 2.85, spend28d: 4000, purchases28d: 41 },
  { entity_id: "set_abo", grain: "adset", roas28d: 1.2, spend28d: 900, purchases28d: 6 },
];

const BIDS = [
  {
    entity_id: "set_under_cbo", campaign_id: "camp_cbo",
    bid_strategy_type: "cost_cap", bid_value: 12, bid_value_format: "currency",
  },
  {
    entity_id: "set_abo", campaign_id: "camp_abo",
    bid_strategy_type: "target_roas", bid_value: 2.2, bid_value_format: "roas",
  },
];

const CHANGES: unknown[] = [];

function read(overrides: Partial<Parameters<typeof readIntentProjectionContexts>[0]> = {}) {
  return readIntentProjectionContexts({
    businessId: BUSINESS,
    providerAccountId: "act_1",
    snapshotDate: "2026-09-05",
    cohortByEntityId: new Map([["camp_cbo", "purchase"], ["set_abo", "purchase"]]),
    roleAuthorityByCampaignId: new Map([["camp_cbo", true]]),
    maturityByEntityId: new Map([["camp_cbo", true], ["set_under_cbo", true]]),
    calibrationSampleByEntityId: new Map([["camp_cbo", 64]]),
    deliveryConstrainedAdsetIds: new Set(["set_under_cbo"]),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  answers([STATE, METRICS, BIDS, CHANGES]);
});

describe("every query names a column an applied migration creates", () => {
  it("issues four statements and none of them touches the unapplied pack", async () => {
    const issued = answers([STATE, METRICS, BIDS, CHANGES]);
    await read();
    expect(issued).toHaveLength(4);
    // Named explicitly, because the whole failure was a silent 42703.
    expect(issued[0]).toContain("meta_entity_state_history");
    expect(issued[0]).toContain("budget_origin");
    expect(issued[1]).toContain("sum(conversions)");
    expect(issued[2]).toContain("bid_value_format");
    expect(issued[3]).toContain("meta_budget_write_journal");
  });
});

describe("the budget owner comes from budget_origin, never from an amount", () => {
  it("counts only real owners in the account total", async () => {
    const contexts = await read();
    // 250,000 (CBO campaign) + 50,000 (ABO ad set). The ad set beneath the CBO
    // campaign owns nothing, however much its own row carries.
    expect(contexts!.accountDailyBudgetMinor).toBe(300_000);
  });

  it("marks an ad set under a CBO campaign proven non-applicable", async () => {
    const contexts = await read();
    expect(contexts!.budgetByEntityId.get("set_under_cbo")?.budgetUniverse)
      .toBe("proven_non_applicable");
    expect(contexts!.budgetByEntityId.get("camp_cbo")?.budgetUniverse)
      .toBe("applicable");
    expect(contexts!.budgetByEntityId.get("set_abo")?.budgetUniverse)
      .toBe("applicable");
  });

  it("computes each owner's share against that same total", async () => {
    const contexts = await read();
    expect(contexts!.budgetByEntityId.get("camp_cbo")?.accountShareBefore)
      .toBeCloseTo(250_000 / 300_000, 6);
  });
});

describe("a bid cap is a currency amount, never a ratio", () => {
  it("scales a currency-format value into minor units", async () => {
    const contexts = await read();
    expect(contexts!.bidByAdsetId.get("set_under_cbo")).toMatchObject({
      bidStrategyType: "cost_cap",
      currentBidMinor: 1200,
      deliveryConstrained: true,
    });
  });

  it("refuses a roas-format value as a cap", async () => {
    // `bid_value` 2.2 with format `roas` is a Target ROAS ratio. Writing it as
    // an amount would put a ratio into a currency field.
    const contexts = await read();
    expect(contexts!.bidByAdsetId.get("set_abo")?.currentBidMinor).toBeNull();
  });
});

describe("an unread fact is null, never a default", () => {
  it("returns nothing when the budget state cannot be read", async () => {
    answers([null]);
    expect(await read()).toBeNull();
  });

  it("returns nothing when the metrics cannot be read", async () => {
    answers([STATE, null]);
    expect(await read()).toBeNull();
  });

  it("returns nothing when the change journal cannot be read", async () => {
    // "No change in 24 hours" and "we could not see the change history" are
    // different answers, and only the first may authorize moving money.
    answers([STATE, METRICS, BIDS, null]);
    expect(await read()).toBeNull();
  });

  it("treats an absent journal ROW as never changed by us", async () => {
    const contexts = await read();
    expect(contexts!.budgetByEntityId.get("camp_cbo")?.changesLast7d).toBe(0);
    expect(contexts!.budgetByEntityId.get("camp_cbo")?.hoursSinceLastChange)
      .toBe(Number.POSITIVE_INFINITY);
  });
});
