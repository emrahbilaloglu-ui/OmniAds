import type {
  MetaRecommendationAnalysisSourceSystem,
  MetaRecommendationsResponse,
} from "@/lib/meta/recommendations";

export type MetaAnalysisState =
  | "not_run"
  | "running"
  | "recommendation_fallback"
  | "error";

export type MetaDecisionOsDisplayStatus =
  | "not_run"
  | "archived"
  | "error"
  | "mismatch";

export type MetaRecommendationSourceSystem =
  | MetaRecommendationAnalysisSourceSystem
  | "none"
  | "unknown";

export type MetaPresentationMode =
  | "fallback_context"
  | "demo_context"
  | "no_guidance"
  | "loading"
  | "error";

export interface MetaAnalysisRunRange {
  businessId: string;
  startDate: string;
  endDate: string;
}

export interface MetaAnalysisStatus {
  state: MetaAnalysisState;
  decisionOsStatus: MetaDecisionOsDisplayStatus;
  decisionOsLabel: string;
  recommendationSource: MetaRecommendationSourceSystem;
  recommendationSourceLabel: string;
  presentationMode: MetaPresentationMode;
  presentationModeLabel: string;
  isAnalysisRunning: boolean;
  message: string;
  detailReasons: string[];
  safeErrorMessage: string | null;
  rangeMismatch: boolean;
  analyzedRangeLabel: string | null;
  lastAnalyzedAtIso: string | null;
}

export interface DeriveMetaAnalysisStatusInput {
  businessId: string | null;
  startDate: string | null;
  endDate: string | null;
  recommendationsData?: MetaRecommendationsResponse | null;
  recommendationsError?: unknown;
  recommendationsIsFetching: boolean;
  lastAnalyzedAt?: Date | string | null;
  lastAnalyzedRange?: MetaAnalysisRunRange | null;
}

function unique(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function hasOwnString(
  value: unknown,
  key: "businessId" | "startDate" | "endDate",
): value is Record<typeof key, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    key in value &&
    typeof (value as Record<typeof key, unknown>)[key] === "string"
  );
}

function normalizeDateOnly(value: string) {
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : trimmed;
}

function responseRangeMismatch(
  response: unknown,
  expected: MetaAnalysisRunRange | null,
) {
  if (!expected) return false;
  if (hasOwnString(response, "businessId") && response.businessId !== expected.businessId) {
    return true;
  }
  if (
    hasOwnString(response, "startDate") &&
    normalizeDateOnly(response.startDate) !== normalizeDateOnly(expected.startDate)
  ) {
    return true;
  }
  if (
    hasOwnString(response, "endDate") &&
    normalizeDateOnly(response.endDate) !== normalizeDateOnly(expected.endDate)
  ) {
    return true;
  }
  return false;
}

export function metaAnalysisRunRangeMatches(
  current: MetaAnalysisRunRange | null | undefined,
  expected: MetaAnalysisRunRange | null | undefined,
) {
  if (!current || !expected) return false;
  return (
    current.businessId === expected.businessId &&
    normalizeDateOnly(current.startDate) === normalizeDateOnly(expected.startDate) &&
    normalizeDateOnly(current.endDate) === normalizeDateOnly(expected.endDate)
  );
}

function responseMatchesRunRange(
  response: unknown,
  expected: MetaAnalysisRunRange | null,
) {
  return (
    Boolean(expected) &&
    hasOwnString(response, "businessId") &&
    hasOwnString(response, "startDate") &&
    hasOwnString(response, "endDate") &&
    !responseRangeMismatch(response, expected)
  );
}

export function getMetaRecommendationSource(
  recommendationsData?: MetaRecommendationsResponse | null,
): MetaRecommendationSourceSystem {
  if (!recommendationsData) return "none";
  const system = recommendationsData?.analysisSource?.system;
  if (
    system === "snapshot_fallback" ||
    system === "snapshot_persistent" ||
    system === "snapshot_live" ||
    system === "demo"
  ) {
    return system;
  }
  if (
    recommendationsData?.sourceModel === "snapshot_heuristics" ||
    recommendationsData?.sourceModel === "snapshot_persistent" ||
    recommendationsData?.sourceModel === "snapshot_live"
  ) {
    return "snapshot_fallback";
  }
  return "unknown";
}

function sourceLabel(source: MetaRecommendationSourceSystem) {
  switch (source) {
    case "snapshot_fallback":
      return "Snapshot fallback";
    case "snapshot_persistent":
      return "Daily snapshot";
    case "snapshot_live":
      return "Live snapshot";
    case "demo":
      return "Demo";
    case "none":
      return "None";
    default:
      return "Unknown";
  }
}

function decisionOsLabel(status: MetaDecisionOsDisplayStatus) {
  switch (status) {
    case "archived":
      return "Archived";
    case "error":
      return "Error";
    case "mismatch":
      return "Mismatch";
    default:
      return "Not run";
  }
}

function presentationModeLabel(mode: MetaPresentationMode) {
  switch (mode) {
    case "fallback_context":
      return "Fallback context";
    case "demo_context":
      return "Demo context";
    case "loading":
      return "Loading";
    case "error":
      return "Error";
    default:
      return "No guidance";
  }
}

function analyzedRangeLabel(
  range: MetaAnalysisRunRange | null | undefined,
) {
  if (!range) return null;
  return `${range.startDate} to ${range.endDate}`;
}

function lastAnalyzedAtIso(value: Date | string | null | undefined) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString();
}

export function deriveMetaAnalysisStatus(
  input: DeriveMetaAnalysisStatusInput,
): MetaAnalysisStatus {
  const expectedRange =
    input.businessId && input.startDate && input.endDate
      ? {
          businessId: input.businessId,
          startDate: input.startDate,
          endDate: input.endDate,
        }
      : null;
  const recommendationSource = getMetaRecommendationSource(input.recommendationsData);
  const recommendationRangeMismatch = responseRangeMismatch(input.recommendationsData, expectedRange);
  const isRunning = input.recommendationsIsFetching;
  const decisionOsStatus: MetaDecisionOsDisplayStatus = recommendationRangeMismatch
      ? "mismatch"
      : "archived";
  const presentationMode: MetaPresentationMode = isRunning
    ? "loading"
    : recommendationRangeMismatch
      ? "error"
      : recommendationSource === "snapshot_fallback" ||
        recommendationSource === "snapshot_persistent" ||
        recommendationSource === "snapshot_live"
        ? "fallback_context"
        : recommendationSource === "demo"
          ? "demo_context"
          : input.recommendationsError
            ? "error"
            : "no_guidance";
  const base = {
    decisionOsStatus,
    decisionOsLabel: decisionOsLabel(decisionOsStatus),
    recommendationSource,
    recommendationSourceLabel: sourceLabel(recommendationSource),
    presentationMode,
    presentationModeLabel: presentationModeLabel(presentationMode),
    isAnalysisRunning: isRunning,
    analyzedRangeLabel: analyzedRangeLabel(input.lastAnalyzedRange),
    lastAnalyzedAtIso: lastAnalyzedAtIso(input.lastAnalyzedAt),
  };

  if (isRunning) {
    return {
      state: "running",
      ...base,
      message: "Analysis is running for the selected range.",
      detailReasons: [],
      safeErrorMessage: null,
      rangeMismatch: false,
    };
  }

  if (recommendationRangeMismatch) {
    return {
      state: "error",
      ...base,
      message: "Analysis response does not match the selected business or date range.",
      detailReasons: ["Selected range changed before the analysis response could be used."],
      safeErrorMessage: "Analysis could not complete safely. Run analysis again for this range.",
      rangeMismatch: true,
    };
  }

  if (
    recommendationSource === "snapshot_fallback" ||
    recommendationSource === "snapshot_persistent" ||
    recommendationSource === "snapshot_live"
  ) {
    return {
      state: "recommendation_fallback",
      ...base,
      message: "Showing snapshot-backed recommendation context.",
      detailReasons: unique([input.recommendationsData?.analysisSource?.fallbackReason]),
      safeErrorMessage: null,
      rangeMismatch: false,
    };
  }

  if (input.recommendationsError && recommendationSource === "none") {
    return {
      state: "error",
      ...base,
      message: "Recommendations could not complete safely.",
      detailReasons: [],
      safeErrorMessage: "Analysis could not complete safely. Run analysis again for this range.",
      rangeMismatch: false,
    };
  }

  if (recommendationSource === "demo") {
    return {
      state: "not_run",
      ...base,
      message: "Showing demo recommendation context for this range.",
      detailReasons: [],
      safeErrorMessage: null,
      rangeMismatch: false,
    };
  }

  return {
    state: "not_run",
    ...base,
    message: "Run analysis to generate snapshot-backed recommendation context.",
    detailReasons: [],
    safeErrorMessage: null,
    rangeMismatch: false,
  };
}

export interface MetaAnalysisQueryRefetchResult<T> {
  data?: T | null;
  error?: unknown;
  status?: string;
  isError?: boolean;
}

function refetchResultSucceeded<T>(result: MetaAnalysisQueryRefetchResult<T>) {
  return !result.error && result.status !== "error" && result.isError !== true;
}

export function isUsableMetaRecommendationsResponse(
  value: unknown,
): value is MetaRecommendationsResponse {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { status?: unknown }).status === "ok" &&
    Array.isArray((value as { recommendations?: unknown }).recommendations)
  );
}

export function didMetaAnalysisRefetchProduceUsableData(input: {
  recommendationsResult: MetaAnalysisQueryRefetchResult<MetaRecommendationsResponse>;
  expectedRange: {
    businessId: string | null | undefined;
    startDate: string;
    endDate: string;
  };
}) {
  const expectedRange =
    input.expectedRange.businessId &&
    input.expectedRange.startDate &&
    input.expectedRange.endDate
      ? {
          businessId: input.expectedRange.businessId,
          startDate: input.expectedRange.startDate,
          endDate: input.expectedRange.endDate,
        }
      : null;
  const recommendationsUsable =
    refetchResultSucceeded(input.recommendationsResult) &&
    isUsableMetaRecommendationsResponse(input.recommendationsResult.data);
  const recommendationsMatches =
    recommendationsUsable &&
    responseMatchesRunRange(input.recommendationsResult.data, expectedRange);

  return recommendationsMatches;
}
