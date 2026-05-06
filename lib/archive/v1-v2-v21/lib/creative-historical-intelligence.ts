import {
  buildCreativeFamilySeeds,
  buildEmptyCreativeHistoricalAnalysis,
  chooseCreativeFamilyLabel,
  type CreativeDecisionOsInputRow,
  type CreativeHistoricalAnalysis,
  type CreativeHistoricalAnalysisBucket,
  type CreativeHistoricalFamilyPerformance,
} from "@/lib/creative-decision-os";

const LOW_MATERIALITY_SPEND = 40;
const LOW_MATERIALITY_IMPRESSIONS = 2_000;
const MAX_BUCKETS = 4;

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function normalizeToken(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function titleCaseToken(value: string | null | undefined, fallback: string) {
  const normalized = normalizeToken(value);
  if (!normalized) return fallback;
  return normalized
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function totalSpend(rows: CreativeDecisionOsInputRow[]) {
  return rows.reduce((sum, row) => sum + row.spend, 0);
}

function totalPurchaseValue(rows: CreativeDecisionOsInputRow[]) {
  return rows.reduce((sum, row) => sum + row.purchaseValue, 0);
}

function totalPurchases(rows: CreativeDecisionOsInputRow[]) {
  return rows.reduce((sum, row) => sum + row.purchases, 0);
}

function dominantString(values: Array<string | null | undefined>, fallback: string) {
  const counts = new Map<string, number>();
  values
    .map((value) => normalizeToken(value))
    .filter(Boolean)
    .forEach((value) => {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    });

  const winner = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0].localeCompare(right[0]);
  })[0]?.[0];

  return titleCaseToken(winner, fallback);
}

function isMaterialSelectedCreative(row: CreativeDecisionOsInputRow) {
  return !(
    row.spend < LOW_MATERIALITY_SPEND &&
    row.purchases === 0 &&
    row.impressions < LOW_MATERIALITY_IMPRESSIONS
  );
}

function buildBucketSummary(input: {
  label: string;
  creativeCount: number;
  spend: number;
  roas: number;
  purchases: number;
  dimensionLabel: string;
}) {
  return `${input.dimensionLabel} ${input.label} covers ${input.creativeCount} creative(s), ${input.spend.toFixed(0)} spend, ${input.roas.toFixed(2)}x ROAS, and ${input.purchases} purchase(s) in the selected period.`;
}

function aggregateBuckets(input: {
  rows: CreativeDecisionOsInputRow[];
  keyOf: (row: CreativeDecisionOsInputRow) => string | null;
  labelOf: (key: string) => string;
  dimensionLabel: string;
}): CreativeHistoricalAnalysisBucket[] {
  const groups = new Map<string, CreativeDecisionOsInputRow[]>();
  for (const row of input.rows) {
    const key = input.keyOf(row);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const spendTotal = Math.max(totalSpend(input.rows), 0.0001);
  return [...groups.entries()]
    .map(([key, rows]) => {
      const spend = totalSpend(rows);
      const purchaseValue = totalPurchaseValue(rows);
      const purchases = totalPurchases(rows);
      const roas = spend > 0 ? purchaseValue / spend : 0;
      const label = input.labelOf(key);
      return {
        label,
        creativeCount: rows.length,
        spend: round(spend, 2),
        purchaseValue: round(purchaseValue, 2),
        purchases,
        roas: round(roas, 2),
        shareOfSpend: round(spend / spendTotal, 4),
        summary: buildBucketSummary({
          label,
          creativeCount: rows.length,
          spend,
          roas,
          purchases,
          dimensionLabel: input.dimensionLabel,
        }),
      } satisfies CreativeHistoricalAnalysisBucket;
    })
    .sort((left, right) => {
      if (right.spend !== left.spend) return right.spend - left.spend;
      if (right.purchases !== left.purchases) return right.purchases - left.purchases;
      return left.label.localeCompare(right.label);
    })
    .slice(0, MAX_BUCKETS);
}

function buildFamilyPerformance(
  rows: CreativeDecisionOsInputRow[],
): CreativeHistoricalFamilyPerformance[] {
  const familySeeds = buildCreativeFamilySeeds(rows);
  const grouped = new Map<string, CreativeDecisionOsInputRow[]>();

  for (const row of rows) {
    const familySeed = familySeeds.get(row.creativeId);
    if (!familySeed) continue;
    grouped.set(familySeed.familyId, [...(grouped.get(familySeed.familyId) ?? []), row]);
  }

  return [...grouped.entries()]
    .map(([familyId, familyRows]) => {
      const familySeed = familySeeds.get(familyRows[0]?.creativeId ?? "");
      const spend = totalSpend(familyRows);
      const purchaseValue = totalPurchaseValue(familyRows);
      const purchases = totalPurchases(familyRows);
      const roas = spend > 0 ? purchaseValue / spend : 0;
      const topHook = dominantString(
        familyRows.map((row) => row.aiTags?.hookTactic?.[0] ?? null),
        "Unlabeled",
      );
      const topAngle = dominantString(
        familyRows.map((row) => row.aiTags?.messagingAngle?.[0] ?? null),
        "Unlabeled",
      );
      const dominantFormat = dominantString(
        familyRows.map((row) => row.creativeFormat ?? null),
        "Image",
      );
      const familyLabel = chooseCreativeFamilyLabel(familyRows);

      return {
        familyId,
        familyLabel,
        familySource: familySeed?.familySource ?? "singleton",
        creativeCount: familyRows.length,
        dominantFormat,
        spend: round(spend, 2),
        purchaseValue: round(purchaseValue, 2),
        purchases,
        roas: round(roas, 2),
        topHook: topHook === "Unlabeled" ? null : topHook,
        topAngle: topAngle === "Unlabeled" ? null : topAngle,
        summary: `${familyLabel} covers ${familyRows.length} creative(s) with ${spend.toFixed(0)} spend and ${roas.toFixed(2)}x ROAS in the selected period.`,
      } satisfies CreativeHistoricalFamilyPerformance;
    })
    .sort((left, right) => {
      if (right.spend !== left.spend) return right.spend - left.spend;
      if (right.purchases !== left.purchases) return right.purchases - left.purchases;
      return left.familyLabel.localeCompare(right.familyLabel);
    })
    .slice(0, MAX_BUCKETS);
}

export function buildCreativeHistoricalAnalysis(input: {
  startDate: string;
  endDate: string;
  rows: CreativeDecisionOsInputRow[];
}): CreativeHistoricalAnalysis {
  const materialRows = input.rows.filter(isMaterialSelectedCreative);
  if (materialRows.length === 0) {
    return {
      ...buildEmptyCreativeHistoricalAnalysis({
        startDate: input.startDate,
        endDate: input.endDate,
        summary:
          "Selected-period historical analysis found no material creative evidence. This block stays descriptive and does not change deterministic Decision Signals.",
      }),
      selectedWindow: {
        startDate: input.startDate,
        endDate: input.endDate,
        rowCount: input.rows.length,
        materialRowCount: 0,
        note: "Analysis only. Live decisions continue to use the primary decision window.",
      },
    };
  }

  const winningFormats = aggregateBuckets({
    rows: materialRows,
    keyOf: (row) => normalizeToken(row.creativeFormat ?? row.taxonomyVisualFormat ?? null),
    labelOf: (key) => titleCaseToken(key, "Unlabeled"),
    dimensionLabel: "Format",
  });
  const hookTrends = aggregateBuckets({
    rows: materialRows,
    keyOf: (row) => normalizeToken(row.aiTags?.hookTactic?.[0] ?? null),
    labelOf: (key) => titleCaseToken(key, "Unlabeled"),
    dimensionLabel: "Hook",
  });
  const angleTrends = aggregateBuckets({
    rows: materialRows,
    keyOf: (row) => normalizeToken(row.aiTags?.messagingAngle?.[0] ?? null),
    labelOf: (key) => titleCaseToken(key, "Unlabeled"),
    dimensionLabel: "Angle",
  });
  const familyPerformance = buildFamilyPerformance(materialRows);

  const leadingFormat = winningFormats[0]?.label ?? "No dominant format";
  const leadingHook = hookTrends[0]?.label ?? "No dominant hook";
  const leadingAngle = angleTrends[0]?.label ?? "No dominant angle";

  return {
    summary: `${leadingFormat} leads the selected-period format mix while ${leadingHook} and ${leadingAngle} describe the strongest visible pattern. This block is analysis-only and does not change deterministic Decision Signals.`,
    selectedWindow: {
      startDate: input.startDate,
      endDate: input.endDate,
      rowCount: input.rows.length,
      materialRowCount: materialRows.length,
      note: "Analysis only. Live decisions continue to use the primary decision window.",
    },
    winningFormats,
    hookTrends,
    angleTrends,
    familyPerformance,
  };
}
