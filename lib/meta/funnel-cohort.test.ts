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
  ["CONTACT", "engagement"],
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
  ["REPLIES", "engagement"],
  ["MESSAGING_PURCHASE_CONVERSION", "engagement"],
  ["CONVERSATIONS", "engagement"],
  ["MESSAGES", "engagement"],
  ["DERIVED_EVENTS", "engagement"],
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

  it("returns unknown when no field resolves", () => {
    expect(resolveMetaFunnelCohort({ optimizationGoal: null, customEventType: null })).toBe("unknown");
    expect(resolveMetaFunnelCohort({})).toBe("unknown");
  });

  it("identifies only purchase as a purchase cohort", () => {
    expect(isPurchaseCohort("purchase")).toBe(true);
    expect(isPurchaseCohort("upper_funnel")).toBe(false);
  });
});
