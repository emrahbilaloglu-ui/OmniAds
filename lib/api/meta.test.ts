import { beforeEach, describe, expect, it, vi } from "vitest";

// Current inventory is now a separately admitted account-current unit, so the
// path crosses the growth fence. Default-admit here; refusal is proven in
// lib/sync/db-growth-fence.test.ts and the retention seam.
vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertSyncGrowthBoundary: vi.fn(async () => ({ allowed: true, reason: "ready" })),
  };
});

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/meta/config-snapshots", () => ({
  appendMetaConfigSnapshots: vi.fn(),
  readLatestMetaConfigSnapshots: vi.fn(),
  readPreviousDifferentMetaConfigDiffs: vi.fn(),
}));

vi.mock("@/lib/meta/configuration", () => ({
  buildConfigSnapshotPayload: vi.fn(),
  summarizeCampaignConfig: vi.fn(),
}));

vi.mock("@/lib/meta/entity-state-history", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/entity-state-history")>();
  return {
    ...actual,
    persistMetaEntityObservation: vi.fn().mockResolvedValue({
      runId: "observation-run-1",
      runHash: "a".repeat(64),
      semanticHash: "b".repeat(64),
      coalesced: false,
      repeatCount: 1,
      stateCount: 0,
      lineageCount: 0,
      completeness: "complete",
      observedAt: "2026-07-12T12:00:00.000Z",
      capturedAt: "2026-07-12T12:00:01.000Z",
    }),
    persistMetaExplicitEntityTombstone: vi.fn(),
  };
});

vi.mock("@/lib/meta/warehouse", () => ({
  createMetaAuthoritativeReconciliationEvent: vi
    .fn()
    .mockResolvedValue({ id: "event-1" }),
  createMetaAuthoritativeSliceVersion: vi
    .fn()
    .mockImplementation(async (input) => ({
      id: `${input.surface}-slice`,
      ...input,
      candidateVersion: input.candidateVersion ?? 1,
    })),
  createMetaAuthoritativeSourceManifest: vi
    .fn()
    .mockResolvedValue({ id: "manifest-1" }),
  buildMetaSyncCheckpointHash: vi.fn(() => "checkpoint-hash"),
  getMetaSyncCheckpoint: vi.fn(),
  getMetaActivePublishedSliceVersion: vi.fn().mockResolvedValue(null),
  heartbeatMetaPartitionLease: vi.fn().mockResolvedValue(true),
  listMetaRawSnapshotsForRun: vi.fn().mockResolvedValue([]),
  publishMetaAuthoritativeSliceVersion: vi
    .fn()
    .mockResolvedValue({ id: "publication-1" }),
  buildMetaRawSnapshotHash: vi.fn(() => "snapshot-hash"),
  createMetaSyncJob: vi.fn(),
  persistMetaRawSnapshot: vi.fn().mockResolvedValue("snapshot-id"),
  deleteMetaSyncCheckpointsForPartition: vi.fn().mockResolvedValue(1),
  supersedeMetaRawSnapshotsForPartition: vi.fn().mockResolvedValue(1),
  replaceMetaAccountDailySlice: vi.fn().mockResolvedValue(undefined),
  replaceMetaAdDailySlice: vi.fn().mockResolvedValue(undefined),
  replaceMetaCampaignDailySlice: vi.fn().mockResolvedValue(undefined),
  replaceMetaAdSetDailySlice: vi.fn().mockResolvedValue(undefined),
  replaceMetaBreakdownDailySlice: vi.fn().mockResolvedValue(undefined),
  refreshMetaAccountDailyOverviewSummary: vi.fn().mockResolvedValue(undefined),
  upsertMetaSyncCheckpoint: vi.fn().mockResolvedValue("checkpoint-id"),
  upsertMetaSyncPhaseTiming: vi.fn().mockResolvedValue("phase-timing-id"),
  updateMetaSyncJob: vi.fn(),
  upsertMetaAccountDailyRows: vi.fn().mockResolvedValue(undefined),
  upsertMetaAdDailyRows: vi.fn().mockResolvedValue(undefined),
  upsertMetaAdSetDailyRows: vi.fn().mockResolvedValue(undefined),
  upsertMetaCampaignDailyRows: vi.fn().mockResolvedValue(undefined),
  appendMetaCurrentConfigHistory: vi.fn().mockResolvedValue({
    campaignRowsWritten: 0,
    adsetRowsWritten: 0,
    campaignSkippedIncompleteReceipt: false,
    adsetSkippedIncompleteReceipt: false,
  }),
  updateMetaAuthoritativeSliceVersion: vi
    .fn()
    .mockImplementation(async (input) => input),
  updateMetaAuthoritativeSourceManifest: vi
    .fn()
    .mockImplementation(async (input) => input),
}));

const warehouse = await import("@/lib/meta/warehouse");
const configSnapshots = await import("@/lib/meta/config-snapshots");
const configuration = await import("@/lib/meta/configuration");
const entityStateHistory = await import("@/lib/meta/entity-state-history");
const {
  fetchMetaActiveAdConfigsReceipt,
  fetchMetaPagedCollectionReceipt,
  getAdSets,
  getCampaigns,
  resolveMetaCurrencyForAccount,
  syncMetaAccountBreakdownWarehouseDay,
  syncMetaAccountCoreWarehouseDay,
} = await import("@/lib/api/meta");
const { classifyMetaSyncFailure } = await import(
  "@/lib/sync/meta-error-classification"
);
const { durableMetaFailureMessage } = await import("@/lib/sync/meta-sync");
const runtimeLogging = await import("@/lib/runtime-logging");

/**
 * A `Response` with the JSON body and status a stubbed Graph call answers with.
 * Local to this file so the refusal fixtures below read as bodies, not as
 * Response plumbing.
 */
function jsonResponseFor(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Meta pagination receipts", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("requests only effective ACTIVE Ads for the Decisions inventory", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "120000000000000001",
                status: "ACTIVE",
                effective_status: "ACTIVE",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaActiveAdConfigsReceipt(
      "act_1",
      "test-token",
    );

    expect(receipt).toMatchObject({
      complete: true,
      termination: "natural_end",
      rows: [{ id: "120000000000000001" }],
    });
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.searchParams.get("fields")).toContain(
      "campaign{id,name}",
    );
    expect(JSON.parse(requested.searchParams.get("filtering") ?? "[]")).toEqual(
      [
        {
          field: "effective_status",
          operator: "IN",
          value: ["ACTIVE"],
        },
      ],
    );
  });

  it("returns an explicit partial receipt at the page cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [{ id: "campaign-1" }],
              paging: {
                next: "https://graph.facebook.com/v25.0/next?access_token=secret",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const receipt = await fetchMetaPagedCollectionReceipt<{ id: string }>(
      "https://graph.facebook.com/v25.0/start?access_token=secret",
      { pageLimit: 1 },
    );

    expect(receipt).toMatchObject({
      rows: [{ id: "campaign-1" }],
      pageCount: 1,
      complete: false,
      termination: "page_cap",
      failure: { kind: "page_cap", pageIndex: 1 },
    });
    expect(receipt.failure?.pageUrl).not.toContain("secret");
    expect(
      entityStateHistory.persistMetaExplicitEntityTombstone,
    ).not.toHaveBeenCalled();
  });

  it("keeps fetched rows but marks a later HTTP failure partial", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: "ad-1" }],
            paging: { next: "https://graph.facebook.com/v25.0/page-2" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaPagedCollectionReceipt<{ id: string }>(
      "https://graph.facebook.com/v25.0/page-1",
    );

    expect(receipt).toMatchObject({
      rows: [{ id: "ad-1" }],
      pageCount: 1,
      complete: false,
      termination: "http_failure",
      failure: { httpStatus: 429 },
    });
  });

  it("does not mark field narrowing recovered when its 2xx body has no data array", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponseFor(
          {
            error: {
              message: "Unsupported field",
              code: 100,
            },
          },
          400,
        ),
      )
      .mockResolvedValueOnce(jsonResponseFor({ data: { id: "not-an-array" } }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaPagedCollectionReceipt<{ id: string }>(
      "https://graph.facebook.com/v25.0/campaigns?fields=id,optional_metric&access_token=secret",
      {
        maxAttemptsPerPage: 1,
        optionalFields: ["optional_metric"],
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get("fields")).toBe("id");
    expect(receipt).toMatchObject({
      rows: [],
      pageCount: 0,
      complete: false,
      termination: "parse_failure",
      fieldDegradation: {
        droppedFields: ["optional_metric"],
        recovered: false,
        cause: { kind: "http_failure", httpStatus: 400 },
      },
    });
  });

  it("marks field narrowing recovered after its 2xx body supplies a data array", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponseFor(
          {
            error: {
              message: "Unsupported field",
              code: 100,
            },
          },
          400,
        ),
      )
      .mockResolvedValueOnce(jsonResponseFor({ data: [{ id: "campaign-1" }] }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await fetchMetaPagedCollectionReceipt<{ id: string }>(
      "https://graph.facebook.com/v25.0/campaigns?fields=id,optional_metric&access_token=secret",
      {
        maxAttemptsPerPage: 1,
        optionalFields: ["optional_metric"],
      },
    );

    expect(receipt).toMatchObject({
      rows: [{ id: "campaign-1" }],
      pageCount: 1,
      complete: true,
      termination: "natural_end",
      fieldDegradation: {
        droppedFields: ["optional_metric"],
        recovered: true,
        cause: { kind: "http_failure", httpStatus: 400 },
      },
    });
  });
});

describe("syncMetaAccountCoreWarehouseDay", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "0";
    delete process.env.META_AUTHORITATIVE_FINALIZATION_CANARY_BUSINESSES;
    vi.mocked(warehouse.heartbeatMetaPartitionLease).mockResolvedValue(true);
    vi.mocked(warehouse.listMetaRawSnapshotsForRun).mockResolvedValue([]);
    vi.mocked(warehouse.persistMetaRawSnapshot).mockResolvedValue(
      "snapshot-id",
    );
    vi.mocked(
      warehouse.deleteMetaSyncCheckpointsForPartition,
    ).mockResolvedValue(1);
    vi.mocked(
      warehouse.supersedeMetaRawSnapshotsForPartition,
    ).mockResolvedValue(1);
    vi.mocked(warehouse.upsertMetaAccountDailyRows).mockResolvedValue(
      undefined,
    );
    vi.mocked(warehouse.upsertMetaCampaignDailyRows).mockResolvedValue(
      undefined,
    );
    vi.mocked(warehouse.upsertMetaAdSetDailyRows).mockResolvedValue(undefined);
    vi.mocked(warehouse.upsertMetaAdDailyRows).mockResolvedValue(undefined);
    vi.mocked(
      warehouse.refreshMetaAccountDailyOverviewSummary,
    ).mockResolvedValue(undefined);
    vi.mocked(
      warehouse.createMetaAuthoritativeSourceManifest,
    ).mockResolvedValue({
      id: "manifest-1",
    } as never);
    vi.mocked(warehouse.createMetaAuthoritativeSliceVersion).mockImplementation(
      async (input) =>
        ({
          id: `${input.surface}-slice`,
          ...input,
          candidateVersion: input.candidateVersion ?? 1,
        }) as never,
    );
    vi.mocked(warehouse.publishMetaAuthoritativeSliceVersion).mockResolvedValue(
      {
        id: "publication-1",
      } as never,
    );
    vi.mocked(
      warehouse.updateMetaAuthoritativeSourceManifest,
    ).mockImplementation(async (input) => input as never);
    vi.mocked(warehouse.updateMetaAuthoritativeSliceVersion).mockImplementation(
      async (input) => input as never,
    );
    vi.mocked(
      warehouse.createMetaAuthoritativeReconciliationEvent,
    ).mockResolvedValue({
      id: "event-1",
    } as never);
    vi.mocked(warehouse.replaceMetaAccountDailySlice).mockImplementation(
      async (input) => {
        await warehouse.upsertMetaAccountDailyRows(input.rows as never);
      },
    );
    vi.mocked(warehouse.replaceMetaAdDailySlice).mockImplementation(
      async (input) => {
        await warehouse.upsertMetaAdDailyRows(input.rows as never, {
          writeMode: "authoritative_fact",
        });
      },
    );
    // The slice writers forward only their rows now. Config history is no
    // longer a side effect of a daily write at all — appendMetaCurrentConfigHistory
    // is its single author — so there is no flag left to forward.
    vi.mocked(warehouse.replaceMetaCampaignDailySlice).mockImplementation(
      async (input) => {
        await warehouse.upsertMetaCampaignDailyRows(input.rows as never);
      },
    );
    vi.mocked(warehouse.replaceMetaAdSetDailySlice).mockImplementation(
      async (input) => {
        await warehouse.upsertMetaAdSetDailyRows(input.rows as never);
      },
    );
    vi.mocked(warehouse.buildMetaSyncCheckpointHash).mockReturnValue(
      "checkpoint-hash",
    );
    vi.mocked(warehouse.upsertMetaSyncCheckpoint).mockResolvedValue(
      "checkpoint-id",
    );
    vi.mocked(warehouse.upsertMetaSyncPhaseTiming).mockResolvedValue(
      "phase-timing-id" as never,
    );
    vi.mocked(configSnapshots.appendMetaConfigSnapshots).mockResolvedValue(
      undefined,
    );
    vi.mocked(warehouse.appendMetaCurrentConfigHistory).mockResolvedValue({
      campaignRowsWritten: 0,
      adsetRowsWritten: 0,
      campaignSkippedIncompleteReceipt: false,
      adsetSkippedIncompleteReceipt: false,
    });
    vi.mocked(configSnapshots.readLatestMetaConfigSnapshots).mockResolvedValue(
      new Map(),
    );
    vi.mocked(
      configSnapshots.readPreviousDifferentMetaConfigDiffs,
    ).mockResolvedValue(new Map());
    vi.mocked(configuration.buildConfigSnapshotPayload).mockImplementation(
      (input) => ({
        campaignId: input.campaignId ?? null,
        objective: input.objective ?? null,
        optimizationGoal: input.optimizationGoal ?? null,
        bidStrategyType: input.bidStrategy ?? null,
        bidStrategyLabel: input.bidStrategy ?? null,
        manualBidAmount: input.manualBidAmount ?? null,
        bidValue: input.targetRoas ?? input.manualBidAmount ?? null,
        bidValueFormat:
          input.targetRoas != null
            ? "roas"
            : input.manualBidAmount != null
              ? "currency"
              : null,
        dailyBudget: input.dailyBudget ?? null,
        lifetimeBudget: input.lifetimeBudget ?? null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
      }),
    );
    vi.mocked(configuration.summarizeCampaignConfig).mockImplementation(
      (input) => {
        const firstAdset = input.adsets[0] ?? null;
        return {
          campaignId: input.campaignId ?? null,
          objective: null,
          optimizationGoal: firstAdset?.optimizationGoal ?? null,
          bidStrategyType: firstAdset?.bidStrategyType ?? null,
          bidStrategyLabel: firstAdset?.bidStrategyLabel ?? null,
          manualBidAmount: firstAdset?.manualBidAmount ?? null,
          bidValue: firstAdset?.bidValue ?? null,
          bidValueFormat: firstAdset?.bidValueFormat ?? null,
          previousManualBidAmount: null,
          previousBidValue: null,
          dailyBudget:
            input.campaignDailyBudget ?? firstAdset?.dailyBudget ?? null,
          lifetimeBudget:
            input.campaignLifetimeBudget ?? firstAdset?.lifetimeBudget ?? null,
          isBudgetMixed: false,
          isConfigMixed: false,
          isOptimizationGoalMixed: false,
          isBidStrategyMixed: false,
          isBidValueMixed: false,
        };
      },
    );
    vi.mocked(
      entityStateHistory.persistMetaEntityObservation,
    ).mockResolvedValue({
      runId: "observation-run-1",
      runHash: "a".repeat(64),
      semanticHash: "b".repeat(64),
      coalesced: false,
      repeatCount: 1,
      stateCount: 0,
      lineageCount: 0,
      completeness: "complete",
      observedAt: "2026-07-12T12:00:00.000Z",
      capturedAt: "2026-07-12T12:00:01.000Z",
      manifestKind: null,
      deltaStats: null,
    });
    vi.mocked(
      entityStateHistory.persistMetaExplicitEntityTombstone,
    ).mockReset();
    vi.unstubAllGlobals();
  });

  it("fails closed before core warehouse work when account currency is unavailable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncMetaAccountCoreWarehouseDay({
        credentials: {
          businessId: "biz-1",
          accessToken: "token-1",
          accountIds: ["act_1"],
          currency: null,
          accountProfiles: {
            act_1: { currency: null, timezone: "UTC", name: "Account 1" },
          },
        },
        accountId: "act_1",
        day: "2026-04-03",
        partitionId: "partition-1",
        workerId: "worker-1",
        leaseEpoch: 1,
        attemptCount: 1,
      }),
    ).rejects.toThrow("meta_currency_unavailable:core_warehouse:act_1");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaAccountDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaCampaignDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaAdSetDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaAdDailyRows).not.toHaveBeenCalled();
  });

  it("never borrows the primary account currency for a secondary account", () => {
    const credentials = {
      businessId: "biz-1",
      accessToken: "token-1",
      accountIds: ["act_primary", "act_secondary"],
      currency: "TRY",
      accountProfiles: {
        act_primary: { currency: "TRY", timezone: "UTC", name: "Primary" },
        act_secondary: { currency: null, timezone: "UTC", name: "Secondary" },
      },
    };

    expect(resolveMetaCurrencyForAccount(credentials, "act_primary")).toBe(
      "TRY",
    );
    expect(
      resolveMetaCurrencyForAccount(credentials, "act_secondary"),
    ).toBeNull();
  });

  it("does not refetch ad insights after restoring a completed terminal generation", async () => {
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue({
      phase: "bulk_upsert",
      pageIndex: 39,
      nextPageUrl: null,
      providerCursor: null,
      rowsFetched: 0,
      startedAt: "2026-04-03T03:00:00.000Z",
    } as never);
    vi.mocked(warehouse.listMetaRawSnapshotsForRun).mockResolvedValue([
      {
        id: "raw-page-38",
        page_index: 38,
        payload_json: [],
        provider_cursor: null,
        provider_http_status: 200,
        status: "fetched",
        fetched_at: "2026-04-03T03:00:01.000Z",
      },
    ] as never);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights") && url.includes("level=account")) {
        return new Response(JSON.stringify({ data: [{ spend: "0" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/campaigns") || url.includes("/adsets")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected refetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncMetaAccountCoreWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      accountId: "act_1",
      day: "2026-04-03",
      partitionId: "partition-terminal-resume",
      workerId: "worker-1",
      leaseEpoch: 12,
      attemptCount: 2,
      leaseMinutes: 15,
    });

    expect(
      vi
        .mocked(warehouse.persistMetaRawSnapshot)
        .mock.calls.filter(
          ([payload]) =>
            payload.partitionId === "partition-terminal-resume" &&
            payload.entityScope === "ad",
        ),
    ).toHaveLength(0);
    expect(
      fetchMock.mock.calls.some(
        ([url]) =>
          String(url).includes("/insights") &&
          !String(url).includes("level=account"),
      ),
    ).toBe(false);
  });

  it("writes no current config or entity evidence for a historical core warehouse day", async () => {
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                adset_id: "adset-1",
                adset_name: "Adset 1",
                ad_id: "ad-1",
                ad_name: "Ad 1",
                spend: "12.50",
                impressions: "100",
                clicks: "4",
                reach: "90",
                frequency: "1.11",
                ctr: "4.0",
                cpm: "125.0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cmp-1",
                name: "Campaign 1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                buying_type: "AUCTION",
                daily_budget: "25",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "7.5",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncMetaAccountCoreWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      accountId: "act_1",
      day: "2026-04-03",
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 11,
      attemptCount: 1,
      leaseMinutes: 15,
    });

    // 2026-04-03 is a HISTORICAL day. Campaign/adset/ad config endpoints return
    // the account's CURRENT inventory, so persisting it here would stamp
    // today's configuration onto a backfilled date — the amplification that
    // wrote current inventory once per day across a 761-day wave. The gate used
    // to be `truthState === "finalized"`, i.e. exactly inverted, so it fired
    // only on historical days. The day is still fetched and still enriches its
    // metric facts in memory; it just writes no config evidence.
    expect(configSnapshots.appendMetaConfigSnapshots).not.toHaveBeenCalled();
    // ZERO current-inventory provider calls. These endpoints have no date
    // filter, so asking them from a historical partition spends three calls per
    // backfilled day AND enriches that day with configuration that did not
    // exist then. Suppressing only the durable writes fixed the storage half and
    // none of the rest.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("buying_type")),
    ).toHaveLength(0);
    // The metric facts are still written, with NO configuration attached: a past
    // day genuinely has no current config, and null is the truthful answer.
    expect(warehouse.upsertMetaCampaignDailyRows).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          campaignId: "cmp-1",
          buyingType: null,
        }),
      ]),
    );
    // Entity observation runs carry `capturedAt: now()`, which is part of the
    // run identity, so a backfill wave produced a brand-new run and a fresh
    // state row per entity for EVERY historical day — dedupe only ever applied
    // within one run. That is the remaining source of meta_entity_state_history
    // growth, and it is evidence about the current inventory, so a historical
    // day must record none of it.
    expect(entityStateHistory.persistMetaEntityObservation).not.toHaveBeenCalled();
    expect(
      entityStateHistory.persistMetaExplicitEntityTombstone,
    ).not.toHaveBeenCalled();
  });

  it("records current config and entity evidence for the account's own today", async () => {
    // The gate is "the account's own local today", and the fixture account is
    // UTC, so this is deterministic without freezing the clock.
    const accountToday = new Date().toISOString().slice(0, 10);
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                adset_id: "adset-1",
                adset_name: "Adset 1",
                ad_id: "ad-1",
                ad_name: "Ad 1",
                spend: "12.50",
                impressions: "100",
                clicks: "4",
                reach: "90",
                frequency: "1.11",
                ctr: "4.0",
                cpm: "125.0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cmp-1",
                name: "Campaign 1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                buying_type: "AUCTION",
                daily_budget: "25",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "7.5",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncMetaAccountCoreWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      accountId: "act_1",
      day: accountToday,
      partitionId: "partition-1",
      /*
        ── ROUND 15, DEFECT 6 ───────────────────────────────────────────────
        The real `meta_sync_runs.id` for the attempt, as `processMetaPartition`
        supplies it. Distinct from `partitionId` (reused across retries) and
        from the observation `runId` (coalesced content), so the assertion
        below cannot pass by accident on either of those.
      */
      syncRunId: "11111111-2222-4333-8444-555555555555",
      workerId: "worker-1",
      leaseEpoch: 11,
      attemptCount: 1,
      leaseMinutes: 15,
    });

    // The account's own local today IS current evidence, so the same gate that
    // withholds everything on a historical day must let all of it through here.
    // Without this the amplification fix would have silently disabled real
    // current-state tracking, which is what A->B->A point-in-time depends on.
    expect(configSnapshots.appendMetaConfigSnapshots).toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("buying_type")),
    ).toBe(true);
    // The metric facts are still written — only the CURRENT-inventory evidence
    // is withheld — and the daily writer must be told not to append config
    // history for a historical day.
    // The daily writer takes rows and nothing else; there is no options object
    // left through which config history could be switched back on at a call site.
    for (const call of vi.mocked(warehouse.upsertMetaCampaignDailyRows).mock
      .calls) {
      expect(call).toHaveLength(1);
    }
    // Typed config history is written HERE, by its own call, not as a side
    // writers only ever fired for `truthState === "finalized"`, and current
    // evidence only exists on a PROVISIONAL today — mutually exclusive, so both
    // typed tables received nothing at all until this call existed.
    expect(warehouse.appendMetaCurrentConfigHistory).toHaveBeenCalledTimes(1);
    const currentConfigCall = vi.mocked(warehouse.appendMetaCurrentConfigHistory)
      .mock.calls[0]![0];
    expect(currentConfigCall.campaignRows.length).toBeGreaterThan(0);
    // A REAL observation timestamp from EACH level's own receipt, not a
    // synthetic midnight, not a clock read at write time, and not one level's
    // timestamp stamped onto the other. captured_at is part of the arbiter.
    expect(currentConfigCall.campaignReceipt.observedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    expect(currentConfigCall.campaignReceipt.observedAt).not.toContain(
      "T00:00:00.000Z",
    );
    expect(currentConfigCall.adsetReceipt.observedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    // Completeness travels with the receipt: a partial page set is missing
    // entities, and absence reads as deletion to anything downstream.
    expect(currentConfigCall.campaignReceipt.complete).toBe(true);
    expect(currentConfigCall.adsetReceipt.complete).toBe(true);
    /*
      ── ROUND 15, DEFECT 6: THE ATTEMPT REACHES BOTH RECEIPTS ──────────────

      Round 14 threaded `syncRunId` from `processMetaPartition` down to the
      receipt, and proved the column exists with a seeded reader test — which
      cannot see whether the shipped core-sync actually passes the value. This
      drives the real `syncMetaAccountCoreWarehouseDay` and reads the argument
      the real writer was called with, for CAMPAIGN and ADSET, which are the two
      endpoints the recent-edit authority reads.
    */
    const observationCalls = vi
      .mocked(entityStateHistory.persistMetaEntityObservation)
      .mock.calls.map(([call]) => call);
    for (const entityType of ["campaign", "adset"] as const) {
      const call = observationCalls.find((one) => one.entityType === entityType);
      expect(call, `${entityType} observation must be persisted`).toBeTruthy();
      expect(call!.captureReceipt?.syncRunId, entityType).toBe(
        "11111111-2222-4333-8444-555555555555",
      );
      // And it is not silently the partition or the observation run instead.
      expect(call!.captureReceipt?.syncRunId, entityType).not.toBe(
        call!.captureReceipt?.partitionId,
      );
    }

    const campaignObservationCall = observationCalls.find(
      (call) => call.entityType === "campaign",
    );
    expect(campaignObservationCall).toMatchObject({
      entityType: "campaign",
      completeness: "complete",
      states: [
        expect.objectContaining({
          entityId: "cmp-1",
          observedAt: "2026-07-01T09:30:00.000Z",
          providerUpdatedAt: "2026-07-01T09:30:00.000Z",
        }),
      ],
    });
    // The state's observedAt is the provider's own updated_time, not the day
    // being synced — that is what makes A->B->A reconstructable from real
    // current evidence.
    expect(campaignObservationCall?.states?.[0]?.observedAt).toBe(
      "2026-07-01T09:30:00.000Z",
    );
  });

  it("finalizes derived account_daily, adset_daily, and ad_daily checkpoints after core writes", async () => {
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockImplementation(
      async ({ checkpointScope }) => {
        if (checkpointScope === "core_ad_insights") {
          return null;
        }
        if (checkpointScope === "account_daily") {
          return { startedAt: "2026-04-03T20:44:30.156Z" } as never;
        }
        if (checkpointScope === "adset_daily") {
          return { startedAt: "2026-04-03T20:44:30.200Z" } as never;
        }
        if (checkpointScope === "ad_daily") {
          return { startedAt: "2026-04-03T20:44:30.240Z" } as never;
        }
        return null;
      },
    );

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                adset_id: "adset-1",
                adset_name: "Adset 1",
                ad_id: "ad-1",
                ad_name: "Ad 1",
                spend: "12.50",
                impressions: "100",
                clicks: "4",
                reach: "90",
                frequency: "1.11",
                ctr: "4.0",
                cpm: "125.0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "cmp-1", effective_status: "ACTIVE", status: "ACTIVE" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncMetaAccountCoreWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: {
            currency: "USD",
            timezone: "UTC",
            name: "Account 1",
          },
        },
      },
      accountId: "act_1",
      day: "2026-04-03",
      partitionId: "partition-1",
      workerId: "worker-1",
      leaseEpoch: 11,
      attemptCount: 1,
      leaseMinutes: 15,
    });

    const checkpointCalls = vi
      .mocked(warehouse.upsertMetaSyncCheckpoint)
      .mock.calls.map(([arg]) => arg);
    const accountFinalize = checkpointCalls.find(
      (call) =>
        call.checkpointScope === "account_daily" && call.phase === "finalize",
    );
    const adsetFinalize = checkpointCalls.find(
      (call) =>
        call.checkpointScope === "adset_daily" && call.phase === "finalize",
    );
    const adFinalize = checkpointCalls.find(
      (call) =>
        call.checkpointScope === "ad_daily" && call.phase === "finalize",
    );
    const coreFinalize = checkpointCalls.find(
      (call) =>
        call.checkpointScope === "core_ad_insights" &&
        call.phase === "finalize",
    );
    const phaseTimingCalls = vi
      .mocked(warehouse.upsertMetaSyncPhaseTiming)
      .mock.calls.map(([arg]) => arg);

    expect(accountFinalize).toMatchObject({
      checkpointScope: "account_daily",
      phase: "finalize",
      status: "succeeded",
      rowsFetched: 1,
      rowsWritten: 1,
      startedAt: "2026-04-03T20:44:30.156Z",
    });
    expect(adsetFinalize).toMatchObject({
      checkpointScope: "adset_daily",
      phase: "finalize",
      status: "succeeded",
      rowsFetched: 1,
      rowsWritten: 1,
      lastSuccessfulEntityKey: "adset-1",
      startedAt: "2026-04-03T20:44:30.200Z",
    });
    expect(adFinalize).toMatchObject({
      checkpointScope: "ad_daily",
      phase: "finalize",
      status: "succeeded",
      rowsFetched: 1,
      rowsWritten: 1,
      lastSuccessfulEntityKey: "ad-1",
      startedAt: "2026-04-03T20:44:30.240Z",
    });
    expect(coreFinalize).toMatchObject({
      checkpointScope: "core_ad_insights",
      phase: "finalize",
      status: "succeeded",
      rowsFetched: 1,
      leaseEpoch: 11,
    });
    expect(phaseTimingCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timingScope: "fetch_raw:core_ad_insights",
          phase: "fetch_raw",
          status: "succeeded",
          rowsFetched: 1,
        }),
        expect.objectContaining({
          timingScope: "bulk_upsert:core_ad_insights",
          phase: "bulk_upsert",
          status: "succeeded",
        }),
        expect.objectContaining({
          timingScope: "finalize:core_ad_insights",
          phase: "finalize",
          status: "succeeded",
        }),
      ]),
    );
    expect(checkpointCalls.every((call) => call.leaseEpoch === 11)).toBe(true);
    const heartbeatOrder = vi.mocked(warehouse.heartbeatMetaPartitionLease).mock
      .invocationCallOrder;
    const accountUpsertOrder = vi.mocked(warehouse.upsertMetaAccountDailyRows)
      .mock.invocationCallOrder[0]!;
    const campaignUpsertOrder = vi.mocked(warehouse.upsertMetaCampaignDailyRows)
      .mock.invocationCallOrder[0]!;
    const adsetUpsertOrder = vi.mocked(warehouse.upsertMetaAdSetDailyRows).mock
      .invocationCallOrder[0]!;
    const adUpsertOrder = vi.mocked(warehouse.upsertMetaAdDailyRows).mock
      .invocationCallOrder[0]!;
    const derivedFinalizeOrder = vi
      .mocked(warehouse.upsertMetaSyncCheckpoint)
      .mock.calls.map(([call], index) => ({
        call,
        order: vi.mocked(warehouse.upsertMetaSyncCheckpoint).mock
          .invocationCallOrder[index]!,
      }))
      .find(
        ({ call }) =>
          call.checkpointScope === "account_daily" && call.phase === "finalize",
      )?.order;

    expect(heartbeatOrder.every((order) => Number.isFinite(order))).toBe(true);
    expect(heartbeatOrder.some((order) => order < accountUpsertOrder)).toBe(
      true,
    );
    expect(
      heartbeatOrder.some(
        (order) => order > accountUpsertOrder && order < campaignUpsertOrder,
      ),
    ).toBe(true);
    expect(
      heartbeatOrder.some(
        (order) => order > campaignUpsertOrder && order < adsetUpsertOrder,
      ),
    ).toBe(true);
    expect(
      heartbeatOrder.some(
        (order) => order > adsetUpsertOrder && order < adUpsertOrder,
      ),
    ).toBe(true);
    expect(
      heartbeatOrder.some(
        (order) =>
          derivedFinalizeOrder != null &&
          order > adUpsertOrder &&
          order < derivedFinalizeOrder,
      ),
    ).toBe(true);
    expect(
      vi
        .mocked(warehouse.heartbeatMetaPartitionLease)
        .mock.calls.every(([input]) => input.leaseEpoch === 11),
    ).toBe(true);
  });

  it("marks derived checkpoints succeeded even when adset rows are empty", async () => {
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockImplementation(
      async ({ checkpointScope }) => {
        if (checkpointScope === "core_ad_insights") return null;
        return null;
      },
    );

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                adset_id: null,
                adset_name: null,
                ad_id: "ad-1",
                ad_name: "Ad 1",
                spend: "0",
                impressions: "0",
                clicks: "0",
                reach: "0",
                frequency: "0",
                ctr: "0",
                cpm: "0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "cmp-1", effective_status: "ACTIVE", status: "ACTIVE" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncMetaAccountCoreWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: {
            currency: "USD",
            timezone: "UTC",
            name: "Account 1",
          },
        },
      },
      accountId: "act_1",
      day: "2026-04-03",
      partitionId: "partition-2",
      workerId: "worker-1",
      leaseEpoch: 17,
      attemptCount: 1,
      leaseMinutes: 15,
    });

    const checkpointCalls = vi
      .mocked(warehouse.upsertMetaSyncCheckpoint)
      .mock.calls.map(([arg]) => arg);
    const adsetFinalize = checkpointCalls.find(
      (call) =>
        call.checkpointScope === "adset_daily" && call.phase === "finalize",
    );

    expect(adsetFinalize).toMatchObject({
      checkpointScope: "adset_daily",
      phase: "finalize",
      status: "succeeded",
      rowsFetched: 1,
      rowsWritten: 0,
      lastSuccessfulEntityKey: null,
      leaseEpoch: 17,
    });
  });

  it("allows zero-spend finalized days to complete without campaign rows", async () => {
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights") && url.includes("level=account")) {
        return new Response(
          JSON.stringify({
            data: [{ spend: "0" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/adsets")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncMetaAccountCoreWarehouseDay({
        credentials: {
          businessId: "biz-1",
          accessToken: "token-1",
          accountIds: ["act_1"],
          currency: "USD",
          accountProfiles: {
            act_1: {
              currency: "USD",
              timezone: "UTC",
              name: "Account 1",
            },
          },
        },
        accountId: "act_1",
        day: "2026-04-03",
        partitionId: "partition-zero",
        workerId: "worker-1",
        leaseEpoch: 21,
        attemptCount: 1,
        leaseMinutes: 15,
      }),
    ).resolves.toMatchObject({
      campaignRowsWritten: 0,
      accountRowsWritten: 1,
    });

    expect(warehouse.replaceMetaAccountDailySlice).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          expect.objectContaining({
            spend: 0,
          }),
        ],
      }),
    );
    expect(warehouse.replaceMetaCampaignDailySlice).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [],
      }),
    );
  });

  it("publishes canonical authoritative truth and records totals_mismatch when source spend drifts", async () => {
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights") && url.includes("level=account")) {
        return new Response(JSON.stringify({ data: [{ spend: "9.00" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                adset_id: "adset-1",
                adset_name: "Adset 1",
                ad_id: "ad-1",
                ad_name: "Ad 1",
                spend: "12.50",
                impressions: "100",
                clicks: "4",
                reach: "90",
                frequency: "1.11",
                ctr: "4.0",
                cpm: "125.0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "cmp-1", effective_status: "ACTIVE", status: "ACTIVE" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncMetaAccountCoreWarehouseDay({
        credentials: {
          businessId: "biz-1",
          accessToken: "token-1",
          accountIds: ["act_1"],
          currency: "USD",
          accountProfiles: {
            act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
          },
        },
        accountId: "act_1",
        day: "2026-04-03",
        partitionId: "partition-failed",
        workerId: "worker-1",
        leaseEpoch: 12,
        attemptCount: 1,
        leaseMinutes: 15,
        freshStart: true,
        source: "manual_refresh",
      }),
    ).resolves.toMatchObject({
      accountRowsWritten: 1,
      campaignRowsWritten: 1,
    });

    expect(
      warehouse.supersedeMetaRawSnapshotsForPartition,
    ).toHaveBeenCalledWith({
      partitionId: "partition-failed",
    });
    expect(
      warehouse.deleteMetaSyncCheckpointsForPartition,
    ).toHaveBeenCalledWith({
      partitionId: "partition-failed",
    });
    expect(warehouse.listMetaRawSnapshotsForRun).not.toHaveBeenCalled();
    expect(warehouse.publishMetaAuthoritativeSliceVersion).toHaveBeenCalled();
    expect(
      warehouse.createMetaAuthoritativeReconciliationEvent,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "totals_mismatch",
        result: "repair_required",
        detailsJson: expect.objectContaining({
          canonicalPublished: true,
          sourceSpend: 9,
          rebuiltAccountSpend: 12.5,
          rebuiltCampaignSpend: 12.5,
        }),
      }),
    );
  });

  it("replaces a previously published tiny warehouse truth with a validated rerun", async () => {
    process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "1";
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);
    vi.mocked(warehouse.getMetaActivePublishedSliceVersion).mockResolvedValue({
      publication: { activeSliceVersionId: "slice-old" },
      sliceVersion: {
        id: "slice-old",
        sourceRunId: "old-run",
        aggregatedSpend: 1,
        status: "published",
      },
    } as never);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights") && url.includes("level=account")) {
        return new Response(JSON.stringify({ data: [{ spend: "12.50" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                adset_id: "adset-1",
                adset_name: "Adset 1",
                ad_id: "ad-1",
                ad_name: "Ad 1",
                spend: "12.50",
                impressions: "100",
                clicks: "4",
                reach: "90",
                frequency: "1.11",
                ctr: "4.0",
                cpm: "125.0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "cmp-1", effective_status: "ACTIVE", status: "ACTIVE" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncMetaAccountCoreWarehouseDay({
        credentials: {
          businessId: "biz-1",
          accessToken: "token-1",
          accountIds: ["act_1"],
          currency: "USD",
          accountProfiles: {
            act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
          },
        },
        accountId: "act_1",
        day: "2026-04-03",
        partitionId: "partition-rerun",
        workerId: "worker-1",
        leaseEpoch: 13,
        attemptCount: 1,
        leaseMinutes: 15,
        freshStart: true,
        source: "repair_recent_day",
      }),
    ).resolves.toMatchObject({
      accountRowsWritten: 1,
      campaignRowsWritten: 1,
    });

    expect(warehouse.replaceMetaAccountDailySlice).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [expect.objectContaining({ spend: 12.5 })],
      }),
    );
    expect(warehouse.publishMetaAuthoritativeSliceVersion).toHaveBeenCalled();
  });

  it("rejects positive-spend finalized days when campaign rows are empty", async () => {
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights") && url.includes("level=account")) {
        return new Response(
          JSON.stringify({
            data: [{ spend: "10" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/adsets")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncMetaAccountCoreWarehouseDay({
        credentials: {
          businessId: "biz-1",
          accessToken: "token-1",
          accountIds: ["act_1"],
          currency: "USD",
          accountProfiles: {
            act_1: {
              currency: "USD",
              timezone: "UTC",
              name: "Account 1",
            },
          },
        },
        accountId: "act_1",
        day: "2026-04-03",
        partitionId: "partition-positive",
        workerId: "worker-1",
        leaseEpoch: 22,
        attemptCount: 1,
        leaseMinutes: 15,
      }),
    ).rejects.toThrow("meta_finalization_proof_incomplete");
  });

  it("attaches no current configuration to a historical core warehouse day", async () => {
    // Daily fact rows are written on FINALIZED days, and current inventory is
    // fetched only on the account's own provisional today — so a finalized day
    // has, correctly, no configuration to attach. This used to write today's
    // objective, bid strategy and budgets onto a day months in the past.
    const accountToday = "2026-04-03";
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                adset_id: "adset-1",
                adset_name: "Adset 1",
                ad_id: "ad-1",
                ad_name: "Ad 1",
                spend: "12.50",
                impressions: "100",
                clicks: "4",
                reach: "90",
                frequency: "1.11",
                ctr: "4.0",
                cpm: "125.0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cmp-1",
                name: "Campaign 1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "25",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "7.5",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "10",
                optimization_goal: "omni_purchase",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "5.5",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncMetaAccountCoreWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      accountId: "act_1",
      day: accountToday,
      partitionId: "partition-3",
      workerId: "worker-1",
      leaseEpoch: 19,
      attemptCount: 1,
      leaseMinutes: 15,
    });

    // Across ALL calls: the current-day path writes in more than one pass, so
    // pinning to calls[0] would assert against whichever pass happened to be
    // first rather than against what was written.
    const adsetRows = vi
      .mocked(warehouse.upsertMetaAdSetDailyRows)
      .mock.calls.flatMap((call) => call[0] ?? []);
    const campaignRows = vi
      .mocked(warehouse.upsertMetaCampaignDailyRows)
      .mock.calls.flatMap((call) => call[0] ?? []);

    // The metric facts land; the configuration columns are null, because no
    // configuration was observed for that day and inventing one from today would
    // be a fabricated historical truth.
    expect(campaignRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          campaignId: "cmp-1",
          dailyBudget: null,
          optimizationGoal: null,
          bidStrategyType: null,
        }),
      ]),
    );
    for (const row of adsetRows) {
      expect(row.bidStrategyType).toBeNull();
      expect(row.dailyBudget).toBeNull();
    }
    expect(configuration.summarizeCampaignConfig).toHaveBeenCalled();
  });

  it("synthesizes no rows from configuration on a historical day", async () => {
    // Synthesis fills in entities that configuration knows about and insights
    // omitted. On a historical day there is no current configuration — by
    // design — so there is nothing to synthesize from, and inventing rows from
    // today's inventory would put entities into a past day that were not
    // running then.
    const accountToday = "2026-04-04";
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                adset_id: "adset-1",
                adset_name: "Adset 1",
                ad_id: "ad-1",
                ad_name: "Ad 1",
                spend: "12.50",
                impressions: "100",
                clicks: "4",
                reach: "90",
                frequency: "1.11",
                ctr: "4.0",
                cpm: "125.0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cmp-1",
                name: "Campaign 1",
                objective: "OUTCOME_SALES",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "25",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "7.5",
              },
              {
                id: "cmp-2",
                name: "Campaign 2",
                objective: "OUTCOME_SALES",
                effective_status: "PAUSED",
                status: "PAUSED",
                daily_budget: "40",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "9.5",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "10",
                optimization_goal: "omni_purchase",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "5.5",
              },
              {
                id: "adset-2",
                name: "Adset 2",
                campaign_id: "cmp-2",
                effective_status: "PAUSED",
                status: "PAUSED",
                daily_budget: "15",
                optimization_goal: "omni_purchase",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "6.5",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncMetaAccountCoreWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      accountId: "act_1",
      day: accountToday,
      partitionId: "partition-4",
      workerId: "worker-1",
      leaseEpoch: 20,
      attemptCount: 1,
      leaseMinutes: 15,
    });

    // Across ALL calls: the current-day path writes in more than one pass, so
    // pinning to calls[0] would assert against whichever pass happened to be
    // first rather than against what was written.
    const adsetRows = vi
      .mocked(warehouse.upsertMetaAdSetDailyRows)
      .mock.calls.flatMap((call) => call[0] ?? []);
    const campaignRows = vi
      .mocked(warehouse.upsertMetaCampaignDailyRows)
      .mock.calls.flatMap((call) => call[0] ?? []);

    // cmp-2 and adset-2 exist only in the CURRENT inventory; insights for that
    // past day never mentioned them. They must not appear: a campaign created
    // last week did not run on a day in April, and synthesizing a zero-metric
    // row for it would assert that it did.
    expect(
      campaignRows.some((row) => row.campaignId === "cmp-2"),
    ).toBe(false);
    expect(adsetRows.some((row) => row.adsetId === "adset-2")).toBe(false);
    // The entities the day's insights actually reported are still written.
    expect(
      campaignRows.some((row) => row.campaignId === "cmp-1"),
    ).toBe(true);
  });

  it("writes normalized config fields in the single-day adset warehouse write-back path", async () => {
    // The account's own local today. Driving a historical day here is what the
    // write-back gate now refuses; that case has its own test below.
    const accountToday = new Date().toISOString().slice(0, 10);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/adsets")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "11",
                optimization_goal: "omni_purchase",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "6",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                adset_id: "adset-1",
                adset_name: "Adset 1",
                campaign_id: "cmp-1",
                spend: "30",
                ctr: "2",
                inline_link_click_ctr: "1.5",
                cpm: "10",
                impressions: "300",
                clicks: "6",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cmp-1",
                name: "Campaign 1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "25",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "7.5",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await getAdSets(
      {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      "cmp-1",
      accountToday,
      accountToday,
      "biz-1",
      false,
    );

    const adsetRows =
      vi.mocked(warehouse.upsertMetaAdSetDailyRows).mock.calls.at(-1)?.[0] ??
      [];
    expect(adsetRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adsetId: "adset-1",
          optimizationGoal: "omni_purchase",
          bidStrategyType: "LOWEST_COST_WITH_BID_CAP",
          bidStrategyLabel: "LOWEST_COST_WITH_BID_CAP",
          manualBidAmount: 6,
          bidValue: 6,
          bidValueFormat: "currency",
          dailyBudget: 11,
          isBudgetMixed: false,
          isConfigMixed: false,
        }),
      ]),
    );
  });

  it("writes nothing back when the single-day adset read is a historical day", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/adsets")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "11",
                optimization_goal: "omni_purchase",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "6",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                adset_id: "adset-1",
                adset_name: "Adset 1",
                campaign_id: "cmp-1",
                spend: "30",
                ctr: "2",
                inline_link_click_ctr: "1.5",
                cpm: "10",
                impressions: "300",
                clicks: "6",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cmp-1",
                name: "Campaign 1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "25",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "7.5",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await getAdSets(
      {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      "cmp-1",
      "2026-04-03",
      "2026-04-03",
      "biz-1",
      false,
    );

    // getAdSets is a live READ surface. A single-day window is not the same
    // thing as the account's today, and without that distinction a dashboard
    // request for any past day wrote adset daily rows and appended config
    // history — the same fabrication as the sync path, reached through a
    // surface whose contract is that it does not write history.
    expect(warehouse.upsertMetaAdSetDailyRows).not.toHaveBeenCalled();
    expect(configSnapshots.appendMetaConfigSnapshots).not.toHaveBeenCalled();
  });


  it("does not read config snapshots for non-today getAdSets requests", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/adsets")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "11",
                optimization_goal: "omni_purchase",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "6",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                adset_id: "adset-1",
                adset_name: "Adset 1",
                campaign_id: "cmp-1",
                spend: "30",
                ctr: "2",
                inline_link_click_ctr: "1.5",
                cpm: "10",
                impressions: "300",
                clicks: "6",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cmp-1",
                name: "Campaign 1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "25",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
                bid_amount: "7.5",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await getAdSets(
      {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      "cmp-1",
      "2026-04-03",
      "2026-04-03",
      "biz-1",
      true,
    );

    expect(
      configSnapshots.readLatestMetaConfigSnapshots,
    ).not.toHaveBeenCalled();
    expect(
      configSnapshots.readPreviousDifferentMetaConfigDiffs,
    ).not.toHaveBeenCalled();
  });

  it("fails core sync when required config truth is still missing", async () => {
    // Config truth is only required where config is fetched — the account's own
    // today.
    const accountToday = new Date().toISOString().slice(0, 10);
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);
    vi.mocked(configuration.buildConfigSnapshotPayload).mockImplementation(
      (input) => ({
        campaignId: input.campaignId ?? null,
        objective: null,
        optimizationGoal: null,
        bidStrategyType: null,
        bidStrategyLabel: null,
        manualBidAmount: null,
        bidValue: null,
        bidValueFormat: null,
        dailyBudget: null,
        lifetimeBudget: null,
        isBudgetMixed: false,
        isConfigMixed: false,
        isOptimizationGoalMixed: false,
        isBidStrategyMixed: false,
        isBidValueMixed: false,
      }),
    );

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                adset_id: "adset-1",
                adset_name: "Adset 1",
                ad_id: "ad-1",
                ad_name: "Ad 1",
                spend: "12.50",
                impressions: "100",
                clicks: "4",
                reach: "90",
                frequency: "1.11",
                ctr: "4.0",
                cpm: "125.0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cmp-1",
                name: "Campaign 1",
                objective: "OUTCOME_SALES",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "25",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                optimization_goal: "omni_purchase",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "10",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncMetaAccountCoreWarehouseDay({
        credentials: {
          businessId: "biz-1",
          accessToken: "token-1",
          accountIds: ["act_1"],
          currency: "USD",
          accountProfiles: {
            act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
          },
        },
        accountId: "act_1",
        day: accountToday,
        partitionId: "partition-1",
        workerId: "worker-1",
        leaseEpoch: 11,
        attemptCount: 1,
        leaseMinutes: 15,
      }),
    ).rejects.toThrow("Meta core truth incomplete");
  });

  it("emits ordered account core sub-stage logs on success", async () => {
    process.env.APP_LOG_LEVEL = "info";
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights") && url.includes("level=account")) {
        return new Response(JSON.stringify({ data: [{ spend: "12.50" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                adset_id: "adset-1",
                adset_name: "Adset 1",
                ad_id: "ad-1",
                ad_name: "Ad 1",
                spend: "12.50",
                impressions: "100",
                clicks: "4",
                reach: "90",
                frequency: "1.11",
                ctr: "4.0",
                cpm: "125.0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cmp-1",
                name: "Campaign 1",
                objective: "OUTCOME_SALES",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "25",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                optimization_goal: "omni_purchase",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "10",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await syncMetaAccountCoreWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      accountId: "act_1",
      day: "2026-04-03",
      partitionId: "partition-ordered-stages",
      workerId: "worker-1",
      leaseEpoch: 11,
      attemptCount: 1,
      leaseMinutes: 15,
      lane: "maintenance",
      source: "finalize_day",
    });

    const stages = infoSpy.mock.calls
      .filter(
        ([message, payload]) =>
          message === "[meta-sync] partition_stage" &&
          typeof payload === "object" &&
          payload != null &&
          String((payload as { stage?: string }).stage ?? "").startsWith(
            "syncMetaAccountCoreWarehouseDay.",
          ),
      )
      .map(([, payload]) => (payload as { stage: string }).stage);

    expect(stages).toEqual([
      "syncMetaAccountCoreWarehouseDay.restore_raw_pages",
      "syncMetaAccountCoreWarehouseDay.fetch_source_pages",
      "syncMetaAccountCoreWarehouseDay.fetch_remote_configs",
      "syncMetaAccountCoreWarehouseDay.fetch_source_account_spend",
      "syncMetaAccountCoreWarehouseDay.read_latest_config_snapshots",
      "syncMetaAccountCoreWarehouseDay.build_daily_rows",
      "syncMetaAccountCoreWarehouseDay.create_authoritative_manifest",
      "syncMetaAccountCoreWarehouseDay.create_slice_versions",
      "syncMetaAccountCoreWarehouseDay.write_account_daily",
      "syncMetaAccountCoreWarehouseDay.write_campaign_daily",
      "syncMetaAccountCoreWarehouseDay.write_adset_daily",
      "syncMetaAccountCoreWarehouseDay.write_ad_daily",
      "syncMetaAccountCoreWarehouseDay.persist_campaign_config_snapshots",
      "syncMetaAccountCoreWarehouseDay.append_adset_config_snapshots",
      "syncMetaAccountCoreWarehouseDay.append_current_config_history",
      "syncMetaAccountCoreWarehouseDay.refresh_overview_summary",
      "syncMetaAccountCoreWarehouseDay.finalize_phase_timings",
    ]);
    expect(
      warehouse.refreshMetaAccountDailyOverviewSummary,
    ).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ providerAccountId: "act_1" }),
      ]),
    );

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("attributes account core timeout failures to the exact write sub-stage", async () => {
    process.env.APP_LOG_LEVEL = "info";
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);
    vi.mocked(warehouse.replaceMetaAccountDailySlice).mockRejectedValueOnce(
      new Error("Database query timed out after 60000ms"),
    );
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights") && url.includes("level=account")) {
        return new Response(JSON.stringify({ data: [{ spend: "12.50" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                adset_id: "adset-1",
                adset_name: "Adset 1",
                ad_id: "ad-1",
                ad_name: "Ad 1",
                spend: "12.50",
                impressions: "100",
                clicks: "4",
                reach: "90",
                frequency: "1.11",
                ctr: "4.0",
                cpm: "125.0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "cmp-1", effective_status: "ACTIVE", status: "ACTIVE" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      syncMetaAccountCoreWarehouseDay({
        credentials: {
          businessId: "biz-1",
          accessToken: "token-1",
          accountIds: ["act_1"],
          currency: "USD",
          accountProfiles: {
            act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
          },
        },
        accountId: "act_1",
        day: "2026-04-03",
        partitionId: "partition-write-timeout",
        workerId: "worker-1",
        leaseEpoch: 11,
        attemptCount: 1,
        leaseMinutes: 15,
        lane: "maintenance",
        source: "finalize_day",
      }),
    ).rejects.toThrow("Database query timed out after 60000ms");

    const failedStagePayload = warnSpy.mock.calls
      .filter(
        ([message, payload]) =>
          message === "[meta-sync] partition_stage_failed" &&
          typeof payload === "object" &&
          payload != null &&
          String((payload as { stage?: string }).stage ?? "").startsWith(
            "syncMetaAccountCoreWarehouseDay.",
          ),
      )
      .map(
        ([, payload]) =>
          payload as {
            stage: string;
            ok: boolean;
            errorMessage?: string | null;
          },
      );

    expect(failedStagePayload).toContainEqual(
      expect.objectContaining({
        stage: "syncMetaAccountCoreWarehouseDay.write_account_daily",
        ok: false,
        errorMessage: "Database query timed out after 60000ms",
      }),
    );
    expect(
      infoSpy.mock.calls.some(
        ([, payload]) =>
          typeof payload === "object" &&
          payload != null &&
          (payload as { stage?: string }).stage ===
            "syncMetaAccountCoreWarehouseDay.write_campaign_daily",
      ),
    ).toBe(false);

    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("does not write historical single-day live campaign reads back into warehouse", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                campaign_id: "cmp-1",
                campaign_name: "Campaign 1",
                spend: "25.04",
                ctr: "2.5",
                cpm: "10",
                impressions: "100",
                clicks: "4",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/campaigns")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "cmp-1",
                name: "Campaign 1",
                objective: "OUTCOME_SALES",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                daily_budget: "25",
                bid_strategy: "LOWEST_COST_WITH_BID_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await getCampaigns(
      {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: {
            currency: "USD",
            timezone: "America/Anchorage",
            name: "Account 1",
          },
        },
      },
      "2026-03-31",
      "2026-03-31",
    );

    expect(warehouse.upsertMetaCampaignDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaAccountDailyRows).not.toHaveBeenCalled();
    // The config snapshot write sat ABOVE the today-only gate and ran
    // unconditionally, so every historical window a dashboard requested
    // persisted the account's CURRENT campaign inventory — the same
    // fabrication as the sync path, through a read surface.
    expect(configSnapshots.appendMetaConfigSnapshots).not.toHaveBeenCalled();
  });
  /*
    ── THE BULK WALK REFUSES LIKE THE RECEIPT WALK ───────────────────────────
    `fetchMetaPagedJson` — the only page fetcher the bulk core and breakdown
    syncs use — threw `new Error(json.error?.message ?? ...)` on BOTH refusal
    paths. Two things were wrong with that and both are asserted here.

    STRUCTURE. `classifyMetaSyncFailure` branches on errorCode / errorSubcode /
    isTransient / httpStatus. A plain Error carries none of them, so an expired
    token, a rate limit and a bug in this file all reached the partition
    failure path indistinguishable from one another.

    SANITISATION. The thrown message was Meta's own prose, and Graph error
    messages quote the request — including, on these edges, the access token in
    the query string. `lib/sync/meta-sync.ts` wrote that message into
    `meta_sync_partitions.last_error` and `meta_sync_runs.error_message`.

    The bodies below therefore carry BOTH a secret and prose, and the
    assertions require the thrown message to contain neither.
  */
  const LEAKY_GRAPH_PROSE =
    "Unsupported get request for /act_1/insights?access_token=EAAG-SECRET-TOKEN-VALUE; the customer 'Acme Widgets Ltd' cannot be queried";
  const SECRET_IN_PROSE = "EAAG-SECRET-TOKEN-VALUE";

  function leakyGraphErrorBody() {
    return {
      error: {
        message: LEAKY_GRAPH_PROSE,
        type: "OAuthException",
        code: 190,
        error_subcode: 463,
        is_transient: false,
        fbtrace_id: "BuLkTrAcE0001",
      },
    };
  }

  async function expectStructuredSanitizedRefusal(run: () => Promise<unknown>) {
    const error = await run().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error & Record<string, unknown>;
    // Structured: the classifier can now branch on the provider's own identity.
    expect(failure.name).toBe("MetaGraphRequestError");
    expect(failure.errorCode).toBe(190);
    expect(failure.errorSubcode).toBe(463);
    expect(failure.isTransient).toBe(false);
    expect(failure.fbtraceId).toBe("BuLkTrAcE0001");
    // Sanitized: no provider prose, and above all no credential.
    expect(failure.message).not.toContain(SECRET_IN_PROSE);
    expect(failure.message).not.toContain("Acme Widgets Ltd");
    expect(failure.message).not.toContain("Unsupported get request");
    expect(failure.message).toContain("code=190");
    // And the durable record built from it carries neither.
    const durable = durableMetaFailureMessage(failure);
    expect(durable).not.toContain(SECRET_IN_PROSE);
    expect(durable).not.toContain("Acme Widgets Ltd");
    expect(durable).toContain("code=190");
    expect(durable).toContain("subcode=463");
    return failure;
  }

  it("sanitizes a provider-chosen fbtrace_id in BOTH the warning and the durable record", async () => {
    /*
      ROUND 6 ITEM 6. `fbtrace_id` is the only free-form string this module
      keeps out of an error body, and it was accepted with `String(...).trim()`
      — so a value carrying a credential, a newline that splits a log line, or
      the `:`/`=` delimiters the failure messages use as structure travelled
      into the `bulk_page_rejected` warning, onto `MetaGraphRequestError`, and
      from there into `meta_sync_partitions.last_error`.

      The warning is CAPTURED here rather than assumed, because it is the
      boundary an operator actually reads.
    */
    const warnings: Array<{ event: string; details: unknown }> = [];
    const warnSpy = vi
      .spyOn(runtimeLogging, "logRuntimeWarn")
      .mockImplementation((_scope, event, details) => {
        warnings.push({ event, details });
      });

    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("level=account") || url.includes("/campaigns") || url.includes("/adsets")) {
          return jsonResponseFor({ data: [] }, 200);
        }
        return jsonResponseFor(
          {
            error: {
              message: "Unsupported get request",
              code: 190,
              error_subcode: 463,
              is_transient: false,
              fbtrace_id:
                "AbCd?access_token=EAAG-SECRET-TOKEN-VALUE\nfbtrace=SPOOFED",
            },
          },
          400,
        );
      }),
    );

    const failure = await syncMetaAccountCoreWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      accountId: "act_1",
      day: "2026-04-03",
      partitionId: "partition-bulk-fbtrace",
      workerId: "worker-1",
      leaseEpoch: 1,
      attemptCount: 1,
      leaseMinutes: 15,
    }).then(
      () => null,
      (thrown: unknown) => thrown as Error & Record<string, unknown>,
    );

    // Parsed away: nothing unsafe was ever constructed.
    expect(failure!.fbtraceId).toBeNull();

    const rejected = warnings.find((entry) => entry.event === "bulk_page_rejected");
    expect(rejected, "the rejection warning must be emitted").toBeTruthy();
    const details = rejected!.details as Record<string, unknown>;
    expect(details.fbtraceId).toBeNull();
    // The identifiers an operator can act on survive.
    expect(details).toMatchObject({ httpStatus: 400, errorCode: 190, errorSubcode: 463 });
    const serializedWarning = JSON.stringify(warnings);
    expect(serializedWarning).not.toContain("EAAG-SECRET-TOKEN-VALUE");
    expect(serializedWarning).not.toContain("SPOOFED");

    const durable = durableMetaFailureMessage(failure);
    expect(durable).toContain("fbtrace=none");
    expect(durable).not.toContain("EAAG-SECRET-TOKEN-VALUE");
    expect(durable).not.toContain("SPOOFED");
    expect(durable.split("\n")).toHaveLength(1);

    warnSpy.mockRestore();
  });

  it("refuses an HTTP 400 ad-insights page as a structured, sanitized failure", async () => {
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("level=account") || url.includes("/campaigns") || url.includes("/adsets")) {
          return jsonResponseFor({ data: [] }, 200);
        }
        return jsonResponseFor(leakyGraphErrorBody(), 400);
      }),
    );

    const failure = await expectStructuredSanitizedRefusal(() =>
      syncMetaAccountCoreWarehouseDay({
        credentials: {
          businessId: "biz-1",
          accessToken: "token-1",
          accountIds: ["act_1"],
          currency: "USD",
          accountProfiles: {
            act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
          },
        },
        accountId: "act_1",
        day: "2026-04-03",
        partitionId: "partition-bulk-http-400",
        workerId: "worker-1",
        leaseEpoch: 1,
        attemptCount: 1,
        leaseMinutes: 15,
      }),
    );
    expect(failure.httpStatus).toBe(400);
    expect(failure.termination).toBe("http_failure");
    /*
      And the classifier reaches its verdict off the structured identity rather
      than off prose: code 190 with subcode 463 is a token that expired, not a
      generic auth failure and not the `unknown` a plain Error produced.
    */
    expect(classifyMetaSyncFailure({ error: failure }).errorClass).toBe(
      "invalid_token",
    );
  });

  it("refuses an HTTP 200 ad-insights page that carries a Graph error envelope", async () => {
    /*
      The status says success. Left unclassified this walked past the refusal,
      read `data` as an empty page, ended the walk on a missing `paging.next`,
      and finished the day having written ad-days built from zero provider rows
      — reported as a success. An empty page and a refused page are opposite
      facts; only one of them may terminate a capture.
    */
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("level=account") || url.includes("/campaigns") || url.includes("/adsets")) {
          return jsonResponseFor({ data: [] }, 200);
        }
        return jsonResponseFor(leakyGraphErrorBody(), 200);
      }),
    );

    const failure = await expectStructuredSanitizedRefusal(() =>
      syncMetaAccountCoreWarehouseDay({
        credentials: {
          businessId: "biz-1",
          accessToken: "token-1",
          accountIds: ["act_1"],
          currency: "USD",
          accountProfiles: {
            act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
          },
        },
        accountId: "act_1",
        day: "2026-04-03",
        partitionId: "partition-bulk-2xx-envelope",
        workerId: "worker-1",
        leaseEpoch: 1,
        attemptCount: 1,
        leaseMinutes: 15,
      }),
    );
    // The status recorded IS 200, and the termination says why that is still a
    // refusal — the distinction an operator needs to read the failure.
    expect(failure.httpStatus).toBe(200);
    expect(failure.termination).toBe("error_envelope");
    // Nothing was written from the refusal.
    expect(warehouse.upsertMetaAdDailyRows).not.toHaveBeenCalled();
  });
});


describe("syncMetaAccountBreakdownWarehouseDay", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(warehouse.heartbeatMetaPartitionLease).mockResolvedValue(true);
    vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);
    vi.mocked(warehouse.persistMetaRawSnapshot).mockResolvedValue(
      "snapshot-id",
    );
    vi.mocked(warehouse.upsertMetaSyncCheckpoint).mockResolvedValue(
      "checkpoint-id",
    );
    vi.mocked(warehouse.upsertMetaSyncPhaseTiming).mockResolvedValue(
      "phase-timing-id" as never,
    );
  });

  it("maps runtime breakdown params to the correct warehouse slice", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/insights")) {
        const breakdowns = new URL(url).searchParams.get("breakdowns");
        if (breakdowns === "age,gender") {
          return new Response(
            JSON.stringify({
              data: [
                {
                  age: "25-34",
                  spend: "3.25",
                  impressions: "100",
                  clicks: "4",
                  reach: "90",
                  frequency: "1.11",
                  ctr: "4.0",
                  cpm: "32.5",
                  actions: [],
                  action_values: [],
                  purchase_roas: [],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (breakdowns === "country") {
          return new Response(
            JSON.stringify({
              data: [
                {
                  country: "US",
                  spend: "2.10",
                  impressions: "90",
                  clicks: "3",
                  reach: "75",
                  frequency: "1.2",
                  ctr: "3.33",
                  cpm: "23.33",
                  actions: [],
                  action_values: [],
                  purchase_roas: [],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            data: [
              {
                publisher_platform: "facebook",
                platform_position: "feed",
                impression_device: "mobile",
                spend: "4.20",
                impressions: "120",
                clicks: "5",
                reach: "95",
                frequency: "1.26",
                ctr: "4.17",
                cpm: "35.0",
                actions: [],
                action_values: [],
                purchase_roas: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/adsets")) {
        // The ad-set leg of the account-current unit. Without it the adset
        // receipt is INCOMPLETE, and an incomplete receipt is not evidence of a
        // configuration — the fixture would be testing the refusal path while
        // claiming to test the write path.
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "adset-1",
                name: "Adset 1",
                campaign_id: "cmp-1",
                effective_status: "ACTIVE",
                status: "ACTIVE",
                updated_time: "2026-07-01T09:30:00.000Z",
                daily_budget: "25",
                optimization_goal: "OFFSITE_CONVERSIONS",
                bid_strategy: "LOWEST_COST_WITHOUT_CAP",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/ads?") || /\/ads($|[?&])/.test(url)) {
        // Current inventory is fetched as ONE account-current unit: campaigns,
        // ad sets and ads together. A fixture that answers only two of the three
        // would fail on the third rather than on the behaviour under test.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const credentials: Parameters<
      typeof syncMetaAccountBreakdownWarehouseDay
    >[0]["credentials"] = {
      businessId: "biz-1",
      accessToken: "token-1",
      accountIds: ["act_1"],
      currency: "USD",
      accountProfiles: {
        act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
      },
    };

    // `age,gender` is TWO dimensions in one fetch and now writes TWO slices.
    // The other two breakdowns are one-dimensional and still write exactly one
    // — a fan-out that widened them would be inventing a dimension.
    const cases = [
      {
        breakdowns: "age,gender",
        endpointName: "breakdown_age",
        expected: ["age", "gender"],
      },
      {
        breakdowns: "country",
        endpointName: "breakdown_country",
        expected: ["country"],
      },
      {
        breakdowns: "publisher_platform,platform_position,impression_device",
        endpointName:
          "breakdown_publisher_platform,platform_position,impression_device",
        expected: ["placement"],
      },
    ] as const;

    for (const testCase of cases) {
      vi.mocked(warehouse.replaceMetaBreakdownDailySlice).mockClear();
      await syncMetaAccountBreakdownWarehouseDay({
        credentials,
        accountId: "act_1",
        day: "2026-04-03",
        partitionId: `partition-${testCase.expected.join("-")}`,
        workerId: "worker-1",
        leaseEpoch: 31,
        attemptCount: 1,
        breakdowns: testCase.breakdowns,
        endpointName: testCase.endpointName,
        positiveSpendAdIds: [],
        leaseMinutes: 15,
      });

      const writtenTypes = vi
        .mocked(warehouse.replaceMetaBreakdownDailySlice)
        .mock.calls.map(([call]) => call.slice.breakdownType);
      expect(writtenTypes).toEqual([...testCase.expected]);

      for (const breakdownType of testCase.expected) {
        expect(warehouse.replaceMetaBreakdownDailySlice).toHaveBeenCalledWith(
          expect.objectContaining({
            slice: {
              businessId: "biz-1",
              providerAccountId: "act_1",
              date: "2026-04-03",
              breakdownType,
            },
          }),
        );
      }
    }
  });

  it("asks Meta for reach and frequency on the breakdown fetch", async () => {
    // The panel could never fill because the FIELD LIST never asked. Pinned
    // against the request URL, not against a parsed row, because the omission
    // lived in the URL builder and a row-level assertion would pass on a
    // fixture that hands back reach nobody requested.
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requestedUrls.push(url);
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await syncMetaAccountBreakdownWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      accountId: "act_1",
      day: "2026-04-03",
      partitionId: "partition-fields",
      workerId: "worker-1",
      leaseEpoch: 31,
      attemptCount: 1,
      breakdowns: "age,gender",
      endpointName: "breakdown_age",
      positiveSpendAdIds: [],
      leaseMinutes: 15,
    });

    const insightsUrl = requestedUrls.find((url) => url.includes("/insights"));
    expect(insightsUrl).toBeDefined();
    const fields = (new URL(insightsUrl!).searchParams.get("fields") ?? "").split(
      ",",
    );
    expect(fields).toContain("reach");
    expect(fields).toContain("frequency");
  });

  it("splits one age,gender row into two dimensions and keeps age identical", async () => {
    // The defect, stated as data: one raw row carries BOTH `25-34` and
    // `female`. Folding it under `age` alone made the gender fact
    // unrecoverable. Two raw rows sharing an age bucket but differing in gender
    // must produce one age bucket with the summed spend AND two gender buckets.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/insights")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  age: "25-34",
                  gender: "female",
                  spend: "3.00",
                  impressions: "100",
                  clicks: "4",
                  reach: "50",
                  ctr: "4.0",
                  cpm: "30.0",
                  actions: [],
                  action_values: [],
                  purchase_roas: [],
                },
                {
                  age: "25-34",
                  gender: "male",
                  spend: "1.00",
                  impressions: "60",
                  clicks: "2",
                  reach: "30",
                  ctr: "3.33",
                  cpm: "16.67",
                  actions: [],
                  action_values: [],
                  purchase_roas: [],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await syncMetaAccountBreakdownWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      accountId: "act_1",
      day: "2026-04-03",
      partitionId: "partition-split",
      workerId: "worker-1",
      leaseEpoch: 31,
      attemptCount: 1,
      breakdowns: "age,gender",
      endpointName: "breakdown_age",
      positiveSpendAdIds: [],
      leaseMinutes: 15,
    });

    const calls = vi.mocked(warehouse.replaceMetaBreakdownDailySlice).mock.calls;
    const ageCall = calls.find(([call]) => call.slice.breakdownType === "age");
    const genderCall = calls.find(
      ([call]) => call.slice.breakdownType === "gender",
    );
    expect(ageCall).toBeDefined();
    expect(genderCall).toBeDefined();

    // Age reads EXACTLY as it always did: one bucket, both rows summed into it.
    const ageRows = ageCall![0].rows;
    expect(ageRows).toHaveLength(1);
    expect(ageRows[0]!.breakdownKey).toBe("25-34");
    expect(ageRows[0]!.spend).toBe(4);
    expect(ageRows[0]!.impressions).toBe(160);
    // 50 + 30 measured people, 160 impressions.
    expect(ageRows[0]!.reach).toBe(80);
    expect(ageRows[0]!.frequency).toBe(2);

    // The split that used to be destroyed.
    const genderRows = genderCall![0].rows;
    expect(
      genderRows.map((row) => [row.breakdownKey, row.spend]).sort(),
    ).toEqual([
      ["female", 3],
      ["male", 1],
    ]);
    const female = genderRows.find((row) => row.breakdownKey === "female")!;
    expect(female.reach).toBe(50);
    expect(female.frequency).toBe(2);
  });

  it("leaves reach null when Meta reports none, and never divides by it", async () => {
    // The law: missing data must not become 0 or a success. A row Meta returned
    // WITHOUT reach is unmeasured, so reach is null and frequency is null —
    // not 0, not Infinity, and emphatically not impressions-as-reach (which
    // would print a confident 1.0).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/insights")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  age: "35-44",
                  gender: "male",
                  spend: "5.00",
                  impressions: "200",
                  clicks: "6",
                  ctr: "3.0",
                  cpm: "25.0",
                  actions: [],
                  action_values: [],
                  purchase_roas: [],
                },
                {
                  age: "45-54",
                  gender: "male",
                  spend: "2.00",
                  impressions: "80",
                  clicks: "1",
                  reach: "0",
                  ctr: "1.25",
                  cpm: "25.0",
                  actions: [],
                  action_values: [],
                  purchase_roas: [],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await syncMetaAccountBreakdownWarehouseDay({
      credentials: {
        businessId: "biz-1",
        accessToken: "token-1",
        accountIds: ["act_1"],
        currency: "USD",
        accountProfiles: {
          act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
        },
      },
      accountId: "act_1",
      day: "2026-04-03",
      partitionId: "partition-null-reach",
      workerId: "worker-1",
      leaseEpoch: 31,
      attemptCount: 1,
      breakdowns: "age,gender",
      endpointName: "breakdown_age",
      positiveSpendAdIds: [],
      leaseMinutes: 15,
    });

    const ageCall = vi
      .mocked(warehouse.replaceMetaBreakdownDailySlice)
      .mock.calls.find(([call]) => call.slice.breakdownType === "age")!;
    const unmeasured = ageCall[0].rows.find(
      (row) => row.breakdownKey === "35-44",
    )!;
    expect(unmeasured.reach).toBeNull();
    expect(unmeasured.frequency).toBeNull();

    // A MEASURED zero stays zero, and still yields no frequency: 0 is not a
    // divisor. The two cases are distinguishable, which is the whole point.
    const measuredZero = ageCall[0].rows.find(
      (row) => row.breakdownKey === "45-54",
    )!;
    expect(measuredZero.reach).toBe(0);
    expect(measuredZero.frequency).toBeNull();
  });

  it("refuses a breakdown page the same way the core walk does", async () => {
    /*
      SAME FUNCTION, SO THE TWO WALKS CANNOT DRIFT. The breakdown pagination
      calls `fetchMetaPagedJson` too, and the defect was in that function — so
      a fix proven only on the core walk would be a fix proven on half the
      callers. Both refusal shapes are driven here.
    */
    for (const [label, status] of [
      ["http_failure", 400],
      ["error_envelope", 200],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponseFor(
            {
              error: {
                message:
                  "Unsupported get request for /act_1/insights?access_token=EAAG-SECRET-TOKEN-VALUE",
                code: 190,
                error_subcode: 463,
                is_transient: false,
                fbtrace_id: "BuLkTrAcE0001",
              },
            },
            status,
          ),
        ),
      );

      const error = await syncMetaAccountBreakdownWarehouseDay({
        credentials: {
          businessId: "biz-1",
          accessToken: "token-1",
          accountIds: ["act_1"],
          currency: "USD",
          accountProfiles: {
            act_1: { currency: "USD", timezone: "UTC", name: "Account 1" },
          },
        },
        accountId: "act_1",
        day: "2026-04-03",
        partitionId: `partition-breakdown-${label}`,
        workerId: "worker-1",
        leaseEpoch: 1,
        attemptCount: 1,
        breakdowns: "country",
        endpointName: "breakdown_country",
        positiveSpendAdIds: [],
        leaseMinutes: 15,
      }).then(
        () => null,
        (thrown: unknown) => thrown as Error & Record<string, unknown>,
      );

      expect(error, `${label} must refuse`).not.toBeNull();
      expect(error!.name).toBe("MetaGraphRequestError");
      expect(error!.termination).toBe(label);
      expect(error!.httpStatus).toBe(status);
      expect(error!.errorCode).toBe(190);
      expect(error!.message).not.toContain("EAAG-SECRET-TOKEN-VALUE");
      expect(durableMetaFailureMessage(error)).not.toContain(
        "EAAG-SECRET-TOKEN-VALUE",
      );
    }
  });
});
