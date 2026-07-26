import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What gets stored, what may authorise storing it, and what the caller is told.
 *
 * Three separate defects, one code path:
 *
 *  1. validation normalized ids only for COMPARISON and the route persisted the
 *     caller's spelling, so `act_100` in the snapshot plus `100` in the request
 *     stored a second, noncanonical identity for one real account — and
 *     `[100, act_100]` selected it twice;
 *  2. a snapshot's freshness timestamp survived a disconnect, a reconnect by
 *     another user, and a credential rotation, so a list captured under an old
 *     token kept authorising selection under a new one;
 *  3. the post-commit scheduling failure was swallowed and both routes answered
 *     `{ success: true }`, so a disabled lane or a capacity refusal looked like
 *     a healthy, fully-synced integration.
 */

const requireBusinessAccess = vi.fn();
const isDemoBusiness = vi.fn();
const getIntegration = vi.fn();
const upsertProviderAccountAssignments = vi.fn();
const readProviderAccountSnapshot = vi.fn();
const syncMetaInitial = vi.fn();
const queuedPartitions = vi.fn();

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/business-mode.server", () => ({ isDemoBusiness }));
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => async () => queuedPartitions()),
  getDbWithTimeout: vi.fn(() => async () => queuedPartitions()),
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

const { computeProviderConnectionFingerprint } = await import(
  "@/lib/provider-connection-fingerprint"
);
const metaRoute = await import(
  "@/app/businesses/[businessId]/meta/assign-accounts/route"
);

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";
const params = Promise.resolve({ businessId: BUSINESS_ID });

const CONNECTION = {
  id: "int-1",
  provider: "meta" as const,
  status: "connected",
  provider_account_id: "act_100",
  access_token: "token-generation-1",
  connected_at: "2026-07-01T00:00:00.000Z",
  token_expires_at: null as string | null,
};

function post(body: unknown) {
  return new Request("https://example.test/businesses/x/assign-accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function snapshotFor(
  connection: typeof CONNECTION,
  accounts: Array<{ id: string; name: string }> = [{ id: "act_100", name: "Mine" }],
  metaOverrides: Record<string, unknown> = {},
) {
  return {
    accounts,
    meta: {
      stale: false,
      refreshFailed: false,
      sourceHealth: "fresh",
      connectionFingerprint: computeProviderConnectionFingerprint(connection),
      ...metaOverrides,
    },
  };
}

describe("assign-accounts selection truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
    isDemoBusiness.mockResolvedValue(false);
    getIntegration.mockResolvedValue(CONNECTION);
    readProviderAccountSnapshot.mockResolvedValue(snapshotFor(CONNECTION));
    upsertProviderAccountAssignments.mockImplementation(
      async ({ accountIds }: { accountIds: string[] }) => ({
        account_ids: accountIds,
        updated_at: new Date(0).toISOString(),
      }),
    );
    syncMetaInitial.mockResolvedValue(null);
    queuedPartitions.mockResolvedValue([{ queued: 3 }]);
  });

  describe("canonical identity", () => {
    it("persists the provider's spelling, not the caller's", async () => {
      const response = await metaRoute.POST(post({ account_ids: ["100"] }), { params });
      expect(response.status).toBe(200);
      // The exact ids handed to the canonical writer.
      expect(upsertProviderAccountAssignments).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: ["act_100"] }),
      );
      const body = (await response.json()) as { assigned_accounts?: string[] };
      expect(body.assigned_accounts).toEqual(["act_100"]);
    });

    it("tolerates whitespace around an id", async () => {
      await metaRoute.POST(post({ account_ids: ["  act_100  "] }), { params });
      expect(upsertProviderAccountAssignments).toHaveBeenCalledWith(
        expect.objectContaining({ accountIds: ["act_100"] }),
      );
    });

    it("rejects two spellings of one account rather than guessing", async () => {
      // `[100, act_100]` is one real account written twice. Silently collapsing
      // it would store a selection the caller did not ask for.
      const response = await metaRoute.POST(
        post({ account_ids: ["100", "act_100"] }),
        { params },
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe("ambiguous_account_selection");
      expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
    });

    it("rejects an id that is not shaped like a Meta account id", async () => {
      const response = await metaRoute.POST(
        post({ account_ids: ["'; DROP TABLE business_provider_accounts; --"] }),
        { params },
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe("invalid_account_id");
      expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
    });

    it("rejects an oversized selection", async () => {
      const response = await metaRoute.POST(
        post({ account_ids: Array.from({ length: 101 }, (_, i) => `act_${i}`) }),
        { params },
      );
      expect(response.status).toBe(400);
      expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
    });
  });

  describe("credential generation binding", () => {
    it("refuses a still-fresh snapshot captured before a reconnect", async () => {
      // Same account list, same timestamp, different connection generation: the
      // integration was disconnected and reconnected. The old snapshot says
      // nothing about what the NEW credential can reach.
      readProviderAccountSnapshot.mockResolvedValue(snapshotFor(CONNECTION));
      getIntegration.mockResolvedValue({
        ...CONNECTION,
        connected_at: "2026-07-20T00:00:00.000Z",
      });

      const response = await metaRoute.POST(post({ account_ids: ["act_100"] }), {
        params,
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe("account_list_from_previous_connection");
      expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
      expect(syncMetaInitial).not.toHaveBeenCalled();
    });

    it("refuses a still-fresh snapshot captured before a credential rotation", async () => {
      readProviderAccountSnapshot.mockResolvedValue(snapshotFor(CONNECTION));
      getIntegration.mockResolvedValue({
        ...CONNECTION,
        access_token: "token-generation-2",
      });

      const response = await metaRoute.POST(post({ account_ids: ["act_100"] }), {
        params,
      });
      expect(response.status).toBe(409);
      expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
    });

    it("refuses a snapshot with no connection binding at all", async () => {
      readProviderAccountSnapshot.mockResolvedValue(
        snapshotFor(CONNECTION, undefined, { connectionFingerprint: null }),
      );
      const response = await metaRoute.POST(post({ account_ids: ["act_100"] }), {
        params,
      });
      expect(response.status).toBe(409);
      expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
    });

    it("admits once discovery has run again under the current credential", async () => {
      const rotated = { ...CONNECTION, access_token: "token-generation-2" };
      getIntegration.mockResolvedValue(rotated);
      readProviderAccountSnapshot.mockResolvedValue(snapshotFor(rotated));
      const response = await metaRoute.POST(post({ account_ids: ["act_100"] }), {
        params,
      });
      expect(response.status).toBe(200);
    });
  });

  describe("connection usability", () => {
    it.each([
      ["disconnected", { ...CONNECTION, status: "disconnected" }, 409],
      ["credential cleared", { ...CONNECTION, access_token: null }, 409],
      [
        "credential expired",
        { ...CONNECTION, token_expires_at: "2020-01-01T00:00:00.000Z" },
        409,
      ],
      ["no integration at all", null, 404],
    ])("refuses when the connection is %s", async (_label, integration, status) => {
      getIntegration.mockResolvedValue(integration);
      const response = await metaRoute.POST(post({ account_ids: ["act_100"] }), {
        params,
      });
      expect(response.status).toBe(status);
      expect(readProviderAccountSnapshot).not.toHaveBeenCalled();
      expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
    });
  });

  describe("stale or failed discovery is blocking", () => {
    it.each([
      ["stale", { stale: true }],
      ["failed", { refreshFailed: true }],
    ])("refuses a %s snapshot", async (_label, overrides) => {
      readProviderAccountSnapshot.mockResolvedValue(
        snapshotFor(CONNECTION, undefined, overrides),
      );
      const response = await metaRoute.POST(post({ account_ids: ["act_100"] }), {
        params,
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe("account_list_not_fresh");
      expect(upsertProviderAccountAssignments).not.toHaveBeenCalled();
    });
  });

  describe("truthful response", () => {
    it("reports 202 with syncScheduled false when the lane is disabled", async () => {
      const { SyncLaneDisabledError } = await import("@/lib/sync/global-kill-switch");
      syncMetaInitial.mockRejectedValue(
        new SyncLaneDisabledError({
          lane: "meta_sync",
          enabled: false,
          reason: "lane_switch_off",
        }),
      );

      const response = await metaRoute.POST(post({ account_ids: ["act_100"] }), {
        params,
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.success).toBe(false);
      expect(body.selectionSaved).toBe(true);
      expect(body.syncScheduled).toBe(false);
      // The refusal survives as structure rather than collapsing to null.
      expect(body.refusal).toMatchObject({ kind: expect.any(String) });
    });

    it("reports 202 when a capacity refusal stops scheduling", async () => {
      const { DbGrowthFenceRefusal } = await import("@/lib/sync/db-growth-fence");
      syncMetaInitial.mockRejectedValue(
        new DbGrowthFenceRefusal(
          {
            allowed: false,
            reason: "physical_free_space_low",
            warning: false,
            databaseBytes: 1,
            databaseBudgetBytes: 2,
            tableBytes: {},
            offender: null,
            evaluatedAt: new Date(0).toISOString(),
            errorMessage: "disk full",
            overridden: false,
            physical: null,
          },
          "meta_initial",
        ),
      );

      const response = await metaRoute.POST(post({ account_ids: ["act_100"] }), {
        params,
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.selectionSaved).toBe(true);
      expect(body.syncScheduled).toBe(false);
      expect(body.refusal).not.toBeNull();
    });

    it("reports 202 when enqueue succeeds but nothing is durably queued", async () => {
      // The failure mode a plain try/catch cannot see: the call returned, and
      // the queue is still empty.
      queuedPartitions.mockResolvedValue([{ queued: 0 }]);
      const response = await metaRoute.POST(post({ account_ids: ["act_100"] }), {
        params,
      });
      expect(response.status).toBe(202);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.selectionSaved).toBe(true);
      expect(body.syncScheduled).toBe(false);
    });

    it("claims full success only when work is durably queued", async () => {
      const response = await metaRoute.POST(post({ account_ids: ["act_100"] }), {
        params,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.selectionSaved).toBe(true);
      expect(body.syncScheduled).toBe(true);
    });

    it("is idempotent on retry", async () => {
      const first = await metaRoute.POST(post({ account_ids: ["act_100"] }), { params });
      const second = await metaRoute.POST(post({ account_ids: ["act_100"] }), { params });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(upsertProviderAccountAssignments).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ accountIds: ["act_100"] }),
      );
    });
  });
});
