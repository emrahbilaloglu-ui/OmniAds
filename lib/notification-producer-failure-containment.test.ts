import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One anomaly's failure must not end the business's scan.
 *
 * This became load-bearing when `recordNotificationEvent` was made atomic in
 * response to a review finding. Before that, a fan-out that failed part way
 * still COMMITTED the event row, so the throw aborted the producer loop but the
 * next hourly run hit the dedupe short-circuit, counted the anomaly `skipped`
 * and carried on to every later one. The failure self-healed by leaving a
 * marker behind.
 *
 * Atomicity removes the marker, which is the point — a partially delivered
 * notification is worse than none. But it also removes the self-healing: a
 * DETERMINISTIC failure inside the fan-out would be re-attempted every run,
 * fail again, and abort the scan again, so every anomaly after it would never
 * be produced at all. Head-of-line blocking, for as long as the cause persists.
 *
 * The atomicity fix and this containment therefore ship together; either alone
 * is a regression on the other.
 */
const readMetaAnomaliesForBusiness = vi.fn();
const recordNotificationEvent = vi.fn();
const query = vi.fn();

vi.mock("@/lib/meta/anomalies", () => ({
  readMetaAnomaliesForBusiness: (...args: unknown[]) =>
    readMetaAnomaliesForBusiness(...args),
}));
vi.mock("@/lib/notification-store", () => ({
  recordNotificationEvent: (...args: unknown[]) =>
    recordNotificationEvent(...args),
}));
vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: (...args: unknown[]) => query(...args) }),
}));

const BUSINESS_ID = "6f0f7a5e-2a1c-4f0e-9d1b-7c2a5b3e8d41";
const RECIPIENT_ID = "0b6d4c3a-9e51-4a2d-8f77-1c9a4d2b6e30";

function anomaly(id: string) {
  return {
    id,
    type: "spend_without_conversions",
    scopeType: "adset",
    scopeId: `set_${id}`,
    severity: "high",
  };
}

describe("a failed anomaly is contained, counted, and not called skipped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue([{ user_id: RECIPIENT_ID }]);
    readMetaAnomaliesForBusiness.mockResolvedValue({
      anomalies: [anomaly("a1"), anomaly("a2")],
    });
  });

  it("keeps producing after one anomaly throws", async () => {
    recordNotificationEvent
      .mockRejectedValueOnce(new Error("statement timeout"))
      .mockResolvedValueOnce({ created: true, record: null });

    const { produceNotificationsForBusiness } = await import(
      "@/lib/notification-producer"
    );
    const result = await produceNotificationsForBusiness({
      businessId: BUSINESS_ID,
      recipientUserId: RECIPIENT_ID,
      now: new Date("2026-09-06T09:00:00.000Z"),
    });

    // The second anomaly was still attempted. That is the whole point: without
    // the catch the loop exits on the first throw and never reaches it.
    expect(recordNotificationEvent).toHaveBeenCalledTimes(2);
    expect(result.scanned).toBe(2);
    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    /*
      And the failure is NOT reported as deduplication. `skipped` means "already
      produced on an earlier run"; counting a notification nobody will ever
      receive as that is precisely how this class of defect stays invisible —
      the same reassuring zero that hid the severity-translation bug this
      producer was written to fix.
    */
    expect(result.skipped).toBe(0);
  });

  it("does not swallow the failure into a success count", async () => {
    recordNotificationEvent.mockRejectedValue(new Error("always fails"));

    const { produceNotificationsForBusiness } = await import(
      "@/lib/notification-producer"
    );
    const result = await produceNotificationsForBusiness({
      businessId: BUSINESS_ID,
      recipientUserId: RECIPIENT_ID,
      now: new Date("2026-09-06T09:00:00.000Z"),
    });

    expect(result).toMatchObject({ scanned: 2, created: 0, skipped: 0, failed: 2 });
  });
});
