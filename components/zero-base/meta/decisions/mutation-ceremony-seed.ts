"use client";

/**
 * The mutation ceremony's server bindings, in one place.
 *
 * `MutationCeremonySeed` takes its `preflight` and `dispatch` as injected
 * functions so the panel can be driven by a test without a network. That left
 * the real bindings living inside whichever client happened to construct the
 * seed — which was fine while there was one, and became a drift risk the moment
 * the mounted Decision Center needed the same ceremony: two copies of "what a
 * withheld preflight means" and "what an unnamed dispatch outcome is" would
 * eventually disagree, and the disagreement would be about whether a provider
 * write happened.
 *
 * Nothing here decides anything. The preflight sends a decision key and an
 * action and reads back the server's own target, verdict and dispatch
 * descriptor; the dispatch posts to the concrete path the server named with the
 * server's own body. This module assembles no endpoint and invents no outcome.
 */
import type { DispatchDescriptor } from "@/lib/zero-base/meta/dispatch-contract";
import type { TerminalOutcome } from "@/lib/zero-base/meta/mutation-ceremony";
import type {
  DispatchAnswer,
  MutationCeremonySeed,
  PreflightAnswer,
} from "@/components/zero-base/meta/decisions/mutation-ceremony-panel";

export function buildMutationCeremonySeed(input: {
  businessId: string;
  viewer: {
    isReviewer: boolean;
    demo: boolean;
    role: "admin" | "collaborator" | "guest" | null;
  };
  newMutationId: () => string;
}): MutationCeremonySeed {
  return {
    businessId: input.businessId,
    enabled: true,
    viewer: input.viewer,
    newMutationId: input.newMutationId,
    preflight: async ({ businessId, decisionKey, action }) => {
      const response = await fetch("/api/meta/decision-action/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Decision key and action only. No target, no expected state.
        body: JSON.stringify({
          contract: "zero-base.decision.v1",
          businessId,
          decisionKey,
          action,
        }),
      });
      const json = (await response.json().catch(() => null)) as {
        receipt?: { verdict: string; detail: string; checkedAt: string };
        dispatch?: DispatchDescriptor;
        withheld?: { reason: string; message: string };
        target?: {
          grain: "campaign" | "adset" | "ad";
          entityId: string;
          providerAccountId: string;
          status: string | null;
        };
        error?: string;
        message?: string;
      } | null;
      // The server proved the target but the handler's required inputs are
      // unavailable. Said plainly rather than offered as a control that could
      // only fail.
      if (response.ok && json?.withheld) {
        return {
          ok: false,
          kind: "withheld",
          code: json.withheld.reason,
          message: json.withheld.message,
        } satisfies PreflightAnswer;
      }
      if (!response.ok || !json?.receipt || !json.dispatch || !json.target) {
        return {
          ok: false,
          code: json?.error ?? `http_${response.status}`,
          message: json?.message ?? "The preflight could not be completed.",
        } satisfies PreflightAnswer;
      }
      return {
        ok: true,
        target: json.target,
        verdict: json.receipt.verdict as "ready",
        detail: json.receipt.detail,
        checkedAt: json.receipt.checkedAt,
        // Path and body both come from the server. This client assembles
        // neither.
        dispatch: json.dispatch,
      } satisfies PreflightAnswer;
    },
    dispatch: async ({ path, body, mutationId }) => {
      try {
        const response = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Verbatim: the server's own body for this handler, plus the operator
          // choices the descriptor declared. Nothing invented.
          body: JSON.stringify({ ...body, mutationId }),
        });
        const json = (await response.json().catch(() => null)) as {
          outcome?: TerminalOutcome;
          durable?: boolean;
          reference?: string | null;
          message?: string;
        } | null;
        return {
          // The endpoint's own classification is authority. An unnamed outcome
          // is ambiguous, never assumed applied.
          outcome:
            json?.outcome ??
            (response.ok ? "provider_outcome_ambiguous" : "failed"),
          durable: json?.durable === true,
          reference: json?.reference ?? null,
          detail: json?.message ?? `HTTP ${response.status}`,
        } satisfies DispatchAnswer;
      } catch (error) {
        // A request that never returned may still have been applied.
        return {
          outcome: "provider_outcome_ambiguous",
          durable: false,
          reference: null,
          detail:
            error instanceof Error
              ? error.message
              : "The request did not complete.",
        } satisfies DispatchAnswer;
      }
    },
  };
}
