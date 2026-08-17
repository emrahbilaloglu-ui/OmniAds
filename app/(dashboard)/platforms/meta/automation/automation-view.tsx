"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import type {
  MetaAutomationActivityItem,
  MetaAutomationControlPlane,
  MetaAutomationDecisionMode,
  MetaAutomationDecisionType,
  MetaAutomationReadinessControlTier,
} from "@/lib/meta/automation-control-plane";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import {
  createAutomationRuleRequest,
  setAutomationRuleActiveRequest,
  type AutomationRuleDraftInput,
} from "@/lib/meta/automation-rules-client";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
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
import styles from "./automation.module.css";

type AutomationPayload = MetaAutomationControlPlane;

export interface MetaAutomationPageProps {
  /** A server-authorized route scope. When present, client store state cannot replace it. */
  businessId?: string;
  /** `null` is an intentional unresolved scope and must not silently select an account. */
  providerAccountId?: string | null;
  initialPayload?: AutomationPayload | null;
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

const MODE_TONES: Record<
  MetaAutomationDecisionMode,
  AutonomyPresentation["tone"]
> = {
  manual: "automation",
  semi_auto: "info",
  auto: "enabled",
};

function hasPersistedBusinessControl(payload: AutomationPayload | null) {
  return payload?.businessControl.source === "persisted";
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
  if (!hasPersistedBusinessControl(payload)) {
    return { label: UNKNOWN, tone: "unknown" };
  }
  return payload!.businessControl.killSwitchEngaged
    ? { label: "STOPPED", tone: "stopped" }
    : { label: "ENABLED", tone: "enabled" };
}

function readinessFor(payload: AutomationPayload | null) {
  return hasPersistedBusinessControl(payload)
    ? READINESS_LABELS[payload!.businessControl.readinessTier]
    : UNKNOWN;
}

function promotionCountFor(payload: AutomationPayload | null) {
  if (
    !hasPersistedBusinessControl(payload) ||
    payload?.readCompleteness?.promotionRecords !== "complete"
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

function guardrailsFor(payload: AutomationPayload | null) {
  const guardrails = hasPersistedBusinessControl(payload)
    ? payload!.businessControl.guardrails
    : null;
  const quietHours = guardrails?.quietHours ?? null;
  return [
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
  const budgetLimit = hasPersistedBusinessControl(payload)
    ? `+${formatNumber(payload!.businessControl.guardrails.maxBudgetIncreasePct)}%`
    : UNKNOWN;
  const byType = new Map(
    (payload?.decisionTypeModes ?? [])
      .filter((item) => item.source === "persisted")
      .map((item) => [item.decisionType, item]),
  );
  // The same rule the promotion count already follows: a read this payload
  // cannot prove is complete may not be turned into a total.
  const streaksProven =
    payload?.readCompleteness?.cleanApprovalStreaks === "complete";

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

  return [
    mapped(`Budget changes ≤ ${budgetLimit}`, "budget"),
    mapped("Pause / resume", "pause"),
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

export function MetaAutomationView({
  payload,
  providerAccountId = null,
  proposals = EMPTY_AUTOMATION_PROPOSALS_MODEL,
  onProposalControl,
  pendingProposalId = null,
  proposalError = null,
  businessId = null,
  onRulesChanged,
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
  /**
   * Server-authorized scope. Absent means this render has no authority to
   * mutate anything, so the toggle and "+ New rule" stay inert rather than
   * pretending to work.
   */
  businessId?: string | null;
  onRulesChanged?: (next: AutomationPayload) => void;
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
  const guardrails = guardrailsFor(payload);
  const autonomy = autonomyFor(payload);
  const readiness = readinessFor(payload);
  const promotionCount = promotionCountFor(payload);
  const ledger = payload?.activityLedger ?? [];
  const showCanonicalReadinessCopy =
    hasPersistedBusinessControl(payload) &&
    payload!.businessControl.readinessTier === "manual_review";

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);
  const [pendingRuleId, setPendingRuleId] = useState<string | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);

  const rules = buildAutomationRulesViewModel({
    payload,
    // Creation needs a proven read and a server-authorized scope. Without
    // either, the control is present but inert — the design's geometry with
    // none of its authority.
    canCreate:
      Boolean(businessId) && payload?.readCompleteness?.rules === "complete",
  });

  async function toggleRule(row: AutomationRuleRowViewModel) {
    if (!businessId || row.locked || pendingRuleId) return;
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
    if (!businessId || composerBusy) return;
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

        <div className={styles.summaryGrid}>
          <article className={styles.killCard}>
            <p className={styles.cardKickerDark}>Kill switch</p>
            <div className={styles.killRow}>
              <span>Global writes</span>
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
              <span>This business</span>
              <span
                className={styles.statusPill}
                data-tone={businessStatus.tone}
                data-field="business-writes"
                data-read-only="true"
              >
                {businessStatus.label}
              </span>
            </div>
            <p className={styles.killNote}>
              Flipping either switch blocks every provider write instantly —
              server-enforced, not a UI state.
            </p>
          </article>

          <article className={styles.guardrailCard}>
            <p className={styles.cardKicker}>Guardrails</p>
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
                      disabled={!onProposalControl || pendingProposalId !== null}
                      onClick={() => onProposalControl?.(row.id, "approve")}
                    >
                      {row.primaryCaption}
                    </button>
                    <button
                      type="button"
                      className={styles.proposalSecondary}
                      data-control="modify"
                      aria-expanded={modifyingProposalId === row.id}
                      disabled={!onProposalControl || pendingProposalId !== null}
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
                      disabled={!onProposalControl || pendingProposalId !== null}
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
            <div
              className={styles.confirmationEmpty}
              data-testid="confirmation-empty"
            >
              {UNKNOWN}
            </div>
          )}
          {proposalError ? (
            <p className={styles.proposalError} role="status">
              {proposalError}
            </p>
          ) : null}
          <p className={styles.sectionFootnote}>
            approving executes inside the guardrails above · every outcome lands
            in the ledger with a receipt · expired proposals re-evaluate on the
            next snapshot
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
                        canMutate={Boolean(businessId)}
                        onToggle={() => void toggleRule(row)}
                      />
                    ))
                  ) : (
                    <tr className={styles.rulesEmpty} data-testid="rules-empty">
                      <td colSpan={5}>{UNKNOWN}</td>
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
                  <tr className={styles.ledgerEmpty} data-testid="ledger-empty">
                    <td colSpan={5}>{UNKNOWN}</td>
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
          the desktop workspace.
        </p>
        <dl className={styles.mobileFacts}>
          <div>
            <dt>Global writes</dt>
            <dd>{globalStatus.label}</dd>
          </div>
          <div>
            <dt>This business</dt>
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
}

const UNAVAILABLE_QUEUE: ProposalQueueRead = {
  readCompleteness: "unavailable",
  proposals: [],
};

function parseProposalQueue(body: unknown): ProposalQueueRead {
  const payload = body as
    | {
        ok?: boolean;
        readCompleteness?: { proposals?: string };
        proposals?: MetaAutomationProposal[];
      }
    | null;
  // An `unavailable` read is not an empty queue, and the two must not be
  // collapsed here: the count badge says `—` for one and `0` for the other.
  if (
    payload?.ok !== true ||
    payload.readCompleteness?.proposals !== "complete" ||
    !Array.isArray(payload.proposals)
  ) {
    return UNAVAILABLE_QUEUE;
  }
  return { readCompleteness: "complete", proposals: payload.proposals };
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
  } | null;
  if (!response.ok || body?.ok === false || !body?.automation) {
    throw new Error("Automation control plane is unavailable.");
  }
  return body.automation;
}

export default function MetaAutomationPage({
  businessId: authorizedBusinessId,
  providerAccountId: authorizedProviderAccountId,
  initialPayload = null,
}: MetaAutomationPageProps = {}) {
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
  const [refreshKey, setRefreshKey] = useState(0);
  const [queue, setQueue] = useState<ProposalQueueRead>(UNAVAILABLE_QUEUE);
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(
    null,
  );
  const [proposalError, setProposalError] = useState<string | null>(null);

  useTierZeroFreshness({
    surface: "automation",
    isLoading: readLoading && !payload,
    isFetching: readLoading,
    error: readError,
    asOf: null,
    partialReason:
      payload?.businessControl.source !== "persisted"
        ? "persisted business control not proven"
        : !providerAccountId
          ? "provider account scope unresolved"
          : payload?.readCompleteness?.rules !== "complete"
            ? "automation rules read not proven"
            : null,
    businessId,
    onRetry: () => setRefreshKey((value) => value + 1),
  });

  useEffect(() => {
    setPayload(initialPayload);
  }, [businessId, initialPayload]);

  useEffect(() => {
    if (accountScopeIsServerAuthorized) {
      setProviderAccountId(authorizedProviderAccountId?.trim() || null);
      return;
    }
    if (!businessId) {
      setProviderAccountId(null);
      return;
    }

    const controller = new AbortController();
    setProviderAccountId(null);
    fetchMetaHistoryAccounts({ businessId, signal: controller.signal })
      .then((accounts) => {
        if (controller.signal.aborted) return;
        const requested = requestedProviderAccountId
          ? accounts.find(
              (account) => account.id === requestedProviderAccountId,
            )
          : null;
        setProviderAccountId(
          requested?.id ?? (accounts.length === 1 ? accounts[0]!.id : null),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setProviderAccountId(null);
      });
    return () => controller.abort();
  }, [
    accountScopeIsServerAuthorized,
    authorizedProviderAccountId,
    businessId,
    requestedProviderAccountId,
  ]);

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
      .catch(() => {
        if (!controller.signal.aborted) {
          setPayload(null);
          setReadError("automation_control_plane_unavailable");
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
      setPendingProposalId(proposalId);
      setProposalError(null);
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
          } | null;
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
          setQueue(parseProposalQueue(body));
        })
        .catch(() => {
          setProposalError(
            "The confirmation queue could not record that decision.",
          );
          setQueue(UNAVAILABLE_QUEUE);
        })
        .finally(() => setPendingProposalId(null));
    },
    [businessId, pendingProposalId, providerAccountId],
  );

  return (
    <MetaAutomationView
      payload={payload}
      providerAccountId={providerAccountId}
      proposals={buildAutomationProposalsModel({
        readCompleteness: queue.readCompleteness,
        proposals: queue.proposals,
        now: new Date(),
      })}
      onProposalControl={onProposalControl}
      pendingProposalId={pendingProposalId}
      proposalError={proposalError}
      businessId={businessId}
      onRulesChanged={setPayload}
    />
  );
}
