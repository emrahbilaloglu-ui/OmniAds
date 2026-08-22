/**
 * Dashboard v2's reference-defined screen vocabulary.
 *
 * The design prototype is a single-page state machine while Adsecute keeps
 * real, bookmarkable routes. This registry is the one translation layer
 * between those two facts. It intentionally contains no authorization,
 * provider-write, or business-decision logic.
 */
export const DASHBOARD_SCREEN_IDS = [
  "overview",
  "meta",
  // Both routes have existed and worked since before this registry did; what
  // was missing was any entry here, so `dashboardScreenForPath` answered null
  // for them. History then fell through to the Decisions rail row's
  // `activeHrefs` and lit up Decisions, and Intelligence lit up nothing at all
  // (master plan §5.1 findings 3 and 4).
  "meta-intelligence",
  "meta-history",
  "creative",
  "launchpad",
  "automation",
  "google",
  "google-advisor",
  "google-search",
  "google-products",
  "google-assets",
  "google-plan",
  "klaviyo",
  "insights",
  "reports",
  "commercial-truth",
  "integrations",
  "team",
  "settings",
] as const;

export type DashboardScreenId = (typeof DASHBOARD_SCREEN_IDS)[number];

export type DashboardScreenState =
  | "default"
  | "assets"
  | "copies"
  | "landing-pages"
  | "inbox"
  | "audiences"
  | "analytics"
  | "seo"
  | "ai-visibility";

export interface DashboardScreenRoute {
  readonly screen: DashboardScreenId;
  readonly state: DashboardScreenState;
  readonly referenceLabel: string;
}

export const DASHBOARD_REFERENCE_SCREENS: Readonly<
  Record<
    DashboardScreenId,
    { readonly label: string; readonly referenceView: string }
  >
> = {
  overview: { label: "Overview", referenceView: "overview" },
  meta: { label: "Meta Decision Center", referenceView: "meta" },
  // `referenceView` names the design prototype's own view id. These two have
  // none: the design file draws four Meta children and neither is among them.
  // The vendored leaf ledger does carry both (L-C-META-INTEL, L-C-META-HIST),
  // which is the authority D3 follows. The id is recorded as the surface id
  // rather than left blank, so nothing reads as a reference view that does not
  // exist.
  "meta-intelligence": {
    label: "Meta · Account Intelligence",
    referenceView: "meta-intelligence",
  },
  "meta-history": { label: "Meta · History", referenceView: "meta-history" },
  creative: { label: "Creative Studio", referenceView: "creative" },
  launchpad: { label: "Launchpad", referenceView: "launchpad" },
  automation: { label: "Automation", referenceView: "automation" },
  google: { label: "Google Ads · Overview", referenceView: "google" },
  "google-advisor": {
    label: "Google Ads · Advisor",
    referenceView: "gadvisor",
  },
  "google-search": { label: "Google Ads · Search", referenceView: "gsearch" },
  "google-products": {
    label: "Google Ads · Products",
    referenceView: "gproducts",
  },
  "google-assets": {
    label: "Google Ads · Assets & Audiences",
    referenceView: "gassets",
  },
  "google-plan": { label: "Google Ads · Plan", referenceView: "gplan" },
  klaviyo: { label: "Klaviyo", referenceView: "klaviyo" },
  insights: { label: "Insights", referenceView: "insights" },
  reports: { label: "Reports", referenceView: "reports" },
  "commercial-truth": { label: "Commercial Truth", referenceView: "truth" },
  integrations: { label: "Integrations", referenceView: "integrations" },
  team: { label: "Team", referenceView: "team" },
  settings: { label: "Settings", referenceView: "settings" },
};

const route = (
  screen: DashboardScreenId,
  referenceLabel = DASHBOARD_REFERENCE_SCREENS[screen].label,
  state: DashboardScreenState = "default",
): DashboardScreenRoute => ({ screen, state, referenceLabel });

/**
 * `/c/[businessId]/**` is normalized to `/app/**` before this table is read.
 * Detail/create/edit/print routes are deliberately absent because the supplied
 * reference does not define their bodies.
 */
const ROUTES: Readonly<Record<string, DashboardScreenRoute>> = {
  "/overview": route("overview"),
  "/app/home": route("overview"),

  "/platforms/meta": route("meta"),
  "/app/meta/decisions": route("meta"),

  // No `/platforms` spelling for Intelligence: it is new in v2 and the vendored
  // contract has no record of it as a changed legacy path, so there is nothing
  // to shim.
  "/app/meta/intelligence": route("meta-intelligence"),
  "/platforms/meta/history": route("meta-history"),
  "/app/meta/history": route("meta-history"),

  "/platforms/meta/creatives": route("creative", undefined, "assets"),
  "/app/creative/performance": route("creative", undefined, "assets"),
  "/platforms/meta/copies": route("creative", undefined, "copies"),
  "/app/creative/copies": route("creative", undefined, "copies"),
  "/platforms/meta/landing-pages": route(
    "creative",
    undefined,
    "landing-pages",
  ),
  "/app/creative/landing-pages": route("creative", undefined, "landing-pages"),
  "/platforms/meta/creative-inbox": route("creative", undefined, "inbox"),
  "/app/creative/inbox": route("creative", undefined, "inbox"),
  "/platforms/meta/audiences": route("creative", undefined, "audiences"),
  "/app/creative/audiences": route("creative", undefined, "audiences"),
  // Briefs, Shares and Creative Detail are Creative Studio sub-surfaces with no
  // rail row of their own. Without these entries they resolved to no screen, so
  // the whole Meta platform group went inactive the moment an operator opened a
  // brief — the rail said they had left Meta.
  "/app/creative/briefs": route("creative", undefined, "assets"),
  "/app/creative/shares": route("creative", undefined, "assets"),

  "/platforms/meta/launchpad": route("launchpad"),
  "/app/meta/launchpad": route("launchpad"),
  "/platforms/meta/automation": route("automation"),
  "/app/meta/automation": route("automation"),

  "/platforms/google": route("google"),
  "/app/google/overview": route("google"),
  "/platforms/google/advisor": route("google-advisor"),
  "/app/google/advisor": route("google-advisor"),
  "/platforms/google/search": route("google-search"),
  "/app/google/search": route("google-search"),
  "/platforms/google/products": route("google-products"),
  "/app/google/products": route("google-products"),
  "/platforms/google/assets": route("google-assets"),
  "/app/google/assets-audiences": route("google-assets"),
  "/platforms/google/plan": route("google-plan"),
  "/app/google/plan": route("google-plan"),

  // The design has exactly one Klaviyo screen; its four tab pills carry no
  // handler and no route, so the flows/campaigns/templates/segments spellings
  // are gone rather than aliased onto the same body.
  "/platforms/klaviyo": route("klaviyo"),
  "/app/klaviyo": route("klaviyo"),

  "/insights": route("insights", undefined, "analytics"),
  "/insights/analytics": route("insights", undefined, "analytics"),
  "/app/analytics/ga4-shopify": route("insights", undefined, "analytics"),
  "/app/analytics/landing-pages": route("insights", undefined, "analytics"),
  "/insights/seo": route("insights", undefined, "seo"),
  "/app/analytics/seo": route("insights", undefined, "seo"),
  "/insights/ai-visibility": route("insights", undefined, "ai-visibility"),
  "/app/analytics/geo": route("insights", undefined, "ai-visibility"),

  "/reports": route("reports"),
  "/app/reports": route("reports"),
  "/commercial-truth": route("commercial-truth"),
  "/app/manage/business": route("commercial-truth"),
  "/integrations": route("integrations"),
  "/app/manage/integrations": route("integrations"),
  "/team": route("team"),
  "/app/manage/team": route("team"),
  "/settings": route("settings"),
  "/app/manage/plan": route("settings"),
};

/** Public `/app/**` spellings for reference-bound legacy destinations. */
const APP_PATH_BY_LEGACY_PATH: Readonly<Record<string, string>> = {
  "/overview": "/app/home",
  "/platforms/meta": "/app/meta/decisions",
  "/platforms/meta/history": "/app/meta/history",
  "/platforms/meta/intelligence": "/app/meta/intelligence",
  "/platforms/meta/creatives": "/app/creative/performance",
  "/platforms/meta/copies": "/app/creative/copies",
  "/platforms/meta/landing-pages": "/app/creative/landing-pages",
  "/platforms/meta/creative-inbox": "/app/creative/inbox",
  "/platforms/meta/audiences": "/app/creative/audiences",
  "/platforms/meta/launchpad": "/app/meta/launchpad",
  "/platforms/meta/automation": "/app/meta/automation",
  "/platforms/google": "/app/google/overview",
  "/platforms/google/pulse": "/app/google/overview",
  "/platforms/google/advisor": "/app/google/advisor",
  "/platforms/google/search": "/app/google/search",
  "/platforms/google/keywords": "/app/google/search",
  "/platforms/google/products": "/app/google/products",
  "/platforms/google/assets": "/app/google/assets-audiences",
  "/platforms/google/audiences": "/app/google/assets-audiences",
  "/platforms/google/plan": "/app/google/plan",
  "/platforms/google/launchpad": "/app/google/plan",
  "/platforms/klaviyo": "/app/klaviyo",
  "/insights": "/app/analytics/ga4-shopify",
  "/insights/analytics": "/app/analytics/ga4-shopify",
  "/insights/seo": "/app/analytics/seo",
  "/insights/ai-visibility": "/app/analytics/geo",
  "/reports": "/app/reports",
  "/commercial-truth": "/app/manage/business",
  "/integrations": "/app/manage/integrations",
  "/team": "/app/manage/team",
  "/settings": "/app/manage/plan",
};

export function normalizeDashboardPath(pathname: string): string {
  const withoutQuery = pathname.split(/[?#]/, 1)[0] || "/";
  const normalized = withoutQuery.replace(/^\/c\/[^/]+(?=\/|$)/, "/app");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function dashboardScreenForPath(
  pathname: string,
): DashboardScreenRoute | null {
  return ROUTES[normalizeDashboardPath(pathname)] ?? null;
}

/**
 * Keeps a shell navigation target inside the route family currently in use.
 * A direct `/c/:businessId/**` request retains that explicit authorized scope;
 * `/app/**` retains its session-scoped public spelling; legacy stays legacy.
 */
export function dashboardHrefForRouteFamily(
  href: string,
  currentPathname: string,
): string {
  const [withoutHash, hash = ""] = href.split("#", 2);
  const [pathname, query = ""] = withoutHash.split("?", 2);
  const appPath =
    APP_PATH_BY_LEGACY_PATH[pathname] ??
    (pathname.startsWith("/reports/")
      ? `/app/reports${pathname.slice("/reports".length)}`
      : /**
         * An href already written in the `/app` spelling is its own app path.
         *
         * Surfaces added in v2 — Account Intelligence, Creative Briefs, Creative
         * Shares — have no pre-v2 route, so there is no legacy key to look up
         * and nothing to invent one from. Passing such an href through
         * unchanged sent a `/c/:businessId` visitor to `/app/**`, which
         * re-scopes from `session.activeBusinessId` and can therefore land them
         * in a *different business* than the one they were explicitly reading.
         * Recognising the spelling keeps the rewrite below in charge, so the
         * explicit scope survives the click.
         */
        pathname === "/app" || pathname.startsWith("/app/")
        ? pathname
        : null);
  if (!appPath) return href;

  const scopedMatch = currentPathname.match(/^\/c\/([^/?#]+)(?:\/|$)/);
  const familyPath = scopedMatch
    ? appPath.replace(/^\/app/, `/c/${scopedMatch[1]}`)
    : currentPathname === "/app" || currentPathname.startsWith("/app/")
      ? appPath
      : pathname;
  return `${familyPath}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
}

export function dashboardReferenceRouteEntries(): ReadonlyArray<
  readonly [string, DashboardScreenRoute]
> {
  return Object.entries(ROUTES);
}
