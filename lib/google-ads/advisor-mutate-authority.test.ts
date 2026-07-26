import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Google advisor writeback accepted a client-supplied `accountId`.
 *
 * Every advisor mutation — apply, batch apply, rollback, and validate-only —
 * takes the account id from the request body and uses the shared business
 * credential. Nothing checked whether that account was currently selected for
 * the business, so any customer the credential could reach was writable, and a
 * deselected account stayed writable indefinitely.
 *
 * The guard sits at `googleAdsMutateRequest` / `googleAdsSearchRequest`, the
 * lowest common boundary all four paths pass through, so no execution surface
 * can bypass it.
 */

const getIntegration = vi.fn();
const getProviderAccountAssignments = vi.fn();
const fetchWithTimeout = vi.fn();

vi.mock("@/lib/integrations", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getIntegration };
});

vi.mock("@/lib/provider-account-assignments", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getProviderAccountAssignments };
});

vi.mock("@/lib/http-fetch-with-timeout", () => ({ fetchWithTimeout }));

vi.mock("@/lib/provider-account-snapshots", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readProviderAccountSnapshot: vi.fn(async () => null) };
});

const {
  assertGoogleAdsAccountAuthority,
  isGoogleAdsAccountAuthorityError,
  resolveGoogleAdsAccountAuthority,
  normalizeGoogleCustomerId,
  GOOGLE_ADS_ACCOUNT_NOT_SELECTED_CODE,
  GOOGLE_ADS_ACCOUNT_AUTHORITY_UNKNOWN_CODE,
} = await import("@/lib/google-ads/account-authority");
const advisor = await import("@/lib/google-ads/advisor-mutate");

describe("Google Ads account authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegration.mockResolvedValue({ status: "connected", access_token: "token" });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["123-456-7890"] });
    fetchWithTimeout.mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
  });

  it("treats formatted and unformatted customer ids as one account", () => {
    expect(normalizeGoogleCustomerId("123-456-7890")).toBe("1234567890");
    expect(normalizeGoogleCustomerId("  1234567890 ")).toBe("1234567890");
  });

  it("authorizes a currently selected account", async () => {
    await expect(
      resolveGoogleAdsAccountAuthority("biz-1", "1234567890"),
    ).resolves.toMatchObject({ state: "authorized" });
  });

  it.each([
    ["an account that was never selected", { account_ids: ["999-999-9999"] }],
    ["an account that was deselected", { account_ids: [] }],
  ])("confirms revocation for %s", async (_label, assignments) => {
    getProviderAccountAssignments.mockResolvedValue(assignments);
    await expect(
      resolveGoogleAdsAccountAuthority("biz-1", "1234567890"),
    ).resolves.toMatchObject({ state: "confirmed_revoked" });
  });

  it("reports a database outage as uncertain, not as revoked", async () => {
    getProviderAccountAssignments.mockRejectedValue(new Error("connection terminated"));
    const decision = await resolveGoogleAdsAccountAuthority("biz-1", "1234567890");
    expect(decision.state).toBe("unknown_error");
    expect(decision.errorMessage).toMatch(/connection terminated/);
  });

  it("confirms revocation when the integration is disconnected", async () => {
    getIntegration.mockResolvedValue({ status: "disconnected", access_token: null });
    await expect(
      resolveGoogleAdsAccountAuthority("biz-1", "1234567890"),
    ).resolves.toMatchObject({ state: "confirmed_revoked" });
  });

  it("throws a 409 for a deselected account", async () => {
    getProviderAccountAssignments.mockResolvedValue({ account_ids: [] });
    await expect(
      assertGoogleAdsAccountAuthority({ businessId: "biz-1", accountId: "1234567890" }),
    ).rejects.toMatchObject({
      code: GOOGLE_ADS_ACCOUNT_NOT_SELECTED_CODE,
      httpStatus: 409,
    });
  });

  it("throws a 503 when authority cannot be read", async () => {
    getProviderAccountAssignments.mockRejectedValue(new Error("down"));
    await expect(
      assertGoogleAdsAccountAuthority({ businessId: "biz-1", accountId: "1234567890" }),
    ).rejects.toMatchObject({
      code: GOOGLE_ADS_ACCOUNT_AUTHORITY_UNKNOWN_CODE,
      httpStatus: 503,
    });
  });

  it("re-reads authority after the token refresh and before every attempt", async () => {
    // Token refresh is a network round trip and manager-candidate resolution
    // reads a discovery snapshot; both take real time. A check only at the top
    // leaves a window before each attempt, and the loop retries against a
    // different login customer id.
    let calls = 0;
    getProviderAccountAssignments.mockImplementation(async () => {
      calls += 1;
      // Selected for the first read (route admission), revoked from then on.
      return { account_ids: calls === 1 ? ["123-456-7890"] : [] };
    });

    const outcome = await advisor
      .executeAdvisorMutation({
        businessId: "biz-1",
        accountId: "123-456-7890",
        action: {
          actionType: "add_negative_keyword",
          payload: {
            campaignId: "c-1",
            negativeKeywords: ["bad"],
            matchType: "EXACT",
          },
        },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(outcome).not.toBeNull();
    expect(isGoogleAdsAccountAuthorityError(outcome)).toBe(true);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  describe("advisor writeback makes zero provider calls without authority", () => {
    const action: import("@/lib/google-ads/advisor-mutate").AdvisorMutatePayload = {
      actionType: "add_negative_keyword",
      payload: {
        campaignId: "c-1",
        negativeKeywords: ["bad"],
        matchType: "EXACT",
      },
    };

    const cases = [
      [
        "apply",
        () =>
          advisor.executeAdvisorMutation({
            businessId: "biz-1",
            accountId: "999-999-9999",
            action,
          }),
      ],
      [
        "validate-only preflight",
        () =>
          advisor.validateAdvisorMutation({
            businessId: "biz-1",
            accountId: "999-999-9999",
            action,
          }),
      ],
      [
        "rollback",
        () =>
          advisor.rollbackAdvisorMutation({
            businessId: "biz-1",
            accountId: "999-999-9999",
            actionType: "remove_negative_keyword",
            payload: {
              resourceNames: ["customers/9999999999/campaignCriteria/1~2"],
            },
          }),
      ],
    ] as const;

    it.each(cases)("%s", async (_label, run) => {
      // `999-999-9999` is not in the selection. Whatever this path does with the
      // refusal, it must not have called the provider.
      const outcome = await Promise.resolve(run()).then(
        (value) => ({ threw: false as const, value }),
        (error: unknown) => ({ threw: true as const, error }),
      );
      if (outcome.threw) {
        expect(isGoogleAdsAccountAuthorityError(outcome.error)).toBe(true);
      } else {
        expect((outcome.value as { ok?: boolean } | null)?.ok).not.toBe(true);
      }
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    });
  });
});
