import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  DecisionsOsView,
  nextAdCandidateLimit,
  preserveDecisionWorkspacePlaceholder,
  resolveAvailableDecisionLane,
} from "@/components/meta/os/DecisionsOsView";

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
  version: "meta-os-decisions.presentation.v2",
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
  banners: [],
  os: {
    contractVersion: "meta-os-decisions.presentation.v2",
    generatedAt: "2026-07-10T04:00:00.000Z",
    source: {
      snapshotAsOf: "2026-07-10",
      engineVersion: "v3-test",
      structureSource: "meta_recommendations",
      adsSource: "creative_decision_with_verified_ad_identity",
    },
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
        data: workspace,
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
  it("renders the Structure and Ads information architecture from the server presentation", () => {
    const html = renderToStaticMarkup(
      <DecisionsOsView businessId="biz_1" businessName="Atelier Nord" currency="EUR" />,
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
      <DecisionsOsView businessId="biz_1" businessName="Atelier Nord" currency="EUR" />,
    );

    expect(html).not.toContain("Run preflight");
    expect(html).not.toContain("Applying · verification pending");
    expect(html).not.toContain("Verified — provider confirmed");
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
    expect(
      resolveAvailableDecisionLane(presentation, "structure", "act"),
    ).toBe("act");
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
});
