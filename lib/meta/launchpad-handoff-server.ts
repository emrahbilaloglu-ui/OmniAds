/**
 * The Launchpad LANDING side of the handoff: re-verify, then prefill.
 *
 * `consumeLaunchpadHandoff` (lib/meta/launchpad-handoff.ts) answers "is this
 * reference real, unexpired, unused, and mine". That is necessary and it is not
 * sufficient. Between minting and landing the world can move in ways the record
 * cannot see:
 *
 *   - the operator can lose collaborator access, or the workspace can be
 *     flagged demo, in which case there is no launch to open at all;
 *   - the account can be unassigned from the business;
 *   - the engine can re-run and withdraw, hold or block the very decision that
 *     authorized the handoff.
 *
 * The first two are decided by the caller and passed in; the third is re-read
 * here against the canonical source and re-run through the SAME pure
 * authorization function the mint side used. Nothing is re-derived — if
 * `authorizeLaunchpadHandoff` refuses the decision now, the handoff opens
 * nothing now, whatever it said fifteen minutes ago.
 *
 * Ordering is deliberate. Write authority is checked BEFORE the token is
 * burned, because a reviewer following a forwarded link must not be able to
 * destroy the handoff of the operator who minted it.
 *
 * Nothing in this module performs a provider WRITE. The one provider call in
 * the path is the current active-ad GET inside
 * `lib/meta/launchpad-handoff-decision-source.ts`.
 */
import {
  buildLaunchpadHandoffPrefill,
  launchpadHandoffPrefillUnavailable,
  LAUNCHPAD_HANDOFF_PREFILL_NONE,
  type LaunchpadHandoffAnyRefusal,
  type LaunchpadHandoffEnvelope,
  type LaunchpadHandoffPrefillEnvelope,
} from "@/lib/meta/launchpad-handoff-contract";
import {
  authorizeLaunchpadHandoff,
  consumeLaunchpadHandoff,
  readConsumedLaunchpadHandoff,
} from "@/lib/meta/launchpad-handoff";
import { readServedMetaDecision } from "@/lib/meta/launchpad-handoff-decision-source";

export interface LandLaunchpadHandoffInput {
  reference: string | null | undefined;
  businessId: string;
  /** The account this request resolved, assignment-verified. Never a raw URL value. */
  providerAccountId: string | null;
  actorUserId: string | null;
  /**
   * The server's own role / reviewer / demo verdict for THIS request, already
   * computed by `buildLaunchpadViewerEnvelope`. Passed in rather than recomputed
   * so the landing route and the write routes cannot disagree about who may
   * prepare a launch.
   */
  canMutate: boolean;
  now?: Date;
  /** Seam for tests. Production always re-reads the canonical decision source. */
  readDecision?: typeof readServedMetaDecision;
}

export type LandLaunchpadHandoffResult =
  | { ok: true; envelope: LaunchpadHandoffEnvelope }
  | { ok: false; refusal: LaunchpadHandoffAnyRefusal };

export async function landLaunchpadHandoff(
  input: LandLaunchpadHandoffInput,
): Promise<LandLaunchpadHandoffResult> {
  // BEFORE the burn. A viewer with no write authority in this workspace has no
  // launch to prepare, and refusing here leaves the record intact for whoever
  // legitimately holds it.
  if (!input.canMutate) {
    return { ok: false, refusal: "write_authority_revoked" };
  }

  const consumed = await consumeLaunchpadHandoff({
    reference: input.reference,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    actorUserId: input.actorUserId,
    now: input.now,
  });
  if (!consumed.ok) return { ok: false, refusal: consumed.refusal };

  const envelope = consumed.envelope;
  // A copy handoff has no canonical decision to re-read: it never claimed one.
  // Its own integrity (no authorized action, no eligibility, no exact-Ad
  // execution) was already re-checked against its origin inside the consume.
  if (envelope.origin !== "decision" || !envelope.lineage) {
    return { ok: true, envelope };
  }

  const providerAccountId = input.providerAccountId;
  if (!providerAccountId) {
    return { ok: false, refusal: "provider_account_mismatch" };
  }

  const read = input.readDecision ?? readServedMetaDecision;
  const current = await read({
    businessId: input.businessId,
    providerAccountId,
    decisionId: envelope.lineage.sourceDecisionId,
    sourceSnapshotId: envelope.lineage.sourceSnapshotId,
  });
  if (current.status === "source_unavailable") {
    return { ok: false, refusal: "decision_source_unavailable" };
  }
  if (current.status === "not_served") {
    return { ok: false, refusal: "decision_not_served" };
  }

  // The SAME pure law the mint side ran, run again on today's decision. Held,
  // blocked, review-only, demo-synthetic and action-ineligible all refuse here
  // under their own names, so the receipt says which one moved.
  const reauthorized = authorizeLaunchpadHandoff({
    decision: current.decision,
    providerAccountId,
  });
  if (!reauthorized.ok) return { ok: false, refusal: reauthorized.refusal };

  // Same decision, different verdict. A handoff minted as a Duplicate must not
  // silently become a Rebuild because the engine changed its mind.
  if (
    reauthorized.authorization.mode !== envelope.mode ||
    reauthorized.authorization.authorizedAction !== envelope.authorizedAction
  ) {
    return { ok: false, refusal: "decision_authority_changed" };
  }

  return {
    ok: true,
    // The re-read wins on the fields it owns. Delivery scope and the parent
    // chain are CURRENT facts, not historical ones, so carrying the minted
    // copies forward would show the operator a hierarchy that has since moved.
    envelope: {
      ...envelope,
      exactAdExecutionEligible:
        reauthorized.authorization.exactAdExecutionEligible,
      lineage: reauthorized.authorization.lineage,
      selection: reauthorized.authorization.selection,
    },
  };
}

export interface ReadLaunchpadHandoffPrefillInput {
  handoffId: string | null | undefined;
  businessId: string;
  providerAccountId: string | null;
  actorUserId: string | null;
  now?: Date;
}

/**
 * The second hop: rebuild the prefill for a handoff that was already burned.
 *
 * Returns an ENVELOPE rather than throwing or silently returning nothing,
 * because the three outcomes are genuinely different and the operator has to be
 * able to tell them apart: no handoff was named, a handoff was named and could
 * not be honoured (say so), or a handoff was named and here is what it carries.
 * A wizard that opened blank on the middle case would read as success.
 */
export async function readLaunchpadHandoffPrefill(
  input: ReadLaunchpadHandoffPrefillInput,
): Promise<LaunchpadHandoffPrefillEnvelope> {
  const handoffId = input.handoffId?.trim() ?? "";
  if (!handoffId) return LAUNCHPAD_HANDOFF_PREFILL_NONE;

  const read = await readConsumedLaunchpadHandoff({
    handoffId,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    actorUserId: input.actorUserId,
    now: input.now,
  });
  if (!read.ok) return launchpadHandoffPrefillUnavailable(read.refusal);
  return { status: "prefilled", prefill: buildLaunchpadHandoffPrefill(read.envelope) };
}
