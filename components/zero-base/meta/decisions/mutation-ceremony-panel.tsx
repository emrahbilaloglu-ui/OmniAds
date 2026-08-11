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
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { ZeroBaseDialog } from "@/components/zero-base/primitives/overlays";
import {
  TERMINAL_COPY,
  confirmationFor,
  receiptAvailable,
  retryAllowed,
  type MutationAction,
  type MutationGrain,
  type TerminalOutcome,
} from "@/lib/zero-base/meta/mutation-ceremony";
import {
  composeDispatchBody,
  validateOperatorValues,
  type DispatchDescriptor,
  type OperatorValues,
} from "@/lib/zero-base/meta/dispatch-contract";
import type { DecisionRow } from "@/lib/zero-base/meta/decisions-presentation";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

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
    /** Concrete path the server named. Never assembled here. */
    path: string;
    /** The handler's exact body: server fields plus validated operator choices. */
    body: Record<string, unknown>;
    mutationId: string;
  }) => Promise<DispatchAnswer>;
  newMutationId: () => string;
  now?: () => Date;
}

export type PreflightAnswer =
  | {
      ok: true;
      target: { grain: MutationGrain; entityId: string; providerAccountId: string; status: string | null };
      verdict: "ready" | "drifted" | "blocked" | "ambiguous" | "not_found";
      detail: string;
      checkedAt: string;
      /** Present only when the action can actually be attempted. */
      dispatch: DispatchDescriptor;
    }
  /** The server can prove the target but the handler's inputs are unavailable. */
  | { ok: false; kind: "withheld"; code: string; message: string }
  | { ok: false; kind?: "refused"; code: string; message: string };

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
      kind: "collect";
      action: MutationAction;
      dispatch: DispatchDescriptor;
      target: { grain: MutationGrain; entityId: string; providerAccountId: string; status: string | null };
      checkedAt: string;
    }
  | {
      kind: "confirm";
      action: MutationAction;
      dispatch: DispatchDescriptor;
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
  const t = useCopy();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [announcement, setAnnouncement] = useState("");
  const [copied, setCopied] = useState(false);
  const [values, setValues] = useState<OperatorValues>({});
  const [problems, setProblems] = useState<string[]>([]);
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

      // An action with operator choices collects them first; validation
      // happens before the confirmation, never after it.
      if (answer.dispatch.operatorFields.length > 0) {
        setStep({
          kind: "collect",
          action,
          dispatch: answer.dispatch,
          target: answer.target,
          checkedAt: answer.checkedAt,
        });
        setAnnouncement(`${action} needs a few details before it can be confirmed.`);
        return;
      }

      setStep({
        kind: "confirm",
        action,
        dispatch: answer.dispatch,
        target: answer.target,
        checkedAt: answer.checkedAt,
      });
      setAnnouncement(`Ready to ${action}. Confirm to continue.`);
    },
    [now, row.id, seed],
  );

  /** Move from the form to the confirmation, but only if the form is valid. */
  const review = useCallback(
    (collecting: Extract<Step, { kind: "collect" }>) => {
      const found = validateOperatorValues(collecting.dispatch, values);
      setProblems(found);
      if (found.length > 0) {
        setAnnouncement(found.join(" "));
        return;
      }
      setStep({ ...collecting, kind: "confirm" });
      setAnnouncement(`Ready to ${collecting.action}. Confirm to continue.`);
    },
    [values],
  );

  const dispatch = useCallback(
    async (confirmed: Extract<Step, { kind: "confirm" }>) => {
      // One id per attempt, so a retried request is a replay rather than a
      // second write.
      if (!attemptId.current) attemptId.current = seed.newMutationId();
      setStep({ kind: "dispatching", action: confirmed.action });

      // A fresh preflight at dispatch time. The one behind the confirmation
      // described the world when the operator started reading; between then and
      // now the target may have moved, been reassigned, or become ambiguous.
      setAnnouncement("Re-checking the target before sending…");
      const fresh = await seed.preflight({
        businessId: seed.businessId,
        decisionKey: row.id,
        action: confirmed.action,
      });
      if (!fresh.ok) {
        setStep({
          kind: "refused",
          action: confirmed.action,
          code: fresh.code,
          message: fresh.message,
        });
        setAnnouncement(`${confirmed.action} was refused at dispatch. ${fresh.message}`);
        return;
      }
      if (fresh.verdict !== "ready") {
        setStep({ kind: "changed", action: confirmed.action, detail: fresh.detail });
        setAnnouncement(`${confirmed.action} was not sent: ${fresh.detail}`);
        return;
      }

      setAnnouncement(`Sending ${confirmed.action} to Meta…`);
      const answer = await seed.dispatch({
        // The path and body the server just issued. The browser adds only the
        // operator choices the descriptor asked for, already validated.
        path: fresh.dispatch.path,
        body: composeDispatchBody(fresh.dispatch, values),
        mutationId: attemptId.current,
      });

      if (answer.outcome !== "failed") attemptId.current = null;
      setStep({ kind: "terminal", action: confirmed.action, answer });
      setAnnouncement(`${TERMINAL_COPY[answer.outcome].title}. ${TERMINAL_COPY[answer.outcome].body}`);
    },
    [row.id, seed, values],
  );

  return (
    <section
      data-mutation-ceremony={row.id}
      aria-label={t.manualWrite}
      style={{
        display: "grid",
        gap: 8,
        padding: "10px 14px",
        borderRadius: "var(--ledger-radius-card)",
        border: "1px solid var(--ledger-border-control)",
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{t.manualWrite}</h3>

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
              data-ctl="gated:META-WRITE-01 open-manual"
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
              onClick={() => {
                setValues({});
                setProblems([]);
                void startPreflight(action);
              }}
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

      {step.kind === "collect" ? (
        <div data-mutation-step="collect" data-el="before-after" style={{ display: "grid", gap: 10 }}>
          {step.dispatch.note ? (
            <p data-mutation-note="" style={{ margin: 0, fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
              {step.dispatch.note}
            </p>
          ) : null}
          {step.dispatch.operatorFields.map((field) => (
            <TextInput
              key={field.name}
              label={
                field.kind === "minor_amount"
                  ? `${field.label} (minor units, ${field.currency})`
                  : field.label
              }
              data-mutation-field={field.name}
              inputMode={field.kind === "minor_amount" ? "numeric" : undefined}
              value={values[field.name] ?? ""}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.name]: event.target.value }))
              }
              hint={
                field.kind === "minor_amount"
                  ? `Entered in ${field.currency}. No conversion happens here.`
                  : undefined
              }
            />
          ))}
          {problems.length > 0 ? (
            <ul data-mutation-problems="" style={{ margin: 0, paddingLeft: 16 }}>
              {problems.map((problem) => (
                <li key={problem} style={{ fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
                  {problem}
                </li>
              ))}
            </ul>
          ) : null}
          <div>
            <Button
              variant="secondary"
              data-mutation-review=""
              data-ctl="gated:META-WRITE-02 continue"
              onClick={() => review(step)}
            >
              Review {step.action}
            </Button>
          </div>
        </div>
      ) : null}

      {step.kind === "stale" ? (
        <div data-mutation-step="stale" data-el="preflight-age" style={{ fontSize: 12.5 }}>
          <p style={{ margin: 0, color: "var(--ledger-semantic-warn)" }}>
            {t.checkOlderThan15}
          </p>
          <Button
            variant="secondary"
            data-mutation-recheck=""
            data-ctl="live:META-WRITE-06 rerun"
            onClick={() => void startPreflight(step.action)}
          >
            {t.reCheck}
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
            <span data-mutation-confirm-scope="" data-el="confirm-restate">
              {step.target.grain} {step.target.entityId} in account {step.target.providerAccountId}.
              Currently {step.target.status ?? "unknown"}. Checked at {step.checkedAt} against
              persisted state — Meta was not contacted. The target is re-checked once more
              before anything is sent.
              {step.dispatch.operatorFields.length > 0 ? (
                <span data-mutation-confirm-values="" style={{ display: "block", marginTop: 4 }}>
                  {step.dispatch.operatorFields
                    .filter((field) => (values[field.name] ?? "").trim())
                    .map((field) => `${field.label}: ${values[field.name]}`)
                    .join(" · ")}
                </span>
              ) : null}
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
      <span data-mutation-detail="" data-el="receipt" style={{ color: "var(--ledger-ink-tertiary)" }}>
        {outcome.detail}
      </span>

      {receipt ? (
        <div>
          <Button
            variant="quiet"
            data-mutation-receipt=""
            data-ctl="live:META-WRITE-08 copy-receipt"
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
