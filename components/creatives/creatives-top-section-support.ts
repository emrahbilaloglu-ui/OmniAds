import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { formatMoney } from "@/components/creatives/money";
import type { DateRangeValue } from "@/components/date-range/DateRangePicker";
import { formatPercentSmart } from "@/lib/metric-format";
import type {
  CreativeDatePreset,
  CreativeDateRangeValue,
  CreativeFilterField,
  CreativeFilterOperator,
  CreativeFilterRule,
  CreativeGroupBy,
} from "@/components/creatives/CreativesTopSection";

type GoodDirection = "high" | "low" | "neutral";

const PRESET_OPTIONS: Array<{ value: CreativeDatePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "thisWeek", label: "This week" },
  { value: "thisMonth", label: "This month" },
  { value: "lastWeek", label: "Last week" },
  { value: "lastMonth", label: "Last month" },
  { value: "last7Days", label: "Last 7 days" },
  { value: "last14Days", label: "Last 14 days" },
  { value: "last30Days", label: "Last 30 days" },
  { value: "last365Days", label: "Last 365 days" },
  { value: "custom", label: "Custom" },
  { value: "last", label: "Last..." },
  { value: "since", label: "Since..." },
];

export const DEFAULT_CREATIVE_DATE_RANGE: CreativeDateRangeValue = {
  preset: "last14Days",
  customStart: "",
  customEnd: "",
  lastDays: 14,
  sinceDate: "",
};

export const DEFAULT_TOP_METRIC_IDS = [
  "spend",
  "roas",
  "thumbstopRatio",
  "purchaseValueShare",
  "purchases",
];

// seeMoreRate is intentionally absent: no real see-more metric exists in the
// warehouse and the old value was fabricated from ctr_all.
export const DEFAULT_COPY_TOP_METRIC_IDS = [
  "spend",
  "roas",
  "linkCtr",
  "clickToPurchaseRatio",
  "clickToAtcRatio",
];

export type CreativeBenchmarkScopeMode = "account" | "campaign";

export interface CreativeBenchmarkCampaignContext {
  campaignId: string;
  campaignName: string;
  rowCount: number;
}

export interface CreativeBenchmarkScopeSelection {
  scope: CreativeBenchmarkScopeMode;
  scopeId: string | null;
  scopeLabel: string;
}

function startOfReferenceDay(referenceDate?: string | null): Date {
  if (!referenceDate) return startOfDay(new Date());
  const [year, month, day] = referenceDate.split("-").map((part) => Number(part));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return startOfDay(new Date());
  }
  return new Date(year, month - 1, day);
}

export function resolveCreativeDateRange(
  value: CreativeDateRangeValue,
  referenceDate?: string | null,
): {
  start: string;
  end: string;
} {
  const today = startOfReferenceDay(referenceDate);
  const completedRollingWindow = (days: number) => {
    const end = addDays(today, -1);
    return {
      start: toISO(addDays(end, -(days - 1))),
      end: toISO(end),
    };
  };

  switch (value.preset) {
    case "today":
      return { start: toISO(today), end: toISO(today) };
    case "yesterday": {
      const date = addDays(today, -1);
      return { start: toISO(date), end: toISO(date) };
    }
    case "thisWeek": {
      const day = today.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      return { start: toISO(addDays(today, mondayOffset)), end: toISO(today) };
    }
    case "thisMonth": {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return { start: toISO(start), end: toISO(today) };
    }
    case "lastWeek": {
      const day = today.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const thisWeekStart = addDays(today, mondayOffset);
      const lastWeekStart = addDays(thisWeekStart, -7);
      const lastWeekEnd = addDays(thisWeekStart, -1);
      return { start: toISO(lastWeekStart), end: toISO(lastWeekEnd) };
    }
    case "lastMonth": {
      const year = today.getFullYear();
      const month = today.getMonth();
      const start = new Date(
        month === 0 ? year - 1 : year,
        month === 0 ? 11 : month - 1,
        1
      );
      const end = new Date(year, month, 0);
      return { start: toISO(start), end: toISO(end) };
    }
    case "last7Days":
      return completedRollingWindow(7);
    case "last14Days":
      return completedRollingWindow(14);
    case "last30Days":
      return completedRollingWindow(30);
    case "last365Days":
      return completedRollingWindow(365);
    case "last": {
      const days = Number.isFinite(value.lastDays)
        ? Math.max(1, Math.floor(value.lastDays))
        : 14;
      return completedRollingWindow(days);
    }
    case "since": {
      if (!value.sinceDate) {
        return { start: toISO(addDays(today, -13)), end: toISO(today) };
      }
      return { start: value.sinceDate, end: toISO(today) };
    }
    case "custom":
      return {
        start: value.customStart || toISO(addDays(today, -13)),
        end: value.customEnd || toISO(today),
      };
  }
}

export function formatCreativeDateLabel(value: CreativeDateRangeValue): string {
  const preset = PRESET_OPTIONS.find((item) => item.value === value.preset);
  if (value.preset !== "custom" && value.preset !== "last" && value.preset !== "since") {
    return preset?.label ?? "Last 14 days";
  }

  if (value.preset === "last") {
    return `Last ${Math.max(1, Math.floor(value.lastDays || 14))} days`;
  }

  const { start, end } = resolveCreativeDateRange(value);
  return `${formatDate(start)} - ${formatDate(end)}`;
}

export function creativeDateRangeToStandard(
  value: CreativeDateRangeValue,
  referenceDate?: string | null,
): DateRangeValue {
  const resolved = resolveCreativeDateRange(value, referenceDate);

  switch (value.preset) {
    case "today":
      return {
        rangePreset: "today",
        customStart: resolved.start,
        customEnd: resolved.end,
        comparisonPreset: "none",
        comparisonStart: "",
        comparisonEnd: "",
      };
    case "yesterday":
      return {
        rangePreset: "yesterday",
        customStart: resolved.start,
        customEnd: resolved.end,
        comparisonPreset: "none",
        comparisonStart: "",
        comparisonEnd: "",
      };
    case "lastMonth":
      return {
        rangePreset: "lastMonth",
        customStart: resolved.start,
        customEnd: resolved.end,
        comparisonPreset: "none",
        comparisonStart: "",
        comparisonEnd: "",
      };
    case "last7Days":
      return {
        rangePreset: "7d",
        customStart: resolved.start,
        customEnd: resolved.end,
        comparisonPreset: "none",
        comparisonStart: "",
        comparisonEnd: "",
      };
    case "last14Days":
      return {
        rangePreset: "14d",
        customStart: resolved.start,
        customEnd: resolved.end,
        comparisonPreset: "none",
        comparisonStart: "",
        comparisonEnd: "",
      };
    case "last30Days":
      return {
        rangePreset: "30d",
        customStart: resolved.start,
        customEnd: resolved.end,
        comparisonPreset: "none",
        comparisonStart: "",
        comparisonEnd: "",
      };
    case "last365Days":
      return {
        rangePreset: "365d",
        customStart: resolved.start,
        customEnd: resolved.end,
        comparisonPreset: "none",
        comparisonStart: "",
        comparisonEnd: "",
      };
    default:
      return {
        rangePreset: "custom",
        customStart: resolved.start,
        customEnd: resolved.end,
        comparisonPreset: "none",
        comparisonStart: "",
        comparisonEnd: "",
      };
  }
}

export function standardDateRangeToCreative(value: DateRangeValue): CreativeDateRangeValue {
  switch (value.rangePreset) {
    case "today":
      return { preset: "today", customStart: "", customEnd: "", lastDays: 1, sinceDate: "" };
    case "yesterday":
      return { preset: "yesterday", customStart: "", customEnd: "", lastDays: 1, sinceDate: "" };
    case "7d":
      return { preset: "last7Days", customStart: "", customEnd: "", lastDays: 7, sinceDate: "" };
    case "14d":
      return { preset: "last14Days", customStart: "", customEnd: "", lastDays: 14, sinceDate: "" };
    case "30d":
      return { preset: "last30Days", customStart: "", customEnd: "", lastDays: 30, sinceDate: "" };
    case "365d":
      return { preset: "last365Days", customStart: "", customEnd: "", lastDays: 365, sinceDate: "" };
    case "lastMonth":
      return { preset: "lastMonth", customStart: "", customEnd: "", lastDays: 30, sinceDate: "" };
    case "3d":
    case "28d":
    case "90d":
    case "custom":
      return {
        preset: "custom",
        customStart: value.customStart,
        customEnd: value.customEnd,
        lastDays: getRangeDayCount(value.customStart, value.customEnd),
        sinceDate: value.customStart,
      };
    case "thisMonth":
      return { preset: "thisMonth", customStart: "", customEnd: "", lastDays: 30, sinceDate: "" };
  }
}

export function applyCreativeFilters(
  rows: MetaCreativeRow[],
  rules: CreativeFilterRule[],
): MetaCreativeRow[] {
  if (rules.length === 0) return rows;

  const normalize = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .trim();

  const includesAny = (candidates: Array<string | null | undefined>, query: string) =>
    candidates.some((candidate) => normalize(candidate ?? "").includes(query));
  const equalsAny = (candidates: Array<string | null | undefined>, query: string) =>
    candidates.some((candidate) => normalize(candidate ?? "") === query);
  const startsWithAny = (candidates: Array<string | null | undefined>, query: string) =>
    candidates.some((candidate) => normalize(candidate ?? "").startsWith(query));
  return rows.filter((row) =>
    rules.every((rule) => {
      const query = normalize(rule.query);
      const operator = rule.operator ?? "contains";
      if (!query) return true;

      const metricsBlob = [
        row.spend,
        row.purchaseValue,
        row.roas,
        row.cpa,
        row.cpcLink,
        row.cpm,
        row.ctrAll,
        row.purchases,
      ]
        .map((value) => String(value))
        .join(" ");
      const tagsBlob = row.tags.join(" ");

      const evaluate = (candidates: Array<string | null | undefined>) => {
        if (operator === "equals") return equalsAny(candidates, query);
        if (operator === "not_equals") return !equalsAny(candidates, query);
        if (operator === "starts_with") return startsWithAny(candidates, query);
        return includesAny(candidates, query);
      };

      const aiTagCandidates = (tagKey: keyof MetaCreativeRow["aiTags"]) => row.aiTags?.[tagKey] ?? [];

      if (rule.field === "campaignName") {
        return evaluate([row.campaignName, row.campaignId, row.name]);
      }
      if (rule.field === "adSetName") {
        return evaluate([row.adSetName, row.adSetId, row.name]);
      }
      if (rule.field === "adName" || rule.field === "namingConvention") {
        return evaluate([row.name]);
      }
      if (rule.field === "launchDate") {
        if (operator === "before") return row.launchDate < rule.query.trim();
        if (operator === "after") return row.launchDate > rule.query.trim();
        return evaluate([row.launchDate]);
      }
      if (rule.field === "performanceMetrics") {
        return evaluate([metricsBlob]);
      }
      if (rule.field === "creativePrimaryLabel") {
        return evaluate([row.creativePrimaryLabel]);
      }
      if (rule.field === "creativeSecondaryLabel") {
        return evaluate([row.creativeSecondaryLabel]);
      }
      if (rule.field === "creativeVisualFormat") {
        return evaluate([row.creativeVisualFormat]);
      }
      if (rule.field === "creativeDeliveryType") {
        return evaluate([row.creativeDeliveryType]);
      }
      if (rule.field === "taxonomySource") {
        return evaluate([row.taxonomySource ?? null]);
      }
      if (rule.field === "isCatalog") {
        return evaluate([String(row.isCatalog), row.isCatalog ? "yes" : "no"]);
      }
      if (
        rule.field === "assetType" ||
        rule.field === "visualFormat" ||
        rule.field === "intendedAudience" ||
        rule.field === "messagingAngle" ||
        rule.field === "seasonality" ||
        rule.field === "offerType" ||
        rule.field === "hookTactic" ||
        rule.field === "headlineTactic"
      ) {
        return evaluate(aiTagCandidates(rule.field));
      }
      if (rule.field === "customTags") {
        return evaluate([tagsBlob]);
      }

      return evaluate([
        row.name,
        row.creativeTypeLabel,
        row.creativePrimaryLabel,
        row.creativeSecondaryLabel,
        tagsBlob,
        row.campaignName,
        row.adSetName,
      ]);
    })
  );
}

export function mapCreativeGroupByToApi(
  groupBy: CreativeGroupBy
): "adName" | "creative" | "adSet" {
  if (groupBy === "creative") return "creative";
  if (groupBy === "adSet" || groupBy === "campaign") return "adSet";
  if (groupBy === "landingPage") return "adSet";
  if (groupBy === "copy" || groupBy === "headline") return "creative";
  return "adName";
}

export function resolveCreativeBenchmarkCampaignContext(
  rows: MetaCreativeRow[],
): CreativeBenchmarkCampaignContext | null {
  const campaigns = new Map<string, CreativeBenchmarkCampaignContext>();

  for (const row of rows) {
    const campaignId = row.campaignId?.trim();
    if (!campaignId) continue;
    const campaignName = row.campaignName?.trim() || "Selected campaign";
    const existing = campaigns.get(campaignId);
    if (existing) {
      existing.rowCount += 1;
      if (existing.campaignName === "Selected campaign" && campaignName !== "Selected campaign") {
        existing.campaignName = campaignName;
      }
      continue;
    }
    campaigns.set(campaignId, {
      campaignId,
      campaignName,
      rowCount: 1,
    });
  }

  if (campaigns.size !== 1) return null;
  return campaigns.values().next().value ?? null;
}

export function resolveCreativeBenchmarkScopeSelection(input: {
  mode: CreativeBenchmarkScopeMode;
  campaignContext: CreativeBenchmarkCampaignContext | null;
}): CreativeBenchmarkScopeSelection {
  if (input.mode === "campaign" && input.campaignContext) {
    return {
      scope: "campaign",
      scopeId: input.campaignContext.campaignId,
      scopeLabel: input.campaignContext.campaignName,
    };
  }

  return {
    scope: "account",
    scopeId: null,
    scopeLabel: "Account-wide",
  };
}

export function filterRowsForCreativeBenchmarkScope(
  rows: MetaCreativeRow[],
  scope: CreativeBenchmarkScopeSelection,
): MetaCreativeRow[] {
  if (scope.scope !== "campaign" || !scope.scopeId) return rows;
  return rows.filter((row) => row.campaignId === scope.scopeId);
}

export function normalizeRange(range: CreativeDateRangeValue): CreativeDateRangeValue {
  const next = { ...range };

  if (next.preset === "last") {
    next.lastDays = Math.max(1, Math.floor(next.lastDays || 14));
  }

  if (next.preset === "custom") {
    const { start, end } = resolveCreativeDateRange(next);
    next.customStart = start;
    next.customEnd = end;
  }

  if (next.preset === "since" && !next.sinceDate) {
    next.sinceDate = toISO(addDays(startOfDay(new Date()), -13));
  }

  return next;
}

function getRangeDayCount(start: string, end: string): number {
  if (!start || !end) return 14;
  const diff = new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime();
  return Math.max(1, Math.round(diff / 86_400_000) + 1);
}

export function selectCalendarDate(
  range: CreativeDateRangeValue,
  iso: string
): CreativeDateRangeValue {
  if (range.preset !== "custom") {
    return {
      ...range,
      preset: "custom",
      customStart: iso,
      customEnd: iso,
    };
  }

  if (!range.customStart || (range.customStart && range.customEnd)) {
    return {
      ...range,
      customStart: iso,
      customEnd: "",
    };
  }

  if (iso < range.customStart) {
    return {
      ...range,
      customStart: iso,
      customEnd: range.customStart,
    };
  }

  return {
    ...range,
    customEnd: iso,
  };
}

export function buildMonthGrid(year: number, month: number): Array<string | null> {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<string | null> = [];

  for (let i = 0; i < firstDay; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(
      `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    );
  }
  while (cells.length % 7 !== 0) cells.push(null);

  return cells;
}

export function moveMonth(
  cursor: { year: number; month: number },
  delta: number
): { year: number; month: number } {
  const next = new Date(cursor.year, cursor.month + delta, 1);
  return { year: next.getFullYear(), month: next.getMonth() };
}

export function nextMonth(cursor: { year: number; month: number }): {
  year: number;
  month: number;
} {
  return moveMonth(cursor, 1);
}

export function prettyFieldLabel(field: CreativeFilterField): string {
  const lookup: Record<CreativeFilterField, string> = {
    campaignName: "Campaign",
    adSetName: "Ad Set",
    adName: "Ad",
    adSetup: "Ad setup",
    landingPage: "Landing page",
    launchDate: "Launch date",
    performanceMetrics: "Performance",
    creativePrimaryLabel: "Primary label",
    creativeSecondaryLabel: "Secondary label",
    creativeVisualFormat: "Visual format",
    creativeDeliveryType: "Delivery type",
    taxonomySource: "Taxonomy source",
    isCatalog: "Is catalog",
    namingConvention: "Naming",
    customTags: "Custom tags",
    assetType: "Asset type",
    visualFormat: "AI visual format",
    intendedAudience: "Audience",
    messagingAngle: "Messaging angle",
    seasonality: "Seasonality",
    offerType: "Offer type",
    hookTactic: "Hook tactic",
    headlineTactic: "Headline tactic",
  };

  return lookup[field];
}

export function prettyOperatorLabel(operator: CreativeFilterOperator): string {
  const lookup: Record<CreativeFilterOperator, string> = {
    contains: "contains",
    equals: "is",
    not_equals: "is not",
    starts_with: "starts with",
    before: "before",
    after: "after",
  };

  return lookup[operator];
}

export function fmtCurrency(
  n: number,
  rowCurrency?: string | null,
  defaultCurrency?: string | null
): string {
  return formatMoney(n, rowCurrency, defaultCurrency);
}

export function fmtPercent(n: number): string {
  return formatPercentSmart(n);
}

export function fmtInteger(n: number): string {
  return Math.round(n).toLocaleString();
}

export function resolveAverageHeatColor(
  direction: GoodDirection,
  value: number,
  average: number
) {
  if (direction === "neutral") {
    return "rgba(148, 163, 184, 0.070)";
  }

  if (!Number.isFinite(average) || average <= 0) {
    return "rgba(148, 163, 184, 0.060)";
  }

  const rawDeltaRatio = (value - average) / average;
  const directionalDelta = direction === "low" ? -rawDeltaRatio : rawDeltaRatio;
  const absDelta = Math.abs(directionalDelta);

  if (directionalDelta >= 0.35) return "rgba(22, 163, 74, 0.294)";
  if (directionalDelta >= 0.15) return "rgba(34, 197, 94, 0.224)";
  if (absDelta <= 0.1) return "rgba(148, 163, 184, 0.070)";
  if (directionalDelta >= 0) return "rgba(74, 222, 128, 0.148)";
  if (directionalDelta <= -0.35) return "rgba(220, 38, 38, 0.246)";
  if (directionalDelta <= -0.15) return "rgba(248, 113, 113, 0.184)";
  return "rgba(251, 191, 36, 0.128)";
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function toISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
