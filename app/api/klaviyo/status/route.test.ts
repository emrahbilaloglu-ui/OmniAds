import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/klaviyo/status` exists for one fact the browser cannot know: whether
 * THIS deployment holds Klaviyo client credentials. That fact is what decides
 * between the design's Connect button and no button at all — the third option
 * defect KLAVIYO-INTEGRATIONS-28 was missing.
 */

const requireBusinessAccess = vi.fn();
const getIntegrationMetadata = vi.fn();
const readKlaviyoFlowSnapshot = vi.fn();

vi.mock("@/lib/access", () => ({ requireBusinessAccess }));
vi.mock("@/lib/integrations", () => ({ getIntegrationMetadata }));
vi.mock("@/lib/klaviyo/warehouse", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readKlaviyoFlowSnapshot };
});
vi.mock("@/lib/db", () => {
  const unusable = () => {
    throw new Error("The route must not reach the database in this test.");
  };
  return {
    getDb: vi.fn(unusable),
    getDbWithTimeout: vi.fn(unusable),
    runDbTransaction: vi.fn(unusable),
  };
});

const { GET } = await import("@/app/api/klaviyo/status/route");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function get(businessId: string | null = BUSINESS_ID) {
  const url = businessId
    ? `https://example.test/api/klaviyo/status?businessId=${businessId}`
    : "https://example.test/api/klaviyo/status";
  const base = new Request(url);
  return Object.assign(base, { nextUrl: new URL(url) }) as never;
}

describe("GET /api/klaviyo/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
    getIntegrationMetadata.mockResolvedValue(null);
    readKlaviyoFlowSnapshot.mockResolvedValue(null);
  });

  it("authorizes exactly like /api/integrations/status: guest on the named business", async () => {
    vi.stubEnv("KLAVIYO_CLIENT_ID", "id");
    vi.stubEnv("KLAVIYO_CLIENT_SECRET", "secret");
    await GET(get());
    expect(requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, minRole: "guest" }),
    );
  });

  it("returns the authorizer's denial unchanged", async () => {
    const denial = new Response(null, { status: 401 });
    requireBusinessAccess.mockResolvedValue({ error: denial });
    expect(await GET(get())).toBe(denial);
  });

  it("requires businessId", async () => {
    expect((await GET(get(null))).status).toBe(400);
  });

  it("reports the card as NOT connectable while the deployment holds no credential", async () => {
    const payload = await (await GET(get())).json();
    expect(payload.state).toBe("not_configured");
    expect(payload.connectable).toBe(false);
    expect(payload.inRail).toBe(false);
  });

  it("reports the card as connectable once the owner supplies both secrets", async () => {
    vi.stubEnv("KLAVIYO_CLIENT_ID", "id");
    vi.stubEnv("KLAVIYO_CLIENT_SECRET", "secret");

    const payload = await (await GET(get())).json();
    expect(payload.state).toBe("not_connected");
    expect(payload.connectable).toBe(true);
    expect(payload.inRail).toBe(false);
  });

  it("puts Klaviyo in the rail only once a snapshot has landed", async () => {
    vi.stubEnv("KLAVIYO_CLIENT_ID", "id");
    vi.stubEnv("KLAVIYO_CLIENT_SECRET", "secret");
    getIntegrationMetadata.mockResolvedValue({
      status: "connected",
      provider_account_name: "Aurora Supply Co.",
    });

    const pending = await (await GET(get())).json();
    expect(pending.state).toBe("awaiting_first_snapshot");
    expect(pending.inRail).toBe(false);
    expect(pending.lastSyncedAt).toBeNull();

    readKlaviyoFlowSnapshot.mockResolvedValue({
      windowDays: 28,
      windowStart: "2026-07-20",
      windowEnd: "2026-08-17",
      fetchedAt: "2026-08-17T03:00:00.000Z",
      providerAccountId: "acct_1",
      rows: [{ flowId: "flow_1" }],
    });

    const ready = await (await GET(get())).json();
    expect(ready.state).toBe("ready");
    expect(ready.inRail).toBe(true);
    expect(ready.lastSyncedAt).toBe("2026-08-17T03:00:00.000Z");
    expect(ready.flowCount).toBe(1);
  });

  it("returns no credential material", async () => {
    vi.stubEnv("KLAVIYO_CLIENT_ID", "id");
    vi.stubEnv("KLAVIYO_CLIENT_SECRET", "secret");
    getIntegrationMetadata.mockResolvedValue({
      status: "connected",
      provider_account_name: "Aurora Supply Co.",
    });

    const body = await (await GET(get())).text();
    expect(body).not.toContain("secret");
    expect(body).not.toContain("access_token");
    expect(body).not.toContain("refresh_token");
  });
});
