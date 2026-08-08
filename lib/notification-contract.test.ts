import { describe, expect, it } from "vitest";
import {
  MAX_DELIVERY_ATTEMPTS,
  buildNotificationDedupeKey,
  canRetryDelivery,
  describeDeliveryState,
  isDelivered,
  isWithinQuietWindow,
  resolveDeliveryDecision,
  type NotificationEvent,
} from "@/lib/notification-contract";

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    eventType: "spend_anomaly",
    severity: "critical",
    businessId: "biz-1",
    providerAccountId: "act_1",
    entityType: "campaign",
    entityId: "c-1",
    sourceKind: "anomaly",
    sourceId: "an-1",
    occurredOn: "2026-08-08",
    ...overrides,
  };
}

describe("the same problem does not alert twice", () => {
  it("gives the same key to the same fact on the same day", () => {
    expect(buildNotificationDedupeKey(event())).toBe(
      buildNotificationDedupeKey(event({ sourceId: "an-2" })),
    );
  });

  it("separates different days, entities, accounts and event types", () => {
    const base = buildNotificationDedupeKey(event());
    expect(buildNotificationDedupeKey(event({ occurredOn: "2026-08-09" }))).not.toBe(base);
    expect(buildNotificationDedupeKey(event({ entityId: "c-2" }))).not.toBe(base);
    expect(buildNotificationDedupeKey(event({ providerAccountId: "act_2" }))).not.toBe(base);
    expect(buildNotificationDedupeKey(event({ eventType: "policy_incident" }))).not.toBe(base);
  });

  it("suppresses an event whose key has already been seen", () => {
    const decision = resolveDeliveryDecision({
      severity: "critical",
      hour: 12,
      alreadySeenDedupeKey: true,
    });
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe("duplicate_suppressed");
  });
});

describe("quiet hours", () => {
  it("handles a window that wraps midnight as one window", () => {
    const overnight = { startHour: 22, endHour: 7 };
    expect(isWithinQuietWindow(23, overnight)).toBe(true);
    expect(isWithinQuietWindow(3, overnight)).toBe(true);
    expect(isWithinQuietWindow(12, overnight)).toBe(false);
  });

  it("handles an ordinary daytime window", () => {
    const daytime = { startHour: 9, endHour: 17 };
    expect(isWithinQuietWindow(9, daytime)).toBe(true);
    expect(isWithinQuietWindow(17, daytime)).toBe(false);
  });

  it("treats an empty window as no quiet hours at all", () => {
    expect(isWithinQuietWindow(4, { startHour: 6, endHour: 6 })).toBe(false);
  });
});

describe("what may be delivered now", () => {
  const quiet = { startHour: 22, endHour: 7 };

  it("lets a critical alert through quiet hours, since not waiting is its purpose", () => {
    const decision = resolveDeliveryDecision({
      severity: "critical",
      hour: 3,
      quietWindow: quiet,
      alreadySeenDedupeKey: false,
    });
    expect(decision.deliver).toBe(true);
    expect(decision.reason).toBe("critical_overrides_quiet_hours");
  });

  it("holds a non-critical alert rather than dropping it", () => {
    const decision = resolveDeliveryDecision({
      severity: "warning",
      hour: 3,
      quietWindow: quiet,
      alreadySeenDedupeKey: false,
    });
    expect(decision.deliver).toBe(false);
    expect(decision.reason).toBe("held_until_quiet_hours_end");
  });

  it("delivers normally outside quiet hours and when none are configured", () => {
    expect(
      resolveDeliveryDecision({
        severity: "info",
        hour: 12,
        quietWindow: quiet,
        alreadySeenDedupeKey: false,
      }).deliver,
    ).toBe(true);
    expect(
      resolveDeliveryDecision({ severity: "info", hour: 3, alreadySeenDedupeKey: false }).deliver,
    ).toBe(true);
  });
});

describe("queued is never delivered", () => {
  it("does not report an unsent or unconfirmed message as delivered", () => {
    expect(isDelivered("queued")).toBe(false);
    expect(isDelivered("attempted")).toBe(false);
    expect(isDelivered("failed")).toBe(false);
    expect(isDelivered("suppressed")).toBe(false);
  });

  it("reports only genuine delivery as delivered", () => {
    expect(isDelivered("delivered")).toBe(true);
    expect(isDelivered("acknowledged")).toBe(true);
  });

  it("says plainly that a queued message has not arrived", () => {
    expect(describeDeliveryState("queued")).toContain("not delivered");
    expect(describeDeliveryState("attempted")).toContain("unconfirmed");
  });
});

describe("retry policy is bounded", () => {
  it("retries a failure up to the cap and then stops", () => {
    expect(canRetryDelivery("failed", 0)).toBe(true);
    expect(canRetryDelivery("failed", MAX_DELIVERY_ATTEMPTS - 1)).toBe(true);
    expect(canRetryDelivery("failed", MAX_DELIVERY_ATTEMPTS)).toBe(false);
  });

  it("never retries something already delivered, acknowledged or suppressed", () => {
    expect(canRetryDelivery("delivered", 0)).toBe(false);
    expect(canRetryDelivery("acknowledged", 0)).toBe(false);
    expect(canRetryDelivery("suppressed", 0)).toBe(false);
  });
});
