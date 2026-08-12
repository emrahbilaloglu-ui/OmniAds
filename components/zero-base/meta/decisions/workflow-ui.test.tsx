// @vitest-environment jsdom

/**
 * The workflow overlay as an operator meets it.
 *
 * The assertions that matter most are about what the overlay must NOT do:
 * never move or restate the served verdict, never resolve a 409 silently,
 * never submit a second transition for one attempt, and never offer a comment
 * control.
 */
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DecisionsView } from "@/components/zero-base/meta/decisions/decisions-view";
import { WorkflowPanel, type WorkflowSubmitResult } from "@/components/zero-base/meta/decisions/workflow-overlay";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { buildDecisionsViewModel } from "@/lib/zero-base/meta/decisions-presentation";
import { newWorkflowRecord, type WorkflowRecord } from "@/lib/decision-workflow";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaLanePayload } from "@/components/meta/redesign/types";
import type { DecisionsUrlState } from "@/lib/zero-base/meta/decisions-url-state";

afterEach(cleanup);

const VERDICT = "Scale up — 7-day ROAS 3.4 vs target 2.6";

function record(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return { ...newWorkflowRecord({ businessId: "biz-1", decisionKey: "ad:1" }), ...overrides };
}

type SubmitFn = NonNullable<React.ComponentProps<typeof WorkflowPanel>["onSubmit"]>;
type SubmitSpy = ReturnType<typeof vi.fn<SubmitFn>>;

function panel(props: Partial<React.ComponentProps<typeof WorkflowPanel>> = {}): SubmitSpy {
  // Always a spy, so every caller can read the recorded calls.
  const submit: SubmitSpy = props.onSubmit
    ? (vi.fn(props.onSubmit) as SubmitSpy)
    : (vi.fn(async () => ({
        ok: true,
        workflow: record({ state: "acknowledged", stateVersion: 2 }),
        replayed: false,
      }) as WorkflowSubmitResult) as SubmitSpy);
  render(
    <ZeroBasePortalHost>
      <WorkflowPanel
        decisionKey="ad:1"
        servedIds={["ad:1"]}
        record={record()}
        events={[]}
        loadState={{ kind: "ready" }}
        posture={{ kind: "write" }}
        newMutationId={() => "11111111-1111-4111-8111-111111111111"}
        {...props}
        onSubmit={submit}
      />
    </ZeroBasePortalHost>,
  );
  return submit;
}

/* ---------------------------------------------------------------- the chip */

describe("state chip", () => {
  it("shows the current state", () => {
    panel({ record: record({ state: "deferred" }) });
    expect(document.querySelector('[data-workflow-chip="deferred"]')).not.toBeNull();
  });

  it("says unknown rather than open when the overlay could not be read", () => {
    // "Open" here would claim nobody owns a decision somebody may well own.
    panel({ loadState: { kind: "error", reason: "unreachable" }, record: null });
    expect(document.querySelector('[data-workflow-chip="unknown"]')).not.toBeNull();
    expect(document.querySelector('[data-workflow-chip="open"]')).toBeNull();
  });

  it("distinguishes loading from unknown", () => {
    panel({ loadState: { kind: "loading" }, record: null });
    expect(document.querySelector('[data-workflow-chip="loading"]')).not.toBeNull();
  });
});

/* ------------------------------------------------------------ role posture */

describe("role posture reaches the controls", () => {
  it("gives a guest no transition control", () => {
    panel({ posture: { kind: "read", reason: "Guests can see workflow state but not change it." } });
    expect(document.querySelectorAll("[data-workflow-action]").length).toBe(0);
    expect(document.querySelector('[data-workflow-posture="read"]')).not.toBeNull();
  });

  it("denies a reviewer with a reason, not a silent absence", () => {
    panel({ posture: { kind: "denied", reason: "Reviewer sessions cannot change workflow state." } });
    expect(document.querySelector('[data-workflow-posture="denied"]')!.textContent).toMatch(
      /Reviewer sessions/,
    );
    expect(document.querySelectorAll("[data-workflow-action]").length).toBe(0);
  });

  it("gives a collaborator the menu", () => {
    panel();
    expect(document.querySelectorAll("[data-workflow-action]").length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------ served-universe gate */

describe("a decision that left the served set", () => {
  it("refuses instead of offering controls", () => {
    panel({ servedIds: ["ad:2"] });
    expect(document.querySelector("[data-workflow-refusal]")).not.toBeNull();
    expect(document.querySelectorAll("[data-workflow-action]").length).toBe(0);
  });
});

/* -------------------------------------------------------------- no comments */

describe("no comment surface", () => {
  it("offers no comment action and no comment field", () => {
    panel();
    expect(document.querySelector('[data-workflow-action="comment"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/comment/i);
  });

  it("renders no comment text even when the journal has some", () => {
    panel({
      events: [
        {
          event: "reject",
          fromState: "open",
          toState: "rejected",
          actorUserId: "u1",
          actorName: "Ada",
          reasonCode: "wrong_target",
          stateVersion: 2,
          occurredAt: "2026-08-11T09:00:00.000Z",
        },
      ],
    });
    // The reason code is structured and shown; free-form comment text is not
    // part of the projection at all.
    expect(screen.getByText(/wrong_target/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/comment/i);
  });
});

/* ------------------------------------------------------------- the ceremony */

describe("applying a transition", () => {
  it("sends expectedVersion and a mutation id", async () => {
    const submit = panel({ record: record({ stateVersion: 5 }) });
    const user = userEvent.setup();

    await user.click(document.querySelector('[data-workflow-action="acknowledge"]') as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Acknowledge" }));

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({
      action: "acknowledge",
      expectedVersion: 5,
      mutationId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("announces progress and the result in a live region", async () => {
    panel();
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-workflow-action="acknowledge"]') as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Acknowledge" }));

    await waitFor(() =>
      expect(document.querySelector("[data-workflow-live]")!.textContent).toMatch(/applied/i),
    );
    expect(document.querySelector("[data-workflow-live]")!.getAttribute("aria-live")).toBe("polite");
    // It must also say the decision itself did not change.
    expect(document.querySelector("[data-workflow-live]")!.textContent).toMatch(/decision itself is unchanged/i);
  });

  it("refuses to submit until a required field is supplied", async () => {
    const submit = panel();
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-workflow-action="reject"]') as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Reject" }));

    expect(submit).not.toHaveBeenCalled();
    expect(dialog.textContent).toMatch(/Provide reasonCode/);
  });

  it("reuses one mutation id across a retried attempt, so a retry is a replay", async () => {
    const ids = ["a1111111-1111-4111-8111-111111111111", "b2222222-2222-4222-8222-222222222222"];
    let index = 0;
    let call = 0;
    const submit = panel({
      newMutationId: () => ids[index++],
      onSubmit: async () => {
        call += 1;
        return call === 1
          ? { ok: false, kind: "error", message: "network died" }
          : { ok: true, workflow: record({ state: "acknowledged" }), replayed: true };
      },
    });
    const user = userEvent.setup();

    await user.click(document.querySelector('[data-workflow-action="acknowledge"]') as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    // The dialog stays open on failure so nothing typed is lost.
    await user.click(within(dialog).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));

    // Same id both times: a second id would append a second event and bump the
    // version again, so the operator would see their own action twice.
    expect(submit.mock.calls[0][0].mutationId).toBe(ids[0]);
    expect(submit.mock.calls[1][0].mutationId).toBe(ids[0]);
  });

  it("reports a replay as already recorded rather than as a fresh transition", async () => {
    panel({
      onSubmit: async () => ({ ok: true, workflow: record({ state: "acknowledged" }), replayed: true }),
    });
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-workflow-action="acknowledge"]') as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Acknowledge" }));

    await waitFor(() =>
      expect(document.querySelector("[data-workflow-live]")!.textContent).toMatch(
        /already recorded/i,
      ),
    );
  });
});

/* ------------------------------------------------------------------ 409 */

describe("a version conflict is shown, never resolved silently", () => {
  async function conflict() {
    let call = 0;
    const submit = panel({
      record: record({ stateVersion: 2 }),
      onSubmit: async () => {
        call += 1;
        return call === 1
          ? {
              ok: false,
              kind: "conflict",
              current: record({ state: "open", stateVersion: 9 }),
              message: "This decision changed while you were looking at it.",
            }
          : { ok: true, workflow: record({ state: "acknowledged" }), replayed: false };
      },
    });
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-workflow-action="acknowledge"]') as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(document.querySelector("[data-workflow-conflict]")).not.toBeNull());
    return { submit, user };
  }

  it("shows the server's current state beside what was attempted", async () => {
    await conflict();
    expect(document.querySelector("[data-workflow-conflict-current]")!.textContent).toMatch(
      /Open \(version 9\)/,
    );
    expect(document.querySelector("[data-workflow-conflict-attempted]")!.textContent).toMatch(
      /Acknowledge from version 2/,
    );
  });

  it("does not re-send anything on its own", async () => {
    const { submit } = await conflict();
    // A silent retry would overwrite whatever the other operator just did.
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("re-applies only on an explicit act, and against the refreshed version", async () => {
    const { submit, user } = await conflict();
    await user.click(document.querySelector("[data-workflow-reapply]") as HTMLElement);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0].expectedVersion).toBe(9);
  });

  it("offers no re-apply when the refreshed state makes the action impossible", async () => {
    const submit = vi.fn(async () => ({
      ok: false,
      kind: "conflict",
      current: record({ state: "resolved", stateVersion: 6 }),
      message: "changed",
    }) as WorkflowSubmitResult);
    panel({ onSubmit: submit });
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-workflow-action="acknowledge"]') as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Acknowledge" }));

    await waitFor(() =>
      expect(document.querySelector("[data-workflow-reapply-blocked]")).not.toBeNull(),
    );
    expect(document.querySelector("[data-workflow-reapply]")).toBeNull();
  });
});

/* ------------------------------------------------------- keyboard and focus */

describe("keyboard and focus", () => {
  it("traps focus inside the dialog and returns it to the control that opened it", async () => {
    panel();
    const user = userEvent.setup();
    const trigger = document.querySelector('[data-workflow-action="acknowledge"]') as HTMLElement;
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog");
    // Everything focusable is inside the dialog while it is open.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("opens a transition from the keyboard", async () => {
    const submit = panel();
    const user = userEvent.setup();
    (document.querySelector('[data-workflow-action="defer"]') as HTMLElement).focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Defer" }));
    expect(submit.mock.calls[0][0].action).toBe("defer");
  });
});

/* --------------------------------------------- workflow never moves the truth */

function recommendation(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "ad:1",
    level: "ad",
    type: "scale",
    lens: "performance",
    priority: "high",
    confidence: "high",
    decisionState: "act",
    decision: VERDICT,
    title: "Ad 1",
    why: "Because",
    summary: "Summary",
    recommendedAction: "Increase budget 20%",
    expectedImpact: "More volume",
    evidence: [],
    timeframeContext: {
      coreVerdict: VERDICT,
      selectedRangeOverlay: "",
      historicalSupport: "",
      seasonalityFlag: "none",
      note: null,
    },
    ...overrides,
  } as MetaRecommendation;
}

function lane(): MetaLanePayload {
  return {
    actionNow: [recommendation()],
    watching: [],
    healthy: [],
    nonSales: [],
    archive: [],
    counts: { actionNow: 1, watching: 0, healthy: 0, nonSales: 0, archive: 0 },
  } as unknown as MetaLanePayload;
}

const urlState: DecisionsUrlState = {
  lane: "act",
  levels: [],
  search: "",
  selected: "ad:1",
};

function DecisionsHarness({ onSubmit }: { onSubmit: () => Promise<WorkflowSubmitResult> }) {
  const [records, setRecords] = useState(
    new Map([["ad:1", record({ state: "open", stateVersion: 1 })]]),
  );
  return (
    <ZeroBasePortalHost>
      <DecisionsView
        model={buildDecisionsViewModel({
          lane: lane(),
          banners: [],
          viewer: { role: "collaborator", isReviewer: false, readOnly: false, readOnlyReason: null },
          state: urlState,
        })}
        state={urlState}
        demo={false}
        onStateChange={() => {}}
        workflow={{
          records,
          events: [],
          loadState: { kind: "ready" },
          newMutationId: () => "11111111-1111-4111-8111-111111111111",
          onSubmit: async () => {
            const result = await onSubmit();
            if (result.ok) setRecords(new Map([["ad:1", result.workflow]]));
            return result;
          },
        }}
      />
    </ZeroBasePortalHost>
  );
}

describe("workflow annotates; it never moves the truth", () => {
  it("leaves the served verdict byte-identical across a transition", async () => {
    render(
      <DecisionsHarness
        onSubmit={async () => ({
          ok: true,
          workflow: record({ state: "resolved", stateVersion: 2 }),
          replayed: false,
        })}
      />,
    );
    const user = userEvent.setup();

    const before = document.querySelector('[data-verdict="ad:1"]')!.textContent;
    expect(before).toBe(VERDICT);
    const rowsBefore = [...document.querySelectorAll("[data-decision-row]")].map((node) =>
      node.getAttribute("data-decision-row"),
    );

    const dialogTrigger = document.querySelector('[data-workflow-action="resolve"]') as HTMLElement;
    await user.click(dialogTrigger);
    // The inspector sheet is itself a dialog, so the confirm dialog is the
    // second one — scope to the one that actually carries the confirm button.
    const dialogs = await screen.findAllByRole("dialog");
    const confirm = dialogs[dialogs.length - 1];
    await user.click(within(confirm).getByRole("button", { name: "Resolve" }));

    await waitFor(() =>
      expect(document.querySelector('[data-workflow-chip="resolved"]')).not.toBeNull(),
    );

    // Same bytes, same row, same order. Resolving is an annotation.
    expect(document.querySelector('[data-verdict="ad:1"]')!.textContent).toBe(before);
    expect(
      [...document.querySelectorAll("[data-decision-row]")].map((node) =>
        node.getAttribute("data-decision-row"),
      ),
    ).toEqual(rowsBefore);
  });

  it("mounts a chip in the row and the panel in the inspector", () => {
    render(<DecisionsHarness onSubmit={async () => ({ ok: true, workflow: record(), replayed: false })} />);
    expect(document.querySelectorAll("[data-workflow-chip]").length).toBeGreaterThan(0);
    expect(document.querySelector('[data-workflow-panel="ad:1"]')).not.toBeNull();
  });
});
