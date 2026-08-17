/**
 * Pure mapping from served proposals to the design's confirmation-queue rows.
 *
 * No I/O, no clock of its own — `now` is passed in so the expiry label is
 * deterministic in tests and identical on both sides of a render. Any fact the
 * proposal does not carry becomes the em-dash the exact shell already renders;
 * nothing here composes a value out of two half-known ones.
 */
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";

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
}

export const EMPTY_AUTOMATION_PROPOSALS_MODEL: AutomationProposalsModel = {
  readCompleteness: "unavailable",
  count: UNKNOWN,
  rows: [],
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
  now: Date;
}): AutomationProposalsModel {
  if (input.readCompleteness !== "complete") {
    return EMPTY_AUTOMATION_PROPOSALS_MODEL;
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
  return {
    readCompleteness: "complete",
    count: String(rows.length),
    rows,
  };
}
