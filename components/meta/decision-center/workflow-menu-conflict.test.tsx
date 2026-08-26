// @vitest-environment jsdom
/**
 * The workflow menu (H11) and the version-conflict dialog (H12).
 *
 * Both were reachable-but-invisible before this: `/api/meta/decision-workflow`
 * has carried all seven transitions with `expectedVersion` optimistic
 * concurrency for a long time, the hook has always returned a structured 409,
 * and the page threw it away — so a refused transition changed the row's state
 * on screen and said nothing about why.
 *
 * The menu had a second problem that was worse than invisibility. Seven bare
 * buttons were drawn, and three of them could not work: `assign`, `snooze` and
 * `reject` were fired with their required fields hard-coded null, so two were
 * guaranteed 422s and `assign` was a no-op that still incremented
 * `stateVersion` — which made every other open tab conflict over a change that
 * changed nothing.
 */
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

function renderWorkflow(workflow: MetaDecisionCenterExactWorkflow) {
  return render(
    <MetaDecisionCenterExact
      viewModel={{
        actionRows: [{ id: "row_1", name: "Prospecting", onOpen: () => {} }],
        inspector: { entityName: "Prospecting", workflow },
      }}
    />,
  );
}

const OPEN_ACTIONS = (
  onSelect: (values: Record<string, string>) => void,
): MetaDecisionCenterExactWorkflow["actions"] => [
  { id: "acknowledge", label: "Acknowledge", refusalReason: null, requires: [], onSelect },
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

describe("the transition menu", () => {
  it("opens, moves with the arrows, and Escape returns focus to the trigger", () => {
    renderWorkflow({
      state: "open",
      stateLabel: "Open",
      assignee: "—",
      holdUntil: "—",
      actions: OPEN_ACTIONS(() => {}),
    });

    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-ctl="gated:META-WF-02..08 menu"]',
    )!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    expect(items).toHaveLength(3);

    (items[0] as HTMLElement).focus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("sends a fieldless transition immediately", () => {
    const onSelect = vi.fn();
    renderWorkflow({
      state: "open",
      stateLabel: "Open",
      assignee: "—",
      holdUntil: "—",
      actions: OPEN_ACTIONS(onSelect),
    });

    fireEvent.click(
      document.querySelector('[data-ctl="gated:META-WF-02..08 menu"]')!,
    );
    fireEvent.click(document.querySelector('[data-workflow-action="acknowledge"]')!);
    expect(onSelect).toHaveBeenCalledWith({});
  });

  it("collects the field a transition cannot be sent without", () => {
    const onSelect = vi.fn();
    renderWorkflow({
      state: "open",
      stateLabel: "Open",
      assignee: "—",
      holdUntil: "—",
      actions: OPEN_ACTIONS(onSelect),
    });

    fireEvent.click(
      document.querySelector('[data-ctl="gated:META-WF-02..08 menu"]')!,
    );
    fireEvent.click(document.querySelector('[data-workflow-action="reject"]')!);

    // Nothing sent yet: `reject` with no reason code is a guaranteed 422.
    expect(onSelect).not.toHaveBeenCalled();
    const form = document.querySelector('[data-meta-exact-workflow-form="reject"]')!;
    fireEvent.change(form.querySelector("input")!, {
      target: { value: "duplicate_of_open_work" },
    });
    fireEvent.submit(form);

    expect(onSelect).toHaveBeenCalledWith({
      reasonCode: "duplicate_of_open_work",
    });
  });

  it("keeps the trigger and states the reason when the gate is shut", () => {
    renderWorkflow({
      state: "open",
      stateLabel: "Open",
      assignee: "—",
      holdUntil: "—",
      actionsRefusedReason:
        "Decision ownership actions are not enabled on this workspace yet.",
      menuRefusedReason:
        "Decision ownership actions are not enabled on this workspace yet.",
      actions: OPEN_ACTIONS(() => {}),
    });

    const trigger = document.querySelector(
      '[data-ctl="gated:META-WF-02..08 menu"]',
    );
    // Present and refusing: a menu that vanished would take its own
    // explanation with it, which is the contract's own failure clause.
    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(trigger!);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      document.querySelector("[data-workflow-menu-refusal]")?.textContent,
    ).toContain("not enabled");
  });
});

describe("the version-conflict dialog", () => {
  const CONFLICT = {
    currentStateLabel: "Acknowledged",
    currentVersion: 4,
    attemptedLabel: "Resolve",
    attemptedFromVersion: 3,
    message: "This decision changed while you were reading it.",
  };

  it("shows both states and offers keep-mine and take-server", () => {
    const onKeepMine = vi.fn();
    const onTakeServer = vi.fn();
    renderWorkflow({
      state: "acknowledged",
      stateLabel: "Acknowledged",
      assignee: "—",
      holdUntil: "—",
      actions: OPEN_ACTIONS(() => {}),
      conflict: { ...CONFLICT, onKeepMine, onTakeServer },
    });

    const dialog = document.querySelector('[data-el="conflict-dialog"]');
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(
      dialog?.querySelector("[data-meta-exact-conflict-current]")?.textContent,
    ).toContain("Acknowledged · version 4");
    expect(
      dialog?.querySelector("[data-meta-exact-conflict-attempted]")?.textContent,
    ).toContain("Resolve · from version 3");

    /*
     * The two keys read backwards and they are the design's own: `keep` is
     * KEEP MINE — "re-submits transition with fresh expectedVersion" — and
     * `reapply` is TAKE SERVER — "discards local transition; row re-renders
     * server state".
     */
    fireEvent.click(document.querySelector('[data-ctl="live:META-WF-11 keep"]')!);
    expect(onKeepMine).toHaveBeenCalledTimes(1);
    fireEvent.click(
      document.querySelector('[data-ctl="live:META-WF-11 reapply"]')!,
    );
    expect(onTakeServer).toHaveBeenCalledTimes(1);
  });

  it("refuses keep-mine in words when the transition no longer applies", () => {
    const onKeepMine = vi.fn();
    renderWorkflow({
      state: "resolved",
      stateLabel: "Resolved",
      assignee: "—",
      holdUntil: "—",
      actions: [],
      conflict: {
        ...CONFLICT,
        currentStateLabel: "Resolved",
        keepRefusedReason:
          "Resolve no longer applies to a decision that is Resolved.",
        onKeepMine,
        onTakeServer: () => {},
      },
    });

    const keep = document.querySelector('[data-ctl="live:META-WF-11 keep"]')!;
    expect(keep.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(keep);
    expect(onKeepMine).not.toHaveBeenCalled();
    expect(
      document.querySelector("[data-meta-exact-conflict-keep-refused]")
        ?.textContent,
    ).toContain("no longer applies");
  });

  it("draws no dialog when there is no conflict", () => {
    renderWorkflow({
      state: "open",
      stateLabel: "Open",
      assignee: "—",
      holdUntil: "—",
      actions: OPEN_ACTIONS(() => {}),
    });
    expect(document.querySelector('[data-el="conflict-dialog"]')).toBeNull();
  });
});
