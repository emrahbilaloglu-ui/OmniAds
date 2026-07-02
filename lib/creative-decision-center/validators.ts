import {
  CREATIVE_DECISION_CENTER_ACTIONABILITIES,
  CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS,
  CREATIVE_DECISION_CENTER_BENCHMARK_RELIABILITY_MINIMUMS,
  CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
  CREATIVE_DECISION_CENTER_CONFIDENCE_BANDS,
  CREATIVE_DECISION_CENTER_EXECUTION_ACTIONS,
  CREATIVE_DECISION_CENTER_FRESHNESS_STATUSES,
  CREATIVE_DECISION_CENTER_IDENTITY_GRAINS,
  CREATIVE_DECISION_CENTER_MATURITY_LEVELS,
  CREATIVE_DECISION_CENTER_PRIORITIES,
  CREATIVE_DECISION_CENTER_PROBLEM_CLASSES,
  CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
  CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
  CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS,
  type CreativeDecisionConfig,
  type CreativeDecisionCenterBuyerAction,
} from "./contracts";

export interface CreativeDecisionCenterValidationResult {
  ok: boolean;
  errors: string[];
}

type ValidationState = {
  errors: string[];
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function includes<T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function add(state: ValidationState, path: string, code: string) {
  state.errors.push(`${path}:${code}`);
}

function result(errors: string[]): CreativeDecisionCenterValidationResult {
  return { ok: errors.length === 0, errors };
}

function requireKey(state: ValidationState, value: RecordValue, key: string, path: string) {
  if (!hasOwn(value, key)) add(state, `${path}.${key}`, "missing_key");
}

function requireString(
  state: ValidationState,
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean } = {},
) {
  if (typeof value !== "string") {
    add(state, path, "invalid_type:expected_string");
    return;
  }
  if (!options.allowEmpty && value.trim().length === 0) {
    add(state, path, "empty_string");
  }
}

function requireStringArray(state: ValidationState, value: unknown, path: string) {
  if (!Array.isArray(value)) {
    add(state, path, "invalid_type:expected_string_array");
    return;
  }
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      add(state, `${path}.${index}`, "invalid_type:expected_string");
    }
  });
}

function requireNumber(state: ValidationState, value: unknown, path: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    add(state, path, "invalid_type:expected_finite_number");
  }
}

function requireLiteral<T extends readonly string[]>(
  state: ValidationState,
  values: T,
  value: unknown,
  path: string,
) {
  if (!includes(values, value)) {
    add(state, path, `invalid_literal:${String(value)}`);
  }
}

function requireRecordOfNumbers(state: ValidationState, value: unknown, path: string) {
  if (!isRecord(value)) {
    add(state, path, "invalid_type:expected_number_record");
    return;
  }
  for (const [key, recordValue] of Object.entries(value)) {
    requireNumber(state, recordValue, `${path}.${key}`);
  }
}

function validateDataFreshness(state: ValidationState, value: unknown, path: string) {
  if (!isRecord(value)) {
    add(state, path, "invalid_type:expected_object");
    return;
  }
  requireKey(state, value, "status", path);
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_FRESHNESS_STATUSES,
    value.status,
    `${path}.status`,
  );
  if (hasOwn(value, "maxAgeHours") && value.maxAgeHours !== null) {
    requireNumber(state, value.maxAgeHours, `${path}.maxAgeHours`);
  }
  if (
    hasOwn(value, "latestSnapshotAsOf") &&
    value.latestSnapshotAsOf !== null
  ) {
    requireString(
      state,
      value.latestSnapshotAsOf,
      `${path}.latestSnapshotAsOf`,
    );
  }
  if (
    hasOwn(value, "snapshotAgeHours") &&
    value.snapshotAgeHours !== null
  ) {
    requireNumber(state, value.snapshotAgeHours, `${path}.snapshotAgeHours`);
  }
}

export function validateCreativeDecisionOsV21Output(
  value: unknown,
  path = "engine",
): CreativeDecisionCenterValidationResult {
  const state: ValidationState = { errors: [] };
  if (!isRecord(value)) return result([`${path}:invalid_type:expected_object`]);

  for (const key of [
    "contractVersion",
    "engineVersion",
    "primaryDecision",
    "actionability",
    "problemClass",
    "confidence",
    "maturity",
    "priority",
    "reasonTags",
    "evidenceSummary",
    "blockerReasons",
    "missingData",
    "queueEligible",
    "applyEligible",
  ]) {
    requireKey(state, value, key, path);
  }

  if (value.contractVersion !== CREATIVE_DECISION_OS_V21_CONTRACT_VERSION) {
    add(state, `${path}.contractVersion`, "invalid_contract_version");
  }
  requireString(state, value.engineVersion, `${path}.engineVersion`);
  requireLiteral(
    state,
    CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS,
    value.primaryDecision,
    `${path}.primaryDecision`,
  );
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_ACTIONABILITIES,
    value.actionability,
    `${path}.actionability`,
  );
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_PROBLEM_CLASSES,
    value.problemClass,
    `${path}.problemClass`,
  );
  requireNumber(state, value.confidence, `${path}.confidence`);
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_MATURITY_LEVELS,
    value.maturity,
    `${path}.maturity`,
  );
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_PRIORITIES,
    value.priority,
    `${path}.priority`,
  );
  requireStringArray(state, value.reasonTags, `${path}.reasonTags`);
  requireString(state, value.evidenceSummary, `${path}.evidenceSummary`);
  requireStringArray(state, value.blockerReasons, `${path}.blockerReasons`);
  requireStringArray(state, value.missingData, `${path}.missingData`);
  if (value.queueEligible !== false) {
    add(state, `${path}.queueEligible`, "eligibility_flag_must_be_false");
  }
  if (value.applyEligible !== false) {
    add(state, `${path}.applyEligible`, "eligibility_flag_must_be_false");
  }

  return result(state.errors);
}

export function validateCreativeDecisionCenterRowDecision(
  value: unknown,
  path = "rowDecision",
): CreativeDecisionCenterValidationResult {
  const state: ValidationState = { errors: [] };
  if (!isRecord(value)) return result([`${path}:invalid_type:expected_object`]);

  for (const key of [
    "scope",
    "creativeId",
    "identityGrain",
    "engine",
    "buyerAction",
    "buyerLabel",
    "uiBucket",
    "confidenceBand",
    "priority",
    "oneLine",
    "reasons",
    "nextStep",
    "missingData",
  ]) {
    requireKey(state, value, key, path);
  }

  if (value.scope !== "creative") add(state, `${path}.scope`, "invalid_literal");
  requireString(state, value.creativeId, `${path}.creativeId`);
  if (hasOwn(value, "rowId") && value.rowId !== undefined) {
    requireString(state, value.rowId, `${path}.rowId`);
  }
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_IDENTITY_GRAINS,
    value.identityGrain,
    `${path}.identityGrain`,
  );
  if (hasOwn(value, "familyId") && value.familyId !== null && value.familyId !== undefined) {
    requireString(state, value.familyId, `${path}.familyId`);
  }
  state.errors.push(
    ...validateCreativeDecisionOsV21Output(value.engine, `${path}.engine`).errors,
  );
  if (value.buyerAction === "brief_variation") {
    add(state, `${path}.buyerAction`, "aggregate_only:brief_variation");
  }
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
    value.buyerAction,
    `${path}.buyerAction`,
  );
  requireString(state, value.buyerLabel, `${path}.buyerLabel`);
  if (value.uiBucket === "brief_variation") {
    add(state, `${path}.uiBucket`, "aggregate_only:brief_variation");
  }
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
    value.uiBucket,
    `${path}.uiBucket`,
  );
  if (
    hasOwn(value, "executionAction") &&
    value.executionAction !== null &&
    value.executionAction !== undefined
  ) {
    requireLiteral(
      state,
      CREATIVE_DECISION_CENTER_EXECUTION_ACTIONS,
      value.executionAction,
      `${path}.executionAction`,
    );
  }
  if (
    hasOwn(value, "sourceDecision") &&
    value.sourceDecision !== null &&
    value.sourceDecision !== undefined
  ) {
    requireString(state, value.sourceDecision, `${path}.sourceDecision`);
  }
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_CONFIDENCE_BANDS,
    value.confidenceBand,
    `${path}.confidenceBand`,
  );
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_PRIORITIES,
    value.priority,
    `${path}.priority`,
  );
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
  const state: ValidationState = { errors: [] };
  if (!isRecord(value)) return result([`${path}:invalid_type:expected_object`]);

  for (const key of [
    "scope",
    "action",
    "priority",
    "confidence",
    "oneLine",
    "reasons",
    "affectedCreativeIds",
    "nextStep",
    "missingData",
  ]) {
    requireKey(state, value, key, path);
  }

  if (value.scope !== "page" && value.scope !== "family") {
    add(state, `${path}.scope`, "invalid_literal");
  }
  if (hasOwn(value, "familyId") && value.familyId !== null && value.familyId !== undefined) {
    requireString(state, value.familyId, `${path}.familyId`);
  }
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS,
    value.action,
    `${path}.action`,
  );
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_PRIORITIES,
    value.priority,
    `${path}.priority`,
  );
  requireNumber(state, value.confidence, `${path}.confidence`);
  requireString(state, value.oneLine, `${path}.oneLine`);
  requireStringArray(state, value.reasons, `${path}.reasons`);
  requireStringArray(state, value.affectedCreativeIds, `${path}.affectedCreativeIds`);
  requireString(state, value.nextStep, `${path}.nextStep`);
  requireStringArray(state, value.missingData, `${path}.missingData`);

  return result(state.errors);
}

function validateActionBoard(state: ValidationState, value: unknown, path: string) {
  if (!isRecord(value)) {
    add(state, path, "invalid_type:expected_action_board");
    return;
  }
  for (const action of CREATIVE_DECISION_CENTER_BUYER_ACTIONS) {
    if (!hasOwn(value, action)) {
      add(state, `${path}.${action}`, "missing_key");
      continue;
    }
    requireStringArray(state, value[action], `${path}.${action}`);
  }
}

function validateTodayBrief(state: ValidationState, value: unknown, path: string) {
  if (!Array.isArray(value)) {
    add(state, path, "invalid_type:expected_array");
    return;
  }
  value.forEach((item, index) => {
    const itemPath = `${path}.${index}`;
    if (!isRecord(item)) {
      add(state, itemPath, "invalid_type:expected_object");
      return;
    }
    for (const key of ["id", "priority", "text", "rowIds"]) {
      requireKey(state, item, key, itemPath);
    }
    requireString(state, item.id, `${itemPath}.id`);
    requireLiteral(
      state,
      CREATIVE_DECISION_CENTER_PRIORITIES,
      item.priority,
      `${itemPath}.priority`,
    );
    requireString(state, item.text, `${itemPath}.text`);
    requireStringArray(state, item.rowIds, `${itemPath}.rowIds`);
    if (hasOwn(item, "aggregateIds")) {
      requireStringArray(state, item.aggregateIds, `${itemPath}.aggregateIds`);
    }
  });
}

export function validateDecisionCenterSnapshot(
  value: unknown,
  path = "snapshot",
): CreativeDecisionCenterValidationResult {
  const state: ValidationState = { errors: [] };
  if (!isRecord(value)) return result([`${path}:invalid_type:expected_object`]);

  for (const key of [
    "contractVersion",
    "engineVersion",
    "adapterVersion",
    "configVersion",
    "generatedAt",
    "dataFreshness",
    "inputCoverageSummary",
    "missingDataSummary",
    "todayBrief",
    "actionBoard",
    "rowDecisions",
    "aggregateDecisions",
  ]) {
    requireKey(state, value, key, path);
  }

  if (value.contractVersion !== CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION) {
    add(state, `${path}.contractVersion`, "invalid_contract_version");
  }
  requireString(state, value.engineVersion, `${path}.engineVersion`);
  requireString(state, value.adapterVersion, `${path}.adapterVersion`);
  requireString(state, value.configVersion, `${path}.configVersion`);
  requireString(state, value.generatedAt, `${path}.generatedAt`);
  validateDataFreshness(state, value.dataFreshness, `${path}.dataFreshness`);
  requireRecordOfNumbers(state, value.inputCoverageSummary, `${path}.inputCoverageSummary`);
  requireRecordOfNumbers(state, value.missingDataSummary, `${path}.missingDataSummary`);
  validateTodayBrief(state, value.todayBrief, `${path}.todayBrief`);
  validateActionBoard(state, value.actionBoard, `${path}.actionBoard`);

  if (!Array.isArray(value.rowDecisions)) {
    add(state, `${path}.rowDecisions`, "invalid_type:expected_array");
  } else {
    value.rowDecisions.forEach((row, index) => {
      state.errors.push(
        ...validateCreativeDecisionCenterRowDecision(
          row,
          `${path}.rowDecisions.${index}`,
        ).errors,
      );
    });
  }

  if (!Array.isArray(value.aggregateDecisions)) {
    add(state, `${path}.aggregateDecisions`, "invalid_type:expected_array");
  } else {
    value.aggregateDecisions.forEach((aggregate, index) => {
      state.errors.push(
        ...validateCreativeDecisionCenterAggregateDecision(
          aggregate,
          `${path}.aggregateDecisions.${index}`,
        ).errors,
      );
    });
  }

  return result(state.errors);
}

export function validateBuyerActionMappingRule(
  value: unknown,
  path = "mappingRule",
): CreativeDecisionCenterValidationResult {
  const state: ValidationState = { errors: [] };
  if (!isRecord(value)) return result([`${path}:invalid_type:expected_object`]);

  for (const key of ["id", "when", "output"]) {
    requireKey(state, value, key, path);
  }
  requireString(state, value.id, `${path}.id`);
  if (!isRecord(value.when)) {
    add(state, `${path}.when`, "invalid_type:expected_object");
  } else {
    if (hasOwn(value.when, "primaryDecision")) {
      requireLiteral(
        state,
        CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS,
        value.when.primaryDecision,
        `${path}.when.primaryDecision`,
      );
    }
    if (hasOwn(value.when, "problemClass")) {
      requireLiteral(
        state,
        CREATIVE_DECISION_CENTER_PROBLEM_CLASSES,
        value.when.problemClass,
        `${path}.when.problemClass`,
      );
    }
    if (hasOwn(value.when, "reasonTagsAny")) {
      requireStringArray(state, value.when.reasonTagsAny, `${path}.when.reasonTagsAny`);
    }
    if (hasOwn(value.when, "actionability")) {
      requireLiteral(
        state,
        CREATIVE_DECISION_CENTER_ACTIONABILITIES,
        value.when.actionability,
        `${path}.when.actionability`,
      );
    }
    if (hasOwn(value.when, "requiredData")) {
      requireStringArray(state, value.when.requiredData, `${path}.when.requiredData`);
    }
    if (hasOwn(value.when, "blockersAbsent")) {
      requireStringArray(state, value.when.blockersAbsent, `${path}.when.blockersAbsent`);
    }
  }
  if (!isRecord(value.output)) {
    add(state, `${path}.output`, "invalid_type:expected_object");
  } else {
    for (const key of ["buyerAction", "buyerLabel", "uiBucket", "nextStepTemplate"]) {
      requireKey(state, value.output, key, `${path}.output`);
    }
    requireLiteral(
      state,
      CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
      value.output.buyerAction,
      `${path}.output.buyerAction`,
    );
    requireString(state, value.output.buyerLabel, `${path}.output.buyerLabel`);
    requireLiteral(
      state,
      CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
      value.output.uiBucket,
      `${path}.output.uiBucket`,
    );
    if (
      hasOwn(value.output, "executionAction") &&
      value.output.executionAction !== null &&
      value.output.executionAction !== undefined
    ) {
      requireLiteral(
        state,
        CREATIVE_DECISION_CENTER_EXECUTION_ACTIONS,
        value.output.executionAction,
        `${path}.output.executionAction`,
      );
    }
    requireString(state, value.output.nextStepTemplate, `${path}.output.nextStepTemplate`);
  }

  return result(state.errors);
}

export function validateCreativeDecisionConfig(
  value: unknown,
  path = "config",
): CreativeDecisionCenterValidationResult {
  const state: ValidationState = { errors: [] };
  if (!isRecord(value)) return result([`${path}:invalid_type:expected_object`]);

  requireKey(state, value, "configVersion", path);
  requireString(state, value.configVersion, `${path}.configVersion`);

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
    requireKey(state, value, key, path);
    requireNumber(state, value[key], `${path}.${key}`);
  }
  requireKey(state, value, "benchmarkReliabilityMinimum", path);
  requireLiteral(
    state,
    CREATIVE_DECISION_CENTER_BENCHMARK_RELIABILITY_MINIMUMS,
    value.benchmarkReliabilityMinimum,
    `${path}.benchmarkReliabilityMinimum`,
  );

  return result(state.errors);
}

export function createEmptyActionBoard(): Record<CreativeDecisionCenterBuyerAction, string[]> {
  return {
    scale: [],
    cut: [],
    refresh: [],
    protect: [],
    test_more: [],
    watch_launch: [],
    fix_delivery: [],
    fix_policy: [],
    diagnose_data: [],
  };
}
