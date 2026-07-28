import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const boundariesMock = vi.fn();
const schemaReadyMock = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: queryMock }),
  getDbWithTimeout: () => ({ query: queryMock }),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: (...args: unknown[]) => schemaReadyMock(...args),
}));

vi.mock("@/lib/provider-platform-date", async () => {
  const actual = await vi.importActual<typeof import("@/lib/provider-platform-date")>(
    "@/lib/provider-platform-date",
  );
  return {
    ...actual,
    getProviderPlatformDateBoundaries: (...args: unknown[]) => boundariesMock(...args),
  };
});

const { readGoogleAdsFreshness, toGoogleAdsFreshnessSummary, weakestGoogleAdsCompletion } =
  await import("./freshness-read");
const { unknownGoogleAdsCompletion, resolveGoogleAdsCompletion } = await import(
  "./completion-semantics"
);

const NOW = new Date("2026-07-28T12:00:00Z");

function boundary(providerAccountId: string, overrides: Record<string, unknown> = {}) {
  return {
    provider: "google" as const,
    businessId: "biz",
    providerAccountId,
    timeZone: "Europe/Istanbul",
    timeZoneSource: "account" as const,
    currentDate: "2026-07-28",
    previousDate: "2026-07-27",
    isPrimary: true,
    ...overrides,
  };
}

/**
 * Aggregate row shape returned by the freshness statement, and the coverage
 * statement's row shape. Postgres returns counts as strings via the driver, so
 * the fixtures use strings deliberately.
 */
function respond(input: {
  aggregate?: Array<Record<string, unknown>>;
  coverage?: Array<Record<string, unknown>>;
}) {
  queryMock.mockImplementation((text: string) => {
    if (text.includes("google_ads_day_finality")) {
      return Promise.resolve(input.aggregate ?? []);
    }
    return Promise.resolve(input.coverage ?? []);
  });
}

beforeEach(() => {
  queryMock.mockReset();
  boundariesMock.mockReset();
  schemaReadyMock.mockReset();
  boundariesMock.mockResolvedValue([boundary("acc-1")]);
  schemaReadyMock.mockResolvedValue({ ready: true });
});

describe("readGoogleAdsFreshness", () => {
  const range = {
    businessId: "biz",
    scopes: ["account_daily", "campaign_daily"] as const,
    startDate: "2026-07-21",
    endDate: "2026-07-27",
    now: NOW,
  };

  it("refuses to call a fully covered but never-re-read range complete", async () => {
    // THE ORIGINAL DEFECT, exactly: every day has rows, none was observed after
    // its day closed. Coverage alone used to render this as a green 100%.
    respond({
      aggregate: [],
      coverage: [
        { scope: "account_daily", covered_days: "7" },
        { scope: "campaign_daily", covered_days: "7" },
      ],
    });

    const snapshot = await readGoogleAdsFreshness(range);

    expect(snapshot.evidenceAvailable).toBe(true);
    expect(snapshot.overall.state).toBe("provisional");
    expect(snapshot.overall.percent).toBeLessThan(100);
    expect(snapshot.overall.complete).toBe(false);
    expect(snapshot.overall.mayStopPolling).toBe(false);
    expect(snapshot.scopes.account_daily.coveredDays).toBe(7);
    expect(snapshot.scopes.account_daily.postCloseObservedDays).toBe(0);
    // Nothing observed means everything is still outstanding work.
    expect(snapshot.scopes.account_daily.dueNowDays).toBe(7);
  });

  it("issues exactly two statements regardless of how many scopes are asked for", async () => {
    respond({ aggregate: [], coverage: [] });
    await readGoogleAdsFreshness({
      ...range,
      scopes: [
        "account_daily",
        "campaign_daily",
        "ad_group_daily",
        "ad_daily",
        "keyword_daily",
        "search_term_daily",
      ],
    });
    // The N+1 guard. Twelve scopes must not mean twelve round trips on the
    // hottest endpoint in the product.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("requires EVERY assigned account to have observed a day before counting it", async () => {
    boundariesMock.mockResolvedValue([
      boundary("acc-1"),
      boundary("acc-2", { isPrimary: false }),
    ]);
    respond({ aggregate: [], coverage: [] });
    await readGoogleAdsFreshness(range);

    const aggregateCall = queryMock.mock.calls.find((call) =>
      String(call[0]).includes("google_ads_day_finality"),
    );
    // The conjunctive threshold is the account count, so one account lagging
    // cannot be masked by the other being fresh. Asserted on the observed-days
    // filter SPECIFICALLY: an earlier version of this test matched the same
    // fragment in the exhausted-days filter and stayed green when the threshold
    // was weakened to `>= 1`.
    expect(aggregateCall?.[1]?.[6]).toBe(2);
    expect(String(aggregateCall?.[0])).toContain(
      "COUNT(*) FILTER (WHERE observed_accounts >= $7::int) AS observed_days",
    );
  });

  it("reports converging, never settled, while the conversion window is open", async () => {
    respond({
      aggregate: [
        { scope: "account_daily", observed_days: "7", exhausted_days: "0", due_days: "1" },
        { scope: "campaign_daily", observed_days: "7", exhausted_days: "0", due_days: "1" },
      ],
      coverage: [
        { scope: "account_daily", covered_days: "7" },
        { scope: "campaign_daily", covered_days: "7" },
      ],
    });

    const snapshot = await readGoogleAdsFreshness(range);
    expect(snapshot.overall.state).toBe("converging");
    expect(snapshot.overall.percent).toBe(99);
    expect(snapshot.overall.mayStopPolling).toBe(false);
  });

  it("settles only when every day is observed post-close AND past the lookback", async () => {
    respond({
      aggregate: [
        { scope: "account_daily", observed_days: "7", exhausted_days: "7", due_days: "0" },
        { scope: "campaign_daily", observed_days: "7", exhausted_days: "7", due_days: "0" },
      ],
      coverage: [
        { scope: "account_daily", covered_days: "7" },
        { scope: "campaign_daily", covered_days: "7" },
      ],
    });

    const snapshot = await readGoogleAdsFreshness(range);
    expect(snapshot.overall.state).toBe("settled");
    expect(snapshot.overall.percent).toBe(100);
    expect(snapshot.overall.mayStopPolling).toBe(true);
  });

  it("is only as complete as its weakest scope", async () => {
    respond({
      aggregate: [
        { scope: "account_daily", observed_days: "7", exhausted_days: "7", due_days: "0" },
        { scope: "campaign_daily", observed_days: "2", exhausted_days: "2", due_days: "5" },
      ],
      coverage: [
        { scope: "account_daily", covered_days: "7" },
        { scope: "campaign_daily", covered_days: "7" },
      ],
    });

    const snapshot = await readGoogleAdsFreshness(range);
    expect(snapshot.scopes.account_daily.verdict.state).toBe("settled");
    expect(snapshot.overall.state).toBe("provisional");
    expect(snapshot.overall.complete).toBe(false);
  });

  it("caps a range that reaches the account's open day", async () => {
    respond({
      aggregate: [
        { scope: "account_daily", observed_days: "8", exhausted_days: "8", due_days: "0" },
        { scope: "campaign_daily", observed_days: "8", exhausted_days: "8", due_days: "0" },
      ],
      coverage: [
        { scope: "account_daily", covered_days: "8" },
        { scope: "campaign_daily", covered_days: "8" },
      ],
    });

    const snapshot = await readGoogleAdsFreshness({ ...range, endDate: "2026-07-28" });
    expect(snapshot.includesOpenDay).toBe(true);
    expect(snapshot.overall.state).toBe("provisional");
    expect(snapshot.overall.percent).toBeLessThan(100);
  });

  it("treats the EARLIEST account day as the open boundary across timezones", async () => {
    // Auckland has already rolled to the 28th while Los Angeles is still on the
    // 27th. The business's 27th is therefore still open.
    boundariesMock.mockResolvedValue([
      boundary("acc-nz", { timeZone: "Pacific/Auckland", currentDate: "2026-07-28" }),
      boundary("acc-la", {
        timeZone: "America/Los_Angeles",
        currentDate: "2026-07-27",
        isPrimary: false,
      }),
    ]);
    respond({ aggregate: [], coverage: [] });

    const snapshot = await readGoogleAdsFreshness(range);
    expect(snapshot.includesOpenDay).toBe(true);
  });

  it("fails closed to unknown when no accounts are assigned", async () => {
    boundariesMock.mockResolvedValue([]);
    const snapshot = await readGoogleAdsFreshness(range);

    expect(snapshot.evidenceAvailable).toBe(false);
    expect(snapshot.overall.state).toBe("unknown");
    expect(snapshot.overall.complete).toBe(false);
    // Unknown means "we could not look", so the caller must come back.
    expect(snapshot.overall.mayStopPolling).toBe(false);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("fails closed to unknown when the schema is not ready", async () => {
    schemaReadyMock.mockRejectedValue(new Error("relation does not exist"));
    const snapshot = await readGoogleAdsFreshness(range);

    expect(snapshot.evidenceAvailable).toBe(false);
    expect(snapshot.overall.state).toBe("unknown");
    expect(snapshot.overall.mayStopPolling).toBe(false);
    expect(snapshot.scopes.account_daily.verdict.state).toBe("unknown");
  });

  it("fails closed to unknown when the read itself fails, and never throws", async () => {
    queryMock.mockRejectedValue(new Error("statement timeout"));
    const snapshot = await readGoogleAdsFreshness(range);

    expect(snapshot.evidenceAvailable).toBe(false);
    expect(snapshot.overall.state).toBe("unknown");
    expect(snapshot.overall.percent).toBe(0);
    expect(snapshot.overall.mayStopPolling).toBe(false);
  });

  it("assumes the range is still open when the account clock is untrustworthy", async () => {
    // A missing or invalid IANA zone must not let a UTC server settle a Los
    // Angeles day seven hours early.
    boundariesMock.mockResolvedValue([
      boundary("acc-1", { timeZone: "UTC", timeZoneSource: "default" }),
    ]);
    respond({
      aggregate: [
        { scope: "account_daily", observed_days: "7", exhausted_days: "7", due_days: "0" },
        { scope: "campaign_daily", observed_days: "7", exhausted_days: "7", due_days: "0" },
      ],
      coverage: [
        { scope: "account_daily", covered_days: "7" },
        { scope: "campaign_daily", covered_days: "7" },
      ],
    });

    const snapshot = await readGoogleAdsFreshness(range);
    expect(snapshot.timeZoneSource).toBe("default");
    expect(snapshot.includesOpenDay).toBe(true);
    expect(snapshot.overall.state).not.toBe("settled");
  });

  it("does not promote legacy pre-table rows to complete", async () => {
    // Rows written before the freshness table existed have coverage but no
    // evidence. They must read as provisional and remain due, not default to 100.
    respond({
      aggregate: [],
      coverage: [
        { scope: "account_daily", covered_days: "7" },
        { scope: "campaign_daily", covered_days: "7" },
      ],
    });

    const snapshot = await readGoogleAdsFreshness(range);
    expect(snapshot.overall.state).toBe("provisional");
    expect(snapshot.scopes.campaign_daily.dueNowDays).toBe(7);
  });
});

describe("weakestGoogleAdsCompletion", () => {
  it("ranks unknown below missing — an admission is weaker than a fact", () => {
    const verdict = weakestGoogleAdsCompletion([
      resolveGoogleAdsCompletion({
        totalDays: 3,
        coveredDays: 1,
        postCloseObservedDays: 1,
        lookbackExhaustedDays: 1,
        includesOpenDay: false,
      }),
      unknownGoogleAdsCompletion("read failed"),
    ]);
    expect(verdict.state).toBe("unknown");
  });

  it("returns unknown rather than a vacuous pass when nothing was evaluated", () => {
    expect(weakestGoogleAdsCompletion([]).state).toBe("unknown");
    expect(weakestGoogleAdsCompletion([]).mayStopPolling).toBe(false);
  });
});

describe("toGoogleAdsFreshnessSummary", () => {
  it("never labels a Google Ads range final or immutable", async () => {
    respond({
      aggregate: [
        { scope: "account_daily", observed_days: "7", exhausted_days: "7", due_days: "0" },
      ],
      coverage: [{ scope: "account_daily", covered_days: "7" }],
    });
    const summary = toGoogleAdsFreshnessSummary(
      await readGoogleAdsFreshness({
        businessId: "biz",
        scopes: ["account_daily"],
        startDate: "2026-07-21",
        endDate: "2026-07-27",
        now: NOW,
      }),
    );

    expect(summary.state).toBe("settled");
    expect(summary.label).toBe("Policy-settled");
    expect(summary.label.toLowerCase()).not.toMatch(/final|immutable|frozen/);
    // The lookback the verdict was measured against is published, so a client
    // can qualify the claim instead of implying Google promised it.
    expect(summary.conversionLookbackDays).toBeGreaterThan(0);
    expect(summary.conversionLookbackDays).toBeLessThanOrEqual(90);
  });

  it("carries the fail-closed reason to the wire", async () => {
    boundariesMock.mockResolvedValue([]);
    const summary = toGoogleAdsFreshnessSummary(
      await readGoogleAdsFreshness({
        businessId: "biz",
        scopes: ["account_daily"],
        startDate: "2026-07-21",
        endDate: "2026-07-27",
        now: NOW,
      }),
    );
    expect(summary.evidenceAvailable).toBe(false);
    expect(summary.state).toBe("unknown");
    expect(summary.label).toBe("Unknown");
    expect(summary.unavailableReason).toMatch(/accounts/i);
    expect(summary.mayStopPolling).toBe(false);
  });
});
