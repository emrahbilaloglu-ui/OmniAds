import "dotenv/config";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

const BUSINESSES: Record<string, string> = {
  TheSwaf: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  IwaStore: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
};

const dsn = process.env.DATABASE_URL;
if (!dsn) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const pool = new Pool({ connectionString: dsn });

const SQL = `
WITH meta_agg AS (
  SELECT
    business_id,
    creative_id,
    MAX(creative_name) AS creative_name,
    MAX(asset_type) AS asset_type,
    MAX(campaign_id) AS campaign_id,
    MAX(date) AS last_seen_date,
    SUM(spend) AS spend_lifetime,
    SUM(CASE WHEN date > NOW() - INTERVAL '7 days' THEN spend ELSE 0 END) AS spend_7d,
    SUM(CASE WHEN date > NOW() - INTERVAL '30 days' THEN spend ELSE 0 END) AS spend_30d,
    SUM(conversions) AS purchases_lifetime,
    SUM(revenue) AS revenue_lifetime
  FROM meta_creative_daily
  WHERE business_id = $1
    AND date > NOW() - INTERVAL '180 days'
  GROUP BY business_id, creative_id
),
latest_status AS (
  SELECT DISTINCT ON (business_id, creative_id)
    business_id,
    creative_id,
    effective_status
  FROM meta_creative_daily
  WHERE business_id = $1
    AND date > NOW() - INTERVAL '180 days'
  ORDER BY business_id, creative_id, date DESC
),
v3 AS (
  SELECT DISTINCT ON (business_ref_id, creative_id)
    business_ref_id,
    creative_id,
    label, confidence, truth_source,
    effective_target_roas, ratio_to_target,
    badges, reason,
    spend AS v3_spend, purchases AS v3_purchases,
    roas AS v3_roas, recent7d_roas
  FROM engine_v3_decision_snapshots_daily
  WHERE business_ref_id::text = $1
  ORDER BY business_ref_id, creative_id, as_of_date DESC, computed_at DESC
),
lifecycle AS (
  SELECT DISTINCT ON (business_ref_id, creative_id)
    business_ref_id,
    creative_id,
    creative_format,
    lifecycle_position, fatigue_status, fatigue_confidence, fatigue_evidence,
    spend_28d, purchases_28d, purchase_value_28d, roas_28d, cpa_28d,
    ctr_28d, frequency_28d, impressions_28d, link_clicks_28d,
    spend_7d AS lc_spend_7d, purchases_7d AS lc_purchases_7d, roas_7d AS lc_roas_7d,
    age_days, active_days_30d, first_seen_date, last_active_date,
    peak_roas_30d, peak_roas_date, days_since_peak,
    spend_slope_7d, spend_slope_30d, roas_slope_7d, roas_slope_30d,
    spend_trajectory_30d,
    target_roas AS lc_target_roas, breakeven_roas AS lc_breakeven_roas,
    objective,
    thumbstop_28d, video25_rate_28d, video50_rate_28d, video75_rate_28d, video100_rate_28d,
    outbound_click_rate_28d, link_to_lpv_rate_28d, link_to_atc_rate_28d,
    lpv_to_atc_rate_28d, atc_to_ic_rate_28d, ic_to_purchase_rate_28d,
    click_to_purchase_rate_28d, atc_to_purchase_rate_28d,
    landing_page_views_28d, add_to_cart_28d, initiate_checkout_28d,
    funnel_primary_weak_stage, funnel_confidence, funnel_evidence,
    creative_responsibility_score, site_responsibility_score,
    checkout_responsibility_score, tracking_anomaly_score,
    quality_ranking, engagement_rate_ranking, conversion_rate_ranking,
    operator_response_type, operator_response_detected_at,
    eligible_for_lifecycle, data_freshness_hours
  FROM engine_v3_creative_lifecycle_daily
  WHERE business_ref_id::text = $1
  ORDER BY business_ref_id, creative_id, as_of_date DESC, computed_at DESC
),
target_pack AS (
  SELECT business_id, target_roas, break_even_roas, default_risk_posture,
         aov_assumption
  FROM business_target_packs
  WHERE business_id::text = $1
)
SELECT
  m.creative_id,
  m.creative_name,
  m.asset_type,
  m.campaign_id,
  m.last_seen_date,
  ls.effective_status,
  CASE
    WHEN ls.effective_status IN ('ACTIVE','ACTIVE_DELIVERY') AND m.spend_7d > 0 THEN 'active'
    WHEN m.last_seen_date > NOW() - INTERVAL '30 days' THEN 'closed_30d'
    ELSE 'older'
  END AS bucket,
  m.spend_lifetime, m.spend_7d, m.spend_30d,
  m.purchases_lifetime, m.revenue_lifetime,
  CASE WHEN m.spend_lifetime > 0 THEN m.revenue_lifetime / m.spend_lifetime ELSE NULL END AS roas_lifetime,
  EXTRACT(DAY FROM NOW() - m.last_seen_date::timestamptz)::int AS days_since_last_spend,
  tp.target_roas, tp.break_even_roas, tp.default_risk_posture, tp.aov_assumption,
  -- lifecycle 28d window (engine's primary eval window)
  lc.creative_format,
  lc.lifecycle_position, lc.fatigue_status, lc.fatigue_confidence,
  lc.spend_28d, lc.purchases_28d, lc.purchase_value_28d, lc.roas_28d,
  lc.cpa_28d, lc.ctr_28d, lc.frequency_28d, lc.impressions_28d,
  lc.lc_spend_7d, lc.lc_purchases_7d, lc.lc_roas_7d,
  lc.age_days, lc.active_days_30d,
  lc.peak_roas_30d, lc.days_since_peak,
  lc.spend_slope_7d, lc.spend_slope_30d, lc.roas_slope_7d, lc.roas_slope_30d,
  lc.spend_trajectory_30d,
  lc.thumbstop_28d, lc.outbound_click_rate_28d,
  lc.link_to_lpv_rate_28d, lc.link_to_atc_rate_28d,
  lc.lpv_to_atc_rate_28d, lc.atc_to_ic_rate_28d, lc.ic_to_purchase_rate_28d,
  lc.click_to_purchase_rate_28d,
  lc.funnel_primary_weak_stage, lc.funnel_confidence, lc.funnel_evidence,
  lc.creative_responsibility_score, lc.site_responsibility_score,
  lc.checkout_responsibility_score, lc.tracking_anomaly_score,
  lc.quality_ranking, lc.engagement_rate_ranking, lc.conversion_rate_ranking,
  lc.operator_response_type, lc.objective,
  lc.eligible_for_lifecycle,
  -- v3 decision
  v3.label AS v3_label,
  v3.reason AS v3_reason,
  v3.confidence AS v3_confidence,
  v3.truth_source AS v3_truth_source,
  v3.effective_target_roas AS v3_effective_target_roas,
  v3.ratio_to_target AS v3_ratio_to_target,
  v3.badges AS v3_badges
FROM meta_agg m
JOIN latest_status ls USING (business_id, creative_id)
LEFT JOIN v3 ON v3.business_ref_id::text = $1 AND v3.creative_id = m.creative_id
LEFT JOIN lifecycle lc ON lc.business_ref_id::text = $1 AND lc.creative_id = m.creative_id
CROSS JOIN target_pack tp
WHERE
  (ls.effective_status IN ('ACTIVE','ACTIVE_DELIVERY') AND m.spend_7d > 0)
  OR m.last_seen_date > NOW() - INTERVAL '30 days'
ORDER BY m.spend_lifetime DESC;
`;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "object") {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmt(value: unknown, decimals = 2): string {
  if (value === null || value === undefined) return "";
  const n = typeof value === "number" ? value : parseFloat(String(value));
  if (Number.isNaN(n)) return "";
  return n.toFixed(decimals);
}

async function main() {
  const allRows: Array<Record<string, unknown>> = [];

  for (const [name, id] of Object.entries(BUSINESSES)) {
    console.log(`[phase5] querying ${name} (${id})...`);
    const result = await pool.query(SQL, [id]);
    for (const row of result.rows) {
      allRows.push({ business: name, ...row });
    }
    console.log(`  → ${result.rows.length} rows`);
  }

  // Schema for raw labeling-ready CSV (no v3 cols, so labelers don't anchor)
  const headerRaw = [
    "business", "creative_id", "creative_name", "bucket",
    "asset_type", "creative_format", "objective",
    "last_seen_date", "effective_status",
    "age_days", "active_days_30d", "days_since_last_spend",
    "spend_lifetime", "spend_30d", "spend_7d",
    "purchases_lifetime", "revenue_lifetime", "roas_lifetime",
    "spend_28d", "purchases_28d", "purchase_value_28d", "roas_28d",
    "lc_spend_7d", "lc_purchases_7d", "lc_roas_7d",
    "cpa_28d", "ctr_28d", "frequency_28d", "impressions_28d",
    "thumbstop_28d", "outbound_click_rate_28d",
    "link_to_lpv_rate_28d", "link_to_atc_rate_28d",
    "lpv_to_atc_rate_28d", "atc_to_ic_rate_28d", "ic_to_purchase_rate_28d",
    "click_to_purchase_rate_28d",
    "lifecycle_position", "fatigue_status", "fatigue_confidence",
    "peak_roas_30d", "days_since_peak",
    "spend_slope_7d", "spend_slope_30d",
    "roas_slope_7d", "roas_slope_30d",
    "spend_trajectory_30d",
    "funnel_primary_weak_stage", "funnel_confidence",
    "creative_responsibility_score", "site_responsibility_score",
    "checkout_responsibility_score", "tracking_anomaly_score",
    "quality_ranking", "engagement_rate_ranking", "conversion_rate_ranking",
    "operator_response_type",
    "target_roas", "break_even_roas", "default_risk_posture", "aov_assumption",
    "eligible_for_lifecycle",
  ];

  const headerV3 = [
    "business", "creative_id", "creative_name", "bucket",
    "v3_label", "v3_reason", "v3_confidence", "v3_truth_source",
    "v3_effective_target_roas", "v3_ratio_to_target", "v3_badges",
    "funnel_primary_weak_stage", "funnel_confidence", "funnel_evidence",
  ];

  const csvRaw = [headerRaw.join(",")];
  const csvV3 = [headerV3.join(",")];

  const numericCols = new Set([
    "roas_lifetime", "roas_28d", "lc_roas_7d", "ctr_28d", "thumbstop_28d",
    "outbound_click_rate_28d", "link_to_lpv_rate_28d", "link_to_atc_rate_28d",
    "lpv_to_atc_rate_28d", "atc_to_ic_rate_28d", "ic_to_purchase_rate_28d",
    "click_to_purchase_rate_28d",
    "fatigue_confidence", "funnel_confidence",
    "creative_responsibility_score", "site_responsibility_score",
    "checkout_responsibility_score", "tracking_anomaly_score",
    "frequency_28d", "peak_roas_30d", "spend_slope_7d", "spend_slope_30d",
    "roas_slope_7d", "roas_slope_30d",
    "v3_confidence", "v3_effective_target_roas", "v3_ratio_to_target",
  ]);

  const moneyCols = new Set([
    "spend_lifetime", "spend_30d", "spend_7d",
    "spend_28d", "purchase_value_28d", "revenue_lifetime",
    "lc_spend_7d", "cpa_28d",
    "target_roas", "break_even_roas", "aov_assumption",
  ]);

  for (const row of allRows) {
    csvRaw.push(headerRaw.map((col) => {
      const v = (row as Record<string, unknown>)[col];
      if (numericCols.has(col)) return csvCell(fmt(v, 4));
      if (moneyCols.has(col)) return csvCell(fmt(v, 2));
      return csvCell(v);
    }).join(","));

    csvV3.push(headerV3.map((col) => {
      const v = (row as Record<string, unknown>)[col];
      if (col === "v3_confidence" || col === "v3_effective_target_roas" || col === "v3_ratio_to_target" || col === "funnel_confidence") {
        return csvCell(fmt(v, 4));
      }
      return csvCell(v);
    }).join(","));
  }

  const baseDir = resolve(process.cwd(), "_analysis/phase-5");
  writeFileSync(resolve(baseDir, "01-raw.csv"), csvRaw.join("\n") + "\n");
  writeFileSync(resolve(baseDir, "02-v3-decisions.csv"), csvV3.join("\n") + "\n");

  // Summary stats
  const byBucket: Record<string, number> = {};
  const byV3Label: Record<string, number> = {};
  const byBucketBusiness: Record<string, Record<string, number>> = {};
  for (const row of allRows) {
    const b = `${row.business}-${row.bucket}`;
    byBucket[b] = (byBucket[b] ?? 0) + 1;
    byBucketBusiness[String(row.business)] ??= {};
    byBucketBusiness[String(row.business)][String(row.bucket)] =
      (byBucketBusiness[String(row.business)][String(row.bucket)] ?? 0) + 1;
    const label = String(row.v3_label ?? "missing");
    byV3Label[label] = (byV3Label[label] ?? 0) + 1;
  }
  console.log("\n[phase5] universe by bucket:");
  for (const [k, v] of Object.entries(byBucket).sort()) console.log(`  ${k}: ${v}`);
  console.log("\n[phase5] v3 label distribution (full universe):");
  for (const [k, v] of Object.entries(byV3Label).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log(`\n[phase5] total: ${allRows.length} creatives`);
  console.log(`[phase5] wrote ${baseDir}/01-raw.csv + 02-v3-decisions.csv`);
}

main()
  .catch((err) => {
    console.error("ERROR:", err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  })
  .finally(() => pool.end());
