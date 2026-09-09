/**
 * Phase Meta R&D — live data extraction
 *
 * Pulls TheSwaf + IwaStore campaign + adset rows across 7d/14d/28d/90d windows,
 * joins per-account percentile calibration (Phase 5.2 meta_decision_calibration_daily),
 * joins current engine v3 snapshot output (Phase 5.2 meta_decision_snapshots_daily),
 * applies maturity filter (ageDays >= 14 OR spend_28d >= account_median × 0.3),
 * writes CSVs + extraction notes.
 *
 * Outputs:
 *   _analysis/phase-meta-rnd/00-raw-campaigns.csv
 *   _analysis/phase-meta-rnd/00-raw-adsets.csv
 *   _analysis/phase-meta-rnd/00-extraction-notes.md
 *
 * Usage: pnpm tsx scripts/_phase-meta-rnd-extract.ts [asOf]
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import { getMetaAdSetsForRange } from "@/lib/meta/adsets-source";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";

const BUSINESSES = [
  { id: "172d0ab8-495b-4679-a4c6-ffa404c389d3", name: "TheSwaf" },
  { id: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", name: "IwaStore" },
];

const WINDOW_DAYS = [7, 14, 28, 90] as const;
type WindowDays = (typeof WINDOW_DAYS)[number];

const METRIC_KEYS = [
  "spend",
  "revenue",
  "purchases",
  "impressions",
  "linkClicks",
  "frequency",
  "cpm",
  "ctr",
  "roas",
  "cpa",
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];

interface CalibrationPercentiles {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  sample_size: number;
}

interface CampaignSnapshot {
  business_id: string;
  business_name: string;
  campaign_id: string;
  campaign_name: string;
  status: string;
  objective: string | null;
  optimization_goal: string | null;
  bid_strategy: string | null;
  bid_amount: number | null;
  daily_budget: number | null;
  lifetime_budget: number | null;
  is_config_mixed: boolean;
  is_budget_mixed: boolean;
  is_optimization_goal_mixed: boolean;
  is_bid_strategy_mixed: boolean;
  age_days: number | null;
  currency: string | null;
  // Per-window metrics: spend_7d, spend_14d, spend_28d, spend_90d, etc.
  metrics: Partial<Record<`${MetricKey}_${WindowDays}d`, number>>;
  // Account-scope percentiles (per metric)
  account_calibration: Record<string, CalibrationPercentiles>;
  // Engine v3 snapshot output (most recent)
  engine_v3_label: string | null;
  engine_v3_confidence: number | null;
  engine_v3_reason: string | null;
  engine_v3_recommended_action: string | null;
  engine_v3_rec_type: string | null;
  engine_v3_decision_state: string | null;
  engine_v3_kind: string | null;
  engine_v3_engine_version: string | null;
}

interface AdSetSnapshot {
  business_id: string;
  business_name: string;
  parent_campaign_id: string;
  parent_campaign_name: string;
  adset_id: string;
  adset_name: string;
  status: string;
  optimization_goal: string | null;
  bid_strategy: string | null;
  bid_amount: number | null;
  daily_budget: number | null;
  lifetime_budget: number | null;
  is_config_mixed: boolean;
  age_days: number | null;
  currency: string | null;
  metrics: Partial<Record<`${MetricKey}_${WindowDays}d`, number>>;
  account_calibration: Record<string, CalibrationPercentiles>;
  engine_v3_label: string | null;
  engine_v3_confidence: number | null;
  engine_v3_reason: string | null;
  engine_v3_recommended_action: string | null;
  engine_v3_rec_type: string | null;
  engine_v3_decision_state: string | null;
  engine_v3_kind: string | null;
  engine_v3_engine_version: string | null;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "object") {
    s = JSON.stringify(v);
  } else {
    s = String(v);
  }
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCsvLine(row: Record<string, unknown>, cols: string[]): string {
  return cols.map((c) => csvCell(row[c])).join(",");
}

function dateOffset(asOf: string, deltaDays: number): string {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

async function fetchCampaignWindow(
  businessId: string,
  asOf: string,
  days: WindowDays,
) {
  const startDate = dateOffset(asOf, -(days - 1));
  const endDate = asOf;
  const result = await getMetaCampaignsForRange({
    businessId,
    startDate,
    endDate,
  });
  return result.rows ?? [];
}

async function fetchAdSetWindow(
  businessId: string,
  asOf: string,
  days: WindowDays,
) {
  const startDate = dateOffset(asOf, -(days - 1));
  const endDate = asOf;
  const result = await getMetaAdSetsForRange({
    businessId,
    startDate,
    endDate,
  });
  return result.rows ?? [];
}

function metricFromCampaign(
  row: MetaCampaignRow,
  key: MetricKey,
): number | undefined {
  switch (key) {
    case "spend":
      return row.spend;
    case "revenue":
      return row.revenue;
    case "purchases":
      return row.purchases;
    case "impressions":
      return row.impressions;
    case "linkClicks":
      return row.clicks;
    case "frequency":
      return row.frequency;
    case "cpm":
      return row.cpm;
    case "ctr":
      return row.ctr;
    case "roas":
      return row.roas;
    case "cpa":
      return row.cpa;
  }
}

function metricFromAdSet(
  row: MetaAdSetData,
  key: MetricKey,
): number | undefined {
  // MetaAdSetData extends MetaMetricsData and shares many fields
  const r = row as unknown as Record<string, number | undefined>;
  switch (key) {
    case "spend":
      return r.spend;
    case "revenue":
      return r.revenue;
    case "purchases":
      return r.purchases;
    case "impressions":
      return r.impressions;
    case "linkClicks":
      return r.clicks;
    case "frequency":
      return r.frequency;
    case "cpm":
      return r.cpm;
    case "ctr":
      return r.ctr;
    case "roas":
      return r.roas;
    case "cpa":
      return r.cpa;
  }
}

async function fetchCampaignAge(
  businessId: string,
  campaignIds: string[],
): Promise<Map<string, number | null>> {
  const ageMap = new Map<string, number | null>();
  if (campaignIds.length === 0) return ageMap;
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT campaign_id, first_seen_at
      FROM meta_campaign_dimensions
      WHERE business_id = ${businessId}
        AND campaign_id = ANY(${campaignIds})
    `) as Array<{ campaign_id: string; first_seen_at: string | null }>;
    const now = Date.now();
    for (const r of rows) {
      if (r.first_seen_at) {
        const age = Math.floor(
          (now - new Date(r.first_seen_at).getTime()) / 86400_000,
        );
        ageMap.set(r.campaign_id, age);
      } else {
        ageMap.set(r.campaign_id, null);
      }
    }
  } catch (e) {
    console.warn(
      "[meta-rnd] fetchCampaignAge failed (table may not exist):",
      String(e).slice(0, 120),
    );
  }
  return ageMap;
}

async function fetchAdSetAge(
  businessId: string,
  adsetIds: string[],
): Promise<Map<string, number | null>> {
  const ageMap = new Map<string, number | null>();
  if (adsetIds.length === 0) return ageMap;
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT adset_id, first_seen_at
      FROM meta_adset_dimensions
      WHERE business_id = ${businessId}
        AND adset_id = ANY(${adsetIds})
    `) as Array<{ adset_id: string; first_seen_at: string | null }>;
    const now = Date.now();
    for (const r of rows) {
      if (r.first_seen_at) {
        const age = Math.floor(
          (now - new Date(r.first_seen_at).getTime()) / 86400_000,
        );
        ageMap.set(r.adset_id, age);
      } else {
        ageMap.set(r.adset_id, null);
      }
    }
  } catch (e) {
    console.warn(
      "[meta-rnd] fetchAdSetAge failed (table may not exist):",
      String(e).slice(0, 120),
    );
  }
  return ageMap;
}

async function fetchAccountCalibration(
  businessId: string,
  asOf: string,
): Promise<Record<string, CalibrationPercentiles>> {
  const calibration: Record<string, CalibrationPercentiles> = {};
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT metric_name, p10, p25, p50, p75, p90, sample_size
      FROM meta_decision_calibration_daily
      WHERE business_id = ${businessId}
        AND scope_type = 'account'
        AND snapshot_date = (
          SELECT MAX(snapshot_date)
          FROM meta_decision_calibration_daily
          WHERE business_id = ${businessId}
            AND scope_type = 'account'
            AND snapshot_date <= ${asOf}::date
        )
    `) as Array<{
      metric_name: string;
      p10: string | number;
      p25: string | number;
      p50: string | number;
      p75: string | number;
      p90: string | number;
      sample_size: number;
    }>;
    for (const r of rows) {
      calibration[r.metric_name] = {
        p10: Number(r.p10),
        p25: Number(r.p25),
        p50: Number(r.p50),
        p75: Number(r.p75),
        p90: Number(r.p90),
        sample_size: r.sample_size,
      };
    }
  } catch (e) {
    console.warn(
      "[meta-rnd] fetchAccountCalibration failed:",
      String(e).slice(0, 120),
    );
  }
  return calibration;
}

interface EngineSnapshotRow {
  scope_type: string;
  scope_id: string;
  rec_type: string;
  decision_label: string | null;
  decision_state: string;
  confidence_score: string | number;
  reasoning: string;
  recommended_action: string;
  evidence: unknown;
  engine_version: string;
  kind: string | null;
}

async function fetchEngineSnapshots(
  businessId: string,
  asOf: string,
): Promise<Map<string, EngineSnapshotRow>> {
  const map = new Map<string, EngineSnapshotRow>();
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT scope_type, scope_id, rec_type, decision_label, decision_state, confidence_score,
             reasoning, recommended_action, evidence, engine_version, kind
      FROM meta_decision_snapshots_daily
      WHERE business_id = ${businessId}
        AND snapshot_date = (
          SELECT MAX(snapshot_date)
          FROM meta_decision_snapshots_daily
          WHERE business_id = ${businessId}
            AND snapshot_date <= ${asOf}::date
        )
      ORDER BY
        scope_type,
        scope_id,
        CASE decision_state WHEN 'act' THEN 1 WHEN 'test' THEN 2 ELSE 3 END,
        CASE WHEN rec_type IN ('campaign_state', 'adset_state', 'entity_state') THEN 2 ELSE 1 END,
        confidence_score DESC
    `) as EngineSnapshotRow[];
    for (const r of rows) {
      const key = `${r.scope_type}:${r.scope_id}`;
      if (!map.has(key)) map.set(key, r);
    }
  } catch (e) {
    console.warn(
      "[meta-rnd] fetchEngineSnapshots failed:",
      String(e).slice(0, 120),
    );
  }
  return map;
}

function decisionLabelFromRecType(recType: string): string {
  // Mirror components/meta/redesign/meta-card-utils.ts:decisionLabelForRec — same mapping
  // (including the known bug we're auditing: scale_for_profitability → "scale" is wrong)
  if (recType === "adset_cut_spend") return "cut";
  if (
    recType === "adset_scale_budget" ||
    recType === "scale_for_volume" ||
    recType === "scale_for_volume_budget_increase" ||
    recType === "scale_for_profitability" ||
    recType === "winner_promotion_flow"
  )
    return "scale";
  if (
    recType === "rebuild_with_constraints" ||
    recType === "campaign_structure" ||
    recType === "scaling_structure_fit"
  )
    return "rebuild";
  if (recType === "historical_bid_regime_fit") return "switch";
  if (
    recType === "bid_strategy_fit" ||
    recType === "bid_value_guidance" ||
    recType === "bid_band_from_history"
  )
    return "tune";
  if (recType === "geo_cluster_for_signal_density") return "swap";
  if (recType === "creative_test_structure") return "test_more";
  if (recType === "seasonal_regime_shift" || recType === "optimization_fit")
    return "diagnose";
  return "unknown";
}

function engineDecisionLabel(row: EngineSnapshotRow | null | undefined) {
  return (
    row?.decision_label || (row ? decisionLabelFromRecType(row.rec_type) : null)
  );
}

function isMature(
  spend28d: number | undefined,
  ageDays: number | null,
  accountSpendMedian: number | undefined,
): boolean {
  if (ageDays !== null && ageDays >= 14) return true;
  if (
    spend28d !== undefined &&
    accountSpendMedian !== undefined &&
    spend28d >= accountSpendMedian * 0.3
  )
    return true;
  // Fallback when both age and calibration unavailable: include if any meaningful 28d activity (>$50 spend)
  if (
    ageDays === null &&
    accountSpendMedian === undefined &&
    (spend28d ?? 0) >= 50
  )
    return true;
  return false;
}

async function buildCampaignSnapshots(
  business: { id: string; name: string },
  asOf: string,
): Promise<{
  rows: CampaignSnapshot[];
  totalFetched: number;
  filteredOut: number;
}> {
  console.log(`[meta-rnd] ${business.name} campaigns — fetching 4 windows...`);
  const windowResults: Record<WindowDays, MetaCampaignRow[]> = {
    7: await fetchCampaignWindow(business.id, asOf, 7),
    14: await fetchCampaignWindow(business.id, asOf, 14),
    28: await fetchCampaignWindow(business.id, asOf, 28),
    90: await fetchCampaignWindow(business.id, asOf, 90),
  };
  // Use 28d as canonical row inventory (most stable mid-window for status + config)
  const canonicalRows = windowResults[28];
  console.log(
    `[meta-rnd] ${business.name} campaigns — ${canonicalRows.length} canonical rows (28d window)`,
  );

  const calibration = await fetchAccountCalibration(business.id, asOf);
  const ageMap = await fetchCampaignAge(
    business.id,
    canonicalRows.map((r) => r.id),
  );
  const snapshots = await fetchEngineSnapshots(business.id, asOf);
  const accountSpendMedian = calibration["spend_28d"]?.p50;

  const buildMetricsForCampaign = (
    id: string,
  ): Partial<Record<`${MetricKey}_${WindowDays}d`, number>> => {
    const metrics: Partial<Record<`${MetricKey}_${WindowDays}d`, number>> = {};
    for (const days of WINDOW_DAYS) {
      const row = windowResults[days].find((r) => r.id === id);
      if (!row) continue;
      for (const m of METRIC_KEYS) {
        const v = metricFromCampaign(row, m);
        if (v !== undefined && Number.isFinite(v)) {
          metrics[`${m}_${days}d` as const] = v;
        }
      }
    }
    return metrics;
  };

  const allSnapshots: CampaignSnapshot[] = canonicalRows.map((row) => {
    const metrics = buildMetricsForCampaign(row.id);
    const ageDays = ageMap.get(row.id) ?? null;
    const eng = snapshots.get(`campaign:${row.id}`) ?? null;
    return {
      business_id: business.id,
      business_name: business.name,
      campaign_id: row.id,
      campaign_name: row.name,
      status: row.status,
      objective: row.objective ?? null,
      optimization_goal: row.optimizationGoal,
      bid_strategy: row.bidStrategyType,
      bid_amount: row.manualBidAmount,
      daily_budget: row.dailyBudget,
      lifetime_budget: row.lifetimeBudget,
      is_config_mixed: row.isConfigMixed,
      is_budget_mixed: row.isBudgetMixed,
      is_optimization_goal_mixed: row.isOptimizationGoalMixed ?? false,
      is_bid_strategy_mixed: row.isBidStrategyMixed ?? false,
      age_days: ageDays,
      currency: row.currency,
      metrics,
      account_calibration: calibration,
      engine_v3_label: engineDecisionLabel(eng),
      engine_v3_confidence: eng ? Number(eng.confidence_score) : null,
      engine_v3_reason: eng?.reasoning ?? null,
      engine_v3_recommended_action: eng?.recommended_action ?? null,
      engine_v3_rec_type: eng?.rec_type ?? null,
      engine_v3_decision_state: eng?.decision_state ?? null,
      engine_v3_kind: eng?.kind ?? null,
      engine_v3_engine_version: eng?.engine_version ?? null,
    };
  });

  const mature = allSnapshots.filter((s) =>
    isMature(s.metrics.spend_28d, s.age_days, accountSpendMedian),
  );
  return {
    rows: mature,
    totalFetched: allSnapshots.length,
    filteredOut: allSnapshots.length - mature.length,
  };
}

async function buildAdSetSnapshots(
  business: { id: string; name: string },
  asOf: string,
  campaignNameById: Map<string, string>,
): Promise<{
  rows: AdSetSnapshot[];
  totalFetched: number;
  filteredOut: number;
}> {
  console.log(`[meta-rnd] ${business.name} adsets — fetching 4 windows...`);
  const windowResults: Record<WindowDays, MetaAdSetData[]> = {
    7: await fetchAdSetWindow(business.id, asOf, 7),
    14: await fetchAdSetWindow(business.id, asOf, 14),
    28: await fetchAdSetWindow(business.id, asOf, 28),
    90: await fetchAdSetWindow(business.id, asOf, 90),
  };
  const canonicalRows = windowResults[28];
  console.log(
    `[meta-rnd] ${business.name} adsets — ${canonicalRows.length} canonical rows`,
  );

  const calibration = await fetchAccountCalibration(business.id, asOf);
  const ageMap = await fetchAdSetAge(
    business.id,
    canonicalRows.map((r) => r.id),
  );
  const snapshots = await fetchEngineSnapshots(business.id, asOf);
  const accountSpendMedian = calibration["spend_28d"]?.p50;

  const buildMetricsForAdSet = (
    id: string,
  ): Partial<Record<`${MetricKey}_${WindowDays}d`, number>> => {
    const metrics: Partial<Record<`${MetricKey}_${WindowDays}d`, number>> = {};
    for (const days of WINDOW_DAYS) {
      const row = windowResults[days].find((r) => r.id === id);
      if (!row) continue;
      for (const m of METRIC_KEYS) {
        const v = metricFromAdSet(row, m);
        if (v !== undefined && Number.isFinite(v)) {
          metrics[`${m}_${days}d` as const] = v;
        }
      }
    }
    return metrics;
  };

  const allSnapshots: AdSetSnapshot[] = canonicalRows.map((row) => {
    const metrics = buildMetricsForAdSet(row.id);
    const ageDays = ageMap.get(row.id) ?? null;
    const eng = snapshots.get(`adset:${row.id}`) ?? null;
    const r = row as unknown as Record<string, unknown>;
    return {
      business_id: business.id,
      business_name: business.name,
      parent_campaign_id: row.campaignId,
      parent_campaign_name: campaignNameById.get(row.campaignId) ?? "",
      adset_id: row.id,
      adset_name: row.name,
      status: row.status,
      optimization_goal: row.optimizationGoal,
      bid_strategy: row.bidStrategyType,
      bid_amount: row.manualBidAmount,
      daily_budget: row.dailyBudget,
      lifetime_budget: row.lifetimeBudget,
      is_config_mixed: row.isConfigMixed,
      age_days: ageDays,
      currency: (r.currency as string) ?? "USD",
      metrics,
      account_calibration: calibration,
      engine_v3_label: engineDecisionLabel(eng),
      engine_v3_confidence: eng ? Number(eng.confidence_score) : null,
      engine_v3_reason: eng?.reasoning ?? null,
      engine_v3_recommended_action: eng?.recommended_action ?? null,
      engine_v3_rec_type: eng?.rec_type ?? null,
      engine_v3_decision_state: eng?.decision_state ?? null,
      engine_v3_kind: eng?.kind ?? null,
      engine_v3_engine_version: eng?.engine_version ?? null,
    };
  });

  const mature = allSnapshots.filter((s) =>
    isMature(s.metrics.spend_28d, s.age_days, accountSpendMedian),
  );
  return {
    rows: mature,
    totalFetched: allSnapshots.length,
    filteredOut: allSnapshots.length - mature.length,
  };
}

function flattenForCsv(
  snap: CampaignSnapshot | AdSetSnapshot,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...snap };
  delete out.metrics;
  delete out.account_calibration;
  for (const k of Object.keys(snap.metrics)) {
    out[k] = (snap.metrics as Record<string, unknown>)[k];
  }
  for (const m of Object.keys(snap.account_calibration)) {
    const p = snap.account_calibration[m];
    out[`acct_${m}_p10`] = p.p10;
    out[`acct_${m}_p25`] = p.p25;
    out[`acct_${m}_p50`] = p.p50;
    out[`acct_${m}_p75`] = p.p75;
    out[`acct_${m}_p90`] = p.p90;
    out[`acct_${m}_sample`] = p.sample_size;
  }
  return out;
}

async function main() {
  const asOf = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  configureOperationalScriptRuntime({ lane: "owner_maintenance" });

  await withOperationalStartupLogsSilenced(async () => {
    const allCampaigns: CampaignSnapshot[] = [];
    const allAdsets: AdSetSnapshot[] = [];
    const stats: Array<{
      business: string;
      campaigns_total: number;
      campaigns_mature: number;
      adsets_total: number;
      adsets_mature: number;
      calibration_metrics: number;
      engine_snapshots: number;
    }> = [];

    for (const business of BUSINESSES) {
      console.log(`\n[meta-rnd] === ${business.name} ===`);
      const campaignResult = await buildCampaignSnapshots(business, asOf);
      allCampaigns.push(...campaignResult.rows);
      const campaignNameById = new Map<string, string>();
      for (const c of campaignResult.rows)
        campaignNameById.set(c.campaign_id, c.campaign_name);

      const adsetResult = await buildAdSetSnapshots(
        business,
        asOf,
        campaignNameById,
      );
      allAdsets.push(...adsetResult.rows);

      const calibration = await fetchAccountCalibration(business.id, asOf);
      const snapshots = await fetchEngineSnapshots(business.id, asOf);

      stats.push({
        business: business.name,
        campaigns_total: campaignResult.totalFetched,
        campaigns_mature: campaignResult.rows.length,
        adsets_total: adsetResult.totalFetched,
        adsets_mature: adsetResult.rows.length,
        calibration_metrics: Object.keys(calibration).length,
        engine_snapshots: snapshots.size,
      });

      console.log(
        `[meta-rnd] ${business.name} — campaigns mature ${campaignResult.rows.length}/${campaignResult.totalFetched}, adsets mature ${adsetResult.rows.length}/${adsetResult.totalFetched}`,
      );
    }

    // Write campaign CSV
    const campaignFlat = allCampaigns.map(flattenForCsv);
    const campaignCols = Array.from(
      new Set(campaignFlat.flatMap((r) => Object.keys(r))),
    );
    const campaignsCsv = [
      campaignCols.join(","),
      ...campaignFlat.map((r) => rowToCsvLine(r, campaignCols)),
    ].join("\n");
    const campaignsPath = resolve(
      process.cwd(),
      "_analysis/phase-meta-rnd/00-raw-campaigns.csv",
    );
    writeFileSync(campaignsPath, campaignsCsv);
    console.log(
      `\n[meta-rnd] wrote ${allCampaigns.length} campaign rows to ${campaignsPath}`,
    );

    // Write adset CSV
    const adsetFlat = allAdsets.map(flattenForCsv);
    const adsetCols = Array.from(
      new Set(adsetFlat.flatMap((r) => Object.keys(r))),
    );
    const adsetsCsv = [
      adsetCols.join(","),
      ...adsetFlat.map((r) => rowToCsvLine(r, adsetCols)),
    ].join("\n");
    const adsetsPath = resolve(
      process.cwd(),
      "_analysis/phase-meta-rnd/00-raw-adsets.csv",
    );
    writeFileSync(adsetsPath, adsetsCsv);
    console.log(
      `[meta-rnd] wrote ${allAdsets.length} adset rows to ${adsetsPath}`,
    );

    // Write extraction notes
    const notes = `# Phase Meta R&D — Extraction Notes

**Run timestamp:** ${new Date().toISOString()}
**As-of date:** ${asOf}

## Window definitions

For each entity (campaign + adset), four metric windows are pulled and merged into per-row columns:
- 7d: ${dateOffset(asOf, -6)} → ${asOf}
- 14d: ${dateOffset(asOf, -13)} → ${asOf}
- 28d: ${dateOffset(asOf, -27)} → ${asOf} (canonical row inventory + maturity reference)
- 90d: ${dateOffset(asOf, -89)} → ${asOf}

Per-window metric set: ${METRIC_KEYS.join(", ")}.

Column naming: \`{metric}_{days}d\` — e.g. \`spend_28d\`, \`roas_7d\`, \`frequency_14d\`.

## Maturity filter

A row is kept if EITHER:
- \`age_days >= 14\` (campaign/adset created at least 14 days ago), OR
- \`spend_28d >= account_spend_28d_p50 × 0.3\` (entity carries meaningful share of account spend)

Otherwise filtered out (too thin / too new for persona evaluation to be statistically grounded).

## Calibration source

Account-scope percentiles pulled from \`meta_decision_calibration_daily\`, most recent snapshot ≤ as-of date.

Per-row columns: \`acct_{metric}_p10/p25/p50/p75/p90/sample\` for every metric in the calibration table for that account. Personas use these for account-history grounded thresholds (no generic industry benchmarks).

## Engine v3 snapshot source

Most recent \`meta_decision_snapshots_daily\` row matching the entity is joined per row. Carried fields:
- \`engine_v3_label\` — backend-owned \`decision_label\` from \`meta_decision_snapshots_daily\`; falls back to legacy rec-type mapping only for older rows without a stored label.
- \`engine_v3_confidence\` — 0-1 statistical confidence
- \`engine_v3_reason\` — engine's reasoning text
- \`engine_v3_recommended_action\` — concrete action string
- \`engine_v3_rec_type\` — category (e.g. scale_for_volume, scale_for_profitability, bid_strategy_fit)
- \`engine_v3_decision_state\` — act | test | watch
- \`engine_v3_kind\` — recommendation | anomaly
- \`engine_v3_engine_version\` — version stamp

If the engine has no snapshot for an entity (less mature, in shadow_only mode, or missing for any reason), all engine_v3_* columns are null.

## Extraction stats

${stats.map((s) => `- **${s.business}**: campaigns ${s.campaigns_mature}/${s.campaigns_total} mature, adsets ${s.adsets_mature}/${s.adsets_total} mature, calibration metrics ${s.calibration_metrics}, engine snapshots ${s.engine_snapshots}`).join("\n")}

**Total rows:** ${allCampaigns.length} campaigns + ${allAdsets.length} adsets = ${allCampaigns.length + allAdsets.length} entities for persona evaluation.

## Known limitations

- \`age_days\` may be null when \`meta_campaign_dimensions\` / \`meta_adset_dimensions\` tables don't carry the entity (warehouse coverage gap). Maturity filter falls back to spend-share rule.
- Calibration is account-scope only here. Campaign-scope calibration (Phase 5.2 enhanced calibration where supported) is not joined — could be added in a follow-up.
- Only the most recent engine snapshot is joined. Historical engine output (prior days) not included; if persona analysis needs trajectory of engine decisions, separate query needed.
- Peer-group ROAS is NOT pre-computed in this extraction. Personas should compute peer references on the fly using account percentiles + family classification (campaign role, optimization intent).
- \`is_config_mixed\` and related "mixed" flags carry forward from the warehouse but personas should validate them against actual config diversity within the entity (some flags may be over-eager or under-detected).

## Reproducibility

Re-running this script with the same as-of date may produce slightly different output if:
- New engine snapshots were written between runs (calibration job ran)
- Warehouse refreshed historical metrics (rare but possible)
- Campaign/adset config changed (status flips, budget edits)

For deterministic R&D, use the same CSVs across Claude + Codex evaluations. Do not regenerate mid-evaluation.
`;
    const notesPath = resolve(
      process.cwd(),
      "_analysis/phase-meta-rnd/00-extraction-notes.md",
    );
    writeFileSync(notesPath, notes);
    console.log(`[meta-rnd] wrote extraction notes to ${notesPath}`);
  });
}

main()
  .then(async () => {
    await resetDbClientCache();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await resetDbClientCache();
    process.exit(1);
  });
