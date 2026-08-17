import { describe, expect, it } from "vitest";

import {
  buildCreativeEvidenceWindowExactViewModel,
  buildMetaAdsManagerHref,
  type CreativeEvidenceWindowExactAdRow,
} from "./creative-evidence-window-exact-adapter";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { MetaOsAdDecision } from "@/lib/meta/decisions-os-contract";

function decisionFixture(
  overrides: Partial<MetaOsAdDecision> = {},
): MetaOsAdDecision {
  return {
    id: "os_ad_1",
    decisionId: "decision_abcdef01",
    sourceSnapshotId: "snapshot_1",
    episodeId: "episode_1",
    providerAccountId: "act_1",
    adId: "120210000000012345",
    adName: "Server Ad",
    campaignId: "cmp_1",
    campaignName: "Server Campaign",
    adsetId: "set_1",
    adsetName: "Prospecting — Broad",
    creativeId: "creative_1",
    creativeName: "Server Creative",
    thumbnailUrl: null,
    lifecycleRole: "main",
    campaignRoleSource: "automatic",
    campaignRoleConfidence: "high",
    campaignRoleTrustedForAction: true,
    action: {
      code: "refresh_creative",
      label: "Refresh Creative",
      intent: "brief",
      targetLevel: "ad",
      providerMutation: null,
      scopeNote: "Creates a replacement brief; does not pause this ad",
    },
    lane: "act",
    priority: { band: "high", rank: 1, version: 1 },
    assessment: "Server assessment",
    confidence: "high",
    confidenceScore: 0.91,
    riskTier: "high",
    confirmationCeremony: "highest",
    whyNow: "Server why now",
    blockers: [],
    resolution: null,
    metrics: {
      spend: 9700,
      purchases: 318,
      roas: 2.7,
      cpa: null,
      ctr: 1.07,
      frequency: 4.1,
      effectiveTargetRoas: 3.8,
      ratioToTarget: 0.71,
      currency: "USD",
      attribution: "meta_attributed",
      grain: "ad",
    },
    rawLabel: "refresh",
    publishedLabel: "refresh",
    engineVersion: "server-engine-v3",
    snapshotAsOf: "2026-08-14",
    sourceGrain: "ad",
    decisionAvailability: "available",
    ...overrides,
  } as MetaOsAdDecision;
}

function canonicalFixture(
  overrides: Record<string, unknown> = {},
): MetaCanonicalDecision {
  return {
    decisionId: "decision_abcdef01",
    sourceSnapshotId: "snapshot_1",
    providerAccountId: "act_1",
    identityGrain: "ad",
    sourceDecision: {
      reason: "CTR fell against its own baseline while spend held flat.",
      confidence: 91,
      confidenceBand: "high",
      engineVersion: "server-engine-v3",
      snapshotAsOf: "2026-08-14",
      truthSource: "server",
      badges: [],
    },
    parentChain: {
      ad: { id: "120210000000012345", name: "Server Ad" },
      adset: { id: "set_1", name: "Prospecting — Broad" },
      creative: { id: "creative_1", name: "Server Creative" },
      campaign: { id: "cmp_1", name: "Server Campaign" },
    },
    media: { state: "available", thumbnail: { state: "available", url: "https://x/y.jpg" } },
    classification: { buyerLabel: "Refresh", blockers: [] },
    metrics: {
      spend: 9700,
      purchases: 318,
      roas: 2.7,
      recent7dRoas: 2.4,
      effectiveTargetRoas: 3.8,
      currency: "USD",
    },
    ...overrides,
  } as unknown as MetaCanonicalDecision;
}

function adRow(
  overrides: Partial<CreativeEvidenceWindowExactAdRow> = {},
): CreativeEvidenceWindowExactAdRow {
  return {
    id: "row_1",
    adsetId: "set_1",
    adsetName: "Prospecting — Broad",
    spend: 6100,
    purchaseValue: 15250,
    roas: 2.5,
    impressions: 1_420_000,
    linkClicks: 15_200,
    addToCart: 942,
    purchases: 318,
    thumbstop: 22,
    launchDate: "2026-06-02",
    ...overrides,
  };
}

describe("buildCreativeEvidenceWindowExactViewModel identity and contract", () => {
  it("carries the design's header facts from the served decision", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(model.name).toBe("Server Ad");
    expect(model.decisionLabel).toBe("Refresh");
    expect(model.decisionTone).toBe("warning");
    expect(model.previewUrl).toBe("https://x/y.jpg");
    expect(model.band).toBe("High confidence");
    expect(model.bandTone).toBe("positive");
  });

  it("states the verdict, the target-relative money line and one server reason", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(model.verdict).toBe("Server verdict: Refresh.");
    expect(model.money).toBe("$9,700 · ROAS 2.70");
    expect(model.moneySub).toBe("vs 3.80 target");
    expect(model.reasons).toEqual([
      "CTR fell against its own baseline while spend held flat.",
    ]);
  });

  it("folds authority blockers into the verdict sub-line rather than a section", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture({
        classification: {
          buyerLabel: "Cut",
          blockers: [{ code: "scope", label: "Native ad authority unavailable" }],
        },
      }),
    });
    expect(model.verdictSub).toContain("Native ad authority unavailable.");
    expect(model.verdictSub).toContain("Creates a replacement brief");
  });

  it("em-dashes the whole contract when nothing is served", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({});
    expect(model.name).toBe("—");
    expect(model.money).toBe("—");
    expect(model.moneySub).toBe("—");
    expect(model.band).toBe("—");
    expect(model.verdict).toBe("—");
    expect(model.reasons).toEqual(["—"]);
  });
});

describe("buildCreativeEvidenceWindowExactViewModel evidence body", () => {
  it("builds the design's four funnel steps from ad-grain rows", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      adRows: [adRow()],
    });
    expect(model.funnel?.map((step) => step.label)).toEqual([
      "Impressions",
      "Link clicks",
      "Add to cart",
      "Purchases",
    ]);
    expect(model.funnel?.map((step) => step.value)).toEqual([
      "1,420,000",
      "15,200",
      "942",
      "318",
    ]);
    expect(model.funnel?.[1]?.sub).toBe("CTR 1.07%");
    expect(model.funnel?.[2]?.sub).toBe("ATC 6.2%");
    expect(model.funnel?.[3]?.sub).toBe("CVR 2.1%");
  });

  it("draws the funnel bars on the design's own decade scale", () => {
    // The design's three authored funnels (design file 3610, 3624, 3638).
    const designFunnels = [
      { top: 1_420_000, values: [15_200, 942, 318], widths: [0.46, 0.27, 0.15] },
      { top: 1_180_000, values: [11_800, 684, 246], widths: [0.42, 0.24, 0.13] },
      { top: 1_940_000, values: [31_600, 2_970, 1_034], widths: [0.58, 0.34, 0.2] },
    ];
    const residuals: number[] = [];
    for (const funnel of designFunnels) {
      const model = buildCreativeEvidenceWindowExactViewModel({
        adRows: [
          adRow({
            impressions: funnel.top,
            linkClicks: funnel.values[0],
            addToCart: funnel.values[1],
            purchases: funnel.values[2],
          }),
        ],
      });
      expect(model.funnel?.[0]?.share).toBe(1);
      for (const [index, width] of funnel.widths.entries()) {
        residuals.push(Math.abs((model.funnel?.[index + 1]?.share ?? 0) - width));
      }
    }
    // Seven of the nine sub-bars land within 3 points of the design's own
    // width. The two that do not are the Clicks bars of the Refresh and Retire
    // funnels, which the design draws shorter than its own scale — recorded as
    // DRAWERS-43 rather than fitted away.
    expect(residuals.filter((residual) => residual <= 0.03)).toHaveLength(7);
    expect(Math.max(...residuals)).toBeLessThan(0.11);
  });

  it("keeps the funnel's four rows and em-dashes them when no ad-grain read resolved", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(model.funnel).toHaveLength(4);
    expect(model.funnel?.[0]?.value).toBe("—");
    // Purchases is on the decisions contract even without the ad-grain read.
    expect(model.funnel?.[3]?.value).toBe("318");
  });

  it("groups Where it runs by ad set with a spend-weighted ROAS", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      adRows: [
        adRow({ id: "r1", adsetId: "set_1", spend: 100, purchaseValue: 400 }),
        adRow({ id: "r2", adsetId: "set_1", spend: 100, purchaseValue: 200 }),
        adRow({
          id: "r3",
          adsetId: "set_2",
          adsetName: "Retargeting 14d",
          spend: 50,
          purchaseValue: 200,
        }),
      ],
    });
    expect(model.adSets).toHaveLength(2);
    expect(model.adSets?.[0]).toMatchObject({
      label: "Prospecting — Broad",
      spend: "$200",
      roas: "3.00",
    });
    expect(model.adSets?.[1]).toMatchObject({ label: "Retargeting 14d", roas: "4.00" });
  });

  it("falls back to the decision's own ad set when no ad-grain read resolved", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(model.adSets).toEqual([
      {
        id: "set_1",
        label: "Prospecting — Broad",
        spend: "$9,700",
        roas: "2.70",
        roasTone: "negative",
      },
    ]);
  });

  it("keeps three placement slots and states that no source serves them", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      adRows: [adRow()],
    });
    expect(model.placements).toHaveLength(3);
    expect(model.placements?.every((row) => row.label === "—")).toBe(true);
  });

  it("serves the design's six evidence keys in order, em-dashing the unserved", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      adRows: [adRow()],
    });
    expect(model.facts?.map((fact) => fact.label)).toEqual([
      "Frequency",
      "First-time reach",
      "Thumbstop",
      "Hold 15s",
      "—",
      "First seen",
    ]);
    expect(model.facts?.map((fact) => fact.value)).toEqual([
      "4.1",
      "—",
      "22.0%",
      "—",
      "—",
      "2026-06-02",
    ]);
  });

  it("weights thumbstop by impressions across the ads sharing the creative", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      adRows: [
        adRow({ id: "r1", impressions: 300, thumbstop: 10 }),
        adRow({ id: "r2", impressions: 100, thumbstop: 30 }),
      ],
    });
    expect(model.facts?.find((fact) => fact.id === "thumbstop")?.value).toBe("15.0%");
  });

  it("leaves both sparkline series unserved rather than interpolating point values", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      adRows: [adRow()],
    });
    expect(model.ctr).toEqual({ path: null, note: "—" });
    expect(model.frequency).toEqual({ path: null, note: "—" });
  });

  it("draws both sparklines from the served per-ad daily series", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      adSeries: {
        adCount: 1,
        points: [
          { date: "2026-08-01", linkCtr: 2, frequency: 1 },
          { date: "2026-08-02", linkCtr: 2, frequency: 1 },
          { date: "2026-08-03", linkCtr: 1, frequency: 3 },
          { date: "2026-08-04", linkCtr: 1, frequency: 3 },
        ],
      },
    });
    // Four points across the design's 0 0 100 22 viewBox, 2px inset each side.
    expect(model.ctr?.path).toBe("M0.0 2.0 L33.3 2.0 L66.7 20.0 L100.0 20.0");
    expect(model.ctr?.note).toBe("link CTR −50.0% vs prior 2d");
    expect(model.frequency?.path).toBe("M0.0 20.0 L33.3 20.0 L66.7 2.0 L100.0 2.0");
    expect(model.frequency?.note).toBe("3.0 · +200.0% vs prior 2d");
  });

  it("flattens a constant series to the middle of the sparkline band", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      adSeries: {
        adCount: 1,
        points: [
          { date: "2026-08-01", linkCtr: 1.5, frequency: null },
          { date: "2026-08-02", linkCtr: 1.5, frequency: null },
        ],
      },
    });
    expect(model.ctr?.path).toBe("M0.0 11.0 L100.0 11.0");
    expect(model.ctr?.note).toBe("link CTR · 2 days served");
    expect(model.frequency).toEqual({ path: null, note: "—" });
  });

  it("names the ad count when the series rolls up more than one ad", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      adSeries: {
        adCount: 3,
        points: [
          { date: "2026-08-01", linkCtr: 1, frequency: null },
          { date: "2026-08-02", linkCtr: 2, frequency: null },
        ],
      },
    });
    expect(model.ctr?.note).toBe("link CTR · 2 days served · 3 ads");
  });

  it("prints snapshot, decision and engine provenance", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(model.provenance).toBe(
      "provenance: snapshot 2026-08-14 · decision deci…01 · engine server-engine-v3",
    );
  });
});

describe("buildCreativeEvidenceWindowExactViewModel footer", () => {
  it("captions the primary with the server decision's own action", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      hrefs: { primary: "/platforms/meta/launchpad?mode=rebuild" },
    });
    expect(model.primaryAction?.label).toBe("Refresh Creative");
    expect(model.primaryAction?.href).toBe("/platforms/meta/launchpad?mode=rebuild");
  });

  it("always emits Compare in Studio and Ads Manager", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({});
    expect(model.compareAction?.label).toBe("Compare in Studio");
    expect(model.adsManagerAction?.label).toBe("Ads Manager ↗");
    expect(model.adsManagerAction?.external).toBe(true);
  });
});

describe("buildMetaAdsManagerHref", () => {
  it("builds the provider deep link from the account and ad", () => {
    expect(buildMetaAdsManagerHref({ providerAccountId: "act_1", adId: "ad_9" })).toBe(
      "https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=1&selected_ad_ids=ad_9",
    );
  });

  it("returns null when either identity is missing", () => {
    expect(buildMetaAdsManagerHref({ providerAccountId: null, adId: "ad_9" })).toBeNull();
    expect(buildMetaAdsManagerHref({ providerAccountId: "act_1", adId: null })).toBeNull();
  });
});
