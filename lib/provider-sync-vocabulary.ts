/**
 * Shared vocabulary for provider sync freshness labels.
 *
 * Every surface that reports provider freshness shares one rule: an unknown,
 * unavailable, never-completed, or failed sync must not be described with the
 * affirmative verb "Synced". Saying "Synced —" tells the operator the sync
 * happened and only its age is missing, which is a different claim from the
 * one the evidence supports.
 *
 * This is the same class of defect the decision log already ruled on:
 *
 * - D064 requires absent currency evidence to say "account currency" rather
 *   than guess a unit, and calls that presentation determinism, not a decision
 *   change.
 * - D070 records a failed read collapsing into "no data" as behaviour
 *   INVARIANTS forbids.
 * - INVARIANTS: "Optional Meta event metrics remain null when no source
 *   payload key was observed. Source absence must not be converted to a
 *   measured zero."
 *
 * The contract that governs which read state each surface serves lives in
 * `docs/creative-decision-center/EXPERIENCE_STATE_CONTRACT.md`, which binds
 * these labels to the master plan's §9 read-state machine.
 *
 * Changing this constant changes copy only. It carries no tone, no decision
 * authority, and no write eligibility.
 */
export const SYNC_AGE_UNKNOWN_LABEL = "Sync age unknown";

/**
 * True when a sync label asserts no observed sync age.
 *
 * Surfaces that derive a tone from label text must treat this exactly as they
 * treated the previous em-dash form: neutral, never positive.
 */
export function isUnknownSyncAgeLabel(label: string | null | undefined): boolean {
  const value = (label ?? "").trim();
  if (value.length === 0) return true;
  if (value === SYNC_AGE_UNKNOWN_LABEL) return true;
  return value.includes("—");
}
