import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";
import { NextRequest, NextResponse } from "next/server";
import { DECISION_WORKFLOW_KEY_CAP } from "@/lib/meta/decision-workflow-limits";
import { findMembership, requireBusinessAccess } from "@/lib/access";
import { rejectIfMetaGateClosed } from "@/lib/meta/release-gate-guard";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { rejectIfMetaOperatorDemoWrite } from "@/app/api/meta/demo-write-authority";
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
// A route module may export only what Next.js accepts
// (`app/api/route-export-surface.test.ts`), so the shared constant lives in
// `lib/meta/decision-workflow-limits.ts` and is imported here.
const ZERO_BASE_MAX_KEYS = DECISION_WORKFLOW_KEY_CAP;

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

  /**
   * The two refusals every other Meta write route performs, and this one did not.
   *
   * A reviewer holds a real membership, so the role check above passes them —
   * `rejectIfReviewerReadOnly` is what every sibling write route
   * (`lib/meta/entity-action-routes.ts`, `lib/meta/ads-action-routes.ts`, the
   * creative-brief create) uses to stop them, and this handler simply never
   * called it. A demo workspace has zero write authority anywhere in the
   * product and the overlay is no exception; INVARIANTS is explicit that a
   * presentation defect supplying an action does not grant one.
   *
   * The surface has refused both for a while (`workflowPosture`), which is
   * exactly why the gap mattered: the screen was enforcing a rule the server
   * did not, so a stale tab or a replayed request moved real workflow state.
   * Nothing here reaches Meta — what a refusal protects is the operator record
   * of who acknowledged what.
   */
  const reviewerBlocked = rejectIfReviewerReadOnly(
    access,
    `decision_workflow_${action}`,
  );
  if (reviewerBlocked) return reviewerBlocked;

  /*
   * FAIL-CLOSED, which this was not.
   *
   * It read `isDemoBusiness(businessId).catch(() => false)`, and
   * `lib/business-mode.server.isDemoBusiness` already swallows its own errors
   * into `false` — so the `.catch` was the second of two fail-open steps. An
   * unreadable flag, an unmigrated `businesses` table or a database outage all
   * answered "not a demo workspace" and the write proceeded. It also read the
   * BODY's `businessId` rather than the one the membership was resolved
   * against.
   *
   * `rejectIfMetaOperatorDemoWrite` reads `businesses.is_demo_business` and
   * refuses on anything short of a proven live workspace, using the server's
   * own id.
   */
  const demoBlocked = await rejectIfMetaOperatorDemoWrite(
    access.membership.businessId,
    `decision_workflow_${action}`,
  );
  if (demoBlocked) return demoBlocked;

  /**
   * The workflow gate, on the server as well as on the screen.
   *
   * `META_DECISION_WORKFLOW_UI` was read by the Decisions page alone, so the
   * controls were hidden while this handler still accepted every transition —
   * a stale tab, a replayed request or a script moved real workflow state that
   * the product was presenting as unavailable. Nothing here reaches Meta; what
   * a refusal protects is the operator's own record of who acknowledged what.
   *
   * Placed after the role check so the first refusal an operator meets is the
   * one about them, and before the assignee lookup so a shut gate cannot be
   * used to probe which user ids are members of this business.
   */
  const gated = rejectIfMetaGateClosed("decisionWorkflowUi", `decision_workflow_${action}`);
  if (gated) return gated;

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
