// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MetaDecisionCenterExact,
  type MetaDecisionCenterExactProps,
  type MetaDecisionCenterExactViewModel,
} from "./MetaDecisionCenterExact";

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
      spend: { value: "$fixture-spend", delta: "fixture delta", detail: "fixture detail" },
      roas: { value: "fixture roas", target: "fixture target", sparkPath: "M0 10 L100 4" },
      snapshot: { freshness: "fixture fresh", detail: "fixture source" },
      labels: { coverage: "fixture coverage", percentage: "fixture percentage" },
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
          { id: "healthy-child-a", name: "Healthy child Alpha", stats: "Stats Alpha" },
          { id: "healthy-child-b", name: "Healthy child Beta", stats: "Stats Beta" },
        ],
      },
    ],
    nonSales: {
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
      { id: "posture-a", label: "Posture A", value: "Value A", detail: "Detail A", tone: "negative" },
      { id: "posture-b", label: "Posture B", value: "Value B", detail: "Detail B", tone: "warning" },
      { id: "posture-c", label: "Posture C", value: "Value C", detail: "Detail C", tone: "warning" },
      { id: "posture-d", label: "Posture D", value: "Value D", detail: "Detail D", tone: "automation" },
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
  it("renders the header, five KPI cards, scope, five lanes, queue and inspector in exact order", () => {
    renderExact();

    expect(root().children).toHaveLength(5);
    expect(root().children[0]?.textContent).toContain("Decision Center");
    expect(root().children[1]?.getAttribute("data-meta-exact-section")).toBe("kpis");
    expect(root().children[1]?.children).toHaveLength(5);
    expect(root().children[2]?.textContent).toContain("Campaigns & Ad sets");
    expect(root().children[3]?.hasAttribute("data-meta-exact-lane-toolbar")).toBe(true);
    expect(root().children[4]?.hasAttribute("data-meta-exact-workspace")).toBe(true);

    expect(
      Array.from(document.querySelectorAll("[data-meta-exact-scope]")).map((node) =>
        node.getAttribute("data-meta-exact-scope"),
      ),
    ).toEqual(["structure", "creatives"]);
    expect(
      Array.from(document.querySelectorAll("[data-meta-exact-lane]")).map((node) =>
        node.getAttribute("data-meta-exact-lane"),
      ),
    ).toEqual(["action", "watching", "healthy", "nonsales", "archive"]);
    expect(
      Array.from(document.querySelectorAll("[data-meta-exact-action-row]")).map((node) =>
        node.textContent,
      ),
    ).toEqual([
      expect.stringContaining("Entity Alpha"),
      expect.stringContaining("Entity Beta"),
    ]);

    const workspace = document.querySelector("[data-meta-exact-workspace]");
    expect(workspace?.children).toHaveLength(2);
    expect(workspace?.children[1]?.hasAttribute("data-meta-exact-inspector")).toBe(true);
  });

  it("keeps the canonical fixed captions and control order", () => {
    renderExact();

    expect(
      Array.from(document.querySelectorAll("[data-meta-exact-window]")).map(
        (node) => node.textContent,
      ),
    ).toEqual(["7d", "14d", "28d", "90d"]);
    expect(screen.getByRole("button", { name: "Run snapshot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+ New campaign" })).toBeTruthy();
    expect(screen.getByText("Spend · today")).toBeTruthy();
    expect(screen.getByText("ROAS · 28d")).toBeTruthy();
    expect(screen.getByText("Snapshot")).toBeTruthy();
    expect(screen.getByText("Labels")).toBeTruthy();
    expect(screen.getByText("Mode")).toBeTruthy();
    expect(screen.getByText(/queue reflects .*date range scopes metrics, not decisions/)).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: Money at stake" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: Priority" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: Age" })).toBeTruthy();
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
});

describe("MetaDecisionCenterExact branches and callbacks", () => {
  it("renders watching, healthy, non-sales and archive branches in lane order", () => {
    renderExact();

    fireEvent.click(document.querySelector('[data-meta-exact-lane="watching"]')!);
    expect(screen.getByText("Learning 2")).toBeTruthy();
    expect(screen.getByText("Watching Alpha")).toBeTruthy();

    fireEvent.click(document.querySelector('[data-meta-exact-lane="healthy"]')!);
    expect(screen.getByText("Healthy Alpha")).toBeTruthy();
    expect(screen.getByText("Healthy child Alpha")).toBeTruthy();

    fireEvent.click(document.querySelector('[data-meta-exact-lane="nonsales"]')!);
    expect(screen.getByText("Non-sales Alpha")).toBeTruthy();
    expect(document.querySelector("[data-meta-exact-nonsales]")?.children[1]?.children).toHaveLength(4);

    fireEvent.click(document.querySelector('[data-meta-exact-lane="archive"]')!);
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

    expect(document.querySelector("[data-meta-exact-lane-toolbar]")).toBeNull();
    const queue = document.querySelector("[data-meta-exact-workspace]")?.firstElementChild;
    expect(queue?.children[0]?.hasAttribute("data-meta-exact-creative-posture")).toBe(true);
    expect(queue?.children[0]?.children).toHaveLength(4);
    expect(queue?.children[1]?.getAttribute("data-meta-exact-creative-row")).toBe("creative-a");
    expect(screen.getByText(/The engine makes only three ad-level calls/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Server creative command" }));
    expect(onPrimary).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Evidence →"));
    expect(onOpen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Open Creative Studio →"));
    expect(onOpenCreativeStudio).toHaveBeenCalledOnce();
  });

  it("emits scope, lane, window, sort and search values without transforming them", () => {
    const onScopeChange = vi.fn();
    const onLaneChange = vi.fn();
    const onWindowChange = vi.fn();
    const onSortChange = vi.fn();
    const onSearchChange = vi.fn();
    renderExact({
      onScopeChange,
      onLaneChange,
      onWindowChange,
      onSortChange,
      onSearchChange,
    });

    fireEvent.click(document.querySelector('[data-meta-exact-window="14d"]')!);
    fireEvent.click(document.querySelector('[data-meta-exact-lane="healthy"]')!);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort decisions" }), {
      target: { value: "age" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Search entities" }), {
      target: { value: "needle" },
    });
    fireEvent.click(document.querySelector('[data-meta-exact-scope="creatives"]')!);

    expect(onWindowChange).toHaveBeenCalledWith("14d");
    expect(onLaneChange).toHaveBeenCalledWith("healthy");
    expect(onSortChange).toHaveBeenCalledWith("age");
    expect(onSearchChange).toHaveBeenCalledWith("needle");
    expect(onScopeChange).toHaveBeenCalledWith("creatives");
  });
});

describe("MetaDecisionCenterExact fail-closed presentation boundary", () => {
  it("uses em dashes for absent payload fields without prototype fallback values", () => {
    render(<MetaDecisionCenterExact viewModel={{}} />);

    expect(root().querySelector('[data-meta-exact-section="kpis"]')?.children).toHaveLength(5);
    expect((root().textContent?.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(20);
    expect(root().textContent).not.toContain("undefined");
    expect(root().textContent).not.toContain("null");
    expect(root().textContent).not.toContain("NaN");
    expect(document.querySelector("[data-meta-exact-inspector]")).toBeTruthy();
  });

  it("shows Resume only from the explicit visual flag and keeps it disabled without authority", () => {
    const onResume = vi.fn();
    const viewModel = exactViewModel({
      archiveRows: [
        { id: "no-flag", status: "PAUSED", onResume },
        { id: "flag-no-callback", status: "PAUSED", showResume: true },
        { id: "flag-with-callback", status: "PAUSED", showResume: true, onResume },
      ],
    });
    render(<MetaDecisionCenterExact defaultLane="archive" viewModel={viewModel} />);

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
      join(process.cwd(), "components/meta/decision-center/MetaDecisionCenterExact.tsx"),
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
      join(process.cwd(), "components/meta/decision-center/MetaDecisionCenterExact.module.css"),
      "utf8",
    );
    expect(css).toContain("grid-template-columns: repeat(auto-fit, minmax(190px, 1fr))");
    expect(css).toContain("grid-template-columns: minmax(0, 1.8fr) minmax(280px, 1fr)");
    expect(css).toContain("border-left: 4px solid var(--tone-solid)");
    expect(css).toContain("position: sticky");
    expect(css).toContain("/* dashboard-v2-meta-exact-reference-type:start */");
    expect(css).toContain("/* dashboard-v2-meta-exact-reference-type:end */");
  });
});
