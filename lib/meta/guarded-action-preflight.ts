/**
 * Preflight for a guarded action, and the receipt it produces.
 *
 * Preflight answers one question: if this action ran right now, would it hit
 * exactly the thing the decision named, in the state the decision assumed?
 * It reads persisted provider state and never contacts the provider, so it is
 * safe to run at any time and proves the target without changing anything.
 *
 * Every failure is a refusal, not a warning. An action whose target drifted is
 * not "probably still fine"; it is an action pointed at something else.
 */

export type PreflightVerdict = "ready" | "drifted" | "not_found" | "blocked" | "ambiguous";

export interface PreflightTarget {
  entityType: "ad" | "adset" | "campaign";
  entityId: string;
  providerAccountId: string;
  /** State the decision was formed against. */
  expectedStatus: string | null;
  expectedCreativeId?: string | null;
  expectedParentId?: string | null;
}

export interface ObservedTarget {
  entityId: string;
  providerAccountId: string;
  status: string | null;
  creativeId?: string | null;
  parentId?: string | null;
  /** How many rows matched the identity; more than one cannot be acted on. */
  matchCount: number;
}

export interface PreflightReceipt {
  verdict: PreflightVerdict;
  /** Plain statement of what was checked and what was found. */
  detail: string;
  target: PreflightTarget;
  observed: ObservedTarget | null;
  checkedAt: string;
  /** Always false here: preflight never contacts the provider. */
  providerContacted: false;
  /** What differed, when the verdict is drifted. */
  drift: string[];
}

function normalizeStatus(value: string | null | undefined): string | null {
  const status = value?.trim().toUpperCase();
  return status ? status : null;
}

export function runGuardedActionPreflight(input: {
  target: PreflightTarget;
  observed: ObservedTarget | null;
  killSwitchEngaged: boolean;
  checkedAt: string;
}): PreflightReceipt {
  const base = {
    target: input.target,
    observed: input.observed,
    checkedAt: input.checkedAt,
    providerContacted: false as const,
  };

  if (input.killSwitchEngaged) {
    return {
      ...base,
      verdict: "blocked",
      detail: "The kill switch is engaged, so no action may be prepared or run.",
      drift: [],
    };
  }

  if (!input.observed || input.observed.matchCount === 0) {
    return {
      ...base,
      verdict: "not_found",
      detail: `No persisted ${input.target.entityType} matches ${input.target.entityId} in this account.`,
      drift: [],
    };
  }

  if (input.observed.matchCount > 1) {
    return {
      ...base,
      verdict: "ambiguous",
      detail: `${input.observed.matchCount} rows match this identity, so the exact target cannot be established.`,
      drift: [],
    };
  }

  const drift: string[] = [];

  if (input.observed.providerAccountId !== input.target.providerAccountId) {
    drift.push(
      `account is ${input.observed.providerAccountId}, decision assumed ${input.target.providerAccountId}`,
    );
  }

  const expectedStatus = normalizeStatus(input.target.expectedStatus);
  const observedStatus = normalizeStatus(input.observed.status);
  if (expectedStatus && observedStatus !== expectedStatus) {
    drift.push(`status is ${observedStatus ?? "unknown"}, decision assumed ${expectedStatus}`);
  }

  if (
    input.target.expectedCreativeId &&
    input.observed.creativeId !== input.target.expectedCreativeId
  ) {
    drift.push(
      `creative is ${input.observed.creativeId ?? "unknown"}, decision assumed ${input.target.expectedCreativeId}`,
    );
  }

  if (input.target.expectedParentId && input.observed.parentId !== input.target.expectedParentId) {
    drift.push(
      `parent is ${input.observed.parentId ?? "unknown"}, decision assumed ${input.target.expectedParentId}`,
    );
  }

  if (drift.length > 0) {
    return {
      ...base,
      verdict: "drifted",
      detail: "The target changed since this decision was formed, so it is no longer the thing the decision described.",
      drift,
    };
  }

  return {
    ...base,
    verdict: "ready",
    detail: `Target verified against persisted state: ${input.target.entityType} ${input.target.entityId}.`,
    drift: [],
  };
}

/** Only a clean verdict may proceed, and even then only if execution is enabled. */
export function preflightPermitsExecution(receipt: PreflightReceipt): boolean {
  return receipt.verdict === "ready";
}

export function describePreflightVerdict(verdict: PreflightVerdict): string {
  switch (verdict) {
    case "ready":
      return "Target verified";
    case "drifted":
      return "Target changed";
    case "not_found":
      return "Target not found";
    case "blocked":
      return "Blocked";
    case "ambiguous":
      return "Target ambiguous";
  }
}
