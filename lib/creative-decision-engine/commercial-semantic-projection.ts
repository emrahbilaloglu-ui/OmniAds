/**
 * WHAT AN IDENTITY IS ALLOWED TO SEE OF THE COMMERCIAL TRUTH.
 *
 * Three different hash families digest the operator's commercial settings: the
 * canonical evaluation context (`canonical-evaluation.ts`), the native
 * authority/spend/generation/cell hashes (`jobs/ad-calibration-job.ts`), and
 * the D086 retention fingerprints (`lib/meta/account-profile-output-producer.ts`).
 * Each enumerated its own field list, and all three enumerated the same
 * non-authoritative numbers.
 *
 * THE DEFECT THAT PRODUCES. When a Target ROAS exists, the canonical rule
 * admits exactly one authoritative spend unit — ready Meta platform-attributed
 * AOV over that ratio — and a Target CPA, a break-even CPA and an operator AOV
 * assumption choose nothing. They were nonetheless hashed, so typing a Target
 * CPA on an account already governed by its Target ROAS moved the evaluation
 * identity, the native generation identity and the D086 `input_fingerprint` at
 * once. The retained verdict then failed its own agreement check
 * (`retained_profile_input_mismatch`) and was discarded and re-minted, for an
 * edit that could not have changed the decision.
 *
 * DROPPING THE NUMBERS IS NOT ENOUGH. `updatedAt` and `freshness` travel with
 * the same target pack, and they move whenever ANY field on it is re-saved. A
 * projection that removed `targetCpa` but kept the row's timestamp would still
 * change every hash on a CPA-only edit — the identity would just have stopped
 * saying why. So the timestamp is projected out in the same case, and what
 * remains is the set of facts that can actually change the verdict.
 *
 * VERSION-SCOPED, NOT UNCONDITIONAL. Without a Target ROAS the legacy Target
 * CPA is the only anchor there is and it legitimately governs, so in that case
 * the full pack — CPA, break-even CPA, operator AOV, timestamp and freshness —
 * is preserved exactly as it was hashed before. That is the compatibility half
 * of the rule, and it is why callers must pass the version they are minting
 * for: a historical row hashed under an older contract is re-verified with the
 * projection that produced it, never with this one.
 */

import {
  type CommercialTargetInstantBoundary,
  isCommercialTargetInstant,
  isCommercialTargetInstantWithinCutoff,
} from "@/lib/meta/commercial-target-instant";
import type { MetaAttributedAovResult } from "./meta-aov-calculator";
import { classifyMetaAovQuality } from "./spend-unit-resolver";
import type { MetaAovQuality } from "./types";

/** The commercial fields any of the three hash families may read. */
export interface CommercialTargetPackFacts {
  targetCpa?: number | null;
  targetRoas?: number | null;
  breakEvenCpa?: number | null;
  breakEvenRoas?: number | null;
  operatorAovAssumption?: number | null;
  defaultRiskPosture?: string | null;
  updatedAt?: string | null;
  freshness?: string | null;
}

function positive(value: unknown): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

/**
 * Does a Target ROAS govern this account?
 *
 * The single predicate every projection below branches on, so the three hash
 * families cannot disagree about which case an account is in.
 */
export function targetRoasGoverns(
  pack: CommercialTargetPackFacts | null | undefined,
): boolean {
  return positive(pack?.targetRoas);
}

/** The legacy calibration fields the account-profile resolver may fall back to. */
export interface MetaAovCalibrationFacts {
  metaAttributedAovMean90d: number | null;
  metaAttributedAovPurchaseCount90d: number;
  metaAttributedRevenue90d: number;
  metaAovQuality: MetaAovQuality;
}

/**
 * Whether resolving this profile will consult the strict physical-account AOV.
 *
 * This is shared by the resolver and retained-profile reader so a captured
 * observation cannot be marked unused while the resolver reaches for it (or be
 * queried eagerly while legacy compatibility genuinely supplies the value).
 */
export function shouldReadStrictMetaAov(
  pack: CommercialTargetPackFacts | null | undefined,
  calibration: MetaAovCalibrationFacts,
): boolean {
  return targetRoasGoverns(pack)
    || calibration.metaAttributedAovMean90d === null
    || calibration.metaAttributedAovPurchaseCount90d === 0;
}

/**
 * The exact Meta-AOV values the account-profile resolver uses.
 *
 * With a Target ROAS, only the strict finalized/cutoff-safe observation may
 * supply these fields; an absent or failed observation projects to the same
 * fail-closed empty semantics the resolver uses. Without a Target ROAS, the
 * legacy calibration remains first and the strict observation is only its
 * historical fallback. The derived quality travels with the values because it
 * changes eligibility even when the mean itself does not.
 */
export function projectEffectiveMetaAovSemantics(input: {
  targetPack: CommercialTargetPackFacts | null | undefined;
  calibration: MetaAovCalibrationFacts;
  strictMetaAov: MetaAttributedAovResult | null;
}): MetaAovCalibrationFacts {
  const targetRoasRequiresStrictAov = targetRoasGoverns(input.targetPack);
  const strict = input.strictMetaAov;
  const metaAttributedAovMean90d = targetRoasRequiresStrictAov
    ? strict?.aovMean ?? null
    : input.calibration.metaAttributedAovMean90d ?? strict?.aovMean ?? null;
  const metaAttributedAovPurchaseCount90d = targetRoasRequiresStrictAov
    ? strict?.purchaseCount ?? 0
    : input.calibration.metaAttributedAovPurchaseCount90d
      || strict?.purchaseCount
      || 0;
  const metaAttributedRevenue90d = targetRoasRequiresStrictAov
    ? strict?.totalRevenue ?? 0
    : input.calibration.metaAttributedRevenue90d
      || strict?.totalRevenue
      || 0;
  const metaAovQuality = targetRoasRequiresStrictAov
    ? classifyMetaAovQuality(metaAttributedAovPurchaseCount90d)
    : input.calibration.metaAovQuality !== "unavailable"
      ? input.calibration.metaAovQuality
      : classifyMetaAovQuality(metaAttributedAovPurchaseCount90d);

  return {
    metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d,
    metaAttributedRevenue90d,
    metaAovQuality,
  };
}

/**
 * The commercial facts an identity may digest.
 *
 * With a Target ROAS: the ratios, the risk posture, and explicit nulls where
 * the non-authoritative numbers used to be. The nulls are deliberate — a field
 * REMOVED from the object would make this projection's own shape depend on the
 * case, and two shapes hash differently for reasons unrelated to the account.
 * Stating them as null keeps one shape and says "this was not read".
 *
 * Without one: everything, unchanged, because the legacy CPA is the anchor.
 */
export function projectCommercialTargetPackForIdentity(
  pack: CommercialTargetPackFacts | null | undefined,
  /** The deterministic cutoff, threaded to `commercialTargetProvenanceState`. */
  cutoff?: CommercialTargetInstantBoundary | null,
): Record<string, unknown> | null {
  if (!pack) return null;
  if (!targetRoasGoverns(pack)) {
    return {
      targetCpa: pack.targetCpa ?? null,
      targetRoas: pack.targetRoas ?? null,
      breakEvenCpa: pack.breakEvenCpa ?? null,
      breakEvenRoas: pack.breakEvenRoas ?? null,
      operatorAovAssumption: pack.operatorAovAssumption ?? null,
      defaultRiskPosture: pack.defaultRiskPosture ?? null,
      updatedAt: pack.updatedAt ?? null,
      freshness: pack.freshness ?? null,
    };
  }
  return {
    targetCpa: null,
    targetRoas: pack.targetRoas ?? null,
    breakEvenCpa: null,
    breakEvenRoas: pack.breakEvenRoas ?? null,
    operatorAovAssumption: null,
    defaultRiskPosture: pack.defaultRiskPosture ?? null,
    /*
      The row's own clock and freshness label move on any re-save, including a
      CPA-only one, so their RAW values are not read in this case. The ROAS
      values above are what can change the verdict, and they are hashed
      directly.
    */
    updatedAt: null,
    /*
      BUT PROVENANCE IS NOT A TIMESTAMP, AND NULLING BOTH LOST IT.

      Removing `freshness` outright made every provenance state hash the same,
      and provenance changes what the engine is allowed to do:
      `resolveSpendUnitProfile` demotes `spendUnitConfidence` to `low` when the
      pack carries no trustworthy timestamp, which turns
      `commercialThresholdEligible` off — the account stops being hard-action
      eligible. An identity that could not see that would let a verdict minted
      while the pack was trusted be RETAINED after its provenance became
      unknown, which is a stale grant of authority rather than a stale number.

      So the raw values stay out and the SEMANTIC state goes in. It moves only
      when the provenance verdict itself moves, so a valid re-save that merely
      advances the timestamp leaves identity untouched while
      trusted -> stale/unknown does not.
    */
    freshness: null,
    targetProvenanceTrusted: commercialTargetProvenanceState(pack, cutoff),
  };
}

/** The provenance states an identity distinguishes. */
export type CommercialTargetProvenanceState = "trusted" | "stale" | "unknown";

/**
 * The provenance verdict, derived from the same two facts
 * `resolveSpendUnitProfile` derives `commercialTruthTimestampTrusted` from.
 *
 * `unknown` — the pack's freshness could not be established, or its timestamp
 * is absent/unparseable. This is the state that demotes confidence and closes
 * the hard-action gate, so it must never share a digest with `trusted`.
 * `stale` — a real, parseable timestamp that has aged past the freshness bar.
 * Authority survives it; a warning is raised. Kept distinct so an identity can
 * tell "old but known" from "not known at all".
 * `trusted` — everything else.
 */
export function commercialTargetProvenanceState(
  pack: CommercialTargetPackFacts | null | undefined,
  /**
   * The deterministic cutoff this identity is being built AS OF. Production
   * callers supply the original strict timestamp so sub-millisecond ordering
   * remains visible; integer epoch milliseconds remain a compatibility input.
   *
   * ── ROUND 9 ITEM 2 ───────────────────────────────────────────────────────
   * Optional only so callers that genuinely have no point-in-time context
   * (pure projection unit tests) keep compiling; every PRODUCTION caller passes
   * it. Without it this asked about FORMAT alone, so a pack saved after the day
   * being reconstructed digested as `trusted` — and a retained verdict then
   * kept an authority grant justified by evidence that did not exist yet.
   */
  cutoff?: CommercialTargetInstantBoundary | null,
): CommercialTargetProvenanceState {
  const updatedAt = pack?.updatedAt ?? null;
  /*
    STRICT, because this predicate IS the identity.

    `Date.parse` accepted `2026-02-30`, a date-only string and a naked local
    time, so a pack whose clock is unusable digested as `trusted` — and a
    retained verdict then kept an authority grant that its own provenance no
    longer supports. The shared validator constructs the instant from the
    literal calendar fields, so a rolled-over date is `unknown` here, which is
    the state that closes the hard-action gate.
  */
  const timestampUsable =
    isCommercialTargetInstant(updatedAt) &&
    (cutoff === null || cutoff === undefined
      ? true
      : isCommercialTargetInstantWithinCutoff(updatedAt, cutoff));
  const freshness = pack?.freshness ?? null;
  if (!timestampUsable || freshness === "unknown" || freshness === null) {
    return "unknown";
  }
  if (freshness === "stale") return "stale";
  return "trusted";
}

/**
 * The account's own measured cost-per-purchase, as an identity may see it.
 *
 * `accountCpaP50` / `accountCpaSampleCount` used to be hashed unconditionally,
 * and the reason recorded in `canonical-evaluation.ts` was explicit: under a
 * Target ROAS with an unusable Meta AOV the ladder FELL THROUGH to the
 * `account_history` rung, so the account's median CPA could still choose the
 * spend unit and was genuinely verdict-bearing.
 *
 * That fall-through no longer exists. `resolveSpendUnit` returns
 * `insufficient` in the governed branch rather than continuing to the soft
 * rungs, so with a positive Target ROAS the account CPA chooses nothing — not
 * the unit, not the thresholds built from it, not the eligibility. Evidence
 * that chooses nothing must not move identity, or a re-measured CPA discards a
 * retained verdict it could not have changed.
 *
 * Without a Target ROAS the `account_history` rung is still reachable and both
 * fields still key identity, unchanged.
 */
export function projectAccountCpaForIdentity(
  pack: CommercialTargetPackFacts | null | undefined,
  cpa: { accountCpaP50: number | null; accountCpaSampleCount: number | null },
): { accountCpaP50: number | null; accountCpaSampleCount: number | null } {
  if (!targetRoasGoverns(pack)) {
    return {
      accountCpaP50: cpa.accountCpaP50 ?? null,
      accountCpaSampleCount: cpa.accountCpaSampleCount ?? null,
    };
  }
  return { accountCpaP50: null, accountCpaSampleCount: null };
}

/**
 * The calibration-profile knobs any identity may read.
 *
 * A `Readonly<Record>` rather than an index-signature interface so a nominal
 * config type (`DecisionCalibrationProfileConfig`) assigns without every
 * caller having to widen it first.
 */
export type CalibrationProfileConfigFacts = {
  readonly attributionAovAdjustmentMultiplier?: number | null;
};

/**
 * The decision-calibration profile config, as an identity may see it.
 *
 * `attributionAovAdjustmentMultiplier` is ACCEPTED AND INERT — `resolveSpendUnit`
 * pins it to 1 on every rung and never writes it into `SpendUnitEvidence`, so
 * it cannot reach a spend unit, a threshold, an eligibility or a verdict. The
 * D086 `input_fingerprint` nonetheless digested `profileConfig` RAW, which put
 * the knob straight into retention identity through the one door the resolver
 * had carefully closed: typing it discarded a retained verdict it could not
 * have changed.
 *
 * Projected out only in the governed case, so the no-Target-ROAS compatibility
 * digest stays byte-identical to what it has always produced.
 */
export function projectProfileConfigForIdentity(
  config: CalibrationProfileConfigFacts | null | undefined,
  pack: CommercialTargetPackFacts | null | undefined,
): Record<string, unknown> | null {
  if (!config) return null;
  if (!targetRoasGoverns(pack)) return { ...config };
  return { ...config, attributionAovAdjustmentMultiplier: null };
}

/** The native target-authority row, as `ad-calibration-job.ts` normalizes it. */
export interface NativeTargetAuthorityFacts {
  sourceRowId?: string | null;
  operation?: unknown;
  targetCpa?: number | null;
  targetRoas?: number | null;
  breakEvenCpa?: number | null;
  breakEvenRoas?: number | null;
  operatorAovAssumption?: number | null;
  defaultRiskPosture?: string | null;
  effectiveAt?: string | null;
  recordedAt?: string | null;
}

/**
 * The native target authority as an IDENTITY may see it.
 *
 * `authorityHash` digested this row whole, which put three non-authoritative
 * numbers into the native authority, spend, generation and cell hashes — and,
 * worse, put `sourceRowId`, `effectiveAt` and `recordedAt` there too. Those
 * three move whenever the target pack row is re-saved, so under a governing
 * Target ROAS an operator editing only their Target CPA minted a new authority
 * hash, a new generation and a new cell for a change that could not reach the
 * verdict. Nulling the numbers alone would not have closed it; the row's
 * identity and clocks had to go with them.
 *
 * The cutoff-safety VERDICT those clocks feed is preserved: the caller hashes
 * `status` (and the derived `targetRoasAuthority` / `breakEvenRoasAuthority`
 * booleans) separately, so what the timestamps decided still keys the hash
 * while their raw values no longer do.
 */
export function projectNativeTargetAuthorityForIdentity(
  authority: NativeTargetAuthorityFacts | null,
): Record<string, unknown> | null {
  if (authority === null) return null;
  if (!targetRoasGoverns(authority)) {
    return { ...authority };
  }
  return {
    sourceRowId: null,
    operation: authority.operation ?? null,
    targetCpa: null,
    targetRoas: authority.targetRoas ?? null,
    breakEvenCpa: null,
    breakEvenRoas: authority.breakEvenRoas ?? null,
    operatorAovAssumption: null,
    defaultRiskPosture: authority.defaultRiskPosture ?? null,
    effectiveAt: null,
    recordedAt: null,
  };
}

/**
 * Warning codes that describe only the non-authoritative inputs.
 *
 * `resolveSpendUnit` emits `target_cpa_missing` and `operator_aov_missing` as
 * an INVENTORY of what the operator has typed, not as a claim about the
 * verdict. With a Target ROAS neither absence changes anything the engine
 * decides, so neither may move an identity — and their presence flipped as
 * soon as an operator typed or cleared a CPA, which is how a purely
 * informational string reached three hash families.
 */
const NON_AUTHORITATIVE_WARNING_CODES: ReadonlySet<string> = new Set([
  "target_cpa_missing",
  "operator_aov_missing",
  "break_even_cpa_missing",
  /*
    `account_cpa_sample_low` describes the ACCOUNT-HISTORY rung's sample, and
    that rung is unreachable while a Target ROAS governs — `resolveSpendUnit`
    answers READY-or-`insufficient` in that branch rather than falling through
    to it. So the warning is an inventory of a number that chooses nothing, and
    hashing it let a re-measured CPA sample discard a retained verdict through
    the same door its VALUE was just projected out of.
  */
  "account_cpa_sample_low",
]);

/**
 * Filters the warning list an identity may digest.
 *
 * Only under a governing Target ROAS: without one, `target_cpa_missing` is a
 * statement about the anchor that actually governs, and it stays.
 */
export function projectSpendUnitWarningsForIdentity(
  warnings: readonly string[],
  pack: CommercialTargetPackFacts | null | undefined,
): string[] {
  if (!targetRoasGoverns(pack)) return [...warnings];
  return warnings.filter((warning) => !NON_AUTHORITATIVE_WARNING_CODES.has(warning));
}
