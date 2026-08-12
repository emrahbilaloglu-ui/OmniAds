import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";
import { NextRequest, NextResponse } from "next/server";
import { findMembership, requireBusinessAccess } from "@/lib/access";
import {
  applyWorkflowTransition,
  newWorkflowRecord,
  type WorkflowAction,
} from "@/lib/decision-workflow";
import {
  persistWorkflowTransition,
  readWorkflowEvents,
  readWorkflowRecord,
  readWorkflowRecords,
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

/** Most decision keys one canonical page may ask about in a single read. */
const ZERO_BASE_MAX_KEYS = 200;

/** Read who owns a decision and what has been done about it. */
export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const decisionKey = request.nextUrl.searchParams.get("decisionKey");

  // Canonical callers opt in explicitly. This is a mode on the one workflow
  // route, not a second route: the overlay must have exactly one authority, and
  // a per-row GET across a served collection would be an N+1 that grows with
  // the page.
  const zeroBase = request.nextUrl.searchParams.get("contract") === "zero-base.v1";
  if (zeroBase) {
    const rawKeys = request.nextUrl.searchParams.get("decisionKeys") ?? "";
    const decisionKeys = [
      ...new Set(
        rawKeys
          .split(",")
          .map((key) => key.trim())
          .filter((key) => key.length > 0),
      ),
    ];
    if (!businessId) {
      return NextResponse.json(
        { error: "missing_parameters", message: "businessId is required." },
        { status: 400 },
      );
    }
    // Bounded rather than truncated: a caller that silently lost keys would
    // render "nobody owns this" for decisions somebody does own.
    if (decisionKeys.length > ZERO_BASE_MAX_KEYS) {
      return NextResponse.json(
        {
          error: "too_many_keys",
          message: `Ask for at most ${ZERO_BASE_MAX_KEYS} decision keys per read.`,
          limit: ZERO_BASE_MAX_KEYS,
        },
        { status: 400 },
      );
    }

    const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
    if ("error" in access) return access.error;

    const records = await readWorkflowRecords({ businessId, decisionKeys });
    // A decision with no row is open, not missing — the same rule the single
    // read already applies, stated once for the whole batch.
    const workflows = decisionKeys.map(
      (key) => records.get(key) ?? newWorkflowRecord({ businessId, decisionKey: key }),
    );

    // Events only for the one decision the operator has open. Fetching the
    // journal for every row would be the N+1 this mode exists to avoid.
    const events =
      decisionKey && decisionKeys.includes(decisionKey)
        ? await readWorkflowEvents({ businessId, decisionKey })
        : [];

    return NextResponse.json({
      contract: "zero-base.v1",
      workflows,
      persistedKeys: [...records.keys()],
      events,
      eventsFor: decisionKey && decisionKeys.includes(decisionKey) ? decisionKey : null,
      viewer: { userId: access.session.user.id, role: access.membership.role },
    });
  }

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
    mutationId?: string | null;
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

  // An assignee must be an active member of THIS business. Without the check
  // work can be assigned to somebody who cannot open it — or to a user id
  // belonging to another tenant, which also confirms that id exists.
  if (body.assigneeUserId) {
    const membership = await findMembership({
      userId: body.assigneeUserId,
      businessId,
    }).catch(() => null);
    if (!membership || membership.status !== "active") {
      return NextResponse.json(
        {
          error: "invalid_assignee",
          message: "Assign work only to an active member of this business.",
        },
        { status: 422 },
      );
    }
  }

  const mutationId =
    typeof body.mutationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      body.mutationId,
    )
      ? body.mutationId
      : null;

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
    mutationId,
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


  // A replayed mutation reports the state it already produced rather than
  // pretending a second transition happened.
  return NextResponse.json({
    workflow: outcome.next,
    event: outcome.event,
    replayed: persisted.ok && persisted.replayed === true,
  });
}
