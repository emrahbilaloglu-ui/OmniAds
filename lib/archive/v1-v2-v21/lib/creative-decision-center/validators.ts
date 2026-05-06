import {
  CREATIVE_DECISION_CENTER_ACTIONABILITIES,
  CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS,
  CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
  CREATIVE_DECISION_CENTER_CONFIDENCE_BANDS,
  CREATIVE_DECISION_CENTER_IDENTITY_GRAINS,
  CREATIVE_DECISION_CENTER_MATURITY_LEVELS,
  CREATIVE_DECISION_CENTER_PRIORITIES,
  CREATIVE_DECISION_CENTER_PROBLEM_CLASSES,
  CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
  CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
  CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS,
  type CreativeDecisionCenterAggregateDecision,
  type CreativeDecisionCenterRowDecision,
  type CreativeDecisionConfig,
  type CreativeDecisionOsV21Output,
  type DecisionCenterSnapshot,
} from "@/lib/creative-decision-center/contracts";

export interface CreativeDecisionCenterValidationResult {
  ok: boolean;
  errors: string[];
}

type MutableValidationResult = {
  errors: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function includes<T extends readonly string[]>(items: T, value: unknown): value is T[number] {
  return typeof value === "string" && items.includes(value);
}

function add(result: MutableValidationResult, path: string, message: string) {
  result.errors.push(`${path}: ${message}`);
}

function requireString(
  result: MutableValidationResult,
  value: unknown,
  path: string,
) {
  if (typeof value !== "string" || value.trim().length === 0) {
    add(result, path, "expected non-empty string");
  }
}

function requireStringArray(
  result: MutableValidationResult,
  value: unknown,
  path: string,
) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    add(result, path, "expected string array");
  }
}

function requireNumber(
  result: MutableValidationResult,
  value: unknown,
  path: string,
  options: { min?: number; max?: number } = {},
) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    add(result, path, "expected finite number");
    return;
  }
  if (options.min !== undefined && value < options.min) {
    add(result, path, `expected number >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    add(result, path, `expected number <= ${options.max}`);
  }
}

function result(errors: string[]): CreativeDecisionCenterValidationResult {
  return { ok: errors.length === 0, errors };
}

export function validateCreativeDecisionOsV21Output(
  value: unknown,
  path = "engine",
): CreativeDecisionCenterValidationResult {
  const state: MutableValidationResult = { errors: [] };
  if (!isRecord(value)) return result([`${path}: expected object`]);

  if (value.contractVersion !== CREATIVE_DECISION_OS_V21_CONTRACT_VERSION) {
    add(state, `${path}.contractVersion`, "expected creative-decision-os.v2.1");
  }
  requireString(state, value.engineVersion, `${path}.engineVersion`);
  if (!includes(CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS, value.primaryDecision)) {
    add(state, `${path}.primaryDecision`, "invalid primary decision");
  }
  if (!includes(CREATIVE_DECISION_CENTER_ACTIONABILITIES, value.actionability)) {
    add(state, `${path}.actionability`, "invalid actionability");
  }
  if (!includes(CREATIVE_DECISION_CENTER_PROBLEM_CLASSES, value.problemClass)) {
    add(state, `${path}.problemClass`, "invalid problem class");
  }
  requireNumber(state, value.confidence, `${path}.confidence`, { min: 0, max: 100 });
  if (!includes(CREATIVE_DECISION_CENTER_MATURITY_LEVELS, value.maturity)) {
    add(state, `${path}.maturity`, "invalid maturity");
  }
  if (!includes(CREATIVE_DECISION_CENTER_PRIORITIES, value.priority)) {
    add(state, `${path}.priority`, "invalid priority");
  }
  requireStringArray(state, value.reasonTags, `${path}.reasonTags`);
  requireString(state, value.evidenceSummary, `${path}.evidenceSummary`);
  requireStringArray(state, value.blockerReasons, `${path}.blockerReasons`);
  requireStringArray(state, value.missingData, `${path}.missingData`);
  if (value.queueEligible !== false) {
    add(state, `${path}.queueEligible`, "must be false for V2.1 MVP");
  }
  if (value.applyEligible !== false) {
    add(state, `${path}.applyEligible`, "must be false for V2.1 MVP");
  }

  return result(state.errors);
}

export function validateCreativeDecisionCenterRowDecision(
  value: unknown,
  path = "rowDecision",
): CreativeDecisionCenterValidationResult {
  const state: MutableValidationResult = { errors: [] };
  if (!isRecord(value)) return result([`${path}: expected object`]);

  if (value.scope !== "creative") add(state, `${path}.scope`, "expected creative");
  requireString(state, value.creativeId, `${path}.creativeId`);
  if (value.rowId !== undefined && typeof value.rowId !== "string") {
    add(state, `${path}.rowId`, "expected string when present");
  }
  if (!includes(CREATIVE_DECISION_CENTER_IDENTITY_GRAINS, value.identityGrain)) {
    add(state, `${path}.identityGrain`, "invalid identity grain");
  }

  const engineValidation = validateCreativeDecisionOsV21Output(
    value.engine,
    `${path}.engine`,
  );
  state.errors.push(...engineValidation.errors);

  if (!includes(CREATIVE_DECISION_CENTER_BUYER_ACTIONS, value.buyerAction)) {
    add(state, `${path}.buyerAction`, "invalid buyer action");
  }
  if (value.buyerAction === "brief_variation") {
    add(state, `${path}.buyerAction`, "brief_variation is aggregate-only");
  }
  requireString(state, value.buyerLabel, `${path}.buyerLabel`);
  if (!includes(CREATIVE_DECISION_CENTER_BUYER_ACTIONS, value.uiBucket)) {
    add(state, `${path}.uiBucket`, "invalid UI bucket");
  }
  if (!includes(CREATIVE_DECISION_CENTER_CONFIDENCE_BANDS, value.confidenceBand)) {
    add(state, `${path}.confidenceBand`, "invalid confidence band");
  }
  if (!includes(CREATIVE_DECISION_CENTER_PRIORITIES, value.priority)) {
    add(state, `${path}.priority`, "invalid priority");
  }
  requireString(state, value.oneLine, `${path}.oneLine`);
  requireStringArray(state, value.reasons, `${path}.reasons`);
  requireString(state, value.nextStep, `${path}.nextStep`);
  requireStringArray(state, value.missingData, `${path}.missingData`);

  return result(state.errors);
}

export function validateCreativeDecisionCenterAggregateDecision(
  value: unknown,
  path = "aggregateDecision",
): CreativeDecisionCenterValidationResult {
  const state: MutableValidationResult = { errors: [] };
  if (!isRecord(value)) return result([`${path}: expected object`]);

  if (value.scope !== "page" && value.scope !== "family") {
    add(state, `${path}.scope`, "expected page or family");
  }
  if (!includes(CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS, value.action)) {
    add(state, `${path}.action`, "invalid aggregate action");
  }
  if (!includes(CREATIVE_DECISION_CENTER_PRIORITIES, value.priority)) {
    add(state, `${path}.priority`, "invalid priority");
  }
  requireNumber(state, value.confidence, `${path}.confidence`, { min: 0, max: 100 });
  requireString(state, value.oneLine, `${path}.oneLine`);
  requireStringArray(state, value.reasons, `${path}.reasons`);
  requireStringArray(state, value.affectedCreativeIds, `${path}.affectedCreativeIds`);
  requireString(state, value.nextStep, `${path}.nextStep`);
  requireStringArray(state, value.missingData, `${path}.missingData`);

  return result(state.errors);
}

export function validateDecisionCenterSnapshot(
  value: unknown,
): CreativeDecisionCenterValidationResult {
  const state: MutableValidationResult = { errors: [] };
  if (!isRecord(value)) return result(["snapshot: expected object"]);

  if (value.contractVersion !== CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION) {
    add(state, "snapshot.contractVersion", "expected creative-decision-center.v2.1");
  }
  requireString(state, value.engineVersion, "snapshot.engineVersion");
  requireString(state, value.adapterVersion, "snapshot.adapterVersion");
  requireString(state, value.configVersion, "snapshot.configVersion");
  requireString(state, value.generatedAt, "snapshot.generatedAt");

  const freshness = value.dataFreshness;
  if (!isRecord(freshness)) {
    add(state, "snapshot.dataFreshness", "expected object");
  } else if (!["fresh", "stale", "unknown"].includes(String(freshness.status))) {
    add(state, "snapshot.dataFreshness.status", "invalid freshness status");
  }

  if (!isRecord(value.inputCoverageSummary)) {
    add(state, "snapshot.inputCoverageSummary", "expected record");
  }
  if (!isRecord(value.missingDataSummary)) {
    add(state, "snapshot.missingDataSummary", "expected record");
  }
  if (!Array.isArray(value.todayBrief)) {
    add(state, "snapshot.todayBrief", "expected array");
  }
  if (!isRecord(value.actionBoard)) {
    add(state, "snapshot.actionBoard", "expected record");
  }

  if (!Array.isArray(value.rowDecisions)) {
    add(state, "snapshot.rowDecisions", "expected array");
  } else {
    value.rowDecisions.forEach((row, index) => {
      state.errors.push(
        ...validateCreativeDecisionCenterRowDecision(
          row,
          `snapshot.rowDecisions.${index}`,
        ).errors,
      );
    });
  }

  if (!Array.isArray(value.aggregateDecisions)) {
    add(state, "snapshot.aggregateDecisions", "expected array");
  } else {
    value.aggregateDecisions.forEach((aggregate, index) => {
      state.errors.push(
        ...validateCreativeDecisionCenterAggregateDecision(
          aggregate,
          `snapshot.aggregateDecisions.${index}`,
        ).errors,
      );
    });
  }

  return result(state.errors);
}

export function validateCreativeDecisionConfig(
  value: unknown,
): CreativeDecisionCenterValidationResult {
  const state: MutableValidationResult = { errors: [] };
  if (!isRecord(value)) return result(["config: expected object"]);

  requireString(state, value.configVersion, "config.configVersion");
  for (const key of [
    "launchWindowHours",
    "noSpendWindowHours",
    "minSpendForMaturityMultiplier",
    "minPurchasesForScale",
    "minImpressionsForCtrReliability",
    "fatigueCtrDropPct",
    "fatigueCpmIncreasePct",
    "fatigueFrequencyIncreasePct",
    "maxCpaOverTargetForCut",
    "minRoasOverTargetForScale",
    "winnerGapDays",
    "fatigueClusterTopN",
    "staleDataHours",
    "minConfidenceForScale",
    "minConfidenceForCut",
  ] satisfies Array<keyof CreativeDecisionConfig>) {
    requireNumber(state, value[key], `config.${key}`, { min: 0 });
  }
  if (!["strong", "medium", "weak"].includes(String(value.benchmarkReliabilityMinimum))) {
    add(
      state,
      "config.benchmarkReliabilityMinimum",
      "expected strong, medium, or weak",
    );
  }

  return result(state.errors);
}

export type {
  CreativeDecisionCenterAggregateDecision,
  CreativeDecisionCenterRowDecision,
  CreativeDecisionConfig,
  CreativeDecisionOsV21Output,
  DecisionCenterSnapshot,
};
