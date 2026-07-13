import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CountryAdDayReconciliation,
  MetaAdDaySpendFact,
  RawCountrySnapshotPage,
} from "@/lib/creative-decision-engine/simulation/country-conditioned-calibration";
import {
  H1_COUNTRY_PARENT_QUERY_POLICY,
  buildCutoffStrictH1CountryReplay,
  buildVariantIndependentH1CountryCohort,
  evaluateH1CountryParentGrid,
  type H1CountryAccountCompleteness,
  type H1CountryMetaFact,
  type H1CountryTargetPack,
} from "./h1-country-parent-challenger";

const businessId = "00000000-0000-4000-8000-000000000001";
const accountId = "act_1";
const adId = "ad-1";
const decisionDate = "2026-04-01";

function fact(
  date: string,
  overrides: Partial<H1CountryMetaFact> = {},
): H1CountryMetaFact {
  return {
    businessId,
    legacyBusinessId: "legacy-business",
    businessName: "Business",
    providerAccountId: accountId,
    date,
    campaignId: "campaign-1",
    adsetId: "adset-1",
    adId,
    currency: "USD",
    objective: "OUTCOME_SALES",
    goal: "OFFSITE_CONVERSIONS",
    customEventType: "PURCHASE",
    spend: 0,
    impressions: 0,
    conversions: 0,
    revenue: 0,
    sourceId: `meta-${date}`,
    updatedAt: `${date}T05:00:00.000Z`,
    ...overrides,
  };
}

const facts: H1CountryMetaFact[] = [
  fact(decisionDate, {
    spend: 100,
    impressions: 1_000,
    conversions: 1,
    revenue: 100,
  }),
  fact("2026-04-02", {
    spend: 20,
    impressions: 200,
    revenue: 0,
  }),
];

const target: H1CountryTargetPack = {
  id: "target-1",
  businessId,
  targetCpa: 20,
  targetRoas: 2,
  breakEvenRoas: 1.5,
  operatorAovAssumption: 100,
  riskPosture: "balanced",
  updatedAt: "2026-03-20T00:00:00.000Z",
};

const completeness: H1CountryAccountCompleteness[] = Array.from(
  { length: 14 },
  (_, index) => {
    const date = new Date("2026-04-02T00:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + index);
    const iso = date.toISOString().slice(0, 10);
    return {
      businessId,
      providerAccountId: accountId,
      date: iso,
      complete: true,
      sourceIds: [`account-${iso}`],
    };
  },
);

const reconciliations: CountryAdDayReconciliation[] = [
  {
    key: `${businessId}::${accountId}::${decisionDate}::${adId}`,
    businessId,
    providerAccountId: accountId,
    date: decisionDate,
    adId,
    currency: "USD",
    goal: "OFFSITE_CONVERSIONS",
    metaSpend: 100,
    rawCountrySpend: 100,
    difference: 0,
    allowedDifference: 0.5,
    status: "reconciled",
    countrySpend: [
      { country: "CA", spend: 25 },
      { country: "US", spend: 75 },
    ],
    metaSourceId: `meta-${decisionDate}`,
    sourceGenerationHashes: ["country-generation-1"],
  },
];

function build(order: "forward" | "reverse") {
  const reverse = <T>(rows: readonly T[]) =>
    order === "forward" ? [...rows] : [...rows].reverse();
  return buildVariantIndependentH1CountryCohort({
    facts: reverse(facts),
    targets: [target],
    completeness: reverse(completeness),
    reconciliations: reverse(reconciliations),
    startDate: decisionDate,
    decisionEndDate: decisionDate,
    outcomeCeiling: "2026-07-11",
  });
}

describe("H1 country-parent challenger", () => {
  it("keeps a future country generation out of an earlier decision and admits it at a later cutoff", () => {
    const countryPage = (
      id: string,
      runId: string,
      fetchedAt: string,
      country: string,
    ): RawCountrySnapshotPage => ({
      id,
      businessId,
      providerAccountId: accountId,
      sourceDate: decisionDate,
      partitionId: "partition-1",
      runId,
      pageIndex: 0,
      providerCursor: null,
      providerHttpStatus: 200,
      status: "fetched",
      fetchedAt,
      createdAt: fetchedAt,
      payload: [
        {
          ad_id: adId,
          campaign_id: "campaign-1",
          adset_id: "adset-1",
          country,
          spend: "100",
          date_start: decisionDate,
          date_stop: decisionDate,
        },
      ],
    });
    const older = countryPage(
      "country-old",
      "run-old",
      "2026-04-01T02:00:00.000Z",
      "US",
    );
    const future = countryPage(
      "country-future",
      "run-future",
      "2026-04-05T02:00:00.000Z",
      "CA",
    );
    const metaRows: MetaAdDaySpendFact[] = [
      {
        businessId,
        providerAccountId: accountId,
        date: decisionDate,
        adId,
        campaignId: "campaign-1",
        adsetId: "adset-1",
        currency: "USD",
        goal: "OFFSITE_CONVERSIONS",
        spend: 100,
        sourceId: "meta-country-day",
      },
    ];
    const decisionDatesByAccount = new Map([
      [`${businessId}::${accountId}`, [decisionDate, "2026-04-08"]],
    ]);
    const replayWithFuture = buildCutoffStrictH1CountryReplay({
      pages: [older, future],
      metaRows,
      decisionDatesByAccount,
    });
    const replayWithoutFuture = buildCutoffStrictH1CountryReplay({
      pages: [older],
      metaRows,
      decisionDatesByAccount,
    });
    const replayWithReversedInputs = buildCutoffStrictH1CountryReplay({
      pages: [future, older],
      metaRows: [...metaRows].reverse(),
      decisionDatesByAccount: new Map([
        [`${businessId}::${accountId}`, ["2026-04-08", decisionDate]],
      ]),
    });
    const newerIncomplete: RawCountrySnapshotPage = {
      ...future,
      id: "country-incomplete",
      runId: "run-incomplete",
      fetchedAt: "2026-04-01T02:30:00.000Z",
      createdAt: "2026-04-01T02:30:00.000Z",
      providerCursor: "next-page",
    };
    const failClosedReplay = buildCutoffStrictH1CountryReplay({
      pages: [older, newerIncomplete],
      metaRows,
      decisionDatesByAccount: new Map([
        [`${businessId}::${accountId}`, [decisionDate]],
      ]),
    });
    const scope = {
      businessId,
      providerAccountId: accountId,
      currency: "USD",
      goal: "OFFSITE_CONVERSIONS",
      adId,
    };
    const earlierWithFuture = replayWithFuture.resolveCountryMix({
      ...scope,
      asOfDate: decisionDate,
    });
    const earlierWithoutFuture = replayWithoutFuture.resolveCountryMix({
      ...scope,
      asOfDate: decisionDate,
    });
    const later = replayWithFuture.resolveCountryMix({
      ...scope,
      asOfDate: "2026-04-08",
    });
    const reversedEarlier = replayWithReversedInputs.resolveCountryMix({
      ...scope,
      asOfDate: decisionDate,
    });
    const reversedLater = replayWithReversedInputs.resolveCountryMix({
      ...scope,
      asOfDate: "2026-04-08",
    });

    expect(earlierWithFuture).toEqual(earlierWithoutFuture);
    expect(reversedEarlier).toEqual(earlierWithFuture);
    expect(reversedLater).toEqual(later);
    expect(replayWithReversedInputs.coverage.selectionPlanHash).toBe(
      replayWithFuture.coverage.selectionPlanHash,
    );
    expect(earlierWithFuture.countries).toEqual([
      { country: "US", spend: 100, spendShare: 1 },
    ]);
    expect(later.countries).toEqual([
      { country: "CA", spend: 100, spendShare: 1 },
    ]);
    expect(later.sourceGenerationHashes).not.toEqual(
      earlierWithFuture.sourceGenerationHashes,
    );
    const failClosed = failClosedReplay.resolveCountryMix({
      ...scope,
      asOfDate: decisionDate,
    });
    expect(failClosed.available).toBe(false);
    expect(failClosed.countries).toEqual([]);
    expect(failClosed.sourceGenerationHashes).toEqual([]);
    expect(failClosedReplay.coverage.incompleteOrInvalidLatestGenerations).toBe(
      1,
    );
  });

  it("builds one deterministic variant-independent fixed cohort", () => {
    const forward = build("forward");
    const reverse = build("reverse");

    expect(reverse.fixedCohortHash).toBe(forward.fixedCohortHash);
    expect(reverse.manifestSetHash).toBe(forward.manifestSetHash);
    expect(reverse.rows).toEqual(forward.rows);
    expect(forward.coverage).toMatchObject({
      rows: 1,
      uniqueKeys: 1,
      completeOutcomeRows: 1,
      completeOutcomeRowsByWindow: { "3d": 1, "7d": 1, "14d": 1 },
      countryMixAvailableRows: 1,
      multiCountryRows: 1,
    });
    expect(forward.rows[0]?.countryMix.assignedCountry).toBeNull();
    expect(forward.rows[0]?.outcome).toEqual(forward.rows[0]?.outcomes[14]);
    expect(
      [3, 7, 14].map((windowDays) => ({
        windowDays,
        dueDate:
          forward.rows[0]?.outcomes[windowDays as 3 | 7 | 14].dueDate,
        status:
          forward.rows[0]?.outcomes[windowDays as 3 | 7 | 14].status,
      })),
    ).toEqual([
      { windowDays: 3, dueDate: "2026-04-04", status: "supported" },
      { windowDays: 7, dueDate: "2026-04-08", status: "supported" },
      { windowDays: 14, dueDate: "2026-04-15", status: "supported" },
    ]);
  });

  it("pairs all 144 parent comparisons on the same fixed row set", () => {
    const cohort = build("forward");
    const evaluation = evaluateH1CountryParentGrid({
      cohort,
      outcomeCeiling: "2026-07-11",
      bootstrapIterations: 100,
    });

    expect(evaluation.variants).toHaveLength(288);
    expect(evaluation.summaries).toHaveLength(288);
    expect(evaluation.pairComparisons).toHaveLength(144);
    expect(
      new Set(
        evaluation.pairComparisons.map(
          (comparison) => comparison.full.cohortHash,
        ),
      ).size,
    ).toBe(1);
    expect(
      evaluation.pairComparisons.every(
        (comparison) => comparison.full.cohortRows === cohort.rows.length,
      ),
    ).toBe(true);
  });

  it("contains only a verified SELECT/read-only DB path and no artifact writer", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("./h1-country-parent-challenger.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(H1_COUNTRY_PARENT_QUERY_POLICY).toEqual({
      databaseTransaction: "read_only",
      providerCalls: false,
      databaseWrites: false,
      filesystemWrites: false,
      manualCron: false,
      output: "stdout_json_only",
    });
    expect(source).toContain('client.query("BEGIN READ ONLY")');
    expect(source).toContain('"SHOW transaction_read_only"');
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/);
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("writeFile");
    expect(source).not.toContain("mkdir");
  });
});
