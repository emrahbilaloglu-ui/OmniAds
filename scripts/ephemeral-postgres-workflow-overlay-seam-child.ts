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
import {
  persistWorkflowTransition,
  readWorkflowEvents,
  readWorkflowRecord,
  readWorkflowRecords,
} from "@/lib/decision-workflow-store";
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

  // ------------------------------------------------- batched read (no N+1)
  //
  // The canonical Decisions page reads the overlay for a whole served page in
  // one statement. This proves the batch actually returns every persisted row
  // and omits nothing, against real storage rather than a mock that echoes its
  // own input.
  const batch = await readWorkflowRecords({
    businessId: BUSINESS_ID,
    decisionKeys: ["dec_basic", "dec_retry", "dec_atomic", "dec_never_touched"],
  });
  expectEqual(batch.size, 3, "the batch returns exactly the rows that exist");
  expectTrue(batch.has("dec_basic"), "batch contains dec_basic");
  expectTrue(batch.has("dec_retry"), "batch contains dec_retry");
  expectTrue(
    !batch.has("dec_never_touched"),
    "a decision nobody touched has no row, and the batch does not invent one",
  );
  expectEqual(batch.get("dec_basic")?.state, "acknowledged", "batched state matches the single read");

  const single = await readWorkflowRecord({ businessId: BUSINESS_ID, decisionKey: "dec_basic" });
  expectEqual(
    JSON.stringify(batch.get("dec_basic")),
    JSON.stringify(single),
    "batched and single reads agree byte-for-byte",
  );

  // Another tenant's identical decision key must not leak into this batch.
  await getDb().query(
    `INSERT INTO decision_workflow_state
       (business_id, entity_type, entity_id, decision_key, state, state_version)
     VALUES ($1, 'creative', 'dec_basic', 'dec_basic', 'resolved', 4)`,
    ["c0000000-0000-4000-8000-0000000000b2"],
  );
  const scoped = await readWorkflowRecords({
    businessId: BUSINESS_ID,
    decisionKeys: ["dec_basic"],
  });
  expectEqual(
    scoped.get("dec_basic")?.state,
    "acknowledged",
    "the batch is business-scoped: another tenant's row for the same key is not returned",
  );

  // ------------------------------------------------------ event projection
  //
  // The canonical surface has no comment control and no comment read. The
  // journal column still exists for the legacy contract, so this proves the
  // projection genuinely cannot carry it out of the database.
  await getDb().query(
    `UPDATE decision_workflow_events
        SET comment = 'operator free text that must never reach the canonical surface'
      WHERE business_id = $1 AND decision_key = 'dec_basic'`,
    [BUSINESS_ID],
  );
  const events = await readWorkflowEvents({ businessId: BUSINESS_ID, decisionKey: "dec_basic" });
  expectTrue(events.length > 0, "the journal read returns the recorded event");
  expectTrue(
    !JSON.stringify(events).includes("free text"),
    "no comment text is projected, even though the column holds some",
  );
  expectTrue(
    Object.keys(events[0]!).every((key) => key !== "comment"),
    "the projected shape has no comment field at all",
  );
  expectEqual(events[0]!.actorName, "Seed", "the actor name is joined from users");

  // An event whose actor was removed reports no name rather than inventing one.
  await getDb().query(
    `INSERT INTO decision_workflow_events
       (business_id, decision_key, event, from_state, to_state, actor_user_id, state_version)
     VALUES ($1, 'dec_orphan', 'acknowledge', 'open', 'acknowledged', NULL, 1)`,
    [BUSINESS_ID],
  );
  const orphan = await readWorkflowEvents({ businessId: BUSINESS_ID, decisionKey: "dec_orphan" });
  expectEqual(orphan[0]?.actorUserId, null, "an unrecorded actor stays null");
  expectEqual(orphan[0]?.actorName, null, "and no name is fabricated for it");

  // The journal read is bounded, so one noisy decision cannot return everything.
  for (let index = 0; index < 60; index += 1) {
    await getDb().query(
      `INSERT INTO decision_workflow_events
         (business_id, decision_key, event, from_state, to_state, actor_user_id, state_version)
       VALUES ($1, 'dec_noisy', 'acknowledge', 'open', 'acknowledged', $2::uuid, $3)`,
      [BUSINESS_ID, USER_ID, index + 1],
    );
  }
  const bounded = await readWorkflowEvents({
    businessId: BUSINESS_ID,
    decisionKey: "dec_noisy",
    limit: 999,
  });
  expectEqual(bounded.length, 50, "the journal read caps at 50 however large a limit is asked for");

  console.log(
    `[${LABEL}] PASS: state and journal commit together and roll back together; a replayed ` +
      "mutation id appends no second event and does not bump the version; the same id is " +
      "allowed in a different business; a stale expectedVersion is refused by the database " +
      "without writing an event; the batched page read is business-scoped, invents no row and " +
      "agrees with the single read; and the journal projection carries no comment text out of " +
      "the database, fabricates no actor name, and caps at 50 rows.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
