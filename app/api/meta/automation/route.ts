import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  engageMetaAutomationKillSwitch,
  releaseMetaAutomationKillSwitch,
  setMetaAutomationDecisionTypeMode,
  getMetaAutomationControlPlane,
  META_AUTOMATION_DECISION_TYPES,
  type MetaAutomationDecisionType,
  type MetaAutomationDecisionMode,
} from "@/lib/meta/automation-control-plane";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";

export const dynamic = "force-dynamic";

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sanitizeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  if (!businessId) return jsonError(400, "missing_business_id", "businessId is required.");

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  try {
    const automation = await getMetaAutomationControlPlane({
      businessId: access.membership.businessId,
    });
    return NextResponse.json({ ok: true, automation });
  } catch (error) {
    return jsonError(500, "automation_contract_failed", sanitizeErrorMessage(error));
  }
}

export async function POST(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  if (!businessId) return jsonError(400, "missing_business_id", "businessId is required.");

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  const body = (await request.json().catch(() => null)) as
    | { action?: unknown; reason?: unknown; decisionType?: unknown; mode?: unknown }
    | null;
  const action = body?.action;
  if (
    action !== "engage_kill_switch" &&
    action !== "release_kill_switch" &&
    action !== "set_decision_type_mode"
  ) {
    return jsonError(
      400,
      "unsupported_automation_action",
      "Only engage_kill_switch, release_kill_switch and set_decision_type_mode are supported from Automation.",
    );
  }

  const reviewerBlocked = rejectIfReviewerReadOnly(
    access,
    action === "release_kill_switch"
      ? "automation_kill_switch_release"
      : action === "set_decision_type_mode"
        ? "automation_decision_type_mode"
        : "automation_kill_switch_engage",
  );
  if (reviewerBlocked) return reviewerBlocked;

  const VALID_MODES: MetaAutomationDecisionMode[] = ["manual", "semi_auto", "auto"];
  if (action === "set_decision_type_mode") {
    const decisionType = body?.decisionType;
    const mode = body?.mode;
    if (
      typeof decisionType !== "string" ||
      !META_AUTOMATION_DECISION_TYPES.includes(decisionType as MetaAutomationDecisionType) ||
      typeof mode !== "string" ||
      !VALID_MODES.includes(mode as MetaAutomationDecisionMode)
    ) {
      return jsonError(
        400,
        "invalid_decision_type_mode",
        "decisionType must be pause|bid|budget|creative and mode must be manual|semi_auto|auto.",
      );
    }
  }

  try {
    if (action === "release_kill_switch") {
      await releaseMetaAutomationKillSwitch({
        businessId: access.membership.businessId,
        userId: access.session.user.id,
      });
    } else if (action === "set_decision_type_mode") {
      await setMetaAutomationDecisionTypeMode({
        businessId: access.membership.businessId,
        userId: access.session.user.id,
        decisionType: body?.decisionType as MetaAutomationDecisionType,
        mode: body?.mode as MetaAutomationDecisionMode,
        reason: body?.reason,
      });
    } else {
      await engageMetaAutomationKillSwitch({
        businessId: access.membership.businessId,
        userId: access.session.user.id,
        reason: body?.reason,
      });
    }
    const automation = await getMetaAutomationControlPlane({
      businessId: access.membership.businessId,
    });
    return NextResponse.json({ ok: true, automation });
  } catch (error) {
    return jsonError(500, "automation_action_failed", sanitizeErrorMessage(error));
  }
}
