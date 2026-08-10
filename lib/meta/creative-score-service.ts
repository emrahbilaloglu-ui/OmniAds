import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import type { AiCreativeHistoricalWindows } from "@/lib/meta/creative-scoring";

/**
 * Historical compatibility reader only.
 *
 * `meta_creative_score_snapshots` predates the canonical native-ad decision
 * authority. Active routes must not use these labels as buyer actions and this
 * module intentionally contains no refresh, scoring, INSERT, or UPDATE path.
 */
export const META_CREATIVE_SCORE_RULE_VERSION = "meta-creative-score-v1";
const META_CREATIVE_SCORE_TABLES = ["meta_creative_score_snapshots"] as const;

type CreativeScoreFreshnessState = "fresh" | "stale";

type CreativeScoreSnapshotRow = {
  creative_id: string;
  window_metrics: AiCreativeHistoricalWindows;
  selected_row_json: MetaCreativeRow;
  weighted_score: number | null;
  label: string | null;
  computed_at: string;
  freshness_state: CreativeScoreFreshnessState;
  rule_version: string;
};

export interface HistoricalMetaCreativeScoreSnapshot {
  selectedRows: MetaCreativeRow[];
  historyById: Map<string, AiCreativeHistoricalWindows>;
  historicalScoresById: Map<
    string,
    { weightedScore: number | null; label: string | null }
  >;
  computedAt: string;
  freshnessState: CreativeScoreFreshnessState;
  ruleVersion: string;
}

function parseHistoricalSnapshotRows(
  rows: CreativeScoreSnapshotRow[],
): HistoricalMetaCreativeScoreSnapshot {
  const historyById = new Map<string, AiCreativeHistoricalWindows>();
  const historicalScoresById = new Map<
    string,
    { weightedScore: number | null; label: string | null }
  >();

  const selectedRows = rows
    .map((row) => {
      historyById.set(row.creative_id, row.window_metrics ?? {});
      historicalScoresById.set(row.creative_id, {
        weightedScore: row.weighted_score,
        label: row.label,
      });
      return row.selected_row_json;
    })
    .sort((a, b) => b.spend - a.spend);

  return {
    selectedRows,
    historyById,
    historicalScoresById,
    computedAt: rows.reduce(
      (latest, row) => (row.computed_at > latest ? row.computed_at : latest),
      rows[0]?.computed_at ?? new Date(0).toISOString(),
    ),
    freshnessState: rows.some((row) => row.freshness_state === "stale")
      ? "stale"
      : "fresh",
    ruleVersion: rows[0]?.rule_version ?? META_CREATIVE_SCORE_RULE_VERSION,
  };
}

export async function readHistoricalCreativeScoreSnapshot(input: {
  businessId: string;
  selectedStartDate: string;
  selectedEndDate: string;
  ruleVersion?: string;
}): Promise<HistoricalMetaCreativeScoreSnapshot | null> {
  const readiness = await getDbSchemaReadiness({
    tables: [...META_CREATIVE_SCORE_TABLES],
  }).catch(() => null);
  if (!readiness?.ready) return null;

  const sql = getDb();
  const rows = (await sql`
    SELECT
      creative_id,
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
      AND rule_version = ${input.ruleVersion ?? META_CREATIVE_SCORE_RULE_VERSION}
      AND as_of_date = ${input.selectedEndDate}
  `) as CreativeScoreSnapshotRow[];

  return rows.length > 0 ? parseHistoricalSnapshotRows(rows) : null;
}

export function buildCreativeHistoryByIdFromSnapshot(
  rows: Array<{
    creativeId: string;
    windowMetrics: AiCreativeHistoricalWindows;
  }>,
) {
  return new Map(rows.map((row) => [row.creativeId, row.windowMetrics]));
}
