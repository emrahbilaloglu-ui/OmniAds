import { describe, expect, it } from "vitest";

import { notificationSeverity } from "@/lib/notification-producer";

/**
 * The translation that made the producer produce nothing.
 *
 * Anomalies are graded `high` / `medium` / `low`. Notifications are `critical`
 * / `warning` / `info`. The producer matched on the notification words against
 * the anomaly values, so nothing ever matched, every anomaly fell through to
 * `info`, and the caller skips info.
 *
 * The result was a producer that could scan a business full of critical
 * anomalies, create zero notifications, and report success — the reassuring
 * zero, one layer below the bell that would have displayed it.
 */
describe("anomaly grades reach notification severities", () => {
  it("treats a high anomaly as critical, so it can override quiet hours", () => {
    expect(notificationSeverity("high")).toBe("critical");
  });

  it("treats a medium anomaly as a warning", () => {
    expect(notificationSeverity("medium")).toBe("warning");
  });

  it("leaves a low anomaly at info, which is not worth interrupting anyone for", () => {
    expect(notificationSeverity("low")).toBe("info");
  });

  it("still accepts the notification vocabulary directly", () => {
    // Both vocabularies are accepted, because assuming one was the other is
    // exactly what broke this.
    expect(notificationSeverity("critical")).toBe("critical");
    expect(notificationSeverity("warning")).toBe("warning");
    expect(notificationSeverity("info")).toBe("info");
  });

  it("is insensitive to case and padding", () => {
    expect(notificationSeverity(" HIGH ")).toBe("critical");
    expect(notificationSeverity("Medium")).toBe("warning");
  });

  it("puts an unrecognised grade at info rather than guessing it is urgent", () => {
    // Not alerted on, and the caller counts it as skipped rather than losing
    // it silently.
    expect(notificationSeverity("catastrophic")).toBe("info");
    expect(notificationSeverity("")).toBe("info");
  });

  it("maps at least one anomaly grade to something that alerts", () => {
    // The assertion the old code could not have passed: it mapped every real
    // anomaly grade to info.
    const grades = ["high", "medium", "low"];
    const alerting = grades.filter(
      (grade) => notificationSeverity(grade) !== "info",
    );
    expect(
      alerting.length,
      "no anomaly grade produces an alert; the producer can never produce anything",
    ).toBeGreaterThan(0);
  });
});
