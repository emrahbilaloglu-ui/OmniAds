import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/provider-account-snapshots", () => ({
  readProviderAccountSnapshot: vi.fn(),
}));

vi.mock("@/lib/server-cache", () => ({
  readThroughCache: vi.fn(async (input: { loader: () => Promise<unknown> }) =>
    input.loader()
  ),
}));

const integrations = await import("@/lib/integrations");
const assignments = await import("@/lib/provider-account-assignments");
const snapshots = await import("@/lib/provider-account-snapshots");
const { getMetaAccountContext, normalizeMetaCurrencyCode } = await import(
  "@/lib/meta/account-context"
);

describe("Meta account currency context", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      access_token: "token-1",
    } as never);
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1"],
    } as never);
    vi.mocked(snapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [],
    } as never);
  });

  it("normalizes valid provider currency codes and rejects invalid values", () => {
    expect(normalizeMetaCurrencyCode(" try ")).toBe("TRY");
    expect(normalizeMetaCurrencyCode("$")).toBeNull();
    expect(normalizeMetaCurrencyCode(null)).toBeNull();
  });

  it("preserves genuine snapshot currency without a live request", async () => {
    vi.mocked(snapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [
        {
          id: "act_1",
          name: "TRY Account",
          currency: "TRY",
          timezone: "Europe/Istanbul",
        },
      ],
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const context = await getMetaAccountContext("biz-1");

    expect(context.currency).toBe("TRY");
    expect(context.accountProfiles.act_1?.currency).toBe("TRY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps currency null when profile sources cannot establish it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 }))
    );

    const context = await getMetaAccountContext("biz-1");

    expect(context.currency).toBeNull();
    expect(context.accountProfiles.act_1?.currency).toBeNull();
  });

  it("uses a genuine live account currency when available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              currency: "EUR",
              name: "EUR Account",
              timezone_name: "Europe/Berlin",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    const context = await getMetaAccountContext("biz-1");

    expect(context.currency).toBe("EUR");
    expect(context.accountProfiles.act_1).toEqual({
      currency: "EUR",
      name: "EUR Account",
      timezone: "Europe/Berlin",
    });
  });
});
