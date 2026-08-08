import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";

const requireBusinessAccess = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const getDbSchemaReadiness = vi.hoisted(() => vi.fn());

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ query }) }));
vi.mock("@/lib/db-schema-readiness", () => ({ getDbSchemaReadiness }));

import { POST } from "@/app/api/meta/decision-action/preflight/route";

function request(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof POST>[0];
}

const validBody = {
  businessId: "biz-1",
  providerAccountId: "act_1",
  entityType: "ad" as const,
  entityId: "ad-1",
  expectedStatus: "ACTIVE",
};

describe("preflight route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireBusinessAccess.mockResolvedValue({ session: { user: { id: "user-1" } } });
    getDbSchemaReadiness.mockResolvedValue({ ready: true });
    query.mockResolvedValue([
      {
        ad_id: "ad-1",
        provider_account_id: "act_1",
        ad_status: "ACTIVE",
        creative_id: "cr-1",
        adset_id: "adset-1",
        match_count: "1",
      },
    ]);
  });

  it("verifies a target that still matches", async () => {
    const body = await (await POST(request(validBody))).json();
    expect(body.receipt.verdict).toBe("ready");
    expect(body.receipt.providerContacted).toBe(false);
  });

  it("reports drift instead of proceeding", async () => {
    query.mockResolvedValue([
      {
        ad_id: "ad-1",
        provider_account_id: "act_1",
        ad_status: "PAUSED",
        creative_id: "cr-1",
        adset_id: "adset-1",
        match_count: "1",
      },
    ]);
    const body = await (await POST(request(validBody))).json();
    expect(body.receipt.verdict).toBe("drifted");
  });

  it("refuses an ambiguous identity", async () => {
    query.mockResolvedValue([
      { ad_id: "ad-1", provider_account_id: "act_1", ad_status: "ACTIVE", creative_id: "cr-1", adset_id: "adset-1", match_count: "2" },
      { ad_id: "ad-1", provider_account_id: "act_2", ad_status: "ACTIVE", creative_id: "cr-1", adset_id: "adset-1", match_count: "2" },
    ]);
    const body = await (await POST(request(validBody))).json();
    expect(body.receipt.verdict).toBe("ambiguous");
  });

  it("honours an engaged kill switch above everything else", async () => {
    const body = await (
      await POST(request({ ...validBody, killSwitchEngaged: true }))
    ).json();
    expect(body.receipt.verdict).toBe("blocked");
  });

  it("requires write access even though it writes nothing", async () => {
    await POST(request(validBody));
    expect(requireBusinessAccess.mock.calls[0][0].minRole).toBe("collaborator");
  });

  it("rejects a malformed target rather than guessing one", async () => {
    expect((await POST(request({ businessId: "biz-1" }))).status).toBe(400);
    expect(
      (await POST(request({ ...validBody, entityType: "campaign" }))).status,
    ).toBe(400);
  });

  it("says plainly that no execution path exists", async () => {
    const body = await (await POST(request(validBody))).json();
    expect(body.executionAvailable).toBe(false);
    expect(body.executionNote).toContain("no provider execution path");
  });
});

describe("the route has no way to reach a provider", () => {
  const source = readFileSync(
    "app/api/meta/decision-action/preflight/route.ts",
    "utf8",
  );

  it("contains no provider client, fetch, or write helper", () => {
    expect(source).not.toContain("fetch(");
    expect(source).not.toMatch(/graph\.facebook\.com/);
    expect(source).not.toContain("ads-write");
    expect(source).not.toContain("resolveMetaCredentials");
  });

  it("exposes only a POST that returns a receipt", () => {
    expect(source).toContain("export async function POST");
    expect(source).not.toContain("export async function PUT");
    expect(source).not.toContain("export async function DELETE");
  });

  it("only reads persisted dimensions", () => {
    expect(source).toContain("FROM meta_ad_dimensions");
    expect(source).not.toContain("INSERT INTO");
    expect(source).not.toContain("UPDATE ");
  });
});
