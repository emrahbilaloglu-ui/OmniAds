// Campaign context source resolution (D033).
//
// CAMPAIGN_CONTEXT_MODE kill switch:
// - legacy_labels: compatibility mode; meta_campaign_labels rows are
//   consumed exactly as today and missing labels keep today's conservative
//   guard behavior. Deploying this module changes nothing until the mode is
//   flipped.
// - automatic: source priority user_override (meta_campaign_labels) ->
//   system_inferred (engine_v3_campaign_context_daily) -> unknown.
// - unknown: emergency context circuit breaker; every campaign is treated as
//   unresolved and hard actions demote under missing-context safety.
import { getDb } from "@/lib/db";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import { type CreativeCampaignContextEntry } from "../campaign-label-guard";
import {
  canonicalSha256,
  type CampaignContextProvenance,
} from "../canonical-evaluation";
import type { CampaignKind, ContextConfidenceClass } from "./resolver";

export type CampaignContextMode = "legacy_labels" | "automatic" | "unknown";

export const CAMPAIGN_CONTEXT_MODE_ENV = "CAMPAIGN_CONTEXT_MODE";
export const CAMPAIGN_CONTEXT_HARD_AUTHORITY_ENV =
  "CAMPAIGN_CONTEXT_HARD_AUTHORITY_ENABLED";

// Persisted context older than this many days (vs asOf) is treated as
// unresolved rather than trusted: stale automatic context must not drive
// kind semantics.
export const CAMPAIGN_CONTEXT_MAX_AGE_DAYS = 2;

export function resolveCampaignContextMode(): CampaignContextMode {
  const raw = process.env[CAMPAIGN_CONTEXT_MODE_ENV]?.trim().toLowerCase();
  if (raw === "legacy_labels") return "legacy_labels";
  if (raw === "automatic") return "automatic";
  if (raw === "unknown") return "unknown";
  // Automatic context is the product default. User corrections remain the
  // highest-priority source, while inferred roles stay review-only until the
  // independent authority gate below is explicitly opened.
  return "automatic";
}

export function isCampaignContextHardAuthorityEnabled() {
  const raw = process.env[CAMPAIGN_CONTEXT_HARD_AUTHORITY_ENV]
    ?.trim()
    .toLowerCase();
  return raw === "1" || raw === "true";
}

type Row = Record<string, unknown>;

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
  campaignId: string;
  inferredKind: CampaignKind | null;
  confidenceClass: ContextConfidenceClass;
  sourceRecordId: string;
  sourceAsOfDate: string;
  sourceUpdatedAt: string;
  sourceHash: string;
}

export interface CampaignContextEntryWithProvenance extends CreativeCampaignContextEntry {
  provenance: CampaignContextProvenance;
}

export type CampaignContextLabelMap = ReadonlyMap<
  string,
  CampaignContextEntryWithProvenance
>;

async function readPersistedCampaignContext(input: {
  businessId: string;
  campaignIds: string[];
  asOf: string;
}): Promise<PersistedContextRow[]> {
  if (input.campaignIds.length === 0) return [];
  const rows = await getDb().query<Row>(
    `
    SELECT DISTINCT ON (campaign_id)
      id::text AS source_record_id,
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
      AND as_of_date <= $3::date
      AND as_of_date >= ($3::date - ($4 * INTERVAL '1 day'))
    ORDER BY campaign_id, as_of_date DESC
    `,
    [
      input.businessId,
      input.campaignIds,
      input.asOf,
      CAMPAIGN_CONTEXT_MAX_AGE_DAYS,
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
        campaignId: toText(row.campaign_id) ?? "",
        inferredKind:
          kindRaw === "main" || kindRaw === "test" || kindRaw === "mixed"
            ? (kindRaw as CampaignKind)
            : null,
        confidenceClass,
        sourceRecordId,
        sourceAsOfDate,
        sourceUpdatedAt,
        sourceHash: canonicalSha256({
          sourceRecordType: "engine_v3_campaign_context_daily",
          sourceRecordId,
          businessId: input.businessId,
          campaignId: toText(row.campaign_id),
          sourceAsOfDate,
          sourceUpdatedAt,
          inferredKind:
            kindRaw === "main" || kindRaw === "test" || kindRaw === "mixed"
              ? kindRaw
              : null,
          confidenceScore: row.confidence_score,
          confidenceClass,
          resolverVersion: toText(row.resolver_version),
          kindSource: toText(row.kind_source),
          kindBasis: toText(row.kind_basis),
        }),
      };
    })
    .filter(
      (row): row is PersistedContextRow => row !== null && !!row.campaignId,
    );
}

function labelProvenance(input: {
  mode: CampaignContextMode;
  businessId: string;
  label: Awaited<ReturnType<typeof readMetaCampaignLabels>>[number];
}): CampaignContextProvenance {
  const sourceRecordId = `${input.businessId}:${input.label.campaignId}`;
  const labeledAt = toIsoTimestamp(input.label.labeledAt);
  const updatedAt = toIsoTimestamp(input.label.updatedAt);
  if (!labeledAt || !updatedAt) {
    throw new TypeError("Campaign label timestamps must be valid instants.");
  }
  const sourceAsOfDate = labeledAt.slice(0, 10);
  return {
    mode: input.mode,
    source: input.mode === "legacy_labels" ? "legacy_label" : "user_override",
    campaignId: input.label.campaignId,
    kind: input.label.kind,
    testDimension: input.label.testDimension,
    contextTrust: input.mode === "legacy_labels" ? null : "override",
    sourceRecordType: "meta_campaign_label",
    sourceRecordId,
    sourceAsOfDate,
    sourceUpdatedAt: updatedAt,
    sourceHash: canonicalSha256({
      sourceRecordType: "meta_campaign_label",
      sourceRecordId,
      businessId: input.businessId,
      campaignId: input.label.campaignId,
      kind: input.label.kind,
      testDimension: input.label.testDimension,
      source: input.label.source,
      labeledAt,
      updatedAt,
    }),
  };
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
 * Mode-aware campaign context map used by every decision surface. In
 * legacy_labels mode this is byte-identical to the previous
 * readMetaCampaignLabels + buildCreativeCampaignLabelMap behavior.
 */
export async function readCampaignContextLabelMap(input: {
  businessId: string;
  campaignIds: string[];
  asOf?: string;
  mode?: CampaignContextMode;
}): Promise<CampaignContextLabelMap> {
  const mode = input.mode ?? resolveCampaignContextMode();
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  if (mode === "unknown") {
    // Circuit breaker: no context at all; guard demotes hard actions.
    return new Map();
  }
  if (input.campaignIds.length === 0) {
    return new Map();
  }

  const labels = await readMetaCampaignLabels({
    businessId: input.businessId,
    campaignIds: input.campaignIds,
  });
  if (mode === "legacy_labels") {
    return new Map(
      labels.map((label) => [
        label.campaignId,
        {
          kind: label.kind,
          testDimension: label.testDimension,
          provenance: labelProvenance({
            mode,
            businessId: input.businessId,
            label,
          }),
        },
      ]),
    );
  }

  // automatic: user_override -> system_inferred -> unknown.
  const entries = new Map<string, CampaignContextEntryWithProvenance>();
  const hardAuthorityEnabled = isCampaignContextHardAuthorityEnabled();
  const persisted = await readPersistedCampaignContext({
    businessId: input.businessId,
    campaignIds: input.campaignIds,
    asOf,
  });
  for (const row of persisted) {
    entries.set(row.campaignId, {
      kind: row.inferredKind,
      testDimension: null,
      contextTrust:
        row.inferredKind === null
          ? row.confidenceClass === "conflict"
            ? "conflict"
            : "unknown"
          : row.confidenceClass === "high"
            ? hardAuthorityEnabled
              ? "high"
              : "medium"
            : row.confidenceClass === "medium"
              ? "medium"
              : row.confidenceClass === "conflict"
                ? "conflict"
                : "low",
      provenance: {
        mode,
        source: "system_inferred",
        campaignId: row.campaignId,
        kind: row.inferredKind,
        testDimension: null,
        contextTrust:
          row.inferredKind === null
            ? row.confidenceClass === "conflict"
              ? "conflict"
              : "unknown"
            : row.confidenceClass === "high"
              ? hardAuthorityEnabled
                ? "high"
                : "medium"
              : row.confidenceClass === "medium"
                ? "medium"
                : row.confidenceClass === "conflict"
                  ? "conflict"
                  : "low",
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
        provenance: campaignContextProvenanceFor({
          mode,
          campaignId,
          entry: null,
        }),
      });
    }
  }
  for (const label of labels) {
    entries.set(label.campaignId, {
      kind: label.kind,
      testDimension: label.testDimension,
      contextTrust: "override",
      provenance: labelProvenance({
        mode,
        businessId: input.businessId,
        label,
      }),
    });
  }
  return entries;
}
