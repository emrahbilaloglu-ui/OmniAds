/**
 * The one decision about whether a Meta sync unit may persist CURRENT evidence.
 *
 * Campaign, adset and ad config endpoints return the account's current
 * inventory. They are not day-scoped. Writing that inventory under a historical
 * date fabricates history and amplifies storage by the whole size of the
 * backfill wave — 761 days per account in the incident, against three config
 * surfaces plus entity observation runs and states.
 *
 * Three distinct writers depend on this decision and previously each decided
 * for themselves, which is how the same run could refuse to write a config
 * snapshot while still appending config history and a fresh entity observation
 * run for the same historical day:
 *
 *  - config snapshots / current config history rows
 *  - entity observation runs and states (`meta_entity_state_history`)
 *
 * They now share this single function. A historical, finalized, backfill,
 * repair or replay day may still USE the fetched inventory in memory to enrich
 * its metric facts; it may not record it as evidence of anything.
 */

/**
 * Mirrors MetaWarehouseTruthState. Written as its own union so a new truth
 * state cannot silently start persisting current evidence: adding one here is
 * a decision, and omitting it is a compile error at the call site.
 */
export type MetaEvidenceTruthState =
  | "provisional"
  | "finalized"
  | "repair_pending"
  | "repair_failed";

export type MetaCurrentEvidenceReason =
  /** The account's own local today, declared provisional: real current evidence. */
  | "current_provisional_day"
  /** A day other than the account's local today. */
  | "historical_day"
  /**
   * The account's local today, but the caller declared it finalized, repairing
   * or repair-failed — a replay or repair of today. The inventory fetched now
   * does not describe the state those facts were produced from.
   */
  | "non_provisional_replay_of_today";

export interface MetaCurrentEvidenceDecision {
  /** Config snapshots and current config history rows. */
  persistsCurrentConfigEvidence: boolean;
  /** Entity observation runs and states. */
  persistsEntityObservations: boolean;
  reason: MetaCurrentEvidenceReason;
}

/**
 * Evidence is only current when this run is the account's own local today AND
 * the caller declared it provisional.
 *
 * This inverts the pre-incident gate, which was `truthState === "finalized"`
 * and therefore fired ONLY on historical days — stamping today's inventory onto
 * every backfilled date.
 */
export function decideMetaCurrentEvidence(input: {
  truthState: MetaEvidenceTruthState;
  normalizedDay: string;
  accountToday: string;
}): MetaCurrentEvidenceDecision {
  const isAccountToday = input.normalizedDay === input.accountToday;
  const reason: MetaCurrentEvidenceReason = !isAccountToday
    ? "historical_day"
    : input.truthState === "provisional"
      ? "current_provisional_day"
      : "non_provisional_replay_of_today";
  const persists = reason === "current_provisional_day";
  // Deliberately one boolean behind two names. They are named separately
  // because two different writers consume them and a future divergence must be
  // an explicit edit here, not an accident at a call site.
  //
  // A third, `appendConfigHistory`, is gone: the daily writers no longer author
  // config history at all. Two authors with two notions of the same
  // configuration is what filled that table with changes nobody made.
  return {
    persistsCurrentConfigEvidence: persists,
    persistsEntityObservations: persists,
    reason,
  };
}
