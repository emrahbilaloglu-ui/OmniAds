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

    // Header, KPI band, operator summary, scope row and lane toolbar lead
    // directly into the decision workspace. Supporting inactive/account facts
    // follow the queue so they cannot displace decisions from the first view.
    expect(root().children).toHaveLength(7);
    expect(root().children[0]?.textContent).toContain("Decision Center");
    expect(root().children[1]?.getAttribute("data-meta-exact-section")).toBe(
      "kpis",
    );
    expect(root().children[1]?.children).toHaveLength(5);
    expect(
      root().children[2]?.hasAttribute("data-meta-exact-operator-summary"),
    ).toBe(true);
    expect(root().children[2]?.textContent).toContain(
      "What Adsecute recommends now",
    );
    expect(root().children[3]?.textContent).toContain("Campaigns & Ad sets");
    expect(
      root().children[4]?.hasAttribute("data-meta-exact-lane-toolbar"),
    ).toBe(true);
    expect(root().children[5]?.hasAttribute("data-meta-exact-workspace")).toBe(
      true,
    );
    expect(
      root().children[6]?.hasAttribute("data-meta-exact-inactive-strip"),
    ).toBe(true);

    expect(
      Array.from(document.querySelectorAll("[data-meta-exact-scope]")).map(
        (node) => node.getAttribute("data-meta-exact-scope"),
      ),
    ).toEqual(["structure", "creatives"]);
    expect(
      Array.from(document.querySelectorAll("[data-meta-exact-lane]")).map(
        (node) => node.getAttribute("data-meta-exact-lane"),
      ),
    ).toEqual([
      "action",
      // The server's own `blocked` state, between the lane that promises an
      // action and the one that promises none.
      "needsres",
      "watching",
      "healthy",
      "nonsales",
      "archive",
    ]);
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
    expect(screen.getByRole("button", { name: "Run a snapshot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New campaign" })).toBeTruthy();
    expect(screen.getByText("Spend · today")).toBeTruthy();
    expect(screen.getByText("ROAS · 28d")).toBeTruthy();
    expect(screen.getByText("Recommendation snapshot")).toBeTruthy();
    expect(screen.getByText("Campaign roles")).toBeTruthy();
    expect(screen.getByText("Automatic inference")).toBeTruthy();
    expect(screen.getByText("Mode")).toBeTruthy();
    expect(
      screen.getByText(
        /queue reflects .*date range scopes metrics, not decisions/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Sort: Money at stake" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: Priority" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: Age" })).toBeTruthy();
  });

  it("localizes the exact spend date and automatic campaign-role state", () => {
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
        unresolvedCount: "0",
      },
    };

    render(
      <ZeroBaseCopyProvider language="tr">
        <MetaDecisionCenterExact viewModel={viewModel} />
      </ZeroBaseCopyProvider>,
    );

    expect(screen.getByText("Harcama · 2026-09-03")).toBeTruthy();
    expect(
      screen.getByText("Otomatik çıkarım · tüm aktif kampanyalar çözüldü"),
    ).toBeTruthy();
    expect(screen.queryByText("Spend · 2026-09-03")).toBeNull();
  });

  it("localizes the collapsed account-coverage summary", () => {
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

    expect(screen.getByText("1 atanmış Meta hesabı")).toBeTruthy();
    expect(
      screen.getByText("Seçili hesap verileri 2026-09-03 tarihine kadar"),
    ).toBeTruthy();
    expect(screen.queryByText(/Selected account data through/)).toBeNull();
  });

  it("routes a creative-only action summary to the creative Action lane", () => {
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

    expect(
      screen.getByText("1 decision need operator review now."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review Action Now" }));
    expect(
      document
        .querySelector('[data-meta-exact-scope="creatives"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      document.querySelector("[data-meta-exact-creative-toolbar]"),
    ).toBeTruthy();
  });

  it("exposes both contributing scopes when a combined action count spans them", () => {
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
      screen.queryByRole("button", { name: "Review Action Now" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Review structure actions (2)" }),
    );
    expect(onScopeChange).toHaveBeenLastCalledWith("structure");
    expect(onLaneChange).toHaveBeenLastCalledWith("action");

    fireEvent.click(
      screen.getByRole("button", { name: "Review creative actions (1)" }),
    );
    expect(onScopeChange).toHaveBeenLastCalledWith("creatives");
    expect(onLaneChange).toHaveBeenLastCalledWith("action");
  });

  it("shows the canonical default inline inspector without a row-selection dependency", () => {
    renderExact();
    const inspector = document.querySelector("[data-meta-exact-inspector]");

    expect(inspector).toBeTruthy();
    const text = inspector?.textContent ?? "";
    const ordered = [
      "Evidence inspector",
      "Inspector Entity",
      "Decision contract",
      "Engine reasoning",
      "Money impact · ROAS vs target",
      "Confidence",
      "Readiness",
      "Blockers",
      // Advisories are a second, separately named block. They sit beside the
      // gates and never inside them: nothing here withholds an action, and a
      // statement filed under "Blockers" is read as one that does.
      "Advisories",
      "Server advisories",
      "Evidence A",
      "Inspector server command",
      "server provenance",
    ];
    let cursor = -1;
    for (const caption of ordered) {
      const next = text.indexOf(caption);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
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
  it("starts with a server-count summary and routes the operator to the useful queue", () => {
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

    const summary = document.querySelector(
      "[data-meta-exact-operator-summary]",
    );
    expect(summary?.textContent).toContain(
      "No immediate Meta change is ready. 12 decisions need evidence resolved.",
    );
    expect(
      within(summary as HTMLElement).queryByRole("button", {
        name: "Review Action Now",
      }),
    ).toBeNull();

    fireEvent.click(
      within(summary as HTMLElement).getByRole("button", {
        name: "Resolve blockers",
      }),
    );
    expect(onScopeChange).toHaveBeenLastCalledWith("structure");
    expect(onLaneChange).toHaveBeenLastCalledWith("needsres");
    // Lower-priority routes stay in the scope/lane controls directly below;
    // the summary carries only the single most urgent recommendation family.
    expect(
      within(summary as HTMLElement).queryByRole("button", {
        name: "Open creative decisions",
      }),
    ).toBeNull();
  });

  it("renders watching, healthy, non-sales and archive branches in lane order", () => {
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

    fireEvent.click(
      document.querySelector('[data-meta-exact-lane="nonsales"]')!,
    );
    expect(screen.getByText("Non-sales Alpha")).toBeTruthy();
    expect(
      document.querySelector("[data-meta-exact-nonsales]")?.children[1]
        ?.children,
    ).toHaveLength(4);

    fireEvent.click(
      document.querySelector('[data-meta-exact-lane="archive"]')!,
    );
    expect(
      Array.from(document.querySelectorAll("[data-meta-exact-archive] th")).map(
        (node) => node.textContent,
      ),
    ).toEqual(["Entity", "Status", "Spend · 28d", "Note", ""]);
    const resume = screen.getByRole("button", { name: "Resume" });
    expect(resume).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(1);
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

    fireEvent.click(screen.getByText("Evidence →"));
    expect(onOpen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Open Creative Studio →"));
    expect(onOpenCreativeStudio).toHaveBeenCalledOnce();
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
  it("states the served source beside a non-empty creative queue", () => {
    const viewModel = exactViewModel();
    viewModel.creativesNotice =
      "Legacy creative-grain decisions cannot authorize Ad writes. Source: native_account_manifest_incomplete.";
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
        // the read model's served count and the presentation's derived maximum.
        // @see meta-decision-center-exact-adapter.ts — sourceProvenance.
        {
          id: "queue-eligible-pre-cap",
          label: "Eligible (pre-cap) · read model",
          value: "71",
        },
        {
          id: "ads-eligible-pre-cap",
          label: "Eligible (pre-cap) · derived maximum",
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
    expect(
      queue?.children[1]?.getAttribute("data-meta-exact-creative-row"),
    ).toBe("creative-a");
    // Source diagnostics remain available after the primary decision rows.
    expect(
      queue?.children[2]?.hasAttribute("data-meta-exact-source-provenance"),
    ).toBe(true);

    // Every one of these is the server's own string. None is gated on the queue.
    expect(
      document.querySelector("[data-meta-exact-source-authority]")?.textContent,
    ).toBe("legacy_creative · degraded");
    expect(
      document.querySelector("[data-meta-exact-source-coverage]")?.textContent,
    ).toBe("60 shown · 80 eligible pre-cap (derived)");
    expect(
      document.querySelector("[data-meta-exact-source-capability-summary]")
        ?.textContent,
    ).toBe("2 of 8 not available");
    expect(screen.getByText("native_account_manifest_incomplete")).toBeTruthy();
    expect(screen.getByText("native_response_source_unavailable")).toBeTruthy();
    expect(
      screen.getByText(
        "Legacy creative-grain decisions remain visible for continuity.",
      ),
    ).toBeTruthy();
    // The notice moved INTO the panel; it must no longer wait for an empty list.
    expect(
      document.querySelector("[data-meta-exact-creative-notice]")?.textContent,
    ).toContain("cannot authorize Ad writes");
    // Read-only by construction: the panel carries no control of any kind.
    expect(
      document
        .querySelector("[data-meta-exact-source-provenance]")
        ?.querySelectorAll("button, input, select, [role='button']").length,
    ).toBe(0);
  });

  /**
   * LAW: an absent field is an em dash; a measured zero stays 0.
   *
   * Both render as "nothing to worry about" if they are conflated, and they are
   * opposite facts: "the server withheld nothing" is knowledge, "we could not
   * read the envelope" is not.
   */
  it("keeps an unserved source field apart from a served zero", () => {
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
      document.querySelector('[data-meta-exact-source-fact="fallback-reason"]')
        ?.textContent,
    ).toBe("Fallback reason—");
    expect(
      document.querySelector('[data-meta-exact-source-fact="suppressed-count"]')
        ?.textContent,
    ).toBe("Withheld0");
    // No capability envelope was served, so no gap list is invented from it.
    expect(
      document.querySelector('[data-meta-exact-source-group="capabilities"]'),
    ).toBeNull();
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
              count: "2 shown · 80 served",
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
              count: "1 shown",
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
    expect(screen.getByText("2 shown · 80 served")).toBeTruthy();
    expect(
      document
        .querySelector('[data-meta-exact-creative-row="row-blocked"]')
        ?.getAttribute("data-meta-exact-creative-state"),
    ).toBe("Blocked");
    expect(
      screen.getByText("Exact Ad-grain decision evidence is unavailable"),
    ).toBeTruthy();
    // No callback was served for the row, so its review control is not
    // live. The SERVED action label still renders — it is decision
    // information, and moving it off the button did not withhold it.
    for (const [rowId, servedAction] of [
      ["row-blocked", "Evidence pending"],
    ] as const) {
      const row = document.querySelector(
        `[data-meta-exact-creative-row="${rowId}"]`,
      );
      expect(
        row?.querySelector("[data-meta-exact-creative-served-action]")
          ?.textContent,
      ).toBe(servedAction);
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
    ).toHaveLength(5);
    expect(
      (root().textContent?.match(/—/g) ?? []).length,
    ).toBeGreaterThanOrEqual(20);
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

  it("names the inspector's inert action button when a row IS selected", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={{ inspector: { entityName: "Selected but unserved" } }}
      />,
    );

    const inspectorAction = screen.getByRole("button", {
      name: "No action available: the inspector has no selection to act on",
    });
    expect(inspectorAction).toBeDisabled();
    expect(inspectorAction.textContent).toBe("—");
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

/**
 * THE STRUCTURES SCOPE, which stated no source authority at all.
 *
 * The panel rendered in Creatives only — while Structures is the scope that
 * draws the action buttons `providerWriteLinkage` and `responseAttribution`
 * govern. These pin that the SAME panel now renders there, that it survives a
 * lane change, that it stays a statement beside the rows rather than a wall
 * above them, and that it never carries the ads notice.
 */
describe("the Structures scope states the envelope its actions answer to", () => {
  function structureProvenanceModel(): NonNullable<
    MetaDecisionCenterExactViewModel["structureProvenance"]
  > {
    return {
      headline: "meta_recommendations · available",
      tone: "warning",
      coverageSummary: "22 carry a decision · 1,230 in census",
      capabilitySummary: "4 of 8 not available",
      source: [
        {
          id: "structure-source",
          label: "Structure source",
          value: "meta_recommendations",
          tone: "warning",
        },
        // The read model's OWN status and its source's status are two fields
        // and carry two labels. @see readModelStatusFacts.
        {
          id: "read-model-status",
          label: "Read model status",
          value: "available",
        },
        { id: "status", label: "Source status", value: "available" },
      ],
      coverage: [
        {
          id: "structure-census",
          label: "Campaigns & ad sets served",
          value: "1,230",
        },
        { id: "structure-monitor", label: "Lane · monitor", value: "0" },
      ],
      limitations: [
        {
          id: "limitation-count",
          label: "Limitations applying here",
          value: "0",
        },
      ],
      capabilityGaps: [
        {
          id: "providerWriteLinkage",
          label: "Provider write linkage",
          status: "Unavailable",
          reason: "native_action_receipt_not_observed",
          tone: "negative",
        },
      ],
    };
  }

  it("keeps the same folded panel after the structure decisions", () => {
    const viewModel = exactViewModel();
    viewModel.structureProvenance = structureProvenanceModel();

    render(
      <MetaDecisionCenterExact
        defaultScope="structure"
        viewModel={viewModel}
      />,
    );

    const queue = document.querySelector(
      "[data-meta-exact-workspace]",
    )?.firstElementChild;
    const laneBody = queue?.children[0];
    const panel = queue?.children[1];
    expect(panel?.getAttribute("data-meta-exact-source-scope")).toBe(
      "structure",
    );
    // The rows are the primary content and render before the supporting source
    // envelope, inside the lane body that carries the named collection.
    expect(laneBody?.getAttribute("data-collection")).toBe("decisions");
    expect(
      laneBody?.firstElementChild?.getAttribute("data-meta-exact-action-row"),
    ).toBe("action-a");

    /*
     * Folded, not hidden. Every load-bearing fact is in the summary line, which
     * is always on screen: the source token, the read model status, the
     * coverage pairing and how many of the eight capabilities are missing. A
     * folded panel therefore still cannot read as "fine".
     */
    expect((panel as HTMLDetailsElement).open).toBe(false);
    expect(
      document.querySelector("[data-meta-exact-source-authority]")?.textContent,
    ).toBe("meta_recommendations · available");
    expect(
      document.querySelector("[data-meta-exact-source-coverage]")?.textContent,
    ).toBe("22 carry a decision · 1,230 in census");
    expect(
      document.querySelector("[data-meta-exact-source-capability-summary]")
        ?.textContent,
    ).toBe("4 of 8 not available");

    // The detail is one disclosure away, not a second page.
    expect(
      document.querySelector('[data-meta-exact-source-fact="structure-census"]')
        ?.textContent,
    ).toBe("Campaigns & ad sets served1,230");
    expect(screen.getByText("native_action_receipt_not_observed")).toBeTruthy();

    // LAW: read-only by construction, in this scope too.
    expect(
      panel?.querySelectorAll("button, input, select, [role='button']").length,
    ).toBe(0);
    // The ads notice belongs to the ad grain and is never handed to this panel.
    expect(
      panel?.querySelector("[data-meta-exact-creative-notice]"),
    ).toBeNull();
  });

  /**
   * The source is a property of the account and the snapshot, never of which
   * lane happens to be selected. A panel that vanished on Archive would be a
   * disclosure the operator could lose by clicking.
   */
  it("keeps stating the source after a lane change", () => {
    const viewModel = exactViewModel();
    viewModel.structureProvenance = structureProvenanceModel();

    render(
      <MetaDecisionCenterExact
        defaultLane="archive"
        defaultScope="structure"
        viewModel={viewModel}
      />,
    );

    expect(
      document.querySelector('[data-meta-exact-source-scope="structure"]'),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-meta-exact-source-authority]")?.textContent,
    ).toBe("meta_recommendations · available");
  });

  /**
   * LAW: a measured zero stays 0 and an unserved field is an em dash — the same
   * law in this scope, because the two are opposite facts about the account.
   */
  it("keeps an unserved structure field apart from a served zero", () => {
    const viewModel = exactViewModel();
    viewModel.structureProvenance = {
      headline: "— · —",
      tone: "neutral",
      coverageSummary: "— carry a decision · — in census",
      capabilitySummary: "capabilities —",
      coverage: [
        {
          id: "structure-census",
          label: "Campaigns & ad sets served",
          value: "—",
        },
        { id: "structure-monitor", label: "Lane · monitor", value: "0" },
      ],
    };

    render(
      <MetaDecisionCenterExact
        defaultScope="structure"
        viewModel={viewModel}
      />,
    );

    expect(
      document.querySelector('[data-meta-exact-source-fact="structure-census"]')
        ?.textContent,
    ).toBe("Campaigns & ad sets served—");
    expect(
      document.querySelector(
        '[data-meta-exact-source-fact="structure-monitor"]',
      )?.textContent,
    ).toBe("Lane · monitor0");
    expect(
      document.querySelector('[data-meta-exact-source-group="capabilities"]'),
    ).toBeNull();
  });

  /**
   * LOADING IS NOT ABSENCE.
   *
   * The page builds no provenance at all until the workspace query resolves —
   * `MetaPlatformPage`'s pre-load view model carries only the window and the
   * identity — while a RESOLVED payload always yields a panel, em dashes and
   * all. So the panel's presence is itself the load signal, and a page still
   * fetching cannot be mistaken for an account whose source is blank. Drawing
   * a skeleton of em dashes here would collapse exactly that distinction.
   */
  it("draws no panel while the workspace has not resolved", () => {
    const viewModel = exactViewModel();
    viewModel.structureProvenance = null;

    render(
      <MetaDecisionCenterExact
        defaultScope="structure"
        viewModel={viewModel}
      />,
    );

    expect(
      document.querySelector('[data-meta-exact-source-scope="structure"]'),
    ).toBeNull();
    const queue = document.querySelector(
      "[data-meta-exact-workspace]",
    )?.firstElementChild;
    expect(queue?.children[0]?.getAttribute("data-collection")).toBe(
      "decisions",
    );
    expect(
      queue?.children[0]?.firstElementChild?.getAttribute(
        "data-meta-exact-action-row",
      ),
    ).toBe("action-a");
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
  const direction = (d: "increase" | "decrease") =>
    root().querySelector(
      `[data-el="budget-decision-direction"][data-direction="${d}"]`,
    );

  it("renders both served directions in the real surface", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={exactViewModel({ budgetEvidence: evidence() })}
      />,
    );
    expect(mounted(), "the panel component is not mounted").toBeTruthy();
    expect(direction("increase")).toBeTruthy();
    expect(direction("decrease")).toBeTruthy();
    expect(mounted()?.getAttribute("data-direction-selected")).toBe("none");
  });

  it("shows each direction's own verdict and its own primary pair", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={exactViewModel({ budgetEvidence: evidence() })}
      />,
    );
    const primary = direction("increase")?.querySelector(
      '[data-el="primary-blocker"]',
    );
    expect(primary?.getAttribute("data-code")).toBe("budget_fact_absent");
    expect(primary?.textContent).toContain("no retained budget fact exists");
    expect(
      direction("decrease")
        ?.querySelector('[data-el="authority"]')
        ?.getAttribute("data-authority"),
    ).toBe("validated_only");
    expect(
      direction("decrease")?.querySelector('[data-el="primary-blocker"]'),
    ).toBeNull();
  });

  it("keeps the primary budget blocker visible while details are closed", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={exactViewModel({ budgetEvidence: evidence() })}
      />,
    );

    const summary = root().querySelector(
      "[data-meta-exact-budget-readiness-summary]",
    );
    const disclosure = summary?.closest("details") as HTMLDetailsElement | null;
    expect(disclosure?.open).toBe(false);
    expect(summary?.parentElement?.getAttribute("data-readiness-state")).toBe(
      "blocked",
    );
    expect(summary?.textContent).toContain("Increase blocked");
    expect(summary?.textContent).toContain(
      "no retained budget fact exists for this entity",
    );
  });

  it("shows the unavailable-history blocker where a buyer can read it", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={exactViewModel({ budgetEvidence: evidence() })}
      />,
    );
    const section = direction("increase")?.querySelector(
      '[data-section="change_safety"]',
    );
    expect(section?.getAttribute("data-clear")).toBe("false");
    expect(section?.textContent).toContain("was not read");
  });

  it("renders an unsupported compatibility state without claiming it is clear", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={exactViewModel({
          budgetEvidence: evidence({
            increase: panel({
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
                  blockerCodes: [],
                  reasons: [],
                  clear: true,
                },
                {
                  section: "change_safety",
                  blockerCodes: [],
                  reasons: [],
                  clear: true,
                },
                {
                  section: "execution_capability",
                  blockerCodes: ["provider_compatibility_unknown"],
                  reasons: [
                    "no provider write-capability fact has been observed",
                  ],
                  clear: false,
                },
              ],
              primaryBlocker: {
                code: "provider_compatibility_unknown",
                reason: "no provider write-capability fact has been observed",
              },
            }),
          }),
        })}
      />,
    );
    const section = direction("increase")?.querySelector(
      '[data-section="execution_capability"]',
    );
    expect(section?.getAttribute("data-clear")).toBe("false");
    expect(section?.textContent).toContain("write-capability");
  });

  it("renders nothing at all when the server sent no evidence", () => {
    render(<MetaDecisionCenterExact viewModel={exactViewModel({})} />);
    expect(mounted()).toBeNull();
  });

  it("renders an unavailable direction as unavailable, never as clear", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={exactViewModel({
          budgetEvidence: evidence({
            increase: panel({
              status: "unavailable",
              unavailableReason: "gate_verdict_absent",
              authority: null,
              primaryBlocker: null,
            }),
          }),
        })}
      />,
    );
    expect(direction("increase")?.getAttribute("data-status")).toBe(
      "unavailable",
    );
    expect(direction("increase")?.textContent).toContain(
      "could not be resolved",
    );
  });

  it("never renders an enabled call to action", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={exactViewModel({ budgetEvidence: evidence() })}
      />,
    );
    const buttons = mounted()?.querySelectorAll("button") ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of Array.from(buttons)) {
      expect(button.hasAttribute("disabled"), button.textContent ?? "").toBe(
        true,
      );
    }
  });

  it("is present and laid out at BOTH desktop and mobile widths", () => {
    // jsdom applies no CSS, so presence is asserted in the DOM and the layout
    // rule is asserted against the stylesheet that governs it — never inferred
    // from a source string alone.
    for (const width of [1440, 390]) {
      cleanup();
      Object.defineProperty(window, "innerWidth", {
        value: width,
        configurable: true,
      });
      window.dispatchEvent(new Event("resize"));
      render(
        <MetaDecisionCenterExact
          viewModel={exactViewModel({ budgetEvidence: evidence() })}
        />,
      );
      expect(mounted(), `not mounted at ${width}px`).toBeTruthy();
      expect(
        direction("increase"),
        `increase missing at ${width}px`,
      ).toBeTruthy();
      expect(
        direction("decrease"),
        `decrease missing at ${width}px`,
      ).toBeTruthy();
      // Both directions stay readable: neither is hidden at either width.
      for (const d of ["increase", "decrease"] as const) {
        expect(
          direction(d)?.getAttribute("hidden"),
          `${d}@${width}`,
        ).toBeNull();
        expect((direction(d) as HTMLElement | null)?.style.display).not.toBe(
          "none",
        );
      }
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
