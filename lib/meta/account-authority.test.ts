import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

const integrations = await import("@/lib/integrations");
const assignments = await import("@/lib/provider-account-assignments");
const { resolveMetaAccountAuthority, isMetaAccountStillAuthorized } = await import(
  "@/lib/meta/account-context"
);

describe("resolveMetaAccountAuthority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("authorizes a connected integration with the account selected", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      access_token: "token",
    } as never);
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1"],
    } as never);

    await expect(resolveMetaAccountAuthority("biz-1", "act_1")).resolves.toEqual({
      state: "authorized",
      errorMessage: null,
    });
  });

  it.each([
    [
      "a disconnected integration",
      { status: "disconnected", access_token: "token" },
      ["act_1"],
    ],
    [
      "a connected integration with no token",
      { status: "connected", access_token: null },
      ["act_1"],
    ],
    ["a deselected account", { status: "connected", access_token: "token" }, []],
  ])("confirms revocation for %s", async (_label, integration, accountIds) => {
    vi.mocked(integrations.getIntegration).mockResolvedValue(integration as never);
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: accountIds,
    } as never);

    const decision = await resolveMetaAccountAuthority("biz-1", "act_1");
    expect(decision.state).toBe("confirmed_revoked");
  });

  it.each([
    ["the integration read", "integrations"],
    ["the assignment read", "assignments"],
  ])("reports unknown_error when %s fails", async (_label, failing) => {
    const boom = new Error("connection terminated unexpectedly");
    vi.mocked(integrations.getIntegration).mockImplementation(async () => {
      if (failing === "integrations") throw boom;
      return { status: "connected", access_token: "token" } as never;
    });
    vi.mocked(assignments.getProviderAccountAssignments).mockImplementation(
      async () => {
        if (failing === "assignments") throw boom;
        return { account_ids: ["act_1"] } as never;
      },
    );

    const decision = await resolveMetaAccountAuthority("biz-1", "act_1");
    // The distinction that matters: an unreadable authority is NOT a
    // revocation. Collapsing the two is what cancelled valid partitions
    // terminally because a database was briefly unreachable.
    expect(decision.state).toBe("unknown_error");
    expect(decision.state).not.toBe("confirmed_revoked");
    expect(decision.errorMessage).toContain("connection terminated");
  });

  it("keeps the boolean helper failing closed for both non-authorized states", async () => {
    vi.mocked(integrations.getIntegration).mockRejectedValue(new Error("down"));
    vi.mocked(assignments.getProviderAccountAssignments).mockRejectedValue(
      new Error("down"),
    );
    // False for uncertainty too — which is why it must never decide a cancel.
    await expect(isMetaAccountStillAuthorized("biz-1", "act_1")).resolves.toBe(false);
  });
});
