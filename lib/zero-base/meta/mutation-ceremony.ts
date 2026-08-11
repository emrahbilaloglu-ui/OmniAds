/**
 * The manual write ceremony (H13–H16, Flow B).
 *
 * A provider write is the only place in this product where a mistake is not
 * recoverable by reloading, so the ceremony is deliberately slow and every
 * step can only narrow what is permitted. Nothing here contacts a provider,
 * and nothing here decides a verdict: the decision is the resolver's and the
 * live state is the persisted-state preflight's.
 *
 * Two rules that shape the whole module:
 *
 * 1. **The server derives the expected state, never the client.** The legacy
 *    preflight accepts `expectedStatus`, `expectedCreativeId` and
 *    `expectedParentId` from the request body. In the canonical mode those are
 *    ignored, because a client that can name what it expects can also name
 *    something that makes a stale write look fresh.
 * 2. **Dispatch is an allowlist of typed endpoints.** There is no generic
 *    execute route: a single endpoint taking an action name is one validation
 *    bug away from performing an action nobody reviewed.
 */
import type { WidthBucket } from "@/lib/zero-base/instrumentation-schema";

export type MutationGrain = "campaign" | "adset" | "ad";
export type MutationAction = "pause" | "resume" | "bid" | "duplicate";

/**
 * Every endpoint the ceremony may call, keyed by grain and action.
 *
 * Exhaustive and explicit: an action with no entry cannot be dispatched at all,
 * which is the property a generic executor gives up.
 */
export const MUTATION_ENDPOINTS: Readonly<
  Partial<Record<MutationGrain, Partial<Record<MutationAction, string>>>>
> = {
  campaign: {
    pause: "/api/meta/campaigns/[campaignId]/pause",
    resume: "/api/meta/campaigns/[campaignId]/resume",
  },
  adset: {
    pause: "/api/meta/adsets/[adsetId]/pause",
    resume: "/api/meta/adsets/[adsetId]/resume",
    bid: "/api/meta/adsets/[adsetId]/bid",
  },
  ad: {
    pause: "/api/meta/ads/[adId]/pause",
    resume: "/api/meta/ads/[adId]/resume",
    duplicate: "/api/meta/ads/[adId]/duplicate",
  },
};

export function endpointFor(grain: MutationGrain, action: MutationAction): string | null {
  return MUTATION_ENDPOINTS[grain]?.[action] ?? null;
}

/** Preflight older than this must be re-run before anything is dispatched. */
export const PREFLIGHT_MAX_AGE_MS = 15 * 60 * 1000;

export type CeremonyStep =
  | "unavailable"
  | "preflight"
  | "stale"
  | "changed"
  | "confirm"
  | "dispatching"
  | "terminal";

export type ConfirmationLevel = "none" | "acknowledge" | "typed_phrase";

export type TerminalOutcome =
  | "verified"
  | "failed"
  | "silent_failure"
  | "provider_outcome_ambiguous";

export interface CeremonyBlocker {
  code:
    | "mutation_ui_disabled"
    | "provider_offline"
    | "reviewer"
    | "demo"
    | "held_decision"
    | "missing_lineage"
    | "not_writable"
    | "target_mismatch"
    | "unsupported_action";
  message: string;
}

export interface CeremonyInput {
  /** Server-owned. Off in every environment unless explicitly enabled. */
  mutationUiEnabled: boolean;
  grain: MutationGrain;
  action: MutationAction;
  /** From the persisted-state preflight, never from the client. */
  preflight: {
    ok: boolean;
    ranAt: string | null;
    /** True when the decision offers no authorized action. */
    held: boolean;
    /** True when live state no longer matches what the decision described. */
    changed: boolean;
    writable: boolean;
    lineageComplete: boolean;
    /** Provider account/business the preflight actually proved. */
    provenBusinessId: string | null;
    provenAccountId: string | null;
  };
  /** The scope the operator is acting in, from the authorized page context. */
  scope: { businessId: string; accountId: string | null };
  viewer: { isReviewer: boolean; demo: boolean };
  providerOnline: boolean;
  now: Date;
}

export interface CeremonyState {
  step: CeremonyStep;
  blocker: CeremonyBlocker | null;
  confirmation: ConfirmationLevel;
  /** Endpoint that would be called; null whenever dispatch is not permitted. */
  endpoint: string | null;
  /** Age of the preflight in ms, or null when it never ran. */
  preflightAgeMs: number | null;
}

function blocked(step: CeremonyStep, blocker: CeremonyBlocker): CeremonyState {
  return { step, blocker, confirmation: "none", endpoint: null, preflightAgeMs: null };
}

/**
 * Highest required confirmation for an action.
 *
 * Pausing spend is reversible and merely needs acknowledgement; resuming spend
 * and changing a bid start money moving again, so they take a typed phrase.
 * Duplicating creates a new object and is acknowledged rather than typed.
 */
export function confirmationFor(action: MutationAction): ConfirmationLevel {
  switch (action) {
    case "pause":
      return "acknowledge";
    case "duplicate":
      return "acknowledge";
    case "resume":
    case "bid":
      return "typed_phrase";
  }
}

/**
 * Resolves the ceremony state.
 *
 * Order matters and is part of the contract: the cheapest, most absolute
 * refusals come first, so a disabled flag or a reviewer never reaches a
 * preflight, and a held decision never reaches a confirmation.
 */
export function resolveCeremony(input: CeremonyInput): CeremonyState {
  // 1 · The flag is the outermost gate. Off means the UI does not exist.
  if (!input.mutationUiEnabled) {
    return blocked("unavailable", {
      code: "mutation_ui_disabled",
      message: "Manual writes are not enabled in this environment.",
    });
  }

  // 2 · Posture. A reviewer and a demo business have no write authority at
  //     all, whatever the decision says.
  if (input.viewer.isReviewer) {
    return blocked("unavailable", {
      code: "reviewer",
      message: "Reviewer sessions are read-only and never reach a provider.",
    });
  }
  if (input.viewer.demo) {
    return blocked("unavailable", {
      code: "demo",
      message: "The demo business has no Meta write authority.",
    });
  }

  // 3 · The action must exist for this grain. No generic executor.
  const endpoint = endpointFor(input.grain, input.action);
  if (!endpoint) {
    return blocked("unavailable", {
      code: "unsupported_action",
      message: `No ${input.action} endpoint exists at ${input.grain} grain.`,
    });
  }

  if (!input.providerOnline) {
    return blocked("unavailable", {
      code: "provider_offline",
      message: "Meta is unreachable, so nothing can be dispatched.",
    });
  }

  // 4 · Preflight must have run and succeeded.
  if (!input.preflight.ok || !input.preflight.ranAt) {
    return { step: "preflight", blocker: null, confirmation: "none", endpoint: null, preflightAgeMs: null };
  }

  if (input.preflight.held) {
    return blocked("unavailable", {
      code: "held_decision",
      message: "This decision offers no authorized action.",
    });
  }
  if (!input.preflight.lineageComplete) {
    return blocked("unavailable", {
      code: "missing_lineage",
      message: "The decision's exact provider identity could not be proven.",
    });
  }
  if (!input.preflight.writable) {
    return blocked("unavailable", {
      code: "not_writable",
      message: "The bound provider account is not writable.",
    });
  }

  // 5 · What the preflight proved must be the scope the operator is in.
  //     A mismatch means the ceremony would act on somebody else's account.
  const businessMismatch =
    input.preflight.provenBusinessId !== null &&
    input.preflight.provenBusinessId !== input.scope.businessId;
  const accountMismatch =
    input.scope.accountId !== null &&
    input.preflight.provenAccountId !== null &&
    input.preflight.provenAccountId !== input.scope.accountId;
  if (businessMismatch || accountMismatch) {
    return blocked("unavailable", {
      code: "target_mismatch",
      message: "The proven target does not match the account you are working in.",
    });
  }

  const ageMs = input.now.getTime() - new Date(input.preflight.ranAt).getTime();

  // 6 · An aged preflight describes a world that may have moved on.
  if (!Number.isFinite(ageMs) || ageMs > PREFLIGHT_MAX_AGE_MS) {
    return {
      step: "stale",
      blocker: null,
      confirmation: "none",
      endpoint: null,
      preflightAgeMs: Number.isFinite(ageMs) ? ageMs : null,
    };
  }

  // 7 · Live state that no longer matches the decision is re-reviewed, not
  //     confirmed away.
  if (input.preflight.changed) {
    return { step: "changed", blocker: null, confirmation: "none", endpoint: null, preflightAgeMs: ageMs };
  }

  return {
    step: "confirm",
    blocker: null,
    confirmation: confirmationFor(input.action),
    endpoint,
    preflightAgeMs: ageMs,
  };
}

/**
 * A receipt exists only when the attempt is durable.
 *
 * An ambiguous outcome has no receipt because there is nothing settled to
 * copy, and offering one would invite an operator to treat "we do not know" as
 * "it worked".
 */
export function receiptAvailable(outcome: TerminalOutcome, durable: boolean): boolean {
  if (!durable) return false;
  return outcome === "verified" || outcome === "failed" || outcome === "silent_failure";
}

/**
 * Retry permission.
 *
 * Never under ambiguity: the provider may already have applied the change, and
 * retrying could double it. D067 requires the outcome be reconciled first.
 */
export function retryAllowed(outcome: TerminalOutcome): boolean {
  return outcome === "failed";
}

export const TERMINAL_COPY: Record<TerminalOutcome, { title: string; body: string }> = {
  verified: {
    title: "Applied and verified",
    body: "Meta confirmed the change and we re-read it back.",
  },
  failed: {
    title: "Not applied",
    body: "Meta refused the change. Nothing was altered, so it is safe to try again.",
  },
  silent_failure: {
    title: "Reported success, verification failed",
    body:
      "Meta accepted the request but the re-read did not confirm it. Treat the outcome as unknown " +
      "and reconcile before acting again.",
  },
  provider_outcome_ambiguous: {
    title: "Outcome unknown",
    body:
      "The request may or may not have been applied. Do not retry — reconciliation will settle it, " +
      "and retrying could apply the change twice.",
  },
};

/** Fields the canonical mode refuses to take from a client. */
export const CLIENT_SUPPLIED_EXPECTED_FIELDS = [
  "expectedStatus",
  "expectedCreativeId",
  "expectedParentId",
] as const;

/**
 * Strips client-supplied expectations.
 *
 * Returns the names it removed so the route can report them rather than
 * silently ignoring a field the caller believed was honoured.
 */
export function stripClientExpectations(body: Record<string, unknown>): {
  cleaned: Record<string, unknown>;
  rejected: string[];
} {
  const cleaned = { ...body };
  const rejected: string[] = [];
  for (const field of CLIENT_SUPPLIED_EXPECTED_FIELDS) {
    if (cleaned[field] !== undefined && cleaned[field] !== null) rejected.push(field);
    delete cleaned[field];
  }
  return { cleaned, rejected };
}

export type { WidthBucket };
