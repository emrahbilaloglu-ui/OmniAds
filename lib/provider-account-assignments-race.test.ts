import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The window between validating a selection and writing it.
 *
 * A selection is authorised by two independent pieces of evidence — the
 * credential the accounts were reached with, and the discovery snapshot that
 * listed them — and both can be replaced while the request is in flight. Four
 * separate defects lived in that window:
 *
 *  1. the generation was captured AFTER validation, so a reconnect landing
 *     during validation was invisible: the token already described the new
 *     connection and matched at write time;
 *  2. the generation check read the connection row without locking it, so a
 *     reconnect could still commit between the check and this transaction's
 *     commit;
 *  3. the discovery snapshot was not bound at all, so a refresh under the SAME
 *     credential could replace the account list — dropping an account the user
 *     had just picked — and the write committed anyway;
 *  4. the read that failed the authority check was wrapped in a catch that
 *     produced `null`, and `null` means "no expectation to enforce", so a
 *     transient database error silently disabled the whole check.
 *
 * Every refusal below must be provably ZERO-mutation: not "rolled back", but
 * never issued, so no enqueue downstream can be reached either.
 */

vi.mock("@/lib/sync/global-kill-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/global-kill-switch")>();
  return {
    ...actual,
    // Lanes default to OFF so a host cannot resume writing before an operator
    // says so. This suite is about the code behind the switch.
    assertSyncLaneEnabled: vi.fn(() => ({
      lane: "assignment_mutation" as const,
      enabled: true,
      reason: "enabled" as const,
    })),
  };
});

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map(
        (businessId) => [businessId, `business-ref-${businessId}`] as const,
      ),
    );
  }),
}));

const db = await import("@/lib/db");
const assignments = await import("@/lib/provider-account-assignments");

const BUSINESS_ID = "biz-race";
const PROVIDER = "meta" as const;

/** The connection and snapshot state a fake database answers with. */
interface AuthorityState {
  generation: string | null;
  status: string | null;
  snapshotRunId: string | null;
  snapshotFingerprint: string | null;
  snapshotAccountsHash: string | null;
}

const CURRENT: AuthorityState = {
  generation: "7",
  status: "connected",
  snapshotRunId: "run-1",
  snapshotFingerprint: "fp-1",
  snapshotAccountsHash: "hash-1",
};

const CURRENT_GENERATION_TOKEN = "7:connected";
const CURRENT_SNAPSHOT_REVISION = "run-1:fp-1:hash-1";

interface FakeDb {
  /** Every statement the writer issued, in order, as one flattened string. */
  queries: string[];
  /** Only the statements that would have changed a row. */
  mutations: string[];
  sql: ReturnType<typeof vi.fn>;
}

function isMutation(query: string): boolean {
  return /^(INSERT|UPDATE|DELETE)\b/i.test(query.trim());
}

/**
 * A fake that answers each statement by what it asks for, so the writer's real
 * ordering — locks, then authority, then mutation, then readback — is exercised
 * rather than stubbed out.
 */
function fakeDb(options: {
  authority?: AuthorityState | null;
  /** What the identity table resolves; defaults to what the readback reports. */
  identities?: string[];
  selected?: string[];
  /** Statements matching this substring throw, to model a database failure. */
  failOn?: string;
}): FakeDb {
  const queries: string[] = [];
  const mutations: string[] = [];
  const authority = options.authority === undefined ? CURRENT : options.authority;
  const selected = options.selected ?? ["act_1", "act_2"];
  const identities = options.identities ?? selected;

  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (isMutation(query)) mutations.push(query);
    if (options.failOn && query.includes(options.failOn)) {
      throw new Error("connection to the database was lost");
    }
    if (query.includes("FROM provider_connections connection")) {
      if (!authority) return [];
      return [
        {
          generation: authority.generation,
          status: authority.status,
          snapshot_run_id: authority.snapshotRunId,
          snapshot_connection_fingerprint: authority.snapshotFingerprint,
          snapshot_accounts_hash: authority.snapshotAccountsHash,
        },
      ];
    }
    if (query.includes("FROM provider_accounts")) {
      return identities.map((accountId, index) => ({
        id: `pa-${index}`,
        external_account_id: accountId,
      }));
    }
    if (query.includes("IS DISTINCT FROM bpa.provider_account_id")) {
      return [];
    }
    if (query.includes("ARRAY_AGG(bpa.id ORDER BY bpa.position, bpa.id)")) {
      if (selected.length === 0) return [];
      return [
        {
          id: "binding-1",
          business_id: BUSINESS_ID,
          provider: PROVIDER,
          account_ids: selected,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
      ];
    }
    return [];
  });

  vi.mocked(db.getDb).mockReturnValue(sql as never);
  return { queries, mutations, sql };
}

describe("provider account selection races", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.runDbTransaction).mockImplementation(
      async (fn: () => Promise<unknown>) => fn(),
    );
  });

  describe("the authority a selection is validated against", () => {
    it("reads the connection generation and the snapshot revision in ONE statement", async () => {
      // Two statements would produce a generation from before a reconnect paired
      // with a snapshot from after it — a combination that never existed, and one
      // no later comparison can detect.
      const fake = fakeDb({});
      const authority = await assignments.readProviderSelectionAuthority(
        BUSINESS_ID,
        PROVIDER,
      );

      expect(authority).toEqual({
        connectionGeneration: CURRENT_GENERATION_TOKEN,
        snapshotRevision: CURRENT_SNAPSHOT_REVISION,
      });
      expect(fake.queries).toHaveLength(1);
      expect(fake.queries[0]).toContain("provider_account_snapshot_runs");
    });

    it("binds the run id, the fingerprint and the accounts hash together", async () => {
      // Each part on its own is survivable: the run id survives an in-place
      // refresh, the fingerprint survives a refresh under the same credential
      // that returns a different list, and the hash survives a refresh under a
      // DIFFERENT credential that returns the same list.
      for (const changed of [
        { ...CURRENT, snapshotRunId: "run-2" },
        { ...CURRENT, snapshotFingerprint: "fp-2" },
        { ...CURRENT, snapshotAccountsHash: "hash-2" },
      ]) {
        fakeDb({ authority: changed });
        const authority = await assignments.readProviderSelectionAuthority(
          BUSINESS_ID,
          PROVIDER,
        );
        expect(authority.snapshotRevision).not.toBe(CURRENT_SNAPSHOT_REVISION);
      }
    });

    it("reports no revision when discovery has never run, rather than a token of empty parts", async () => {
      // A token built from NULL parts would compare equal to a real revision
      // whose parts happen to be NULL, which is the fail-OPEN direction.
      fakeDb({
        authority: {
          ...CURRENT,
          snapshotRunId: null,
          snapshotFingerprint: null,
          snapshotAccountsHash: null,
        },
      });
      const authority = await assignments.readProviderSelectionAuthority(
        BUSINESS_ID,
        PROVIDER,
      );
      expect(authority.snapshotRevision).toBeNull();
      expect(authority.connectionGeneration).toBe(CURRENT_GENERATION_TOKEN);
    });

    it("propagates a database failure instead of reporting no authority", async () => {
      // The defect this replaces: a `.catch(() => null)` here handed `null` to
      // the writer, and `null` means "no expectation to enforce".
      fakeDb({ failOn: "FROM provider_connections connection" });
      await expect(
        assignments.readProviderSelectionAuthority(BUSINESS_ID, PROVIDER),
      ).rejects.toThrow("connection to the database was lost");
    });
  });

  describe("a reconnect between validation and the write", () => {
    it("refuses with zero mutation when the connection generation moved", async () => {
      const fake = fakeDb({
        authority: { ...CURRENT, generation: "8" },
      });

      await expect(
        assignments.replaceProviderAccountSelection({
          businessId: BUSINESS_ID,
          provider: PROVIDER,
          accountIds: ["act_1", "act_2"],
          expectedConnectionGeneration: CURRENT_GENERATION_TOKEN,
          expectedSnapshotRevision: CURRENT_SNAPSHOT_REVISION,
        }),
      ).rejects.toMatchObject({ code: "connection_generation_changed" });

      expect(fake.mutations).toEqual([]);
    });

    it("refuses when the connection was disconnected without its generation moving", async () => {
      // Status is part of the token precisely because a disconnect changes what
      // the credential can reach without incrementing anything.
      const fake = fakeDb({ authority: { ...CURRENT, status: "disconnected" } });

      await expect(
        assignments.replaceProviderAccountSelection({
          businessId: BUSINESS_ID,
          provider: PROVIDER,
          accountIds: ["act_1"],
          expectedConnectionGeneration: CURRENT_GENERATION_TOKEN,
        }),
      ).rejects.toMatchObject({ code: "connection_generation_changed" });
      expect(fake.mutations).toEqual([]);
    });

    it("refuses when the connection row disappeared entirely", async () => {
      const fake = fakeDb({ authority: null });

      await expect(
        assignments.replaceProviderAccountSelection({
          businessId: BUSINESS_ID,
          provider: PROVIDER,
          accountIds: ["act_1"],
          expectedConnectionGeneration: CURRENT_GENERATION_TOKEN,
        }),
      ).rejects.toMatchObject({ code: "connection_generation_changed" });
      expect(fake.mutations).toEqual([]);
    });

    it("LOCKS the connection row so it cannot move between the check and the commit", async () => {
      // Without the row lock the check proved only that the connection had not
      // moved at the instant of the read; a reconnect committing after it still
      // landed a selection validated against a credential that no longer exists.
      const fake = fakeDb({});
      await assignments.replaceProviderAccountSelection({
        businessId: BUSINESS_ID,
        provider: PROVIDER,
        accountIds: ["act_1", "act_2"],
        expectedConnectionGeneration: CURRENT_GENERATION_TOKEN,
        expectedSnapshotRevision: CURRENT_SNAPSHOT_REVISION,
      });

      const authorityRead = fake.queries.find((query) =>
        query.includes("FROM provider_connections connection"),
      );
      expect(authorityRead).toContain("FOR UPDATE OF connection");
    });
  });

  describe("a discovery refresh between validation and the write", () => {
    it("refuses with zero mutation when the snapshot revision was replaced", async () => {
      // Same credential, same generation, different account list: an account the
      // user picked may no longer be reachable at all.
      const fake = fakeDb({
        authority: { ...CURRENT, snapshotAccountsHash: "hash-2" },
      });

      await expect(
        assignments.replaceProviderAccountSelection({
          businessId: BUSINESS_ID,
          provider: PROVIDER,
          accountIds: ["act_1", "act_2"],
          expectedConnectionGeneration: CURRENT_GENERATION_TOKEN,
          expectedSnapshotRevision: CURRENT_SNAPSHOT_REVISION,
        }),
      ).rejects.toMatchObject({ code: "snapshot_revision_changed" });

      expect(fake.mutations).toEqual([]);
    });

    it("refuses when the snapshot was deleted rather than replaced", async () => {
      const fake = fakeDb({
        authority: {
          ...CURRENT,
          snapshotRunId: null,
          snapshotFingerprint: null,
          snapshotAccountsHash: null,
        },
      });

      await expect(
        assignments.replaceProviderAccountSelection({
          businessId: BUSINESS_ID,
          provider: PROVIDER,
          accountIds: ["act_1"],
          expectedConnectionGeneration: CURRENT_GENERATION_TOKEN,
          expectedSnapshotRevision: CURRENT_SNAPSHOT_REVISION,
        }),
      ).rejects.toMatchObject({ code: "snapshot_revision_changed" });
      expect(fake.mutations).toEqual([]);
    });

    it("checks the authority before any mutating statement is issued", async () => {
      // The refusal must leave nothing to roll back, so that a caller cannot
      // observe a partial selection and no downstream enqueue can be reached.
      const fake = fakeDb({ authority: { ...CURRENT, snapshotRunId: "run-2" } });
      await assignments
        .replaceProviderAccountSelection({
          businessId: BUSINESS_ID,
          provider: PROVIDER,
          accountIds: ["act_1"],
          expectedSnapshotRevision: CURRENT_SNAPSHOT_REVISION,
        })
        .catch(() => undefined);

      expect(fake.queries.some((query) => isMutation(query))).toBe(false);
      // Locks first, then the authority read: the check has to happen behind the
      // same lock that serialises the write.
      const lockIndex = fake.queries.findIndex((query) =>
        query.includes("pg_advisory_xact_lock("),
      );
      const authorityIndex = fake.queries.findIndex((query) =>
        query.includes("FOR UPDATE OF connection"),
      );
      expect(lockIndex).toBeGreaterThanOrEqual(0);
      expect(authorityIndex).toBeGreaterThan(lockIndex);
    });
  });

  describe("a database failure inside the write", () => {
    it("propagates instead of being read as an absent expectation", async () => {
      const fake = fakeDb({ failOn: "FOR UPDATE OF connection" });

      await expect(
        assignments.replaceProviderAccountSelection({
          businessId: BUSINESS_ID,
          provider: PROVIDER,
          accountIds: ["act_1", "act_2"],
          expectedConnectionGeneration: CURRENT_GENERATION_TOKEN,
          expectedSnapshotRevision: CURRENT_SNAPSHOT_REVISION,
        }),
      ).rejects.toThrow("connection to the database was lost");

      expect(fake.mutations).toEqual([]);
    });
  });

  describe("the happy path", () => {
    it("writes, verifies and reports the selection unchanged", async () => {
      const fake = fakeDb({});
      const outcome = await assignments.replaceProviderAccountSelection({
        businessId: BUSINESS_ID,
        provider: PROVIDER,
        accountIds: ["act_1", "act_2"],
        expectedConnectionGeneration: CURRENT_GENERATION_TOKEN,
        expectedSnapshotRevision: CURRENT_SNAPSHOT_REVISION,
      });

      expect(outcome.accountIds).toEqual(["act_1", "act_2"]);
      expect(outcome.assignment.id).toBe("binding-1");
      const text = fake.queries.join("\n");
      expect(text).toContain("INSERT INTO provider_accounts");
      expect(text).toContain("INSERT INTO business_provider_accounts");
      // Identity bindings survive deselection.
      expect(text).not.toContain("DELETE FROM business_provider_accounts");
      expect(text).toContain("SET is_selected = FALSE");
    });

    it("still writes when no expectation is supplied, and takes no authority read", async () => {
      // Revocation and the migration backfills pass no expectation; requiring one
      // would make "stop using my accounts" fail when the connection is exactly
      // the thing that is broken.
      const fake = fakeDb({});
      await assignments.replaceProviderAccountSelection({
        businessId: BUSINESS_ID,
        provider: PROVIDER,
        accountIds: ["act_1", "act_2"],
      });

      expect(
        fake.queries.some((query) => query.includes("FOR UPDATE OF connection")),
      ).toBe(false);
      expect(fake.mutations.length).toBeGreaterThan(0);
    });

    it("refuses when the readback does not match what was asked for", async () => {
      // Both identities resolve, so the write proceeds — and the readback still
      // reports one account. The caller is told nothing was saved rather than
      // being handed a selection it did not ask for.
      const fake = fakeDb({ identities: ["act_1", "act_2"], selected: ["act_1"] });

      await expect(
        assignments.replaceProviderAccountSelection({
          businessId: BUSINESS_ID,
          provider: PROVIDER,
          accountIds: ["act_1", "act_2"],
        }),
      ).rejects.toMatchObject({ code: "readback_mismatch" });
      expect(fake.queries.length).toBeGreaterThan(0);
    });
  });

  describe("the reported selection", () => {
    it("comes from the in-transaction readback, with no second read outside it", async () => {
      // The wrapper used to discard the verified readback and re-read after
      // commit. That second read sees whatever is committed when it runs and
      // holds no lock, so a concurrent replacement made the response describe
      // another request's selection while claiming to describe this one.
      const fake = fakeDb({});
      const inTransaction: string[] = [];
      vi.mocked(db.runDbTransaction).mockImplementation(
        async (fn: () => Promise<unknown>) => {
          const before = fake.queries.length;
          const result = await fn();
          inTransaction.push(...fake.queries.slice(before));
          return result;
        },
      );

      const row = await assignments.upsertProviderAccountAssignments({
        businessId: BUSINESS_ID,
        provider: PROVIDER,
        accountIds: ["act_1", "act_2"],
        expectedConnectionGeneration: CURRENT_GENERATION_TOKEN,
        expectedSnapshotRevision: CURRENT_SNAPSHOT_REVISION,
      });

      expect(row.account_ids).toEqual(["act_1", "act_2"]);
      // Every statement this operation issued was issued inside the transaction.
      expect(inTransaction).toEqual(fake.queries);
      // ...and the aggregate was read exactly once.
      expect(
        fake.queries.filter((query) =>
          query.includes("ARRAY_AGG(bpa.id ORDER BY bpa.position, bpa.id)"),
        ),
      ).toHaveLength(1);
    });

    it("reports an empty selection as an outcome, not a failure", async () => {
      fakeDb({ selected: [] });
      const row = await assignments.upsertProviderAccountAssignments({
        businessId: BUSINESS_ID,
        provider: PROVIDER,
        accountIds: [],
      });
      expect(row.account_ids).toEqual([]);
      expect(row.business_id).toBe(BUSINESS_ID);
    });
  });

  describe("the exported selection lock", () => {
    it("takes the same two locks, in the same order, as the writer", async () => {
      // The OAuth post-connect path reads the previous selection, discovers the
      // new grant's accounts and writes the intersection back. Only its final
      // write was serialised, so a selection saved by the user during that
      // discovery was read as "previous" and then overwritten.
      const fake = fakeDb({});
      const ran = await assignments.withProviderAccountSelectionLock({
        businessId: BUSINESS_ID,
        provider: PROVIDER,
        work: async () => "did the work",
      });

      expect(ran).toBe("did the work");
      expect(fake.queries[0]).toContain("pg_advisory_xact_lock_shared");
      expect(fake.queries[1]).toContain("pg_advisory_xact_lock(");
      expect(vi.mocked(db.runDbTransaction)).toHaveBeenCalled();
    });

    it("holds the lock for the whole of the caller's work, not just its write", async () => {
      const fake = fakeDb({});
      await assignments.withProviderAccountSelectionLock({
        businessId: BUSINESS_ID,
        provider: PROVIDER,
        work: async () => {
          await assignments.replaceProviderAccountSelection({
            businessId: BUSINESS_ID,
            provider: PROVIDER,
            accountIds: ["act_1", "act_2"],
          });
        },
      });

      // `runDbTransaction` joins an open transaction, so the inner write runs
      // under the lock the wrapper already holds rather than taking its own.
      expect(fake.mutations.length).toBeGreaterThan(0);
      expect(
        fake.queries.filter((query) =>
          query.includes("pg_advisory_xact_lock_shared"),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });
});
