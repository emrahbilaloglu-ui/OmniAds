/**
 * Notification ledger contract.
 *
 * Today a problem only reaches the buyer if the buyer happens to open the app.
 * A spend spike on a Saturday, a disapproved ad, a sync that stopped — all of
 * it waits silently until someone looks.
 *
 * This models the record of an event and its delivery, and nothing else. It
 * deliberately sends nothing: the moment a product can say "notified" without
 * having delivered anything is the moment its alerts stop being trustworthy, so
 * every state here is one we can actually evidence.
 */

export type NotificationSeverity = "critical" | "warning" | "info";

export type NotificationEventType =
  | "spend_anomaly"
  | "roas_collapse"
  | "policy_incident"
  | "data_outage"
  | "write_ambiguous"
  | "digest";

/**
 * Delivery lifecycle. `queued` and `attempted` are explicitly not `delivered`:
 * a channel accepting a message is not the same as a person receiving it.
 */
export type NotificationDeliveryState =
  | "queued"
  | "attempted"
  | "delivered"
  | "failed"
  | "suppressed"
  | "acknowledged";

export interface NotificationEvent {
  eventType: NotificationEventType;
  severity: NotificationSeverity;
  businessId: string;
  providerAccountId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** The decision, anomaly or health record this came from. */
  sourceKind: string;
  sourceId: string;
  /** The day the underlying fact belongs to, so a re-run cannot re-alert. */
  occurredOn: string;
}

/**
 * A stable identity for "this problem, on this thing, on this day".
 *
 * Re-running a job, re-syncing an account, or recomputing a decision must not
 * produce a second alert for the same underlying fact. The key deliberately
 * excludes wall-clock time for that reason.
 */
export function buildNotificationDedupeKey(event: NotificationEvent): string {
  return [
    event.businessId,
    event.providerAccountId ?? "-",
    event.eventType,
    event.entityType ?? "-",
    event.entityId ?? "-",
    event.sourceKind,
    event.occurredOn,
  ].join("|");
}

export interface QuietWindow {
  /** Local hour the quiet period starts, inclusive (0-23). */
  startHour: number;
  /** Local hour it ends, exclusive (0-23). */
  endHour: number;
}

/**
 * Whether an hour falls inside a quiet window, including windows that wrap
 * midnight (22:00 to 07:00 is one window, not two).
 */
export function isWithinQuietWindow(hour: number, window: QuietWindow): boolean {
  if (!Number.isFinite(hour)) return false;
  const { startHour, endHour } = window;
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

export interface DeliveryDecision {
  deliver: boolean;
  reason:
    | "critical_overrides_quiet_hours"
    | "outside_quiet_hours"
    | "held_until_quiet_hours_end"
    | "duplicate_suppressed";
}

/**
 * Decide whether an event may be delivered now.
 *
 * Critical events override quiet hours — the entire purpose of a critical alert
 * is that it does not wait. Everything else is held rather than dropped, so
 * suppression never silently loses an event.
 */
export function resolveDeliveryDecision(input: {
  severity: NotificationSeverity;
  hour: number;
  quietWindow?: QuietWindow | null;
  alreadySeenDedupeKey: boolean;
}): DeliveryDecision {
  if (input.alreadySeenDedupeKey) {
    return { deliver: false, reason: "duplicate_suppressed" };
  }
  if (!input.quietWindow || !isWithinQuietWindow(input.hour, input.quietWindow)) {
    return { deliver: true, reason: "outside_quiet_hours" };
  }
  if (input.severity === "critical") {
    return { deliver: true, reason: "critical_overrides_quiet_hours" };
  }
  return { deliver: false, reason: "held_until_quiet_hours_end" };
}

/** Terminal states never retry; a bounded retry policy applies to the rest. */
export const MAX_DELIVERY_ATTEMPTS = 3;

export function canRetryDelivery(state: NotificationDeliveryState, attempts: number): boolean {
  if (state === "delivered" || state === "acknowledged" || state === "suppressed") return false;
  return attempts < MAX_DELIVERY_ATTEMPTS;
}

/**
 * What the operator may be told about an event's delivery.
 *
 * A queued or attempted message is reported as not yet delivered, because that
 * is what it is.
 */
export function describeDeliveryState(state: NotificationDeliveryState): string {
  switch (state) {
    case "queued":
      return "Queued — not delivered yet";
    case "attempted":
      return "Attempted — delivery unconfirmed";
    case "delivered":
      return "Delivered";
    case "failed":
      return "Delivery failed";
    case "suppressed":
      return "Suppressed as a duplicate";
    case "acknowledged":
      return "Acknowledged";
  }
}

export function isDelivered(state: NotificationDeliveryState): boolean {
  return state === "delivered" || state === "acknowledged";
}
