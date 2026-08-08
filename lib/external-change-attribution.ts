/**
 * Attributing an observed change to whoever actually made it.
 *
 * "Did ROAS drop because something changed?" is the question that starts most
 * bad mornings, and today it can only be answered for changes this product
 * made. An edit made directly in Ads Manager simply appears as different
 * numbers, with no record that anything happened.
 *
 * Config history tells us a change was observed. Our own action log tells us
 * what we asked for. Correlating the two attributes each observed change — and
 * the honest third answer matters as much as the other two: when our own write
 * was never verified, we cannot claim the change was ours, and we must not
 * claim it was the client's either.
 */

export type ChangeOrigin = "internal" | "external" | "ambiguous";

export interface ObservedChange {
  entityType: "campaign" | "adset" | "ad";
  entityId: string;
  businessId: string;
  /** What visibly changed, e.g. "status" or "daily_budget". */
  field: string;
  previousValue: string | null;
  nextValue: string | null;
  observedAt: string;
}

export interface RecordedAction {
  entityId: string;
  /** The change class this action would produce, e.g. "status". */
  field: string;
  requestedAt: string;
  /** Provider verification is what makes an action ours beyond doubt. */
  status: "pending" | "verified" | "failed" | "ambiguous";
  actorUserId?: string | null;
}

export interface AttributedChange extends ObservedChange {
  origin: ChangeOrigin;
  /** The action we matched it to, when there was one. */
  matchedActionAt: string | null;
  actorUserId: string | null;
  reason: string;
}

/**
 * How long after our request a provider change may still plausibly be ours.
 * Provider state is read on a sync cycle, so the observation can lag the write
 * considerably; the window is generous by design because wrongly calling our
 * own change "external" is the more damaging error.
 */
export const DEFAULT_CORRELATION_WINDOW_MS = 6 * 60 * 60 * 1000;

function toTime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? Number.NaN : time;
}

export function attributeObservedChange(
  change: ObservedChange,
  actions: RecordedAction[],
  windowMs: number = DEFAULT_CORRELATION_WINDOW_MS,
): AttributedChange {
  const observedAt = toTime(change.observedAt);

  if (Number.isNaN(observedAt)) {
    return {
      ...change,
      origin: "ambiguous",
      matchedActionAt: null,
      actorUserId: null,
      reason: "The change has no usable observation time.",
    };
  }

  const candidates = actions
    .filter((action) => action.entityId === change.entityId && action.field === change.field)
    .map((action) => ({ action, requestedAt: toTime(action.requestedAt) }))
    .filter(({ requestedAt }) => !Number.isNaN(requestedAt))
    // Our request must precede the observation, within the window.
    .filter(
      ({ requestedAt }) =>
        requestedAt <= observedAt && observedAt - requestedAt <= windowMs,
    )
    .sort((a, b) => b.requestedAt - a.requestedAt);

  if (candidates.length === 0) {
    return {
      ...change,
      origin: "external",
      matchedActionAt: null,
      actorUserId: null,
      reason: "No action from this product could have produced this change.",
    };
  }

  const verified = candidates.find(({ action }) => action.status === "verified");
  if (verified) {
    return {
      ...change,
      origin: "internal",
      matchedActionAt: verified.action.requestedAt,
      actorUserId: verified.action.actorUserId ?? null,
      reason: "Matches a verified action from this product.",
    };
  }

  const failedOnly = candidates.every(({ action }) => action.status === "failed");
  if (failedOnly) {
    // Our attempt failed, yet the change happened. Someone else did it.
    return {
      ...change,
      origin: "external",
      matchedActionAt: candidates[0].action.requestedAt,
      actorUserId: null,
      reason: "Our matching action failed, so this change came from elsewhere.",
    };
  }

  return {
    ...change,
    origin: "ambiguous",
    matchedActionAt: candidates[0].action.requestedAt,
    actorUserId: candidates[0].action.actorUserId ?? null,
    reason:
      "An action from this product was never verified, so this change cannot be attributed.",
  };
}

export function attributeObservedChanges(
  changes: ObservedChange[],
  actions: RecordedAction[],
  windowMs: number = DEFAULT_CORRELATION_WINDOW_MS,
): AttributedChange[] {
  return changes.map((change) => attributeObservedChange(change, actions, windowMs));
}

/** Human-facing label for a change origin. */
export function describeChangeOrigin(origin: ChangeOrigin): string {
  if (origin === "internal") return "Changed in Adsecute";
  if (origin === "external") return "Changed in Ads Manager";
  return "Origin unconfirmed";
}
