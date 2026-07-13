import {
  FATIGUE_SIGNIFICANT_DECAY_THRESHOLD,
  FATIGUE_SPEND_CONCENTRATION_THRESHOLD,
} from "../config-values";

export type AdChallengerFamily =
  "V0" | "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H8" | "HC";

export type AdCutBoundaryMode =
  "account_p10" | "account_p25" | "below_both" | "midpoint_below_breakeven";

export type AdCutPurchaseFloorMode =
  "none" | "fixed_2" | "fixed_3" | "half_winner_p50";

export type NonPurchaseWeightMode =
  | "goal_result"
  | "lead_message_total"
  | "site_conversion_total"
  | "balanced_depth";

export interface AdChallengerSpec {
  id: string;
  family: AdChallengerFamily;
  label: string;
  calibrationHalfLifeDays: 14 | 28 | 56 | 90 | null;
  calibrationShrinkageKappa: 8 | 16 | 32 | 64 | null;
  calibrationQuantile:
    0.1 | 0.2 | 0.25 | 0.3 | 0.5 | 0.6 | 0.7 | 0.75 | 0.8 | null;
  lossBudgetMultiplier: 1.25 | 1.5 | 2 | 2.5 | 3 | null;
  zeroConvBurnerMultiplier: 2 | 3 | 4 | 5 | null;
  hardCutMultiplier: 3 | 4 | 5 | 6 | 8 | null;
  cutBoundaryMode: AdCutBoundaryMode;
  cutPurchaseFloorMode: AdCutPurchaseFloorMode;
  fatigueDecayThreshold: 0.1 | 0.15 | 0.18 | 0.25 | 0.3;
  fatigueConcentrationThreshold: 0.4 | 0.55 | 0.7;
  fatigueFrequencyQuantile: 0.7 | 0.75 | 0.8 | 0.85;
  fatigueRequiredDecayCount: 2 | 3;
  relativeWinnerQuantile: 0.7 | 0.75 | 0.8 | null;
  budgetScaleTargetRatio: 1.1 | 1.2 | 1.3 | 1.4 | 1.5 | null;
  scalePurchaseMultiplier: 0.7 | 1 | 1.25 | 1.5 | null;
  funnelWeakMultiplier: 0.35 | 0.5 | 0.65 | 0.8 | null;
  funnelConfidenceFloor: 0.55 | 0.65 | 0.75 | null;
  funnelEffectiveSampleFloor: 8 | 20 | 30 | null;
  nonPurchaseWeightMode: NonPurchaseWeightMode | null;
  nonPurchaseDepthGate: 1 | 3 | 5 | 8 | null;
}

const baseline: AdChallengerSpec = {
  id: "V0_current",
  family: "V0",
  label: "Current ad-grain engine policy",
  calibrationHalfLifeDays: null,
  calibrationShrinkageKappa: null,
  calibrationQuantile: null,
  lossBudgetMultiplier: null,
  zeroConvBurnerMultiplier: null,
  hardCutMultiplier: null,
  cutBoundaryMode: "account_p25",
  cutPurchaseFloorMode: "none",
  fatigueDecayThreshold: FATIGUE_SIGNIFICANT_DECAY_THRESHOLD,
  fatigueConcentrationThreshold: FATIGUE_SPEND_CONCENTRATION_THRESHOLD,
  fatigueFrequencyQuantile: 0.75,
  fatigueRequiredDecayCount: 2,
  relativeWinnerQuantile: null,
  budgetScaleTargetRatio: null,
  scalePurchaseMultiplier: null,
  funnelWeakMultiplier: null,
  funnelConfidenceFloor: null,
  funnelEffectiveSampleFloor: null,
  nonPurchaseWeightMode: null,
  nonPurchaseDepthGate: null,
};

function token(value: string | number) {
  return String(value).replaceAll(".", "p");
}

function challenger(
  family: Exclude<AdChallengerFamily, "V0">,
  id: string,
  label: string,
  overrides: Partial<AdChallengerSpec>,
): AdChallengerSpec {
  return { ...baseline, id: `${family}_${id}`, family, label, ...overrides };
}

export function buildAdChallengerGrid(): AdChallengerSpec[] {
  const result: AdChallengerSpec[] = [{ ...baseline }];

  for (const halfLife of [14, 28, 56, 90] as const) {
    for (const kappa of [8, 16, 32, 64] as const) {
      for (const quantile of [
        0.1, 0.2, 0.25, 0.3, 0.5, 0.6, 0.7, 0.75, 0.8,
      ] as const) {
        result.push(
          challenger(
            "H1",
            `hl${halfLife}_k${kappa}_q${token(quantile)}`,
            `Recency ${halfLife}d, shrinkage ${kappa}, quantile ${quantile}`,
            {
              calibrationHalfLifeDays: halfLife,
              calibrationShrinkageKappa: kappa,
              calibrationQuantile: quantile,
            },
          ),
        );
      }
    }
  }

  for (const lossBudget of [1.25, 1.5, 2, 2.5, 3] as const) {
    for (const zeroConversion of [2, 3, 4, 5] as const) {
      for (const hardCut of [3, 4, 5, 6, 8] as const) {
        result.push(
          challenger(
            "H2",
            `loss${token(lossBudget)}_zero${zeroConversion}_hard${hardCut}`,
            `Maturity loss ${lossBudget}, zero ${zeroConversion}, hard ${hardCut}`,
            {
              lossBudgetMultiplier: lossBudget,
              zeroConvBurnerMultiplier: zeroConversion,
              hardCutMultiplier: hardCut,
            },
          ),
        );
      }
    }
  }

  for (const boundary of [
    "account_p10",
    "account_p25",
    "below_both",
    "midpoint_below_breakeven",
  ] as const) {
    for (const purchaseFloor of [
      "none",
      "fixed_2",
      "fixed_3",
      "half_winner_p50",
    ] as const) {
      result.push(
        challenger(
          "H3",
          `${boundary}_${purchaseFloor}`,
          `Cut boundary ${boundary}, purchase floor ${purchaseFloor}`,
          { cutBoundaryMode: boundary, cutPurchaseFloorMode: purchaseFloor },
        ),
      );
    }
  }

  for (const relativeWinner of [0.7, 0.75, 0.8] as const) {
    for (const targetRatio of [1.1, 1.2, 1.3, 1.4, 1.5] as const) {
      for (const purchaseMultiplier of [0.7, 1, 1.25, 1.5] as const) {
        result.push(
          challenger(
            "H4",
            `rel${token(relativeWinner)}_target${token(targetRatio)}_purchase${token(purchaseMultiplier)}`,
            `Relative winner P${relativeWinner * 100}, target ${targetRatio}x, purchase ${purchaseMultiplier}x`,
            {
              relativeWinnerQuantile: relativeWinner,
              budgetScaleTargetRatio: targetRatio,
              scalePurchaseMultiplier: purchaseMultiplier,
              cutBoundaryMode: "below_both",
            },
          ),
        );
      }
    }
  }

  for (const decay of [0.1, 0.15, 0.18, 0.25, 0.3] as const) {
    for (const concentration of [0.4, 0.55, 0.7] as const) {
      for (const frequency of [0.7, 0.75, 0.8, 0.85] as const) {
        for (const decayCount of [2, 3] as const) {
          result.push(
            challenger(
              "H5",
              `decay${token(decay)}_con${token(concentration)}_freq${token(frequency)}_count${decayCount}`,
              `Fatigue decay ${decay}, concentration ${concentration}, frequency P${frequency * 100}, count ${decayCount}`,
              {
                fatigueDecayThreshold: decay,
                fatigueConcentrationThreshold: concentration,
                fatigueFrequencyQuantile: frequency,
                fatigueRequiredDecayCount: decayCount,
              },
            ),
          );
        }
      }
    }
  }

  for (const weakMultiplier of [0.35, 0.5, 0.65, 0.8] as const) {
    for (const confidence of [0.55, 0.65, 0.75] as const) {
      for (const sampleFloor of [8, 20, 30] as const) {
        result.push(
          challenger(
            "H6",
            `weak${token(weakMultiplier)}_confidence${token(confidence)}_sample${sampleFloor}`,
            `Funnel weak ${weakMultiplier}, confidence ${confidence}, sample ${sampleFloor}`,
            {
              funnelWeakMultiplier: weakMultiplier,
              funnelConfidenceFloor: confidence,
              funnelEffectiveSampleFloor: sampleFloor,
            },
          ),
        );
      }
    }
  }

  for (const weighting of [
    "goal_result",
    "lead_message_total",
    "site_conversion_total",
    "balanced_depth",
  ] as const) {
    for (const depth of [1, 3, 5, 8] as const) {
      result.push(
        challenger(
          "H8",
          `${weighting}_depth${depth}`,
          `Non-purchase ${weighting}, result depth ${depth}`,
          { nonPurchaseWeightMode: weighting, nonPurchaseDepthGate: depth },
        ),
      );
    }
  }

  result.push(
    challenger(
      "HC",
      "safe_cut_relative_winner",
      "Safe cut plus relative winner",
      {
        cutBoundaryMode: "below_both",
        relativeWinnerQuantile: 0.75,
        budgetScaleTargetRatio: 1.2,
        scalePurchaseMultiplier: 1,
      },
    ),
    challenger("HC", "safe_cut_maturity", "Safe cut plus maturity", {
      cutBoundaryMode: "below_both",
      lossBudgetMultiplier: 1.5,
      zeroConvBurnerMultiplier: 3,
      hardCutMultiplier: 4,
    }),
    challenger("HC", "safe_cut_fatigue", "Safe cut plus fatigue", {
      cutBoundaryMode: "below_both",
      fatigueDecayThreshold: 0.15,
      fatigueConcentrationThreshold: 0.55,
      fatigueFrequencyQuantile: 0.7,
      fatigueRequiredDecayCount: 2,
    }),
    challenger("HC", "safe_cut_funnel", "Safe cut plus funnel materiality", {
      cutBoundaryMode: "below_both",
      funnelWeakMultiplier: 0.5,
      funnelConfidenceFloor: 0.65,
      funnelEffectiveSampleFloor: 20,
    }),
    challenger(
      "HC",
      "safe_cut_hierarchical",
      "Safe cut plus hierarchical calibration",
      {
        cutBoundaryMode: "below_both",
        calibrationHalfLifeDays: 28,
        calibrationShrinkageKappa: 16,
        calibrationQuantile: 0.25,
      },
    ),
    challenger("HC", "full_preregistered", "Full preregistered interaction", {
      cutBoundaryMode: "below_both",
      lossBudgetMultiplier: 1.5,
      zeroConvBurnerMultiplier: 3,
      hardCutMultiplier: 4,
      relativeWinnerQuantile: 0.75,
      budgetScaleTargetRatio: 1.2,
      scalePurchaseMultiplier: 1,
      fatigueDecayThreshold: 0.15,
      fatigueConcentrationThreshold: 0.55,
      fatigueFrequencyQuantile: 0.7,
      fatigueRequiredDecayCount: 2,
      funnelWeakMultiplier: 0.5,
      funnelConfidenceFloor: 0.65,
      funnelEffectiveSampleFloor: 20,
    }),
  );

  return result;
}

export function buildAdSmokeGrid(): AdChallengerSpec[] {
  const full = buildAdChallengerGrid();
  const ids = new Set([
    "V0_current",
    "H1_hl28_k16_q0p25",
    "H2_loss1p5_zero3_hard4",
    "H2_loss2p5_zero3_hard4",
    "H3_below_both_none",
    "H3_below_both_half_winner_p50",
    "H4_rel0p75_target1p2_purchase1",
    "H5_decay0p15_con0p55_freq0p7_count2",
    "H5_decay0p25_con0p7_freq0p8_count2",
    "H6_weak0p5_confidence0p65_sample20",
    "H8_goal_result_depth3",
  ]);
  return full.filter((candidate) => ids.has(candidate.id));
}

export function adChallengerFamilyCounts(
  candidates: readonly AdChallengerSpec[],
) {
  return candidates.reduce<Record<string, number>>((counts, candidate) => {
    counts[candidate.family] = (counts[candidate.family] ?? 0) + 1;
    return counts;
  }, {});
}
