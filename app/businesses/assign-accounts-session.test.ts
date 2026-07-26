import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The exposure was not "authenticated cross-tenant". It was unauthenticated.
 *
 * Both handlers live under `/businesses/...`, not `/api`. For non-API paths
 * `proxy.ts` only asks whether an `omniads_session` cookie is present and
 * non-empty — it never validates it. Neither handler called `getSession` or
 * `requireBusinessAccess`. So any string in that cookie, plus a known or guessed
 * business UUID, reached a handler that rewrote canonical account selection and
 * (on Meta) started a sync.
 *
 * These tests exercise the REAL `lib/access` code path — only the session
 * lookup and the membership row are faked — so they prove the handler rejects
 * rather than proving a mock was called. Every rejected case asserts zero
 * database, provider and enqueue side effects.
 */

const findSession = vi.fn();
const membershipRows = vi.fn();
const isDemoBusiness = vi.fn();
const getIntegration = vi.fn();
const upsertProviderAccountAssignments = vi.fn();
const readProviderAccountSnapshot = vi.fn();
const syncMetaInitial = vi.fn();
const enqueueGoogleAdsScheduledWork = vi.fn();

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getSessionFromRequest: findSession };
});

// `findMembership` is module-local to lib/access, so the membership answer has
// to come through the database rather than through a mocked export.
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => {
    const tag = async () => membershipRows();
    return tag;
  }),
  getDbWithTimeout: vi.fn(() => {
    throw new Error("unexpected timed database access");
  }),
}));

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

const metaRoute = await import(
  "@/app/businesses/[businessId]/meta/assign-accounts/route"
);
const googleRoute = await import(
  "@/app/businesses/[businessId]/google/assign-accounts/route"
);

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_BUSINESS_ID = "99999999-8888-7777-6666-555555555555";
const params = Promise.resolve({ businessId: BUSINESS_ID });

function post(cookie: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie !== null) headers.cookie = `omniads_session=${cookie}`;
  return new Request("https://example.test/businesses/x/assign-accounts", {
    method: "POST",
    headers,
    body: JSON.stringify({ account_ids: ["act_1"] }),
  }) as never;
}

function session(userId = "user-1", email = "owner@example.test") {
  return { user: { id: userId, email }, session: { id: "sess-1" } };
}

function membership(role: string, status = "active", businessId = BUSINESS_ID) {
  return [
    {
      id: "m-1",
      user_id: "user-1",
      business_id: businessId,
      role,
      status,
      joined_at: new Date(0).toISOString(),
    },
  ];
}

function expectNoSideEffects() {
  expect(isDemoBusiness).not.toHaveBeenCalled();
  expect(getIntegration).not.toHaveBeenCalled();
  expect(readProviderAccountSnapshot).not.toHaveBeenCalled();
  expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
  expect(syncMetaInitial).not.toHaveBeenCalled();
  expect(enqueueGoogleAdsScheduledWork).not.toHaveBeenCalled();
}

describe.each([
  ["meta", () => metaRoute.POST] as const,
  ["google", () => googleRoute.POST] as const,
])("%s assign-accounts session enforcement", (_provider, getPost) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    membershipRows.mockResolvedValue([]);
  });

  it("rejects a request with no cookie at all", async () => {
    findSession.mockResolvedValue(null);
    const response = await getPost()(post(null), { params });
    expect(response.status).toBe(401);
    expectNoSideEffects();
  });

  it("rejects a FORGED non-empty cookie", async () => {
    // This is the exact request the proxy used to wave through: the cookie is
    // present and non-empty, so the proxy is satisfied, and nothing downstream
    // ever looked at it.
    findSession.mockResolvedValue(null);
    const response = await getPost()(post("not-a-real-token"), { params });
    expect(response.status).toBe(401);
    expectNoSideEffects();
  });

  it("rejects an expired or otherwise invalid session token", async () => {
    // An expired token resolves to no session, which must read as unauthorized
    // rather than as an absent check.
    findSession.mockResolvedValue(null);
    const response = await getPost()(post("expired-token"), { params });
    expect(response.status).toBe(401);
    expectNoSideEffects();
  });

  it("rejects a valid user who is a member of a DIFFERENT business", async () => {
    findSession.mockResolvedValue(session());
    membershipRows.mockResolvedValue(membership("admin", "active", OTHER_BUSINESS_ID));
    // The lookup is keyed by (user, business-in-path), so a membership elsewhere
    // returns nothing for this business.
    membershipRows.mockResolvedValue([]);
    const response = await getPost()(post("valid-token"), { params });
    expect(response.status).toBe(403);
    expectNoSideEffects();
  });

  it("rejects a guest — read access is not selection authority", async () => {
    findSession.mockResolvedValue(session());
    membershipRows.mockResolvedValue(membership("guest"));
    const response = await getPost()(post("valid-token"), { params });
    expect(response.status).toBe(403);
    expectNoSideEffects();
  });

  it("rejects an invited-but-not-active membership", async () => {
    findSession.mockResolvedValue(session());
    membershipRows.mockResolvedValue(membership("admin", "invited"));
    const response = await getPost()(post("valid-token"), { params });
    expect(response.status).toBe(403);
    expectNoSideEffects();
  });

  it("admits an active collaborator past the guard", async () => {
    findSession.mockResolvedValue(session());
    membershipRows.mockResolvedValue(membership("collaborator"));
    isDemoBusiness.mockResolvedValue(false);
    getIntegration.mockResolvedValue(null);

    const response = await getPost()(post("valid-token"), { params });
    // 404 integration_not_found: past authorization, refused for a real reason.
    expect(response.status).toBe(404);
    expect(getIntegration).toHaveBeenCalled();
    expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
  });

  it("admits an active admin past the guard", async () => {
    findSession.mockResolvedValue(session());
    membershipRows.mockResolvedValue(membership("admin"));
    isDemoBusiness.mockResolvedValue(false);
    getIntegration.mockResolvedValue(null);

    const response = await getPost()(post("valid-token"), { params });
    expect(response.status).toBe(404);
    expect(getIntegration).toHaveBeenCalled();
  });
});
