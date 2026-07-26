import { describeGrowthFenceRefusal } from "@/lib/sync/db-growth-fence";
import { SyncLaneDisabledError } from "@/lib/sync/global-kill-switch";

/**
 * A refusal that must never be reported as success.
 *
 * Routes fan work out with `Promise.allSettled` and render each rejection as
 * `{ error: String(reason) }`. That is lossy in exactly the wrong direction: a
 * capacity refusal, a disabled lane and an unreadable authority all arrive as
 * a string, indistinguishable from an ordinary provider error, and the route
 * then answers HTTP 200. Detection has to happen where the rejection is still
 * an object, and the structure has to survive into the response.
 */

export type SyncSafetyRefusalKind =
  | "capacity_refused"
  | "lane_disabled"
  | "authority_unknown";

export interface SyncSafetyRefusal {
  kind: SyncSafetyRefusalKind;
  /** Which boundary or lane refused. */
  scope: string | null;
  message: string;
  detail: Record<string, unknown> | null;
}

/** Failure classes that mean "we could not establish authority", not "denied". */
const AUTHORITY_UNKNOWN_CLASSES = new Set([
  "meta_account_authority_unknown",
  "google_account_authority_unknown",
]);

/**
 * Classify a rejection reason. Returns null for ordinary failures, which are
 * still errors but are not safety refusals and should not change the status
 * code on their own.
 */
export function describeSyncSafetyRefusal(
  reason: unknown,
): SyncSafetyRefusal | null {
  const capacity = describeGrowthFenceRefusal(reason);
  if (capacity) {
    return {
      kind: "capacity_refused",
      scope: capacity.operation,
      message:
        reason instanceof Error ? reason.message : "database capacity boundary",
      detail: { decision: capacity.decision },
    };
  }

  if (
    reason instanceof SyncLaneDisabledError ||
    (typeof reason === "object" &&
      reason !== null &&
      (reason as { name?: unknown }).name === "SyncLaneDisabledError")
  ) {
    const admission = (reason as { admission?: { lane?: string; reason?: string } })
      .admission;
    return {
      kind: "lane_disabled",
      scope: admission?.lane ?? null,
      message: reason instanceof Error ? reason.message : "sync lane disabled",
      detail: admission ? { ...admission } : null,
    };
  }

  // Authority uncertainty surfaces as a RESULT, not a throw, so this also
  // accepts the shape a lane returns rather than only what it rejects with.
  const failureClass =
    typeof reason === "object" && reason !== null
      ? ((reason as { failureClass?: unknown }).failureClass ??
        (reason as { stopReason?: unknown }).stopReason)
      : null;
  if (typeof failureClass === "string" && AUTHORITY_UNKNOWN_CLASSES.has(failureClass)) {
    return {
      kind: "authority_unknown",
      scope: failureClass,
      message:
        "provider authority could not be read; work was requeued, not completed",
      detail: null,
    };
  }

  return null;
}

/**
 * Turn a settled lane result into something a response can carry WITHOUT
 * losing the refusal.
 *
 * A rejected lane keeps its structured refusal alongside the message; a
 * fulfilled lane is passed through so a lane that returned a stop reason can
 * still be inspected.
 */
export function describeLaneOutcome(
  result: PromiseSettledResult<unknown>,
): { value: unknown; refusal: SyncSafetyRefusal | null } {
  if (result.status === "fulfilled") {
    return {
      value: result.value,
      refusal: describeSyncSafetyRefusal(result.value),
    };
  }
  const refusal = describeSyncSafetyRefusal(result.reason);
  return {
    value: {
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      ...(refusal ? { safetyRefusal: refusal } : {}),
    },
    refusal,
  };
}
