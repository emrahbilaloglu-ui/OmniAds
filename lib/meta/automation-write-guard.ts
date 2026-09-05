import { NextResponse } from "next/server";
import {
  getMetaWriteBlockState,
  type MetaWriteBlockState,
} from "@/lib/meta/automation-control-plane";

/**
 * The one server-side posture every Meta write family reads.
 *
 * Two facts come back, and conflating them was the defect. A BLOCK means
 * nothing may be sent. REHEARSAL means something is sent for real to the
 * read-back and the journal, but never to a mutation — the operator gets a
 * receipt saying exactly what would have been written.
 *
 * Before this, only the block half existed, and rehearsal lived entirely in the
 * request body: every entity and ad route computed `dryRun` from
 * `body.dryRun` alone. A request that simply omitted the field escaped a
 * business's persisted rehearsal guardrail and reached a provider POST. The
 * client can still ASK for a dry run; it can no longer decline one.
 */
export interface MetaWritePosture {
  blocked: boolean;
  /** Server-decided. OR this with any client request; never replace it. */
  rehearsal: boolean;
  reason: MetaWriteBlockState["reason"];
  message: string | null;
}

export async function readMetaWritePosture(input: {
  businessId: string;
  at?: Date;
}): Promise<MetaWritePosture> {
  const block = await getMetaWriteBlockState({
    businessId: input.businessId,
    at: input.at,
  }).catch(() => null);
  // An unreadable posture is a blocked, rehearsing one. "We could not check"
  // and "it is fine" are different answers and only one may reach a provider.
  if (!block) {
    return {
      blocked: true,
      rehearsal: true,
      reason: "control_state_unavailable",
      message:
        "Meta writes are blocked because the automation posture could not be read.",
    };
  }
  return {
    blocked: block.blocked,
    rehearsal: block.rehearsal,
    reason: block.reason,
    message: block.message,
  };
}

/**
 * Whether this request must stop before Meta.
 *
 * The client's flag can only ADD. A route that passed `body.dryRun` straight
 * through was letting the request decide something the business had already
 * decided.
 */
export function metaWriteIsRehearsal(input: {
  posture: Pick<MetaWritePosture, "rehearsal">;
  requestedDryRun: boolean;
}): boolean {
  return input.posture.rehearsal || input.requestedDryRun === true;
}

/** The refusal every write family answers with, unchanged in shape. */
export function metaWriteBlockedResponse(posture: MetaWritePosture): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "kill_switch_engaged",
        message: posture.message ?? "Meta writes are disabled by kill switch.",
        reason: posture.reason,
      },
    },
    { status: 503 },
  );
}

export async function rejectIfMetaWritesBlocked(input: {
  businessId: string;
}): Promise<NextResponse | null> {
  const posture = await readMetaWritePosture({ businessId: input.businessId });
  if (!posture.blocked) return null;
  return metaWriteBlockedResponse(posture);
}
