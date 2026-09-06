/**
 * One terminal answer for every Meta write route.
 *
 * The mutation ceremony reads `outcome`, `durable` and `reference` from the
 * response and treats an unnamed outcome as ambiguous — correctly, because a
 * client cannot know what happened at the provider. The status routes answered
 * `{ ok: true, status, dryRun }` instead, so every successful, read-back,
 * journalled write was presented to the operator as "Outcome unknown — do not
 * retry". The write was fine; the sentence was wrong, and it is the sentence an
 * operator acts on.
 *
 * The answer is derived from the PERSISTED journal status, never from `ok` and
 * never from the absence of an error. `ok === true && !dryRun` is an inference;
 * "the action log says success and here is its id" is a reading.
 */
import type { TerminalOutcome } from "@/lib/zero-base/meta/mutation-ceremony";
import {
  hasSuccessfulMetaProviderMutationAttempt,
  type MetaAdsWriteFailure,
} from "@/lib/meta/ads-write";
import type { DecisionOriginReconciliationOutcome } from "@/lib/meta/ads-action-log";

export interface MetaWriteTerminalAnswer {
  outcome: TerminalOutcome;
  /** True only when a durable row records this attempt's terminal state. */
  durable: boolean;
  /** The action-log id, which is what a receipt quotes. */
  reference: string | null;
}

/**
 * @param dryRun    the server's own posture for this attempt, not the client's
 *                  request — rehearsal is a business guardrail
 * @param logStatus the terminal status written to `meta_ads_action_log`
 * @param logId     that row's id, or null when nothing durable was written
 */
export function metaWriteTerminalAnswer(input: {
  dryRun: boolean;
  logStatus: string | null | undefined;
  logId: string | null | undefined;
}): MetaWriteTerminalAnswer {
  const reference = input.logId ?? null;
  const durable = reference !== null;
  if (input.dryRun) {
    // A rehearsal is a real, journalled outcome: it says what would have been
    // sent and that nothing was.
    return { outcome: "dry_run", durable, reference };
  }
  switch (input.logStatus) {
    case "success":
      return { outcome: "verified", durable, reference };
    case "silent_failure":
      return { outcome: "silent_failure", durable, reference };
    case "failure":
      return { outcome: "failed", durable, reference };
    default:
      // No terminal row means nothing settled the attempt. Ambiguous is the
      // only honest reading, and it is the one that forbids a retry.
      return { outcome: "provider_outcome_ambiguous", durable: false, reference };
  }
}

/**
 * The failure half.
 *
 * A refused write and an unresolved one are different facts: the first is safe
 * to retry, the second must be reconciled first. The adapters already
 * distinguish them; this only carries the distinction into the response.
 */
export function metaWriteFailureAnswer(input: {
  providerOutcome: "definite_failure" | "outcome_ambiguous" | null | undefined;
  logId: string | null | undefined;
}): MetaWriteTerminalAnswer {
  const reference = input.logId ?? null;
  if (input.providerOutcome === "outcome_ambiguous") {
    return {
      outcome: "provider_outcome_ambiguous",
      durable: false,
      reference,
    };
  }
  return { outcome: "failed", durable: reference !== null, reference };
}

/**
 * Which reconciliation outcome a failed decision-origin write parks under.
 *
 * Moved here from `ads-action-routes.ts` unchanged, because the unattended ad
 * path has to make the SAME judgement and a second copy is a second place for
 * "unknown" and "definitely failed" to drift apart. `null` means the failure is
 * definite and terminalises normally; anything else means the provider may have
 * applied the change and the row waits for a person.
 */
export function reconciliationOutcomeForProviderWriteFailure(
  result: MetaAdsWriteFailure,
  dryRun: boolean,
): DecisionOriginReconciliationOutcome | null {
  // A rehearsal never posted, so there is nothing whose outcome is unknown.
  if (dryRun) return null;
  if (
    result.error.code === "provider_outcome_ambiguous"
    || result.providerOutcome === "outcome_ambiguous"
  ) {
    return "provider_outcome_ambiguous";
  }
  if (hasSuccessfulMetaProviderMutationAttempt(result)) {
    // Meta accepted it and the verification did not agree. That is not a
    // failure to retry; it is a state nobody has established.
    return "provider_response_succeeded_verification_failed";
  }
  return null;
}
