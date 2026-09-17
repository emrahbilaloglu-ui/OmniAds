import { isDemoBusiness } from "@/lib/business-mode.server";
import { getBusinessTimezone } from "@/lib/account-store";
import { getDemoOverview, getDemoSparklines, isDemoBusinessId } from "@/lib/demo-business";
import {
  getGoogleCanonicalOverviewSummary,
  getGoogleCanonicalOverviewTrends,
} from "@/lib/google-ads/serving";
import { getGa4EcommerceFallbackData, type Ga4EcommerceFallback } from "@/lib/ga4-ecommerce-fallback";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { getIntegration, getIntegrationMetadata } from "@/lib/integrations";
import {
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
  getProviderAccountAssignments,
} from "@/lib/provider-account-assignments";
import {
  enumerateDays,
  nDaysAgo,
  parseActionValue,
  round2,
  toISODate,
} from "@/lib/overview-service-support";
import {
  applyEcommerceSourcePriority,
  buildOverviewResponse,
} from "@/lib/overview-response-support";
import {
  getMetaCanonicalOverviewSummary,
  getMetaCanonicalOverviewTrends,
} from "@/lib/meta/canonical-overview";
import { logPerfEvent, measurePerf } from "@/lib/perf";
import { logRuntimeDebug } from "@/lib/runtime-logging";
import {
  getShopifyOverviewReadCandidate,
  getShopifyOverviewSummaryReadCandidate,
  type ShopifyOverviewServingMetadata,
} from "@/lib/shopify/read-adapter";
import { getShopifyCustomerEventsAggregate } from "@/lib/shopify/customer-events-analytics";
import type { ShopifyOverviewAggregate } from "@/lib/shopify/overview";
import {
  type GoogleScalarSource,
  type GoogleTrendSource,
  type MetaScalarSource,
  type MetaTrendSource,
  type ProviderScalarSources,
  type ProviderTrendSources,
  metaWarehouseSource,
} from "@/lib/overview-provider-metrics";

interface TrendPoint {
  date: string;
  spend: number;
  revenue: number;
  purchases: number;
}

interface PlatformEfficiencyRow {
  platform: string;
  spend: number;
  revenue: number;
  roas: number;
  purchases: number;
  cpa: number;
  /**
   * Delivery primitives from the same provider read as spend. Optional because
   * a row from an older payload or a source that did not report them is
   * unknown, not zero; provider cards derive CTR/CPC/CPM only when present.
   */
  impressions?: number;
  clicks?: number;
}

export interface DailyTrendPoint {
  date: string;
  spend: number;
  revenue: number;
  purchases: number;
}

/**
 * One provider day, present only when the provider reported at least one row
 * for that date. Impressions and clicks are null when a reported row omitted
 * them, so a rate series can drop the day instead of plotting a fabricated zero.
 */
export interface ProviderDailyTrendPoint extends DailyTrendPoint {
  impressions: number | null;
  clicks: number | null;
}

export interface OverviewTrendBundle {
  combined: DailyTrendPoint[];
  providerTrends: Partial<Record<"meta" | "google", ProviderDailyTrendPoint[]>>;
  /** Which read produced each provider's points; null when that read failed. */
  providerTrendSources: ProviderTrendSources;
  shopifyDaily?: ShopifyOverviewAggregate["dailyTrends"];
  shopifyCommerceAvailable?: boolean;
  shopifyConnectionState?: ShopifyConnectionState;
}

export type ShopifyConnectionState = "connected" | "disconnected" | "unknown";

export interface OverviewResponse {
  businessId: string;
  dateRange: { startDate: string; endDate: string };
  shopifyConnectionState?: ShopifyConnectionState;
  status?: string;
  kpis: {
    spend: number;
    revenue: number;
    roas: number;
    purchases: number;
    cpa: number;
    aov: number;
  };
  kpiSources: Partial<
    Record<
      keyof OverviewResponse["kpis"],
      {
        source:
          | "shopify_ledger"
          | "shopify_warehouse"
          | "shopify_live_fallback"
          | "ga4_fallback"
          | "ad_platforms"
          | "unavailable";
        label: string;
      }
    >
  >;
  totals: {
    impressions: number;
    clicks: number;
    purchases: number;
    spend: number;
    conversions: number;
    revenue: number;
    ctr: number;
    cpm: number;
    cpc: number;
    cpa: number;
    roas: number;
  };
  platformEfficiency: PlatformEfficiencyRow[];
  /** The read behind each provider's platform rows; null when none was usable. */
  providerSources?: ProviderScalarSources;
  /** Exact scalar coverage used by each provider; null when no provider row was usable. */
  providerScalarRanges?: ProviderScalarRanges;
  shopifyServing?: ShopifyOverviewServingMetadata | null;
  providerTrends?: Partial<Record<"meta" | "google", ProviderDailyTrendPoint[]>>;
  providerTrendSources?: ProviderTrendSources;
  trends: {
    "7d": TrendPoint[];
    "14d": TrendPoint[];
    "30d": TrendPoint[];
    custom: TrendPoint[];
  };
}

export interface ProviderReadRange {
  startDate: string;
  endDate: string;
}

export interface ProviderScalarRanges {
  meta: ProviderReadRange | null;
  google: ProviderReadRange | null;
}

function normalizeOverviewTrendDate(value: string | Date) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return text.slice(0, 10);
}

interface MetaOverviewFragment {
  spend: number;
  revenue: number;
  purchases: number;
  clicks: number;
  impressions: number;
  rows: PlatformEfficiencyRow[];
  /** Null whenever `rows` is empty, or when a warehouse read did not name its grain. */
  source: MetaScalarSource | null;
  range: ProviderReadRange | null;
}

interface GoogleOverviewFragment {
  spend: number;
  revenue: number;
  purchases: number;
  clicks: number;
  impressions: number;
  row: PlatformEfficiencyRow | null;
  /** Null whenever `row` is null. */
  source: GoogleScalarSource | null;
  range: ProviderReadRange | null;
}

interface DailyTrendsBundle {
  combined: TrendPoint[];
  providerTrends: Partial<Record<"meta" | "google", ProviderDailyTrendPoint[]>>;
  providerTrendSources: ProviderTrendSources;
  shopifyDaily: ShopifyOverviewAggregate["dailyTrends"];
  shopifyCommerceAvailable: boolean;
  shopifyConnectionState: ShopifyConnectionState;
}

interface TimedResult<T> {
  durationMs: number;
  result: T;
}

interface MetaAccessContext {
  assignedAccountIds: string[];
  connected: boolean;
}

interface GoogleAccessContext {
  assignedAccountIds: string[];
}

const META_OVERVIEW_CACHE_TTL_MINUTES = 15;
const META_ACCESS_CACHE_TTL_MS = 30 * 1000;
const metaAccessCache = new Map<string, { expiresAt: number; value: Promise<MetaAccessContext> }>();

async function getGa4EcommerceFallback(
  businessId: string,
  startDate: string,
  endDate: string
): Promise<Ga4EcommerceFallback | null> {
  return getGa4EcommerceFallbackData(businessId, startDate, endDate);
}

/**
 * Returns a deliberately small connection-state contract for commerce source
 * selection. A successful read with no Shopify row is a confirmed disconnect;
 * error or unexpected persisted states remain unknown and must fail closed.
 */
export async function getShopifyConnectionState(
  businessId: string,
): Promise<ShopifyConnectionState> {
  try {
    const integration = await getIntegration(businessId, "shopify");
    if (!integration || integration.status === "disconnected") return "disconnected";
    if (integration.status === "connected") return "connected";
    return "unknown";
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[overview] shopify integration state unavailable", { businessId, message });
    return "unknown";
  }
}

async function getMetaAccessContext(businessId: string): Promise<MetaAccessContext> {
  const cached = metaAccessCache.get(businessId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = (async () => {
    let assignedAccountIds: string[] = [];
    try {
      const readiness = await getDbSchemaReadiness({
        tables: [...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES],
      });
      if (readiness.ready) {
        const row = await getProviderAccountAssignments(businessId, "meta");
        assignedAccountIds = row?.account_ids ?? [];
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[overview] assignment read failed", {
        businessId,
        message,
      });
    }

    let connected = false;
    try {
      const integration = await getIntegrationMetadata(businessId, "meta");
      connected = Boolean(integration?.status === "connected");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[overview] integration read failed", {
        businessId,
        message,
      });
    }

    return { assignedAccountIds, connected };
  })();

  metaAccessCache.set(businessId, {
    expiresAt: Date.now() + META_ACCESS_CACHE_TTL_MS,
    value,
  });
  return value;
}

async function getGoogleAccessContext(businessId: string): Promise<GoogleAccessContext> {
  try {
    const assignment = await getProviderAccountAssignments(businessId, "google");
    return {
      assignedAccountIds: assignment?.account_ids ?? [],
    };
  } catch {
    return { assignedAccountIds: [] };
  }
}

async function getMetaOverviewFragment(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<MetaOverviewFragment> {
  try {
    const canonicalSummary = await getMetaCanonicalOverviewSummary({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    const totals = canonicalSummary.totals;
    const fragmentTotals = {
      spend: totals.spend,
      revenue: totals.revenue,
      purchases: totals.conversions,
      clicks: Number(totals.clicks ?? 0),
      impressions: Number(totals.impressions ?? 0),
    };

    if (canonicalSummary.readSource === "warehouse_published") {
      // Account rows are the published warehouse slice itself, so they are
      // the platform rows only for a warehouse read.
      if (canonicalSummary.accounts.length > 0) {
        return {
          ...fragmentTotals,
          rows: canonicalSummary.accounts.map((account) => ({
            platform: "meta",
            spend: account.spend,
            revenue: account.revenue,
            purchases: account.conversions,
            cpa: account.conversions > 0 ? account.spend / account.conversions : 0,
            roas: account.roas,
            impressions: reportedCount(account.impressions),
            clicks: reportedCount(account.clicks),
          })),
          // The grain (campaign_daily or account_daily) is part of the source,
          // so a campaign-grain total is never paired with account-grain rows.
          source: metaWarehouseSource(canonicalSummary.warehouseScope),
          range: {
            startDate: input.startDate,
            endDate: canonicalSummary.effectiveEndDate ?? input.endDate,
          },
        };
      }
    } else if (!canonicalSummary.isPartial) {
      // Live reads (today, or a range the warehouse cannot serve) replace the
      // totals but may keep a partial warehouse `accounts` slice, so they
      // become ONE provider row built from the live totals. `isPartial` is how
      // the canonical read says the live totals are not ready yet; an unready
      // read stays unknown instead of becoming a measured zero.
      return {
        ...fragmentTotals,
        rows: [
          {
            platform: "meta",
            spend: totals.spend,
            revenue: totals.revenue,
            purchases: totals.conversions,
            cpa: totals.conversions > 0 ? totals.spend / totals.conversions : 0,
            roas: totals.roas,
            impressions: reportedCount(totals.impressions),
            clicks: reportedCount(totals.clicks),
          },
        ],
        source: canonicalSummary.readSource,
        range: {
          startDate: input.startDate,
          endDate: canonicalSummary.effectiveEndDate ?? input.endDate,
        },
      };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[overview] meta canonical summary unavailable", {
      businessId: input.businessId,
      message,
    });
  }
  return { spend: 0, revenue: 0, purchases: 0, clicks: 0, impressions: 0, rows: [], source: null, range: null };
}

/**
 * A delivery count the provider actually reported. Anything else — absent,
 * null, non-numeric — stays undefined so downstream rates read it as unknown
 * rather than as a measured zero.
 */
function reportedCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface ProviderTrendAccumulator {
  spend: number;
  revenue: number;
  purchases: number;
  /** Null once any contributing row failed to report the primitive. */
  impressions: number | null;
  clicks: number | null;
}

interface ProviderTrendSourceRow {
  date: string | Date;
  spend?: number | null;
  revenue?: number | null;
  conversions?: number | null;
  impressions?: number | null;
  clicks?: number | null;
}

/** Sums provider rows per day; delivery primitives stay unknown unless every row reported them. */
function accumulateProviderTrendRows(rows: readonly ProviderTrendSourceRow[]) {
  const byDate = new Map<string, ProviderTrendAccumulator>();
  for (const row of rows) {
    const date = normalizeOverviewTrendDate(row.date);
    const current = byDate.get(date) ?? {
      spend: 0,
      revenue: 0,
      purchases: 0,
      impressions: 0,
      clicks: 0,
    };
    current.spend += Number(row.spend ?? 0);
    current.revenue += Number(row.revenue ?? 0);
    current.purchases += Number(row.conversions ?? 0);
    const impressions = reportedCount(row.impressions);
    const clicks = reportedCount(row.clicks);
    current.impressions =
      current.impressions === null || impressions === undefined ? null : current.impressions + impressions;
    current.clicks = current.clicks === null || clicks === undefined ? null : current.clicks + clicks;
    byDate.set(date, current);
  }
  return byDate;
}

/**
 * One reported provider day. Callers only build points for dates the provider
 * actually returned; a measured zero stays zero. Purchases keep two decimals
 * because Google conversions are fractional under data-driven attribution.
 */
function toProviderTrendPoint(date: string, row: ProviderTrendAccumulator): ProviderDailyTrendPoint {
  return {
    date,
    spend: round2(row.spend),
    revenue: round2(row.revenue),
    purchases: round2(row.purchases),
    impressions: row.impressions,
    clicks: row.clicks,
  };
}

function reportedProviderTrend(dates: readonly string[], byDate: Map<string, ProviderTrendAccumulator>) {
  return dates.flatMap((date) => {
    const row = byDate.get(date);
    return row ? [toProviderTrendPoint(date, row)] : [];
  });
}

async function getGoogleOverviewFragment(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<GoogleOverviewFragment> {
  const googleOverview = await getGoogleCanonicalOverviewSummary({
    businessId: input.businessId,
    accountId: null,
    dateRange: "custom",
    customStart: input.startDate,
    customEnd: input.endDate,
    compareMode: "none",
    debug: false,
    source: "overview_aggregation_route",
  });

  const spend = Number(googleOverview.kpis.spend ?? 0);
  const revenue = Number(googleOverview.kpis.revenue ?? 0);
  const purchases = Number(googleOverview.kpis.conversions ?? 0);
  const clicks = Number(googleOverview.kpis.clicks ?? 0);
  const impressions = Number(googleOverview.kpis.impressions ?? 0);

  const source = measuredGoogleScalarSource(googleOverview);
  // Row existence follows read coverage, never metric magnitude: a covered
  // window that spent nothing is a measured zero, not a missing provider.
  const row: PlatformEfficiencyRow | null =
    source !== null
      ? {
          platform: "google",
          spend,
          revenue,
          roas: Number(googleOverview.kpis.roas ?? 0),
          purchases,
          cpa: Number(googleOverview.kpis.cpa ?? 0),
          impressions: reportedCount(googleOverview.kpis.impressions),
          clicks: reportedCount(googleOverview.kpis.clicks),
        }
      : null;
  const payload: GoogleOverviewFragment = {
    spend,
    revenue,
    purchases,
    clicks,
    impressions,
    row,
    source,
    range: source ? { startDate: input.startDate, endDate: input.endDate } : null,
  };

  return payload;
}

/**
 * The Google scalar source when the canonical read actually measured the
 * window, otherwise null.
 *
 * - A warehouse aggregate is measured when it covered at least one row
 *   (`summary.totalAccounts` counts the account or campaign rows it summed).
 * - The current-day live overlay is measured when its authoritative
 *   `customer_summary` query ran and did not fail, even if every KPI is zero.
 */
function measuredGoogleScalarSource(
  overview: Awaited<ReturnType<typeof getGoogleCanonicalOverviewSummary>>,
): GoogleScalarSource | null {
  const readSource = overview.summary?.readSource ?? overview.meta?.readSource ?? null;
  if (readSource === "warehouse_account_aggregate" || readSource === "warehouse_campaign_aggregate_fallback") {
    return Number(overview.summary?.totalAccounts ?? 0) > 0 ? readSource : null;
  }
  if (readSource === "live_overlay_current_day") {
    const ran = overview.meta?.query_names ?? [];
    const failed = (overview.meta?.failed_queries ?? []).some((failure) => failure.query === "customer_summary");
    return ran.includes("customer_summary") && !failed ? readSource : null;
  }
  return null;
}

async function measureComponent<T>(operation: () => Promise<T>): Promise<TimedResult<T>> {
  const startedAt = Date.now();
  const result = await operation();
  return {
    durationMs: Date.now() - startedAt,
    result,
  };
}

async function resolveShopifyOverviewAggregateForRead(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  purpose?: "summary" | "full";
  timeZone?: string | null;
}) {
  // Request-time reads stay projection-backed; the full diagnostic candidate remains
  // available to sync/evidence lanes that still need live-vs-warehouse comparison.
  const candidate = await getShopifyOverviewSummaryReadCandidate(input);
  const customerEventsTimeZone =
    input.timeZone ??
    (input.purpose === "full"
      ? await getBusinessTimezone(input.businessId).catch(() => null)
      : null);
  const customerEventsRegisteredAt = candidate.customerEventsRegisteredAt ?? null;
  const customerEventsCoverRange = Boolean(
    customerEventsRegisteredAt &&
      customerEventsRegisteredAt.slice(0, 10) < input.startDate,
  );
  const customerEvents =
    input.purpose === "full" &&
    candidate.status.connected &&
    candidate.status.shopId &&
    customerEventsCoverRange
      ? await getShopifyCustomerEventsAggregate({
          businessId: input.businessId,
          providerAccountId: candidate.status.shopId,
          timeZone: customerEventsTimeZone,
          startDate: input.startDate,
          endDate: input.endDate,
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[overview] shopify customer events unavailable", {
            businessId: input.businessId,
            message,
          });
          return null;
        })
      : null;
  const liveDailyByDate = new Map(
    (candidate.live?.dailyTrends ?? []).map((row) => [row.date, row])
  );
  const customerEventsByDate = new Map(
    (customerEvents?.daily ?? []).map((row) => [row.date, row]),
  );
  const mergeCustomerEvents = (
    aggregate: ShopifyOverviewAggregate | null,
  ): ShopifyOverviewAggregate | null => {
    if (!aggregate || !customerEvents || customerEvents.daily.length === 0) return aggregate;
    const commerceByDate = new Map(aggregate.dailyTrends.map((row) => [row.date, row]));
    const dates = new Set([...commerceByDate.keys(), ...customerEventsByDate.keys()]);
    return {
      ...aggregate,
      sessions: customerEvents.sessions,
      conversionRate: customerEvents.conversionRate,
      dailyTrends: Array.from(dates)
        .sort()
        .map((date) => {
          const commerceRow = commerceByDate.get(date);
          const eventRow = customerEventsByDate.get(date);
          return {
            ...(commerceRow ?? {
              date,
              revenue: 0,
              purchases: 0,
              grossRevenue: 0,
              refundedRevenue: 0,
              returnEvents: 0,
              newCustomers: null,
              returningCustomers: null,
            }),
            sessions: eventRow?.sessions ?? commerceRow?.sessions ?? null,
            conversionRate: eventRow?.conversionRate ?? commerceRow?.conversionRate ?? null,
          };
        }),
    };
  };

  if (candidate.preferredSource === "warehouse" && candidate.warehouse) {
    logRuntimeDebug("overview", "shopify_warehouse_read_canary_selected", {
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      revenueDeltaPercent: null,
      purchaseDelta: null,
    });

    return {
      aggregate: mergeCustomerEvents({
        revenue: candidate.warehouse.revenue,
        purchases: candidate.warehouse.purchases,
        averageOrderValue: candidate.warehouse.averageOrderValue,
        grossRevenue: candidate.warehouse.grossRevenue,
        refundedRevenue: candidate.warehouse.refundedRevenue,
        returnEvents: candidate.warehouse.returnEvents,
        sessions: candidate.live?.sessions ?? null,
        conversionRate: candidate.live?.conversionRate ?? null,
        newCustomers: candidate.live?.newCustomers ?? null,
        returningCustomers: candidate.live?.returningCustomers ?? null,
        dailyTrends: candidate.warehouse.daily.map((row) => {
          const liveRow = liveDailyByDate.get(row.date);
          return {
            date: row.date,
            revenue: row.netRevenue,
            grossRevenue: row.orderRevenue,
            refundedRevenue: row.refundedRevenue,
            returnEvents: row.returnEvents,
            purchases: row.orders,
            sessions: liveRow?.sessions ?? null,
            conversionRate: liveRow?.conversionRate ?? null,
            newCustomers: liveRow?.newCustomers ?? null,
            returningCustomers: liveRow?.returningCustomers ?? null,
          };
        }),
      }),
      serving: candidate.servingMetadata,
    };
  }

  if (candidate.preferredSource === "warehouse_shadow" && candidate.warehouse) {
    logRuntimeDebug("overview", "shopify_warehouse_shadow_read_selected", {
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      status: candidate.status.state,
      fallbackReason: candidate.servingMetadata.fallbackReason,
    });

    return {
      aggregate: mergeCustomerEvents({
        revenue: candidate.warehouse.revenue,
        purchases: candidate.warehouse.purchases,
        averageOrderValue: candidate.warehouse.averageOrderValue,
        grossRevenue: candidate.warehouse.grossRevenue,
        refundedRevenue: candidate.warehouse.refundedRevenue,
        returnEvents: candidate.warehouse.returnEvents,
        sessions: candidate.live?.sessions ?? null,
        conversionRate: candidate.live?.conversionRate ?? null,
        newCustomers: candidate.live?.newCustomers ?? null,
        returningCustomers: candidate.live?.returningCustomers ?? null,
        dailyTrends: candidate.warehouse.daily.map((row) => {
          const liveRow = liveDailyByDate.get(row.date);
          return {
            date: row.date,
            revenue: row.netRevenue,
            grossRevenue: row.orderRevenue,
            refundedRevenue: row.refundedRevenue,
            returnEvents: row.returnEvents,
            purchases: row.orders,
            sessions: liveRow?.sessions ?? null,
            conversionRate: liveRow?.conversionRate ?? null,
            newCustomers: liveRow?.newCustomers ?? null,
            returningCustomers: liveRow?.returningCustomers ?? null,
          };
        }),
      }),
      serving: candidate.servingMetadata,
    };
  }

  if (candidate.preferredSource === "ledger" && candidate.ledger) {
    logRuntimeDebug("overview", "shopify_ledger_read_canary_selected", {
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      revenueDeltaPercent: null,
      purchaseDelta: null,
      ledgerRevenueDeltaPercent: null,
    });

    return {
      aggregate: mergeCustomerEvents({
        revenue: candidate.ledger.revenue,
        purchases: candidate.ledger.purchases,
        averageOrderValue: candidate.ledger.averageOrderValue,
        grossRevenue: candidate.ledger.grossRevenue,
        refundedRevenue: candidate.ledger.refundedRevenue,
        returnEvents: candidate.ledger.returnEvents,
        sessions: candidate.live?.sessions ?? null,
        conversionRate: candidate.live?.conversionRate ?? null,
        newCustomers: candidate.live?.newCustomers ?? null,
        returningCustomers: candidate.live?.returningCustomers ?? null,
        dailyTrends: candidate.ledger.daily.map((row) => {
          const liveRow = liveDailyByDate.get(row.date);
          return {
            date: row.date,
            revenue: row.netRevenue,
            grossRevenue: row.orderRevenue,
            refundedRevenue: row.refundedRevenue,
            returnEvents: row.returnEvents,
            purchases: row.orders,
            sessions: liveRow?.sessions ?? null,
            conversionRate: liveRow?.conversionRate ?? null,
            newCustomers: liveRow?.newCustomers ?? null,
            returningCustomers: liveRow?.returningCustomers ?? null,
          };
        }),
      }),
      serving: candidate.servingMetadata,
    };
  }

  if (candidate.canaryEnabled) {
    logRuntimeDebug("overview", "shopify_warehouse_read_canary_blocked", {
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      status: candidate.status.state,
      preferredSource: candidate.preferredSource,
      reasons: candidate.decisionReasons,
      revenueDeltaPercent: null,
      maxDailyRevenueDeltaPercent: null,
      purchaseDelta: null,
      maxDailyPurchaseDelta: null,
    });
  }

  return {
    aggregate: mergeCustomerEvents(candidate.live),
    serving: candidate.servingMetadata,
  };
}

export async function getShopifyOverviewServingData(params: {
  businessId: string;
  startDate: string;
  endDate: string;
  timeZone?: string | null;
}) {
  return resolveShopifyOverviewAggregateForRead({ ...params, purpose: "full" });
}

async function buildDailyTrends(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<DailyTrendsBundle> {
  return measurePerf(
    "overview_daily_trends_build",
    {
      businessId: params.businessId,
      startDate: params.startDate,
      endDate: params.endDate,
      dateSpanDays: enumerateDays(params.startDate, params.endDate).length,
    },
    async () => {
      const [shopifyResult, shopifyConnectionState] = await Promise.all([
        measureComponent(() =>
          resolveShopifyOverviewAggregateForRead({
            ...params,
            purpose: "full",
          }).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.warn("[overview] shopify daily trends unavailable", {
              businessId: params.businessId,
              message,
            });
            return null;
          }),
        ),
        getShopifyConnectionState(params.businessId),
      ]);

      const [metaRowsResult, googleRowsResult] = await Promise.all([
        measureComponent(async () => {
          const trends = await getMetaCanonicalOverviewTrends({
            businessId: params.businessId,
            startDate: params.startDate,
            endDate: params.endDate,
          }).catch(() => null);
          return {
            points: trends?.points ?? [],
            source:
              trends?.readSource === "warehouse_published"
                ? (metaWarehouseSource(trends.warehouseScope) as MetaTrendSource | null)
                : null,
          };
        }),
        measureComponent(async () => {
          const trends = await getGoogleCanonicalOverviewTrends({
            businessId: params.businessId,
            startDate: params.startDate,
            endDate: params.endDate,
          }).catch(() => null);
          return {
            points: trends?.points ?? [],
            source: (trends?.meta?.readSource ?? null) as GoogleTrendSource | null,
          };
        }),
      ]);
      const metaRows = metaRowsResult.result.points;
      const googleRows = googleRowsResult.result.points;

      const dates = enumerateDays(params.startDate, params.endDate);
      const mergeStartedAt = Date.now();
      const metaByDate = accumulateProviderTrendRows(metaRows);
      const googleByDate = accumulateProviderTrendRows(googleRows);

      const hasShopifyAggregate = Boolean(shopifyResult.result?.aggregate);
      const canServeShopifyCommerce =
        shopifyConnectionState === "connected" && hasShopifyAggregate;
      const trustedShopifyDaily = canServeShopifyCommerce
        ? (shopifyResult.result?.aggregate?.dailyTrends ?? [])
        : [];
      const shopifyByDate = new Map(trustedShopifyDaily.map((row) => [row.date, row]));
      // Provider trends carry only dates the provider reported. An absent date
      // is not a measured zero, so it must not become a zero point.
      const metaTrend = reportedProviderTrend(dates, metaByDate);
      const googleTrend = reportedProviderTrend(dates, googleByDate);

      const payload = {
        combined: dates.map((date) => {
          const shopifyDay = shopifyByDate.get(date);
          // Blended spend may still read an absent provider date as no spend.
          const metaDay = metaByDate.get(date);
          const googleDay = googleByDate.get(date);
          const spend = (metaDay ? round2(metaDay.spend) : 0) + (googleDay ? round2(googleDay.spend) : 0);
          return {
            date,
            spend: round2(spend),
            // Provider-attributed revenue remains in providerTrends. It is not
            // a store-commerce fallback and must never be relabeled as
            // Shopify/GA4 revenue in the combined series.
            revenue: round2(canServeShopifyCommerce ? shopifyDay?.revenue ?? 0 : 0),
            purchases: Math.round(canServeShopifyCommerce ? shopifyDay?.purchases ?? 0 : 0),
          };
        }),
        providerTrends: {
          meta: metaTrend,
          google: googleTrend,
        },
        providerTrendSources: {
          meta: metaRowsResult.result.source,
          google: googleRowsResult.result.source,
        },
        shopifyDaily: trustedShopifyDaily,
        shopifyCommerceAvailable: canServeShopifyCommerce,
        shopifyConnectionState,
      };
      logPerfEvent("overview_daily_trends_components", {
        businessId: params.businessId,
        startDate: params.startDate,
        endDate: params.endDate,
        dateSpanDays: dates.length,
        metaReadDurationMs: metaRowsResult.durationMs,
        googleReadDurationMs: googleRowsResult.durationMs,
        shopifyTrendDurationMs: shopifyResult.durationMs,
        mergeDurationMs: Date.now() - mergeStartedAt,
        metaRowCount: metaRows.length,
        googleRowCount: googleRows.length,
        shopifyTrendCount: shopifyByDate.size,
        metaAccountCount: metaRows.length > 0 ? 1 : 0,
        googleAccountCount: googleRows.length > 0 ? 1 : 0,
      });

      return payload;
    },
  );
}

/**
 * Returns only the batched daily trend data. Used by the /api/overview-sparklines
 * endpoint so the main summary response can return KPIs immediately.
 */
export async function getOverviewTrendBundle(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<OverviewTrendBundle> {
  if (isDemoBusinessId(params.businessId)) {
    return getDemoSparklines();
  }
  return buildDailyTrends(params);
}

export async function getOverviewData(params: {
  businessId: string;
  startDate?: string | null;
  endDate?: string | null;
  /**
   * When false the expensive daily-trend batching is skipped. The returned
   * OverviewResponse will have all `trends` arrays empty. Use this flag when
   * sparkline data will be fetched separately via getOverviewTrendBundle().
   * Defaults to true for backwards compatibility.
   */
  includeTrends?: boolean;
}): Promise<OverviewResponse> {
  const { businessId } = params;
  const resolvedStart = params.startDate ?? toISODate(nDaysAgo(29));
  const resolvedEnd = params.endDate ?? toISODate(new Date());
  const orchestrationStartedAt = Date.now();
  const dateSpanDays = enumerateDays(resolvedStart, resolvedEnd).length;
  const perfContext = {
    businessId,
    startDate: resolvedStart,
    endDate: resolvedEnd,
    dateSpanDays,
    includeTrends: params.includeTrends !== false,
  };

  if (await isDemoBusiness(businessId)) {
    return getDemoOverview() as unknown as OverviewResponse;
  }

  const shopifyConnectionState = await getShopifyConnectionState(businessId);

  let totalSpend = 0;
  let totalRevenue = 0;
  let totalPurchases = 0;
  let totalClicks = 0;
  let totalImpressions = 0;
  const platformEfficiency: PlatformEfficiencyRow[] = [];

  const [metaResult, googleResult, shopifyResult] = await Promise.allSettled([
    measureComponent(() =>
      getMetaOverviewFragment({
        businessId,
        startDate: resolvedStart,
        endDate: resolvedEnd,
      }),
    ),
    measureComponent(() =>
      getGoogleOverviewFragment({
        businessId,
        startDate: resolvedStart,
        endDate: resolvedEnd,
      }),
    ),
    measureComponent(() =>
      resolveShopifyOverviewAggregateForRead({
        businessId,
        startDate: resolvedStart,
        endDate: resolvedEnd,
        purpose: params.includeTrends === false ? "summary" : "full",
      }),
    ),
  ]);

  const componentPerf: Record<string, number | null> = {
    metaDurationMs: metaResult.status === "fulfilled" ? metaResult.value.durationMs : null,
    googleDurationMs: googleResult.status === "fulfilled" ? googleResult.value.durationMs : null,
    shopifyDurationMs: shopifyResult.status === "fulfilled" ? shopifyResult.value.durationMs : null,
    ga4FallbackDurationMs: null,
    aggregationDurationMs: null,
  };

  if (metaResult.status === "fulfilled") {
    totalSpend += metaResult.value.result.spend;
    totalRevenue += metaResult.value.result.revenue;
    totalPurchases += metaResult.value.result.purchases;
    // Blended totals divide Meta + Google spend by these delivery counts, so
    // leaving Meta out divided blended spend by Google-only impressions and
    // clicks. Provider cards never read these blended values.
    totalClicks += metaResult.value.result.clicks;
    totalImpressions += metaResult.value.result.impressions;
    platformEfficiency.push(...metaResult.value.result.rows);
  } else {
    const message =
      metaResult.reason instanceof Error
        ? metaResult.reason.message
        : String(metaResult.reason);
    console.warn("[overview] meta overview unavailable", { businessId, message });
  }

  if (googleResult.status === "fulfilled") {
    totalSpend += googleResult.value.result.spend;
    totalRevenue += googleResult.value.result.revenue;
    totalPurchases += googleResult.value.result.purchases;
    totalClicks += googleResult.value.result.clicks;
    totalImpressions += googleResult.value.result.impressions;
    if (googleResult.value.result.row) {
      platformEfficiency.push(googleResult.value.result.row);
    }
  } else {
    const message =
      googleResult.reason instanceof Error
        ? googleResult.reason.message
        : String(googleResult.reason);
    console.warn("[overview] google ads overview unavailable", { businessId, message });
  }

  const shopifyResolution = shopifyResult.status === "fulfilled" ? shopifyResult.value.result : null;
  const shopifyAggregate =
    shopifyConnectionState === "connected" ? (shopifyResolution?.aggregate ?? null) : null;
  if (shopifyResult.status === "rejected") {
    const message =
      shopifyResult.reason instanceof Error
        ? shopifyResult.reason.message
        : String(shopifyResult.reason);
    console.warn("[overview] shopify overview unavailable", { businessId, message });
  }

  const roas = totalSpend > 0 ? totalRevenue / totalSpend : 0;
  const cpa = totalPurchases > 0 ? totalSpend / totalPurchases : 0;
  const aov = totalPurchases > 0 ? totalRevenue / totalPurchases : 0;

  const aggregationStartedAt = Date.now();
  const overview = buildOverviewResponse({
    businessId,
    startDate: resolvedStart,
    endDate: resolvedEnd,
    totalSpend,
    totalRevenue,
    totalPurchases,
    totalClicks,
    totalImpressions,
    roas,
    cpa,
    aov,
    platformEfficiency,
  });
  componentPerf.aggregationDurationMs = Date.now() - aggregationStartedAt;

  const skipTrends = params.includeTrends === false;
  const ga4FallbackAllowed = shopifyConnectionState === "disconnected";

  const [ga4FallbackResult, dailyTrends] = await Promise.all([
    shopifyAggregate
      ? Promise.resolve<TimedResult<Ga4EcommerceFallback | null> | null>(null)
      : ga4FallbackAllowed
        ? measureComponent(() => getGa4EcommerceFallback(businessId, resolvedStart, resolvedEnd))
        : Promise.resolve<TimedResult<Ga4EcommerceFallback | null> | null>(null),
    skipTrends
      ? Promise.resolve(null)
      : buildDailyTrends({ businessId, startDate: resolvedStart, endDate: resolvedEnd }),
  ]);
  componentPerf.ga4FallbackDurationMs = ga4FallbackResult?.durationMs ?? null;
  const ga4Fallback = ga4FallbackResult?.result ?? null;

  applyEcommerceSourcePriority(overview, {
    shopify: shopifyAggregate
      ? {
          ...shopifyAggregate,
          source:
            shopifyResolution?.serving?.source === "ledger"
              ? "shopify_ledger"
              : shopifyResolution?.serving?.source === "warehouse"
                ? "shopify_warehouse"
                : "shopify_live_fallback",
        }
      : null,
    ga4Fallback,
  });
  overview.shopifyConnectionState = shopifyConnectionState;
  overview.shopifyServing = shopifyResolution?.serving ?? null;
  overview.providerSources = {
    meta: metaResult.status === "fulfilled" ? metaResult.value.result.source : null,
    google: googleResult.status === "fulfilled" ? googleResult.value.result.source : null,
  };
  overview.providerScalarRanges = {
    meta: metaResult.status === "fulfilled" ? metaResult.value.result.range : null,
    google: googleResult.status === "fulfilled" ? googleResult.value.result.range : null,
  };

  if (dailyTrends) {
    overview.providerTrends = dailyTrends.providerTrends;
    overview.providerTrendSources = dailyTrends.providerTrendSources;
    const overviewCommerceSource = overview.kpiSources.revenue?.source;
    const canServeCombinedCommerceTrend =
      dailyTrends.shopifyCommerceAvailable &&
      (overviewCommerceSource === "shopify_ledger" ||
        overviewCommerceSource === "shopify_warehouse" ||
        overviewCommerceSource === "shopify_live_fallback");
    const commerceTrend = canServeCombinedCommerceTrend ? dailyTrends.combined : [];
    overview.trends.custom = commerceTrend;
    overview.trends["7d"] = commerceTrend.slice(-7);
    overview.trends["14d"] = commerceTrend.slice(-14);
    overview.trends["30d"] = commerceTrend.slice(-30);
  }

  if (overview.status === "no_data" && (ga4Fallback || shopifyAggregate)) {
    delete overview.status;
  }

  const readSource =
    shopifyResolution?.serving?.source === "ledger"
      ? "shopify_ledger"
      : shopifyResolution?.serving?.source === "warehouse"
        ? "shopify_warehouse"
        : shopifyAggregate
          ? "shopify_live_fallback"
          : ga4Fallback
            ? "ga4_fallback"
            : "ad_platforms";
  const shopifyDailyTrendCount = shopifyAggregate?.dailyTrends?.length ?? 0;
  logPerfEvent(
    skipTrends ? "overview_data_no_trends" : "overview_data_with_trends",
    {
      ...perfContext,
      ...componentPerf,
      accountCount: platformEfficiency.length,
      rowCount: platformEfficiency.length,
      readSource,
      shopifyDailyTrendCount,
      durationMs: Date.now() - orchestrationStartedAt,
    },
  );

  return overview;
}
