import { describe, expect, it } from "vitest";

import {
  DECISION_LANES,
  DEFAULT_LANE,
  decisionsHref,
  isSelectionServed,
  parseDecisionsUrlState,
  resetForContextChange,
  serializeDecisionsUrlState,
} from "@/lib/zero-base/meta/decisions-url-state";
import {
  actionCountFor,
  buildDecisionsViewModel,
  buildOsDecisionsViewModel,
  isHeld,
  orderedBanners,
  toDecisionRow,
} from "@/lib/zero-base/meta/decisions-presentation";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaDecisionsWorkspaceViewer, MetaLanePayload } from "@/components/meta/redesign/types";
import type { MetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-contract";

function recommendation(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "dec_1",
    level: "campaign",
    type: "campaign_state",
    lens: "profitability",
    priority: "high",
    confidence: "high",
    decisionState: "act",
    decision: "Scale up — 7-day ROAS above target",
    title: "Prospecting — Broad US",
    why: "7-day ROAS 3.4 against a target of 2.6.",
    summary: "",
    recommendedAction: "Raise the daily budget by 20%.",
    expectedImpact: "",
    evidence: [],
    timeframeContext: {} as MetaRecommendation["timeframeContext"],
    campaignName: "Prospecting — Broad US",
    ...overrides,
  } as MetaRecommendation;
}

function lane(rows: MetaRecommendation[], overrides: Partial<MetaLanePayload> = {}): MetaLanePayload {
  return {
    businessId: "biz_1",
    startDate: "2026-08-01",
    endDate: "2026-08-07",
    sourceModel: "v3",
    snapshotDate: "2026-08-07",
    snapshotCreatedAt: "2026-08-11T06:00:00Z",
    actionNow: rows,
    watching: [],
    healthy: [],
    nonSales: [],
    archive: [],
    deferredIds: [],
    counts: { actionNow: rows.length, watching: 0, healthy: 0, nonSales: 0, archive: 0 },
    ...overrides,
  } as MetaLanePayload;
}

const emptyState = { lane: "act" as const, levels: [], search: "", selected: null };

describe("URL state is total and restorable", () => {
  it("round-trips every filter and the selected row", () => {
    const state = {
      lane: "watch" as const,
      levels: ["campaign", "adset"] as Array<"campaign" | "adset">,
      search: "prospecting",
      selected: "dec_9",
    };
    const query = serializeDecisionsUrlState(state);
    expect(parseDecisionsUrlState(new URLSearchParams(query))).toEqual(state);
  });

  it("omits defaults so equivalent views produce the same URL", () => {
    expect(serializeDecisionsUrlState(emptyState)).toBe("");
    expect(decisionsHref("biz_1", emptyState)).toBe("/app/meta/decisions");
  });

  it("normalises level order, so two links to the same view match", () => {
    const a = parseDecisionsUrlState(new URLSearchParams("levels=adset,campaign"));
    const b = parseDecisionsUrlState(new URLSearchParams("levels=campaign,adset"));
    expect(a.levels).toEqual(b.levels);
    expect(serializeDecisionsUrlState(a)).toBe(serializeDecisionsUrlState(b));
  });

  it("falls back rather than throwing on a hand-edited URL", () => {
    const state = parseDecisionsUrlState(
      new URLSearchParams("lane=nonsense&levels=galaxy&row=%20%20"),
    );
    expect(state.lane).toBe(DEFAULT_LANE);
    expect(state.levels).toEqual([]);
    expect(state.selected).toBeNull();
  });

  it("refuses a selected id that is not id-shaped", () => {
    for (const row of ["../etc", "a b", "<script>", "x".repeat(200)]) {
      expect(parseDecisionsUrlState(new URLSearchParams(`row=${encodeURIComponent(row)}`)).selected).toBeNull();
    }
  });

  it("bounds the search term", () => {
    const long = "q".repeat(500);
    expect(parseDecisionsUrlState(new URLSearchParams(`q=${long}`)).search).toHaveLength(128);
  });

  it("parses every lane the surface offers", () => {
    for (const lane of DECISION_LANES) {
      expect(parseDecisionsUrlState(new URLSearchParams(`lane=${lane}`)).lane).toBe(lane);
    }
  });

  it("keeps Ad as a real server-owned decision level", () => {
    const state = parseDecisionsUrlState(new URLSearchParams("levels=ad,campaign"));
    expect(state.levels).toEqual(["campaign", "ad"]);
  });
});

function osPresentation(): MetaOsDecisionsPresentation {
  const action = {
    code: "review",
    label: "Review served decision",
    intent: "review" as const,
    targetLevel: "campaign" as const,
    providerMutation: null,
    scopeNote: "Review only.",
  };
  const node = (id: string, lane: "act" | "blocked" | "monitor") => ({
    id,
    sourceRecommendationId: id,
    level: "campaign" as const,
    providerEntityId: id,
    campaignId: id,
    campaignName: id,
    name: id,
    lifecycleRole: "main" as const,
    budgetOwner: "campaign" as const,
    budgetMode: "campaign_budget" as const,
    controlOwner: "campaign" as const,
    status: "ACTIVE",
    optimizationGoal: "PURCHASE",
    action,
    lane,
    priority: { band: "medium" as const, rank: 1, version: "meta-os-decisions.presentation.v5" as const },
    urgency: { level: "medium" as const, rank: 1, label: "Medium", reason: null },
    confidence: "high" as const,
    assessment: `${lane} assessment`,
    whyNow: `${lane} why`,
    expectedImpact: "Served impact",
    evidence: [],
    metrics: {
      spend: 10,
      purchases: 1,
      roas: 2,
      cpa: 10,
      ctr: 1,
      frequency: 1,
      effectiveTargetRoas: 2,
      ratioToTarget: 1,
      currency: "USD",
      attribution: "meta_attributed" as const,
      grain: "campaign_or_adset" as const,
    },
    suppressedAlternativeCount: 0,
  });
  return {
    contractVersion: "meta-os-decisions.presentation.v5",
    generatedAt: "2026-08-13T00:00:00Z",
    source: {
      snapshotAsOf: "2026-08-12",
      engineVersion: "v3",
      structureSource: "meta_recommendations",
      adsSource: "native_ad_decision",
    },
    structure: {
      groups: [
        { id: "g-act", campaign: node("active-campaign", "act"), adsets: [], highestPriority: node("x", "act").priority, highestUrgency: node("x", "act").urgency, urgentAdsetCount: 0 },
        { id: "g-blocked", campaign: node("blocked-campaign", "blocked"), adsets: [], highestPriority: node("x", "blocked").priority, highestUrgency: node("x", "blocked").urgency, urgentAdsetCount: 0 },
        { id: "g-monitor", campaign: node("monitor-campaign", "monitor"), adsets: [], highestPriority: node("x", "monitor").priority, highestUrgency: node("x", "monitor").urgency, urgentAdsetCount: 0 },
      ],
      actCount: 1,
      blockedCount: 1,
      monitorCount: 1,
      suppressedAlternativeCount: 0,
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
  } as MetaOsDecisionsPresentation;
}

describe("canonical OS lanes do not mix operational states", () => {
  it("serves only Act rows in Act now and keeps server counts", () => {
    const model = buildOsDecisionsViewModel({
      os: osPresentation(),
      banners: [],
      viewer: null,
      state: emptyState,
      evidenceWindow: { startDate: "2026-08-01", endDate: "2026-08-12" },
    });
    expect(model.rows.map((row) => row.id)).toEqual(["active-campaign"]);
    expect(model.counts).toEqual({ act: 1, test: 1, watch: 1 });
  });

  it("maps blocked and monitoring lanes without client-side verdict logic", () => {
    const os = osPresentation();
    const blocked = buildOsDecisionsViewModel({
      os,
      banners: [],
      viewer: null,
      state: { ...emptyState, lane: "test" },
      evidenceWindow: { startDate: "2026-08-01", endDate: "2026-08-12" },
    });
    const monitor = buildOsDecisionsViewModel({
      os,
      banners: [],
      viewer: null,
      state: { ...emptyState, lane: "watch" },
      evidenceWindow: { startDate: "2026-08-01", endDate: "2026-08-12" },
    });
    expect(blocked.rows.map((row) => row.id)).toEqual(["blocked-campaign"]);
    expect(monitor.rows.map((row) => row.id)).toEqual(["monitor-campaign"]);
  });
});

describe("context change resets what cannot transfer", () => {
  it("keeps the view but drops the search and selected row", () => {
    const next = resetForContextChange({
      lane: "watch",
      levels: ["adset"],
      search: "prospecting",
      selected: "dec_9",
    });
    // Lane and level describe the view; the term and the row describe the
    // previous client's data and would resolve to nothing.
    expect(next).toEqual({ lane: "watch", levels: ["adset"], search: "", selected: null });
  });

  it("treats a selection outside the served universe as absent", () => {
    expect(isSelectionServed("dec_9", ["dec_1", "dec_2"])).toBe(false);
    expect(isSelectionServed("dec_1", ["dec_1"])).toBe(true);
    expect(isSelectionServed(null, ["dec_1"])).toBe(false);
  });
});

describe("served presentation is the authority", () => {
  it("copies verdict, why and action byte-for-byte", () => {
    const source = recommendation();
    const row = toDecisionRow(source);
    expect(row.decision).toBe(source.decision);
    expect(row.why).toBe(source.why);
    expect(row.recommendedAction).toBe(source.recommendedAction);
    expect(row.title).toBe(source.title);
  });

  it("does not reformat or re-derive the verdict", () => {
    const odd = recommendation({ decision: "  Scale up  —  keep spacing  " });
    // Trimming or normalising is still rewriting the server's words.
    expect(toDecisionRow(odd).decision).toBe("  Scale up  —  keep spacing  ");
  });

  it("reads held from the server's fields, not from label text", () => {
    // INVARIANTS forbids recovering a blocked resolution by parsing reason text.
    expect(isHeld(recommendation({ recommendedAction: "" }))).toBe(true);
    expect(isHeld(recommendation({ decisionState: "watch" }))).toBe(true);
    expect(isHeld(recommendation())).toBe(false);
  });

  it("carries the held reason the server gave", () => {
    const row = toDecisionRow(
      recommendation({ recommendedAction: "", stateReason: "Authority blocked: no write token." }),
    );
    expect(row.held).toBe(true);
    expect(row.heldReason).toBe("Authority blocked: no write token.");
  });
});

describe("client action math is zero", () => {
  const collaborator: MetaDecisionsWorkspaceViewer = {
    role: "collaborator",
    isReviewer: false,
    readOnly: false,
    readOnlyReason: null,
  };

  it("offers no action on a held decision, whatever its label says", () => {
    const row = toDecisionRow(recommendation({ recommendedAction: "" }));
    expect(actionCountFor({ row, viewer: collaborator, demo: false })).toBe(0);
  });

  it("offers no action to a reviewer", () => {
    const row = toDecisionRow(recommendation());
    expect(
      actionCountFor({ row, viewer: { ...collaborator, isReviewer: true }, demo: false }),
    ).toBe(0);
  });

  it("offers no action on a demo business even with an action present", () => {
    // A demo business has zero Meta write authority even if a presentation
    // defect supplies an action.
    const row = toDecisionRow(recommendation());
    expect(actionCountFor({ row, viewer: collaborator, demo: true })).toBe(0);
  });

  it("offers no action to a guest or a read-only viewer", () => {
    const row = toDecisionRow(recommendation());
    expect(actionCountFor({ row, viewer: { ...collaborator, role: "guest" }, demo: false })).toBe(0);
    expect(
      actionCountFor({ row, viewer: { ...collaborator, readOnly: true }, demo: false }),
    ).toBe(0);
  });

  it("offers exactly one action to a collaborator on an actionable row", () => {
    expect(actionCountFor({ row: toDecisionRow(recommendation()), viewer: collaborator, demo: false })).toBe(1);
  });
});

describe("view model", () => {
  const rows = [
    recommendation({ id: "d1", level: "campaign", title: "Alpha" }),
    recommendation({ id: "d2", level: "adset", title: "Beta", campaignName: "Alpha" }),
    recommendation({ id: "d3", level: "account", title: "Gamma" }),
  ];

  it("filters by level without touching the served text", () => {
    const model = buildDecisionsViewModel({
      lane: lane(rows),
      banners: [],
      viewer: null,
      state: { ...emptyState, levels: ["adset"] },
    });
    expect(model.rows.map((row) => row.id)).toEqual(["d2"]);
    expect(model.rows[0].decision).toBe(rows[1].decision);
  });

  it("searches title, campaign and ad set", () => {
    const model = buildDecisionsViewModel({
      lane: lane(rows),
      banners: [],
      viewer: null,
      state: { ...emptyState, search: "alpha" },
    });
    // Beta matches through its campaign name.
    expect(model.rows.map((row) => row.id).sort()).toEqual(["d1", "d2"]);
  });

  it("keeps the evidence window and the snapshot time separate", () => {
    const model = buildDecisionsViewModel({ lane: lane(rows), banners: [], viewer: null, state: emptyState });
    expect(model.evidenceWindow).toEqual({ startDate: "2026-08-01", endDate: "2026-08-07" });
    // Written days after the window it describes — the exact case that makes a
    // stale read look current if the two are collapsed.
    expect(model.snapshotAt).toBe("2026-08-11T06:00:00Z");
    expect(model.snapshotAt).not.toBe(model.evidenceWindow.endDate);
  });

  it("discloses truncation rather than implying the cap is the total", () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      recommendation({ id: `d${index}`, title: `Row ${index}` }),
    );
    const model = buildDecisionsViewModel({
      lane: lane(many),
      banners: [],
      viewer: null,
      state: emptyState,
      cap: 100,
    });
    expect(model.rows).toHaveLength(100);
    expect(model.truncated).toBe(true);
    expect(model.disclosure).toContain("first 100 of 120");
  });

  it("exposes the served universe so a URL selection can be checked against it", () => {
    const model = buildDecisionsViewModel({ lane: lane(rows), banners: [], viewer: null, state: emptyState });
    expect(model.servedIds).toEqual(["d1", "d2", "d3"]);
    expect(isSelectionServed("d9", model.servedIds)).toBe(false);
  });
});

describe("banner stack", () => {
  const banners = [
    { id: "b1", tone: "warning" as const, title: "Partial", detail: "GA4 incomplete.", blocking: false },
    { id: "b2", tone: "danger" as const, title: "Hard", detail: "Token expired.", blocking: true },
  ];

  it("orders blocking first without dropping advisory", () => {
    const ordered = orderedBanners(banners);
    expect(ordered.map((banner) => banner.id)).toEqual(["b2", "b1"]);
    expect(ordered).toHaveLength(2);
  });
});
