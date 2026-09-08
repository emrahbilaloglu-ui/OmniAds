// Child of ephemeral-postgres-migrations-check. It runs only against the
// throwaway database URL force-set by the parent, and the only provider it ever
// reaches is a double this file installs.
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
// warehouse and creative facts through the shipped writers, a real capture
// chain (partition, raw snapshot, observation) for the retained budget truth, a
// Shopify store, commercial targets, guardrails and campaign roles — and then
// calls the REAL production functions end to end:
// `runMetaSnapshotForBusiness`, `listTypedBudgetCandidates`,
// `listTypedBidCandidates`, `projectMetaBidProposals` with `insertBidProposalRow`,
// `projectMetaBudgetProposals` with the production
// `loadBudgetCompositionSourcesForCandidate`, `readMetaAutomationProposal`, the
// approval route's own claim/readers/runtime/lifecycle assembly, and
// `runMetaBudgetAutomationSweepIfDue`.
//
// THE BUDGET ARM, WHICH USED TO STOP HERE. The earlier revision asserted one
// budget candidate and ZERO projected rows, because
// `engine_v3_account_profile_output` had no migration and no writer: the
// commercial verdict the composition needs could not exist. That is a negative
// test, not acceptance of the feature. The table is now migrated and
// `lib/meta/account-profile-output-producer.ts` retains the canonical verdict
// from this account's own facts, so the chain runs to a queue row, an operator
// approval and an unattended sweep — each ending in a durable journal receipt
// verified against a provider read-back. Nothing here inserts a profile row,
// and the two ways a verdict fails — never produced, and superseded by
// commercial truth that moved — are asserted as their own refusals.
//
// AND ONE MORE BUSINESS, WHOSE ONLY SUBJECT IS ACCOUNT SCOPE. The chain above
// is a single business with a single ad account, where "this account's
// evidence" and "this business's evidence" are numerically the same thing — so
// it cannot see the defect where they are not. A second business here holds
// four accounts: it produces one account's verdict, moves a DIFFERENT
// account's samples, re-runs the whole calibration pass, and requires the first
// account's eligibility, blocker code, spend unit and both fingerprints to be
// byte-identical while the pooled scope visibly moves; it requires an account
// with no measured evidence at all to hold with the resolver's own named code
// rather than inherit a sibling's; it requires one more synced ad row NOT to
// move the day's measured identity, and the next calibration pass to move it;
// and it requires an account the pass has not covered to be refused by name
// rather than have a verdict retained on a live aggregate.
//
// THE CALIBRATION PASS IS PART OF THE CHAIN NOW, for both businesses, because
// it is the only writer of the scopes those reads land on. Every calibration
// row this seam asserts against was written by the shipped
// `runCalibrationJob`, at the scope it computed, and never at two scopes at
// once.
//
// WHAT THE BENCHMARK IS MADE OF. For a Meta decision the canonical
// money-per-purchase unit is META'S OWN attributed purchase AOV — attributed
// revenue over attributed purchases, ninety days, for THIS provider account —
// divided by the target ROAS. `resolveSpendUnit` is a two-case split, not a
// precedence list: with a target ROAS that platform AOV is the only hard basis,
// and with no target ROAS a legacy configured target CPA is preserved exactly.
// `observed_shopify_aov` and `operator_aov` are RETIRED rungs — still members
// of `SpendUnitSource` so persisted rows parse, and never minted again. The
// store's own average order value is DIAGNOSTIC evidence and chooses nothing,
// which this seam is built to prove rather than to assume.
//
// It re-implements NO formula. Every asserted number is either read back out of
// the database or taken off a production return value. In particular the seam
// never divides 58.00 by 2.20: the derived $26.36 benchmark is bound by what it
// produces (a 10% cap raise at a 0.83 CPA ratio, and the retained verdict's own
// spend unit) and by the two controls at the end of the file.
//
// THE TWO CONTROLS, AND WHY THEY POINT THE WAY THEY DO. The POSITIVE one
// withdraws the STORE's evidence and requires every number to stand still. The
// store's books say $36.00 and Meta's say $58.00, so a benchmark taken from the
// store would be $16.36 and would CUT the cap to 1080; the raise to 1320
// surviving the store's disappearance is what says the store is not the basis.
// The NEGATIVE one moves the META-attributed purchase sample one purchase under
// the floor `classifyMetaAovQuality` calls `ready`, leaving the attributed AOV
// itself untouched at $58.00, and requires every intent to disappear — because
// only a `hardEligibleByDefault` unit may size money, and the sampled rung earns
// that only at a ready sample.
import {
  createMetaAuthoritativeSliceVersion,
  publishMetaAuthoritativeSliceVersion,
  upsertMetaAdSetDailyRows,
  upsertMetaCampaignDailyRows,
  upsertMetaCreativeDailyRows,
  buildMetaRawSnapshotHash,
  persistMetaRawSnapshot,
  queueMetaSyncPartition,
} from "@/lib/meta/warehouse";
import { mapCampaignObservationState, mapAdSetObservationState } from "@/lib/api/meta";
import { persistMetaEntityObservation } from "@/lib/meta/entity-state-history";
import { detectAnomaliesForBusiness } from "@/lib/meta/anomalies";
import { getDb, resetDbClientCache } from "@/lib/db";
import { readMetaAutomationProposal } from "@/lib/meta/automation-proposals";
import { BID_SIZING_POLICY_VERSION } from "@/lib/meta/bid-sizing-policy";
import { BUDGET_SIZING_POLICY_VERSION } from "@/lib/meta/budget-sizing-policy";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { runCalibrationJob } from "@/lib/creative-decision-engine/jobs/calibration-job";
import { MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE } from "@/lib/creative-decision-engine/config";
import { classifyMetaAovQuality } from "@/lib/creative-decision-engine/spend-unit-resolver";
import { computeMetaAttributedAov } from "@/lib/creative-decision-engine/meta-aov-calculator";
import { OBSERVED_SHOPIFY_AOV_MIN_ORDERS } from "@/lib/creative-decision-engine/shopify-aov-source";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
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
import {
  produceRetainedAccountProfileOutputs,
  readAccountProfileRetentionIdentity,
  readAccountProfileRetentionInputs,
} from "@/lib/meta/account-profile-output-producer";
import { runMetaSnapshotForBusiness } from "@/lib/meta/snapshot";
import {
  claimMetaAutomationProposal,
  forceMetaAutomationProposalReconcile,
  markMetaAutomationProposalDispatchStarted,
  providerDispatchFacts,
  settleMetaAutomationProposal,
} from "@/lib/meta/automation-proposals";
import { appendMetaAutomationReconciliationReceipt } from "@/lib/meta/automation-reconciliation";
import { createBudgetProposalServerRuntime } from "@/lib/meta/budget-proposal-server-runtime";
import { createBudgetServerReaders } from "@/lib/meta/budget-proposal-server-readers";
import { runClaimedProposalExecution } from "@/lib/meta/budget-execution-lifecycle";
import { buildMetaBudgetWriteContextForProposal } from "@/lib/meta/budget-proposal-write-context";
import { runMetaBudgetAutomationSweepIfDue } from "@/lib/meta/budget-automation-scheduled";
import { composeBudgetExecutionCandidate } from "@/lib/meta/budget-execution-composition";
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
/*
  The SECOND authorised budget owner.

  Two proposals are needed because a proposal is executed exactly once, and the
  approval path and the scheduled sweep are two different authorisations that
  both have to be shown reaching the provider. It mirrors the CBO campaign in
  every respect except the delivery stall, so it raises a budget row and no bid
  row, and its presence also keeps the account concentration share of any single
  increase comfortably inside the guardrail.
*/
const SWEEP_CAMPAIGN = "5000000000103";
const SWEEP_ADSET = "5000000000203";

/*
  A SECOND business, whose only subject is account scope.

  The chain above is one business with one ad account, so nothing in it can
  say whether a verdict is that ACCOUNT's or the business's — with a single
  account the two readings are numerically identical. This business holds
  three: two that have measured evidence and one that has none. It is
  deliberately kept apart from the chain business rather than bolted onto it,
  because adding accounts there would change the concentration arithmetic,
  the candidate set and the snapshot's own account loop, and the numbers
  above would then be proving something else.

  It gets no Meta connection, no automation controls, no campaign roles and
  no snapshot run: the producer is called directly, which is the whole point.
*/
const SCOPE_BUSINESS = "d0000000-0000-4000-8000-000000000502";
const SCOPE_ACCOUNT_A = "act_5000000000011";
const SCOPE_ACCOUNT_B = "act_5000000000012";
const SCOPE_ACCOUNT_C = "act_5000000000013";
/*
  A FOURTH account, assigned only after the calibration pass has run.

  Accounts are assigned between passes, so an account whose own calibration
  scope does not exist yet is an ordinary production state rather than a
  contrived one. It is what separates "measured and empty" — account C, which
  the pass covered and found nothing in — from "never measured", which is what
  an empty funnel pack and a live aggregate would otherwise be reported as.
*/
const SCOPE_ACCOUNT_D = "act_5000000000014";

/** The evidence window both the warehouse and the store fixture cover. */
const WINDOW_DAYS = 28;

/**
 * The merchant's own settled order value. DIAGNOSTIC EVIDENCE, NOT A BASIS.
 *
 * Kept far away from {@link CONVERTER_ORDER_VALUE} so the two books cannot be
 * confused for each other: see `seedShopifyStore`.
 */
const STORE_ORDER_VALUE = 36.0;

/**
 * What META attributed to one purchase, which IS the basis.
 *
 * 58.00 over the 2.20 target ROAS is the $26.36 benchmark every money figure in
 * this seam is measured against.
 */
const CONVERTER_ORDER_VALUE = 58.0;

/**
 * The smallest attributed-purchase count `classifyMetaAovQuality` calls `ready`.
 *
 * FOUND, NOT ASSERTED. `resolveSpendUnit` marks the sampled rung
 * `hardEligibleByDefault` only at `ready`, and `lib/meta/snapshot.ts` sizes
 * nothing from a unit that is not — so this number is the floor the whole
 * economics chain stands on. Probing the shipped classifier for it means the
 * fixture cannot drift away from a constant somebody moved, and the negative
 * control below can sit exactly one purchase under whatever it currently is.
 */
const META_AOV_READY_FLOOR = (() => {
  for (let count = 1; count <= 10_000; count += 1) {
    if (classifyMetaAovQuality(count) === "ready") return count;
  }
  throw new Error(
    `${LABEL} FAILED [meta_aov_ready_floor_unfindable]: no purchase count under `
    + "10000 is classified ready",
  );
})();

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
 * The provider, as a double that only ever answers what this seam allows.
 *
 * It starts REFUSING. Everything the economics and bid chains claim is derived
 * from retained facts, so a request during that phase is a finding and a POST
 * is a failure of the strongest kind.
 *
 * It is then switched to SERVING for the budget execution phase, where the
 * point is the opposite: the projection takes exactly one GET-only baseline
 * through the shipped write context, and approval and the scheduled sweep each
 * POST once through the shipped executor. The double holds the entity's budget
 * as state and updates it on a POST, so the executor's own pre-POST
 * compare-and-set and post-write read-back are answered by a provider that
 * actually changed — not by a stub that echoes whatever it is asked.
 */
function installProviderDouble(budgets: Map<string, number>): {
  calls: RecordedRequest[];
  serve: () => void;
  refuse: () => void;
  restore: () => void;
  since: (index: number) => RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  let mode: "refuse" | "serve" = "refuse";
  const original = globalThis.fetch;
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(
      typeof input === "object" && input !== null && "url" in input
        ? (input as { url: unknown }).url
        : input,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (mode === "refuse") {
      if (method !== "GET") fail("provider_write_attempted", `${method} ${url}`);
      fail("provider_request_attempted", `${method} ${url}`);
    }
    const node = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    // The ad account profile, which is where the account's currency comes from.
    if (method === "GET" && node === ACCOUNT) {
      return json({
        id: ACCOUNT, currency: "USD", name: "Economics seam account",
        timezone_name: "UTC",
      });
    }
    if (method === "GET" && budgets.has(node)) {
      return json({
        id: node,
        // Meta reports the account without the `act_` prefix the context holds.
        account_id: ACCOUNT.replace(/^act_/, ""),
        name: node, daily_budget: String(budgets.get(node)),
        status: "ACTIVE", effective_status: "ACTIVE",
      });
    }
    if (method === "POST" && budgets.has(node)) {
      const body = init?.body instanceof URLSearchParams
        ? init.body
        : new URLSearchParams(String(init?.body ?? ""));
      const amount = Number(body.get("daily_budget"));
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        fail("provider_post_without_amount", `${url} body=${body.toString()}`);
      }
      budgets.set(node, amount);
      return json({ success: true, id: node });
    }
    fail("provider_request_unexpected", `${method} ${url}`);
  }) as typeof fetch;
  return {
    calls,
    serve: () => { mode = "serve"; },
    refuse: () => { mode = "refuse"; },
    restore: () => { globalThis.fetch = original; },
    since: (index: number) => calls.slice(index),
  };
}

/**
 * Clear the process-wide read-through cache.
 *
 * `getMetaAccountContext` memoises for a minute on `globalThis`, and this seam
 * deliberately runs the first phase with no Meta connection at all — so the
 * "not connected" answer would still be cached when the connection is seeded.
 * A fresh process would not have it; clearing the store is how one run stands
 * in for two.
 */
function clearServerCache() {
  (globalThis as typeof globalThis & {
    __omniadsServerCache?: { entries: Map<string, unknown> };
  }).__omniadsServerCache?.entries.clear();
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

    This is the whole economics case, and it is the FIRST case of
    `resolveSpendUnit`'s two-case split: a configured target ROAS makes Meta's
    own attributed purchase AOV the one hard basis, so the Meta purchase
    evidence seeded below is the ONLY source of a CPA benchmark and the only
    `accountCpaBaseline` `metaLossBudgetMaturity` can use. That is what makes it
    load-bearing rather than decorative, and it is what the two controls at the
    end of this seam demonstrate from both sides.

    The nulls are not decoration either. A target CPA beside a target ROAS no
    longer adds a second anchor — the ladder stops reading it — and today it
    would additionally suppress the basis this fixture rests on, because
    `configuredUnitAvailable` in `lib/meta/snapshot.ts` skips the
    attributed-AOV read whenever a target CPA or an operator AOV assumption is
    configured, and CASE 1 then has no AOV to divide. That short-circuit is a
    survival of the retired precedence and is reported with this work; nothing
    here depends on it, because all three inputs are null.
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
  /*
    The SUCCESS window is a separate pair of columns, and it is the one the
    coverage proof reads.

    `latest_sync_window_start`/`_end` are written before any work happens and
    again on failure, so they describe an ATTEMPT; only
    `latest_successful_sync_window_start`/`_end` are written by a pass that
    finished. `proveShopifyOrderWindowCovered` therefore reads the success pair
    and answers `orders_coverage_unproven` when it is absent — a store that may
    well be covered, with no retained proof that it is. A fixture that recorded
    only the attempt window was claiming a span no completed pass had
    established, which is exactly the shape the proof exists to reject.
  */
  await sql.query(
    `INSERT INTO shopify_sync_state
       (business_id, provider_account_id, sync_target,
        latest_successful_sync_at, latest_sync_window_start,
        latest_sync_window_end, latest_successful_sync_window_start,
        latest_successful_sync_window_end, ready_through_date,
        latest_sync_status)
     VALUES ($1, $2, 'commerce_orders_recent', $3::timestamptz, $4::date,
             $5::date, $4::date, $5::date, $5::date, 'succeeded')
     ON CONFLICT (business_id, provider_account_id, sync_target)
     DO UPDATE SET latest_successful_sync_at = EXCLUDED.latest_successful_sync_at`,
    [BUSINESS, SHOP, syncAt, addDays(AS_OF, -60), AS_OF],
  );

  /*
    `OBSERVED_SHOPIFY_AOV_MIN_ORDERS` orders inside the closed window — the
    observed-order floor exactly, so the store's evidence resolves `observed`
    rather than `sample_thin`. The AOV is the ledger's own revenue / purchases.

    STORE_ORDER_VALUE is deliberately NOT what Meta attributed. The merchant's
    settled orders and Meta's attributed purchases are two different books, and
    a fixture in which they carried the same number could not tell a benchmark
    taken from the store apart from one taken from Meta. Here they are far
    apart: 36.00 / 2.20 = 16.36 against 58.00 / 2.20 = 26.36, which is the
    difference between a 10% CUT and a 10% RAISE on the same $12.00 cap. The
    positive control at the end of this seam is exactly that distinction, and
    it is only legible because these two numbers disagree.
  */
  for (let index = 0; index < OBSERVED_SHOPIFY_AOV_MIN_ORDERS; index += 1) {
    const day = addDays(AS_OF, -(1 + (index % 27)));
    await sql.query(
      `INSERT INTO shopify_orders
         (business_id, provider_account_id, shop_id, order_id, currency_code,
          shop_currency_code, order_created_at, order_created_date_local,
          total_price, current_total_price, original_total_price)
       VALUES ($1, $2, $2, $3, 'USD', 'USD', $4::timestamptz, $5::date, $6, $6, $6)
       ON CONFLICT DO NOTHING`,
      [BUSINESS, SHOP, `order-${index}`, `${day}T12:00:00.000Z`, day, STORE_ORDER_VALUE],
    );
    await sql.query(
      `INSERT INTO shopify_sales_events
         (business_id, provider_account_id, shop_id, event_id, source_kind,
          source_id, order_id, occurred_at, occurred_date_local,
          gross_sales, net_revenue, currency_code)
       VALUES ($1, $2, $2, $3, 'order', $4, $4, $5::timestamptz, $6::date,
               $7, $7, 'USD')
       ON CONFLICT DO NOTHING`,
      [BUSINESS, SHOP, `event-${index}`, `order-${index}`,
        `${day}T12:00:00.000Z`, day, STORE_ORDER_VALUE],
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
  /*
    The RETAINED authority record, which is a different fact from the daily row
    above and is the one the budget path actually reads.

    Its producer in this product is `campaign-context-job`'s
    `UPSERT_ROLE_AUTHORITY_QUERY`, which writes exactly these columns beside the
    daily inference under `engine-v3-campaign-role-authority.v1`. It is seeded
    here as an INPUT, the same way the daily context row above is: this seam's
    subject is the budget chain, and the campaign-context job is upstream of it.
    Both hashes are the job's own digests over its evidence; a fixture cannot
    reproduce those, so they are stated as fixture digests and nothing in the
    budget path reads them.
  */
  await getDb().query(
    `INSERT INTO engine_v3_campaign_role_authority
       (contract, business_id, provider_account_id, campaign_id, as_of_date,
        inferred_kind, kind_source, resolver_version, confidence_class,
        evidence_hash, input_hash, effective_at, recorded_at, provenance)
     VALUES ('engine-v3-campaign-role-authority.v1', $1, $2, $3, $4::date,
             'main', 'system_inferred', $5, 'high',
             $6, $7, ($4 || 'T00:00:00.000Z')::timestamptz, now(),
             'system_inference')`,
    [BUSINESS, ACCOUNT, CBO_CAMPAIGN, AS_OF, CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      "a".repeat(64), "b".repeat(64)],
  );
  await getDb().query(
    `INSERT INTO engine_v3_campaign_context_daily
       (business_id, provider_account_id, campaign_id, campaign_name, as_of_date,
        inferred_kind, confidence_score, confidence_class, kind_source,
        kind_basis, resolver_version)
     VALUES ($1, $2, $3, 'Prospecting CBO II', $4::date, 'main', 0.95, 'high',
             'system_inferred', 'system_inference', $5)`,
    [BUSINESS, ACCOUNT, SWEEP_CAMPAIGN, AS_OF, CAMPAIGN_CONTEXT_RESOLVER_VERSION],
  );
  await getDb().query(
    `INSERT INTO engine_v3_campaign_role_authority
       (contract, business_id, provider_account_id, campaign_id, as_of_date,
        inferred_kind, kind_source, resolver_version, confidence_class,
        evidence_hash, input_hash, effective_at, recorded_at, provenance)
     VALUES ('engine-v3-campaign-role-authority.v1', $1, $2, $3, $4::date,
             'main', 'system_inferred', $5, 'high',
             $6, $7, ($4 || 'T00:00:00.000Z')::timestamptz, now(),
             'system_inference')`,
    [BUSINESS, ACCOUNT, SWEEP_CAMPAIGN, AS_OF, CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      "c".repeat(64), "d".repeat(64)],
  );
}

/**
 * The converter population, which is TWO facts in one set of rows.
 *
 * FIRST, the account calibration. `calibrationReady` —
 * `matureCreativeCount >= MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE` — is one of the
 * three conditions the canonical resolver requires before it will call `scale`
 * commercially eligible, and `mature_count` in `ACCOUNT_CALIBRATION_QUERY` is
 * the count of creatives with at least one purchase, positive revenue and
 * positive spend inside ninety days. An account with campaign and ad-set rows
 * but no creative rows has a mature count of zero, so its scale verdict is
 * withheld with `scale_calibration_below_floor` — a true answer about a fixture
 * that had never described the ad level at all.
 *
 * SECOND, and this is what the economics chain rests on, these are also the
 * only rows `computeMetaAttributedAov` reads: it sums `revenue` and
 * `conversions` over `meta_creative_daily` for this account, ninety days,
 * `objective = 'OUTCOME_SALES'`. One purchase apiece at
 * {@link CONVERTER_ORDER_VALUE} therefore makes Meta's attributed AOV exactly
 * 58.00 on a sample of {@link CONVERTER_CREATIVE_COUNT} purchases, and
 * 58.00 / 2.20 is the $26.36 benchmark every money figure below is measured
 * against.
 *
 * The count clears BOTH floors and is stated as such rather than as a literal:
 * `MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE` for the calibration, and
 * {@link META_AOV_READY_FLOOR} for a `ready` — and therefore hard-eligible —
 * attributed AOV. Two, so that neither floor is being cleared by exactly
 * nothing, and so the negative control at the end has somewhere to fall from.
 */
const CONVERTER_CREATIVE_COUNT = Math.max(
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
  META_AOV_READY_FLOOR,
) + 2;

/**
 * Write a slice of the converter population through the SHIPPED writer.
 *
 * The range is a parameter because the negative control at the end of this seam
 * re-observes part of the same population with no purchase on it — the way a
 * later sync would, rather than by deleting warehouse rows behind the writer's
 * back. Every other caller writes the whole set with its purchase intact.
 */
async function writeConverterCreatives(input: {
  from: number;
  to: number;
  revenue: number;
  conversions: number;
}) {
  const rows = [];
  for (let index = input.from; index < input.to; index += 1) {
    rows.push({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      accountTimezone: "UTC",
      accountCurrency: "USD",
      sourceSnapshotId: null,
      date: AS_OF,
      campaignId: CBO_CAMPAIGN,
      adsetId: CBO_ADSET,
      adId: `50000000003${String(index).padStart(2, "0")}`,
      creativeId: `50000000004${String(index).padStart(2, "0")}`,
      creativeName: `Converter ${index}`,
      headline: null,
      primaryText: null,
      destinationUrl: null,
      thumbnailUrl: null,
      assetType: "image",
      objective: "OUTCOME_SALES",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      effectiveStatus: "ACTIVE",
      ...metricRow({
        spend: 10,
        revenue: input.revenue,
        conversions: input.conversions,
        impressions: 400, clicks: 8, reach: 300,
      }),
    });
  }
  await upsertMetaCreativeDailyRows(rows);
}

async function seedCreativeFacts() {
  await writeConverterCreatives({
    from: 0,
    to: CONVERTER_CREATIVE_COUNT,
    revenue: CONVERTER_ORDER_VALUE,
    conversions: 1,
  });
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
      campaignId: SWEEP_CAMPAIGN,
      campaignNameCurrent: "Prospecting CBO II",
      campaignNameHistorical: "Prospecting CBO II",
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
    /*
      The sweep campaign's ad set, with steady delivery on every day.

      No impression collapse, so no `delivery_stall` anomaly and no cap intent:
      the bid arm still has exactly one candidate, and the second budget row
      this campaign exists for is the only thing it adds.
    */
    adsetRows.push({
      ...base,
      date,
      campaignId: SWEEP_CAMPAIGN,
      adsetId: SWEEP_ADSET,
      adsetNameCurrent: "Broad prospecting II",
      adsetNameHistorical: "Broad prospecting II",
      adsetStatus: "ACTIVE",
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
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      ...metricRow({
        spend: 80, revenue: 288, conversions: 3,
        impressions: 4000, clicks: 30, reach: 1000,
      }),
    });
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
 * The retained budget truth, through the REAL capture chain.
 *
 * `readMeasuredBudgetHistory` does not read `meta_entity_state_history` on its
 * own: it first attests a COMPLETE capture run from
 * `meta_entity_observation_receipts`, whose cohort has to name a real
 * `meta_sync_partitions` row and a real raw snapshot, and then requires the
 * present entity identities to be exactly the run's members. A fixture that
 * INSERTed state rows by hand satisfied none of that, so the history read
 * returned null and the composition refused with `change_history_unknown` —
 * a fact about the fixture rather than about the account.
 *
 * So every row below comes from the same writers the Meta sync uses: a queued
 * core-lane partition, a persisted raw snapshot of the provider's own payload
 * shape, the shipped observation mappers, and `persistMetaEntityObservation`.
 * The CBO ad set carries its parent's amount and owns none of it, which is what
 * makes its budget universe `proven_non_applicable` and keeps a budget intent
 * off it; an ad set that acquired one would suppress its own bid intent as a
 * sibling change in the same window.
 */
interface RawCampaignPayload {
  id: string; name: string; status: string; effective_status: string;
  daily_budget?: string; updated_time: string;
}
interface RawAdSetPayload {
  id: string; name: string; campaign_id: string; status: string;
  effective_status: string; daily_budget?: string; updated_time: string;
}

type ObservationCredentials =
  Parameters<typeof mapCampaignObservationState>[0]["credentials"];

async function seedBudgetState() {
  const observedAt = `${AS_OF}T03:00:00.000Z`;
  const capturedAt = `${AS_OF}T03:00:00.000Z`;
  const providerUpdatedAt = `${AS_OF}T02:00:00+0000`;

  const credentials = {
    businessId: BUSINESS,
    accessToken: "unused-by-the-mapper",
    accountIds: [ACCOUNT],
    accountProfiles: { [ACCOUNT]: { timezone: "UTC", currency: "USD" } },
  } as unknown as ObservationCredentials;

  const campaigns: RawCampaignPayload[] = [
    {
      id: CBO_CAMPAIGN, name: "Prospecting CBO", status: "ACTIVE",
      effective_status: "ACTIVE", daily_budget: "25000",
      updated_time: providerUpdatedAt,
    },
    {
      id: SWEEP_CAMPAIGN, name: "Prospecting CBO II", status: "ACTIVE",
      effective_status: "ACTIVE", daily_budget: "25000",
      updated_time: providerUpdatedAt,
    },
    {
      id: ABO_CAMPAIGN, name: "Retargeting ABO", status: "ACTIVE",
      effective_status: "ACTIVE", updated_time: providerUpdatedAt,
    },
  ];
  const adsets: RawAdSetPayload[] = [
    {
      id: CBO_ADSET, name: "Broad prospecting", campaign_id: CBO_CAMPAIGN,
      status: "ACTIVE", effective_status: "ACTIVE",
      updated_time: providerUpdatedAt,
    },
    {
      id: SWEEP_ADSET, name: "Broad prospecting II", campaign_id: SWEEP_CAMPAIGN,
      status: "ACTIVE", effective_status: "ACTIVE",
      updated_time: providerUpdatedAt,
    },
    {
      id: ABO_ADSET, name: "Retargeting 30d", campaign_id: ABO_CAMPAIGN,
      status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "25000",
      updated_time: providerUpdatedAt,
    },
  ];

  const partition = await queueMetaSyncPartition({
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    lane: "core" as never,
    scope: "account_daily" as never,
    partitionDate: AS_OF,
    status: "succeeded",
    priority: 0,
    source: "system",
    attemptCount: 1,
  });
  const partitionId = partition?.id ?? null;
  if (!partitionId) fail("partition_not_queued", "the partition queue returned no row");

  const snapshotFor = async (endpointName: string, entityScope: string, payload: unknown) => {
    const id = await persistMetaRawSnapshot({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      partitionId: partitionId!,
      endpointName,
      entityScope,
      startDate: AS_OF,
      endDate: AS_OF,
      accountTimezone: "UTC",
      accountCurrency: "USD",
      payloadJson: payload,
      payloadHash: buildMetaRawSnapshotHash({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        endpointName,
        startDate: AS_OF,
        endDate: AS_OF,
        payload,
      }),
      requestContext: { source: LABEL },
      providerHttpStatus: 200,
      status: "fetched",
    });
    if (!id) fail("raw_snapshot_absent", endpointName);
    return id!;
  };
  const campaignSnapshot = await snapshotFor("campaign_configs", "campaign", campaigns);
  const adsetSnapshot = await snapshotFor("adset_configs", "adset", adsets);

  const campaignStates = campaigns
    .map((row) => mapCampaignObservationState({
      credentials, accountId: ACCOUNT, row: row as never,
      responseObservedAt: observedAt, capturedAt,
    }).state)
    .filter((state): state is NonNullable<typeof state> => state !== null);
  const adsetStates = adsets
    .map((row) => mapAdSetObservationState({
      credentials, accountId: ACCOUNT, row: row as never,
      responseObservedAt: observedAt, capturedAt,
    }).state)
    .filter((state): state is NonNullable<typeof state> => state !== null);

  await persistMetaEntityObservation({
    businessId: BUSINESS, providerAccountId: ACCOUNT, entityType: "campaign",
    endpoint: "campaign_configs", observedAt, capturedAt,
    completeness: "complete", pageCount: 1,
    providerRowCount: campaignStates.length, states: campaignStates,
    sourceSnapshotId: campaignSnapshot, error: null,
    captureReceipt: {
      partitionId: partitionId!,
      sourceSnapshotId: campaignSnapshot,
      sourceSnapshotRefId: campaignSnapshot,
    },
  });
  await persistMetaEntityObservation({
    businessId: BUSINESS, providerAccountId: ACCOUNT, entityType: "adset",
    endpoint: "adset_configs", observedAt, capturedAt,
    completeness: "complete", pageCount: 1,
    providerRowCount: adsetStates.length, states: adsetStates,
    sourceSnapshotId: adsetSnapshot, error: null,
    captureReceipt: {
      partitionId: partitionId!,
      sourceSnapshotId: adsetSnapshot,
      sourceSnapshotRefId: adsetSnapshot,
    },
  });
  // No `meta_budget_write_journal` rows: this product has never changed these
  // budgets, which is a real observation and not an unreadable one.
}

/**
 * The account-scope fixture: one business, three ad accounts, no store.
 *
 * ROAS is the only commercial target, exactly as the chain business has it, so
 * the ONLY remaining source of a money-per-purchase unit is Meta's own
 * attributed average order value — which is measured, per account, and is the
 * rung the borrow used to happen on. With no Shopify store bound to this
 * business, an account with no purchases of its own has no anchor at all, and
 * whether it gets one is a direct statement about scope.
 */
async function seedAccountScopeAccount(account: string) {
  const sql = getDb();
  const rows = (await sql.query(
    `INSERT INTO provider_accounts
       (provider, external_account_id, account_name, currency, timezone)
     VALUES ('meta', $1, $1, 'USD', 'UTC')
     ON CONFLICT (provider, external_account_id)
     DO UPDATE SET currency = EXCLUDED.currency
     RETURNING id::text AS id`,
    [account],
  )) as Array<{ id: string }>;
  await sql.query(
    `INSERT INTO business_provider_accounts
       (business_id, provider, provider_account_ref_id, provider_account_id,
        position, is_selected)
     VALUES ($1, 'meta', $2::uuid, $3, 0, TRUE)
     ON CONFLICT (business_id, provider, provider_account_ref_id)
     DO UPDATE SET is_selected = TRUE`,
    [SCOPE_BUSINESS, rows[0]!.id, account],
  );
}

/** Converter creatives for one account, through the production writer. */
async function seedAccountScopeCreatives(input: {
  account: string;
  count: number;
  offset: number;
  spend: number;
  revenue: number;
}) {
  const digits = input.account.replace(/\D/g, "");
  const rows = [];
  for (let index = 0; index < input.count; index += 1) {
    const ordinal = input.offset + index;
    rows.push({
      businessId: SCOPE_BUSINESS,
      providerAccountId: input.account,
      accountTimezone: "UTC",
      accountCurrency: "USD",
      sourceSnapshotId: null,
      date: AS_OF,
      campaignId: `${digits}01`,
      adsetId: `${digits}02`,
      adId: `${digits}3${String(ordinal).padStart(3, "0")}`,
      creativeId: `${digits}4${String(ordinal).padStart(3, "0")}`,
      creativeName: `Converter ${ordinal}`,
      headline: null,
      primaryText: null,
      destinationUrl: null,
      thumbnailUrl: null,
      assetType: "image",
      objective: "OUTCOME_SALES",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      effectiveStatus: "ACTIVE",
      ...metricRow({
        spend: input.spend, revenue: input.revenue, conversions: 1,
        impressions: 400, clicks: 8, reach: 300,
      }),
    });
  }
  await upsertMetaCreativeDailyRows(rows);
}

/** The retained verdict for one account, read straight back out. */
async function readAccountScopeVerdicts(account: string) {
  return (await getDb().query(
    `SELECT action, eligible, blocker_code, spend_unit::text AS spend_unit,
            input_fingerprint, source_fingerprint
       FROM engine_v3_account_profile_output
      WHERE business_id = $1 AND provider_account_id = $2
      ORDER BY action`,
    [SCOPE_BUSINESS, account],
  )) as Array<{
    action: string;
    eligible: boolean;
    blocker_code: string | null;
    spend_unit: string | null;
    input_fingerprint: string;
    source_fingerprint: string;
  }>;
}

function renderVerdict(row: {
  action: string;
  eligible: boolean;
  blocker_code: string | null;
  spend_unit: string | null;
  input_fingerprint: string;
  source_fingerprint: string;
}) {
  return `${row.action} eligible=${row.eligible} blocker=${row.blocker_code}`
    + ` spendUnit=${row.spend_unit} input=${row.input_fingerprint}`
    + ` source=${row.source_fingerprint}`;
}

/**
 * ONE ACCOUNT'S VERDICT IS ITS OWN, AND IT IS THE DAY'S.
 *
 * The retained row is keyed on `(business_id, provider_account_id, action)` and
 * its two fingerprints are the identity every later reader re-derives and
 * compares against — so what those fingerprints are computed FROM decides
 * whether a mid-day target change moves the verdict, whether an unrelated
 * account can move it, and whether an ordinary sync write can. The producer
 * read the account calibration, the funnel calibration and the live
 * Meta-attributed AOV at the warehouse default, which is the whole BUSINESS:
 * `getAccountCalibration({businessId, asOf})` read the `scope_id '*'` row and
 * fell back to a runtime aggregate over every account the business owns.
 *
 * Two things followed, and both are asserted here. A's verdict moved when a
 * sibling account's samples moved, so a commercial decision about A could flip
 * because of an account nobody was looking at. And an account with no measured
 * evidence at all was handed its siblings' — the opposite of "enough evidence
 * gives a decision, otherwise a named hold".
 *
 * NAMING THE ACCOUNT ON THOSE READS IS ONLY HALF OF IT, and the second half is
 * asserted here too. A scoped read finds nothing unless the calibration pass
 * has materialised that account's own scope, and "nothing" is answered as an
 * empty funnel pack and a live aggregate — a measurement that never happened
 * and a number that moves under the next sync write. So this phase runs the
 * shipped calibration job, requires the scoped reads to land on rows it wrote
 * for that account alone, requires the day's identity to survive one more
 * synced ad row and to move on the next pass, and requires an account the pass
 * has not covered to be refused with the reason in the name.
 */
async function assertAccountScopeIsolation() {
  const sql = getDb();
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, timezone, currency, is_demo_business)
     VALUES ($1::uuid, 'Account scope seam', $2::uuid, 'UTC', 'USD', FALSE)
     ON CONFLICT (id) DO NOTHING`,
    [SCOPE_BUSINESS, OWNER],
  );
  await sql.query(
    `INSERT INTO memberships (user_id, business_id, role, status)
     VALUES ($1::uuid, $2::uuid, 'admin', 'active')
     ON CONFLICT DO NOTHING`,
    [OWNER, SCOPE_BUSINESS],
  );
  // ROAS only, the same binding rule the chain business is seeded under.
  await sql.query(
    `INSERT INTO business_target_pack_history
       (business_id, target_roas, break_even_roas, target_cpa, break_even_cpa,
        aov_assumption, default_risk_posture, operation, effective_at, recorded_at)
     VALUES ($1::uuid, 2.20, 1.80, NULL, NULL, NULL, 'balanced', 'upsert',
             $2::timestamptz, $2::timestamptz)`,
    [SCOPE_BUSINESS, `${AS_OF}T00:00:00.000Z`],
  );
  for (const account of [SCOPE_ACCOUNT_A, SCOPE_ACCOUNT_B, SCOPE_ACCOUNT_C]) {
    await seedAccountScopeAccount(account);
  }
  /*
    Genuinely different measured facts, and a third account with none.

    A: thirty-two converters at $36.00 each — over the scale calibration floor,
    so A is an account that CAN be commercially eligible.
    B: six converters at $12.00 — a materially different average order value in
    the same window, so pooling the two produces a number that is neither.
    C: nothing at all.
  */
  await seedAccountScopeCreatives({
    account: SCOPE_ACCOUNT_A, count: 32, offset: 0, spend: 10, revenue: 36,
  });
  await seedAccountScopeCreatives({
    account: SCOPE_ACCOUNT_B, count: 6, offset: 0, spend: 10, revenue: 12,
  });

  /*
    ONE SCOPE PER SELECTED ACCOUNT, WRITTEN BY THE SHIPPED JOB.

    Before the job wrote them there was nothing at these scope ids at all, and
    the scoped readers said so in the two ways that are indistinguishable from a
    measurement: the funnel pack came back with no formats in it and the
    kind-segmented calibration came back null, on EVERY account, for ever. The
    pooled `'*'` row is written by the same pass and is untouched, so nothing
    here is planted at two scopes to make a scoped read look answered.
  */
  const scopeRows = await materialiseCalibrationScopes(SCOPE_BUSINESS);
  expectEqual(
    scopeRows
      .filter((row) => row.scope_type === "account")
      .map((row) => row.scope_id)
      .sort(),
    ["*", SCOPE_ACCOUNT_A, SCOPE_ACCOUNT_B, SCOPE_ACCOUNT_C].sort(),
    "every selected account has a calibration scope of its own, beside the pooled one",
  );

  /*
    AND THE SCOPED READS FIND THEM, WITH DIFFERENT NUMBERS IN EACH.

    Through the shipped `WarehouseDataSource`, on the same readers the producer
    uses. A's own converter count, B's own converter count and the pooled count
    are three different numbers here — 32, 6 and 38 — so a read that had
    silently answered with the pooled row could not pass this, and neither could
    one that answered `null` because nothing had been materialised.
  */
  const warehouse = new WarehouseDataSource();
  const measured = async (account: string | null) => {
    const scoped = account === null ? {} : { providerAccountId: account };
    const kind = await warehouse.getAccountCalibrationByKind({
      businessId: SCOPE_BUSINESS, asOf: AS_OF, campaignKind: "all", ...scoped,
    });
    const funnel = await warehouse.getAccountFunnelCalibration({
      businessId: SCOPE_BUSINESS, asOf: AS_OF, ...scoped,
    });
    return {
      matureCreativeCount: kind?.matureCreativeCount ?? null,
      funnelFormats: Object.keys(funnel.byFormat).length,
    };
  };
  const pooled = await measured(null);
  const measuredA = await measured(SCOPE_ACCOUNT_A);
  const measuredB = await measured(SCOPE_ACCOUNT_B);
  console.log(
    `[${LABEL}] measured evidence: pooled=${JSON.stringify(pooled)}`
    + ` A=${JSON.stringify(measuredA)} B=${JSON.stringify(measuredB)}`,
  );
  expectEqual(
    [pooled.matureCreativeCount, measuredA.matureCreativeCount, measuredB.matureCreativeCount],
    [38, 32, 6],
    "each scope carries its own converters, and the pooled one carries both",
  );
  expectEqual(
    [pooled.funnelFormats, measuredA.funnelFormats, measuredB.funnelFormats],
    [5, 5, 5],
    "and a scoped funnel read returns this account's own per-format baselines",
  );

  for (const account of [SCOPE_ACCOUNT_A, SCOPE_ACCOUNT_B, SCOPE_ACCOUNT_C]) {
    await produceRetainedAccountProfileOutputs({
      businessId: SCOPE_BUSINESS, providerAccountId: account, asOfDate: AS_OF,
    });
  }

  const before = await readAccountScopeVerdicts(SCOPE_ACCOUNT_A);
  expectEqual(
    before.map((row) => row.action), ["cut", "refresh", "scale"],
    "account A retained one verdict per canonical action",
  );
  console.log(`[${LABEL}] account A before: ${before.map(renderVerdict).join(" | ")}`);
  /*
    A's OWN average order value over the target ROAS: 36.00 / 2.20.

    The business-wide reading of the same fixture is 32.21 / 2.20 = 14.64 —
    thirty-two creatives at 36.00 pooled with six at 12.00 — which is a number
    that describes neither account and is what this row used to carry.
  */
  expectEqual(
    Math.round(Number(before[0]!.spend_unit) * 100) / 100, 16.36,
    "account A's spend unit is account A's own evidence",
  );
  expectEqual(
    before.find((row) => row.action === "scale")!.eligible, true,
    "account A clears the scale calibration floor on its own creatives",
  );

  /*
    THE ACCOUNT WITH NO EVIDENCE OF ITS OWN.

    Business-wide, C inherited A and B's pooled calibration whole: a spend unit
    of 14.64, a mature creative count over the floor, and `eligible = true` on
    every action for an account that has never run an ad. Scoped, it has no
    anchor, and the resolver's own canonical code says so.
  */
  const scopeC = await readAccountScopeVerdicts(SCOPE_ACCOUNT_C);
  console.log(`[${LABEL}] account C: ${scopeC.map(renderVerdict).join(" | ")}`);
  expectEqual(
    scopeC.map((row) => `${row.action}:${row.eligible}:${row.blocker_code}`),
    [
      "cut:false:commercial_anchor_missing",
      "refresh:false:commercial_anchor_missing",
      "scale:false:commercial_anchor_missing",
    ],
    "an account with no measured evidence holds by name instead of inheriting",
  );
  expectEqual(
    scopeC.every((row) => row.spend_unit === null), true,
    "and it is handed no spend unit at all",
  );

  /*
    CHANGE ONLY B, AND RE-RUN THE WHOLE CALIBRATION PASS.

    Forty more converters at $200.00 — an average order value an order of
    magnitude away from anything A has. Business-wide this moves the pooled
    number from 32.21 to 118.26, which moved A's spend unit to 53.75, changed
    A's source fingerprint, and retained a SECOND set of rows for A that the
    reader's re-derived expectation then pointed at. Nothing about A changed.

    The job is re-run deliberately rather than skipped. Every scope is
    recomputed from the moved warehouse: the pooled one and B's move, and A's
    is recomputed from A's own unchanged rows and lands on the same numbers. If
    A's verdict were still reading the pooled scope, a stale precomputed row
    would hide it — re-running removes that excuse.
  */
  await seedAccountScopeCreatives({
    account: SCOPE_ACCOUNT_B, count: 40, offset: 100, spend: 10, revenue: 200,
  });
  await materialiseCalibrationScopes(SCOPE_BUSINESS);
  const pooledAfter = await measured(null);
  const measuredAafter = await measured(SCOPE_ACCOUNT_A);
  expectEqual(
    pooledAfter.matureCreativeCount, 78,
    "the pooled scope moved with B, which is what a business-wide reader would have read",
  );
  expectEqual(
    measuredAafter.matureCreativeCount, 32,
    "and A's own scope did not move at all",
  );
  await produceRetainedAccountProfileOutputs({
    businessId: SCOPE_BUSINESS, providerAccountId: SCOPE_ACCOUNT_A, asOfDate: AS_OF,
  });

  const after = await readAccountScopeVerdicts(SCOPE_ACCOUNT_A);
  console.log(`[${LABEL}] account A after B moved: ${after.map(renderVerdict).join(" | ")}`);
  // Byte-identical, field by field, and no second identity beside it.
  expectEqual(after.map(renderVerdict), before.map(renderVerdict),
    "changing another account changes nothing about this account's verdict");
  expectEqual(after.length, 3,
    "and produces no second retained identity for it");

  /*
    B's own verdict DID move, which is what makes the assertion above a scope
    claim rather than a claim that the producer ignores new evidence.
  */
  await produceRetainedAccountProfileOutputs({
    businessId: SCOPE_BUSINESS, providerAccountId: SCOPE_ACCOUNT_B, asOfDate: AS_OF,
  });
  const scopeB = await readAccountScopeVerdicts(SCOPE_ACCOUNT_B);
  if (scopeB.length !== 6) {
    fail(
      "account_b_verdict_did_not_move",
      `expected B to retain a second identity after its own evidence moved, got ${scopeB.length} rows`,
    );
  }

  /*
    The reader's expectation, re-derived with the retained table untouched. It
    is what `classifyRetainedProfile` compares A's row against, so if it drifted
    with B the row would be refused as superseded and A's budget path would go
    quiet for a reason that has nothing to do with A.
  */
  const identityA = await readAccountProfileRetentionIdentity({
    businessId: SCOPE_BUSINESS, providerAccountId: SCOPE_ACCOUNT_A, asOfDate: AS_OF,
  });
  if (!identityA) fail("account_scope_identity_unreadable", SCOPE_ACCOUNT_A);
  expectEqual(
    identityA!.inputFingerprint, before[0]!.input_fingerprint,
    "A's re-derived configured identity still names A's retained row",
  );
  expectEqual(
    identityA!.sourceFingerprint, before[0]!.source_fingerprint,
    "and its measured identity did not move with a sibling account",
  );

  /*
    AND THE IDENTITY DOES NOT MOVE WHEN THIS ACCOUNT'S OWN SYNC WRITES A ROW.

    This is the second half of "a verdict is retained for a DAY". The measured
    reads used to be answered by a live aggregate over `meta_creative_daily`,
    because no scope existed for this account to read: one ordinary warehouse
    write through the shipped writer then moved `source_fingerprint`,
    `classifyRetainedProfile` answered `retained_profile_source_mismatch`, and
    the budget path withheld at approval a verdict it had projected minutes
    earlier — for a change in the account's own sync, not in its commercial
    truth. The scoped read now lands on the day's retained row and is as fixed
    as the pooled read has always been.
  */
  await seedAccountScopeCreatives({
    account: SCOPE_ACCOUNT_A, count: 1, offset: 900, spend: 10, revenue: 36,
  });
  const identityAfterSync = await readAccountProfileRetentionIdentity({
    businessId: SCOPE_BUSINESS, providerAccountId: SCOPE_ACCOUNT_A, asOfDate: AS_OF,
  });
  console.log(
    `[${LABEL}] account A identity after one synced ad row: `
    + `${identityAfterSync?.sourceFingerprint.slice(0, 8)} `
    + `(was ${identityA!.sourceFingerprint.slice(0, 8)})`,
  );
  expectEqual(
    identityAfterSync?.sourceFingerprint, identityA!.sourceFingerprint,
    "one more synced ad row does not move the day's measured identity",
  );
  await produceRetainedAccountProfileOutputs({
    businessId: SCOPE_BUSINESS, providerAccountId: SCOPE_ACCOUNT_A, asOfDate: AS_OF,
  });
  expectEqual(
    (await readAccountScopeVerdicts(SCOPE_ACCOUNT_A)).length, 3,
    "and retains no second identity for the same day",
  );

  /*
    FIXED FOR THE DAY IS NOT DEAF.

    The next calibration pass re-measures the account and the identity moves,
    which is the whole point of retaining a verdict per set of inputs: the new
    reading is a new verdict, and the old row stops being the one a reader
    agrees with.
  */
  await materialiseCalibrationScopes(SCOPE_BUSINESS);
  const identityRecalibrated = await readAccountProfileRetentionIdentity({
    businessId: SCOPE_BUSINESS, providerAccountId: SCOPE_ACCOUNT_A, asOfDate: AS_OF,
  });
  if (identityRecalibrated?.sourceFingerprint === identityA!.sourceFingerprint) {
    fail(
      "identity_ignored_recalibration",
      "A's measured identity did not move after its own evidence was re-measured",
    );
  }

  /*
    AN ACCOUNT THE CALIBRATION PASS HAS NOT COVERED HOLDS BY NAME.

    Accounts get assigned between calibration passes, and this is that moment.
    The scoped readers still ANSWER for such an account — an empty funnel pack
    and a live aggregate — and both are unusable as an identity: the first is
    indistinguishable from a genuinely empty account, the second moves under the
    next sync write. Retaining a verdict on them is how a fully evidenced
    account ends up withheld at approval for a reason that has nothing to do
    with its evidence, so the producer refuses with the reason in the name and
    the reader offers no expectation to compare against.
  */
  await seedAccountScopeAccount(SCOPE_ACCOUNT_D);
  const uncovered = await produceRetainedAccountProfileOutputs({
    businessId: SCOPE_BUSINESS, providerAccountId: SCOPE_ACCOUNT_D, asOfDate: AS_OF,
  });
  console.log(
    `[${LABEL}] account D before any calibration pass: produced=${uncovered.produced} `
    + `refusals=${JSON.stringify(Object.keys(uncovered.refusals))}`,
  );
  expectEqual(
    Object.keys(uncovered.refusals), ["account_calibration_scope_not_materialised"],
    "an uncovered account is refused by name, not by silence",
  );
  expectEqual(uncovered.retained, [], "and nothing is retained for it");
  expectEqual(
    (await readAccountScopeVerdicts(SCOPE_ACCOUNT_D)).length, 0,
    "so the table carries no verdict for an account nobody has measured",
  );
  expectEqual(
    await readAccountProfileRetentionIdentity({
      businessId: SCOPE_BUSINESS, providerAccountId: SCOPE_ACCOUNT_D, asOfDate: AS_OF,
    }),
    null,
    "and a reader is offered no expectation to check a verdict against",
  );

  /*
    And the hold lifts the moment the pass covers it — a hold, not a wall. D has
    no evidence of its own, so what it then retains is the resolver's own
    `commercial_anchor_missing`, exactly like C, rather than a sibling's anchor.
  */
  await materialiseCalibrationScopes(SCOPE_BUSINESS);
  const covered = await produceRetainedAccountProfileOutputs({
    businessId: SCOPE_BUSINESS, providerAccountId: SCOPE_ACCOUNT_D, asOfDate: AS_OF,
  });
  expectEqual(covered.refusals, {}, "the named hold lifts once the account is measured");
  expectEqual(
    (await readAccountScopeVerdicts(SCOPE_ACCOUNT_D))
      .map((row) => `${row.action}:${row.eligible}:${row.blocker_code}`),
    [
      "cut:false:commercial_anchor_missing",
      "refresh:false:commercial_anchor_missing",
      "scale:false:commercial_anchor_missing",
    ],
    "and an account measured as empty holds with the resolver's own code",
  );
}

/**
 * The calibration scopes for one business, written by the SHIPPED job.
 *
 * `lib/creative-decision-engine/jobs/calibration-job.ts` is the only writer of
 * `engine_v3_account_calibration_daily`, and this seam runs it rather than
 * planting rows, so what the readers below find is exactly what production
 * finds. It writes the pooled `('account', '*')` scope, one
 * `('account', <provider account id>)` scope per SELECTED Meta account computed
 * from that account's own rows, and one `('campaign', <id>)` scope per eligible
 * campaign.
 *
 * NOTHING IN THIS SEAM EVER WRITES A CALIBRATION ROW AT TWO SCOPES. That is the
 * shape a per-account read can be made to pass under while finding nothing in
 * the real world, so every scoped read asserted here is answered by a row this
 * job computed for that scope alone.
 */
async function materialiseCalibrationScopes(businessId: string) {
  const job = await runCalibrationJob({ businessId, asOf: AS_OF });
  if (job.status !== "success") {
    fail("calibration_job_failed", `${businessId}: ${job.status} ${job.errorMessage ?? ""}`);
  }
  const rows = (await getDb().query(
    `SELECT scope_type, scope_id, COUNT(*)::int AS rows
       FROM engine_v3_account_calibration_daily
      WHERE business_ref_id = $1::uuid
      GROUP BY scope_type, scope_id
      ORDER BY scope_type, scope_id`,
    [businessId],
  )) as Array<{ scope_type: string; scope_id: string; rows: number }>;
  console.log(
    `[${LABEL}] calibration scopes for ${businessId}: `
    + rows.map((row) => `${row.scope_type}/${row.scope_id}=${row.rows}`).join(" "),
  );
  return rows;
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

/**
 * The Meta connection, seeded ONLY for the execution phase.
 *
 * `buildMetaBudgetWriteContextForProposal` needs a connected integration, its
 * generation, and an account profile carrying the account's own currency. Until
 * this row exists the projection cannot take a baseline at all, which is what
 * the first phase of this seam shows: the candidate is admitted, composed, and
 * refused by name with `provider_baseline_unavailable`, having contacted
 * nothing.
 */
async function seedMetaConnection() {
  const sql = getDb();
  const rows = (await sql.query(
    `INSERT INTO provider_connections
       (business_id, provider, status, provider_account_id,
        provider_account_name, connected_at)
     VALUES ($1, 'meta', 'connected', $2, 'Economics seam account', now())
     RETURNING id::text AS id`,
    [BUSINESS, ACCOUNT],
  )) as Array<{ id: string }>;
  await sql.query(
    `INSERT INTO integration_credentials (provider_connection_id, access_token)
     VALUES ($1::uuid, 'economics-seam-meta-token')`,
    [rows[0]!.id],
  );
  // The cached "not connected" answer from the first phase would otherwise
  // outlive the connection it describes.
  clearServerCache();
}

/**
 * The MANUAL approval path, assembled exactly as the approval route assembles
 * it: the same claim, the same readers, the same runtime, the same shared
 * lifecycle, and the same settle/reconcile/marker dependencies.
 */
async function approveManually(proposalId: string) {
  const claim = await claimMetaAutomationProposal({
    businessId: BUSINESS, providerAccountId: ACCOUNT, proposalId,
    claimedBy: OWNER,
  });
  if (claim.status !== "claimed") {
    fail("manual_claim_refused", `claim status ${claim.status}`);
  }
  const claimed = claim as Extract<typeof claim, { status: "claimed" }>;
  const runtime = createBudgetProposalServerRuntime(
    createBudgetServerReaders({
      businessId: BUSINESS,
      actorUserId: OWNER,
      writeContext: await buildMetaBudgetWriteContextForProposal({
        businessId: BUSINESS, providerAccountId: ACCOUNT,
      }),
    }),
  );
  return runClaimedProposalExecution({
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    proposal: claimed.proposal,
    claimToken: claimed.claimToken,
    actorUserId: OWNER,
    executionKind: "manual",
    markDispatchStarted: async (marked) =>
      Boolean(await markMetaAutomationProposalDispatchStarted({
        businessId: marked.businessId,
        proposalId: marked.proposalId,
        claimToken: marked.claimToken,
      }).catch(() => null)),
    settle: async (settleInput) => settleMetaAutomationProposal({
      businessId: settleInput.businessId,
      proposalId: settleInput.proposalId,
      status: settleInput.status,
      decidedBy: settleInput.decidedBy,
      decisionNote: null,
      receipt: settleInput.receipt,
      claimToken: settleInput.claimToken,
    }),
    forceReconcile: (reconcileInput) =>
      forceMetaAutomationProposalReconcile(reconcileInput),
    recordReconciliation: async ({ proposal, claimToken, receipt }) => {
      const recorded = await appendMetaAutomationReconciliationReceipt({
        businessId: proposal.businessId,
        proposalId: proposal.id,
        providerAccountId: proposal.providerAccountId,
        decisionKey: proposal.decisionKey,
        proposedAction: proposal.proposedAction,
        claimToken,
        reason: "settle_failed_after_dispatch",
        facts: providerDispatchFacts({
          dispatchStarted: true, outcomeKnown: false, ok: false,
          dryRun: receipt.dryRun === true,
        }),
        receipt,
      });
      return recorded.status !== "unavailable";
    },
    recordLedger: async () => {},
    execute: async (beforeProviderPost) => runtime({
      proposal: claimed.proposal,
      dryRunOnly: false,
      claimToken: claimed.claimToken,
      authorization: {
        kind: "manual", explicitConfirmation: true, operatorUserId: OWNER,
      },
      beforeProviderPost,
    }),
  });
}

/** The durable journal receipt for one entity, read straight back out. */
async function readJournalReceipts(entityId: string) {
  return (await getDb().query(
    `SELECT entity_id, result_class, before_amount_minor,
            intended_amount_minor, readback_amount_minor, currency,
            provider_attempted, provider_http_status
       FROM meta_budget_write_journal
      WHERE business_id = $1 AND provider_account_id = $2 AND entity_id = $3
      ORDER BY requested_at`,
    [BUSINESS, ACCOUNT, entityId],
  )) as Array<Record<string, unknown>>;
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

  /*
    Both entities the double will be asked about, with the amount the account
    actually holds. It is the double's STATE: a POST changes it, so the
    executor's pre-POST compare-and-set and its post-write read-back are
    answered by a provider that moved rather than by an echo.
  */
  const providerBudgets = new Map<string, number>([
    [CBO_CAMPAIGN, 25_000],
    [SWEEP_CAMPAIGN, 25_000],
  ]);
  // Installed BEFORE the first production call, so a request during seeding is
  // caught too. It refuses everything until the execution phase.
  const provider = installProviderDouble(providerBudgets);

  await seedIdentity();
  await seedCommercialTargets();
  await seedShopifyStore(new Date().toISOString());
  await seedAutomationControls();
  await seedCampaignRole();
  await seedWarehouseFacts();
  await seedCreativeFacts();
  await publishSlices();
  await seedBudgetState();

  /*
    THE DAILY CALIBRATION PASS, BEFORE ANYTHING READS A CALIBRATION.

    The retained commercial verdict is stamped with a digest of the measured
    facts it was computed from, and a later reader re-derives that digest to
    decide whether the verdict still describes the account. That only works if
    the measured read is FIXED for the day: without this job the account-scoped
    read falls through to a live aggregate over `meta_creative_daily`, and one
    ordinary sync write then moves the digest and withholds a verdict that had
    nothing wrong with it. So the job runs here, exactly as a daily pass would,
    and the numbers below are asserted against what it wrote.
  */
  const chainScopes = await materialiseCalibrationScopes(BUSINESS);
  expectEqual(
    chainScopes
      .filter((row) => row.scope_type === "account")
      .map((row) => row.scope_id)
      .sort(),
    ["*", ACCOUNT].sort(),
    "the job materialised this account's own scope beside the pooled one",
  );

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
  expectEqual(
    budgetCandidates.map((candidate) => candidate.scopeId).sort(),
    [CBO_CAMPAIGN, SWEEP_CAMPAIGN].sort(),
    "one typed budget candidate per role-authorised budget owner",
  );
  const budgetCandidate = budgetCandidates
    .find((candidate) => candidate.scopeId === CBO_CAMPAIGN)!;
  expectEqual(budgetCandidate.scopeType, "campaign", "candidate grain");
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

  /*
    THE ARITHMETIC, STATED ONCE AND NOWHERE COMPUTED.

    THE BENCHMARK. Meta attributed 32 purchases and $1,856 of purchase revenue
    to this account over the ninety-day window — an AOV of $58.00 on a sample
    two above `META_AOV_READY_FLOOR`, so `classifyMetaAovQuality` says `ready`
    and `resolveSpendUnit` marks the unit hard-eligible. 58.00 / 2.20 = $26.36,
    or 2636 minor units. Not the store: the merchant's own books say $36.00 in
    the same window, and $36.00 / 2.20 = $16.36 would put this ad set on the
    other side of the dead band entirely.

    THE RATIO. The ad set's own twenty-eight days are $2,200 over 100
    purchases — $22.00, or 2200 minor units, and both operands are on the
    account's own scale because `projectBidIntents` resolves the ISO exponent
    once and hands it to the policy. q = 2200 / 2636 = 0.83.

    THE RUNG. 0.83 is under `deadBand.min`, which only authorises a raise when
    delivery is measurably constrained — and the `delivery_stall` row asserted
    just above is that evidence. `raiseBands` puts 0.83 on the 0.9 rung at 10%,
    and 1200 * 1.10 = 1320.

    Every figure here is a fixture input or a published band of
    `BID_SIZING_POLICY_V1`. What follows reads the producer's own answer.
  */
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

  // ── Chain A's terminal step, with the provider still unreachable ─────────
  /*
    The RETAINED COMMERCIAL VERDICT, produced by the shipped producer.

    `D086_PROFILE_LATEST_SQL` reads `engine_v3_account_profile_output`. That
    table had no migration and no writer, so the statement raised 42P01, the
    loader read the error as unknown, and every candidate was refused with
    `composition_sources_unavailable` — the whole budget arm inert. The table is
    now created by `lib/migrations.ts` and
    `lib/meta/account-profile-output-producer.ts` resolves the canonical
    `AccountDecisionProfile` from this account's own retained facts and retains
    what it says. Nothing below inserts a profile row.

    The production loader is used UNWRAPPED on purpose. Substituting a
    seam-owned `loadCompositionSources` would replace the only thing this step
    can prove with the seam's own opinion.
  */
  const projectBudgetProposals = () => projectMetaBudgetProposals({
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

  const withoutConnection = await projectBudgetProposals();
  expectEqual(withoutConnection.candidates, 2, "both budget candidates are admitted");
  expectEqual(withoutConnection.projected, 0, "and neither raises a row yet");
  /*
    ONE blocker, and it is the provider one. The commercial verdict, the role
    authority, the canonical fact and the measured history are all satisfied
    from retained evidence; what is missing is the account's own current amount,
    and this seam has deliberately not connected Meta yet.
  */
  expectEqual(
    withoutConnection.refusals,
    { provider_baseline_unavailable: 2 },
    "refused by name, not by silence",
  );
  expectEqual(provider.calls, [], "and still no provider request left the process");

  const retained = (await getDb().query(
    `SELECT action, contract, profile_contract, engine_epoch, engine_version,
            eligible, blocker_code, anchor_source, spend_unit,
            input_fingerprint, source_fingerprint, as_of_date::text AS as_of_date
       FROM engine_v3_account_profile_output
      WHERE business_id = $1 AND provider_account_id = $2
      ORDER BY action`,
    [BUSINESS, ACCOUNT],
  )) as Array<Record<string, unknown>>;
  expectEqual(
    retained.map((row) => row.action),
    ["cut", "refresh", "scale"],
    "the producer retained one verdict per canonical action",
  );
  const scaleVerdict = retained.find((row) => row.action === "scale")!;
  expectEqual(scaleVerdict.eligible, true, "the account may scale");
  expectEqual(scaleVerdict.blocker_code, null, "an eligible verdict carries no code");
  expectEqual(scaleVerdict.as_of_date, AS_OF, "the day the verdict speaks for");
  /*
    26.36 again, and from the same place: Meta's own $58.00 attributed purchase
    AOV over the 2.20 target ROAS. The retained verdict and the sized intent
    rest on ONE commercial anchor, not on two that happen to agree — and they
    reach it by two different routes, the producer through this account's
    precomputed calibration cell and the snapshot through a live
    `computeMetaAttributedAov` read, which is why agreeing here is worth
    asserting. The store's own books say $36.00 and appear in neither number.
  */
  expectEqual(
    Math.round(Number(scaleVerdict.spend_unit) * 100) / 100,
    26.36,
    "the retained spend unit is Meta's attributed AOV over the target ROAS",
  );
  /*
    The expectation a reader re-derives, with the retained table untouched. It
    is what `classifyRetainedProfile` compares the row against, so it is what
    makes a verdict computed from superseded commercial truth unusable.
  */
  const identity = await readAccountProfileRetentionIdentity({
    businessId: BUSINESS, providerAccountId: ACCOUNT, asOfDate: AS_OF,
  });
  if (!identity) fail("retention_identity_unreadable", "the reader offered no expectation");
  expectEqual(
    scaleVerdict.input_fingerprint, identity!.inputFingerprint,
    "the retained verdict names the configured inputs a reader re-derives",
  );
  expectEqual(
    scaleVerdict.source_fingerprint, identity!.sourceFingerprint,
    "and the measured ones",
  );

  // ── One account's verdict is its own ─────────────────────────────────────
  const beforeAccountScope = provider.calls.length;
  await assertAccountScopeIsolation();
  expectEqual(
    provider.since(beforeAccountScope), [],
    "the account-scope phase reached the provider not at all",
  );

  // ── The connection, and the projected queue rows ─────────────────────────
  await seedMetaConnection();
  provider.serve();
  const beforeProjectionCalls = provider.calls.length;
  const projectedRun = await projectBudgetProposals();
  expectEqual(projectedRun.candidates, 2, "the same two candidates");
  expectEqual(projectedRun.refusals, {}, "and nothing is refused");
  expectEqual(projectedRun.projected, 2, "both become queue rows");
  expectEqual(
    provider.since(beforeProjectionCalls)
      .filter((call) => call.method !== "GET").length,
    0,
    "projection is GET-only: a preview never writes",
  );

  const queuedBudgetRows = (await getDb().query(
    `SELECT id::text AS id, scope_id, status
       FROM meta_automation_proposals
      WHERE business_id = $1::uuid AND provider_account_id = $2
        AND proposed_action = 'budget'
      ORDER BY scope_id`,
    [BUSINESS, ACCOUNT],
  )) as Array<{ id: string; scope_id: string; status: string }>;
  expectEqual(
    queuedBudgetRows.map((row) => `${row.scope_id}:${row.status}`),
    [`${CBO_CAMPAIGN}:pending`, `${SWEEP_CAMPAIGN}:pending`],
    "one pending budget row per owner",
  );
  const manualProposalId = queuedBudgetRows
    .find((row) => row.scope_id === CBO_CAMPAIGN)!.id;
  const sweepProposalId = queuedBudgetRows
    .find((row) => row.scope_id === SWEEP_CAMPAIGN)!.id;
  const raised = await readMetaAutomationProposal({
    businessId: BUSINESS, providerAccountId: ACCOUNT, proposalId: manualProposalId,
  });
  expectEqual(raised?.proposedAction, "budget", "queue row action");
  expectEqual(raised?.budgetEnvelope?.currentAmountMinor, 25000, "envelope current amount");
  expectEqual(raised?.budgetEnvelope?.intendedAmountMinor, 27500, "envelope intended amount");
  expectEqual(raised?.budgetEnvelope?.currency, "USD", "envelope currency");

  // ── Two rejections, on the real execution reader ─────────────────────────
  /*
    The execution path NEVER produces a verdict; it reads the one projection
    retained and re-checks it against the inputs of the moment. These two cases
    are what that buys, and both are driven through the shipped readers and the
    shipped composition root on a real pending proposal.
  */
  const executionSources = async () => {
    const readers = createBudgetServerReaders({
      businessId: BUSINESS,
      actorUserId: OWNER,
      writeContext: await buildMetaBudgetWriteContextForProposal({
        businessId: BUSINESS, providerAccountId: ACCOUNT,
      }),
    });
    const proposal = await readMetaAutomationProposal({
      businessId: BUSINESS, providerAccountId: ACCOUNT, proposalId: manualProposalId,
    });
    if (!proposal) fail("proposal_unreadable", manualProposalId);
    const sources = await readers.loadCompositionSources({
      proposal: proposal!, claimToken: manualProposalId, explicitlyApproved: true,
    });
    if (!sources) return null;
    return {
      sources,
      composed: composeBudgetExecutionCandidate({
        ...sources, proposalId: manualProposalId, claimToken: manualProposalId,
      }),
    };
  };

  // A verdict nobody produced is ABSENT, and absent is a refusal.
  await getDb().query("DELETE FROM engine_v3_account_profile_output");
  const withoutProfile = await executionSources();
  if (!withoutProfile) fail("execution_sources_unreadable", "with no retained profile");
  expectEqual(
    withoutProfile!.composed.blockers.includes("profile_not_retained"), true,
    "an unretained commercial verdict blocks the write by name",
  );
  expectEqual(
    withoutProfile!.sources.commercial.sourceStatus, "unavailable",
    "and the commercial verdict is reported unavailable rather than resolved",
  );
  expectEqual(
    withoutProfile!.sources.commercial.eligible, null,
    "an absent verdict is never reported eligible",
  );

  // Produced again, by the same producer, from the same unchanged facts.
  const reproduced = await produceRetainedAccountProfileOutputs({
    businessId: BUSINESS, providerAccountId: ACCOUNT, asOfDate: AS_OF,
  });
  expectEqual(reproduced.produced, true, "the producer retained the verdict again");
  const restoredVerdict = await executionSources();
  expectEqual(
    restoredVerdict!.composed.blockers, [],
    "and the execution reader admits the candidate again",
  );

  /*
    COMMERCIAL TRUTH THAT MOVED AFTER PROJECTION.

    A new target pack row changes the configured half of the retained identity,
    so the verdict projection retained no longer describes this account and the
    classifier refuses it. This is the check the retention exists for: without
    it a write approved at noon would be authorised by a target ROAS the
    operator replaced at eleven.
  */
  await getDb().query(
    `INSERT INTO business_target_pack_history
       (business_id, target_roas, break_even_roas, target_cpa, break_even_cpa,
        aov_assumption, default_risk_posture, operation, effective_at, recorded_at)
     VALUES ($1::uuid, 3.10, 1.80, NULL, NULL, NULL, 'balanced', 'upsert',
             ($2 || 'T02:00:00.000Z')::timestamptz,
             ($2 || 'T02:00:00.000Z')::timestamptz)`,
    [BUSINESS, AS_OF],
  );
  const afterTargetChange = await executionSources();
  expectEqual(
    afterTargetChange!.composed.blockers.includes("profile_not_retained"), true,
    "a verdict computed from superseded commercial truth is not usable",
  );
  expectEqual(
    afterTargetChange!.sources.commercial.code,
    "retained_profile_input_mismatch",
    "and the refusal names the identity that moved",
  );
  // Withdrawn again, so the rest of the seam runs on the truth it seeded.
  await getDb().query(
    `DELETE FROM business_target_pack_history
      WHERE business_id = $1::uuid AND target_roas = 3.10`,
    [BUSINESS],
  );
  expectEqual(
    (await executionSources())!.composed.blockers, [],
    "and the original commercial truth restores the verdict",
  );
  expectEqual(
    provider.calls.filter((call) => call.method !== "GET").length, 0,
    "no rejection above reached the provider with a write",
  );

  // ── The approval path, to a real POST and a durable receipt ──────────────
  /*
    Live writes are armed HERE and nowhere earlier: everything above is proven
    with the write gate shut, so nothing before this line could have reached
    Meta even if it had tried to.
  */
  process.env.META_AUTOMATION_LIVE_WRITES = "true";
  await getDb().query(
    `UPDATE meta_automation_business_controls
        SET guardrails_json = jsonb_set(guardrails_json, '{dryRunOnly}', 'false')
      WHERE business_id = $1::uuid`,
    [BUSINESS],
  );
  clearServerCache();
  const beforeManual = provider.calls.length;
  const manual = await approveManually(manualProposalId);
  expectEqual(manual.receipt.withheld ?? null, null, "nothing withheld the approval");
  expectEqual(manual.ok, true, "the manual approval executed");
  expectEqual(manual.settledStatus, "approved", "and settled as approved");
  expectEqual(manual.providerDispatchStarted, true, "the provider was reached");
  expectEqual(
    provider.since(beforeManual).filter((call) => call.method === "POST").length,
    1,
    "exactly one provider write, from one approval",
  );
  expectEqual(providerBudgets.get(CBO_CAMPAIGN), 27500, "the account's own amount moved");
  const manualJournal = await readJournalReceipts(CBO_CAMPAIGN);
  expectEqual(manualJournal.length, 1, "one durable journal receipt");
  expectEqual(manualJournal[0]!.result_class, "verified", "verified against a read-back");
  expectEqual(Number(manualJournal[0]!.before_amount_minor), 25000, "receipt before amount");
  expectEqual(Number(manualJournal[0]!.intended_amount_minor), 27500, "receipt intended amount");
  expectEqual(Number(manualJournal[0]!.readback_amount_minor), 27500, "receipt read-back amount");
  expectEqual(manualJournal[0]!.currency, "USD", "receipt currency");
  const settledManual = await readMetaAutomationProposal({
    businessId: BUSINESS, providerAccountId: ACCOUNT, proposalId: manualProposalId,
  });
  expectEqual(settledManual?.status, "approved", "the queue row is settled");

  // ── The scheduled path, on the second row ────────────────────────────────
  /*
    A DIFFERENT authorisation. Manual approval rests on the operator's explicit
    confirmation; the sweep has no operator, so it requires the account-bound
    enablement, the admin who persisted it, and the exact control version that
    tuple was read under — all re-checked at the pre-POST boundary.
  */
  await getDb().query(
    `UPDATE meta_automation_business_controls
        SET auto_execution_enabled = TRUE,
            auto_execution_provider_account_id = $2,
            auto_execution_enabled_by = $3::uuid
      WHERE business_id = $1::uuid`,
    [BUSINESS, ACCOUNT, OWNER],
  );
  await getDb().query(
    `UPDATE meta_automation_decision_type_modes SET mode = 'auto'
      WHERE business_id = $1::uuid AND decision_type = 'budget'`,
    [BUSINESS],
  );
  clearServerCache();
  const beforeSweep = provider.calls.length;
  const sweep = await runMetaBudgetAutomationSweepIfDue();
  if (sweep.skipped) fail("sweep_skipped", String(sweep.reason));
  expectEqual(
    (sweep.reports ?? []).map((report) => ({
      executed: report.executed, withheld: report.withheld, failed: report.failed,
    })),
    [{ executed: 1, withheld: 0, failed: 0 }],
    "the sweep executed exactly the one row left",
  );
  expectEqual(
    provider.since(beforeSweep).filter((call) => call.method === "POST").length,
    1,
    "one unattended provider write",
  );
  expectEqual(providerBudgets.get(SWEEP_CAMPAIGN), 27500, "the swept account amount moved");
  const sweepJournal = await readJournalReceipts(SWEEP_CAMPAIGN);
  expectEqual(sweepJournal.length, 1, "one durable journal receipt for the sweep");
  expectEqual(sweepJournal[0]!.result_class, "verified", "verified against a read-back");
  expectEqual(Number(sweepJournal[0]!.readback_amount_minor), 27500, "sweep read-back amount");
  const settledSweep = await readMetaAutomationProposal({
    businessId: BUSINESS, providerAccountId: ACCOUNT, proposalId: sweepProposalId,
  });
  expectEqual(settledSweep?.status, "approved", "the swept row is settled");

  /*
    The writes are done. Everything after this point is about decision content
    again, so the provider goes back to refusing: a request from here on is a
    finding.
  */
  process.env.META_AUTOMATION_LIVE_WRITES = "false";
  await getDb().query(
    `UPDATE meta_automation_business_controls
        SET auto_execution_enabled = FALSE,
            guardrails_json = jsonb_set(guardrails_json, '{dryRunOnly}', 'true')
      WHERE business_id = $1::uuid`,
    [BUSINESS],
  );
  clearServerCache();
  provider.refuse();
  const beforeControlPhase = provider.calls.length;

  // ── The two controls: which book the $26.36 comes out of ────────────────
  /*
    An intent is identified by its contract version, which is exactly the
    identity both candidate queries select on. The `state` rows keep a
    `target_value` of their own — an entity-state payload, not a proposed
    amount — so every claim below is stated against the contract rather than
    against the column being null.
  */
  const carriesIntent = (rows: DecisionRow[], contractVersion: string) =>
    rows.some((row) => (row.target_value as { contractVersion?: unknown } | null)
      ?.contractVersion === contractVersion);
  /** The cap this run proposes for the stalled ad set, or null if none. */
  const proposedCap = async () => {
    const row = (await readDecisionRows(CBO_ADSET)).find(
      (candidate) => (candidate.target_value as { contractVersion?: unknown } | null)
        ?.contractVersion === META_BID_INTENT_CONTRACT_VERSION,
    );
    const intent = row?.target_value as Record<string, unknown> | undefined;
    return intent
      ? {
        proposedMinorUnits: intent.proposedMinorUnits,
        percent: intent.percent,
        direction: intent.direction,
      }
      : null;
  };
  const capRaise = {
    proposedMinorUnits: 1320, percent: 10, direction: "increase",
  };

  /** The budget this run proposes for the CBO campaign, or null if none. */
  const proposedBudget = async () => {
    const row = (await readDecisionRows(CBO_CAMPAIGN)).find(
      (candidate) => (candidate.target_value as { contractVersion?: unknown } | null)
        ?.contractVersion === META_BUDGET_INTENT_CONTRACT_VERSION,
    );
    const intent = row?.target_value as Record<string, unknown> | undefined;
    return intent
      ? {
        amountMinor: intent.amountMinor,
        percent: intent.percent,
        direction: intent.direction,
      }
      : null;
  };
  const budgetRaise = { amountMinor: 27500, percent: 10, direction: "increase" };
  /*
    BOTH ARMS ARE STILL LIVE HERE, and the two executions above did not quiet
    either of them.

    That is worth stating because it looks as though they should have.
    `meta_budget_write_journal` now carries a verified change against each
    budget owner, and `readIntentProjectionContexts` reads the cooldown and the
    7-day frequency off exactly those rows — but it reads them
    `WHERE requested_at <= $3`, and that cutoff is the END of the snapshot day
    (`${snapshotDate}T23:59:59.999Z`), which for this seam is yesterday.
    Receipts this run stamped with `now()` are therefore outside the window the
    guardrail asks about, `hours_since_change` stays absent, and the campaign
    keeps proposing. So both controls below assert on the budget arm and the bid
    arm together, and neither assertion is over-determined by a cooldown.

    What DOES stop the queue producer from raising another row is the open-slot
    predicate — both budget proposals are settled — which is why the candidate
    counts below are stated only for the bid arm.
  */

  // ── POSITIVE CONTROL: withdrawing the STORE moves no number ─────────────
  /*
    Age the store's sync past `OBSERVED_SHOPIFY_AOV_MAX_SYNC_AGE_HOURS` and
    re-run. This is the SAME lever that used to erase both intents, back when
    `observed_shopify_aov` was a rung of `resolveSpendUnit`; the point of
    pulling it here is that it must now change nothing at all.

    It is a real withdrawal and not a no-op dressed as one. The merchant's books
    say $36.00 against Meta's $58.00, so a benchmark that had quietly kept a
    store rung would be $16.36, q would be 2200 / 1636 = 1.34, and the same
    stalled ad set would come back on the `lowerBands` 1.1 rung with its cap CUT
    to 1080. The raise standing still at 1320 is what says the store chose
    nothing.
  */
  await getDb().query(
    `UPDATE shopify_sync_state SET latest_successful_sync_at = now() - interval '96 hours'
      WHERE business_id = $1 AND provider_account_id = $2`,
    [BUSINESS, SHOP],
  );
  await runMetaSnapshotForBusiness(BUSINESS, AS_OF);
  expectEqual(
    await proposedCap(), capRaise,
    "the cap raise is unchanged with the store's evidence withdrawn",
  );
  expectEqual(
    await proposedBudget(), budgetRaise,
    "and so is the budget raise the same benchmark authorised",
  );
  const capCandidatesWithoutStore = await listTypedBidCandidates(BUSINESS, AS_OF);
  expectEqual(
    capCandidatesWithoutStore.map((candidate) => candidate.proposedMinorUnits),
    [1320],
    "and the queue producer still selects the same amount",
  );
  /*
    THE STORE IS EVIDENCE, AND EVIDENCE ONLY — INCLUDING IN THE IDENTITY.

    This block used to read: "It is carried into the retained profile's measured
    identity — `accountProfileRetentionIdentity` digests its status, window,
    order count and amount — so withdrawing it moves `source_fingerprint` and
    the producer retains a new verdict." That was TRUE of the code and it was a
    defect, closed under Codex Round 4 item 1.

    `source_fingerprint` is persisted on `engine_v3_account_profile_output` as
    part of that table's UNIQUE key, and `budget-readiness-retention.ts`
    compares it and answers `retained_profile_source_mismatch` when it moves.
    So a fact that D091 says chooses no rung — the store's AOV reaches no rung
    of `resolveSpendUnit` at all — could still discard an unchanged Meta
    verdict. One new order did it. The digest no longer reads it.

    The assertion below is therefore INVERTED from what it was, and the
    positive control needs a different proof that the lever was pulled, because
    "the identity did not move" is now the expected result rather than the
    evidence of a fixture edit that never landed.
  */
  await produceRetainedAccountProfileOutputs({
    businessId: BUSINESS, providerAccountId: ACCOUNT, asOfDate: AS_OF,
  });
  const staleStoreIdentity = await readAccountProfileRetentionIdentity({
    businessId: BUSINESS, providerAccountId: ACCOUNT, asOfDate: AS_OF,
  });
  const staleStoreVerdicts = (await getDb().query(
    `SELECT DISTINCT spend_unit::text AS spend_unit, source_fingerprint
       FROM engine_v3_account_profile_output
      WHERE business_id = $1 AND provider_account_id = $2
        AND source_fingerprint = $3`,
    [BUSINESS, ACCOUNT, staleStoreIdentity?.sourceFingerprint ?? ""],
  )) as Array<{ spend_unit: string | null; source_fingerprint: string }>;
  console.log(
    `[${LABEL}] retained verdict with the store withdrawn: `
    + `spendUnit=${staleStoreVerdicts.map((row) => row.spend_unit).join(",")} `
    + `source=${staleStoreIdentity?.sourceFingerprint.slice(0, 8)} `
    + `(was ${identity!.sourceFingerprint.slice(0, 8)})`,
  );
  /*
    THE LEVER REALLY WAS PULLED, proven where the withdrawal is still visible.

    A positive control is worthless if the mutation it makes is invisible to the
    system under test — "nothing changed" would otherwise be true of a fixture
    edit that never landed. The identity moving used to be that proof; now that
    the digest ignores the store, it cannot be, so the proof moves to the place
    the withdrawal is genuinely observable: the producer's own INPUTS. The same
    reader the producer runs on reports the store's evidence as unusable once
    its sync is aged past `OBSERVED_SHOPIFY_AOV_MAX_SYNC_AGE_HOURS`, and
    `readAccountProfileRetentionInputs` is what feeds
    `accountProfileRetentionIdentity`, so this is the exact value the digest
    declined to read — not a parallel re-derivation of it.
  */
  const withdrawnInputs = await readAccountProfileRetentionInputs({
    businessId: BUSINESS, providerAccountId: ACCOUNT, asOfDate: AS_OF,
  });
  const withdrawnStore = withdrawnInputs?.observedShopifyAov ?? null;
  if (withdrawnStore !== null && withdrawnStore.status === "observed") {
    fail(
      "store_withdrawal_unobserved",
      "aging the store's sync left its evidence still `observed`, so this "
      + "control would pass against a fixture edit that never landed "
      + `(status=${withdrawnStore.status})`,
    );
  }

  /*
    AND THE FINDING, which is now two findings rather than one.

    The money standing still was always the point. What is new beside it is
    that the IDENTITY stands still too: the same withdrawal that leaves the
    spend unit at Meta's $58.00 / 2.20 also leaves `source_fingerprint`
    untouched, so the retained verdict is not discarded and re-minted for a
    number that chose nothing.
  */
  if (staleStoreIdentity?.sourceFingerprint !== identity!.sourceFingerprint) {
    fail(
      "store_withdrawal_moved_identity",
      "withdrawing the store's evidence moved the retained profile's measured "
      + "identity, which discards an unchanged Meta verdict through "
      + "`retained_profile_source_mismatch` — the store chooses no rung and "
      + "must key no identity "
      + `(${identity!.sourceFingerprint.slice(0, 8)} -> `
      + `${staleStoreIdentity?.sourceFingerprint.slice(0, 8)})`,
    );
  }
  expectEqual(
    staleStoreVerdicts.map(
      (row) => Math.round(Number(row.spend_unit) * 100) / 100,
    ),
    [26.36],
    "the retained spend unit does not move when the store's evidence is withdrawn",
  );

  // Back again, so the control is shown to be about the store rather than
  // about having run the snapshot twice.
  await getDb().query(
    `UPDATE shopify_sync_state SET latest_successful_sync_at = now()
      WHERE business_id = $1 AND provider_account_id = $2`,
    [BUSINESS, SHOP],
  );
  await runMetaSnapshotForBusiness(BUSINESS, AS_OF);
  expectEqual(
    [await proposedCap(), await proposedBudget()], [capRaise, budgetRaise],
    "and returning the store's evidence moves nothing either",
  );

  // ── NEGATIVE CONTROL: the META sample under the ready floor ─────────────
  /*
    Re-observe part of the converter population with no purchase on it, through
    the SHIPPED writer, until Meta's attributed sample is exactly one purchase
    under `META_AOV_READY_FLOOR`. This is how a real sync would report the same
    ads on a later pass, not a DELETE reaching behind the writer.

    IT CONTROLS ON THE SAMPLE, NOT ON THE NUMBER. Every surviving row still
    carries `CONVERTER_ORDER_VALUE`, so the attributed AOV is still exactly
    58.00 — asserted below off `computeMetaAttributedAov` itself — and the only
    thing that moved is how many purchases stand behind it.
    `classifyMetaAovQuality` drops from `ready` to `low_sample`,
    `resolveSpendUnit` stops marking the unit `hardEligibleByDefault`, and
    `attachSizedIntents` refuses to size anything from a unit that is not: the
    benchmark and the loss budget both go null together and every intent
    disappears. A $26.36 anchor that could still be assembled from an unready
    sample would fail here.
  */
  await writeConverterCreatives({
    from: META_AOV_READY_FLOOR - 1,
    to: CONVERTER_CREATIVE_COUNT,
    revenue: 0,
    conversions: 0,
  });
  const thinSample = await computeMetaAttributedAov({
    businessId: BUSINESS, asOf: AS_OF, providerAccountId: ACCOUNT, db: getDb(),
  });
  console.log(
    `[${LABEL}] Meta attributed sample under the floor: `
    + `purchases=${thinSample.purchaseCount} aov=${thinSample.aovMean} `
    + `quality=${classifyMetaAovQuality(thinSample.purchaseCount)} `
    + `(ready floor ${META_AOV_READY_FLOOR})`,
  );
  expectEqual(
    thinSample.purchaseCount, META_AOV_READY_FLOOR - 1,
    "the attributed sample sits exactly one purchase under the ready floor",
  );
  expectEqual(
    thinSample.aovMean, CONVERTER_ORDER_VALUE,
    "and the attributed average order value itself did not move",
  );
  expectEqual(
    classifyMetaAovQuality(thinSample.purchaseCount), "low_sample",
    "which the shipped classifier calls low_sample rather than ready",
  );
  await runMetaSnapshotForBusiness(BUSINESS, AS_OF);
  if (carriesIntent(await readDecisionRows(CBO_ADSET), META_BID_INTENT_CONTRACT_VERSION)) {
    fail(
      "bid_intent_survived_unready_meta_sample",
      "a cap was sized from a unit the resolver does not call hard-eligible",
    );
  }
  if (carriesIntent(await readDecisionRows(CBO_CAMPAIGN), META_BUDGET_INTENT_CONTRACT_VERSION)) {
    fail(
      "budget_intent_survived_unready_meta_sample",
      "a budget was sized from a unit the resolver does not call hard-eligible",
    );
  }
  // And nothing downstream can find the cap either.
  expectEqual(
    (await listTypedBidCandidates(BUSINESS, AS_OF)).length, 0,
    "no bid candidate once the Meta sample is under the floor",
  );

  // And back again: the purchases return, the sample clears the floor, and so
  // does the same amount.
  await seedCreativeFacts();
  await runMetaSnapshotForBusiness(BUSINESS, AS_OF);
  expectEqual(
    [await proposedCap(), await proposedBudget()], [capRaise, budgetRaise],
    "both amounts return with the Meta purchase evidence restored",
  );

  /*
    Exactly two provider writes across the whole run, and both of them are
    accounted for above: one operator approval and one unattended sweep, each
    against its own entity. Every other phase — five snapshots, two
    projections, four execution reads and two rejections — reached the provider
    only for GETs or not at all.
  */
  expectEqual(
    provider.calls.filter((call) => call.method !== "GET").length, 2,
    "two provider writes in the whole run, one per authorised execution",
  );
  /*
    And the control phase touched no ENTITY at all.

    The four snapshots there reload the account context, whose own profile read
    is a GET against the ad account node; that is the shipped behaviour of a
    connected workspace and is not what this phase is about. What matters is
    that no campaign or ad set was read or written while the decision content
    was being re-derived. The RECORD is what proves it: the double `fail()`s on
    a refused request, but that rejection is swallowed by the production fetch
    wrapper's own catch.
  */
  expectEqual(
    provider.since(beforeControlPhase).filter(
      (call) => call.method !== "GET" || !call.url.includes(ACCOUNT),
    ).length,
    0,
    "the control-phase snapshots read only the ad account profile",
  );
  provider.restore();

  console.log(
    `[${LABEL}] PASS: the real snapshot derives its CPA benchmark from META'S `
    + "OWN attributed purchase AOV and a target ROAS alone, sizes a campaign "
    + "budget 25000 -> 27500 that the real candidate SQL selects, sizes a cost "
    + "cap 1200 -> 1320 on the delivery-stalled ad set and raises the queue row "
    + "carrying it, retains the canonical commercial verdict through the real "
    + "producer and raises both budget rows on it, refuses an absent and a "
    + "superseded verdict by name, executes one row through operator approval "
    + "and the other through the scheduled sweep with durable read-back "
    + "receipts, holds every one of those numbers still while the Shopify "
    + "store's evidence is withdrawn and returned, loses every intent when the "
    + "Meta-attributed sample falls one purchase under the ready floor with the "
    + "attributed AOV itself unchanged, keeps one account's retained verdict "
    + "byte-identical while a sibling account's samples move and the pooled "
    + "scope moves with them, holds an account with no evidence of its own by "
    + "name, keeps the day's measured identity fixed across an ordinary sync "
    + "write and moves it on the next calibration pass, refuses by name for an "
    + "account that pass has not covered, and makes exactly two provider "
    + "writes.",
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
