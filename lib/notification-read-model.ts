/**
 * What the operator has actually seen, and what a notification still points at.
 *
 * Two things are deliberately kept apart here. Whether a message reached a
 * channel is delivery (see notification-contract). Whether a person has looked
 * at it is read state. Conflating them is how a product ends up claiming
 * someone was notified because a queue accepted a row.
 *
 * A notification is also a claim about the past. By the time it is opened the
 * decision may have been acted on, superseded, or withdrawn, so following one
 * revalidates the current state rather than re-presenting the state that
 * existed when it fired.
 */

import type {
  NotificationDeliveryState,
  NotificationEvent,
  NotificationEventType,
  NotificationSeverity,
} from "@/lib/notification-contract";
import { isDelivered } from "@/lib/notification-contract";

export type NotificationReadState = "unread" | "read" | "acknowledged";

export interface NotificationRecord {
  id: string;
  dedupeKey: string;
  event: NotificationEvent;
  deliveryState: NotificationDeliveryState;
  readState: NotificationReadState;
  /** When the record was written, ISO 8601. */
  createdAt: string;
}

/**
 * Unread count for the bell.
 *
 * Counts what exists in the app, not what a channel accepted: an event whose
 * external delivery failed is still something the operator has not seen, and
 * hiding it would make the failure invisible twice.
 */
export function countUnread(records: readonly NotificationRecord[]): number {
  return records.filter((record) => record.readState === "unread").length;
}

export function countUnreadCritical(
  records: readonly NotificationRecord[],
): number {
  return records.filter(
    (record) =>
      record.readState === "unread" && record.event.severity === "critical",
  ).length;
}

/** Reading is not acknowledging: only an explicit act clears a critical item. */
export function markRead(
  record: NotificationRecord,
  next: NotificationReadState,
): NotificationRecord {
  if (record.readState === "acknowledged") return record;
  if (next === "unread") return record;
  return { ...record, readState: next };
}

export interface DigestReconciliation {
  total: number;
  bySeverity: Record<NotificationSeverity, number>;
  byType: Partial<Record<NotificationEventType, number>>;
  /**
   * Whether the digest's own total matches the server's count of the underlying
   * facts. False means the digest is incomplete and says so.
   */
  reconciled: boolean;
  /** Server count minus digest count; positive means events are missing. */
  missingFromDigest: number;
  note: string | null;
}

const EMPTY_SEVERITY: Record<NotificationSeverity, number> = {
  critical: 0,
  warning: 0,
  info: 0,
};

/**
 * Build the daily digest and check it against the source of truth.
 *
 * The plan requires digest totals to reconcile with server source counts. A
 * digest that quietly under-reports is worse than no digest, so a mismatch is
 * reported as one rather than being smoothed over.
 */
export function buildDailyDigest(input: {
  records: readonly NotificationRecord[];
  /** Server-side count of the underlying facts for the same day. */
  sourceEventCount: number;
  on: string;
}): DigestReconciliation {
  const forDay = input.records.filter(
    (record) => record.event.occurredOn === input.on,
  );
  const bySeverity = { ...EMPTY_SEVERITY };
  const byType: Partial<Record<NotificationEventType, number>> = {};
  for (const record of forDay) {
    bySeverity[record.event.severity] += 1;
    byType[record.event.eventType] = (byType[record.event.eventType] ?? 0) + 1;
  }
  const total = forDay.length;
  const missingFromDigest = input.sourceEventCount - total;
  const reconciled = missingFromDigest === 0;
  return {
    total,
    bySeverity,
    byType,
    reconciled,
    missingFromDigest,
    note: reconciled
      ? null
      : missingFromDigest > 0
        ? `${missingFromDigest} event${missingFromDigest === 1 ? "" : "s"} the server recorded are missing from this digest.`
        : `This digest lists ${Math.abs(missingFromDigest)} more event${Math.abs(missingFromDigest) === 1 ? "" : "s"} than the server recorded.`,
  };
}

/**
 * Where a notification points.
 *
 * Returns null when the event carries no entity to point at, rather than a link
 * to a surface that cannot resolve it.
 */
export function buildNotificationDeepLink(
  event: NotificationEvent,
): string | null {
  if (!event.businessId) return null;
  const params = new URLSearchParams({ businessId: event.businessId });
  if (event.providerAccountId) {
    params.set("providerAccountId", event.providerAccountId);
  }
  switch (event.eventType) {
    case "policy_incident":
    case "write_ambiguous":
    case "roas_collapse":
    case "spend_anomaly": {
      if (!event.entityId) return null;
      params.set("focus", event.entityId);
      if (event.entityType) params.set("focusLevel", event.entityType);
      return `/platforms/meta?${params.toString()}`;
    }
    case "data_outage":
      return `/integrations?${params.toString()}`;
    case "digest":
      return `/overview?${params.toString()}`;
  }
}

export type DeepLinkFreshness = "current" | "changed" | "gone";

export interface DeepLinkResolution {
  freshness: DeepLinkFreshness;
  /** Whether the surface may present the notification's own framing as current. */
  mayPresentAsCurrent: boolean;
  message: string | null;
}

/**
 * Revalidate a notification against the state that exists now.
 *
 * A notification is evidence that something was true when it fired. Following
 * it must not assert that the same thing is true now — the decision may have
 * been acted on, superseded, or removed while the alert sat in an inbox.
 */
export function resolveDeepLinkFreshness(input: {
  /** Source revision/updated-at captured when the notification was written. */
  notifiedSourceVersion: string | null;
  /** The same field read fresh, or null if the source no longer exists. */
  currentSourceVersion: string | null;
  sourceExists: boolean;
}): DeepLinkResolution {
  if (!input.sourceExists) {
    return {
      freshness: "gone",
      mayPresentAsCurrent: false,
      message:
        "What this alert pointed at no longer exists. It is kept as a record of what happened, not as something to act on.",
    };
  }
  if (
    input.notifiedSourceVersion === null ||
    input.currentSourceVersion === null
  ) {
    // Without both versions we cannot claim it is unchanged, so we do not.
    return {
      freshness: "changed",
      mayPresentAsCurrent: false,
      message:
        "This alert cannot be confirmed against the current record, so the current state is shown instead.",
    };
  }
  if (input.notifiedSourceVersion !== input.currentSourceVersion) {
    return {
      freshness: "changed",
      mayPresentAsCurrent: false,
      message:
        "This changed after the alert was sent. The current state is shown, not the state that triggered it.",
    };
  }
  return { freshness: "current", mayPresentAsCurrent: true, message: null };
}

/**
 * Honest one-line status for a record, combining what we know about delivery
 * and what we know about the person.
 */
export function describeNotificationStatus(record: NotificationRecord): string {
  if (record.readState === "acknowledged") return "Acknowledged";
  if (record.readState === "read") return "Seen";
  return isDelivered(record.deliveryState) ? "Delivered, unread" : "Not yet delivered";
}
