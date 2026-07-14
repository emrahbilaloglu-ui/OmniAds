import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdDecisionAuthorityTrail,
  DecisionsOsView,
  isExactAdExecutionSourceBlocked,
  isCampaignRoleCorrectionTarget,
  nextAdCandidateLimit,
  preserveDecisionWorkspacePlaceholder,
  resolveGlobalBlockingBanner,
  resolveAvailableDecisionLane,
} from "@/components/meta/os/DecisionsOsView";
import type {
  MetaOsAdDecision,
  MetaOsDecisionsPresentation,
  MetaOsWorkspaceBanner,
} from "@/lib/meta/decisions-os-contract";

const state = vi.hoisted(() => ({
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: state.replace }),
  useSearchParams: () => new URLSearchParams("providerAccountId=act_1"),
}));

const action = {
  code: "review_budget",
  label: "Review Campaign Budget",
  intent: "manual",
  targetLevel: "campaign",
  providerMutation: null,
  scopeNote: "Affects this campaign only",
};

const priority = {
  band: "high",
  rank: 330,
  version: "meta-os-decisions.presentation.v3",
};

const urgency = {
  level: "critical",
  rank: 4,
  label: "Urgent",
  reason: "Above target at mature spend.",
} as const;

const metrics = {
  spend: 1000,
  purchases: 20,
  roas: 2.4,
  cpa: null,
  ctr: null,
  frequency: null,
  effectiveTargetRoas: null,
  ratioToTarget: null,
  currency: "EUR",
  attribution: "meta_attributed",
  grain: "campaign_or_adset",
};

const workspace = {
  system: {
    laneSnapshotCreatedAt: "2026-07-10T04:00:00.000Z",
    snapshotHealth: { status: "fresh" },
    engineVersion: "v3-test",
    currency: "EUR",
    killSwitchEngaged: false,
  },
  pulse: { lastSyncAt: "2026-07-10T04:00:00.000Z" },
  viewer: { readOnly: false, readOnlyReason: null },
  banners: [] as MetaOsWorkspaceBanner[],
  os: {
    contractVersion: "meta-os-decisions.presentation.v3",
    generatedAt: "2026-07-10T04:00:00.000Z",
    source: {
      snapshotAsOf: "2026-07-10",
      engineVersion: "v3-test",
      structureSource: "meta_recommendations",
      adsSource: "native_ad_decision",
    } as MetaOsDecisionsPresentation["source"],
    structure: {
      actCount: 1,
      blockedCount: 0,
      monitorCount: 0,
      suppressedAlternativeCount: 0,
      groups: [
        {
          id: "group:cmp_1",
          highestPriority: priority,
          highestUrgency: urgency,
          urgentAdsetCount: 0,
          adsets: [],
          campaign: {
            id: "campaign:cmp_1",
            sourceRecommendationId: "rec_1",
            level: "campaign",
            providerEntityId: "cmp_1",
            campaignId: "cmp_1",
            campaignName: "Prospecting",
            name: "Prospecting",
            lifecycleRole: "main",
            budgetOwner: "campaign",
            budgetMode: "campaign_budget",
            controlOwner: "campaign",
            status: "ACTIVE",
            optimizationGoal: "PURCHASE",
            action,
            lane: "act",
            priority,
            urgency,
            confidence: "high",
            assessment: "Budget opportunity",
            whyNow: "Above target at mature spend.",
            expectedImpact: "Cannot calculate",
            evidence: [],
            metrics,
            suppressedAlternativeCount: 0,
          },
        },
      ],
    },
    ads: {
      items: [],
      actCount: 0,
      blockedCount: 0,
      monitorCount: 0,
      statePreCapCounts: { act: 0, blocked: 0, monitor: 0 },
      eligiblePreCapCount: 0,
      omittedWithoutVerifiedAdId: 0,
      omittedAmbiguousIdentity: 0,
      omittedNotApplicable: 0,
      sourcePreCapCount: 0,
    },
    limitations: [],
  },
};

let workspaceForQuery = workspace;

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = String(queryKey[0]);
    if (key === "meta-provider-accounts") {
      return {
        data: [{ id: "act_1", name: "Atelier Nord", currency: "EUR" }],
        status: "success",
        fetchStatus: "idle",
        isLoading: false,
        isError: false,
        error: null,
      };
    }
    if (key === "meta-decisions-os-v2") {
      return {
        data: workspaceForQuery,
        status: "success",
        fetchStatus: "idle",
        isLoading: false,
        isError: false,
        error: null,
      };
    }
    return {
      data: { anomalies: [], count: 0, snapshotDate: "2026-07-10" },
      status: "success",
      fetchStatus: "idle",
      isLoading: false,
      isError: false,
      error: null,
    };
  },
}));

describe("DecisionsOsView", () => {
  beforeEach(() => {
    workspaceForQuery = workspace;
  });

  it("renders the Structure and Ads information architecture from the server presentation", () => {
    const html = renderToStaticMarkup(
      <DecisionsOsView
        businessId="biz_1"
        businessName="Atelier Nord"
        currency="EUR"
      />,
    );

    expect(html).toContain("Structure");
    expect(html).toContain("Ads");
    expect(html).toContain("Inactive assets");
    expect(html).toContain("Act Now");
    expect(html).toContain("Needs Resolution");
    expect(html).toContain("Monitoring");
    expect(html).toContain("All statuses");
    expect(html).toContain("Urgent");
    expect(html).toContain("Review Campaign Budget");
    expect(html).toContain("Prospecting");
    expect(html).toContain('data-provider-writes="none"');
    expect(html).toContain('data-workspace-query-status="success"');
    expect(html).not.toContain("Money Moves");
    expect(html).not.toContain("Creative Rotation");
  });

  it("does not render simulated preflight or success receipts", () => {
    const html = renderToStaticMarkup(
      <DecisionsOsView
        businessId="biz_1"
        businessName="Atelier Nord"
        currency="EUR"
      />,
    );

    expect(html).not.toContain("Run preflight");
    expect(html).not.toContain("Applying · verification pending");
    expect(html).not.toContain("Verified — provider confirmed");
  });

  it("renders stale-target authority as a scoped warning without a global action lock", () => {
    const targetAuthorityBanner = {
      id: "stale_commercial_target_authority",
      tone: "warning" as const,
      title: "Commercial targets need reconfirmation.",
      detail:
        "Configured targets are stale. Hard Scale/Cut authority is suppressed until the economics are reviewed and reconfirmed.",
      blocking: false,
      scope: "target_hard_actions" as const,
      action: {
        label: "Review commercial truth",
        href: "/commercial-truth",
      },
    };
    workspaceForQuery = {
      ...workspace,
      banners: [targetAuthorityBanner],
    };

    const html = renderToStaticMarkup(
      <DecisionsOsView
        businessId="biz_1"
        businessName="Atelier Nord"
        currency="EUR"
      />,
    );

    expect(html).toContain('data-scope="target_hard_actions"');
    expect(html).toContain("Hard Scale/Cut authority is suppressed");
    expect(html).toContain('href="/commercial-truth"');
    expect(html).toContain("Review commercial truth");
    expect(resolveGlobalBlockingBanner([targetAuthorityBanner])).toBeNull();
    expect(
      resolveGlobalBlockingBanner([
        { ...targetAuthorityBanner, blocking: true },
      ]),
    ).toBeNull();
  });

  it("blocks exact Ad actions visibly when the active source falls back to legacy review-only rows", () => {
    const degradedSource: MetaOsDecisionsPresentation["source"] = {
      ...workspace.os.source,
      adsSource: "legacy_creative_review_only" as const,
      health: "degraded" as const,
      fallbackReason: "native_latest_job_failed",
    };
    workspaceForQuery = {
      ...workspace,
      os: {
        ...workspace.os,
        source: degradedSource,
      },
    };

    const html = renderToStaticMarkup(
      <DecisionsOsView
        businessId="biz_1"
        businessName="IwaStore"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-decision-source-health"');
    expect(html).toContain('data-source-health="degraded"');
    expect(html).toContain('data-scope="account_ad_source"');
    expect(html).toContain('data-fallback-reason="native_latest_job_failed"');
    expect(html).toContain('data-blocking="true"');
    expect(html).toContain("Native Ad decisions are degraded.");
    expect(html).toContain("latest native Ad decision job failed");
    expect(html).toContain("Legacy rows remain review-only");
    expect(html).toContain("exact Ad actions are withheld");
    const executeSelection = {
      kind: "ad" as const,
      value: { action: { intent: "execute" } },
    };
    expect(
      isExactAdExecutionSourceBlocked(degradedSource, executeSelection),
    ).toBe(true);
    expect(
      isExactAdExecutionSourceBlocked(
        {
          ...degradedSource,
          health: undefined,
        },
        executeSelection,
      ),
    ).toBe(true);
    expect(
      isExactAdExecutionSourceBlocked(
        {
          ...degradedSource,
          adsSource: "native_ad_decision",
          health: "healthy",
          fallbackReason: null,
        },
        executeSelection,
      ),
    ).toBe(false);
    expect(
      isExactAdExecutionSourceBlocked(degradedSource, {
        kind: "ad",
        value: { action: { intent: "review" } },
      }),
    ).toBe(false);
    expect(
      isExactAdExecutionSourceBlocked(degradedSource, {
        kind: "ad",
        value: { action: { intent: "brief" } },
      }),
    ).toBe(false);
  });

  it("selects a non-empty Ads lane without changing the Structure lane", () => {
    const presentation = {
      ...workspace.os,
      ads: {
        ...workspace.os.ads,
        actCount: 0,
        blockedCount: 8,
        monitorCount: 60,
      },
    } as Parameters<typeof resolveAvailableDecisionLane>[0];

    expect(resolveAvailableDecisionLane(presentation, "ads", "act")).toBe(
      "blocked",
    );
    expect(resolveAvailableDecisionLane(presentation, "structure", "act")).toBe(
      "act",
    );
  });

  it("expands Ads decisions in bounded server pages", () => {
    expect(nextAdCandidateLimit(60)).toBe(120);
    expect(nextAdCandidateLimit(240)).toBe(300);
    expect(nextAdCandidateLimit(300)).toBe(300);
  });

  it("never carries Ads rows across businesses or provider accounts", () => {
    const previous = { os: { ads: { items: ["prior-account-ad"] } } };

    expect(
      preserveDecisionWorkspacePlaceholder(
        previous,
        { queryKey: ["meta-decisions-os-v2", "biz_1", "act_1"] },
        "biz_2",
        "act_2",
      ),
    ).toBeUndefined();
    expect(
      preserveDecisionWorkspacePlaceholder(
        previous,
        { queryKey: ["meta-decisions-os-v2", "biz_1", "act_1"] },
        "biz_1",
        "act_2",
      ),
    ).toBeUndefined();
  });

  it("allows campaign-role correction only from a campaign inspector", () => {
    expect(
      isCampaignRoleCorrectionTarget({
        kind: "structure",
        value: { level: "campaign", campaignId: "cmp_1" },
      }),
    ).toBe(true);
    expect(
      isCampaignRoleCorrectionTarget({
        kind: "structure",
        value: { level: "adset", campaignId: "cmp_1" },
      }),
    ).toBe(false);
    expect(
      isCampaignRoleCorrectionTarget({
        kind: "ad",
        value: { campaignId: "cmp_1" },
      }),
    ).toBe(false);
  });

  it("keeps prior rows only while the same scoped workspace refreshes", () => {
    const previous = { os: { ads: { items: ["same-account-ad"] } } };

    expect(
      preserveDecisionWorkspacePlaceholder(
        previous,
        { queryKey: ["meta-decisions-os-v2", "biz_1", "act_1", "28d"] },
        "biz_1",
        "act_1",
      ),
    ).toBe(previous);
  });

  it("renders all three decision stages and the first authority blocker", () => {
    const ad = {
      publishedLabel: "keep",
      engineVersion: "v3-ad-test",
      confidenceScore: 0.82,
      authorityProvenance: {
        availability: "available",
        preAuthorityLabel: "cut",
        postAuthorityRawLabel: "keep",
        publishedLabel: "keep",
        firstBlocker: {
          code: "source_freshness",
          label: "Source evidence is not fresh enough",
          explanation:
            "The mathematical verdict was held until the required source evidence is fresh.",
        },
      },
    } as MetaOsAdDecision;

    const html = renderToStaticMarkup(<AdDecisionAuthorityTrail ad={ad} />);

    expect(html).toContain("Mathematical / semantic verdict");
    expect(html).toContain("Post-authority raw label");
    expect(html).toContain("Published label");
    expect(html).toContain("First authority blocker");
    expect(html).toContain("Source evidence is not fresh enough");
    expect(html).toContain("required source evidence is fresh");
  });

  it("renders historical authority provenance as unavailable", () => {
    const ad = {
      publishedLabel: "test_more",
      engineVersion: "v3-old",
      confidenceScore: 0.5,
      authorityProvenance: {
        availability: "historical_unavailable",
        preAuthorityLabel: null,
        postAuthorityRawLabel: null,
        publishedLabel: "test_more",
        firstBlocker: null,
      },
    } as MetaOsAdDecision;

    const html = renderToStaticMarkup(<AdDecisionAuthorityTrail ad={ad} />);

    expect(html).toContain("Historical provenance unavailable");
    expect(html).not.toContain("Source evidence is not fresh enough");
  });
});
