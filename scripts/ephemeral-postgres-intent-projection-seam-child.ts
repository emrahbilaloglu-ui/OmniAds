// Child of ephemeral-postgres-migrations-check: runs the sizing projection's
// REAL production queries against a real migrated database.
//
// This seam exists because the module it guards shipped broken and green. Its
// unit test mocked the database and fed rows named after columns that do not
// exist — budget_owner_mode, budget_raw_minor_units, budget_field, changed_at,
// bid_amount, purchases — all of which belong to the prepared-and-unapplied
// D086 pack or to nothing at all. Every statement raised SQLSTATE 42703, the
// error was swallowed into null, and the projection silently returned every
// recommendation unchanged. A mocked row can agree with any schema; only
// PostgreSQL can refuse one.
//
// So this inserts the canonical facts through the real columns, calls the real
// reader, and asserts the numbers it derives.
import { getDb } from "@/lib/db";
import { readIntentProjectionContexts } from "@/lib/meta/intent-projection-context";

const LABEL = "intent-projection-seam";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

const BUSINESS_ID = "d0000000-0000-4000-8000-000000000101";
const BUSINESS_TEXT = BUSINESS_ID;
const ACCOUNT = "act_projection_seam";
const AS_OF = "2026-09-04";
const CBO = "cmp_cbo";
const CBO_ADSET = "set_under_cbo";
const ABO_CAMPAIGN = "cmp_abo";
const ABO_ADSET = "set_abo";

async function seed() {
  const sql = getDb();
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, timezone, currency)
     SELECT $1::uuid, 'Projection seam', u.id, 'Europe/Istanbul', 'USD'
       FROM users u LIMIT 1
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID],
  ).catch(async () => {
    // No user rows in a from-zero database: create the owner this business
    // needs rather than skipping the case that needs it.
    await sql.query(
      `INSERT INTO users (id, email, name)
       VALUES ('d0000000-0000-4000-8000-0000000000ff'::uuid,
               'projection-seam@example.test', 'Projection seam')
       ON CONFLICT (id) DO NOTHING`,
    );
    await sql.query(
      `INSERT INTO businesses (id, name, owner_id, timezone, currency)
       VALUES ($1::uuid, 'Projection seam',
               'd0000000-0000-4000-8000-0000000000ff'::uuid,
               'Europe/Istanbul', 'USD')
       ON CONFLICT (id) DO NOTHING`,
      [BUSINESS_ID],
    );
  });

  /*
    The ad account row, because the observation run carries a composite foreign
    key to (provider_account_ref_id, provider_account_id). The seam's account
    has to be a real account before any observation of it can exist.
  */
  const accountRows = (await sql.query(
    `INSERT INTO provider_accounts
       (provider, external_account_id, account_name, currency, timezone)
     VALUES ('meta', $1, 'Projection seam account', 'USD', 'Europe/Istanbul')
     ON CONFLICT (provider, external_account_id)
     DO UPDATE SET currency = EXCLUDED.currency
     RETURNING id::text AS id`,
    [ACCOUNT],
  )) as Array<{ id: string }>;
  const accountRefId = accountRows[0]!.id;

  // And the business/account binding, which the observation run's second
  // composite foreign key points at.
  await sql.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id)
     VALUES ($1, 'meta', $2::uuid, $3)
     ON CONFLICT (business_id, provider, provider_account_ref_id) DO NOTHING`,
    [BUSINESS_TEXT, accountRefId, ACCOUNT],
  );

  /*
    One observation run per entity type, because the state rows carry a
    COMPOSITE foreign key back to the run — id, business, account, entity type,
    captured_at and completeness all have to line up. Their contents are not
    what this seam measures; they exist so the budget facts can be inserted at
    all.
  */
  const captured = `${AS_OF}T03:00:00.000Z`;
  const runFor = async (entityType: "campaign" | "adset") => {
    const rows = (await sql.query(
      `INSERT INTO meta_entity_observation_runs
         (business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, endpoint,
          observed_at, captured_at, completeness, run_hash)
       VALUES ($1::uuid, $2, $7::uuid, $3, $4, '/act/' || $4,
               $5::timestamptz, $5::timestamptz, 'complete', $6)
       RETURNING id::text AS id`,
      [BUSINESS_ID, BUSINESS_TEXT, ACCOUNT, entityType, captured,
        entityType === "campaign" ? "c".repeat(64) : "d".repeat(64),
        accountRefId],
    )) as Array<{ id: string }>;
    return rows[0]!.id;
  };
  const runIds = {
    campaign: await runFor("campaign"),
    adset: await runFor("adset"),
  };

  let stateHashSeed = 0;
  const state = async (input: {
    entityType: "campaign" | "adset";
    entityId: string;
    campaignId: string;
    origin: string;
    campaignDaily: string | null;
    adsetDaily: string | null;
  }) => {
    stateHashSeed += 1;
    await sql.query(
      `INSERT INTO meta_entity_state_history
         (run_id, business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, entity_id, campaign_id, adset_id,
          configured_status, effective_status,
          campaign_daily_budget_raw, adset_daily_budget_raw,
          budget_currency, budget_currency_exponent, budget_origin,
          presence, observed_at, captured_at, run_completeness, state_hash)
       VALUES ($1::uuid, $2::uuid, $3, $14::uuid, $4, $5, $6, $7, $8,
               'ACTIVE', 'ACTIVE', $9, $10, 'USD', 2, $11, 'present',
               $12::timestamptz, $12::timestamptz, 'complete', $13)`,
      [runIds[input.entityType], BUSINESS_ID, BUSINESS_TEXT, ACCOUNT,
        input.entityType, input.entityId, input.campaignId,
        input.entityType === "adset" ? input.entityId : null,
        input.campaignDaily, input.adsetDaily, input.origin, captured,
        String(stateHashSeed).padStart(64, "0"), accountRefId],
    );
  };

  // A CBO campaign owning 250,000 minor units, and an ad set beneath it whose
  // own observation carries the SAME amount and owns none of it — the exact
  // shape that makes inferring ownership from a non-null amount wrong.
  await state({
    entityType: "campaign", entityId: CBO, campaignId: CBO,
    origin: "campaign", campaignDaily: "250000", adsetDaily: null,
  });
  await state({
    entityType: "adset", entityId: CBO_ADSET, campaignId: CBO,
    origin: "campaign", campaignDaily: "250000", adsetDaily: null,
  });
  // An ABO ad set owning its own 50,000.
  await state({
    entityType: "adset", entityId: ABO_ADSET, campaignId: ABO_CAMPAIGN,
    origin: "adset", campaignDaily: null, adsetDaily: "50000",
  });

  // Metrics, through the columns that exist: conversions IS the purchase
  // count, and there is no purchases column.
  await sql.query(
    `INSERT INTO meta_campaign_daily
       (business_id, provider_account_id, date, campaign_id, account_timezone,
        account_currency, spend, revenue, conversions, impressions, clicks)
     VALUES ($1, $2, $3::date, $4, 'Europe/Istanbul', 'USD',
             4000, 11400, 41, 100000, 2000)`,
    [BUSINESS_TEXT, ACCOUNT, AS_OF, CBO],
  );
  await sql.query(
    `INSERT INTO meta_adset_daily
       (business_id, provider_account_id, date, campaign_id, adset_id,
        account_timezone, account_currency, spend, revenue, conversions,
        impressions, clicks, bid_strategy_type, bid_value, bid_value_format)
     VALUES ($1, $2, $3::date, $4, $5, 'Europe/Istanbul', 'USD',
             4200, 5040, 500, 90000, 1800, 'cost_cap', 12.00, 'currency')`,
    [BUSINESS_TEXT, ACCOUNT, AS_OF, CBO, CBO_ADSET],
  );
  await sql.query(
    `INSERT INTO meta_adset_daily
       (business_id, provider_account_id, date, campaign_id, adset_id,
        account_timezone, account_currency, spend, revenue, conversions,
        impressions, clicks, bid_strategy_type, bid_value, bid_value_format)
     VALUES ($1, $2, $3::date, $4, $5, 'Europe/Istanbul', 'USD',
             900, 1080, 6, 20000, 400, 'lowest_cost', NULL, NULL)`,
    [BUSINESS_TEXT, ACCOUNT, AS_OF, ABO_CAMPAIGN, ABO_ADSET],
  );
}

async function main() {
  await seed();

  const contexts = await readIntentProjectionContexts({
    businessId: BUSINESS_TEXT,
    providerAccountId: ACCOUNT,
    snapshotDate: AS_OF,
    cohortByEntityId: new Map([[CBO, "purchase"], [CBO_ADSET, "purchase"]]),
    roleAuthorityByCampaignId: new Map([[CBO, true]]),
    maturityByEntityId: new Map([[CBO, true], [CBO_ADSET, true]]),
    calibrationSampleByEntityId: new Map([[CBO, 64]]),
    deliveryConstrainedAdsetIds: new Set([CBO_ADSET]),
  });

  // The whole point: the reader used to return null here, every time, because
  // its first statement named columns that do not exist.
  if (contexts === null) {
    fail("reader_returned_null", "every query must run against the real schema");
  }

  /*
    The concentration denominator counts unique OWNERS.

    250,000 (the CBO campaign) + 50,000 (the ABO ad set). The ad set beneath
    the CBO campaign carries the campaign's amount in its own observation and
    owns none of it; counting it would double the same spend.
  */
  expectEqual(contexts.accountDailyBudgetMinor, 300_000, "account_total_minor");

  const cbo = contexts.budgetByEntityId.get(CBO);
  if (!cbo) fail("cbo_context_missing");
  expectEqual(cbo.budgetUniverse, "applicable", "cbo_universe");
  expectEqual(cbo.currentMinorUnits, 250_000, "cbo_amount_minor");
  expectEqual(cbo.purchases28d, 41, "cbo_purchases_from_conversions");
  expectEqual(cbo.spend28d, 4000, "cbo_spend");
  if (cbo.roas28d === null || Math.abs(cbo.roas28d - 2.85) > 0.001) {
    fail("cbo_roas", `expected 2.85, got ${cbo.roas28d}`);
  }
  if (cbo.accountShareBefore === null
    || Math.abs(cbo.accountShareBefore - 250_000 / 300_000) > 1e-9) {
    fail("cbo_share", `got ${cbo.accountShareBefore}`);
  }

  const underCbo = contexts.budgetByEntityId.get(CBO_ADSET);
  if (!underCbo) fail("cbo_adset_context_missing");
  // An ad set under a CBO campaign is NOT an applicable budget owner, even
  // though its observation carries a positive amount.
  expectEqual(underCbo.budgetUniverse, "proven_non_applicable", "cbo_adset_universe");

  const abo = contexts.budgetByEntityId.get(ABO_ADSET);
  if (!abo) fail("abo_context_missing");
  expectEqual(abo.budgetUniverse, "applicable", "abo_universe");
  expectEqual(abo.currentMinorUnits, 50_000, "abo_amount_minor");

  /*
    The bid cap, in minor units, from bid_value + bid_value_format.

    $12.00 at exponent 2 is 1200. There is no `bid_amount` column; a
    `roas`-formatted value is a Target ROAS ratio and must never become an
    amount.
  */
  const bid = contexts.bidByAdsetId.get(CBO_ADSET);
  if (!bid) fail("bid_context_missing");
  expectEqual(bid.currentBidMinor, 1200, "bid_cap_minor");
  expectEqual(bid.bidStrategyType, "cost_cap", "bid_strategy");
  expectEqual(bid.deliveryConstrained, true, "delivery_constraint_travels");

  const lowestCost = contexts.bidByAdsetId.get(ABO_ADSET);
  if (!lowestCost) fail("lowest_cost_context_missing");
  // A lowest-cost ad set owns no writable cap; the policy refuses it BY NAME
  // rather than this reader dropping the row silently.
  expectEqual(lowestCost.currentBidMinor, null, "lowest_cost_has_no_cap");
  expectEqual(lowestCost.bidStrategyType, "lowest_cost", "lowest_cost_strategy");

  // No journal row means this product has never changed these budgets, which
  // is a real observation rather than an unreadable one.
  expectEqual(cbo.changesLast7d, 0, "no_changes_recorded");

  console.log(
    `[${LABEL}] PASS: canonical budget owner and amount from meta_entity_state_history, `
    + "purchases from conversions, bid cap from bid_value/bid_value_format, "
    + "unique-owner concentration, and change history from the write journal.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
