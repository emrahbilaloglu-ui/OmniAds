import { describe, expect, it } from "vitest";
import { comparePlatformTableRows, formatPlatformMetricCell } from "@/components/platform-table-page";
import { Platform, type PlatformTableRow } from "@/src/types";

const row: PlatformTableRow = {
  id: "row_1",
  name: "Campaign",
  level: "campaign",
  status: "active",
  platform: Platform.TIKTOK,
  accountId: "acct_1",
  metrics: {
    spend: 1200,
    revenue: 3400,
    roas: 2.833,
    ctr: 1.25,
  },
};

describe("formatPlatformMetricCell", () => {
  it("does not invent a dollar currency for money cells", () => {
    expect(formatPlatformMetricCell("spend", row)).toBe("1,200 · currency —");
    expect(formatPlatformMetricCell("revenue", row)).toBe("3,400 · currency —");
    expect(formatPlatformMetricCell("spend", row)).not.toContain("$");
  });

  it("renders missing metrics as missing and ratio metrics without currency", () => {
    expect(formatPlatformMetricCell("cpa", row)).toBe("—");
    expect(formatPlatformMetricCell("roas", row)).toBe("2.83");
    expect(formatPlatformMetricCell("ctr", row)).toBe("1.25%");
  });
});

describe("comparePlatformTableRows", () => {
  it("sorts missing metric rows last in both directions", () => {
    const missing: PlatformTableRow = {
      ...row,
      id: "row_missing",
      name: "Missing campaign",
      metrics: {},
    };
    const lower: PlatformTableRow = {
      ...row,
      id: "row_lower",
      name: "Lower campaign",
      metrics: { spend: 10 },
    };
    const higher: PlatformTableRow = {
      ...row,
      id: "row_higher",
      name: "Higher campaign",
      metrics: { spend: 50 },
    };

    const ascending = [missing, higher, lower].sort((a, b) =>
      comparePlatformTableRows(a, b, "spend", "asc")
    );
    const descending = [missing, lower, higher].sort((a, b) =>
      comparePlatformTableRows(a, b, "spend", "desc")
    );

    expect(ascending.map((item) => item.id)).toEqual(["row_lower", "row_higher", "row_missing"]);
    expect(descending.map((item) => item.id)).toEqual(["row_higher", "row_lower", "row_missing"]);
  });
});
