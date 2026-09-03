/**
 * Offline commercial-anchor counterfactual replay (corrected).
 *
 * Question: if an owner supplied a trustworthy commercial anchor, which
 * historical hard-action signals would stop being withheld — PER ACTION?
 *
 * Strictly offline. It reads the accepted frozen generalized PIT evidence,
 * verifies it byte-for-byte against its published SHA-256, and never contacts a
 * database, Meta, production or any network service. It never mutates the
 * accepted package.
 *
 * TWO CORRECTIONS THIS FILE EXISTS TO ENCODE
 * ------------------------------------------
 * 1. PER ACTION, NOT PER ROW. Clearing the common commercial threshold does not
 *    make a held Cut eligible: Cut additionally needs a break-even ROAS and
 *    Scale additionally needs a Target ROAS and a calibration sample. The
 *    earlier version counted every threshold-cleared row as unblocked, which
 *    claimed 291 unblocked rows for IwaTR when only its 9 held Refresh rows
 *    clear the full per-action gate and all 282 held Cuts remain blocked.
 *    Every outcome here is recomputed through the REAL production explanation
 *    (`resolveSpendUnit` + `resolveCommercialAnchorExplanation`).
 *
 * 2. NO FUTURE LEAKAGE. A target pack is resolved BITEMPORALLY as of each
 *    row's own origin: `effectiveAt <= cutoff AND recordedAt <= cutoff`. Every
 *    frozen pack was recorded on 2026-07-14 or later while decision origins
 *    start 2025-03-02, so borrowing the latest revision would apply values the
 *    system could not have known. A scenario may instead declare an explicit
 *    all-window hypothetical, in which case the paired ROAS values are required
 *    inputs and are included in the candidate hash.
 *
 * What it cannot do is stated, not guessed: the engine persists only the FIRST
 * blocker per row, and the frozen package carries no calibration state, so an
 * outcome that depends on either is emitted as
 * `not_determinable_from_frozen_evidence` by action and business. No revenue,
 * ROAS, profit or lift is derived from a structural eligibility change.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveCommercialAnchorExplanation } from "@/lib/creative-decision-engine/commercial-anchor";
import {
  classifyMetaAovQuality,
  resolveSpendUnit,
} from "@/lib/creative-decision-engine/spend-unit-resolver";

export const COMMERCIAL_ANCHOR_COUNTERFACTUAL_CONTRACT =
  "adsecute.meta.commercial-anchor-counterfactual.v2" as const;

export const ACCEPTED_EVIDENCE_PATH =
  "docs/audits/generated/generalized-pit-replay-evidence-2026-08-30.json";
export const ACCEPTED_EVIDENCE_SHA256 =
  "56f4472ba94363987a0c9854d3a20dbcd23a89dc9e9037f773e822e2be4ddfe1";

export const COUNTERFACTUAL_JSON_OUT =
  "docs/audits/generated/commercial-anchor-counterfactual-2026-08-31.json";

/** The production target reference instant used by the accepted replay. */
export const TARGET_REFERENCE_TIME_SUFFIX = "T03:00:00.000Z";

// ---------------------------------------------------------------------------
// Frozen-evidence shapes (only the fields this tool reads)
// ---------------------------------------------------------------------------

interface FrozenBusiness {
  businessId: string;
  name: string;
  currency: string | null;
}

interface FrozenAccount {
  businessId: string;
  providerAccountId: string;
  isSelected: boolean;
}

export interface FrozenTargetHistoryRow {
  businessId: string;
  id?: string | null;
  effectiveAt: string;
  recordedAt: string;
  operation: string;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
}

interface FrozenDecisionRow {
  businessId: string;
  providerAccountId: string | null;
  originDate: string;
  freshnessMode: string;
  label: string;
  blockedActionType: string | null;
  authorityBlocker: string | null;
  truthSource: string;
}

export interface FrozenEvidence {
  scope: { businesses: FrozenBusiness[]; accounts: FrozenAccount[] };
  targetHistory: FrozenTargetHistoryRow[];
  perOriginDecisions: FrozenDecisionRow[];
}

// ---------------------------------------------------------------------------
// Candidates and time semantics
// ---------------------------------------------------------------------------

export type CounterfactualTimeSemantics =
  /** Target/break-even ROAS resolved bitemporally as of each row's origin. */
  | "as_of_origin"
  /** The candidate declares the paired ROAS values for the whole window. */
  | "declared_all_window";

export interface CandidateAnchor {
  businessId: string;
  currency: string;
  sourceLabel: string;
  targetCpa?: number | null;
  operatorAovAssumption?: number | null;
  /** Required under `declared_all_window`; ignored under `as_of_origin`. */
  targetRoas?: number | null;
  breakEvenRoas?: number | null;
}

export class CandidateAnchorValidationError extends Error {
  readonly code = "invalid_candidate_anchor";
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.name = "CandidateAnchorValidationError";
    this.field = field;
  }
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validateCandidateAnchor(
  candidate: CandidateAnchor,
  evidence: FrozenEvidence,
  timeSemantics: CounterfactualTimeSemantics = "as_of_origin",
): { business: FrozenBusiness } {
  if (typeof candidate?.businessId !== "string" || !candidate.businessId) {
    throw new CandidateAnchorValidationError("businessId", "is required");
  }
  const business = evidence.scope.businesses.find(
    (entry) => entry.businessId === candidate.businessId,
  );
  if (!business) {
    throw new CandidateAnchorValidationError(
      "businessId",
      "is not present in the frozen evidence scope",
    );
  }
  if (
    typeof candidate.sourceLabel !== "string" ||
    !candidate.sourceLabel.trim()
  ) {
    throw new CandidateAnchorValidationError(
      "sourceLabel",
      "is required so a hypothetical can never be mistaken for an approved target",
    );
  }
  if (typeof candidate.currency !== "string" || !candidate.currency.trim()) {
    throw new CandidateAnchorValidationError("currency", "is required");
  }
  if (
    business.currency !== null &&
    candidate.currency.toUpperCase() !== business.currency.toUpperCase()
  ) {
    throw new CandidateAnchorValidationError(
      "currency",
      `is ${candidate.currency} but the frozen business currency is ${business.currency}`,
    );
  }

  const hasCpa =
    candidate.targetCpa !== undefined && candidate.targetCpa !== null;
  const hasAov =
    candidate.operatorAovAssumption !== undefined &&
    candidate.operatorAovAssumption !== null;
  if (!hasCpa && !hasAov) {
    throw new CandidateAnchorValidationError(
      "targetCpa|operatorAovAssumption",
      "at least one anchor is required",
    );
  }
  if (hasCpa && !positiveFinite(candidate.targetCpa)) {
    throw new CandidateAnchorValidationError(
      "targetCpa",
      "must be a finite number greater than zero",
    );
  }
  if (hasAov && !positiveFinite(candidate.operatorAovAssumption)) {
    throw new CandidateAnchorValidationError(
      "operatorAovAssumption",
      "must be a finite number greater than zero",
    );
  }
  if (timeSemantics === "declared_all_window") {
    // Every value the scenario resolves with must be an explicit, hashed input.
    // Borrowing a frozen revision here is exactly the future leakage this mode
    // exists to avoid.
    if (!positiveFinite(candidate.targetRoas)) {
      throw new CandidateAnchorValidationError(
        "targetRoas",
        "must be declared explicitly under declared_all_window semantics",
      );
    }
    if (!positiveFinite(candidate.breakEvenRoas)) {
      throw new CandidateAnchorValidationError(
        "breakEvenRoas",
        "must be declared explicitly under declared_all_window semantics",
      );
    }
  } else if (
    candidate.targetRoas !== undefined ||
    candidate.breakEvenRoas !== undefined
  ) {
    throw new CandidateAnchorValidationError(
      "targetRoas|breakEvenRoas",
      "must not be supplied under as_of_origin semantics; they are resolved bitemporally from the frozen history",
    );
  }
  return { business };
}

/**
 * Bitemporal resolution: a revision is knowable at an origin only when BOTH
 * its effective and its recorded instants precede the origin's cutoff.
 */
export function targetPackAsOfOrigin(
  evidence: FrozenEvidence,
  businessId: string,
  originDate: string,
): FrozenTargetHistoryRow | null {
  const cutoff = `${originDate}${TARGET_REFERENCE_TIME_SUFFIX}`;
  const knowable = evidence.targetHistory
    .filter(
      (row) =>
        row.businessId === businessId &&
        row.effectiveAt <= cutoff &&
        row.recordedAt <= cutoff,
    )
    .sort((left, right) =>
      left.effectiveAt === right.effectiveAt
        ? left.recordedAt === right.recordedAt
          ? String(left.id ?? "").localeCompare(String(right.id ?? ""))
          : left.recordedAt.localeCompare(right.recordedAt)
        : left.effectiveAt.localeCompare(right.effectiveAt),
    );
  const last = knowable[knowable.length - 1];
  if (!last || last.operation !== "upsert") return null;
  return last;
}

// ---------------------------------------------------------------------------
// Observed baseline (unchanged: it must keep reproducing the accepted counts)
// ---------------------------------------------------------------------------

export interface BaselineTotals {
  selectedHistoricalRows: number;
  heldHardSignals: number;
  profileHardActionIneligible: number;
  campaignContext: number;
  recentRecoveryUnverifiable: number;
  enabledHardActions: number;
}

export function selectedHistoricalRows(
  evidence: FrozenEvidence,
): FrozenDecisionRow[] {
  const selected = new Set(
    evidence.scope.accounts
      .filter((account) => account.isSelected)
      .map((account) => `${account.businessId}\u0000${account.providerAccountId}`),
  );
  return evidence.perOriginDecisions.filter(
    (row) =>
      row.freshnessMode === "historical" &&
      row.providerAccountId !== null &&
      selected.has(`${row.businessId}\u0000${row.providerAccountId}`),
  );
}

export function computeBaseline(rows: FrozenDecisionRow[]): BaselineTotals {
  const held = rows.filter((row) => row.blockedActionType !== null);
  return {
    selectedHistoricalRows: rows.length,
    heldHardSignals: held.length,
    profileHardActionIneligible: held.filter(
      (row) => row.authorityBlocker === "profile_hard_action_ineligible",
    ).length,
    campaignContext: held.filter(
      (row) => row.authorityBlocker === "campaign_context",
    ).length,
    recentRecoveryUnverifiable: held.filter(
      (row) => row.authorityBlocker === "recent_recovery_unverifiable",
    ).length,
    enabledHardActions: rows.filter(
      (row) =>
        ["cut", "scale", "refresh"].includes(row.label) &&
        row.blockedActionType === null,
    ).length,
  };
}

// ---------------------------------------------------------------------------
// Per-action counterfactual
// ---------------------------------------------------------------------------

export type CounterfactualAction = "scale" | "cut" | "refresh";

/** The outcome of one held row under the candidate, for its own action. */
export type RowOutcome =
  | "eligible_after"
  | "still_blocked"
  | "not_determinable_from_frozen_evidence"
  | "no_candidate_supplied";

/**
 * A COMPLETE partition of one action's held rows.
 *
 * The invariant every row and every total must satisfy:
 *
 *   heldBefore = eligibleAfter
 *              + blockedByEffectiveProfileCodeTotal
 *              + blockedNoCandidate
 *              + blockedNotDeterminable
 *              + blockedByCampaignContext
 *              + blockedByRecentRecoveryUnverifiable
 *              + blockedByOtherIndependentGate
 *
 * The buckets are mutually exclusive and are chosen by the row's PERSISTED
 * first blocker, so nothing is double counted and an independent-gate row is
 * never recast as a commercial-anchor transition.
 */
export interface ActionOutcomeBreakdown {
  action: CounterfactualAction;
  /** Every held row was withheld before; the persisted blocker is the fact. */
  heldBefore: number;
  eligibleBefore: number;
  eligibleAfter: number;
  /** Unambiguous: heldBefore - eligibleAfter. The whole blocked population. */
  blockedAfterTotal: number;
  /**
   * Rows whose persisted first blocker was `profile_hard_action_ineligible`
   * and which the candidate still cannot clear, by the effective code the real
   * explanation produced. This is a NARROW bucket, never the blocked total.
   */
  blockedByEffectiveProfileCode: Record<string, number>;
  blockedByEffectiveProfileCodeTotal: number;
  blockedNoCandidate: number;
  blockedNotDeterminable: number;
  notDeterminableReasons: Record<string, number>;
  /** Independent gates: an anchor cannot move these, in either direction. */
  blockedByCampaignContext: number;
  blockedByRecentRecoveryUnverifiable: number;
  blockedByOtherIndependentGate: number;
  /** Explicit `<persisted first blocker>-><after outcome>` counts. */
  codeTransitions: Record<string, number>;
  /** True when the invariant above holds for this row. */
  partitionComplete: boolean;
}

export interface BusinessActionTransitions {
  businessId: string;
  businessName: string;
  currency: string | null;
  candidateSupplied: boolean;
  /** The revisions the bitemporal resolution actually consumed. */
  resolvedTargetRevisions: Array<{
    effectiveAt: string;
    recordedAt: string;
    targetRoas: number | null;
    breakEvenRoas: number | null;
    originsUsing: number;
  }>;
  originsWithNoKnowableTargetPack: number;
  byAction: ActionOutcomeBreakdown[];
  /** Rows whose FIRST blocker was an independent gate; untouched by an anchor. */
  blockedByIndependentGate: {
    campaignContext: number;
    recentRecoveryUnverifiable: number;
  };
}

export interface CounterfactualScenario {
  scenarioId: string;
  kind: "baseline" | "candidate" | "sensitivity";
  inputClass:
    | "observed_frozen_fact"
    | "declared_candidate"
    | "illustrative_sensitivity_input";
  timeSemantics: CounterfactualTimeSemantics;
  candidates: CandidateAnchor[];
  totals: BaselineTotals;
  byBusiness: BusinessActionTransitions[];
  totalsByAction: ActionOutcomeBreakdown[];
  /** Deliberately NOT a single headline number; see the honesty block. */
  eligibleAfterTotal: number;
  /** heldBefore - eligibleAfter, summed. The whole blocked population. */
  blockedAfterTotal: number;
  partitionComplete: boolean;
  notes: string[];
}

export interface CounterfactualArtifact {
  contract: typeof COMMERCIAL_ANCHOR_COUNTERFACTUAL_CONTRACT;
  evidencePath: string;
  evidenceSha256: string;
  candidateInputsSha256: string;
  honesty: string[];
  scenarios: CounterfactualScenario[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
    }
    return entry;
  });
}

function emptyBreakdown(action: CounterfactualAction): ActionOutcomeBreakdown {
  return {
    action,
    heldBefore: 0,
    eligibleBefore: 0,
    eligibleAfter: 0,
    blockedAfterTotal: 0,
    blockedByEffectiveProfileCode: {},
    blockedByEffectiveProfileCodeTotal: 0,
    blockedNoCandidate: 0,
    blockedNotDeterminable: 0,
    notDeterminableReasons: {},
    blockedByCampaignContext: 0,
    blockedByRecentRecoveryUnverifiable: 0,
    blockedByOtherIndependentGate: 0,
    codeTransitions: {},
    partitionComplete: true,
  };
}

function bump(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

/** Recomputes the derived fields and checks the partition invariant. */
function sealBreakdown(entry: ActionOutcomeBreakdown): ActionOutcomeBreakdown {
  entry.blockedByEffectiveProfileCodeTotal = Object.values(
    entry.blockedByEffectiveProfileCode,
  ).reduce((sum, count) => sum + count, 0);
  entry.blockedAfterTotal = entry.heldBefore - entry.eligibleAfter;
  const accounted =
    entry.eligibleAfter +
    entry.blockedByEffectiveProfileCodeTotal +
    entry.blockedNoCandidate +
    entry.blockedNotDeterminable +
    entry.blockedByCampaignContext +
    entry.blockedByRecentRecoveryUnverifiable +
    entry.blockedByOtherIndependentGate;
  entry.partitionComplete = accounted === entry.heldBefore;
  return entry;
}

/**
 * Evaluates ONE action under the candidate through the real explanation.
 *
 * `calibrationReady` is unknown in the frozen package, so the explanation is
 * computed under both values; a disagreement means the outcome depends on
 * evidence the package does not contain.
 */
function evaluateAction(input: {
  action: CounterfactualAction;
  candidate: CandidateAnchor;
  targetRoas: number | null;
  breakEvenRoas: number | null;
}): { outcome: RowOutcome; blockerCode: string | null; reason: string | null } {
  const resolution = resolveSpendUnit({
    targetCpa: input.candidate.targetCpa ?? null,
    operatorAovAssumption: input.candidate.operatorAovAssumption ?? null,
    // Calibration-derived rungs are deliberately withheld: a candidate anchor
    // must clear the gate on its own merits, never by borrowing a sampled or
    // account-history rung that is not owner truth.
    metaAttributedAovMean90d: null,
    metaAttributedAovPurchaseCount90d: 0,
    metaAttributedRevenue90d: 0,
    targetRoas: input.targetRoas,
    breakEvenRoas: input.breakEvenRoas,
    accountCpaP50: null,
    accountCpaSampleCount: 0,
    attributionAovAdjustmentMultiplier: 1,
  });
  const metaAovQuality = classifyMetaAovQuality(0);
  const thresholdEligible =
    resolution.hardEligibleByDefault &&
    (resolution.confidence === "high" ||
      (resolution.confidence === "medium" && metaAovQuality === "ready"));

  const explain = (calibrationReady: boolean) =>
    resolveCommercialAnchorExplanation({
      shadowOnly: false,
      thresholdEligible,
      provenanceUnverified: false,
      scaleAnchorEligible: positiveFinite(input.targetRoas),
      cutAnchorEligible: positiveFinite(input.breakEvenRoas),
      calibrationReady,
      spendUnit: resolution.spendUnit,
      spendUnitSource: resolution.source,
      spendUnitConfidence: resolution.confidence,
      metaAovQuality,
      currency: input.candidate.currency,
      targetPackFreshness: null,
      targetPackUpdatedAt: null,
      lineage: {
        targetCpa: input.candidate.targetCpa ?? null,
        operatorAovAssumption: input.candidate.operatorAovAssumption ?? null,
        targetRoas: input.targetRoas,
        breakEvenRoas: input.breakEvenRoas,
        metaAttributedAovMean90d: null,
        metaAttributedAovPurchaseCount90d: 0,
        attributionAovAdjustmentMultiplier: 1,
      },
    });

  const withCalibration = explain(true).actions[input.action];
  const withoutCalibration = explain(false).actions[input.action];
  if (withCalibration.eligible !== withoutCalibration.eligible) {
    return {
      outcome: "not_determinable_from_frozen_evidence",
      blockerCode: null,
      reason: "account_calibration_state_absent_from_frozen_package",
    };
  }
  if (withCalibration.eligible) {
    return { outcome: "eligible_after", blockerCode: null, reason: null };
  }
  return {
    outcome: "still_blocked",
    blockerCode: withCalibration.blockerCode,
    reason: null,
  };
}

export function runScenario(input: {
  scenarioId: string;
  kind: CounterfactualScenario["kind"];
  inputClass: CounterfactualScenario["inputClass"];
  timeSemantics: CounterfactualTimeSemantics;
  candidates: CandidateAnchor[];
  evidence: FrozenEvidence;
}): CounterfactualScenario {
  for (const candidate of input.candidates) {
    validateCandidateAnchor(candidate, input.evidence, input.timeSemantics);
  }
  const rows = selectedHistoricalRows(input.evidence);
  const totals = computeBaseline(rows);
  const byBusiness: BusinessActionTransitions[] = [];
  const totalsByAction: Record<CounterfactualAction, ActionOutcomeBreakdown> = {
    scale: emptyBreakdown("scale"),
    cut: emptyBreakdown("cut"),
    refresh: emptyBreakdown("refresh"),
  };

  for (const business of [...input.evidence.scope.businesses].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const candidate = input.candidates.find(
      (entry) => entry.businessId === business.businessId,
    );
    const businessRows = rows.filter(
      (row) => row.businessId === business.businessId,
    );
    const held = businessRows.filter((row) => row.blockedActionType !== null);
    const perAction: Record<CounterfactualAction, ActionOutcomeBreakdown> = {
      scale: emptyBreakdown("scale"),
      cut: emptyBreakdown("cut"),
      refresh: emptyBreakdown("refresh"),
    };
    const revisionUse = new Map<
      string,
      {
        effectiveAt: string;
        recordedAt: string;
        targetRoas: number | null;
        breakEvenRoas: number | null;
        originsUsing: number;
      }
    >();
    let originsWithNoKnowableTargetPack = 0;

    for (const row of held) {
      const action = row.blockedActionType as CounterfactualAction;
      if (!["scale", "cut", "refresh"].includes(action)) continue;
      const bucket = perAction[action];
      // Every held row was ineligible before; that is the persisted fact.
      bucket.heldBefore += 1;

      const persisted = row.authorityBlocker ?? "unknown";
      if (persisted !== "profile_hard_action_ineligible") {
        // An independent gate fired first. An anchor cannot move it and the
        // frozen package does not record what the threshold gate would have
        // said, so the row stays an INDEPENDENT-GATE outcome — counted, never
        // recast as a commercial-anchor transition.
        if (persisted === "campaign_context") bucket.blockedByCampaignContext += 1;
        else if (persisted === "recent_recovery_unverifiable")
          bucket.blockedByRecentRecoveryUnverifiable += 1;
        else bucket.blockedByOtherIndependentGate += 1;
        bump(bucket.codeTransitions, `${persisted}->${persisted}`);
        continue;
      }
      if (!candidate) {
        bucket.blockedNoCandidate += 1;
        bump(bucket.codeTransitions, `${persisted}->no_candidate_supplied`);
        continue;
      }

      let targetRoas: number | null;
      let breakEvenRoas: number | null;
      if (input.timeSemantics === "declared_all_window") {
        targetRoas = candidate.targetRoas ?? null;
        breakEvenRoas = candidate.breakEvenRoas ?? null;
      } else {
        const pack = targetPackAsOfOrigin(
          input.evidence,
          business.businessId,
          row.originDate,
        );
        targetRoas = pack?.targetRoas ?? null;
        breakEvenRoas = pack?.breakEvenRoas ?? null;
        if (!pack) {
          originsWithNoKnowableTargetPack += 1;
        } else {
          const key = `${pack.effectiveAt}\u0000${pack.recordedAt}`;
          const seen = revisionUse.get(key);
          if (seen) seen.originsUsing += 1;
          else
            revisionUse.set(key, {
              effectiveAt: pack.effectiveAt,
              recordedAt: pack.recordedAt,
              targetRoas: pack.targetRoas,
              breakEvenRoas: pack.breakEvenRoas,
              originsUsing: 1,
            });
        }
      }

      const evaluated = evaluateAction({
        action,
        candidate,
        targetRoas,
        breakEvenRoas,
      });
      if (evaluated.outcome === "eligible_after") {
        bucket.eligibleAfter += 1;
        bump(bucket.codeTransitions, `${persisted}->eligible`);
      } else if (
        evaluated.outcome === "not_determinable_from_frozen_evidence"
      ) {
        bucket.blockedNotDeterminable += 1;
        const reason = evaluated.reason ?? "unknown";
        bump(bucket.notDeterminableReasons, reason);
        bump(
          bucket.codeTransitions,
          `${persisted}->not_determinable_from_frozen_evidence`,
        );
      } else {
        const code = evaluated.blockerCode ?? "unknown";
        bump(bucket.blockedByEffectiveProfileCode, code);
        bump(bucket.codeTransitions, `${persisted}->${code}`);
      }
    }

    for (const action of ["scale", "cut", "refresh"] as const) {
      const from = perAction[action];
      const into = totalsByAction[action];
      into.heldBefore += from.heldBefore;
      into.eligibleAfter += from.eligibleAfter;
      into.blockedNoCandidate += from.blockedNoCandidate;
      into.blockedNotDeterminable += from.blockedNotDeterminable;
      into.blockedByCampaignContext += from.blockedByCampaignContext;
      into.blockedByRecentRecoveryUnverifiable +=
        from.blockedByRecentRecoveryUnverifiable;
      into.blockedByOtherIndependentGate += from.blockedByOtherIndependentGate;
      for (const [code, count] of Object.entries(
        from.blockedByEffectiveProfileCode,
      )) {
        bump(into.blockedByEffectiveProfileCode, code, count);
      }
      for (const [reason, count] of Object.entries(
        from.notDeterminableReasons,
      )) {
        bump(into.notDeterminableReasons, reason, count);
      }
      for (const [key, count] of Object.entries(from.codeTransitions)) {
        bump(into.codeTransitions, key, count);
      }
      sealBreakdown(from);
    }

    byBusiness.push({
      businessId: business.businessId,
      businessName: business.name,
      currency: business.currency,
      candidateSupplied: Boolean(candidate),
      resolvedTargetRevisions: [...revisionUse.values()].sort((a, b) =>
        a.effectiveAt.localeCompare(b.effectiveAt),
      ),
      originsWithNoKnowableTargetPack,
      byAction: [perAction.scale, perAction.cut, perAction.refresh].map(
        sealBreakdown,
      ),
      blockedByIndependentGate: {
        campaignContext: held.filter(
          (row) => row.authorityBlocker === "campaign_context",
        ).length,
        recentRecoveryUnverifiable: held.filter(
          (row) => row.authorityBlocker === "recent_recovery_unverifiable",
        ).length,
      },
    });
  }

  const actionTotals = [
    totalsByAction.scale,
    totalsByAction.cut,
    totalsByAction.refresh,
  ].map(sealBreakdown);
  return {
    scenarioId: input.scenarioId,
    kind: input.kind,
    inputClass: input.inputClass,
    timeSemantics: input.timeSemantics,
    candidates: input.candidates,
    totals,
    byBusiness,
    totalsByAction: actionTotals,
    eligibleAfterTotal: actionTotals.reduce(
      (sum, entry) => sum + entry.eligibleAfter,
      0,
    ),
    blockedAfterTotal: actionTotals.reduce(
      (sum, entry) => sum + entry.blockedAfterTotal,
      0,
    ),
    // True only when EVERY business/action row and every total partitions
    // exactly. A false here means the artifact is not to be read.
    partitionComplete:
      actionTotals.every((entry) => entry.partitionComplete) &&
      byBusiness.every((entry) =>
        entry.byAction.every((action) => action.partitionComplete),
      ),
    notes: [
      "Every held row is recomputed for ITS OWN action. Clearing the common commercial threshold does not make a held Cut eligible; Cut additionally needs a break-even ROAS and Scale a Target ROAS plus a calibration sample.",
      input.timeSemantics === "as_of_origin"
        ? "Target and break-even ROAS are resolved bitemporally as of each row's origin (effectiveAt AND recordedAt at or before the origin's 03:00Z cutoff). No later revision is applied to an earlier row."
        : "Target and break-even ROAS are explicit all-window hypotheticals supplied by the candidate and included in the candidate hash. They are NOT frozen facts.",
      "Rows whose first persisted blocker was campaign context or recovery-unverifiability are reported separately and are never counted as anchor transitions: the frozen package does not record what the threshold gate would have said for them.",
      "A row's persisted blocker is `profile_hard_action_ineligible`, a first-blocker FAMILY that also covers scale calibration. This tool never restates it as a specific anchor sub-cause; only the AFTER state carries a canonical code.",
      "Every action row partitions completely: heldBefore = eligibleAfter + blockedByEffectiveProfileCodeTotal + blockedNoCandidate + blockedNotDeterminable + blockedByCampaignContext + blockedByRecentRecoveryUnverifiable + blockedByOtherIndependentGate. `blockedAfterTotal` is heldBefore - eligibleAfter; no narrower bucket may be read as the blocked population.",
    ],
  };
}

export function loadFrozenEvidence(path = ACCEPTED_EVIDENCE_PATH): {
  evidence: FrozenEvidence;
  sha256: string;
} {
  const bytes = readFileSync(resolve(path));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== ACCEPTED_EVIDENCE_SHA256) {
    throw new Error(
      `frozen evidence hash mismatch — refusing to replay against an unaccepted package (expected ${ACCEPTED_EVIDENCE_SHA256}, got ${digest})`,
    );
  }
  return {
    evidence: JSON.parse(bytes.toString("utf8")) as FrozenEvidence,
    sha256: digest,
  };
}

export function buildCounterfactualArtifact(input: {
  evidenceSha256: string;
  scenarios: CounterfactualScenario[];
}): CounterfactualArtifact {
  return {
    contract: COMMERCIAL_ANCHOR_COUNTERFACTUAL_CONTRACT,
    evidencePath: ACCEPTED_EVIDENCE_PATH,
    evidenceSha256: input.evidenceSha256,
    // Every resolved input a scenario decided with is part of its identity:
    // the candidates, and the time semantics that determine whether any ROAS
    // was borrowed from frozen history or declared outright.
    candidateInputsSha256: sha256(
      canonical(
        input.scenarios.map((scenario) => ({
          scenarioId: scenario.scenarioId,
          timeSemantics: scenario.timeSemantics,
          candidates: scenario.candidates,
          resolvedTargetRevisions: scenario.byBusiness.map((entry) => ({
            businessId: entry.businessId,
            revisions: entry.resolvedTargetRevisions,
          })),
        })),
      ),
    ),
    honesty: [
      "Every candidate anchor is a declared INPUT, never a recommendation and never an approved business target. Nothing here is persisted.",
      "Outcomes are recomputed PER ACTION through the real production explanation. There is no single 'rows unblocked' number, because clearing the commercial threshold does not clear Cut's break-even requirement or Scale's calibration requirement.",
      "Target and break-even ROAS are resolved bitemporally as of each row's origin unless a scenario declares all-window hypotheticals, which are then part of the candidate hash. No later target revision is ever applied to an earlier row.",
      "An outcome that depends on account calibration state is emitted as not_determinable_from_frozen_evidence, by action and business, because the frozen package does not carry it.",
      "Rows blocked first by campaign context or recovery-unverifiability are reported separately and never counted as anchor transitions.",
      "No revenue, ROAS, profit or lift is derived from a structural eligibility change.",
      "Whether an owner-supplied anchor is economically CORRECT is an irreducible unknown that no replay can settle.",
      "No wall-clock time is included, so repeated identical runs are byte-identical.",
    ],
    scenarios: input.scenarios,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const SENSITIVITY_MULTIPLIERS = [0.5, 1, 2] as const;

async function main() {
  const rawArg = process.argv[2] ?? null;
  const { evidence, sha256: evidenceSha256 } = loadFrozenEvidence();

  const scenarios: CounterfactualScenario[] = [
    runScenario({
      scenarioId: "no_anchor_baseline",
      kind: "baseline",
      inputClass: "observed_frozen_fact",
      timeSemantics: "as_of_origin",
      candidates: [],
      evidence,
    }),
  ];

  if (rawArg) {
    const parsed = JSON.parse(readFileSync(resolve(rawArg), "utf8")) as {
      candidates: CandidateAnchor[];
      timeSemantics?: CounterfactualTimeSemantics;
    };
    const timeSemantics = parsed.timeSemantics ?? "as_of_origin";
    const candidates = parsed.candidates ?? [];
    scenarios.push(
      runScenario({
        scenarioId: `declared_candidate_anchors__${timeSemantics}`,
        kind: "candidate",
        inputClass: "declared_candidate",
        timeSemantics,
        candidates,
        evidence,
      }),
    );
    for (const multiplier of SENSITIVITY_MULTIPLIERS) {
      scenarios.push(
        runScenario({
          scenarioId: `sensitivity_x${multiplier}__${timeSemantics}`,
          kind: "sensitivity",
          inputClass: "illustrative_sensitivity_input",
          timeSemantics,
          candidates: candidates.map((candidate) => ({
            ...candidate,
            sourceLabel: `${candidate.sourceLabel}__illustrative_x${multiplier}`,
            targetCpa:
              candidate.targetCpa == null
                ? candidate.targetCpa
                : candidate.targetCpa * multiplier,
            operatorAovAssumption:
              candidate.operatorAovAssumption == null
                ? candidate.operatorAovAssumption
                : candidate.operatorAovAssumption * multiplier,
          })),
          evidence,
        }),
      );
    }
  }

  const artifact = buildCounterfactualArtifact({ evidenceSha256, scenarios });
  writeFileSync(
    resolve(COUNTERFACTUAL_JSON_OUT),
    JSON.stringify(artifact, null, 1),
  );
  console.log(
    JSON.stringify(
      {
        phase: "commercial-anchor-counterfactual",
        evidenceSha256,
        candidateInputsSha256: artifact.candidateInputsSha256,
        artifactSha256: sha256(JSON.stringify(artifact, null, 1)),
        baseline: artifact.scenarios[0]?.totals,
        scenarios: artifact.scenarios.map((scenario) => ({
          scenarioId: scenario.scenarioId,
          timeSemantics: scenario.timeSemantics,
          eligibleAfterTotal: scenario.eligibleAfterTotal,
          blockedAfterTotal: scenario.blockedAfterTotal,
          partitionComplete: scenario.partitionComplete,
          byAction: scenario.totalsByAction.map((entry) => ({
            action: entry.action,
            heldBefore: entry.heldBefore,
            eligibleAfter: entry.eligibleAfter,
            blockedAfterTotal: entry.blockedAfterTotal,
            blockedByEffectiveProfileCode: entry.blockedByEffectiveProfileCode,
            blockedNoCandidate: entry.blockedNoCandidate,
            blockedNotDeterminable: entry.blockedNotDeterminable,
            blockedByCampaignContext: entry.blockedByCampaignContext,
            blockedByRecentRecoveryUnverifiable:
              entry.blockedByRecentRecoveryUnverifiable,
            blockedByOtherIndependentGate: entry.blockedByOtherIndependentGate,
            partitionComplete: entry.partitionComplete,
          })),
        })),
      },
      null,
      1,
    ),
  );
}

if (
  process.argv[1] &&
  process.argv[1].includes("commercial-anchor-counterfactual")
) {
  void main();
}
