/**
 * Native manual Cut advisory (meta-native-manual-cut-advisory.v1).
 *
 * A RECOMMENDATION, never an authority. D098 still holds a hard verdict unless
 * every economic day's whole configuration — the campaign objective included —
 * is proven; this module changes none of that. The row keeps
 * `authority_blocker = config_source_authority`, its held Cut and a null
 * `authorized_action`. What it adds is a separately named, MEDIUM-capped manual
 * Cut recommendation, with its basis and uncertainty, for exactly one case:
 *
 *   The existing decision core returns a Cut; the same core returns a Cut again
 *   with every Cut-enabling peer ratio removed (so the account's commercial
 *   arithmetic alone supports it); and it returns a Cut on a sensitivity
 *   input in which every economic day whose purchase intent was only
 *   POINT-observed is raised to at least the commercial target, day by day —
 *   under BOTH the original and the peer-free profile. The peer-free profile
 *   is not uniformly stricter: its uncalibrated 0.70 boundary can sit above a
 *   low account P25, which keeps a stressed ratio in the legacy zone (recovery
 *   only above target) where the original profile would judge it in the
 *   break-even strip (economic recovery at break-even). Every economic day's purchase goal and PURCHASE/VALUE event must be
 *   named by a same-day receipt, the receipt manifest must describe exactly the
 *   economic window, and the current configuration must be observed with
 *   supplied receipt lineage.
 *
 * What it never claims: that a point-observed day's whole configuration was
 * verified, any historical campaign objective, or execution readiness. It is
 * Cut-only; Scale, Refresh and a Test-cohort Refresh turned Cut never qualify.
 *
 * Pure: the job runs the core and hands the results in. The proof is compact so
 * the caller can hash and persist it and a server can revalidate it with
 * `parseNativeManualCutAdvisoryProof` instead of trusting a badge.
 */
import type {
  AccountCalibration,
  AccountDecisionProfile,
  AdDecisionInput,
  CalibrationCampaignKind,
  DecisionLabel,
  EngineThresholdSet,
} from "./types";
import {
  META_PURCHASE_INTENT_WINDOW_CONTRACT,
  type HydratedConfigAuthority,
} from "./native-ad-hydration-authority";

export const META_NATIVE_MANUAL_CUT_ADVISORY_CONTRACT =
  "meta-native-manual-cut-advisory.v1" as const;

/* ── the peer-free profile ─────────────────────────────────────────────── */

function withoutPeerCutRatios(thresholds: EngineThresholdSet): EngineThresholdSet {
  return { ...thresholds, bottomQuartileRatio: null, severeLoserRatio: null };
}

function withoutPeerCutPercentiles(calibration: AccountCalibration): AccountCalibration {
  return { ...calibration, roasRatioP25: null, roasRatioP10: null };
}

function mapKinds<T>(
  record: Record<CalibrationCampaignKind, T | null> | undefined,
  map: (value: T) => T,
): Record<CalibrationCampaignKind, T | null> | undefined {
  if (!record) return record;
  const out = {} as Record<CalibrationCampaignKind, T | null>;
  for (const [kind, value] of Object.entries(record) as Array<
    [CalibrationCampaignKind, T | null]
  >) {
    out[kind] = value === null ? null : map(value);
  }
  return out;
}

/**
 * The same profile with every Cut-ENABLING peer quantity removed: the P25
 * boundary and the P10 severe-loser ratio, in every view that carries them.
 * The objective keys the peer cell, so these are exactly the quantities whose
 * population rests on an unverified objective. Spend thresholds (spend unit ×
 * fixed multipliers), the commercial target, break-even, sample floors and
 * every protective quantity stay.
 */
export function peerFreeCutProfile(profile: AccountDecisionProfile): AccountDecisionProfile {
  return {
    ...profile,
    thresholds: withoutPeerCutRatios(profile.thresholds),
    commercialStopLossThresholds: profile.commercialStopLossThresholds
      ? withoutPeerCutRatios(profile.commercialStopLossThresholds)
      : profile.commercialStopLossThresholds,
    thresholdsByKind: mapKinds(profile.thresholdsByKind, withoutPeerCutRatios),
    accountBaselines: withoutPeerCutPercentiles(profile.accountBaselines),
    accountBaselinesByKind: mapKinds(
      profile.accountBaselinesByKind,
      withoutPeerCutPercentiles,
    ),
  };
}

/* ── the point-day sensitivity input ──────────────────────────────────── */

export type ManualCutStressRefusal =
  | "commercial_target_invalid"
  | "purchase_intent_window_absent"
  | "decision_window_absent"
  | "point_day_invalid"
  | "point_day_outside_decision_window"
  | "cumulative_value_unconstructible"
  | "recent_window_unconstructible"
  | "band_unconstructible";

export interface ManualCutStressDay {
  date: string;
  spend: number;
  revenue: number;
  /** max(revenue, spend × commercial target), for THIS day alone. */
  stressedRevenue: number;
}

export interface ManualCutStressDetail {
  commercialTargetRoas: number;
  days: ManualCutStressDay[];
  purchaseValue: { actual: number; stressed: number };
  roas: { actual: number; stressed: number };
  /** Null when no point-observed day falls inside the recent band. */
  recent7dRoas: { actual: number; stressed: number } | null;
  /** Lifecycle bands whose revenue moved; the fatigue verdict is recomputed. */
  bands: Array<"recent14" | "prior14">;
}

const DAY = /^(\d{4}-\d{2}-\d{2})/;
/** Relative slack for comparing sums the loader produced with its own parts. */
const SUM_TOLERANCE = 1e-6;

function isoDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DAY.exec(value);
  if (!match) return null;
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === match[1]
    ? match[1]! : null;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function atLeast(total: number, part: number): boolean {
  return total + SUM_TOLERANCE * Math.max(1, Math.abs(total), Math.abs(part)) >= part;
}

function within(day: string, start: string, end: string): boolean {
  return start <= day && day <= end;
}

/**
 * The ad's decision input with every point-observed economic day's revenue
 * raised to max(actual, spend × commercial target), each day on its own.
 *
 * Moved: `purchaseValue` and `roas` (the admitted window), `recent7dRoas` when
 * the day falls in the recent band, and the revenue of any 14/14 lifecycle band
 * containing it. Never moved: spend, purchases, the window, any threshold, or
 * a band's spend. Refused, not approximated, when any of those figures cannot
 * be moved exactly: a sensitivity input that does not describe the same
 * decision would prove nothing.
 */
export function buildManualCutStressedAdInput(
  ad: AdDecisionInput,
  commercialTargetRoas: number | null | undefined,
):
  | { ok: true; ad: AdDecisionInput; detail: ManualCutStressDetail }
  | { ok: false; refusal: ManualCutStressRefusal } {
  const refuse = (refusal: ManualCutStressRefusal) => ({ ok: false, refusal }) as const;
  const target = commercialTargetRoas;
  if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) {
    return refuse("commercial_target_invalid");
  }
  const window = ad.configAuthority.purchaseIntentWindow;
  if (!window || window.contractVersion !== META_PURCHASE_INTENT_WINDOW_CONTRACT) {
    return refuse("purchase_intent_window_absent");
  }
  const decisionWindow = ad.decisionWindow ?? null;
  const windowStart = isoDay(decisionWindow?.startDate);
  const windowEnd = isoDay(decisionWindow?.endDate);
  if (!decisionWindow || windowStart === null || windowEnd === null) {
    return refuse("decision_window_absent");
  }

  const days: ManualCutStressDay[] = [];
  const seen = new Set<string>();
  for (const point of window.pointObserved) {
    const date = isoDay(point.date);
    if (
      date === null ||
      seen.has(date) ||
      !nonNegativeFinite(point.spend) ||
      !nonNegativeFinite(point.revenue)
    ) {
      return refuse("point_day_invalid");
    }
    seen.add(date);
    if (!within(date, windowStart, windowEnd)) {
      return refuse("point_day_outside_decision_window");
    }
    days.push({
      date,
      spend: point.spend,
      revenue: point.revenue,
      stressedRevenue: Math.max(point.revenue, point.spend * target),
    });
  }
  const delta = (day: ManualCutStressDay) => day.stressedRevenue - day.revenue;

  // The admitted window's own totals must contain the days being moved.
  const spend = ad.spend;
  const purchaseValue = ad.purchaseValue;
  const roas = ad.roas;
  const pointSpend = days.reduce((sum, day) => sum + day.spend, 0);
  const pointRevenue = days.reduce((sum, day) => sum + day.revenue, 0);
  if (
    !nonNegativeFinite(spend) ||
    spend <= 0 ||
    !nonNegativeFinite(purchaseValue) ||
    !nonNegativeFinite(roas) ||
    !atLeast(spend, pointSpend) ||
    !atLeast(purchaseValue, pointRevenue)
  ) {
    return refuse("cumulative_value_unconstructible");
  }
  const totalDelta = days.reduce((sum, day) => sum + delta(day), 0);

  // The recent band: moved when a point day falls in it, exactly or not at all.
  const recentStart = decisionWindow.recentStartDate;
  const recentEnd = decisionWindow.recentEndDate;
  let recent7dRoas: ManualCutStressDetail["recent7dRoas"] = null;
  let stressedRecentRoas = ad.recent7dRoas;
  if ((recentStart === null) !== (recentEnd === null)) {
    return refuse("recent_window_unconstructible");
  }
  const recentStartDay = recentStart === null ? null : isoDay(recentStart);
  const recentEndDay = recentEnd === null ? null : isoDay(recentEnd);
  if (recentStart !== null && (recentStartDay === null || recentEndDay === null)) {
    return refuse("recent_window_unconstructible");
  }
  const recentDays =
    recentStartDay !== null && recentEndDay !== null
      ? days.filter((day) => within(day.date, recentStartDay, recentEndDay))
      : [];
  if (recentDays.length > 0) {
    const recentSpend = ad.recent7dSpend;
    const recentRoas = ad.recent7dRoas;
    const recentPointSpend = recentDays.reduce((sum, day) => sum + day.spend, 0);
    if (
      !nonNegativeFinite(recentSpend) ||
      recentSpend <= 0 ||
      !nonNegativeFinite(recentRoas) ||
      !atLeast(recentSpend, recentPointSpend) ||
      !atLeast(recentRoas * recentSpend, recentDays.reduce((sum, day) => sum + day.revenue, 0))
    ) {
      return refuse("recent_window_unconstructible");
    }
    stressedRecentRoas =
      recentRoas + recentDays.reduce((sum, day) => sum + delta(day), 0) / recentSpend;
    recent7dRoas = { actual: recentRoas, stressed: stressedRecentRoas };
  }

  // The 14/14 lifecycle bands: revenue moves, spend never does.
  const bandEvidence = ad.adBandEvidence ?? null;
  const bands: ManualCutStressDetail["bands"] = [];
  let stressedBandEvidence = bandEvidence;
  if (bandEvidence) {
    const moved = { ...bandEvidence };
    for (const name of ["recent14", "prior14"] as const) {
      const band = bandEvidence[name];
      const start = isoDay(band.startDate);
      const end = isoDay(band.endDate);
      if (start === null || end === null) return refuse("band_unconstructible");
      const inside = days.filter((day) => within(day.date, start, end));
      if (inside.length === 0) continue;
      const insideSpend = inside.reduce((sum, day) => sum + day.spend, 0);
      const insideRevenue = inside.reduce((sum, day) => sum + day.revenue, 0);
      if (
        !nonNegativeFinite(band.spend) ||
        !nonNegativeFinite(band.revenue) ||
        !atLeast(band.spend, insideSpend) ||
        !atLeast(band.revenue, insideRevenue)
      ) {
        return refuse("band_unconstructible");
      }
      moved[name] = {
        ...band,
        revenue: band.revenue + inside.reduce((sum, day) => sum + delta(day), 0),
      };
      bands.push(name);
    }
    stressedBandEvidence = moved;
  }

  return {
    ok: true,
    ad: {
      ...ad,
      purchaseValue: purchaseValue + totalDelta,
      roas: roas + totalDelta / spend,
      recent7dRoas: stressedRecentRoas,
      adBandEvidence: stressedBandEvidence,
    },
    detail: {
      commercialTargetRoas: target,
      days,
      purchaseValue: { actual: purchaseValue, stressed: purchaseValue + totalDelta },
      roas: { actual: roas, stressed: roas + totalDelta / spend },
      recent7dRoas,
      bands,
    },
  };
}

/* ── what the job records from the core ───────────────────────────────── */

/** The fields of one core run the advisory reads. */
export interface ManualCutCoreVerdict {
  label: DecisionLabel;
  authorityBlocker: string | null;
  labelTransform: string | null;
}

/**
 * Computed by the job for every raw Cut, from the SAME core that produced the
 * published decision. Absent on a computation that never ran it.
 */
export interface ManualCutSensitivity {
  /** The core's own target for this decision, which the stress used. */
  commercialTargetRoas: number | null;
  peerFree: ManualCutCoreVerdict;
  stress:
    | { status: "not_required" }
    | { status: "unconstructible"; refusal: ManualCutStressRefusal }
    | {
        status: "evaluated";
        /** The stressed input on the PEER-FREE profile. */
        verdict: ManualCutCoreVerdict;
        /** The same stressed input on the ORIGINAL profile, peers included. */
        originalProfileVerdict: ManualCutCoreVerdict;
        detail: ManualCutStressDetail;
      };
}

/* ── the advisory ─────────────────────────────────────────────────────── */

export type NativeManualCutAdvisoryRefusal =
  | "not_a_published_cut"
  | "hysteresis_pending"
  | "refresh_transform_not_eligible"
  | "config_not_held"
  | "engine_validity_hold"
  | "source_coverage_gap"
  | "purchase_observation_incomplete"
  | "current_config_unobserved"
  | "current_receipt_lineage_unverified"
  | "receipt_manifest_incoherent"
  | "commercial_truth_absent"
  | "purchase_intent_window_invalid"
  | "purchase_intent_unnamed"
  | "goal_receipt_conflict"
  | "objective_receipt_conflict"
  | "sensitivity_not_computed"
  | "peer_free_cut_not_confirmed"
  | "sensitivity_unconstructible"
  | "stressed_cut_not_confirmed"
  | "stressed_original_cut_not_confirmed";

export interface NativeManualCutAdvisoryProof {
  contractVersion: typeof META_NATIVE_MANUAL_CUT_ADVISORY_CONTRACT;
  recommendation: "cut";
  basis: "peer_free_commercial_stop_loss";
  confidenceCap: "medium";
  /** No provider authority: the row stays config-held and unauthorized. */
  authority: "none";
  heldBy: "config_source_authority";
  asOfDate: string;
  computedAt: string;
  engineVersion: string;
  providerAccountId: string;
  adId: string;
  /** Null, or the campaign role, which only routes execution. */
  engineAuthorityBlocker: "campaign_context" | null;
  commercialTargetRoas: number;
  receiptManifestHash: string;
  economicDayCount: number;
  bracketedDays: number;
  /** Economic days whose campaign objective was not verified; never asserted. */
  historicalObjectiveUnverifiedDays: number;
  /** Whole-day configuration NOT verified on these; each stressed alone. */
  pointObservedDays: ManualCutStressDay[];
  /** Null when there was no point-observed day to stress. */
  stress: Omit<ManualCutStressDetail, "commercialTargetRoas" | "days"> | null;
}

export type NativeManualCutAdvisory =
  | { status: "advised"; proof: NativeManualCutAdvisoryProof }
  | { status: "refused"; refusal: NativeManualCutAdvisoryRefusal };

export interface NativeManualCutAdvisoryFacts {
  asOfDate: string;
  computedAt: string;
  engineVersion: string;
  providerAccountId: string;
  adId: string;
  rawLabel: DecisionLabel;
  publishedLabel: DecisionLabel;
  hysteresisSuppressed: boolean;
  labelTransform: string | null;
  /** The published decision's own blocker, before any payload-time gate. */
  engineAuthorityBlocker: string | null;
  /** The producer's own D098 / D101 / purchase-observation verdicts. */
  configSourceBlocked: boolean;
  sourceCoverageBlocked: boolean;
  purchaseEvidenceBlocked: boolean;
  truthSource: string | null | undefined;
  effectiveTargetRoas: number | null | undefined;
  configAuthority: HydratedConfigAuthority;
  sensitivity: ManualCutSensitivity | undefined;
}

function isCleanCut(verdict: ManualCutCoreVerdict): boolean {
  return (
    verdict.label === "cut" &&
    verdict.authorityBlocker === null &&
    verdict.labelTransform === null
  );
}

export function resolveNativeManualCutAdvisory(
  facts: NativeManualCutAdvisoryFacts,
): NativeManualCutAdvisory {
  const refuse = (refusal: NativeManualCutAdvisoryRefusal) =>
    ({ status: "refused", refusal }) as const;
  if (facts.rawLabel !== "cut") return refuse("not_a_published_cut");
  if (facts.hysteresisSuppressed) return refuse("hysteresis_pending");
  if (facts.publishedLabel !== "cut") return refuse("not_a_published_cut");
  if (facts.labelTransform !== null) return refuse("refresh_transform_not_eligible");
  // Only a row D098 actually holds needs advice; a verified one is not held.
  if (!facts.configSourceBlocked) return refuse("config_not_held");
  // The campaign role only routes HOW a stop is carried out. Every other
  // blocker (recovery, profile, calibration, metrics) is a validity gate.
  if (
    facts.engineAuthorityBlocker !== null &&
    facts.engineAuthorityBlocker !== "campaign_context"
  ) {
    return refuse("engine_validity_hold");
  }
  if (facts.sourceCoverageBlocked) return refuse("source_coverage_gap");
  if (facts.purchaseEvidenceBlocked) return refuse("purchase_observation_incomplete");

  const authority = facts.configAuthority;
  const current = authority.currentValueEvidence;
  if (!current.observed) return refuse("current_config_unobserved");
  if (!current.lineageSupplied || Object.keys(current.refRefusals).length > 0) {
    return refuse("current_receipt_lineage_unverified");
  }
  const economics = authority.decisionEconomics;
  const manifest = economics.receiptManifest;
  if (
    manifest === null ||
    economics.economicDayCount <= 0 ||
    manifest.economicDayCount !== economics.economicDayCount ||
    manifest.incoherentDayCount !== 0
  ) {
    return refuse("receipt_manifest_incoherent");
  }

  const target = facts.effectiveTargetRoas;
  if (
    facts.truthSource !== "commercial_truth" ||
    typeof target !== "number" ||
    !Number.isFinite(target) ||
    target <= 0
  ) {
    return refuse("commercial_truth_absent");
  }

  const intent = authority.purchaseIntentWindow;
  if (
    !intent ||
    intent.contractVersion !== META_PURCHASE_INTENT_WINDOW_CONTRACT ||
    intent.economicDayCount !== economics.economicDayCount ||
    intent.bracketedDays + intent.pointObservedDays + intent.unnamedDays !==
      intent.economicDayCount ||
    intent.pointObserved.length !== intent.pointObservedDays
  ) {
    return refuse("purchase_intent_window_invalid");
  }
  if (intent.unnamedDays > 0) return refuse("purchase_intent_unnamed");
  if (authority.receiptDisagreements.optimizationGoal !== 0) {
    return refuse("goal_receipt_conflict");
  }
  // A receipt that NAMED another objective than the one recorded is observed
  // conflicting configuration, not an absent historical objective.
  if (authority.receiptDisagreements.objective !== 0) {
    return refuse("objective_receipt_conflict");
  }

  const sensitivity = facts.sensitivity;
  if (!sensitivity || sensitivity.commercialTargetRoas !== target) {
    return refuse("sensitivity_not_computed");
  }
  if (!isCleanCut(sensitivity.peerFree)) return refuse("peer_free_cut_not_confirmed");
  const stress = sensitivity.stress;
  if (intent.pointObservedDays > 0 && stress.status !== "evaluated") {
    return refuse(
      stress.status === "unconstructible"
        ? "sensitivity_unconstructible"
        : "sensitivity_not_computed",
    );
  }
  if (intent.pointObservedDays === 0 && stress.status !== "not_required") {
    return refuse("sensitivity_not_computed");
  }
  if (stress.status === "evaluated") {
    if (
      stress.detail.commercialTargetRoas !== target ||
      stress.detail.days.length !== intent.pointObservedDays
    ) {
      return refuse("sensitivity_not_computed");
    }
    if (!isCleanCut(stress.verdict)) return refuse("stressed_cut_not_confirmed");
    if (!isCleanCut(stress.originalProfileVerdict)) {
      return refuse("stressed_original_cut_not_confirmed");
    }
  }

  return {
    status: "advised",
    proof: {
      contractVersion: META_NATIVE_MANUAL_CUT_ADVISORY_CONTRACT,
      recommendation: "cut",
      basis: "peer_free_commercial_stop_loss",
      confidenceCap: "medium",
      authority: "none",
      heldBy: "config_source_authority",
      asOfDate: facts.asOfDate,
      computedAt: facts.computedAt,
      engineVersion: facts.engineVersion,
      providerAccountId: facts.providerAccountId,
      adId: facts.adId,
      engineAuthorityBlocker:
        facts.engineAuthorityBlocker === "campaign_context" ? "campaign_context" : null,
      commercialTargetRoas: target,
      receiptManifestHash: manifest.hash,
      economicDayCount: economics.economicDayCount,
      bracketedDays: intent.bracketedDays,
      historicalObjectiveUnverifiedDays: intent.historicalObjectiveUnverifiedDays,
      pointObservedDays:
        stress.status === "evaluated" ? stress.detail.days.map((day) => ({ ...day })) : [],
      stress:
        stress.status === "evaluated"
          ? {
              purchaseValue: { ...stress.detail.purchaseValue },
              roas: { ...stress.detail.roas },
              recent7dRoas: stress.detail.recent7dRoas
                ? { ...stress.detail.recent7dRoas }
                : null,
              bands: [...stress.detail.bands],
            }
          : null,
    },
  };
}

/* ── serving-side revalidation ────────────────────────────────────────── */

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pair(value: unknown): { actual: number; stressed: number } | null {
  return isRecord(value) &&
    nonNegativeFinite(value.actual) &&
    nonNegativeFinite(value.stressed) &&
    value.stressed >= value.actual
    ? { actual: value.actual, stressed: value.stressed }
    : null;
}

/**
 * Structural and arithmetic revalidation of a persisted proof. It cannot
 * re-run the core; it checks that the proof is a well-formed, internally
 * consistent statement of this contract: every literal, every count, each
 * point day's stressed revenue recomputed from its own spend and the target,
 * and a stress block present exactly when point days exist. Anything else is
 * not a proof.
 */
export function parseNativeManualCutAdvisoryProof(
  value: unknown,
): NativeManualCutAdvisoryProof | null {
  if (!isRecord(value)) return null;
  const v = value;
  const count = (x: unknown): x is number =>
    typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
  if (
    v.contractVersion !== META_NATIVE_MANUAL_CUT_ADVISORY_CONTRACT ||
    v.recommendation !== "cut" ||
    v.basis !== "peer_free_commercial_stop_loss" ||
    v.confidenceCap !== "medium" ||
    v.authority !== "none" ||
    v.heldBy !== "config_source_authority" ||
    isoDay(v.asOfDate) === null || isoDay(v.asOfDate) !== v.asOfDate ||
    typeof v.computedAt !== "string" ||
    !Number.isFinite(Date.parse(v.computedAt)) ||
    typeof v.engineVersion !== "string" ||
    v.engineVersion === "" ||
    typeof v.providerAccountId !== "string" ||
    v.providerAccountId === "" ||
    typeof v.adId !== "string" ||
    v.adId === "" ||
    (v.engineAuthorityBlocker !== null && v.engineAuthorityBlocker !== "campaign_context") ||
    !nonNegativeFinite(v.commercialTargetRoas) ||
    v.commercialTargetRoas <= 0 ||
    typeof v.receiptManifestHash !== "string" ||
    !SHA256_HEX.test(v.receiptManifestHash) ||
    !count(v.economicDayCount) ||
    v.economicDayCount === 0 ||
    !count(v.bracketedDays) ||
    !count(v.historicalObjectiveUnverifiedDays) ||
    v.historicalObjectiveUnverifiedDays > v.economicDayCount ||
    !Array.isArray(v.pointObservedDays)
  ) {
    return null;
  }
  const target = v.commercialTargetRoas;
  const days: ManualCutStressDay[] = [];
  const seen = new Set<string>();
  for (const day of v.pointObservedDays as unknown[]) {
    if (!isRecord(day)) return null;
    const date = isoDay(day.date);
    if (
      date === null ||
      date !== day.date ||
      seen.has(date) ||
      !nonNegativeFinite(day.spend) ||
      !nonNegativeFinite(day.revenue) ||
      !nonNegativeFinite(day.stressedRevenue) ||
      day.stressedRevenue !== Math.max(day.revenue, day.spend * target)
    ) {
      return null;
    }
    seen.add(date);
    days.push({
      date,
      spend: day.spend,
      revenue: day.revenue,
      stressedRevenue: day.stressedRevenue,
    });
  }
  if (v.bracketedDays + days.length !== v.economicDayCount) return null;

  let stress: NativeManualCutAdvisoryProof["stress"] = null;
  if (days.length === 0) {
    if (v.stress !== null) return null;
  } else {
    if (!isRecord(v.stress)) return null;
    const purchaseValue = pair(v.stress.purchaseValue);
    const roas = pair(v.stress.roas);
    const recent = v.stress.recent7dRoas === null ? null : pair(v.stress.recent7dRoas);
    const bands = v.stress.bands;
    const totalDelta = days.reduce((sum, day) => sum + day.stressedRevenue - day.revenue, 0);
    if (
      purchaseValue === null ||
      roas === null ||
      (v.stress.recent7dRoas !== null && recent === null) ||
      !Array.isArray(bands) ||
      bands.some((band) => band !== "recent14" && band !== "prior14") ||
      new Set(bands).size !== bands.length ||
      Math.abs(purchaseValue.stressed - purchaseValue.actual - totalDelta) >
        SUM_TOLERANCE * Math.max(1, purchaseValue.stressed)
    ) {
      return null;
    }
    stress = {
      purchaseValue,
      roas,
      recent7dRoas: recent,
      bands: bands as Array<"recent14" | "prior14">,
    };
  }
  return {
    contractVersion: META_NATIVE_MANUAL_CUT_ADVISORY_CONTRACT,
    recommendation: "cut",
    basis: "peer_free_commercial_stop_loss",
    confidenceCap: "medium",
    authority: "none",
    heldBy: "config_source_authority",
    asOfDate: v.asOfDate as string,
    computedAt: v.computedAt,
    engineVersion: v.engineVersion,
    providerAccountId: v.providerAccountId,
    adId: v.adId,
    engineAuthorityBlocker: v.engineAuthorityBlocker as "campaign_context" | null,
    commercialTargetRoas: target,
    receiptManifestHash: v.receiptManifestHash,
    economicDayCount: v.economicDayCount,
    bracketedDays: v.bracketedDays,
    historicalObjectiveUnverifiedDays: v.historicalObjectiveUnverifiedDays,
    pointObservedDays: days,
    stress,
  };
}
