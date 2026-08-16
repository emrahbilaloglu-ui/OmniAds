/**
 * The body renders the reference anatomy, from the server presentation only.
 *
 * Server-rendered on purpose: the assertions then describe what a person
 * actually receives, not what a hook would have produced given time.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { DecisionCenterBody } from "@/components/meta/decision-center/DecisionCenterBody";
import type { MetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-contract";

function node(over: Record<string, unknown> = {}) {
  return {
    id: "n1",
    sourceRecommendationId: null,
    level: "campaign",
    providerEntityId: "123",
    campaignId: "c1",
    campaignName: "Prospecting",
    name: "Prospecting — Broad US",
    budgetOwner: "campaign",
    budgetMode: "campaign_budget",
    controlOwner: "campaign",
    status: "ACTIVE",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    action: {
      code: "scale_budget",
      label: "Scale budget +20%",
      intent: "launchpad",
      targetLevel: "campaign",
      providerMutation: null,
      scopeNote: "Executes as a routed Launchpad write with confirmation",
    },
    lane: "act",
    priority: "high",
    urgency: "now",
    confidence: "high",
    assessment: "ROAS above target on stable spend",
    whyNow: "ROAS at or above target for 12 consecutive days",
    expectedImpact: "$8.6k upside/mo",
    evidence: [{ label: "ROAS", value: "5.12", tone: "positive" }],
    metrics: {
      spend: 1240,
      purchases: 138,
      roas: 5.12,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: 3.8,
      ratioToTarget: 1.35,
      currency: "USD",
      attribution: "meta_attributed",
      grain: "campaign_or_adset",
    },
    suppressedAlternativeCount: 0,
    ...over,
  };
}

function presentation(over: Record<string, unknown> = {}): MetaOsDecisionsPresentation {
  return {
    contractVersion: "meta-os-decisions-presentation.v2",
    generatedAt: "2026-08-16T00:00:00.000Z",
    source: {
      snapshotAsOf: "2026-08-14",
      engineVersion: "v3.2",
      structureSource: "meta_recommendations",
      adsSource: "native_ad_decision",
      health: "healthy",
      fallbackReason: null,
    },
    structure: {
      groups: [{ id: "g1", campaign: node(), adsets: [], highestPriority: "high", highestUrgency: "now", urgentAdsetCount: 0 }],
      actCount: 4,
      blockedCount: 2,
      monitorCount: 7,
      suppressedAlternativeCount: 0,
    },
    ads: { items: [], actCount: 3, blockedCount: 1, monitorCount: 5, statePreCapCounts: { act: 3, blocked: 1, monitor: 5 } },
    ...over,
  } as unknown as MetaOsDecisionsPresentation;
}

function render(over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <DecisionCenterBody
      presentation={presentation(over)}
      accountLabel="Ad account 2841…09"
      currency="USD"
      windowLabel="Last 28 days"
      lastSyncLabel="12m ago"
      canRunSnapshot
    />,
  );
}

describe("the Decision Center body", () => {
  it("names itself and states the snapshot, engine and account it is reading", () => {
    const html = render();
    expect(html).toContain("Decision Center");
    expect(html).toContain("Ad account 2841…09");
    expect(html).toContain("snapshot 2026-08-14");
    expect(html).toContain("engine v3.2");
  });

  /**
   * The single most confusable thing on this surface: the date picker scopes
   * metrics, while the queue comes from the snapshot. The header says so.
   */
  it("says in words that the window scopes metrics and not decisions", () => {
    expect(render()).toContain("scopes metrics, not decisions");
  });

  it("carries both layer tabs with the server's act counts", () => {
    const html = render();
    expect(html).toContain("Campaigns &amp; Ad sets");
    expect(html).toContain("Creatives");
    expect(html).toContain(">4<");
    expect(html).toContain(">3<");
  });

  it("shows the queue filters with server counts, not a recount of the cards", () => {
    const html = render();
    expect(html).toContain('data-testid="decision-center-queue-act"');
    expect(html).toContain('data-testid="decision-center-queue-monitor"');
    expect(html).toContain('data-testid="decision-center-queue-blocked"');
    // One card is rendered; the queue still reports the server's 4.
    expect((html.match(/data-testid="decision-center-card"/g) || []).length).toBe(1);
  });

  it("renders the decision with the server's verdict as its command", () => {
    const html = render();
    expect(html).toContain("Prospecting — Broad US");
    expect(html).toContain("Scale budget +20%");
    expect(html).toContain('data-testid="decision-center-command"');
    expect(html).toContain("high confidence");
  });

  it("opens the evidence inspector on the decision contract, naming the server as the author", () => {
    const html = render();
    expect(html).toContain('data-testid="decision-center-evidence"');
    expect(html).toContain("Server verdict:");
    expect(html).toContain("The UI never\ncomputes this action.".replace(/\n/, " "));
    expect(html).toContain("routed Launchpad write with confirmation");
  });

  it("offers Run snapshot and New campaign", () => {
    const html = render();
    expect(html).toContain('data-testid="decision-center-run-snapshot"');
    expect(html).toContain('data-testid="decision-center-new-campaign"');
  });

  /**
   * A withheld command must stay withheld. The server sets `intent: "none"`
   * when it will not route an action, and the card then states the label
   * without offering a button that would do nothing.
   */
  it("does not offer a button when the server withheld the command", () => {
    const html = render({
      structure: {
        groups: [
          {
            id: "g1",
            campaign: node({ action: { code: "review", label: "Review setup", intent: "none", targetLevel: "campaign", providerMutation: null, scopeNote: "Review only" } }),
            adsets: [],
            highestPriority: "high",
            highestUrgency: "now",
            urgentAdsetCount: 0,
          },
        ],
        actCount: 1,
        blockedCount: 0,
        monitorCount: 0,
        suppressedAlternativeCount: 0,
      },
    });
    expect(html).toContain("Review setup");
    expect(html).not.toContain('data-testid="decision-center-command"');
  });

  it("surfaces a degraded source rather than presenting it as healthy", () => {
    const html = render({
      source: {
        snapshotAsOf: "2026-08-14",
        engineVersion: "v3.2",
        structureSource: "meta_recommendations",
        adsSource: "legacy_creative_review_only",
        health: "degraded",
        fallbackReason: "source_read_failed",
      },
    });
    expect(html).toContain("degraded");
    expect(html).toContain("source_read_failed");
    expect(html).toContain("legacy creative · review only");
  });
});

describe("the Decision Center header KPI strip", () => {
  function renderWithPulse() {
    return renderToStaticMarkup(
      <DecisionCenterBody
        presentation={presentation()}
        accountLabel="Ad account 2841…09"
        currency="USD"
        windowLabel="Last 28 days"
        windowShortLabel="28D"
        pulse={{
          pacing: { spendToday: 4120, avg7dSpend: 3887, conversionsToday: 138, avg7dConversions: 129 },
          roas: { selected: 4.26, d28: 4.26, target: 3.8 },
          roasHistory: [3.9, 4.05, 4.26],
          labelCoverage: { activeCampaigns: 22, labeledCampaigns: 18 },
          operatingMode: "standard",
          seasonalRegime: "high_season",
          trackingHealth: { status: "healthy", detail: "ok" },
        }}
        snapshotHealth={{ status: "fresh", ageHours: 2 }}
        lastSyncLabel="12m ago"
        canRunSnapshot
      />,
    );
  }

  it("renders all five reference tiles from the account pulse", () => {
    const html = renderWithPulse();
    for (const key of ["spend", "roas", "snapshot", "labels", "mode"]) {
      expect(html).toContain(`data-testid="decision-center-kpi-${key}"`);
    }
  });

  it("shows the measured figures rather than the queue counts", () => {
    const html = renderWithPulse();
    expect(html).toContain("4.26");
    expect(html).toContain("target 3.80");
    expect(html).toContain("18/22");
    expect(html).toContain("138 conversions");
    expect(html).toContain("Tracking OK");
  });

  /**
   * A read-only viewer's missing buttons and an engine-withheld command look
   * identical on screen. Only one of them is about permissions, and the banner
   * is what tells them apart.
   */
  it("states a downgrade reason when the server marked the viewer read-only", () => {
    const html = renderToStaticMarkup(
      <DecisionCenterBody
        presentation={presentation()}
        accountLabel={null}
        currency="USD"
        windowLabel={null}
        lastSyncLabel={null}
        readOnlyReason="Your workspace role is Guest: write controls are downgraded to review."
        canRunSnapshot={false}
      />,
    );
    expect(html).toContain('data-testid="decision-center-state-banner"');
    expect(html).toContain("workspace role is Guest");
  });

  /**
   * The canonical read failing returns cards-less success, not an error. Left
   * unlabelled the queue below would read as a clean slate.
   */
  it("labels an unavailable canonical read instead of showing a clean slate", () => {
    const html = renderToStaticMarkup(
      <DecisionCenterBody
        presentation={presentation()}
        accountLabel={null}
        currency="USD"
        windowLabel={null}
        lastSyncLabel={null}
        unavailableReason="The account-scoped decision sources could not be read."
        canRunSnapshot={false}
      />,
    );
    expect(html).toContain("Canonical decisions unavailable");
    expect(html).toContain("nothing was read, not that nothing");
  });
});

describe("the evidence inspector's header chip", () => {
  /**
   * `action.code` is a routing key for the command router
   * (`route_launchpad_duplicate`, `review_drill`); `action.label` is the
   * server's operator-facing wording. Rendering the code put implementation
   * jargon directly above the panel's own "Server verdict: <label>" line,
   * where the two then disagreed about the same decision.
   */
  it("shows the server's operator-facing label, never the routing code", () => {
    const html = renderToStaticMarkup(
      <DecisionCenterBody
        presentation={presentation({
          structure: {
            groups: [
              {
                id: "g1",
                campaign: node({
                  action: {
                    code: "route_launchpad_duplicate",
                    label: "Duplicate into EU",
                    intent: "launchpad",
                    targetLevel: "campaign",
                    providerMutation: null,
                    scopeNote: "Routed Launchpad write with confirmation",
                  },
                }),
                adsets: [],
                highestPriority: "high",
                highestUrgency: "now",
                urgentAdsetCount: 0,
              },
            ],
            actCount: 1,
            blockedCount: 0,
            monitorCount: 0,
            suppressedAlternativeCount: 0,
          },
        })}
        accountLabel={null}
        currency="USD"
        windowLabel={null}
        lastSyncLabel={null}
        canRunSnapshot={false}
      />,
    );
    expect(html).toContain("Duplicate into EU");
    expect(html).not.toContain("route_launchpad_duplicate");
    expect(html).not.toContain("route launchpad duplicate");
  });
});
