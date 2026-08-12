export interface PublicRouteRedirect {
  destination: string;
  businessId: string | null;
}

const LEGACY_EXACT: Record<string, string> = {
  "/overview": "/app/home",
  "/platforms/meta": "/app/meta/decisions",
  "/platforms/meta/creatives": "/app/creative/performance",
  "/platforms/meta/creative-inbox": "/app/creative/inbox",
  "/platforms/meta/copies": "/app/creative/copies",
  "/platforms/meta/landing-pages": "/app/creative/landing-pages",
  "/platforms/meta/audiences": "/app/meta/intelligence",
  "/platforms/meta/automation": "/app/meta/automation",
  "/platforms/meta/history": "/app/meta/history",
  "/platforms/meta/launchpad": "/app/meta/launchpad",
  "/platforms/google": "/app/google/overview",
  "/platforms/google/ads": "/app/google/overview",
  "/platforms/google/pulse": "/app/google/advisor",
  "/platforms/google/keywords": "/app/google/search",
  "/platforms/google/audiences": "/app/google/assets-audiences",
  "/platforms/google/launchpad": "/app/google/plan",
  "/platforms/klaviyo": "/app/manage/integrations",
  "/platforms/klaviyo/campaigns": "/app/manage/integrations",
  "/platforms/klaviyo/flows": "/app/manage/integrations",
  "/platforms/klaviyo/segments": "/app/manage/integrations",
  "/platforms/klaviyo/templates": "/app/manage/integrations",
  "/platforms/pinterest": "/app/manage/integrations",
  "/platforms/snapchat": "/app/manage/integrations",
  "/platforms/tiktok": "/app/manage/integrations",
  "/insights": "/app/analytics/ga4-shopify",
  "/insights/analytics": "/app/analytics/landing-pages",
  "/insights/seo": "/app/analytics/seo",
  "/insights/ai-visibility": "/app/analytics/geo",
  "/integrations": "/app/manage/integrations",
  "/team": "/app/manage/team",
  "/commercial-truth": "/app/manage/business",
  "/settings": "/app/manage/business",
};

/** Resolve every retired dashboard spelling before a React tree can mount. */
export function resolvePublicRouteRedirect(pathname: string): PublicRouteRedirect | null {
  const scoped = pathname.match(/^\/c\/([^/]+)(\/.*)?$/);
  if (scoped) {
    const businessId = decodeURIComponent(scoped[1]!);
    const rest = scoped[2] || "/home";
    return { destination: `/app${rest}`, businessId };
  }

  const exact = LEGACY_EXACT[pathname];
  if (exact) return { destination: exact, businessId: null };

  if (pathname === "/reports" || pathname.startsWith("/reports/")) {
    return { destination: `/app${pathname}`, businessId: null };
  }

  const callback = pathname.match(/^\/integrations\/callback\/([^/]+)$/);
  if (callback) {
    return {
      destination: `/app/manage/integrations/callback/${encodeURIComponent(callback[1]!)}`,
      businessId: null,
    };
  }

  return null;
}
