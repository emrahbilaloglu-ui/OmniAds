export type CreativeShareFailure =
  "load" | "create" | "rotate" | "revoke" | "delete";

const CREATIVE_SHARE_FAILURE_COPY: Record<CreativeShareFailure, string> = {
  load: "Shared links could not be loaded. Try again.",
  create: "Share link could not be created. Try again.",
  rotate: "Share link could not be refreshed. Try again.",
  revoke: "Share link could not be revoked. Try again.",
  delete: "Share link could not be deleted. Try again.",
};

/**
 * Stable copy for Creative Studio share failures.
 *
 * Callers deliberately pass only the attempted operation. Provider messages,
 * route codes and transport details remain diagnostics and never enter UI.
 */
export function creativeShareFailureMessage(
  operation: CreativeShareFailure,
): string {
  return CREATIVE_SHARE_FAILURE_COPY[operation];
}
