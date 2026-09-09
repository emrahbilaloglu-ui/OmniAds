/**
 * The execution claim, against a REAL PostgreSQL and a FAKE provider.
 *
 * This file is the proof for one sentence: **two concurrent approvals of the
 * same proposal reach the provider exactly once.** Nothing about that is
 * provable with a mocked database. The guarantee is PostgreSQL's — one
 * `UPDATE ... WHERE status = 'pending' RETURNING` returns a row to exactly one
 * of N concurrent sessions — so only real sessions racing a real row can show
 * it. A mocked `settleMetaAutomationProposal` proves the route calls something;
 * it cannot prove the something is exclusive.
 *
 * What is real here: the route handler, the store, the migrations, the
 * database, the concurrency. What is fake: the provider. The executor is
 * replaced by a counting stub, so this test can never perform a Meta write —
 * and its call count is the number the concurrency claim is actually about.
 *
 * Run by `scripts/ephemeral-postgres-automation-claim-race-seam.ts`, which
 * boots a throwaway cluster on a random free port (never 5432, never 15432),
 * migrates it from zero, and points `DATABASE_URL` at it. Outside that harness
 * every test below is skipped rather than silently run against whatever
 * `DATABASE_URL` happens to be — which, in this repo, is production.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

const PROVIDER_ACCOUNT_ID = "act_claim_race";

/** Every fake dispatch this file performs. Real provider writes: zero. */
const providerCalls: Array<{ proposalId: string; receiptKey: string | null }> =
  [];

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(async () => ({
    session: { user: { id: seeded.userId, email: "race@example.invalid" } },
    membership: { businessId: seeded.businessId, role: "collaborator" },
  })),
}));

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(async () => [PROVIDER_ACCOUNT_ID]),
}));

/**
 * The fake provider.
 *
 * It sleeps, deliberately. A dispatch that returned instantly would let the
 * winner settle before the loser even reached the claim, which would test
 * sequential requests wearing the word "concurrent". The sleep holds the claim
 * open across the whole race.
 */
vi.mock("@/lib/meta/automation-proposal-execution", () => ({
  executeMetaAutomationProposal: vi.fn(
    async (input: {
      proposal: { id: string };
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
      await new Promise((resolve) => setTimeout(resolve, 60));
      return {
        ok: true,
        receipt: {
          httpStatus: 200,
          response: { ok: true, fakeProvider: true },
          // The seam injects a live provider answer to exercise the execution
          // claim independently of the host's release gate. No provider client
          // is imported; this remains a counting fake.
          dryRun: false,
          dispatchedAt: new Date().toISOString(),
          endpoint: `/api/meta/adsets/${input.proposal.id}/pause`,
          withheld: null,
          receiptKey: input.receiptKey ?? null,
          providerMutationAttempted: true,
        },
      };
    },
  ),
}));

const seeded = {
  businessId: "",
  userId: "",
};

const { getDb, resetDbClientCache } = await import("@/lib/db");
const store = await import("@/lib/meta/automation-proposals");
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

function decideRequest(proposalId: string, action: "modify" | "dismiss") {
  return new NextRequest(URL_BASE(), {
    method: "POST",
    body: JSON.stringify({
      proposalId,
      action,
      ...(action === "modify" ? { note: "Cut 30% instead." } : {}),
    }),
  });
}

async function seedProposal(scopeId: string) {
  /*
    The claim now re-proves the exact current decision inside its atomic UPDATE.
    Each race row therefore needs the real source it claims to project; a bare
    queue fixture would correctly be unclaimable and would test no race at all.
  */
  await getDb().query(
    `INSERT INTO meta_adset_dimensions
       (business_id, provider_account_id, campaign_id, adset_id,
        adset_name_current, adset_status)
     VALUES ($1::uuid, $2, 'camp_race', $3, 'Race ad set', 'ACTIVE')
     ON CONFLICT DO NOTHING`,
    [seeded.businessId, PROVIDER_ACCOUNT_ID, scopeId],
  );
  await getDb().query(
    `INSERT INTO meta_decision_snapshots_daily (
       scope_type, scope_id, business_id, snapshot_date, rec_id, rec_type,
       level, decision_state, evidence, recommended_action, target_value,
       reasoning, engine_version, kind, decision_label, provider_account_id
     ) VALUES (
       'adset', $1, $2, CURRENT_DATE, 'rec_race', 'scenario_race_cut',
       'adset', 'act', '{}'::jsonb, 'Pause this ad set.', NULL,
       'ROAS below breakeven for 6 days.', 'meta-v3', 'recommendation', 'cut', $3
     )
     ON CONFLICT DO NOTHING`,
    [scopeId, seeded.businessId, PROVIDER_ACCOUNT_ID],
  );
  const rows = (await getDb().query<{ id: string }>(
    `
      INSERT INTO meta_automation_proposals (
        business_id, provider_account_id, origin, decision_key, scope_type,
        scope_id, rec_id, rec_type, snapshot_date, engine_version,
        decision_label, proposed_action, action_label, primary_caption,
        entity_label, reason, evidence_label, evidence_ref, expires_at, status
      ) VALUES (
        $1::uuid, $2, 'engine_decision', $3, 'adset',
        $4, 'rec_race', 'scenario_race_cut', CURRENT_DATE, 'meta-v3',
        'cut', 'pause', 'Pause ad set', 'Approve & apply',
        'Race ad set', 'ROAS below breakeven for 6 days.', 'frees $680/d',
        '{}'::jsonb, NOW() + INTERVAL '6 hours', 'pending'
      )
      RETURNING id::text AS id
    `,
    [seeded.businessId, PROVIDER_ACCOUNT_ID, `adset:${scopeId}`, scopeId],
  )) as Array<{ id: string }>;
  return rows[0]!.id;
}

async function readRow(proposalId: string) {
  const rows = (await getDb().query<{
    status: string;
    claim_token: string | null;
    dispatch_started_at: string | null;
    receipt_json: { receiptKey?: string | null } | null;
  }>(
    `SELECT status, claim_token::text AS claim_token, dispatch_started_at, receipt_json
     FROM meta_automation_proposals WHERE id = $1::uuid`,
    [proposalId],
  )) as Array<{
    status: string;
    claim_token: string | null;
    dispatch_started_at: string | null;
    receipt_json: { receiptKey?: string | null } | null;
  }>;
  return rows[0]!;
}

describe.runIf(SEAM)("the execution claim under real concurrency", () => {
  beforeAll(async () => {
    resetDbClientCache();
    const db = getDb();
    const users = (await db.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Claim race operator', 'claim-race@example.invalid', 'x')
       RETURNING id::text AS id`,
    )) as Array<{ id: string }>;
    seeded.userId = users[0]!.id;
    const businesses = (await db.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id)
       VALUES ('Claim race business', $1::uuid)
       RETURNING id::text AS id`,
      [seeded.userId],
    )) as Array<{ id: string }>;
    seeded.businessId = businesses[0]!.id;

    // A REAL persisted control row: the approve path refuses anything whose
    // supervised posture is merely defaulted, so without this the race would
    // never reach the claim and the test would pass for the wrong reason.
    await db.query(
      `INSERT INTO meta_automation_business_controls
         (business_id, kill_switch_engaged, auto_execution_enabled, readiness_tier)
       VALUES ($1::uuid, FALSE, FALSE, 'manual_review')`,
      [seeded.businessId],
    );
    await db.query(
      `INSERT INTO meta_adset_dimensions
         (business_id, provider_account_id, campaign_id, adset_id, adset_name_current)
       VALUES ($1::uuid, $2, 'camp_race', 'adset_race_1', 'Race ad set')`,
      [seeded.businessId, PROVIDER_ACCOUNT_ID],
    );
  });

  afterEach(() => {
    providerCalls.length = 0;
  });

  it("dispatches exactly once when eight approvals race the same proposal", async () => {
    const proposalId = await seedProposal("adset_race_1");

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => POST(approveRequest(proposalId))),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));

    // THE assertion. One fake provider dispatch for eight parallel approvals.
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]!.proposalId).toBe(proposalId);

    const winners = responses.filter((r) => r.status === 200);
    const losers = responses.filter((r) => r.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);

    // Deterministic: every loser gets the same 409 and the same code, whatever
    // the winner happened to be doing at that instant.
    for (const response of losers) expect(response.status).toBe(409);
    const loserBodies = bodies.filter((body) => body.ok !== true);
    for (const body of loserBodies) {
      expect(body.error.code).toBe("proposal_claim_conflict");
      // The row's actual state travels with the refusal — `claimed` while the
      // winner is dispatching, `approved` once it has settled. Both are the
      // existing status of the existing row, never a guess.
      expect(["claimed", "approved"]).toContain(body.proposalStatus);
      if (body.proposalStatus === "approved") {
        expect(body.receipt).not.toBeNull();
      }
    }

    const row = await readRow(proposalId);
    expect(row.status).toBe("approved");
    expect(row.claim_token).toBe(providerCalls[0]!.receiptKey);
    expect(row.dispatch_started_at).not.toBeNull();
    // The auditable link: the key on the row is the key in the receipt.
    expect(row.receipt_json?.receiptKey).toBe(row.claim_token);
  });

  it("holds for five distinct proposals raced in parallel, so no run is luck", async () => {
    const proposalIds = await Promise.all(
      [2, 3, 4, 5, 6].map((index) => seedProposal(`adset_race_${index}`)),
    );

    await Promise.all(
      proposalIds.flatMap((proposalId) =>
        Array.from({ length: 4 }, () => POST(approveRequest(proposalId))),
      ),
    );

    // Twenty parallel approvals over five proposals: five dispatches, one each.
    expect(providerCalls).toHaveLength(5);
    expect(new Set(providerCalls.map((call) => call.proposalId)).size).toBe(5);
    for (const proposalId of proposalIds) {
      expect((await readRow(proposalId)).status).toBe("approved");
    }
  });

  it("hands the claim to exactly one of sixteen parallel claimers", async () => {
    const proposalId = await seedProposal("adset_race_claim_only");

    const results = await Promise.all(
      Array.from({ length: 16 }, () =>
        store.claimMetaAutomationProposal({
          businessId: seeded.businessId,
          providerAccountId: PROVIDER_ACCOUNT_ID,
          proposalId,
          claimedBy: seeded.userId,
        }),
      ),
    );

    expect(results.filter((r) => r.status === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "conflict")).toHaveLength(15);
    // Nothing was dispatched by this test at all: the claim is not the write.
    expect(providerCalls).toHaveLength(0);
  });

  it("refuses a dismissal racing an approval rather than losing the claim", async () => {
    const proposalId = await seedProposal("adset_race_dismiss");

    const [approveResponse, dismissResponse] = await Promise.all([
      POST(approveRequest(proposalId)),
      // Started in the same tick. The approval claims the row; the dismissal
      // settles on `status = 'pending'` and therefore cannot touch it.
      POST(decideRequest(proposalId, "dismiss")),
    ]);

    // Exactly one of them may win the row, and a dismissal must never land on
    // a row that is being dispatched.
    if (approveResponse.status === 200) {
      expect(dismissResponse.status).toBe(409);
      const body = await dismissResponse.json();
      expect(["proposal_claim_conflict", "proposal_not_pending"]).toContain(
        body.error.code,
      );
      expect((await readRow(proposalId)).status).toBe("approved");
    } else {
      // The dismissal got there first: then nothing may have been dispatched.
      expect(dismissResponse.status).toBe(200);
      expect(providerCalls).toHaveLength(0);
      expect((await readRow(proposalId)).status).toBe("dismissed");
    }
  });

  it("refuses a second open row for the same entity and action", async () => {
    const proposalId = await seedProposal("adset_race_slot");
    await store.claimMetaAutomationProposal({
      businessId: seeded.businessId,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      proposalId,
      claimedBy: seeded.userId,
    });

    // The claimed row still holds the entity's action slot. Without the
    // open-slot predicate this INSERT would succeed and the queue would offer
    // the same pause twice.
    await expect(seedProposal("adset_race_slot")).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("never requeues a claim whose dispatch had started", async () => {
    const dispatched = await seedProposal("adset_race_sweep_dispatched");
    const untouched = await seedProposal("adset_race_sweep_untouched");
    for (const id of [dispatched, untouched]) {
      const claim = await store.claimMetaAutomationProposal({
        businessId: seeded.businessId,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        proposalId: id,
        claimedBy: seeded.userId,
      });
      expect(claim.status).toBe("claimed");
      if (id === dispatched && claim.status === "claimed") {
        await store.markMetaAutomationProposalDispatchStarted({
          businessId: seeded.businessId,
          proposalId: id,
          claimToken: claim.claimToken,
        });
      }
    }

    // Age both claims past the lease.
    await getDb().query(
      `UPDATE meta_automation_proposals
       SET claimed_at = NOW() - INTERVAL '30 minutes'
       WHERE id = ANY($1::uuid[])`,
      [[dispatched, untouched]],
    );

    const swept = await store.sweepStaleMetaAutomationProposalClaims({
      businessId: seeded.businessId,
    });

    expect(swept.ran).toBe(true);
    // A dispatch that started may have paused something. Requeueing it would
    // offer a second write for a write that might already exist; approving it
    // would report a success nobody observed. It waits for a human.
    expect((await readRow(dispatched)).status).toBe("reconcile");
    expect((await readRow(dispatched)).claim_token).not.toBeNull();
    // A claim that never entered the handler provably dispatched nothing, so
    // returning it to the queue is a proof, not a guess.
    expect((await readRow(untouched)).status).toBe("pending");
    expect((await readRow(untouched)).claim_token).toBeNull();
    expect(providerCalls).toHaveLength(0);
  });

  it("could not have reached a real provider at all", async () => {
    // Belt and braces on the safety claim this whole file rests on: the only
    // module in the tree that can call Meta from this path is the executor,
    // and it is a vitest mock for the entire file. If that ever stopped being
    // true, this assertion fails before any dispatch could happen.
    const executor = await import("@/lib/meta/automation-proposal-execution");
    expect(vi.isMockFunction(executor.executeMetaAutomationProposal)).toBe(true);
  });
});
