"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import type {
  MetaAutomationActivityItem,
  MetaAutomationControlPlane,
  MetaAutomationDecisionMode,
  MetaAutomationDecisionType,
  MetaAutomationReadinessControlTier,
} from "@/lib/meta/automation-control-plane";
import {
  resolveStopCeremony,
  type StopCeremonyState,
} from "@/lib/zero-base/meta/automation-posture";
import type {
  MetaAutomationProposal,
  MetaAutomationProposalHoldCounts,
} from "@/lib/meta/automation-proposals";
import { metaFailureMessage } from "@/lib/meta/read-state-contract";
import {
  createAutomationRuleRequest,
  setAutomationRuleActiveRequest,
  type AutomationRuleDraftInput,
} from "@/lib/meta/automation-rules-client";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import { accountSwitchQuery } from "@/lib/dashboard/account-scope-url";
import { MANUAL_CONFIRMATION } from "@/lib/zero-base/meta/dispatch-contract";
import { useAppStore } from "@/store/app-store";

import {
  EMPTY_AUTOMATION_PROPOSALS_MODEL,
  buildAutomationProposalsModel,
  type AutomationProposalsModel,
} from "./automation-proposals-exact-adapter";
import {
  buildAutomationRulesViewModel,
  type AutomationRuleRowViewModel,
} from "./automation-rules-exact-adapter";
import {
  AUTOMATION_VIEWER_NOT_ESTABLISHED,
  BUDGET_MASTER_SWITCH_MOBILE_REFUSAL,
  buildBudgetMasterSwitchAuthorization,
  type AutomationViewerEnvelope,
  type BudgetMasterSwitchAuthorization,
} from "./viewer-envelope";
import type { StateHistoryCompactionReadiness } from "@/lib/meta/state-history-compaction-readiness";
import type { BudgetWriteReadinessModel } from "@/lib/meta/budget-write-readiness";
import {
  BUDGET_ACTIVATION_CONFIRMATION_PHRASE,
  type BudgetActivationCondition,
} from "@/lib/meta/budget-activation";
import {
  parseBudgetAutomationConfig,
  type BudgetAutomationConfigInput,
} from "@/lib/meta/budget-automation-config-contract";
import {
  BUDGET_PREPARATION_FIELDS,
  unpreparedFields,
  type BudgetPreparationView,
  type PreparationField,
} from "@/lib/meta/budget-preparation-contract";
import type { BudgetReadinessReadModel } from "@/lib/meta/budget-readiness-read-model";
import {
  formatMinorUnitsForDisplay,
  resolveMinorUnitExponent,
  type MinorUnitExponent,
} from "@/lib/currency/iso-4217-minor-units";
import styles from "./automation.module.css";

type AutomationPayload = MetaAutomationControlPlane;

export function metaAutomationFreshnessPartialReason(input: {
  hasProviderAccount: boolean;
  incomplete: boolean;
}): string | null {
  if (!input.hasProviderAccount) {
    return "Select a Meta account to view automation data.";
  }
  return input.incomplete
    ? "Some automation data is unavailable. Try again."
    : null;
}

export interface MetaAutomationPageProps {
  /** A server-authorized route scope. When present, client store state cannot replace it. */
  businessId?: string;
  /** `null` is an intentional unresolved scope and must not silently select an account. */
  providerAccountId?: string | null;
  /**
   * The legacy dashboard shell has no shared provider-account control. Its
   * route opts into the local recovery picker; canonical `/c/**` routes leave
   * this unset because their topbar owns account selection.
   */
  accountSelection?: "shared" | "local";
  initialPayload?: AutomationPayload | null;
  /**
   * The server's answer to "may this viewer write here". Absent means no server
   * established it (the preserved legacy mount), which is NOT a grant — the
   * routes still refuse on their own authority — it only means this render has
   * no server fact to restate.
   */
  viewer?: AutomationViewerEnvelope;
  /**
   * Why engaging the Meta Stop is refused, read on the SERVER.
   *
   * Non-null exactly when `/api/meta/automation` would refuse
   * `engage_kill_switch`, so the control states the same fact the route would.
   * Releasing is never gated — a stop that cannot be lifted is the trap the
   * gate exists to avoid — so this governs one direction only.
   */
  stopEngageRefusalReason?: string | null;
  /**
   * Why an approved proposal cannot reach Meta, read on the SERVER.
   *
   * The "Approvals reach Meta" row used to answer from the guardrail column
   * alone, so a row saying `dryRunOnly: false` printed "Yes" while
   * `/api/meta/automation/proposals` was independently forcing dry-run because
   * the live-writes gate was shut. Two authorities, one of them wrong on the
   * screen the operator reads. This is the second one, handed over as a fact
   * rather than re-derived here.
   */
  liveWritesRefusalReason?: string | null;
  /**
   * D077 read-only recovery readiness, read on the SERVER through
   * lib/meta/state-history-compaction-readiness. Display-only: this view
   * renders the facts verbatim and never computes readiness, invokes the
   * planner or executor, or offers a compaction control. `null` means the
   * server did not read it — rendered as unavailable, never as ready.
   */
  stateHistoryReadiness?: StateHistoryCompactionReadiness | null;
  /** D086 server-owned budget-readiness facts; display-only, `null` = unread. */
  budgetReadiness?: BudgetReadinessReadModel | null;
  budgetWriteReadiness?: BudgetWriteReadinessModel | null;
}

interface StatusPresentation {
  label: string;
  tone: "enabled" | "stopped" | "unknown";
}

interface AutonomyPresentation {
  kind: string;
  decisionType: MetaAutomationDecisionType | null;
  tier: string;
  tone: "automation" | "info" | "enabled" | "manual" | "unknown";
  progress: string;
  /** CSS width for the bar; `0%` whenever the ratio is not fully proven. */
  progressWidth: string;
  progressTone: "measured" | "locked";
  next: string;
}

interface LedgerResultPresentation {
  label: string;
  tone: "applied" | "blocked" | "failed" | "recorded" | "unknown";
}

const UNKNOWN = "—";

/*
  Said in the operator's language, not the ladder's.

  "Tier 2" is a rung on an internal readiness ladder, and it appeared on the
  one control that decides whether this product touches somebody's money. An
  operator choosing how their ads are managed is choosing between doing it
  themselves, confirming each change, and letting it run — three sentences
  they can act on. The internal tier names still exist where they belong: on
  the readiness state, which is a diagnosis rather than a choice.
*/
const READINESS_LABELS: Record<MetaAutomationReadinessControlTier, string> = {
  read_only: "Read only",
  manual_review: "Supervised",
  backtest_candidate: "Backtest candidate",
  auto_execute: "Cleared for automatic",
};

const MODE_LABELS: Record<MetaAutomationDecisionMode, string> = {
  manual: "Manual · you apply each change",
  semi_auto: "Semi-automatic · you confirm each change",
  auto: "Automatic · applied within your guardrails",
};

/** The ladder's three rungs, in the order the server declares them. */
const AUTONOMY_MODES: readonly MetaAutomationDecisionMode[] = [
  "manual",
  "semi_auto",
  "auto",
];

/** What each rung says ON the segment; `MODE_LABELS` is its accessible name. */
const MODE_SEGMENT_LABELS: Record<MetaAutomationDecisionMode, string> = {
  manual: "Manual",
  semi_auto: "Semi-automatic",
  auto: "Automatic",
};

const ACTIVATION_BLOCKER_LABELS: Record<BudgetActivationCondition, string> = {
  control_row_absent: "Save the automation limits below.",
  global_gate_closed: "Automatic Meta actions are not available yet.",
  business_stop_engaged: "Release the business emergency stop.",
  budget_mode_not_auto: "Set Budget to Automatic.",
  dry_run_guardrail_engaged: "Turn off preview-only mode in the saved limits.",
  canonical_fact_retention_not_ready:
    "More verified account history is needed.",
  profile_retention_not_ready: "More verified performance history is needed.",
  automatic_role_retention_not_ready:
    "More verified campaign history is needed.",
  account_scope_not_exact: "Select one Meta ad account.",
  journal_schema_not_ready: "Action history is not ready yet.",
  unresolved_reconciliation: "Wait for the current Meta action to finish.",
  open_claim: "Wait for the current Meta action to finish.",
};

function activationBlockerLabel(code: string): string {
  if (code === "enabling_actor_absent") {
    return "The enabling admin no longer has active authority.";
  }
  return (
    ACTIVATION_BLOCKER_LABELS[code as BudgetActivationCondition] ??
    "One setup requirement is not ready yet."
  );
}

function compactMetaAccountId(providerAccountId: string | null): string | null {
  if (!providerAccountId) return null;
  const accountId = providerAccountId.replace(/^act_/, "");
  if (accountId.length <= 2) return `••${accountId.slice(-1)}`;
  if (accountId.length <= 7) {
    return `${accountId.slice(0, 1)}…${accountId.slice(-2)}`;
  }
  return `${accountId.slice(0, 3)}…${accountId.slice(-4)}`;
}

const PREPARATION_FIELD_LABELS: Record<
  (typeof BUDGET_PREPARATION_FIELDS)[number],
  string
> = {
  dryRunOnly: "preview setting",
  budgetMinHoursBetweenChanges: "minimum time between changes",
  budgetMaxChangesPer7d: "maximum changes per week",
  budgetMaxAccountConcentrationPct: "maximum account budget share",
  maxBudgetIncreasePct: "maximum increase per change",
  perActionSpendCeilingMinor: "spend limit",
  perActionSpendCeilingCurrency: "spend-limit currency",
};

/**
 * The mode the control plane currently HOLDS for one action kind.
 *
 * Only a persisted row counts. A default the server synthesised is not a
 * recorded choice, and drawing it as the checked segment would tell an operator
 * they had set something they never set.
 */
function currentModeFor(
  payload: AutomationPayload | null,
  decisionType: MetaAutomationDecisionType,
): MetaAutomationDecisionMode | null {
  const item = (payload?.decisionTypeModes ?? []).find(
    (entry) =>
      entry.decisionType === decisionType && entry.source === "persisted",
  );
  return item?.mode ?? null;
}

const MODE_TONES: Record<
  MetaAutomationDecisionMode,
  AutonomyPresentation["tone"]
> = {
  manual: "automation",
  semi_auto: "info",
  auto: "enabled",
};

/**
 * One section's provenance, from the richest source this payload offers.
 *
 * The server now sends a per-section envelope (`sections`) carrying a status,
 * an error code and the instant the read was attempted. Older payloads carry
 * only the flat `readCompleteness` booleans, and payloads older still carry
 * neither — so the fallback chain ends at `"unproven"`, never at `"complete"`.
 * An absent flag has always meant "this server never told us", and that is not
 * the same as "it is fine".
 */
type SectionKey =
  | "businessControl"
  | "rules"
  | "activity"
  | "promotionRecords"
  | "decisionModes"
  | "anchors"
  | "readiness";

type SectionState =
  "complete" | "unavailable" | "migration_required" | "unproven";

const LEGACY_COMPLETENESS_KEY: Partial<
  Record<
    SectionKey,
    | "rules"
    | "activityLedger"
    | "promotionRecords"
    | "businessControl"
    | "cleanApprovalStreaks"
  >
> = {
  businessControl: "businessControl",
  rules: "rules",
  activity: "activityLedger",
  promotionRecords: "promotionRecords",
  readiness: "cleanApprovalStreaks",
};

function sectionState(
  payload: AutomationPayload | null,
  key: SectionKey,
): SectionState {
  if (!payload) return "unproven";
  const served = payload.sections?.[key];
  if (served) return served.status;
  const legacyKey = LEGACY_COMPLETENESS_KEY[key];
  if (!legacyKey) return "unproven";
  const legacy = payload.readCompleteness?.[legacyKey];
  if (legacy === "complete") return "complete";
  return legacy === "unavailable" ? "unavailable" : "unproven";
}

function sectionIsComplete(payload: AutomationPayload | null, key: SectionKey) {
  return sectionState(payload, key) === "complete";
}

/**
 * Whether the served control state can be stated at all.
 *
 * Deliberately NOT "did an operator persist a row". A defaulted control is not
 * an absent one: `dryRunOnly: true`, a 15% budget ceiling and a 3-action daily
 * cap are what the server actually enforces for a business nobody has
 * configured — every approval on this screen short-circuits because of that
 * default. Gating the panel on `source === "persisted"` printed an em dash
 * beside each of those, telling the operator no guardrail was in force while
 * one governed every write.
 *
 * The distinction is still worth drawing, so `source` is surfaced beside the
 * values rather than used to suppress them.
 *
 * It IS gated on read provenance, because `businessControl` is populated even
 * when the control read failed: the server degrades to a concrete, benign
 * default (ENABLED, Tier 1 — Supervised, +15% max, 3 actions/day). Truthiness
 * alone was therefore true of a failed read, and this screen printed those
 * four values as facts while the write path refused every action in the same
 * window with `control_state_unavailable`. An absent flag is an unproven read,
 * exactly as for `rules`, so it withholds too.
 */
function hasServedBusinessControl(payload: AutomationPayload | null) {
  return (
    Boolean(payload?.businessControl) &&
    sectionIsComplete(payload, "businessControl")
  );
}

/**
 * The failure this render has to name, or `null` while nothing failed.
 *
 * `readError` covers the client fetch. The control-plane read can also fail
 * *inside* a successful response — the payload arrives, carrying defaults where
 * the control row should be — and that case drew no notice at all.
 */
function readFailureFor(input: {
  payload: AutomationPayload | null;
  readError: string | null;
}) {
  if (input.readError) return input.readError;
  if (input.payload && !hasServedBusinessControl(input.payload)) {
    return "automation_control_state_unavailable";
  }
  return null;
}

/**
 * One sentence per failure, because "unknown rather than zero" is not true of
 * all of them: an unresolved account scope means the read never ran, which is a
 * different fact from a read that ran and failed. Unrecognised codes fall back
 * to the general sentence rather than rendering a raw code at an operator.
 */
const READ_FAILURE_MESSAGES: Record<string, string> = {
  automation_control_plane_unavailable:
    "Automation is unavailable right now. Refresh to try again.",
  automation_control_state_unavailable:
    "Automation status is unavailable right now. Refresh to try again.",
  provider_account_scope_unresolved:
    "Choose a Meta ad account in the top bar to see its automation status.",
  provider_account_none_assigned:
    "No Meta ad account is assigned to this business.",
  provider_account_not_assigned:
    "That Meta ad account is not assigned to this business.",
  provider_account_scope_unavailable:
    "Meta ad accounts are unavailable right now. Refresh to try again.",
  // Codes the route returns that previously arrived here flattened into the
  // general sentence. Each says what actually happened and what to do, because
  // "could not be read" is true of all of them and useful for none.
  automation_contract_failed:
    "Automation is unavailable right now. Refresh to try again.",
  unauthorized: "Your session has expired. Sign in again to see Automation.",
  forbidden: "You do not have access to Automation for this business.",
};

/**
 * This screen's own sentence first, then the shared contract, then the general
 * one.
 *
 * The local dictionary stays first because its wording is specific to what this
 * screen shows — "the kill switch, guardrails and readiness above are unknown"
 * names the four values the operator is looking at, which a shared sentence
 * cannot. But a code this screen has never heard of should not fall straight to
 * the general "Automation could not be read" when
 * `lib/meta/read-state-contract.ts` already has an operator sentence for it:
 * that is how an expired connection was reported as an unexplained read
 * failure.
 *
 * The general fallback stays last for a code neither dictionary knows. It is
 * honest — something failed and the figures are unknown rather than zero — and
 * it is the only case where the screen genuinely has nothing more specific.
 */
function readFailureMessage(code: string) {
  return (
    READ_FAILURE_MESSAGES[code] ??
    metaFailureMessage(code) ??
    READ_FAILURE_MESSAGES.automation_control_plane_unavailable!
  );
}

function automationRefusalMessage(
  code: AutomationViewerEnvelope["reasonCode"],
): string {
  switch (code) {
    case "reviewer_read_only":
      return "This workspace is read-only.";
    case "demo_business_read_only":
      return "Automation changes are unavailable in demo workspaces.";
    case "demo_status_unverified":
      return "Automation changes are unavailable right now.";
    case "insufficient_role":
      return "Collaborator access is required to change automation.";
    default:
      return "Automation changes are unavailable from this view.";
  }
}

function automaticActionsRefusalMessage(
  code: BudgetMasterSwitchAuthorization["reasonCode"],
): string {
  switch (code) {
    case "reviewer_read_only":
      return "This workspace is read-only.";
    case "demo_business_read_only":
      return "Automatic actions are unavailable in demo workspaces.";
    case "insufficient_role":
      return "Admin access is required to change automatic actions.";
    case "read_only_surface":
      return "Open Automation on desktop to change automatic actions.";
    case "demo_status_unverified":
    case "viewer_not_established":
      return "Automatic actions are unavailable right now.";
    default:
      return "Automatic actions cannot be changed from here.";
  }
}

function stopBlockerMessage(
  code: NonNullable<StopCeremonyState["blocker"]>["code"],
  intent: "engage" | "release",
): string {
  switch (code) {
    case "preflight_unavailable":
    case "preflight_stale":
    case "state_unavailable":
      return "Refresh before changing the emergency stop.";
    case "gate_closed":
      return "The emergency stop is unavailable right now.";
    case "reviewer":
      return "This workspace is read-only.";
    case "demo":
      return "The emergency stop is unavailable in demo workspaces.";
    case "insufficient_role":
      return intent === "release"
        ? "Admin access is required to release the emergency stop."
        : "Collaborator access is required to use the emergency stop.";
  }
}

function businessControlIsDefault(payload: AutomationPayload | null) {
  return payload?.businessControl.source !== "persisted";
}

function statusForGlobalKillSwitch(
  payload: AutomationPayload | null,
): StatusPresentation {
  if (!payload) {
    return { label: UNKNOWN, tone: "unknown" };
  }
  return payload.globalKillSwitch.engaged
    ? { label: "ENGAGED", tone: "stopped" }
    : { label: "NOT ENGAGED", tone: "enabled" };
}

function statusForBusinessKillSwitch(
  payload: AutomationPayload | null,
): StatusPresentation {
  if (!hasServedBusinessControl(payload)) {
    return { label: UNKNOWN, tone: "unknown" };
  }
  // An engaged stop reads ENGAGED regardless of provenance — a stop is a
  // stop, and softening it because the row is a default would weaken the
  // fail-closed direction.
  if (payload!.businessControl.killSwitchEngaged) {
    return { label: "ENGAGED", tone: "stopped" };
  }
  // A successful read of a MISSING control row degrades to defaults, and the
  // write boundary refuses every Meta write for that business with
  // `business_control_not_configured` (D072 fail-closed governance). Printing
  // a green ENABLED here claimed a write-enablement the server does not
  // grant; the pill states the effective posture instead.
  if (payload!.businessControl.source !== "persisted") {
    return { label: "NOT CONFIGURED", tone: "stopped" };
  }
  return { label: "NOT ENGAGED", tone: "enabled" };
}

function readinessFor(payload: AutomationPayload | null) {
  return hasServedBusinessControl(payload)
    ? READINESS_LABELS[payload!.businessControl.readinessTier]
    : UNKNOWN;
}

/**
 * Gated on the promotion read alone, deliberately.
 *
 * This was coupled to the control gate, which was harmless while that gate only
 * meant "a control object exists". Now that the gate also means "the control
 * read succeeded", the coupling would hide a promotion count the server DID
 * prove whenever the unrelated control read failed — an em dash standing in for
 * a known fact, which is the mirror image of the defect above and just as
 * wrong. Each collection answers for its own read.
 */
function promotionCountFor(payload: AutomationPayload | null) {
  if (
    !payload?.promotionRecords ||
    !sectionIsComplete(payload, "promotionRecords")
  ) {
    return UNKNOWN;
  }
  const count = payload!.promotionRecords.length;
  return `${count} promotion ${count === 1 ? "record" : "records"}`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    value,
  );
}

function formatRoas(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function guardrailsFor(
  payload: AutomationPayload | null,
  liveWritesRefusalReason: string | null,
) {
  const guardrails = hasServedBusinessControl(payload)
    ? payload!.businessControl.guardrails
    : null;
  const quietHours = guardrails?.quietHours ?? null;
  return [
    {
      /**
       * The guardrail that decides whether anything on this screen can reach
       * Meta at all, and it was the one guardrail not shown.
       *
       * `dryRunOnly` defaults true in the code and in the column, so in the
       * only configuration production can reach, every approval here
       * short-circuits before the provider POST. The operator was reading four
       * limits on writes while the fifth fact — that there are no writes — went
       * unstated, which made an approval look like an action.
       */
      key: "dry-run",
      label: "Approved actions",
      /*
       * The EFFECTIVE posture, not the column's alone. Either lock closes it,
       * and the server applies exactly this rule in `metaAutomationDryRunOnly`,
       * so the row and the route now answer together instead of disagreeing
       * about the one fact that decides whether an approval leaves the
       * building.
       */
      value: guardrails
        ? guardrails.dryRunOnly || liveWritesRefusalReason
          ? "Preview only"
          : "Sent to Meta"
        : UNKNOWN,
    },
    {
      key: "budget-change",
      label: "Maximum budget increase",
      value: guardrails
        ? `+${formatNumber(guardrails.maxBudgetIncreasePct)}% max`
        : UNKNOWN,
    },
    {
      key: "roas-floor",
      label: "Pause below ROAS",
      value:
        typeof guardrails?.minRoasFloor === "number"
          ? formatRoas(guardrails.minRoasFloor)
          : UNKNOWN,
    },
    {
      key: "actions-per-day",
      label: "Maximum actions per day",
      value: guardrails ? formatNumber(guardrails.dailyAutoActionCap) : UNKNOWN,
    },
    {
      key: "quiet-hours",
      label: "Quiet hours",
      value: quietHours
        ? `${quietHours.start}–${quietHours.end} ${quietHours.timezone}`
        : UNKNOWN,
    },
  ] as const;
}

function autonomyFor(
  payload: AutomationPayload | null,
): AutonomyPresentation[] {
  const budgetLimit = hasServedBusinessControl(payload)
    ? `+${formatNumber(payload!.businessControl.guardrails.maxBudgetIncreasePct)}%`
    : UNKNOWN;
  // Gated on the decision-mode read too. The server used to degrade this
  // collection to its defaults without recording that it had, so a failed read
  // and a workspace that had configured nothing rendered the same four rows.
  const modesProven = sectionIsComplete(payload, "decisionModes");
  const byType = new Map(
    (modesProven ? (payload?.decisionTypeModes ?? []) : [])
      .filter((item) => item.source === "persisted")
      .map((item) => [item.decisionType, item]),
  );
  // The same rule the promotion count already follows: a read this payload
  // cannot prove is complete may not be turned into a total.
  const streaksProven = sectionIsComplete(payload, "readiness");

  const mapped = (
    kind: string,
    decisionType: MetaAutomationDecisionType,
  ): AutonomyPresentation => {
    const item = byType.get(decisionType);
    const threshold = item?.cleanApprovalThreshold ?? null;
    const streak = item?.cleanApprovalStreak ?? null;
    const measured =
      streaksProven &&
      typeof threshold === "number" &&
      typeof streak === "number";
    return {
      kind,
      decisionType,
      tier: item ? MODE_LABELS[item.mode] : UNKNOWN,
      tone: item ? MODE_TONES[item.mode] : "unknown",
      progress: measured ? `${streak} / ${threshold}` : UNKNOWN,
      progressWidth: measured
        ? `${Math.max(0, Math.min(100, Math.round((streak! / threshold!) * 100)))}%`
        : "0%",
      progressTone: measured ? "measured" : "locked",
      next: item?.lockReason?.trim() || UNKNOWN,
    };
  };

  /*
   * Four controlled rows, because the server has four decision types.
   *
   * `bid` was missing: `MetaAutomationDecisionType` is
   * `pause | bid | budget | creative`, `setMetaAutomationDecisionTypeMode`
   * accepts all four, and `LEDGER_ENTITY_LABELS` already had a caption for it —
   * but the ladder drew three, so a bid mode could be recorded by the control
   * plane and never appear on the screen that claims to show every action
   * kind's autonomy.
   */
  return [
    mapped(
      budgetLimit === UNKNOWN
        ? "Budget changes"
        : `Budget changes ≤ ${budgetLimit}`,
      "budget",
    ),
    mapped("Pause / resume", "pause"),
    mapped("Bid changes", "bid"),
    mapped("Creative rotation", "creative"),
    {
      kind: "Launches · new spend",
      decisionType: null,
      tier: "Manual · by design",
      tone: "manual",
      progress: "locked",
      progressWidth: "0%",
      progressTone: "locked",
      next: "New spend never automates. Launches stay a deliberate human act, always PAUSED first.",
    },
  ];
}

const LEDGER_RESULT_LABELS: Record<string, string> = {
  applied: "Applied",
  blocked: "Blocked",
  failed: "Failed",
  recorded: "Recorded",
};

/** Design entity captions for the control-plane objects this screen records. */
const LEDGER_ENTITY_LABELS: Record<string, string> = {
  pause: "Pause / resume",
  bid: "Bid",
  budget: "Budget",
  creative: "Creative rotation",
};

const LEDGER_ACTION_LABELS: Record<string, string> = {
  business_kill_switch_engaged: "Automation stopped",
  business_kill_switch_released: "Automation resumed",
  decision_type_mode_change: "Action mode changed",
  automation_guardrail_policy_updated: "Limits updated",
  automation_rule_created: "Rule created",
  automation_rule_enabled: "Rule enabled",
  automation_rule_disabled: "Rule disabled",
  automation_proposal_approved: "Action approved",
  automation_proposal_modify: "Action modified",
  automation_proposal_dismiss: "Action dismissed",
  automation_proposal_failed: "Action failed",
  automation_proposal_reconcile: "Action needs review",
  budget_auto_execution_enabled: "Automatic actions enabled",
  budget_auto_execution_disabled: "Automatic actions disabled",
  budget_automation_configuration_saved: "Automation limits updated",
};

function ledgerActorFor(item: MetaAutomationActivityItem) {
  return item.actor?.name?.trim() || UNKNOWN;
}

function ledgerEntityFor(item: MetaAutomationActivityItem) {
  const entity = item.entity;
  if (!entity) return UNKNOWN;
  if (entity.name?.trim()) return entity.name.trim();
  if (entity.type === "automation_decision_type" && entity.id) {
    return LEDGER_ENTITY_LABELS[entity.id] ?? entity.id;
  }
  if (entity.type === "campaign") return "Campaign";
  if (entity.type === "adset") return "Ad set";
  if (entity.type === "ad") return "Ad";
  if (entity.type === "business") return "Business";
  return "Automation";
}

function ledgerActionFor(item: MetaAutomationActivityItem) {
  if (item.activityType.startsWith("meta_")) return "Meta action";
  return LEDGER_ACTION_LABELS[item.activityType] ?? "Automation updated";
}

function ledgerResultFor(
  item: MetaAutomationActivityItem,
): LedgerResultPresentation {
  const result = item.result;
  if (!result) return { label: UNKNOWN, tone: "unknown" };
  const label = LEDGER_RESULT_LABELS[result.status];
  return label
    ? { label, tone: result.status }
    : { label: UNKNOWN, tone: "unknown" };
}

function formatLedgerTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return UNKNOWN;
  const parts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).formatToParts(new Date(time));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("month")} ${part("day")}, ${part("hour")}:${part("minute")}`;
}

/** The three controls the design puts on every proposal row. */
export type ProposalControl = "approve" | "modify" | "dismiss";

function AutomationRuleRow({
  row,
  busy,
  canMutate,
  onToggle,
}: {
  row: AutomationRuleRowViewModel;
  busy: boolean;
  canMutate: boolean;
  onToggle: () => void;
}) {
  const interactive = canMutate && !row.locked;
  return (
    <tr
      className={styles.rulesRow}
      data-rule-id={row.id}
      data-active={row.active ? "true" : "false"}
    >
      <td className={styles.ruleCell}>
        <span className={styles.ruleName}>{row.name}</span>
        <span className={styles.ruleTrigger}>{row.trigger}</span>
      </td>
      <td className={styles.ruleThen}>{row.then}</td>
      <td className={styles.ruleModeCell}>
        <span className={styles.modeChip} data-mode={row.modeTone}>
          {row.mode}
        </span>
      </td>
      <td className={styles.ruleFired}>{row.fired}</td>
      <td className={styles.ruleToggleCell}>
        <button
          type="button"
          className={styles.ruleToggle}
          title={row.toggleTitle}
          aria-label={`${row.name} — ${row.toggleTitle}`}
          aria-pressed={row.active}
          data-on={row.active ? "true" : "false"}
          data-locked={row.locked ? "true" : "false"}
          disabled={!interactive || busy}
          onClick={interactive ? onToggle : undefined}
        >
          <span className={styles.ruleToggleKnob} />
        </button>
      </td>
    </tr>
  );
}

const COMPOSER_TRIGGER_KINDS = [
  { value: "roas_below_anchor", label: "ROAS below anchor" },
  { value: "roas_at_or_above_anchor", label: "ROAS at or above anchor" },
  { value: "cpa_above_anchor", label: "CPA above anchor" },
  { value: "cpa_at_or_below_anchor", label: "CPA at or below anchor" },
] as const;

const COMPOSER_ANCHORS = {
  roas: [
    { value: "break_even_roas", label: "Breakeven ROAS" },
    { value: "target_roas", label: "Target ROAS" },
  ],
  cpa: [
    { value: "break_even_cpa", label: "Breakeven CPA" },
    { value: "target_cpa", label: "Target CPA" },
  ],
} as const;

/**
 * The only action a rule may be built to take.
 *
 * A rule raises a row into the one confirmation queue, and every row there
 * promises that approving executes. `pause` is the single action with a real
 * guarded endpoint at these grains, so it is the single option here — the list
 * is short because the write surface is, not because the composer is.
 */
const COMPOSER_ACTIONS = [
  { value: "propose_pause", label: "Propose pause into the queue" },
] as const;

/**
 * The composer only offers anchors, never numbers.
 *
 * There is no field here for "ROAS below 2.5". A trigger picks a Commercial
 * Truth anchor and a bounded multiplier, so a rule cannot drift away from the
 * pack the workspace actually agreed on. The action list likewise contains no
 * executing option — the strongest thing a rule can be built to do is queue a
 * proposal.
 */
function AutomationRuleComposer({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (draft: AutomationRuleDraftInput) => void;
}) {
  const [name, setName] = useState("");
  const [entityLevel, setEntityLevel] = useState<"adset" | "campaign">("adset");
  const [triggerKind, setTriggerKind] =
    useState<(typeof COMPOSER_TRIGGER_KINDS)[number]["value"]>(
      "roas_below_anchor",
    );
  const [anchor, setAnchor] = useState<string>("break_even_roas");
  const [anchorMultiplier, setAnchorMultiplier] = useState("1");
  const [consecutiveDays, setConsecutiveDays] = useState("3");
  const [actionKind, setActionKind] =
    useState<(typeof COMPOSER_ACTIONS)[number]["value"]>("propose_pause");
  const [mode, setMode] = useState<"confirm" | "suggest">("confirm");

  const anchorFamily = triggerKind.startsWith("roas") ? "roas" : "cpa";
  const anchorOptions = COMPOSER_ANCHORS[anchorFamily];
  const anchorValue = anchorOptions.some((option) => option.value === anchor)
    ? anchor
    : anchorOptions[0].value;

  return (
    <form
      className={styles.ruleComposer}
      data-testid="rule-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          name: name.trim(),
          entityLevel,
          trigger: {
            kind: triggerKind,
            anchor: anchorValue as never,
            anchorMultiplier: Number(anchorMultiplier),
            consecutiveDays: Number(consecutiveDays),
          },
          action: { kind: actionKind },
          mode,
        });
      }}
    >
      <div className={styles.ruleComposerGrid}>
        <label className={styles.ruleField}>
          <span>Rule name</span>
          <input
            value={name}
            maxLength={80}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className={styles.ruleField}>
          <span>Level</span>
          <select
            value={entityLevel}
            onChange={(event) =>
              setEntityLevel(event.target.value as "adset" | "campaign")
            }
          >
            <option value="adset">Ad set</option>
            <option value="campaign">Campaign</option>
          </select>
        </label>
        <label className={styles.ruleField}>
          <span>When</span>
          <select
            value={triggerKind}
            onChange={(event) =>
              setTriggerKind(event.target.value as typeof triggerKind)
            }
          >
            {COMPOSER_TRIGGER_KINDS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.ruleField}>
          <span>Anchor</span>
          <select
            value={anchorValue}
            onChange={(event) => setAnchor(event.target.value)}
          >
            {anchorOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.ruleField}>
          <span>Anchor ×</span>
          <input
            type="number"
            min="0.1"
            max="3"
            step="0.05"
            value={anchorMultiplier}
            onChange={(event) => setAnchorMultiplier(event.target.value)}
          />
        </label>
        <label className={styles.ruleField}>
          <span>Consecutive days</span>
          <input
            type="number"
            min="1"
            max="30"
            step="1"
            value={consecutiveDays}
            onChange={(event) => setConsecutiveDays(event.target.value)}
          />
        </label>
        <label className={styles.ruleField}>
          <span>Then</span>
          <select
            value={actionKind}
            onChange={(event) =>
              setActionKind(event.target.value as typeof actionKind)
            }
          >
            {COMPOSER_ACTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.ruleField}>
          <span>Mode</span>
          <select
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as "confirm" | "suggest")
            }
          >
            <option value="confirm">Confirm</option>
            <option value="suggest">Suggest</option>
          </select>
        </label>
      </div>
      <p className={styles.ruleComposerNote}>
        Rules create suggestions for approval. They never change ads on Meta by
        themselves.
      </p>
      {error ? (
        <p className={styles.ruleError} role="status">
          {error}
        </p>
      ) : null}
      <div className={styles.ruleComposerActions}>
        <button type="submit" className={styles.rulePrimary} disabled={busy}>
          Create rule
        </button>
        <button
          type="button"
          className={styles.ruleSecondary}
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The account choice offered by the legacy dashboard shell when scope is
 * unresolved. Selecting an option only writes a request into the URL; the
 * server resolves that id against the business's assignments on the next
 * render before any account-scoped read or write can run.
 */
function AutomationAccountPicker({
  accounts,
  loading,
  onSelect,
}: {
  accounts: MetaHistoryAccount[];
  loading: boolean;
  onSelect: (providerAccountId: string) => void;
}) {
  return (
    <label className={styles.accountPicker} data-control="account-picker">
      <span>Meta ad account</span>
      <select
        aria-label="Meta ad account for Automation"
        value=""
        disabled={loading || accounts.length === 0}
        onChange={(event) => onSelect(event.currentTarget.value)}
      >
        <option value="">
          {loading
            ? "Loading accounts"
            : accounts.length === 0
              ? "No assigned account"
              : "Select account"}
        </option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {automationAccountOptionLabel(account)}
            {account.currency ? ` · ${account.currency}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function automationAccountOptionLabel(account: MetaHistoryAccount): string {
  const name = account.name?.trim() || "Unnamed Meta account";
  return `${name} · ID ${account.id}`;
}

/**
 * Which pane a shared control is being drawn into.
 *
 * Not a permission. Authority is decided by `viewer`, by `resolveStopCeremony`
 * and by the routes; this only chooses reference markers and DOM-id suffixes.
 * The one place a surface IS an authority is
 * `buildBudgetMasterSwitchAuthorization`, which takes its own literal.
 */
type AutomationSurface = "desktop" | "mobile";

export function MetaAutomationView({
  payload,
  providerAccountId = null,
  proposals = EMPTY_AUTOMATION_PROPOSALS_MODEL,
  onProposalControl,
  pendingProposalId = null,
  proposalError = null,
  proposalNotice = null,
  businessId = null,
  onRulesChanged,
  readError = null,
  onRetryRead,
  providerAccounts = [],
  providerAccountsLoading = false,
  onSelectProviderAccount,
  ledgerCompleteness = null,
  viewer = AUTOMATION_VIEWER_NOT_ESTABLISHED,
  stopEngageRefusalReason = null,
  liveWritesRefusalReason = null,
  stateHistoryReadiness = null,
  budgetReadiness = null,
  budgetWriteReadiness = null,
  onBudgetActivationChanged,
}: {
  payload: AutomationPayload | null;
  providerAccountId?: string | null;
  proposals?: AutomationProposalsModel;
  /** Absent on a server render; the controls are then inert rather than fake. */
  onProposalControl?: (
    proposalId: string,
    control: ProposalControl,
    note?: string,
  ) => void;
  pendingProposalId?: string | null;
  proposalError?: string | null;
  /** What the last successful approval actually did. See the state's comment. */
  proposalNotice?: string | null;
  /**
   * Server-authorized scope. Absent means this render has no authority to
   * mutate anything, so the toggle and "+ New rule" stay inert rather than
   * pretending to work.
   */
  businessId?: string | null;
  onRulesChanged?: (next: AutomationPayload) => void;
  /**
   * Why this render has no read, when it has none. Either the control-plane
   * read's own failure code, or the reason no account scope resolved and the
   * read therefore never ran. Every card below em-dashes in that state, and an
   * em dash alone cannot tell an operator whether the read broke, the scope is
   * unresolved, or the fact is genuinely unknown.
   */
  readError?: string | null;
  /** Re-runs the same read. Absent on a server render, where nothing can retry. */
  onRetryRead?: () => void;
  /** Assigned accounts used only by the legacy shell's unresolved-scope picker. */
  providerAccounts?: MetaHistoryAccount[];
  providerAccountsLoading?: boolean;
  /**
   * Requests an account through the URL. Absent on canonical routes, where the
   * shared topbar owns selection and this view must not draw a duplicate.
   */
  onSelectProviderAccount?: (providerAccountId: string) => void;
  /**
   * Whether the LAST decision this session recorded actually reached the
   * ledger. `null` means no decision has been made in this session — which is
   * NOT by itself permission to print the promise; see `ledgerEvidence` below.
   */
  ledgerCompleteness?: "complete" | "unavailable" | null;
  /**
   * The server's answer to "may this viewer write here", restated — never
   * re-derived. Defaults to the not-established envelope so a server render and
   * the preserved legacy mount behave exactly as they did.
   */
  viewer?: AutomationViewerEnvelope;
  /** Server-read: why engaging the Meta Stop is refused, when it is. */
  stopEngageRefusalReason?: string | null;
  /** Why an approved proposal cannot reach Meta. Server fact, not inferred. */
  liveWritesRefusalReason?: string | null;
  /** D077 server-owned recovery readiness; display-only, `null` = unread. */
  stateHistoryReadiness?: StateHistoryCompactionReadiness | null;
  /** D086 server-owned budget readiness; display-only, `null` = unread. */
  budgetReadiness?: BudgetReadinessReadModel | null;
  budgetWriteReadiness?: BudgetWriteReadinessModel | null;
  onBudgetActivationChanged?: () => void;
}) {
  // Modify has no operator-editable field on the proposal itself (a status
  // write declares none), so the only thing it can carry is what the operator
  // wants instead. The note field appears on intent and is absent otherwise, so
  // the design's row geometry is untouched until an operator asks for it.
  const [modifyingProposalId, setModifyingProposalId] = useState<string | null>(
    null,
  );
  const [modificationNote, setModificationNote] = useState("");
  const globalStatus = statusForGlobalKillSwitch(payload);
  const businessStatus = statusForBusinessKillSwitch(payload);
  const businessMasterSwitchState = hasServedBusinessControl(payload)
    ? payload!.businessControl.autoExecutionEnabled
      ? "ON"
      : "OFF"
    : UNKNOWN;

  /**
   * The Stop's own state, and the mutation that changes it.
   *
   * `stopEngaged` is read from the served control rather than held locally: a
   * client-held stop is a stop that only this tab believes in. After either
   * direction the payload is re-read, so what the screen shows next is what the
   * server stored — the read-back, not the request's own optimism.
   */
  const [stopPending, setStopPending] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const stopEngaged = payload?.businessControl.killSwitchEngaged === true;
  /**
   * The confirming read, kept apart from the payload the page holds.
   *
   * `resolveStopCeremony` may only announce a status once a read-back has been
   * taken and has agreed. Holding it here rather than deriving it from
   * `payload` is what makes that possible: the payload changes for many
   * reasons, and a banner keyed off it would eventually congratulate an
   * operator for a change somebody else made.
   *
   * `engaged: null` is the read-back that itself failed — neither success nor
   * failure, and reported as unknown rather than resolved either way.
   */
  const [stopReadBack, setStopReadBack] = useState<{
    intent: "engage" | "release";
    engaged: boolean | null;
    readAt: string;
    error?: string | null;
  } | null>(null);
  /** The direction the operator has opened the typed confirmation for. */
  const [stopConfirm, setStopConfirm] = useState<"engage" | "release" | null>(
    null,
  );
  const [stopTyped, setStopTyped] = useState("");
  /**
   * Why a confirmation that was open is no longer being sent.
   *
   * Not an error and not a refusal of the operator: the state the confirmation
   * was made against changed after they read it. Said out loud, because a form
   * that closes silently reads as a click that was lost.
   */
  const [stopAborted, setStopAborted] = useState<string | null>(null);

  /**
   * The ceremony, resolved from the same reading the screen is drawn from.
   *
   * `preflight` is `sections.businessControl` — the server's own per-section
   * provenance, carrying the instant the read was ATTEMPTED and the error code
   * when it failed. Confirming against anything else would be confirming a
   * screen rather than a system, which is the whole reason the ceremony exists.
   */
  const stopIntent: "engage" | "release" = stopEngaged ? "release" : "engage";
  const stopCeremony = resolveStopCeremony({
    intent: stopIntent,
    viewer: {
      role: viewer.role,
      isReviewer: viewer.reviewerReadOnly,
      demo: viewer.demo,
    },
    currentlyEngaged: sectionIsComplete(payload, "businessControl")
      ? stopEngaged
      : null,
    gateClosedReason: stopEngageRefusalReason ?? null,
    preflight: payload?.sections?.businessControl ?? null,
    // Deliberately no read-back here. This resolution answers "what may this
    // operator do NOW"; the outcome of what they just did is the resolution
    // below, and conflating the two is what made the banner vanish.
    readBack: null,
  });
  /**
   * What happened to the change the operator just made.
   *
   * Resolved for the intent the READ-BACK was taken for, not for the direction
   * the surface currently offers — because a successful engage flips that
   * direction to "release" the moment the payload updates, and a banner keyed
   * off the current direction would disappear at exactly the moment it became
   * true. The two questions are separate and are asked separately.
   */
  const stopOutcome = stopReadBack
    ? resolveStopCeremony({
        intent: stopReadBack.intent,
        viewer: {
          role: viewer.role,
          isReviewer: viewer.reviewerReadOnly,
          demo: viewer.demo,
        },
        // The change already happened; this resolution is about its result, so
        // the pre-change gates are not re-applied to it.
        currentlyEngaged: false,
        readBack: {
          engaged: stopReadBack.engaged,
          readAt: stopReadBack.readAt,
          error: stopReadBack.error ?? null,
        },
      })
    : null;
  const automationStopped =
    payload?.globalKillSwitch.engaged === true || stopEngaged;
  /**
   * The phrase, per DIRECTION rather than per payload.
   *
   * `stopPhrase` used to be derived from `stopIntent`, which is read from the
   * payload every render, while the form posted the direction captured when it
   * was opened. Those are two different facts, and when the payload moved
   * underneath an open form they disagreed: the label read "Type RESUME META to
   * stop Meta automation for this business", and typing the phrase on screen
   * submitted the OTHER direction. Everything the form says and does now comes
   * from `stopConfirm`.
   */
  const stopPhraseFor = (direction: "engage" | "release") =>
    direction === "engage" ? "STOP META" : "RESUME META";
  const stopPhrase = stopPhraseFor(stopConfirm ?? stopIntent);

  const onStopControl = useCallback(
    (action: "engage_kill_switch" | "release_kill_switch") => {
      if (!businessId || !providerAccountId || stopPending) return;
      // The server's refusal, restated before the request. Reaching this line
      // with a refused viewer means something bypassed the DOM, and the route
      // would refuse anyway — but a POST from here would still put a real stop
      // attempt on a reviewer's wire.
      if (!viewer.canMutate) return;
      setStopPending(true);
      setStopError(null);
      setStopReadBack(null);
      const query = new URLSearchParams({ businessId, providerAccountId });
      void fetch(`/api/meta/automation?${query.toString()}`, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "release_kill_switch"
            ? { reason: "Released from the Automation control plane." }
            : { reason: "Engaged from the Automation control plane." }),
        }),
      })
        .then(async (response) => {
          const body = (await response.json().catch(() => null)) as {
            ok?: boolean;
            error?: { message?: string };
          } | null;
          if (!response.ok || body?.ok === false) {
            setStopError(
              "The emergency stop could not be changed. Refresh and try again.",
            );
            return;
          }
          // Re-read rather than trust the request. The control state on screen
          // must be the state the database holds, and only a read proves that.
          const next = await readAutomation({
            businessId,
            providerAccountId,
          }).catch(() => null);
          // Hands the re-read payload to the same channel the rules editor uses
          // to publish one, so the page owns the state and this body still owns
          // none of it.
          if (next) onRulesChanged?.(next);
          /*
           * The read-back, recorded as evidence rather than as optimism.
           *
           * A failed re-read is `engaged: null` — the write was submitted and
           * the confirming read did not answer, which is neither outcome. A
           * re-read that answers something other than the intent is recorded
           * verbatim and the ceremony reports it as unconfirmed; nothing here
           * decides that it "probably worked".
           */
          setStopReadBack({
            intent: action === "engage_kill_switch" ? "engage" : "release",
            engaged: next
              ? next.businessControl.killSwitchEngaged === true
              : null,
            readAt: new Date().toISOString(),
            error: next ? null : "the control plane could not be re-read",
          });
        })
        .catch(() => {
          setStopError(
            "The emergency stop could not be changed. Refresh and try again.",
          );
        })
        .finally(() => setStopPending(false));
    },
    [
      businessId,
      providerAccountId,
      stopPending,
      viewer.canMutate,
      onRulesChanged,
    ],
  );
  /**
   * AUTO-03 — record the autonomy mode for one action kind.
   *
   * The same shape as the stop control above, for the same reasons: refuse
   * locally before putting a refused viewer's attempt on the wire, and then
   * RE-READ rather than trust the request. A ladder that showed what was asked
   * for rather than what was stored would be the exact defect the stop
   * control's own comment warns about.
   *
   * Per row, not per screen: two action kinds can be changed one after the
   * other, and a single pending flag would grey out the row the operator is not
   * touching and attribute the second failure to the first.
   */
  const [modePending, setModePending] = useState<string | null>(null);
  const [modeError, setModeError] = useState<Record<string, string>>({});
  const [modeSaved, setModeSaved] = useState<Record<string, string>>({});

  const onModeChange = useCallback(
    (
      decisionType: MetaAutomationDecisionType,
      mode: MetaAutomationDecisionMode,
    ) => {
      if (!businessId || !providerAccountId || modePending) return;
      if (!viewer.canMutate) return;
      if (mode === "auto" && viewer.role !== "admin") return;
      setModePending(decisionType);
      setModeError((previous) => ({ ...previous, [decisionType]: "" }));
      setModeSaved((previous) => ({ ...previous, [decisionType]: "" }));
      const query = new URLSearchParams({ businessId, providerAccountId });
      void fetch(`/api/meta/automation?${query.toString()}`, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_decision_type_mode",
          decisionType,
          mode,
          reason: "Set from the Automation autonomy ladder.",
        }),
      })
        .then(async (response) => {
          const body = (await response.json().catch(() => null)) as {
            ok?: boolean;
            error?: { message?: string };
          } | null;
          if (!response.ok || body?.ok === false) {
            setModeError((previous) => ({
              ...previous,
              [decisionType]: "Action mode could not be changed.",
            }));
            return;
          }
          const next = await readAutomation({
            businessId,
            providerAccountId,
          }).catch(() => null);
          if (!next) {
            setModeError((previous) => ({
              ...previous,
              [decisionType]:
                "The change was saved, but could not be confirmed. Refresh to check it.",
            }));
            return;
          }
          onRulesChanged?.(next);
          /*
           * Announced off the READ-BACK, never off the 200. The stored mode is
           * the only thing worth confirming, and a confirmation that fires on a
           * response is a confirmation of a request.
           */
          const stored = next.decisionTypeModes?.find(
            (item) => item.decisionType === decisionType,
          );
          setModeSaved((previous) => ({
            ...previous,
            [decisionType]:
              stored?.mode === mode
                ? `Saved — ${MODE_LABELS[mode]}`
                : "Saved, but the current mode could not be confirmed.",
          }));
        })
        .catch(() => {
          setModeError((previous) => ({
            ...previous,
            [decisionType]: "Automation is unavailable.",
          }));
        })
        .finally(() => setModePending(null));
    },
    [
      businessId,
      providerAccountId,
      modePending,
      viewer.canMutate,
      viewer.role,
      onRulesChanged,
    ],
  );

  const guardrails = guardrailsFor(payload, liveWritesRefusalReason);
  // The persisted values themselves, not the formatted rows above: the form
  // has to seed from what is stored, and an unread control seeds from nothing.
  const payloadGuardrails = hasServedBusinessControl(payload)
    ? payload!.businessControl.guardrails
    : null;
  /*
    The same channel every other mutation on this body uses.

    This component owns none of the payload state — the page does — so a save
    re-reads the control plane and publishes the result upward rather than
    holding a second copy that could disagree with the one on screen.
  */
  const onGuardrailPolicySaved = useCallback(async () => {
    if (!businessId || !providerAccountId) return;
    const next = await readAutomation({ businessId, providerAccountId }).catch(
      () => null,
    );
    if (next) onRulesChanged?.(next);
  }, [businessId, providerAccountId, onRulesChanged]);
  const autonomy = autonomyFor(payload);
  const readiness = readinessFor(payload);
  const promotionCount = promotionCountFor(payload);
  const ledger = payload?.activityLedger ?? [];
  // Same law the rules table already follows: an empty collection is only an
  // honest "nothing has happened" when the read proved it. Without provenance
  // a broken activity read and a quiet workspace were the same em dash, so a
  // business with a genuinely empty ledger could never learn that.
  /**
   * A model that does not carry the hold counts did not READ them, so they are
   * unknown — the same law the adapter applies to an absent `holds` field from
   * the server. Normalised here because this component is also rendered
   * directly (server render, tests) with hand-built models, and an absent fact
   * must never crash the surface nor read as zero.
   */
  const queueHolds = proposals.holds ?? null;
  const queueProvenEmpty = proposals.provenEmpty === true;
  const activityState = sectionState(payload, "activity");
  const ledgerIsProvenEmpty = activityState === "complete";
  const ledgerState =
    ledger.length > 0 ? "ready" : ledgerIsProvenEmpty ? "empty" : "unavailable";
  /**
   * Whether the footnote may claim a receipt trail — and it may only claim one
   * where something proves it.
   *
   * Precedence, most direct evidence first:
   *
   *  1. This session watched a decision's ledger write succeed or fail. That is
   *     first-hand and wins.
   *  2. Otherwise the SERVER READ MODEL: `readCompleteness.activityLedger` is
   *     the control plane's own answer for whether the ledger could be read at
   *     all, and it survives a reload because it arrives with every render.
   *  3. Otherwise nothing is known.
   *
   * `no_evidence` exists because the two-state version was wrong in both
   * directions after a refresh. `null` used to print "every outcome lands in
   * the ledger with a receipt" off no evidence whatsoever; printing the
   * `unavailable` copy instead would be just as wrong, because it asserts that
   * a decision failed when no decision was made. So the middle clause — the
   * only one that is a claim about evidence — is simply not made.
   */
  const ledgerEvidence: "complete" | "unavailable" | "no_evidence" =
    ledgerCompleteness === "unavailable"
      ? "unavailable"
      : ledgerCompleteness === "complete"
        ? "complete"
        : payload?.readCompleteness?.activityLedger === "complete"
          ? "complete"
          : "no_evidence";
  const readFailure = readFailureFor({ payload, readError });
  const showCanonicalReadinessCopy =
    hasServedBusinessControl(payload) &&
    payload!.businessControl.readinessTier === "manual_review";

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);
  const [pendingRuleId, setPendingRuleId] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);

  /**
   * Nothing here may act without a resolved account.
   *
   * Every write this screen can issue is account-scoped — the rules routes and
   * the proposal queue both refuse a request whose account does not resolve —
   * so a control rendered live while `providerAccountId` is null is a control
   * that can only fail. It is disabled instead, which is the honest shape of
   * "choose an account first".
   */
  const accountResolved = Boolean(providerAccountId);
  /**
   * Three independent conditions, and every write control on this screen needs
   * all three: a server-authorized business scope, a resolved ad account, and a
   * viewer the SERVER says may write. The third was missing entirely — a guest,
   * a reviewer and a demo session all got live Approve / Modify / Dismiss /
   * + New rule / toggle controls the moment an account resolved, and learned
   * about the refusal from a 403 after the click.
   */
  const canMutate = Boolean(businessId) && accountResolved && viewer.canMutate;
  const automationStatus =
    businessMasterSwitchState === UNKNOWN
      ? "Unavailable"
      : automationStopped
        ? "Stopped"
        : businessMasterSwitchState === "OFF"
          ? "Off"
          : payload?.execution.autoExecutionAllowed
            ? "On"
            : "Needs setup";
  const automationStatusCopy =
    automationStatus === "On"
      ? "Eligible Meta actions can run automatically within your saved limits."
      : automationStatus === "Off"
        ? "Adsecute can recommend changes, but nothing runs automatically."
        : automationStatus === "Stopped"
          ? "All automatic Meta actions are paused for this business."
          : automationStatus === "Needs setup"
            ? "Automatic actions are selected, but setup still needs attention."
            : "Automation status is unavailable. Refresh before making a change.";
  const automationStateAvailable = hasServedBusinessControl(payload);
  const decisionModesState = sectionState(payload, "decisionModes");
  const actionModesAvailable =
    automationStateAvailable && decisionModesState === "complete";
  // A missing account or failed control read makes the whole mobile surface
  // look unavailable. State the specific cause once, keep the one invariant
  // the operator can still use (launches always require approval), and retain
  // any queue/activity data that was independently proven by its own read.
  const collapseMobileUnavailable =
    Boolean(readFailure) && !automationStateAvailable;
  const mobileQueueHasUsefulState =
    proposals.rows.length > 0 ||
    queueProvenEmpty ||
    Boolean(queueHolds && (queueHolds.claimed > 0 || queueHolds.reconcile > 0));
  const mobileActivityHasUsefulState = ledger.length > 0 || ledgerIsProvenEmpty;

  const rules = buildAutomationRulesViewModel({
    payload,
    // Creation needs a proven read, a server-authorized scope AND a resolved
    // account. Without any of them the control is present but inert — the
    // design's geometry with none of its authority.
    canCreate: canMutate && sectionIsComplete(payload, "rules"),
  });

  async function toggleRule(row: AutomationRuleRowViewModel) {
    // `canMutate` as well as the scope narrowing: a refused viewer must issue
    // no request at all, not one the route will refuse.
    if (!canMutate || !businessId || row.locked || pendingRuleId) return;
    setPendingRuleId(row.id);
    setRuleError(null);
    try {
      const next = await setAutomationRuleActiveRequest({
        businessId,
        providerAccountId,
        ruleId: row.id,
        active: !row.active,
      });
      onRulesChanged?.(next);
    } catch {
      setRuleError("The rule could not be changed. Try again.");
    } finally {
      setPendingRuleId(null);
    }
  }

  async function createRule(draft: AutomationRuleDraftInput) {
    if (!canMutate || !businessId || composerBusy) return;
    setComposerBusy(true);
    setRuleError(null);
    try {
      const next = await createAutomationRuleRequest({
        businessId,
        providerAccountId,
        rule: draft,
      });
      onRulesChanged?.(next);
      setComposerOpen(false);
    } catch {
      setRuleError("The rule could not be created. Try again.");
    } finally {
      setComposerBusy(false);
    }
  }

  const renderActionModes = (surface: AutomationSurface) => (
    <article
      className={styles.autonomyCard}
      data-testid={`automation-action-modes-${surface}`}
      data-action-modes-state={
        actionModesAvailable ? "available" : "unavailable"
      }
    >
      <div className={styles.sectionHeaderCompact}>
        <h2>Action modes</h2>
      </div>
      {!actionModesAvailable &&
      !(surface === "mobile" && collapseMobileUnavailable) ? (
        <div
          className={styles.autonomyUnavailable}
          data-field="action-modes-unavailable"
        >
          <span>Current modes</span>
          <strong>Unavailable</strong>
        </div>
      ) : null}
      {autonomy.map((item) => {
        if (!actionModesAvailable && item.decisionType) return null;
        const current = item.decisionType
          ? currentModeFor(payload, item.decisionType)
          : null;
        return (
          <div
            className={styles.autonomyRow}
            data-decision-type={item.decisionType ?? "launch"}
            key={`${surface}-${item.kind}`}
          >
            <div className={styles.autonomyTopline}>
              <span className={styles.autonomyKind}>{item.kind}</span>
              {!item.decisionType ? (
                <span className={styles.autonomyTier} data-tone="manual">
                  Always manual
                </span>
              ) : surface === "mobile" ? (
                <span className={styles.autonomyTier} data-tone={item.tone}>
                  {current ? MODE_SEGMENT_LABELS[current] : "Not set"}
                </span>
              ) : null}
            </div>
            {item.decisionType && surface === "desktop" ? (
              <div
                className={styles.modeGroup}
                role="radiogroup"
                aria-label={`Action mode — ${item.kind}`}
                data-ctl="gated:AUTO-03 mode"
              >
                {AUTONOMY_MODES.map((mode) => {
                  const refused =
                    !canMutate || (mode === "auto" && viewer.role !== "admin");
                  const refusalMessage = !canMutate
                    ? !businessId
                      ? "Choose a business and Meta ad account first."
                      : !accountResolved
                        ? "Choose a Meta ad account first."
                        : automationRefusalMessage(viewer.reasonCode)
                    : mode === "auto" && viewer.role !== "admin"
                      ? "Admin access is required to turn on automatic actions."
                      : undefined;
                  return (
                    <button
                      key={mode}
                      type="button"
                      className={styles.modeSegment}
                      role="radio"
                      aria-checked={current === mode}
                      data-mode={mode}
                      data-mode-refused={refused ? "" : undefined}
                      disabled={refused || modePending === item.decisionType}
                      title={refusalMessage}
                      aria-label={MODE_LABELS[mode]}
                      onClick={() => onModeChange(item.decisionType!, mode)}
                    >
                      {MODE_SEGMENT_LABELS[mode]}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {item.decisionType && modeError[item.decisionType] ? (
              <p
                className={styles.autonomyNext}
                data-field={`mode-error-${item.decisionType}`}
                role="status"
              >
                {modeError[item.decisionType]}
              </p>
            ) : null}
            {item.decisionType && modeSaved[item.decisionType] ? (
              <p
                className={styles.autonomyNext}
                data-field={`mode-saved-${item.decisionType}`}
                role="status"
              >
                {modeSaved[item.decisionType]}
              </p>
            ) : null}
          </div>
        );
      })}
    </article>
  );

  const renderRecentActivity = (surface: AutomationSurface) => (
    <article
      className={styles.ledgerCard}
      data-testid={`automation-recent-activity-${surface}`}
      data-ledger-state={ledgerState}
    >
      <div className={styles.ledgerHeader}>
        <h2>Recent activity</h2>
      </div>
      <div
        className={styles.tableScroll}
        role="region"
        tabIndex={0}
        aria-label={
          surface === "mobile" && ledgerState !== "ready"
            ? "Recent activity"
            : "Recent activity table, scrolls sideways"
        }
      >
        <table className={styles.ledgerTable}>
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Item</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {ledger.length > 0 ? (
              ledger.slice(0, 8).map((item) => {
                const result = ledgerResultFor(item);
                return (
                  <tr data-ledger-id={item.id} key={`${surface}-${item.id}`}>
                    <td className={styles.ledgerTime}>
                      {formatLedgerTime(item.createdAt)}
                    </td>
                    <td className={styles.ledgerAction}>
                      {ledgerActionFor(item)}
                    </td>
                    <td data-field="ledger-entity">{ledgerEntityFor(item)}</td>
                    <td>
                      <span
                        className={styles.ledgerResult}
                        data-field="ledger-result"
                        data-tone={result.tone}
                      >
                        {result.label}
                      </span>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr
                className={styles.ledgerEmpty}
                data-testid="ledger-empty"
                data-proven-empty={ledgerIsProvenEmpty ? "true" : "false"}
              >
                <td colSpan={4}>
                  {ledgerIsProvenEmpty
                    ? "No recent activity"
                    : "Activity is unavailable"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </article>
  );

  return (
    <div className={styles.page}>
      <section
        className={`${styles.desktopSurface} ${styles.automation}`}
        data-screen-label="Automation"
        data-testid="automation-exact-desktop"
      >
        <header>
          <h1 className={styles.title}>Automation</h1>
          <p className={styles.pageIntro}>
            Choose which Meta actions need approval and which can run
            automatically.
          </p>
        </header>

        <article
          className={styles.operatingState}
          data-testid="automation-operating-state"
          data-business-master-switch={businessMasterSwitchState.toLowerCase()}
          data-operating-state={
            automationStateAvailable ? "available" : "unavailable"
          }
        >
          <div>
            <p className={styles.operatingStateEyebrow}>Status</p>
            <h2>{automationStatus}</h2>
            {readFailure ? (
              <p
                className={styles.readError}
                role="status"
                data-field="read-error"
                data-reason={readFailure}
              >
                <span>
                  {readFailure === "provider_account_scope_unresolved" &&
                  onSelectProviderAccount
                    ? "Choose a Meta ad account below to see its automation status."
                    : readFailureMessage(readFailure)}
                </span>
                {readFailure === "provider_account_scope_unresolved" &&
                onSelectProviderAccount &&
                !providerAccountId ? (
                  <AutomationAccountPicker
                    accounts={providerAccounts}
                    loading={providerAccountsLoading}
                    onSelect={onSelectProviderAccount}
                  />
                ) : null}
                <button
                  type="button"
                  className={styles.readRetry}
                  data-control="retry-read"
                  disabled={!onRetryRead}
                  onClick={onRetryRead}
                >
                  Retry
                </button>
              </p>
            ) : (
              <p>{automationStatusCopy}</p>
            )}
          </div>
          {automationStateAvailable ? (
            <dl>
              <div>
                <dt>Pending approvals</dt>
                <dd>{proposals.count}</dd>
              </div>
              <div>
                <dt>Emergency stop</dt>
                <dd>{automationStopped ? "Active" : "Not active"}</dd>
              </div>
            </dl>
          ) : null}
        </article>

        {renderActionModes("desktop")}

        <ConfirmationQueue
          surface="desktop"
          proposals={proposals}
          canMutate={canMutate}
          onProposalControl={onProposalControl}
          pendingProposalId={pendingProposalId}
          proposalError={proposalError}
          proposalNotice={proposalNotice}
          modifyingProposalId={modifyingProposalId}
          setModifyingProposalId={setModifyingProposalId}
          modificationNote={modificationNote}
          setModificationNote={setModificationNote}
          queueHolds={queueHolds}
          queueProvenEmpty={queueProvenEmpty}
          onRetryRead={onRetryRead}
          viewer={viewer}
          ledgerEvidence={ledgerEvidence}
        />

        {renderRecentActivity("desktop")}

        <details className={styles.advancedAutomation}>
          <summary>
            <span>Controls and limits</span>
          </summary>
          <div className={styles.advancedAutomationBody}>
            <div className={styles.summaryGrid}>
              <article className={styles.killCard}>
                <p className={styles.cardKickerDark}>Emergency stop</p>
                <div className={styles.killRow}>
                  <span>Status</span>
                  <span
                    className={styles.statusPill}
                    data-tone={businessStatus.tone}
                    data-field="business-writes"
                  >
                    {automationStateAvailable
                      ? stopEngaged
                        ? "ON"
                        : "OFF"
                      : "Unavailable"}
                  </span>
                </div>
                <MetaStopControl
                  surface="desktop"
                  payload={payload}
                  viewer={viewer}
                  stopEngaged={stopEngaged}
                  stopPending={stopPending}
                  stopError={stopError}
                  stopConfirm={stopConfirm}
                  stopTyped={stopTyped}
                  stopAborted={stopAborted}
                  stopIntent={stopIntent}
                  stopCeremony={stopCeremony}
                  stopOutcome={stopOutcome}
                  stopEngageRefusalReason={stopEngageRefusalReason}
                  stopPhraseFor={stopPhraseFor}
                  setStopConfirm={setStopConfirm}
                  setStopTyped={setStopTyped}
                  setStopAborted={setStopAborted}
                  onStopControl={onStopControl}
                />
              </article>

              <article
                className={styles.guardrailCard}
                data-el="guardrails-readonly"
              >
                <p className={styles.cardKicker}>Limits</p>
                <div data-collection="guardrails">
                  {guardrails.map((guardrail) => (
                    <div
                      className={styles.guardrailRow}
                      data-field={`guardrail-${guardrail.key}`}
                      key={guardrail.key}
                    >
                      <span>{guardrail.label}</span>
                      <strong>{guardrail.value}</strong>
                    </div>
                  ))}
                </div>
                {automationStateAvailable &&
                canMutate &&
                viewer.role === "admin" ? (
                  <GuardrailPolicyForm
                    businessId={businessId}
                    providerAccountId={providerAccountId}
                    canMutate={automationStateAvailable && canMutate}
                    minRoasFloor={payloadGuardrails?.minRoasFloor ?? null}
                    quietHours={payloadGuardrails?.quietHours ?? null}
                    onSaved={onGuardrailPolicySaved}
                  />
                ) : null}
              </article>
            </div>

            <BudgetWriteReadinessSection
              readiness={budgetWriteReadiness}
              authorization={buildBudgetMasterSwitchAuthorization({
                viewer,
                surface: "desktop",
              })}
              onActivationChanged={onBudgetActivationChanged}
            />
          </div>
        </details>

        <details className={styles.advancedAutomation}>
          <summary>
            <span>Custom rules</span>
          </summary>
          <div className={styles.advancedAutomationBody}>
            <article className={styles.rulesCard}>
              <div className={styles.sectionHeader}>
                <h2>Custom rules</h2>
                <button
                  type="button"
                  className={styles.newRule}
                  disabled={!rules.canCreate || composerOpen}
                  aria-disabled={!rules.canCreate || composerOpen}
                  aria-expanded={composerOpen}
                  onClick={
                    rules.canCreate ? () => setComposerOpen(true) : undefined
                  }
                >
                  + New rule
                </button>
              </div>
              <div
                className={styles.tableScroll}
                role="region"
                tabIndex={0}
                aria-label="Custom rules table, scrolls sideways"
              >
                <table className={styles.rulesTable}>
                  <thead>
                    <tr>
                      <th>Rule</th>
                      <th>Then</th>
                      <th>Mode</th>
                      <th>Fired · 28d</th>
                      <th>Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.rows && rules.rows.length > 0 ? (
                      rules.rows.map((row) => (
                        <AutomationRuleRow
                          key={row.id}
                          row={row}
                          busy={pendingRuleId === row.id}
                          canMutate={canMutate}
                          onToggle={() => void toggleRule(row)}
                        />
                      ))
                    ) : (
                      <tr
                        className={styles.rulesEmpty}
                        data-testid="rules-empty"
                        data-proven-empty={
                          rules.isProvenEmpty ? "true" : "false"
                        }
                      >
                        <td colSpan={5}>
                          {rules.isProvenEmpty ? "No custom rules" : UNKNOWN}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {composerOpen ? (
                <AutomationRuleComposer
                  busy={composerBusy}
                  error={ruleError}
                  onCancel={() => {
                    setComposerOpen(false);
                    setRuleError(null);
                  }}
                  onSubmit={(draft) => void createRule(draft)}
                />
              ) : ruleError ? (
                <p className={styles.ruleError} role="status">
                  {ruleError}
                </p>
              ) : null}
            </article>
          </div>
        </details>
      </section>

      <section
        className={styles.mobileSurface}
        data-testid="meta-mobile-automation"
        data-read-only="false"
        aria-labelledby="automation-mobile-title"
      >
        <h1 id="automation-mobile-title">Automation</h1>
        {readFailure ? (
          <div
            className={styles.mobileReadRecovery}
            data-testid="automation-mobile-read-recovery"
            data-field="read-error"
            data-reason={readFailure}
          >
            <p role="status">
              {readFailure === "provider_account_scope_unresolved" &&
              onSelectProviderAccount
                ? "Choose a Meta ad account below to see its automation status."
                : readFailureMessage(readFailure)}
            </p>
            {readFailure === "provider_account_scope_unresolved" &&
            onSelectProviderAccount &&
            !providerAccountId ? (
              <AutomationAccountPicker
                accounts={providerAccounts}
                loading={providerAccountsLoading}
                onSelect={onSelectProviderAccount}
              />
            ) : null}
            <button
              type="button"
              className={styles.readRetry}
              data-control="retry-read"
              disabled={!onRetryRead}
              onClick={onRetryRead}
            >
              Retry
            </button>
          </div>
        ) : null}
        {!collapseMobileUnavailable ? (
          <>
            <p className={styles.mobileIntro}>{automationStatusCopy}</p>
            <dl className={styles.mobileFacts}>
              <div>
                <dt>Status</dt>
                <dd>{automationStatus}</dd>
              </div>
              {automationStateAvailable ? (
                <>
                  <div>
                    <dt>Pending approvals</dt>
                    <dd>{proposals.count}</dd>
                  </div>
                  <div>
                    <dt>Emergency stop</dt>
                    <dd>{automationStopped ? "Active" : "Not active"}</dd>
                  </div>
                </>
              ) : null}
            </dl>
          </>
        ) : null}

        {renderActionModes("mobile")}

        {!collapseMobileUnavailable ? (
          <div className={styles.mobileStop} data-testid="mobile-stop-control">
            <MetaStopControl
              surface="mobile"
              payload={payload}
              viewer={viewer}
              stopEngaged={stopEngaged}
              stopPending={stopPending}
              stopError={stopError}
              stopConfirm={stopConfirm}
              stopTyped={stopTyped}
              stopAborted={stopAborted}
              stopIntent={stopIntent}
              stopCeremony={stopCeremony}
              stopOutcome={stopOutcome}
              stopEngageRefusalReason={stopEngageRefusalReason}
              stopPhraseFor={stopPhraseFor}
              setStopConfirm={setStopConfirm}
              setStopTyped={setStopTyped}
              setStopAborted={setStopAborted}
              onStopControl={onStopControl}
            />
          </div>
        ) : null}

        {!collapseMobileUnavailable || mobileQueueHasUsefulState ? (
          <ConfirmationQueue
            surface="mobile"
            proposals={proposals}
            canMutate={canMutate}
            onProposalControl={onProposalControl}
            pendingProposalId={pendingProposalId}
            proposalError={proposalError}
            proposalNotice={proposalNotice}
            modifyingProposalId={modifyingProposalId}
            setModifyingProposalId={setModifyingProposalId}
            modificationNote={modificationNote}
            setModificationNote={setModificationNote}
            queueHolds={queueHolds}
            queueProvenEmpty={queueProvenEmpty}
            onRetryRead={onRetryRead}
            viewer={viewer}
            ledgerEvidence={ledgerEvidence}
          />
        ) : null}

        {!collapseMobileUnavailable || mobileActivityHasUsefulState
          ? renderRecentActivity("mobile")
          : null}
      </section>
    </div>
  );
}

interface ProposalQueueRead {
  readCompleteness: "complete" | "unavailable";
  proposals: MetaAutomationProposal[];
  /**
   * The server's claimed/reconcile hold counts. `null` is UNKNOWN, never zero:
   * a hold read that failed must not license the queue to call itself empty.
   */
  holds: MetaAutomationProposalHoldCounts | null;
}

const UNAVAILABLE_QUEUE: ProposalQueueRead = {
  readCompleteness: "unavailable",
  proposals: [],
  holds: null,
};

/**
 * `holds` only if the server actually counted both statuses.
 *
 * A partially shaped object, a negative, a non-finite or an absent field is
 * unknown — and unknown is `null`, because the only thing this value is used
 * for is deciding whether the queue may claim to be empty.
 */
function parseHolds(value: unknown): MetaAutomationProposalHoldCounts | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { claimed?: unknown; reconcile?: unknown };
  const claimed = raw.claimed;
  const reconcile = raw.reconcile;
  if (
    typeof claimed !== "number" ||
    typeof reconcile !== "number" ||
    !Number.isFinite(claimed) ||
    !Number.isFinite(reconcile) ||
    claimed < 0 ||
    reconcile < 0
  ) {
    return null;
  }
  return { claimed, reconcile };
}

function parseProposalQueue(body: unknown): ProposalQueueRead {
  const payload = body as {
    ok?: boolean;
    readCompleteness?: { proposals?: string };
    sections?: { proposals?: { status?: string } };
    holds?: unknown;
    proposals?: MetaAutomationProposal[];
  } | null;
  // The server has always sent this beside the queue and this function used to
  // throw it away, so a queue holding a live dispatch (`claimed`) or an
  // unreconciled provider outcome (`reconcile`) arrived here as an empty array
  // and rendered as a proven `0`.
  const holds = parseHolds(payload?.holds);
  // The richer per-section envelope wins where the server sends one, and the
  // flat flag is the fallback for a server that does not. Neither may be
  // absent AND treated as complete.
  const status =
    payload?.sections?.proposals?.status ??
    payload?.readCompleteness?.proposals ??
    null;
  // An `unavailable` read is not an empty queue, and the two must not be
  // collapsed here: the count badge says `—` for one and `0` for the other.
  if (
    payload?.ok !== true ||
    status !== "complete" ||
    !Array.isArray(payload.proposals)
  ) {
    return { ...UNAVAILABLE_QUEUE, holds };
  }
  return { readCompleteness: "complete", proposals: payload.proposals, holds };
}

async function readProposalQueue(input: {
  businessId: string;
  providerAccountId: string;
  signal?: AbortSignal;
}): Promise<ProposalQueueRead> {
  const query = new URLSearchParams({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  const response = await fetch(
    `/api/meta/automation/proposals?${query.toString()}`,
    { cache: "no-store", credentials: "same-origin", signal: input.signal },
  );
  if (!response.ok) return UNAVAILABLE_QUEUE;
  return parseProposalQueue(await response.json().catch(() => null));
}

/**
 * The two guardrails an operator could read and not set.
 *
 * `minRoasFloor` decides whether a pause is proposed at all, and quiet hours
 * decide when an alert may interrupt someone. Both are persisted, both are
 * enforced on the server, and until now neither had a control — so in practice
 * they belonged to whoever last edited the row directly.
 *
 * Blank clears. That is the same shape the route already accepts (`null` to
 * clear) and it keeps "no floor" expressible: an operator who wants automation
 * to consider every losing entity should not have to invent a number to say so.
 */
function GuardrailPolicyForm({
  businessId,
  providerAccountId,
  canMutate,
  minRoasFloor,
  quietHours,
  onSaved,
}: {
  businessId: string | null;
  providerAccountId: string | null;
  canMutate: boolean;
  minRoasFloor: number | null;
  quietHours: { start: string; end: string; timezone: string } | null;
  onSaved: () => void | Promise<void>;
}) {
  const [floor, setFloor] = useState(
    minRoasFloor === null ? "" : String(minRoasFloor),
  );
  const [start, setStart] = useState(quietHours?.start ?? "");
  const [end, setEnd] = useState(quietHours?.end ?? "");
  const [zone, setZone] = useState(quietHours?.timezone ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const ready = Boolean(businessId && providerAccountId && canMutate);
  const trimmedFloor = floor.trim();
  const parsedFloor = trimmedFloor === "" ? null : Number(trimmedFloor);
  const floorValid =
    parsedFloor === null || (Number.isFinite(parsedFloor) && parsedFloor > 0);
  // A window needs all three or none of them: two thirds of a quiet window is
  // not a window, and the route refuses it.
  const windowParts = [start.trim(), end.trim(), zone.trim()];
  const windowValid =
    windowParts.every((part) => part === "") ||
    windowParts.every((part) => part !== "");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || busy || !floorValid || !windowValid) return;
    setBusy(true);
    setMessage(null);
    const query = new URLSearchParams({
      businessId: businessId!,
      providerAccountId: providerAccountId!,
    });
    try {
      const response = await fetch(`/api/meta/automation?${query.toString()}`, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_guardrail_policy",
          minRoasFloor: parsedFloor,
          quietHours: windowParts[0]
            ? {
                start: windowParts[0],
                end: windowParts[1],
                timezone: windowParts[2],
              }
            : null,
          reason: "Set from the Automation guardrails card.",
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!response.ok || body?.ok === false) {
        setMessage("Limits could not be saved.");
        return;
      }
      setMessage("Saved.");
      await onSaved();
    } catch {
      setMessage("Limits could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: "5px 8px",
    borderRadius: 6,
    border: "1px solid var(--border, #e5e7eb)",
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    fontSize: 12,
  };

  return (
    <form
      data-testid="guardrail-policy-form"
      data-can-mutate={String(ready)}
      onSubmit={submit}
      style={{
        marginTop: 10,
        paddingTop: 10,
        borderTop: "1px solid var(--border, #e5e7eb)",
      }}
    >
      <p style={{ margin: 0, fontSize: 12, fontWeight: 600 }}>
        Pause threshold and quiet hours
      </p>
      <div style={{ display: "grid", gap: 8, margin: "8px 0 0" }}>
        <label style={{ display: "grid", gap: 3, fontSize: 11.5 }}>
          Pause below ROAS
          <input
            type="text"
            inputMode="decimal"
            data-testid="guardrail-roas-floor"
            value={floor}
            onChange={(event) => setFloor(event.target.value)}
            disabled={!ready || busy}
            aria-label="Pause below ROAS"
            aria-invalid={!floorValid}
            style={inputStyle}
          />
        </label>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1.4fr",
            gap: 6,
          }}
        >
          <label style={{ display: "grid", gap: 3, fontSize: 11.5 }}>
            Quiet from
            <input
              type="text"
              placeholder="22:00"
              data-testid="guardrail-quiet-start"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              disabled={!ready || busy}
              aria-label="Quiet hours start"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 3, fontSize: 11.5 }}>
            until
            <input
              type="text"
              placeholder="07:00"
              data-testid="guardrail-quiet-end"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              disabled={!ready || busy}
              aria-label="Quiet hours end"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 3, fontSize: 11.5 }}>
            in timezone
            <input
              type="text"
              placeholder="Europe/Istanbul"
              data-testid="guardrail-quiet-timezone"
              value={zone}
              onChange={(event) => setZone(event.target.value)}
              disabled={!ready || busy}
              aria-label="Quiet hours timezone"
              style={inputStyle}
            />
          </label>
        </div>
      </div>
      {!floorValid ? (
        <p
          data-field="guardrail-floor-invalid"
          style={{ margin: "6px 0 0", fontSize: 11.5 }}
        >
          A floor is a positive number, or blank to clear it.
        </p>
      ) : null}
      {!windowValid ? (
        <p
          data-field="guardrail-window-invalid"
          style={{ margin: "6px 0 0", fontSize: 11.5 }}
        >
          A quiet window needs a start, an end and a timezone — or none of them.
        </p>
      ) : null}
      <button
        type="submit"
        data-testid="guardrail-policy-save"
        disabled={!ready || busy || !floorValid || !windowValid}
        aria-disabled={!ready || busy || !floorValid || !windowValid}
        style={{
          margin: "8px 0 0",
          padding: "6px 10px",
          borderRadius: 6,
          border: "1px solid var(--border, #e5e7eb)",
          background: "transparent",
          fontSize: 12,
          cursor: ready && !busy ? "pointer" : "not-allowed",
          opacity: ready && !busy && floorValid && windowValid ? 1 : 0.55,
        }}
      >
        Save limits
      </button>
      {message ? (
        <p
          data-field="guardrail-policy-message"
          style={{ margin: "6px 0 0", fontSize: 11.5 }}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}

async function readAutomation(input: {
  businessId: string;
  providerAccountId: string;
  signal?: AbortSignal;
}) {
  const query = new URLSearchParams({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  const response = await fetch(`/api/meta/automation?${query.toString()}`, {
    cache: "no-store",
    credentials: "same-origin",
    signal: input.signal,
  });
  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    automation?: AutomationPayload;
    error?: { code?: string };
  } | null;
  if (!response.ok || body?.ok === false || !body?.automation) {
    /**
     * Carry the server's own code instead of one sentence for every failure.
     *
     * The route distinguishes an unassigned account, a requested account that
     * belongs to someone else, an unreadable assignment source, a 401 and a
     * crashed contract — and all five arrived here as the same string, so the
     * screen told an operator whose token had expired that "Automation could
     * not be read", which is true and useless. `READ_FAILURE_MESSAGES` has had
     * a sentence per code all along; nothing was reaching it.
     *
     * An unreadable body still degrades to the general code rather than
     * inventing a specific one — the failure is real either way, and guessing
     * WHICH failure would be a new lie in place of the old one.
     */
    throw new AutomationReadError(
      body?.error?.code?.trim() || "automation_control_plane_unavailable",
    );
  }
  return body.automation;
}

/** Carries the server's failure code to the render, nothing else. */
class AutomationReadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AutomationReadError";
  }
}

function formatFenceBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "unavailable";
  }
  return `${value.toLocaleString("en-US")} B`;
}

/**
 * D086 — server-owned budget-readiness facts for the three retention blockers
 * D085 r16 left open, rendered verbatim on both surfaces.
 *
 * Display-only in the same sense as the D077 section beside it: this component
 * renders `status`, `evidence`, `source`, `asOf`, `coverage` and `blocker`
 * exactly as the server produced them. It computes no readiness, no buyerAction,
 * no role, no eligibility and no confidence; it derives nothing from a campaign
 * name; and it offers no affordance that could start a capture, a migration or a
 * provider call. A missing read model renders as unavailable, never as ready.
 */
export function BudgetReadinessSection({
  readiness,
}: {
  readiness: BudgetReadinessReadModel | null;
}) {
  return (
    <article
      data-testid="budget-readiness"
      data-display-only="true"
      style={{
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 12,
        padding: "12px 14px",
        display: "grid",
        gap: 6,
      }}
    >
      <h2 style={{ fontSize: 14, margin: 0 }}>
        Decision-input retention readiness
      </h2>
      {readiness === null ? (
        <p data-testid="budget-readiness-unavailable" style={{ margin: 0 }}>
          Readiness read unavailable — no server fact to display.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 8, fontSize: 12 }}>
          {readiness.dimensions.map((dimension) => (
            <dl
              key={dimension.key}
              data-testid={`budget-readiness-${dimension.key}`}
              data-status={dimension.status}
              data-blocker={dimension.blocker ?? ""}
              data-truncated={
                dimension.coverage === null
                  ? "unknown"
                  : String(dimension.coverage.truncated)
              }
              data-complete-run-attested={
                dimension.coverage?.universe
                  ? String(dimension.coverage.universe.completeRunAttested)
                  : "not-applicable"
              }
              data-conflicts={
                dimension.coverage === null
                  ? "unknown"
                  : String(dimension.coverage.conflicts)
              }
              style={{ margin: 0, display: "grid", gap: 2 }}
            >
              <div>
                <dt style={{ fontWeight: 600, display: "inline" }}>Status: </dt>
                <dd
                  data-field="status"
                  style={{ display: "inline", margin: 0 }}
                >
                  {dimension.status}
                </dd>
              </div>
              <div>
                <dt style={{ fontWeight: 600, display: "inline" }}>
                  Evidence:{" "}
                </dt>
                <dd
                  data-field="evidence"
                  style={{ display: "inline", margin: 0 }}
                >
                  {dimension.evidence}
                </dd>
              </div>
              <div>
                <dt style={{ fontWeight: 600, display: "inline" }}>Source: </dt>
                <dd
                  data-field="source"
                  style={{ display: "inline", margin: 0 }}
                >
                  {dimension.source}
                </dd>
              </div>
              <div>
                <dt style={{ fontWeight: 600, display: "inline" }}>As of: </dt>
                <dd data-field="as-of" style={{ display: "inline", margin: 0 }}>
                  {dimension.asOf ?? "unknown"}
                </dd>
              </div>
              {/*
                STRUCTURED, not prose. The r3 component rendered only
                "qualifying of examined" while the population, the truncation
                state and the conflict count lived in an English sentence — so a
                truncated or conflicted measurement looked like a plain count.
              */}
              <div>
                <dt style={{ fontWeight: 600, display: "inline" }}>
                  Qualifying:{" "}
                </dt>
                <dd
                  data-field="qualifying"
                  style={{ display: "inline", margin: 0 }}
                >
                  {dimension.coverage === null
                    ? "unknown"
                    : dimension.coverage.qualifying}
                </dd>
              </div>
              <div>
                <dt style={{ fontWeight: 600, display: "inline" }}>
                  Examined:{" "}
                </dt>
                <dd
                  data-field="examined"
                  style={{ display: "inline", margin: 0 }}
                >
                  {dimension.coverage === null
                    ? "unknown"
                    : dimension.coverage.examined}
                </dd>
              </div>
              <div>
                <dt style={{ fontWeight: 600, display: "inline" }}>
                  Population:{" "}
                </dt>
                <dd
                  data-field="population"
                  style={{ display: "inline", margin: 0 }}
                >
                  {dimension.coverage === null ||
                  dimension.coverage.population === null
                    ? "unknown"
                    : dimension.coverage.population}
                </dd>
              </div>
              <div>
                <dt style={{ fontWeight: 600, display: "inline" }}>
                  Truncated:{" "}
                </dt>
                <dd
                  data-field="truncated"
                  style={{ display: "inline", margin: 0 }}
                >
                  {dimension.coverage === null
                    ? "unknown"
                    : String(dimension.coverage.truncated)}
                </dd>
              </div>
              <div>
                <dt style={{ fontWeight: 600, display: "inline" }}>
                  Conflicts:{" "}
                </dt>
                <dd
                  data-field="conflicts"
                  style={{ display: "inline", margin: 0 }}
                >
                  {dimension.coverage === null
                    ? "unknown"
                    : dimension.coverage.conflicts}
                </dd>
              </div>
              {/*
                THE OWNER UNIVERSE, as structured fields.

                r4 added these counts to the model and then rendered none of them:
                they survived only inside an English evidence sentence, so an
                uncovered owner or an uncaptured owner mode was invisible to a
                reader scanning the numbers.
              */}
              {dimension.coverage?.universe ? (
                <>
                  <div>
                    <dt style={{ fontWeight: 600, display: "inline" }}>
                      Retained rows:{" "}
                    </dt>
                    <dd
                      data-field="retained-rows"
                      style={{ display: "inline", margin: 0 }}
                    >
                      {dimension.coverage.universe.retainedRows}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ fontWeight: 600, display: "inline" }}>
                      Applicable owners:{" "}
                    </dt>
                    <dd
                      data-field="applicable"
                      style={{ display: "inline", margin: 0 }}
                    >
                      {dimension.coverage.universe.applicable}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ fontWeight: 600, display: "inline" }}>
                      Proven non-owner:{" "}
                    </dt>
                    <dd
                      data-field="proven-non-applicable"
                      style={{ display: "inline", margin: 0 }}
                    >
                      {dimension.coverage.universe.provenNonApplicable}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ fontWeight: 600, display: "inline" }}>
                      Owner uncaptured:{" "}
                    </dt>
                    <dd
                      data-field="owner-unknown"
                      style={{ display: "inline", margin: 0 }}
                    >
                      {dimension.coverage.universe.ownerUnknown}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ fontWeight: 600, display: "inline" }}>
                      Applicable owner missing from evidence:{" "}
                    </dt>
                    <dd
                      data-field="uncovered-applicable"
                      style={{ display: "inline", margin: 0 }}
                    >
                      {dimension.coverage.universe.uncoveredApplicable}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ fontWeight: 600, display: "inline" }}>
                      Hierarchy contradictions:{" "}
                    </dt>
                    <dd
                      data-field="hierarchy-contradictions"
                      style={{ display: "inline", margin: 0 }}
                    >
                      {dimension.coverage.universe.hierarchyContradictions}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ fontWeight: 600, display: "inline" }}>
                      Complete run attested:{" "}
                    </dt>
                    <dd
                      data-field="complete-run-attested"
                      style={{ display: "inline", margin: 0 }}
                    >
                      {String(dimension.coverage.universe.completeRunAttested)}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ fontWeight: 600, display: "inline" }}>
                      Campaigns expected/observed:{" "}
                    </dt>
                    <dd
                      data-field="campaigns-expected-observed"
                      style={{ display: "inline", margin: 0 }}
                    >
                      {`${dimension.coverage.universe.expectedCampaigns ?? "unknown"} / ${
                        dimension.coverage.universe.observedCampaigns
                      }`}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ fontWeight: 600, display: "inline" }}>
                      Sync cohort:{" "}
                    </dt>
                    <dd
                      data-field="cohort-id"
                      style={{ display: "inline", margin: 0 }}
                    >
                      {dimension.coverage.universe.cohortId ?? "unbound"}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ fontWeight: 600, display: "inline" }}>
                      Manifest members (campaign/ad set):{" "}
                    </dt>
                    <dd
                      data-field="manifest-members"
                      style={{ display: "inline", margin: 0 }}
                    >
                      {`${dimension.coverage.universe.manifestCampaignMembers ?? "unknown"} / ${
                        dimension.coverage.universe.manifestAdsetMembers ??
                        "unknown"
                      }`}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ fontWeight: 600, display: "inline" }}>
                      Ad sets expected/observed:{" "}
                    </dt>
                    <dd
                      data-field="adsets-expected-observed"
                      style={{ display: "inline", margin: 0 }}
                    >
                      {`${dimension.coverage.universe.expectedAdsets ?? "unknown"} / ${
                        dimension.coverage.universe.observedAdsets
                      }`}
                    </dd>
                  </div>
                </>
              ) : null}
              <div>
                <dt style={{ fontWeight: 600, display: "inline" }}>
                  Blocker:{" "}
                </dt>
                <dd
                  data-field="blocker"
                  style={{ display: "inline", margin: 0 }}
                >
                  {dimension.blocker ?? "none"}
                </dd>
              </div>
              {dimension.preconditions.length > 0 ? (
                <div>
                  <dt style={{ fontWeight: 600, display: "inline" }}>
                    Needed, in order:{" "}
                  </dt>
                  <dd
                    data-field="preconditions"
                    style={{ display: "inline", margin: 0 }}
                  >
                    {dimension.preconditions.join("; ")}
                  </dd>
                </div>
              ) : null}
            </dl>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * D077 — server-owned recovery-readiness facts, rendered verbatim on both
 * the desktop and mobile surfaces. No readiness computation, no zeros or
 * green states manufactured for missing data, no compaction / extension /
 * shrink / automation affordance, and no approval token: the operator CLI
 * is the only path that can progress this state.
 */
export function StateHistoryRecoverySection({
  readiness,
}: {
  readiness: StateHistoryCompactionReadiness | null;
}) {
  return (
    <article
      data-testid="state-history-recovery-readiness"
      data-display-only="true"
      style={{
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 12,
        padding: "12px 14px",
        display: "grid",
        gap: 6,
      }}
    >
      <h2 style={{ fontSize: 14, margin: 0 }}>
        State-history recovery readiness
      </h2>
      {readiness === null ? (
        <p data-testid="recovery-readiness-unavailable" style={{ margin: 0 }}>
          Readiness read unavailable — no server fact to display.
        </p>
      ) : (
        <dl style={{ margin: 0, display: "grid", gap: 4, fontSize: 12 }}>
          <div>
            <dt style={{ fontWeight: 600, display: "inline" }}>
              Governing fence metric:{" "}
            </dt>
            <dd
              style={{ display: "inline", margin: 0 }}
              data-testid="recovery-fence"
            >
              {readiness.fence === null
                ? "unavailable"
                : `${readiness.fence.metric} — raw ${formatFenceBytes(readiness.fence.rawBytes)}, effective ${formatFenceBytes(readiness.fence.effectiveBytes)}, budget ${formatFenceBytes(readiness.fence.budgetBytes)}, ${
                    readiness.fence.breachedEffective === true
                      ? "BREACHED"
                      : readiness.fence.breachedEffective === false
                        ? "not breached"
                        : "breach state unknown"
                  }`}
            </dd>
          </div>
          <div>
            <dt style={{ fontWeight: 600, display: "inline" }}>
              Approval / journal (this business):{" "}
            </dt>
            <dd
              style={{ display: "inline", margin: 0 }}
              data-testid="recovery-journal"
            >
              {readiness.journalRead === "unavailable"
                ? "journal state unavailable — the business-scoped journal read failed; execution state is unknown"
                : `${readiness.approvalStatus}${
                    readiness.latestJournal.length === 0
                      ? " — no journal entries for this business"
                      : ` — ${readiness.latestJournal
                          .map(
                            (entry) =>
                              `${entry.event}@${entry.createdAt ?? "?"}`,
                          )
                          .join("; ")}`
                  }`}
            </dd>
          </div>
          <div>
            <dt style={{ fontWeight: 600, display: "inline" }}>
              Planned reclaim:{" "}
            </dt>
            <dd
              style={{ display: "inline", margin: 0 }}
              data-testid="recovery-reclaim"
            >
              unknown — no operator dry-run plan artifact is available to this
              surface
            </dd>
          </div>
          <div>
            <dt style={{ fontWeight: 600, display: "inline" }}>
              D075 writer evidence:{" "}
            </dt>
            <dd
              style={{ display: "inline", margin: 0 }}
              data-testid="recovery-d075"
            >
              {readiness.d075WriterEvidence.state}
            </dd>
          </div>
          <div>
            <dt style={{ fontWeight: 600, display: "inline" }}>Blockers: </dt>
            <dd
              style={{ display: "inline", margin: 0 }}
              data-testid="recovery-blockers"
            >
              {readiness.blockers.length === 0
                ? "none reported"
                : readiness.blockers.join(" | ")}
            </dd>
          </div>
        </dl>
      )}
    </article>
  );
}

export default function MetaAutomationPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
  accountSelection = "shared",
  initialPayload = null,
  viewer = AUTOMATION_VIEWER_NOT_ESTABLISHED,
  stopEngageRefusalReason = null,
  liveWritesRefusalReason = null,
  stateHistoryReadiness = null,
  budgetReadiness = null,
  budgetWriteReadiness = null,
}: MetaAutomationPageProps = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId =
    authorizedBusinessId !== undefined
      ? authorizedBusinessId.trim() || null
      : selectedBusinessId;
  const accountScopeIsServerAuthorized =
    authorizedProviderAccountId !== undefined;
  const requestedProviderAccountId =
    searchParams.get("providerAccountId")?.trim() || null;
  const [providerAccountId, setProviderAccountId] = useState<string | null>(
    accountScopeIsServerAuthorized
      ? authorizedProviderAccountId?.trim() || null
      : null,
  );
  const [payload, setPayload] = useState<AutomationPayload | null>(
    initialPayload,
  );
  const [readLoading, setReadLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  /**
   * Why no account scope was resolved, when none was.
   *
   * `providerAccountId === null` short-circuits BOTH reads below without a
   * request ever leaving the browser, so without this the surface went silent:
   * the confirmation count stayed at "—" forever, no proposal row could appear,
   * and on the legacy mount every card em-dashed with nothing on screen saying
   * why. The design has no account picker and this does not add one — it names
   * the unresolved scope in the failure notice the screen already draws.
   */
  const [scopeFailure, setScopeFailure] = useState<string | null>(null);
  const [providerAccounts, setProviderAccounts] = useState<
    MetaHistoryAccount[]
  >([]);
  const [providerAccountsLoading, setProviderAccountsLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [queue, setQueue] = useState<ProposalQueueRead>(UNAVAILABLE_QUEUE);
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(
    null,
  );
  const [proposalError, setProposalError] = useState<string | null>(null);
  /**
   * What actually happened on the last approval, when it succeeded.
   *
   * Success used to render nothing at all, so an approval that short-circuited
   * before the provider POST — which is every approval in the only
   * configuration production can reach, because `dryRunOnly` defaults true —
   * looked exactly like an approval that changed something on Meta. The row
   * left the queue and the operator drew the obvious conclusion. This states
   * the receipt's own `dryRun` flag instead of inferring anything.
   */
  const [proposalNotice, setProposalNotice] = useState<string | null>(null);
  /**
   * Whether the last decision THIS SESSION recorded reached the activity
   * ledger, or `null` when this session has recorded none.
   *
   * It is session state and it stays session state, because it is a fact about
   * one request. What changed is that it is no longer the ONLY input: a reload
   * used to reset it to `null` and the view read `null` as "fine", so the
   * screen went back to promising "every outcome lands in the ledger with a
   * receipt" with no evidence at all behind the sentence. The view now falls
   * back to the server read model (`readCompleteness.activityLedger`) and
   * prints the promise only where one of the two actually proves it.
   *
   * Cleared whenever the business or the account changes — a decision recorded
   * against another scope says nothing about this one.
   */
  const [sessionLedgerCompleteness, setSessionLedgerCompleteness] = useState<
    "complete" | "unavailable" | null
  >(null);

  // One retry, two invokers: the Tier-0 freshness bar registers it, and the
  // failure state on this screen calls it directly. Before this the handler was
  // registered and never reachable, because nothing in the app mounts the bar.
  const retryRead = useCallback(() => setRefreshKey((value) => value + 1), []);

  const selectProviderAccount = useCallback(
    (nextProviderAccountId: string) => {
      if (!nextProviderAccountId) return;
      const next = accountSwitchQuery(
        searchParams.toString(),
        nextProviderAccountId,
      );
      const query = next.toString();
      const pathname =
        typeof window !== "undefined"
          ? window.location.pathname
          : "/platforms/meta/automation";
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [router, searchParams],
  );

  // The scope failure is a read failure too: it is the reason no read ran.
  const surfacedReadFailure = readError ?? scopeFailure;

  /**
   * Freshness by AGGREGATION, not by guessing from one field.
   *
   * The old reason read `businessControl.source !== "persisted"` — which is
   * true of every workspace that has simply never configured a guardrail, so
   * a perfectly healthy screen permanently reported itself partial, and the
   * one thing that made it partial (a section whose read actually failed) was
   * invisible behind it. `source` is a fact about configuration; completeness
   * is a fact about the read, and only the second one belongs here.
   */
  const partialReason = useMemo(() => {
    const incomplete = (
      [
        "businessControl",
        "rules",
        "activity",
        "promotionRecords",
        "decisionModes",
        "anchors",
        "readiness",
      ] as const
    ).some((key) => sectionState(payload, key) !== "complete");
    const queueIncomplete = queue.readCompleteness !== "complete";
    return metaAutomationFreshnessPartialReason({
      hasProviderAccount: Boolean(providerAccountId),
      incomplete: incomplete || queueIncomplete,
    });
  }, [payload, providerAccountId, queue.readCompleteness]);

  useTierZeroFreshness({
    surface: "automation",
    isLoading: readLoading && !payload,
    isFetching: readLoading,
    error: surfacedReadFailure,
    asOf: null,
    partialReason,
    businessId,
    onRetry: retryRead,
  });

  useEffect(() => {
    setPayload(initialPayload);
  }, [businessId, initialPayload]);

  useEffect(() => {
    if (accountScopeIsServerAuthorized) {
      const authorized = authorizedProviderAccountId?.trim() || null;
      setProviderAccountId(authorized);
      // The server resolved the scope and got nothing. That null is
      // authoritative — `provider-scope-server.ts` returns it whenever the
      // catalog does not hold exactly one account — so it is a stated reason,
      // not a loading state.
      setScopeFailure(authorized ? null : "provider_account_scope_unresolved");
      if (authorized || !businessId) {
        setProviderAccounts([]);
        setProviderAccountsLoading(false);
        return;
      }
      // The shared topbar owns account selection. This read only distinguishes
      // an unassigned workspace from a temporarily unavailable assignment
      // catalog so the recovery message remains truthful.
      const scopeController = new AbortController();
      setProviderAccountsLoading(true);
      fetchMetaHistoryAccounts({ businessId, signal: scopeController.signal })
        .then((accounts) => {
          if (scopeController.signal.aborted) return;
          setProviderAccounts(accounts);
          if (accounts.length === 0) {
            setScopeFailure("provider_account_none_assigned");
          }
        })
        .catch(() => {
          if (scopeController.signal.aborted) return;
          // A failed assignment read is not "no accounts".
          setProviderAccounts([]);
          setScopeFailure("provider_account_scope_unavailable");
        })
        .finally(() => {
          if (!scopeController.signal.aborted) {
            setProviderAccountsLoading(false);
          }
        });
      return () => scopeController.abort();
    }
    if (!businessId) {
      setProviderAccountId(null);
      setProviderAccounts([]);
      setProviderAccountsLoading(false);
      setScopeFailure(null);
      return;
    }

    const controller = new AbortController();
    setProviderAccountId(null);
    setScopeFailure(null);
    setProviderAccountsLoading(true);
    fetchMetaHistoryAccounts({ businessId, signal: controller.signal })
      .then((accounts) => {
        if (controller.signal.aborted) return;
        setProviderAccounts(accounts);
        const requested = requestedProviderAccountId
          ? accounts.find(
              (account) => account.id === requestedProviderAccountId,
            )
          : null;
        const resolved =
          requested?.id ?? (accounts.length === 1 ? accounts[0]!.id : null);
        setProviderAccountId(resolved);
        if (resolved) {
          setScopeFailure(null);
          return;
        }
        // Three different facts, and the operator can act on only one of them.
        setScopeFailure(
          accounts.length === 0
            ? "provider_account_none_assigned"
            : requestedProviderAccountId
              ? "provider_account_not_assigned"
              : "provider_account_scope_unresolved",
        );
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setProviderAccountId(null);
        setProviderAccounts([]);
        // A failed assignment read is not "no accounts". Saying so would turn
        // a read failure into a claim about the workspace.
        setScopeFailure("provider_account_scope_unavailable");
      })
      .finally(() => {
        if (!controller.signal.aborted) setProviderAccountsLoading(false);
      });
    return () => controller.abort();
  }, [
    accountScopeIsServerAuthorized,
    authorizedProviderAccountId,
    businessId,
    // Retry re-runs the scope resolution too. Without this the Retry control
    // was dead in exactly the state it most needed to work: an unresolved
    // scope never reaches the read whose refresh key it bumps.
    refreshKey,
    requestedProviderAccountId,
  ]);

  /**
   * Stale session state does not travel across scopes.
   *
   * `sessionLedgerCompleteness` answers "did the last decision reach the
   * ledger", and "the last decision" is only meaningful within one business and
   * one ad account. Carrying it across a switch would either withhold a true
   * promise on a healthy workspace or, worse, keep a `complete` from the
   * previous account standing in as evidence for this one.
   */
  useEffect(() => {
    setSessionLedgerCompleteness(null);
  }, [businessId, providerAccountId]);

  useEffect(() => {
    if (!businessId || !providerAccountId) {
      if (!initialPayload) setPayload(null);
      setReadLoading(false);
      setReadError(null);
      return;
    }
    const controller = new AbortController();
    setReadLoading(true);
    setReadError(null);
    readAutomation({ businessId, providerAccountId, signal: controller.signal })
      .then((nextPayload) => {
        if (!controller.signal.aborted) setPayload(nextPayload);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setPayload(null);
          setReadError(
            error instanceof AutomationReadError
              ? error.code
              : // A transport failure (offline, DNS, aborted socket) never
                // reached the route, so there is no server code to restate and
                // the general one is the honest answer.
                "automation_control_plane_unavailable",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setReadLoading(false);
      });
    return () => controller.abort();
  }, [businessId, initialPayload, providerAccountId, refreshKey]);

  useEffect(() => {
    if (!businessId || !providerAccountId) {
      setQueue(UNAVAILABLE_QUEUE);
      return;
    }
    const controller = new AbortController();
    readProposalQueue({
      businessId,
      providerAccountId,
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) setQueue(next);
      })
      .catch(() => {
        // A failed read is `unavailable`, never an empty queue: telling an
        // operator that nothing needs confirmation when we do not know is the
        // one wrong answer this surface can give.
        if (!controller.signal.aborted) setQueue(UNAVAILABLE_QUEUE);
      });
    return () => controller.abort();
  }, [businessId, providerAccountId, refreshKey]);

  const onProposalControl = useCallback(
    (proposalId: string, control: ProposalControl, note?: string) => {
      if (!businessId || !providerAccountId || pendingProposalId) return;
      // The server's refusal, restated before the request rather than after it.
      // Every one of these controls is rendered disabled for a refused viewer,
      // so reaching this line means something bypassed the DOM — and a POST
      // issued from here would still be refused by the route, but it would also
      // put a real approval attempt on a demo or reviewer session's wire.
      if (!viewer.canMutate) return;
      setPendingProposalId(proposalId);
      setProposalError(null);
      setProposalNotice(null);
      const query = new URLSearchParams({ businessId, providerAccountId });
      fetch(`/api/meta/automation/proposals?${query.toString()}`, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposalId,
          action: control,
          ...(note ? { note } : {}),
          // The explicit operator confirmation the guarded write path demands.
          // Sent only for the control that reaches a provider.
          ...(control === "approve"
            ? { manualConfirmation: MANUAL_CONFIRMATION }
            : {}),
        }),
      })
        .then(async (response) => {
          const body = (await response.json().catch(() => null)) as {
            ok?: boolean;
            error?: { message?: string };
            ledgerCompleteness?: "complete" | "unavailable";
            receipt?: { dryRun?: boolean } | null;
            proposalStatus?: string | null;
            providerOutcomeKnown?: boolean;
            providerWriteVerified?: boolean;
          } | null;
          // Recorded from BOTH arms: a decision that reached the provider and
          // failed to reach the ledger still has to stop the footnote from
          // promising a receipt trail.
          //
          // Three cases, and only one of them used to be handled. A body that
          // is not JSON at all is `null` here, and the old code turned that into
          // `null` state — i.e. straight back to the promise, off a response
          // nobody could read. It is `unavailable` now. A valid JSON body that
          // simply carries no `ledgerCompleteness` (a 409 claim conflict, where
          // nothing was dispatched and nothing was written) is not a new ledger
          // fact and must not overwrite the one already held.
          if (body === null) {
            setSessionLedgerCompleteness("unavailable");
          } else if (
            body.ledgerCompleteness === "complete" ||
            body.ledgerCompleteness === "unavailable"
          ) {
            setSessionLedgerCompleteness(body.ledgerCompleteness);
          }
          if (!response.ok || body?.ok !== true) {
            const serverMessage = typeof body?.error?.message === "string"
              ? body.error.message.trim()
              : "";
            setProposalError(
              serverMessage || "This action could not be saved.",
            );
            setQueue(UNAVAILABLE_QUEUE);
            return;
          }
          if (control === "approve") {
            /**
             * Provider truth, not the HTTP envelope, decides the notice.
             *
             * The route returns a 200 queue envelope after a conclusively failed
             * provider attempt too, because the proposal row and refreshed queue
             * were recorded successfully. `receipt.dryRun === false` therefore
             * cannot mean "Applied" by itself. Only the route's explicit
             * `providerWriteVerified` fact may make that claim.
             */
            const dryRun = body?.receipt?.dryRun;
            if (body?.providerWriteVerified === true) {
              setProposalNotice("Applied on Meta.");
            } else if (dryRun === true) {
              setProposalNotice("Saved as a preview. Nothing was sent to Meta.");
            } else if (
              body?.proposalStatus === "failed"
              || (body?.providerWriteVerified === false
                && body.providerOutcomeKnown === true)
            ) {
              setProposalError(
                "The proposal was recorded, but nothing was applied on Meta.",
              );
            } else {
              setProposalNotice(
                "Saved, but the result could not be confirmed. Check recent activity before trying again.",
              );
            }
          }
          setQueue(parseProposalQueue(body));
        })
        .catch(() => {
          setProposalError(
            "The confirmation queue could not record that decision.",
          );
          setQueue(UNAVAILABLE_QUEUE);
          // The request left the browser and no answer came back, so whether
          // anything reached the ledger is unknown. Unknown is not a receipt
          // trail, and the footnote must stop claiming one.
          setSessionLedgerCompleteness("unavailable");
        })
        .finally(() => setPendingProposalId(null));
    },
    [businessId, pendingProposalId, providerAccountId, viewer.canMutate],
  );

  return (
    <MetaAutomationView
      payload={payload}
      providerAccountId={providerAccountId}
      proposals={buildAutomationProposalsModel({
        readCompleteness: queue.readCompleteness,
        proposals: queue.proposals,
        holds: queue.holds,
        now: new Date(),
      })}
      onProposalControl={onProposalControl}
      proposalNotice={proposalNotice}
      pendingProposalId={pendingProposalId}
      proposalError={proposalError}
      businessId={businessId}
      onRulesChanged={setPayload}
      readError={surfacedReadFailure}
      onRetryRead={retryRead}
      providerAccounts={
        accountSelection === "local" ? providerAccounts : undefined
      }
      providerAccountsLoading={
        accountSelection === "local" ? providerAccountsLoading : undefined
      }
      onSelectProviderAccount={
        accountSelection === "local" ? selectProviderAccount : undefined
      }
      ledgerCompleteness={sessionLedgerCompleteness}
      viewer={viewer}
      stopEngageRefusalReason={stopEngageRefusalReason}
      liveWritesRefusalReason={liveWritesRefusalReason}
      stateHistoryReadiness={stateHistoryReadiness}
      budgetReadiness={budgetReadiness}
      budgetWriteReadiness={budgetWriteReadiness}
      onBudgetActivationChanged={() => router.refresh()}
    />
  );
}

/**
 * D087/D088 — the budget write capability and activation ceremony.
 *
 * Every value here is a string the server put in the model. The component
 * decides nothing: not whether execution is possible, not the magnitude, not
 * the owner, not the direction. Its only controls alter persisted activation;
 * they never choose or dispatch a budget mutation. The server supplies the
 * fresh blockers that enable or disable the ceremony.
 */
export function BudgetWriteReadinessSection({
  readiness,
  authorization,
  onActivationChanged,
  anchorId = "automatic-execution-control",
}: {
  readiness: BudgetWriteReadinessModel | null;
  /*
    The anchor this section answers to, because two panes now render it.

    The desktop pane keeps the canonical id its own "Review setup and execution
    controls" link points at; the mobile pane takes a scoped one. Two elements
    sharing an id is not cosmetic here — the link would jump to whichever the
    browser found first, which at 390px is the hidden desktop copy.
  */
  anchorId?: string;
  /*
    PRE-DEPLOY AUDIT: who is looking, decided on the SERVER.

    This section had no viewer envelope at all, so the read-only mobile pane
    and a collaborator both got a live Enable button for the strongest control
    in the product — a control whose route answers 403. Absent means the
    read-only surface: a section rendered without an explicit authorization
    must not offer a write.
  */
  authorization?: BudgetMasterSwitchAuthorization;
  /** Lets the page re-read the server model after a successful change. */
  onActivationChanged?: () => void;
}) {
  const auth: BudgetMasterSwitchAuthorization = authorization ?? {
    canConfigure: false,
    canDisable: false,
    reason: BUDGET_MASTER_SWITCH_MOBILE_REFUSAL,
    reasonCode: "read_only_surface",
    surface: "mobile_read_only",
  };
  const [activationPhrase, setActivationPhrase] = useState("");
  const [activationBusy, setActivationBusy] = useState(false);
  const [activationMessage, setActivationMessage] = useState<string | null>(
    null,
  );

  const submitActivation = async (enabled: boolean) => {
    if (!readiness) return;
    const activeAccount = readiness.execution.activatedProviderAccountId;
    const activeElsewhere =
      activeAccount !== null && activeAccount !== readiness.providerAccountId;
    if (enabled && (!auth.canConfigure || activeElsewhere)) return;
    if (
      !enabled &&
      (!auth.canDisable ||
        readiness.execution.executionEnabled !== true ||
        activeAccount !== readiness.providerAccountId)
    ) {
      return;
    }
    setActivationBusy(true);
    setActivationMessage(null);
    try {
      const query = new URLSearchParams({
        businessId: readiness.businessId,
        providerAccountId: readiness.providerAccountId,
      });
      const response = await fetch(`/api/meta/automation?${query.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "set_budget_auto_execution",
          enabled,
          // The phrase is the only thing the operator supplies. The verdict is
          // computed on the server and is never sent from here.
          confirmationPhrase: enabled ? activationPhrase : null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { code?: string; message?: string };
        blockers?: string[];
      } | null;
      if (payload?.ok) {
        setActivationMessage(
          enabled
            ? "Automatic actions are on for this account."
            : "Automatic actions are off.",
        );
        setActivationPhrase("");
        onActivationChanged?.();
      } else {
        setActivationMessage("Automatic actions could not be changed.");
      }
    } catch {
      setActivationMessage("Automatic actions could not be changed.");
    } finally {
      setActivationBusy(false);
    }
  };

  if (!readiness) {
    return (
      <article
        id={anchorId}
        data-testid="budget-write-readiness-unavailable"
        data-display-only="true"
        style={{
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: 12,
          padding: "12px 14px",
          fontSize: 13,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14 }}>Automatic actions</h3>
        <p style={{ margin: "6px 0 0" }}>
          Automatic actions are unavailable. Refresh and try again.
        </p>
      </article>
    );
  }

  const { execution } = readiness;
  const activatedElsewhere =
    execution.activatedProviderAccountId !== null &&
    execution.activatedProviderAccountId !== readiness.providerAccountId;
  const activationAccountUnresolved =
    execution.executionEnabled && execution.activatedProviderAccountId === null;
  const activatedAccountLabel = compactMetaAccountId(
    execution.activatedProviderAccountId,
  );
  const dryRunBlockerPresent = execution.activationReadyBlockers.includes(
    "dry_run_guardrail_engaged",
  );
  const effectiveWriteAbility =
    execution.capabilityPrepared &&
    execution.executionEnabled &&
    !dryRunBlockerPresent &&
    execution.activationReadyBlockers.length === 0 &&
    execution.activatedProviderAccountId === readiness.providerAccountId;

  return (
    <article
      id={anchorId}
      data-testid="budget-write-readiness"
      data-display-only="true"
      data-execution-enabled={String(execution.executionEnabled)}
      data-capability-prepared={String(execution.capabilityPrepared)}
      data-effective-write={String(effectiveWriteAbility)}
      data-activated-account={activatedAccountLabel ?? "none"}
      data-activated-here={String(
        execution.activatedProviderAccountId === readiness.providerAccountId,
      )}
      style={{
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 12,
        padding: "12px 14px",
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14 }}>Automatic actions</h3>
        <strong
          data-field="business-master-switch"
          data-value={String(execution.executionEnabled)}
        >
          {activatedElsewhere
            ? "On for another account"
            : activationAccountUnresolved
              ? "On — account unavailable"
              : execution.executionEnabled
                ? "On"
                : "Off"}
        </strong>
      </div>
      <p style={{ margin: "6px 0 0" }} data-field="master-switch-scope">
        Eligible actions set to Automatic can run within your saved limits.
      </p>

      {!activatedElsewhere && !activationAccountUnresolved ? (
        <div
          style={{ margin: "10px 0 0" }}
          data-field="activation-ready-blockers"
        >
          {execution.activationReadyBlockers.length === 0 ? (
            <p style={{ margin: 0 }}>Ready to turn on.</p>
          ) : (
            <>
              <p style={{ margin: 0, fontWeight: 600 }}>
                Before this can start
              </p>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {execution.activationReadyBlockers.map((blocker) => (
                  <li key={blocker} data-blocker-code={blocker}>
                    {activationBlockerLabel(blocker)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      {activatedElsewhere ? (
        <p style={{ margin: "10px 0 0" }} data-field="activated-account-fact">
          Automatic actions are active for Meta ad account{" "}
          {activatedAccountLabel}. Open that account to manage them.
        </p>
      ) : null}

      {activationAccountUnresolved ? (
        <p style={{ margin: "10px 0 0" }} data-field="activated-account-fact">
          The active Meta ad account is unavailable. Refresh before managing
          automatic actions.
        </p>
      ) : null}

      {!activatedElsewhere &&
      !activationAccountUnresolved &&
      (auth.canConfigure ||
        (auth.canDisable &&
          execution.executionEnabled &&
          execution.activatedProviderAccountId ===
            readiness.providerAccountId)) ? (
        <form
          data-testid="budget-activation-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitActivation(true);
          }}
          style={{
            margin: "10px 0 0",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {auth.canConfigure && !execution.executionEnabled ? (
            <>
              <input
                type="text"
                name="confirmationPhrase"
                data-testid="budget-activation-phrase"
                value={activationPhrase}
                onChange={(event) => setActivationPhrase(event.target.value)}
                placeholder={BUDGET_ACTIVATION_CONFIRMATION_PHRASE}
                aria-label="Confirmation phrase"
                disabled={
                  activationBusy || execution.activationReadyBlockers.length > 0
                }
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid var(--border, #e5e7eb)",
                  minWidth: 280,
                }}
              />
              <button
                type="submit"
                data-testid="budget-activation-enable"
                data-enabled={String(
                  execution.activationReadyBlockers.length === 0 &&
                    !activationBusy,
                )}
                disabled={
                  activationBusy || execution.activationReadyBlockers.length > 0
                }
                aria-disabled={
                  activationBusy || execution.activationReadyBlockers.length > 0
                }
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border, #e5e7eb)",
                  background: "transparent",
                  cursor:
                    execution.activationReadyBlockers.length > 0
                      ? "not-allowed"
                      : "pointer",
                  opacity:
                    execution.activationReadyBlockers.length > 0 ? 0.55 : 1,
                }}
              >
                Turn on automatic actions
              </button>
            </>
          ) : null}
          {auth.canDisable &&
          execution.executionEnabled &&
          execution.activatedProviderAccountId ===
            readiness.providerAccountId ? (
            <button
              type="button"
              data-testid="budget-activation-disable"
              disabled={activationBusy}
              onClick={() => {
                void submitActivation(false);
              }}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: "1px solid var(--border, #e5e7eb)",
                background: "transparent",
                cursor: "pointer",
              }}
            >
              Turn off automatic actions
            </button>
          ) : null}
        </form>
      ) : !auth.canConfigure && !auth.canDisable ? (
        <p
          style={{ margin: "10px 0 0" }}
          data-field="master-switch-refusal"
          data-reason-code={auth.reasonCode ?? "none"}
          data-surface={auth.surface}
        >
          {automaticActionsRefusalMessage(auth.reasonCode)}
        </p>
      ) : null}

      {auth.canConfigure &&
      !activatedElsewhere &&
      !activationAccountUnresolved ? (
        <details style={{ margin: "12px 0 0" }}>
          <summary>Setup limits</summary>
          <BudgetPreparationForm
            key={`${readiness.businessId}::${readiness.providerAccountId}`}
            businessId={readiness.businessId}
            providerAccountId={readiness.providerAccountId}
            preparation={readiness.preparation ?? null}
            onSaved={onActivationChanged}
          />
        </details>
      ) : null}

      {activationMessage ? (
        <p style={{ margin: "8px 0 0" }} data-field="activation-response">
          {activationMessage}
        </p>
      ) : null}
    </article>
  );
}

/**
 * PRE-DEPLOY AUDIT — the admin-only budget automation preparation form.
 *
 * WHAT IT IS FOR. Activation readiness demands a persisted control row whose
 * dry-run guardrail is lifted and whose budget policy keys carry real numbers.
 * This writes them, through the route action that already exists, and it is
 * the only way to satisfy those prerequisites without a hand-run statement.
 *
 * WHAT IT REFUSES TO DO.
 *
 *  - It never invents a value. Every input starts EMPTY unless the server
 *    said a value is persisted, and each field states its own provenance
 *    beside it: persisted, not set, or could not be read. A form pre-filled
 *    with plausible numbers invites an admin to press Save and believe they
 *    reviewed a configuration when they persisted the form's defaults.
 *  - It never validates differently from the server. `parseBudgetAutomationConfig`
 *    is the SAME parser the route runs, imported from a module with no
 *    database in it, so a value this form accepts is a value the route
 *    accepts, and the rejection code shown is the one the route would return.
 *  - It never computes a buyerAction, a readiness verdict or a blocker. It
 *    sends an intent; the server re-derives readiness, and the section above
 *    re-reads it afterwards.
 *  - It never enables anything. The save pins the master switch OFF and clears
 *    the bound account, and the warning states that before the button.
 */
/** "" | "true" | "false" — an unmade choice is its OWN state, never a default. */
type DryRunTriState = "" | "true" | "false";

/**
 * Text state, not numbers. An empty string is "the admin has typed nothing",
 * which is distinct from 0 — and 0 is a value the validator rejects for every
 * one of these keys. Coercing "" to 0 would submit a rejected value as if it
 * had been chosen. Module-level and pure so both the initial `useState` calls
 * and the post-mount resync effect read the SAME logic.
 */
function preparedFieldText(
  preparation: BudgetPreparationView | null,
  key: keyof BudgetAutomationConfigInput,
): string {
  const field = preparation?.[key] as PreparationField<unknown> | undefined;
  if (!field || field.state !== "persisted" || field.value === null) return "";
  return String(field.value);
}

function preparedSpendLimitText(
  preparation: BudgetPreparationView | null,
): string {
  const amount = preparation?.perActionSpendCeilingMinor;
  const currency = preparation?.perActionSpendCeilingCurrency;
  if (
    amount?.state !== "persisted" ||
    typeof amount.value !== "number" ||
    !Number.isSafeInteger(amount.value) ||
    currency?.state !== "persisted"
  ) {
    return "";
  }
  const exponent = resolveMinorUnitExponent(currency.value);
  return exponent.status === "resolved"
    ? formatMinorUnitsForDisplay(amount.value, exponent.exponent)
    : "";
}

function spendLimitMinorFromText(
  raw: string,
  exponent: MinorUnitExponent | null,
): number | null | undefined {
  const value = raw.trim();
  if (!value) return null;
  if (exponent === null) return undefined;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2]?.length ?? 0) > exponent) return undefined;
  const minorText = `${match[1]}${(match[2] ?? "").padEnd(exponent, "0")}`;
  const minor = Number(minorText);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : undefined;
}

function spendLimitLabel(currency: string): string {
  const code = currency.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code)
    ? `Per-action spend limit (${code})`
    : "Per-action spend limit";
}

/**
 * PRE-DEPLOY AUDIT — no fabricated default. `dryRunOnly` used to initialize
 * to `true` whenever the stored value was not `persisted`, which means an
 * UNKNOWN and an UNSET row rendered as an already-made, safe-looking choice.
 * It is nothing of the kind: the operator never chose it, and the shared
 * parser must refuse to accept a value nobody picked. The empty string is
 * that refusal, surfaced as "Choose…" in the `<select>` below.
 */
function preparedDryRunOnly(
  preparation: BudgetPreparationView | null,
): DryRunTriState {
  if (preparation?.dryRunOnly.state !== "persisted") return "";
  return preparation.dryRunOnly.value ? "true" : "false";
}

function preparationErrorMessage(rejection: string): string {
  switch (rejection) {
    case "dry_run_only_not_boolean":
      return "Choose whether changes should stay in preview mode.";
    case "min_hours_between_changes_invalid":
      return "Enter a valid number of hours between changes.";
    case "max_changes_per_7d_invalid":
      return "Enter a whole number of changes allowed per week.";
    case "max_account_concentration_pct_invalid":
      return "Enter an account budget share between 1 and 100%.";
    case "max_budget_increase_pct_invalid":
      return "Enter a valid maximum increase percentage.";
    case "per_action_spend_ceiling_invalid":
      return "Enter a valid spend limit for the selected currency.";
    case "per_action_spend_ceiling_currency_invalid":
      return "Enter a three-letter currency code for the spend limit.";
    default:
      return "Review the limits and try again.";
  }
}

function BudgetPreparationForm({
  businessId,
  providerAccountId,
  preparation,
  onSaved,
}: {
  businessId: string;
  providerAccountId: string;
  preparation: BudgetPreparationView | null;
  onSaved?: () => void;
}) {
  /*
    PRE-DEPLOY AUDIT — fail CLOSED, not fail open.

    `preparation === null` (the caller supplied nothing) and
    `preparation.rowRead === false` (a real read was attempted and failed)
    are both states where this form has NOT SEEN the stored configuration.
    Every control below — the dry-run selector, every numeric input, and
    Save — is disabled in both states: a value typed over a row nobody
    could read is a value that silently overwrites something unseen.
    `rowRead === true && rowExists === false` is the one state that stays
    editable — the row genuinely does not exist yet, so there is nothing it
    could overwrite, and that IS the first-setup path this form exists for.
  */
  const fieldsLocked = !preparation || preparation.rowRead === false;

  const [dryRunOnly, setDryRunOnly] = useState<DryRunTriState>(
    preparedDryRunOnly(preparation),
  );
  const [minHours, setMinHours] = useState(
    preparedFieldText(preparation, "budgetMinHoursBetweenChanges"),
  );
  const [maxChanges, setMaxChanges] = useState(
    preparedFieldText(preparation, "budgetMaxChangesPer7d"),
  );
  const [maxConcentration, setMaxConcentration] = useState(
    preparedFieldText(preparation, "budgetMaxAccountConcentrationPct"),
  );
  const [maxIncrease, setMaxIncrease] = useState(
    preparedFieldText(preparation, "maxBudgetIncreasePct"),
  );
  const [ceilingAmount, setCeilingAmount] = useState(
    preparedSpendLimitText(preparation),
  );
  const [ceilingCurrency, setCeilingCurrency] = useState(
    preparedFieldText(preparation, "perActionSpendCeilingCurrency"),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /*
    PRE-DEPLOY AUDIT — resync ONCE, exactly when a real read first lands.

    Scope changes (business or provider account) are handled entirely by the
    caller: `key={businessId::providerAccountId}` on this component's JSX
    below gives React a fresh mount on scope change, so every hook above
    starts over from the CURRENT props — a value from a different scope can
    never be read here. This effect covers the one thing a remount does not:
    the SAME scope, where `preparation` starts unread (still loading, or a
    failed first attempt) and a real row arrives moments later. The
    `useState` calls above already captured "" for every field on that first,
    unread render (fail closed, per the rule above) — this effect is what
    upgrades them to the real stored values the first time the read
    succeeds, and `syncedRef` stops it from ever firing again for this
    mount, so a LATER preparation update for the same, already-read scope
    (a background poll, the refetch this form's own `onSaved` triggers)
    never overwrites what the operator may be typing.
  */
  const syncedRef = useRef(!fieldsLocked);
  useEffect(() => {
    if (fieldsLocked || syncedRef.current) return;
    syncedRef.current = true;
    setDryRunOnly(preparedDryRunOnly(preparation));
    setMinHours(preparedFieldText(preparation, "budgetMinHoursBetweenChanges"));
    setMaxChanges(preparedFieldText(preparation, "budgetMaxChangesPer7d"));
    setMaxConcentration(
      preparedFieldText(preparation, "budgetMaxAccountConcentrationPct"),
    );
    setMaxIncrease(preparedFieldText(preparation, "maxBudgetIncreasePct"));
    setCeilingAmount(preparedSpendLimitText(preparation));
    setCeilingCurrency(
      preparedFieldText(preparation, "perActionSpendCeilingCurrency"),
    );
  }, [fieldsLocked, preparation]);

  /*
    An empty numeric field submits `null`, which the shared parser rejects by
    NAME. That is deliberate: a blank required guardrail must produce the
    server's own rejection code rather than a bespoke UI message, so the
    operator sees the same words in the form and in the route's response.
    An unmade dry-run CHOICE submits `undefined`, which the same parser
    rejects as `dry_run_only_not_boolean` — there is no third, silently
    accepted spelling of "the operator has not decided".
  */
  const numeric = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  };
  const ceilingExponent = resolveMinorUnitExponent(ceilingCurrency);
  const candidate = {
    dryRunOnly: dryRunOnly === "" ? undefined : dryRunOnly === "true",
    budgetMinHoursBetweenChanges: numeric(minHours),
    budgetMaxChangesPer7d: numeric(maxChanges),
    budgetMaxAccountConcentrationPct: numeric(maxConcentration),
    maxBudgetIncreasePct: numeric(maxIncrease),
    // A blank ceiling is a real, valid choice: it CLEARS the ceiling.
    perActionSpendCeilingMinor: spendLimitMinorFromText(
      ceilingAmount,
      ceilingExponent.status === "resolved" ? ceilingExponent.exponent : null,
    ),
    perActionSpendCeilingCurrency: ceilingCurrency.trim()
      ? ceilingCurrency.trim().toUpperCase()
      : null,
  };
  const parsed = parseBudgetAutomationConfig(candidate);
  const missing = preparation ? unpreparedFields(preparation) : [];
  const missingLabels = missing.map(
    (key) =>
      PREPARATION_FIELD_LABELS[
        key as (typeof BUDGET_PREPARATION_FIELDS)[number]
      ] ?? key,
  );
  const saveEnabled = parsed.ok && !busy && !fieldsLocked;

  const submit = async () => {
    // Defense in depth: the button already carries `disabled`, but a
    // programmatic form submit (e.g. Enter inside a still-enabled sibling
    // control) must not reach the network on the button's styling alone.
    if (!saveEnabled) return;
    setBusy(true);
    setMessage(null);
    try {
      const query = new URLSearchParams({ businessId, providerAccountId });
      const response = await fetch(`/api/meta/automation?${query.toString()}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save_budget_automation_config",
          ...parsed.config,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        saved?: boolean;
        autoExecutionEnabled?: boolean;
        error?: { code?: string; message?: string };
      } | null;
      if (payload?.ok) {
        setMessage(
          "Limits saved. Automatic actions remain off until you turn them on.",
        );
        // Re-read the server model so readiness reflects the new row rather
        // than this component's optimism.
        onSaved?.();
      } else {
        setMessage("Limits could not be saved.");
      }
    } catch {
      setMessage("Limits could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = {
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid var(--border, #e5e7eb)",
    // Mobile: the grid below is one column under 520px, and an input that
    // cannot shrink is what makes a narrow pane scroll sideways.
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box" as const,
  };

  return (
    <form
      data-testid="budget-preparation-form"
      data-row-read={String(preparation?.rowRead ?? false)}
      data-row-exists={String(preparation?.rowExists ?? false)}
      data-fields-locked={String(fieldsLocked)}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      style={{
        margin: "12px 0 0",
        paddingTop: 10,
        borderTop: "1px solid var(--border, #e5e7eb)",
      }}
    >
      <h4 style={{ margin: 0, fontSize: 13 }}>Automation limits</h4>
      {/*
        The warning comes BEFORE the fields, not beside the button. An operator
        who reads only the heading and the first sentence must still have been
        told what the save does to the master switch.
      */}
      <p
        data-field="preparation-warning"
        style={{ margin: "6px 0 0", fontSize: 12 }}
      >
        Saving limits turns automatic actions off until you turn them on again.
      </p>
      {/*
        PRE-DEPLOY AUDIT — fail-closed banner, for BOTH ways this form can
        fail to have seen the real row: `preparation === null` (the caller
        supplied nothing — this component predates the read, or the parent's
        own read of readiness is itself in an unavailable state) and
        `rowRead === false` (a read was attempted and failed). Both disable
        every control below; this is where that is EXPLAINED rather than
        merely enforced.
      */}
      {fieldsLocked ? (
        <p
          data-field="preparation-unreadable"
          style={{ margin: "6px 0 0", fontSize: 12 }}
        >
          Saved limits are unavailable. Refresh before changing them.
        </p>
      ) : null}
      {missing.length > 0 ? (
        <p
          data-field="preparation-missing"
          data-missing={missing.join(",")}
          style={{ margin: "6px 0 0", fontSize: 12 }}
        >
          Complete these settings: {missingLabels.join(", ")}.
        </p>
      ) : null}

      <div
        style={{
          display: "grid",
          // Mobile-first: one column, becoming two only where there is room.
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 10,
          margin: "10px 0 0",
        }}
      >
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          Preview changes only
          <select
            data-testid="preparation-dry-run-only"
            value={dryRunOnly}
            onChange={(event) =>
              setDryRunOnly(event.target.value as DryRunTriState)
            }
            disabled={busy || fieldsLocked}
            style={inputStyle}
          >
            {/*
              PRE-DEPLOY AUDIT: the empty option is the DEFAULT and stays
              selectable — an operator who has not decided must see an
              unmade choice, not a value that already reads as "true".
            */}
            <option value="">Choose…</option>
            <option value="true">On — do not send changes to Meta</option>
            <option value="false">Off — allow automatic Meta actions</option>
          </select>
        </label>

        {(
          [
            [
              "budgetMinHoursBetweenChanges",
              "Minimum hours between changes",
              minHours,
              setMinHours,
              "preparation-min-hours",
            ],
            [
              "budgetMaxChangesPer7d",
              "Maximum changes per week",
              maxChanges,
              setMaxChanges,
              "preparation-max-changes",
            ],
            [
              "budgetMaxAccountConcentrationPct",
              "Maximum account budget share (%)",
              maxConcentration,
              setMaxConcentration,
              "preparation-max-concentration",
            ],
            [
              "maxBudgetIncreasePct",
              "Maximum increase per change (%)",
              maxIncrease,
              setMaxIncrease,
              "preparation-max-increase",
            ],
          ] as const
        ).map(([key, label, value, setValue, testId]) => (
          <label key={key} style={{ display: "grid", gap: 4, fontSize: 12 }}>
            {label}
            <input
              type="text"
              inputMode="numeric"
              data-testid={testId}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={busy || fieldsLocked}
              aria-label={label}
              style={inputStyle}
            />
          </label>
        ))}

        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          {spendLimitLabel(ceilingCurrency)}
          <input
            type="text"
            inputMode="decimal"
            data-testid="preparation-ceiling-minor"
            value={ceilingAmount}
            onChange={(event) => setCeilingAmount(event.target.value)}
            disabled={busy || fieldsLocked}
            aria-label={spendLimitLabel(ceilingCurrency)}
            style={inputStyle}
          />
        </label>

        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          Spend-limit currency
          <input
            type="text"
            data-testid="preparation-ceiling-currency"
            value={ceilingCurrency}
            maxLength={3}
            spellCheck={false}
            onChange={(event) =>
              setCeilingCurrency(event.target.value.toUpperCase())
            }
            disabled={busy || fieldsLocked}
            aria-label="Spend-limit currency"
            placeholder="TRY"
            style={inputStyle}
          />
        </label>
      </div>

      {/*
        The server's own rejection code, shown before the operator submits.
        Computed by the route's parser, so it cannot disagree with the answer.
        Suppressed while `fieldsLocked`: an unread row's fields are all "",
        which the parser also rejects, and showing that rejection here would
        read as "you filled this in wrong" rather than "this cannot be edited
        yet" — the banner above already says the real reason.
      */}
      {!parsed.ok && !fieldsLocked ? (
        <p
          data-field="preparation-rejection"
          data-rejection={parsed.rejection}
          style={{ margin: "8px 0 0", fontSize: 12 }}
        >
          {preparationErrorMessage(parsed.rejection)}
        </p>
      ) : null}

      <button
        type="submit"
        data-testid="preparation-save"
        data-enabled={String(saveEnabled)}
        disabled={!saveEnabled}
        aria-disabled={!saveEnabled}
        style={{
          margin: "10px 0 0",
          padding: "8px 12px",
          borderRadius: 8,
          border: "1px solid var(--border, #e5e7eb)",
          background: "transparent",
          cursor: saveEnabled ? "pointer" : "not-allowed",
          opacity: saveEnabled ? 1 : 0.55,
          // Full width on a narrow pane, natural width once there is room.
          width: "100%",
          maxWidth: 360,
        }}
      >
        Save limits
      </button>
      {message ? (
        <p
          data-field="preparation-response"
          style={{ margin: "6px 0 0", fontSize: 12 }}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The Meta STOP, rendered on whichever surface the operator is on.
 *
 * Extracted so that desktop and mobile are two RENDERS of one truth rather
 * than two implementations of it. Every piece of state it reads still lives in
 * `MetaAutomationView` and is passed down: a second `useState` here would be a
 * stop that only one pane believes in, which is the exact defect the state's
 * own comment in that component warns about. Opening the confirmation on one
 * pane therefore opens it on the other, because there is one `stopConfirm`.
 *
 * `surface` decides two things and nothing else: which reference markers are
 * carried (H19/H20 are 1440px artboards, so `data-ctl` stays on desktop — a
 * mobile duplicate would add a graded node with no contract behind it), and
 * how the duplicated DOM ids are suffixed. Both panes are in the DOM at every
 * width; only CSS hides one, so an unsuffixed id would be a real duplicate.
 */
function MetaStopControl({
  surface,
  payload,
  viewer,
  stopEngaged,
  stopPending,
  stopError,
  stopConfirm,
  stopTyped,
  stopAborted,
  stopIntent,
  stopCeremony,
  stopOutcome,
  stopEngageRefusalReason,
  stopPhraseFor,
  setStopConfirm,
  setStopTyped,
  setStopAborted,
  onStopControl,
}: {
  surface: AutomationSurface;
  payload: AutomationPayload | null;
  viewer: AutomationViewerEnvelope;
  stopEngaged: boolean;
  stopPending: boolean;
  stopError: string | null;
  stopConfirm: "engage" | "release" | null;
  stopTyped: string;
  stopAborted: string | null;
  stopIntent: "engage" | "release";
  stopCeremony: StopCeremonyState;
  stopOutcome: StopCeremonyState | null;
  stopEngageRefusalReason: string | null;
  stopPhraseFor: (direction: "engage" | "release") => string;
  setStopConfirm: (next: "engage" | "release" | null) => void;
  setStopTyped: (next: string) => void;
  setStopAborted: (next: string | null) => void;
  onStopControl: (action: "engage_kill_switch" | "release_kill_switch") => void;
}) {
  const blockerMessage = stopCeremony.blocker
    ? stopBlockerMessage(stopCeremony.blocker.code, stopIntent)
    : null;
  const engageRefusalMessage = stopEngageRefusalReason
    ? "The emergency stop is unavailable right now."
    : null;
  /*
   * `aria-disabled`, never `disabled`.
   *
   * A `disabled` button leaves the tab order, so the operator cannot reach the
   * control to read the reason it refuses — and the reason is the whole point
   * of keeping it on screen. The same choice the account-scope control and the
   * date picker already make, and the responsive gate's "reachable from the
   * keyboard" law measures it, on both panes.
   */
  const releaseRefused = Boolean(stopCeremony.blocker) || !viewer.canMutate;
  const releaseTriggerProps = {
    type: "button" as const,
    className: styles.killAction,
    "data-stop-trigger": "",
    "data-surface": surface,
    "aria-disabled": releaseRefused || stopPending ? true : undefined,
    "data-stop-refused": releaseRefused ? "" : undefined,
    title:
      blockerMessage ??
      (viewer.canMutate
        ? undefined
        : automationRefusalMessage(viewer.reasonCode)),
    onClick: () => {
      if (releaseRefused || stopPending) return;
      setStopTyped("");
      setStopAborted(null);
      setStopConfirm("release");
    },
  };
  const releaseLabel = stopPending ? "Releasing…" : "Release the stop";

  const engageRefused =
    Boolean(stopCeremony.blocker) ||
    Boolean(stopEngageRefusalReason) ||
    !viewer.canMutate;
  const engageTriggerProps = {
    type: "button" as const,
    className: styles.killAction,
    "data-stop-trigger": "",
    "data-surface": surface,
    "data-stop-engage-refused": stopEngageRefusalReason ? "" : undefined,
    "aria-disabled": engageRefused || stopPending ? true : undefined,
    "data-stop-refused": engageRefused ? "" : undefined,
    title:
      blockerMessage ??
      engageRefusalMessage ??
      (viewer.canMutate
        ? undefined
        : automationRefusalMessage(viewer.reasonCode)),
    onClick: () => {
      if (engageRefused || stopPending) return;
      setStopTyped("");
      setStopAborted(null);
      setStopConfirm("engage");
    },
  };
  const engageLabel = stopPending ? "Stopping…" : "Stop Meta writes";

  return (
    <>
      <div
        className={styles.killRow}
        data-field="business-writes-control"
        data-surface={surface}
        data-stop-preflight={
          payload?.sections?.businessControl?.status ?? "unproven"
        }
        data-stop-preflight-at={
          payload?.sections?.businessControl?.observedAt ?? undefined
        }
      >
        {stopEngaged ? (
          /*
               One set of trigger behaviour, two tags.

               The tags differ by exactly one attribute — H19/H20's `data-ctl`
               marker, which stays on the DESKTOP instance because those are
               1440px artboards where `.mobileSurface` is `display: none`; a
               mobile duplicate would add a graded node with no contract behind
               it. Everything an operator can actually do is in
               `releaseTriggerProps`, written once, so the two panes cannot
               drift.
             */
          surface === "desktop" ? (
            <button {...releaseTriggerProps} data-ctl="gated:AUTO-02 release">
              {releaseLabel}
            </button>
          ) : (
            <button {...releaseTriggerProps}>{releaseLabel}</button>
          )
        ) : surface === "desktop" ? (
          /*
           * The manifest's own key, prefix included.
           *
           * `docs/zero-base-design/v3/export/interaction-manifest.json`
           * states `k: "gated:AUTO-01A engage"`, and the key IS the
           * `data-ctl` value — the `gated:` prefix is part of the
           * contract, not a state this body chooses. An earlier revision
           * invented `live:`/`disabled:AUTOMATION-STOP`, which left the
           * anatomy gate unable to find the control it was looking for.
           * Whether the control is currently refused is carried by
           * `aria-disabled` and `data-stop-engage-refused`, where a state
           * belongs.
           */
          <button {...engageTriggerProps} data-ctl="gated:AUTO-01A engage">
            {engageLabel}
          </button>
        ) : (
          <button {...engageTriggerProps}>{engageLabel}</button>
        )}
      </div>
      {/*
        The typed confirmation, for BOTH directions.

        Releasing re-enables spend, so it is exactly as worth typing as
        stopping. The phrase is checked against the direction the operator
        opened, not against whatever the payload says now — a payload that
        changed underneath would otherwise accept a phrase for the other
        direction.
      */}
      {stopConfirm ? (
        <form
          className={styles.killNote}
          data-stop-confirm={stopConfirm}
          data-surface={surface}
          onSubmit={(event) => {
            event.preventDefault();
            const direction = stopConfirm;
            if (stopTyped.trim().toUpperCase() !== stopPhraseFor(direction))
              return;
            /*
             * Re-resolved at SUBMIT, against the payload as it is now and
             * the clock as it is now.
             *
             * The render-time resolution is a statement about the moment
             * the form opened. Typing takes time: the preflight can age
             * past `STOP_PREFLIGHT_MAX_AGE_MS` while the operator is
             * typing, and nothing re-renders when a clock passes a
             * boundary — so without this the confirmation would be made
             * against a reading the surface itself would now refuse. And
             * if the payload moved, the direction the operator opened may
             * no longer be the one the system permits; posting it anyway
             * would act on a state that changed after they read it.
             */
            const atSubmit = resolveStopCeremony({
              intent: direction,
              viewer: {
                role: viewer.role,
                isReviewer: viewer.reviewerReadOnly,
                demo: viewer.demo,
              },
              currentlyEngaged: sectionIsComplete(payload, "businessControl")
                ? stopEngaged
                : null,
              gateClosedReason: stopEngageRefusalReason ?? null,
              preflight: payload?.sections?.businessControl ?? null,
              readBack: null,
              now: Date.now(),
            });
            if (atSubmit.blocker) {
              setStopConfirm(null);
              setStopTyped("");
              setStopAborted("Refresh before changing the emergency stop.");
              return;
            }
            // The direction the system currently permits must still be
            // the one being confirmed. `stopIntent` is derived from the
            // payload, so this is the payload-moved case.
            if (stopIntent !== direction) {
              setStopConfirm(null);
              setStopTyped("");
              setStopAborted(
                direction === "engage"
                  ? "Meta automation was already stopped while this confirmation was open, so nothing was sent. Re-read the state and choose again."
                  : "Meta automation was already running again while this confirmation was open, so nothing was sent. Re-read the state and choose again.",
              );
              return;
            }
            setStopAborted(null);
            setStopConfirm(null);
            onStopControl(
              direction === "engage"
                ? "engage_kill_switch"
                : "release_kill_switch",
            );
          }}
        >
          <label htmlFor={`stop-confirm-input-${surface}`}>
            Type <b>{stopPhraseFor(stopConfirm)}</b> to{" "}
            {stopConfirm === "engage"
              ? "stop Meta automation for this business"
              : "resume Meta automation for this business"}
            <input
              aria-label={`Type ${stopPhraseFor(stopConfirm)} to confirm`}
              id={`stop-confirm-input-${surface}`}
              autoComplete="off"
              data-stop-confirm-input=""
              onChange={(event) => setStopTyped(event.target.value)}
              value={stopTyped}
            />
          </label>
          <span>
            <button
              data-stop-confirm-submit=""
              disabled={
                stopTyped.trim().toUpperCase() !== stopPhraseFor(stopConfirm)
              }
              type="submit"
            >
              {stopConfirm === "engage" ? "Stop Meta automation" : "Resume"}
            </button>
            <button
              data-stop-confirm-cancel=""
              onClick={() => setStopConfirm(null)}
              type="button"
            >
              Cancel
            </button>
          </span>
        </form>
      ) : null}
      {/*
        The refusal, addressable and beside the control rather than
        instead of it.

        The control stays on screen because a control that vanishes
        teaches an operator there is nothing here to reach for — the same
        law this card already applies to the gate. What the refusal
        removes is the ABILITY, not the affordance: the trigger is
        `aria-disabled`, carries the reason as its title, stays in the
        tab order so that reason can be reached, and its handler returns
        before opening the confirmation.
      */}
      {stopCeremony.blocker ? (
        <p
          className={styles.killNote}
          data-stop-blocked={stopCeremony.blocker.code}
          role="note"
        >
          {blockerMessage}
        </p>
      ) : null}
      {/*
        A confirmation that was abandoned because the state moved.
        `role="status"`, not `alert`: nothing went wrong and nothing was
        sent — the operator is being told why the form closed.
      */}
      {stopAborted ? (
        <p className={styles.killNote} data-stop-aborted="" role="status">
          {stopAborted}
        </p>
      ) : null}
      {stopEngageRefusalReason && !stopEngaged && !stopCeremony.blocker ? (
        <p
          className={styles.killNote}
          data-field="stop-engage-refusal"
          role="note"
        >
          {engageRefusalMessage}
        </p>
      ) : null}
      {/*
        The only two things that may announce an outcome.

        `showStatusBanner` is true exactly when a read-back was taken and
        AGREED with the intent. Anything else — a failed re-read, a
        re-read that answered the other way — is the unconfirmed banner,
        because claiming either outcome there is a guess about whether
        spend is still running.
      */}
      {stopOutcome?.showStatusBanner ? (
        <p className={styles.killNote} data-stop-status="" role="status">
          {stopEngaged
            ? "Meta automation stopped."
            : "Meta automation resumed."}
        </p>
      ) : stopOutcome?.statusMessage ? (
        <p className={styles.killNote} data-stop-unconfirmed="" role="status">
          The change could not be confirmed. Refresh before trying again.
        </p>
      ) : null}
      {stopError ? (
        <p className={styles.killNote} data-field="stop-error" role="status">
          {stopError}
        </p>
      ) : null}
    </>
  );
}

/**
 * The confirmation queue, rendered on whichever surface the operator is on.
 *
 * Same law as `MetaStopControl`: one source of state in `MetaAutomationView`,
 * two renders. `surface` exists only to suffix the modify-note id — both panes
 * are in the DOM at every width, so `proposal-note-<id>` alone would be a
 * duplicate id and therefore an accessibility defect, not merely a test
 * artifact.
 *
 * The write itself is still `onProposalControl`, which lives on the page and
 * refuses on `viewer.canMutate` before anything reaches the wire.
 */
function ConfirmationQueue({
  surface,
  proposals,
  canMutate,
  onProposalControl,
  pendingProposalId,
  proposalError,
  proposalNotice,
  modifyingProposalId,
  setModifyingProposalId,
  modificationNote,
  setModificationNote,
  queueHolds,
  queueProvenEmpty,
  onRetryRead,
  viewer,
  ledgerEvidence,
}: {
  surface: AutomationSurface;
  proposals: AutomationProposalsModel;
  canMutate: boolean;
  onProposalControl?: (
    proposalId: string,
    control: ProposalControl,
    note?: string,
  ) => void;
  pendingProposalId: string | null;
  proposalError: string | null;
  proposalNotice: string | null;
  modifyingProposalId: string | null;
  setModifyingProposalId: (next: string | null) => void;
  modificationNote: string;
  setModificationNote: (next: string) => void;
  queueHolds: MetaAutomationProposalHoldCounts | null;
  queueProvenEmpty: boolean;
  onRetryRead?: () => void;
  viewer: AutomationViewerEnvelope;
  ledgerEvidence: "complete" | "unavailable" | "no_evidence";
}) {
  const queueState =
    proposals.rows.length > 0
      ? "ready"
      : queueProvenEmpty
        ? "empty"
        : "unavailable";

  return (
    <article
      className={styles.confirmationCard}
      data-surface={surface}
      data-ledger-evidence={ledgerEvidence}
      data-queue-state={queueState}
    >
      <div className={styles.confirmationHeader}>
        <h2>Pending approvals</h2>
        <span
          className={styles.confirmationCount}
          data-state={queueState}
          data-field="confirmation-count"
        >
          {proposals.count}
        </span>
      </div>
      {proposals.rows.length > 0 ? (
        proposals.rows.map((row) => (
          <div key={row.id}>
            <div className={styles.proposalRow} data-proposal-id={row.id}>
              <span className={styles.proposalAction} data-tone={row.tone}>
                {row.action}
              </span>
              <div className={styles.proposalBody}>
                <p className={styles.proposalEntity}>{row.entity}</p>
                <p className={styles.proposalWhy}>{row.why}</p>
              </div>
              <span className={styles.proposalEvidence}>{row.evidence}</span>
              <span className={styles.proposalExpiry}>
                expires {row.expires}
              </span>
              <div className={styles.proposalControls}>
                <button
                  type="button"
                  className={styles.proposalPrimary}
                  data-tone={row.tone}
                  data-control="approve"
                  disabled={
                    !onProposalControl ||
                    !canMutate ||
                    pendingProposalId !== null
                  }
                  onClick={() => onProposalControl?.(row.id, "approve")}
                >
                  {row.primaryCaption}
                </button>
                <button
                  type="button"
                  className={styles.proposalSecondary}
                  data-control="modify"
                  aria-expanded={modifyingProposalId === row.id}
                  disabled={
                    !onProposalControl ||
                    !canMutate ||
                    pendingProposalId !== null
                  }
                  onClick={() => {
                    setModificationNote("");
                    setModifyingProposalId(
                      modifyingProposalId === row.id ? null : row.id,
                    );
                  }}
                >
                  Modify
                </button>
                <button
                  type="button"
                  className={styles.proposalTertiary}
                  data-control="dismiss"
                  disabled={
                    !onProposalControl ||
                    !canMutate ||
                    pendingProposalId !== null
                  }
                  onClick={() => onProposalControl?.(row.id, "dismiss")}
                >
                  Dismiss
                </button>
              </div>
            </div>
            {modifyingProposalId === row.id ? (
              <div
                className={styles.proposalModify}
                data-testid="proposal-modify"
              >
                <label htmlFor={`proposal-note-${row.id}-${surface}`}>
                  What should happen instead
                </label>
                <input
                  id={`proposal-note-${row.id}-${surface}`}
                  type="text"
                  value={modificationNote}
                  onChange={(event) => setModificationNote(event.target.value)}
                />
                <button
                  type="button"
                  className={styles.proposalSecondary}
                  data-control="modify-submit"
                  disabled={
                    !onProposalControl ||
                    !canMutate ||
                    pendingProposalId !== null ||
                    modificationNote.trim().length === 0
                  }
                  onClick={() => {
                    onProposalControl?.(
                      row.id,
                      "modify",
                      modificationNote.trim(),
                    );
                    setModifyingProposalId(null);
                    setModificationNote("");
                  }}
                >
                  Record modification
                </button>
              </div>
            ) : null}
          </div>
        ))
      ) : (
        // "Nothing needs confirmation" and "the queue could not be read"
        // are different facts and only one of them may be offered a
        // recovery. The proven-empty state renders exactly what it always
        // did; the unreadable one gets the em dash AND the control that
        // re-runs the read, because a failure with no way back is a dead
        // end an operator can only escape by reloading the page.
        <div
          className={styles.confirmationEmpty}
          data-testid="confirmation-empty"
          // Proven empty means the queue read completed AND the server
          // proved nothing is being held. A claimed row being dispatched
          // right now, a reconcile row awaiting reconciliation, or a hold
          // count that could not be read at all each keep this `false`.
          data-proven-empty={queueProvenEmpty ? "true" : "false"}
        >
          {/*
              The em dash stays in BOTH states: the count badge above already
              separates a proven `0` from an unproven `—`, and changing this
              cell's own copy is a design decision this change has no mandate
              to make. What changes is only that the unreadable state now has
              a way back.
            */}
          <span>
            {queueProvenEmpty
              ? "No actions waiting for approval"
              : "Pending actions are unavailable"}
          </span>
          {queueProvenEmpty ? null : (
            <button
              type="button"
              className={styles.readRetry}
              data-control="retry-queue"
              disabled={!onRetryRead}
              onClick={onRetryRead}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {proposalNotice ? (
        <p
          className={styles.proposalError}
          data-field="proposal-notice"
          data-tone="notice"
          role="status"
        >
          {proposalNotice}
        </p>
      ) : null}
      {proposalError ? (
        <p className={styles.proposalError} role="status">
          {proposalError}
        </p>
      ) : null}
      {/*
          The server said this viewer may not write, so the refusal is stated
          once, here, beside the controls it explains — rather than arriving
          as a 403 after a click. It is the SERVER's sentence and the SERVER's
          code, restated verbatim: re-wording either would describe a guard
          this surface does not own.

          No new happy-path chrome: `canMutate` is true on every canonical
          render, so this element does not exist there at all.
        */}
      {proposals.rows.length > 0 && !viewer.canMutate && viewer.reason ? (
        <p
          className={styles.sectionFootnote}
          role="status"
          data-field="viewer-refusal"
          data-reason-code={viewer.reasonCode ?? ""}
        >
          {automationRefusalMessage(viewer.reasonCode)}
        </p>
      ) : null}
      {/*
          What the queue is holding but cannot offer. `claimed` is a dispatch
          in flight and `reconcile` is an outcome nobody has confirmed; the
          invariant keeps the second one pending with retry forbidden, so the
          only correct thing this screen can do is say so. Neither is
          approvable, so neither appears as a row — and before this the
          operator was simply told `0`.

          Renders only when there is something to say. A queue with no holds
          draws nothing, so the canonical state is untouched.
        */}
      {queueHolds !== null &&
      (queueHolds.claimed > 0 || queueHolds.reconcile > 0) ? (
        <p
          className={styles.sectionFootnote}
          role="status"
          data-field="queue-holds"
          data-holds="present"
          data-claimed={queueHolds.claimed}
          data-reconcile={queueHolds.reconcile}
        >
          {queueHolds.claimed > 0 ? (
            <span data-field="queue-holds-claimed">
              {queueHolds.claimed} action{queueHolds.claimed === 1 ? "" : "s"}{" "}
              in progress
            </span>
          ) : null}
          {queueHolds.claimed > 0 && queueHolds.reconcile > 0 ? " · " : null}
          {queueHolds.reconcile > 0 ? (
            <span data-field="queue-holds-reconcile">
              {queueHolds.reconcile} action
              {queueHolds.reconcile === 1 ? "" : "s"} need review
            </span>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}
