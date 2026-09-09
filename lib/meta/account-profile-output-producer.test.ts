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
  ACCOUNT_PROFILE_OUTPUT_PRODUCER_CONTRACT,
  accountProfileMeasuredScopeHold,
  accountProfileRetentionIdentity,
  businessPooledMeasurementScope,
  resolveAccountProfileMeasurementScope,
  type AccountProfileRetentionInputs,
} from "@/lib/meta/account-profile-output-producer";
import { reconcileProfileIdentityExpectation } from "@/lib/meta/budget-readiness-retention";
import type { AccountCalibration } from "@/lib/creative-decision-engine/types";

const BIZ = "d0000000-0000-4000-8000-000000000501";
const ACCOUNT = "act_5000000000001";

it("mints the pinned strict-AOV producer contract", () => {
  expect(ACCOUNT_PROFILE_OUTPUT_PRODUCER_CONTRACT).toBe(
    "meta.account-profile-output-producer.v2",
  );
});

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
  // Deliberately differs from the legacy creative-day calibration AOV above.
  strictMetaAov: {
    status: "resolved",
    value: {
      aovMean: 58,
      purchaseCount: 32,
      totalRevenue: 1856,
      windowStart: "2026-06-07",
      windowEnd: "2026-09-04",
    },
  },
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
  /*
    The measured facts above came from this account's own retained calibration
    scope, which is what makes them fixed for the day. `absent` would mean the
    funnel pack is empty because nobody measured it and the calibration is a
    live aggregate — facts no identity may be stamped on.
  */
  measuredScope: "materialised",
  /*
    Only consulted while no account of the business has a scope of its own, and
    the fixture above is materialised — so this reports the state a source that
    was never asked reports, and it can never be read as `sole_account`.
  */
  populationBreadth: "unprobed",
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

  /*
    ── ROUND 6 ITEM 3: ONE FIELD AT A TIME, WHILE A TARGET ROAS GOVERNS ─────
    Everything the canonical rule calls unauthoritative must be unable to move
    either fingerprint. Both halves are asserted on every permutation, because
    the two doors are different: the operator's typed numbers reach
    `input_fingerprint` through the target pack and `profileConfig`, while the
    account's own measured CPA reaches `source_fingerprint` through the
    calibration.

    Each row changes exactly ONE field, so a failure names the field.
  */
  const CONFIGURED_NON_AUTHORITATIVE: Array<
    [string, Partial<AccountProfileRetentionInputs>]
  > = [
    ["a typed Target CPA", { targetPack: { ...inputs().targetPack!, targetCpa: 31 } }],
    ["a typed break-even CPA", { targetPack: { ...inputs().targetPack!, breakEvenCpa: 44 } }],
    [
      "an operator AOV assumption",
      { targetPack: { ...inputs().targetPack!, operatorAovAssumption: 900 } },
    ],
    [
      /*
        ROUND 9 ITEM 2. The value moved from `T23:59:00Z` to `T02:59:00Z`, and
        the reason is not cosmetic: `asOfDate` is `2026-09-04`, whose
        deterministic cutoff is `2026-09-04T03:00:00.000Z`. A pack stamped
        `T23:59:00Z` is stamped AFTER the moment this row reconstructs, so it
        is no longer an inert re-save — it is evidence the identity is not
        allowed to have seen, and it now correctly moves the fingerprint. The
        post-cutoff case is asserted in its own right below.

        Within the cutoff, an advancing clock is still inert, which is what
        this row was written to hold.
      */
      "a re-save that only advances the row clock, within the cutoff",
      {
        targetPack: {
          ...inputs().targetPack!,
          updatedAt: "2026-09-04T02:59:00.000Z",
        },
      },
    ],
  ];

  it.each(CONFIGURED_NON_AUTHORITATIVE)(
    "does not move either fingerprint on %s",
    (_name, over) => {
      const base = accountProfileRetentionIdentity(inputs());
      const changed = accountProfileRetentionIdentity(inputs(over));
      expect(changed.inputFingerprint).toBe(base.inputFingerprint);
      expect(changed.sourceFingerprint).toBe(base.sourceFingerprint);
    },
  );

  /*
    ── ROUND 9 ITEM 2: THE CUTOFF IS PART OF THE IDENTITY ────────────────────
    `asOfDate: "2026-09-04"` widens to the deterministic cutoff
    `2026-09-04T03:00:00.000Z` — the same rule `normalizeAsOfCutoff` applies
    when the historical pack is read, so the identity and the reader cannot
    disagree about which pack was in force.
  */
  it("MOVES the configured fingerprint when the pack is stamped after the cutoff", () => {
    /*
      Before Round 9 this was inert: `commercialTargetProvenanceState` asked
      only whether `updatedAt` PARSED, so a pack saved after the day being
      reconstructed digested as `trusted` — identical bytes to one that really
      was in force. A retained verdict could then keep an authority grant
      justified by evidence that did not exist when it was minted.
    */
    const base = accountProfileRetentionIdentity(inputs());
    const afterCutoff = accountProfileRetentionIdentity(
      inputs({
        targetPack: {
          ...inputs().targetPack!,
          updatedAt: "2026-09-04T03:00:00.001Z",
        },
      }),
    );
    expect(afterCutoff.inputFingerprint).not.toBe(base.inputFingerprint);
    // The MEASURED half is untouched by a configured-side clock.
    expect(afterCutoff.sourceFingerprint).toBe(base.sourceFingerprint);
  });

  it("holds the exact 1 ms boundary in both directions", () => {
    /*
      The boundary itself, so a future widening has to face this line. At the
      cutoff is IN; one millisecond past it is OUT.
    */
    const base = accountProfileRetentionIdentity(inputs());
    const atCutoff = accountProfileRetentionIdentity(
      inputs({
        targetPack: {
          ...inputs().targetPack!,
          updatedAt: "2026-09-04T03:00:00.000Z",
        },
      }),
    );
    const oneMsPast = accountProfileRetentionIdentity(
      inputs({
        targetPack: {
          ...inputs().targetPack!,
          updatedAt: "2026-09-04T03:00:00.001Z",
        },
      }),
    );
    expect(atCutoff.inputFingerprint).toBe(base.inputFingerprint);
    expect(oneMsPast.inputFingerprint).not.toBe(base.inputFingerprint);
  });

  it("moves the configured fingerprint across a same-ms microsecond cutoff", () => {
    const beforeCutoff = accountProfileRetentionIdentity(
      inputs({
        asOfDate: "2026-09-04T03:00:00.000100Z",
        targetPack: {
          ...inputs().targetPack!,
          updatedAt: "2026-09-04T03:00:00.000100Z",
        },
      }),
    );
    const afterCutoff = accountProfileRetentionIdentity(
      inputs({
        asOfDate: "2026-09-04T03:00:00.000100Z",
        targetPack: {
          ...inputs().targetPack!,
          updatedAt: "2026-09-04T03:00:00.000900Z",
        },
      }),
    );
    expect(afterCutoff.inputFingerprint).not.toBe(
      beforeCutoff.inputFingerprint,
    );
    expect(afterCutoff.sourceFingerprint).toBe(
      beforeCutoff.sourceFingerprint,
    );
  });

  it("does not move either fingerprint on the INERT attribution multiplier", () => {
    /*
      `attributionAovAdjustmentMultiplier` is accepted and pinned to 1 on every
      rung of `resolveSpendUnit`, and never written into `SpendUnitEvidence`,
      precisely so it cannot reach a unit, a threshold, an eligibility or a
      verdict. `profileConfig` was digested RAW, so it entered retention
      identity through the one door the resolver had carefully closed.

      Both sides carry a profileConfig and differ ONLY in that member, so a
      pass cannot come from the object being absent on one side.
    */
    const config = (
      attributionAovAdjustmentMultiplier: number | null,
    ): NonNullable<AccountProfileRetentionInputs["profileConfig"]> => ({
      enginePresetLabel: null,
      zeroConvBurnerMultiplier: null,
      cutCandidateMultiplier: null,
      sustainedLoserMultiplier: null,
      hardCutMultiplier: null,
      scalePurchaseMultiplier: null,
      winnerMemoryMultiplier: null,
      recentSampleMultiplier: null,
      weakFunnelRateMultiplier: null,
      attributionAovAdjustmentMultiplier,
    });
    const base = accountProfileRetentionIdentity(
      inputs({ profileConfig: config(1) }),
    );
    const typed = accountProfileRetentionIdentity(
      inputs({ profileConfig: config(1.35) }),
    );
    expect(typed.inputFingerprint).toBe(base.inputFingerprint);
    expect(typed.sourceFingerprint).toBe(base.sourceFingerprint);

    // The control: a knob the resolver DOES read still moves identity, so the
    // projection is not simply discarding the whole object.
    const otherKnob = accountProfileRetentionIdentity(
      inputs({
        profileConfig: { ...config(1), hardCutMultiplier: 2.5 },
      }),
    );
    expect(otherKnob.inputFingerprint).not.toBe(base.inputFingerprint);
  });

  it("does not move either fingerprint on the account's own measured CPA", () => {
    /*
      `accountCpaP50` / `accountCpaSampleCount` were deliberately KEPT hashed
      while `resolveSpendUnit`'s governed branch could still fall through to
      the `account_history` rung, where the account's median CPA genuinely
      chose the unit. That branch now answers READY-or-`insufficient`, so the
      measured CPA chooses nothing here and must not discard a retained verdict
      by moving `source_fingerprint`.
    */
    const base = accountProfileRetentionIdentity(inputs());
    const remeasured = accountProfileRetentionIdentity(
      inputs({
        accountCalibration: calibration({
          accountCpaP50: 99,
          accountCpaSampleCount: 4,
        }),
      }),
    );
    expect(remeasured.sourceFingerprint).toBe(base.sourceFingerprint);
    expect(remeasured.inputFingerprint).toBe(base.inputFingerprint);
  });

  it("DOES move the configured half when target provenance stops being trusted", () => {
    /*
      ROUND 6 ITEM 4. Removing the raw `updatedAt`/`freshness` from the digest
      made every provenance state hash the same — and provenance changes what
      the engine may DO: `resolveSpendUnitProfile` demotes the confidence when
      a pack carries no trustworthy timestamp, which closes the hard-action
      gate. An identity blind to that would retain a verdict minted while the
      pack was trusted after its provenance became unknown.
    */
    const base = accountProfileRetentionIdentity(inputs());
    for (const degraded of [
      { ...inputs().targetPack!, freshness: "stale" as const },
      { ...inputs().targetPack!, freshness: "unknown" as const },
      { ...inputs().targetPack!, updatedAt: null },
    ]) {
      const moved = accountProfileRetentionIdentity(
        inputs({ targetPack: degraded }),
      );
      expect(
        moved.inputFingerprint,
        JSON.stringify({
          freshness: degraded.freshness,
          updatedAt: degraded.updatedAt,
        }),
      ).not.toBe(base.inputFingerprint);
    }
  });

  it("keeps the legacy CPA keying identity when NO Target ROAS governs", () => {
    // The compatibility half: without a ratio the typed CPA is the anchor, so
    // it must still move the configured fingerprint.
    const legacyPack = {
      ...inputs().targetPack!,
      targetRoas: null,
      targetCpa: 31,
    };
    const base = accountProfileRetentionIdentity(
      inputs({ targetPack: legacyPack }),
    );
    const edited = accountProfileRetentionIdentity(
      inputs({ targetPack: { ...legacyPack, targetCpa: 47 } }),
    );
    expect(edited.inputFingerprint).not.toBe(base.inputFingerprint);
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

  /*
    RE-PINNED, IN THE OPPOSITE DIRECTION. This case used to assert
    `moved.sourceFingerprint).not.toBe(original.sourceFingerprint)` — that a
    store-only change MOVES the measured half. It was green, specific, and it
    pinned a defect.

    `sourceFingerprint` is persisted as
    `engine_v3_account_profile_output.source_fingerprint` and is part of that
    table's UNIQUE key; `budget-readiness-retention.ts` compares it and answers
    `retained_profile_source_mismatch` when it moves, discarding the retained
    verdict. Under D091 the store's AOV chooses no rung, so it cannot change
    the verdict — which made this the exact provenance mismatch D091 forbids: a
    number with no authority over the decision silently invalidating it.
  */
  it("does NOT move the measured half when only the store's evidence moves", () => {
    const base = inputs();
    const original = accountProfileRetentionIdentity(base);

    // Three independent store-only changes: the value, the sample, and the
    // availability status. None of them is a rung, so none may key an identity.
    for (const store of [
      { ...base.observedShopifyAov!, aovMinor: 6_100 },
      { ...base.observedShopifyAov!, orderCount: 941 },
      { ...base.observedShopifyAov!, status: "stale" as const },
    ]) {
      const moved = accountProfileRetentionIdentity(
        inputs({ observedShopifyAov: store }),
      );
      expect(moved.sourceFingerprint).toBe(original.sourceFingerprint);
      expect(moved.inputFingerprint).toBe(original.inputFingerprint);
    }

    // Dropping the store reading entirely is likewise not an identity change:
    // an account that never had Shopify and one whose store went unavailable
    // must be able to hold the same retained Meta verdict.
    expect(
      accountProfileRetentionIdentity(inputs({ observedShopifyAov: null }))
        .sourceFingerprint,
    ).toBe(original.sourceFingerprint);
  });

  /*
    The other half of the invariant: narrowing the digest must not make it
    inert. A Meta-side measurement that CAN move the verdict still moves it.
  */
  it("moves the measured half when the canonical strict Meta AOV moves", () => {
    const original = accountProfileRetentionIdentity(inputs());
    const moved = accountProfileRetentionIdentity(inputs({
      strictMetaAov: {
        status: "resolved",
        value: {
          aovMean: 77.5,
          purchaseCount: 32,
          totalRevenue: 2480,
          windowStart: "2026-06-07",
          windowEnd: "2026-09-04",
        },
      },
    }));
    expect(moved.sourceFingerprint).not.toBe(original.sourceFingerprint);
    expect(moved.inputFingerprint).toBe(original.inputFingerprint);
  });

  it("does not move identity when only legacy calibration AOV changes under Target ROAS", () => {
    const original = accountProfileRetentionIdentity(inputs());
    const moved = accountProfileRetentionIdentity(inputs({
      accountCalibration: calibration({
        metaAttributedAovMean90d: 777,
        metaAttributedAovPurchaseCount90d: 3,
        metaAttributedRevenue90d: 2331,
        metaAovQuality: "unstable",
      }),
    }));
    expect(moved).toEqual(original);
  });

  it("moves the MEASURED half when the calibration sample moves", () => {
    const original = accountProfileRetentionIdentity(inputs());
    const moved = accountProfileRetentionIdentity(inputs({
      accountCalibration: calibration({ matureCreativeCount: 31 }),
    }));
    expect(moved.sourceFingerprint).not.toBe(original.sourceFingerprint);
    expect(moved.inputFingerprint).toBe(original.inputFingerprint);
  });

  it("preserves no-ROAS legacy AOV identity and its strict fallback", () => {
    const noRoas = { ...inputs().targetPack!, targetRoas: null, targetCpa: 31 };
    const legacy = accountProfileRetentionIdentity(inputs({
      targetPack: noRoas,
      strictMetaAov: { status: "not_read" },
    }));
    const legacyMoved = accountProfileRetentionIdentity(inputs({
      targetPack: noRoas,
      strictMetaAov: { status: "not_read" },
      accountCalibration: calibration({
        metaAttributedAovMean90d: 41,
        metaAttributedRevenue90d: 1312,
      }),
    }));
    expect(legacyMoved.sourceFingerprint).not.toBe(legacy.sourceFingerprint);

    const withoutLegacy = calibration({
      metaAttributedAovMean90d: null,
      metaAttributedAovPurchaseCount90d: 0,
      metaAttributedRevenue90d: 0,
      metaAovQuality: "unavailable",
    });
    const fallback = accountProfileRetentionIdentity(inputs({
      targetPack: noRoas,
      accountCalibration: withoutLegacy,
    }));
    const fallbackMoved = accountProfileRetentionIdentity(inputs({
      targetPack: noRoas,
      accountCalibration: withoutLegacy,
      strictMetaAov: {
        status: "resolved",
        value: {
          aovMean: 64,
          purchaseCount: 19,
          totalRevenue: 1216,
          windowStart: "2026-06-07",
          windowEnd: "2026-09-04",
        },
      },
    }));
    expect(fallbackMoved.sourceFingerprint).not.toBe(fallback.sourceFingerprint);
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

/**
 * WHICH READINGS MAY BE STAMPED WITH AN IDENTITY AT ALL.
 *
 * The producer reads the measured half per account. When the calibration job
 * has not materialised that account's own scope, the readers still answer — an
 * empty funnel pack and a runtime aggregate — and both are unusable as an
 * identity for the same underlying reason: the first is indistinguishable from a
 * genuinely empty account and the second is recomputed on every read, so the
 * verdict stops agreeing with its own expectation as soon as the account's sync
 * writes one row. Retaining it would send a fully evidenced account to a
 * mismatch hold at approval time; this is where that becomes a named refusal
 * instead.
 */
describe("the measured scope a verdict may be built on", () => {
  it("passes a scope the calibration job has materialised", () => {
    expect(accountProfileMeasuredScopeHold("materialised")).toBeNull();
  });

  it("holds by name when the account has no scope of its own", () => {
    expect(accountProfileMeasuredScopeHold("absent"))
      .toBe("account_calibration_scope_not_materialised");
  });

  it("holds by a DIFFERENT name when the warehouse could not be asked", () => {
    /*
      A probe that threw proves nothing about what the table holds, so it is
      neither reported as materialised nor confused with a genuine absence.
    */
    expect(accountProfileMeasuredScopeHold("unreadable"))
      .toBe("account_calibration_scope_unreadable");
  });

  it("passes a source that has no such fact to report", () => {
    /*
      An injected double answers the measured reads itself and models no
      precomputed table, so there is nothing to check its facts against. Every
      production path runs against the warehouse source, which reports one of
      the three real states.
    */
    expect(accountProfileMeasuredScopeHold("unprobed")).toBeNull();
  });

  it("passes a warehouse that has never written ANY per-account scope", () => {
    /*
      That state is a fact about the WAREHOUSE, not about this account.
      Refusing it would blank every healthy account until a calibration run —
      the deploy-day regression this delivery has already had to repair twice.
      The verdict is produced; what changes is the population it is measured
      from, which is settled by the resolver below and never by this hold.
    */
    expect(
      accountProfileMeasuredScopeHold("per_account_scopes_unwritten"),
    ).toBeNull();
  });
});

/**
 * WHOSE EVIDENCE A BOOTSTRAP VERDICT RESTS ON.
 *
 * The state where no account of a business has a calibration scope of its own
 * used to be answered from the BUSINESS-POOLED population and labelled
 * `business_pooled`. The label was accurate and it granted authority anyway: an
 * account with six mature converters beside a sibling with thirty-two was
 * served — and had retained under its own `provider_account_id` — a `scale`
 * verdict only the pooled thirty-eight could reach.
 *
 * The population is now always this account's. Only the READ that reaches it
 * moves, and it moves on a fact proved from the warehouse rows.
 */
describe("the population a bootstrap verdict is measured from", () => {
  const bootstrap = (
    populationBreadth: AccountProfileRetentionInputs["populationBreadth"],
  ) =>
    resolveAccountProfileMeasurementScope({
      status: "per_account_scopes_unwritten",
      populationBreadth,
      providerAccountId: ACCOUNT,
      asOfDate: "2026-09-04",
    });

  it("never answers a named account from the business's pooled population", () => {
    for (const breadth of [
      "sole_account",
      "multiple_accounts",
      "unreadable",
      "unprobed",
    ] as const) {
      const measurement = bootstrap(breadth);
      expect(measurement.scope).toBe("account");
      expect(measurement.providerAccountId).toBe(ACCOUNT);
      expect(measurement.hold).toBeNull();
    }
  });

  it("reads the pooled row only where it IS this account's rows", () => {
    /*
      The business's warehouse holds rows for no other ad account, so the pooled
      `scope_id '*'` statement ran over exactly this account's rows. Reading it
      borrows nothing and keeps the day's reading fixed.
    */
    const measurement = bootstrap("sole_account");
    expect(measurement.basis).toBe("sole_account_pooled_rows");
    expect(measurement.readProviderAccountId).toBeNull();
    expect(measurement.why).toContain("nothing else");
  });

  it("scopes the reads to the account in every other case", () => {
    for (const breadth of ["multiple_accounts", "unreadable", "unprobed"] as const) {
      const measurement = bootstrap(breadth);
      expect(measurement.basis).toBe("account_runtime_aggregate");
      expect(measurement.readProviderAccountId).toBe(ACCOUNT);
    }
  });

  it("gives the two bootstrap readings different identities", () => {
    /*
      A sole-account business's pooled row and a runtime aggregate over the same
      rows carry identical NUMBERS. They are still reached differently — one is
      fixed for the day and one is not — so a reader must be able to tell which
      a retained verdict rested on, and the digest is where that lives.
    */
    const sole = accountProfileRetentionIdentity(
      inputs({
        measuredScope: "per_account_scopes_unwritten",
        populationBreadth: "sole_account",
      }),
    );
    const runtime = accountProfileRetentionIdentity(
      inputs({
        measuredScope: "per_account_scopes_unwritten",
        populationBreadth: "multiple_accounts",
      }),
    );
    expect(sole.sourceFingerprint).not.toBe(runtime.sourceFingerprint);

    // And neither is the identity a materialised scope carries, so the first
    // calibration run that covers this account ends the bootstrap reading by
    // itself rather than by anyone remembering to invalidate it.
    const materialised = accountProfileRetentionIdentity(inputs());
    expect(materialised.sourceFingerprint).not.toBe(sole.sourceFingerprint);
    expect(materialised.sourceFingerprint).not.toBe(runtime.sourceFingerprint);
  });

  it("keeps the two long-standing bases sharing one identity", () => {
    /*
      `measurementIdentityTag` spells `"account"` for a materialised scope and
      for a source that answers the reads itself — the exact value the digest's
      `measurementScope` field carried before it learned about the bootstrap
      bases. That is what makes them share this fingerprint, and it is why this
      change re-derives no verdict already retained on either of them. The
      bootstrap bases are distinguished from both by the case above.
    */
    expect(accountProfileRetentionIdentity(inputs()).sourceFingerprint).toBe(
      accountProfileRetentionIdentity(inputs({ measuredScope: "unprobed" }))
        .sourceFingerprint,
    );
  });

  it("labels a request that names no account as the business summary", () => {
    /*
      Kept, because a business-wide reading is useful and a reader should be
      able to see that it is one. It grants nothing: a retained commercial
      verdict is keyed on one `provider_account_id`, and this names none.
    */
    const summary = businessPooledMeasurementScope({ asOfDate: "2026-09-04" });
    expect(summary.scope).toBe("business_pooled");
    expect(summary.providerAccountId).toBeNull();
    expect(summary.readProviderAccountId).toBeNull();
    expect(summary.basis).toBe("business_pooled_rows");
    expect(summary.materialisation).toBeNull();
    expect(summary.hold).toBeNull();
  });
});
