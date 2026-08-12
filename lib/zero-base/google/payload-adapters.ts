/**
 * Adapters for the ACTUAL Google endpoint payloads.
 *
 * Acceptance review found the first version of these clients typed against
 * shapes the endpoints never return: `/api/google-ads/overview` serves
 * `{kpis, kpiDeltas, topCampaigns, insights, summary, meta}` and was read as
 * `{accounts, rows}`, so the surface rendered nothing while labelling the read
 * "serving". The advisor payload was cast to an invented `ServedRecommendation`
 * whose `accountId` does not exist, and `googleDeepLink` then called
 * `.replace()` on `undefined` — a real runtime crash.
 *
 * The lesson encoded here: **a 200 is not a shape.** Every adapter validates
 * what it actually received and returns an explicit `malformed` result when the
 * required fields are absent, so the surface degrades visibly instead of
 * claiming to serve an empty view.
 */
import type { GoogleSourceState } from "@/lib/zero-base/google/google-contract";

export type Adapted<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* -------------------------------------------------------------- meta/state */

/** The real `GoogleAdsReportMeta` degradation signals. */
export interface ReportMeta {
  partial: boolean;
  degraded: boolean;
  warnings: string[];
  readSource: string | null;
  failedQueries: number;
}

export function adaptReportMeta(raw: unknown): ReportMeta {
  const meta = isRecord(raw) ? raw : {};
  const failed = Array.isArray(meta.failed_queries) ? meta.failed_queries.length : 0;
  return {
    partial: meta.partial === true,
    degraded: meta.degraded === true,
    warnings: Array.isArray(meta.warnings) ? meta.warnings.filter((w): w is string => typeof w === "string") : [],
    readSource: str(meta.readSource),
    failedQueries: failed,
  };
}

/**
 * Turn the report's own metadata into a source state.
 *
 * `provider_truth_unavailable` is not a partial read — it means the provider
 * truth was not obtained at all, and reporting it as "serving with warnings"
 * would present a projection as measurement.
 */
export function sourceStateFromMeta(meta: ReportMeta): GoogleSourceState {
  if (meta.readSource === "provider_truth_unavailable") {
    return {
      kind: "unavailable",
      reason: "Google provider truth was not available for this window.",
    };
  }
  if (meta.degraded || meta.partial || meta.failedQueries > 0) {
    const parts = [
      meta.failedQueries > 0 ? `${meta.failedQueries} query/queries failed` : null,
      meta.warnings[0] ?? null,
    ].filter(Boolean);
    return {
      kind: "partial",
      reason: parts.length ? `Incomplete read: ${parts.join("; ")}.` : "Google returned an incomplete read.",
      observedAt: null,
    };
  }
  return { kind: "serving", observedAt: null };
}

/* ------------------------------------------------------------------ scope */

/** Account scope served by a server-owned reader, never invented client-side. */
export interface ServedScopeAccount {
  id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

export function adaptScopeAccounts(raw: unknown): Adapted<ServedScopeAccount[]> {
  if (!isRecord(raw) || !Array.isArray(raw.accounts)) {
    return { ok: false, reason: "Account scope was not served, so it cannot be stated." };
  }
  const accounts = raw.accounts.filter(isRecord).map((account) => ({
    id: str(account.id) ?? str(account.customerId) ?? "",
    name: str(account.name),
    currency: str(account.currency),
    timezone: str(account.timezone) ?? str(account.timeZone),
  }));
  const usable = accounts.filter((account) => account.id);
  if (usable.length === 0) {
    return { ok: false, reason: "No Google account identity was served for this business." };
  }
  return { ok: true, value: usable };
}

/* --------------------------------------------------------------- overview */

export interface OverviewCampaignRow {
  id: string;
  name: string;
  cost: number | null;
  conversions: number | null;
}

export interface AdaptedOverview {
  kpis: Array<{ key: string; value: number | null; delta: number | null }>;
  campaigns: OverviewCampaignRow[];
  meta: ReportMeta;
}

/**
 * Adapt the real overview payload.
 *
 * Requires `kpis` and `topCampaigns` to be present in the shapes the route
 * actually returns. A response missing them is malformed, not empty.
 */
export function adaptOverview(raw: unknown): Adapted<AdaptedOverview> {
  if (!isRecord(raw)) return { ok: false, reason: "The overview response was not an object." };
  if (!isRecord(raw.kpis) || !Array.isArray(raw.topCampaigns)) {
    return {
      ok: false,
      reason:
        "The overview response did not carry the expected kpis and topCampaigns fields, so nothing can be shown for it.",
    };
  }
  const deltas = isRecord(raw.kpiDeltas) ? raw.kpiDeltas : {};
  return {
    ok: true,
    value: {
      kpis: Object.entries(raw.kpis).map(([key, value]) => ({
        key,
        value: num(value),
        delta: num(deltas[key]),
      })),
      campaigns: raw.topCampaigns.filter(isRecord).map((row, index) => ({
        id: str(row.id) ?? str(row.campaignId) ?? String(index),
        name: str(row.name) ?? str(row.campaignName) ?? "(name not served)",
        cost: num(row.cost) ?? num(row.costMicros !== undefined ? Number(row.costMicros) / 1_000_000 : null),
        conversions: num(row.conversions),
      })),
      meta: adaptReportMeta(raw.meta),
    },
  };
}

/* ---------------------------------------------------------------- advisor */

/** The fields of the real `GoogleRecommendation` this programme reads. */
export interface AdaptedRecommendation {
  id: string;
  title: string;
  summary: string | null;
  why: string | null;
  /** The server's own bucket. Not re-derived from a priority word. */
  doBucket: "do_now" | "do_next" | "do_later";
  rankScore: number | null;
  level: string | null;
  entityId: string | null;
  entityName: string | null;
  executionTargetType: string | null;
  executionTargetId: string | null;
  /** Served link. Absent means the exact link is withheld, never guessed. */
  deepLinkUrl: string | null;
  rollbackGuidance: string | null;
}

export function adaptRecommendations(raw: unknown): Adapted<AdaptedRecommendation[]> {
  if (!isRecord(raw) || !Array.isArray(raw.recommendations)) {
    return {
      ok: false,
      reason: "The advisor response did not carry a recommendations array, so no plan can be built from it.",
    };
  }
  const items = raw.recommendations.filter(isRecord).map((item) => {
    const bucket = str(item.doBucket);
    return {
      id: str(item.id) ?? "",
      title: str(item.title) ?? "(title not served)",
      summary: str(item.summary),
      why: str(item.why) ?? str(item.whyNow),
      // Only the three real bucket values; anything else falls to do_later
      // rather than being promoted into urgency the engine never expressed.
      doBucket:
        bucket === "do_now" || bucket === "do_next" || bucket === "do_later"
          ? (bucket as AdaptedRecommendation["doBucket"])
          : ("do_later" as const),
      rankScore: num(item.rankScore),
      level: str(item.level),
      entityId: str(item.entityId),
      entityName: str(item.entityName),
      executionTargetType: str(item.executionTargetType),
      executionTargetId: str(item.executionTargetId),
      deepLinkUrl: str(item.deepLinkUrl),
      rollbackGuidance: str(item.rollbackGuidance),
    } satisfies AdaptedRecommendation;
  });
  return { ok: true, value: items.filter((item) => item.id) };
}

/* ------------------------------------------------------------ collections */

export interface AdaptedCollection {
  rows: Array<Record<string, string | number | null>>;
  meta: ReportMeta;
  rowCap: number | null;
}

/**
 * Adapt a Google collection payload by trying the row keys these endpoints
 * actually use, in order. A payload with none of them is malformed rather than
 * an empty collection.
 */
export function adaptCollection(raw: unknown, rowKeys: readonly string[]): Adapted<AdaptedCollection> {
  if (!isRecord(raw)) return { ok: false, reason: "The response was not an object." };
  const key = rowKeys.find((candidate) => Array.isArray(raw[candidate]));
  if (!key) {
    return {
      ok: false,
      reason: `The response carried none of the expected collections (${rowKeys.join(", ")}), so nothing can be shown for it.`,
    };
  }
  const rows = (raw[key] as unknown[]).filter(isRecord).map((row, index) => {
    const out: Record<string, string | number | null> = { id: str(row.id) ?? String(index) };
    for (const [field, value] of Object.entries(row)) {
      out[field] = typeof value === "number" ? value : str(value);
    }
    return out;
  });
  return {
    ok: true,
    value: { rows, meta: adaptReportMeta(raw.meta), rowCap: num(raw.rowCap) },
  };
}
