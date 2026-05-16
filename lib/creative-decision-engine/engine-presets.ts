import type { EngineMultiplierSet, EngineRiskPreset } from "./types";

export const ENGINE_PRESET_MULTIPLIERS: Record<
  EngineRiskPreset,
  EngineMultiplierSet
> = {
  aggressive: {
    zeroConvBurner: 2.0,
    cutCandidate: 1.5,
    sustainedLoser: 2.0,
    lossBudget: 1.5,
    hardCut: 3.0,
    scalePurchase: 0.7,
    winnerMemory: 1.0,
    recentSample: 0.25,
    weakFunnelRate: 0.65,
  },
  balanced: {
    zeroConvBurner: 3.0,
    cutCandidate: 2.0,
    sustainedLoser: 3.0,
    lossBudget: 2.0,
    hardCut: 5.0,
    scalePurchase: 1.0,
    winnerMemory: 1.5,
    recentSample: 0.5,
    weakFunnelRate: 0.5,
  },
  conservative: {
    zeroConvBurner: 5.0,
    cutCandidate: 3.0,
    sustainedLoser: 5.0,
    lossBudget: 2.5,
    hardCut: 8.0,
    scalePurchase: 1.5,
    winnerMemory: 2.0,
    recentSample: 1.0,
    weakFunnelRate: 0.35,
  },
};
