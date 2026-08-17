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
    | null;
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
    "asOfDate" | "evaluation" | "recorded" | "skippedReason"
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
    };
  }

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
    };
  }

  const evaluation = evaluateAutomationRules({
    rules: evaluableRules,
    anchors,
    entities,
    asOfDate,
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
  };
}
