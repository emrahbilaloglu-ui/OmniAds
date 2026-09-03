import { describe, expect, it, vi } from "vitest";

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

  /*
   * LAW: the reasoning card prints every reasoning line the payload served, and
   * prints each of them once.
   *
   * This used to assert exactly ONE line, which pinned a real defect: the
   * engine serves `whyNow` (why this ad is on the screen today) and
   * `assessment` (its standing read of the ad) as two different sentences, and
   * only the first reached the window. On a row with no canonical envelope the
   * cost is total — `reason` falls back to `whyNow`, so the assessment the
   * engine computed appeared nowhere at all. What must not come back is
   * duplication: an account whose two fields agree still reads one line.
   */
  it("states the verdict, the money line and every served reasoning line once", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(model.verdict).toBe("Server verdict: Refresh.");
    expect(model.money).toBe("$9,700 · ROAS 2.70");
    expect(model.moneySub).toBe("vs 3.80 target");
    expect(model.reasons).toEqual([
      "CTR fell against its own baseline while spend held flat.",
      "Server assessment",
    ]);

    const agreeing = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({ assessment: "Same sentence" }),
      canonical: canonicalFixture({
        sourceDecision: {
          reason: "Same sentence",
          confidence: 91,
          confidenceBand: "high",
          engineVersion: "server-engine-v3",
          snapshotAsOf: "2026-08-14",
          truthSource: "server",
          badges: [],
        },
      }),
    });
    expect(agreeing.reasons).toEqual(["Same sentence"]);
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

  it("fills the decision-specific slot with the engine's served fatigue class", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({ fatigueStatus: "fatigued" }),
      canonical: canonicalFixture(),
    });
    expect(model.facts?.[4]).toMatchObject({ label: "Fatigue", value: "Fatigued" });
  });

  it("reads the fatigue class off the canonical decision when the OS one omits it", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture({ fatigueStatus: "watch" }),
    });
    expect(model.facts?.[4]).toMatchObject({ label: "Fatigue", value: "Watch" });
  });

  it("keeps a served 'unknown' fatigue class distinct from no fatigue field at all", () => {
    const assessed = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({ fatigueStatus: "unknown" }),
      canonical: canonicalFixture(),
    });
    const absent = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(assessed.facts?.[4]).toMatchObject({ label: "Fatigue", value: "Unknown" });
    expect(absent.facts?.[4]).toMatchObject({ label: "—", value: "—" });
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
          { date: "2026-08-01", linkCtr: 0, ctr: 2, frequency: 1 },
          { date: "2026-08-02", linkCtr: 0, ctr: 2, frequency: 1 },
          { date: "2026-08-03", linkCtr: 0, ctr: 1, frequency: 3 },
          { date: "2026-08-04", linkCtr: 0, ctr: 1, frequency: 3 },
        ],
      },
    });
    // Four points across the design's 0 0 100 22 viewBox, 2px inset each side.
    expect(model.ctr?.path).toBe("M0.0 2.0 L33.3 2.0 L66.7 20.0 L100.0 20.0");
    expect(model.ctr?.note).toBe("−50.0% vs prior 2d");
    expect(model.frequency?.path).toBe("M0.0 20.0 L33.3 20.0 L66.7 2.0 L100.0 2.0");
    expect(model.frequency?.note).toBe("3.0 · +200.0% vs prior 2d");
  });

  it("draws the CTR card from all-clicks CTR, not the flat-zero link CTR", () => {
    // Every stored warehouse row has link_clicks 0, so `linkCtr` is 0 on every
    // day of a real payload; a card captioned plainly "CTR · 28d" that read it
    // drew one flat line for every creative in the account.
    const model = buildCreativeEvidenceWindowExactViewModel({
      adSeries: {
        adCount: 1,
        points: [
          { date: "2026-08-01", linkCtr: 0, ctr: 1, frequency: null },
          { date: "2026-08-02", linkCtr: 0, ctr: 1, frequency: null },
          { date: "2026-08-03", linkCtr: 0, ctr: 2, frequency: null },
          { date: "2026-08-04", linkCtr: 0, ctr: 2, frequency: null },
        ],
      },
    });
    expect(model.ctr?.path).toBe("M0.0 20.0 L33.3 20.0 L66.7 2.0 L100.0 2.0");
    expect(model.ctr?.note).toBe("+100.0% vs prior 2d");
  });

  it("leaves the CTR card unserved when the trail carries no all-clicks CTR", () => {
    // Link CTR must not stand in: it is a different measure from the one the
    // card is captioned with, so an unreadable CTR stays unreadable.
    const model = buildCreativeEvidenceWindowExactViewModel({
      adSeries: {
        adCount: 1,
        points: [
          { date: "2026-08-01", linkCtr: 1, ctr: null, frequency: null },
          { date: "2026-08-02", linkCtr: 2, ctr: null, frequency: null },
        ],
      },
    });
    expect(model.ctr).toEqual({ path: null, note: "—" });
  });

  it("flattens a constant series to the middle of the sparkline band", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      adSeries: {
        adCount: 1,
        points: [
          { date: "2026-08-01", linkCtr: 0, ctr: 1.5, frequency: null },
          { date: "2026-08-02", linkCtr: 0, ctr: 1.5, frequency: null },
        ],
      },
    });
    expect(model.ctr?.path).toBe("M0.0 11.0 L100.0 11.0");
    expect(model.ctr?.note).toBe("2 days served");
    expect(model.frequency).toEqual({ path: null, note: "—" });
  });

  it("names the ad count when the series rolls up more than one ad", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      adSeries: {
        adCount: 3,
        points: [
          { date: "2026-08-01", linkCtr: 0, ctr: 1, frequency: null },
          { date: "2026-08-02", linkCtr: 0, ctr: 2, frequency: null },
        ],
      },
    });
    expect(model.ctr?.note).toBe("2 days served · 3 ads");
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

/**
 * THE LAW: three different facts must not print the same character.
 *
 * `adRows`/`adSeries` arrive as `undefined` while the helper read is in flight,
 * when it failed, and when the account genuinely has no ad-grain rows. Before
 * `adRowsState` existed, all three rendered the same em-dash, so an operator
 * could not tell a broken read from an empty one and would read an unread
 * funnel as a measured absence. Loading prints "…", a failed read prints
 * "unreadable", and only a resolved-but-empty read keeps the em-dash.
 */
describe("buildCreativeEvidenceWindowExactViewModel helper read state", () => {
  it("keeps the em-dash when the read resolved and the account has no rows", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      adRows: [],
      adSeries: { adCount: 0, points: [] },
      adRowsState: "loaded",
      adSeriesState: "loaded",
    });
    expect(model.readNotice).toBeNull();
    expect(model.funnel?.[0]?.value).toBe("—");
    expect(model.ctr?.note).toBe("—");
  });

  it("marks an in-flight read as pending rather than as absent", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      adRowsState: "loading",
      adSeriesState: "loading",
    });
    expect(model.funnel?.[0]?.value).toBe("…");
    expect(model.ctr?.note).toBe("…");
    expect(model.facts?.find((fact) => fact.id === "first-seen")?.value).toBe("…");
    expect(model.readNotice?.tone).toBe("info");
    expect(model.readNotice?.text).toContain("still loading");
  });

  it("marks a failed read as unreadable and quotes the read's own message", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      adRowsState: "error",
      adRowsErrorMessage: "meta creatives read failed: 502",
      adSeriesState: "loaded",
      adSeries: { adCount: 0, points: [] },
    });
    expect(model.funnel?.[0]?.value).toBe("unreadable");
    expect(model.facts?.find((fact) => fact.id === "thumbstop")?.value).toBe(
      "unreadable",
    );
    expect(model.readNotice?.tone).toBe("negative");
    expect(model.readNotice?.text).toContain("meta creatives read failed: 502");
  });

  it("never overwrites a served value with a read-state token", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      adRowsState: "error",
    });
    // Purchases falls back to the decision's own served metric, which is a
    // measured number and stays one even while the helper read is broken.
    expect(model.funnel?.[3]?.value).toBe("318");
  });
});

/**
 * THE LAW: the audit surface the payload serves reaches the drawer.
 *
 * Source authority, action eligibility, identity resolution, delivery scope,
 * risk/ceremony, operator responses and the provider-write outcome are EVIDENCE
 * and belong beside the numbers they qualify. Hashes and lineage ids are
 * RECEIPTS and belong in the closed diagnostics disclosure. Neither family is
 * allowed onto the summary card.
 */
describe("buildCreativeEvidenceWindowExactViewModel audit surface", () => {
  const canonical = canonicalFixture({
    episodeId: "episode_1",
    episodeStartedAt: "2026-07-30T00:00:00.000Z",
    sourceAuthority: {
      status: "legacy_review_only",
      actionEligible: false,
      reviewOnlyReason: "native_schema_or_generation_read_failed",
      snapshotId: "snapshot_1",
      evaluationId: "eval_9",
      inputHash: "in_hash_9",
      decisionHash: "dec_hash_9",
      providerAccountRefId: "ref_9",
      engineVersion: "server-engine-v3",
      realAdId: "120210000000012345",
      authorizedAction: null,
      jobRunId: "job_9",
    },
    identityResolution: {
      basis: "creative_ambiguous",
      candidateAdCount: 3,
      metricsEquivalent: false,
      adActionEligible: false,
    },
    deliveryScope: {
      state: "inactive",
      campaignStatus: "ACTIVE",
      adsetStatus: "PAUSED",
      adStatus: "ACTIVE",
      reason: "hierarchy_not_active",
    },
    riskTier: null,
    confirmationCeremony: "elevated",
    riskTierProvenance: {
      status: "proposed",
      reason: "risk_tier_producer_not_persisted",
    },
    promotionBasis: {
      status: "proposed",
      value: null,
      reason: "promotion_basis_not_persisted",
    },
    classification: {
      buyerLabel: "Refresh",
      blockers: [],
      decisionState: "blocked",
      heldAction: "refresh",
      provenance: { source: "overlay", field: "decision_state" },
    },
    history: {
      responses: { status: "unavailable", reason: "legacy_response_journal" },
      providerWrites: { status: "unavailable", reason: "journal_not_keyed" },
    },
  });

  function value(
    rows: readonly { id: string; value?: unknown }[] | undefined,
    id: string,
  ) {
    return rows?.find((row) => row.id === id)?.value;
  }

  it("states source authority, eligibility and the review-only reason", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical,
    });
    expect(value(model.authority, "source-authority")).toBe("Legacy review only");
    expect(value(model.authority, "action-eligibility")).toBe("no");
    expect(
      model.authority?.find((row) => row.id === "action-eligibility")?.label,
    ).toBe("Decision-authorized");
    expect(value(model.authority, "review-only-reason")).toBe(
      "Native schema or generation read failed",
    );
  });

  it("separates exact decision age from decision authorization and execution readiness", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture({
        sourceDecision: {
          reason: "Exact persisted decision.",
          confidence: 91,
          confidenceBand: "high",
          engineVersion: "server-engine-v3",
          snapshotAsOf: "2026-08-14",
          computedAt: "2026-08-14T05:00:00.000Z",
          truthSource: "server",
          badges: [],
        },
        sourceAuthority: {
          status: "native_exact",
          actionEligible: true,
          reviewOnlyReason: null,
          snapshotId: "snapshot_1",
          evaluationId: "eval_1",
          inputHash: "a".repeat(64),
          decisionHash: "b".repeat(64),
          providerAccountRefId: "ref_1",
          engineVersion: "server-engine-v3",
          realAdId: "120210000000012345",
          authorizedAction: "cut",
          jobRunId: "job_1",
          executionReadiness: "stale_decision",
          decisionFreshness: {
            status: "stale",
            computedAt: "2026-08-14T05:00:00.000Z",
            ageHours: 13.25,
            maxAgeHours: 12,
          },
        },
      }),
    });

    expect(value(model.authority, "action-eligibility")).toBe("yes");
    expect(value(model.authority, "exact-decision-computed-at")).toBe(
      "2026-08-14T05:00:00.000Z",
    );
    expect(value(model.authority, "exact-decision-freshness")).toBe(
      "Stale · 13.25h old · max 12h",
    );
    expect(value(model.authority, "execution-readiness")).toBe(
      "Stale decision",
    );
  });

  it("states identity resolution, delivery scope, risk and ceremony", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical,
    });
    expect(value(model.authority, "identity-basis")).toBe("Creative ambiguous");
    expect(value(model.authority, "identity-candidates")).toContain("3");
    expect(value(model.authority, "delivery-scope")).toContain("PAUSED");
    expect(value(model.authority, "risk-tier")).toContain(
      "Risk tier producer not persisted",
    );
    expect(value(model.authority, "confirmation-ceremony")).toBe("Elevated");
  });

  it("reports a held, blocked decision as held rather than as an ordinary call", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical,
    });
    expect(value(model.authority, "decision-state")).toBe("Blocked");
    expect(value(model.authority, "held-action")).toBe("refresh");
  });

  /**
   * D074/D076: the resolver's own role explanation is printed verbatim on its
   * own rows. The window never computes a kind — a served null kind renders as
   * unresolved with the server's own reason, even while the display role above
   * carries a provisional value.
   */
  it("prints the served role explanation verbatim for a resolved campaign", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({
        campaignRoleExplanation: {
          kind: "main",
          confidenceClass: "high",
          confidenceScore: 0.87,
          evidence: ["budget concentration 0.81", "purchase volume stable"],
          conflictReasons: [],
          unresolvedReason: null,
          lastEvaluatedAt: "2026-08-13T04:00:00.000Z",
          resolverVersion: "campaign-context-v2-account-scoped",
        },
      }),
      canonical,
    });
    expect(value(model.authority, "served-role-inference")).toBe(
      "main · confidence high · score 0.87",
    );
    expect(value(model.authority, "served-role-evidence")).toBe(
      "budget concentration 0.81 · purchase volume stable",
    );
    expect(value(model.authority, "served-role-conflicts")).toBe("—");
    expect(value(model.authority, "served-role-status")).toBe("—");
    expect(value(model.authority, "served-role-evaluated")).toBe(
      "2026-08-13T04:00:00.000Z · resolver campaign-context-v2-account-scoped",
    );
  });

  it("keeps a served null kind unresolved rather than computing a fallback", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      // The display role is provisionally "main"; the explanation's null kind
      // must stay visible as unresolved beside it, not be overwritten by it.
      decision: decisionFixture({
        lifecycleRole: "main",
        campaignRoleExplanation: {
          kind: null,
          confidenceClass: "conflict",
          confidenceScore: null,
          evidence: [],
          conflictReasons: ["name says test, budget says main"],
          unresolvedReason: "conflicting_signals",
          lastEvaluatedAt: "2026-08-13T04:00:00.000Z",
          resolverVersion: "campaign-context-v2-account-scoped",
        },
      }),
      canonical,
    });
    expect(value(model.authority, "served-role-inference")).toBe(
      "unresolved · confidence conflict",
    );
    expect(value(model.authority, "served-role-evidence")).toBe("—");
    expect(value(model.authority, "served-role-conflicts")).toBe(
      "name says test, budget says main",
    );
    expect(value(model.authority, "served-role-status")).toBe(
      "Conflicting signals",
    );
  });

  it("emits no role-explanation rows for a payload serialized before the field existed", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical,
    });
    for (const id of [
      "served-role-inference",
      "served-role-evidence",
      "served-role-conflicts",
      "served-role-status",
      "served-role-evaluated",
    ]) {
      expect(model.authority?.some((row) => row.id === id)).toBe(false);
    }
  });

  it("states operator responses and the provider-write outcome from the payload", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical,
    });
    expect(value(model.authority, "operator-responses")).toContain("unavailable");
    expect(value(model.authority, "provider-write-outcome")).toContain(
      "Journal not keyed",
    );
  });

  it("falls back to the served capability states when the row carries no history", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      capabilities: {
        providerAccountScope: { status: "available", reason: null },
        stableDecisionIdentity: { status: "available", reason: null },
        stableEpisodeIdentity: { status: "available", reason: null },
        classificationOverlay: { status: "available", reason: null },
        riskTierProducer: { status: "proposed", reason: null },
        promotionBasisProducer: { status: "proposed", reason: null },
        responseAttribution: {
          status: "unavailable",
          reason: "legacy_response_journal_not_keyed_by_decision_episode",
        },
        providerWriteLinkage: {
          status: "unavailable",
          reason: "provider_write_journal_not_keyed_by_decision_episode",
        },
      },
    });
    expect(value(model.authority, "operator-responses")).toContain(
      "Legacy response journal not keyed by decision episode",
    );
    expect(value(model.authority, "provider-write-outcome")).toContain(
      "Provider write journal not keyed by decision episode",
    );
  });

  it("puts hashes and lineage ids in diagnostics, never on the summary", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical,
    });
    expect(value(model.diagnostics, "decision-hash")).toBe("dec_hash_9");
    expect(value(model.diagnostics, "input-hash")).toBe("in_hash_9");
    expect(value(model.diagnostics, "evaluation-id")).toBe("eval_9");
    expect(value(model.diagnostics, "job-run-id")).toBe("job_9");
    expect(value(model.diagnostics, "episode-id")).toBe("episode_1");
    expect(value(model.diagnostics, "real-ad-id")).toBe("120210000000012345");
    expect(value(model.diagnostics, "provider-account-ref")).toBe("ref_9");
    // The decision summary stays a summary.
    expect(model.verdict).not.toContain("dec_hash_9");
    expect(model.money).not.toContain("dec_hash_9");
    expect(model.reasons?.join(" ")).not.toContain("dec_hash_9");
  });

  it("em-dashes every audit field a payload does not carry", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({});
    expect(value(model.authority, "source-authority")).toBe("—");
    expect(value(model.authority, "identity-basis")).toBe("—");
    expect(value(model.diagnostics, "decision-hash")).toBe("—");
  });

  /*
   * The QUEUE-grain source envelope, which is a different fact from the row's.
   *
   * `canonical.sourceAuthority` says what this row may be used for.
   * `readModel.source` says what the whole generation is — which table it came
   * out of, which manifest validated it, and whether the server fell back. On
   * an account whose ads source degrades to `legacy_creative`, sixty rows keep
   * rendering and NOTHING on the row says so; only this envelope does.
   */
  const degradedSource = {
    status: "available",
    authority: "legacy_creative",
    table: "engine_v3_decision_snapshots_daily",
    snapshotAsOf: "2026-08-19",
    computedAt: "2026-08-19 03:53:25.268+00",
    engineVersion: "server-engine-v3",
    fallbackReason: "native_account_manifest_incomplete",
    generation: null,
  } as const;

  it("states the queue's own source authority beside the row's", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      source: degradedSource,
    });
    expect(value(model.authority, "queue-source-authority")).toBe(
      "Legacy creative · Available",
    );
    expect(value(model.authority, "queue-source-fallback")).toBe(
      "Native account manifest incomplete",
    );
    const row = model.authority?.find((r) => r.id === "queue-source-authority");
    expect(row?.tone).toBe("warning");
  });

  it("does not flag a healthy native generation as degraded", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
      source: {
        ...degradedSource,
        authority: "native_ad",
        table: "engine_v3_ad_decision_snapshots_daily",
        fallbackReason: null,
        generation: {
          jobRunId: "job_run_1",
          providerAccountRefId: "ref_gen_1",
          manifestHash: "manifest_hash_1",
          expectedAdCount: 2517,
        },
      },
    });
    expect(model.authority?.find((r) => r.id === "queue-source-authority")?.tone).toBe(
      "positive",
    );
    // No fallback row at all when the server states no fallback: an absent
    // reason must not be printed as an empty one.
    expect(
      model.authority?.some((r) => r.id === "queue-source-fallback"),
    ).toBe(false);
  });

  it("keeps generation lineage in diagnostics, including a measured count", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical,
      source: {
        ...degradedSource,
        generation: {
          jobRunId: "job_run_1",
          providerAccountRefId: "ref_gen_1",
          manifestHash: "manifest_hash_1",
          expectedAdCount: 0,
        },
      },
    });
    expect(value(model.diagnostics, "source-table")).toBe(
      "engine_v3_decision_snapshots_daily",
    );
    expect(value(model.diagnostics, "generation-manifest-hash")).toBe(
      "manifest_hash_1",
    );
    expect(value(model.diagnostics, "generation-job-run-id")).toBe("job_run_1");
    // A MEASURED zero is a number, not an absence. `?? EM_DASH` on a falsy
    // count would have erased the one value that says the manifest is empty.
    expect(value(model.diagnostics, "generation-expected-ad-count")).toBe("0");
    // Lineage never climbs onto the summary card.
    expect(model.verdict).not.toContain("manifest_hash_1");
    expect(model.money).not.toContain("manifest_hash_1");
  });

  it("states both decision journals rather than showing an empty history", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture({
        history: {
          events: {
            status: "unavailable",
            reason: "decision_event_journal_unavailable",
            preCapCount: 0,
            items: [],
          },
          outcomes: {
            status: "available",
            reason: null,
            items: [{ id: "outcome_1" }, { id: "outcome_2" }],
          },
          responses: { status: "unavailable", reason: null },
          providerWrites: { status: "unavailable", reason: null },
        },
      }),
    });
    expect(value(model.authority, "decision-events")).toBe(
      "unavailable · Decision event journal unavailable",
    );
    expect(value(model.authority, "decision-outcomes")).toBe("2 recorded");
  });

  it("counts a served-but-empty event journal as 0, never as unavailable", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture({
        history: {
          events: { status: "available", reason: null, preCapCount: 0, items: [] },
          outcomes: { status: "available", reason: null, items: [] },
          responses: { status: "unavailable", reason: null },
          providerWrites: { status: "unavailable", reason: null },
        },
      }),
    });
    expect(value(model.authority, "decision-events")).toBe("0 recorded of 0 served");
    expect(value(model.authority, "decision-outcomes")).toBe("0 recorded");
  });

  it("prints blocker codes as receipts while their labels stay on the verdict", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture({
        classification: {
          buyerLabel: "Refresh",
          blockers: [
            { code: "risk_tier_unclassified", label: "Risk is unclassified" },
          ],
        },
      }),
    });
    expect(value(model.diagnostics, "blocker-codes")).toBe("risk_tier_unclassified");
    expect(model.verdictSub).toContain("Risk is unclassified");
    expect(model.verdictSub).not.toContain("risk_tier_unclassified");
  });

  it("keeps the risk-tier statement visible as an advisory, with its reason and apart from the gates", () => {
    // The server no longer files `risk_tier_unclassified` under blockers, so
    // the window must not lose the statement with it. It states the same fact
    // in the same two places — the verdict sub-line and the receipts — under a
    // name that says it gates nothing.
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture({
        classification: {
          buyerLabel: "Cut",
          blockers: [],
          advisories: [
            {
              code: "risk_tier_unclassified",
              label: "Risk is unclassified",
              category: "risk",
              reason: "risk_tier_producer_not_persisted",
            },
          ],
        },
      }),
    });

    expect(value(model.diagnostics, "advisory-codes")).toBe(
      "risk_tier_unclassified",
    );
    expect(value(model.diagnostics, "blocker-codes")).toBe("—");
    expect(model.verdictSub).toContain(
      "Advisory: Risk is unclassified — Risk tier producer not persisted.",
    );
    expect(model.verdictSub).not.toContain("risk_tier_unclassified");
  });

  it("says the advisory receipt has no issuer when no envelope was served", () => {
    // Advisories exist only on the canonical envelope, so an absent envelope
    // must not print the em dash an issued-but-empty receipt prints.
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: null,
    });
    expect(value(model.diagnostics, "advisory-codes")).toBe(
      "unavailable · no canonical decision envelope was served for this row",
    );
  });

  it("states the server's Launchpad verdict beside the served action tuple", () => {
    const refused = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical,
      launchpadRoute: {
        offered: false,
        refusalReason: "That decision is held, so no launch handoff was created.",
      },
    });
    expect(value(refused.authority, "served-action")).toBe(
      "refresh_creative · intent brief · ad · no provider mutation",
    );
    expect(value(refused.authority, "launchpad-route")).toBe(
      "refused · That decision is held, so no launch handoff was created.",
    );
    const offered = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical,
      launchpadRoute: { offered: true, refusalReason: null },
    });
    expect(value(offered.authority, "launchpad-route")).toBe("offered");
  });

  it("names a served provider mutation instead of leaving the tuple half-read", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({
        action: {
          code: "cut",
          label: "Cut",
          intent: "execute",
          targetLevel: "ad",
          providerMutation: "pause",
          scopeNote: "Pauses this ad",
        },
      }),
      canonical,
    });
    expect(value(model.authority, "served-action")).toBe(
      "cut · intent execute · ad · provider pause",
    );
    expect(model.authority?.find((r) => r.id === "served-action")?.tone).toBe(
      "warning",
    );
  });
});

describe("buildCreativeEvidenceWindowExactViewModel primary action tuple", () => {
  it("hands the callback the served action object itself, not a copy", () => {
    const decision = decisionFixture();
    const seen: unknown[] = [];
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision,
      canonical: canonicalFixture(),
      callbacks: { onPrimary: (action) => seen.push(action) },
    });
    model.primaryAction?.onClick?.();
    expect(seen).toHaveLength(1);
    // Reference identity is the whole point: a spread or a rebuilt literal
    // would pass this test's field checks and still be a reconstruction.
    expect(seen[0]).toBe(decision.action);
    expect(seen[0]).toEqual({
      code: "refresh_creative",
      label: "Refresh Creative",
      intent: "brief",
      targetLevel: "ad",
      providerMutation: null,
      scopeNote: "Creates a replacement brief; does not pause this ad",
    });
  });

  it("keeps an offered native-Ad pause callback active when Launchpad is refused", () => {
    const decision = decisionFixture({
      action: {
        code: "cut",
        label: "Cut",
        intent: "execute",
        targetLevel: "ad",
        providerMutation: "pause",
        scopeNote: "Pauses this exact Ad",
      },
    });
    const onPrimary = vi.fn();
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision,
      canonical: canonicalFixture(),
      launchpadRoute: {
        offered: false,
        refusalReason: "Provider actions do not use Launchpad.",
      },
      primaryActionAuthority: {
        kind: "native_ad_pause",
        offered: true,
        refusalReason: null,
      },
      callbacks: { onPrimary },
    });

    model.primaryAction?.onClick?.();

    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onPrimary).toHaveBeenCalledWith(decision.action);
    expect(
      model.authority?.find((row) => row.id === "launchpad-route")?.value,
    ).toBe("refused · Provider actions do not use Launchpad.");
    expect(
      model.authority?.find((row) => row.id === "primary-action-authority")
        ?.value,
    ).toBe("Native ad pause · offered");
  });

  it("structurally suppresses a refused native-Ad pause callback", () => {
    const onPrimary = vi.fn();
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({
        action: {
          code: "cut",
          label: "Cut",
          intent: "execute",
          targetLevel: "ad",
          providerMutation: "pause",
          scopeNote: "Pauses this exact Ad",
        },
      }),
      canonical: canonicalFixture(),
      launchpadRoute: { offered: true, refusalReason: null },
      primaryActionAuthority: {
        kind: "native_ad_pause",
        offered: false,
        refusalReason: "Exact native-Ad pause authority is unavailable.",
      },
      callbacks: { onPrimary },
    });

    expect(model.primaryAction?.onClick).toBeUndefined();
    model.primaryAction?.onClick?.();
    expect(onPrimary).not.toHaveBeenCalled();
    expect(
      model.authority?.find((row) => row.id === "primary-action-authority")
        ?.value,
    ).toBe(
      "Native ad pause · refused · Exact native-Ad pause authority is unavailable.",
    );
  });

  it("refuses to caption a primary control the payload served no action for", () => {
    // This used to fall back to the buyer label, so a canonical-only payload
    // produced a button reading "Refresh" — a CLASSIFICATION rendered as an
    // ACTION the server never authorized. A missing action is a dash.
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: null,
      canonical: canonicalFixture(),
      callbacks: { onPrimary: () => undefined },
    });
    expect(model.primaryAction?.label).toBe("—");
    expect(model.primaryAction?.disabled).toBe(true);
    expect(model.primaryAction?.onClick).toBeUndefined();
  });

  it("stays inert when the caller offers no callback, action or not", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(model.primaryAction?.label).toBe("Refresh Creative");
    expect(model.primaryAction?.onClick).toBeUndefined();
  });
});

/**
 * The row the Decision Center serves 60 of on a real account: a live Ad the
 * engine decided about, with NO canonical decision snapshot behind it.
 *
 * Until this batch such a row could not open the evidence window at all — the
 * affordance was gated on the envelope — so the evidence the engine did serve
 * for it was unreachable by any click. It opens now, and everything below pins
 * the price of that: the window may show the served half and must refuse to
 * invent the other half, out loud, field by field.
 */
function servedOnlyDecision(): MetaOsAdDecision {
  return decisionFixture({
    id: "os_ad_pending",
    decisionId: "inventory:ad_2",
    sourceSnapshotId: "inventory:ad_2:2026-08-16",
    lane: "blocked",
    decisionAvailability: "pending_native_evidence",
    publishedLabel: "not_evaluated",
    rawLabel: null,
    riskTier: null,
    confidence: "low",
    confidenceScore: 0.12,
    priority: { band: "low", rank: 41 } as unknown as MetaOsAdDecision["priority"],
    assessment: "Live Ad with no exact Ad-grain decision",
    whyNow:
      "Meta confirms this Ad is ACTIVE, but the exact Ad-grain decision snapshot is not available.",
    action: {
      code: "await_ad_grain_evidence",
      label: "Evidence pending",
      intent: "review",
      targetLevel: "ad",
      providerMutation: null,
      scopeNote:
        "The Ad is live, but no exact Ad-grain decision snapshot can authorize an action yet",
    },
    blockers: [
      {
        code: "native_ad_decision_unavailable",
        label: "Exact Ad-grain decision evidence is unavailable",
      },
    ],
    resolution: {
      code: "produce_native_ad_decision",
      category: "system",
      owner: "system",
      label: "Produce exact Ad decision",
      nextStep: "Complete the native Ad decision schema and producer lineage gate.",
    },
  });
}

describe("a row served with no canonical decision envelope", () => {
  function auditValue(
    rows: readonly { id: string; value?: unknown }[] | undefined,
    id: string,
  ) {
    return rows?.find((row) => row.id === id)?.value;
  }

  const ABSENT = "unavailable · no canonical decision envelope was served for this row";

  it("states plainly which half of the evidence it is holding", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: servedOnlyDecision(),
      canonical: null,
    });
    expect(model.coverage?.state).toBe("served-only");
    expect(model.coverage?.headline).toContain("Served evidence only");
    expect(model.coverage?.headline).toContain("read-only");
    // The two halves are NAMED, not merely counted.
    expect(model.coverage?.served).toContain("engine reasoning");
    expect(model.coverage?.served).toContain("ad metrics");
    expect(model.coverage?.unavailable).toContain("action eligibility");
    expect(model.coverage?.unavailable).toContain("provider lineage");
    expect(model.coverage?.unavailable).toContain("provider-write outcome");
    expect(model.coverage?.note).toContain("no action authority");
  });

  it("says a row WITH an envelope is holding both halves", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(model.coverage?.state).toBe("served-and-canonical");
    expect(model.coverage?.note).toBe("");
  });

  it("makes no coverage claim when nothing at all was served", () => {
    // A window built from an empty payload has no row to describe, so it does
    // not announce a gap it cannot locate.
    expect(buildCreativeEvidenceWindowExactViewModel({}).coverage).toBeNull();
  });

  /**
   * LAW: a canonical-only field with no canonical envelope says so, with the
   * reason. It is never a blank, and it is never inferred.
   */
  it("marks every canonical-only audit field unavailable, with the reason", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: servedOnlyDecision(),
      canonical: null,
    });
    for (const id of [
      "source-authority",
      "action-eligibility",
      "exact-decision-computed-at",
      "exact-decision-freshness",
      "execution-readiness",
      "authorized-action",
      "decision-state",
      "identity-basis",
      "delivery-scope",
      // Whether the creative's own media is readable at source. Only the
      // envelope answers it, so with no envelope the row says so rather than
      // letting the presence or absence of a preview stand in for the answer.
      "creative-media",
      "risk-tier",
      "confirmation-ceremony",
      "operator-responses",
      "provider-write-outcome",
      "decision-events",
      "decision-outcomes",
    ]) {
      expect(auditValue(model.authority, id)).toBe(ABSENT);
    }
    for (const id of [
      "decision-hash",
      "input-hash",
      "evaluation-id",
      "job-run-id",
      "provider-account-ref",
      "real-ad-id",
      "identity-grain",
      "truth-source",
      "classification-provenance",
      "promotion-basis",
    ]) {
      expect(auditValue(model.diagnostics, id)).toBe(ABSENT);
    }
  });

  /**
   * LAW: the two absences stay apart.
   *
   * "The envelope is here and this field is empty in it" is an answered
   * question. "No envelope was served" is an unanswered one, and it is the only
   * one that also means the row carries no authority. A single em-dash for both
   * turns the second into the first.
   */
  it("keeps an empty field inside a served envelope apart from no envelope at all", () => {
    const empty = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(auditValue(empty.authority, "identity-basis")).toBe("—");
    expect(auditValue(empty.diagnostics, "decision-hash")).toBe("—");

    const absent = buildCreativeEvidenceWindowExactViewModel({
      decision: servedOnlyDecision(),
      canonical: null,
    });
    expect(auditValue(absent.authority, "identity-basis")).toBe(ABSENT);
    expect(auditValue(absent.diagnostics, "decision-hash")).toBe(ABSENT);
  });

  /**
   * LAW: eligibility, lineage and write authority are NEVER read off the
   * presentation decision.
   *
   * The served action tuple is the sharpest trap here: the row carries
   * `{code: "await_ad_grain_evidence", label: "Evidence pending", intent:
   * "review"}`, and printing that under "Authorized action" or answering
   * "Action eligible: yes" from its presence would manufacture an authority the
   * server never granted.
   */
  it("never infers eligibility or authority from the served action", () => {
    const decision = servedOnlyDecision();
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision,
      canonical: null,
    });
    expect(auditValue(model.authority, "action-eligibility")).toBe(ABSENT);
    expect(auditValue(model.authority, "authorized-action")).toBe(ABSENT);
    expect(auditValue(model.authority, "authorized-action")).not.toContain(
      decision.action.code,
    );
    expect(auditValue(model.authority, "authorized-action")).not.toContain(
      decision.action.label,
    );
    // The served tuple is still stated — verbatim, under its own label, as a
    // SERVED fact rather than as an eligibility verdict.
    expect(auditValue(model.authority, "served-action")).toContain(
      "await_ad_grain_evidence",
    );
    expect(auditValue(model.authority, "served-action")).toContain(
      "no provider mutation",
    );
  });

  /**
   * LAW: fail-closed. No provider-write control on a row with no authority.
   *
   * Both gates are asserted: the caller withholding the callback, AND a stated
   * `offered: false` beating a callback that arrived anyway.
   */
  it("offers no live primary control, even if a callback is handed in anyway", () => {
    const refusal = "This row was served with no canonical decision envelope.";
    const onPrimary = vi.fn();
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: servedOnlyDecision(),
      canonical: null,
      launchpadRoute: { offered: false, refusalReason: refusal },
      callbacks: { onPrimary },
    });
    expect(model.primaryAction?.onClick).toBeUndefined();
    expect(model.primaryAction?.href).toBeNull();
    expect(onPrimary).not.toHaveBeenCalled();
    // And the refusal is stated where the eligibility evidence is, so the inert
    // footer explains itself instead of looking broken.
    expect(auditValue(model.authority, "launchpad-route")).toBe(
      `refused · ${refusal}`,
    );
  });

  /**
   * LAW: a broken or in-flight helper read stays distinguishable from the
   * envelope gap, and from a real absence. Three states, three renderings.
   */
  it("keeps a failed helper read distinct from the missing envelope", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: servedOnlyDecision(),
      canonical: null,
      adRowsState: "error",
      adRowsErrorMessage: "meta creatives read failed",
      adSeriesState: "loading",
    });
    expect(model.readNotice?.tone).toBe("negative");
    expect(model.readNotice?.text).toContain("meta creatives read failed");
    // The unread funnel cells say "unreadable" — not the em-dash a measured
    // absence prints, and not the envelope sentence either.
    expect(model.funnel?.[0]?.value).toBe("unreadable");
    expect(model.coverage?.state).toBe("served-only");
    expect(auditValue(model.authority, "source-authority")).toBe(ABSENT);
  });

  /**
   * LAW: the served half is actually rendered. The point of opening the window
   * on an envelope-less row is the evidence it does carry.
   */
  it("renders the served lane, availability, blockers, resolution and assessment", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: servedOnlyDecision(),
      canonical: null,
    });
    expect(auditValue(model.authority, "served-lane")).toBe("Blocked");
    expect(auditValue(model.authority, "served-availability")).toBe(
      "Pending native evidence",
    );
    expect(auditValue(model.authority, "served-confidence")).toBe("low · score 0.12");
    expect(auditValue(model.authority, "served-priority")).toBe("low · rank 41");
    expect(auditValue(model.authority, "served-resolution")).toContain(
      "Produce exact Ad decision",
    );
    expect(auditValue(model.authority, "served-resolution")).toContain("owner system");
    // The blocker label and the next step ride the verdict sub-line, which is
    // where this drawer keeps gate text.
    expect(model.verdictSub).toContain(
      "Exact Ad-grain decision evidence is unavailable.",
    );
    expect(model.verdictSub).toContain(
      "Next: Complete the native Ad decision schema and producer lineage gate.",
    );
    // Both reasoning sentences, and the blocker CODE as a receipt.
    expect(model.reasons).toEqual([
      "Meta confirms this Ad is ACTIVE, but the exact Ad-grain decision snapshot is not available.",
      "Live Ad with no exact Ad-grain decision",
    ]);
    expect(auditValue(model.diagnostics, "blocker-codes")).toBe(
      "native_ad_decision_unavailable",
    );
    // Served identity: without the envelope these ids are the only statement of
    // which ad the window is about.
    expect(auditValue(model.diagnostics, "served-ad")).toBe(
      "120210000000012345 · Server Ad",
    );
    expect(auditValue(model.diagnostics, "snapshot-id")).toBe(
      "inventory:ad_2:2026-08-16",
    );
  });

  /**
   * LAW: a MEASURED zero stays 0. The envelope sentence must not swallow a
   * number the server actually served.
   */
  it("keeps a served zero as 0 rather than as the envelope sentence", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({
        confidenceScore: 0,
        priority: { band: "unrankable", rank: 0 } as unknown as MetaOsAdDecision["priority"],
      }),
      canonical: null,
    });
    expect(auditValue(model.authority, "served-confidence")).toBe("high · score 0.00");
    expect(auditValue(model.authority, "served-priority")).toBe("unrankable · rank 0");
  });
});

/**
 * The four served fields this window had been dropping, and why each one's home
 * is the one it got.
 *
 * Each was named by a coverage sweep as "served by the payload, rendered
 * nowhere". None of them is a decision, so none of them joined the summary card
 * — the rule this file already keeps for blocker codes applies to all four: the
 * half an operator READS goes where they read, and the half they QUOTE BACK goes
 * with the receipts.
 */
describe("served fields that reached no surface", () => {
  function auditValue(
    rows: readonly { id: string; value?: unknown }[] | undefined,
    id: string,
  ) {
    return rows?.find((row) => row.id === id)?.value;
  }

  const ABSENT = "unavailable · no canonical decision envelope was served for this row";

  /**
   * LAW: the machine-readable half of a served object is a receipt, not a
   * verdict.
   *
   * `resolution.label`, `owner` and `category` are already read by the audit
   * block's "Served resolution" line and `nextStep` rides the verdict sub-line.
   * The `code` is what an operator quotes back when the resolution is wrong, so
   * it belongs in the diagnostics disclosure beside the blocker codes — and it
   * must not be duplicated onto the decision-facing lines.
   */
  it("prints the served resolution's code as a receipt, once", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: servedOnlyDecision(),
      canonical: null,
    });

    expect(auditValue(model.diagnostics, "served-resolution-code")).toBe(
      "produce_native_ad_decision",
    );
    // The operator-facing lines keep the LABEL and the NEXT STEP, not the code.
    expect(auditValue(model.authority, "served-resolution")).not.toContain(
      "produce_native_ad_decision",
    );
    expect(model.verdictSub).not.toContain("produce_native_ad_decision");
  });

  it("leaves the resolution code an em dash when the decision served no resolution", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({ resolution: null }),
      canonical: canonicalFixture(),
    });
    expect(auditValue(model.diagnostics, "served-resolution-code")).toBe("—");
  });

  /**
   * LAW: the authority gate's code is read from whichever envelope carried it.
   *
   * `authorityProvenance.firstBlocker.code` is not a second opinion — the OS
   * presentation copies it verbatim off `sourceDecision.authorityBlocker` — but
   * the two do not ARRIVE together. The presentation decision is served for
   * every row; the canonical envelope is served only for rows the section and
   * candidate caps kept. Reading the canonical field alone made an
   * envelope-less row print "no envelope was served" for a gate the payload had
   * named in full.
   */
  it("falls back to the served first blocker's code when no envelope was served", () => {
    const withProvenance = servedOnlyDecision();
    (withProvenance as unknown as Record<string, unknown>).authorityProvenance = {
      availability: "available",
      preAuthorityLabel: "cut",
      postAuthorityRawLabel: "refresh",
      publishedLabel: "refresh",
      firstBlocker: {
        code: "recent_recovery_unverifiable",
        label: "Recent economic recovery cannot be ruled out",
        explanation:
          "The Cut verdict is held until a sufficiently sampled recent window confirms ROAS remains below break-even.",
      },
    };

    const servedOnly = buildCreativeEvidenceWindowExactViewModel({
      decision: withProvenance,
      canonical: null,
    });
    expect(auditValue(servedOnly.diagnostics, "authority-blocker")).toBe(
      "recent_recovery_unverifiable",
    );

    // With an envelope the CANONICAL field still wins: the fallback fills a gap,
    // it does not overwrite the record a write would be authorized against.
    const withEnvelope = buildCreativeEvidenceWindowExactViewModel({
      decision: withProvenance,
      canonical: canonicalFixture({
        sourceDecision: {
          reason: "Envelope reason",
          confidence: 91,
          confidenceBand: "high",
          engineVersion: "server-engine-v3",
          snapshotAsOf: "2026-08-14",
          truthSource: "server",
          badges: [],
          authorityBlocker: "native_profile_unavailable",
        },
      }),
    });
    expect(auditValue(withEnvelope.diagnostics, "authority-blocker")).toBe(
      "native_profile_unavailable",
    );

    // And a decision that served no provenance at all still says the envelope
    // is the thing that is missing, rather than going quiet.
    const neither = buildCreativeEvidenceWindowExactViewModel({
      decision: servedOnlyDecision(),
      canonical: null,
    });
    expect(auditValue(neither.diagnostics, "authority-blocker")).toBe(ABSENT);
  });

  /**
   * LAW: the sentence that explains a held label is prose an operator reads, so
   * it goes in the audit block, not in the receipts.
   *
   * The provenance line names the gate; the label is a noun phrase and says
   * nothing about what the gate DID to this verdict. On a held row with no
   * resolution the explanation is the only served prose that answers it.
   */
  it("prints the first blocker's explanation as its own line beside the provenance", () => {
    const held = decisionFixture({ resolution: null });
    (held as unknown as Record<string, unknown>).authorityProvenance = {
      availability: "available",
      preAuthorityLabel: "cut",
      postAuthorityRawLabel: "refresh",
      publishedLabel: "refresh",
      firstBlocker: {
        code: "recent_recovery_unverifiable",
        label: "Recent economic recovery cannot be ruled out",
        explanation:
          "The Cut verdict is held until a sufficiently sampled recent window confirms ROAS remains below break-even.",
      },
    };

    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: held,
      canonical: canonicalFixture(),
    });

    // The joined provenance line keeps the label and the three label states.
    expect(auditValue(model.authority, "served-authority-provenance")).toContain(
      "first blocker Recent economic recovery cannot be ruled out",
    );
    // The sentence is its own row, so a token list does not become a paragraph.
    expect(auditValue(model.authority, "served-first-blocker-explanation")).toBe(
      "The Cut verdict is held until a sufficiently sampled recent window confirms ROAS remains below break-even.",
    );

    // No first blocker, no row: a decision that passed every gate must not
    // acquire an empty "held because" line suggesting one was tripped.
    const clean = decisionFixture();
    (clean as unknown as Record<string, unknown>).authorityProvenance = {
      availability: "available",
      preAuthorityLabel: "refresh",
      postAuthorityRawLabel: "refresh",
      publishedLabel: "refresh",
      firstBlocker: null,
    };
    const passed = buildCreativeEvidenceWindowExactViewModel({
      decision: clean,
      canonical: canonicalFixture(),
    });
    expect(
      passed.authority?.some((row) => row.id === "served-first-blocker-explanation"),
    ).toBe(false);
  });

  /**
   * LAW: whether the creative's media is readable is a different question from
   * whether a thumbnail rendered, and the window must answer the one it is for.
   *
   * `media.state` is computed from `media_source_present` / `media_available`;
   * `media.thumbnail.state` is computed from whether a `thumbnail_url` survived.
   * A cached thumbnail beside a missing media asset draws a picture over a
   * creative the source says is gone, and before this the window showed the
   * picture and said nothing.
   */
  it("states the canonical media state even when the thumbnail still renders", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture({
        media: {
          state: "missing",
          missingMedia: true,
          thumbnail: { state: "available", url: "https://x/cached.jpg" },
        },
      }),
    });

    // The preview still comes from the served thumbnail — this adds a statement,
    // it does not withhold an image the payload carried.
    expect(model.previewUrl).toBe("https://x/cached.jpg");
    expect(auditValue(model.authority, "creative-media")).toBe("Missing");
    expect(
      model.authority?.find((row) => row.id === "creative-media")?.tone,
    ).toBe("warning");

    const healthy = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(auditValue(healthy.authority, "creative-media")).toBe("Available");
    expect(
      healthy.authority?.find((row) => row.id === "creative-media")?.tone,
    ).toBe("positive");
  });

  /**
   * LAW: none of the four became a provider write, a lane, or an action.
   *
   * Every one of them is copy off a served envelope. The window's primary
   * control is still the server's own action tuple and nothing here may add a
   * second route to it.
   */
  it("adds no callback and no action to the window for any of them", () => {
    const held = servedOnlyDecision();
    (held as unknown as Record<string, unknown>).authorityProvenance = {
      availability: "available",
      preAuthorityLabel: "cut",
      postAuthorityRawLabel: "refresh",
      publishedLabel: "refresh",
      firstBlocker: {
        code: "recent_recovery_unverifiable",
        label: "Recent economic recovery cannot be ruled out",
        explanation: "Held until the recent window is sampled.",
      },
    };
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: held,
      canonical: null,
    });

    for (const row of [...(model.authority ?? []), ...(model.diagnostics ?? [])]) {
      for (const value of Object.values(row)) {
        expect(typeof value).not.toBe("function");
      }
    }
    expect(model.primaryAction?.onClick).toBeUndefined();
  });
});

/**
 * The inverse of the null-vs-zero law, which is a law in its own right.
 *
 * "Unsupplied fact -> em dash" is only half of it. The other half is that a
 * SUPPLIED fact must never be dressed as an unsupplied one: a measured absence
 * rendered as "we could not tell" is the same lie told backwards, and it is
 * harder to catch because the dash-and-sentence vocabulary looks careful.
 */
describe("a measured absence never renders as an unknown", () => {
  function auditValue(
    rows: readonly { id: string; value?: unknown }[] | undefined,
    id: string,
  ) {
    return rows?.find((row) => row.id === id)?.value;
  }

  const ABSENT = "unavailable · no canonical decision envelope was served for this row";

  function withProvenance(
    decision: MetaOsAdDecision,
    provenance: Record<string, unknown>,
  ): MetaOsAdDecision {
    (decision as unknown as Record<string, unknown>).authorityProvenance =
      provenance;
    return decision;
  }

  /**
   * LAW: `authorityProvenance.firstBlocker === null` under an AVAILABLE
   * provenance is the server stating that no authority gate was tripped. That
   * is an answer, and an answer may not print as a missing source.
   *
   * This is the case the fallback's own test never reached: it built its
   * envelope-less row from `servedOnlyDecision()`, which serves no
   * `authorityProvenance` at all, so the served-AND-EMPTY branch went uncovered
   * while `authority-blocker` stayed in the canonical-only set — and every row
   * whose gates all passed reported "no canonical decision envelope was served"
   * for a question the payload had answered.
   */
  it("prints an em dash when the served provenance says no gate was tripped", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: withProvenance(servedOnlyDecision(), {
        availability: "available",
        preAuthorityLabel: "refresh",
        postAuthorityRawLabel: "refresh",
        publishedLabel: "refresh",
        firstBlocker: null,
      }),
      canonical: null,
    });

    expect(auditValue(model.diagnostics, "authority-blocker")).toBe("—");
    expect(auditValue(model.diagnostics, "authority-blocker")).not.toBe(ABSENT);
  });

  /**
   * LAW: the same dash must not spread to the receipts that really do have only
   * one issuer. A served provenance answers the AUTHORITY GATE question and
   * nothing else, so lineage and identity keep saying they have no source.
   */
  it("leaves the truly canonical-only receipts saying they have no issuer", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: withProvenance(servedOnlyDecision(), {
        availability: "available",
        preAuthorityLabel: "refresh",
        postAuthorityRawLabel: "refresh",
        publishedLabel: "refresh",
        firstBlocker: null,
      }),
      canonical: null,
    });

    expect(auditValue(model.diagnostics, "input-hash")).toBe(ABSENT);
    expect(auditValue(model.diagnostics, "decision-hash")).toBe(ABSENT);
    expect(auditValue(model.diagnostics, "truth-source")).toBe(ABSENT);
    expect(auditValue(model.diagnostics, "identity-grain")).toBe(ABSENT);
  });

  /**
   * LAW: and the converse — a real unknown must not be flattened into the dash
   * the measured absence now prints. Two shapes are unknowns:
   *
   *   no `authorityProvenance` at all — nothing carried the question
   *   `availability: "historical_unavailable"` — set when `preAuthorityLabel`
   *   is null, i.e. the row predates the gate ledger, so its null blocker is
   *   UNRECORDED, not untripped
   */
  it("keeps the absence sentence when nothing answered the gate question", () => {
    const noProvenance = buildCreativeEvidenceWindowExactViewModel({
      decision: servedOnlyDecision(),
      canonical: null,
    });
    expect(auditValue(noProvenance.diagnostics, "authority-blocker")).toBe(ABSENT);

    const historical = buildCreativeEvidenceWindowExactViewModel({
      decision: withProvenance(servedOnlyDecision(), {
        availability: "historical_unavailable",
        preAuthorityLabel: null,
        postAuthorityRawLabel: "refresh",
        publishedLabel: "refresh",
        firstBlocker: null,
      }),
      canonical: null,
    });
    expect(auditValue(historical.diagnostics, "authority-blocker")).toBe(ABSENT);
  });

  /**
   * LAW: a served envelope that named no gate is also a measured absence, and
   * it was already honest. Pinned so the per-row rule cannot regress it.
   */
  it("prints an em dash when the canonical envelope named no gate", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture(),
      canonical: canonicalFixture(),
    });
    expect(auditValue(model.diagnostics, "authority-blocker")).toBe("—");
  });

  /**
   * LAW: a fabricated constant must never render as a measurement.
   *
   * The synthesised `await_ad_grain_evidence` row is a placeholder whose own
   * `whyNow` says the Ad-grain snapshot is not available. It carried a
   * hardcoded `confidenceScore: 0`, and the served-confidence line printed
   * "low · score 0.00" — a number no engine produced, shown in the exact format
   * a real score is shown in. `confidenceScore` is now nullable and the
   * placeholder serves null.
   */
  it("prints no score when the payload served none", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({ confidence: "low", confidenceScore: null }),
      canonical: null,
    });
    expect(auditValue(model.authority, "served-confidence")).toBe("low");
    expect(auditValue(model.authority, "served-confidence")).not.toContain("score");
  });

  /**
   * LAW: and a MEASURED zero is still a measurement. The nullable field must not
   * become an excuse to swallow a real engine score of zero.
   */
  it("still prints a served score of zero as 0.00", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({ confidence: "low", confidenceScore: 0 }),
      canonical: null,
    });
    expect(auditValue(model.authority, "served-confidence")).toBe("low · score 0.00");
  });

  /**
   * LAW: a thumbnail the server marked unusable is not a preview.
   *
   * `media.thumbnail.state` and `media.thumbnail.url` are two separate served
   * facts, and a stale `url` survives beside a `missing` state. The window reads
   * the URL only through the state gate, so a picture is never drawn over a
   * creative the source says is gone. Deleting `=== "available"` from that gate
   * left all 64 tests in this file green, which is why these exist.
   */
  it("refuses a thumbnail url the server did not mark available", () => {
    for (const state of ["missing", "unavailable"] as const) {
      const model = buildCreativeEvidenceWindowExactViewModel({
        decision: decisionFixture({ thumbnailUrl: null }),
        canonical: canonicalFixture({
          media: {
            state: "missing",
            missingMedia: true,
            thumbnail: { state, url: "https://x/stale.jpg" },
          },
        }),
      });
      expect(model.previewUrl).toBeNull();
    }
  });

  /**
   * LAW: refusing the canonical url is not the same as withholding the image.
   * The served `thumbnailUrl` is a different fact from a different envelope and
   * still fills the preview — the gate drops the url it distrusts, not the row.
   */
  it("falls back to the served thumbnail rather than the distrusted one", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({ thumbnailUrl: "https://served/live.jpg" }),
      canonical: canonicalFixture({
        media: {
          state: "missing",
          missingMedia: true,
          thumbnail: { state: "missing", url: "https://x/stale.jpg" },
        },
      }),
    });
    expect(model.previewUrl).toBe("https://served/live.jpg");
  });

  /**
   * LAW: and the gate must still PASS what the server did mark available, or
   * the fix would be a different dishonesty — a served preview withheld.
   */
  it("uses the canonical thumbnail the server marked available", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: decisionFixture({ thumbnailUrl: "https://served/live.jpg" }),
      canonical: canonicalFixture({
        media: {
          state: "available",
          missingMedia: false,
          thumbnail: { state: "available", url: "https://x/canonical.jpg" },
        },
      }),
    });
    expect(model.previewUrl).toBe("https://x/canonical.jpg");
  });

  /**
   * LAW: none of the above created a route to a provider write.
   */
  it("adds no callback anywhere in the rows it changed", () => {
    const model = buildCreativeEvidenceWindowExactViewModel({
      decision: withProvenance(servedOnlyDecision(), {
        availability: "available",
        preAuthorityLabel: "refresh",
        postAuthorityRawLabel: "refresh",
        publishedLabel: "refresh",
        firstBlocker: null,
      }),
      canonical: null,
    });
    for (const row of [...(model.authority ?? []), ...(model.diagnostics ?? [])]) {
      for (const value of Object.values(row)) {
        expect(typeof value).not.toBe("function");
      }
    }
    expect(model.primaryAction?.onClick).toBeUndefined();
  });
});
