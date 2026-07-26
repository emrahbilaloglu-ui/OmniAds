import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockSearchConsoleAuthError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = "SearchConsoleAuthError";
    this.code = code;
    this.status = status;
  }
}

const sql = vi.fn();

vi.mock("@/lib/sync/global-kill-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/global-kill-switch")>();
  return {
    ...actual,
    // Lanes default to OFF. Admission has its own suite
    // (source-ingest-admission.test.ts); this one is about what runs behind it.
    assertSyncLaneEnabled: vi.fn(() => ({
      lane: "source_ingest" as const,
      enabled: true,
      reason: "enabled" as const,
    })),
  };
});

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/db-growth-fence")>();
  return {
    ...actual,
    assertSyncGrowthBoundary: vi.fn(async () => ({
      allowed: true as const,
      reason: "ready" as const,
      warning: false,
      databaseBytes: 1,
      databaseBudgetBytes: 2,
      tableBytes: {},
      offender: null,
      evaluatedAt: "2026-07-26T00:00:00.000Z",
      errorMessage: null,
      overridden: false,
    })),
  };
});
vi.mock("@/lib/search-console", () => ({
  resolveSearchConsoleContext: vi.fn(),
  SearchConsoleAuthError: MockSearchConsoleAuthError,
}));

vi.mock("@/lib/seo/intelligence", () => ({
  fetchSearchConsoleAnalyticsRows: vi.fn(),
  buildSeoOverviewPayload: vi.fn(),
}));

vi.mock("@/lib/seo/findings", () => ({
  buildSeoTechnicalFindings: vi.fn(),
}));

vi.mock("@/lib/seo/results-cache-writer", () => ({
  writeSeoResultsCacheEntry: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `${businessId}-ref`] as const),
    );
  }),
}));

const searchConsole = await import("@/lib/search-console");
const intelligence = await import("@/lib/seo/intelligence");
const findings = await import("@/lib/seo/findings");
const resultsCacheWriter = await import("@/lib/seo/results-cache-writer");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const { ProviderRequestCooldownError } = await import("@/lib/provider-request-governance");
const { syncSearchConsoleReports } = await import("@/lib/sync/search-console-sync");

describe("syncSearchConsoleReports", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));
    vi.resetAllMocks();
    sql.mockResolvedValue([]);
    vi.mocked(searchConsole.resolveSearchConsoleContext).mockResolvedValue({
      accessToken: "token",
      siteUrl: "https://example.com",
    } as never);
    vi.mocked(intelligence.fetchSearchConsoleAnalyticsRows).mockResolvedValue([
      { keys: ["/"], clicks: 12 },
    ] as never);
    vi.mocked(intelligence.buildSeoOverviewPayload).mockResolvedValue({
      summary: { clicks: 12 },
    } as never);
    vi.mocked(findings.buildSeoTechnicalFindings).mockResolvedValue({
      summary: { critical: 0, warning: 1, opportunity: 0 },
      findings: [],
    } as never);
    vi.mocked(resultsCacheWriter.writeSeoResultsCacheEntry).mockResolvedValue(undefined);
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warms overview and findings caches through the search-console sync owner", async () => {
    const result = await syncSearchConsoleReports("biz_1");

    expect(resultsCacheWriter.writeSeoResultsCacheEntry).toHaveBeenCalledTimes(4);
    expect(
      vi.mocked(resultsCacheWriter.writeSeoResultsCacheEntry).mock.calls.map(
        ([input]) => input.cacheType,
      ),
    ).toEqual(["overview", "findings", "overview", "findings"]);
    expect(result).toEqual({
      businessId: "biz_1",
      attempted: 2,
      succeeded: 2,
      failed: 0,
      skipped: false,
    });
    expect(
      sql.mock.calls.some(([strings]) =>
        String((strings as TemplateStringsArray).join(" ")).includes("business_ref_id"),
      ),
    ).toBe(true);
  });

  it("skips warming when Search Console auth is unavailable", async () => {
    vi.mocked(searchConsole.resolveSearchConsoleContext).mockRejectedValue(
      new searchConsole.SearchConsoleAuthError(
        "search_console_not_connected",
        "Not connected",
        404,
      ),
    );

    const result = await syncSearchConsoleReports("biz_1");

    expect(result).toEqual({
      businessId: "biz_1",
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: true,
    });
    expect(resultsCacheWriter.writeSeoResultsCacheEntry).not.toHaveBeenCalled();
  });

  it("stops after cooldown suppression instead of hammering later windows", async () => {
    vi.mocked(intelligence.fetchSearchConsoleAnalyticsRows)
      .mockRejectedValueOnce(
        new ProviderRequestCooldownError({
          provider: "search_console",
          businessId: "biz_1",
          requestType: "seo_overview:abc",
          message: "cooldown",
          retryAfterMs: 60_000,
          status: 503,
        }),
      )
      .mockResolvedValue([
        { keys: ["/"], clicks: 12 },
      ] as never);

    const result = await syncSearchConsoleReports("biz_1");

    expect(result).toEqual({
      businessId: "biz_1",
      attempted: 2,
      succeeded: 0,
      failed: 1,
      skipped: false,
    });
    expect(intelligence.fetchSearchConsoleAnalyticsRows).toHaveBeenCalledTimes(2);
    expect(resultsCacheWriter.writeSeoResultsCacheEntry).not.toHaveBeenCalled();
  });
});
