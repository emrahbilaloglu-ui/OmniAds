import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

import * as db from "@/lib/db";
import { readIntentProjectionContexts } from "@/lib/meta/intent-projection-context";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

function answers(sequence: Array<unknown[] | null>) {
  let call = 0;
  const tag = (() => Promise.resolve([])) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn(async () => {
    const answer = sequence[Math.min(call++, sequence.length - 1)];
    if (answer === null) throw new Error("unreadable");
    return answer;
  }) as never;
  vi.mocked(db.getDb).mockReturnValue(tag);
}

const CONFIG = [
  {
    entity_id: "camp_cbo", grain: "campaign", parent_campaign_id: null,
    budget_owner_mode: "campaign_budget_optimization",
    budget_raw_minor_units: 250_000, budget_field: "daily_budget",
    bid_strategy_type: null, hours_since_change: 40, changes_7d: 1,
  },
  {
    entity_id: "set_under_cbo", grain: "adset", parent_campaign_id: "camp_cbo",
    // An ad set under a CBO campaign carries a positive daily budget in its
    // own config row and owns none of it.
    budget_owner_mode: "campaign_budget_optimization",
    budget_raw_minor_units: 90_000, budget_field: "daily_budget",
    bid_strategy_type: "cost_cap", hours_since_change: 12, changes_7d: 0,
  },
  {
    entity_id: "set_abo", grain: "adset", parent_campaign_id: "camp_abo",
    budget_owner_mode: "adset_budget",
    budget_raw_minor_units: 50_000, budget_field: "daily_budget",
    bid_strategy_type: "lowest_cost", hours_since_change: 100, changes_7d: 2,
  },
];

const METRICS = [
  { entity_id: "camp_cbo", grain: "campaign", roas28d: 2.85, spend28d: 4000, purchases28d: 41 },
  { entity_id: "set_abo", grain: "adset", roas28d: 1.2, spend28d: 900, purchases28d: 6 },
];

const BIDS = [{ entity_id: "set_under_cbo", bid_amount: 1200 }];

function read(overrides: Partial<Parameters<typeof readIntentProjectionContexts>[0]> = {}) {
  return readIntentProjectionContexts({
    businessId: BUSINESS,
    providerAccountId: "act_1",
    snapshotDate: "2026-09-05",
    cohortByEntityId: new Map([["camp_cbo", "purchase"], ["set_abo", "purchase"]]),
    roleAuthorityByCampaignId: new Map([["camp_cbo", true]]),
    maturityByEntityId: new Map([["camp_cbo", true], ["set_abo", false]]),
    calibrationSampleByEntityId: new Map([["camp_cbo", 64]]),
    deliveryConstrainedAdsetIds: new Set(["set_under_cbo"]),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  answers([CONFIG, METRICS, BIDS]);
});

describe("the budget owner comes from the retained mode, never from an amount", () => {
  it("counts only real owners in the account total", async () => {
    const contexts = await read();
    expect(contexts).not.toBeNull();
    /*
      The CBO campaign owns 250,000. Its ad set carries 90,000 in its own
      config row and owns none of it — counting that would double the same
      spend and make every concentration share look smaller than it is.
      The ABO ad set owns its own 50,000.
    */
    expect(contexts!.accountDailyBudgetMinor).toBe(300_000);
  });

  it("marks an ad set under a CBO campaign as not applicable", async () => {
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

describe("an unread fact is null, never a default", () => {
  it("returns nothing at all when the config history cannot be read", async () => {
    // "No change in 24 hours" and "we could not see the change history" are
    // different answers; only the first may authorize a change.
    answers([null]);
    expect(await read()).toBeNull();
  });

  it("returns nothing when the metrics cannot be read", async () => {
    answers([CONFIG, null]);
    expect(await read()).toBeNull();
  });

  it("leaves a bid amount null rather than zero when none was observed", async () => {
    answers([CONFIG, METRICS, []]);
    const contexts = await read();
    expect(contexts!.bidByAdsetId.get("set_under_cbo")?.currentBidMinor).toBeNull();
  });
});

describe("the bid context is ad-set only and carries its strategy", () => {
  it("records the retained strategy and the observed cap", async () => {
    const contexts = await read();
    expect(contexts!.bidByAdsetId.get("set_under_cbo")).toMatchObject({
      bidStrategyType: "cost_cap",
      currentBidMinor: 1200,
      deliveryConstrained: true,
      parentCampaignId: "camp_cbo",
    });
  });

  it("has no entry for a campaign", async () => {
    const contexts = await read();
    expect(contexts!.bidByAdsetId.has("camp_cbo")).toBe(false);
  });

  it("carries a lowest-cost ad set through for the policy to refuse by name", async () => {
    // The policy owns the refusal, so the reader does not silently drop the
    // row: a dropped row produces no reason, and a reason is the point.
    const contexts = await read();
    expect(contexts!.bidByAdsetId.get("set_abo")?.bidStrategyType).toBe("lowest_cost");
  });
});

describe("the role gate travels per campaign", () => {
  it("gives an ad set its parent campaign's role authority", async () => {
    const contexts = await read();
    expect(contexts!.budgetByEntityId.get("set_under_cbo")?.roleAuthoritySatisfied)
      .toBe(true);
    // `camp_abo` has no role, so its ad set has none either.
    expect(contexts!.budgetByEntityId.get("set_abo")?.roleAuthoritySatisfied)
      .toBe(false);
  });
});
