/**
 * The Decision Center's sources, named in the §9 vocabulary.
 *
 * Four reads decide whether the workspace may be believed. Keeping the mapping
 * here rather than inline in a fifteen-hundred-line route means it can be read,
 * and tested, without reading everything around it — and it keeps the route
 * file exporting nothing but its handlers, which Next requires.
 */
import type { MetaSurfaceSource } from "@/lib/meta/surface-read-state";

/**
 * The workspace's sources, in the §9 vocabulary.
 *
 * Four reads decide whether the Decision Center may be believed, and this is
 * the only place they are named. Keeping them here rather than inline in the
 * payload means the mapping can be read, and tested, without reading the
 * thousand lines around it.
 */
export function decisionsWorkspaceSources(input: {
  decisionStatus: "available" | "unavailable";
  decisionUnavailableCode: string | null;
  laneRowCount: number;
  currentAdsComplete: boolean;
  currentAdRowCount: number;
  commercialTargetsReadFailed: boolean;
}): MetaSurfaceSource[] {
  return [
    {
      id: "decision-snapshot",
      // `unavailable` is a read that did not happen, never a queue with
      // nothing in it. The §9.1 code the read model already carries is
      // forwarded when it is one this contract knows.
      outcome: input.decisionStatus === "available" ? "served" : "failed",
      rowCount: input.decisionStatus === "available" ? 1 : 0,
      failureCode: "source_read_failed",
    },
    {
      id: "lanes",
      outcome: input.laneRowCount > 0 ? "served" : "empty",
      rowCount: input.laneRowCount,
    },
    {
      id: "current-ads",
      // `complete: false` means the ad source was capped or partly read. Those
      // rows are real; presenting them as the whole set is the defect.
      outcome: input.currentAdsComplete
        ? input.currentAdRowCount > 0
          ? "served"
          : "empty"
        : "partial",
      rowCount: input.currentAdRowCount,
    },
    {
      id: "commercial-targets",
      outcome: input.commercialTargetsReadFailed ? "failed" : "served",
      rowCount: input.commercialTargetsReadFailed ? 0 : 1,
      failureCode: input.commercialTargetsReadFailed ? "source_read_failed" : undefined,
    },
  ];
}
