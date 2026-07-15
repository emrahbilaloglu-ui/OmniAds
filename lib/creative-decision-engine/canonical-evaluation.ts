import { createHash } from "crypto";

import type {
  MetaCampaignKind,
  MetaCampaignTestDimension,
} from "@/lib/meta/campaign-label-types";
import type { CreativeCampaignContextTrust } from "./campaign-label-guard";
import type { EngineV3Flags } from "./feature-flags";
import type {
  AccountCalibration,
  AccountDecisionProfile,
  AccountFunnelCalibration,
  AdDecisionInput,
  AdDecisionOutput,
  CreativeInput,
  DataHealth,
  DataLayerHealth,
  DecisionLabel,
  DecisionOutput,
  DecisionProfileScope,
  HardActionEligibility,
  SpendUnitEvidence,
  SpendUnitProfile,
} from "./types";

export const CANONICAL_EVALUATION_CONTRACT_VERSION =
  "engine-v3-canonical-evaluation.v4" as const;

export type CanonicalJsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  CanonicalJsonPrimitive | readonly CanonicalJsonValue[] | CanonicalJsonObject;

export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

export const CANONICAL_DATA_HEALTH_NOTE_CODES = [
  "unknown_source_freshness",
  "precomputed_row_missing",
  "runtime_sql_fallback",
  "runtime_sql_failed",
  "precomputed_calibration_stale",
  "computed_by_engine",
  "decision_runtime_only",
] as const;

export type CanonicalDataHealthNoteCode =
  (typeof CANONICAL_DATA_HEALTH_NOTE_CODES)[number];

export type CampaignContextProvenanceMode =
  "legacy_labels" | "automatic" | "unknown";

export type CampaignContextProvenanceSource =
  "legacy_label" | "user_override" | "system_inferred" | "unknown";

export type CampaignContextSourceRecordType =
  "meta_campaign_label" | "engine_v3_campaign_context_daily";

export interface CampaignContextProvenance {
  mode: CampaignContextProvenanceMode;
  source: CampaignContextProvenanceSource;
  campaignId: string | null;
  kind: MetaCampaignKind | null;
  testDimension: MetaCampaignTestDimension | null;
  contextTrust: CreativeCampaignContextTrust | null;
  sourceRecordType?: CampaignContextSourceRecordType | null;
  sourceRecordId?: string | null;
  sourceAsOfDate?: string | null;
  sourceUpdatedAt?: string | null;
  sourceHash?: string | null;
}

export type PriorHysteresisSource =
  "persisted_evaluation" | "legacy_snapshot" | "none";

export interface PriorHysteresisProvenance {
  source: PriorHysteresisSource;
  sourceBusinessId?: string | null;
  sourceProviderAccountId?: string | null;
  sourceDecisionEntityType?: "ad" | null;
  sourceDecisionEntityId?: string | null;
  sourceEvaluationId?: string | null;
  sourceSnapshotId?: string | null;
  sourceEngineVersion?: string | null;
  sourceAsOfDate?: string | null;
  sourceInputHash?: string | null;
  sourceDecisionHash?: string | null;
  publishedLabel?: DecisionLabel | null;
  rawLabel?: DecisionLabel | null;
}

/**
 * Canonical context for an ad that was evaluated without calibration
 * authority. It intentionally contains no synthetic thresholds or retained
 * creative calibration fields.
 */
export interface NativeAdSoftOnlyDecisionProfile {
  profileType: "native_ad_soft_only";
  businessId: string;
  asOfDate: string;
  channel: "meta";
  objectiveFamily: "sales";
  scope: DecisionProfileScope;
  blocker: string;
  calibrationSource: string | null;
  selectedCell: {
    engineVersion: string;
    policyVersion: string;
    inputManifestHash: string;
    sourceManifestHash: string;
    qualityStatus: string;
  } | null;
  hardActionEligibility: HardActionEligibility;
}

export type CanonicalDecisionProfile =
  | AccountDecisionProfile
  | NativeAdSoftOnlyDecisionProfile;

export interface BuildCanonicalEvaluationInput {
  engineVersion: string;
  accountProfile: CanonicalDecisionProfile;
  dataHealth: DataHealth;
  flags: EngineV3Flags;
  scope: DecisionProfileScope;
  creativeInput: CreativeInput | AdDecisionInput;
  campaignContext: CampaignContextProvenance;
  priorHysteresis?: PriorHysteresisProvenance | null;
  decision: DecisionOutput | AdDecisionOutput;
  rawLabel: DecisionLabel;
  publishedLabel: DecisionLabel;
  hysteresisSuppressed: boolean;
  evaluatedAt?: string | null;
}

export interface CanonicalContextPayload {
  contractVersion: typeof CANONICAL_EVALUATION_CONTRACT_VERSION;
  envelopeType: "context";
  engineVersion: string;
  scope: CanonicalJsonObject;
  accountProfile: CanonicalJsonObject;
  dataHealth: CanonicalJsonObject;
  flags: CanonicalJsonObject;
}

export interface CanonicalInputPayload {
  contractVersion: typeof CANONICAL_EVALUATION_CONTRACT_VERSION;
  envelopeType: "input";
  engineVersion: string;
  contextHash: string;
  creativeInput: CanonicalJsonObject;
  campaignContext: CanonicalJsonObject;
  priorHysteresis: CanonicalJsonObject;
}

export interface CanonicalDecisionPayload {
  contractVersion: typeof CANONICAL_EVALUATION_CONTRACT_VERSION;
  envelopeType: "decision";
  engineVersion: string;
  inputHash: string;
  decision: CanonicalJsonObject;
  rawLabel: DecisionLabel;
  publishedLabel: DecisionLabel;
  hysteresisSuppressed: boolean;
}

export interface CanonicalEvaluationProvenance {
  contractVersion: typeof CANONICAL_EVALUATION_CONTRACT_VERSION;
  contextPayload: CanonicalContextPayload;
  inputPayload: CanonicalInputPayload;
  decisionPayload: CanonicalDecisionPayload;
  contextJson: string;
  inputJson: string;
  decisionJson: string;
  contextHash: string;
  inputHash: string;
  decisionHash: string;
  volatile: {
    evaluatedAt: string | null;
    generatedAt: string;
  };
}

function describePath(path: string, key: string | number): string {
  return typeof key === "number"
    ? `${path}[${key}]`
    : `${path}.${JSON.stringify(key)}`;
}

function isArrayIndex(key: string, length: number): boolean {
  if (key === "") return false;
  const numeric = Number(key);
  return (
    Number.isInteger(numeric) &&
    numeric >= 0 &&
    numeric < length &&
    String(numeric) === key
  );
}

function normalizeCanonicalValue(
  value: unknown,
  path: string,
  active: WeakSet<object>,
): CanonicalJsonValue {
  if (value === null) return null;
  if (value === undefined) {
    if (path === "$") {
      throw new TypeError("Canonical JSON cannot encode top-level undefined.");
    }
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} contains a non-finite number.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError(`${path} contains a non-JSON ${typeof value} value.`);
  }

  if (active.has(value)) {
    throw new TypeError(`${path} contains a cyclic reference.`);
  }

  if (Array.isArray(value)) {
    active.add(value);
    try {
      const enumerableKeys = Object.keys(value);
      const extraKey = enumerableKeys.find(
        (key) => !isArrayIndex(key, value.length),
      );
      if (extraKey !== undefined) {
        throw new TypeError(
          `${describePath(path, extraKey)} is an unsupported array property.`,
        );
      }

      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor) {
          throw new TypeError(
            `${describePath(path, index)} is a sparse array slot.`,
          );
        }
        if (!("value" in descriptor)) {
          throw new TypeError(
            `${describePath(path, index)} is an accessor, not JSON data.`,
          );
        }
        return normalizeCanonicalValue(
          descriptor.value,
          describePath(path, index),
          active,
        );
      });
    } finally {
      active.delete(value);
    }
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} contains a non-plain JSON object.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} contains a symbol-keyed property.`);
  }

  active.add(value);
  try {
    const output: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError(
          `${describePath(path, key)} is an accessor, not JSON data.`,
        );
      }
      output[key] = normalizeCanonicalValue(
        descriptor.value,
        describePath(path, key),
        active,
      );
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function serializeCanonicalValue(value: CanonicalJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalValue).join(",")}]`;
  }

  const record = value as CanonicalJsonObject;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeCanonicalValue(record[key] ?? null)}`,
    )
    .join(",")}}`;
}

function canonicalObject(value: Record<string, unknown>): CanonicalJsonObject {
  return normalizeCanonicalValue(
    value,
    "$",
    new WeakSet(),
  ) as CanonicalJsonObject;
}

/** Stable JSON with lexicographically sorted object keys and ordered arrays. */
export function stableCanonicalJson(value: unknown): string {
  return serializeCanonicalValue(
    normalizeCanonicalValue(value, "$", new WeakSet()),
  );
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(stableCanonicalJson(value), "utf8")
    .digest("hex");
}

function noteCode(
  note: string | null | undefined,
): CanonicalDataHealthNoteCode | null {
  const normalized = note?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("unknown source freshness")) {
    return "unknown_source_freshness";
  }
  if (normalized.startsWith("no precomputed row available")) {
    return "precomputed_row_missing";
  }
  if (normalized.startsWith("calibration unavailable")) {
    return "runtime_sql_failed";
  }
  if (normalized.startsWith("lifecycle unavailable")) {
    return "runtime_sql_failed";
  }
  if (
    normalized.startsWith("runtime sql fallback") &&
    normalized.includes("precomputed calibration stale")
  ) {
    return "precomputed_calibration_stale";
  }
  if (normalized.startsWith("runtime sql fallback")) {
    return "runtime_sql_fallback";
  }
  if (normalized.startsWith("computed by engine")) {
    return "computed_by_engine";
  }
  if (normalized.startsWith("decision snapshots are not populated")) {
    return "decision_runtime_only";
  }
  return null;
}

function normalizeDataLayerHealth(
  layer: DataLayerHealth,
): Record<string, unknown> {
  return {
    asOfDate: layer.asOfDate,
    computedAt: layer.computedAt,
    sourceFreshnessHours: layer.sourceFreshnessHours,
    staleTier: layer.staleTier,
    fallbackMode: layer.fallbackMode,
    noteCode: noteCode(layer.note),
  };
}

function normalizeDataHealth(dataHealth: DataHealth): CanonicalJsonObject {
  return canonicalObject({
    calibration: normalizeDataLayerHealth(dataHealth.calibration),
    lifecycle: normalizeDataLayerHealth(dataHealth.lifecycle),
    decisions: normalizeDataLayerHealth(dataHealth.decisions),
    worstTier: dataHealth.worstTier,
    degraded: dataHealth.degraded,
  });
}

function normalizeScope(scope: DecisionProfileScope): CanonicalJsonObject {
  return canonicalObject({
    type: scope.type,
    id: scope.id,
    fallbackReason: scope.fallbackReason ?? null,
  });
}

function normalizeSpendUnitEvidence(
  evidence: SpendUnitEvidence,
): Record<string, unknown> {
  return {
    ...evidence,
    confidenceBeforeFreshness: evidence.confidenceBeforeFreshness ?? null,
  };
}

function normalizeHardActionEligibility(
  eligibility: HardActionEligibility,
): Record<string, unknown> {
  return {
    scale: eligibility.scale,
    cut: eligibility.cut,
    refresh: eligibility.refresh,
    reason: eligibility.reason,
    reasons:
      eligibility.reasons === undefined
        ? null
        : {
            scale: eligibility.reasons.scale ?? null,
            cut: eligibility.reasons.cut ?? null,
            refresh: eligibility.reasons.refresh ?? null,
          },
  };
}

function normalizeAccountCalibration(
  calibration: AccountCalibration,
): Record<string, unknown> {
  return {
    ...calibration,
    campaignKind: calibration.campaignKind ?? null,
  };
}

function normalizeFunnelCalibration(
  calibration: AccountFunnelCalibration,
): Record<string, unknown> {
  return {
    ...calibration,
    campaignKind: calibration.campaignKind ?? null,
  };
}

function normalizeSpendUnitProfile(
  profile: SpendUnitProfile,
): Record<string, unknown> {
  return {
    ...profile,
    spendUnitEvidence: normalizeSpendUnitEvidence(profile.spendUnitEvidence),
  };
}

function mapNullableRecord<T>(
  record: Record<string, T | null> | undefined,
  mapper: (value: T) => Record<string, unknown>,
): Record<string, unknown> | null {
  if (record === undefined) return null;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => {
        const value = record[key];
        return [
          key,
          value === null || value === undefined ? null : mapper(value),
        ];
      }),
  );
}

function normalizeAccountProfile(
  profile: CanonicalDecisionProfile,
): CanonicalJsonObject {
  if (isNativeAdSoftOnlyProfile(profile)) {
    return canonicalObject({
      profileType: profile.profileType,
      businessId: profile.businessId,
      asOfDate: profile.asOfDate,
      channel: profile.channel,
      objectiveFamily: profile.objectiveFamily,
      scope: normalizeScope(profile.scope),
      blocker: profile.blocker,
      calibrationSource: profile.calibrationSource,
      selectedCell: profile.selectedCell,
      hardActionEligibility: normalizeHardActionEligibility(
        profile.hardActionEligibility,
      ),
    });
  }
  return canonicalObject({
    businessId: profile.businessId,
    asOfDate: profile.asOfDate,
    channel: profile.channel,
    objectiveFamily: profile.objectiveFamily,
    preset: profile.preset,
    presetSource: profile.presetSource,
    spendUnit: profile.spendUnit,
    spendUnitSource: profile.spendUnitSource,
    spendUnitConfidence: profile.spendUnitConfidence,
    spendUnitEvidence: normalizeSpendUnitEvidence(profile.spendUnitEvidence),
    multipliers: profile.multipliers,
    thresholds: profile.thresholds,
    accountBaselines: normalizeAccountCalibration(profile.accountBaselines),
    funnelCalibration: normalizeFunnelCalibration(profile.funnelCalibration),
    accountBaselinesByKind: mapNullableRecord(
      profile.accountBaselinesByKind,
      normalizeAccountCalibration,
    ),
    spendUnitByKind: mapNullableRecord(
      profile.spendUnitByKind,
      normalizeSpendUnitProfile,
    ),
    thresholdsByKind:
      profile.thresholdsByKind === undefined ? null : profile.thresholdsByKind,
    hardActionEligibilityByKind: mapNullableRecord(
      profile.hardActionEligibilityByKind,
      normalizeHardActionEligibility,
    ),
    funnelCalibrationByKind: mapNullableRecord(
      profile.funnelCalibrationByKind,
      normalizeFunnelCalibration,
    ),
    scope: normalizeScope(profile.scope),
    hardActionEligibility: normalizeHardActionEligibility(
      profile.hardActionEligibility,
    ),
    quality: {
      commercialTruthReady: profile.quality.commercialTruthReady,
      commercialTruthFreshness:
        profile.quality.commercialTruthFreshness ?? null,
      calibrationReady: profile.quality.calibrationReady,
      metaAovQuality: profile.quality.metaAovQuality,
      thresholdQuality: profile.quality.thresholdQuality,
    },
  });
}

function isNativeAdSoftOnlyProfile(
  profile: CanonicalDecisionProfile,
): profile is NativeAdSoftOnlyDecisionProfile {
  return (
    "profileType" in profile &&
    profile.profileType === "native_ad_soft_only"
  );
}

function normalizeFlags(flags: EngineV3Flags): CanonicalJsonObject {
  return canonicalObject({
    businessId: flags.businessId,
    enabled: flags.enabled,
    surfaceVisible: flags.surfaceVisible,
    shadowOnly: flags.shadowOnly,
    presetOverride: flags.presetOverride,
    source: {
      enabled: flags.source.enabled,
      surfaceVisible: flags.source.surfaceVisible,
      shadowOnly: flags.source.shadowOnly,
      presetOverride: flags.source.presetOverride,
    },
    envDefaults: {
      enabled: flags.envDefaults.enabled,
      surfaceVisible: flags.envDefaults.surfaceVisible,
      shadowOnly: flags.envDefaults.shadowOnly,
    },
  });
}

function normalizeCreativeInput(
  input: CreativeInput | AdDecisionInput,
): CanonicalJsonObject {
  const adInput = isAdDecisionInput(input) ? input : null;
  return canonicalObject({
    creativeId: input.creativeId,
    decisionEntityType: adInput?.decisionEntityType ?? null,
    decisionEntityId: adInput?.decisionEntityId ?? null,
    adId: adInput?.adId ?? null,
    providerAccountId: adInput?.providerAccountId ?? null,
    accountTimezone: adInput?.accountTimezone ?? null,
    accountCurrency: adInput?.accountCurrency ?? null,
    adsetId: adInput?.adsetId ?? input.adsetId ?? null,
    optimizationGoal:
      adInput?.optimizationGoal ?? input.optimizationGoal ?? null,
    customEventType: adInput?.customEventType ?? input.customEventType ?? null,
    creativeName: input.creativeName,
    businessId: input.businessId,
    campaignId: input.campaignId,
    campaignKind: input.campaignKind ?? null,
    objective: input.objective,
    contextGrain: input.contextGrain ?? null,
    effectiveCohort: input.effectiveCohort ?? null,
    spend: input.spend,
    purchases: input.purchases,
    purchaseValue: input.purchaseValue,
    impressions: input.impressions,
    linkClicks: input.linkClicks,
    roas: input.roas,
    cpa: input.cpa,
    ctr: input.ctr,
    frequency: input.frequency,
    recent7dSpend: input.recent7dSpend,
    recent7dPurchases: input.recent7dPurchases,
    recent7dRoas: input.recent7dRoas,
    recent7dImpressions: input.recent7dImpressions,
    effectiveStatus: input.effectiveStatus,
    ageDays: input.ageDays,
    firstSeenAt: input.firstSeenAt ?? null,
    firstSpendAt: input.firstSpendAt ?? null,
    lastSpendAt: input.lastSpendAt,
    spend24h: input.spend24h ?? null,
    impressions24h: input.impressions24h ?? null,
    reviewStatus: input.reviewStatus ?? null,
    policyReason: input.policyReason,
    disapprovalReason: input.disapprovalReason ?? null,
    limitedReason: input.limitedReason ?? null,
    dataFreshnessHours: input.dataFreshnessHours,
    fatigueStatus: input.fatigueStatus,
    targetRoas: input.targetRoas,
    breakevenRoas: input.breakevenRoas,
    commercialTargetFreshness: input.commercialTargetFreshness ?? null,
    lifecyclePosition: input.lifecyclePosition ?? null,
    daysSincePeak: input.daysSincePeak ?? null,
    peakRoas30d: input.peakRoas30d ?? null,
    peakConfidence: input.peakConfidence ?? null,
    spendTrajectory30d: input.spendTrajectory30d ?? null,
    spendSlope7d: input.spendSlope7d ?? null,
    spendSlope30d: input.spendSlope30d ?? null,
    roasSlope7d: input.roasSlope7d ?? null,
    roasSlope30d: input.roasSlope30d ?? null,
    cpm: input.cpm,
    outboundClicks: input.outboundClicks,
    landingPageViews: input.landingPageViews,
    addToCart: input.addToCart,
    initiateCheckout: input.initiateCheckout,
    thumbstop: input.thumbstop,
    video25Rate: input.video25Rate,
    video50Rate: input.video50Rate,
    video75Rate: input.video75Rate,
    video100Rate: input.video100Rate,
    qualityRanking: input.qualityRanking,
    engagementRateRanking: input.engagementRateRanking,
    conversionRateRanking: input.conversionRateRanking,
    creativeFormat: input.creativeFormat,
    metricEvidence: adInput?.metricEvidence ?? null,
    statusEvidence: adInput?.statusEvidence ?? null,
    creativeEvidence: adInput?.creativeEvidence ?? null,
  });
}

function normalizeCampaignContext(
  context: CampaignContextProvenance,
): CanonicalJsonObject {
  return canonicalObject({
    mode: context.mode,
    source: context.source,
    campaignId: context.campaignId,
    kind: context.kind,
    testDimension: context.testDimension,
    contextTrust: context.contextTrust,
    sourceRecordType: context.sourceRecordType ?? null,
    sourceRecordId: context.sourceRecordId ?? null,
    sourceAsOfDate: context.sourceAsOfDate ?? null,
    sourceUpdatedAt: context.sourceUpdatedAt ?? null,
    sourceHash: context.sourceHash ?? null,
  });
}

function normalizePriorHysteresis(
  provenance: PriorHysteresisProvenance | null | undefined,
): CanonicalJsonObject {
  return canonicalObject({
    source: provenance?.source ?? "none",
    sourceBusinessId: provenance?.sourceBusinessId ?? null,
    sourceProviderAccountId: provenance?.sourceProviderAccountId ?? null,
    sourceDecisionEntityType: provenance?.sourceDecisionEntityType ?? null,
    sourceDecisionEntityId: provenance?.sourceDecisionEntityId ?? null,
    sourceEvaluationId: provenance?.sourceEvaluationId ?? null,
    sourceSnapshotId: provenance?.sourceSnapshotId ?? null,
    sourceEngineVersion: provenance?.sourceEngineVersion ?? null,
    sourceAsOfDate: provenance?.sourceAsOfDate ?? null,
    sourceInputHash: provenance?.sourceInputHash ?? null,
    sourceDecisionHash: provenance?.sourceDecisionHash ?? null,
    publishedLabel: provenance?.publishedLabel ?? null,
    rawLabel: provenance?.rawLabel ?? null,
  });
}

function normalizeDecision(
  decision: DecisionOutput | AdDecisionOutput,
): CanonicalJsonObject {
  const adDecision = isAdDecisionOutput(decision) ? decision : null;
  return canonicalObject({
    creativeId: decision.creativeId,
    decisionEntityType: adDecision?.decisionEntityType ?? null,
    decisionEntityId: adDecision?.decisionEntityId ?? null,
    adId: adDecision?.adId ?? null,
    providerAccountId: adDecision?.providerAccountId ?? null,
    creativeName: decision.creativeName,
    label: decision.label,
    reason: decision.reason,
    confidence: decision.confidence,
    truthSource: decision.truthSource,
    effectiveTargetRoas: decision.effectiveTargetRoas,
    ratioToTarget: decision.ratioToTarget,
    badges: decision.badges,
    blockers: decision.blockers ?? null,
    metrics: decision.metrics,
    campaignLabelStatus: decision.campaignLabelStatus ?? null,
    campaignKind: decision.campaignKind ?? null,
    campaignTestDimension: decision.campaignTestDimension ?? null,
    preAuthorityLabel: decision.preAuthorityLabel,
    authorityBlocker: decision.authorityBlocker,
    blockedActionType: decision.blockedActionType ?? null,
    decisionKindSource: decision.decisionKindSource ?? null,
    labelTransform: decision.labelTransform ?? null,
    engineVersion: decision.engineVersion,
  });
}

function isAdDecisionInput(
  input: CreativeInput | AdDecisionInput,
): input is AdDecisionInput {
  return (
    input.decisionEntityType === "ad" &&
    typeof input.decisionEntityId === "string" &&
    typeof input.adId === "string" &&
    typeof input.providerAccountId === "string" &&
    "metricEvidence" in input
  );
}

function isAdDecisionOutput(
  decision: DecisionOutput | AdDecisionOutput,
): decision is AdDecisionOutput {
  return (
    "decisionEntityType" in decision &&
    decision.decisionEntityType === "ad" &&
    typeof decision.decisionEntityId === "string" &&
    typeof decision.adId === "string" &&
    typeof decision.providerAccountId === "string"
  );
}

function assertLineage(input: BuildCanonicalEvaluationInput): void {
  if (!input.engineVersion.trim()) {
    throw new TypeError("engineVersion must be a non-empty string.");
  }
  if (input.accountProfile.businessId !== input.creativeInput.businessId) {
    throw new TypeError(
      "Account profile and creative input business IDs differ.",
    );
  }
  if (
    String(input.flags.businessId) !== String(input.accountProfile.businessId)
  ) {
    throw new TypeError(
      "Engine flags and account profile business IDs differ.",
    );
  }
  if (
    stableCanonicalJson(normalizeScope(input.scope)) !==
    stableCanonicalJson(normalizeScope(input.accountProfile.scope))
  ) {
    throw new TypeError("Evaluation scope and account profile scope differ.");
  }
  if (input.campaignContext.campaignId !== input.creativeInput.campaignId) {
    throw new TypeError(
      "Campaign context and creative input campaign IDs differ.",
    );
  }
  if (isAdDecisionInput(input.creativeInput)) {
    if (!isAdDecisionOutput(input.decision)) {
      throw new TypeError(
        "Native ad input requires a native ad decision output.",
      );
    }
    if (
      input.decision.decisionEntityId !==
        input.creativeInput.decisionEntityId ||
      input.decision.adId !== input.creativeInput.adId ||
      input.decision.providerAccountId !==
        input.creativeInput.providerAccountId ||
      input.decision.creativeId !== input.creativeInput.creativeId
    ) {
      throw new TypeError("Decision and native ad input identities differ.");
    }
  } else if (input.decision.creativeId !== input.creativeInput.creativeId) {
    throw new TypeError("Decision and creative input IDs differ.");
  }
  if (input.decision.engineVersion !== input.engineVersion) {
    throw new TypeError("Decision and evaluation engine versions differ.");
  }
  if (input.decision.label !== input.publishedLabel) {
    throw new TypeError("Decision label and published label differ.");
  }
}

export function buildCanonicalEvaluationProvenance(
  input: BuildCanonicalEvaluationInput,
): CanonicalEvaluationProvenance {
  assertLineage(input);

  const contextPayload = canonicalObject({
    contractVersion: CANONICAL_EVALUATION_CONTRACT_VERSION,
    envelopeType: "context",
    engineVersion: input.engineVersion,
    scope: normalizeScope(input.scope),
    accountProfile: normalizeAccountProfile(input.accountProfile),
    dataHealth: normalizeDataHealth(input.dataHealth),
    flags: normalizeFlags(input.flags),
  }) as unknown as CanonicalContextPayload;
  const contextJson = stableCanonicalJson(contextPayload);
  const contextHash = createHash("sha256")
    .update(contextJson, "utf8")
    .digest("hex");

  const inputPayload = canonicalObject({
    contractVersion: CANONICAL_EVALUATION_CONTRACT_VERSION,
    envelopeType: "input",
    engineVersion: input.engineVersion,
    contextHash,
    creativeInput: normalizeCreativeInput(input.creativeInput),
    campaignContext: normalizeCampaignContext(input.campaignContext),
    priorHysteresis: normalizePriorHysteresis(input.priorHysteresis),
  }) as unknown as CanonicalInputPayload;
  const inputJson = stableCanonicalJson(inputPayload);
  const inputHash = createHash("sha256")
    .update(inputJson, "utf8")
    .digest("hex");

  const decisionPayload = canonicalObject({
    contractVersion: CANONICAL_EVALUATION_CONTRACT_VERSION,
    envelopeType: "decision",
    engineVersion: input.engineVersion,
    inputHash,
    decision: normalizeDecision(input.decision),
    rawLabel: input.rawLabel,
    publishedLabel: input.publishedLabel,
    hysteresisSuppressed: input.hysteresisSuppressed,
  }) as unknown as CanonicalDecisionPayload;
  const decisionJson = stableCanonicalJson(decisionPayload);
  const decisionHash = createHash("sha256")
    .update(decisionJson, "utf8")
    .digest("hex");

  return {
    contractVersion: CANONICAL_EVALUATION_CONTRACT_VERSION,
    contextPayload,
    inputPayload,
    decisionPayload,
    contextJson,
    inputJson,
    decisionJson,
    contextHash,
    inputHash,
    decisionHash,
    volatile: {
      evaluatedAt: input.evaluatedAt ?? null,
      generatedAt: input.decision.generatedAt,
    },
  };
}
