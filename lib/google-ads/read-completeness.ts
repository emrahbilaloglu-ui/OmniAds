/**
 * Minimal wire contract required before an empty Google report may be treated
 * as a measured zero. Optional or absent provenance is deliberately incomplete.
 */
export interface GoogleAdsReadCompletenessMeta {
  dataState?: unknown;
  partial?: unknown;
  isPartial?: unknown;
  readSource?: unknown;
  failed_queries?: unknown;
  unavailable_metrics?: unknown;
  completion?:
    | {
        evidenceAvailable?: unknown;
        state?: unknown;
      }
    | null;
}

export function isGoogleAdsReadComplete(
  meta: GoogleAdsReadCompletenessMeta | null | undefined,
): boolean {
  if (
    !meta ||
    meta.dataState !== "ready" ||
    meta.partial !== false ||
    meta.isPartial !== false
  ) {
    return false;
  }
  if (Array.isArray(meta.failed_queries) && meta.failed_queries.length > 0) return false;
  if (Array.isArray(meta.unavailable_metrics) && meta.unavailable_metrics.length > 0) {
    return false;
  }

  // A successful same-day provider read is the one explicit exception to the
  // warehouse completion receipt: it is live evidence, not a warehouse range
  // whose post-close re-read must be proven.
  if (meta.readSource === "live_overlay_current_day") return true;

  const completion = meta.completion;
  if (!completion || completion.evidenceAvailable !== true) return false;
  if (
    completion.state !== "settled" &&
    completion.state !== "converging"
  ) {
    return false;
  }

  return true;
}
