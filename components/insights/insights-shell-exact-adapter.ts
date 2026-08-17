/**
 * Pure mapping from route + provider connection state to the Insights outer
 * chrome view model. No React, no fetching — unit-testable on its own.
 */
import type {
  ProviderReadBlock,
  ProviderReadCapability,
} from "@/lib/provider-read-capability";
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

const SOURCE_LABEL: Record<InsightsSourceProvider, string> = {
  ga4: "GA4",
  search_console: "Search Console",
};

/** Assets already shipped at these paths; the design points at both. */
const SOURCE_ICON: Record<InsightsSourceProvider, string> = {
  ga4: "/platform-logos/GA4.svg",
  search_console: "/platform-logos/searchconsole.svg",
};

/**
 * What each chip says, keyed by why the read cannot run.
 *
 * Two rules bound the wording. The chip may not claim "connected" for a source
 * whose reads the app itself refuses — that is the defect: a header asserting
 * a capability the body below it then denies. And a blocked-but-connected
 * source may not collapse into "not connected", which would send the operator
 * to reconnect something already connected. So each blocked state names the
 * next action instead, in the app's own vocabulary: the Integrations card
 * already captions these two providers "Select Property" and "Select Site",
 * and the SEO body already says "Please reconnect Google."
 *
 * Lowercase, one or two words, to sit inside the design's 10.5px state pill.
 */
const BLOCK_CHIP: Record<
  ProviderReadBlock,
  { stateLabel: string; tone: InsightsSourceChipModel["tone"] }
> = {
  not_connected: { stateLabel: "not connected", tone: "neutral" },
  connection_fault: { stateLabel: "action required", tone: "warning" },
  google_reconnect_required: { stateLabel: "reconnect Google", tone: "warning" },
  property_not_selected: { stateLabel: "select property", tone: "warning" },
  site_not_selected: { stateLabel: "select site", tone: "warning" },
};

/**
 * WP-21: "not connected" is a claim about the provider, and it may only be made
 * once the integration authority has actually been read. Before that the state
 * is unknown, and the chip says so rather than reporting the source as down.
 *
 * E5: "connected" is the stronger claim, and it may only be made once the
 * provider can actually serve a read. The chip takes an effective capability,
 * not a connection row.
 */
export function buildInsightsSourceChip(
  provider: InsightsSourceProvider,
  capability: ProviderReadCapability,
  authorityRead = true,
): InsightsSourceChipModel {
  const base = {
    id: provider,
    label: SOURCE_LABEL[provider],
    iconSrc: SOURCE_ICON[provider],
  };
  if (!authorityRead) {
    return { ...base, stateLabel: "reading status", tone: "neutral" };
  }
  if (capability.canRead) {
    return { ...base, stateLabel: "connected", tone: "positive" };
  }
  // An unread authority is the only unknown; a capability that says it cannot
  // read always says why, so there is no confident default to fall back to.
  return { ...base, ...BLOCK_CHIP[capability.block ?? "not_connected"] };
}

export interface InsightsShellAdapterInput {
  pathname: string;
  /** `resolveGa4ReadCapability` — the GA4 read gate's own predicate. */
  ga4: ProviderReadCapability;
  /** `resolveSearchConsoleReadCapability` — includes the borrowed Google grant. */
  searchConsole: ProviderReadCapability;
  /**
   * Whether the integration manifest for this business has been read yet.
   * Defaults to `true` so a caller that never bootstraps is unchanged.
   */
  authorityRead?: boolean;
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
      buildInsightsSourceChip("ga4", input.ga4, input.authorityRead ?? true),
      buildInsightsSourceChip(
        "search_console",
        input.searchConsole,
        input.authorityRead ?? true,
      ),
    ],
  };
}
