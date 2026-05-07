import type { DecisionLabel } from "@/components/common/briefing/types";

export type BriefingLabelTone = "success" | "warning" | "danger" | "info" | "muted";

export const DECISION_LABELS = [
  "scale",
  "cut",
  "refresh",
  "keep",
  "test_more",
  "diagnose",
  "below_breakeven",
  "fatigue",
  "rebuild",
  "switch",
  "tune",
  "swap",
  "review_placements",
  "review_adsets",
  "out_of_scope",
] as const satisfies readonly DecisionLabel[];

export const CREATIVE_ENGINE_DECISION_LABELS = [
  "scale",
  "keep",
  "refresh",
  "cut",
  "test_more",
  "diagnose",
  "out_of_scope",
] as const;

export const TONE_CLASS: Record<BriefingLabelTone, string> = {
  success:
    "border-emerald-200 bg-emerald-500/15 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-300",
  warning:
    "border-amber-200 bg-amber-500/15 text-amber-800 dark:border-amber-500/30 dark:text-amber-300",
  danger:
    "border-rose-200 bg-rose-500/15 text-rose-700 dark:border-rose-500/30 dark:text-rose-300",
  info: "border-sky-200 bg-sky-500/15 text-sky-700 dark:border-sky-500/30 dark:text-sky-300",
  muted: "border-border bg-muted text-muted-foreground",
};

export const DECISION_LABEL_PALETTE: Record<
  DecisionLabel,
  {
    label: string;
    tone: BriefingLabelTone;
    creativeClassName: string;
    metaClassName: string;
    legacyClassName: string;
  }
> = {
  scale: {
    label: "Scale",
    tone: "success",
    creativeClassName: "text-emerald-700 bg-emerald-500/15 border-emerald-200",
    metaClassName: "bg-emerald-50 text-emerald-700 border-emerald-200",
    legacyClassName: TONE_CLASS.success,
  },
  cut: {
    label: "Cut",
    tone: "danger",
    creativeClassName: "text-rose-700 bg-rose-500/15 border-rose-200",
    metaClassName: "bg-rose-50 text-rose-700 border-rose-200",
    legacyClassName: TONE_CLASS.danger,
  },
  refresh: {
    label: "Refresh",
    tone: "warning",
    creativeClassName: "text-amber-800 bg-amber-500/15 border-amber-200",
    metaClassName: "bg-amber-50 text-amber-800 border-amber-200",
    legacyClassName: TONE_CLASS.warning,
  },
  keep: {
    label: "Keep",
    tone: "info",
    creativeClassName: "text-sky-700 bg-sky-500/15 border-sky-200",
    metaClassName: "bg-slate-50 text-slate-700 border-slate-200",
    legacyClassName: TONE_CLASS.info,
  },
  test_more: {
    label: "Test more",
    tone: "muted",
    creativeClassName: "text-slate-700 bg-slate-100 border-slate-200",
    metaClassName: "bg-slate-50 text-slate-700 border-slate-200",
    legacyClassName: TONE_CLASS.muted,
  },
  diagnose: {
    label: "Diagnose",
    tone: "warning",
    creativeClassName: "text-rose-700 bg-rose-500/15 border-rose-200",
    metaClassName: "bg-rose-50 text-rose-700 border-rose-200",
    legacyClassName: TONE_CLASS.warning,
  },
  below_breakeven: {
    label: "Below breakeven",
    tone: "warning",
    creativeClassName: "text-amber-800 bg-amber-500/15 border-amber-200",
    metaClassName: "bg-amber-50 text-amber-800 border-amber-200",
    legacyClassName: TONE_CLASS.warning,
  },
  fatigue: {
    label: "Fatigue",
    tone: "warning",
    creativeClassName: "text-amber-800 bg-amber-500/15 border-amber-200",
    metaClassName: "bg-amber-50 text-amber-800 border-amber-200",
    legacyClassName: TONE_CLASS.warning,
  },
  rebuild: {
    label: "Rebuild",
    tone: "danger",
    creativeClassName: "text-rose-700 bg-rose-500/15 border-rose-200",
    metaClassName: "bg-rose-50 text-rose-700 border-rose-200",
    legacyClassName: TONE_CLASS.danger,
  },
  switch: {
    label: "Switch",
    tone: "info",
    creativeClassName: "text-blue-700 bg-blue-50 border-blue-200",
    metaClassName: "bg-blue-50 text-blue-700 border-blue-200",
    legacyClassName: TONE_CLASS.info,
  },
  tune: {
    label: "Tune",
    tone: "info",
    creativeClassName: "text-blue-700 bg-blue-50 border-blue-200",
    metaClassName: "bg-blue-50 text-blue-700 border-blue-200",
    legacyClassName: TONE_CLASS.info,
  },
  swap: {
    label: "Swap",
    tone: "warning",
    creativeClassName: "text-amber-800 bg-amber-500/15 border-amber-200",
    metaClassName: "bg-amber-50 text-amber-800 border-amber-200",
    legacyClassName: TONE_CLASS.warning,
  },
  review_placements: {
    label: "Review placements",
    tone: "muted",
    creativeClassName: "text-slate-700 bg-slate-100 border-slate-200",
    metaClassName: "bg-slate-50 text-slate-700 border-slate-200",
    legacyClassName: TONE_CLASS.muted,
  },
  review_adsets: {
    label: "Review adsets",
    tone: "muted",
    creativeClassName: "text-slate-700 bg-slate-100 border-slate-200",
    metaClassName: "bg-slate-50 text-slate-700 border-slate-200",
    legacyClassName: TONE_CLASS.muted,
  },
  out_of_scope: {
    label: "Out of scope",
    tone: "muted",
    creativeClassName: "text-slate-500 bg-transparent border-slate-200",
    metaClassName: "bg-slate-50 text-slate-700 border-slate-200",
    legacyClassName: TONE_CLASS.muted,
  },
};

export function displayDecisionLabel(label: DecisionLabel): string {
  return DECISION_LABEL_PALETTE[label].label;
}
