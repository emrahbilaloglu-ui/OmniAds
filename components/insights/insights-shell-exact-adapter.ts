/**
 * Pure mapping from route + provider connection state to the Insights outer
 * chrome view model. No React, no fetching — unit-testable on its own.
 */
import type {
  InsightsSectionId,
  InsightsSectionTabModel,
  InsightsShellExactModel,
  InsightsSourceChipModel,
  InsightsSourceProvider,
} from "@/components/insights/insights-shell-exact-model";

/**
 * The design's order, verbatim from script line 3902. The app shipped
 * Analytics / AI Visibility / SEO Intelligence; the design is
 * Analytics / SEO Intelligence / AI Visibility.
 */
export const INSIGHTS_SECTIONS: ReadonlyArray<{
  id: InsightsSectionId;
  label: string;
}> = [
  { id: "analytics", label: "Analytics" },
  { id: "seo", label: "SEO Intelligence" },
  { id: "geo", label: "AI Visibility" },
];

/** Canonical `/c/{businessId}/analytics/**` and `/app/analytics/**` leaves. */
const CANONICAL_SEGMENT: Record<InsightsSectionId, string> = {
  analytics: "ga4-shopify",
  seo: "seo",
  geo: "geo",
};

/** Preserved `/insights/**` legacy leaves. */
const LEGACY_SEGMENT: Record<InsightsSectionId, string> = {
  analytics: "analytics",
  seo: "seo",
  geo: "ai-visibility",
};

/**
 * Both analytics leaves — the GA4 overview and the landing-pages/products
 * leaf — are the same design tab, so both light the Analytics pill.
 */
const CANONICAL_ANALYTICS_SEGMENTS = new Set(["ga4-shopify", "landing-pages"]);

export interface InsightsRouteBase {
  /** Everything up to and including the section container. */
  base: string;
  kind: "canonical" | "legacy";
}

/**
 * Where the three sections live for the route currently being rendered.
 *
 * `/c/{id}/analytics/**` and `/app/analytics/**` are the canonical twins;
 * anything else is the preserved `/insights/**` family.
 */
export function resolveInsightsRouteBase(pathname: string): InsightsRouteBase {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "c" && segments[1] && segments[2] === "analytics") {
    return { base: `/c/${segments[1]}/analytics`, kind: "canonical" };
  }
  if (segments[0] === "app" && segments[1] === "analytics") {
    return { base: "/app/analytics", kind: "canonical" };
  }
  return { base: "/insights", kind: "legacy" };
}

function activeSectionFor(
  pathname: string,
  route: InsightsRouteBase,
): InsightsSectionId {
  const trailing = pathname.startsWith(`${route.base}/`)
    ? pathname.slice(route.base.length + 1).split("/")[0]
    : "";
  if (route.kind === "canonical") {
    if (CANONICAL_ANALYTICS_SEGMENTS.has(trailing)) return "analytics";
    if (trailing === "seo") return "seo";
    if (trailing === "geo") return "geo";
    return "analytics";
  }
  if (trailing === "seo") return "seo";
  if (trailing === "ai-visibility") return "geo";
  return "analytics";
}

export function buildInsightsSectionTabs(
  pathname: string,
): InsightsSectionTabModel[] {
  const route = resolveInsightsRouteBase(pathname);
  const active = activeSectionFor(pathname, route);
  const segments = route.kind === "canonical" ? CANONICAL_SEGMENT : LEGACY_SEGMENT;
  return INSIGHTS_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    href: `${route.base}/${segments[section.id]}`,
    active: section.id === active,
  }));
}

/** Exactly what `deriveProviderViewState` gives us, narrowed to what we read. */
export interface InsightsProviderState {
  isConnected: boolean;
  status: string;
}

const SOURCE_LABEL: Record<InsightsSourceProvider, string> = {
  ga4: "GA4",
  search_console: "Search Console",
};

/** Assets already shipped at these paths; the design points at both. */
const SOURCE_ICON: Record<InsightsSourceProvider, string> = {
  ga4: "/platform-logos/GA4.svg",
  search_console: "/platform-logos/searchconsole.svg",
};

export function buildInsightsSourceChip(
  provider: InsightsSourceProvider,
  state: InsightsProviderState,
): InsightsSourceChipModel {
  const tone: InsightsSourceChipModel["tone"] = state.isConnected
    ? "positive"
    : state.status === "action_required" || state.status === "degraded"
      ? "warning"
      : "neutral";
  const stateLabel = state.isConnected
    ? "connected"
    : state.status === "action_required"
      ? "action required"
      : state.status === "degraded"
        ? "degraded"
        : state.status === "loading_data"
          ? "loading"
          : "not connected";
  return {
    id: provider,
    label: SOURCE_LABEL[provider],
    iconSrc: SOURCE_ICON[provider],
    stateLabel,
    tone,
  };
}

export interface InsightsShellAdapterInput {
  pathname: string;
  ga4: InsightsProviderState;
  searchConsole: InsightsProviderState;
}

export function buildInsightsShellExactModel(
  input: InsightsShellAdapterInput,
): InsightsShellExactModel {
  return {
    // Design line 1737 / 1738 — verbatim.
    eyebrow: "Growth · GA4 + Search Console",
    title: "Insights",
    tabs: buildInsightsSectionTabs(input.pathname),
    sources: [
      buildInsightsSourceChip("ga4", input.ga4),
      buildInsightsSourceChip("search_console", input.searchConsole),
    ],
  };
}
