/**
 * The per-entity facts the budget and bid sizing policies need, read once.
 *
 * Both policies are pure functions, deliberately: they decide a direction and
 * a rung and touch no database. Something still has to gather what they decide
 * from, and this is that something — one read per account per run, from the
 * retained config history and the warehouse rows the snapshot already has.
 *
 * Two rules it follows without exception.
 *
 * A fact that could not be read is `null`, never a default. "No change in the
 * last 24 hours" and "we could not see the change history" are different
 * answers, and the sizing policies refuse on the second — a cooldown that
 * silently reads as satisfied is how a budget gets moved twice in an hour.
 *
 * The budget owner comes only from the retained `budget_owner_mode`. A
 * non-null `daily_budget` proves nothing about ownership: campaign and ad-set
 * config rows routinely carry a positive daily budget at the same time, so
 * inferring the owner from a number would guess wrong on real accounts.
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

type ConfigRow = {
  entity_id: string;
  grain: "campaign" | "adset";
  parent_campaign_id: string | null;
  budget_owner_mode: string | null;
  budget_raw_minor_units: string | number | null;
  budget_field: string | null;
  bid_strategy_type: string | null;
  hours_since_change: string | number | null;
  changes_7d: string | number | null;
};

type MetricRow = {
  entity_id: string;
  grain: "campaign" | "adset";
  roas28d: number | null;
  spend28d: number | null;
  purchases28d: number | null;
};

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
}): Promise<IntentProjectionContexts | null> {
  const sql = getDb();
  const windowStart = new Date(`${input.snapshotDate}T00:00:00.000Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - 27);
  const start28 = windowStart.toISOString().slice(0, 10);

  /*
    The latest config row per entity, plus its own change history.

    `DISTINCT ON` takes the most recent row per entity; the two aggregates are
    computed over the same table in one pass so the cooldown and the 7-day
    count cannot describe a different moment than the amount they guard.
  */
  const config = (await sql.query(
    `
    WITH campaign_config AS (
      SELECT DISTINCT ON (campaign_id)
             campaign_id AS entity_id,
             'campaign'::text AS grain,
             NULL::text AS parent_campaign_id,
             budget_owner_mode,
             budget_raw_minor_units,
             budget_field,
             NULL::text AS bid_strategy_type,
             changed_at
        FROM meta_campaign_config_history
       WHERE business_id = $1 AND provider_account_id = $2
       ORDER BY campaign_id, changed_at DESC
    ), adset_config AS (
      SELECT DISTINCT ON (adset_id)
             adset_id AS entity_id,
             'adset'::text AS grain,
             campaign_id AS parent_campaign_id,
             budget_owner_mode,
             budget_raw_minor_units,
             budget_field,
             bid_strategy_type,
             changed_at
        FROM meta_adset_config_history
       WHERE business_id = $1 AND provider_account_id = $2
       ORDER BY adset_id, changed_at DESC
    ), latest AS (
      SELECT * FROM campaign_config UNION ALL SELECT * FROM adset_config
    ), campaign_changes AS (
      SELECT campaign_id AS entity_id, 'campaign'::text AS grain,
             count(*) FILTER (WHERE changed_at >= now() - INTERVAL '7 days') AS changes_7d
        FROM meta_campaign_config_history
       WHERE business_id = $1 AND provider_account_id = $2
       GROUP BY campaign_id
    ), adset_changes AS (
      SELECT adset_id AS entity_id, 'adset'::text AS grain,
             count(*) FILTER (WHERE changed_at >= now() - INTERVAL '7 days') AS changes_7d
        FROM meta_adset_config_history
       WHERE business_id = $1 AND provider_account_id = $2
       GROUP BY adset_id
    ), changes AS (
      SELECT * FROM campaign_changes UNION ALL SELECT * FROM adset_changes
    )
    SELECT latest.entity_id,
           latest.grain,
           latest.parent_campaign_id,
           latest.budget_owner_mode,
           latest.budget_raw_minor_units,
           latest.budget_field,
           latest.bid_strategy_type,
           EXTRACT(EPOCH FROM (now() - latest.changed_at)) / 3600 AS hours_since_change,
           COALESCE(changes.changes_7d, 0) AS changes_7d
      FROM latest
      LEFT JOIN changes
        ON changes.entity_id = latest.entity_id AND changes.grain = latest.grain
    `,
    [input.businessId, input.providerAccountId],
  ).catch(() => null)) as ConfigRow[] | null;
  // An unreadable config history means no context at all: the caller then
  // proposes nothing, rather than proposing on assumed values.
  if (config === null) return null;

  const metrics = (await sql.query(
    `
    SELECT campaign_id AS entity_id, 'campaign'::text AS grain,
           CASE WHEN sum(spend) > 0 THEN sum(revenue) / sum(spend) END AS roas28d,
           sum(spend) AS spend28d, sum(purchases) AS purchases28d
      FROM meta_campaign_daily
     WHERE business_id = $1 AND provider_account_id = $2
       AND date BETWEEN $3::date AND $4::date
     GROUP BY campaign_id
    UNION ALL
    SELECT adset_id AS entity_id, 'adset'::text AS grain,
           CASE WHEN sum(spend) > 0 THEN sum(revenue) / sum(spend) END AS roas28d,
           sum(spend) AS spend28d, sum(purchases) AS purchases28d
      FROM meta_adset_daily
     WHERE business_id = $1 AND provider_account_id = $2
       AND date BETWEEN $3::date AND $4::date
     GROUP BY adset_id
    `,
    [input.businessId, input.providerAccountId, start28, input.snapshotDate],
  ).catch(() => null)) as MetricRow[] | null;
  if (metrics === null) return null;

  const bidAmounts = (await sql.query(
    `
    SELECT DISTINCT ON (adset_id) adset_id AS entity_id, bid_amount
      FROM meta_adset_daily
     WHERE business_id = $1 AND provider_account_id = $2
       AND date BETWEEN $3::date AND $4::date
     ORDER BY adset_id, date DESC
    `,
    [input.businessId, input.providerAccountId, start28, input.snapshotDate],
  ).catch(() => null)) as Array<{ entity_id: string; bid_amount: unknown }> | null;

  const metricByKey = new Map(
    metrics.map((row) => [`${row.grain}:${row.entity_id}`, row]),
  );
  const bidByAdset = new Map(
    (bidAmounts ?? []).map((row) => [row.entity_id, num(row.bid_amount)]),
  );

  /*
    The concentration denominator: unique budget OWNERS only.

    A CBO campaign is counted once and its ad sets are not counted at all —
    they do not own money. Summing every row carrying a positive daily budget
    would double-count the same spend and make every share look smaller than
    it is, which is the wrong direction for a safety check.
  */
  let accountDailyBudgetMinor: number | null = null;
  for (const row of config) {
    const universe = classifyBudgetUniverse({
      entityGrain: row.grain,
      budgetOwnerMode: row.budget_owner_mode,
    });
    if (universe !== "applicable") continue;
    const amount = num(row.budget_raw_minor_units);
    if (amount === null || amount <= 0) continue;
    accountDailyBudgetMinor = (accountDailyBudgetMinor ?? 0) + amount;
  }

  const budgetByEntityId = new Map<string, BudgetIntentEntityContext>();
  const bidByAdsetId = new Map<string, BidIntentEntityContext>();

  for (const row of config) {
    const metric = metricByKey.get(`${row.grain}:${row.entity_id}`);
    const currentMinorUnits = num(row.budget_raw_minor_units);
    const roleCampaignId = row.grain === "campaign"
      ? row.entity_id
      : row.parent_campaign_id;

    budgetByEntityId.set(row.entity_id, {
      currentMinorUnits,
      budgetUniverse: classifyBudgetUniverse({
        entityGrain: row.grain,
        budgetOwnerMode: row.budget_owner_mode,
      }),
      // A row whose retained field is not the daily budget is not mixed; it is
      // simply about a different field, and the universe classifier decides.
      isBudgetMixed: row.budget_owner_mode === "mixed",
      funnelCohort: input.cohortByEntityId.get(row.entity_id) ?? "unknown",
      roleAuthoritySatisfied: roleCampaignId
        ? input.roleAuthorityByCampaignId.get(roleCampaignId) === true
        : false,
      maturityOk: input.maturityByEntityId.get(row.entity_id) === true,
      roas28d: num(metric?.roas28d),
      spend28d: num(metric?.spend28d),
      purchases28d: num(metric?.purchases28d),
      calibrationSampleSize: input.calibrationSampleByEntityId.get(row.entity_id) ?? null,
      hoursSinceLastChange: num(row.hours_since_change),
      changesLast7d: num(row.changes_7d),
      accountShareBefore:
        currentMinorUnits !== null && accountDailyBudgetMinor
          ? currentMinorUnits / accountDailyBudgetMinor
          : null,
      // The fresh provider baseline is taken by the write preflight, not here.
      // What this asserts is only that a retained amount exists to compare to.
      providerBaselineKnown: currentMinorUnits !== null,
    });

    if (row.grain !== "adset") continue;
    bidByAdsetId.set(row.entity_id, {
      bidStrategyType: row.bid_strategy_type,
      currentBidMinor: bidByAdset.get(row.entity_id) ?? null,
      spend28d: num(metric?.spend28d),
      purchases28d: num(metric?.purchases28d),
      maturityOk: input.maturityByEntityId.get(row.entity_id) === true,
      deliveryConstrained: input.deliveryConstrainedAdsetIds.has(row.entity_id),
      hoursSinceLastChange: num(row.hours_since_change),
      changesLast7d: num(row.changes_7d),
      parentCampaignId: row.parent_campaign_id,
    });
  }

  return { budgetByEntityId, bidByAdsetId, accountDailyBudgetMinor };
}
