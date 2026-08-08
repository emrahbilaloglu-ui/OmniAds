import { describe, expect, it, vi, beforeEach } from "vitest";

const getSessionFromRequest = vi.hoisted(() => vi.fn());
const listUserBusinesses = vi.hoisted(() => vi.fn());
const findEntitySearchCandidates = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ getSessionFromRequest }));
vi.mock("@/lib/access", () => ({ listUserBusinesses }));
vi.mock("@/lib/entity-search-store", () => ({ findEntitySearchCandidates }));

import { GET } from "@/app/api/search/route";

function request(search: string) {
  return { nextUrl: { searchParams: new URLSearchParams(search) } } as unknown as Parameters<
    typeof GET
  >[0];
}

describe("GET /api/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionFromRequest.mockResolvedValue({ user: { id: "user-1" } });
    listUserBusinesses.mockResolvedValue([
      { id: "biz-1", name: "Grandmix", membershipStatus: "active" },
    ]);
    findEntitySearchCandidates.mockResolvedValue([
      {
        entityType: "campaign",
        entityId: "23849",
        name: "Grandmix Prospecting",
        businessId: "biz-1",
        providerAccountId: "act_1",
        status: "ACTIVE",
      },
    ]);
  });

  it("refuses an unauthenticated caller", async () => {
    getSessionFromRequest.mockResolvedValue(null);
    expect((await GET(request("q=grandmix"))).status).toBe(401);
  });

  it("finds a campaign by name and returns a scoped deep link", async () => {
    const body = await (await GET(request("q=prospecting"))).json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].entityId).toBe("23849");
    expect(body.results[0].href).toContain("businessId=biz-1");
    expect(body.results[0].href).toContain("providerAccountId=act_1");
    expect(body.results[0].businessName).toBe("Grandmix");
  });

  it("only searches businesses the caller is entitled to", async () => {
    listUserBusinesses.mockResolvedValue([
      { id: "biz-1", name: "Grandmix", membershipStatus: "active" },
      { id: "biz-2", name: "Other", membershipStatus: "invited" },
    ]);
    await GET(request("q=grandmix"));
    expect(findEntitySearchCandidates.mock.calls[0][0].businessIds).toEqual(["biz-1"]);
  });

  it("does not run a query that is too short to be meaningful", async () => {
    const body = await (await GET(request("q=g"))).json();
    expect(body.results).toEqual([]);
    expect(body.reason).toBe("query_too_short");
    expect(findEntitySearchCandidates).not.toHaveBeenCalled();
  });

  it("reports a failed search as a failure, not as no matches", async () => {
    findEntitySearchCandidates.mockRejectedValue(new Error("index unavailable"));
    const response = await GET(request("q=grandmix"));
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.error).toBe("search_unavailable");
    expect(body.results).toBeUndefined();
  });

  it("includes the caller's own businesses as results", async () => {
    const body = await (await GET(request("q=grandmix"))).json();
    expect(body.results.some((r: { entityType: string }) => r.entityType === "business")).toBe(true);
  });

  it("returns an explicit empty result when the caller has no scope", async () => {
    listUserBusinesses.mockResolvedValue([]);
    const body = await (await GET(request("q=grandmix"))).json();
    expect(body.results).toEqual([]);
    expect(body.reason).toBe("no_scope");
    expect(findEntitySearchCandidates).not.toHaveBeenCalled();
  });
});
