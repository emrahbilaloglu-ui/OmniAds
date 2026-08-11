"use client";

/**
 * The manual write ceremony, mounted in the Decisions inspector (H13–H16).
 *
 * A provider write is the only place in this product where a mistake is not
 * recoverable by reloading, so this is deliberately slow and every step only
 * narrows what is permitted.
 *
 * The component exists at all only because the server said the mutation UI is
 * enabled. There is no client flag to read and no branch that renders a
 * disabled control: when the seed is absent, so is this whole surface — and
 * with it every preflight and dispatch request it could have made.
 *
 * Order is the contract:
 *
 *   availability → decision-bound persisted-state preflight → age/change
 *   → highest required confirmation → typed endpoint dispatch → progress
 *   → terminal / reconciliation
 *
 * Nothing here names its own target. The operator picks an action; the server
 * proves which campaign, ad set or ad that decision means, and the dispatch
 * path is built from the proven id alone.
 */
import { useCallback, useRef, useState } from "react";

import { Button } from "@/components/zero-base/primitives/button";
import { ZeroBaseDialog } from "@/components/zero-base/primitives/overlays";
import {
  TERMINAL_COPY,
  confirmationFor,
  receiptAvailable,
  resolveEndpointPath,
  retryAllowed,
  type MutationAction,
  type MutationGrain,
  type TerminalOutcome,
} from "@/lib/zero-base/meta/mutation-ceremony";
import type { DecisionRow } from "@/lib/zero-base/meta/decisions-presentation";

/** Everything the ceremony needs, all of it from the authorized server route. */
export interface MutationCeremonySeed {
  businessId: string;
  /** Server-read. The panel is not rendered at all when this is false. */
  enabled: true;
  viewer: { isReviewer: boolean; demo: boolean; role: "admin" | "collaborator" | "guest" | null };
  /** Injected so tests drive the boundary without a network. */
  preflight: (input: {
    businessId: string;
    decisionKey: string;
    action: MutationAction;
  }) => Promise<PreflightAnswer>;
  dispatch: (input: {
    path: string;
    businessId: string;
    mutationId: string;
  }) => Promise<DispatchAnswer>;
  newMutationId: () => string;
  now?: () => Date;
}

export type PreflightAnswer =
  | {
      ok: true;
      endpoint: string;
      target: { grain: MutationGrain; entityId: string; providerAccountId: string; status: string | null };
      verdict: "ready" | "drifted" | "blocked" | "ambiguous" | "not_found";
      detail: string;
      checkedAt: string;
    }
  | { ok: false; code: string; message: string };

export type DispatchAnswer = {
  outcome: TerminalOutcome;
  /** True only when the attempt reached a durable action/reconciliation log. */
  durable: boolean;
  reference: string | null;
  detail: string;
};

type Step =
  | { kind: "idle" }
  | { kind: "preflighting"; action: MutationAction }
  | { kind: "refused"; action: MutationAction; code: string; message: string }
  | { kind: "stale"; action: MutationAction; ageMs: number }
  | { kind: "changed"; action: MutationAction; detail: string }
  | {
      kind: "confirm";
      action: MutationAction;
      endpoint: string;
      target: { grain: MutationGrain; entityId: string; providerAccountId: string; status: string | null };
      checkedAt: string;
    }
  | { kind: "dispatching"; action: MutationAction }
  | { kind: "terminal"; action: MutationAction; answer: DispatchAnswer };

const OFFERED_ACTIONS: MutationAction[] = ["pause", "resume", "bid", "duplicate"];

/** Preflight older than this must be re-run before anything is dispatched. */
const MAX_AGE_MS = 15 * 60 * 1000;

const TYPED_PHRASE: Record<MutationAction, string> = {
  pause: "PAUSE",
  resume: "RESUME",
  bid: "CHANGE BID",
  duplicate: "DUPLICATE",
};

export function MutationCeremonyPanel({
  row,
  seed,
}: {
  row: DecisionRow;
  seed: MutationCeremonySeed;
}) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [announcement, setAnnouncement] = useState("");
  const [copied, setCopied] = useState(false);
  const attemptId = useRef<string | null>(null);
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const now = seed.now ?? (() => new Date());

  const denial = seed.viewer.isReviewer
    ? "Reviewer sessions are read-only and never reach a provider."
    : seed.viewer.demo
      ? "The demo business has no Meta write authority."
      : seed.viewer.role === "guest" || seed.viewer.role === null
        ? "Your role on this business cannot make provider changes."
        : row.held
          ? (row.heldReason ?? "This decision offers no authorized action.")
          : null;

  const startPreflight = useCallback(
    async (action: MutationAction) => {
      setStep({ kind: "preflighting", action });
      setAnnouncement(`Checking whether ${action} is still safe…`);
      const answer = await seed.preflight({
        businessId: seed.businessId,
        decisionKey: row.id,
        action,
      });

      if (!answer.ok) {
        setStep({ kind: "refused", action, code: answer.code, message: answer.message });
        setAnnouncement(`${action} was refused. ${answer.message}`);
        return;
      }

      const ageMs = now().getTime() - new Date(answer.checkedAt).getTime();
      if (!Number.isFinite(ageMs) || ageMs > MAX_AGE_MS) {
        // An aged check describes a world that may have moved on.
        setStep({ kind: "stale", action, ageMs: Number.isFinite(ageMs) ? ageMs : 0 });
        setAnnouncement("That check is too old to act on. Run it again.");
        return;
      }
      if (answer.verdict !== "ready") {
        setStep({ kind: "changed", action, detail: answer.detail });
        setAnnouncement(`${action} was not offered: ${answer.detail}`);
        return;
      }

      setStep({
        kind: "confirm",
        action,
        endpoint: answer.endpoint,
        target: answer.target,
        checkedAt: answer.checkedAt,
      });
      setAnnouncement(`Ready to ${action}. Confirm to continue.`);
    },
    [now, row.id, seed],
  );

  const dispatch = useCallback(
    async (confirmed: Extract<Step, { kind: "confirm" }>) => {
      // One id per attempt, so a retried request is a replay rather than a
      // second write.
      if (!attemptId.current) attemptId.current = seed.newMutationId();
      setStep({ kind: "dispatching", action: confirmed.action });
      setAnnouncement(`Sending ${confirmed.action} to Meta…`);

      const answer = await seed.dispatch({
        // The path is built from the endpoint the server named and the id the
        // server proved. Neither came from this browser.
        path: resolveEndpointPath(confirmed.endpoint, confirmed.target.entityId),
        businessId: seed.businessId,
        mutationId: attemptId.current,
      });

      if (answer.outcome !== "failed") attemptId.current = null;
      setStep({ kind: "terminal", action: confirmed.action, answer });
      setAnnouncement(`${TERMINAL_COPY[answer.outcome].title}. ${TERMINAL_COPY[answer.outcome].body}`);
    },
    [seed],
  );

  return (
    <section
      data-mutation-ceremony={row.id}
      aria-label="Manual write"
      style={{
        display: "grid",
        gap: 8,
        padding: "10px 14px",
        borderRadius: "var(--ledger-radius-card)",
        border: "1px solid var(--ledger-border-control)",
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Manual write</h3>

      <p
        role="status"
        aria-live="polite"
        data-mutation-live=""
        style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-secondary)", minHeight: 16 }}
      >
        {announcement}
      </p>

      {denial ? (
        <p data-mutation-denied="" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
          {denial}
        </p>
      ) : (
        <div data-mutation-actions="" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {OFFERED_ACTIONS.map((action) => (
            <Button
              key={action}
              variant="secondary"
              data-mutation-action={action}
              ref={(node: HTMLButtonElement | null) => {
                triggerRefs.current[action] = node;
              }}
              state={
                step.kind === "preflighting"
                  ? { kind: "busy", label: "Checking…" }
                  : step.kind === "dispatching"
                    ? { kind: "busy", label: "Sending…" }
                    : { kind: "enabled" }
              }
              onClick={() => void startPreflight(action)}
            >
              {action}
            </Button>
          ))}
        </div>
      )}

      {step.kind === "preflighting" ? (
        <p data-mutation-step="preflighting" style={{ margin: 0, fontSize: 12.5 }}>
          Checking persisted provider state…
        </p>
      ) : null}

      {step.kind === "refused" ? (
        <p
          data-mutation-step="refused"
          data-mutation-refusal={step.code}
          style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}
        >
          {step.message}
        </p>
      ) : null}

      {step.kind === "stale" ? (
        <div data-mutation-step="stale" style={{ fontSize: 12.5 }}>
          <p style={{ margin: 0, color: "var(--ledger-semantic-warn)" }}>
            That check is older than 15 minutes. Run it again before acting.
          </p>
          <Button variant="secondary" data-mutation-recheck="" onClick={() => void startPreflight(step.action)}>
            Re-check
          </Button>
        </div>
      ) : null}

      {step.kind === "changed" ? (
        <p data-mutation-step="changed" style={{ margin: 0, fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
          {step.detail}
        </p>
      ) : null}

      {step.kind === "dispatching" ? (
        <p data-mutation-step="dispatching" style={{ margin: 0, fontSize: 12.5 }}>
          Sending…
        </p>
      ) : null}

      {step.kind === "terminal" ? (
        <TerminalPanel
          outcome={step.answer}
          action={step.action}
          onRetry={
            retryAllowed(step.answer.outcome)
              ? () => void startPreflight(step.action)
              : null
          }
          copied={copied}
          onCopy={() => setCopied(true)}
        />
      ) : null}

      <ZeroBaseDialog
        open={step.kind === "confirm"}
        onOpenChange={(open) => {
          if (!open) {
            const action = step.kind === "confirm" ? step.action : null;
            setStep({ kind: "idle" });
            if (action) triggerRefs.current[action]?.focus();
          }
        }}
        title={step.kind === "confirm" ? `${step.action} this ${step.target.grain}?` : "Confirm"}
        description={
          step.kind === "confirm" ? (
            <span data-mutation-confirm-scope="">
              {step.target.grain} {step.target.entityId} in account {step.target.providerAccountId}.
              Currently {step.target.status ?? "unknown"}. Checked at {step.checkedAt} against
              persisted state — Meta was not contacted.
            </span>
          ) : undefined
        }
        confirmLabel={step.kind === "confirm" ? step.action : "Confirm"}
        destructive={step.kind === "confirm" && step.action === "pause"}
        // Resuming spend and changing a bid take a typed phrase; pausing and
        // duplicating are acknowledged.
        confirmPhrase={
          step.kind === "confirm" && confirmationFor(step.action) === "typed_phrase"
            ? TYPED_PHRASE[step.action]
            : undefined
        }
        onConfirm={() => {
          if (step.kind === "confirm") void dispatch(step);
        }}
      />
    </section>
  );
}

function TerminalPanel({
  outcome,
  action,
  onRetry,
  copied,
  onCopy,
}: {
  outcome: DispatchAnswer;
  action: MutationAction;
  onRetry: (() => void) | null;
  copied: boolean;
  onCopy: () => void;
}) {
  const copy = TERMINAL_COPY[outcome.outcome];
  const receipt = receiptAvailable(outcome.outcome, outcome.durable);
  return (
    <div
      data-mutation-step="terminal"
      data-mutation-outcome={outcome.outcome}
      style={{ display: "grid", gap: 6, fontSize: 12.5 }}
    >
      <strong style={{ fontWeight: 600 }}>{copy.title}</strong>
      <span>{copy.body}</span>
      <span data-mutation-detail="" style={{ color: "var(--ledger-ink-tertiary)" }}>
        {outcome.detail}
      </span>

      {receipt ? (
        <div>
          <Button
            variant="quiet"
            data-mutation-receipt=""
            onClick={() => {
              void navigator.clipboard?.writeText?.(outcome.reference ?? "").catch(() => {});
              onCopy();
            }}
          >
            {copied ? "Receipt copied" : "Copy receipt"}
          </Button>
        </div>
      ) : (
        // Nothing is settled, and a receipt would invite reading "we do not
        // know" as "it worked".
        <span data-mutation-receipt-withheld="" style={{ color: "var(--ledger-ink-tertiary)" }}>
          No receipt: this attempt is not durably settled.
        </span>
      )}

      {onRetry ? (
        <div>
          <Button variant="secondary" data-mutation-retry="" onClick={onRetry}>
            Try {action} again
          </Button>
        </div>
      ) : (
        <span data-mutation-retry-blocked="" style={{ color: "var(--ledger-ink-tertiary)" }}>
          {outcome.outcome === "verified"
            ? "Applied — nothing to retry."
            : "Retrying is not offered until reconciliation settles this attempt."}
        </span>
      )}
    </div>
  );
}
