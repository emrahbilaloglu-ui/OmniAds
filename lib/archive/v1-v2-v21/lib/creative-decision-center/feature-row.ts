import type {
  CreativeDecisionOsCreative,
  CreativeDecisionOsV1Response,
} from "@/lib/creative-decision-os";
import type {
  CreativeDecisionCenterIdentityGrain,
  CreativeDecisionCenterMaturity,
} from "@/lib/creative-decision-center/contracts";
import type { CreativeDecisionOsV21Input } from "@/lib/creative-decision-os-v2";
import type { CreativeDecisionOsSnapshot } from "@/lib/creative-decision-os-snapshots";
import type { CreativeDecisionConfig } from "@/lib/creative-decision-center/contracts";

export interface CreativeDecisionCenterV21FeatureRow extends CreativeDecisionOsV21Input {
  availableData: string[];
  missingData: string[];
}

const REQUIRED_FIELDS = [
  "spend",
  "purchases",
  "impressions",
  "roas",
  "cpa",
  "ctr",
  "cpm",
  "frequency",
  "firstSeenAt",
  "firstSpendAt",
  "reviewStatus",
  "effectiveStatus",
  "policyReason",
  "spend24h",
  "impressions24h",
  "campaignStatus",
  "adsetStatus",
  "adStatus",
  "benchmarkReliability",
  "targetSource",
  "dataFreshness",
  "truth",
] as const;

function hasValue(value: unknown) {
  return value !== null && value !== undefined && value !== "";
}

function maybeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hoursBetween(laterIso: string, earlierIso: string) {
  const later = Date.parse(laterIso);
  const earlier = Date.parse(earlierIso);
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return null;
  return Math.max(0, (later - earlier) / 3_600_000);
}

function freshness(input: {
  snapshot: CreativeDecisionOsSnapshot;
  now: string;
  config: CreativeDecisionConfig;
}) {
  const ageHours = hoursBetween(input.now, input.snapshot.generatedAt);
  if (ageHours === null) {
    return { status: "unknown" as const, ageHours: null };
  }
  return {
    status: ageHours > input.config.staleDataHours ? "stale" as const : "fresh" as const,
    ageHours,
  };
}

function maturity(
  creative: CreativeDecisionOsCreative,
  config: CreativeDecisionConfig,
): CreativeDecisionCenterMaturity {
  const creativeAgeDays = maybeNumber(creative.creativeAgeDays) ?? 0;
  const spend = maybeNumber(creative.spend) ?? 0;
  const purchases = maybeNumber(creative.purchases) ?? 0;
  const impressions = maybeNumber(creative.impressions) ?? 0;
  if (creativeAgeDays <= Math.ceil(config.launchWindowHours / 24)) {
    return "too_early";
  }
  if (purchases >= config.minPurchasesForScale && spend >= 500) {
    return "mature";
  }
  if (purchases >= 2 && impressions >= config.minImpressionsForCtrReliability / 2) {
    return "actionable";
  }
  return "learning";
}

function truthState(payload: CreativeDecisionOsV1Response, creative: CreativeDecisionOsCreative) {
  const missingInputs = payload.commercialTruthCoverage?.missingInputs ?? [];
  const trustState = String(
    (creative.trust as unknown as Record<string, unknown>)?.truthState ??
      (creative.trust as unknown as Record<string, unknown>)?.state ??
      "",
  ).toLowerCase();

  if (trustState.includes("degraded")) return "degraded" as const;
  if (trustState.includes("missing")) return "missing" as const;
  if (missingInputs.length > 0) return "missing" as const;
  return "present" as const;
}

function benchmarkReliability(creative: CreativeDecisionOsCreative) {
  const value = creative.benchmarkReliability;
  return value === "strong" || value === "medium" || value === "weak"
    ? value
    : "missing";
}

function targetSource(payload: CreativeDecisionOsV1Response, creative: CreativeDecisionOsCreative) {
  if (
    creative.economics?.targetRoas != null ||
    creative.economics?.targetCpa != null ||
    creative.economics?.breakEvenRoas != null ||
    creative.economics?.breakEvenCpa != null
  ) {
    return "business_commercial_truth";
  }
  if (payload.commercialTruthCoverage?.configuredSections?.targetPack) {
    return "business_commercial_truth";
  }
  if (creative.benchmarkReliability === "strong" || creative.benchmarkReliability === "medium") {
    return "benchmark";
  }
  return null;
}

function reasonHints(creative: CreativeDecisionOsCreative): string[] {
  return Array.from(
    new Set([
      ...(creative.decisionSignals ?? []),
      creative.fatigue?.status === "fatigued" ? "fatigue_composite" : null,
      creative.primaryAction === "hold_no_touch" ? "stable_winner" : null,
    ].filter((item): item is string => Boolean(item))),
  );
}

function withCoverage(
  row: Omit<CreativeDecisionCenterV21FeatureRow, "availableData" | "missingData">,
): CreativeDecisionCenterV21FeatureRow {
  const availableData = REQUIRED_FIELDS.filter((field) => {
    if (field === "truth") return row.truthState === "present";
    if (field === "dataFreshness") return row.dataFreshnessStatus === "fresh" || row.dataFreshnessStatus === "stale";
    if (field === "policyReason") return hasValue(row.policyReason);
    if (field === "benchmarkReliability") return row.benchmarkReliability === "strong" || row.benchmarkReliability === "medium";
    return hasValue((row as unknown as Record<string, unknown>)[field]);
  });
  const missingData = REQUIRED_FIELDS.filter((field) => !availableData.includes(field));

  return {
    ...row,
    availableData,
    missingData,
  };
}

export function buildCreativeDecisionCenterV21FeatureRows(input: {
  snapshot: CreativeDecisionOsSnapshot;
  now: string;
  config: CreativeDecisionConfig;
}): CreativeDecisionCenterV21FeatureRow[] {
  const payload = input.snapshot.payload;
  if (!payload) return [];
  const fresh = freshness(input);

  return payload.creatives.map((creative) => {
    const deliveryContext = creative.deliveryContext;
    const cpm = maybeNumber(
      creative.impressions > 0 ? (creative.spend / creative.impressions) * 1000 : null,
    );
    const frequency = maybeNumber(
      (creative as unknown as { frequency?: unknown }).frequency,
    );
    const target = targetSource(payload, creative);
    const benchmark = creative.benchmark?.metrics;

    return withCoverage({
      rowId: creative.creativeId,
      creativeId: creative.creativeId,
      identityGrain: "creative" as CreativeDecisionCenterIdentityGrain,
      familyId: creative.familyId ?? null,
      activeStatus: deliveryContext?.activeDelivery ?? null,
      adStatus: null,
      campaignStatus: deliveryContext?.campaignStatus ?? null,
      adsetStatus: deliveryContext?.adSetStatus ?? null,
      spend: creative.spend ?? null,
      purchases: creative.purchases ?? null,
      impressions: creative.impressions ?? null,
      roas: creative.roas ?? null,
      cpa: creative.cpa ?? null,
      recentRoas: creative.report?.timeframeContext ? null : creative.roas,
      recentPurchases: null,
      benchmarkRoas: benchmark?.roas?.benchmark ?? creative.relativeBaseline?.weightedRoas ?? null,
      benchmarkCpa: benchmark?.cpa?.benchmark ?? creative.relativeBaseline?.weightedCpa ?? null,
      targetRoas: creative.economics?.targetRoas ?? creative.economics?.breakEvenRoas ?? null,
      targetCpa: creative.economics?.targetCpa ?? creative.economics?.breakEvenCpa ?? null,
      peerMedianSpend: creative.relativeBaseline?.medianSpend ?? null,
      ctr: creative.ctr ?? null,
      cpm,
      frequency,
      ctrDecayPct: creative.fatigue?.ctrDecay ?? null,
      cpmIncreasePct: null,
      frequencyIncreasePct: creative.fatigue?.frequencyPressure ?? null,
      fatigueStatus: creative.fatigue?.status ?? "unknown",
      fatigueConfidence: creative.fatigue?.confidence ?? null,
      firstSeenAt: null,
      firstSpendAt: null,
      launchAgeHours: creative.creativeAgeDays * 24,
      spend24h: null,
      impressions24h: null,
      reviewStatus: null,
      effectiveStatus: null,
      policyReason: null,
      benchmarkReliability: benchmarkReliability(creative),
      targetSource: target,
      dataFreshnessStatus: fresh.status,
      dataFreshnessHours: fresh.ageHours,
      truthState: truthState(payload, creative),
      maturity: maturity(creative, input.config),
      reasonHints: reasonHints(creative),
    });
  });
}
