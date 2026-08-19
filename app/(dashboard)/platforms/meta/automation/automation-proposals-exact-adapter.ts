/**
 * Pure mapping from served proposals to the design's confirmation-queue rows.
 *
 * No I/O, no clock of its own — `now` is passed in so the expiry label is
 * deterministic in tests and identical on both sides of a render. Any fact the
 * proposal does not carry becomes the em-dash the exact shell already renders;
 * nothing here composes a value out of two half-known ones.
 */
import type {
  MetaAutomationProposal,
  MetaAutomationProposalHoldCounts,
} from "@/lib/meta/automation-proposals";

/** `—` in the design's own geometry. */
export const UNKNOWN = "—";

/**
 * Row tone.
 *
 * The design colours the action tag and the primary button by whether the
 * action adds or removes spend: `C.pos` for the scale row, `C.neg` for the
 * pause row. Tone is derived from the action, never stored.
 */
export type ProposalRowTone = "positive" | "negative";

export interface AutomationProposalRow {
  id: string;
  action: string;
  tone: ProposalRowTone;
  entity: string;
  why: string;
  evidence: string;
  /** Rendered after the design's literal `expires ` prefix. */
  expires: string;
  primaryCaption: string;
}

export interface AutomationProposalsModel {
  /** `unavailable` keeps the count at `—` instead of claiming an empty queue. */
  readCompleteness: "complete" | "unavailable";
  count: string;
  rows: AutomationProposalRow[];
  /**
   * Rows this account is holding open without being approvable.
   *
   * `claimed` is being dispatched right now; `reconcile` has an unknown
   * provider outcome and, per the invariant, "stays pending ... reconciliation
   * required, and retry forbidden". Neither belongs in `rows` — an operator
   * cannot confirm either — and the server already counts both and sends them
   * beside the queue. The adapter used to DROP that field, so a queue holding a
   * live dispatch presented itself as `0`, which is the one answer this surface
   * must never give: it tells an operator nothing is outstanding while a
   * provider write is in flight.
   *
   * `null` means the hold count could not be read. Unknown, never zero.
   */
  holds: MetaAutomationProposalHoldCounts | null;
  /**
   * True only where the read proved BOTH that no proposal needs confirmation
   * and that nothing is being held. Anything less is `—`, not `0`.
   */
  provenEmpty: boolean;
}

export const EMPTY_AUTOMATION_PROPOSALS_MODEL: AutomationProposalsModel = {
  readCompleteness: "unavailable",
  count: UNKNOWN,
  rows: [],
  holds: null,
  provenEmpty: false,
};

function toneFor(action: MetaAutomationProposal["proposedAction"]): ProposalRowTone {
  return action === "pause" ? "negative" : "positive";
}

/**
 * `in 6h` / `in 45m` / `in 3d`, matching the design's own granularity.
 *
 * A proposal at or past its expiry is never in this collection — the queue read
 * filters it — so `expired` here would be unreachable copy. An unparseable
 * expiry renders the em-dash rather than a guess about how long is left.
 */
export function expiresLabel(input: { expiresAt: string; now: Date }): string {
  const expiry = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiry)) return UNKNOWN;
  const remainingMs = expiry - input.now.getTime();
  if (remainingMs <= 0) return UNKNOWN;
  const minutes = Math.floor(remainingMs / 60000);
  if (minutes < 60) return `in ${Math.max(minutes, 1)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

export function buildAutomationProposalsModel(input: {
  readCompleteness: "complete" | "unavailable";
  proposals: readonly MetaAutomationProposal[];
  /**
   * The server's `holds` envelope. `null` (or an absent field on a server that
   * does not send one) is UNKNOWN and therefore forbids a proven-empty queue,
   * exactly as an absent `readCompleteness` already does: a fact nobody
   * forwards may not read as "there is nothing there".
   */
  holds?: MetaAutomationProposalHoldCounts | null;
  now: Date;
}): AutomationProposalsModel {
  const holds = input.holds ?? null;
  if (input.readCompleteness !== "complete") {
    return { ...EMPTY_AUTOMATION_PROPOSALS_MODEL, holds };
  }
  const rows = input.proposals.map((proposal) => ({
    id: proposal.id,
    action: proposal.actionLabel.trim() || UNKNOWN,
    tone: toneFor(proposal.proposedAction),
    entity: proposal.entityLabel?.trim() || UNKNOWN,
    why: proposal.reason.trim() || UNKNOWN,
    evidence: proposal.evidenceLabel?.trim() || UNKNOWN,
    expires: expiresLabel({ expiresAt: proposal.expiresAt, now: input.now }),
    primaryCaption: proposal.primaryCaption.trim() || UNKNOWN,
  }));
  const nothingHeld = holds !== null && holds.claimed === 0 && holds.reconcile === 0;
  const provenEmpty = rows.length === 0 && nothingHeld;
  return {
    readCompleteness: "complete",
    // A non-empty queue counts its own approvable rows and always has; holds
    // are not "needs your confirmation" and are never added in. Only the EMPTY
    // case changes: `0` is a claim that nothing is outstanding, and it is
    // withheld while a claimed or reconcile row is holding a slot, or while the
    // hold count could not be read at all.
    count: rows.length > 0 ? String(rows.length) : provenEmpty ? "0" : UNKNOWN,
    rows,
    holds,
    provenEmpty,
  };
}
