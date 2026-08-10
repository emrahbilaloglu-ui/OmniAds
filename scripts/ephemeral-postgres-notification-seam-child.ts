// Child of ephemeral-postgres-migrations-check: drives the notification
// lifecycle through its real production transitions against real storage.
//
// Contract tests can prove the shape of each stage; only PostgreSQL can show
// that the dedupe key actually prevents a second alert, that enqueue does not
// claim delivery, and that acknowledging is terminal.
//
// Nothing external is contacted. The in-app channel is the only channel, and
// "delivery" here means the recipient's client fetched it.
import { getDb } from "@/lib/db";
import type { NotificationEvent } from "@/lib/notification-contract";
import {
  acknowledgeNotification,
  countUnacknowledged,
  markNotificationOpened,
  markNotificationsDelivered,
  readNotificationsForRecipient,
  recordNotificationEvent,
} from "@/lib/notification-store";

const LABEL = "notification-seam";

function fail(label: string, detail?: string): never {
  throw new Error(`${LABEL} FAILED [${label}]${detail ? `: ${detail}` : ""}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(label, `expected ${e}, got ${a}`);
}

const USER_ID = "e0000000-0000-4000-8000-0000000000aa";
const BUSINESS_ID = "e0000000-0000-4000-8000-000000000001";

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    eventType: "spend_anomaly",
    severity: "critical",
    businessId: BUSINESS_ID,
    providerAccountId: "act_seam",
    entityType: "campaign",
    entityId: "cmp-1",
    sourceKind: "meta_anomaly",
    sourceId: "anom-1",
    occurredOn: "2026-08-09",
    ...overrides,
  };
}

async function seed() {
  const db = getDb();
  await db.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1, 'Seam', 'notify-seam@adsecute.local', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  await db.query(
    `INSERT INTO businesses (id, name, owner_id)
     VALUES ($1, 'Notification Seam', $2) ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID, USER_ID],
  );
}

async function main() {
  await seed();
  const db = getDb();
  await db.query(`DELETE FROM notification_events WHERE business_id = $1`, [
    BUSINESS_ID,
  ]);

  // ------------------------------------------------------------- attempted
  const first = await recordNotificationEvent({
    event: event(),
    recipientUserId: USER_ID,
  });
  if (!first.created || !first.record) fail("create", "no notification created");
  expectEqual(first.record.state, "attempted", "enqueue is an attempt");

  // A fetch has not happened, so nothing may claim delivery yet.
  const beforeFetch = await readNotificationsForRecipient({
    businessId: BUSINESS_ID,
    recipientUserId: USER_ID,
  });
  expectEqual(beforeFetch[0]?.state, "attempted", "not delivered before a fetch");
  expectEqual(countUnacknowledged(beforeFetch), 1, "one unacknowledged");

  // ------------------------------------------------------------- duplicate
  const duplicate = await recordNotificationEvent({
    event: event(),
    recipientUserId: USER_ID,
  });
  expectEqual(duplicate.created, false, "a duplicate creates nothing");
  const afterDuplicate = await readNotificationsForRecipient({
    businessId: BUSINESS_ID,
    recipientUserId: USER_ID,
  });
  expectEqual(afterDuplicate.length, 1, "still exactly one notification");

  // ------------------------------------------------------------- delivered
  const delivered = await markNotificationsDelivered({
    businessId: BUSINESS_ID,
    recipientUserId: USER_ID,
  });
  expectEqual(delivered, 1, "the fetch delivered exactly one");
  const afterDelivery = await readNotificationsForRecipient({
    businessId: BUSINESS_ID,
    recipientUserId: USER_ID,
  });
  expectEqual(afterDelivery[0]?.state, "delivered", "state advanced");

  // Delivering twice must not double-count: nothing is attempted any more.
  expectEqual(
    await markNotificationsDelivered({
      businessId: BUSINESS_ID,
      recipientUserId: USER_ID,
    }),
    0,
    "delivery is not re-counted",
  );

  // ------------------------------------------------------ opened / acked
  const deliveryId = afterDelivery[0]!.deliveryId;
  expectEqual(
    await markNotificationOpened({ businessId: BUSINESS_ID, deliveryId }),
    true,
    "opening is recorded",
  );
  const afterOpen = await readNotificationsForRecipient({
    businessId: BUSINESS_ID,
    recipientUserId: USER_ID,
  });
  // Opening is not acknowledging: it must still count as outstanding.
  expectEqual(afterOpen[0]?.state, "delivered", "opening does not acknowledge");
  expectEqual(countUnacknowledged(afterOpen), 1, "still outstanding after a look");

  expectEqual(
    await acknowledgeNotification({ businessId: BUSINESS_ID, deliveryId }),
    true,
    "acknowledgment is recorded",
  );
  const afterAck = await readNotificationsForRecipient({
    businessId: BUSINESS_ID,
    recipientUserId: USER_ID,
  });
  expectEqual(afterAck[0]?.state, "acknowledged", "state is terminal");
  expectEqual(countUnacknowledged(afterAck), 0, "nothing outstanding");

  // Acknowledging twice is a no-op, reported as one.
  expectEqual(
    await acknowledgeNotification({ businessId: BUSINESS_ID, deliveryId }),
    false,
    "a second acknowledgment changes nothing",
  );

  // ------------------------------------------------------------- tenancy
  expectEqual(
    await markNotificationOpened({
      businessId: "e0000000-0000-4000-8000-00000000000f",
      deliveryId,
    }),
    false,
    "another business cannot touch this delivery",
  );

  // ------------------------------------------------------------ quiet hours
  await db.query(`DELETE FROM notification_events WHERE business_id = $1`, [
    BUSINESS_ID,
  ]);
  const held = await recordNotificationEvent({
    event: event({ severity: "warning", sourceId: "anom-2" }),
    recipientUserId: USER_ID,
    hourInRecipientTimezone: 3,
    quietWindow: { startHour: 22, endHour: 7 },
  });
  expectEqual(
    held.record?.state,
    "suppressed",
    "a warning inside quiet hours is held, not sent",
  );

  const critical = await recordNotificationEvent({
    // A different entity, because the dedupe key is deliberately "this problem,
    // on this thing, on this day" -- reusing the entity would correctly be
    // suppressed as the same fact, which is a different property than the one
    // being checked here.
    event: event({ severity: "critical", entityId: "cmp-2", sourceId: "anom-3" }),
    recipientUserId: USER_ID,
    hourInRecipientTimezone: 3,
    quietWindow: { startHour: 22, endHour: 7 },
  });
  expectEqual(
    critical.record?.state,
    "attempted",
    "a critical alert overrides quiet hours -- that is what critical means",
  );

  console.log(
    `[${LABEL}] PASS: enqueue is an attempt, delivery is claimed only on fetch and never re-counted, opening is not acknowledging, acknowledgment is terminal and idempotent, another business cannot touch a delivery, and quiet hours hold a warning while a critical alert overrides them.`,
  );
}

main()
  .then(async () => {
    await getDb()
      .query(`DELETE FROM notification_events WHERE business_id = $1`, [
        BUSINESS_ID,
      ])
      .catch(() => undefined);
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });
