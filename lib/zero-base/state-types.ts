/**
 * The state grammar.
 *
 * Four states look superficially similar and mean completely different things,
 * and conflating them is how a surface ends up rendering `0` for "we don't
 * know". They are separate members of one union so a component cannot render a
 * value without having said which kind of truth it is:
 *
 * - `unavailable` — the data is not served at this grain. Never 0, never a
 *   skeleton, never an empty chart.
 * - `withheld` — we have the data but showing it would be unsafe or
 *   misleading (mixing currencies, say). Distinct from unavailable because the
 *   fix is different.
 * - `disabled` — a control exists but cannot be used yet, and the reason is
 *   always rendered inline rather than hidden in a tooltip.
 * - `empty` — the query genuinely returned nothing. This is the only one that
 *   means "zero".
 *
 * Every one of them carries a human reason. A state without a reason is a
 * shrug, and the point of the grammar is that the product never shrugs.
 */

export type SurfaceStateKind =
  | "ready"
  | "loading"
  | "empty"
  | "unavailable"
  | "withheld"
  | "error";

export interface SurfaceStateBase {
  /** Sentence a buyer can act on. Required — never a bare status word. */
  readonly reason: string;
  /** Contract/capability id, so a reader can trace the rule. */
  readonly code?: string;
}

export type SurfaceState =
  | { kind: "ready" }
  | { kind: "loading"; label?: string }
  | ({ kind: "empty" } & SurfaceStateBase)
  | ({ kind: "unavailable" } & SurfaceStateBase)
  | ({ kind: "withheld" } & SurfaceStateBase & {
      /** What would unlock it. Withheld is never permanent by default. */
      readonly unlock?: string;
    })
  | ({ kind: "error" } & SurfaceStateBase & {
      /** Verbatim server text. Never paraphrased into reassurance. */
      readonly verbatim?: string;
      readonly retry?: boolean;
    });

/** A control's availability, with the reason attached to the refusal itself. */
export type ControlState =
  | { kind: "enabled" }
  | { kind: "disabled"; reason: string; code?: string }
  | { kind: "busy"; label?: string };

/**
 * A displayed number. `unavailable` is a first-class member so a missing
 * metric cannot be rendered as zero by accident.
 */
export type MetricValue =
  | {
      state: "available";
      value: number;
      unit: "count" | "percent" | "currency" | "ratio";
      currency: string | null;
      /** False when the currency is configured but never observed. */
      currencyProven: boolean;
      sourceAsOf: string | null;
    }
  | { state: "unavailable"; reason: string };

export type TrendDirection = "up" | "down" | "flat" | "unknown";
/** Owned by the read model, never by the card: rising spend is not "good". */
export type TrendSentiment = "positive" | "negative" | "neutral" | "unknown";

export interface TrendPresentation {
  comparison: MetricValue;
  direction: TrendDirection;
  sentiment: TrendSentiment;
  label: string;
}

/** Common envelope for every collection a canonical view renders. */
export interface CollectionEnvelope<T> {
  items: T[];
  servedCount: number;
  totalCount: number | null;
  cap: number | null;
  nextCursor: string | null;
  truncated: boolean;
  disclosure: string | null;
}

export const SURFACE_STATE_KINDS: readonly SurfaceStateKind[] = [
  "ready",
  "loading",
  "empty",
  "unavailable",
  "withheld",
  "error",
];

/** Non-ready, non-loading states must explain themselves. */
export function surfaceStateReason(state: SurfaceState): string | null {
  return "reason" in state ? state.reason : null;
}

export function isBlockingState(state: SurfaceState): boolean {
  return state.kind !== "ready";
}

/**
 * X-of-Y disclosure text. Returns null when nothing was withheld, so callers
 * cannot render a reassuring "showing all" line that isn't true.
 */
export function truncationDisclosure(envelope: {
  servedCount: number;
  totalCount: number | null;
  cap: number | null;
  truncated: boolean;
}): string | null {
  if (!envelope.truncated) return null;
  if (envelope.totalCount === null) {
    return `Showing ${envelope.servedCount}. More exist than can be counted here.`;
  }
  return `Showing ${envelope.servedCount} of ${envelope.totalCount}.`;
}
