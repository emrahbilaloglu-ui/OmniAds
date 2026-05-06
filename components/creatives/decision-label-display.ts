import type { DecisionLabel } from "@/lib/creative-decision-engine";

export type LabelTone = "success" | "warning" | "danger" | "info" | "muted";

export const DECISION_LABELS: DecisionLabel[] = [
  "scale",
  "keep",
  "refresh",
  "cut",
  "test_more",
  "diagnose",
  "out_of_scope",
];

export const LABEL_DISPLAY: Record<
  DecisionLabel,
  { label: string; tone: LabelTone }
> = {
  scale: { label: "Scale", tone: "success" },
  keep: { label: "Keep", tone: "info" },
  refresh: { label: "Refresh", tone: "warning" },
  cut: { label: "Cut", tone: "danger" },
  test_more: { label: "Test more", tone: "muted" },
  diagnose: { label: "Diagnose", tone: "warning" },
  out_of_scope: { label: "Out of scope", tone: "muted" },
};

export const TONE_CLASS: Record<LabelTone, string> = {
  success:
    "border-emerald-200 bg-emerald-500/15 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-300",
  warning:
    "border-amber-200 bg-amber-500/15 text-amber-800 dark:border-amber-500/30 dark:text-amber-300",
  danger:
    "border-rose-200 bg-rose-500/15 text-rose-700 dark:border-rose-500/30 dark:text-rose-300",
  info: "border-sky-200 bg-sky-500/15 text-sky-700 dark:border-sky-500/30 dark:text-sky-300",
  muted: "border-border bg-muted text-muted-foreground",
};
