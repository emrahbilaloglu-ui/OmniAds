import { getDb, runDbTransaction } from "@/lib/db";
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

interface MetaCampaignLabelHistoryDbRow extends MetaCampaignLabelDbRow {
  change_kind: "created" | "updated";
  observed_at: string;
  state_hash: string;
}

interface MetaAssignedAccountDbRow {
  business_ref_id: string;
  provider_account_ref_id: string | null;
  provider_account_id: string | null;
}

export interface MetaCampaignLabelHistoryState extends MetaCampaignLabel {
  changeKind: "created" | "updated";
  observedAt: string;
  stateHash: string;
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
    input.kind === "test" &&
    rawDimension &&
    isMetaCampaignTestDimension(rawDimension)
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

export async function writeMetaCampaignLabels(input: {
  businessId: string;
  labeledBy: string | null;
  labels: MetaCampaignLabelInput[];
}): Promise<MetaCampaignLabel[]> {
  const labelsByCampaign = new Map<string, NormalizedLabelInput>();
  for (const rawLabel of input.labels) {
    const label = normalizeMetaCampaignLabelInput(rawLabel);
    labelsByCampaign.delete(label.campaignId);
    labelsByCampaign.set(label.campaignId, label);
  }
  const normalized = Array.from(labelsByCampaign.values());
  if (normalized.length === 0) return [];

  const businessId = nonEmptyString(input.businessId);
  if (!businessId) throw new Error("businessId is required.");

  return runDbTransaction(async () => {
    const sql = getDb();
    const assignedRows = (await sql`
      SELECT
        business.id::text AS business_ref_id,
        assignment.provider_account_ref_id::text AS provider_account_ref_id,
        assignment.provider_account_id
      FROM businesses business
      LEFT JOIN business_provider_accounts assignment
        ON assignment.business_id = business.id::text
       AND assignment.provider = 'meta'
      WHERE business.id::text = ${businessId}
    `) as MetaAssignedAccountDbRow[];
    const businessRefId = assignedRows[0]?.business_ref_id;
    if (!businessRefId) throw new Error("Business does not exist.");
    const assignedAccountIds = new Set(
      assignedRows
        .map((row) => row.provider_account_id)
        .filter((value): value is string => value != null),
    );
    const accountRefByExternalId = new Map(
      assignedRows.flatMap((row) =>
        row.provider_account_id && row.provider_account_ref_id
          ? [[row.provider_account_id, row.provider_account_ref_id] as const]
          : [],
      ),
    );
    for (const campaignId of normalized
      .map((label) => label.campaignId)
      .sort()) {
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`meta_campaign_label:${businessId}:${campaignId}`}, 0)
        )
      `;
    }

    const written: MetaCampaignLabel[] = [];
    for (const label of normalized) {
      const existingRows = (await sql`
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
        WHERE business_id = ${businessId}
          AND campaign_id = ${label.campaignId}
        FOR UPDATE
      `) as MetaCampaignLabelDbRow[];
      const previous = existingRows[0] ?? null;
      const nextProviderAccountId =
        label.providerAccountId ?? previous?.provider_account_id ?? null;
      if (
        nextProviderAccountId != null &&
        !assignedAccountIds.has(nextProviderAccountId)
      ) {
        throw new Error("providerAccountId is not assigned to this business.");
      }
      const nextProviderAccountRefId = nextProviderAccountId
        ? (accountRefByExternalId.get(nextProviderAccountId) ?? null)
        : null;
      const nextCampaignName =
        label.campaignName ?? previous?.campaign_name ?? null;
      const changed =
        previous == null ||
        previous.provider_account_id !== nextProviderAccountId ||
        previous.campaign_name !== nextCampaignName ||
        previous.campaign_kind !== label.kind ||
        previous.test_dimension !== label.testDimension ||
        previous.source !== label.source;

      if (!changed && previous) {
        written.push(mapLabelRow(previous));
        continue;
      }

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
          ${businessId},
          ${label.campaignId},
          ${nextProviderAccountId},
          ${nextCampaignName},
          ${label.kind},
          ${label.testDimension},
          ${label.source},
          ${input.labeledBy},
          now(),
          now()
        )
        ON CONFLICT (business_id, campaign_id) DO UPDATE SET
          provider_account_id = EXCLUDED.provider_account_id,
          campaign_name = EXCLUDED.campaign_name,
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
      const next = rows[0];
      if (!next) {
        throw new Error(
          `Campaign label write returned no row for ${label.campaignId}.`,
        );
      }

      await sql`
        INSERT INTO meta_campaign_label_history (
          business_ref_id,
          business_id,
          campaign_id,
          provider_account_ref_id,
          provider_account_id,
          campaign_name,
          campaign_kind,
          test_dimension,
          source,
          previous_provider_account_id,
          previous_campaign_name,
          previous_campaign_kind,
          previous_test_dimension,
          previous_source,
          labeled_by,
          change_kind,
          observed_at,
          state_hash
        ) VALUES (
          ${businessRefId},
          ${next.business_id},
          ${next.campaign_id},
          ${nextProviderAccountRefId},
          ${next.provider_account_id},
          ${next.campaign_name},
          ${next.campaign_kind},
          ${next.test_dimension},
          ${next.source},
          ${previous?.provider_account_id ?? null},
          ${previous?.campaign_name ?? null},
          ${previous?.campaign_kind ?? null},
          ${previous?.test_dimension ?? null},
          ${previous?.source ?? null},
          ${next.labeled_by},
          ${previous ? "updated" : "created"},
          now(),
          encode(
            digest(
              convert_to(
                jsonb_build_object(
                  'contractVersion', 'meta-campaign-label-history.v1',
                  'businessId', ${next.business_id}::text,
                  'campaignId', ${next.campaign_id}::text,
                  'providerAccountId', ${next.provider_account_id}::text,
                  'campaignName', ${next.campaign_name}::text,
                  'campaignKind', ${next.campaign_kind}::text,
                  'testDimension', ${next.test_dimension}::text,
                  'source', ${next.source}::text
                )::text,
                'UTF8'
              ),
              'sha256'
            ),
            'hex'
          )
        )
      `;
      written.push(mapLabelRow(next));
    }
    return written;
  });
}
