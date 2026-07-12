import { describe, expect, it, vi } from "vitest";
import {
  fetchMetaHistoryAccounts,
  fetchMetaHistoryPage,
} from "@/lib/meta/history-client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Meta History client", () => {
  it("loads assigned accounts with GET only", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        accounts: [{ id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" }],
      }),
    );

    await expect(
      fetchMetaHistoryAccounts({ businessId: "business_1", fetchImpl }),
    ).resolves.toEqual([
      { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    ]);

    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/meta/history/accounts?businessId=business_1",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("sends explicit scope, filters, and cursor without any POST", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        mode: "read_only",
        scope: {
          businessId: "business_1",
          providerAccountId: "act_1",
          providerAccountName: "Primary",
          currency: "EUR",
          timezone: "UTC",
        },
        filters: {},
        entries: [],
        page: { limit: 40, nextCursor: null },
        identityContract: {
          canonicalDecisionIdAvailable: false,
          grouping: "persisted_source_rows",
          limitation: "unavailable",
        },
        limitations: [],
      }),
    );

    await fetchMetaHistoryPage({
      businessId: "business_1",
      providerAccountId: "act_1",
      filters: {
        kind: "writes",
        entity: "ad",
        label: "cut",
        from: "2026-07-01",
        to: "2026-07-10",
        q: "ad 42",
      },
      cursor: "opaque-cursor",
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("businessId=business_1");
    expect(String(url)).toContain("providerAccountId=act_1");
    expect(String(url)).toContain("kind=writes");
    expect(String(url)).toContain("entity=ad");
    expect(String(url)).toContain("cursor=opaque-cursor");
    expect(init).toEqual(expect.objectContaining({ method: "GET" }));
    expect(JSON.stringify(init)).not.toContain("POST");
  });
});
