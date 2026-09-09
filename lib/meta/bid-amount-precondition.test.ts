/**
 * The approved AMOUNT is re-proved at the write boundary, not only the strategy.
 *
 * WHAT WAS WRONG. Both bid callers read the live cap and compare it to the
 * envelope before they dispatch — `automation-proposal-execution.ts` at the
 * approval boundary, `scheduled-bid-runtime.ts` at the sweep's. Everything
 * after that comparison is awaits: an access check, an account context, an
 * action-log insert, a live provider preflight, a durable dispatch marker. An
 * operator moving the cap in Ads Manager inside that window was overwritten —
 * `updateAdsetBidAmount` writes the amount it is handed, and its read-back
 * verifies the number it just sent, so an approved "+10%, 1200 → 1320" landed
 * on somebody's 1500 as a 12% CUT and was reported as a verified success.
 *
 * The strategy could be closed with a POST-WRITE read-back because the write
 * does not change the strategy. The amount cannot: by read-back time it has
 * already been overwritten. So the amount needs a genuine PRE-POST comparison,
 * which is what `expectedCurrentBidAmountMinor` installs — the last awaited
 * operation before the request goes out.
 *
 * These cases drive the real write adapter with the provider mocked, because
 * the property is about which provider requests happen and in what order.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/automation-control-plane", () => ({
  getMetaWriteBlockState: vi.fn(),
}));

vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveMetaAccountAuthority: vi.fn(async () => ({
      state: "authorized",
      errorMessage: null,
    })),
  };
});

// The pre-POST authority snapshot is proved in `write-authority-toctou.test.ts`;
// these cases are about the bid precondition that runs after it.
vi.mock("@/lib/provider-write-authority", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertProviderWriteAuthorityUnchanged: vi.fn(async () => ({ ok: true })),
  };
});

const controlPlane = await import("@/lib/meta/automation-control-plane");
const { updateAdsetBidAmount } = await import("@/lib/meta/ads-write");
type MetaAdsWriteContext =
  import("@/lib/meta/ads-write").MetaAdsWriteContext;

const ctx: MetaAdsWriteContext = {
  businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  providerAccountId: "act_123",
  accessToken: "secret-token",
  connectionGeneration: "1:connected",
};

const ADSET = "adset_1";

/** What Meta answers a bid-state or verification GET with. */
function adsetState(bidAmount: number, bidStrategy = "COST_CAP") {
  return new Response(
    JSON.stringify({
      id: ADSET,
      account_id: "123",
      name: "Prospecting — broad",
      bid_amount: bidAmount,
      bid_strategy: bidStrategy,
      status: "ACTIVE",
      effective_status: "ACTIVE",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function accepted() {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The provider requests actually issued, in order. */
function issuedMethods() {
  return vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method);
}

describe("the live cap is re-proved immediately before the bid POST", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({
      blocked: false,
      reason: null,
      message: null,
      rehearsal: false,
    } as never);
  });

  it("refuses without POSTing when the cap moved after the caller's baseline", async () => {
    /*
      THE FINDING'S OWN CASE. The caller proved 1200 and sized 1320 against it;
      by the time the write reaches its boundary the ad set is on 1500. Before
      the fix the POST went out, the read-back found 1320, and the operator was
      told their approved raise had been applied.
    */
    vi.mocked(fetch).mockResolvedValueOnce(adsetState(1500));

    const result = await updateAdsetBidAmount(ctx, {
      adsetId: ADSET,
      bidAmountMinor: 1320,
      expectedBidStrategy: "COST_CAP",
      expectedCurrentBidAmountMinor: 1200,
    });

    expect(result.ok).toBe(false);
    expect(issuedMethods()).toEqual(["GET"]);
    expect(result).toMatchObject({
      error: { code: "bid_baseline_changed" },
      httpStatus: 409,
      // A DEFINITE failure: nothing was sent, so nothing has to be reconciled.
      providerMutationAttempted: false,
      providerOutcome: "definite_failure",
    });
    expect(result).not.toHaveProperty("mutationAttempt");
  });

  it("writes when the cap still holds, and verifies the number it sent", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(adsetState(1200))
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(adsetState(1320));

    const result = await updateAdsetBidAmount(ctx, {
      adsetId: ADSET,
      bidAmountMinor: 1320,
      expectedBidStrategy: "COST_CAP",
      expectedCurrentBidAmountMinor: 1200,
    });

    expect(result).toMatchObject({ ok: true, verifiedBidAmount: 1320 });
    // Precondition GET, the single POST, read-back GET.
    expect(issuedMethods()).toEqual(["GET", "POST", "GET"]);
  });

  it("reads the cap AFTER the journal hook, as the last step before the POST", async () => {
    /*
      Placement is the whole property. The caller's own comparison happens
      before the handler is even entered; a check that ran before the durable
      journal and dispatch-marker await would leave exactly the window this
      exists to close. `metaFetchWriteOnce` calls no awaited hook after this
      one.
    */
    const order: string[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      order.push(method);
      return method === "POST" ? accepted() : adsetState(1200);
    });

    await updateAdsetBidAmount(ctx, {
      adsetId: ADSET,
      bidAmountMinor: 1320,
      expectedCurrentBidAmountMinor: 1200,
      beforeMutationAttempt: async () => {
        order.push("journal");
      },
      onProviderMutationAttempt: () => { order.push("attempt"); },
    });

    expect(order).toEqual(["journal", "GET", "attempt", "POST", "GET"]);
  });

  it("refuses a strategy that moved, before the write rather than after it", async () => {
    // The post-write read-back still asserts this — it has to, the strategy can
    // move between this GET and the POST — but a refusal that arrives after the
    // amount has landed under the wrong strategy prevents nothing.
    vi.mocked(fetch).mockResolvedValueOnce(
      adsetState(1200, "LOWEST_COST_WITH_BID_CAP"),
    );

    const result = await updateAdsetBidAmount(ctx, {
      adsetId: ADSET,
      bidAmountMinor: 1320,
      expectedBidStrategy: "COST_CAP",
      expectedCurrentBidAmountMinor: 1200,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "bid_strategy_changed" },
      providerMutationAttempted: false,
      providerOutcome: "definite_failure",
    });
    expect(issuedMethods()).toEqual(["GET"]);
  });

  it("does not let a synchronous observation failure gate or repeat the POST", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(adsetState(1200))
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(adsetState(1320));
    const onProviderMutationAttempt = vi.fn(() => { throw new Error("observer failed"); });

    const result = await updateAdsetBidAmount(ctx, {
      adsetId: ADSET, bidAmountMinor: 1320, expectedCurrentBidAmountMinor: 1200,
      onProviderMutationAttempt,
    });

    expect(result).toMatchObject({ ok: true, verifiedBidAmount: 1320 });
    expect(onProviderMutationAttempt).toHaveBeenCalledOnce();
    expect(issuedMethods()).toEqual(["GET", "POST", "GET"]);
  });

  it("refuses when the pre-POST read is not about this ad set", async () => {
    // The read carries its own identity and account checks. An answer about
    // another ad set is not a baseline, and an unread baseline is not
    // permission to write.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id: "adset_other", account_id: "123", bid_amount: 1200 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await updateAdsetBidAmount(ctx, {
      adsetId: ADSET,
      bidAmountMinor: 1320,
      expectedCurrentBidAmountMinor: 1200,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "entity_identity_mismatch" },
      providerMutationAttempted: false,
    });
    expect(issuedMethods()).toEqual(["GET"]);
  });

  it("leaves a caller that proved no cap with the write it always had", async () => {
    /*
      The operator's own apply-bid entry. It has proved nothing about the
      current cap, so nothing is asserted on its behalf — and, specifically, NO
      extra provider request is made: POST then read-back, exactly as before.
    */
    vi.mocked(fetch)
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(adsetState(1320));

    const result = await updateAdsetBidAmount(ctx, {
      adsetId: ADSET,
      bidAmountMinor: 1320,
    });

    expect(result).toMatchObject({ ok: true, verifiedBidAmount: 1320 });
    expect(issuedMethods()).toEqual(["POST", "GET"]);
  });

  it("rehearses exactly as before: one GET, no precondition read", async () => {
    // A dry run returns before the write, so there is no POST to overwrite
    // anything and nothing for a pre-POST comparison to protect.
    vi.mocked(fetch).mockResolvedValueOnce(adsetState(1500));

    const result = await updateAdsetBidAmount(ctx, {
      adsetId: ADSET,
      bidAmountMinor: 1320,
      expectedBidStrategy: "COST_CAP",
      expectedCurrentBidAmountMinor: 1200,
      dryRun: true,
    });

    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(issuedMethods()).toEqual(["GET"]);
  });
});
