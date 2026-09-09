/**
 * The operator-facing Meta surface sizes hard actions from META's AOV.
 *
 * `app/api/meta/decisions-workspace/route.ts` resolves the commercial anchor by
 * calling `resolveAccountDecisionProfile` with the account's target pack and —
 * as contextual evidence — the store's own observed average order value. While
 * `resolveSpendUnit` carried an `observed_shopify_aov` rung ABOVE
 * `meta_derived_aov`, that store number became the served spend unit and the
 * served derived CPA benchmark, so this surface and the native hard-decision
 * path (which retired the same basis — see `NativeAdSpendUnitAuthorityBasis` in
 * `lib/creative-decision-engine/jobs/ad-calibration-job.ts`) answered "what is
 * a Meta purchase worth" with two different numbers for one account.
 *
 * These cases resolve the REAL profile the route serves, through the same
 * function with the same inputs, and pin the canonical rule on it:
 *
 * - Meta's own 90-day attributed purchase AOV over the configured Target ROAS
 *   is the unit, even when a fully proven store observation is present.
 * - A missing Meta AOV HOLDS and names the absence; the store never stands in.
 * - The store's number is still carried as evidence, so nothing is hidden.
 * - `observed_shopify_aov` stays a readable `SpendUnitSource` for profiles
 *   persisted while it was a rung, and is never minted again.
 */
import { describe, expect, it } from "vitest";
import { resolveAccountDecisionProfile } from "@/lib/creative-decision-engine/account-decision-profile";
import {
  AnchorProfileDataSource,
  makeAnchorFlags,
  makeAnchorTargetPack,
} from "@/lib/creative-decision-engine/__tests__/anchor-profile-fixture";
import { makeAccountCalibration } from "@/lib/creative-decision-engine/__tests__/helpers";
import { resolveSpendUnit } from "@/lib/creative-decision-engine/spend-unit-resolver";
import type { AccountCalibration, SpendUnitSource } from "@/lib/creative-decision-engine/types";
import type { ObservedShopifyAovEvidence } from "@/lib/creative-decision-engine/shopify-aov-source";
import {
  revalidateMetaStructureLanesForAccountProfile,
  targetHardActionEligibilityFromAccountProfile,
} from "@/lib/meta/decisions-os-presentation";
import { metaLanePayload, metaRec } from "@/components/meta/redesign/test-fixtures";

/** Grandmix's shape: a Target ROAS and nothing the product declares optional. */
const TARGET_PACK = makeAnchorTargetPack({
  targetCpa: null,
  operatorAovAssumption: null,
  targetRoas: 2.2,
  breakEvenRoas: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
  freshness: "fresh",
});

/** 58.00 USD over 60 settled orders in a proven, closed 28-day window. */
function provenStoreAov(): ObservedShopifyAovEvidence {
  return {
    contract: "meta.observed-shopify-aov.v1",
    status: "observed",
    source: "shopify_revenue_ledger",
    providerAccountId: "grandmix.myshopify.com",
    revenueBasis: "net_ledger",
    window: { from: "2026-08-08", to: "2026-09-04" },
    zoneName: "UTC",
    orderCount: 60,
    currency: "USD",
    currencyExponent: 2,
    revenueMinor: 348_000,
    aovMinor: 5_800,
    observedAt: "2026-09-04T00:00:00.000Z",
    knowledgeAsOf: "2026-09-04T12:00:00.000Z",
  };
}

/**
 * The exact call the workspace route makes, minus the warehouse.
 *
 * `resolveAccountDecisionProfile` does no IO for the store evidence by design —
 * the route resolves it in `resolveServeTimeObservedShopifyAov` and hands it
 * over — so a fake data source plus that one argument reproduces the served
 * resolution faithfully.
 */
async function serveAnchor(input: {
  calibration: AccountCalibration;
  observedShopifyAov: ObservedShopifyAovEvidence | null;
}) {
  const profile = await resolveAccountDecisionProfile({
    businessId: "biz-1",
    asOf: "2026-09-04",
    dataSource: new AnchorProfileDataSource(TARGET_PACK, input.calibration),
    flags: makeAnchorFlags(),
    observedShopifyAov: input.observedShopifyAov,
  });
  const anchor = profile.hardActionEligibility.anchor;
  // The profile always builds one; a missing anchor is a contract breach, not
  // a case to skip quietly.
  if (!anchor) throw new Error("hardActionEligibility.anchor was not produced");
  return { profile, anchor };
}

/** A ready Meta sample: 50.00 mean over 42 attributed purchases. */
const META_READY = makeAccountCalibration({
  metaAttributedAovMean90d: 50,
  metaAttributedAovPurchaseCount90d: 42,
  metaAttributedRevenue90d: 2_100,
  metaAovQuality: "ready",
});

/** No Meta-attributed purchases at all, and no account CPA history either. */
const META_ABSENT = makeAccountCalibration({
  metaAttributedAovMean90d: null,
  metaAttributedAovPurchaseCount90d: 0,
  metaAttributedRevenue90d: 0,
  metaAovQuality: "unavailable",
  accountCpaP50: null,
  accountCpaSampleCount: 0,
});

describe("served Meta anchor is sized from the Meta platform AOV", () => {
  it("divides Meta's attributed AOV by Target ROAS while the store is present", async () => {
    const { profile, anchor } = await serveAnchor({
      calibration: META_READY,
      observedShopifyAov: provenStoreAov(),
    });

    expect(anchor.spendUnitSource).toBe("meta_derived_aov");
    expect(anchor.status).toBe("eligible_meta_derived_aov");
    // 50.00 / 2.20 = 22.73 — the Meta basis. The store's 58.00 / 2.20 = 26.36
    // is the number this surface used to serve.
    expect(anchor.spendUnit).toBeCloseTo(22.7273, 4);
    expect(anchor.thresholdEligible).toBe(true);
    expect(anchor.missingInputs).toEqual([]);
    expect(anchor.lineage.metaAttributedAovMean90d).toBe(50);
    expect(anchor.lineage.metaAttributedAovPurchaseCount90d).toBe(42);
    expect(profile.spendUnitEvidence.breakEvenRoas).toBeNull();
    expect(targetHardActionEligibilityFromAccountProfile(
      profile.hardActionEligibility,
    )).toMatchObject({ scale: true, cut: true, refresh: true });

    const cut = metaRec({
      id: "target-roas-cut",
      decisionLabel: "cut",
      actionKind: "execute_pause",
      proposedAction: { kind: "pause" },
    });
    const servedLanes = revalidateMetaStructureLanesForAccountProfile(
      metaLanePayload({
        actionNow: [cut],
        watching: [],
        counts: {
          actionNow: 1,
          watching: 0,
          healthy: 1,
          nonSales: 0,
          archive: 0,
        },
      }),
      profile.hardActionEligibility,
    );
    expect(servedLanes.actionNow).toEqual([cut]);
    expect(servedLanes.watching).toEqual([]);
  });

  it("keeps a no-ratio Cut blocked when the canonical profile blocks it", () => {
    expect(targetHardActionEligibilityFromAccountProfile({
      scale: false,
      cut: false,
      refresh: true,
    })).toEqual({ scale: false, cut: false, refresh: true });

    const cut = metaRec({
      id: "no-ratio-cut",
      decisionLabel: "cut",
      actionKind: "execute_pause",
      proposedAction: { kind: "pause" },
    });
    const servedLanes = revalidateMetaStructureLanesForAccountProfile(
      metaLanePayload({
        actionNow: [cut],
        watching: [],
        counts: {
          actionNow: 1,
          watching: 0,
          healthy: 1,
          nonSales: 0,
          archive: 0,
        },
      }),
      { scale: false, cut: false, refresh: true },
    );
    expect(servedLanes.actionNow).toEqual([]);
    expect(servedLanes.watching[0]).toMatchObject({
      id: "no-ratio-cut",
      decisionState: "watch",
      actionKind: "review_drill",
    });
  });

  it("carries the store's own number as evidence beside the Meta unit", async () => {
    const { profile } = await serveAnchor({
      calibration: META_READY,
      observedShopifyAov: provenStoreAov(),
    });

    // Diagnostic, not authority: an operator can still read what the merchant's
    // books said next to the unit the decision was sized from.
    expect(profile.spendUnitEvidence.observedShopifyAov).toBe(58);
    expect(profile.spendUnitEvidence.observedShopifyAovOrderCount).toBe(60);
    expect(profile.spendUnitEvidence.observedShopifyAovStatus).toBe("observed");
    expect(profile.spendUnit).toBeCloseTo(22.7273, 4);
  });

  it("holds explicitly when Meta has no AOV, with the store fully proven", async () => {
    const { profile, anchor } = await serveAnchor({
      calibration: META_ABSENT,
      observedShopifyAov: provenStoreAov(),
    });

    expect(anchor.spendUnitSource).toBe("insufficient");
    expect(anchor.spendUnit).toBeNull();
    expect(anchor.status).toBe("blocked_missing_owner_anchor");
    expect(anchor.thresholdEligible).toBe(false);
    expect(profile.hardActionEligibility.cut).toBe(false);
    expect(profile.hardActionEligibility.refresh).toBe(false);
    expect(profile.hardActionEligibility.scale).toBe(false);
    expect(anchor.actions.cut.blockerCode).toBe("commercial_anchor_missing");
    expect(anchor.actions.refresh.blockerCode).toBe(
      "commercial_anchor_missing",
    );
    // The hold is legible beside what the store said, rather than replacing it.
    expect(profile.spendUnitEvidence.observedShopifyAov).toBe(58);
    expect(profile.spendUnitEvidence.warnings).toContain("meta_aov_unavailable");

    const projectedEligibility =
      targetHardActionEligibilityFromAccountProfile(
        profile.hardActionEligibility,
      );
    expect(projectedEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
      codes: {
        scale: "commercial_anchor_missing",
        cut: "commercial_anchor_missing",
        refresh: "commercial_anchor_missing",
      },
    });
    expect(projectedEligibility.reasons?.refresh).toBe(
      profile.hardActionEligibility.reasons?.refresh,
    );
    expect(projectedEligibility.missingInputs).toContain(
      "meta_attributed_purchase_sample",
    );

    const cut = metaRec({
      id: "missing-meta-aov-cut",
      decisionLabel: "cut",
      actionKind: "execute_pause",
      proposedAction: { kind: "pause" },
    });
    const servedLanes = revalidateMetaStructureLanesForAccountProfile(
      metaLanePayload({
        actionNow: [cut],
        watching: [],
        counts: {
          actionNow: 1,
          watching: 0,
          healthy: 1,
          nonSales: 0,
          archive: 0,
        },
      }),
      profile.hardActionEligibility,
    );
    expect(servedLanes.watching[0]).toMatchObject({
      primaryActionLabel: "Review Meta Purchase Evidence",
      watchSegment: "insufficient_signal",
      rowPresentation: {
        blockerLabel: "Meta purchase value evidence is unavailable",
      },
    });
    expect(JSON.stringify(servedLanes.watching[0])).not.toMatch(
      /break-even ROAS/i,
    );
  });

  it("serves a thin Meta AOV as an evidence hold rather than a missing target", async () => {
    const { profile } = await serveAnchor({
      calibration: makeAccountCalibration({
        metaAttributedAovMean90d: 50,
        metaAttributedAovPurchaseCount90d: 3,
        metaAttributedRevenue90d: 150,
        metaAovQuality: "low_sample",
        accountCpaP50: null,
        accountCpaSampleCount: 0,
      }),
      observedShopifyAov: provenStoreAov(),
    });
    expect(profile.hardActionEligibility.codes?.cut).toBe(
      "commercial_anchor_sample_insufficient",
    );
    expect(
      targetHardActionEligibilityFromAccountProfile(
        profile.hardActionEligibility,
      ),
    ).toMatchObject({
      refresh: false,
      codes: { refresh: "commercial_anchor_sample_insufficient" },
      missingInputs: ["meta_attributed_purchase_sample"],
    });

    const cut = metaRec({
      id: "thin-meta-aov-cut",
      decisionLabel: "cut",
      actionKind: "execute_pause",
      proposedAction: { kind: "pause" },
    });
    const servedLanes = revalidateMetaStructureLanesForAccountProfile(
      metaLanePayload({
        actionNow: [cut],
        watching: [],
        counts: {
          actionNow: 1,
          watching: 0,
          healthy: 1,
          nonSales: 0,
          archive: 0,
        },
      }),
      profile.hardActionEligibility,
    );
    expect(servedLanes.watching[0]).toMatchObject({
      primaryActionLabel: "Review Meta Purchase Evidence",
      watchSegment: "insufficient_signal",
      rowPresentation: {
        blockerLabel: "Meta purchase sample is still too small",
      },
    });
    expect(JSON.stringify(servedLanes.watching[0])).not.toMatch(
      /break-even ROAS/i,
    );
  });

  it("resolves identically with and without the store evidence", async () => {
    const withStore = await serveAnchor({
      calibration: META_READY,
      observedShopifyAov: provenStoreAov(),
    });
    const withoutStore = await serveAnchor({
      calibration: META_READY,
      observedShopifyAov: null,
    });

    // The store cannot move the unit, the source, the threshold or any action.
    expect(withStore.anchor.spendUnit).toBe(withoutStore.anchor.spendUnit);
    expect(withStore.anchor.spendUnitSource).toBe(
      withoutStore.anchor.spendUnitSource,
    );
    expect(withStore.anchor.thresholdEligible).toBe(
      withoutStore.anchor.thresholdEligible,
    );
    expect(withStore.profile.hardActionEligibility.codes).toEqual(
      withoutStore.profile.hardActionEligibility.codes,
    );
  });
});

describe("the retired store basis stays readable and is never re-minted", () => {
  it("keeps observed_shopify_aov a legal persisted SpendUnitSource", () => {
    // Profiles written while the rung existed name this basis. Dropping it from
    // the union would make those rows unreadable, which is the migration this
    // product does not do.
    const persisted: SpendUnitSource = "observed_shopify_aov";
    expect(persisted).toBe("observed_shopify_aov");
  });

  it("never chooses it, for any combination of the inputs that used to", () => {
    const store = [
      { observedShopifyAov: 58, observedShopifyAovStatus: "observed" },
      { observedShopifyAov: null, observedShopifyAovStatus: "unavailable" },
    ];
    const meta = [
      {
        metaAttributedAovMean90d: 50,
        metaAttributedAovPurchaseCount90d: 42,
        metaAttributedRevenue90d: 2_100,
      },
      {
        metaAttributedAovMean90d: 50,
        metaAttributedAovPurchaseCount90d: 3,
        metaAttributedRevenue90d: 150,
      },
      {
        metaAttributedAovMean90d: null,
        metaAttributedAovPurchaseCount90d: 0,
        metaAttributedRevenue90d: 0,
      },
    ];
    const owner = [
      { targetCpa: null, operatorAovAssumption: null },
      { targetCpa: 30, operatorAovAssumption: null },
      { targetCpa: null, operatorAovAssumption: 40 },
    ];
    const history = [
      { accountCpaP50: null, accountCpaSampleCount: 0 },
      { accountCpaP50: 35, accountCpaSampleCount: 24 },
    ];
    const roas = [
      { targetRoas: 2.2, breakEvenRoas: null },
      { targetRoas: null, breakEvenRoas: 1.8 },
    ];

    const sources = new Set<SpendUnitSource>();
    for (const s of store) {
      for (const m of meta) {
        for (const o of owner) {
          for (const h of history) {
            for (const r of roas) {
              sources.add(
                resolveSpendUnit({
                  ...s,
                  ...m,
                  ...o,
                  ...h,
                  ...r,
                  attributionAovAdjustmentMultiplier: 1,
                }).source,
              );
            }
          }
        }
      }
    }

    expect(sources.has("observed_shopify_aov")).toBe(false);
    // The sweep is meaningful only because it reaches the real rungs.
    expect(sources.has("meta_derived_aov")).toBe(true);
    expect(sources.has("insufficient")).toBe(true);
  });
});
