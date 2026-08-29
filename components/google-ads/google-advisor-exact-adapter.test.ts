import { describe, expect, it } from "vitest";

import type {
  GoogleAdvisorActionCard,
  GoogleAdvisorResponse,
  GoogleRecommendation,
} from "@/lib/google-ads/growth-advisor-types";

import { buildGoogleAdvisorExactViewModel } from "./google-advisor-exact-adapter";
import { SYNC_AGE_UNKNOWN_LABEL } from "@/lib/provider-sync-vocabulary";

function actionCard(
  overrides: Partial<GoogleAdvisorActionCard> = {},
): GoogleAdvisorActionCard {
  return {
    contractVersion: "google_ads_advisor_action_v2",
    contractSource: "native",
    assistMode: "deterministic",
    recommendationType: "query_governance",
    primaryAction: "Add the two exact negatives now.",
    scope: {
      level: "campaign",
      label: "Search — Non-brand · exact match",
      governedEntityCount: 1,
    },
    exactChanges: [
      {
        label: "Add exact negatives now",
        items: ["refund policy", "free shipping code"],
        kind: "change",
        tone: "primary",
      },
    ],
    exactChangePayload: {
      kind: "generic_manual_action",
      recommendedAction: "Add the two exact negatives now.",
    },
    expectedEffect: {
      summary: "Waste recovery at current click prices.",
      estimationMode: "bounded_range",
      estimateLabel: "Waste recovery: $180–$320/mo",
      note: "Bounded by the native contract.",
    },
    whyThisNow: "Zero-conversion terms concentrate on these two stems.",
    evidence: [],
    validation: ["Zero-conversion spend falls to $0 within 14 days."],
    rollback: ["Delete the two negatives — no learning reset."],
    blockedBecause: [],
    ...overrides,
  };
}

function recommendation(
  id: string,
  overrides: Partial<GoogleRecommendation> = {},
): GoogleRecommendation {
  return {
    id,
    type: "query_governance",
    doBucket: "do_now",
    confidence: "high",
    integrityState: "ready",
    actionability: "ready_now",
    decision: {
      riskLevel: "low",
      blockers: [],
    },
    blockers: [],
    operatorActionCard: actionCard(),
    ...overrides,
  } as GoogleRecommendation;
}

function response(
  recommendations: GoogleRecommendation[],
  asOfDate: string | null = "2026-08-17",
): GoogleAdvisorResponse {
  return {
    summary: {},
    recommendations,
    sections: [],
    clusters: [],
    metadata: asOfDate === null ? undefined : { asOfDate },
  } as unknown as GoogleAdvisorResponse;
}

describe("buildGoogleAdvisorExactViewModel", () => {
  it("keeps every recommendation in server order without type filtering", () => {
    const native = recommendation("native");
    const compatibility = recommendation("compatibility", {
      type: "budget_reallocation",
      doBucket: "do_next",
      operatorActionCard: actionCard({ contractSource: "compatibility_derived" }),
    });
    const missing = recommendation("missing", {
      type: "creative_asset_deployment",
      doBucket: "do_later",
      operatorActionCard: null,
    });

    const view = buildGoogleAdvisorExactViewModel(response([native, compatibility, missing]));

    expect(view.cards.map((card) => card.id)).toEqual(["native", "compatibility", "missing"]);
    expect(view.cards[1]).toMatchObject({
      type: "Budget reallocation",
      action: "—",
      scope: "—",
      mode: "—",
      money: "—",
      effect: "—",
      why: "—",
      validation: "—",
      last: "—",
      nativeActionContract: false,
      navigationKind: "unsupported",
    });
    expect(view.cards[1].changes).toEqual([{ label: "—", items: ["—"], tone: "muted" }]);
    expect(view.cards[2]).toMatchObject({ bucket: "—", action: "—", nativeActionContract: false });
  });

  it("maps only native action-card fields into the exact card anatomy", () => {
    const native = recommendation("budget", {
      type: "budget_reallocation",
      confidence: "medium",
      decision: { riskLevel: "medium" } as GoogleRecommendation["decision"],
      operatorActionCard: actionCard({
        recommendationType: "budget_reallocation",
        primaryAction: "Move $120/day into Search — Brand.",
        scope: {
          level: "campaign",
          label: "2 campaigns · previewed with exact budget amounts",
          governedEntityCount: 2,
        },
        exactChanges: [
          {
            label: "Source campaign",
            items: ["Shopping — Core feed: $180 → $60/day (−67%)"],
            kind: "change",
            tone: "danger",
          },
          {
            label: "Destination campaign",
            items: ["Search — Brand: $170 → $290/day (+71%)"],
            kind: "change",
            tone: "primary",
          },
        ],
        exactChangePayload: {
          kind: "budget_reallocation",
          sourceCampaigns: [],
          destinationCampaigns: [],
          budgetBand: "$120/day",
          estimateMode: "bounded_preview",
          netDelta: 0,
        },
        expectedEffect: {
          summary: "Recovers lost impression share.",
          estimationMode: "bounded_range",
          estimateLabel: "Revenue: +$0.9k/mo",
          note: "Native bounded preview.",
        },
        whyThisNow: "Brand is budget constrained while Shopping is below breakeven.",
        validation: ["Brand IS reaches 85%.", "CPC does not inflate."],
        rollback: ["Restore both daily budgets."],
      }),
    });

    const card = buildGoogleAdvisorExactViewModel(response([native])).cards[0];

    expect(card).toMatchObject({
      bucket: "Do now",
      type: "Budget reallocation",
      mode: "bounded preview",
      modeTone: "positive",
      money: "+$0.9k/mo",
      action: "Move $120/day into Search — Brand.",
      scope: "2 campaigns · previewed with exact budget amounts",
      effect: "Recovers lost impression share.",
      why: "Brand is budget constrained while Shopping is below breakeven.",
      validation: "Brand IS reaches 85%. · CPC does not inflate.",
      lastLabel: "Rollback",
      last: "Restore both daily budgets.",
      confidence: "medium confidence · medium risk · blast radius: 2 campaigns · contract v2 · native",
      navigationKind: "plan",
    });
    expect(card.changes.map((change) => change.label)).toEqual([
      "Source campaign",
      "Destination campaign",
    ]);
  });

  it("counts only applied execution records with an authoritative 30-day timestamp", () => {
    const manuallyMarked = recommendation("manual", {
      userAction: "applied",
      appliedAt: "2026-08-10T09:00:00.000Z",
      executionStatus: "not_started",
      executedAt: null,
    });
    const receipted = recommendation("receipted", {
      executionStatus: "applied",
      executedAt: "2026-08-12T09:00:00.000Z",
    });
    const appliedTimestampFallback = recommendation("applied-fallback", {
      executionStatus: "applied",
      executedAt: null,
      appliedAt: "2026-08-11T09:00:00.000Z",
    });
    const oldReceipt = recommendation("old", {
      executionStatus: "applied",
      executedAt: "2026-06-01T09:00:00.000Z",
    });

    const view = buildGoogleAdvisorExactViewModel(
      response([manuallyMarked, receipted, appliedTimestampFallback, oldReceipt]),
      { accountId: "493-118-2201", currencyCode: "USD", windowLabel: "28d" },
    );

    expect(view.eyebrow).toBe("Google Ads · 493-118-2201 · USD · 28d window");
    expect(view.tiles.map((tile) => [tile.label, tile.value, tile.sub])).toEqual([
      ["Do now", "4", "ranked by money at stake"],
      ["Do next", "0", "this week"],
      ["Blocked", "0", "feed fix first"],
      ["Applied · 30d", "2", "guarded writes · receipted"],
    ]);
  });

  it("derives blocked state from blockers, integrity, or explicit current status and never double-counts lanes", () => {
    const byBlocker = recommendation("by-blocker", {
      doBucket: "do_now",
      blockers: ["feed blocker"],
    });
    const byIntegrity = recommendation("by-integrity", {
      doBucket: "do_next",
      integrityState: "blocked",
    });
    const byStatus = recommendation("by-status", {
      doBucket: "do_now",
      currentStatus: "blocked" as GoogleRecommendation["currentStatus"],
    });

    const view = buildGoogleAdvisorExactViewModel(
      response([byBlocker, byIntegrity, byStatus]),
    );

    expect(view.cards.every((card) => card.blocked)).toBe(true);
    expect(view.cards.every((card) => card.navigationKind === "unsupported")).toBe(true);
    expect(view.tiles.map((tile) => tile.value)).toEqual(["0", "0", "3", "0"]);
  });

  it("keeps insufficient-evidence watch cards out of Blocked and disables unsupported navigation", () => {
    const insufficient = recommendation("insufficient", {
      doBucket: "do_next",
      actionability: "not_ready",
      operatorActionCard: actionCard({
        primaryAction: "Hold this as a watch item.",
        exactChangePayload: {
          kind: "blocked_or_insufficient_evidence",
          state: "insufficient_evidence",
          reasons: ["No deterministic exact-change fields are attached."],
        },
        expectedEffect: {
          summary: "No effect estimate is supported.",
          estimationMode: "not_confidently_estimable",
          estimateLabel: null,
          note: "Watch only.",
        },
        blockedBecause: [],
      }),
    });

    const view = buildGoogleAdvisorExactViewModel(response([insufficient]));

    expect(view.cards[0]).toMatchObject({
      blocked: false,
      bucket: "Do next",
      mode: "—",
      navigationKind: "unsupported",
    });
    expect(view.tiles.map((tile) => tile.value)).toEqual(["0", "1", "0", "0"]);
  });

  it("opens Products only for product allocation and never relabels blocker reasons as an unblock path", () => {
    const blockedQuery = recommendation("blocked-query", {
      blockers: ["query ownership is unresolved"],
      operatorActionCard: actionCard({
        expectedEffect: {
          summary: "Blocked.",
          estimationMode: "blocked",
          estimateLabel: null,
          note: "Blocked.",
        },
        blockedBecause: ["query ownership is unresolved"],
      }),
    });
    const blockedProduct = recommendation("blocked-product", {
      type: "product_allocation",
      integrityState: "blocked",
      operatorActionCard: actionCard({
        recommendationType: "product_allocation",
        exactChanges: [
          {
            label: "Blocked because",
            items: ["feed disapproval"],
            kind: "blocker",
            tone: "danger",
          },
          {
            label: "Unblock path",
            items: ["Resolve the disapproval in Merchant Center."],
            kind: "informational",
            tone: "default",
          },
        ],
        exactChangePayload: {
          kind: "product_allocation",
          isolateClusters: [],
          scaleClusters: [],
          reduceClusters: [],
          hiddenWinnerClusters: [],
        },
        expectedEffect: {
          summary: "Blocked.",
          estimationMode: "blocked",
          estimateLabel: null,
          note: "Blocked.",
        },
        blockedBecause: ["feed disapproval"],
      }),
    });

    const view = buildGoogleAdvisorExactViewModel(
      response([blockedQuery, blockedProduct]),
    );

    expect(view.cards[0]).toMatchObject({
      blocked: true,
      lastLabel: "Unblock path",
      last: "—",
      navigationKind: "unsupported",
    });
    expect(view.cards[1]).toMatchObject({
      blocked: true,
      last: "Resolve the disapproval in Merchant Center.",
      navigationKind: "products",
    });
  });

  it("uses an em dash when the applied-receipt reference date is unsupported", () => {
    const view = buildGoogleAdvisorExactViewModel(response([], null));
    expect(view.tiles[3].value).toBe("—");
  });

  it("keeps unavailable payload counts unknown instead of fabricating measured zeros", () => {
    const view = buildGoogleAdvisorExactViewModel(null, {
      accountId: "493-118-2201",
      currencyCode: "USD",
      windowLabel: "28d",
    });

    expect(view.tiles.map((tile) => tile.value)).toEqual(["—", "—", "—", "—"]);
    expect(view.cards).toEqual([]);
    // An absent sync label must not claim a completed sync.
    expect(view.syncLabel).toBe(SYNC_AGE_UNKNOWN_LABEL);
    expect(view.syncLabel).not.toContain("Synced");
  });

  it("passes a real sync label through untouched", () => {
    const view = buildGoogleAdvisorExactViewModel(null, {
      accountId: "493-118-2201",
      currencyCode: "USD",
      windowLabel: "28d",
      syncLabel: "Synced 26m ago",
    });

    expect(view.syncLabel).toBe("Synced 26m ago");
  });

  it("omits suppressed rows overlaid onto a cached snapshot from the active exact list", () => {
    const active = recommendation("active");
    const suppressed = recommendation("suppressed", {
      currentStatus: "suppressed",
      userAction: "dismissed",
    });
    const dismissed = recommendation("dismissed", {
      currentStatus: "persistent",
      userAction: "dismissed",
    });

    const view = buildGoogleAdvisorExactViewModel(
      response([active, suppressed, dismissed]),
    );

    expect(view.cards.map((card) => card.id)).toEqual(["active"]);
    expect(view.tiles[0].value).toBe("1");
  });
});
