import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import type { MetaCalibrationContext } from "@/lib/meta/recommendations";

export const META_ANOMALY_TYPES = [
  "roas_drop_sudden",
  "delivery_stall",
  "policy_block",
  "pacing_failure",
  "cpm_spike",
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
  detectedAt: string;
  resolvedAt?: string | null;
}

export interface DetectAnomaliesInput {
  businessId: string;
  snapshotDate: string;
  calibrationContext?: MetaCalibrationContext | null;
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
    detectedAt: input.detectedAt,
    resolvedAt: input.resolvedAt ?? null,
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
        daily_budget
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
      }),
    );
  }
  return anomalies;
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

  return [
    ...detectRoasDrops({ rows: campaignRows, snapshotDate, detectedAt }),
    ...detectDeliveryStalls({ rows: adsetRows, snapshotDate, detectedAt }),
    ...detectPolicyBlocks({ rows: adRows, snapshotDate, detectedAt }),
    ...detectPacingFailures({
      rows: campaignRows,
      snapshotDate,
      detectedAt,
      progress: timeOfDayProgress(snapshotDate, now),
    }),
    ...detectCpmSpikes({ rows: campaignRows, snapshotDate, detectedAt }),
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
    detectedAt: row.detected_at ?? stored?.detectedAt ?? row.snapshot_date,
    resolvedAt: row.resolved_at,
  };
}

export async function readMetaAnomaliesForBusiness(input: {
  businessId: string;
  activeOnly?: boolean;
}): Promise<ReadMetaAnomaliesResult> {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_decision_snapshots_daily"],
  }).catch(() => null);
  if (!readiness?.ready) {
    return { anomalies: [], snapshotDate: null, count: 0 };
  }

  const sql = getDb();
  const activeOnly = input.activeOnly === true;
  const [latest] = (await sql`
    SELECT MAX(snapshot_date)::text AS snapshot_date
    FROM meta_decision_snapshots_daily
    WHERE business_id = ${input.businessId}
      AND kind = 'anomaly'
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

  const anomalies = rows.map(hydrateAnomaly);
  return {
    anomalies,
    snapshotDate,
    count: anomalies.length,
  };
}
