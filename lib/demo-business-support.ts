export const DEMO_BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
/**
 * The one Meta ad account the demo workspace is authorized for.
 *
 * ── ROUND 9 ITEM 9 ─────────────────────────────────────────────────────────
 * `app/api/meta/recommendations/route.ts` had invented its own
 * `demo:meta-account` sentinel for demo scoping, which conflicted with the id
 * the rest of the product already serves everywhere: `getDemoIntegrations()`
 * publishes it as the connected Meta account, `listDemoProviderAccounts()`
 * lists it as "UrbanTrail DTC", `getDemoMetaBreakdowns()` is keyed on it, and
 * the demo business summary assigns it. Two sentinels for one demo account
 * means a request naming the id the UI shows is refused by the route that is
 * supposed to serve it.
 *
 * Named here, beside the business id, and imported by every other demo source
 * rather than retyped — which is what let the literal drift in the first place.
 */
export const DEMO_META_PROVIDER_ACCOUNT_ID = "act_210009998877";
export const DEMO_BUSINESS_NAME = "Adsecute Demo";

export type DemoAssignableProvider = "meta" | "google";

export interface DemoProviderAccount {
  id: string;
  name: string;
  currency?: string;
  timezone?: string;
  isManager?: boolean;
}

export interface DemoGa4Property {
  propertyId: string;
  propertyName: string;
  accountId: string;
  accountName: string;
}

function getDemoIsoNow() {
  return new Date().toISOString();
}

export interface DemoBusinessSummary {
  id: string;
  name: string;
  timezone: string;
  currency: string;
  role: "admin";
  membershipStatus: "active";
  isDemoBusiness: true;
  industry: "ecommerce";
  platform: "shopify";
}

export type ProductRow = {
  product_id: string;
  title: string;
  category: string;
  price: number;
  compare_at_price: number;
  description: string;
  image_url: string;
  inventory: number;
  reviews_count: number;
  rating: number;
};

export const DEMO_PRODUCTS: ProductRow[] = [
  { product_id: "ut-001", title: "UrbanTrail Explorer Backpack", category: "Backpacks", price: 89, compare_at_price: 109, description: "All-day carry backpack with weather-resistant shell.", image_url: "/demo/urbantrail/explorer-backpack.svg", inventory: 142, reviews_count: 324, rating: 4.7 },
  { product_id: "ut-002", title: "UrbanTrail Travel Duffel", category: "Travel Bags", price: 99, compare_at_price: 119, description: "Convertible duffel with structured base and shoe pocket.", image_url: "/demo/urbantrail/travel-duffel.svg", inventory: 98, reviews_count: 201, rating: 4.6 },
  { product_id: "ut-003", title: "UrbanTrail Daypack Lite", category: "Backpacks", price: 59, compare_at_price: 79, description: "Lightweight everyday daypack with breathable back panel.", image_url: "/demo/urbantrail/daypack-lite.svg", inventory: 210, reviews_count: 186, rating: 4.5 },
  { product_id: "ut-004", title: "UrbanTrail Hiking Backpack Pro", category: "Backpacks", price: 129, compare_at_price: 149, description: "Technical hiking pack with frame support and hydration slot.", image_url: "/demo/urbantrail/hiking-pro.svg", inventory: 76, reviews_count: 273, rating: 4.8 },
  { product_id: "ut-005", title: "UrbanTrail Travel Organizer", category: "Organizers", price: 29, compare_at_price: 39, description: "Compact organizer for cables, passport, and accessories.", image_url: "/demo/urbantrail/travel-organizer.svg", inventory: 391, reviews_count: 149, rating: 4.4 },
  { product_id: "ut-006", title: "UrbanTrail Waterproof Backpack", category: "Backpacks", price: 109, compare_at_price: 129, description: "Roll-top waterproof backpack for rain and outdoor trips.", image_url: "/demo/urbantrail/waterproof-backpack.svg", inventory: 81, reviews_count: 228, rating: 4.7 },
  { product_id: "ut-007", title: "UrbanTrail Laptop Travel Bag", category: "Travel Bags", price: 79, compare_at_price: 99, description: "Padded 16-inch laptop compartment with TSA-friendly layout.", image_url: "/demo/urbantrail/laptop-travel-bag.svg", inventory: 117, reviews_count: 167, rating: 4.6 },
  { product_id: "ut-008", title: "UrbanTrail Packing Cubes", category: "Organizers", price: 39, compare_at_price: 49, description: "Set of 4 compression cubes for efficient packing.", image_url: "/demo/urbantrail/packing-cubes.svg", inventory: 260, reviews_count: 118, rating: 4.5 },
  { product_id: "ut-009", title: "UrbanTrail Carry-On Backpack", category: "Backpacks", price: 119, compare_at_price: 139, description: "Airline-ready carry-on backpack with clamshell opening.", image_url: "/demo/urbantrail/carry-on-backpack.svg", inventory: 69, reviews_count: 301, rating: 4.8 },
  { product_id: "ut-010", title: "UrbanTrail Hiking Waist Pack", category: "Accessories", price: 35, compare_at_price: 45, description: "Slim waist pack for essentials on trail runs and day hikes.", image_url: "/demo/urbantrail/waist-pack.svg", inventory: 238, reviews_count: 92, rating: 4.3 },
  { product_id: "ut-011", title: "UrbanTrail Adventure Backpack", category: "Backpacks", price: 95, compare_at_price: 119, description: "Multi-use pack for commuting, gym, and weekend escapes.", image_url: "/demo/urbantrail/adventure-backpack.svg", inventory: 121, reviews_count: 211, rating: 4.6 },
  { product_id: "ut-012", title: "UrbanTrail Outdoor Sling Bag", category: "Accessories", price: 49, compare_at_price: 65, description: "Crossbody sling bag with anti-theft zip and quick-access pockets.", image_url: "/demo/urbantrail/outdoor-sling.svg", inventory: 184, reviews_count: 133, rating: 4.5 },
];

export const DEMO_DEMOGRAPHICS: Record<string, Array<{ value: string; sessions: number; engagedSessions: number; engagementRate: number; purchases: number; revenue: number; purchaseCvr: number }>> = {
  country: [
    { value: "United States", sessions: 28100, engagedSessions: 16500, engagementRate: 0.587, purchases: 741, revenue: 62320, purchaseCvr: 0.0264 },
    { value: "Canada", sessions: 7140, engagedSessions: 3920, engagementRate: 0.549, purchases: 162, revenue: 12920, purchaseCvr: 0.0227 },
    { value: "United Kingdom", sessions: 5080, engagedSessions: 2930, engagementRate: 0.577, purchases: 123, revenue: 10150, purchaseCvr: 0.0242 },
  ],
  region: [
    { value: "California", sessions: 9420, engagedSessions: 5620, engagementRate: 0.597, purchases: 252, revenue: 21320, purchaseCvr: 0.0268 },
    { value: "Texas", sessions: 5440, engagedSessions: 3110, engagementRate: 0.571, purchases: 138, revenue: 11240, purchaseCvr: 0.0254 },
    { value: "New York", sessions: 4920, engagedSessions: 2860, engagementRate: 0.581, purchases: 119, revenue: 9920, purchaseCvr: 0.0242 },
  ],
  city: [
    { value: "Los Angeles", sessions: 3320, engagedSessions: 2040, engagementRate: 0.614, purchases: 92, revenue: 7740, purchaseCvr: 0.0277 },
    { value: "New York", sessions: 2890, engagedSessions: 1710, engagementRate: 0.592, purchases: 72, revenue: 6060, purchaseCvr: 0.0249 },
    { value: "Toronto", sessions: 1820, engagedSessions: 1010, engagementRate: 0.555, purchases: 41, revenue: 3250, purchaseCvr: 0.0225 },
  ],
  language: [
    { value: "en-us", sessions: 34910, engagedSessions: 20120, engagementRate: 0.576, purchases: 901, revenue: 73820, purchaseCvr: 0.0258 },
    { value: "en-gb", sessions: 6210, engagedSessions: 3530, engagementRate: 0.568, purchases: 151, revenue: 12450, purchaseCvr: 0.0243 },
    { value: "fr-ca", sessions: 2140, engagedSessions: 1160, engagementRate: 0.542, purchases: 47, revenue: 3760, purchaseCvr: 0.022 },
  ],
  userAgeBracket: [
    { value: "25-34", sessions: 16800, engagedSessions: 9760, engagementRate: 0.581, purchases: 442, revenue: 36820, purchaseCvr: 0.0263 },
    { value: "35-44", sessions: 12340, engagedSessions: 7140, engagementRate: 0.579, purchases: 330, revenue: 27910, purchaseCvr: 0.0267 },
    { value: "18-24", sessions: 9210, engagedSessions: 4780, engagementRate: 0.519, purchases: 173, revenue: 12920, purchaseCvr: 0.0188 },
  ],
  userGender: [
    { value: "male", sessions: 24410, engagedSessions: 13890, engagementRate: 0.569, purchases: 601, revenue: 48750, purchaseCvr: 0.0246 },
    { value: "female", sessions: 22620, engagedSessions: 12980, engagementRate: 0.574, purchases: 562, revenue: 46220, purchaseCvr: 0.0248 },
    { value: "unknown", sessions: 1180, engagedSessions: 610, engagementRate: 0.517, purchases: 21, revenue: 1450, purchaseCvr: 0.0178 },
  ],
  brandingInterest: [
    { value: "Travel Buffs", sessions: 12010, engagedSessions: 7230, engagementRate: 0.602, purchases: 336, revenue: 27110, purchaseCvr: 0.028 },
    { value: "Outdoor Enthusiasts", sessions: 9410, engagedSessions: 5560, engagementRate: 0.591, purchases: 266, revenue: 21980, purchaseCvr: 0.0283 },
    { value: "Commuter Professionals", sessions: 7760, engagedSessions: 4150, engagementRate: 0.535, purchases: 165, revenue: 14230, purchaseCvr: 0.0213 },
  ],
};

export function getDemoBusinessSummary(): DemoBusinessSummary {
  return {
    id: DEMO_BUSINESS_ID,
    name: DEMO_BUSINESS_NAME,
    timezone: "America/Los_Angeles",
    currency: "USD",
    role: "admin",
    membershipStatus: "active",
    isDemoBusiness: true,
    industry: "ecommerce",
    platform: "shopify",
  };
}

export function getDemoIntegrations() {
  const now = getDemoIsoNow();
  const providers = [
    "shopify",
    "meta",
    "google",
    "ga4",
    "search_console",
    "klaviyo",
    "tiktok",
    "pinterest",
    "snapchat",
  ];
  return providers.map((provider) => ({
    id: `demo-${provider}`,
    business_id: DEMO_BUSINESS_ID,
    provider,
    status: provider === "tiktok" || provider === "pinterest" || provider === "snapchat" ? "disconnected" : "connected",
    provider_account_id:
      provider === "shopify"
        ? "urbantrail.myshopify.com"
        : provider === "google"
        ? "5241455382"
        : provider === "meta"
          ? DEMO_META_PROVIDER_ACCOUNT_ID
          : provider === "ga4"
            ? "properties/3322114455"
            : provider === "search_console"
              ? "sc-domain:urbantrail.co"
          : provider === "klaviyo"
            ? "X8Y72L"
            : null,
    provider_account_name:
      provider === "shopify"
        ? "UrbanTrail"
        : provider === "google"
        ? "UrbanTrail US"
        : provider === "meta"
          ? "UrbanTrail DTC"
          : provider === "ga4"
            ? "UrbanTrail Store GA4"
            : provider === "search_console"
              ? "urbantrail.co"
          : provider === "klaviyo"
            ? "UrbanTrail Lifecycle"
            : null,
    access_token: null,
    refresh_token: null,
    token_expires_at: null,
    scopes: null,
    error_message: null,
    metadata:
      provider === "ga4"
        ? { propertyId: "3322114455", propertyName: "UrbanTrail Store GA4", propertyResourceName: "properties/3322114455", selectedAt: now }
        : provider === "search_console"
          ? { siteUrl: "sc-domain:urbantrail.co", siteType: "domain", propertyName: "urbantrail.co", connectedAt: now }
          : provider === "shopify"
            ? { storeName: "UrbanTrail", platform: "shopify", syncedAt: now }
            : provider === "klaviyo"
              ? {
                  accountName: "UrbanTrail Lifecycle",
                  channelMix: { email: 0.74, sms: 0.26 },
                  benchmarkTier: "shopify_growth",
                  syncedAt: now,
                }
              : {},
    connected_at: now,
    disconnected_at: null,
    created_at: now,
    updated_at: now,
  }));
}

export function getDemoIntegration(provider: string) {
  return getDemoIntegrations().find((item) => item.provider === provider) ?? null;
}

export function getDemoProviderAccounts(
  provider: DemoAssignableProvider
): DemoProviderAccount[] {
  if (provider === "google") {
    return [
      {
        id: "5241455382",
        name: "UrbanTrail US",
        currency: "USD",
        timezone: "America/Los_Angeles",
        isManager: false,
      },
      {
        id: "6317742091",
        name: "UrbanTrail Canada",
        currency: "CAD",
        timezone: "America/Toronto",
        isManager: false,
      },
      {
        id: "8421193045",
        name: "UrbanTrail Experiments",
        currency: "USD",
        timezone: "America/Chicago",
        isManager: false,
      },
    ];
  }

  return [
    {
      id: DEMO_META_PROVIDER_ACCOUNT_ID,
      name: "UrbanTrail DTC",
      currency: "USD",
      timezone: "America/Los_Angeles",
      isManager: false,
    },
    {
      id: "act_210009998901",
      name: "UrbanTrail Prospecting",
      currency: "USD",
      timezone: "America/New_York",
      isManager: false,
    },
    {
      id: "act_210009998955",
      name: "UrbanTrail Retention",
      currency: "USD",
      timezone: "America/Chicago",
      isManager: false,
    },
  ];
}

export function getDemoGa4Properties(): DemoGa4Property[] {
  return [
    {
      propertyId: "properties/3322114455",
      propertyName: "UrbanTrail Store GA4",
      accountId: "accounts/90112233",
      accountName: "UrbanTrail Analytics",
    },
    {
      propertyId: "properties/3322114466",
      propertyName: "UrbanTrail Blog GA4",
      accountId: "accounts/90112233",
      accountName: "UrbanTrail Analytics",
    },
  ];
}

export function getDemoBillingState() {
  return {
    connected: true,
    planId: "pro" as const,
    planName: "Pro",
    monthlyPrice: 99,
    status: "active",
    shopId: "urbantrail.myshopify.com",
    storeName: "UrbanTrail",
    source: "demo" as const,
  };
}

export function getDemoSelectedGa4PropertyId() {
  const integration = getDemoIntegration("ga4");
  const metadata =
    integration?.metadata && typeof integration.metadata === "object"
      ? (integration.metadata as Record<string, unknown>)
      : null;
  const propertyId = metadata?.propertyResourceName;
  return typeof propertyId === "string" ? propertyId : null;
}

export function getDemoProviderDiscoveryPayload(
  provider: DemoAssignableProvider
) {
  const assignedId = getDemoIntegration(provider)?.provider_account_id ?? null;
  const now = getDemoIsoNow();

  return {
    data: getDemoProviderAccounts(provider).map((account) => ({
      ...account,
      assigned: assignedId === account.id,
    })),
    meta: {
      source: "snapshot" as const,
      sourceHealth: "healthy_cached" as const,
      fetchedAt: now,
      stale: false,
      refreshFailed: false,
      failureClass: null,
      lastError: null,
      lastKnownGoodAvailable: true,
      refreshRequestedAt: null,
      lastRefreshAttemptAt: null,
      nextRefreshAfter: null,
      retryAfterAt: null,
      refreshInProgress: false,
      sourceReason: "demo_fixture",
    },
    notice: "Using demo workspace fixture data.",
  };
}
