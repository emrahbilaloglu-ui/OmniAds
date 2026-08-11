/**
 * Ops repair ceremony presentation (Flow J).
 *
 * The admin repair endpoint answers `{ ok: true, action, actionResult }` and
 * performs **no independent read-back**. That is a real gap in the operation,
 * and this module's job is to preserve it rather than dress it up:
 *
 * - `ok: true` means the request was accepted and the action ran. It does not
 *   mean the condition is fixed, because nothing re-read the health state.
 * - So the surface never prints a receipt. It reports what the action returned
 *   and says plainly that confirmation requires re-running the health read.
 *
 * Changing the operation to add a read-back is out of scope for a work package
 * whose whole point is adapting composition without changing semantics. Naming
 * the gap is the honest alternative to hiding it.
 */

export type RepairPhase = "idle" | "running" | "settled";

export type RepairOutcome =
  | { kind: "accepted"; action: string; detail: string; readBack: "not_performed" }
  | { kind: "refused"; action: string; detail: string }
  | { kind: "ambiguous"; action: string; detail: string };

export const READ_BACK_GAP_NOTE =
  "This action reports what the repair returned. It does not re-read the health state, so it is not confirmation that the condition is resolved — run the health check again to see the current state.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Interpret the real PATCH response.
 *
 * A transport failure is **ambiguous**, not refused: the request may have
 * reached the server and run. Only an explicit non-ok body is a refusal.
 */
export function interpretRepairResponse(input: {
  httpOk: boolean;
  status: number | null;
  body: unknown;
  transportFailed: boolean;
}): RepairOutcome {
  const action = str(isRecord(input.body) ? input.body.action : null) ?? "repair";

  if (input.transportFailed) {
    return {
      kind: "ambiguous",
      action,
      detail:
        "The request did not complete. It may or may not have run on the server — re-read the health state before trying again.",
    };
  }
  if (!input.httpOk) {
    const message = str(isRecord(input.body) ? input.body.message : null);
    return {
      kind: "refused",
      action,
      detail: `${message ?? `The repair was refused (HTTP ${input.status ?? "unknown"}).`} Nothing was changed.`,
    };
  }

  const result = isRecord(input.body) ? input.body.actionResult : null;
  const status = str(isRecord(result) ? result.status : null);
  return {
    kind: "accepted",
    action,
    detail: status
      ? `The ${action} action ran and reported "${status}".`
      : `The ${action} action ran. It reported no status of its own.`,
    // Stated as a field, so a future read-back cannot be added silently.
    readBack: "not_performed",
  };
}

/** A receipt is never offered: nothing here observed the resulting state. */
export function repairReceiptAvailable(): false {
  return false;
}

export interface CriticalIncidentStep {
  id: string;
  label: string;
  /** What the operator can actually see at this step. */
  evidence: string;
}

/**
 * The critical incident path.
 *
 * Ordered so the operator reads state before acting and re-reads after: the
 * ceremony's honesty depends on the last step existing, because the action
 * itself confirms nothing.
 */
export const CRITICAL_INCIDENT_PATH: readonly CriticalIncidentStep[] = [
  { id: "detect", label: "See the failing health check", evidence: "The health board reports the failing provider and its reason." },
  { id: "inspect", label: "Open the affected workspace", evidence: "The workspace detail shows its own integration and sync state." },
  { id: "act", label: "Run the repair action", evidence: "The action reports what it returned — accepted, refused, or ambiguous." },
  { id: "reread", label: "Re-run the health check", evidence: "Only this shows whether the condition is actually resolved." },
];
