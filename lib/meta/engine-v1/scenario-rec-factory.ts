import {
  META_RECOMMENDATION_ENGINE_VERSION,
  type MetaRecommendation,
} from "@/lib/meta/recommendations";
import {
  META_ENGINE_V1_SCENARIOS,
  type MetaEngineScenarioDefinition,
} from "@/lib/meta/engine-v1/scenarios";

export interface MetaScenarioFixtureEntity {
  level: "campaign" | "adset";
  campaignId: string;
  campaignName: string;
  adsetId?: string;
  adsetName?: string;
  roas?: number;
  purchases?: number;
}

function scenarioDecisionState(scenario: MetaEngineScenarioDefinition): MetaRecommendation["decisionState"] {
  if (scenario.missingSignalFallback === "diagnose_low_confidence") return "test";
  if (scenario.missingSignalFallback === "unsupported_state") return "watch";
  if (/^(B|C|I|K)/.test(scenario.id)) return "act";
  return "test";
}

function scenarioRecommendedAction(scenario: MetaEngineScenarioDefinition) {
  if (/^A/.test(scenario.id)) return "Respect learning and sample gates before changing delivery.";
  if (/^B/.test(scenario.id)) return "Tune bid strategy using account-history bands.";
  if (/^C/.test(scenario.id)) return "Apply controlled scale only inside calibrated guardrails.";
  if (/^D/.test(scenario.id)) return "Review audience structure and isolate the cleaner audience path.";
  if (/^E/.test(scenario.id)) return "Refresh creative or rotate the fatigued delivery path.";
  if (/^F/.test(scenario.id)) return "Diagnose the ROAS drop before taking a budget action.";
  if (/^G/.test(scenario.id)) return "Switch optimization event only after signal-density checks.";
  if (/^H/.test(scenario.id)) return "Diagnose tracking quality before trusting performance movement.";
  if (/^I/.test(scenario.id)) return "Restructure budget allocation around the winning adset pattern.";
  if (/^J/.test(scenario.id)) return "Protect portfolio winners while monitoring fade risk.";
  return "Resolve structural or seasonal constraints before scaling.";
}

export function buildMetaScenarioRecommendation(input: {
  scenario: MetaEngineScenarioDefinition;
  entity: MetaScenarioFixtureEntity;
  confidenceScore?: number;
}): MetaRecommendation {
  const { scenario, entity } = input;
  const decisionState = scenarioDecisionState(scenario);
  const confidenceScore = input.confidenceScore ?? (decisionState === "act" ? 0.72 : decisionState === "test" ? 0.58 : 0.38);
  const scopeName = entity.level === "adset" ? entity.adsetName ?? entity.campaignName : entity.campaignName;
  return {
    id: `${scenario.recType}-${entity.level}-${entity.level === "adset" ? entity.adsetId : entity.campaignId}`,
    level: entity.level,
    campaignId: entity.campaignId,
    campaignName: entity.campaignName,
    adsetId: entity.level === "adset" ? entity.adsetId : undefined,
    adsetName: entity.level === "adset" ? entity.adsetName : undefined,
    type: scenario.recType,
    kind: "recommendation",
    lens: /^B|^C|^F|^J/.test(scenario.id) ? "profitability" : /^G|^I/.test(scenario.id) ? "volume" : "structure",
    priority: decisionState === "act" ? "high" : decisionState === "test" ? "medium" : "low",
    confidence: confidenceScore >= 0.7 ? "high" : confidenceScore >= 0.55 ? "medium" : "low",
    confidenceScore,
    confidenceReason: `fixture_triggered_${scenario.id.toLowerCase()}`,
    decisionState,
    decision: scenario.id,
    title: `${scenario.id}: ${scopeName}`,
    why: `Fixture satisfies ${scenario.id} required signals: ${scenario.requiredSignals.join(", ")}.`,
    summary: `Scenario ${scenario.id} fired for Meta Engine v1 validation on an account-history grounded fixture.`,
    recommendedAction: scenarioRecommendedAction(scenario),
    expectedImpact: "Validates scenario-library coverage without emitting fake production actions.",
    evidence: [
      { label: "Scenario", value: scenario.id, tone: "neutral" },
      { label: "Signals", value: String(scenario.requiredSignals.length), tone: "neutral" },
      { label: "ROAS", value: `${(entity.roas ?? 1.8).toFixed(2)}x`, tone: "neutral" },
      { label: "Purchases", value: String(entity.purchases ?? 12), tone: "neutral" },
    ],
    timeframeContext: {
      coreVerdict: `Scenario ${scenario.id} fixture fired.`,
      selectedRangeOverlay: "Fixture rows are validation-only and are not production state coverage.",
      historicalSupport: "Uses account-history fixture bands instead of generic industry thresholds.",
      seasonalityFlag: /^K/.test(scenario.id) ? "possible" : "none",
      note: null,
    },
    targetValue: {
      scenarioId: scenario.id,
      requiredSignals: scenario.requiredSignals,
      fixtureOnly: true,
    },
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    calibrationScope: { type: "fixture", id: scenario.id, snapshotDate: "2026-05-08" },
    signalQuality: { quality_status: "fixture_complete", confidence_cap: "fixture_only" },
  };
}

export function buildMetaScenarioFixtureRecommendations(): MetaRecommendation[] {
  return META_ENGINE_V1_SCENARIOS.map((scenario, index) =>
    buildMetaScenarioRecommendation({
      scenario,
      entity: {
        level: index % 3 === 0 ? "campaign" : "adset",
        campaignId: `fixture_campaign_${index % 8}`,
        campaignName: `Fixture Campaign ${index % 8}`,
        adsetId: `fixture_adset_${index}`,
        adsetName: `Fixture Adset ${index}`,
        roas: 1.2 + (index % 5) * 0.4,
        purchases: 5 + index,
      },
    }),
  );
}
