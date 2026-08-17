import { describe, expect, it } from "vitest";

import {
  attachMerchantCenterState,
  deriveMerchantCenterFeedState,
  merchantCenterFeedStatusLabel,
  merchantCenterStateFromStatus,
  parseShoppingProductRow,
  summarizeMerchantCenterFeed,
  type MerchantCenterItemState,
} from "@/lib/google-ads/merchant-center-item-state";

function item(
  overrides: Partial<MerchantCenterItemState> = {},
): MerchantCenterItemState {
  return {
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
    ...overrides,
  };
}

describe("merchantCenterStateFromStatus", () => {
  it("maps the provider's three eligibility values and nothing else", () => {
    expect(merchantCenterStateFromStatus("ELIGIBLE")).toBe("serving");
    expect(merchantCenterStateFromStatus("ELIGIBLE_LIMITED")).toBe("limited");
    expect(merchantCenterStateFromStatus("NOT_ELIGIBLE")).toBe("disapproved");
  });

  it("never widens an absent or unrecognised status into serving", () => {
    expect(merchantCenterStateFromStatus(null)).toBe("unknown");
    expect(merchantCenterStateFromStatus("UNKNOWN")).toBe("unknown");
    expect(merchantCenterStateFromStatus("UNSPECIFIED")).toBe("unknown");
    expect(merchantCenterStateFromStatus("SOMETHING_NEW")).toBe("unknown");
  });
});

describe("deriveMerchantCenterFeedState", () => {
  it("takes the status when the issue list is empty", () => {
    expect(
      deriveMerchantCenterFeedState({ rawStatus: "ELIGIBLE", issues: [] }),
    ).toBe("serving");
    expect(
      deriveMerchantCenterFeedState({
        rawStatus: "ELIGIBLE_LIMITED",
        issues: [],
      }),
    ).toBe("limited");
  });

  it("lets a DISAPPROVED issue override an eligible status", () => {
    expect(
      deriveMerchantCenterFeedState({
        rawStatus: "ELIGIBLE",
        issues: [
          {
            code: "image_link_broken",
            severity: "DISAPPROVED",
            attribute: "image_link",
            description: "Invalid image",
          },
        ],
      }),
    ).toBe("disapproved");
  });

  it("demotes an eligible item that carries a DEMOTED issue", () => {
    expect(
      deriveMerchantCenterFeedState({
        rawStatus: "ELIGIBLE",
        issues: [
          {
            code: "missing_gtin",
            severity: "DEMOTED",
            attribute: "gtin",
            description: "Missing GTIN",
          },
        ],
      }),
    ).toBe("limited");
  });

  it("never promotes an unknown status just because no issue was returned", () => {
    expect(
      deriveMerchantCenterFeedState({ rawStatus: null, issues: [] }),
    ).toBe("unknown");
    expect(
      deriveMerchantCenterFeedState({ rawStatus: "UNKNOWN", issues: [] }),
    ).toBe("unknown");
  });

  it("never softens a disapproval because a milder issue is also present", () => {
    expect(
      deriveMerchantCenterFeedState({
        rawStatus: "NOT_ELIGIBLE",
        issues: [
          {
            code: "missing_gtin",
            severity: "DEMOTED",
            attribute: "gtin",
            description: "Missing GTIN",
          },
        ],
      }),
    ).toBe("disapproved");
  });
});

describe("parseShoppingProductRow", () => {
  it("reads a camelCase provider row end to end", () => {
    const parsed = parseShoppingProductRow({
      shoppingProduct: {
        merchantCenterId: "512233",
        itemId: "CW-310",
        title: "Canvas Weekender",
        feedLabel: "US",
        languageCode: "en",
        channel: "ONLINE",
        availability: "in_stock",
        status: "ELIGIBLE_LIMITED",
        issues: [
          {
            errorCode: "missing_gtin",
            adsSeverity: "DEMOTED",
            attributeName: "gtin",
            description: "Missing GTIN",
          },
        ],
      },
    });
    expect(parsed).toEqual({
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
    });
  });

  it("reads the snake_case shape the REST transport can also return", () => {
    const parsed = parseShoppingProductRow({
      shopping_product: {
        merchant_center_id: "512233",
        item_id: "AT-105",
        status: "NOT_ELIGIBLE",
        issues: [{ error_code: "policy_violation", ads_severity: "DISAPPROVED" }],
      },
    });
    expect(parsed?.itemId).toBe("AT-105");
    expect(parsed?.state).toBe("disapproved");
  });

  it("refuses a row with no item id rather than storing a state with no subject", () => {
    expect(
      parseShoppingProductRow({ shoppingProduct: { status: "ELIGIBLE" } }),
    ).toBeNull();
    expect(parseShoppingProductRow({})).toBeNull();
  });

  it("keeps an item whose status the provider did not supply, as unknown", () => {
    const parsed = parseShoppingProductRow({
      shoppingProduct: { itemId: "TK-201" },
    });
    expect(parsed?.state).toBe("unknown");
    expect(parsed?.rawStatus).toBeNull();
  });
});

describe("summarizeMerchantCenterFeed", () => {
  it("counts each state separately and never folds unknown into serving", () => {
    expect(
      summarizeMerchantCenterFeed([
        item(),
        item({ itemId: "b", state: "limited" }),
        item({ itemId: "c", state: "disapproved" }),
        item({ itemId: "d", state: "disapproved" }),
        item({ itemId: "e", state: "unknown" }),
      ]),
    ).toEqual({
      totalItemsInFeed: 5,
      servingItemCount: 1,
      limitedItemCount: 1,
      disapprovedItemCount: 2,
      unknownItemCount: 1,
    });
  });
});

describe("merchantCenterFeedStatusLabel", () => {
  it("prints the state for serving and disapproved items", () => {
    expect(merchantCenterFeedStatusLabel(item())).toBe("Serving");
    expect(
      merchantCenterFeedStatusLabel(item({ state: "disapproved" })),
    ).toBe("Disapproved");
  });

  it("prints the provider's own reason for a limited item", () => {
    expect(
      merchantCenterFeedStatusLabel(
        item({
          state: "limited",
          issues: [
            {
              code: "missing_gtin",
              severity: "DEMOTED",
              attribute: "gtin",
              description: "Missing GTIN",
            },
          ],
        }),
      ),
    ).toBe("Missing GTIN");
  });

  it("falls back to the state when the provider's reason would break the chip", () => {
    expect(
      merchantCenterFeedStatusLabel(
        item({
          state: "limited",
          issues: [
            {
              code: "generic",
              severity: "DEMOTED",
              attribute: null,
              description:
                "This item is limited because several attributes disagree with the landing page",
            },
          ],
        }),
      ),
    ).toBe("Limited");
  });

  it("has no label at all for an unknown item, so the caller can dash it", () => {
    expect(merchantCenterFeedStatusLabel(item({ state: "unknown" }))).toBeNull();
  });
});

describe("attachMerchantCenterState", () => {
  const rows = [
    { itemId: "AT-104", title: "Aurora Tote — Sand", spend: 3180 },
    { itemId: "CW-310", title: "Canvas Weekender", spend: 2410 },
    { productItemId: "TK-201", title: "Travel Kit — Slate", spend: 2910 },
  ];

  it("returns rows untouched when no Merchant Center read exists", () => {
    expect(attachMerchantCenterState(rows, null)).toEqual(rows);
    expect(attachMerchantCenterState(rows, new Map())).toEqual(rows);
  });

  it("leaves an unmatched row without any feed key at all", () => {
    const attached = attachMerchantCenterState(
      rows,
      new Map([["AT-104", item()]]),
    );
    expect(attached[0]).toMatchObject({ feedState: "serving" });
    // Not `feedState: "unknown"` — the key is simply absent.
    expect("feedState" in attached[1]!).toBe(false);
    expect("merchantCenterId" in attached[1]!).toBe(false);
  });

  it("joins on the shopping report's alternative item-id key", () => {
    const attached = attachMerchantCenterState(
      rows,
      new Map([["TK-201", item({ itemId: "TK-201", state: "disapproved" })]]),
    );
    expect(attached[2]).toMatchObject({ feedState: "disapproved" });
  });

  it("carries the provider's own label and linkage onto the row", () => {
    const attached = attachMerchantCenterState(
      [{ itemId: "CW-310" }],
      new Map([
        [
          "CW-310",
          item({
            itemId: "CW-310",
            state: "limited",
            availability: "OUT_OF_STOCK",
            issues: [
              {
                code: "missing_gtin",
                severity: "DEMOTED",
                attribute: "gtin",
                description: "Missing GTIN",
              },
            ],
          }),
        ],
      ]),
    );
    expect(attached[0]).toMatchObject({
      feedState: "limited",
      feedStatusLabel: "Missing GTIN",
      feedAvailability: "OUT_OF_STOCK",
      merchantCenterId: "512233",
    });
  });

  it("never mutates the rows it was handed", () => {
    const original = [{ itemId: "AT-104" }];
    attachMerchantCenterState(original, new Map([["AT-104", item()]]));
    expect(original[0]).toEqual({ itemId: "AT-104" });
  });
});
