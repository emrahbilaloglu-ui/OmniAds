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
 * an arm in a nested ternary, and a near-identical pin test -- which meant that
 * every parity batch touched the same three places and every batch merge
 * conflicted here. One row per surface is the same assertions with one place to
 * edit.
 *
 * `pins: null` registers a marker without pinning its values. Only the Creative
 * Studio fragment is in that state, because its marker has no end delimiter and
 * runs to end-of-file; it should gain an end marker and a pinned list.
 *
 * `pinsBelowFloorOnly` says whether that surface's pinned list was authored as
 * only the sub-floor declarations (true) or as every font-size inside the
 * marker (false). Both are exact; the second is stricter.
 */
interface ExactReferenceSurface {
  readonly name: string | null;
  readonly file: string;
  readonly start: string;
  readonly end: string | null;
  readonly pins: ReadonlyArray<{ selector: string; size: number }> | null;
  readonly pinsBelowFloorOnly: boolean;
}

const EXACT_REFERENCE_SURFACES: readonly ExactReferenceSurface[] = [
  {
    name: "shell",
    file: "app/globals.css",
    start:
      "/* dashboard-v2-shell-exact-reference-type:start */",
    end:
      "/* dashboard-v2-shell-exact-reference-type:end */",
    pins: [
      { selector: ".adv-rail-version, .adv-rail-group", size: 9.5 },
      { selector: ".adv-rail-count", size: 10.5 },
      { selector: ".adv-rail-badge", size: 9 },
      { selector: ".adv-rail-avatar", size: 11.5 },
      { selector: ".adv-kbd", size: 10 },
    ],
    pinsBelowFloorOnly: false,
  },
  {
    name: "Meta",
    file: "components/meta/decision-center/MetaDecisionCenterExact.module.css",
    start:
      "/* dashboard-v2-meta-exact-reference-type:start */",
    end:
      "/* dashboard-v2-meta-exact-reference-type:end */",
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
    pinsBelowFloorOnly: false,
  },
  {
    name: null,
    file: "components/creatives/CreativeStudioExact.module.css",
    start:
      "/* dashboard-v2-exact-font-exception: canonical Creative Studio labels use 8.5px-10.5px type. */",
    end:
      null,
    pins: null,
    pinsBelowFloorOnly: false,
  },
  {
    name: "Launchpad",
    file: "app/(dashboard)/platforms/meta/launchpad/page.module.css",
    start:
      "/* dashboard-v2-exact-typography:start launchpad */",
    end:
      "/* dashboard-v2-exact-typography:end launchpad */",
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
    pinsBelowFloorOnly: true,
  },
  {
    name: "Automation",
    file: "app/(dashboard)/platforms/meta/automation/automation.module.css",
    start:
      "/* dashboard-v2-automation-exact-reference-type:start */",
    end:
      "/* dashboard-v2-automation-exact-reference-type:end */",
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
      { selector: ".autonomyNext, .ledgerUnknown", size: 11 },
      { selector: ".ledgerTime", size: 11.5 },
    ],
    pinsBelowFloorOnly: false,
  },
  {
    name: "Google Overview",
    file: "components/google-ads/GoogleOverviewExact.module.css",
    start:
      "/* dashboard-v2-google-overview-exact-reference-type:start */",
    end:
      "/* dashboard-v2-google-overview-exact-reference-type:end */",
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
    pinsBelowFloorOnly: true,
  },
  {
    name: "Google Advisor",
    file: "components/google-ads/GoogleAdvisorExact.module.css",
    start:
      "/* dashboard-v2-google-advisor-exact-reference-type:start */",
    end:
      "/* dashboard-v2-google-advisor-exact-reference-type:end */",
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
    pinsBelowFloorOnly: true,
  },
  {
    name: "Google Search/Products",
    file: "components/google-ads/GoogleSearchProductsExact.module.css",
    start:
      "/* dashboard-v2-google-search-products-exact-reference-type:start */",
    end:
      "/* dashboard-v2-google-search-products-exact-reference-type:end */",
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
    pinsBelowFloorOnly: true,
  },
  {
    name: "Integrations",
    file: "components/integrations/IntegrationsExact.module.css",
    start:
      "/* dashboard-v2-integrations-exact-reference-type:start */",
    end:
      "/* dashboard-v2-integrations-exact-reference-type:end */",
    pins: [
      { selector: ".eyebrow", size: 11 },
      { selector: ".statusPill", size: 11 },
      { selector: ".firstSyncLabel", size: 10 },
      { selector: ".firstSyncPercent, .cardMeta, .soonNote", size: 10.5 },
      { selector: ".stepLabel, .soonEta, .soonButton", size: 11.5 },
      { selector: ".stepNote", size: 9.5 },
      { selector: ".soonBadge", size: 8.5 },
    ],
    pinsBelowFloorOnly: false,
  },
  {
    name: "Klaviyo",
    file: "components/klaviyo/KlaviyoExact.module.css",
    start:
      "/* dashboard-v2-klaviyo-exact-reference-type:start */",
    end:
      "/* dashboard-v2-klaviyo-exact-reference-type:end */",
    pins: [
      { selector: ".eyebrow, .statusChip, .footNote", size: 11 },
      { selector: ".th", size: 10 },
    ],
    pinsBelowFloorOnly: false,
  },
  {
    name: "Insights chrome",
    file: "components/insights/InsightsShellExact.module.css",
    start:
      "/* dashboard-v2-insights-shell-exact-reference-type:start */",
    end:
      "/* dashboard-v2-insights-shell-exact-reference-type:end */",
    pins: [
      { selector: ".eyebrow", size: 11 },
      { selector: ".dateChip :global(.adv-date-range-trigger)", size: 11.5 },
      { selector: ".sourceState", size: 10.5 },
    ],
    pinsBelowFloorOnly: true,
  },
  {
    name: "Insights Analytics",
    file: "components/analytics/InsightsAnalyticsExact.module.css",
    start:
      "/* dashboard-v2-insights-analytics-exact-reference-type:start */",
    end:
      "/* dashboard-v2-insights-analytics-exact-reference-type:end */",
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
    pinsBelowFloorOnly: true,
  },
  {
    name: "Reports",
    file: "components/reports/ReportsExact.module.css",
    start:
      "/* dashboard-v2-reports-exact-reference-type:start */",
    end:
      "/* dashboard-v2-reports-exact-reference-type:end */",
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
    pinsBelowFloorOnly: false,
  },
  {
    name: "creative evidence window",
    file: "components/creatives/CreativeEvidenceWindowExact.module.css",
    start:
      "/* dashboard-v2-evidence-window-exact-reference-type:start */",
    end:
      "/* dashboard-v2-evidence-window-exact-reference-type:end */",
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
    pinsBelowFloorOnly: true,
  },
  {
    name: "copy detail drawer",
    file: "components/creatives/CopyDetailDrawerExact.module.css",
    start:
      "/* dashboard-v2-copy-drawer-exact-reference-type:start */",
    end:
      "/* dashboard-v2-copy-drawer-exact-reference-type:end */",
    pins: [
      { selector: ".statLabel", size: 8.5 },
      { selector: ".statSub, .cardEyebrow, .alternateAngle", size: 9 },
      { selector: ".headerEyebrow, .alternatesHead span", size: 9.5 },
      { selector: ".footnote", size: 10 },
      { selector: ".anglePill, .draftButton", size: 10.5 },
      { selector: ".alternateWhy", size: 11 },
    ],
    pinsBelowFloorOnly: true,
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
        ).map((match) => ({
          selector: match[1]!.replace(/\s+/g, " ").trim(),
          size: Number(match[2]),
        }));
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
    if (surface.pins === null) continue;
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
