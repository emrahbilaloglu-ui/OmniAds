#!/usr/bin/env node
// H11B campaign-context lifecycle challenger — STAGE 1: frozen evidence bundle.
//
// Reads, once and SELECT-only, every input the H11B evaluation needs for the
// six named businesses, and freezes it into a single hashed JSON artifact so
// the evaluation stage (h11b-context-lifecycle-eval.ts) is deterministic and
// offline. The manual-label table is read here strictly as the frozen OFFLINE
// comparator (D074): labels are evaluation truth, never a resolver input.
//
// Window design (recorded in the artifact):
// - EVAL window 2026-07-13 .. 2026-08-22: entity-state history (status,
//   budgets, adset structure) exists only from 2026-07-13, and every source
//   stops at 2026-08-22 (ingestion halted by the storage fence breach).
// - Creative-day source extends 56 days earlier for feature windows, and
//   campaign first-seen is unbounded history (age is a legitimate PIT fact).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { addDaysUtc } from "@/lib/creative-decision-engine/campaign-context/data";

export const H11B_BUNDLE_CONTRACT_VERSION =
  "adsecute.meta.h11b-context-lifecycle-bundle.v1";

export const H11B_BUSINESS_NAMES = [
  "Bilsem Zeka",
  "ColorFullWorldsTR",
  "Grandmix",
  "IwaStore",
  "IwaTR",
  "TheSwaf",
] as const;

export const H11B_EVAL_START = "2026-07-13";
export const H11B_EVAL_END = "2026-08-22";
// Train anchors reach back to 2026-06-15 so the frozen labels' Test
// campaigns are observed WHILE running (they are all paused by mid-July);
// the creative-day source extends 56 days before that earliest anchor.
export const H11B_EARLIEST_ANCHOR = "2026-06-15";
const SOURCE_WINDOW_DAYS = 56;
const SOURCE_START = addDaysUtc(H11B_EARLIEST_ANCHOR, -(SOURCE_WINDOW_DAYS - 1));

const JSON_OUT =
  "docs/creative-decision-center/generated/h11b-context-lifecycle-bundle-2026-07-13-to-2026-08-22.json";

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value === null || value === undefined) return null;
  return String(value);
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = num(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function day(value: unknown): string | null {
  return text(value)?.slice(0, 10) ?? null;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function main() {
  const [{ getDb, runDbTransaction }, operational] = await Promise.all([
    import("@/lib/db"),
    import("@/scripts/_operational-runtime"),
  ]);
  operational.configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  process.env.DB_QUERY_TIMEOUT_MS = "180000";

  const bundle = await operational.withOperationalStartupLogsSilenced(
    async () =>
      runDbTransaction(async () => {
        const db = getDb();
        await db.query("SET TRANSACTION READ ONLY");
        const readOnly = await db.query<{ transaction_read_only: string }>(
          "SHOW transaction_read_only",
        );
        if (readOnly[0]?.transaction_read_only !== "on") {
          throw new Error(
            "H11B bundle refuses to run outside a read-only transaction",
          );
        }

        const businesses = await db.query<Row>(
          `
          SELECT b.id::text AS business_id, b.name, bpa.provider_account_id
          FROM businesses b
          JOIN business_provider_accounts bpa
            ON bpa.business_id = b.id::text AND bpa.provider = 'meta'
          WHERE b.name = ANY($1::text[])
          ORDER BY b.name, bpa.provider_account_id
          `,
          [[...H11B_BUSINESS_NAMES]],
        );
        const businessIds = [
          ...new Set(businesses.map((row) => text(row.business_id) ?? "")),
        ].filter(Boolean);

        const creativeRows = await db.query<Row>(
          `
          WITH first_spend AS (
            SELECT
              COALESCE(business_ref_id::text, business_id) AS business_id,
              provider_account_id, creative_id, MIN(date) AS first_spend_date
            FROM meta_creative_daily
            WHERE date <= $3::date AND spend > 0
              AND provider_account_id IS NOT NULL AND creative_id IS NOT NULL
            GROUP BY 1, 2, 3
          )
          SELECT
            COALESCE(d.business_ref_id::text, d.business_id) AS business_id,
            d.provider_account_id, d.campaign_id, d.adset_id, d.creative_id,
            d.date::text AS date, d.spend,
            fs.first_spend_date::text AS first_spend_date
          FROM meta_creative_daily d
          JOIN first_spend fs
            ON fs.business_id = COALESCE(d.business_ref_id::text, d.business_id)
           AND fs.provider_account_id = d.provider_account_id
           AND fs.creative_id = d.creative_id
          WHERE COALESCE(d.business_ref_id::text, d.business_id) = ANY($1::text[])
            AND d.date BETWEEN $2::date AND $3::date
            AND d.spend > 0
            AND d.provider_account_id IS NOT NULL
            AND d.campaign_id IS NOT NULL AND d.creative_id IS NOT NULL
          ORDER BY 1, 2, 6, 3, 5
          `,
          [businessIds, SOURCE_START, H11B_EVAL_END],
        );

        const nameRows = await db.query<Row>(
          `
          WITH timeline AS (
            SELECT
              COALESCE(business_ref_id::text, business_id) AS business_id,
              provider_account_id, campaign_id, date,
              COALESCE(campaign_name_current, campaign_name_historical)
                AS campaign_name,
              LAG(COALESCE(campaign_name_current, campaign_name_historical))
                OVER (
                  PARTITION BY COALESCE(business_ref_id::text, business_id),
                    provider_account_id, campaign_id
                  ORDER BY date
                ) AS previous_name,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE(business_ref_id::text, business_id),
                  provider_account_id, campaign_id
                ORDER BY date
              ) AS sequence_number
            FROM meta_campaign_daily
            WHERE date <= $2::date
              AND provider_account_id IS NOT NULL AND campaign_id IS NOT NULL
              AND COALESCE(business_ref_id::text, business_id) = ANY($1::text[])
          )
          SELECT business_id, provider_account_id, campaign_id,
            date::text AS date, campaign_name
          FROM timeline
          WHERE sequence_number = 1
             OR campaign_name IS DISTINCT FROM previous_name
          ORDER BY business_id, provider_account_id, campaign_id, date
          `,
          [businessIds, H11B_EVAL_END],
        );

        const firstSeenRows = await db.query<Row>(
          `
          SELECT
            COALESCE(business_ref_id::text, business_id) AS business_id,
            provider_account_id, campaign_id,
            MIN(date)::text AS first_seen_date
          FROM meta_campaign_daily
          WHERE date <= $2::date
            AND provider_account_id IS NOT NULL AND campaign_id IS NOT NULL
            AND COALESCE(business_ref_id::text, business_id) = ANY($1::text[])
          GROUP BY 1, 2, 3
          ORDER BY 1, 2, 3
          `,
          [businessIds, H11B_EVAL_END],
        );

        // Frozen OFFLINE comparator (evaluation truth only, never a feature).
        const labelRows = await db.query<Row>(
          `
          SELECT business_id, provider_account_id, campaign_id, campaign_kind,
            labeled_at::date::text AS labeled_at_date,
            updated_at::date::text AS updated_at_date, source
          FROM meta_campaign_labels
          WHERE campaign_kind IN ('main', 'test', 'mixed')
            AND business_id = ANY($1::text[])
          ORDER BY business_id, provider_account_id, campaign_id
          `,
          [businessIds],
        );

        // D075-era campaign lifecycle series: change points only, complete
        // lane, per (business, account, campaign, captured day).
        const campaignStateRows = await db.query<Row>(
          `
          WITH daily AS (
            SELECT DISTINCT ON (business_id, provider_account_id, entity_id,
              captured_at::date)
              business_id, provider_account_id, entity_id AS campaign_id,
              captured_at::date AS captured_date,
              configured_status, effective_status, presence,
              campaign_daily_budget_raw
            FROM meta_entity_state_history
            WHERE entity_type = 'campaign'
              AND run_completeness = 'complete'
              AND business_id = ANY($1::text[])
              AND captured_at <= ($2::date + 1)::timestamptz
            ORDER BY business_id, provider_account_id, entity_id,
              captured_at::date, captured_at DESC, created_at DESC, id DESC
          ), change_points AS (
            SELECT *,
              LAG(configured_status || '|' || COALESCE(effective_status, '')
                || '|' || presence || '|'
                || COALESCE(campaign_daily_budget_raw::text, '')) OVER (
                PARTITION BY business_id, provider_account_id, campaign_id
                ORDER BY captured_date
              ) AS previous_signature,
              ROW_NUMBER() OVER (
                PARTITION BY business_id, provider_account_id, campaign_id
                ORDER BY captured_date
              ) AS sequence_number
            FROM daily
          )
          SELECT business_id, provider_account_id, campaign_id,
            captured_date::text AS captured_date, configured_status,
            effective_status, presence, campaign_daily_budget_raw
          FROM change_points
          WHERE sequence_number = 1
             OR (configured_status || '|' || COALESCE(effective_status, '')
                || '|' || presence || '|'
                || COALESCE(campaign_daily_budget_raw::text, ''))
                IS DISTINCT FROM previous_signature
          ORDER BY business_id, provider_account_id, campaign_id, captured_date
          `,
          [businessIds, H11B_EVAL_END],
        );

        // Ad-set structure per campaign per captured day (aggregates only).
        const adsetDailyRows = await db.query<Row>(
          `
          WITH daily AS (
            SELECT DISTINCT ON (business_id, provider_account_id, entity_id,
              captured_at::date)
              business_id, provider_account_id, entity_id AS adset_id,
              campaign_id, captured_at::date AS captured_date,
              configured_status, presence, adset_daily_budget_raw
            FROM meta_entity_state_history
            WHERE entity_type = 'adset'
              AND run_completeness = 'complete'
              AND business_id = ANY($1::text[])
              AND captured_at <= ($2::date + 1)::timestamptz
            ORDER BY business_id, provider_account_id, entity_id,
              captured_at::date, captured_at DESC, created_at DESC, id DESC
          )
          SELECT business_id, provider_account_id, campaign_id,
            captured_date::text AS captured_date,
            COUNT(*) FILTER (
              WHERE presence = 'present' AND configured_status = 'ACTIVE'
            )::int AS active_adsets,
            COUNT(*) FILTER (WHERE presence = 'present')::int AS present_adsets,
            SUM(NULLIF(adset_daily_budget_raw, '')::numeric) FILTER (
              WHERE presence = 'present' AND configured_status = 'ACTIVE'
            ) AS active_adset_budget_sum
          FROM daily
          WHERE campaign_id IS NOT NULL
          GROUP BY 1, 2, 3, 4
          ORDER BY 1, 2, 3, 4
          `,
          [businessIds, H11B_EVAL_END],
        );

        return {
          businesses: businesses.map((row) => ({
            businessId: text(row.business_id) ?? "",
            name: text(row.name) ?? "",
            providerAccountId: text(row.provider_account_id) ?? "",
          })),
          creativeRows: creativeRows.map((row) => ({
            businessId: text(row.business_id) ?? "",
            accountId: text(row.provider_account_id) ?? "",
            campaignId: text(row.campaign_id) ?? "",
            adsetId: text(row.adset_id),
            creativeId: text(row.creative_id) ?? "",
            date: day(row.date) ?? "",
            spend: num(row.spend),
            firstSpendDate: day(row.first_spend_date) ?? "",
          })),
          nameRows: nameRows.map((row) => ({
            businessId: text(row.business_id) ?? "",
            accountId: text(row.provider_account_id) ?? "",
            campaignId: text(row.campaign_id) ?? "",
            date: day(row.date) ?? "",
            campaignName: text(row.campaign_name),
          })),
          firstSeenRows: firstSeenRows.map((row) => ({
            businessId: text(row.business_id) ?? "",
            accountId: text(row.provider_account_id) ?? "",
            campaignId: text(row.campaign_id) ?? "",
            firstSeenDate: day(row.first_seen_date) ?? "",
          })),
          labels: labelRows.map((row) => ({
            businessId: text(row.business_id) ?? "",
            accountId: text(row.provider_account_id),
            campaignId: text(row.campaign_id) ?? "",
            campaignKind: text(row.campaign_kind) ?? "",
            labeledAtDate: day(row.labeled_at_date),
            updatedAtDate: day(row.updated_at_date),
            source: text(row.source),
          })),
          campaignStateRows: campaignStateRows.map((row) => ({
            businessId: text(row.business_id) ?? "",
            accountId: text(row.provider_account_id) ?? "",
            campaignId: text(row.campaign_id) ?? "",
            capturedDate: day(row.captured_date) ?? "",
            configuredStatus: text(row.configured_status),
            effectiveStatus: text(row.effective_status),
            presence: text(row.presence) ?? "",
            campaignDailyBudgetRaw: numOrNull(row.campaign_daily_budget_raw),
          })),
          adsetDailyRows: adsetDailyRows.map((row) => ({
            businessId: text(row.business_id) ?? "",
            accountId: text(row.provider_account_id) ?? "",
            campaignId: text(row.campaign_id) ?? "",
            capturedDate: day(row.captured_date) ?? "",
            activeAdsets: num(row.active_adsets),
            presentAdsets: num(row.present_adsets),
            activeAdsetBudgetSum: numOrNull(row.active_adset_budget_sum),
          })),
        };
      }),
  );

  const sections = {
    businesses: sha256(bundle.businesses),
    creativeRows: sha256(bundle.creativeRows),
    nameRows: sha256(bundle.nameRows),
    firstSeenRows: sha256(bundle.firstSeenRows),
    labels: sha256(bundle.labels),
    campaignStateRows: sha256(bundle.campaignStateRows),
    adsetDailyRows: sha256(bundle.adsetDailyRows),
  };
  const artifact = {
    contract: H11B_BUNDLE_CONTRACT_VERSION,
    businessNames: H11B_BUSINESS_NAMES,
    evalStart: H11B_EVAL_START,
    evalEnd: H11B_EVAL_END,
    sourceStart: SOURCE_START,
    counts: Object.fromEntries(
      Object.entries(bundle).map(([key, value]) => [key, value.length]),
    ),
    sectionHashes: sections,
    bundleHash: sha256(sections),
    ...bundle,
  };

  const outPath = resolve(JSON_OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(artifact));
  console.log(
    `[h11b-bundle] frozen: ${JSON.stringify({ counts: artifact.counts, bundleHash: artifact.bundleHash })}`,
  );
  console.log(`[h11b-bundle] wrote ${JSON_OUT}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
