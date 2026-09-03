// Campaign context source resolution (D033, D074).
//
// Runtime campaign role has one authority: account-scoped system inference in
// engine_v3_campaign_context_daily. Historical meta_campaign_labels rows are
// migration/evaluation evidence only and are never read here. The only runtime
// switch left is the fail-closed `unknown` circuit breaker.
import { getDb } from "@/lib/db";
import {
  type CreativeCampaignContextEntry,
  type CreativeCampaignContextTrust,
} from "../campaign-label-guard";
import {
  canonicalSha256,
  type CampaignContextProvenance,
} from "../canonical-evaluation";
import {
  CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  type CampaignKind,
  type ContextConfidenceClass,
} from "./resolver";

export type CampaignContextMode = "legacy_labels" | "automatic" | "unknown";

export const CAMPAIGN_CONTEXT_MODE_ENV = "CAMPAIGN_CONTEXT_MODE";
export const CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV =
  "CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION";

// Persisted context older than this many days (vs asOf) is treated as
// unresolved rather than trusted: stale automatic context must not drive
// kind semantics.
export const CAMPAIGN_CONTEXT_MAX_AGE_DAYS = 2;

export function resolveCampaignContextMode(): CampaignContextMode {
  const raw = process.env[CAMPAIGN_CONTEXT_MODE_ENV]?.trim().toLowerCase();
  if (raw === "unknown") return "unknown";
  // `legacy_labels` is intentionally treated as automatic. Keeping the parser
  // value in the public type preserves old snapshot deserialization, but the
  // manual label table can no longer become runtime authority via env rollback.
  return "automatic";
}

export function isCampaignContextResolverAuthorityValidated(
  resolverVersion: string | null | undefined,
) {
  const approvedVersion = campaignContextAuthorityResolverVersion();
  return Boolean(approvedVersion && resolverVersion === approvedVersion);
}

export function campaignContextAuthorityResolverVersion(): string | null {
  const approvedVersion = process.env[
    CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV
  ]?.trim();
  return approvedVersion === CAMPAIGN_CONTEXT_RESOLVER_VERSION
    ? approvedVersion
    : null;
}

type Row = Record<string, unknown>;

// Authority-bearing provenance columns are compared byte-for-byte, so they are
// read raw: no trim, no case fold, no String() coercion, no empty-to-null
// collapse. A non-string persisted value cannot equal an approved identity, so
// it fails closed as null rather than being stringified into a near-match.
function rawText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value === null || value === undefined) return null;
  return String(value);
}

function toIsoTimestamp(value: unknown): string | null {
  const text = toText(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

interface PersistedContextRow {
  providerAccountId: string;
  campaignId: string;
  inferredKind: CampaignKind | null;
  confidenceClass: ContextConfidenceClass;
  // Raw persisted provenance. These two are deliberately NOT passed through
  // toText(): authority is byte-for-byte, so trimming or coercing here would
  // let " system_inferred" and a whitespace-padded resolver version buy the
  // same authority as the exact stored value.
  rawKindSource: string | null;
  rawResolverVersion: string | null;
  sourceRecordId: string;
  sourceAsOfDate: string;
  sourceUpdatedAt: string;
  sourceHash: string;
}

export interface CampaignContextEntryWithProvenance extends CreativeCampaignContextEntry {
  provenance: CampaignContextProvenance;
}

export type CampaignContextMap = ReadonlyMap<
  string,
  CampaignContextEntryWithProvenance
>;

/** @deprecated Use CampaignContextMap; retained for serialized/test compatibility. */
export type CampaignContextLabelMap = CampaignContextMap;

async function readPersistedCampaignContext(input: {
  businessId: string;
  providerAccountId: string;
  campaignIds: string[];
  asOf: string;
}): Promise<PersistedContextRow[]> {
  if (input.campaignIds.length === 0) return [];
  const rows = await getDb().query<Row>(
    `
    SELECT DISTINCT ON (campaign_id)
      id::text AS source_record_id,
      provider_account_id,
      campaign_id,
      as_of_date::text AS source_as_of_date,
      inferred_kind,
      confidence_score,
      confidence_class,
      resolver_version,
      kind_source,
      kind_basis,
      updated_at::text AS source_updated_at
    FROM engine_v3_campaign_context_daily
    WHERE business_id = $1
      AND campaign_id = ANY($2::text[])
      AND provider_account_id IS NOT NULL
      AND provider_account_id = $5
      AND as_of_date <= $3::date
      AND as_of_date >= ($3::date - ($4 * INTERVAL '1 day'))
    ORDER BY campaign_id, as_of_date DESC
    `,
    [
      input.businessId,
      input.campaignIds,
      input.asOf,
      CAMPAIGN_CONTEXT_MAX_AGE_DAYS,
      input.providerAccountId,
    ],
  );
  return rows
    .map((row) => {
      const kindRaw = toText(row.inferred_kind);
      const classRaw = toText(row.confidence_class) ?? "unknown";
      const sourceRecordId = toText(row.source_record_id);
      const sourceAsOfDate = toText(row.source_as_of_date);
      const sourceUpdatedAt = toIsoTimestamp(row.source_updated_at);
      if (!sourceRecordId || !sourceAsOfDate || !sourceUpdatedAt) return null;
      const confidenceClass = (
        ["high", "medium", "low", "unknown", "conflict"].includes(classRaw)
          ? classRaw
          : "unknown"
      ) as ContextConfidenceClass;
      return {
        providerAccountId: toText(row.provider_account_id) ?? "",
        campaignId: toText(row.campaign_id) ?? "",
        inferredKind:
          kindRaw === "main" || kindRaw === "test" || kindRaw === "mixed"
            ? (kindRaw as CampaignKind)
            : null,
        confidenceClass,
        rawKindSource: rawText(row.kind_source),
        rawResolverVersion: rawText(row.resolver_version),
        sourceRecordId,
        sourceAsOfDate,
        sourceUpdatedAt,
        sourceHash: canonicalSha256({
          sourceRecordType: "engine_v3_campaign_context_daily",
          sourceRecordId,
          businessId: input.businessId,
          providerAccountId: toText(row.provider_account_id),
          campaignId: toText(row.campaign_id),
          sourceAsOfDate,
          sourceUpdatedAt,
          inferredKind:
            kindRaw === "main" || kindRaw === "test" || kindRaw === "mixed"
              ? kindRaw
              : null,
          confidenceScore: row.confidence_score,
          confidenceClass,
          // Raw, so whitespace and case variants of the provenance strings
          // cannot hash identically to the exact stored values.
          resolverVersion: rawText(row.resolver_version),
          kindSource: rawText(row.kind_source),
          kindBasis: toText(row.kind_basis),
        }),
      };
    })
    .filter(
      (row): row is PersistedContextRow =>
        row !== null && !!row.providerAccountId && !!row.campaignId,
    );
}

export function campaignContextProvenanceFor(input: {
  mode: CampaignContextMode;
  campaignId: string | null | undefined;
  entry: CampaignContextEntryWithProvenance | null | undefined;
}): CampaignContextProvenance {
  const campaignId = input.campaignId?.trim() || null;
  if (campaignId && input.entry) return input.entry.provenance;
  return {
    mode: input.mode,
    source: "unknown",
    campaignId,
    kind: null,
    testDimension: null,
    contextTrust: null,
    sourceRecordType: null,
    sourceRecordId: null,
    sourceAsOfDate: null,
    sourceUpdatedAt: null,
    sourceHash: null,
  };
}

/**
 * Account-scoped automatic campaign-role map used by every decision surface.
 * Manual labels are intentionally absent: unknown/low-confidence inference
 * stays fail-closed instead of asking the operator to supply a role.
 */
export async function readCampaignContextMap(input: {
  businessId: string;
  providerAccountId?: string | null;
  campaignIds: string[];
  asOf?: string;
  mode?: CampaignContextMode;
}): Promise<CampaignContextMap> {
  const requestedMode = input.mode ?? resolveCampaignContextMode();
  const mode: CampaignContextMode =
    requestedMode === "unknown" ? "unknown" : "automatic";
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  if (mode === "unknown") {
    // Circuit breaker: no context at all; guard demotes hard actions.
    return new Map();
  }

  const providerAccountId = input.providerAccountId?.trim() ?? "";
  if (!providerAccountId) {
    // Campaign role is a physical-account fact. Never collapse a multi-account
    // business into one campaign-id map when the caller cannot prove account
    // scope; missing scope is unresolved and therefore review-only.
    return new Map();
  }
  if (input.campaignIds.length === 0) {
    return new Map();
  }

  // automatic: system_inferred -> unknown.
  const entries = new Map<string, CampaignContextEntryWithProvenance>();
  const persisted = await readPersistedCampaignContext({
    businessId: input.businessId,
    providerAccountId,
    campaignIds: input.campaignIds,
    asOf,
  });
  for (const row of persisted) {
    // Byte-for-byte, against the RAW persisted value. The validator is never
    // handed a trimmed or case-folded string, and the source is never defaulted
    // or inferred from the read mode, the timestamp, or the row's existence.
    const resolverAuthorityValidated =
      isCampaignContextResolverAuthorityValidated(row.rawResolverVersion);
    const sourceAuthorityValidated = row.rawKindSource === "system_inferred";
    // Exact `high` only: an automatic origin, an exact high confidence class and
    // an exact approved resolver identity must all hold. Any one of them missing
    // leaves the row as review-only evidence, which never unlocks kind semantics
    // or hard action.
    const contextTrust: CreativeCampaignContextTrust =
      row.inferredKind === null
        ? row.confidenceClass === "conflict"
          ? "conflict"
          : "unknown"
        : row.confidenceClass === "high"
          ? sourceAuthorityValidated && resolverAuthorityValidated
            ? "high"
            : "medium"
          : row.confidenceClass === "medium"
            ? "medium"
            : row.confidenceClass === "conflict"
              ? "conflict"
              : "low";
    entries.set(row.campaignId, {
      kind: row.inferredKind,
      testDimension: null,
      inferenceConfidenceClass: row.confidenceClass,
      resolverAuthorityValidated,
      contextTrust,
      provenance: {
        mode,
        // The validated origin, never a synthesized one: anything that is not
        // byte-for-byte "system_inferred" is reported as unknown.
        source: sourceAuthorityValidated ? "system_inferred" : "unknown",
        campaignId: row.campaignId,
        kind: row.inferredKind,
        testDimension: null,
        contextTrust,
        sourceRecordType: "engine_v3_campaign_context_daily",
        sourceRecordId: row.sourceRecordId,
        sourceAsOfDate: row.sourceAsOfDate,
        sourceUpdatedAt: row.sourceUpdatedAt,
        sourceHash: row.sourceHash,
      },
    });
  }
  for (const campaignId of input.campaignIds) {
    if (!entries.has(campaignId)) {
      entries.set(campaignId, {
        kind: null,
        testDimension: null,
        contextTrust: "unknown",
        inferenceConfidenceClass: "unknown",
        resolverAuthorityValidated: false,
        provenance: campaignContextProvenanceFor({
          mode,
          campaignId,
          entry: null,
        }),
      });
    }
  }
  return entries;
}

/**
 * @deprecated Compatibility name for existing callers. Runtime semantics are
 * automatic-only; this function never reads `meta_campaign_labels`.
 */
export const readCampaignContextLabelMap = readCampaignContextMap;
