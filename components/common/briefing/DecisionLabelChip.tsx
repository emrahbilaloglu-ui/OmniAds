import type { ReactNode } from "react";
import type { DecisionLabel } from "@/components/common/briefing/types";
import { DECISION_LABEL_PALETTE } from "@/components/common/briefing/decision-label-palette";

type DecisionLabelChipSurface = "creative" | "meta";
type DecisionLabelChipSize = "sm" | "md";

interface DecisionLabelChipProps {
  label: DecisionLabel;
  surface?: DecisionLabelChipSurface;
  size?: DecisionLabelChipSize;
  children?: ReactNode;
  className?: string;
  appearance?: "default" | "unstyled";
  "data-testid"?: string;
}

export function DecisionLabelChip({
  label,
  surface = "creative",
  size = "md",
  children,
  className,
  appearance = "default",
  "data-testid": testId,
}: DecisionLabelChipProps) {
  const palette = DECISION_LABEL_PALETTE[label];
  const text = children ?? label.replace(/_/g, " ");

  if (appearance === "unstyled") {
    return (
      <span className={className} data-testid={testId}>
        {text}
      </span>
    );
  }

  const sourceClassName =
    surface === "meta"
      ? [
          "inline-flex items-center px-1.5",
          size === "sm" ? "py-0" : "py-0.5",
          "rounded-md border font-semibold uppercase tracking-wider",
          size === "sm" ? "text-[12px]" : "text-[12px]",
          palette.metaClassName,
          className,
        ]
          .filter(Boolean)
          .join(" ")
      : [
          "inline-flex items-center gap-1 rounded-md border",
          palette.creativeClassName,
          size === "sm" ? "px-1.5 py-0.5 text-[12px]" : "px-2 py-0.5 text-[12px]",
          "font-semibold uppercase tracking-wider",
          className,
        ]
          .filter(Boolean)
          .join(" ");

  return (
    <span className={sourceClassName} data-testid={testId}>
      {text}
    </span>
  );
}
