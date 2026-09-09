import type { SpendUnitResolution } from "@/lib/creative-decision-engine/spend-unit-resolver";
import {
  hasMetaHardActionAnchor,
  resolveMetaPurchaseValueAuthority,
  type MetaAttributedAovSample,
  type MetaCommercialTargets,
} from "@/lib/meta/commercial-targets";

export interface MetaIntentProjectionAuthority {
  /** A budget move is purchase-value governed and needs the complete unit. */
  budgetActionAuthorized: boolean;
  /** A bid move may use either READY Meta AOV / Target ROAS or legacy Target CPA. */
  bidActionAuthorized: boolean;
}

/**
 * Converts the commercial reads for this account and cutoff into the two
 * authority tokens the money-moving projectors require.
 *
 * Keeping the tokens separate matters. Budget sizing always needs Target ROAS
 * plus READY same-account Meta AOV. Bid sizing keeps the documented legacy
 * no-ROAS + Target CPA path, but only when that spend unit came from the
 * canonical resolver and the configured target pack has trusted provenance.
 */
export function resolveMetaIntentProjectionAuthority(input: {
  targets: MetaCommercialTargets | null | undefined;
  metaAttributedAov: MetaAttributedAovSample | null;
  spendUnitResolution: SpendUnitResolution;
  spendUnitMinor: number | null;
}): MetaIntentProjectionAuthority {
  /*
    Passing null must mean this account/cutoff read proved no usable sample.
    `resolveMetaPurchaseValueAuthority` normally falls back to a sample carried
    on the target object for callers that deliberately enrich that object; this
    boundary has its own strict physical-account read, so allowing that fallback
    would let an unrelated legacy scalar replace a failed current read.
  */
  const exactMetaAovSample = input.metaAttributedAov ?? {
    aovMean: null,
    purchaseCount: 0,
  };
  const budgetActionAuthorized = resolveMetaPurchaseValueAuthority(
    input.targets,
    exactMetaAovSample,
  ).authorized;
  const bidActionAuthorized =
    hasMetaHardActionAnchor(input.targets) &&
    input.spendUnitResolution.hardEligibleByDefault &&
    typeof input.spendUnitResolution.spendUnit === "number" &&
    Number.isFinite(input.spendUnitResolution.spendUnit) &&
    input.spendUnitResolution.spendUnit > 0 &&
    typeof input.spendUnitMinor === "number" &&
    Number.isSafeInteger(input.spendUnitMinor) &&
    input.spendUnitMinor > 0;

  return { budgetActionAuthorized, bidActionAuthorized };
}
