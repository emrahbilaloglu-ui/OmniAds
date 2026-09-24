import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { MetaOsAdDecision } from "@/lib/meta/decisions-os-contract";

export type MetaAdPerformanceAvailability = "observed" | "unavailable" | "unknown";

/** Read only source-owned observation state; a numeric zero is never proof. */
export function adPerformanceAvailability(
  decision: MetaOsAdDecision | null,
  canonical: MetaCanonicalDecision | null,
): MetaAdPerformanceAvailability {
  if (
    canonical?.sourceDecision?.badges?.includes("ad_metrics_unavailable") ||
    decision?.adPerformanceAvailability === "unavailable"
  ) {
    return "unavailable";
  }
  if (decision?.adPerformanceAvailability === "observed" || canonical) {
    return "observed";
  }
  // A legacy served-only payload can carry fail-closed zero sentinels. Its
  // observation state cannot be recovered from those values or its lane.
  return "unknown";
}
