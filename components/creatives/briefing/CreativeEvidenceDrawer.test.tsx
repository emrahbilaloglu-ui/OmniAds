import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CreativeEvidenceDrawer } from "@/components/creatives/briefing/CreativeEvidenceDrawer";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

function card(overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: "ad_4421",
    adId: "ad_4421",
    realAdId: "90021",
    creativeId: "creative_4421",
    name: "UGC Sarah V2",
    brand: "brand.co",
    campaignName: "Spring Test",
    adsetName: "Reels Prospecting",
    label: "scale",
    campaignKind: "test",
    campaignLabelStatus: "labeled",
    confidence: 91,
    reason: "ROAS sustained above account target in test campaign.",
    spend: 1240,
    roas: 2.74,
    cpa: 31,
    purchases: 11,
    ctr: 1.84,
    addToCart: 42,
    frequency: 2.1,
    fatigue: false,
    bestPlacement: "Reels",
    sourceDataSource: "briefing",
    primary: { kind: "promote", label: "Promote to main" },
    mediaPreviewUrl: "https://example.com/creative.jpg",
    creativeVisualFormat: "video",
    creativePrimaryType: "video",
    creativePrimaryLabel: "Video",
    preview: {
      render_mode: "image",
      image_url: "https://example.com/creative.jpg",
      video_url: null,
      poster_url: "https://example.com/poster.jpg",
      source: "fixture",
      is_catalog: false,
    },
    ...overrides,
  };
}

function decisionCenterRow(): NonNullable<BriefingCreativeCard["decisionCenterRow"]> {
  return {
    scope: "creative",
    creativeId: "creative_4421",
    rowId: "ad_4421",
    identityGrain: "creative",
    familyId: null,
    engine: {
      contractVersion: "creative-decision-os.v2.1",
      engineVersion: "decision-engine-v3-test",
      primaryDecision: "Scale",
      actionability: "review_only",
      problemClass: "performance",
      confidence: 88,
      maturity: "mature",
      priority: "high",
      reasonTags: ["v3_scale"],
      evidenceSummary: "Server evidence.",
      blockerReasons: [],
      missingData: [],
      queueEligible: false,
      applyEligible: false,
    },
    buyerAction: "scale",
    buyerLabel: "Scale review",
    uiBucket: "scale",
    executionAction: "promote_to_main",
    sourceDecision: "v3:scale",
    confidenceBand: "high",
    priority: "high",
    oneLine: "Server supplied V2.1 decision.",
    reasons: ["above_target"],
    nextStep: "Review budget context before scaling.",
    missingData: [],
  };
}

const noopProps = {
  onClose: () => undefined,
  onCut: () => undefined,
  onDefer: () => undefined,
  onUndefer: () => undefined,
  onLaunchpad: () => undefined,
};

function renderDrawer(
  element: React.ReactElement,
  queryData?: Record<string, unknown>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (queryData) {
    client.setQueryData(
      [
        "creative-evidence-ad-preview",
        "biz_1",
        "creative_4421",
        "90021",
        "feed",
      ],
      queryData,
    );
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
  );
}

describe("CreativeEvidenceDrawer", () => {
  it("renders the product drawer pattern with a chrome-free placement preview and evidence actions", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer open card={card()} {...noopProps} />,
    );

    expect(html).toContain("creative-evidence-drawer-shell");
    expect(html).toContain("creative-evidence-stage");
    expect(html).toContain("creative-evidence-preview-slot");
    expect(html).not.toContain("creative-evidence-phone");
    expect(html).not.toContain("creative-evidence-notch");
    expect(html).toContain("creative-evidence-drawer");
    expect(html).toContain("Promote to main");
    expect(html).toContain("Evidence");
    expect(html).not.toContain("Decision Center");
    expect(html).toContain("Automation readiness");
    expect(html).toContain("Operator history");
    expect(html).toContain("Add to existing");
    expect(html).toContain("Fresh test");
    expect(html).toContain("data-media-shape=\"portrait\"");
    expect(html).toContain("Meta ad preview unavailable");
    expect(html).not.toContain("creative-evidence-phone-surface");
    expect(html).not.toContain("creative-evidence-preview-overlay");
    expect(html).not.toContain("adsecute.app");
    expect(html).not.toContain("browser-bar");
  });

  it("renders Meta preview html in an iframe instead of the static thumbnail chain", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer open businessId="biz_1" card={card()} {...noopProps} />,
      {
        html: "<div data-meta-preview>Real Meta ad preview</div>",
        adFormat: "MOBILE_FEED_STANDARD",
        source: "meta_creative_previews",
        targetType: "ad",
      },
    );

    expect(html).toContain("creative-evidence-live-frame");
    expect(html).toContain("creative-evidence-preview-frame-shell");
    expect(html).toContain("data-preview-placement=\"feed\"");
    expect(html).toContain("--preview-aspect:4 / 5");
    expect(html).toContain("--preview-native-width:540px");
    expect(html).toContain("--preview-native-height:675px");
    expect(html).not.toContain("--preview-scaled-width");
    expect(html).not.toContain("--preview-scaled-height");
    expect(html).toContain("adsecute-meta-preview-fit");
    expect(html).toContain("adsecute-meta-preview-content");
    expect(html).toContain("body &gt; iframe");
    expect(html).toContain("fitNestedPreviewFrames");
    expect(html).toContain("fitContentLayer");
    expect(html).toContain("readContentDimension");
    expect(html).toContain("adsecuteNativeWidth");
    expect(html).toContain("fitScaleFor");
    expect(html).toContain("FIT_MODE === &quot;cover&quot;");
    expect(html).toContain("Math.min(ratioWidth, ratioHeight)");
    expect(html).toContain("wrapper.querySelectorAll(&quot;iframe&quot;)");
    expect(html).toContain("setAttribute(&quot;scrolling&quot;, &quot;no&quot;)");
    expect(html).toContain("setProperty(&quot;overflow&quot;, &quot;hidden&quot;, &quot;important&quot;)");
    expect(html).toContain("setProperty(&quot;scrollbar-width&quot;, &quot;none&quot;, &quot;important&quot;)");
    expect(html).toContain("Real Meta ad preview");
    expect(html).toContain("Meta preview - mobile feed standard");
    expect(html).not.toContain("creative-evidence-phone-surface");
    expect(html).not.toContain("creative-evidence-preview-overlay");
  });

  it("opens with an unavailable evidence state when card evidence is missing", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({
          reason: null,
          spend: null,
          roas: null,
          cpa: null,
          purchases: null,
          ctr: null,
          addToCart: null,
          frequency: null,
          fatigue: null,
          bestPlacement: null,
          placementList: null,
        })}
        {...noopProps}
      />,
    );

    expect(html).toContain("Evidence unavailable");
    expect(html).toContain("missing evidence fields");
    expect(html).toContain("creative-evidence-preview-slot");
    expect(html).not.toContain("creative-evidence-phone");
  });

  it("renders only server-supplied decisionCenter row fields when present", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({ decisionCenterRow: decisionCenterRow() })}
        {...noopProps}
      />,
    );

    expect(html).toContain("Decision Center");
    expect(html).toContain("Scale review");
    expect(html).toContain("Server supplied V2.1 decision.");
    expect(html).toContain("decision center - creative-decision-os.v2.1");
    expect(html).not.toContain("shadow surface");
    expect(html).toContain("buyerAction scale - execution promote_to_main");
    expect(html).toContain("sourceDecision v3:scale");
    expect(html).toContain("Queue false - apply false");
    expect(html).toContain("engine queue false - apply false");
  });

  it("renders server-supplied automation readiness instead of stale missing-field copy", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({
          automationReadiness: {
            contractVersion: "meta-automation-readiness.v1",
            tier: "read_only",
            autoExecuteEligible: false,
            operatorReviewRequired: true,
            decisionLabel: "scale",
            blockers: ["no_empirical_outcome_model", "missing_live_preflight"],
            missingEvidence: ["creative_empirical_outcome_model"],
            requiredEvidence: ["creative_empirical_outcome_model"],
            reason: "Creative-side automation evidence not yet implemented.",
          },
        })}
        {...noopProps}
      />,
    );

    expect(html).toContain("Tier: read only");
    expect(html).toContain("Creative-side automation evidence not yet implemented.");
    expect(html).toContain(
      "blocked by no_empirical_outcome_model, missing_live_preflight",
    );
    expect(html).not.toContain(
      "Creative briefing does not currently carry an automationReadiness field.",
    );
  });

  it("hides when closed", () => {
    expect(
      renderDrawer(
        <CreativeEvidenceDrawer open={false} card={card()} {...noopProps} />,
      ),
    ).toBe("");
  });
});

describe("Decision basis section", () => {
  it("renders server-supplied targetRoas, truthSource, and predicate blockers", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({
          targetRoas: 2.2,
          ratioToTarget: 0.7,
          truthSource: "commercial_truth",
          blockers: [
            {
              predicate: "min_spend",
              observed: 120,
              threshold: 300,
              status: "failed",
              severity: "warning",
              reason: "Spend below hard-action floor.",
            },
          ],
        })}
        {...noopProps}
      />,
    );

    expect(html).toContain("Decision basis");
    expect(html).toContain("Target ROAS 2.20");
    expect(html).toContain("Creative is at 70% of target");
    expect(html).toContain("Truth source: Commercial Truth");
    expect(html).toContain("Blocker: Min Spend (failed)");
    expect(html).toContain("Spend below hard-action floor.");
    expect(html).toContain("observed 120 - threshold 300");
  });

  it("hides every decision-origin Launchpad control for a held canonical card", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({
          label: "test_more",
          blockedActionType: "cut",
          primary: { kind: "review", label: "Await recent evidence" },
          canonicalDecision: {
            classification: {
              decisionState: "blocked",
              buyerAction: null,
              buyerLabel: "Cut pending",
              executionAction: null,
              heldAction: "cut",
            },
            sourceAuthority: {
              status: "native_exact",
              actionEligible: false,
              authorizedAction: null,
            },
          } as never,
        })}
        {...noopProps}
      />,
    );

    expect(html).not.toContain("Add to existing");
    expect(html).not.toContain("lucide-test-tube-2");
    expect(html).not.toContain('class="btn btn--primary"');
    expect(html).not.toContain(">Fresh test<");
    expect(html).not.toContain(">Test More<");
    expect(html).toContain("Cut pending");
    expect(html).toContain("Defer");
  });

  it("renders the server-supplied pre-authority verdict and first blocker without deriving action", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({
          label: "keep",
          preAuthorityLabel: "scale",
          authorityBlocker: "source_freshness",
        })}
        {...noopProps}
      />,
    );

    expect(html).toContain("Mathematical / semantic verdict: Scale");
    expect(html).toContain("never grants a provider action by itself");
    expect(html).toContain("First authority blocker: Source Freshness");
  });

  it("omits the section entirely when the payload has none of the fields", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({ targetRoas: null, truthSource: null, blockers: null })}
        {...noopProps}
      />,
    );
    expect(html).not.toContain("Decision basis");
  });
});

describe("pending transition surface", () => {
  it("renders the held-decision row from server hysteresis fields", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({ label: "cut", rawLabel: "keep", pendingTransition: true })}
        {...noopProps}
      />,
    );
    expect(html).toContain("Pending transition - held at previous decision");
    expect(html).toContain("raw engine signal");
    expect(html).toContain("keep");
  });

  it("omits the row when the decision is not held", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({ pendingTransition: false, rawLabel: null })}
        {...noopProps}
      />,
    );
    expect(html).not.toContain("Pending transition - held");
  });
});

describe("decision history section", () => {
  it("renders server-supplied label changes with realized outcomes", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({
          decisionHistory: [
            {
              date: "2026-07-04",
              previousLabel: "keep",
              currentLabel: "cut",
              realizedOutcome7d: "positive",
            },
            {
              date: "2026-07-02",
              previousLabel: null,
              currentLabel: "keep",
              realizedOutcome7d: null,
            },
          ],
        })}
        {...noopProps}
      />,
    );
    expect(html).toContain("Decision history (30d)");
    expect(html).toContain("2026-07-04: keep");
    expect(html).toContain("7d realized outcome: positive");
    expect(html).toContain("(first)");
    expect(html).toContain("window not closed or not computed");
  });

  it("omits the section without history", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer open card={card({ decisionHistory: null })} {...noopProps} />,
    );
    expect(html).not.toContain("Decision history (30d)");
  });

  it("renders the key-metrics hero strip with tabular numerals when metrics exist", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer open card={card()} {...noopProps} />,
    );
    expect(html).toContain("creative-evidence-keymetrics");
    expect(html).toContain("2.74×");
    expect(html).toContain("tabular-nums");
  });

  it("shows an em dash, never a fabricated zero, for missing key metrics", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({ roas: null, cpa: null, spend: 1240, purchases: 11 })}
        {...noopProps}
      />,
    );
    expect(html).toContain("creative-evidence-keymetrics");
    expect(html).toContain("—");
    expect(html).not.toContain("0.00×");
  });
});
