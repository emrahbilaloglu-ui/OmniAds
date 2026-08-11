// Child of ephemeral-postgres-migrations-check: proves the workflow overlay's
// atomicity and idempotency against real storage.
//
// Both claims are ones a mocked test cannot make. "State and journal are
// written together" is only true if a failed event insert actually rolls the
// state back, and "a retry is a no-op" is only true if the unique index really
// refuses the second row. Both need a real transaction and a real constraint.
//
// DATABASE_URL is pre-set by the parent to the ephemeral server.
import { getDb } from "@/lib/db";
import { persistWorkflowTransition, readWorkflowRecord } from "@/lib/decision-workflow-store";
import { applyWorkflowTransition, newWorkflowRecord } from "@/lib/decision-workflow";

const LABEL = "workflow-overlay-seam";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

function expectTrue(value: boolean, label: string, detail?: string) {
  if (!value) fail(label, detail);
}

const USER_ID = "c0000000-0000-4000-8000-000000000001";
const BUSINESS_ID = "c0000000-0000-4000-8000-0000000000b1";
const MUTATION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

async function eventCount(decisionKey: string): Promise<number> {
  const rows = (await getDb().query(
    `SELECT count(*)::int AS n FROM decision_workflow_events
     WHERE business_id = $1 AND decision_key = $2`,
    [BUSINESS_ID, decisionKey],
  )) as unknown as Array<{ n: number }>;
  return rows[0]!.n;
}

async function seed() {
  const sql = getDb();
  await sql.query(
    `INSERT INTO users (id, email, name, password_hash)
     VALUES ($1::uuid, 'workflow@example.com', 'Seed', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  await sql.query(
    `INSERT INTO businesses (id, name, owner_id, currency, timezone)
     VALUES ($1::uuid, 'Workflow Seam', $2::uuid, 'USD', 'UTC')
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID, USER_ID],
  );
}

/** Drives one transition through the real state machine and store. */
async function transition(decisionKey: string, options: { mutationId?: string | null } = {}) {
  const current =
    (await readWorkflowRecord({ businessId: BUSINESS_ID, decisionKey })) ??
    newWorkflowRecord({ businessId: BUSINESS_ID, decisionKey });

  const outcome = applyWorkflowTransition({
    current,
    action: "acknowledge",
    actorUserId: USER_ID,
    expectedVersion: current.stateVersion,
  });
  if (!outcome.ok) fail("transition applied", outcome.reason);

  return persistWorkflowTransition({
    next: outcome.next,
    expectedVersion: current.stateVersion,
    entityType: "creative",
    entityId: decisionKey,
    providerAccountId: null,
    mutationId: options.mutationId ?? null,
    event: outcome.event,
  });
}

async function main() {
  await seed();

  // --------------------------------------------------- state and journal
  const first = await transition("dec_basic");
  expectTrue(first.ok, "first transition persists");
  expectEqual(await eventCount("dec_basic"), 1, "one event recorded");

  const afterFirst = await readWorkflowRecord({ businessId: BUSINESS_ID, decisionKey: "dec_basic" });
  expectEqual(afterFirst?.state, "acknowledged", "state moved");
  expectEqual(afterFirst?.stateVersion, 2, "version bumped");

  // ------------------------------------------------------- idempotency
  //
  // A retry re-sends the SAME request: the same expectedVersion and the same
  // mutation id. Recomputing from the already-moved state would be a different
  // transition and would be refused for a different reason, which would not
  // exercise idempotency at all.
  const retryCurrent = newWorkflowRecord({ businessId: BUSINESS_ID, decisionKey: "dec_retry" });
  const retryOutcome = applyWorkflowTransition({
    current: retryCurrent,
    action: "acknowledge",
    actorUserId: USER_ID,
    expectedVersion: retryCurrent.stateVersion,
  });
  if (!retryOutcome.ok) fail("retry transition applied", retryOutcome.reason);
  const retryRequest = {
    next: retryOutcome.next,
    expectedVersion: retryCurrent.stateVersion,
    entityType: "creative",
    entityId: "dec_retry",
    providerAccountId: null as string | null,
    mutationId: MUTATION_ID,
    event: retryOutcome.event,
  };

  const once = await persistWorkflowTransition(retryRequest);
  expectTrue(once.ok, "mutation persists");
  expectEqual(await eventCount("dec_retry"), 1, "one event for one mutation");

  // The identical request again — a double click or a retried POST.
  const replay = await persistWorkflowTransition(retryRequest);
  expectTrue(replay.ok, "replay is accepted");
  expectTrue(
    replay.ok && replay.replayed === true,
    "replay is reported as a replay, not a new transition",
  );
  expectEqual(await eventCount("dec_retry"), 1, "replay appended no second event");

  const afterReplay = await readWorkflowRecord({
    businessId: BUSINESS_ID,
    decisionKey: "dec_retry",
  });
  // The crucial part: the version did NOT move again, so the next actor's
  // expectedVersion is still correct.
  expectEqual(afterReplay?.stateVersion, 2, "replay did not bump the version");

  // Two tenants may generate the same client-side id; the index is scoped per
  // business so one tenant's retry cannot suppress another's event.
  const otherBusiness = "c0000000-0000-4000-8000-0000000000b2";
  await getDb().query(
    `INSERT INTO businesses (id, name, owner_id, currency, timezone)
     VALUES ($1::uuid, 'Other', $2::uuid, 'USD', 'UTC') ON CONFLICT (id) DO NOTHING`,
    [otherBusiness, USER_ID],
  );
  await getDb().query(
    `INSERT INTO decision_workflow_events
       (business_id, decision_key, event, from_state, to_state, actor_user_id, state_version, mutation_id)
     VALUES ($1, 'dec_other', 'acknowledge', 'open', 'acknowledged', $2::uuid, 1, $3::uuid)`,
    [otherBusiness, USER_ID, MUTATION_ID],
  );
  const otherRows = (await getDb().query(
    `SELECT count(*)::int AS n FROM decision_workflow_events WHERE mutation_id = $1::uuid`,
    [MUTATION_ID],
  )) as unknown as Array<{ n: number }>;
  expectEqual(otherRows[0]!.n, 2, "the same mutation id is allowed in a different business");

  // ----------------------------------------------------------- atomicity
  // Force the event insert to fail inside the transaction. The state upsert
  // that ran first must roll back with it: a moved state with no journal entry
  // is exactly what the overlay exists to prevent.
  await getDb().query(
    `ALTER TABLE decision_workflow_events
       ADD CONSTRAINT tmp_reject_atomicity_probe
       CHECK (decision_key <> 'dec_atomic')`,
  );

  let threw = false;
  try {
    await transition("dec_atomic");
  } catch {
    threw = true;
  }
  expectTrue(threw, "a failing event insert propagates rather than being swallowed");
  expectEqual(await eventCount("dec_atomic"), 0, "no event was written");

  const rolledBack = await readWorkflowRecord({
    businessId: BUSINESS_ID,
    decisionKey: "dec_atomic",
  });
  expectTrue(
    rolledBack === null || rolledBack.state === "open",
    "state rolled back with the failed event",
    `state was ${rolledBack?.state}`,
  );

  await getDb().query(
    `ALTER TABLE decision_workflow_events DROP CONSTRAINT tmp_reject_atomicity_probe`,
  );

  // Recovery: with the constraint gone the same transition now succeeds, so
  // the rollback left nothing wedged.
  const recovered = await transition("dec_atomic");
  expectTrue(recovered.ok, "the transition succeeds once the failure is removed");
  expectEqual(await eventCount("dec_atomic"), 1, "exactly one event after recovery");

  // ------------------------------------------------------ version conflict
  const stale = await readWorkflowRecord({ businessId: BUSINESS_ID, decisionKey: "dec_basic" });
  const conflict = await persistWorkflowTransition({
    next: { ...stale!, state: "resolved", stateVersion: 99 },
    // A version nobody is on: the guarded UPDATE must match no row.
    expectedVersion: 42,
    entityType: "creative",
    entityId: "dec_basic",
    providerAccountId: null,
    event: {
      event: "resolve",
      fromState: "acknowledged",
      toState: "resolved",
      actorUserId: USER_ID,
      reasonCode: null,
      comment: null,
      stateVersion: 99,
    },
  });
  expectTrue(!conflict.ok, "a stale expectedVersion is refused by the database");
  expectEqual(!conflict.ok && conflict.reason, "version_conflict", "refusal names the conflict");
  expectEqual(await eventCount("dec_basic"), 1, "the refused conflict appended no event");

  console.log(
    `[${LABEL}] PASS: state and journal commit together and roll back together; a replayed ` +
      "mutation id appends no second event and does not bump the version; the same id is " +
      "allowed in a different business; and a stale expectedVersion is refused by the database " +
      "without writing an event.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
