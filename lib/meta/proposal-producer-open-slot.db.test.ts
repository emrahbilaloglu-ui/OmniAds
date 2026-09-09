/**
 * Budget and bid producer slot arbitration against a migrated PostgreSQL.
 *
 * This file runs only inside the repository's throwaway claim-race seam. It
 * never reads a configured DATABASE_URL outside that harness.
 */
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getDb, resetDbClientCache } from "@/lib/db";
import {
  NATIVE_AD_PAUSE_PROJECTION_SQL,
  projectMetaAutomationProposals,
  raiseRuleAutomationProposal,
  reconcileMetaEngineDecisionProposalsForSnapshot,
} from "@/lib/meta/automation-proposals";
import {
  insertBudgetProposalRow,
  listTypedBudgetCandidates,
  type TypedBudgetCandidate,
} from "@/lib/meta/budget-proposal-producer";
import { buildBudgetProposalEnvelope }
  from "@/lib/meta/budget-proposal-runtime";
import {
  insertBidProposalRow,
  listTypedBidCandidates,
  type TypedBidCandidate,
} from "@/lib/meta/bid-proposal-producer";
import { buildBidProposalEnvelope } from "@/lib/meta/bid-proposal-envelope";
import { META_BUDGET_INTENT_CONTRACT_VERSION }
  from "@/lib/meta/budget-intent-contract";
import { META_BID_INTENT_CONTRACT_VERSION }
  from "@/lib/meta/bid-intent-contract";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const ACCOUNT = "act_producer_open_slot";

let businessId = "";
let userId = "";
let ruleId = "";

const RACE_GATE_TABLE = "meta_pause_projection_race_gates_test";
const RACE_GATE_FUNCTION = "meta_pause_projection_race_block_test";
const RACE_GATE_TRIGGER = "trg_meta_pause_projection_race_block_test";

async function waitForProjectionAtGate(client: Client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_locks
        WHERE locktype = 'advisory' AND granted = FALSE`,
    );
    if ((waiting.rows[0]?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("projection did not reach the advisory race gate");
}

async function installRaceGate(decisionKey: string, lockKey: number) {
  await getDb().query(
    `INSERT INTO ${RACE_GATE_TABLE} (decision_key, lock_key)
     VALUES ($1, $2::bigint)
     ON CONFLICT (decision_key) DO UPDATE SET lock_key = EXCLUDED.lock_key`,
    [decisionKey, lockKey],
  );
}

async function raiseContendingRule(input: {
  decisionKey: string;
  scopeType: "adset" | "ad";
  scopeId: string;
  snapshotDate: string;
}) {
  const raised = await raiseRuleAutomationProposal({
    businessId,
    providerAccountId: ACCOUNT,
    ruleId,
    dedupeKey: `pause-race:${input.decisionKey}:${randomUUID()}`,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    proposedAction: "pause",
    entityLabel: "Rule-owned pause",
    reason: "A concurrent deterministic rule won this action slot.",
    evidenceLabel: null,
    evidenceRef: { seam: "pause_projection_open_slot_race" },
    evaluatedForDate: input.snapshotDate,
  });
  expect(raised.status).toBe("inserted");
  return raised.proposalId;
}

async function openRaceController(lockKey: number) {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("ephemeral DATABASE_URL is missing");
  const controller = new Client({ connectionString });
  await controller.connect();
  await controller.query("SELECT pg_advisory_lock($1::bigint)", [lockKey]);
  return controller;
}

async function releaseRaceController(controller: Client, lockKey: number) {
  await controller.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
  await controller.end();
}

function budgetCandidate(input: {
  scopeId: string;
  snapshotDate: string;
}): TypedBudgetCandidate {
  return {
    businessId,
    scopeType: "campaign",
    scopeId: input.scopeId,
    parentCampaignId: null,
    decisionAt: `${input.snapshotDate}T03:00:00.000Z`,
    decisionHash: "a".repeat(64),
    providerAccountId: ACCOUNT,
    recId: `budget-${input.snapshotDate}`,
    recType: "scenario_c1_controlled_scale",
    snapshotDate: input.snapshotDate,
    engineVersion: "meta-v3",
    decisionLabel: "scale",
    recommendedAction: "increase_budget",
    targetAmountMinor: 11_000,
    reasoning: "Typed budget intent with an exact target.",
    entityLabel: "Budget entity",
    evidence: {},
  };
}

function bidCandidate(input: {
  scopeId: string;
  snapshotDate: string;
}): TypedBidCandidate {
  return {
    businessId,
    scopeId: input.scopeId,
    parentCampaignId: "campaign_bid_parent",
    providerAccountId: ACCOUNT,
    recId: `bid-${input.snapshotDate}`,
    recType: "scenario_b1_capped_winner_bid_raise",
    snapshotDate: input.snapshotDate,
    engineVersion: "meta-v3",
    decisionLabel: "scale",
    decisionAt: `${input.snapshotDate}T03:00:00.000Z`,
    bidStrategyType: "cost_cap",
    direction: "increase",
    percent: 10,
    currentMinorUnits: 1_000,
    proposedMinorUnits: 1_100,
    currency: "USD",
    currencyExponent: 2,
    intentKey: `bid-intent-${input.snapshotDate}`,
    reasoning: "Typed bid intent with an exact target.",
    entityLabel: "Bid entity",
    evidence: {},
  };
}

async function insertBudget(
  candidate: TypedBudgetCandidate,
  proposalId = randomUUID(),
) {
  const envelope = buildBudgetProposalEnvelope({
    proposalId,
    businessId,
    providerAccountId: ACCOUNT,
    ownerGrain: candidate.scopeType,
    entityId: candidate.scopeId,
    parentCampaignId: candidate.parentCampaignId,
    budgetField: "daily_budget",
    ownerMode: "campaign_budget_optimization",
    currentAmountMinor: 10_000,
    intendedAmountMinor: candidate.targetAmountMinor,
    currency: "USD",
    currencyExponent: 2,
    currencyRegistryVersion: "iso4217.minor-units.2026-09-01",
    intentVerb: candidate.recommendedAction,
    recId: candidate.recId,
    recType: candidate.recType,
    snapshotDate: candidate.snapshotDate,
    engineVersion: candidate.engineVersion,
    decisionHash: candidate.decisionHash,
    decisionAt: candidate.decisionAt,
  });
  return insertBudgetProposalRow({
    businessId,
    proposalId,
    candidate,
    envelopeJson: JSON.stringify(envelope),
    actionLabel: "Apply budget",
  });
}

async function insertBid(candidate: TypedBidCandidate, proposalId = randomUUID()) {
  const envelope = buildBidProposalEnvelope({
    proposalId,
    businessId,
    providerAccountId: ACCOUNT,
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
  return insertBidProposalRow({
    businessId,
    proposalId,
    candidate,
    envelopeJson: JSON.stringify(envelope),
    actionLabel: "Apply bid",
  });
}

async function moveToOpenStatus(proposalId: string, status: string) {
  await getDb().query(
    `UPDATE meta_automation_proposals
        SET status = $2,
            claim_token = CASE WHEN $2 = 'pending' THEN NULL ELSE $3::uuid END,
            claimed_by = CASE WHEN $2 = 'pending' THEN NULL ELSE $4::uuid END,
            claimed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE NOW() END,
            dispatch_started_at = CASE WHEN $2 = 'reconcile' THEN NOW() ELSE NULL END
      WHERE id = $1::uuid`,
    [proposalId, status, randomUUID(), userId],
  );
}

async function seedBudgetDecision(candidate: TypedBudgetCandidate) {
  await getDb().query(
    `INSERT INTO meta_campaign_dimensions (
       business_id, provider_account_id, campaign_id,
       campaign_name_current, campaign_status
     ) VALUES ($1, $2, $3, 'Budget candidate', 'ACTIVE')
     ON CONFLICT DO NOTHING`,
    [businessId, ACCOUNT, candidate.scopeId],
  );
  await getDb().query(
    `INSERT INTO meta_decision_snapshots_daily (
       scope_type, scope_id, business_id, provider_account_id, snapshot_date,
       rec_id, rec_type, level, decision_state, evidence, recommended_action,
       target_value, reasoning, engine_version, kind, decision_label
     ) VALUES (
       'campaign', $1, $2, $3, $4::date, $5, $6, 'campaign', 'act',
       '{}'::jsonb, 'Increase the campaign budget.', $7::jsonb, $8, $9,
       'recommendation', 'scale'
     )`,
    [
      candidate.scopeId,
      businessId,
      ACCOUNT,
      candidate.snapshotDate,
      candidate.recId,
      candidate.recType,
      JSON.stringify({
        contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
        direction: "increase",
        amountMinor: String(candidate.targetAmountMinor),
      }),
      candidate.reasoning,
      candidate.engineVersion,
    ],
  );
}

async function seedBidDecision(candidate: TypedBidCandidate) {
  await getDb().query(
    `INSERT INTO meta_adset_dimensions (
       business_id, provider_account_id, campaign_id, adset_id,
       adset_name_current, adset_status
     ) VALUES ($1, $2, $3, $4, 'Bid candidate', 'ACTIVE')
     ON CONFLICT DO NOTHING`,
    [businessId, ACCOUNT, candidate.parentCampaignId, candidate.scopeId],
  );
  await getDb().query(
    `INSERT INTO meta_decision_snapshots_daily (
       scope_type, scope_id, business_id, provider_account_id, snapshot_date,
       rec_id, rec_type, level, decision_state, evidence, recommended_action,
       target_value, reasoning, engine_version, kind, decision_label
     ) VALUES (
       'adset', $1, $2, $3, $4::date, $5, $6, 'adset', 'act', '{}'::jsonb,
       'Raise the ad-set cost cap.', $7::jsonb, $8, $9,
       'recommendation', 'scale'
     )`,
    [
      candidate.scopeId,
      businessId,
      ACCOUNT,
      candidate.snapshotDate,
      candidate.recId,
      candidate.recType,
      JSON.stringify({
        contractVersion: META_BID_INTENT_CONTRACT_VERSION,
        kind: "bid_intent",
        authorityStatus: "authorised",
        blockerCodes: [],
        bidStrategyType: candidate.bidStrategyType,
        direction: candidate.direction,
        percent: String(candidate.percent),
        currentMinorUnits: String(candidate.currentMinorUnits),
        proposedMinorUnits: String(candidate.proposedMinorUnits),
        currency: candidate.currency,
        currencyExponent: String(candidate.currencyExponent),
        intentKey: candidate.intentKey,
      }),
      candidate.reasoning,
      candidate.engineVersion,
    ],
  );
}

async function seedStructurePauseDecision(input: {
  scopeId: string;
  snapshotDate: string;
}) {
  const recId = `pause-${randomUUID()}`;
  const recType = `scenario_pause_race_${randomUUID().replaceAll("-", "")}`;
  await getDb().query(
    `INSERT INTO meta_adset_dimensions (
       business_id, provider_account_id, campaign_id, adset_id,
       adset_name_current, adset_status
     ) VALUES ($1, $2, 'campaign_pause_race', $3, $4, 'ACTIVE')`,
    [businessId, ACCOUNT, input.scopeId, `Pause ${input.scopeId}`],
  );
  await getDb().query(
    `INSERT INTO meta_decision_snapshots_daily (
       scope_type, scope_id, business_id, provider_account_id, snapshot_date,
       rec_id, rec_type, level, decision_state, evidence, recommended_action,
       target_value, reasoning, expected_impact, engine_version, kind,
       decision_label
     ) VALUES (
       'adset', $1, $2, $3, $4::date, $5, $6, 'adset', 'act',
       '{}'::jsonb, 'Pause this ad set.', NULL,
       'ROAS is below the configured commercial floor.', 'Stops inefficient spend.',
       'meta-v3', 'recommendation', 'cut'
     )`,
    [input.scopeId, businessId, ACCOUNT, input.snapshotDate, recId, recType],
  );
}

async function slotRows(
  decisionKey: string,
  action: "pause" | "budget" | "bid",
) {
  return (await getDb().query<{
    id: string;
    status: string;
    origin: string;
    evidence_label: string | null;
    budget_envelope_json: { proposalId?: string } | null;
    bid_envelope_json: { proposalId?: string } | null;
  }>(
    `SELECT id::text AS id, status, origin, evidence_label,
            budget_envelope_json, bid_envelope_json
       FROM meta_automation_proposals
      WHERE business_id = $1::uuid
        AND provider_account_id = $2
        AND decision_key = $3
        AND proposed_action = $4
      ORDER BY created_at, id`,
    [businessId, ACCOUNT, decisionKey, action],
  )) as Array<{
    id: string;
    status: string;
    origin: string;
    evidence_label: string | null;
    budget_envelope_json: { proposalId?: string } | null;
    bid_envelope_json: { proposalId?: string } | null;
  }>;
}

describe.runIf(SEAM)("budget and bid projection open-slot arbitration", () => {
  beforeAll(async () => {
    resetDbClientCache();
    const users = (await getDb().query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Producer slot operator', $1, 'x')
       RETURNING id::text AS id`,
      [`producer-slot-${randomUUID()}@example.invalid`],
    )) as Array<{ id: string }>;
    userId = users[0]!.id;
    const businesses = (await getDb().query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id)
       VALUES ('Producer open-slot seam', $1::uuid)
       RETURNING id::text AS id`,
      [userId],
    )) as Array<{ id: string }>;
    businessId = businesses[0]!.id;

    const rules = (await getDb().query<{ id: string }>(
      `INSERT INTO meta_automation_rules (
         business_id, name, entity_level, trigger_json, action_json,
         mode, active, created_by
       ) VALUES (
         $1::uuid, $2, 'adset', '{}'::jsonb, '{"action":"pause"}'::jsonb,
         'confirm', TRUE, $3::uuid
       )
       RETURNING id::text AS id`,
      [businessId, `Pause projection race ${randomUUID()}`, userId],
    )) as Array<{ id: string }>;
    ruleId = rules[0]!.id;

    /*
      A real BEFORE INSERT trigger creates the exact timing window that matters:
      the projection statement has already fixed its PostgreSQL snapshot and
      selected the candidate, but has not yet tested either unique index. The
      test connection owns the advisory lock, a rule commits the same slot on a
      second connection, and releasing the lock lets the production INSERT face
      the now-invisible winner. This is deterministic; no sleep-based race.
    */
    await getDb().query(`
      CREATE TABLE ${RACE_GATE_TABLE} (
        decision_key TEXT PRIMARY KEY,
        lock_key BIGINT NOT NULL
      );
      CREATE FUNCTION ${RACE_GATE_FUNCTION}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE gate_key BIGINT;
      BEGIN
        IF NEW.origin = 'engine_decision' THEN
          SELECT lock_key INTO gate_key
            FROM ${RACE_GATE_TABLE}
           WHERE decision_key = NEW.decision_key;
          IF FOUND THEN
            PERFORM pg_advisory_xact_lock(gate_key);
          END IF;
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER ${RACE_GATE_TRIGGER}
      BEFORE INSERT ON meta_automation_proposals
      FOR EACH ROW EXECUTE FUNCTION ${RACE_GATE_FUNCTION}();
    `);
  });

  afterAll(async () => {
    await getDb().query(`
      DROP TRIGGER IF EXISTS ${RACE_GATE_TRIGGER} ON meta_automation_proposals;
      DROP FUNCTION IF EXISTS ${RACE_GATE_FUNCTION}();
      DROP TABLE IF EXISTS ${RACE_GATE_TABLE};
    `);
  });

  it.each(["pending", "claimed", "reconcile"])(
    "returns a conflict behind a %s holder instead of throwing",
    async (status) => {
      const suffix = `${status}-${randomUUID()}`;
      const budgetScope = `campaign-${suffix}`;
      const nextBudget = budgetCandidate({
        scopeId: budgetScope,
        snapshotDate: "2026-09-09",
      });
      await seedBudgetDecision(nextBudget);
      expect((await listTypedBudgetCandidates(
        businessId,
        nextBudget.snapshotDate,
        [ACCOUNT],
      )).find((row) => row.scopeId === budgetScope)).toBeDefined();
      const budgetHolder = await insertBudget(budgetCandidate({
        scopeId: budgetScope,
        snapshotDate: "2026-09-08",
      }));
      expect(budgetHolder).toBeTruthy();
      await moveToOpenStatus(budgetHolder!, status);
      expect((await listTypedBudgetCandidates(
        businessId,
        nextBudget.snapshotDate,
        [ACCOUNT],
      )).find((row) => row.scopeId === budgetScope)).toBeUndefined();
      await expect(insertBudget(nextBudget)).resolves.toBeNull();
      expect(await slotRows(`campaign:${budgetScope}`, "budget")).toHaveLength(1);

      const bidScope = `adset-${suffix}`;
      const nextBid = bidCandidate({
        scopeId: bidScope,
        snapshotDate: "2026-09-09",
      });
      await seedBidDecision(nextBid);
      expect((await listTypedBidCandidates(
        businessId,
        nextBid.snapshotDate,
        [ACCOUNT],
      )).find((row) => row.scopeId === bidScope)).toBeDefined();
      const bidHolder = await insertBid(bidCandidate({
        scopeId: bidScope,
        snapshotDate: "2026-09-08",
      }));
      expect(bidHolder).toBeTruthy();
      await moveToOpenStatus(bidHolder!, status);
      expect((await listTypedBidCandidates(
        businessId,
        nextBid.snapshotDate,
        [ACCOUNT],
      )).find((row) => row.scopeId === bidScope)).toBeUndefined();
      await expect(insertBid(nextBid)).resolves.toBeNull();
      expect(await slotRows(`adset:${bidScope}`, "bid")).toHaveLength(1);
    },
  );

  it("refreshes the exact pending projection in place", async () => {
    const budgetScope = `budget-idempotent-${randomUUID()}`;
    const budget = budgetCandidate({
      scopeId: budgetScope,
      snapshotDate: "2026-09-09",
    });
    const budgetId = randomUUID();
    const firstBudgetId = await insertBudget(budget, budgetId);
    const secondBudgetId = await insertBudget({
      ...budget,
      targetAmountMinor: 12_000,
      decisionHash: "b".repeat(64),
    }, budgetId);
    expect(secondBudgetId).toBe(firstBudgetId);
    const budgetRows = await slotRows(`campaign:${budgetScope}`, "budget");
    expect(budgetRows).toHaveLength(1);
    expect(budgetRows[0]!.evidence_label).toBe(
      "Budget: USD 100.00 → USD 120.00",
    );

    const bidScope = `bid-idempotent-${randomUUID()}`;
    const bid = bidCandidate({
      scopeId: bidScope,
      snapshotDate: "2026-09-09",
    });
    const bidId = randomUUID();
    const firstBidId = await insertBid(bid, bidId);
    const secondBidId = await insertBid({
      ...bid,
      currentMinorUnits: 1_200,
      proposedMinorUnits: 1_320,
      intentKey: `${bid.intentKey}:refreshed`,
    }, bidId);
    expect(secondBidId).toBe(firstBidId);
    const bidRows = await slotRows(`adset:${bidScope}`, "bid");
    expect(bidRows).toHaveLength(1);
    expect(bidRows[0]!.evidence_label).toBe(
      "Bid: USD 12.00 → USD 13.20 (+10%)",
    );
  });

  it("does not let an exact-key race detach an envelope from its row", async () => {
    const budgetScope = `budget-exact-race-${randomUUID()}`;
    const budget = budgetCandidate({
      scopeId: budgetScope,
      snapshotDate: "2026-09-09",
    });
    const budgetResults = await Promise.all([
      insertBudget(budget),
      insertBudget(budget),
    ]);
    expect(budgetResults.filter(Boolean)).toHaveLength(1);
    const [storedBudget] = await slotRows(`campaign:${budgetScope}`, "budget");
    expect(storedBudget!.budget_envelope_json?.proposalId).toBe(storedBudget!.id);

    const bidScope = `bid-exact-race-${randomUUID()}`;
    const bid = bidCandidate({ scopeId: bidScope, snapshotDate: "2026-09-09" });
    const bidResults = await Promise.all([insertBid(bid), insertBid(bid)]);
    expect(bidResults.filter(Boolean)).toHaveLength(1);
    const [storedBid] = await slotRows(`adset:${bidScope}`, "bid");
    expect(storedBid!.bid_envelope_json?.proposalId).toBe(storedBid!.id);
  });

  it("lets one of two concurrent competing projections own each slot", async () => {
    const budgetScope = `budget-race-${randomUUID()}`;
    const budgetResults = await Promise.all([
      insertBudget(budgetCandidate({
        scopeId: budgetScope,
        snapshotDate: "2026-09-08",
      })),
      insertBudget(budgetCandidate({
        scopeId: budgetScope,
        snapshotDate: "2026-09-09",
      })),
    ]);
    expect(budgetResults.filter(Boolean)).toHaveLength(1);
    expect(await slotRows(`campaign:${budgetScope}`, "budget")).toHaveLength(1);

    const bidScope = `bid-race-${randomUUID()}`;
    const bidResults = await Promise.all([
      insertBid(bidCandidate({ scopeId: bidScope, snapshotDate: "2026-09-08" })),
      insertBid(bidCandidate({ scopeId: bidScope, snapshotDate: "2026-09-09" })),
    ]);
    expect(bidResults.filter(Boolean)).toHaveLength(1);
    expect(await slotRows(`adset:${bidScope}`, "bid")).toHaveLength(1);
  });

  it("keeps an independent structure pause when a concurrent rule wins another slot", async () => {
    const snapshot = (await getDb().query<{ today: string }>(
      "SELECT CURRENT_DATE::text AS today",
    )) as Array<{ today: string }>;
    const snapshotDate = snapshot[0]!.today;
    const contestedScope = `adset-a-pause-race-${randomUUID()}`;
    const independentScope = `adset-z-pause-free-${randomUUID()}`;
    await seedStructurePauseDecision({ scopeId: contestedScope, snapshotDate });
    await seedStructurePauseDecision({ scopeId: independentScope, snapshotDate });

    const decisionKey = `adset:${contestedScope}`;
    const lockKey = 9_100_001;
    await installRaceGate(decisionKey, lockKey);
    const controller = await openRaceController(lockKey);
    let controllerReleased = false;
    let projection: ReturnType<typeof projectMetaAutomationProposals> | null = null;
    try {
      projection = projectMetaAutomationProposals({
        businessId,
        snapshotDate,
        providerAccountIds: [ACCOUNT],
        readModes: async () => ({ pause: "semi_auto" }) as never,
      });
      await waitForProjectionAtGate(controller);
      await raiseContendingRule({
        decisionKey,
        scopeType: "adset",
        scopeId: contestedScope,
        snapshotDate,
      });
      await releaseRaceController(controller, lockKey);
      controllerReleased = true;

      await expect(projection).resolves.toMatchObject({ projected: 1, ran: true });
    } finally {
      if (!controllerReleased) {
        await releaseRaceController(controller, lockKey).catch(() => null);
      }
      await projection?.catch(() => null);
      await getDb().query(`DELETE FROM ${RACE_GATE_TABLE} WHERE decision_key = $1`, [
        decisionKey,
      ]);
    }

    const contested = await slotRows(decisionKey, "pause");
    expect(contested).toHaveLength(1);
    expect(contested[0]!.origin).toBe("automation_rule");
    const independent = await slotRows(`adset:${independentScope}`, "pause");
    expect(independent).toHaveLength(1);
    expect(independent[0]!.origin).toBe("engine_decision");
  });

  it("withdraws an untouched prior-day structure pause on the next attempted snapshot", async () => {
    const dates = (await getDb().query<{ today: string; yesterday: string }>(
      `SELECT CURRENT_DATE::text AS today,
              (CURRENT_DATE - 1)::text AS yesterday`,
    )) as Array<{ today: string; yesterday: string }>;
    const { today, yesterday } = dates[0]!;
    const scopeId = `adset-cross-date-${randomUUID()}`;
    await seedStructurePauseDecision({ scopeId, snapshotDate: yesterday });

    await expect(projectMetaAutomationProposals({
      businessId,
      snapshotDate: yesterday,
      providerAccountIds: [ACCOUNT],
      readModes: async () => ({ pause: "semi_auto" }) as never,
    })).resolves.toMatchObject({ projected: 1, ran: true });

    const reconciled = await reconcileMetaEngineDecisionProposalsForSnapshot({
      businessId,
      snapshotDate: today,
      attemptedProviderAccountIds: [ACCOUNT],
      fulfilledProviderAccountIds: [ACCOUNT],
    });
    expect(reconciled.ran).toBe(true);
    expect(reconciled.withdrawn).toBeGreaterThanOrEqual(1);

    const rows = (await getDb().query<{
      status: string;
      decision_note: string | null;
    }>(
      `SELECT status, decision_note
         FROM meta_automation_proposals
        WHERE business_id = $1::uuid
          AND provider_account_id = $2
          AND decision_key = $3
          AND proposed_action = 'pause'`,
      [businessId, ACCOUNT, `adset:${scopeId}`],
    )) as Array<{ status: string; decision_note: string | null }>;
    expect(rows).toEqual([{
      status: "expired",
      decision_note: "engine_decision_source_withdrawn",
    }]);
  });

  it("keeps an independent native-ad pause when a concurrent rule wins another slot", async () => {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) throw new Error("ephemeral DATABASE_URL is missing");
    const projectionClient = new Client({ connectionString });
    await projectionClient.connect();
    const snapshot = await projectionClient.query<{ today: string }>(
      "SELECT CURRENT_DATE::text AS today",
    );
    const snapshotDate = snapshot.rows[0]!.today;
    const contestedScope = `ad-a-pause-race-${randomUUID()}`;
    const independentScope = `ad-z-pause-free-${randomUUID()}`;

    /*
      Only the source tables are temporary. The target is the fully migrated
      public proposal table, so both real unique indexes and the concurrent
      rule's committed row arbitrate the production native projection SQL.
    */
    await projectionClient.query(`
      CREATE TEMP TABLE engine_v3_ad_decision_snapshots_daily (
        id UUID DEFAULT gen_random_uuid(),
        evaluation_id UUID DEFAULT gen_random_uuid(),
        business_id TEXT,
        provider_account_id TEXT,
        ad_id TEXT,
        creative_id TEXT,
        as_of_date DATE,
        computed_at TIMESTAMPTZ,
        engine_version TEXT,
        label TEXT,
        authorized_action TEXT,
        reason TEXT,
        decision_hash TEXT,
        roas NUMERIC,
        spend NUMERIC,
        effective_target_roas NUMERIC
      );
      CREATE TEMP TABLE meta_ad_dimensions (
        business_id TEXT,
        provider_account_id TEXT,
        ad_id TEXT,
        ad_name_current TEXT,
        ad_status TEXT,
        UNIQUE (business_id, provider_account_id, ad_id)
      );
    `);
    for (const scopeId of [contestedScope, independentScope]) {
      await projectionClient.query(
        `INSERT INTO meta_ad_dimensions
           (business_id, provider_account_id, ad_id, ad_name_current, ad_status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')`,
        [businessId, ACCOUNT, scopeId, `Native ${scopeId}`],
      );
      await projectionClient.query(
        `INSERT INTO engine_v3_ad_decision_snapshots_daily (
           business_id, provider_account_id, ad_id, creative_id, as_of_date,
           computed_at, engine_version, label, authorized_action, reason,
           decision_hash, roas, spend, effective_target_roas
         ) VALUES (
           $1, $2, $3, $4, $5::date, NOW(), 'meta-v3', 'cut', 'cut',
           'Native ad ROAS is below the configured commercial floor.',
           $6, 0.5, 100, 2.0
         )`,
        [
          businessId,
          ACCOUNT,
          scopeId,
          `creative-${scopeId}`,
          snapshotDate,
          randomUUID().replaceAll("-", "").repeat(2),
        ],
      );
    }

    const decisionKey = `ad:${contestedScope}`;
    const lockKey = 9_100_002;
    await installRaceGate(decisionKey, lockKey);
    const controller = await openRaceController(lockKey);
    let controllerReleased = false;
    let projection: Promise<{ rows: unknown[] }> | null = null;
    try {
      projection = projectionClient.query(NATIVE_AD_PAUSE_PROJECTION_SQL, [
        businessId,
        snapshotDate,
        "Approve & apply",
        "24 hours",
        ACCOUNT,
      ]);
      await waitForProjectionAtGate(controller);
      await raiseContendingRule({
        decisionKey,
        scopeType: "ad",
        scopeId: contestedScope,
        snapshotDate,
      });
      await releaseRaceController(controller, lockKey);
      controllerReleased = true;

      const result = await projection!;
      expect(result.rows).toHaveLength(1);
    } finally {
      if (!controllerReleased) {
        await releaseRaceController(controller, lockKey).catch(() => null);
      }
      await projection?.catch(() => null);
      await projectionClient.end();
      await getDb().query(`DELETE FROM ${RACE_GATE_TABLE} WHERE decision_key = $1`, [
        decisionKey,
      ]);
    }

    const contested = await slotRows(decisionKey, "pause");
    expect(contested).toHaveLength(1);
    expect(contested[0]!.origin).toBe("automation_rule");
    const independent = await slotRows(`ad:${independentScope}`, "pause");
    expect(independent).toHaveLength(1);
    expect(independent[0]!.origin).toBe("engine_decision");
  });

  it("replaces an untouched prior-day native pause without losing the new open slot", async () => {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) throw new Error("ephemeral DATABASE_URL is missing");
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const dates = await client.query<{ today: string; yesterday: string }>(
        `SELECT CURRENT_DATE::text AS today,
                (CURRENT_DATE - 1)::text AS yesterday`,
      );
      const { today, yesterday } = dates.rows[0]!;
      const scopeId = `ad-cross-date-${randomUUID()}`;
      await client.query(`
        CREATE TEMP TABLE engine_v3_ad_decision_snapshots_daily (
          id UUID DEFAULT gen_random_uuid(),
          evaluation_id UUID DEFAULT gen_random_uuid(),
          business_id TEXT,
          provider_account_id TEXT,
          ad_id TEXT,
          creative_id TEXT,
          as_of_date DATE,
          computed_at TIMESTAMPTZ,
          engine_version TEXT,
          label TEXT,
          authorized_action TEXT,
          reason TEXT,
          decision_hash TEXT,
          roas NUMERIC,
          spend NUMERIC,
          effective_target_roas NUMERIC
        );
        CREATE TEMP TABLE meta_ad_dimensions (
          business_id TEXT,
          provider_account_id TEXT,
          ad_id TEXT,
          ad_name_current TEXT,
          ad_status TEXT,
          UNIQUE (business_id, provider_account_id, ad_id)
        );
      `);
      await client.query(
        `INSERT INTO meta_ad_dimensions
           (business_id, provider_account_id, ad_id, ad_name_current, ad_status)
         VALUES ($1, $2, $3, 'Cross-date native ad', 'ACTIVE')`,
        [businessId, ACCOUNT, scopeId],
      );
      const insertCut = async (snapshotDate: string, hash: string) =>
        client.query(
          `INSERT INTO engine_v3_ad_decision_snapshots_daily (
             business_id, provider_account_id, ad_id, creative_id, as_of_date,
             computed_at, engine_version, label, authorized_action, reason,
             decision_hash, roas, spend, effective_target_roas
           ) VALUES (
             $1, $2, $3, $4, $5::date, NOW(), 'meta-v3', 'cut', 'cut',
             'Native ad remains below the configured commercial floor.',
             $6, 0.5, 100, 2.0
           )`,
          [businessId, ACCOUNT, scopeId, `creative-${scopeId}`, snapshotDate, hash],
        );

      await insertCut(yesterday, "a".repeat(64));
      const first = await client.query(NATIVE_AD_PAUSE_PROJECTION_SQL, [
        businessId,
        yesterday,
        "Approve & apply",
        "48 hours",
        ACCOUNT,
      ]);
      expect(first.rows).toHaveLength(1);

      await insertCut(today, "b".repeat(64));
      const second = await client.query(NATIVE_AD_PAUSE_PROJECTION_SQL, [
        businessId,
        today,
        "Approve & apply",
        "48 hours",
        ACCOUNT,
      ]);
      expect(second.rows).toHaveLength(1);

      const rows = await client.query<{
        snapshot_date: string;
        status: string;
        decision_note: string | null;
      }>(
        `SELECT snapshot_date::text, status, decision_note
           FROM meta_automation_proposals
          WHERE business_id = $1::uuid
            AND provider_account_id = $2
            AND decision_key = $3
            AND proposed_action = 'pause'
          ORDER BY snapshot_date`,
        [businessId, ACCOUNT, `ad:${scopeId}`],
      );
      expect(rows.rows).toEqual([
        {
          snapshot_date: yesterday,
          status: "expired",
          decision_note: "native_ad_decision_withdrawn",
        },
        { snapshot_date: today, status: "pending", decision_note: null },
      ]);
    } finally {
      await client.end();
    }
  });
});
