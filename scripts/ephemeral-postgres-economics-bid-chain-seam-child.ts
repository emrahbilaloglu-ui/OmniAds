// Child of ephemeral-postgres-migrations-check. It runs only against the
// throwaway database URL force-set by the parent and never calls a provider.
//
// WHY THIS SEAM EXISTS
//
// The economics chain and the bid chain were each proven only by seams that
// minted their own `target_value`. `scripts/ephemeral-postgres-bid-queue-seam-child.ts`
// hand-writes the typed bid payload and then asserts the candidate SQL selects
// it, which proves the query reads what the FIXTURE wrote and says nothing
// about what the snapshot writes. That is how the bid arm shipped dark: the
// projection persisted nine keys and the producer's query required six others,
// and no test compared the two because no test used both.
//
// So this seam takes the long way round on purpose. It seeds inputs only —
// warehouse facts, a Shopify store, commercial targets, guardrails, a campaign
// role — and then calls the REAL production functions end to end:
// `runMetaSnapshotForBusiness`, `listTypedBudgetCandidates`,
// `listTypedBidCandidates`, `projectMetaBidProposals` with `insertBidProposalRow`,
// `projectMetaBudgetProposals` with the production
// `loadBudgetCompositionSourcesForCandidate`, and `readMetaAutomationProposal`.
//
// It re-implements NO formula. Every asserted number is either read back out of
// the database or taken off a production return value. In particular the seam
// never divides 58.00 by 2.20: the derived $26.36 benchmark is bound by what it
// produces (a 10% cap raise at a 0.83 CPA ratio) and by a negative control that
// removes the store's evidence and shows every intent disappear.
import {
  createMetaAuthoritativeSliceVersion,
  publishMetaAuthoritativeSliceVersion,
  upsertMetaAdSetDailyRows,
  upsertMetaCampaignDailyRows,
} from "@/lib/meta/warehouse";
import { detectAnomaliesForBusiness } from "@/lib/meta/anomalies";
import { getDb, resetDbClientCache } from "@/lib/db";
import { readMetaAutomationProposal } from "@/lib/meta/automation-proposals";
import { BID_SIZING_POLICY_VERSION } from "@/lib/meta/bid-sizing-policy";
import { BUDGET_SIZING_POLICY_VERSION } from "@/lib/meta/budget-sizing-policy";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { META_BID_INTENT_CONTRACT_VERSION } from "@/lib/meta/bid-intent-contract";
import { META_BUDGET_INTENT_CONTRACT_VERSION } from "@/lib/meta/budget-intent-contract";
import {
  insertBidProposalRow,
  listTypedBidCandidates,
  projectMetaBidProposals,
} from "@/lib/meta/bid-proposal-producer";
import {
  insertBudgetProposalRow,
  listTypedBudgetCandidates,
  projectMetaBudgetProposals,
} from "@/lib/meta/budget-proposal-producer";
import { loadBudgetCompositionSourcesForCandidate } from "@/lib/meta/budget-proposal-source-loader";
import { runMetaSnapshotForBusiness } from "@/lib/meta/snapshot";
import type { MetaAdSetDailyRow, MetaCampaignDailyRow } from "@/lib/meta/warehouse-types";

const LABEL = "economics-bid-chain-seam";

const BUSINESS = "d0000000-0000-4000-8000-000000000501";
const OWNER = "d0000000-0000-4000-8000-0000000005ff";
const ACCOUNT = "act_5000000000001";
const SHOP = "economics-seam.myshopify.test";

/*
  Every ENTITY id is pure digits.

  `META_PROVIDER_ENTITY_ID_PATTERN` (/^\d+$/) gates `isExactMetaProviderEntityId`
  and every action-log write behind it, so a fixture using readable ids would
  prove the chain against entities the write path would refuse. The `act_`
  prefix on the ACCOUNT is correct and is what Meta itself uses.
*/
const CBO_CAMPAIGN = "5000000000101";
const CBO_ADSET = "5000000000201";
const ABO_CAMPAIGN = "5000000000102";
const ABO_ADSET = "5000000000202";

/** The evidence window both the warehouse and the store fixture cover. */
const WINDOW_DAYS = 28;

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/*
  Yesterday, in the account's own zone, computed per run.

  A literal date would eventually put the engine's all-history window outside
  META_AUTHORITATIVE_HISTORY_DAYS, which flips `historicalReadMode` to
  `historical_live_fallback` and sends the campaign source at the live
  provider. The account and the store are both on UTC so the warehouse day and
  the store day are the same day.
*/
const AS_OF = addDays(new Date().toISOString().slice(0, 10), -1);

interface RecordedRequest {
  method: string;
  url: string;
}

/**
 * A provider that refuses to exist.
 *
 * The seam's central claim is that a decision worth an operator's approval is
 * produced from retained facts alone. Any request at all is therefore a
 * finding, and a POST is a failure of the strongest kind: nothing on this path
 * may write to Meta.
 */
function installRefusingFetch(): { calls: RecordedRequest[]; restore: () => void } {
  const calls: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(
      typeof input === "object" && input !== null && "url" in input
        ? (input as { url: unknown }).url
        : input,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (method !== "GET") {
      fail("provider_write_attempted", `${method} ${url}`);
    }
    fail("provider_request_attempted", `${method} ${url}`);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function metricRow(input: {
  spend: number;
  revenue: number;
  conversions: number;
  impressions: number;
  clicks: number;
  reach: number;
}) {
  return {
    spend: input.spend,
    revenue: input.revenue,
    conversions: input.conversions,
    impressions: input.impressions,
    clicks: input.clicks,
    reach: input.reach,
    frequency: input.reach > 0 ? input.impressions / input.reach : null,
    roas: input.spend > 0 ? input.revenue / input.spend : 0,
    cpa: input.conversions > 0 ? input.spend / input.conversions : null,
    ctr: input.impressions > 0 ? (input.clicks / input.impressions) * 100 : null,
    cpc: input.clicks > 0 ? input.spend / input.clicks : null,
  };
}

async function seedIdentity() {
  const sql = getDb();
  await sql.query(
    `INSERT INTO users (id, email, name, password_hash)
     VALUES ($1::uuid, 'economics-bid-chain-seam@example.test', 'Economics seam', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [OWNER],
  );
  /*
    `is_demo_business` FALSE, explicitly.

    `readLaunchpadWriteAuthority` answers `unverified` for anything it cannot
    prove is a real workspace, and every Meta source then reports
    `not_connected` and returns no rows at all. The whole fixture would read as
    an empty account.
  */
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, timezone, currency, is_demo_business)
     VALUES ($1::uuid, 'Economics and bid chain seam', $2::uuid, 'UTC', 'USD', FALSE)
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS, OWNER],
  );
  await sql.query(
    `INSERT INTO memberships (user_id, business_id, role, status)
     VALUES ($1::uuid, $2::uuid, 'admin', 'active')
     ON CONFLICT DO NOTHING`,
    [OWNER, BUSINESS],
  );
  const accountRows = (await sql.query(
    `INSERT INTO provider_accounts
       (provider, external_account_id, account_name, currency, timezone)
     VALUES ('meta', $1, 'Economics seam account', 'USD', 'UTC')
     ON CONFLICT (provider, external_account_id)
     DO UPDATE SET currency = EXCLUDED.currency
     RETURNING id::text AS id`,
    [ACCOUNT],
  )) as Array<{ id: string }>;
  const accountRefId = accountRows[0]!.id;
  // `is_selected` is what `readAssignmentRowsByBusiness` filters on; an
  // unselected assignment reads as no assigned account at all.
  await sql.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id,
        position, is_selected)
     VALUES ($1, 'meta', $2::uuid, $3, 0, TRUE)
     ON CONFLICT (business_id, provider, provider_account_ref_id)
     DO UPDATE SET is_selected = TRUE`,
    [BUSINESS, accountRefId, ACCOUNT],
  );
  /*
    No `provider_connections` row for Meta, deliberately.

    With no connected integration `loadMetaAccountContext` cannot call
    `fetchMetaAccountProfile` and `buildMetaBudgetWriteContextForProposal`
    returns null before it reaches a request. The historical-authoritative read
    path needs no connection, so the fixture proves the chain with the provider
    genuinely unreachable rather than merely unasked.
  */
  return accountRefId;
}

async function seedCommercialTargets() {
  /*
    ROAS only. No target CPA, no break-even CPA, no AOV assumption.

    This is the whole economics case: with all three null the store's observed
    average order value is the ONLY source of a CPA benchmark, and it is also
    the only `accountCpaBaseline` `metaLossBudgetMaturity` can use. That makes
    the Shopify evidence load-bearing rather than decorative, which is what the
    negative control at the end of this seam demonstrates.
  */
  await getDb().query(
    `INSERT INTO business_target_pack_history
       (business_id, target_roas, break_even_roas, target_cpa, break_even_cpa,
        aov_assumption, default_risk_posture, operation, effective_at, recorded_at)
     VALUES ($1::uuid, 2.20, 1.80, NULL, NULL, NULL, 'balanced', 'upsert',
             $2::timestamptz, $2::timestamptz)`,
    [BUSINESS, `${AS_OF}T00:00:00.000Z`],
  );
}

async function seedShopifyStore(syncAt: string) {
  const sql = getDb();
  const connectionRows = (await sql.query(
    `INSERT INTO provider_connections
       (business_id, provider, status, provider_account_id, provider_account_name,
        connected_at)
     VALUES ($1, 'shopify', 'connected', $2, 'Economics seam store', now())
     RETURNING id::text AS id`,
    [BUSINESS, SHOP],
  )) as Array<{ id: string }>;
  /*
    A plaintext access token is correct here: `decryptIntegrationSecret` passes
    through anything not prefixed `enc:v1:`, and the store reader only needs the
    credential to exist. The zone is what makes a store DAY definable.
  */
  await sql.query(
    `INSERT INTO integration_credentials
       (provider_connection_id, access_token, metadata)
     VALUES ($1::uuid, 'economics-seam-token', $2::jsonb)`,
    [connectionRows[0]!.id, JSON.stringify({ iana_timezone: "UTC" })],
  );
  /*
    Freshness and coverage are two different facts and both are read.

    `latest_successful_sync_at` is our pipeline's clock; the span
    [latest_sync_window_start, ready_through_date] is how far back that reading
    reached. A window we never read cannot be averaged, however fresh the sync.
  */
  await sql.query(
    `INSERT INTO shopify_sync_state
       (business_id, provider_account_id, sync_target,
        latest_successful_sync_at, latest_sync_window_start, ready_through_date,
        latest_sync_status)
     VALUES ($1, $2, 'commerce_orders_recent', $3::timestamptz, $4::date, $5::date, 'succeeded')
     ON CONFLICT (business_id, provider_account_id, sync_target)
     DO UPDATE SET latest_successful_sync_at = EXCLUDED.latest_successful_sync_at`,
    [BUSINESS, SHOP, syncAt, addDays(AS_OF, -60), AS_OF],
  );

  // Thirty orders at $58.00 inside the closed window, which is the observed
  // order floor exactly. The AOV is the ledger's own revenue / purchases.
  for (let index = 0; index < 30; index += 1) {
    const day = addDays(AS_OF, -(1 + (index % 27)));
    await sql.query(
      `INSERT INTO shopify_orders
         (business_id, provider_account_id, shop_id, order_id, currency_code,
          shop_currency_code, order_created_at, order_created_date_local,
          total_price, current_total_price, original_total_price)
       VALUES ($1, $2, $2, $3, 'USD', 'USD', $4::timestamptz, $5::date, 58.00, 58.00, 58.00)
       ON CONFLICT DO NOTHING`,
      [BUSINESS, SHOP, `order-${index}`, `${day}T12:00:00.000Z`, day],
    );
    await sql.query(
      `INSERT INTO shopify_sales_events
         (business_id, provider_account_id, shop_id, event_id, source_kind,
          source_id, order_id, occurred_at, occurred_date_local,
          gross_sales, net_revenue, currency_code)
       VALUES ($1, $2, $2, $3, 'order', $4, $4, $5::timestamptz, $6::date,
               58.00, 58.00, 'USD')
       ON CONFLICT DO NOTHING`,
      [BUSINESS, SHOP, `event-${index}`, `order-${index}`, `${day}T12:00:00.000Z`, day],
    );
  }
}

async function seedAutomationControls() {
  const sql = getDb();
  /*
    The ceiling is stated in USD explicitly.

    An ABSENT ceiling takes the packaged EUR default, and every budget intent
    then dies on `policy_spend_ceiling_currency_mismatch` against a USD account
    — a refusal that looks like a policy decision and is really a fixture
    omission. The two policy versions must equal the constants the policies
    check, or both refuse on the version alone before any evidence is read.
  */
  await sql.query(
    `INSERT INTO meta_automation_business_controls
       (business_id, kill_switch_engaged, auto_execution_enabled, readiness_tier,
        guardrails_json)
     VALUES ($1::uuid, FALSE, FALSE, 'manual_review', $2::jsonb)
     ON CONFLICT (business_id) DO UPDATE SET guardrails_json = EXCLUDED.guardrails_json`,
    [BUSINESS, JSON.stringify({
      dryRunOnly: true,
      maxBudgetIncreasePct: 15,
      perActionSpendCeilingMinor: 40000,
      perActionSpendCeilingCurrency: "USD",
      budgetMinHoursBetweenChanges: 24,
      budgetMaxChangesPer7d: 3,
      budgetMaxAccountConcentrationPct: 60,
      budgetSizingPolicyVersion: BUDGET_SIZING_POLICY_VERSION,
      bidSizingPolicyVersion: BID_SIZING_POLICY_VERSION,
    })],
  );
  // An absent mode row reads `manual`, and both producers return early on that
  // before they ever look at a candidate.
  for (const decisionType of ["budget", "bid"]) {
    await sql.query(
      `INSERT INTO meta_automation_decision_type_modes (business_id, decision_type, mode)
       VALUES ($1::uuid, $2, 'semi_auto')
       ON CONFLICT (business_id, decision_type) DO UPDATE SET mode = 'semi_auto'`,
      [BUSINESS, decisionType],
    );
  }
}

async function seedCampaignRole() {
  /*
    Only the CBO campaign gets a published role.

    `contextTrust` is `high` only on an exact `high` confidence class, a
    byte-for-byte `system_inferred` origin AND an approved resolver identity;
    anything less leaves the label map empty and `roleAuthoritySatisfied` false
    for every campaign. The ABO campaign is deliberately left without one, so
    the seam also shows a role-unauthorised campaign producing no budget intent.
  */
  await getDb().query(
    `INSERT INTO engine_v3_campaign_context_daily
       (business_id, provider_account_id, campaign_id, campaign_name, as_of_date,
        inferred_kind, confidence_score, confidence_class, kind_source,
        kind_basis, resolver_version)
     VALUES ($1, $2, $3, 'Prospecting CBO', $4::date, 'main', 0.95, 'high',
             'system_inferred', 'system_inference', $5)`,
    [BUSINESS, ACCOUNT, CBO_CAMPAIGN, AS_OF, CAMPAIGN_CONTEXT_RESOLVER_VERSION],
  );
}

async function seedWarehouseFacts() {
  const base = {
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    accountTimezone: "UTC",
    accountCurrency: "USD",
    sourceSnapshotId: null,
  };

  /*
    One day at a time, the way the sync itself writes.

    `upsertMetaCampaignDailyRows` maintains the dimension tables as a side
    effect, emitting one dimension row per DAILY row — so a single call carrying
    twenty-eight days of one campaign proposes twenty-eight rows with the same
    conflict key and Postgres refuses the whole statement. A day is the unit the
    writer is built for.
  */
  for (let back = WINDOW_DAYS - 1; back >= 0; back -= 1) {
    const date = addDays(AS_OF, -back);
    const isLatest = back === 0;
    const campaignRows: MetaCampaignDailyRow[] = [];
    const adsetRows: MetaAdSetDailyRow[] = [];
    campaignRows.push({
      ...base,
      date,
      campaignId: CBO_CAMPAIGN,
      campaignNameCurrent: "Prospecting CBO",
      campaignNameHistorical: "Prospecting CBO",
      campaignStatus: "ACTIVE",
      objective: "OUTCOME_SALES",
      buyingType: "AUCTION",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      customEventType: "PURCHASE",
      bidStrategyType: "lowest_cost",
      bidStrategyLabel: null,
      manualBidAmount: null,
      bidValue: null,
      bidValueFormat: null,
      dailyBudget: 250,
      lifetimeBudget: null,
      isBudgetMixed: false,
      isConfigMixed: false,
      isOptimizationGoalMixed: false,
      isCustomEventTypeMixed: false,
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      ...metricRow({
        spend: 100, revenue: 360, conversions: 4,
        impressions: 4000, clicks: 30, reach: 1000,
      }),
    });
    campaignRows.push({
      ...base,
      date,
      campaignId: ABO_CAMPAIGN,
      campaignNameCurrent: "Retargeting ABO",
      campaignNameHistorical: "Retargeting ABO",
      campaignStatus: "ACTIVE",
      objective: "OUTCOME_SALES",
      buyingType: "AUCTION",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      customEventType: "PURCHASE",
      bidStrategyType: "lowest_cost",
      bidStrategyLabel: null,
      manualBidAmount: null,
      bidValue: null,
      bidValueFormat: null,
      dailyBudget: null,
      lifetimeBudget: null,
      isBudgetMixed: false,
      isConfigMixed: false,
      isOptimizationGoalMixed: false,
      isCustomEventTypeMixed: false,
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      ...metricRow({
        spend: 50, revenue: 50, conversions: 1,
        impressions: 4000, clicks: 80, reach: 2700,
      }),
    });
    /*
      The Chain-B ad set: twenty-seven ordinary days, then a day whose
      impressions collapse.

      500 against a seven-day median of 4000 is an 87.5% fall, which is what
      makes `delivery_stall` fire at high severity — and that anomaly is the
      ONLY evidence in this product that a cap is holding delivery back. The
      bid policy withholds every raise without it, so the stall is not
      decoration: it is the fact that authorises the change.
    */
    adsetRows.push({
      ...base,
      date,
      campaignId: CBO_CAMPAIGN,
      adsetId: CBO_ADSET,
      adsetNameCurrent: "Broad prospecting",
      adsetNameHistorical: "Broad prospecting",
      adsetStatus: "ACTIVE",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      customEventType: "PURCHASE",
      bidStrategyType: "cost_cap",
      bidStrategyLabel: "Cost cap",
      manualBidAmount: null,
      bidValue: 12.0,
      bidValueFormat: "currency",
      dailyBudget: null,
      lifetimeBudget: null,
      isBudgetMixed: false,
      isConfigMixed: false,
      isOptimizationGoalMixed: false,
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      ...(isLatest
        ? metricRow({
          spend: 40, revenue: 120, conversions: 19,
          impressions: 500, clicks: 3, reach: 200,
        })
        : metricRow({
          spend: 80, revenue: 240, conversions: 3,
          impressions: 4000, clicks: 30, reach: 1000,
        })),
    });
    /*
      The second budget owner, which is load-bearing arithmetic rather than
      scenery: with one owner the CBO share is 1.0 and every increase trips
      `policy_account_concentration_exceeded`. Its lowest-cost strategy also
      gives the seam a contrast case — an ad set that owns no writable cap.
    */
    adsetRows.push({
      ...base,
      date,
      campaignId: ABO_CAMPAIGN,
      adsetId: ABO_ADSET,
      adsetNameCurrent: "Retargeting 30d",
      adsetNameHistorical: "Retargeting 30d",
      adsetStatus: "ACTIVE",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      customEventType: "PURCHASE",
      bidStrategyType: "lowest_cost",
      bidStrategyLabel: null,
      manualBidAmount: null,
      bidValue: null,
      bidValueFormat: null,
      dailyBudget: 250,
      lifetimeBudget: null,
      isBudgetMixed: false,
      isConfigMixed: false,
      isOptimizationGoalMixed: false,
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      ...metricRow({
        spend: 50, revenue: 50, conversions: 1,
        impressions: 4000, clicks: 80, reach: 2700,
      }),
    });

    /*
      Through the production writers, which resolve the business and account
      reference ids a raw INSERT would have to guess at and maintain the
      dimension rows both candidate queries join against.
    */
    await upsertMetaCampaignDailyRows(campaignRows);
    await upsertMetaAdSetDailyRows(adsetRows);
  }
}

/**
 * Publication, through the real slice lifecycle.
 *
 * `filterRowsToPublishedKeys` drops every warehouse row whose account:day is
 * not a published key, and an empty key set returns an empty array — so an
 * unpublished fixture reads as an account with no campaigns and no
 * recommendations at all. The gate is satisfied by publishing real slices, not
 * by switching the finalization flag off.
 */
async function publishSlices() {
  for (let back = WINDOW_DAYS - 1; back >= 0; back -= 1) {
    const day = addDays(AS_OF, -back);
    for (const surface of ["campaign_daily", "adset_daily"] as const) {
      const slice = await createMetaAuthoritativeSliceVersion({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        day,
        surface,
        state: "pending_finalization",
        truthState: "finalized",
        validationStatus: "passed",
        status: "validated",
      });
      if (!slice?.id) fail("slice_not_created", `${day} ${surface}`);
      await publishMetaAuthoritativeSliceVersion({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        day,
        surface,
        sliceVersionId: slice.id,
        publicationReason: "economics_bid_chain_seam",
      });
    }
  }
}

/**
 * The retained budget truth, with the foreign-key chain it depends on.
 *
 * `meta_entity_state_history` rows carry a COMPOSITE key back to an
 * observation run — id, business, account, entity type, captured_at and
 * completeness all have to agree — so the run has to exist first. The CBO ad
 * set carries its parent's amount and owns none of it, which is what makes its
 * budget universe `proven_non_applicable` and keeps a budget intent off it; an
 * ad set that acquired one would suppress its own bid intent as a sibling
 * change in the same window.
 */
async function seedBudgetState(accountRefId: string) {
  const sql = getDb();
  const captured = `${AS_OF}T03:00:00.000Z`;
  const runFor = async (entityType: "campaign" | "adset") => {
    const rows = (await sql.query(
      `INSERT INTO meta_entity_observation_runs
         (business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, endpoint,
          observed_at, captured_at, completeness, run_hash)
       VALUES ($1::uuid, $2, $6::uuid, $3, $4, '/act/' || $3,
               $5::timestamptz, $5::timestamptz, 'complete',
               $7)
       RETURNING id::text AS id`,
      [BUSINESS, BUSINESS, ACCOUNT, entityType, captured, accountRefId,
        (entityType === "campaign" ? "e" : "f").repeat(64)],
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
      [runIds[input.entityType], BUSINESS, BUSINESS, ACCOUNT,
        input.entityType, input.entityId, input.campaignId,
        input.entityType === "adset" ? input.entityId : null,
        input.campaignDaily, input.adsetDaily, input.origin, captured,
        String(stateHashSeed).padStart(64, "0"), accountRefId],
    );
  };

  await state({
    entityType: "campaign", entityId: CBO_CAMPAIGN, campaignId: CBO_CAMPAIGN,
    origin: "campaign", campaignDaily: "25000", adsetDaily: null,
  });
  await state({
    entityType: "adset", entityId: CBO_ADSET, campaignId: CBO_CAMPAIGN,
    origin: "campaign", campaignDaily: "25000", adsetDaily: null,
  });
  await state({
    entityType: "adset", entityId: ABO_ADSET, campaignId: ABO_CAMPAIGN,
    origin: "adset", campaignDaily: null, adsetDaily: "25000",
  });
  // No `meta_budget_write_journal` rows: this product has never changed these
  // budgets, which is a real observation and not an unreadable one.
}

type DecisionRow = {
  scope_type: string;
  scope_id: string;
  rec_type: string;
  decision_label: string | null;
  target_value: Record<string, unknown> | null;
};

async function readDecisionRows(scopeId: string): Promise<DecisionRow[]> {
  return (await getDb().query(
    `SELECT scope_type, scope_id, rec_type, decision_label, target_value
       FROM meta_decision_snapshots_daily
      WHERE business_id = $1 AND snapshot_date = $2::date
        AND kind = 'recommendation' AND scope_id = $3`,
    [BUSINESS, AS_OF, scopeId],
  )) as DecisionRow[];
}

function intentFor(rows: DecisionRow[], contractVersion: string, label: string) {
  const match = rows.find(
    (row) => (row.target_value as { contractVersion?: unknown } | null)
      ?.contractVersion === contractVersion,
  );
  if (!match) {
    fail(
      label,
      `no row carries ${contractVersion}; observed rec types `
      + JSON.stringify(rows.map((row) => row.rec_type)),
    );
  }
  return match;
}

async function main() {
  if (
    process.env.DATABASE_URL?.includes(":15432/")
    || process.env.DATABASE_URL?.includes(":5432/")
  ) {
    fail("protected_port", "DATABASE_URL points at the local volume or the prod tunnel");
  }
  /*
    The resolver identity this deployment approves, taken from the constant
    rather than typed out. A literal here would keep passing on the day the
    resolver is versioned, while every real business silently lost its campaign
    roles.
  */
  process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION =
    CAMPAIGN_CONTEXT_RESOLVER_VERSION;

  // Installed BEFORE the first production call, so a request during seeding is
  // caught too.
  const provider = installRefusingFetch();

  const accountRefId = await seedIdentity();
  await seedCommercialTargets();
  await seedShopifyStore(new Date().toISOString());
  await seedAutomationControls();
  await seedCampaignRole();
  await seedWarehouseFacts();
  await publishSlices();
  await seedBudgetState(accountRefId);

  const run = await runMetaSnapshotForBusiness(BUSINESS, AS_OF);
  expectEqual(run.failedAccountIds, [], "every assigned account generated");
  expectEqual(provider.calls, [], "no provider request left the process");

  // ── Chain A: the derived benchmark becomes a sized budget intent ─────────
  const campaignRows = await readDecisionRows(CBO_CAMPAIGN);
  const budgetRow = intentFor(
    campaignRows, META_BUDGET_INTENT_CONTRACT_VERSION, "campaign_budget_intent_absent",
  );
  const budgetIntent = budgetRow.target_value as Record<string, unknown>;
  expectEqual(budgetRow.decision_label, "scale", "the engine labelled the campaign for scale");
  expectEqual(budgetIntent.direction, "increase", "budget direction");
  /*
    Ten, not fifteen.

    r = 3.60 / 2.20 = 1.64 selects the >=1.35 band at 15%, and the increase
    damper then caps it at the policy's damped maximum because this account's
    calibration cell carries the minimum required sample, far under the sample
    the policy wants before it will pay a full rung. 27500 is inside the 40000
    ceiling, and the post-increase account share stays under the 60%
    concentration limit only because a second budget owner exists.
  */
  expectEqual(budgetIntent.percent, 10, "budget rung after damping");
  expectEqual(budgetIntent.amountMinor, 27500, "proposed budget in minor units");
  expectEqual(budgetIntent.currentMinorUnits, 25000, "observed budget in minor units");

  const budgetCandidates = await listTypedBudgetCandidates(BUSINESS, AS_OF);
  expectEqual(budgetCandidates.length, 1, "one typed budget candidate");
  const budgetCandidate = budgetCandidates[0]!;
  expectEqual(budgetCandidate.scopeType, "campaign", "candidate grain");
  expectEqual(budgetCandidate.scopeId, CBO_CAMPAIGN, "candidate entity");
  expectEqual(budgetCandidate.providerAccountId, ACCOUNT, "candidate account");
  expectEqual(budgetCandidate.recommendedAction, "increase_budget", "candidate verb");
  expectEqual(budgetCandidate.targetAmountMinor, 27500, "candidate amount");

  /*
    The contrast case. The ABO campaign owns no budget in the retained state —
    its ad set does — and it carries no published role either, so neither the
    ownership gate nor the role gate would admit it. A budget intent here would
    mean an amount had been written to an entity that does not hold one.
  */
  const aboRows = await readDecisionRows(ABO_CAMPAIGN);
  const aboBudget = aboRows.find(
    (row) => (row.target_value as { contractVersion?: unknown } | null)
      ?.contractVersion === META_BUDGET_INTENT_CONTRACT_VERSION,
  );
  if (aboBudget) fail("abo_budget_intent_present", "a campaign with no authorised role was sized");

  // ── Chain B: the same benchmark moves a $12.00 cap to $13.20 ─────────────
  const stallRows = (await getDb().query(
    `SELECT rec_type, severity
       FROM meta_decision_snapshots_daily
      WHERE business_id = $1 AND snapshot_date = $2::date
        AND kind = 'anomaly' AND scope_id = $3 AND rec_type = 'delivery_stall'`,
    [BUSINESS, AS_OF, CBO_ADSET],
  )) as Array<{ rec_type: string; severity: string | null }>;
  if (stallRows.length !== 1) {
    /*
      The snapshot swallows a failed anomaly detection into an empty list, so an
      absent stall looks identical to a healthy ad set. Re-running the detector
      here turns that silence back into the error it was, which is the whole
      reason a seam is the right place to assert on it.
    */
    const detectorSaid = await detectAnomaliesForBusiness({
      businessId: BUSINESS,
      snapshotDate: AS_OF,
      calibrationContext: null,
    }).then((rows) => `detector returned ${rows.length} anomalies`)
      .catch((error) => `detector threw: ${error instanceof Error ? error.message : String(error)}`);
    fail(
      "delivery_stall_absent",
      `expected exactly one stall row, got ${stallRows.length}; ${detectorSaid}`,
    );
  }
  expectEqual(stallRows[0]!.severity, "high", "stall severity from the measured fall");

  const adsetRows = await readDecisionRows(CBO_ADSET);
  const bidRow = intentFor(
    adsetRows, META_BID_INTENT_CONTRACT_VERSION, "adset_bid_intent_absent",
  );
  const bidIntent = bidRow.target_value as Record<string, unknown>;
  expectEqual(bidIntent.currentMinorUnits, 1200, "observed cap in minor units");
  expectEqual(bidIntent.proposedMinorUnits, 1320, "proposed cap in minor units");
  expectEqual(bidIntent.bidAmountMinor, 1320, "the field the apply path reads");
  expectEqual(bidIntent.percent, 10, "cap rung");
  expectEqual(bidIntent.direction, "increase", "cap direction");
  expectEqual(bidIntent.bidStrategyType, "cost_cap", "cap strategy");
  /*
    The six keys the producer's query has always required and the projection
    never wrote. Until this seam existed nothing compared the payload a snapshot
    persists with the payload the candidate SQL selects, so the whole bid arm
    was dark while every test around it was green.
  */
  expectEqual(bidIntent.kind, "bid_intent", "payload names its own contract kind");
  expectEqual(bidIntent.authorityStatus, "authorised", "authority status is written");
  expectEqual(bidIntent.blockerCodes, [], "no blockers on an authorised intent");
  expectEqual(bidIntent.currency, "USD", "cap currency");
  expectEqual(bidIntent.currencyExponent, 2, "cap currency scale");

  // A lowest-cost ad set owns no writable cap, so it gets no intent at all.
  const aboAdsetRows = await readDecisionRows(ABO_ADSET);
  const aboBid = aboAdsetRows.find(
    (row) => (row.target_value as { contractVersion?: unknown } | null)
      ?.contractVersion === META_BID_INTENT_CONTRACT_VERSION,
  );
  if (aboBid) fail("abo_bid_intent_present", "a lowest-cost ad set was given a cap");

  // ── The queue row, from the producer the snapshot itself ran ─────────────
  expectEqual(run.bidProposals, { candidates: 1, projected: 1 }, "the snapshot's own bid producer");
  const bidCandidates = await listTypedBidCandidates(BUSINESS, AS_OF);
  expectEqual(bidCandidates.length, 1, "one typed bid candidate through the real SQL");
  expectEqual(bidCandidates[0]!.scopeId, CBO_ADSET, "bid candidate entity");
  expectEqual(bidCandidates[0]!.proposedMinorUnits, 1320, "bid candidate amount");

  const queuedRows = (await getDb().query(
    `SELECT id::text AS id FROM meta_automation_proposals
      WHERE business_id = $1::uuid AND provider_account_id = $2
        AND proposed_action = 'bid' AND scope_id = $3`,
    [BUSINESS, ACCOUNT, CBO_ADSET],
  )) as Array<{ id: string }>;
  expectEqual(queuedRows.length, 1, "exactly one bid row on the queue");
  const proposal = await readMetaAutomationProposal({
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    proposalId: queuedRows[0]!.id,
  });
  expectEqual(proposal?.proposedAction, "bid", "queue row action");
  expectEqual(proposal?.bidEnvelope?.currentMinorUnits, 1200, "envelope current amount");
  expectEqual(proposal?.bidEnvelope?.proposedMinorUnits, 1320, "envelope proposed amount");
  if (!proposal?.bidEnvelope?.fingerprint) {
    fail("envelope_fingerprint_absent", "a bid row must carry a fingerprinted envelope");
  }
  /*
    Running the producer again finds the same candidate and refuses to
    duplicate it. That is the open-slot discipline working, and it is why the
    numbers above are asserted from the snapshot's own run rather than from a
    second call.
  */
  const rerun = await projectMetaBidProposals({
    businessId: BUSINESS,
    snapshotDate: AS_OF,
    insertProposal: async (insert) => insertBidProposalRow({
      businessId: BUSINESS,
      proposalId: insert.proposalId,
      candidate: insert.candidate,
      envelopeJson: insert.envelopeJson,
      actionLabel: insert.actionLabel,
    }),
  });
  expectEqual(rerun.candidates, 1, "the candidate survives a second pass");
  expectEqual(rerun.refusals, { insert_conflicted: 1 }, "and is not duplicated");

  // ── Chain A's terminal step, pinned by its exact refusal ─────────────────
  /*
    `D086_PROFILE_LATEST_SQL` reads `engine_v3_account_profile_output`, which
    `lib/migrations.ts` deliberately does not create: the D086 pack is prepared
    and unapplied, and its own audit asserts it stays that way. The statement
    raises 42P01, the loader reads that as unknown, and the producer refuses by
    name.

    The production loader is used UNWRAPPED on purpose. Substituting a
    seam-owned `loadCompositionSources` would replace the only thing this step
    can prove with the seam's own opinion. When the D086 slice is deployed this
    assertion fails, and that is the correct moment to change it to demand a
    projected row.
  */
  const budgetProjection = await projectMetaBudgetProposals({
    businessId: BUSINESS,
    snapshotDate: AS_OF,
    loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
    insertProposal: async (insert) => insertBudgetProposalRow({
      businessId: BUSINESS,
      proposalId: insert.proposalId,
      candidate: insert.candidate,
      envelopeJson: insert.envelopeJson,
      actionLabel: insert.actionLabel,
    }),
  });
  expectEqual(budgetProjection.candidates, 1, "the budget candidate is admitted");
  expectEqual(budgetProjection.projected, 0, "and no row is raised");
  expectEqual(
    budgetProjection.refusals,
    { composition_sources_unavailable: 1 },
    "refused by name, not by silence",
  );

  // ── The negative control that makes $26.36 load-bearing ─────────────────
  /*
    Age the store's sync past its 48-hour freshness bound and re-run.

    With target CPA, break-even CPA and the AOV assumption all null, the store's
    observed average order value is the ONLY CPA benchmark AND the only
    `accountCpaBaseline`, so `metaLossBudgetMaturity` returns null and every
    entity fails maturity. Both intents disappear together. If the numbers above
    could be produced without the store, this is the assertion that would fail.
  */
  await getDb().query(
    `UPDATE shopify_sync_state SET latest_successful_sync_at = now() - interval '96 hours'
      WHERE business_id = $1 AND provider_account_id = $2`,
    [BUSINESS, SHOP],
  );
  await runMetaSnapshotForBusiness(BUSINESS, AS_OF);
  /*
    An intent is identified by its contract version, which is exactly the
    identity both candidate queries select on. The `state` rows keep a
    `target_value` of their own — an entity-state payload, not a proposed
    amount — so the claim is stated against the contract rather than against
    the column being null.
  */
  const carriesIntent = (rows: DecisionRow[], contractVersion: string) =>
    rows.some((row) => (row.target_value as { contractVersion?: unknown } | null)
      ?.contractVersion === contractVersion);
  if (carriesIntent(await readDecisionRows(CBO_CAMPAIGN), META_BUDGET_INTENT_CONTRACT_VERSION)) {
    fail("budget_intent_survived_store_removal", "the benchmark was not the store's");
  }
  if (carriesIntent(await readDecisionRows(CBO_ADSET), META_BID_INTENT_CONTRACT_VERSION)) {
    fail("bid_intent_survived_store_removal", "the benchmark was not the store's");
  }
  // And nothing downstream can find one either.
  expectEqual(
    (await listTypedBudgetCandidates(BUSINESS, AS_OF)).length, 0,
    "no budget candidate without the store",
  );
  expectEqual(
    (await listTypedBidCandidates(BUSINESS, AS_OF)).length, 0,
    "no bid candidate without the store",
  );

  // And back again, so the control is shown to be about the store rather than
  // about having run the snapshot twice.
  await getDb().query(
    `UPDATE shopify_sync_state SET latest_successful_sync_at = now()
      WHERE business_id = $1 AND provider_account_id = $2`,
    [BUSINESS, SHOP],
  );
  await runMetaSnapshotForBusiness(BUSINESS, AS_OF);
  const restored = intentFor(
    await readDecisionRows(CBO_ADSET),
    META_BID_INTENT_CONTRACT_VERSION,
    "bid_intent_did_not_return",
  );
  expectEqual(
    (restored.target_value as Record<string, unknown>).proposedMinorUnits,
    1320,
    "the same amount returns with the store's evidence",
  );

  expectEqual(provider.calls, [], "still no provider request, across three runs");
  provider.restore();

  console.log(
    `[${LABEL}] PASS: the real snapshot derives its CPA benchmark from a Shopify `
    + "store and a target ROAS alone, sizes a campaign budget 25000 -> 27500 that "
    + "the real candidate SQL selects, sizes a cost cap 1200 -> 1320 on the "
    + "delivery-stalled ad set and raises the queue row carrying it, refuses the "
    + "budget row by name on the unapplied D086 profile table, loses both intents "
    + "when the store's evidence is withdrawn, and makes zero provider requests.",
  );
  resetDbClientCache();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  try {
    resetDbClientCache();
  } catch {
    // Best-effort cleanup after the original seam failure.
  }
  process.exit(1);
});
