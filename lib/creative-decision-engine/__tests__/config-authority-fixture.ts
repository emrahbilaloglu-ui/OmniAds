/**
 * A config authority for fixtures that mean "the configuration is known".
 *
 * Built through the REAL resolver rather than hand-written, so a fixture cannot
 * assert a shape the production path can never produce. Most decision fixtures
 * predate the config source contract and were written when a value was all a
 * decision needed; they still mean what they always meant, and this states it.
 *
 * A fixture that is ABOUT weak or missing provenance uses
 * `EMPTY_HYDRATED_CONFIG_AUTHORITY` or builds its own row instead.
 */
import {
  resolveHydratedConfigAuthority,
  type HydratedConfigAuthority,
} from "../native-ad-hydration-authority";

const BRACKETED = "provider_receipt_legacy_bracketed";

export function observedConfigAuthority(
  asOfDate = "2026-07-12",
): HydratedConfigAuthority {
  return resolveHydratedConfigAuthority({
    cohort: "purchase",
    asOfDate,
    row: {
      latestContextDate: asOfDate,
      providerLocalAsOfDate: asOfDate,
      objectiveTier: BRACKETED,
      objectiveReadiness: "decision_authority",
      optimizationGoalTier: BRACKETED,
      optimizationGoalReadiness: "decision_authority",
      customEventTypeTier: BRACKETED,
      customEventTypeReadiness: "decision_authority",
      customEventType: "PURCHASE",
      customConversionId: null,
      customConversionIdReadiness: null,
      authorityDates: [asOfDate],
      authoritySpend: [100],
      authorityConversions: [2],
      authorityRevenue: [240],
      authorityObjectiveTier: [BRACKETED],
      authorityObjectiveReadiness: ["decision_authority"],
      authorityGoalTier: [BRACKETED],
      authorityGoalReadiness: ["decision_authority"],
      authorityEventTier: [BRACKETED],
      authorityEventReadiness: ["decision_authority"],
      authorityEventValue: ["PURCHASE"],
      authorityCustomConversionId: [null],
      authorityCustomConversionReadiness: [null],
      /* The evaluation day's own receipt, naming the same configuration. */
      currentConfigDay: asOfDate,
      currentObjectiveTier: BRACKETED,
      currentObjectiveReadiness: "decision_authority",
      currentOptimizationGoalTier: BRACKETED,
      currentOptimizationGoalReadiness: "decision_authority",
      currentCustomEventTypeTier: BRACKETED,
      currentCustomEventTypeReadiness: "decision_authority",
      currentCustomEventType: "PURCHASE",
      currentCustomConversionId: null,
      currentCustomConversionIdReadiness: null,
      objectiveReceiptDisagreements: 0,
      optimizationGoalReceiptDisagreements: 0,
    },
  });
}
