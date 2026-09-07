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
 *
 * ## Why two of those sentences are not in the layout
 *
 * `loading` and `refreshing-with-stale` are the two states that ALWAYS end. A
 * notice that always disappears, sitting in flow above the whole surface, moves
 * every row on the page the moment the read lands — measured on the mounted
 * Creative Studio as CLS 0.104 against a 0.100 budget, from one 52 px collapse
 * (a 40 px card plus its 12 px margin) of this exact element. Every Meta
 * surface paid it on every load; Creative Studio was simply the one whose
 * content column is tall enough to cross the budget.
 *
 * So the transient pair is pinned rather than stacked: same words, same
 * markers, same failure code, but out of flow, where a notice that is about to
 * vanish cannot drag the page with it when it does. The three states that
 * PERSIST — `partial`, `degraded`, `refused` — stay exactly where they were, in
 * flow and above the content, because those are answers rather than waits: they
 * last as long as the condition does, an operator must not be able to scroll
 * past them, and the shift they cause happens once, on arrival, as the settled
 * result rather than as a flicker.
 *
 * Reserving the space instead was the other candidate and is worse: it spends
 * 52 px of every Meta surface, for ever, on a box that is empty almost all of
 * the time — and the design package draws no such gap, so the fidelity gates
 * would refuse it for the same reason an operator would.
 */
import type {
  MetaReadState,
  MetaResponseEnvelope,
} from "@/lib/meta/read-state-contract";

/** States that speak. The other two are the quiet, correct ones. */
const ANNOUNCED: readonly MetaReadState[] = [
  "loading",
  "refreshing-with-stale",
  "partial",
  "degraded",
  "refused",
];

/**
 * The announced states that end on their own.
 *
 * Membership here is not a styling choice; it is the claim that the state is a
 * WAIT rather than an ANSWER. Adding a state to this list says "this always
 * resolves", and a state that can persist must never be added — an operator
 * would then have a permanent condition reported by something that reads as a
 * momentary one.
 */
const TRANSIENT: readonly MetaReadState[] = [
  "loading",
  "refreshing-with-stale",
];

/**
 * What the two stateless states say.
 *
 * These have no failure code, so the dictionary has no sentence for them, and
 * they still need words: a skeleton with no explanation and a stale table with
 * no label are both surfaces that look like something they are not.
 */
const STATE_MESSAGE: Partial<Record<MetaReadState, string>> = {
  loading: "Loading the latest Meta data.",
  "refreshing-with-stale": "Updating the latest Meta data.",
  partial: "Some recent Meta data is still loading.",
  degraded: "This information is temporarily unavailable.",
  refused: "This information is unavailable for the selected account.",
};

/** The card, identical in both placements. Only its position differs. */
const CARD: React.CSSProperties = {
  display: "grid",
  gap: 4,
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid var(--adv-border, #e4e8f0)",
  background: "var(--adv-fill, #f7f9fc)",
  fontSize: 12,
  lineHeight: "18px",
  color: "var(--adv-ink-2, #45526b)",
};

/** In flow, above the surface, for the states that persist. */
const IN_FLOW: React.CSSProperties = { ...CARD, margin: "0 0 12px" };

/**
 * Pinned, for the states that end.
 *
 * Bottom-right rather than over the surface's own header: a wait that lasts
 * longer than expected must stay readable without covering the thing being
 * waited for. `box-shadow` rather than a heavier border, because this one sits
 * above content rather than beside it.
 */
const PINNED: React.CSSProperties = {
  ...CARD,
  position: "fixed",
  right: 20,
  bottom: 20,
  zIndex: 40,
  maxWidth: "min(420px, calc(100vw - 40px))",
  background: "var(--adv-surface, #ffffff)",
  boxShadow: "0 10px 30px rgba(11, 16, 32, 0.16)",
};

export interface MetaSurfaceStateProps {
  /** The server's envelope. `null` before either side has spoken. */
  envelope: MetaResponseEnvelope<null> | null;
  /** The surface this belongs to, so evidence can name the screen. */
  surfaceId: string;
  className?: string;
}

export function MetaSurfaceState({
  envelope,
  surfaceId,
  className,
}: MetaSurfaceStateProps) {
  if (!envelope) return null;
  const { state, failure } = envelope;
  const message = STATE_MESSAGE[state] ?? null;
  const announced = ANNOUNCED.includes(state);
  const transient = TRANSIENT.includes(state);

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
      /* Which placement this state got, so the CLS gate can name it. */
      data-notice-placement={
        announced ? (transient ? "pinned" : "in-flow") : undefined
      }
      className={className}
    >
      {announced ? (
        /*
         * Keyed by placement, so the two are different ELEMENTS rather than one
         * element that relocates.
         *
         * Without the key React reconciles them as the same `div` and simply
         * swaps the style — and a node that goes from pinned in the corner to
         * in flow at the top has, as far as the layout-shift API is concerned,
         * travelled the diagonal of the viewport. Measured: Decisions settles
         * `loading → partial`, and that one reused node took the surface from
         * 0.013 to 0.312. Keyed, one unmounts and the other mounts, and the only
         * cost left is the honest one — a persistent notice arriving above the
         * content it qualifies.
         */
        <div
          key={transient ? "pinned" : "in-flow"}
          style={transient ? PINNED : IN_FLOW}
          data-meta-surface-notice=""
        >
          {/*
            `status`, not `alert`. Every one of these is a fact about the read
            that just happened; none is an interruption, and an assertive live
            region would talk over an operator mid-task on every refresh.
          */}
          <p role="status" style={{ margin: 0 }}>
            <strong style={{ fontWeight: 600 }}>
              {READ_STATE_LABEL[state]}
            </strong>
            {message ? ` — ${message}` : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** The operator's word for each state. Not the enum, which is ours. */
export const READ_STATE_LABEL: Record<MetaReadState, string> = {
  loading: "Loading",
  "refreshing-with-stale": "Updating",
  success: "Ready",
  "empty-proven": "Nothing to show",
  partial: "Some data unavailable",
  degraded: "Unavailable",
  refused: "Unavailable",
};
