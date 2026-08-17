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
        : [{ generated_at: snapshotAnchor.value }],
  ),
}));

const integrations = await import("@/lib/integrations");
const businessMode = await import("@/lib/business-mode.server");
const evidence = await import("@/lib/provider-report-sync-evidence");
const {
  getSearchConsoleStatus,
  getDemoSearchConsoleStatus,
  SEARCH_CONSOLE_REQUIRED_GOOGLE_SCOPE,
} = await import("@/lib/search-console-status");

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function searchConsoleRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "connected",
    connected_at: "2026-08-15T09:00:00.000Z",
    error_message: null,
    provider_account_id: "sc-domain:aurora.example",
    provider_account_name: "aurora.example",
    scopes: null,
    metadata: { siteUrl: "sc-domain:aurora.example" },
    ...overrides,
  } as never;
}

function googleRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "connected",
    connected_at: "2026-08-15T09:00:00.000Z",
    error_message: null,
    provider_account_id: "493-118-2201",
    provider_account_name: "Aurora US",
    scopes: `https://www.googleapis.com/auth/adwords ${SEARCH_CONSOLE_REQUIRED_GOOGLE_SCOPE}`,
    metadata: {},
    ...overrides,
  } as never;
}

/** `getIntegrationMetadata` is called for `search_console` then `google`. */
function connections(
  searchConsole: unknown,
  google: unknown = googleRow(),
) {
  vi.mocked(integrations.getIntegrationMetadata).mockImplementation(
    (async (_businessId: string, provider: string) =>
      provider === "search_console" ? searchConsole : google) as never,
  );
}

beforeEach(() => {
  vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
  vi.mocked(evidence.readLatestProviderReportSyncJob).mockResolvedValue(null);
  snapshotAnchor.value = null;
});

describe("getSearchConsoleStatus", () => {
  it("reports not_connected when no Search Console row exists", async () => {
    connections(null);

    const status = await getSearchConsoleStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("not_connected");
    expect(status.connected).toBe(false);
    expect(status.googleAuthority).toEqual({
      connected: true,
      hasSearchConsoleScope: true,
    });
  });

  it("says action_required when the Google connection it reads through is gone", async () => {
    connections(searchConsoleRow(), null);

    const status = await getSearchConsoleStatus(BUSINESS_ID, NOW);

    expect(status.connected).toBe(true);
    expect(status.state).toBe("action_required");
    expect(status.googleAuthority).toEqual({
      connected: false,
      hasSearchConsoleScope: false,
    });
  });

  it("says action_required when Google is connected without the webmasters scope", async () => {
    connections(
      searchConsoleRow(),
      googleRow({ scopes: "https://www.googleapis.com/auth/adwords" }),
    );

    const status = await getSearchConsoleStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("action_required");
    expect(status.googleAuthority.hasSearchConsoleScope).toBe(false);
  });

  it("waits on the operator when no site has been selected", async () => {
    connections(
      searchConsoleRow({ provider_account_id: null, metadata: {} }),
    );

    const status = await getSearchConsoleStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("connected_no_site");
    expect(status.siteReady).toBe(false);
    expect(status.site).toEqual({ url: null, type: null });
  });

  it("says awaiting_first_sync when nothing has landed and nothing is running", async () => {
    connections(searchConsoleRow());

    const status = await getSearchConsoleStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("awaiting_first_sync");
    expect(status.site).toEqual({
      url: "sc-domain:aurora.example",
      type: "domain",
    });
    expect(status.backfillPercent).toBeNull();
  });

  it("says syncing only while a warm job is genuinely in flight", async () => {
    connections(searchConsoleRow());
    vi.mocked(evidence.readLatestProviderReportSyncJob).mockResolvedValue({
      status: "running",
      triggeredAt: new Date(NOW - 30_000).toISOString(),
      startedAt: new Date(NOW - 30_000).toISOString(),
      completedAt: null,
      errorMessage: null,
    });

    const status = await getSearchConsoleStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("syncing");
    expect(status.siteReady).toBe(true);
    expect(status.snapshotReady).toBe(false);
    expect(status.backfillPercent).toBeNull();
  });

  it("stops calling a job in flight once it passes the stuck boundary", async () => {
    connections(searchConsoleRow());
    vi.mocked(evidence.readLatestProviderReportSyncJob).mockResolvedValue({
      status: "running",
      triggeredAt: new Date(NOW - 16 * 60_000).toISOString(),
      startedAt: new Date(NOW - 16 * 60_000).toISOString(),
      completedAt: null,
      errorMessage: null,
    });

    const status = await getSearchConsoleStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("first_sync_stalled");
  });

  it("reports ready once the SEO overview cache exists", async () => {
    connections(searchConsoleRow());
    snapshotAnchor.value = "2026-08-16T05:30:00.000Z";

    const status = await getSearchConsoleStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("ready");
    expect(status.snapshotReady).toBe(true);
    expect(status.snapshotAt).toBe("2026-08-16T05:30:00.000Z");
  });

  it("classifies a url-prefix site as such", async () => {
    connections(
      searchConsoleRow({
        provider_account_id: "https://aurora.example/",
        metadata: { siteUrl: "https://aurora.example/" },
      }),
    );

    const status = await getSearchConsoleStatus(BUSINESS_ID, NOW);

    expect(status.site).toEqual({
      url: "https://aurora.example/",
      type: "url-prefix",
    });
  });

  it("never claims the demo workspace holds a Google scope it does not have", () => {
    const status = getDemoSearchConsoleStatus();
    expect(status.connected).toBe(true);
    expect(status.state).toBe("ready");
    expect(status.site.url).toBe("sc-domain:urbantrail.co");
    expect(status.googleAuthority.hasSearchConsoleScope).toBe(false);
    expect(status.backfillPercent).toBeNull();
  });
});

describe("stale failure residue on a healthy Search Console row", () => {
  it("does not let a cleared-over error message name a fault that is not there", async () => {
    connections(
      searchConsoleRow({ error_message: "a failure from three weeks ago" }),
    );
    snapshotAnchor.value = "2026-08-16T05:30:00.000Z";

    const status = await getSearchConsoleStatus(BUSINESS_ID, NOW);

    expect(status.state).toBe("ready");
    expect(status.errorMessage).toBe("a failure from three weeks ago");
  });
});
