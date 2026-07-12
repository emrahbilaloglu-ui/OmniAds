import { describe, expect, it } from "vitest";
import {
  decodeMetaHistoryCursor,
  encodeMetaHistoryCursor,
  MetaHistoryQueryError,
  parseMetaHistoryQuery,
} from "@/lib/meta/history-contract";

describe("Meta History contract", () => {
  it("requires explicit business and provider-account scope and parses every filter", () => {
    const query = parseMetaHistoryQuery(
      new URLSearchParams({
        businessId: "business_1",
        providerAccountId: "act_123",
        kind: "outcomes",
        entity: "creative",
        label: "scale",
        from: "2026-07-01",
        to: "2026-07-10",
        q: "summer hook",
        limit: "25",
      }),
    );

    expect(query).toMatchObject({
      businessId: "business_1",
      providerAccountId: "act_123",
      kind: "outcomes",
      entity: "creative",
      label: "scale",
      from: "2026-07-01",
      to: "2026-07-10",
      q: "summer hook",
      limit: 25,
      cursor: null,
    });
  });

  it.each([
    [{ providerAccountId: "act_1" }, "missing_business_id"],
    [{ businessId: "business_1" }, "missing_provider_account_id"],
    [
      {
        businessId: "business_1",
        providerAccountId: "act_1",
        from: "2026-07-11",
        to: "2026-07-10",
      },
      "invalid_date_range",
    ],
    [
      { businessId: "business_1", providerAccountId: "act_1", kind: "executions" },
      "invalid_kind",
    ],
  ])("rejects invalid query scope or filters", (input, code) => {
    expect(() => parseMetaHistoryQuery(new URLSearchParams(input))).toThrowError(
      expect.objectContaining<Partial<MetaHistoryQueryError>>({ code }),
    );
  });

  it("round-trips an opaque deterministic cursor", () => {
    const cursor = {
      occurredAt: "2026-07-10T08:30:00.000Z",
      source: "meta_ads_action_log" as const,
      sourceId: "log_123",
    };
    const encoded = encodeMetaHistoryCursor(cursor);

    expect(encoded).not.toContain("2026-07-10");
    expect(decodeMetaHistoryCursor(encoded)).toEqual(cursor);
    expect(
      parseMetaHistoryQuery(
        new URLSearchParams({
          businessId: "business_1",
          providerAccountId: "act_1",
          cursor: encoded,
        }),
      ).cursor,
    ).toEqual(cursor);
  });

  it("rejects malformed cursors rather than restarting pagination", () => {
    expect(() => decodeMetaHistoryCursor("not-a-cursor")).toThrowError(
      expect.objectContaining<Partial<MetaHistoryQueryError>>({ code: "invalid_cursor" }),
    );
  });
});
