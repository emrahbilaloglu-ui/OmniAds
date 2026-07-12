import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import { resolveMetaFunnelCohort, type MetaFunnelCohort } from "@/lib/meta/funnel-cohort";

export type MetaCampaignLaneLabel = "Scaling" | "Validation" | "Test";
export type MetaCampaignLaneReason =
  | "strong_efficiency"
  | "balanced_validation"
  | "hard_test"
  | "exploratory_test";
export type MetaCampaignLaneConfidence = "high" | "medium";
export interface MetaCampaignLaneSignal {
  lane: MetaCampaignLaneLabel;
  family: MetaCampaignFamily;
  reason: MetaCampaignLaneReason;
  confidence: MetaCampaignLaneConfidence;
}
export interface MetaCampaignLaneFamilySummary {
  accountId: string;
  currency: string;
  family: MetaCampaignFamily;
  familyLabel: string;
  scalingCount: number;
  validationCount: number;
  testCount: number;
  unclassifiedCount: number;
  eligibleForBudgetShift: boolean;
}
export type MetaCampaignFamily =
  | "purchase_value"
  | "mid_funnel"
  | "lead"
  | "awareness"
  | "engagement"
  | "other";

function normalizeGoal(value: string | null | undefined) {
  return (value ?? "").toLowerCase().trim();
}

type CampaignFamilyInput = Pick<
  MetaCampaignRow,
  | "id"
  | "accountId"
  | "currency"
  | "optimizationGoal"
  | "customEventType"
  | "objective"
  | "purchases"
  | "revenue"
>;

function familyFromFunnelCohort(cohort: MetaFunnelCohort): MetaCampaignFamily {
  if (cohort === "purchase") return "purchase_value";
  if (cohort === "mid_funnel") return "mid_funnel";
  if (cohort === "lead") return "lead";
  if (cohort === "upper_funnel" || cohort === "traffic") return "awareness";
  if (cohort === "engagement") return "engagement";
  return "other";
}

export function resolveMetaCampaignFamily(row: CampaignFamilyInput): MetaCampaignFamily {
  return familyFromFunnelCohort(resolveMetaFunnelCohort({
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
    objective: row.objective,
    purchases: row.purchases,
    revenue: row.revenue,
  }));
}

export function metaCampaignFamilyLabel(family: MetaCampaignFamily) {
  if (family === "purchase_value") return "purchase/value";
  if (family === "mid_funnel") return "mid-funnel conversion";
  if (family === "lead") return "lead generation";
  if (family === "awareness") return "awareness/video";
  if (family === "engagement") return "engagement/messaging";
  return "other";
}

export function isScalingCampaignFamily(family: MetaCampaignFamily) {
  return family === "purchase_value" || family === "mid_funnel" || family === "lead";
}

export function comparableMetaIntentKey(row: CampaignFamilyInput) {
  const accountId = normalizeGoal(row.accountId) || `missing:${row.id}`;
  const currency = normalizeGoal(row.currency) || "unknown";
  const scope = `account:${accountId}|currency:${currency}`;
  const customEventType = normalizeGoal(row.customEventType);
  if (customEventType) {
    return `${scope}|custom_event:${customEventType}`;
  }

  const optimization = normalizeGoal(row.optimizationGoal);
  if (optimization) {
    return `${scope}|optimization:${optimization}`;
  }

  const objective = normalizeGoal(row.objective);
  if (objective) {
    return `${scope}|objective:${objective}`;
  }

  return `${scope}|family:${resolveMetaCampaignFamily(row)}`;
}

export function metaCampaignLaneGroupKey(row: CampaignFamilyInput) {
  return comparableMetaIntentKey(row);
}

export function comparableMetaIntentLabel(row: CampaignFamilyInput) {
  if (row.customEventType) return row.customEventType;
  if (row.optimizationGoal) return row.optimizationGoal;
  if (row.objective) return row.objective;
  return metaCampaignFamilyLabel(resolveMetaCampaignFamily(row));
}

function averagePositive(values: number[]) {
  const filtered = values.filter((value) => Number.isFinite(value) && value > 0);
  if (filtered.length === 0) return 0;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function quantile(values: number[], q: number) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function buildFamilyLaneAnalysis(family: MetaCampaignFamily, familyRows: MetaCampaignRow[]) {
  const totalSpend = familyRows.reduce((sum, row) => sum + Math.max(0, row.spend), 0);
  const totalRevenue = familyRows.reduce((sum, row) => sum + Math.max(0, row.revenue), 0);
  const avgRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;
  const avgSpend = averagePositive(familyRows.map((row) => row.spend));
  const upperRoasQuartile = quantile(familyRows.map((row) => row.roas), 0.75);
  const roasSpread =
    familyRows.length > 1
      ? Math.max(...familyRows.map((row) => row.roas)) - Math.min(...familyRows.map((row) => row.roas))
      : 0;

  const peerRoas = (row: MetaCampaignRow) => {
    const peers = familyRows.filter((candidate) => candidate.id !== row.id);
    const spend = peers.reduce((sum, peer) => sum + Math.max(0, peer.spend), 0);
    const revenue = peers.reduce(
      (sum, peer) => sum + Math.max(0, peer.revenue),
      0,
    );
    return spend > 0 ? revenue / spend : null;
  };
  const strongRows = familyRows.filter((row) => {
    const benchmark = peerRoas(row);
    return (
      benchmark != null &&
      benchmark > 0 &&
      upperRoasQuartile != null &&
      row.purchases >= 10 &&
      row.roas >= benchmark * 1.1 &&
      row.roas >= upperRoasQuartile
    );
  });
  const lowSignalRows = familyRows.filter(
    (row) => row.purchases < 8 || row.spend <= Math.max(avgSpend * 0.75, 0)
  );
  const hardTestRows = familyRows.filter((row) => {
    const benchmark = peerRoas(row);
    return (
      benchmark != null &&
      benchmark > 0 &&
      row.purchases < 5 &&
      row.roas <= benchmark * 0.7
    );
  });
  const validationRows = familyRows.filter((row) => {
    const hasMeaningfulSignal = row.purchases >= 8 || row.spend > Math.max(avgSpend * 0.75, 0);
    return hasMeaningfulSignal;
  });

  return {
    family,
    familyLabel: metaCampaignFamilyLabel(family),
    avgRoas,
    avgSpend,
    roasSpread,
    strongRows,
    lowSignalRows,
    hardTestRows,
    validationRows,
  };
}

export function buildMetaCampaignLaneSignals(rows: MetaCampaignRow[]) {
  const grouped = new Map<
    string,
    { family: MetaCampaignFamily; rows: MetaCampaignRow[] }
  >();
  for (const row of rows) {
    const family = resolveMetaCampaignFamily(row);
    if (!isScalingCampaignFamily(family) || row.status !== "ACTIVE") continue;
    const key = metaCampaignLaneGroupKey(row);
    const group = grouped.get(key) ?? { family, rows: [] };
    group.rows.push(row);
    grouped.set(key, group);
  }

  const laneMap = new Map<string, MetaCampaignLaneSignal>();

  for (const { family, rows: familyRows } of grouped.values()) {
    if (familyRows.length < 2) continue;

    const { avgRoas, roasSpread, strongRows, lowSignalRows, hardTestRows, validationRows } =
      buildFamilyLaneAnalysis(family, familyRows);

    if (strongRows.length === 0) continue;
    const homogeneousMatureFamily =
      strongRows.length === familyRows.length && roasSpread < 0.35;
    const lowDifferentiationFamily =
      roasSpread < 0.35 && hardTestRows.length === 0 && lowSignalRows.length < 2;
    const noRealOperatingSplit =
      strongRows.length === 1 && validationRows.length === 0 && lowSignalRows.length === 0;

    if (homogeneousMatureFamily || lowDifferentiationFamily || noRealOperatingSplit) continue;

    for (const row of strongRows) {
      laneMap.set(row.id, {
        lane: "Scaling",
        family,
        reason: "strong_efficiency",
        confidence: row.purchases >= 15 || row.roas >= Math.max(avgRoas * 1.25, 2.5) ? "high" : "medium",
      });
    }

    for (const row of hardTestRows) {
      if (!laneMap.has(row.id)) {
        laneMap.set(row.id, {
          lane: "Test",
          family,
          reason: "hard_test",
          confidence: "high",
        });
      }
    }

    for (const row of validationRows) {
      if (laneMap.has(row.id)) continue;
      laneMap.set(row.id, {
        lane: "Validation",
        family,
        reason: "balanced_validation",
        confidence: row.purchases >= 12 ? "high" : "medium",
      });
    }

    if (lowSignalRows.length >= 2) {
      for (const row of lowSignalRows) {
        if (!laneMap.has(row.id)) {
          laneMap.set(row.id, {
            lane: "Test",
            family,
            reason: "exploratory_test",
            confidence: "medium",
          });
        }
      }
    }
  }

  return laneMap;
}

export function buildMetaCampaignLaneSummary(rows: MetaCampaignRow[]) {
  const signals = buildMetaCampaignLaneSignals(rows);
  const grouped = new Map<
    string,
    { family: MetaCampaignFamily; rows: MetaCampaignRow[] }
  >();
  for (const row of rows) {
    const family = resolveMetaCampaignFamily(row);
    if (!isScalingCampaignFamily(family) || row.status !== "ACTIVE") continue;
    const key = metaCampaignLaneGroupKey(row);
    const group = grouped.get(key) ?? { family, rows: [] };
    group.rows.push(row);
    grouped.set(key, group);
  }

  const summaries = new Map<string, MetaCampaignLaneFamilySummary>();
  for (const [key, { family, rows: familyRows }] of grouped) {
    const familySignals = familyRows
      .map((row) => signals.get(row.id))
      .filter((signal): signal is MetaCampaignLaneSignal => Boolean(signal));

    const scalingCount = familySignals.filter((signal) => signal.lane === "Scaling").length;
    const validationCount = familySignals.filter((signal) => signal.lane === "Validation").length;
    const testCount = familySignals.filter((signal) => signal.lane === "Test").length;
    const unclassifiedCount = Math.max(familyRows.length - familySignals.length, 0);

    const first = familyRows[0]!;
    summaries.set(key, {
      accountId: first.accountId,
      currency: first.currency ?? "unknown",
      family,
      familyLabel: metaCampaignFamilyLabel(family),
      scalingCount,
      validationCount,
      testCount,
      unclassifiedCount,
      eligibleForBudgetShift: scalingCount >= 1 && validationCount >= 1,
    });
  }

  return summaries;
}

export function buildMetaCampaignLaneMap(rows: MetaCampaignRow[]) {
  const signals = buildMetaCampaignLaneSignals(rows);
  return new Map([...signals.entries()].map(([id, signal]) => [id, signal.lane]));
}
