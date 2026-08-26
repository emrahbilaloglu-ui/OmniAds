import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { rejectIfMetaOperatorDemoWrite } from "@/app/api/meta/demo-write-authority";
import { readServedMetaRecommendation } from "@/lib/meta/served-recommendation";
import {
  emitMetaDecisionResponseTelemetry,
  META_DECISION_RESPONSE_ACTIONS,
  recordMetaDecisionResponseIfAuthorized,
  type MetaDecisionResponseAction,
} from "@/lib/meta/decision-responses";

type ResponseBody = {
  recId?: unknown;
  businessId?: unknown;
  /**
   * The physical Meta account the caller is scoped to.
   *
   * Account Intelligence is an account-scoped surface and already names one
   * account on screen; this is that account, and the write boundary requires
   * it for the three current-snapshot actions. It is a REQUEST, not authority:
   * the check below matches it against `provider_account_id` on rows this
   * business owns, so naming another workspace's account proves nothing.
   */
  providerAccountId?: unknown;
  action?: unknown;
  actionSubtype?: unknown;
  reappearAt?: unknown;
};

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidAction(value: string): value is MetaDecisionResponseAction {
  return META_DECISION_RESPONSE_ACTIONS.includes(value as MetaDecisionResponseAction);
}

function validTimestamp(value: string) {
  if (!value) return true;
  return Number.isFinite(new Date(value).getTime());
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as ResponseBody | null;
  if (!body || typeof body !== "object") {
    return jsonError(400, "invalid_body", "A JSON body is required.");
  }

  const recId = stringValue(body.recId);
  const businessId = stringValue(body.businessId);
  const providerAccountId = stringValue(body.providerAccountId) || null;
  const action = stringValue(body.action);
  const actionSubtype = stringValue(body.actionSubtype) || null;
  const reappearAt = stringValue(body.reappearAt) || null;

  if (!recId || !businessId || !action) {
    return jsonError(400, "missing_params", "recId, businessId and action are required.");
  }
  if (!isValidAction(action)) {
    return jsonError(400, "invalid_action", "action must be acted, deferred, undeferred or ignored.");
  }
  if (!validTimestamp(reappearAt ?? "")) {
    return jsonError(400, "invalid_reappear_at", "reappearAt must be an ISO timestamp when provided.");
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;
  const reviewerBlocked = rejectIfReviewerReadOnly(access, "operator_response");
  if (reviewerBlocked) return reviewerBlocked;
  /*
   * Demo authority, after the caller facts and before anything durable.
   *
   * Role, then reviewer, then demo — the precedence every other Meta write
   * boundary uses, so an operator is told the refusal that is about THEM
   * before the one that is about the workspace. Read against the SERVER's
   * resolved business id, and fail-closed on an unreadable flag.
   */
  const demoBlocked = await rejectIfMetaOperatorDemoWrite(
    access.membership.businessId,
    "operator_response",
  );
  if (demoBlocked) return demoBlocked;

  /*
   * Authority and write in ONE statement.
   *
   * The id must name a recommendation this business was actually served, in
   * this physical account, and the rule is per ACTION:
   *
   *   acted / deferred / ignored -> it must be in the CURRENT snapshot for this
   *     account. A rec that has fallen out of the snapshot is no longer a
   *     decision the engine is making.
   *   undeferred -> it must have a currently ACTIVE prior deferral to lift,
   *     which is the one action whose purpose is to reach backwards.
   *
   * `rec_id` has no foreign key — `lib/triage-events.ts` writes synthetic ids
   * into the same table — so the check belongs here, at the boundary that
   * accepts an id from a caller, rather than as a table constraint that would
   * break the other writer.
   *
   * `recordMetaDecisionResponseIfAuthorized` makes the predicate the INSERT's
   * own WHERE, so a snapshot rotation between a check and a write cannot
   * produce a row the check would have refused. `readServedMetaRecommendation`
   * is consulted only when that INSERT wrote nothing, to say WHICH refusal it
   * was — and it is the same predicate, so the two cannot disagree.
   */
  let response: Awaited<ReturnType<typeof recordMetaDecisionResponseIfAuthorized>>;
  try {
    response = await recordMetaDecisionResponseIfAuthorized({
      recId,
      businessId: access.membership.businessId,
      providerAccountId,
      action,
      actionSubtype,
      reappearAt,
    });
  } catch {
    return jsonError(
      503,
      "recommendation_source_unavailable",
      "The decision snapshot could not be read, so this response was not recorded. Nothing was written.",
    );
  }
  if (!response) {
    const served = await readServedMetaRecommendation({
      businessId: access.membership.businessId,
      recId,
      action,
      providerAccountId,
    });
    if (served.status === "source_unavailable") {
      return jsonError(
        503,
        "recommendation_source_unavailable",
        "The decision snapshot could not be read, so this response was not recorded. Nothing was written.",
      );
    }
    return jsonError(
      404,
      "recommendation_not_served",
      action === "undeferred"
        ? "That recommendation has no active deferral to lift, so no response was recorded."
        : "That recommendation is not in the current served snapshot for this account, so no response was recorded.",
    );
  }

  const telemetry = emitMetaDecisionResponseTelemetry({
    recId,
    businessId: access.membership.businessId,
    action,
    actionSubtype,
  });

  return NextResponse.json({ ok: true, response, telemetry });
}
