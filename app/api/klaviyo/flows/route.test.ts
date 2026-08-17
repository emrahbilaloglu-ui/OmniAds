import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What `/api/klaviyo/flows` will and will not serve.
 *
 * Two properties are load-bearing and both are asserted here:
 *   - the authorization boundary is the same as its closest sibling read,
 *     `app/api/search-console/analytics/route.ts` — requireBusinessAccess with
 *     `minRole: "guest"` — and a denial is returned unchanged;
 *   - a stored snapshot is WITHHELD unless the connection that produced it is
 *     still connected. Warehouse rows outlive a disconnect, and serving them
 *     would present a dead grant's numbers as current.
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

const { GET } = await import("@/app/api/klaviyo/flows/route");

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function get(businessId: string | null = BUSINESS_ID) {
  const url = businessId
    ? `https://example.test/api/klaviyo/flows?businessId=${businessId}`
    : "https://example.test/api/klaviyo/flows";
  const base = new Request(url);
  return Object.assign(base, { nextUrl: new URL(url) }) as never;
}

const SNAPSHOT = {
  windowDays: 28,
  windowStart: "2026-07-20",
  windowEnd: "2026-08-17",
  fetchedAt: "2026-08-17T03:00:00.000Z",
  providerAccountId: "acct_1",
  rows: [
    {
      flowId: "flow_1",
      flowName: "Welcome Series",
      flowStatus: "live",
      currency: "USD",
      revenue: 18420,
      openRate: 0.54,
      recipients: 12480,
    },
    {
      flowId: "flow_2",
      flowName: "Win-back 60d",
      flowStatus: "draft",
      currency: "USD",
      revenue: null,
      openRate: null,
      recipients: null,
    },
  ],
};

describe("GET /api/klaviyo/flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("KLAVIYO_CLIENT_ID", "client-id");
    vi.stubEnv("KLAVIYO_CLIENT_SECRET", "client-secret");
    requireBusinessAccess.mockResolvedValue({ session: {}, membership: {} });
    getIntegrationMetadata.mockResolvedValue({ status: "connected" });
    readKlaviyoFlowSnapshot.mockResolvedValue(SNAPSHOT);
  });

  it("requires businessId before touching anything else", async () => {
    const response = await GET(get(null));
    expect(response.status).toBe(400);
    expect(requireBusinessAccess).not.toHaveBeenCalled();
  });

  it("authorizes exactly like its closest sibling read: guest on the named business", async () => {
    await GET(get());
    expect(requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, minRole: "guest" }),
    );
  });

  it("returns the authorizer's own denial and reads nothing", async () => {
    const denial = new Response(null, { status: 403 });
    requireBusinessAccess.mockResolvedValue({ error: denial });

    const response = await GET(get());
    expect(response).toBe(denial);
    expect(readKlaviyoFlowSnapshot).not.toHaveBeenCalled();
  });

  it("serves the five formatted columns when the connection is live and a snapshot exists", async () => {
    const payload = await (await GET(get())).json();

    expect(payload.state).toBe("ready");
    expect(payload.flows).toEqual([
      {
        id: "flow_1",
        name: "Welcome Series",
        status: "Live",
        revenue: "$18,420",
        openRate: "54%",
        recipients: "12,480",
      },
      {
        id: "flow_2",
        name: "Win-back 60d",
        status: "Draft",
        revenue: null,
        openRate: null,
        recipients: null,
      },
    ]);
    expect(payload.meta).toMatchObject({ windowDays: 28, rowCount: 2 });
  });

  it("answers flows:null — not an empty list — when nothing has been imported", async () => {
    readKlaviyoFlowSnapshot.mockResolvedValue(null);

    const payload = await (await GET(get())).json();
    expect(payload.state).toBe("awaiting_first_snapshot");
    expect(payload.flows).toBeNull();
    expect(payload.meta.fetchedAt).toBeNull();
  });

  it("withholds a stored snapshot once the connection is no longer connected", async () => {
    getIntegrationMetadata.mockResolvedValue({ status: "disconnected" });

    const payload = await (await GET(get())).json();
    expect(payload.state).toBe("reconnect_required");
    expect(payload.flows).toBeNull();
  });

  it("reports not_connected when the workspace has no Klaviyo row at all", async () => {
    getIntegrationMetadata.mockResolvedValue(null);
    readKlaviyoFlowSnapshot.mockResolvedValue(null);

    const payload = await (await GET(get())).json();
    expect(payload.state).toBe("not_connected");
    expect(payload.flows).toBeNull();
  });

  it("reports not_configured when the deployment holds no Klaviyo credential", async () => {
    vi.stubEnv("KLAVIYO_CLIENT_ID", "");
    vi.stubEnv("KLAVIYO_CLIENT_SECRET", "");

    const payload = await (await GET(get())).json();
    expect(payload.state).toBe("not_configured");
    expect(payload.flows).toBeNull();
  });
});
