import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The plan's typography floor, enforced so it cannot quietly regress.
 *
 * Essential data and body text must be at least 12px. Marker-bounded fragments
 * copied from the canonical Dashboard v2 reference are the only exceptions.
 * Their selector/value pairs are asserted exactly, so a marker cannot become a
 * general exemption.
 *
 * SCOPE, stated honestly: this checks `.css` files only. It does not see
 * Tailwind arbitrary values in TSX (`text-[11.5px]`), and that is where most of
 * this product's small text now lives -- the v2 design's own type scale puts
 * 121 of its 379 non-monospace text elements below 12px, including `<p>`
 * descriptions at 11px. Measured 2026-08-16 against the design file itself, and
 * on `/commercial-truth` alone 38 pieces of essential text render below the
 * floor: target-pack values, assessments like "degraded no scale, review hold",
 * and field explanations -- the exact categories the audit named.
 *
 * So the sentence above ("regardless of where it appears") is the rule's
 * intent, not its coverage. The gap is deliberate to leave visible rather than
 * paper over: closing it means either re-scaling the shipped design or
 * narrowing the rule, and that is a product decision, not a lint fix. The
 * reporting test below prints the size of the gap so it cannot be forgotten.
 *
 * This asserts on shipped stylesheets rather than on a screenshot, because a
 * screenshot proves one viewport on one day and a stylesheet proves the rule.
 */
const STYLESHEETS: string[] = execSync(
  "find app components -name '*.css' -not -path '*/node_modules/*'",
  { encoding: "utf8" },
)
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const FONT_SIZE = /font-size:\s*([0-9.]+)px/g;
const EXACT_SHELL_TYPE_FILE = "app/globals.css";
const EXACT_SHELL_TYPE_START =
  "/* dashboard-v2-shell-exact-reference-type:start */";
const EXACT_SHELL_TYPE_END =
  "/* dashboard-v2-shell-exact-reference-type:end */";
const EXACT_META_TYPE_FILE =
  "components/meta/decision-center/MetaDecisionCenterExact.module.css";
const EXACT_META_TYPE_START =
  "/* dashboard-v2-meta-exact-reference-type:start */";
const EXACT_META_TYPE_END =
  "/* dashboard-v2-meta-exact-reference-type:end */";
const EXACT_CREATIVE_TYPE_FILE =
  "components/creatives/CreativeStudioExact.module.css";
const EXACT_CREATIVE_TYPE_START =
  "/* dashboard-v2-exact-font-exception: canonical Creative Studio labels use 8.5px-10.5px type. */";
const EXACT_LAUNCHPAD_TYPE_FILE =
  "app/(dashboard)/platforms/meta/launchpad/page.module.css";
const EXACT_LAUNCHPAD_TYPE_START =
  "/* dashboard-v2-exact-typography:start launchpad */";
const EXACT_LAUNCHPAD_TYPE_END =
  "/* dashboard-v2-exact-typography:end launchpad */";
const EXACT_AUTOMATION_TYPE_FILE =
  "app/(dashboard)/platforms/meta/automation/automation.module.css";
const EXACT_AUTOMATION_TYPE_START =
  "/* dashboard-v2-automation-exact-reference-type:start */";
const EXACT_AUTOMATION_TYPE_END =
  "/* dashboard-v2-automation-exact-reference-type:end */";
const EXACT_GOOGLE_OVERVIEW_TYPE_FILE =
  "components/google-ads/GoogleOverviewExact.module.css";
const EXACT_GOOGLE_OVERVIEW_TYPE_START =
  "/* dashboard-v2-google-overview-exact-reference-type:start */";
const EXACT_GOOGLE_OVERVIEW_TYPE_END =
  "/* dashboard-v2-google-overview-exact-reference-type:end */";
const EXACT_GOOGLE_ADVISOR_TYPE_FILE =
  "components/google-ads/GoogleAdvisorExact.module.css";
const EXACT_GOOGLE_ADVISOR_TYPE_START =
  "/* dashboard-v2-google-advisor-exact-reference-type:start */";
const EXACT_GOOGLE_ADVISOR_TYPE_END =
  "/* dashboard-v2-google-advisor-exact-reference-type:end */";
const EXACT_INSIGHTS_SHELL_TYPE_FILE =
  "components/insights/InsightsShellExact.module.css";
const EXACT_INSIGHTS_SHELL_TYPE_START =
  "/* dashboard-v2-insights-shell-exact-reference-type:start */";
const EXACT_INSIGHTS_SHELL_TYPE_END =
  "/* dashboard-v2-insights-shell-exact-reference-type:end */";
const EXACT_INSIGHTS_ANALYTICS_TYPE_FILE =
  "components/analytics/InsightsAnalyticsExact.module.css";
const EXACT_INSIGHTS_ANALYTICS_TYPE_START =
  "/* dashboard-v2-insights-analytics-exact-reference-type:start */";
const EXACT_INSIGHTS_ANALYTICS_TYPE_END =
  "/* dashboard-v2-insights-analytics-exact-reference-type:end */";
const EXACT_INSIGHTS_SEO_TYPE_FILE = "components/seo/InsightsSeoExact.module.css";
const EXACT_INSIGHTS_SEO_TYPE_START =
  "/* dashboard-v2-insights-seo-exact-reference-type:start */";
const EXACT_INSIGHTS_SEO_TYPE_END =
  "/* dashboard-v2-insights-seo-exact-reference-type:end */";
const EXACT_INSIGHTS_GEO_TYPE_FILE = "components/geo/InsightsGeoExact.module.css";
const EXACT_INSIGHTS_GEO_TYPE_START =
  "/* dashboard-v2-insights-geo-exact-reference-type:start */";
const EXACT_INSIGHTS_GEO_TYPE_END =
  "/* dashboard-v2-insights-geo-exact-reference-type:end */";

/**
 * Marker-bounded fragments copied from the canonical Dashboard v2 reference.
 * A file appears here only with its own start/end pair — never as a blanket
 * exemption — and every value inside is pinned by a companion test below.
 */
const EXACT_REFERENCE_MARKERS: ReadonlyArray<
  readonly [file: string, start: string, end: string | null]
> = [
  [EXACT_SHELL_TYPE_FILE, EXACT_SHELL_TYPE_START, EXACT_SHELL_TYPE_END],
  [EXACT_META_TYPE_FILE, EXACT_META_TYPE_START, EXACT_META_TYPE_END],
  [EXACT_CREATIVE_TYPE_FILE, EXACT_CREATIVE_TYPE_START, null],
  [EXACT_LAUNCHPAD_TYPE_FILE, EXACT_LAUNCHPAD_TYPE_START, EXACT_LAUNCHPAD_TYPE_END],
  [EXACT_AUTOMATION_TYPE_FILE, EXACT_AUTOMATION_TYPE_START, EXACT_AUTOMATION_TYPE_END],
  [
    EXACT_GOOGLE_OVERVIEW_TYPE_FILE,
    EXACT_GOOGLE_OVERVIEW_TYPE_START,
    EXACT_GOOGLE_OVERVIEW_TYPE_END,
  ],
  [
    EXACT_GOOGLE_ADVISOR_TYPE_FILE,
    EXACT_GOOGLE_ADVISOR_TYPE_START,
    EXACT_GOOGLE_ADVISOR_TYPE_END,
  ],
  [
    EXACT_INSIGHTS_SHELL_TYPE_FILE,
    EXACT_INSIGHTS_SHELL_TYPE_START,
    EXACT_INSIGHTS_SHELL_TYPE_END,
  ],
  [
    EXACT_INSIGHTS_ANALYTICS_TYPE_FILE,
    EXACT_INSIGHTS_ANALYTICS_TYPE_START,
    EXACT_INSIGHTS_ANALYTICS_TYPE_END,
  ],
  [EXACT_INSIGHTS_SEO_TYPE_FILE, EXACT_INSIGHTS_SEO_TYPE_START, EXACT_INSIGHTS_SEO_TYPE_END],
  [EXACT_INSIGHTS_GEO_TYPE_FILE, EXACT_INSIGHTS_GEO_TYPE_START, EXACT_INSIGHTS_GEO_TYPE_END],
];

function exactReferenceTypeBounds(file: string, source: string) {
  const entry = EXACT_REFERENCE_MARKERS.find(([marked]) => marked === file);
  if (!entry) return null;
  const [, startMarker, endMarker] = entry;
  const markerStart = source.indexOf(startMarker);
  const markerEnd = endMarker === null ? source.length : source.indexOf(endMarker);
  if (markerStart < 0 || markerEnd <= markerStart) return null;
  return {
    start: markerStart + startMarker.length,
    end: markerEnd,
  };
}

/** Every `font-size` declaration inside a marker block, below the floor. */
function narrowDeclarations(file: string, startMarker: string, endMarker: string | null) {
  const source = readFileSync(file, "utf8");
  expect(source.split(startMarker)).toHaveLength(2);
  if (endMarker !== null) expect(source.split(endMarker)).toHaveLength(2);
  const bounds = exactReferenceTypeBounds(file, source);
  expect(bounds).not.toBeNull();
  return Array.from(
    source
      .slice(bounds!.start, bounds!.end)
      .matchAll(/([^{}]+)\{[^{}]*font-size:\s*([0-9.]+)px;?[^{}]*\}/g),
  )
    .map((match) => ({
      selector: match[1]!.replace(/\s+/g, " ").trim(),
      size: Number(match[2]),
    }))
    .filter(({ size }) => size < 12);
}

describe("no essential text is rendered below the readable floor", () => {
  it("finds stylesheets to check", () => {
    expect(STYLESHEETS.length).toBeGreaterThan(5);
  });

  it("keeps the marker-bounded shell values narrow and exact", () => {
    const source = readFileSync(EXACT_SHELL_TYPE_FILE, "utf8");
    expect(source.split(EXACT_SHELL_TYPE_START)).toHaveLength(2);
    expect(source.split(EXACT_SHELL_TYPE_END)).toHaveLength(2);

    const bounds = exactReferenceTypeBounds(EXACT_SHELL_TYPE_FILE, source);
    expect(bounds).not.toBeNull();
    const exactShell = source.slice(bounds!.start, bounds!.end);
    const declarations = Array.from(
      exactShell.matchAll(
        /([^{}]+)\{[^{}]*font-size:\s*([0-9.]+)px;?[^{}]*\}/g,
      ),
    ).map((match) => ({
      selector: match[1]!.replace(/\s+/g, " ").trim(),
      size: Number(match[2]),
    }));

    expect(declarations).toEqual([
      { selector: ".adv-rail-version, .adv-rail-group", size: 9.5 },
      { selector: ".adv-rail-count", size: 10.5 },
      { selector: ".adv-rail-badge", size: 9 },
      { selector: ".adv-rail-avatar", size: 11.5 },
      { selector: ".adv-kbd", size: 10 },
    ]);
  });

  it("keeps the marker-bounded Meta values narrow and exact", () => {
    const source = readFileSync(EXACT_META_TYPE_FILE, "utf8");
    expect(source.split(EXACT_META_TYPE_START)).toHaveLength(2);
    expect(source.split(EXACT_META_TYPE_END)).toHaveLength(2);

    const bounds = exactReferenceTypeBounds(EXACT_META_TYPE_FILE, source);
    expect(bounds).not.toBeNull();
    const exactMeta = source.slice(bounds!.start, bounds!.end);
    const declarations = Array.from(
      exactMeta.matchAll(
        /([^{}]+)\{[^{}]*font-size:\s*([0-9.]+)px;?[^{}]*\}/g,
      ),
    ).map((match) => ({
      selector: match[1]!.replace(/\s+/g, " ").trim(),
      size: Number(match[2]),
    }));

    expect(declarations).toEqual([
      { selector: ".pageEyebrow, .asOfLine, .scopeRow > p", size: 11 },
      { selector: ".kpiLabel, .watchBadge, .inspectorEyebrow", size: 9.5 },
      {
        selector:
          ".snapshotDetail, .moneySub, .watchSegment, .healthyStats, .resumeButton, .postureDetail, .creativeDecisionLabel, .inspectorMoneyDetail",
        size: 11.5,
      },
      {
        selector: ".modeChip, .scopeOption > span, .healthyStrategy, .inspectorMeta",
        size: 10.5,
      },
      {
        selector:
          ".laneOption > span, .rowChip, .confidencePill, .nonSalesContext, .archiveStatus, .inspectorDecision, .evidenceRow > span:last-child",
        size: 11,
      },
      {
        selector:
          ".entityLevel, .watchLevel, .nonSalesLevel, .nonSalesMetricLabel, .postureLabel, .inspectorSectionLabel, .reasonHeading, .blockersHeading, .inspectorMiniLabel",
        size: 9,
      },
      { selector: ".archiveTable th, .provenance", size: 10 },
      { selector: ".creativeKind", size: 8 },
      { selector: ".creativeSparkLabel", size: 8.5 },
    ]);
  });

  it("keeps the canonical Creative Studio type exception exact", () => {
    const source = readFileSync(EXACT_CREATIVE_TYPE_FILE, "utf8");
    expect(source.split(EXACT_CREATIVE_TYPE_START)).toHaveLength(2);

    const bounds = exactReferenceTypeBounds(EXACT_CREATIVE_TYPE_FILE, source);
    expect(bounds).not.toBeNull();
    const exactCreative = source.slice(bounds!.start, bounds!.end);
    const declarations = Array.from(
      exactCreative.matchAll(
        /([^{}]+)\{[^{}]*font-size:\s*([0-9.]+)px;?[^{}]*\}/g,
      ),
    )
      .map((match) => ({
        selector: match[1]!
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\s+/g, " ")
          .trim(),
        size: Number(match[2]),
      }))
      .filter(({ size }) => size < 12);

    expect(declarations).toEqual([
      { selector: ".pageEyebrow", size: 11 },
      { selector: ".tabCount, .tabCountActive", size: 10 },
      { selector: ".mutedMono", size: 10.5 },
      { selector: ".unpinButton", size: 11 },
      { selector: ".kindBadge", size: 10 },
      { selector: ".statusBadge", size: 10.5 },
      {
        selector:
          ".boardMetric > span:first-child, .summaryMetric > span:first-child",
        size: 8.5,
      },
      { selector: ".columnsLabel", size: 9.5 },
      { selector: ".metricPickerHeader > span", size: 10 },
      { selector: ".metricCategory", size: 9 },
      { selector: ".metricCheckbox, .metricCheckboxSelected", size: 9 },
      { selector: ".metricDirection", size: 10 },
      { selector: ".heatLegend", size: 10 },
      { selector: ".assetTable th", size: 10 },
      { selector: ".rowCheckbox, .rowCheckboxSelected", size: 10 },
      { selector: ".creativeIdentityText > span:last-child", size: 10 },
      { selector: ".tableStatus", size: 10.5 },
      { selector: ".emptyTableCell", size: 11 },
      { selector: ".closingNote", size: 11 },
      { selector: ".angleCardHeader > span", size: 10 },
      { selector: ".angleBestLine", size: 11.5 },
      { selector: ".angleUsage", size: 10 },
      { selector: ".angleCoverage > span:first-child", size: 9.5 },
      { selector: ".angleGap", size: 11 },
      {
        selector: ".articleHeader > span:not(.insightPill, .heatRamp)",
        size: 10.5,
      },
      { selector: ".insightPill", size: 11 },
      { selector: ".copyTable th, .landingTable th, .matrixTable th", size: 10 },
      { selector: ".copyCell > span:last-child", size: 10 },
      { selector: ".anglePill", size: 10.5 },
      { selector: ".roasPill", size: 11.5 },
      { selector: ".emptyPanel", size: 11 },
      { selector: ".signalPill", size: 11 },
      { selector: ".readKind", size: 9 },
      { selector: ".testEstimate", size: 9 },
      {
        selector: ".readEmpty, .historyEmpty, .breakdownEmpty, .inboxEmpty",
        size: 11,
      },
      { selector: ".historyHeader span, .audienceSectionHeading span", size: 10.5 },
      { selector: ".historyRow > span:first-child", size: 10.5 },
      { selector: ".historyRow > span:last-child", size: 11 },
      { selector: ".inboxColumnHeader", size: 10 },
      { selector: ".inboxSource", size: 9 },
      { selector: ".inboxCardNote", size: 11.5 },
      { selector: ".avatar", size: 9 },
      { selector: ".inboxDue", size: 10 },
      { selector: ".inboxAction", size: 11 },
      { selector: ".audienceNote", size: 11.5 },
      { selector: ".breakdownHeader span", size: 8.5 },
      { selector: ".breakdownRow > span:first-child", size: 10.5 },
      { selector: ".breakdownRow > span:nth-child(3)", size: 10.5 },
      { selector: ".breakdownNote", size: 11 },
    ]);
  });

  it("keeps the marker-bounded Launchpad values narrow and exact", () => {
    const source = readFileSync(EXACT_LAUNCHPAD_TYPE_FILE, "utf8");
    expect(source.split(EXACT_LAUNCHPAD_TYPE_START)).toHaveLength(2);
    expect(source.split(EXACT_LAUNCHPAD_TYPE_END)).toHaveLength(2);

    const bounds = exactReferenceTypeBounds(EXACT_LAUNCHPAD_TYPE_FILE, source);
    expect(bounds).not.toBeNull();
    const exactLaunchpad = source.slice(bounds!.start, bounds!.end);
    const declarations = Array.from(
      exactLaunchpad.matchAll(
        /([^{}]+)\{[^{}]*font-size:\s*([0-9.]+)px;?[^{}]*\}/g,
      ),
    )
      .map((match) => ({
        selector: match[1]!.replace(/\s+/g, " ").trim(),
        size: Number(match[2]),
      }))
      .filter(({ size }) => size < 12);

    expect(declarations).toEqual([
      {
        selector:
          ".exactHeader p, .exactReceiptId, .exactModeChip, .exactValidationChip",
        size: 11,
      },
      {
        selector:
          ".exactStartChip, .exactSectionHeader span, .exactReceiptStatus",
        size: 10.5,
      },
      { selector: ".exactDraftTable th", size: 10 },
    ]);
  });

  it("keeps the marker-bounded Automation values narrow and exact", () => {
    const source = readFileSync(EXACT_AUTOMATION_TYPE_FILE, "utf8");
    expect(source.split(EXACT_AUTOMATION_TYPE_START)).toHaveLength(2);
    expect(source.split(EXACT_AUTOMATION_TYPE_END)).toHaveLength(2);

    const bounds = exactReferenceTypeBounds(EXACT_AUTOMATION_TYPE_FILE, source);
    expect(bounds).not.toBeNull();
    const exactAutomation = source.slice(bounds!.start, bounds!.end);
    const declarations = Array.from(
      exactAutomation.matchAll(
        /([^{}]+)\{[^{}]*font-size:\s*([0-9.]+)px;?[^{}]*\}/g,
      ),
    ).map((match) => ({
      selector: match[1]!.replace(/\s+/g, " ").trim(),
      size: Number(match[2]),
    }));

    expect(declarations).toEqual([
      { selector: ".eyebrow", size: 11 },
      { selector: ".cardKicker, .cardKickerDark", size: 9.5 },
      { selector: ".statusPill, .killNote", size: 11.5 },
      { selector: ".promotionCount", size: 11 },
      {
        selector:
          ".confirmationCount, .confirmationHint, .sectionHint, .autonomyTier",
        size: 10.5,
      },
      {
        selector:
          ".sectionFootnote, .rulesTable th, .ledgerTable th, .progressValue",
        size: 10,
      },
      { selector: ".autonomyNext, .ledgerUnknown", size: 11 },
      { selector: ".ledgerTime", size: 11.5 },
    ]);
  });

  it("keeps the marker-bounded Google Overview values narrow and exact", () => {
    const source = readFileSync(EXACT_GOOGLE_OVERVIEW_TYPE_FILE, "utf8");
    expect(source.split(EXACT_GOOGLE_OVERVIEW_TYPE_START)).toHaveLength(2);
    expect(source.split(EXACT_GOOGLE_OVERVIEW_TYPE_END)).toHaveLength(2);

    const bounds = exactReferenceTypeBounds(EXACT_GOOGLE_OVERVIEW_TYPE_FILE, source);
    expect(bounds).not.toBeNull();
    const exactOverview = source.slice(bounds!.start, bounds!.end);
    const declarations = Array.from(
      exactOverview.matchAll(
        /([^{}]+)\{[^{}]*font-size:\s*([0-9.]+)px;?[^{}]*\}/g,
      ),
    )
      .map((match) => ({
        selector: match[1]!.replace(/\s+/g, " ").trim(),
        size: Number(match[2]),
      }))
      .filter(({ size }) => size < 12);

    expect(declarations).toEqual([
      { selector: ".pageEyebrow", size: 11 },
      { selector: ".guardCopy, .sectionNote", size: 10.5 },
      { selector: ".metricLabel", size: 9.5 },
      { selector: ".metricDelta", size: 11.5 },
      {
        selector:
          ".metricDetail, .chartTooltip, .lookEvidence, .campaignTable th, .campaignType",
        size: 10,
      },
      { selector: ".chartAverageLabel", size: 8.5 },
      { selector: ".secondaryLabel, .severity, .budgetKpiLabel", size: 9 },
      { selector: ".shareValue, .pulsePill", size: 10.5 },
      { selector: ".roasPill", size: 11.5 },
      { selector: ".budgetKpiDetail", size: 11 },
      { selector: ".budgetAmount, .budgetReason", size: 11.5 },
    ]);
  });

  it("keeps the marker-bounded Google Advisor values narrow and exact", () => {
    const source = readFileSync(EXACT_GOOGLE_ADVISOR_TYPE_FILE, "utf8");
    expect(source.split(EXACT_GOOGLE_ADVISOR_TYPE_START)).toHaveLength(2);
    expect(source.split(EXACT_GOOGLE_ADVISOR_TYPE_END)).toHaveLength(2);

    const bounds = exactReferenceTypeBounds(EXACT_GOOGLE_ADVISOR_TYPE_FILE, source);
    expect(bounds).not.toBeNull();
    const exactAdvisor = source.slice(bounds!.start, bounds!.end);
    const declarations = Array.from(
      exactAdvisor.matchAll(
        /([^{}]+)\{[^{}]*font-size:\s*([0-9.]+)px;?[^{}]*\}/g,
      ),
    )
      .map((match) => ({
        selector: match[1]!.replace(/\s+/g, " ").trim(),
        size: Number(match[2]),
      }))
      .filter(({ size }) => size < 12);

    expect(declarations).toEqual([
      { selector: ".eyebrow", size: 11 },
      { selector: ".guardCopy", size: 10.5 },
      { selector: ".tileLabel", size: 9.5 },
      { selector: ".tileSub", size: 11 },
      { selector: ".bucket", size: 9 },
      { selector: ".cardType", size: 10.5 },
      { selector: ".mode", size: 9 },
      { selector: ".scope", size: 10.5 },
      { selector: ".changeLabel", size: 9.5 },
      { selector: ".infoLabel", size: 9 },
      { selector: ".confidence", size: 10 },
      { selector: ".closingCopy", size: 11 },
    ]);
  });

  it("keeps the marker-bounded Insights chrome values narrow and exact", () => {
    const source = readFileSync(EXACT_INSIGHTS_SHELL_TYPE_FILE, "utf8");
    expect(source.split(EXACT_INSIGHTS_SHELL_TYPE_START)).toHaveLength(2);
    expect(source.split(EXACT_INSIGHTS_SHELL_TYPE_END)).toHaveLength(2);

    const bounds = exactReferenceTypeBounds(EXACT_INSIGHTS_SHELL_TYPE_FILE, source);
    expect(bounds).not.toBeNull();
    const exactShell = source.slice(bounds!.start, bounds!.end);
    const declarations = Array.from(
      exactShell.matchAll(/([^{}]+)\{[^{}]*font-size:\s*([0-9.]+)px;?[^{}]*\}/g),
    )
      .map((match) => ({
        selector: match[1]!.replace(/\s+/g, " ").trim(),
        size: Number(match[2]),
      }))
      .filter(({ size }) => size < 12);

    expect(declarations).toEqual([
      { selector: ".eyebrow", size: 11 },
      { selector: ".dateChip :global(.adv-date-range-trigger)", size: 11.5 },
      { selector: ".sourceState", size: 10.5 },
    ]);
  });

  it("keeps the marker-bounded Insights Analytics values narrow and exact", () => {
    const source = readFileSync(EXACT_INSIGHTS_ANALYTICS_TYPE_FILE, "utf8");
    expect(source.split(EXACT_INSIGHTS_ANALYTICS_TYPE_START)).toHaveLength(2);
    expect(source.split(EXACT_INSIGHTS_ANALYTICS_TYPE_END)).toHaveLength(2);

    const bounds = exactReferenceTypeBounds(EXACT_INSIGHTS_ANALYTICS_TYPE_FILE, source);
    expect(bounds).not.toBeNull();
    const exactAnalytics = source.slice(bounds!.start, bounds!.end);
    const declarations = Array.from(
      exactAnalytics.matchAll(/([^{}]+)\{[^{}]*font-size:\s*([0-9.]+)px;?[^{}]*\}/g),
    )
      .map((match) => ({
        selector: match[1]!.replace(/\s+/g, " ").trim(),
        size: Number(match[2]),
      }))
      .filter(({ size }) => size < 12);

    expect(declarations).toEqual([
      { selector: ".kpiLabel", size: 9.5 },
      { selector: ".kpiDelta", size: 11.5 },
      { selector: ".segmentLabel", size: 10 },
      { selector: ".segmentBadge", size: 11 },
      { selector: ".segmentMetricLabel", size: 11 },
      { selector: ".kindChip", size: 9 },
      { selector: ".cardHint", size: 10.5 },
      { selector: ".th", size: 10 },
      { selector: ".signalChip", size: 11 },
      { selector: ".tableNote", size: 11.5 },
      { selector: ".tdCohortMono", size: 11.5 },
      { selector: ".retentionChip", size: 11 },
      { selector: ".trailingNote", size: 11.5 },
    ]);
  });

  it("keeps the marker-bounded Insights SEO values narrow and exact", () => {
    expect(
      narrowDeclarations(
        EXACT_INSIGHTS_SEO_TYPE_FILE,
        EXACT_INSIGHTS_SEO_TYPE_START,
        EXACT_INSIGHTS_SEO_TYPE_END,
      ),
    ).toEqual([
      { selector: ".kpiLabel", size: 9.5 },
      { selector: ".kpiDelta", size: 11 },
      { selector: ".kpiPrev", size: 10.5 },
      { selector: ".monthlyStatus", size: 10.5 },
      { selector: ".monthlyMeta", size: 11 },
      { selector: ".readsLabel", size: 10 },
      { selector: ".readChip", size: 11 },
      { selector: ".columnLabel", size: 10 },
      { selector: ".planOrdinal", size: 10 },
      { selector: ".cardHint", size: 10.5 },
      { selector: ".moverDelta", size: 11 },
      { selector: ".trailingNote", size: 11.5 },
      { selector: ".th", size: 10 },
      { selector: ".deltaChip", size: 11 },
      { selector: ".actionTone", size: 10.5 },
      { selector: ".actionMeta", size: 11.5 },
      { selector: ".excludedReason", size: 10.5 },
      { selector: ".findingSeverity", size: 9 },
      { selector: ".findingDetail", size: 11.5 },
    ]);
  });

  it("keeps the marker-bounded Insights AI-visibility values narrow and exact", () => {
    expect(
      narrowDeclarations(
        EXACT_INSIGHTS_GEO_TYPE_FILE,
        EXACT_INSIGHTS_GEO_TYPE_START,
        EXACT_INSIGHTS_GEO_TYPE_END,
      ),
    ).toEqual([
      { selector: ".statLabel", size: 9.5 },
      { selector: ".kpiSub", size: 11 },
      { selector: ".intentLabel", size: 10 },
      { selector: ".priorityPill", size: 10 },
      { selector: ".priorityMeta", size: 11.5 },
      { selector: ".highlightLabel", size: 9.5 },
      { selector: ".highlightPill", size: 10.5 },
      { selector: ".highlightSub", size: 11.5 },
      { selector: ".kindChip", size: 9 },
      { selector: ".cardHint", size: 10.5 },
      { selector: ".th", size: 10 },
      { selector: ".enginePill", size: 11.5 },
      { selector: ".valueChip", size: 10.5 },
      { selector: ".momentumChip", size: 10.5 },
      { selector: ".tdRecommendation", size: 11.5 },
      { selector: ".scorePill", size: 11 },
      { selector: ".tdSourcedBy", size: 11.5 },
      { selector: ".filterCount", size: 10 },
      { selector: ".intentChip", size: 10.5 },
      { selector: ".scoreToggle", size: 11 },
      { selector: ".breakdownLabel", size: 8.5 },
      { selector: ".breakdownValue", size: 9.5 },
      { selector: ".tdPosition", size: 11.5 },
      { selector: ".tdQueryRecommendation", size: 11.5 },
      { selector: ".tableNote", size: 11.5 },
      { selector: ".coveragePill", size: 10.5 },
      { selector: ".topicPriority", size: 11 },
      { selector: ".topicGap", size: 10 },
      { selector: ".topicQueryCount", size: 11 },
      { selector: ".topicChip", size: 11 },
      { selector: ".topicRecMeta", size: 11.5 },
      { selector: ".topicScore", size: 11 },
      { selector: ".topicAsideCaption", size: 10.5 },
      { selector: ".topicPosition", size: 11 },
      { selector: ".topicAuthority", size: 10.5 },
      { selector: ".trailingNote", size: 11.5 },
      { selector: ".playOrdinal", size: 11 },
      { selector: ".playChip", size: 10.5 },
      { selector: ".methodArrow", size: 11 },
    ]);
  });

  it("has no font-size below 12px outside the exact shell marker", () => {
    const violations: string[] = [];
    for (const file of STYLESHEETS) {
      const source = readFileSync(file, "utf8");
      const bounds = exactReferenceTypeBounds(file, source);
      for (const match of source.matchAll(FONT_SIZE)) {
        const size = Number(match[1]);
        const offset = match.index;
        const isExactReference =
          bounds !== null && offset >= bounds.start && offset < bounds.end;
        if (size < 12 && !isExactReference) {
          const line = source.slice(0, offset).split("\n").length;
          violations.push(`${file}:${line} — ${size}px`);
        }
      }
    }
    expect(
      violations,
      `text below the 12px floor:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps a real primary reading layer, not a wall of minimum-size text", () => {
    // The floor is not the target. If nothing is 13–14px, the surface has been
    // flattened to its minimum rather than given a reading hierarchy.
    const all = STYLESHEETS.flatMap((file) =>
      Array.from(readFileSync(file, "utf8").matchAll(FONT_SIZE)).map((match) =>
        Number(match[1]),
      ),
    );
    const primaryReading = all.filter((size) => size >= 13 && size <= 14);
    expect(primaryReading.length).toBeGreaterThan(20);
  });
});

/**
 * The uncovered surface, reported rather than enforced.
 *
 * This does not fail. Failing it would either force a redesign of every screen
 * or force an exemption nobody has agreed to. What it does is make the number
 * visible on every run, so "the floor is enforced" can never again be believed
 * about a surface where it is not.
 */
describe("the part of the floor that is not enforced", () => {
  it("reports how much sub-12px text lives in TSX, where this check cannot reach", () => {
    const files = execSync(
      "find app components -name '*.tsx' -not -name '*.test.tsx' -not -path '*/node_modules/*'",
      { encoding: "utf8" },
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const ARBITRARY = /text-\[(\d+(?:\.\d+)?)px\]/g;
    let below = 0;
    let total = 0;
    const perFile = new Map<string, number>();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(ARBITRARY)) {
        total += 1;
        if (Number(match[1]) < 12) {
          below += 1;
          perFile.set(file, (perFile.get(file) ?? 0) + 1);
        }
      }
    }

    const worst = [...perFile.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([file, count]) => `${count} ${file}`);

    console.warn(
      `[typography-floor] ${below} of ${total} arbitrary text sizes in TSX are below 12px, ` +
        `across ${perFile.size} files. Not enforced here. Worst: ${worst.join(", ")}`,
    );

    // The only assertion: the measurement itself still works. If this ever
    // reads zero, either the debt is gone or the pattern changed -- both are
    // worth noticing.
    expect(total).toBeGreaterThan(0);
  });
});
