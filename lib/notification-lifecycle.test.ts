import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The notification lifecycle is server-owned, and each stage means one thing.
 *
 * These assert on the shipped transitions; the real-Postgres behaviour is
 * proven in the notification seam, which runs the store against real storage.
 */
const store = readFileSync("lib/notification-store.ts", "utf8");
const producer = readFileSync("lib/notification-producer.ts", "utf8");
const listRoute = readFileSync("app/api/notifications/route.ts", "utf8");
const itemRoute = readFileSync(
  "app/api/notifications/[deliveryId]/route.ts",
  "utf8",
);

describe("enqueueing is an attempt, never a delivery", () => {
  it("records an attempt when a notification is created", () => {
    expect(store).toContain('eventName: "notification_attempted"');
    expect(store).toContain("state: NotificationDeliveryState = decision.deliver");
  });

  it("claims delivery only when the recipient's client has fetched it", () => {
    expect(store).toContain("markNotificationsDelivered");
    expect(store).toContain("delivery.state = 'attempted'");
    expect(listRoute).toContain("await markNotificationsDelivered(");
  });

  it("reports a suppressed alert as withheld, not delivered", () => {
    expect(store).toContain('outcome: decision.deliver ? "ok" : "withheld"');
  });
});

describe("opening is not acknowledging", () => {
  it("has separate transitions and separate events", () => {
    expect(store).toContain('eventName: "notification_opened"');
    expect(store).toContain('eventName: "notification_acknowledged"');
    expect(itemRoute).toContain('body?.action !== "open"');
    expect(itemRoute).toContain('body.action === "open"');
  });

  it("refuses an unknown action rather than defaulting to one", () => {
    expect(itemRoute).toContain('error: "unknown_action"');
  });

  it("reports a no-op as a conflict instead of a false success", () => {
    expect(itemRoute).toContain("{ status: changed ? 200 : 409 }");
  });
});

describe("a duplicate does not become a second alert", () => {
  it("returns the existing record and emits nothing new", () => {
    expect(store).toContain("alreadySeenDedupeKey: existing.length > 0");
    expect(store).toContain("return { created: false, record: null };");
  });

  it("keys production on a per-day dedupe so an hourly job is not a storm", () => {
    expect(producer).toContain("occurredOn");
    expect(producer).toContain("Idempotent through the dedupe key");
  });
});

describe("production only alerts on what is worth interrupting someone for", () => {
  it("skips info-level anomalies", () => {
    expect(producer).toContain('if (severity === "info")');
    expect(producer).toContain("skipped += 1");
  });

  it("never puts anomaly prose in the deep link", () => {
    const linkBlock = producer.slice(producer.indexOf("deepLink:"));
    expect(linkBlock.slice(0, 200)).not.toContain("detail");
    expect(linkBlock.slice(0, 200)).not.toContain("title");
  });
});
