import { describe, expect, it } from "vitest";
import {
  isPurchaseCohort,
  resolveMetaFunnelCohort,
  type MetaFunnelCohort,
} from "@/lib/meta/funnel-cohort";

const eventCases: Array<[string, MetaFunnelCohort]> = [
  ["PURCHASE", "purchase"],
  ["VALUE", "purchase"],
  ["ADD_TO_CART", "mid_funnel"],
  ["INITIATE_CHECKOUT", "mid_funnel"],
  ["VIEW_CONTENT", "mid_funnel"],
  ["SEARCH", "mid_funnel"],
  ["ADD_PAYMENT_INFO", "mid_funnel"],
  ["ADD_TO_WISHLIST", "mid_funnel"],
  ["LEAD", "lead"],
  ["COMPLETE_REGISTRATION", "lead"],
  ["SUBMIT_APPLICATION", "lead"],
  ["START_TRIAL", "lead"],
  ["SUBSCRIBE", "lead"],
  ["CONTACT", "lead"],
];

const optimizationGoalCases: Array<[string, MetaFunnelCohort]> = [
  ["PURCHASE", "purchase"],
  ["VALUE", "purchase"],
  ["PRODUCT_CATALOG_SALES", "purchase"],
  ["OFFSITE_CONVERSIONS", "purchase"],
  ["ADD_TO_CART", "mid_funnel"],
  ["INITIATE_CHECKOUT", "mid_funnel"],
  ["LEAD", "lead"],
  ["LEAD_GENERATION", "lead"],
  ["QUALITY_LEAD", "lead"],
  ["LANDING_PAGE_VIEWS", "traffic"],
  ["LINK_CLICKS", "traffic"],
  ["THRUPLAY", "upper_funnel"],
  ["VIDEO_VIEWS", "upper_funnel"],
  ["REACH", "upper_funnel"],
  ["IMPRESSIONS", "upper_funnel"],
  ["AWARENESS", "upper_funnel"],
  ["AD_RECALL_LIFT", "upper_funnel"],
  ["POST_ENGAGEMENT", "engagement"],
  ["PAGE_LIKES", "engagement"],
  ["EVENT_RESPONSES", "engagement"],
  ["REPLIES", "unknown"],
  ["MESSAGING_PURCHASE_CONVERSION", "unknown"],
  ["CONVERSATIONS", "unknown"],
  ["MESSAGES", "unknown"],
  ["DERIVED_EVENTS", "unknown"],
];

describe("resolveMetaFunnelCohort", () => {
  it.each(eventCases)("maps custom event %s to %s", (customEventType, expected) => {
    expect(resolveMetaFunnelCohort({ customEventType })).toBe(expected);
  });

  it.each(optimizationGoalCases)("maps optimization goal %s to %s", (optimizationGoal, expected) => {
    expect(resolveMetaFunnelCohort({ optimizationGoal })).toBe(expected);
  });

  it("treats OFFSITE_CONVERSIONS without an event as purchase", () => {
    expect(resolveMetaFunnelCohort({
      optimizationGoal: "OFFSITE_CONVERSIONS",
      customEventType: null,
    })).toBe("purchase");
    expect(resolveMetaFunnelCohort({
      optimizationGoal: "OFFSITE_CONVERSIONS",
      customEventType: "",
    })).toBe("purchase");
  });

  it("lets explicit conversion event win over optimization goal", () => {
    expect(resolveMetaFunnelCohort({
      optimizationGoal: "OFFSITE_CONVERSIONS",
      customEventType: "VIEW_CONTENT",
    })).toBe("mid_funnel");
  });

  it("normalizes whitespace and hyphens before matching", () => {
    expect(resolveMetaFunnelCohort({ customEventType: "  add-to-cart " })).toBe("mid_funnel");
    expect(resolveMetaFunnelCohort({ optimizationGoal: "landing page views" })).toBe("traffic");
    expect(resolveMetaFunnelCohort({ optimizationGoal: "Lead" })).toBe("lead");
  });

  it("uses objective only when goal and event metadata are absent", () => {
    expect(resolveMetaFunnelCohort({ objective: "OUTCOME_SALES" })).toBe("purchase");
    expect(resolveMetaFunnelCohort({ objective: "OUTCOME_LEADS" })).toBe("lead");
    expect(resolveMetaFunnelCohort({ objective: "OUTCOME_TRAFFIC" })).toBe("traffic");
    expect(resolveMetaFunnelCohort({ objective: "OUTCOME_AWARENESS" })).toBe("upper_funnel");
    expect(resolveMetaFunnelCohort({ objective: "OUTCOME_ENGAGEMENT" })).toBe("engagement");
    expect(resolveMetaFunnelCohort({
      optimizationGoal: "LANDING_PAGE_VIEWS",
      objective: "OUTCOME_SALES",
    })).toBe("traffic");
  });

  it("never treats messaging optimization as post-engagement evidence", () => {
    expect(
      resolveMetaFunnelCohort({
        optimizationGoal: "CONVERSATIONS",
        objective: "OUTCOME_ENGAGEMENT",
      }),
    ).toBe("unknown");
  });

  it("uses revenue-bearing fallback only when all cohort metadata is absent", () => {
    expect(resolveMetaFunnelCohort({ purchases: 3, revenue: 120 })).toBe("purchase");
    expect(resolveMetaFunnelCohort({
      optimizationGoal: "LANDING_PAGE_VIEWS",
      purchases: 3,
      revenue: 120,
    })).toBe("traffic");
  });

  it("returns unknown when no field resolves", () => {
    expect(resolveMetaFunnelCohort({ optimizationGoal: null, customEventType: null })).toBe("unknown");
    expect(resolveMetaFunnelCohort({})).toBe("unknown");
  });

  it("identifies only purchase as a purchase cohort", () => {
    expect(isPurchaseCohort("purchase")).toBe(true);
    expect(isPurchaseCohort("upper_funnel")).toBe(false);
  });
});
