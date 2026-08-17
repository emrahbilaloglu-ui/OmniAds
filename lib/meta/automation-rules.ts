/**
 * Deterministic automation rules — the pure half.
 *
 * The design states the safety property this module exists to make structural:
 *
 *   "rules never write directly — they raise proposals into the confirmation
 *    queue (or hard-block, for guards)"
 *
 * Nothing in this file may import a provider client, a database handle, `fetch`,
 * the clock or a random source. A rule's whole vocabulary is: read numbers that
 * were handed to it, compare them against the workspace Commercial Truth pack,
 * and return a verdict. The only two outcomes a firing can have are
 * `proposal` (goes into the confirmation queue) and `hard_block` (refuses a
 * write). There is deliberately no action kind that executes anything.
 *
 * Determinism means: same inputs, same verdict. Every time-dependent value —
 * the evaluation date, the instant a guard is checked — is an explicit input,
 * never read from the environment.
 */

export const AUTOMATION_RULE_MODES = ["confirm", "suggest", "enforced"] as const;
export type AutomationRuleMode = (typeof AUTOMATION_RULE_MODES)[number];

/**
 * The anchors a trigger may reference. "Anchored to the Commercial Truth pack"
 * is literal: a trigger names one of these and an optional multiplier. It can
 * never carry a free-floating absolute threshold, because the validator below
 * has nowhere to put one.
 */
export const AUTOMATION_RULE_COMMERCIAL_ANCHORS = [
  "target_roas",
  "break_even_roas",
  "target_cpa",
  "break_even_cpa",
] as const;
export type AutomationRuleCommercialAnchor =
  (typeof AUTOMATION_RULE_COMMERCIAL_ANCHORS)[number];

export const AUTOMATION_RULE_ROAS_ANCHORS = [
  "target_roas",
  "break_even_roas",
] as const;
export const AUTOMATION_RULE_CPA_ANCHORS = [
  "target_cpa",
  "break_even_cpa",
] as const;

export const AUTOMATION_RULE_TRIGGER_KINDS = [
  "roas_below_anchor",
  "roas_at_or_above_anchor",
  "cpa_above_anchor",
  "cpa_at_or_below_anchor",
  "quiet_hours",
] as const;
export type AutomationRuleTriggerKind =
  (typeof AUTOMATION_RULE_TRIGGER_KINDS)[number];

export const AUTOMATION_RULE_COMMERCIAL_TRIGGER_KINDS = [
  "roas_below_anchor",
  "roas_at_or_above_anchor",
  "cpa_above_anchor",
  "cpa_at_or_below_anchor",
] as const;
export type AutomationRuleCommercialTriggerKind =
  (typeof AUTOMATION_RULE_COMMERCIAL_TRIGGER_KINDS)[number];

export interface AutomationRuleCommercialTrigger {
  kind: AutomationRuleCommercialTriggerKind;
  anchor: AutomationRuleCommercialAnchor;
  /** Multiplier applied to the anchor. 1 means "the anchor itself". */
  anchorMultiplier: number;
  /** How many consecutive most-recent days must satisfy the comparison. */
  consecutiveDays: number;
}

/**
 * A temporal guard. This is the one trigger family that is not an economic
 * comparison, so it does not take an anchor — it is a window, not a number.
 */
export interface AutomationRuleQuietHoursTrigger {
  kind: "quiet_hours";
  /** IANA zone, e.g. "America/New_York". */
  timeZone: string;
  /** Inclusive start hour, 0–23, in `timeZone`. */
  startHour: number;
  /** Exclusive end hour, 0–24, in `timeZone`. Wraps when < startHour. */
  endHour: number;
}

export type AutomationRuleTrigger =
  | AutomationRuleCommercialTrigger
  | AutomationRuleQuietHoursTrigger;

/**
 * What a rule may be built to do.
 *
 * Two members, and the exclusions are the interesting part. A firing raises a
 * row into the ONE confirmation queue, and every row there carries "Approve &
 * apply" under a footer promising "approving executes inside the guardrails
 * above". So a rule may only name an action the queue can actually execute
 * through the existing guarded handler:
 *
 * - `propose_pause` → the queue's `pause`, which has a real endpoint at
 *   campaign and ad-set grain and needs no operator-entered value.
 * - `hard_block_writes` → not a proposal at all. A guard refuses a write at the
 *   write boundary and is recorded; it never queues anything.
 *
 * Budget proposals are absent because `MUTATION_ENDPOINTS` has no budget action
 * at any grain — the same reason the engine projection refuses to project a
 * `scale` decision. A "flag for review" action is absent because it names no
 * provider mutation, so it could only produce a queue row whose primary button
 * does nothing. Adding either back means shipping its endpoint first.
 */
export const AUTOMATION_RULE_ACTION_KINDS = [
  "propose_pause",
  "hard_block_writes",
] as const;
export type AutomationRuleActionKind =
  (typeof AUTOMATION_RULE_ACTION_KINDS)[number];

export interface AutomationRuleAction {
  kind: AutomationRuleActionKind;
}

export const AUTOMATION_RULE_ENTITY_LEVELS = ["campaign", "adset"] as const;
export type AutomationRuleEntityLevel =
  (typeof AUTOMATION_RULE_ENTITY_LEVELS)[number];

export interface AutomationRuleDefinition {
  id: string;
  businessId: string;
  name: string;
  entityLevel: AutomationRuleEntityLevel;
  trigger: AutomationRuleTrigger;
  action: AutomationRuleAction;
  mode: AutomationRuleMode;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Enforced rules are guards. The design locks their toggle: "Enforced — cannot be disabled". */
export function isAutomationRuleLocked(
  rule: Pick<AutomationRuleDefinition, "mode">,
) {
  return rule.mode === "enforced";
}

export interface AutomationRuleAnchorValues {
  target_roas: number | null;
  break_even_roas: number | null;
  target_cpa: number | null;
  break_even_cpa: number | null;
}

/**
 * Project the workspace Commercial Truth pack onto the anchor set a trigger may
 * reference. A field the pack does not supply stays `null`, and a rule that
 * needs it becomes unevaluable rather than falling back to a number nobody set.
 */
export function anchorsFromTargetPack(
  targetPack: {
    targetRoas: number | null;
    breakEvenRoas: number | null;
    targetCpa: number | null;
    breakEvenCpa: number | null;
  } | null,
): AutomationRuleAnchorValues {
  return {
    target_roas: finiteNumber(targetPack?.targetRoas ?? null),
    break_even_roas: finiteNumber(targetPack?.breakEvenRoas ?? null),
    target_cpa: finiteNumber(targetPack?.targetCpa ?? null),
    break_even_cpa: finiteNumber(targetPack?.breakEvenCpa ?? null),
  };
}

export interface AutomationRuleDailyMetric {
  /** YYYY-MM-DD */
  date: string;
  roas: number | null;
  cpa: number | null;
  spend: number | null;
  revenue: number | null;
}

export interface AutomationRuleEntityWindow {
  entityLevel: AutomationRuleEntityLevel;
  entityId: string;
  entityName: string | null;
  providerAccountId: string | null;
  /** Daily rows for this entity. Order is irrelevant; the evaluator sorts. */
  daily: AutomationRuleDailyMetric[];
}

export type AutomationRuleUnevaluableReason =
  | "rule_inactive"
  | "anchor_missing"
  | "insufficient_history"
  | "metric_missing"
  | "guard_not_entity_scoped";

/**
 * Why a rule that DID fire raised no proposal.
 *
 * Distinct from `unevaluable` on purpose: the trigger was met and the verdict
 * was reached — it is the operator's own ROAS floor that withheld the queue row.
 */
export type AutomationRuleSuppressionReason =
  | "roas_at_or_above_floor"
  | "roas_floor_unprovable";

export interface AutomationRuleFiringEvidence {
  anchor: AutomationRuleCommercialAnchor | null;
  anchorValue: number | null;
  threshold: number | null;
  consecutiveDays: number;
  observed: Array<{ date: string; value: number }>;
}

export type AutomationRuleVerdict =
  | {
      status: "skipped";
      ruleId: string;
      entityId: null;
      reason: AutomationRuleUnevaluableReason;
    }
  | {
      status: "unevaluable";
      ruleId: string;
      entityId: string | null;
      reason: AutomationRuleUnevaluableReason;
    }
  | { status: "not_met"; ruleId: string; entityId: string }
  | {
      status: "suppressed";
      ruleId: string;
      entityId: string;
      reason: AutomationRuleSuppressionReason;
    }
  | {
      status: "fires";
      ruleId: string;
      entityId: string;
      entityLevel: AutomationRuleEntityLevel;
      entityName: string | null;
      providerAccountId: string | null;
      outcome: "proposal" | "hard_block";
      evaluatedForDate: string;
      dedupeKey: string;
      reason: string;
      evidence: AutomationRuleFiringEvidence;
    };

export interface AutomationRuleEvaluationInput {
  rules: AutomationRuleDefinition[];
  anchors: AutomationRuleAnchorValues;
  entities: AutomationRuleEntityWindow[];
  /** YYYY-MM-DD. Explicit, never read from the clock. */
  asOfDate: string;
  /**
   * The business's persisted ROAS proposal floor, or `null` when no operator has
   * committed one. When set, no pause proposal is raised for an entity that is
   * not PROVEN below it — see {@link clearsRoasProposalFloor}.
   */
  minRoasFloor?: number | null;
}

export interface AutomationRuleEvaluation {
  contractVersion: "automation-rule-evaluation.v1";
  asOfDate: string;
  verdicts: AutomationRuleVerdict[];
}

export class AutomationRuleValidationError extends Error {
  readonly code = "invalid_automation_rule";

  constructor(
    readonly field: string,
    readonly reason: string,
    message?: string,
  ) {
    super(message ?? `${field} is invalid: ${reason}`);
    this.name = "AutomationRuleValidationError";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONSECUTIVE_DAYS = 30;
const MAX_ANCHOR_MULTIPLIER = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRoasAnchor(anchor: AutomationRuleCommercialAnchor) {
  return (AUTOMATION_RULE_ROAS_ANCHORS as readonly string[]).includes(anchor);
}

function isCpaAnchor(anchor: AutomationRuleCommercialAnchor) {
  return (AUTOMATION_RULE_CPA_ANCHORS as readonly string[]).includes(anchor);
}

export function isCommercialTrigger(
  trigger: AutomationRuleTrigger,
): trigger is AutomationRuleCommercialTrigger {
  return trigger.kind !== "quiet_hours";
}

/**
 * The rule state machine's structural invariants, enforced at the only place a
 * rule can enter the system. Everything downstream may assume them.
 *
 *  - `enforced` ⇔ a guard: quiet-hours trigger, `hard_block_writes` action.
 *  - `confirm` / `suggest` ⇒ a commercial-anchored trigger, and an action that
 *    can only ever produce a proposal. `hard_block_writes` is not reachable.
 *  - No trigger may carry an absolute economic threshold; only an anchor and a
 *    bounded multiplier.
 */
export function validateAutomationRuleDraft(input: {
  name: unknown;
  entityLevel: unknown;
  trigger: unknown;
  action: unknown;
  mode: unknown;
}): {
  name: string;
  entityLevel: AutomationRuleEntityLevel;
  trigger: AutomationRuleTrigger;
  action: AutomationRuleAction;
  mode: AutomationRuleMode;
} {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0 || name.length > 80) {
    throw new AutomationRuleValidationError(
      "name",
      "name_must_be_1_to_80_characters",
    );
  }

  const mode = AUTOMATION_RULE_MODES.includes(input.mode as AutomationRuleMode)
    ? (input.mode as AutomationRuleMode)
    : null;
  if (!mode) {
    throw new AutomationRuleValidationError(
      "mode",
      "mode_must_be_confirm_suggest_or_enforced",
    );
  }

  const entityLevel = AUTOMATION_RULE_ENTITY_LEVELS.includes(
    input.entityLevel as AutomationRuleEntityLevel,
  )
    ? (input.entityLevel as AutomationRuleEntityLevel)
    : null;
  if (!entityLevel) {
    throw new AutomationRuleValidationError(
      "entityLevel",
      "entity_level_must_be_campaign_or_adset",
    );
  }

  const triggerInput = isRecord(input.trigger) ? input.trigger : null;
  if (!triggerInput) {
    throw new AutomationRuleValidationError("trigger", "trigger_is_required");
  }
  const actionInput = isRecord(input.action) ? input.action : null;
  if (!actionInput) {
    throw new AutomationRuleValidationError("action", "action_is_required");
  }

  const triggerKind = AUTOMATION_RULE_TRIGGER_KINDS.includes(
    triggerInput.kind as AutomationRuleTriggerKind,
  )
    ? (triggerInput.kind as AutomationRuleTriggerKind)
    : null;
  if (!triggerKind) {
    throw new AutomationRuleValidationError(
      "trigger.kind",
      "unsupported_trigger_kind",
    );
  }

  const actionKind = AUTOMATION_RULE_ACTION_KINDS.includes(
    actionInput.kind as AutomationRuleActionKind,
  )
    ? (actionInput.kind as AutomationRuleActionKind)
    : null;
  if (!actionKind) {
    throw new AutomationRuleValidationError(
      "action.kind",
      "unsupported_action_kind",
    );
  }

  if (mode === "enforced") {
    if (triggerKind !== "quiet_hours") {
      throw new AutomationRuleValidationError(
        "trigger.kind",
        "enforced_rules_must_use_a_guard_trigger",
      );
    }
    if (actionKind !== "hard_block_writes") {
      throw new AutomationRuleValidationError(
        "action.kind",
        "enforced_rules_must_hard_block",
      );
    }
  } else {
    if (triggerKind === "quiet_hours") {
      throw new AutomationRuleValidationError(
        "trigger.kind",
        "quiet_hours_is_only_available_to_enforced_guards",
      );
    }
    if (actionKind === "hard_block_writes") {
      throw new AutomationRuleValidationError(
        "action.kind",
        "hard_block_is_only_available_to_enforced_guards",
      );
    }
  }

  let trigger: AutomationRuleTrigger;
  if (triggerKind === "quiet_hours") {
    const timeZone =
      typeof triggerInput.timeZone === "string"
        ? triggerInput.timeZone.trim()
        : "";
    if (!isSupportedTimeZone(timeZone)) {
      throw new AutomationRuleValidationError(
        "trigger.timeZone",
        "time_zone_must_be_a_valid_iana_zone",
      );
    }
    const startHour = finiteNumber(triggerInput.startHour);
    const endHour = finiteNumber(triggerInput.endHour);
    if (
      startHour === null ||
      endHour === null ||
      !Number.isInteger(startHour) ||
      !Number.isInteger(endHour) ||
      startHour < 0 ||
      startHour > 23 ||
      endHour < 1 ||
      endHour > 24 ||
      startHour === endHour
    ) {
      throw new AutomationRuleValidationError(
        "trigger.startHour",
        "quiet_hours_window_must_be_a_non_empty_hour_range",
      );
    }
    trigger = { kind: "quiet_hours", timeZone, startHour, endHour };
  } else {
    const anchor = AUTOMATION_RULE_COMMERCIAL_ANCHORS.includes(
      triggerInput.anchor as AutomationRuleCommercialAnchor,
    )
      ? (triggerInput.anchor as AutomationRuleCommercialAnchor)
      : null;
    if (!anchor) {
      throw new AutomationRuleValidationError(
        "trigger.anchor",
        "trigger_must_reference_a_commercial_truth_anchor",
      );
    }
    const wantsRoas =
      triggerKind === "roas_below_anchor" ||
      triggerKind === "roas_at_or_above_anchor";
    if (wantsRoas !== isRoasAnchor(anchor)) {
      throw new AutomationRuleValidationError(
        "trigger.anchor",
        wantsRoas
          ? "roas_trigger_requires_a_roas_anchor"
          : "cpa_trigger_requires_a_cpa_anchor",
      );
    }
    const anchorMultiplier =
      triggerInput.anchorMultiplier === undefined ||
      triggerInput.anchorMultiplier === null
        ? 1
        : finiteNumber(triggerInput.anchorMultiplier);
    if (
      anchorMultiplier === null ||
      anchorMultiplier <= 0 ||
      anchorMultiplier > MAX_ANCHOR_MULTIPLIER
    ) {
      throw new AutomationRuleValidationError(
        "trigger.anchorMultiplier",
        "anchor_multiplier_must_be_within_0_and_3_exclusive_of_zero",
      );
    }
    const consecutiveDays = finiteNumber(triggerInput.consecutiveDays);
    if (
      consecutiveDays === null ||
      !Number.isInteger(consecutiveDays) ||
      consecutiveDays < 1 ||
      consecutiveDays > MAX_CONSECUTIVE_DAYS
    ) {
      throw new AutomationRuleValidationError(
        "trigger.consecutiveDays",
        "consecutive_days_must_be_an_integer_between_1_and_30",
      );
    }
    // A trigger that also carried a literal threshold would be a free-floating
    // number wearing an anchor's clothes. Reject it rather than ignore it.
    for (const forbidden of ["threshold", "value", "absoluteThreshold"]) {
      if (triggerInput[forbidden] !== undefined) {
        throw new AutomationRuleValidationError(
          `trigger.${forbidden}`,
          "triggers_must_anchor_to_the_commercial_truth_pack_not_absolute_numbers",
        );
      }
    }
    trigger = {
      kind: triggerKind,
      anchor,
      anchorMultiplier,
      consecutiveDays,
    };
  }

  return {
    name,
    entityLevel,
    trigger,
    action: { kind: actionKind },
    mode,
  };
}

/**
 * Does this string name a zone the runtime can actually locate on the clock?
 *
 * Exported because the save boundary must ask the same question the write
 * boundary does. A quiet-hours window whose zone cannot be resolved fails
 * CLOSED -- it refuses every provider write, around the clock -- so accepting
 * an unresolvable label at save time turns a safety control into an outage the
 * operator cannot see coming.
 */
export function isSupportedTimeZone(timeZone: string) {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function resolveAnchorValue(
  anchors: AutomationRuleAnchorValues,
  trigger: AutomationRuleCommercialTrigger,
): { anchorValue: number | null; threshold: number | null } {
  const anchorValue = finiteNumber(anchors[trigger.anchor]);
  if (anchorValue === null || anchorValue <= 0) {
    return { anchorValue: null, threshold: null };
  }
  return {
    anchorValue,
    threshold: anchorValue * trigger.anchorMultiplier,
  };
}

function metricFor(
  row: AutomationRuleDailyMetric,
  trigger: AutomationRuleCommercialTrigger,
) {
  return isRoasAnchor(trigger.anchor)
    ? finiteNumber(row.roas)
    : finiteNumber(row.cpa);
}

function comparisonHolds(
  kind: AutomationRuleCommercialTriggerKind,
  observed: number,
  threshold: number,
) {
  switch (kind) {
    case "roas_below_anchor":
      return observed < threshold;
    case "roas_at_or_above_anchor":
      return observed >= threshold;
    case "cpa_above_anchor":
      return observed > threshold;
    case "cpa_at_or_below_anchor":
      return observed <= threshold;
  }
}

function sortedDescendingDaily(daily: AutomationRuleDailyMetric[]) {
  return daily
    .filter((row) => ISO_DATE.test(row.date))
    .slice()
    .sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0));
}

function compareVerdicts(
  left: AutomationRuleVerdict,
  right: AutomationRuleVerdict,
) {
  const byRule = left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0;
  if (byRule !== 0) return byRule;
  const leftEntity = left.entityId ?? "";
  const rightEntity = right.entityId ?? "";
  return leftEntity < rightEntity ? -1 : leftEntity > rightEntity ? 1 : 0;
}

export type AutomationRoasFloorVerdict =
  | "below_floor"
  | "at_or_above_floor"
  | "unprovable";

/**
 * One served day against the operator's ROAS floor.
 *
 * The floor means "automation may propose a pause only BELOW this ROAS", so a
 * proposal requires proof of being below it — strictly, because an entity
 * sitting exactly at the floor is not below it.
 *
 * What it compares: the warehouse's own served `roas` for that entity-day
 * (`meta_campaign_daily.roas` / `meta_adset_daily.roas`) — the same column the
 * rule's trigger already compares against its anchor. Nothing is averaged,
 * re-derived or reconstructed from two other fields; there is one ROAS here and
 * it is the one the warehouse serves.
 *
 * `spend` is consulted only to tell a measurement from a default: that column is
 * `NOT NULL DEFAULT 0`, so a day with no spend serves `roas = 0`, which would
 * otherwise sail under every floor an operator could set. A day with no spend,
 * or with no served row at all, is `unprovable` — never `below_floor`.
 */
export function clearsRoasProposalFloor(input: {
  roas: number | null;
  spend: number | null;
  floor: number;
}): AutomationRoasFloorVerdict {
  const spend = finiteNumber(input.spend);
  const roas = finiteNumber(input.roas);
  if (spend === null || spend <= 0 || roas === null) return "unprovable";
  return roas < input.floor ? "below_floor" : "at_or_above_floor";
}

/**
 * The floor applied to the exact window the rule itself evaluated.
 *
 * Same shape as the rule's own comparison: EVERY day in the window has to hold.
 * A proven day at or above the floor answers the question outright, so it wins
 * over an unprovable one; otherwise a single unprovable day makes the whole
 * window unprovable. Both outcomes withhold the proposal — the distinction is
 * only so the verdict says which happened.
 */
export function clearsRoasProposalFloorOverWindow(
  window: AutomationRuleDailyMetric[],
  floor: number,
): AutomationRoasFloorVerdict {
  let unprovable = false;
  for (const row of window) {
    const verdict = clearsRoasProposalFloor({
      roas: row.roas,
      spend: row.spend,
      floor,
    });
    if (verdict === "at_or_above_floor") return "at_or_above_floor";
    if (verdict === "unprovable") unprovable = true;
  }
  if (window.length === 0) return "unprovable";
  return unprovable ? "unprovable" : "below_floor";
}

/**
 * Evaluate every rule against every entity window.
 *
 * Pure. Given the same `input` this returns a deeply equal result, in the same
 * order, forever. It never consults the clock, a random source, the network or
 * a database, and it cannot execute anything: the richest thing it can say is
 * "this should become a proposal".
 */
export function evaluateAutomationRules(
  input: AutomationRuleEvaluationInput,
): AutomationRuleEvaluation {
  const verdicts: AutomationRuleVerdict[] = [];
  // A floor that is absent, zero or negative is not a floor. Normalised once,
  // here, so every comparison below reads the same committed number.
  const rawFloor = finiteNumber(input.minRoasFloor ?? null);
  const floor = rawFloor !== null && rawFloor > 0 ? rawFloor : null;
  const rules = input.rules
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  for (const rule of rules) {
    if (!rule.active) {
      verdicts.push({
        status: "skipped",
        ruleId: rule.id,
        entityId: null,
        reason: "rule_inactive",
      });
      continue;
    }

    if (!isCommercialTrigger(rule.trigger)) {
      // Guards are not entity-scoped: they are consulted at the write boundary
      // by `evaluateAutomationGuardRules`, not by the snapshot evaluation.
      verdicts.push({
        status: "skipped",
        ruleId: rule.id,
        entityId: null,
        reason: "guard_not_entity_scoped",
      });
      continue;
    }

    const trigger = rule.trigger;
    const { anchorValue, threshold } = resolveAnchorValue(input.anchors, trigger);
    if (anchorValue === null || threshold === null) {
      // The Commercial Truth pack does not supply this anchor. A rule with no
      // anchor has no honest verdict, so it produces none.
      verdicts.push({
        status: "unevaluable",
        ruleId: rule.id,
        entityId: null,
        reason: "anchor_missing",
      });
      continue;
    }

    const entities = input.entities
      .filter((entity) => entity.entityLevel === rule.entityLevel)
      .slice()
      .sort((left, right) =>
        left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0,
      );

    for (const entity of entities) {
      const daily = sortedDescendingDaily(entity.daily).filter(
        (row) => row.date <= input.asOfDate,
      );
      if (daily.length < trigger.consecutiveDays) {
        verdicts.push({
          status: "unevaluable",
          ruleId: rule.id,
          entityId: entity.entityId,
          reason: "insufficient_history",
        });
        continue;
      }

      const window = daily.slice(0, trigger.consecutiveDays);
      const observed: Array<{ date: string; value: number }> = [];
      let missingMetric = false;
      let holds = true;
      for (const row of window) {
        const value = metricFor(row, trigger);
        if (value === null) {
          missingMetric = true;
          break;
        }
        observed.push({ date: row.date, value });
        if (!comparisonHolds(trigger.kind, value, threshold)) {
          holds = false;
        }
      }

      if (missingMetric) {
        verdicts.push({
          status: "unevaluable",
          ruleId: rule.id,
          entityId: entity.entityId,
          reason: "metric_missing",
        });
        continue;
      }

      if (!holds) {
        verdicts.push({
          status: "not_met",
          ruleId: rule.id,
          entityId: entity.entityId,
        });
        continue;
      }

      // The operator's own ROAS floor, applied to the proposal-raising half of
      // the rule vocabulary. `propose_pause` is the only action that can put a
      // row in the queue, and the queue row promises "approving executes" — so
      // a floor the operator committed has to mean no such row exists for an
      // entity that is not proven below it. `hard_block_writes` is untouched:
      // guards refuse writes, they never propose.
      if (floor !== null && rule.action.kind === "propose_pause") {
        const cleared = clearsRoasProposalFloorOverWindow(window, floor);
        if (cleared !== "below_floor") {
          verdicts.push({
            status: "suppressed",
            ruleId: rule.id,
            entityId: entity.entityId,
            reason:
              cleared === "at_or_above_floor"
                ? "roas_at_or_above_floor"
                : "roas_floor_unprovable",
          });
          continue;
        }
      }

      const evaluatedForDate = window[0]!.date;
      verdicts.push({
        status: "fires",
        ruleId: rule.id,
        entityId: entity.entityId,
        entityLevel: entity.entityLevel,
        entityName: entity.entityName,
        providerAccountId: entity.providerAccountId,
        // Every non-guard mode raises a proposal. There is no branch here that
        // executes; `hard_block_writes` is unreachable for confirm/suggest by
        // construction (see `validateAutomationRuleDraft`).
        outcome: "proposal",
        evaluatedForDate,
        dedupeKey: `${rule.id}:${entity.entityId}:${evaluatedForDate}`,
        reason: describeFiringReason(rule, trigger, anchorValue, threshold),
        evidence: {
          anchor: trigger.anchor,
          anchorValue,
          threshold,
          consecutiveDays: trigger.consecutiveDays,
          observed,
        },
      });
    }
  }

  return {
    contractVersion: "automation-rule-evaluation.v1",
    asOfDate: input.asOfDate,
    verdicts: verdicts.sort(compareVerdicts),
  };
}

export function formatAnchorNumber(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

export const AUTOMATION_RULE_ANCHOR_LABELS: Record<
  AutomationRuleCommercialAnchor,
  string
> = {
  target_roas: "target",
  break_even_roas: "breakeven",
  target_cpa: "target CPA",
  break_even_cpa: "breakeven CPA",
};

export function describeTrigger(
  trigger: AutomationRuleTrigger,
  anchors: AutomationRuleAnchorValues,
): string {
  if (!isCommercialTrigger(trigger)) {
    const pad = (hour: number) => `${String(hour % 24).padStart(2, "0")}:00`;
    return `any provider write ${pad(trigger.startHour)}–${pad(trigger.endHour)} ${trigger.timeZone}`;
  }
  const { anchorValue, threshold } = resolveAnchorValue(anchors, trigger);
  const label = AUTOMATION_RULE_ANCHOR_LABELS[trigger.anchor];
  const anchorText =
    trigger.anchorMultiplier === 1
      ? `${label} (${formatAnchorNumber(anchorValue)})`
      : `${label} × ${trigger.anchorMultiplier} (${formatAnchorNumber(threshold)})`;
  const comparator =
    trigger.kind === "roas_below_anchor"
      ? "ROAS <"
      : trigger.kind === "roas_at_or_above_anchor"
        ? "ROAS ≥"
        : trigger.kind === "cpa_above_anchor"
          ? "CPA >"
          : "CPA ≤";
  const days =
    trigger.consecutiveDays === 1
      ? "for 1 day"
      : `for ${trigger.consecutiveDays} consecutive days`;
  return `${comparator} ${anchorText} ${days}`;
}

export function describeAction(action: AutomationRuleAction): string {
  switch (action.kind) {
    case "propose_pause":
      return "Propose pause into the queue";
    case "hard_block_writes":
      return "Hard block · logged";
  }
}

function describeFiringReason(
  rule: AutomationRuleDefinition,
  trigger: AutomationRuleCommercialTrigger,
  anchorValue: number,
  threshold: number,
) {
  const label = AUTOMATION_RULE_ANCHOR_LABELS[trigger.anchor];
  const metric = isCpaAnchor(trigger.anchor) ? "CPA" : "ROAS";
  const comparator =
    trigger.kind === "roas_below_anchor"
      ? "below"
      : trigger.kind === "roas_at_or_above_anchor"
        ? "at or above"
        : trigger.kind === "cpa_above_anchor"
          ? "above"
          : "at or below";
  const anchorText =
    trigger.anchorMultiplier === 1
      ? `${label} ${anchorValue.toFixed(2)}`
      : `${label} × ${trigger.anchorMultiplier} (${threshold.toFixed(2)})`;
  const days =
    trigger.consecutiveDays === 1
      ? "1 day"
      : `${trigger.consecutiveDays} consecutive days`;
  return `${rule.name}: ${metric} ${comparator} ${anchorText} for ${days}.`;
}

/**
 * The map of `AutomationRuleActionKind` onto the CONFIRMATION QUEUE's own
 * action vocabulary. A kind that is absent here cannot be queued — which is why
 * `hard_block_writes` is absent: a guard refuses, it does not propose.
 */
export const AUTOMATION_RULE_PROPOSAL_ACTION_KINDS = {
  propose_pause: "pause",
} as const;

/**
 * The queue row's evidence chip, rendered from the firing's own stored numbers.
 *
 * Nothing here is composed out of two half-known values: the anchor, its
 * threshold and the window all come from the evidence the pure evaluator
 * recorded, so the chip says exactly what fired the rule.
 */
export function describeFiringEvidence(
  evidence: AutomationRuleFiringEvidence,
): string | null {
  if (!evidence.anchor || evidence.threshold === null) return null;
  const label = AUTOMATION_RULE_ANCHOR_LABELS[evidence.anchor];
  const days =
    evidence.consecutiveDays === 1 ? "1d" : `${evidence.consecutiveDays}d`;
  return `${label} ${evidence.threshold.toFixed(2)} · ${days}`;
}

export interface AutomationGuardBlock {
  ruleId: string;
  ruleName: string;
  reason: string;
}

/**
 * Guard evaluation, consulted at the existing provider-write boundary.
 *
 * `at` is an explicit instant so this is deterministic in tests and in
 * production alike. A guard can only ever say "blocked"; it has no path that
 * permits or performs a write.
 */
export function evaluateAutomationGuardRules(input: {
  rules: AutomationRuleDefinition[];
  at: Date;
}): AutomationGuardBlock | null {
  const guards = input.rules
    .filter((rule) => rule.mode === "enforced" && rule.active)
    .filter(
      (rule): rule is AutomationRuleDefinition & {
        trigger: AutomationRuleQuietHoursTrigger;
      } => rule.trigger.kind === "quiet_hours",
    )
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  for (const rule of guards) {
    const hour = hourInTimeZone(input.at, rule.trigger.timeZone);
    if (hour === null) continue;
    if (isWithinQuietHours(hour, rule.trigger)) {
      const pad = (value: number) => `${String(value % 24).padStart(2, "0")}:00`;
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        reason: `${rule.name}: provider writes are hard-blocked between ${pad(rule.trigger.startHour)} and ${pad(rule.trigger.endHour)} ${rule.trigger.timeZone}.`,
      };
    }
  }
  return null;
}

/**
 * The ONE wrap-around implementation for a quiet window, in minutes since local
 * midnight. Start inclusive, end exclusive. A window whose start is at or after
 * its end crosses midnight and wraps — `22:00 → 06:00` is inside at `23:30` and
 * at `02:00`, outside at `12:00`.
 *
 * Both quiet-hours shapes in this product go through here: the `enforced` rule's
 * hour-grain trigger, and the operator's own minute-grain guardrail window. Two
 * implementations of "does this instant fall inside that window" would be two
 * chances to get midnight wrong, and only one of them could be right.
 */
export function isWithinQuietWindow(
  minuteOfDay: number,
  startMinuteOfDay: number,
  endMinuteOfDay: number,
) {
  if (startMinuteOfDay < endMinuteOfDay) {
    return minuteOfDay >= startMinuteOfDay && minuteOfDay < endMinuteOfDay;
  }
  return minuteOfDay >= startMinuteOfDay || minuteOfDay < endMinuteOfDay;
}

export function isWithinQuietHours(
  hour: number,
  trigger: Pick<AutomationRuleQuietHoursTrigger, "startHour" | "endHour">,
) {
  return isWithinQuietWindow(hour * 60, trigger.startHour * 60, trigger.endHour * 60);
}

/**
 * Minutes since local midnight in `timeZone`, or `null` when this instant
 * cannot be located on that clock at all.
 *
 * `null` is the honest "I could not tell", and every caller must treat it as a
 * refusal rather than a pass: an unresolvable zone means the window's position
 * on the clock is unknown, not that the instant is outside it.
 */
export function minuteOfDayInTimeZone(
  at: Date,
  timeZone: string,
): number | null {
  const time = at.getTime();
  if (!Number.isFinite(time)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).formatToParts(at);
    const rawHour = parts.find((part) => part.type === "hour")?.value;
    const rawMinute = parts.find((part) => part.type === "minute")?.value;
    if (!rawHour || !rawMinute) return null;
    const hour = Number(rawHour);
    const minute = Number(rawMinute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 24) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}

export function hourInTimeZone(at: Date, timeZone: string): number | null {
  const minuteOfDay = minuteOfDayInTimeZone(at, timeZone);
  return minuteOfDay === null ? null : Math.floor(minuteOfDay / 60);
}

/** `HH:MM` → minutes since midnight; anything else → `null`. */
export function quietWindowMinuteOfDay(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * The quiet-hours window an operator committed by hand, as persisted.
 *
 * Structural rather than imported from the control plane, so this module keeps
 * its promise of depending on nothing.
 */
export interface AutomationQuietHoursPolicy {
  /** `HH:MM` in `timezone`. Inclusive. */
  start: string;
  /** `HH:MM` in `timezone`. Exclusive. */
  end: string;
  /** Must resolve as an IANA zone; a display label cannot be located on a clock. */
  timezone: string;
}

/**
 * Evaluate the operator's own quiet-hours window at the provider-write boundary.
 *
 * **This fails CLOSED, deliberately.** A window that cannot be interpreted is
 * refused, not ignored:
 *
 * - an unresolvable `timezone` (empty, or anything `Intl` rejects — `ET` is a
 *   display label, not a zone) means the window's position on the clock is
 *   unknown, so every instant might be inside it;
 * - a `start` or `end` that is not `HH:MM` is not a boundary;
 * - `start === end` names either a zero-length window or a whole day, and there
 *   is no way to tell which the operator meant.
 *
 * In each case the operator has asked for a window and the product cannot say
 * whether this write falls in it. Allowing the write would be the exact defect
 * this guardrail exists to prevent — a control that is displayed and not
 * honoured — so the write is refused and the message names what could not be
 * resolved, which is also how the operator finds out to fix it.
 *
 * `null` quiet hours means no window was ever persisted, which is not a failure:
 * nothing is refused and behaviour is unchanged.
 *
 * Pure and deterministic: `at` is an explicit instant, never the clock.
 */
export function evaluatePersistedQuietHoursGuardrail(input: {
  quietHours: AutomationQuietHoursPolicy | null;
  at: Date;
}): { reason: string } | null {
  const policy = input.quietHours;
  if (!policy) return null;

  const timezone = policy.timezone.trim();
  const start = quietWindowMinuteOfDay(policy.start);
  const end = quietWindowMinuteOfDay(policy.end);
  if (start === null || end === null) {
    return {
      reason: `Quiet hours: provider writes are refused because the configured window (${policy.start}–${policy.end}) is not a readable clock range.`,
    };
  }
  if (start === end) {
    return {
      reason: `Quiet hours: provider writes are refused because the configured window starts and ends at ${policy.start}, which names neither a range nor a whole day.`,
    };
  }
  const minuteOfDay = timezone
    ? minuteOfDayInTimeZone(input.at, timezone)
    : null;
  if (minuteOfDay === null) {
    return {
      reason: `Quiet hours: provider writes are refused because the configured timezone ${timezone || "(none)"} could not be resolved, so ${policy.start}–${policy.end} cannot be located on the clock.`,
    };
  }
  if (!isWithinQuietWindow(minuteOfDay, start, end)) return null;
  return {
    reason: `Quiet hours: provider writes are hard-blocked between ${policy.start} and ${policy.end} ${timezone}.`,
  };
}
