import type { MetaMetricPercentiles } from "@/lib/meta/calibration";

function rank(value: number, thresholds: MetaMetricPercentiles) {
  if (!Number.isFinite(value)) return null;
  if (thresholds.p90 === thresholds.p10) return 0.5;
  if (value <= thresholds.p10) return 0;
  if (value >= thresholds.p90) return 1;
  return (value - thresholds.p10) / (thresholds.p90 - thresholds.p10);
}

export function percentileRank(value: number, thresholds: MetaMetricPercentiles) {
  return rank(value, thresholds);
}

export function percentileRankInverted(value: number, thresholds: MetaMetricPercentiles) {
  const percentile = rank(value, thresholds);
  return percentile == null ? null : 1 - percentile;
}
