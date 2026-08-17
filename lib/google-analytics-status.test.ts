import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integrations", () => ({
  getIntegrationMetadata: vi.fn(),
}));

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/provider-report-sync-evidence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readLatestProviderReportSyncJob: vi.fn() };
});

const snapshotAnchor = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(
    () => async () =>
      snapshotAnchor.value === null
        ? []
        : [{ updated_at: snapshotAnchor.value }],
  ),
}));

const integrations = await import("@/lib/integrations");
const businessMode = await import("@/lib/business-mode.server");
const evidence = await import("@/lib/provider-report-sync-evidence");
const { getGoogleAnalyticsStatus, getDemoGoogleAnalyticsStatus } = await import(
  "@/lib/google-analytics-status"
);

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function connectedRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "connected",
    connected_at: "2026-08-15T09:00:00.000Z",
    error_message: null,
    provider_account_id: "properties/3322114455",
    provider_account_name: "Aurora Store GA4",
    metadata: { ga4PropertyId: "properties/3322114455" },
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
  vi.mocked(evidence.readLatestProviderReportSyncJob).mockResolvedValue(null);
  snapshotAnchor.value = null;
});

describe("getGoogleAnalyticsStatus", () => {
  it("reports not_connected when no GA4 connection row exists", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue(null);

    const status = await getGoogleAnalyticsStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("not_connected");
    expect(status.connected).toBe(false);
    expect(status.propertyReady).toBe(false);
    expect(status.snapshotReady).toBe(false);
  });

  it("names a stored connection that is no longer usable rather than hiding it", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue(
      connectedRow({ status: "expired", error_message: "token revoked" }),
    );

    const status = await getGoogleAnalyticsStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("action_required");
    expect(status.connected).toBe(false);
    expect(status.connectedAt).toBe("2026-08-15T09:00:00.000Z");
    expect(status.errorMessage).toBe("token revoked");
  });

  it("waits on the operator when no property has been selected", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue(
      connectedRow({ provider_account_id: null, metadata: {} }),
    );

    const status = await getGoogleAnalyticsStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("connected_no_property");
    expect(status.propertyReady).toBe(false);
    expect(status.property).toEqual({ id: null, name: "Aurora Store GA4" });
  });

  it("says awaiting_first_sync when nothing has landed and nothing is running", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue(
      connectedRow(),
    );

    const status = await getGoogleAnalyticsStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("awaiting_first_sync");
    expect(status.snapshotReady).toBe(false);
    expect(status.backfillPercent).toBeNull();
  });

  it("says syncing only while a warm job is genuinely in flight", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue(
      connectedRow(),
    );
    vi.mocked(evidence.readLatestProviderReportSyncJob).mockResolvedValue({
      status: "running",
      triggeredAt: new Date(NOW - 60_000).toISOString(),
      startedAt: new Date(NOW - 60_000).toISOString(),
      completedAt: null,
      errorMessage: null,
    });

    const status = await getGoogleAnalyticsStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("syncing");
    expect(status.propertyReady).toBe(true);
    expect(status.snapshotReady).toBe(false);
    // The importer exposes no share of the window, so none is reported.
    expect(status.backfillPercent).toBeNull();
  });

  it("stops calling a job in flight once it passes the stuck boundary", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue(
      connectedRow(),
    );
    vi.mocked(evidence.readLatestProviderReportSyncJob).mockResolvedValue({
      status: "running",
      triggeredAt: new Date(NOW - 16 * 60_000).toISOString(),
      startedAt: new Date(NOW - 16 * 60_000).toISOString(),
      completedAt: null,
      errorMessage: null,
    });

    const status = await getGoogleAnalyticsStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("first_sync_stalled");
  });

  it("reports a failed warm attempt as stalled, not as an import in progress", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue(
      connectedRow(),
    );
    vi.mocked(evidence.readLatestProviderReportSyncJob).mockResolvedValue({
      status: "failed",
      triggeredAt: new Date(NOW - 60_000).toISOString(),
      startedAt: new Date(NOW - 60_000).toISOString(),
      completedAt: new Date(NOW - 30_000).toISOString(),
      errorMessage: "ga4 quota exceeded",
    });

    const status = await getGoogleAnalyticsStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("first_sync_stalled");
    expect(status.latestSync?.errorMessage).toBe("ga4 quota exceeded");
  });

  it("reports ready once the anchor snapshot exists, even while a job runs", async () => {
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue(
      connectedRow(),
    );
    snapshotAnchor.value = "2026-08-16T04:00:00.000Z";
    vi.mocked(evidence.readLatestProviderReportSyncJob).mockResolvedValue({
      status: "running",
      triggeredAt: new Date(NOW - 60_000).toISOString(),
      startedAt: new Date(NOW - 60_000).toISOString(),
      completedAt: null,
      errorMessage: null,
    });

    const status = await getGoogleAnalyticsStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("ready");
    expect(status.snapshotReady).toBe(true);
    expect(status.snapshotAt).toBe("2026-08-16T04:00:00.000Z");
  });

  it("accepts the demo workspace's own property spelling", () => {
    const status = getDemoGoogleAnalyticsStatus();
    expect(status.connected).toBe(true);
    expect(status.state).toBe("ready");
    expect(status.property.id).toBe("properties/3322114455");
    expect(status.backfillPercent).toBeNull();
  });
});

describe("stale failure residue on a healthy GA4 row", () => {
  it("does not let a cleared-over error message name a fault that is not there", async () => {
    // `markIntegrationError` always sets status='error' with its message; a
    // message left on a row that is back to `connected` is residue.
    vi.mocked(integrations.getIntegrationMetadata).mockResolvedValue(
      connectedRow({ error_message: "a failure from three weeks ago" }),
    );
    snapshotAnchor.value = "2026-08-16T04:00:00.000Z";

    const status = await getGoogleAnalyticsStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("ready");
    // Still reported, because it is the last provider error on record.
    expect(status.errorMessage).toBe("a failure from three weeks ago");
  });
});
