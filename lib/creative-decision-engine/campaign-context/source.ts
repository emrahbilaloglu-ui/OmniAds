// Campaign context source resolution (D033).
//
// CAMPAIGN_CONTEXT_MODE kill switch:
// - legacy_labels (default): current behavior; meta_campaign_labels rows are
//   consumed exactly as today and missing labels keep today's conservative
//   guard behavior. Deploying this module changes nothing until the mode is
//   flipped.
// - automatic: source priority user_override (meta_campaign_labels) ->
//   system_inferred (engine_v3_campaign_context_daily) -> unknown.
// - unknown: emergency context circuit breaker; every campaign is treated as
//   unresolved and hard actions demote under missing-context safety.
import { getDb } from "@/lib/db";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import {
  buildCreativeCampaignLabelMap,
  type CreativeCampaignLabelMap,
  type CreativeCampaignContextEntry,
} from "../campaign-label-guard";
import type { CampaignKind, ContextConfidenceClass } from "./resolver";

export type CampaignContextMode = "legacy_labels" | "automatic" | "unknown";

export const CAMPAIGN_CONTEXT_MODE_ENV = "CAMPAIGN_CONTEXT_MODE";

// Persisted context older than this many days (vs asOf) is treated as
// unresolved rather than trusted: stale automatic context must not drive
// kind semantics.
export const CAMPAIGN_CONTEXT_MAX_AGE_DAYS = 2;

export function resolveCampaignContextMode(): CampaignContextMode {
  const raw = process.env[CAMPAIGN_CONTEXT_MODE_ENV]?.trim().toLowerCase();
  if (raw === "automatic") return "automatic";
  if (raw === "unknown") return "unknown";
  return "legacy_labels";
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

interface PersistedContextRow {
  campaignId: string;
  inferredKind: CampaignKind | null;
  confidenceClass: ContextConfidenceClass;
}

async function readPersistedCampaignContext(input: {
  businessId: string;
  campaignIds: string[];
  asOf: string;
}): Promise<PersistedContextRow[]> {
  if (input.campaignIds.length === 0) return [];
  const rows = await getDb().query<Row>(
    `
    SELECT DISTINCT ON (campaign_id)
      campaign_id,
      inferred_kind,
      confidence_class
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
      return {
        campaignId: toText(row.campaign_id) ?? "",
        inferredKind:
          kindRaw === "main" || kindRaw === "test" || kindRaw === "mixed"
            ? (kindRaw as CampaignKind)
            : null,
        confidenceClass: (
          ["high", "medium", "low", "unknown", "conflict"].includes(classRaw)
            ? classRaw
            : "unknown"
        ) as ContextConfidenceClass,
      };
    })
    .filter((row) => row.campaignId);
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
}): Promise<CreativeCampaignLabelMap> {
  const mode = input.mode ?? resolveCampaignContextMode();
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  if (mode === "unknown") {
    // Circuit breaker: no context at all; guard demotes hard actions.
    return buildCreativeCampaignLabelMap([]);
  }
  if (input.campaignIds.length === 0) {
    return buildCreativeCampaignLabelMap([]);
  }

  const labels = await readMetaCampaignLabels({
    businessId: input.businessId,
    campaignIds: input.campaignIds,
  });
  if (mode === "legacy_labels") {
    return buildCreativeCampaignLabelMap(labels);
  }

  // automatic: user_override -> system_inferred -> unknown.
  const entries = new Map<string, CreativeCampaignContextEntry>();
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
            ? "high"
            : row.confidenceClass === "medium"
              ? "medium"
              : row.confidenceClass === "conflict"
                ? "conflict"
                : "low",
    });
  }
  for (const campaignId of input.campaignIds) {
    if (!entries.has(campaignId)) {
      entries.set(campaignId, {
        kind: null,
        testDimension: null,
        contextTrust: "unknown",
      });
    }
  }
  for (const label of labels) {
    entries.set(label.campaignId, {
      kind: label.kind,
      testDimension: label.testDimension,
      contextTrust: "override",
    });
  }
  return entries;
}
