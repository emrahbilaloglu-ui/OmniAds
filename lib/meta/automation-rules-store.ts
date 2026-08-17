/**
 * Persistence for automation rules, their firings, and the 28-day count the
 * design's "Fired · 28d" column shows.
 *
 * Every write in this file lands in a table this repo owns. There is no
 * provider client here and there never may be: the engine's whole contract is
 * that a rule raises a proposal or hard-blocks, and both of those are rows.
 */

import { getDb } from "@/lib/db";
import {
  AUTOMATION_RULE_PROPOSAL_ACTION_KINDS,
  anchorsFromTargetPack,
  describeFiringEvidence,
  isAutomationRuleLocked,
  validateAutomationRuleDraft,
  type AutomationRuleAction,
  type AutomationRuleDefinition,
  type AutomationRuleEntityLevel,
  type AutomationRuleMode,
  type AutomationRuleTrigger,
  type AutomationRuleVerdict,
} from "@/lib/meta/automation-rules";
import {
  AUTOMATION_PROPOSAL_CONTRACT_VERSION,
  persistAutomationRuleProposal,
  type AutomationProposalDraft,
  type AutomationProposalSink,
} from "@/lib/meta/automation-proposal-intake";

export const AUTOMATION_RULE_FIRED_WINDOW_DAYS = 28;

export class AutomationRuleLockedError extends Error {
  readonly code = "automation_rule_locked";

  constructor() {
    super("Enforced guard rules cannot be disabled.");
    this.name = "AutomationRuleLockedError";
  }
}

export class AutomationRuleNotFoundError extends Error {
  readonly code = "automation_rule_not_found";

  constructor() {
    super("No such automation rule for this business.");
    this.name = "AutomationRuleNotFoundError";
  }
}

export class AutomationRuleDuplicateNameError extends Error {
  readonly code = "automation_rule_duplicate_name";

  constructor() {
    super("A rule with this name already exists for this business.");
    this.name = "AutomationRuleDuplicateNameError";
  }
}

type RuleDbRow = {
  id: string;
  business_id: string;
  name: string;
  entity_level: string;
  trigger_json: unknown;
  action_json: unknown;
  mode: string;
  active: boolean | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
};

type FiringCountDbRow = {
  rule_id: string;
  fired_count: string | number;
  last_fired_at: string | Date | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeTimestamp(value: string | Date | null | undefined) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value === "string" && value.trim()) return value;
  return null;
}

/**
 * Rows are validated on the way out, not trusted. A row whose stored trigger or
 * action no longer satisfies the state machine is dropped rather than rendered:
 * an un-typeable rule has no honest row on the surface.
 */
export function mapAutomationRuleRow(
  row: RuleDbRow,
): AutomationRuleDefinition | null {
  try {
    const validated = validateAutomationRuleDraft({
      name: row.name,
      entityLevel: row.entity_level,
      trigger: isRecord(row.trigger_json) ? row.trigger_json : null,
      action: isRecord(row.action_json) ? row.action_json : null,
      mode: row.mode,
    });
    return {
      id: row.id,
      businessId: row.business_id,
      name: validated.name,
      entityLevel: validated.entityLevel,
      trigger: validated.trigger,
      action: validated.action,
      mode: validated.mode,
      active: row.active === true,
      createdAt: normalizeTimestamp(row.created_at),
      updatedAt: normalizeTimestamp(row.updated_at),
    };
  } catch {
    return null;
  }
}

export async function listAutomationRules(
  businessId: string,
): Promise<AutomationRuleDefinition[]> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id, business_id, name, entity_level, trigger_json, action_json, mode, active, created_at, updated_at
    FROM meta_automation_rules
    WHERE business_id = ${businessId}
    ORDER BY created_at ASC, id ASC
  `) as RuleDbRow[];
  return rows
    .map(mapAutomationRuleRow)
    .filter((rule): rule is AutomationRuleDefinition => rule !== null);
}

export interface AutomationRuleFiredCount {
  ruleId: string;
  firedCount: number;
  lastFiredAt: string | null;
}

/**
 * Real events over a real window. `asOf` is explicit so the count is
 * reproducible; the caller decides what "now" means.
 */
export async function countAutomationRuleFirings(input: {
  businessId: string;
  asOf: Date;
  windowDays?: number;
}): Promise<Map<string, AutomationRuleFiredCount>> {
  const windowDays = input.windowDays ?? AUTOMATION_RULE_FIRED_WINDOW_DAYS;
  const since = new Date(
    input.asOf.getTime() - windowDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const sql = getDb();
  const rows = (await sql`
    SELECT rule_id, COUNT(*) AS fired_count, MAX(fired_at) AS last_fired_at
    FROM meta_automation_rule_firings
    WHERE business_id = ${input.businessId}
      AND fired_at >= ${since}::timestamptz
      AND fired_at <= ${input.asOf.toISOString()}::timestamptz
    GROUP BY rule_id
  `) as FiringCountDbRow[];
  const counts = new Map<string, AutomationRuleFiredCount>();
  for (const row of rows) {
    const firedCount = Number(row.fired_count);
    counts.set(row.rule_id, {
      ruleId: row.rule_id,
      firedCount: Number.isFinite(firedCount) ? firedCount : 0,
      lastFiredAt: normalizeTimestamp(row.last_fired_at),
    });
  }
  return counts;
}

export interface CreateAutomationRuleInput {
  businessId: string;
  userId: string;
  name: unknown;
  entityLevel: unknown;
  trigger: unknown;
  action: unknown;
  mode: unknown;
}

export async function createAutomationRule(
  input: CreateAutomationRuleInput,
): Promise<AutomationRuleDefinition> {
  const draft = validateAutomationRuleDraft({
    name: input.name,
    entityLevel: input.entityLevel,
    trigger: input.trigger,
    action: input.action,
    mode: input.mode,
  });
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO meta_automation_rules (
      business_id, name, entity_level, trigger_json, action_json, mode, active, created_by, updated_by
    )
    VALUES (
      ${input.businessId},
      ${draft.name},
      ${draft.entityLevel},
      ${JSON.stringify(draft.trigger)}::jsonb,
      ${JSON.stringify(draft.action)}::jsonb,
      ${draft.mode},
      TRUE,
      ${input.userId},
      ${input.userId}
    )
    ON CONFLICT (business_id, name) DO NOTHING
    RETURNING id, business_id, name, entity_level, trigger_json, action_json, mode, active, created_at, updated_at
  `) as RuleDbRow[];
  const row = rows[0];
  if (!row) throw new AutomationRuleDuplicateNameError();
  const rule = mapAutomationRuleRow(row);
  if (!rule) throw new AutomationRuleNotFoundError();

  await recordAutomationRuleLedgerEntry({
    businessId: input.businessId,
    userId: input.userId,
    activityType: "automation_rule_created",
    severity: "info",
    message: `Automation rule "${rule.name}" created in ${rule.mode} mode.`,
    payload: {
      ruleId: rule.id,
      mode: rule.mode,
      entityLevel: rule.entityLevel,
      trigger: rule.trigger,
      action: rule.action,
    },
  });
  return rule;
}

/**
 * The toggle. Enforced guards are locked — the design's toggle title says
 * "Enforced — cannot be disabled", and this is where that is true rather than
 * merely displayed.
 */
export async function setAutomationRuleActive(input: {
  businessId: string;
  userId: string;
  ruleId: string;
  active: boolean;
}): Promise<AutomationRuleDefinition> {
  const sql = getDb();
  const currentRows = (await sql`
    SELECT id, business_id, name, entity_level, trigger_json, action_json, mode, active, created_at, updated_at
    FROM meta_automation_rules
    WHERE business_id = ${input.businessId} AND id = ${input.ruleId}
    LIMIT 1
  `) as RuleDbRow[];
  const current = currentRows[0] ? mapAutomationRuleRow(currentRows[0]) : null;
  if (!current) throw new AutomationRuleNotFoundError();
  if (isAutomationRuleLocked(current) && input.active === false) {
    throw new AutomationRuleLockedError();
  }

  const rows = (await sql`
    UPDATE meta_automation_rules
    SET active = ${input.active}, updated_by = ${input.userId}, updated_at = NOW()
    WHERE business_id = ${input.businessId} AND id = ${input.ruleId}
    RETURNING id, business_id, name, entity_level, trigger_json, action_json, mode, active, created_at, updated_at
  `) as RuleDbRow[];
  const updated = rows[0] ? mapAutomationRuleRow(rows[0]) : null;
  if (!updated) throw new AutomationRuleNotFoundError();

  await recordAutomationRuleLedgerEntry({
    businessId: input.businessId,
    userId: input.userId,
    activityType: input.active
      ? "automation_rule_enabled"
      : "automation_rule_disabled",
    severity: "info",
    message: `Automation rule "${updated.name}" ${input.active ? "enabled" : "disabled"}.`,
    payload: { ruleId: updated.id, active: input.active },
  });
  return updated;
}

async function recordAutomationRuleLedgerEntry(input: {
  businessId: string;
  userId: string | null;
  activityType: string;
  severity: "info" | "warning" | "danger" | "success";
  message: string;
  payload: Record<string, unknown>;
}) {
  const sql = getDb();
  await sql`
    INSERT INTO meta_automation_activity_ledger (
      business_id, activity_type, severity, message, payload_json, created_by
    )
    VALUES (
      ${input.businessId},
      ${input.activityType},
      ${input.severity},
      ${input.message},
      ${JSON.stringify(input.payload)}::jsonb,
      ${input.userId}
    )
  `;
}

export interface RecordedFiring {
  ruleId: string;
  entityId: string;
  evaluatedForDate: string;
  outcome: "proposal_raised" | "hard_block_recorded";
  proposalId: string | null;
  inserted: boolean;
}

type FiringDbRow = { id: string };

/**
 * Persist the firings a deterministic evaluation produced, then hand each one
 * to the confirmation queue through the intake sink.
 *
 * Order matters: the firing row is written first and the proposal second, so a
 * proposal can never exist without the evidence that produced it. The unique
 * `(rule_id, entity_id, evaluated_for_date)` constraint makes a re-run over the
 * same warehouse day a no-op rather than a second count.
 *
 * The two counts on this screen stay independent facts. "Fired · 28d" counts
 * rows in `meta_automation_rule_firings`; the queue header counts pending rows
 * in `meta_automation_proposals`. A firing that finds the entity's pending slot
 * already held raises no second row — it links to the one that is already
 * there — so a queued proposal is never counted twice, and a firing that joined
 * an existing proposal is still counted once as a firing.
 *
 * This function cannot reach a provider. Its only outputs are two INSERTs into
 * this product's own tables; execution belongs to the queue's approve path.
 */
export async function recordRuleFirings(input: {
  businessId: string;
  rules: AutomationRuleDefinition[];
  verdicts: AutomationRuleVerdict[];
  proposalSink?: AutomationProposalSink;
}): Promise<RecordedFiring[]> {
  const sink = input.proposalSink ?? persistAutomationRuleProposal;
  const sql = getDb();
  const byId = new Map(input.rules.map((rule) => [rule.id, rule]));
  const recorded: RecordedFiring[] = [];

  for (const verdict of input.verdicts) {
    if (verdict.status !== "fires") continue;
    const rule = byId.get(verdict.ruleId);
    if (!rule) continue;
    // Structural guarantee, restated at the persistence boundary: the only
    // outcomes that exist are a queued proposal and a recorded hard block.
    if (verdict.outcome !== "proposal" && verdict.outcome !== "hard_block") {
      continue;
    }

    const rows = (await sql`
      INSERT INTO meta_automation_rule_firings (
        business_id,
        rule_id,
        provider_account_id,
        entity_level,
        entity_id,
        entity_name,
        evaluated_for_date,
        outcome,
        reason,
        evidence_json
      )
      VALUES (
        ${input.businessId},
        ${verdict.ruleId},
        ${verdict.providerAccountId},
        ${verdict.entityLevel},
        ${verdict.entityId},
        ${verdict.entityName},
        ${verdict.evaluatedForDate}::date,
        ${verdict.outcome === "proposal" ? "proposal_raised" : "hard_block_recorded"},
        ${verdict.reason},
        ${JSON.stringify(verdict.evidence)}::jsonb
      )
      ON CONFLICT (rule_id, entity_id, evaluated_for_date) DO NOTHING
      RETURNING id
    `) as FiringDbRow[];

    const inserted = rows.length > 0;
    let proposalId: string | null = null;

    if (verdict.outcome === "proposal") {
      const proposedAction =
        AUTOMATION_RULE_PROPOSAL_ACTION_KINDS[
          rule.action.kind as keyof typeof AUTOMATION_RULE_PROPOSAL_ACTION_KINDS
        ];
      // A firing with no account scope cannot appear in an account-scoped
      // queue, so it stays a recorded firing and raises nothing.
      if (proposedAction && verdict.providerAccountId) {
        const receipt = await sink(
          buildProposalDraft({
            businessId: input.businessId,
            rule,
            verdict,
            providerAccountId: verdict.providerAccountId,
            proposedAction,
          }),
        );
        proposalId = receipt.proposalId;
        if (proposalId && inserted) {
          await sql`
            UPDATE meta_automation_rule_firings
            SET proposal_id = ${proposalId}
            WHERE id = ${rows[0]!.id}
          `;
        }
      }
    }

    recorded.push({
      ruleId: verdict.ruleId,
      entityId: verdict.entityId,
      evaluatedForDate: verdict.evaluatedForDate,
      outcome:
        verdict.outcome === "proposal"
          ? "proposal_raised"
          : "hard_block_recorded",
      proposalId,
      inserted,
    });
  }

  return recorded;
}

function buildProposalDraft(input: {
  businessId: string;
  rule: AutomationRuleDefinition;
  verdict: Extract<AutomationRuleVerdict, { status: "fires" }>;
  providerAccountId: string;
  proposedAction: AutomationProposalDraft["proposedAction"];
}): AutomationProposalDraft {
  return {
    contractVersion: AUTOMATION_PROPOSAL_CONTRACT_VERSION,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    sourceKind: "automation_rule",
    sourceId: input.rule.id,
    sourceName: input.rule.name,
    proposedAction: input.proposedAction,
    entityLevel: input.verdict.entityLevel,
    entityId: input.verdict.entityId,
    entityName: input.verdict.entityName,
    reason: input.verdict.reason,
    evidenceLabel: describeFiringEvidence(input.verdict.evidence),
    evidence: {
      ...input.verdict.evidence,
      mode: input.rule.mode,
      ruleName: input.rule.name,
    },
    dedupeKey: input.verdict.dedupeKey,
    evaluatedForDate: input.verdict.evaluatedForDate,
    requiresConfirmation: true,
    autoExecute: false,
  };
}

/**
 * Record that an enforced guard actually refused a provider write.
 *
 * Called from the existing guarded write path, at the moment a write was
 * attempted and blocked — never from a read. The design's "Hard block · logged"
 * is what makes the Enforced row's fired count real.
 */
export async function recordAutomationGuardBlock(input: {
  businessId: string;
  ruleId: string;
  ruleName: string;
  reason: string;
  providerAccountId?: string | null;
  entityId?: string | null;
  at: Date;
}): Promise<void> {
  const sql = getDb();
  const day = input.at.toISOString().slice(0, 10);
  const entityId = input.entityId?.trim() || "provider_write";
  await sql`
    INSERT INTO meta_automation_rule_firings (
      business_id,
      rule_id,
      provider_account_id,
      entity_level,
      entity_id,
      entity_name,
      evaluated_for_date,
      outcome,
      reason,
      evidence_json
    )
    VALUES (
      ${input.businessId},
      ${input.ruleId},
      ${input.providerAccountId ?? null},
      'account',
      ${entityId},
      ${input.ruleName},
      ${day}::date,
      'hard_block_recorded',
      ${input.reason},
      ${JSON.stringify({ blockedAt: input.at.toISOString() })}::jsonb
    )
    ON CONFLICT (rule_id, entity_id, evaluated_for_date) DO NOTHING
  `;
}

export { anchorsFromTargetPack };

export type {
  AutomationRuleAction,
  AutomationRuleDefinition,
  AutomationRuleEntityLevel,
  AutomationRuleMode,
  AutomationRuleTrigger,
};
