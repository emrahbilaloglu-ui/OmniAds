import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import {
  isTriageAction,
  recordTriageEvent,
} from "@/lib/triage-events";

type TriageEventBody = {
  businessId?: unknown;
  scopeType?: unknown;
  scopeId?: unknown;
  action?: unknown;
  reappearAt?: unknown;
};

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message }, message }, { status });
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function validTimestamp(value: string | null) {
  if (!value) return true;
  return Number.isFinite(new Date(value).getTime());
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as TriageEventBody | null;
  if (!body || typeof body !== "object") {
    return jsonError(400, "invalid_body", "A JSON body is required.");
  }

  const businessId = stringValue(body.businessId);
  const scopeType = stringValue(body.scopeType);
  const scopeId = stringValue(body.scopeId);
  const action = stringValue(body.action);
  const reappearAt = stringValue(body.reappearAt) || null;

  if (!businessId || !scopeType || !scopeId || !action) {
    return jsonError(400, "missing_params", "businessId, scopeType, scopeId and action are required.");
  }
  if (!isTriageAction(action)) {
    return jsonError(400, "invalid_action", "action must be deferred or undeferred.");
  }
  if (!validTimestamp(reappearAt)) {
    return jsonError(400, "invalid_reappear_at", "reappearAt must be an ISO timestamp when provided.");
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;
  const reviewerBlocked = rejectIfReviewerReadOnly(access, `triage_${action}`);
  if (reviewerBlocked) return reviewerBlocked;

  try {
    const event = await recordTriageEvent({
      businessId: access.membership.businessId,
      scopeType,
      scopeId,
      action,
      reappearAt,
    });
    return NextResponse.json({ ok: true, event });
  } catch (error) {
    return jsonError(
      503,
      "triage_persistence_unavailable",
      error instanceof Error ? error.message : "Triage persistence is unavailable.",
    );
  }
}
