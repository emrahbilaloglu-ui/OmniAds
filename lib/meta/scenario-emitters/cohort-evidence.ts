import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import type {
  MetaCalibrationContext,
  MetaRecommendation,
} from "@/lib/meta/recommendations";

const HARD_ACTION_MIN_AGE_DAYS = 14;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function positiveOrFallback(value: number | null | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function resolveCohortEvidenceThresholds(
  context: MetaCalibrationContext | null,
) {
  return {
    nMin: positiveOrFallback(
      context?.thresholds.minRequiredSample,
      LEGACY_META_CALIBRATION_THRESHOLDS.minRequiredSample,
    ),
    hardCutSpend: positiveOrFallback(
      context?.thresholds.hardCutSpend,
      LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend,
    ),
  };
}

export interface CohortEvidenceProfile {
  directionStrength: number;
  evidenceDepth: number;
  confidenceScore: number;
  confidence: MetaRecommendation["confidence"];
  nMin: number;
  hardCutSpend: number;
  scaleMature: boolean;
  cutMature: boolean;
}

export function evaluateCohortEvidence(input: {
  context: MetaCalibrationContext | null;
  score: number;
  eventCount: number;
  spend: number;
  ageDays: number | null;
}): CohortEvidenceProfile {
  const { nMin, hardCutSpend } = resolveCohortEvidenceThresholds(input.context);
  const directionStrength = clamp01(2 * Math.abs(input.score - 0.5));
  const evidenceDepth = clamp01(
    Math.max(input.eventCount / nMin, input.spend / hardCutSpend),
  );
  const confidenceScore = 0.5 + (0.5 * directionStrength * evidenceDepth);
  const confidence =
    confidenceScore >= 0.85
      ? "high"
      : confidenceScore >= 0.7
        ? "medium"
        : "low";
  const ageMature =
    input.ageDays != null &&
    Number.isFinite(input.ageDays) &&
    input.ageDays >= HARD_ACTION_MIN_AGE_DAYS;

  return {
    directionStrength,
    evidenceDepth,
    confidenceScore,
    confidence,
    nMin,
    hardCutSpend,
    scaleMature: ageMature && input.eventCount >= nMin,
    cutMature: ageMature && input.spend > hardCutSpend,
  };
}

export function hasCohortFatigueEvidence(input: {
  context: MetaCalibrationContext | null;
  frequency: number | null;
  ctrDecayPct: number | null | undefined;
}) {
  const frequencyThreshold = input.context?.thresholds.metrics.freq_14d;
  const nMin = resolveCohortEvidenceThresholds(input.context).nMin;
  if (
    input.context?.thresholds.source !== "calibrated" ||
    !frequencyThreshold ||
    frequencyThreshold.sampleSize < nMin ||
    input.frequency == null ||
    !Number.isFinite(input.frequency) ||
    input.ctrDecayPct == null ||
    !Number.isFinite(input.ctrDecayPct)
  ) {
    return false;
  }
  return input.frequency > frequencyThreshold.p75 && input.ctrDecayPct <= -15;
}
