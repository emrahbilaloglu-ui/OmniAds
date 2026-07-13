import { createHash } from "node:crypto";

import { getDb, runDbTransaction } from "@/lib/db";

export const CONTROLLED_EXPERIMENT_VERSION = "meta-controlled-experiment.v2";
export const CONTROLLED_ARM_VERSION = "meta-controlled-experiment-arm.v2";
export const CONTROLLED_BATCH_VERSION = "meta-controlled-assignment-batch.v2";
export const CONTROLLED_ASSIGNMENT_VERSION =
  "meta-controlled-random-assignment.v2";
export const CONTROLLED_SEED_REVEAL_VERSION = "meta-controlled-seed-reveal.v1";
export const CONTROLLED_OBSERVATION_VERSION =
  "meta-controlled-control-outcome-observation.v1";
export const CONTROLLED_ESTIMATE_VERSION =
  "meta-controlled-control-estimate.v2";
export const CONTROLLED_HYDRATION_VERSION =
  "meta-controlled-evidence-hydration.v2";
export const CONTROLLED_CAUSAL_DESIGN_VERSION =
  "meta-controlled-causal-design.v2";
export const CONTROLLED_TREATMENT_RECEIPT_VERSION = "meta-treatment-receipt.v2";
export const CONTROLLED_PROVIDER_VERIFICATION_VERSION =
  "meta-provider-verification.v1";
export const CONTROLLED_SOURCE_RECEIPT_VERSION =
  "meta-controlled-source-receipt.v1";
export const CONTROLLED_EVIDENCE_CLASS = "controlled_causal";
export const CONTROLLED_RANDOMIZATION_ALGORITHM = "sha256-threshold-v1";

export type ControlledEntityType = "ad" | "adset" | "campaign";
export type ControlledArmRole = "control" | "treatment";
export type ControlledMetricDirection = "increase" | "decrease";
export type ControlledTerminalOutcome = "positive" | "negative" | "neutral";
export type ControlledMetricName =
  "outcome_roas" | "outcome_revenue" | "outcome_purchases" | "outcome_spend";

export interface ControlledEntityTarget {
  entityType: ControlledEntityType;
  entityId: string;
}

export interface ControlledEligibilityEntry {
  assignmentId: string;
  recommendationFingerprint: string;
  recId: string;
  evaluationId: string;
  snapshotId: string;
  target: ControlledEntityTarget;
}

export interface ControlledArmInput {
  armId: string;
  role: ControlledArmRole;
  allocationOrder: number;
  assignmentProbability: number;
  treatmentAction: string | null;
}

export interface PreregisterControlledExperimentInput {
  experimentId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  name: string;
  hypothesis: string;
  primaryMetric: ControlledMetricName;
  metricDirection: ControlledMetricDirection;
  randomizationUnit: ControlledEntityType;
  seedCommitmentHash: string;
  startsAt: string;
  outcomeWindowStartAt: string;
  outcomeWindowEndAt: string;
  endsAt: string;
  eligibilityManifest: readonly ControlledEligibilityEntry[];
  arms: readonly ControlledArmInput[];
}

export interface CreateControlledAssignmentBatchInput {
  batchId: string;
  experimentId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  randomizationSeed: string;
  eligibilityManifest: readonly ControlledEligibilityEntry[];
}

export interface FinalizeControlledSeedRevealInput {
  batchId: string;
  experimentId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  randomizationSeed: string;
}

export interface FinalizeControlledEstimateInput {
  estimateId: string;
  experimentId: string;
  batchId: string;
  treatedAssignmentId: string;
  treatedOutcomeLogId: string;
  treatedNativeOutcomeId: string;
  treatmentActionLogId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
}

export interface MaterializeControlledControlObservationsInput {
  experimentId: string;
  batchId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
}

export interface ReadControlledEvidenceInput {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  recTypes: readonly string[];
  outcomeLogIds?: readonly string[];
  limit?: number;
}

export interface ControlledArmRecord {
  armId: string;
  role: ControlledArmRole;
  allocationOrder: number;
  assignmentProbability: number;
  treatmentAction: string | null;
  armHash: string;
}

export interface ControlledExperimentRecord {
  experimentId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  primaryMetric: ControlledMetricName;
  metricDirection: ControlledMetricDirection;
  randomizationUnit: ControlledEntityType;
  seedCommitmentHash: string;
  eligibilityCount: number;
  eligibilityHash: string;
  assignmentManifestHash: string;
  startsAt: string;
  outcomeWindowStartAt: string;
  outcomeWindowEndAt: string;
  endsAt: string;
  registrationHash: string;
  preregisteredAt: string;
  arms: ControlledArmRecord[];
}

export interface ControlledAssignmentRecord extends ControlledEligibilityEntry {
  experimentId: string;
  batchId: string;
  armId: string;
  armRole: ControlledArmRole;
  assignedAction: string | null;
  assignmentProbability: number;
  randomizationDraw: number;
  randomizationProofHash: string;
  assignmentHash: string;
  assignedAt: string;
}

export interface ControlledAssignmentBatchRecord {
  batchId: string;
  experimentId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  eligibilityCount: number;
  eligibilityHash: string;
  assignmentManifestHash: string;
  batchHash: string;
  assignedAt: string;
  assignments: ControlledAssignmentRecord[];
}

export interface ControlledSeedRevealRecord {
  batchId: string;
  experimentId: string;
  seedHash: string;
  revealHash: string;
  revealedAt: string;
}

export interface FinalizedControlledEstimateRecord {
  estimateId: string;
  experimentId: string;
  batchId: string;
  treatedAssignmentId: string;
  treatedOutcomeLogId: string;
  treatedNativeOutcomeId: string;
  treatedNativeOutcomeSourceManifestHash: string;
  treatedMetricValue: string;
  treatmentActionLogId: string;
  controlArmId: string;
  metricName: string;
  metricDirection: ControlledMetricDirection;
  windowStartAt: string;
  windowEndAt: string;
  observationIds: string[];
  observationCount: number;
  sourceManifestHash: string;
  asOf: string;
  value: string;
  sampleSize: number;
  variance: string | null;
  standardError: string | null;
  confidence95Lower: string | null;
  confidence95Upper: string | null;
  estimateHash: string;
  finalizedAt: string;
}

export interface ControlledControlObservationRecord {
  observationId: string;
  experimentId: string;
  batchId: string;
  controlAssignmentId: string;
  nativeOutcomeId: string;
  metricName: ControlledMetricName;
  metricDirection: ControlledMetricDirection;
  windowStartAt: string;
  windowEndAt: string;
  metricValue: string;
  nativeOutcomeSourceManifestHash: string;
  nativeOutcomeComputedAt: string;
  observationHash: string;
  finalizedAt: string;
}

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class ControlledRegistryValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlledRegistryValidationError";
  }
}

export class ControlledRegistryConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControlledRegistryConflictError";
  }
}

export interface ControlledRegistryCapabilities {
  ready: boolean;
  issues: string[];
}

export class ControlledRegistrySchemaError extends Error {
  readonly code = "controlled_registry_schema_unavailable";

  constructor(readonly capabilities: ControlledRegistryCapabilities) {
    super("Controlled evidence schema capabilities are incomplete.");
    this.name = "ControlledRegistrySchemaError";
  }
}

function canonicalize(
  value: unknown,
  path = "$",
  active = new WeakSet<object>(),
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ControlledRegistryValidationError(
        "non_finite_number",
        `${path} contains a non-finite number.`,
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new ControlledRegistryValidationError(
      "non_json_value",
      `${path} is not canonical JSON.`,
    );
  }
  if (active.has(value)) {
    throw new ControlledRegistryValidationError(
      "cyclic_json",
      `${path} contains a cycle.`,
    );
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        canonicalize(entry, `${path}[${index}]`, active),
      );
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) {
        throw new ControlledRegistryValidationError(
          "undefined_json_value",
          `${path}.${key} is undefined.`,
        );
      }
      output[key] = canonicalize(entry, `${path}.${key}`, active);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

export function stableControlledJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function controlledSha256(value: unknown) {
  return createHash("sha256")
    .update(stableControlledJson(value), "utf8")
    .digest("hex");
}

function requiredString(value: unknown, field: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new ControlledRegistryValidationError(
      "missing_required_field",
      `${field} is required.`,
    );
  }
  return normalized;
}

function requiredUuid(value: unknown, field: string) {
  const normalized = requiredString(value, field).toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      normalized,
    )
  ) {
    throw new ControlledRegistryValidationError(
      "invalid_uuid",
      `${field} must be a UUID.`,
    );
  }
  return normalized;
}

function requiredHash(value: unknown, field: string) {
  const normalized = requiredString(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new ControlledRegistryValidationError(
      "invalid_sha256",
      `${field} must be lowercase SHA-256 hex.`,
    );
  }
  return normalized;
}

function requiredTimestamp(value: unknown, field: string) {
  const normalized = requiredString(value, field);
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new ControlledRegistryValidationError(
      "invalid_timestamp",
      `${field} must be a valid timestamp.`,
    );
  }
  return parsed.toISOString();
}

function requiredEntityType(
  value: unknown,
  field: string,
): ControlledEntityType {
  if (value === "ad" || value === "adset" || value === "campaign") return value;
  throw new ControlledRegistryValidationError(
    "invalid_entity_type",
    `${field} must be ad, adset, or campaign.`,
  );
}

function requiredDirection(
  value: unknown,
  field: string,
): ControlledMetricDirection {
  if (value === "increase" || value === "decrease") return value;
  throw new ControlledRegistryValidationError(
    "invalid_metric_direction",
    `${field} must be increase or decrease.`,
  );
}

const CONTROLLED_METRIC_NAMES = new Set<ControlledMetricName>([
  "outcome_roas",
  "outcome_revenue",
  "outcome_purchases",
  "outcome_spend",
]);

function requiredMetricName(
  value: unknown,
  field: string,
): ControlledMetricName {
  const normalized = requiredString(value, field) as ControlledMetricName;
  if (CONTROLLED_METRIC_NAMES.has(normalized)) return normalized;
  throw new ControlledRegistryValidationError(
    "unsupported_controlled_metric",
    `${field} must be an immutable native outcome metric.`,
  );
}

function normalizeManifest(manifest: readonly ControlledEligibilityEntry[]) {
  if (manifest.length === 0) {
    throw new ControlledRegistryValidationError(
      "empty_eligibility_manifest",
      "eligibilityManifest must contain every eligible target.",
    );
  }
  const assignmentIds = new Set<string>();
  const targets = new Set<string>();
  const recommendationIds = new Set<string>();
  const normalized = manifest.map((entry, index) => {
    const result: ControlledEligibilityEntry = {
      assignmentId: requiredString(
        entry.assignmentId,
        `eligibilityManifest[${index}].assignmentId`,
      ),
      recommendationFingerprint: requiredString(
        entry.recommendationFingerprint,
        `eligibilityManifest[${index}].recommendationFingerprint`,
      ),
      recId: requiredString(entry.recId, `eligibilityManifest[${index}].recId`),
      evaluationId: requiredUuid(
        entry.evaluationId,
        `eligibilityManifest[${index}].evaluationId`,
      ),
      snapshotId: requiredUuid(
        entry.snapshotId,
        `eligibilityManifest[${index}].snapshotId`,
      ),
      target: {
        entityType: requiredEntityType(
          entry.target.entityType,
          `eligibilityManifest[${index}].target.entityType`,
        ),
        entityId: requiredString(
          entry.target.entityId,
          `eligibilityManifest[${index}].target.entityId`,
        ),
      },
    };
    if (result.target.entityType !== "ad") {
      throw new ControlledRegistryValidationError(
        "unsupported_controlled_randomization_unit",
        "Controlled authority is currently available only for native ad decisions.",
      );
    }
    const targetKey = `${result.target.entityType}\u001f${result.target.entityId}`;
    const recKey = `${result.recommendationFingerprint}\u001f${result.recId}`;
    if (
      assignmentIds.has(result.assignmentId) ||
      targets.has(targetKey) ||
      recommendationIds.has(recKey)
    ) {
      throw new ControlledRegistryValidationError(
        "duplicate_eligibility_identity",
        "Assignment, target, and recommendation identities must be unique.",
      );
    }
    assignmentIds.add(result.assignmentId);
    targets.add(targetKey);
    recommendationIds.add(recKey);
    return result;
  });
  return normalized.sort((left, right) => {
    const leftKey = `${left.target.entityType}\u001f${left.target.entityId}\u001f${left.assignmentId}`;
    const rightKey = `${right.target.entityType}\u001f${right.target.entityId}\u001f${right.assignmentId}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function buildEligibilityContract(
  manifest: readonly ControlledEligibilityEntry[],
) {
  const normalizedManifest = normalizeManifest(manifest);
  const eligibilityLines = normalizedManifest.map(
    (entry) => `${entry.target.entityType}\u001f${entry.target.entityId}`,
  );
  const manifestLines = normalizedManifest.map((entry) =>
    [
      entry.assignmentId,
      entry.recommendationFingerprint,
      entry.recId,
      entry.evaluationId,
      entry.snapshotId,
      entry.target.entityType,
      entry.target.entityId,
    ].join("\u001f"),
  );
  return {
    manifest: normalizedManifest,
    eligibilityCount: normalizedManifest.length,
    eligibilityHash: hashLines(eligibilityLines),
    assignmentManifestHash: hashLines(manifestLines),
  };
}

export function buildSeedCommitment(input: {
  experimentId: string;
  seed: string;
}) {
  const seed = requiredString(input.seed, "seed");
  if (Buffer.byteLength(seed, "utf8") < 32) {
    throw new ControlledRegistryValidationError(
      "weak_randomization_seed",
      "seed must contain at least 32 UTF-8 bytes.",
    );
  }
  return hashParts([
    CONTROLLED_EXPERIMENT_VERSION,
    requiredString(input.experimentId, "experimentId"),
    seed,
  ]);
}

function normalizeArms(
  experimentId: string,
  arms: readonly ControlledArmInput[],
) {
  if (arms.length < 2) {
    throw new ControlledRegistryValidationError(
      "insufficient_arms",
      "Exactly one control and at least one treatment arm are required.",
    );
  }
  const ids = new Set<string>();
  const orders = new Set<number>();
  const normalized = arms.map((arm, index) => {
    const armId = requiredString(arm.armId, `arms[${index}].armId`);
    if (ids.has(armId) || orders.has(arm.allocationOrder)) {
      throw new ControlledRegistryValidationError(
        "duplicate_arm_identity",
        "Arm IDs and allocation orders must be unique.",
      );
    }
    ids.add(armId);
    orders.add(arm.allocationOrder);
    if (
      (arm.role !== "control" && arm.role !== "treatment") ||
      !Number.isInteger(arm.allocationOrder) ||
      arm.allocationOrder < 0 ||
      !Number.isFinite(arm.assignmentProbability) ||
      arm.assignmentProbability <= 0 ||
      arm.assignmentProbability > 1
    ) {
      throw new ControlledRegistryValidationError(
        "invalid_arm",
        `arms[${index}] is invalid.`,
      );
    }
    const treatmentAction = arm.treatmentAction?.trim() || null;
    if (
      (arm.role === "control" && treatmentAction !== null) ||
      (arm.role === "treatment" &&
        !["pause", "resume"].includes(treatmentAction ?? ""))
    ) {
      throw new ControlledRegistryValidationError(
        "invalid_arm_action",
        "Control arms have no action; native-ad treatments require pause or resume.",
      );
    }
    const hashInput = {
      contractVersion: CONTROLLED_ARM_VERSION,
      experimentId,
      armId,
      role: arm.role,
      allocationOrder: arm.allocationOrder,
      assignmentProbability: arm.assignmentProbability,
      treatmentAction,
    };
    return { ...hashInput, armHash: controlledSha256(hashInput) };
  });
  normalized.sort(
    (left, right) => left.allocationOrder - right.allocationOrder,
  );
  if (
    normalized.filter((arm) => arm.role === "control").length !== 1 ||
    normalized.some((arm, index) => arm.allocationOrder !== index) ||
    Math.abs(
      normalized.reduce((sum, arm) => sum + arm.assignmentProbability, 0) - 1,
    ) > 1e-12
  ) {
    throw new ControlledRegistryValidationError(
      "invalid_arm_allocation",
      "Arms require one control, contiguous order, and total probability 1.",
    );
  }
  return normalized;
}

function randomization(input: {
  experimentId: string;
  businessId: string;
  providerAccountId: string;
  target: ControlledEntityTarget;
  seed: string;
}) {
  const material = stableControlledJson({
    algorithm: CONTROLLED_RANDOMIZATION_ALGORITHM,
    experimentId: input.experimentId,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    target: input.target,
    seed: input.seed,
  });
  const digest = createHash("sha256").update(material, "utf8").digest();
  return {
    draw: digest.readUIntBE(0, 6) / 281_474_976_710_656,
    proofHash: digest.toString("hex"),
  };
}

function chooseArm(arms: ControlledArmRecord[], draw: number) {
  let cumulative = 0;
  for (const arm of arms) {
    cumulative += arm.assignmentProbability;
    if (draw < cumulative) return arm;
  }
  return arms.at(-1)!;
}

function assignmentHash(input: Omit<ControlledAssignmentRecord, "assignedAt">) {
  return controlledSha256(input);
}

export function buildControlObservationHash(input: {
  observationId: string;
  experimentId: string;
  batchId: string;
  controlAssignmentId: string;
  nativeOutcomeId: string;
  nativeOutcomeContractVersion: string;
  nativeOutcomeClassifierVersion: string;
  nativeOutcomeSourceManifestHash: string;
  nativeOutcomeComputedAt: string;
  metricName: ControlledMetricName;
  metricDirection: ControlledMetricDirection;
  windowStartAt: string;
  windowEndAt: string;
  value: string;
  observedAt: string;
  asOf: string;
}) {
  return hashParts([
    CONTROLLED_OBSERVATION_VERSION,
    requiredUuid(input.observationId, "observationId"),
    requiredString(input.experimentId, "experimentId"),
    requiredString(input.batchId, "batchId"),
    requiredString(input.controlAssignmentId, "controlAssignmentId"),
    requiredUuid(input.nativeOutcomeId, "nativeOutcomeId"),
    requiredString(
      input.nativeOutcomeContractVersion,
      "nativeOutcomeContractVersion",
    ),
    requiredString(
      input.nativeOutcomeClassifierVersion,
      "nativeOutcomeClassifierVersion",
    ),
    requiredHash(
      input.nativeOutcomeSourceManifestHash,
      "nativeOutcomeSourceManifestHash",
    ),
    requiredTimestamp(input.nativeOutcomeComputedAt, "nativeOutcomeComputedAt"),
    requiredMetricName(input.metricName, "metricName"),
    requiredDirection(input.metricDirection, "metricDirection"),
    requiredTimestamp(input.windowStartAt, "windowStartAt"),
    requiredTimestamp(input.windowEndAt, "windowEndAt"),
    fixedNumeric(input.value, "value"),
    requiredTimestamp(input.observedAt, "observedAt"),
    requiredTimestamp(input.asOf, "asOf"),
  ]);
}

export function buildControlledProviderVerificationHash(input: {
  actionLogId: string;
  controlledAssignmentId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  snapshotId: string;
  evaluationId: string;
  engineVersion: string;
  decisionHash: string;
  entityType: "ad";
  entityId: string;
  action: string;
  status: string;
  observedAt: string;
  responseHash: string;
}) {
  return hashParts([
    CONTROLLED_PROVIDER_VERIFICATION_VERSION,
    requiredUuid(input.actionLogId, "actionLogId"),
    requiredString(input.controlledAssignmentId, "controlledAssignmentId"),
    requiredUuid(input.businessId, "businessId"),
    requiredUuid(input.providerAccountRefId, "providerAccountRefId"),
    requiredString(input.providerAccountId, "providerAccountId"),
    requiredUuid(input.snapshotId, "snapshotId"),
    requiredUuid(input.evaluationId, "evaluationId"),
    requiredString(input.engineVersion, "engineVersion"),
    requiredHash(input.decisionHash, "decisionHash"),
    requiredEntityType(input.entityType, "entityType"),
    requiredString(input.entityId, "entityId"),
    requiredString(input.action, "action"),
    requiredString(input.status, "status"),
    requiredTimestamp(input.observedAt, "observedAt"),
    requiredHash(input.responseHash, "responseHash"),
  ]);
}

function normalizeNumeric(value: unknown, field: string) {
  const normalized = requiredString(value, field);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new ControlledRegistryValidationError(
      "invalid_numeric",
      `${field} must be a plain decimal string.`,
    );
  }
  const [integer, fraction = ""] = normalized.split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const canonicalInteger = integer === "-0" ? "0" : integer;
  return trimmedFraction
    ? `${canonicalInteger}.${trimmedFraction}`
    : canonicalInteger;
}

function fixedNumeric(value: unknown, field: string) {
  const normalized = normalizeNumeric(value, field);
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integer, fraction = ""] = unsigned.split(".");
  if (fraction.length > 12) {
    throw new ControlledRegistryValidationError(
      "numeric_scale_exceeded",
      `${field} must have no more than 12 decimal places.`,
    );
  }
  return `${negative ? "-" : ""}${integer}.${fraction.padEnd(12, "0")}`;
}

function hashParts(parts: readonly string[]) {
  return createHash("sha256")
    .update(parts.join("\u001f"), "utf8")
    .digest("hex");
}

function hashLines(lines: readonly string[]) {
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

function estimateHashMaterial(input: {
  estimateId: string;
  experimentId: string;
  batchId: string;
  treatedAssignmentId: string;
  treatedOutcomeLogId: string;
  treatedNativeOutcomeId: string;
  treatedNativeOutcomeSourceManifestHash: string;
  treatedMetricValue: string;
  treatmentActionLogId: string;
  controlArmId: string;
  metricName: string;
  metricDirection: string;
  windowStartAt: string;
  windowEndAt: string;
  observationIds: string[];
  sourceManifestHash: string;
  asOf: string;
  value: string;
  sampleSize: number;
  variance: string | null;
  standardError: string | null;
  confidence95Lower: string | null;
  confidence95Upper: string | null;
}) {
  return hashParts([
    CONTROLLED_ESTIMATE_VERSION,
    input.estimateId,
    input.experimentId,
    input.batchId,
    input.treatedAssignmentId,
    input.treatedOutcomeLogId,
    input.treatedNativeOutcomeId,
    input.treatedNativeOutcomeSourceManifestHash,
    fixedNumeric(input.treatedMetricValue, "estimate.treatedMetricValue"),
    input.treatmentActionLogId,
    input.controlArmId,
    input.metricName,
    input.metricDirection,
    input.windowStartAt,
    input.windowEndAt,
    [...input.observationIds].sort().join(","),
    input.sourceManifestHash,
    input.asOf,
    fixedNumeric(input.value, "estimate.value"),
    String(input.sampleSize),
    input.variance === null
      ? "null"
      : fixedNumeric(input.variance, "estimate.variance"),
    input.standardError === null
      ? "null"
      : fixedNumeric(input.standardError, "estimate.standardError"),
    input.confidence95Lower === null
      ? "null"
      : fixedNumeric(input.confidence95Lower, "estimate.confidence95Lower"),
    input.confidence95Upper === null
      ? "null"
      : fixedNumeric(input.confidence95Upper, "estimate.confidence95Upper"),
  ]);
}

interface ColumnRequirement {
  table: string;
  column: string;
  type: string;
  notNull: boolean;
}

interface ConstraintRequirement {
  table: string;
  name: string;
  type: "c" | "f" | "p" | "u";
  definition: string;
}

interface IndexRequirement {
  table: string;
  name: string;
  unique: boolean;
  keys: string[];
  predicate: string | null;
}

interface TriggerRequirement {
  table: string;
  name: string;
  functionName: string;
  enabled: "O";
  timing?: "BEFORE" | "AFTER";
  events?: string[];
  rowLevel?: boolean;
  constraint?: boolean;
  deferrable?: boolean;
  initiallyDeferred?: boolean;
  functionSource?: string;
}

function columns(
  table: string,
  definitions: ReadonlyArray<readonly [string, string, boolean]>,
): ColumnRequirement[] {
  return definitions.map(([column, type, notNull]) => ({
    table,
    column,
    type,
    notNull,
  }));
}

export const CONTROLLED_REGISTRY_SCHEMA_CONTRACT = {
  extensions: ["pgcrypto"],
  columns: [
    ...columns("businesses", [["id", "uuid", true]]),
    ...columns("provider_accounts", [
      ["id", "uuid", true],
      ["provider", "text", true],
      ["external_account_id", "text", true],
    ]),
    ...columns("business_provider_accounts", [
      ["business_id", "text", true],
      ["provider", "text", true],
      ["provider_account_ref_id", "uuid", true],
      ["provider_account_id", "text", true],
    ]),
    ...columns("engine_v3_ad_decision_evaluations", [
      ["id", "uuid", true],
      ["business_ref_id", "uuid", true],
      ["provider_account_id", "text", true],
      ["decision_entity_type", "text", true],
      ["decision_entity_id", "text", true],
      ["input_hash", "character(64)", true],
      ["decision_hash", "character(64)", true],
      ["engine_version", "text", true],
    ]),
    ...columns("engine_v3_ad_decision_snapshots_daily", [
      ["id", "uuid", true],
      ["evaluation_id", "uuid", true],
      ["business_ref_id", "uuid", true],
      ["provider_account_id", "text", true],
      ["decision_entity_type", "text", true],
      ["decision_entity_id", "text", true],
      ["input_hash", "character(64)", true],
      ["decision_hash", "character(64)", true],
      ["engine_version", "text", true],
    ]),
    ...columns("engine_v3_ad_decision_outcomes_daily", [
      ["id", "uuid", true],
      ["contract_version", "text", true],
      ["classifier_version", "text", true],
      ["decision_snapshot_id", "uuid", true],
      ["evaluation_id", "uuid", true],
      ["business_ref_id", "uuid", true],
      ["business_id", "text", true],
      ["provider_account_id", "text", true],
      ["decision_entity_type", "text", true],
      ["decision_entity_id", "text", true],
      ["ad_id", "text", true],
      ["outcome_window_start", "date", true],
      ["outcome_window_end", "date", true],
      ["window_complete", "boolean", true],
      ["measurement_status", "text", true],
      ["realized_outcome", "text", true],
      ["action_contaminated", "boolean", true],
      ["outcome_roas", "double precision", false],
      ["outcome_revenue", "double precision", true],
      ["outcome_purchases", "double precision", true],
      ["outcome_spend", "double precision", true],
      ["action_source_hash", "character(64)", true],
      ["source_manifest_hash", "character(64)", true],
      ["source_receipts_json", "jsonb", true],
      ["computed_at", "timestamp with time zone", true],
    ]),
    ...columns("meta_controlled_experiments", [
      ["id", "text", true],
      ["contract_version", "text", true],
      ["business_id", "uuid", true],
      ["provider_account_ref_id", "uuid", true],
      ["provider_account_id", "text", true],
      ["name", "text", true],
      ["hypothesis", "text", true],
      ["primary_metric", "text", true],
      ["metric_direction", "text", true],
      ["randomization_unit", "text", true],
      ["randomization_algorithm", "text", true],
      ["seed_commitment_hash", "character(64)", true],
      ["eligibility_count", "integer", true],
      ["eligibility_hash", "character(64)", true],
      ["assignment_manifest_hash", "character(64)", true],
      ["starts_at", "timestamp with time zone", true],
      ["outcome_window_start_at", "timestamp with time zone", true],
      ["outcome_window_end_at", "timestamp with time zone", true],
      ["ends_at", "timestamp with time zone", true],
      ["registration_hash", "character(64)", true],
      ["preregistered_at", "timestamp with time zone", true],
      ["created_at", "timestamp with time zone", true],
    ]),
    ...columns("meta_controlled_experiment_arms", [
      ["id", "text", true],
      ["contract_version", "text", true],
      ["experiment_id", "text", true],
      ["business_id", "uuid", true],
      ["provider_account_ref_id", "uuid", true],
      ["provider_account_id", "text", true],
      ["arm_role", "text", true],
      ["allocation_order", "integer", true],
      ["assignment_probability", "double precision", true],
      ["treatment_action", "text", false],
      ["arm_hash", "character(64)", true],
      ["created_at", "timestamp with time zone", true],
    ]),
    ...columns("meta_controlled_assignment_batches", [
      ["id", "text", true],
      ["contract_version", "text", true],
      ["experiment_id", "text", true],
      ["business_id", "uuid", true],
      ["provider_account_ref_id", "uuid", true],
      ["provider_account_id", "text", true],
      ["eligibility_count", "integer", true],
      ["eligibility_hash", "character(64)", true],
      ["assignment_manifest_hash", "character(64)", true],
      ["eligibility_manifest_json", "jsonb", true],
      ["batch_hash", "character(64)", true],
      ["assigned_at", "timestamp with time zone", true],
      ["created_at", "timestamp with time zone", true],
    ]),
    ...columns("meta_controlled_random_assignments", [
      ["id", "text", true],
      ["contract_version", "text", true],
      ["experiment_id", "text", true],
      ["batch_id", "text", true],
      ["arm_id", "text", true],
      ["arm_role", "text", true],
      ["business_id", "uuid", true],
      ["provider_account_ref_id", "uuid", true],
      ["provider_account_id", "text", true],
      ["recommendation_fingerprint", "text", true],
      ["rec_id", "text", true],
      ["evaluation_id", "uuid", true],
      ["snapshot_id", "uuid", true],
      ["entity_type", "text", true],
      ["entity_id", "text", true],
      ["assigned_action", "text", false],
      ["assignment_probability", "double precision", true],
      ["randomization_algorithm", "text", true],
      ["seed_commitment_hash", "character(64)", true],
      ["eligibility_hash", "character(64)", true],
      ["randomization_draw", "double precision", true],
      ["randomization_proof_hash", "character(64)", true],
      ["assignment_hash", "character(64)", true],
      ["assigned_at", "timestamp with time zone", true],
      ["created_at", "timestamp with time zone", true],
    ]),
    ...columns("meta_controlled_seed_reveals", [
      ["batch_id", "text", true],
      ["contract_version", "text", true],
      ["experiment_id", "text", true],
      ["business_id", "uuid", true],
      ["provider_account_ref_id", "uuid", true],
      ["provider_account_id", "text", true],
      ["revealed_seed", "text", true],
      ["seed_hash", "character(64)", true],
      ["reveal_hash", "character(64)", true],
      ["revealed_at", "timestamp with time zone", true],
      ["created_at", "timestamp with time zone", true],
    ]),
    ...columns("meta_controlled_control_outcome_observations", [
      ["id", "uuid", true],
      ["contract_version", "text", true],
      ["experiment_id", "text", true],
      ["batch_id", "text", true],
      ["control_assignment_id", "text", true],
      ["arm_role", "text", true],
      ["business_id", "uuid", true],
      ["provider_account_ref_id", "uuid", true],
      ["provider_account_id", "text", true],
      ["native_outcome_id", "uuid", true],
      ["native_outcome_contract_version", "text", true],
      ["native_outcome_classifier_version", "text", true],
      ["native_outcome_source_manifest_hash", "character(64)", true],
      ["native_outcome_computed_at", "timestamp with time zone", true],
      ["metric_name", "text", true],
      ["metric_direction", "text", true],
      ["window_start_at", "timestamp with time zone", true],
      ["window_end_at", "timestamp with time zone", true],
      ["source_receipt_id", "text", true],
      ["source_receipt_hash", "character(64)", true],
      ["source_receipt_json", "jsonb", true],
      ["metric_value", "numeric(30,12)", true],
      ["sample_size", "bigint", true],
      ["observation_status", "text", true],
      ["observed_at", "timestamp with time zone", true],
      ["as_of", "timestamp with time zone", true],
      ["finalized_at", "timestamp with time zone", true],
      ["observation_hash", "character(64)", true],
      ["created_at", "timestamp with time zone", true],
    ]),
    ...columns("meta_controlled_control_estimates", [
      ["id", "text", true],
      ["contract_version", "text", true],
      ["experiment_id", "text", true],
      ["batch_id", "text", true],
      ["treated_assignment_id", "text", true],
      ["treated_arm_role", "text", true],
      ["treated_outcome_log_id", "uuid", true],
      ["treated_native_outcome_id", "uuid", true],
      ["treated_native_outcome_source_manifest_hash", "character(64)", true],
      ["treated_metric_value", "numeric(30,12)", true],
      ["treatment_action_log_id", "uuid", true],
      ["control_arm_id", "text", true],
      ["business_id", "uuid", true],
      ["provider_account_ref_id", "uuid", true],
      ["provider_account_id", "text", true],
      ["metric_name", "text", true],
      ["metric_direction", "text", true],
      ["window_start_at", "timestamp with time zone", true],
      ["window_end_at", "timestamp with time zone", true],
      ["observation_ids", "uuid[]", true],
      ["observation_count", "integer", true],
      ["source_manifest_hash", "character(64)", true],
      ["as_of", "timestamp with time zone", true],
      ["estimate_value", "numeric(30,12)", true],
      ["sample_size", "bigint", true],
      ["estimate_variance", "numeric(30,12)", false],
      ["standard_error", "numeric(30,12)", false],
      ["confidence_95_lower", "numeric(30,12)", false],
      ["confidence_95_upper", "numeric(30,12)", false],
      ["estimate_hash", "character(64)", true],
      ["finalized_at", "timestamp with time zone", true],
      ["created_at", "timestamp with time zone", true],
    ]),
    ...columns("meta_ads_action_log", [
      ["business_id", "uuid", true],
      ["provider_account_ref_id", "uuid", false],
      ["provider_account_id", "text", false],
      ["controlled_assignment_id", "text", false],
      ["target_entity_type", "text", false],
      ["target_entity_id", "text", false],
      ["source_snapshot_id", "uuid", false],
      ["source_evaluation_id", "uuid", false],
      ["engine_version", "text", false],
      ["decision_hash", "character(64)", false],
      ["dry_run", "boolean", true],
      ["executed_at", "timestamp with time zone", false],
      ["provider_entity_id", "text", false],
      ["provider_action", "text", false],
      ["provider_status", "text", false],
      ["provider_observed_at", "timestamp with time zone", false],
      ["provider_response_hash", "character(64)", false],
      ["provider_verification_hash", "character(64)", false],
      ["verification_payload", "jsonb", false],
      ["verified_at", "timestamp with time zone", false],
    ]),
    ...columns("meta_decision_action_outcome_logs", [
      ["business_ref_id", "uuid", false],
      ["business_id", "text", true],
      ["provider_account_ref_id", "uuid", false],
      ["provider_account_id", "text", false],
      ["outcome_status", "text", false],
      ["payload_json", "jsonb", true],
      ["occurred_at", "timestamp with time zone", true],
    ]),
  ],
  constraints: [] as ConstraintRequirement[],
  indexes: [] as IndexRequirement[],
  triggers: [
    ...[
      "meta_controlled_experiments",
      "meta_controlled_experiment_arms",
      "meta_controlled_assignment_batches",
      "meta_controlled_random_assignments",
      "meta_controlled_seed_reveals",
      "meta_controlled_control_outcome_observations",
      "meta_controlled_control_estimates",
    ].map((table) => ({
      table,
      name: `trg_${table}_immutable`,
      functionName: "meta_reject_immutable_controlled_registry_write",
      enabled: "O" as const,
    })),
    {
      table: "meta_controlled_experiments",
      name: "trg_meta_controlled_experiment_account_guard",
      functionName: "meta_validate_controlled_experiment_account_binding",
      enabled: "O" as const,
    },
    {
      table: "meta_ads_action_log",
      name: "trg_meta_ads_action_log_controlled_verified_immutable",
      functionName: "meta_prevent_verified_controlled_action_mutation",
      enabled: "O" as const,
    },
    {
      table: "meta_decision_action_outcome_logs",
      name: "trg_meta_decision_controlled_outcome_immutable",
      functionName: "meta_prevent_bound_controlled_outcome_mutation",
      enabled: "O" as const,
    },
    {
      table: "meta_controlled_experiment_arms",
      name: "trg_meta_controlled_arms_allocation_guard",
      functionName: "meta_validate_controlled_arm_allocation",
      enabled: "O" as const,
    },
    {
      table: "meta_controlled_random_assignments",
      name: "trg_meta_controlled_assignment_batch_guard",
      functionName: "meta_validate_controlled_assignment_batch",
      enabled: "O" as const,
    },
    {
      table: "meta_controlled_assignment_batches",
      name: "trg_meta_controlled_assignment_batch_header_guard",
      functionName: "meta_validate_controlled_assignment_batch",
      enabled: "O" as const,
    },
    {
      table: "meta_controlled_seed_reveals",
      name: "trg_meta_controlled_seed_reveal_guard",
      functionName: "meta_validate_controlled_seed_reveal",
      enabled: "O" as const,
    },
    {
      table: "meta_controlled_control_outcome_observations",
      name: "trg_meta_controlled_control_observation_native_guard",
      functionName: "meta_validate_controlled_control_observation",
      enabled: "O" as const,
    },
    {
      table: "engine_v3_ad_decision_outcomes_daily",
      name: "trg_engine_v3_ad_outcomes_immutable",
      functionName: "reject_engine_v3_ad_outcome_mutation",
      enabled: "O" as const,
      timing: "BEFORE",
      events: ["DELETE", "UPDATE"],
      rowLevel: true,
      constraint: false,
      deferrable: false,
      initiallyDeferred: false,
      functionSource:
        "BEGIN RAISE EXCEPTION 'engine_v3_ad_decision_outcomes_daily rows are immutable'; END;",
    },
  ] as TriggerRequirement[],
};

function requiredConstraint(
  table: string,
  name: string,
  type: ConstraintRequirement["type"],
  definition: string,
): ConstraintRequirement {
  return { table, name, type, definition };
}

const businessBindingDefinition =
  "FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE RESTRICT";
const accountBindingDefinition =
  "FOREIGN KEY (provider_account_ref_id, provider_account_id) " +
  "REFERENCES provider_accounts(id, external_account_id) ON DELETE RESTRICT";

CONTROLLED_REGISTRY_SCHEMA_CONTRACT.constraints.push(
  requiredConstraint(
    "engine_v3_ad_decision_evaluations",
    "engine_v3_ad_evaluations_controlled_identity_key",
    "u",
    "UNIQUE (id, business_ref_id, provider_account_id, decision_entity_type, decision_entity_id)",
  ),
  requiredConstraint(
    "engine_v3_ad_decision_snapshots_daily",
    "engine_v3_ad_snapshots_controlled_identity_key",
    "u",
    "UNIQUE (id, evaluation_id, business_ref_id, provider_account_id, decision_entity_type, decision_entity_id)",
  ),
  requiredConstraint(
    "engine_v3_ad_decision_outcomes_daily",
    "engine_v3_ad_outcomes_controlled_identity_key",
    "u",
    "UNIQUE (id, decision_snapshot_id, evaluation_id, business_ref_id, provider_account_id, decision_entity_type, decision_entity_id)",
  ),
  requiredConstraint(
    "meta_controlled_experiments",
    "meta_controlled_experiments_pkey",
    "p",
    "PRIMARY KEY (id)",
  ),
  requiredConstraint(
    "meta_controlled_experiments",
    "meta_controlled_experiments_tenant_key",
    "u",
    "UNIQUE (id, business_id, provider_account_ref_id, provider_account_id)",
  ),
  requiredConstraint(
    "meta_controlled_experiments",
    "meta_controlled_experiments_business_fk",
    "f",
    businessBindingDefinition,
  ),
  requiredConstraint(
    "meta_controlled_experiments",
    "meta_controlled_experiments_account_fk",
    "f",
    accountBindingDefinition,
  ),
  requiredConstraint(
    "meta_controlled_experiments",
    "meta_controlled_experiments_contract_check",
    "c",
    "CHECK (contract_version = 'meta-controlled-experiment.v2'::text AND eligibility_count > 0 AND preregistered_at = created_at AND preregistered_at < starts_at AND starts_at <= outcome_window_start_at AND outcome_window_start_at < outcome_window_end_at AND outcome_window_end_at <= ends_at)",
  ),
  requiredConstraint(
    "meta_controlled_experiment_arms",
    "meta_controlled_experiment_arms_pkey",
    "p",
    "PRIMARY KEY (id)",
  ),
  requiredConstraint(
    "meta_controlled_experiment_arms",
    "meta_controlled_experiment_arms_tenant_key",
    "u",
    "UNIQUE (id, experiment_id, arm_role, business_id, provider_account_ref_id, provider_account_id)",
  ),
  requiredConstraint(
    "meta_controlled_experiment_arms",
    "meta_controlled_experiment_arms_experiment_fk",
    "f",
    "FOREIGN KEY (experiment_id, business_id, provider_account_ref_id, provider_account_id) REFERENCES meta_controlled_experiments(id, business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_experiment_arms",
    "meta_controlled_experiment_arms_allocation_unique",
    "u",
    "UNIQUE (experiment_id, allocation_order)",
  ),
  requiredConstraint(
    "meta_controlled_experiment_arms",
    "meta_controlled_experiment_arms_contract_check",
    "c",
    "CHECK (contract_version = 'meta-controlled-experiment-arm.v2'::text AND assignment_probability > 0::double precision AND assignment_probability <= 1::double precision AND (arm_role = 'control'::text AND treatment_action IS NULL OR arm_role = 'treatment'::text AND (treatment_action = ANY (ARRAY['pause'::text, 'resume'::text]))))",
  ),
  requiredConstraint(
    "meta_controlled_assignment_batches",
    "meta_controlled_assignment_batches_pkey",
    "p",
    "PRIMARY KEY (id)",
  ),
  requiredConstraint(
    "meta_controlled_assignment_batches",
    "meta_controlled_assignment_batches_tenant_key",
    "u",
    "UNIQUE (id, experiment_id, business_id, provider_account_ref_id, provider_account_id)",
  ),
  requiredConstraint(
    "meta_controlled_assignment_batches",
    "meta_controlled_assignment_batches_experiment_unique",
    "u",
    "UNIQUE (experiment_id)",
  ),
  requiredConstraint(
    "meta_controlled_assignment_batches",
    "meta_controlled_assignment_batches_experiment_fk",
    "f",
    "FOREIGN KEY (experiment_id, business_id, provider_account_ref_id, provider_account_id) REFERENCES meta_controlled_experiments(id, business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_assignment_batches",
    "meta_controlled_assignment_batches_contract_check",
    "c",
    "CHECK (contract_version = 'meta-controlled-assignment-batch.v2'::text AND eligibility_count > 0 AND jsonb_typeof(eligibility_manifest_json) = 'array'::text AND assigned_at = created_at)",
  ),
  requiredConstraint(
    "meta_controlled_random_assignments",
    "meta_controlled_random_assignments_pkey",
    "p",
    "PRIMARY KEY (id)",
  ),
  requiredConstraint(
    "meta_controlled_random_assignments",
    "meta_controlled_random_assignments_tenant_key",
    "u",
    "UNIQUE (id, experiment_id, batch_id, arm_role, business_id, provider_account_ref_id, provider_account_id)",
  ),
  requiredConstraint(
    "meta_controlled_random_assignments",
    "meta_controlled_random_assignments_receipt_binding_key",
    "u",
    "UNIQUE (id, business_id, provider_account_ref_id, provider_account_id, entity_type, entity_id, assigned_action, rec_id, snapshot_id, evaluation_id)",
  ),
  requiredConstraint(
    "meta_controlled_random_assignments",
    "meta_controlled_random_assignments_batch_fk",
    "f",
    "FOREIGN KEY (batch_id, experiment_id, business_id, provider_account_ref_id, provider_account_id) REFERENCES meta_controlled_assignment_batches(id, experiment_id, business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_random_assignments",
    "meta_controlled_random_assignments_arm_fk",
    "f",
    "FOREIGN KEY (arm_id, experiment_id, arm_role, business_id, provider_account_ref_id, provider_account_id) REFERENCES meta_controlled_experiment_arms(id, experiment_id, arm_role, business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_random_assignments",
    "meta_controlled_random_assignments_evaluation_fk",
    "f",
    "FOREIGN KEY (evaluation_id, business_id, provider_account_id, entity_type, entity_id) REFERENCES engine_v3_ad_decision_evaluations(id, business_ref_id, provider_account_id, decision_entity_type, decision_entity_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_random_assignments",
    "meta_controlled_random_assignments_snapshot_fk",
    "f",
    "FOREIGN KEY (snapshot_id, evaluation_id, business_id, provider_account_id, entity_type, entity_id) REFERENCES engine_v3_ad_decision_snapshots_daily(id, evaluation_id, business_ref_id, provider_account_id, decision_entity_type, decision_entity_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_random_assignments",
    "meta_controlled_random_assignments_entity_unique",
    "u",
    "UNIQUE (experiment_id, entity_type, entity_id)",
  ),
  requiredConstraint(
    "meta_controlled_random_assignments",
    "meta_controlled_random_assignments_recommendation_unique",
    "u",
    "UNIQUE (experiment_id, recommendation_fingerprint, rec_id)",
  ),
  requiredConstraint(
    "meta_controlled_random_assignments",
    "meta_controlled_random_assignments_contract_check",
    "c",
    "CHECK (contract_version = 'meta-controlled-random-assignment.v2'::text AND entity_type = 'ad'::text AND randomization_algorithm = 'sha256-threshold-v1'::text AND assignment_probability > 0::double precision AND assignment_probability <= 1::double precision AND randomization_draw >= 0::double precision AND randomization_draw < 1::double precision AND assigned_at = created_at AND (arm_role = 'control'::text AND assigned_action IS NULL OR arm_role = 'treatment'::text AND (assigned_action = ANY (ARRAY['pause'::text, 'resume'::text]))))",
  ),
  requiredConstraint(
    "meta_controlled_seed_reveals",
    "meta_controlled_seed_reveals_pkey",
    "p",
    "PRIMARY KEY (batch_id)",
  ),
  requiredConstraint(
    "meta_controlled_seed_reveals",
    "meta_controlled_seed_reveals_batch_fk",
    "f",
    "FOREIGN KEY (batch_id, experiment_id, business_id, provider_account_ref_id, provider_account_id) REFERENCES meta_controlled_assignment_batches(id, experiment_id, business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_seed_reveals",
    "meta_controlled_seed_reveals_experiment_unique",
    "u",
    "UNIQUE (experiment_id)",
  ),
  requiredConstraint(
    "meta_controlled_seed_reveals",
    "meta_controlled_seed_reveals_contract_check",
    "c",
    "CHECK (contract_version = 'meta-controlled-seed-reveal.v1'::text AND revealed_at = created_at)",
  ),
  requiredConstraint(
    "meta_controlled_control_outcome_observations",
    "meta_controlled_control_outcome_observations_pkey",
    "p",
    "PRIMARY KEY (id)",
  ),
  requiredConstraint(
    "meta_controlled_control_outcome_observations",
    "meta_controlled_control_observations_account_fk",
    "f",
    accountBindingDefinition,
  ),
  requiredConstraint(
    "meta_controlled_control_outcome_observations",
    "meta_controlled_control_observations_assignment_fk",
    "f",
    "FOREIGN KEY (control_assignment_id, experiment_id, batch_id, arm_role, business_id, provider_account_ref_id, provider_account_id) REFERENCES meta_controlled_random_assignments(id, experiment_id, batch_id, arm_role, business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_control_outcome_observations",
    "meta_controlled_control_observations_receipt_unique",
    "u",
    "UNIQUE (business_id, provider_account_ref_id, provider_account_id, source_receipt_id)",
  ),
  requiredConstraint(
    "meta_controlled_control_outcome_observations",
    "meta_controlled_control_observations_assignment_unique",
    "u",
    "UNIQUE (control_assignment_id)",
  ),
  requiredConstraint(
    "meta_controlled_control_outcome_observations",
    "meta_controlled_control_observations_native_outcome_unique",
    "u",
    "UNIQUE (native_outcome_id)",
  ),
  requiredConstraint(
    "meta_controlled_control_outcome_observations",
    "meta_controlled_control_observations_native_outcome_fk",
    "f",
    "FOREIGN KEY (native_outcome_id) REFERENCES engine_v3_ad_decision_outcomes_daily(id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_control_outcome_observations",
    "meta_controlled_control_observations_contract_check",
    "c",
    "CHECK (contract_version = 'meta-controlled-control-outcome-observation.v1'::text AND arm_role = 'control'::text AND observation_status = 'finalized'::text AND sample_size = 1 AND source_receipt_id = native_outcome_id::text AND source_receipt_hash = native_outcome_source_manifest_hash AND jsonb_typeof(source_receipt_json) = 'object'::text AND jsonb_array_length(jsonb_path_query_array(source_receipt_json, '$.keyvalue()'::jsonpath)) = 5 AND window_start_at < window_end_at AND window_end_at <= observed_at AND observed_at = native_outcome_computed_at AND observed_at <= as_of AND as_of <= finalized_at AND finalized_at = created_at)",
  ),
  requiredConstraint(
    "meta_controlled_control_estimates",
    "meta_controlled_control_estimates_pkey",
    "p",
    "PRIMARY KEY (id)",
  ),
  requiredConstraint(
    "meta_controlled_control_estimates",
    "meta_controlled_control_estimates_account_fk",
    "f",
    accountBindingDefinition,
  ),
  requiredConstraint(
    "meta_controlled_control_estimates",
    "meta_controlled_control_estimates_assignment_fk",
    "f",
    "FOREIGN KEY (treated_assignment_id, experiment_id, batch_id, treated_arm_role, business_id, provider_account_ref_id, provider_account_id) REFERENCES meta_controlled_random_assignments(id, experiment_id, batch_id, arm_role, business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_control_estimates",
    "meta_controlled_control_estimates_assignment_unique",
    "u",
    "UNIQUE (treated_assignment_id)",
  ),
  requiredConstraint(
    "meta_controlled_control_estimates",
    "meta_controlled_control_estimates_outcome_unique",
    "u",
    "UNIQUE (treated_outcome_log_id)",
  ),
  requiredConstraint(
    "meta_controlled_control_estimates",
    "meta_controlled_control_estimates_native_outcome_unique",
    "u",
    "UNIQUE (treated_native_outcome_id)",
  ),
  requiredConstraint(
    "meta_controlled_control_estimates",
    "meta_controlled_control_estimates_native_outcome_fk",
    "f",
    "FOREIGN KEY (treated_native_outcome_id) REFERENCES engine_v3_ad_decision_outcomes_daily(id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_control_estimates",
    "meta_controlled_control_estimates_receipt_unique",
    "u",
    "UNIQUE (treatment_action_log_id)",
  ),
  requiredConstraint(
    "meta_controlled_control_estimates",
    "meta_controlled_control_estimates_contract_check",
    "c",
    "CHECK (contract_version = 'meta-controlled-control-estimate.v2'::text AND treated_arm_role = 'treatment'::text AND observation_count > 1 AND cardinality(observation_ids) = observation_count AND sample_size = observation_count AND window_start_at < window_end_at AND window_end_at <= as_of AND as_of <= finalized_at AND finalized_at = created_at AND treated_native_outcome_source_manifest_hash ~ '^[0-9a-f]{64}$'::text AND estimate_variance IS NOT NULL AND estimate_variance >= 0::numeric AND standard_error IS NOT NULL AND standard_error >= 0::numeric AND confidence_95_lower IS NOT NULL AND confidence_95_upper IS NOT NULL AND confidence_95_lower <= estimate_value AND estimate_value <= confidence_95_upper)",
  ),
  requiredConstraint(
    "meta_ads_action_log",
    "meta_ads_action_log_controlled_assignment_fk",
    "f",
    "FOREIGN KEY (controlled_assignment_id, business_id, provider_account_ref_id, provider_account_id, target_entity_type, target_entity_id, action, rec_id_origin, source_snapshot_id, source_evaluation_id) REFERENCES meta_controlled_random_assignments(id, business_id, provider_account_ref_id, provider_account_id, entity_type, entity_id, assigned_action, rec_id, snapshot_id, evaluation_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_ads_action_log",
    "meta_ads_action_log_controlled_verification_check",
    "c",
    "CHECK (controlled_assignment_id IS NULL OR provider_account_ref_id IS NOT NULL AND provider_account_id IS NOT NULL AND target_entity_type = 'ad'::text AND target_entity_id IS NOT NULL AND source_snapshot_id IS NOT NULL AND source_evaluation_id IS NOT NULL AND engine_version IS NOT NULL AND decision_hash IS NOT NULL AND NOT dry_run AND executed_at IS NOT NULL AND verified_at IS NOT NULL AND provider_entity_id IS NOT NULL AND provider_action IS NOT NULL AND provider_status IS NOT NULL AND (provider_action = 'pause'::text AND provider_status = 'PAUSED'::text OR provider_action = 'resume'::text AND provider_status = 'ACTIVE'::text) AND provider_observed_at IS NOT NULL AND provider_response_hash IS NOT NULL AND provider_verification_hash IS NOT NULL AND verification_payload IS NOT NULL AND jsonb_typeof(verification_payload) = 'object'::text AND jsonb_array_length(jsonb_path_query_array(verification_payload, '$.keyvalue()'::jsonpath)) = 16)",
  ),
  requiredConstraint(
    "meta_ads_action_log",
    "meta_ads_action_log_controlled_tenant_key",
    "u",
    "UNIQUE (id, business_id, provider_account_ref_id, provider_account_id)",
  ),
  requiredConstraint(
    "meta_decision_action_outcome_logs",
    "meta_decision_outcome_controlled_business_fk",
    "f",
    "FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_decision_action_outcome_logs",
    "meta_decision_outcome_controlled_account_fk",
    "f",
    "FOREIGN KEY (provider_account_ref_id, provider_account_id) REFERENCES provider_accounts(id, external_account_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_decision_action_outcome_logs",
    "meta_decision_outcome_controlled_identity_check",
    "c",
    "CHECK ((payload_json ->> 'evidenceClass'::text) <> 'controlled_causal'::text OR business_ref_id IS NOT NULL AND business_id = business_ref_id::text AND provider_account_ref_id IS NOT NULL AND provider_account_id IS NOT NULL)",
  ),
  requiredConstraint(
    "meta_decision_action_outcome_logs",
    "meta_decision_outcome_controlled_terminal_status_check",
    "c",
    "CHECK ((payload_json ->> 'evidenceClass'::text) <> 'controlled_causal'::text OR action_type = 'outcome'::text AND (outcome_status = ANY (ARRAY['positive'::text, 'negative'::text, 'neutral'::text])))",
  ),
  requiredConstraint(
    "meta_decision_action_outcome_logs",
    "meta_decision_outcome_controlled_tenant_key",
    "u",
    "UNIQUE (id, business_ref_id, provider_account_ref_id, provider_account_id)",
  ),
  requiredConstraint(
    "meta_controlled_control_estimates",
    "meta_controlled_control_estimates_outcome_fk",
    "f",
    "FOREIGN KEY (treated_outcome_log_id, business_id, provider_account_ref_id, provider_account_id) REFERENCES meta_decision_action_outcome_logs(id, business_ref_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
  ),
  requiredConstraint(
    "meta_controlled_control_estimates",
    "meta_controlled_control_estimates_action_fk",
    "f",
    "FOREIGN KEY (treatment_action_log_id, business_id, provider_account_ref_id, provider_account_id) REFERENCES meta_ads_action_log(id, business_id, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
  ),
);

CONTROLLED_REGISTRY_SCHEMA_CONTRACT.indexes.push(
  {
    table: "provider_accounts",
    name: "idx_provider_accounts_id_external",
    unique: true,
    keys: ["id", "external_account_id"],
    predicate: null,
  },
  {
    table: "business_provider_accounts",
    name: "idx_business_provider_accounts_binding",
    unique: true,
    keys: ["business_id", "provider_account_ref_id", "provider_account_id"],
    predicate: null,
  },
  {
    table: "meta_controlled_experiment_arms",
    name: "idx_meta_controlled_experiment_single_control_arm",
    unique: true,
    keys: ["experiment_id"],
    predicate: "arm_role = 'control'::text",
  },
  {
    table: "meta_ads_action_log",
    name: "idx_meta_ads_action_log_controlled_verified_receipt_unique",
    unique: true,
    keys: ["controlled_assignment_id"],
    predicate:
      "controlled_assignment_id IS NOT NULL AND status = 'success'::text AND NOT dry_run AND verified_at IS NOT NULL",
  },
  ...(["assignmentId", "estimateId"] as const).map((claimKey) => ({
    table: "meta_decision_action_outcome_logs",
    name: `idx_meta_decision_outcome_controlled_${claimKey === "assignmentId" ? "assignment" : "estimate"}_unique`,
    unique: true,
    keys: [
      "business_ref_id",
      "provider_account_ref_id",
      "provider_account_id",
      `((payload_json -> 'causalDesign'::text) ->> '${claimKey}'::text)`,
    ],
    predicate:
      "action_type = 'outcome'::text AND (payload_json ->> 'evidenceClass'::text) = 'controlled_causal'::text",
  })),
  {
    table: "meta_decision_action_outcome_logs",
    name: "idx_meta_decision_outcome_controlled_receipt_unique",
    unique: true,
    keys: [
      "business_ref_id",
      "provider_account_ref_id",
      "provider_account_id",
      "((payload_json -> 'treatmentReceipt'::text) ->> 'actionLogId'::text)",
    ],
    predicate:
      "action_type = 'outcome'::text AND (payload_json ->> 'evidenceClass'::text) = 'controlled_causal'::text",
  },
);

/**
 * Exact migration contract for the controlled-causal registry.
 *
 * The migration integrator must execute this string verbatim after the native
 * ad evaluation, snapshot, outcome, action-log, and outcome-log tables exist.
 * The dedicated ephemeral PostgreSQL seam executes this same export.
 */
export const CONTROLLED_REGISTRY_SCHEMA_SQL = String.raw`
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_id_external
  ON provider_accounts (id, external_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_provider_accounts_binding
  ON business_provider_accounts
  (business_id, provider_account_ref_id, provider_account_id);

DO $ddl$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_proc procedure ON procedure.oid = trigger_row.tgfoid
    WHERE relation.relname = 'engine_v3_ad_decision_outcomes_daily'
      AND trigger_row.tgname = 'trg_engine_v3_ad_outcomes_immutable'
      AND trigger_row.tgenabled = 'O'
      AND procedure.proname = 'reject_engine_v3_ad_outcome_mutation'
  ) THEN
    RAISE EXCEPTION 'native ad outcomes immutable trigger is required'
      USING ERRCODE = '55000';
  END IF;
END
$ddl$;

DO $ddl$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'engine_v3_ad_decision_evaluations'::regclass
      AND conname = 'engine_v3_ad_evaluations_controlled_identity_key'
  ) THEN
    ALTER TABLE engine_v3_ad_decision_evaluations
      ADD CONSTRAINT engine_v3_ad_evaluations_controlled_identity_key
      UNIQUE (id, business_ref_id, provider_account_id,
              decision_entity_type, decision_entity_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'engine_v3_ad_decision_snapshots_daily'::regclass
      AND conname = 'engine_v3_ad_snapshots_controlled_identity_key'
  ) THEN
    ALTER TABLE engine_v3_ad_decision_snapshots_daily
      ADD CONSTRAINT engine_v3_ad_snapshots_controlled_identity_key
      UNIQUE (id, evaluation_id, business_ref_id, provider_account_id,
              decision_entity_type, decision_entity_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'engine_v3_ad_decision_outcomes_daily'::regclass
      AND conname = 'engine_v3_ad_outcomes_controlled_identity_key'
  ) THEN
    ALTER TABLE engine_v3_ad_decision_outcomes_daily
      ADD CONSTRAINT engine_v3_ad_outcomes_controlled_identity_key
      UNIQUE (id, decision_snapshot_id, evaluation_id, business_ref_id,
              provider_account_id, decision_entity_type, decision_entity_id);
  END IF;
END
$ddl$;

ALTER TABLE meta_ads_action_log
  ADD COLUMN IF NOT EXISTS provider_account_ref_id UUID,
  ADD COLUMN IF NOT EXISTS provider_account_id TEXT,
  ADD COLUMN IF NOT EXISTS controlled_assignment_id TEXT,
  ADD COLUMN IF NOT EXISTS target_entity_type TEXT,
  ADD COLUMN IF NOT EXISTS target_entity_id TEXT,
  ADD COLUMN IF NOT EXISTS source_snapshot_id UUID,
  ADD COLUMN IF NOT EXISTS source_evaluation_id UUID,
  ADD COLUMN IF NOT EXISTS engine_version TEXT,
  ADD COLUMN IF NOT EXISTS decision_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS dry_run BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_entity_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_action TEXT,
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS provider_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_response_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS provider_verification_hash CHAR(64);

CREATE TABLE IF NOT EXISTS meta_controlled_experiments (
  id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  business_id UUID NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  primary_metric TEXT NOT NULL,
  metric_direction TEXT NOT NULL,
  randomization_unit TEXT NOT NULL,
  randomization_algorithm TEXT NOT NULL,
  seed_commitment_hash CHAR(64) NOT NULL,
  eligibility_count INTEGER NOT NULL,
  eligibility_hash CHAR(64) NOT NULL,
  assignment_manifest_hash CHAR(64) NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  outcome_window_start_at TIMESTAMPTZ NOT NULL,
  outcome_window_end_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  registration_hash CHAR(64) NOT NULL,
  preregistered_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT meta_controlled_experiments_tenant_key
    UNIQUE (id, business_id, provider_account_ref_id, provider_account_id),
  CONSTRAINT meta_controlled_experiments_business_fk FOREIGN KEY (business_id)
    REFERENCES businesses (id) ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_experiments_account_fk FOREIGN KEY
    (provider_account_ref_id, provider_account_id)
    REFERENCES provider_accounts (id, external_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_experiments_contract_check CHECK (
    contract_version = 'meta-controlled-experiment.v2'
    AND eligibility_count > 0
    AND preregistered_at = created_at
    AND preregistered_at < starts_at
    AND starts_at <= outcome_window_start_at
    AND outcome_window_start_at < outcome_window_end_at
    AND outcome_window_end_at <= ends_at
  )
);

CREATE TABLE IF NOT EXISTS meta_controlled_experiment_arms (
  id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  business_id UUID NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  arm_role TEXT NOT NULL,
  allocation_order INTEGER NOT NULL,
  assignment_probability DOUBLE PRECISION NOT NULL,
  treatment_action TEXT,
  arm_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT meta_controlled_experiment_arms_tenant_key
    UNIQUE (id, experiment_id, arm_role, business_id,
            provider_account_ref_id, provider_account_id),
  CONSTRAINT meta_controlled_experiment_arms_experiment_fk FOREIGN KEY
    (experiment_id, business_id, provider_account_ref_id, provider_account_id)
    REFERENCES meta_controlled_experiments
      (id, business_id, provider_account_ref_id, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_experiment_arms_allocation_unique
    UNIQUE (experiment_id, allocation_order),
  CONSTRAINT meta_controlled_experiment_arms_contract_check CHECK (
    contract_version = 'meta-controlled-experiment-arm.v2'
    AND assignment_probability > 0::double precision
    AND assignment_probability <= 1::double precision
    AND (
      (arm_role = 'control' AND treatment_action IS NULL)
      OR (arm_role = 'treatment' AND treatment_action IN ('pause', 'resume'))
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_controlled_experiment_single_control_arm
  ON meta_controlled_experiment_arms (experiment_id)
  WHERE arm_role = 'control';

CREATE TABLE IF NOT EXISTS meta_controlled_assignment_batches (
  id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  business_id UUID NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  eligibility_count INTEGER NOT NULL,
  eligibility_hash CHAR(64) NOT NULL,
  assignment_manifest_hash CHAR(64) NOT NULL,
  eligibility_manifest_json JSONB NOT NULL,
  batch_hash CHAR(64) NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT meta_controlled_assignment_batches_tenant_key
    UNIQUE (id, experiment_id, business_id,
            provider_account_ref_id, provider_account_id),
  CONSTRAINT meta_controlled_assignment_batches_experiment_unique
    UNIQUE (experiment_id),
  CONSTRAINT meta_controlled_assignment_batches_experiment_fk FOREIGN KEY
    (experiment_id, business_id, provider_account_ref_id, provider_account_id)
    REFERENCES meta_controlled_experiments
      (id, business_id, provider_account_ref_id, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_assignment_batches_contract_check CHECK (
    contract_version = 'meta-controlled-assignment-batch.v2'
    AND eligibility_count > 0
    AND jsonb_typeof(eligibility_manifest_json) = 'array'
    AND assigned_at = created_at
  )
);

CREATE TABLE IF NOT EXISTS meta_controlled_random_assignments (
  id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  arm_role TEXT NOT NULL,
  business_id UUID NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  recommendation_fingerprint TEXT NOT NULL,
  rec_id TEXT NOT NULL,
  evaluation_id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  assigned_action TEXT,
  assignment_probability DOUBLE PRECISION NOT NULL,
  randomization_algorithm TEXT NOT NULL,
  seed_commitment_hash CHAR(64) NOT NULL,
  eligibility_hash CHAR(64) NOT NULL,
  randomization_draw DOUBLE PRECISION NOT NULL,
  randomization_proof_hash CHAR(64) NOT NULL,
  assignment_hash CHAR(64) NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT meta_controlled_random_assignments_tenant_key
    UNIQUE (id, experiment_id, batch_id, arm_role, business_id,
            provider_account_ref_id, provider_account_id),
  CONSTRAINT meta_controlled_random_assignments_receipt_binding_key
    UNIQUE (id, business_id, provider_account_ref_id, provider_account_id,
            entity_type, entity_id, assigned_action, rec_id,
            snapshot_id, evaluation_id),
  CONSTRAINT meta_controlled_random_assignments_batch_fk FOREIGN KEY
    (batch_id, experiment_id, business_id,
     provider_account_ref_id, provider_account_id)
    REFERENCES meta_controlled_assignment_batches
      (id, experiment_id, business_id,
       provider_account_ref_id, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_random_assignments_arm_fk FOREIGN KEY
    (arm_id, experiment_id, arm_role, business_id,
     provider_account_ref_id, provider_account_id)
    REFERENCES meta_controlled_experiment_arms
      (id, experiment_id, arm_role, business_id,
       provider_account_ref_id, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_random_assignments_evaluation_fk FOREIGN KEY
    (evaluation_id, business_id, provider_account_id, entity_type, entity_id)
    REFERENCES engine_v3_ad_decision_evaluations
      (id, business_ref_id, provider_account_id,
       decision_entity_type, decision_entity_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_random_assignments_snapshot_fk FOREIGN KEY
    (snapshot_id, evaluation_id, business_id,
     provider_account_id, entity_type, entity_id)
    REFERENCES engine_v3_ad_decision_snapshots_daily
      (id, evaluation_id, business_ref_id,
       provider_account_id, decision_entity_type, decision_entity_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_random_assignments_entity_unique
    UNIQUE (experiment_id, entity_type, entity_id),
  CONSTRAINT meta_controlled_random_assignments_recommendation_unique
    UNIQUE (experiment_id, recommendation_fingerprint, rec_id),
  CONSTRAINT meta_controlled_random_assignments_contract_check CHECK (
    contract_version = 'meta-controlled-random-assignment.v2'
    AND entity_type = 'ad'
    AND randomization_algorithm = 'sha256-threshold-v1'
    AND assignment_probability > 0::double precision
    AND assignment_probability <= 1::double precision
    AND randomization_draw >= 0::double precision
    AND randomization_draw < 1::double precision
    AND assigned_at = created_at
    AND (
      (arm_role = 'control' AND assigned_action IS NULL)
      OR (arm_role = 'treatment' AND assigned_action IN ('pause', 'resume'))
    )
  )
);

CREATE TABLE IF NOT EXISTS meta_controlled_seed_reveals (
  batch_id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  business_id UUID NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  revealed_seed TEXT NOT NULL,
  seed_hash CHAR(64) NOT NULL,
  reveal_hash CHAR(64) NOT NULL,
  revealed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT meta_controlled_seed_reveals_batch_fk FOREIGN KEY
    (batch_id, experiment_id, business_id,
     provider_account_ref_id, provider_account_id)
    REFERENCES meta_controlled_assignment_batches
      (id, experiment_id, business_id,
       provider_account_ref_id, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_seed_reveals_experiment_unique
    UNIQUE (experiment_id),
  CONSTRAINT meta_controlled_seed_reveals_contract_check CHECK (
    contract_version = 'meta-controlled-seed-reveal.v1'
    AND revealed_at = created_at
  )
);

CREATE TABLE IF NOT EXISTS meta_controlled_control_outcome_observations (
  id UUID PRIMARY KEY,
  contract_version TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  control_assignment_id TEXT NOT NULL,
  arm_role TEXT NOT NULL,
  business_id UUID NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  native_outcome_id UUID NOT NULL,
  native_outcome_contract_version TEXT NOT NULL,
  native_outcome_classifier_version TEXT NOT NULL,
  native_outcome_source_manifest_hash CHAR(64) NOT NULL,
  native_outcome_computed_at TIMESTAMPTZ NOT NULL,
  metric_name TEXT NOT NULL,
  metric_direction TEXT NOT NULL,
  window_start_at TIMESTAMPTZ NOT NULL,
  window_end_at TIMESTAMPTZ NOT NULL,
  source_receipt_id TEXT NOT NULL,
  source_receipt_hash CHAR(64) NOT NULL,
  source_receipt_json JSONB NOT NULL,
  metric_value NUMERIC(30,12) NOT NULL,
  sample_size BIGINT NOT NULL,
  observation_status TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL,
  observation_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT meta_controlled_control_observations_account_fk FOREIGN KEY
    (provider_account_ref_id, provider_account_id)
    REFERENCES provider_accounts (id, external_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_control_observations_assignment_fk FOREIGN KEY
    (control_assignment_id, experiment_id, batch_id, arm_role, business_id,
     provider_account_ref_id, provider_account_id)
    REFERENCES meta_controlled_random_assignments
      (id, experiment_id, batch_id, arm_role, business_id,
       provider_account_ref_id, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_control_observations_receipt_unique
    UNIQUE (business_id, provider_account_ref_id,
            provider_account_id, source_receipt_id),
  CONSTRAINT meta_controlled_control_observations_assignment_unique
    UNIQUE (control_assignment_id),
  CONSTRAINT meta_controlled_control_observations_native_outcome_unique
    UNIQUE (native_outcome_id),
  CONSTRAINT meta_controlled_control_observations_native_outcome_fk
    FOREIGN KEY (native_outcome_id)
    REFERENCES engine_v3_ad_decision_outcomes_daily (id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_control_observations_contract_check CHECK (
    contract_version = 'meta-controlled-control-outcome-observation.v1'
    AND arm_role = 'control'
    AND observation_status = 'finalized'
    AND sample_size = 1
    AND source_receipt_id = native_outcome_id::text
    AND source_receipt_hash = native_outcome_source_manifest_hash
    AND jsonb_typeof(source_receipt_json) = 'object'
    AND jsonb_array_length(
      jsonb_path_query_array(source_receipt_json, '$.keyvalue()')
    ) = 5
    AND window_start_at < window_end_at
    AND window_end_at <= observed_at
    AND observed_at = native_outcome_computed_at
    AND observed_at <= as_of
    AND as_of <= finalized_at
    AND finalized_at = created_at
  )
);

CREATE TABLE IF NOT EXISTS meta_controlled_control_estimates (
  id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  treated_assignment_id TEXT NOT NULL,
  treated_arm_role TEXT NOT NULL,
  treated_outcome_log_id UUID NOT NULL,
  treated_native_outcome_id UUID NOT NULL,
  treated_native_outcome_source_manifest_hash CHAR(64) NOT NULL,
  treated_metric_value NUMERIC(30,12) NOT NULL,
  treatment_action_log_id UUID NOT NULL,
  control_arm_id TEXT NOT NULL,
  business_id UUID NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_direction TEXT NOT NULL,
  window_start_at TIMESTAMPTZ NOT NULL,
  window_end_at TIMESTAMPTZ NOT NULL,
  observation_ids UUID[] NOT NULL,
  observation_count INTEGER NOT NULL,
  source_manifest_hash CHAR(64) NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  estimate_value NUMERIC(30,12) NOT NULL,
  sample_size BIGINT NOT NULL,
  estimate_variance NUMERIC(30,12),
  standard_error NUMERIC(30,12),
  confidence_95_lower NUMERIC(30,12),
  confidence_95_upper NUMERIC(30,12),
  estimate_hash CHAR(64) NOT NULL,
  finalized_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT meta_controlled_control_estimates_account_fk FOREIGN KEY
    (provider_account_ref_id, provider_account_id)
    REFERENCES provider_accounts (id, external_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_control_estimates_assignment_fk FOREIGN KEY
    (treated_assignment_id, experiment_id, batch_id, treated_arm_role,
     business_id, provider_account_ref_id, provider_account_id)
    REFERENCES meta_controlled_random_assignments
      (id, experiment_id, batch_id, arm_role,
       business_id, provider_account_ref_id, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_control_estimates_assignment_unique
    UNIQUE (treated_assignment_id),
  CONSTRAINT meta_controlled_control_estimates_outcome_unique
    UNIQUE (treated_outcome_log_id),
  CONSTRAINT meta_controlled_control_estimates_native_outcome_unique
    UNIQUE (treated_native_outcome_id),
  CONSTRAINT meta_controlled_control_estimates_native_outcome_fk
    FOREIGN KEY (treated_native_outcome_id)
    REFERENCES engine_v3_ad_decision_outcomes_daily (id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_controlled_control_estimates_receipt_unique
    UNIQUE (treatment_action_log_id),
  CONSTRAINT meta_controlled_control_estimates_contract_check CHECK (
    contract_version = 'meta-controlled-control-estimate.v2'
    AND treated_arm_role = 'treatment'
    AND observation_count > 1
    AND cardinality(observation_ids) = observation_count
    AND sample_size = observation_count
    AND window_start_at < window_end_at
    AND window_end_at <= as_of
    AND as_of <= finalized_at
    AND finalized_at = created_at
    AND treated_native_outcome_source_manifest_hash ~ '^[0-9a-f]{64}$'
    AND estimate_variance IS NOT NULL
    AND estimate_variance >= 0
    AND standard_error IS NOT NULL
    AND standard_error >= 0
    AND confidence_95_lower IS NOT NULL
    AND confidence_95_upper IS NOT NULL
    AND confidence_95_lower <= estimate_value
    AND estimate_value <= confidence_95_upper
  )
);

DO $ddl$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'meta_ads_action_log'::regclass
      AND conname = 'meta_ads_action_log_controlled_tenant_key'
  ) THEN
    ALTER TABLE meta_ads_action_log
      ADD CONSTRAINT meta_ads_action_log_controlled_tenant_key
      UNIQUE (id, business_id, provider_account_ref_id, provider_account_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'meta_ads_action_log'::regclass
      AND conname = 'meta_ads_action_log_controlled_assignment_fk'
  ) THEN
    ALTER TABLE meta_ads_action_log
      ADD CONSTRAINT meta_ads_action_log_controlled_assignment_fk FOREIGN KEY
      (controlled_assignment_id, business_id, provider_account_ref_id,
       provider_account_id, target_entity_type, target_entity_id,
       action, rec_id_origin, source_snapshot_id, source_evaluation_id)
      REFERENCES meta_controlled_random_assignments
      (id, business_id, provider_account_ref_id, provider_account_id,
       entity_type, entity_id, assigned_action, rec_id,
       snapshot_id, evaluation_id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'meta_ads_action_log'::regclass
      AND conname = 'meta_ads_action_log_controlled_verification_check'
  ) THEN
    ALTER TABLE meta_ads_action_log
      ADD CONSTRAINT meta_ads_action_log_controlled_verification_check CHECK (
        controlled_assignment_id IS NULL OR (
          provider_account_ref_id IS NOT NULL
          AND provider_account_id IS NOT NULL
          AND target_entity_type = 'ad'
          AND target_entity_id IS NOT NULL
          AND source_snapshot_id IS NOT NULL
          AND source_evaluation_id IS NOT NULL
          AND engine_version IS NOT NULL
          AND decision_hash IS NOT NULL
          AND NOT dry_run
          AND executed_at IS NOT NULL
          AND verified_at IS NOT NULL
          AND provider_entity_id IS NOT NULL
          AND provider_action IS NOT NULL
          AND provider_status IS NOT NULL
          AND (
            (provider_action = 'pause' AND provider_status = 'PAUSED')
            OR (provider_action = 'resume' AND provider_status = 'ACTIVE')
          )
          AND provider_observed_at IS NOT NULL
          AND provider_response_hash IS NOT NULL
          AND provider_verification_hash IS NOT NULL
          AND verification_payload IS NOT NULL
          AND jsonb_typeof(verification_payload) = 'object'
          AND jsonb_array_length(
            jsonb_path_query_array(verification_payload, '$.keyvalue()')
          ) = 16
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'meta_decision_action_outcome_logs'::regclass
      AND conname = 'meta_decision_outcome_controlled_tenant_key'
  ) THEN
    ALTER TABLE meta_decision_action_outcome_logs
      ADD CONSTRAINT meta_decision_outcome_controlled_tenant_key
      UNIQUE (id, business_ref_id, provider_account_ref_id, provider_account_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'meta_decision_action_outcome_logs'::regclass
      AND conname = 'meta_decision_outcome_controlled_business_fk'
  ) THEN
    ALTER TABLE meta_decision_action_outcome_logs
      ADD CONSTRAINT meta_decision_outcome_controlled_business_fk FOREIGN KEY
      (business_ref_id) REFERENCES businesses (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'meta_decision_action_outcome_logs'::regclass
      AND conname = 'meta_decision_outcome_controlled_account_fk'
  ) THEN
    ALTER TABLE meta_decision_action_outcome_logs
      ADD CONSTRAINT meta_decision_outcome_controlled_account_fk FOREIGN KEY
      (provider_account_ref_id, provider_account_id)
      REFERENCES provider_accounts (id, external_account_id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'meta_decision_action_outcome_logs'::regclass
      AND conname = 'meta_decision_outcome_controlled_identity_check'
  ) THEN
    ALTER TABLE meta_decision_action_outcome_logs
      ADD CONSTRAINT meta_decision_outcome_controlled_identity_check CHECK (
        payload_json->>'evidenceClass' <> 'controlled_causal'
        OR (
          business_ref_id IS NOT NULL
          AND business_id = business_ref_id::text
          AND provider_account_ref_id IS NOT NULL
          AND provider_account_id IS NOT NULL
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'meta_decision_action_outcome_logs'::regclass
      AND conname = 'meta_decision_outcome_controlled_terminal_status_check'
  ) THEN
    ALTER TABLE meta_decision_action_outcome_logs
      ADD CONSTRAINT meta_decision_outcome_controlled_terminal_status_check CHECK (
        payload_json->>'evidenceClass' <> 'controlled_causal'
        OR (
          action_type = 'outcome'
          AND outcome_status = ANY (ARRAY['positive','negative','neutral']::text[])
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'meta_controlled_control_estimates'::regclass
      AND conname = 'meta_controlled_control_estimates_outcome_fk'
  ) THEN
    ALTER TABLE meta_controlled_control_estimates
      ADD CONSTRAINT meta_controlled_control_estimates_outcome_fk FOREIGN KEY
      (treated_outcome_log_id, business_id,
       provider_account_ref_id, provider_account_id)
      REFERENCES meta_decision_action_outcome_logs
      (id, business_ref_id, provider_account_ref_id, provider_account_id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'meta_controlled_control_estimates'::regclass
      AND conname = 'meta_controlled_control_estimates_action_fk'
  ) THEN
    ALTER TABLE meta_controlled_control_estimates
      ADD CONSTRAINT meta_controlled_control_estimates_action_fk FOREIGN KEY
      (treatment_action_log_id, business_id,
       provider_account_ref_id, provider_account_id)
      REFERENCES meta_ads_action_log
      (id, business_id, provider_account_ref_id, provider_account_id)
      ON DELETE RESTRICT;
  END IF;
END
$ddl$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_ads_action_log_controlled_verified_receipt_unique
  ON meta_ads_action_log (controlled_assignment_id)
  WHERE controlled_assignment_id IS NOT NULL
    AND status = 'success' AND NOT dry_run AND verified_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_decision_outcome_controlled_assignment_unique
  ON meta_decision_action_outcome_logs (
    business_ref_id, provider_account_ref_id, provider_account_id,
    ((payload_json->'causalDesign')->>'assignmentId')
  )
  WHERE action_type = 'outcome'
    AND payload_json->>'evidenceClass' = 'controlled_causal';

CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_decision_outcome_controlled_estimate_unique
  ON meta_decision_action_outcome_logs (
    business_ref_id, provider_account_ref_id, provider_account_id,
    ((payload_json->'causalDesign')->>'estimateId')
  )
  WHERE action_type = 'outcome'
    AND payload_json->>'evidenceClass' = 'controlled_causal';

CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_decision_outcome_controlled_receipt_unique
  ON meta_decision_action_outcome_logs (
    business_ref_id, provider_account_ref_id, provider_account_id,
    ((payload_json->'treatmentReceipt')->>'actionLogId')
  )
  WHERE action_type = 'outcome'
    AND payload_json->>'evidenceClass' = 'controlled_causal';

CREATE OR REPLACE FUNCTION meta_validate_controlled_experiment_account_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM business_provider_accounts binding
    JOIN provider_accounts account
      ON account.id = binding.provider_account_ref_id
     AND account.external_account_id = binding.provider_account_id
     AND account.provider = 'meta'
    WHERE binding.business_id = NEW.business_id::text
      AND binding.provider = 'meta'
      AND binding.provider_account_ref_id = NEW.provider_account_ref_id
      AND binding.provider_account_id = NEW.provider_account_id
  ) THEN
    RAISE EXCEPTION 'controlled experiment account is not assigned to business'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_meta_controlled_experiment_account_guard
  ON meta_controlled_experiments;
CREATE TRIGGER trg_meta_controlled_experiment_account_guard
BEFORE INSERT ON meta_controlled_experiments
FOR EACH ROW EXECUTE FUNCTION meta_validate_controlled_experiment_account_binding();

CREATE OR REPLACE FUNCTION meta_reject_immutable_controlled_registry_write()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION 'controlled registry rows are immutable'
    USING ERRCODE = '55000';
END
$fn$;

DO $ddl$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'meta_controlled_experiments',
    'meta_controlled_experiment_arms',
    'meta_controlled_assignment_batches',
    'meta_controlled_random_assignments',
    'meta_controlled_seed_reveals',
    'meta_controlled_control_outcome_observations',
    'meta_controlled_control_estimates'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',
      'trg_' || table_name || '_immutable', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION meta_reject_immutable_controlled_registry_write()',
      'trg_' || table_name || '_immutable', table_name
    );
  END LOOP;
END
$ddl$;

CREATE OR REPLACE FUNCTION meta_validate_controlled_arm_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  target_experiment_id TEXT := COALESCE(NEW.experiment_id, OLD.experiment_id);
  arm_count INTEGER;
  control_count INTEGER;
  order_count INTEGER;
  minimum_order INTEGER;
  maximum_order INTEGER;
  probability_sum DOUBLE PRECISION;
BEGIN
  SELECT count(*)::int,
         count(*) FILTER (WHERE arm_role = 'control')::int,
         count(DISTINCT allocation_order)::int,
         min(allocation_order), max(allocation_order),
         sum(assignment_probability)
  INTO arm_count, control_count, order_count,
       minimum_order, maximum_order, probability_sum
  FROM meta_controlled_experiment_arms
  WHERE experiment_id = target_experiment_id;

  IF arm_count < 2 OR control_count <> 1 OR order_count <> arm_count
     OR minimum_order <> 0 OR maximum_order <> arm_count - 1
     OR abs(probability_sum - 1::double precision) > 1e-12 THEN
    RAISE EXCEPTION 'controlled arm allocation is incomplete or invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trg_meta_controlled_arms_allocation_guard
  ON meta_controlled_experiment_arms;
CREATE CONSTRAINT TRIGGER trg_meta_controlled_arms_allocation_guard
AFTER INSERT ON meta_controlled_experiment_arms
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION meta_validate_controlled_arm_allocation();

CREATE OR REPLACE FUNCTION meta_validate_controlled_assignment_batch()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  target_batch_id TEXT;
  expected_count INTEGER;
  actual_count INTEGER;
  unique_target_count INTEGER;
  unique_recommendation_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'meta_controlled_assignment_batches' THEN
    target_batch_id := NEW.id;
  ELSE
    target_batch_id := COALESCE(NEW.batch_id, OLD.batch_id);
  END IF;

  SELECT eligibility_count INTO expected_count
  FROM meta_controlled_assignment_batches
  WHERE id = target_batch_id;

  SELECT count(*)::int,
         count(DISTINCT entity_type || E'\x1f' || entity_id)::int,
         count(DISTINCT recommendation_fingerprint || E'\x1f' || rec_id)::int
  INTO actual_count, unique_target_count, unique_recommendation_count
  FROM meta_controlled_random_assignments
  WHERE batch_id = target_batch_id;

  IF expected_count IS NULL OR actual_count <> expected_count
     OR unique_target_count <> expected_count
     OR unique_recommendation_count <> expected_count THEN
    RAISE EXCEPTION 'controlled assignment batch is not the full eligibility set'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trg_meta_controlled_assignment_batch_guard
  ON meta_controlled_random_assignments;
CREATE CONSTRAINT TRIGGER trg_meta_controlled_assignment_batch_guard
AFTER INSERT ON meta_controlled_random_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION meta_validate_controlled_assignment_batch();

DROP TRIGGER IF EXISTS trg_meta_controlled_assignment_batch_header_guard
  ON meta_controlled_assignment_batches;
CREATE CONSTRAINT TRIGGER trg_meta_controlled_assignment_batch_header_guard
AFTER INSERT ON meta_controlled_assignment_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION meta_validate_controlled_assignment_batch();

CREATE OR REPLACE FUNCTION meta_validate_controlled_seed_reveal()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  expected_seed_hash TEXT;
  invalid_assignment_count INTEGER;
BEGIN
  expected_seed_hash := encode(digest(concat_ws(E'\x1f',
    'meta-controlled-experiment.v2', NEW.experiment_id, NEW.revealed_seed
  ), 'sha256'), 'hex');
  IF NEW.seed_hash <> expected_seed_hash OR NOT EXISTS (
    SELECT 1 FROM meta_controlled_experiments experiment
    WHERE experiment.id = NEW.experiment_id
      AND experiment.seed_commitment_hash = expected_seed_hash
  ) THEN
    RAISE EXCEPTION 'controlled seed reveal does not match its commitment'
      USING ERRCODE = '23514';
  END IF;

  WITH arm_ranges AS (
    SELECT
      arm.*,
      sum(arm.assignment_probability) OVER (
        PARTITION BY arm.experiment_id
        ORDER BY arm.allocation_order, arm.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) - arm.assignment_probability AS lower_bound,
      sum(arm.assignment_probability) OVER (
        PARTITION BY arm.experiment_id
        ORDER BY arm.allocation_order, arm.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS upper_bound
    FROM meta_controlled_experiment_arms arm
    WHERE arm.experiment_id = NEW.experiment_id
  ), proof_material AS (
    SELECT
      assignment.*,
      batch.eligibility_hash AS batch_eligibility_hash,
      experiment.seed_commitment_hash AS experiment_seed_hash,
      encode(digest(
        '{"algorithm":' || to_json(assignment.randomization_algorithm)::text ||
        ',"businessId":' || to_json(assignment.business_id::text)::text ||
        ',"experimentId":' || to_json(assignment.experiment_id)::text ||
        ',"providerAccountId":' || to_json(assignment.provider_account_id)::text ||
        ',"seed":' || to_json(NEW.revealed_seed)::text ||
        ',"target":{"entityId":' || to_json(assignment.entity_id)::text ||
        ',"entityType":' || to_json(assignment.entity_type)::text || '}}',
        'sha256'), 'hex') AS expected_proof_hash
    FROM meta_controlled_random_assignments assignment
    JOIN meta_controlled_assignment_batches batch
      ON batch.id = assignment.batch_id
     AND batch.experiment_id = assignment.experiment_id
     AND batch.business_id = assignment.business_id
     AND batch.provider_account_ref_id = assignment.provider_account_ref_id
     AND batch.provider_account_id = assignment.provider_account_id
    JOIN meta_controlled_experiments experiment
      ON experiment.id = assignment.experiment_id
     AND experiment.business_id = assignment.business_id
     AND experiment.provider_account_ref_id = assignment.provider_account_ref_id
     AND experiment.provider_account_id = assignment.provider_account_id
    WHERE assignment.batch_id = NEW.batch_id
  ), reproduced AS (
    SELECT proof.*,
      (
        ('x' || substr(proof.expected_proof_hash, 1, 12))::bit(48)::bigint
      )::double precision / 281474976710656::double precision AS expected_draw
    FROM proof_material proof
  )
  SELECT count(*)::int INTO invalid_assignment_count
  FROM reproduced assignment
  LEFT JOIN arm_ranges arm
    ON arm.id = assignment.arm_id
   AND arm.experiment_id = assignment.experiment_id
   AND arm.business_id = assignment.business_id
   AND arm.provider_account_ref_id = assignment.provider_account_ref_id
   AND arm.provider_account_id = assignment.provider_account_id
  WHERE assignment.randomization_proof_hash <> assignment.expected_proof_hash
    OR assignment.randomization_draw <> assignment.expected_draw
    OR assignment.randomization_algorithm <> 'sha256-threshold-v1'
    OR assignment.seed_commitment_hash <> assignment.experiment_seed_hash
    OR assignment.seed_commitment_hash <> NEW.seed_hash
    OR assignment.eligibility_hash <> assignment.batch_eligibility_hash
    OR arm.id IS NULL
    OR assignment.expected_draw < arm.lower_bound
    OR assignment.expected_draw >= arm.upper_bound
    OR assignment.arm_role <> arm.arm_role
    OR assignment.assignment_probability <> arm.assignment_probability
    OR assignment.assigned_action IS DISTINCT FROM arm.treatment_action;
  IF invalid_assignment_count <> 0 THEN
    RAISE EXCEPTION 'controlled assignments do not reproduce from revealed seed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_meta_controlled_seed_reveal_guard
  ON meta_controlled_seed_reveals;
CREATE TRIGGER trg_meta_controlled_seed_reveal_guard
BEFORE INSERT ON meta_controlled_seed_reveals
FOR EACH ROW EXECUTE FUNCTION meta_validate_controlled_seed_reveal();

CREATE OR REPLACE FUNCTION meta_validate_controlled_control_observation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  assignment_row meta_controlled_random_assignments%ROWTYPE;
  experiment_row meta_controlled_experiments%ROWTYPE;
  native_outcome_row engine_v3_ad_decision_outcomes_daily%ROWTYPE;
  expected_metric NUMERIC(30,12);
  expected_receipt JSONB;
  expected_hash TEXT;
BEGIN
  SELECT * INTO assignment_row
  FROM meta_controlled_random_assignments assignment
  WHERE assignment.id = NEW.control_assignment_id
    AND assignment.experiment_id = NEW.experiment_id
    AND assignment.batch_id = NEW.batch_id
    AND assignment.arm_role = 'control'
    AND assignment.assigned_action IS NULL
    AND assignment.business_id = NEW.business_id
    AND assignment.provider_account_ref_id = NEW.provider_account_ref_id
    AND assignment.provider_account_id = NEW.provider_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control observation is not bound to a control assignment'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO experiment_row
  FROM meta_controlled_experiments experiment
  WHERE experiment.id = NEW.experiment_id
    AND experiment.business_id = NEW.business_id
    AND experiment.provider_account_ref_id = NEW.provider_account_ref_id
    AND experiment.provider_account_id = NEW.provider_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control observation is not bound to its experiment'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO native_outcome_row
  FROM engine_v3_ad_decision_outcomes_daily native_outcome
  WHERE native_outcome.id = NEW.native_outcome_id
    AND native_outcome.decision_snapshot_id = assignment_row.snapshot_id
    AND native_outcome.evaluation_id = assignment_row.evaluation_id
    AND native_outcome.business_ref_id = assignment_row.business_id
    AND native_outcome.business_id = assignment_row.business_id::text
    AND native_outcome.provider_account_id = assignment_row.provider_account_id
    AND native_outcome.decision_entity_type = assignment_row.entity_type
    AND native_outcome.decision_entity_id = assignment_row.entity_id
    AND native_outcome.ad_id = assignment_row.entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control observation native outcome lineage is invalid'
      USING ERRCODE = '23514';
  END IF;

  expected_metric := CASE experiment_row.primary_metric
    WHEN 'outcome_roas' THEN native_outcome_row.outcome_roas::numeric(30,12)
    WHEN 'outcome_revenue' THEN native_outcome_row.outcome_revenue::numeric(30,12)
    WHEN 'outcome_purchases' THEN native_outcome_row.outcome_purchases::numeric(30,12)
    WHEN 'outcome_spend' THEN native_outcome_row.outcome_spend::numeric(30,12)
    ELSE NULL
  END;
  expected_receipt := jsonb_build_object(
    'contractVersion', 'meta-controlled-source-receipt.v1',
    'nativeOutcomeId', native_outcome_row.id::text,
    'sourceManifestHash', native_outcome_row.source_manifest_hash,
    'computedAt', to_char(native_outcome_row.computed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'metricName', experiment_row.primary_metric
  );
  expected_hash := encode(digest(concat_ws(E'\x1f',
    NEW.contract_version, NEW.id::text, NEW.experiment_id, NEW.batch_id,
    NEW.control_assignment_id, NEW.native_outcome_id::text,
    NEW.native_outcome_contract_version,
    NEW.native_outcome_classifier_version,
    NEW.native_outcome_source_manifest_hash,
    to_char(NEW.native_outcome_computed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    NEW.metric_name, NEW.metric_direction,
    to_char(NEW.window_start_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(NEW.window_end_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    NEW.metric_value::text,
    to_char(NEW.observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(NEW.as_of AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ), 'sha256'), 'hex');

  IF expected_metric IS NULL
     OR NEW.metric_name <> experiment_row.primary_metric
     OR NEW.metric_direction <> experiment_row.metric_direction
     OR NEW.window_start_at <> experiment_row.outcome_window_start_at
     OR NEW.window_end_at <> experiment_row.outcome_window_end_at
     OR native_outcome_row.outcome_window_start <>
        (NEW.window_start_at AT TIME ZONE 'UTC')::date
     OR native_outcome_row.outcome_window_end <>
        (NEW.window_end_at AT TIME ZONE 'UTC')::date
     OR NOT native_outcome_row.window_complete
     OR native_outcome_row.measurement_status <> 'known'
     OR native_outcome_row.realized_outcome <>
        ALL (ARRAY['positive','negative','neutral']::text[])
     OR native_outcome_row.action_contaminated
     OR native_outcome_row.action_source_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(native_outcome_row.source_receipts_json)
        IS DISTINCT FROM 'object'
     OR jsonb_typeof(
          native_outcome_row.source_receipts_json->'verifiedActions'
        ) IS DISTINCT FROM 'array'
     OR jsonb_array_length(
          native_outcome_row.source_receipts_json->'verifiedActions'
        ) <> 0
     OR native_outcome_row.computed_at < NEW.window_end_at
     OR native_outcome_row.computed_at > experiment_row.ends_at
     OR NEW.as_of <> experiment_row.ends_at
     OR NEW.finalized_at < experiment_row.ends_at
     OR NEW.native_outcome_contract_version <> native_outcome_row.contract_version
     OR NEW.native_outcome_classifier_version <> native_outcome_row.classifier_version
     OR NEW.native_outcome_source_manifest_hash <>
        native_outcome_row.source_manifest_hash
     OR NEW.native_outcome_computed_at <> native_outcome_row.computed_at
     OR NEW.observed_at <> native_outcome_row.computed_at
     OR NEW.source_receipt_id <> native_outcome_row.id::text
     OR NEW.source_receipt_hash <> native_outcome_row.source_manifest_hash
     OR NEW.source_receipt_json IS DISTINCT FROM expected_receipt
     OR NEW.metric_value <> expected_metric
     OR NEW.observation_hash <> expected_hash THEN
    RAISE EXCEPTION 'control observation does not match its immutable native outcome'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_meta_controlled_control_observation_native_guard
  ON meta_controlled_control_outcome_observations;
CREATE TRIGGER trg_meta_controlled_control_observation_native_guard
BEFORE INSERT ON meta_controlled_control_outcome_observations
FOR EACH ROW EXECUTE FUNCTION meta_validate_controlled_control_observation();

CREATE OR REPLACE FUNCTION meta_prevent_verified_controlled_action_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  expected_payload JSONB;
  expected_hash TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.controlled_assignment_id IS NOT NULL THEN
      RAISE EXCEPTION 'verified controlled action receipts are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.controlled_assignment_id IS NOT NULL THEN
    RAISE EXCEPTION 'verified controlled action receipts are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.controlled_assignment_id IS NULL THEN
    RETURN NEW;
  END IF;

  expected_payload := jsonb_build_object(
    'contractVersion', 'meta-provider-verification.v1',
    'actionLogId', NEW.id::text,
    'controlledAssignmentId', NEW.controlled_assignment_id,
    'businessId', NEW.business_id::text,
    'providerAccountRefId', NEW.provider_account_ref_id::text,
    'providerAccountId', NEW.provider_account_id,
    'snapshotId', NEW.source_snapshot_id::text,
    'evaluationId', NEW.source_evaluation_id::text,
    'engineVersion', NEW.engine_version,
    'decisionHash', NEW.decision_hash,
    'entityType', NEW.target_entity_type,
    'entityId', NEW.target_entity_id,
    'action', NEW.provider_action,
    'status', NEW.provider_status,
    'observedAt', to_char(NEW.provider_observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'responseHash', NEW.provider_response_hash
  );
  expected_hash := encode(digest(concat_ws(E'\x1f',
    'meta-provider-verification.v1', NEW.id::text,
    NEW.controlled_assignment_id, NEW.business_id::text,
    NEW.provider_account_ref_id::text, NEW.provider_account_id,
    NEW.source_snapshot_id::text, NEW.source_evaluation_id::text,
    NEW.engine_version, NEW.decision_hash, NEW.target_entity_type,
    NEW.target_entity_id, NEW.provider_action, NEW.provider_status,
    to_char(NEW.provider_observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    NEW.provider_response_hash
  ), 'sha256'), 'hex');

  IF NEW.verification_payload IS DISTINCT FROM expected_payload
     OR NEW.provider_verification_hash IS DISTINCT FROM expected_hash
     OR NOT (
       (NEW.provider_action = 'pause' AND NEW.provider_status = 'PAUSED')
       OR (NEW.provider_action = 'resume' AND NEW.provider_status = 'ACTIVE')
     ) THEN
    RAISE EXCEPTION 'controlled provider verification is not the typed receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_meta_ads_action_log_controlled_verified_immutable
  ON meta_ads_action_log;
CREATE TRIGGER trg_meta_ads_action_log_controlled_verified_immutable
BEFORE INSERT OR UPDATE OR DELETE ON meta_ads_action_log
FOR EACH ROW EXECUTE FUNCTION meta_prevent_verified_controlled_action_mutation();

CREATE OR REPLACE FUNCTION meta_prevent_bound_controlled_outcome_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM meta_controlled_control_estimates estimate
    WHERE estimate.treated_outcome_log_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'estimate-bound controlled outcome logs are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_meta_decision_controlled_outcome_immutable
  ON meta_decision_action_outcome_logs;
CREATE TRIGGER trg_meta_decision_controlled_outcome_immutable
BEFORE UPDATE OR DELETE ON meta_decision_action_outcome_logs
FOR EACH ROW EXECUTE FUNCTION meta_prevent_bound_controlled_outcome_mutation();
`;

export const CONTROLLED_REGISTRY_SCHEMA_SQL_SHA256 = createHash("sha256")
  .update(CONTROLLED_REGISTRY_SCHEMA_SQL, "utf8")
  .digest("hex");

function triggerFunctionSourceFromSchema(functionName: string) {
  const marker = `CREATE OR REPLACE FUNCTION ${functionName}()`;
  const start = CONTROLLED_REGISTRY_SCHEMA_SQL.indexOf(marker);
  if (start < 0)
    throw new Error(`Missing controlled trigger function ${functionName}.`);
  const bodyStart = CONTROLLED_REGISTRY_SCHEMA_SQL.indexOf("AS $fn$", start);
  const bodyEnd = CONTROLLED_REGISTRY_SCHEMA_SQL.indexOf("$fn$;", bodyStart);
  if (bodyStart < 0 || bodyEnd < 0) {
    throw new Error(`Malformed controlled trigger function ${functionName}.`);
  }
  return CONTROLLED_REGISTRY_SCHEMA_SQL.slice(
    bodyStart + "AS $fn$".length,
    bodyEnd,
  ).trim();
}

const CONTROLLED_TRIGGER_SHAPES: Record<
  string,
  Omit<TriggerRequirement, "table" | "name" | "enabled">
> = {
  meta_validate_controlled_experiment_account_binding: {
    functionName: "meta_validate_controlled_experiment_account_binding",
    timing: "BEFORE",
    events: ["INSERT"],
    rowLevel: true,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
    functionSource: triggerFunctionSourceFromSchema(
      "meta_validate_controlled_experiment_account_binding",
    ),
  },
  meta_reject_immutable_controlled_registry_write: {
    functionName: "meta_reject_immutable_controlled_registry_write",
    timing: "BEFORE",
    events: ["DELETE", "UPDATE"],
    rowLevel: true,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
    functionSource: triggerFunctionSourceFromSchema(
      "meta_reject_immutable_controlled_registry_write",
    ),
  },
  meta_validate_controlled_arm_allocation: {
    functionName: "meta_validate_controlled_arm_allocation",
    timing: "AFTER",
    events: ["INSERT"],
    rowLevel: true,
    constraint: true,
    deferrable: true,
    initiallyDeferred: true,
    functionSource: triggerFunctionSourceFromSchema(
      "meta_validate_controlled_arm_allocation",
    ),
  },
  meta_validate_controlled_assignment_batch: {
    functionName: "meta_validate_controlled_assignment_batch",
    timing: "AFTER",
    events: ["INSERT"],
    rowLevel: true,
    constraint: true,
    deferrable: true,
    initiallyDeferred: true,
    functionSource: triggerFunctionSourceFromSchema(
      "meta_validate_controlled_assignment_batch",
    ),
  },
  meta_validate_controlled_seed_reveal: {
    functionName: "meta_validate_controlled_seed_reveal",
    timing: "BEFORE",
    events: ["INSERT"],
    rowLevel: true,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
    functionSource: triggerFunctionSourceFromSchema(
      "meta_validate_controlled_seed_reveal",
    ),
  },
  meta_validate_controlled_control_observation: {
    functionName: "meta_validate_controlled_control_observation",
    timing: "BEFORE",
    events: ["INSERT"],
    rowLevel: true,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
    functionSource: triggerFunctionSourceFromSchema(
      "meta_validate_controlled_control_observation",
    ),
  },
  meta_prevent_verified_controlled_action_mutation: {
    functionName: "meta_prevent_verified_controlled_action_mutation",
    timing: "BEFORE",
    events: ["INSERT", "DELETE", "UPDATE"],
    rowLevel: true,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
    functionSource: triggerFunctionSourceFromSchema(
      "meta_prevent_verified_controlled_action_mutation",
    ),
  },
  meta_prevent_bound_controlled_outcome_mutation: {
    functionName: "meta_prevent_bound_controlled_outcome_mutation",
    timing: "BEFORE",
    events: ["DELETE", "UPDATE"],
    rowLevel: true,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
    functionSource: triggerFunctionSourceFromSchema(
      "meta_prevent_bound_controlled_outcome_mutation",
    ),
  },
};

for (const trigger of CONTROLLED_REGISTRY_SCHEMA_CONTRACT.triggers) {
  Object.assign(trigger, CONTROLLED_TRIGGER_SHAPES[trigger.functionName]);
}

export type ControlledRegistryQuery = <
  Row extends Record<string, unknown> = Record<string, unknown>,
>(
  sql: string,
  params?: readonly unknown[],
) => Promise<Row[]>;

export type ControlledRegistryTransaction = <T>(
  operation: (query: ControlledRegistryQuery) => Promise<T>,
) => Promise<T>;

export interface ControlledRegistryStoreOptions {
  query?: ControlledRegistryQuery;
  transaction?: ControlledRegistryTransaction;
}

interface CapabilityRow extends Record<string, unknown> {
  capability_kind: "column" | "constraint" | "extension" | "index" | "trigger";
  table_name: string | null;
  capability_name: string;
  details: Record<string, unknown> | string;
}

const CAPABILITY_SQL = `
  SELECT
    'extension'::text AS capability_kind,
    NULL::text AS table_name,
    extension.extname AS capability_name,
    jsonb_build_object('version', extension.extversion) AS details
  FROM pg_extension extension
  WHERE extension.extname = ANY($1::text[])

  UNION ALL

  SELECT
    'column'::text,
    relation.relname,
    attribute.attname,
    jsonb_build_object(
      'type', format_type(attribute.atttypid, attribute.atttypmod),
      'notNull', attribute.attnotnull
    )
  FROM pg_attribute attribute
  JOIN pg_class relation ON relation.oid = attribute.attrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname = current_schema()
    AND relation.relname = ANY($2::text[])
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped

  UNION ALL

  SELECT
    'constraint'::text,
    relation.relname,
    constraint_row.conname,
    jsonb_build_object(
      'type', constraint_row.contype::text,
      'validated', constraint_row.convalidated,
      'definition', pg_get_constraintdef(constraint_row.oid, true)
    )
  FROM pg_constraint constraint_row
  JOIN pg_class relation ON relation.oid = constraint_row.conrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname = current_schema()
    AND relation.relname = ANY($2::text[])

  UNION ALL

  SELECT
    'index'::text,
    relation.relname,
    index_relation.relname,
    jsonb_build_object(
      'unique', index_row.indisunique,
      'valid', index_row.indisvalid,
      'keys', (
        SELECT jsonb_agg(
          pg_get_indexdef(index_row.indexrelid, key_number, true)
          ORDER BY key_number
        )
        FROM generate_series(1, index_row.indnkeyatts) key_number
      ),
      'predicate', pg_get_expr(index_row.indpred, index_row.indrelid, true)
    )
  FROM pg_index index_row
  JOIN pg_class relation ON relation.oid = index_row.indrelid
  JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname = current_schema()
    AND relation.relname = ANY($2::text[])

  UNION ALL

  SELECT
    'trigger'::text,
    relation.relname,
    trigger_row.tgname,
    jsonb_build_object(
      'enabled', trigger_row.tgenabled::text,
      'functionName', procedure.proname,
      'timing', CASE
        WHEN (trigger_row.tgtype & 2) <> 0 THEN 'BEFORE'
        WHEN (trigger_row.tgtype & 64) <> 0 THEN 'INSTEAD OF'
        ELSE 'AFTER'
      END,
      'events', array_remove(ARRAY[
        CASE WHEN (trigger_row.tgtype & 4) <> 0 THEN 'INSERT' END,
        CASE WHEN (trigger_row.tgtype & 8) <> 0 THEN 'DELETE' END,
        CASE WHEN (trigger_row.tgtype & 16) <> 0 THEN 'UPDATE' END,
        CASE WHEN (trigger_row.tgtype & 32) <> 0 THEN 'TRUNCATE' END
      ], NULL),
      'rowLevel', (trigger_row.tgtype & 1) <> 0,
      'constraint', trigger_row.tgconstraint <> 0,
      'deferrable', trigger_row.tgdeferrable,
      'initiallyDeferred', trigger_row.tginitdeferred,
      'functionSource', procedure.prosrc
    )
  FROM pg_trigger trigger_row
  JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
  JOIN pg_proc procedure ON procedure.oid = trigger_row.tgfoid
  WHERE namespace_row.nspname = current_schema()
    AND relation.relname = ANY($2::text[])
    AND NOT trigger_row.tgisinternal
`;

function queryDefault<Row extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
) {
  return getDb().query<Row>(sql, [...params]);
}

function details(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeSql(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stringArray(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function capabilityTables() {
  return Array.from(
    new Set([
      ...CONTROLLED_REGISTRY_SCHEMA_CONTRACT.columns.map(
        (entry) => entry.table,
      ),
      ...CONTROLLED_REGISTRY_SCHEMA_CONTRACT.constraints.map(
        (entry) => entry.table,
      ),
      ...CONTROLLED_REGISTRY_SCHEMA_CONTRACT.indexes.map(
        (entry) => entry.table,
      ),
      ...CONTROLLED_REGISTRY_SCHEMA_CONTRACT.triggers.map(
        (entry) => entry.table,
      ),
    ]),
  );
}

function inspectCapabilityRows(
  rows: CapabilityRow[],
): ControlledRegistryCapabilities {
  const issues: string[] = [];
  const byKey = new Map(
    rows.map((row) => [
      `${row.capability_kind}:${row.table_name ?? ""}:${row.capability_name}`,
      details(row.details),
    ]),
  );
  for (const extension of CONTROLLED_REGISTRY_SCHEMA_CONTRACT.extensions) {
    if (!byKey.has(`extension::${extension}`)) {
      issues.push(`missing_extension:${extension}`);
    }
  }
  for (const expected of CONTROLLED_REGISTRY_SCHEMA_CONTRACT.columns) {
    const key = `column:${expected.table}:${expected.column}`;
    const actual = byKey.get(key);
    if (!actual) {
      issues.push(`missing_column:${expected.table}.${expected.column}`);
      continue;
    }
    if (
      normalizeSql(actual.type) !== normalizeSql(expected.type) ||
      actual.notNull !== expected.notNull
    ) {
      issues.push(
        `column_contract_mismatch:${expected.table}.${expected.column}:expected=${expected.type}/${expected.notNull}:actual=${String(actual.type)}/${String(actual.notNull)}`,
      );
    }
  }
  for (const expected of CONTROLLED_REGISTRY_SCHEMA_CONTRACT.constraints) {
    const key = `constraint:${expected.table}:${expected.name}`;
    const actual = byKey.get(key);
    if (!actual) {
      issues.push(`missing_constraint:${expected.table}.${expected.name}`);
      continue;
    }
    if (
      actual.type !== expected.type ||
      actual.validated !== true ||
      normalizeSql(actual.definition) !== normalizeSql(expected.definition)
    ) {
      issues.push(
        `constraint_contract_mismatch:${expected.table}.${expected.name}:expected=${expected.type}/validated/${normalizeSql(expected.definition)}:actual=${String(actual.type)}/${String(actual.validated)}/${normalizeSql(actual.definition)}`,
      );
    }
  }
  for (const expected of CONTROLLED_REGISTRY_SCHEMA_CONTRACT.indexes) {
    const key = `index:${expected.table}:${expected.name}`;
    const actual = byKey.get(key);
    if (!actual) {
      issues.push(`missing_index:${expected.table}.${expected.name}`);
      continue;
    }
    const actualKeys = stringArray(actual.keys).map(normalizeSql);
    if (
      actual.unique !== expected.unique ||
      actual.valid !== true ||
      JSON.stringify(actualKeys) !==
        JSON.stringify(expected.keys.map(normalizeSql)) ||
      normalizeSql(actual.predicate) !== normalizeSql(expected.predicate)
    ) {
      issues.push(
        `index_contract_mismatch:${expected.table}.${expected.name}:expected=${expected.unique}/${expected.keys.join(",")}/${normalizeSql(expected.predicate)}:actual=${String(actual.unique)}/${actualKeys.join(",")}/${normalizeSql(actual.predicate)}`,
      );
    }
  }
  for (const expected of CONTROLLED_REGISTRY_SCHEMA_CONTRACT.triggers) {
    const key = `trigger:${expected.table}:${expected.name}`;
    const actual = byKey.get(key);
    if (!actual) {
      issues.push(`missing_trigger:${expected.table}.${expected.name}`);
      continue;
    }
    if (
      actual.enabled !== expected.enabled ||
      actual.functionName !== expected.functionName ||
      actual.timing !== expected.timing ||
      JSON.stringify(stringArray(actual.events)) !==
        JSON.stringify(expected.events) ||
      actual.rowLevel !== expected.rowLevel ||
      actual.constraint !== expected.constraint ||
      actual.deferrable !== expected.deferrable ||
      actual.initiallyDeferred !== expected.initiallyDeferred ||
      normalizeSql(actual.functionSource) !==
        normalizeSql(expected.functionSource)
    ) {
      issues.push(
        `trigger_contract_mismatch:${expected.table}.${expected.name}:expected=${expected.functionName}/${expected.enabled}/${expected.timing}/${expected.events?.join(",")}:actual=${String(actual.functionName)}/${String(actual.enabled)}/${String(actual.timing)}/${stringArray(actual.events).join(",")}`,
      );
    }
  }
  return { ready: issues.length === 0, issues };
}

function databaseTimestamp(value: unknown, field: string) {
  if (value instanceof Date) return value.toISOString();
  return requiredTimestamp(value, field);
}

function databaseErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

function conflictFromDatabase(
  error: unknown,
  code: string,
  message: string,
): never {
  if (["23503", "23505", "23514", "P0001"].includes(databaseErrorCode(error))) {
    throw new ControlledRegistryConflictError(code, message);
  }
  throw error;
}

function parseRegisteredArms(value: unknown): ControlledArmRecord[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (JSON.parse(value) as unknown[])
      : [];
  const arms = raw.map((entry, index) => {
    const row = details(entry);
    const arm: ControlledArmRecord = {
      armId: requiredString(row.armId, `registeredArms[${index}].armId`),
      role: requiredString(
        row.role,
        `registeredArms[${index}].role`,
      ) as ControlledArmRole,
      allocationOrder: Number(row.allocationOrder),
      assignmentProbability: Number(row.assignmentProbability),
      treatmentAction:
        typeof row.treatmentAction === "string" && row.treatmentAction.trim()
          ? row.treatmentAction.trim()
          : null,
      armHash: requiredHash(row.armHash, `registeredArms[${index}].armHash`),
    };
    const expectedHash = controlledSha256({
      contractVersion: CONTROLLED_ARM_VERSION,
      experimentId: requiredString(
        row.experimentId,
        `registeredArms[${index}].experimentId`,
      ),
      armId: arm.armId,
      role: arm.role,
      allocationOrder: arm.allocationOrder,
      assignmentProbability: arm.assignmentProbability,
      treatmentAction: arm.treatmentAction,
    });
    if (expectedHash !== arm.armHash) {
      throw new ControlledRegistryValidationError(
        "registered_arm_hash_mismatch",
        `Registered arm ${arm.armId} failed its hash check.`,
      );
    }
    return arm;
  });
  const normalized = normalizeArms(
    requiredString(details(raw[0]).experimentId, "registeredExperimentId"),
    arms,
  );
  if (normalized.some((arm, index) => arm.armHash !== arms[index]?.armHash)) {
    throw new ControlledRegistryValidationError(
      "registered_arm_contract_mismatch",
      "Registered arms do not match their canonical contract.",
    );
  }
  return arms.sort(
    (left, right) => left.allocationOrder - right.allocationOrder,
  );
}

function normalizedScope(input: {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
}) {
  return {
    businessId: requiredUuid(input.businessId, "businessId"),
    providerAccountRefId: requiredUuid(
      input.providerAccountRefId,
      "providerAccountRefId",
    ),
    providerAccountId: requiredString(
      input.providerAccountId,
      "providerAccountId",
    ),
  };
}

function buildExperimentRegistration(
  input: PreregisterControlledExperimentInput,
) {
  const scope = normalizedScope(input);
  const experimentId = requiredString(input.experimentId, "experimentId");
  const startsAt = requiredTimestamp(input.startsAt, "startsAt");
  const outcomeWindowStartAt = requiredTimestamp(
    input.outcomeWindowStartAt,
    "outcomeWindowStartAt",
  );
  const outcomeWindowEndAt = requiredTimestamp(
    input.outcomeWindowEndAt,
    "outcomeWindowEndAt",
  );
  const endsAt = requiredTimestamp(input.endsAt, "endsAt");
  if (
    !outcomeWindowStartAt.endsWith("T00:00:00.000Z") ||
    !outcomeWindowEndAt.endsWith("T00:00:00.000Z")
  ) {
    throw new ControlledRegistryValidationError(
      "non_canonical_outcome_window",
      "Controlled outcome windows must use UTC-midnight boundaries matching native outcome dates.",
    );
  }
  if (
    Date.parse(startsAt) > Date.parse(outcomeWindowStartAt) ||
    Date.parse(outcomeWindowStartAt) >= Date.parse(outcomeWindowEndAt) ||
    Date.parse(outcomeWindowEndAt) > Date.parse(endsAt)
  ) {
    throw new ControlledRegistryValidationError(
      "invalid_experiment_window",
      "The preregistered outcome window must be inside the experiment window.",
    );
  }
  const randomizationUnit = requiredEntityType(
    input.randomizationUnit,
    "randomizationUnit",
  );
  if (randomizationUnit !== "ad") {
    throw new ControlledRegistryValidationError(
      "unsupported_controlled_randomization_unit",
      "Controlled authority is currently available only for native ad decisions.",
    );
  }
  const eligibility = buildEligibilityContract(input.eligibilityManifest);
  if (
    eligibility.manifest.some(
      (entry) => entry.target.entityType !== randomizationUnit,
    )
  ) {
    throw new ControlledRegistryValidationError(
      "eligibility_unit_mismatch",
      "Every eligible target must use the preregistered randomization unit.",
    );
  }
  const arms = normalizeArms(experimentId, input.arms);
  const base = {
    contractVersion: CONTROLLED_EXPERIMENT_VERSION,
    experimentId,
    ...scope,
    name: requiredString(input.name, "name"),
    hypothesis: requiredString(input.hypothesis, "hypothesis"),
    primaryMetric: requiredMetricName(input.primaryMetric, "primaryMetric"),
    metricDirection: requiredDirection(
      input.metricDirection,
      "metricDirection",
    ),
    randomizationUnit,
    randomizationAlgorithm: CONTROLLED_RANDOMIZATION_ALGORITHM,
    seedCommitmentHash: requiredHash(
      input.seedCommitmentHash,
      "seedCommitmentHash",
    ),
    eligibilityCount: eligibility.eligibilityCount,
    eligibilityHash: eligibility.eligibilityHash,
    assignmentManifestHash: eligibility.assignmentManifestHash,
    startsAt,
    outcomeWindowStartAt,
    outcomeWindowEndAt,
    endsAt,
    arms,
  };
  return {
    ...base,
    eligibilityManifest: eligibility.manifest,
    registrationHash: controlledSha256(base),
  };
}

const READ_REGISTERED_EXPERIMENT_SQL = `
  SELECT
    experiment.*,
    arms.rows AS arms_json
  FROM meta_controlled_experiments experiment
  JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'experimentId', arm.experiment_id,
        'armId', arm.id,
        'role', arm.arm_role,
        'allocationOrder', arm.allocation_order,
        'assignmentProbability', arm.assignment_probability,
        'treatmentAction', arm.treatment_action,
        'armHash', arm.arm_hash
      ) ORDER BY arm.allocation_order, arm.id
    ) AS rows
    FROM meta_controlled_experiment_arms arm
    WHERE arm.experiment_id = experiment.id
      AND arm.business_id = experiment.business_id
      AND arm.provider_account_ref_id = experiment.provider_account_ref_id
      AND arm.provider_account_id = experiment.provider_account_id
  ) arms ON arms.rows IS NOT NULL
  WHERE experiment.id = $1
    AND experiment.business_id = $2::uuid
    AND experiment.provider_account_ref_id = $3::uuid
    AND experiment.provider_account_id = $4
  FOR SHARE OF experiment
`;

function mapExperimentRow(
  row: Record<string, unknown>,
): ControlledExperimentRecord {
  return {
    experimentId: requiredString(row.id, "experiment.id"),
    businessId: requiredUuid(row.business_id, "experiment.businessId"),
    providerAccountRefId: requiredUuid(
      row.provider_account_ref_id,
      "experiment.providerAccountRefId",
    ),
    providerAccountId: requiredString(
      row.provider_account_id,
      "experiment.providerAccountId",
    ),
    primaryMetric: requiredMetricName(
      row.primary_metric,
      "experiment.primaryMetric",
    ),
    metricDirection: requiredDirection(
      row.metric_direction,
      "experiment.metricDirection",
    ),
    randomizationUnit: requiredEntityType(
      row.randomization_unit,
      "experiment.randomizationUnit",
    ),
    seedCommitmentHash: requiredHash(
      row.seed_commitment_hash,
      "experiment.seedCommitmentHash",
    ),
    eligibilityCount: Number(row.eligibility_count),
    eligibilityHash: requiredHash(
      row.eligibility_hash,
      "experiment.eligibilityHash",
    ),
    assignmentManifestHash: requiredHash(
      row.assignment_manifest_hash,
      "experiment.assignmentManifestHash",
    ),
    startsAt: databaseTimestamp(row.starts_at, "experiment.startsAt"),
    outcomeWindowStartAt: databaseTimestamp(
      row.outcome_window_start_at,
      "experiment.outcomeWindowStartAt",
    ),
    outcomeWindowEndAt: databaseTimestamp(
      row.outcome_window_end_at,
      "experiment.outcomeWindowEndAt",
    ),
    endsAt: databaseTimestamp(row.ends_at, "experiment.endsAt"),
    registrationHash: requiredHash(
      row.registration_hash,
      "experiment.registrationHash",
    ),
    preregisteredAt: databaseTimestamp(
      row.preregistered_at,
      "experiment.preregisteredAt",
    ),
    arms: parseRegisteredArms(row.arms_json),
  };
}

export function createControlledExperimentRegistryStore(
  options: ControlledRegistryStoreOptions = {},
) {
  if (Boolean(options.query) !== Boolean(options.transaction)) {
    throw new ControlledRegistryValidationError(
      "transaction_adapter_required",
      "Custom controlled-registry queries require an explicitly bound transaction adapter.",
    );
  }
  const query = options.query ?? queryDefault;
  const transaction: ControlledRegistryTransaction =
    options.transaction ??
    ((operation) => runDbTransaction(() => operation(queryDefault)));

  async function inspectCapabilities() {
    const rows = await query<CapabilityRow>(CAPABILITY_SQL, [
      CONTROLLED_REGISTRY_SCHEMA_CONTRACT.extensions,
      capabilityTables(),
    ]);
    return inspectCapabilityRows(rows);
  }

  async function assertCapabilities() {
    const capabilities = await inspectCapabilities();
    if (!capabilities.ready)
      throw new ControlledRegistrySchemaError(capabilities);
  }

  async function preregisterExperiment(
    input: PreregisterControlledExperimentInput,
  ): Promise<ControlledExperimentRecord> {
    await assertCapabilities();
    const registration = buildExperimentRegistration(input);
    try {
      return await transaction(async (boundQuery) => {
        const query = boundQuery;
        await query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [`controlled-experiment:${registration.experimentId}`],
        );
        const existingRows = await query<Record<string, unknown>>(
          READ_REGISTERED_EXPERIMENT_SQL,
          [
            registration.experimentId,
            registration.businessId,
            registration.providerAccountRefId,
            registration.providerAccountId,
          ],
        );
        if (existingRows[0]) {
          const existing = mapExperimentRow(existingRows[0]);
          if (
            existing.registrationHash !== registration.registrationHash ||
            existing.eligibilityHash !== registration.eligibilityHash ||
            existing.assignmentManifestHash !==
              registration.assignmentManifestHash ||
            stableControlledJson(existing.arms) !==
              stableControlledJson(
                registration.arms.map((arm) => ({
                  armId: arm.armId,
                  role: arm.role,
                  allocationOrder: arm.allocationOrder,
                  assignmentProbability: arm.assignmentProbability,
                  treatmentAction: arm.treatmentAction,
                  armHash: arm.armHash,
                })),
              )
          ) {
            throw new ControlledRegistryConflictError(
              "preregistration_conflict",
              "The experiment identity is already bound to a different immutable contract.",
            );
          }
          return existing;
        }
        const rows = await query<Record<string, unknown>>(
          `
            WITH authoritative_clock AS (
              SELECT statement_timestamp() AS at
            ), inserted_experiment AS (
              INSERT INTO meta_controlled_experiments (
                id, contract_version, business_id, provider_account_ref_id,
                provider_account_id, name, hypothesis, primary_metric,
                metric_direction, randomization_unit, randomization_algorithm,
                seed_commitment_hash, eligibility_count, eligibility_hash,
                assignment_manifest_hash, starts_at, outcome_window_start_at,
                outcome_window_end_at, ends_at, registration_hash,
                preregistered_at, created_at
              )
              SELECT
                $1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16::timestamptz,
                $17::timestamptz, $18::timestamptz, $19::timestamptz, $20,
                clock.at, clock.at
              FROM authoritative_clock clock
              WHERE clock.at < $16::timestamptz
              RETURNING *
            ), arm_input AS (
              SELECT *
              FROM jsonb_to_recordset($21::jsonb) AS arm(
                id text,
                contract_version text,
                arm_role text,
                allocation_order integer,
                assignment_probability double precision,
                treatment_action text,
                arm_hash text
              )
            ), inserted_arms AS (
              INSERT INTO meta_controlled_experiment_arms (
                id, contract_version, experiment_id, business_id,
                provider_account_ref_id, provider_account_id, arm_role,
                allocation_order, assignment_probability, treatment_action,
                arm_hash, created_at
              )
              SELECT
                arm.id, arm.contract_version, experiment.id,
                experiment.business_id, experiment.provider_account_ref_id,
                experiment.provider_account_id, arm.arm_role,
                arm.allocation_order, arm.assignment_probability,
                arm.treatment_action, arm.arm_hash, experiment.created_at
              FROM arm_input arm
              CROSS JOIN inserted_experiment experiment
              RETURNING id
            )
            SELECT
              experiment.*,
              (SELECT count(*)::int FROM inserted_arms) AS inserted_arm_count,
              $21::jsonb AS arms_json
            FROM inserted_experiment experiment
          `,
          [
            registration.experimentId,
            CONTROLLED_EXPERIMENT_VERSION,
            registration.businessId,
            registration.providerAccountRefId,
            registration.providerAccountId,
            registration.name,
            registration.hypothesis,
            registration.primaryMetric,
            registration.metricDirection,
            registration.randomizationUnit,
            CONTROLLED_RANDOMIZATION_ALGORITHM,
            registration.seedCommitmentHash,
            registration.eligibilityCount,
            registration.eligibilityHash,
            registration.assignmentManifestHash,
            registration.startsAt,
            registration.outcomeWindowStartAt,
            registration.outcomeWindowEndAt,
            registration.endsAt,
            registration.registrationHash,
            JSON.stringify(
              registration.arms.map((arm) => ({
                id: arm.armId,
                contract_version: CONTROLLED_ARM_VERSION,
                arm_role: arm.role,
                allocation_order: arm.allocationOrder,
                assignment_probability: arm.assignmentProbability,
                treatment_action: arm.treatmentAction,
                arm_hash: arm.armHash,
                experimentId: registration.experimentId,
                armId: arm.armId,
                role: arm.role,
                allocationOrder: arm.allocationOrder,
                assignmentProbability: arm.assignmentProbability,
                treatmentAction: arm.treatmentAction,
                armHash: arm.armHash,
              })),
            ),
          ],
        );
        const row = rows[0];
        if (
          !row ||
          Number(row.inserted_arm_count) !== registration.arms.length
        ) {
          throw new ControlledRegistryConflictError(
            "preregistration_incomplete",
            "The experiment and every arm were not registered atomically.",
          );
        }
        return mapExperimentRow(row);
      });
    } catch (error) {
      if (error instanceof ControlledRegistryConflictError) throw error;
      return conflictFromDatabase(
        error,
        "preregistration_conflict",
        "Experiment preregistration violates an immutable schema contract.",
      );
    }
  }

  async function createAssignmentBatch(
    input: CreateControlledAssignmentBatchInput,
  ): Promise<ControlledAssignmentBatchRecord> {
    await assertCapabilities();
    const scope = normalizedScope(input);
    const experimentId = requiredString(input.experimentId, "experimentId");
    const batchId = requiredString(input.batchId, "batchId");
    const eligibility = buildEligibilityContract(input.eligibilityManifest);
    const seedCommitmentHash = buildSeedCommitment({
      experimentId,
      seed: input.randomizationSeed,
    });
    try {
      return await transaction(async (boundQuery) => {
        const query = boundQuery;
        await query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [`controlled-assignment:${experimentId}`],
        );
        const experimentRows = await query<Record<string, unknown>>(
          READ_REGISTERED_EXPERIMENT_SQL,
          [
            experimentId,
            scope.businessId,
            scope.providerAccountRefId,
            scope.providerAccountId,
          ],
        );
        const experimentRow = experimentRows[0];
        if (!experimentRow) {
          throw new ControlledRegistryConflictError(
            "experiment_not_found",
            "No preregistered experiment exists in this tenant/account.",
          );
        }
        const experiment = mapExperimentRow(experimentRow);
        if (
          experiment.seedCommitmentHash !== seedCommitmentHash ||
          experiment.eligibilityCount !== eligibility.eligibilityCount ||
          experiment.eligibilityHash !== eligibility.eligibilityHash ||
          experiment.assignmentManifestHash !==
            eligibility.assignmentManifestHash
        ) {
          throw new ControlledRegistryConflictError(
            "batch_preregistration_mismatch",
            "The full eligibility manifest or seed does not match preregistration.",
          );
        }
        const assignmentsWithoutTime = eligibility.manifest.map((entry) => {
          const proof = randomization({
            experimentId,
            businessId: scope.businessId,
            providerAccountId: scope.providerAccountId,
            target: entry.target,
            seed: input.randomizationSeed,
          });
          const arm = chooseArm(experiment.arms, proof.draw);
          const base = {
            contractVersion: CONTROLLED_ASSIGNMENT_VERSION,
            ...entry,
            experimentId,
            batchId,
            armId: arm.armId,
            armRole: arm.role,
            assignedAction: arm.treatmentAction,
            assignmentProbability: arm.assignmentProbability,
            randomizationAlgorithm: CONTROLLED_RANDOMIZATION_ALGORITHM,
            seedCommitmentHash,
            eligibilityHash: eligibility.eligibilityHash,
            randomizationDraw: proof.draw,
            randomizationProofHash: proof.proofHash,
          };
          return { ...base, assignmentHash: controlledSha256(base) };
        });
        const batchHash = controlledSha256({
          contractVersion: CONTROLLED_BATCH_VERSION,
          batchId,
          experimentId,
          ...scope,
          eligibilityCount: eligibility.eligibilityCount,
          eligibilityHash: eligibility.eligibilityHash,
          assignmentManifestHash: eligibility.assignmentManifestHash,
          assignments: assignmentsWithoutTime.map((assignment) => ({
            assignmentId: assignment.assignmentId,
            assignmentHash: assignment.assignmentHash,
          })),
        });
        const rows = await query<Record<string, unknown>>(
          `
            WITH authoritative_clock AS (
              SELECT statement_timestamp() AS at
            ), inserted_batch AS (
              INSERT INTO meta_controlled_assignment_batches (
                id, contract_version, experiment_id, business_id,
                provider_account_ref_id, provider_account_id,
                eligibility_count, eligibility_hash,
                assignment_manifest_hash, eligibility_manifest_json,
                batch_hash, assigned_at, created_at
              )
              SELECT
                $1, $2, experiment.id, experiment.business_id,
                experiment.provider_account_ref_id,
                experiment.provider_account_id, $6, $7, $8, $9::jsonb,
                $10, clock.at, clock.at
              FROM meta_controlled_experiments experiment
              CROSS JOIN authoritative_clock clock
              WHERE experiment.id = $3
                AND experiment.business_id = $4::uuid
                AND experiment.provider_account_ref_id = $5::uuid
                AND experiment.provider_account_id = $11
                AND experiment.eligibility_count = $6
                AND experiment.eligibility_hash = $7
                AND experiment.assignment_manifest_hash = $8
                AND clock.at < experiment.starts_at
              ON CONFLICT (experiment_id) DO NOTHING
              RETURNING *
            ), selected_batch AS (
              SELECT * FROM inserted_batch
              UNION ALL
              SELECT persisted.*
              FROM meta_controlled_assignment_batches persisted
              WHERE persisted.experiment_id = $3
                AND persisted.business_id = $4::uuid
                AND persisted.provider_account_ref_id = $5::uuid
                AND persisted.provider_account_id = $11
                AND NOT EXISTS (SELECT 1 FROM inserted_batch)
            ), assignment_input AS (
              SELECT *
              FROM jsonb_to_recordset($12::jsonb) AS assignment(
                id text,
                contract_version text,
                arm_id text,
                arm_role text,
                recommendation_fingerprint text,
                rec_id text,
                evaluation_id uuid,
                snapshot_id uuid,
                entity_type text,
                entity_id text,
                assigned_action text,
                assignment_probability double precision,
                randomization_algorithm text,
                seed_commitment_hash text,
                eligibility_hash text,
                randomization_draw double precision,
                randomization_proof_hash text,
                assignment_hash text
              )
            ), inserted_assignments AS (
              INSERT INTO meta_controlled_random_assignments (
                id, contract_version, experiment_id, batch_id, arm_id,
                arm_role, business_id, provider_account_ref_id,
                provider_account_id, recommendation_fingerprint, rec_id,
                evaluation_id, snapshot_id, entity_type, entity_id,
                assigned_action, assignment_probability,
                randomization_algorithm, seed_commitment_hash,
                eligibility_hash, randomization_draw,
                randomization_proof_hash, assignment_hash, assigned_at,
                created_at
              )
              SELECT
                assignment.id, assignment.contract_version,
                batch.experiment_id, batch.id, assignment.arm_id,
                assignment.arm_role, batch.business_id,
                batch.provider_account_ref_id, batch.provider_account_id,
                assignment.recommendation_fingerprint, assignment.rec_id,
                assignment.evaluation_id, assignment.snapshot_id,
                assignment.entity_type, assignment.entity_id,
                assignment.assigned_action, assignment.assignment_probability,
                assignment.randomization_algorithm,
                assignment.seed_commitment_hash,
                assignment.eligibility_hash, assignment.randomization_draw,
                assignment.randomization_proof_hash,
                assignment.assignment_hash, batch.assigned_at,
                batch.assigned_at
              FROM assignment_input assignment
              CROSS JOIN selected_batch batch
              ON CONFLICT DO NOTHING
              RETURNING *
            ), selected_assignments AS (
              SELECT * FROM inserted_assignments
              UNION ALL
              SELECT persisted.*
              FROM meta_controlled_random_assignments persisted
              CROSS JOIN selected_batch batch
              WHERE persisted.batch_id = batch.id
                AND persisted.experiment_id = batch.experiment_id
                AND persisted.business_id = batch.business_id
                AND persisted.provider_account_ref_id = batch.provider_account_ref_id
                AND persisted.provider_account_id = batch.provider_account_id
                AND NOT EXISTS (
                  SELECT 1 FROM inserted_assignments inserted
                  WHERE inserted.id = persisted.id
                )
            )
            SELECT
              batch.*,
              (
                SELECT count(*)::int
                FROM selected_assignments persisted
              ) AS persisted_count,
              (
                SELECT jsonb_agg(to_jsonb(persisted) ORDER BY persisted.entity_type, persisted.entity_id, persisted.id)
                FROM selected_assignments persisted
              ) AS assignments_json
            FROM selected_batch batch
          `,
          [
            batchId,
            CONTROLLED_BATCH_VERSION,
            experimentId,
            scope.businessId,
            scope.providerAccountRefId,
            eligibility.eligibilityCount,
            eligibility.eligibilityHash,
            eligibility.assignmentManifestHash,
            JSON.stringify(eligibility.manifest),
            batchHash,
            scope.providerAccountId,
            JSON.stringify(
              assignmentsWithoutTime.map((assignment) => ({
                id: assignment.assignmentId,
                contract_version: CONTROLLED_ASSIGNMENT_VERSION,
                arm_id: assignment.armId,
                arm_role: assignment.armRole,
                recommendation_fingerprint:
                  assignment.recommendationFingerprint,
                rec_id: assignment.recId,
                evaluation_id: assignment.evaluationId,
                snapshot_id: assignment.snapshotId,
                entity_type: assignment.target.entityType,
                entity_id: assignment.target.entityId,
                assigned_action: assignment.assignedAction,
                assignment_probability: assignment.assignmentProbability,
                randomization_algorithm: CONTROLLED_RANDOMIZATION_ALGORITHM,
                seed_commitment_hash: seedCommitmentHash,
                eligibility_hash: eligibility.eligibilityHash,
                randomization_draw: assignment.randomizationDraw,
                randomization_proof_hash: assignment.randomizationProofHash,
                assignment_hash: assignment.assignmentHash,
              })),
            ),
          ],
        );
        const row = rows[0];
        if (
          !row ||
          Number(row.persisted_count) !== eligibility.eligibilityCount ||
          row.id !== batchId ||
          row.contract_version !== CONTROLLED_BATCH_VERSION ||
          Number(row.eligibility_count) !== eligibility.eligibilityCount ||
          row.eligibility_hash !== eligibility.eligibilityHash ||
          row.assignment_manifest_hash !== eligibility.assignmentManifestHash ||
          row.batch_hash !== batchHash
        ) {
          throw new ControlledRegistryConflictError(
            "assignment_batch_incomplete",
            "The database did not persist the exact complete eligibility batch.",
          );
        }
        const persistedAssignments = objectArray(row.assignments_json);
        const expectedAssignmentsById = new Map(
          assignmentsWithoutTime.map((assignment) => [
            assignment.assignmentId,
            assignment,
          ]),
        );
        if (
          persistedAssignments.length !== eligibility.eligibilityCount ||
          persistedAssignments.some((persisted) => {
            const expected = expectedAssignmentsById.get(String(persisted.id));
            return (
              !expected ||
              persisted.assignment_hash !== expected.assignmentHash ||
              persisted.randomization_proof_hash !==
                expected.randomizationProofHash ||
              Number(persisted.randomization_draw) !==
                expected.randomizationDraw ||
              persisted.arm_id !== expected.armId ||
              persisted.arm_role !== expected.armRole ||
              optionalString(persisted.assigned_action) !==
                expected.assignedAction ||
              optionalUuid(persisted.evaluation_id) !== expected.evaluationId ||
              optionalUuid(persisted.snapshot_id) !== expected.snapshotId ||
              persisted.entity_type !== expected.target.entityType ||
              persisted.entity_id !== expected.target.entityId
            );
          })
        ) {
          throw new ControlledRegistryConflictError(
            "assignment_batch_tampered",
            "Persisted assignments do not reproduce from the committed seed and full manifest.",
          );
        }
        const assignedAt = databaseTimestamp(
          row.assigned_at,
          "batch.assignedAt",
        );
        return {
          batchId,
          experimentId,
          ...scope,
          eligibilityCount: eligibility.eligibilityCount,
          eligibilityHash: eligibility.eligibilityHash,
          assignmentManifestHash: eligibility.assignmentManifestHash,
          batchHash,
          assignedAt,
          assignments: assignmentsWithoutTime.map((assignment) => ({
            assignmentId: assignment.assignmentId,
            recommendationFingerprint: assignment.recommendationFingerprint,
            recId: assignment.recId,
            evaluationId: assignment.evaluationId,
            snapshotId: assignment.snapshotId,
            target: assignment.target,
            experimentId,
            batchId,
            armId: assignment.armId,
            armRole: assignment.armRole,
            assignedAction: assignment.assignedAction,
            assignmentProbability: assignment.assignmentProbability,
            randomizationDraw: assignment.randomizationDraw,
            randomizationProofHash: assignment.randomizationProofHash,
            assignmentHash: assignment.assignmentHash,
            assignedAt,
          })),
        };
      });
    } catch (error) {
      if (error instanceof ControlledRegistryConflictError) throw error;
      return conflictFromDatabase(
        error,
        "assignment_batch_conflict",
        "The full assignment batch conflicts with an immutable identity or FK.",
      );
    }
  }

  async function finalizeSeedReveal(
    input: FinalizeControlledSeedRevealInput,
  ): Promise<ControlledSeedRevealRecord> {
    await assertCapabilities();
    const scope = normalizedScope(input);
    const batchId = requiredString(input.batchId, "batchId");
    const experimentId = requiredString(input.experimentId, "experimentId");
    const seed = requiredString(input.randomizationSeed, "randomizationSeed");
    const seedHash = buildSeedCommitment({ experimentId, seed });
    const revealHash = controlledSha256({
      contractVersion: CONTROLLED_SEED_REVEAL_VERSION,
      batchId,
      experimentId,
      ...scope,
      seedHash,
      seed,
    });
    try {
      return await transaction(async (boundQuery) => {
        const query = boundQuery;
        await query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [`controlled-seed-reveal:${experimentId}`],
        );
        const rows = await query<Record<string, unknown>>(
          `
          WITH authoritative_clock AS (
            SELECT statement_timestamp() AS at
          ), inserted AS (
            INSERT INTO meta_controlled_seed_reveals (
            batch_id, contract_version, experiment_id, business_id,
            provider_account_ref_id, provider_account_id, revealed_seed,
            seed_hash, reveal_hash, revealed_at, created_at
            )
            SELECT
            batch.id, $2, experiment.id, batch.business_id,
            batch.provider_account_ref_id, batch.provider_account_id,
            $6, $7, $8, clock.at, clock.at
          FROM meta_controlled_assignment_batches batch
          JOIN meta_controlled_experiments experiment
            ON experiment.id = batch.experiment_id
           AND experiment.business_id = batch.business_id
           AND experiment.provider_account_ref_id = batch.provider_account_ref_id
           AND experiment.provider_account_id = batch.provider_account_id
          CROSS JOIN authoritative_clock clock
          WHERE batch.id = $1
            AND experiment.id = $3
            AND batch.business_id = $4::uuid
            AND batch.provider_account_ref_id = $5::uuid
            AND batch.provider_account_id = $9
            AND experiment.seed_commitment_hash = $7
            AND clock.at < experiment.ends_at
            AND (
              SELECT count(*)
              FROM meta_controlled_random_assignments assignment
              WHERE assignment.batch_id = batch.id
            ) = batch.eligibility_count
            ON CONFLICT (batch_id) DO NOTHING
            RETURNING batch_id, experiment_id, business_id,
              provider_account_ref_id, provider_account_id, revealed_seed,
              seed_hash, reveal_hash, revealed_at
          ), selected AS (
            SELECT * FROM inserted
            UNION ALL
            SELECT persisted.batch_id, persisted.experiment_id,
              persisted.business_id, persisted.provider_account_ref_id,
              persisted.provider_account_id, persisted.revealed_seed,
              persisted.seed_hash, persisted.reveal_hash, persisted.revealed_at
            FROM meta_controlled_seed_reveals persisted
            WHERE persisted.batch_id = $1
              AND persisted.experiment_id = $3
              AND persisted.business_id = $4::uuid
              AND persisted.provider_account_ref_id = $5::uuid
              AND persisted.provider_account_id = $9
              AND persisted.revealed_seed = $6
              AND persisted.seed_hash = $7
              AND persisted.reveal_hash = $8
              AND NOT EXISTS (SELECT 1 FROM inserted)
          )
          SELECT * FROM selected LIMIT 1
        `,
          [
            batchId,
            CONTROLLED_SEED_REVEAL_VERSION,
            experimentId,
            scope.businessId,
            scope.providerAccountRefId,
            seed,
            seedHash,
            revealHash,
            scope.providerAccountId,
          ],
        );
        const row = rows[0];
        if (!row) {
          throw new ControlledRegistryConflictError(
            "seed_reveal_binding_failed",
            "The seed reveal does not match the committed full assignment batch.",
          );
        }
        return {
          batchId: requiredString(row.batch_id, "seedReveal.batchId"),
          experimentId: requiredString(
            row.experiment_id,
            "seedReveal.experimentId",
          ),
          seedHash: requiredHash(row.seed_hash, "seedReveal.seedHash"),
          revealHash: requiredHash(row.reveal_hash, "seedReveal.revealHash"),
          revealedAt: databaseTimestamp(
            row.revealed_at,
            "seedReveal.revealedAt",
          ),
        };
      });
    } catch (error) {
      if (error instanceof ControlledRegistryConflictError) throw error;
      return conflictFromDatabase(
        error,
        "seed_reveal_conflict",
        "A seed was already revealed or violates the committed batch.",
      );
    }
  }

  return {
    inspectCapabilities,
    assertCapabilities,
    preregisterExperiment,
    createAssignmentBatch,
    finalizeSeedReveal,
    materializeControlObservations: (
      input: MaterializeControlledControlObservationsInput,
    ) =>
      materializeControlObservationsFromNativeOutcomes(
        query,
        transaction,
        assertCapabilities,
        input,
      ),
    finalizeControlEstimate: (input: FinalizeControlledEstimateInput) =>
      finalizeControlEstimate(query, transaction, assertCapabilities, input),
    readVerifiedEvidence: (input: ReadControlledEvidenceInput) =>
      readVerifiedEvidence(query, assertCapabilities, input),
  };
}

const ISO_SQL = (expression: string) =>
  `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

async function materializeControlObservationsFromNativeOutcomes(
  query: ControlledRegistryQuery,
  transaction: ControlledRegistryTransaction,
  assertCapabilities: () => Promise<void>,
  input: MaterializeControlledControlObservationsInput,
): Promise<ControlledControlObservationRecord[]> {
  await assertCapabilities();
  const scope = normalizedScope(input);
  const experimentId = requiredString(input.experimentId, "experimentId");
  const batchId = requiredString(input.batchId, "batchId");

  try {
    return await transaction(async (boundQuery) => {
      const query = boundQuery;
      await query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [`controlled-observations:${experimentId}`],
      );
      const rows = await query<Record<string, unknown>>(
        `
          WITH authoritative_clock AS (
            SELECT statement_timestamp() AS at
          ), experiment_scope AS (
            SELECT
              experiment.*,
              batch.id AS batch_id,
              batch.assigned_at,
              batch.eligibility_count AS batch_eligibility_count,
              clock.at AS finalized_at
            FROM meta_controlled_experiments experiment
            JOIN meta_controlled_assignment_batches batch
              ON batch.experiment_id = experiment.id
             AND batch.business_id = experiment.business_id
             AND batch.provider_account_ref_id = experiment.provider_account_ref_id
             AND batch.provider_account_id = experiment.provider_account_id
            CROSS JOIN authoritative_clock clock
            WHERE experiment.id = $1
              AND batch.id = $2
              AND experiment.business_id = $3::uuid
              AND experiment.provider_account_ref_id = $4::uuid
              AND experiment.provider_account_id = $5
              AND experiment.randomization_unit = 'ad'
              AND clock.at >= experiment.ends_at
            FOR SHARE OF experiment, batch
          ), control_assignments AS (
            SELECT assignment.*, scope.primary_metric,
              scope.metric_direction, scope.outcome_window_start_at,
              scope.outcome_window_end_at, scope.ends_at,
              scope.finalized_at
            FROM meta_controlled_random_assignments assignment
            JOIN experiment_scope scope
              ON scope.id = assignment.experiment_id
             AND scope.batch_id = assignment.batch_id
             AND scope.business_id = assignment.business_id
             AND scope.provider_account_ref_id = assignment.provider_account_ref_id
             AND scope.provider_account_id = assignment.provider_account_id
            WHERE assignment.arm_role = 'control'
              AND assignment.assigned_action IS NULL
          ), deterministic_outcomes AS (
            SELECT
              assignment.*,
              outcome.id AS native_outcome_id,
              outcome.contract_version AS native_outcome_contract_version,
              outcome.classifier_version AS native_outcome_classifier_version,
              outcome.source_manifest_hash::text AS native_outcome_source_manifest_hash,
              outcome.computed_at AS native_outcome_computed_at,
              CASE assignment.primary_metric
                WHEN 'outcome_roas' THEN outcome.outcome_roas::numeric(30,12)
                WHEN 'outcome_revenue' THEN outcome.outcome_revenue::numeric(30,12)
                WHEN 'outcome_purchases' THEN outcome.outcome_purchases::numeric(30,12)
                WHEN 'outcome_spend' THEN outcome.outcome_spend::numeric(30,12)
                ELSE NULL
              END AS metric_value
            FROM control_assignments assignment
            JOIN LATERAL (
              SELECT candidate.*
              FROM engine_v3_ad_decision_outcomes_daily candidate
              WHERE candidate.decision_snapshot_id = assignment.snapshot_id
                AND candidate.evaluation_id = assignment.evaluation_id
                AND candidate.business_ref_id = assignment.business_id
                AND candidate.provider_account_id = assignment.provider_account_id
                AND candidate.decision_entity_type = assignment.entity_type
                AND candidate.decision_entity_id = assignment.entity_id
                AND candidate.ad_id = assignment.entity_id
                AND candidate.outcome_window_start =
                  (assignment.outcome_window_start_at AT TIME ZONE 'UTC')::date
                AND candidate.outcome_window_end =
                  (assignment.outcome_window_end_at AT TIME ZONE 'UTC')::date
                AND candidate.window_complete
                AND candidate.measurement_status = 'known'
                AND candidate.realized_outcome = ANY(
                  ARRAY['positive','negative','neutral']::text[]
                )
                AND NOT candidate.action_contaminated
                AND candidate.action_source_hash ~ '^[0-9a-f]{64}$'
                AND jsonb_typeof(candidate.source_receipts_json) = 'object'
                AND jsonb_typeof(
                      candidate.source_receipts_json->'verifiedActions'
                    ) = 'array'
                AND jsonb_array_length(
                      candidate.source_receipts_json->'verifiedActions'
                    ) = 0
                AND candidate.computed_at >= assignment.outcome_window_end_at
                AND candidate.computed_at <= assignment.ends_at
              ORDER BY candidate.computed_at DESC, candidate.id DESC
              LIMIT 1
            ) outcome ON TRUE
          ), coverage AS (
            SELECT
              (SELECT count(*)::int FROM control_assignments) AS control_count,
              (SELECT count(*)::int FROM deterministic_outcomes
                WHERE metric_value IS NOT NULL) AS candidate_count
          ), generated AS (
            SELECT gen_random_uuid() AS observation_id, outcome.*
            FROM deterministic_outcomes outcome
            CROSS JOIN coverage
            WHERE outcome.metric_value IS NOT NULL
              AND coverage.control_count > 1
              AND coverage.candidate_count = coverage.control_count
          ), prepared AS (
            SELECT
              generated.observation_id AS id,
              $6::text AS contract_version,
              generated.experiment_id,
              generated.batch_id,
              generated.id AS control_assignment_id,
              'control'::text AS arm_role,
              generated.business_id,
              generated.provider_account_ref_id,
              generated.provider_account_id,
              generated.native_outcome_id,
              generated.native_outcome_contract_version,
              generated.native_outcome_classifier_version,
              generated.native_outcome_source_manifest_hash,
              generated.native_outcome_computed_at,
              generated.primary_metric AS metric_name,
              generated.metric_direction,
              generated.outcome_window_start_at AS window_start_at,
              generated.outcome_window_end_at AS window_end_at,
              generated.native_outcome_id::text AS source_receipt_id,
              generated.native_outcome_source_manifest_hash AS source_receipt_hash,
              jsonb_build_object(
                'contractVersion', $7::text,
                'nativeOutcomeId', generated.native_outcome_id::text,
                'sourceManifestHash', generated.native_outcome_source_manifest_hash,
                'computedAt', ${ISO_SQL("generated.native_outcome_computed_at")},
                'metricName', generated.primary_metric
              ) AS source_receipt_json,
              generated.metric_value,
              1::bigint AS sample_size,
              'finalized'::text AS observation_status,
              generated.native_outcome_computed_at AS observed_at,
              generated.ends_at AS as_of,
              generated.finalized_at,
              generated.finalized_at AS created_at
            FROM generated
          ), hashed AS (
            SELECT prepared.*,
              encode(digest(concat_ws(E'\\x1f',
                prepared.contract_version,
                prepared.id::text,
                prepared.experiment_id,
                prepared.batch_id,
                prepared.control_assignment_id,
                prepared.native_outcome_id::text,
                prepared.native_outcome_contract_version,
                prepared.native_outcome_classifier_version,
                prepared.native_outcome_source_manifest_hash,
                ${ISO_SQL("prepared.native_outcome_computed_at")},
                prepared.metric_name,
                prepared.metric_direction,
                ${ISO_SQL("prepared.window_start_at")},
                ${ISO_SQL("prepared.window_end_at")},
                prepared.metric_value::text,
                ${ISO_SQL("prepared.observed_at")},
                ${ISO_SQL("prepared.as_of")}
              ), 'sha256'), 'hex') AS observation_hash
            FROM prepared
          ), inserted AS (
            INSERT INTO meta_controlled_control_outcome_observations (
              id, contract_version, experiment_id, batch_id,
              control_assignment_id, arm_role, business_id,
              provider_account_ref_id, provider_account_id, native_outcome_id,
              native_outcome_contract_version,
              native_outcome_classifier_version,
              native_outcome_source_manifest_hash,
              native_outcome_computed_at, metric_name, metric_direction,
              window_start_at, window_end_at, source_receipt_id,
              source_receipt_hash, source_receipt_json, metric_value,
              sample_size, observation_status, observed_at, as_of,
              finalized_at, observation_hash, created_at
            )
            SELECT
              id, contract_version, experiment_id, batch_id,
              control_assignment_id, arm_role, business_id,
              provider_account_ref_id, provider_account_id, native_outcome_id,
              native_outcome_contract_version,
              native_outcome_classifier_version,
              native_outcome_source_manifest_hash,
              native_outcome_computed_at, metric_name, metric_direction,
              window_start_at, window_end_at, source_receipt_id,
              source_receipt_hash, source_receipt_json, metric_value,
              sample_size, observation_status, observed_at, as_of,
              finalized_at, observation_hash, created_at
            FROM hashed
            ON CONFLICT (control_assignment_id) DO NOTHING
            RETURNING *
          ), selected AS (
            SELECT * FROM inserted
            UNION ALL
            SELECT persisted.*
            FROM meta_controlled_control_outcome_observations persisted
            JOIN experiment_scope scope
              ON scope.id = persisted.experiment_id
             AND scope.batch_id = persisted.batch_id
             AND scope.business_id = persisted.business_id
             AND scope.provider_account_ref_id = persisted.provider_account_ref_id
             AND scope.provider_account_id = persisted.provider_account_id
            WHERE NOT EXISTS (
              SELECT 1 FROM inserted WHERE inserted.id = persisted.id
            )
          ), validation AS (
            SELECT
              coverage.control_count,
              coverage.candidate_count,
              count(selected.id)::int AS persisted_count,
              count(*) FILTER (WHERE
                outcome.id IS NULL
                OR selected.native_outcome_id <> outcome.native_outcome_id
                OR selected.metric_value <> outcome.metric_value
                OR selected.source_receipt_hash <>
                  outcome.native_outcome_source_manifest_hash
              )::int AS mismatch_count
            FROM coverage
            LEFT JOIN selected ON TRUE
            LEFT JOIN deterministic_outcomes outcome
              ON outcome.id = selected.control_assignment_id
             AND outcome.metric_value IS NOT NULL
            GROUP BY coverage.control_count, coverage.candidate_count
          )
          SELECT selected.*, validation.*
          FROM selected CROSS JOIN validation
          ORDER BY selected.control_assignment_id, selected.id
        `,
        [
          experimentId,
          batchId,
          scope.businessId,
          scope.providerAccountRefId,
          scope.providerAccountId,
          CONTROLLED_OBSERVATION_VERSION,
          CONTROLLED_SOURCE_RECEIPT_VERSION,
        ],
      );

      const first = rows[0];
      if (
        !first ||
        Number(first.control_count) <= 1 ||
        Number(first.candidate_count) !== Number(first.control_count) ||
        Number(first.persisted_count) !== Number(first.control_count) ||
        Number(first.mismatch_count) !== 0 ||
        rows.length !== Number(first.control_count)
      ) {
        throw new ControlledRegistryConflictError(
          "control_observation_set_incomplete",
          "Every randomized control assignment needs one immutable, complete native outcome before estimation.",
        );
      }

      return rows.map((row): ControlledControlObservationRecord => {
        const record: ControlledControlObservationRecord = {
          observationId: requiredUuid(row.id, "observation.id"),
          experimentId: requiredString(
            row.experiment_id,
            "observation.experimentId",
          ),
          batchId: requiredString(row.batch_id, "observation.batchId"),
          controlAssignmentId: requiredString(
            row.control_assignment_id,
            "observation.controlAssignmentId",
          ),
          nativeOutcomeId: requiredUuid(
            row.native_outcome_id,
            "observation.nativeOutcomeId",
          ),
          metricName: requiredMetricName(
            row.metric_name,
            "observation.metricName",
          ),
          metricDirection: requiredDirection(
            row.metric_direction,
            "observation.metricDirection",
          ),
          windowStartAt: databaseTimestamp(
            row.window_start_at,
            "observation.windowStartAt",
          ),
          windowEndAt: databaseTimestamp(
            row.window_end_at,
            "observation.windowEndAt",
          ),
          metricValue: normalizeNumeric(
            row.metric_value,
            "observation.metricValue",
          ),
          nativeOutcomeSourceManifestHash: requiredHash(
            row.native_outcome_source_manifest_hash,
            "observation.nativeOutcomeSourceManifestHash",
          ),
          nativeOutcomeComputedAt: databaseTimestamp(
            row.native_outcome_computed_at,
            "observation.nativeOutcomeComputedAt",
          ),
          observationHash: requiredHash(
            row.observation_hash,
            "observation.observationHash",
          ),
          finalizedAt: databaseTimestamp(
            row.finalized_at,
            "observation.finalizedAt",
          ),
        };
        const expectedHash = buildControlObservationHash({
          observationId: record.observationId,
          experimentId: record.experimentId,
          batchId: record.batchId,
          controlAssignmentId: record.controlAssignmentId,
          nativeOutcomeId: record.nativeOutcomeId,
          nativeOutcomeContractVersion: requiredString(
            row.native_outcome_contract_version,
            "observation.nativeOutcomeContractVersion",
          ),
          nativeOutcomeClassifierVersion: requiredString(
            row.native_outcome_classifier_version,
            "observation.nativeOutcomeClassifierVersion",
          ),
          nativeOutcomeSourceManifestHash:
            record.nativeOutcomeSourceManifestHash,
          nativeOutcomeComputedAt: record.nativeOutcomeComputedAt,
          metricName: record.metricName,
          metricDirection: record.metricDirection,
          windowStartAt: record.windowStartAt,
          windowEndAt: record.windowEndAt,
          value: record.metricValue,
          observedAt: record.nativeOutcomeComputedAt,
          asOf: databaseTimestamp(row.as_of, "observation.asOf"),
        });
        if (record.observationHash !== expectedHash) {
          throw new ControlledRegistryConflictError(
            "control_observation_hash_mismatch",
            "A persisted control observation failed deterministic hash verification.",
          );
        }
        return record;
      });
    });
  } catch (error) {
    if (error instanceof ControlledRegistryConflictError) throw error;
    return conflictFromDatabase(
      error,
      "control_observation_conflict",
      "Control observations violate native outcome lineage or immutable set coverage.",
    );
  }
}

async function finalizeControlEstimate(
  query: ControlledRegistryQuery,
  transaction: ControlledRegistryTransaction,
  assertCapabilities: () => Promise<void>,
  input: FinalizeControlledEstimateInput,
): Promise<FinalizedControlledEstimateRecord> {
  await assertCapabilities();
  const scope = normalizedScope(input);
  const estimateId = requiredString(input.estimateId, "estimateId");
  const experimentId = requiredString(input.experimentId, "experimentId");
  const batchId = requiredString(input.batchId, "batchId");
  const treatedAssignmentId = requiredString(
    input.treatedAssignmentId,
    "treatedAssignmentId",
  );
  const treatedOutcomeLogId = requiredUuid(
    input.treatedOutcomeLogId,
    "treatedOutcomeLogId",
  );
  const treatedNativeOutcomeId = requiredUuid(
    input.treatedNativeOutcomeId,
    "treatedNativeOutcomeId",
  );
  const treatmentActionLogId = requiredUuid(
    input.treatmentActionLogId,
    "treatmentActionLogId",
  );
  try {
    return await transaction(async (boundQuery) => {
      const query = boundQuery;
      await query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [`controlled-estimate:${treatedAssignmentId}`],
      );
      const rows = await query<Record<string, unknown>>(
        `
          WITH authoritative_clock AS (
            SELECT statement_timestamp() AS at
          ), valid_observations AS (
            SELECT observation.*, assignment.arm_id AS control_arm_id
            FROM meta_controlled_control_outcome_observations observation
            JOIN meta_controlled_random_assignments assignment
              ON assignment.id = observation.control_assignment_id
             AND assignment.experiment_id = observation.experiment_id
             AND assignment.batch_id = observation.batch_id
             AND assignment.arm_role = 'control'
             AND assignment.business_id = observation.business_id
             AND assignment.provider_account_ref_id = observation.provider_account_ref_id
             AND assignment.provider_account_id = observation.provider_account_id
            JOIN engine_v3_ad_decision_outcomes_daily native_outcome
              ON native_outcome.id = observation.native_outcome_id
             AND native_outcome.decision_snapshot_id = assignment.snapshot_id
             AND native_outcome.evaluation_id = assignment.evaluation_id
             AND native_outcome.business_ref_id = assignment.business_id
             AND native_outcome.provider_account_id = assignment.provider_account_id
             AND native_outcome.decision_entity_type = assignment.entity_type
             AND native_outcome.decision_entity_id = assignment.entity_id
            WHERE observation.experiment_id = $3
             AND observation.batch_id = $4
             AND observation.business_id = $8::uuid
             AND observation.provider_account_ref_id = $9::uuid
             AND observation.provider_account_id = $10
              AND observation.contract_version = $15
              AND observation.arm_role = 'control'
              AND observation.observation_status = 'finalized'
              AND observation.sample_size = 1
              AND jsonb_array_length(jsonb_path_query_array(
                observation.source_receipt_json, '$.keyvalue()'
              )) = 5
              AND observation.source_receipt_json->>'contractVersion' = $16
              AND observation.source_receipt_json->>'nativeOutcomeId' = observation.native_outcome_id::text
              AND observation.source_receipt_json->>'sourceManifestHash' = observation.native_outcome_source_manifest_hash
              AND (observation.source_receipt_json->>'computedAt')::timestamptz = observation.native_outcome_computed_at
              AND observation.source_receipt_json->>'metricName' = observation.metric_name
              AND observation.source_receipt_id = observation.native_outcome_id::text
              AND observation.source_receipt_hash = observation.native_outcome_source_manifest_hash
              AND observation.native_outcome_contract_version = native_outcome.contract_version
              AND observation.native_outcome_classifier_version = native_outcome.classifier_version
              AND observation.native_outcome_source_manifest_hash = native_outcome.source_manifest_hash
              AND observation.native_outcome_computed_at = native_outcome.computed_at
              AND observation.observed_at = native_outcome.computed_at
              AND native_outcome.outcome_window_start =
                    (observation.window_start_at AT TIME ZONE 'UTC')::date
              AND native_outcome.outcome_window_end =
                    (observation.window_end_at AT TIME ZONE 'UTC')::date
              AND native_outcome.window_complete
              AND native_outcome.measurement_status = 'known'
              AND native_outcome.realized_outcome = ANY(
                    ARRAY['positive','negative','neutral']::text[]
                  )
              AND NOT native_outcome.action_contaminated
              AND native_outcome.action_source_hash ~ '^[0-9a-f]{64}$'
              AND jsonb_typeof(native_outcome.source_receipts_json) = 'object'
              AND jsonb_typeof(
                    native_outcome.source_receipts_json->'verifiedActions'
                  ) = 'array'
              AND jsonb_array_length(
                    native_outcome.source_receipts_json->'verifiedActions'
                  ) = 0
              AND observation.metric_value = CASE observation.metric_name
                    WHEN 'outcome_roas' THEN native_outcome.outcome_roas::numeric(30,12)
                    WHEN 'outcome_revenue' THEN native_outcome.outcome_revenue::numeric(30,12)
                    WHEN 'outcome_purchases' THEN native_outcome.outcome_purchases::numeric(30,12)
                    WHEN 'outcome_spend' THEN native_outcome.outcome_spend::numeric(30,12)
                    ELSE NULL
                  END
              AND observation.observation_hash = encode(digest(concat_ws(E'\\x1f',
                observation.contract_version,
                observation.id::text,
                observation.experiment_id,
                observation.batch_id,
                observation.control_assignment_id,
                observation.native_outcome_id::text,
                observation.native_outcome_contract_version,
                observation.native_outcome_classifier_version,
                observation.native_outcome_source_manifest_hash,
                ${ISO_SQL("observation.native_outcome_computed_at")},
                observation.metric_name,
                observation.metric_direction,
                ${ISO_SQL("observation.window_start_at")},
                ${ISO_SQL("observation.window_end_at")},
                observation.metric_value::text,
                ${ISO_SQL("observation.observed_at")},
                ${ISO_SQL("observation.as_of")}
              ), 'sha256'), 'hex')
          ), observation_aggregate AS (
            SELECT
              count(*)::int AS observation_count,
              count(DISTINCT control_arm_id)::int AS control_arm_count,
              min(control_arm_id) AS control_arm_id,
              count(DISTINCT metric_name)::int AS metric_count,
              min(metric_name) AS metric_name,
              count(DISTINCT metric_direction)::int AS direction_count,
              min(metric_direction) AS metric_direction,
              count(DISTINCT window_start_at)::int AS start_count,
              min(window_start_at) AS window_start_at,
              count(DISTINCT window_end_at)::int AS end_count,
              min(window_end_at) AS window_end_at,
              count(DISTINCT as_of)::int AS as_of_count,
              min(as_of) AS as_of,
              array_agg(id ORDER BY id) AS observation_ids,
              count(*)::bigint AS sample_size,
              avg(metric_value)::numeric(30,12) AS estimate_value,
              var_samp(metric_value)::numeric(30,12) AS estimate_variance,
              encode(digest(string_agg(
                native_outcome_id::text || E'\\x1f' ||
                  native_outcome_source_manifest_hash,
                E'\\n' ORDER BY native_outcome_id, native_outcome_source_manifest_hash
              ), 'sha256'), 'hex') AS source_manifest_hash,
              max(finalized_at) AS observations_finalized_at
            FROM valid_observations
          ), observation_statistics AS (
            SELECT aggregate.*,
              sqrt(
                aggregate.estimate_variance /
                aggregate.observation_count::numeric
              )::numeric(30,12) AS standard_error
            FROM observation_aggregate aggregate
            WHERE aggregate.observation_count > 1
              AND aggregate.estimate_variance IS NOT NULL
          ), bound_estimate AS (
            SELECT
              $1::text AS estimate_id,
              experiment.id AS experiment_id,
              batch.id AS batch_id,
              treatment.id AS treated_assignment_id,
              outcome.id AS treated_outcome_log_id,
              treated_native_outcome.id AS treated_native_outcome_id,
              treated_native_outcome.source_manifest_hash::text AS
                treated_native_outcome_source_manifest_hash,
              CASE experiment.primary_metric
                WHEN 'outcome_roas' THEN treated_native_outcome.outcome_roas::numeric(30,12)
                WHEN 'outcome_revenue' THEN treated_native_outcome.outcome_revenue::numeric(30,12)
                WHEN 'outcome_purchases' THEN treated_native_outcome.outcome_purchases::numeric(30,12)
                WHEN 'outcome_spend' THEN treated_native_outcome.outcome_spend::numeric(30,12)
                ELSE NULL
              END AS treated_metric_value,
              action_log.id AS treatment_action_log_id,
              aggregate.control_arm_id,
              experiment.business_id,
              experiment.provider_account_ref_id,
              experiment.provider_account_id,
              aggregate.metric_name,
              aggregate.metric_direction,
              aggregate.window_start_at,
              aggregate.window_end_at,
              aggregate.observation_ids,
              aggregate.observation_count,
              aggregate.source_manifest_hash,
              aggregate.as_of,
              aggregate.estimate_value,
              aggregate.sample_size,
              aggregate.estimate_variance,
              aggregate.standard_error,
              (
                aggregate.estimate_value -
                1.959963984540054::numeric * aggregate.standard_error
              )::numeric(30,12) AS confidence_95_lower,
              (
                aggregate.estimate_value +
                1.959963984540054::numeric * aggregate.standard_error
              )::numeric(30,12) AS confidence_95_upper,
              clock.at AS finalized_at
            FROM observation_statistics aggregate
            JOIN meta_controlled_experiments experiment
              ON experiment.id = $3
             AND experiment.business_id = $8::uuid
             AND experiment.provider_account_ref_id = $9::uuid
             AND experiment.provider_account_id = $10
            JOIN meta_controlled_assignment_batches batch
              ON batch.id = $4
             AND batch.experiment_id = experiment.id
             AND batch.business_id = experiment.business_id
             AND batch.provider_account_ref_id = experiment.provider_account_ref_id
             AND batch.provider_account_id = experiment.provider_account_id
            JOIN meta_controlled_seed_reveals reveal
              ON reveal.batch_id = batch.id
             AND reveal.seed_hash = experiment.seed_commitment_hash
            JOIN meta_controlled_random_assignments treatment
              ON treatment.id = $5
             AND treatment.experiment_id = experiment.id
             AND treatment.batch_id = batch.id
             AND treatment.arm_role = 'treatment'
             AND treatment.business_id = experiment.business_id
             AND treatment.provider_account_ref_id = experiment.provider_account_ref_id
             AND treatment.provider_account_id = experiment.provider_account_id
            JOIN engine_v3_ad_decision_snapshots_daily native_snapshot
              ON native_snapshot.id = treatment.snapshot_id
             AND native_snapshot.evaluation_id = treatment.evaluation_id
             AND native_snapshot.business_ref_id = treatment.business_id
             AND native_snapshot.provider_account_id = treatment.provider_account_id
             AND native_snapshot.decision_entity_type = treatment.entity_type
             AND native_snapshot.decision_entity_id = treatment.entity_id
            JOIN engine_v3_ad_decision_evaluations native_evaluation
              ON native_evaluation.id = treatment.evaluation_id
             AND native_evaluation.business_ref_id = treatment.business_id
             AND native_evaluation.provider_account_id = treatment.provider_account_id
             AND native_evaluation.decision_entity_type = treatment.entity_type
             AND native_evaluation.decision_entity_id = treatment.entity_id
             AND native_evaluation.input_hash = native_snapshot.input_hash
             AND native_evaluation.decision_hash = native_snapshot.decision_hash
            JOIN meta_ads_action_log action_log
              ON action_log.id = $7::uuid
             AND action_log.business_id = treatment.business_id
             AND action_log.provider_account_ref_id = treatment.provider_account_ref_id
             AND action_log.provider_account_id = treatment.provider_account_id
             AND action_log.controlled_assignment_id = treatment.id
             AND action_log.target_entity_type = treatment.entity_type
             AND action_log.target_entity_id = treatment.entity_id
             AND action_log.action = treatment.assigned_action
             AND action_log.rec_id_origin = treatment.rec_id
             AND action_log.source_snapshot_id = treatment.snapshot_id
             AND action_log.source_evaluation_id = treatment.evaluation_id
             AND action_log.engine_version = native_snapshot.engine_version
             AND action_log.decision_hash = native_snapshot.decision_hash
            JOIN meta_decision_action_outcome_logs outcome
              ON outcome.id = $6::uuid
             AND outcome.business_ref_id = treatment.business_id
             AND outcome.provider_account_ref_id = treatment.provider_account_ref_id
             AND outcome.provider_account_id = treatment.provider_account_id
             AND outcome.recommendation_fingerprint = treatment.recommendation_fingerprint
             AND outcome.rec_id = treatment.rec_id
            JOIN engine_v3_ad_decision_outcomes_daily treated_native_outcome
              ON treated_native_outcome.id = $17::uuid
             AND treated_native_outcome.decision_snapshot_id = treatment.snapshot_id
             AND treated_native_outcome.evaluation_id = treatment.evaluation_id
             AND treated_native_outcome.business_ref_id = treatment.business_id
             AND treated_native_outcome.provider_account_id = treatment.provider_account_id
             AND treated_native_outcome.decision_entity_type = treatment.entity_type
             AND treated_native_outcome.decision_entity_id = treatment.entity_id
             AND treated_native_outcome.ad_id = treatment.entity_id
            CROSS JOIN authoritative_clock clock
            WHERE aggregate.observation_count = (
                    SELECT count(*)
                    FROM meta_controlled_random_assignments control_assignment
                    WHERE control_assignment.experiment_id = experiment.id
                      AND control_assignment.batch_id = batch.id
                      AND control_assignment.business_id = experiment.business_id
                      AND control_assignment.provider_account_ref_id = experiment.provider_account_ref_id
                      AND control_assignment.provider_account_id = experiment.provider_account_id
                      AND control_assignment.arm_role = 'control'
                  )
              AND aggregate.observation_count > 1
              AND aggregate.control_arm_count = 1
              AND aggregate.metric_count = 1
              AND aggregate.direction_count = 1
              AND aggregate.start_count = 1
              AND aggregate.end_count = 1
              AND aggregate.as_of_count = 1
              AND aggregate.metric_name = experiment.primary_metric
              AND aggregate.metric_direction = experiment.metric_direction
              AND aggregate.window_start_at = experiment.outcome_window_start_at
              AND aggregate.window_end_at = experiment.outcome_window_end_at
              AND aggregate.sample_size = aggregate.observation_count
              AND aggregate.as_of = experiment.ends_at
              AND aggregate.observations_finalized_at <= clock.at
              AND clock.at >= experiment.ends_at
              AND reveal.revealed_at >= batch.assigned_at
              AND reveal.revealed_at <= action_log.executed_at
              AND treatment.assigned_at = batch.assigned_at
              AND treatment.assigned_at < action_log.executed_at
              AND action_log.executed_at >= experiment.starts_at
              AND action_log.executed_at <= experiment.ends_at
              AND action_log.executed_at <= aggregate.window_start_at
              AND action_log.status = 'success'
              AND action_log.dry_run = FALSE
              AND action_log.verified_at IS NOT NULL
              AND action_log.verified_at <= aggregate.window_start_at
              AND action_log.provider_observed_at >= action_log.executed_at
              AND action_log.provider_observed_at <= action_log.verified_at
              AND jsonb_typeof(action_log.verification_payload) = 'object'
              AND jsonb_array_length(jsonb_path_query_array(
                action_log.verification_payload, '$.keyvalue()'
              )) = 16
              AND action_log.verification_payload->>'contractVersion' = $13
              AND action_log.verification_payload->>'actionLogId' = action_log.id::text
              AND action_log.verification_payload->>'controlledAssignmentId' = treatment.id
              AND action_log.verification_payload->>'businessId' = action_log.business_id::text
              AND action_log.verification_payload->>'providerAccountRefId' = action_log.provider_account_ref_id::text
              AND action_log.verification_payload->>'providerAccountId' = action_log.provider_account_id
              AND action_log.verification_payload->>'snapshotId' = action_log.source_snapshot_id::text
              AND action_log.verification_payload->>'evaluationId' = action_log.source_evaluation_id::text
              AND action_log.verification_payload->>'engineVersion' = action_log.engine_version
              AND action_log.verification_payload->>'decisionHash' = action_log.decision_hash
              AND action_log.verification_payload->>'entityType' = action_log.target_entity_type
              AND action_log.verification_payload->>'entityId' = action_log.target_entity_id
              AND action_log.verification_payload->>'action' = action_log.provider_action
              AND action_log.provider_entity_id = action_log.target_entity_id
              AND action_log.provider_action = action_log.action
              AND action_log.verification_payload->>'status' = action_log.provider_status
              AND (
                (action_log.provider_action = 'pause' AND action_log.provider_status = 'PAUSED')
                OR (action_log.provider_action = 'resume' AND action_log.provider_status = 'ACTIVE')
              )
              AND (action_log.verification_payload->>'observedAt')::timestamptz = action_log.provider_observed_at
              AND action_log.verification_payload->>'responseHash' = action_log.provider_response_hash
              AND action_log.provider_verification_hash = encode(digest(concat_ws(E'\\x1f',
                $13,
                action_log.id::text,
                treatment.id,
                action_log.business_id::text,
                action_log.provider_account_ref_id::text,
                action_log.provider_account_id,
                action_log.source_snapshot_id::text,
                action_log.source_evaluation_id::text,
                action_log.engine_version,
                action_log.decision_hash,
                action_log.target_entity_type,
                action_log.target_entity_id,
                action_log.provider_action,
                action_log.provider_status,
                ${ISO_SQL("action_log.provider_observed_at")},
                action_log.provider_response_hash
              ), 'sha256'), 'hex')
              AND outcome.action_type = 'outcome'
              AND outcome.outcome_status = ANY(ARRAY['positive','negative','neutral']::text[])
              AND outcome.payload_json->>'evidenceClass' = $14
              AND jsonb_typeof(outcome.payload_json->'causalDesign') = 'object'
              AND jsonb_array_length(jsonb_path_query_array(
                outcome.payload_json->'causalDesign', '$.keyvalue()'
              )) = 6
              AND outcome.payload_json->'causalDesign'->>'contractVersion' = $11
              AND outcome.payload_json->'causalDesign'->>'method' = 'randomized_controlled_trial'
              AND outcome.payload_json->'causalDesign'->>'experimentId' = experiment.id
              AND outcome.payload_json->'causalDesign'->>'batchId' = batch.id
              AND outcome.payload_json->'causalDesign'->>'assignmentId' = treatment.id
              AND outcome.payload_json->'causalDesign'->>'estimateId' = $1
              AND jsonb_typeof(outcome.payload_json->'treatmentReceipt') = 'object'
              AND jsonb_array_length(jsonb_path_query_array(
                outcome.payload_json->'treatmentReceipt', '$.keyvalue()'
              )) = 9
              AND outcome.payload_json->'treatmentReceipt'->>'contractVersion' = $12
              AND outcome.payload_json->'treatmentReceipt'->>'actionLogId' = action_log.id::text
              AND outcome.payload_json->'treatmentReceipt'->>'status' = 'success'
              AND outcome.payload_json->'treatmentReceipt'->>'verificationStatus' = 'verified'
              AND outcome.payload_json->'treatmentReceipt'->>'recommendationFingerprint' = treatment.recommendation_fingerprint
              AND outcome.payload_json->'treatmentReceipt'->>'recId' = treatment.rec_id
              AND outcome.payload_json->'treatmentReceipt'->>'experimentId' = experiment.id
              AND outcome.payload_json->'treatmentReceipt'->>'batchId' = batch.id
              AND outcome.payload_json->'treatmentReceipt'->>'assignmentId' = treatment.id
              AND outcome.occurred_at >= aggregate.window_end_at
              AND outcome.occurred_at >= treated_native_outcome.computed_at
              AND outcome.occurred_at <= aggregate.as_of
              AND treated_native_outcome.outcome_window_start =
                    (aggregate.window_start_at AT TIME ZONE 'UTC')::date
              AND treated_native_outcome.outcome_window_end =
                    (aggregate.window_end_at AT TIME ZONE 'UTC')::date
              AND treated_native_outcome.window_complete
              AND treated_native_outcome.measurement_status = 'known'
              AND treated_native_outcome.realized_outcome = outcome.outcome_status
              AND treated_native_outcome.action_contaminated
              AND treated_native_outcome.action_source_hash ~ '^[0-9a-f]{64}$'
              AND jsonb_typeof(treated_native_outcome.source_receipts_json) = 'object'
              AND jsonb_typeof(
                    treated_native_outcome.source_receipts_json->'verifiedActions'
                  ) = 'array'
              AND EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  treated_native_outcome.source_receipts_json->'verifiedActions'
                ) AS native_receipt
                WHERE native_receipt->>'id' = action_log.id::text
                  AND native_receipt->>'businessId' = action_log.business_id::text
                  AND native_receipt->>'providerAccountRefId' =
                      action_log.provider_account_ref_id::text
                  AND native_receipt->>'providerAccountId' =
                      action_log.provider_account_id
                  AND native_receipt->>'targetEntityType' = 'ad'
                  AND native_receipt->>'targetEntityId' = action_log.target_entity_id
                  AND native_receipt->>'action' = action_log.action
                  AND native_receipt->>'status' = 'success'
                  AND native_receipt->'dryRun' = 'false'::jsonb
                  AND (native_receipt->>'executedAt')::timestamptz =
                      action_log.executed_at
                  AND (native_receipt->>'verifiedAt')::timestamptz =
                      action_log.verified_at
                  AND native_receipt->>'providerEntityId' =
                      action_log.provider_entity_id
                  AND native_receipt->>'providerAction' = action_log.provider_action
                  AND native_receipt->>'providerStatus' = action_log.provider_status
                  AND (native_receipt->>'providerObservedAt')::timestamptz =
                      action_log.provider_observed_at
                  AND native_receipt->>'providerResponseHash' =
                      action_log.provider_response_hash
                  AND native_receipt->>'providerVerificationHash' =
                      action_log.provider_verification_hash
                  AND native_receipt->>'source' = 'decision_origin'
                  AND native_receipt->>'sourceSnapshotId' =
                      action_log.source_snapshot_id::text
                  AND native_receipt->>'sourceEvaluationId' =
                      action_log.source_evaluation_id::text
                  AND native_receipt->>'engineVersion' = action_log.engine_version
                  AND native_receipt->>'decisionHash' = action_log.decision_hash
                  AND native_receipt->'nativeDecisionLineageValidated' =
                      'true'::jsonb
                  AND native_receipt->'controlledReceiptHashValidated' =
                      'true'::jsonb
                  AND native_receipt->>'controlledAssignmentId' = treatment.id
                  AND native_receipt->>'recIdOrigin' = treatment.rec_id
              )
              AND treated_native_outcome.computed_at >= aggregate.window_end_at
              AND treated_native_outcome.computed_at <= aggregate.as_of
              AND treated_native_outcome.source_manifest_hash ~ '^[0-9a-f]{64}$'
              AND aggregate.as_of <= clock.at
          ), hashed_estimate AS (
            SELECT
              bound.*,
              encode(digest(concat_ws(E'\\x1f',
                $2::text,
                bound.estimate_id,
                bound.experiment_id,
                bound.batch_id,
                bound.treated_assignment_id,
                bound.treated_outcome_log_id::text,
                bound.treated_native_outcome_id::text,
                bound.treated_native_outcome_source_manifest_hash,
                bound.treated_metric_value::text,
                bound.treatment_action_log_id::text,
                bound.control_arm_id,
                bound.metric_name,
                bound.metric_direction,
                ${ISO_SQL("bound.window_start_at")},
                ${ISO_SQL("bound.window_end_at")},
                array_to_string(bound.observation_ids, ','),
                bound.source_manifest_hash,
                ${ISO_SQL("bound.as_of")},
                bound.estimate_value::text,
                bound.sample_size::text,
                bound.estimate_variance::text,
                bound.standard_error::text,
                bound.confidence_95_lower::text,
                bound.confidence_95_upper::text
              ), 'sha256'), 'hex') AS estimate_hash
            FROM bound_estimate bound
          ), inserted_estimate AS (
            INSERT INTO meta_controlled_control_estimates (
            id, contract_version, experiment_id, batch_id,
            treated_assignment_id, treated_arm_role,
            treated_outcome_log_id, treated_native_outcome_id,
            treated_native_outcome_source_manifest_hash,
            treated_metric_value, treatment_action_log_id, control_arm_id,
            business_id, provider_account_ref_id, provider_account_id,
            metric_name, metric_direction, window_start_at, window_end_at,
            observation_ids, observation_count, source_manifest_hash, as_of,
            estimate_value, sample_size, estimate_variance, standard_error,
            confidence_95_lower, confidence_95_upper, estimate_hash,
            finalized_at, created_at
          )
          SELECT
            estimate_id, $2::text, experiment_id, batch_id,
            treated_assignment_id, 'treatment', treated_outcome_log_id,
            treated_native_outcome_id,
            treated_native_outcome_source_manifest_hash,
            treated_metric_value, treatment_action_log_id, control_arm_id, business_id,
            provider_account_ref_id, provider_account_id, metric_name,
            metric_direction, window_start_at, window_end_at,
            observation_ids, observation_count, source_manifest_hash, as_of,
            estimate_value, sample_size, estimate_variance, standard_error,
            confidence_95_lower, confidence_95_upper, estimate_hash,
            finalized_at, finalized_at
          FROM hashed_estimate
          ON CONFLICT (id) DO NOTHING
            RETURNING *
          ), selected_estimate AS (
            SELECT * FROM inserted_estimate
            UNION ALL
            SELECT persisted.*
            FROM meta_controlled_control_estimates persisted
            WHERE persisted.id = $1
              AND persisted.experiment_id = $3
              AND persisted.batch_id = $4
              AND persisted.treated_assignment_id = $5
              AND persisted.business_id = $8::uuid
              AND persisted.provider_account_ref_id = $9::uuid
              AND persisted.provider_account_id = $10
              AND NOT EXISTS (SELECT 1 FROM inserted_estimate)
          )
          SELECT * FROM selected_estimate
        `,
        [
          estimateId,
          CONTROLLED_ESTIMATE_VERSION,
          experimentId,
          batchId,
          treatedAssignmentId,
          treatedOutcomeLogId,
          treatmentActionLogId,
          scope.businessId,
          scope.providerAccountRefId,
          scope.providerAccountId,
          CONTROLLED_CAUSAL_DESIGN_VERSION,
          CONTROLLED_TREATMENT_RECEIPT_VERSION,
          CONTROLLED_PROVIDER_VERIFICATION_VERSION,
          CONTROLLED_EVIDENCE_CLASS,
          CONTROLLED_OBSERVATION_VERSION,
          CONTROLLED_SOURCE_RECEIPT_VERSION,
          treatedNativeOutcomeId,
        ],
      );
      const row = rows[0];
      if (!row) {
        throw new ControlledRegistryConflictError(
          "estimate_assertion_or_binding_failed",
          "Observation-derived value/sample or causal chronology did not match.",
        );
      }
      const record: FinalizedControlledEstimateRecord = {
        estimateId: requiredString(row.id, "estimate.id"),
        experimentId: requiredString(
          row.experiment_id,
          "estimate.experimentId",
        ),
        batchId: requiredString(row.batch_id, "estimate.batchId"),
        treatedAssignmentId: requiredString(
          row.treated_assignment_id,
          "estimate.treatedAssignmentId",
        ),
        treatedOutcomeLogId: requiredUuid(
          row.treated_outcome_log_id,
          "estimate.treatedOutcomeLogId",
        ),
        treatedNativeOutcomeId: requiredUuid(
          row.treated_native_outcome_id,
          "estimate.treatedNativeOutcomeId",
        ),
        treatedNativeOutcomeSourceManifestHash: requiredHash(
          row.treated_native_outcome_source_manifest_hash,
          "estimate.treatedNativeOutcomeSourceManifestHash",
        ),
        treatedMetricValue: normalizeNumeric(
          row.treated_metric_value,
          "estimate.treatedMetricValue",
        ),
        treatmentActionLogId: requiredUuid(
          row.treatment_action_log_id,
          "estimate.treatmentActionLogId",
        ),
        controlArmId: requiredString(
          row.control_arm_id,
          "estimate.controlArmId",
        ),
        metricName: requiredMetricName(row.metric_name, "estimate.metricName"),
        metricDirection: requiredDirection(
          row.metric_direction,
          "estimate.metricDirection",
        ),
        windowStartAt: databaseTimestamp(
          row.window_start_at,
          "estimate.windowStartAt",
        ),
        windowEndAt: databaseTimestamp(
          row.window_end_at,
          "estimate.windowEndAt",
        ),
        observationIds: stringArray(row.observation_ids).map((id, index) =>
          requiredUuid(id, `estimate.observationIds[${index}]`),
        ),
        observationCount: Number(row.observation_count),
        sourceManifestHash: requiredHash(
          row.source_manifest_hash,
          "estimate.sourceManifestHash",
        ),
        asOf: databaseTimestamp(row.as_of, "estimate.asOf"),
        value: normalizeNumeric(row.estimate_value, "estimate.value"),
        sampleSize: Number(row.sample_size),
        variance: normalizeNumeric(row.estimate_variance, "estimate.variance"),
        standardError: normalizeNumeric(
          row.standard_error,
          "estimate.standardError",
        ),
        confidence95Lower: normalizeNumeric(
          row.confidence_95_lower,
          "estimate.confidence95Lower",
        ),
        confidence95Upper: normalizeNumeric(
          row.confidence_95_upper,
          "estimate.confidence95Upper",
        ),
        estimateHash: requiredHash(row.estimate_hash, "estimate.estimateHash"),
        finalizedAt: databaseTimestamp(
          row.finalized_at,
          "estimate.finalizedAt",
        ),
      };
      const expectedHash = estimateHashMaterial({
        ...record,
        value: record.value,
        sampleSize: record.sampleSize,
      });
      if (record.estimateHash !== expectedHash) {
        throw new ControlledRegistryConflictError(
          "estimate_hash_mismatch",
          "The persisted estimate does not match its DB-derived observations and uncertainty.",
        );
      }
      return record;
    });
  } catch (error) {
    if (error instanceof ControlledRegistryConflictError) throw error;
    return conflictFromDatabase(
      error,
      "estimate_conflict",
      "The estimate reuses an assignment, outcome, receipt, or invalid observation.",
    );
  }
}

export type ControlledEvidenceInvalidReason =
  | "payload_invalid"
  | "scope_invalid"
  | "experiment_invalid"
  | "batch_invalid"
  | "seed_reveal_invalid"
  | "full_batch_randomization_invalid"
  | "assignment_invalid"
  | "assignment_reused"
  | "receipt_invalid"
  | "receipt_reused"
  | "provider_verification_invalid"
  | "chronology_invalid"
  | "control_observation_invalid"
  | "estimate_invalid"
  | "estimate_reused"
  | "outcome_invalid";

export interface VerifiedControlledEvidenceRow {
  contractVersion: typeof CONTROLLED_HYDRATION_VERSION;
  outcomeLogId: string;
  businessId: string;
  providerAccountId: string;
  recommendationFingerprint: string | null;
  recId: string | null;
  recType: string | null;
  decisionLabel: string | null;
  actionType: string | null;
  outcomeStatus: string | null;
  payloadJson: unknown;
  occurredAt: string | null;
  causalAssignmentValidated: boolean;
  treatmentReceiptValidated: boolean;
  causalEstimateValidated: boolean;
  controlledEvidenceValidated: boolean;
  invalidReasonCodes: ControlledEvidenceInvalidReason[];
  evidence: {
    experimentId: string | null;
    batchId: string | null;
    assignmentId: string | null;
    estimateId: string | null;
    actionLogId: string | null;
    eligibilityCount: number | null;
    hydratedAssignmentCount: number;
    observationCount: number;
    seedRevealedAt: string | null;
  };
}

const READ_VERIFIED_EVIDENCE_SQL = `
  WITH all_claims AS (
    SELECT
      outcome.*,
      NULLIF(outcome.payload_json->'causalDesign'->>'experimentId', '') AS claim_experiment_id,
      NULLIF(outcome.payload_json->'causalDesign'->>'batchId', '') AS claim_batch_id,
      NULLIF(outcome.payload_json->'causalDesign'->>'assignmentId', '') AS claim_assignment_id,
      NULLIF(outcome.payload_json->'causalDesign'->>'estimateId', '') AS claim_estimate_id,
      NULLIF(outcome.payload_json->'treatmentReceipt'->>'actionLogId', '') AS claim_action_log_id
    FROM meta_decision_action_outcome_logs outcome
    WHERE outcome.business_ref_id = $1::uuid
      AND outcome.provider_account_ref_id = $2::uuid
      AND outcome.provider_account_id = $3
      AND outcome.action_type = 'outcome'
      AND outcome.payload_json->>'evidenceClass' = $7
  ), claims_with_usage AS (
    SELECT
      claim.*,
      count(*) OVER (PARTITION BY claim.claim_assignment_id) AS assignment_claim_count,
      count(*) OVER (PARTITION BY claim.claim_estimate_id) AS estimate_claim_count,
      count(*) OVER (PARTITION BY claim.claim_action_log_id) AS action_log_claim_count
    FROM all_claims claim
  ), scoped_claims AS (
    SELECT *
    FROM claims_with_usage claim
    WHERE claim.rec_type = ANY($4::text[])
      AND ($5::uuid[] IS NULL OR claim.id = ANY($5::uuid[]))
    ORDER BY claim.occurred_at DESC, claim.id DESC
    LIMIT $6
  )
  SELECT
    claim.id::text AS outcome_log_id,
    claim.business_ref_id::text AS outcome_business_id,
    claim.provider_account_ref_id::text AS outcome_provider_account_ref_id,
    claim.provider_account_id AS outcome_provider_account_id,
    claim.recommendation_fingerprint,
    claim.rec_id,
    claim.rec_type,
    claim.decision_label,
    claim.action_type,
    claim.outcome_status,
    claim.payload_json,
    claim.occurred_at::text AS occurred_at,
    claim.assignment_claim_count,
    claim.estimate_claim_count,
    claim.action_log_claim_count,
    to_jsonb(experiment) AS experiment_json,
    arms.rows AS arms_json,
    to_jsonb(batch) AS batch_json,
    to_jsonb(reveal) AS seed_reveal_json,
    assignments.rows AS assignments_json,
    to_jsonb(assignment) AS assignment_json,
    to_jsonb(action_log) AS action_log_json,
    jsonb_build_object(
      'id', estimate.id,
      'contract_version', estimate.contract_version,
      'experiment_id', estimate.experiment_id,
      'batch_id', estimate.batch_id,
      'treated_assignment_id', estimate.treated_assignment_id,
      'treated_outcome_log_id', estimate.treated_outcome_log_id,
      'treated_native_outcome_id', estimate.treated_native_outcome_id,
      'treated_native_outcome_source_manifest_hash',
        estimate.treated_native_outcome_source_manifest_hash,
      'treated_metric_value', estimate.treated_metric_value::text,
      'treatment_action_log_id', estimate.treatment_action_log_id,
      'control_arm_id', estimate.control_arm_id,
      'business_id', estimate.business_id,
      'provider_account_ref_id', estimate.provider_account_ref_id,
      'provider_account_id', estimate.provider_account_id,
      'metric_name', estimate.metric_name,
      'metric_direction', estimate.metric_direction,
      'window_start_at', estimate.window_start_at,
      'window_end_at', estimate.window_end_at,
      'observation_ids', estimate.observation_ids,
      'observation_count', estimate.observation_count,
      'source_manifest_hash', estimate.source_manifest_hash,
      'as_of', estimate.as_of,
      'estimate_value', estimate.estimate_value::text,
      'sample_size', estimate.sample_size,
      'estimate_variance', estimate.estimate_variance::text,
      'standard_error', estimate.standard_error::text,
      'confidence_95_lower', estimate.confidence_95_lower::text,
      'confidence_95_upper', estimate.confidence_95_upper::text,
      'estimate_hash', estimate.estimate_hash,
      'finalized_at', estimate.finalized_at
    ) AS estimate_json,
    to_jsonb(treated_native_outcome) AS treated_native_outcome_json,
    observations.rows AS observations_json,
    control_statistics.row AS control_statistics_json
  FROM scoped_claims claim
  LEFT JOIN meta_controlled_experiments experiment
    ON experiment.id = claim.claim_experiment_id
   AND experiment.business_id = claim.business_ref_id
   AND experiment.provider_account_ref_id = claim.provider_account_ref_id
   AND experiment.provider_account_id = claim.provider_account_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'experimentId', arm.experiment_id,
        'armId', arm.id,
        'role', arm.arm_role,
        'allocationOrder', arm.allocation_order,
        'assignmentProbability', arm.assignment_probability,
        'treatmentAction', arm.treatment_action,
        'armHash', arm.arm_hash
      ) ORDER BY arm.allocation_order, arm.id
    ) AS rows
    FROM meta_controlled_experiment_arms arm
    WHERE arm.experiment_id = experiment.id
      AND arm.business_id = experiment.business_id
      AND arm.provider_account_ref_id = experiment.provider_account_ref_id
      AND arm.provider_account_id = experiment.provider_account_id
  ) arms ON TRUE
  LEFT JOIN meta_controlled_assignment_batches batch
    ON batch.id = claim.claim_batch_id
   AND batch.experiment_id = experiment.id
   AND batch.business_id = claim.business_ref_id
   AND batch.provider_account_ref_id = claim.provider_account_ref_id
   AND batch.provider_account_id = claim.provider_account_id
  LEFT JOIN meta_controlled_seed_reveals reveal
    ON reveal.batch_id = batch.id
   AND reveal.experiment_id = experiment.id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(to_jsonb(batch_assignment) ORDER BY batch_assignment.entity_type, batch_assignment.entity_id, batch_assignment.id) AS rows
    FROM meta_controlled_random_assignments batch_assignment
    WHERE batch_assignment.batch_id = batch.id
      AND batch_assignment.experiment_id = experiment.id
      AND batch_assignment.business_id = claim.business_ref_id
      AND batch_assignment.provider_account_ref_id = claim.provider_account_ref_id
      AND batch_assignment.provider_account_id = claim.provider_account_id
  ) assignments ON TRUE
  LEFT JOIN meta_controlled_random_assignments assignment
    ON assignment.id = claim.claim_assignment_id
   AND assignment.batch_id = batch.id
   AND assignment.experiment_id = experiment.id
   AND assignment.business_id = claim.business_ref_id
   AND assignment.provider_account_ref_id = claim.provider_account_ref_id
   AND assignment.provider_account_id = claim.provider_account_id
  LEFT JOIN meta_ads_action_log action_log
    ON action_log.id::text = claim.claim_action_log_id
   AND action_log.business_id = claim.business_ref_id
   AND action_log.provider_account_ref_id = claim.provider_account_ref_id
   AND action_log.provider_account_id = claim.provider_account_id
  LEFT JOIN meta_controlled_control_estimates estimate
    ON estimate.id = claim.claim_estimate_id
   AND estimate.business_id = claim.business_ref_id
   AND estimate.provider_account_ref_id = claim.provider_account_ref_id
   AND estimate.provider_account_id = claim.provider_account_id
  LEFT JOIN engine_v3_ad_decision_outcomes_daily treated_native_outcome
    ON treated_native_outcome.id = estimate.treated_native_outcome_id
   AND treated_native_outcome.decision_snapshot_id = assignment.snapshot_id
   AND treated_native_outcome.evaluation_id = assignment.evaluation_id
   AND treated_native_outcome.business_ref_id = claim.business_ref_id
   AND treated_native_outcome.provider_account_id = claim.provider_account_id
   AND treated_native_outcome.decision_entity_type = assignment.entity_type
   AND treated_native_outcome.decision_entity_id = assignment.entity_id
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', observation.id,
        'contract_version', observation.contract_version,
        'experiment_id', observation.experiment_id,
        'batch_id', observation.batch_id,
        'control_assignment_id', observation.control_assignment_id,
        'arm_role', observation.arm_role,
        'business_id', observation.business_id,
        'provider_account_ref_id', observation.provider_account_ref_id,
        'provider_account_id', observation.provider_account_id,
        'native_outcome_id', observation.native_outcome_id,
        'native_outcome_contract_version', observation.native_outcome_contract_version,
        'native_outcome_classifier_version', observation.native_outcome_classifier_version,
        'native_outcome_source_manifest_hash', observation.native_outcome_source_manifest_hash,
        'native_outcome_computed_at', observation.native_outcome_computed_at,
        'metric_name', observation.metric_name,
        'metric_direction', observation.metric_direction,
        'window_start_at', observation.window_start_at,
        'window_end_at', observation.window_end_at,
        'source_receipt_id', observation.source_receipt_id,
        'source_receipt_hash', observation.source_receipt_hash,
        'source_receipt_json', observation.source_receipt_json,
        'metric_value', observation.metric_value::text,
        'sample_size', observation.sample_size,
        'observation_status', observation.observation_status,
        'observed_at', observation.observed_at,
        'as_of', observation.as_of,
        'finalized_at', observation.finalized_at,
        'observation_hash', observation.observation_hash,
        'created_at', observation.created_at,
        'native_outcome', to_jsonb(control_native_outcome)
      ) ORDER BY observation.id
    ) AS rows
    FROM meta_controlled_control_outcome_observations observation
    LEFT JOIN engine_v3_ad_decision_outcomes_daily control_native_outcome
      ON control_native_outcome.id = observation.native_outcome_id
    WHERE estimate.id IS NOT NULL
      AND observation.id = ANY(estimate.observation_ids)
  ) observations ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'observation_count', aggregate.observation_count,
      'estimate_value', aggregate.estimate_value::text,
      'estimate_variance', aggregate.estimate_variance::text,
      'standard_error', uncertainty.standard_error::text,
      'confidence_95_lower', (
        aggregate.estimate_value -
        1.959963984540054::numeric * uncertainty.standard_error
      )::numeric(30,12)::text,
      'confidence_95_upper', (
        aggregate.estimate_value +
        1.959963984540054::numeric * uncertainty.standard_error
      )::numeric(30,12)::text
    ) AS row
    FROM (
      SELECT
        count(*)::int AS observation_count,
        avg(observation.metric_value)::numeric(30,12) AS estimate_value,
        var_samp(observation.metric_value)::numeric(30,12) AS estimate_variance
      FROM meta_controlled_control_outcome_observations observation
      WHERE estimate.id IS NOT NULL
        AND observation.id = ANY(estimate.observation_ids)
    ) aggregate
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN aggregate.observation_count > 1
          AND aggregate.estimate_variance IS NOT NULL
        THEN sqrt(
          aggregate.estimate_variance /
          aggregate.observation_count::numeric
        )::numeric(30,12)
        ELSE NULL
      END AS standard_error
    ) uncertainty
  ) control_statistics ON TRUE
  ORDER BY claim.occurred_at DESC, claim.id DESC
`;

function objectArray(value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (JSON.parse(value) as unknown[])
      : [];
  return raw.map(details);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalUuid(value: unknown) {
  const normalized = optionalString(value)?.toLowerCase() ?? null;
  return normalized &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      normalized,
    )
    ? normalized
    : null;
}

function optionalHash(value: unknown) {
  const normalized = optionalString(value)?.toLowerCase() ?? null;
  return normalized && /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function optionalTimestamp(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  const normalized = optionalString(value);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function scaledInteger(value: unknown) {
  const fixed = fixedNumeric(value, "metricValue");
  const negative = fixed.startsWith("-");
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [integer, fraction] = unsigned.split(".");
  const scaled = BigInt(`${integer}${fraction}`);
  return negative ? -scaled : scaled;
}

function weightedAverageFixed(
  observations: Array<{ value: unknown; sampleSize: number }>,
) {
  let weighted = BigInt(0);
  let sample = BigInt(0);
  for (const observation of observations) {
    const size = BigInt(observation.sampleSize);
    weighted += scaledInteger(observation.value) * size;
    sample += size;
  }
  if (sample <= BigInt(0)) return null;
  let quotient = weighted / sample;
  const remainder = weighted % sample;
  if (
    remainder !== BigInt(0) &&
    (remainder < BigInt(0) ? -remainder : remainder) * BigInt(2) >= sample
  ) {
    quotient += weighted < BigInt(0) ? BigInt(-1) : BigInt(1);
  }
  const negative = quotient < BigInt(0);
  const digits = (negative ? -quotient : quotient).toString().padStart(13, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -12)}.${digits.slice(-12)}`;
}

const REASON_ORDER: readonly ControlledEvidenceInvalidReason[] = [
  "payload_invalid",
  "scope_invalid",
  "experiment_invalid",
  "batch_invalid",
  "seed_reveal_invalid",
  "full_batch_randomization_invalid",
  "assignment_invalid",
  "assignment_reused",
  "receipt_invalid",
  "receipt_reused",
  "provider_verification_invalid",
  "chronology_invalid",
  "control_observation_invalid",
  "estimate_invalid",
  "estimate_reused",
  "outcome_invalid",
];

function validateHydrationRow(
  row: Record<string, unknown>,
  scope: ReturnType<typeof normalizedScope>,
): VerifiedControlledEvidenceRow {
  const reasons = new Set<ControlledEvidenceInvalidReason>();
  const payload = details(row.payload_json);
  const design = details(payload.causalDesign);
  const receiptClaim = details(payload.treatmentReceipt);
  const claim = {
    experimentId: optionalString(design.experimentId),
    batchId: optionalString(design.batchId),
    assignmentId: optionalString(design.assignmentId),
    estimateId: optionalString(design.estimateId),
    actionLogId: optionalUuid(receiptClaim.actionLogId),
  };
  if (
    payload.evidenceClass !== CONTROLLED_EVIDENCE_CLASS ||
    Object.keys(design).sort().join(",") !==
      "assignmentId,batchId,contractVersion,estimateId,experimentId,method" ||
    design.contractVersion !== CONTROLLED_CAUSAL_DESIGN_VERSION ||
    design.method !== "randomized_controlled_trial" ||
    !claim.experimentId ||
    !claim.batchId ||
    !claim.assignmentId ||
    !claim.estimateId ||
    Object.keys(receiptClaim).sort().join(",") !==
      "actionLogId,assignmentId,batchId,contractVersion,experimentId,recId,recommendationFingerprint,status,verificationStatus" ||
    receiptClaim.contractVersion !== CONTROLLED_TREATMENT_RECEIPT_VERSION ||
    !claim.actionLogId
  ) {
    reasons.add("payload_invalid");
  }
  if (
    optionalUuid(row.outcome_business_id) !== scope.businessId ||
    optionalUuid(row.outcome_provider_account_ref_id) !==
      scope.providerAccountRefId ||
    optionalString(row.outcome_provider_account_id) !== scope.providerAccountId
  ) {
    reasons.add("scope_invalid");
  }

  const experiment = details(row.experiment_json);
  let arms: ControlledArmRecord[] = [];
  try {
    arms = parseRegisteredArms(row.arms_json);
    const registrationBase = {
      contractVersion: CONTROLLED_EXPERIMENT_VERSION,
      experimentId: requiredString(experiment.id, "experiment.id"),
      businessId: requiredUuid(experiment.business_id, "experiment.businessId"),
      providerAccountRefId: requiredUuid(
        experiment.provider_account_ref_id,
        "experiment.providerAccountRefId",
      ),
      providerAccountId: requiredString(
        experiment.provider_account_id,
        "experiment.providerAccountId",
      ),
      name: requiredString(experiment.name, "experiment.name"),
      hypothesis: requiredString(
        experiment.hypothesis,
        "experiment.hypothesis",
      ),
      primaryMetric: requiredMetricName(
        experiment.primary_metric,
        "experiment.primaryMetric",
      ),
      metricDirection: requiredDirection(
        experiment.metric_direction,
        "experiment.metricDirection",
      ),
      randomizationUnit: requiredEntityType(
        experiment.randomization_unit,
        "experiment.randomizationUnit",
      ),
      randomizationAlgorithm: requiredString(
        experiment.randomization_algorithm,
        "experiment.randomizationAlgorithm",
      ),
      seedCommitmentHash: requiredHash(
        experiment.seed_commitment_hash,
        "experiment.seedCommitmentHash",
      ),
      eligibilityCount: Number(experiment.eligibility_count),
      eligibilityHash: requiredHash(
        experiment.eligibility_hash,
        "experiment.eligibilityHash",
      ),
      assignmentManifestHash: requiredHash(
        experiment.assignment_manifest_hash,
        "experiment.assignmentManifestHash",
      ),
      startsAt: databaseTimestamp(experiment.starts_at, "experiment.startsAt"),
      outcomeWindowStartAt: databaseTimestamp(
        experiment.outcome_window_start_at,
        "experiment.outcomeWindowStartAt",
      ),
      outcomeWindowEndAt: databaseTimestamp(
        experiment.outcome_window_end_at,
        "experiment.outcomeWindowEndAt",
      ),
      endsAt: databaseTimestamp(experiment.ends_at, "experiment.endsAt"),
      arms: arms.map((arm) => ({
        contractVersion: CONTROLLED_ARM_VERSION,
        experimentId: claim.experimentId,
        ...arm,
      })),
    };
    if (
      registrationBase.experimentId !== claim.experimentId ||
      registrationBase.businessId !== scope.businessId ||
      registrationBase.providerAccountRefId !== scope.providerAccountRefId ||
      registrationBase.providerAccountId !== scope.providerAccountId ||
      registrationBase.randomizationUnit !== "ad" ||
      registrationBase.randomizationAlgorithm !==
        CONTROLLED_RANDOMIZATION_ALGORITHM ||
      controlledSha256(registrationBase) !== experiment.registration_hash
    ) {
      reasons.add("experiment_invalid");
    }
  } catch {
    reasons.add("experiment_invalid");
  }

  const batch = details(row.batch_json);
  const seedReveal = details(row.seed_reveal_json);
  const assignmentRows = objectArray(row.assignments_json);
  let manifest: ControlledEligibilityEntry[] = [];
  let eligibilityContract: ReturnType<typeof buildEligibilityContract> | null =
    null;
  try {
    manifest = normalizeManifest(
      objectArray(batch.eligibility_manifest_json).map((entry) => ({
        assignmentId: String(entry.assignmentId ?? ""),
        recommendationFingerprint: String(
          entry.recommendationFingerprint ?? "",
        ),
        recId: String(entry.recId ?? ""),
        evaluationId: String(entry.evaluationId ?? ""),
        snapshotId: String(entry.snapshotId ?? ""),
        target: {
          entityType: details(entry.target).entityType as ControlledEntityType,
          entityId: String(details(entry.target).entityId ?? ""),
        },
      })),
    );
    eligibilityContract = buildEligibilityContract(manifest);
    if (
      batch.contract_version !== CONTROLLED_BATCH_VERSION ||
      batch.id !== claim.batchId ||
      batch.experiment_id !== claim.experimentId ||
      Number(batch.eligibility_count) !==
        eligibilityContract.eligibilityCount ||
      batch.eligibility_hash !== eligibilityContract.eligibilityHash ||
      batch.assignment_manifest_hash !==
        eligibilityContract.assignmentManifestHash ||
      optionalUuid(batch.business_id) !== scope.businessId ||
      optionalUuid(batch.provider_account_ref_id) !==
        scope.providerAccountRefId ||
      batch.provider_account_id !== scope.providerAccountId ||
      assignmentRows.length !== eligibilityContract.eligibilityCount ||
      Number(experiment.eligibility_count) !==
        eligibilityContract.eligibilityCount ||
      experiment.eligibility_hash !== eligibilityContract.eligibilityHash ||
      experiment.assignment_manifest_hash !==
        eligibilityContract.assignmentManifestHash
    ) {
      reasons.add("batch_invalid");
    }
  } catch {
    reasons.add("batch_invalid");
  }

  const revealedSeed = optionalString(seedReveal.revealed_seed);
  try {
    const seedHash = revealedSeed
      ? buildSeedCommitment({
          experimentId: claim.experimentId ?? "",
          seed: revealedSeed,
        })
      : null;
    const revealHash = controlledSha256({
      contractVersion: CONTROLLED_SEED_REVEAL_VERSION,
      batchId: claim.batchId,
      experimentId: claim.experimentId,
      businessId: scope.businessId,
      providerAccountRefId: scope.providerAccountRefId,
      providerAccountId: scope.providerAccountId,
      seedHash,
      seed: revealedSeed,
    });
    if (
      !revealedSeed ||
      seedReveal.contract_version !== CONTROLLED_SEED_REVEAL_VERSION ||
      seedReveal.batch_id !== claim.batchId ||
      optionalUuid(seedReveal.business_id) !== scope.businessId ||
      optionalUuid(seedReveal.provider_account_ref_id) !==
        scope.providerAccountRefId ||
      seedReveal.provider_account_id !== scope.providerAccountId ||
      seedHash !== experiment.seed_commitment_hash ||
      seedReveal.seed_hash !== seedHash ||
      seedReveal.reveal_hash !== revealHash
    ) {
      reasons.add("seed_reveal_invalid");
    }
  } catch {
    reasons.add("seed_reveal_invalid");
  }

  const assignmentsById = new Map(
    assignmentRows.map((assignment) => [String(assignment.id), assignment]),
  );
  if (eligibilityContract && revealedSeed && arms.length > 0) {
    for (const entry of eligibilityContract.manifest) {
      const persisted = assignmentsById.get(entry.assignmentId);
      if (!persisted) {
        reasons.add("full_batch_randomization_invalid");
        break;
      }
      const proof = randomization({
        experimentId: claim.experimentId ?? "",
        businessId: scope.businessId,
        providerAccountId: scope.providerAccountId,
        target: entry.target,
        seed: revealedSeed,
      });
      const arm = chooseArm(arms, proof.draw);
      const assignmentBase = {
        contractVersion: CONTROLLED_ASSIGNMENT_VERSION,
        ...entry,
        experimentId: claim.experimentId,
        batchId: claim.batchId,
        armId: arm.armId,
        armRole: arm.role,
        assignedAction: arm.treatmentAction,
        assignmentProbability: arm.assignmentProbability,
        randomizationAlgorithm: CONTROLLED_RANDOMIZATION_ALGORITHM,
        seedCommitmentHash: experiment.seed_commitment_hash,
        eligibilityHash: eligibilityContract.eligibilityHash,
        randomizationDraw: proof.draw,
        randomizationProofHash: proof.proofHash,
      };
      if (
        persisted.contract_version !== CONTROLLED_ASSIGNMENT_VERSION ||
        persisted.experiment_id !== assignmentBase.experimentId ||
        persisted.batch_id !== assignmentBase.batchId ||
        persisted.arm_id !== arm.armId ||
        persisted.arm_role !== arm.role ||
        persisted.recommendation_fingerprint !==
          entry.recommendationFingerprint ||
        persisted.rec_id !== entry.recId ||
        optionalUuid(persisted.evaluation_id) !== entry.evaluationId ||
        optionalUuid(persisted.snapshot_id) !== entry.snapshotId ||
        persisted.entity_type !== entry.target.entityType ||
        persisted.entity_id !== entry.target.entityId ||
        optionalString(persisted.assigned_action) !== arm.treatmentAction ||
        Number(persisted.assignment_probability) !==
          arm.assignmentProbability ||
        Number(persisted.randomization_draw) !== proof.draw ||
        persisted.randomization_proof_hash !== proof.proofHash ||
        persisted.assignment_hash !== controlledSha256(assignmentBase) ||
        optionalTimestamp(persisted.assigned_at) !==
          optionalTimestamp(batch.assigned_at)
      ) {
        reasons.add("full_batch_randomization_invalid");
        break;
      }
    }
    const expectedBatchHash = controlledSha256({
      contractVersion: CONTROLLED_BATCH_VERSION,
      batchId: claim.batchId,
      experimentId: claim.experimentId,
      businessId: scope.businessId,
      providerAccountRefId: scope.providerAccountRefId,
      providerAccountId: scope.providerAccountId,
      eligibilityCount: eligibilityContract.eligibilityCount,
      eligibilityHash: eligibilityContract.eligibilityHash,
      assignmentManifestHash: eligibilityContract.assignmentManifestHash,
      assignments: eligibilityContract.manifest.map((entry) => ({
        assignmentId: entry.assignmentId,
        assignmentHash: assignmentsById.get(entry.assignmentId)
          ?.assignment_hash,
      })),
    });
    if (batch.batch_hash !== expectedBatchHash) {
      reasons.add("batch_invalid");
    }
  } else {
    reasons.add("full_batch_randomization_invalid");
  }

  const assignment = assignmentsById.get(claim.assignmentId ?? "") ?? {};
  if (
    !claim.assignmentId ||
    assignment.id !== claim.assignmentId ||
    assignment.arm_role !== "treatment" ||
    !optionalString(assignment.assigned_action) ||
    assignment.recommendation_fingerprint !== row.recommendation_fingerprint ||
    assignment.rec_id !== row.rec_id
  ) {
    reasons.add("assignment_invalid");
  }
  if (Number(row.assignment_claim_count) !== 1) {
    reasons.add("assignment_reused");
  }

  const action = details(row.action_log_json);
  const providerVerification = details(action.verification_payload);
  if (
    optionalUuid(action.id) !== claim.actionLogId ||
    action.controlled_assignment_id !== claim.assignmentId ||
    action.target_entity_type !== assignment.entity_type ||
    action.target_entity_id !== assignment.entity_id ||
    optionalUuid(action.source_snapshot_id) !==
      optionalUuid(assignment.snapshot_id) ||
    optionalUuid(action.source_evaluation_id) !==
      optionalUuid(assignment.evaluation_id) ||
    !optionalString(action.engine_version) ||
    !optionalHash(action.decision_hash) ||
    action.action !== assignment.assigned_action ||
    action.rec_id_origin !== assignment.rec_id ||
    action.status !== "success" ||
    action.dry_run !== false ||
    optionalUuid(action.business_id) !== scope.businessId ||
    optionalUuid(action.provider_account_ref_id) !==
      scope.providerAccountRefId ||
    action.provider_account_id !== scope.providerAccountId ||
    receiptClaim.status !== "success" ||
    receiptClaim.verificationStatus !== "verified" ||
    receiptClaim.recommendationFingerprint !== row.recommendation_fingerprint ||
    receiptClaim.recId !== row.rec_id ||
    receiptClaim.experimentId !== claim.experimentId ||
    receiptClaim.batchId !== claim.batchId ||
    receiptClaim.assignmentId !== claim.assignmentId
  ) {
    reasons.add("receipt_invalid");
  }
  if (Number(row.action_log_claim_count) !== 1) {
    reasons.add("receipt_reused");
  }
  let providerVerificationHashValid = false;
  try {
    providerVerificationHashValid =
      buildControlledProviderVerificationHash({
        actionLogId: String(action.id),
        controlledAssignmentId: String(action.controlled_assignment_id),
        businessId: String(action.business_id),
        providerAccountRefId: String(action.provider_account_ref_id),
        providerAccountId: String(action.provider_account_id),
        snapshotId: String(action.source_snapshot_id),
        evaluationId: String(action.source_evaluation_id),
        engineVersion: String(action.engine_version),
        decisionHash: String(action.decision_hash),
        entityType: "ad",
        entityId: String(action.target_entity_id),
        action: String(action.provider_action),
        status: String(action.provider_status),
        observedAt: databaseTimestamp(
          action.provider_observed_at,
          "action.providerObservedAt",
        ),
        responseHash: String(action.provider_response_hash),
      }) === action.provider_verification_hash;
  } catch {
    providerVerificationHashValid = false;
  }
  if (
    Object.keys(providerVerification).sort().join(",") !==
      "action,actionLogId,businessId,contractVersion,controlledAssignmentId,decisionHash,engineVersion,entityId,entityType,evaluationId,observedAt,providerAccountId,providerAccountRefId,responseHash,snapshotId,status" ||
    providerVerification.contractVersion !==
      CONTROLLED_PROVIDER_VERIFICATION_VERSION ||
    providerVerification.actionLogId !== String(action.id) ||
    providerVerification.controlledAssignmentId !==
      action.controlled_assignment_id ||
    providerVerification.businessId !== String(action.business_id) ||
    providerVerification.providerAccountRefId !==
      String(action.provider_account_ref_id) ||
    providerVerification.providerAccountId !== action.provider_account_id ||
    providerVerification.snapshotId !== String(action.source_snapshot_id) ||
    providerVerification.evaluationId !== String(action.source_evaluation_id) ||
    providerVerification.engineVersion !== action.engine_version ||
    providerVerification.decisionHash !== action.decision_hash ||
    providerVerification.entityType !== action.target_entity_type ||
    providerVerification.entityId !== action.target_entity_id ||
    action.provider_entity_id !== action.target_entity_id ||
    providerVerification.action !== action.provider_action ||
    action.provider_action !== action.action ||
    providerVerification.status !== action.provider_status ||
    !(
      (action.provider_action === "pause" &&
        action.provider_status === "PAUSED") ||
      (action.provider_action === "resume" &&
        action.provider_status === "ACTIVE")
    ) ||
    optionalTimestamp(providerVerification.observedAt) !==
      optionalTimestamp(action.provider_observed_at) ||
    providerVerification.responseHash !== action.provider_response_hash ||
    !optionalHash(action.provider_response_hash) ||
    !providerVerificationHashValid
  ) {
    reasons.add("provider_verification_invalid");
  }

  const estimate = details(row.estimate_json);
  const treatedNativeOutcome = details(row.treated_native_outcome_json);
  const treatedSourceReceipts = details(
    treatedNativeOutcome.source_receipts_json,
  );
  const matchingTreatedActionReceipts = objectArray(
    treatedSourceReceipts.verifiedActions,
  ).filter(
    (receipt) =>
      receipt.id === action.id &&
      receipt.businessId === scope.businessId &&
      receipt.providerAccountRefId === scope.providerAccountRefId &&
      receipt.providerAccountId === scope.providerAccountId &&
      receipt.targetEntityType === "ad" &&
      receipt.targetEntityId === assignment.entity_id &&
      receipt.action === action.action &&
      receipt.status === "success" &&
      receipt.dryRun === false &&
      optionalTimestamp(receipt.executedAt) ===
        optionalTimestamp(action.executed_at) &&
      optionalTimestamp(receipt.verifiedAt) ===
        optionalTimestamp(action.verified_at) &&
      receipt.providerEntityId === action.provider_entity_id &&
      receipt.providerAction === action.provider_action &&
      receipt.providerStatus === action.provider_status &&
      optionalTimestamp(receipt.providerObservedAt) ===
        optionalTimestamp(action.provider_observed_at) &&
      receipt.providerResponseHash === action.provider_response_hash &&
      receipt.providerVerificationHash === action.provider_verification_hash &&
      receipt.source === "decision_origin" &&
      receipt.sourceSnapshotId === String(action.source_snapshot_id) &&
      receipt.sourceEvaluationId === String(action.source_evaluation_id) &&
      receipt.engineVersion === action.engine_version &&
      receipt.decisionHash === action.decision_hash &&
      receipt.nativeDecisionLineageValidated === true &&
      receipt.controlledReceiptHashValidated === true &&
      receipt.controlledAssignmentId === assignment.id &&
      receipt.recIdOrigin === assignment.rec_id,
  );
  const controlStatistics = details(row.control_statistics_json);
  const observations = objectArray(row.observations_json);
  const observationSummaries: Array<{
    id: string;
    value: string;
    sampleSize: number;
    sourceLine: string;
    asOf: string;
  }> = [];
  for (const observation of observations) {
    try {
      const sourceReceipt = details(observation.source_receipt_json);
      const nativeOutcome = details(observation.native_outcome);
      const nativeSourceReceipts = details(nativeOutcome.source_receipts_json);
      const summary = {
        id: requiredUuid(observation.id, "observation.id"),
        value: fixedNumeric(
          observation.metric_value,
          "observation.metricValue",
        ),
        sampleSize: Number(observation.sample_size),
        sourceLine: `${requiredUuid(observation.native_outcome_id, "nativeOutcomeId")}\u001f${requiredHash(observation.native_outcome_source_manifest_hash, "nativeOutcomeSourceManifestHash")}`,
        asOf: databaseTimestamp(observation.as_of, "observation.asOf"),
      };
      const controlAssignment = assignmentsById.get(
        String(observation.control_assignment_id),
      );
      const nativeMetricValue =
        observation.metric_name === "outcome_roas"
          ? nativeOutcome.outcome_roas
          : observation.metric_name === "outcome_revenue"
            ? nativeOutcome.outcome_revenue
            : observation.metric_name === "outcome_purchases"
              ? nativeOutcome.outcome_purchases
              : observation.metric_name === "outcome_spend"
                ? nativeOutcome.outcome_spend
                : null;
      const expectedObservationHash = buildControlObservationHash({
        observationId: summary.id,
        experimentId: String(observation.experiment_id),
        batchId: String(observation.batch_id),
        controlAssignmentId: String(observation.control_assignment_id),
        nativeOutcomeId: String(observation.native_outcome_id),
        nativeOutcomeContractVersion: String(
          observation.native_outcome_contract_version,
        ),
        nativeOutcomeClassifierVersion: String(
          observation.native_outcome_classifier_version,
        ),
        nativeOutcomeSourceManifestHash: String(
          observation.native_outcome_source_manifest_hash,
        ),
        nativeOutcomeComputedAt: databaseTimestamp(
          observation.native_outcome_computed_at,
          "observation.nativeOutcomeComputedAt",
        ),
        metricName: requiredMetricName(
          observation.metric_name,
          "observation.metricName",
        ),
        metricDirection:
          observation.metric_direction as ControlledMetricDirection,
        windowStartAt: databaseTimestamp(
          observation.window_start_at,
          "observation.windowStartAt",
        ),
        windowEndAt: databaseTimestamp(
          observation.window_end_at,
          "observation.windowEndAt",
        ),
        value: summary.value,
        observedAt: databaseTimestamp(
          observation.observed_at,
          "observation.observedAt",
        ),
        asOf: summary.asOf,
      });
      if (
        observation.contract_version !== CONTROLLED_OBSERVATION_VERSION ||
        observation.observation_status !== "finalized" ||
        observation.arm_role !== "control" ||
        controlAssignment?.arm_role !== "control" ||
        observation.metric_name !== experiment.primary_metric ||
        observation.metric_direction !== experiment.metric_direction ||
        optionalUuid(nativeOutcome.id) !==
          optionalUuid(observation.native_outcome_id) ||
        nativeOutcome.contract_version !==
          observation.native_outcome_contract_version ||
        nativeOutcome.classifier_version !==
          observation.native_outcome_classifier_version ||
        nativeOutcome.source_manifest_hash !==
          observation.native_outcome_source_manifest_hash ||
        optionalTimestamp(nativeOutcome.computed_at) !==
          optionalTimestamp(observation.native_outcome_computed_at) ||
        optionalUuid(nativeOutcome.decision_snapshot_id) !==
          optionalUuid(controlAssignment?.snapshot_id) ||
        optionalUuid(nativeOutcome.evaluation_id) !==
          optionalUuid(controlAssignment?.evaluation_id) ||
        optionalUuid(nativeOutcome.business_ref_id) !== scope.businessId ||
        nativeOutcome.business_id !== scope.businessId ||
        nativeOutcome.provider_account_id !== scope.providerAccountId ||
        nativeOutcome.decision_entity_type !== controlAssignment?.entity_type ||
        nativeOutcome.decision_entity_id !== controlAssignment?.entity_id ||
        nativeOutcome.ad_id !== controlAssignment?.entity_id ||
        nativeOutcome.window_complete !== true ||
        nativeOutcome.measurement_status !== "known" ||
        !["positive", "negative", "neutral"].includes(
          String(nativeOutcome.realized_outcome),
        ) ||
        nativeOutcome.action_contaminated !== false ||
        !optionalHash(nativeOutcome.action_source_hash) ||
        !Array.isArray(nativeSourceReceipts.verifiedActions) ||
        nativeSourceReceipts.verifiedActions.length !== 0 ||
        fixedNumeric(String(nativeMetricValue), "nativeOutcome.metricValue") !==
          summary.value ||
        optionalTimestamp(observation.window_start_at) !==
          optionalTimestamp(experiment.outcome_window_start_at) ||
        optionalTimestamp(observation.window_end_at) !==
          optionalTimestamp(experiment.outcome_window_end_at) ||
        optionalTimestamp(nativeOutcome.outcome_window_start) !==
          optionalTimestamp(experiment.outcome_window_start_at) ||
        optionalTimestamp(nativeOutcome.outcome_window_end) !==
          optionalTimestamp(experiment.outcome_window_end_at) ||
        Object.keys(sourceReceipt).sort().join(",") !==
          "computedAt,contractVersion,metricName,nativeOutcomeId,sourceManifestHash" ||
        sourceReceipt.contractVersion !== CONTROLLED_SOURCE_RECEIPT_VERSION ||
        sourceReceipt.nativeOutcomeId !==
          String(observation.native_outcome_id) ||
        sourceReceipt.sourceManifestHash !==
          observation.native_outcome_source_manifest_hash ||
        sourceReceipt.metricName !== observation.metric_name ||
        optionalTimestamp(sourceReceipt.computedAt) !==
          optionalTimestamp(observation.native_outcome_computed_at) ||
        observation.source_receipt_id !==
          String(observation.native_outcome_id) ||
        observation.source_receipt_hash !==
          observation.native_outcome_source_manifest_hash ||
        optionalTimestamp(observation.observed_at) !==
          optionalTimestamp(observation.native_outcome_computed_at) ||
        optionalTimestamp(observation.as_of) !==
          optionalTimestamp(experiment.ends_at) ||
        optionalTimestamp(observation.finalized_at) !==
          optionalTimestamp(observation.created_at) ||
        Date.parse(
          databaseTimestamp(
            nativeOutcome.computed_at,
            "nativeOutcome.computedAt",
          ),
        ) <
          Date.parse(
            databaseTimestamp(
              observation.window_end_at,
              "observation.windowEndAt",
            ),
          ) ||
        Date.parse(
          databaseTimestamp(
            nativeOutcome.computed_at,
            "nativeOutcome.computedAt",
          ),
        ) >
          Date.parse(
            databaseTimestamp(experiment.ends_at, "experiment.endsAt"),
          ) ||
        Date.parse(
          databaseTimestamp(
            observation.finalized_at,
            "observation.finalizedAt",
          ),
        ) <
          Date.parse(
            databaseTimestamp(experiment.ends_at, "experiment.endsAt"),
          ) ||
        observation.observation_hash !== expectedObservationHash ||
        summary.sampleSize !== 1
      ) {
        throw new Error("invalid observation");
      }
      observationSummaries.push(summary);
    } catch {
      reasons.add("control_observation_invalid");
      break;
    }
  }

  try {
    const observationIds = observationSummaries.map((entry) => entry.id).sort();
    const expectedControlCount = assignmentRows.filter(
      (entry) => entry.arm_role === "control",
    ).length;
    const expectedValue = weightedAverageFixed(
      observationSummaries.map((entry) => ({
        value: entry.value,
        sampleSize: entry.sampleSize,
      })),
    );
    const expectedSample = observationSummaries.reduce(
      (sum, entry) => sum + entry.sampleSize,
      0,
    );
    const sourceManifestHash = hashLines(
      observationSummaries
        .map((entry) => entry.sourceLine)
        .sort((left, right) => left.localeCompare(right)),
    );
    const asOfValues = new Set(observationSummaries.map((entry) => entry.asOf));
    const asOf = asOfValues.size === 1 ? [...asOfValues][0]! : "";
    const expectedVariance = fixedNumeric(
      controlStatistics.estimate_variance,
      "statistics.estimateVariance",
    );
    const expectedStandardError = fixedNumeric(
      controlStatistics.standard_error,
      "statistics.standardError",
    );
    const expectedLower = fixedNumeric(
      controlStatistics.confidence_95_lower,
      "statistics.confidence95Lower",
    );
    const expectedUpper = fixedNumeric(
      controlStatistics.confidence_95_upper,
      "statistics.confidence95Upper",
    );
    const expectedEstimateHash = estimateHashMaterial({
      estimateId: String(estimate.id),
      experimentId: String(estimate.experiment_id),
      batchId: String(estimate.batch_id),
      treatedAssignmentId: String(estimate.treated_assignment_id),
      treatedOutcomeLogId: String(estimate.treated_outcome_log_id),
      treatedNativeOutcomeId: String(estimate.treated_native_outcome_id),
      treatedNativeOutcomeSourceManifestHash: String(
        estimate.treated_native_outcome_source_manifest_hash,
      ),
      treatedMetricValue: String(estimate.treated_metric_value),
      treatmentActionLogId: String(estimate.treatment_action_log_id),
      controlArmId: String(estimate.control_arm_id),
      metricName: String(estimate.metric_name),
      metricDirection: String(estimate.metric_direction),
      windowStartAt: databaseTimestamp(
        estimate.window_start_at,
        "estimate.windowStartAt",
      ),
      windowEndAt: databaseTimestamp(
        estimate.window_end_at,
        "estimate.windowEndAt",
      ),
      observationIds,
      sourceManifestHash,
      asOf,
      value: String(expectedValue),
      sampleSize: expectedSample,
      variance: String(estimate.estimate_variance),
      standardError: String(estimate.standard_error),
      confidence95Lower: String(estimate.confidence_95_lower),
      confidence95Upper: String(estimate.confidence_95_upper),
    });
    const treatedMetricField =
      experiment.primary_metric === "outcome_roas"
        ? treatedNativeOutcome.outcome_roas
        : experiment.primary_metric === "outcome_revenue"
          ? treatedNativeOutcome.outcome_revenue
          : experiment.primary_metric === "outcome_purchases"
            ? treatedNativeOutcome.outcome_purchases
            : experiment.primary_metric === "outcome_spend"
              ? treatedNativeOutcome.outcome_spend
              : null;
    if (
      estimate.contract_version !== CONTROLLED_ESTIMATE_VERSION ||
      estimate.id !== claim.estimateId ||
      estimate.experiment_id !== claim.experimentId ||
      estimate.batch_id !== claim.batchId ||
      estimate.treated_assignment_id !== claim.assignmentId ||
      optionalUuid(estimate.business_id) !== scope.businessId ||
      optionalUuid(estimate.provider_account_ref_id) !==
        scope.providerAccountRefId ||
      estimate.provider_account_id !== scope.providerAccountId ||
      optionalUuid(estimate.treated_outcome_log_id) !==
        optionalUuid(row.outcome_log_id) ||
      optionalUuid(estimate.treated_native_outcome_id) !==
        optionalUuid(treatedNativeOutcome.id) ||
      estimate.treated_native_outcome_source_manifest_hash !==
        treatedNativeOutcome.source_manifest_hash ||
      fixedNumeric(
        estimate.treated_metric_value,
        "estimate.treatedMetricValue",
      ) !==
        fixedNumeric(
          String(treatedMetricField),
          "nativeOutcome.treatedMetricValue",
        ) ||
      optionalUuid(treatedNativeOutcome.decision_snapshot_id) !==
        optionalUuid(assignment.snapshot_id) ||
      optionalUuid(treatedNativeOutcome.evaluation_id) !==
        optionalUuid(assignment.evaluation_id) ||
      optionalUuid(treatedNativeOutcome.business_ref_id) !== scope.businessId ||
      treatedNativeOutcome.provider_account_id !== scope.providerAccountId ||
      treatedNativeOutcome.decision_entity_type !== assignment.entity_type ||
      treatedNativeOutcome.decision_entity_id !== assignment.entity_id ||
      treatedNativeOutcome.ad_id !== assignment.entity_id ||
      treatedNativeOutcome.window_complete !== true ||
      treatedNativeOutcome.measurement_status !== "known" ||
      treatedNativeOutcome.action_contaminated !== true ||
      !optionalHash(treatedNativeOutcome.action_source_hash) ||
      matchingTreatedActionReceipts.length !== 1 ||
      treatedNativeOutcome.realized_outcome !== row.outcome_status ||
      optionalTimestamp(treatedNativeOutcome.outcome_window_start) !==
        optionalTimestamp(experiment.outcome_window_start_at) ||
      optionalTimestamp(treatedNativeOutcome.outcome_window_end) !==
        optionalTimestamp(experiment.outcome_window_end_at) ||
      optionalTimestamp(treatedNativeOutcome.computed_at) === null ||
      optionalUuid(estimate.treatment_action_log_id) !== claim.actionLogId ||
      observationIds.length <= 1 ||
      observationIds.length !== expectedControlCount ||
      Number(estimate.observation_count) !== observationIds.length ||
      JSON.stringify(stringArray(estimate.observation_ids).sort()) !==
        JSON.stringify(observationIds) ||
      estimate.source_manifest_hash !== sourceManifestHash ||
      optionalTimestamp(estimate.as_of) !== asOf ||
      fixedNumeric(estimate.estimate_value, "estimate.value") !==
        expectedValue ||
      Number(estimate.sample_size) !== expectedSample ||
      Number(controlStatistics.observation_count) !== expectedSample ||
      fixedNumeric(
        controlStatistics.estimate_value,
        "statistics.estimateValue",
      ) !== expectedValue ||
      fixedNumeric(estimate.estimate_variance, "estimate.variance") !==
        expectedVariance ||
      fixedNumeric(estimate.standard_error, "estimate.standardError") !==
        expectedStandardError ||
      fixedNumeric(
        estimate.confidence_95_lower,
        "estimate.confidence95Lower",
      ) !== expectedLower ||
      fixedNumeric(
        estimate.confidence_95_upper,
        "estimate.confidence95Upper",
      ) !== expectedUpper ||
      estimate.estimate_hash !== expectedEstimateHash
    ) {
      reasons.add("estimate_invalid");
    }
  } catch {
    reasons.add("estimate_invalid");
  }
  if (Number(row.estimate_claim_count) !== 1) {
    reasons.add("estimate_reused");
  }

  const assignedAt = optionalTimestamp(assignment.assigned_at);
  const batchAssignedAt = optionalTimestamp(batch.assigned_at);
  const revealedAt = optionalTimestamp(seedReveal.revealed_at);
  const executedAt = optionalTimestamp(action.executed_at);
  const providerObservedAt = optionalTimestamp(action.provider_observed_at);
  const verifiedAt = optionalTimestamp(action.verified_at);
  const startsAt = optionalTimestamp(experiment.starts_at);
  const endsAt = optionalTimestamp(experiment.ends_at);
  const windowStartAt = optionalTimestamp(estimate.window_start_at);
  const windowEndAt = optionalTimestamp(estimate.window_end_at);
  const occurredAt = optionalTimestamp(row.occurred_at);
  const estimateAsOf = optionalTimestamp(estimate.as_of);
  const estimateFinalizedAt = optionalTimestamp(estimate.finalized_at);
  const treatedNativeOutcomeComputedAt = optionalTimestamp(
    treatedNativeOutcome.computed_at,
  );
  if (
    !assignedAt ||
    assignedAt !== batchAssignedAt ||
    !revealedAt ||
    !executedAt ||
    !startsAt ||
    !endsAt ||
    !windowStartAt ||
    !windowEndAt ||
    !occurredAt ||
    !estimateAsOf ||
    !estimateFinalizedAt ||
    !treatedNativeOutcomeComputedAt ||
    Date.parse(assignedAt) >= Date.parse(executedAt) ||
    Date.parse(revealedAt) > Date.parse(executedAt) ||
    Date.parse(executedAt) < Date.parse(startsAt) ||
    Date.parse(executedAt) > Date.parse(endsAt) ||
    Date.parse(executedAt) > Date.parse(windowStartAt) ||
    !providerObservedAt ||
    !verifiedAt ||
    Date.parse(providerObservedAt) < Date.parse(executedAt) ||
    Date.parse(providerObservedAt) > Date.parse(verifiedAt) ||
    Date.parse(verifiedAt) > Date.parse(windowStartAt) ||
    Date.parse(treatedNativeOutcomeComputedAt) < Date.parse(windowEndAt) ||
    Date.parse(treatedNativeOutcomeComputedAt) > Date.parse(occurredAt) ||
    Date.parse(treatedNativeOutcomeComputedAt) > Date.parse(endsAt) ||
    Date.parse(occurredAt) < Date.parse(windowEndAt) ||
    Date.parse(occurredAt) > Date.parse(estimateAsOf) ||
    Date.parse(estimateAsOf) > Date.parse(estimateFinalizedAt)
  ) {
    reasons.add("chronology_invalid");
  }
  if (
    row.action_type !== "outcome" ||
    !["positive", "negative", "neutral"].includes(String(row.outcome_status)) ||
    row.recommendation_fingerprint !== assignment.recommendation_fingerprint ||
    row.rec_id !== assignment.rec_id
  ) {
    reasons.add("outcome_invalid");
  }

  const assignmentBlockers: ControlledEvidenceInvalidReason[] = [
    "payload_invalid",
    "scope_invalid",
    "experiment_invalid",
    "batch_invalid",
    "seed_reveal_invalid",
    "full_batch_randomization_invalid",
    "assignment_invalid",
    "assignment_reused",
  ];
  const receiptBlockers: ControlledEvidenceInvalidReason[] = [
    ...assignmentBlockers,
    "receipt_invalid",
    "receipt_reused",
    "provider_verification_invalid",
    "chronology_invalid",
  ];
  const estimateBlockers: ControlledEvidenceInvalidReason[] = [
    ...assignmentBlockers,
    "control_observation_invalid",
    "estimate_invalid",
    "estimate_reused",
    "chronology_invalid",
    "outcome_invalid",
  ];
  const causalAssignmentValidated = !assignmentBlockers.some((reason) =>
    reasons.has(reason),
  );
  const treatmentReceiptValidated = !receiptBlockers.some((reason) =>
    reasons.has(reason),
  );
  const causalEstimateValidated = !estimateBlockers.some((reason) =>
    reasons.has(reason),
  );

  return {
    contractVersion: CONTROLLED_HYDRATION_VERSION,
    outcomeLogId: optionalUuid(row.outcome_log_id) ?? "",
    businessId: scope.businessId,
    providerAccountId: scope.providerAccountId,
    recommendationFingerprint: optionalString(row.recommendation_fingerprint),
    recId: optionalString(row.rec_id),
    recType: optionalString(row.rec_type),
    decisionLabel: optionalString(row.decision_label),
    actionType: optionalString(row.action_type),
    outcomeStatus: optionalString(row.outcome_status),
    payloadJson: row.payload_json,
    occurredAt,
    causalAssignmentValidated,
    treatmentReceiptValidated,
    causalEstimateValidated,
    controlledEvidenceValidated:
      causalAssignmentValidated &&
      treatmentReceiptValidated &&
      causalEstimateValidated,
    invalidReasonCodes: REASON_ORDER.filter((reason) => reasons.has(reason)),
    evidence: {
      experimentId: claim.experimentId,
      batchId: claim.batchId,
      assignmentId: claim.assignmentId,
      estimateId: claim.estimateId,
      actionLogId: claim.actionLogId,
      eligibilityCount: eligibilityContract?.eligibilityCount ?? null,
      hydratedAssignmentCount: assignmentRows.length,
      observationCount: observations.length,
      seedRevealedAt: revealedAt,
    },
  };
}

async function readVerifiedEvidence(
  query: ControlledRegistryQuery,
  assertCapabilities: () => Promise<void>,
  input: ReadControlledEvidenceInput,
) {
  if (input.outcomeLogIds && input.outcomeLogIds.length === 0) return [];
  const scope = normalizedScope(input);
  const recTypes = Array.from(
    new Set(input.recTypes.map((value) => value.trim()).filter(Boolean)),
  );
  if (recTypes.length === 0) {
    throw new ControlledRegistryValidationError(
      "empty_rec_types",
      "recTypes must contain at least one recommendation type.",
    );
  }
  const outcomeLogIds = input.outcomeLogIds
    ? Array.from(
        new Set(
          input.outcomeLogIds.map((id, index) =>
            requiredUuid(id, `outcomeLogIds[${index}]`),
          ),
        ),
      )
    : null;
  await assertCapabilities();
  const rows = await query<Record<string, unknown>>(
    READ_VERIFIED_EVIDENCE_SQL,
    [
      scope.businessId,
      scope.providerAccountRefId,
      scope.providerAccountId,
      recTypes,
      outcomeLogIds,
      Math.max(1, Math.min(Math.floor(input.limit ?? 500), 5_000)),
      CONTROLLED_EVIDENCE_CLASS,
    ],
  );
  return rows.map((row) => validateHydrationRow(row, scope));
}

export const controlledExperimentRegistry =
  createControlledExperimentRegistryStore();

export const inspectControlledRegistryCapabilities = () =>
  controlledExperimentRegistry.inspectCapabilities();
export const preregisterControlledExperiment = (
  input: PreregisterControlledExperimentInput,
) => controlledExperimentRegistry.preregisterExperiment(input);
export const createControlledAssignmentBatch = (
  input: CreateControlledAssignmentBatchInput,
) => controlledExperimentRegistry.createAssignmentBatch(input);
export const finalizeControlledSeedReveal = (
  input: FinalizeControlledSeedRevealInput,
) => controlledExperimentRegistry.finalizeSeedReveal(input);
export const materializeControlledControlObservations = (
  input: MaterializeControlledControlObservationsInput,
) => controlledExperimentRegistry.materializeControlObservations(input);
export const finalizeControlledControlEstimate = (
  input: FinalizeControlledEstimateInput,
) => controlledExperimentRegistry.finalizeControlEstimate(input);
export const readVerifiedControlledEvidenceForOutcomes = (
  input: ReadControlledEvidenceInput,
) => controlledExperimentRegistry.readVerifiedEvidence(input);
