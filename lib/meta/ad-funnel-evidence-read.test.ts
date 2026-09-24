import { beforeEach, describe, expect, it, vi } from "vitest";
import { readMetaAdFunnelEvidenceWindow } from "./ad-funnel-evidence";

vi.mock("@/lib/db", () => ({ getDbWithTimeout: vi.fn() }));
vi.mock("@/lib/meta/warehouse", () => ({ getMetaAdDailyCoverage: vi.fn() }));

const db = await import("@/lib/db");
const warehouse = await import("@/lib/meta/warehouse");
const query = vi.fn();
const scope = {
  businessId: "biz_gm", providerAccountId: "act_gm", adId: "ad_1",
  start: "2026-09-20", end: "2026-09-20",
};

describe("exact-Ad funnel warehouse read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.getDbWithTimeout).mockReturnValue({ query } as never);
    vi.mocked(warehouse.getMetaAdDailyCoverage).mockResolvedValue({
      completed_days: 1,
    } as never);
    query.mockResolvedValue([]);
  });

  it("refuses incomplete account-day coverage before reading a partial Ad sum", async () => {
    vi.mocked(warehouse.getMetaAdDailyCoverage).mockResolvedValueOnce({
      completed_days: 0,
    } as never);
    await expect(readMetaAdFunnelEvidenceWindow(scope)).resolves.toEqual({
      rows: [], coverageComplete: false,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("binds exact business/account/Ad/dates and the D108 receipt to the raw day read", async () => {
    await readMetaAdFunnelEvidenceWindow(scope);
    expect(db.getDbWithTimeout).toHaveBeenCalledWith(25_000);
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain("d.business_id = $1 AND d.provider_account_id = $2 AND d.ad_id = $3");
    expect(sql).toContain("d.date BETWEEN $4::date AND $5::date");
    expect(sql).toContain("meta_raw_snapshot_observations observation");
    expect(sql).toContain("validation.event_kind = 'validation_passed'");
    expect(sql).toContain("AS provider_zero_receipt_verified");
    expect(params.slice(0, 5)).toEqual([
      "biz_gm", "act_gm", "ad_1", "2026-09-20", "2026-09-20",
    ]);
    expect(typeof params[5]).toBe("string");
  });
});
