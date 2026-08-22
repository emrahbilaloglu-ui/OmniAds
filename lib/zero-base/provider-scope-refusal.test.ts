import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));
vi.mock("@/lib/provider-account-snapshots", () => ({
  readProviderAccountSnapshot: vi.fn(),
}));

const assignments = await import("@/lib/provider-account-assignments");
const snapshots = await import("@/lib/provider-account-snapshots");
const { resolveProviderAccountScope, resolveProviderAccountId } = await import(
  "@/lib/zero-base/provider-scope-server"
);

function assigned(ids: string[]) {
  vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
    account_ids: ids,
  } as never);
  vi.mocked(snapshots.readProviderAccountSnapshot).mockResolvedValue({
    accounts: ids.map((id) => ({ id, name: `Account ${id}` })),
  } as never);
}

/**
 * D6's 0 / 1 / N, and the reason each `null` happened.
 *
 * A bare `null` covered three situations that ask the operator for three
 * different things — assign an account, choose one, and "that link is not
 * yours" — so every surface could only offer the same dead end for all three.
 */
describe("resolveProviderAccountScope", () => {
  it("0 assigned: refuses with none_assigned", async () => {
    assigned([]);
    const scope = await resolveProviderAccountScope({
      businessId: "biz_1",
      provider: "meta",
    });
    expect(scope).toEqual({
      providerAccountId: null,
      refusal: "provider_account_none_assigned",
      requestedButUnassigned: null,
    });
  });

  it("1 assigned: resolves it without a request", async () => {
    assigned(["act_1"]);
    const scope = await resolveProviderAccountScope({
      businessId: "biz_1",
      provider: "meta",
    });
    expect(scope.providerAccountId).toBe("act_1");
    expect(scope.refusal).toBeNull();
  });

  it("N assigned, nothing requested: account_required, never an auto-pick", async () => {
    assigned(["act_1", "act_2"]);
    const scope = await resolveProviderAccountScope({
      businessId: "biz_1",
      provider: "meta",
    });
    expect(scope.providerAccountId).toBeNull();
    expect(scope.refusal).toBe("account_required");
  });

  it("an unassigned request refuses and names the id, without falling back", async () => {
    // A silent fallback would answer a question about account A with account
    // B's data — the plan's rollback trigger 2.
    assigned(["act_1", "act_2"]);
    const scope = await resolveProviderAccountScope({
      businessId: "biz_1",
      provider: "meta",
      requestedAccountId: "act_999",
    });
    expect(scope.providerAccountId).toBeNull();
    expect(scope.refusal).toBe("provider_account_not_assigned");
    expect(scope.requestedButUnassigned).toBe("act_999");
  });

  it("an unassigned request refuses even when exactly one account is assigned", async () => {
    // The single-account auto-select must not rescue a request for a different
    // account: asking for A and being handed B is the same defect either way.
    assigned(["act_1"]);
    const scope = await resolveProviderAccountScope({
      businessId: "biz_1",
      provider: "meta",
      requestedAccountId: "act_999",
    });
    expect(scope.providerAccountId).toBeNull();
    expect(scope.refusal).toBe("provider_account_not_assigned");
  });

  it("matches a Meta account across the act_ prefix, and answers in the catalog's spelling", async () => {
    // §7.2. Meta returns both spellings from its own edges, so a raw string
    // comparison made a correctly-assigned account fail to match itself and the
    // surface refused for a selection that was in the URL all along.
    assigned(["act_123456"]);
    const scope = await resolveProviderAccountScope({
      businessId: "biz_1",
      provider: "meta",
      requestedAccountId: "123456",
    });
    expect(scope.providerAccountId).toBe("act_123456");
    expect(scope.refusal).toBeNull();
  });

  it("does not apply the Meta prefix rule to Google", async () => {
    // Google customer ids are not `act_`-prefixed; normalising them would make
    // two different customers compare equal.
    assigned(["1234567890"]);
    const scope = await resolveProviderAccountScope({
      businessId: "biz_1",
      provider: "google",
      requestedAccountId: "act_1234567890",
    });
    expect(scope.providerAccountId).toBeNull();
    expect(scope.refusal).toBe("provider_account_not_assigned");
  });

  it("resolveProviderAccountId returns exactly the scope's id", async () => {
    // One implementation, so the two cannot disagree about what resolved.
    assigned(["act_1", "act_2"]);
    for (const requested of [null, "act_2", "act_999"]) {
      const scope = await resolveProviderAccountScope({
        businessId: "biz_1",
        provider: "meta",
        requestedAccountId: requested,
      });
      const id = await resolveProviderAccountId({
        businessId: "biz_1",
        provider: "meta",
        requestedAccountId: requested,
      });
      expect(id).toBe(scope.providerAccountId);
    }
  });
});
