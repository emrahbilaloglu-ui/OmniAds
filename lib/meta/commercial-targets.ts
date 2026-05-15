import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";

export type MetaCommercialTargetSource = "configured_targets" | "none";
export type MetaCommercialRiskPosture = "conservative" | "balanced" | "aggressive";

export interface MetaCommercialTargets {
  source: MetaCommercialTargetSource;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
  breakEvenCpa: number | null;
  riskPosture: MetaCommercialRiskPosture;
}

export interface MetaLossBudgetMaturity {
  spendThreshold: number;
  cpaBaseline: number;
  multiplier: number;
  currencyFloor: number;
  source: "break_even_cpa" | "target_cpa" | "account_cpa";
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRiskPosture(value: unknown): MetaCommercialRiskPosture {
  return value === "conservative" || value === "aggressive" ? value : "balanced";
}

export function normalizeMetaCommercialTargets(input?: Partial<MetaCommercialTargets> | null): MetaCommercialTargets {
  const targetRoas = positiveNumber(input?.targetRoas);
  const breakEvenRoas = positiveNumber(input?.breakEvenRoas);
  const targetCpa = positiveNumber(input?.targetCpa);
  const breakEvenCpa = positiveNumber(input?.breakEvenCpa);
  const hasAnchor = Boolean(targetRoas || breakEvenRoas || targetCpa || breakEvenCpa);
  return {
    source: hasAnchor ? "configured_targets" : "none",
    targetRoas,
    breakEvenRoas,
    targetCpa,
    breakEvenCpa,
    riskPosture: normalizeRiskPosture(input?.riskPosture),
  };
}

export async function readMetaCommercialTargets(businessId: string): Promise<MetaCommercialTargets> {
  const snapshot = await getBusinessCommercialTruthSnapshot(businessId);
  return normalizeMetaCommercialTargets({
    targetRoas: snapshot.targetPack?.targetRoas ?? snapshot.coverage?.thresholds.targetRoas ?? null,
    breakEvenRoas: snapshot.targetPack?.breakEvenRoas ?? snapshot.coverage?.thresholds.breakEvenRoas ?? null,
    targetCpa: snapshot.targetPack?.targetCpa ?? snapshot.coverage?.thresholds.targetCpa ?? null,
    breakEvenCpa: snapshot.targetPack?.breakEvenCpa ?? snapshot.coverage?.thresholds.breakEvenCpa ?? null,
    riskPosture: snapshot.targetPack?.defaultRiskPosture ?? snapshot.coverage?.thresholds.defaultRiskPosture ?? "balanced",
  });
}

export function hasMetaHardActionAnchor(targets: MetaCommercialTargets | null | undefined) {
  return normalizeMetaCommercialTargets(targets).source === "configured_targets";
}

export function metaScaleRoasFloor(targets: MetaCommercialTargets | null | undefined) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (normalized.targetRoas) return normalized.targetRoas;
  if (normalized.breakEvenRoas) return normalized.breakEvenRoas * 1.15;
  return null;
}

export function metaCutRoasCeiling(targets: MetaCommercialTargets | null | undefined) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (normalized.breakEvenRoas) return normalized.breakEvenRoas;
  if (normalized.targetRoas) return normalized.targetRoas * 0.75;
  return null;
}

function currencyFloor(currency: string | null | undefined) {
  if (currency === "TRY") return 1500;
  if (currency === "EUR") return 50;
  return 50;
}

function riskMultiplier(posture: MetaCommercialRiskPosture) {
  if (posture === "conservative") return 2.5;
  if (posture === "aggressive") return 1.5;
  return 2;
}

export function metaLossBudgetMaturity(input: {
  targets?: MetaCommercialTargets | null;
  accountCpaBaseline?: number | null;
  currency?: string | null;
}): MetaLossBudgetMaturity | null {
  const targets = normalizeMetaCommercialTargets(input.targets);
  const breakEvenCpa = positiveNumber(targets.breakEvenCpa);
  const targetCpa = positiveNumber(targets.targetCpa);
  const accountCpa = positiveNumber(input.accountCpaBaseline);
  const cpaBaseline = breakEvenCpa ?? targetCpa ?? accountCpa;
  if (!cpaBaseline) return null;
  const multiplier = riskMultiplier(targets.riskPosture);
  const floor = currencyFloor(input.currency);
  return {
    spendThreshold: Math.max(floor, cpaBaseline * multiplier),
    cpaBaseline,
    multiplier,
    currencyFloor: floor,
    source: breakEvenCpa ? "break_even_cpa" : targetCpa ? "target_cpa" : "account_cpa",
  };
}
