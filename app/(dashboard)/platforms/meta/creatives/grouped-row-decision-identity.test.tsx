// @vitest-environment jsdom

import { useQuery } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CreativeStudioPage from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";
import { projectCanonicalNativeAdDecisionToBriefing } from "@/app/api/creatives/briefing/canonical-projection";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  applyMetaExecutionGovernanceToCanonicalDecisions,
  buildNativeMetaCanonicalDecisionInventory,
  type MetaNativeDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import { buildMetaCreativeApiRow } from "@/lib/meta/creatives-service-support";
import { groupRows } from "@/lib/meta/creatives-row-mappers";
import {
  buildCreativeUsageMap,
  buildFallbackAdRawRow,
  coerceRawCreativeRow,
  hydrateWarehouseCreativeMetrics,
} from "@/lib/meta/creatives-warehouse";
import { stripMetaCreativeMediaPayload } from "@/lib/meta/warehouse";
import type {
  MetaCreativeApiRow,
  RawCreativeRow,
} from "@/lib/meta/creatives-types";
import type {
  MetaAdDailyRow,
  MetaCreativeDailyRow,
} from "@/lib/meta/warehouse-types";
import type {
  BriefingCreativeCard,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";

/**
 * B4 — a Creative Studio row read "Not evaluated" over Ads that HAD a served
 * decision, pinned along the production chain on both sides:
 *
 *   persisted native snapshot rows
 *     -> buildNativeMetaCanonicalDecisionInventory
 *     -> applyMetaExecutionGovernanceToCanonicalDecisions
 *     -> projectCanonicalNativeAdDecisionToBriefing   (the served cards)
 *   and
 *   ad-days -> buildFallbackAdRawRow / hydrate
 *     -> groupRows("creative") -> buildMetaCreativeApiRow   (the creative-day
 *        writer's payload, when the live path is modelled)
 *     -> hydrate(creative day) -> groupRows -> buildMetaCreativeApiRow
 *     -> the page's own mapApiRowToUiRow -> the rendered Status cell.
 *
 * MEASURED, Grandmix act_805150454596350, window 2026-08-24..09-22 against the
 * 2026-09-23 native generation: 11 of 42 Assets rows ($4,657 of $31,522) read
 * "Not evaluated". Row "Cat-Sale" keyed on its earliest day's creative
 * 1684050916162467, which has no current decision, while its Ads
 * 120251840550270316 / 120251840570200316 were decided (test_more) under their
 * current creatives 2527054164481845 / 1617987753052572.
 *
 * And the opposite failure of the same join, also measured there: creative
 * 1252732400140286 is used by "Niche-CoatRack-Tree-94dcd8d6" (campaign
 * 120241060762560316, test_more) AND by "GMX-HF-CoatRack-…-R3" (campaign
 * 120251381091360316, diagnose), so a creative-id join showed both campaigns'
 * answers on one row.
 */

const navigation = vi.hoisted(() => ({
  pathname: "/platforms/meta/creatives",
  search: "",
}));

const queryState = vi.hoisted(() => ({
  accounts: undefined as unknown,
  creatives: undefined as unknown,
  briefing: undefined as unknown,
  sharedLinks: undefined as unknown,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectedBusinessId: "biz_1", businesses: [] }),
}));

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "custom",
      customStart: "2026-08-24",
      customEnd: "2026-09-22",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const useQueryMock = vi.mocked(useQuery);

const BUSINESS_ID = "biz_1";
const PROVIDER_ACCOUNT_ID = "act_805150454596350";
const AS_OF_DATE = "2026-09-23";

// Grandmix's own identities.
const CAT_SALE_AD_1 = "120251840550270316";
const CAT_SALE_AD_2 = "120251840570200316";
const CAT_SALE_FIRST_CREATIVE = "1684050916162467";
const CAT_SALE_AD_2_OLD_CREATIVE = "2035224437077363";
const CAT_SALE_AD_2_CREATIVE = "1617987753052572";
const CAT_SALE_AD_1_CREATIVE = "2527054164481845";
const NICHE_AD = "120251532272420316";
const GMX_AD = "120251381095820316";
const SHARED_CREATIVE = "1252732400140286";

// ---- the served side, through the server's own producers -----------------

function snapshotRow(input: {
  adId: string;
  creativeId: string;
  adName: string;
  campaignId: string;
  label: "test_more" | "diagnose" | "keep";
}): MetaNativeDecisionSnapshotSourceRow {
  const suffix = input.adId.slice(-12).padStart(12, "0");
  return {
    snapshot_id: `00000000-0000-4000-8000-${suffix}`,
    evaluation_id: `10000000-0000-4000-8000-${suffix}`,
    job_run_id: "20000000-0000-4000-8000-000000000001",
    provider_account_ref_id: "30000000-0000-4000-8000-000000000001",
    provider_account_id: PROVIDER_ACCOUNT_ID,
    ad_id: input.adId,
    creative_id: input.creativeId,
    as_of_date: AS_OF_DATE,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: PROVIDER_ACCOUNT_ID,
    label: input.label,
    pre_authority_label: input.label,
    authority_blocker: null,
    raw_label: input.label,
    confidence: 45,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 0.9,
    badges: [],
    reason: `${input.adName} persisted reason.`,
    spend: 150,
    purchases: 1,
    roas: 1.8,
    recent7d_roas: 1.8,
    label_transform: null,
    blocked_action_type: null,
    authorized_action: null,
    input_hash: "a".repeat(64),
    decision_hash: "b".repeat(64),
    computed_at: new Date(Date.now() - 3_600_000).toISOString(),
    episode_started_at: AS_OF_DATE,
    lineage_valid: true,
    creative_name: input.adName,
    campaign_id: input.campaignId,
    campaign_name: `Campaign ${input.campaignId}`,
    adset_id: `as_${input.campaignId}`,
    adset_name: "Broad",
    ad_name: input.adName,
    campaign_status: "ACTIVE",
    adset_status: "ACTIVE",
    ad_status: "ACTIVE",
    currency: "USD",
    thumbnail_url: null,
    media_source_present: true,
    media_available: false,
    media_source: "meta_creative_media",
    source_updated_at: `${AS_OF_DATE}T04:00:00.000Z`,
    config_authority_verified: false,
    config_evidence_lineage: null,
  } as MetaNativeDecisionSnapshotSourceRow;
}

/** The briefing the route serves for these persisted rows. */
function servedBriefing(
  rows: MetaNativeDecisionSnapshotSourceRow[],
): CreativesBriefingResponse {
  const generation = {
    jobRunId: "20000000-0000-4000-8000-000000000001",
    asOfDate: AS_OF_DATE,
    providerAccountRefId: "30000000-0000-4000-8000-000000000001",
    manifestHash: hashAdDecisionIdentityManifest({
      businessId: BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      asOfDate: AS_OF_DATE,
      adIds: rows.map((row) => row.ad_id),
    }),
    expectedAdCount: rows.length,
  };
  const inventory = buildNativeMetaCanonicalDecisionInventory({
    businessId: BUSINESS_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    generation,
    snapshotRows: rows,
  });
  expect(inventory.status).toBe("available");
  const governed = applyMetaExecutionGovernanceToCanonicalDecisions({
    decisions: inventory.items,
    governance: {
      verified: true,
      controlsConfigured: true,
      writeBlocked: false,
      blockReason: null,
    },
    pipeline: { verified: true, executionReady: true },
  });
  const lanes: Record<"action" | "watching" | "healthy", BriefingCreativeCard[]> =
    { action: [], watching: [], healthy: [] };
  for (const decision of governed) {
    const projection = projectCanonicalNativeAdDecisionToBriefing({ decision });
    expect(projection).not.toBeNull();
    lanes[projection!.lane].push(projection!.card);
  }
  return {
    actionNow: lanes.action,
    watching: lanes.watching,
    healthy: lanes.healthy,
    source: {
      canonicalDecisionInventory: {
        contractVersion: "briefing-canonical-native-ad.v1",
        status: "available",
        unavailableReason: null,
        generation,
        itemCount: governed.length,
      },
    },
  } as CreativesBriefingResponse;
}

/** The buyer label the server put on one Ad's decision. */
function servedLabelFor(
  briefing: CreativesBriefingResponse,
  adId: string,
): string {
  const card = [
    ...(briefing.actionNow ?? []),
    ...(briefing.watching ?? []),
    ...(briefing.healthy ?? []),
  ]
    .map((item) => ("primaryRec" in item ? item.primaryRec : item))
    .find((item) => item.canonicalDecision?.adId === adId);
  const label = card?.canonicalDecision?.classification.buyerLabel;
  expect(label, `no served decision for ${adId}`).toBeTruthy();
  return label!;
}

// ---- the row side, through the warehouse's own producers -----------------

function adDay(input: {
  date: string;
  adId: string;
  creativeId: string;
  name: string;
  campaignId: string;
  spend: number;
}): MetaAdDailyRow {
  return {
    businessId: BUSINESS_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    date: input.date,
    campaignId: input.campaignId,
    adsetId: `as_${input.campaignId}`,
    adId: input.adId,
    adNameCurrent: input.name,
    adNameHistorical: null,
    adStatus: "ACTIVE",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    spend: input.spend,
    impressions: 1000,
    clicks: 50,
    reach: 800,
    frequency: null,
    conversions: 1,
    revenue: input.spend * 1.8,
    roas: 1.8,
    cpa: null,
    ctr: null,
    cpc: null,
    linkClicks: 40,
    outboundClicks: null,
    landingPageViews: null,
    addToCart: null,
    initiateCheckout: null,
    viewContent: null,
    leads: null,
    postEngagement: null,
    thruplayActions: null,
    videoViews3s: null,
    payloadJson: { creative_id: input.creativeId },
  } as MetaAdDailyRow;
}

/** One ad-grain raw row per ad-day, as the ad-daily warehouse read builds it. */
function adGrainRows(days: readonly MetaAdDailyRow[]): RawCreativeRow[] {
  return days.map((factRow) =>
    hydrateWarehouseCreativeMetrics({
      row: buildFallbackAdRawRow({
        factRow,
        projectionJson: null,
        creativeId: (factRow.payloadJson as { creative_id: string }).creative_id,
      }),
      factRow,
    }),
  );
}

function toApiRows(rows: RawCreativeRow[]): MetaCreativeApiRow[] {
  return rows.map((row) =>
    buildMetaCreativeApiRow({
      row,
      cachedThumbnailUrl: null,
      cardFallbackThumbnailUrl: null,
      includeDebugFields: false,
    }),
  );
}

/** The ad-daily read: warehouse-ordered ad-days grouped at creative grain. */
function adDailyReadApiRows(days: readonly MetaAdDailyRow[]) {
  const raw = adGrainRows(days);
  return toApiRows(groupRows(raw, "creative", buildCreativeUsageMap(raw)));
}

/**
 * The creative-day writer, one sync per day: the day's ad rows round-trip the
 * ad-grain API row, are grouped at creative grain, and each group is persisted
 * with `buildMetaCreativeApiRow`'s row as `payload_json`
 * (`syncMetaCreativesWarehouseDay`).
 */
function syncCreativeDays(days: readonly MetaAdDailyRow[]): MetaCreativeDailyRow[] {
  const byDate = new Map<string, MetaAdDailyRow[]>();
  for (const day of days) {
    byDate.set(day.date, [...(byDate.get(day.date) ?? []), day]);
  }
  const persisted: MetaCreativeDailyRow[] = [];
  for (const [date, facts] of byDate) {
    const rawRows = toApiRows(adGrainRows(facts))
      .map((row) => coerceRawCreativeRow(row))
      .filter((row): row is RawCreativeRow => Boolean(row));
    for (const row of groupRows(rawRows, "creative", buildCreativeUsageMap(rawRows))) {
      persisted.push({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        date,
        campaignId: row.campaign_id,
        adsetId: row.adset_id,
        adId: row.id,
        creativeId: row.creative_id,
        creativeName: row.name,
        headline: null,
        primaryText: null,
        destinationUrl: null,
        thumbnailUrl: null,
        assetType: row.format,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        reach: row.reach ?? row.impressions,
        frequency: row.frequency ?? null,
        conversions: row.purchases,
        revenue: row.purchase_value,
        roas: row.roas,
        cpa: row.cpa,
        ctr: row.ctr_all,
        cpc: row.cpc_link,
        linkClicks: row.link_clicks,
        sourceSnapshotId: null,
        payloadJson: buildMetaCreativeApiRow({
          row,
          cachedThumbnailUrl: null,
          cardFallbackThumbnailUrl: null,
          includeDebugFields: false,
        }),
      } as MetaCreativeDailyRow);
    }
  }
  return persisted;
}

/** A creative day as persisted before the source lists existed. */
function withoutSourceLists(day: MetaCreativeDailyRow): MetaCreativeDailyRow {
  const payload = { ...(day.payloadJson as Record<string, unknown>) };
  delete payload.source_ad_ids;
  delete payload.source_ad_ids_complete;
  delete payload.source_creative_ids;
  return { ...day, payloadJson: payload };
}

/**
 * The creative-grain read the Studio page makes (`groupBy=creative` ->
 * `getMetaCreativesWarehousePayload`): each persisted day hydrated over its
 * creative's dimension projection — the payload of whichever day synced last
 * for that creative — then grouped across the window.
 */
function creativeDailyReadApiRows(days: readonly MetaCreativeDailyRow[]) {
  const dimensions = new Map<string, unknown>();
  for (const day of days) {
    dimensions.set(day.creativeId, stripMetaCreativeMediaPayload(day.payloadJson));
  }
  const raw = days.flatMap((factRow) => {
    const projection = coerceRawCreativeRow(dimensions.get(factRow.creativeId));
    return projection
      ? [hydrateWarehouseCreativeMetrics({ row: projection, factRow })]
      : [];
  });
  return toApiRows(groupRows(raw, "creative", buildCreativeUsageMap(raw)));
}

function renderStudio(input: {
  rows: MetaCreativeApiRow[];
  briefing: CreativesBriefingResponse;
}) {
  queryState.creatives = {
    status: "ok",
    rows: input.rows,
    warehouse_observed_at: null,
  };
  queryState.briefing = input.briefing;
  render(
    <CreativeStudioPage
      businessId={BUSINESS_ID}
      providerAccountId={PROVIDER_ACCOUNT_ID}
    />,
  );
}

/**
 * The classification each rendered row's Status cell carries, by rendered
 * creative name. Read from the cell's own `data-creative-classification` (the
 * cell text prefixes the served segment, "Monitor · Test more").
 */
function statusByName(): Record<string, string> {
  const headers = Array.from(document.querySelectorAll("thead th")).map(
    (cell) => cell.textContent?.replace(/[▲▼↑↓]/g, "").trim() ?? "",
  );
  const statusIndex = headers.indexOf("Status");
  expect(statusIndex, 'no "Status" column is on screen').toBeGreaterThan(-1);
  const result: Record<string, string> = {};
  for (const row of Array.from(
    document.querySelectorAll("[data-creative-studio-asset-row]"),
  )) {
    const name =
      row.querySelector("td:nth-child(2) span span")?.textContent?.trim() ?? "";
    result[name] =
      Array.from(row.querySelectorAll("td"))
        [statusIndex]?.querySelector("[data-creative-classification]")
        ?.getAttribute("data-creative-classification") ?? "";
  }
  return result;
}

// ---- fixtures --------------------------------------------------------------

/**
 * Warehouse order (date ASC). Each Cat-Sale Ad's creative is replaced inside
 * the window; the first creative the group meets (1684…, Ad 1 on 08-24) is
 * one neither Ad carries any more.
 */
const CAT_SALE_DAYS = [
  adDay({ date: "2026-08-24", adId: CAT_SALE_AD_1, creativeId: CAT_SALE_FIRST_CREATIVE, name: "Cat-Sale", campaignId: "cmp_catalog", spend: 137.52 }),
  adDay({ date: "2026-08-24", adId: CAT_SALE_AD_2, creativeId: CAT_SALE_AD_2_OLD_CREATIVE, name: "Cat-Sale", campaignId: "cmp_catalog", spend: 60 }),
  adDay({ date: "2026-09-16", adId: CAT_SALE_AD_2, creativeId: CAT_SALE_AD_2_CREATIVE, name: "Cat-Sale", campaignId: "cmp_catalog", spend: 41.94 }),
  adDay({ date: "2026-09-16", adId: CAT_SALE_AD_1, creativeId: CAT_SALE_FIRST_CREATIVE, name: "Cat-Sale", campaignId: "cmp_catalog", spend: 30 }),
  adDay({ date: "2026-09-21", adId: CAT_SALE_AD_1, creativeId: CAT_SALE_AD_1_CREATIVE, name: "Cat-Sale", campaignId: "cmp_catalog", spend: 0.89 }),
  adDay({ date: "2026-09-21", adId: CAT_SALE_AD_2, creativeId: CAT_SALE_AD_2_CREATIVE, name: "Cat-Sale", campaignId: "cmp_catalog", spend: 25.19 }),
];

/**
 * The Grandmix shape: only the Niche Ad delivered in the window, while the GMX
 * Ad in another campaign — same creative id — was still decided.
 */
const NICHE_DAYS = [
  adDay({ date: "2026-09-10", adId: NICHE_AD, creativeId: SHARED_CREATIVE, name: "Niche-CoatRack-Tree-94dcd8d6", campaignId: "120241060762560316", spend: 80 }),
  adDay({ date: "2026-09-11", adId: NICHE_AD, creativeId: SHARED_CREATIVE, name: "Niche-CoatRack-Tree-94dcd8d6", campaignId: "120241060762560316", spend: 52 }),
];

/** Both campaigns delivering, each Ad under its own name. */
const SHARED_CREATIVE_DAYS = [
  ...NICHE_DAYS,
  adDay({ date: "2026-09-10", adId: GMX_AD, creativeId: SHARED_CREATIVE, name: "GMX-HF-CoatRack-Tree-Shaped-Coat-Rack-94dcd8d6-R3", campaignId: "120251381091360316", spend: 52 }),
];

const SERVED_ROWS = [
  snapshotRow({ adId: CAT_SALE_AD_1, creativeId: CAT_SALE_AD_1_CREATIVE, adName: "Cat-Sale", campaignId: "cmp_catalog", label: "test_more" }),
  snapshotRow({ adId: CAT_SALE_AD_2, creativeId: CAT_SALE_AD_2_CREATIVE, adName: "Cat-Sale", campaignId: "cmp_catalog", label: "test_more" }),
  snapshotRow({ adId: NICHE_AD, creativeId: SHARED_CREATIVE, adName: "Niche-CoatRack-Tree-94dcd8d6", campaignId: "120241060762560316", label: "test_more" }),
  snapshotRow({ adId: GMX_AD, creativeId: SHARED_CREATIVE, adName: "GMX-HF-CoatRack-Tree-Shaped-Coat-Rack-94dcd8d6-R3", campaignId: "120251381091360316", label: "diagnose" }),
];

beforeEach(() => {
  navigation.pathname = "/platforms/meta/creatives";
  navigation.search = "";
  queryState.accounts = [
    { id: PROVIDER_ACCOUNT_ID, name: "Grandmix", timezone: "UTC", currency: "USD" },
  ];
  queryState.creatives = undefined;
  queryState.briefing = undefined;
  queryState.sharedLinks = undefined;
  window.localStorage.clear();
  useQueryMock.mockReset();
  useQueryMock.mockImplementation(
    (options: { queryKey?: readonly unknown[] }) => {
      const key = options.queryKey?.[0];
      const data =
        key === "meta-provider-accounts"
          ? queryState.accounts
          : key === "meta-creative-studio"
            ? queryState.creatives
            : key === "creative-share-links"
              ? queryState.sharedLinks
              : queryState.briefing;
      return {
        data,
        error: null,
        fetchStatus: "idle",
        isError: false,
        isFetching: false,
        isLoading: false,
        refetch: vi.fn(),
        status: data ? "success" : "pending",
      } as unknown as ReturnType<typeof useQuery>;
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("B4 — a grouped Studio row is matched to served decisions by its member identities", () => {
  it("carries every member Ad and creative on the grouped row without changing the sampled ids", () => {
    const [row] = adDailyReadApiRows(CAT_SALE_DAYS);

    // The grouping and its sampled fields are exactly what they were.
    expect(row!.creative_id).toBe(CAT_SALE_FIRST_CREATIVE);
    expect(row!.real_ad_id).toBe(CAT_SALE_AD_1);
    expect(row!.associated_ads_count).toBe(2);
    expect(row!.source_ad_ids).toEqual([CAT_SALE_AD_1, CAT_SALE_AD_2]);
    expect(row!.source_ad_ids_complete).toBe(true);
    expect(row!.source_creative_ids).toEqual([
      CAT_SALE_FIRST_CREATIVE,
      CAT_SALE_AD_2_OLD_CREATIVE,
      CAT_SALE_AD_2_CREATIVE,
      CAT_SALE_AD_1_CREATIVE,
    ]);
  });

  it("shows the served decisions of a group whose earliest-day creative was replaced (ad-daily read)", () => {
    const briefing = servedBriefing(SERVED_ROWS.slice(0, 2));
    renderStudio({ rows: adDailyReadApiRows(CAT_SALE_DAYS), briefing });

    const status = statusByName()["Cat-Sale"];
    expect(status).toBe(servedLabelFor(briefing, CAT_SALE_AD_1));
    expect(status).toBe(servedLabelFor(briefing, CAT_SALE_AD_2));
    expect(status).not.toBe("Not evaluated");
  });

  it("does not import another campaign's decision through a shared creative id", () => {
    const briefing = servedBriefing(SERVED_ROWS.slice(2));
    const nicheLabel = servedLabelFor(briefing, NICHE_AD);
    const gmxLabel = servedLabelFor(briefing, GMX_AD);
    expect(nicheLabel).not.toBe(gmxLabel);

    renderStudio({ rows: adDailyReadApiRows(SHARED_CREATIVE_DAYS), briefing });

    const status = statusByName();
    expect(status["Niche-CoatRack-Tree-94dcd8d6"]).toBe(nicheLabel);
    expect(status["GMX-HF-CoatRack-Tree-Shaped-Coat-Rack-94dcd8d6-R3"]).toBe(
      gmxLabel,
    );
  });

  it("reads 'Not evaluated' when none of a complete group's Ads was decided, even though its creative was", () => {
    // Only the GMX Ad is in the generation; the Niche row shares its creative.
    const briefing = servedBriefing(SERVED_ROWS.slice(3));
    renderStudio({ rows: adDailyReadApiRows(SHARED_CREATIVE_DAYS), briefing });

    const status = statusByName();
    expect(status["Niche-CoatRack-Tree-94dcd8d6"]).toBe("Not evaluated");
    expect(status["GMX-HF-CoatRack-Tree-Shaped-Coat-Rack-94dcd8d6-R3"]).toBe(
      servedLabelFor(briefing, GMX_AD),
    );
  });

  it("matches through the creative-day read the page makes, from payloads the day writer persists", () => {
    const briefing = servedBriefing(SERVED_ROWS);
    const days = syncCreativeDays([...CAT_SALE_DAYS, ...NICHE_DAYS]);
    // A persisted creative day is a group whose `ad_id` is its handle.
    expect(days.every((day) => day.adId?.startsWith("creative_"))).toBe(true);

    const rows = creativeDailyReadApiRows(days);
    const catSale = rows.find((row) => row.name === "Cat-Sale")!;
    expect(catSale.creative_id).toBe(CAT_SALE_FIRST_CREATIVE);
    expect(catSale.source_ad_ids).toEqual([CAT_SALE_AD_1, CAT_SALE_AD_2]);
    expect(catSale.source_ad_ids_complete).toBe(true);

    renderStudio({ rows, briefing });

    const status = statusByName();
    expect(status["Cat-Sale"]).toBe(servedLabelFor(briefing, CAT_SALE_AD_1));
    expect(status["Niche-CoatRack-Tree-94dcd8d6"]).toBe(
      servedLabelFor(briefing, NICHE_AD),
    );
  });

  it("matches creative days persisted before the source lists existed by the Ad each day recorded", () => {
    const briefing = servedBriefing(SERVED_ROWS);
    const days = syncCreativeDays([...CAT_SALE_DAYS, ...NICHE_DAYS]).map(
      withoutSourceLists,
    );

    const rows = creativeDailyReadApiRows(days);
    const catSale = rows.find((row) => row.name === "Cat-Sale")!;
    // A multi-Ad day recorded only its first Ad, so the list is partial —
    // but every day's first Ad is an exact member, and here both were first
    // on some day.
    expect(catSale.source_ad_ids).toEqual([CAT_SALE_AD_1, CAT_SALE_AD_2]);
    expect(catSale.source_ad_ids_complete).toBe(false);
    const niche = rows.find(
      (row) => row.name === "Niche-CoatRack-Tree-94dcd8d6",
    )!;
    // A one-Ad day recorded all of its Ads.
    expect(niche.source_ad_ids).toEqual([NICHE_AD]);
    expect(niche.source_ad_ids_complete).toBe(true);

    renderStudio({ rows, briefing });

    const status = statusByName();
    expect(status["Cat-Sale"]).toBe(servedLabelFor(briefing, CAT_SALE_AD_1));
    expect(status["Niche-CoatRack-Tree-94dcd8d6"]).toBe(
      servedLabelFor(briefing, NICHE_AD),
    );
  });

  it("does not guess an unrecorded Ad from a shared creative when the member list is partial", () => {
    // Two Ads, one creative, one day, persisted before the source lists: the
    // day recorded only its first Ad, which the generation did not decide.
    const firstAd = "120250000000000001";
    const unrecordedAd = "120250000000000002";
    const duplicatedCreative = "1999000000000001";
    const briefing = servedBriefing([
      snapshotRow({ adId: unrecordedAd, creativeId: duplicatedCreative, adName: "Dup-Hero", campaignId: "cmp_dup", label: "keep" }),
    ]);
    const days = syncCreativeDays([
      adDay({ date: "2026-09-12", adId: firstAd, creativeId: duplicatedCreative, name: "Dup-Hero", campaignId: "cmp_dup", spend: 40 }),
      adDay({ date: "2026-09-12", adId: unrecordedAd, creativeId: duplicatedCreative, name: "Dup-Hero", campaignId: "cmp_dup", spend: 30 }),
    ]).map(withoutSourceLists);
    const rows = creativeDailyReadApiRows(days);
    expect(rows[0]!.source_ad_ids).toEqual([firstAd]);
    expect(rows[0]!.source_ad_ids_complete).toBe(false);

    renderStudio({ rows, briefing });

    // The missing Ad may be a member, but that is not evidence that it is.
    expect(statusByName()["Dup-Hero"]).toBe("Decision membership unverified");
  });

  it("does not assign an Ad decision when the row carries no member identities", () => {
    const briefing = servedBriefing(SERVED_ROWS.slice(0, 2));
    const rows = adDailyReadApiRows(CAT_SALE_DAYS.slice(4, 5)).map((row) => {
      const legacy = { ...row };
      delete legacy.source_ad_ids;
      delete legacy.source_ad_ids_complete;
      delete legacy.source_creative_ids;
      legacy.real_ad_id = null;
      return legacy;
    });
    expect(rows[0]!.creative_id).toBe(CAT_SALE_AD_1_CREATIVE);

    renderStudio({ rows, briefing });

    expect(statusByName()["Cat-Sale"]).toBe("Decision membership unverified");
  });

  it("assigns old single-Ad snapshot rows by exact Ad without mixing shared-creative campaigns", () => {
    const briefing = servedBriefing(SERVED_ROWS.slice(2));
    const rows = adDailyReadApiRows(SHARED_CREATIVE_DAYS).map((row) => {
      const legacy = { ...row };
      delete legacy.source_ad_ids;
      delete legacy.source_ad_ids_complete;
      delete legacy.source_creative_ids;
      expect(legacy.associated_ads_count).toBe(1);
      return legacy;
    });

    renderStudio({ rows, briefing });

    const status = statusByName();
    expect(status["Niche-CoatRack-Tree-94dcd8d6"]).toBe(
      servedLabelFor(briefing, NICHE_AD),
    );
    expect(status["GMX-HF-CoatRack-Tree-Shaped-Coat-Rack-94dcd8d6-R3"]).toBe(
      servedLabelFor(briefing, GMX_AD),
    );
  });

  it("does not import another campaign's canonical answer through a partial shared creative", () => {
    const firstAd = "120250000000000011";
    const hiddenAd = "120250000000000012";
    const otherCampaignAd = "120250000000000013";
    const sharedCreative = "1999000000000011";
    const briefing = servedBriefing([
      snapshotRow({
        adId: otherCampaignAd,
        creativeId: sharedCreative,
        adName: "Other Campaign",
        campaignId: "cmp_other",
        label: "diagnose",
      }),
    ]);
    const rows = adDailyReadApiRows([
      adDay({ date: "2026-09-12", adId: firstAd, creativeId: sharedCreative, name: "Partial Hero", campaignId: "cmp_partial", spend: 40 }),
      adDay({ date: "2026-09-12", adId: hiddenAd, creativeId: sharedCreative, name: "Partial Hero", campaignId: "cmp_partial", spend: 30 }),
      adDay({ date: "2026-09-12", adId: otherCampaignAd, creativeId: sharedCreative, name: "Other Campaign", campaignId: "cmp_other", spend: 20 }),
    ]);
    const partial = rows.find((row) => row.name === "Partial Hero")!;
    // This is the page's API row with the membership an older creative-day
    // payload could actually preserve: its first Ad, without a completeness
    // claim. The separate creative-day chain above covers that write shape.
    partial.source_ad_ids = [firstAd];
    partial.source_ad_ids_complete = false;
    expect(partial.source_ad_ids).toEqual([firstAd]);
    expect(partial.source_ad_ids_complete).toBe(false);

    renderStudio({ rows, briefing });
    const status = statusByName();
    expect(status["Partial Hero"]).toBe("Decision membership unverified");
    expect(status["Other Campaign"]).toBe(
      servedLabelFor(briefing, otherCampaignAd),
    );
  });
});
