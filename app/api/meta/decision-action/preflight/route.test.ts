import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";

const requireBusinessAccess = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const getDbSchemaReadiness = vi.hoisted(() => vi.fn());
const fetchAssignedAccountIds = vi.hoisted(() => vi.fn(async () => ["act_1"]));
const getMetaAccountContext = vi.hoisted(() =>
  vi.fn(async () => ({ accountProfiles: { act_1: { currency: "USD" } } })),
);

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ query }) }));
vi.mock("@/lib/db-schema-readiness", () => ({ getDbSchemaReadiness }));
vi.mock("@/lib/meta/creatives-fetchers", () => ({ fetchAssignedAccountIds }));
vi.mock("@/lib/meta/account-context", () => ({
  getMetaAccountContext,
  normalizeMetaCurrencyCode: (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null,
}));

/*
 * The fail-closed demo authority's DB read, stubbed.
 *
 * The GUARD is the code under test — its statuses, its codes and its position
 * in the precedence — so only the read it delegates to is replaced. `getDb()`
 * throws with no DATABASE_URL under vitest, which is why the read has to be
 * mocked rather than the guard.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(async () => "live"),
}));

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
    requireBusinessAccess.mockResolvedValue({ membership: { businessId: "biz-1" }, session: { user: { id: "user-1" } } });
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


/**
 * The decision-bound contract.
 *
 * The caller sends a served decision key and an allowlisted action — nothing
 * else. Everything the write would be aimed at is derived here.
 */
describe("decision-bound preflight", () => {
  function bound(overrides: Record<string, unknown> = {}) {
    return request({
      contract: "zero-base.decision.v1",
      businessId: "biz-1",
      decisionKey: "ad:ad-1",
      action: "pause",
      ...overrides,
    });
  }

  function warehouseRow(overrides: Record<string, unknown> = {}) {
    return [
      {
        entity_id: "ad-1",
        provider_account_id: "act_1",
        status: "ACTIVE",
        creative_id: "cr-1",
        parent_id: "adset-1",
        match_count: "1",
        ...overrides,
      },
    ];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    requireBusinessAccess.mockResolvedValue({ membership: { businessId: "biz-1" }, session: { user: { id: "user-1" } } });
    getDbSchemaReadiness.mockResolvedValue({ ready: true });
    fetchAssignedAccountIds.mockResolvedValue(["act_1"]);
    getMetaAccountContext.mockResolvedValue({ accountProfiles: { act_1: { currency: "USD" } } });
    query.mockResolvedValue(warehouseRow());
  });

  it("derives the target from the warehouse, not from the request", async () => {
    const body = await (await POST(bound())).json();
    expect(body.target).toMatchObject({
      grain: "ad",
      entityId: "ad-1",
      providerAccountId: "act_1",
      status: "ACTIVE",
    });
    // The expected state came from the row the server just read.
    expect(body.receipt.target.expectedStatus).toBe("ACTIVE");
    expect(body.receipt.providerContacted).toBe(false);
    expect(body.providerContacted).toBe(false);
  });

  it("names the typed endpoint for the grain and action", async () => {
    expect((await (await POST(bound())).json()).endpoint).toBe("/api/meta/ads/[adId]/pause");
    expect(
      (await (await POST(bound({ decisionKey: "campaign:c-1", action: "resume" }))).json()).endpoint,
    ).toBe("/api/meta/campaigns/[campaignId]/resume");
    expect(
      (await (await POST(bound({ decisionKey: "adset:as-1", action: "bid" }))).json()).endpoint,
    ).toBe("/api/meta/adsets/[adsetId]/apply-bid");
  });

  it("issues the exact body the real handler requires, not a generic one", async () => {
    const body = await (await POST(bound())).json();
    expect(body.dispatch.path).toBe("/api/meta/ads/ad-1/pause");
    expect(body.dispatch.body).toEqual({
      actionOrigin: "manual_operator_v1",
      manualConfirmation: "explicit_operator_confirmation",
      businessId: "biz-1",
      providerAccountId: "act_1",
      adId: "ad-1",
      creativeId: "cr-1",
    });
  });

  it("asks the operator for a bid amount in the account's own currency", async () => {
    getMetaAccountContext.mockResolvedValue({ accountProfiles: { act_1: { currency: "try" } } });
    const body = await (
      await POST(bound({ decisionKey: "adset:as-1", action: "bid" }))
    ).json();
    expect(body.dispatch.operatorFields[0]).toMatchObject({
      name: "bidAmountMinor",
      currency: "TRY",
    });
  });

  it("withholds a bid when the account currency cannot be verified", async () => {
    getMetaAccountContext.mockRejectedValue(new Error("account context unavailable"));
    const body = await (
      await POST(bound({ decisionKey: "adset:as-1", action: "bid" }))
    ).json();
    // The handler refuses without a verified currency, so the control is
    // withheld with a reason instead of offered as a guaranteed failure.
    expect(body.withheld.reason).toBe("account_currency_unavailable");
    expect(body.dispatch).toBeUndefined();
  });

  it("withholds an ad action when the creative identity was never recorded", async () => {
    query.mockResolvedValue(warehouseRow({ creative_id: null }));
    const body = await (await POST(bound())).json();
    expect(body.withheld.reason).toBe("creative_identity_unavailable");
    expect(body.dispatch).toBeUndefined();
  });

  it("withholds a duplicate when the source ad's parent ad set is unknown", async () => {
    query.mockResolvedValue(warehouseRow({ parent_id: null }));
    const body = await (await POST(bound({ action: "duplicate" }))).json();
    expect(body.withheld.reason).toBe("parent_adset_unknown");
  });

  it("resolves all three grains from their own dimension tables", async () => {
    for (const [key, table] of [
      ["campaign:c-1", "meta_campaign_dimensions"],
      ["adset:as-1", "meta_adset_dimensions"],
      ["ad:ad-1", "meta_ad_dimensions"],
    ] as const) {
      query.mockClear();
      query.mockResolvedValue(warehouseRow({ entity_id: key.split(":")[1] }));
      const response = await POST(bound({ decisionKey: key, action: "pause" }));
      expect(response.status, key).toBe(200);
      // The warehouse read, not the instrumentation write that follows it.
      const read = query.mock.calls.find((call) => String(call[0]).includes("FROM meta_"));
      expect(String(read?.[0]), key).toContain(table);
    }
  });

  it("refuses any attempt to name the target or its expected state", async () => {
    for (const field of [
      "providerAccountId",
      "entityId",
      "entityType",
      "expectedStatus",
      "expectedCreativeId",
      "expectedParentId",
    ]) {
      const response = await POST(bound({ [field]: "anything" }));
      const body = await response.json();
      expect(response.status, field).toBe(400);
      expect(body.error).toBe("client_target_rejected");
      expect(body.rejected).toContain(field);
    }
    // Refused before any read, so an override can never be probed.
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses an explicit null override too, rather than treating it as absent", async () => {
    const response = await POST(bound({ expectedStatus: null }));
    expect(response.status).toBe(400);
  });

  it("authorizes the business before touching the warehouse", async () => {
    requireBusinessAccess.mockResolvedValue({ error: new Response(null, { status: 403 }) });
    await POST(bound());
    expect(query).not.toHaveBeenCalled();
  });

  it("requires write access, so a viewer cannot probe write readiness", async () => {
    await POST(bound());
    expect(requireBusinessAccess.mock.calls[0][0].minRole).toBe("collaborator");
  });

  it("refuses a decision key that names no single entity", async () => {
    for (const key of ["group:abc", "inactive:ad:1", "structure-7", "campaign:unknown:x", "ad:"]) {
      const response = await POST(bound({ decisionKey: key }));
      expect(response.status, key).toBe(422);
      expect((await response.json()).error).toBe("decision_not_actionable");
    }
  });

  it("refuses an action with no endpoint at that grain", async () => {
    const response = await POST(bound({ decisionKey: "campaign:c-1", action: "duplicate" }));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("unsupported_action");
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a decision that is not in this business", async () => {
    query.mockResolvedValue([]);
    const response = await POST(bound());
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("decision_not_in_served_universe");
  });

  it("scopes the warehouse read to the authorized business", async () => {
    await POST(bound());
    expect(query.mock.calls[0][1]).toEqual(["biz-1", "ad-1"]);
  });

  it("refuses when the account behind the decision is not assigned", async () => {
    fetchAssignedAccountIds.mockResolvedValue(["act_other"]);
    const response = await POST(bound());
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("provider_account_not_assigned");
  });

  it("refuses when assignments cannot be read, rather than assuming assigned", async () => {
    fetchAssignedAccountIds.mockRejectedValue(new Error("down"));
    expect((await POST(bound())).status).toBe(403);
  });

  it("refuses an ambiguous identity instead of picking the newest row", async () => {
    query.mockResolvedValue([
      ...warehouseRow({ match_count: "2" }),
      ...warehouseRow({ provider_account_id: "act_2", match_count: "2" }),
    ]);
    const response = await POST(bound());
    // Picking one would be a guess, and the guess would be a provider write.
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("target_ambiguous");
  });

  it("refuses when the warehouse table is not present", async () => {
    getDbSchemaReadiness.mockResolvedValue({ ready: false });
    expect((await POST(bound())).status).toBe(503);
  });

  it("reports the mutation flag as off, because it is set nowhere", async () => {
    expect((await (await POST(bound())).json()).mutationUiEnabled).toBe(false);
  });

  it("requires a decision key and an action", async () => {
    expect((await POST(bound({ decisionKey: undefined }))).status).toBe(400);
    expect((await POST(bound({ action: undefined }))).status).toBe(400);
  });
});

describe("legacy preflight is untouched by the new modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireBusinessAccess.mockResolvedValue({ membership: { businessId: "biz-1" }, session: { user: { id: "user-1" } } });
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

  it("still honours a legacy caller's own expected state", async () => {
    const body = await (await POST(request(validBody))).json();
    // The legacy contract passes expectedStatus through; only the canonical
    // modes derive it. Changing that would break every existing caller.
    expect(body.receipt.target.expectedStatus).toBe("ACTIVE");
    expect(body.executionAvailable).toBe(false);
  });

  it("keeps the legacy response keys exactly as they were", async () => {
    const body = await (await POST(request(validBody))).json();
    expect(Object.keys(body).sort()).toEqual([
      "executionAvailable",
      "executionEnabledFlag",
      "executionNote",
      "receipt",
    ]);
  });
});
