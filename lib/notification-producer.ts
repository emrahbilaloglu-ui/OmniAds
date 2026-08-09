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
 * Anomaly severity maps to notification severity directly. Only `critical`
 * overrides quiet hours, which is the whole reason the distinction exists.
 */
function notificationSeverity(
  severity: string,
): NotificationEvent["severity"] {
  if (severity === "critical") return "critical";
  if (severity === "warning") return "warning";
  return "info";
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
