// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MetaDecisionCenterExact,
  type MetaDecisionCenterExactProps,
  type MetaDecisionCenterExactViewModel,
} from "./MetaDecisionCenterExact";
// The tone the operator actually sees is a class on the rendered node, so the
// tone assertions below compare against the stylesheet's own names rather than
// against a string this test invented.
import styles from "./MetaDecisionCenterExact.module.css";
import type {
  MetaBudgetDecisionEvidenceByDirection,
  MetaBudgetDecisionEvidencePanel,
} from "@/lib/meta/budget-decision-evidence-panel";
import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";

afterEach(cleanup);

function exactViewModel(
  over: Partial<MetaDecisionCenterExactViewModel> = {},
): MetaDecisionCenterExactViewModel {
  return {
    identity: {
      accountLabel: "Exact Account",
      currency: "USD",
      syncedLabel: "synced recently",
      snapshotLabel: "snapshot fixture-date",
      engineLabel: "engine server-version",
      timeLabel: "fixture time",
    },
    activeWindow: "28d",
    counts: {
      structure: "4",
      creatives: "3",
      action: "4",
      watching: "7",
      healthy: "12",
      nonsales: "2",
      archive: "30",
      deferred: "2",
    },
    kpis: {
      spend: {
        value: "$fixture-spend",
        delta: "fixture delta",
        detail: "fixture detail",
      },
      roas: {
        value: "fixture roas",
        target: "fixture target",
        sparkPath: "M0 10 L100 4",
      },
      snapshot: { freshness: "fixture fresh", detail: "fixture source" },
      campaignRoles: {
        coverage: "fixture coverage",
        percentage: "fixture percentage",
      },
      mode: {
        value: "fixture mode",
        chips: [
          { label: "fixture season", tone: "warning" },
          { label: "fixture tracking", tone: "positive" },
        ],
      },
    },
    actionRows: [
      {
        id: "action-a",
        name: "Entity Alpha",
        level: "Campaign",
        chips: ["Chip A", "Chip B"],
        decisionLabel: "Server label Alpha",
        decisionTone: "positive",
        edgeTone: "positive",
        money: "Money Alpha",
        moneySub: "Money detail Alpha",
        confidence: "Server band Alpha",
        confidenceTone: "positive",
        actionLabel: "Server command Alpha",
        actionTone: "positive",
      },
      {
        id: "action-b",
        name: "Entity Beta",
        level: "Ad set",
        chips: ["Chip C"],
        decisionLabel: "Server label Beta",
        decisionTone: "negative",
        edgeTone: "negative",
        money: "Money Beta",
        moneySub: "Money detail Beta",
        confidence: "Server band Beta",
        confidenceTone: "warning",
        actionLabel: "Server command Beta",
        actionTone: "negative",
      },
    ],
    watchSegments: [
      { id: "segment-a", label: "Learning", count: "2" },
      { id: "segment-b", label: "Changed", count: "1" },
      { id: "segment-c", label: "Mid", count: "3" },
      { id: "segment-d", label: "Deferred", count: "2" },
      { id: "segment-e", label: "Signal", count: "1" },
    ],
    watchingRows: [
      {
        id: "watch-a",
        segment: "Learning",
        segmentTone: "info",
        name: "Watching Alpha",
        level: "Campaign",
        note: "Watching reason",
        money: "Watching money",
      },
    ],
    healthyGroups: [
      {
        id: "healthy-a",
        name: "Healthy Alpha",
        strategy: "Strategy Alpha",
        rollup: "Rollup Alpha",
        adsets: [
          {
            id: "healthy-child-a",
            name: "Healthy child Alpha",
            stats: "Stats Alpha",
          },
          {
            id: "healthy-child-b",
            name: "Healthy child Beta",
            stats: "Stats Beta",
          },
        ],
      },
    ],
    nonSales: [
      {
        name: "Non-sales Alpha",
        level: "Campaign",
        contextLabel: "Upper funnel · informational",
        metrics: [
          { id: "metric-a", label: "Metric A", value: "Value A" },
          { id: "metric-b", label: "Metric B", value: "Value B" },
          { id: "metric-c", label: "Metric C", value: "Value C" },
          { id: "metric-d", label: "Metric D", value: "Value D" },
        ],
        note: "Server context only",
      },
    ],
    archiveRows: [
      {
        id: "archive-a",
        name: "Archive Alpha",
        status: "PAUSED",
        statusTone: "warning",
        spend: "Archive spend A",
        note: "Archive note A",
        showResume: true,
      },
      {
        id: "archive-b",
        name: "Archive Beta",
        status: "ARCHIVED",
        statusTone: "neutral",
        spend: "Archive spend B",
        note: "Archive note B",
      },
    ],
    creativePosture: [
      {
        id: "posture-a",
        label: "Posture A",
        value: "Value A",
        detail: "Detail A",
        tone: "negative",
      },
      {
        id: "posture-b",
        label: "Posture B",
        value: "Value B",
        detail: "Detail B",
        tone: "warning",
      },
      {
        id: "posture-c",
        label: "Posture C",
        value: "Value C",
        detail: "Detail C",
        tone: "warning",
      },
      {
        id: "posture-d",
        label: "Posture D",
        value: "Value D",
        detail: "Detail D",
        tone: "automation",
      },
    ],
    creativeDecisions: [
      {
        id: "creative-a",
        name: "Creative Alpha",
        kindShort: "fixture kind",
        edgeTone: "warning",
        decisionLabel: "Server creative label",
        decisionTone: "warning",
        chips: ["Creative chip A", "Creative chip B"],
        sparkPath: "M0 8 L100 12",
        money: "Creative money",
        moneySub: "Creative money detail",
        actionLabel: "Server creative command",
        actionTone: "automation",
      },
    ],
    inspector: {
      entityName: "Inspector Entity",
      entityMeta: "Inspector meta",
      decisionLabel: "Inspector server label",
      tone: "positive",
      serverVerdict: "server supplied verdict",
      contractDetail: "server supplied contract detail",
      reasons: ["Reason A", "Reason B", "Reason C"],
      moneyValue: "Inspector money",
      targetComparison: "Inspector target",
      moneySparkPath: "M0 16 L100 4",
      moneyDetail: "Inspector money detail",
      confidence: "Server confidence band",
      readiness: "Server readiness",
      blockers: "Server blockers",
      blockerTone: "positive",
      advisories: "Server advisories",
      evidence: [
        { id: "evidence-a", label: "Evidence A", value: "Value A" },
        { id: "evidence-b", label: "Evidence B", value: "Value B" },
        { id: "evidence-c", label: "Evidence C", value: "Value C" },
        { id: "evidence-d", label: "Evidence D", value: "Value D" },
      ],
      actionLabel: "Inspector server command",
      actionTone: "positive",
      provenance: "server provenance",
    },
    ...over,
  };
}

function renderExact(props: Partial<MetaDecisionCenterExactProps> = {}) {
  return render(
    <MetaDecisionCenterExact viewModel={exactViewModel()} {...props} />,
  );
}

function root(): HTMLElement {
  const node = document.querySelector<HTMLElement>(
    '[data-screen-label="Meta Decision Center"]',
  );
  if (!node) throw new Error("Meta Decision Center root was not rendered");
  return node;
}

describe("MetaDecisionCenterExact canonical desktop anatomy", () => {
  it("renders the header, KPIs and controls before the decision-first workspace", () => {
    renderExact();

    // Header, KPI band, scope row and lane toolbar lead directly into the
    // decision workspace, matching the accepted V2 panel hierarchy.
    expect(root().children).toHaveLength(5);
    expect(root().children[0]?.textContent).toContain("Decision Center");
    expect(root().children[1]?.getAttribute("data-meta-exact-section")).toBe(
      "kpis",
    );
    expect(root().children[1]?.children).toHaveLength(2);
    expect(root().children[2]?.textContent).toContain("Campaigns & Ad sets");
    expect(
      root().children[3]?.hasAttribute("data-meta-exact-lane-toolbar"),
    ).toBe(true);
    expect(root().children[4]?.hasAttribute("data-meta-exact-workspace")).toBe(
      true,
    );
    expect(
      document.querySelector("[data-meta-exact-inactive-strip]"),
    ).toBeNull();
    expect(
      document.querySelector("[data-meta-exact-operator-summary]"),
    ).toBeNull();

    expect(
      Array.from(document.querySelectorAll("[data-meta-exact-scope]")).map(
        (node) => node.getAttribute("data-meta-exact-scope"),
      ),
    ).toEqual(["structure", "creatives"]);
    expect(
      Array.from(document.querySelectorAll("[data-meta-exact-lane]")).map(
        (node) => node.getAttribute("data-meta-exact-lane"),
      ),
    ).toEqual(["action", "needsres", "watching", "healthy"]);
    expect(
      Array.from(document.querySelectorAll("[data-meta-exact-action-row]")).map(
        (node) => node.textContent,
      ),
    ).toEqual([
      expect.stringContaining("Entity Alpha"),
      expect.stringContaining("Entity Beta"),
    ]);

    const workspace = document.querySelector("[data-meta-exact-workspace]");
    expect(workspace?.children).toHaveLength(2);
    expect(
      workspace?.children[1]?.hasAttribute("data-meta-exact-inspector"),
    ).toBe(true);
  });

  it("keeps the canonical fixed captions and control order", () => {
    renderExact();

    // The four window pills were REMOVED from this header on purpose: the
    // shell topbar picker already owns the window and offers more than these
    // four, so the header was a second writer for one value. Pinned as an
    // absence so nobody reintroduces the split by restoring the caption.
    expect(document.querySelectorAll("[data-meta-exact-window]")).toHaveLength(
      0,
    );
    expect(
      screen.queryByRole("button", { name: "Refresh decisions" }),
    ).toBeNull();
    expect(screen.getByText("Spend · today")).toBeTruthy();
    expect(screen.getByText("ROAS · 28d")).toBeTruthy();
    expect(screen.queryByText("Recommendation snapshot")).toBeNull();
    expect(screen.queryByText("Campaign roles")).toBeNull();
    expect(screen.queryByText("Automatic inference")).toBeNull();
    expect(screen.queryByText("Mode")).toBeNull();
    expect(screen.queryByRole("button", { name: "+ New campaign" })).toBeNull();
    expect(
      screen.getByRole("option", { name: "Sort: Money at stake" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: Priority" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: Age" })).toBeTruthy();
  });

  it("localizes the spend date without exposing campaign-role diagnostics", () => {
    const viewModel = exactViewModel();
    viewModel.kpis = {
      ...viewModel.kpis,
      spend: {
        ...viewModel.kpis?.spend,
        date: "2026-09-03",
      },
      campaignRoles: {
        coverage: "5/5",
        percentage: "100%",
        status: "resolved",
        activeCount: "5",
        unresolvedCount: "0",
        actionAuthoritativeCount: "0",
      },
    };

    render(
      <ZeroBaseCopyProvider language="tr">
        <MetaDecisionCenterExact viewModel={viewModel} />
      </ZeroBaseCopyProvider>,
    );

    expect(screen.getByText("Harcama · 2026-09-03")).toBeTruthy();
    expect(screen.queryByText(/Otomatik çıkarım/)).toBeNull();
    expect(screen.queryByText("Spend · 2026-09-03")).toBeNull();
  });

  it("keeps account-coverage diagnostics out of the buyer surface", () => {
    const viewModel = exactViewModel({
      assignedAccountStates: [
        {
          providerAccountId: "act_1",
          accountName: "Hesap",
          selectionState: "selected",
          accountCurrency: "TRY",
          accountTimezone: "Europe/Istanbul",
          latestFactDate: "2026-09-03",
          spend14d: 100,
          latestDecisionAsOf: "2026-09-03",
          latestDecisionRows: 2,
          latestDecisionAuthorizedRows: 0,
          policy: "Salt okunur kapsam kanıtı.",
        },
      ],
    });

    render(
      <ZeroBaseCopyProvider language="tr">
        <MetaDecisionCenterExact viewModel={viewModel} />
      </ZeroBaseCopyProvider>,
    );

    expect(screen.queryByText("1 atanmış Meta hesabı")).toBeNull();
    expect(screen.queryByText(/Seçili hesap verileri/)).toBeNull();
    expect(screen.getByText("Entity Alpha")).toBeTruthy();
  });

  it("keeps a creative-only action directly reachable from the V2 scope control", () => {
    const viewModel = exactViewModel({
      counts: {
        structure: "0",
        creatives: "1",
        action: "0",
        needsres: "0",
        watching: "0",
      },
      operatorSummary: {
        action: "1",
        needsResolution: "0",
        watching: "0",
        creatives: "1",
        actionScope: "creatives",
      },
    });
    renderExact({ viewModel });

    fireEvent.click(
      document.querySelector('[data-meta-exact-scope="creatives"]')!,
    );
    expect(
      document
        .querySelector('[data-meta-exact-scope="creatives"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      document.querySelector("[data-meta-exact-creative-toolbar]"),
    ).toBeTruthy();
  });

  it("exposes each scope's server counts without a duplicate summary panel", () => {
    const onLaneChange = vi.fn();
    const onScopeChange = vi.fn();
    const viewModel = exactViewModel({
      operatorSummary: {
        action: 3,
        needsResolution: 0,
        watching: 0,
        creatives: 1,
        actionScope: "structure",
        scopeCounts: {
          structure: { action: 2, needsResolution: 0, watching: 0 },
          creatives: { action: 1, needsResolution: 0, watching: 0 },
        },
      },
    });

    renderExact({ viewModel, onLaneChange, onScopeChange });

    expect(
      document.querySelector("[data-meta-exact-operator-summary]"),
    ).toBeNull();
    fireEvent.click(
      document.querySelector('[data-meta-exact-scope="creatives"]')!,
    );
    expect(onScopeChange).toHaveBeenLastCalledWith("creatives");
    expect(
      document.querySelector('[data-meta-exact-creative-lane="action"]')
        ?.textContent,
    ).toContain("1");
    expect(onLaneChange).not.toHaveBeenCalled();
  });

  it("shows the canonical default inline inspector without a row-selection dependency", () => {
    renderExact();
    const inspector = document.querySelector("[data-meta-exact-inspector]");

    expect(inspector).toBeTruthy();
    const text = inspector?.textContent ?? "";
    const ordered = [
      "Decision details",
      "Inspector server label",
      "Inspector Entity",
      "What to do",
      "server supplied verdict",
      "Why",
      "Reason A",
      "Key metrics",
      "Inspector money",
      "Confidence",
      "Server confidence band",
    ];
    let cursor = -1;
    for (const caption of ordered) {
      const next = text.indexOf(caption);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(text).not.toContain("Engine reasoning");
    expect(text).not.toContain("Server blockers");
    expect(text).not.toContain("Server advisories");
    expect(text).not.toContain("server provenance");
  });

  it("omits unavailable inspector sections instead of rendering operator-facing dash rows", () => {
    const base = exactViewModel();
    render(
      <MetaDecisionCenterExact
        viewModel={exactViewModel({
          inspector: {
            ...base.inspector,
            contractDetail: "—",
            reasons: ["—", null],
            targetComparison: "—",
            moneyDetail: "—",
            blockers: "—",
            advisories: "—",
            evidence: [
              { id: "empty", label: "—", value: "—" },
              { id: "missing-value", label: "Bidding", value: "—" },
            ],
            provenance: "—",
          },
        })}
      />,
    );

    const inspector = document.querySelector("[data-meta-exact-inspector]");
    expect(inspector).toBeTruthy();
    expect(
      within(inspector as HTMLElement).queryByText("Engine reasoning"),
    ).toBeNull();
    expect(within(inspector as HTMLElement).queryByText("Blockers")).toBeNull();
    expect(
      within(inspector as HTMLElement).queryByText("Advisories"),
    ).toBeNull();
    expect(within(inspector as HTMLElement).queryByText("Bidding")).toBeNull();
    expect(inspector?.textContent).not.toContain("—");
  });
});

describe("MetaDecisionCenterExact branches and callbacks", () => {
  it("routes directly from the compact lane controls without an extra summary card", () => {
    const onLaneChange = vi.fn();
    const onScopeChange = vi.fn();
    render(
      <MetaDecisionCenterExact
        onLaneChange={onLaneChange}
        onScopeChange={onScopeChange}
        viewModel={exactViewModel({
          counts: {
            structure: 24,
            creatives: 8,
            action: 0,
            needsres: 12,
            watching: 4,
            healthy: 8,
            nonsales: 0,
            archive: 0,
            deferred: 0,
          },
        })}
      />,
    );

    fireEvent.click(
      document.querySelector('[data-meta-exact-lane="needsres"]')!,
    );
    expect(onLaneChange).toHaveBeenLastCalledWith("needsres");
    expect(onScopeChange).not.toHaveBeenCalled();
  });

  it("renders one concise safe next step on each compact blocked row", () => {
    const viewModel = exactViewModel({
      needsResolutionRows: [
        {
          id: "blocked-a",
          name: "Blocked Alpha",
          level: "Campaign",
          chips: ["Auto · Main"],
          selected: true,
          decisionLabel: "Hold",
          decisionTone: "warning",
          blocker: "This change must be completed manually in Meta.",
          blockerBuyerFacing: true,
          blockerCount: 3,
          blockerTone: "warning",
          resolution: "Review and apply this change manually.",
          money: "$420 · ROAS 2.10",
          confidence: "Low",
          confidenceTone: "warning",
          staleDemoted: true,
          staleDemotedReason: "Confidence capped by server evidence",
        },
        {
          id: "blocked-b",
          name: "Blocked Beta",
          blocker: "A fresh Meta safety check is required.",
          blockerBuyerFacing: true,
          resolution: "Refresh Meta data and run the safety check again.",
        },
        {
          id: "blocked-c",
          name: "Blocked Gamma",
          blocker: "missing_executor_schema_receipt",
          resolution: "Review and apply this change manually.",
        },
      ],
    });
    renderExact({ lane: "needsres", viewModel });

    const row = document.querySelector<HTMLElement>(
      '[data-meta-exact-needsres-row="blocked-a"]',
    );
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Auto · Main");
    expect(row?.textContent).toContain("Low confidence");
    expect(row?.textContent).not.toContain("· capped");
    expect(
      Array.from(row?.querySelectorAll("span") ?? []).find((element) =>
        element.textContent?.includes("Low confidence"),
      )?.getAttribute("title"),
    ).toBe("Confidence capped by server evidence");
    expect(row?.textContent).not.toContain("3 checks");
    expect(row?.textContent).toContain("$420 · ROAS 2.10");
    expect(row?.textContent).not.toContain("Review and apply");
    expect(row?.textContent).toContain(
      "This change must be completed manually in Meta.",
    );
    expect(row?.querySelectorAll("[data-el='resolution-step']")).toHaveLength(
      1,
    );
    const preferredResolution = document.querySelector<HTMLElement>(
      '[data-meta-exact-needsres-row="blocked-b"]',
    );
    expect(preferredResolution?.textContent).toContain(
      "Refresh Meta data and run the safety check again.",
    );
    expect(preferredResolution?.textContent).not.toContain(
      "A fresh Meta safety check is required.",
    );
    expect(
      preferredResolution?.querySelectorAll("[data-el='resolution-step']"),
    ).toHaveLength(1);
    const unsafeFallback = document.querySelector<HTMLElement>(
      '[data-meta-exact-needsres-row="blocked-c"]',
    );
    expect(unsafeFallback?.textContent).toContain("Open decision details.");
    expect(unsafeFallback?.textContent).not.toContain(
      "missing_executor_schema_receipt",
    );
    expect(
      unsafeFallback?.querySelectorAll("[data-el='resolution-step']"),
    ).toHaveLength(1);
    expect(row?.querySelector("[data-meta-exact-needsres-step]")).toBeNull();
    expect(document.querySelector("[data-meta-exact-inspector]")).toBeTruthy();
  });

  it("renders the useful watching and healthy branches without extra lanes", () => {
    renderExact();

    fireEvent.click(
      document.querySelector('[data-meta-exact-lane="watching"]')!,
    );
    expect(screen.getByText("Learning 2")).toBeTruthy();
    expect(screen.getByText("Watching Alpha")).toBeTruthy();

    fireEvent.click(
      document.querySelector('[data-meta-exact-lane="healthy"]')!,
    );
    expect(screen.getByText("Healthy Alpha")).toBeTruthy();
    expect(screen.getByText("Healthy child Alpha")).toBeTruthy();

    expect(
      document.querySelector('[data-meta-exact-lane="nonsales"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-meta-exact-lane="archive"]'),
    ).toBeNull();
  });

  it("renders the creative posture before creative decisions and emits callback-only actions", () => {
    const onOpen = vi.fn();
    const onPrimary = vi.fn();
    const onOpenCreativeStudio = vi.fn();
    const viewModel = exactViewModel();
    viewModel.creativeDecisions = [
      { ...viewModel.creativeDecisions![0]!, onOpen, onPrimary },
    ];
    render(
      <MetaDecisionCenterExact
        defaultScope="creatives"
        onOpenCreativeStudio={onOpenCreativeStudio}
        viewModel={viewModel}
      />,
    );

    // The STRUCTURE toolbar still stays out of this scope: its lane pills and
    // its sort apply to structure rows, so rendering either here would be a
    // control that changes nothing.
    expect(document.querySelector("[data-meta-exact-lane-toolbar]")).toBeNull();
    const queue = document.querySelector(
      "[data-meta-exact-workspace]",
    )?.firstElementChild;
    expect(
      queue?.children[0]?.hasAttribute("data-meta-exact-creative-posture"),
    ).toBe(true);
    expect(queue?.children[0]?.children).toHaveLength(4);
    // A view model with rows but no served states still renders those rows: the
    // groups are how state is shown, not a precondition for showing anything.
    expect(
      queue?.children[1]?.getAttribute("data-meta-exact-creative-row"),
    ).toBe("creative-a");
    // LAW: the closing sentence is served, never authored here. The UI used to
    // assert "the engine makes only three ad-level calls -- refresh, retire,
    // scale winner", which is a second decision vocabulary maintained in the
    // component; real accounts serve "Watch" and "Evidence pending" and no
    // account serves "retire".
    expect(screen.queryByText(/only three ad-level calls/)).toBeNull();

    fireEvent.click(
      // The accessible name now states both halves: the served action label AND
      // that pressing it opens evidence. There is exactly one creative callback
      // (`onCreativeReview`), so the caption names an action the control does not
      // perform — legible in context to a sighted operator, invisible to a screen
      // reader until the name said so. The visible caption is unchanged.
      screen.getByRole("button", { name: /^Review evidence — / }),
    );
    expect(onPrimary).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();

    expect(screen.queryByText("Evidence →")).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Open Creative Studio →"));
    expect(onOpenCreativeStudio).toHaveBeenCalledOnce();
  });

  /**
   * LAW: un-decided ACTIVE inventory reaches NO lane, NO count and NO control.
   *
   * The Decision Center used to render one placeholder row per ACTIVE Ad that
   * no producer had decided — on Grandmix that was the entire page, and the
   * real held verdicts were pushed off it by rows whose only content was that
   * nothing had been decided. The producer no longer builds those rows at all;
   * the population is a count and one sentence.
   *
   * This is the surface half of that claim, which the route and presentation
   * tests cannot make: with the population present and non-zero, the rendered
   * Creatives scope shows zero decision rows, zero primary controls, and the
   * sentence — and it says the empty lane is empty rather than leaving the
   * absence unexplained.
   */
  it("renders the inventory sentence and no rows when nothing was decided", () => {
    const viewModel = exactViewModel();
    viewModel.creativeDecisions = [];
    viewModel.creativeGroups = [];
    viewModel.creativePosture = [];
    viewModel.creativesNotice =
      "60 ACTIVE Ads have no exact Ad-grain decision yet, so they are not listed as decisions.";

    render(
      <MetaDecisionCenterExact
        defaultScope="creatives"
        viewModel={viewModel}
      />,
    );

    const html = root().innerHTML;
    // The sentence is there.
    expect(
      document.querySelector("[data-meta-exact-creatives-notice]")?.textContent,
    ).toBe(
      "60 ACTIVE Ads have no exact Ad-grain decision yet, so they are not listed as decisions.",
    );
    // And nothing that looks like a decision is.
    expect(html).not.toContain("data-meta-exact-creative-row");
    expect(html).not.toContain("data-meta-exact-creative-served-action");
    expect(html).not.toContain("Evidence pending");
    expect(html).not.toContain("Wait for ad-level decision");
    // The empty lane says it is empty rather than rendering nothing at all.
    expect(html).toContain("data-meta-exact-lane-empty");
  });

  /**
   * LAW: source degradation is a property of the SOURCE, never of the row count.
   *
   * The only path that reached the desktop used to be the creatives notice, and
   * it rendered under `decisions.length === 0`. Grandmix serves 60 rows against
   * a pre-cap count of 80 with two capabilities `unavailable` and two
   * `proposed`, so on every real account the condition was false and the screen
   * said nothing. This pins that the panel renders WITH rows, and that it sits
   * between the posture band and the first row rather than under the queue
   * where nobody scrolls.
   */
  it("keeps a non-empty creative queue useful without raw source diagnostics", () => {
    const viewModel = exactViewModel();
    // Buyer language only. The producer code that used to be appended here as
    // "Source: native_account_manifest_incomplete." is asserted below to be
    // absent from the rendered text, and it keeps its own labelled row in the
    // diagnostics panel that this surface does not render.
    viewModel.creativesNotice =
      "Legacy creative-grain decisions cannot authorize Ad writes.";
    viewModel.sourceProvenance = {
      headline: "legacy_creative · degraded",
      tone: "warning",
      coverageSummary: "60 shown · 80 eligible pre-cap (derived)",
      capabilitySummary: "2 of 8 not available",
      source: [
        {
          id: "authority",
          label: "Authority",
          value: "legacy_creative",
          tone: "warning",
        },
        {
          id: "fallback-reason",
          label: "Fallback reason",
          value: "native_account_manifest_incomplete",
        },
      ],
      coverage: [
        { id: "shown", label: "Shown here", value: "60" },
        // Two eligible pre-cap counts, each under a label naming which it is:
        // the read model's served count and the presentation's own served count.
        // @see meta-decision-center-exact-adapter.ts — sourceProvenance.
        {
          id: "queue-eligible-pre-cap",
          label: "Eligible (pre-cap) · read model",
          value: "71",
        },
        {
          id: "ads-eligible-pre-cap",
          label: "Eligible (pre-cap) · served payload",
          value: "80",
        },
      ],
      suppression: [{ id: "suppressed-count", label: "Withheld", value: "0" }],
      limitations: [
        { id: "limitation-count", label: "Served limitations", value: "1" },
        {
          id: "limitation-legacy_creative_review_only",
          label: "legacy_creative_review_only",
          value:
            "Legacy creative-grain decisions remain visible for continuity.",
          tone: "warning",
        },
      ],
      capabilityGaps: [
        {
          id: "responseAttribution",
          label: "Response attribution",
          status: "Unavailable",
          reason: "native_response_source_unavailable",
          tone: "negative",
        },
      ],
    };

    render(
      <MetaDecisionCenterExact
        defaultScope="creatives"
        viewModel={viewModel}
      />,
    );

    const queue = document.querySelector(
      "[data-meta-exact-workspace]",
    )?.firstElementChild;
    expect(
      queue?.children[0]?.hasAttribute("data-meta-exact-creative-posture"),
    ).toBe(true);
    /*
     * The notice sits BETWEEN the posture band and the first row.
     *
     * It was a declared prop that reached no pixel: nothing in this component
     * destructured `creativesNotice` and nothing rendered it, so the adapter
     * computed the sentence on every render and threw it away. Placing it here
     * is the point of the law above — an operator reads why the source is
     * degraded before reading the rows it produced, not after scrolling past
     * them.
     */
    expect(
      queue?.children[1]?.hasAttribute("data-meta-exact-creatives-notice"),
    ).toBe(true);
    expect(queue?.children[1]?.textContent).toBe(
      "Legacy creative-grain decisions cannot authorize Ad writes.",
    );
    expect(
      queue?.children[2]?.getAttribute("data-meta-exact-creative-row"),
    ).toBe("creative-a");
    expect(
      document.querySelector("[data-meta-exact-source-provenance]"),
    ).toBeNull();
    expect(root().textContent).not.toContain("legacy_creative · degraded");
    expect(root().textContent).not.toContain(
      "native_account_manifest_incomplete",
    );
    expect(root().textContent).not.toContain(
      "native_response_source_unavailable",
    );
  });

  /**
   * LAW: an absent field is an em dash; a measured zero stays 0.
   *
   * Both render as "nothing to worry about" if they are conflated, and they are
   * opposite facts: "the server withheld nothing" is knowledge, "we could not
   * read the envelope" is not.
   */
  it("does not expose unserved source fields or backend census values", () => {
    const viewModel = exactViewModel();
    viewModel.sourceProvenance = {
      headline: "— · —",
      tone: "neutral",
      coverageSummary: "0 shown · — eligible pre-cap (derived)",
      capabilitySummary: "capabilities —",
      source: [{ id: "fallback-reason", label: "Fallback reason", value: "—" }],
      suppression: [{ id: "suppressed-count", label: "Withheld", value: "0" }],
    };

    render(
      <MetaDecisionCenterExact
        defaultScope="creatives"
        viewModel={viewModel}
      />,
    );

    expect(
      document.querySelector("[data-meta-exact-source-provenance]"),
    ).toBeNull();
    expect(root().textContent).not.toContain("Fallback reason");
    expect(root().textContent).not.toContain("Withheld0");
  });

  /**
   * LAW: no row may be hidden by a filter the operator cannot see.
   *
   * The search term is ONE piece of page state and it filtered creative rows
   * all along, but the only box that could show or clear it lived in the
   * structure toolbar. Typing a term in Campaigns & Ad sets and switching to
   * Creatives therefore hid rows with no visible cause and no way out. The box
   * follows the term into this scope; clearing the term on scope change was the
   * other option and is worse, because it silently discards something the
   * operator typed and it is also what the deep link restores.
   */
  it("keeps a search control in the creatives scope, seeded with the live term", () => {
    const onSearchChange = vi.fn();
    render(
      <MetaDecisionCenterExact
        defaultScope="creatives"
        initialQuery="hook"
        onSearchChange={onSearchChange}
        viewModel={exactViewModel()}
      />,
    );

    const search = screen.getByRole("textbox", { name: "Find creatives" });
    expect((search as HTMLInputElement).value).toBe("hook");
    // The structure toolbar's lane pills and sort stay out: they act on
    // structure rows, so here they would be controls that change nothing.
    expect(document.querySelector("[data-meta-exact-lane-toolbar]")).toBeNull();
    expect(screen.queryByLabelText("Sort decisions")).toBeNull();

    fireEvent.change(search, { target: { value: "angel" } });
    expect(onSearchChange).toHaveBeenCalledWith("angel");
  });

  /**
   * LAW: a blocked decision must never render as an ordinary recommendation.
   *
   * The server keeps `act`, `blocked` and `monitor` apart and the scope pooled
   * them into one flat list, so a withheld call sat as a visual peer of an
   * authorized one. The groups are how the state is shown; they move no row and
   * invent no state.
   */
  it("splits the creative queue by the served state and prints each group's counts", () => {
    render(
      <MetaDecisionCenterExact
        lane="needsres"
        scope="creatives"
        viewModel={{
          creativeGroups: [
            {
              id: "blocked",
              label: "Blocked",
              tone: "warning",
              count: "2 of 80 decisions",
              note: "Evidence pending",
              rows: [
                {
                  id: "row-blocked",
                  name: "Blocked row",
                  stateLabel: "Blocked",
                  stateTone: "warning",
                  blockedNote:
                    "Exact Ad-grain decision evidence is unavailable",
                  actionLabel: "Evidence pending",
                },
              ],
            },
            {
              id: "monitor",
              label: "Monitor",
              tone: "neutral",
              count: "1 decision",
              note: "Watch",
              rows: [
                {
                  id: "row-monitor",
                  name: "Monitor row",
                  stateLabel: "Monitor",
                  actionLabel: "Watch",
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(
      Array.from(
        document.querySelectorAll("[data-meta-exact-creative-group]"),
      ).map((node) => node.getAttribute("data-meta-exact-creative-group")),
    ).toEqual(["blocked"]);
    expect(screen.getByText("2 of 80 decisions")).toBeTruthy();
    expect(
      document
        .querySelector('[data-meta-exact-creative-row="row-blocked"]')
        ?.getAttribute("data-meta-exact-creative-state"),
    ).toBe("Blocked");
    expect(
      screen.getByText("Exact Ad-grain decision evidence is unavailable"),
    ).toBeTruthy();
    // The blocked group already states the row's state. The row keeps one
    // next step and one evidence control instead of repeating the same held
    // state as a badge, action line and blocker line.
    for (const rowId of ["row-blocked"] as const) {
      const row = document.querySelector(
        `[data-meta-exact-creative-row="${rowId}"]`,
      );
      expect(
        row?.querySelectorAll("[data-meta-exact-creative-next-step]"),
      ).toHaveLength(1);
      expect(
        row?.querySelector("[data-meta-exact-creative-served-action]"),
      ).toBeNull();
      expect(
        row?.querySelector("[data-meta-exact-creative-row-state]"),
      ).toBeNull();
      const review = row?.querySelector<HTMLButtonElement>(
        "[data-meta-exact-creative-review]",
      );
      expect(review?.textContent).toBe("Review evidence");
      expect(review?.disabled).toBe(true);
    }
  });

  it("filters each creative summary route to its matching served state", () => {
    const viewModel: MetaDecisionCenterExactViewModel = {
      creativeGroups: [
        {
          id: "act",
          label: "Act",
          rows: [{ id: "act-row", name: "Act row" }],
        },
        {
          id: "blocked",
          label: "Blocked",
          rows: [{ id: "blocked-row", name: "Blocked row" }],
        },
        {
          id: "monitor",
          label: "Monitor",
          rows: [{ id: "monitor-row", name: "Monitor row" }],
        },
      ],
    };
    const rendered = render(
      <MetaDecisionCenterExact
        lane="action"
        scope="creatives"
        viewModel={viewModel}
      />,
    );
    const renderedGroups = () =>
      Array.from(
        document.querySelectorAll("[data-meta-exact-creative-group]"),
      ).map((node) => node.getAttribute("data-meta-exact-creative-group"));

    expect(renderedGroups()).toEqual(["act"]);
    rendered.rerender(
      <MetaDecisionCenterExact
        lane="needsres"
        scope="creatives"
        viewModel={viewModel}
      />,
    );
    expect(renderedGroups()).toEqual(["blocked"]);
    rendered.rerender(
      <MetaDecisionCenterExact
        lane="watching"
        scope="creatives"
        viewModel={viewModel}
      />,
    );
    expect(renderedGroups()).toEqual(["monitor"]);
  });

  it("keeps all creative decision lanes reachable after switching scopes", () => {
    render(
      <MetaDecisionCenterExact
        defaultLane="watching"
        viewModel={{
          operatorSummary: {
            scopeCounts: {
              creatives: { action: 1, needsResolution: 1, watching: 1 },
            },
          },
          creativeGroups: [
            {
              id: "act",
              label: "Act",
              rows: [{ id: "act-row", name: "Act row" }],
            },
            {
              id: "blocked",
              label: "Blocked",
              rows: [{ id: "blocked-row", name: "Blocked row" }],
            },
            {
              id: "monitor",
              label: "Monitor",
              rows: [{ id: "monitor-row", name: "Monitor row" }],
            },
          ],
        }}
      />,
    );

    fireEvent.click(
      document.querySelector('[data-meta-exact-scope="creatives"]')!,
    );
    const creativeLaneToolbar = document.querySelector(
      "[data-meta-exact-creative-lane-toolbar]",
    );
    expect(creativeLaneToolbar).toBeTruthy();
    expect(
      creativeLaneToolbar?.querySelectorAll("[data-meta-exact-creative-lane]"),
    ).toHaveLength(3);
    expect(
      document.querySelector('[data-meta-exact-creative-group="monitor"]'),
    ).toBeTruthy();

    fireEvent.keyDown(creativeLaneToolbar!, { key: "ArrowRight" });
    expect(
      document.querySelector('[data-meta-exact-creative-lane="action"]'),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      document.querySelector('[data-meta-exact-creative-group="act"]'),
    ).toBeTruthy();

    fireEvent.keyDown(creativeLaneToolbar!, { key: "ArrowLeft" });
    expect(
      document.querySelector('[data-meta-exact-creative-lane="watching"]'),
    ).toHaveAttribute("aria-checked", "true");

    fireEvent.click(
      document.querySelector('[data-meta-exact-creative-lane="action"]')!,
    );
    expect(
      document.querySelector('[data-meta-exact-creative-group="act"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-meta-exact-creative-group="monitor"]'),
    ).toBeNull();
  });

  it("normalizes a structure-only lane when entering Creatives", () => {
    render(
      <MetaDecisionCenterExact
        defaultLane="healthy"
        viewModel={{
          operatorSummary: {
            scopeCounts: {
              creatives: { action: 1, needsResolution: 1, watching: 1 },
            },
          },
          creativeGroups: [
            {
              id: "act",
              label: "Act",
              rows: [{ id: "act-row", name: "Act row" }],
            },
            {
              id: "blocked",
              label: "Blocked",
              rows: [{ id: "blocked-row", name: "Blocked row" }],
            },
            {
              id: "monitor",
              label: "Monitor",
              rows: [{ id: "monitor-row", name: "Monitor row" }],
            },
          ],
        }}
      />,
    );

    fireEvent.click(
      document.querySelector('[data-meta-exact-scope="creatives"]')!,
    );

    const actionRadio = document.querySelector(
      '[data-meta-exact-creative-lane="action"]',
    );
    expect(actionRadio).toHaveAttribute("aria-checked", "true");
    expect(actionRadio).toHaveAttribute("tabindex", "0");
    expect(
      document.querySelector('[data-meta-exact-creative-group="act"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-meta-exact-creative-group="blocked"]'),
    ).toBeNull();
  });

  // The window pills are gone. The shell topbar picker owns the window and
  // offers a wider vocabulary than the four this header carried; keeping both
  // meant two WRITERS for one value, which is the split the single date
  // authority removed everywhere else. The remaining controls still emit
  // their values verbatim, which is what this test is really for.
  it("emits scope, lane, sort and search values without transforming them", () => {
    const onScopeChange = vi.fn();
    const onLaneChange = vi.fn();
    const onSortChange = vi.fn();
    const onSearchChange = vi.fn();
    renderExact({
      onScopeChange,
      onLaneChange,
      onSortChange,
      onSearchChange,
    });

    fireEvent.click(
      document.querySelector('[data-meta-exact-lane="healthy"]')!,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Sort decisions" }), {
      target: { value: "age" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Find entities" }), {
      target: { value: "needle" },
    });
    fireEvent.click(
      document.querySelector('[data-meta-exact-scope="creatives"]')!,
    );

    expect(onLaneChange).toHaveBeenCalledWith("healthy");
    expect(onSortChange).toHaveBeenCalledWith("age");
    expect(onSearchChange).toHaveBeenCalledWith("needle");
    expect(onScopeChange).toHaveBeenCalledWith("creatives");
  });
});

describe("MetaDecisionCenterExact fail-closed presentation boundary", () => {
  it("uses em dashes for absent payload fields without prototype fallback values", () => {
    render(<MetaDecisionCenterExact viewModel={{}} />);

    expect(
      root().querySelector('[data-meta-exact-section="kpis"]')?.children,
    ).toHaveLength(2);
    expect((root().textContent?.match(/—/g) ?? []).length).toBeGreaterThan(0);
    expect(root().textContent).not.toContain("undefined");
    expect(root().textContent).not.toContain("null");
    expect(root().textContent).not.toContain("NaN");
    /*
     * No selection, no panel.
     *
     * This used to assert the opposite, and the opposite was the defect: with
     * no inspector in the view model the panel rendered anyway, so a workspace
     * that had not resolved drew a fully formed evidence column of em dashes
     * beside an empty queue. An absent panel is the honest shape; the em-dash
     * law below is about a panel that HAS a selection whose fields were not
     * served.
     */
    expect(document.querySelector("[data-meta-exact-inspector]")).toBeNull();
  });

  it("still em-dashes a selected row whose fields were not served", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={{ inspector: { entityName: null } }}
      />,
    );

    const inspector = document.querySelector("[data-meta-exact-inspector]");
    expect(inspector).toBeTruthy();
    expect(inspector?.textContent).not.toContain("undefined");
    expect(inspector?.textContent).not.toContain("null");
    expect(inspector?.textContent).toContain("—");
  });

  it("names the inert action buttons whose whole label is the em dash", () => {
    // The geometry is right — the button stays, dimmed and inert — but its
    // rendered label is one dash, so it announced as an unnamed dimmed button.
    render(
      <MetaDecisionCenterExact
        viewModel={{ actionRows: [{ id: "unserved" }] }}
      />,
    );

    const unnamed = Array.from(document.querySelectorAll("button")).filter(
      (button) =>
        button.textContent?.trim() === "—" &&
        !button.getAttribute("aria-label") &&
        !button.getAttribute("title"),
    );
    expect(unnamed).toEqual([]);

    const rowAction = screen.getByRole("button", {
      name: "No action available: this decision was served without one",
    });
    expect(rowAction).toBeDisabled();
    expect(rowAction.textContent).toBe("—");
  });

  it("omits an inspector action when the server did not authorize one", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={{ inspector: { entityName: "Selected but unserved" } }}
      />,
    );

    const inspector = document.querySelector("[data-meta-exact-inspector]");
    expect(inspector).toBeTruthy();
    expect(inspector?.querySelector("button")).toBeNull();
  });

  it("names the creative lane's inert action button too", () => {
    render(
      <MetaDecisionCenterExact
        defaultScope="creatives"
        viewModel={{ creativeDecisions: [{ id: "unserved" }] }}
      />,
    );

    const unnamed = Array.from(document.querySelectorAll("button")).filter(
      (button) =>
        button.textContent?.trim() === "—" &&
        !button.getAttribute("aria-label") &&
        !button.getAttribute("title"),
    );
    expect(unnamed).toEqual([]);
    expect(
      screen.getByRole("button", {
        name: /^Evidence unavailable for /,
      }),
    ).toBeDisabled();
  });

  it("leaves a served action label as its own accessible name", () => {
    renderExact();
    const named = Array.from(document.querySelectorAll("button")).filter(
      (button) =>
        button.getAttribute("aria-label")?.startsWith("No action available"),
    );
    expect(named).toEqual([]);
  });

  it("shows Resume only from the explicit visual flag and keeps it disabled without authority", () => {
    const onResume = vi.fn();
    const viewModel = exactViewModel({
      archiveRows: [
        { id: "no-flag", status: "PAUSED", onResume },
        { id: "flag-no-callback", status: "PAUSED", showResume: true },
        {
          id: "flag-with-callback",
          status: "PAUSED",
          showResume: true,
          onResume,
        },
      ],
    });
    render(
      <MetaDecisionCenterExact defaultLane="archive" viewModel={viewModel} />,
    );

    const buttons = screen.getAllByRole("button", { name: "Resume" });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).not.toBeDisabled();
    fireEvent.click(buttons[1]!);
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("does not add non-canonical controls, receipts or decision-core hooks", () => {
    renderExact();
    const html = root().innerHTML;
    const forbiddenVisibleCopy = [
      "Since last snapshot",
      "History",
      "Min spend",
      "Account structure",
      "Read evidence",
      "Authority",
      "Nothing selected",
      "Launchpad bridge",
      "Receipt",
    ];
    for (const copy of forbiddenVisibleCopy) expect(html).not.toContain(copy);
    expect(root().querySelector('input[type="checkbox"]')).toBeNull();

    const source = readFileSync(
      join(
        process.cwd(),
        "components/meta/decision-center/MetaDecisionCenterExact.tsx",
      ),
      "utf8",
    );
    expect(source).not.toContain("useRouter");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("buyerAction");
    expect(source).not.toContain("providerMutation");
    expect(source).not.toContain("Prospecting — Broad US");
    expect(source).not.toContain("$4,120");
  });

  it("keeps canonical desktop geometry and the narrow small-type exception markers", () => {
    const css = readFileSync(
      join(
        process.cwd(),
        "components/meta/decision-center/MetaDecisionCenterExact.module.css",
      ),
      "utf8",
    );
    expect(css).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(190px, 1fr))",
    );
    expect(css).toContain(
      "grid-template-columns: minmax(0, 1.8fr) minmax(280px, 1fr)",
    );
    expect(css).toContain("border-left: 4px solid var(--tone-solid)");
    expect(css).toContain("position: sticky");
    expect(css).toContain("/* dashboard-v2-meta-exact-reference-type:start */");
    expect(css).toContain("/* dashboard-v2-meta-exact-reference-type:end */");
  });
});

describe("the ROAS tile names the reference it is showing, not a target it isn't", () => {
  function roasCard(): HTMLElement {
    const card = root().querySelector<HTMLElement>(
      '[data-meta-exact-section="kpis"]',
    )?.children[1] as HTMLElement | undefined;
    if (!card) throw new Error("the ROAS KPI card was not rendered");
    return card;
  }

  // The tile used to write the word "target" itself and print whatever number
  // followed. The pulse resolves that reference from four sources, one of them
  // an account median measured when the business unit has NO commercial-truth
  // target; a fixed "target" caption would have relabelled that median as a
  // number the operator set. The noun now travels with the value.
  it("prints the served reference phrase verbatim, median included", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={exactViewModel({
          kpis: {
            roas: {
              label: "ROAS · 28d",
              value: "1.84",
              target: "account median 2.10",
            },
          },
        })}
      />,
    );

    expect(roasCard().textContent).toContain("account median 2.10");
    expect(roasCard().textContent).not.toContain("target account median");
    expect(roasCard().textContent).not.toMatch(/target\s*2\.10/);
  });

  it("keeps a served target reading as a target", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={exactViewModel({
          kpis: {
            roas: {
              label: "ROAS · 28d",
              value: "3.20",
              target: "target 2.50 · stale",
            },
          },
        })}
      />,
    );

    expect(roasCard().textContent).toContain("target 2.50 · stale");
  });

  it("still shows an unserved reference as 'target —'", () => {
    render(<MetaDecisionCenterExact viewModel={{}} />);

    expect(roasCard().textContent).toContain("target —");
  });
});

describe("a restored deep-link search is visible in the control that filtered", () => {
  // The deep-link work restored `?q=` and filtered every lane by it, but this
  // component kept its own `useState("")`. A link carrying `?q=` therefore
  // rendered a filtered queue with an EMPTY search box and no notice: the
  // operator saw fewer rows than the account has and nothing on screen said
  // why. The restore is only complete when the term is on screen, so this pins
  // the term's visibility, not merely that filtering happened.
  it("shows the restored term in the search box", () => {
    renderExact({ initialQuery: "prospecting" });
    const input = root().querySelector<HTMLInputElement>(
      'input[aria-label="Find entities"]',
    );
    expect(input).not.toBeNull();
    expect(input!.value).toBe("prospecting");
  });

  it("leaves the box empty when the link carries no search", () => {
    renderExact();
    const input = root().querySelector<HTMLInputElement>(
      'input[aria-label="Find entities"]',
    );
    expect(input).not.toBeNull();
    expect(input!.value).toBe("");
  });
});

describe("the Structures scope keeps technical diagnostics out of the queue", () => {
  it("keeps decision rows visible without rendering raw source provenance", () => {
    const viewModel = exactViewModel();
    viewModel.structureProvenance = {
      headline: "meta_recommendations · available",
      coverageSummary: "22 carry a decision · 1,230 in census",
      capabilityGaps: [
        {
          id: "providerWriteLinkage",
          label: "Provider write linkage",
          status: "Unavailable",
          reason: "native_action_receipt_not_observed",
        },
      ],
    };

    render(
      <MetaDecisionCenterExact
        defaultScope="structure"
        viewModel={viewModel}
      />,
    );

    expect(
      document.querySelector('[data-meta-exact-action-row="action-a"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-meta-exact-source-scope="structure"]'),
    ).toBeNull();
    expect(root().textContent).not.toContain("meta_recommendations");
    expect(root().textContent).not.toContain(
      "native_action_receipt_not_observed",
    );
  });
});

/**
 * D084 Correction 2 — the directional panel is mounted on the real surface and
 * is visible at both desktop and mobile widths.
 */
describe("the Decision Center mounts the budget-decision evidence", () => {
  const panel = (
    over: Partial<MetaBudgetDecisionEvidencePanel> = {},
  ): MetaBudgetDecisionEvidencePanel => ({
    contractVersion: "meta-budget-decision-evidence-panel.v4",
    status: "resolved",
    unavailableReason: null,
    authority: "blocked",
    primaryBlocker: {
      code: "budget_fact_absent",
      reason:
        "no retained budget fact exists for this entity, so nothing can be proposed",
    },
    sections: [
      {
        section: "input_integrity",
        blockerCodes: [],
        reasons: [],
        clear: true,
      },
      {
        section: "commercial_target",
        blockerCodes: [],
        reasons: [],
        clear: true,
      },
      {
        section: "evidence_floor",
        blockerCodes: ["budget_fact_absent"],
        reasons: [
          "no retained budget fact exists for this entity, so nothing can be proposed",
        ],
        clear: false,
      },
      {
        section: "change_safety",
        blockerCodes: ["change_safety_history_unavailable"],
        reasons: [
          "recent-change history was not read, so no cap can be evaluated",
        ],
        clear: false,
      },
      {
        section: "execution_capability",
        blockerCodes: [],
        reasons: [],
        clear: true,
      },
    ],
    commercialLineage: {
      selectedAction: "scale",
      eligible: false,
      code: "commercial_anchor_not_hard_action_eligible",
      reason: "the canonical profile reports scale ineligible",
      anchorExplanation: { spendUnitSource: "unresolved" },
      contractVersion: "adsecute.account-decision-profile.v1",
      availability: { status: "resolved" },
    },
    executionReadiness: {
      state: "not_executable",
      why: "at least one local gate is unmet",
      ctaEnabled: false,
    },
    counterfactual: null,
    ...over,
  });

  const evidence = (
    over: Partial<MetaBudgetDecisionEvidenceByDirection> = {},
  ): MetaBudgetDecisionEvidenceByDirection => ({
    contractVersion: "meta-budget-decision-evidence-directional.v3",
    directionToAction: { increase: "scale", decrease: "cut" },
    directionToActionWhy:
      "an increase is a scale decision and a decrease is a cut decision",
    directionSelected: null,
    directionSelectedWhy:
      "this panel is account-scoped and no proposal direction has been selected",
    increase: panel(),
    decrease: panel({ authority: "validated_only", primaryBlocker: null }),
    ...over,
  });

  const mounted = () =>
    root().querySelector('[data-el="budget-decision-evidence"]');
  it("keeps technical budget evidence out of the buyer queue and adds no write", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={exactViewModel({ budgetEvidence: evidence() })}
      />,
    );

    expect(mounted()).toBeNull();
    expect(root().textContent).not.toContain("budget_fact_absent");
    expect(root().textContent).not.toContain(
      "no retained budget fact exists for this entity",
    );
    expect(root().textContent).not.toContain(
      "change_safety_history_unavailable",
    );
    for (const action of screen.getAllByRole("button", {
      name: /Server command/,
    })) {
      expect(action).toBeDisabled();
    }
  });

  it("derives no buyer action, role, threshold or arithmetic on the client", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "components/meta/decision-center/BudgetDecisionEvidencePanel.tsx",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/buyerAction|inferredKind|campaignRole/i);
    expect(source).not.toMatch(/Math\.|reduce\(|parseFloat|Number\(/);
  });
});

/**
 * D091 / Codex item 5 — the held verdict on the rendered row.
 *
 * The view model is not the operator's eye. These assert the DOM: the engine's
 * withheld conclusion is a SEPARATE element from the published label, it says
 * which verdict was reached, and the row it sits on offers nothing that would
 * change anything at Meta.
 */
describe("a held verdict renders as evidence and never as an affordance", () => {
  function heldRow(): MetaDecisionCenterExactViewModel {
    return {
      creativeGroups: [
        {
          id: "blocked",
          label: "Blocked",
          tone: "warning",
          count: "1 decision",
          note: "3 ads need more evidence before action (scale 1 · cut 0 · refresh 2), counted apart from this group's total",
          rows: [
            {
              id: "row-held",
              name: "Held Refresh Ad",
              stateLabel: "Blocked",
              stateTone: "warning",
              decisionLabel: "Keep monitoring",
              decisionTone: "warning",
              heldVerdictLabel: "Recommendation awaiting review: Refresh creative",
              heldVerdictTone: "warning",
              note: "Confirm the commercial target before acting. Then review this Refresh creative recommendation again.",
              actionLabel: "Keep running",
              onPrimary: () => {},
              onOpen: () => {},
            },
          ],
        },
      ],
    };
  }

  it("draws the engine's held verdict as its own element beside the published label", () => {
    render(
      <MetaDecisionCenterExact
        lane="needsres"
        scope="creatives"
        viewModel={heldRow()}
      />,
    );
    const row = document.querySelector(
      '[data-meta-exact-creative-row="row-held"]',
    )!;
    const held = row.querySelector("[data-meta-exact-creative-held-verdict]");

    // The engine reached Refresh. The row now says so, in words, on screen.
    expect(held?.textContent).toBe("Recommendation awaiting review: Refresh creative");
    // And it is a DIFFERENT element from the published label, so neither one
    // is mistaken for the other.
    expect(row.textContent).toContain("Keep monitoring");
    expect(held?.textContent).not.toContain("Keep monitoring");
    // The specific held resolution, not the generic evidence sentence.
    expect(
      row.querySelector("[data-meta-exact-creative-next-step]")?.textContent,
    ).toBe(
      "Confirm the commercial target before acting. Then review this Refresh creative recommendation again.",
    );
    // The group states the held split apart from its own total.
    expect(screen.getByText("1 decision")).toBeTruthy();
    expect(
      screen.getByText(
        "3 ads need more evidence before action (scale 1 · cut 0 · refresh 2), counted apart from this group's total",
      ),
    ).toBeTruthy();
  });

  /**
   * The suppression must follow the HELD VERDICT, not the badge caption.
   *
   * `isBlocked` in this component is a string comparison against
   * `stateLabel`, so this row is deliberately served WITHOUT one — the flat
   * `creativeDecisions` path, and any caller that supplies rows with no state.
   * Before the held verdict governed it, such a row drew the served action
   * line for a verdict the server had refused to authorize.
   */
  it("offers no Apply, no CTA and no served action on the held row", () => {
    const base = heldRow();
    const row0 = base.creativeGroups![0]!.rows[0]!;
    render(
      <MetaDecisionCenterExact
        lane="needsres"
        scope="creatives"
        viewModel={{
          creativeDecisions: [
            { ...row0, stateLabel: undefined, stateTone: undefined },
          ],
        }}
      />,
    );
    const row = document.querySelector(
      '[data-meta-exact-creative-row="row-held"]',
    )!;

    // No served-action line, and no design control key: a held row mints no
    // provider write and must not draw the affordance for one.
    expect(
      row.querySelector("[data-meta-exact-creative-served-action]"),
    ).toBeNull();
    expect(row.querySelector("[data-ctl]")).toBeNull();
    // The ONE control on the row opens the evidence, and says so. Anything
    // else here would be an execution affordance on a withheld verdict.
    const buttons = Array.from(row.querySelectorAll("button"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("data-meta-exact-creative-review")).toBe(
      "true",
    );
    expect(buttons[0]!.textContent).toBe("Review evidence");
    expect(row.textContent).not.toMatch(/apply|pause|resume|execute/i);
  });

  it("draws no held badge on a row the server held nothing on", () => {
    const viewModel = heldRow();
    const row = viewModel.creativeGroups![0]!.rows[0]!;
    render(
      <MetaDecisionCenterExact
        lane="needsres"
        scope="creatives"
        viewModel={{
          creativeGroups: [
            {
              ...viewModel.creativeGroups![0]!,
              note: null,
              rows: [{ ...row, heldVerdictLabel: undefined }],
            },
          ],
        }}
      />,
    );
    expect(
      document.querySelector("[data-meta-exact-creative-held-verdict]"),
    ).toBeNull();
  });
});

/**
 * D091 / Codex item 5, SECOND SURFACE — the held verdict in the evidence panel.
 *
 * The panel is one click from the row above. It drew `decisionLabel` —
 * "Keep monitoring" for a held Refresh — under `tone`, which reads the
 * published `keep` as POSITIVE, and said nothing at all about a verdict being
 * withheld. These assert the DOM, not the view model: the held verdict is a
 * SEPARATE element from the published label, it carries its own specific
 * resolution, the panel is not painted with the approval colour, and nothing
 * that would change anything at Meta becomes reachable inside it.
 */
describe("the evidence panel states a held verdict and offers no way to act on it", () => {
  function heldInspector(): MetaDecisionCenterExactViewModel["inspector"] {
    return {
      entityName: "Held Refresh Ad",
      entityMeta: "Server Campaign · Server Ad set",
      decisionLabel: "Keep monitoring",
      tone: "warning",
      heldVerdictLabel: "Recommendation awaiting review: Refresh creative",
      heldVerdictTone: "warning",
      heldVerdictNextStep:
        "Confirm the commercial target before acting. Then review this Refresh creative recommendation again.",
      serverVerdict: "Review decision",
      reasons: ["This decision needs review before any action."],
      actionLabel: "Review decision",
      actionTone: "warning",
    };
  }

  function panel(): HTMLElement {
    return document.querySelector("[data-meta-exact-inspector]") as HTMLElement;
  }

  it("draws the held verdict and its own resolution as elements of their own", () => {
    render(
      <MetaDecisionCenterExact
        lane="needsres"
        scope="structure"
        viewModel={{ inspector: heldInspector() }}
      />,
    );
    const held = panel().querySelector(
      "[data-meta-exact-inspector-held-verdict]",
    );

    // The engine reached Refresh. The panel now says so, in words, on screen.
    expect(
      held?.querySelector("[data-meta-exact-inspector-held-verdict-label]")
        ?.textContent,
    ).toBe("Recommendation awaiting review: Refresh creative");
    // The SPECIFIC held resolution, not the generic evidence sentence.
    expect(
      held?.querySelector("[data-meta-exact-inspector-held-next-step]")
        ?.textContent,
    ).toBe(
      "Confirm the commercial target before acting. Then review this Refresh creative recommendation again.",
    );
    expect(held?.textContent).not.toContain(
      "Review the missing evidence before taking action.",
    );
    // And the published label is still there, in a DIFFERENT element, so
    // neither fact is mistaken for the other.
    expect(panel().textContent).toContain("Keep monitoring");
    expect(held?.textContent).not.toContain("Keep monitoring");
    // The badge wears its own warning tone — the same pill the operator
    // clicked from on the queue row, not the published label's colour.
    expect(
      held?.querySelector("[data-meta-exact-inspector-held-verdict-label]")
        ?.className,
    ).toContain(styles.toneWarning);
  });

  it("never paints the panel of a held row in the approval colour", () => {
    render(
      <MetaDecisionCenterExact
        lane="needsres"
        scope="structure"
        viewModel={{ inspector: heldInspector() }}
      />,
    );

    // `tone` tints the panel frame and its header badge. Read off the rendered
    // class list rather than off the view model, because the colour is what
    // the operator actually sees.
    expect(panel().className).not.toContain(styles.tonePositive);
    expect(panel().className).toContain(styles.toneWarning);
  });

  /**
   * THE MUTATION CEREMONY MUST NOT FALL THROUGH ONTO A HELD PANEL.
   *
   * `manualAction` is the `gated:META-WRITE-01` sheet — a provider write. It
   * becomes the panel's primary control whenever no other primary is served,
   * which is precisely the shape a held row can arrive in: authority withheld
   * the verdict, so there is nothing else to offer. Served UNREFUSED here —
   * the gate open and the viewer able to write — because a refused sheet
   * proves nothing about the suppression.
   */
  it("offers no execution affordance inside a held row's evidence panel", () => {
    const openMutationSheet = vi.fn();
    render(
      <MetaDecisionCenterExact
        lane="needsres"
        scope="structure"
        viewModel={{
          inspector: {
            ...heldInspector(),
            manualAction: {
              label: "Open manual action",
              refusalReason: null,
              onOpen: openMutationSheet,
            },
          },
        }}
      />,
    );

    expect(panel().querySelectorAll("button")).toHaveLength(0);
    expect(panel().textContent).not.toContain("Open manual action");
    // No design control key inside the panel either: a held verdict mints no
    // provider write and must not draw the affordance for one.
    expect(panel().querySelector("[data-ctl]")).toBeNull();
  });

  it("keeps the evidence review reachable on a held panel, and only that", () => {
    const review = vi.fn();
    const openMutationSheet = vi.fn();
    render(
      <MetaDecisionCenterExact
        lane="needsres"
        scope="structure"
        viewModel={{
          inspector: {
            ...heldInspector(),
            onPrimary: review,
            manualAction: {
              label: "Open manual action",
              refusalReason: null,
              onOpen: openMutationSheet,
            },
          },
        }}
      />,
    );
    const buttons = Array.from(panel().querySelectorAll("button"));

    // Exactly one control, and it reads the evidence rather than writing.
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Review decision");
    fireEvent.click(buttons[0]!);
    expect(review).toHaveBeenCalledTimes(1);
    expect(openMutationSheet).not.toHaveBeenCalled();
    expect(panel().textContent).not.toContain("Open manual action");
  });

  it("still opens the mutation sheet on a panel with no held verdict", () => {
    const openMutationSheet = vi.fn();
    const { heldVerdictLabel: _label, ...unheld } = heldInspector()!;
    render(
      <MetaDecisionCenterExact
        lane="needsres"
        scope="structure"
        viewModel={{
          inspector: {
            ...unheld,
            manualAction: {
              label: "Open manual action",
              refusalReason: null,
              onOpen: openMutationSheet,
            },
          },
        }}
      />,
    );
    const buttons = Array.from(panel().querySelectorAll("button"));

    // The suppression above follows the HELD VERDICT and nothing else: remove
    // it and the ceremony is reachable exactly as before.
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(openMutationSheet).toHaveBeenCalledTimes(1);
  });

  it("draws no held block on a panel the server held nothing on", () => {
    const { heldVerdictLabel: _label, ...unheld } = heldInspector()!;
    render(
      <MetaDecisionCenterExact
        lane="needsres"
        scope="structure"
        viewModel={{ inspector: { ...unheld, tone: "positive" } }}
      />,
    );

    expect(
      panel().querySelector("[data-meta-exact-inspector-held-verdict]"),
    ).toBeNull();
    expect(panel().textContent).toContain("Keep monitoring");
  });
});
