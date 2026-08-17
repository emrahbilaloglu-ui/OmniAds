import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Klaviyo ingest, and the guards it is not allowed to walk around.
 *
 * Klaviyo is read-only here: this subsystem performs no provider write, so the
 * guarded-write ceremony does not apply to it. What DOES apply is the ingest
 * admission every other external source obeys — the global/per-lane kill switch
 * and the database growth fence — and the tests below pin that this path is
 * admitted by them rather than beside them, including AFTER the provider
 * round-trip, which is the window an admission taken only at the top misses.
 */

const assertSyncLaneEnabled = vi.fn();
const assertSyncGrowthBoundary = vi.fn();
const getIntegration = vi.fn();
const getDbSchemaReadiness = vi.fn();
const resolveKlaviyoAccessToken = vi.fn();
const fetchKlaviyoFlows = vi.fn();
const fetchKlaviyoConversionMetricId = vi.fn();
const fetchKlaviyoFlowStatistics = vi.fn();
const replaceKlaviyoFlowMetrics = vi.fn();

class MockLaneDisabledError extends Error {
  constructor() {
    super("Sync lane 'source_ingest' is disabled (lane_switch_unset).");
    this.name = "SyncLaneDisabledError";
  }
}

vi.mock("@/lib/sync/global-kill-switch", () => ({
  assertSyncLaneEnabled,
  SyncLaneDisabledError: MockLaneDisabledError,
}));
vi.mock("@/lib/sync/db-growth-fence", () => ({ assertSyncGrowthBoundary }));
vi.mock("@/lib/integrations", () => ({ getIntegration }));
vi.mock("@/lib/db-schema-readiness", () => ({ getDbSchemaReadiness }));
vi.mock("@/lib/klaviyo/token", () => ({ resolveKlaviyoAccessToken }));
vi.mock("@/lib/klaviyo/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchKlaviyoFlows,
    fetchKlaviyoConversionMetricId,
    fetchKlaviyoFlowStatistics,
  };
});
vi.mock("@/lib/klaviyo/warehouse", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, replaceKlaviyoFlowMetrics };
});
vi.mock("@/lib/db", () => {
  const unusable = () => {
    throw new Error("The sync must not reach the database directly here.");
  };
  return {
    getDb: vi.fn(unusable),
    getDbWithTimeout: vi.fn(unusable),
    runDbTransaction: vi.fn(unusable),
  };
});
vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(async () => new Map()),
}));

const { syncKlaviyoFlowMetrics, buildKlaviyoWindow } = await import(
  "@/lib/klaviyo/sync"
);
/** The unmocked client, for the one test that must exercise real pagination. */
const { fetchKlaviyoFlows: actualFetchKlaviyoFlows } =
  await vi.importActual<typeof import("@/lib/klaviyo/api")>(
    "@/lib/klaviyo/api",
  );

const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

describe("syncKlaviyoFlowMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertSyncLaneEnabled.mockReturnValue({
      lane: "source_ingest",
      enabled: true,
      reason: "enabled",
    });
    assertSyncGrowthBoundary.mockResolvedValue({ allowed: true });
    getDbSchemaReadiness.mockResolvedValue({ ready: true, missingTables: [] });
    getIntegration.mockResolvedValue({
      status: "connected",
      provider_account_id: "acct_1",
      metadata: { klaviyoCurrency: "USD" },
    });
    resolveKlaviyoAccessToken.mockResolvedValue({ accessToken: "token" });
    fetchKlaviyoFlows.mockResolvedValue([
      { id: "flow_1", name: "Welcome Series", status: "live", archived: false },
      { id: "flow_2", name: "Win-back 60d", status: "draft", archived: false },
      { id: "flow_3", name: "Retired", status: "draft", archived: true },
    ]);
    fetchKlaviyoConversionMetricId.mockResolvedValue("metric_placed_order");
    fetchKlaviyoFlowStatistics.mockResolvedValue([
      {
        flowId: "flow_1",
        conversionValue: 18420,
        openRate: 0.54,
        recipients: 12480,
      },
    ]);
    replaceKlaviyoFlowMetrics.mockResolvedValue({ written: 2 });
  });

  it("is admitted by the source_ingest lane before it resolves any connection", async () => {
    assertSyncLaneEnabled.mockImplementation(() => {
      throw new MockLaneDisabledError();
    });

    await expect(syncKlaviyoFlowMetrics(BUSINESS_ID)).rejects.toThrow(
      /source_ingest/,
    );
    expect(getIntegration).not.toHaveBeenCalled();
    expect(replaceKlaviyoFlowMetrics).not.toHaveBeenCalled();
  });

  it("is admitted by the database growth fence", async () => {
    assertSyncGrowthBoundary.mockRejectedValue(new Error("growth fence tripped"));

    await expect(syncKlaviyoFlowMetrics(BUSINESS_ID)).rejects.toThrow(
      "growth fence tripped",
    );
    expect(replaceKlaviyoFlowMetrics).not.toHaveBeenCalled();
  });

  it("re-asserts admission AFTER the provider round-trip, before writing", async () => {
    // The lane goes off while Klaviyo is being read. Admission taken only at the
    // top would have written anyway.
    let laneCalls = 0;
    assertSyncLaneEnabled.mockImplementation(() => {
      laneCalls += 1;
      if (laneCalls > 1) throw new MockLaneDisabledError();
      return { lane: "source_ingest", enabled: true, reason: "enabled" };
    });

    await expect(syncKlaviyoFlowMetrics(BUSINESS_ID)).rejects.toThrow(
      /source_ingest/,
    );
    expect(fetchKlaviyoFlows).toHaveBeenCalled();
    expect(replaceKlaviyoFlowMetrics).not.toHaveBeenCalled();
  });

  it("never writes a flow collection it could not read to the end", async () => {
    // The REAL `fetchKlaviyoFlows`, over a Klaviyo that keeps handing back
    // another `links.next`. What must not happen is the sync taking the pages
    // it managed to read and writing them: `replaceKlaviyoFlowMetrics` DELETES
    // every stored flow the collection does not mention, so a partial import
    // would silently destroy the flows nobody read.
    const flowsUrl = "https://a.klaviyo.com/api/flows/";
    let page = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        page += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                type: "flow",
                id: `flow_page_${page}`,
                attributes: { name: `Page ${page}`, status: "live" },
              },
            ],
            links: { next: `${flowsUrl}?page%5Bcursor%5D=cursor_${page + 1}` },
          }),
        };
      }),
    );
    fetchKlaviyoFlows.mockImplementation((accessToken: string) =>
      actualFetchKlaviyoFlows(accessToken),
    );

    try {
      await expect(syncKlaviyoFlowMetrics(BUSINESS_ID)).rejects.toMatchObject({
        code: "klaviyo_flow_pagination_unbounded",
      });
      expect(replaceKlaviyoFlowMetrics).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses to ingest for a connection that is not connected", async () => {
    getIntegration.mockResolvedValue({
      status: "disconnected",
      provider_account_id: "acct_1",
    });

    const result = await syncKlaviyoFlowMetrics(BUSINESS_ID);
    expect(result).toMatchObject({ skipped: true, skipReason: "not_connected" });
    expect(resolveKlaviyoAccessToken).not.toHaveBeenCalled();
    expect(replaceKlaviyoFlowMetrics).not.toHaveBeenCalled();
  });

  it("refuses to store a snapshot it cannot attribute to a provider account", async () => {
    getIntegration.mockResolvedValue({
      status: "connected",
      provider_account_id: null,
    });

    const result = await syncKlaviyoFlowMetrics(BUSINESS_ID);
    expect(result.skipReason).toBe("no_provider_account");
    expect(replaceKlaviyoFlowMetrics).not.toHaveBeenCalled();
  });

  it("skips cleanly when the warehouse table does not exist yet", async () => {
    getDbSchemaReadiness.mockResolvedValue({
      ready: false,
      missingTables: ["klaviyo_flow_metrics"],
    });

    const result = await syncKlaviyoFlowMetrics(BUSINESS_ID);
    expect(result.skipReason).toBe("schema_not_ready");
    expect(getIntegration).not.toHaveBeenCalled();
  });

  it("writes NULL — never zero — for a flow Klaviyo reported no statistics for", async () => {
    await syncKlaviyoFlowMetrics(BUSINESS_ID);

    const written = replaceKlaviyoFlowMetrics.mock.calls[0][0];
    expect(written.rows).toEqual([
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
    ]);
  });

  it("drops archived flows rather than presenting them as live lifecycle rows", async () => {
    await syncKlaviyoFlowMetrics(BUSINESS_ID);
    const written = replaceKlaviyoFlowMetrics.mock.calls[0][0];
    expect(written.rows.map((row: { flowId: string }) => row.flowId)).not.toContain(
      "flow_3",
    );
  });

  it("reports revenue as unavailable when Klaviyo serves no conversion metric", async () => {
    fetchKlaviyoConversionMetricId.mockResolvedValue(null);
    fetchKlaviyoFlowStatistics.mockResolvedValue([]);

    const result = await syncKlaviyoFlowMetrics(BUSINESS_ID);
    expect(result.revenueUnavailable).toBe(true);
    const written = replaceKlaviyoFlowMetrics.mock.calls[0][0];
    for (const row of written.rows) {
      expect(row.revenue).toBeNull();
    }
  });

  it("stores no currency when the connection never recorded one", async () => {
    getIntegration.mockResolvedValue({
      status: "connected",
      provider_account_id: "acct_1",
      metadata: {},
    });

    await syncKlaviyoFlowMetrics(BUSINESS_ID);
    const written = replaceKlaviyoFlowMetrics.mock.calls[0][0];
    expect(written.rows[0].currency).toBeNull();
  });

  it("uses the 28-day window the design's column names", async () => {
    const now = new Date("2026-08-17T12:34:56.000Z");
    const window = buildKlaviyoWindow(now);
    expect(window).toEqual({ start: "2026-07-20", end: "2026-08-17" });

    await syncKlaviyoFlowMetrics(BUSINESS_ID, { now });
    expect(replaceKlaviyoFlowMetrics.mock.calls[0][0]).toMatchObject({
      windowDays: 28,
      windowStart: "2026-07-20",
      windowEnd: "2026-08-17",
    });
  });
});
