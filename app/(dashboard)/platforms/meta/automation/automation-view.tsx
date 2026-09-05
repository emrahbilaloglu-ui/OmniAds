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
  STOP_PREFLIGHT_MAX_AGE_MS,
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
import styles from "./automation.module.css";

type AutomationPayload = MetaAutomationControlPlane;

export interface MetaAutomationPageProps {
  /** A server-authorized route scope. When present, client store state cannot replace it. */
  businessId?: string;
  /** `null` is an intentional unresolved scope and must not silently select an account. */
  providerAccountId?: string | null;
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
  control_row_absent: "Save this business's automation guardrails.",
  global_gate_closed: "The production live-write capability is still closed.",
  business_stop_engaged: "Release the business emergency stop.",
  budget_mode_not_auto: "Set Budget to Automatic.",
  dry_run_guardrail_engaged: "Turn off dry-run-only in the saved guardrails.",
  canonical_fact_retention_not_ready:
    "Historical canonical-decision retention is not yet proven.",
  profile_retention_not_ready:
    "Performance-profile retention is not yet proven.",
  automatic_role_retention_not_ready:
    "Automatic campaign-role history is not yet proven.",
  account_scope_not_exact: "Select and verify exactly one Meta ad account.",
  journal_schema_not_ready: "The execution journal is not ready.",
  unresolved_reconciliation: "Resolve the in-progress provider reconciliation.",
  open_claim: "Wait for or clear the open execution claim.",
};

function activationBlockerLabel(code: string): string {
  if (code === "enabling_actor_absent") {
    return "The enabling admin no longer has active authority.";
  }
  return (
    ACTIVATION_BLOCKER_LABELS[code as BudgetActivationCondition] ??
    code.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())
  );
}

const PREPARATION_FIELD_LABELS: Record<
  (typeof BUDGET_PREPARATION_FIELDS)[number],
  string
> = {
  dryRunOnly: "dry-run choice",
  budgetMinHoursBetweenChanges: "minimum hours between changes",
  budgetMaxChangesPer7d: "maximum changes per 7 days",
  budgetMaxAccountConcentrationPct: "maximum account concentration",
  maxBudgetIncreasePct: "maximum single increase",
  perActionSpendCeilingMinor: "per-action spend ceiling",
  perActionSpendCeilingCurrency: "spend-ceiling currency",
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
    "Automation could not be read, so every figure below is unknown rather than zero.",
  automation_control_state_unavailable:
    "The automation control state could not be read, so the kill switch, guardrails and readiness above are unknown rather than the defaults they would otherwise show.",
  provider_account_scope_unresolved:
    "No Meta ad account is resolved for this business, so Automation was never read — the confirmation queue and every account-scoped figure below is unknown rather than empty.",
  provider_account_none_assigned:
    "No Meta ad account is assigned to this business, so Automation has nothing to read.",
  provider_account_not_assigned:
    "The requested Meta ad account is not assigned to this business, so Automation was never read.",
  provider_account_scope_unavailable:
    "Meta account assignments could not be read, so Automation was never read — every figure below is unknown rather than zero.",
  // Codes the route returns that previously arrived here flattened into the
  // general sentence. Each says what actually happened and what to do, because
  // "could not be read" is true of all of them and useful for none.
  automation_contract_failed:
    "Automation was read and the control plane failed while answering, so every figure below is unknown rather than zero. Retrying is safe — nothing on this screen has been changed.",
  unauthorized:
    "Your session is no longer signed in, so Automation was never read. Sign in again to see the current control state.",
  forbidden:
    "You do not have access to this business's Automation controls, so nothing below was read.",
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
      label: "Approvals reach Meta",
      /*
       * The EFFECTIVE posture, not the column's alone. Either lock closes it,
       * and the server applies exactly this rule in `metaAutomationDryRunOnly`,
       * so the row and the route now answer together instead of disagreeing
       * about the one fact that decides whether an approval leaves the
       * building.
       */
      value: guardrails
        ? guardrails.dryRunOnly || liveWritesRefusalReason
          ? "No — dry run only"
          : "Yes"
        : UNKNOWN,
    },
    {
      key: "budget-change",
      label: "Max budget change / day",
      value: guardrails
        ? `+${formatNumber(guardrails.maxBudgetIncreasePct)}% max`
        : UNKNOWN,
    },
    {
      key: "roas-floor",
      label: "Min ROAS floor (pause)",
      value:
        typeof guardrails?.minRoasFloor === "number"
          ? formatRoas(guardrails.minRoasFloor)
          : UNKNOWN,
    },
    {
      key: "actions-per-day",
      label: "Max actions / day",
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
  const modesProven = sectionState(payload, "decisionModes") !== "unavailable";
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
    mapped(`Budget changes ≤ ${budgetLimit}`, "budget"),
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
  return entity.id?.trim() || UNKNOWN;
}

function ledgerResultFor(
  item: MetaAutomationActivityItem,
): LedgerResultPresentation {
  const result = item.result;
  if (!result) return { label: UNKNOWN, tone: "unknown" };
  if (result.receiptId) {
    return { label: `Receipt ${result.receiptId}`, tone: result.status };
  }
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
        Rules raise proposals into the confirmation queue. Nothing created here
        can execute a provider write.
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
 * The account choice, offered ONLY where the scope is unresolved.
 *
 * The design draws no account control on this screen, and in the resolved
 * state this renders nothing at all — the surface is byte-identical. It exists
 * because the unresolved state was a dead end: every card em-dashed, the
 * notice said the scope was unresolved, and a multi-account business had no
 * way to say which account it meant short of hand-editing the address bar.
 *
 * The client may only REQUEST an account. Selecting one writes the id into the
 * URL and the server re-resolves it against this business's assignments on the
 * next render, so an unassigned id is still refused. A URL parameter therefore
 * never becomes authority — it becomes a question the server answers.
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
        // No pre-selection. Picking the first of several assigned accounts on
        // the operator's behalf is exactly the silent scope this screen must
        // never invent.
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
            {account.name ?? account.id}
            {account.currency ? ` · ${account.currency}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

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
  /** The business's assigned Meta accounts, for the unresolved-scope picker. */
  providerAccounts?: MetaHistoryAccount[];
  providerAccountsLoading?: boolean;
  /**
   * Requests an account by writing it into the URL. Absent means this render
   * cannot express a choice, and the picker is then not drawn at all rather
   * than drawn inert.
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
              body?.error?.message ??
                "The stop could not be changed, and nothing on Meta was altered.",
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
          setStopError("The automation control plane could not be reached.");
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
              [decisionType]:
                body?.error?.message ??
                "The autonomy mode could not be changed, and nothing on Meta was altered.",
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
                "The change was accepted but the control plane could not be re-read, so this row may be stale.",
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
                : "Saved, but the control plane reports a different mode. Re-read shown.",
          }));
        })
        .catch(() => {
          setModeError((previous) => ({
            ...previous,
            [decisionType]:
              "The automation control plane could not be reached.",
          }));
        })
        .finally(() => setModePending(null));
    },
    [
      businessId,
      providerAccountId,
      modePending,
      viewer.canMutate,
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
    const next = await readAutomation({ businessId, providerAccountId })
      .catch(() => null);
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
  const ledgerIsProvenEmpty =
    payload?.readCompleteness?.activityLedger === "complete";
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
    } catch (error) {
      setRuleError(
        error instanceof Error ? error.message : "Rule change was not applied.",
      );
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
    } catch (error) {
      setRuleError(
        error instanceof Error ? error.message : "Rule was not created.",
      );
    } finally {
      setComposerBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <section
        className={`${styles.desktopSurface} ${styles.automation}`}
        data-screen-label="Automation"
        data-testid="automation-exact-desktop"
      >
        <div>
          <p className={styles.eyebrow}>Meta · Automation control</p>
          <h1 className={styles.title}>Automation</h1>
        </div>

        <article
          className={styles.operatingState}
          data-testid="automation-operating-state"
          data-business-master-switch={businessMasterSwitchState.toLowerCase()}
        >
          <div>
            <p className={styles.operatingStateEyebrow}>
              Business-wide setting
            </p>
            <h2>Business master switch is {businessMasterSwitchState}</h2>
            <p>
              {businessMasterSwitchState === "OFF"
                ? "No Meta change can run automatically for this business. You can finish configuration, historical backtests and readiness checks without turning it on."
                : businessMasterSwitchState === "ON"
                  ? payload?.execution.autoExecutionAllowed
                    ? "The business master switch is on and the business-level safety gates currently allow automatic execution. The exact account activation and every proposal preflight must still pass before Meta can change."
                    : "The business master switch is on, but effective automatic execution is blocked by the current safety state. Review the blockers below; no Meta change can run automatically while they remain."
                  : "The server could not prove the business master-switch setting. Writes remain fail-closed until the control state can be read."}
            </p>
            {budgetWriteReadiness ? (
              <a
                className={styles.operatingStateLink}
                href="#automatic-execution-control"
              >
                Review setup and execution controls
              </a>
            ) : null}
          </div>
          <dl>
            <div>
              <dt>Readiness</dt>
              <dd>{readiness}</dd>
            </div>
            <div>
              <dt>Pending approvals</dt>
              <dd>{proposals.count}</dd>
            </div>
            <div>
              <dt>Activation blockers</dt>
              <dd>
                {budgetWriteReadiness
                  ? budgetWriteReadiness.execution.activationReadyBlockers
                      .length
                  : UNKNOWN}
              </dd>
            </div>
          </dl>
        </article>

        {/*
          The failure state's own recovery. The read this re-runs is the one
          that already exists; without a control to invoke it the only way back
          from a transient failure was a full page reload, and the screen gave
          no sign that a reload was what it needed.
        */}
        {readFailure ? (
          <p
            className={styles.readError}
            role="status"
            data-field="read-error"
            data-reason={readFailure}
          >
            <span>{readFailureMessage(readFailure)}</span>
            {/*
              The way out of the dead end, mounted only here. In the resolved
              state this whole notice does not render, so the design's surface
              is untouched.
            */}
            {onSelectProviderAccount && !providerAccountId ? (
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
        ) : null}

        <div className={styles.summaryGrid}>
          <article className={styles.killCard}>
            <p className={styles.cardKickerDark}>Emergency stops</p>
            <div className={styles.killRow}>
              {/*
                Was "Global writes". The switch behind it is
                `META_ADS_WRITE_KILL_SWITCH`, which only `lib/meta/ads-write.ts`
                and the Meta routes read — `lib/google-ads/advisor-mutate.ts`
                neither reads it nor imports anything from the Meta control
                plane. "Global" therefore claimed a reach the control does not
                have, and an operator reaching for it in an incident would have
                believed Google Ads had stopped too.
              */}
              <span>All-business Meta stop</span>
              <span
                className={styles.statusPill}
                data-tone={globalStatus.tone}
                data-field="global-writes"
                data-read-only="true"
              >
                {globalStatus.label}
              </span>
            </div>
            <div className={styles.killRow}>
              <span>This-business Meta stop</span>
              <span
                className={styles.statusPill}
                data-tone={businessStatus.tone}
                data-field="business-writes"
              >
                {businessStatus.label}
              </span>
            </div>
            {/*
              The Stop itself, which this screen described and never offered.
              WP13 left it out deliberately, and "deliberately absent" reads on
              screen as "this product cannot stop Meta writes" — which is false,
              and dangerous in the moment an operator needs it.

              Engage is held by `META_AUTOMATION_STOP_UI` and stays visible with
              its reason: a control that vanishes teaches an operator there is
              nothing here to reach for. Release is NEVER held, at any gate
              setting — a stop that cannot be lifted is the trap the gate was
              written to avoid.
            */}
            {/*
              The reading this confirmation is made against, and its age.

              `sections.businessControl` is the server's own per-section
              provenance: the instant the read was ATTEMPTED, and the error code
              when it failed. Stated on screen because a typed confirmation is a
              confirmation of a READING — an operator who types the phrase
              against a reading from half an hour ago has confirmed a screen.
            */}
            <p
              className={styles.killNote}
              data-field="stop-preflight"
              data-stop-preflight={
                payload?.sections?.businessControl?.status ?? "unproven"
              }
              data-stop-preflight-at={
                payload?.sections?.businessControl?.observedAt ?? undefined
              }
            >
              Control-plane reading{" "}
              {payload?.sections?.businessControl
                ? `${payload.sections.businessControl.status} at ${payload.sections.businessControl.observedAt}`
                : "not served by this payload"}
              . A confirmation older than{" "}
              {Math.round(STOP_PREFLIGHT_MAX_AGE_MS / 60000)} minutes is
              refused.
            </p>
            <div
              className={styles.killRow}
              data-field="business-writes-control"
            >
              {stopEngaged ? (
                <button
                  type="button"
                  className={styles.killAction}
                  data-ctl="gated:AUTO-02 release"
                  data-stop-trigger=""
                  /*
                   * `aria-disabled`, never `disabled`.
                   *
                   * A `disabled` button leaves the tab order, so the operator
                   * cannot reach the control to read the reason it refuses —
                   * and the reason is the whole point of keeping it on screen.
                   * The same choice the account-scope control and the date
                   * picker already make, and the responsive gate's
                   * "reachable from the keyboard" law measures it.
                   */
                  aria-disabled={
                    Boolean(stopCeremony.blocker) ||
                    !viewer.canMutate ||
                    stopPending
                      ? true
                      : undefined
                  }
                  data-stop-refused={
                    Boolean(stopCeremony.blocker) || !viewer.canMutate
                      ? ""
                      : undefined
                  }
                  title={
                    stopCeremony.blocker?.message ??
                    (viewer.canMutate
                      ? undefined
                      : (viewer.reason ?? undefined))
                  }
                  onClick={() => {
                    if (
                      stopCeremony.blocker ||
                      !viewer.canMutate ||
                      stopPending
                    )
                      return;
                    setStopTyped("");
                    setStopAborted(null);
                    setStopConfirm("release");
                  }}
                >
                  {stopPending ? "Releasing…" : "Release the stop"}
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.killAction}
                  /*
                   * The manifest's own key, prefix included.
                   *
                   * `docs/zero-base-design/v3/export/interaction-manifest.json`
                   * states `k: "gated:AUTO-01A engage"`, and the key IS the
                   * `data-ctl` value — the `gated:` prefix is part of the
                   * contract, not a state this body chooses. An earlier
                   * revision invented `live:`/`disabled:AUTOMATION-STOP`, which
                   * left the anatomy gate unable to find the control it was
                   * looking for. Whether the control is currently refused is
                   * carried by `aria-disabled` and `data-stop-engage-refused`,
                   * where a state belongs.
                   */
                  data-ctl="gated:AUTO-01A engage"
                  data-stop-trigger=""
                  data-stop-engage-refused={
                    stopEngageRefusalReason ? "" : undefined
                  }
                  // `aria-disabled` rather than `disabled` — see the release
                  // trigger above for why the control must stay focusable.
                  aria-disabled={
                    Boolean(stopCeremony.blocker) ||
                    Boolean(stopEngageRefusalReason) ||
                    !viewer.canMutate ||
                    stopPending
                      ? true
                      : undefined
                  }
                  data-stop-refused={
                    Boolean(stopCeremony.blocker) ||
                    Boolean(stopEngageRefusalReason) ||
                    !viewer.canMutate
                      ? ""
                      : undefined
                  }
                  title={
                    stopCeremony.blocker?.message ??
                    stopEngageRefusalReason ??
                    viewer.reason ??
                    undefined
                  }
                  onClick={() => {
                    if (
                      stopCeremony.blocker ||
                      stopEngageRefusalReason ||
                      !viewer.canMutate ||
                      stopPending
                    )
                      return;
                    setStopTyped("");
                    setStopAborted(null);
                    setStopConfirm("engage");
                  }}
                >
                  {stopPending ? "Stopping…" : "Stop Meta writes"}
                </button>
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
                onSubmit={(event) => {
                  event.preventDefault();
                  const direction = stopConfirm;
                  if (
                    stopTyped.trim().toUpperCase() !== stopPhraseFor(direction)
                  )
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
                    currentlyEngaged: sectionIsComplete(
                      payload,
                      "businessControl",
                    )
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
                    setStopAborted(atSubmit.blocker.message);
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
                <label>
                  Type <b>{stopPhraseFor(stopConfirm)}</b> to{" "}
                  {stopConfirm === "engage"
                    ? "stop Meta automation for this business"
                    : "resume Meta automation for this business"}
                  <input
                    aria-label={`Type ${stopPhraseFor(stopConfirm)} to confirm`}
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
                      stopTyped.trim().toUpperCase() !==
                      stopPhraseFor(stopConfirm)
                    }
                    type="submit"
                  >
                    {stopConfirm === "engage"
                      ? "Stop Meta automation"
                      : "Resume"}
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
                {stopCeremony.blocker.message}
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
            {stopEngageRefusalReason &&
            !stopEngaged &&
            !stopCeremony.blocker ? (
              <p
                className={styles.killNote}
                data-field="stop-engage-refusal"
                role="note"
              >
                {stopEngageRefusalReason}
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
                {stopOutcome.statusMessage}
              </p>
            ) : stopOutcome?.statusMessage ? (
              <p
                className={styles.killNote}
                data-stop-unconfirmed=""
                role="status"
              >
                {stopOutcome.statusMessage}
              </p>
            ) : null}
            {stopError ? (
              <p
                className={styles.killNote}
                data-field="stop-error"
                role="status"
              >
                {stopError}
              </p>
            ) : null}
            <p
              className={styles.killNote}
              data-field="kill-switch-scope"
              /*
               * H19's `google-posture-row`. This IS the row that states
               * Google's posture: that neither switch above reaches it. The
               * artboard requires the claim to be addressable, because "one
               * switch stops everything" is the belief this sentence exists to
               * correct.
               */
              data-el="google-posture-row"
            >
              Flipping either switch blocks every <b>Meta</b> write instantly —
              server-enforced, not a UI state.{" "}
              <b>No control on this screen stops Google Ads writes.</b>
            </p>
          </article>

          <article
            className={styles.guardrailCard}
            /*
             * H19 requires the guardrails to be addressable AND to say that
             * they are read-only here — `AUTO-05..10 remain read-only rows` in
             * the interaction manifest. They are: every row below renders a
             * label and a value with no control.
             */
            data-el="guardrails-readonly"
            /*
             * The KIND, not the artboard-prefixed id. `collectionKind` in
             * `verify-reference-anatomy.ts` strips the `h19-` prefix before
             * comparing, so the prefixed value the manifest lists is never what
             * a body should carry — a marker written as `h19-guardrails` is a
             * marker the gate looks for and cannot find.
             */
          >
            <p className={styles.cardKicker}>
              Guardrails
              {hasServedBusinessControl(payload) &&
              businessControlIsDefault(payload) ? (
                // These are the system defaults, and they are in force: every
                // approval on this screen is a dry run because `dryRunOnly`
                // defaults true. Naming them as defaults is the difference
                // between "nobody set a limit" and "nobody set a limit, so
                // these apply".
                //
                // Gated on the read having happened, because an unread control
                // also arrives with `source: "default"`. Saying "defaults, not
                // set here" there asserts nobody configured a guardrail, when
                // what actually happened is that the server could not find out
                // — the opposite claim, beside four em dashes.
                <span data-field="guardrail-source">
                  {" "}
                  · defaults, not set here
                </span>
              ) : null}
            </p>
            {/*
              The collection NESTED inside the region, which is where the
              reference puts it. `data-el="guardrails-readonly"` and
              `data-collection="guardrails"` were on the same element, and the
              fidelity gate reads ownership from the tree: it reported
              `wrong-owner — reference nests this inside el:guardrails-readonly;
              implementation nests it under the frame root`. A marker in the
              right document but the wrong place is not the same marker.
            */}
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
            {/*
              Two of those rows were readable and unsettable.

              The ROAS floor gates whether a pause is even proposed, and quiet
              hours decide when an alert may interrupt someone — both persisted,
              both server-enforced, and neither reachable from any screen. The
              route has accepted `set_guardrail_policy` all along; nothing sent
              it. A limit an operator cannot set is a limit that belongs to
              whoever last edited the database.
            */}
            <GuardrailPolicyForm
              businessId={businessId}
              providerAccountId={providerAccountId}
              canMutate={viewer.canMutate}
              minRoasFloor={payloadGuardrails?.minRoasFloor ?? null}
              quietHours={payloadGuardrails?.quietHours ?? null}
              onSaved={onGuardrailPolicySaved}
            />
          </article>

          <article className={styles.readinessCard}>
            <p className={styles.cardKicker}>Readiness</p>
            <span className={styles.readinessBadge} data-field="readiness-tier">
              {readiness}
            </span>
            <p className={styles.readinessCopy}>
              {showCanonicalReadinessCopy ? (
                <>
                  Every action requires operator confirmation. Per-action
                  auto-execute is <b>locked · contract required</b> — promotion
                  records will unlock tiers per action kind.
                </>
              ) : (
                UNKNOWN
              )}
            </p>
            <span
              className={styles.promotionCount}
              data-field="promotion-count"
            >
              {promotionCount}
            </span>
          </article>
        </div>

        <article className={styles.confirmationCard}>
          <div className={styles.confirmationHeader}>
            <h2>Needs your confirmation</h2>
            <span
              className={styles.confirmationCount}
              data-field="confirmation-count"
            >
              {proposals.count}
            </span>
            <span className={styles.confirmationHint}>
              engine proposals wait here — nothing executes without you at Tier
              1
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
                  <span className={styles.proposalEvidence}>
                    {row.evidence}
                  </span>
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
                    <label htmlFor={`proposal-note-${row.id}`}>
                      What should happen instead
                    </label>
                    <input
                      id={`proposal-note-${row.id}`}
                      type="text"
                      value={modificationNote}
                      onChange={(event) =>
                        setModificationNote(event.target.value)
                      }
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
              <span>{UNKNOWN}</span>
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
          {!viewer.canMutate && viewer.reason ? (
            <p
              className={styles.sectionFootnote}
              role="status"
              data-field="viewer-refusal"
              data-reason-code={viewer.reasonCode ?? ""}
            >
              {viewer.reason}
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
          {queueHolds === null ? (
            <p
              className={styles.sectionFootnote}
              role="status"
              data-field="queue-holds"
              data-holds="unreadable"
            >
              held proposals could not be counted, so this queue is not proven
              empty — a dispatch in progress or a row awaiting reconciliation
              would not be visible here
            </p>
          ) : queueHolds.claimed > 0 || queueHolds.reconcile > 0 ? (
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
                  {queueHolds.claimed} dispatch in progress
                </span>
              ) : null}
              {queueHolds.claimed > 0 && queueHolds.reconcile > 0
                ? " · "
                : null}
              {queueHolds.reconcile > 0 ? (
                <span data-field="queue-holds-reconcile">
                  {queueHolds.reconcile} reconciliation required — retry is
                  forbidden until it is reconciled
                </span>
              ) : null}
            </p>
          ) : null}
          {/*
            The middle clause is a claim about evidence, so it is only made
            when the evidence exists. A decision whose ledger INSERT failed is
            still recorded — on the proposal row itself, with its receipt and
            its receipt key — but it is NOT in the ledger, and printing the
            promise anyway is what turned a swallowed error into a lie. Every
            other state renders the design's own sentence, unchanged.
          */}
          <p
            className={styles.sectionFootnote}
            data-field="queue-footnote"
            data-ledger-evidence={ledgerEvidence}
          >
            {ledgerEvidence === "unavailable" ? (
              <>
                approving executes inside the guardrails above · the last
                decision could not be written to the activity ledger — its
                receipt is on the proposal record · expired proposals
                re-evaluate on the next snapshot
              </>
            ) : ledgerEvidence === "no_evidence" ? (
              // Nothing proves the ledger works and nothing proves it failed.
              // The two clauses that are still true are printed; the one that
              // is a claim about evidence is not made at all.
              <>
                approving executes inside the guardrails above · expired
                proposals re-evaluate on the next snapshot
              </>
            ) : (
              <>
                approving executes inside the guardrails above · every outcome
                lands in the ledger with a receipt · expired proposals
                re-evaluate on the next snapshot
              </>
            )}
          </p>
        </article>

        <details className={styles.advancedAutomation}>
          <summary>
            <span>Advanced automation settings</span>
            <small>Rules, autonomy tiers and activity history</small>
          </summary>
          <div className={styles.advancedAutomationBody}>
            <div className={styles.rulesAutonomyGrid}>
              <article className={styles.rulesCard}>
                <div className={styles.sectionHeader}>
                  <h2>Rules</h2>
                  <span className={styles.sectionHint}>
                    deterministic triggers · anchored to the Commercial Truth
                    pack
                  </span>
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
                <div className={styles.tableScroll}>
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
                        // "No rules exist" and "the rules could not be read" are
                        // different facts, and the adapter has already separated
                        // them. Collapsing both into an em dash told an operator
                        // who had just created a rule the same thing it told one
                        // whose read had failed. Same rule as `0×` on the Fired
                        // column: a proven zero is a fact and is stated as one.
                        <tr
                          className={styles.rulesEmpty}
                          data-testid="rules-empty"
                          data-proven-empty={
                            rules.isProvenEmpty ? "true" : "false"
                          }
                        >
                          <td colSpan={5}>
                            {rules.isProvenEmpty ? "No rules yet" : UNKNOWN}
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
                <p className={styles.sectionFootnote}>
                  rules never write directly — they raise proposals into the
                  confirmation queue (or hard-block, for guards)
                </p>
              </article>

              <article className={styles.autonomyCard}>
                <div className={styles.sectionHeaderCompact}>
                  <h2>Autonomy ladder</h2>
                  <span className={styles.sectionHint}>per action kind</span>
                </div>
                {autonomy.map((item) => (
                  <div
                    className={styles.autonomyRow}
                    data-decision-type={item.decisionType ?? "launch"}
                    key={item.kind}
                  >
                    <div className={styles.autonomyTopline}>
                      <span className={styles.autonomyKind}>{item.kind}</span>
                      <span
                        className={styles.autonomyTier}
                        data-tone={item.tone}
                      >
                        {item.tier}
                      </span>
                    </div>
                    {/*
                  AUTO-03 — the mode itself, as a control rather than a caption.
                  The launch row is deliberately excluded: it has no server
                  decision type, and new spend never automates by design, so a
                  control there would offer a choice the product does not have.
                */}
                    {item.decisionType ? (
                      <div
                        className={styles.modeGroup}
                        role="radiogroup"
                        aria-label={`Autonomy mode — ${item.kind}`}
                        data-ctl="gated:AUTO-03 mode"
                        data-mode-refused={viewer.canMutate ? undefined : ""}
                      >
                        {AUTONOMY_MODES.map((mode) => {
                          const current = currentModeFor(
                            payload,
                            item.decisionType!,
                          );
                          const refused = !viewer.canMutate;
                          return (
                            <button
                              key={mode}
                              type="button"
                              className={styles.modeSegment}
                              role="radio"
                              aria-checked={current === mode}
                              data-mode={mode}
                              disabled={
                                refused || modePending === item.decisionType
                              }
                              title={
                                refused
                                  ? (viewer.reason ?? undefined)
                                  : undefined
                              }
                              /*
                               * Short on screen, full to a reader. Three segments
                               * carrying "Tier 2 · Backtest" wrap the row at the
                               * card's width and stop being one scannable control;
                               * the tier chip beside them already spells the
                               * current one out, and the accessible name carries
                               * the whole thing for anyone not reading the chip.
                               */
                              aria-label={MODE_LABELS[mode]}
                              onClick={() =>
                                onModeChange(item.decisionType!, mode)
                              }
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
                    <div className={styles.progressRow}>
                      <span className={styles.progressTrack}>
                        <span
                          className={styles.progressFill}
                          data-tone={item.progressTone}
                          style={{ width: item.progressWidth }}
                        />
                      </span>
                      <span className={styles.progressValue}>
                        {item.progress}
                      </span>
                    </div>
                    <p className={styles.autonomyNext}>{item.next}</p>
                  </div>
                ))}
                <p className={styles.sectionFootnote}>
                  promotion reviews weekly on clean-approval streaks · any error
                  demotes instantly
                </p>
                {/*
              What recording a mode does and does not do.
              `setMetaAutomationDecisionTypeMode` writes a row in our own
              control plane; it is not a Meta write and it does not by itself
              enable auto-execution. Without this sentence, moving a row to
              Tier 3 while `META_AUTOMATION_LIVE_WRITES` is shut reads as
              "this now changes things on Meta", which is the one thing it
              must never be mistaken for.
            */}
                <p className={styles.sectionFootnote} data-field="mode-posture">
                  {liveWritesRefusalReason
                    ? `Choosing a mode records it in this workspace. It is not a Meta write, and it does not enable automatic execution: ${liveWritesRefusalReason}`
                    : "Choosing a mode records it in this workspace. It is not a Meta write; execution still runs through the confirmation queue."}
                </p>
              </article>
            </div>

            <article className={styles.ledgerCard}>
              <div className={styles.ledgerHeader}>
                <h2>Activity ledger</h2>
              </div>
              <div className={styles.tableScroll}>
                <table className={styles.ledgerTable}>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Entity</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.length > 0 ? (
                      ledger.map((item) => {
                        const result = ledgerResultFor(item);
                        return (
                          <tr data-ledger-id={item.id} key={item.id}>
                            <td className={styles.ledgerTime}>
                              {formatLedgerTime(item.createdAt)}
                            </td>
                            <td data-field="ledger-actor">
                              {ledgerActorFor(item)}
                            </td>
                            <td className={styles.ledgerAction}>
                              {item.message.trim() || item.activityType}
                            </td>
                            <td data-field="ledger-entity">
                              {ledgerEntityFor(item)}
                            </td>
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
                      // "This workspace has never acted" and "the activity read
                      // failed" are different facts and only one of them may be
                      // stated. Same `data-proven-empty` pattern the rules table
                      // uses two sections up, for the same reason.
                      <tr
                        className={styles.ledgerEmpty}
                        data-testid="ledger-empty"
                        data-proven-empty={
                          ledgerIsProvenEmpty ? "true" : "false"
                        }
                      >
                        <td colSpan={5}>
                          {ledgerIsProvenEmpty ? "No activity yet" : UNKNOWN}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </article>
          </div>
        </details>

        <details className={styles.systemDiagnostics}>
          <summary>System diagnostics</summary>
          <p>
            Storage admission and proposal construction evidence for recovery
            work. These diagnostics do not enable automation.
          </p>
          <div className={styles.systemDiagnosticsBody}>
            <StateHistoryRecoverySection readiness={stateHistoryReadiness} />
            <BudgetReadinessSection readiness={budgetReadiness} />
          </div>
        </details>
        <BudgetWriteReadinessSection
          readiness={budgetWriteReadiness}
          authorization={buildBudgetMasterSwitchAuthorization({
            viewer,
            surface: "desktop",
          })}
          onActivationChanged={onBudgetActivationChanged}
        />
      </section>

      <section
        className={styles.mobileSurface}
        data-testid="meta-mobile-automation"
        data-read-only="true"
        aria-labelledby="automation-mobile-title"
      >
        <div className={styles.mobileHeading}>
          <p className={styles.mobileEyebrow}>Automation status</p>
          <span className={styles.mobileReadOnly}>Read-only</span>
        </div>
        <h1 id="automation-mobile-title">Meta authority</h1>
        <p className={styles.mobileIntro}>
          Current server-read status. Automation controls are available only in
          the desktop workspace. Everything here governs Meta writes only; no
          control on this screen stops Google Ads writes.
        </p>
        <dl className={styles.mobileFacts}>
          <div>
            <dt>Meta writes · all businesses</dt>
            <dd>{globalStatus.label}</dd>
          </div>
          <div>
            <dt>Meta writes · this business</dt>
            <dd>{businessStatus.label}</dd>
          </div>
          <div>
            <dt>Readiness</dt>
            <dd>{readiness}</dd>
          </div>
          <div>
            <dt>Ad account</dt>
            <dd>{providerAccountId || UNKNOWN}</dd>
          </div>
        </dl>
        <details className={styles.systemDiagnostics}>
          <summary>Readiness details</summary>
          <p>
            Historical evidence, storage health and budget execution readiness.
            This mobile view remains read-only.
          </p>
          <div className={styles.systemDiagnosticsBody}>
            <StateHistoryRecoverySection readiness={stateHistoryReadiness} />
            <BudgetReadinessSection readiness={budgetReadiness} />
            {/* The mobile pane declares itself read-only; it carries no form. */}
            <BudgetWriteReadinessSection
              readiness={budgetWriteReadiness}
              authorization={buildBudgetMasterSwitchAuthorization({
                viewer,
                surface: "mobile_read_only",
              })}
            />
          </div>
        </details>
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
  const floorValid = parsedFloor === null
    || (Number.isFinite(parsedFloor) && parsedFloor > 0);
  // A window needs all three or none of them: two thirds of a quiet window is
  // not a window, and the route refuses it.
  const windowParts = [start.trim(), end.trim(), zone.trim()];
  const windowValid = windowParts.every((part) => part === "")
    || windowParts.every((part) => part !== "");

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
            ? { start: windowParts[0], end: windowParts[1], timezone: windowParts[2] }
            : null,
          reason: "Set from the Automation guardrails card.",
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean; error?: { message?: string };
      } | null;
      if (!response.ok || body?.ok === false) {
        setMessage(
          body?.error?.message
          ?? "The guardrail policy could not be saved, and nothing was changed.",
        );
        return;
      }
      setMessage("Saved.");
      await onSaved();
    } catch {
      setMessage("The request did not reach the server; nothing was changed.");
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
      style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border, #e5e7eb)" }}
    >
      <p style={{ margin: 0, fontSize: 12, fontWeight: 600 }}>
        Set the pause floor and quiet hours
      </p>
      <p style={{ margin: "4px 0 0", fontSize: 11.5, opacity: 0.85 }}>
        Blank clears. With no floor, automation may propose a pause for any
        entity its evidence supports.
      </p>
      <div style={{ display: "grid", gap: 8, margin: "8px 0 0" }}>
        <label style={{ display: "grid", gap: 3, fontSize: 11.5 }}>
          Min ROAS floor (pause)
          <input
            type="text"
            inputMode="decimal"
            data-testid="guardrail-roas-floor"
            value={floor}
            onChange={(event) => setFloor(event.target.value)}
            disabled={!ready || busy}
            aria-label="Min ROAS floor"
            aria-invalid={!floorValid}
            style={inputStyle}
          />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.4fr", gap: 6 }}>
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
        <p data-field="guardrail-floor-invalid" style={{ margin: "6px 0 0", fontSize: 11.5 }}>
          A floor is a positive number, or blank to clear it.
        </p>
      ) : null}
      {!windowValid ? (
        <p data-field="guardrail-window-invalid" style={{ margin: "6px 0 0", fontSize: 11.5 }}>
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
        Save guardrail policy
      </button>
      {message ? (
        <p data-field="guardrail-policy-message" style={{ margin: "6px 0 0", fontSize: 11.5 }}>
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
  /**
   * The business's assigned Meta accounts.
   *
   * Read even when the server already resolved the scope to null, because this
   * list IS the set `resolveProviderAccountId` authorizes against — asking for
   * it cannot widen scope, and without it a multi-account business has nothing
   * to choose from and Automation stays a dead end. Same reasoning, and the
   * same server-reauthorized model, as Launchpad's own account control.
   */
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

  /**
   * Request an account. Never grant one.
   *
   * The id goes into the URL and nothing else changes here: the canonical
   * route re-runs `resolveProviderAccountId` against this business's
   * assignments on the next render, so an id that is not assigned comes back
   * as null and the surface stays refused. That is why this is a `replace`
   * into the address bar rather than a `setProviderAccountId` — a URL
   * parameter must never become authority on its own.
   */
  const selectProviderAccount = useCallback(
    (nextProviderAccountId: string) => {
      if (!nextProviderAccountId || typeof window === "undefined") return;
      const url = new URL(window.location.href);
      url.searchParams.set("providerAccountId", nextProviderAccountId);
      router.replace(`${url.pathname}${url.search}`);
    },
    [router],
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
    if (!providerAccountId) return "provider account scope unresolved";
    const incomplete = (
      [
        ["businessControl", "automation control state"],
        ["rules", "automation rules"],
        ["activity", "activity ledger"],
        ["promotionRecords", "promotion records"],
        ["decisionModes", "decision-type modes"],
        ["anchors", "commercial anchors"],
        ["readiness", "readiness ladder"],
      ] as const
    ).filter(([key]) => sectionState(payload, key) !== "complete");
    const queueIncomplete = queue.readCompleteness !== "complete";
    if (incomplete.length === 0 && !queueIncomplete) return null;
    const names = [
      ...incomplete.map(([, label]) => label),
      ...(queueIncomplete ? ["confirmation queue"] : []),
    ];
    return `${names.join(", ")} not proven`;
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
        return;
      }
      // Unresolved on the server: fetch the assignment list so the operator
      // can name one. The client never SELECTS here — it writes the id into
      // the URL and the server authorizes it again on the next render.
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
            // The server's own refusal, verbatim. Re-wording it here would
            // describe a guard this surface does not own.
            setProposalError(
              body?.error?.message ??
                "The confirmation queue could not record that decision.",
            );
            setQueue(UNAVAILABLE_QUEUE);
            return;
          }
          if (control === "approve") {
            /**
             * Three states, and the middle one is the one that matters.
             *
             * `dryRun === true` is a receipt that says the approval never left
             * the building. `false` means it did reach Meta. Anything else —
             * an absent receipt, an absent flag — is a successful response we
             * cannot read the disposition out of, and that is said rather than
             * defaulted to either answer: guessing "sent" invents a write, and
             * guessing "not sent" hides one.
             */
            const dryRun = body?.receipt?.dryRun;
            setProposalNotice(
              dryRun === true
                ? "Recorded as a dry run — nothing was sent to Meta. The dryRunOnly guardrail held this approval inside the building."
                : dryRun === false
                  ? "Approved and dispatched to Meta. Check the activity ledger for the receipt."
                  : "Recorded. This response carried no receipt, so whether anything reached Meta is unknown — check the activity ledger before approving it again.",
            );
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
      providerAccounts={providerAccounts}
      providerAccountsLoading={providerAccountsLoading}
      onSelectProviderAccount={selectProviderAccount}
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
}: {
  readiness: BudgetWriteReadinessModel | null;
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
            ? "Automatic execution enabled for this account. Each decision " +
                "type also needs its own standing mode set to Automatic."
            : "Automatic execution disabled for this business.",
        );
        setActivationPhrase("");
        onActivationChanged?.();
      } else {
        setActivationMessage(
          `${payload?.error?.code ?? "refused"}` +
            `${payload?.blockers?.length ? `: ${payload.blockers.join("; ")}` : ""}`,
        );
      }
    } catch {
      setActivationMessage("The activation request could not be sent.");
    } finally {
      setActivationBusy(false);
    }
  };

  if (!readiness) {
    return (
      <article
        id="automatic-execution-control"
        data-testid="budget-write-readiness-unavailable"
        data-display-only="true"
        style={{
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: 12,
          padding: "12px 14px",
          fontSize: 13,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14 }}>
          Automatic execution — master switch
        </h3>
        <p style={{ margin: "6px 0 0" }}>
          Automatic-execution state unavailable. Unavailable is not
          &ldquo;off&rdquo;: the server could not prove the current posture, so
          nothing here should be read as a state.
        </p>
      </article>
    );
  }

  const { proposal, execution } = readiness;
  /*
    The dry-run guardrail is not carried on this model, so it is reported as
    UNKNOWN rather than guessed. Unknown is not "off".
  */
  const dryRunBlockerPresent = execution.activationReadyBlockers.includes(
    "dry_run_guardrail_engaged",
  );
  const dryRunFactValue = dryRunBlockerPresent ? "engaged" : "not_reported";
  const dryRunFactLabel = dryRunBlockerPresent
    ? "Engaged — every write stays inside the building"
    : "Not reported as a blocker by the server readiness read";
  /*
    The AND of every input above. It is deliberately not a new authority: the
    runtime re-checks all of it, and this row only says what the operator
    should expect.
  */
  const effectiveWriteAbility =
    execution.capabilityPrepared &&
    execution.executionEnabled &&
    !dryRunBlockerPresent &&
    execution.activationReadyBlockers.length === 0 &&
    execution.activatedProviderAccountId === readiness.providerAccountId;
  return (
    <article
      id="automatic-execution-control"
      data-testid="budget-write-readiness"
      data-display-only="true"
      data-execution-enabled={String(execution.executionEnabled)}
      data-capability-prepared={String(execution.capabilityPrepared)}
      style={{
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 12,
        padding: "12px 14px",
        fontSize: 13,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 14 }}>
        Automatic execution — master switch
      </h3>
      {/*
        PRE-DEPLOY AUDIT: say what this control actually flips.

        The switch below writes `meta_automation_business_controls
        .auto_execution_enabled`, which is the business-wide MASTER
        automatic-execution flag — not a budget-only setting. Budget is simply
        the only decision type that has an automatic executor today, and it
        additionally requires its own standing mode to be Tier 3. Labelling the
        master as if it were budget-scoped told an admin they were enabling one
        family when they were enabling the business-wide gate every future
        family would read.
      */}
      <p style={{ margin: "6px 0 0" }} data-field="master-switch-scope">
        This is the business-wide master switch for automatic Meta execution.
        Two keys are required and both are server-checked on every run: this
        master switch, and the decision type&rsquo;s own standing mode set to
        Automatic. Budget, pause and resume have automatic executors; turning
        this on never makes bid or creative write by themselves, and every
        operator-approved write keeps its own approval.
      </p>
      {/*
        PRE-DEPLOY AUDIT — SIX separate facts, not one word.

        "Prepared and disabled" collapsed the environment's capability, the
        business's master switch, the dry-run guardrail, the readiness verdict,
        the account binding and the effective write ability into a single
        phrase. An operator could not tell which of them was the reason, and a
        missing control row read the same as a configured-and-off one.

        Every row below is a server fact rendered verbatim. `effective-write`
        is the AND of all of them, stated last so it cannot be mistaken for any
        single input.
      */}
      <dl
        data-field="master-switch-facts"
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "2px 12px",
          margin: "8px 0 0",
        }}
      >
        <dt>Environment capability</dt>
        <dd
          data-field="environment-capability"
          data-value={String(execution.capabilityPrepared)}
        >
          {execution.capabilityPrepared
            ? "Transport prepared in this build"
            : "Transport not prepared in this build"}
        </dd>

        <dt>Business master switch</dt>
        <dd
          data-field="business-master-switch"
          data-value={String(execution.executionEnabled)}
        >
          {/*
            A control row that could not be read, or that does not exist, is
            OFF here. It is never rendered as enabled and never inferred.
          */}
          {execution.executionEnabled ? "ON" : "OFF"}
        </dd>

        <dt>Dry-run guardrail</dt>
        <dd data-field="dry-run-guardrail" data-value={dryRunFactValue}>
          {dryRunFactLabel}
        </dd>

        <dt>Activation readiness</dt>
        <dd
          data-field="activation-readiness"
          data-value={
            execution.activationReadyBlockers.length === 0 ? "ready" : "blocked"
          }
        >
          {execution.activationReadyBlockers.length === 0
            ? "No blockers reported"
            : `${execution.activationReadyBlockers.length} blocker(s)`}
        </dd>

        <dt>Activated account</dt>
        <dd data-field="activated-account-fact">
          {execution.activatedProviderAccountId ?? "none"}
        </dd>

        <dt>Effective write ability</dt>
        <dd
          data-field="effective-write"
          data-value={String(effectiveWriteAbility)}
        >
          {effectiveWriteAbility
            ? "This account can execute automatic budget writes"
            : "No automatic budget write can execute for this account"}
        </dd>
      </dl>
      {/*
        D088 C3: WHICH account automatic execution is enabled for.

        The control row is business-wide. Rendering only "on" would tell an
        operator on a second account that their budgets will move, when the
        activation was performed — and its readiness proven — for another
        account entirely.
      */}
      <p
        style={{ margin: "4px 0 0" }}
        data-field="activated-account"
        data-activated-account={execution.activatedProviderAccountId ?? "none"}
        data-activated-here={String(
          execution.activatedProviderAccountId !== null &&
            execution.activatedProviderAccountId ===
              readiness.providerAccountId,
        )}
      >
        {execution.activatedProviderAccountId === null
          ? "Automatic execution is not enabled for any account."
          : execution.activatedProviderAccountId === readiness.providerAccountId
            ? `Automatic execution is enabled for this account (${execution.activatedProviderAccountId}).`
            : `Automatic execution is enabled for ${execution.activatedProviderAccountId}, not this account.`}
      </p>

      {proposal ? (
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "auto auto",
            gap: "2px 12px",
            margin: "8px 0 0",
          }}
        >
          <dt>Owner</dt>
          <dd data-field="owner-grain">{proposal.ownerGrain}</dd>
          <dt>Entity</dt>
          <dd data-field="entity-id">{proposal.entityId}</dd>
          <dt>Field</dt>
          <dd data-field="budget-field">{proposal.budgetField}</dd>
          <dt>Before</dt>
          <dd data-field="before-amount-minor">{proposal.beforeAmountMinor}</dd>
          <dt>Proposed</dt>
          <dd data-field="intended-amount-minor">
            {proposal.intendedAmountMinor}
          </dd>
          <dt>Currency</dt>
          <dd data-field="currency">
            {proposal.currency} (exponent {proposal.currencyExponent})
          </dd>
          <dt>Change</dt>
          <dd data-field="change-percent">
            {proposal.changePercent === null
              ? "unknown"
              : `${proposal.changePercent}%`}
          </dd>
          <dt>Evidence as of</dt>
          <dd data-field="evidence-as-of">{proposal.evidenceAsOf}</dd>
          <dt>Evidence age</dt>
          <dd data-field="evidence-age-hours">
            {proposal.evidenceAgeHours === null
              ? "unknown"
              : `${proposal.evidenceAgeHours}h`}
          </dd>
          <dt>Read-back</dt>
          <dd data-field="readback-state">{execution.readbackState}</dd>
          <dt>Rollback</dt>
          <dd data-field="rollback-eligible">
            {execution.rollbackEligible ? "eligible" : "not eligible"}
          </dd>
          <dt>Proposal</dt>
          <dd data-field="proposal-state">
            {execution.proposalState ?? "none"}
          </dd>
          <dt>Claim</dt>
          <dd data-field="claim-state">{execution.claimState ?? "none"}</dd>
          <dt>Reconcile</dt>
          <dd data-field="reconcile-state">
            {execution.reconcileState ?? "none"}
          </dd>
        </dl>
      ) : (
        <p style={{ margin: "8px 0 0" }} data-field="unavailable-reason">
          {readiness.unavailableReason ?? "No budget proposal is available."}
        </p>
      )}

      <p
        style={{ margin: "8px 0 0" }}
        data-field="preflight-blockers"
        data-blockers={execution.preflightBlockers.join(",")}
      >
        {execution.preflightBlockers.length === 0
          ? "No proposal safety blockers are reported."
          : execution.preflightBlockers.map(activationBlockerLabel).join("; ")}
      </p>
      {/*
        PRE-DEPLOY AUDIT — the controls exist only for a viewer who may use them.

        An unauthorized viewer gets the same status above plus the CONCRETE
        refusal the route would answer with, and no button at all. The
        read-only mobile pane never reaches this branch.

        D088 C2 (kept): the form itself is the REAL ceremony. C1 rendered a
        button with no handler, which looked like a control and was scenery.
        This types the phrase, posts to the existing Automation route, renders
        whatever the server answers and refreshes. The server remains the only
        readiness authority: this component sends an intent and a phrase, and
        never a verdict.
      */}
      {auth.canConfigure || auth.canDisable ? (
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
          <input
            type="text"
            name="confirmationPhrase"
            data-testid="budget-activation-phrase"
            value={activationPhrase}
            onChange={(event) => setActivationPhrase(event.target.value)}
            placeholder={BUDGET_ACTIVATION_CONFIRMATION_PHRASE}
            aria-label="Confirmation phrase"
            disabled={
              activationBusy ||
              execution.executionEnabled ||
              execution.activationReadyBlockers.length > 0
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
                !execution.executionEnabled &&
                !activationBusy,
            )}
            disabled={
              activationBusy ||
              execution.executionEnabled ||
              execution.activationReadyBlockers.length > 0
            }
            aria-disabled={
              activationBusy ||
              execution.executionEnabled ||
              execution.activationReadyBlockers.length > 0
            }
            style={{
              padding: "6px 12px",
              borderRadius: 8,
              border: "1px solid var(--border, #e5e7eb)",
              background: "transparent",
              cursor:
                execution.executionEnabled ||
                execution.activationReadyBlockers.length > 0
                  ? "not-allowed"
                  : "pointer",
              opacity:
                execution.executionEnabled ||
                execution.activationReadyBlockers.length > 0
                  ? 0.55
                  : 1,
            }}
          >
            Enable automatic execution (budget)
          </button>
          {/* STOP is never gated. A stop that could be refused is not a stop. */}
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
            Disable automatic execution
          </button>
        </form>
      ) : (
        <p
          style={{ margin: "10px 0 0" }}
          data-field="master-switch-refusal"
          data-reason-code={auth.reasonCode ?? "none"}
          data-surface={auth.surface}
        >
          {auth.reason ?? "Automatic execution cannot be changed from here."}
        </p>
      )}
      {/*
        PRE-DEPLOY AUDIT — the SAFE preparation path, finally mounted.

        `save_budget_automation_config` has existed on the Automation route
        since D088 C3 and had ZERO callers anywhere in the product. Activation
        readiness requires a persisted control row with a lifted dry-run
        guardrail and three real budget numbers; five of the six target
        businesses have no control row at all, and nothing on any screen could
        write one. So the documented ceremony ended at a button that can only
        ever answer "not ready", and the only way forward was a hand-run SQL
        statement — the exact thing an activation ceremony exists to replace.

        This form is that path. It is a different VERB from the switch above:
        the route pins `auto_execution_enabled` to FALSE and clears the bound
        account on every path through the save, so preparing can never enable.
        The warning below says so before the operator commits, because a
        control that silently changes another control's state is how an
        operator loses track of what is on.
      */}
      {auth.canConfigure ? (
        <BudgetPreparationForm
          /*
            PRE-DEPLOY AUDIT — a scope-keyed remount, not an effect that tries
            to reconcile state after the fact. Switching account or business
            hands React a NEW key, which discards every hook's state and
            re-runs every `useState` initializer against the CURRENT props —
            there is no window in which a stale local value from the previous
            scope can be read, submitted, or displayed. An ordinary re-render
            for the SAME scope (a readiness refetch after Save, a background
            poll) keeps the key unchanged, so it does not touch what the
            operator is mid-typing.
          */
          key={`${readiness.businessId}::${readiness.providerAccountId}`}
          businessId={readiness.businessId}
          providerAccountId={readiness.providerAccountId}
          preparation={readiness.preparation ?? null}
          onSaved={onActivationChanged}
        />
      ) : null}
      {activationMessage ? (
        <p style={{ margin: "6px 0 0" }} data-field="activation-response">
          {activationMessage}
        </p>
      ) : null}
      <div style={{ margin: "8px 0 0" }} data-field="activation-ready-blockers">
        {execution.activationReadyBlockers.length === 0 ? (
          <p style={{ margin: 0 }}>
            All activation requirements are satisfied.
          </p>
        ) : (
          <details>
            <summary>
              Show {execution.activationReadyBlockers.length} activation
              requirements
            </summary>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {execution.activationReadyBlockers.map((blocker) => (
                <li key={blocker} data-blocker-code={blocker}>
                  {activationBlockerLabel(blocker)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <ul
        style={{ margin: "6px 0 0", paddingLeft: 18 }}
        data-field="activation-blockers"
      >
        {execution.activationBlockers.map((blocker) => (
          <li key={blocker.code} data-blocker={blocker.code}>
            {blocker.why}
          </li>
        ))}
      </ul>
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
function PreparationFact({
  label,
  field,
  render,
}: {
  label: string;
  field: PreparationField<unknown> | undefined;
  render: (value: unknown) => string;
}) {
  const state = field?.state ?? "unknown";
  return (
    <span
      data-field="preparation-state"
      data-key={label}
      data-state={state}
      style={{ fontSize: 12, opacity: 0.85 }}
    >
      {state === "persisted"
        ? `saved: ${render(field!.value)}`
        : state === "unset"
          ? "not set"
          : "could not be read"}
    </span>
  );
}

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
  const [ceilingMinor, setCeilingMinor] = useState(
    preparedFieldText(preparation, "perActionSpendCeilingMinor"),
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
    setCeilingMinor(
      preparedFieldText(preparation, "perActionSpendCeilingMinor"),
    );
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
  const candidate = {
    dryRunOnly: dryRunOnly === "" ? undefined : dryRunOnly === "true",
    budgetMinHoursBetweenChanges: numeric(minHours),
    budgetMaxChangesPer7d: numeric(maxChanges),
    budgetMaxAccountConcentrationPct: numeric(maxConcentration),
    maxBudgetIncreasePct: numeric(maxIncrease),
    // A blank ceiling is a real, valid choice: it CLEARS the ceiling.
    perActionSpendCeilingMinor: numeric(ceilingMinor),
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
          "Preparation saved. Automatic execution is OFF and any bound account was cleared.",
        );
        // Re-read the server model so readiness reflects the new row rather
        // than this component's optimism.
        onSaved?.();
      } else {
        setMessage(
          `${payload?.error?.code ?? "refused"}: ${payload?.error?.message ?? ""}`.trim(),
        );
      }
    } catch {
      setMessage("The preparation request could not be sent.");
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
      <h4 style={{ margin: 0, fontSize: 13 }}>
        Prepare budget automation (does not enable it)
      </h4>
      {/*
        The warning comes BEFORE the fields, not beside the button. An operator
        who reads only the heading and the first sentence must still have been
        told what the save does to the master switch.
      */}
      <p
        data-field="preparation-warning"
        style={{ margin: "6px 0 0", fontSize: 12 }}
      >
        Saving this configuration{" "}
        <strong>forces automatic execution OFF</strong> for this business and{" "}
        <strong>clears any activated account binding</strong>. It is the
        preparation step: after saving, activation readiness is recomputed and
        the enable ceremony above must be performed again.
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
          The stored configuration could not be read
          {!preparation
            ? " — no preparation state is available for this account yet"
            : ""}
          . Every field below is locked rather than shown editable-but-empty:
          unknown is not &ldquo;unset&rdquo;, and saving over it would overwrite
          values nobody has seen.
        </p>
      ) : null}
      {missing.length > 0 ? (
        <p
          data-field="preparation-missing"
          data-missing={missing.join(",")}
          style={{ margin: "6px 0 0", fontSize: 12 }}
        >
          Not yet prepared: {missingLabels.join(", ")}. Activation readiness
          cannot be satisfied until each carries a value.
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
          Dry-run only
          <PreparationFact
            label="dryRunOnly"
            field={preparation?.dryRunOnly}
            render={(value) => String(value)}
          />
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
            <option value="true">
              true — every write stays inside the building
            </option>
            <option value="false">
              false — required before activation readiness
            </option>
          </select>
        </label>

        {(
          [
            [
              "budgetMinHoursBetweenChanges",
              "Min hours between changes",
              minHours,
              setMinHours,
              "preparation-min-hours",
            ],
            [
              "budgetMaxChangesPer7d",
              "Max changes per 7 days",
              maxChanges,
              setMaxChanges,
              "preparation-max-changes",
            ],
            [
              "budgetMaxAccountConcentrationPct",
              "Max account concentration (%)",
              maxConcentration,
              setMaxConcentration,
              "preparation-max-concentration",
            ],
            [
              "maxBudgetIncreasePct",
              "Max single increase (%)",
              maxIncrease,
              setMaxIncrease,
              "preparation-max-increase",
            ],
            [
              "perActionSpendCeilingMinor",
              "Per-action spend ceiling (minor units, blank clears)",
              ceilingMinor,
              setCeilingMinor,
              "preparation-ceiling-minor",
            ],
          ] as const
        ).map(([key, label, value, setValue, testId]) => (
          <label key={key} style={{ display: "grid", gap: 4, fontSize: 12 }}>
            {label}
            <PreparationFact
              label={key}
              field={preparation?.[key]}
              render={(stored) => String(stored)}
            />
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
          Ceiling currency (ISO-4217, blank clears)
          <PreparationFact
            label="perActionSpendCeilingCurrency"
            field={preparation?.perActionSpendCeilingCurrency}
            render={(stored) => String(stored)}
          />
          <input
            type="text"
            data-testid="preparation-ceiling-currency"
            value={ceilingCurrency}
            onChange={(event) => setCeilingCurrency(event.target.value)}
            disabled={busy || fieldsLocked}
            aria-label="Ceiling currency"
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
          {parsed.rejection === "dry_run_only_not_boolean"
            ? "Choose whether this setup should remain dry-run only."
            : parsed.message}
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
        Save preparation (keeps automation OFF)
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
