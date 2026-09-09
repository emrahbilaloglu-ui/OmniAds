import { describe, expect, it } from "vitest";

import {
  buildCanonicalEvaluationProvenance,
  canonicalSha256,
  type BuildCanonicalEvaluationInput,
} from "../canonical-evaluation";
import { buildAdCanonicalEvaluationProvenance } from "../evaluation-store";
import type { EngineV3Flags } from "../feature-flags";
import {
  NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION,
  computeNativeAdCalibrationBatch,
  recomputeNativeAdCalibrationCellInputManifestHash,
  recomputeNativeAdSpendUnitAuthorityHash,
  type NativeAdCalibrationBatch,
  type NativeAdCalibrationSourceRow,
  type NativeAdSpendUnitAuthority,
  type NativeAdTargetAuthorityInput,
} from "../jobs/ad-calibration-job";
import type { ObservedShopifyAovEvidence } from "../shopify-aov-source";
import { resolveSpendUnit } from "../spend-unit-resolver";
import type { DecisionOutput, SpendUnitEvidence } from "../types";
import {
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeDataHealth,
} from "./helpers";

/*
  SHOPIFY IS DIAGNOSTIC-ONLY IN IDENTITY, NOT ONLY IN THE ARITHMETIC.

  Retiring `observed_shopify_aov` as a spend-unit BASIS fixed which number the
  engine divides by and left identity alone, so a store-only change still moved
  hashes it has no business moving. This file pins every hash boundary the store
  observation can reach, in both directions:

    - byte-identity across the full Shopify permutation set, and
    - a MOVE on a genuine Meta-side change, so a hash that has simply stopped
      depending on anything cannot pass by standing still.

  Every producer here is the real one. The authority hashes come out of
  `computeNativeAdCalibrationBatch`; the evaluation hashes come out of
  `buildCanonicalEvaluationProvenance` over a profile whose `spendUnitEvidence`
  is built by the real `resolveSpendUnit`, which is what actually writes the
  Shopify-derived `warnings` entry that used to leak through a second door.
*/

const BUSINESS_ID = "00000000-0000-4000-8000-0000000009a1";
const PROVIDER_ACCOUNT_REF_ID = "00000000-0000-4000-8000-0000000009a2";
const PROVIDER_ACCOUNT_ID = "act-shopify-identity-1";
const AS_OF = "2026-07-12";
const CUTOFF = "2026-07-12T03:05:00.000Z";

const TARGET: NativeAdTargetAuthorityInput = {
  sourceRowId: "00000000-0000-4000-8000-0000000009a9",
  operation: "upsert",
  targetCpa: 50,
  targetRoas: 2,
  breakEvenCpa: 70,
  breakEvenRoas: 1.5,
  operatorAovAssumption: 100,
  defaultRiskPosture: "balanced",
  effectiveAt: "2026-07-01T00:00:00.000Z",
  recordedAt: "2026-07-01T00:00:01.000Z",
};

function makeSourceRow(
  overrides: Partial<NativeAdCalibrationSourceRow> = {},
): NativeAdCalibrationSourceRow {
  const adId = overrides.adId ?? "ad-1";
  const date = overrides.date ?? "2026-07-11";
  return {
    sourceRowId: `${adId}-${date}`,
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    date,
    campaignId: "campaign-1",
    adsetId: "adset-1",
    adId,
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "USD",
    sourceAccountTimezone: "Europe/Istanbul",
    sourceAccountCurrency: "USD",
    metricSchemaVersion: 2,
    objective: "OUTCOME_SALES",
    optimizationGoal: "PURCHASE",
    customEventType: "PURCHASE",
    spend: 100,
    impressions: 10_000,
    clicks: 300,
    linkClicks: 250,
    conversions: 2,
    revenue: 240,
    landingPageViews: 200,
    addToCart: 50,
    initiateCheckout: 20,
    thumbstop: 0.3,
    truthState: "finalized",
    validationStatus: "passed",
    finalizedAt: "2026-07-12T01:00:00.000Z",
    createdAt: "2026-07-12T01:00:00.000Z",
    updatedAt: "2026-07-12T02:00:00.000Z",
    campaignSourceRowId: `campaign-source-${date}`,
    campaignTruthState: "finalized",
    campaignValidationStatus: "passed",
    campaignCreatedAt: "2026-07-12T01:00:00.000Z",
    campaignUpdatedAt: "2026-07-12T02:00:00.000Z",
    adsetSourceRowId: `adset-source-${date}`,
    adsetTruthState: "finalized",
    adsetValidationStatus: "passed",
    adsetCreatedAt: "2026-07-12T01:00:00.000Z",
    adsetUpdatedAt: "2026-07-12T02:00:00.000Z",
    ...overrides,
  };
}

/** Enough Ads and days that the account AOV clears its purchase-sample floor. */
function sourceRows(
  overrides: Partial<NativeAdCalibrationSourceRow> = {},
): NativeAdCalibrationSourceRow[] {
  const dates = ["2026-07-09", "2026-07-10", "2026-07-11"];
  return ["ad-1", "ad-2", "ad-3", "ad-4"].flatMap((adId) =>
    dates.map((date) => makeSourceRow({ adId, date, ...overrides })),
  );
}

function observed(
  overrides: Partial<ObservedShopifyAovEvidence> = {},
): ObservedShopifyAovEvidence {
  return {
    contract: "meta.observed-shopify-aov.v1",
    status: "observed",
    source: "shopify_revenue_ledger",
    providerAccountId: "identity-store.myshopify.com",
    revenueBasis: "net_ledger",
    window: { from: "2026-06-12", to: "2026-07-11" },
    zoneName: "America/Los_Angeles",
    orderCount: 527,
    currency: "USD",
    currencyExponent: 2,
    revenueMinor: 8_160_386,
    aovMinor: 15_485,
    observedAt: "2026-07-11T06:15:03.000Z",
    knowledgeAsOf: "2026-07-12T03:05:01.000Z",
    ...overrides,
  };
}

/**
 * A stated absence, shaped the way `withheld` in `shopify-aov-source.ts` shapes
 * one. `observed_zero_orders` is the exception: it is a complete read of an
 * empty window, so it keeps the store, window and currency it really had.
 */
function withheld(
  status: ObservedShopifyAovEvidence["status"],
): ObservedShopifyAovEvidence {
  return {
    contract: "meta.observed-shopify-aov.v1",
    status,
    source: "shopify_revenue_ledger",
    providerAccountId: null,
    revenueBasis: "net_ledger",
    window: null,
    zoneName: null,
    orderCount: 0,
    currency: null,
    currencyExponent: 2,
    revenueMinor: null,
    aovMinor: null,
    observedAt: null,
    knowledgeAsOf: "2026-07-12T03:05:01.000Z",
    ...(status === "observed_zero_orders"
      ? {
          providerAccountId: "identity-store.myshopify.com",
          window: { from: "2026-06-12", to: "2026-07-11" },
          zoneName: "America/Los_Angeles",
          currency: "USD",
          revenueMinor: 0,
        }
      : {}),
  };
}

/**
 * Every shape the store can put in front of the engine, and nothing else.
 *
 * `undefined` (never consulted) is deliberately in the set. Whether the store
 * was asked at all is itself a Shopify-only fact, and while it was the thing
 * that picked `.v1` vs `.v2` it moved every hash below.
 */
const SHOPIFY_PERMUTATIONS: Array<{
  name: string;
  evidence: ObservedShopifyAovEvidence | null | undefined;
}> = [
  { name: "never consulted", evidence: undefined },
  { name: "consulted, nothing usable", evidence: null },
  { name: "observed", evidence: observed() },
  {
    name: "observed with a different AOV",
    evidence: observed({ aovMinor: 42_100, revenueMinor: 22_186_700 }),
  },
  {
    name: "observed with a different order count",
    evidence: observed({ orderCount: 4 }),
  },
  { name: "stale", evidence: withheld("stale") },
  { name: "unavailable", evidence: withheld("unavailable") },
  { name: "observed_zero_orders", evidence: withheld("observed_zero_orders") },
  { name: "sample_thin", evidence: withheld("sample_thin") },
  {
    name: "orders_backfill_incomplete",
    evidence: withheld("orders_backfill_incomplete"),
  },
  { name: "orders_coverage_gap", evidence: withheld("orders_coverage_gap") },
];

function buildBatch(options: {
  shopify?: ObservedShopifyAovEvidence | null;
  consulted?: boolean;
  revenue?: number;
}): NativeAdCalibrationBatch {
  return computeNativeAdCalibrationBatch({
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    asOf: AS_OF,
    computationCutoff: CUTOFF,
    sourceRows:
      options.revenue === undefined
        ? sourceRows()
        : sourceRows({ revenue: options.revenue }),
    targetAuthority: TARGET,
    ...(options.consulted === false
      ? {}
      : { observedShopifyAovEvidence: options.shopify ?? null }),
  });
}

/** The identity surface of a calibration batch, in one comparable object. */
function batchIdentity(batch: NativeAdCalibrationBatch) {
  return {
    authorityHash: batch.spendUnitAuthority.authorityHash,
    generationContentHash: batch.generationContentHash,
    inputManifestHash: batch.inputManifestHash,
    sourceManifestHash: batch.sourceManifestHash,
    cellSetHash: batch.cellSetHash,
    cellInputManifestHashes: batch.cells.map(
      (cell) => cell.inputManifestHash,
    ),
  };
}

const flags: EngineV3Flags = {
  businessId: BUSINESS_ID,
  enabled: true,
  surfaceVisible: true,
  shadowOnly: false,
  presetOverride: null,
  source: {
    enabled: "env",
    surfaceVisible: "env",
    shadowOnly: "env",
    presetOverride: null,
  },
  envDefaults: { enabled: true, surfaceVisible: true, shadowOnly: false },
};

/**
 * `spendUnitEvidence` straight out of the real resolver.
 *
 * `resolveSpendUnit` is what copies the store observation onto the evidence AND
 * what pushes `observed_shopify_aov_<status>` into `evidence.warnings`. Driving
 * it here rather than hand-writing an evidence literal is what makes this test
 * fail if that warning is ever renamed out from under the envelope's filter.
 */
function evidenceFor(shopify: {
  observedShopifyAov?: number | null;
  observedShopifyAovOrderCount?: number;
  observedShopifyAovStatus?: string | null;
  metaAttributedAovMean90d?: number;
  /** Round 6: the non-authoritative Meta-side knobs, one at a time. */
  targetCpa?: number | null;
  operatorAovAssumption?: number | null;
  accountCpaP50?: number | null;
  accountCpaSampleCount?: number;
  attributionAovAdjustmentMultiplier?: number;
}): SpendUnitEvidence {
  return resolveSpendUnit({
    targetCpa: shopify.targetCpa === undefined ? 50 : shopify.targetCpa,
    operatorAovAssumption:
      shopify.operatorAovAssumption === undefined
        ? 100
        : shopify.operatorAovAssumption,
    observedShopifyAov: shopify.observedShopifyAov,
    observedShopifyAovOrderCount: shopify.observedShopifyAovOrderCount,
    observedShopifyAovStatus: shopify.observedShopifyAovStatus,
    metaAttributedAovMean90d: shopify.metaAttributedAovMean90d ?? 164.85,
    metaAttributedAovPurchaseCount90d: 781,
    metaAttributedRevenue90d: 128_748.02,
    targetRoas: 2,
    breakEvenRoas: 1.5,
    accountCpaP50:
      shopify.accountCpaP50 === undefined ? 44 : shopify.accountCpaP50,
    accountCpaSampleCount: shopify.accountCpaSampleCount ?? 60,
    attributionAovAdjustmentMultiplier:
      shopify.attributionAovAdjustmentMultiplier ?? 1,
  }).evidence;
}

function makeDecision(): DecisionOutput {
  return {
    creativeId: "creative-1",
    creativeName: "Test Creative",
    label: "keep",
    reason: "Evidence remains inside the keep band.",
    confidence: 72,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 1.1,
    badges: [],
    metrics: { spend: 500, purchases: 8, roas: 3, recent7dRoas: 2.8 },
    engineVersion: "v3-test",
    generatedAt: "2026-07-12T03:00:00.000Z",
    preAuthorityLabel: "keep",
    authorityBlocker: null,
  };
}

function evaluationFor(evidence: SpendUnitEvidence): BuildCanonicalEvaluationInput {
  const accountProfile = makeAccountDecisionProfile({
    businessId: BUSINESS_ID,
    asOfDate: AS_OF,
    spendUnitEvidence: evidence,
  });
  const creativeInput = makeCreativeInput({ businessId: BUSINESS_ID });
  return {
    engineVersion: "v3-test",
    accountProfile,
    dataHealth: makeDataHealth(),
    flags,
    scope: accountProfile.scope,
    creativeInput,
    campaignContext: {
      mode: "automatic",
      source: "system_inferred",
      campaignId: creativeInput.campaignId,
      kind: "main",
      testDimension: null,
      contextTrust: "high",
      sourceRecordType: "engine_v3_campaign_context_daily",
      sourceRecordId: "ctx-1",
      sourceAsOfDate: AS_OF,
      sourceUpdatedAt: "2026-07-12T02:00:00.000Z",
      sourceHash: "a".repeat(64),
    },
    priorHysteresis: null,
    decision: makeDecision(),
    rawLabel: "keep",
    publishedLabel: "keep",
    hysteresisSuppressed: false,
    evaluatedAt: "2026-07-12T03:00:01.000Z",
  };
}

/** The identity surface of one evaluation, base envelope and Ad envelope. */
function evaluationIdentity(evidence: SpendUnitEvidence) {
  const base = buildCanonicalEvaluationProvenance(evaluationFor(evidence));
  const ad = buildAdCanonicalEvaluationProvenance({
    identity: {
      decisionEntityType: "ad",
      decisionEntityId: "ad-1",
      adId: "ad-1",
      providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      creativeId: "creative-1",
    },
    base,
  });
  return {
    contextHash: base.contextHash,
    inputHash: base.inputHash,
    decisionHash: base.decisionHash,
    decisionJson: base.decisionJson,
    campaignContextHash: canonicalSha256(base.inputPayload.campaignContext),
    adContextHash: ad.contextHash,
    adInputHash: ad.inputHash,
    adDecisionHash: ad.decisionHash,
    adDecisionJson: ad.decisionJson,
  };
}

describe("Shopify is excluded from calibration-authority identity", () => {
  it("mints one contract version for every store permutation", () => {
    for (const permutation of SHOPIFY_PERMUTATIONS) {
      const batch = buildBatch({
        shopify: permutation.evidence ?? null,
        consulted: permutation.evidence !== undefined,
      });
      expect(
        batch.spendUnitAuthority.contractVersion,
        `contract version for "${permutation.name}"`,
      ).toBe(NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION);
    }
  });

  it("holds every calibration hash byte-identical across the permutation set", () => {
    const baseline = batchIdentity(
      buildBatch({ shopify: null, consulted: true }),
    );

    for (const permutation of SHOPIFY_PERMUTATIONS) {
      const batch = buildBatch({
        shopify: permutation.evidence ?? null,
        consulted: permutation.evidence !== undefined,
      });
      expect(
        batchIdentity(batch),
        `calibration identity moved for "${permutation.name}"`,
      ).toEqual(baseline);
      // Every cell's stored manifest hash still recomputes from its own content.
      for (const cell of batch.cells) {
        expect(recomputeNativeAdCalibrationCellInputManifestHash(cell)).toBe(
          cell.inputManifestHash,
        );
      }
    }
  });

  it("still carries and serves the store observation it refuses to hash", () => {
    const evidence = observed();
    const batch = buildBatch({ shopify: evidence, consulted: true });

    expect(batch.spendUnitAuthority.observedShopifyAovEvidence).toEqual(
      evidence,
    );
    // Carried, and still not the basis: the Meta-attributed AOV is.
    expect(batch.spendUnitAuthority.basis).toBe(
      "physical_account_purchase_aov_90d",
    );
  });

  it("mints an authorityHash the shared recompute reproduces", () => {
    for (const permutation of SHOPIFY_PERMUTATIONS) {
      const authority = buildBatch({
        shopify: permutation.evidence ?? null,
        consulted: permutation.evidence !== undefined,
      }).spendUnitAuthority;
      expect(
        recomputeNativeAdSpendUnitAuthorityHash(authority),
        `authority recompute for "${permutation.name}"`,
      ).toBe(authority.authorityHash);
    }
  });

  it("MOVES every calibration hash on a Meta-side change", () => {
    const baseline = batchIdentity(
      buildBatch({ shopify: observed(), consulted: true }),
    );
    const metaChanged = batchIdentity(
      buildBatch({ shopify: observed(), consulted: true, revenue: 999 }),
    );

    expect(metaChanged.authorityHash).not.toBe(baseline.authorityHash);
    expect(metaChanged.generationContentHash).not.toBe(
      baseline.generationContentHash,
    );
    expect(metaChanged.inputManifestHash).not.toBe(baseline.inputManifestHash);
    expect(metaChanged.sourceManifestHash).not.toBe(
      baseline.sourceManifestHash,
    );
    expect(metaChanged.cellSetHash).not.toBe(baseline.cellSetHash);
    expect(metaChanged.cellInputManifestHashes).not.toEqual(
      baseline.cellInputManifestHashes,
    );
  });
});

describe("Shopify is excluded from evaluation identity", () => {
  /*
    Statuses go through the RESOLVER, so each one also exercises the
    `observed_shopify_aov_<status>` warning it writes into `evidence.warnings`.
    Only `observed` writes none, which is why an `observed` baseline compared
    against the absences is the case that catches the warning leak.
  */
  const STATUS_PERMUTATIONS = [
    { name: "no store field at all", shopify: {} },
    {
      name: "observed",
      shopify: {
        observedShopifyAov: 154.85,
        observedShopifyAovOrderCount: 527,
        observedShopifyAovStatus: "observed",
      },
    },
    {
      name: "observed with a different AOV",
      shopify: {
        observedShopifyAov: 421,
        observedShopifyAovOrderCount: 12,
        observedShopifyAovStatus: "observed",
      },
    },
    {
      name: "stale",
      shopify: {
        observedShopifyAov: null,
        observedShopifyAovOrderCount: 0,
        observedShopifyAovStatus: "stale",
      },
    },
    {
      name: "unavailable",
      shopify: {
        observedShopifyAov: null,
        observedShopifyAovOrderCount: 0,
        observedShopifyAovStatus: "unavailable",
      },
    },
    {
      name: "observed_zero_orders",
      shopify: {
        observedShopifyAov: null,
        observedShopifyAovOrderCount: 0,
        observedShopifyAovStatus: "observed_zero_orders",
      },
    },
    {
      name: "sample_thin",
      shopify: {
        observedShopifyAov: null,
        observedShopifyAovOrderCount: 3,
        observedShopifyAovStatus: "sample_thin",
      },
    },
  ];

  it("proves the resolver really does vary the evidence it is handed", () => {
    const observedEvidence = evidenceFor(STATUS_PERMUTATIONS[1]!.shopify);
    const staleEvidence = evidenceFor(STATUS_PERMUTATIONS[3]!.shopify);

    expect(observedEvidence.observedShopifyAov).toBe(154.85);
    expect(staleEvidence.observedShopifyAov).toBeNull();
    // The second door: a store-only status change writes a warning, and
    // `warnings` is a hashed member of the evidence.
    expect(observedEvidence.warnings).not.toContain(
      "observed_shopify_aov_stale",
    );
    expect(staleEvidence.warnings).toContain("observed_shopify_aov_stale");
  });

  it("holds context, input, decision and Ad-envelope hashes byte-identical", () => {
    const baseline = evaluationIdentity(
      evidenceFor(STATUS_PERMUTATIONS[1]!.shopify),
    );

    for (const permutation of STATUS_PERMUTATIONS) {
      expect(
        evaluationIdentity(evidenceFor(permutation.shopify)),
        `evaluation identity moved for "${permutation.name}"`,
      ).toEqual(baseline);
    }
  });

  it("MOVES context, input and decision hashes on a Meta-side change", () => {
    const baseline = evaluationIdentity(
      evidenceFor(STATUS_PERMUTATIONS[1]!.shopify),
    );
    const metaChanged = evaluationIdentity(
      evidenceFor({
        ...STATUS_PERMUTATIONS[1]!.shopify,
        metaAttributedAovMean90d: 201.5,
      }),
    );

    expect(metaChanged.contextHash).not.toBe(baseline.contextHash);
    expect(metaChanged.inputHash).not.toBe(baseline.inputHash);
    expect(metaChanged.decisionHash).not.toBe(baseline.decisionHash);
    expect(metaChanged.adContextHash).not.toBe(baseline.adContextHash);
    expect(metaChanged.adInputHash).not.toBe(baseline.adInputHash);
    expect(metaChanged.adDecisionHash).not.toBe(baseline.adDecisionHash);
  });

  /*
    ── ROUND 6 ITEM 3: THE OTHER NON-AUTHORITATIVE NUMBERS, ONE AT A TIME ────
    `normalizeSpendUnitEvidence` projected the operator's Target CPA and AOV
    assumption out in `.v7` but deliberately KEPT `accountCpaP50` /
    `accountCpaSampleCount`, and the reason was written down: under a Target
    ROAS with an unusable Meta AOV the ladder FELL THROUGH to the
    `account_history` rung, so the account's median CPA could still choose the
    unit. That fall-through no longer exists — the governed branch answers
    READY-or-`insufficient` — so those two choose nothing here either. `.v8`
    projects them out, and this is the permutation that proves it.
  */
  const NON_AUTHORITATIVE_META_SIDE: Array<[string, Parameters<typeof evidenceFor>[0]]> = [
    ["a typed Target CPA", { targetCpa: 31 }],
    ["no Target CPA at all", { targetCpa: null }],
    ["an operator AOV assumption", { operatorAovAssumption: 900 }],
    ["a re-measured account CPA", { accountCpaP50: 99 }],
    ["a collapsed account CPA sample", { accountCpaSampleCount: 4 }],
    ["an absent account CPA", { accountCpaP50: null, accountCpaSampleCount: 0 }],
    ["a typed attribution multiplier", { attributionAovAdjustmentMultiplier: 1.35 }],
  ];

  it.each(NON_AUTHORITATIVE_META_SIDE)(
    "holds every evaluation hash byte-identical on %s",
    (_name, over) => {
      const baseline = evaluationIdentity(
        evidenceFor(STATUS_PERMUTATIONS[1]!.shopify),
      );
      expect(
        evaluationIdentity(
          evidenceFor({ ...STATUS_PERMUTATIONS[1]!.shopify, ...over }),
        ),
      ).toEqual(baseline);
    },
  );

  it("proves the resolver really is handed those different numbers", () => {
    // Without this the permutations above could pass because the evidence
    // never varied. `accountCpaP50` is CARRIED in the evidence and simply not
    // hashed, which is exactly the distinction being made.
    const base = evidenceFor(STATUS_PERMUTATIONS[1]!.shopify);
    const remeasured = evidenceFor({
      ...STATUS_PERMUTATIONS[1]!.shopify,
      accountCpaP50: 99,
    });
    expect(base.accountCpaP50).toBe(44);
    expect(remeasured.accountCpaP50).toBe(99);
  });

  it("keeps a NON-Shopify warning inside identity", () => {
    /*
      The envelope filters ONE prefix, not the warnings array. A warning that
      names a Meta-side or commercial-target absence still has to move the
      hash, or the filter would have quietly deleted the whole member from
      identity.
    */
    const baseline = evidenceFor(STATUS_PERMUTATIONS[1]!.shopify);
    const withMetaWarning: SpendUnitEvidence = {
      ...baseline,
      warnings: [...baseline.warnings, "commercial_target_freshness_unknown"],
    };

    expect(evaluationIdentity(withMetaWarning).contextHash).not.toBe(
      evaluationIdentity(baseline).contextHash,
    );
  });
});

describe("a persisted .v2 authority recomputes under its own version key", () => {
  /*
    A REAL production row, copied verbatim from
    `engine_v3_ad_account_calibration_daily` on 2026-09-07 (read-only prod
    tunnel). 118 rows carry a `.v2` authority and every one of them was minted
    with the store observation INSIDE `authorityHash`. They must keep verifying
    under `.v2`, never be silently recomputed under `.v3` semantics.
  */
  const legacy: NativeAdSpendUnitAuthority = {
    contractVersion: "engine-v3-native-ad-spend-unit-authority.v2",
    status: "ready",
    basis: "physical_account_purchase_aov_90d",
    businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
    providerAccountRefId: "1068f9fe-b86f-4f56-80f5-d9ff7abfcfd5",
    providerAccountId: "act_1087566732415606",
    accountCurrency: "USD",
    asOfCutoff: "2026-09-07T03:13:07.971Z",
    targetAuthorityHash:
      "9fdbe8b10f2be9d732929a1b769eb9ae96f383ef5a297cb10d3e7bfd32765d15",
    baseSpendUnit: 47.100062191329805,
    accountAovEvidence: {
      status: "ready",
      scope: "business_provider_account_currency",
      businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
      providerAccountRefId: "1068f9fe-b86f-4f56-80f5-d9ff7abfcfd5",
      providerAccountId: "act_1087566732415606",
      accountCurrency: "USD",
      sampleWindowStart: "2026-06-10",
      sampleWindowEnd: "2026-09-07",
      asOfCutoff: "2026-09-07T03:13:07.971Z",
      observedPurchaseCount: 781,
      requiredPurchaseCount: 20,
      revenueBackedRowCount: 483,
      canonicalRowCount: 3104,
      contradictoryRowCount: 0,
      legacySchemaRowCount: 0,
      unsupportedSchemaRowCount: 0,
      totalRevenue: 128748.02000000002,
      meanAov: 164.8502176696543,
      evidenceHash:
        "ea2eac66c086dd5b70a828bc8f4bf04d8894a4e83f1b01db1d2a41860ce4fa6f",
    },
    observedShopifyAovEvidence: {
      contract: "meta.observed-shopify-aov.v1",
      status: "observed",
      source: "shopify_revenue_ledger",
      providerAccountId: "islamicwallartstr.myshopify.com",
      revenueBasis: "net_ledger",
      window: { from: "2026-08-09", to: "2026-09-05" },
      zoneName: "America/Los_Angeles",
      orderCount: 527,
      currency: "USD",
      currencyExponent: 2,
      revenueMinor: 8160386,
      aovMinor: 15485,
      observedAt: "2026-09-06T06:15:03.000Z",
      knowledgeAsOf: "2026-09-07T03:13:09.154Z",
    },
    authorityHash:
      "ca8a7c188003392c8ecbf2f9ce9531641aaceacd948437ccba2e0d5c1375fa6c",
  };

  it("recomputes the stored hash of a live .v2 row", () => {
    expect(recomputeNativeAdSpendUnitAuthorityHash(legacy)).toBe(
      legacy.authorityHash,
    );
  });

  it("still binds the store observation under .v2", () => {
    /*
      The other half of "readable under its ORIGINAL version key": a `.v2` row
      whose store evidence was altered must FAIL, not be waved through by the
      `.v3` rule. If this passed, old rows would be recomputing under current
      semantics.
    */
    const tampered: NativeAdSpendUnitAuthority = {
      ...legacy,
      observedShopifyAovEvidence: {
        ...legacy.observedShopifyAovEvidence!,
        aovMinor: 99_999,
      },
    };

    expect(recomputeNativeAdSpendUnitAuthorityHash(tampered)).not.toBe(
      legacy.authorityHash,
    );
  });

  it("does not verify the same content under the current version key", () => {
    const restamped: NativeAdSpendUnitAuthority = {
      ...legacy,
      contractVersion: NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION,
    };

    expect(recomputeNativeAdSpendUnitAuthorityHash(restamped)).not.toBe(
      legacy.authorityHash,
    );
  });
});
