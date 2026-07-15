import type { TruthSource } from "../types";

export function formatReasonNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function comparisonLabel(truthSource: TruthSource): string {
  switch (truthSource) {
    case "commercial_truth":
      return "commercial target";
    case "commercial_truth_stale":
      return "commercial target with unavailable timestamp";
    case "account_baseline":
      return "account P75 baseline";
    case "account_baseline_thin":
      return "account P60 baseline";
    case "global_default":
      return "fallback benchmark";
  }
}
