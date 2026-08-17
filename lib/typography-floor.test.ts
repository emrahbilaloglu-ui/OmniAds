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

function exactReferenceTypeBounds(file: string, source: string) {
  const markers: readonly [string, string | null] | null =
    file === EXACT_SHELL_TYPE_FILE
      ? [EXACT_SHELL_TYPE_START, EXACT_SHELL_TYPE_END]
      : file === EXACT_META_TYPE_FILE
        ? [EXACT_META_TYPE_START, EXACT_META_TYPE_END]
        : file === EXACT_CREATIVE_TYPE_FILE
          ? [EXACT_CREATIVE_TYPE_START, null]
        : null;
  if (!markers) return null;
  const [startMarker, endMarker] = markers;
  const markerStart = source.indexOf(startMarker);
  const markerEnd = endMarker === null ? source.length : source.indexOf(endMarker);
  if (markerStart < 0 || markerEnd <= markerStart) return null;
  return {
    start: markerStart + startMarker.length,
    end: markerEnd,
  };
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
