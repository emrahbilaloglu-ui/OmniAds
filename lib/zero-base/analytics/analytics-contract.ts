/**
 * Analytics, landing pages/products, SEO and GEO adapters (H34–H36).
 *
 * Written after inventorying the real handlers, because the Phase C/D lesson
 * was that a client typed against an invented shape renders nothing while
 * reporting success. Every adapter here validates what actually arrived and
 * refuses visibly when the required fields are absent — a 200 with the wrong
 * body is degraded, never "serving".
 *
 * Two disclosures the GEO endpoint forces, and which must not be smoothed over:
 *
 * - `aiPageCount` is `Math.min(rowCount, 50)`. It is a **proxy capped at 50**,
 *   not a count of AI-visited pages, and a surface that prints "50" without
 *   saying so reports a ceiling as a measurement.
 * - `top3Priorities` is already `.slice(0, 3)` server-side. The surface shows
 *   exactly those three and says more may exist, rather than implying the list
 *   is the whole of what the engine found.
 */

export type Adapted<T> = { ok: true; value: T } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/* --------------------------------------------------------- measured values */

/**
 * A served number, or an explicit absence.
 *
 * `measured zero` and `unavailable` are different facts and the tests pin the
 * difference: a zero is a measurement somebody took.
 */
export type AnalyticsValue =
  | { available: true; display: string; raw: number; measuredZero: boolean }
  | { available: false; reason: string };

export function analyticsValue(
  raw: unknown,
  format: (value: number) => string,
  reason = "Not served for this window.",
): AnalyticsValue {
  const value = num(raw);
  if (value === null) return { available: false, reason };
  return { available: true, display: format(value), raw: value, measuredZero: value === 0 };
}

/* ------------------------------------------------------------- source state */

export type SourceKind = "ga4" | "shopify" | "search_console";

export interface SourcePanel {
  kind: SourceKind;
  label: string;
  connected: boolean;
  /** Verbatim provider error. Absent when connected. */
  error: string | null;
  /** Whether this source alone being down degrades the surface. */
  required: boolean;
}

export const SOURCE_LABEL: Record<SourceKind, string> = {
  ga4: "Google Analytics 4",
  shopify: "Shopify",
  search_console: "Search Console",
};

/** Adapt the `sources` object the GEO and SEO endpoints actually return. */
export function adaptSources(raw: unknown): SourcePanel[] {
  const sources = isRecord(raw) && isRecord(raw.sources) ? raw.sources : {};
  const read = (key: string): { connected: boolean; error: string | null } => {
    const entry = sources[key];
    if (!isRecord(entry)) return { connected: false, error: "This source was not reported." };
    return {
      connected: entry.connected === true,
      error: entry.connected === true ? null : (str(entry.error) ?? "This source is not connected."),
    };
  };
  return [
    { kind: "ga4" as const, ...read("ga4"), label: SOURCE_LABEL.ga4, required: true },
    {
      kind: "search_console" as const,
      ...read("searchConsole"),
      label: SOURCE_LABEL.search_console,
      required: true,
    },
  ].map((panel) => ({ ...panel }));
}

/**
 * How a surface behaves when one of two sources is down.
 *
 * Partial, not empty: the half that answered is still shown, and the half that
 * did not is named. Blanking the page would discard measurements we have.
 */
export function dualSourceState(panels: readonly SourcePanel[]): {
  kind: "serving" | "partial" | "unavailable";
  reason: string | null;
} {
  const down = panels.filter((panel) => !panel.connected);
  if (down.length === 0) return { kind: "serving", reason: null };
  if (down.length === panels.length) {
    return {
      kind: "unavailable",
      reason: `Neither source is connected: ${down.map((p) => p.label).join(" and ")}.`,
    };
  }
  return {
    kind: "partial",
    reason: `${down.map((p) => p.label).join(" and ")} did not answer, so anything derived from it is missing rather than zero.`,
  };
}

/* ------------------------------------------------------------------- GEO */

export const GEO_PAGE_COUNT_PROXY_CAP = 50;
export const GEO_PROXY_DISCLOSURE =
  `Counted from sampled rows and capped at ${GEO_PAGE_COUNT_PROXY_CAP}. It is a proxy for AI-visited pages, not an exact count, and a value of ${GEO_PAGE_COUNT_PROXY_CAP} means "at least ${GEO_PAGE_COUNT_PROXY_CAP}".`;

export const GEO_TOP_THREE_DISCLOSURE =
  "These are the three highest priorities the engine surfaced. Others may exist and are not shown here.";

export interface GeoPriority {
  title: string;
  priority: "high" | "medium" | "low";
  detail: string | null;
}

export interface AdaptedGeo {
  sources: SourcePanel[];
  aiPageCount: AnalyticsValue;
  /** Exactly what the server sliced. Never re-sliced or padded here. */
  priorities: GeoPriority[];
  /** True when the count sits on the proxy ceiling. */
  atProxyCap: boolean;
  kpis: Array<{ key: string; value: AnalyticsValue }>;
}

export function adaptGeoOverview(raw: unknown): Adapted<AdaptedGeo> {
  if (!isRecord(raw) || !isRecord(raw.kpis)) {
    return {
      ok: false,
      reason: "The GEO response did not carry the expected kpis object, so nothing can be shown for it.",
    };
  }
  const pageCount = num((raw.kpis as Record<string, unknown>).aiPageCount);
  const priorities = Array.isArray(raw.top3Priorities) ? raw.top3Priorities.filter(isRecord) : [];
  return {
    ok: true,
    value: {
      sources: adaptSources(raw),
      aiPageCount: analyticsValue((raw.kpis as Record<string, unknown>).aiPageCount, (v) =>
        String(Math.trunc(v)),
      ),
      priorities: priorities.map((item) => ({
        title: str(item.title) ?? "(title not served)",
        priority:
          item.priority === "high" || item.priority === "medium" || item.priority === "low"
            ? item.priority
            : "low",
        detail: str(item.detail) ?? str(item.description),
      })),
      atProxyCap: pageCount !== null && pageCount >= GEO_PAGE_COUNT_PROXY_CAP,
      kpis: Object.entries(raw.kpis as Record<string, unknown>).map(([key, value]) => ({
        key,
        value: analyticsValue(value, (v) => String(v)),
      })),
    },
  };
}

/* ---------------------------------------------------------- collections */

export interface AdaptedTable {
  rows: Array<Record<string, unknown>>;
  /** Only when the backend served one. Never a number from a spec. */
  servedCap: number | null;
  capText: string;
}

export const BACKEND_CAP_NOT_SUPPLIED = "Backend cap not supplied";

export function adaptTable(raw: unknown, rowKeys: readonly string[]): Adapted<AdaptedTable> {
  if (!isRecord(raw)) return { ok: false, reason: "The response was not an object." };
  const key = rowKeys.find((candidate) => Array.isArray(raw[candidate]));
  if (!key) {
    return {
      ok: false,
      reason: `The response carried none of the expected collections (${rowKeys.join(", ")}).`,
    };
  }
  const rows = (raw[key] as unknown[]).filter(isRecord);
  const cap = num(raw.rowLimit) ?? num(raw.rowCap) ?? num(raw.limit);
  return {
    ok: true,
    value: {
      rows,
      servedCap: cap,
      capText:
        cap === null
          ? BACKEND_CAP_NOT_SUPPLIED
          : rows.length >= cap
            ? `Showing ${rows.length} rows, the maximum this read returns. More may exist.`
            : `Showing ${rows.length} of up to ${cap} rows.`,
    },
  };
}

/* -------------------------------------------------------------- AI insight */

/** The AI insight is READ ONLY here. Generation is not reachable. */
export const AI_GENERATE_ENDPOINT = "/api/ai/insights/generate";

export interface AdaptedInsight {
  text: string | null;
  generatedAt: string | null;
  absentReason: string | null;
}

export function adaptLatestInsight(raw: unknown): AdaptedInsight {
  if (!isRecord(raw) || raw.insight === null || !isRecord(raw.insight)) {
    return {
      text: null,
      generatedAt: null,
      // Absent, not empty: nobody has generated one, and this surface will not.
      absentReason: "No AI insight has been generated for this business yet.",
    };
  }
  const insight = raw.insight;
  return {
    text: str(insight.content) ?? str(insight.text) ?? str(insight.summary),
    generatedAt: str(insight.createdAt) ?? str(insight.generatedAt),
    absentReason: null,
  };
}

/* --------------------------------------------------------------- SEO role */

export type SeoRoleState =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * SEO write affordances are collaborator-gated.
 *
 * A guest sees the findings and no controls; the gate states why rather than
 * silently omitting them.
 */
export function seoRoleState(role: string | null): SeoRoleState {
  if (role === "admin" || role === "collaborator") return { allowed: true };
  return {
    allowed: false,
    reason: "Guests can read SEO findings but cannot change them.",
  };
}
