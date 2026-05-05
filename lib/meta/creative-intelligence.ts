import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import {
  scoreMetaCreativeRows,
  type AiCreativeHistoricalWindows,
  type CreativeDecisionResult,
} from "@/lib/meta/creative-scoring";

export interface MetaCreativeCampaignSignalSummary {
  campaignId: string;
  campaignName: string | null;
  creativeCount: number;
  winnerCount: number;
  provenWinnerCount: number;
  stableScalingCount: number;
  emergingScalingCount: number;
  testOnlyCount: number;
  fatiguedCount: number;
  blockedCount: number;
  lowConfidenceCount: number;
  weakCount: number;
  topWinnerNames: string[];
  topStableWinnerNames: string[];
  topEmergingScalingNames: string[];
  topTestOnlyNames: string[];
  topFatiguedNames: string[];
  topBlockedNames: string[];
  scalingReadyNames: string[];
  keepTestingNames: string[];
  doNotDeployNames: string[];
}

export interface MetaCreativeIntelligenceSummary {
  totalCreatives: number;
  winnerCount: number;
  provenWinnerCount: number;
  stableScalingCount: number;
  emergingScalingCount: number;
  testOnlyCount: number;
  fatiguedCount: number;
  blockedCount: number;
  lowConfidenceCount: number;
  weakCount: number;
  topWinnerNames: string[];
  topStableWinnerNames: string[];
  topEmergingScalingNames: string[];
  topTestOnlyNames: string[];
  topFatiguedNames: string[];
  topBlockedNames: string[];
  scalingReadyNames: string[];
  keepTestingNames: string[];
  doNotDeployNames: string[];
  byCampaignId: Record<string, MetaCreativeCampaignSignalSummary>;
  byFamily: Record<string, Omit<MetaCreativeCampaignSignalSummary, "campaignId" | "campaignName"> & { familyKey: string; familyLabel: string }>;
}

function normalizeGoal(value: string | null | undefined) {
  return (value ?? "").toLowerCase().trim();
}

function familyFromCampaign(row: MetaCampaignRow | null | undefined) {
  const goal = normalizeGoal(row?.optimizationGoal);
  const objective = normalizeGoal(row?.objective);

  if (
    goal.includes("purchase") ||
    goal.includes("value") ||
    goal.includes("offsite conversions") ||
    goal.includes("offsite_conversion") ||
    objective.includes("outcome_sales") ||
    objective.includes("sales")
  ) {
    return { key: "purchase_value", label: "purchase/value" };
  }
  if (
    goal.includes("add to cart") ||
    goal.includes("initiate checkout") ||
    goal.includes("checkout") ||
    goal.includes("landing page") ||
    goal.includes("conversion")
  ) {
    return { key: "mid_funnel", label: "mid-funnel conversion" };
  }
  if (goal.includes("lead") || goal.includes("registration")) {
    return { key: "lead", label: "lead generation" };
  }
  if (
    goal.includes("thruplay") ||
    goal.includes("reach") ||
    goal.includes("video") ||
    goal.includes("awareness") ||
    goal.includes("traffic")
  ) {
    return { key: "awareness", label: "awareness/video" };
  }
  if (
    goal.includes("engagement") ||
    goal.includes("message") ||
    goal.includes("messaging") ||
    goal.includes("post")
  ) {
    return { key: "engagement", label: "engagement/messaging" };
  }
  return { key: "other", label: "other" };
}

function isWinner(decision: CreativeDecisionResult) {
  return decision.action === "scale" || decision.action === "scale_hard";
}

function isProvenWinner(decision: CreativeDecisionResult) {
  return isWinner(decision) && decision.confidence >= 0.65;
}

function isLowConfidence(row: MetaCreativeRow, decision: CreativeDecisionResult) {
  return (
    decision.lifecycleState === "test_only" ||
    decision.action === "test_more" ||
    (decision.action === "watch" && row.spend < 100)
  );
}

function isWeak(decision: CreativeDecisionResult) {
  return decision.action === "pause" || decision.action === "kill";
}

function historicalStrengthCount(windows: AiCreativeHistoricalWindows | undefined) {
  const candidates = [
    windows?.last3,
    windows?.last7,
    windows?.last14,
    windows?.last30,
    windows?.last90,
    windows?.allHistory,
  ].filter((window): window is NonNullable<typeof window> => Boolean(window));

  return candidates.filter((window) => window.roas >= 1.5 && window.purchases >= 1).length;
}

function isStableScaling(decision: CreativeDecisionResult) {
  return decision.lifecycleState === "stable_winner";
}

function isEmergingScaling(decision: CreativeDecisionResult) {
  return decision.lifecycleState === "emerging_winner";
}

function isFatiguedCreative(decision: CreativeDecisionResult, historyById: Map<string, AiCreativeHistoricalWindows>, creativeId: string) {
  return decision.lifecycleState === "fatigued_winner" || (decision.action === "pause" && historicalStrengthCount(historyById.get(creativeId)) >= 2);
}

function isBlockedCreative(
  row: MetaCreativeRow,
  decision: CreativeDecisionResult,
  historyById: Map<string, AiCreativeHistoricalWindows>
) {
  if (decision.lifecycleState === "blocked") return true;
  if (decision.action === "kill") return true;
  if (decision.action !== "pause") return false;
  return !isFatiguedCreative(decision, historyById, row.id);
}

export function buildMetaCreativeIntelligence(input: {
  rows: MetaCreativeRow[];
  historyById: Map<string, AiCreativeHistoricalWindows>;
  campaigns?: MetaCampaignRow[];
}): MetaCreativeIntelligenceSummary {
  const rows = input.rows;
  if (rows.length === 0) {
    return {
      totalCreatives: 0,
      winnerCount: 0,
      provenWinnerCount: 0,
      stableScalingCount: 0,
      emergingScalingCount: 0,
      testOnlyCount: 0,
      fatiguedCount: 0,
      blockedCount: 0,
      lowConfidenceCount: 0,
      weakCount: 0,
      topWinnerNames: [],
      topStableWinnerNames: [],
      topTestOnlyNames: [],
      topEmergingScalingNames: [],
      topFatiguedNames: [],
      topBlockedNames: [],
      scalingReadyNames: [],
      keepTestingNames: [],
      doNotDeployNames: [],
      byCampaignId: {},
      byFamily: {},
    };
  }

  const campaignById = new Map((input.campaigns ?? []).map((campaign) => [campaign.id, campaign]));

  const decisions = scoreMetaCreativeRows(rows, input.historyById);

  const decisionById = new Map(decisions.map((decision) => [decision.creativeId, decision]));
  const campaignMap = new Map<string, MetaCreativeCampaignSignalSummary>();
  const familyMap = new Map<string, Omit<MetaCreativeCampaignSignalSummary, "campaignId" | "campaignName"> & { familyKey: string; familyLabel: string }>();

  let winnerCount = 0;
  let provenWinnerCount = 0;
  let stableScalingCount = 0;
  let emergingScalingCount = 0;
  let testOnlyCount = 0;
  let fatiguedCount = 0;
  let blockedCount = 0;
  let lowConfidenceCount = 0;
  let weakCount = 0;

  for (const row of rows) {
    const decision = decisionById.get(row.id);
    if (!decision) continue;
    const stableScaling = isStableScaling(decision);
    const emergingScaling = isEmergingScaling(decision);
    const testOnly = isLowConfidence(row, decision);
    const fatigued = isFatiguedCreative(decision, input.historyById, row.id);
    const blocked = isBlockedCreative(row, decision, input.historyById);

    if (isWinner(decision)) winnerCount += 1;
    if (isProvenWinner(decision)) provenWinnerCount += 1;
    if (stableScaling) stableScalingCount += 1;
    if (emergingScaling) emergingScalingCount += 1;
    if (testOnly) testOnlyCount += 1;
    if (fatigued) fatiguedCount += 1;
    if (blocked) blockedCount += 1;
    if (isLowConfidence(row, decision)) lowConfidenceCount += 1;
    if (isWeak(decision)) weakCount += 1;

    const campaignId = row.campaignId ?? `unknown:${row.accountId ?? "account"}`;
    const family = familyFromCampaign(campaignById.get(campaignId));
    const existing = campaignMap.get(campaignId) ?? {
      campaignId,
      campaignName: row.campaignName ?? null,
      creativeCount: 0,
      winnerCount: 0,
      provenWinnerCount: 0,
      stableScalingCount: 0,
      emergingScalingCount: 0,
      testOnlyCount: 0,
      fatiguedCount: 0,
      blockedCount: 0,
      lowConfidenceCount: 0,
      weakCount: 0,
      topWinnerNames: [],
      topStableWinnerNames: [],
      topTestOnlyNames: [],
      topEmergingScalingNames: [],
      topFatiguedNames: [],
      topBlockedNames: [],
      scalingReadyNames: [],
      keepTestingNames: [],
      doNotDeployNames: [],
    };
    existing.creativeCount += 1;
    if (isWinner(decision)) existing.winnerCount += 1;
    if (isProvenWinner(decision)) existing.provenWinnerCount += 1;
    if (stableScaling) existing.stableScalingCount += 1;
    if (emergingScaling) existing.emergingScalingCount += 1;
    if (testOnly) existing.testOnlyCount += 1;
    if (fatigued) existing.fatiguedCount += 1;
    if (blocked) existing.blockedCount += 1;
    if (isLowConfidence(row, decision)) existing.lowConfidenceCount += 1;
    if (isWeak(decision)) existing.weakCount += 1;
    if (isWinner(decision) && existing.topWinnerNames.length < 3) {
      existing.topWinnerNames.push(row.name);
    }
    if (stableScaling && existing.topStableWinnerNames.length < 3) {
      existing.topStableWinnerNames.push(row.name);
    }
    if (emergingScaling && existing.topEmergingScalingNames.length < 3) {
      existing.topEmergingScalingNames.push(row.name);
    }
    if (testOnly && existing.topTestOnlyNames.length < 3) {
      existing.topTestOnlyNames.push(row.name);
    }
    if (fatigued && existing.topFatiguedNames.length < 3) {
      existing.topFatiguedNames.push(row.name);
    }
    if (blocked && existing.topBlockedNames.length < 3) {
      existing.topBlockedNames.push(row.name);
    }
    if ((stableScaling || emergingScaling) && existing.scalingReadyNames.length < 4) {
      existing.scalingReadyNames.push(row.name);
    }
    if (testOnly && existing.keepTestingNames.length < 4) {
      existing.keepTestingNames.push(row.name);
    }
    if (blocked && existing.doNotDeployNames.length < 4) {
      existing.doNotDeployNames.push(row.name);
    }
    campaignMap.set(campaignId, existing);

    const familyExisting = familyMap.get(family.key) ?? {
      familyKey: family.key,
      familyLabel: family.label,
      creativeCount: 0,
      winnerCount: 0,
      provenWinnerCount: 0,
      stableScalingCount: 0,
      emergingScalingCount: 0,
      testOnlyCount: 0,
      fatiguedCount: 0,
      blockedCount: 0,
      lowConfidenceCount: 0,
      weakCount: 0,
      topWinnerNames: [],
      topStableWinnerNames: [],
      topTestOnlyNames: [],
      topEmergingScalingNames: [],
      topFatiguedNames: [],
      topBlockedNames: [],
      scalingReadyNames: [],
      keepTestingNames: [],
      doNotDeployNames: [],
    };
    familyExisting.creativeCount += 1;
    if (isWinner(decision)) familyExisting.winnerCount += 1;
    if (isProvenWinner(decision)) familyExisting.provenWinnerCount += 1;
    if (stableScaling) familyExisting.stableScalingCount += 1;
    if (emergingScaling) familyExisting.emergingScalingCount += 1;
    if (testOnly) familyExisting.testOnlyCount += 1;
    if (fatigued) familyExisting.fatiguedCount += 1;
    if (blocked) familyExisting.blockedCount += 1;
    if (isLowConfidence(row, decision)) familyExisting.lowConfidenceCount += 1;
    if (isWeak(decision)) familyExisting.weakCount += 1;
    if (isWinner(decision) && familyExisting.topWinnerNames.length < 5) {
      familyExisting.topWinnerNames.push(row.name);
    }
    if (stableScaling && familyExisting.topStableWinnerNames.length < 5) {
      familyExisting.topStableWinnerNames.push(row.name);
    }
    if (emergingScaling && familyExisting.topEmergingScalingNames.length < 5) {
      familyExisting.topEmergingScalingNames.push(row.name);
    }
    if (testOnly && familyExisting.topTestOnlyNames.length < 5) {
      familyExisting.topTestOnlyNames.push(row.name);
    }
    if (fatigued && familyExisting.topFatiguedNames.length < 5) {
      familyExisting.topFatiguedNames.push(row.name);
    }
    if (blocked && familyExisting.topBlockedNames.length < 5) {
      familyExisting.topBlockedNames.push(row.name);
    }
    if ((stableScaling || emergingScaling) && familyExisting.scalingReadyNames.length < 6) {
      familyExisting.scalingReadyNames.push(row.name);
    }
    if (testOnly && familyExisting.keepTestingNames.length < 6) {
      familyExisting.keepTestingNames.push(row.name);
    }
    if (blocked && familyExisting.doNotDeployNames.length < 6) {
      familyExisting.doNotDeployNames.push(row.name);
    }
    familyMap.set(family.key, familyExisting);
  }

  const topWinnerNames = rows
    .map((row) => ({ row, decision: decisionById.get(row.id) }))
    .filter((item): item is { row: MetaCreativeRow; decision: CreativeDecisionResult } => Boolean(item.decision))
    .filter((item) => isWinner(item.decision))
    .sort((a, b) => b.decision.score - a.decision.score)
    .slice(0, 5)
    .map((item) => item.row.name);

  return {
    totalCreatives: rows.length,
    winnerCount,
    provenWinnerCount,
    stableScalingCount,
    emergingScalingCount,
    testOnlyCount,
    fatiguedCount,
    blockedCount,
    lowConfidenceCount,
    weakCount,
    topWinnerNames,
    topStableWinnerNames: topWinnerNames.filter((name, index) => {
      const row = rows.find((candidate) => candidate.name === name);
      const decision = row ? decisionById.get(row.id) : null;
      return decision ? isStableScaling(decision) && index < 5 : false;
    }),
    topEmergingScalingNames: rows
      .filter((row) => {
        const decision = decisionById.get(row.id);
        return decision ? isEmergingScaling(decision) : false;
      })
      .slice(0, 5)
      .map((row) => row.name),
    topTestOnlyNames: rows
      .filter((row) => {
        const decision = decisionById.get(row.id);
        return decision ? isLowConfidence(row, decision) : false;
      })
      .slice(0, 5)
      .map((row) => row.name),
    topFatiguedNames: rows
      .filter((row) => {
        const decision = decisionById.get(row.id);
        return decision ? isFatiguedCreative(decision, input.historyById, row.id) : false;
      })
      .slice(0, 5)
      .map((row) => row.name),
    topBlockedNames: rows
      .filter((row) => {
        const decision = decisionById.get(row.id);
        return decision ? isBlockedCreative(row, decision, input.historyById) : false;
      })
      .slice(0, 5)
      .map((row) => row.name),
    scalingReadyNames: rows
      .filter((row) => {
        const decision = decisionById.get(row.id);
        return decision ? isStableScaling(decision) || isEmergingScaling(decision) : false;
      })
      .slice(0, 6)
      .map((row) => row.name),
    keepTestingNames: rows
      .filter((row) => {
        const decision = decisionById.get(row.id);
        return decision ? isLowConfidence(row, decision) : false;
      })
      .slice(0, 6)
      .map((row) => row.name),
    doNotDeployNames: rows
      .filter((row) => {
        const decision = decisionById.get(row.id);
        return decision ? isBlockedCreative(row, decision, input.historyById) : false;
      })
      .slice(0, 6)
      .map((row) => row.name),
    byCampaignId: Object.fromEntries(campaignMap.entries()),
    byFamily: Object.fromEntries(familyMap.entries()),
  };
}
