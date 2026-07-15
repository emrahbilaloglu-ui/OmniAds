import {
  getBusinessCommercialTruthSnapshot,
  getBusinessTargetPackHistoryAsOf,
  resolveBusinessTargetPackFreshness,
} from "@/lib/business-commercial";

export type MetaCommercialTargetSource = "configured_targets" | "none";
export type MetaCommercialRiskPosture =
  "conservative" | "balanced" | "aggressive";

export interface MetaCommercialTargets {
  source: MetaCommercialTargetSource;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
  breakEvenCpa: number | null;
  riskPosture: MetaCommercialRiskPosture;
  freshness: "fresh" | "stale" | "unknown";
  updatedAt: string | null;
}

export interface MetaLossBudgetMaturity {
  spendThreshold: number;
  cpaBaseline: number;
  multiplier: number;
  calibratedSpendFloor: number;
  source: "break_even_cpa" | "target_cpa" | "account_cpa";
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRiskPosture(value: unknown): MetaCommercialRiskPosture {
  return value === "conservative" || value === "aggressive"
    ? value
    : "balanced";
}

export function normalizeMetaCommercialTargets(
  input?: Partial<MetaCommercialTargets> | null,
  referenceTime: Date = new Date(),
): MetaCommercialTargets {
  const targetRoas = positiveNumber(input?.targetRoas);
  const breakEvenRoas = positiveNumber(input?.breakEvenRoas);
  const targetCpa = positiveNumber(input?.targetCpa);
  const breakEvenCpa = positiveNumber(input?.breakEvenCpa);
  const hasAnchor = Boolean(
    targetRoas || breakEvenRoas || targetCpa || breakEvenCpa,
  );
  const updatedAtCandidate =
    typeof input?.updatedAt === "string" && input.updatedAt.trim()
      ? input.updatedAt.trim()
      : null;
  const updatedAt =
    updatedAtCandidate && Number.isFinite(Date.parse(updatedAtCandidate))
      ? updatedAtCandidate
      : null;
  const referenceTimeMs = referenceTime.getTime();
  const updatedAtMs = updatedAt === null ? null : Date.parse(updatedAt);
  const timestampCutoffSafe =
    updatedAtMs !== null &&
    Number.isFinite(referenceTimeMs) &&
    updatedAtMs <= referenceTimeMs;
  const freshness =
    hasAnchor && timestampCutoffSafe && input?.freshness === "fresh"
      ? "fresh"
      : hasAnchor && timestampCutoffSafe && input?.freshness === "stale"
        ? "stale"
        : "unknown";
  return {
    source: hasAnchor ? "configured_targets" : "none",
    targetRoas,
    breakEvenRoas,
    targetCpa,
    breakEvenCpa,
    riskPosture: normalizeRiskPosture(input?.riskPosture),
    freshness,
    updatedAt: timestampCutoffSafe ? updatedAt : null,
  };
}

export async function readMetaCommercialTargets(
  businessId: string,
  input?: { asOf?: string | Date },
): Promise<MetaCommercialTargets> {
  if (input?.asOf !== undefined) {
    const referenceTime =
      input.asOf instanceof Date
        ? new Date(input.asOf.getTime())
        : new Date(
            /^\d{4}-\d{2}-\d{2}$/.test(input.asOf.trim())
              ? `${input.asOf.trim()}T03:00:00.000Z`
              : input.asOf,
          );
    if (!Number.isFinite(referenceTime.getTime())) {
      throw new Error("asOf must be a valid date or timestamp");
    }
    const targetPack = await getBusinessTargetPackHistoryAsOf({
      businessId,
      asOf: input.asOf,
    });
    return normalizeMetaCommercialTargets(
      {
        targetRoas: targetPack?.targetRoas ?? null,
        breakEvenRoas: targetPack?.breakEvenRoas ?? null,
        targetCpa: targetPack?.targetCpa ?? null,
        breakEvenCpa: targetPack?.breakEvenCpa ?? null,
        riskPosture: targetPack?.defaultRiskPosture ?? "balanced",
        freshness: resolveBusinessTargetPackFreshness(
          targetPack?.updatedAt,
          referenceTime,
        ),
        updatedAt: targetPack?.updatedAt ?? null,
      },
      referenceTime,
    );
  }

  const snapshot = await getBusinessCommercialTruthSnapshot(businessId);
  const targetPack = snapshot.targetPack;
  const targetFreshness = snapshot.sectionMeta?.targetPack?.freshness;
  return normalizeMetaCommercialTargets({
    targetRoas: targetPack?.targetRoas ?? null,
    breakEvenRoas: targetPack?.breakEvenRoas ?? null,
    targetCpa: targetPack?.targetCpa ?? null,
    breakEvenCpa: targetPack?.breakEvenCpa ?? null,
    riskPosture: targetPack?.defaultRiskPosture ?? "balanced",
    freshness:
      targetFreshness?.status === "fresh"
        ? "fresh"
        : targetFreshness?.status === "stale"
          ? "stale"
          : "unknown",
    updatedAt: targetFreshness?.updatedAt ?? targetPack?.updatedAt ?? null,
  });
}

export function hasMetaHardActionAnchor(
  targets: MetaCommercialTargets | null | undefined,
) {
  const normalized = normalizeMetaCommercialTargets(targets);
  return (
    normalized.source === "configured_targets" &&
    normalized.freshness !== "unknown" &&
    normalized.updatedAt !== null
  );
}

export function metaScaleRoasFloor(
  targets: MetaCommercialTargets | null | undefined,
) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (!hasMetaHardActionAnchor(normalized)) return null;
  // Budget expansion needs an explicit operating target. Break-even only
  // proves non-loss; it does not define acceptable growth economics.
  return normalized.targetRoas;
}

export function metaCutRoasCeiling(
  targets: MetaCommercialTargets | null | undefined,
) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (!hasMetaHardActionAnchor(normalized)) return null;
  // Only break-even establishes that spend is economically loss-making.
  // A fixed fraction of a target ROAS is not a loss boundary.
  return normalized.breakEvenRoas;
}

export function metaCutRoasReviewCeiling(
  targets: MetaCommercialTargets | null | undefined,
) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (normalized.source !== "configured_targets") return null;
  // Review candidates may use the configured loss boundary even when another
  // action-specific anchor is absent. Age alone never changes authority.
  return normalized.breakEvenRoas;
}

function riskMultiplier(posture: MetaCommercialRiskPosture) {
  if (posture === "conservative") return 2.5;
  if (posture === "aggressive") return 1.5;
  return 2;
}

export function metaLossBudgetMaturity(input: {
  targets?: MetaCommercialTargets | null;
  accountCpaBaseline?: number | null;
  calibratedHardCutSpend?: number | null;
}): MetaLossBudgetMaturity | null {
  const targets = normalizeMetaCommercialTargets(input.targets);
  const breakEvenCpa = positiveNumber(targets.breakEvenCpa);
  const targetCpa = positiveNumber(targets.targetCpa);
  const accountCpa = positiveNumber(input.accountCpaBaseline);
  const cpaBaseline = breakEvenCpa ?? targetCpa ?? accountCpa;
  if (!cpaBaseline) return null;
  const multiplier = riskMultiplier(targets.riskPosture);
  const calibratedSpendFloor = positiveNumber(input.calibratedHardCutSpend) ?? 0;
  return {
    spendThreshold: Math.max(calibratedSpendFloor, cpaBaseline * multiplier),
    cpaBaseline,
    multiplier,
    calibratedSpendFloor,
    source: breakEvenCpa
      ? "break_even_cpa"
      : targetCpa
        ? "target_cpa"
        : "account_cpa",
  };
}
