/**
 * `reconcile` holds the action slot — proven against a REAL PostgreSQL.
 *
 * TWO claims live here, and neither is provable with a mocked database.
 *
 * **ITEM 1 — the slot.** A `reconcile` row is an attempt that ENTERED the
 * provider and never came back with an answer. While the slot predicate covered
 * only `pending` and `claimed`, the stale-claim sweep's own correct behaviour
 * opened the hole: it moves a dead claim whose dispatch had started into
 * `reconcile`, and the slot then read as FREE. The next snapshot projection or
 * rule firing could therefore raise a second pause for an entity that may
 * already be paused at Meta — a second dispatch path for work whose provider
 * outcome nobody has established. The guarantee is PostgreSQL's, via the
 * partial unique index `uq_meta_automation_proposals_open_slot`, so only a real
 * index refusing a real INSERT can show it.
 *
 * **ITEM 4 — the post-dispatch settle exception.** The provider answered and the
 * write that had to record its answer threw. The route must not call the
 * provider again, must not report success, must hold the row, must append the
 * receipt and claim token to a durable store, and must refuse a re-dispatch.
 * That is a sequence of real database states, so it is injected here — settle
 * throws, ledger throws — against the real route handler and a FAKE provider.
 *
 * What is real: the route handler, the store, the migrations, the database, the
 * unique index, the append-only trigger. What is fake: the provider. The
 * executor is replaced by a counting stub, so this file can never perform a Meta
 * write — and its call count is the number the claims are about.
 *
 * Run by `scripts/ephemeral-postgres-automation-claim-race-seam.ts`, which boots
 * a throwaway cluster on a random free port (never 5432, never 15432), migrates
 * it from zero, and points `DATABASE_URL` at it. Outside that harness every test
 * below is skipped rather than silently run against whatever `DATABASE_URL`
 * happens to be — which, in this repo, is production.
 */
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

const PROVIDER_ACCOUNT_ID = "act_reconcile_slot";

/** Every fake dispatch this file performs. Real provider writes: zero. */
const providerCalls: Array<{ proposalId: string; receiptKey: string | null }> =
  [];

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(async () => ({
    session: { user: { id: seeded.userId, email: "reconcile@example.invalid" } },
    membership: { businessId: seeded.businessId, role: "collaborator" },
  })),
}));

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(async () => [PROVIDER_ACCOUNT_ID]),
}));

/**
 * The fake provider. It ANSWERS — that is the point of the ITEM 4 case: the
 * dispatch succeeds and the bookkeeping afterwards is what fails.
 */
vi.mock("@/lib/meta/automation-proposal-execution", () => ({
  executeMetaAutomationProposal: vi.fn(
    async (input: {
      proposal: { id: string; scopeId: string };
      receiptKey?: string | null;
      dryRunOnly: boolean;
      markDispatchStarted?: () => Promise<boolean>;
    }) => {
      const marked = await input.markDispatchStarted?.();
      if (marked === false) throw new Error("fake provider dispatch marker failed");
      providerCalls.push({
        proposalId: input.proposal.id,
        receiptKey: input.receiptKey ?? null,
      });
      return {
        ok: true,
        receipt: {
          httpStatus: 200,
          response: { ok: true, fakeProvider: true },
          // This seam injects a provider answer so it can test the bookkeeping
          // failure after a real attempt, independently of the host's release
          // gate. The provider itself remains a counting fake.
          dryRun: false,
          dispatchedAt: new Date().toISOString(),
          endpoint: `/api/meta/adsets/${input.proposal.scopeId}/pause`,
          withheld: null,
          receiptKey: input.receiptKey ?? null,
          providerMutationAttempted: true,
        },
      };
    },
  ),
}));

const seeded = { businessId: "", userId: "" };

const { getDb, resetDbClientCache } = await import("@/lib/db");
const store = await import("@/lib/meta/automation-proposals");
const reconciliation = await import("@/lib/meta/automation-reconciliation");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const executor = await import("@/lib/meta/automation-proposal-execution");
const { POST } = await import("@/app/api/meta/automation/proposals/route");

const URL_BASE = () =>
  `http://127.0.0.1/api/meta/automation/proposals?businessId=${seeded.businessId}&providerAccountId=${PROVIDER_ACCOUNT_ID}`;

function approveRequest(proposalId: string) {
  return new NextRequest(URL_BASE(), {
    method: "POST",
    body: JSON.stringify({
      proposalId,
      action: "approve",
      manualConfirmation: "explicit_operator_confirmation",
    }),
  });
}

async function seedProposal(input: {
  scopeId: string;
  providerAccountId?: string;
  status?: string;
  recType?: string;
  claimToken?: string | null;
  dispatchStarted?: boolean;
}) {
  const providerAccountId = input.providerAccountId ?? PROVIDER_ACCOUNT_ID;
  const recType = input.recType ?? "scenario_reconcile_cut";
  /*
    Claimable engine rows must own the exact current decision they project.
    Seeding the proposal alone would now be a deliberate stale-source case and
    could never reach the provider double this seam is meant to exercise.
  */
  await getDb().query(
    `INSERT INTO meta_adset_dimensions
       (business_id, provider_account_id, campaign_id, adset_id,
        adset_name_current, adset_status)
     VALUES ($1::uuid, $2, 'camp_reconcile', $3, 'Reconcile ad set', 'ACTIVE')
     ON CONFLICT DO NOTHING`,
    [seeded.businessId, providerAccountId, input.scopeId],
  );
  await getDb().query(
    `INSERT INTO meta_decision_snapshots_daily (
       scope_type, scope_id, business_id, snapshot_date, rec_id, rec_type,
       level, decision_state, evidence, recommended_action, target_value,
       reasoning, engine_version, kind, decision_label, provider_account_id
     ) VALUES (
       'adset', $1, $2, CURRENT_DATE, 'rec_reconcile', $3,
       'adset', 'act', '{}'::jsonb, 'Pause this ad set.', NULL,
       'ROAS below breakeven for 6 days.', 'meta-v3', 'recommendation', 'cut', $4
     )
     ON CONFLICT DO NOTHING`,
    [input.scopeId, seeded.businessId, recType, providerAccountId],
  );
  const rows = (await getDb().query<{ id: string }>(
    `
      INSERT INTO meta_automation_proposals (
        business_id, provider_account_id, origin, decision_key, scope_type,
        scope_id, rec_id, rec_type, snapshot_date, engine_version,
        decision_label, proposed_action, action_label, primary_caption,
        entity_label, reason, evidence_label, evidence_ref, expires_at, status,
        claim_token, claimed_by, claimed_at, dispatch_started_at
      ) VALUES (
        $1::uuid, $2, 'engine_decision', $3, 'adset',
        $4, 'rec_reconcile', $5, CURRENT_DATE, 'meta-v3',
        'cut', 'pause', 'Pause ad set', 'Approve & apply',
        'Reconcile ad set', 'ROAS below breakeven for 6 days.', 'frees $680/d',
        '{}'::jsonb, NOW() + INTERVAL '6 hours', $6,
        $7::uuid, CASE WHEN $7::uuid IS NULL THEN NULL ELSE $8::uuid END,
        CASE WHEN $7::uuid IS NULL THEN NULL ELSE NOW() END,
        CASE WHEN $9::boolean THEN NOW() ELSE NULL END
      )
      RETURNING id::text AS id
    `,
    [
      seeded.businessId,
      providerAccountId,
      `adset:${input.scopeId}`,
      input.scopeId,
      recType,
      input.status ?? "pending",
      input.claimToken ?? null,
      seeded.userId,
      input.dispatchStarted ?? false,
    ],
  )) as Array<{ id: string }>;
  return rows[0]!.id;
}

async function readRow(proposalId: string) {
  const rows = (await getDb().query<{
    status: string;
    claim_token: string | null;
    dispatch_started_at: string | null;
    decision_note: string | null;
  }>(
    `SELECT status, claim_token::text AS claim_token, dispatch_started_at,
            decision_note
     FROM meta_automation_proposals WHERE id = $1::uuid`,
    [proposalId],
  )) as Array<{
    status: string;
    claim_token: string | null;
    dispatch_started_at: string | null;
    decision_note: string | null;
  }>;
  return rows[0]!;
}

describe.runIf(SEAM)("a reconcile row holds the entity's action slot", () => {
  beforeAll(async () => {
    resetDbClientCache();
    const db = getDb();
    const users = (await db.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Reconcile operator', 'reconcile-slot@example.invalid', 'x')
       RETURNING id::text AS id`,
    )) as Array<{ id: string }>;
    seeded.userId = users[0]!.id;
    const businesses = (await db.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id)
       VALUES ('Reconcile slot business', $1::uuid)
       RETURNING id::text AS id`,
      [seeded.userId],
    )) as Array<{ id: string }>;
    seeded.businessId = businesses[0]!.id;

    // A REAL persisted control row: the approve path refuses anything whose
    // supervised posture is merely defaulted.
    await db.query(
      `INSERT INTO meta_automation_business_controls
         (business_id, kill_switch_engaged, auto_execution_enabled, readiness_tier)
       VALUES ($1::uuid, FALSE, FALSE, 'manual_review')`,
      [seeded.businessId],
    );
    await db.query(
      `INSERT INTO meta_adset_dimensions
         (business_id, provider_account_id, campaign_id, adset_id, adset_name_current)
       VALUES ($1::uuid, $2, 'camp_reconcile', 'adset_reconcile_1', 'Reconcile ad set')`,
      [seeded.businessId, PROVIDER_ACCOUNT_ID],
    );
  });

  afterEach(() => {
    providerCalls.length = 0;
    vi.mocked(executor.executeMetaAutomationProposal).mockClear();
  });

  // THE index assertion. Not "the code checks a status list" — the database
  // itself refuses the row, which is what makes the guarantee hold against a
  // producer nobody has read.
  it("refuses a second open row for an entity whose outcome is unknown", async () => {
    await seedProposal({
      scopeId: "adset_slot_reconcile",
      status: "reconcile",
      claimToken: "33333333-3333-4333-8333-333333333331",
      dispatchStarted: true,
    });

    await expect(
      seedProposal({
        scopeId: "adset_slot_reconcile",
        recType: "scenario_some_other_cut",
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  // The slot is per entity AND action. A reconcile hold on one ad set must not
  // freeze the queue for every other one.
  it("leaves a different entity's slot completely unaffected", async () => {
    await seedProposal({
      scopeId: "adset_slot_neighbour_held",
      status: "reconcile",
      claimToken: "33333333-3333-4333-8333-333333333332",
      dispatchStarted: true,
    });

    const neighbour = await seedProposal({ scopeId: "adset_slot_neighbour_free" });
    expect((await readRow(neighbour)).status).toBe("pending");

    // And a different ACTION on the same held entity is a different slot.
    const resumeRows = (await getDb().query<{ id: string }>(
      `INSERT INTO meta_automation_proposals (
         business_id, provider_account_id, origin, decision_key, scope_type,
         scope_id, rec_id, rec_type, snapshot_date, engine_version,
         decision_label, proposed_action, action_label, primary_caption,
         reason, evidence_ref, expires_at, status
       ) VALUES (
         $1::uuid, $2, 'engine_decision', 'adset:adset_slot_neighbour_held', 'adset',
         'adset_slot_neighbour_held', 'rec_resume', 'scenario_resume', CURRENT_DATE, 'meta-v3',
         'cut', 'resume', 'Resume ad set', 'Approve & apply',
         'Different action, different slot.', '{}'::jsonb,
         NOW() + INTERVAL '6 hours', 'pending'
       )
       RETURNING id::text AS id`,
      [seeded.businessId, PROVIDER_ACCOUNT_ID],
    )) as Array<{ id: string }>;
    expect(resumeRows).toHaveLength(1);
  });

  // The rule producer's own NOT EXISTS, run for real. It must not report a
  // queue row that does not exist — there is nothing approvable behind a
  // reconcile hold.
  it("tells a rule firing the slot is held for reconciliation, not queued", async () => {
    const heldId = await seedProposal({
      scopeId: "adset_slot_rule_held",
      status: "reconcile",
      claimToken: "33333333-3333-4333-8333-333333333333",
      dispatchStarted: true,
    });

    const raised = await store.raiseRuleAutomationProposal({
      businessId: seeded.businessId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      ruleId: "44444444-4444-4444-8444-444444444444",
      dedupeKey: `rule:adset_slot_rule_held:${new Date().toISOString().slice(0, 10)}`,
      scopeType: "adset",
      scopeId: "adset_slot_rule_held",
      proposedAction: "pause",
      entityLabel: null,
      reason: "ROAS below breakeven.",
      evidenceLabel: null,
      evidenceRef: {},
      evaluatedForDate: new Date().toISOString().slice(0, 10),
    });

    expect(raised.status).toBe("held_for_reconciliation");
    expect(raised.proposalId).toBe(heldId);
    // And no second row was created behind the hold.
    const count = (await getDb().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM meta_automation_proposals
       WHERE business_id = $1::uuid AND decision_key = 'adset:adset_slot_rule_held'`,
      [seeded.businessId],
    )) as Array<{ count: string }>;
    expect(count[0]!.count).toBe("1");
    expect(providerCalls).toHaveLength(0);
  });

  // The whole point of holding the slot: the row cannot be picked up again by
  // the approve path either. `claimMetaAutomationProposal` requires `pending`.
  it("cannot be re-claimed, so no second dispatch path exists", async () => {
    const heldId = await seedProposal({
      scopeId: "adset_slot_reclaim",
      status: "reconcile",
      claimToken: "33333333-3333-4333-8333-333333333334",
      dispatchStarted: true,
    });

    const claim = await store.claimMetaAutomationProposal({
      businessId: seeded.businessId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      proposalId: heldId,
      claimedBy: seeded.userId,
    });
    expect(claim.status).toBe("conflict");
    expect((await readRow(heldId)).status).toBe("reconcile");

    const response = await POST(approveRequest(heldId));
    expect(response.status).toBe(409);
    expect(providerCalls).toHaveLength(0);
  });

  it("withdraws, re-offers, and revokes pause authority per provider account", async () => {
    const siblingAccount = "act_reconcile_sibling";
    const sharedScopeId = "adset_same_external_id";
    const todayRows = (await getDb().query<{ today: string }>(
      `SELECT CURRENT_DATE::text AS today`,
    )) as Array<{ today: string }>;
    const today = todayRows[0]!.today;

    // Earlier cases intentionally leave one untouched pending row behind. This
    // case measures a business-wide reconciliation, so isolate its candidate
    // set before asserting the exact withdrawal count.
    await getDb().query(
      `DELETE FROM meta_automation_proposals
        WHERE business_id = $1::uuid AND status = 'pending'
          AND claim_token IS NULL AND dispatch_started_at IS NULL`,
      [seeded.businessId],
    );
    await getDb().query(
      `DELETE FROM meta_decision_snapshots_daily
        WHERE business_id = $1 AND snapshot_date = CURRENT_DATE`,
      [seeded.businessId],
    );

    for (const accountId of [PROVIDER_ACCOUNT_ID, siblingAccount]) {
      await getDb().query(
        `INSERT INTO meta_adset_dimensions
           (business_id, provider_account_id, campaign_id, adset_id,
            adset_name_current, adset_status)
         VALUES ($1::uuid, $2, 'camp_shared', $3, 'Shared external id', 'ACTIVE')
         ON CONFLICT DO NOTHING`,
        [seeded.businessId, accountId, sharedScopeId],
      );
      await getDb().query(
        `INSERT INTO meta_decision_snapshots_daily (
           scope_type, scope_id, business_id, snapshot_date, rec_id, rec_type,
           level, decision_state, evidence, recommended_action, target_value,
           reasoning, engine_version, kind, decision_label, provider_account_id
         ) VALUES (
           'adset', $1, $2, $3::date, 'rec_reconcile',
           'scenario_reconcile_cut', 'adset', 'act', '{}'::jsonb,
           'Pause this ad set.', NULL, 'ROAS is below the configured floor.',
           'meta-v3', 'recommendation', 'cut', $4
         )`,
        [sharedScopeId, seeded.businessId, today, accountId],
      );
    }

    const primaryId = await seedProposal({
      scopeId: sharedScopeId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    });
    const siblingId = await seedProposal({
      scopeId: sharedScopeId,
      providerAccountId: siblingAccount,
    });

    const preRefresh = await store.reconcileMetaEngineDecisionProposalsForSnapshot({
      businessId: seeded.businessId,
      snapshotDate: today,
      attemptedProviderAccountIds: [PROVIDER_ACCOUNT_ID, siblingAccount],
      fulfilledProviderAccountIds: [],
    });
    expect(preRefresh).toEqual({ ran: true, withdrawn: 2 });
    expect(await readRow(primaryId)).toMatchObject({
      status: "expired",
      decision_note: "engine_decision_source_withdrawn",
    });
    expect(await readRow(siblingId)).toMatchObject({
      status: "expired",
      decision_note: "engine_decision_source_withdrawn",
    });

    const projected = await store.projectMetaAutomationProposals({
      businessId: seeded.businessId,
      snapshotDate: today,
      providerAccountIds: [PROVIDER_ACCOUNT_ID],
      readModes: async () => ({ pause: "semi_auto" }) as never,
    });
    expect(projected.projected).toBe(1);
    expect(await readRow(primaryId)).toMatchObject({
      status: "pending",
      decision_note: null,
    });
    expect(await readRow(siblingId)).toMatchObject({
      status: "expired",
      decision_note: "engine_decision_source_withdrawn",
    });

    await getDb().query(
      `UPDATE meta_decision_snapshots_daily
          SET decision_state = 'watch'
        WHERE business_id = $1 AND provider_account_id = $2
          AND snapshot_date = $3::date AND scope_id = $4
          AND rec_type = 'scenario_reconcile_cut'`,
      [seeded.businessId, PROVIDER_ACCOUNT_ID, today, sharedScopeId],
    );
    const staleClaim = await store.claimMetaAutomationProposal({
      businessId: seeded.businessId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      proposalId: primaryId,
      claimedBy: seeded.userId,
    });
    expect(staleClaim.status).toBe("conflict");
    expect(providerCalls).toHaveLength(0);

    const downgraded = await store.reconcileMetaEngineDecisionProposalsForSnapshot({
      businessId: seeded.businessId,
      snapshotDate: today,
      attemptedProviderAccountIds: [PROVIDER_ACCOUNT_ID],
      fulfilledProviderAccountIds: [PROVIDER_ACCOUNT_ID],
    });
    expect(downgraded).toEqual({ ran: true, withdrawn: 1 });
    expect(await readRow(primaryId)).toMatchObject({
      status: "expired",
      decision_note: "engine_decision_source_withdrawn",
    });
  });
});

describe.runIf(SEAM)("releasing a reconcile row", () => {
  async function seedHeldAttempt(scopeId: string, claimToken: string) {
    const proposalId = await seedProposal({
      scopeId,
      status: "reconcile",
      claimToken,
      dispatchStarted: true,
    });
    const appended = await reconciliation.appendMetaAutomationReconciliationReceipt(
      {
        businessId: seeded.businessId,
        proposalId,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        decisionKey: `adset:${scopeId}`,
        proposedAction: "pause",
        claimToken,
        reason: "dispatch_no_answer",
        facts: {
          providerDispatchStarted: true,
          providerOutcomeKnown: false,
          providerWriteVerified: false,
        },
        receipt: {
          httpStatus: 0,
          response: null,
          dryRun: false,
          dispatchedAt: new Date().toISOString(),
          endpoint: `/api/meta/adsets/${scopeId}/pause`,
          withheld: null,
          receiptKey: claimToken,
          ambiguous: true,
        },
      },
    );
    expect(appended.status).toBe("recorded");
    return proposalId;
  }

  // An inconclusive read is a first-class answer. "I could not tell" must never
  // become "nothing happened".
  it("keeps the slot held when the fresh read is inconclusive", async () => {
    const token = "55555555-5555-4555-8555-555555555551";
    const proposalId = await seedHeldAttempt("adset_release_inconclusive", token);

    const result = await reconciliation.resolveMetaAutomationProposalReconciliation({
      businessId: seeded.businessId,
      proposalId,
      claimToken: token,
      resolvedBy: seeded.userId,
      expectedEntityStatus: "PAUSED",
      read: { status: "inconclusive", reason: "provider returned 500" },
    });

    expect(result).toEqual({ status: "held", code: "read_inconclusive" });
    expect((await readRow(proposalId)).status).toBe("reconcile");
    const receipt = await reconciliation.readMetaAutomationReconciliationReceipt({
      businessId: seeded.businessId,
      claimToken: token,
    });
    expect(receipt?.resolution).toBeNull();
    expect(providerCalls).toHaveLength(0);
  });

  // A stale read describes a world that may have moved. It cannot release a slot.
  it("refuses a read that is too old, and one taken before the dispatch", async () => {
    const token = "55555555-5555-4555-8555-555555555552";
    const proposalId = await seedHeldAttempt("adset_release_stale", token);

    expect(
      await reconciliation.resolveMetaAutomationProposalReconciliation({
        businessId: seeded.businessId,
        proposalId,
        claimToken: token,
        resolvedBy: seeded.userId,
        expectedEntityStatus: "PAUSED",
        read: {
          status: "observed",
          observedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          entityStatus: "PAUSED",
        },
      }),
    ).toEqual({ status: "held", code: "read_stale" });

    expect(
      await reconciliation.resolveMetaAutomationProposalReconciliation({
        businessId: seeded.businessId,
        proposalId,
        claimToken: token,
        resolvedBy: seeded.userId,
        expectedEntityStatus: "PAUSED",
        read: {
          status: "observed",
          // Inside the freshness window, but BEFORE the dispatch it judges.
          observedAt: new Date(Date.now() - 60 * 1000).toISOString(),
          entityStatus: "PAUSED",
        },
      }),
    ).toEqual({ status: "held", code: "read_precedes_dispatch" });

    expect((await readRow(proposalId)).status).toBe("reconcile");
  });

  it("releases the slot on a fresh conclusive read, and records it immutably", async () => {
    const token = "55555555-5555-4555-8555-555555555553";
    const proposalId = await seedHeldAttempt("adset_release_confirmed", token);

    const result = await reconciliation.resolveMetaAutomationProposalReconciliation({
      businessId: seeded.businessId,
      proposalId,
      claimToken: token,
      resolvedBy: seeded.userId,
      expectedEntityStatus: "PAUSED",
      read: {
        status: "observed",
        observedAt: new Date().toISOString(),
        entityStatus: "PAUSED",
        evidence: { source: "fake provider read" },
      },
    });

    expect(result).toEqual({
      status: "resolved",
      resolution: "provider_write_confirmed",
      proposalStatus: "approved",
    });
    expect((await readRow(proposalId)).status).toBe("approved");

    // Immutable: the attempt's own facts cannot be rewritten afterwards, and
    // the resolution cannot be replaced. Enforced by the database, so a later
    // "just fix the flag" UPDATE cannot erase the evidence.
    await expect(
      getDb().query(
        `UPDATE meta_automation_reconciliation_receipts
         SET provider_write_verified = TRUE
         WHERE claim_token = $1::uuid`,
        [token],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      getDb().query(
        `UPDATE meta_automation_reconciliation_receipts
         SET resolution = 'provider_write_absent'
         WHERE claim_token = $1::uuid`,
        [token],
      ),
    ).rejects.toThrow(/append-only/);

    expect(providerCalls).toHaveLength(0);
  });

  it("records an absent write as failed rather than as a silent success", async () => {
    const token = "55555555-5555-4555-8555-555555555554";
    const proposalId = await seedHeldAttempt("adset_release_absent", token);

    const result = await reconciliation.resolveMetaAutomationProposalReconciliation({
      businessId: seeded.businessId,
      proposalId,
      claimToken: token,
      resolvedBy: seeded.userId,
      expectedEntityStatus: "PAUSED",
      read: {
        status: "observed",
        observedAt: new Date().toISOString(),
        entityStatus: "ACTIVE",
      },
    });

    expect(result).toEqual({
      status: "resolved",
      resolution: "provider_write_absent",
      proposalStatus: "failed",
    });
    expect((await readRow(proposalId)).status).toBe("failed");
    // Resolving does NOT re-dispatch. Re-raising the decision belongs to the
    // next snapshot's projection, with fresh evidence.
    expect(providerCalls).toHaveLength(0);
  });

  // One receipt per attempt, and the first write of the facts wins.
  it("never lets one attempt hold two reconciliation receipts", async () => {
    const token = "55555555-5555-4555-8555-555555555555";
    const proposalId = await seedHeldAttempt("adset_release_duplicate", token);

    const second = await reconciliation.appendMetaAutomationReconciliationReceipt({
      businessId: seeded.businessId,
      proposalId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      decisionKey: "adset:adset_release_duplicate",
      proposedAction: "pause",
      claimToken: token,
      reason: "settle_failed_after_dispatch",
      facts: {
        providerDispatchStarted: true,
        providerOutcomeKnown: true,
        providerWriteVerified: true,
      },
      receipt: null,
    });

    expect(second.status).toBe("already_recorded");
    const stored = await reconciliation.readMetaAutomationReconciliationReceipt({
      businessId: seeded.businessId,
      claimToken: token,
    });
    // The FIRST write's facts survived. A repeat cannot upgrade an unknown
    // outcome into a verified one.
    expect(stored?.reason).toBe("dispatch_no_answer");
    expect(stored?.providerWriteVerified).toBe(false);
    expect(stored?.providerOutcomeKnown).toBe(false);
  });
});

describe.runIf(SEAM)("the post-dispatch settle exception", () => {
  it(
    "calls the provider once, refuses success, keeps the receipt, and blocks re-dispatch",
    async () => {
      const proposalId = await seedProposal({ scopeId: "adset_settle_throws" });

      // The injection. The provider answers; the write that has to record its
      // answer throws — and so does the ledger, so the ONLY durable place left
      // is the reconciliation outbox and the proposal row's own status.
      const settleSpy = vi
        .spyOn(store, "settleMetaAutomationProposal")
        .mockRejectedValue(new Error("injected: settle failed after dispatch"));
      const ledgerSpy = vi
        .spyOn(controlPlane, "writeActivityLedgerRow")
        .mockRejectedValue(new Error("injected: ledger insert failed"));

      let body: Record<string, unknown>;
      let status: number;
      try {
        const response = await POST(approveRequest(proposalId));
        status = response.status;
        body = (await response.json()) as Record<string, unknown>;
      } finally {
        settleSpy.mockRestore();
        ledgerSpy.mockRestore();
      }

      // EXACTLY ONCE. Nothing on this path re-enters the dispatch.
      expect(providerCalls).toHaveLength(1);
      expect(providerCalls[0]!.proposalId).toBe(proposalId);
      const claimToken = providerCalls[0]!.receiptKey;
      expect(claimToken).toBeTruthy();

      // NOT a success, and not the generic 500 this used to fall into.
      expect(body.ok).toBe(false);
      expect(status).toBe(502);
      expect((body.error as { code: string }).code).toBe(
        "proposal_reconciliation_required",
      );
      expect((body.error as { code: string }).code).not.toBe(
        "proposal_action_failed",
      );
      expect(body.receiptKey).toBe(claimToken);
      expect(body.receipt).not.toBeNull();
      // ITEM 3's tri-state, on the wire: unknown, never "no write".
      expect(body.providerDispatchStarted).toBe(true);
      expect(body.providerOutcomeKnown).toBe(false);
      expect(body.providerWriteVerified).toBe(false);

      // The claim moved to `reconcile` through a statement that shares nothing
      // with the settle that failed.
      const row = await readRow(proposalId);
      expect(row.status).toBe("reconcile");
      expect(row.claim_token).toBe(claimToken);
      expect(row.dispatch_started_at).not.toBeNull();

      // The receipt and the claim token are findable in the durable store that
      // remains, keyed by the attempt.
      const stored = await reconciliation.readMetaAutomationReconciliationReceipt(
        { businessId: seeded.businessId, claimToken: claimToken! },
      );
      expect(stored).not.toBeNull();
      expect(stored!.reason).toBe("settle_failed_after_dispatch");
      expect(stored!.providerDispatchStarted).toBe(true);
      expect(stored!.providerOutcomeKnown).toBe(false);
      expect(stored!.providerWriteVerified).toBe(false);
      expect(stored!.receipt?.receiptKey).toBe(claimToken);
      expect(stored!.resolution).toBeNull();

      // RE-DISPATCH IS REFUSED — and refused EARLIER than expected, which is
      // worth pinning rather than papering over. The row is now `reconcile`, so
      // `evaluateProposalTransition` refuses it as `proposal_not_pending`
      // before the approve path is entered at all; the claim's own
      // compare-and-set (which requires `status = 'pending'`) is the second
      // lock behind it. The load-bearing assertion is the provider count, and
      // the code is pinned so a future change that lets this reach the claim
      // gate has to say so out loud.
      const retry = await POST(approveRequest(proposalId));
      expect(retry.status).toBe(409);
      expect((await retry.json()).error.code).toBe("proposal_not_pending");
      expect(providerCalls).toHaveLength(1);
    },
  );

  it("could not have reached a real provider at all", async () => {
    // Belt and braces on the safety claim this whole file rests on: the only
    // module in the tree that can call Meta from this path is the executor, and
    // it is a vitest mock for the entire file.
    expect(vi.isMockFunction(executor.executeMetaAutomationProposal)).toBe(true);
  });
});

describe.runIf(SEAM)("native proposal generation authority", () => {
  it("hides and refuses to claim the retained cut after a newer failed or account-incomplete generation", async () => {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) throw new Error("ephemeral DATABASE_URL is missing");
    const client = new Client({ connectionString });
    await client.connect();

    const businessId = "a1100000-0000-4000-8000-000000000001";
    const otherBusinessId = "a1100000-0000-4000-8000-000000000002";
    const accountId = "act_native_generation_authority";
    const accountRefId = "a1200000-0000-4000-8000-000000000001";
    const otherAccountId = "act_native_generation_other";
    const decisionId = "a1300000-0000-4000-8000-000000000001";
    const evaluationId = "a1400000-0000-4000-8000-000000000001";
    const successfulRunId = "a1500000-0000-4000-8000-000000000001";
    const failedRunId = "a1500000-0000-4000-8000-000000000002";
    const proposalId = "a1600000-0000-4000-8000-000000000001";
    const adId = "ad_native_generation_authority";
    const creativeId = "creative_native_generation_authority";
    const decisionHash = "d".repeat(64);
    const manifestHash = "e".repeat(64);
    const decisionKey = `ad:${adId}`;
    const completeReceipt = {
      provider_account_ref_id: accountRefId,
      provider_account_id: accountId,
      expected_ad_count: 1,
      expected_manifest_hash: manifestHash,
      hydrated_ad_count: 1,
      hydrated_manifest_hash: manifestHash,
      authoritative_for_prune: true,
    };

    try {
      /*
        These are session-local source/queue tables with the production columns
        the predicate reads. PostgreSQL evaluates the exact production
        predicate below; no mock decides which generation is authoritative.
      */
      await client.query(`
        CREATE TEMP TABLE engine_v3_job_runs (
          id UUID PRIMARY KEY,
          job_name TEXT NOT NULL,
          business_ref_id UUID NOT NULL,
          business_id TEXT,
          as_of_date DATE NOT NULL,
          engine_version TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL,
          finished_at TIMESTAMPTZ,
          error_message TEXT,
          error_json JSONB
        );
        CREATE TEMP TABLE engine_v3_ad_decision_snapshots_daily (
          id UUID PRIMARY KEY,
          business_id TEXT NOT NULL,
          provider_account_ref_id UUID NOT NULL,
          provider_account_id TEXT NOT NULL,
          ad_id TEXT NOT NULL,
          creative_id TEXT,
          as_of_date DATE NOT NULL,
          engine_version TEXT NOT NULL,
          label TEXT NOT NULL,
          authorized_action TEXT,
          job_run_id UUID NOT NULL,
          evaluation_id UUID NOT NULL,
          decision_hash TEXT NOT NULL,
          computed_at TIMESTAMPTZ NOT NULL
        );
        CREATE TEMP TABLE native_proposal_fixture (
          id UUID PRIMARY KEY,
          business_id UUID NOT NULL,
          provider_account_id TEXT NOT NULL,
          snapshot_date DATE NOT NULL,
          scope_id TEXT NOT NULL,
          rec_id TEXT NOT NULL,
          engine_version TEXT NOT NULL,
          decision_key TEXT NOT NULL,
          evidence_ref JSONB NOT NULL,
          claimed BOOLEAN NOT NULL DEFAULT FALSE
        );
      `);
      await client.query(
        `INSERT INTO engine_v3_job_runs (
           id, job_name, business_ref_id, business_id, as_of_date,
           engine_version, status, started_at, finished_at, error_json
         ) VALUES (
           $1::uuid, 'engine_v3_native_ad_decisions_shadow_job',
           $2::uuid, $2::text,
           (statement_timestamp() AT TIME ZONE 'UTC')::date,
           $3, 'success',
           NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '29 minutes',
           $4::jsonb
         )`,
        [
          successfulRunId,
          businessId,
          NATIVE_AD_ENGINE_VERSION,
          JSON.stringify({
            metadata: { hydration_receipts: [completeReceipt] },
          }),
        ],
      );
      await client.query(
        `INSERT INTO engine_v3_ad_decision_snapshots_daily (
           id, business_id, provider_account_ref_id, provider_account_id,
           ad_id, creative_id, as_of_date, engine_version, label,
           authorized_action, job_run_id, evaluation_id, decision_hash,
           computed_at
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4, $5, $6,
           (statement_timestamp() AT TIME ZONE 'UTC')::date, $7,
           'cut', 'cut', $8::uuid, $9::uuid, $10,
           NOW() - INTERVAL '29 minutes'
         )`,
        [
          decisionId,
          businessId,
          accountRefId,
          accountId,
          adId,
          creativeId,
          NATIVE_AD_ENGINE_VERSION,
          successfulRunId,
          evaluationId,
          decisionHash,
        ],
      );
      await client.query(
        `INSERT INTO native_proposal_fixture (
           id, business_id, provider_account_id, snapshot_date, scope_id,
           rec_id, engine_version, decision_key, evidence_ref
         ) VALUES (
           $1::uuid, $2::uuid, $3,
           (statement_timestamp() AT TIME ZONE 'UTC')::date,
           $4, $5, $6, $7, $8::jsonb
         )`,
        [
          proposalId,
          businessId,
          accountId,
          adId,
          evaluationId,
          NATIVE_AD_ENGINE_VERSION,
          decisionKey,
          JSON.stringify({
            snapshotId: decisionId,
            evaluationId,
            creativeId,
            decisionHash,
            decisionKey,
            snapshotDate: new Date().toISOString().slice(0, 10),
          }),
        ],
      );

      const predicate = store.currentNativeAdDecisionSourcePredicate(
        "proposal",
        true,
      );
      const read = () =>
        client.query<{ id: string }>(
          `SELECT proposal.id::text AS id
             FROM native_proposal_fixture proposal
            WHERE proposal.id = $1::uuid
              AND ${predicate}`,
          [proposalId],
        );
      const claim = () =>
        client.query<{ id: string }>(
          `UPDATE native_proposal_fixture proposal
              SET claimed = TRUE
            WHERE proposal.id = $1::uuid
              AND proposal.claimed = FALSE
              AND ${predicate}
          RETURNING proposal.id::text AS id`,
          [proposalId],
        );

      expect((await read()).rows.map((row) => row.id)).toEqual([proposalId]);

      // A later failure from another business, an older day, or another job is
      // outside this source's authority boundary and must not revoke it.
      await client.query(
        `INSERT INTO engine_v3_job_runs (
           id, job_name, business_ref_id, business_id, as_of_date,
           engine_version, status, started_at, finished_at
         ) VALUES
           (gen_random_uuid(), 'engine_v3_native_ad_decisions_shadow_job',
            $1::uuid, $1::text,
            (statement_timestamp() AT TIME ZONE 'UTC')::date,
            $3, 'failed',
            NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '4 minutes'),
           (gen_random_uuid(), 'engine_v3_native_ad_decisions_shadow_job',
            $2::uuid, $2::text,
            (statement_timestamp() AT TIME ZONE 'UTC')::date - 1,
            $3, 'failed',
            NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '2 minutes'),
           (gen_random_uuid(), 'engine_v3_native_ad_operator_response_shadow_job',
            $2::uuid, $2::text,
            (statement_timestamp() AT TIME ZONE 'UTC')::date,
            $3, 'failed',
            NOW() - INTERVAL '1 minute', NOW())`,
        [otherBusinessId, businessId, NATIVE_AD_ENGINE_VERSION],
      );
      expect((await read()).rows).toHaveLength(1);

      // This is the production failure: it writes no replacement decision row.
      // The morning row is still the latest row, but no longer belongs to the
      // latest authoritative generation.
      await client.query(
        `INSERT INTO engine_v3_job_runs (
           id, job_name, business_ref_id, business_id, as_of_date,
           engine_version, status, started_at, finished_at, error_message
         ) VALUES (
           $1::uuid, 'engine_v3_native_ad_decisions_shadow_job',
           $2::uuid, $2::text,
           (statement_timestamp() AT TIME ZONE 'UTC')::date,
           $3, 'failed',
           NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '4 minutes',
           'injected newer generation failure'
         )`,
        [failedRunId, businessId, NATIVE_AD_ENGINE_VERSION],
      );
      expect((await read()).rows).toHaveLength(0);
      expect((await claim()).rows).toHaveLength(0);
      expect(
        (
          await client.query<{ claimed: boolean }>(
            `SELECT claimed FROM native_proposal_fixture WHERE id = $1::uuid`,
            [proposalId],
          )
        ).rows[0]?.claimed,
      ).toBe(false);

      // A nominally successful run without exactly one complete receipt for
      // this provider account is unavailable for this account and also closed.
      await client.query(`DELETE FROM engine_v3_job_runs WHERE id = $1::uuid`, [
        failedRunId,
      ]);
      await client.query(
        `UPDATE engine_v3_job_runs
            SET error_json = $2::jsonb
          WHERE id = $1::uuid`,
        [
          successfulRunId,
          JSON.stringify({
            metadata: {
              hydration_receipts: [
                { ...completeReceipt, provider_account_id: otherAccountId },
              ],
            },
          }),
        ],
      );
      expect((await read()).rows).toHaveLength(0);
      expect((await claim()).rows).toHaveLength(0);

      // Positive control for the same guarded UPDATE after authority returns.
      await client.query(
        `UPDATE engine_v3_job_runs
            SET error_json = $2::jsonb
          WHERE id = $1::uuid`,
        [
          successfulRunId,
          JSON.stringify({
            metadata: { hydration_receipts: [completeReceipt] },
          }),
        ],
      );
      expect((await claim()).rows.map((row) => row.id)).toEqual([proposalId]);
    } finally {
      await client.end();
    }
  });
});
