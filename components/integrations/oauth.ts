import { IntegrationProvider } from "@/store/integrations-store";

/** The design's provider captions (model 4315-4321, 4349-4353). */
const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  shopify: "Shopify",
  meta: "Meta Ads",
  google: "Google Ads",
  search_console: "Search Console",
  tiktok: "TikTok Ads",
  pinterest: "Pinterest",
  snapchat: "Snapchat",
  ga4: "GA4",
  klaviyo: "Klaviyo",
};

export function getOAuthStartUrl(
  provider: IntegrationProvider,
  businessId: string,
  returnTo: string,
  options?: { shop?: string },
) {
  // GA4 uses a different route segment than the provider name
  const routeProvider =
    provider === "ga4"
      ? "google-analytics"
      : provider === "search_console"
        ? "google"
        : provider;
  const url = `/api/oauth/${routeProvider}/start?businessId=${businessId}&returnTo=${encodeURIComponent(
    returnTo,
  )}${provider === "search_console" ? "&provider=search_console" : ""}`;
  if (options?.shop) {
    return `${url}&shop=${encodeURIComponent(options.shop)}`;
  }
  return url;
}

export function getProviderLabel(provider: IntegrationProvider) {
  return PROVIDER_LABELS[provider];
}
