/**
 * Where notifications actually come from.
 *
 * Until now the ledger and the delivery contract existed with nothing producing
 * a notification, so every count would have been a constant zero that reads as
 * "no incidents". This turns detected anomalies into notification events.
 *
 * It deliberately produces only from facts the product has already committed to
 * — a persisted anomaly, with its own severity — rather than inventing a second
 * detection pass. A notification is a delivery decision about an existing fact,
 * not a new opinion about the data.
 */

import { getDb } from "@/lib/db";
import { readMetaAnomaliesForBusiness } from "@/lib/meta/anomalies";
import type { NotificationEvent } from "@/lib/notification-contract";
import { recordNotificationEvent } from "@/lib/notification-store";
import { logRuntimeWarn } from "@/lib/runtime-logging";

/**
 * Who a business's notifications are for.
 *
 * The producer wrote deliveries with a NULL recipient and the reader looks
 * them up by `recipient_user_id = <the viewer>`, so every notification this
 * product has ever produced was addressed to nobody. The bell was empty not
 * because nothing was detected but because nothing was addressed.
 *
 * Admins and collaborators, active memberships only. A guest can read the
 * product; being interrupted about someone's ad spend is a different thing.
 * A failed lookup must reject before the producer writes an event: treating
 * it as an empty list commits a NULL-recipient delivery and consumes the
 * dedupe key, preventing delivery to real members after the lookup recovers.
 * A successfully read empty list retains the existing NULL-recipient behavior.
 */
export async function readNotificationRecipients(
  businessId: string,
): Promise<string[]> {
  const rows = await getDb().query<{ user_id: string }>(
    `SELECT user_id::text AS user_id
       FROM memberships
      WHERE business_id = $1::uuid
        AND status = 'active'
        AND role IN ('admin', 'collaborator')
      ORDER BY user_id`,
    [businessId],
  );
  return rows.map((row) => row.user_id);
}

/**
 * Anomaly severity, translated into notification severity.
 *
 * These are two different vocabularies and this function used to assume they
 * were one. Anomalies are graded `high` / `medium` / `low`
 * (`lib/meta/anomalies.ts`); notifications are `critical` / `warning` / `info`.
 * Matching on "critical" and "warning" meant nothing ever matched, every
 * anomaly fell through to `info`, and the caller skips info — so the producer
 * could scan a business full of critical anomalies and create exactly zero
 * notifications, for ever, while reporting success.
 *
 * Both vocabularies are accepted now, because a producer that silently drops
 * an input it does not recognise is how this happened. An unrecognised grade
 * is `info` — not alerted on, but the caller counts it as skipped rather than
 * losing it.
 *
 * Only `critical` overrides quiet hours, which is the whole reason the
 * distinction exists.
 */
export function notificationSeverity(
  severity: string,
): NotificationEvent["severity"] {
  switch (severity.trim().toLowerCase()) {
    case "critical":
    case "high":
      return "critical";
    case "warning":
    case "medium":
      return "warning";
    default:
      return "info";
  }
}

function eventType(anomalyType: string): NotificationEvent["eventType"] {
  if (anomalyType.includes("spend")) return "spend_anomaly";
  if (anomalyType.includes("roas")) return "roas_collapse";
  if (anomalyType.includes("policy") || anomalyType.includes("disapprov")) {
    return "policy_incident";
  }
  return "spend_anomaly";
}

export interface NotificationProducerResult {
  scanned: number;
  created: number;
  skipped: number;
  /**
   * Anomalies whose event could not be recorded at all.
   *
   * Kept separate from `skipped` on purpose: skipped means "already produced
   * on an earlier run", and folding a failure into it would report a
   * notification nobody will ever receive as routine deduplication.
   */
  failed: number;
}

/**
 * Produce notifications for one business's current anomalies.
 *
 * Idempotent through the dedupe key: the same anomaly on the same day produces
 * one notification however many times this runs, so a cron that fires hourly
 * does not become an alert storm.
 */
export async function produceNotificationsForBusiness(input: {
  businessId: string;
  providerAccountId?: string | null;
  recipientUserId: string | null;
  now?: Date;
}): Promise<NotificationProducerResult> {
  const now = input.now ?? new Date();
  const occurredOn = now.toISOString().slice(0, 10);
  const providerAccountId = input.providerAccountId?.trim() || null;

  /*
    Bounded to the day being produced for, and typed rather than cast.

    `readMetaAnomaliesForBusiness` picks its snapshot with
    `MAX(snapshot_date)` and only narrows that to `<= endDate` when one is
    given. Omitting it means "newest snapshot in the table", which is the
    intended ceiling for a run anchored on `new Date()` — but this producer
    accepts an injected `now`, so a past-dated run would have attached today's
    anomalies to an older `occurredOn`. That is the same forward-leak
    `lib/meta/daily-brief.ts` carried; passing `occurredOn` closes it here
    before it can be reached rather than after.

    The `as never` is gone with it. It silenced the compiler on exactly this
    argument, so the missing bound could not have been caught by typechecking —
    a cast that hides the shape of the call is how the same mistake survives in
    two places.
  */
  const anomalies = await readMetaAnomaliesForBusiness({
    businessId: input.businessId,
    /*
      Scoped to the account these notifications will be STAMPED with.

      The read and every emitted event use the same normalized account id.
      Reading business-wide while stamping one account means that on a business
      with several assigned Meta accounts, another account's anomaly is
      delivered to the operator labelled as this one's — a wrong attribution on
      the one surface whose whole job is to tell someone what happened where.

      When the caller names no account the read stays business-wide, and the
      stamp is `null`, so the two halves agree in that case too.
    */
    ...(providerAccountId ? { providerAccountId } : {}),
    activeOnly: true,
    endDate: occurredOn,
  }).catch(() => null);

  const rows = anomalies?.anomalies ?? [];
  // Reuse one recipient snapshot for this scan. Membership changes during the
  // batch are picked up by the next scan. A lookup failure rejects here,
  // before any event or dedupe key can be written, so a later scan can retry.
  const recipients = input.recipientUserId
    ? [input.recipientUserId]
    : await readNotificationRecipients(input.businessId);
  let created = 0;
  let skipped = 0;
  let failed = 0;

  /*
    Iterated as what it is. This was `rows as Array<Record<string, string>>`,
    which type-checked only because the read above was cast to `never` and the
    rows were therefore untyped. `MetaAnomaly` already declares every field read
    below — `id`, `type`, `scopeType`, `scopeId`, `severity` — so the assertion
    bought nothing and cost the compiler its view of the loop.
  */
  for (const row of rows) {
    // Only alert on what is worth interrupting someone for. An info-level
    // anomaly is visible in the product; it is not a reason to send anything.
    const severity = notificationSeverity(row.severity);
    if (severity === "info") {
      skipped += 1;
      continue;
    }

    const event: NotificationEvent = {
      eventType: eventType(row.type),
      severity,
      businessId: input.businessId,
      providerAccountId,
      entityType: row.scopeType,
      entityId: row.scopeId,
      sourceKind: "meta_anomaly",
      sourceId: row.id,
      occurredOn,
    };

    /*
      One anomaly's failure must not end the business's scan.

      This became load-bearing when `recordNotificationEvent` was made atomic.
      Before that, a fan-out that failed part way still COMMITTED the event
      row, so the throw aborted this loop but the next hourly run hit the
      dedupe short-circuit, counted the anomaly `skipped` and carried on to
      every later one. The failure self-healed by leaving a marker behind.

      Atomicity removes the marker, which is the point — a partially delivered
      notification is worse than none. But it also removes the self-healing: a
      DETERMINISTIC failure inside the fan-out (a statement timeout that always
      fires, a constraint the row can never satisfy) would now be re-attempted
      on every run, fail again, and abort the scan again, so every anomaly
      after it in the list would never be produced. Head-of-line blocking, for
      as long as the cause persists.

      So the failure is contained to its own anomaly and counted. It is
      deliberately NOT counted as `skipped`: skipped means "already produced",
      and reporting a failure as that is how this kind of thing stays invisible.
    */
    let result: Awaited<ReturnType<typeof recordNotificationEvent>> | null =
      null;
    try {
      result = await recordNotificationEvent({
      event,
      recipientUserId: input.recipientUserId,
      recipientUserIds: recipients,
      // The deep link names the entity, never the anomaly's prose.
      deepLink: row.scopeId
        ? `/platforms/meta?businessId=${encodeURIComponent(input.businessId)}&focus=${encodeURIComponent(row.scopeId)}`
        : null,
      hourInRecipientTimezone: now.getUTCHours(),
      });
    } catch (error) {
      failed += 1;
      logRuntimeWarn("notification-producer", "record_failed", {
        businessId: input.businessId,
        sourceId: row.id,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (result.created) created += 1;
    else skipped += 1;
  }

  return { scanned: rows.length, created, skipped, failed };
}

/**
 * Scheduled production, run from the same cron as the other maintenance jobs.
 */
export async function runNotificationProducerIfDue(
  businessIds: readonly string[],
  now = new Date(),
) {
  // Hourly is enough for an alert that already carries a per-day dedupe key,
  // and it keeps a stuck job from re-scanning every minute.
  if (now.getUTCMinutes() > 5) {
    return { skipped: true as const, reason: "not_due" as const };
  }
  let created = 0;
  for (const businessId of businessIds) {
    const result = await produceNotificationsForBusiness({
      businessId,
      recipientUserId: null,
      now,
    }).catch(() => null);
    created += result?.created ?? 0;
  }
  return { skipped: false as const, businesses: businessIds.length, created };
}
