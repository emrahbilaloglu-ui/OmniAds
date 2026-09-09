// Child of ephemeral-postgres-migrations-check. It runs only against the
// throwaway database URL force-set by the parent and never calls Meta.
//
// What only Postgres can answer for the future bid arm:
//   * the candidate SQL selects the typed intent's real payload fields;
//   * a `bid` row without an envelope is refused by the database, not by a
//     hopeful reader;
//   * the action log accepts `bid` as its own verb, so a bid write does not
//     have to be filed under a status contract.
import { getDb, resetDbClientCache } from "@/lib/db";
import {
  insertBidProposalRow,
  listTypedBidCandidates,
  projectMetaBidProposals,
} from "@/lib/meta/bid-proposal-producer";
import { buildBidProposalEnvelope } from "@/lib/meta/bid-proposal-envelope";
import {
  claimMetaAutomationProposal,
  readMetaAutomationProposal,
  reconcileMetaEngineDecisionProposalsForSnapshot,
} from "@/lib/meta/automation-proposals";
import { createMetaAdsActionLog } from "@/lib/meta/ads-action-log";

const BUSINESS = "d0000000-0000-4000-8000-000000000202";
const OWNER = "d0000000-0000-4000-8000-0000000002ff";
const ACCOUNT = "act_bid_queue_seam";
const ADSET = "set_bid_seam";
const BLOCKED_ADSET = "set_bid_seam_blocked";
const AS_OF = "2026-09-04";

function expectEqual(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `bid-queue seam FAILED [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/**
 * A synthetic forward-contract payload.
 *
 * B1 currently emits at campaign grain, so production cannot create this
 * ad-set row yet. The seam deliberately supplies the missing future producer
 * shape to prove PostgreSQL selection, envelope, and journal mechanics without
 * claiming present-day reachability.
 */
function bidIntent(overrides: Record<string, unknown> = {}) {
  return {
    kind: "bid_intent",
    contractVersion: "meta.bid-intent.v1",
    intentKey: "meta.bid-intent.v1:seam",
    scope: {
      businessId: BUSINESS, providerAccountId: ACCOUNT,
      entityGrain: "adset", entityId: ADSET, parentCampaignId: "cmp_bid_seam",
    },
    bidStrategyType: "cost_cap",
    direction: "increase",
    percent: 10,
    currency: "USD",
    currencyExponent: 2,
    currentMinorUnits: 1200,
    proposedMinorUnits: 1320,
    deltaMinorUnits: 120,
    authorityStatus: "authorised",
    blockerCodes: [],
    executionState: "validated_only",
    ...overrides,
  };
}

async function seed() {
  const sql = getDb();
  await sql.query(
    `INSERT INTO users (id, email, name, password_hash)
     VALUES ($1::uuid, 'bid-queue-seam@example.test', 'Bid queue seam', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [OWNER],
  );
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, timezone, currency)
     VALUES ($1::uuid, 'Bid queue seam', $2::uuid, 'America/Chicago', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS, OWNER],
  );
  for (const [adsetId, name] of [[ADSET, "Prospecting"], [BLOCKED_ADSET, "Retargeting"]]) {
    await sql.query(
      `INSERT INTO meta_adset_dimensions
         (business_id, provider_account_id, adset_id, campaign_id,
          adset_name_current, adset_status)
       VALUES ($1, $2, $3, 'cmp_bid_seam', $4, 'ACTIVE')
       ON CONFLICT DO NOTHING`,
      [BUSINESS, ACCOUNT, adsetId, name],
    );
  }
  // One authorised intent, and one the sizing policy withheld. A withheld
  // intent is an explanation on a card and must never become an approvable row.
  await sql.query(
    `INSERT INTO meta_decision_snapshots_daily (
       scope_type, scope_id, business_id, snapshot_date, rec_id, rec_type,
       level, decision_state, evidence, recommended_action, target_value,
       reasoning, engine_version, kind, decision_label, provider_account_id
     ) VALUES
       ('adset', $1, $2, $3::date, 'rec-bid-1', 'scenario_b1_capped_winner_bid_raise', 'adset', 'act',
        '{}'::jsonb, 'Raise the cost cap one rung.', $4::jsonb,
        'CPA is 16% under the benchmark and delivery is constrained.',
        'v-seam', 'recommendation', 'tune', $6),
       ('adset', $5, $2, $3::date, 'rec-bid-2', 'scenario_b1_capped_winner_bid_raise', 'adset', 'act',
        '{}'::jsonb, 'Raise the cost cap one rung.', $7::jsonb,
        'Withheld: no delivery constraint.',
        'v-seam', 'recommendation', 'tune', $6)
     ON CONFLICT DO NOTHING`,
    [
      ADSET, BUSINESS, AS_OF, JSON.stringify(bidIntent()), BLOCKED_ADSET, ACCOUNT,
      JSON.stringify(bidIntent({
        scope: {
          businessId: BUSINESS, providerAccountId: ACCOUNT,
          entityGrain: "adset", entityId: BLOCKED_ADSET, parentCampaignId: "cmp_bid_seam",
        },
        authorityStatus: "blocked",
        blockerCodes: ["no_delivery_constraint"],
      })),
    ],
  );
}

async function main() {
  if (
    process.env.DATABASE_URL?.includes(":15432/")
    || process.env.DATABASE_URL?.includes(":5432/")
  ) {
    throw new Error("bid-queue seam refused: DATABASE_URL points at a protected port");
  }
  await seed();

  const candidates = await listTypedBidCandidates(BUSINESS, AS_OF, [ACCOUNT]);
  expectEqual(candidates.length, 1, "only the authorised intent is a candidate");
  const candidate = candidates[0]!;
  expectEqual(candidate.scopeId, ADSET, "candidate ad set");
  // The real payload fields, read through the real SQL — not a mock row with
  // columns that do not exist.
  expectEqual(candidate.currentMinorUnits, 1200, "current amount from the payload");
  expectEqual(candidate.proposedMinorUnits, 1320, "proposed amount from the payload");
  expectEqual(candidate.percent, 10, "rung from the payload");
  expectEqual(candidate.bidStrategyType, "cost_cap", "strategy from the payload");
  expectEqual(candidate.parentCampaignId, "cmp_bid_seam", "parent from the dimension");

  const proposalId = "d0000000-0000-4000-8000-0000000002a1";
  const envelope = buildBidProposalEnvelope({
    proposalId,
    businessId: candidate.businessId,
    providerAccountId: candidate.providerAccountId,
    entityId: candidate.scopeId,
    parentCampaignId: candidate.parentCampaignId,
    bidStrategyType: candidate.bidStrategyType,
    direction: candidate.direction,
    percent: candidate.percent,
    currentMinorUnits: candidate.currentMinorUnits,
    proposedMinorUnits: candidate.proposedMinorUnits,
    currency: candidate.currency,
    currencyExponent: candidate.currencyExponent,
    intentKey: candidate.intentKey,
    recId: candidate.recId,
    recType: candidate.recType,
    snapshotDate: candidate.snapshotDate,
    engineVersion: candidate.engineVersion,
    decisionAt: candidate.decisionAt,
  });
  const inserted = await insertBidProposalRow({
    businessId: BUSINESS,
    proposalId,
    candidate,
    envelopeJson: JSON.stringify(envelope),
    actionLabel: "Apply bid",
  });
  expectEqual(inserted, proposalId, "the row keeps the id the envelope names");

  // The row reads back through the production reader with a live envelope.
  const row = await readMetaAutomationProposal({
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    proposalId,
  });
  expectEqual(row?.proposedAction, "bid", "action persisted");
  expectEqual(row?.bidEnvelope?.proposedMinorUnits, 1320, "envelope reads back");
  expectEqual(row?.bidEnvelope?.fingerprint, envelope.fingerprint, "fingerprint holds");

  /*
    A snapshot closes old same-day authority before recomputation. The source
    decision still exists, but an account absent from the fulfilled set must
    lose its pending row. A successful current B1 decision then re-opens that
    exact row id with a freshly bound envelope; a second row would create a
    second approval chance for one decision.
  */
  const withdrawn = await reconcileMetaEngineDecisionProposalsForSnapshot({
    businessId: BUSINESS,
    snapshotDate: AS_OF,
    attemptedProviderAccountIds: [ACCOUNT],
    fulfilledProviderAccountIds: [],
  });
  expectEqual(withdrawn.withdrawn, 1, "failed generation withdraws the open bid row");
  const withdrawnRaw = (await getDb().query(
    `SELECT status, decision_note FROM meta_automation_proposals WHERE id = $1::uuid`,
    [proposalId],
  )) as Array<{ status: string; decision_note: string | null }>;
  expectEqual(
    withdrawnRaw[0],
    { status: "expired", decision_note: "engine_decision_source_withdrawn" },
    "withdrawal is explicit and reversible",
  );

  const reoffered = await projectMetaBidProposals({
    businessId: BUSINESS,
    snapshotDate: AS_OF,
    providerAccountIds: [ACCOUNT],
    readBidMode: async () => "semi_auto",
    insertProposal: async (input) => insertBidProposalRow({
      businessId: BUSINESS,
      proposalId: input.proposalId,
      candidate: input.candidate,
      envelopeJson: input.envelopeJson,
      actionLabel: input.actionLabel,
    }),
  });
  expectEqual(reoffered.projected, 1, "current source re-offers the withdrawn row");
  const reofferedRaw = (await getDb().query(
    `SELECT id::text AS id, status, decision_note
       FROM meta_automation_proposals
      WHERE business_id = $1::uuid AND provider_account_id = $2
        AND decision_key = 'adset:' || $3 AND proposed_action = 'bid'`,
    [BUSINESS, ACCOUNT, ADSET],
  )) as Array<{ id: string; status: string; decision_note: string | null }>;
  expectEqual(
    reofferedRaw,
    [{ id: proposalId, status: "pending", decision_note: null }],
    "re-offer preserves one row identity",
  );

  /*
    Claim re-proves the source in the same UPDATE that takes the row. This is a
    direct race reproduction: the card could have been read while Act, then the
    source changes to Watch before approval reaches the server.
  */
  await getDb().query(
    `UPDATE meta_decision_snapshots_daily
        SET decision_state = 'watch'
      WHERE business_id = $1 AND provider_account_id = $2
        AND snapshot_date = $3::date AND scope_id = $4
        AND rec_type = 'scenario_b1_capped_winner_bid_raise'`,
    [BUSINESS, ACCOUNT, AS_OF, ADSET],
  );
  const staleClaim = await claimMetaAutomationProposal({
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    proposalId,
    claimedBy: OWNER,
  });
  expectEqual(staleClaim.status, "conflict", "Watch source cannot be claimed");
  expectEqual(
    await readMetaAutomationProposal({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      proposalId,
    }),
    null,
    "stale pending source is hidden from the reader",
  );
  const staleWithdrawal = await reconcileMetaEngineDecisionProposalsForSnapshot({
    businessId: BUSINESS,
    snapshotDate: AS_OF,
    attemptedProviderAccountIds: [ACCOUNT],
    fulfilledProviderAccountIds: [ACCOUNT],
  });
  expectEqual(staleWithdrawal.withdrawn, 1, "Watch source is withdrawn durably");

  /*
    THE CONSTRAINT THAT MATTERS.

    A `bid` row without an amount is what the old queue would have produced,
    and an executor handed one would have had to invent the size of the change.
    The database refuses it, so no reader has to be careful.
  */
  let refusedEnvelopeless = false;
  await getDb().query(
    `INSERT INTO meta_automation_proposals (
       business_id, provider_account_id, origin, decision_key, scope_type,
       scope_id, rec_id, rec_type, snapshot_date, engine_version,
       decision_label, proposed_action, action_label, primary_caption,
       reason, expires_at, status
     ) VALUES (
       $1::uuid, $2, 'engine_decision', 'adset:no_envelope', 'adset',
       'no_envelope', 'rec-x', 'scenario_b1_capped_winner_bid_raise', $3::date, 'v-seam',
       'tune', 'bid', 'Apply bid', 'Review', 'x', NOW() + interval '24 hours',
       'pending'
     )`,
    [BUSINESS, ACCOUNT, AS_OF],
  ).catch(() => { refusedEnvelopeless = true; });
  expectEqual(refusedEnvelopeless, true, "a bid row without an envelope is refused");

  /*
    And the action log takes `bid` as its own verb.

    Filing a bid change under `pause`/`resume` would put it inside the manual
    status-mutation contract those two carry, whose triggers are about a
    different kind of write entirely.
  */
  const journalled = await createMetaAdsActionLog({
    businessId: BUSINESS,
    providerAccountId: ACCOUNT,
    adId: ADSET,
    creativeId: null,
    action: "bid",
    source: "scheduled_automation_v1",
    requestedBy: null,
    payloadRequest: {
      method: "POST",
      endpoint: `/${ADSET}`,
      body: { bid_amount: 1320 },
      dry_run: false,
      prior_state: { bid_amount: 1200, bid_strategy: "COST_CAP" },
    },
  });
  const stored = await getDb().query<{ action: string; prior: string | null }>(
    `SELECT action, payload_request->'prior_state'->>'bid_amount' AS prior
       FROM meta_ads_action_log WHERE id = $1::uuid`,
    [journalled.id],
  );
  expectEqual(stored[0]!.action, "bid", "the action log records a bid as a bid");
  expectEqual(stored[0]!.prior, "1200", "the pre-write value is durable");

  console.log(
    "[bid-queue-seam] PASS: typed bid candidates from the real payload columns, withheld intents excluded, envelope round-trip and fingerprint, database-refused envelopeless bid row, and a bid-verb action log carrying its pre-write value.",
  );
  resetDbClientCache();
}

main().catch((error) => {
  console.error(error);
  try {
    resetDbClientCache();
  } catch {
    // Best-effort cleanup after the original seam failure.
  }
  process.exitCode = 1;
});
