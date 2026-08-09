import type { ConfidenceTier } from "@/components/common/briefing/types";

export interface ConfidenceClassResult {
  tier: ConfidenceTier;
  thumb: "lg" | "md" | "sm";
  border: string;
  primaryStyle: "filled" | "outline";
  textWeight: string;
}

export function confidenceClass(confidence: number | null | undefined): ConfidenceClassResult {
  const numeric = typeof confidence === "number" && Number.isFinite(confidence) ? confidence : null;
  if (numeric !== null && numeric >= 70) {
    return {
      tier: "high",
      thumb: "lg",
      border: "border-2 border-neutral-300",
      primaryStyle: "filled",
      textWeight: "font-semibold",
    };
  }
  if (numeric !== null && numeric >= 50) {
    return {
      tier: "mid",
      thumb: "md",
      border: "border border-neutral-200",
      primaryStyle: "filled",
      textWeight: "font-medium",
    };
  }
  return {
    tier: "low",
    thumb: "sm",
    border: "border border-neutral-200 opacity-90",
    primaryStyle: "outline",
    textWeight: "font-normal",
  };
}

interface ConfidencePillProps {
  confidence: number | null | undefined;
  size?: "sm" | "md";
  className?: string;
}

export function ConfidencePill({
  confidence,
  size = "md",
  className,
}: ConfidencePillProps) {
  const numeric = typeof confidence === "number" && Number.isFinite(confidence) ? Math.round(confidence) : null;
  const sizeClassName =
    size === "sm"
      ? "font-mono tabular-nums text-[12px] text-neutral-500 px-1 py-0.5 rounded border border-neutral-200"
      : "font-mono tabular-nums text-[12px] text-neutral-500 px-1.5 py-0.5 rounded-md border border-neutral-200";

  return (
    <span className={[sizeClassName, className].filter(Boolean).join(" ")}>
      {numeric === null ? "—" : `${numeric}%`}
    </span>
  );
}
