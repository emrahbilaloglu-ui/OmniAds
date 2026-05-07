import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  emitMetaDecisionResponseTelemetry,
  META_DECISION_RESPONSE_ACTIONS,
  recordMetaDecisionResponse,
  type MetaDecisionResponseAction,
} from "@/lib/meta/decision-responses";

type ResponseBody = {
  recId?: unknown;
  businessId?: unknown;
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

  const response = await recordMetaDecisionResponse({
    recId,
    businessId: access.membership.businessId,
    action,
    actionSubtype,
    reappearAt,
  });
  const telemetry = emitMetaDecisionResponseTelemetry({
    recId,
    businessId: access.membership.businessId,
    action,
    actionSubtype,
  });

  return NextResponse.json({ ok: true, response, telemetry });
}
