import type {
  AccountDecisionProfile,
  AccountFunnelCalibration,
  CreativeInput,
  FormatFunnelBaseline,
  FunnelDiagnosis,
  FunnelRates,
} from "./types";

const FALLBACK_DENOMINATOR_P50 = {
  upperFunnel: 1_000,
  landingPage: 50,
  checkout: 10,
} as const;

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function rate(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
): number | null {
  if (numerator == null || !Number.isFinite(numerator)) return null;
  if (!positiveFinite(denominator)) return null;
  return (numerator / denominator) * 100;
}

function formatPercent(value: number) {
  return `${value.toFixed(2)}%`;
}

function formatRateEvidence(
  label: string,
  value: number,
  baseline: number | null,
) {
  return baseline === null
    ? `${label} ${formatPercent(value)} below weak-rate threshold`
    : `${label} ${formatPercent(value)} vs account baseline ${formatPercent(
        baseline,
      )}`;
}

export function computeFunnelRates(creative: CreativeInput): FunnelRates {
  const linkClicks = creative.linkClicks;
  const impressions = creative.impressions;
  const purchases = creative.purchases;
  const ctr =
    creative.ctr ??
    (positiveFinite(linkClicks) && positiveFinite(impressions)
      ? (linkClicks / impressions) * 100
      : null);

  return {
    ctr,
    outboundClickRate: rate(creative.outboundClicks, impressions),
    linkToLpvRate: rate(creative.landingPageViews, linkClicks),
    linkToAtcRate: rate(creative.addToCart, linkClicks),
    lpvToAtcRate: rate(creative.addToCart, creative.landingPageViews),
    atcToIcRate: rate(creative.initiateCheckout, creative.addToCart),
    icToPurchaseRate: rate(purchases, creative.initiateCheckout),
    atcToPurchaseRate: rate(purchases, creative.addToCart),
    clickToPurchaseRate: rate(purchases, linkClicks),
  };
}

export function stageDenominatorConfidence(
  creativeStageDenominator: number | null | undefined,
  accountStageDenominatorP50: number | null | undefined,
): number {
  if (
    !positiveFinite(creativeStageDenominator) ||
    !positiveFinite(accountStageDenominatorP50)
  ) {
    return 0;
  }
  return Math.min(1, creativeStageDenominator / accountStageDenominatorP50);
}

function resolveBaseline(input: {
  creative: CreativeInput;
  funnelCalibration: AccountFunnelCalibration;
}): FormatFunnelBaseline | null {
  const format = input.creative.creativeFormat ?? "overall";
  const specific = input.funnelCalibration.byFormat[format];
  if (specific && specific.qualityStatus !== "insufficient") {
    return specific;
  }

  const overall = input.funnelCalibration.byFormat.overall;
  if (overall && overall.qualityStatus !== "insufficient") {
    return overall;
  }

  return null;
}

function weakThreshold(p25: number | null, p50: number | null, multiplier: number) {
  if (p25 !== null) return p25;
  if (p50 !== null) return p50 * multiplier;
  return null;
}

function checkStageWeak(input: {
  label: string;
  rate: number | null;
  p25: number | null;
  p50: number | null;
  denomConfidence: number;
  weakMultiplier: number;
}): {
  weak: boolean;
  insufficient: boolean;
  evidence: string | null;
} {
  const threshold = weakThreshold(input.p25, input.p50, input.weakMultiplier);
  if (input.rate === null || threshold === null) {
    return { weak: false, insufficient: false, evidence: null };
  }

  const belowThreshold = input.rate <= threshold;
  if (!belowThreshold) {
    return { weak: false, insufficient: false, evidence: null };
  }

  const evidence = formatRateEvidence(input.label, input.rate, threshold);
  if (input.denomConfidence < 0.5) {
    return {
      weak: false,
      insufficient: true,
      evidence: `${evidence}; denominator confidence ${input.denomConfidence.toFixed(
        2,
      )}`,
    };
  }

  return { weak: true, insufficient: false, evidence };
}

function confidence(input: {
  denominatorConfidence: number;
  evidenceCount: number;
  base?: number;
}) {
  const base = input.base ?? 0.55;
  const evidenceLift = Math.min(0.15, Math.max(0, input.evidenceCount - 1) * 0.05);
  return Math.max(
    0,
    Math.min(1, base + input.denominatorConfidence * 0.25 + evidenceLift),
  );
}

function emptyDiagnosis(
  primaryWeakStage: FunnelDiagnosis["primaryWeakStage"],
  evidence: string[],
  rates: FunnelRates,
): FunnelDiagnosis {
  return {
    primaryWeakStage,
    creativeResponsible: false,
    confidence: 0,
    evidence,
    rates,
  };
}

function hasAnyRate(rates: FunnelRates) {
  return Object.values(rates).some((value) => value !== null);
}

export function hasUpperFunnelStrength(input: {
  creative: CreativeInput;
  funnelCalibration: AccountFunnelCalibration;
}): boolean {
  const baseline = resolveBaseline(input);
  if (baseline === null) return false;

  const rates = computeFunnelRates(input.creative);
  const ctrStrong =
    rates.ctr !== null &&
    baseline.ctrP50 !== null &&
    rates.ctr >= baseline.ctrP50;
  const thumbstopStrong =
    input.creative.thumbstop !== null &&
    baseline.thumbstopP50 !== null &&
    input.creative.thumbstop >= baseline.thumbstopP50;
  const cpmEfficient =
    input.creative.cpm !== null &&
    baseline.cpmP50 !== null &&
    input.creative.cpm <= baseline.cpmP50;

  return ctrStrong || thumbstopStrong || cpmEfficient;
}

export function computeFunnelDiagnosis(input: {
  creative: CreativeInput;
  funnelCalibration: AccountFunnelCalibration;
  profile: AccountDecisionProfile;
}): FunnelDiagnosis {
  const { creative, funnelCalibration, profile } = input;
  const rates = computeFunnelRates(creative);
  const baseline = resolveBaseline({ creative, funnelCalibration });

  if (baseline === null) {
    return emptyDiagnosis("insufficient_signal", [
      "no funnel calibration available",
    ], rates);
  }

  const weakMultiplier = profile.multipliers.weakFunnelRate;
  const upperConfidence = stageDenominatorConfidence(
    creative.impressions,
    FALLBACK_DENOMINATOR_P50.upperFunnel,
  );
  const clickConfidence = stageDenominatorConfidence(
    creative.linkClicks,
    FALLBACK_DENOMINATOR_P50.landingPage,
  );
  const lpvConfidence = stageDenominatorConfidence(
    creative.landingPageViews,
    FALLBACK_DENOMINATOR_P50.landingPage,
  );
  const atcConfidence = stageDenominatorConfidence(
    creative.addToCart,
    FALLBACK_DENOMINATOR_P50.checkout,
  );
  const icConfidence = stageDenominatorConfidence(
    creative.initiateCheckout,
    FALLBACK_DENOMINATOR_P50.checkout,
  );

  if (
    creative.spend > 0 &&
    (creative.linkClicks ?? 0) > 0 &&
    (creative.landingPageViews ?? 0) > 0 &&
    (creative.addToCart ?? 0) > 0 &&
    (creative.initiateCheckout ?? 0) > 0 &&
    creative.purchases === 0
  ) {
    return {
      primaryWeakStage: "tracking",
      creativeResponsible: false,
      confidence: 0.85,
      evidence: [
        "spend, clicks, landing page views, add-to-cart, and checkout all have activity but purchases are zero",
      ],
      rates,
    };
  }

  const insufficientEvidence: string[] = [];
  const upperEvidence: string[] = [];
  const upperChecks = [
    checkStageWeak({
      label: "CTR",
      rate: rates.ctr,
      p25: baseline.ctrP25,
      p50: baseline.ctrP50,
      denomConfidence: upperConfidence,
      weakMultiplier,
    }),
    checkStageWeak({
      label: "Thumbstop",
      rate: creative.thumbstop,
      p25: baseline.thumbstopP25,
      p50: baseline.thumbstopP50,
      denomConfidence: upperConfidence,
      weakMultiplier,
    }),
  ];

  for (const check of upperChecks) {
    if (check.evidence !== null) {
      if (check.weak) upperEvidence.push(check.evidence);
      if (check.insufficient) insufficientEvidence.push(check.evidence);
    }
  }

  if (
    creative.cpm !== null &&
    baseline.cpmP75 !== null &&
    creative.cpm > baseline.cpmP75 &&
    upperConfidence >= 0.5
  ) {
    upperEvidence.push(
      `CPM ${creative.cpm.toFixed(2)} above account P75 ${baseline.cpmP75.toFixed(
        2,
      )}`,
    );
  }
  if (creative.qualityRanking === "below_average") {
    upperEvidence.push("quality ranking below average");
  }
  if (creative.engagementRateRanking === "below_average") {
    upperEvidence.push("engagement rate ranking below average");
  }

  if (upperEvidence.length > 0) {
    return {
      primaryWeakStage: "upper_funnel",
      creativeResponsible: true,
      confidence: confidence({
        denominatorConfidence: upperConfidence,
        evidenceCount: upperEvidence.length,
      }),
      evidence: upperEvidence,
      rates,
    };
  }

  const landingEvidence: string[] = [];
  const landingChecks = [
    checkStageWeak({
      label: "Link-to-LPV",
      rate: rates.linkToLpvRate,
      p25: baseline.linkToLpvP25,
      p50: baseline.linkToLpvP50,
      denomConfidence: clickConfidence,
      weakMultiplier,
    }),
    checkStageWeak({
      label: "Link-to-ATC",
      rate: rates.linkToAtcRate,
      p25: baseline.linkToAtcP25,
      p50: baseline.linkToAtcP50,
      denomConfidence: clickConfidence,
      weakMultiplier,
    }),
    checkStageWeak({
      label: "LPV-to-ATC",
      rate: rates.lpvToAtcRate,
      p25: baseline.lpvToAtcP25,
      p50: baseline.lpvToAtcP50,
      denomConfidence: lpvConfidence,
      weakMultiplier,
    }),
  ];
  for (const check of landingChecks) {
    if (check.evidence !== null) {
      if (check.weak) landingEvidence.push(check.evidence);
      if (check.insufficient) insufficientEvidence.push(check.evidence);
    }
  }

  if (landingEvidence.length > 0) {
    return {
      primaryWeakStage: "landing_page",
      creativeResponsible: false,
      confidence: confidence({
        denominatorConfidence: Math.max(clickConfidence, lpvConfidence),
        evidenceCount: landingEvidence.length,
      }),
      evidence: landingEvidence,
      rates,
    };
  }

  const checkoutEvidence: string[] = [];
  const checkoutChecks = [
    checkStageWeak({
      label: "ATC-to-IC",
      rate: rates.atcToIcRate,
      p25: baseline.atcToIcP25,
      p50: baseline.atcToIcP50,
      denomConfidence: atcConfidence,
      weakMultiplier,
    }),
    checkStageWeak({
      label: "IC-to-purchase",
      rate: rates.icToPurchaseRate,
      p25: baseline.icToPurchaseP25,
      p50: baseline.icToPurchaseP50,
      denomConfidence: icConfidence,
      weakMultiplier,
    }),
  ];
  for (const check of checkoutChecks) {
    if (check.evidence !== null) {
      if (check.weak) checkoutEvidence.push(check.evidence);
      if (check.insufficient) insufficientEvidence.push(check.evidence);
    }
  }

  if (checkoutEvidence.length > 0) {
    return {
      primaryWeakStage: "checkout",
      creativeResponsible: false,
      confidence: confidence({
        denominatorConfidence: Math.max(atcConfidence, icConfidence),
        evidenceCount: checkoutEvidence.length,
      }),
      evidence: checkoutEvidence,
      rates,
    };
  }

  if (insufficientEvidence.length > 0 || !hasAnyRate(rates)) {
    return {
      primaryWeakStage: "insufficient_signal",
      creativeResponsible: false,
      confidence: 0,
      evidence:
        insufficientEvidence.length > 0
          ? insufficientEvidence
          : ["not enough funnel metrics to diagnose"],
      rates,
    };
  }

  return {
    primaryWeakStage: "none",
    creativeResponsible: false,
    confidence: 1,
    evidence: ["funnel rates are not below account weak thresholds"],
    rates,
  };
}
