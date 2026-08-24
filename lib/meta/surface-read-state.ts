/**
 * The one place a Meta surface's §9 read state is decided.
 *
 * `read-state-contract.ts` gave the branch a vocabulary — seven read states, a
 * closed failure dictionary, and an envelope shape. Nothing decided a state
 * with it and nothing rendered one, so every mounted surface still worked out
 * its own readiness inline, in its own words, and the three distinctions §9
 * exists to protect were collapsed on all six of them:
 *
 * - `empty-proven` against `degraded`. Both show no rows. One means "there is
 *   nothing here", the other "we do not know what is here".
 * - `partial` against `success`. Some sources answered and some did not, and
 *   presenting the subset as the whole is how a total silently becomes wrong.
 * - `refused` against everything else. A surface that was never scoped is not
 *   a surface that is empty.
 *
 * ## Server-owned, and singular
 *
 * `resolveMetaSurfaceReadState` is a pure function over facts the server
 * already holds. It is called in two places and nowhere else:
 *
 * 1. the canonical page, before any data exists — scope, permissions,
 *    capability. That envelope is `loading` at worst and `refused` at best,
 *    and it is correct without waiting for a fetch;
 * 2. the API route that serves the surface's payload, which adds what only it
 *    knows: which sources answered, and how many rows came back.
 *
 * The client picks between the two with `laterMetaSurfaceState`, which is also
 * here and also pure. No component computes a state, and there is no second
 * readiness authority: the decision core still owns verdicts, this owns only
 * whether the screen may be believed.
 *
 * ## What it will not do
 *
 * It never turns a missing source into a zero, never reports `success` for a
 * read that did not happen, and never invents a message. A failure code it does
 * not recognise resolves to `degraded` with no sentence rather than to a
 * reassuring default, because a known-looking unknown is the exact defect D8
 * names.
 */
import {
  META_FAILURES,
  isMetaFailureCode,
  type MetaFailureCode,
  type MetaReadState,
  type MetaResponseEnvelope,
} from "@/lib/meta/read-state-contract";
import type { ProviderScopeRefusal } from "@/lib/zero-base/provider-scope-server";

/** How one source behind a surface answered. */
export type MetaSourceOutcome =
  /** Answered, with rows. */
  | "served"
  /** Answered, and there were genuinely none. */
  | "empty"
  /**
   * Answered, but not wholly — a cap was applied, or one of its own inputs was
   * missing. Distinct from `served` because a subset presented as a whole is
   * the §9 collapse this contract exists to stop, and distinct from `failed`
   * because what it did return is real and readable.
   */
  | "partial"
  /** Did not answer. `failureCode` says why. */
  | "failed"
  /** Cannot answer yet — schema, capability or migration. `failureCode` says. */
  | "not-ready";

export interface MetaSurfaceSource {
  /** Stable id, so a partial state can name what is missing. */
  readonly id: string;
  readonly outcome: MetaSourceOutcome;
  /** Rows this source contributed. Only meaningful for `served`. */
  readonly rowCount?: number;
  /** Required for `failed` and `not-ready`; ignored otherwise. */
  readonly failureCode?: MetaFailureCode;
}

export interface MetaSurfaceEvidence {
  sourceUpdatedAt?: string | null;
  snapshotAt?: string | null;
  observedAt?: string | null;
  freshness?: "fresh" | "stale" | "unknown";
  window?: { startDate: string; endDate: string } | null;
  decisionAsOf?: string | null;
}

export interface MetaSurfaceReadStateInput {
  businessId: string;
  /** Resolved scope, or null with a refusal. */
  providerAccountId: string | null;
  /**
   * Why no account resolved. Null when one did, or when the surface is not
   * account-scoped.
   */
  scopeRefusal?: ProviderScopeRefusal | null;
  /**
   * D6. `single_physical` surfaces serve nothing without one physical account;
   * `business_scope`, `assignment` and `token_public` surfaces do not need one.
   */
  requiresProviderAccount: boolean;
  permissions: {
    role: string | null;
    reviewerReadOnly: boolean;
    demo: boolean;
  };
  capability: {
    canRead: boolean;
    canWrite: boolean;
    /** Why reading is impossible. Required when `canRead` is false. */
    readBlockedBy?: MetaFailureCode;
  };
  /**
   * Undefined means "no data read has happened yet" and yields `loading`.
   * An empty array means "this surface reads nothing", which is `success`.
   */
  sources?: readonly MetaSurfaceSource[];
  evidence?: MetaSurfaceEvidence;
  /** Old rows are still on screen while a new read runs. §9's fourth state. */
  refreshing?: boolean;
}

/**
 * Scope refusals, mapped onto the §9.1 dictionary.
 *
 * `provider_account_none_assigned` has no code of its own: the operator-facing
 * fact is the same one `provider_account_not_assigned` states — this workspace
 * has no account that could answer — and inventing a twenty-third code to say
 * it a second way would put two sentences in the product for one situation.
 */
const SCOPE_REFUSAL_CODE: Record<ProviderScopeRefusal, MetaFailureCode> = {
  provider_account_none_assigned: "provider_account_not_assigned",
  account_required: "account_required",
  provider_account_not_assigned: "provider_account_not_assigned",
};

function failure(code: MetaFailureCode): { code: MetaFailureCode; message: string } {
  return { code, message: META_FAILURES[code].message };
}

/**
 * Decide the surface's state.
 *
 * Ordered most-specific first, so the reason an operator is given is the one
 * they can act on. A refusal outranks a degraded read because "you have not
 * chosen an account" is more useful than "a source failed" when both are true —
 * the source was never asked.
 */
export function resolveMetaSurfaceReadState(
  input: MetaSurfaceReadStateInput,
): MetaResponseEnvelope<null> {
  const scope = {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  };
  const evidence: MetaResponseEnvelope<null>["evidence"] = {
    sourceUpdatedAt: input.evidence?.sourceUpdatedAt ?? null,
    snapshotAt: input.evidence?.snapshotAt ?? null,
    observedAt: input.evidence?.observedAt ?? null,
    freshness: input.evidence?.freshness ?? "unknown",
    window: input.evidence?.window ?? null,
    decisionAsOf: input.evidence?.decisionAsOf ?? null,
  };
  const permissions = { ...input.permissions };
  const capability = { canRead: input.capability.canRead, canWrite: input.capability.canWrite };

  const envelope = (
    state: MetaReadState,
    code: MetaFailureCode | null,
  ): MetaResponseEnvelope<null> => ({
    scope,
    evidence,
    data: null,
    capability,
    permissions,
    failure: code ? failure(code) : null,
    state,
  });

  // 1. Reading is impossible. Not empty, not zero — unavailable.
  if (!input.capability.canRead) {
    const code = input.capability.readBlockedBy;
    return envelope("degraded", isMetaFailureCode(code) ? code : "schema_not_ready");
  }

  // 2. Never scoped. D6: an account-scoped surface serves nothing without one
  //    physical account, and `null` is never "all accounts".
  if (input.requiresProviderAccount && input.providerAccountId === null) {
    const refusal = input.scopeRefusal ?? "provider_account_none_assigned";
    return envelope("refused", SCOPE_REFUSAL_CODE[refusal]);
  }

  // 3. No read has been attempted yet. A skeleton, never an empty list.
  if (input.sources === undefined) return envelope("loading", null);

  const failed = input.sources.filter(
    (source) => source.outcome === "failed" || source.outcome === "not-ready",
  );
  const answered = input.sources.filter(
    (source) =>
      source.outcome === "served" ||
      source.outcome === "empty" ||
      source.outcome === "partial",
  );

  // 4. Nothing answered and something failed: the screen is unknown, not empty.
  if (answered.length === 0 && failed.length > 0) {
    const code = failed.find((source) => isMetaFailureCode(source.failureCode))?.failureCode;
    return envelope("degraded", isMetaFailureCode(code) ? code : "source_read_failed");
  }

  // 5. Some answered and some did not, or one answered incompletely. Either
  //    way the subset is not the whole and must not read as one.
  if (failed.length > 0 || input.sources.some((source) => source.outcome === "partial")) {
    return envelope("partial", "source_read_failed");
  }

  // 6. Old rows still on screen while a new read runs. Not a first load.
  if (input.refreshing) return envelope("refreshing-with-stale", null);

  // 7. Everything answered. Zero rows here is a fact, not an absence.
  const rows = answered.reduce((sum, source) => sum + (source.rowCount ?? 0), 0);
  if (input.sources.length > 0 && rows === 0) return envelope("empty-proven", null);

  return envelope("success", null);
}

/**
 * Which of two envelopes the screen should show.
 *
 * The page resolves one before any data exists and the API route resolves
 * another once it has read. The client must not choose between them by
 * inspecting their contents — that is exactly the inline readiness logic this
 * module replaces — so the rule is here, it is total, and it is tested.
 *
 * The served envelope wins whenever it exists, EXCEPT where the page's envelope
 * is a refusal. A refusal is a fact about authority, and a payload that
 * answered anyway does not overturn it: if the page says this workspace never
 * chose an account, a list of rows on screen would be a list from somewhere.
 */
export function laterMetaSurfaceState(
  fromPage: MetaResponseEnvelope<null> | null | undefined,
  fromPayload: MetaResponseEnvelope<null> | null | undefined,
  /**
   * A newer read is in flight while these rows are still on screen.
   *
   * The one fact only the client holds: it owns the request. It is an
   * OBSERVATION, not a state — what it means is decided here, so a body cannot
   * decide for itself that stale rows are fine to present unlabelled. §9's
   * fourth state exists because blanking readable evidence to show a spinner
   * throws away what the operator was reading, and leaving it unlabelled
   * presents old figures as current ones.
   */
  refreshing?: boolean,
): MetaResponseEnvelope<null> | null {
  if (fromPage?.state === "refused") return fromPage;
  const chosen = fromPayload ?? fromPage ?? null;
  if (!chosen || !refreshing) return chosen;
  // Only a state that HAS rows can be stale. A refresh over a refusal, a
  // degraded read or a first load is still that thing.
  if (!["success", "empty-proven", "partial"].includes(chosen.state)) return chosen;
  return { ...chosen, state: "refreshing-with-stale" };
}

/**
 * States in which the surface must not present its data as answerable.
 *
 * Exported so a body can hold a control closed without deciding for itself
 * what "not ready" means.
 */
export const META_UNSERVED_STATES: readonly MetaReadState[] = [
  "loading",
  "degraded",
  "refused",
] as const;

export function isMetaSurfaceServed(state: MetaReadState): boolean {
  return !META_UNSERVED_STATES.includes(state);
}
