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

/**
 * The manual Cut advisory's evidence shape, built through the REAL resolver
 * with supplied receipt lineage and a window manifest: every economic day's
 * purchase goal and PURCHASE event observed as `observation` says, the
 * historical campaign objective only typed (never verified), and the evaluation
 * day's whole configuration bracketed. Defaults: five 100/100 days with the
 * second one point-observed.
 */
export interface PurchaseIntentFixtureDay {
  date: string;
  spend: number;
  revenue: number;
  conversions?: number;
  observation?: "bracketed" | "point" | "typed" | "interval_uncertain" | "absent";
  eventValue?: string | null;
  customConversionId?: string | null;
}

const OBSERVATION_TIERS: Record<
  NonNullable<PurchaseIntentFixtureDay["observation"]>,
  { tier: string; readiness: string }
> = {
  bracketed: { tier: BRACKETED, readiness: "decision_authority" },
  point: { tier: "provider_receipt_legacy_single_page", readiness: "review_only" },
  typed: { tier: "typed_contemporaneous", readiness: "review_only" },
  interval_uncertain: {
    tier: "provider_receipt_legacy_interval_uncertain",
    readiness: "review_only",
  },
  absent: { tier: "observed_absent", readiness: "none" },
};

export function purchaseIntentDays(
  pointIndexes: number[] = [1],
  dates = ["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-11"],
): PurchaseIntentFixtureDay[] {
  return dates.map((date, i) => ({
    date,
    spend: 100,
    revenue: 100,
    conversions: 1,
    observation: pointIndexes.includes(i) ? "point" : "bracketed",
  }));
}

const REF_SNAPSHOT = "11111111-1111-4111-8111-111111111111";
const REF_OBSERVATION = "33333333-3333-4333-8333-333333333333";
const REF_CORROBORATION = "55555555-5555-4555-8555-555555555555";

function bracketedRef(field: string, asOfDate: string) {
  return {
    refContractVersion: "meta-config-field-evidence-ref.v1",
    field,
    sourceContractVersion: "meta-config-field-source.v1",
    normalizationVersion: 1,
    tier: BRACKETED,
    readiness: "decision_authority",
    sourceClass: "legacy_observed",
    pitClass: "as_of_known",
    sourceSnapshotId: REF_SNAPSHOT,
    observationId: REF_OBSERVATION,
    observedAt: `${asOfDate}T00:30:00.000Z`,
    fieldScopeHash: "b".repeat(64),
    corroboratingSnapshotId: REF_SNAPSHOT,
    corroboratingObservationId: REF_CORROBORATION,
    corroboratingObservedAt: `${asOfDate}T01:00:00.000Z`,
  };
}

function noReceiptRef(field: string) {
  return {
    refContractVersion: "meta-config-field-evidence-ref.v1",
    field,
    sourceContractVersion: "meta-config-field-source.v1",
    normalizationVersion: null,
    tier: "unknown",
    readiness: "none",
    sourceClass: "none",
    pitClass: null,
    sourceSnapshotId: null,
    observationId: null,
    observedAt: null,
    fieldScopeHash: null,
    corroboratingSnapshotId: null,
    corroboratingObservationId: null,
    corroboratingObservedAt: null,
  };
}

export function purchaseIntentConfigAuthority(
  asOfDate = "2026-07-12",
  override: {
    days?: PurchaseIntentFixtureDay[];
    optimizationGoal?: string | null;
    currentObjectiveReadiness?: string;
    goalReceiptDisagreements?: number;
    objectiveReceiptDisagreements?: number;
    /** `null` omits the manifest (a row that predates lineage). */
    manifest?: Record<string, unknown> | null;
    /** `null` omits the current references (a row that predates lineage). */
    currentEvidenceRefs?: Record<string, unknown> | null;
  } = {},
): HydratedConfigAuthority {
  const days = override.days ?? purchaseIntentDays();
  const observation = (day: PurchaseIntentFixtureDay) =>
    OBSERVATION_TIERS[day.observation ?? "bracketed"];
  const eventOf = (day: PurchaseIntentFixtureDay) =>
    day.eventValue === undefined ? "PURCHASE" : day.eventValue;
  const economicDays = days.filter(
    (day) => day.spend !== 0 || (day.conversions ?? 0) !== 0 || day.revenue !== 0,
  ).length;
  const currentObjectiveReadiness =
    override.currentObjectiveReadiness ?? "decision_authority";
  const refs =
    override.currentEvidenceRefs === null
      ? undefined
      : {
          objective:
            currentObjectiveReadiness === "decision_authority"
              ? bracketedRef("objective", asOfDate)
              : noReceiptRef("objective"),
          optimization_goal: bracketedRef("optimization_goal", asOfDate),
          custom_event_type: bracketedRef("custom_event_type", asOfDate),
          custom_conversion_id: noReceiptRef("custom_conversion_id"),
          ...(override.currentEvidenceRefs ?? {}),
        };
  const manifest =
    override.manifest === null
      ? undefined
      : {
          hash: "c".repeat(64),
          economicDayCount: economicDays,
          nullObservationIdCount: 0,
          incoherentDayCount: 0,
          ...(override.manifest ?? {}),
        };
  return resolveHydratedConfigAuthority({
    cohort: "purchase",
    optimizationGoal:
      override.optimizationGoal === undefined ? "OFFSITE_CONVERSIONS" : override.optimizationGoal,
    asOfDate,
    row: {
      latestContextDate: asOfDate,
      providerLocalAsOfDate: asOfDate,
      objectiveTier: "typed_contemporaneous",
      objectiveReadiness: "review_only",
      optimizationGoalTier: BRACKETED,
      optimizationGoalReadiness: "decision_authority",
      customEventTypeTier: BRACKETED,
      customEventTypeReadiness: "decision_authority",
      customEventType: "PURCHASE",
      customConversionId: null,
      customConversionIdReadiness: null,
      authorityDates: days.map((day) => day.date),
      authoritySpend: days.map((day) => day.spend),
      authorityConversions: days.map((day) => day.conversions ?? 0),
      authorityRevenue: days.map((day) => day.revenue),
      authorityObjectiveTier: days.map(() => "typed_contemporaneous"),
      authorityObjectiveReadiness: days.map(() => "review_only"),
      authorityGoalTier: days.map((day) => observation(day).tier),
      authorityGoalReadiness: days.map((day) => observation(day).readiness),
      authorityEventTier: days.map((day) => observation(day).tier),
      authorityEventReadiness: days.map((day) => observation(day).readiness),
      authorityEventValue: days.map(eventOf),
      authorityCustomConversionId: days.map((day) => day.customConversionId ?? null),
      authorityCustomConversionReadiness: days.map((day) =>
        day.customConversionId ? "decision_authority" : null,
      ),
      currentConfigDay: asOfDate,
      currentObjectiveTier: BRACKETED,
      currentObjectiveReadiness,
      currentOptimizationGoalTier: BRACKETED,
      currentOptimizationGoalReadiness: "decision_authority",
      currentCustomEventTypeTier: BRACKETED,
      currentCustomEventTypeReadiness: "decision_authority",
      currentCustomEventType: "PURCHASE",
      currentCustomConversionId: null,
      currentCustomConversionIdReadiness: refs ? "none" : null,
      objectiveReceiptDisagreements: override.objectiveReceiptDisagreements ?? 0,
      optimizationGoalReceiptDisagreements: override.goalReceiptDisagreements ?? 0,
      ...(refs ? { currentEvidenceRefs: refs } : {}),
      ...(manifest ? { authorityReceiptManifest: manifest } : {}),
    },
  });
}
