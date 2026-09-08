/**
 * The native spend unit is sized by META's attributed AOV, and by nothing else.
 *
 * These drive the real builder (`computeNativeAdCalibrationBatch`) and the real
 * validator (`resolveNativeAdAccountDecisionProfile`) against the shape that
 * actually failed in production on 2026-09-07: a cell whose Shopify evidence
 * carries a `knowledgeAsOf` stamped a few hundred milliseconds AFTER the cell
 * cutoff, because `resolveObservedShopifyAov` stamps it from the wall clock and
 * no production caller passes a cutoff. The builder's cutoff test rejected that
 * evidence and chose the Meta basis; the validator had no cutoff test, expected
 * the store basis, and refused the authority the builder had just minted.
 * Grandmix, IwaStore and TheSwaf logged 39 failed
 * `engine_v3_native_ad_decisions_shadow_job` runs each — 117 in 24h, every one
 * `native_target_authority_mismatch`.
 */
import { describe, expect, it } from "vitest";
import {
  resolveNativeAdAccountDecisionProfile,
  type NativeAdAccountProfileDataSource,
  type NativeAdCalibrationCellQuery,
} from "../ad-account-decision-profile";
import type { EngineV3Flags } from "../feature-flags";
import {
  computeNativeAdCalibrationBatch,
  recomputeNativeAdCalibrationCellInputManifestHash,
  recomputeNativeAdSpendUnitAuthorityHash,
  type NativeAdCalibrationCell,
  type NativeAdCalibrationSourceRow,
  type NativeAdTargetAuthorityInput,
} from "../jobs/ad-calibration-job";
import {
  OBSERVED_SHOPIFY_AOV_CONTRACT,
  type ObservedShopifyAovEvidence,
} from "../shopify-aov-source";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000811";
const PROVIDER_ACCOUNT_REF_ID = "00000000-0000-4000-8000-000000000810";
const BATCH_ID = "00000000-0000-4000-8000-000000000812";
const PROVIDER_ACCOUNT_ID = "act-native-aov";
const AS_OF = "2026-07-12";
/** The cell cutoff every authority below is minted against. */
const COMPUTATION_CUTOFF = "2026-07-12T03:05:00.000Z";

/**
 * Target ROAS is the ONLY configured commercial target — every other economic
 * input is null, break-even included.
 *
 * This pack used to carry `breakEvenRoas: 1.5` while calling itself ROAS-only,
 * and that single field is what made the Cut lane below pass: with it set to
 * null the exact-cell Cut reason was `break_even_roas_authority_missing`
 * instead of the spend-unit hold these tests are about. A break-even ROAS is a
 * configured commercial target like any other, so a pack that sets one is not
 * the ROAS-only shape and cannot stand in for it. Grandmix's purchase cell IS
 * this shape: a Target ROAS and a ready 90-day Meta platform AOV, and no
 * operator ever typed a break-even.
 */
const TARGET_ROAS_ONLY: NativeAdTargetAuthorityInput = {
  sourceRowId: "00000000-0000-4000-8000-000000000819",
  operation: "upsert",
  targetCpa: null,
  targetRoas: 2,
  breakEvenCpa: null,
  breakEvenRoas: null,
  operatorAovAssumption: null,
  defaultRiskPosture: "balanced",
  effectiveAt: "2026-07-01T00:00:00.000Z",
  recordedAt: "2026-07-01T00:00:01.000Z",
};

/** The same account, plus the break-even an operator may also have typed. */
const TARGET_ROAS_AND_BREAK_EVEN: NativeAdTargetAuthorityInput = {
  ...TARGET_ROAS_ONLY,
  sourceRowId: "00000000-0000-4000-8000-00000000081a",
  breakEvenRoas: 1.5,
};

/** Break-even alone, with no Target ROAS and no Target CPA behind it. */
const BREAK_EVEN_ONLY: NativeAdTargetAuthorityInput = {
  ...TARGET_ROAS_ONLY,
  sourceRowId: "00000000-0000-4000-8000-00000000081b",
  targetRoas: null,
  breakEvenRoas: 1.5,
};

/**
 * The same ROAS-only account, plus a legacy Target CPA that DISAGREES with the
 * derived unit. 37 is not 50 (`meanAov 100 / targetRoas 2`), so a builder or a
 * validator that still preferred the CPA could not be mistaken for one that
 * preferred the platform AOV.
 */
const TARGET_ROAS_AND_LEGACY_CPA: NativeAdTargetAuthorityInput = {
  ...TARGET_ROAS_ONLY,
  sourceRowId: "00000000-0000-4000-8000-00000000081d",
  targetCpa: 37,
};

/** The same, with an operator AOV assumption instead: 400 / 2 = 200, not 50. */
const TARGET_ROAS_AND_OPERATOR_AOV: NativeAdTargetAuthorityInput = {
  ...TARGET_ROAS_ONLY,
  sourceRowId: "00000000-0000-4000-8000-00000000081e",
  operatorAovAssumption: 400,
};

/** Both operator-typed numbers at once, both disagreeing with the platform. */
const TARGET_ROAS_AND_BOTH: NativeAdTargetAuthorityInput = {
  ...TARGET_ROAS_ONLY,
  sourceRowId: "00000000-0000-4000-8000-00000000081f",
  targetCpa: 37,
  operatorAovAssumption: 400,
};

/** A legacy Target CPA with NO Target ROAS: the compatibility case. */
const LEGACY_CPA_ONLY: NativeAdTargetAuthorityInput = {
  ...TARGET_ROAS_ONLY,
  sourceRowId: "00000000-0000-4000-8000-000000000820",
  targetRoas: null,
  targetCpa: 37,
};

/** No commercial target of any kind: the case that must still be refused. */
const NO_COMMERCIAL_TARGET: NativeAdTargetAuthorityInput = {
  ...TARGET_ROAS_ONLY,
  sourceRowId: "00000000-0000-4000-8000-00000000081c",
  targetRoas: null,
  breakEvenRoas: null,
};

/**
 * The production stamping, to the millisecond gap that caused it.
 *
 * act_805150454596350 on 2026-09-07: cell cutoff 03:13:19.302Z, evidence
 * knowledgeAsOf 03:13:20.188Z — 886ms late, over a window that closed two days
 * earlier and an `observedAt` well inside the cutoff. Only the read clock is
 * late, which is why the window alone never revealed the race.
 */
const LATE_KNOWLEDGE_AS_OF = "2026-07-12T03:05:00.886Z";
const EARLY_KNOWLEDGE_AS_OF = "2026-07-12T02:00:00.000Z";

/** 300.00 USD, deliberately unequal to the Meta-attributed 100.00 below. */
const STORE_AOV_MINOR = 30_000;

function makeObservedShopifyAov(
  knowledgeAsOf: string,
): ObservedShopifyAovEvidence {
  return {
    contract: OBSERVED_SHOPIFY_AOV_CONTRACT,
    status: "observed",
    source: "shopify_revenue_ledger",
    providerAccountId: "store.myshopify.com",
    revenueBasis: "net_ledger",
    window: { from: "2026-06-13", to: "2026-07-10" },
    zoneName: "America/Los_Angeles",
    orderCount: 41,
    currency: "USD",
    currencyExponent: 2,
    revenueMinor: STORE_AOV_MINOR * 41,
    aovMinor: STORE_AOV_MINOR,
    observedAt: "2026-07-11T06:15:03.000Z",
    knowledgeAsOf,
  };
}

function makeFlags(): EngineV3Flags {
  return {
    businessId: BUSINESS_ID,
    enabled: true,
    surfaceVisible: false,
    shadowOnly: false,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: { enabled: true, surfaceVisible: false, shadowOnly: false },
  };
}

/** One purchase at 100.00, so the Meta-attributed AOV is exactly 100. */
function makeSourceRow(
  index: number,
  overrides: Partial<NativeAdCalibrationSourceRow> = {},
): NativeAdCalibrationSourceRow {
  const adId = overrides.adId ?? `aov-ad-${String(index).padStart(2, "0")}`;
  return {
    sourceRowId: `source-${adId}`,
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    date: "2026-07-11",
    campaignId: "campaign-native",
    adsetId: "adset-native",
    adId,
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "USD",
    sourceAccountCurrency: "USD",
    sourceAccountTimezone: "Europe/Istanbul",
    metricSchemaVersion: 2,
    objective: "OUTCOME_SALES",
    optimizationGoal: "PURCHASE",
    customEventType: "PURCHASE",
    spend: 40 + index,
    impressions: 10_000,
    clicks: 300,
    linkClicks: 250,
    conversions: 1,
    revenue: 100,
    landingPageViews: 200,
    addToCart: 50,
    initiateCheckout: 20,
    thumbstop: 0.3,
    truthState: "finalized",
    validationStatus: "passed",
    finalizedAt: "2026-07-12T01:00:00.000Z",
    createdAt: "2026-07-12T01:00:00.000Z",
    updatedAt: "2026-07-12T02:00:00.000Z",
    campaignSourceRowId: "campaign-source",
    campaignTruthState: "finalized",
    campaignValidationStatus: "passed",
    campaignCreatedAt: "2026-07-12T01:00:00.000Z",
    campaignUpdatedAt: "2026-07-12T02:00:00.000Z",
    adsetSourceRowId: "adset-source",
    adsetTruthState: "finalized",
    adsetValidationStatus: "passed",
    adsetCreatedAt: "2026-07-12T01:00:00.000Z",
    adsetUpdatedAt: "2026-07-12T02:00:00.000Z",
    ...overrides,
  };
}

function buildCells(input: {
  rowCount: number;
  targetAuthority?: NativeAdTargetAuthorityInput;
  observedShopifyAovEvidence?: ObservedShopifyAovEvidence | null;
  rowOverrides?: Partial<NativeAdCalibrationSourceRow>;
}): NativeAdCalibrationCell[] {
  const batch = computeNativeAdCalibrationBatch({
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    asOf: AS_OF,
    computationCutoff: COMPUTATION_CUTOFF,
    sourceRows: Array.from({ length: input.rowCount }, (_, index) =>
      makeSourceRow(index + 1, input.rowOverrides ?? {}),
    ),
    targetAuthority: input.targetAuthority ?? TARGET_ROAS_ONLY,
    // Omitted entirely rather than passed as undefined: "the store was never
    // consulted" is a different fact from "it was, and produced nothing", and
    // the authority records the difference.
    ...("observedShopifyAovEvidence" in input
      ? { observedShopifyAovEvidence: input.observedShopifyAovEvidence }
      : {}),
  });
  return batch.cells.map((cell) => ({
    ...cell,
    batchId: BATCH_ID,
    batchCompleteness: "complete" as const,
  }));
}

/** The same builder call, kept whole so a test can read its quality counts. */
function buildBatch(input: {
  rowCount: number;
  targetAuthority: NativeAdTargetAuthorityInput;
}) {
  return computeNativeAdCalibrationBatch({
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    asOf: AS_OF,
    computationCutoff: COMPUTATION_CUTOFF,
    sourceRows: Array.from({ length: input.rowCount }, (_, index) =>
      makeSourceRow(index + 1),
    ),
    targetAuthority: input.targetAuthority,
  });
}

/**
 * Re-stamps the integrity hashes a hand-edited cell would otherwise fail on.
 *
 * A cell arrives from the warehouse with its authority hash and its own input
 * manifest hash already agreeing with its content, so a test that edits the
 * content and stops there is refused as `native_calibration_contract_invalid`
 * before any authority rule is reached. Resealing lets a test aim at exactly
 * one rule.
 */
function reseal(cell: NativeAdCalibrationCell): NativeAdCalibrationCell {
  return {
    ...cell,
    inputManifestHash:
      recomputeNativeAdCalibrationCellInputManifestHash(cell),
  };
}

function resealAuthority(
  authority: NativeAdCalibrationCell["actionReadiness"]["spendUnitAuthority"],
): NativeAdCalibrationCell["actionReadiness"]["spendUnitAuthority"] {
  return {
    ...authority,
    authorityHash: recomputeNativeAdSpendUnitAuthorityHash(authority),
  };
}

function exactCellOf(cells: NativeAdCalibrationCell[]) {
  const cell = cells.find(
    (candidate) => candidate.key.cellScope === "objective_cohort_context",
  );
  if (!cell) throw new Error("expected an exact objective/cohort/context cell");
  return cell;
}

class NativeOnlyProfileDataSource implements NativeAdAccountProfileDataSource {
  constructor(
    private readonly cells: NativeAdCalibrationCell[],
    private readonly targetAuthority: NativeAdTargetAuthorityInput = TARGET_ROAS_ONLY,
  ) {}

  async getNativeAdCalibrationCell(input: NativeAdCalibrationCellQuery) {
    return (
      this.cells.find(
        (cell) =>
          cell.key.businessId === input.businessId &&
          cell.key.providerAccountId === input.providerAccountId &&
          cell.key.accountTimezone === input.accountTimezone &&
          cell.key.accountCurrency === input.accountCurrency &&
          cell.key.cellScope === input.cellScope &&
          cell.key.objective === input.objective &&
          cell.key.cohort === input.cohort &&
          cell.key.optimizationContext === input.optimizationContext &&
          cell.asOfDate === input.asOfDate,
      ) ?? null
    );
  }

  async getNativeTargetAuthorityAsOf() {
    return this.targetAuthority;
  }

  async getNativeDecisionCalibrationProfileAsOf() {
    return null;
  }
}

function resolveWith(
  cells: NativeAdCalibrationCell[],
  targetAuthority: NativeAdTargetAuthorityInput = TARGET_ROAS_ONLY,
) {
  return resolveNativeAdAccountDecisionProfile({
    businessId: BUSINESS_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "USD",
    objective: "OUTCOME_SALES",
    optimizationGoal: "PURCHASE",
    customEventType: "PURCHASE",
    cohort: "purchase",
    asOf: AS_OF,
    dataSource: new NativeOnlyProfileDataSource(cells, targetAuthority),
    flags: makeFlags(),
  });
}

describe("native spend-unit authority is Meta-attributed AOV only", () => {
  it("keeps the Meta basis and stays resolvable when store evidence lands after the cell cutoff", async () => {
    const cells = buildCells({
      rowCount: 30,
      observedShopifyAovEvidence: makeObservedShopifyAov(LATE_KNOWLEDGE_AS_OF),
    });
    const exact = exactCellOf(cells);
    const authority = exact.actionReadiness.spendUnitAuthority;

    // The evidence really is the production shape: closed window, an
    // `observedAt` inside the cutoff, and only the read clock late.
    const store = authority.observedShopifyAovEvidence!;
    expect(exact.asOfCutoff).toBe(COMPUTATION_CUTOFF);
    expect(store.knowledgeAsOf).toBe(LATE_KNOWLEDGE_AS_OF);
    expect(store.knowledgeAsOf > exact.asOfCutoff).toBe(true);
    expect(store.observedAt! < exact.asOfCutoff).toBe(true);
    expect(store.window!.to < exact.asOfCutoff.slice(0, 10)).toBe(true);

    // The builder sized the unit from Meta's attributed AOV over Target ROAS.
    expect(authority.status).toBe("ready");
    expect(authority.basis).toBe("physical_account_purchase_aov_90d");
    expect(authority.accountAovEvidence.meanAov).toBe(100);
    expect(authority.baseSpendUnit).toBe(50);

    // The validator agrees with the authority the builder minted. Before the
    // Shopify basis was retired this returned
    // fail_closed/native_target_authority_mismatch — the 117 failed runs.
    const result = await resolveWith(cells);
    expect(result.status).toBe("ready");
    expect(result.reason).toBeNull();
    expect(
      result.selectedCell?.actionReadiness.spendUnitAuthority.baseSpendUnit,
    ).toBe(50);
  });

  it("keeps the Meta basis even when store evidence is fully cutoff-safe", async () => {
    // The rule is not "Shopify only when it is late". A store observation the
    // cutoff could legitimately have known is still not the authority for a
    // Meta decision, so the unit stays 100/2 and never becomes 300/2.
    const cells = buildCells({
      rowCount: 30,
      observedShopifyAovEvidence: makeObservedShopifyAov(EARLY_KNOWLEDGE_AS_OF),
    });
    const authority = exactCellOf(cells).actionReadiness.spendUnitAuthority;

    const store = authority.observedShopifyAovEvidence!;
    expect(store.knowledgeAsOf < COMPUTATION_CUTOFF).toBe(true);
    expect(authority.basis).toBe("physical_account_purchase_aov_90d");
    expect(authority.baseSpendUnit).toBe(50);
    expect(authority.baseSpendUnit).not.toBe(
      STORE_AOV_MINOR / 100 / TARGET_ROAS_ONLY.targetRoas!,
    );

    const result = await resolveWith(cells);
    expect(result.status).toBe("ready");
  });

  it("holds explicitly when Meta AOV is missing instead of substituting the store's", async () => {
    // Zero Meta-attributed purchases: the only AOV in the room is the store's,
    // and it is cutoff-safe and well above the order floor. The authority must
    // still block, naming the absence, rather than quietly sizing Meta spend
    // from a number Meta never attributed.
    const cells = buildCells({
      rowCount: 30,
      rowOverrides: { conversions: 0, revenue: 0 },
      observedShopifyAovEvidence: makeObservedShopifyAov(EARLY_KNOWLEDGE_AS_OF),
    });
    const exact = exactCellOf(cells);
    const authority = exact.actionReadiness.spendUnitAuthority;

    expect(authority.status).toBe("blocked");
    expect(authority.basis).toBeNull();
    expect(authority.baseSpendUnit).toBeNull();
    // The hold is named, and it names the Meta side.
    expect(authority.accountAovEvidence.status).not.toBe("ready");
    expect(exact.actionReadiness.cut).toMatchObject({
      ready: false,
      reason: "commercial_spend_unit_authority_missing",
      authorityBasis: null,
    });
    // The store observation is still carried, so an operator can read what the
    // other book said — it just did not decide anything.
    expect(authority.observedShopifyAovEvidence?.status).toBe("observed");

    const result = await resolveWith(cells);
    expect(result.hardActionEligibility.cut).toBe(false);
    expect(result.hardActionEligibility.reasons?.cut).toBe(
      "native_ad_calibration:commercial_spend_unit_authority_missing",
    );
  });

  it("fails a persisted store-basis authority CLOSED rather than honouring it", async () => {
    // Compatibility, in the direction that matters. No production row names
    // this basis (verified: zero rows on any as_of_date in
    // engine_v3_ad_account_calibration_daily), but a row that did must be
    // refused, not served — and it must be refused for its basis, not because
    // it failed to parse or to re-hash.
    const cells = buildCells({
      rowCount: 30,
      observedShopifyAovEvidence: makeObservedShopifyAov(EARLY_KNOWLEDGE_AS_OF),
    });
    const rewritten = cells.map((cell) =>
      reseal({
        ...cell,
        actionReadiness: {
          ...cell.actionReadiness,
          spendUnitAuthority: resealAuthority({
            ...cell.actionReadiness.spendUnitAuthority,
            basis: "observed_shopify_aov" as const,
            baseSpendUnit: STORE_AOV_MINOR / 100 / TARGET_ROAS_ONLY.targetRoas!,
          }),
        },
      }),
    );
    // Resealed end to end, so the refusal below can only be the basis rule —
    // not a stale authority hash and not a stale cell manifest.
    const rewrittenCell = exactCellOf(rewritten);
    expect(rewrittenCell.inputManifestHash).toBe(
      recomputeNativeAdCalibrationCellInputManifestHash(rewrittenCell),
    );
    expect(
      rewrittenCell.actionReadiness.spendUnitAuthority.authorityHash,
    ).toBe(
      recomputeNativeAdSpendUnitAuthorityHash(
        rewrittenCell.actionReadiness.spendUnitAuthority,
      ),
    );

    const result = await resolveWith(rewritten);
    expect(result.status).toBe("fail_closed");
    expect(result.reason).toBe("native_target_authority_mismatch");
    expect(result.profile).toBeNull();
    expect(result.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
  });

  it("reads a persisted .v1 authority to the same spend unit, and refuses to let it authorize", async () => {
    // Production holds both shapes: 939 `.v1` rows minted 2026-08-10..09-06,
    // before the store source existed and carrying no such member, and `.v2`
    // rows since. Neither may be rewritten, and neither may disagree about what
    // the unit is.
    const v2Cells = buildCells({
      rowCount: 30,
      observedShopifyAovEvidence: makeObservedShopifyAov(LATE_KNOWLEDGE_AS_OF),
    });
    const v1Cells = v2Cells.map((cell) => {
      const {
        observedShopifyAovEvidence: _dropped,
        ...withoutStore
      } = cell.actionReadiness.spendUnitAuthority;
      return reseal({
        ...cell,
        actionReadiness: {
          ...cell.actionReadiness,
          spendUnitAuthority: resealAuthority({
            ...withoutStore,
            contractVersion: "engine-v3-native-ad-spend-unit-authority.v1",
          }),
        },
      });
    });
    const v1 = exactCellOf(v1Cells).actionReadiness.spendUnitAuthority;
    const v2 = exactCellOf(v2Cells).actionReadiness.spendUnitAuthority;

    expect(v1.observedShopifyAovEvidence).toBeUndefined();
    expect(v2.observedShopifyAovEvidence?.status).toBe("observed");
    expect(v1.basis).toBe("physical_account_purchase_aov_90d");
    expect(v1.basis).toBe(v2.basis);
    expect(v1.baseSpendUnit).toBe(v2.baseSpendUnit);

    /*
      RE-PINNED FOR CODEX A6. Both of these asserted `status: "ready"` — that a
      persisted `.v1` (and `.v2`) authority AUTHORIZES a current decision. That
      is what A6 closes: an authority minted under an older contract was being
      judged by today's ladder, so a row produced under different rungs and a
      different hashed content could still grant hard action.

      What this case actually proves is untouched and is asserted above: both
      shapes PARSE, both hash-verify, and they do not disagree about the basis
      or the unit. Those are the claims that matter for "old rows stay
      readable". Authorization is the separate question, and the answer is now
      an explicit, named refusal rather than a quiet yes.
    */
    await expect(resolveWith(v1Cells)).resolves.toMatchObject({
      status: "fail_closed",
      reason: "native_target_authority_mismatch",
    });
    /*
      THE CONTROL, and a correction to this case's own vocabulary: `v2Cells` is
      whatever `buildCells` MINTS, which is the current contract — not a `.v2`
      row. Only `v1Cells` above is forged to a historical version. So this half
      is the proof that the refusal is version-scoped rather than blanket: the
      same cells, minted by the producer, still authorize.
    */
    await expect(resolveWith(v2Cells)).resolves.toMatchObject({
      status: "ready",
      reason: null,
    });
  });
});

/**
 * The canonical rule's other half: with a Target ROAS configured and a ready
 * Meta platform AOV behind it, no second operator-typed ratio is a required
 * input. An explicit break-even ROAS was one until this pass, which is why
 * `TARGET_ROAS_ONLY` above had to carry one to reach any of the assertions in
 * the suite above.
 */
describe("a configured Target ROAS is a sufficient commercial anchor", () => {
  it("grants Cut on a ROAS-only account, with no break-even anywhere", () => {
    const exact = exactCellOf(buildCells({ rowCount: 30 }));

    // The pack really is ROAS-only, so the grant below cannot be coming from a
    // break-even that a fixture quietly supplied.
    expect(TARGET_ROAS_ONLY.breakEvenRoas).toBeNull();
    expect(TARGET_ROAS_ONLY.breakEvenCpa).toBeNull();
    expect(TARGET_ROAS_ONLY.targetCpa).toBeNull();
    expect(TARGET_ROAS_ONLY.operatorAovAssumption).toBeNull();

    expect(exact.qualityStatus).not.toBe("blocked_commercial");
    expect(exact.actionReadiness.cut.ready).toBe(true);
    expect(exact.actionReadiness.cut.reason).toBeNull();
    // Sized by the Meta platform AOV over the Target ROAS, exactly as the
    // canonical derived-CPA benchmark says.
    expect(exact.actionReadiness.spendUnitAuthority.basis).toBe(
      "physical_account_purchase_aov_90d",
    );
    expect(exact.actionReadiness.spendUnitAuthority.baseSpendUnit).toBe(50);
  });

  it("counts no purchase observation as commercially excluded on a ROAS-only account", () => {
    // The exclusion count is generation content: while break-even was required
    // it declared every purchase Ad on a ROAS-only account commercially
    // unusable, which is what a reader of the batch would have believed.
    const roasOnly = buildBatch({
      rowCount: 30,
      targetAuthority: TARGET_ROAS_ONLY,
    });
    expect(roasOnly.qualityCounts.commercialAuthorityAdExclusionCount).toBe(0);

    const none = buildBatch({
      rowCount: 30,
      targetAuthority: NO_COMMERCIAL_TARGET,
    });
    expect(
      none.qualityCounts.commercialAuthorityAdExclusionCount,
    ).toBeGreaterThan(0);
  });

  it("resolves the whole native profile to a Cut-eligible account", async () => {
    const result = await resolveWith(buildCells({ rowCount: 30 }));
    expect(result.status).toBe("ready");
    expect(result.hardActionEligibility.cut).toBe(true);
    expect(result.hardActionEligibility.reasons?.cut ?? null).toBeNull();
  });

  it("treats an added break-even as evidence, not as the thing that unlocked Cut", () => {
    // Same account, same rows; the only difference is a typed break-even. If
    // Cut readiness moves at all, break-even is still acting as a gate.
    const roasOnly = exactCellOf(buildCells({ rowCount: 30 }));
    const withBreakEven = exactCellOf(
      buildCells({ rowCount: 30, targetAuthority: TARGET_ROAS_AND_BREAK_EVEN }),
    );
    expect(withBreakEven.actionReadiness.cut).toEqual(
      roasOnly.actionReadiness.cut,
    );
    expect(withBreakEven.qualityStatus).toBe(roasOnly.qualityStatus);
    // It is carried, so a reader can still see the operator typed one.
    expect(TARGET_ROAS_AND_BREAK_EVEN.breakEvenRoas).toBe(1.5);
  });
});

describe("the loosening is not a free pass", () => {
  it("refuses Cut by name when NEITHER a break-even NOR a Target ROAS exists", async () => {
    const cells = buildCells({
      rowCount: 30,
      targetAuthority: NO_COMMERCIAL_TARGET,
    });
    const exact = exactCellOf(cells);

    expect(NO_COMMERCIAL_TARGET.targetRoas).toBeNull();
    expect(NO_COMMERCIAL_TARGET.breakEvenRoas).toBeNull();
    expect(exact.qualityStatus).toBe("blocked_commercial");
    expect(exact.actionReadiness.cut).toMatchObject({
      ready: false,
      reason: "target_roas_authority_missing",
      authorityBasis: null,
    });
    expect(exact.actionReadiness.spendUnitAuthority.status).toBe("blocked");

    const result = await resolveWith(cells, NO_COMMERCIAL_TARGET);
    expect(result.hardActionEligibility.cut).toBe(false);
    expect(result.hardActionEligibility.reasons?.cut).toBe(
      "native_ad_calibration:target_roas_authority_missing",
    );
  });

  it("still holds a break-even-only account: nothing native can size or bound it", () => {
    // Break-even passes the commercial-target gate, and then stops: no lane in
    // `buildNativeAdSpendUnitAuthority` divides by it, and `roasRatios` is
    // empty without a Target ROAS, so there is no relative boundary either. The
    // hold has to be named rather than silently granted.
    const exact = exactCellOf(
      buildCells({ rowCount: 30, targetAuthority: BREAK_EVEN_ONLY }),
    );
    expect(exact.actionReadiness.cut).toMatchObject({
      ready: false,
      reason: "commercial_spend_unit_authority_missing",
      authorityBasis: null,
    });
    expect(exact.actionReadiness.spendUnitAuthority.status).toBe("blocked");
  });
});

/**
 * The precedence, driven through the REAL builder and the REAL validator so the
 * two ladders are proved to agree cell by cell.
 *
 * `buildNativeAdSpendUnitAuthority` in `../jobs/ad-calibration-job.ts` and
 * `nativeSpendUnitAuthorityMatchesTarget` in `../ad-account-decision-profile.ts`
 * are one rule read twice. A single rung of disagreement makes the validator
 * raise `native_target_authority_mismatch` and rolls the whole native job back —
 * the 117 failed runs in this file's header. Every case below therefore asserts
 * BOTH what the builder minted and that the validator accepted it.
 */
describe("with a Target ROAS, the platform AOV outranks every operator input", () => {
  /** `meanAov 100 / targetRoas 2`. Neither 37 nor 400 / 2 = 200. */
  const PLATFORM_UNIT = 50;

  it("ignores a conflicting legacy Target CPA, on both paths", async () => {
    const cells = buildCells({
      rowCount: 30,
      targetAuthority: TARGET_ROAS_AND_LEGACY_CPA,
    });
    const authority = exactCellOf(cells).actionReadiness.spendUnitAuthority;

    expect(TARGET_ROAS_AND_LEGACY_CPA.targetCpa).toBe(37);
    expect(authority.basis).toBe("physical_account_purchase_aov_90d");
    expect(authority.baseSpendUnit).toBe(PLATFORM_UNIT);
    expect(authority.baseSpendUnit).not.toBe(
      TARGET_ROAS_AND_LEGACY_CPA.targetCpa,
    );

    const result = await resolveWith(cells, TARGET_ROAS_AND_LEGACY_CPA);
    expect(result.status).toBe("ready");
    expect(result.reason).toBeNull();
  });

  it("ignores a conflicting operator AOV assumption, on both paths", async () => {
    const cells = buildCells({
      rowCount: 30,
      targetAuthority: TARGET_ROAS_AND_OPERATOR_AOV,
    });
    const authority = exactCellOf(cells).actionReadiness.spendUnitAuthority;

    expect(authority.basis).toBe("physical_account_purchase_aov_90d");
    expect(authority.baseSpendUnit).toBe(PLATFORM_UNIT);
    expect(authority.baseSpendUnit).not.toBe(
      TARGET_ROAS_AND_OPERATOR_AOV.operatorAovAssumption! /
        TARGET_ROAS_AND_OPERATOR_AOV.targetRoas!,
    );

    const result = await resolveWith(cells, TARGET_ROAS_AND_OPERATOR_AOV);
    expect(result.status).toBe("ready");
    expect(result.reason).toBeNull();
  });

  it("ignores both at once, on both paths", async () => {
    const cells = buildCells({
      rowCount: 30,
      targetAuthority: TARGET_ROAS_AND_BOTH,
    });
    const authority = exactCellOf(cells).actionReadiness.spendUnitAuthority;

    expect(authority.basis).toBe("physical_account_purchase_aov_90d");
    expect(authority.baseSpendUnit).toBe(PLATFORM_UNIT);

    const result = await resolveWith(cells, TARGET_ROAS_AND_BOTH);
    expect(result.status).toBe("ready");
    expect(result.hardActionEligibility.cut).toBe(true);
  });

  it("holds instead of falling back to the CPA when the platform AOV is gone", async () => {
    // THE DECIDED ANSWER for `Target ROAS + no Meta AOV + Target CPA` on the
    // native path, matching `resolveSpendUnit`: blocked, named, and NOT the CPA.
    const cells = buildCells({
      rowCount: 30,
      targetAuthority: TARGET_ROAS_AND_LEGACY_CPA,
      rowOverrides: { conversions: 0, revenue: 0 },
    });
    const exact = exactCellOf(cells);
    const authority = exact.actionReadiness.spendUnitAuthority;

    expect(authority.status).toBe("blocked");
    expect(authority.basis).toBeNull();
    expect(authority.baseSpendUnit).toBeNull();
    expect(authority.accountAovEvidence.status).not.toBe("ready");
    expect(exact.actionReadiness.cut).toMatchObject({
      ready: false,
      reason: "commercial_spend_unit_authority_missing",
      authorityBasis: null,
    });

    // The validator expects the same hold, so the block is served as a block
    // rather than rolled back as a mismatch.
    const result = await resolveWith(cells, TARGET_ROAS_AND_LEGACY_CPA);
    expect(result.reason).not.toBe("native_target_authority_mismatch");
    expect(result.hardActionEligibility.cut).toBe(false);
  });

  it("keeps the legacy Target CPA governing when there is no Target ROAS", async () => {
    // The compatibility guard. Same CPA, same rows; the only difference from
    // the hold above is that no Target ROAS exists to make the platform AOV
    // divisible, so the CPA is the only anchor there is and it is taken whole.
    const cells = buildCells({
      rowCount: 30,
      targetAuthority: LEGACY_CPA_ONLY,
    });
    const authority = exactCellOf(cells).actionReadiness.spendUnitAuthority;

    expect(LEGACY_CPA_ONLY.targetRoas).toBeNull();
    expect(authority.basis).toBe("target_cpa");
    expect(authority.baseSpendUnit).toBe(37);
    expect(authority.status).toBe("ready");

    // And the two ladders agree about it: no mismatch, so the refusal that does
    // reach the operator is the commercial-target one, by its own name.
    const result = await resolveWith(cells, LEGACY_CPA_ONLY);
    expect(result.reason).not.toBe("native_target_authority_mismatch");
  });

  it("fails a persisted target_cpa authority CLOSED once a Target ROAS exists", async () => {
    // The migration direction that matters. A row minted by the old ladder for
    // an account carrying BOTH a Target ROAS and a Target CPA named
    // `target_cpa`; under the new rule no expected basis matches it, so it is
    // refused rather than served. Zero production rows name this basis
    // (verified read-only on 2026-09-07: every non-null basis in
    // `engine_v3_ad_account_calibration_daily` is
    // `physical_account_purchase_aov_90d`).
    const cells = buildCells({
      rowCount: 30,
      targetAuthority: TARGET_ROAS_AND_LEGACY_CPA,
    });
    const rewritten = cells.map((cell) =>
      reseal({
        ...cell,
        actionReadiness: {
          ...cell.actionReadiness,
          spendUnitAuthority: resealAuthority({
            ...cell.actionReadiness.spendUnitAuthority,
            basis: "target_cpa" as const,
            baseSpendUnit: TARGET_ROAS_AND_LEGACY_CPA.targetCpa,
          }),
        },
      }),
    );

    const result = await resolveWith(rewritten, TARGET_ROAS_AND_LEGACY_CPA);
    expect(result.status).toBe("fail_closed");
    expect(result.reason).toBe("native_target_authority_mismatch");
    expect(result.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
  });

  it("fails a persisted operator_aov authority CLOSED", async () => {
    // `operator_aov` is retired the same way `observed_shopify_aov` is: the
    // member stays in `NativeAdSpendUnitAuthorityBasis` so the row parses, and
    // then matches no expected basis.
    const cells = buildCells({
      rowCount: 30,
      targetAuthority: TARGET_ROAS_AND_OPERATOR_AOV,
    });
    const rewritten = cells.map((cell) =>
      reseal({
        ...cell,
        actionReadiness: {
          ...cell.actionReadiness,
          spendUnitAuthority: resealAuthority({
            ...cell.actionReadiness.spendUnitAuthority,
            basis: "operator_aov" as const,
            baseSpendUnit:
              TARGET_ROAS_AND_OPERATOR_AOV.operatorAovAssumption! /
              TARGET_ROAS_AND_OPERATOR_AOV.targetRoas!,
          }),
        },
      }),
    );

    const result = await resolveWith(rewritten, TARGET_ROAS_AND_OPERATOR_AOV);
    expect(result.status).toBe("fail_closed");
    expect(result.reason).toBe("native_target_authority_mismatch");
  });
});

/**
 * The deploy window this rule change opens, named rather than left to be
 * discovered.
 *
 * `resolveNativeAdAccountDecisionProfile` re-runs
 * `resolveNativeAdCalibrationActionReadiness` over every persisted cell and
 * refuses the cell when the stored readiness disagrees with the recomputed one
 * (`nativeActionReadinessMatchesComputedCell`). A row minted for today's
 * as-of date by a calibration run that still required an explicit break-even
 * therefore stops being served the moment this rule ships, until the
 * calibration job recomputes that date. It fails CLOSED and says why; it is
 * never served as a stale Cut refusal.
 */
describe("a cell minted under the retired break-even rule", () => {
  it("is refused as contract-invalid, not served", async () => {
    const stale = buildCells({ rowCount: 30 }).map((cell) =>
      reseal({
        ...cell,
        actionReadiness: {
          ...cell.actionReadiness,
          cut: {
            ...cell.actionReadiness.cut,
            // Exactly what the old rule wrote for this ROAS-only account.
            ready: false,
            reason: "break_even_roas_authority_missing" as const,
            authorityBasis: null,
          },
        },
      }),
    );
    // Resealed, so the refusal below is the readiness recompute and not a
    // stale manifest hash.
    const staleCell = exactCellOf(stale);
    expect(staleCell.inputManifestHash).toBe(
      recomputeNativeAdCalibrationCellInputManifestHash(staleCell),
    );

    const result = await resolveWith(stale);
    expect(result.status).toBe("fail_closed");
    expect(result.reason).toBe("native_calibration_contract_invalid");
    expect(result.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
  });
});
