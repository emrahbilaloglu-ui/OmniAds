import type { ConfidenceTier } from "@/components/common/briefing/types";

export interface ConfidenceClassResult {
  tier: ConfidenceTier;
  thumb: "lg" | "md" | "sm";
  border: string;
  primaryStyle: "filled" | "outline";
  textWeight: string;
}

export function confidenceClass(confidence: number): ConfidenceClassResult {
  if (confidence >= 70) {
    return {
      tier: "high",
      thumb: "lg",
      border: "border-2 border-slate-300",
      primaryStyle: "filled",
      textWeight: "font-semibold",
    };
  }
  if (confidence >= 50) {
    return {
      tier: "mid",
      thumb: "md",
      border: "border border-slate-200",
      primaryStyle: "filled",
      textWeight: "font-medium",
    };
  }
  return {
    tier: "low",
    thumb: "sm",
    border: "border border-slate-200 opacity-90",
    primaryStyle: "outline",
    textWeight: "font-normal",
  };
}

interface ConfidencePillProps {
  confidence: number;
  size?: "sm" | "md";
  className?: string;
}

export function ConfidencePill({
  confidence,
  size = "md",
  className,
}: ConfidencePillProps) {
  const sizeClassName =
    size === "sm"
      ? "font-mono tabular-nums text-[10px] text-slate-500 px-1 py-0.5 rounded border border-slate-200"
      : "font-mono tabular-nums text-[10.5px] text-slate-500 px-1.5 py-0.5 rounded-md border border-slate-200";

  return (
    <span className={[sizeClassName, className].filter(Boolean).join(" ")}>
      {Math.round(confidence)}%
    </span>
  );
}
