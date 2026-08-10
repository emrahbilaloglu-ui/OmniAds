import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/notification-store", () => ({
  markNotificationsDelivered: vi.fn(),
  readNotificationsForRecipient: vi.fn(),
  countUnacknowledged: vi.fn(),
  markNotificationOpened: vi.fn(),
  acknowledgeNotification: vi.fn(),
}));

import { GET } from "@/app/api/notifications/route";
import { POST } from "@/app/api/notifications/[deliveryId]/route";
import { requireBusinessAccess } from "@/lib/access";
import {
  acknowledgeNotification,
  countUnacknowledged,
  markNotificationOpened,
  markNotificationsDelivered,
  readNotificationsForRecipient,
} from "@/lib/notification-store";

/**
 * The routes where the notification lifecycle actually advances.
 *
 * Delivery and acknowledgment are the two numbers anyone would use to judge
 * whether alerting works, so each has to mean what it says. Fetching is what
 * turns an attempt into a delivery; a click that changed nothing must not be
 * reported as one.
 */
function grantAccess() {
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user-1" } },
    membership: { businessId: "biz-1" },
  } as never);
}

describe("reading the bell is what delivers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantAccess();
    vi.mocked(readNotificationsForRecipient).mockResolvedValue([] as never);
    vi.mocked(countUnacknowledged).mockReturnValue(0);
  });

  it("marks attempts as delivered before reading them back", async () => {
    const order: string[] = [];
    vi.mocked(markNotificationsDelivered).mockImplementation(async () => {
      order.push("deliver");
      return 1;
    });
    vi.mocked(readNotificationsForRecipient).mockImplementation(async () => {
      order.push("read");
      return [] as never;
    });

    await GET(new NextRequest("http://localhost/api/notifications?businessId=biz-1"));

    // If the read came first, the row it returned would still say "attempted"
    // and the operator's own fetch would be missing from the delivery rate.
    expect(order).toEqual(["deliver", "read"]);
  });

  it("delivers to the signed-in recipient, not to whoever the caller names", async () => {
    await GET(new NextRequest("http://localhost/api/notifications?businessId=biz-1&recipient=someone-else"));
    expect(markNotificationsDelivered).toHaveBeenCalledWith({
      businessId: "biz-1",
      recipientUserId: "user-1",
    });
  });

  it("scopes to the membership's business rather than the query string", async () => {
    // A caller passing another tenant's id must not read their notifications.
    await GET(new NextRequest("http://localhost/api/notifications?businessId=biz-999"));
    expect(readNotificationsForRecipient).toHaveBeenCalledWith({
      businessId: "biz-1",
      recipientUserId: "user-1",
    });
  });

  it("does not deliver anything when access is refused", async () => {
    vi.mocked(requireBusinessAccess).mockResolvedValue({
      error: Response.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/notifications?businessId=biz-1"),
    );
    expect(response.status).toBe(403);
    // A refused read that still marked delivery would inflate the rate with
    // deliveries nobody was allowed to receive.
    expect(markNotificationsDelivered).not.toHaveBeenCalled();
  });
});

describe("opening and acknowledging are different things", () => {
  const params = (deliveryId: string) => ({
    params: Promise.resolve({ deliveryId }),
  });

  const postRequest = (body: unknown) =>
    new NextRequest("http://localhost/api/notifications/d-1", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    grantAccess();
  });

  it("records an open without claiming ownership", async () => {
    vi.mocked(markNotificationOpened).mockResolvedValue(true);
    const response = await POST(
      postRequest({ businessId: "biz-1", action: "open" }),
      params("d-1"),
    );
    expect(response.status).toBe(200);
    expect(markNotificationOpened).toHaveBeenCalled();
    // Collapsing the two would make every glance count as ownership.
    expect(acknowledgeNotification).not.toHaveBeenCalled();
  });

  it("reports a no-op as a no-op rather than as success", async () => {
    // Already acknowledged, or a delivery belonging to another business. A 200
    // here would tell the caller something happened when nothing did.
    vi.mocked(acknowledgeNotification).mockResolvedValue(false);
    const response = await POST(
      postRequest({ businessId: "biz-1", action: "acknowledge" }),
      params("d-1"),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ changed: false });
  });

  it("refuses an action it does not recognise instead of guessing", async () => {
    const response = await POST(
      postRequest({ businessId: "biz-1", action: "dismiss" }),
      params("d-1"),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("unknown_action");
    expect(markNotificationOpened).not.toHaveBeenCalled();
    expect(acknowledgeNotification).not.toHaveBeenCalled();
  });

  it("acts on the membership's business, never the body's", async () => {
    vi.mocked(acknowledgeNotification).mockResolvedValue(true);
    await POST(
      postRequest({ businessId: "biz-999", action: "acknowledge" }),
      params("d-1"),
    );
    expect(acknowledgeNotification).toHaveBeenCalledWith({
      businessId: "biz-1",
      deliveryId: "d-1",
    });
  });
});
