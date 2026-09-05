import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import type { BriefingStatusFilter } from "@/lib/meta/briefing-filter";
import type { MetaCalibrationContext } from "@/lib/meta/recommendations";

export const META_ANOMALY_TYPES = [
  "roas_drop_sudden",
  "delivery_stall",
  "policy_block",
  "pacing_failure",
  "cpm_spike",
  /*
    Two failures the existing five could not see.

    `pacing_failure` catches a campaign spending too SLOWLY. Nothing caught the
    opposite — a daily budget gone by mid-morning, which for the rest of the
    day is a campaign that cannot buy anything and a competitor auction it is
    absent from.

    And nothing at all caught the most expensive shape there is: real money
    spent, zero purchases. A ROAS drop needs a previous ROAS to drop from; an
    account that has never converted has none, so its worst days were invisible
    to every detector here.
  */
  "zero_conversions_with_spend",
  "budget_exhausted_early",
] as const;

export type MetaAnomalyType = (typeof META_ANOMALY_TYPES)[number];
export type MetaAnomalySeverity = "high" | "medium" | "low";
export type MetaAnomalyScopeType = "account" | "campaign" | "adset";

export interface MetaAnomaly {
  id: string;
  type: MetaAnomalyType;
  scopeType: MetaAnomalyScopeType;
  scopeId: string;
  scopeLabel: string;
  severity: MetaAnomalySeverity;
  kind: "anomaly";
  title: string;
  detail: string;
  diagnostics: string[];
  diagnosticLadder?: Array<{
    step: number;
    label: string;
    detail: string;
  }>;
  detectedAt: string;
  resolvedAt?: string | null;
  /** Briefing status of the scoped entity observed at detection time
   * (normalized uppercase, e.g. ACTIVE/PAUSED). Null on account scope and
   * on snapshots written before this field existed - readers must
   * fail-open on null so anomalies never disappear for lack of metadata. */
  entityStatus?: string | null;
}

export interface DetectAnomaliesInput {
  businessId: string;
  snapshotDate: string;
  calibrationContext?: MetaCalibrationContext | null;
  /**
   * What this account considers a meaningful loss, and when its day starts.
   *
   * Both new detectors need a number, and neither may invent one: "$50 with no
   * purchases" means something different on an account whose average order is
   * $30 and one whose average order is $400. The spend floor is the loss
   * budget the commercial targets already define — the CPA baseline times the
   * account's own risk posture — and the day fraction is measured in the
   * business's own timezone, because "by mid-morning" is a local sentence.
   *
   * Absent, both detectors produce nothing. A default here would be a
   * universal threshold wearing a profile's clothes.
   */
  profile?: {
    /** Spend at which zero purchases stops being a small sample. */
    lossBudgetSpend?: number | null;
    /** IANA zone the business's day is measured in. */
    timezone?: string | null;
  } | null;
  now?: Date;
}

export interface ReadMetaAnomaliesResult {
  anomalies: MetaAnomaly[];
  snapshotDate: string | null;
  count: number;
}

type CampaignDailyRow = {
  provider_account_id: string;
  date: string;
  campaign_id: string;
  campaign_name: string | null;
  campaign_status: string | null;
  spend: unknown;
  revenue: unknown;
  impressions: unknown;
  daily_budget: unknown;
  purchases: unknown;
};

type AdsetDailyRow = {
  provider_account_id: string;
  date: string;
  campaign_id: string | null;
  adset_id: string;
  adset_name: string | null;
  adset_status: string | null;
  spend: unknown;
  impressions: unknown;
  daily_budget: unknown;
};

type AdDailyRow = {
  date: string;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string;
  ad_name: string | null;
  effective_status: string | null;
  impressions: unknown;
  spend: unknown;
};

type SnapshotAnomalyRow = {
  snapshot_date: string;
  rec_id: string;
  rec_type: MetaAnomalyType;
  scope_type: MetaAnomalyScopeType;
  scope_id: string;
  severity: MetaAnomalySeverity | null;
  evidence: unknown;
  recommended_action: string;
  reasoning: string;
  diagnostics: unknown;
  detected_at: string | null;
  resolved_at: string | null;
};

const DAY_MS = 86_400_000;

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

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function sum<T>(rows: T[], pick: (row: T) => unknown) {
  return rows.reduce((total, row) => total + toNumber(pick(row)), 0);
}

function ratio(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

function cpm(spend: number, impressions: number) {
  return impressions > 0 ? (spend / impressions) * 1000 : 0;
}

function median(values: number[]) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function groupBy<T>(rows: T[], key: (row: T) => string | null | undefined) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const resolved = key(row);
    if (!resolved) continue;
    groups.set(resolved, [...(groups.get(resolved) ?? []), row]);
  }
  return groups;
}

function latestByDate<T extends { date: string }>(rows: T[]) {
  return [...rows].sort((left, right) => right.date.localeCompare(left.date))[0] ?? null;
}

function normalizeStatus(status: string | null | undefined): string | null {
  const value = String(status ?? "").trim().toUpperCase();
  return value || null;
}

function isActiveStatus(status: string | null | undefined) {
  return String(status ?? "").toUpperCase() === "ACTIVE";
}

function severityRank(severity: MetaAnomalySeverity) {
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

export function severityFromMagnitude(
  magnitude: number,
  thresholds = { high: 0.5, medium: 0.25 },
): MetaAnomalySeverity {
  if (magnitude >= thresholds.high) return "high";
  if (magnitude >= thresholds.medium) return "medium";
  return "low";
}

function detectedAtFor(snapshotDate: string, now: Date) {
  const today = now.toISOString().slice(0, 10);
  if (snapshotDate === today) return now.toISOString();
  return `${snapshotDate}T23:59:59.000Z`;
}

function positiveOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * How much of the business's OWN day has passed.
 *
 * `timeOfDayProgress` measures the UTC day, which is the right clock for a
 * UTC-dated snapshot and the wrong one for the sentence "the budget was gone
 * by mid-morning". A business in Los Angeles is eight hours from agreeing with
 * UTC about when its morning is.
 *
 * No zone, no answer. Substituting UTC would be quietly reporting somebody
 * else's morning as theirs.
 */
function localDayProgress(
  snapshotDate: string,
  now: Date,
  timezone: string | null | undefined,
): number | null {
  if (!timezone?.trim()) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);
  } catch {
    // An unknown zone is unreadable, not UTC.
    return null;
  }
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const localDate = `${part("year")}-${part("month")}-${part("day")}`;
  if (snapshotDate < localDate) return 1;
  if (snapshotDate > localDate) return 0;
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // 24 formats midnight as "24" in some locales; both mean the day just began.
  return Math.max(0, Math.min(1, ((hour % 24) * 60 + minute) / (24 * 60)));
}

function timeOfDayProgress(snapshotDate: string, now: Date) {
  const today = now.toISOString().slice(0, 10);
  if (snapshotDate < today) return 1;
  if (snapshotDate > today) return 0;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.min(1, (now.getTime() - start) / DAY_MS));
}

function anomalyId(input: {
  type: MetaAnomalyType;
  scopeType: MetaAnomalyScopeType;
  scopeId: string;
  snapshotDate: string;
}) {
  return `meta_anomaly_${input.snapshotDate}_${input.scopeType}_${input.scopeId}_${input.type}`;
}

function makeAnomaly(input: Omit<MetaAnomaly, "id" | "kind"> & { snapshotDate: string }): MetaAnomaly {
  const diagnosticLadder = input.diagnosticLadder ?? [
    {
      step: 1,
      label: "Tracking",
      detail: input.diagnostics.find((item) => /tracking|attribution|event/i.test(item)) ?? "Check pixel, CAPI, event match quality, and attribution freshness first.",
    },
    {
      step: 2,
      label: "Fatigue",
      detail: input.diagnostics.find((item) => /fatigue|audience|frequency|saturation/i.test(item)) ?? "Check CTR, frequency, audience pressure, and creative age before changing bids.",
    },
    {
      step: 3,
      label: "Recent edits",
      detail: input.diagnostics.find((item) => /change|budget|bid|landing/i.test(item)) ?? "Check budget, bid, learning, landing-page, and campaign edits in the last seven days.",
    },
    {
      step: 4,
      label: "Auction",
      detail: input.diagnostics.find((item) => /auction|cpm|placement|inventory/i.test(item)) ?? "Check CPM, placement mix, bid pressure, and auction competition.",
    },
    {
      step: 5,
      label: "Seasonality",
      detail: input.diagnostics.find((item) => /season|calendar|promo/i.test(item)) ?? "Check calendar, promotion, and demand-regime context before taking a single action.",
    },
  ];
  return {
    id: anomalyId({
      type: input.type,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      snapshotDate: input.snapshotDate,
    }),
    kind: "anomaly",
    type: input.type,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    scopeLabel: input.scopeLabel,
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    diagnostics: input.diagnostics,
    diagnosticLadder,
    detectedAt: input.detectedAt,
    resolvedAt: input.resolvedAt ?? null,
    entityStatus: input.entityStatus ?? null,
  };
}

async function fetchAnomalyInputs(input: { businessId: string; snapshotDate: string }) {
  const sql = getDb();
  const start28 = addDaysToISO(input.snapshotDate, -27);

  const [campaignRows, adsetRows, adRows] = await Promise.all([
    sql`
      SELECT
        provider_account_id,
        date::text AS date,
        campaign_id,
        COALESCE(campaign_name_current, campaign_name_historical, campaign_id) AS campaign_name,
        campaign_status,
        spend,
        revenue,
        impressions,
        daily_budget,
        /*
          The warehouse counts purchases in conversions.

          There is no purchases column on this table and never was, so this
          SELECT raised 42703 on every run -- and the caller swallows a failed
          detection into an empty list (snapshot.ts catches it into []). The
          symptom was not an error anywhere: it was that no Meta account ever
          produced a single anomaly, of any type. delivery_stall among them,
          which is why the bid path could never find the delivery evidence a
          cap raise requires.
        */
        conversions AS purchases
      FROM meta_campaign_daily
      WHERE business_id = ${input.businessId}
        AND date BETWEEN ${start28}::date AND ${input.snapshotDate}::date
    ` as Promise<CampaignDailyRow[]>,
    sql`
      SELECT
        provider_account_id,
        date::text AS date,
        campaign_id,
        adset_id,
        COALESCE(adset_name_current, adset_name_historical, adset_id) AS adset_name,
        adset_status,
        spend,
        impressions,
        daily_budget
      FROM meta_adset_daily
      WHERE business_id = ${input.businessId}
        AND date BETWEEN ${start28}::date AND ${input.snapshotDate}::date
    ` as Promise<AdsetDailyRow[]>,
    sql`
      SELECT
        date::text AS date,
        campaign_id,
        adset_id,
        ad_id,
        COALESCE(ad_name_current, ad_name_historical, ad_id) AS ad_name,
        COALESCE(
          NULLIF(payload_json->>'effective_status', ''),
          NULLIF(payload_json->>'status', ''),
          ad_status
        ) AS effective_status,
        impressions,
        spend
      FROM meta_ad_daily
      WHERE business_id = ${input.businessId}
        AND date BETWEEN ${start28}::date AND ${input.snapshotDate}::date
    ` as Promise<AdDailyRow[]>,
  ]);

  return { campaignRows, adsetRows, adRows };
}

function detectRoasDrops(input: {
  rows: CampaignDailyRow[];
  snapshotDate: string;
  detectedAt: string;
}) {
  const anomalies: MetaAnomaly[] = [];
  const last7Start = addDaysToISO(input.snapshotDate, -6);
  for (const [campaignId, rows] of groupBy(input.rows, (row) => row.campaign_id)) {
    const latest = latestByDate(rows);
    const last7 = rows.filter((row) => row.date >= last7Start);
    const spend7 = sum(last7, (row) => row.spend);
    const revenue7 = sum(last7, (row) => row.revenue);
    const spend28 = sum(rows, (row) => row.spend);
    const revenue28 = sum(rows, (row) => row.revenue);
    const roas7 = ratio(revenue7, spend7);
    const roas28 = ratio(revenue28, spend28);
    if (spend7 <= 200 || roas28 <= 0 || roas7 >= roas28 * 0.6) continue;

    const drop = 1 - ratio(roas7, roas28);
    anomalies.push(
      makeAnomaly({
        snapshotDate: input.snapshotDate,
        type: "roas_drop_sudden",
        scopeType: "campaign",
        scopeId: campaignId,
        scopeLabel: latest?.campaign_name ?? campaignId,
        severity: severityFromMagnitude(drop),
        title: "Sudden ROAS drop",
        detail: `7d ROAS fell to ${rounded(roas7)}x from a 28d baseline of ${rounded(roas28)}x on $${rounded(spend7)} recent spend.`,
        diagnostics: [
          "Recent creative fatigue or audience saturation.",
          "Tracking or purchase-event attribution disruption.",
          "Bid, budget, or landing-page change in the last week.",
        ],
        detectedAt: input.detectedAt,
        entityStatus: normalizeStatus(latest?.campaign_status),
      }),
    );
  }
  return anomalies;
}

function detectDeliveryStalls(input: {
  rows: AdsetDailyRow[];
  snapshotDate: string;
  detectedAt: string;
}) {
  const anomalies: MetaAnomaly[] = [];
  for (const [adsetId, rows] of groupBy(input.rows, (row) => row.adset_id)) {
    const latest = latestByDate(rows);
    if (!latest || latest.date !== input.snapshotDate || !isActiveStatus(latest.adset_status)) continue;
    const previous = rows
      .filter((row) => row.date < input.snapshotDate)
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-7);
    const baseline = median(previous.map((row) => toNumber(row.impressions)));
    const current = toNumber(latest.impressions);
    if (baseline <= 0 || current >= baseline * 0.4) continue;

    const drop = 1 - ratio(current, baseline);
    anomalies.push(
      makeAnomaly({
        snapshotDate: input.snapshotDate,
        type: "delivery_stall",
        scopeType: "adset",
        scopeId: adsetId,
        scopeLabel: latest.adset_name ?? adsetId,
        severity: severityFromMagnitude(drop, { high: 0.75, medium: 0.5 }),
        title: "Delivery stall",
        detail: `Latest impressions are ${Math.round(current)} versus a 7d median of ${Math.round(baseline)} while the ad set is active.`,
        diagnostics: [
          "Auction eligibility or learning reset reduced delivery.",
          "Audience, bid, or budget constraints are limiting spend.",
          "Policy or billing review may be suppressing impressions.",
        ],
        detectedAt: input.detectedAt,
        entityStatus: normalizeStatus(latest.adset_status),
      }),
    );
  }
  return anomalies;
}

function policyStatusKind(status: string | null | undefined) {
  const value = String(status ?? "").toUpperCase();
  if (/REJECT|DISAPPROV|BLOCK|DISABLE|WITH_ISSUES|POLICY/.test(value)) {
    return "blocked" as const;
  }
  if (/REVIEW|PENDING|PROCESS|IN_PROCESS/.test(value)) {
    return "review" as const;
  }
  return null;
}

function detectPolicyBlocks(input: {
  rows: AdDailyRow[];
  snapshotDate: string;
  detectedAt: string;
  scopeStatusById: Map<string, string | null>;
}) {
  const latestByAd = new Map<string, AdDailyRow>();
  for (const row of input.rows) {
    const current = latestByAd.get(row.ad_id);
    if (!current || row.date > current.date) latestByAd.set(row.ad_id, row);
  }

  const impacted = [...latestByAd.values()].filter((row) => {
    const kind = policyStatusKind(row.effective_status);
    if (!kind) return false;
    if (kind === "blocked") return true;
    return toNumber(row.impressions) <= 10 || toNumber(row.spend) <= 1;
  });

  const byScope = groupBy(impacted, (row) => row.adset_id ?? row.campaign_id);
  const anomalies: MetaAnomaly[] = [];
  for (const [scopeId, rows] of byScope) {
    const blockedCount = rows.filter((row) => policyStatusKind(row.effective_status) === "blocked").length;
    const scopeType: MetaAnomalyScopeType = rows[0]?.adset_id ? "adset" : "campaign";
    const sample = rows[0];
    anomalies.push(
      makeAnomaly({
        snapshotDate: input.snapshotDate,
        type: "policy_block",
        scopeType,
        scopeId,
        scopeLabel: sample?.ad_name ? `${sample.ad_name} group` : scopeId,
        severity: blockedCount > 0 ? "high" : "medium",
        title: "Policy delivery block",
        detail: `${rows.length} ad${rows.length === 1 ? "" : "s"} show rejected, blocked, or review statuses with delivery impact.`,
        diagnostics: rows.slice(0, 4).map((row) => `${row.ad_name ?? row.ad_id}: ${row.effective_status ?? "unknown status"}`),
        detectedAt: input.detectedAt,
        entityStatus: input.scopeStatusById.get(scopeId) ?? null,
      }),
    );
  }
  return anomalies;
}

function detectPacingFailures(input: {
  rows: CampaignDailyRow[];
  snapshotDate: string;
  detectedAt: string;
  progress: number;
}) {
  if (input.progress <= 0.6) return [];
  const anomalies: MetaAnomaly[] = [];
  for (const [campaignId, rows] of groupBy(input.rows, (row) => row.campaign_id)) {
    const latest = latestByDate(rows);
    if (!latest || latest.date !== input.snapshotDate || !isActiveStatus(latest.campaign_status)) continue;
    const budget = toNumber(latest.daily_budget);
    const spendToday = toNumber(latest.spend);
    if (budget <= 0 || spendToday >= budget * 0.4) continue;

    const spendRatio = ratio(spendToday, budget);
    anomalies.push(
      makeAnomaly({
        snapshotDate: input.snapshotDate,
        type: "pacing_failure",
        scopeType: "campaign",
        scopeId: campaignId,
        scopeLabel: latest.campaign_name ?? campaignId,
        severity: spendRatio <= 0.2 ? "high" : spendRatio <= 0.3 ? "medium" : "low",
        title: "Pacing failure",
        detail: `Campaign has spent $${rounded(spendToday)} of a $${rounded(budget)} daily budget after ${Math.round(input.progress * 100)}% of the UTC day.`,
        diagnostics: [
          "Bid or audience constraints are preventing normal pacing.",
          "Campaign may be stuck in review, learning, or limited delivery.",
          "Budget or schedule settings may not match intended daily pacing.",
        ],
        detectedAt: input.detectedAt,
        entityStatus: normalizeStatus(latest.campaign_status),
      }),
    );
  }
  return anomalies;
}

/**
 * Real money, no purchases.
 *
 * The most expensive failure a Meta account has, and until now no detector saw
 * it: `roas_drop_sudden` needs a previous ROAS to fall from, so an account or
 * campaign that has never converted produced no signal at all — its worst
 * fortnight looked exactly like its best one.
 *
 * The threshold is the account's OWN loss budget, not a number chosen here.
 * Below it, zero purchases is a small sample and saying anything would be
 * noise; above it, the campaign has spent what this business decided it was
 * willing to lose learning something, and learned that nobody bought.
 *
 * The window is 7 closed days, not today: an account with a long
 * consideration cycle would otherwise be accused of failing every morning.
 */
function detectZeroConversionSpend(input: {
  rows: CampaignDailyRow[];
  snapshotDate: string;
  detectedAt: string;
  lossBudgetSpend: number;
}) {
  const anomalies: MetaAnomaly[] = [];
  const windowStart = addDaysToISO(input.snapshotDate, -7);
  const windowEnd = addDaysToISO(input.snapshotDate, -1);
  for (const [campaignId, rows] of groupBy(input.rows, (row) => row.campaign_id)) {
    const latest = latestByDate(rows);
    if (!latest || !isActiveStatus(latest.campaign_status)) continue;
    const window = rows.filter(
      (row) => row.date >= windowStart && row.date <= windowEnd,
    );
    if (window.length === 0) continue;
    const spend = sum(window, (row) => row.spend);
    const purchases = sum(window, (row) => row.purchases);
    const revenue = sum(window, (row) => row.revenue);
    // Purchases AND revenue: a conversion the pixel counted without a value,
    // or a value without a count, is still a conversion. Neither is "nothing".
    if (purchases > 0 || revenue > 0) continue;
    if (spend < input.lossBudgetSpend) continue;

    const overBudget = ratio(spend, input.lossBudgetSpend);
    anomalies.push(
      makeAnomaly({
        snapshotDate: input.snapshotDate,
        type: "zero_conversions_with_spend",
        scopeType: "campaign",
        scopeId: campaignId,
        scopeLabel: latest.campaign_name ?? campaignId,
        // Two loss budgets spent with nothing to show is not a worse version
        // of the same problem; it is a different conversation.
        severity: overBudget >= 2 ? "high" : "medium",
        title: "Spending with no purchases",
        detail: `$${rounded(spend)} spent over 7 closed days with no recorded purchase, against a $${rounded(input.lossBudgetSpend)} loss budget.`,
        diagnostics: [
          "Conversion tracking may not be recording purchases for this campaign.",
          "Targeting or creative may be reaching people who do not buy.",
          "The offer or landing page may not convert the traffic being bought.",
        ],
        detectedAt: input.detectedAt,
        entityStatus: normalizeStatus(latest.campaign_status),
      }),
    );
  }
  return anomalies;
}

/**
 * The daily budget gone before the day is.
 *
 * `pacing_failure` is the opposite failure — a campaign spending too slowly —
 * and this is its missing twin. A budget exhausted at 30% of the day means the
 * campaign is absent from the auction for the other 70%, and the day's results
 * describe a morning rather than a day.
 *
 * The day fraction is measured in the BUSINESS's timezone, because "by
 * mid-morning" is a local sentence and Meta bills against the ad account's own
 * day. Without a zone there is no local morning to speak of, and the caller
 * passes none rather than assuming UTC.
 */
function detectEarlyBudgetExhaustion(input: {
  rows: CampaignDailyRow[];
  snapshotDate: string;
  detectedAt: string;
  /** How much of the local day has passed, 0–1. */
  localProgress: number;
}) {
  // Before a fifth of the day there is not enough day to be early in.
  if (input.localProgress <= 0.2 || input.localProgress >= 0.9) return [];
  const anomalies: MetaAnomaly[] = [];
  for (const [campaignId, rows] of groupBy(input.rows, (row) => row.campaign_id)) {
    const latest = latestByDate(rows);
    if (!latest || latest.date !== input.snapshotDate) continue;
    if (!isActiveStatus(latest.campaign_status)) continue;
    const budget = toNumber(latest.daily_budget);
    const spendToday = toNumber(latest.spend);
    if (budget <= 0) continue;
    const consumed = ratio(spendToday, budget);
    /*
      Spent faster than the clock, and nearly all of it.

      Both conditions matter. A campaign at 95% of budget at 90% of the day is
      pacing correctly; one at 95% at 30% of the day has stopped buying for
      most of it.
    */
    if (consumed < 0.9 || consumed <= input.localProgress * 1.5) continue;

    anomalies.push(
      makeAnomaly({
        snapshotDate: input.snapshotDate,
        type: "budget_exhausted_early",
        scopeType: "campaign",
        scopeId: campaignId,
        scopeLabel: latest.campaign_name ?? campaignId,
        severity: input.localProgress <= 0.5 ? "high" : "medium",
        title: "Budget spent early",
        detail: `$${rounded(spendToday)} of a $${rounded(budget)} daily budget was spent by ${Math.round(input.localProgress * 100)}% of the local day.`,
        diagnostics: [
          "Delivery is front-loading and the campaign is absent later in the day.",
          "The daily budget may be below what this audience can absorb.",
          "Bid strategy or schedule may be concentrating spend into a short window.",
        ],
        detectedAt: input.detectedAt,
        entityStatus: normalizeStatus(latest.campaign_status),
      }),
    );
  }
  return anomalies;
}

function detectCpmSpikes(input: {
  rows: CampaignDailyRow[];
  snapshotDate: string;
  detectedAt: string;
}) {
  const anomalies: MetaAnomaly[] = [];
  const last3Start = addDaysToISO(input.snapshotDate, -2);
  for (const [campaignId, rows] of groupBy(input.rows, (row) => row.campaign_id)) {
    const latest = latestByDate(rows);
    const last3 = rows.filter((row) => row.date >= last3Start);
    const spend3 = sum(last3, (row) => row.spend);
    const impressions3 = sum(last3, (row) => row.impressions);
    const spend28 = sum(rows, (row) => row.spend);
    const impressions28 = sum(rows, (row) => row.impressions);
    const cpm3 = cpm(spend3, impressions3);
    const cpm28 = cpm(spend28, impressions28);
    if (impressions3 <= 10_000 || cpm28 <= 0 || cpm3 <= cpm28 * 1.5) continue;

    const spikeRatio = ratio(cpm3, cpm28);
    anomalies.push(
      makeAnomaly({
        snapshotDate: input.snapshotDate,
        type: "cpm_spike",
        scopeType: "campaign",
        scopeId: campaignId,
        scopeLabel: latest?.campaign_name ?? campaignId,
        severity: spikeRatio >= 2 ? "high" : "medium",
        title: "CPM spike",
        detail: `3d CPM rose to $${rounded(cpm3)} from a 28d baseline of $${rounded(cpm28)} across ${Math.round(impressions3)} impressions.`,
        diagnostics: [
          "Auction competition changed sharply in the last three days.",
          "Audience narrowed or frequency pressure increased.",
          "Placement mix may have shifted into more expensive inventory.",
        ],
        detectedAt: input.detectedAt,
        entityStatus: normalizeStatus(latest?.campaign_status),
      }),
    );
  }
  return anomalies;
}

/**
 * The ad sets whose delivery is measurably limited, from anomalies already found.
 *
 * A bid cap may only be RAISED when delivery is actually constrained —
 * otherwise a higher cap just pays more for the same result. The sizing policy
 * has always required that evidence and the snapshot always passed an empty
 * set, so no cap increase could ever be produced.
 *
 * This is a projection of the EXISTING `delivery_stall` detector, not a second
 * opinion about delivery: one detector, one definition, and the card and the
 * bid intent cite the same fact. Medium and high only — a low-severity stall is
 * visible in the product and is not evidence enough to spend more per result.
 */
export function deliveryConstrainedAdsetIdsFrom(
  anomalies: readonly MetaAnomaly[],
): Set<string> {
  return new Set(
    anomalies
      .filter((anomaly) =>
        anomaly.type === "delivery_stall"
        && anomaly.scopeType === "adset"
        && (anomaly.severity === "high" || anomaly.severity === "medium")
        && anomaly.scopeId.trim().length > 0)
      .map((anomaly) => anomaly.scopeId),
  );
}

export async function detectAnomaliesForBusiness(input: DetectAnomaliesInput): Promise<MetaAnomaly[]> {
  void input.calibrationContext;
  const snapshotDate = normalizeDate(input.snapshotDate);
  const now = input.now ?? new Date();
  const detectedAt = detectedAtFor(snapshotDate, now);
  const { campaignRows, adsetRows, adRows } = await fetchAnomalyInputs({
    businessId: input.businessId,
    snapshotDate,
  });

  const lossBudgetSpend = positiveOrNull(input.profile?.lossBudgetSpend);
  const localProgress = localDayProgress(snapshotDate, now, input.profile?.timezone);

  const scopeStatusById = new Map<string, string | null>();
  for (const [campaignId, rows] of groupBy(campaignRows, (row) => row.campaign_id)) {
    scopeStatusById.set(campaignId, normalizeStatus(latestByDate(rows)?.campaign_status));
  }
  for (const [adsetId, rows] of groupBy(adsetRows, (row) => row.adset_id)) {
    scopeStatusById.set(adsetId, normalizeStatus(latestByDate(rows)?.adset_status));
  }

  return [
    ...detectRoasDrops({ rows: campaignRows, snapshotDate, detectedAt }),
    ...detectDeliveryStalls({ rows: adsetRows, snapshotDate, detectedAt }),
    ...detectPolicyBlocks({ rows: adRows, snapshotDate, detectedAt, scopeStatusById }),
    ...detectPacingFailures({
      rows: campaignRows,
      snapshotDate,
      detectedAt,
      progress: timeOfDayProgress(snapshotDate, now),
    }),
    ...detectCpmSpikes({ rows: campaignRows, snapshotDate, detectedAt }),
    /*
      Both new detectors are silent without a profile. That is deliberate: a
      default loss budget or an assumed timezone would be this module deciding
      what a business considers a bad day.
    */
    ...(lossBudgetSpend !== null
      ? detectZeroConversionSpend({
        rows: campaignRows, snapshotDate, detectedAt, lossBudgetSpend,
      })
      : []),
    ...(localProgress !== null
      ? detectEarlyBudgetExhaustion({
        rows: campaignRows, snapshotDate, detectedAt, localProgress,
      })
      : []),
  ].sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      left.scopeLabel.localeCompare(right.scopeLabel) ||
      left.type.localeCompare(right.type),
  );
}

function diagnosticsFrom(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function storedAnomaly(value: unknown): Partial<MetaAnomaly> | null {
  if (!value || typeof value !== "object") return null;
  const anomaly = (value as { anomaly?: unknown }).anomaly;
  if (!anomaly || typeof anomaly !== "object") return null;
  return anomaly as Partial<MetaAnomaly>;
}

function hydrateAnomaly(row: SnapshotAnomalyRow): MetaAnomaly {
  const stored = storedAnomaly(row.evidence);
  const diagnostics = diagnosticsFrom(row.diagnostics);
  return {
    id: row.rec_id,
    type: row.rec_type,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    scopeLabel: stored?.scopeLabel ?? row.scope_id,
    severity: row.severity ?? "low",
    kind: "anomaly",
    title: stored?.title ?? row.recommended_action,
    detail: stored?.detail ?? row.reasoning,
    diagnostics: diagnostics.length > 0 ? diagnostics : diagnosticsFrom(stored?.diagnostics),
    diagnosticLadder: Array.isArray(stored?.diagnosticLadder)
      ? stored.diagnosticLadder as MetaAnomaly["diagnosticLadder"]
      : undefined,
    detectedAt: row.detected_at ?? stored?.detectedAt ?? row.snapshot_date,
    resolvedAt: row.resolved_at,
    entityStatus: typeof stored?.entityStatus === "string" ? stored.entityStatus : null,
  };
}

/**
 * Status-filter semantics for anomalies. Anomaly rows store the entity
 * status OBSERVED at detection time (day resolution, no status-change
 * timestamp), so "recently paused" cannot be evaluated exactly:
 * - "active": keep ACTIVE; keep null/unknown (fail-open for pre-field
 *   snapshots - an anomaly must never vanish for lack of metadata).
 * - "active_plus_recent_paused": additionally keep PAUSED (coarse
 *   superset of the <=24h recent-paused rule used elsewhere).
 * - "all": keep everything.
 */
export function anomalyMatchesStatusFilter(
  anomaly: Pick<MetaAnomaly, "entityStatus">,
  filter: BriefingStatusFilter,
): boolean {
  if (filter === "all") return true;
  const status = anomaly.entityStatus ?? null;
  if (status === null || status === "UNKNOWN") return true;
  if (status === "ACTIVE") return true;
  return filter === "active_plus_recent_paused" && status === "PAUSED";
}

export async function readMetaAnomaliesForBusiness(input: {
  businessId: string;
  providerAccountId?: string | null;
  activeOnly?: boolean;
  /** Scope the anomaly snapshot to the selected range: the newest anomaly
   * snapshot at or before this date. Without it a historical range would
   * show today's anomalies. */
  endDate?: string | null;
  /** Filter by the entity status captured at anomaly write time. Null
   * applies no status filtering (legacy behavior). See
   * anomalyMatchesStatusFilter for the exact semantics. */
  statusFilter?: BriefingStatusFilter | null;
}): Promise<ReadMetaAnomaliesResult> {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_decision_snapshots_daily"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return { anomalies: [], snapshotDate: null, count: 0 };
  }

  const sql = getDb();
  const activeOnly = input.activeOnly === true;
  const endDateBound = input.endDate?.trim() || null;
  const [latest] = (await sql`
    SELECT MAX(snapshot_date)::text AS snapshot_date
    FROM meta_decision_snapshots_daily
    WHERE business_id = ${input.businessId}
      AND kind = 'anomaly'
      AND (${endDateBound}::date IS NULL OR snapshot_date <= ${endDateBound}::date)
  `) as Array<{ snapshot_date: string | null }>;
  const snapshotDate = latest?.snapshot_date ?? null;
  if (!snapshotDate) {
    return { anomalies: [], snapshotDate: null, count: 0 };
  }

  const rows = (await sql`
    SELECT
      snapshot_date::text AS snapshot_date,
      rec_id,
      rec_type,
      scope_type,
      scope_id,
      severity,
      evidence,
      recommended_action,
      reasoning,
      diagnostics,
      detected_at::text AS detected_at,
      resolved_at::text AS resolved_at
    FROM meta_decision_snapshots_daily
    WHERE business_id = ${input.businessId}
      AND kind = 'anomaly'
      AND snapshot_date = ${snapshotDate}::date
      AND (${activeOnly}::boolean IS FALSE OR resolved_at IS NULL)
    ORDER BY
      CASE severity
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        ELSE 1
      END DESC,
      detected_at DESC NULLS LAST,
      rec_type ASC
  `) as SnapshotAnomalyRow[];

  const providerAccountId = input.providerAccountId?.trim() || null;
  let allowedCampaignIds: Set<string> | null = null;
  let allowedAdsetIds: Set<string> | null = null;
  if (providerAccountId) {
    const [campaigns, adsets] = await Promise.all([
      sql`
        SELECT DISTINCT campaign_id
        FROM meta_campaign_dimensions
        WHERE business_id = ${input.businessId}
          AND provider_account_id = ${providerAccountId}
      ` as Promise<Array<{ campaign_id: string }>>,
      sql`
        SELECT DISTINCT adset_id
        FROM meta_adset_dimensions
        WHERE business_id = ${input.businessId}
          AND provider_account_id = ${providerAccountId}
      ` as Promise<Array<{ adset_id: string }>>,
    ]);
    allowedCampaignIds = new Set(campaigns.map((row) => row.campaign_id));
    allowedAdsetIds = new Set(adsets.map((row) => row.adset_id));
  }

  const statusFilter = input.statusFilter ?? null;
  const anomalies = rows
    .map(hydrateAnomaly)
    .filter((anomaly) => {
      if (!providerAccountId) return true;
      if (anomaly.scopeType === "campaign") {
        return allowedCampaignIds?.has(anomaly.scopeId) === true;
      }
      if (anomaly.scopeType === "adset") {
        return allowedAdsetIds?.has(anomaly.scopeId) === true;
      }
      return anomaly.scopeId === providerAccountId;
    })
    .filter((anomaly) => statusFilter === null || anomalyMatchesStatusFilter(anomaly, statusFilter));
  return {
    anomalies,
    snapshotDate,
    count: anomalies.length,
  };
}
