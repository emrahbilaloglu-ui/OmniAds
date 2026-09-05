/**
 * The per-entity facts the budget and bid sizing policies need, read once.
 *
 * Both policies are pure functions, deliberately: they decide a direction and
 * a rung and touch no database. Something still has to gather what they decide
 * from, and this is that something — one read per account per run.
 *
 * ## Where each fact actually comes from
 *
 * This module's first version asked the config-history tables for
 * `budget_owner_mode`, `budget_raw_minor_units`, `budget_field` and
 * `changed_at`. Those columns belong to the D086 additive pack, which is
 * PREPARED AND UNAPPLIED — `lib/migrations.ts` never runs it, and its own
 * audit asserts that it does not. So every statement raised SQLSTATE 42703,
 * the error was swallowed into `null`, and the projection returned every
 * recommendation unchanged. Policies that were correct produced nothing,
 * silently, for a reason no surface could show.
 *
 * The canonical sources, all of which exist and are populated:
 *
 * - **Budget owner and amount** — `meta_entity_state_history`. `budget_origin`
 *   is the owner ('campaign' = CBO, 'adset' = ABO) and the `*_budget_raw`
 *   columns hold the provider's own MINOR-unit strings, with the currency and
 *   its captured exponent beside them. This is the same table and the same
 *   shape `readMeasuredBudgetHistory` already reads in production; deriving
 *   ownership from a non-null amount is forbidden and would guess wrong,
 *   because a CBO campaign and its ad sets both carry positive daily budgets.
 * - **28-day metrics** — `meta_campaign_daily` / `meta_adset_daily`. The
 *   purchase count is `conversions`; there is no `purchases` column, and the
 *   serving layer maps one to the other (`purchases += row.conversions`).
 * - **Bid** — the same daily tables: `bid_strategy_type`, `bid_value` and
 *   `bid_value_format`. There is no `bid_amount`. `bid_value` is a MAJOR-unit
 *   currency amount and only counts as a cap when the format says `currency`;
 *   a `roas` value is a Target ROAS ratio and writing it as an amount is
 *   exactly the confusion the bid policy exists to avoid.
 * - **Change history** — `meta_budget_write_journal`, not config history. The
 *   cooldown and 7-day frequency guardrails are about changes WE made; config
 *   history records every observed configuration difference, which is a
 *   different and much noisier fact.
 *
 * A fact that could not be read is `null`, and the policies refuse on null:
 * "no change in the last 24 hours" and "we could not see the change history"
 * are different answers, and only one of them may authorize moving money.
 */
import { getDb } from "@/lib/db";
import type { BudgetIntentEntityContext } from "@/lib/meta/budget-intent-projection";
import type { BidIntentEntityContext } from "@/lib/meta/bid-intent-projection";
import { classifyBudgetUniverse } from "@/lib/meta/budget-readiness-retention";

export interface IntentProjectionContexts {
  budgetByEntityId: Map<string, BudgetIntentEntityContext>;
  bidByAdsetId: Map<string, BidIntentEntityContext>;
  /** Total daily budget across unique owners, for the concentration check. */
  accountDailyBudgetMinor: number | null;
}

type StateRow = {
  entity_type: "campaign" | "adset";
  entity_id: string;
  campaign_id: string | null;
  budget_origin: string | null;
  owned_minor: string | number | null;
  owned_field_count: number;
  budget_currency: string | null;
  budget_currency_exponent: number | null;
};

type MetricRow = {
  entity_id: string;
  grain: "campaign" | "adset";
  roas28d: number | null;
  spend28d: number | null;
  purchases28d: number | null;
};

type BidRow = {
  entity_id: string;
  campaign_id: string | null;
  bid_strategy_type: string | null;
  bid_value: number | null;
  bid_value_format: string | null;
};

type ChangeRow = {
  entity_id: string;
  hours_since_change: string | number | null;
  changes_7d: string | number | null;
};

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `budget_origin` in the vocabulary `classifyBudgetUniverse` speaks.
 *
 * The retained values are 'campaign' | 'adset' | 'not_observed' |
 * 'not_applicable' — there is no 'mixed'. Anything but the first two is
 * unknown ownership, which the classifier turns into `owner_unknown` and the
 * policy withholds on.
 */
function ownerModeFrom(origin: string | null): string {
  if (origin === "campaign") return "campaign_budget_optimization";
  if (origin === "adset") return "adset_budget";
  return "unknown";
}

export async function readIntentProjectionContexts(input: {
  businessId: string;
  providerAccountId: string;
  snapshotDate: string;
  /** Funnel cohort per entity, resolved by the caller from its own reader. */
  cohortByEntityId: Map<string, string>;
  roleAuthorityByCampaignId: Map<string, boolean>;
  maturityByEntityId: Map<string, boolean>;
  calibrationSampleByEntityId: Map<string, number | null>;
  deliveryConstrainedAdsetIds: Set<string>;
  /** Bound so a replay cannot read state captured after the day it is about. */
  asOfCutoff?: string;
}): Promise<IntentProjectionContexts | null> {
  const sql = getDb();
  const windowStart = new Date(`${input.snapshotDate}T00:00:00.000Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - 27);
  const start28 = windowStart.toISOString().slice(0, 10);
  const cutoff = input.asOfCutoff
    ?? `${input.snapshotDate}T23:59:59.999Z`;

  /*
    The canonical budget truth: the latest PRESENT observation per entity.

    `owned_field_count` is carried so a row claiming two owned amounts can be
    refused rather than silently picking one — the same discipline the
    production concentration read applies.
  */
  const stateRows = (await sql.query(
    `WITH latest AS (
       SELECT DISTINCT ON (entity_type, entity_id)
              entity_type, entity_id, campaign_id, presence, budget_origin,
              budget_currency, budget_currency_exponent,
              campaign_daily_budget_raw, campaign_lifetime_budget_raw,
              adset_daily_budget_raw, adset_lifetime_budget_raw
         FROM meta_entity_state_history
        WHERE business_id = $1 AND provider_account_id = $2
          AND entity_type IN ('campaign', 'adset')
          AND captured_at <= $3::timestamptz
        ORDER BY entity_type, entity_id, observed_at DESC, captured_at DESC,
                 created_at DESC, id DESC
     )
     SELECT entity_type, entity_id, campaign_id, budget_origin,
            budget_currency, budget_currency_exponent,
            /*
              What THIS entity owns, at its own grain.

              A CBO campaign's amount appears on its ad sets' observations too —
              the schema requires it, because that is how "this ad set's money
              comes from its campaign" is recorded. So ownership is the origin
              MATCHING the entity's own type: a campaign owns a campaign-origin
              amount, an ad set owns an ad-set-origin one, and an ad set under
              a CBO campaign owns nothing at all. Reading the amount without
              that test counts the same money once per ad set and makes every
              concentration share look far safer than it is.
            */
            CASE
              WHEN entity_type = 'campaign' AND budget_origin = 'campaign' THEN
                ((campaign_daily_budget_raw IS NOT NULL AND campaign_daily_budget_raw <> '')::int
                 + (campaign_lifetime_budget_raw IS NOT NULL AND campaign_lifetime_budget_raw <> '')::int)
              WHEN entity_type = 'adset' AND budget_origin = 'adset' THEN
                ((adset_daily_budget_raw IS NOT NULL AND adset_daily_budget_raw <> '')::int
                 + (adset_lifetime_budget_raw IS NOT NULL AND adset_lifetime_budget_raw <> '')::int)
              ELSE 0
            END AS owned_field_count,
            CASE
              WHEN entity_type = 'campaign' AND budget_origin = 'campaign'
                THEN NULLIF(campaign_daily_budget_raw, '')::numeric
              WHEN entity_type = 'adset' AND budget_origin = 'adset'
                THEN NULLIF(adset_daily_budget_raw, '')::numeric
            END AS owned_minor
       FROM latest
      WHERE presence = 'present'`,
    [input.businessId, input.providerAccountId, cutoff],
  ).catch(() => null)) as StateRow[] | null;
  // An unreadable budget state means no context at all: the caller then
  // proposes nothing, rather than proposing on assumed values.
  if (stateRows === null) return null;

  const metrics = (await sql.query(
    `SELECT campaign_id AS entity_id, 'campaign'::text AS grain,
            CASE WHEN sum(spend) > 0 THEN sum(revenue) / sum(spend) END AS roas28d,
            sum(spend) AS spend28d,
            -- conversions IS the purchase count in this warehouse; there is
            -- no purchases column, and asking for one raised SQLSTATE 42703.
            sum(conversions) AS purchases28d
       FROM meta_campaign_daily
      WHERE business_id = $1 AND provider_account_id = $2
        AND date BETWEEN $3::date AND $4::date
      GROUP BY campaign_id
     UNION ALL
     SELECT adset_id AS entity_id, 'adset'::text AS grain,
            CASE WHEN sum(spend) > 0 THEN sum(revenue) / sum(spend) END AS roas28d,
            sum(spend) AS spend28d,
            sum(conversions) AS purchases28d
       FROM meta_adset_daily
      WHERE business_id = $1 AND provider_account_id = $2
        AND date BETWEEN $3::date AND $4::date
      GROUP BY adset_id`,
    [input.businessId, input.providerAccountId, start28, input.snapshotDate],
  ).catch(() => null)) as MetricRow[] | null;
  if (metrics === null) return null;

  /*
    The bid facts, from the retained daily row.

    `bid_value_format` decides whether the number is a cap at all: 'currency'
    is an amount, 'roas' is a Target ROAS ratio. Reading the second as the
    first would write a ratio into a currency field.
  */
  const bidRows = (await sql.query(
    `SELECT DISTINCT ON (adset_id)
            adset_id AS entity_id, campaign_id,
            bid_strategy_type, bid_value, bid_value_format
       FROM meta_adset_daily
      WHERE business_id = $1 AND provider_account_id = $2
        AND date BETWEEN $3::date AND $4::date
      ORDER BY adset_id, date DESC`,
    [input.businessId, input.providerAccountId, start28, input.snapshotDate],
  ).catch(() => null)) as BidRow[] | null;
  if (bidRows === null) return null;

  /*
    Changes WE made, from our own write journal.

    The cooldown and the 7-day frequency are guardrails on this product's
    writes. Config history would answer a different question — every observed
    configuration difference, including provider-side churn — and answering the
    wrong question with real-looking numbers is worse than answering none.
  */
  const changeRows = (await sql.query(
    `SELECT entity_id,
            EXTRACT(EPOCH FROM ($3::timestamptz - max(requested_at))) / 3600
              AS hours_since_change,
            count(*) FILTER (
              WHERE requested_at >= $3::timestamptz - INTERVAL '7 days'
            ) AS changes_7d
       FROM meta_budget_write_journal
      WHERE business_id = $1 AND provider_account_id = $2
        AND result_class = 'verified'
        AND requested_at <= $3::timestamptz
      GROUP BY entity_id`,
    // Three parameters, not four: this query has no window start. The metric
    // window is a different question from "when did we last change this".
    [input.businessId, input.providerAccountId, cutoff],
  ).catch(() => null)) as ChangeRow[] | null;
  if (changeRows === null) return null;

  const metricByKey = new Map(
    metrics.map((row) => [`${row.grain}:${row.entity_id}`, row]),
  );
  const bidByEntity = new Map(bidRows.map((row) => [row.entity_id, row]));
  const changeByEntity = new Map(changeRows.map((row) => [row.entity_id, row]));

  /*
    The concentration denominator: unique budget OWNERS only.

    A CBO campaign is counted once and its ad sets are not counted at all —
    they do not own money. Summing every row carrying a positive amount would
    double-count the same spend and make every share look safer than it is.
  */
  let accountDailyBudgetMinor: number | null = null;
  for (const row of stateRows) {
    // The origin has to name this entity's own grain; the SQL above already
    // zeroes anything else, and this is the same rule stated in one place.
    if (row.budget_origin !== row.entity_type) continue;
    if (Number(row.owned_field_count) !== 1) continue;
    const amount = num(row.owned_minor);
    if (amount === null || amount <= 0) continue;
    accountDailyBudgetMinor = (accountDailyBudgetMinor ?? 0) + amount;
  }

  const budgetByEntityId = new Map<string, BudgetIntentEntityContext>();
  const bidByAdsetId = new Map<string, BidIntentEntityContext>();

  for (const row of stateRows) {
    const grain = row.entity_type;
    const metric = metricByKey.get(`${grain}:${row.entity_id}`);
    /*
      The owner mode this entity is in, from its own grain and the origin.

      `classifyBudgetUniverse` then turns it into applicable / proven-non-
      applicable / owner-unknown. An ad set under a CBO campaign reports
      `campaign_budget_optimization` at ad-set grain, which is exactly the
      "proven non-applicable" the classifier exists to name — it is not that we
      failed to find its owner, it is that its owner is somewhere else.
    */
    const ownerMode = ownerModeFrom(row.budget_origin);
    // One owned amount at this grain, or none. Two is an unresolved
    // observation, not a budget this product may reason about.
    const currentMinorUnits = Number(row.owned_field_count) === 1
      ? num(row.owned_minor)
      : null;
    const roleCampaignId = grain === "campaign"
      ? row.entity_id
      : row.campaign_id;
    const change = changeByEntity.get(row.entity_id);

    budgetByEntityId.set(row.entity_id, {
      currentMinorUnits,
      budgetUniverse: classifyBudgetUniverse({
        entityGrain: grain,
        budgetOwnerMode: ownerMode,
      }),
      // `budget_origin` has no 'mixed' value; ambiguity shows up as more than
      // one owned amount, which is already refused above.
      isBudgetMixed: Number(row.owned_field_count) > 1,
      funnelCohort: input.cohortByEntityId.get(row.entity_id) ?? "unknown",
      roleAuthoritySatisfied: roleCampaignId
        ? input.roleAuthorityByCampaignId.get(roleCampaignId) === true
        : false,
      maturityOk: input.maturityByEntityId.get(row.entity_id) === true,
      roas28d: num(metric?.roas28d),
      spend28d: num(metric?.spend28d),
      purchases28d: num(metric?.purchases28d),
      calibrationSampleSize:
        input.calibrationSampleByEntityId.get(row.entity_id) ?? null,
      /*
        No journal row means no change this product has made — which is a real
        observation, not an unreadable one. The read itself failing returns
        null above; here an absent row is genuinely "never changed by us".
      */
      hoursSinceLastChange: change ? num(change.hours_since_change) : Number.POSITIVE_INFINITY,
      changesLast7d: change ? num(change.changes_7d) : 0,
      accountShareBefore:
        currentMinorUnits !== null && accountDailyBudgetMinor
          ? currentMinorUnits / accountDailyBudgetMinor
          : null,
      // The fresh provider baseline is taken by the write preflight, not here.
      // This asserts only that a retained amount exists to compare against.
      providerBaselineKnown: currentMinorUnits !== null,
    });

    if (grain !== "adset") continue;
    const bid = bidByEntity.get(row.entity_id);
    const exponent = num(row.budget_currency_exponent);
    /*
      A cap in MINOR units, or nothing.

      `bid_value` is a major-unit currency amount and the sizing contract works
      in minor units throughout. Without a captured exponent the scale is
      unknown, and a number whose scale is unknown is not a number.
    */
    const capMinor =
      bid?.bid_value_format === "currency"
      && num(bid.bid_value) !== null
      && exponent !== null
        ? Math.round(num(bid.bid_value)! * 10 ** exponent)
        : null;

    bidByAdsetId.set(row.entity_id, {
      bidStrategyType: bid?.bid_strategy_type ?? null,
      currentBidMinor: capMinor,
      spend28d: num(metric?.spend28d),
      purchases28d: num(metric?.purchases28d),
      maturityOk: input.maturityByEntityId.get(row.entity_id) === true,
      deliveryConstrained: input.deliveryConstrainedAdsetIds.has(row.entity_id),
      hoursSinceLastChange: change ? num(change.hours_since_change) : Number.POSITIVE_INFINITY,
      changesLast7d: change ? num(change.changes_7d) : 0,
      parentCampaignId: row.campaign_id,
    });
  }

  return { budgetByEntityId, bidByAdsetId, accountDailyBudgetMinor };
}
