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

import { readMetaAnomaliesForBusiness } from "@/lib/meta/anomalies";
import type { NotificationEvent } from "@/lib/notification-contract";
import { recordNotificationEvent } from "@/lib/notification-store";

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

  const anomalies = await readMetaAnomaliesForBusiness({
    businessId: input.businessId,
    activeOnly: true,
  } as never).catch(() => null);

  const rows = (anomalies as { anomalies?: unknown[] } | null)?.anomalies ?? [];
  let created = 0;
  let skipped = 0;

  for (const row of rows as Array<Record<string, string>>) {
    // Only alert on what is worth interrupting someone for. An info-level
    // anomaly is visible in the product; it is not a reason to send anything.
    const severity = notificationSeverity(row.severity ?? "info");
    if (severity === "info") {
      skipped += 1;
      continue;
    }

    const event: NotificationEvent = {
      eventType: eventType(row.type ?? ""),
      severity,
      businessId: input.businessId,
      providerAccountId: input.providerAccountId ?? null,
      entityType: row.scopeType ?? null,
      entityId: row.scopeId ?? null,
      sourceKind: "meta_anomaly",
      sourceId: row.id ?? "",
      occurredOn,
    };

    const result = await recordNotificationEvent({
      event,
      recipientUserId: input.recipientUserId,
      // The deep link names the entity, never the anomaly's prose.
      deepLink: row.scopeId
        ? `/platforms/meta?businessId=${encodeURIComponent(input.businessId)}&focus=${encodeURIComponent(row.scopeId)}`
        : null,
      hourInRecipientTimezone: now.getUTCHours(),
    });
    if (result.created) created += 1;
    else skipped += 1;
  }

  return { scanned: rows.length, created, skipped };
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
