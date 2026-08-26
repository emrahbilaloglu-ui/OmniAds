import { getDb } from "@/lib/db";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

export interface MetaEvidenceTrailHistoryPoint {
  date: string;
  roas: number;
  regime?: string | null;
}

export interface MetaEvidenceTrailRecentChange {
  type: string;
  applied_at: string;
  value: unknown;
}

export interface MetaEvidenceTrail {
  roas_history: number[];
  peer_comparison: {
    p10: number;
    p50: number;
    p90: number;
    this_value: number;
  };
  regime_stability: number;
  age_days: number;
  recent_changes: MetaEvidenceTrailRecentChange[];
}

export interface BuildEvidenceTrailInput {
  scope: {
    type: "account" | "campaign" | "adset";
    id: string;
    firstSeenAt?: string | null;
    thisValue?: number | null;
  };
  history: MetaEvidenceTrailHistoryPoint[];
  peers: number[];
  recentChanges: MetaEvidenceTrailRecentChange[];
  asOfDate?: string | null;
}

type DailyHistoryRow = {
  scope_type: "campaign" | "adset";
  scope_id: string;
  parent_campaign_id: string | null;
  date: string;
  roas: unknown;
  bid_strategy_type: string | null;
};

type ActionLogRow = {
  action: string;
  requested_at: string;
  payload_request: unknown;
  payload_response: unknown;
  rec_id_origin: string | null;
};

function normalizeDate(value: string | Date | null | undefined) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function addDaysToISO(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rounded(value: number, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values: number[], p: number) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * weight;
}

function dateDiffDays(start: string, end: string) {
  const startMs = new Date(`${normalizeDate(start)}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${normalizeDate(end)}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.floor((endMs - startMs) / 86_400_000));
}

function resolveAsOfDate(input: BuildEvidenceTrailInput) {
  if (input.asOfDate) return normalizeDate(input.asOfDate);
  const latest = [...input.history].sort((left, right) => right.date.localeCompare(left.date))[0];
  return latest?.date ?? normalizeDate(new Date());
}

function regimeStability(history: MetaEvidenceTrailHistoryPoint[]) {
  const regimes = history
    .map((point) => point.regime?.trim())
    .filter((value): value is string => Boolean(value));
  if (regimes.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const regime of regimes) counts.set(regime, (counts.get(regime) ?? 0) + 1);
  return rounded(Math.max(...counts.values()) / regimes.length);
}

function recentWithinWindow(
  changes: MetaEvidenceTrailRecentChange[],
  asOfDate: string,
) {
  const start = addDaysToISO(asOfDate, -13);
  return changes
    .filter((change) => {
      const applied = normalizeDate(change.applied_at);
      return applied >= start && applied <= asOfDate;
    })
    .sort((left, right) => right.applied_at.localeCompare(left.applied_at))
    .slice(0, 20);
}

export function buildEvidenceTrail(input: BuildEvidenceTrailInput): MetaEvidenceTrail {
  const asOfDate = resolveAsOfDate(input);
  const sortedHistory = [...input.history].sort((left, right) => left.date.localeCompare(right.date));
  const roasHistory = sortedHistory.slice(-28).map((point) => rounded(point.roas));
  const lastHistoryValue = sortedHistory.at(-1)?.roas ?? 0;
  const thisValue = toNumber(input.scope.thisValue ?? lastHistoryValue);
  const firstSeen = input.scope.firstSeenAt ?? sortedHistory[0]?.date ?? asOfDate;

  return {
    roas_history: roasHistory,
    peer_comparison: {
      p10: rounded(percentile(input.peers, 0.1)),
      p50: rounded(percentile(input.peers, 0.5)),
      p90: rounded(percentile(input.peers, 0.9)),
      this_value: rounded(thisValue),
    },
    regime_stability: regimeStability(sortedHistory),
    age_days: dateDiffDays(firstSeen, asOfDate),
    recent_changes: recentWithinWindow(input.recentChanges, asOfDate),
  };
}

function recommendationScope(recommendation: MetaRecommendation) {
  if (recommendation.level === "adset" && recommendation.adsetId) {
    return {
      type: "adset" as const,
      id: recommendation.adsetId,
      parentCampaignId: recommendation.campaignId ?? null,
    };
  }
  if (recommendation.level === "campaign" && recommendation.campaignId) {
    return {
      type: "campaign" as const,
      id: recommendation.campaignId,
      parentCampaignId: recommendation.campaignId,
    };
  }
  return { type: "account" as const, id: recommendation.id, parentCampaignId: null };
}

function key(scopeType: string, scopeId: string) {
  return `${scopeType}:${scopeId}`;
}

function actionLogMatchesScope(row: ActionLogRow, scopeId: string, recId: string) {
  if (row.rec_id_origin === recId) return true;
  const text = JSON.stringify({
    request: row.payload_request ?? null,
    response: row.payload_response ?? null,
  });
  return text.includes(scopeId);
}

function actionLogToRecentChange(row: ActionLogRow): MetaEvidenceTrailRecentChange {
  return {
    type: row.action,
    applied_at: row.requested_at,
    value: row.payload_request ?? row.payload_response ?? null,
  };
}

export async function buildEvidenceTrailsForRecommendations(input: {
  businessId: string;
  snapshotDate: string;
  recommendations: MetaRecommendation[];
  /**
   * The physical account this snapshot run is FOR (D-M011).
   *
   * The daily history below is narrowed by it. It was already account-safe by
   * identity — a trail is matched to a recommendation on `campaign_id` /
   * `adset_id`, and Meta entity ids are globally unique, so another account's
   * rows matched nothing and were simply fetched and discarded — but "narrowed
   * before the computation" is the rule, and reading one account's history to
   * build one account's trails is also the cheaper query.
   *
   * Null for a business with no assigned account, which reads everything it
   * has, exactly as before.
   */
  providerAccountId?: string | null;
}): Promise<Record<string, MetaEvidenceTrail>> {
  const snapshotDate = normalizeDate(input.snapshotDate);
  const account = input.providerAccountId?.trim() || null;
  if (input.recommendations.length === 0) return {};
  const start28 = addDaysToISO(snapshotDate, -27);
  const start14 = addDaysToISO(snapshotDate, -13);
  const sql = getDb();

  const [historyRows, actionRows] = await Promise.all([
    sql`
      SELECT
        'campaign'::text AS scope_type,
        campaign_id AS scope_id,
        campaign_id AS parent_campaign_id,
        date::text AS date,
        roas,
        bid_strategy_type
      FROM meta_campaign_daily
      WHERE business_id = ${input.businessId}
        AND (${account}::text IS NULL OR provider_account_id = ${account})
        AND date BETWEEN ${start28}::date AND ${snapshotDate}::date
      UNION ALL
      SELECT
        'adset'::text AS scope_type,
        adset_id AS scope_id,
        campaign_id AS parent_campaign_id,
        date::text AS date,
        roas,
        bid_strategy_type
      FROM meta_adset_daily
      WHERE business_id = ${input.businessId}
        AND (${account}::text IS NULL OR provider_account_id = ${account})
        AND date BETWEEN ${start28}::date AND ${snapshotDate}::date
    ` as Promise<DailyHistoryRow[]>,
    sql`
      SELECT
        action,
        requested_at::text AS requested_at,
        payload_request,
        payload_response,
        rec_id_origin
      -- NOT narrowed by account: meta_ads_action_log has no account column.
      -- It is keyed by ad_id, which is globally unique at Meta, and the match
      -- below is on that id — so another account's actions match no
      -- recommendation here. The absence is recorded so a reader does not
      -- mistake it for an oversight.
      FROM meta_ads_action_log
      WHERE business_id = ${input.businessId}
        AND requested_at >= ${start14}::date
        AND requested_at < (${snapshotDate}::date + interval '1 day')
      ORDER BY requested_at DESC
    ` as Promise<ActionLogRow[]>,
  ]);

  const historyByScope = new Map<string, DailyHistoryRow[]>();
  for (const row of historyRows) {
    const scopeKey = key(row.scope_type, row.scope_id);
    historyByScope.set(scopeKey, [...(historyByScope.get(scopeKey) ?? []), row]);
  }

  const latestRows = historyRows.filter((row) => row.date === snapshotDate);
  const campaignPeers = latestRows
    .filter((row) => row.scope_type === "campaign")
    .map((row) => toNumber(row.roas));
  const adsetPeersByCampaign = new Map<string, number[]>();
  for (const row of latestRows.filter((item) => item.scope_type === "adset")) {
    const parent = row.parent_campaign_id ?? "unknown";
    adsetPeersByCampaign.set(parent, [
      ...(adsetPeersByCampaign.get(parent) ?? []),
      toNumber(row.roas),
    ]);
  }

  return Object.fromEntries(
    input.recommendations.map((recommendation) => {
      const scope = recommendationScope(recommendation);
      const rows = historyByScope.get(key(scope.type, scope.id)) ?? [];
      const history = rows.map((row) => ({
        date: row.date,
        roas: toNumber(row.roas),
        regime: row.bid_strategy_type,
      }));
      const peers =
        scope.type === "adset"
          ? adsetPeersByCampaign.get(scope.parentCampaignId ?? "unknown") ?? []
          : campaignPeers;
      const recentChanges = actionRows
        .filter((row) => actionLogMatchesScope(row, scope.id, recommendation.id))
        .map(actionLogToRecentChange);
      const snapshotRow = rows.find((row) => row.date === snapshotDate);
      return [
        recommendation.id,
        buildEvidenceTrail({
          scope: {
            type: scope.type,
            id: scope.id,
            thisValue: snapshotRow ? toNumber(snapshotRow.roas) : undefined,
          },
          history,
          peers,
          recentChanges,
          asOfDate: snapshotDate,
        }),
      ];
    }),
  );
}
