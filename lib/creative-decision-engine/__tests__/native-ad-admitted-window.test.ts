import { describe, expect, it } from "vitest";

import {
  resolveAdmittedContextWindow,
  type AdmittedContextWindowDay,
} from "../native-ad-admitted-window";
import {
  exactContextIdentityKey,
  exactContextObservedParts,
} from "../jobs/ad-calibration-job";

/*
  ADR D107 — only an OBSERVED difference ends an admitted run.

  These are the calibration half of the rule. The scenarios are the same six
  day sequences `native-ad-admitted-window.db.test.ts` feeds the hydration SQL,
  so the two halves are pinned to the same windows (D098 parity).
*/

interface Day {
  date: string;
  spend: number;
  conversions: number;
  revenue: number;
  campaignId: string | null;
  adsetId: string | null;
  objective: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  accountTimezone: string | null;
  accountCurrency: string | null;
}

const DATES = [
  "2026-09-01",
  "2026-09-02",
  "2026-09-03",
  "2026-09-04",
  "2026-09-05",
  "2026-09-06",
  "2026-09-07",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
];

function day(
  date: string,
  config: {
    objective: string | null;
    goal: string | null;
    empty?: boolean;
    currency?: string | null;
  },
): Day {
  return {
    date,
    spend: config.empty ? 0 : 100,
    conversions: config.empty ? 0 : 3,
    revenue: config.empty ? 0 : 400,
    campaignId: "campaign",
    adsetId: "adset",
    objective: config.objective,
    optimizationGoal: config.goal,
    customEventType: config.goal === null ? null : "PURCHASE",
    accountTimezone: "UTC",
    accountCurrency: config.currency === undefined ? "USD" : config.currency,
  };
}

/** A key exactly as calibration builds one: null unless the context resolves. */
function contextKey(row: Day): string | null {
  if (
    !row.campaignId ||
    !row.adsetId ||
    !row.objective ||
    !row.accountTimezone ||
    !row.accountCurrency ||
    (!row.optimizationGoal && !row.customEventType)
  ) {
    return null;
  }
  const goal = row.optimizationGoal?.toUpperCase() ?? "";
  const event = row.customEventType?.toUpperCase() ?? "";
  return exactContextIdentityKey({
    accountTimezone: "UTC",
    accountCurrency: "USD",
    campaignId: row.campaignId,
    adsetId: row.adsetId,
    objective: row.objective,
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
    customConversionId: null,
    optimizationContext: `goal=${goal}|event=${event}`,
    cohort: "purchase",
  });
}

function walk(days: Day[]) {
  return resolveAdmittedContextWindow(
    days,
    (row): AdmittedContextWindowDay => ({
      date: row.date,
      spend: row.spend,
      conversions: row.conversions,
      revenue: row.revenue,
      contextKey: contextKey(row),
      contextParts: exactContextObservedParts(row),
    }),
  );
}

const SALES = "OUTCOME_SALES";

describe("ADR D107 admitted-window walk", () => {
  it("bridges an unreadable interior day with the same context on both sides", () => {
    const window = walk(
      DATES.map((date) =>
        date === "2026-09-06"
          ? day(date, { objective: null, goal: null })
          : day(date, { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
      ),
    );
    expect(window).toMatchObject({
      reason: "admitted",
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      truncatedByChange: false,
      truncatedByGap: false,
      bridgedUnresolvedDayCount: 1,
      observedDayCount: 10,
      droppedOlderDays: 0,
      droppedNewerDays: 0,
    });
    expect(window.rows).toHaveLength(10);
  });

  it("starts the run at an observed configuration change", () => {
    const window = walk(
      DATES.map((date) =>
        day(date, {
          objective: SALES,
          goal: date < "2026-09-06" ? "OFFSITE_CONVERSIONS" : "VALUE",
        }),
      ),
    );
    expect(window).toMatchObject({
      startDate: "2026-09-06",
      endDate: "2026-09-10",
      truncatedByChange: true,
      truncatedByGap: false,
      bridgedUnresolvedDayCount: 0,
      droppedOlderDays: 5,
    });
  });

  it("ends the run at an unresolved day that observed a contradicting value", () => {
    const window = walk(
      DATES.map((date) =>
        date === "2026-09-06"
          ? day(date, { objective: null, goal: "VALUE" })
          : day(date, { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
      ),
    );
    expect(window).toMatchObject({
      startDate: "2026-09-07",
      endDate: "2026-09-10",
      truncatedByChange: true,
      bridgedUnresolvedDayCount: 0,
      droppedOlderDays: 6,
    });
  });

  it("does not bridge unreadable days at the older edge", () => {
    const window = walk(
      DATES.map((date) =>
        date < "2026-09-05"
          ? day(date, { objective: null, goal: null })
          : day(date, { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
      ),
    );
    expect(window).toMatchObject({
      startDate: "2026-09-05",
      endDate: "2026-09-10",
      truncatedByChange: false,
      truncatedByGap: true,
      bridgedUnresolvedDayCount: 0,
      droppedOlderDays: 4,
    });
  });

  it("ends the run at the newest resolved day, never carrying it forward", () => {
    const window = walk(
      DATES.map((date) =>
        date > "2026-09-08"
          ? day(date, { objective: null, goal: null })
          : day(date, { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
      ),
    );
    expect(window).toMatchObject({
      startDate: "2026-09-01",
      endDate: "2026-09-08",
      bridgedUnresolvedDayCount: 0,
      droppedNewerDays: 2,
    });
  });

  it("keeps an unreadable empty day transparent", () => {
    const window = walk(
      DATES.map((date) =>
        date === "2026-09-06"
          ? day(date, { objective: null, goal: null, empty: true })
          : day(date, { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
      ),
    );
    expect(window).toMatchObject({
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      bridgedUnresolvedDayCount: 0,
      truncatedByGap: false,
    });
    expect(window.rows).toHaveLength(10);
  });

  it("drops an unresolved run that sits between two different contexts", () => {
    // B, gap, A, A: the gap has an observation of a DIFFERENT context on one
    // side only, so which context it belonged to is unknowable. It is left
    // out, and the run starts at the first A.
    const days = [
      day("2026-09-01", { objective: SALES, goal: "VALUE" }),
      day("2026-09-02", { objective: null, goal: null }),
      day("2026-09-03", { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
      day("2026-09-04", { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
    ];
    expect(walk(days)).toMatchObject({
      startDate: "2026-09-03",
      endDate: "2026-09-04",
      truncatedByChange: true,
      truncatedByGap: true,
      bridgedUnresolvedDayCount: 0,
      droppedOlderDays: 2,
    });
  });

  it("bridges several unreadable days, and only between same-context days", () => {
    const days = [
      day("2026-09-01", { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
      day("2026-09-02", { objective: null, goal: null }),
      day("2026-09-03", { objective: null, goal: "OFFSITE_CONVERSIONS" }),
      day("2026-09-04", { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
    ];
    expect(walk(days)).toMatchObject({
      startDate: "2026-09-01",
      endDate: "2026-09-04",
      bridgedUnresolvedDayCount: 2,
      truncatedByChange: false,
      truncatedByGap: false,
    });
  });

  it("still reports no context when nothing resolves", () => {
    const window = walk(
      DATES.map((date) => day(date, { objective: null, goal: null })),
    );
    expect(window.reason).toBe("no_context_day");
    expect(window.rows).toEqual([]);
  });

  it("never bridges a day that observed a different account currency", () => {
    // The day does not resolve (no objective), but it DID observe TRY where
    // the run is USD: a second currency is a contradiction, not a gap.
    const days = [
      day("2026-09-01", { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
      day("2026-09-02", { objective: null, goal: null, currency: "TRY" }),
      day("2026-09-03", { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
    ];
    expect(walk(days)).toMatchObject({
      startDate: "2026-09-03",
      endDate: "2026-09-03",
      truncatedByChange: true,
      bridgedUnresolvedDayCount: 0,
    });
  });

  it("bridges a day that only lacks its currency, and says it was bridged", () => {
    const days = [
      day("2026-09-01", { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
      day("2026-09-02", { objective: SALES, goal: "OFFSITE_CONVERSIONS", currency: null }),
      day("2026-09-03", { objective: SALES, goal: "OFFSITE_CONVERSIONS" }),
    ];
    expect(walk(days)).toMatchObject({
      startDate: "2026-09-01",
      endDate: "2026-09-03",
      bridgedUnresolvedDayCount: 1,
    });
  });
});
