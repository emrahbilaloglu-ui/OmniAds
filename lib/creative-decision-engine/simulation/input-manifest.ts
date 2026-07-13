import { createHash } from "node:crypto";

export const SIMULATION_INPUT_MANIFEST_VERSION =
  "creative-decision-simulation-input-manifest.v1" as const;

export const SIMULATION_SOURCE_MODES = [
  "exact_raw_pit",
  "restated_ad_daily",
  "persisted_decision_input",
  "unreconstructable",
] as const;

export type SimulationSourceMode = (typeof SIMULATION_SOURCE_MODES)[number];

export type SimulationProvenanceClass =
  | "exact_observation"
  | "bitemporal_observation"
  | "restated_fact"
  | "current_dimension"
  | "persisted_input"
  | "unknown";

export const SIMULATION_IDENTITY_FIELDS = [
  "account",
  "campaign",
  "adset",
  "ad",
  "creative",
  "goal",
  "country",
  "currency",
] as const;

export type SimulationIdentityField =
  (typeof SIMULATION_IDENTITY_FIELDS)[number];

export interface SimulationIdentityProvenance {
  value: string | null;
  required: boolean;
  source: string;
  evidenceClass: SimulationProvenanceClass;
  sourceId: string | null;
  observedAt: string | null;
}

export type SimulationIdentityProvenanceMap = Record<
  SimulationIdentityField,
  SimulationIdentityProvenance
>;

export interface SimulationTargetProvenance {
  required: boolean;
  source: string;
  evidenceClass: SimulationProvenanceClass;
  sourceId: string | null;
  effectiveAt: string | null;
  recordedAt: string | null;
}

export interface SimulationConfigProvenance {
  required: boolean;
  source: string;
  evidenceClass: SimulationProvenanceClass;
  sourceId: string | null;
  observedAt: string | null;
  effectiveFrom: string | null;
}

export interface SimulationGenerationReceipt {
  complete: boolean;
  partitionId: string | null;
  runId: string | null;
  snapshotIds: string[];
  sourceManifestHash: string | null;
}

export interface SimulationOutcomeCompletenessReceipt {
  status: "complete" | "partial" | "censored" | "not_due" | "not_requested";
  checkedAt: string;
  windowDays: number[];
  completeThrough: string | null;
  sourceIds: string[];
  missingFields: string[];
}

export interface BuildSimulationInputManifestInput {
  sourceMode: SimulationSourceMode;
  cutoff: string;
  identity: SimulationIdentityProvenanceMap;
  targetProvenance: SimulationTargetProvenance | null;
  configProvenance: SimulationConfigProvenance[];
  generation: SimulationGenerationReceipt | null;
  sourceIds: string[];
  missingFields: string[];
  conflictFields: string[];
  outcomeCompleteness: SimulationOutcomeCompletenessReceipt;
}

export interface SimulationInputManifest {
  contractVersion: typeof SIMULATION_INPUT_MANIFEST_VERSION;
  sourceMode: SimulationSourceMode;
  assertedSourceMode: SimulationSourceMode;
  cutoff: string;
  identity: SimulationIdentityProvenanceMap;
  targetProvenance: SimulationTargetProvenance | null;
  configProvenance: SimulationConfigProvenance[];
  generation: SimulationGenerationReceipt | null;
  sourceIds: string[];
  missingFields: string[];
  conflictFields: string[];
  outcomeCompleteness: SimulationOutcomeCompletenessReceipt;
  eligibility: {
    simulationEligible: boolean;
    exactPitEligible: boolean;
    reasons: string[];
  };
  sha256: string;
}

function sortedUnique(values: readonly string[]) {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  );
}

function timestampAtOrBefore(value: string | null, cutoffMs: number) {
  if (value === null) return false;
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) && timestampMs <= cutoffMs;
}

function normalizedIdentity(
  identity: SimulationIdentityProvenanceMap,
): SimulationIdentityProvenanceMap {
  return Object.fromEntries(
    SIMULATION_IDENTITY_FIELDS.map((field) => [
      field,
      {
        ...identity[field],
        value: identity[field].value?.trim() || null,
        sourceId: identity[field].sourceId?.trim() || null,
      },
    ]),
  ) as SimulationIdentityProvenanceMap;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function hashSimulationInputManifest(
  manifest: Omit<SimulationInputManifest, "sha256">,
) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(manifest)))
    .digest("hex");
}

export function buildSimulationInputManifest(
  input: BuildSimulationInputManifestInput,
): SimulationInputManifest {
  const cutoffMs = Date.parse(input.cutoff);
  const cutoffValid = Number.isFinite(cutoffMs);
  const identity = normalizedIdentity(input.identity);
  const derivedMissingFields: string[] = [];

  if (!cutoffValid) derivedMissingFields.push("cutoff.valid_timestamp");

  for (const field of SIMULATION_IDENTITY_FIELDS) {
    const provenance = identity[field];
    if (!provenance.required) continue;
    if (provenance.evidenceClass !== "exact_observation") {
      derivedMissingFields.push(`identity.${field}.exact_observation`);
    }
    if (provenance.value === null) {
      derivedMissingFields.push(`identity.${field}.value`);
    }
    if (!cutoffValid || !timestampAtOrBefore(provenance.observedAt, cutoffMs)) {
      derivedMissingFields.push(`identity.${field}.cutoff_safe_observation`);
    }
  }

  const targetProvenance = input.targetProvenance
    ? {
        ...input.targetProvenance,
        sourceId: input.targetProvenance.sourceId?.trim() || null,
      }
    : null;
  if (targetProvenance?.required) {
    if (
      targetProvenance.evidenceClass !== "bitemporal_observation" &&
      targetProvenance.evidenceClass !== "exact_observation"
    ) {
      derivedMissingFields.push("target.exact_observation");
    }
    if (targetProvenance.sourceId === null) {
      derivedMissingFields.push("target.source_id");
    }
    if (
      !cutoffValid ||
      !timestampAtOrBefore(targetProvenance.effectiveAt, cutoffMs) ||
      !timestampAtOrBefore(targetProvenance.recordedAt, cutoffMs)
    ) {
      derivedMissingFields.push("target.bitemporal_cutoff");
    }
  }

  const configProvenance = input.configProvenance
    .map((provenance) => ({
      ...provenance,
      sourceId: provenance.sourceId?.trim() || null,
    }))
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        (left.sourceId ?? "").localeCompare(right.sourceId ?? ""),
    );
  for (const provenance of configProvenance) {
    if (!provenance.required) continue;
    if (
      provenance.evidenceClass !== "exact_observation" &&
      provenance.evidenceClass !== "bitemporal_observation"
    ) {
      derivedMissingFields.push(
        `config.${provenance.source}.exact_observation`,
      );
    }
    if (provenance.sourceId === null) {
      derivedMissingFields.push(`config.${provenance.source}.source_id`);
    }
    if (!cutoffValid || !timestampAtOrBefore(provenance.observedAt, cutoffMs)) {
      derivedMissingFields.push(
        `config.${provenance.source}.cutoff_safe_observation`,
      );
    }
  }

  const generation = input.generation
    ? {
        ...input.generation,
        partitionId: input.generation.partitionId?.trim() || null,
        runId: input.generation.runId?.trim() || null,
        snapshotIds: sortedUnique(input.generation.snapshotIds),
        sourceManifestHash: input.generation.sourceManifestHash?.trim() || null,
      }
    : null;

  if (input.sourceMode === "exact_raw_pit") {
    if (generation === null) {
      derivedMissingFields.push("generation.receipt");
    } else {
      if (!generation.complete)
        derivedMissingFields.push("generation.complete");
      if (generation.partitionId === null) {
        derivedMissingFields.push("generation.partition_id");
      }
      if (generation.runId === null) {
        derivedMissingFields.push("generation.run_id");
      }
      if (generation.snapshotIds.length === 0) {
        derivedMissingFields.push("generation.snapshot_ids");
      }
      if (generation.sourceManifestHash === null) {
        derivedMissingFields.push("generation.source_manifest_hash");
      }
    }
  }

  const missingFields = sortedUnique([
    ...input.missingFields,
    ...derivedMissingFields,
  ]);
  const conflictFields = sortedUnique(input.conflictFields);
  const exactPitEligible =
    input.sourceMode === "exact_raw_pit" &&
    cutoffValid &&
    missingFields.length === 0 &&
    conflictFields.length === 0;
  const sourceMode =
    input.sourceMode === "exact_raw_pit" && !exactPitEligible
      ? "unreconstructable"
      : input.sourceMode;
  const simulationEligible = sourceMode !== "unreconstructable";
  const reasons = sortedUnique([
    ...(sourceMode === "restated_ad_daily"
      ? ["restated_source_not_exact_pit"]
      : []),
    ...(sourceMode === "persisted_decision_input"
      ? ["persisted_input_not_native_pit_reconstruction"]
      : []),
    ...(sourceMode === "unreconstructable"
      ? ["required_input_not_reconstructable"]
      : []),
    ...missingFields.map((field) => `missing:${field}`),
    ...conflictFields.map((field) => `conflict:${field}`),
  ]);
  const outcomeCompleteness = {
    ...input.outcomeCompleteness,
    windowDays: Array.from(new Set(input.outcomeCompleteness.windowDays)).sort(
      (left, right) => left - right,
    ),
    sourceIds: sortedUnique(input.outcomeCompleteness.sourceIds),
    missingFields: sortedUnique(input.outcomeCompleteness.missingFields),
  };

  const unhashed: Omit<SimulationInputManifest, "sha256"> = {
    contractVersion: SIMULATION_INPUT_MANIFEST_VERSION,
    sourceMode,
    assertedSourceMode: input.sourceMode,
    cutoff: input.cutoff,
    identity,
    targetProvenance,
    configProvenance,
    generation,
    sourceIds: sortedUnique(input.sourceIds),
    missingFields,
    conflictFields,
    outcomeCompleteness,
    eligibility: {
      simulationEligible,
      exactPitEligible,
      reasons,
    },
  };

  return {
    ...unhashed,
    sha256: hashSimulationInputManifest(unhashed),
  };
}
