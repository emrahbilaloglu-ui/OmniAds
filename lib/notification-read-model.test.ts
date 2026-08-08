import { describe, expect, it } from "vitest";

import type { NotificationEvent } from "@/lib/notification-contract";
import {
  buildDailyDigest,
  buildNotificationDeepLink,
  countUnread,
  countUnreadCritical,
  describeNotificationStatus,
  markRead,
  resolveDeepLinkFreshness,
  type NotificationRecord,
} from "@/lib/notification-read-model";

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    eventType: "spend_anomaly",
    severity: "critical",
    businessId: "biz-1",
    providerAccountId: "act_1",
    entityType: "ad",
    entityId: "ad-1",
    sourceKind: "anomaly",
    sourceId: "an-1",
    occurredOn: "2026-08-09",
    ...overrides,
  };
}

function record(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: "n-1",
    dedupeKey: "k-1",
    event: event(),
    deliveryState: "delivered",
    readState: "unread",
    createdAt: "2026-08-09T10:00:00.000Z",
    ...overrides,
  };
}

describe("unread is about the person, not the channel", () => {
  it("counts an undelivered event as unread rather than hiding it", () => {
    const records = [
      record({ id: "a", deliveryState: "failed" }),
      record({ id: "b", deliveryState: "queued" }),
      record({ id: "c", readState: "read" }),
    ];
    expect(countUnread(records)).toBe(2);
  });

  it("counts critical unread separately", () => {
    const records = [
      record({ id: "a" }),
      record({ id: "b", event: event({ severity: "info" }) }),
    ];
    expect(countUnreadCritical(records)).toBe(1);
  });

  it("reports delivery honestly for an unread item", () => {
    expect(describeNotificationStatus(record({ deliveryState: "queued" }))).toBe(
      "Not yet delivered",
    );
    expect(describeNotificationStatus(record())).toBe("Delivered, unread");
    expect(describeNotificationStatus(record({ readState: "read" }))).toBe("Seen");
  });
});

describe("read state only moves forward", () => {
  it("does not let reading undo an acknowledgement", () => {
    const acknowledged = record({ readState: "acknowledged" });
    expect(markRead(acknowledged, "read").readState).toBe("acknowledged");
  });

  it("refuses to mark something unread again", () => {
    const read = record({ readState: "read" });
    expect(markRead(read, "unread").readState).toBe("read");
  });

  it("promotes unread to read and to acknowledged", () => {
    expect(markRead(record(), "read").readState).toBe("read");
    expect(markRead(record(), "acknowledged").readState).toBe("acknowledged");
  });
});

describe("the digest reconciles with the server instead of asserting", () => {
  it("totals the day it was asked for and nothing else", () => {
    const digest = buildDailyDigest({
      records: [
        record({ id: "a" }),
        record({ id: "b", event: event({ severity: "warning" }) }),
        record({
          id: "c",
          event: event({ occurredOn: "2026-08-08" }),
        }),
      ],
      sourceEventCount: 2,
      on: "2026-08-09",
    });
    expect(digest.total).toBe(2);
    expect(digest.bySeverity.critical).toBe(1);
    expect(digest.bySeverity.warning).toBe(1);
    expect(digest.reconciled).toBe(true);
    expect(digest.note).toBeNull();
  });

  it("says so when the server recorded more than the digest lists", () => {
    const digest = buildDailyDigest({
      records: [record()],
      sourceEventCount: 4,
      on: "2026-08-09",
    });
    expect(digest.reconciled).toBe(false);
    expect(digest.missingFromDigest).toBe(3);
    expect(digest.note).toContain("3 events");
    expect(digest.note).toContain("missing");
  });

  it("says so in the other direction too", () => {
    const digest = buildDailyDigest({
      records: [record({ id: "a" }), record({ id: "b" })],
      sourceEventCount: 1,
      on: "2026-08-09",
    });
    expect(digest.reconciled).toBe(false);
    expect(digest.note).toContain("1 more event");
  });
});

describe("a deep link points somewhere that can resolve it", () => {
  it("scopes an entity alert to the business, account and entity", () => {
    const href = buildNotificationDeepLink(event());
    expect(href).toContain("/platforms/meta?");
    expect(href).toContain("businessId=biz-1");
    expect(href).toContain("providerAccountId=act_1");
    expect(href).toContain("focus=ad-1");
    expect(href).toContain("focusLevel=ad");
  });

  it("returns nothing rather than a link that cannot resolve", () => {
    expect(buildNotificationDeepLink(event({ entityId: null }))).toBeNull();
    expect(buildNotificationDeepLink(event({ businessId: "" }))).toBeNull();
  });

  it("sends an outage to integrations and a digest to the overview", () => {
    expect(buildNotificationDeepLink(event({ eventType: "data_outage" }))).toContain(
      "/integrations?",
    );
    expect(buildNotificationDeepLink(event({ eventType: "digest" }))).toContain(
      "/overview?",
    );
  });
});

describe("following an alert revalidates rather than replays", () => {
  it("presents as current only when the source is provably unchanged", () => {
    const resolution = resolveDeepLinkFreshness({
      notifiedSourceVersion: "v7",
      currentSourceVersion: "v7",
      sourceExists: true,
    });
    expect(resolution.freshness).toBe("current");
    expect(resolution.mayPresentAsCurrent).toBe(true);
    expect(resolution.message).toBeNull();
  });

  it("refuses to present stale authority when the source moved on", () => {
    const resolution = resolveDeepLinkFreshness({
      notifiedSourceVersion: "v7",
      currentSourceVersion: "v9",
      sourceExists: true,
    });
    expect(resolution.freshness).toBe("changed");
    expect(resolution.mayPresentAsCurrent).toBe(false);
    expect(resolution.message).toContain("changed after the alert");
  });

  it("does not claim unchanged when it cannot compare", () => {
    for (const [notified, current] of [
      [null, "v1"],
      ["v1", null],
      [null, null],
    ] as const) {
      const resolution = resolveDeepLinkFreshness({
        notifiedSourceVersion: notified,
        currentSourceVersion: current,
        sourceExists: true,
      });
      expect(resolution.freshness).toBe("changed");
      expect(resolution.mayPresentAsCurrent).toBe(false);
    }
  });

  it("keeps a vanished target as a record, not as something to act on", () => {
    const resolution = resolveDeepLinkFreshness({
      notifiedSourceVersion: "v7",
      currentSourceVersion: null,
      sourceExists: false,
    });
    expect(resolution.freshness).toBe("gone");
    expect(resolution.mayPresentAsCurrent).toBe(false);
    expect(resolution.message).toContain("no longer exists");
  });
});
