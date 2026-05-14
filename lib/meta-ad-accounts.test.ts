import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMetaAdAccounts } from "@/lib/meta-ad-accounts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchMetaAdAccounts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges direct, business-owned, and business-client Meta ad accounts", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/v25.0/me/adaccounts") {
        return jsonResponse({
          data: [
            {
              id: "act_direct",
              name: "Direct Account",
              currency: "USD",
              timezone_name: "America/New_York",
              account_status: 1,
            },
          ],
        });
      }
      if (url.pathname === "/v25.0/me/businesses") {
        return jsonResponse({ data: [{ id: "biz_1", name: "Business 1" }] });
      }
      if (url.pathname === "/v25.0/biz_1/owned_ad_accounts") {
        return jsonResponse({
          data: [
            {
              id: "1054905059780305",
              name: "Emolos LTD.",
              currency: "TRY",
              timezone_name: "Europe/Istanbul",
              account_status: 1,
            },
            {
              id: "act_direct",
              name: "Direct Account Duplicate",
              account_status: 1,
            },
          ],
        });
      }
      if (url.pathname === "/v25.0/biz_1/client_ad_accounts") {
        return jsonResponse({
          data: [
            {
              id: "act_client",
              name: "Client Account",
              account_status: 1,
            },
          ],
        });
      }
      return jsonResponse({ error: { message: "unexpected path" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchMetaAdAccounts("token");

    expect(result.ok).toBe(true);
    expect(result.normalized.map((account) => account.id)).toEqual([
      "act_direct",
      "act_1054905059780305",
      "act_client",
    ]);
    expect(result.normalized[1]).toMatchObject({
      name: "Emolos LTD.",
      source: "business_owned",
      business_id: "biz_1",
      business_name: "Business 1",
    });
    expect(result.businessDiscovery).toMatchObject({
      ok: true,
      businessCount: 1,
      accountCount: 2,
    });
  });

  it("keeps direct ad accounts in the payload but marks refresh degraded when business discovery is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v25.0/me/adaccounts") {
          return jsonResponse({
            data: [{ id: "act_direct", name: "Direct Account" }],
          });
        }
        if (url.pathname === "/v25.0/me/businesses") {
          return jsonResponse({ error: { message: "Missing business permission" } }, 403);
        }
        return jsonResponse({ data: [] });
      }),
    );

    const result = await fetchMetaAdAccounts("token");

    expect(result.ok).toBe(false);
    expect(result.normalized.map((account) => account.id)).toEqual(["act_direct"]);
    expect(result.body?.error?.message).toContain("Missing business permission");
    expect(result.businessDiscovery?.ok).toBe(false);
    expect(result.businessDiscovery?.errors[0]?.message).toBe("Missing business permission");
  });

  it("fails the refresh when only business discovery can find accounts and it is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v25.0/me/adaccounts") {
          return jsonResponse({ data: [] });
        }
        if (url.pathname === "/v25.0/me/businesses") {
          return jsonResponse({ error: { message: "Business discovery unavailable" } }, 503);
        }
        return jsonResponse({ data: [] });
      }),
    );

    const result = await fetchMetaAdAccounts("token");

    expect(result.ok).toBe(false);
    expect(result.normalized).toEqual([]);
    expect(result.body?.error?.message).toContain("Business discovery unavailable");
    expect(result.businessDiscovery?.errors[0]?.edge).toBe("me/businesses");
  });

  it("fails the refresh when a business account edge returns a partial error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v25.0/me/adaccounts") {
          return jsonResponse({ data: [] });
        }
        if (url.pathname === "/v25.0/me/businesses") {
          return jsonResponse({ data: [{ id: "biz_1", name: "Business 1" }] });
        }
        if (url.pathname === "/v25.0/biz_1/owned_ad_accounts") {
          return jsonResponse({
            data: [{ id: "act_owned", name: "Owned Account" }],
          });
        }
        if (url.pathname === "/v25.0/biz_1/client_ad_accounts") {
          return jsonResponse({ error: { message: "Client edge failed" } }, 500);
        }
        return jsonResponse({ data: [] });
      }),
    );

    const result = await fetchMetaAdAccounts("token");

    expect(result.ok).toBe(false);
    expect(result.normalized.map((account) => account.id)).toEqual(["act_owned"]);
    expect(result.body?.error?.message).toContain("Client edge failed");
    expect(result.businessDiscovery?.errors[0]).toMatchObject({
      businessId: "biz_1",
      edge: "client_ad_accounts",
    });
  });

  it("marks paginated Meta edge failures as failed instead of returning a partial success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v25.0/me/adaccounts" && url.searchParams.get("page") !== "2") {
          return jsonResponse({
            data: [{ id: "act_direct", name: "Direct Account" }],
            paging: {
              next: "https://graph.facebook.com/v25.0/me/adaccounts?page=2",
            },
          });
        }
        if (url.pathname === "/v25.0/me/adaccounts" && url.searchParams.get("page") === "2") {
          return jsonResponse({ error: { message: "Next page failed" } }, 500);
        }
        return jsonResponse({ data: [] });
      }),
    );

    const result = await fetchMetaAdAccounts("token");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.body?.error?.message).toBe("Next page failed");
    expect(result.normalized.map((account) => account.id)).toEqual(["act_direct"]);
  });

  it("marks capped Meta pagination as failed instead of returning a truncated success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const page = Number(url.searchParams.get("page") ?? "1");
        if (url.pathname === "/v25.0/me/adaccounts" && page <= 50) {
          return jsonResponse({
            data: [{ id: `act_page_${page}`, name: `Page ${page}` }],
            paging: {
              next: `https://graph.facebook.com/v25.0/me/adaccounts?page=${page + 1}`,
            },
          });
        }
        return jsonResponse({ data: [] });
      }),
    );

    const result = await fetchMetaAdAccounts("token");

    expect(result.ok).toBe(false);
    expect(result.normalized).toHaveLength(50);
    expect(result.body?.error?.message).toBe(
      "Meta Graph pagination exceeded 50 pages before completion.",
    );
  });

  it("preserves the direct Meta API failure contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "Bad token" } }, 401)),
    );

    const result = await fetchMetaAdAccounts("token");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.body?.error?.message).toBe("Bad token");
    expect(result.normalized).toEqual([]);
  });
});
