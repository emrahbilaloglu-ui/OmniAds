/**
 * D087 C1 — the budget adapter, against the repository's mocked Meta transport.
 *
 * The orchestrator's compare-and-set happens against an injected baseline read
 * some milliseconds earlier. That is not the last word: the adapter itself does
 * another GET before it POSTs, and until C1 nothing compared THAT read to the
 * value the proposal was accepted against. An operator change landing in the
 * gap was overwritten.
 *
 * So these cases count POSTs. A refusal that still issued a mutation is not a
 * refusal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateEntityBudget, type MetaAdsWriteContext } from "@/lib/meta/ads-write";

vi.mock("@/lib/meta/automation-control-plane", () => ({
  getMetaWriteBlockState: vi.fn(),
}));
const controlPlane = await import("@/lib/meta/automation-control-plane");

vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveMetaAccountAuthority: vi.fn(async () => ({
      state: "authorized", errorMessage: null,
    })),
  };
});
vi.mock("@/lib/provider-write-authority", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertProviderWriteAuthorityUnchanged: vi.fn(async () => ({ ok: true })),
  };
});

const ctx: MetaAdsWriteContext = {
  businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  providerAccountId: "act_123",
  accessToken: "secret-token",
  connectionGeneration: "1:connected",
};

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** A campaign node exactly as the read-back field list asks for it. */
const node = (over: Record<string, unknown> = {}) =>
  json({
    id: "campaign_1",
    account_id: "123",
    name: "Prospecting",
    daily_budget: "250000",
    currency: "TRY",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    ...over,
  });

const call = (over: Record<string, unknown> = {}) =>
  updateEntityBudget(ctx, {
    scope: "campaign",
    entityId: "campaign_1",
    budgetField: "daily_budget",
    amountMinor: 300000,
    expectedCurrency: "TRY",
    expectedPreviousAmountMinor: 250000,
    ...over,
  } as never);

/** Every POST the adapter issued, in order. */
const posts = () =>
  vi.mocked(fetch).mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );

describe("D087 C1 — the adapter re-checks the baseline immediately before POST", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({
      blocked: false, reason: null, message: null,
    });
  });

  it("writes ONCE, with the exact field and body, when the pre-POST read still matches", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(node())                                  // pre-POST CAS read
      .mockResolvedValueOnce(json({ success: true }))                 // the POST
      .mockResolvedValueOnce(node({ daily_budget: "300000" }));       // read-back

    const result = await call();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const issued = posts();
    expect(issued).toHaveLength(1);
    expect(String(issued[0]![0])).toContain("campaign_1");
    expect(String((issued[0]![1] as RequestInit).body)).toBe("daily_budget=300000");
    if (result.ok) {
      expect(result.verifiedAmountMinor).toBe(300000);
      expect(result.previousAmountMinor).toBe(250000);
      expect(result.verifiedCurrency).toBe("TRY");
    }
  });

  it("writes the AD-SET field on the ad-set node", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({
        id: "adset_1", account_id: "123", name: "Broad",
        lifetime_budget: "900000", currency: "TRY",
      }))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(json({
        id: "adset_1", account_id: "123", name: "Broad",
        lifetime_budget: "990000", currency: "TRY",
      }));

    const result = await call({
      scope: "adset", entityId: "adset_1", budgetField: "lifetime_budget",
      amountMinor: 990000, expectedPreviousAmountMinor: 900000,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(String((posts()[0]![1] as RequestInit).body)).toBe("lifetime_budget=990000");
  });

  it.each([
    ["the value moved after preflight", { daily_budget: "260000" }, "precondition_amount_mismatch"],
    /*
      Identity is refused by the SHARED `verifyEntity` boundary before the
      budget classifier is reached, under the repository's own codes. Asserting
      those rather than inventing a parallel pair keeps one name per fault.
    */
    ["another entity answered", { id: "campaign_999" }, "entity_identity_mismatch"],
    ["another account answered", { account_id: "999" }, "provider_account_mismatch"],
    ["the currency changed", { currency: "USD" }, "precondition_currency_mismatch"],
    ["the currency is absent", { currency: undefined }, "precondition_currency_absent"],
    ["the field is absent", { daily_budget: undefined }, "precondition_field_absent"],
  ])("REFUSES and issues ZERO POSTs when %s", async (_label, over, code) => {
    vi.mocked(fetch).mockResolvedValueOnce(node(over));
    const result = await call();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(code);
      expect(result.providerOutcome).toBe("definite_failure");
      expect(result.providerMutationAttempted).toBe(false);
    }
    expect(posts()).toHaveLength(0);
  });

  it("REFUSES when the pre-POST read itself fails, and issues ZERO POSTs", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ error: { message: "nope" } }, 400));
    const result = await call();
    expect(result.ok).toBe(false);
    expect(posts()).toHaveLength(0);
  });
});

describe("D087 C1 — currency is OBSERVED, never substituted", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({
      blocked: false, reason: null, message: null,
    });
  });

  it.each([
    ["missing on the read-back", { currency: undefined }, "readback_currency_absent"],
    ["wrong on the read-back", { currency: "USD" }, "readback_currency_mismatch"],
  ])("fails closed when the currency is %s", async (_label, over, code) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(node())
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node({ daily_budget: "300000", ...over }));

    const result = await call();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it.each([
    ["the wrong entity", { id: "campaign_999" }, "entity_identity_mismatch"],
    ["the wrong account", { account_id: "999" }, "provider_account_mismatch"],
    ["no such field", { daily_budget: undefined }, "readback_field_absent"],
    ["the old value", { daily_budget: "250000" }, "silent_failure"],
  ])("a 2xx whose read-back shows %s is NOT success", async (_label, over, code) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(node())
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node({ daily_budget: "300000", ...over }));

    const result = await call();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it("never reports a currency the provider did not state", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(node())
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node({ daily_budget: "300000", currency: "TRY" }));
    const result = await call();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.verifiedCurrency).toBe("TRY");
    // The source of that string is the read-back, not the request: a request
    // in a currency the account does not hold cannot make itself true.
    const source = (await import("node:fs")).readFileSync("lib/meta/ads-write.ts", "utf8");
    expect(source).not.toContain("verifiedCurrency: input.expectedCurrency");
  });
});
