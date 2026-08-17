import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlTag = vi.hoisted(() => vi.fn());
const assertDbSchemaReady = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ getDb: () => sqlTag }));
vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady,
  isMissingRelationError: () => false,
}));

const {
  MERCHANT_CENTER_STATE_MAX_AGE_MS,
  readMerchantCenterFeedState,
  upsertMerchantCenterItemStates,
} = await import("@/lib/google-ads/merchant-center-warehouse");

const NOW = new Date("2026-08-17T12:00:00.000Z");

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    item_id: "AT-104",
    merchant_center_id: "512233",
    product_title: "Aurora Tote — Sand",
    feed_label: "US",
    language_code: "en",
    channel: "ONLINE",
    availability: "IN_STOCK",
    raw_status: "ELIGIBLE",
    feed_state: "serving",
    issues_json: [],
    observed_at: "2026-08-17T11:34:00.000Z",
    ...overrides,
  };
}

describe("readMerchantCenterFeedState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertDbSchemaReady.mockResolvedValue({ ready: true });
  });

  it("returns null when no account is assigned, without touching the database", async () => {
    expect(
      await readMerchantCenterFeedState({
        businessId: "biz_1",
        providerAccountIds: [],
      }),
    ).toBeNull();
    expect(sqlTag).not.toHaveBeenCalled();
  });

  it("returns null — never an empty read — when the table is not there", async () => {
    assertDbSchemaReady.mockRejectedValue(new Error("schema not ready"));
    expect(
      await readMerchantCenterFeedState({
        businessId: "biz_1",
        providerAccountIds: ["4931182201"],
      }),
    ).toBeNull();
    expect(sqlTag).not.toHaveBeenCalled();
  });

  it("returns null when the query fails, rather than reporting zero issues", async () => {
    sqlTag.mockRejectedValue(new Error("connection reset"));
    expect(
      await readMerchantCenterFeedState({
        businessId: "biz_1",
        providerAccountIds: ["4931182201"],
      }),
    ).toBeNull();
  });

  it("returns null when nothing has ever been stored", async () => {
    sqlTag.mockResolvedValue([]);
    expect(
      await readMerchantCenterFeedState({
        businessId: "biz_1",
        providerAccountIds: ["4931182201"],
      }),
    ).toBeNull();
  });

  it("drops rows older than the max age and returns null when all of them are", async () => {
    const stale = new Date(
      NOW.getTime() - MERCHANT_CENTER_STATE_MAX_AGE_MS - 60_000,
    ).toISOString();
    sqlTag.mockResolvedValue([storedRow({ observed_at: stale })]);
    expect(
      await readMerchantCenterFeedState({
        businessId: "biz_1",
        providerAccountIds: ["4931182201"],
        now: NOW,
      }),
    ).toBeNull();
  });

  it("ages each row on its own timestamp, not on the freshest one", async () => {
    const stale = new Date(
      NOW.getTime() - MERCHANT_CENTER_STATE_MAX_AGE_MS - 60_000,
    ).toISOString();
    sqlTag.mockResolvedValue([
      storedRow(),
      storedRow({ item_id: "AT-105", observed_at: stale, feed_state: "disapproved" }),
    ]);

    const read = await readMerchantCenterFeedState({
      businessId: "biz_1",
      providerAccountIds: ["4931182201"],
      now: NOW,
    });

    expect([...read!.items.keys()]).toEqual(["AT-104"]);
    expect(read!.tallies.totalItemsInFeed).toBe(1);
    expect(read!.tallies.disapprovedItemCount).toBe(0);
  });

  it("re-derives the state from the stored status and issues", async () => {
    // The stored label says serving; the stored issues say the item is blocked.
    // The read is what an operator acts on, so the issues win.
    sqlTag.mockResolvedValue([
      storedRow({
        feed_state: "serving",
        raw_status: "ELIGIBLE",
        issues_json: [
          {
            code: "policy_violation",
            severity: "DISAPPROVED",
            attribute: null,
            description: "Policy violation",
          },
        ],
      }),
    ]);

    const read = await readMerchantCenterFeedState({
      businessId: "biz_1",
      providerAccountIds: ["4931182201"],
      now: NOW,
    });

    expect(read!.items.get("AT-104")!.state).toBe("disapproved");
    expect(read!.tallies.disapprovedItemCount).toBe(1);
  });

  it("parses a JSON-string issues column as well as a jsonb one", async () => {
    sqlTag.mockResolvedValue([
      storedRow({
        raw_status: "ELIGIBLE_LIMITED",
        issues_json: JSON.stringify([
          {
            code: "missing_gtin",
            severity: "DEMOTED",
            attribute: "gtin",
            description: "Missing GTIN",
          },
        ]),
      }),
    ]);

    const read = await readMerchantCenterFeedState({
      businessId: "biz_1",
      providerAccountIds: ["4931182201"],
      now: NOW,
    });

    expect(read!.items.get("AT-104")!.issues[0]!.description).toBe("Missing GTIN");
    expect(read!.tallies.limitedItemCount).toBe(1);
  });

  it("reports the newest observation and the Merchant Center accounts behind it", async () => {
    sqlTag.mockResolvedValue([
      storedRow({ observed_at: "2026-08-17T09:00:00.000Z" }),
      storedRow({
        item_id: "AT-105",
        merchant_center_id: "998877",
        observed_at: "2026-08-17T11:34:00.000Z",
      }),
    ]);

    const read = await readMerchantCenterFeedState({
      businessId: "biz_1",
      providerAccountIds: ["4931182201"],
      now: NOW,
    });

    expect(read!.observedAt).toBe("2026-08-17T11:34:00.000Z");
    expect(read!.merchantCenterIds).toEqual(["512233", "998877"]);
  });
});

describe("upsertMerchantCenterItemStates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlTag.mockResolvedValue([]);
  });

  it("writes nothing for an empty read", async () => {
    expect(
      await upsertMerchantCenterItemStates({
        businessId: "biz_1",
        providerAccountId: "4931182201",
        items: [],
      }),
    ).toEqual({ written: 0 });
    expect(sqlTag).not.toHaveBeenCalled();
  });

  it("stamps every row of one read with the same observation time", async () => {
    const observedAt = new Date("2026-08-17T11:34:00.000Z");
    await upsertMerchantCenterItemStates({
      businessId: "biz_1",
      providerAccountId: "4931182201",
      observedAt,
      items: [
        {
          itemId: "AT-104",
          merchantCenterId: "512233",
          title: "Aurora Tote — Sand",
          feedLabel: "US",
          languageCode: "en",
          channel: "ONLINE",
          availability: "IN_STOCK",
          rawStatus: "ELIGIBLE",
          state: "serving",
          issues: [],
        },
      ],
    });

    expect(sqlTag).toHaveBeenCalledTimes(1);
    const params = sqlTag.mock.calls[0]!.slice(1);
    expect(params).toContain(observedAt.toISOString());
  });
});

describe("upsertMerchantCenterItemStates — the jsonb payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlTag.mockResolvedValue([]);
  });

  /**
   * `jsonb_to_recordset` matches JSON keys to lower-cased SQL identifiers, so a
   * camelCase payload would silently produce a table of NULLs and a NOT NULL
   * violation on `feed_state`. This pins the serialization to the record
   * definition the statement declares.
   */
  it("serializes keys to the record definition's snake_case column names", async () => {
    await upsertMerchantCenterItemStates({
      businessId: "biz_1",
      providerAccountId: "4931182201",
      observedAt: new Date("2026-08-17T11:34:00.000Z"),
      items: [
        {
          itemId: "CW-310",
          merchantCenterId: "512233",
          title: "Canvas Weekender",
          feedLabel: "US",
          languageCode: "en",
          channel: "ONLINE",
          availability: "IN_STOCK",
          rawStatus: "ELIGIBLE_LIMITED",
          state: "limited",
          issues: [
            {
              code: "missing_gtin",
              severity: "DEMOTED",
              attribute: "gtin",
              description: "Missing GTIN",
            },
          ],
        },
      ],
    });

    const jsonParam = sqlTag.mock.calls[0]!
      .slice(1)
      .find((value): value is string => typeof value === "string" && value.startsWith("["));
    expect(JSON.parse(jsonParam!)).toEqual([
      {
        item_id: "CW-310",
        merchant_center_id: "512233",
        title: "Canvas Weekender",
        feed_label: "US",
        language_code: "en",
        channel: "ONLINE",
        availability: "IN_STOCK",
        raw_status: "ELIGIBLE_LIMITED",
        state: "limited",
        issues: [
          {
            code: "missing_gtin",
            severity: "DEMOTED",
            attribute: "gtin",
            description: "Missing GTIN",
          },
        ],
      },
    ]);
  });

  it("chunks a large read rather than issuing one unbounded statement", async () => {
    await upsertMerchantCenterItemStates({
      businessId: "biz_1",
      providerAccountId: "4931182201",
      items: Array.from({ length: 1001 }, (_, index) => ({
        itemId: `SKU-${index}`,
        merchantCenterId: "512233",
        title: null,
        feedLabel: null,
        languageCode: null,
        channel: null,
        availability: null,
        rawStatus: "ELIGIBLE",
        state: "serving" as const,
        issues: [],
      })),
    });

    expect(sqlTag).toHaveBeenCalledTimes(3);
  });
});
