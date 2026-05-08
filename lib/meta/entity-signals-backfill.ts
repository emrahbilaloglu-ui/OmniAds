import { getDb } from "@/lib/db";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";
import {
  getMetaAdSetDailyRange,
  getMetaCampaignDailyRange,
} from "@/lib/meta/warehouse";
import type {
  MetaAdSetDailyRow,
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

export function findLastSignificantEditAt(rows: ConfigHistoryRow[], asOfDate: string) {
  const sorted = [...rows]
    .filter((row) => normalizeDate(row.captured_at) <= normalizeDate(asOfDate))
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
  "learningState" | "frequencyP80" | "ctrDecayPct" | "creativeAgeDaysMax" | "lastSignificantEditAt"
>) {
  const readySignals = [
    signal.learningState,
    signal.frequencyP80,
    signal.ctrDecayPct,
    signal.creativeAgeDaysMax,
    signal.lastSignificantEditAt,
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
  entityIds: string[];
  asOfDate: string;
}) {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)));
  if (entityIds.length === 0) return new Map<string, ConfigHistoryRow[]>();
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
          SELECT unnest($2::text[]) AS entity_id
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
            AND ${entityColumn} = requested_entities.entity_id
            AND captured_at >= ($3::date - INTERVAL '60 days')
            AND captured_at < ($3::date + INTERVAL '1 day')
          ORDER BY captured_at DESC, created_at DESC
          LIMIT 25
        ) history ON true
        ORDER BY requested_entities.entity_id ASC, history.captured_at ASC
      `,
      [input.businessId, entityIds, normalizeDate(input.asOfDate)],
    )) as ConfigHistoryRow[];
    return byEntity(rows, (row) => row.entity_id);
  } catch (error) {
    console.warn("[meta-signals] config_history_unavailable", {
      businessId: input.businessId,
      scopeType: input.scopeType,
      message: error instanceof Error ? error.message : String(error),
    });
    return new Map<string, ConfigHistoryRow[]>();
  }
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
}) {
  const lastSignificantEditAt = findLastSignificantEditAt(input.rows, input.asOfDate);
  const editDate = dateFromTimestamp(lastSignificantEditAt);
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
  sourceJson: Record<string, unknown>;
}): MetaEntityDecisionSignal {
  const edit = significantEditFields({
    rows: input.configHistoryRows,
    asOfDate: input.asOfDate,
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
    sourceJson: {
      ...input.sourceJson,
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
  };
}

export async function runMetaSignalsBackfillForBusiness(
  businessId: string,
  asOfDate: string,
): Promise<RunMetaSignalsBackfillResult> {
  const normalizedAsOfDate = normalizeDate(asOfDate);
  const startDate = addDaysToISO(normalizedAsOfDate, -27);
  const last7Start = addDaysToISO(normalizedAsOfDate, -6);
  const [campaignRows, adsetRows] = await Promise.all([
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
  ]);

  const campaignGroups = byEntity(campaignRows, (row) => row.campaignId);
  const adsetGroups = byEntity(adsetRows, (row) => row.adsetId);
  const campaignIds = Array.from(campaignGroups.keys());
  const adsetIds = Array.from(adsetGroups.keys());
  const [
    campaignCreativeAge,
    adsetCreativeAge,
    campaignFirstSeen,
    adsetFirstSeen,
    campaignHistory,
    adsetHistory,
  ] = await Promise.all([
    readCreativeAgeDaysMax({ businessId, scopeType: "campaign", asOfDate: normalizedAsOfDate }),
    readCreativeAgeDaysMax({ businessId, scopeType: "adset", asOfDate: normalizedAsOfDate }),
    readDimensionFirstSeen({ businessId, scopeType: "campaign" }),
    readDimensionFirstSeen({ businessId, scopeType: "adset" }),
    readConfigHistory({ businessId, scopeType: "campaign", entityIds: campaignIds, asOfDate: normalizedAsOfDate }),
    readConfigHistory({ businessId, scopeType: "adset", entityIds: adsetIds, asOfDate: normalizedAsOfDate }),
  ]);

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
      scopeType: "adset",
      scopeId: adsetId,
      asOfDate: normalizedAsOfDate,
      rows: sortedRows,
      learningState,
      creativeAgeDaysMax: adsetCreativeAge.get(adsetId) ?? null,
      configHistoryRows: adsetHistory.get(adsetId) ?? [],
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
      scopeType: "campaign",
      scopeId: campaignId,
      asOfDate: normalizedAsOfDate,
      rows: sortedRows,
      learningState,
      creativeAgeDaysMax: campaignCreativeAge.get(campaignId) ?? null,
      configHistoryRows: campaignHistory.get(campaignId) ?? [],
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
