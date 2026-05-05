import { NextRequest } from "next/server";
import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";
import { mapApiRowToUiRow } from "@/app/(dashboard)/creatives/page-support";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import {
  ensureProviderAccountReferenceIds,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";
import {
  scoreMetaCreativeRows,
  type AiCreativeHistoricalWindow,
  type AiCreativeHistoricalWindows,
} from "@/lib/meta/creative-scoring";

export const META_CREATIVE_SCORE_RULE_VERSION = "meta-creative-score-v1";
const META_CREATIVE_SCORE_TABLES = ["meta_creative_score_snapshots"] as const;

type CreativeHistoryWindowKey =
  | "last3"
  | "last7"
  | "last14"
  | "last30"
  | "last90"
  | "allHistory";

type CreativeScoreFreshnessState = "fresh" | "stale";

type CreativeScoreSnapshotRow = {
  business_id: string;
  provider_account_id: string;
  creative_id: string;
  as_of_date: string;
  selected_start_date: string;
  selected_end_date: string;
  window_metrics: AiCreativeHistoricalWindows;
  selected_row_json: MetaCreativeRow;
  weighted_score: number | null;
  label: string | null;
  computed_at: string;
  freshness_state: CreativeScoreFreshnessState;
  rule_version: string;
};

export interface MetaCreativeScoreSnapshotPayload {
  selectedRows: MetaCreativeRow[];
  historyById: Map<string, AiCreativeHistoricalWindows>;
  decisionsById: Map<string, { weightedScore: number | null; label: string | null }>;
  computedAt: string;
  freshnessState: CreativeScoreFreshnessState;
  ruleVersion: string;
}

const inflightRefreshes = new Map<string, Promise<MetaCreativeScoreSnapshotPayload>>();

function parseISODate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDaysToISO(value: string, days: number): string {
  const date = parseISODate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDiffInclusive(startDate: string, endDate: string): number {
  const start = parseISODate(startDate).getTime();
  const end = parseISODate(endDate).getTime();
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
}

function getCacheTtlMs(startDate: string, endDate: string) {
  const spanDays = dayDiffInclusive(startDate, endDate);
  if (spanDays <= 7) return 10 * 60_000;
  if (spanDays <= 30) return 30 * 60_000;
  if (spanDays <= 90) return 2 * 60 * 60_000;
  return 12 * 60 * 60_000;
}

function toHistoricalWindow(row: MetaCreativeRow): AiCreativeHistoricalWindow {
  return {
    spend: row.spend,
    purchaseValue: row.purchaseValue,
    roas: row.roas,
    cpa: row.cpa,
    ctr: row.ctrAll,
    purchases: row.purchases,
    impressions: row.impressions,
    linkClicks: row.linkClicks,
    hookRate: row.thumbstop,
    holdRate: row.video100,
    video25Rate: row.video25,
    watchRate: row.video50,
    video75Rate: row.video75,
    clickToPurchaseRate: row.clickToPurchase,
    atcToPurchaseRate: row.atcToPurchaseRatio,
  };
}

function buildHistoryById(input: Partial<Record<CreativeHistoryWindowKey, MetaCreativeRow[]>>) {
  const map = new Map<string, AiCreativeHistoricalWindows>();
  const windowKeys = Object.keys(input) as CreativeHistoryWindowKey[];
  for (const windowKey of windowKeys) {
    const rows = input[windowKey] ?? [];
    for (const row of rows) {
      const existing = map.get(row.id) ?? {};
      existing[windowKey] = toHistoricalWindow(row);
      map.set(row.id, existing);
    }
  }
  return map;
}

function buildWindowRanges(endDate: string) {
  return {
    last3: { start: addDaysToISO(endDate, -2), end: endDate },
    last7: { start: addDaysToISO(endDate, -6), end: endDate },
    last14: { start: addDaysToISO(endDate, -13), end: endDate },
    last30: { start: addDaysToISO(endDate, -29), end: endDate },
    last90: { start: addDaysToISO(endDate, -89), end: endDate },
    allHistory: { start: addDaysToISO(endDate, -364), end: endDate },
  } satisfies Record<CreativeHistoryWindowKey, { start: string; end: string }>;
}

async function fetchCreativeRows(input: {
  request: NextRequest;
  businessId: string;
  start: string;
  end: string;
}) {
  const payload = await getMetaCreativesApiPayload({
    request: input.request,
    requestStartedAt: Date.now(),
    businessId: input.businessId,
    mediaMode: "metadata",
    groupBy: "creative",
    format: "all",
    sort: "spend",
    start: input.start,
    end: input.end,
    debugPreview: false,
    debugThumbnail: false,
    debugPerf: false,
    snapshotBypass: false,
    snapshotWarm: false,
    enableCopyRecovery: false,
    enableCreativeBasicsFallback: false,
    enableCreativeDetails: false,
    enableThumbnailBackfill: false,
    enableCardThumbnailBackfill: false,
    enableImageHashLookup: false,
    enableMediaRecovery: false,
    enableMediaCache: true,
    enableDeepAudit: false,
    perAccountSampleLimit: 10,
  });
  return ((payload.rows ?? []) as MetaCreativeApiRow[]).map(mapApiRowToUiRow);
}

function buildDecisionCacheRows(selectedRows: MetaCreativeRow[], historyById: Map<string, AiCreativeHistoricalWindows>) {
  const decisions = scoreMetaCreativeRows(selectedRows, historyById);
  return new Map(decisions.map((decision) => [decision.creativeId, decision]));
}

function parseSnapshotRows(rows: CreativeScoreSnapshotRow[]): MetaCreativeScoreSnapshotPayload {
  const historyById = new Map<string, AiCreativeHistoricalWindows>();
  const decisionsById = new Map<string, { weightedScore: number | null; label: string | null }>();

  const selectedRows = rows
    .map((row) => {
      historyById.set(row.creative_id, row.window_metrics ?? {});
      decisionsById.set(row.creative_id, {
        weightedScore: row.weighted_score,
        label: row.label,
      });
      return row.selected_row_json;
    })
    .sort((a, b) => b.spend - a.spend);

  const latestComputedAt = rows.reduce(
    (latest, row) => (row.computed_at > latest ? row.computed_at : latest),
    rows[0]?.computed_at ?? new Date(0).toISOString()
  );
  const freshnessState =
    rows.some((row) => row.freshness_state === "stale") ? "stale" : "fresh";

  return {
    selectedRows,
    historyById,
    decisionsById,
    computedAt: latestComputedAt,
    freshnessState,
    ruleVersion: rows[0]?.rule_version ?? META_CREATIVE_SCORE_RULE_VERSION,
  };
}

async function readScoreRows(input: {
  businessId: string;
  selectedStartDate: string;
  selectedEndDate: string;
  ruleVersion: string;
}) {
  const readiness = await getDbSchemaReadiness({
    tables: [...META_CREATIVE_SCORE_TABLES],
  }).catch(() => null);
  if (!readiness?.ready) {
    return [];
  }
  const sql = getDb();
  return (await sql`
    SELECT
      business_id,
      provider_account_id,
      creative_id,
      as_of_date,
      selected_start_date,
      selected_end_date,
      window_metrics,
      selected_row_json,
      weighted_score,
      label,
      computed_at,
      freshness_state,
      rule_version
    FROM meta_creative_score_snapshots
    WHERE business_id = ${input.businessId}
      AND selected_start_date = ${input.selectedStartDate}
      AND selected_end_date = ${input.selectedEndDate}
      AND rule_version = ${input.ruleVersion}
      AND as_of_date = ${input.selectedEndDate}
  `) as CreativeScoreSnapshotRow[];
}

async function writeScoreRows(input: {
  businessId: string;
  selectedStartDate: string;
  selectedEndDate: string;
  selectedRows: MetaCreativeRow[];
  historyById: Map<string, AiCreativeHistoricalWindows>;
  computedAt: string;
  freshnessState: CreativeScoreFreshnessState;
  ruleVersion: string;
}) {
  const readiness = await getDbSchemaReadiness({
    tables: [...META_CREATIVE_SCORE_TABLES],
  }).catch(() => null);
  const sql = getDb();
  const decisionsById = buildDecisionCacheRows(input.selectedRows, input.historyById);
  const businessRefIds = await resolveBusinessReferenceIds([input.businessId]);
  const businessRefId = businessRefIds.get(input.businessId) ?? null;
  const providerAccountIds = Array.from(
    new Set(
      input.selectedRows
        .map((row) => row.accountId ?? null)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const providerAccountRefIds =
    providerAccountIds.length > 0
      ? await ensureProviderAccountReferenceIds({
          provider: "meta",
          accounts: providerAccountIds.map((externalAccountId) => ({
            externalAccountId,
          })),
        })
      : new Map<string, string>();

  if (!readiness?.ready) {
    return decisionsById;
  }

  await Promise.all(
    input.selectedRows.map((row) => {
      const decision = decisionsById.get(row.id);
      const providerAccountId = row.accountId ?? "__unknown__";
      const providerAccountRefId = row.accountId
        ? (providerAccountRefIds.get(row.accountId) ?? null)
        : null;
      return sql`
        INSERT INTO meta_creative_score_snapshots (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          creative_id,
          as_of_date,
          selected_start_date,
          selected_end_date,
          window_metrics,
          selected_row_json,
          weighted_score,
          label,
          computed_at,
          freshness_state,
          rule_version
        )
        VALUES (
          ${input.businessId},
          ${businessRefId},
          ${providerAccountId},
          ${providerAccountRefId},
          ${row.id},
          ${input.selectedEndDate},
          ${input.selectedStartDate},
          ${input.selectedEndDate},
          ${JSON.stringify(input.historyById.get(row.id) ?? {})}::jsonb,
          ${JSON.stringify(row)}::jsonb,
          ${decision?.score ?? null},
          ${decision?.action ?? null},
          ${input.computedAt},
          ${input.freshnessState},
          ${input.ruleVersion}
        )
        ON CONFLICT (business_id, provider_account_id, creative_id, as_of_date, selected_start_date, selected_end_date, rule_version)
        DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_creative_score_snapshots.business_ref_id),
          provider_account_ref_id = COALESCE(
            EXCLUDED.provider_account_ref_id,
            meta_creative_score_snapshots.provider_account_ref_id
          ),
          window_metrics = EXCLUDED.window_metrics,
          selected_row_json = EXCLUDED.selected_row_json,
          weighted_score = EXCLUDED.weighted_score,
          label = EXCLUDED.label,
          computed_at = EXCLUDED.computed_at,
          freshness_state = EXCLUDED.freshness_state
      `;
    })
  );

  return decisionsById;
}

export async function refreshCreativeScoreSnapshot(input: {
  request: NextRequest;
  businessId: string;
  selectedStartDate: string;
  selectedEndDate: string;
  ruleVersion?: string;
}): Promise<MetaCreativeScoreSnapshotPayload> {
  const ranges = buildWindowRanges(input.selectedEndDate);
  const [selectedRows, last3Rows, last7Rows, last14Rows, last30Rows, last90Rows, allHistoryRows] =
    await Promise.all([
      fetchCreativeRows({
        request: input.request,
        businessId: input.businessId,
        start: input.selectedStartDate,
        end: input.selectedEndDate,
      }),
      fetchCreativeRows({ request: input.request, businessId: input.businessId, ...ranges.last3 }),
      fetchCreativeRows({ request: input.request, businessId: input.businessId, ...ranges.last7 }),
      fetchCreativeRows({ request: input.request, businessId: input.businessId, ...ranges.last14 }),
      fetchCreativeRows({ request: input.request, businessId: input.businessId, ...ranges.last30 }),
      fetchCreativeRows({ request: input.request, businessId: input.businessId, ...ranges.last90 }),
      fetchCreativeRows({ request: input.request, businessId: input.businessId, ...ranges.allHistory }),
    ]);

  const historyById = buildHistoryById({
    last3: last3Rows,
    last7: last7Rows,
    last14: last14Rows,
    last30: last30Rows,
    last90: last90Rows,
    allHistory: allHistoryRows,
  });
  const computedAt = new Date().toISOString();
  const ruleVersion = input.ruleVersion ?? META_CREATIVE_SCORE_RULE_VERSION;
  const decisionsById = await writeScoreRows({
    businessId: input.businessId,
    selectedStartDate: input.selectedStartDate,
    selectedEndDate: input.selectedEndDate,
    selectedRows,
    historyById,
    computedAt,
    freshnessState: "fresh",
    ruleVersion,
  });

  return {
    selectedRows,
    historyById,
    decisionsById: new Map(
      Array.from(decisionsById.entries()).map(([creativeId, decision]) => [
        creativeId,
        { weightedScore: decision.score ?? null, label: decision.action ?? null },
      ])
    ),
    computedAt,
    freshnessState: "fresh",
    ruleVersion,
  };
}

export async function getCreativeScoreSnapshot(input: {
  request: NextRequest;
  businessId: string;
  selectedStartDate: string;
  selectedEndDate: string;
  ruleVersion?: string;
}): Promise<MetaCreativeScoreSnapshotPayload> {
  const ruleVersion = input.ruleVersion ?? META_CREATIVE_SCORE_RULE_VERSION;
  const cacheKey = [
    input.businessId,
    input.selectedStartDate,
    input.selectedEndDate,
    ruleVersion,
  ].join(":");

  const refresh = async () =>
    refreshCreativeScoreSnapshot({
      request: input.request,
      businessId: input.businessId,
      selectedStartDate: input.selectedStartDate,
      selectedEndDate: input.selectedEndDate,
      ruleVersion,
    });

  const cachedRows = await readScoreRows({
    businessId: input.businessId,
    selectedStartDate: input.selectedStartDate,
    selectedEndDate: input.selectedEndDate,
    ruleVersion,
  });

  if (cachedRows.length === 0) {
    const inflight = inflightRefreshes.get(cacheKey);
    if (inflight) return inflight;
    const next = refresh().finally(() => inflightRefreshes.delete(cacheKey));
    inflightRefreshes.set(cacheKey, next);
    return next;
  }

  const payload = parseSnapshotRows(cachedRows);
  const ageMs = Date.now() - new Date(payload.computedAt).getTime();
  if (ageMs <= getCacheTtlMs(input.selectedStartDate, input.selectedEndDate)) {
    return payload;
  }

  if (!inflightRefreshes.has(cacheKey)) {
    const next = refresh().finally(() => inflightRefreshes.delete(cacheKey));
    inflightRefreshes.set(cacheKey, next);
  }

  return {
    ...payload,
    freshnessState: "stale",
  };
}

export function buildCreativeHistoryByIdFromSnapshot(
  rows: Array<{ creativeId: string; windowMetrics: AiCreativeHistoricalWindows }>
) {
  return new Map(rows.map((row) => [row.creativeId, row.windowMetrics]));
}
