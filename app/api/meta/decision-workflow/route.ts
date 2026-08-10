import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  applyWorkflowTransition,
  newWorkflowRecord,
  type WorkflowAction,
} from "@/lib/decision-workflow";
import {
  persistWorkflowTransition,
  readWorkflowRecord,
} from "@/lib/decision-workflow-store";

export const dynamic = "force-dynamic";

const ACTIONS: WorkflowAction[] = [
  "assign",
  "acknowledge",
  "defer",
  "snooze",
  "reject",
  "resolve",
  "reopen",
  "comment",
];

/** Read who owns a decision and what has been done about it. */
export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const decisionKey = request.nextUrl.searchParams.get("decisionKey");
  if (!businessId || !decisionKey) {
    return NextResponse.json(
      { error: "missing_parameters", message: "businessId and decisionKey are required." },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  const record = await readWorkflowRecord({ businessId, decisionKey });
  return NextResponse.json({
    workflow: record ?? newWorkflowRecord({ businessId, decisionKey }),
    // An absent overlay is reported, not silently rendered as "nobody owns this".
    available: record !== null,
  });
}

/**
 * Apply a workflow transition.
 *
 * This changes who owns a decision and what they have said about it. It cannot
 * change the decision itself: no field here reaches a label, an authority, or
 * provider eligibility, and the engine never reads this table.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    businessId?: string;
    decisionKey?: string;
    action?: string;
    expectedVersion?: number;
    entityType?: string;
    entityId?: string;
    providerAccountId?: string | null;
    assigneeUserId?: string | null;
    dueAt?: string | null;
    snoozeUntil?: string | null;
    reasonCode?: string | null;
    comment?: string | null;
  } | null;

  const businessId = body?.businessId;
  const decisionKey = body?.decisionKey;
  const action = body?.action as WorkflowAction | undefined;

  if (!businessId || !decisionKey || !action || !ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: "invalid_request", message: "businessId, decisionKey and a known action are required." },
      { status: 400 },
    );
  }
  if (typeof body?.expectedVersion !== "number") {
    return NextResponse.json(
      {
        error: "missing_expected_version",
        message: "expectedVersion is required so a stale edit cannot overwrite a newer one.",
      },
      { status: 400 },
    );
  }

  // Changing ownership is a write; a viewer may read the overlay but not move it.
  const access = await requireBusinessAccess({ request, businessId, minRole: "collaborator" });
  if ("error" in access) return access.error;

  const current =
    (await readWorkflowRecord({ businessId, decisionKey })) ??
    newWorkflowRecord({ businessId, decisionKey });

  const outcome = applyWorkflowTransition({
    current,
    action,
    actorUserId: access.session.user.id,
    expectedVersion: body.expectedVersion,
    assigneeUserId: body.assigneeUserId,
    dueAt: body.dueAt,
    snoozeUntil: body.snoozeUntil,
    reasonCode: body.reasonCode,
    comment: body.comment,
  });

  if (!outcome.ok) {
    const status = outcome.reason === "version_conflict" ? 409 : 422;
    return NextResponse.json(
      { error: outcome.reason, message: outcome.message, current },
      { status },
    );
  }

  const persisted = await persistWorkflowTransition({
    next: outcome.next,
    expectedVersion: body.expectedVersion,
    entityType: body.entityType ?? "creative",
    entityId: body.entityId ?? decisionKey,
    providerAccountId: body.providerAccountId ?? null,
    event: outcome.event,
  });

  if (!persisted.ok) {
    // A transition that could not be recorded is not a transition. Reporting
    // success here would leave the operator believing work was assigned.
    const status = persisted.reason === "version_conflict" ? 409 : 503;
    return NextResponse.json(
      {
        error: persisted.reason,
        message:
          persisted.reason === "version_conflict"
            ? "This decision changed while you were looking at it. Reload to see the current state."
            : "The workflow overlay is unavailable, so nothing was recorded.",
        current,
      },
      { status },
    );
  }

  await recordProductInstrumentationEvent({

    businessId,

    scope: "business",

    eventName: "decision_workflow_changed",

    surface: "meta_decision_inspector",

    outcome: "ok",

    occurredAt: new Date().toISOString(),

  });


  return NextResponse.json({ workflow: outcome.next, event: outcome.event });
}
