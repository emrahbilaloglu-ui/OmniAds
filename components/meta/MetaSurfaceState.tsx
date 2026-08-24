/**
 * The §9 read state, rendered.
 *
 * This component decides nothing. It takes the envelope the server resolved and
 * prints it — the state, the failure code, and the operator sentence the
 * failure dictionary owns. There is deliberately no prop for "is this ready",
 * no prop for a message, and no branch on the payload: everything it could
 * infer is something `resolveMetaSurfaceReadState` has already decided, and a
 * second opinion here is exactly the drift §9 was written to stop.
 *
 * ## Why the state is in the DOM
 *
 * `data-read-state` is the only way a surface can be asked, from outside, what
 * it believes about itself. Without it a runtime gate can see an empty table
 * and cannot tell "there is nothing here" from "we could not read it" — which
 * is the same blindness the operator has, and the reason the distinction kept
 * being lost. It is an attribute rather than a class so styling cannot delete
 * the evidence.
 *
 * ## What it renders per state
 *
 * `success` and `empty-proven` render the marker and no banner: a surface that
 * is fine should not carry a notice saying so. Every other state renders a
 * sentence, because every other state is one the operator would otherwise have
 * to guess at.
 */
import type { MetaReadState, MetaResponseEnvelope } from "@/lib/meta/read-state-contract";

/** States that speak. The other two are the quiet, correct ones. */
const ANNOUNCED: readonly MetaReadState[] = [
  "loading",
  "refreshing-with-stale",
  "partial",
  "degraded",
  "refused",
];

/**
 * What the two stateless states say.
 *
 * These have no failure code, so the dictionary has no sentence for them, and
 * they still need words: a skeleton with no explanation and a stale table with
 * no label are both surfaces that look like something they are not.
 */
const STATELESS_MESSAGE: Partial<Record<MetaReadState, string>> = {
  loading: "Reading this surface. Nothing below is final yet.",
  "refreshing-with-stale":
    "These are the previous figures, still on screen while a newer read runs.",
};

export interface MetaSurfaceStateProps {
  /** The server's envelope. `null` before either side has spoken. */
  envelope: MetaResponseEnvelope<null> | null;
  /** The surface this belongs to, so evidence can name the screen. */
  surfaceId: string;
  className?: string;
}

export function MetaSurfaceState({ envelope, surfaceId, className }: MetaSurfaceStateProps) {
  if (!envelope) return null;
  const { state, failure } = envelope;
  const message = failure?.message ?? STATELESS_MESSAGE[state] ?? null;
  const announced = ANNOUNCED.includes(state);

  return (
    <div
      data-meta-surface-state={surfaceId}
      data-read-state={state}
      data-failure-code={failure?.code ?? undefined}
      data-provider-account={envelope.scope.providerAccountId ?? undefined}
      data-freshness={envelope.evidence.freshness}
      /* Observable from outside: a surface that is updating says so in the DOM
         as well as in words, so a gate can tell a stale read from a settled
         one without parsing a sentence. */
      data-updating={state === "refreshing-with-stale" ? "" : undefined}
      className={className}
      style={
        announced
          ? {
              display: "grid",
              gap: 4,
              margin: "0 0 12px",
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid var(--adv-border, #e4e8f0)",
              background: "var(--adv-fill, #f7f9fc)",
              fontSize: 12,
              lineHeight: "18px",
              color: "var(--adv-ink-2, #45526b)",
            }
          : undefined
      }
    >
      {announced ? (
        <>
          {/*
            `status`, not `alert`. Every one of these is a fact about the read
            that just happened; none is an interruption, and an assertive live
            region would talk over an operator mid-task on every refresh.
          */}
          <p role="status" style={{ margin: 0 }}>
            <strong style={{ fontWeight: 600 }}>{READ_STATE_LABEL[state]}</strong>
            {message ? ` — ${message}` : null}
          </p>
          {/*
            The code, for an operator who is reporting this to someone. Never a
            variable name and never a stack: a §9.1 code and nothing else.
          */}
          {failure ? (
            <p
              data-failure-code-label=""
              style={{ margin: 0, fontSize: 12, color: "var(--adv-ink-3, #555d6d)" }}
            >
              Reference: {failure.code}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The operator's word for each state. Not the enum, which is ours. */
export const READ_STATE_LABEL: Record<MetaReadState, string> = {
  loading: "Loading",
  "refreshing-with-stale": "Updating",
  success: "Serving",
  "empty-proven": "Nothing to show",
  partial: "Partly served",
  degraded: "Unavailable",
  refused: "Withheld",
};
