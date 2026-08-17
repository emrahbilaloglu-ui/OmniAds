import { describe, expect, it } from "vitest";

import { presentKlaviyoFlow } from "@/lib/klaviyo/flow-presentation";
import type { KlaviyoFlowMetricRow } from "@/lib/klaviyo/warehouse";

function row(overrides: Partial<KlaviyoFlowMetricRow> = {}): KlaviyoFlowMetricRow {
  return {
    flowId: "flow_1",
    flowName: "Welcome Series",
    flowStatus: "live",
    currency: "USD",
    revenue: 18420,
    openRate: 0.54,
    recipients: 12480,
    ...overrides,
  };
}

describe("presentKlaviyoFlow", () => {
  it("formats the design's three numeric columns", () => {
    expect(presentKlaviyoFlow(row())).toEqual({
      id: "flow_1",
      name: "Welcome Series",
      status: "Live",
      revenue: "$18,420",
      openRate: "54%",
      recipients: "12,480",
    });
  });

  it("capitalises Klaviyo's own status verb without relabelling it", () => {
    expect(presentKlaviyoFlow(row({ flowStatus: "draft" })).status).toBe("Draft");
    expect(presentKlaviyoFlow(row({ flowStatus: "manual" })).status).toBe(
      "Manual",
    );
  });

  it("returns null — never zero — for every unreported statistic", () => {
    const presented = presentKlaviyoFlow(
      row({ revenue: null, openRate: null, recipients: null }),
    );
    expect(presented.revenue).toBeNull();
    expect(presented.openRate).toBeNull();
    expect(presented.recipients).toBeNull();
  });

  it("keeps a genuine zero distinguishable from an absence", () => {
    const presented = presentKlaviyoFlow(
      row({ revenue: 0, openRate: 0, recipients: 0 }),
    );
    expect(presented.revenue).toBe("$0.00");
    expect(presented.openRate).toBe("0%");
    expect(presented.recipients).toBe("0");
  });

  it("refuses to claim a currency it was not given", () => {
    // A revenue number with no currency code renders as missing rather than
    // silently becoming dollars.
    expect(presentKlaviyoFlow(row({ currency: null })).revenue).toBeNull();
    const lira = presentKlaviyoFlow(row({ currency: "TRY" })).revenue ?? "";
    expect(lira.startsWith("TRY")).toBe(true);
    expect(lira).not.toContain("$");
  });

  it("passes a missing flow name straight through as null", () => {
    expect(presentKlaviyoFlow(row({ flowName: null })).name).toBeNull();
    expect(presentKlaviyoFlow(row({ flowStatus: null })).status).toBeNull();
  });
});
