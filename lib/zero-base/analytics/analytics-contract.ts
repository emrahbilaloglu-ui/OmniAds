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

// Type-only: erased at build time, so no server module reaches the client.
import type { IntegrationStatusResponse } from "@/lib/integration-status";

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

/**
 * Adapt the `sources` object the **GEO** endpoint returns.
 *
 * Only GEO emits one. A re-audit found this being called on the analytics and
 * SEO payloads, which carry no `sources` key at all — so a perfectly healthy
 * GA4 read displayed GA4 and Search Console as down. Connection state now comes
 * from the integration authority instead; see `sourcePanelsFromIntegrations`.
 */
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

/**
 * Provider panels from the real integration authority.
 *
 * `/api/integrations/status` returns a flat `{meta, google, shopify, ...}`
 * boolean map. That is a **connection** fact and nothing more — it says a
 * provider is linked, not that this window's numbers came from it, which is why
 * `measurementNote` is separate and why a Shopify metric is never implied by a
 * Shopify connection.
 */
export function sourcePanelsFromIntegrations(input: {
  raw: unknown;
  /** Which providers this surface actually reads from. */
  providers: readonly SourceKind[];
  /** Null when the status read itself failed. */
  readFailed?: boolean;
}): SourcePanel[] {
  const status = isRecord(input.raw) ? input.raw : {};
  // Keys come from the real producer's own type, so a rename there breaks this
  // at compile time instead of silently reporting every provider as down.
  const KEY: Record<SourceKind, keyof IntegrationStatusResponse> = {
    ga4: "ga4",
    shopify: "shopify",
    search_console: "search_console",
  };
  return input.providers.map((kind) => {
    if (input.readFailed) {
      return {
        kind,
        label: SOURCE_LABEL[kind],
        connected: false,
        // Unknown, not down: we failed to ask.
        error: "The integration status could not be read, so this connection is unknown.",
        required: true,
      };
    }
    const connected = status[KEY[kind]] === true;
    return {
      kind,
      label: SOURCE_LABEL[kind],
      connected,
      error: connected ? null : `${SOURCE_LABEL[kind]} is not connected for this business.`,
      required: true,
    };
  });
}

/**
 * Connection is not measurement.
 *
 * A connected provider whose read served nothing is a different state from a
 * disconnected one, and a surface that shows only the connection invites the
 * reader to assume the numbers came from it.
 */
export function measurementNote(input: {
  connected: boolean;
  served: boolean;
  label: string;
}): string | null {
  if (!input.connected) return null;
  if (input.served) return null;
  return `${input.label} is connected but supplied no figures for this window.`;
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

/* ============================================================================
 * Real payload adapters.
 *
 * Added after a transition audit found the first version calling
 * `adaptTable(...["rows","sources","channels"])` on `/api/analytics/overview`
 * and `["findings","rows","pages"]` on `/api/seo/overview`. Neither endpoint
 * returns any of those keys, so both surfaces degraded on every successful
 * read — a wrong-shape guess is indistinguishable from an outage to the person
 * looking at it.
 *
 * These adapters are typed against the handlers' actual return types.
 * ========================================================================== */

/** `AnalyticsOverviewResponse` from `lib/analytics-overview.ts`. */
export interface AdaptedAnalyticsOverview {
  propertyName: string | null;
  kpis: Array<{ key: string; value: AnalyticsValue }>;
  /** New vs returning, kept as two labelled cohorts rather than summed. */
  cohorts: Array<{ key: "new" | "returning"; sessions: AnalyticsValue; purchases: AnalyticsValue; purchaseCvr: AnalyticsValue }>;
  trafficSources?: Array<{ name: string; sessions: AnalyticsValue }>;
  insights: string[];
}

const KPI_LABEL: Record<string, string> = {
  sessions: "Sessions",
  engagedSessions: "Engaged sessions",
  engagementRate: "Engagement rate",
  purchases: "Purchases",
  purchaseCvr: "Purchase CVR",
  revenue: "Revenue",
  avgSessionDuration: "Avg. session duration",
  averageOrderValue: "Average order value",
  totalUsers: "Total users",
  newUsers: "New users",
  totalPurchasers: "Total purchasers",
  firstTimePurchasers: "First-time purchasers",
};

export function adaptAnalyticsOverview(raw: unknown): Adapted<AdaptedAnalyticsOverview> {
  if (!isRecord(raw)) return { ok: false, reason: "The overview response was not an object." };
  if (!isRecord(raw.kpis)) {
    return {
      ok: false,
      reason: "The analytics overview response carried no kpis object, so nothing can be shown for it.",
    };
  }
  const kpis = raw.kpis as Record<string, unknown>;
  const cohortOf = (key: "new" | "returning") => {
    const source = isRecord(raw.newVsReturning) ? (raw.newVsReturning as Record<string, unknown>)[key] : null;
    const cohort = isRecord(source) ? source : {};
    return {
      key,
      sessions: analyticsValue(cohort.sessions, (v) => String(Math.trunc(v))),
      purchases: analyticsValue(cohort.purchases, (v) => String(Math.trunc(v))),
      purchaseCvr: analyticsValue(cohort.purchaseCvr, (v) => `${(v * 100).toFixed(2)}%`),
    };
  };

  return {
    ok: true,
    value: {
      propertyName: str(raw.propertyName),
      // Only the keys the handler actually serves; an absent KPI stays absent
      // rather than being rendered as a zero row.
      kpis: Object.keys(KPI_LABEL)
        .filter((key) => key in kpis)
        .map((key) => ({
          key,
          value: analyticsValue(
            kpis[key],
            key === "engagementRate" || key === "purchaseCvr"
              ? (v) => `${(v * 100).toFixed(2)}%`
              : key === "revenue" || key === "averageOrderValue"
                ? (v) => v.toFixed(2)
                : (v) => String(Math.trunc(v)),
          ),
        })),
      // Two cohorts, never added together: "new + returning" is not a metric
      // GA4 serves and summing them invents one.
      cohorts: [cohortOf("new"), cohortOf("returning")],
      trafficSources: Array.isArray(raw.trafficSources)
        ? raw.trafficSources.flatMap((item) => {
            if (!isRecord(item)) return [];
            const name = str(item.name);
            return name
              ? [{ name, sessions: analyticsValue(item.sessions, (value) => String(Math.trunc(value))) }]
              : [];
          })
        : [],
      insights: Array.isArray(raw.insights)
        ? raw.insights
            .map((item) => (isRecord(item) ? str(item.text) : str(item)))
            .filter((text): text is string => Boolean(text))
        : [],
    },
  };
}

/** `{ pages: [{ path, sessions, engagementRate, purchases, purchaseCvr }] }`. */
export interface AdaptedLandingPage {
  id: string;
  path: string;
  sessions: AnalyticsValue;
  purchases: AnalyticsValue;
  purchaseCvr: AnalyticsValue;
}

export function adaptLandingPages(raw: unknown): Adapted<{ rows: AdaptedLandingPage[]; capText: string }> {
  if (!isRecord(raw)) return { ok: false, reason: "The landing-pages response was not an object." };
  const list = Array.isArray(raw.pages) ? raw.pages : Array.isArray(raw.rows) ? raw.rows : null;
  if (!list) {
    return {
      ok: false,
      reason: "The landing-pages response carried neither a pages nor a rows collection.",
    };
  }
  const rows = list.filter(isRecord).map((row, index) => ({
    id: str(row.path) ?? String(index),
    path: str(row.path) ?? "(path not served)",
    sessions: analyticsValue(row.sessions, (v) => String(Math.trunc(v))),
    // The handler serves purchases and purchaseCvr. There is no `conversions`
    // field; asking for one produced "Not served" on every row.
    purchases: analyticsValue(row.purchases, (v) => String(Math.trunc(v))),
    purchaseCvr: analyticsValue(row.purchaseCvr, (v) => `${(v * 100).toFixed(2)}%`),
  }));
  const cap = num(raw.rowLimit) ?? num(raw.rowCap);
  return {
    ok: true,
    value: {
      rows,
      capText:
        cap === null
          ? BACKEND_CAP_NOT_SUPPLIED
          : `Showing ${rows.length} of up to ${cap} rows.`,
    },
  };
}

/** `SeoOverviewPayload` from `lib/seo/intelligence.ts`. */
export interface AdaptedSeo {
  siteUrl: string | null;
  rowCount: number | null;
  summary: Array<{ key: string; current: AnalyticsValue; deltaPercent: AnalyticsValue }>;
  leaderQueries: Array<{ id: string; label: string }>;
  decliningQueries: Array<{ id: string; label: string }>;
  causes: Array<{ id: string; label: string }>;
  recommendations: Array<{ id: string; label: string }>;
  /** Read-only AI brief. This surface never generates one. */
  aiBriefHeadline: string | null;
}

function entityLabel(item: unknown, index: number): { id: string; label: string } {
  const record = isRecord(item) ? item : {};
  const label =
    str(record.query) ?? str(record.page) ?? str(record.title) ?? str(record.label) ?? str(record.id);
  return { id: label ?? String(index), label: label ?? "(not served)" };
}

export function adaptSeoOverview(raw: unknown): Adapted<AdaptedSeo> {
  if (!isRecord(raw) || !isRecord(raw.summary)) {
    return {
      ok: false,
      reason: "The SEO response carried no summary object, so nothing can be shown for it.",
    };
  }
  const summary = raw.summary as Record<string, unknown>;
  const leaders = isRecord(raw.leaders) ? raw.leaders : {};
  const movers = isRecord(raw.movers) ? raw.movers : {};
  const meta = isRecord(raw.meta) ? raw.meta : {};
  const aiBrief = isRecord(raw.aiBrief) ? raw.aiBrief : {};

  return {
    ok: true,
    value: {
      siteUrl: str(meta.siteUrl),
      rowCount: num(meta.rowCount),
      summary: ["clicks", "impressions", "ctr", "position"]
        .filter((key) => isRecord(summary[key]))
        .map((key) => {
          const metric = summary[key] as Record<string, unknown>;
          return {
            key,
            current: analyticsValue(metric.current, (v) =>
              key === "ctr" ? `${(v * 100).toFixed(2)}%` : v.toFixed(key === "position" ? 1 : 0),
            ),
            // deltaPercent is nullable in the contract; null stays unavailable
            // rather than becoming a 0% "no change" claim.
            deltaPercent: analyticsValue(metric.deltaPercent, (v) => `${(v * 100).toFixed(1)}%`),
          };
        }),
      leaderQueries: (Array.isArray(leaders.queries) ? leaders.queries : []).map(entityLabel),
      decliningQueries: (Array.isArray(movers.decliningQueries) ? movers.decliningQueries : []).map(entityLabel),
      causes: (Array.isArray(raw.causes) ? raw.causes : []).map(entityLabel),
      recommendations: (Array.isArray(raw.recommendations) ? raw.recommendations : []).map(entityLabel),
      aiBriefHeadline: str(aiBrief.headline) ?? str(aiBrief.summary),
    },
  };
}
