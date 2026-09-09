import {
  getBusinessCommercialTruthSnapshot,
  getBusinessTargetPackHistoryAsOf,
  resolveBusinessTargetPackFreshness,
} from "@/lib/business-commercial";
// The SAME readiness predicate `resolveSpendUnit` divides by, imported rather
// than restated so the maturity floor cannot claim a canonical unit the
// resolver would refuse to build. `spend-unit-resolver` imports only `./types`,
// so this edge introduces no cycle.
import { classifyMetaAovQuality } from "@/lib/creative-decision-engine/spend-unit-resolver";
// The strict reading of a target-pack clock, shared with the semantic
// projection, the account profile and the native target authority so the four
// cannot disagree about whether a stored timestamp is usable evidence.
import {
  commercialTargetInstantMs,
  deterministicCommercialCutoff,
  isCommercialTargetInstantWithinCutoff,
} from "@/lib/meta/commercial-target-instant";

export type MetaCommercialTargetSource = "configured_targets" | "none";
export type MetaCommercialRiskPosture =
  "conservative" | "balanced" | "aggressive";

export interface MetaCommercialTargets {
  source: MetaCommercialTargetSource;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
  breakEvenCpa: number | null;
  /**
   * Operator average-order-value assumption.
   *
   * CARRIED, NEVER AUTHORITATIVE. This used to say it "resolves the
   * hard-action spend unit at high confidence" with a Target ROAS. It does
   * not: with a Target ROAS the only authoritative unit is READY Meta
   * platform-attributed AOV over that ratio, and an operator's assumption
   * chooses no rung (`resolveSpendUnit`). It stays on the pack so a surface can
   * show what the operator typed beside what the engine used.
   *
   * Optional-by-absence for previously serialized payloads; absence is never
   * read as "configured".
   */
  aovAssumption?: number | null;
  riskPosture: MetaCommercialRiskPosture;
  freshness: "fresh" | "stale" | "unknown";
  updatedAt: string | null;
  /**
   * Meta's attributed purchase AOV, carried ALONGSIDE the ratios rather than
   * threaded separately.
   *
   * The canonical unit needs both halves — the ratio from these targets and
   * the average order value from the warehouse — and every path that builds a
   * maturity floor (snapshot, ad-set, scenario emitters, recommendations)
   * already receives this object. Threading a second parameter through those
   * four call chains, several of them positional, would have been four chances
   * to forget one; a caller that forgets leaves a ROAS-governed account with no
   * canonical unit at all, which now HOLDS it — visibly, rather than quietly
   * substituting a CPA as it once did.
   *
   * Optional by absence: a caller that never populates it resolves precisely
   * as it did before, and absence is never read as "no Meta AOV exists".
   */
  metaAttributedAov?: MetaAttributedAovSample | null;
}

/**
 * Meta's own attributed purchase AOV and the sample standing behind it.
 *
 * Threaded beside `MetaCommercialTargets` wherever a maturity floor is built,
 * because the canonical unit needs BOTH halves: the ratio comes from the
 * targets and the average order value comes from here. A caller that passes
 * the targets without this pair leaves a ROAS-governed account with no
 * authoritative unit, and the maturity floor then withholds rather than
 * reaching for a CPA — which is the substitution this type exists to prevent.
 */
export interface MetaAttributedAovSample {
  aovMean: number | null;
  purchaseCount: number;
}

export interface MetaLossBudgetMaturity {
  spendThreshold: number;
  /**
   * The money-per-purchase unit the floor is built from.
   *
   * Named `cpaBaseline` for the callers that already read it. When `source` is
   * `meta_derived_aov` it is NOT a CPA any operator typed — it is the canonical
   * unit, ready Meta platform-attributed AOV over the Target ROAS. Read
   * `source` before describing this number to anyone.
   */
  cpaBaseline: number;
  multiplier: number;
  calibratedSpendFloor: number;
  source:
    | "meta_derived_aov"
    | "break_even_cpa"
    | "target_cpa"
    | "account_cpa";
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRiskPosture(value: unknown): MetaCommercialRiskPosture {
  return value === "conservative" || value === "aggressive"
    ? value
    : "balanced";
}

export function normalizeMetaCommercialTargets(
  input?: Partial<MetaCommercialTargets> | null,
  referenceTime: Date | string = new Date(),
): MetaCommercialTargets {
  const targetRoas = positiveNumber(input?.targetRoas);
  const breakEvenRoas = positiveNumber(input?.breakEvenRoas);
  const targetCpa = positiveNumber(input?.targetCpa);
  const breakEvenCpa = positiveNumber(input?.breakEvenCpa);
  const aovAssumption = positiveNumber(input?.aovAssumption);
  const hasAnchor = Boolean(
    targetRoas || breakEvenRoas || targetCpa || breakEvenCpa,
  );
  /*
    VALIDATED RAW, BEFORE NORMALIZATION.

    This asked `Number.isFinite(Date.parse(candidate))`, which accepts a
    date-only string, a naked local time, `2026-02-30` (silently 2026-03-02)
    and `September 5, 2026`. Any of those made `freshness` resolvable, and
    `freshness` is what decides whether this pack may anchor a hard action —
    so an impossible calendar date granted authority while naming a day that
    does not exist. `commercialTargetInstantMs` constructs the instant from the
    literal fields instead of handing them to a parser that rolls them over,
    so a value that cannot be a real UTC instant is an ABSENT timestamp here.
  */
  const updatedAtCandidate =
    typeof input?.updatedAt === "string" && input.updatedAt.trim()
      ? input.updatedAt.trim()
      : null;
  const updatedAtMsCandidate = commercialTargetInstantMs(updatedAtCandidate);
  const updatedAt = updatedAtMsCandidate === null ? null : updatedAtCandidate;
  const referenceCutoff =
    typeof referenceTime === "string"
      ? deterministicCommercialCutoff(referenceTime)
      : Number.isFinite(referenceTime.getTime())
        ? referenceTime.getTime()
        : null;
  const updatedAtMs = updatedAtMsCandidate;
  const timestampCutoffSafe =
    updatedAtMs !== null &&
    referenceCutoff !== null &&
    isCommercialTargetInstantWithinCutoff(
      updatedAtCandidate,
      referenceCutoff,
    );
  const freshness =
    hasAnchor && timestampCutoffSafe && input?.freshness === "fresh"
      ? "fresh"
      : hasAnchor && timestampCutoffSafe && input?.freshness === "stale"
        ? "stale"
        : "unknown";
  return {
    source: hasAnchor ? "configured_targets" : "none",
    targetRoas,
    breakEvenRoas,
    targetCpa,
    breakEvenCpa,
    aovAssumption,
    riskPosture: normalizeRiskPosture(input?.riskPosture),
    freshness,
    updatedAt: timestampCutoffSafe ? updatedAt : null,
    /*
      Carried through, never invented. The sample is only usable when both
      halves are real numbers, so a malformed or partial pair normalizes to
      null rather than being divided by something that cannot be trusted.

      A null here does NOT hand the account to the CPA ladder: with a positive
      Target ROAS `metaLossBudgetMaturity` holds instead, because the absence
      of the only authoritative unit is an absence and not a licence to size
      the floor from a number that governs nothing.
    */
    metaAttributedAov:
      positiveNumber(input?.metaAttributedAov?.aovMean) !== null &&
      Number.isFinite(Number(input?.metaAttributedAov?.purchaseCount))
        ? {
          aovMean: positiveNumber(input?.metaAttributedAov?.aovMean),
          purchaseCount: Number(input?.metaAttributedAov?.purchaseCount),
        }
        : null,
  };
}

export async function readMetaCommercialTargets(
  businessId: string,
  input?: { asOf?: string | Date },
): Promise<MetaCommercialTargets> {
  if (input?.asOf !== undefined) {
    const referenceCutoff =
      input.asOf instanceof Date
        ? Number.isFinite(input.asOf.getTime())
          ? input.asOf.toISOString()
          : null
        : deterministicCommercialCutoff(input.asOf);
    if (referenceCutoff === null) {
      throw new Error("asOf must be a valid date or timestamp");
    }
    const targetPack = await getBusinessTargetPackHistoryAsOf({
      businessId,
      asOf: input.asOf,
    });
    return normalizeMetaCommercialTargets(
      {
        targetRoas: targetPack?.targetRoas ?? null,
        breakEvenRoas: targetPack?.breakEvenRoas ?? null,
        targetCpa: targetPack?.targetCpa ?? null,
        breakEvenCpa: targetPack?.breakEvenCpa ?? null,
        aovAssumption: targetPack?.aovAssumption ?? null,
        riskPosture: targetPack?.defaultRiskPosture ?? "balanced",
        freshness: resolveBusinessTargetPackFreshness(
          targetPack?.updatedAt,
          referenceCutoff,
        ),
        updatedAt: targetPack?.updatedAt ?? null,
      },
      referenceCutoff,
    );
  }

  const snapshot = await getBusinessCommercialTruthSnapshot(businessId);
  const targetPack = snapshot.targetPack;
  const targetFreshness = snapshot.sectionMeta?.targetPack?.freshness;
  return normalizeMetaCommercialTargets({
    targetRoas: targetPack?.targetRoas ?? null,
    breakEvenRoas: targetPack?.breakEvenRoas ?? null,
    targetCpa: targetPack?.targetCpa ?? null,
    breakEvenCpa: targetPack?.breakEvenCpa ?? null,
    aovAssumption: targetPack?.aovAssumption ?? null,
    riskPosture: targetPack?.defaultRiskPosture ?? "balanced",
    freshness:
      targetFreshness?.status === "fresh"
        ? "fresh"
        : targetFreshness?.status === "stale"
          ? "stale"
          : "unknown",
    updatedAt: targetFreshness?.updatedAt ?? targetPack?.updatedAt ?? null,
  });
}

export function hasMetaHardActionAnchor(
  targets: MetaCommercialTargets | null | undefined,
) {
  const normalized = normalizeMetaCommercialTargets(targets);
  return (
    normalized.source === "configured_targets" &&
    normalized.freshness !== "unknown" &&
    normalized.updatedAt !== null
  );
}

/**
 * The reason a purchase-VALUE budget action may not act, or `null` when it may.
 *
 * ONE PREDICATE FOR EVERY PURCHASE-BUDGET SURFACE. Scale, the C1 controlled
 * scale emitter, the ad-set budget path and the shared action-authority guard
 * each used to ask a DIFFERENT question — "is there a target pack?", "is there
 * a Target ROAS?", "is the measured CPA under the account p75?" — and each
 * answer could grant a budget increase the canonical rule forbids. With a
 * positive Target ROAS the only authoritative money-per-purchase unit is READY
 * same-account, same-cutoff Meta platform-attributed AOV over that ratio, so a
 * surface that authorized on the ratio ALONE was authorizing on half the unit.
 *
 * The refusals are ordered from the most specific missing input outward, and
 * every one of them is a HOLD: none of them may be answered by a Target CPA, a
 * break-even CPA, an account CPA, an operator AOV assumption or a store AOV.
 * The blocker names are the ones the native/served commercial anchor already
 * uses (`lib/creative-decision-engine/commercial-anchor.ts`) so an operator
 * reading two surfaces reads one vocabulary.
 *
 * WITHOUT a positive Target ROAS this returns `commercial_growth_anchor_missing`
 * exactly as before: nothing can divide an average order value without a ratio,
 * and the legacy Target-CPA compatibility path is reached through the CPA
 * ladder in `metaLossBudgetMaturity`, never through here.
 */
export type MetaPurchaseValueBlocker =
  | "commercial_target_missing"
  | "commercial_target_unknown"
  | "commercial_growth_anchor_missing"
  | "commercial_anchor_missing"
  | "commercial_anchor_sample_insufficient";

export type MetaPurchaseValueAuthority =
  | { authorized: true; blocker: null; unit: number }
  | { authorized: false; blocker: MetaPurchaseValueBlocker; unit: null };

export function resolveMetaPurchaseValueAuthority(
  targets: MetaCommercialTargets | null | undefined,
  sample?: MetaAttributedAovSample | null,
): MetaPurchaseValueAuthority {
  const refuse = (blocker: MetaPurchaseValueBlocker): MetaPurchaseValueAuthority => ({
    authorized: false,
    blocker,
    unit: null,
  });
  const normalized = normalizeMetaCommercialTargets(targets);
  if (normalized.source === "none") return refuse("commercial_target_missing");
  if (!hasMetaHardActionAnchor(normalized)) return refuse("commercial_target_unknown");
  const targetRoas = positiveNumber(normalized.targetRoas);
  if (!targetRoas) return refuse("commercial_growth_anchor_missing");
  const resolved = sample ?? normalized.metaAttributedAov ?? null;
  const aov = positiveNumber(resolved?.aovMean);
  if (!aov) return refuse("commercial_anchor_missing");
  if (classifyMetaAovQuality(Number(resolved?.purchaseCount ?? 0)) !== "ready") {
    return refuse("commercial_anchor_sample_insufficient");
  }
  return { authorized: true, blocker: null, unit: aov / targetRoas };
}

/**
 * The ceiling the RELATIVE cut path compares against.
 *
 * THE TARGET ROAS WHENEVER THERE IS ONE. This returned
 * `breakEvenRoas ?? targetRoas`, which reads as a courtesy — "use the stricter
 * line the operator typed" — and is a silent replacement of the boundary the
 * product actually asks for. Two accounts with the same Target ROAS then made
 * DIFFERENT relative decisions because one of them had also typed a
 * break-even, and an operator who edited only their break-even moved a
 * relative Cut boundary they never intended to move. Target ROAS is the
 * configured operating line; while it exists it is the relative boundary, and
 * break-even changes are inert here.
 *
 * Break-even keeps its own, separately labeled question and its own consumers.
 * `metaCutRoasCeiling` / `metaCutRoasReviewCeiling` return break-even ROAS
 * alone and power the ECONOMIC STOP-LOSS path — "is this spend loss-making",
 * not "is this below the operating target". That path is optional in both
 * directions: it never fires without a configured break-even, and its absence
 * never blocks a relative decision. Break-even is therefore never a second
 * required target, and it never stands in for the target boundary.
 *
 * Without a positive Target ROAS the account has no operating line, and the
 * configured break-even is the only commercial ratio there is — so it is the
 * compatibility boundary for the relative path too.
 */
export function metaRelativeCutRoasCeiling(
  targets: MetaCommercialTargets | null | undefined,
) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (normalized.source !== "configured_targets") return null;
  return positiveNumber(normalized.targetRoas) ?? positiveNumber(normalized.breakEvenRoas);
}

export function metaScaleRoasFloor(
  targets: MetaCommercialTargets | null | undefined,
) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (!hasMetaHardActionAnchor(normalized)) return null;
  // Budget expansion needs an explicit operating target. Break-even only
  // proves non-loss; it does not define acceptable growth economics.
  return normalized.targetRoas;
}

export function metaCutRoasCeiling(
  targets: MetaCommercialTargets | null | undefined,
) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (!hasMetaHardActionAnchor(normalized)) return null;
  // Only break-even establishes that spend is economically loss-making.
  // A fixed fraction of a target ROAS is not a loss boundary.
  return normalized.breakEvenRoas;
}

export function metaCutRoasReviewCeiling(
  targets: MetaCommercialTargets | null | undefined,
) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (normalized.source !== "configured_targets") return null;
  // Review candidates may use the configured loss boundary even when another
  // action-specific anchor is absent. Age alone never changes authority.
  return normalized.breakEvenRoas;
}

function riskMultiplier(posture: MetaCommercialRiskPosture) {
  if (posture === "conservative") return 2.5;
  if (posture === "aggressive") return 1.5;
  return 2;
}

/**
 * The canonical money-per-purchase unit, or null when this account has none.
 *
 * ONE DEFINITION, read by everything that needs to know what a purchase is
 * worth: `metaLossBudgetMaturity` below, the Scale ceiling in
 * `recommendations.ts`, the ad-set Scale gate, and
 * `resolveMetaPurchaseValueAuthority` above.
 *
 * `ready` is `classifyMetaAovQuality`'s bar — the same predicate
 * `resolveSpendUnit` divides by — so this never claims a unit the resolver
 * would refuse to build.
 *
 * NULL MEANS TWO DIFFERENT THINGS AND THE CALLER MUST KNOW WHICH. With a
 * positive Target ROAS it means HOLD: the only authoritative unit is absent
 * and nothing substitutes for it. Without one it means the legacy CPA
 * compatibility path applies. `resolveMetaPurchaseValueAuthority` returns the
 * named reason rather than a bare null for callers that need to say which.
 */
export function metaCanonicalSpendUnit(
  targets: MetaCommercialTargets | null | undefined,
  sample?: MetaAttributedAovSample | null,
): number | null {
  const normalized = normalizeMetaCommercialTargets(targets);
  const targetRoas = positiveNumber(normalized.targetRoas);
  if (!targetRoas) return null;
  const resolved = sample ?? normalized.metaAttributedAov ?? null;
  const aov = positiveNumber(resolved?.aovMean);
  if (!aov) return null;
  if (classifyMetaAovQuality(Number(resolved?.purchaseCount ?? 0)) !== "ready") {
    return null;
  }
  return aov / targetRoas;
}

/**
 * The maturity floor: how much an entity must have spent before a loss verdict
 * is allowed to be hard.
 *
 * TWO CASES, AND ONLY ONE OF THEM HAS A CPA IN IT.
 *
 * With a positive Target ROAS the floor is sized from the canonical unit —
 * ready Meta platform-attributed AOV over that ratio — and from nothing else.
 * A missing or thin sample returns `null`, which every caller already treats
 * as "nothing is mature yet". It never falls through to `breakEvenCpa`,
 * `targetCpa` or the account CPA: sizing the gate that decides whether the
 * canonical unit may act from a number the canonical rule calls
 * unauthoritative gave one account two answers to "what is a purchase worth"
 * in a single run.
 *
 * Without a positive Target ROAS the legacy `breakEvenCpa ?? targetCpa ??
 * accountCpa` ladder is the anchor and is preserved exactly.
 */
export function metaLossBudgetMaturity(input: {
  targets?: MetaCommercialTargets | null;
  accountCpaBaseline?: number | null;
  calibratedHardCutSpend?: number | null;
  /**
   * Meta's own attributed purchase AOV and the sample behind it. Optional so
   * a caller that genuinely has no calibration reads exactly as before; when
   * supplied with a Target ROAS it outranks every CPA below.
   */
  metaAttributedAovMean90d?: number | null;
  metaAttributedAovPurchaseCount90d?: number | null;
}): MetaLossBudgetMaturity | null {
  const targets = normalizeMetaCommercialTargets(input.targets);

  /*
    Explicit arguments win; the sample carried on the targets is the fallback.
    Both doors exist because `snapshot.ts` already holds the pair at its own
    call site, while the ad-set, scenario and recommendation paths only ever
    receive the targets object.
  */
  const explicitSample =
    input.metaAttributedAovMean90d !== undefined ||
    input.metaAttributedAovPurchaseCount90d !== undefined
      ? {
        aovMean: input.metaAttributedAovMean90d ?? null,
        purchaseCount: Number(input.metaAttributedAovPurchaseCount90d ?? 0),
      }
      : null;
  const canonicalUnit = metaCanonicalSpendUnit(targets, explicitSample);

  // A positive Target ROAS closes the CPA ladder entirely: the answer is the
  // canonical unit or NOTHING. See this function's own doc comment.
  const targetRoasGoverns = positiveNumber(targets.targetRoas) !== null;
  if (targetRoasGoverns) {
    if (canonicalUnit === null) return null;
    const multiplier = riskMultiplier(targets.riskPosture);
    const calibratedSpendFloor =
      positiveNumber(input.calibratedHardCutSpend) ?? 0;
    return {
      spendThreshold: Math.max(calibratedSpendFloor, canonicalUnit * multiplier),
      cpaBaseline: canonicalUnit,
      multiplier,
      calibratedSpendFloor,
      source: "meta_derived_aov",
    };
  }

  const breakEvenCpa = positiveNumber(targets.breakEvenCpa);
  const targetCpa = positiveNumber(targets.targetCpa);
  const accountCpa = positiveNumber(input.accountCpaBaseline);
  const cpaBaseline = breakEvenCpa ?? targetCpa ?? accountCpa;
  if (!cpaBaseline) return null;
  const multiplier = riskMultiplier(targets.riskPosture);
  const calibratedSpendFloor = positiveNumber(input.calibratedHardCutSpend) ?? 0;
  return {
    spendThreshold: Math.max(calibratedSpendFloor, cpaBaseline * multiplier),
    cpaBaseline,
    multiplier,
    calibratedSpendFloor,
    source: breakEvenCpa
      ? "break_even_cpa"
      : targetCpa
        ? "target_cpa"
        : "account_cpa",
  };
}
