import { describe, expect, it } from "vitest";
import {
  buildRequestUrl,
  deriveCurrentActiveContext,
  isAuditLocalRefreshUrl,
  resolveAuditBaseUrl,
  resolveAuditWindow,
  selectDeterministicAuditSample,
} from "./creative-live-firm-audit";

describe("creative live firm audit helpers", () => {
  it("builds a last-30-completed-days audit window", () => {
    expect(resolveAuditWindow("2026-04-24")).toEqual({
      todayReference: "2026-04-24",
      startDate: "2026-03-25",
      endDate: "2026-04-23",
      days: 30,
      excludesToday: true,
    });
  });

  it("uses the runtime-safe local dev base URL by default", () => {
    expect(resolveAuditBaseUrl()).toBe("http://127.0.0.1:3000");
  });

  it("builds decision-os URLs against an explicit base URL", () => {
    expect(
      buildRequestUrl({
        baseUrl: "https://audit.example.test/base/",
        businessId: "biz-01",
        startDate: "2026-03-25",
        endDate: "2026-04-23",
        decisionAsOf: "2026-04-23",
      }),
    ).toBe(
      "https://audit.example.test/api/creatives/decision-os?businessId=biz-01&startDate=2026-03-25&endDate=2026-04-23&decisionAsOf=2026-04-23",
    );
  });

  it("only short-circuits local decision-os refresh URLs", () => {
    expect(
      isAuditLocalRefreshUrl(
        "http://127.0.0.1:3000/api/creatives/decision-os?businessId=biz-01",
      ),
    ).toBe(true);
    expect(
      isAuditLocalRefreshUrl(
        "https://graph.facebook.com/v25.0/act_123/insights?fields=ad_id,spend",
      ),
    ).toBe(false);
  });

  it("treats active campaign and ad set context as active", () => {
    const result = deriveCurrentActiveContext({
      contextRow: {
        campaignId: "cmp-active",
        adSetId: "adset-active",
      },
      campaignStatusById: new Map([["cmp-active", "ACTIVE"]]),
      adSetStatusById: new Map([["adset-active", "ACTIVE"]]),
    });

    expect(result).toEqual({
      isActive: true,
      campaignStatus: "ACTIVE",
      adSetStatus: "ACTIVE",
      source: "campaign_and_adset",
    });
  });

  it("does not treat a paused ad set as active even if the campaign is active", () => {
    const result = deriveCurrentActiveContext({
      contextRow: {
        campaignId: "cmp-active",
        adSetId: "adset-paused",
      },
      campaignStatusById: new Map([["cmp-active", "ACTIVE"]]),
      adSetStatusById: new Map([["adset-paused", "PAUSED"]]),
    });

    expect(result.isActive).toBe(false);
    expect(result.source).toBe("campaign_and_adset");
  });

  it("uses Decision OS delivery context without requiring an extra campaign/ad set map read", () => {
    const result = deriveCurrentActiveContext({
      contextRow: {
        campaignId: "cmp-active",
        adSetId: "adset-active",
      },
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        activeDelivery: true,
        pausedDelivery: false,
      },
    });

    expect(result).toEqual({
      isActive: true,
      campaignStatus: "ACTIVE",
      adSetStatus: "ACTIVE",
      source: "campaign_and_adset",
    });
  });

  it("keeps paused Decision OS delivery context inactive even when statuses are active", () => {
    const result = deriveCurrentActiveContext({
      contextRow: {
        campaignId: "cmp-active",
        adSetId: "adset-active",
      },
      deliveryContext: {
        campaignStatus: "ACTIVE",
        adSetStatus: "ACTIVE",
        activeDelivery: true,
        pausedDelivery: true,
      },
    });

    expect(result.isActive).toBe(false);
    expect(result.source).toBe("campaign_and_adset");
  });

  it("prioritizes active creatives by spend and then fills with inactive creatives", () => {
    const sample = selectDeterministicAuditSample(
      [
        { creativeId: "creative-03", spend: 180, isActive: false },
        { creativeId: "creative-02", spend: 120, isActive: true },
        { creativeId: "creative-01", spend: 220, isActive: true },
        { creativeId: "creative-04", spend: 260, isActive: false },
      ],
      3,
    );

    expect(sample.map((row) => row.creativeId)).toEqual([
      "creative-01",
      "creative-02",
      "creative-04",
    ]);
  });
});
