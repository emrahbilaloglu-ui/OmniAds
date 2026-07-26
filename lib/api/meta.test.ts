import { beforeEach, describe, expect, it, vi } from "vitest";

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
        await warehouse.upsertMetaAdDailyRows(input.rows as never);
      },
    );
    // Forward appendConfigHistory. Dropping it here would make the fixture
    // hide the very flag these tests exist to check: a caller could stop
    // passing it and every assertion would still pass.
    vi.mocked(warehouse.replaceMetaCampaignDailySlice).mockImplementation(
      async (input) => {
        await warehouse.upsertMetaCampaignDailyRows(input.rows as never, {
          appendConfigHistory: input.appendConfigHistory,
        });
      },
    );
    vi.mocked(warehouse.replaceMetaAdSetDailySlice).mockImplementation(
      async (input) => {
        await warehouse.upsertMetaAdSetDailyRows(input.rows as never, {
          appendConfigHistory: input.appendConfigHistory,
        });
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
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("buying_type")),
    ).toBe(true);
    // The metric facts are still written — only the CURRENT-inventory evidence
    // is withheld — and the daily writer must be told not to append config
    // history for a historical day.
    expect(warehouse.upsertMetaCampaignDailyRows).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          campaignId: "cmp-1",
          buyingType: "AUCTION",
        }),
      ]),
      expect.objectContaining({ appendConfigHistory: false }),
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
    expect(warehouse.upsertMetaCampaignDailyRows).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appendConfigHistory: false }),
    );
    const campaignObservationCall = vi
      .mocked(entityStateHistory.persistMetaEntityObservation)
      .mock.calls.map(([call]) => call)
      .find((call) => call.entityType === "campaign");
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

  it("writes normalized config fields into campaign_daily and adset_daily rows during core sync", async () => {
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
      partitionId: "partition-3",
      workerId: "worker-1",
      leaseEpoch: 19,
      attemptCount: 1,
      leaseMinutes: 15,
    });

    const adsetRows =
      vi.mocked(warehouse.upsertMetaAdSetDailyRows).mock.calls[0]?.[0] ?? [];
    const campaignRows =
      vi.mocked(warehouse.upsertMetaCampaignDailyRows).mock.calls[0]?.[0] ?? [];

    expect(adsetRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adsetId: "adset-1",
          optimizationGoal: "omni_purchase",
          bidStrategyType: "LOWEST_COST_WITH_BID_CAP",
          bidStrategyLabel: "LOWEST_COST_WITH_BID_CAP",
          manualBidAmount: 5.5,
          bidValue: 5.5,
          bidValueFormat: "currency",
          dailyBudget: 10,
          lifetimeBudget: null,
          isBudgetMixed: false,
          isConfigMixed: false,
        }),
      ]),
    );
    expect(campaignRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          campaignId: "cmp-1",
          dailyBudget: 25,
          optimizationGoal: "omni_purchase",
          bidStrategyType: "LOWEST_COST_WITH_BID_CAP",
          bidStrategyLabel: "LOWEST_COST_WITH_BID_CAP",
        }),
      ]),
    );
    expect(configuration.summarizeCampaignConfig).toHaveBeenCalled();
  });

  it("synthesizes zero-metric campaign and ad set rows from config when insights omit them", async () => {
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
      day: "2026-04-04",
      partitionId: "partition-4",
      workerId: "worker-1",
      leaseEpoch: 20,
      attemptCount: 1,
      leaseMinutes: 15,
    });

    const adsetRows =
      vi.mocked(warehouse.upsertMetaAdSetDailyRows).mock.calls[0]?.[0] ?? [];
    const campaignRows =
      vi.mocked(warehouse.upsertMetaCampaignDailyRows).mock.calls[0]?.[0] ?? [];

    expect(campaignRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          campaignId: "cmp-2",
          campaignNameCurrent: "Campaign 2",
          spend: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          revenue: 0,
          objective: "OUTCOME_SALES",
          dailyBudget: 40,
          bidStrategyLabel: "LOWEST_COST_WITH_BID_CAP",
        }),
      ]),
    );
    expect(adsetRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adsetId: "adset-2",
          campaignId: "cmp-2",
          adsetNameCurrent: "Adset 2",
          spend: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          revenue: 0,
          optimizationGoal: "omni_purchase",
          dailyBudget: 15,
          bidStrategyLabel: "LOWEST_COST_WITH_BID_CAP",
        }),
      ]),
    );
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

    const cases = [
      {
        breakdowns: "age,gender",
        endpointName: "breakdown_age",
        expected: "age",
      },
      {
        breakdowns: "country",
        endpointName: "breakdown_country",
        expected: "country",
      },
      {
        breakdowns: "publisher_platform,platform_position,impression_device",
        endpointName:
          "breakdown_publisher_platform,platform_position,impression_device",
        expected: "placement",
      },
    ] as const;

    for (const testCase of cases) {
      await syncMetaAccountBreakdownWarehouseDay({
        credentials,
        accountId: "act_1",
        day: "2026-04-03",
        partitionId: `partition-${testCase.expected}`,
        workerId: "worker-1",
        leaseEpoch: 31,
        attemptCount: 1,
        breakdowns: testCase.breakdowns,
        endpointName: testCase.endpointName,
        positiveSpendAdIds: [],
        leaseMinutes: 15,
      });

      expect(warehouse.replaceMetaBreakdownDailySlice).toHaveBeenLastCalledWith(
        expect.objectContaining({
          slice: {
            businessId: "biz-1",
            providerAccountId: "act_1",
            date: "2026-04-03",
            breakdownType: testCase.expected,
          },
        }),
      );
    }
  });
});
