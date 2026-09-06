import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  engageMetaAutomationKillSwitch,
  normalizeCleanApprovalThreshold,
  normalizeQuietHourTime,
  releaseMetaAutomationKillSwitch,
  setMetaAutomationDecisionTypeMode,
  setMetaAutomationGuardrailPolicy,
  ensureBusinessControlRow,
  getMetaAutomationControlPlane,
  getMetaWriteBlockState,
  writeActivityLedgerRow,
  META_AUTOMATION_DECISION_TYPES,
  type MetaAutomationDecisionType,
  type MetaAutomationDecisionMode,
  type MetaAutomationQuietHours,
} from "@/lib/meta/automation-control-plane";
import {
  AutomationRuleValidationError,
  isSupportedTimeZone,
} from "@/lib/meta/automation-rules";
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
import { rejectIfAutomationDemoWrite } from "./demo-write-authority";
import { rejectIfMetaGateClosed } from "@/lib/meta/release-gate-guard";
import { getDb, runDbTransaction } from "@/lib/db";
import {
  disableBudgetAutoExecution,
  setBudgetAutoExecutionEnabled,
} from "@/lib/meta/budget-activation";
import {
  parseBudgetAutomationConfig,
  saveBudgetAutomationConfiguration,
} from "@/lib/meta/budget-automation-configuration";
import { readBudgetActivationServerRead }
  from "@/lib/meta/budget-activation-readiness-server";

export const dynamic = "force-dynamic";

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sanitizeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

/**
 * The ONE write behind both automatic-execution paths.
 *
 * PRE-DEPLOY AUDIT: the fail-safe STOP and the enable ceremony must not be able
 * to disagree about what "off" means. Enabling binds the exact account;
 * disabling always clears it, so no scheduled run can find an activated
 * account afterwards.
 */
async function persistBudgetAutoExecution(row: {
  businessId: string;
  providerAccountId: string;
  enabled: boolean;
  decidedBy: string;
  expectedControlUpdatedAt?: string | null;
}): Promise<void> {
  if (row.enabled) {
    if (!row.expectedControlUpdatedAt) {
      throw new BudgetAutoExecutionStateChangedError();
    }
    const updated = await getDb().query<{ business_id: string }>(
      `UPDATE meta_automation_business_controls
          SET auto_execution_enabled = $2::boolean,
              auto_execution_provider_account_id = $4,
              auto_execution_enabled_by = $3::uuid,
              updated_at = now(),
              updated_by = $3::uuid
        WHERE business_id = $1::uuid
          AND auto_execution_enabled = FALSE
          AND kill_switch_engaged = FALSE
          AND updated_at = $5::timestamptz
        RETURNING business_id::text AS business_id`,
      [row.businessId, true, row.decidedBy, row.providerAccountId,
        row.expectedControlUpdatedAt],
    );
    if (updated.length !== 1) {
      throw new BudgetAutoExecutionStateChangedError();
    }
    return;
  }

  await getDb().query(
    `INSERT INTO meta_automation_business_controls
       (business_id, auto_execution_enabled,
        auto_execution_provider_account_id, auto_execution_enabled_by,
        updated_at, updated_by)
     VALUES ($1::uuid, $2, $4, NULL, now(), $3::uuid)
     ON CONFLICT (business_id) DO UPDATE SET
       auto_execution_enabled = EXCLUDED.auto_execution_enabled,
       auto_execution_provider_account_id =
         EXCLUDED.auto_execution_provider_account_id,
       auto_execution_enabled_by = NULL,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [row.businessId, row.enabled, row.decidedBy,
      row.enabled ? row.providerAccountId : null],
  );
}

class BudgetAutoExecutionStateChangedError extends Error {
  constructor() {
    super("The automation control changed after readiness was evaluated.");
    this.name = "BudgetAutoExecutionStateChangedError";
  }
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
        rule?: unknown;
        ruleId?: unknown;
        active?: unknown;
        enabled?: unknown;
        confirmationPhrase?: unknown;
      }
    | null;
  const action = body?.action;
  if (
    action !== "engage_kill_switch" &&
    action !== "release_kill_switch" &&
    action !== "set_decision_type_mode" &&
    action !== "set_business_mode" &&
    action !== "set_budget_auto_execution" &&
    action !== "save_budget_automation_config" &&
    action !== "set_guardrail_policy" &&
    action !== "create_rule" &&
    action !== "set_rule_active" &&
    action !== "evaluate_rules"
  ) {
    return jsonError(
      400,
      "unsupported_automation_action",
      "Only engage_kill_switch, release_kill_switch, set_decision_type_mode, set_business_mode, set_budget_auto_execution, save_budget_automation_config, set_guardrail_policy, create_rule, set_rule_active and evaluate_rules are supported from Automation.",
    );
  }

  // The rule mutations are automation-control configuration writes that never
  // reach a provider, so they carry the same `collaborator` floor as
  // engage_kill_switch and set_decision_type_mode — their closest siblings.
  // `release_kill_switch` keeps its stricter `admin` floor untouched.
  /*
    PRE-DEPLOY AUDIT — arming a decision type is an ADMIN act.

    Automatic execution needs two keys: the business-wide master switch
    (`set_budget_auto_execution`, admin) and the decision type's own standing
    mode set to Tier 3 (`set_decision_type_mode`). Only the first was
    admin-gated, so once an admin had turned the master on, a COLLABORATOR
    could set `budget` back to Tier 3 and re-arm the only decision type that
    has an automatic executor — after an admin had deliberately demoted it.
    Raising the floor for the `auto` rung closes that path. It only ever
    tightens: demoting to Tier 1 or Tier 2 stays a collaborator preference,
    because standing down must never be harder than standing up.
  */
  const armsAutoExecution =
    (action === "set_decision_type_mode" || action === "set_business_mode") &&
    body?.mode === "auto";
  const access = await requireBusinessAccess({
    request,
    businessId,
    // Guardrail policy sets the ROAS floor and quiet-hours window that bound
    // every automated action, so it takes the STOP-release role rather than the
    // weaker preference role used by set_decision_type_mode.
    minRole:
      // D088 C1: enabling automatic budget writes is the strongest control in
      // the product, so it takes the same admin floor the STOP release does.
      action === "release_kill_switch" || action === "set_guardrail_policy"
      || action === "set_budget_auto_execution"
      || action === "save_budget_automation_config" || armsAutoExecution
        ? "admin"
        : "collaborator",
  });
  if ("error" in access) return access.error;

  // Same reason as the Automation page: without a persisted control row every
  // Meta write is refused `control_state_unavailable`, so a deliberate operator
  // action on this surface creates the default-closed row it needs.
  await ensureBusinessControlRow({
    businessId: access.membership.businessId,
    userId: access.session.user.id,
  }).catch(() => null);

  const REVIEWER_ACTION_LABELS: Record<string, string> = {
    release_kill_switch: "automation_kill_switch_release",
    set_decision_type_mode: "automation_decision_type_mode",
    set_business_mode: "automation_business_mode",
    set_guardrail_policy: "automation_guardrail_policy",
    engage_kill_switch: "automation_kill_switch_engage",
    create_rule: "automation_rule_create",
    set_rule_active: "automation_rule_toggle",
    evaluate_rules: "automation_rule_evaluate",
    set_budget_auto_execution: "automation_budget_auto_execution",
    save_budget_automation_config: "automation_budget_configuration",
  };
  const reviewerBlocked = rejectIfReviewerReadOnly(
    access,
    REVIEWER_ACTION_LABELS[action] ?? "automation_kill_switch_engage",
  );
  if (reviewerBlocked) return reviewerBlocked;

  /**
   * Zero write authority in a demo workspace, for EVERY action above — not
   * only the ones that could reach Meta.
   *
   * None of these seven actions consults `getMetaWriteBlockState`, which is
   * where the demo refusal already lived, so a demo session (an ADMIN under a
   * non-reviewer email, minted by `/api/auth/demo-login`) cleared the role gate
   * and the reviewer gate and then persisted real control, guardrail, rule and
   * proposal rows. Placed after the role and reviewer gates so the operator is
   * told the first refusal that applies, in the same precedence the surface
   * restates, and before every validation branch so no write can be reached by
   * a request the server was always going to refuse.
   */
  const demoBlocked = await rejectIfAutomationDemoWrite(
    access.membership.businessId,
    REVIEWER_ACTION_LABELS[action] ?? "automation_kill_switch_engage",
  );
  if (demoBlocked) return demoBlocked;

  /*
    THE FAIL-SAFE STOP, ahead of every dependency it does not need.

    PRE-DEPLOY AUDIT: `set_budget_auto_execution` used to be reached only after
    `resolveAutomationAccountScope`, which answers 503
    `provider_account_scope_unavailable` when the account-assignment read
    throws, and after a fresh readiness read. So an unrelated failure — a
    provider assignment API outage, an unselected account, a readiness query
    that could not run — could REFUSE a request to turn automatic execution
    OFF. A stop that a failing dependency can refuse is not a stop.

    Turning it off is therefore handled here: after authentication, the admin
    floor, the reviewer gate and the demo gate — the four facts about the
    CALLER, none of which needs an account — and before account resolution,
    readiness, the control plane, or any provider lookup. It writes the
    business-wide flag to false, clears the activated provider account, and
    records the act in the activity ledger.

    Turning it ON is untouched below: admin-only, typed phrase, fresh
    server-owned readiness, and bound to the exact resolved account.
  */
  if (action === "set_budget_auto_execution" && body?.enabled === false) {
    const stop = await disableBudgetAutoExecution({
      businessId: access.membership.businessId,
      // Recorded for the audit row only; the write below clears the binding.
      providerAccountId: requestedProviderAccountId,
      actor: { userId: access.session.user.id },
      persist: persistBudgetAutoExecution,
    }).catch((error: unknown) => ({ error } as const));

    if ("error" in stop) {
      /*
        The one thing that can still refuse a stop is the write itself. Say so
        exactly, rather than reporting a generic failure an operator might read
        as "already off".
      */
      return jsonError(
        503,
        "budget_auto_execution_stop_unpersisted",
        "The stop could not be recorded, so automatic budget execution may still be enabled. Retry, and engage the business STOP if it continues to fail.",
      );
    }

    /*
      The audit row is attempted, not required: a stop that landed must not be
      reported as failed because its ledger entry could not be written.
    */
    await writeActivityLedgerRow({
      businessId: access.membership.businessId,
      activityType: "budget_auto_execution_disabled",
      severity: "warning",
      message: "Automatic budget execution disabled for this business.",
      payload: {
        enabled: false,
        clearedActivatedProviderAccount: true,
        requestedProviderAccountId,
        path: "fail_safe_stop",
      },
      userId: access.session.user.id,
      actorKind: "operator",
      entityType: "automation_budget_auto_execution",
      entityId: access.membership.businessId,
      resultStatus: "recorded",
      resultReceiptId: null,
    }).catch(() => undefined);

    return NextResponse.json({ ok: true, enabled: false, stopPath: "fail_safe" });
  }


  /*
    PRE-DEPLOY AUDIT — PREPARE, which can never enable.

    Placed beside the fail-safe STOP and before account resolution on purpose:
    the guardrails it writes are BUSINESS-wide, so it needs no provider
    account, and the five businesses that have no control row are exactly the
    ones whose account scope is least likely to resolve cleanly.

    Activation readiness requires a persisted control row with a lifted
    dry-run guardrail and three real budget numbers, and nothing in the
    product could write any of them. This action can: it is admin-only,
    every value is explicitly validated, and the write pins
    `auto_execution_enabled` to FALSE and clears the activated account on
    every path. Preparing and enabling stay two different verbs.
  */
  if (action === "save_budget_automation_config") {
    const parsed = parseBudgetAutomationConfig(body);
    if (!parsed.ok) {
      return jsonError(400, parsed.rejection, parsed.message);
    }
    const saved = await saveBudgetAutomationConfiguration({
      businessId: access.membership.businessId,
      actorUserId: access.session.user.id,
      config: parsed.config,
    });
    await writeActivityLedgerRow({
      businessId: access.membership.businessId,
      activityType: "budget_automation_configuration_saved",
      severity: "info",
      message:
        "Budget automation configuration saved. Automatic execution remains OFF.",
      payload: {
        config: parsed.config,
        autoExecutionEnabled: false,
        activatedProviderAccountCleared: true,
      },
      userId: access.session.user.id,
      actorKind: "operator",
      entityType: "automation_budget_configuration",
      entityId: access.membership.businessId,
      resultStatus: "recorded",
      resultReceiptId: null,
    }).catch(() => undefined);
    return NextResponse.json({
      ok: true,
      saved: true,
      /* Restated so a caller cannot read a successful save as an enable. */
      autoExecutionEnabled: false,
      guardrails: saved.storedGuardrails,
    });
  }

  const accountScope = await resolveAutomationAccountScope({
    businessId: access.membership.businessId,
    providerAccountId: requestedProviderAccountId,
  });
  if (!accountScope.ok) return accountScope.response;

  /**
   * The Stop gate holds ENGAGE, and deliberately never holds RELEASE.
   *
   * `META_AUTOMATION_STOP_UI` exists because releasing a business-scoped stop
   * has not been proven reversible against a provider, and the refusal says so
   * in as many words: *"a stop that cannot be released is worse than no stop."*
   * The dangerous act is therefore engaging one — so that is what the gate
   * refuses, on the server as well as on the screen, where a stale tab or a
   * script would otherwise reach it.
   *
   * Releasing stays open at every gate setting. Whatever the rollout state, a
   * stop that exists must always be liftable, and gating the lift would build
   * exactly the trap the gate was written to avoid. The global incident switch
   * (`META_ADS_WRITE_KILL_SWITCH`) is a separate mechanism and is unaffected by
   * either decision.
   *
   * Ordered LAST among the refusals, after role, reviewer and demo. Those three
   * are facts about the caller and hold at every gate setting; this one is a
   * fact about the deployment. Refusing in that order means a demo workspace
   * gets the same answer whatever the rollout state, instead of a refusal that
   * changes shape when an unrelated variable moves.
   */
  if (action === "engage_kill_switch") {
    const stopGated = rejectIfMetaGateClosed(
      "automationStopUi",
      "automation_kill_switch_engage",
    );
    if (stopGated) return stopGated;
  }

  const VALID_MODES: MetaAutomationDecisionMode[] = ["manual", "semi_auto", "auto"];
  if (action === "set_business_mode") {
    const mode = body?.mode;
    if (
      typeof mode !== "string" ||
      !VALID_MODES.includes(mode as MetaAutomationDecisionMode)
    ) {
      return jsonError(
        400,
        "invalid_business_mode",
        "mode must be manual|semi_auto|auto.",
      );
    }
  }
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
      // The write boundary fails CLOSED on a window it cannot locate on the
      // clock: an unresolvable zone, or a start equal to its end, refuses every
      // provider write around the clock. Accepting either here would let an
      // operator arm that outage by typing a display label like "ET", and only
      // find out when writes stopped. Refuse at entry, where the message can
      // still reach the person who can fix it.
      if (!isSupportedTimeZone(timezone)) {
        return jsonError(
          400,
          "invalid_quiet_hours_timezone",
          `quietHours.timezone must be an IANA zone this server can resolve, such as America/New_York — "${timezone}" is not one.`,
        );
      }
      if (start === end) {
        return jsonError(
          400,
          "invalid_quiet_hours",
          "quietHours.start and quietHours.end must differ; a window that begins where it ends names neither a range nor a whole day.",
        );
      }
      quietHours = { start, end, timezone };
    }
  }

  try {
    /*
      D088 C1 — activation.

      Every fact the verdict needs is computed HERE, on the server. The browser
      supplies exactly two things: the intent to enable or disable, and the
      typed phrase. A readiness boolean from a client would be a client deciding
      whether it may write.
    */
    if (action === "set_budget_auto_execution") {
      const enabled = body?.enabled;
      if (typeof enabled !== "boolean") {
        return jsonError(400, "invalid_budget_auto_execution",
          "enabled must be true or false.");
      }
      const { readiness, controlUpdatedAt } = await readBudgetActivationServerRead({
        businessId: access.membership.businessId,
        providerAccountId: accountScope.providerAccountId,
        env: process.env,
      });

      const result = await setBudgetAutoExecutionEnabled({
        businessId: access.membership.businessId,
        providerAccountId: accountScope.providerAccountId,
        enabled,
        confirmationPhrase: typeof body?.confirmationPhrase === "string"
          ? body.confirmationPhrase : null,
        actor: {
          userId: access.session.user.id,
          isAdmin: true, // the requireBusinessAccess floor above proved it
        },
        readiness,
        /*
          D088 C3: activation is bound to the EXACT provider account.

          The control row is business-wide, so C2's write enabled automatic
          execution for every account the business holds while proving the
          readiness of exactly one of them. The account this ceremony was run
          for is now persisted alongside the flag, and cleared when execution is
          turned off, so the scheduler and the runtime can refuse an account
          nobody activated.
        */
        persist: (row) => persistBudgetAutoExecution({
          ...row,
          expectedControlUpdatedAt: controlUpdatedAt,
        }),
      }).catch((error: unknown) => {
        if (error instanceof BudgetAutoExecutionStateChangedError) return null;
        throw error;
      });
      if (result === null) {
        return jsonError(
          409,
          "budget_auto_execution_state_changed",
          "Automation controls changed while readiness was being checked. Enablement was not persisted; review the fresh state before acting again.",
        );
      }
      if (!result.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: result.refusal ?? "budget_auto_execution_refused",
              message: "Automatic budget execution was not changed.",
            },
            blockers: result.blockers,
            readiness,
          },
          { status: 409 },
        );
      }
      /* The enable half of the audit trail. Attempted, never required. */
      await writeActivityLedgerRow({
        businessId: access.membership.businessId,
        activityType: "budget_auto_execution_enabled",
        severity: "warning",
        message:
          "Automatic budget execution ENABLED for "
          + `${accountScope.providerAccountId}.`,
        payload: {
          enabled: true,
          providerAccountId: accountScope.providerAccountId,
          readiness,
        },
        userId: access.session.user.id,
        actorKind: "operator",
        entityType: "automation_budget_auto_execution",
        entityId: access.membership.businessId,
        resultStatus: "recorded",
        resultReceiptId: null,
      }).catch(() => undefined);
      return NextResponse.json({ ok: true, enabled, readiness });
    }

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
    } else if (action === "set_business_mode") {
      /*
        One switch, four rows.

        The operator asks for "this business runs semi-automatically"; the
        product stores that per decision type because that is where every
        consumer reads it. Writing the four rows here — rather than inventing a
        fifth business-level column that would then disagree with them — keeps
        one source of truth. A per-type override afterwards is still allowed and
        the surface then reads "custom".

        Sequential, not concurrent: each write appends a promotion record and an
        activity-ledger row, and interleaving them would produce an audit trail
        whose order does not match what happened.

        ONE transaction, because a partial business mode is worse than none.
        Each call used to commit on its own, so a failure on the second, third
        or fourth type answered 500 with the earlier types already changed. On
        `auto` that is the dangerous half: the caller reads a failed request as
        "nothing was armed" while one or more unattended action families are in
        fact armed, and the single business mode this action advertises is left
        as a custom mixture nobody asked for. Every statement inside
        `setMetaAutomationDecisionTypeMode` — the mode upsert, the promotion
        record and the ledger row — reaches the database through `getDb()`,
        which returns the transaction's own client while `runDbTransaction` is
        on the stack, so all twelve rows commit together or none of them do
        without the control plane needing to know it is in a transaction.

        The cost falls on a database where the additive-column migrations have
        not run: `withAdditiveColumnFallback` retries a `42703` with the
        pre-migration column list, and a failed statement poisons the
        transaction around it, so there this action now fails whole instead of
        degrading. That is the right trade here — all four writes name the same
        columns, so the fallback was all-or-nothing anyway — and the
        single-type action above keeps its ungrouped, degrading behaviour.
      */
      await runDbTransaction(async () => {
        for (const decisionType of META_AUTOMATION_DECISION_TYPES) {
          await setMetaAutomationDecisionTypeMode({
            businessId: access.membership.businessId,
            userId: access.session.user.id,
            decisionType,
            mode: body?.mode as MetaAutomationDecisionMode,
            reason: body?.reason,
          });
        }
      });
    } else if (action === "set_guardrail_policy") {
      await setMetaAutomationGuardrailPolicy({
        businessId: access.membership.businessId,
        userId: access.session.user.id,
        minRoasFloor,
        quietHours,
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
