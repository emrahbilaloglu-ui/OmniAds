/**
 * The canonical Meta-AOV basis, proved over the full permutation of the fields
 * that used to compete with it.
 *
 * D091 makes the META PLATFORM AOV — Meta's own attributed purchase revenue
 * over its purchase count — the canonical money-per-purchase unit for a Meta
 * decision, so the derived spend unit is `Meta platform AOV / target ROAS`, and
 * it retires the store's average order value as a rung of the ladder. Shopify
 * evidence is carried and labelled, and it decides nothing.
 *
 * The individual rules already have targeted tests in
 * `spend-unit-resolver.test.ts`. What was missing is the CROSS PRODUCT: the
 * production incident behind D091 was not a wrong rule, it was two code paths
 * that each looked right in isolation and disagreed on one combination of
 * inputs. This file enumerates the combinations and states the answer for each
 * cell, so a reader can check the rule instead of trusting a sample of it.
 *
 * Axes:
 *   - target ROAS: present / absent
 *   - Meta platform AOV: sampled (>=20 purchases) / thin (low_sample, unstable)
 *     / absent
 *   - legacy target CPA: present / absent
 *   - operator AOV assumption: present / absent
 *   - Shopify AOV: observed / stale / unavailable / observed-zero-orders /
 *     no connected store, plus one adversarial shape production never builds
 *
 * THE TWO DIVERGENCES THIS FILE USED TO PIN ARE CLOSED. It previously recorded
 * that, with a target ROAS present, an explicit Target CPA still won outright
 * and an operator AOV assumption still outranked the platform AOV — the two
 * halves of the rule that `resolveSpendUnit` did not yet implement. Both are now
 * implemented, on BOTH paths in one step:
 *
 *   - CASE 1, a target ROAS is configured: the basis is the platform AOV over
 *     that ratio and nothing else. A conflicting Target CPA and an operator AOV
 *     assumption are carried in the evidence and choose nothing. If the platform
 *     AOV is not usable the ladder HOLDS — it does not reach for the CPA — and
 *     falls only to the soft rungs, which are never hard-action eligible.
 *   - CASE 2, no target ROAS: nothing can divide an average order value, so the
 *     legacy Target CPA legitimately governs and that behaviour is untouched.
 *
 * The same split, in the same order, is what `buildNativeAdSpendUnitAuthority`
 * in `lib/creative-decision-engine/jobs/ad-calibration-job.ts` and
 * `nativeSpendUnitAuthorityMatchesTarget` in `../ad-account-decision-profile.ts`
 * now do. They are one rule read twice: a single rung of disagreement raises
 * `native_target_authority_mismatch` and rolls the native job back, which is the
 * production failure D091 exists to remove. The cells marked
 * `PLATFORM_AOV_OUTRANKS_OPERATOR_ANCHOR` and `HOLD_ON_MISSING_PLATFORM_AOV` are
 * the ones that moved.
 *
 * `operator_aov` is consequently no longer a reachable rung at all: it only ever
 * built `operatorAovAssumption / targetRoas`, and CASE 1 owns every input shape
 * that carries a ratio. It stays a member of `SpendUnitSource` so persisted
 * profiles that name it still parse; it is never minted again.
 */
import { describe, expect, it } from "vitest";
import { resolveAccountDecisionProfile } from "../account-decision-profile";
import { canonicalSha256 } from "../canonical-evaluation";
import type { BusinessTargetPack } from "../data-source";
import {
  OBSERVED_SHOPIFY_AOV_CONTRACT,
  type ObservedShopifyAovEvidence,
} from "../shopify-aov-source";
import { resolveSpendUnit } from "../spend-unit-resolver";
import type {
  AccountCalibration,
  SpendUnitConfidence,
  SpendUnitEvidence,
  SpendUnitSource,
} from "../types";
import {
  AnchorProfileDataSource,
  makeAnchorFlags,
  makeAnchorTargetPack,
} from "./anchor-profile-fixture";
import { makeAccountCalibration } from "./helpers";

const TARGET_ROAS = 2.5;
/** Meta's attributed AOV. `META_AOV / TARGET_ROAS` is the canonical unit. */
const META_AOV = 80;
const META_UNIT = META_AOV / TARGET_ROAS; // 32
/** A legacy operator-typed CPA that disagrees with every derived unit here. */
const TARGET_CPA = 37;
const OPERATOR_AOV = 200;
const OPERATOR_UNIT = OPERATOR_AOV / TARGET_ROAS; // 80
/**
 * The store's own AOV, chosen so that a store-sized unit could not be mistaken
 * for any other answer: `300 / 2.5 = 120`, which is 3.75x the canonical Meta
 * unit, 3.24x the legacy Target CPA and 1.5x the operator-derived unit.
 */
const STORE_AOV = 300;

type MetaTier = "sampled" | "low_sample" | "unstable" | "absent";

/**
 * Purchase counts chosen at the tier boundaries `classifyMetaAovQuality` uses:
 * `>= 20` ready, `>= 5` low_sample, `> 0` unstable, `0` unavailable.
 *
 * The `absent` tier sets the mean to null as well as the count to zero. A mean
 * WITH a zero count is arithmetically impossible upstream — the mean is
 * revenue / count — and the resolver's `metaAovQuality` check rejects it on the
 * count alone, which `spend-unit-resolver.test.ts` already pins.
 */
const META_TIERS: Record<
  MetaTier,
  { mean: number | null; purchaseCount: number; revenue: number }
> = {
  sampled: { mean: META_AOV, purchaseCount: 42, revenue: META_AOV * 42 },
  low_sample: { mean: META_AOV, purchaseCount: 9, revenue: META_AOV * 9 },
  unstable: { mean: META_AOV, purchaseCount: 3, revenue: META_AOV * 3 },
  absent: { mean: null, purchaseCount: 0, revenue: 0 },
};

const META_TIER_WARNING: Record<MetaTier, string | null> = {
  sampled: null,
  low_sample: "meta_aov_low_sample",
  unstable: "meta_aov_unstable",
  absent: "meta_aov_unavailable",
};

interface ShopifyPermutation {
  name: string;
  observedShopifyAov: number | null;
  observedShopifyAovOrderCount: number;
  observedShopifyAovStatus: string | null;
  /** The `observed_shopify_aov_*` warning this permutation adds, if any. */
  statusWarning: string | null;
}

/**
 * Every Shopify shape the served path can present, plus one it cannot.
 *
 * `resolveSpendUnitProfile` in `account-decision-profile.ts` forwards a MAJOR
 * amount only when `observedShopifyAovIsUsable` passes, which requires
 * `status === "observed"`, so in production a non-`observed` status always
 * arrives with a null amount and `observed` always arrives with one. The last
 * entry breaks that pairing on purpose: it hands the resolver a large amount
 * under a `stale` status, a shape no caller builds, to show the number is
 * ignored because it is the store's and not because the status withheld it.
 */
const SHOPIFY_PERMUTATIONS: ShopifyPermutation[] = [
  {
    name: "observed (a usable store AOV that would size a very different unit)",
    observedShopifyAov: STORE_AOV,
    observedShopifyAovOrderCount: 41,
    observedShopifyAovStatus: "observed",
    statusWarning: null,
  },
  {
    name: "stale",
    observedShopifyAov: null,
    observedShopifyAovOrderCount: 0,
    observedShopifyAovStatus: "stale",
    statusWarning: "observed_shopify_aov_stale",
  },
  {
    name: "unavailable",
    observedShopifyAov: null,
    observedShopifyAovOrderCount: 0,
    observedShopifyAovStatus: "unavailable",
    statusWarning: "observed_shopify_aov_unavailable",
  },
  {
    name: "observed_zero_orders",
    observedShopifyAov: null,
    observedShopifyAovOrderCount: 0,
    observedShopifyAovStatus: "observed_zero_orders",
    statusWarning: "observed_shopify_aov_observed_zero_orders",
  },
  {
    name: "no connected store (the field was never looked for)",
    observedShopifyAov: null,
    observedShopifyAovOrderCount: 0,
    observedShopifyAovStatus: null,
    statusWarning: null,
  },
  {
    name: "stale but carrying a number (not producible by the served path)",
    observedShopifyAov: 1234,
    observedShopifyAovOrderCount: 41,
    observedShopifyAovStatus: "stale",
    statusWarning: "observed_shopify_aov_stale",
  },
];

interface Cell {
  targetRoas: number | null;
  meta: MetaTier;
  targetCpa: number | null;
  operatorAov: number | null;
  source: SpendUnitSource;
  spendUnit: number | null;
  confidence: SpendUnitConfidence;
  hardEligibleByDefault: boolean;
  /** Codes the evidence must name for this cell, beyond the Meta tier's own. */
  requiredWarnings?: string[];
  forbiddenWarnings?: string[];
  note?: string;
}

const PLATFORM_AOV_OUTRANKS_OPERATOR_ANCHOR =
  "A target ROAS is configured and the platform AOV is usable, so the basis is" +
  " Meta's own attributed AOV over that ratio. The conflicting operator-typed" +
  " number is carried in the evidence and decides nothing.";

const HOLD_ON_MISSING_PLATFORM_AOV =
  "A target ROAS is configured and the platform AOV is NOT usable, so the" +
  " ladder holds. It does not reach for the operator-typed number: taking it" +
  " would report the absence of Meta evidence as a high-confidence anchor.";

/*
  ROUND 6 — THIN IS NOT A UNIT EITHER.

  The `low_sample` and `unstable` cells under a target ROAS expected
  `meta_derived_aov` with `confidence: "low"` and
  `hardEligibleByDefault: false`. That closed the ACTION gate and still handed
  back a real `spendUnit`, which sized the maturity floor, every threshold
  derived from it, and the canonical evaluation hash — from a sample the rule
  calls insufficient. `resolveSpendUnit` now answers `insufficient` for every
  non-`ready` tier under a target ROAS, so these cells expect no unit at all.
  The `sampled` rows are unchanged, which is what keeps the matrix
  discriminating rather than uniformly withholding.
*/

const LEGACY_CPA_COMPATIBILITY =
  "No target ROAS, so nothing can divide an average order value and the legacy" +
  " Target CPA legitimately governs. Unchanged by the reordering.";

/**
 * The 32 economic cells: 2 target-ROAS states x 4 Meta tiers x 2 target-CPA
 * states x 2 operator-AOV states. Every one is run against every Shopify
 * permutation above.
 *
 * The account's own CPA history and the break-even fallback are held OFF in
 * this table (`accountCpaP50: null`, `breakEvenRoas: null`) so each cell shows
 * the answer of the anchor ladder itself rather than a lower rung catching it.
 * Both lower rungs get their own section below.
 *
 * READ THE TWO HALVES SEPARATELY. Every cell with a target ROAS answers
 * `meta_derived_aov` or `insufficient` and NEVER `target_cpa` or
 * `operator_aov`, whatever the operator typed. Every cell without one answers
 * exactly what it answered before.
 */
const CELLS: Cell[] = [
  // --- target ROAS present ------------------------------------------------
  // Rule 1: the canonical basis. The unit is Meta's own AOV over the
  // configured Target ROAS, and the four target-CPA / operator-AOV
  // combinations below it are all the same answer.
  {
    targetRoas: TARGET_ROAS,
    meta: "sampled",
    targetCpa: null,
    operatorAov: null,
    source: "meta_derived_aov",
    spendUnit: META_UNIT,
    confidence: "medium",
    hardEligibleByDefault: true,
    forbiddenWarnings: ["operator_aov_missing", "meta_aov_unavailable"],
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "low_sample",
    targetCpa: null,
    operatorAov: null,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    forbiddenWarnings: ["operator_aov_missing"],
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "unstable",
    targetCpa: null,
    operatorAov: null,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    forbiddenWarnings: ["operator_aov_missing"],
  },
  // Rule 3: the Meta AOV is gone and nothing may stand in for it.
  {
    targetRoas: TARGET_ROAS,
    meta: "absent",
    targetCpa: null,
    operatorAov: null,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: ["meta_aov_unavailable", "operator_aov_missing"],
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "sampled",
    targetCpa: null,
    operatorAov: OPERATOR_AOV,
    source: "meta_derived_aov",
    spendUnit: META_UNIT,
    confidence: "medium",
    hardEligibleByDefault: true,
    forbiddenWarnings: ["operator_aov_missing"],
    note: PLATFORM_AOV_OUTRANKS_OPERATOR_ANCHOR,
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "low_sample",
    targetCpa: null,
    operatorAov: OPERATOR_AOV,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    forbiddenWarnings: ["operator_aov_missing"],
    note: HOLD_ON_MISSING_PLATFORM_AOV,
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "unstable",
    targetCpa: null,
    operatorAov: OPERATOR_AOV,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    forbiddenWarnings: ["operator_aov_missing"],
    note: HOLD_ON_MISSING_PLATFORM_AOV,
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "absent",
    targetCpa: null,
    operatorAov: OPERATOR_AOV,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: ["meta_aov_unavailable"],
    forbiddenWarnings: ["operator_aov_missing"],
    note: HOLD_ON_MISSING_PLATFORM_AOV,
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "sampled",
    targetCpa: TARGET_CPA,
    operatorAov: null,
    source: "meta_derived_aov",
    spendUnit: META_UNIT,
    confidence: "medium",
    hardEligibleByDefault: true,
    forbiddenWarnings: ["target_cpa_missing"],
    note: PLATFORM_AOV_OUTRANKS_OPERATOR_ANCHOR,
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "low_sample",
    targetCpa: TARGET_CPA,
    operatorAov: null,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    note: HOLD_ON_MISSING_PLATFORM_AOV,
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "unstable",
    targetCpa: TARGET_CPA,
    operatorAov: null,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    note: HOLD_ON_MISSING_PLATFORM_AOV,
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "absent",
    targetCpa: TARGET_CPA,
    operatorAov: null,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: ["meta_aov_unavailable", "operator_aov_missing"],
    forbiddenWarnings: ["target_cpa_missing"],
    note: HOLD_ON_MISSING_PLATFORM_AOV,
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "sampled",
    targetCpa: TARGET_CPA,
    operatorAov: OPERATOR_AOV,
    source: "meta_derived_aov",
    spendUnit: META_UNIT,
    confidence: "medium",
    hardEligibleByDefault: true,
    forbiddenWarnings: ["target_cpa_missing", "operator_aov_missing"],
    note: PLATFORM_AOV_OUTRANKS_OPERATOR_ANCHOR,
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "low_sample",
    targetCpa: TARGET_CPA,
    operatorAov: OPERATOR_AOV,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    note: HOLD_ON_MISSING_PLATFORM_AOV,
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "unstable",
    targetCpa: TARGET_CPA,
    operatorAov: OPERATOR_AOV,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    note: HOLD_ON_MISSING_PLATFORM_AOV,
  },
  {
    targetRoas: TARGET_ROAS,
    meta: "absent",
    targetCpa: TARGET_CPA,
    operatorAov: OPERATOR_AOV,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: ["meta_aov_unavailable"],
    forbiddenWarnings: ["target_cpa_missing", "operator_aov_missing"],
    note: HOLD_ON_MISSING_PLATFORM_AOV,
  },
  // --- target ROAS absent -------------------------------------------------
  // Rule 4: with no ratio to divide by, an AOV of any book builds nothing,
  // and only the legacy Target CPA still anchors. UNCHANGED throughout.
  {
    targetRoas: null,
    meta: "sampled",
    targetCpa: null,
    operatorAov: null,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: ["target_roas_missing", "target_cpa_missing"],
    // Meta's AOV is present and sampled, so the evidence does not also demand
    // an operator AOV: supplying the Target ROAS alone completes this account.
    forbiddenWarnings: ["operator_aov_missing"],
  },
  {
    targetRoas: null,
    meta: "low_sample",
    targetCpa: null,
    operatorAov: null,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: ["target_roas_missing"],
    forbiddenWarnings: ["operator_aov_missing"],
  },
  {
    targetRoas: null,
    meta: "unstable",
    targetCpa: null,
    operatorAov: null,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: ["target_roas_missing"],
    forbiddenWarnings: ["operator_aov_missing"],
  },
  {
    targetRoas: null,
    meta: "absent",
    targetCpa: null,
    operatorAov: null,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: [
      "target_roas_missing",
      "target_cpa_missing",
      "meta_aov_unavailable",
      "operator_aov_missing",
    ],
  },
  {
    targetRoas: null,
    meta: "sampled",
    targetCpa: null,
    operatorAov: OPERATOR_AOV,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: ["target_roas_missing"],
    forbiddenWarnings: ["operator_aov_missing"],
  },
  {
    targetRoas: null,
    meta: "low_sample",
    targetCpa: null,
    operatorAov: OPERATOR_AOV,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: ["target_roas_missing"],
    forbiddenWarnings: ["operator_aov_missing"],
  },
  {
    targetRoas: null,
    meta: "unstable",
    targetCpa: null,
    operatorAov: OPERATOR_AOV,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: ["target_roas_missing"],
    forbiddenWarnings: ["operator_aov_missing"],
  },
  {
    targetRoas: null,
    meta: "absent",
    targetCpa: null,
    operatorAov: OPERATOR_AOV,
    source: "insufficient",
    spendUnit: null,
    confidence: "insufficient",
    hardEligibleByDefault: false,
    requiredWarnings: ["target_roas_missing", "meta_aov_unavailable"],
    forbiddenWarnings: ["operator_aov_missing"],
  },
  {
    targetRoas: null,
    meta: "sampled",
    targetCpa: TARGET_CPA,
    operatorAov: null,
    source: "target_cpa",
    spendUnit: TARGET_CPA,
    confidence: "high",
    hardEligibleByDefault: true,
    requiredWarnings: ["target_roas_missing"],
    note: LEGACY_CPA_COMPATIBILITY,
  },
  {
    targetRoas: null,
    meta: "low_sample",
    targetCpa: TARGET_CPA,
    operatorAov: null,
    source: "target_cpa",
    spendUnit: TARGET_CPA,
    confidence: "high",
    hardEligibleByDefault: true,
    requiredWarnings: ["target_roas_missing"],
    note: LEGACY_CPA_COMPATIBILITY,
  },
  {
    targetRoas: null,
    meta: "unstable",
    targetCpa: TARGET_CPA,
    operatorAov: null,
    source: "target_cpa",
    spendUnit: TARGET_CPA,
    confidence: "high",
    hardEligibleByDefault: true,
    requiredWarnings: ["target_roas_missing"],
    note: LEGACY_CPA_COMPATIBILITY,
  },
  {
    targetRoas: null,
    meta: "absent",
    targetCpa: TARGET_CPA,
    operatorAov: null,
    source: "target_cpa",
    spendUnit: TARGET_CPA,
    confidence: "high",
    hardEligibleByDefault: true,
    requiredWarnings: [
      "target_roas_missing",
      "meta_aov_unavailable",
      "operator_aov_missing",
    ],
    note: LEGACY_CPA_COMPATIBILITY,
  },
  {
    targetRoas: null,
    meta: "sampled",
    targetCpa: TARGET_CPA,
    operatorAov: OPERATOR_AOV,
    source: "target_cpa",
    spendUnit: TARGET_CPA,
    confidence: "high",
    hardEligibleByDefault: true,
    requiredWarnings: ["target_roas_missing"],
    note: LEGACY_CPA_COMPATIBILITY,
  },
  {
    targetRoas: null,
    meta: "low_sample",
    targetCpa: TARGET_CPA,
    operatorAov: OPERATOR_AOV,
    source: "target_cpa",
    spendUnit: TARGET_CPA,
    confidence: "high",
    hardEligibleByDefault: true,
    requiredWarnings: ["target_roas_missing"],
    note: LEGACY_CPA_COMPATIBILITY,
  },
  {
    targetRoas: null,
    meta: "unstable",
    targetCpa: TARGET_CPA,
    operatorAov: OPERATOR_AOV,
    source: "target_cpa",
    spendUnit: TARGET_CPA,
    confidence: "high",
    hardEligibleByDefault: true,
    requiredWarnings: ["target_roas_missing"],
    note: LEGACY_CPA_COMPATIBILITY,
  },
  {
    targetRoas: null,
    meta: "absent",
    targetCpa: TARGET_CPA,
    operatorAov: OPERATOR_AOV,
    source: "target_cpa",
    spendUnit: TARGET_CPA,
    confidence: "high",
    hardEligibleByDefault: true,
    requiredWarnings: ["target_roas_missing", "meta_aov_unavailable"],
    forbiddenWarnings: ["operator_aov_missing"],
    note: LEGACY_CPA_COMPATIBILITY,
  },
];

function cellLabel(cell: Cell): string {
  return [
    `targetRoas=${cell.targetRoas ?? "none"}`,
    `metaAov=${cell.meta}`,
    `targetCpa=${cell.targetCpa ?? "none"}`,
    `operatorAov=${cell.operatorAov ?? "none"}`,
  ].join(" ");
}

function resolveCell(cell: Cell, shopify: ShopifyPermutation) {
  const tier = META_TIERS[cell.meta];
  return resolveSpendUnit({
    targetCpa: cell.targetCpa,
    operatorAovAssumption: cell.operatorAov,
    observedShopifyAov: shopify.observedShopifyAov,
    observedShopifyAovOrderCount: shopify.observedShopifyAovOrderCount,
    observedShopifyAovStatus: shopify.observedShopifyAovStatus,
    metaAttributedAovMean90d: tier.mean,
    metaAttributedAovPurchaseCount90d: tier.purchaseCount,
    metaAttributedRevenue90d: tier.revenue,
    targetRoas: cell.targetRoas,
    breakEvenRoas: null,
    accountCpaP50: null,
    accountCpaSampleCount: 0,
    attributionAovAdjustmentMultiplier: 1,
  });
}

/** Everything in the evidence that is NOT the store's own contribution. */
function decisionBearingEvidence(evidence: SpendUnitEvidence) {
  const {
    observedShopifyAov: _aov,
    observedShopifyAovOrderCount: _count,
    observedShopifyAovStatus: _status,
    warnings,
    ...rest
  } = evidence;
  return {
    ...rest,
    warnings: warnings.filter(
      (warning) => !warning.startsWith("observed_shopify_aov_"),
    ),
  };
}

describe("canonical Meta AOV permutation matrix", () => {
  it("covers the full cross product of the competing anchor inputs", () => {
    expect(CELLS).toHaveLength(2 * 4 * 2 * 2);
    // No cell is declared twice, so a duplicated row cannot hide a missing one.
    expect(new Set(CELLS.map(cellLabel)).size).toBe(CELLS.length);
  });

  for (const cell of CELLS) {
    describe(cellLabel(cell), () => {
      for (const shopify of SHOPIFY_PERMUTATIONS) {
        it(`resolves ${cell.source} under Shopify ${shopify.name}`, () => {
          const result = resolveCell(cell, shopify);

          expect(result.source).toBe(cell.source);
          if (cell.spendUnit === null) {
            expect(result.spendUnit).toBeNull();
          } else {
            expect(result.spendUnit).toBeCloseTo(cell.spendUnit, 10);
          }
          expect(result.confidence).toBe(cell.confidence);
          expect(result.hardEligibleByDefault).toBe(cell.hardEligibleByDefault);

          const tierWarning = META_TIER_WARNING[cell.meta];
          if (tierWarning) {
            expect(result.evidence.warnings).toContain(tierWarning);
          }
          for (const warning of cell.requiredWarnings ?? []) {
            expect(result.evidence.warnings).toContain(warning);
          }
          for (const warning of cell.forbiddenWarnings ?? []) {
            expect(result.evidence.warnings).not.toContain(warning);
          }

          // The store's figure is carried verbatim beside the unit whatever
          // the unit turned out to be, so a panel can show both books.
          expect(result.evidence.observedShopifyAov).toBe(
            shopify.observedShopifyAov,
          );
          expect(result.evidence.observedShopifyAovStatus).toBe(
            shopify.observedShopifyAovStatus,
          );
          if (shopify.statusWarning) {
            expect(result.evidence.warnings).toContain(shopify.statusWarning);
          }
        });
      }

      it("gives the same answer under every Shopify permutation", () => {
        const [first, ...rest] = SHOPIFY_PERMUTATIONS.map((shopify) =>
          resolveCell(cell, shopify),
        );
        for (const other of rest) {
          expect(other.source).toBe(first.source);
          expect(other.spendUnit).toBe(first.spendUnit);
          expect(other.confidence).toBe(first.confidence);
          expect(other.hardEligibleByDefault).toBe(
            first.hardEligibleByDefault,
          );
          // Nothing outside the explicitly store-labelled fields moves either.
          expect(decisionBearingEvidence(other.evidence)).toEqual(
            decisionBearingEvidence(first.evidence),
          );
        }
      });
    });
  }
});

/**
 * The precedence itself, stated as the three conflicts rather than as a table
 * lookup, so the numbers that must NOT come out are named.
 *
 * `TARGET_CPA` (37), `OPERATOR_UNIT` (80) and the store-sized `STORE_AOV /
 * TARGET_ROAS` (120) are all different from `META_UNIT` (32) and from each
 * other, so a wrong rung cannot be mistaken for the right one at any of these
 * assertions.
 */
describe("with a target ROAS, the platform AOV outranks every operator input", () => {
  const withRoas = (overrides: {
    targetCpa?: number | null;
    operatorAov?: number | null;
    meta?: MetaTier;
  }) =>
    resolveCell(
      {
        targetRoas: TARGET_ROAS,
        meta: overrides.meta ?? "sampled",
        targetCpa: overrides.targetCpa ?? null,
        operatorAov: overrides.operatorAov ?? null,
        source: "meta_derived_aov",
        spendUnit: META_UNIT,
        confidence: "medium",
        hardEligibleByDefault: true,
      },
      SHOPIFY_PERMUTATIONS[0]!,
    );

  it("ignores a conflicting legacy target CPA", () => {
    const result = withRoas({ targetCpa: TARGET_CPA });

    expect(result.source).toBe("meta_derived_aov");
    expect(result.spendUnit).toBe(META_UNIT);
    expect(result.spendUnit).not.toBe(TARGET_CPA);
    // The CPA is not discarded, only demoted: it stays readable as evidence.
    expect(result.evidence.targetCpa).toBe(TARGET_CPA);
  });

  it("ignores a conflicting operator AOV assumption", () => {
    const result = withRoas({ operatorAov: OPERATOR_AOV });

    expect(result.source).toBe("meta_derived_aov");
    expect(result.spendUnit).toBe(META_UNIT);
    expect(result.spendUnit).not.toBe(OPERATOR_UNIT);
    expect(result.evidence.operatorAovAssumption).toBe(OPERATOR_AOV);
  });

  it("ignores both at once", () => {
    const result = withRoas({
      targetCpa: TARGET_CPA,
      operatorAov: OPERATOR_AOV,
    });

    expect(result.source).toBe("meta_derived_aov");
    expect(result.spendUnit).toBe(META_UNIT);
    expect(result.spendUnit).not.toBe(TARGET_CPA);
    expect(result.spendUnit).not.toBe(OPERATOR_UNIT);
    expect(result.spendUnit).not.toBe(STORE_AOV / TARGET_ROAS);
  });

  it("holds rather than falling back to the CPA when the platform AOV is gone", () => {
    // THE DECIDED ANSWER for `target ROAS + no Meta AOV + target CPA`: hold.
    //
    // The CPA is explicit and operator-typed, so taking it would be defensible
    // in isolation — and it is exactly what this ladder did before. It is
    // refused because of what the CPA would then CLAIM: `confidence: "high"`
    // and `hardEligibleByDefault: true` on an account where Meta attributed no
    // purchases at all, which reports a missing platform AOV as a resolved
    // anchor. The absence is already named in the evidence, and the resolved
    // source must not contradict the evidence.
    //
    // The soft rungs below still supply a NUMBER for the threshold builder (see
    // the next describe block); none of them is hard-action eligible.
    const result = withRoas({ targetCpa: TARGET_CPA, meta: "absent" });

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.hardEligibleByDefault).toBe(false);
    expect(result.evidence.warnings).toContain("meta_aov_unavailable");
    // Still readable, still not taken.
    expect(result.evidence.targetCpa).toBe(TARGET_CPA);
  });

  it("holds rather than falling back to the operator AOV when it is gone", () => {
    const result = withRoas({ operatorAov: OPERATOR_AOV, meta: "absent" });

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.hardEligibleByDefault).toBe(false);
    expect(result.evidence.warnings).toContain("meta_aov_unavailable");
  });

  it("keeps the legacy CPA governing the moment the target ROAS is removed", () => {
    // The compatibility guard, against the same inputs as the hold above: the
    // difference between the two answers is the target ROAS and nothing else.
    const held = withRoas({ targetCpa: TARGET_CPA, meta: "absent" });
    const legacy = resolveCell(
      {
        targetRoas: null,
        meta: "absent",
        targetCpa: TARGET_CPA,
        operatorAov: null,
        source: "target_cpa",
        spendUnit: TARGET_CPA,
        confidence: "high",
        hardEligibleByDefault: true,
      },
      SHOPIFY_PERMUTATIONS[0]!,
    );

    expect(held.source).toBe("insufficient");
    expect(legacy.source).toBe("target_cpa");
    expect(legacy.spendUnit).toBe(TARGET_CPA);
    expect(legacy.confidence).toBe("high");
    expect(legacy.hardEligibleByDefault).toBe(true);
  });

  it("never mints operator_aov under any cell of the matrix", () => {
    // `operator_aov` is retired as a rung, not merely outranked: there is no
    // combination of the axes that produces it. It stays in `SpendUnitSource`
    // so a persisted profile naming it still parses.
    for (const cell of CELLS) {
      for (const shopify of SHOPIFY_PERMUTATIONS) {
        expect(resolveCell(cell, shopify).source).not.toBe("operator_aov");
      }
    }
  });
});

/**
 * The soft rungs cannot rescue a missing Meta AOV — and under a Target ROAS
 * they are not reached at all.
 *
 * ROUND 6 RE-PIN. These asserted that a Target-ROAS account with no usable
 * Meta AOV FELL THROUGH to `account_history` (the account's median CPA) and
 * then to `break_even_aov`. `hardEligibleByDefault: false` closed the action
 * gate, but a NUMBER was still produced and it was a money-per-purchase unit
 * built from something other than ready Meta AOV — it sized the maturity
 * floor, every threshold derived from it, and the canonical evaluation hash.
 *
 * With a positive Target ROAS the answer is now the READY unit or
 * `insufficient`, so the cases below assert the hold. The no-Target-ROAS
 * controls beside each one keep both soft rungs proven reachable, which is
 * what makes the hold a scoped rule rather than a deletion.
 */
describe("a missing Meta AOV never becomes a hard action through a lower rung", () => {
  const missingMeta = {
    targetCpa: null,
    operatorAovAssumption: null,
    observedShopifyAov: STORE_AOV,
    observedShopifyAovOrderCount: 41,
    observedShopifyAovStatus: "observed",
    metaAttributedAovMean90d: null,
    metaAttributedAovPurchaseCount90d: 0,
    metaAttributedRevenue90d: 0,
    targetRoas: TARGET_ROAS,
    breakEvenRoas: null,
    accountCpaP50: null,
    accountCpaSampleCount: 0,
    attributionAovAdjustmentMultiplier: 1,
  };

  it("does NOT fall to account history while a Target ROAS governs", () => {
    const result = resolveSpendUnit({
      ...missingMeta,
      accountCpaP50: 58,
      accountCpaSampleCount: 24,
    });

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.hardEligibleByDefault).toBe(false);
    expect(result.evidence.warnings).toContain("meta_aov_unavailable");
    // Neither the account's own median CPA nor the store-sized unit.
    expect(result.spendUnit).not.toBe(58);
    expect(result.spendUnit).not.toBe(STORE_AOV / TARGET_ROAS);
  });

  it("still reaches account history when there is no Target ROAS at all", () => {
    // The compatibility control. Without it the assertion above would be
    // satisfied by a resolver that had simply lost the rung.
    const result = resolveSpendUnit({
      ...missingMeta,
      targetRoas: null,
      accountCpaP50: 58,
      accountCpaSampleCount: 24,
    });

    expect(result.source).toBe("account_history");
    expect(result.spendUnit).toBe(58);
    expect(result.hardEligibleByDefault).toBe(false);
  });

  it("holds outright when no lower rung exists either", () => {
    const result = resolveSpendUnit(missingMeta);

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.hardEligibleByDefault).toBe(false);
    expect(result.evidence.warnings).toContain("meta_aov_unavailable");
    expect(result.evidence.warnings).toContain("operator_aov_missing");
  });

  it("does NOT use the break-even fallback while a Target ROAS governs", () => {
    // A configured break-even is a SECOND ratio, so dividing by it is another
    // way to answer "what is a purchase worth" that the Target ROAS did not
    // authorize. Reachable only with a mean but a zero purchase count, which
    // is exactly the thin-evidence shape the hold exists for.
    const result = resolveSpendUnit({
      ...missingMeta,
      metaAttributedAovMean90d: META_AOV,
      breakEvenRoas: 2,
    });

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.evidence.warnings).toContain("meta_aov_unavailable");
  });

  it("still uses the break-even fallback when there is no Target ROAS", () => {
    const result = resolveSpendUnit({
      ...missingMeta,
      targetRoas: null,
      metaAttributedAovMean90d: META_AOV,
      breakEvenRoas: 2,
    });

    expect(result.source).toBe("break_even_aov");
    expect(result.spendUnit).toBe(META_AOV / 2);
    expect(result.hardEligibleByDefault).toBe(false);
  });
});

/*
  The profile level, where the answer actually reaches an operator.

  `resolveSpendUnit` is a pure ladder; `resolveAccountDecisionProfile` is the
  production entry point that adds commercial-target provenance, threshold
  quality and the hard-action gates. Both are exercised because the D091
  incident was a disagreement BETWEEN two levels that each held their own rule.
*/
const SHOPIFY_BASE: ObservedShopifyAovEvidence = {
  contract: OBSERVED_SHOPIFY_AOV_CONTRACT,
  status: "observed",
  source: "shopify_revenue_ledger",
  providerAccountId: "store-1",
  revenueBasis: "net_ledger",
  window: { from: "2026-04-04", to: "2026-05-03" },
  zoneName: "Europe/Istanbul",
  orderCount: 41,
  currency: "USD",
  currencyExponent: 2,
  revenueMinor: STORE_AOV * 100 * 41,
  aovMinor: STORE_AOV * 100,
  observedAt: "2026-05-04T00:00:00.000Z",
  knowledgeAsOf: "2026-05-04T00:00:01.000Z",
};

function storeEvidence(
  overrides: Partial<ObservedShopifyAovEvidence>,
): ObservedShopifyAovEvidence {
  return { ...SHOPIFY_BASE, ...overrides };
}

async function resolveProfile(input: {
  pack?: Partial<BusinessTargetPack>;
  calibration?: Partial<AccountCalibration>;
  store?: ObservedShopifyAovEvidence | null;
}) {
  return resolveAccountDecisionProfile({
    businessId: "biz-1",
    asOf: "2026-05-04",
    dataSource: new AnchorProfileDataSource(
      makeAnchorTargetPack({
        targetCpa: null,
        operatorAovAssumption: null,
        targetRoas: TARGET_ROAS,
        breakEvenRoas: null,
        ...input.pack,
      }),
      makeAccountCalibration({
        metaAttributedAovMean90d: META_AOV,
        metaAttributedAovPurchaseCount90d: 42,
        metaAttributedRevenue90d: META_AOV * 42,
        metaAovQuality: "ready",
        ...input.calibration,
      }),
    ),
    flags: makeAnchorFlags({ shadowOnly: false }),
    observedShopifyAov: input.store ?? null,
  });
}

const NO_META_AOV = {
  metaAttributedAovMean90d: null,
  metaAttributedAovPurchaseCount90d: 0,
  metaAttributedRevenue90d: 0,
  metaAovQuality: "unavailable" as const,
};

describe("resolveAccountDecisionProfile under the same permutations", () => {
  const stores: Array<[string, ObservedShopifyAovEvidence | null]> = [
    ["observed, 300.00", storeEvidence({})],
    [
      "observed, 55.00 (a store AOV close to the Meta one)",
      storeEvidence({ aovMinor: 5500, revenueMinor: 5500 * 41 }),
    ],
    [
      "stale",
      storeEvidence({
        status: "stale",
        aovMinor: null,
        revenueMinor: null,
        orderCount: 0,
      }),
    ],
    [
      "unavailable",
      storeEvidence({
        status: "unavailable",
        aovMinor: null,
        revenueMinor: null,
        orderCount: 0,
        currency: null,
      }),
    ],
    [
      "observed_zero_orders",
      storeEvidence({
        status: "observed_zero_orders",
        aovMinor: null,
        revenueMinor: 0,
        orderCount: 0,
      }),
    ],
    ["no connected store", null],
  ];

  for (const [name, store] of stores) {
    it(`sizes the unit from Meta's AOV with Shopify ${name}`, async () => {
      const profile = await resolveProfile({ store });

      expect(profile.spendUnitSource).toBe("meta_derived_aov");
      expect(profile.spendUnit).toBe(META_UNIT);
      expect(profile.spendUnitConfidence).toBe("medium");
      expect(profile.hardActionEligibility.scale).toBe(true);
      expect(profile.hardActionEligibility.cut).toBe(true);
      expect(profile.hardActionEligibility.refresh).toBe(true);
      expect(profile.hardActionEligibility.anchor?.status).toBe(
        "eligible_meta_derived_aov",
      );
    });
  }

  it("names the hold when the Meta AOV is missing, whatever the store says", async () => {
    const profile = await resolveProfile({
      calibration: NO_META_AOV,
      store: storeEvidence({}),
    });

    // ROUND 6: the profile no longer receives a number at all here. Account
    // history used to supply one for the threshold builder while granting
    // nothing; under a governing Target ROAS the resolver holds instead, so
    // the thresholds are built from no unit rather than from the account's own
    // median CPA. The blocker still names the missing owner anchor rather than
    // the store's presence.
    expect(profile.spendUnitSource).toBe("insufficient");
    expect(profile.spendUnit).toBeNull();
    expect(profile.hardActionEligibility.scale).toBe(false);
    expect(profile.hardActionEligibility.cut).toBe(false);
    expect(profile.hardActionEligibility.refresh).toBe(false);
    expect(profile.hardActionEligibility.codes).toEqual({
      scale: "commercial_anchor_missing",
      cut: "commercial_anchor_missing",
      refresh: "commercial_anchor_missing",
    });
    expect(profile.hardActionEligibility.anchor?.status).toBe(
      "blocked_missing_owner_anchor",
    );
    expect(profile.spendUnitEvidence.warnings).toContain("meta_aov_unavailable");
  });

  it("holds a thin Meta sample with its own named code", async () => {
    const profile = await resolveProfile({
      calibration: {
        metaAttributedAovPurchaseCount90d: 9,
        metaAttributedRevenue90d: META_AOV * 9,
        metaAovQuality: "low_sample",
      },
      store: storeEvidence({}),
    });

    // ROUND 6: a thin sample builds no unit, so the source is the hold itself
    // rather than a `meta_derived_aov` carrying a number nothing may use. The
    // anchor status still names the sample as the reason.
    expect(profile.spendUnitSource).toBe("insufficient");
    expect(profile.spendUnit).toBeNull();
    expect(profile.hardActionEligibility.anchor?.status).toBe(
      "blocked_meta_aov_sample_insufficient",
    );
    expect(profile.hardActionEligibility.codes).toEqual({
      scale: "commercial_anchor_sample_insufficient",
      cut: "commercial_anchor_sample_insufficient",
      refresh: "commercial_anchor_sample_insufficient",
    });
  });

  it("outranks a conflicting target CPA at the profile too", async () => {
    const profile = await resolveProfile({
      pack: { targetCpa: TARGET_CPA },
      store: storeEvidence({}),
    });

    expect(profile.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.spendUnit).toBe(META_UNIT);
    expect(profile.spendUnit).not.toBe(TARGET_CPA);
    expect(profile.hardActionEligibility.anchor?.status).toBe(
      "eligible_meta_derived_aov",
    );
  });

  it("outranks a conflicting operator AOV assumption at the profile too", async () => {
    const profile = await resolveProfile({
      pack: { operatorAovAssumption: OPERATOR_AOV },
      store: storeEvidence({}),
    });

    expect(profile.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.spendUnit).toBe(META_UNIT);
    expect(profile.spendUnit).not.toBe(OPERATOR_UNIT);
    expect(profile.hardActionEligibility.anchor?.status).toBe(
      "eligible_meta_derived_aov",
    );
  });

  it("outranks both at once at the profile", async () => {
    const profile = await resolveProfile({
      pack: { targetCpa: TARGET_CPA, operatorAovAssumption: OPERATOR_AOV },
      store: storeEvidence({}),
    });

    expect(profile.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.spendUnit).toBe(META_UNIT);
    expect(profile.hardActionEligibility.scale).toBe(true);
  });

  it("holds at the profile when the Meta AOV is gone and only a CPA remains", async () => {
    const profile = await resolveProfile({
      pack: { targetCpa: TARGET_CPA },
      calibration: NO_META_AOV,
      store: storeEvidence({}),
    });

    // Account history still supplies a threshold number; the CPA does not
    // become the anchor and no hard action is granted.
    expect(profile.spendUnitSource).not.toBe("target_cpa");
    expect(profile.spendUnit).not.toBe(TARGET_CPA);
    expect(profile.hardActionEligibility.scale).toBe(false);
    expect(profile.hardActionEligibility.cut).toBe(false);
    expect(profile.hardActionEligibility.refresh).toBe(false);
    expect(profile.spendUnitEvidence.warnings).toContain("meta_aov_unavailable");
  });

  it("keeps legacy target-CPA compatibility when no target ROAS exists", async () => {
    const profile = await resolveProfile({
      pack: { targetRoas: null, targetCpa: TARGET_CPA },
      store: storeEvidence({}),
    });

    expect(profile.spendUnitSource).toBe("target_cpa");
    expect(profile.spendUnit).toBe(TARGET_CPA);
    expect(profile.spendUnitConfidence).toBe("high");
    // Refresh needs only the commercial threshold; Scale and Cut still need a
    // ratio, and the blocker says which one is missing rather than inventing
    // one from the CPA.
    expect(profile.hardActionEligibility.refresh).toBe(true);
    expect(profile.hardActionEligibility.scale).toBe(false);
    expect(profile.hardActionEligibility.codes?.scale).toBe(
      "target_roas_missing",
    );
    expect(profile.spendUnitEvidence.warnings).toContain("target_roas_missing");
  });
});

/**
 * Rule 2's hash claim, measured rather than asserted.
 *
 * Two profiles that differ ONLY in the store's average order value: the
 * decision-bearing content is byte-identical, and the store-labelled evidence
 * is the only thing that moves.
 *
 * MEASURED DEFECT, OPEN AND NOT FIXED HERE: the store figure is nevertheless
 * INSIDE the hashed canonical envelope. `normalizeSpendUnitEvidence` in
 * `canonical-evaluation.ts` spreads the whole `SpendUnitEvidence` — including
 * `observedShopifyAov`, `observedShopifyAovOrderCount` and
 * `observedShopifyAovStatus` — into the account profile that `contextHash` is
 * taken over, and `inputHash` and `decisionHash` chain off `contextHash`. So
 * two evaluations of the same account, at the same cutoff, reaching the same
 * decision, mint different canonical digests when the store's books moved. That
 * is a provenance difference with no decision difference, which is the class
 * INVARIANTS.md D091 forbids ("may never ... produce a provenance mismatch").
 *
 * THAT FIX HAS LANDED (Round 4 item 1). `normalizeSpendUnitEvidence` in
 * `canonical-evaluation.ts` no longer spreads `SpendUnitEvidence`; it projects
 * an enumerated, store-free field list, and it is the ONLY route by which a
 * profile reaches a production hash — `normalizeSpendUnitProfile` (:531) and
 * `normalizeAccountProfile` (:589) both call it, and a repository-wide search
 * for a `canonicalSha256(profile…)` outside these tests returns nothing.
 * `CANONICAL_EVALUATION_CONTRACT_VERSION` moved to `.v6` and
 * `AD_DECISION_EVALUATION_CONTRACT_VERSION` to `.v8` to record it.
 *
 * The two cases below therefore no longer describe a defect, and were renamed:
 * they digest the RAW profile object, which is a test-local construct with no
 * production meaning. What they still prove is worth keeping — that the store's
 * numbers are genuinely CARRIED on the profile (evidence, as intended) and that
 * they are the ONLY thing separating two otherwise-identical profiles. That is
 * the evidence the fix was a projection change and not a decision change.
 */
describe("the store's AOV and the canonical hashes", () => {
  it("changes no decision-bearing field of the resolved profile", async () => {
    const expensive = await resolveProfile({ store: storeEvidence({}) });
    const cheap = await resolveProfile({
      store: storeEvidence({ aovMinor: 5500, revenueMinor: 5500 * 41 }),
    });

    expect(expensive.spendUnitEvidence.observedShopifyAov).toBe(STORE_AOV);
    expect(cheap.spendUnitEvidence.observedShopifyAov).toBe(55);

    expect(cheap.spendUnit).toBe(expensive.spendUnit);
    expect(cheap.spendUnitSource).toBe(expensive.spendUnitSource);
    expect(cheap.spendUnitConfidence).toBe(expensive.spendUnitConfidence);
    expect(cheap.thresholds).toEqual(expensive.thresholds);
    expect(cheap.hardActionEligibility).toEqual(expensive.hardActionEligibility);
    expect(decisionBearingEvidence(cheap.spendUnitEvidence)).toEqual(
      decisionBearingEvidence(expensive.spendUnitEvidence),
    );
  });

  it("hashes identically once the store-labelled fields are projected out", async () => {
    const expensive = await resolveProfile({ store: storeEvidence({}) });
    const cheap = await resolveProfile({
      store: storeEvidence({ aovMinor: 5500, revenueMinor: 5500 * 41 }),
    });

    const digest = (profile: Awaited<ReturnType<typeof resolveProfile>>) =>
      canonicalSha256({
        ...profile,
        spendUnitEvidence: decisionBearingEvidence(profile.spendUnitEvidence),
      });

    expect(digest(cheap)).toBe(digest(expensive));
  });

  it("still CARRIES the store's number, so a raw digest of the object differs", async () => {
    const expensive = await resolveProfile({ store: storeEvidence({}) });
    const cheap = await resolveProfile({
      store: storeEvidence({ aovMinor: 5500, revenueMinor: 5500 * 41 }),
    });

    /*
      NOT a production identity. `canonicalSha256(profile)` hashes the raw
      object; every production hash goes through `normalizeSpendUnitEvidence`,
      which is proved store-blind by the case above. This asserts the store
      evidence is still THERE — a projection that deleted it would pass the
      hash test and lose the diagnostic, and this is what catches that.
    */
    expect(canonicalSha256(cheap)).not.toBe(canonicalSha256(expensive));
  });

  it("and the store-labelled fields are the ONLY thing that differs", async () => {
    const expensive = await resolveProfile({ store: storeEvidence({}) });
    const cheap = await resolveProfile({
      store: storeEvidence({ aovMinor: 5500, revenueMinor: 5500 * 41 }),
    });

    // Everything else in the profile is already equal, so the digest gap is
    // attributable to the three store fields and to nothing else. This is the
    // evidence that the fix is a projection change, not a decision change.
    const strip = (profile: Awaited<ReturnType<typeof resolveProfile>>) => ({
      ...profile,
      spendUnitEvidence: decisionBearingEvidence(profile.spendUnitEvidence),
    });
    expect(strip(cheap)).toEqual(strip(expensive));
    expect(canonicalSha256(cheap)).not.toBe(canonicalSha256(expensive));
  });
});

/**
 * Rule 5: same inputs at the same cutoff, twice, byte-identical.
 *
 * Two claims of different strength, and this block says which is which.
 *
 * WEAK, and honestly so: at `resolveSpendUnit` the wall-clock `knowledgeAsOf`
 * that `resolveObservedShopifyAov` stamps is not an input at all — the resolver
 * receives a major amount, an order count and a status, and never the stamp. A
 * determinism test there passes because nothing reads it.
 *
 * STRONG: `resolveAccountDecisionProfile` DOES receive the whole
 * `ObservedShopifyAovEvidence`, stamp included, and the profile is still
 * byte-identical when only the stamp differs. That is the claim worth having,
 * because the 2026-09-07 incident was two code paths disagreeing over an
 * 886-millisecond gap in exactly this field.
 */
describe("same-cutoff determinism", () => {
  it("repeats byte-identically at the resolver (weak: the stamp is not an input)", () => {
    const input = {
      targetCpa: null,
      operatorAovAssumption: null,
      observedShopifyAov: STORE_AOV,
      observedShopifyAovOrderCount: 41,
      observedShopifyAovStatus: "observed",
      metaAttributedAovMean90d: META_AOV,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: META_AOV * 42,
      targetRoas: TARGET_ROAS,
      breakEvenRoas: null,
      accountCpaP50: null,
      accountCpaSampleCount: 0,
      attributionAovAdjustmentMultiplier: 1,
    };

    expect(canonicalSha256(resolveSpendUnit(input))).toBe(
      canonicalSha256(resolveSpendUnit(input)),
    );
  });

  it("repeats byte-identically at the profile", async () => {
    const first = await resolveProfile({ store: storeEvidence({}) });
    const second = await resolveProfile({ store: storeEvidence({}) });

    expect(canonicalSha256(second)).toBe(canonicalSha256(first));
  });

  it("is unmoved when only the store's knowledgeAsOf stamp differs (strong)", async () => {
    const early = await resolveProfile({
      store: storeEvidence({ knowledgeAsOf: "2026-05-04T03:13:19.302Z" }),
    });
    const late = await resolveProfile({
      // 886ms later: the same gap that took three accounts dark on 2026-09-07,
      // moved onto this fixture's as-of date. D091 records the production
      // pair as a 03:13:19.302 cutoff against a 03:13:20.188Z store stamp.
      store: storeEvidence({ knowledgeAsOf: "2026-05-04T03:13:20.188Z" }),
    });

    expect(canonicalSha256(late)).toBe(canonicalSha256(early));
  });
});
