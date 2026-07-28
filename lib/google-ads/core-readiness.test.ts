import { describe, expect, it } from "vitest";
import { buildGoogleAdsCoreReadiness } from "@/lib/google-ads/core-readiness";
import {
  resolveGoogleAdsCompletion,
  unknownGoogleAdsCompletion,
} from "@/lib/google-ads/completion-semantics";

const TOTAL_DAYS = 730;

/**
 * Verdicts are built with the real contract rather than hand-written literals,
 * so these tests fail if `resolveGoogleAdsCompletion` ever starts treating
 * coverage as completion again.
 */
function verdict(options: {
  coveredDays: number;
  postCloseObservedDays: number;
  lookbackExhaustedDays?: number;
  includesOpenDay?: boolean;
}) {
  return resolveGoogleAdsCompletion({
    totalDays: TOTAL_DAYS,
    coveredDays: options.coveredDays,
    postCloseObservedDays: options.postCloseObservedDays,
    lookbackExhaustedDays: options.lookbackExhaustedDays ?? 0,
    includesOpenDay: options.includesOpenDay ?? false,
  });
}

function build(overrides: Partial<Parameters<typeof buildGoogleAdsCoreReadiness>[0]> = {}) {
  const settled = verdict({
    coveredDays: TOTAL_DAYS,
    postCloseObservedDays: TOTAL_DAYS,
    lookbackExhaustedDays: TOTAL_DAYS,
  });
  return buildGoogleAdsCoreReadiness({
    connected: true,
    assignedAccountCount: 1,
    totalDays: TOTAL_DAYS,
    campaignReadyThroughDate: "2026-03-30",
    accountCoveredDays: TOTAL_DAYS,
    campaignCoveredDays: TOTAL_DAYS,
    accountCompletion: settled,
    campaignCompletion: settled,
    accountPostCloseObservedDays: TOTAL_DAYS,
    campaignPostCloseObservedDays: TOTAL_DAYS,
    ...overrides,
  });
}

describe("buildGoogleAdsCoreReadiness", () => {
  it("refuses to call a fully covered but never re-read range complete", () => {
    // The exact defect: every day has a row, no day has been read since it
    // closed. The old implementation returned 100% and no pending surfaces.
    const frozen = verdict({ coveredDays: TOTAL_DAYS, postCloseObservedDays: 0 });
    const result = build({
      accountCompletion: frozen,
      campaignCompletion: frozen,
      accountPostCloseObservedDays: 0,
      campaignPostCloseObservedDays: 0,
    });

    expect(result.historicalCompletionState).toBe("provisional");
    expect(result.historicalProgressPercent).toBe(0);
    expect(result.historicalComplete).toBe(false);
    expect(result.historicalMayStopPolling).toBe(false);
    expect(result.needsBootstrap).toBe(true);
    expect(result.productPendingSurfaces).toEqual(["account_daily", "campaign_daily"]);
    expect(result.overallCompletedDays).toBe(0);
    expect(result.overallAccountCompletedDays).toBe(0);
    // Coverage survives, but only as the availability answer it always was.
    expect(result.overallCoveredDays).toBe(TOTAL_DAYS);
    expect(result.coreUsable).toBe(true);
  });

  it("NEGATIVE CONTROL: the percent is the verdict's, never recomputed from coverage", () => {
    // Chosen so the two formulas cannot coincide. Coverage math on the campaign
    // scope gives round(412/730*100) = 56 — the number the previous test suite
    // asserted. The verdict, measured on post-close observations, gives 41.
    const partiallyRead = verdict({ coveredDays: 412, postCloseObservedDays: 300 });
    const result = build({
      accountCoveredDays: 412,
      campaignCoveredDays: 412,
      accountCompletion: partiallyRead,
      campaignCompletion: partiallyRead,
      accountPostCloseObservedDays: 300,
      campaignPostCloseObservedDays: 300,
    });

    expect(partiallyRead.percent).toBe(41);
    expect(result.historicalProgressPercent).toBe(41);
    expect(result.historicalProgressPercent).toBe(partiallyRead.percent);
    // Teeth: these are the two coverage-derived numbers the old code produced.
    expect(result.historicalProgressPercent).not.toBe(
      Math.round((result.overallCoveredDays / result.effectiveHistoricalTotalDays) * 100),
    );
    expect(result.historicalProgressPercent).not.toBe(56);

    // Same guard where coverage is complete: coverage math says 100, the
    // verdict says 50, and only one of those may reach the surface.
    const halfRead = verdict({ coveredDays: TOTAL_DAYS, postCloseObservedDays: 365 });
    const covered = build({
      accountCompletion: halfRead,
      campaignCompletion: halfRead,
      accountPostCloseObservedDays: 365,
      campaignPostCloseObservedDays: 365,
    });
    expect(covered.overallCoveredDays).toBe(TOTAL_DAYS);
    expect(covered.historicalProgressPercent).toBe(50);
    expect(covered.historicalProgressPercent).not.toBe(100);
  });

  it("caps progress below 100 while the range is still inside the conversion lookback", () => {
    const converging = verdict({
      coveredDays: TOTAL_DAYS,
      postCloseObservedDays: TOTAL_DAYS,
      lookbackExhaustedDays: TOTAL_DAYS - 30,
    });
    const result = build({
      accountCompletion: converging,
      campaignCompletion: converging,
    });

    expect(result.historicalCompletionState).toBe("converging");
    expect(result.historicalProgressPercent).toBe(99);
    expect(result.historicalProgressPercent).toBeLessThan(100);
    expect(result.historicalComplete).toBe(false);
    expect(result.historicalMayStopPolling).toBe(false);
    // Nothing is owed: every day HAS been re-read, so this must not look like
    // outstanding backfill work or the repair path never stops.
    expect(result.needsBootstrap).toBe(false);
    expect(result.productPendingSurfaces).toEqual([]);
  });

  it("only reports 100 percent once the range is policy-settled", () => {
    const result = build();

    expect(result.historicalCompletionState).toBe("settled");
    expect(result.historicalProgressPercent).toBe(100);
    expect(result.historicalComplete).toBe(true);
    expect(result.historicalMayStopPolling).toBe(true);
    expect(result.coreUsable).toBe(true);
    expect(result.needsBootstrap).toBe(false);
    expect(result.productPendingSurfaces).toEqual([]);
  });

  it("fails closed on an unknown verdict without inventing a failure", () => {
    const unknown = unknownGoogleAdsCompletion("Freshness tables are not ready yet.");
    const result = build({
      accountCompletion: unknown,
      campaignCompletion: unknown,
      // Even if a caller hands over day counts alongside an unknown verdict,
      // they came from a read that did not complete and are not trusted.
      accountPostCloseObservedDays: TOTAL_DAYS,
      campaignPostCloseObservedDays: TOTAL_DAYS,
    });

    expect(result.historicalCompletionState).toBe("unknown");
    expect(result.evidenceAvailable).toBe(false);
    expect(result.coreUsable).toBe(false);
    expect(result.historicalProgressPercent).toBe(0);
    expect(result.historicalComplete).toBe(false);
    expect(result.historicalMayStopPolling).toBe(false);
    expect(result.overallCompletedDays).toBe(0);
    expect(result.overallAccountCompletedDays).toBe(0);
    expect(result.needsBootstrap).toBe(true);
    expect(result.productPendingSurfaces).toEqual(["account_daily", "campaign_daily"]);
  });

  it("takes the weaker of the two core scopes", () => {
    const settled = verdict({
      coveredDays: TOTAL_DAYS,
      postCloseObservedDays: TOTAL_DAYS,
      lookbackExhaustedDays: TOTAL_DAYS,
    });
    const frozenCampaign = verdict({ coveredDays: TOTAL_DAYS, postCloseObservedDays: 100 });
    const result = build({
      accountCompletion: settled,
      campaignCompletion: frozenCampaign,
      campaignPostCloseObservedDays: 100,
    });

    expect(result.historicalCompletionState).toBe("provisional");
    expect(result.historicalProgressPercent).toBe(frozenCampaign.percent);
    expect(result.historicalComplete).toBe(false);
    expect(result.productPendingSurfaces).toEqual(["campaign_daily"]);
  });

  it("still uses coverage for the availability question it legitimately answers", () => {
    // No rows at all for a scope: there is nothing to render, independent of
    // any freshness verdict. This is the one job coverage keeps.
    const result = build({ campaignCoveredDays: 0 });

    expect(result.coreUsable).toBe(false);
    expect(result.overallCoveredDays).toBe(0);
    // ...and it is not allowed to drag the completion claim around with it.
    expect(result.historicalCompletionState).toBe("settled");
  });

  it("stays not-usable while disconnected or unassigned", () => {
    expect(build({ connected: false }).coreUsable).toBe(false);
    expect(build({ assignedAccountCount: 0 }).coreUsable).toBe(false);
    expect(build({ connected: false }).needsBootstrap).toBe(false);
  });

  it("passes the campaign ready-through date through untouched", () => {
    expect(build({ campaignReadyThroughDate: "2025-05-16" }).historicalReadyThroughDate).toBe(
      "2025-05-16",
    );
    expect(build({ campaignReadyThroughDate: null }).historicalReadyThroughDate).toBeNull();
  });
});
