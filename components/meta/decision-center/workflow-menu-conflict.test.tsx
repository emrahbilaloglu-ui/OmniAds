// @vitest-environment jsdom
/** The concise Decisions surface keeps workflow state, without workflow chrome. */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MetaDecisionCenterExact,
  type MetaDecisionCenterExactWorkflow,
} from "./MetaDecisionCenterExact";

afterEach(() => {
  document.body.innerHTML = "";
});

function renderWorkflow(
  workflow: MetaDecisionCenterExactWorkflow,
  options: { onOpen?: () => void; onPrimary?: () => void } = {},
) {
  const onOpen = options.onOpen ?? vi.fn();
  render(
    <MetaDecisionCenterExact
      viewModel={{
        actionRows: [
          {
            id: "row_1",
            name: "Prospecting",
            decisionLabel: "Scale",
            actionLabel: "Review decision",
            workflowChip: {
              state: workflow.state,
              label: workflow.stateLabel,
              detail: workflow.assignee,
            },
            onOpen,
            onPrimary: options.onPrimary,
          },
        ],
        inspector: {
          entityName: "Prospecting",
          decisionLabel: "Scale",
          workflow,
        },
      }}
    />,
  );
  return { onOpen };
}

const OPEN_ACTIONS = (
  onSelect: (values: Record<string, string>) => void,
): MetaDecisionCenterExactWorkflow["actions"] => [
  {
    id: "acknowledge",
    label: "Acknowledge",
    refusalReason: null,
    requires: [],
    onSelect,
  },
  {
    id: "assign",
    label: "Assign",
    refusalReason: null,
    requires: ["assignee"],
    onSelect,
  },
  {
    id: "reject",
    label: "Reject",
    refusalReason: null,
    requires: ["reasonCode"],
    onSelect,
  },
];

describe("workflow state on the concise decision row", () => {
  it("keeps the served state visible and the evidence action reachable", () => {
    const { onOpen } = renderWorkflow({
      state: "open",
      stateLabel: "Open",
      assignee: "Jamie",
      holdUntil: "—",
      actions: OPEN_ACTIONS(() => {}),
    });

    const chip = document.querySelector('[data-el="wf-chip"]');
    expect(chip?.getAttribute("data-workflow-state")).toBe("open");
    expect(chip?.textContent).toBe("Open");
    expect(chip?.getAttribute("title")).toBe("Jamie");

    fireEvent.click(
      document.querySelector("[data-meta-exact-card-open]")!,
    );
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("does not render the removed transition menu or required-field forms", () => {
    const onSelect = vi.fn();
    renderWorkflow({
      state: "open",
      stateLabel: "Open",
      assignee: "—",
      holdUntil: "—",
      actions: OPEN_ACTIONS(onSelect),
    });

    expect(
      document.querySelector('[data-ctl="gated:META-WF-02..08 menu"]'),
    ).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.querySelector("[data-workflow-action]")).toBeNull();
    expect(
      document.querySelector("[data-meta-exact-workflow-form]"),
    ).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps a decision action disabled when no authorized callback was served", () => {
    renderWorkflow({
      state: "open",
      stateLabel: "Open",
      assignee: "—",
      holdUntil: "—",
      actionsRefusedReason: "raw internal workflow gate reason",
      menuRefusedReason: "raw internal workflow gate reason",
      actions: OPEN_ACTIONS(() => {}),
    });

    expect(
      screen.getByRole("button", { name: "Review decision" }),
    ).toBeDisabled();
    expect(document.body.textContent).not.toContain(
      "raw internal workflow gate reason",
    );
    expect(document.querySelector("[data-workflow-menu-refusal]")).toBeNull();
  });

  it("keeps an authorized decision action working independently of workflow", () => {
    const onPrimary = vi.fn();
    renderWorkflow(
      {
        state: "acknowledged",
        stateLabel: "Acknowledged",
        assignee: "—",
        holdUntil: "—",
        actions: OPEN_ACTIONS(() => {}),
      },
      { onPrimary },
    );

    const action = screen.getByRole("button", { name: "Review decision" });
    expect(action).not.toBeDisabled();
    fireEvent.click(action);
    expect(onPrimary).toHaveBeenCalledOnce();
  });
});

describe("removed workflow conflict chrome", () => {
  it("shows the current server state without rendering conflict controls", () => {
    const onKeepMine = vi.fn();
    const onTakeServer = vi.fn();
    renderWorkflow({
      state: "acknowledged",
      stateLabel: "Acknowledged",
      assignee: "—",
      holdUntil: "—",
      actions: OPEN_ACTIONS(() => {}),
      conflict: {
        currentStateLabel: "Acknowledged",
        currentVersion: 4,
        attemptedLabel: "Resolve",
        attemptedFromVersion: 3,
        message: "raw internal version conflict",
        onKeepMine,
        onTakeServer,
      },
    });

    expect(
      document.querySelector('[data-workflow-state="acknowledged"]')
        ?.textContent,
    ).toBe("Acknowledged");
    expect(document.querySelector('[data-el="conflict-dialog"]')).toBeNull();
    expect(
      document.querySelector('[data-ctl="live:META-WF-11 keep"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-ctl="live:META-WF-11 reapply"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      "raw internal version conflict",
    );
    expect(onKeepMine).not.toHaveBeenCalled();
    expect(onTakeServer).not.toHaveBeenCalled();
  });

  it("does not expose a stale keep-mine refusal on a resolved row", () => {
    renderWorkflow({
      state: "resolved",
      stateLabel: "Resolved",
      assignee: "—",
      holdUntil: "—",
      actions: [],
      conflict: {
        currentStateLabel: "Resolved",
        currentVersion: 4,
        attemptedLabel: "Resolve",
        attemptedFromVersion: 3,
        message: "raw conflict message",
        keepRefusedReason: "raw transition no longer applies",
        onKeepMine: () => {},
        onTakeServer: () => {},
      },
    });

    expect(
      document.querySelector('[data-workflow-state="resolved"]')?.textContent,
    ).toBe("Resolved");
    expect(document.querySelector('[data-el="conflict-dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain(
      "raw transition no longer applies",
    );
  });
});
