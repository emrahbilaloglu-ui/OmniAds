import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A recipient that fails mid-fan-out must not be lost for ever.
 *
 * The event row carries a UNIQUE dedupe key and `recordNotificationEvent`
 * short-circuits on it: a repeat run returns `created: false` before it writes
 * any delivery. So if the event commits and the per-recipient loop then fails
 * — a membership whose user row was deleted between the recipient read and the
 * write, or a transient database error — the recipient that failed, and
 * everyone after them in the loop, can never be reached again. The producer
 * now fans out to every authorized member of a business rather than writing a
 * single NULL row, so that loop really does have several recipients.
 *
 * The fake below models the one property that matters: a write inside an
 * uncommitted transaction is invisible after a rollback. `getDb()` hands back
 * a different client inside the transaction than outside it, exactly as the
 * real `lib/db` does, so writes issued on a handle resolved before the
 * transaction land in committed storage and are NOT rolled back.
 */

interface EventRow {
  id: string;
  dedupe_key: string;
  created_at: string;
}
interface DeliveryRow {
  id: string;
  notification_event_id: string;
  recipient_user_id: string | null;
}

const committed = { events: [] as EventRow[], deliveries: [] as DeliveryRow[] };
const pending = { events: [] as EventRow[], deliveries: [] as DeliveryRow[] };

/** Recipients whose delivery insert throws, as a deleted user row would. */
const failingRecipients = new Set<string>();
let inTransaction = false;
let nextId = 0;

function exec(
  text: string,
  params: unknown[],
  buffer: typeof committed,
): unknown {
  if (text.includes("SELECT id::text AS id FROM notification_events")) {
    // A read sees committed rows plus this transaction's own pending writes.
    const visible = inTransaction
      ? [...committed.events, ...pending.events]
      : [...committed.events];
    return visible
      .filter((row) => row.dedupe_key === params[0])
      .map((row) => ({ id: row.id }));
  }

  if (text.includes("INSERT INTO notification_events")) {
    const dedupeKey = params[9] as string;
    const clash = [...committed.events, ...pending.events].some(
      (row) => row.dedupe_key === dedupeKey,
    );
    if (clash) return []; // ON CONFLICT (dedupe_key) DO NOTHING
    const row: EventRow = {
      id: `event-${(nextId += 1)}`,
      dedupe_key: dedupeKey,
      created_at: "2026-09-06T00:00:00.000Z",
    };
    buffer.events.push(row);
    return [{ id: row.id, created_at: row.created_at }];
  }

  if (text.includes("INSERT INTO notification_deliveries")) {
    const recipient = params[1] as string | null;
    if (recipient !== null && failingRecipients.has(recipient)) {
      throw new Error(
        `insert or update on table "notification_deliveries" violates foreign key constraint (${recipient})`,
      );
    }
    const row: DeliveryRow = {
      id: `delivery-${(nextId += 1)}`,
      notification_event_id: params[0] as string,
      recipient_user_id: recipient,
    };
    buffer.deliveries.push(row);
    return [{ id: row.id }];
  }

  throw new Error(`unexpected query: ${text}`);
}

const poolClient = {
  query: async (text: string, params: unknown[] = []) =>
    exec(text, params, committed),
};
const transactionClient = {
  query: async (text: string, params: unknown[] = []) =>
    exec(text, params, pending),
};

vi.mock("@/lib/db", () => ({
  getDb: () => (inTransaction ? transactionClient : poolClient),
  runDbTransaction: async <T,>(fn: () => Promise<T>): Promise<T> => {
    inTransaction = true;
    try {
      const result = await fn();
      committed.events.push(...pending.events);
      committed.deliveries.push(...pending.deliveries);
      return result;
    } finally {
      // Rollback on throw: nothing written in the block survives.
      pending.events.length = 0;
      pending.deliveries.length = 0;
      inTransaction = false;
    }
  },
}));

vi.mock("@/lib/product-instrumentation", () => ({
  recordProductInstrumentationEvent: vi.fn(async () => ({ recorded: true })),
}));

const { recordNotificationEvent } = await import("@/lib/notification-store");

const BUSINESS_ID = "biz-1";
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

function produce(recipients: readonly string[]) {
  return recordNotificationEvent({
    event: {
      eventType: "spend_anomaly",
      severity: "critical",
      businessId: BUSINESS_ID,
      providerAccountId: "act_1",
      entityType: "campaign",
      entityId: "cmp-1",
      sourceKind: "meta_anomaly",
      sourceId: "anom-1",
      occurredOn: "2026-09-06",
    },
    recipientUserId: null,
    recipientUserIds: recipients,
    hourInRecipientTimezone: 12,
  });
}

function deliveriesFor(userId: string) {
  return committed.deliveries.filter((row) => row.recipient_user_id === userId);
}

beforeEach(() => {
  committed.events.length = 0;
  committed.deliveries.length = 0;
  pending.events.length = 0;
  pending.deliveries.length = 0;
  failingRecipients.clear();
  inTransaction = false;
  nextId = 0;
});

describe("recipient fan-out is retryable", () => {
  it("re-attempts every recipient after a mid-loop failure", async () => {
    // The second recipient's user row is gone by the time the loop reaches it.
    failingRecipients.add(SECOND);
    await expect(produce([FIRST, SECOND])).rejects.toThrow(
      /notification_deliveries/,
    );

    // Whatever partial state that run left, the next run must be able to
    // finish the job. Nothing outside this module can repair it: no other code
    // path writes notification deliveries.
    failingRecipients.clear();
    const retry = await produce([FIRST, SECOND]);

    expect(
      deliveriesFor(SECOND),
      "the recipient that failed mid-loop was never reachable again",
    ).toHaveLength(1);
    expect(deliveriesFor(FIRST)).toHaveLength(1);
    expect(retry.created).toBe(true);
  });

  it("leaves no event row behind when the fan-out could not complete", async () => {
    failingRecipients.add(SECOND);
    await expect(produce([FIRST, SECOND])).rejects.toThrow();

    // A committed event with an incomplete fan-out is precisely what makes the
    // next run return `created: false` without delivering anything.
    expect(committed.events).toHaveLength(0);
    expect(committed.deliveries).toHaveLength(0);
  });

  it("still writes one delivery per recipient on a clean run", async () => {
    const result = await produce([FIRST, SECOND, FIRST]);
    expect(result.created).toBe(true);
    expect(committed.events).toHaveLength(1);
    expect(committed.deliveries).toHaveLength(2); // deduped recipient list
    expect(result.record?.state).toBe("attempted");
  });

  it("still suppresses a duplicate rather than fanning out twice", async () => {
    await produce([FIRST, SECOND]);
    const duplicate = await produce([FIRST, SECOND]);
    expect(duplicate.created).toBe(false);
    expect(committed.deliveries).toHaveLength(2);
  });
});
