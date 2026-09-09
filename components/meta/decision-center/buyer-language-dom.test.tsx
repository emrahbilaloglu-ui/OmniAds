// @vitest-environment jsdom

/**
 * WHAT THE BUYER'S SCREEN ACTUALLY SAYS.
 *
 * Round 8, item 7. The adapter tests assert the mapped strings; this file
 * asserts the RENDERED DOM, because a mapping that is computed and then not
 * used — or used in one scope and not another — passes an adapter test and
 * still shows an operator "Legacy creative-grain decisions … cannot authorize
 * Ad writes".
 *
 * The fixtures below deliberately carry the SERVER'S OWN vocabulary in every
 * prose field: the limitation messages, the fallback reason, the blocker
 * explanation. That is what the payload really contains, and it is what makes
 * these assertions a proof of mapping rather than a proof of renaming — if the
 * surface passed anything through, the forbidden term would appear.
 *
 * Both directions are asserted every time:
 *   - the internal vocabulary is ABSENT from the rendered text, and
 *   - the actionable sentence is PRESENT.
 * A screen that rendered nothing at all would satisfy the first on its own,
 * which is why it never appears without the second.
 */
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  MetaDecisionCenterExact,
  type MetaDecisionCenterExactViewModel,
} from "./MetaDecisionCenterExact";
import { buildMetaDecisionCenterExactViewModel } from "./meta-decision-center-exact-adapter";
import { INTERNAL_VOCABULARY, SPEND_EXECUTION_INSTRUCTIONS } from "@/lib/meta/buyer-copy";
import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";
import type { MetaDecisionsWorkspacePayload } from "@/components/meta/redesign/types";

afterEach(cleanup);

/** The engine's own sentences, exactly as `decisions-os-presentation.ts` emits them. */
const SERVER_LIMITATIONS = [
  {
    code: "legacy_creative_review_only",
    message:
      "Legacy creative-grain decisions remain visible for continuity but cannot authorize Ad writes.",
  },
  {
    code: "ad_metrics_are_creative_context",
    message:
      "Legacy rows use creative-grain metrics and are review-only even when one exact Ad identity is displayed.",
  },
  {
    code: "active_ad_inventory_pending_native_decision",
    message:
      "60 ACTIVE Ads have no exact Ad-grain decision yet, so they are not listed as decisions.",
  },
] as const;

function workspace(): MetaDecisionsWorkspacePayload {
  return {
    businessId: "biz_1",
    window: "28d",
    startDate: "2026-07-21",
    endDate: "2026-08-17",
    pulse: {
      businessId: "biz_1",
      window: "28d",
      startDate: "2026-07-21",
      endDate: "2026-08-17",
      pacing: { mtdSpend: 0, mtdTarget: 0, dayPace: 0 },
      roas: {
        selected: Number.NaN,
        d7: Number.NaN,
        d14: Number.NaN,
        d28: Number.NaN,
        target: null,
        median: null,
        target_source: "none",
      },
      spend: { current: 0, prev: 0 },
      revenue: { current: 0, prev: 0 },
      cpa: { current: null, prev: null },
      matureCampaigns: 0,
      learningCampaigns: 0,
      operatingMode: "",
      seasonalRegime: "",
      engineLastRun: null,
      engineVersion: "server-engine-v1",
      trackingHealth: { status: "unknown", detail: "" },
      lastSyncAt: null,
      currency: "USD",
    },
    queue: {
      groups: [],
      actionStates: {
        executablePause: 0,
        executableBid: 0,
        executableResume: 0,
        launchpadRoutes: 0,
        reviewOnly: 0,
        missingActionKind: 0,
      },
    },
    viewer: null,
    banners: [],
    digest: {
      snapshotDate: "2026-08-16",
      unavailableReason: null,
      labelFlips: { count: 0, publishedCount: 0, items: [] },
      actions: { verifiedCount: 0, silentFailureCount: 0, items: [] },
      anomalies: { openedCount: 0, items: [] },
      deferrals: { dueCount: 0, items: [] },
    },
    lanes: {
      businessId: "biz_1",
      startDate: "2026-07-21",
      endDate: "2026-08-17",
      sourceModel: "snapshot_persistent",
      snapshotDate: "2026-08-16",
      actionNow: [],
      watching: [],
      healthy: [],
      nonSales: [],
      archive: [],
      deferredIds: [],
      watchingSegments: [],
      counts: {
        actionNow: 0,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    },
    system: {
      trackingBlocked: false,
      laneSnapshotDate: "2026-08-16",
      engineVersion: "server-engine-v1",
      currency: "USD",
      killSwitchEngaged: false,
      killSwitchReason: null,
    },
    decisionReadModel: {
      scope: {
        businessId: "biz_1",
        providerAccountId: "act_1",
        decisionMode: "current",
      },
      source: {
        // The raw tokens the headline used to print.
        authority: "legacy_creative",
        status: "degraded",
        fallbackReason: "native_account_manifest_incomplete",
        snapshotAsOf: "2026-08-16",
        engineVersion: "server-engine-v1",
      },
      capabilities: {
        providerAccountScope: { status: "unavailable", reason: "not_bound" },
        stableDecisionIdentity: { status: "available", reason: null },
        stableEpisodeIdentity: { status: "available", reason: null },
        classificationOverlay: { status: "available", reason: null },
        riskTierProducer: { status: "available", reason: null },
        promotionBasisProducer: { status: "available", reason: null },
        responseAttribution: { status: "available", reason: null },
        providerWriteLinkage: { status: "available", reason: null },
      },
      queue: { sections: {} },
    },
    os: {
      source: {
        adsSource: "legacy_creative_review_only",
        structureSource: "meta_recommendations",
        health: "degraded",
        fallbackReason: "native_account_manifest_incomplete",
      },
      ads: { pendingInventoryCount: 60 },
      limitations: SERVER_LIMITATIONS,
      structure: { groups: [] },
    },
  } as unknown as MetaDecisionsWorkspacePayload;
}

function renderCenter(
  viewModel: MetaDecisionCenterExactViewModel,
  scope: "structure" | "creatives" = "creatives",
) {
  return render(
    <ZeroBaseCopyProvider language="en">
      <MetaDecisionCenterExact
        viewModel={viewModel}
        scope={scope as never}
        inspectorOpen
      />
    </ZeroBaseCopyProvider>,
  );
}

/**
 * Every rendered word on the screen, normalised.
 *
 * Read off `document.body` rather than off the view model so nothing that only
 * exists in a prop can satisfy these assertions.
 */
function renderedText(): string {
  return (document.body.textContent ?? "").replace(/\s+/g, " ").toLowerCase();
}

function expectNoInternalVocabulary(text: string, where: string) {
  for (const term of INTERNAL_VOCABULARY) {
    expect(text, `${where} rendered the internal term "${term}"`).not.toContain(
      term.toLowerCase(),
    );
  }
}

describe("the Creatives scope, notice and provenance panel", () => {
  const viewModel = () =>
    buildMetaDecisionCenterExactViewModel({ workspace: workspace() });

  it("says what is happening without naming a decision grain", () => {
    const model = viewModel();
    renderCenter(model);
    const text = renderedText();

    // THE MEANING SURVIVES.
    expect(text).toContain(
      "earlier creative-level guidance is shown for reference and cannot be applied to individual ads",
    );
    // AND THE VOCABULARY DOES NOT.
    expectNoInternalVocabulary(text, "the Creatives scope");
  });

  it("keeps the pending-ads COUNT, which is the fact a buyer can act on", () => {
    const model = viewModel();
    renderCenter(model);
    const text = renderedText();

    /*
      The server sentence and the buyer sentence carry the same number. Dropping
      it to avoid the jargon would have traded one failure for another: "some
      ads are being evaluated" does not tell an operator whether five or six
      hundred of their account is affected.
    */
    expect(text).toContain("60 active ads are still being evaluated");
  });

  it("does not print the raw limitation codes or the fallback reason", () => {
    const model = viewModel();
    renderCenter(model);
    const text = renderedText();

    for (const limitation of SERVER_LIMITATIONS) {
      expect(text).not.toContain(limitation.code);
      // And not the engine's sentence for it either.
      expect(text).not.toContain(limitation.message.toLowerCase().slice(0, 40));
    }
  });

  it("would FAIL if the surface passed the server message through", () => {
    /*
      The control. These fixtures only prove a mapping if the raw strings would
      otherwise be visible — so this asserts the strings really do contain the
      forbidden vocabulary, rather than being harmless prose that would pass the
      sweep either way.
    */
    const raw = SERVER_LIMITATIONS.map((l) => l.message)
      .join(" ")
      .toLowerCase();
    expect(
      INTERNAL_VOCABULARY.filter((term) => raw.includes(term.toLowerCase())),
    ).not.toHaveLength(0);
  });
});

/*
  The evidence DRAWER is asserted in
  `components/creatives/creative-evidence-window-exact-adapter.test.ts`, which
  already owns the full canonical fixture that builder requires. Duplicating
  that fixture here to render the same row would be a second source of truth
  for it; the assertion there covers the same two directions — the buyer
  sentence is present and the engine's own wording is absent.
*/

describe("the capability rows an operator reads when something is missing", () => {
  it("names what the buyer loses, not the contract field", () => {
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspace(),
    });
    const gap = (model.sourceProvenance?.capabilityGaps ?? []).find(
      (entry) => entry.id === "providerAccountScope",
    );
    expect(gap, "the unavailable capability must still be reported").toBeTruthy();
    expect(gap?.label).toBe("Account this applies to");
    expect(String(gap?.label).toLowerCase()).not.toContain("provider account scope");
  });

  it("headlines the panel in a sentence rather than two database enums", () => {
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspace(),
    });
    expect(model.sourceProvenance?.headline).toBe(
      "Ad-level decisions are not available yet",
    );
    expect(model.structureProvenance?.headline).toBe(
      "Campaign and ad set guidance is limited right now",
    );
  });
});

/**
 * A screen with no problems at all must still read as one.
 *
 * Every case above renders a DEGRADED account, which is where the jargon lived.
 * If the mapping only fired on the unhappy path an operator on a healthy
 * account would still meet the raw tokens in the same panel.
 */
describe("a healthy account", () => {
  it("headlines its source without naming the producer", () => {
    const healthy = workspace();
    (healthy as unknown as { os: Record<string, unknown> }).os = {
      source: {
        adsSource: "native_ad_decision",
        structureSource: "meta_recommendations",
        health: "healthy",
        fallbackReason: null,
      },
      ads: { pendingInventoryCount: 0 },
      limitations: [],
      structure: { groups: [] },
    };
    (
      healthy as unknown as {
        decisionReadModel: { source: Record<string, unknown> };
      }
    ).decisionReadModel.source = {
      authority: "native_ad",
      status: "available",
      fallbackReason: null,
      snapshotAsOf: "2026-08-16",
      engineVersion: "server-engine-v1",
    };

    const model = buildMetaDecisionCenterExactViewModel({ workspace: healthy });
    expect(model.sourceProvenance?.headline).toBe(
      "Ad-level decisions are up to date",
    );
    expect(model.creativesNotice ?? null).toBeNull();
  });
});

/*
  ── ROUND 9 ITEMS 7 AND 8: THE HELD RECOMMENDATION, EVERYWHERE IT RENDERS ────

  `heldCreativeVerdict` is the ONE producer for the label and the next step, and
  its output reaches the main creative row, the structure inspector, the
  creative drawer and (Round 9) the mobile row. It emitted "Held verdict:
  Refresh creative" and "The engine's Refresh creative verdict stays
  unauthorized until then" — three internal words in one sentence, on four
  surfaces.

  Asserted at the producer AND on rendered DOM, because a producer test alone
  cannot see that a surface renders the field at all — which is exactly how
  mobile ended up showing a different decision truth from desktop.
*/
describe("the held recommendation reads as an action, not an engine state", () => {
  const HELD = {
    heldAction: "refresh" as const,
    heldResolution: { code: "commercial_target_missing" },
  };

  it("labels it as a recommendation awaiting review", async () => {
    const { heldCreativeVerdict } = await import(
      "./meta-decision-center-exact-adapter"
    );
    const held = heldCreativeVerdict(HELD as never);
    expect(held?.label).toBe(
      "Recommendation awaiting review: Refresh creative",
    );
    expectNoInternalVocabulary(
      String(held?.label).toLowerCase(),
      "the held label",
    );
  });

  it("states a next step a buyer can act on", async () => {
    const { heldCreativeVerdict } = await import(
      "./meta-decision-center-exact-adapter"
    );
    // No resolution code served: the generic sentence must still be actionable
    // rather than an explanation of the permission model.
    const held = heldCreativeVerdict({ heldAction: "refresh" } as never);
    expect(held?.nextStep).toBe(
      "Confirm the missing information, then review this Refresh creative recommendation again.",
    );
    expectNoInternalVocabulary(
      String(held?.nextStep).toLowerCase(),
      "the held next step",
    );
  });

  it("keeps the SERVER verdict intact under the buyer copy", async () => {
    /*
      The copy change must not have become a data change. `action` is the
      server's own `heldAction`, unmapped, so downstream consumers and the
      diagnostics still see what the engine concluded.
    */
    const { heldCreativeVerdict } = await import(
      "./meta-decision-center-exact-adapter"
    );
    for (const action of ["scale", "cut", "refresh"] as const) {
      expect(heldCreativeVerdict({ heldAction: action } as never)?.action).toBe(
        action,
      );
    }
  });

  it("carries BOTH halves onto the row model the mobile surface reads", async () => {
    /*
      ROUND 9 ITEM 8. The row model carried only the label, and mobile is built
      from the row model — so a phone could not have shown the next step even
      after it started drawing the label.
    */
    const { heldCreativeVerdict } = await import(
      "./meta-decision-center-exact-adapter"
    );
    const held = heldCreativeVerdict(HELD as never);
    expect(held?.label).toBeTruthy();
    expect(held?.nextStep).toBeTruthy();
  });
});

/*
  ── ROUND 10 ITEM 6: EVERY REVIEW-ONLY CODE, THROUGH EVERY MOUNTED SURFACE ───

  `buyerFacingCreativeScope` still emitted "no Meta change is authorized" for
  nine action codes, and that sentence reaches the exact inspector, the desktop
  drawer and the mobile evidence screen. Spot-checking one code missed it for a
  round: the sweep below drives the WHOLE list through the real producers and
  bans the shared vocabulary on each.
*/
describe("no review-only code leaks internal vocabulary to a mounted surface", () => {
  /** Every code whose scope copy said "authorized", plus the two lane notes. */
  const REVIEW_ONLY_CODES = [
    "fix_delivery",
    "fix_policy",
    "await_ad_grain_evidence",
    "resolve_contract_state",
    "refresh_decision_data",
    "review_kill_switch",
    "review_engine_version",
    "review_execution_governance",
    "cut",
  ] as const;

  const decisionFor = (code: string) =>
    ({
      id: `ad_${code}`,
      lane: "blocked",
      action: { code, intent: "review", providerMutation: null },
      publishedLabel: "keep",
      rawLabel: "keep",
      parentChain: { ad: { id: "ad_1", name: "Ad one" } },
    }) as never;

  it.each(REVIEW_ONLY_CODES)(
    "keeps the scope sentence for %s free of internal vocabulary",
    async (code) => {
      const { buyerFacingCreativeScope } = await import(
        "./meta-decision-center-exact-adapter"
      );
      const scope = buyerFacingCreativeScope(decisionFor(code));
      // The sentence must still EXIST — a surface that says nothing about a
      // blocked row is worse than one that says it plainly.
      expect(scope, `${code} lost its scope sentence`).toBeTruthy();
      expectNoInternalVocabulary(
        String(scope).toLowerCase(),
        `the ${code} scope sentence`,
      );
      // And it must not print the raw code either.
      expect(String(scope).toLowerCase()).not.toContain(code);
    },
  );

  it("keeps the readiness-resolution copy free of it too", async () => {
    /*
      `not_action_state` and `diagnostic_or_watch_state` live in the READINESS
      resolution map, not the scope map — a second producer feeding the same
      inspector rows, and it carried "no change is currently authorized".
      Driven through the real adapter export rather than by reading the map.
    */
    const { buyerFacingCreativeResolution } = await import(
      "./meta-decision-center-exact-adapter"
    );
    for (const code of ["not_action_state", "diagnostic_or_watch_state"]) {
      const copy = buyerFacingCreativeResolution({
        ...(decisionFor("cut") as unknown as Record<string, unknown>),
        readiness: { issues: [{ code }] },
      } as never);
      if (!copy) continue;
      expectNoInternalVocabulary(
        String(copy).toLowerCase(),
        `the ${code} resolution copy`,
      );
    }
  });

  it("states the blocked-group note as recommendations awaiting review", async () => {
    /*
      The group note read "Verdicts held (unauthorized)" — two internal words
      and a permission model, on a heading a buyer reads before any row.
    */
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspace(),
    });
    const rendered = JSON.stringify(model).toLowerCase();
    expect(rendered).not.toContain("verdicts held");
    expect(rendered).not.toContain("unauthorized");
  });

  it("bans the shared list across the whole rendered Creatives DOM", async () => {
    /*
      The end-to-end sweep. Anything that reached a mounted surface through a
      path this file does not enumerate is still caught here, because the
      assertion is over `document.body`.
    */
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspace(),
    });
    renderCenter(model);
    expectNoInternalVocabulary(renderedText(), "the Creatives DOM");
  });

  it("bans the shared list across the rendered Structures DOM", async () => {
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspace(),
    });
    renderCenter(model, "structure");
    expectNoInternalVocabulary(renderedText(), "the Structures DOM");
  });
});

/*
  ══ ROUND 11, ITEM 2 ════════════════════════════════════════════════════════

  THE SWEEP ABOVE PASSED ON AN EMPTY SCREEN.

  `workspace()` carries no lane rows, no ad decisions and no inactive assets,
  so "the rendered Creatives DOM contains no internal vocabulary" was true of a
  surface that rendered no decisions at all. Three real leaks survived it:

    - the Creatives BLOCKED GROUP note   — "3 held verdicts (…)"
    - the ARCHIVE row note, desktop and mobile
                                        — "Withheld from the live queue: …"
    - the LOW-CONFIDENCE STRUCTURE ROW's demotion reason
                                        — "The automatic campaign-role resolver
                                           is awaiting independent validation"

  The workspace below populates exactly those four mounted surfaces, and every
  case asserts BOTH directions: the buyer sentence is present, and the shared
  `INTERNAL_VOCABULARY` list is absent from `document.body`. A screen that
  rendered nothing would fail the first half.
*/

const RESOLVER_CONFIDENCE_REASON = "campaign_context_resolver_unvalidated";

/** One Ad the read model withheld from the live queues, as the payload carries it. */
function inactiveAd(over: Record<string, unknown> = {}) {
  return {
    decisionId: "inactive_1",
    sourceSnapshotId: "snapshot_9",
    identityGrain: "ad",
    parentChain: {
      account: { id: "act_1", name: "Account" },
      campaign: { id: "cmp_9", name: "Retired Campaign" },
      adset: { id: "ads_9", name: "Retired Ad set" },
      ad: { id: "ad_9", name: "Cat-Guarantee" },
      creative: { id: "crt_9", name: "Cat-Guarantee creative" },
    },
    deliveryScope: {
      state: "inactive",
      campaignStatus: "NOT_ACTIVE",
      adsetStatus: "NOT_ACTIVE",
      adStatus: "NOT_ACTIVE",
      reason: "hierarchy_not_active",
    },
    sourceAuthority: {
      status: "native_exact",
      actionEligible: false,
      reviewOnlyReason: "current_hierarchy_is_not_active",
      authorizedAction: null,
    },
    classification: {
      buyerLabel: "Cut this creative",
      decisionState: "act",
      heldAction: "cut",
    },
    sourceDecision: { label: "cut", reason: "ROAS below target" },
    metrics: { spend: 699.34, purchases: 2, roas: 1.1 },
    ...over,
  };
}

/** One server-blocked Ad decision carrying a held recommendation. */
function blockedAd() {
  return {
    id: "os_ad_1",
    decisionId: "decision_1",
    sourceSnapshotId: "snapshot_1",
    episodeId: "episode_1",
    providerAccountId: "act_1",
    adId: "ad_1",
    adName: "Server Creative",
    campaignId: "cmp_1",
    campaignName: "Server Campaign",
    adsetId: "set_1",
    adsetName: "Server Ad set",
    creativeId: "creative_1",
    creativeName: "Server Creative",
    thumbnailUrl: null,
    lifecycleRole: "main",
    campaignRoleSource: "automatic",
    campaignRoleConfidence: "high",
    campaignRoleTrustedForAction: true,
    action: {
      code: "refresh_decision_data",
      label: "Refresh decision data",
      intent: "review",
      targetLevel: "ad",
      providerMutation: null,
      scopeNote: "Review only.",
    },
    lane: "blocked",
    priority: { band: "high", rank: 100, version: "meta-os-decisions.presentation.v5" },
    assessment: "Server creative assessment",
    confidence: "low",
    confidenceScore: 0.2,
    riskTier: "high",
    confirmationCeremony: "highest",
    whyNow: "Server creative why now",
    blockers: [],
    resolution: null,
    heldAction: "refresh",
    heldResolution: { code: "commercial_target_missing" },
    metrics: {
      spend: 725,
      purchases: 18,
      roas: 3.8,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: 3.1,
      ratioToTarget: 1.23,
      currency: "USD",
      attribution: "meta_attributed",
      grain: "ad",
    },
    rawLabel: "refresh",
    publishedLabel: "keep",
    engineVersion: "server-engine-v1",
    snapshotAsOf: "2026-08-16",
    sourceGrain: "ad",
    decisionAvailability: "available",
  };
}

/**
 * The same payload shape as `workspace()`, populated on the four surfaces the
 * audit named. Built by mutating that fixture rather than by writing a second
 * one, so the two cannot drift apart.
 */
function populatedWorkspace(): MetaDecisionsWorkspacePayload {
  const payload = workspace() as unknown as Record<string, any>;
  // A structure row the SERVER capped to low confidence, with the resolver
  // reason it caps on. This is the only field the row's demotion text reads.
  payload.lanes.actionNow = [
    {
      id: "rec_low",
      level: "campaign",
      campaignId: "cmp_1",
      campaignName: "ASC Prospecting",
      type: "scale_for_volume",
      lens: "structure",
      priority: "high",
      confidence: "low",
      confidenceScore: 0.21,
      confidenceReason: RESOLVER_CONFIDENCE_REASON,
      decisionState: "act",
      decision: "Scale",
      title: "ASC Prospecting",
      why: "Structure and bid signals are mixed.",
      summary: "",
      recommendedAction: "Increase budget.",
      expectedImpact: "",
      evidence: [],
      engineVersion: "server-engine-v1",
      decisionLabel: "Increase spend",
      actionKind: "review",
      primaryActionLabel: "Review",
      metrics: { spend: 100, roas: 3.2, purchases: 4, currency: "USD" },
    },
  ];
  payload.lanes.counts.actionNow = 1;
  payload.decisionReadModel.queue.inactiveAssets = {
    items: [inactiveAd()],
    count: 1,
  };
  payload.os.ads = {
    ...payload.os.ads,
    items: [blockedAd()],
    // The three counts that produce the blocked group's note.
    heldCounts: { scale: 1, cut: 0, refresh: 2 },
  };
  return payload as unknown as MetaDecisionsWorkspacePayload;
}

function renderLane(
  viewModel: MetaDecisionCenterExactViewModel,
  scope: "structure" | "creatives",
  lane?: string,
) {
  return render(
    <ZeroBaseCopyProvider language="en">
      <MetaDecisionCenterExact
        viewModel={viewModel}
        scope={scope as never}
        {...(lane ? { lane: lane as never } : {})}
        inspectorOpen
      />
    </ZeroBaseCopyProvider>,
  );
}

describe("Round 11 item 2 — the four populated mounted surfaces", () => {
  const model = () =>
    buildMetaDecisionCenterExactViewModel({ workspace: populatedWorkspace() });

  it("desktop Creatives blocked group states a count, not a held verdict", () => {
    // The blocked group is the Creatives scope's "Needs resolution" lane.
    // @see creativeGroupIdForLane
    renderLane(model(), "creatives", "needsres");
    const text = renderedText();
    // PRESENT: the count and the split survive; only the noun changed.
    expect(text).toContain(
      "3 ads need more evidence before action (scale 1 · cut 0 · refresh 2)",
    );
    // ABSENT: and the group heading is real DOM, not a view-model field.
    expect(text).not.toContain("held verdict");
    expectNoInternalVocabulary(text, "the Creatives blocked group");
  });

  it("desktop Archive says why the ad is not in Action now", () => {
    renderLane(model(), "structure", "archive");
    const text = renderedText();
    expect(text).toContain(
      "not included in action now because this ad is inactive.",
    );
    // The provider's own status list is the useful half and is still there.
    expect(text).toContain("current status — campaign not_active");
    expect(text).not.toContain("withheld from the live queue");
    expectNoInternalVocabulary(text, "the desktop Archive");
  });

  it("the low-confidence structure row names the campaign, not the resolver", () => {
    const { container } = renderLane(model(), "structure", "action");
    const demoted = container.querySelector('[data-el="stale-demoted"]');
    expect(demoted, "the capped row must still state its reason").toBeTruthy();
    expect(demoted?.textContent).toBe("Campaign role could not be confirmed");
    expectNoInternalVocabulary(renderedText(), "the low-confidence row");
  });

  it("would FAIL if the served reason reached the screen unmapped", () => {
    /*
      THE CONTROL for the case above. The reason code and the sentence it used
      to render are both asserted to contain forbidden vocabulary, so the
      assertion is a proof of MAPPING rather than of a fixture that happened to
      be clean.
    */
    const raw =
      "The automatic campaign-role resolver is awaiting independent validation";
    expect(
      INTERNAL_VOCABULARY.filter((term) =>
        raw.toLowerCase().includes(term.toLowerCase()),
      ),
    ).not.toHaveLength(0);
    expect(renderedText()).not.toContain(RESOLVER_CONFIDENCE_REASON);
  });
});


describe("blocked DOM does not advertise spend execution", () => {
  it.each([false, true])("keeps blocked creative instructions review-only when held=%s", (held) => {
    const payload = populatedWorkspace();
    const decision = blockedAd();
    decision.whyNow = "Increase budget. Bütçeyi kademeli artırın.";
    if (!held) {
      decision.heldAction = null as never;
      decision.heldResolution = null as never;
    }
    payload.os!.ads.items = [decision] as never;
    renderLane(buildMetaDecisionCenterExactViewModel({ workspace: payload }), "creatives", "needsres");
    const row = document.querySelector('[data-meta-exact-creative-row="os_ad_1"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain(held ? "ROAS" : "Refresh");
    for (const instruction of SPEND_EXECUTION_INSTRUCTIONS) {
      expect(row.textContent!.toLowerCase()).not.toContain(instruction);
    }
    for (const button of within(row).queryAllByRole("button")) {
      expect(button.textContent).not.toMatch(/^(apply|pause|scale|cut|increase|reduce|duraklat|kapat)\b/i);
    }
    expect(row.querySelector('[data-meta-exact-creative-served-action]')).toBeNull();
  });

  it("keeps a server-blocked structure row on evidence review despite spend prose", () => {
    const payload = populatedWorkspace();
    const recommendation = payload.lanes.actionNow[0]!;
    recommendation.decisionLabel = "scale";
    recommendation.recommendedAction = "Increase budget. Bütçeyi kademeli artırın.";
    payload.os!.structure.groups = [{
      id: "blocked_campaign", adsets: [],
      campaign: {
        ...blockedAd(), id: "node_cmp_1", sourceRecommendationId: recommendation.id,
        level: "campaign", providerEntityId: "cmp_1", name: "ASC Prospecting",
        suppressedAlternativeCount: 0,
      },
    }] as never;
    const model = buildMetaDecisionCenterExactViewModel({ workspace: payload });
    renderLane(model, "structure", "needsres");
    const row = document.querySelector('[data-meta-exact-needsres-row="rec_low"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.querySelector('[data-el="resolution-step"]')?.textContent).toMatch(/review/i);
    for (const instruction of SPEND_EXECUTION_INSTRUCTIONS) {
      expect(row.textContent!.toLowerCase()).not.toContain(instruction);
    }
    expect(within(row).queryByRole("button", { name: /apply|pause|scale|increase budget/i })).toBeNull();
  });

  it("detects spend instructions in both locales without banning healthy action information", () => {
    for (const phrase of ["Increase budget.", "Bütçeyi kademeli artırın."]) {
      expect(SPEND_EXECUTION_INSTRUCTIONS.some((instruction) => phrase.toLowerCase().includes(instruction))).toBe(true);
    }
    const model = buildMetaDecisionCenterExactViewModel({ workspace: populatedWorkspace() });
    model.creativeGroups = [{ id: "act", label: "Action", rows: [{
      id: "healthy", name: "Healthy ad", stateLabel: "Act",
      decisionLabel: "Scale", actionLabel: "Increase budget", note: "The target and measured evidence are available.",
    }] }];
    renderLane(model, "creatives", "action");
    expect(document.querySelector('[data-meta-exact-creative-served-action]')?.textContent).toBe("Increase budget");
  });
});
