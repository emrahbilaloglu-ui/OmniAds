import { beforeEach, describe, expect, it, vi } from "vitest";

const authorityMocks = vi.hoisted(() => ({
  getIntegration: vi.fn(),
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: authorityMocks.getIntegration,
}));
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: authorityMocks.getProviderAccountAssignments,
}));

const {
  GOOGLE_ADS_ACCOUNT_AUTHORITY_UNKNOWN_CODE,
  GOOGLE_ADS_ACCOUNT_NOT_SELECTED_CODE,
  googleAdsReadAccountAuthorityFailure,
  resolveGoogleAdsReadAccountAuthority,
} = await import("@/lib/google-ads/account-authority");

beforeEach(() => {
  vi.clearAllMocks();
  authorityMocks.getProviderAccountAssignments.mockResolvedValue({
    account_ids: ["493-118-2201"],
  });
});

describe("Google reporting account authority", () => {
  it("authorizes only an assigned account and does not require a live credential", async () => {
    const authority = await resolveGoogleAdsReadAccountAuthority(
      "biz_1",
      "4931182201",
    );

    expect(authority).toEqual({ state: "authorized", errorMessage: null });
    expect(authorityMocks.getProviderAccountAssignments).toHaveBeenCalledWith(
      "biz_1",
      "google",
    );
    expect(authorityMocks.getIntegration).not.toHaveBeenCalled();
    expect(googleAdsReadAccountAuthorityFailure(authority)).toBeNull();
  });

  it("refuses an unassigned requested account without falling back", async () => {
    const authority = await resolveGoogleAdsReadAccountAuthority(
      "biz_1",
      "9999999999",
    );

    expect(googleAdsReadAccountAuthorityFailure(authority)).toEqual({
      code: GOOGLE_ADS_ACCOUNT_NOT_SELECTED_CODE,
      httpStatus: 409,
      message:
        "This Google Ads account is not assigned to this business. No reporting data was read.",
    });
  });

  it("fails closed when assignment authority cannot be read", async () => {
    authorityMocks.getProviderAccountAssignments.mockRejectedValueOnce(
      new Error("assignment store unavailable"),
    );

    const authority = await resolveGoogleAdsReadAccountAuthority(
      "biz_1",
      "4931182201",
    );

    expect(googleAdsReadAccountAuthorityFailure(authority)).toEqual({
      code: GOOGLE_ADS_ACCOUNT_AUTHORITY_UNKNOWN_CODE,
      httpStatus: 503,
      message:
        "Could not verify that this Google Ads account is assigned to the business. No reporting data was read.",
    });
  });
});
