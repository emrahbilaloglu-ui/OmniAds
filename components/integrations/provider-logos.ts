import type { IntegrationProvider } from "@/store/integrations-store";

/** design 4315-4321 / 4349-4353 `logo` — the same marks, greyed on roadmap cards. */
export function getProviderLogo(provider: IntegrationProvider): string | null {
  switch (provider) {
    case "meta": return "/platform-logos/Meta.png";
    case "google": return "/platform-logos/googleAds.svg";
    case "ga4": return "/platform-logos/GA4.svg";
    case "search_console": return "/platform-logos/searchconsole.svg";
    case "shopify": return "/platform-logos/shopify_glyph.svg";
    case "tiktok": return "/platform-logos/tiktok.svg";
    case "pinterest": return "/platform-logos/Pinterest.svg";
    case "snapchat": return "/platform-logos/snapchat.svg";
    case "klaviyo": return "/platform-logos/Klaviyo.svg";
    default: return null;
  }
}
