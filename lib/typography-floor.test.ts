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

/**
 * Every marker-bounded fragment copied from the canonical Dashboard v2
 * reference, in one table.
 *
 * This used to be three parallel structures -- a triple of consts per surface,
 * an arm in a nested ternary, and a near-identical pin test -- so every parity
 * batch edited the same three places and every batch merge conflicted here.
 * Three separate batches independently started collapsing it; this is that
 * collapse finished. One row per surface, same assertions, one place to edit.
 *
 * Per-surface variations are data rather than forked code:
 *  - `end: null` runs the marker to end-of-file (only Creative Studio, which
 *    should gain an end delimiter).
 *  - `pinsBelowFloorOnly` says whether the pinned list was authored as only the
 *    sub-floor declarations (true) or as every font-size inside the marker
 *    (false). Both are exact; the second is stricter.
 *  - `stripsCommentsFromSelector` drops CSS comments before normalising the
 *    selector, which Creative Studio's fragment needs and no other does.
 */
interface ExactReferenceSurface {
  readonly name: string;
  readonly file: string;
  readonly start: string;
  readonly end: string | null;
  readonly pinsBelowFloorOnly: boolean;
  readonly stripsCommentsFromSelector: boolean;
  readonly pins: ReadonlyArray<{ selector: string; size: number }>;
}

const EXACT_REFERENCE_SURFACES: readonly ExactReferenceSurface[] = [
  {
    name: "shell",
    file: "app/globals.css",
    start:
      "/* dashboard-v2-shell-exact-reference-type:start */",
    end:
      "/* dashboard-v2-shell-exact-reference-type:end */",
    pinsBelowFloorOnly: false,
    stripsCommentsFromSelector: false,
    pins: [
      { selector: ".adv-rail-version, .adv-rail-group", size: 9.5 },
      { selector: ".adv-rail-count", size: 10.5 },
      { selector: ".adv-rail-badge", size: 9 },
      { selector: ".adv-rail-avatar", size: 11.5 },
      { selector: ".adv-kbd", size: 10 },
    ],
  },
  {
    name: "Meta",
    file: "components/meta/decision-center/MetaDecisionCenterExact.module.css",
    start:
      "/* dashboard-v2-meta-exact-reference-type:start */",
    end:
      "/* dashboard-v2-meta-exact-reference-type:end */",
    pinsBelowFloorOnly: false,
    stripsCommentsFromSelector: false,
    pins: [
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
    ],
  },
  {
    name: "Creative Studio",
    file: "components/creatives/CreativeStudioExact.module.css",
    start:
      "/* dashboard-v2-exact-font-exception: canonical Creative Studio labels use 8.5px-10.5px type. */",
    end:
      null,
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: true,
    pins: [
      { selector: ".pageEyebrow", size: 11 },
      { selector: ".sharedLinksCount", size: 10 },
      { selector: ".shareNudgeDismiss", size: 11 },
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
    ],
  },
  {
    name: "Launchpad",
    file: "app/(dashboard)/platforms/meta/launchpad/page.module.css",
    start:
      "/* dashboard-v2-exact-typography:start launchpad */",
    end:
      "/* dashboard-v2-exact-typography:end launchpad */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
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
    ],
  },
  {
    name: "Automation",
    file: "app/(dashboard)/platforms/meta/automation/automation.module.css",
    start:
      "/* dashboard-v2-automation-exact-reference-type:start */",
    end:
      "/* dashboard-v2-automation-exact-reference-type:end */",
    pinsBelowFloorOnly: false,
    stripsCommentsFromSelector: false,
    pins: [
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
      { selector: ".autonomyNext, .ledgerResult", size: 11 },
      { selector: ".ledgerTime", size: 11.5 },
      { selector: ".proposalAction", size: 11.5 },
      { selector: ".proposalEvidence, .proposalExpiry", size: 10 },
      { selector: ".ruleTrigger, .ruleComposerNote", size: 10 },
      { selector: ".modeChip", size: 10.5 },
      { selector: ".ruleFired", size: 11 },
    ],
  },
  {
    name: "Google Overview",
    file: "components/google-ads/GoogleOverviewExact.module.css",
    start:
      "/* dashboard-v2-google-overview-exact-reference-type:start */",
    end:
      "/* dashboard-v2-google-overview-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
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
    ],
  },
  {
    name: "Google Advisor",
    file: "components/google-ads/GoogleAdvisorExact.module.css",
    start:
      "/* dashboard-v2-google-advisor-exact-reference-type:start */",
    end:
      "/* dashboard-v2-google-advisor-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
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
    ],
  },
  {
    name: "Google Search/Products",
    file: "components/google-ads/GoogleSearchProductsExact.module.css",
    start:
      "/* dashboard-v2-google-search-products-exact-reference-type:start */",
    end:
      "/* dashboard-v2-google-search-products-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
      { selector: ".eyebrow", size: 11 },
      { selector: ".guardCopy, .cardSubtitle", size: 10.5 },
      { selector: ".statLabel, .allocationNote", size: 11.5 },
      { selector: ".filterCount", size: 10 },
      { selector: ".table th", size: 10 },
      { selector: ".chip, .matchChip", size: 10 },
      { selector: ".roasChip", size: 11.5 },
      { selector: ".keywordComponents, .allocationLabel", size: 9.5 },
      { selector: ".productSku", size: 10 },
      { selector: ".statusChip", size: 11 },
      { selector: ".tileLabel", size: 9.5 },
      { selector: ".tileSub, .footnote", size: 11 },
    ],
  },
  {
    name: "Google Assets/Plan",
    file: "components/google-ads/GoogleAssetsPlanExact.module.css",
    start:
      "/* dashboard-v2-google-assets-plan-exact-reference-type:start */",
    end:
      "/* dashboard-v2-google-assets-plan-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
      { selector: ".eyebrow", size: 11 },
      { selector: ".guardCopy, .cardSubtitle", size: 10.5 },
      { selector: ".table th, .activityTable th", size: 10 },
      { selector: ".roasChip", size: 11.5 },
      { selector: ".strengthChip", size: 11 },
      { selector: ".typeChip", size: 10.5 },
      { selector: ".assetKind", size: 9 },
      { selector: ".assetImpressions", size: 10.5 },
      { selector: ".performanceChip", size: 11 },
      { selector: ".imageShare", size: 10 },
      { selector: ".imageNote, .stepNote, .retentionLine", size: 11.5 },
      { selector: ".stepSource", size: 10 },
      { selector: ".queueCount", size: 10.5 },
      { selector: ".stepNumber", size: 11 },
      { selector: ".applyButton, .stepButton", size: 11.5 },
      { selector: ".activityWhen", size: 10.5 },
      { selector: ".footnote", size: 11 },
    ],
  },
  {
    name: "Integrations",
    file: "components/integrations/IntegrationsExact.module.css",
    start:
      "/* dashboard-v2-integrations-exact-reference-type:start */",
    end:
      "/* dashboard-v2-integrations-exact-reference-type:end */",
    pinsBelowFloorOnly: false,
    stripsCommentsFromSelector: false,
    pins: [
      { selector: ".eyebrow", size: 11 },
      { selector: ".statusPill", size: 11 },
      { selector: ".firstSyncLabel", size: 10 },
      { selector: ".firstSyncPercent, .cardMeta, .soonNote", size: 10.5 },
      { selector: ".stepLabel, .soonEta, .soonButton", size: 11.5 },
      { selector: ".stepNote", size: 9.5 },
      { selector: ".soonBadge", size: 8.5 },
    ],
  },
  {
    name: "Klaviyo",
    file: "components/klaviyo/KlaviyoExact.module.css",
    start:
      "/* dashboard-v2-klaviyo-exact-reference-type:start */",
    end:
      "/* dashboard-v2-klaviyo-exact-reference-type:end */",
    pinsBelowFloorOnly: false,
    stripsCommentsFromSelector: false,
    pins: [
      { selector: ".eyebrow, .statusChip, .footNote", size: 11 },
      { selector: ".th", size: 10 },
    ],
  },
  {
    name: "Insights chrome",
    file: "components/insights/InsightsShellExact.module.css",
    start:
      "/* dashboard-v2-insights-shell-exact-reference-type:start */",
    end:
      "/* dashboard-v2-insights-shell-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
      { selector: ".eyebrow", size: 11 },
      { selector: ".dateChip :global(.adv-date-range-trigger)", size: 11.5 },
      { selector: ".sourceState", size: 10.5 },
    ],
  },
  {
    name: "Insights Analytics",
    file: "components/analytics/InsightsAnalyticsExact.module.css",
    start:
      "/* dashboard-v2-insights-analytics-exact-reference-type:start */",
    end:
      "/* dashboard-v2-insights-analytics-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
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
    ],
  },
  {
    name: "Insights SEO",
    file: "components/seo/InsightsSeoExact.module.css",
    start:
      "/* dashboard-v2-insights-seo-exact-reference-type:start */",
    end:
      "/* dashboard-v2-insights-seo-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
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
    ],
  },
  {
    name: "Insights AI-visibility",
    file: "components/geo/InsightsGeoExact.module.css",
    start:
      "/* dashboard-v2-insights-geo-exact-reference-type:start */",
    end:
      "/* dashboard-v2-insights-geo-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
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
    ],
  },
  {
    name: "Reports",
    file: "components/reports/ReportsExact.module.css",
    start:
      "/* dashboard-v2-reports-exact-reference-type:start */",
    end:
      "/* dashboard-v2-reports-exact-reference-type:end */",
    pinsBelowFloorOnly: false,
    stripsCommentsFromSelector: false,
    pins: [
      {
      selector:
      ".kpiMiniKey, .briefLabel, .briefRowLabel, .briefNeedLabel, .briefWhyLabel",
      size: 8,
      },
      {
      selector:
      ".paletteSource, .aiTag, .blockSourceNote, .funnelLabel, .briefTag, .briefSpec, .briefFoot",
      size: 8.5,
      },
      { selector: ".templateCategory, .blockSize, .briefGate", size: 9 },
      {
      selector:
      ".templateContentIndex, .paletteEyebrow, .blockTitle, .inspectorEyebrow, .inspectorKind, .inspectorFootnote, .toggleNote, .briefStatus",
      size: 9.5,
      },
      {
      selector:
      ".tabCount, .templateCadence, .templateFooterMeta, .builderCounter, .canvasMeta, .briefFromMeta, .briefMakeSub",
      size: 10,
      },
      {
      selector:
      ".exportNote, .savedStatus, .savedMeta, .donutLegendItem, .briefWhy, .briefChip, .briefRule",
      size: 10.5,
      },
      {
      selector:
      ".eyebrow, .footnote, .blockHandle, .blockRemove, .kpiDelta, .recipient, .recipientAdd",
      size: 11,
      },
      {
      selector:
      ".paletteGroupName, .fieldLabel, .segment, .inspectorHintText, .briefFromName",
      size: 11.5,
      },
    ],
  },
  {
    name: "Commercial Truth",
    file: "components/commercial-truth/CommercialTruthExact.module.css",
    start:
      "/* dashboard-v2-commercial-truth-exact-reference-type:start */",
    end:
      "/* dashboard-v2-commercial-truth-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
      { selector: ".eyebrow", size: 11 },
      { selector: ".bandPill", size: 10 },
      { selector: ".bandStatKey", size: 9 },
      { selector: ".cardNote", size: 10 },
      { selector: ".fieldHint", size: 11 },
      { selector: ".packStamp", size: 10.5 },
      { selector: ".splitValue", size: 11 },
      { selector: ".consumerLast", size: 9.5 },
      { selector: ".consumerReads", size: 10 },
      { selector: ".logTime", size: 10 },
      { selector: ".logWhy", size: 11.5 },
      { selector: ".listFoot", size: 10 },
      { selector: ".scenarioStubSpend", size: 10 },
      { selector: ".scenarioSpendSymbol", size: 10.5 },
      { selector: ".scenarioStubRoasSub", size: 9.5 },
      { selector: ".scenarioRoasSymbol", size: 10.5 },
      { selector: ".scenarioRowSub", size: 9.5 },
      { selector: ".cardFoot", size: 10.5 },
      { selector: ".bandCardRange", size: 9.5 },
      { selector: ".bandCardShare", size: 11 },
      { selector: ".bandCardVerdict", size: 11 },
      { selector: ".shareNote", size: 10 },
      { selector: ".spendTh", size: 10 },
      { selector: ".spendMeta", size: 9.5 },
      { selector: ".spendShareLabel", size: 10 },
      { selector: ".spendRoasChip", size: 11.5 },
      { selector: ".spendDeltaCell", size: 11.5 },
      { selector: ".spendVerdictChip", size: 11 },
      { selector: ".spendFootTarget", size: 10 },
    ],
  },
  {
    name: "Team",
    file: "components/team/TeamExact.module.css",
    start:
      "/* dashboard-v2-team-exact-reference-type:start */",
    end:
      "/* dashboard-v2-team-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
      { selector: ".eyebrow", size: 11 },
      { selector: ".seatsEyebrow", size: 10 },
      { selector: ".cardSub", size: 10.5 },
      { selector: ".th", size: 10 },
      { selector: ".avatar", size: 11 },
      { selector: ".memberEmail", size: 11.5 },
      { selector: ".roleChip", size: 11 },
      { selector: ".faChip", size: 10.5 },
      { selector: ".actionsCell", size: 11.5 },
      { selector: ".activeCell", size: 10.5 },
      { selector: ".inviteListMeta", size: 11 },
      { selector: ".inviteListRole", size: 10.5 },
      { selector: ".inviteAction", size: 11.5 },
      { selector: ".eventTime", size: 10 },
      { selector: ".cardFoot", size: 10 },
    ],
  },
  {
    name: "Settings",
    file: "components/settings/SettingsExact.module.css",
    start:
      "/* dashboard-v2-settings-exact-reference-type:start */",
    end:
      "/* dashboard-v2-settings-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
      { selector: ".eyebrow", size: 11 },
    ],
  },
  {
    name: "creative evidence window",
    file: "components/creatives/CreativeEvidenceWindowExact.module.css",
    start:
      "/* dashboard-v2-evidence-window-exact-reference-type:start */",
    end:
      "/* dashboard-v2-evidence-window-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
      {
      selector:
      ".cardEyebrow, .cardEyebrowSpaced, .cardEyebrowReasons, .cardEyebrowTight",
      size: 9,
      },
      { selector: ".headerEyebrow, .funnelSub, .placementStats", size: 9.5 },
      { selector: ".previewPlaceholder, .provenance", size: 10 },
      {
      selector: ".previewKind, .adSetSpend, .adSetRoas, .adSetNote",
      size: 10.5,
      },
      { selector: ".bandPill, .seriesNote, .factValue", size: 11 },
      {
      selector: ".moneySub, .funnelLabel, .placementHead, .factLabel",
      size: 11.5,
      },
    ],
  },
  {
    name: "copy detail drawer",
    file: "components/creatives/CopyDetailDrawerExact.module.css",
    start:
      "/* dashboard-v2-copy-drawer-exact-reference-type:start */",
    end:
      "/* dashboard-v2-copy-drawer-exact-reference-type:end */",
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: false,
    pins: [
      { selector: ".statLabel", size: 8.5 },
      { selector: ".statSub, .cardEyebrow, .alternateAngle", size: 9 },
      { selector: ".headerEyebrow, .alternatesHead span", size: 9.5 },
      { selector: ".footnote", size: 10 },
      { selector: ".anglePill, .draftButton", size: 10.5 },
      { selector: ".alternateWhy", size: 11 },
    ],
  },
  {
    name: "share modal",
    file: "components/creatives/share/ShareSnapshotModal.module.css",
    start:
      "/* dashboard-v2-exact-font-exception: canonical Share modal labels use 9px-11.5px IBM Plex Mono type, matching the reference's own tag/meta/badge scale. */",
    end: null,
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: true,
    pins: [
      { selector: ".sectionLabel", size: 9.5 },
      { selector: ".presetTag", size: 9.5 },
      { selector: ".previewHead span", size: 9.5 },
      { selector: ".previewIncluded > p", size: 9 },
      { selector: ".previewRemoved > p", size: 9 },
      { selector: ".rulesCard > p", size: 9 },
      { selector: ".keepCard > p", size: 9 },
      { selector: ".readyUrlCard > p", size: 9 },
    ],
  },
  {
    name: "shared links manager",
    file: "components/creatives/share/SharedLinksManager.module.css",
    start:
      "/* dashboard-v2-exact-font-exception: canonical Shared links manager labels use 9px-11.5px IBM Plex Mono type. */",
    end: null,
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: true,
    pins: [{ selector: ".eyebrow", size: 9.5 }],
  },
  {
    name: "public share page",
    file: "components/zero-base/creative/PublicSharePage.module.css",
    start:
      "/* dashboard-v2-exact-font-exception: canonical public share page labels use 8px-11.5px IBM Plex Mono/body type, matching the reference's own eyebrow/meta/badge scale. */",
    end: null,
    pinsBelowFloorOnly: true,
    stripsCommentsFromSelector: true,
    pins: [
      { selector: ".snapshotTag", size: 9.5 },
      { selector: ".frozenPill", size: 11 },
      { selector: ".readOnlyPill", size: 11 },
      { selector: ".metaLine", size: 10 },
      { selector: ".senderNoteLabel", size: 9 },
      { selector: ".csvText span", size: 11 },
      { selector: ".csvMessageDone, .csvMessageFail", size: 11.5 },
      { selector: ".csvOffNote", size: 10 },
      { selector: ".formatBadge", size: 9.5 },
      { selector: ".mediaMissing", size: 11.5 },
      { selector: ".creativeLaunch", size: 9.5 },
      { selector: ".metricRow span", size: 11.5 },
      { selector: ".metricsEmpty", size: 11.5 },
      { selector: ".stageLabel", size: 11.5 },
      { selector: ".stageBand", size: 9.5 },
      { selector: ".stagePlain", size: 10.5 },
      { selector: ".dropOffTitle", size: 11.5 },
      { selector: ".dropOffLabels span", size: 8 },
      { selector: ".dropOffCaption", size: 10.5 },
      { selector: ".suggestionEyebrow", size: 8.5 },
      { selector: ".rawLine", size: 9 },
      { selector: ".comparisonHead span", size: 10 },
      { selector: ".tableScroll th", size: 9.5 },
      { selector: ".tableNote", size: 10 },
      { selector: ".actionsHead span", size: 10 },
      { selector: ".actionHead span", size: 10 },
      { selector: ".actionOutcome", size: 11 },
      { selector: ".notesHead span", size: 10 },
      { selector: ".noteAvatar", size: 10 },
      { selector: ".noteName", size: 11.5 },
      { selector: ".senderTag", size: 9 },
      { selector: ".noteTime", size: 9 },
      { selector: ".noteError", size: 11 },
      { selector: ".noteFooter", size: 9 },
      { selector: ".footer p:first-child", size: 11.5 },
      { selector: ".footerSub", size: 11 },
      { selector: ".footerBrand", size: 9.5 },
      { selector: ".emptyFooterLine", size: 9.5 },
      { selector: ".unavailableFooter span:last-child", size: 10 },
    ],
  },
];

function exactReferenceTypeBounds(file: string, source: string) {
  const surface = EXACT_REFERENCE_SURFACES.find((entry) => entry.file === file);
  if (!surface) return null;
  const markerStart = source.indexOf(surface.start);
  const markerEnd =
    surface.end === null ? source.length : source.indexOf(surface.end);
  if (markerStart < 0 || markerEnd <= markerStart) return null;
  return { start: markerStart + surface.start.length, end: markerEnd };
}

function markerBoundedDeclarations(surface: ExactReferenceSurface) {
  const source = readFileSync(surface.file, "utf8");
  const bounds = exactReferenceTypeBounds(surface.file, source);
  const declarations =
    bounds === null
      ? []
      : Array.from(
          source
            .slice(bounds.start, bounds.end)
            .matchAll(/([^{}]+)\{[^{}]*font-size:\s*([0-9.]+)px;?[^{}]*\}/g),
        ).map((match) => {
          const raw = surface.stripsCommentsFromSelector
            ? match[1]!.replace(/\/\*[\s\S]*?\*\//g, "")
            : match[1]!;
          return {
            selector: raw.replace(/\s+/g, " ").trim(),
            size: Number(match[2]),
          };
        });
  return { source, bounds, declarations };
}

describe("no essential text is rendered below the readable floor", () => {
  it("finds stylesheets to check", () => {
    expect(STYLESHEETS.length).toBeGreaterThan(5);
  });

  it("registers every exact-reference stylesheet exactly once", () => {
    const files = EXACT_REFERENCE_SURFACES.map((surface) => surface.file);
    expect(new Set(files).size).toBe(files.length);
  });

  for (const surface of EXACT_REFERENCE_SURFACES) {
    it(`keeps the marker-bounded ${surface.name} values narrow and exact`, () => {
      const { source, bounds, declarations } = markerBoundedDeclarations(surface);
      expect(source.split(surface.start)).toHaveLength(2);
      if (surface.end !== null) {
        expect(source.split(surface.end)).toHaveLength(2);
      }
      expect(bounds).not.toBeNull();
      const pinned = surface.pinsBelowFloorOnly
        ? declarations.filter(({ size }) => size < 12)
        : declarations;
      expect(pinned).toEqual(surface.pins);
    });
  }

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
