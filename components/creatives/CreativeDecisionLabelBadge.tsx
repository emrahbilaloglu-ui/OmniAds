"use client";

import type { DecisionLabel } from "@/lib/creative-decision-engine";
import { cn } from "@/lib/utils";
import {
  LABEL_DISPLAY,
  TONE_CLASS,
} from "@/components/creatives/decision-label-display";

interface CreativeDecisionLabelBadgeProps {
  label: DecisionLabel;
  className?: string;
}

export function CreativeDecisionLabelBadge({
  label,
  className,
}: CreativeDecisionLabelBadgeProps) {
  const display = LABEL_DISPLAY[label];

  return (
    <span
      className={cn(
        "pointer-events-none inline-flex rounded-full bg-background/80 p-px shadow-md ring-1 ring-background/80 backdrop-blur-sm",
        className,
      )}
      data-testid="creative-decision-label-badge"
    >
      <span
        className={cn(
          "rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none",
          TONE_CLASS[display.tone],
        )}
      >
        {display.label}
      </span>
    </span>
  );
}
