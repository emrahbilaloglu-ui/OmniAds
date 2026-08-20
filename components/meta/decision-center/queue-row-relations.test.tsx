// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { metaRec } from "@/components/meta/redesign/test-fixtures";
import type { MetaDecisionsWorkspacePayload } from "@/components/meta/redesign/types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

import { MetaDecisionCenterExact } from "./MetaDecisionCenterExact";
import {
  buildMetaDecisionCenterExactViewModel,
  type MetaDecisionCenterExactAdapterCallbacks,
  type MetaDecisionCenterExactAdapterSelection,
} from "./meta-decision-center-exact-adapter";

/**
 * Three operator complaints about the Decision Center's left-hand queue, pinned
 * end to end: the REAL adapter builds the view model from a served workspace
 * payload and the REAL component renders it. Nothing here is a stub, because
 * two of the three defects lived exactly at that seam — the adapter knew which
 * row the inspector had defaulted to and the queue did not, and the row model
 * carried the campaign an ad set belongs to while the row never said it.
 *
 *  1. "Solda kampanya ve reklam seti arasında hiyerarşik bağ kuran
 *     görselleştirme yok" — campaign rows and ad-set rows rendered as flat
 *     siblings, so nothing said which ad set belonged to which campaign.
 *  2. "Soldakiler kart olarak genel tıklanabilir olmalı fakat değil" — only the
 *     small overflow glyph opened the evidence inspector.
 *  3. "Tıklandığında hangisi tıklandı belli olması lazım ama değil" — no row
 *     ever looked selected, not even the one the inspector was describing on
 *     first paint.
 *
 * What none of this may do, and what these tests therefore also guard: the lane
 * a row sits in and the order the server sorted it are decisions, not
 * presentation.
 */
afterEach(cleanup);

const PARENT = "cmp_parent";
const ELSEWHERE = "cmp_elsewhere";

function campaignRec(): MetaRecommendation {
  return metaRec({
    id: "rec_campaign",
    level: "campaign",
    campaignId: PARENT,
    campaignName: "Parent Campaign",
  });
}

function adsetRec(): MetaRecommendation {
  return metaRec({
    id: "rec_adset",
    level: "adset",
    campaignId: PARENT,
    campaignName: "Parent Campaign",
    adsetId: "adset_1",
    adsetName: "Child Ad Set",
  });
}

/** An ad set whose campaign is real but has no row in this lane. */
function orphanAdsetRec(): MetaRecommendation {
  return metaRec({
    id: "rec_orphan",
    level: "adset",
    campaignId: ELSEWHERE,
    campaignName: "Campaign Elsewhere",
    adsetId: "adset_2",
    adsetName: "Lone Ad Set",
  });
}

function structureNode(recommendationId: string) {
  return {
    id: `node_${recommendationId}`,
    sourceRecommendationId: recommendationId,
    level: "campaign",
    providerEntityId: PARENT,
    campaignId: PARENT,
    campaignName: "Parent Campaign",
    name: "Parent Campaign",
    action: {
      code: "rebuild",
      label: "Rebuild in Launchpad",
      intent: "launchpad",
      targetLevel: "campaign",
      providerMutation: null,
      scopeNote: "Routes to Launchpad.",
    },
    lane: "act",
    priority: { band: "high", rank: 100, version: "v5" },
    urgency: { level: "high", rank: 3, label: "High", reason: null },
    confidence: "high",
    assessment: "Server assessment",
    whyNow: "Server why now",
    expectedImpact: "Server expected impact",
    evidence: [{ label: "Server evidence", value: "literal", tone: "neutral" }],
    metrics: { spend: 500, roas: 2.5, currency: "USD", effectiveTargetRoas: 2 },
  };
}

/**
 * The served payload, trimmed to the fields this surface reads. Cast the way the
 * adapter's own suite casts: the contract is wide and none of the omitted
 * branches are exercised here.
 */
function workspace(input: {
  actionNow?: readonly MetaRecommendation[];
  watching?: readonly MetaRecommendation[];
  nodes?: readonly string[];
}): MetaDecisionsWorkspacePayload {
  const actionNow = input.actionNow ?? [];
  const watching = input.watching ?? [];
  return {
    businessId: "biz_1",
    window: "28d",
    startDate: "2026-07-21",
    endDate: "2026-08-17",
    pulse: {
      pacing: {},
      roas: { selected: Number.NaN, target: null, target_source: "none" },
      operatingMode: "",
      seasonalRegime: "",
      trackingHealth: { status: "unknown", detail: "" },
      lastSyncAt: null,
      currency: "USD",
    },
    lanes: {
      snapshotDate: "2026-08-16",
      actionNow,
      watching,
      healthy: [],
      nonSales: [],
      archive: [],
      deferredIds: [],
      watchingSegments: [],
      counts: {
        actionNow: actionNow.length,
        watching: watching.length,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    },
    queue: { groups: [], actionStates: {} },
    system: {
      trackingBlocked: false,
      dataReadiness: null,
      snapshotHealth: null,
      engineVersion: "server-engine-v1",
      currency: "USD",
      killSwitchEngaged: false,
      killSwitchReason: null,
    },
    viewer: null,
    banners: [],
    digest: null,
    decisionReadModel: {
      scope: { businessId: "biz_1", providerAccountId: "act_1" },
      source: {
        snapshotAsOf: "2026-08-16",
        computedAt: "2026-08-17T09:55:00.000Z",
        engineVersion: "server-engine-v1",
      },
      queue: { adCandidates: { items: [] }, sections: {} },
    },
    os: {
      source: { snapshotAsOf: "2026-08-16", engineVersion: "server-engine-v1" },
      structure: {
        groups: (input.nodes ?? []).map((id) => ({
          id: `group_${id}`,
          campaign: structureNode(id),
          adsets: [],
        })),
        actCount: (input.nodes ?? []).length,
      },
      ads: { items: [] },
      limitations: [],
    },
  } as unknown as MetaDecisionsWorkspacePayload;
}

function renderQueue(input: {
  actionNow?: readonly MetaRecommendation[];
  watching?: readonly MetaRecommendation[];
  nodes?: readonly string[];
  selection?: MetaDecisionCenterExactAdapterSelection;
  callbacks?: MetaDecisionCenterExactAdapterCallbacks;
  lane?: "action" | "watching";
}) {
  const viewModel = buildMetaDecisionCenterExactViewModel({
    workspace: workspace(input),
    now: Date.parse("2026-08-17T10:00:00.000Z"),
    ...(input.selection !== undefined ? { selection: input.selection } : {}),
    callbacks: input.callbacks ?? {
      onStructurePrimary: () => {},
      onStructureMenu: () => {},
      onWatchingReview: () => {},
    },
  });
  render(
    <MetaDecisionCenterExact lane={input.lane ?? "action"} viewModel={viewModel} />,
  );
  return viewModel;
}

function actionRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-meta-exact-action-row="${id}"]`,
  );
  if (!row) throw new Error(`no action row ${id}`);
  return row;
}

function watchingRow(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-meta-exact-watching-row="${id}"]`,
  );
  if (!row) throw new Error(`no watching row ${id}`);
  return row;
}

/** The stretched-link overlay, which shares its name with the row's ⋯ glyph. */
function cardOpen(row: HTMLElement): HTMLButtonElement {
  const button = row.querySelector<HTMLButtonElement>("[data-meta-exact-card-open]");
  if (!button) throw new Error("row has no card-open control");
  return button;
}

/**
 * The lineage line as a screen reader hears it: the decorative connector glyph
 * is aria-hidden, so it is dropped rather than asserted on.
 */
function lineageOf(row: HTMLElement): string | null {
  const line = row.querySelector("[data-meta-exact-lineage]");
  if (!line) return null;
  const spoken = line.cloneNode(true) as HTMLElement;
  for (const hidden of Array.from(spoken.querySelectorAll('[aria-hidden="true"]'))) {
    hidden.remove();
  }
  return spoken.textContent?.trim() ?? null;
}

describe("the queue states the campaign an ad-set row belongs to", () => {
  it("names the parent on the ad set and counts the children on the campaign", () => {
    renderQueue({ actionNow: [campaignRec(), adsetRec()] });

    // The ad set says what it is part of, in words, on the row itself.
    expect(lineageOf(actionRow("rec_adset"))).toContain("In Parent Campaign");
    // ...and that the campaign it belongs to is one of the rows on screen, so
    // the operator can go find it rather than wondering if it is missing.
    expect(lineageOf(actionRow("rec_adset"))).toContain("campaign also in this lane");
    expect(
      actionRow("rec_adset").querySelector("[data-meta-exact-lineage]")
        ?.getAttribute("data-meta-exact-lineage"),
    ).toBe("child");

    // The campaign says how much of the lane hangs off it.
    expect(lineageOf(actionRow("rec_campaign"))).toBe("1 ad set in this lane");
    expect(
      actionRow("rec_campaign").querySelector("[data-meta-exact-lineage]")
        ?.getAttribute("data-meta-exact-lineage"),
    ).toBe("parent");
  });

  it("pluralises the child count from the rows actually in the lane", () => {
    renderQueue({
      actionNow: [
        campaignRec(),
        adsetRec(),
        metaRec({
          id: "rec_adset_2",
          level: "adset",
          campaignId: PARENT,
          campaignName: "Parent Campaign",
          adsetId: "adset_3",
          adsetName: "Second Child",
        }),
      ],
    });

    expect(lineageOf(actionRow("rec_campaign"))).toBe("2 ad sets in this lane");
  });

  it("still says what an ad set belongs to when its campaign has no row here", () => {
    // The lane not holding the campaign row is a fact about the lane. It is not
    // a fact about the ad set's parent, and the row must not imply otherwise.
    renderQueue({ actionNow: [orphanAdsetRec()] });

    expect(lineageOf(actionRow("rec_orphan"))).toBe("In Campaign Elsewhere");
    expect(lineageOf(actionRow("rec_orphan"))).not.toContain("also in this lane");
  });

  it("says nothing at all about a campaign with no ad-set row beside it", () => {
    // "0 ad sets" would be a claim about the account. The lane cannot make it.
    renderQueue({ actionNow: [campaignRec()] });

    expect(lineageOf(actionRow("rec_campaign"))).toBeNull();
  });

  it("uses the em dash rather than inventing a parent the payload did not name", () => {
    renderQueue({
      actionNow: [
        metaRec({
          id: "rec_nameless",
          level: "adset",
          campaignId: PARENT,
          campaignName: undefined,
          adsetId: "adset_9",
          adsetName: "Unparented Ad Set",
        }),
      ],
    });

    expect(lineageOf(actionRow("rec_nameless"))).toBe("In —");
  });

  it("leaves the server's lane membership and order exactly as served", () => {
    // The relation is drawn where the row already is. Grouping children under
    // their parent would reorder a queue the server sorted, and a sort order is
    // a decision.
    renderQueue({
      actionNow: [orphanAdsetRec(), campaignRec(), adsetRec()],
      watching: [adsetRec()],
      lane: "action",
    });

    expect(
      Array.from(document.querySelectorAll("[data-meta-exact-action-row]")).map(
        (node) => node.getAttribute("data-meta-exact-action-row"),
      ),
    ).toEqual(["rec_orphan", "rec_campaign", "rec_adset"]);
  });

  it("reads the relation in the Watching lane too, where both levels mix", () => {
    renderQueue({
      watching: [campaignRec(), adsetRec()],
      lane: "watching",
    });

    expect(lineageOf(watchingRow("rec_adset"))).toContain("In Parent Campaign");
    expect(lineageOf(watchingRow("rec_campaign"))).toBe("1 ad set in this lane");
  });
});

describe("the whole queue card is the target, not only the ⋯ glyph", () => {
  it("opens the row's evidence from the card body", () => {
    const onStructureMenu = vi.fn();
    renderQueue({ actionNow: [campaignRec(), adsetRec()], callbacks: { onStructureMenu } });

    fireEvent.click(cardOpen(actionRow("rec_adset")));

    expect(onStructureMenu).toHaveBeenCalledTimes(1);
    expect(onStructureMenu.mock.calls[0]?.[0]?.id).toBe("rec_adset");
  });

  it("names what it opens, and is a real button so Enter and Space activate it", () => {
    // Stated as structure on purpose: jsdom does not run a key event's default
    // activation behaviour, so the honest pin is that this IS a native button —
    // which is what makes Enter and Space work — rather than a div wearing a
    // role. Enter and Space were then exercised in a real browser against
    // Grandmix, where both moved the selection and Space did not scroll.
    renderQueue({ actionNow: [adsetRec()] });
    const open = cardOpen(actionRow("rec_adset"));

    expect(open.tagName).toBe("BUTTON");
    expect(open.getAttribute("type")).toBe("button");
    expect(open.getAttribute("aria-label")).toBe("Open evidence for Child Ad Set");
  });

  it("does not nest the row's controls inside the card control", () => {
    // A `role="button"` wrapper would have been the cheap fix and the wrong one:
    // ARIA gives a button presentational children, so the row's action button
    // and ⋯ glyph would stop being announced at all. The overlay is a sibling of
    // both, which is why they keep their own names and their own clicks.
    renderQueue({ actionNow: [campaignRec()], nodes: ["rec_campaign"] });
    const row = actionRow("rec_campaign");
    const open = cardOpen(row);

    expect(row.getAttribute("role")).toBeNull();
    expect(open.querySelector("button")).toBeNull();
    expect(open.querySelector('[role="button"]')).toBeNull();

    const primary = within(row).getByRole("button", { name: "Rebuild in Launchpad" });
    expect(primary.closest('[role="button"]')).toBeNull();
    expect(open.contains(primary)).toBe(false);
  });

  it("leaves the row's own controls doing their own jobs", () => {
    const onStructurePrimary = vi.fn();
    const onStructureMenu = vi.fn();
    renderQueue({
      actionNow: [campaignRec()],
      nodes: ["rec_campaign"],
      callbacks: { onStructurePrimary, onStructureMenu },
    });
    const row = actionRow("rec_campaign");

    fireEvent.click(within(row).getByRole("button", { name: "Rebuild in Launchpad" }));
    expect(onStructurePrimary).toHaveBeenCalledTimes(1);
    expect(onStructureMenu).not.toHaveBeenCalled();

    const glyph = Array.from(row.querySelectorAll('[role="button"]')).find(
      (node) => node.textContent?.trim() === "⋯",
    );
    fireEvent.click(glyph!);
    expect(onStructureMenu).toHaveBeenCalledTimes(1);
    expect(onStructurePrimary).toHaveBeenCalledTimes(1);
  });

  it("gives the Watching card the same body target as its Review control", () => {
    const onWatchingReview = vi.fn();
    renderQueue({
      watching: [adsetRec()],
      lane: "watching",
      callbacks: { onWatchingReview },
    });
    const row = watchingRow("rec_adset");

    fireEvent.click(cardOpen(row));
    expect(onWatchingReview).toHaveBeenCalledTimes(1);

    fireEvent.click(within(row).getByRole("button", { name: "Review" }));
    expect(onWatchingReview).toHaveBeenCalledTimes(2);
  });

  it("claims no card control for a row the server gave no way to open", () => {
    renderQueue({ actionNow: [campaignRec()], callbacks: {} });

    expect(
      actionRow("rec_campaign").querySelector("[data-meta-exact-card-open]"),
    ).toBeNull();
  });
});

describe("the row the inspector is describing looks like it", () => {
  it("marks the default Action Now row before anything has been clicked", () => {
    // The inspector has always defaulted to the first Action Now row. The queue
    // did not know, so first paint showed an inspector describing a row that
    // looked exactly like the others, and the first click appeared to do
    // nothing at all.
    const viewModel = renderQueue({ actionNow: [campaignRec(), adsetRec()] });

    const first = actionRow("rec_campaign");
    expect(first.getAttribute("aria-current")).toBe("true");
    expect(first.textContent).toContain("Inspecting");
    expect(actionRow("rec_adset").getAttribute("aria-current")).toBeNull();
    // ...and it is the same row the panel is actually describing.
    expect(viewModel.inspector?.entityName).toBe("Parent Campaign");
  });

  it("follows an explicit selection to whichever row the inspector moved to", () => {
    const viewModel = renderQueue({
      actionNow: [campaignRec(), adsetRec()],
      selection: { kind: "structure", recommendationId: "rec_adset" },
    });

    expect(actionRow("rec_adset").getAttribute("aria-current")).toBe("true");
    expect(actionRow("rec_campaign").getAttribute("aria-current")).toBeNull();
    expect(viewModel.inspector?.entityName).toBe("Child Ad Set");
  });

  it("marks a Watching row when the inspector is pointed at one", () => {
    renderQueue({
      watching: [campaignRec(), adsetRec()],
      lane: "watching",
      selection: { kind: "structure", recommendationId: "rec_adset" },
    });

    expect(watchingRow("rec_adset").getAttribute("aria-current")).toBe("true");
    expect(watchingRow("rec_adset").textContent).toContain("Inspecting");
    expect(watchingRow("rec_campaign").getAttribute("aria-current")).toBeNull();
  });

  it("marks nothing when the inspector is suppressed", () => {
    renderQueue({ actionNow: [campaignRec(), adsetRec()], selection: null });

    expect(document.querySelectorAll("[data-meta-exact-selected]")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Inspecting");
  });

  it("says selected in words, not only in colour", () => {
    // A tint and a ring are nothing to a colour-blind operator and nothing at
    // all to a screen reader. The state is a word on the card and an
    // aria-current on the row; the styling is the third signal, not the only.
    renderQueue({ actionNow: [campaignRec()] });
    const row = actionRow("rec_campaign");

    expect(row.getAttribute("aria-current")).toBe("true");
    expect(within(row).getByText("Inspecting")).toBeTruthy();
  });

  it("marks no queue row when the selection is not one of these rows", () => {
    renderQueue({
      actionNow: [campaignRec()],
      selection: { kind: "creative", decisionId: "dec_1" },
    });

    expect(document.querySelectorAll("[data-meta-exact-selected]")).toHaveLength(0);
  });
});
