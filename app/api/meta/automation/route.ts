import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  engageMetaAutomationKillSwitch,
  releaseMetaAutomationKillSwitch,
  setMetaAutomationDecisionTypeMode,
  getMetaAutomationControlPlane,
  getMetaWriteBlockState,
  META_AUTOMATION_DECISION_TYPES,
  type MetaAutomationDecisionType,
  type MetaAutomationDecisionMode,
} from "@/lib/meta/automation-control-plane";
import { AutomationRuleValidationError } from "@/lib/meta/automation-rules";
import { evaluateBusinessAutomationRules } from "@/lib/meta/automation-rules-evaluation";
import {
  AutomationRuleDuplicateNameError,
  AutomationRuleLockedError,
  AutomationRuleNotFoundError,
  createAutomationRule,
  setAutomationRuleActive,
} from "@/lib/meta/automation-rules-store";
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
        rule?: unknown;
        ruleId?: unknown;
        active?: unknown;
      }
    | null;
  const action = body?.action;
  if (
    action !== "engage_kill_switch" &&
    action !== "release_kill_switch" &&
    action !== "set_decision_type_mode" &&
    action !== "create_rule" &&
    action !== "set_rule_active" &&
    action !== "evaluate_rules"
  ) {
    return jsonError(
      400,
      "unsupported_automation_action",
      "Only engage_kill_switch, release_kill_switch, set_decision_type_mode, create_rule, set_rule_active and evaluate_rules are supported from Automation.",
    );
  }

  // The rule mutations are automation-control configuration writes that never
  // reach a provider, so they carry the same `collaborator` floor as
  // engage_kill_switch and set_decision_type_mode — their closest siblings.
  // `release_kill_switch` keeps its stricter `admin` floor untouched.
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: action === "release_kill_switch" ? "admin" : "collaborator",
  });
  if ("error" in access) return access.error;

  const accountScope = await resolveAutomationAccountScope({
    businessId: access.membership.businessId,
    providerAccountId: requestedProviderAccountId,
  });
  if (!accountScope.ok) return accountScope.response;

  const REVIEWER_ACTION_LABELS: Record<string, string> = {
    release_kill_switch: "automation_kill_switch_release",
    set_decision_type_mode: "automation_decision_type_mode",
    engage_kill_switch: "automation_kill_switch_engage",
    create_rule: "automation_rule_create",
    set_rule_active: "automation_rule_toggle",
    evaluate_rules: "automation_rule_evaluate",
  };
  const reviewerBlocked = rejectIfReviewerReadOnly(
    access,
    REVIEWER_ACTION_LABELS[action],
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
      });
    } else if (action === "create_rule") {
      // A rule definition, not an action. Nothing here can reach a provider:
      // the validated action kinds only ever produce a queued proposal or a
      // hard block, both of which are rows in this database.
      const draft = (
        body?.rule && typeof body.rule === "object" ? body.rule : {}
      ) as Record<string, unknown>;
      await createAutomationRule({
        businessId: access.membership.businessId,
        userId: access.session.user.id,
        name: draft.name,
        entityLevel: draft.entityLevel,
        trigger: draft.trigger,
        action: draft.action,
        mode: draft.mode,
      });
    } else if (action === "set_rule_active") {
      const ruleId = typeof body?.ruleId === "string" ? body.ruleId.trim() : "";
      if (!ruleId || typeof body?.active !== "boolean") {
        return jsonError(
          400,
          "invalid_rule_toggle",
          "ruleId must be a rule id and active must be a boolean.",
        );
      }
      await setAutomationRuleActive({
        businessId: access.membership.businessId,
        userId: access.session.user.id,
        ruleId,
        active: body.active,
      });
    } else if (action === "evaluate_rules") {
      // Runs the deterministic evaluation over the warehouse and raises any
      // resulting proposals into the confirmation queue. It is idempotent —
      // a re-run over an unchanged warehouse day inserts nothing — and it
      // reaches no provider: the strongest thing it can do is queue a proposal
      // that still needs operator confirmation.
      if (!accountScope.providerAccountId) {
        return jsonError(
          400,
          "provider_account_scope_required",
          "Select one assigned Meta account before evaluating automation rules.",
        );
      }
      await evaluateBusinessAutomationRules({
        businessId: access.membership.businessId,
        providerAccountId: accountScope.providerAccountId,
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
    if (error instanceof AutomationRuleValidationError) {
      return jsonError(400, error.code, error.message);
    }
    if (error instanceof AutomationRuleDuplicateNameError) {
      return jsonError(409, error.code, error.message);
    }
    if (error instanceof AutomationRuleLockedError) {
      return jsonError(409, error.code, error.message);
    }
    if (error instanceof AutomationRuleNotFoundError) {
      return jsonError(404, error.code, error.message);
    }
    return jsonError(500, "automation_action_failed", sanitizeErrorMessage(error));
  }
}
