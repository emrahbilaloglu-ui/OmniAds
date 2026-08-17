import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  engageMetaAutomationKillSwitch,
  normalizeCleanApprovalThreshold,
  normalizeQuietHourTime,
  releaseMetaAutomationKillSwitch,
  setMetaAutomationDecisionTypeMode,
  setMetaAutomationGuardrailPolicy,
  getMetaAutomationControlPlane,
  getMetaWriteBlockState,
  META_AUTOMATION_DECISION_TYPES,
  type MetaAutomationDecisionType,
  type MetaAutomationDecisionMode,
  type MetaAutomationQuietHours,
} from "@/lib/meta/automation-control-plane";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { resolveMetaCreativesAccountScope } from "@/lib/meta/creatives-warehouse";

export const dynamic = "force-dynamic";

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sanitizeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

async function resolveAutomationAccountScope(input: {
  businessId: string;
  providerAccountId: string | null;
}) {
  try {
    const result = resolveMetaCreativesAccountScope({
      assignedAccountIds: await fetchAssignedAccountIds(input.businessId),
      requestedProviderAccountId: input.providerAccountId,
    });
    if (result.ok) return { ok: true as const, providerAccountId: result.providerAccountId };
    return {
      ok: false as const,
      response: jsonError(
        result.status === "account_not_assigned" ? 403 : 400,
        result.status,
        result.status === "account_not_assigned"
          ? "The requested Meta account is not assigned to this business."
          : "Select one assigned Meta account before reading or changing Automation.",
      ),
    };
  } catch {
    return {
      ok: false as const,
      response: jsonError(
        503,
        "provider_account_scope_unavailable",
        "Meta account assignments are unavailable; Automation fails closed.",
      ),
    };
  }
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const requestedProviderAccountId =
    request.nextUrl.searchParams.get("providerAccountId")?.trim() || null;
  if (!businessId) return jsonError(400, "missing_business_id", "businessId is required.");

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const accountScope = await resolveAutomationAccountScope({
    businessId: access.membership.businessId,
    providerAccountId: requestedProviderAccountId,
  });
  if (!accountScope.ok) return accountScope.response;

  try {
    if (request.nextUrl.searchParams.get("summary") === "1") {
      const writeBlock = await getMetaWriteBlockState({
        businessId: access.membership.businessId,
      });
      return NextResponse.json({
        ok: true,
        system: {
          killSwitchEngaged:
            writeBlock.reason === "META_ADS_WRITE_KILL_SWITCH" ||
            writeBlock.reason === "business_kill_switch"
              ? true
              : writeBlock.reason === null
                ? false
                : null,
          writeEndpointsBlocked: writeBlock.blocked,
          blockReason: writeBlock.reason,
        },
      });
    }
    const automation = await getMetaAutomationControlPlane({
      businessId: access.membership.businessId,
      providerAccountId: accountScope.providerAccountId,
    });
    return NextResponse.json({ ok: true, automation });
  } catch (error) {
    return jsonError(500, "automation_contract_failed", sanitizeErrorMessage(error));
  }
}

export async function POST(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const requestedProviderAccountId =
    request.nextUrl.searchParams.get("providerAccountId")?.trim() || null;
  if (!businessId) return jsonError(400, "missing_business_id", "businessId is required.");

  const body = (await request.json().catch(() => null)) as
    | {
        action?: unknown;
        reason?: unknown;
        decisionType?: unknown;
        mode?: unknown;
        cleanApprovalThreshold?: unknown;
        minRoasFloor?: unknown;
        quietHours?: unknown;
      }
    | null;
  const action = body?.action;
  if (
    action !== "engage_kill_switch" &&
    action !== "release_kill_switch" &&
    action !== "set_decision_type_mode" &&
    action !== "set_guardrail_policy"
  ) {
    return jsonError(
      400,
      "unsupported_automation_action",
      "Only engage_kill_switch, release_kill_switch, set_decision_type_mode and set_guardrail_policy are supported from Automation.",
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    // Guardrail policy sets the ROAS floor and quiet-hours window that bound
    // every automated action, so it takes the STOP-release role rather than the
    // weaker preference role used by set_decision_type_mode.
    minRole:
      action === "release_kill_switch" || action === "set_guardrail_policy"
        ? "admin"
        : "collaborator",
  });
  if ("error" in access) return access.error;

  const accountScope = await resolveAutomationAccountScope({
    businessId: access.membership.businessId,
    providerAccountId: requestedProviderAccountId,
  });
  if (!accountScope.ok) return accountScope.response;

  const reviewerBlocked = rejectIfReviewerReadOnly(
    access,
    action === "release_kill_switch"
      ? "automation_kill_switch_release"
      : action === "set_decision_type_mode"
        ? "automation_decision_type_mode"
        : action === "set_guardrail_policy"
          ? "automation_guardrail_policy"
          : "automation_kill_switch_engage",
  );
  if (reviewerBlocked) return reviewerBlocked;

  const VALID_MODES: MetaAutomationDecisionMode[] = ["manual", "semi_auto", "auto"];
  let cleanApprovalThreshold: number | null | undefined;
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
    // Absent leaves the persisted target alone; explicit null clears it back to
    // "no target stated". A value that is not a positive whole number is a typo,
    // not a policy, and is refused rather than rounded into one.
    if (body && "cleanApprovalThreshold" in body) {
      const raw = body.cleanApprovalThreshold;
      if (raw === null) {
        cleanApprovalThreshold = null;
      } else {
        const normalized = normalizeCleanApprovalThreshold(raw);
        if (normalized === null || normalized !== Number(raw)) {
          return jsonError(
            400,
            "invalid_clean_approval_threshold",
            "cleanApprovalThreshold must be a whole number of at least 1, or null to clear it.",
          );
        }
        cleanApprovalThreshold = normalized;
      }
    }
  }

  let minRoasFloor: number | null = null;
  let quietHours: MetaAutomationQuietHours | null = null;
  if (action === "set_guardrail_policy") {
    const rawFloor = body?.minRoasFloor;
    if (rawFloor !== null && rawFloor !== undefined) {
      if (typeof rawFloor !== "number" || !Number.isFinite(rawFloor) || rawFloor <= 0) {
        return jsonError(
          400,
          "invalid_min_roas_floor",
          "minRoasFloor must be a positive number, or null to clear it.",
        );
      }
      minRoasFloor = rawFloor;
    }
    const rawWindow = body?.quietHours;
    if (rawWindow !== null && rawWindow !== undefined) {
      const window = rawWindow as {
        start?: unknown;
        end?: unknown;
        timezone?: unknown;
      };
      const start = normalizeQuietHourTime(window.start);
      const end = normalizeQuietHourTime(window.end);
      const timezone =
        typeof window.timezone === "string" ? window.timezone.trim() : "";
      if (!start || !end || !timezone || timezone.length > 40) {
        return jsonError(
          400,
          "invalid_quiet_hours",
          "quietHours must be {start,end} as HH:MM with a non-empty timezone label, or null to clear it.",
        );
      }
      quietHours = { start, end, timezone };
    }
  }

  try {
    if (action === "release_kill_switch") {
      const preflight = await getMetaAutomationControlPlane({
        businessId: access.membership.businessId,
        providerAccountId: accountScope.providerAccountId,
      });
      if (
        preflight.businessControl.source !== "persisted" ||
        !preflight.businessControl.killSwitchEngaged
      ) {
        return jsonError(
          409,
          "kill_switch_release_preflight_failed",
          "Business STOP release was withheld because a fresh persisted engaged state could not be verified.",
        );
      }
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
        ...(cleanApprovalThreshold === undefined
          ? {}
          : { cleanApprovalThreshold }),
      });
    } else if (action === "set_guardrail_policy") {
      await setMetaAutomationGuardrailPolicy({
        businessId: access.membership.businessId,
        userId: access.session.user.id,
        minRoasFloor,
        quietHours,
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
      providerAccountId: accountScope.providerAccountId,
    });
    return NextResponse.json({ ok: true, automation });
  } catch (error) {
    return jsonError(500, "automation_action_failed", sanitizeErrorMessage(error));
  }
}
