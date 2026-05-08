export type MetaOperatingModeV1 = "aggressive_volume" | "profit_first";
export type MetaSeasonalRegimeV1 = "peak" | "post_peak" | "normalized" | "unstable";

export interface MetaModeMetrics {
  spend: number;
  revenue: number;
  purchases: number;
  roas: number;
}

function ratio(current: number, previous: number) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return 1;
  return current / previous;
}

export function classifyMetaOperatingMode(input: {
  current: MetaModeMetrics;
  previous: MetaModeMetrics;
  targetRoas: number;
  constrainedBidShare?: number;
}): MetaOperatingModeV1 {
  const spendGrowth = ratio(input.current.spend, input.previous.spend);
  const roasToTarget = input.targetRoas > 0 ? input.current.roas / input.targetRoas : 1;
  const constrainedBidShare = input.constrainedBidShare ?? 0;

  if (constrainedBidShare >= 0.5) return "profit_first";
  if (roasToTarget < 0.95 && spendGrowth >= 1.1) return "profit_first";
  if (spendGrowth >= 1.15 && roasToTarget >= 0.9) return "aggressive_volume";
  if (input.current.purchases >= input.previous.purchases * 1.2 && roasToTarget >= 0.9) return "aggressive_volume";
  return "profit_first";
}

export function classifyMetaSeasonalRegime(input: {
  d7Roas: number;
  d14Roas: number;
  d28Roas: number;
  currentSpend: number;
  previousSpend: number;
}): MetaSeasonalRegimeV1 {
  const shortVsBase = ratio(input.d7Roas, input.d28Roas);
  const midVsBase = ratio(input.d14Roas, input.d28Roas);
  const spendGrowth = ratio(input.currentSpend, input.previousSpend);

  if (shortVsBase >= 1.25 && spendGrowth >= 1.15) return "peak";
  if (shortVsBase <= 0.75 && midVsBase <= 0.9 && spendGrowth <= 1.05) return "post_peak";
  if (Math.abs(shortVsBase - 1) >= 0.35 || Math.abs(midVsBase - 1) >= 0.3) return "unstable";
  return "normalized";
}

export function modeAwareScaleCeiling(input: {
  mode: MetaOperatingModeV1;
  regime: MetaSeasonalRegimeV1;
}) {
  if (input.mode === "aggressive_volume" && input.regime === "peak") return 0.3;
  if (input.mode === "aggressive_volume") return 0.25;
  if (input.regime === "post_peak" || input.regime === "unstable") return 0.1;
  return 0.15;
}
