/**
 * ADR D107 — ONLY AN OBSERVED DIFFERENCE ENDS AN ADMITTED RUN.
 *
 * The native Ad loader admits the latest run of economically meaningful days
 * that carries one resolvable context. Under D098 a day whose context did not
 * resolve counted as a DIFFERENT context: `context_key IS DISTINCT FROM`. On
 * 2026-09-24 a sync rewrote Grandmix's 2026-09-21 objective to NULL, and every
 * one of its ads' 28-day runs collapsed to 2026-09-22. Ads with weeks of strong
 * delivery were then judged on one day and $26 of spend: 0 purchases, a
 * soft-only Cut and a cut_candidate badge, under a reason that said "28d".
 *
 * These ads pin the SQL rule against real PostgreSQL, read back through the
 * shipped `WarehouseDataSource.listAdDecisionInputs`:
 *
 *   BRIDGE     one unreadable interior day, same context on both sides:
 *              the run keeps all ten days; the gap day is admitted as a
 *              bridged day and carries no authority, so the ad is NOT fully
 *              verified.
 *   CHANGE     the ad set's optimization goal genuinely changed on a
 *              provider receipt: the run starts at the change — a short
 *              window after an observed change is valid.
 *   CONTRADICT an unresolved day (no campaign receipt) that still OBSERVED a
 *              different goal: that is an observed change, and it ends the run.
 *   LEADING    unreadable days at the older edge are not bridged: nothing
 *              older shares the context, so they stay out.
 *   TRAILING   unreadable days after the newest resolved day end the run
 *              earlier; the latest value is never carried past it.
 *   EMPTY_GAP  an unreadable EMPTY day inside the run no longer turns the ad's
 *              identity "unknown" (which made its objective NULL and its cohort
 *              unknown).
 *
 * Config values come only from explicit, complete raw config receipts — one
 * account-wide page per endpoint per day, exactly as the provider list GETs are
 * captured. No dated Insights field is used as configuration evidence.
 *
 * Runs only inside an ephemeral-database seam (`ADSECUTE_EPHEMERAL_DB_SEAM=1`),
 * because outside one `DATABASE_URL` in this repository points at PRODUCTION.
 * It is registered as a stage of `scripts/ephemeral-postgres-migrations-check.ts`
 * with a pinned passing count.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WarehouseDataSource } from "./data-source";
import type { AdDecisionInput } from "./types";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000d07";
const OWNER_EMAIL = "admitted-window-d107-seam@example.test";
const ACCOUNT_ID = "act_admitted_window_d107";
const ACCOUNT_TZ = "UTC";

const AS_OF = "2026-09-10";
const DECISION_CUTOFF = "2026-09-11T00:00:00.000Z";
/** Before the cutoff, so every seeded ad-day row is admissible. */
const ROW_CLOCK = "2026-09-10T06:00:00.000Z";

const DATES = [
  "2026-09-01",
  "2026-09-02",
  "2026-09-03",
  "2026-09-04",
  "2026-09-05",
  "2026-09-06",
  "2026-09-07",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
] as const;
type SeamDate = (typeof DATES)[number];

const OLD_CLOCK = "2026-08-01T00:00:00+0000";
const CHANGE_CLOCK = "2026-09-05T23:00:00+0000";

interface Scenario {
  adId: string;
  campaignId: string;
  adsetId: string;
  /** Days whose campaign receipt names this campaign (objective observed). */
  campaignObserved: (date: SeamDate) => boolean;
  /** The ad set goal a day's ad set receipt names, or null for no receipt. */
  adsetGoal: (date: SeamDate) => string | null;
  /** Days with no spend, conversions or revenue at all. */
  empty?: (date: SeamDate) => boolean;
  /** The ad-day's own account currency; USD unless stated. */
  currency?: (date: SeamDate) => string;
}

const always = () => true;
const goal = (value: string) => () => value;

const SCENARIOS: Record<
  | "BRIDGE"
  | "CHANGE"
  | "CONTRADICT"
  | "LEADING"
  | "TRAILING"
  | "EMPTY_GAP"
  | "RECEIPTED_GAP"
  | "CURRENCY_ANOMALY",
  Scenario
> = {
  BRIDGE: {
    adId: "ad-d107-bridge",
    campaignId: "campaign-d107-bridge",
    adsetId: "adset-d107-bridge",
    campaignObserved: (date) => date !== "2026-09-06",
    adsetGoal: (date) => (date === "2026-09-06" ? null : "OFFSITE_CONVERSIONS"),
  },
  CHANGE: {
    adId: "ad-d107-change",
    campaignId: "campaign-d107-change",
    adsetId: "adset-d107-change",
    campaignObserved: always,
    adsetGoal: (date) => (date < "2026-09-06" ? "OFFSITE_CONVERSIONS" : "VALUE"),
  },
  CONTRADICT: {
    adId: "ad-d107-contradict",
    campaignId: "campaign-d107-contradict",
    adsetId: "adset-d107-contradict",
    campaignObserved: (date) => date !== "2026-09-06",
    adsetGoal: (date) => (date === "2026-09-06" ? "VALUE" : "OFFSITE_CONVERSIONS"),
  },
  LEADING: {
    adId: "ad-d107-leading",
    campaignId: "campaign-d107-leading",
    adsetId: "adset-d107-leading",
    campaignObserved: (date) => date >= "2026-09-05",
    adsetGoal: (date) => (date >= "2026-09-05" ? "OFFSITE_CONVERSIONS" : null),
  },
  TRAILING: {
    adId: "ad-d107-trailing",
    campaignId: "campaign-d107-trailing",
    adsetId: "adset-d107-trailing",
    campaignObserved: (date) => date <= "2026-09-08",
    adsetGoal: (date) => (date <= "2026-09-08" ? "OFFSITE_CONVERSIONS" : null),
  },
  EMPTY_GAP: {
    adId: "ad-d107-empty-gap",
    campaignId: "campaign-d107-empty-gap",
    adsetId: "adset-d107-empty-gap",
    campaignObserved: (date) => date !== "2026-09-06",
    adsetGoal: (date) => (date === "2026-09-06" ? null : "OFFSITE_CONVERSIONS"),
    empty: (date) => date === "2026-09-06",
  },
  /*
    Full campaign and ad-set receipts on every day, but the ad-day row for
    2026-09-06 lost its account currency. The day does not resolve, so it is
    bridged — and its receipt-backed fields must still carry NO authority.
  */
  RECEIPTED_GAP: {
    adId: "ad-d107-receipted-gap",
    campaignId: "campaign-d107-receipted-gap",
    adsetId: "adset-d107-receipted-gap",
    campaignObserved: always,
    adsetGoal: goal("OFFSITE_CONVERSIONS"),
    /* The column is NOT NULL; a blank value is what reads as missing. */
    currency: (date) => (date === "2026-09-06" ? "" : "USD"),
  },
  /* No campaign receipt on 2026-09-06, and that day's row says TRY. */
  CURRENCY_ANOMALY: {
    adId: "ad-d107-currency-anomaly",
    campaignId: "campaign-d107-currency-anomaly",
    adsetId: "adset-d107-currency-anomaly",
    campaignObserved: (date) => date !== "2026-09-06",
    adsetGoal: goal("OFFSITE_CONVERSIONS"),
    currency: (date) => (date === "2026-09-06" ? "TRY" : "USD"),
  },
};

/** Every delivering day: $100 spend, 3 purchases, $400 revenue (ROAS 4). */
const DAY = { spend: 100, conversions: 3, revenue: 400 } as const;

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

/**
 * One complete, single-page, account-wide receipt per endpoint per day. An
 * entity absent from a day's page simply has no value that day; nothing is
 * inferred for it.
 */
async function seedDailyConfigReceipts(
  client: import("pg").Client,
  accountRefId: string,
) {
  const scenarios = Object.values(SCENARIOS);
  for (const date of DATES) {
    const campaignPayload = scenarios
      .filter((scenario) => scenario.campaignObserved(date))
      .map((scenario) => ({
        id: scenario.campaignId,
        objective: "OUTCOME_SALES",
        updated_time: OLD_CLOCK,
      }));
    const adsetPayload = scenarios.flatMap((scenario) => {
      const value = scenario.adsetGoal(date);
      if (value === null) return [];
      return [
        {
          id: scenario.adsetId,
          optimization_goal: value,
          promoted_object: { custom_event_type: "PURCHASE" },
          updated_time: value === "VALUE" ? CHANGE_CLOCK : OLD_CLOCK,
        },
      ];
    });
    for (const config of [
      {
        endpoint: "campaign_configs",
        scope: "campaign",
        fields: "id,objective,updated_time",
        payload: campaignPayload,
      },
      {
        endpoint: "adset_configs",
        scope: "adset",
        fields: "id,optimization_goal,promoted_object,updated_time",
        payload: adsetPayload,
      },
    ]) {
      const context = JSON.stringify({
        source: "admitted_window_d107_seam",
        fields: config.fields,
        pagination: { complete: true, termination: "natural_end", pageCount: 1 },
      });
      const observedAt = `${date}T12:00:00.000Z`;
      const [snapshot] = (
        await client.query<{ id: string }>(
          `INSERT INTO meta_raw_snapshots (
             business_id, business_ref_id, provider_account_id, provider_account_ref_id,
             endpoint_name, entity_scope, status, provider_http_status,
             start_date, end_date, payload_hash, request_context, payload_json,
             fetched_at
           ) VALUES (
             $1::text, ($1::text)::uuid, $2, $3::uuid, $4, $5, 'fetched', 200,
             $6::date, $6::date, $7, $8::jsonb, $9::jsonb, $10::timestamptz
           ) RETURNING id`,
          [
            BUSINESS_ID, ACCOUNT_ID, accountRefId, config.endpoint, config.scope,
            date, `d107-${config.scope}-${date}`, context,
            JSON.stringify(config.payload), observedAt,
          ],
        )
      ).rows;
      if (!snapshot?.id) throw new Error("Could not seed config receipt snapshot.");
      await client.query(
        `INSERT INTO meta_raw_snapshot_observations (
           snapshot_id, business_id, provider_account_id, endpoint_name,
           entity_scope, status, provider_http_status, request_context,
           observed_at
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, 'fetched', 200, $6::jsonb, $7::timestamptz
         )`,
        [snapshot.id, BUSINESS_ID, ACCOUNT_ID, config.endpoint, config.scope,
          context, observedAt],
      );
    }
  }
}

async function seed() {
  await withClient(async (client) => {
    const userId = (
      await client.query(
        `INSERT INTO users (name, email, password_hash)
         VALUES ('Admitted window D107 seam', $1, 'unused') RETURNING id`,
        [OWNER_EMAIL],
      )
    ).rows[0].id as string;
    await client.query(
      `INSERT INTO businesses (id, name, owner_id, currency, platform)
       VALUES ($1::uuid, 'Admitted window D107 seam', $2, 'USD', 'shopify')`,
      [BUSINESS_ID, userId],
    );
    const accountRefId = (
      await client.query(
        `INSERT INTO provider_accounts
           (provider, external_account_id, account_name, currency, timezone)
         VALUES ('meta', $1, 'Admitted window D107 seam', 'USD', $2)
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
    await seedDailyConfigReceipts(client, accountRefId);
    for (const scenario of Object.values(SCENARIOS)) {
      for (const date of DATES) {
        /* A warehouse objective on every day, including the unreadable ones: it
           is a contradiction check under D098, never a substitute source. */
        await client.query(
          `INSERT INTO meta_campaign_daily
             (business_id, provider_account_id, date, campaign_id,
              campaign_name_current, campaign_status, objective,
              optimization_goal, custom_event_type, account_timezone,
              account_currency, truth_state, finalized_at, validation_status,
              created_at, updated_at)
           VALUES ($1::text, $2, $3::date, $4, $4, 'ACTIVE', 'OUTCOME_SALES',
                   'OFFSITE_CONVERSIONS', 'PURCHASE', $5, 'USD', 'finalized',
                   $6::timestamptz, 'passed', $6::timestamptz, $6::timestamptz)
           ON CONFLICT DO NOTHING`,
          [BUSINESS_ID, ACCOUNT_ID, date, scenario.campaignId, ACCOUNT_TZ, ROW_CLOCK],
        );
        const empty = scenario.empty?.(date) ?? false;
        await client.query(
          `INSERT INTO meta_ad_daily
             (business_id, provider_account_id, date, campaign_id, adset_id,
              ad_id, ad_name_current, ad_status, account_timezone,
              account_currency, spend, impressions, clicks, reach, frequency,
              conversions, revenue, link_clicks, payload_json, truth_state,
              finalized_at, validation_status, created_at, updated_at,
              business_ref_id)
           VALUES ($1::text, $2, $3::date, $4, $5, $6, $6, 'ACTIVE', $7, $17,
                   $8, $9, $10, $11, 5, $12, $13, $14::bigint, $15::jsonb,
                   'finalized', $16::timestamptz, 'passed',
                   $16::timestamptz, $16::timestamptz, $1::uuid)`,
          [
            BUSINESS_ID,
            ACCOUNT_ID,
            date,
            scenario.campaignId,
            scenario.adsetId,
            scenario.adId,
            ACCOUNT_TZ,
            empty ? 0 : DAY.spend,
            empty ? 0 : 20_000,
            empty ? 0 : 200,
            empty ? 0 : 4_000,
            empty ? 0 : DAY.conversions,
            empty ? 0 : DAY.revenue,
            empty ? 0 : 150,
            JSON.stringify({
              actions: [
                { action_type: "link_click", value: empty ? "0" : "150" },
              ],
            }),
            ROW_CLOCK,
            scenario.currency ? scenario.currency(date) : "USD",
          ],
        );
      }
    }
  });
}

describe.runIf(SEAM)(
  "ADR D107 admitted window against real PostgreSQL",
  () => {
    let inputs: AdDecisionInput[] = [];
    const inputFor = (scenario: Scenario): AdDecisionInput => {
      const input = inputs.find((row) => row.adId === scenario.adId);
      if (!input) throw new Error(`No hydrated input for ${scenario.adId}.`);
      return input;
    };

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
        for (const statement of [
          `DELETE FROM meta_raw_snapshot_observations WHERE business_id = $1::text`,
          `DELETE FROM meta_raw_snapshots WHERE business_id = $1::text`,
          `DELETE FROM meta_ad_daily WHERE business_id = $1::text`,
          `DELETE FROM meta_campaign_daily WHERE business_id = $1::text`,
          `DELETE FROM business_provider_accounts WHERE business_id = $1::text`,
        ]) {
          await client.query(statement, [BUSINESS_ID]);
        }
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

    it("bridges one unreadable interior day and keeps the whole observed run", () => {
      const input = inputFor(SCENARIOS.BRIDGE);
      expect(input.decisionWindow).toMatchObject({
        startDate: "2026-09-01",
        endDate: "2026-09-10",
        calendarDaySpan: 10,
        observedDayCount: 10,
        economicDayCount: 10,
        bridgedUnresolvedDayCount: 1,
        lookbackStartDate: "2026-08-14",
        lookbackEndDate: "2026-09-10",
        recentStartDate: "2026-09-04",
        recentEndDate: "2026-09-10",
      });
      // All ten days' economics, not the four after the gap.
      expect(input.spend).toBe(1_000);
      expect(input.purchases).toBe(30);
      // The unreadable day is not a second, or an unknown, identity.
      expect(input.contextGrain?.contextIdentityUnknown).toBe(false);
      expect(input.objective).toBe("OUTCOME_SALES");
      expect(input.effectiveCohort).toBe("purchase");
      // ...and it carries no authority: the run is diagnosable, not actionable.
      expect(input.configAuthority.decisionEconomics.economicDayCount).toBe(10);
      // The bridged day, plus the as-of day still awaiting corroboration.
      expect(input.configAuthority.counts).toMatchObject({
        decisionAuthorityDays: 8,
        reviewOnlyPendingDays: 1,
        noneDays: 1,
        noneSpend: 100,
      });
      expect(
        input.configAuthority.decisionEconomics.unverifiedEconomicDayCount,
      ).toBe(2);
      expect(input.configAuthority.decisionEconomics.fullyVerified).toBe(false);
    });

    it("gives a bridged day no authority even when its own receipts are complete", () => {
      // 2026-09-06 has full campaign and ad-set receipts; only the ad-day's
      // currency is blank, so its context does not resolve. Its per-field
      // readiness reads decision_authority — bridgedDayReadinessSql must still
      // classify it `none`, or the unread day would count as verified.
      const input = inputFor(SCENARIOS.RECEIPTED_GAP);
      expect(input.decisionWindow).toMatchObject({
        startDate: "2026-09-01",
        endDate: "2026-09-10",
        bridgedUnresolvedDayCount: 1,
      });
      expect(input.configAuthority.counts).toMatchObject({
        decisionAuthorityDays: 8,
        reviewOnlyPendingDays: 1,
        noneDays: 1,
        noneSpend: 100,
      });
      expect(input.configAuthority.decisionEconomics.fullyVerified).toBe(false);
      /*
        THE HOLD THIS PINS (ADR D107): verified days on both sides do not make
        the run fully verified while the bridged day is inside it. It stays
        held until that day leaves the 28-day lookback.
      */
      // A BLANK currency is not an observation of another currency: the ad's
      // identity stays known.
      expect(input.contextGrain?.contextIdentityUnknown).toBe(false);
      expect(input.objective).toBe("OUTCOME_SALES");
    });

    it("fails the ad closed when an unreadable day observed a different currency", () => {
      // 09-01..05 USD resolved, 09-06 no objective but TRY, 09-07..10 USD. The
      // TRY day is never bridged into the run, and the shorter run it leaves
      // behind must not launder the anomaly: the identity check reads every
      // economic day's observed currency, before any window is chosen.
      const input = inputFor(SCENARIOS.CURRENCY_ANOMALY);
      expect(input.decisionWindow).toMatchObject({
        startDate: "2026-09-07",
        endDate: "2026-09-10",
        bridgedUnresolvedDayCount: 0,
      });
      expect(input.contextGrain?.contextIdentityUnknown).toBe(true);
      expect(input.objective).toBeNull();
      expect(input.effectiveCohort).not.toBe("purchase");
    });

    it("starts a valid short window at a provider-observed configuration change", () => {
      const input = inputFor(SCENARIOS.CHANGE);
      expect(input.decisionWindow).toMatchObject({
        startDate: "2026-09-06",
        endDate: "2026-09-10",
        calendarDaySpan: 5,
        economicDayCount: 5,
        bridgedUnresolvedDayCount: 0,
      });
      expect(input.spend).toBe(500);
      expect(input.purchases).toBe(15);
      expect(input.optimizationGoal).toBe("VALUE");
      expect(input.contextGrain?.contextIdentityUnknown).toBe(false);
    });

    it("ends the run at an unresolved day that observed a contradicting value", () => {
      const input = inputFor(SCENARIOS.CONTRADICT);
      expect(input.decisionWindow).toMatchObject({
        startDate: "2026-09-07",
        endDate: "2026-09-10",
        calendarDaySpan: 4,
        bridgedUnresolvedDayCount: 0,
      });
      expect(input.spend).toBe(400);
      expect(input.optimizationGoal).toBe("OFFSITE_CONVERSIONS");
    });

    it("does not bridge unreadable days at the older edge", () => {
      const input = inputFor(SCENARIOS.LEADING);
      expect(input.decisionWindow).toMatchObject({
        startDate: "2026-09-05",
        endDate: "2026-09-10",
        calendarDaySpan: 6,
        bridgedUnresolvedDayCount: 0,
      });
      expect(input.spend).toBe(600);
    });

    it("ends the run at the newest resolved day instead of carrying it forward", () => {
      const input = inputFor(SCENARIOS.TRAILING);
      expect(input.decisionWindow).toMatchObject({
        startDate: "2026-09-01",
        endDate: "2026-09-08",
        calendarDaySpan: 8,
        bridgedUnresolvedDayCount: 0,
        recentStartDate: "2026-09-04",
        recentEndDate: "2026-09-08",
      });
      expect(input.spend).toBe(800);
    });

    it("keeps an unreadable empty day transparent to the ad's identity", () => {
      const input = inputFor(SCENARIOS.EMPTY_GAP);
      expect(input.decisionWindow).toMatchObject({
        startDate: "2026-09-01",
        endDate: "2026-09-10",
        calendarDaySpan: 10,
        economicDayCount: 9,
        bridgedUnresolvedDayCount: 0,
      });
      expect(input.spend).toBe(900);
      expect(input.contextGrain?.contextIdentityUnknown).toBe(false);
      expect(input.objective).toBe("OUTCOME_SALES");
    });
  },
);
