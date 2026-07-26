import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Stop using my accounts" must always work.
 *
 * Revocation used to go through the same path as a new selection, so it failed
 * for the same reasons: a missing, disconnected or expired integration, a stale
 * discovery snapshot, a disabled assignment lane. Every one of those is a state
 * in which the user is MORE likely to want to revoke — a connection that broke,
 * a token that expired, an incident with the lanes off — and refusing left the
 * product syncing accounts the owner had asked it to stop touching.
 *
 * It is safe to exempt precisely because it can only reduce authority. These
 * tests hold that line in both directions: revocation succeeds where selection
 * is refused, and a NON-empty selection stays fail-closed under exactly the same
 * conditions.
 */

const requireBusinessAccess = vi.fn();
const isDemoBusiness = vi.fn();
const getIntegration = vi.fn();
const upsertProviderAccountAssignments = vi.fn();
const readProviderAccountSnapshot = vi.fn();
const revokeAllProviderAccountSelection = vi.fn();
const syncMetaInitial = vi.fn();
const providerFetch = vi.fn();

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/business-mode.server", () => ({ isDemoBusiness }));
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => async () => []),
  getDbWithTimeout: vi.fn(() => async () => []),
  runDbTransaction: vi.fn(async (run: () => Promise<unknown>) => run()),
}));
vi.mock("@/lib/integrations", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getIntegration };
});
vi.mock("@/lib/provider-account-assignments", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, upsertProviderAccountAssignments };
});
vi.mock("@/lib/provider-account-snapshots", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readProviderAccountSnapshot };
});
vi.mock("@/lib/provider-selection-revocation", () => ({
  revokeAllProviderAccountSelection,
}));
vi.mock("@/lib/sync/meta-sync", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, syncMetaInitial };
});
vi.mock("@/lib/db-schema-readiness", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDbSchemaReadiness: vi.fn().mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: new Date(0).toISOString(),
    }),
  };
});

const metaRoute = await import(
  "@/app/businesses/[businessId]/meta/assign-accounts/route"
);

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const params = Promise.resolve({ businessId: BUSINESS_ID });

function post(accountIds: string[]) {
  return new Request("https://example.test/businesses/x/assign-accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_ids: accountIds }),
  }) as never;
}

describe("empty selection is an authorized revocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
    isDemoBusiness.mockResolvedValue(false);
    vi.stubGlobal("fetch", providerFetch);
    revokeAllProviderAccountSelection.mockResolvedValue({
      businessId: BUSINESS_ID,
      provider: "meta",
      deselected: ["act_100", "act_200"],
      cancelledPartitions: 4,
      remainingSelected: [],
    });
    delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
    delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;
  });

  it.each([
    ["no integration at all", null],
    ["a disconnected integration", { status: "disconnected", access_token: null }],
    [
      "an expired credential",
      {
        id: "int-1",
        provider: "meta",
        status: "connected",
        access_token: "t",
        connected_at: "2026-01-01T00:00:00.000Z",
        provider_account_id: "act_100",
        token_expires_at: "2020-01-01T00:00:00.000Z",
      },
    ],
  ])("revokes with %s", async (_label, integration) => {
    getIntegration.mockResolvedValue(integration);
    // Snapshot deliberately absent: revocation must not need discovery either.
    readProviderAccountSnapshot.mockResolvedValue(null);

    const response = await metaRoute.POST(post([]), { params });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.revoked).toBe(true);
    expect(body.selectionSaved).toBe(true);
    expect(body.assigned_accounts).toEqual([]);
    expect(revokeAllProviderAccountSelection).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      provider: "meta",
    });
    // Zero provider calls, zero enqueue: revocation reduces authority and
    // starts nothing.
    expect(providerFetch).not.toHaveBeenCalled();
    expect(syncMetaInitial).not.toHaveBeenCalled();
    // And it does not go through the ordinary writer, which is behind the lane.
    expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
  });

  it("revokes with every sync lane disabled", async () => {
    // The lanes are off here — the cutover state — and revocation still works.
    getIntegration.mockResolvedValue(null);
    const response = await metaRoute.POST(post([]), { params });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { revoked?: boolean }).revoked).toBe(true);
  });

  it("still requires business authorization", async () => {
    // Revocation is exempt from the CONNECTION and LANE rules, not from tenant
    // access: deselecting another tenant's accounts is still an attack.
    requireBusinessAccess.mockResolvedValue({
      error: new Response(JSON.stringify({ error: "auth_error" }), { status: 403 }),
    });
    const response = await metaRoute.POST(post([]), { params });
    expect(response.status).toBe(403);
    expect(revokeAllProviderAccountSelection).not.toHaveBeenCalled();
  });

  it("reports what it deselected and what it cancelled", async () => {
    getIntegration.mockResolvedValue(null);
    const response = await metaRoute.POST(post([]), { params });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.deselectedAccounts).toEqual(["act_100", "act_200"]);
    expect(body.cancelledPartitions).toBe(4);
  });

  it("does not claim success when revocation itself fails", async () => {
    revokeAllProviderAccountSelection.mockRejectedValue(
      new Error("Revocation readback failed: 1 account(s) are still selected."),
    );
    getIntegration.mockResolvedValue(null);
    const response = await metaRoute.POST(post([]), { params });
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.selectionSaved).toBe(false);
  });

  it("keeps a NON-empty selection fail-closed under the same conditions", async () => {
    // The exemption is for reducing authority. Adding an account with a
    // disconnected integration must still refuse.
    getIntegration.mockResolvedValue({ status: "disconnected", access_token: null });
    const response = await metaRoute.POST(post(["act_100"]), { params });
    expect(response.status).toBe(409);
    expect(revokeAllProviderAccountSelection).not.toHaveBeenCalled();
    expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
  });
});
