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
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import type { WidthBucket } from "@/lib/zero-base/instrumentation-schema";

export type MutationGrain = "campaign" | "adset" | "ad";
export type { MutationAction } from "@/lib/zero-base/meta/dispatch-contract";
import {
  endpointFor,
  type MutationAction,
} from "@/lib/zero-base/meta/dispatch-contract";

/**
 * Endpoints and their request contracts live in `dispatch-contract.ts`.
 *
 * They were inlined here as a bare path map, which is how this module came to
 * claim `/api/meta/adsets/[adsetId]/bid` — a route that does not exist. A path
 * with no body contract beside it is a path nobody checks against a handler.
 */
export {
  MUTATION_ENDPOINTS,
  MANUAL_ACTION_ORIGIN,
  MANUAL_CONFIRMATION,
  FORBIDDEN_DISPATCH_FIELDS,
  buildDispatchDescriptor,
  composeDispatchBody,
  validateOperatorValues,
  WITHHOLD_MESSAGE,
  type DispatchDescriptor,
  type DispatchTarget,
  type OperatorField,
  type OperatorValues,
  type WithholdReason,
} from "@/lib/zero-base/meta/dispatch-contract";
export { endpointFor };

/** Server-owned name of the flag. Never a `NEXT_PUBLIC_*` value. */
export const MUTATION_UI_FLAG = "ZERO_BASE_MUTATION_UI_ENABLED";

/**
 * Whether the manual write UI exists at all.
 *
 * Read on the server only. This used to be a third independent spelling of one
 * capability: `ZERO_BASE_MUTATION_UI_ENABLED` was set in no environment file, so
 * the manual action sheet was unreachable everywhere while the routes behind it
 * had no gate at all. It now follows the single environment capability that the
 * rest of the write path reads, and the legacy variable is honoured only as an
 * explicit local override for a single process.
 *
 * This decides what the product OFFERS. What a viewer may actually do is
 * decided per business by `resolveMetaWriteCapability` on the server.
 */
export function isMutationUiEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[MUTATION_UI_FLAG]?.trim() === "true") return true;
  return readMetaReleaseGates(env).automationLiveWrites;
}

/**
 * Substitute a proven entity id into a typed endpoint template.
 *
 * Retained for the endpoint-shape tests. The ceremony no longer calls it: the
 * server now issues a concrete path inside the dispatch descriptor, so the
 * browser never assembles one.
 */
export function resolveEndpointPath(
  endpoint: string,
  provenEntityId: string,
): string {
  return endpoint.replace(/\[[^\]]+\]/, encodeURIComponent(provenEntityId));
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
  /**
   * The write was rehearsed, not made.
   *
   * `guardrails_json.dryRunOnly` is a business-level posture the server reads
   * at the write boundary, so an operator can complete the whole ceremony and
   * have nothing reach Meta. Folding that into `verified` would tell them a
   * change was applied that was not; folding it into `failed` would tell them
   * something went wrong when the guardrail did exactly its job.
   */
  | "dry_run"
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
  return {
    step,
    blocker,
    confirmation: "none",
    endpoint: null,
    preflightAgeMs: null,
  };
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
    case "launch":
      // A launch creates PAUSED, so nothing begins spending on confirmation;
      // acknowledgement matches what the act actually does. Activating it
      // afterwards is a separate, explicitly authorized step.
      return "acknowledge";
    case "resume":
    case "bid":
      return "typed_phrase";
    case "budget":
      /*
        D088. There is no operator ceremony for a budget change: the browser
        chooses no entity, field or magnitude, and `MUTATION_ENDPOINTS` names
        no path, so `buildDispatchDescriptor` refuses before a confirmation is
        ever needed. The strictest level is returned anyway, so a future
        ceremony cannot inherit a weaker default by omission.
      */
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
    return {
      step: "preflight",
      blocker: null,
      confirmation: "none",
      endpoint: null,
      preflightAgeMs: null,
    };
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
      message:
        "The proven target does not match the account you are working in.",
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
    return {
      step: "changed",
      blocker: null,
      confirmation: "none",
      endpoint: null,
      preflightAgeMs: ageMs,
    };
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
export function receiptAvailable(
  outcome: TerminalOutcome,
  durable: boolean,
): boolean {
  if (!durable) return false;
  return (
    outcome === "verified" ||
    outcome === "dry_run" ||
    outcome === "failed" ||
    outcome === "silent_failure"
  );
}

/**
 * Retry permission.
 *
 * Never under ambiguity: the provider may already have applied the change, and
 * retrying could double it. D067 requires the outcome be reconciled first.
 */
export function retryAllowed(outcome: TerminalOutcome): boolean {
  // A rehearsal may be re-run: nothing was applied, so nothing can be doubled.
  return outcome === "failed" || outcome === "dry_run";
}

export const TERMINAL_COPY: Record<
  TerminalOutcome,
  { title: string; body: string }
> = {
  verified: {
    title: "Applied and verified",
    body: "The change was confirmed in Meta.",
  },
  dry_run: {
    title: "Rehearsed, not applied",
    body:
      "Rehearsal mode is on for this business, so the request stopped before Meta. " +
      "Turn rehearsal off in Automation to apply changes for real.",
  },
  failed: {
    title: "Not applied",
    body: "Meta refused the change. Nothing was altered, so it is safe to try again.",
  },
  silent_failure: {
    title: "Change needs review",
    body: "The result is unknown. Check History before acting again.",
  },
  provider_outcome_ambiguous: {
    title: "Outcome unknown",
    body: "The change may have been applied. Do not retry. Check History first.",
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
    if (cleaned[field] !== undefined && cleaned[field] !== null)
      rejected.push(field);
    delete cleaned[field];
  }
  return { cleaned, rejected };
}

export type { WidthBucket };
