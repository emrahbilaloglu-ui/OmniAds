"use client";

import type { DecisionLabel } from "@/lib/creative-decision-engine/types";
import { cn } from "@/lib/utils";
import {
  DECISION_LABELS,
  LABEL_DISPLAY,
  TONE_CLASS,
} from "@/components/creatives/decision-label-display";

interface CreativeV3LabelChipsProps {
  counts: Partial<Record<DecisionLabel, number>>;
  selected: Set<DecisionLabel>;
  onToggle: (label: DecisionLabel) => void;
  onClearAll: () => void;
  visible: boolean;
}

export function CreativeV3LabelChips({
  counts,
  selected,
  onToggle,
  onClearAll,
  visible,
}: CreativeV3LabelChipsProps) {
  if (!visible) return null;

  const labelsWithCounts = DECISION_LABELS.filter(
    (label) => (counts[label] ?? 0) > 0,
  );

  if (labelsWithCounts.length === 0 && selected.size === 0) return null;

  return (
    <div
      className="flex min-w-0 flex-1 basis-[18rem] flex-wrap items-center gap-1.5"
      aria-label="Engine v3 label filters"
    >
      {labelsWithCounts.map((label) => {
        const count = counts[label] ?? 0;
        const display = LABEL_DISPLAY[label];
        const active = selected.has(label);

        return (
          <button
            key={label}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(label)}
            className={cn(
              "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium leading-none transition-colors",
              TONE_CLASS[display.tone],
              active
                ? "shadow-sm"
                : "bg-background/70 hover:bg-muted/40 dark:bg-background/40",
            )}
          >
            {display.label} ({count})
          </button>
        );
      })}
      {selected.size > 0 ? (
        <button
          type="button"
          onClick={onClearAll}
          className="px-1.5 py-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
