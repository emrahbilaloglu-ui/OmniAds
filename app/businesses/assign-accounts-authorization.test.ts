import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cross-tenant authorization for account selection.
 *
 * Both assign-accounts routes read a business UUID out of the path and acted on
 * it. `proxy.ts` proves only that some session cookie exists; it never binds
 * that session to the business being addressed. Any authenticated user who knew
 * or guessed another tenant's business id could therefore rewrite that tenant's
 * selected accounts — and, on the Meta side, start an initial sync against them.
 *
 * The mocks below make every side effect loud: the database, the provider
 * account snapshot, the assignment writer and the sync enqueue all throw if they
 * are reached. A refusal that touched any of them would fail here even if the
 * status code looked right.
 */

const requireBusinessAccess = vi.fn();
const isDemoBusiness = vi.fn();
const getIntegration = vi.fn();
const upsertProviderAccountAssignments = vi.fn();
const readProviderAccountSnapshot = vi.fn();
const syncMetaInitial = vi.fn();
const enqueueGoogleAdsScheduledWork = vi.fn();

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => {
    throw new Error("no database access before authorization");
  }),
  getDbWithTimeout: vi.fn(() => {
    throw new Error("no database access before authorization");
  }),
}));

vi.mock("@/lib/business-mode.server", () => ({ isDemoBusiness }));
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
vi.mock("@/lib/sync/meta-sync", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, syncMetaInitial };
});
vi.mock("@/lib/sync/google-ads-sync", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, enqueueGoogleAdsScheduledWork };
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
const googleRoute = await import(
  "@/app/businesses/[businessId]/google/assign-accounts/route"
);

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function post(body: unknown) {
  return new Request("https://example.test/businesses/x/assign-accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

const params = Promise.resolve({ businessId: BUSINESS_ID });

function denyWith(status: number) {
  requireBusinessAccess.mockResolvedValue({
    error: new Response(JSON.stringify({ error: "auth_error" }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  });
}

function expectNoSideEffects() {
  expect(isDemoBusiness).not.toHaveBeenCalled();
  expect(getIntegration).not.toHaveBeenCalled();
  expect(readProviderAccountSnapshot).not.toHaveBeenCalled();
  expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
  expect(syncMetaInitial).not.toHaveBeenCalled();
  expect(enqueueGoogleAdsScheduledWork).not.toHaveBeenCalled();
}

describe("assign-accounts cross-tenant authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe.each([
    ["meta", () => metaRoute.POST] as const,
    ["google", () => googleRoute.POST] as const,
  ])("%s", (_provider, getPost) => {
    it("refuses an unauthenticated caller before any side effect", async () => {
      denyWith(401);
      const response = await getPost()(post({ account_ids: ["act_1"] }), { params });
      expect(response.status).toBe(401);
      expectNoSideEffects();
    });

    it("refuses a guest — read access is not selection authority", async () => {
      denyWith(403);
      const response = await getPost()(post({ account_ids: ["act_1"] }), { params });
      expect(response.status).toBe(403);
      expectNoSideEffects();
    });

    it("refuses a member of a DIFFERENT business", async () => {
      // requireBusinessAccess looks the membership up for the business in the
      // path, so a caller with a valid session elsewhere gets no membership here.
      denyWith(403);
      const response = await getPost()(post({ account_ids: [] }), { params });
      expect(response.status).toBe(403);
      expectNoSideEffects();
    });

    it("authorizes on the business in the PATH, not one supplied elsewhere", async () => {
      denyWith(403);
      await getPost()(post({ account_ids: ["act_1"], businessId: "other" }), {
        params,
      });
      expect(requireBusinessAccess).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, minRole: "collaborator" }),
      );
    });

    it("checks authorization before the demo branch", async () => {
      // The demo branch answers 200 with no membership check at all, so landing
      // an unauthorized caller there still discloses that the business exists.
      denyWith(401);
      const response = await getPost()(post({ account_ids: ["act_1"] }), { params });
      expect(response.status).toBe(401);
      expect(isDemoBusiness).not.toHaveBeenCalled();
    });
  });

  it("rejects a Meta account id that is not in this business's snapshot", async () => {
    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
    isDemoBusiness.mockResolvedValue(false);
    getIntegration.mockResolvedValue({ status: "connected", access_token: "t" });
    readProviderAccountSnapshot.mockResolvedValue({
      accounts: [{ id: "act_100", name: "Mine" }],
      meta: {},
    });

    const response = await metaRoute.POST(post({ account_ids: ["act_999"] }), {
      params,
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("invalid_meta_account_selection");
    // Nothing was written and no sync was started for an account this business
    // was never shown.
    expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
    expect(syncMetaInitial).not.toHaveBeenCalled();
  });

  it("accepts a Meta id in either spelling of the same account", async () => {
    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
    isDemoBusiness.mockResolvedValue(false);
    getIntegration.mockResolvedValue({ status: "connected", access_token: "t" });
    readProviderAccountSnapshot.mockResolvedValue({
      accounts: [{ id: "act_100", name: "Mine" }],
      meta: {},
    });
    upsertProviderAccountAssignments.mockResolvedValue({
      account_ids: ["act_100"],
      updated_at: new Date(0).toISOString(),
    });
    syncMetaInitial.mockResolvedValue(null);

    // `100` and `act_100` are one account, not two.
    const response = await metaRoute.POST(post({ account_ids: ["100"] }), { params });
    expect(response.status).toBe(200);
    expect(upsertProviderAccountAssignments).toHaveBeenCalled();
  });

  it("refuses Meta selection when no account snapshot is available", async () => {
    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
    isDemoBusiness.mockResolvedValue(false);
    getIntegration.mockResolvedValue({ status: "connected", access_token: "t" });
    readProviderAccountSnapshot.mockResolvedValue(null);

    const response = await metaRoute.POST(post({ account_ids: ["act_1"] }), {
      params,
    });
    expect(response.status).toBe(409);
    expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
    expect(syncMetaInitial).not.toHaveBeenCalled();
  });
});
