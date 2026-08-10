import React from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import { normalizeMetaLaunchPayload } from "@/lib/launchpad/meta";
import {
  LaunchpadReview,
  buildLaunchpadValidationRequest,
  buildLaunchpadBudgetReview,
  buildEngineAggregate,
} from "@/components/launchpad/LaunchpadReview";

function makeCreative(id: string, spend: number, roas: number): MetaCreativeRow {
  return {
    id,
    creativeId: id,
    name: id,
    associatedAdsCount: 1,
    accountId: "act_1",
    accountName: "Main",
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
    spend,
    purchaseValue: spend * roas,
    roas,
    cpa: 0,
    cpcLink: 0,
    cpm: 0,
    ctrAll: 0,
    linkCtr: 0,
    purchases: 0,
    impressions: 0,
    clicks: 0,
    linkClicks: 0,
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
  };
}

function makeDecision(overrides: Partial<DecisionOutput>): DecisionOutput {
  return {
    creativeId: "creative_1",
    creativeName: null,
    label: "scale",
    preAuthorityLabel:
      overrides.preAuthorityLabel ?? overrides.label ?? "scale",
    authorityBlocker: overrides.authorityBlocker ?? null,
    reason: "reason",
    confidence: 80,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 1,
    badges: [],
    metrics: {
      spend: 100,
      purchases: 1,
      roas: 3,
      recent7dRoas: 2,
    },
    engineVersion: "v3-test",
    generatedAt: "2026-05-06T00:00:00.000Z",
    ...overrides,
  };
}

const payload = normalizeMetaLaunchPayload({
  campaign: { name: "Launch", objective: "OUTCOME_SALES", specialAdCategories: [] },
  currencyCode: "USD",
  budget: {
    mode: "CBO",
    schedule: "daily",
    amountMinor: 5000,
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
  },
  creatives: [{ creativeId: "creative_1" }],
  adSets: [
    {
      clientId: "adset-1",
      name: "Ad set 1",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      pixelId: "pixel_1",
      customEventType: "PURCHASE",
      targeting: {
        countries: ["US"],
        ageMin: 18,
        ageMax: 65,
        advantageAudience: true,
        advantagePlacements: true,
      },
      attributionSpec: [{ eventType: "CLICK_THROUGH", windowDays: 7 }],
    },
  ],
});

describe("LaunchpadReview", () => {
  it("invalidates manual confirmation whenever the reviewed payload changes", () => {
    const source = readFileSync(
      "components/launchpad/LaunchpadReview.tsx",
      "utf8",
    );
    expect(source).toContain("setAck(false);");
    expect(source).toContain(
      "[businessId, mode, payload, providerAccountId]",
    );
  });

  it("binds validation to the exact provider account under review", () => {
    expect(
      buildLaunchpadValidationRequest({
        businessId: "biz",
        providerAccountId: "act_123",
        payload,
      }),
    ).toEqual({
      businessId: "biz",
      providerAccountId: "act_123",
      payload,
    });
  });

  it("normalizes launch payload currency codes without accepting non-ISO names", () => {
    expect(
      normalizeMetaLaunchPayload({
        ...payload,
        currencyCode: "try",
      }).currencyCode,
    ).toBe("TRY");
    expect(
      normalizeMetaLaunchPayload({
        ...payload,
        currencyCode: "Turkish lira",
      }).currencyCode,
    ).toBeNull();
  });

  it("builds aggregate engine warning counts and weighted ROAS", () => {
    const aggregate = buildEngineAggregate({
      selectedCreatives: [
        makeCreative("creative_1", 100, 3),
        makeCreative("creative_2", 300, 1),
      ],
      decisionByCreativeId: new Map([
        ["creative_1", makeDecision({ creativeId: "creative_1", label: "scale" })],
        [
          "creative_2",
          makeDecision({
            creativeId: "creative_2",
            label: "cut",
            badges: [{ type: "below_breakeven", label: "Below breakeven", severity: "warning" }],
            metrics: { spend: 300, purchases: 1, roas: 1, recent7dRoas: 1 },
          }),
        ],
      ]),
    });

    expect(aggregate).toMatchObject({
      total: 2,
      scale: 1,
      cut: 1,
      belowBreakeven: 1,
      severe: true,
    });
    expect(aggregate.averageRoas).toBe(1.5);
  });

  it("builds review budget math in the real account currency", () => {
    expect(buildLaunchpadBudgetReview(payload, "USD")).toMatchObject({
      amount: "$50.00/day",
      detail: "CBO · LOWEST_COST_WITHOUT_CAP",
      complete: true,
    });
    expect(buildLaunchpadBudgetReview(payload, null)).toMatchObject({
      amount: "50 (Currency unavailable)/day",
      complete: false,
    });
  });

  it("renders aggregate banner and disables launch until validation passes", () => {
    const html = renderToStaticMarkup(
      <LaunchpadReview
        businessId="biz"
        providerAccountId="act_1"
        payload={payload}
        currencyCode="USD"
        selectedCreatives={[makeCreative("creative_1", 100, 3)]}
        decisionByCreativeId={new Map([["creative_1", makeDecision({})]])}
        onSaveTemplate={vi.fn()}
        onSaveDraft={vi.fn()}
        onLaunch={vi.fn()}
      />,
    );

    expect(html).toContain("1 of 1 selected creatives are engine-flagged");
    expect(html).toContain("$50.00/day");
    expect(html).toContain("Validation unavailable until the server returns a result");
    expect(html).toContain("raw launch JSON");
    expect(html).not.toContain("&quot;campaign&quot;:");
    expect(html).toContain("Create PAUSED");
    expect(html).toContain("Publish ACTIVE");
    expect(html).toContain("Proposed/contract required");
    expect(html).toContain("disabled");
  });

  it("blocks review when the account currency is unavailable", () => {
    const html = renderToStaticMarkup(
      <LaunchpadReview
        businessId="biz"
        providerAccountId="act_1"
        payload={payload}
        currencyCode={null}
        selectedCreatives={[makeCreative("creative_1", 100, 3)]}
        decisionByCreativeId={new Map()}
        onLaunch={vi.fn()}
      />,
    );

    expect(html).toContain("currency_unavailable");
    expect(html).toContain("50 (Currency unavailable)/day");
    expect(html).toContain("Create PAUSED");
    expect(html).toContain("disabled");
  });

  it("renders Mode B review copy and hides template saving", () => {
    const modeBPayload = {
      mode: "add_to_existing" as const,
      targetCampaignId: "cmp_1",
      targetAdsetId: "adset_1",
      targetCampaignName: "Campaign",
      targetAdsetName: "Ad set",
      copyMode: "rebuild_creative" as const,
      targets: [
        {
          targetCampaignId: "cmp_1",
          targetAdsetId: "adset_1",
          targetCampaignName: "Campaign",
          targetAdsetName: "Ad set",
        },
      ],
      creativeIds: ["creative_1"],
      creatives: [{ creativeId: "creative_1", name: "Creative 1", nameOverride: "Creative 1 added" }],
      names: { creative_1: "Creative 1 added" },
    };
    const html = renderToStaticMarkup(
      <LaunchpadReview
        mode="add_to_existing"
        businessId="biz"
        providerAccountId="act_1"
        payload={modeBPayload}
        currencyCode="USD"
        selectedCreatives={[makeCreative("creative_1", 100, 3)]}
        decisionByCreativeId={new Map([["creative_1", makeDecision({})]])}
        targetSummary={{
          campaignName: "Campaign",
          adsetName: "Ad set",
          currentAdCount: 4,
          budgetLines: [
            {
              label: "Campaign / Ad set",
              amountMinor: 2500,
              schedule: "daily",
              source: "ad set",
            },
          ],
        }}
        onSaveDraft={vi.fn()}
        onLaunch={vi.fn()}
      />,
    );

    expect(html).toContain("1 creatives -&gt; existing ad set Ad set under campaign Campaign");
    expect(html).toContain("Creative copy: recreate exact ad");
    expect(html).toContain("after launch: 5");
    expect(html).toContain("$25.00/day");
    expect(html).not.toContain("Save as template");
    expect(html).toContain("Save draft");
  });
});
