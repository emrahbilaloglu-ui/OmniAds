"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import type {
  MetaAutomationActivityItem,
  MetaAutomationControlPlane,
  MetaAutomationDecisionMode,
  MetaAutomationDecisionType,
  MetaAutomationReadinessControlTier,
} from "@/lib/meta/automation-control-plane";
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
  type AutomationViewerEnvelope,
} from "./viewer-envelope";
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

const READINESS_LABELS: Record<MetaAutomationReadinessControlTier, string> = {
  read_only: "Tier 0 — Read only",
  manual_review: "Tier 1 — Supervised",
  backtest_candidate: "Tier 2 — Backtest candidate",
  auto_execute: "Tier 3 — Auto-execute",
};

const MODE_LABELS: Record<MetaAutomationDecisionMode, string> = {
  manual: "Tier 1 · Supervised",
  semi_auto: "Tier 2 · Backtest",
  auto: "Tier 3 · Auto-execute",
};

/** The ladder's three rungs, in the order the server declares them. */
const AUTONOMY_MODES: readonly MetaAutomationDecisionMode[] = ["manual", "semi_auto", "auto"];

/** What each rung says ON the segment; `MODE_LABELS` is its accessible name. */
const MODE_SEGMENT_LABELS: Record<MetaAutomationDecisionMode, string> = {
  manual: "Tier 1",
  semi_auto: "Tier 2",
  auto: "Tier 3",
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
    (entry) => entry.decisionType === decisionType && entry.source === "persisted",
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

type SectionState = "complete" | "unavailable" | "migration_required" | "unproven";

const LEGACY_COMPLETENESS_KEY: Partial<
  Record<SectionKey, "rules" | "activityLedger" | "promotionRecords" | "businessControl" | "cleanApprovalStreaks">
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
    ? { label: "STOPPED", tone: "stopped" }
    : { label: "ENABLED", tone: "enabled" };
}

function statusForBusinessKillSwitch(
  payload: AutomationPayload | null,
): StatusPresentation {
  if (!hasServedBusinessControl(payload)) {
    return { label: UNKNOWN, tone: "unknown" };
  }
  return payload!.businessControl.killSwitchEngaged
    ? { label: "STOPPED", tone: "stopped" }
    : { label: "ENABLED", tone: "enabled" };
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
  return label ? { label, tone: result.status } : { label: UNKNOWN, tone: "unknown" };
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
              setTriggerKind(
                event.target.value as typeof triggerKind,
              )
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
          const next = await readAutomation({ businessId, providerAccountId }).catch(
            () => null,
          );
          // Hands the re-read payload to the same channel the rules editor uses
          // to publish one, so the page owns the state and this body still owns
          // none of it.
          if (next) onRulesChanged?.(next);
        })
        .catch(() => {
          setStopError("The automation control plane could not be reached.");
        })
        .finally(() => setStopPending(false));
    },
    [businessId, providerAccountId, stopPending, viewer.canMutate, onRulesChanged],
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
    (decisionType: MetaAutomationDecisionType, mode: MetaAutomationDecisionMode) => {
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
          const next = await readAutomation({ businessId, providerAccountId }).catch(
            () => null,
          );
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
            [decisionType]: "The automation control plane could not be reached.",
          }));
        })
        .finally(() => setModePending(null));
    },
    [businessId, providerAccountId, modePending, viewer.canMutate, onRulesChanged],
  );

  const guardrails = guardrailsFor(payload, liveWritesRefusalReason);
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
  const canMutate =
    Boolean(businessId) && accountResolved && viewer.canMutate;

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
          <p className={styles.eyebrow}>Meta · Supervision control plane</p>
          <h1 className={styles.title}>Automation</h1>
        </div>

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
            <p className={styles.cardKickerDark}>Kill switch</p>
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
              <span>Meta writes · all businesses</span>
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
              <span>Meta writes · this business</span>
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
            <div className={styles.killRow} data-field="business-writes-control">
              {stopEngaged ? (
                <button
                  type="button"
                  className={styles.killAction}
                  data-ctl="gated:AUTO-02 release"
                  disabled={!viewer.canMutate || stopPending}
                  title={viewer.canMutate ? undefined : (viewer.reason ?? undefined)}
                  onClick={() => onStopControl("release_kill_switch")}
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
                   * carried by `disabled` and `data-stop-engage-refused`, where
                   * a state belongs.
                   */
                  data-ctl="gated:AUTO-01A engage"
                  data-stop-engage-refused={stopEngageRefusalReason ? "" : undefined}
                  disabled={
                    Boolean(stopEngageRefusalReason) || !viewer.canMutate || stopPending
                  }
                  title={stopEngageRefusalReason ?? viewer.reason ?? undefined}
                  onClick={() => onStopControl("engage_kill_switch")}
                >
                  {stopPending ? "Stopping…" : "Stop Meta writes"}
                </button>
              )}
            </div>
            {stopEngageRefusalReason && !stopEngaged ? (
              <p className={styles.killNote} data-field="stop-engage-refusal" role="note">
                {stopEngageRefusalReason}
              </p>
            ) : null}
            {stopError ? (
              <p className={styles.killNote} data-field="stop-error" role="status">
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
                <span data-field="guardrail-source"> · defaults, not set here</span>
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
                <div
                  className={styles.proposalRow}
                  data-proposal-id={row.id}
                >
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

        <div className={styles.rulesAutonomyGrid}>
          <article className={styles.rulesCard}>
            <div className={styles.sectionHeader}>
              <h2>Rules</h2>
              <span className={styles.sectionHint}>
                deterministic triggers · anchored to the Commercial Truth pack
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
                      data-proven-empty={rules.isProvenEmpty ? "true" : "false"}
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
                  <span className={styles.autonomyTier} data-tone={item.tone}>
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
                      const current = currentModeFor(payload, item.decisionType!);
                      const refused = !viewer.canMutate;
                      return (
                        <button
                          key={mode}
                          type="button"
                          className={styles.modeSegment}
                          role="radio"
                          aria-checked={current === mode}
                          data-mode={mode}
                          disabled={refused || modePending === item.decisionType}
                          title={refused ? (viewer.reason ?? undefined) : undefined}
                          /*
                           * Short on screen, full to a reader. Three segments
                           * carrying "Tier 2 · Backtest" wrap the row at the
                           * card's width and stop being one scannable control;
                           * the tier chip beside them already spells the
                           * current one out, and the accessible name carries
                           * the whole thing for anyone not reading the chip.
                           */
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
                <div className={styles.progressRow}>
                  <span className={styles.progressTrack}>
                    <span
                      className={styles.progressFill}
                      data-tone={item.progressTone}
                      style={{ width: item.progressWidth }}
                    />
                  </span>
                  <span className={styles.progressValue}>{item.progress}</span>
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
                ? `Setting a tier records the intent in this workspace. It is not a Meta write, and it does not enable auto-execution: ${liveWritesRefusalReason}`
                : "Setting a tier records the intent in this workspace. It is not a Meta write; execution still runs through the confirmation queue."}
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
                        <td data-field="ledger-actor">{ledgerActorFor(item)}</td>
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
                    data-proven-empty={ledgerIsProvenEmpty ? "true" : "false"}
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
  const payload = body as
    | {
        ok?: boolean;
        readCompleteness?: { proposals?: string };
        sections?: { proposals?: { status?: string } };
        holds?: unknown;
        proposals?: MetaAutomationProposal[];
      }
    | null;
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

export default function MetaAutomationPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
  initialPayload = null,
  viewer = AUTOMATION_VIEWER_NOT_ESTABLISHED,
  stopEngageRefusalReason = null,
  liveWritesRefusalReason = null,
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
  const [providerAccounts, setProviderAccounts] = useState<MetaHistoryAccount[]>(
    [],
  );
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
    />
  );
}
