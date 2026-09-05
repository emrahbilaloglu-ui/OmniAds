/**
 * The identity a retained commercial verdict is stamped with, and the rule that
 * decides which expectation a reader compares it against.
 *
 * The end-to-end behaviour — the real producer resolving the canonical profile,
 * retaining it, and the budget chain projecting and executing on it — is proven
 * against a real cluster by
 * `scripts/ephemeral-postgres-economics-bid-chain-seam-child.ts`. What cannot be
 * proven there is the property this file exists for: that the digest is stable
 * across two reads of an unchanged account, and that each half moves for exactly
 * the kind of change it names. A digest that drifted on its own would refuse
 * every verdict ever retained; one that ignored an input would let a write rest
 * on commercial truth the operator had already replaced.
 */
import { describe, expect, it } from "vitest";

import {
  accountProfileRetentionIdentity,
  type AccountProfileRetentionInputs,
} from "@/lib/meta/account-profile-output-producer";
import { reconcileProfileIdentityExpectation } from "@/lib/meta/budget-readiness-retention";
import type { AccountCalibration } from "@/lib/creative-decision-engine/types";

const BIZ = "d0000000-0000-4000-8000-000000000501";
const ACCOUNT = "act_5000000000001";

const calibration = (over: Partial<AccountCalibration> = {}): AccountCalibration => ({
  businessId: BIZ,
  // The volatile one: every runtime-SQL read stamps this with `new Date()`.
  computedAt: new Date().toISOString(),
  campaignKind: "all",
  matureCreativeCount: 32,
  roasP75: 3.9,
  roasP60: 3.1,
  refreshRatioP10: 0.8,
  lowCtrP10: 0.9,
  accountCpaP50: 10,
  accountCpaSampleCount: 32,
  metaAttributedAovMean90d: 36,
  metaAttributedAovPurchaseCount90d: 32,
  metaAttributedRevenue90d: 1152,
  matureSpendP50: 10,
  matureSpendP75: 10,
  winnerSpendP25: 10,
  winnerSpendP50: 10,
  winnerPurchaseP50: 1,
  roasRatioP10: 1.6,
  roasRatioP25: 1.6,
  roasRatioP50: 1.6,
  roasRatioP75: 1.6,
  metaAovQuality: "ready",
  ...over,
});

const inputs = (
  over: Partial<AccountProfileRetentionInputs> = {},
): AccountProfileRetentionInputs => ({
  businessId: BIZ,
  providerAccountId: ACCOUNT,
  asOfDate: "2026-09-04",
  accountCurrency: "USD",
  targetPack: {
    targetCpa: null,
    targetRoas: 2.2,
    breakEvenCpa: null,
    breakEvenRoas: 1.8,
    operatorAovAssumption: null,
    defaultRiskPosture: "balanced",
    updatedAt: "2026-09-04T00:00:00.000Z",
    freshness: "fresh",
  },
  profileConfig: null,
  flags: {
    businessId: BIZ,
    enabled: true,
    surfaceVisible: true,
    shadowOnly: false,
    presetOverride: null,
    source: {
      enabled: "env", surfaceVisible: "env", shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: { enabled: true, surfaceVisible: true, shadowOnly: false },
  } as AccountProfileRetentionInputs["flags"],
  accountCalibration: calibration(),
  funnelCalibration: { campaignKind: "all", byFormat: {} },
  observedShopifyAov: {
    contract: "meta.observed-shopify-aov.v1",
    status: "observed",
    source: "shopify_revenue_ledger",
    providerAccountId: "economics-seam.myshopify.test",
    revenueBasis: "net_ledger",
    window: { from: "2026-08-08", to: "2026-09-04" },
    zoneName: "UTC",
    orderCount: 30,
    currency: "USD",
    currencyExponent: 2,
    revenueMinor: 174_000,
    aovMinor: 5_800,
    observedAt: "2026-09-03T12:00:00.000Z",
    // The other volatile one: the instant this read happened.
    knowledgeAsOf: new Date().toISOString(),
  },
  ...over,
});

describe("the retained account profile identity", () => {
  it("is stable across two reads of an account that did not change", () => {
    const first = accountProfileRetentionIdentity(inputs());
    const second = accountProfileRetentionIdentity(inputs());
    expect(second).toEqual(first);
    expect(first.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The two halves are different claims and must never collapse into one.
    expect(first.sourceFingerprint).not.toBe(first.inputFingerprint);
  });

  it("ignores the clocks a reader stamps on its own reads", () => {
    /*
      `AccountCalibration.computedAt` is `new Date()` on every runtime-SQL read
      and `ObservedShopifyAovEvidence.knowledgeAsOf` is the read's own instant.
      Digesting either would make the identity differ from itself milliseconds
      later, and every retained verdict would then read as unusable.
    */
    const base = inputs();
    const later = inputs({
      accountCalibration: calibration({ computedAt: "2099-01-01T00:00:00.000Z" }),
      observedShopifyAov: {
        ...base.observedShopifyAov!,
        knowledgeAsOf: "2099-01-01T00:00:00.000Z",
      },
    });
    expect(accountProfileRetentionIdentity(later))
      .toEqual(accountProfileRetentionIdentity(base));
  });

  it("moves the CONFIGURED half when the operator's target moves", () => {
    const base = accountProfileRetentionIdentity(inputs());
    const edited = accountProfileRetentionIdentity(inputs({
      targetPack: { ...inputs().targetPack!, targetRoas: 3.1 },
    }));
    expect(edited.inputFingerprint).not.toBe(base.inputFingerprint);
    // The measurements did not change, so the measured half must not either.
    expect(edited.sourceFingerprint).toBe(base.sourceFingerprint);
  });

  it("moves the MEASURED half when the store's evidence moves", () => {
    const base = inputs();
    const moved = accountProfileRetentionIdentity(inputs({
      observedShopifyAov: { ...base.observedShopifyAov!, aovMinor: 6_100 },
    }));
    const original = accountProfileRetentionIdentity(base);
    expect(moved.sourceFingerprint).not.toBe(original.sourceFingerprint);
    expect(moved.inputFingerprint).toBe(original.inputFingerprint);
  });

  it("moves the MEASURED half when the calibration sample moves", () => {
    const original = accountProfileRetentionIdentity(inputs());
    const moved = accountProfileRetentionIdentity(inputs({
      accountCalibration: calibration({ matureCreativeCount: 31 }),
    }));
    expect(moved.sourceFingerprint).not.toBe(original.sourceFingerprint);
    expect(moved.inputFingerprint).toBe(original.inputFingerprint);
  });

  it("is scoped to one account and one day", () => {
    const original = accountProfileRetentionIdentity(inputs());
    for (const over of [
      { providerAccountId: "act_9999999999999" },
      { asOfDate: "2026-09-03" },
      { businessId: "d0000000-0000-4000-8000-0000000005aa" },
    ]) {
      const other = accountProfileRetentionIdentity(inputs(over));
      expect(other.inputFingerprint).not.toBe(original.inputFingerprint);
      expect(other.sourceFingerprint).not.toBe(original.sourceFingerprint);
    }
  });
});

describe("which expectation a budget reader compares a retained verdict against", () => {
  const derived = { inputFingerprint: "a".repeat(64), sourceFingerprint: "b".repeat(64) };
  const none = { inputFingerprint: null, sourceFingerprint: null };

  it("uses the decision's own digests when the decision carries them", () => {
    // The original law, unchanged: a decision that stamped the profile identity
    // it rested on is the expectation, whether or not the inputs can be re-read.
    expect(reconcileProfileIdentityExpectation(derived, null)).toEqual(derived);
  });

  it("uses the re-derived identity when the decision carries none", () => {
    /*
      No producer in this repository has ever written those digests onto a
      decision, so before this rule existed every real candidate reached
      `classifyRetainedProfile` with a null expectation and was answered
      `profile_identity_agreement_unavailable` — which is why registering the
      table and writing verdicts into it would not by itself have raised a row.
    */
    expect(reconcileProfileIdentityExpectation(none, derived)).toEqual(derived);
  });

  it("requires the two to agree exactly when both exist", () => {
    expect(reconcileProfileIdentityExpectation(derived, derived)).toEqual(derived);
    expect(reconcileProfileIdentityExpectation(
      { inputFingerprint: "c".repeat(64), sourceFingerprint: derived.sourceFingerprint },
      derived,
    )).toEqual(none);
    expect(reconcileProfileIdentityExpectation(
      { inputFingerprint: derived.inputFingerprint, sourceFingerprint: "d".repeat(64) },
      derived,
    )).toEqual(none);
  });

  it("refuses half a decision-carried identity rather than completing it", () => {
    // Pairing one carried digest with the other source's would compare the row
    // against something neither producer ever stamped.
    expect(reconcileProfileIdentityExpectation(
      { inputFingerprint: derived.inputFingerprint, sourceFingerprint: null }, null,
    )).toEqual(none);
    expect(reconcileProfileIdentityExpectation(
      { inputFingerprint: null, sourceFingerprint: derived.sourceFingerprint }, derived,
    )).toEqual(derived);
  });

  it("offers nothing when neither source has an identity", () => {
    expect(reconcileProfileIdentityExpectation(none, null)).toEqual(none);
  });
});
