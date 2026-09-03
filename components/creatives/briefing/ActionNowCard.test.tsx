import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionNowCard } from "@/components/creatives/briefing/ActionNowCard";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

function card(overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: "cr_1",
    name: "Aphrodite Necklace Hook v3",
    brand: "TheSwaf",
    campaign: "ASC | Worldwide | Sales",
    adset: "AdSet | Worldwide | 25-44 | Advantage+",
    label: "scale",
    confidence: 88,
    reason: "ROAS above target with stable frequency.",
    predictive: "If applied: expected 28d ROAS drift 3.10x - 3.25x",
    spend: 4210,
    roas: 3.42,
    ctr: 1.84,
    cpa: 14.2,
    purchases: 297,
    frequency: 1.6,
    fatigue: false,
    sparkline: [2.1, 2.4, 2.9, 3.2, 3.42],
    ctrFunnel: { value: 1.84, p50: 1.1 },
    primary: { kind: "promote", label: "Promote to main" },
    status: "ACTIVE",
    ageDays: 34,
    ...overrides,
  };
}

function canonicalActionCard(
  action: "cut" | "scale" | "refresh",
  overrides: Partial<BriefingCreativeCard> = {},
): BriefingCreativeCard {
  const executionAction =
    action === "scale" ? "promote_to_main" : null;
  return card({
    id: "ad_1",
    realAdId: "ad_1",
    providerAccountId: "act_1",
    creativeId: "cr_1",
    label: action,
    authorityBlocker: null,
    blockedActionType: null,
    primary:
      action === "cut"
        ? { kind: "cut", label: "Cut" }
        : action === "scale"
          ? { kind: "review", label: "Review scale evidence" }
          : { kind: "review", label: "Review refresh evidence" },
    sourceDecisionSnapshotId: "snapshot_1",
    sourceDecisionSnapshotMatch: "matched",
    sourceDecisionAuthorityStatus: "native_exact",
    sourceDecisionEvaluationId: "evaluation_1",
    sourceDecisionSnapshotEngineVersion: "native_engine_1",
    sourceDecisionInputHash: "1".repeat(64),
    sourceDecisionHash: "2".repeat(64),
    sourceDecisionProviderAccountRefId: "provider_ref_1",
    sourceDecisionJobRunId: "job_1",
    sourceDecisionAuthorizedAction: action,
    sourceDecisionActionEligible: true,
    canonicalDecision: {
      contractVersion: "briefing-canonical-native-ad.v1",
      identityGrain: "ad",
      decisionId: "decision_1",
      episodeId: "episode_1",
      sourceSnapshotId: "snapshot_1",
      adId: "ad_1",
      creativeId: "cr_1",
      identityResolution: {
        basis: "native_ad_exact",
        adActionEligible: true,
      },
      classification: {
        decisionState: "act",
        buyerAction: action,
        buyerLabel:
          action === "cut" ? "Cut" : action === "scale" ? "Scale" : "Refresh",
        executionAction,
        heldAction: null,
      },
      sourceDecision: {
        label: action,
        authorityBlocker: null,
        confidence: 0.9,
        reason: `Canonical ${action} decision.`,
        snapshotAsOf: "2026-07-18",
        computedAt: "2026-07-18T03:00:00.000Z",
      },
      sourceAuthority: {
        status: "native_exact",
        snapshotId: "snapshot_1",
        evaluationId: "evaluation_1",
        inputHash: "1".repeat(64),
        decisionHash: "2".repeat(64),
        engineVersion: "native_engine_1",
        providerAccountRefId: "provider_ref_1",
        providerAccountId: "act_1",
        realAdId: "ad_1",
        jobRunId: "job_1",
        authorizedAction: action,
        actionEligible: true,
        reviewOnlyReason: null,
        executionReadiness: "live_preflight_required",
      },
    },
    ...overrides,
  });
}

describe("ActionNowCard", () => {
  it("renders the tile shell with name, primary action, metrics, confidence pill, and select control", () => {
    const html = renderToStaticMarkup(<ActionNowCard card={card()} selected />);

    expect(html).toContain("Aphrodite Necklace Hook v3");
    expect(html).toContain("ccard-tile");
    expect(html).toContain("tile-thumb");
    expect(html).toContain('aria-label="Open evidence for Aphrodite Necklace Hook v3"');
    expect(html).toContain("creative-evidence-trigger--media");
    expect(html).toContain("creative-evidence-trigger--name");
    expect(html).toContain("data-media-shape=\"feed\"");
    expect(html).toContain(">4:5<");
    expect(html).toContain("tile-metrics");
    expect(html).toContain("Promote to main");
    // D074b correction: a card without a validated canonical decision can
    // never be executable — the bridge no longer derives Launchpad authority
    // from primary kinds, labels, or a missing blockedActionType.
    expect(html).toContain('data-executable="false"');
    expect(html).toContain("What does Defer 24h do?");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("ring-2 ring-blue-500 ring-offset-1");
  });

  it("renders cut actions as destructive primary controls", () => {
    const cutHtml = renderToStaticMarkup(
      <ActionNowCard
        card={canonicalActionCard("cut")}
      />,
    );

    expect(cutHtml).toContain("btn--danger");
    expect(cutHtml).toContain('data-kind="cut"');
    expect(cutHtml).toContain('data-executable="true"');
    expect(cutHtml).toContain("Cut");
  });

  it.each([
    {
      action: "scale",
      stalePrimary: { kind: "promote", label: "Promote to main" },
      reviewLabel: "Open canonical evidence",
      forbiddenLabel: "Promote to main",
    },
    {
      action: "refresh",
      stalePrimary: { kind: "fresh_test", label: "Launch fresh test" },
      reviewLabel: "Open canonical evidence",
      forbiddenLabel: "Launch fresh test",
    },
  ] as const)(
    "renders canonical $action as review evidence with an explicit non-executable contract",
    ({ action, stalePrimary, reviewLabel, forbiddenLabel }) => {
      const html = renderToStaticMarkup(
        <ActionNowCard
          card={canonicalActionCard(action, { primary: stalePrimary })}
        />,
      );

      expect(html).toContain(reviewLabel);
      expect(html).toContain('data-kind="review"');
      expect(html).toContain('data-executable="false"');
      expect(html).not.toContain("btn--danger");
      expect(html).not.toContain(forbiddenLabel);
    },
  );

  it("renders deferred chip and cut-removing classes", () => {
    const deferredHtml = renderToStaticMarkup(<ActionNowCard card={card()} deferred />);
    const cuttingHtml = renderToStaticMarkup(<ActionNowCard card={card()} cutting />);

    expect(deferredHtml).toContain("opacity-60");
    expect(deferredHtml).toContain("Reappears tomorrow 9am ·");
    expect(deferredHtml).toContain('data-action="undefer"');
    expect(cuttingHtml).toContain("opacity-0 -translate-x-4 pointer-events-none");
  });

  it("a stale Decision Center row cannot surface a hard-action CTA on an unresolved/legacy card (D074b correction 2)", () => {
    const staleRow = {
      buyerAction: "scale",
      buyerLabel: "Scale - Promote to main",
      executionAction: "promote_to_main",
    } as never;
    // Pre-correction the row's executionAction overrode the primary label,
    // so this legacy-only card rendered "Promote to main" as its primary.
    // The server review primary must stand, unexecutable, review-kinded.
    const legacyHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          campaignKind: "test",
          campaignLabelStatus: "labeled",
          primary: { kind: "review", label: "Resolve campaign role before scaling" },
          decisionCenterRow: staleRow,
        })}
      />,
    );
    expect(legacyHtml).not.toContain("Promote to main");
    expect(legacyHtml).toContain("Resolve campaign role before scaling");
    expect(legacyHtml).toContain('data-kind="review"');
    expect(legacyHtml).toContain('data-executable="false"');
    expect(legacyHtml).toContain("Role unresolved");

    const missingHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          campaignKind: "test",
          primary: { kind: "review", label: "Resolve campaign role before scaling" },
          decisionCenterRow: staleRow,
        })}
      />,
    );
    expect(missingHtml).not.toContain("Promote to main");
    expect(missingHtml).toContain('data-executable="false"');

    // Resolved + agreeing kind keeps the execution display label — still
    // unexecutable (no canonical decision, Launchpad stays fail-closed).
    const resolvedHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          campaignKind: "test",
          campaignRoleStatus: "resolved",
          primary: { kind: "promote", label: "Promote to main" },
          decisionCenterRow: staleRow,
        })}
      />,
    );
    expect(resolvedHtml).toContain("Promote to main");
    expect(resolvedHtml).toContain('data-executable="false"');
  });

  it("displays Main/Test only under canonical resolved status; legacy-only or missing status renders Role unresolved", () => {
    // Canonical resolved status + kind: the only shape that may display a
    // trusted automatic role.
    const resolvedHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({ campaignKind: "main", campaignRoleStatus: "resolved" })}
      />,
    );
    expect(resolvedHtml).toContain(">Main<");
    expect(resolvedHtml).toContain("tile-chips");

    // Legacy-only "labeled" is manual-era provenance: pre-correction this
    // rendered ">Main<" as trusted; it must render Role unresolved.
    const legacyHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({ campaignKind: "main", campaignLabelStatus: "labeled" })}
      />,
    );
    expect(legacyHtml).not.toContain(">Main<");
    expect(legacyHtml).toContain("Role unresolved");

    // Missing both statuses fails closed the same way.
    const missingHtml = renderToStaticMarkup(
      <ActionNowCard card={card({ campaignKind: "main" })} />,
    );
    expect(missingHtml).not.toContain(">Main<");
    expect(missingHtml).toContain("Role unresolved");
  });

  it("renders non-promote scale actions from the server without relabeling them", () => {
    const html = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          campaignKind: "main",
          campaignRoleStatus: "resolved",
          primary: { kind: "scale_budget", label: "Scale budget" },
        })}
      />,
    );

    expect(html).toContain("Scale budget");
    expect(html).toContain('data-kind="scale_budget"');
    expect(html).not.toContain("Promote to main");
  });

  it("renders the canonical held-action buyer label instead of inventing a fresh-test chip", () => {
    const html = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          label: "test_more",
          canonicalDecision: {
            classification: {
              decisionState: "review",
              buyerAction: "keep",
              buyerLabel: "Cut pending authority review",
              executionAction: null,
              heldAction: "cut",
            },
          } as never,
        })}
      />,
    );

    expect(html).toContain("Cut pending authority review");
    expect(html).not.toContain("Fresh test");
    expect(html).toContain('data-kind="review"');
    expect(html).toContain('data-executable="false"');
    expect(html).not.toContain('data-kind="promote"');
  });

  it("keeps video and carousel cards in their native media frames", () => {
    const videoHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          name: "Founder Story",
          format: "image",
          creativeVisualFormat: "video",
          creativePrimaryType: "video",
          creativePrimaryLabel: "Video",
          preview: {
            render_mode: "image",
            image_url: "https://example.com/poster.jpg",
            video_url: null,
            poster_url: "https://example.com/poster.jpg",
            source: "thumbnail_url",
            is_catalog: false,
          },
        })}
      />,
    );
    const carouselHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          name: "Product Set",
          creativeVisualFormat: "carousel",
          creativePrimaryType: "carousel",
          creativePrimaryLabel: "Carousel",
        })}
      />,
    );

    expect(videoHtml).toContain("data-media-shape=\"portrait\"");
    expect(videoHtml).toContain(">VID<");
    expect(videoHtml).toContain(">9:16<");
    expect(carouselHtml).toContain("data-media-shape=\"square\"");
    expect(carouselHtml).toContain(">CAR<");
    expect(carouselHtml).toContain(">1:1<");
  });
});

describe("execution action CTA", () => {
  const dcRow = (executionAction: string | null) =>
    ({
      scope: "creative",
      creativeId: "cr_1",
      identityGrain: "creative",
      buyerAction: "scale",
      buyerLabel: "Scale",
      uiBucket: "scale",
      executionAction,
      confidenceBand: "high",
      priority: "high",
      oneLine: "",
      reasons: [],
      nextStep: "",
      missingData: [],
    }) as never;

  it("renders the execution CTA only when the server current primary confirms the row (D074b corrections 2+3)", () => {
    const html = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          campaignRoleStatus: "resolved",
          campaignKind: "main",
          primary: { kind: "scale_budget", label: "Scale budget" },
          decisionCenterRow: dcRow("scale_budget"),
        })}
      />,
    );
    expect(html).toContain("Review scale budget");
    expect(html).not.toContain(">Scale budget ↗<");

    // Correction 3: resolved role + agreeing kind alone no longer suffice —
    // a server primary that is not the same scale CTA (here a generic
    // legacy "scale" kind) keeps its own label.
    const disagreeingHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          campaignRoleStatus: "resolved",
          campaignKind: "main",
          primary: { kind: "scale", label: "Legacy scale label" },
          decisionCenterRow: dcRow("scale_budget"),
        })}
      />,
    );
    expect(disagreeingHtml).not.toContain("Review scale budget");
    expect(disagreeingHtml).toContain("Legacy scale label");

    // Pre-correction-2 the same row rendered its CTA with no role at all.
    const ungroundedHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          primary: { kind: "scale", label: "Legacy scale label" },
          decisionCenterRow: dcRow("scale_budget"),
        })}
      />,
    );
    expect(ungroundedHtml).not.toContain("Review scale budget");
    expect(ungroundedHtml).toContain("Legacy scale label");
  });

  it("keeps the exact server review label over a stale row on a source-freshness block (D074b correction 3 probe)", () => {
    // The exact acceptance probe: current scale decision, resolved Test
    // role, source-freshness authority block, stale promote row. Correction
    // 2 rendered "Promote to main ↗" here, erasing "Refresh evidence".
    const html = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          label: "scale",
          campaignRoleStatus: "resolved",
          campaignKind: "test",
          authorityBlocker: "source_freshness",
          blockedActionType: "scale",
          primary: { kind: "review", label: "Refresh evidence" },
          decisionCenterRow: {
            buyerAction: "scale",
            buyerLabel: "Scale - Promote to main",
            executionAction: "promote_to_main",
          } as never,
        })}
      />,
    );
    expect(html).toContain("Refresh evidence");
    expect(html).not.toContain("Promote to main");
    expect(html).toContain('data-kind="review"');
    expect(html).toContain('data-executable="false"');
    // Interaction limitation, stated honestly: this harness renders static
    // markup, so the no-Launchpad click guarantee is carried by the
    // globally-false Launchpad bridge tests plus data-executable="false"
    // (the click path without a launchpad mode opens evidence).
  });

  it("never lets the execution CTA override a cut decision", () => {
    const html = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          label: "cut",
          primary: { kind: "cut", label: "Cut" },
          decisionCenterRow: dcRow("promote_to_main"),
        })}
      />,
    );
    expect(html).not.toContain("Promote to main");
    expect(html).toContain("Cut");
  });

  it("falls back to the legacy primary label without a decision-center row", () => {
    const html = renderToStaticMarkup(
      <ActionNowCard card={card({ decisionCenterRow: null })} />,
    );
    expect(html).toContain("Promote to main");
  });
});
