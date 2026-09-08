import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  The authoritative Meta link-click source, driven through the real sync.

  Codex item 2. `meta_ad_daily.link_clicks` was fully NULL for 2026-09 (all
  2,327 rows) and 0-or-NULL for 2026-08 (all 11,948 rows) against 7,666
  positive rows in 2026-03, which blocks every native Refresh verdict — the
  verdict needs a link-click denominator. The count was never missing from the
  provider: `payload_json` beside those same rows carries 8,640 `link_click`
  action entries for 2026-08-01 onwards.

  Nothing here hand-builds a warehouse row. The tests drive
  `syncMetaAccountCoreWarehouseDay` — the only production writer of
  `meta_ad_daily.link_clicks` — against a stubbed global fetch answering with
  Graph's own ad-day insight shapes, and read what the sync hands the warehouse.

  PROVENANCE OF THE FIXTURE SHAPES. Every insight row below is the key set and
  value formatting of a real `meta_ad_daily.payload_json` row, read 2026-09-07
  over the read-only production tunnel with identifiers replaced:

    SELECT jsonb_pretty(payload_json::jsonb - 'ad_name' - 'campaign_name'
             - 'adset_name' - 'ad_id' - 'adset_id' - 'campaign_id')
    FROM meta_ad_daily WHERE date = '2026-09-05' ...

  That is where the three states come from, and they are all real populations
  for 2026-08-01..2026-09-06 (14,275 rows):
    - 8,640 rows carry a `link_click` entry inside `actions`;
    - 3,171 rows carry an `actions` array with NO `link_click` entry — Meta
      lists the action types that happened and omits the ones that did not, and
      across all 8,640 present entries the minimum value is 1 and there is not
      one explicit `"value": "0"`, so the omission IS the zero;
    - 2,464 rows carry no `actions` key at all — and every one of those has
      impressions > 0, with 133 of them also carrying clicks > 0, so "no
      actions array" is not a quiet way of saying "nothing happened".

  `inline_link_clicks` is not a candidate source here: neither ad-level field
  list in lib/api/meta.ts requests it, and a key census of the same 14,275 rows
  returns eighteen keys (campaign_id, campaign_name, adset_id, adset_name,
  ad_id, ad_name, date_start, date_stop, spend, impressions, clicks, reach,
  frequency, cpm, ctr, actions, action_values, purchase_roas) without it.
*/

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertSyncGrowthBoundary: vi.fn(async () => ({
      allowed: true,
      reason: "ready",
    })),
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
    persistMetaEntityObservation: vi.fn(),
    persistMetaExplicitEntityTombstone: vi.fn(),
  };
});

vi.mock("@/lib/meta/warehouse", () => ({
  createMetaAuthoritativeReconciliationEvent: vi.fn(),
  createMetaAuthoritativeSliceVersion: vi.fn(),
  createMetaAuthoritativeSourceManifest: vi.fn(),
  buildMetaSyncCheckpointHash: vi.fn(),
  getMetaSyncCheckpoint: vi.fn(),
  getMetaActivePublishedSliceVersion: vi.fn(),
  heartbeatMetaPartitionLease: vi.fn(),
  listMetaRawSnapshotsForRun: vi.fn(),
  publishMetaAuthoritativeSliceVersion: vi.fn(),
  buildMetaRawSnapshotHash: vi.fn(),
  createMetaSyncJob: vi.fn(),
  persistMetaRawSnapshot: vi.fn(),
  deleteMetaSyncCheckpointsForPartition: vi.fn(),
  supersedeMetaRawSnapshotsForPartition: vi.fn(),
  replaceMetaAccountDailySlice: vi.fn(),
  replaceMetaAdDailySlice: vi.fn(),
  replaceMetaCampaignDailySlice: vi.fn(),
  replaceMetaAdSetDailySlice: vi.fn(),
  replaceMetaBreakdownDailySlice: vi.fn(),
  refreshMetaAccountDailyOverviewSummary: vi.fn(),
  upsertMetaSyncCheckpoint: vi.fn(),
  upsertMetaSyncPhaseTiming: vi.fn(),
  updateMetaSyncJob: vi.fn(),
  upsertMetaAccountDailyRows: vi.fn(),
  upsertMetaAdDailyRows: vi.fn(),
  upsertMetaAdSetDailyRows: vi.fn(),
  upsertMetaCampaignDailyRows: vi.fn(),
  appendMetaCurrentConfigHistory: vi.fn(),
  updateMetaAuthoritativeSliceVersion: vi.fn(),
  updateMetaAuthoritativeSourceManifest: vi.fn(),
}));

const warehouse = await import("@/lib/meta/warehouse");
const configSnapshots = await import("@/lib/meta/config-snapshots");
const configuration = await import("@/lib/meta/configuration");
const entityStateHistory = await import("@/lib/meta/entity-state-history");
const { readMetaLinkClicksFromInsight, syncMetaAccountCoreWarehouseDay } =
  await import("@/lib/api/meta");

type InsightRow = Record<string, unknown>;

/** A real `link_click`-bearing action array, trimmed to the shape that matters. */
function actionsWithLinkClick(linkClicks: number): InsightRow["actions"] {
  return [
    { value: "9", action_type: "offsite_complete_registration_add_meta_leads" },
    { value: String(linkClicks), action_type: "link_click" },
    { value: "3", action_type: "initiate_checkout" },
    { value: "67", action_type: "landing_page_view" },
    { value: "2", action_type: "post_reaction" },
  ];
}

/**
 * A real action array from an ad-day that had engagement and no link clicks.
 * Copied from a 2026-09-05 row with clicks = 1: Meta listed post_engagement,
 * page_engagement and video_view and simply did not mention link_click.
 */
function actionsWithoutLinkClick(): InsightRow["actions"] {
  return [
    { value: "6", action_type: "post_engagement" },
    { value: "6", action_type: "page_engagement" },
    { value: "6", action_type: "video_view" },
  ];
}

function insightRow(input: {
  adId: string;
  spend: string;
  impressions: string;
  clicks: string;
  actions?: InsightRow["actions"];
}): InsightRow {
  const row: InsightRow = {
    campaign_id: "cmp-1",
    campaign_name: "Campaign 1",
    adset_id: "adset-1",
    adset_name: "Adset 1",
    ad_id: input.adId,
    ad_name: `Ad ${input.adId}`,
    date_start: "2026-04-03",
    date_stop: "2026-04-03",
    spend: input.spend,
    impressions: input.impressions,
    clicks: input.clicks,
    reach: input.impressions,
    frequency: "1.0",
    ctr: "1.0",
    cpm: "100.0",
  };
  // Assigned conditionally on purpose: the ABSENT state is the ABSENCE of the
  // key, not `actions: []` and not `actions: undefined` spelled out.
  if (input.actions) row.actions = input.actions;
  return row;
}

const PAGE_ONE: InsightRow[] = [
  // Measured on both pages: 30 here, 12 on page two.
  insightRow({
    adId: "ad-measured",
    spend: "100.00",
    impressions: "1000",
    clicks: "50",
    actions: actionsWithLinkClick(30),
  }),
  // Measured ZERO on both pages: actions present, no link_click entry.
  insightRow({
    adId: "ad-zero",
    spend: "40.00",
    impressions: "45",
    clicks: "1",
    actions: actionsWithoutLinkClick(),
  }),
  // ABSENT on both pages: no actions key at all.
  insightRow({
    adId: "ad-absent",
    spend: "15.00",
    impressions: "28",
    clicks: "1",
  }),
  // Absent here, measured on page two.
  insightRow({
    adId: "ad-late",
    spend: "10.00",
    impressions: "20",
    clicks: "1",
  }),
];

const PAGE_TWO: InsightRow[] = [
  insightRow({
    adId: "ad-measured",
    spend: "20.00",
    impressions: "200",
    clicks: "10",
    actions: actionsWithLinkClick(12),
  }),
  insightRow({
    adId: "ad-zero",
    spend: "5.00",
    impressions: "10",
    clicks: "1",
    actions: actionsWithoutLinkClick(),
  }),
  insightRow({
    adId: "ad-absent",
    spend: "5.00",
    impressions: "10",
    clicks: "1",
  }),
  insightRow({
    adId: "ad-late",
    spend: "5.00",
    impressions: "10",
    clicks: "1",
    actions: actionsWithLinkClick(7),
  }),
];

/** Page one + page two spend, which is what the account-level leg must report. */
const ACCOUNT_DAY_SPEND = "200.00";

const PAGE_TWO_URL =
  "https://graph.facebook.com/v25.0/act_1/insights?level=ad&cursor_page=2&access_token=token-1";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Answers the whole account-current unit the core sync fetches, with the ad
 * insights paginated across two pages.
 *
 * `adInsightPages` is consumed in order, so a test can hand back a refusal on
 * a later page.
 */
function stubCoreSyncFetch(options?: {
  adInsightPages?: (() => Response)[];
}) {
  const pages = options?.adInsightPages ?? [
    () => jsonResponse({ data: PAGE_ONE, paging: { next: PAGE_TWO_URL } }),
    () => jsonResponse({ data: PAGE_TWO }),
  ];
  let adInsightCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/insights")) {
      if (url.includes("level=account")) {
        return jsonResponse({ data: [{ spend: ACCOUNT_DAY_SPEND }] });
      }
      const page = pages[adInsightCalls] ?? pages[pages.length - 1]!;
      adInsightCalls += 1;
      return page();
    }
    if (url.includes("/campaigns")) {
      return jsonResponse({
        data: [{ id: "cmp-1", effective_status: "ACTIVE", status: "ACTIVE" }],
      });
    }
    if (url.includes("/adsets")) {
      return jsonResponse({
        data: [
          {
            id: "adset-1",
            name: "Adset 1",
            campaign_id: "cmp-1",
            effective_status: "ACTIVE",
            status: "ACTIVE",
            updated_time: "2026-04-03T09:30:00.000Z",
            daily_budget: "25",
            optimization_goal: "OFFSITE_CONVERSIONS",
            bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          },
        ],
      });
    }
    if (/\/ads($|[?&])/.test(url)) {
      return jsonResponse({ data: [] });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function runCoreSyncDay() {
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
}

/** The ad-day rows the sync actually handed the warehouse, keyed by ad id. */
function writtenAdRows() {
  const rows = vi
    .mocked(warehouse.upsertMetaAdDailyRows)
    .mock.calls.flatMap(([batch]) => batch);
  return new Map(rows.map((row) => [row.adId, row]));
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.META_AUTHORITATIVE_FINALIZATION_V2 = "0";
  delete process.env.META_AUTHORITATIVE_FINALIZATION_CANARY_BUSINESSES;
  vi.mocked(warehouse.heartbeatMetaPartitionLease).mockResolvedValue(true);
  vi.mocked(warehouse.listMetaRawSnapshotsForRun).mockResolvedValue([]);
  vi.mocked(warehouse.getMetaSyncCheckpoint).mockResolvedValue(null);
  vi.mocked(warehouse.getMetaActivePublishedSliceVersion).mockResolvedValue(
    null,
  );
  vi.mocked(warehouse.persistMetaRawSnapshot).mockResolvedValue("snapshot-id");
  vi.mocked(warehouse.buildMetaRawSnapshotHash).mockReturnValue(
    "snapshot-hash",
  );
  vi.mocked(warehouse.deleteMetaSyncCheckpointsForPartition).mockResolvedValue(
    1,
  );
  vi.mocked(warehouse.supersedeMetaRawSnapshotsForPartition).mockResolvedValue(
    1,
  );
  vi.mocked(warehouse.upsertMetaAccountDailyRows).mockResolvedValue(undefined);
  vi.mocked(warehouse.upsertMetaCampaignDailyRows).mockResolvedValue(undefined);
  vi.mocked(warehouse.upsertMetaAdSetDailyRows).mockResolvedValue(undefined);
  vi.mocked(warehouse.upsertMetaAdDailyRows).mockResolvedValue(undefined);
  vi.mocked(warehouse.refreshMetaAccountDailyOverviewSummary).mockResolvedValue(
    undefined,
  );
  vi.mocked(warehouse.createMetaAuthoritativeSourceManifest).mockResolvedValue({
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
  vi.mocked(warehouse.publishMetaAuthoritativeSliceVersion).mockResolvedValue({
    id: "publication-1",
  } as never);
  vi.mocked(warehouse.updateMetaAuthoritativeSourceManifest).mockImplementation(
    async (input) => input as never,
  );
  vi.mocked(warehouse.updateMetaAuthoritativeSliceVersion).mockImplementation(
    async (input) => input as never,
  );
  vi.mocked(
    warehouse.createMetaAuthoritativeReconciliationEvent,
  ).mockResolvedValue({ id: "event-1" } as never);
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
  vi.mocked(warehouse.appendMetaCurrentConfigHistory).mockResolvedValue({
    campaignRowsWritten: 0,
    adsetRowsWritten: 0,
    campaignSkippedIncompleteReceipt: false,
    adsetSkippedIncompleteReceipt: false,
  });
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
        dailyBudget: input.campaignDailyBudget ?? firstAdset?.dailyBudget ?? null,
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
  vi.mocked(entityStateHistory.persistMetaEntityObservation).mockResolvedValue({
    runId: "observation-run-1",
    runHash: "a".repeat(64),
    semanticHash: "b".repeat(64),
    coalesced: false,
    repeatCount: 1,
    stateCount: 0,
    lineageCount: 0,
    completeness: "complete",
    observedAt: "2026-04-03T12:00:00.000Z",
    capturedAt: "2026-04-03T12:00:01.000Z",
    manifestKind: null,
    deltaStats: null,
  });
  vi.unstubAllGlobals();
});

describe("readMetaLinkClicksFromInsight", () => {
  it("reads the count out of the actions array's link_click entry", () => {
    expect(
      readMetaLinkClicksFromInsight({
        actions: actionsWithLinkClick(136) as never,
      }),
    ).toBe(136);
  });

  it("reports a MEASURED ZERO when other actions are present and link_click is not", () => {
    // The zero is Meta's, not ours. Meta enumerates the action types that
    // occurred; across the 8,640 production rows that do carry a `link_click`
    // entry the minimum value is 1 and no entry is ever written as "0", so an
    // array that lists three other action types and omits this one is the only
    // way Meta ever says "no link clicks".
    expect(
      readMetaLinkClicksFromInsight({
        actions: actionsWithoutLinkClick() as never,
      }),
    ).toBe(0);
  });

  it("reports ABSENT when the row carries no actions array at all", () => {
    // Distinct from the case above, and not interchangeable with it: 2,464
    // production rows for 2026-08-01 onwards are in this state, every one with
    // impressions > 0 and 133 with clicks > 0.
    expect(readMetaLinkClicksFromInsight({})).toBeNull();
  });

  it("refuses to turn an unparseable value into a confident zero", () => {
    expect(
      readMetaLinkClicksFromInsight({
        actions: [{ value: "n/a", action_type: "link_click" }] as never,
      }),
    ).toBeNull();
  });
});

describe("syncMetaAccountCoreWarehouseDay link-click extraction", () => {
  it("writes the summed provider count at ad-day grain across pages", async () => {
    const fetchMock = stubCoreSyncFetch();

    await runCoreSyncDay();

    // Two ad-level insight pages were actually walked, and page two was
    // reached through the provider's own `paging.next`.
    const adInsightUrls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/insights") && url.includes("level=ad"));
    expect(adInsightUrls).toHaveLength(2);
    expect(adInsightUrls[1]).toBe(PAGE_TWO_URL);

    const rows = writtenAdRows();
    // 30 on page one + 12 on page two. A per-page overwrite would have written
    // 12; a page applied twice would have written 84.
    expect(rows.get("ad-measured")?.linkClicks).toBe(42);
    // Spend is the control: it accumulates through the same visit, in the same
    // map, under the same rule, so the two must agree about how many times the
    // pages were folded in.
    expect(rows.get("ad-measured")?.spend).toBe(120);
  });

  it("keeps a measured zero and an absent count as different warehouse values", async () => {
    stubCoreSyncFetch();

    await runCoreSyncDay();

    const rows = writtenAdRows();
    // Meta reported actions on both pages and named no link clicks.
    expect(rows.get("ad-zero")?.linkClicks).toBe(0);
    // Meta reported no actions on either page. Writing 0 here is the
    // fabrication this change removes; writing null is what lets the merge
    // `COALESCE(EXCLUDED.link_clicks, meta_ad_daily.link_clicks)` keep an
    // earlier real measurement instead of erasing it.
    expect(rows.get("ad-absent")?.linkClicks).toBeNull();
    // Both ads really were captured — the null above is a link-click fact, not
    // a missing row.
    expect(rows.get("ad-absent")?.spend).toBe(20);
  });

  it("lets one measured page rescue an ad whose other page carried no actions", async () => {
    stubCoreSyncFetch();

    await runCoreSyncDay();

    // Page one had no actions array for this ad, page two measured 7. The
    // absent page contributes nothing and does not hold the ad at null.
    expect(writtenAdRows().get("ad-late")?.linkClicks).toBe(7);
  });

  it("writes no ad rows when a later insight page is a 2xx carrying a Graph error", async () => {
    // Codex item 7 reaching the bulk core sync. `fetchMetaPagedJson` used to
    // accept any 2xx, and the caller's `json.data ?? []` then turned the
    // refusal into an empty page while `json.paging?.next ?? null` ended the
    // walk — so the day finished "successfully" with page two's ads missing
    // and page one's ads written as if they were the whole day.
    stubCoreSyncFetch({
      adInsightPages: [
        () => jsonResponse({ data: PAGE_ONE, paging: { next: PAGE_TWO_URL } }),
        () =>
          jsonResponse({
            error: {
              message: "(#100) Tried accessing nonexisting field",
              type: "OAuthException",
              code: 100,
              error_subcode: 33,
              is_transient: false,
              fbtrace_id: "AbCdEfGhIjKlMnOp",
            },
          }),
      ],
    });

    /*
      RE-PINNED (Round 5 item 6). This matched `/nonexisting field|error
      envelope/` — the first alternative being Meta's own prose, quoted
      verbatim out of `json.error.message`. That message was written into
      `meta_sync_partitions.last_error` and `meta_sync_runs.error_message`, and
      Graph error text on these edges quotes the request, access token
      included. The refusal is now a typed `MetaGraphRequestError` whose
      message is built from the status and the numeric codes, so what this
      asserts is the STRUCTURE and the ABSENCE of the prose.
    */
    const thrown = await runCoreSyncDay().then(
      () => null,
      (error: unknown) => error as Error & Record<string, unknown>,
    );
    expect(thrown).not.toBeNull();
    expect(thrown!.name).toBe("MetaGraphRequestError");
    expect(thrown!.termination).toBe("error_envelope");
    expect(thrown!.httpStatus).toBe(200);
    expect(thrown!.errorCode).toBe(100);
    expect(thrown!.errorSubcode).toBe(33);
    expect(thrown!.fbtraceId).toBe("AbCdEfGhIjKlMnOp");
    expect(thrown!.message).not.toContain("nonexisting field");
    expect(warehouse.upsertMetaAdDailyRows).not.toHaveBeenCalled();
    expect(warehouse.replaceMetaAdDailySlice).not.toHaveBeenCalled();
  });
});
