import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations", () => ({ getIntegration: vi.fn() }));
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

const integrations = await import("@/lib/integrations");
const assignments = await import("@/lib/provider-account-assignments");
const {
  resolveAssignedMetaLaunchAccount,
  resolveMetaLaunchWriteContext,
} = await import("@/lib/launchpad/meta-validation");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

describe("Meta Launchpad provider-account scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["123", "act_456"],
    } as never);
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      access_token: "secret-token",
      provider_account_id: "act_legacy_primary",
    } as never);
  });

  it("requires an explicit account even when the integration has a primary account", async () => {
    const result = await resolveMetaLaunchWriteContext(BUSINESS_ID, null);

    expect(result).toMatchObject({
      ok: false,
      blocker: { code: "provider_account_id_required" },
    });
    expect(integrations.getIntegration).not.toHaveBeenCalled();
  });

  it("normalizes numeric account ids and accepts only assigned accounts", async () => {
    await expect(
      resolveAssignedMetaLaunchAccount({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
      }),
    ).resolves.toEqual({ ok: true, providerAccountId: "act_123" });

    await expect(
      resolveAssignedMetaLaunchAccount({
        businessId: BUSINESS_ID,
        providerAccountId: "act_999",
      }),
    ).resolves.toMatchObject({
      ok: false,
      blocker: { code: "provider_account_not_assigned" },
    });
  });

  it("uses the selected assigned account instead of the integration primary", async () => {
    const result = await resolveMetaLaunchWriteContext(BUSINESS_ID, "act_456");

    expect(result).toEqual({
      ok: true,
      ctx: {
        businessId: BUSINESS_ID,
        providerAccountId: "act_456",
        accessToken: "secret-token",
        // Not decoration: while this was absent, ads-write.ts skipped the
        // pre-POST authority compare-and-set entirely for every Launchpad write.
        connectionGeneration: expect.stringMatching(/^\d+:connected$/),
      },
    });
  });

  it("distinguishes assignment-source failure from an unassigned account", async () => {
    vi.mocked(assignments.getProviderAccountAssignments).mockRejectedValueOnce(
      new Error("db unavailable"),
    );

    await expect(
      resolveAssignedMetaLaunchAccount({
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
      }),
    ).resolves.toMatchObject({
      ok: false,
      blocker: { code: "provider_account_scope_unavailable" },
    });
  });
});
