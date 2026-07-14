import type {
  MetaWatchingSegment,
  MetaWatchingSegmentKey,
} from "@/components/meta/redesign/types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

const WATCH_SEGMENT_META: Record<
  MetaWatchingSegmentKey,
  Omit<MetaWatchingSegment, "key" | "count">
> = {
  unlabeled: {
    label: "Unlabeled",
    description: "Campaign label is missing, so hard actions stay soft-only.",
    ctaLabel: "Label campaigns",
    href: null,
  },
  missing_target: {
    label: "Missing target",
    description: "Commercial target or break-even anchor is missing.",
    ctaLabel: "Set targets",
    href: "/commercial-truth",
  },
  learning: {
    label: "Learning",
    description: "Meta learning, thin data, or cook-time gate is active.",
    ctaLabel: null,
    href: null,
  },
  recently_changed: {
    label: "Recent change",
    description: "Recent edits make the current readout cooldown-bound.",
    ctaLabel: null,
    href: null,
  },
  deferred: {
    label: "Deferred",
    description: "Operator deferred this recommendation.",
    ctaLabel: null,
    href: null,
  },
  issues: {
    label: "Delivery issues",
    description:
      "Entity has status or delivery issues; action confidence is capped.",
    ctaLabel: null,
    href: null,
  },
  mid_confidence: {
    label: "Mid confidence",
    description: "Signal forming - below the Action Now bar.",
    ctaLabel: null,
    href: null,
  },
  insufficient_signal: {
    label: "Insufficient signal",
    description:
      "Spend, purchase, or confidence evidence is not strong enough yet.",
    ctaLabel: null,
    href: null,
  },
  other: {
    label: "Other watch",
    description: "Watch-only recommendation not mapped to a narrower fix path.",
    ctaLabel: null,
    href: null,
  },
};

const WATCH_SEGMENT_ORDER: readonly MetaWatchingSegmentKey[] = [
  "unlabeled",
  "missing_target",
  "learning",
  "recently_changed",
  "deferred",
  "issues",
  "mid_confidence",
  "insufficient_signal",
  "other",
];

export function buildMetaWatchingSegments(
  watching: readonly MetaRecommendation[],
): MetaWatchingSegment[] {
  const counts = new Map<MetaWatchingSegmentKey, number>();
  for (const rec of watching) {
    const key = rec.watchSegment ?? "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return WATCH_SEGMENT_ORDER.map((key) => ({
    key,
    count: counts.get(key) ?? 0,
    ...WATCH_SEGMENT_META[key],
  })).filter((segment) => segment.count > 0);
}
