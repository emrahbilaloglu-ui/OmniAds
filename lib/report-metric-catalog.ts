import type {
  CustomReportBreakdown,
  CustomReportDataSource,
  CustomReportPlatform,
  CustomReportWidgetDefinition,
  CustomReportWidgetType,
} from "@/lib/custom-reports";

export interface ReportMetricCatalogItem {
  value: string;
  label: string;
}

export interface ReportColumnCatalogItem {
  value: string;
  label: string;
}

interface ReportWidgetCatalogEntry {
  dataSource: CustomReportDataSource;
  metrics?: ReportMetricCatalogItem[];
  columns?: ReportColumnCatalogItem[];
  breakdowns?: Array<{ value: CustomReportBreakdown; label: string; group?: string }>;
  defaultMetric?: string;
  defaultColumns?: string[];
}

export interface ReportPlatformCatalogEntry {
  id: CustomReportPlatform;
  label: string;
  logoSrc?: string;
  supported: boolean;
  accountScoped: boolean;
  widgets: Partial<Record<"metric" | "trend" | "bar" | "table", ReportWidgetCatalogEntry>>;
}

const META_METRICS: ReportMetricCatalogItem[] = [
  { value: "spend", label: "Amount Spent" },
  { value: "revenue", label: "Revenue" },
  { value: "purchases", label: "Website Purchases" },
  { value: "roas", label: "ROAS (Website)" },
  { value: "cpa", label: "Cost per Website Purchase" },
  { value: "clicks", label: "Clicks" },
  { value: "outboundClicks", label: "Outbound Clicks" },
  { value: "uniqueClicks", label: "Unique Clicks" },
  { value: "ctr", label: "CTR" },
  { value: "outboundCtr", label: "Outbound CTR" },
  { value: "uniqueCtr", label: "Unique CTR" },
  { value: "cpm", label: "CPM" },
  { value: "cpc", label: "CPC (All Clicks)" },
  { value: "cpp", label: "CPP" },
  { value: "impressions", label: "Impressions" },
  { value: "reach", label: "Reach" },
  { value: "frequency", label: "Frequency" },
  { value: "landingPageViews", label: "Landing Page Views" },
  { value: "costPerLandingPageView", label: "Cost per Landing Page View" },
  { value: "addToCart", label: "Adds to Cart" },
  { value: "addToCartValue", label: "Adds to Cart Value" },
  { value: "costPerAddToCart", label: "Cost per Add to Cart" },
  { value: "initiateCheckout", label: "Checkouts Initiated" },
  { value: "initiateCheckoutValue", label: "Checkouts Initiated Value" },
  { value: "costPerCheckoutInitiated", label: "Cost per Checkout Initiated" },
  { value: "leads", label: "Leads (All)" },
  { value: "leadsValue", label: "Leads Value" },
  { value: "costPerLead", label: "Cost per Lead (All)" },
  { value: "contentViews", label: "Content Views" },
  { value: "contentViewsValue", label: "Content Views Value" },
  { value: "costPerContentView", label: "Cost per Content View" },
  { value: "registrationsCompleted", label: "Registrations Completed" },
  { value: "registrationsCompletedValue", label: "Registrations Completed Value" },
  { value: "costPerRegistrationCompleted", label: "Cost per Registration Completed" },
  { value: "searches", label: "Searches" },
  { value: "searchesValue", label: "Searches Value" },
  { value: "costPerSearch", label: "Cost per Search" },
  { value: "addPaymentInfo", label: "Add Payment Info" },
  { value: "addPaymentInfoValue", label: "Add Payment Info Value" },
  { value: "costPerAddPaymentInfo", label: "Cost per Add Payment Info" },
  { value: "pageLikes", label: "Page Likes" },
  { value: "costPerPageLike", label: "Cost per Page Like" },
  { value: "postEngagement", label: "Post Engagement" },
  { value: "costPerEngagement", label: "Cost per Engagement" },
  { value: "postReactions", label: "Post Reactions" },
  { value: "costPerReaction", label: "Cost per Reaction" },
  { value: "postComments", label: "Post Comments" },
  { value: "costPerPostComment", label: "Cost per Post Comment" },
  { value: "postShares", label: "Post Shares" },
  { value: "costPerPostShare", label: "Cost per Post Share" },
  { value: "messagingConversationsStarted", label: "Messenger Conversation Started" },
  { value: "costPerMessagingConversationStarted", label: "Cost Per Messenger Conversation Started" },
  { value: "appInstalls", label: "Mobile App Installs" },
  { value: "costPerAppInstall", label: "Cost Per Mobile App Install" },
  { value: "videoViews3s", label: "3-Second Video Views" },
  { value: "videoViews15s", label: "15-Second Video Views" },
  { value: "videoViews25", label: "Video Watches at 25%" },
  { value: "videoViews50", label: "Video Watches at 50%" },
  { value: "videoViews75", label: "Video Watches at 75%" },
  { value: "videoViews95", label: "Video Watches at 95%" },
  { value: "videoViews100", label: "Video Watches at 100%" },
  { value: "costPerVideoView", label: "Cost per Video View" },
];

const GOOGLE_METRICS: ReportMetricCatalogItem[] = [
  { value: "spend", label: "Spend" },
  { value: "revenue", label: "Revenue" },
  { value: "conversions", label: "Conversions" },
  { value: "roas", label: "ROAS" },
  { value: "cpa", label: "CPA" },
  { value: "ctr", label: "CTR" },
  { value: "impressions", label: "Impressions" },
  { value: "clicks", label: "Clicks" },
  { value: "cpc", label: "Average CPC" },
  { value: "averageCost", label: "Average Cost" },
  { value: "interactions", label: "Interactions" },
  { value: "interactionRate", label: "Interaction Rate" },
  { value: "conversionRate", label: "Conversion Rate" },
  { value: "costPerConversion", label: "Cost per Conversion" },
  { value: "valuePerConversion", label: "Value per Conversion" },
  { value: "videoViews", label: "Video Views" },
  { value: "videoViewRate", label: "Video View Rate" },
  { value: "engagements", label: "Engagements" },
  { value: "engagementRate", label: "Engagement Rate" },
];

const ALL_METRICS: ReportMetricCatalogItem[] = [
  { value: "spend", label: "Spend" },
  { value: "revenue", label: "Revenue" },
  { value: "purchases", label: "Purchases" },
  { value: "roas", label: "ROAS" },
];

const META_COLUMNS: ReportColumnCatalogItem[] = [
  { value: "name", label: "Campaign Name" },
  { value: "status", label: "Status" },
  { value: "spend", label: "Amount Spent" },
  { value: "revenue", label: "Revenue" },
  { value: "purchases", label: "Website Purchases" },
  { value: "roas", label: "ROAS (Website)" },
  { value: "cpa", label: "Cost per Website Purchase" },
  { value: "ctr", label: "CTR" },
  { value: "cpm", label: "CPM" },
  { value: "impressions", label: "Impressions" },
  { value: "clicks", label: "Clicks" },
  { value: "currency", label: "Currency" },
  { value: "reach", label: "Reach" },
  { value: "frequency", label: "Frequency" },
  { value: "cpc", label: "CPC (All Clicks)" },
  { value: "cpp", label: "CPP" },
  { value: "uniqueClicks", label: "Unique Clicks" },
  { value: "uniqueCtr", label: "Unique CTR" },
  { value: "outboundClicks", label: "Outbound Clicks" },
  { value: "outboundCtr", label: "Outbound CTR" },
  { value: "uniqueOutboundClicks", label: "Unique Outbound Clicks" },
  { value: "uniqueOutboundCtr", label: "Unique Outbound CTR" },
  { value: "landingPageViews", label: "Landing Page Views" },
  { value: "costPerLandingPageView", label: "Cost per Landing Page View" },
  { value: "addToCart", label: "Adds to Cart" },
  { value: "addToCartValue", label: "Adds to Cart Value" },
  { value: "costPerAddToCart", label: "Cost per Add to Cart" },
  { value: "initiateCheckout", label: "Checkouts Initiated" },
  { value: "initiateCheckoutValue", label: "Checkouts Initiated Value" },
  { value: "costPerCheckoutInitiated", label: "Cost per Checkout Initiated" },
  { value: "leads", label: "Leads (All)" },
  { value: "leadsValue", label: "Leads Value" },
  { value: "costPerLead", label: "Cost per Lead (All)" },
  { value: "contentViews", label: "Content Views" },
  { value: "contentViewsValue", label: "Content Views Value" },
  { value: "costPerContentView", label: "Cost per Content View" },
  { value: "registrationsCompleted", label: "Registrations Completed" },
  { value: "registrationsCompletedValue", label: "Registrations Completed Value" },
  { value: "costPerRegistrationCompleted", label: "Cost per Registration Completed" },
  { value: "searches", label: "Searches" },
  { value: "searchesValue", label: "Searches Value" },
  { value: "costPerSearch", label: "Cost per Search" },
  { value: "addPaymentInfo", label: "Add Payment Info" },
  { value: "addPaymentInfoValue", label: "Add Payment Info Value" },
  { value: "costPerAddPaymentInfo", label: "Cost per Add Payment Info" },
  { value: "pageLikes", label: "Page Likes" },
  { value: "costPerPageLike", label: "Cost per Page Like" },
  { value: "postEngagement", label: "Post Engagement" },
  { value: "costPerEngagement", label: "Cost per Engagement" },
  { value: "postReactions", label: "Post Reactions" },
  { value: "costPerReaction", label: "Cost per Reaction" },
  { value: "postComments", label: "Post Comments" },
  { value: "costPerPostComment", label: "Cost per Post Comment" },
  { value: "postShares", label: "Post Shares" },
  { value: "costPerPostShare", label: "Cost per Post Share" },
  { value: "messagingConversationsStarted", label: "Messenger Conversation Started" },
  { value: "costPerMessagingConversationStarted", label: "Cost Per Messenger Conversation Started" },
  { value: "appInstalls", label: "Mobile App Installs" },
  { value: "costPerAppInstall", label: "Cost Per Mobile App Install" },
  { value: "videoViews3s", label: "3-Second Video Views" },
  { value: "videoViews15s", label: "15-Second Video Views" },
  { value: "videoViews25", label: "Video Watches at 25%" },
  { value: "videoViews50", label: "Video Watches at 50%" },
  { value: "videoViews75", label: "Video Watches at 75%" },
  { value: "videoViews95", label: "Video Watches at 95%" },
  { value: "videoViews100", label: "Video Watches at 100%" },
  { value: "costPerVideoView", label: "Cost per Video View" },
];

const GOOGLE_COLUMNS: ReportColumnCatalogItem[] = [
  { value: "name", label: "Campaign Name" },
  { value: "status", label: "Status" },
  { value: "spend", label: "Spend" },
  { value: "revenue", label: "Revenue" },
  { value: "conversions", label: "Conversions" },
  { value: "roas", label: "ROAS" },
  { value: "cpa", label: "CPA" },
  { value: "ctr", label: "CTR" },
  { value: "impressions", label: "Impressions" },
  { value: "clicks", label: "Clicks" },
  { value: "cpc", label: "Average CPC" },
  { value: "averageCost", label: "Average Cost" },
  { value: "interactions", label: "Interactions" },
  { value: "interactionRate", label: "Interaction Rate" },
  { value: "conversionRate", label: "Conversion Rate" },
  { value: "costPerConversion", label: "Cost per Conversion" },
  { value: "valuePerConversion", label: "Value per Conversion" },
  { value: "videoViews", label: "Video Views" },
  { value: "videoViewRate", label: "Video View Rate" },
  { value: "engagements", label: "Engagements" },
  { value: "engagementRate", label: "Engagement Rate" },
];

const SEARCH_CONSOLE_METRICS: ReportMetricCatalogItem[] = [
  { value: "clicks", label: "Clicks" },
  { value: "impressions", label: "Impressions" },
  { value: "ctr", label: "CTR" },
  { value: "position", label: "Avg. Position" },
];

const GA4_METRICS: ReportMetricCatalogItem[] = [
  { value: "sessions", label: "Sessions" },
  { value: "users", label: "Users" },
  { value: "newUsers", label: "New Users" },
  { value: "pageviews", label: "Page Views" },
  { value: "bounceRate", label: "Bounce Rate" },
  { value: "avgSessionDuration", label: "Avg. Session Duration" },
  { value: "engagementRate", label: "Engagement Rate" },
  { value: "conversions", label: "Conversions" },
  { value: "revenue", label: "Revenue" },
];

const KLAVIYO_METRICS: ReportMetricCatalogItem[] = [
  { value: "emailsSent", label: "Emails Sent" },
  { value: "opens", label: "Opens" },
  { value: "clicks", label: "Clicks" },
  { value: "openRate", label: "Open Rate" },
  { value: "clickRate", label: "Click Rate" },
  { value: "revenue", label: "Revenue" },
  { value: "conversions", label: "Conversions" },
  { value: "unsubscribes", label: "Unsubscribes" },
  { value: "bounces", label: "Bounces" },
  { value: "spamComplaints", label: "Spam Complaints" },
];

const SHOPIFY_METRICS: ReportMetricCatalogItem[] = [
  { value: "orders", label: "Orders" },
  { value: "revenue", label: "Revenue" },
  { value: "aov", label: "Avg. Order Value" },
  { value: "refunds", label: "Refunds" },
  { value: "refundAmount", label: "Refund Amount" },
  { value: "customers", label: "Customers" },
  { value: "newCustomers", label: "New Customers" },
  { value: "sessions", label: "Sessions" },
  { value: "conversionRate", label: "Conversion Rate" },
  { value: "itemsSold", label: "Items Sold" },
];

const ATTRIBUTION_COLUMNS: ReportColumnCatalogItem[] = [
  { value: "channel", label: "Channel" },
  { value: "spend", label: "Spend" },
  { value: "revenue", label: "Revenue" },
  { value: "roas", label: "ROAS" },
  { value: "conversions", label: "Conversions" },
  { value: "clicks", label: "Clicks" },
  { value: "ctr", label: "CTR" },
  { value: "cpa", label: "CPA" },
];

export interface TableDimensionOption {
  value: string;
  label: string;
  group?: string;
}

const META_TABLE_DIMENSIONS: TableDimensionOption[] = [
  { value: "campaign", label: "Campaign Name", group: "Campaign" },
  { value: "day",      label: "Day",           group: "Time" },
  { value: "week",     label: "Week",          group: "Time" },
  { value: "month",    label: "Month",         group: "Time" },
  { value: "age",      label: "Age",           group: "Demographic" },
  { value: "gender",   label: "Gender",        group: "Demographic" },
  { value: "country",  label: "Country",       group: "Geographic" },
  { value: "region",   label: "Region",        group: "Geographic" },
];

const GOOGLE_TABLE_DIMENSIONS: TableDimensionOption[] = [
  { value: "campaign", label: "Campaign Name", group: "Campaign" },
  { value: "day",      label: "Day",           group: "Time" },
  { value: "week",     label: "Week",          group: "Time" },
  { value: "month",    label: "Month",         group: "Time" },
];

const SEARCH_CONSOLE_TABLE_DIMENSIONS: TableDimensionOption[] = [
  { value: "query",   label: "Search Query",  group: "Content" },
  { value: "page",    label: "Page URL",      group: "Content" },
  { value: "country", label: "Country",       group: "Geographic" },
  { value: "device",  label: "Device",        group: "Device" },
  { value: "day",     label: "Day",           group: "Time" },
  { value: "week",    label: "Week",          group: "Time" },
  { value: "month",   label: "Month",         group: "Time" },
];

const GA4_TABLE_DIMENSIONS: TableDimensionOption[] = [
  { value: "page",        label: "Page",          group: "Content" },
  { value: "source",      label: "Traffic Source", group: "Acquisition" },
  { value: "medium",      label: "Medium",        group: "Acquisition" },
  { value: "campaign",    label: "Campaign",      group: "Acquisition" },
  { value: "country",     label: "Country",       group: "Geographic" },
  { value: "device",      label: "Device",        group: "Device" },
  { value: "day",         label: "Day",           group: "Time" },
  { value: "week",        label: "Week",          group: "Time" },
  { value: "month",       label: "Month",         group: "Time" },
];

const KLAVIYO_TABLE_DIMENSIONS: TableDimensionOption[] = [
  { value: "campaign", label: "Campaign",   group: "Campaign" },
  { value: "flow",     label: "Flow",       group: "Campaign" },
  { value: "day",      label: "Day",        group: "Time" },
  { value: "week",     label: "Week",       group: "Time" },
  { value: "month",    label: "Month",      group: "Time" },
];

const SHOPIFY_TABLE_DIMENSIONS: TableDimensionOption[] = [
  { value: "product",  label: "Product",   group: "Product" },
  { value: "variant",  label: "Variant",   group: "Product" },
  { value: "customer", label: "Customer",  group: "Customer" },
  { value: "country",  label: "Country",   group: "Geographic" },
  { value: "day",      label: "Day",       group: "Time" },
  { value: "week",     label: "Week",      group: "Time" },
  { value: "month",    label: "Month",     group: "Time" },
];

const TIME_BREAKDOWNS = [
  { value: "day" as const, label: "Day", group: "Time" },
  { value: "week" as const, label: "Week", group: "Time" },
  { value: "month" as const, label: "Month", group: "Time" },
];

const META_BREAKDOWNS = [
  ...TIME_BREAKDOWNS,
  { value: "age" as const, label: "Age", group: "Demographic" },
  { value: "gender" as const, label: "Gender", group: "Demographic" },
  { value: "country" as const, label: "Country", group: "Geographic" },
  { value: "region" as const, label: "Region", group: "Geographic" },
];

function prefixMetricOptions(
  prefix: "combined" | "meta" | "google",
  metrics: ReportMetricCatalogItem[]
): ReportMetricCatalogItem[] {
  return metrics.map((metric) => ({
    value: `${prefix}.${metric.value}`,
    label: metric.label,
  }));
}

export const REPORT_PLATFORM_CATALOG: Record<CustomReportPlatform, ReportPlatformCatalogEntry> = {
  all: {
    id: "all",
    label: "All Channels",
    supported: true,
    accountScoped: false,
    widgets: {
      metric: {
        dataSource: "overview_summary",
        metrics: ALL_METRICS,
        defaultMetric: "spend",
      },
      trend: {
        dataSource: "overview_trend",
        metrics: prefixMetricOptions("combined", ALL_METRICS),
        defaultMetric: "combined.spend",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      bar: {
        dataSource: "overview_trend",
        metrics: ALL_METRICS.map((metric) => ({ value: `combined.${metric.value}`, label: metric.label })),
        defaultMetric: "combined.spend",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      table: {
        dataSource: "channel_attribution",
        columns: ATTRIBUTION_COLUMNS,
        defaultColumns: ["channel", "spend", "revenue", "roas", "conversions"],
      },
    },
  },
  meta: {
    id: "meta",
    label: "Meta",
    logoSrc: "/platform-logos/Meta.png",
    supported: true,
    accountScoped: true,
    widgets: {
      metric: {
        dataSource: "meta_campaigns",
        metrics: META_METRICS,
        defaultMetric: "spend",
      },
      trend: {
        dataSource: "overview_trend",
        metrics: prefixMetricOptions("meta", META_METRICS),
        defaultMetric: "meta.spend",
        breakdowns: [...META_BREAKDOWNS],
      },
      bar: {
        dataSource: "overview_trend",
        metrics: prefixMetricOptions("meta", META_METRICS),
        defaultMetric: "meta.spend",
        breakdowns: [...META_BREAKDOWNS],
      },
      table: {
        dataSource: "meta_campaigns",
        columns: META_COLUMNS,
        defaultColumns: ["name", "status", "spend", "revenue", "purchases", "roas"],
      },
    },
  },
  google: {
    id: "google",
    label: "Google Ads",
    logoSrc: "/platform-logos/googleAds.svg",
    supported: true,
    accountScoped: true,
    widgets: {
      metric: {
        dataSource: "google_campaigns",
        metrics: GOOGLE_METRICS,
        defaultMetric: "spend",
      },
      trend: {
        dataSource: "overview_trend",
        metrics: prefixMetricOptions("google", GOOGLE_METRICS),
        defaultMetric: "google.spend",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      bar: {
        dataSource: "overview_trend",
        metrics: prefixMetricOptions("google", GOOGLE_METRICS),
        defaultMetric: "google.spend",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      table: {
        dataSource: "google_campaigns",
        columns: GOOGLE_COLUMNS,
        defaultColumns: ["name", "status", "spend", "revenue", "conversions", "roas"],
      },
    },
  },
  tiktok: {
    id: "tiktok",
    label: "TikTok",
    logoSrc: "/platform-logos/tiktok.svg",
    supported: false,
    accountScoped: false,
    widgets: {},
  },
  pinterest: {
    id: "pinterest",
    label: "Pinterest",
    logoSrc: "/platform-logos/Pinterest.svg",
    supported: false,
    accountScoped: false,
    widgets: {},
  },
  snapchat: {
    id: "snapchat",
    label: "Snapchat",
    logoSrc: "/platform-logos/snapchat.svg",
    supported: false,
    accountScoped: false,
    widgets: {},
  },
  klaviyo: {
    id: "klaviyo",
    label: "Klaviyo",
    logoSrc: "/platform-logos/Klaviyo.svg",
    supported: true,
    accountScoped: false,
    widgets: {
      metric: {
        dataSource: "klaviyo_data",
        metrics: KLAVIYO_METRICS,
        defaultMetric: "revenue",
      },
      trend: {
        dataSource: "klaviyo_data",
        metrics: KLAVIYO_METRICS,
        defaultMetric: "revenue",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      bar: {
        dataSource: "klaviyo_data",
        metrics: KLAVIYO_METRICS,
        defaultMetric: "revenue",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      table: {
        dataSource: "klaviyo_data",
        columns: KLAVIYO_METRICS.map((m) => ({ value: m.value, label: m.label })),
        defaultColumns: [],
      },
    },
  },
  shopify: {
    id: "shopify",
    label: "Shopify",
    logoSrc: "/platform-logos/shopify_glyph.svg",
    supported: true,
    accountScoped: false,
    widgets: {
      metric: {
        dataSource: "shopify_data",
        metrics: SHOPIFY_METRICS,
        defaultMetric: "revenue",
      },
      trend: {
        dataSource: "shopify_data",
        metrics: SHOPIFY_METRICS,
        defaultMetric: "revenue",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      bar: {
        dataSource: "shopify_data",
        metrics: SHOPIFY_METRICS,
        defaultMetric: "revenue",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      table: {
        dataSource: "shopify_data",
        columns: SHOPIFY_METRICS.map((m) => ({ value: m.value, label: m.label })),
        defaultColumns: [],
      },
    },
  },
  ga4: {
    id: "ga4",
    label: "GA4",
    logoSrc: "/platform-logos/GA4.svg",
    supported: true,
    accountScoped: false,
    widgets: {
      metric: {
        dataSource: "ga4_data",
        metrics: GA4_METRICS,
        defaultMetric: "sessions",
      },
      trend: {
        dataSource: "ga4_data",
        metrics: GA4_METRICS,
        defaultMetric: "sessions",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      bar: {
        dataSource: "ga4_data",
        metrics: GA4_METRICS,
        defaultMetric: "sessions",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      table: {
        dataSource: "ga4_data",
        columns: GA4_METRICS.map((m) => ({ value: m.value, label: m.label })),
        defaultColumns: [],
      },
    },
  },
  search_console: {
    id: "search_console",
    label: "Search Console",
    logoSrc: "/platform-logos/searchconsole.svg",
    supported: true,
    accountScoped: false,
    widgets: {
      metric: {
        dataSource: "search_console_data",
        metrics: SEARCH_CONSOLE_METRICS,
        defaultMetric: "clicks",
      },
      trend: {
        dataSource: "search_console_data",
        metrics: SEARCH_CONSOLE_METRICS,
        defaultMetric: "clicks",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      bar: {
        dataSource: "search_console_data",
        metrics: SEARCH_CONSOLE_METRICS,
        defaultMetric: "clicks",
        breakdowns: [...TIME_BREAKDOWNS],
      },
      table: {
        dataSource: "search_console_data",
        columns: SEARCH_CONSOLE_METRICS.map((m) => ({ value: m.value, label: m.label })),
        defaultColumns: [],
      },
    },
  },
};

export function getReportPlatformLogo(platform: CustomReportPlatform) {
  return REPORT_PLATFORM_CATALOG[platform]?.logoSrc ?? null;
}

export function resolveWidgetPlatform(widget: Pick<CustomReportWidgetDefinition, "platform" | "dataSource">): CustomReportPlatform {
  if (widget.platform && REPORT_PLATFORM_CATALOG[widget.platform]) return widget.platform;
  if (widget.dataSource === "meta_campaigns") return "meta";
  if (widget.dataSource === "google_campaigns") return "google";
  return "all";
}

export function getCatalogWidgetConfig(
  platform: CustomReportPlatform,
  widgetType: CustomReportWidgetType
) {
  // The catalogue describes the four block kinds that take a platform-scoped
  // metric. Every other kind — text, section, and the v2 kinds that read a
  // fixed source — has no per-platform configuration to look up.
  if (
    widgetType !== "metric" &&
    widgetType !== "trend" &&
    widgetType !== "bar" &&
    widgetType !== "table"
  ) {
    return null;
  }
  return REPORT_PLATFORM_CATALOG[platform].widgets[widgetType] ?? null;
}

export function getSupportedPlatformsForWidget(widgetType: CustomReportWidgetType) {
  return (Object.values(REPORT_PLATFORM_CATALOG) as ReportPlatformCatalogEntry[]).filter(
    (entry) => entry.supported && Boolean(getCatalogWidgetConfig(entry.id, widgetType))
  );
}

export function getMetricOptionsForPlatform(
  platform: CustomReportPlatform,
  widgetType: CustomReportWidgetType
) {
  return getCatalogWidgetConfig(platform, widgetType)?.metrics ?? [];
}

export function getMetricLabelForKey(metricKey: string) {
  const suffix = metricKey.includes(".") ? metricKey.split(".").pop() ?? metricKey : metricKey;
  const catalogs = [ALL_METRICS, META_METRICS, GOOGLE_METRICS, SEARCH_CONSOLE_METRICS, GA4_METRICS, KLAVIYO_METRICS, SHOPIFY_METRICS];
  for (const catalog of catalogs) {
    const match = catalog.find((metric) => metric.value === suffix);
    if (match) return match.label;
  }
  return suffix.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim();
}

export function getColumnOptionsForPlatform(platform: CustomReportPlatform) {
  return getCatalogWidgetConfig(platform, "table")?.columns ?? [];
}

export function getDefaultColumnsForPlatform(platform: CustomReportPlatform) {
  return getCatalogWidgetConfig(platform, "table")?.defaultColumns ?? [];
}

export function getDefaultMetricForPlatform(
  platform: CustomReportPlatform,
  widgetType: CustomReportWidgetType
) {
  return getCatalogWidgetConfig(platform, widgetType)?.defaultMetric;
}

export function getDataSourceForPlatform(
  platform: CustomReportPlatform,
  widgetType: CustomReportWidgetType
) {
  return getCatalogWidgetConfig(platform, widgetType)?.dataSource;
}

export function getBreakdownOptionsForPlatform(
  platform: CustomReportPlatform,
  widgetType: CustomReportWidgetType
) {
  return getCatalogWidgetConfig(platform, widgetType)?.breakdowns ?? [];
}

export function platformSupportsAccountSelection(platform: CustomReportPlatform) {
  return REPORT_PLATFORM_CATALOG[platform]?.accountScoped ?? false;
}

export function getTableDimensionsForPlatform(platform: CustomReportPlatform): TableDimensionOption[] {
  if (platform === "meta") return META_TABLE_DIMENSIONS;
  if (platform === "google") return GOOGLE_TABLE_DIMENSIONS;
  if (platform === "search_console") return SEARCH_CONSOLE_TABLE_DIMENSIONS;
  if (platform === "ga4") return GA4_TABLE_DIMENSIONS;
  if (platform === "klaviyo") return KLAVIYO_TABLE_DIMENSIONS;
  if (platform === "shopify") return SHOPIFY_TABLE_DIMENSIONS;
  return [];
}

export function getTableMetricOptionsForPlatform(platform: CustomReportPlatform): ReportMetricCatalogItem[] {
  if (platform === "meta") return META_METRICS;
  if (platform === "google") return GOOGLE_METRICS;
  if (platform === "search_console") return SEARCH_CONSOLE_METRICS;
  if (platform === "ga4") return GA4_METRICS;
  if (platform === "klaviyo") return KLAVIYO_METRICS;
  if (platform === "shopify") return SHOPIFY_METRICS;
  return ALL_METRICS;
}

export function getTableDimensionLabel(dimensionValue: string): string {
  const all = [
    ...META_TABLE_DIMENSIONS,
    ...GOOGLE_TABLE_DIMENSIONS,
    ...SEARCH_CONSOLE_TABLE_DIMENSIONS,
    ...GA4_TABLE_DIMENSIONS,
    ...KLAVIYO_TABLE_DIMENSIONS,
    ...SHOPIFY_TABLE_DIMENSIONS,
  ];
  return all.find((d) => d.value === dimensionValue)?.label ?? dimensionValue;
}
