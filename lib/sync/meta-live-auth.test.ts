import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/meta", () => ({
  resolveMetaCredentials: vi.fn(),
}));

const apiMeta = await import("@/lib/api/meta");
const { validateMetaLiveAccountAccess } = await import("@/lib/sync/meta-live-auth");

describe("Meta live account access validation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns missing_credentials when no assigned account token exists", async () => {
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue(null);

    const result = await validateMetaLiveAccountAccess({ businessId: "biz-1" });

    expect(result).toMatchObject({
      status: "missing_credentials",
      checkedAccountCount: 0,
      validAccountIds: [],
    });
  });

  it("requires every assigned Meta account probe to pass", async () => {
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      businessId: "biz-1",
      accessToken: "token-1",
      accountIds: ["act_1", "act_2"],
      currency: "USD",
      accountProfiles: {},
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: "act_1" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: vi.fn().mockResolvedValue({
          error: { message: "You cannot access the app till you log in." },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateMetaLiveAccountAccess({
      businessId: "biz-1",
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      status: "invalid",
      checkedAccountCount: 2,
      validAccountIds: ["act_1"],
      invalidAccountIds: ["act_2"],
      errorMessage: "You cannot access the app till you log in.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns valid when all assigned Meta account probes pass", async () => {
    vi.mocked(apiMeta.resolveMetaCredentials).mockResolvedValue({
      businessId: "biz-1",
      accessToken: "token-1",
      accountIds: ["act_1"],
      currency: "USD",
      accountProfiles: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: "act_1" }),
      }),
    );

    const result = await validateMetaLiveAccountAccess({
      businessId: "biz-1",
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      status: "valid",
      checkedAccountCount: 1,
      validAccountIds: ["act_1"],
      invalidAccountIds: [],
      unknownAccountIds: [],
      errorMessage: null,
    });
  });
});
