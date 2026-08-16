export type CustomReportDateRangePreset = "7" | "30" | "90";
export type CustomReportCompareMode = "none" | "previous_period";
export type CustomReportWidgetType = "metric" | "trend" | "bar" | "table" | "text" | "section";
export type CustomReportAxisMode = "adaptive" | "zero_based" | "symmetric";
export type CustomReportBreakdown = "day" | "week" | "month" | "age" | "gender" | "country" | "region";
export type CustomReportPlatform =
  | "all"
  | "meta"
  | "google"
  | "tiktok"
  | "pinterest"
  | "snapchat"
  | "klaviyo"
  | "shopify"
  | "ga4"
  | "search_console";
export type CustomReportDataSource =
  | "overview_summary"
  | "overview_trend"
  | "channel_attribution"
  | "meta_campaigns"
  | "google_campaigns"
  | "search_console_data"
  | "ga4_data"
  | "klaviyo_data"
  | "shopify_data";

export interface CustomReportWidgetDefinition {
  id: string;
  type: CustomReportWidgetType;
  slot: number;
  colSpan: number;
  rowSpan: number;
  title: string;
  subtitle?: string;
  dataSource?: CustomReportDataSource;
  accountId?: string;
  metricKey?: string;
  yMetrics?: string[];
  breakdown?: CustomReportBreakdown;
  text?: string;
  platform?: CustomReportPlatform;
  limit?: number;
  columns?: string[];
  tableDimension?: string;
  axisMode?: CustomReportAxisMode;
}

export interface CustomReportDocument {
  version: 1;
  dateRangePreset: CustomReportDateRangePreset;
  compareMode: CustomReportCompareMode;
  reportPlatforms?: CustomReportPlatform[];
  widgets: CustomReportWidgetDefinition[];
}

export interface CustomReportRecord {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  templateId: string | null;
  definition: CustomReportDocument;
  createdAt: string;
  updatedAt: string;
}

export interface CustomReportTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  providers: string[];
  accent: string;
  definition: CustomReportDocument;
}

export interface RenderedReportWidget {
  id: string;
  slot: number;
  colSpan: number;
  rowSpan: number;
  type: CustomReportWidgetType;
  title: string;
  subtitle?: string;
  value?: string;
  deltaLabel?: string | null;
  points?: Array<{ label: string; value: number }>;
  series?: Array<{
    key: string;
    label: string;
    color: string;
    points: Array<{ label: string; value: number }>;
  }>;
  rows?: Array<Record<string, string | number | null>>;
  columns?: string[];
  text?: string;
  emptyMessage?: string;
  /**
   * Set only when this widget failed to build. A failure is distinct from an
   * empty result: "no rows in this period" and "we could not load this" are
   * different facts and must not render the same way.
   */
  errorMessage?: string | null;
  /** True when the widget can be retried without rebuilding the whole report. */
  retryable?: boolean;
  warning?: string | null;
  axisMode?: CustomReportAxisMode;
}

export interface RenderedReportPayload {
  businessId: string;
  reportId?: string;
  name: string;
  description?: string | null;
  dateRangeLabel: string;
  /** Exact window this payload was rendered for. */
  startDate?: string;
  endDate?: string;
  /** ISO 4217 code the amounts are denominated in; null when not established. */
  currency?: string | null;
  compareMode?: string | null;
  generatedAt: string;
  widgets: RenderedReportWidget[];
}

export interface CustomReportSharePayload extends RenderedReportPayload {
  token: string;
  createdAt: string;
  expiresAt: string;
  businessName?: string | null;
  clientEmail?: string | null;
  currency?: string | null;
  trackingState?: "normal" | "no_actions" | "tracking_degraded" | null;
}

export const REPORT_GRID_SLOT_COUNT = 48;
export const REPORT_GRID_COLUMNS = 4;
export const REPORT_SHARE_EXPIRY_OPTIONS = [
  { value: 1, label: "24 hours" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
] as const;

export function createCustomReportId() {
  if (typeof globalThis !== "undefined" && typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `report_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function getDefaultWidgetSpan(type: CustomReportWidgetType) {
  if (type === "section") return { colSpan: 4, rowSpan: 1 };
  if (type === "table") return { colSpan: 2, rowSpan: 2 };
  if (type === "trend" || type === "bar") return { colSpan: 2, rowSpan: 2 };
  if (type === "text") return { colSpan: 2, rowSpan: 1 };
  return { colSpan: 1, rowSpan: 1 };
}

export function clampWidgetSpan(input: {
  colSpan?: number;
  rowSpan?: number;
  type: CustomReportWidgetType;
}) {
  const defaults = getDefaultWidgetSpan(input.type);
  return {
    colSpan: Math.max(1, Math.min(REPORT_GRID_COLUMNS, input.colSpan ?? defaults.colSpan)),
    rowSpan: Math.max(1, input.rowSpan ?? defaults.rowSpan),
  };
}

function createWidget(
  input: Omit<CustomReportWidgetDefinition, "id">
): CustomReportWidgetDefinition {
  return { id: createCustomReportId(), ...input };
}

export function createBlankReportDefinition(): CustomReportDocument {
  return {
    version: 1,
    dateRangePreset: "30",
    compareMode: "none",
    widgets: [],
  };
}

export const CUSTOM_REPORT_TEMPLATES: CustomReportTemplate[] = [
  {
    id: "one-click-paid-media",
    name: "Executive Overview",
    description: "Blended KPIs, attribution, and the next actions on one leadership-ready page.",
    category: "Executive",
    providers: ["Meta", "Google", "GA4", "Shopify"],
    accent: "from-emerald-100 via-sky-50 to-white",
    definition: {
      version: 1,
      dateRangePreset: "30",
        compareMode: "previous_period",
      widgets: [
        createWidget({
          slot: 0,
          ...getDefaultWidgetSpan("section"),
          type: "section",
          title: "Executive Overview",
          subtitle: "Executive KPIs and channel mix for your current reporting window.",
        }),
        createWidget({
          slot: 4,
          ...getDefaultWidgetSpan("metric"),
          type: "metric",
          title: "Spend",
          dataSource: "overview_summary",
          metricKey: "spend",
        }),
        createWidget({
          slot: 5,
          ...getDefaultWidgetSpan("metric"),
          type: "metric",
          title: "Revenue",
          dataSource: "overview_summary",
          metricKey: "revenue",
        }),
        createWidget({
          slot: 6,
          ...getDefaultWidgetSpan("metric"),
          type: "metric",
          title: "Purchases",
          dataSource: "overview_summary",
          metricKey: "purchases",
        }),
        createWidget({
          slot: 7,
          ...getDefaultWidgetSpan("metric"),
          type: "metric",
          title: "ROAS",
          dataSource: "overview_summary",
          metricKey: "roas",
        }),
        createWidget({
          slot: 8,
          ...getDefaultWidgetSpan("trend"),
          type: "trend",
          title: "Blended Spend Trend",
          dataSource: "overview_trend",
          metricKey: "combined.spend",
        }),
        createWidget({
          slot: 10,
          ...getDefaultWidgetSpan("bar"),
          type: "bar",
          title: "Channel Revenue Trend",
          dataSource: "overview_trend",
          metricKey: "combined.revenue",
        }),
        createWidget({
          slot: 12,
          ...getDefaultWidgetSpan("table"),
          type: "table",
          title: "Channel Attribution",
          dataSource: "channel_attribution",
          columns: ["channel", "spend", "revenue", "roas", "conversions"],
          limit: 8,
        }),
      ],
    },
  },
  {
    id: "google-demand-capture",
    name: "Meta Deep Dive",
    description: "Account pulse, campaign outcomes, and where Meta spend moved.",
    category: "Meta",
    providers: ["Meta"],
    accent: "from-sky-100 via-indigo-50 to-white",
    definition: {
      version: 1,
      dateRangePreset: "30",
      compareMode: "none",
      widgets: [
        createWidget({
          slot: 0,
          ...getDefaultWidgetSpan("section"),
          type: "section",
          title: "Meta Deep Dive",
          subtitle: "Campaign outcomes and account-level performance for Meta.",
        }),
        createWidget({
          slot: 4,
          ...getDefaultWidgetSpan("metric"),
          type: "metric",
          title: "Meta Spend",
          dataSource: "overview_summary",
          metricKey: "meta-spend",
        }),
        createWidget({
          slot: 5,
          ...getDefaultWidgetSpan("metric"),
          type: "metric",
          title: "Meta Revenue",
          dataSource: "overview_summary",
          metricKey: "meta-revenue",
        }),
        createWidget({
          slot: 6,
          ...getDefaultWidgetSpan("metric"),
          type: "metric",
          title: "Meta ROAS",
          dataSource: "overview_summary",
          metricKey: "meta-roas",
        }),
        createWidget({
          slot: 8,
          ...getDefaultWidgetSpan("table"),
          type: "table",
          title: "Meta Campaign Outcomes",
          dataSource: "meta_campaigns",
          columns: ["name", "status", "spend", "revenue", "purchases", "roas"],
          limit: 8,
        }),
      ],
    },
  },
  {
    id: "meta-performance-brief",
    name: "Creative Performance Review",
    description: "Creative performance framing, fatigue signals, and the next test slate.",
    category: "Creative",
    providers: ["Meta"],
    accent: "from-blue-100 via-violet-50 to-white",
    definition: {
      version: 1,
      dateRangePreset: "30",
      compareMode: "none",
      widgets: [
        createWidget({
          slot: 0,
          ...getDefaultWidgetSpan("section"),
          type: "section",
          title: "Creative Performance Review",
          subtitle: "Performance evidence for the next creative review.",
        }),
        createWidget({
          slot: 4,
          ...getDefaultWidgetSpan("metric"),
          type: "metric",
          title: "Meta Spend",
          dataSource: "overview_summary",
          metricKey: "meta-spend",
        }),
        createWidget({
          slot: 5,
          ...getDefaultWidgetSpan("metric"),
          type: "metric",
          title: "Meta Revenue",
          dataSource: "overview_summary",
          metricKey: "meta-revenue",
        }),
        createWidget({
          slot: 6,
          ...getDefaultWidgetSpan("metric"),
          type: "metric",
          title: "Meta ROAS",
          dataSource: "overview_summary",
          metricKey: "meta-roas",
        }),
        createWidget({
          slot: 8,
          ...getDefaultWidgetSpan("table"),
          type: "table",
          title: "Top Meta Campaigns",
          dataSource: "meta_campaigns",
          columns: ["name", "status", "spend", "revenue", "purchases", "roas"],
          limit: 8,
        }),
      ],
    },
  },
  {
    id: "meta-creative-briefs",
    name: "Meta Creative Briefs",
    description: "Turn current Meta evidence into a forwardable creative-team handoff.",
    category: "Creative",
    providers: ["Meta"],
    accent: "from-violet-100 via-purple-50 to-white",
    definition: {
      version: 1,
      dateRangePreset: "30",
      compareMode: "previous_period",
      widgets: [
        createWidget({ slot: 0, ...getDefaultWidgetSpan("section"), type: "section", title: "Meta Creative Briefs", subtitle: "Evidence, hypotheses, and production handoff." }),
        createWidget({ slot: 4, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Meta Spend", dataSource: "overview_summary", metricKey: "meta-spend" }),
        createWidget({ slot: 5, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Meta Revenue", dataSource: "overview_summary", metricKey: "meta-revenue" }),
        createWidget({ slot: 6, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Meta ROAS", dataSource: "overview_summary", metricKey: "meta-roas" }),
        createWidget({ slot: 8, ...getDefaultWidgetSpan("table"), type: "table", title: "Creative Evidence by Campaign", dataSource: "meta_campaigns", columns: ["name", "spend", "revenue", "purchases", "roas"], limit: 10 }),
        createWidget({ slot: 10, ...getDefaultWidgetSpan("text"), type: "text", title: "Brief and Handoff", text: "Use the evidence table to document the winning angle, next hypothesis, hooks, formats, guardrails, naming, and owner before sending the brief." }),
      ],
    },
  },
  {
    id: "store-economics",
    name: "Store Economics",
    description: "Revenue, order value, and store contribution context for the monthly review.",
    category: "Economics",
    providers: ["Shopify", "GA4"],
    accent: "from-emerald-100 via-teal-50 to-white",
    definition: {
      version: 1,
      dateRangePreset: "30",
      compareMode: "previous_period",
      widgets: [
        createWidget({ slot: 0, ...getDefaultWidgetSpan("section"), type: "section", title: "Store Economics", subtitle: "Commerce performance and customer economics." }),
        createWidget({ slot: 4, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Revenue", dataSource: "overview_summary", metricKey: "revenue" }),
        createWidget({ slot: 5, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Orders", dataSource: "shopify_data", metricKey: "orders" }),
        createWidget({ slot: 6, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Average Order Value", dataSource: "shopify_data", metricKey: "aov" }),
        createWidget({ slot: 8, ...getDefaultWidgetSpan("trend"), type: "trend", title: "Store Revenue Trend", dataSource: "shopify_data", metricKey: "revenue" }),
        createWidget({ slot: 10, ...getDefaultWidgetSpan("table"), type: "table", title: "Commerce Detail", dataSource: "shopify_data", columns: ["date", "revenue", "orders", "aov"], limit: 12 }),
      ],
    },
  },
  {
    id: "channel-mix",
    name: "Channel Mix",
    description: "Spend and revenue allocation shifts across connected paid channels.",
    category: "Channels",
    providers: ["Meta", "Google"],
    accent: "from-amber-100 via-orange-50 to-white",
    definition: {
      version: 1,
      dateRangePreset: "30",
      compareMode: "previous_period",
      widgets: [
        createWidget({ slot: 0, ...getDefaultWidgetSpan("section"), type: "section", title: "Channel Mix", subtitle: "Blended efficiency and provider allocation." }),
        createWidget({ slot: 4, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Spend", dataSource: "overview_summary", metricKey: "spend" }),
        createWidget({ slot: 5, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Revenue", dataSource: "overview_summary", metricKey: "revenue" }),
        createWidget({ slot: 6, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Blended ROAS", dataSource: "overview_summary", metricKey: "roas" }),
        createWidget({ slot: 8, ...getDefaultWidgetSpan("bar"), type: "bar", title: "Revenue Allocation Trend", dataSource: "overview_trend", metricKey: "combined.revenue" }),
        createWidget({ slot: 10, ...getDefaultWidgetSpan("table"), type: "table", title: "ROAS by Channel", dataSource: "channel_attribution", columns: ["channel", "spend", "revenue", "roas", "conversions"], limit: 10 }),
      ],
    },
  },
  {
    id: "seo-ai-visibility",
    name: "SEO & AI Visibility",
    description: "Search KPIs, query movers, and landing-page opportunities from connected analytics.",
    category: "Growth",
    providers: ["Search Console", "GA4"],
    accent: "from-lime-100 via-emerald-50 to-white",
    definition: {
      version: 1,
      dateRangePreset: "30",
      compareMode: "previous_period",
      widgets: [
        createWidget({ slot: 0, ...getDefaultWidgetSpan("section"), type: "section", title: "SEO & AI Visibility", subtitle: "Organic discovery and landing-page performance." }),
        createWidget({ slot: 4, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Organic Clicks", dataSource: "search_console_data", metricKey: "clicks" }),
        createWidget({ slot: 5, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Impressions", dataSource: "search_console_data", metricKey: "impressions" }),
        createWidget({ slot: 6, ...getDefaultWidgetSpan("metric"), type: "metric", title: "Search CTR", dataSource: "search_console_data", metricKey: "ctr" }),
        createWidget({ slot: 8, ...getDefaultWidgetSpan("trend"), type: "trend", title: "Organic Traffic Trend", dataSource: "ga4_data", metricKey: "sessions" }),
        createWidget({ slot: 10, ...getDefaultWidgetSpan("table"), type: "table", title: "Query Movers", dataSource: "search_console_data", columns: ["query", "clicks", "impressions", "ctr", "position"], limit: 12 }),
      ],
    },
  },
];

export function getTemplateById(templateId: string | null | undefined) {
  return CUSTOM_REPORT_TEMPLATES.find((template) => template.id === templateId) ?? null;
}

export function cloneReportDefinition(definition: CustomReportDocument): CustomReportDocument {
  return JSON.parse(JSON.stringify(definition)) as CustomReportDocument;
}

export function ensureReportDefinition(
  input: Partial<CustomReportDocument> | null | undefined
): CustomReportDocument {
  const fallback = createBlankReportDefinition();
  return {
    version: 1,
    dateRangePreset:
      input?.dateRangePreset === "7" || input?.dateRangePreset === "90"
        ? input.dateRangePreset
        : input?.dateRangePreset === "30"
          ? "30"
          : fallback.dateRangePreset,
    compareMode: input?.compareMode === "previous_period" ? "previous_period" : "none",
    widgets: Array.isArray(input?.widgets)
      ? input.widgets
          .filter((widget): widget is CustomReportWidgetDefinition => Boolean(widget?.id))
          .map((widget) => {
            const span = clampWidgetSpan(widget);
            const breakdown =
              widget.type === "trend" || widget.type === "bar"
                ? widget.breakdown === "week" ||
                  widget.breakdown === "month" ||
                  widget.breakdown === "age" ||
                  widget.breakdown === "gender" ||
                  widget.breakdown === "country" ||
                  widget.breakdown === "region"
                  ? widget.breakdown
                  : "day"
                : undefined;
            const yMetrics =
              widget.type === "trend" || widget.type === "bar"
                ? Array.isArray(widget.yMetrics) && widget.yMetrics.length > 0
                  ? widget.yMetrics.filter((metric): metric is string => typeof metric === "string" && metric.trim().length > 0)
                  : typeof widget.metricKey === "string" && widget.metricKey.trim().length > 0
                    ? [widget.metricKey]
                    : ["combined.spend"]
                : undefined;
            const platform =
              widget.platform === "meta" ||
              widget.platform === "google" ||
              widget.platform === "all" ||
              widget.platform === "tiktok" ||
              widget.platform === "pinterest" ||
              widget.platform === "snapchat" ||
              widget.platform === "klaviyo" ||
              widget.platform === "shopify" ||
              widget.platform === "ga4" ||
              widget.platform === "search_console"
                ? widget.platform
                : undefined;
            return {
              ...widget,
              colSpan: span.colSpan,
              rowSpan: span.rowSpan,
              breakdown: breakdown as CustomReportBreakdown | undefined,
              platform,
              yMetrics,
            };
          })
          .slice(0, REPORT_GRID_SLOT_COUNT)
      : fallback.widgets,
  };
}
