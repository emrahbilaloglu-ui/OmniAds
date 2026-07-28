import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

vi.mock("@/lib/google-ads/warehouse", () => ({
  forceReplayGoogleAdsPoisonedPartitions: vi.fn(),
  getGoogleAdsCoveredDates: vi.fn(),
  replayGoogleAdsDeadLetterPartitions: vi.fn(),
}));

vi.mock("@/lib/google-ads/freshness-read", async () => {
  const actual = await vi.importActual<typeof import("@/lib/google-ads/freshness-read")>(
    "@/lib/google-ads/freshness-read",
  );
  // Only the DB read is faked; the verdict mapping stays real.
  return { ...actual, readGoogleAdsFreshness: vi.fn() };
});

vi.mock("@/lib/google-ads/history", () => ({
  addDaysToIsoDate: vi.fn((date: string, days: number) => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }),
  enumerateDays: vi.fn(() => ["2026-04-07"]),
}));

vi.mock("@/lib/sync/google-ads-sync", () => ({
  refreshGoogleAdsSyncStateForBusiness: vi.fn(),
  runGoogleAdsTargetedRepair: vi.fn(),
}));

vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn(),
}));

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const warehouse = await import("@/lib/google-ads/warehouse");
const freshnessRead = await import("@/lib/google-ads/freshness-read");
const googleAdsSync = await import("@/lib/sync/google-ads-sync");
const migrations = await import("@/lib/migrations");
const { resolveGoogleAdsCompletion, unknownGoogleAdsCompletion } = await import(
  "@/lib/google-ads/completion-semantics"
);
const { POST } = await import("@/app/api/google-ads/repair-recent-gap/route");

const REPAIR_SCOPES = ["product_daily", "search_term_daily", "campaign_daily"] as const;

/** One-day window (the `enumerateDays` mock yields exactly "2026-04-07"). */
function freshnessSnapshot(input: {
  postCloseObservedDays: number;
  lookbackExhaustedDays?: number;
}) {
  const verdict = resolveGoogleAdsCompletion({
    totalDays: 1,
    coveredDays: 1,
    postCloseObservedDays: input.postCloseObservedDays,
    lookbackExhaustedDays: input.lookbackExhaustedDays ?? 0,
    includesOpenDay: false,
  });
  return {
    businessId: "biz",
    startDate: "2026-04-07",
    endDate: "2026-04-07",
    totalDays: 1,
    providerAccountIds: ["acc_1"],
    timeZoneSource: "account" as const,
    includesOpenDay: false,
    evidenceAvailable: true,
    unavailableReason: null,
    scopes: Object.fromEntries(
      REPAIR_SCOPES.map((scope) => [
        scope,
        {
          scope,
          coveredDays: 1,
          postCloseObservedDays: input.postCloseObservedDays,
          lookbackExhaustedDays: input.lookbackExhaustedDays ?? 0,
          dueNowDays: 1 - input.postCloseObservedDays,
          oldestObservationAt: null,
          latestObservationAt: null,
          verdict,
        },
      ]),
    ),
    overall: verdict,
  };
}

function unavailableSnapshot(reason: string) {
  const verdict = unknownGoogleAdsCompletion(reason);
  return {
    businessId: "biz",
    startDate: "2026-04-07",
    endDate: "2026-04-07",
    totalDays: 1,
    providerAccountIds: [] as string[],
    timeZoneSource: "default" as const,
    includesOpenDay: true,
    evidenceAvailable: false,
    unavailableReason: reason,
    scopes: Object.fromEntries(
      REPAIR_SCOPES.map((scope) => [
        scope,
        {
          scope,
          coveredDays: 0,
          postCloseObservedDays: 0,
          lookbackExhaustedDays: 0,
          dueNowDays: 0,
          oldestObservationAt: null,
          latestObservationAt: null,
          verdict,
        },
      ]),
    ),
    overall: verdict,
  };
}

describe("POST /api/google-ads/repair-recent-gap", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
    vi.mocked(warehouse.getGoogleAdsCoveredDates).mockResolvedValue(["2026-04-07"] as never);
    vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
      freshnessSnapshot({ postCloseObservedDays: 1, lookbackExhaustedDays: 1 }) as never,
    );
    vi.mocked(db.getDb).mockReturnValue(vi.fn().mockResolvedValue([]) as never);
  });

  it("fails fast when repair tables are not ready", async () => {
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: ["google_ads_sync_jobs"],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });

    const request = new NextRequest(
      "http://localhost/api/google-ads/repair-recent-gap?businessId=biz",
      { method: "POST", body: JSON.stringify({}) },
    );
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      error: "schema_not_ready",
      message:
        "Google Ads recent-gap repair is unavailable until request-external migrations are applied.",
      provider: "google_ads",
      missingTables: ["google_ads_sync_jobs"],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
    expect(warehouse.getGoogleAdsCoveredDates).not.toHaveBeenCalled();
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });

  it("preserves the no-gap response contract without migrations", async () => {
    const request = new NextRequest(
      "http://localhost/api/google-ads/repair-recent-gap?businessId=biz",
      { method: "POST", body: JSON.stringify({}) },
    );
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        outcome: "no_missing_recent_gap",
        targetWindow: expect.objectContaining({
          startDate: expect.any(String),
          endDate: expect.any(String),
          source: "recent_window",
        }),
        chosenScope: null,
        chosenStartDate: null,
        chosenEndDate: null,
        reason:
          "No missing recent gap found in search_term_daily, product_daily, or campaign_daily.",
      }),
    );
    // Every day covered, re-read after close, and past the lookback: the only
    // shape in which this endpoint may say it is done.
    expect(payload.complete).toBe(true);
    expect(payload.retryable).toBe(false);
    expect(payload.completionState).toBe("settled");
    expect(googleAdsSync.runGoogleAdsTargetedRepair).not.toHaveBeenCalled();
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });

  it("does not report a covered-but-never-re-read window as complete", async () => {
    // Coverage is FULL — the old gate's entire input — but the day has never
    // been fetched again since it closed.
    vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
      freshnessSnapshot({ postCloseObservedDays: 0 }) as never,
    );

    const request = new NextRequest(
      "http://localhost/api/google-ads/repair-recent-gap?businessId=biz",
      { method: "POST", body: JSON.stringify({}) },
    );
    const payload = await (await POST(request)).json();

    expect(payload.outcome).toBe("no_missing_recent_gap");
    expect(payload.complete).toBe(false);
    expect(payload.retryable).toBe(true);
    expect(payload.completionState).toBe("provisional");
    expect(payload.unreobservedScopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "campaign_daily", unreobservedDays: 1 }),
      ]),
    );
    expect(payload.reason).toContain("never re-read since they closed");
    // The rolling refresh owns those days; this endpoint must not widen its
    // repair scope to the whole window.
    expect(googleAdsSync.runGoogleAdsTargetedRepair).not.toHaveBeenCalled();
  });

  it("fails closed and stays retryable when the freshness evidence is unreadable", async () => {
    vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
      unavailableSnapshot("Google Ads freshness tables are not ready yet.") as never,
    );

    const request = new NextRequest(
      "http://localhost/api/google-ads/repair-recent-gap?businessId=biz",
      { method: "POST", body: JSON.stringify({}) },
    );
    const payload = await (await POST(request)).json();

    expect(payload.complete).toBe(false);
    expect(payload.retryable).toBe(true);
    expect(payload.completionState).toBe("unknown");
    expect(payload.freshness).toEqual(
      expect.objectContaining({ evidenceAvailable: false, mayStopPolling: false }),
    );
    expect(payload.reason).toContain("recency could not be verified");
  });

  it("still repairs genuinely missing days from row existence alone", async () => {
    // Zero rows for the day: a real gap, detected exactly as before and
    // unaffected by any freshness verdict.
    vi.mocked(warehouse.getGoogleAdsCoveredDates).mockResolvedValue([] as never);
    vi.mocked(freshnessRead.readGoogleAdsFreshness).mockResolvedValue(
      freshnessSnapshot({ postCloseObservedDays: 1, lookbackExhaustedDays: 1 }) as never,
    );
    vi.mocked(warehouse.forceReplayGoogleAdsPoisonedPartitions).mockResolvedValue({
      partitions: [],
    } as never);
    vi.mocked(warehouse.replayGoogleAdsDeadLetterPartitions).mockResolvedValue({
      partitions: [],
    } as never);
    vi.mocked(googleAdsSync.runGoogleAdsTargetedRepair).mockResolvedValue({
      outcome: "coverage_increased",
    } as never);
    vi.mocked(googleAdsSync.refreshGoogleAdsSyncStateForBusiness).mockResolvedValue(
      undefined as never,
    );

    const request = new NextRequest(
      "http://localhost/api/google-ads/repair-recent-gap?businessId=biz",
      { method: "POST", body: JSON.stringify({}) },
    );
    const payload = await (await POST(request)).json();

    expect(payload.outcome).toBe("coverage_increased");
    expect(payload.chosenScope).toBe("product_daily");
    expect(payload.chosenDate).toBe("2026-04-07");
    expect(googleAdsSync.runGoogleAdsTargetedRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "product_daily",
        startDate: "2026-04-07",
        endDate: "2026-04-07",
      }),
    );
  });
});
