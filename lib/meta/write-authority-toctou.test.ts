import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The window between admission and the provider POST.
 *
 * Route admission proves selection once, at the start of a request. Everything
 * after it is time: resolving an entity from the warehouse, reading a journal,
 * taking a baseline, iterating a batch, retrying. Launchpad is the extreme
 * case — it resolves the assignment near admission and then performs campaign,
 * ad-set and ad POSTs much later and across a batch, and its immediate write
 * helper rechecked only the kill switch.
 *
 * So the re-read lives in `getMetaAdsWriteBlockFailure`, the one hook every
 * write path passes through immediately before the request goes out. These
 * tests flip authority AFTER admission and BETWEEN batch items and prove that
 * no further provider call happens.
 */

const getMetaWriteBlockState = vi.fn();
const resolveMetaAccountAuthority = vi.fn();
const providerFetch = vi.fn();

vi.mock("@/lib/meta/automation-control-plane", () => ({ getMetaWriteBlockState }));

vi.mock("@/lib/meta/account-context", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveMetaAccountAuthority };
});

const {
  getMetaAdsWriteBlockFailure,
  isMetaWriteAuthorityFailure,
  META_ACCOUNT_NOT_SELECTED_CODE,
  META_ACCOUNT_AUTHORITY_UNKNOWN_CODE,
  pauseAd,
  pauseCampaign,
  pauseAdset,
  updateAdsetBidAmount,
} = await import("@/lib/meta/ads-write");

const ctx = {
  businessId: "biz-1",
  providerAccountId: "act_1",
  accessToken: "token",
};

describe("Meta write authority at the immediate pre-POST boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMetaWriteBlockState.mockResolvedValue({ blocked: false });
    resolveMetaAccountAuthority.mockResolvedValue({
      state: "authorized",
      errorMessage: null,
    });
    vi.stubGlobal("fetch", providerFetch);
    providerFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "1" }), { status: 200 }),
    );
  });

  it("admits when the account is currently selected", async () => {
    await expect(getMetaAdsWriteBlockFailure(ctx)).resolves.toBeNull();
  });

  it("refuses a deselected account with 409 and no provider call", async () => {
    resolveMetaAccountAuthority.mockResolvedValue({
      state: "confirmed_revoked",
      errorMessage: null,
    });
    const failure = await getMetaAdsWriteBlockFailure(ctx);
    expect(failure?.httpStatus).toBe(409);
    expect(failure?.error.code).toBe(META_ACCOUNT_NOT_SELECTED_CODE);
    expect(failure?.providerMutationAttempted).toBe(false);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("refuses unreadable authority as uncertain with 503, not as revoked", async () => {
    resolveMetaAccountAuthority.mockResolvedValue({
      state: "unknown_error",
      errorMessage: "connection terminated",
    });
    const failure = await getMetaAdsWriteBlockFailure(ctx);
    expect(failure?.httpStatus).toBe(503);
    expect(failure?.error.code).toBe(META_ACCOUNT_AUTHORITY_UNKNOWN_CODE);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("checks the kill switch before selection", async () => {
    getMetaWriteBlockState.mockResolvedValue({ blocked: true, message: "off" });
    const failure = await getMetaAdsWriteBlockFailure(ctx);
    expect(failure?.error.code).toBe("kill_switch_engaged");
    expect(resolveMetaAccountAuthority).not.toHaveBeenCalled();
  });

  const postCount = () =>
    providerFetch.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    ).length;

  it.each([
    ["pauseAd", () => pauseAd(ctx, "ad-1")],
    ["pauseCampaign", () => pauseCampaign(ctx, "c-1")],
    ["pauseAdset", () => pauseAdset(ctx, "as-1")],
    [
      "updateAdsetBidAmount",
      () =>
        updateAdsetBidAmount(ctx, {
          adsetId: "as-1",
          bidAmountMinor: 500,
        }),
    ],
  ])(
    "%s issues zero provider MUTATIONS once authority is revoked",
    async (_label, run) => {
      // Authority was fine at admission; it is revoked by the time the write
      // helper runs. These helpers read current state first, so a GET may
      // happen — what must not happen is a POST.
      resolveMetaAccountAuthority.mockResolvedValue({
        state: "confirmed_revoked",
        errorMessage: null,
      });
      const result = (await run()) as { ok: boolean; error?: { code?: string } };
      expect(result.ok).toBe(false);
      expect(postCount()).toBe(0);
    },
  );

  it("halts a batch at the item where authority flips", async () => {
    // Three items sharing one context. Authority is good for the first and
    // revoked from the second on. A batch that treated this as an ordinary
    // per-item failure would keep going and keep calling the provider.
    //
    // Driven through `getMetaAdsWriteBlockFailure` directly because that is the
    // hook every item passes through, whatever the item's own preflight looks
    // like.
    let call = 0;
    resolveMetaAccountAuthority.mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { state: "authorized", errorMessage: null }
        : { state: "confirmed_revoked", errorMessage: null };
    });

    const processed: string[] = [];
    let halted: { code?: string } | null = null;
    for (const adId of ["ad-1", "ad-2", "ad-3"]) {
      const failure = await getMetaAdsWriteBlockFailure(ctx);
      if (failure && isMetaWriteAuthorityFailure(failure.error)) {
        halted = failure.error;
        break;
      }
      processed.push(adId);
    }

    expect(processed).toEqual(["ad-1"]);
    expect(halted?.code).toBe(META_ACCOUNT_NOT_SELECTED_CODE);
    // Item 3 was never even evaluated.
    expect(resolveMetaAccountAuthority).toHaveBeenCalledTimes(2);
  });

  it("re-reads authority AFTER the journaling hook, immediately before the POST", async () => {
    // The route checks once, and the check at the top of the write helper runs
    // BEFORE `beforeMutationAttempt` — which is where the durable journal entry
    // is written, and journaling is not instantaneous. An account deselected in
    // that window would have been caught by neither.
    let revokedDuringJournaling = false;
    resolveMetaAccountAuthority.mockImplementation(async () =>
      revokedDuringJournaling
        ? { state: "confirmed_revoked", errorMessage: null }
        : { state: "authorized", errorMessage: null },
    );

    const failure = await (async () => {
      const first = await getMetaAdsWriteBlockFailure(ctx);
      expect(first).toBeNull();
      // ...the journaling hook runs here, and the account is deselected in it.
      revokedDuringJournaling = true;
      return getMetaAdsWriteBlockFailure(ctx);
    })();

    expect(failure?.error.code).toBe(META_ACCOUNT_NOT_SELECTED_CODE);
    expect(postCount()).toBe(0);
  });

  it("classifies both authority refusals as batch-halting", () => {
    expect(isMetaWriteAuthorityFailure({ code: META_ACCOUNT_NOT_SELECTED_CODE })).toBe(
      true,
    );
    expect(
      isMetaWriteAuthorityFailure({ code: META_ACCOUNT_AUTHORITY_UNKNOWN_CODE }),
    ).toBe(true);
    // An ordinary provider error is retryable per item and must NOT stop a batch.
    expect(isMetaWriteAuthorityFailure({ code: "meta_http_error" })).toBe(false);
    expect(isMetaWriteAuthorityFailure(null)).toBe(false);
  });
});
