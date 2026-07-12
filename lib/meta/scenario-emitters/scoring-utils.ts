import type { MetaMetricPercentiles } from "@/lib/meta/calibration";

function rank(value: number, thresholds: MetaMetricPercentiles) {
  if (!Number.isFinite(value)) return null;
  const rawAnchors = [
    [thresholds.p10, 0.1],
    [thresholds.p25, 0.25],
    [thresholds.p50, 0.5],
    [thresholds.p75, 0.75],
    [thresholds.p90, 0.9],
  ] as const;
  const grouped = new Map<number, number[]>();
  for (const [metric, percentile] of rawAnchors) {
    if (!Number.isFinite(metric)) return null;
    const values = grouped.get(metric) ?? [];
    values.push(percentile);
    grouped.set(metric, values);
  }
  const anchors = [...grouped.entries()]
    .map(([metric, percentiles]) => ({
      metric,
      percentile:
        percentiles.reduce((sum, percentile) => sum + percentile, 0) /
        percentiles.length,
    }))
    .sort((left, right) => left.metric - right.metric);
  if (anchors.length === 1) return 0.5;

  const interpolate = (
    left: (typeof anchors)[number],
    right: (typeof anchors)[number],
  ) =>
    left.percentile +
    ((value - left.metric) / (right.metric - left.metric)) *
      (right.percentile - left.percentile);

  if (value <= anchors[0].metric) {
    return Math.max(0, interpolate(anchors[0], anchors[1]));
  }
  const last = anchors.length - 1;
  if (value >= anchors[last].metric) {
    return Math.min(1, interpolate(anchors[last - 1], anchors[last]));
  }
  for (let index = 1; index < anchors.length; index += 1) {
    if (value <= anchors[index].metric) {
      return interpolate(anchors[index - 1], anchors[index]);
    }
  }
  return null;
}

export function percentileRank(value: number, thresholds: MetaMetricPercentiles) {
  return rank(value, thresholds);
}

export function percentileRankInverted(value: number, thresholds: MetaMetricPercentiles) {
  const percentile = rank(value, thresholds);
  return percentile == null ? null : 1 - percentile;
}
