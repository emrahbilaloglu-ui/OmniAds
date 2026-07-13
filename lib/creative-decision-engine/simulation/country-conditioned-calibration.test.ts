import { describe, expect, it } from "vitest";
import {
  H1_COUNTRY_PARENT_SOURCE_MODE,
  buildAdCountrySpendMix,
  buildH1CountryParentGrid,
  countryCalibrationConfidenceRank,
  normalizeCountryGenerationRows,
  prepareH1CountryParentThresholdResolver,
  reconcileCountryAdDaySpend,
  resolveH1CountryParentThreshold,
  selectLatestCompleteCountryGeneration,
  selectLatestCompleteCountryGenerationAtCutoff,
  type AdCountrySpendMix,
  type CountryCalibrationObservation,
  type RawCountrySnapshotPage,
} from "./country-conditioned-calibration";

function page(
  payload: unknown[],
  overrides: Partial<RawCountrySnapshotPage> = {},
): RawCountrySnapshotPage {
  return {
    id: "snapshot-1",
    businessId: "business-1",
    providerAccountId: "account-1",
    sourceDate: "2026-04-01",
    partitionId: "partition-1",
    runId: "run-1",
    pageIndex: 0,
    providerCursor: null,
    providerHttpStatus: 200,
    status: "fetched",
    fetchedAt: "2026-04-02T01:00:00.000Z",
    createdAt: "2026-04-02T01:00:00.000Z",
    payload,
    ...overrides,
  };
}

function mix(
  adId: string,
  countries: Array<{ country: string; spendShare: number }>,
  available = true,
): AdCountrySpendMix {
  const total = 100;
  return {
    sourceMode: H1_COUNTRY_PARENT_SOURCE_MODE,
    businessId: "business-1",
    providerAccountId: "account-1",
    currency: "USD",
    goal: "PURCHASE",
    adId,
    asOfDate: "2026-04-01",
    windowDays: 28,
    assignedCountry: null,
    countries: countries.map((country) => ({
      ...country,
      spend: total * country.spendShare,
    })),
    multiCountry: countries.length > 1,
    totalMetaSpend: total,
    reconciledMetaSpend: available ? total : 0,
    rawCountrySpend: available ? total : 0,
    coveredSpendShare: available ? 1 : 0,
    available,
    missingFields: available ? [] : ["country_mix_spend_coverage"],
    sourceGenerationHashes: ["generation-hash"],
    mixHash: `mix-${adId}`,
  };
}

function observation(input: {
  id: string;
  value: number;
  country: string;
  businessId?: string;
  providerAccountId?: string;
  currency?: string;
  goal?: string;
}): CountryCalibrationObservation {
  return {
    id: input.id,
    businessId: input.businessId ?? "business-1",
    providerAccountId: input.providerAccountId ?? "account-1",
    currency: input.currency ?? "USD",
    goal: input.goal ?? "PURCHASE",
    adId: input.id,
    value: input.value,
    ageDays: 0,
    countryMix: mix(input.id, [{ country: input.country, spendShare: 1 }]),
  };
}

const countryVariant = {
  parentMode: "account_goal_country_spend_weighted" as const,
  halfLifeDays: 28 as const,
  kappa: 8 as const,
  quantile: 0.5 as const,
};

describe("H1 country-parent calibration", () => {
  it("crosses all 144 H1 configurations with both parent modes", () => {
    const grid = buildH1CountryParentGrid();
    expect(grid).toHaveLength(288);
    expect(new Set(grid.map((variant) => variant.baseVariantId))).toHaveLength(
      144,
    );
    expect(new Set(grid.map((variant) => variant.id))).toHaveLength(288);
    expect(
      grid.filter((variant) => variant.parentMode === "account_goal"),
    ).toHaveLength(144);
    expect(
      grid.filter(
        (variant) =>
          variant.parentMode === "account_goal_country_spend_weighted",
      ),
    ).toHaveLength(144);
  });

  it("selects only the latest complete generation and never falls back", () => {
    const older = page([], {
      id: "older",
      runId: "older-run",
      fetchedAt: "2026-04-02T01:00:00.000Z",
    });
    const newerIncomplete = page([], {
      id: "newer",
      runId: "newer-run",
      providerCursor: "next-page",
      fetchedAt: "2026-04-02T02:00:00.000Z",
    });
    expect(() =>
      selectLatestCompleteCountryGeneration([older, newerIncomplete]),
    ).toThrow(/latest_generation_incomplete/);

    const newerComplete = { ...newerIncomplete, providerCursor: null };
    expect(
      selectLatestCompleteCountryGeneration([older, newerComplete]).snapshotIds,
    ).toEqual(["newer"]);
  });

  it("selects generations strictly at the declared decision cutoff", () => {
    const older = page([{ ad_id: "ad-1", country: "US", spend: "10" }], {
      id: "older",
      runId: "older-run",
      fetchedAt: "2026-04-02T01:00:00.000Z",
      createdAt: "2026-04-02T01:00:00.000Z",
    });
    const future = page([{ ad_id: "ad-1", country: "CA", spend: "10" }], {
      id: "future",
      runId: "future-run",
      fetchedAt: "2026-04-04T01:00:00.000Z",
      createdAt: "2026-04-04T01:00:00.000Z",
    });

    const earlierWithoutFuture = selectLatestCompleteCountryGenerationAtCutoff(
      [older],
      "2026-04-03T03:00:00.000Z",
    );
    const earlierWithFuture = selectLatestCompleteCountryGenerationAtCutoff(
      [older, future],
      "2026-04-03T03:00:00.000Z",
    );
    const later = selectLatestCompleteCountryGenerationAtCutoff(
      [older, future],
      "2026-04-05T03:00:00.000Z",
    );

    expect(earlierWithFuture.snapshotIds).toEqual(["older"]);
    expect(earlierWithFuture.sourceHash).toBe(earlierWithoutFuture.sourceHash);
    expect(later.snapshotIds).toEqual(["future"]);
    expect(later.sourceHash).not.toBe(earlierWithFuture.sourceHash);
  });

  it("fails closed when the newest observed generation is not cutoff-valid", () => {
    const older = page([], {
      id: "older",
      runId: "older-run",
      fetchedAt: "2026-04-02T01:00:00.000Z",
      createdAt: "2026-04-02T01:00:00.000Z",
    });
    const newerIncomplete = page([], {
      id: "newer-incomplete",
      runId: "newer-run",
      providerCursor: "next-page",
      fetchedAt: "2026-04-03T01:00:00.000Z",
      createdAt: "2026-04-03T01:00:00.000Z",
    });
    expect(() =>
      selectLatestCompleteCountryGenerationAtCutoff(
        [older, newerIncomplete],
        "2026-04-03T03:00:00.000Z",
      ),
    ).toThrow(/latest_generation_incomplete/);

    const newerCreatedAfterCutoff = {
      ...newerIncomplete,
      id: "newer-created-after-cutoff",
      providerCursor: null,
      createdAt: "2026-04-03T04:00:00.000Z",
    };
    expect(() =>
      selectLatestCompleteCountryGenerationAtCutoff(
        [older, newerCreatedAfterCutoff],
        "2026-04-03T03:00:00.000Z",
      ),
    ).toThrow(/created_after_cutoff/);
  });

  it("rejects exact duplicate and conflicting ad-country keys", () => {
    const duplicate = {
      ad_id: "ad-1",
      country: "US",
      spend: "10",
      date_start: "2026-04-01",
      date_stop: "2026-04-01",
    };
    const exactGeneration = selectLatestCompleteCountryGeneration([
      page([duplicate, duplicate]),
    ]);
    expect(() => normalizeCountryGenerationRows(exactGeneration)).toThrow(
      /duplicate_ad_country_key/,
    );

    const conflictGeneration = selectLatestCompleteCountryGeneration([
      page([duplicate, { ...duplicate, spend: "11" }]),
    ]);
    expect(() => normalizeCountryGenerationRows(conflictGeneration)).toThrow(
      /conflicting_ad_country_key/,
    );
  });

  it("keeps a multi-country ad as a weighted vector with no assigned country", () => {
    const generation = selectLatestCompleteCountryGeneration([
      page([
        { ad_id: "ad-1", country: "US", spend: "40" },
        { ad_id: "ad-1", country: "CA", spend: "60" },
      ]),
    ]);
    const countryRows = normalizeCountryGenerationRows(generation);
    const reconciliations = reconcileCountryAdDaySpend({
      countryRows,
      metaRows: [
        {
          businessId: "business-1",
          providerAccountId: "account-1",
          date: "2026-04-01",
          adId: "ad-1",
          currency: "USD",
          goal: "PURCHASE",
          spend: 100,
          sourceId: "meta-day-1",
        },
      ],
    });
    const result = buildAdCountrySpendMix({
      businessId: "business-1",
      providerAccountId: "account-1",
      currency: "USD",
      goal: "PURCHASE",
      adId: "ad-1",
      asOfDate: "2026-04-01",
      reconciliations,
    });

    expect(result.assignedCountry).toBeNull();
    expect(result.multiCountry).toBe(true);
    expect(result.countries).toEqual([
      { country: "CA", spend: 60, spendShare: 0.6 },
      { country: "US", spend: 40, spendShare: 0.4 },
    ]);
    expect(result.coveredSpendShare).toBe(1);
  });

  it("collapses supported country thresholds by the target ad spend mix", () => {
    const observations = [
      ...Array.from({ length: 8 }, (_, index) =>
        observation({
          id: `us-${index}`,
          value: 1,
          country: "US",
        }),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        observation({
          id: `ca-${index}`,
          value: 4,
          country: "CA",
        }),
      ),
    ];
    const result = resolveH1CountryParentThreshold({
      observations,
      target: {
        businessId: "business-1",
        providerAccountId: "account-1",
        currency: "USD",
        goal: "PURCHASE",
        countryMix: mix("target", [
          { country: "US", spendShare: 0.25 },
          { country: "CA", spendShare: 0.75 },
        ]),
      },
      variant: countryVariant,
    });

    expect(result.usedCountryConditioning).toBe(true);
    expect(result.fallbackSpendShare).toBeCloseTo(0, 12);
    expect(result.countryCells).toHaveLength(2);
    expect(result.value).toBeCloseTo(
      result.countryCells.reduce(
        (sum, cell) => sum + cell.targetSpendShare * cell.threshold,
        0,
      ),
      12,
    );
    expect(result.value).not.toBe(
      result.countryCells.find((cell) => cell.country === "CA")?.threshold,
    );
    expect(
      countryCalibrationConfidenceRank(result.confidence),
    ).toBeLessThanOrEqual(
      countryCalibrationConfidenceRank(result.accountGoal.confidence),
    );
  });

  it("keeps the prepared resolver bit-equivalent to direct resolution", () => {
    const observations = [
      ...Array.from({ length: 8 }, (_, index) =>
        observation({ id: `us-${index}`, value: 1, country: "US" }),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        observation({ id: `ca-${index}`, value: 4, country: "CA" }),
      ),
    ];
    const countryMix = mix("target", [
      { country: "US", spendShare: 0.25 },
      { country: "CA", spendShare: 0.75 },
    ]);
    const target = {
      businessId: "business-1",
      providerAccountId: "account-1",
      currency: "USD",
      goal: "PURCHASE",
    };
    const direct = resolveH1CountryParentThreshold({
      observations,
      target: { ...target, countryMix },
      variant: countryVariant,
    });
    const prepared = prepareH1CountryParentThresholdResolver({
      observations,
      target,
      variant: countryVariant,
    }).resolve({
      parentMode: "account_goal_country_spend_weighted",
      countryMix,
    });

    expect(prepared).toEqual(direct);
  });

  it("falls sparse country cells back to account-goal without more confidence", () => {
    const observations = Array.from({ length: 6 }, (_, index) =>
      observation({
        id: `sparse-${index}`,
        value: index < 3 ? 1 : 2,
        country: index < 3 ? "US" : "CA",
      }),
    );
    const result = resolveH1CountryParentThreshold({
      observations,
      target: {
        businessId: "business-1",
        providerAccountId: "account-1",
        currency: "USD",
        goal: "PURCHASE",
        countryMix: mix("target", [
          { country: "US", spendShare: 0.5 },
          { country: "CA", spendShare: 0.5 },
        ]),
      },
      variant: countryVariant,
    });

    expect(result.value).toBe(result.accountGoal.value);
    expect(result.usedCountryConditioning).toBe(false);
    expect(result.fallbackSpendShare).toBe(1);
    expect(result.countryCells.every((cell) => !cell.adequateSupport)).toBe(
      true,
    );
    expect(
      countryCalibrationConfidenceRank(result.confidence),
    ).toBeLessThanOrEqual(
      countryCalibrationConfidenceRank(result.accountGoal.confidence),
    );
  });

  it("isolates account, currency, and goal calibration cells", () => {
    const inScope = Array.from({ length: 8 }, (_, index) =>
      observation({ id: `in-${index}`, value: 1, country: "US" }),
    );
    const foreignOutsideAccountParent = [
      observation({
        id: "foreign-account",
        value: 100,
        country: "US",
        providerAccountId: "account-2",
      }),
      observation({
        id: "foreign-currency",
        value: 100,
        country: "US",
        currency: "EUR",
      }),
      observation({
        id: "foreign-business",
        value: 100,
        country: "US",
        businessId: "business-2",
      }),
    ];
    const target = {
      businessId: "business-1",
      providerAccountId: "account-1",
      currency: "USD",
      goal: "PURCHASE",
      countryMix: mix("target", [{ country: "US", spendShare: 1 }]),
    };
    const baseline = resolveH1CountryParentThreshold({
      observations: inScope,
      target,
      variant: countryVariant,
    });
    const contaminated = resolveH1CountryParentThreshold({
      observations: [...inScope, ...foreignOutsideAccountParent],
      target,
      variant: countryVariant,
    });

    expect(contaminated).toEqual(baseline);
    expect(contaminated.accountGoal.sampleSize).toBe(8);
    expect(contaminated.countryCells[0]?.sampleSize).toBe(8);

    const explicitAccountParent = resolveH1CountryParentThreshold({
      observations: [
        ...inScope,
        observation({
          id: "other-goal-account-parent",
          value: 100,
          country: "US",
          goal: "LEAD",
        }),
      ],
      target,
      variant: countryVariant,
    });
    expect(explicitAccountParent.accountGoal.goalSampleSize).toBe(8);
    expect(explicitAccountParent.accountGoal.accountParentSampleSize).toBe(9);
    expect(explicitAccountParent.countryCells[0]?.sampleSize).toBe(8);
  });
});
