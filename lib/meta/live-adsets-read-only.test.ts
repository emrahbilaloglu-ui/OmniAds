import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live ad-set fallback claimed to fetch "without warehouse writes".
 *
 * It did not. It delegates to `getAdSets`, which is the SYNC path's capture
 * function, and that recorded `adset_statuses` and `adset_insights` keyed by the
 * requested window. Viewing a historical range therefore appended raw rows on
 * every page load AND attributed the account's CURRENT ad-set state to a past
 * date — the same fabricated date-keyed identity the historical core path had,
 * reached from a read instead of from a backfill.
 */

// `recordMetaRawSnapshot` is module-local to lib/api/meta, so the observable
// boundary is the store function it delegates to.
const persistMetaRawSnapshot = vi.fn();
const resolveMetaCredentials = vi.fn();
const providerFetch = vi.fn();

vi.mock("@/lib/meta/warehouse", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, persistMetaRawSnapshot };
});

const meta = await import("@/lib/api/meta");
const live = await import("@/lib/meta/live");

const credentials = {
  businessId: "biz-1",
  accessToken: "token",
  accountIds: ["act_1"],
  currency: "TRY",
  accountProfiles: {
    act_1: { currency: "TRY", timezone: "Europe/Istanbul", name: "Account" },
  },
};

function emptyGraphResponse() {
  return new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("live ad-set fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", providerFetch);
    providerFetch.mockImplementation(async () => emptyGraphResponse());
    persistMetaRawSnapshot.mockResolvedValue(null);
    resolveMetaCredentials.mockResolvedValue(credentials);
  });

  it("records raw evidence by default, because the sync path captures", async () => {
    await meta.getAdSets(
      credentials as never,
      null,
      "2026-05-01",
      "2026-05-01",
      "biz-1",
      false,
      null,
    );
    expect(persistMetaRawSnapshot).toHaveBeenCalled();
  });

  it("records nothing when raw-snapshot capture is switched off", async () => {
    await meta.getAdSets(
      credentials as never,
      null,
      "2026-05-01",
      "2026-05-01",
      "biz-1",
      false,
      null,
      { recordRawSnapshots: false },
    );
    expect(persistMetaRawSnapshot).not.toHaveBeenCalled();
    // The provider was still asked — the read genuinely happened.
    expect(providerFetch).toHaveBeenCalled();
  });

  it("the live fallback passes that flag, so a historical read writes nothing", async () => {
    const credentialsSpy = vi
      .spyOn(meta, "resolveMetaCredentials")
      .mockResolvedValue(credentials as never);
    try {
      await live.getMetaLiveAdSets({
        businessId: "biz-1",
        startDate: "2026-05-01",
        endDate: "2026-05-01",
      });
    } finally {
      credentialsSpy.mockRestore();
    }
    expect(persistMetaRawSnapshot).not.toHaveBeenCalled();
  });
});
