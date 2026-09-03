// D074 — FROZEN, READ-ONLY HISTORICAL COMPARATOR MODULE.
//
// The manual campaign-label product — including its write implementation — is
// removed. `meta_campaign_labels` / `meta_campaign_label_history` are frozen
// historical evidence; this module exposes ONLY the SELECT-based comparator
// reads that replay/evaluation scripts need. It must never contain a mutation:
// no INSERT/UPDATE/DELETE against either table, no `runDbTransaction` import,
// and no exported writer. It may be imported ONLY by:
//   - replay/simulation/seam scripts under `scripts/`, and
//   - its own tests and type-only consumers of the deserialization shapes.
// No live route, decision producer, read model, or UI component may import it.
// `lib/meta/__tests__/campaign-labels-isolation.test.ts` enforces every one of
// these boundaries statically. Runtime campaign role comes exclusively from
// `readCampaignContextMap` (engine_v3_campaign_context_daily).
import { getDb } from "@/lib/db";
import {
  type MetaCampaignKind,
  type MetaCampaignLabel,
  type MetaCampaignLabelSource,
  type MetaCampaignTestDimension,
} from "@/lib/meta/campaign-label-types";

export {
  META_CAMPAIGN_KINDS,
  META_CAMPAIGN_LABEL_SOURCES,
  META_CAMPAIGN_TEST_DIMENSIONS,
  isMetaCampaignKind,
  isMetaCampaignLabelSource,
  isMetaCampaignTestDimension,
  labelKindDisplay,
  testDimensionDisplay,
  type MetaCampaignKind,
  type MetaCampaignLabel,
  type MetaCampaignLabelInput,
  type MetaCampaignLabelSource,
  type MetaCampaignTestDimension,
} from "@/lib/meta/campaign-label-types";

interface MetaCampaignLabelDbRow {
  business_id: string;
  campaign_id: string;
  campaign_kind: MetaCampaignKind;
  test_dimension: MetaCampaignTestDimension | null;
  source: MetaCampaignLabelSource;
  provider_account_id: string | null;
  campaign_name: string | null;
  labeled_by: string | null;
  labeled_at: string;
  updated_at: string;
}

interface MetaCampaignLabelHistoryDbRow extends MetaCampaignLabelDbRow {
  change_kind: "created" | "updated";
  observed_at: string;
  state_hash: string;
}

export interface MetaCampaignLabelHistoryState extends MetaCampaignLabel {
  changeKind: "created" | "updated";
  observedAt: string;
  stateHash: string;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mapLabelRow(row: MetaCampaignLabelDbRow): MetaCampaignLabel {
  return {
    businessId: row.business_id,
    campaignId: row.campaign_id,
    kind: row.campaign_kind,
    testDimension: row.test_dimension,
    source: row.source,
    providerAccountId: row.provider_account_id,
    campaignName: row.campaign_name,
    labeledBy: row.labeled_by,
    labeledAt: row.labeled_at,
    updatedAt: row.updated_at,
  };
}

function mapLabelHistoryRow(
  row: MetaCampaignLabelHistoryDbRow,
): MetaCampaignLabelHistoryState {
  return {
    ...mapLabelRow(row),
    changeKind: row.change_kind,
    observedAt: row.observed_at,
    stateHash: row.state_hash,
  };
}

function normalizeCutoff(value: string | Date) {
  const parsed =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("cutoff must be a valid timestamp.");
  }
  return parsed.toISOString();
}


export async function readMetaCampaignLabels(input: {
  businessId: string;
  campaignIds?: string[] | null;
}): Promise<MetaCampaignLabel[]> {
  const sql = getDb();
  const campaignIds = Array.from(
    new Set((input.campaignIds ?? []).map((id) => id.trim()).filter(Boolean)),
  );
  const rows =
    campaignIds.length > 0
      ? ((await sql`
        SELECT
          business_id,
          campaign_id,
          campaign_kind,
          test_dimension,
          source,
          provider_account_id,
          campaign_name,
          labeled_by,
          labeled_at::text AS labeled_at,
          updated_at::text AS updated_at
        FROM meta_campaign_labels
        WHERE business_id = ${input.businessId}
          AND campaign_id = ANY(${campaignIds}::text[])
        ORDER BY updated_at DESC
      `) as MetaCampaignLabelDbRow[])
      : ((await sql`
        SELECT
          business_id,
          campaign_id,
          campaign_kind,
          test_dimension,
          source,
          provider_account_id,
          campaign_name,
          labeled_by,
          labeled_at::text AS labeled_at,
          updated_at::text AS updated_at
        FROM meta_campaign_labels
        WHERE business_id = ${input.businessId}
        ORDER BY updated_at DESC
      `) as MetaCampaignLabelDbRow[]);
  return rows.map(mapLabelRow);
}

export async function readMetaCampaignLabelsAsOf(input: {
  businessId: string;
  providerAccountId: string;
  cutoff: string | Date;
  campaignIds?: string[] | null;
}): Promise<MetaCampaignLabelHistoryState[]> {
  const businessId = nonEmptyString(input.businessId);
  const providerAccountId = nonEmptyString(input.providerAccountId);
  if (!businessId) throw new Error("businessId is required.");
  if (!providerAccountId) throw new Error("providerAccountId is required.");

  const cutoff = normalizeCutoff(input.cutoff);
  const campaignIds = Array.from(
    new Set((input.campaignIds ?? []).map((id) => id.trim()).filter(Boolean)),
  );
  const sql = getDb();
  const rows =
    campaignIds.length > 0
      ? ((await sql`
        SELECT DISTINCT ON (campaign_id)
          business_id,
          campaign_id,
          campaign_kind,
          test_dimension,
          source,
          provider_account_id,
          campaign_name,
          labeled_by,
          observed_at::text AS labeled_at,
          observed_at::text AS updated_at,
          change_kind,
          observed_at::text AS observed_at,
          state_hash
        FROM meta_campaign_label_history
        WHERE business_id = ${businessId}
          AND provider_account_id = ${providerAccountId}
          AND campaign_id = ANY(${campaignIds}::text[])
          AND observed_at <= ${cutoff}::timestamptz
        ORDER BY campaign_id, observed_at DESC, created_at DESC, id DESC
      `) as MetaCampaignLabelHistoryDbRow[])
      : ((await sql`
        SELECT DISTINCT ON (campaign_id)
          business_id,
          campaign_id,
          campaign_kind,
          test_dimension,
          source,
          provider_account_id,
          campaign_name,
          labeled_by,
          observed_at::text AS labeled_at,
          observed_at::text AS updated_at,
          change_kind,
          observed_at::text AS observed_at,
          state_hash
        FROM meta_campaign_label_history
        WHERE business_id = ${businessId}
          AND provider_account_id = ${providerAccountId}
          AND observed_at <= ${cutoff}::timestamptz
        ORDER BY campaign_id, observed_at DESC, created_at DESC, id DESC
      `) as MetaCampaignLabelHistoryDbRow[]);
  return rows.map(mapLabelHistoryRow);
}
