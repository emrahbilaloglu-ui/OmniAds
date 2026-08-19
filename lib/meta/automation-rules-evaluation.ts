/**
 * The orchestrator: read real inputs, run the pure evaluator, persist the
 * firings, raise the proposals.
 *
 * The only non-deterministic thing an evaluation could do is decide for itself
 * what "today" is, so it does not: `asOfDate` defaults to the newest warehouse
 * day for the scoped account, which makes a re-run over an unchanged warehouse
 * produce byte-identical verdicts.
 */

import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import {
  anchorsFromTargetPack,
  evaluateAutomationRules,
  type AutomationRuleAnchorValues,
  type AutomationRuleDefinition,
  type AutomationRuleEntityWindow,
  type AutomationRuleEvaluation,
} from "@/lib/meta/automation-rules";
import {
  listAutomationRules,
  recordRuleFirings,
  type RecordedFiring,
} from "@/lib/meta/automation-rules-store";
import type { AutomationProposalSink } from "@/lib/meta/automation-proposal-intake";
import { readMetaAutomationProposalRoasFloor } from "@/lib/meta/automation-guardrail-policy";
import { getMetaWriteBlockState } from "@/lib/meta/automation-control-plane";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";

/** Hard ceiling on how much history one evaluation may pull per entity. */
const MAX_LOOKBACK_DAYS = 30;

export interface AutomationRuleEvaluationReport {
  contractVersion: "automation-rule-evaluation-report.v1";
  businessId: string;
  providerAccountId: string;
  asOfDate: string | null;
  /** Null when the Commercial Truth pack supplies no usable anchor at all. */
  anchors: AutomationRuleAnchorValues;
  ruleCount: number;
  evaluation: AutomationRuleEvaluation | null;
  recorded: RecordedFiring[];
  skippedReason:
    | "no_rules"
    | "no_warehouse_history"
    | "no_commercial_anchors"
    /** The operator's ROAS floor could not be read, so nothing may be proposed. */
    | "roas_floor_unreadable"
    | null;
  /** The floor this evaluation actually applied. `null` when none is committed. */
  minRoasFloor: number | null;
}

type DailyDbRow = {
  entity_id: string;
  entity_name: string | null;
  date: string | Date;
  roas: number | null;
  cpa: number | null;
  spend: number | null;
  revenue: number | null;
};

function isoDate(value: string | Date) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function readLatestWarehouseDate(input: {
  businessId: string;
  providerAccountId: string;
  level: "campaign" | "adset";
}): Promise<string | null> {
  const sql = getDb();
  const rows =
    input.level === "campaign"
      ? ((await sql`
          SELECT MAX(date)::text AS max_date
          FROM meta_campaign_daily
          WHERE business_id = ${input.businessId}
            AND provider_account_id = ${input.providerAccountId}
        `) as Array<{ max_date: string | null }>)
      : ((await sql`
          SELECT MAX(date)::text AS max_date
          FROM meta_adset_daily
          WHERE business_id = ${input.businessId}
            AND provider_account_id = ${input.providerAccountId}
        `) as Array<{ max_date: string | null }>);
  return rows[0]?.max_date ?? null;
}

async function readEntityWindows(input: {
  businessId: string;
  providerAccountId: string;
  level: "campaign" | "adset";
  asOfDate: string;
  lookbackDays: number;
}): Promise<AutomationRuleEntityWindow[]> {
  const sql = getDb();
  const rows =
    input.level === "campaign"
      ? ((await sql`
          SELECT
            campaign_id AS entity_id,
            campaign_name_current AS entity_name,
            date::text AS date,
            roas,
            cpa,
            spend,
            revenue
          FROM meta_campaign_daily
          WHERE business_id = ${input.businessId}
            AND provider_account_id = ${input.providerAccountId}
            AND date <= ${input.asOfDate}::date
            AND date > ${input.asOfDate}::date - ${input.lookbackDays}::int
          ORDER BY campaign_id ASC, date DESC
        `) as DailyDbRow[])
      : ((await sql`
          SELECT
            adset_id AS entity_id,
            adset_name_current AS entity_name,
            date::text AS date,
            roas,
            cpa,
            spend,
            revenue
          FROM meta_adset_daily
          WHERE business_id = ${input.businessId}
            AND provider_account_id = ${input.providerAccountId}
            AND date <= ${input.asOfDate}::date
            AND date > ${input.asOfDate}::date - ${input.lookbackDays}::int
          ORDER BY adset_id ASC, date DESC
        `) as DailyDbRow[]);

  const byEntity = new Map<string, AutomationRuleEntityWindow>();
  for (const row of rows) {
    const entityId = String(row.entity_id ?? "").trim();
    if (!entityId) continue;
    let window = byEntity.get(entityId);
    if (!window) {
      window = {
        entityLevel: input.level,
        entityId,
        entityName: row.entity_name?.trim() || null,
        providerAccountId: input.providerAccountId,
        daily: [],
      };
      byEntity.set(entityId, window);
    }
    window.daily.push({
      date: isoDate(row.date),
      roas: typeof row.roas === "number" ? row.roas : null,
      cpa: typeof row.cpa === "number" ? row.cpa : null,
      spend: typeof row.spend === "number" ? row.spend : null,
      revenue: typeof row.revenue === "number" ? row.revenue : null,
    });
  }
  return [...byEntity.values()].sort((left, right) =>
    left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0,
  );
}

export async function evaluateBusinessAutomationRules(input: {
  businessId: string;
  providerAccountId: string;
  asOfDate?: string | null;
  rules?: AutomationRuleDefinition[];
  proposalSink?: AutomationProposalSink;
}): Promise<AutomationRuleEvaluationReport> {
  const rules =
    input.rules ?? (await listAutomationRules(input.businessId));
  const snapshot = await getBusinessCommercialTruthSnapshot(input.businessId);
  const anchors = anchorsFromTargetPack(snapshot.targetPack);

  const base: Omit<
    AutomationRuleEvaluationReport,
    | "asOfDate"
    | "evaluation"
    | "recorded"
    | "skippedReason"
    | "minRoasFloor"
  > = {
    contractVersion: "automation-rule-evaluation-report.v1",
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    anchors,
    ruleCount: rules.length,
  };

  const evaluableRules = rules.filter(
    (rule) => rule.active && rule.trigger.kind !== "quiet_hours",
  );
  if (evaluableRules.length === 0) {
    return {
      ...base,
      asOfDate: input.asOfDate ?? null,
      evaluation: null,
      recorded: [],
      skippedReason: "no_rules",
      minRoasFloor: null,
    };
  }

  const hasAnchor = Object.values(anchors).some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  if (!hasAnchor) {
    // Anchored to the Commercial Truth pack, literally: with no pack there is
    // nothing to compare against, and inventing a threshold is the one thing
    // this engine must never do.
    return {
      ...base,
      asOfDate: input.asOfDate ?? null,
      evaluation: null,
      recorded: [],
      skippedReason: "no_commercial_anchors",
      minRoasFloor: null,
    };
  }

  // The operator's ROAS proposal floor, read BEFORE anything can be raised.
  //
  // Fail closed: a floor this process cannot read is not the same fact as no
  // floor, and proposing under a guardrail we could not consult is precisely the
  // defect this gate exists to close. So an unreadable floor skips the whole
  // evaluation rather than running it ungated.
  const floorRead = await readMetaAutomationProposalRoasFloor(input.businessId);
  if (floorRead.status === "unreadable") {
    return {
      ...base,
      asOfDate: input.asOfDate ?? null,
      evaluation: null,
      recorded: [],
      skippedReason: "roas_floor_unreadable",
      minRoasFloor: null,
    };
  }
  const minRoasFloor = floorRead.floor;

  const levels = Array.from(
    new Set(evaluableRules.map((rule) => rule.entityLevel)),
  ).sort();
  const lookbackDays = Math.min(
    MAX_LOOKBACK_DAYS,
    Math.max(
      ...evaluableRules.map((rule) =>
        rule.trigger.kind === "quiet_hours" ? 1 : rule.trigger.consecutiveDays,
      ),
    ),
  );

  const entities: AutomationRuleEntityWindow[] = [];
  let asOfDate = input.asOfDate?.trim() || null;
  for (const level of levels) {
    const levelAsOf =
      asOfDate ??
      (await readLatestWarehouseDate({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        level,
      }));
    if (!levelAsOf) continue;
    asOfDate = asOfDate ?? levelAsOf;
    entities.push(
      ...(await readEntityWindows({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        level,
        asOfDate: levelAsOf,
        lookbackDays,
      })),
    );
  }

  if (!asOfDate || entities.length === 0) {
    return {
      ...base,
      asOfDate,
      evaluation: null,
      recorded: [],
      skippedReason: "no_warehouse_history",
      minRoasFloor,
    };
  }

  const evaluation = evaluateAutomationRules({
    rules: evaluableRules,
    anchors,
    entities,
    asOfDate,
    minRoasFloor,
  });
  const recorded = await recordRuleFirings({
    businessId: input.businessId,
    rules: evaluableRules,
    verdicts: evaluation.verdicts,
    proposalSink: input.proposalSink,
  });

  return {
    ...base,
    asOfDate,
    evaluation,
    recorded,
    skippedReason: null,
    minRoasFloor,
  };
}

/**
 * The scheduler slot rule evaluation runs in, in UTC.
 *
 * 03:00 is the Meta snapshot, 04:00 the ignored-decision marker, 05:00 the
 * outcome accrual; this takes the next free hour so it reads a warehouse day
 * those jobs have already settled. The hour is NOT a threshold and nothing in a
 * verdict depends on it: `meta_automation_rule_firings` is unique on
 * `(rule_id, entity_id, evaluated_for_date)`, so a second pass over the same
 * warehouse day records nothing new. It is a cadence, chosen the way its three
 * siblings in this cron chose theirs.
 */
const RULE_EVALUATION_UTC_HOUR = 6;

export type MetaAutomationRuleEvaluationSkip =
  | "not_due"
  | "schema_not_ready";

export interface MetaAutomationRuleEvaluationBusinessOutcome {
  businessId: string;
  /** Present only when the business was skipped before any account ran. */
  skippedReason?:
    | "no_rules"
    | "rules_unreadable"
    | "no_assigned_accounts"
    | "writes_blocked";
  /** The kill-switch reason, verbatim, when `writes_blocked`. */
  blockReason?: string | null;
  accounts: Array<{
    providerAccountId: string;
    status: "evaluated" | "failed";
    skippedReason?: AutomationRuleEvaluationReport["skippedReason"];
    firings?: number;
    error?: string;
  }>;
}

export type MetaAutomationRuleEvaluationJobResult =
  | { skipped: true; reason: MetaAutomationRuleEvaluationSkip; runDate: string }
  | {
      skipped: false;
      runDate: string;
      businesses: MetaAutomationRuleEvaluationBusinessOutcome[];
    };

/**
 * The production trigger for {@link evaluateBusinessAutomationRules}.
 *
 * Until this existed the evaluator had exactly one caller — the operator-driven
 * `evaluate_rules` action on `POST /api/meta/automation` — and no periodic one,
 * which meant a rule an operator created with "+ New rule" could sit active
 * forever while "Fired · 28d" stayed a truthful, permanent `0×`. The rule was
 * armed and nothing ever pulled the trigger.
 *
 * What this may do is deliberately narrow. It reaches no provider: the strongest
 * outcome of a firing is a row in `meta_automation_proposals`, which still needs
 * an operator to approve it before anything is written anywhere. The guards it
 * honours are the ones the rest of this path already honours, in order:
 *
 * 1. The cron's own global admission (`assertSyncLaneEnabled` + the growth
 *    fence) runs before any job in that chain, so it is not restated here —
 *    exactly as `runMetaOutcomeAccrualIfDue` and `runMetaSnapshotJobIfDue` do
 *    not restate it.
 * 2. Schema readiness, so an un-migrated database skips instead of throwing.
 * 3. Per business, `getMetaWriteBlockState` — the same authority the write
 *    guard uses, but only for the reasons that mean automation is off here at
 *    all. A business under the global or business STOP, a demo business, or one
 *    whose control row cannot be read raises no proposals: an operator who
 *    stopped automation did not ask for a queue to come back to, and an
 *    unreadable control state fails closed. A guard rule or a quiet-hours
 *    window is NOT one of those reasons — it says "do not write now", and this
 *    job never writes; the approval that eventually would re-checks it.
 *
 * Every failure is per business and per account. One business whose warehouse
 * read throws must not cost every other business its evaluation.
 */
export async function runMetaAutomationRuleEvaluationIfDue(
  now = new Date(),
): Promise<MetaAutomationRuleEvaluationJobResult> {
  const runDate = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== RULE_EVALUATION_UTC_HOUR) {
    return { skipped: true, reason: "not_due", runDate };
  }

  const readiness = await getDbSchemaReadiness({
    tables: [
      "meta_automation_rules",
      "meta_automation_rule_firings",
      "meta_automation_proposals",
    ],
  }).catch(() => null);
  if (!readiness?.ready) {
    return { skipped: true, reason: "schema_not_ready", runDate };
  }

  const businesses = await getActiveBusinesses();
  const outcomes: MetaAutomationRuleEvaluationBusinessOutcome[] = [];

  for (const business of businesses) {
    const businessId = business.id;

    let rules: AutomationRuleDefinition[];
    try {
      rules = await listAutomationRules(businessId);
    } catch {
      outcomes.push({
        businessId,
        skippedReason: "rules_unreadable",
        accounts: [],
      });
      continue;
    }
    // Cheapest possible exit, and the common one: most businesses have no
    // rules at all, and none of the reads below are worth paying for them.
    if (
      !rules.some(
        (rule) => rule.active && rule.trigger.kind !== "quiet_hours",
      )
    ) {
      outcomes.push({ businessId, skippedReason: "no_rules", accounts: [] });
      continue;
    }

    const writeBlock = await getMetaWriteBlockState({
      businessId,
      at: now,
    }).catch(() => null);
    // "Automation is off here" and "do not write right now" are different
    // answers, and this gate must only honour the first.
    //
    // `automation_guard_rule` covers an enforced guard rule and the persisted
    // quiet-hours window. Both mean the provider must not be written to at this
    // moment — and this job never writes to a provider: its strongest outcome
    // is a proposal an operator still has to approve, and that approval
    // re-checks the same guard at write time via `rejectIfMetaWritesBlocked`.
    //
    // Skipping on it was worse than redundant. The job fires in exactly one UTC
    // hour, so a business whose quiet hours cover that hour would be evaluated
    // on no day at all — silently reproducing the permanently-zero
    // `firedCount` this job exists to fix, visible only as a skip reason buried
    // in the cron receipt.
    const blockedForAutomation =
      !writeBlock || (writeBlock.blocked && writeBlock.reason !== "automation_guard_rule");
    if (blockedForAutomation) {
      outcomes.push({
        businessId,
        skippedReason: "writes_blocked",
        blockReason: writeBlock?.reason ?? "control_state_unavailable",
        accounts: [],
      });
      continue;
    }

    const accountIds = await fetchAssignedAccountIds(businessId).catch(
      () => [] as string[],
    );
    if (accountIds.length === 0) {
      outcomes.push({
        businessId,
        skippedReason: "no_assigned_accounts",
        accounts: [],
      });
      continue;
    }

    const accounts: MetaAutomationRuleEvaluationBusinessOutcome["accounts"] = [];
    for (const providerAccountId of accountIds) {
      try {
        const report = await evaluateBusinessAutomationRules({
          businessId,
          providerAccountId,
          rules,
        });
        accounts.push({
          providerAccountId,
          status: "evaluated",
          ...(report.skippedReason
            ? { skippedReason: report.skippedReason }
            : {}),
          firings: report.recorded.filter((firing) => firing.inserted).length,
        });
      } catch (error) {
        accounts.push({
          providerAccountId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    outcomes.push({ businessId, accounts });
  }

  return { skipped: false, runDate, businesses: outcomes };
}
