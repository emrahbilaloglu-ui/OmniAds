import { getDb } from "@/lib/db";
import { attestMetaConfigObservation } from "@/lib/meta/config-observation-attestation";
import {
  META_RECENT_EDIT_AUTHORITY_KEY,
  metaRecentEditAuthorityRecord,
  type MetaRecentEditAuthorityReason,
  type MetaRecentEditAuthorityRecord,
} from "@/lib/meta/recent-edit-authority";
import {
  providerLocalCalendarDate,
  providerLocalDayEndExclusive,
  providerLocalDayStartInclusive,
  readMetaAccountTimeZones,
} from "@/lib/meta/provider-local-day";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";
import {
  getMetaAdDailyRange,
  getMetaAdSetDailyRange,
  getMetaBreakdownDailyRange,
  getMetaCampaignDailyRange,
} from "@/lib/meta/warehouse";
import type {
  MetaAdDailyRow,
  MetaAdSetDailyRow,
  MetaBreakdownDailyRow,
  MetaCampaignDailyRow,
  MetaWarehouseMetricSet,
} from "@/lib/meta/warehouse-types";
import {
  upsertMetaEntityDecisionSignalsDaily,
  type MetaEntityDecisionSignal,
  type MetaEntitySignalScopeType,
  type MetaLearningState,
} from "@/lib/meta/entity-signals";

const MIN_FREQUENCY_IMPRESSIONS = 1_000;
const CTR_STABLE_SPEND_MIN_RATIO = 0.5;
const CTR_STABLE_SPEND_MAX_RATIO = 2;
const RECENT_EDIT_COOLDOWN_DAYS = 7;
/** The config-history window, in provider-local days. Unchanged from the 60 the
 *  previous `INTERVAL '60 days'` expressed; only its ANCHOR moved from the DB
 *  session's calendar to the advertiser's. */
const CONFIG_HISTORY_LOOKBACK_DAYS = 60;
const TRACKING_CLICK_SAMPLE_MIN = 500;
const TRACKING_LPV_DROP_RATIO_MAX = 0.25;
const TRACKING_LPV_OBSERVED_RATIO_MIN = 0.45;
const MONTHLY_PACING_OVER_RATIO = 1.25;
const MONTHLY_PACING_UNDER_RATIO = 0.75;

type DailyRow = Pick<
  MetaWarehouseMetricSet,
  "spend" | "impressions" | "clicks" | "reach" | "frequency" | "conversions"
> & { date: string };

type ConfigHistoryRow = {
  entity_id: string;
  captured_at: string;
  daily_budget: number | null;
  lifetime_budget: number | null;
  bid_strategy_type: string | null;
  optimization_goal: string | null;
  custom_event_type: string | null;
  promoted_object_json?: unknown;
};

type CreativeAgeRow = {
  scope_id: string;
  creative_age_days_max: number | null;
};

export interface RunMetaSignalsBackfillResult {
  businessId: string;
  asOfDate: string;
  rowsWritten: number;
  campaignSignals: number;
  adsetSignals: number;
  signalCounts: {
    frequencyP80: number;
    ctrDecayPct: number;
    creativeAgeDaysMax: number;
    lastSignificantEditAt: number;
    learningState: number;
    trackingQualityStatus: number;
    monthlyPacingStatus: number;
    placementMix: number;
  };
}

export interface RunMetaSignalsBackfillAllBusinessesResult {
  asOfDate: string;
  businessCount: number;
  results: Array<{
    businessId: string;
    status: "fulfilled" | "rejected";
    value?: RunMetaSignalsBackfillResult;
    reason?: string;
  }>;
}

function normalizeDate(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : text.slice(0, 10);
}

function addDaysToISO(value: string, days: number) {
  const date = new Date(`${normalizeDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthStartISO(value: string) {
  const date = new Date(`${normalizeDate(value)}T00:00:00Z`);
  date.setUTCDate(1);
  return date.toISOString().slice(0, 10);
}

function daysInMonth(value: string) {
  const date = new Date(`${normalizeDate(value)}T00:00:00Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

function monthDay(value: string) {
  return new Date(`${normalizeDate(value)}T00:00:00Z`).getUTCDate();
}

function earlierISODate(left: string, right: string) {
  return normalizeDate(left) < normalizeDate(right) ? normalizeDate(left) : normalizeDate(right);
}

function dayDiff(leftDate: string, rightDate: string) {
  const left = new Date(`${normalizeDate(leftDate)}T00:00:00Z`).getTime();
  const right = new Date(`${normalizeDate(rightDate)}T00:00:00Z`).getTime();
  return Math.floor((left - right) / 86_400_000);
}

function dateFromTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function n(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function r2(value: number) {
  return Math.round(value * 100) / 100;
}

function byEntity<T>(
  rows: T[],
  getId: (row: T) => string | null | undefined,
) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = getId(row);
    if (!id) continue;
    const list = grouped.get(id);
    if (list) list.push(row);
    else grouped.set(id, [row]);
  }
  return grouped;
}

function sumRows(rows: DailyRow[]) {
  const spend = rows.reduce((sum, row) => sum + n(row.spend), 0);
  const impressions = rows.reduce((sum, row) => sum + n(row.impressions), 0);
  const clicks = rows.reduce((sum, row) => sum + n(row.clicks), 0);
  const reach = rows.reduce((sum, row) => sum + n(row.reach), 0);
  const conversions = rows.reduce((sum, row) => sum + n(row.conversions), 0);
  return {
    spend,
    impressions,
    clicks,
    reach,
    conversions,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
  };
}

function rowFrequency(row: DailyRow) {
  if (row.frequency != null && Number.isFinite(Number(row.frequency)) && Number(row.frequency) > 0) {
    return Number(row.frequency);
  }
  const reach = n(row.reach);
  return reach > 0 ? n(row.impressions) / reach : null;
}

type TrackingQualityStatus =
  | "lpv_drop_suspected"
  | "click_to_lpv_observed"
  | "click_to_lpv_borderline"
  | "insufficient_click_sample";

export function computeTrackingQualityStatus(input: {
  linkClicks: number;
  landingPageViews: number;
}) {
  const linkClicks = Math.max(0, n(input.linkClicks));
  const landingPageViews = Math.max(0, n(input.landingPageViews));
  const landingPageViewRate = linkClicks > 0 ? landingPageViews / linkClicks : null;
  let status: TrackingQualityStatus = "insufficient_click_sample";
  if (linkClicks >= TRACKING_CLICK_SAMPLE_MIN && landingPageViewRate != null) {
    if (landingPageViewRate <= TRACKING_LPV_DROP_RATIO_MAX) {
      status = "lpv_drop_suspected";
    } else if (landingPageViewRate >= TRACKING_LPV_OBSERVED_RATIO_MIN) {
      status = "click_to_lpv_observed";
    } else {
      status = "click_to_lpv_borderline";
    }
  }
  return {
    status,
    link_clicks: linkClicks,
    landing_page_views: landingPageViews,
    landing_page_view_rate: landingPageViewRate == null ? null : r2(landingPageViewRate),
    click_sample_floor: TRACKING_CLICK_SAMPLE_MIN,
    lpv_drop_ratio_max: TRACKING_LPV_DROP_RATIO_MAX,
    lpv_observed_ratio_min: TRACKING_LPV_OBSERVED_RATIO_MIN,
  };
}

function trackingQualityFromAdRows(rows: MetaAdDailyRow[], startDate: string, endDate: string) {
  const filtered = rows.filter((row) => row.date >= normalizeDate(startDate) && row.date <= normalizeDate(endDate));
  const linkClicks = filtered.reduce((sum, row) => sum + n(row.linkClicks), 0);
  const landingPageViews = filtered.reduce((sum, row) => sum + n(row.landingPageViews), 0);
  const addToCart = filtered.reduce((sum, row) => sum + n(row.addToCart), 0);
  const initiateCheckout = filtered.reduce((sum, row) => sum + n(row.initiateCheckout), 0);
  const purchases = filtered.reduce((sum, row) => sum + n(row.conversions), 0);
  return {
    ...computeTrackingQualityStatus({ linkClicks, landingPageViews }),
    add_to_cart: addToCart,
    initiate_checkout: initiateCheckout,
    purchases,
    source: "meta_ad_daily_click_to_lpv_28d",
  };
}

export function computeMonthlyPacing(input: {
  rows: DailyRow[];
  asOfDate: string;
  dailyBudget: number | null | undefined;
  lifetimeBudget: number | null | undefined;
}) {
  const asOfDate = normalizeDate(input.asOfDate);
  const monthStart = monthStartISO(asOfDate);
  const monthLength = daysInMonth(asOfDate);
  const elapsedDays = monthDay(asOfDate);
  const dailyBudget = input.dailyBudget == null ? null : n(input.dailyBudget);
  const lifetimeBudget = input.lifetimeBudget == null ? null : n(input.lifetimeBudget);
  const monthlyBudget =
    dailyBudget != null && dailyBudget > 0
      ? dailyBudget * monthLength
      : lifetimeBudget != null && lifetimeBudget > 0
        ? lifetimeBudget
        : null;
  const mtdSpend = input.rows
    .filter((row) => row.date >= monthStart && row.date <= asOfDate)
    .reduce((sum, row) => sum + n(row.spend), 0);
  const expectedMtdSpend = monthlyBudget == null ? null : monthlyBudget * (elapsedDays / monthLength);
  const paceRatio = expectedMtdSpend != null && expectedMtdSpend > 0 ? mtdSpend / expectedMtdSpend : null;
  const status =
    monthlyBudget == null
      ? "no_budget"
      : paceRatio == null
        ? "insufficient_budget_data"
        : paceRatio > MONTHLY_PACING_OVER_RATIO
          ? "overpaced"
          : paceRatio < MONTHLY_PACING_UNDER_RATIO
            ? "underpaced"
            : "on_track";
  return {
    status,
    month_start: monthStart,
    elapsed_days: elapsedDays,
    days_in_month: monthLength,
    monthly_budget: monthlyBudget == null ? null : r2(monthlyBudget),
    mtd_spend: r2(mtdSpend),
    expected_mtd_spend: expectedMtdSpend == null ? null : r2(expectedMtdSpend),
    pace_ratio: paceRatio == null ? null : r2(paceRatio),
    over_ratio: MONTHLY_PACING_OVER_RATIO,
    under_ratio: MONTHLY_PACING_UNDER_RATIO,
  };
}

function buildPlacementMixSummary(rows: MetaBreakdownDailyRow[]) {
  if (rows.length === 0) {
    return {
      status: "missing",
      entity_scoped: false,
      reason: "no_placement_breakdown_rows",
    };
  }
  const grouped = new Map<string, { key: string; label: string; spend: number; impressions: number }>();
  for (const row of rows) {
    const key = row.breakdownKey;
    const current = grouped.get(key) ?? {
      key,
      label: row.breakdownLabel,
      spend: 0,
      impressions: 0,
    };
    current.spend += n(row.spend);
    current.impressions += n(row.impressions);
    grouped.set(key, current);
  }
  const totalSpend = Array.from(grouped.values()).reduce((sum, row) => sum + row.spend, 0);
  const topPlacements = Array.from(grouped.values())
    .sort((left, right) => right.spend - left.spend)
    .slice(0, 5)
    .map((row) => ({
      key: row.key,
      label: row.label,
      spend: r2(row.spend),
      spend_share: totalSpend > 0 ? r2(row.spend / totalSpend) : null,
      impressions: row.impressions,
    }));
  return {
    status: "account_level_only",
    entity_scoped: false,
    reason: "meta_breakdown_daily_has_no_campaign_or_adset_key",
    total_spend: r2(totalSpend),
    top_placements: topPlacements,
  };
}

export function computeFrequencyP80(rows: DailyRow[]) {
  const weighted = rows
    .map((row) => ({
      frequency: rowFrequency(row),
      impressions: n(row.impressions),
    }))
    .filter((row): row is { frequency: number; impressions: number } =>
      row.frequency != null && row.frequency > 0 && row.impressions > 0,
    )
    .sort((left, right) => left.frequency - right.frequency);
  const totalImpressions = weighted.reduce((sum, row) => sum + row.impressions, 0);
  if (totalImpressions < MIN_FREQUENCY_IMPRESSIONS) return null;
  const threshold = totalImpressions * 0.8;
  let cumulative = 0;
  for (const row of weighted) {
    cumulative += row.impressions;
    if (cumulative >= threshold) return r2(row.frequency);
  }
  return weighted.length ? r2(weighted[weighted.length - 1]!.frequency) : null;
}

export function computeCtrDecayPct7dVs14d(input: {
  rows: DailyRow[];
  asOfDate: string;
}) {
  const asOfDate = normalizeDate(input.asOfDate);
  const last7Start = addDaysToISO(asOfDate, -6);
  const prev7Start = addDaysToISO(asOfDate, -13);
  const prev7End = addDaysToISO(asOfDate, -7);
  const last7 = sumRows(input.rows.filter((row) => row.date >= last7Start && row.date <= asOfDate));
  const previous7 = sumRows(input.rows.filter((row) => row.date >= prev7Start && row.date <= prev7End));
  const last14 = sumRows(input.rows.filter((row) => row.date >= prev7Start && row.date <= asOfDate));
  if (!last7.ctr || !last14.ctr || !previous7.ctr) return null;
  if (last7.spend <= 0 || previous7.spend <= 0) return null;
  const spendRatio = last7.spend / Math.max(previous7.spend, 0.01);
  if (spendRatio < CTR_STABLE_SPEND_MIN_RATIO || spendRatio > CTR_STABLE_SPEND_MAX_RATIO) return null;
  return r2(((last7.ctr / last14.ctr) - 1) * 100);
}

export function inferLearningState(input: {
  ageDays: number | null;
  purchases7d: number;
}): MetaLearningState {
  if (input.purchases7d >= 50) return "OPTIMAL_LEARNING_DONE";
  if (input.ageDays != null && input.ageDays < 7) return "LEARNING";
  return "LEARNING_LIMITED";
}

function worstLearningState(states: Array<MetaLearningState | null | undefined>): MetaLearningState | null {
  if (states.includes("LEARNING")) return "LEARNING";
  if (states.includes("LEARNING_LIMITED")) return "LEARNING_LIMITED";
  if (states.includes("OPTIMAL_LEARNING_DONE")) return "OPTIMAL_LEARNING_DONE";
  return null;
}

function budgetAmount(row: Pick<ConfigHistoryRow, "daily_budget" | "lifetime_budget">) {
  return row.daily_budget ?? (row.lifetime_budget != null ? row.lifetime_budget / 30 : null);
}

function jsonStable(value: unknown) {
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isSignificantConfigChange(current: ConfigHistoryRow, previous: ConfigHistoryRow) {
  const currentBudget = budgetAmount(current);
  const previousBudget = budgetAmount(previous);
  const budgetChangePct =
    currentBudget != null && previousBudget != null && previousBudget > 0
      ? Math.abs(currentBudget - previousBudget) / previousBudget
      : 0;
  return (
    budgetChangePct > 0.2 ||
    current.bid_strategy_type !== previous.bid_strategy_type ||
    current.optimization_goal !== previous.optimization_goal ||
    current.custom_event_type !== previous.custom_event_type ||
    jsonStable(current.promoted_object_json) !== jsonStable(previous.promoted_object_json)
  );
}

export function findLastSignificantEditAt(
  rows: ConfigHistoryRow[],
  asOfDate: string,
  /**
   * ROUND 11 ITEM 1. The cutoff filter compared `normalizeDate(captured_at)` —
   * the UTC date — against the as-of day, so an edit late on the advertiser's
   * as-of day was excluded (or an edit early the next local day included).
   * Optional only so existing pure-unit callers keep compiling; production
   * always passes the account zone, and null means the row's own timestamp
   * prefix is used exactly as before.
   */
  timeZone?: string | null,
) {
  const localDate = (value: string) =>
    timeZone
      ? (providerLocalCalendarDate({ instant: value, timeZone }) ??
        normalizeDate(value))
      : normalizeDate(value);
  const sorted = [...rows]
    .filter((row) => localDate(row.captured_at) <= normalizeDate(asOfDate))
    .sort((left, right) => new Date(left.captured_at).getTime() - new Date(right.captured_at).getTime());
  let latest: string | null = null;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (isSignificantConfigChange(current, previous)) {
      latest = current.captured_at;
    }
  }
  return latest;
}

function qualityStatusFor(signal: Pick<
  MetaEntityDecisionSignal,
  | "learningState"
  | "frequencyP80"
  | "ctrDecayPct"
  | "creativeAgeDaysMax"
  | "lastSignificantEditAt"
  | "trackingQualityStatus"
>) {
  const trackingStatusCounts =
    signal.trackingQualityStatus === "lpv_drop_suspected" ||
    signal.trackingQualityStatus === "click_to_lpv_observed" ||
    signal.trackingQualityStatus === "click_to_lpv_borderline";
  const readySignals = [
    signal.learningState,
    signal.frequencyP80,
    signal.ctrDecayPct,
    signal.creativeAgeDaysMax,
    signal.lastSignificantEditAt,
    trackingStatusCounts ? signal.trackingQualityStatus : null,
  ].filter((value) => value != null).length;
  if (readySignals >= 3) return "ready";
  if (readySignals > 0) return "partial";
  return "missing";
}

async function readCreativeAgeDaysMax(input: {
  businessId: string;
  scopeType: MetaEntitySignalScopeType;
  asOfDate: string;
}) {
  const sql = getDb();
  const entityColumn = input.scopeType === "campaign" ? "campaign_id" : "adset_id";
  try {
    const rows = (await sql.query(
      `
        SELECT
          ${entityColumn} AS scope_id,
          MAX(FLOOR(EXTRACT(EPOCH FROM (($2::date + INTERVAL '1 day') - first_seen_at)) / 86400))::integer
            AS creative_age_days_max
        FROM meta_ad_dimensions
        WHERE business_id = $1
          AND ${entityColumn} IS NOT NULL
          AND first_seen_at IS NOT NULL
          AND COALESCE(UPPER(ad_status), 'ACTIVE') IN ('ACTIVE', 'WITH_ISSUES')
        GROUP BY ${entityColumn}
      `,
      [input.businessId, normalizeDate(input.asOfDate)],
    )) as CreativeAgeRow[];
    return new Map(rows.map((row) => [row.scope_id, row.creative_age_days_max]));
  } catch (error) {
    console.warn("[meta-signals] creative_age_unavailable", {
      businessId: input.businessId,
      scopeType: input.scopeType,
      message: error instanceof Error ? error.message : String(error),
    });
    return new Map<string, number | null>();
  }
}

async function readDimensionFirstSeen(input: {
  businessId: string;
  scopeType: MetaEntitySignalScopeType;
}) {
  const sql = getDb();
  const tableName = input.scopeType === "campaign" ? "meta_campaign_dimensions" : "meta_adset_dimensions";
  const entityColumn = input.scopeType === "campaign" ? "campaign_id" : "adset_id";
  try {
    const rows = (await sql.query(
      `
        SELECT ${entityColumn} AS scope_id, first_seen_at
        FROM ${tableName}
        WHERE business_id = $1
          AND first_seen_at IS NOT NULL
      `,
      [input.businessId],
    )) as Array<{ scope_id: string; first_seen_at: string | null }>;
    return new Map(rows.map((row) => [row.scope_id, row.first_seen_at]));
  } catch {
    return new Map<string, string | null>();
  }
}

async function readConfigHistory(input: {
  businessId: string;
  scopeType: MetaEntitySignalScopeType;
  /**
   * The physical provider account each entity belongs to, and the trusted IANA
   * zone of that account.
   *
   * ── ROUND 11 ITEM 1 ──────────────────────────────────────────────────────
   * This read filtered on `business_id` ALONE while
   * `meta_campaign_config_history` and `meta_adset_config_history` both carry
   * `provider_account_id` — so a business with several Meta accounts pooled
   * every account's edit history, and one account's configuration change could
   * lift the recent-edit veto on another account's ad set.
   *
   * An entity whose account or zone cannot be established is simply not
   * requested.
   *
   * ── ROUND 12 ─────────────────────────────────────────────────────────────
   * Round 11's comment here claimed that withholding the rows FAILS CLOSED,
   * because a null `lastSignificantEditAt` keeps `qualityStatusFor` off
   * "ready". That was wrong: `qualityStatusFor` calls a pack ready at any THREE
   * non-null signals out of six, so a learning state, a frequency and a CTR
   * decay were enough — and `blocksPurchaseHardAction` reads
   * `daysSinceSignificantEdit != null && < 7`, which a null passes. Withholding
   * the rows was silently INDISTINGUISHABLE from observing no edits.
   *
   * The caller now records that distinction explicitly.
   * @see lib/meta/recent-edit-authority.ts
   */
  entityScopes: ReadonlyArray<{
    entityId: string;
    providerAccountId: string;
    timeZone: string;
    /**
     * ── ROUND 15, DEFECT 1 ────────────────────────────────────────────────
     * The ONE knowledge bound, computed once per account by the caller before
     * any read happens. This used to be derived here as the full provider-local
     * DAY END, while the receipt authority used `min(now, dayEnd)` — so on the
     * current day a transition captured after `now` (a replay, or clock skew)
     * entered the 60-day change window and moved
     * `daysSinceSignificantEdit`, while the receipt evidence that was supposed
     * to justify it excluded the very same instant. Two bounds, one decision.
     */
    knowledgeEndExclusive: Date;
  }>;
  asOfDate: string;
}) {
  /*
    ABSOLUTE INSTANTS, PER ACCOUNT. The bounds were `($3::date - INTERVAL '60
    days')` and `($3::date + INTERVAL '1 day')`, and PostgreSQL resolves a
    `date` against a `timestamptz` column using the SESSION's `TimeZone`. The
    60-day window therefore started and ended wherever the connection happened
    to be configured, not where the advertiser's day begins. Each entity now
    carries its own start/end `timestamptz`, computed from its own account zone.
  */
  const scopes = input.entityScopes
    .map((scope) => {
      // ROUND 15: the caller's bound, not a second derivation of it.
      const endExclusive = scope.knowledgeEndExclusive;
      const startInclusive = providerLocalDayStartInclusive({
        day: addDaysToISO(normalizeDate(input.asOfDate), -CONFIG_HISTORY_LOOKBACK_DAYS),
        timeZone: scope.timeZone,
      });
      if (!endExclusive || !startInclusive) return null;
      return {
        entityId: scope.entityId,
        providerAccountId: scope.providerAccountId,
        startInclusive: startInclusive.toISOString(),
        endExclusive: endExclusive.toISOString(),
      };
    })
    .filter((scope): scope is NonNullable<typeof scope> => scope !== null);
  const entityIds = scopes.map((scope) => scope.entityId);
  /*
    Nothing requested is not a failure. Every entity that was DROPPED before
    this point already carries its own `unavailable` reason from the caller, so
    reporting a read failure here as well would mislabel the cause.
  */
  if (entityIds.length === 0) {
    return { byEntity: new Map<string, ConfigHistoryRow[]>(), readOk: true };
  }
  const sql = getDb();
  const tableName =
    input.scopeType === "campaign" ? "meta_campaign_config_history" : "meta_adset_config_history";
  const entityColumn = input.scopeType === "campaign" ? "campaign_id" : "adset_id";
  const promotedObjectSelect =
    input.scopeType === "adset" ? "promoted_object_json" : "NULL::jsonb AS promoted_object_json";
  try {
    const rows = (await sql.query(
      `
        WITH requested_entities AS (
          SELECT * FROM unnest(
            $2::text[], $4::text[], $5::timestamptz[], $6::timestamptz[]
          ) AS t(entity_id, provider_account_id, start_inclusive, end_exclusive)
        )
        SELECT
          requested_entities.entity_id,
          history.captured_at,
          history.daily_budget,
          history.lifetime_budget,
          history.bid_strategy_type,
          history.optimization_goal,
          history.custom_event_type,
          history.promoted_object_json
        FROM requested_entities
        JOIN LATERAL (
          -- IN-WINDOW TRANSITIONS.
          (
            SELECT
              captured_at,
              daily_budget,
              lifetime_budget,
              bid_strategy_type,
              optimization_goal,
              custom_event_type,
              ${promotedObjectSelect}
            FROM ${tableName}
            WHERE business_id = $1
              -- The physical account this entity belongs to. Without it a
              -- multi-account business pooled every account edit history.
              AND provider_account_id = requested_entities.provider_account_id
              AND ${entityColumn} = requested_entities.entity_id
              -- Absolute instants, bounded by the ADVERTISER calendar. Never
              -- ::date arithmetic, which resolves in the DB session timezone.
              AND captured_at >= requested_entities.start_inclusive
              AND captured_at < requested_entities.end_exclusive
            ORDER BY captured_at DESC, created_at DESC
            LIMIT 25
          )
          UNION ALL
          -- ROUND 13, DEFECT 2: THE PREDECESSOR.
          --
          -- This table is TRANSITION-ONLY, and findLastSignificantEditAt
          -- compares ADJACENT returned rows. A config set 90 days ago and
          -- changed 2 days ago therefore returned exactly ONE row inside the
          -- 60-day window, had no predecessor to be compared against, and the
          -- real edit was reported as no edit at all -- the veto silently
          -- lifted on the most recently edited entities.
          --
          -- One row, the latest strictly BEFORE the window, per exact account
          -- and entity. It is COMPARISON CONTEXT ONLY: it sorts first, so it is
          -- only ever the previous side of a comparison and can never itself be
          -- reported as a recent edit.
          (
            SELECT
              captured_at,
              daily_budget,
              lifetime_budget,
              bid_strategy_type,
              optimization_goal,
              custom_event_type,
              ${promotedObjectSelect}
            FROM ${tableName}
            WHERE business_id = $1
              AND provider_account_id = requested_entities.provider_account_id
              AND ${entityColumn} = requested_entities.entity_id
              AND captured_at < requested_entities.start_inclusive
            ORDER BY captured_at DESC, created_at DESC
            LIMIT 1
          )
        ) history ON true
        ORDER BY requested_entities.entity_id ASC, history.captured_at ASC
      `,
      [
        input.businessId,
        entityIds,
        normalizeDate(input.asOfDate),
        scopes.map((scope) => scope.providerAccountId),
        scopes.map((scope) => scope.startInclusive),
        scopes.map((scope) => scope.endExclusive),
      ],
    )) as ConfigHistoryRow[];
    return { byEntity: byEntity(rows, (row) => row.entity_id), readOk: true };
  } catch (error) {
    console.warn("[meta-signals] config_history_unavailable", {
      businessId: input.businessId,
      scopeType: input.scopeType,
      message: error instanceof Error ? error.message : String(error),
    });
    /*
      A THROWN READ IS NOT AN EMPTY ONE. Returning an empty map alone made a
      failed query look exactly like a clean account with no configuration
      changes, and the second reading authorises spend.
    */
    return { byEntity: new Map<string, ConfigHistoryRow[]>(), readOk: false };
  }
}

/**
 * ── ROUND 13, DEFECT 1: A SELECT IS NOT AN OBSERVATION ──────────────────────
 *
 * `meta_campaign_config_history` and `meta_adset_config_history` are
 * TRANSITION-ONLY. A row is appended only when a COMPLETE capture observes a
 * CHANGE. Two other things therefore also produce zero rows:
 *
 *   - an incomplete capture (partial, point_lookup, failed) writes nothing;
 *   - a complete capture that saw no change writes nothing.
 *
 * Round 12 recorded `readOk: true` — the query did not throw — as `observed`,
 * which collapses all three into "no recent edit" and authorises spend on an
 * account that may never have been successfully read.
 *
 * What separates them is the durable CURRENT-CONFIG observation evidence the
 * repository already keeps: `meta_entity_observation_receipts`, written per
 * capture occurrence by `persistMetaEntityObservation`, plus the entity truth
 * (`meta_entity_state_history` / `meta_entity_tombstones`) that says whether
 * this exact entity was in that capture. Both are read through their existing
 * canonical readers rather than re-implemented here.
 *
 * Every bound is the SAME one the history window uses: same business, same
 * physical provider account, same trusted zone, and the same provider-local
 * cutoff instant. Evidence bound to a different account or a different day
 * would attest something other than the window it is being used to justify.
 */
type ObservationEvidence =
  | { ok: true }
  | { ok: false; reason: MetaRecentEditAuthorityReason; detail?: string | null };

/**
 * ── ROUND 14, CONTRACT 3: ONE KNOWLEDGE CLOCK, DERIVED PER ACCOUNT ─────────
 *
 * `dayEndExclusive` is the end of the provider-local as-of day. It is the right
 * bound for a HISTORICAL day, where it is point-in-time evidence about a day
 * that has finished. It is the wrong bound for the CURRENT day, where it sits
 * in the future and would admit evidence that has not happened yet — and it is
 * also what made freshness arithmetic wrong, because measuring an age back from
 * a future instant inflates it.
 *
 * The knowledge bound is therefore `min(evaluationNow, dayEndExclusive)`, and a
 * provider-local day whose START is still in the future has no knowledge bound
 * at all: nothing can be known about it yet.
 *
 * `evaluationNow` is captured ONCE per backfill run and injected, so every
 * account, entity and clock comparison in one run is taken against the same
 * instant. Reading the wall clock per call would let two entities of the same
 * account disagree about what "now" was.
 */
function resolveKnowledgeEndExclusive(input: {
  day: string;
  timeZone: string;
  evaluationNow: Date;
}): { knowledgeEndExclusive: Date } | { refusal: MetaRecentEditAuthorityReason } {
  const dayEndExclusive = providerLocalDayEndExclusive({
    day: input.day,
    timeZone: input.timeZone,
  });
  const dayStartInclusive = providerLocalDayStartInclusive({
    day: input.day,
    timeZone: input.timeZone,
  });
  if (!dayEndExclusive || !dayStartInclusive) {
    return { refusal: "provider_timezone_untrusted" };
  }
  // A day that has not begun in the advertiser's own calendar cannot be
  // observed, and a "fresh" receipt for it would be evidence from the future.
  if (dayStartInclusive.getTime() > input.evaluationNow.getTime()) {
    return { refusal: "provider_local_day_in_future" };
  }
  return {
    knowledgeEndExclusive: new Date(
      Math.min(input.evaluationNow.getTime(), dayEndExclusive.getTime()),
    ),
  };
}

/**
 * ── ROUND 14, DEFECT 1: A SELECT IS NOT AN OBSERVATION, AND NEITHER IS A
 *    COMPLETE RECEIPT ON ITS OWN ─────────────────────────────────────────────
 *
 * `meta_campaign_config_history` and `meta_adset_config_history` are
 * TRANSITION-ONLY: an incomplete capture appends nothing and an unchanged
 * complete capture appends nothing, so zero rows is written identically by
 * "nothing changed", "we never looked" and "we looked and failed".
 *
 * Round 13 closed the first gap with the capture receipt. It did not close the
 * second: a COMPLETE receipt is committed BEFORE
 * `append_current_config_history` runs, so an attempt can write a perfect
 * receipt and then fail the apply. The receipt alone therefore attests that the
 * provider was read — not that the config history it is being used to interpret
 * was ever written.
 *
 * Three things are now required, and each closes a distinct hole:
 *
 *   1. THE EXACT ATTEMPT. `receipt.sync_run_id` is the real `meta_sync_runs.id`
 *      — not the partition (reused across retries) and not the observation run
 *      (coalesced content shared by many captures). The receipt is SELECTED
 *      status-blind and the attempt is judged afterwards, so a newer failure is
 *      never stepped over to reach an older success.
 *   2. MANIFEST MEMBERSHIP. Not "is anything known about this entity" but "was
 *      this entity in the manifest of the capture whose completeness is doing
 *      the authorising".
 *   3. THE KNOWLEDGE CLOCK. Freshness measured from the Meta-response clock to
 *      the knowledge bound, so a newly persisted replay of an old provider
 *      observation stays stale.
 */
type ObservationEvidenceInput = {
  businessId: string;
  providerAccountId: string;
  scopeType: MetaEntitySignalScopeType;
  entityIds: string[];
  /** min(evaluationNow, provider-local day end). Strict upper bound. */
  knowledgeEndExclusive: Date;
};

async function readObservationEvidence(
  input: ObservationEvidenceInput,
): Promise<Map<string, ObservationEvidence>> {
  const evidence = new Map<string, ObservationEvidence>();
  if (input.entityIds.length === 0) return evidence;

  /*
    ── ROUND 16: ONE ATTESTATION, SHARED WITH THE BOOTSTRAP ─────────────────

    Every endpoint-level check that used to live inline here — receipt
    selection, completeness, the exact sync attempt, the clocks, freshness and
    manifest integrity — now lives in `attestMetaConfigObservation`, because the
    bootstrap probe needs to ask exactly the same question. When it asked a
    weaker one it could suppress the repair while the authority still held.

    What remains here is the only part that is genuinely per-entity: which of
    the requested ids are members of the attested manifest.
  */
  const attestation = await attestMetaConfigObservation({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    entityType: input.scopeType,
    knowledgeEndExclusive: input.knowledgeEndExclusive,
    entityIds: input.entityIds,
  });
  if (!attestation.ok) {
    for (const entityId of input.entityIds) {
      evidence.set(entityId, {
        ok: false,
        reason: attestation.reason,
        detail: attestation.detail,
      });
    }
    return evidence;
  }

  for (const entityId of input.entityIds) {
    evidence.set(
      entityId,
      attestation.membership.presentEntityIds.has(entityId)
        ? { ok: true }
        : { ok: false, reason: "entity_absent_from_observation", detail: null },
    );
  }
  return evidence;
}

function rowsWithin(rows: DailyRow[], startDate: string, endDate: string) {
  const start = normalizeDate(startDate);
  const end = normalizeDate(endDate);
  return rows.filter((row) => row.date >= start && row.date <= end);
}

function ageDaysFromFirstSeen(firstSeenAt: string | null | undefined, asOfDate: string, fallbackRows: DailyRow[]) {
  const firstSeenDate = dateFromTimestamp(firstSeenAt ?? null) ?? fallbackRows[0]?.date ?? null;
  if (!firstSeenDate) return null;
  return Math.max(0, dayDiff(asOfDate, firstSeenDate));
}

function significantEditFields(input: {
  rows: ConfigHistoryRow[];
  asOfDate: string;
  /**
   * The account's own calendar. Null when it could not be established.
   *
   * ROUND 12. The caller has already withheld the history rows in that case, so
   * this returns the same "nothing observed" shape — which is exactly the
   * ambiguity that made the missing-timezone path authorise spend. The three
   * fields below can no longer answer "was this knowable"; the authority record
   * the caller attaches is what answers it.
   */
  timeZone: string | null;
}) {
  const lastSignificantEditAt = findLastSignificantEditAt(
    input.rows,
    input.asOfDate,
    input.timeZone,
  );
  /*
    ROUND 11 ITEM 1. `dateFromTimestamp` is `toISOString().slice(0, 10)` — the
    UTC date. An edit at 23:30 local in America/Los_Angeles is 06:30Z the next
    day, so it was attributed to the wrong calendar day and the day count that
    the >= 7 veto reads came out one off. The edit date and the as-of day are
    now both read in the ADVERTISER's calendar.
  */
  const editDate =
    lastSignificantEditAt == null || input.timeZone == null
      ? null
      : providerLocalCalendarDate({
          instant: lastSignificantEditAt,
          timeZone: input.timeZone,
        });
  const daysSinceSignificantEdit = editDate == null ? null : Math.max(0, dayDiff(input.asOfDate, editDate));
  const recentChangeCooldownUntil =
    editDate == null
      ? null
      : addDaysToISO(editDate, RECENT_EDIT_COOLDOWN_DAYS);
  return { lastSignificantEditAt, daysSinceSignificantEdit, recentChangeCooldownUntil };
}

function buildSignal(input: {
  businessId: string;
  providerAccountId: string | null;
  scopeType: MetaEntitySignalScopeType;
  scopeId: string;
  asOfDate: string;
  rows: DailyRow[];
  learningState: MetaLearningState | null;
  creativeAgeDaysMax: number | null;
  configHistoryRows: ConfigHistoryRow[];
  trackingQuality: ReturnType<typeof trackingQualityFromAdRows>;
  monthlyPacing: ReturnType<typeof computeMonthlyPacing>;
  placementMix: ReturnType<typeof buildPlacementMixSummary>;
  /** The account's trusted IANA zone, or null when it could not be established. */
  timeZone: string | null;
  /**
   * Whether this entity's edit age was KNOWABLE at all. Written into
   * `sourceJson` so every consumer of the signal reads the same answer.
   * @see lib/meta/recent-edit-authority.ts
   */
  recentEditAuthority: MetaRecentEditAuthorityRecord;
  sourceJson: Record<string, unknown>;
}): MetaEntityDecisionSignal {
  const edit = significantEditFields({
    rows: input.configHistoryRows,
    asOfDate: input.asOfDate,
    timeZone: input.timeZone,
  });
  const signal = {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    asOfDate: normalizeDate(input.asOfDate),
    learningState: input.learningState,
    daysAtLearningState: null,
    lastSignificantEditAt: edit.lastSignificantEditAt,
    daysSinceSignificantEdit: edit.daysSinceSignificantEdit,
    recentChangeCooldownUntil: edit.recentChangeCooldownUntil,
    creativeAgeDays: input.creativeAgeDaysMax,
    creativeAgeDaysMax: input.creativeAgeDaysMax,
    frequencyP80: computeFrequencyP80(input.rows),
    ctrDecayPct: computeCtrDecayPct7dVs14d({
      rows: input.rows,
      asOfDate: input.asOfDate,
    }),
    audienceOverlapPct: null,
    audienceSize: null,
    lookalikePct: null,
    audienceStage: null,
    feedDisapprovalCount: null,
    feedStatus: null,
    dedupRatePct: null,
    metaToCrmRatio: null,
    trackingQualityStatus: input.trackingQuality.status,
    sourceJson: {
      ...input.sourceJson,
      /*
        ROUND 12. Beside `tracking_quality`, `monthly_pacing` and
        `placement_mix`, and read the same way. This is the field that
        distinguishes "the window was read and held no significant edit" from
        "the window could not be read at all" — a distinction the three
        edit columns above cannot carry, because both cases write null.
      */
      [META_RECENT_EDIT_AUTHORITY_KEY]: input.recentEditAuthority,
      tracking_quality: input.trackingQuality,
      monthly_pacing: input.monthlyPacing,
      placement_mix: input.placementMix,
      audience_overlap_status: "unsupported_no_entity_overlap_source",
      feed_status_source: "unsupported_no_feed_or_catalog_source",
      learning_state_quality: "inferred",
      significant_edit_rules: [
        "budget_change_gt_20_pct",
        "bid_strategy_change",
        "optimization_event_change",
        "custom_event_change",
        "promoted_object_change",
      ],
      frequency_impression_floor: MIN_FREQUENCY_IMPRESSIONS,
    },
    qualityStatus: "missing" as const,
  };
  return {
    ...signal,
    qualityStatus: qualityStatusFor(signal),
  };
}

function signalCounts(signals: MetaEntityDecisionSignal[]) {
  return {
    frequencyP80: signals.filter((signal) => signal.frequencyP80 != null).length,
    ctrDecayPct: signals.filter((signal) => signal.ctrDecayPct != null).length,
    creativeAgeDaysMax: signals.filter((signal) => signal.creativeAgeDaysMax != null).length,
    lastSignificantEditAt: signals.filter((signal) => signal.lastSignificantEditAt != null).length,
    learningState: signals.filter((signal) => signal.learningState != null).length,
    trackingQualityStatus: signals.filter((signal) => signal.trackingQualityStatus != null).length,
    monthlyPacingStatus: signals.filter((signal) => {
      const pacing = signal.sourceJson.monthly_pacing;
      return Boolean(pacing && typeof pacing === "object" && "status" in pacing);
    }).length,
    placementMix: signals.filter((signal) => {
      const placement = signal.sourceJson.placement_mix;
      return Boolean(placement && typeof placement === "object" && "status" in placement);
    }).length,
  };
}

export async function runMetaSignalsBackfillForBusiness(
  businessId: string,
  asOfDate: string,
  /**
   * ROUND 14, CONTRACT 3. The evaluation instant, captured once by the caller
   * (or once here) and used for every clock comparison in this run. A test
   * seam as well as a correctness one: a run must not drift across its own
   * accounts because each read the wall clock separately.
   */
  input?: { now?: Date },
): Promise<RunMetaSignalsBackfillResult> {
  const normalizedAsOfDate = normalizeDate(asOfDate);
  /*
    ── ROUND 15, DEFECT 1: ONE INSTANT, CAPTURED BEFORE ANY READ ─────────────
    Captured here rather than beside the receipt reads, because the config
    history window is opened first and must be bounded by the SAME instant.
  */
  const evaluationNow = input?.now ?? new Date();
  const metricStartDate = addDaysToISO(normalizedAsOfDate, -27);
  const startDate = earlierISODate(metricStartDate, monthStartISO(normalizedAsOfDate));
  const last7Start = addDaysToISO(normalizedAsOfDate, -6);
  const [campaignRows, adsetRows, adRows, placementRows] = await Promise.all([
    getMetaCampaignDailyRange({
      businessId,
      startDate,
      endDate: normalizedAsOfDate,
      includeProvisional: true,
    }),
    getMetaAdSetDailyRange({
      businessId,
      startDate,
      endDate: normalizedAsOfDate,
      includeProvisional: true,
    }),
    getMetaAdDailyRange({
      businessId,
      startDate,
      endDate: normalizedAsOfDate,
    }),
    getMetaBreakdownDailyRange({
      businessId,
      startDate,
      endDate: normalizedAsOfDate,
      breakdownTypes: ["placement"],
      includeProvisional: true,
    }).catch((error) => {
      console.warn("[meta-signals] placement_breakdown_unavailable", {
        businessId,
        message: error instanceof Error ? error.message : String(error),
      });
      return [] as MetaBreakdownDailyRow[];
    }),
  ]);

  const campaignGroups = byEntity(campaignRows, (row) => row.campaignId);
  const adsetGroups = byEntity(adsetRows, (row) => row.adsetId);
  const adRowsByCampaign = byEntity(adRows, (row) => row.campaignId);
  const adRowsByAdset = byEntity(adRows, (row) => row.adsetId);
  const placementMix = buildPlacementMixSummary(placementRows);
  const campaignIds = Array.from(campaignGroups.keys());
  const adsetIds = Array.from(adsetGroups.keys());
  const [
    campaignCreativeAge,
    adsetCreativeAge,
    campaignFirstSeen,
    adsetFirstSeen,
  ] = await Promise.all([
    readCreativeAgeDaysMax({ businessId, scopeType: "campaign", asOfDate: normalizedAsOfDate }),
    readCreativeAgeDaysMax({ businessId, scopeType: "adset", asOfDate: normalizedAsOfDate }),
    readDimensionFirstSeen({ businessId, scopeType: "campaign" }),
    readDimensionFirstSeen({ businessId, scopeType: "adset" }),
  ]);

  /*
    ── ROUND 11 ITEM 1: THE ADVERTISER'S CALENDAR, PER ACCOUNT ────────────────

    A business can carry several Meta accounts in different zones, so one map is
    resolved for all of them and each entity is bounded by its OWN account's
    calendar. An account with no binding, a null zone or a zone this runtime
    cannot resolve is ABSENT from the map and its entities are not requested.

    ── ROUND 12: WHAT THAT ABSENCE ACTUALLY DID ──────────────────────────────

    Round 11 claimed here that a withheld account fails closed, "because they
    carry no `lastSignificantEditAt`, `qualityStatusFor` does not call them
    ready, and `blocksPurchaseHardAction` refuses on
    `qualityStatus !== "ready"`". Every step of that was wrong:

      - `qualityStatusFor` calls a pack READY at any three non-null signals out
        of six, and `lastSignificantEditAt` is only one of the six. A learning
        state, a frequency p80 and a CTR decay reach "ready" on their own.
      - `blocksPurchaseHardAction` then tests
        `daysSinceSignificantEdit != null && < 7`, and a null is not `< 7`.
      - `recentEditCooldownActive` in the campaign emitters reads the same field
        with the same null-passes semantics.

    So the withheld account produced a signal that looked fully ready and
    authorised Scale / Cut / Refresh against an edit age nobody had measured —
    the exact opposite of failing closed.

    The fix is to stop inferring the answer from an absent value and to record
    it. Each entity gets an explicit authority.

    ── ROUND 13: AND THE READ SUCCEEDING IS NOT ENOUGH EITHER ────────────────

    Round 12's authority read READY as "trusted zone AND the config-history
    query did not throw". Those tables are TRANSITION-ONLY, so a query that
    returns nothing is equally consistent with "nothing changed", "we never
    looked" and "we looked and failed" — and only the first is an observation.

    READY now additionally requires a fresh COMPLETE current-config capture
    receipt for this exact account, entity type and endpoint at or before the
    same provider-local cutoff, with this entity present in it. Zero significant
    edits under all of that stays READY, because that is an observation rather
    than a failure.
  */
  const accountByEntity = new Map<string, string>();
  for (const [entityId, rows] of campaignGroups) {
    const account = rows[rows.length - 1]?.providerAccountId;
    if (account) accountByEntity.set(`campaign:${entityId}`, account);
  }
  for (const [entityId, rows] of adsetGroups) {
    const account = rows[rows.length - 1]?.providerAccountId;
    if (account) accountByEntity.set(`adset:${entityId}`, account);
  }
  const timeZoneByAccount = await readMetaAccountTimeZones({
    businessId,
    providerAccountIds: Array.from(new Set(accountByEntity.values())),
    query: (text, params) => getDb().query(text, params),
  }).catch(() => new Map<string, string>());

  /*
    ── ROUND 15, DEFECT 1: THE BOUND, DERIVED ONCE PER ACCOUNT ───────────────

    Computed here, before the config-history read, and reused verbatim by the
    receipt/membership authority below. Previously the history window derived
    its own end from `providerLocalDayEndExclusive` — the full provider day —
    while the authority used `min(now, dayEnd)`. On the CURRENT day those are
    different instants, so a transition captured after `now` could move
    `daysSinceSignificantEdit` while being invisible to the evidence that was
    supposed to justify reading it.

    A completed historical day keeps its original day end, which is point-in-
    time evidence about a day that has finished. A day that has not begun in
    the advertiser's own calendar has no bound at all.
  */
  const knowledgeByAccount = new Map<
    string,
    { knowledgeEndExclusive: Date } | { refusal: MetaRecentEditAuthorityReason }
  >();
  for (const providerAccountId of new Set(accountByEntity.values())) {
    const timeZone = timeZoneByAccount.get(providerAccountId);
    knowledgeByAccount.set(
      providerAccountId,
      timeZone
        ? resolveKnowledgeEndExclusive({
            day: normalizedAsOfDate,
            timeZone,
            evaluationNow,
          })
        : { refusal: "provider_timezone_untrusted" },
    );
  }

  const scopesFor = (
    scopeType: MetaEntitySignalScopeType,
    entityIds: string[],
  ) =>
    entityIds
      .map((entityId) => {
        const providerAccountId = accountByEntity.get(`${scopeType}:${entityId}`);
        const timeZone = providerAccountId
          ? timeZoneByAccount.get(providerAccountId)
          : undefined;
        const knowledge = providerAccountId
          ? knowledgeByAccount.get(providerAccountId)
          : undefined;
        // An account with no usable bound is not requested at all: its entities
        // are already denied, and reading a window nobody can bound would be
        // the second reading this defect exists to remove.
        return providerAccountId && timeZone && knowledge && !("refusal" in knowledge)
          ? {
              entityId,
              providerAccountId,
              timeZone,
              knowledgeEndExclusive: knowledge.knowledgeEndExclusive,
            }
          : null;
      })
      .filter((scope): scope is NonNullable<typeof scope> => scope !== null);

  const [campaignHistory, adsetHistory] = await Promise.all([
    readConfigHistory({
      businessId,
      scopeType: "campaign",
      entityScopes: scopesFor("campaign", campaignIds),
      asOfDate: normalizedAsOfDate,
    }),
    readConfigHistory({
      businessId,
      scopeType: "adset",
      entityScopes: scopesFor("adset", adsetIds),
      asOfDate: normalizedAsOfDate,
    }),
  ]);

  /*
    ── ROUND 12: THE AUTHORITY, PER ENTITY ───────────────────────────────────

    Resolved from the same three facts the window itself was built from, in the
    order the failures actually occur. `observed` is the ONLY ready reason, and
    it deliberately says nothing about whether an edit was found: an account
    with a trusted zone and a clean 60-day history is `observed` with a null
    `lastSignificantEditAt`, and must keep authorising actions.
  */
  /*
    ── ROUND 13, DEFECT 1: THE OBSERVATION EVIDENCE, PER ACCOUNT ─────────────

    Grouped by (scope type, physical account) because that is the grain a
    capture receipt is written at, and resolved at the SAME provider-local
    cutoff instant the history window closes on — so the evidence and the
    window cannot describe different days or different accounts.
  */
  const observationEvidence = new Map<string, ObservationEvidence>();
  const evidenceGroups = new Map<
    string,
    { scopeType: MetaEntitySignalScopeType; providerAccountId: string; entityIds: string[] }
  >();
  for (const scopeType of ["campaign", "adset"] as const) {
    for (const entityId of scopeType === "campaign" ? campaignIds : adsetIds) {
      const providerAccountId = accountByEntity.get(`${scopeType}:${entityId}`);
      if (!providerAccountId) continue;
      // No trusted zone means no cutoff instant to bind the evidence to, and
      // the entity is already denied on that reason alone.
      if (!timeZoneByAccount.get(providerAccountId)) continue;
      const key = `${scopeType}:${providerAccountId}`;
      const group = evidenceGroups.get(key) ?? {
        scopeType,
        providerAccountId,
        entityIds: [],
      };
      group.entityIds.push(entityId);
      evidenceGroups.set(key, group);
    }
  }
  /*
    ── ROUND 14, CONTRACT 3 ──────────────────────────────────────────────────
    ONE evaluation instant for the whole run, so every account, entity and
    clock comparison below is taken against the same "now". Reading the wall
    clock per call would let two entities of one account disagree about it.
  */
  await Promise.all(
    Array.from(evidenceGroups.values()).map(async (group) => {
      const knowledge = knowledgeByAccount.get(group.providerAccountId)!;
      const resolved =
        "refusal" in knowledge
          ? new Map<string, ObservationEvidence>(
              group.entityIds.map((entityId) => [
                entityId,
                { ok: false as const, reason: knowledge.refusal },
              ]),
            )
          : await readObservationEvidence({
              businessId,
              providerAccountId: group.providerAccountId,
              scopeType: group.scopeType,
              entityIds: group.entityIds,
              knowledgeEndExclusive: knowledge.knowledgeEndExclusive,
            }).catch(
              () =>
                new Map<string, ObservationEvidence>(
                  group.entityIds.map((entityId) => [
                    entityId,
                    {
                      ok: false as const,
                      reason: "config_history_read_failed" as const,
                    },
                  ]),
                ),
            );
      for (const [entityId, value] of resolved) {
        observationEvidence.set(`${group.scopeType}:${entityId}`, value);
      }
    }),
  );

  const recentEditAuthorityFor = (
    scopeType: MetaEntitySignalScopeType,
    entityId: string,
  ): MetaRecentEditAuthorityRecord => {
    const providerAccountId = accountByEntity.get(`${scopeType}:${entityId}`);
    const timeZone = providerAccountId
      ? (timeZoneByAccount.get(providerAccountId) ?? null)
      : null;
    const readOk =
      scopeType === "campaign" ? campaignHistory.readOk : adsetHistory.readOk;
    /*
      Ordered by which failure actually happened first. `observed` is reached
      ONLY when the account resolved, its zone is trusted, the transition read
      succeeded, AND a fresh complete current-config receipt names this exact
      entity. Zero transitions under all four is a known no-edit result.
    */
    const evidence =
      observationEvidence.get(`${scopeType}:${entityId}`) ??
      ({
        ok: false,
        reason: "observation_receipt_missing",
        detail: null,
      } as ObservationEvidence);
    const reason: MetaRecentEditAuthorityReason = !providerAccountId
      ? "provider_account_unresolved"
      : !timeZone
        ? "provider_timezone_untrusted"
        : !readOk
          ? "config_history_read_failed"
          : evidence.ok
            ? "observed"
            : evidence.reason;
    return metaRecentEditAuthorityRecord({
      status: reason === "observed" ? "ready" : "unavailable",
      reason,
      detail: evidence.ok ? null : (evidence.detail ?? null),
      // Only a ready authority carries a zone: an unavailable one has either no
      // zone at all, or a zone whose window was never successfully attested.
      timeZone: reason === "observed" ? timeZone : null,
    });
  };

  const adsetLearningByCampaign = new Map<string, MetaLearningState[]>();
  const adsetSignals = Array.from(adsetGroups.entries()).map(([adsetId, rows]) => {
    const sortedRows = [...rows].sort((left, right) => left.date.localeCompare(right.date));
    const latest = sortedRows[sortedRows.length - 1]!;
    const ageDays = ageDaysFromFirstSeen(adsetFirstSeen.get(adsetId), normalizedAsOfDate, sortedRows);
    const purchases7d = sumRows(rowsWithin(sortedRows, last7Start, normalizedAsOfDate)).conversions;
    const learningState = inferLearningState({ ageDays, purchases7d });
    if (latest.campaignId) {
      const list = adsetLearningByCampaign.get(latest.campaignId) ?? [];
      list.push(learningState);
      adsetLearningByCampaign.set(latest.campaignId, list);
    }
    return buildSignal({
      businessId,
      providerAccountId: latest.providerAccountId,
      // The account's own calendar, or null when it could not be established.
      timeZone: timeZoneByAccount.get(latest.providerAccountId) ?? null,
      scopeType: "adset",
      scopeId: adsetId,
      asOfDate: normalizedAsOfDate,
      rows: sortedRows,
      learningState,
      creativeAgeDaysMax: adsetCreativeAge.get(adsetId) ?? null,
      configHistoryRows: adsetHistory.byEntity.get(adsetId) ?? [],
      recentEditAuthority: recentEditAuthorityFor("adset", adsetId),
      trackingQuality: trackingQualityFromAdRows(adRowsByAdset.get(adsetId) ?? [], metricStartDate, normalizedAsOfDate),
      monthlyPacing: computeMonthlyPacing({
        rows: sortedRows,
        asOfDate: normalizedAsOfDate,
        dailyBudget: latest.dailyBudget,
        lifetimeBudget: latest.lifetimeBudget,
      }),
      placementMix,
      sourceJson: {
        source: "warehouse_signal_backfill",
        age_days: ageDays,
        purchases_7d: purchases7d,
      },
    });
  });

  const campaignSignals = Array.from(campaignGroups.entries()).map(([campaignId, rows]) => {
    const sortedRows = [...rows].sort((left, right) => left.date.localeCompare(right.date));
    const latest = sortedRows[sortedRows.length - 1]!;
    const ageDays = ageDaysFromFirstSeen(campaignFirstSeen.get(campaignId), normalizedAsOfDate, sortedRows);
    const purchases7d = sumRows(rowsWithin(sortedRows, last7Start, normalizedAsOfDate)).conversions;
    const childLearningState = worstLearningState(adsetLearningByCampaign.get(campaignId) ?? []);
    const learningState = childLearningState ?? inferLearningState({ ageDays, purchases7d });
    return buildSignal({
      businessId,
      providerAccountId: latest.providerAccountId,
      timeZone: timeZoneByAccount.get(latest.providerAccountId) ?? null,
      scopeType: "campaign",
      scopeId: campaignId,
      asOfDate: normalizedAsOfDate,
      rows: sortedRows,
      learningState,
      creativeAgeDaysMax: campaignCreativeAge.get(campaignId) ?? null,
      configHistoryRows: campaignHistory.byEntity.get(campaignId) ?? [],
      recentEditAuthority: recentEditAuthorityFor("campaign", campaignId),
      trackingQuality: trackingQualityFromAdRows(adRowsByCampaign.get(campaignId) ?? [], metricStartDate, normalizedAsOfDate),
      monthlyPacing: computeMonthlyPacing({
        rows: sortedRows,
        asOfDate: normalizedAsOfDate,
        dailyBudget: latest.dailyBudget,
        lifetimeBudget: latest.lifetimeBudget,
      }),
      placementMix,
      sourceJson: {
        source: "warehouse_signal_backfill",
        age_days: ageDays,
        purchases_7d: purchases7d,
        learning_state_aggregation: childLearningState ? "worst_child_adset" : "campaign_proxy",
      },
    });
  });

  const signals = [...campaignSignals, ...adsetSignals];
  const write = await upsertMetaEntityDecisionSignalsDaily(signals);
  return {
    businessId,
    asOfDate: normalizedAsOfDate,
    rowsWritten: write.rowsWritten,
    campaignSignals: campaignSignals.length,
    adsetSignals: adsetSignals.length,
    signalCounts: signalCounts(signals),
  };
}

export async function runMetaSignalsBackfillForAllBusinesses(
  asOfDate: string,
): Promise<RunMetaSignalsBackfillAllBusinessesResult> {
  const normalizedAsOfDate = normalizeDate(asOfDate);
  const businesses = await getActiveBusinesses();
  const settled = await Promise.allSettled(
    businesses.map((business) =>
      runMetaSignalsBackfillForBusiness(business.id, normalizedAsOfDate),
    ),
  );
  return {
    asOfDate: normalizedAsOfDate,
    businessCount: businesses.length,
    results: settled.map((result, index) => {
      const businessId = businesses[index]?.id ?? "unknown";
      if (result.status === "fulfilled") {
        return {
          businessId,
          status: "fulfilled" as const,
          value: result.value,
        };
      }
      return {
        businessId,
        status: "rejected" as const,
        reason:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      };
    }),
  };
}
