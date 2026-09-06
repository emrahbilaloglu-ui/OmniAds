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
 *
 * PR #272 review — the fixtures below used to answer `currency` on a campaign
 * and an ad-set node, which Meta has never done: currency is an AD ACCOUNT
 * field, and asking a campaign for it makes the graph reject the whole GET
 * with error #100. Every case that turned on an observed entity currency was
 * therefore testing a provider that does not exist. The currency now comes
 * from the verified ad-account profile the caller supplies, and the account
 * identity of the node is what ties the two together.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUDGET_READBACK_FIELDS,
} from "@/lib/meta/budget-write-capability";
import {
  readMetaEntityBudgetState,
  updateEntityBudget,
  type MetaAdsWriteContext,
} from "@/lib/meta/ads-write";

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

/** The account's verified currency, as the account profile reports it. */
const ACCOUNT_CURRENCY = "TRY";

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * A campaign node exactly as Meta answers it for this field list.
 *
 * No `currency`: the graph has no such field on a campaign or an ad set, and a
 * fixture that invents one hides the very failure this suite exists to catch.
 */
const node = (over: Record<string, unknown> = {}) =>
  json({
    id: "campaign_1",
    account_id: "123",
    name: "Prospecting",
    daily_budget: "250000",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    ...over,
  });

/** What the graph actually answers when a GET asks for an unknown field. */
const invalidFieldError = () =>
  json({
    error: {
      message:
        "(#100) Tried accessing nonexisting field (currency) on node type (AdCampaign)",
      type: "OAuthException",
      code: 100,
      fbtrace_id: "AbCdEfGhIjK",
    },
  }, 400);

const call = (over: Record<string, unknown> = {}) =>
  updateEntityBudget(ctx, {
    scope: "campaign",
    entityId: "campaign_1",
    budgetField: "daily_budget",
    amountMinor: 300000,
    expectedCurrency: ACCOUNT_CURRENCY,
    expectedPreviousAmountMinor: 250000,
    ...over,
  } as never);

/** Every POST the adapter issued, in order. */
const posts = () =>
  vi.mocked(fetch).mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );

/** Every GET the adapter issued, as URL strings. */
const gets = () =>
  vi.mocked(fetch).mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method !== "POST")
    .map(([url]) => String(url));

describe("D087 C1 — the adapter re-checks the baseline immediately before POST", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({ blocked: false, reason: null, message: null, rehearsal: false });
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
      // The ACCOUNT's currency, supplied by the caller — not a field Meta
      // answered for the campaign, because Meta answers no such field.
      expect(result.verifiedCurrency).toBe(ACCOUNT_CURRENCY);
    }
  });

  it("rechecks after an asynchronous dispatch marker and refuses a concurrent edit", async () => {
    let markerFinished = false;
    const marker = vi.fn(async () => {
      // Model another operator changing Meta while the durable marker await is
      // in flight. The provider read must happen only after this completes.
      markerFinished = true;
      return true;
    });
    vi.mocked(fetch).mockImplementationOnce(async () => {
      expect(markerFinished).toBe(true);
      return node({ daily_budget: "260000" });
    });

    const result = await call({ beforeProviderPost: marker });

    expect(marker).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("precondition_amount_mismatch");
      expect(result.providerMutationAttempted).toBe(false);
    }
    expect(posts()).toHaveLength(0);
  });

  it("writes the AD-SET field on the ad-set node", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({
        id: "adset_1", account_id: "123", name: "Broad",
        lifetime_budget: "900000",
      }))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(json({
        id: "adset_1", account_id: "123", name: "Broad",
        lifetime_budget: "990000",
      }));

    const result = await call({
      scope: "adset", entityId: "adset_1", budgetField: "lifetime_budget",
      amountMinor: 990000, expectedPreviousAmountMinor: 900000,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(String((posts()[0]![1] as RequestInit).body)).toBe("lifetime_budget=990000");
    if (result.ok) expect(result.verifiedCurrency).toBe(ACCOUNT_CURRENCY);
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

  it("marks a successful POST with an unreadable verification GET as ambiguous", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(node())
      .mockResolvedValueOnce(json({ success: true }))
      .mockRejectedValueOnce(new Error("verification timeout"));

    const result = await call();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.providerMutationAttempted).toBe(true);
      expect(result.providerOutcome).toBe("outcome_ambiguous");
      expect(result.error.code).toBe("provider_outcome_ambiguous");
      expect(result.mutationAttempt).toMatchObject({
        attemptCount: 1,
        providerResponseReceived: true,
        providerResponseSuccessful: true,
        automaticRetryAttempted: false,
      });
    }
    expect(posts()).toHaveLength(1);
  });
});

/**
 * PR #272 review — the currency a budget is denominated in comes from the
 * ACCOUNT, and the entity read never asks for it.
 */
describe("budget currency: the account's, verified, never the request's", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({ blocked: false, reason: null, message: null, rehearsal: false });
  });

  it("never asks a campaign or ad-set GET for a currency field", async () => {
    expect(BUDGET_READBACK_FIELDS).not.toContain("currency");
    expect(BUDGET_READBACK_FIELDS).toContain("account_id");
    expect(BUDGET_READBACK_FIELDS).toContain("daily_budget");
    expect(BUDGET_READBACK_FIELDS).toContain("lifetime_budget");

    vi.mocked(fetch)
      .mockResolvedValueOnce(node())
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node({ daily_budget: "300000" }));
    await call();

    const requested = gets();
    expect(requested.length).toBeGreaterThan(0);
    for (const url of requested) {
      const fields = new URL(url).searchParams.get("fields") ?? "";
      expect(fields).not.toContain("currency");
      expect(fields.split(",")).toContain("account_id");
    }
  });

  it("also asks no currency field on the ad-set read path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({
      id: "adset_1", account_id: "123", name: "Broad", lifetime_budget: "900000",
    }));

    await readMetaEntityBudgetState(ctx, {
      entityId: "adset_1",
      budgetField: "lifetime_budget",
      accountCurrency: ACCOUNT_CURRENCY,
    });

    for (const url of gets()) {
      expect(new URL(url).searchParams.get("fields") ?? "").not.toContain("currency");
    }
  });

  it("is why the old field list could never have worked: Meta answers #100", async () => {
    /*
      The provider behaviour the previous fixtures hid. If the read-back list
      still asked a campaign for `currency`, this is the response, and it fails
      the WHOLE read — baseline, compare-and-set and post-write verification
      alike, not merely the currency half of it.
    */
    vi.mocked(fetch).mockResolvedValueOnce(invalidFieldError());

    const result = await call();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.providerMutationAttempted).toBe(false);
    expect(posts()).toHaveLength(0);
  });

  it.each([
    ["absent", ""],
    ["blank", "   "],
  ])("REFUSES with ZERO POSTs when the verified account currency is %s", async (_l, supplied) => {
    vi.mocked(fetch).mockResolvedValueOnce(node());

    const result = await call({ expectedCurrency: supplied });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("precondition_currency_absent");
      expect(result.providerMutationAttempted).toBe(false);
    }
    expect(posts()).toHaveLength(0);
  });

  it("REFUSES a read with no verified account currency before contacting Meta", async () => {
    vi.mocked(fetch).mockResolvedValue(node());

    const read = await readMetaEntityBudgetState(ctx, {
      entityId: "campaign_1",
      budgetField: "daily_budget",
      accountCurrency: "",
    });

    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("account_currency_missing");
    // Refused BEFORE the provider was asked anything at all.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("reports the account currency it was given, for campaign and ad set alike", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(node());
    const campaign = await readMetaEntityBudgetState(ctx, {
      entityId: "campaign_1",
      budgetField: "daily_budget",
      accountCurrency: ACCOUNT_CURRENCY,
    });
    expect(campaign.ok).toBe(true);
    if (campaign.ok) {
      expect(campaign.currency).toBe(ACCOUNT_CURRENCY);
      expect(campaign.amountMinor).toBe(250000);
      expect(campaign.providerAccountId).toBe("act_123");
    }

    vi.mocked(fetch).mockResolvedValueOnce(json({
      id: "adset_1", account_id: "123", name: "Broad", lifetime_budget: "900000",
    }));
    const adset = await readMetaEntityBudgetState(ctx, {
      entityId: "adset_1",
      budgetField: "lifetime_budget",
      accountCurrency: ACCOUNT_CURRENCY,
    });
    expect(adset.ok).toBe(true);
    if (adset.ok) expect(adset.currency).toBe(ACCOUNT_CURRENCY);
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
    if (!result.ok) {
      expect(result.providerMutationAttempted).toBe(true);
      expect(result.providerOutcome).toBe("outcome_ambiguous");
      expect(result.error.code).toBe("provider_outcome_ambiguous");
      expect(result.verificationFailure?.code).toBe(code);
    }
  });

  it("takes no currency from the entity payload, however loudly it claims one", async () => {
    /*
      The request-proves-itself pin, restated for the account model: a node
      that (impossibly) volunteered a currency must not be able to change what
      the write is verified against. The answer stays the account's.
    */
    vi.mocked(fetch)
      .mockResolvedValueOnce(node({ currency: "USD" }))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(node({ daily_budget: "300000", currency: "USD" }));

    const result = await call();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.verifiedCurrency).toBe(ACCOUNT_CURRENCY);

    // And the adapter never reads a currency off the wire to begin with.
    const source = (await import("node:fs")).readFileSync("lib/meta/ads-write.ts", "utf8");
    expect(source).not.toContain("verificationPayload?.currency");
    expect(source).not.toContain("payload?.currency");
  });
});
