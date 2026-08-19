import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import {
  describeLaunchpadHandoffRefusal,
  mintLaunchpadHandoff,
} from "@/lib/meta/launchpad-handoff";
import { readServedMetaDecision } from "@/lib/meta/launchpad-handoff-decision-source";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { isReviewerEmail } from "@/lib/reviewer-access";

export const dynamic = "force-dynamic";

/**
 * Mints a server-persisted Decisions -> Launchpad handoff.
 *
 * The request body NAMES a decision. It does not describe one. Everything the
 * handoff asserts — the authorized action, the eligibility, the lineage, the
 * campaign/ad set/creative selection and the evidence window — is read back off
 * the canonical read model on this side of the wire, because a body a client
 * wrote is exactly as trustworthy as the query string this replaces. A caller
 * who edits `decisionId` gets a different server-read decision or a 404; a
 * caller who invents authority fields gets them ignored, because none are read.
 *
 * This endpoint performs NO provider write. It issues at most one provider
 * GET (the current active-ad inventory) so the decision is authorized against
 * the same current-status truth the Decisions surface was showing.
 */

interface HandoffRequestBody {
  businessId?: unknown;
  providerAccountId?: unknown;
  decisionId?: unknown;
  sourceSnapshotId?: unknown;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function POST(request: NextRequest) {
  let body: HandoffRequestBody;
  try {
    body = (await request.json()) as HandoffRequestBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "A JSON body is required." },
      { status: 400 },
    );
  }

  const businessId = readString(body.businessId);
  const providerAccountId = readString(body.providerAccountId);
  const decisionId = readString(body.decisionId);
  const sourceSnapshotId = readString(body.sourceSnapshotId);
  if (!businessId || !providerAccountId || !decisionId || !sourceSnapshotId) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message:
          "businessId, providerAccountId, decisionId and sourceSnapshotId are required.",
      },
      { status: 400 },
    );
  }

  // Collaborator, not guest: a handoff is the opening move of a write.
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  if (isReviewerEmail(access.session.user.email)) {
    return NextResponse.json(
      {
        error: "reviewer_read_only",
        message:
          "Reviewer access is read-only, so no launch handoff can be created.",
      },
      { status: 403 },
    );
  }

  // Same assignment gate the workspace read applies. A URL-supplied account is
  // never authority; it is a request that has to survive this check.
  let assignments: Awaited<ReturnType<typeof getProviderAccountAssignments>>;
  try {
    assignments = await getProviderAccountAssignments(businessId, "meta");
  } catch {
    return NextResponse.json(
      {
        error: "provider_account_scope_unverified",
        message:
          "The provider-account assignment source is unavailable, so no handoff was created.",
      },
      { status: 503 },
    );
  }
  if (!assignments?.account_ids.includes(providerAccountId)) {
    return NextResponse.json(
      {
        error: "provider_account_not_assigned",
        message: "The requested Meta account is not assigned to this business.",
      },
      { status: 403 },
    );
  }

  const served = await readServedMetaDecision({
    businessId,
    providerAccountId,
    decisionId,
    sourceSnapshotId,
  });
  if (served.status === "source_unavailable") {
    return NextResponse.json(
      { error: "decision_source_unavailable", message: served.message },
      { status: 503 },
    );
  }
  if (served.status === "not_served") {
    return NextResponse.json(
      {
        error: "decision_not_served",
        message:
          "That decision is not in the current served universe for this account.",
      },
      { status: 404 },
    );
  }
  const decision = served.decision;

  const minted = await mintLaunchpadHandoff({
    businessId,
    providerAccountId,
    decision,
    createdByUserId: access.session.user.id,
  });
  if (!minted.ok) {
    return NextResponse.json(
      {
        error: minted.refusal,
        message: describeLaunchpadHandoffRefusal(minted.refusal),
      },
      { status: minted.refusal === "persist_failed" ? 503 : 409 },
    );
  }

  return NextResponse.json({
    handoff: minted.reference,
    mode: minted.envelope.mode,
    authorizedAction: minted.envelope.authorizedAction,
    expiresAt: minted.envelope.expiresAt,
    // Evidence, echoed so the caller can render honestly. Not permission.
    exactAdExecutionEligible: minted.envelope.exactAdExecutionEligible,
  });
}
