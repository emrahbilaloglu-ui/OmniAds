/**
 * The Agency read: batched, scoped, and money-free.
 *
 * Two properties are asserted rather than assumed. First, the totals store is
 * called **once** with every business id — a per-client loop is the fan-out the
 * design forbids, and it is invisible in a UI test because the page still
 * renders. Second, the spend/revenue/purchases the store returns are dropped
 * here, so they cannot reach the projection even by accident.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access", () => ({ listUserBusinesses: vi.fn() }));
vi.mock("@/lib/agency-today-store", () => ({ readAgencyTodayTotals: vi.fn() }));
vi.mock("server-only", () => ({}));

const { readAgencyDirectorySource } = await import("@/lib/zero-base/agency-directory-server");
const access = await import("@/lib/access");
const store = await import("@/lib/agency-today-store");
const { findForbiddenAgencyKeys } = await import("@/lib/zero-base/agency-projection");
const { SHOPIFY_REVIEWER_EMAIL } = await import("@/lib/reviewer-access");
const { DEMO_BUSINESS_ID } = await import("@/lib/demo-business");

function membership(id: string, status: "active" | "invited" | "pending" = "active") {
  return {
    id,
    name: `Client ${id}`,
    timezone: "UTC",
    timezoneSource: null,
    currency: "USD",
    role: "admin" as const,
    membershipStatus: status,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.readAgencyTodayTotals).mockResolvedValue(new Map());
});

describe("no per-client fan-out", () => {
  it("calls the totals store once, with every id", async () => {
    vi.mocked(access.listUserBusinesses).mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => membership(`biz_${i}`)) as never,
    );

    await readAgencyDirectorySource({ userId: "user_1", email: "ada@example.com" });

    // Fifty clients, one query. A loop here would be fifty round trips.
    expect(store.readAgencyTodayTotals).toHaveBeenCalledTimes(1);
    expect(vi.mocked(store.readAgencyTodayTotals).mock.calls[0][0].businessIds).toHaveLength(50);
  });

  it("skips the totals query entirely when there are no active clients", async () => {
    vi.mocked(access.listUserBusinesses).mockResolvedValue([
      membership("biz_1", "invited"),
    ] as never);

    await expect(
      readAgencyDirectorySource({ userId: "user_1", email: "ada@example.com" }),
    ).resolves.toEqual([]);
    expect(store.readAgencyTodayTotals).not.toHaveBeenCalled();
  });
});

describe("money never crosses into the projection", () => {
  it("takes only the timestamp from a totals row", async () => {
    vi.mocked(access.listUserBusinesses).mockResolvedValue([membership("biz_1")] as never);
    vi.mocked(store.readAgencyTodayTotals).mockResolvedValue(
      new Map([
        [
          "biz_1",
          {
            businessId: "biz_1",
            spend: 8214,
            revenue: 21400,
            purchases: 91,
            lastSourceUpdatedAt: "2026-08-10T12:00:00Z",
          },
        ],
      ]) as never,
    );

    const rows = await readAgencyDirectorySource({ userId: "user_1", email: "ada@example.com" });

    expect(rows[0].sourceUpdatedAt).toBe("2026-08-10T12:00:00Z");
    expect(findForbiddenAgencyKeys(rows)).toEqual([]);
    expect(Object.keys(rows[0]).sort()).toEqual([
      "currency",
      "id",
      "membershipStatus",
      "name",
      "role",
      "sourceUpdatedAt",
    ]);
  });

  it("records an absent timestamp as null rather than inventing one", async () => {
    vi.mocked(access.listUserBusinesses).mockResolvedValue([membership("biz_1")] as never);
    const rows = await readAgencyDirectorySource({ userId: "user_1", email: "ada@example.com" });
    expect(rows[0].sourceUpdatedAt).toBeNull();
  });

  it("still returns the directory when the totals query fails", async () => {
    vi.mocked(access.listUserBusinesses).mockResolvedValue([membership("biz_1")] as never);
    vi.mocked(store.readAgencyTodayTotals).mockRejectedValue(new Error("warehouse down"));

    const rows = await readAgencyDirectorySource({ userId: "user_1", email: "ada@example.com" });
    // Activity is a nice-to-have; losing it must not lose the client list.
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceUpdatedAt).toBeNull();
  });
});

describe("scope", () => {
  it("lists only active memberships", async () => {
    vi.mocked(access.listUserBusinesses).mockResolvedValue([
      membership("biz_1", "active"),
      membership("biz_2", "invited"),
      membership("biz_3", "pending"),
    ] as never);

    const rows = await readAgencyDirectorySource({ userId: "user_1", email: "ada@example.com" });
    // An unaccepted invite is not a client; listing it would imply access.
    expect(rows.map((row) => row.id)).toEqual(["biz_1"]);
  });

  it("keeps a reviewer inside the demo business", async () => {
    vi.mocked(access.listUserBusinesses).mockResolvedValue([
      membership(DEMO_BUSINESS_ID),
      membership("biz_real"),
    ] as never);

    const rows = await readAgencyDirectorySource({
      userId: "user_1",
      email: SHOPIFY_REVIEWER_EMAIL,
    });
    expect(rows.map((row) => row.id)).toEqual([DEMO_BUSINESS_ID]);
  });
});
