import { getDb } from "@/lib/db";
import {
  isMetaCampaignKind,
  isMetaCampaignLabelSource,
  isMetaCampaignTestDimension,
  type MetaCampaignKind,
  type MetaCampaignLabel,
  type MetaCampaignLabelInput,
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

interface NormalizedLabelInput {
  campaignId: string;
  kind: MetaCampaignKind;
  testDimension: MetaCampaignTestDimension | null;
  source: MetaCampaignLabelSource;
  providerAccountId: string | null;
  campaignName: string | null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableString(value: unknown) {
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

export function normalizeMetaCampaignLabelInput(
  input: MetaCampaignLabelInput,
): NormalizedLabelInput {
  const campaignId = nonEmptyString(input.campaignId);
  if (!campaignId) {
    throw new Error("campaignId is required.");
  }
  if (!isMetaCampaignKind(input.kind)) {
    throw new Error("kind must be main, test or mixed.");
  }

  const source =
    input.source && isMetaCampaignLabelSource(input.source)
      ? input.source
      : "user";
  const rawDimension = input.testDimension ?? null;
  const testDimension =
    input.kind === "test" && rawDimension && isMetaCampaignTestDimension(rawDimension)
      ? rawDimension
      : null;
  if (input.kind === "test" && rawDimension && !testDimension) {
    throw new Error("testDimension is invalid.");
  }

  return {
    campaignId,
    kind: input.kind,
    testDimension,
    source,
    providerAccountId: nullableString(input.providerAccountId),
    campaignName: nullableString(input.campaignName),
  };
}

export async function readMetaCampaignLabels(input: {
  businessId: string;
  campaignIds?: string[] | null;
}): Promise<MetaCampaignLabel[]> {
  const sql = getDb();
  const campaignIds = Array.from(
    new Set((input.campaignIds ?? []).map((id) => id.trim()).filter(Boolean)),
  );
  const rows = campaignIds.length > 0
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

export async function writeMetaCampaignLabels(input: {
  businessId: string;
  labeledBy: string | null;
  labels: MetaCampaignLabelInput[];
}): Promise<MetaCampaignLabel[]> {
  const normalized = input.labels.map(normalizeMetaCampaignLabelInput);
  if (normalized.length === 0) return [];

  const sql = getDb();
  const written: MetaCampaignLabel[] = [];
  for (const label of normalized) {
    const rows = (await sql`
      INSERT INTO meta_campaign_labels (
        business_id,
        campaign_id,
        provider_account_id,
        campaign_name,
        campaign_kind,
        test_dimension,
        source,
        labeled_by,
        labeled_at,
        updated_at
      ) VALUES (
        ${input.businessId},
        ${label.campaignId},
        ${label.providerAccountId},
        ${label.campaignName},
        ${label.kind},
        ${label.testDimension},
        ${label.source},
        ${input.labeledBy},
        now(),
        now()
      )
      ON CONFLICT (business_id, campaign_id) DO UPDATE SET
        provider_account_id = COALESCE(EXCLUDED.provider_account_id, meta_campaign_labels.provider_account_id),
        campaign_name = COALESCE(EXCLUDED.campaign_name, meta_campaign_labels.campaign_name),
        campaign_kind = EXCLUDED.campaign_kind,
        test_dimension = EXCLUDED.test_dimension,
        source = EXCLUDED.source,
        labeled_by = EXCLUDED.labeled_by,
        updated_at = now()
      RETURNING
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
    `) as MetaCampaignLabelDbRow[];
    if (rows[0]) written.push(mapLabelRow(rows[0]));
  }
  return written;
}
