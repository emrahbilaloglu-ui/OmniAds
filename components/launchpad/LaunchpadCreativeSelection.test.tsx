import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import {
  LaunchpadCreativeSelection,
  buildLaunchpadSelectionSummary,
  filterLaunchpadCreativeRows,
  getCreativeAdvisoryNotes,
} from "@/components/launchpad/LaunchpadCreativeSelection";

function makeRow(overrides: Partial<MetaCreativeRow> = {}): MetaCreativeRow {
  return {
    id: "row_1",
    creativeId: "creative_1",
    name: "Creative One",
    associatedAdsCount: 1,
    accountId: "act_1",
    accountName: "Main",
    campaignId: "cmp_1",
    campaignName: "Campaign 1",
    adSetId: "adset_1",
    adSetName: "Ad set 1",
    effectiveStatus: "ACTIVE",
    currency: "USD",
    format: "image",
    creativeType: "feed",
    creativeTypeLabel: "Feed",
    creativeDeliveryType: "standard",
    creativeVisualFormat: "image",
    creativePrimaryType: "standard",
    creativePrimaryLabel: "Standard",
    creativeSecondaryType: null,
    creativeSecondaryLabel: null,
    thumbnailUrl: null,
    previewUrl: null,
    imageUrl: null,
    isCatalog: false,
    previewState: "unavailable",
    preview: {
      render_mode: "unavailable",
      image_url: null,
      video_url: null,
      poster_url: null,
      source: null,
      is_catalog: false,
    },
    launchDate: "2026-05-01",
    tags: [],
    aiTags: {},
    spend: 100,
    purchaseValue: 240,
    roas: 2.4,
    cpa: 12,
    cpcLink: 1,
    cpm: 10,
    ctrAll: 1,
    linkCtr: 1,
    purchases: 8,
    impressions: 1000,
    clicks: 50,
    linkClicks: 40,
    landingPageViews: 0,
    addToCart: 0,
    initiateCheckout: 0,
    leads: 0,
    messages: 0,
    thumbstop: 0,
    clickToAddToCart: 0,
    clickToPurchase: 0,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    atcToPurchaseRatio: 0,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<DecisionOutput> = {}): DecisionOutput {
  return {
    creativeId: "creative_1",
    creativeName: "Creative One",
    label: "scale",
    preAuthorityLabel:
      overrides.preAuthorityLabel ?? overrides.label ?? "scale",
    authorityBlocker: overrides.authorityBlocker ?? null,
    reason: "Strong winner.",
    confidence: 80,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 1.4,
    badges: [],
    metrics: {
      spend: 100,
      purchases: 8,
      roas: 2.4,
      recent7dRoas: 2.2,
    },
    engineVersion: "v3-test",
    generatedAt: "2026-05-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("LaunchpadCreativeSelection", () => {
  it("renders engine v3 label and below breakeven badges", () => {
    const decision = makeDecision({
      badges: [
        {
          type: "below_breakeven",
          label: "Below breakeven",
          severity: "warning",
        },
      ],
    });

    const html = renderToStaticMarkup(
      <LaunchpadCreativeSelection
        rows={[makeRow()]}
        selectedCreativeIds={["creative_1"]}
        decisionByCreativeId={new Map([["creative_1", decision]])}
        onToggleCreative={vi.fn()}
      />,
    );

    expect(html).toContain("Scale");
    expect(html).toContain("Below breakeven");
    expect(html).toContain("Engine: scale candidate");
    expect(html).toContain("Upload new creative");
    expect(html).toContain("NEEDS-SERVER-CONTRACT");
    expect(html).toContain("out_of_scope");
    expect(html).toContain("deliberately distinct from buyerAction");
  });

  it("renders creative spend and selection totals in the account currency", () => {
    const html = renderToStaticMarkup(
      <LaunchpadCreativeSelection
        rows={[makeRow({ spend: 100 })]}
        selectedCreativeIds={["creative_1"]}
        decisionByCreativeId={new Map()}
        currency="TRY"
        onToggleCreative={vi.fn()}
      />,
    );

    expect(html).toContain("TRY");
    expect(html).not.toContain("$100.00");
  });

  it("keeps paused recently duplicated ads visible in manage mode filters", () => {
    const recentRow = makeRow({
      id: "recent:ad_2",
      realAdId: "ad_2",
      creativeId: "creative_2",
      name: "Hero added",
      campaignId: "cmp_target",
      campaignName: "Main Campaign",
      effectiveStatus: "PAUSED",
      launchpadRecentAction: {
        action: "launch_ad",
        requestedAt: "2026-05-06T12:00:00.000Z",
        resultingAdId: "ad_2",
        sourceAdId: "ad_1",
        sourceName: "Hero",
        targetCampaignId: "cmp_target",
        targetCampaignName: "Main Campaign",
        targetAdsetId: "adset_target",
        targetAdsetName: "Main Ad Set",
      },
    });

    expect(
      filterLaunchpadCreativeRows({
        rows: [recentRow],
        decisionByCreativeId: new Map(),
        statusFilter: "active",
        campaignFilter: "cmp_target",
      }),
    ).toEqual([]);
    expect(
      filterLaunchpadCreativeRows({
        rows: [recentRow],
        decisionByCreativeId: new Map(),
        statusFilter: "all",
        campaignFilter: "cmp_target",
      }).map((row) => row.id),
    ).toEqual(["recent:ad_2"]);
    expect(
      filterLaunchpadCreativeRows({
        rows: [recentRow, makeRow({ id: "row_3", creativeId: "creative_3" })],
        decisionByCreativeId: new Map(),
        statusFilter: "recently_duplicated",
      }).map((row) => row.id),
    ).toEqual(["recent:ad_2"]);

    const html = renderToStaticMarkup(
      <LaunchpadCreativeSelection
        rows={[recentRow]}
        selectedCreativeIds={["ad_2"]}
        decisionByCreativeId={new Map()}
        initialStatusFilter="all"
        getSelectionId={(row) => row.realAdId ?? row.id}
        onToggleCreative={vi.fn()}
      />,
    );

    expect(html).toContain("Recently duplicated");
    expect(html).toContain("1</span> selected");
  });

  it("maps cut and diagnose decisions to advisory notes", () => {
    expect(
      getCreativeAdvisoryNotes(makeDecision({ label: "cut" })).map(
        (note) => note.text,
      ),
    ).toContain("Engine: cut candidate - confirm intent");
    expect(
      getCreativeAdvisoryNotes(makeDecision({ label: "diagnose" })).map(
        (note) => note.text,
      ),
    ).toContain("Engine: data anomaly - verify before launch");
  });

  it("filters by status, format, label, badge, and search", () => {
    const rows = [
      makeRow({
        creativeId: "creative_1",
        name: "Hero Scale",
        format: "image",
      }),
      makeRow({
        id: "row_2",
        creativeId: "creative_2",
        name: "Video Cut",
        format: "video",
        creativeVisualFormat: "video",
      }),
      makeRow({
        id: "row_3",
        creativeId: "creative_3",
        name: "Closed Refresh",
        effectiveStatus: "PAUSED",
        // Relative to "now" so the closed_30d assertion below stays deterministic
        // instead of breaking once a hardcoded date ages past the 30-day window.
        launchDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
      }),
    ];
    const decisions = new Map<string, DecisionOutput>([
      [
        "creative_1",
        makeDecision({ creativeId: "creative_1", label: "scale" }),
      ],
      [
        "creative_2",
        makeDecision({
          creativeId: "creative_2",
          label: "cut",
          badges: [
            {
              type: "below_breakeven",
              label: "Below breakeven",
              severity: "warning",
            },
          ],
        }),
      ],
      [
        "creative_3",
        makeDecision({ creativeId: "creative_3", label: "refresh" }),
      ],
    ]);

    expect(
      filterLaunchpadCreativeRows({
        rows,
        decisionByCreativeId: decisions,
        formatFilter: "video",
      }).map((row) => row.creativeId),
    ).toEqual(["creative_2"]);
    expect(
      filterLaunchpadCreativeRows({
        rows,
        decisionByCreativeId: decisions,
        labels: ["cut"],
        badges: ["below_breakeven"],
        search: "video",
      }).map((row) => row.creativeId),
    ).toEqual(["creative_2"]);
    expect(
      filterLaunchpadCreativeRows({
        rows,
        decisionByCreativeId: decisions,
        statusFilter: "closed_30d",
      }).map((row) => row.creativeId),
    ).toEqual(["creative_3"]);
    expect(
      filterLaunchpadCreativeRows({
        rows,
        decisionByCreativeId: decisions,
        campaignFilter: "cmp_1",
      }).map((row) => row.creativeId),
    ).toEqual(["creative_1", "creative_2"]);
  });

  it("sorts and builds the persistent selection summary", () => {
    const rows = [
      makeRow({
        creativeId: "creative_1",
        name: "B",
        spend: 50,
        roas: 3,
        purchases: 2,
      }),
      makeRow({
        id: "row_2",
        creativeId: "creative_2",
        name: "A",
        spend: 150,
        roas: 1,
        purchases: 1,
      }),
    ];
    const decisions = new Map<string, DecisionOutput>([
      [
        "creative_1",
        makeDecision({
          creativeId: "creative_1",
          label: "scale",
          metrics: { spend: 50, purchases: 2, roas: 3, recent7dRoas: 3 },
        }),
      ],
      [
        "creative_2",
        makeDecision({
          creativeId: "creative_2",
          label: "cut",
          metrics: { spend: 150, purchases: 1, roas: 1, recent7dRoas: 1 },
        }),
      ],
    ]);

    expect(
      filterLaunchpadCreativeRows({
        rows,
        decisionByCreativeId: decisions,
        sort: "name_asc",
      }).map((row) => row.name),
    ).toEqual(["A", "B"]);
    expect(
      buildLaunchpadSelectionSummary({
        selectedCreatives: rows,
        decisionByCreativeId: decisions,
      }),
    ).toMatchObject({
      count: 2,
      totalSpend: 200,
      averageRoas: 1.5,
      missingMetricCount: 0,
      scale: 1,
      cut: 1,
    });
  });

  it("withholds synthetic provider-result metrics instead of treating placeholders as zero", () => {
    const pendingMetrics = makeRow({
      id: "recent:ad_new",
      creativeId: "creative_new",
      metricsAvailability: "unavailable",
      spend: 0,
      roas: 0,
      purchases: 0,
    });
    const summary = buildLaunchpadSelectionSummary({
      selectedCreatives: [pendingMetrics],
      decisionByCreativeId: new Map(),
    });
    expect(summary).toMatchObject({
      count: 1,
      totalSpend: null,
      averageRoas: null,
      missingMetricCount: 1,
    });

    const html = renderToStaticMarkup(
      <LaunchpadCreativeSelection
        rows={[pendingMetrics]}
        selectedCreativeIds={[]}
        decisionByCreativeId={new Map()}
        initialStatusFilter="all"
        onToggleCreative={() => undefined}
      />,
    );
    expect(html).toContain("Metrics unavailable");
    expect(html).not.toContain("$0.00");
  });
});
