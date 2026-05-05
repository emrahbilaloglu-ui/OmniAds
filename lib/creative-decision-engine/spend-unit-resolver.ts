import type {
  MetaAovQuality,
  SpendUnitConfidence,
  SpendUnitEvidence,
  SpendUnitSource,
} from "./types";

export interface SpendUnitResolution {
  spendUnit: number | null;
  source: SpendUnitSource;
  confidence: SpendUnitConfidence;
  evidence: SpendUnitEvidence;
  hardEligibleByDefault: boolean;
}

export function classifyMetaAovQuality(purchaseCount: number): MetaAovQuality {
  if (!Number.isFinite(purchaseCount) || purchaseCount <= 0) {
    return "unavailable";
  }
  if (purchaseCount < 5) return "unstable";
  if (purchaseCount < 20) return "low_sample";
  return "ready";
}

function positiveFinite(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function baseEvidence(input: {
  targetCpa: number | null;
  operatorAovAssumption: number | null;
  metaAttributedAovMean90d: number | null;
  metaAttributedAovPurchaseCount90d: number;
  metaAttributedRevenue90d: number;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  accountCpaP50: number | null;
  accountCpaSampleCount: number;
}): SpendUnitEvidence {
  const warnings: string[] = [];

  if (!positiveFinite(input.targetCpa)) warnings.push("target_cpa_missing");
  if (!positiveFinite(input.targetRoas)) warnings.push("target_roas_missing");
  if (!positiveFinite(input.operatorAovAssumption)) {
    warnings.push("operator_aov_missing");
  }

  const metaAovQuality = classifyMetaAovQuality(
    input.metaAttributedAovPurchaseCount90d,
  );
  if (metaAovQuality === "unavailable") {
    warnings.push("meta_aov_unavailable");
  } else if (metaAovQuality === "unstable") {
    warnings.push("meta_aov_unstable");
  } else if (metaAovQuality === "low_sample") {
    warnings.push("meta_aov_low_sample");
  }

  if (input.accountCpaSampleCount < 20) {
    warnings.push("account_cpa_sample_low");
  }

  return {
    targetCpa: input.targetCpa,
    operatorAovAssumption: input.operatorAovAssumption,
    metaAttributedAovMean90d: input.metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d:
      input.metaAttributedAovPurchaseCount90d,
    metaAttributedRevenue90d: input.metaAttributedRevenue90d,
    targetRoas: input.targetRoas,
    breakEvenRoas: input.breakEvenRoas,
    accountCpaP50: input.accountCpaP50,
    accountCpaSampleCount: input.accountCpaSampleCount,
    warnings,
  };
}

function resolved(input: {
  spendUnit: number | null;
  source: SpendUnitSource;
  confidence: SpendUnitConfidence;
  evidence: SpendUnitEvidence;
  hardEligibleByDefault: boolean;
}): SpendUnitResolution {
  return input;
}

export function resolveSpendUnit(input: {
  targetCpa: number | null;
  operatorAovAssumption: number | null;
  metaAttributedAovMean90d: number | null;
  metaAttributedAovPurchaseCount90d: number;
  metaAttributedRevenue90d: number;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  accountCpaP50: number | null;
  accountCpaSampleCount: number;
  attributionAovAdjustmentMultiplier: number;
}): SpendUnitResolution {
  const evidence = baseEvidence(input);

  if (positiveFinite(input.targetCpa)) {
    return resolved({
      spendUnit: input.targetCpa,
      source: "target_cpa",
      confidence: "high",
      evidence,
      hardEligibleByDefault: true,
    });
  }

  if (
    positiveFinite(input.operatorAovAssumption) &&
    positiveFinite(input.targetRoas)
  ) {
    return resolved({
      spendUnit: input.operatorAovAssumption / input.targetRoas,
      source: "operator_aov",
      confidence: "high",
      evidence,
      hardEligibleByDefault: true,
    });
  }

  const metaAovQuality = classifyMetaAovQuality(
    input.metaAttributedAovPurchaseCount90d,
  );
  if (
    metaAovQuality !== "unavailable" &&
    positiveFinite(input.metaAttributedAovMean90d) &&
    positiveFinite(input.targetRoas)
  ) {
    const adjustedAov =
      input.metaAttributedAovMean90d *
      input.attributionAovAdjustmentMultiplier;
    const isReady = metaAovQuality === "ready";
    return resolved({
      spendUnit: adjustedAov / input.targetRoas,
      source: "meta_derived_aov",
      confidence: isReady ? "medium" : "low",
      evidence,
      hardEligibleByDefault: isReady,
    });
  }

  if (positiveFinite(input.accountCpaP50) && input.accountCpaSampleCount >= 20) {
    return resolved({
      spendUnit: input.accountCpaP50,
      source: "account_history",
      confidence: positiveFinite(input.targetRoas) ? "medium" : "low",
      evidence,
      hardEligibleByDefault: false,
    });
  }

  if (
    positiveFinite(input.metaAttributedAovMean90d) &&
    positiveFinite(input.breakEvenRoas)
  ) {
    return resolved({
      spendUnit:
        (input.metaAttributedAovMean90d *
          input.attributionAovAdjustmentMultiplier) /
        input.breakEvenRoas,
      source: "break_even_aov",
      confidence: "low",
      evidence,
      hardEligibleByDefault: false,
    });
  }

  return resolved({
    spendUnit: null,
    source: "insufficient",
    confidence: "insufficient",
    evidence,
    hardEligibleByDefault: false,
  });
}
