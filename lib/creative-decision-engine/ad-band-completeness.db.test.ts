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

const MIXED_AD = "ad-MIXED-BAND";
const CLEAN_AD = "ad-CLEAN-BAND";

interface DayRow {
  adId: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  linkClicks: number | null;
}

/*
  The two ads differ by exactly ONE row.

  Both carry the same two fully measured recent days, the same fully measured
  prior band, and the same wholly inert day — zero on every metric, link clicks
  absent — which must NOT count as a gap, because a day with no activity at all
  legitimately has no link clicks. The mixed ad additionally carries the
  anomalous row: zero spend, zero impressions, but real clicks, a conversion
  and revenue, with its link-click reading absent.
*/
function daysFor(adId: string, includeAnomalous: boolean): DayRow[] {
  const rows: DayRow[] = [
    // recent14 — measured.
    { adId, date: "2026-09-01", spend: 60, impressions: 30_000, clicks: 400, conversions: 2, revenue: 240, linkClicks: 300 },
    { adId, date: "2026-09-02", spend: 60, impressions: 30_000, clicks: 400, conversions: 2, revenue: 240, linkClicks: 300 },
    // recent14 — wholly inert. Absent link clicks here are not a gap.
    { adId, date: "2026-09-04", spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0, linkClicks: null },
    // prior14 — measured.
    { adId, date: "2026-08-18", spend: 60, impressions: 30_000, clicks: 400, conversions: 3, revenue: 300, linkClicks: 300 },
    { adId, date: "2026-08-19", spend: 60, impressions: 30_000, clicks: 400, conversions: 3, revenue: 300, linkClicks: 300 },
  ];
  if (includeAnomalous) {
    // THE ROW THE OLD DELIVERY TEST EXEMPTED.
    rows.push({
      adId, date: "2026-09-03", spend: 0, impressions: 0,
      clicks: 25, conversions: 1, revenue: 120, linkClicks: null,
    });
  }
  return rows;
}

async function withClient<T>(fn: (client: import("pg").Client) => Promise<T>): Promise<T> {
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

    const rows = [
      ...daysFor(MIXED_AD, true),
      ...daysFor(CLEAN_AD, false),
    ];
    for (const row of rows) {
      await client.query(
        `INSERT INTO meta_ad_daily
           (business_id, provider_account_id, date, campaign_id, adset_id,
            ad_id, ad_name_current, ad_status, account_timezone,
            account_currency, spend, impressions, clicks, conversions,
            revenue, link_clicks, truth_state, finalized_at, validation_status,
            created_at, updated_at, business_ref_id)
         VALUES ($1::text, $2, $3::date, $4, $5, $6, $6, 'ACTIVE', $7, 'USD',
                 $8, $9, $10, $11, $12, $13::bigint,
                 'finalized', $14::timestamptz, 'passed',
                 $14::timestamptz, $14::timestamptz, $1::uuid)`,
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
          row.conversions,
          row.revenue,
          row.linkClicks,
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
  });
}

describe.runIf(SEAM)("ad band link-click completeness against real PostgreSQL", () => {
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
      await client.query(`DELETE FROM meta_ad_daily WHERE business_id = $1::text`, [BUSINESS_ID]);
      await client.query(
        `DELETE FROM business_provider_accounts WHERE business_id = $1::text`,
        [BUSINESS_ID],
      );
      await client.query(`DELETE FROM provider_accounts WHERE external_account_id = $1`, [ACCOUNT_ID]);
      await client.query(`DELETE FROM businesses WHERE id = $1::uuid`, [BUSINESS_ID]);
      await client.query(`DELETE FROM users WHERE email = $1`, [OWNER_EMAIL]);
    });
  });

  const adNamed = (adId: string) => {
    const input = inputs.find((row) => row.adId === adId);
    expect(input, `hydration produced no row for ${adId}`).toBeDefined();
    return input!;
  };

  it("hydrates both ads with the equal, disjoint pair the contract requires", async () => {
    for (const adId of [MIXED_AD, CLEAN_AD]) {
      const evidence = adNamed(adId).adBandEvidence;
      expect(evidence?.cutoffDate).toBe(AS_OF);
      expect(evidence?.recent14.startDate).toBe("2026-08-24");
      expect(evidence?.recent14.endDate).toBe(AS_OF);
      expect(evidence?.prior14.startDate).toBe("2026-08-10");
      expect(evidence?.prior14.endDate).toBe("2026-08-23");
    }
  });

  it("keeps the measured band measured when the only extra row is wholly inert", async () => {
    /*
      THE CONTROL. Without it, "a NULL row makes the band unknown" would be
      satisfied by a predicate that calls every absent reading a gap, which
      would suppress the denominator for every ad with a dark day and hold the
      whole surface for the wrong reason.
    */
    const evidence = adNamed(CLEAN_AD).adBandEvidence;
    expect(evidence?.recent14.linkClicks).toBe(600);
    expect(evidence?.prior14.linkClicks).toBe(600);
    // The inert day is in the aggregate; it simply contributes nothing.
    expect(evidence?.recent14.clicks).toBe(800);
    expect(evidence?.recent14.spend).toBe(120);
  });

  it("suppresses the band total when a decision-bearing row has no link-click reading", async () => {
    const evidence = adNamed(MIXED_AD).adBandEvidence;
    /*
      THE ASYMMETRY, MADE VISIBLE. The anomalous row is inside the aggregate —
      its 25 clicks, its conversion and its revenue are all counted — so a
      denominator that silently excluded its link clicks would be a fraction of
      a window presented as the whole of it.
    */
    expect(evidence?.recent14.clicks).toBe(825);
    expect(evidence?.recent14.purchases).toBe(5);
    expect(evidence?.recent14.revenue).toBe(600);
    // Zero spend and zero impressions on that row, so the band's delivery
    // totals are unchanged: the row is invisible to the OLD delivery test.
    expect(evidence?.recent14.spend).toBe(120);
    expect(evidence?.recent14.impressions).toBe(60_000);
    // And therefore the link-click total is UNKNOWN, not 600.
    expect(evidence?.recent14.linkClicks).toBeNull();
    // The untouched band still carries its measurement.
    expect(evidence?.prior14.linkClicks).toBe(600);
  });

  it("withholds the lifecycle evidence contract rather than authorizing a partial aggregate", async () => {
    const withheld = computeNativeAdLifecycleEvidence({
      ad: adNamed(MIXED_AD),
      profile: profile(),
      frequencyPressureThreshold: null,
    });
    expect(withheld.missingEvidence).toContain(
      "ad_recent14_window_link_clicks_unavailable",
    );
    expect(withheld.fatigueStatus).toBe("unknown");

    // The same call on the control does NOT raise that reason, which is what
    // makes the withholding attributable to the anomalous row alone.
    const admitted = computeNativeAdLifecycleEvidence({
      ad: adNamed(CLEAN_AD),
      profile: profile(),
      frequencyPressureThreshold: null,
    });
    expect(admitted.missingEvidence).not.toContain(
      "ad_recent14_window_link_clicks_unavailable",
    );
    expect(admitted.missingEvidence).not.toContain(
      "ad_prior14_window_link_clicks_unavailable",
    );
  });
});
