/**
 * A PARTIAL LINK-CLICK BAND IS UNKNOWN — INCLUDING WHEN THE MISSING DAY SPENT
 * NOTHING.
 *
 * `ad_band_aggregates` in `HYDRATE_AD_DECISION_INPUTS_QUERY` counts the rows
 * whose link-click reading is absent, and `toAdDisjointBandObservation` turns
 * any such row into a NULL band total rather than letting `SUM` present part
 * of a window as the whole of it. The count was taken only over rows that
 * delivered, and the delivery test was `impressions > 0 OR spend > 0`.
 *
 * That exempted the rows most likely to be anomalous. An ad-day can carry
 * clicks, conversions and revenue while its spend and impressions come back
 * zero — a late-attributed conversion written onto an already-closed day, a
 * lifetime-budget day whose spend lands on the parent, a partial capture the
 * provider later completes. Such a row was read as "did not deliver", so its
 * NULL link-click reading did not count as missing, the band was admitted as
 * fully measured, and the click-to-purchase composite divided a numerator that
 * INCLUDED that row's conversions by a denominator that EXCLUDED its link
 * clicks. The asymmetry is the defect, and it is the one this file pins.
 *
 * Historical non-null zeros need the same treatment. Before nullable ingestion,
 * the writer stored literal 0 when Meta supplied no actions breakdown, and the
 * widening migration intentionally preserved those rows. A zero enters the band
 * here only when that row's stored actions prove either Meta's omitted-action
 * measured-zero encoding or one strict string zero. Missing actions, a positive
 * contradiction, duplicate entries, JSON numeric zero, and malformed zero all
 * remain unknown on a decision-bearing day.
 *
 * WHY REAL POSTGRES. Every claim here is a claim about what SQL decided:
 * whether a `COUNT(*) FILTER (...)` over a real mixed band returned 1 or 0,
 * and whether `SUM(link_clicks)` over the same band was therefore carried or
 * suppressed. A mocked hydration row answers both with whatever the test
 * author typed into the fixture — the mapper tests in
 * `__tests__/data-source.ad-grain.test.ts` set `recent14_link_clicks` by hand
 * and can never exercise the predicate that produces it.
 *
 * The rows are written with the columns the authoritative writer writes and
 * read back through the shipped `WarehouseDataSource.listAdDecisionInputs`;
 * no query in this file restates production SQL.
 *
 * Runs only inside an ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`),
 * because outside one `DATABASE_URL` in this repository points at PRODUCTION.
 * Under a plain `npx vitest run` the default include still COLLECTS this file
 * and `describe.runIf(SEAM)` reports it as skipped, which reads green — so it
 * is registered as a stage of `scripts/ephemeral-postgres-migrations-check.ts`
 * with a pinned passing count.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WarehouseDataSource } from "./data-source";
import { computeNativeAdLifecycleEvidence } from "./jobs/ad-decisions-job";
import {
  hasRefreshDecayEvidence,
  shouldRefreshOnFatigue,
} from "./gates/ratio-zones";
import {
  makeAccountCalibration,
  makeAccountDecisionProfile,
} from "./__tests__/helpers";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

const BUSINESS_ID = "00000000-0000-4000-8000-0000000009a1";
const OWNER_EMAIL = "ad-band-completeness-seam@example.test";
const ACCOUNT_ID = "act_band_completeness";
const ACCOUNT_TZ = "UTC";
const CAMPAIGN_ID = "campaign-band-completeness";
const ADSET_ID = "adset-band-completeness";

/** recent14 = 2026-08-24..2026-09-06, prior14 = 2026-08-10..2026-08-23. */
const AS_OF = "2026-09-06";
const DECISION_CUTOFF = "2026-09-07T00:00:00.000Z";
/** Before the cutoff, so every seeded row is admissible. */
const ROW_CLOCK = "2026-09-06T06:00:00.000Z";

const CLEAN_AD = "ad-CLEAN-BAND";
const MISSING_AD = "ad-MISSING-BAND";
const LEGACY_ZERO_AD = "ad-LEGACY-ZERO-BAND";
const MEASURED_ZERO_AD = "ad-MEASURED-ZERO-BAND";
const EXPLICIT_ZERO_AD = "ad-EXPLICIT-ZERO-BAND";
const CONTRADICTED_ZERO_AD = "ad-CONTRADICTED-ZERO-BAND";
const DUPLICATE_ZERO_AD = "ad-DUPLICATE-ZERO-BAND";
const NUMERIC_ZERO_AD = "ad-NUMERIC-ZERO-BAND";
const MALFORMED_ZERO_AD = "ad-MALFORMED-ZERO-BAND";
const NON_ARRAY_ACTIONS_AD = "ad-NON-ARRAY-ACTIONS-BAND";

type ProvenanceVariant =
  | "clean"
  | "missing"
  | "legacy_zero"
  | "measured_zero"
  | "explicit_zero"
  | "contradicted_zero"
  | "duplicate_zero"
  | "numeric_zero"
  | "malformed_zero"
  | "non_array_actions";

const AD_CASES: ReadonlyArray<readonly [string, ProvenanceVariant]> = [
  [CLEAN_AD, "clean"],
  [MISSING_AD, "missing"],
  [LEGACY_ZERO_AD, "legacy_zero"],
  [MEASURED_ZERO_AD, "measured_zero"],
  [EXPLICIT_ZERO_AD, "explicit_zero"],
  [CONTRADICTED_ZERO_AD, "contradicted_zero"],
  [DUPLICATE_ZERO_AD, "duplicate_zero"],
  [NUMERIC_ZERO_AD, "numeric_zero"],
  [MALFORMED_ZERO_AD, "malformed_zero"],
  [NON_ARRAY_ACTIONS_AD, "non_array_actions"],
];

const ADMITTED_ADS = [CLEAN_AD, MEASURED_ZERO_AD, EXPLICIT_ZERO_AD] as const;
const WITHHELD_ADS = [
  MISSING_AD,
  LEGACY_ZERO_AD,
  CONTRADICTED_ZERO_AD,
  DUPLICATE_ZERO_AD,
  NUMERIC_ZERO_AD,
  MALFORMED_ZERO_AD,
  NON_ARRAY_ACTIONS_AD,
] as const;

interface DayRow {
  adId: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  linkClicks: number | null;
  reach: number;
  frequency: number | null;
  payloadJson?: Record<string, unknown>;
}

/*
  Nine otherwise-identical ads exercise the complete provenance boundary.

  Every ad carries the same measured rows and the same wholly inert NULL day,
  which is not a gap. Every non-clean variant then adds the same decision-bearing
  row: clicks, a late-attributed conversion and revenue, with zero delivery. Only
  its stored link-click value and row-local actions payload differ. This makes
  admission attributable to provenance rather than to a different metric shape.
*/
function anomalyFor(
  adId: string,
  variant: Exclude<ProvenanceVariant, "clean">,
): DayRow {
  let linkClicks: number | null = 0;
  let payloadJson: Record<string, unknown>;
  switch (variant) {
    case "missing":
      linkClicks = null;
      payloadJson = {};
      break;
    case "legacy_zero":
      payloadJson = {};
      break;
    case "measured_zero":
      payloadJson = { actions: [{ action_type: "purchase", value: "1" }] };
      break;
    case "explicit_zero":
      payloadJson = { actions: [{ action_type: "link_click", value: "0" }] };
      break;
    case "contradicted_zero":
      payloadJson = { actions: [{ action_type: "link_click", value: "17" }] };
      break;
    case "duplicate_zero":
      payloadJson = {
        actions: [
          { action_type: "link_click", value: "0" },
          { action_type: "link_click", value: "0" },
        ],
      };
      break;
    case "numeric_zero":
      payloadJson = { actions: [{ action_type: "link_click", value: 0 }] };
      break;
    case "malformed_zero":
      payloadJson = { actions: [{ action_type: "link_click", value: "0.0" }] };
      break;
    case "non_array_actions":
      payloadJson = { actions: { action_type: "link_click", value: "0" } };
      break;
  }
  return {
    adId,
    date: "2026-09-03",
    spend: 0,
    impressions: 0,
    clicks: 25,
    conversions: 1,
    revenue: 120,
    linkClicks,
    reach: 0,
    frequency: null,
    payloadJson,
  };
}

function measuredDay(
  input: Omit<DayRow, "reach" | "frequency" | "payloadJson">,
): DayRow {
  return {
    ...input,
    reach: input.impressions / 5,
    frequency: 5,
    payloadJson: {
      actions: [{ action_type: "link_click", value: String(input.linkClicks) }],
    },
  };
}

function daysFor(adId: string, variant: ProvenanceVariant): DayRow[] {
  const rows: DayRow[] = [
    // recent14 — measured and materially weaker than prior14.
    measuredDay({
      adId,
      date: "2026-09-01",
      spend: 100,
      impressions: 50_000,
      clicks: 300,
      conversions: 2,
      revenue: 200,
      linkClicks: 400,
    }),
    measuredDay({
      adId,
      date: "2026-09-02",
      spend: 100,
      impressions: 50_000,
      clicks: 300,
      conversions: 2,
      revenue: 200,
      linkClicks: 400,
    }),
    // recent14 — wholly inert. Absent link clicks here are not a gap.
    {
      adId,
      date: "2026-09-04",
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      revenue: 0,
      linkClicks: null,
      reach: 0,
      frequency: null,
    },
    // prior14 — strong, measured winner memory.
    measuredDay({
      adId,
      date: "2026-08-18",
      spend: 100,
      impressions: 50_000,
      clicks: 1_000,
      conversions: 6,
      revenue: 600,
      linkClicks: 600,
    }),
    measuredDay({
      adId,
      date: "2026-08-19",
      spend: 100,
      impressions: 50_000,
      clicks: 1_000,
      conversions: 6,
      revenue: 600,
      linkClicks: 600,
    }),
  ];
  if (variant !== "clean") rows.push(anomalyFor(adId, variant));
  return rows;
}

async function withClient<T>(
  fn: (client: import("pg").Client) => Promise<T>,
): Promise<T> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function seed() {
  await withClient(async (client) => {
    const userId = (
      await client.query(
        `INSERT INTO users (name, email, password_hash)
         VALUES ('Ad band completeness seam', $1, 'unused') RETURNING id`,
        [OWNER_EMAIL],
      )
    ).rows[0].id as string;
    await client.query(
      `INSERT INTO businesses (id, name, owner_id, currency, platform)
       VALUES ($1::uuid, 'Ad band completeness seam', $2, 'USD', 'shopify')`,
      [BUSINESS_ID, userId],
    );
    const accountRefId = (
      await client.query(
        `INSERT INTO provider_accounts
           (provider, external_account_id, account_name, currency, timezone)
         VALUES ('meta', $1, 'Ad band completeness seam', 'USD', $2)
         RETURNING id`,
        [ACCOUNT_ID, ACCOUNT_TZ],
      )
    ).rows[0].id as string;
    await client.query(
      `INSERT INTO business_provider_accounts
         (business_id, provider, provider_account_id, is_selected,
          business_ref_id, provider_account_ref_id)
       VALUES ($1::text, 'meta', $2, true, $1::uuid, $3::uuid)`,
      [BUSINESS_ID, ACCOUNT_ID, accountRefId],
    );

    const rows = AD_CASES.flatMap(([adId, variant]) => daysFor(adId, variant));
    const dates = Array.from(new Set(rows.map((row) => row.date)));
    for (const date of dates) {
      /*
        Historical campaign context makes these real purchase-cohort inputs, so
        the hydrated 28d/7d ROAS can drive the exact Refresh predicate below.
      */
      await client.query(
        `INSERT INTO meta_campaign_daily
           (business_id, provider_account_id, date, campaign_id,
            campaign_name_current, campaign_status, objective,
            optimization_goal, custom_event_type, account_timezone,
            account_currency, truth_state, finalized_at, validation_status,
            created_at, updated_at)
         VALUES ($1::text, $2, $3::date, $4, $4, 'ACTIVE', 'OUTCOME_SALES',
                 'OFFSITE_CONVERSIONS', 'PURCHASE', $5, 'USD', 'finalized',
                 $6::timestamptz, 'passed', $6::timestamptz, $6::timestamptz)`,
        [BUSINESS_ID, ACCOUNT_ID, date, CAMPAIGN_ID, ACCOUNT_TZ, ROW_CLOCK],
      );
    }
    for (const row of rows) {
      await client.query(
        `INSERT INTO meta_ad_daily
           (business_id, provider_account_id, date, campaign_id, adset_id,
            ad_id, ad_name_current, ad_status, account_timezone,
            account_currency, spend, impressions, clicks, reach, frequency,
            conversions, revenue, link_clicks, payload_json, truth_state,
            finalized_at, validation_status, created_at, updated_at,
            business_ref_id)
         VALUES ($1::text, $2, $3::date, $4, $5, $6, $6, 'ACTIVE', $7, 'USD',
                 $8, $9, $10, $11, $12, $13, $14, $15::bigint, $16::jsonb,
                 'finalized', $17::timestamptz, 'passed',
                 $17::timestamptz, $17::timestamptz, $1::uuid)`,
        [
          BUSINESS_ID,
          ACCOUNT_ID,
          row.date,
          CAMPAIGN_ID,
          ADSET_ID,
          row.adId,
          ACCOUNT_TZ,
          row.spend,
          row.impressions,
          row.clicks,
          row.reach,
          row.frequency,
          row.conversions,
          row.revenue,
          row.linkClicks,
          JSON.stringify(row.payloadJson ?? {}),
          ROW_CLOCK,
        ],
      );
    }
  });
}

function profile() {
  return makeAccountDecisionProfile({
    businessId: BUSINESS_ID,
    asOfDate: AS_OF,
    accountBaselines: makeAccountCalibration({
      matureCreativeCount: 35,
      winnerPurchaseP50: 6,
      refreshRatioP10: 0.8,
    }),
    thresholds: {
      recentSampleMinSpend: 100,
      winnerMemoryMinSpend: 150,
      winnerMemoryMinPurchases: 5,
    },
  });
}

describe.runIf(SEAM)(
  "ad band link-click completeness against real PostgreSQL",
  () => {
    let inputs: Awaited<
      ReturnType<WarehouseDataSource["listAdDecisionInputs"]>
    > = [];

    beforeAll(async () => {
      await seed();
      inputs = await new WarehouseDataSource().listAdDecisionInputs({
        businessId: BUSINESS_ID,
        asOf: AS_OF,
        decisionCutoff: DECISION_CUTOFF,
      });
    });

    afterAll(async () => {
      await withClient(async (client) => {
        await client.query(
          `DELETE FROM meta_ad_daily WHERE business_id = $1::text`,
          [BUSINESS_ID],
        );
        await client.query(
          `DELETE FROM meta_campaign_daily WHERE business_id = $1::text`,
          [BUSINESS_ID],
        );
        await client.query(
          `DELETE FROM business_provider_accounts WHERE business_id = $1::text`,
          [BUSINESS_ID],
        );
        await client.query(
          `DELETE FROM provider_accounts WHERE external_account_id = $1`,
          [ACCOUNT_ID],
        );
        await client.query(`DELETE FROM businesses WHERE id = $1::uuid`, [
          BUSINESS_ID,
        ]);
        await client.query(`DELETE FROM users WHERE email = $1`, [OWNER_EMAIL]);
      });
    });

    const adNamed = (adId: string) => {
      const input = inputs.find((row) => row.adId === adId);
      expect(input, `hydration produced no row for ${adId}`).toBeDefined();
      return input!;
    };

    it("hydrates every provenance case with the equal, disjoint pair the contract requires", async () => {
      for (const [adId] of AD_CASES) {
        const evidence = adNamed(adId).adBandEvidence;
        expect(evidence?.cutoffDate).toBe(AS_OF);
        expect(evidence?.recent14.startDate).toBe("2026-08-24");
        expect(evidence?.recent14.endDate).toBe(AS_OF);
        expect(evidence?.prior14.startDate).toBe("2026-08-10");
        expect(evidence?.prior14.endDate).toBe("2026-08-23");
      }
    });

    it("admits provider-proven zeros while keeping the wholly inert NULL day non-blocking", async () => {
      /*
      THREE POSITIVE CONTROLS. The clean row proves an inert NULL is harmless.
      The other two prove both encodings admitted by the forward parser: an
      actions array with no link_click entry and one exact string zero.
    */
      const evidence = adNamed(CLEAN_AD).adBandEvidence;
      expect(evidence?.recent14.linkClicks).toBe(800);
      expect(evidence?.prior14.linkClicks).toBe(1_200);
      // The inert day is in the aggregate; it simply contributes nothing.
      expect(evidence?.recent14.clicks).toBe(600);
      expect(evidence?.recent14.spend).toBe(200);

      for (const adId of [MEASURED_ZERO_AD, EXPLICIT_ZERO_AD]) {
        const measuredZero = adNamed(adId);
        expect(measuredZero.adBandEvidence?.recent14.linkClicks).toBe(800);
        expect(measuredZero.adBandEvidence?.prior14.linkClicks).toBe(1_200);
        // The anomalous row's outcomes remain in the same admitted band.
        expect(measuredZero.adBandEvidence?.recent14.clicks).toBe(625);
        expect(measuredZero.adBandEvidence?.recent14.purchases).toBe(5);
        expect(measuredZero.adBandEvidence?.recent14.revenue).toBe(520);
        expect(measuredZero.frequency).toBeCloseTo(5);
        expect(measuredZero.effectiveCohort).toBe("purchase");
        expect(measuredZero.roas).toBeCloseTo(4.3);
        expect(measuredZero.recent7dRoas).toBeCloseTo(2.6);
      }
    });

  it("suppresses partial totals for every missing or invalid zero provenance shape", async () => {
      for (const adId of WITHHELD_ADS) {
        const evidence = adNamed(adId).adBandEvidence;
        /*
        THE ASYMMETRY, MADE VISIBLE. Every anomalous row is inside the
        aggregate — its clicks, conversion and revenue are counted — so a
        denominator that silently excludes its link clicks would be only a
        fraction of the window presented as the whole of it.
      */
        expect(evidence?.recent14.clicks).toBe(625);
        expect(evidence?.recent14.purchases).toBe(5);
        expect(evidence?.recent14.revenue).toBe(520);
        // Zero spend and impressions preserve the earlier decision-bearing edge.
        expect(evidence?.recent14.spend).toBe(200);
        expect(evidence?.recent14.impressions).toBe(100_000);
        expect(evidence?.recent14.linkClicks).toBeNull();
        expect(evidence?.prior14.linkClicks).toBe(1_200);
      }
    });

    it("authorizes the Refresh predicate only for complete, provider-proven band evidence", async () => {
      const decisionProfile = profile();
      const frequencyPressureThreshold = 4;

      for (const adId of ADMITTED_ADS) {
        const ad = adNamed(adId);
        const admitted = computeNativeAdLifecycleEvidence({
          ad,
          profile: decisionProfile,
          frequencyPressureThreshold,
        });
        expect(ad.frequency).toBeCloseTo(5);
        expect(admitted.missingEvidence).toEqual([]);
        expect(admitted.fatigueStatus).toBe("fatigued");

        const resolverInput = {
          ...ad,
          creativeId: ad.creativeId ?? `native-ad:${ad.adId}`,
          fatigueStatus: admitted.fatigueStatus,
        };
        expect(hasRefreshDecayEvidence(resolverInput, decisionProfile)).toBe(
          true,
        );
        expect(shouldRefreshOnFatigue(resolverInput, decisionProfile)).toBe(
          true,
        );
      }

      for (const adId of WITHHELD_ADS) {
        const ad = adNamed(adId);
        const withheld = computeNativeAdLifecycleEvidence({
          ad,
          profile: decisionProfile,
          frequencyPressureThreshold,
        });
        expect(withheld.missingEvidence).toContain(
          "ad_recent14_window_link_clicks_unavailable",
        );
        expect(withheld.fatigueStatus).toBe("unknown");

        const resolverInput = {
          ...ad,
          creativeId: ad.creativeId ?? `native-ad:${ad.adId}`,
          fatigueStatus: withheld.fatigueStatus,
        };
        // The economic decay remains a Refresh candidate; provenance alone holds it.
        expect(hasRefreshDecayEvidence(resolverInput, decisionProfile)).toBe(
          true,
        );
        expect(shouldRefreshOnFatigue(resolverInput, decisionProfile)).toBe(
          false,
        );
      }
    });
  },
);
