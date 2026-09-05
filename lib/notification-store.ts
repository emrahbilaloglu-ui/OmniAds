/**
 * The notification lifecycle, as production transitions.
 *
 * `lib/notification-contract.ts` decided what a notification means; this is
 * where one actually comes into existence and moves through its states. Each
 * transition emits its section-9 event from the server, because only the server
 * knows whether a delivery was attempted or whether a channel accepted it — a
 * browser can report that someone clicked, never that something was delivered.
 *
 * The in-app channel is the one channel that exists today, and it is honest
 * about what it is: enqueueing a notification for the bell is an *attempt*, and
 * it becomes `delivered` only when the recipient's client has actually fetched
 * it. Marking enqueue as delivery would make the delivery rate a measure of our
 * own queue rather than of anyone receiving anything.
 *
 * No external channel is contacted from here. There is nothing to send to.
 */

import { getDb } from "@/lib/db";
import {
  buildNotificationDedupeKey,
  isDelivered,
  resolveDeliveryDecision,
  type NotificationDeliveryState,
  type NotificationEvent,
} from "@/lib/notification-contract";
import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";

export const NOTIFICATION_IN_APP_CHANNEL = "in_app" as const;

export interface NotificationRecordRow {
  id: string;
  deliveryId: string;
  businessId: string;
  eventType: string;
  severity: string;
  state: NotificationDeliveryState;
  deepLink: string | null;
  occurredOn: string;
  createdAt: string;
}

/**
 * Create a notification and enqueue its in-app delivery.
 *
 * Idempotent on the dedupe key: re-running a job, re-syncing an account or
 * recomputing a decision must not produce a second alert for the same
 * underlying fact, so a repeat returns the existing record rather than
 * inserting one.
 */
export async function recordNotificationEvent(input: {
  event: NotificationEvent;
  recipientUserId: string | null;
  /**
   * Everyone this notification is for.
   *
   * The reader looks up deliveries by `recipient_user_id = <the viewer>`, so a
   * delivery written with NULL is addressed to nobody and appears in nobody's
   * bell. One event, one delivery row per person: the event stays deduped —
   * one underlying fact is one notification — while each recipient gets their
   * own row to read, and later to mark read.
   *
   * Absent or empty falls back to `recipientUserId`, so every existing caller
   * keeps its exact behaviour.
   */
  recipientUserIds?: readonly string[];
  deepLink?: string | null;
  hourInRecipientTimezone?: number;
  quietWindow?: { startHour: number; endHour: number } | null;
}): Promise<{ created: boolean; record: NotificationRecordRow | null }> {
  const sql = getDb();
  const dedupeKey = buildNotificationDedupeKey(input.event);

  const existing = (await sql.query(
    `SELECT id::text AS id FROM notification_events WHERE dedupe_key = $1`,
    [dedupeKey],
  )) as unknown as Array<{ id: string }>;

  const decision = resolveDeliveryDecision({
    severity: input.event.severity,
    hour: input.hourInRecipientTimezone ?? 12,
    quietWindow: input.quietWindow ?? null,
    alreadySeenDedupeKey: existing.length > 0,
  });

  if (existing.length > 0) {
    // A duplicate is suppressed, not re-sent. Nothing is emitted: no new
    // notification was attempted, and counting one would inflate the rate with
    // our own retries.
    return { created: false, record: null };
  }

  const inserted = (await sql.query(
    `INSERT INTO notification_events (
       business_id, provider_account_id, event_type, severity,
       entity_type, entity_id, source_kind, source_id, occurred_on,
       dedupe_key, deep_link
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id::text AS id, created_at`,
    [
      input.event.businessId,
      input.event.providerAccountId ?? null,
      input.event.eventType,
      input.event.severity,
      input.event.entityType ?? null,
      input.event.entityId ?? null,
      input.event.sourceKind,
      input.event.sourceId,
      input.event.occurredOn,
      dedupeKey,
      input.deepLink ?? null,
    ],
  )) as unknown as Array<{ id: string; created_at: string }>;

  if (!inserted[0]) return { created: false, record: null };

  const state: NotificationDeliveryState = decision.deliver
    ? "attempted"
    : "suppressed";

  const recipients = input.recipientUserIds?.length
    ? [...new Set(input.recipientUserIds)]
    : [input.recipientUserId];
  const deliveries: Array<{ id: string }> = [];
  for (const recipient of recipients) {
    const row = (await sql.query(
      `INSERT INTO notification_deliveries (
         notification_event_id, recipient_user_id, channel, state,
         suppression_reason, attempts, attempted_at
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       RETURNING id::text AS id`,
      [
        inserted[0].id,
        recipient,
        NOTIFICATION_IN_APP_CHANNEL,
        state,
        decision.deliver ? null : decision.reason,
        decision.deliver ? 1 : 0,
        decision.deliver ? new Date().toISOString() : null,
      ],
    )) as unknown as Array<{ id: string }>;
    if (row[0]) deliveries.push(row[0]);
  }
  const delivery = deliveries;

  // Section 9: an attempt happened, or was withheld by quiet hours. Reported as
  // what it was -- a suppressed alert is not a delivered one.
  await recordProductInstrumentationEvent({
    businessId: input.event.businessId,
    scope: "business",
    eventName: "notification_attempted",
    surface: "system",
    outcome: decision.deliver ? "ok" : "withheld",
    occurredAt: new Date().toISOString(),
  });

  return {
    created: true,
    record: {
      id: inserted[0].id,
      deliveryId: delivery[0]!.id,
      businessId: input.event.businessId,
      eventType: input.event.eventType,
      severity: input.event.severity,
      state,
      deepLink: input.deepLink ?? null,
      occurredOn: input.event.occurredOn,
      createdAt: inserted[0].created_at,
    },
  };
}

/**
 * The recipient's client fetched their notifications, so anything attempted has
 * now genuinely reached them. This is the only transition that may claim
 * delivery.
 */
export async function markNotificationsDelivered(input: {
  businessId: string;
  recipientUserId: string | null;
}): Promise<number> {
  const sql = getDb();
  const rows = (await sql.query(
    `UPDATE notification_deliveries delivery
     SET state = 'delivered', delivered_at = now(), updated_at = now()
     FROM notification_events event
     WHERE delivery.notification_event_id = event.id
       AND event.business_id = $1
       AND delivery.state = 'attempted'
       AND ($2::uuid IS NULL OR delivery.recipient_user_id = $2::uuid)
     RETURNING delivery.id::text AS id`,
    [input.businessId, input.recipientUserId],
  )) as unknown as Array<{ id: string }>;

  if (rows.length > 0) {
    await recordProductInstrumentationEvent({
      businessId: input.businessId,
      scope: "business",
      eventName: "notification_delivered",
      surface: "system",
      outcome: "ok",
      itemCount: rows.length,
      occurredAt: new Date().toISOString(),
    });
  }
  return rows.length;
}

/** The recipient opened one. Opening is not acknowledging. */
export async function markNotificationOpened(input: {
  businessId: string;
  deliveryId: string;
}): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql.query(
    `UPDATE notification_deliveries delivery
     SET opened_at = COALESCE(delivery.opened_at, now()), updated_at = now()
     FROM notification_events event
     WHERE delivery.notification_event_id = event.id
       AND delivery.id = $2::uuid
       AND event.business_id = $1
     RETURNING delivery.id::text AS id`,
    [input.businessId, input.deliveryId],
  )) as unknown as Array<{ id: string }>;

  if (rows.length === 0) return false;
  await recordProductInstrumentationEvent({
    businessId: input.businessId,
    scope: "business",
    eventName: "notification_opened",
    surface: "system",
    outcome: "ok",
    occurredAt: new Date().toISOString(),
  });
  return true;
}

/** The recipient took responsibility for it. Terminal. */
export async function acknowledgeNotification(input: {
  businessId: string;
  deliveryId: string;
}): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql.query(
    `UPDATE notification_deliveries delivery
     SET state = 'acknowledged', acknowledged_at = now(), updated_at = now()
     FROM notification_events event
     WHERE delivery.notification_event_id = event.id
       AND delivery.id = $2::uuid
       AND event.business_id = $1
       AND delivery.state <> 'acknowledged'
     RETURNING delivery.id::text AS id`,
    [input.businessId, input.deliveryId],
  )) as unknown as Array<{ id: string }>;

  if (rows.length === 0) return false;
  await recordProductInstrumentationEvent({
    businessId: input.businessId,
    scope: "business",
    eventName: "notification_acknowledged",
    surface: "system",
    outcome: "ok",
    occurredAt: new Date().toISOString(),
  });
  return true;
}

/** What the bell reads. Unread means not yet acknowledged. */
export async function readNotificationsForRecipient(input: {
  businessId: string;
  recipientUserId: string | null;
  limit?: number;
}): Promise<NotificationRecordRow[]> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT event.id::text AS id, delivery.id::text AS delivery_id,
            event.business_id, event.event_type, event.severity,
            delivery.state, event.deep_link, event.occurred_on::text AS occurred_on,
            event.created_at
     FROM notification_events event
     INNER JOIN notification_deliveries delivery
       ON delivery.notification_event_id = event.id
     WHERE event.business_id = $1
       AND ($2::uuid IS NULL OR delivery.recipient_user_id = $2::uuid)
     ORDER BY event.created_at DESC
     LIMIT $3`,
    [input.businessId, input.recipientUserId, input.limit ?? 50],
  )) as unknown as Array<Record<string, string>>;

  return rows.map((row) => ({
    id: row.id!,
    deliveryId: row.delivery_id!,
    businessId: row.business_id!,
    eventType: row.event_type!,
    severity: row.severity!,
    state: row.state as NotificationDeliveryState,
    deepLink: row.deep_link ?? null,
    occurredOn: row.occurred_on!,
    createdAt: row.created_at!,
  }));
}

export function countUnacknowledged(rows: NotificationRecordRow[]): number {
  return rows.filter((row) => row.state !== "acknowledged").length;
}

export { isDelivered };
