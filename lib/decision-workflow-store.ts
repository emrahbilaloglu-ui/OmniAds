import { getDb, runDbTransaction } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { newWorkflowRecord, type WorkflowRecord } from "@/lib/decision-workflow";

/**
 * Persistence for the operator workflow overlay.
 *
 * State and journal are written together, in one transaction. They were
 * previously two independent statements: the state upsert committed, then the
 * event insert ran, and if that second write failed the state had already
 * moved with nothing in the journal to explain it. The overlay exists to record
 * who decided what, so a state change with no event is worse than no change.
 *
 * A `mutationId` makes a retry safe. Without one, a flaky connection or a
 * double click appends a second event and bumps the version again, so the
 * operator sees their own action twice and the next actor's expectedVersion is
 * already wrong.
 */

interface StateRow {
  business_id: string;
  decision_key: string;
  state: string;
  assignee_user_id: string | null;
  due_at: string | null;
  snooze_until: string | null;
  reason_code: string | null;
  state_version: number;
}

function toRecord(row: StateRow): WorkflowRecord {
  return {
    businessId: row.business_id,
    decisionKey: row.decision_key,
    state: row.state as WorkflowRecord["state"],
    assigneeUserId: row.assignee_user_id,
    dueAt: row.due_at,
    snoozeUntil: row.snooze_until,
    reasonCode: row.reason_code,
    stateVersion: row.state_version,
  };
}

async function overlayReady() {
  const readiness = await getDbSchemaReadiness({
    tables: ["decision_workflow_state", "decision_workflow_events"],
  }).catch(() => null);
  return Boolean(readiness?.ready);
}

/**
 * Read current state, or the implicit open state for a decision nobody has
 * touched. A decision with no row is open, not missing.
 */
export async function readWorkflowRecord(input: {
  businessId: string;
  decisionKey: string;
}): Promise<WorkflowRecord | null> {
  if (!(await overlayReady())) return null;
  const rows = (await getDb().query<StateRow>(
    `
      SELECT business_id, decision_key, state, assignee_user_id,
             due_at::text, snooze_until::text, reason_code, state_version
      FROM decision_workflow_state
      WHERE business_id = $1 AND decision_key = $2
      LIMIT 1
    `,
    [input.businessId, input.decisionKey],
  )) as StateRow[];
  return rows[0]
    ? toRecord(rows[0])
    : newWorkflowRecord({ businessId: input.businessId, decisionKey: input.decisionKey });
}

export async function readWorkflowRecords(input: {
  businessId: string;
  decisionKeys: string[];
}): Promise<Map<string, WorkflowRecord>> {
  const result = new Map<string, WorkflowRecord>();
  if (input.decisionKeys.length === 0) return result;
  if (!(await overlayReady())) return result;
  const rows = (await getDb().query<StateRow>(
    `
      SELECT business_id, decision_key, state, assignee_user_id,
             due_at::text, snooze_until::text, reason_code, state_version
      FROM decision_workflow_state
      WHERE business_id = $1 AND decision_key = ANY($2::text[])
    `,
    [input.businessId, input.decisionKeys],
  )) as StateRow[];
  for (const row of rows) result.set(row.decision_key, toRecord(row));
  return result;
}

export interface WorkflowEvent {
  event: string;
  fromState: string | null;
  toState: string | null;
  /** Null when the acting user was never recorded or has since been removed. */
  actorUserId: string | null;
  actorName: string | null;
  reasonCode: string | null;
  stateVersion: number;
  occurredAt: string;
}

/**
 * Read the journal for one decision, newest first and bounded.
 *
 * `comment` is deliberately **not** selected. The canonical surface has no
 * comment control and no comment read; projecting the column here would put
 * free-form text one render away from a surface that must not carry it, and
 * INVARIANTS is explicit that a blocked resolution must never be recovered by
 * parsing free-form reason text.
 */
export async function readWorkflowEvents(input: {
  businessId: string;
  decisionKey: string;
  limit?: number;
}): Promise<WorkflowEvent[]> {
  if (!(await overlayReady())) return [];
  // Bounded so one noisy decision cannot return an unbounded journal.
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50);
  const rows = (await getDb().query<{
    event: string;
    from_state: string | null;
    to_state: string | null;
    actor_user_id: string | null;
    actor_name: string | null;
    reason_code: string | null;
    state_version: number;
    created_at: string;
  }>(
    `
      SELECT e.event,
             e.from_state,
             e.to_state,
             e.actor_user_id::text AS actor_user_id,
             u.name               AS actor_name,
             e.reason_code,
             e.state_version,
             e.created_at::text   AS created_at
      FROM decision_workflow_events e
      LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.business_id = $1 AND e.decision_key = $2
      ORDER BY e.created_at DESC, e.state_version DESC
      LIMIT $3
    `,
    [input.businessId, input.decisionKey, limit],
  )) as Array<{
    event: string;
    from_state: string | null;
    to_state: string | null;
    actor_user_id: string | null;
    actor_name: string | null;
    reason_code: string | null;
    state_version: number;
    created_at: string;
  }>;
  return rows.map((row) => ({
    event: row.event,
    fromState: row.from_state,
    toState: row.to_state,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    reasonCode: row.reason_code,
    stateVersion: row.state_version,
    occurredAt: row.created_at,
  }));
}

/**
 * Persist a transition.
 *
 * The version is asserted in the UPDATE's WHERE clause, so two operators racing
 * on the same decision cannot both win: the loser updates zero rows and is told
 * to reload rather than silently overwriting the winner.
 */
export async function persistWorkflowTransition(input: {
  next: WorkflowRecord;
  expectedVersion: number;
  entityType: string;
  entityId: string;
  providerAccountId: string | null;
  /** Client-generated idempotency key. A repeat is accepted as a no-op. */
  mutationId?: string | null;
  event: {
    event: string;
    fromState: string;
    toState: string;
    actorUserId: string;
    reasonCode: string | null;
    comment: string | null;
    stateVersion: number;
  };
}): Promise<
  { ok: true; replayed?: boolean } | { ok: false; reason: "version_conflict" | "unavailable" }
> {
  if (!(await overlayReady())) return { ok: false, reason: "unavailable" };
  const { next } = input;

  return runDbTransaction(async () => {
  const sql = getDb();

  // A replay of a mutation we already recorded is a no-op success, not a
  // second transition. Checked inside the transaction so two concurrent
  // retries cannot both pass it.
  if (input.mutationId) {
    const seen = (await sql.query<{ id: string }>(
      `SELECT id FROM decision_workflow_events
       WHERE business_id = $1 AND mutation_id = $2::uuid LIMIT 1`,
      [next.businessId, input.mutationId],
    )) as Array<{ id: string }>;
    if (seen.length > 0) return { ok: true as const, replayed: true };
  }

  const updated = (await sql.query<{ decision_key: string }>(
    `
      INSERT INTO decision_workflow_state (
        business_id, business_ref_id, provider_account_id, entity_type, entity_id,
        decision_key, state, assignee_user_id, due_at, snooze_until, reason_code,
        state_version, updated_by_user_id, updated_at
      ) VALUES (
        $1, $14::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::timestamptz, $9::timestamptz,
        $10, $11, $12::uuid, now()
      )
      ON CONFLICT (business_id, decision_key) DO UPDATE SET
        state = EXCLUDED.state,
        assignee_user_id = EXCLUDED.assignee_user_id,
        due_at = EXCLUDED.due_at,
        snooze_until = EXCLUDED.snooze_until,
        reason_code = EXCLUDED.reason_code,
        state_version = EXCLUDED.state_version,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = now()
      WHERE decision_workflow_state.state_version = $13
      RETURNING decision_key
    `,
    [
      next.businessId,
      input.providerAccountId,
      input.entityType,
      input.entityId,
      next.decisionKey,
      next.state,
      next.assigneeUserId,
      next.dueAt,
      next.snoozeUntil,
      next.reasonCode,
      next.stateVersion,
      input.event.actorUserId,
      input.expectedVersion,
      // Separate parameter for the UUID form: reusing $1 for both the TEXT
      // business_id and business_ref_id::uuid made PostgreSQL deduce two
      // conflicting types for one parameter and refuse the whole statement.
      next.businessId,
    ],
  )) as Array<{ decision_key: string }>;

  if (updated.length === 0) return { ok: false as const, reason: "version_conflict" as const };

  // Same transaction: if this throws, the state upsert above is rolled back.
  await sql.query(
    `
      INSERT INTO decision_workflow_events (
        business_id, decision_key, event, from_state, to_state,
        assignee_user_id, reason_code, comment, actor_user_id, state_version,
        mutation_id
      ) VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9::uuid, $10, $11::uuid)
    `,
    [
      next.businessId,
      next.decisionKey,
      input.event.event,
      input.event.fromState,
      input.event.toState,
      next.assigneeUserId,
      input.event.reasonCode,
      input.event.comment,
      input.event.actorUserId,
      input.event.stateVersion,
      input.mutationId ?? null,
    ],
  );

  return { ok: true as const };
  });
}
