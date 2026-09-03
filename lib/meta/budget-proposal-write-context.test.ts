/**
 * PR #272 review — the budget write context must carry a VERIFIED currency, or
 * refuse to exist.
 *
 * A budget is a count of minor units. Meta does not report currency on a
 * campaign or an ad set, so the only honest source is the ad-account profile
 * this builder already reads to prove the business still holds the account.
 * If that profile has no currency, there is no way to say what the number
 * means, and the correct answer is `null` rather than a context that lets an
 * execution guess.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/account-context", () => ({
  getMetaAccountContext: vi.fn(),
}));

const accountContext = await import("@/lib/meta/account-context");
const {
  buildMetaBudgetWriteContextForProposal,
  buildMetaWriteContextForProposal,
} = await import("@/lib/meta/budget-proposal-write-context");

const ACCOUNT = "act_770001";
const BIZ = "33333333-3333-4333-8333-333333333333";

function context(over: Record<string, unknown> = {}) {
  return {
    businessId: BIZ,
    connected: true,
    accessToken: "secret-token",
    connectionGeneration: "7:connected",
    accountIds: [ACCOUNT],
    primaryAccountId: ACCOUNT,
    primaryAccountTimezone: "Europe/Istanbul",
    currency: "TRY",
    accountProfiles: {
      [ACCOUNT]: { currency: "TRY", timezone: "Europe/Istanbul", name: "Main" },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(accountContext.getMetaAccountContext).mockReset();
});

describe("buildMetaBudgetWriteContextForProposal", () => {
  it("carries the exact account's normalised currency", async () => {
    vi.mocked(accountContext.getMetaAccountContext).mockResolvedValue(context() as never);

    const built = await buildMetaBudgetWriteContextForProposal({
      businessId: BIZ, providerAccountId: ACCOUNT,
    });

    expect(built).toEqual({
      businessId: BIZ,
      providerAccountId: ACCOUNT,
      accessToken: "secret-token",
      connectionGeneration: "7:connected",
      accountCurrency: "TRY",
    });
  });

  it.each(["try", "US", "EURO", "$$$"])(
    "normalizes or refuses a non-canonical profile currency: %s",
    async (currency) => {
      vi.mocked(accountContext.getMetaAccountContext).mockResolvedValue(context({
        accountProfiles: {
          [ACCOUNT]: { currency, timezone: "Europe/Istanbul", name: "Main" },
        },
      }) as never);

      const built = await buildMetaBudgetWriteContextForProposal({
        businessId: BIZ, providerAccountId: ACCOUNT,
      });

      if (currency === "try") expect(built?.accountCurrency).toBe("TRY");
      else expect(built).toBeNull();
    },
  );

  it("takes the currency of the REQUESTED account, not the primary one", async () => {
    const second = "act_770002";
    vi.mocked(accountContext.getMetaAccountContext).mockResolvedValue(context({
      accountIds: [ACCOUNT, second],
      accountProfiles: {
        [ACCOUNT]: { currency: "TRY", timezone: null, name: null },
        [second]: { currency: "USD", timezone: null, name: null },
      },
    }) as never);

    const built = await buildMetaBudgetWriteContextForProposal({
      businessId: BIZ, providerAccountId: second,
    });

    expect(built?.accountCurrency).toBe("USD");
    expect(built?.providerAccountId).toBe(second);
  });

  it.each([
    ["the profile has no currency", { [ACCOUNT]: { currency: null, timezone: null, name: null } }],
    ["the currency is blank", { [ACCOUNT]: { currency: "   ", timezone: null, name: null } }],
    ["the account is not held at all", {}],
  ])("fails closed when %s", async (_label, accountProfiles) => {
    vi.mocked(accountContext.getMetaAccountContext).mockResolvedValue(
      context({ accountProfiles }) as never,
    );

    await expect(buildMetaBudgetWriteContextForProposal({
      businessId: BIZ, providerAccountId: ACCOUNT,
    })).resolves.toBeNull();
  });

  it.each([
    ["the integration is disconnected", { connected: false }],
    ["no access token", { accessToken: "" }],
    ["no connection generation", { connectionGeneration: "" }],
  ])("still fails closed with %s, exactly as the general builder does", async (_l, over) => {
    vi.mocked(accountContext.getMetaAccountContext).mockResolvedValue(context(over) as never);

    await expect(buildMetaBudgetWriteContextForProposal({
      businessId: BIZ, providerAccountId: ACCOUNT,
    })).resolves.toBeNull();
    await expect(buildMetaWriteContextForProposal({
      businessId: BIZ, providerAccountId: ACCOUNT,
    })).resolves.toBeNull();
  });

  it("does not change the general write context, which needs no currency", async () => {
    // Pauses, resumes, bid writes and Launchpad creates share this builder and
    // must keep working for an account whose currency is unknown.
    vi.mocked(accountContext.getMetaAccountContext).mockResolvedValue(context({
      accountProfiles: { [ACCOUNT]: { currency: null, timezone: null, name: null } },
    }) as never);

    const general = await buildMetaWriteContextForProposal({
      businessId: BIZ, providerAccountId: ACCOUNT,
    });

    expect(general).toEqual({
      businessId: BIZ,
      providerAccountId: ACCOUNT,
      accessToken: "secret-token",
      connectionGeneration: "7:connected",
    });
    expect(general).not.toHaveProperty("accountCurrency");
  });
});
