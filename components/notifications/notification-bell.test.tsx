import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The bell, and the zero it must never show.
 *
 * It was disabled for a real reason: nothing produced notification events, so
 * an enabled bell would have rendered a confident `0 unread` meaning "nothing
 * can generate these" rather than "nothing is wrong". The producer now runs on
 * the maintenance cron, so the honest state flipped — leaving it disabled would
 * mean producing alerts and delivering them to nobody.
 *
 * That makes the badge the highest-stakes number in the console: an operator
 * who sees no badge concludes nothing needs them, and stops looking.
 */
const bell = readFileSync(
  "components/notifications/NotificationBell.tsx",
  "utf8",
);

describe("the badge cannot show a reassuring zero", () => {
  it("shows no count at all while the first read is in flight", () => {
    // Not "0" — a zero during load is indistinguishable from a real zero.
    expect(bell).toContain("!query.isLoading");
    expect(bell).toContain("Boolean(selectedBusinessId)");
  });

  it("reports a failed read without drawing a badge state absent from the design", () => {
    expect(bell).toContain("data-notification-state=");
    expect(bell).toContain('"unreadable"');
    expect(bell).toContain("Notifications — count unavailable");
    expect(bell).not.toContain('? "?"');
  });

  it("renders no badge only for a genuine zero", () => {
    expect(bell).toContain("unacknowledged && unacknowledged > 0");
  });

  it("tells a screen reader which of the three states it is in", () => {
    expect(bell).toContain("Notifications — count unavailable");
    expect(bell).toContain("Notifications — loading");
    expect(bell).toContain("unacknowledged`");
  });
});

describe("the panel keeps the same rules as the badge", () => {
  it("renders no list and no zero while loading", () => {
    expect(bell).toContain("Loading — nothing to show yet");
  });

  it("offers a retry on a failed read instead of an empty list", () => {
    // An empty list after a failure reads as "nothing needs you".
    expect(bell).toContain("Could not read notifications");
    expect(bell).toContain("Try again");
  });

  it("distinguishes a genuine empty from a failure", () => {
    expect(bell).toContain("Nothing needs you right now");
  });
});

describe("opening is not acknowledging", () => {
  it("offers them as separate actions", () => {
    // Collapsing them would make every glance count as ownership, and the
    // acknowledgment rate would stop meaning anything.
    expect(bell).toContain('act(row.deliveryId, "open")');
    expect(bell).toContain('act(row.deliveryId, "acknowledge")');
  });

  it("stops offering acknowledge once it is acknowledged", () => {
    expect(bell).toContain('row.state !== "acknowledged"');
    expect(bell).toContain("Acknowledged");
  });

  it("emits nothing from the client", () => {
    // The lifecycle events are server-owned: only the server knows whether the
    // transition landed. A client emit here would also be dead vocabulary --
    // there is no bell-opened event, and the database CHECK would refuse one.
    expect(bell).not.toContain("emitProductInstrumentation");
  });
});

describe("it is actually mounted, in both frames", () => {
  it("replaces the disabled button in the console frame", () => {
    const frame = readFileSync("components/layout/dashboard-frame.tsx", "utf8");
    expect(frame).toContain("<NotificationBell />");
    expect(frame).not.toContain("Notifications are not available yet");
  });

  it("replaces the disabled button in the legacy frame", () => {
    // Overview renders through this one; a bell in only one frame is a bell
    // that disappears depending on which page you are on.
    const topbar = readFileSync("components/layout/topbar.tsx", "utf8");
    expect(topbar).toContain("<NotificationBell />");
    expect(topbar).not.toContain("not available yet");
  });
});

describe("something actually produces the notifications it shows", () => {
  it("runs the producer from the maintenance cron", () => {
    // A bell backed by a producer nothing invokes is the reassuring zero in a
    // different costume.
    const cron = readFileSync("app/api/sync/cron/route.ts", "utf8");
    expect(cron).toContain("runNotificationProducerIfDue");
    expect(cron).toContain("notificationProducerJob");
  });

  it("reports the producer's result in the cron receipt", () => {
    const cron = readFileSync("app/api/sync/cron/route.ts", "utf8");
    const receipt = cron.slice(cron.indexOf("instrumentationRetentionJob,"));
    expect(receipt).toContain("notificationProducerJob,");
  });
});
