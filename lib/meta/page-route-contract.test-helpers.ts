import { expect } from "vitest";
import {
  META_PAGE_OPTIONAL_SURFACES,
  META_PAGE_REQUIRED_SURFACE_ORDER,
} from "@/lib/meta/page-contract";

function expectNumberOrNull(value: unknown) {
  expect(value === null || typeof value === "number").toBe(true);
}

function expectStringOrNull(value: unknown) {
  expect(value === null || typeof value === "string").toBe(true);
}

function expectBoolean(value: unknown) {
  expect(typeof value).toBe("boolean");
}

export function assertMetaStatusPageContract(payload: Record<string, unknown>) {
  expect(payload).toHaveProperty("readinessLevel");
  expect(payload).toHaveProperty("domainReadiness");
  expect(payload).toHaveProperty("pageReadiness");
  expect(payload).toHaveProperty("coreReadiness");
  expect(payload).toHaveProperty("extendedCompleteness");
  expect(payload).toHaveProperty("currentDateInTimezone");
  expect(payload).toHaveProperty("primaryAccountTimezone");
  expect(payload).toHaveProperty("currentDayLive");
  expect(payload).toHaveProperty("retention");

  const pageReadiness = payload.pageReadiness as Record<string, unknown>;
  expect(pageReadiness).toBeTruthy();
  expect(pageReadiness).toHaveProperty("state");
  expect(pageReadiness).toHaveProperty("usable");
  expect(pageReadiness).toHaveProperty("complete");
  expect(pageReadiness).toHaveProperty("selectedRangeMode");
  expect(pageReadiness).toHaveProperty("reason");
  expect(pageReadiness).toHaveProperty("missingRequiredSurfaces");
  expect(pageReadiness).toHaveProperty("requiredSurfaces");
  expect(pageReadiness).toHaveProperty("optionalSurfaces");

  const requiredSurfaces = pageReadiness.requiredSurfaces as Record<string, Record<string, unknown>>;
  const optionalSurfaces = pageReadiness.optionalSurfaces as Record<string, Record<string, unknown>>;
  const coreReadiness = payload.coreReadiness as Record<string, unknown>;
  const extendedCompleteness = payload.extendedCompleteness as Record<string, unknown>;

  expect(Object.keys(requiredSurfaces)).toEqual([...META_PAGE_REQUIRED_SURFACE_ORDER]);
  expect(Object.keys(optionalSurfaces)).toEqual([...META_PAGE_OPTIONAL_SURFACES]);
  expect(coreReadiness).toBeTruthy();
  expect(coreReadiness).toHaveProperty("state");
  expect(coreReadiness).toHaveProperty("usable");
  expect(coreReadiness).toHaveProperty("complete");
  expect(coreReadiness).toHaveProperty("percent");
  expect(coreReadiness).toHaveProperty("reason");
  expect(coreReadiness).toHaveProperty("summary");
  expect(coreReadiness).toHaveProperty("missingSurfaces");
  expect(coreReadiness).toHaveProperty("blockedSurfaces");
  expect(coreReadiness).toHaveProperty("surfaces");
  expect(Object.keys(coreReadiness.surfaces as Record<string, unknown>)).toEqual([
    "summary",
    "campaigns",
  ]);
  expect(extendedCompleteness).toBeTruthy();
  expect(extendedCompleteness).toHaveProperty("state");
  expect(extendedCompleteness).toHaveProperty("complete");
  expect(extendedCompleteness).toHaveProperty("percent");
  expect(extendedCompleteness).toHaveProperty("reason");
  expect(extendedCompleteness).toHaveProperty("summary");
  expect(extendedCompleteness).toHaveProperty("missingSurfaces");
  expect(extendedCompleteness).toHaveProperty("blockedSurfaces");
  expect(extendedCompleteness).toHaveProperty("surfaces");
  expect(Object.keys(extendedCompleteness.surfaces as Record<string, unknown>)).toEqual([
    "breakdowns.age",
    "breakdowns.location",
    "breakdowns.placement",
  ]);

  for (const key of META_PAGE_REQUIRED_SURFACE_ORDER) {
    expect(requiredSurfaces[key]).toEqual(
      expect.objectContaining({
        state: expect.any(String),
        blocking: expect.any(Boolean),
        countsForPageCompleteness: true,
        truthClass: expect.any(String),
      })
    );
    expect(requiredSurfaces[key].reason === null || typeof requiredSurfaces[key].reason === "string").toBe(true);
  }

  for (const key of META_PAGE_OPTIONAL_SURFACES) {
    expect(optionalSurfaces[key]).toEqual(
      expect.objectContaining({
        state: expect.any(String),
        blocking: expect.any(Boolean),
        countsForPageCompleteness: false,
        truthClass: expect.any(String),
      })
    );
    expect(optionalSurfaces[key].reason === null || typeof optionalSurfaces[key].reason === "string").toBe(true);
  }

  if (payload.currentDayLive) {
    const currentDayLive = payload.currentDayLive as Record<string, unknown>;
    expectBoolean(currentDayLive.summaryAvailable);
    expectBoolean(currentDayLive.campaignsAvailable);
  }

  const retention = payload.retention as Record<string, unknown>;
  expectBoolean(retention.runtimeAvailable);
  expectBoolean(retention.executionEnabled);
  expectBoolean(retention.defaultExecutionDisabled);
  expect(typeof retention.mode).toBe("string");
  expect(typeof retention.gateReason).toBe("string");
  expect(retention.policy).toBeTruthy();
  expect(Array.isArray(retention.tables)).toBe(true);
}

export function assertMetaSummaryPageContract(payload: Record<string, unknown>) {
  expect(payload).toHaveProperty("totals");
  const totals = payload.totals as Record<string, unknown>;
  expectNumberOrNull(totals.spend);
  expectNumberOrNull(totals.revenue);
  expectNumberOrNull(totals.cpa);
  expectNumberOrNull(totals.roas);
}

export function assertMetaCampaignRowPageContract(row: Record<string, unknown>) {
  expectStringOrNull(row.id);
  expectStringOrNull(row.name);
  expectStringOrNull(row.status);
  expectStringOrNull(row.objective);
  expectNumberOrNull(row.spend);
  expectNumberOrNull(row.revenue);
  expectNumberOrNull(row.roas);
  expectNumberOrNull(row.cpa);
  expectNumberOrNull(row.dailyBudget);
  expectNumberOrNull(row.lifetimeBudget);
  expectNumberOrNull(row.previousDailyBudget);
  expectNumberOrNull(row.previousLifetimeBudget);
  expectStringOrNull(row.previousBudgetCapturedAt);
}

export function assertMetaAdSetRowPageContract(row: Record<string, unknown>) {
  expectStringOrNull(row.id);
  expectStringOrNull(row.name);
  expectStringOrNull(row.status);
  expectStringOrNull(row.optimizationGoal);
  expectStringOrNull(row.bidStrategyLabel);
  expectNumberOrNull(row.bidValue);
  expectStringOrNull(row.bidValueFormat);
  expectNumberOrNull(row.previousBidValue);
  expectStringOrNull(row.previousBidValueFormat);
  expectStringOrNull(row.previousBidValueCapturedAt);
  expectNumberOrNull(row.spend);
  expectNumberOrNull(row.revenue);
  expectNumberOrNull(row.cpa);
  expectNumberOrNull(row.ctr);
}

export function assertMetaBreakdownsPageContract(payload: Record<string, unknown>) {
  for (const surface of ["age", "location", "placement"] as const) {
    expect(Array.isArray(payload[surface])).toBe(true);
    const rows = payload[surface] as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      const row = rows[0];
      expectStringOrNull(row.key);
      expectStringOrNull(row.label);
      expectNumberOrNull(row.spend);
      expectNumberOrNull(row.revenue);
    }
  }
}

export function assertMetaRecommendationsPageContract(payload: Record<string, unknown>) {
  expect(payload.status).toBe("ok");
  expect(Array.isArray(payload.recommendations)).toBe(true);
  const recommendations = payload.recommendations as Array<Record<string, unknown>>;
  if (recommendations.length > 0) {
    const recommendation = recommendations[0];
    expectStringOrNull(recommendation.id);
    expectStringOrNull(recommendation.campaignId);
    expectStringOrNull(recommendation.title);
    expectStringOrNull(recommendation.recommendedAction);
    expectStringOrNull(recommendation.why);
    expectStringOrNull(recommendation.summary);
    expectStringOrNull(recommendation.expectedImpact);
    expectStringOrNull(recommendation.decisionState);
    expect(Array.isArray(recommendation.evidence)).toBe(true);
  }
}
