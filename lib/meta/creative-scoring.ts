import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

export interface AiCreativeHistoricalWindow {
  spend: number;
  purchaseValue: number;
  roas: number;
  cpa: number;
  ctr: number;
  purchases: number;
  impressions: number;
  linkClicks: number;
  hookRate: number;
  holdRate: number;
  video25Rate: number;
  watchRate: number;
  video75Rate: number;
  clickToPurchaseRate: number;
  atcToPurchaseRate: number;
}

export interface AiCreativeHistoricalWindows {
  last3?: AiCreativeHistoricalWindow;
  last7?: AiCreativeHistoricalWindow;
  last14?: AiCreativeHistoricalWindow;
  last30?: AiCreativeHistoricalWindow;
  last90?: AiCreativeHistoricalWindow;
  allHistory?: AiCreativeHistoricalWindow;
}

export type CreativeDecisionAction =
  | "scale"
  | "scale_hard"
  | "test_more"
  | "watch"
  | "pause"
  | "kill";

export type CreativeLifecycleState =
  | "stable_winner"
  | "emerging_winner"
  | "test_only"
  | "fatigued_winner"
  | "blocked"
  | "learning";

export interface CreativeDecisionResult {
  creativeId: string;
  action: CreativeDecisionAction;
  confidence: number;
  score: number;
  lifecycleState: CreativeLifecycleState;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function historicalStrengthCount(windows: AiCreativeHistoricalWindows | null | undefined) {
  const candidates = [
    windows?.last3,
    windows?.last7,
    windows?.last14,
    windows?.last30,
    windows?.last90,
    windows?.allHistory,
  ].filter((window): window is AiCreativeHistoricalWindow => Boolean(window));

  return candidates.filter((window) => window.roas >= 1.5 && window.purchases >= 1).length;
}

function scoreRow(row: MetaCreativeRow) {
  const roasScore = clamp(row.roas / 3, 0, 1) * 45;
  const purchaseScore = clamp(row.purchases / 5, 0, 1) * 25;
  const efficiencyScore = row.spend > 0 && row.cpa > 0 ? clamp(120 / row.cpa, 0, 1) * 15 : 0;
  const engagementScore = clamp((row.ctrAll ?? 0) / 2, 0, 1) * 15;
  return Math.round((roasScore + purchaseScore + efficiencyScore + engagementScore) * 10) / 10;
}

export function scoreMetaCreativeRows(
  rows: MetaCreativeRow[],
  historyById: Map<string, AiCreativeHistoricalWindows>,
): CreativeDecisionResult[] {
  return rows.map((row) => {
    const score = scoreRow(row);
    const historicalStrength = historicalStrengthCount(historyById.get(row.id));
    const hasMeaningfulSpend = row.spend >= 100;
    const hasPurchaseSignal = row.purchases >= 2;
    const strongWinner = hasMeaningfulSpend && hasPurchaseSignal && row.roas >= 2.2;
    const severeLoser = row.spend >= 150 && row.purchases === 0;
    const underperforming = row.spend >= 75 && row.roas < 0.8;
    const fatigueCandidate = historicalStrength >= 2 && row.roas < 1.2;

    if (severeLoser) {
      return {
        creativeId: row.id,
        action: "kill",
        confidence: 0.78,
        score,
        lifecycleState: "blocked",
      };
    }

    if (fatigueCandidate) {
      return {
        creativeId: row.id,
        action: "pause",
        confidence: 0.68,
        score,
        lifecycleState: "fatigued_winner",
      };
    }

    if (underperforming) {
      return {
        creativeId: row.id,
        action: "pause",
        confidence: 0.62,
        score,
        lifecycleState: "blocked",
      };
    }

    if (strongWinner) {
      return {
        creativeId: row.id,
        action: row.roas >= 3 && row.purchases >= 4 ? "scale_hard" : "scale",
        confidence: row.roas >= 3 ? 0.82 : 0.7,
        score,
        lifecycleState: historicalStrength >= 2 ? "stable_winner" : "emerging_winner",
      };
    }

    if (row.spend < 100 || row.purchases < 2) {
      return {
        creativeId: row.id,
        action: "test_more",
        confidence: 0.52,
        score,
        lifecycleState: "test_only",
      };
    }

    return {
      creativeId: row.id,
      action: "watch",
      confidence: 0.58,
      score,
      lifecycleState: "learning",
    };
  });
}
