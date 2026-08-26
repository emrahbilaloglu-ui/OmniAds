import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));
vi.mock("@/lib/meta/history-read-model", () => ({
  readMetaHistoryAccounts: vi.fn(),
  readMetaHistoryAssignedAccountIds: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-validation", () => ({
  metaLaunchAccountBlockerHttpStatus: vi.fn(() => 400),
  resolveAssignedMetaLaunchAccount: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-store", () => ({
  listManualMetaLaunchTemplates: vi.fn(),
  listMetaLaunchDrafts: vi.fn(),
  listRecentMetaLaunchTemplates: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-store", () => ({
  listMetaLaunchIntents: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-store-capability", () => ({
  getMetaLaunchStoreCapability: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-launch-intent-capability", () => ({
  getMetaLaunchIntentCapability: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-recent-ad-actions", () => ({
  readRecentLaunchpadAdActions: vi.fn(),
}));
vi.mock("@/lib/business-commercial", () => ({
  getBusinessCommercialTruthSnapshot: vi.fn(),
}));

const access = await import("@/lib/access");
const history = await import("@/lib/meta/history-read-model");
const validation = await import("@/lib/launchpad/meta-validation");
const store = await import("@/lib/launchpad/meta-store");
const intentStore = await import("@/lib/launchpad/meta-launch-intent-store");
const storeCapability = await import("@/lib/launchpad/meta-store-capability");
const intentCapability = await import(
  "@/lib/launchpad/meta-launch-intent-capability"
);
const recentActions = await import("@/lib/launchpad/meta-recent-ad-actions");
const commercial = await import("@/lib/business-commercial");
const { GET } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const ACCOUNT = "act_123";

const ACCOUNTS = [
  { id: ACCOUNT, name: "Account One" },
  { id: "act_456", name: "Account Two" },
];

function request(query = `businessId=${BUSINESS_ID}&providerAccountId=${ACCOUNT}`) {
  return new NextRequest(`http://localhost/api/launchpad/meta/workspace?${query}`);
}

/**
 * The two floors, separately. `requireBusinessAccess` is the one function both
 * gates call, so what it answers for each `minRole` is exactly what separates a
 * guest from a collaborator here.
 */
function grantAccess(options: { library?: boolean } = {}) {
  const library = options.library !== false;
  vi.mocked(access.requireBusinessAccess).mockImplementation((async (input: {
    minRole?: string;
  }) => {
    if (input.minRole === "collaborator" && !library) {
      return { error: new Response(null, { status: 403 }) };
    }
    return {
      session: { user: { id: "user_1" } },
      membership: { businessId: BUSINESS_ID, role: library ? "admin" : "guest" },
    };
  }) as never);
  vi.mocked(history.readMetaHistoryAccounts).mockResolvedValue(
    ACCOUNTS as never,
  );
  vi.mocked(history.readMetaHistoryAssignedAccountIds).mockResolvedValue([
    ACCOUNT,
    "act_456",
  ]);
  vi.mocked(validation.resolveAssignedMetaLaunchAccount).mockResolvedValue({
    ok: true,
    providerAccountId: ACCOUNT,
  });
  vi.mocked(storeCapability.getMetaLaunchStoreCapability).mockResolvedValue({
    status: "ready",
    canRead: true,
    canWrite: true,
    missingColumns: [],
  });
  vi.mocked(intentCapability.getMetaLaunchIntentCapability).mockResolvedValue({
    status: "ready",
    canRead: true,
    canWrite: true,
    missingTables: [],
    checkedAt: "2026-08-26T00:00:00.000Z",
  } as never);
  vi.mocked(store.listManualMetaLaunchTemplates).mockResolvedValue([
    { id: "t_1" },
  ] as never);
  vi.mocked(store.listRecentMetaLaunchTemplates).mockResolvedValue([] as never);
  vi.mocked(store.listMetaLaunchDrafts).mockResolvedValue([] as never);
  vi.mocked(intentStore.listMetaLaunchIntents).mockResolvedValue([] as never);
  vi.mocked(recentActions.readRecentLaunchpadAdActions).mockResolvedValue([
    { resultingAdId: "a_1" },
  ] as never);
  vi.mocked(commercial.getBusinessCommercialTruthSnapshot).mockResolvedValue({
    targetPack: { targetCpa: 42.5 },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/launchpad/meta/workspace", () => {
  it("answers every section in one response", async () => {
    grantAccess();

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      Object.entries(body.sections as Record<string, { status: string }>)
        .filter(([, section]) => section.status === "complete")
        .map(([key]) => key)
        .sort(),
    ).toEqual([
      "accounts",
      "drafts",
      "intents",
      "recentAdActions",
      "recentTemplates",
      "targetCpa",
      "templates",
    ]);
    expect(body.templates).toEqual([{ id: "t_1" }]);
    expect(body.recentAdActions).toEqual([{ resultingAdId: "a_1" }]);
    expect(body.targetCpa).toBe(42.5);
    expect(body.accounts).toEqual(ACCOUNTS);
  });

  // LAW: the seven folded routes do not share one floor. `/api/meta/history/
  // accounts` admits a guest; the six Launchpad routes are hardcoded to
  // collaborator. Composing them must not move either boundary — a guest keeps
  // the account picker and is still refused the library, by name.
  it("serves a guest the account list and names the library refusal", async () => {
    grantAccess({ library: false });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.accounts).toEqual(ACCOUNTS);
    expect(body.sections.accounts.status).toBe("complete");
    for (const key of [
      "templates",
      "recentTemplates",
      "drafts",
      "intents",
      "recentAdActions",
      "targetCpa",
    ]) {
      expect(body.sections[key]).toMatchObject({
        status: "unavailable",
        // `insufficient_role`, not `capability_read_denied`: the §9.1
        // dictionary declares the latter a PROVIDER permission failure whose
        // remedy is reconnecting Meta, which is false about a guest.
        errorCode: "insufficient_role",
      });
    }
    // Refused means not read. Nothing account-scoped may be touched.
    expect(store.listMetaLaunchDrafts).not.toHaveBeenCalled();
    expect(validation.resolveAssignedMetaLaunchAccount).not.toHaveBeenCalled();
  });

  it("carries an account blocker instead of failing the whole response", async () => {
    grantAccess();
    vi.mocked(validation.resolveAssignedMetaLaunchAccount).mockResolvedValue({
      ok: false,
      blocker: {
        code: "provider_account_not_assigned",
        message: "Select one assigned Meta ad account.",
      },
    } as never);

    const response = await GET(request(`businessId=${BUSINESS_ID}`));
    const body = await response.json();

    // A 4xx here would take away the account list, which is the only thing that
    // could resolve the blocker.
    expect(response.status).toBe(200);
    expect(body.accounts).toEqual(ACCOUNTS);
    expect(body.accountBlocker.code).toBe("provider_account_not_assigned");
    expect(body.sections.templates).toBeUndefined();
  });

  it("lets one failing section fail alone", async () => {
    grantAccess();
    vi.mocked(store.listMetaLaunchDrafts).mockRejectedValue(
      new Error("drafts table is unreadable"),
    );

    const body = await (await GET(request())).json();

    expect(body.sections.drafts).toMatchObject({
      status: "unavailable",
      errorCode: "drafts_failed",
    });
    expect(body.drafts).toEqual([]);
    expect(body.sections.templates.status).toBe("complete");
    expect(body.templates).toEqual([{ id: "t_1" }]);
  });

  /*
   * LAW: missing or unreadable data must never become 0 or success.
   *
   * This case used to assert only that `capability.canRead` was false and the
   * array was empty — both of which were true while the SECTION said
   * `complete`, which is the one thing that decides what the surface draws.
   * The client reads `sections[key].status`, not `capability`, so an
   * unmigrated store arrived as "this workspace has no drafts".
   */
  for (const [label, unmigrated] of [
    [
      "templates",
      () =>
        vi.mocked(storeCapability.getMetaLaunchStoreCapability).mockImplementation(
          async (kind) =>
            kind === "templates"
              ? {
                  status: "migration_required",
                  canRead: false,
                  canWrite: false,
                  missingColumns: ["provider_account_id"],
                }
              : { status: "ready", canRead: true, canWrite: true, missingColumns: [] },
        ),
    ],
    [
      "drafts",
      () =>
        vi.mocked(storeCapability.getMetaLaunchStoreCapability).mockImplementation(
          async (kind) =>
            kind === "drafts"
              ? {
                  status: "migration_required",
                  canRead: false,
                  canWrite: false,
                  missingColumns: ["provider_account_id"],
                }
              : { status: "ready", canRead: true, canWrite: true, missingColumns: [] },
        ),
    ],
    [
      "intents",
      () =>
        vi.mocked(intentCapability.getMetaLaunchIntentCapability).mockResolvedValue({
          status: "migration_required",
          canRead: false,
          canWrite: false,
          missingTables: ["meta_launch_intents"],
          checkedAt: "2026-08-26T00:00:00.000Z",
        } as never),
    ],
  ] as const) {
    it(`reports an unmigrated ${label} store as unavailable, not complete`, async () => {
      grantAccess();
      unmigrated();

      const body = await (await GET(request())).json();

      const affected =
        label === "templates"
          ? ["templates", "recentTemplates"]
          : label === "drafts"
            ? ["drafts"]
            : ["intents"];
      for (const key of affected) {
        expect(body.sections[key], key).toMatchObject({
          status: "unavailable",
          errorCode: "schema_not_ready",
        });
      }
      // And the sections whose store IS readable are untouched.
      const untouched = [
        "templates",
        "recentTemplates",
        "drafts",
        "intents",
      ].filter((key) => !affected.includes(key));
      for (const key of untouched) {
        expect(body.sections[key].status, key).toBe("complete");
      }
    });
  }

  it("does not call a repository the capability says cannot be read", async () => {
    grantAccess();
    vi.mocked(storeCapability.getMetaLaunchStoreCapability).mockResolvedValue({
      status: "migration_required",
      canRead: false,
      canWrite: false,
      missingColumns: ["provider_account_id"],
    });
    vi.mocked(intentCapability.getMetaLaunchIntentCapability).mockResolvedValue({
      status: "migration_required",
      canRead: false,
      canWrite: false,
      missingTables: ["meta_launch_intents"],
      checkedAt: "2026-08-26T00:00:00.000Z",
    } as never);

    const body = await (await GET(request())).json();

    expect(store.listManualMetaLaunchTemplates).not.toHaveBeenCalled();
    expect(store.listRecentMetaLaunchTemplates).not.toHaveBeenCalled();
    expect(store.listMetaLaunchDrafts).not.toHaveBeenCalled();
    expect(intentStore.listMetaLaunchIntents).not.toHaveBeenCalled();
    // The capability still travels, because the surface uses it to decide
    // whether to offer a SAVE — a different question from whether this read
    // answered.
    expect(body.capability.templates.canRead).toBe(false);
    expect(body.templates).toEqual([]);
  });

  /*
   * A capability read that itself FAILED is not a capability that said "no".
   * Not knowing whether a store is readable must not stop the read: the
   * repository's own failure is the honest answer, and `settled()` reports it.
   */
  it("still attempts the read when the capability check itself failed", async () => {
    grantAccess();
    vi.mocked(storeCapability.getMetaLaunchStoreCapability).mockRejectedValue(
      new Error("capability probe failed"),
    );

    const body = await (await GET(request())).json();

    expect(store.listManualMetaLaunchTemplates).toHaveBeenCalled();
    expect(body.sections.templates.status).toBe("complete");
    expect(body.capability.templates).toBeNull();
  });

  it("reads the target CPA and never derives one", async () => {
    grantAccess();
    vi.mocked(commercial.getBusinessCommercialTruthSnapshot).mockResolvedValue({
      targetPack: { targetCpa: 0 },
    } as never);

    const body = await (await GET(request())).json();

    expect(body.targetCpa).toBeNull();
  });

  it("refuses a request with no business", async () => {
    grantAccess();

    const response = await GET(request("providerAccountId=act_123"));

    expect(response.status).toBe(400);
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("reaches no provider", async () => {
    const providerFetch = vi.spyOn(globalThis, "fetch");
    grantAccess();

    await GET(request());

    expect(providerFetch).not.toHaveBeenCalled();
    providerFetch.mockRestore();
  });
});
