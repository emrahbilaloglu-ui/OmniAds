// @vitest-environment jsdom

/**
 * The manual write ceremony as an operator meets it.
 *
 * The single most important test in this file is the first one: with the
 * server-owned flag off there is no control, and — more to the point — zero
 * preflight and zero dispatch calls are possible, because the ceremony is never
 * constructed at all.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DecisionsView } from "@/components/zero-base/_reference/meta-decisions-view";
import {
  MutationCeremonyPanel,
  type DispatchAnswer,
  type MutationCeremonySeed,
  type PreflightAnswer,
} from "@/components/zero-base/meta/decisions/mutation-ceremony-panel";
import type { MutationAction } from "@/lib/zero-base/meta/mutation-ceremony";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { buildDecisionsViewModel } from "@/lib/zero-base/meta/decisions-presentation";
import {
  MUTATION_UI_FLAG,
  isMutationUiEnabled,
} from "@/lib/zero-base/meta/mutation-ceremony";
import {
  buildDispatchDescriptor,
  type DispatchDescriptor,
} from "@/lib/zero-base/meta/dispatch-contract";
import type { DecisionRow } from "@/lib/zero-base/meta/decisions-presentation";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaLanePayload } from "@/components/meta/redesign/types";
import type { DecisionsUrlState } from "@/lib/zero-base/meta/decisions-url-state";

afterEach(cleanup);

const NOW = new Date("2026-08-11T12:00:00.000Z");

function row(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    // A served DISPLAY id, in the shape the engine actually produces. The
    // panel must never send this to the preflight: `parseDecisionKey` refuses
    // `structure-…` / `bid-…` outright with `decision_not_actionable`.
    id: "structure-ad-1",
    // The row's grain identity. This, and only this, is the decision key.
    decisionKey: "ad:ad-1",
    // DecisionLevel has no "ad" member; an ad-grain decision is served at
    // adset level with an ad-keyed identity, which is what the preflight parses.
    level: "adset",
    title: "Ad 1",
    decision: "Scale up",
    why: "Because",
    recommendedAction: "Increase budget",
    confidence: "high",
    confidenceReason: null,
    decisionState: "act",
    campaignName: "C",
    adsetName: "A",
    held: false,
    heldReason: null,
    ...overrides,
  };
}

/** The real builder, so a test can never assert against a body shape that
 *  the handlers would refuse. */
function descriptor(
  action: "pause" | "resume" | "bid" | "duplicate" = "pause",
  grain: "campaign" | "adset" | "ad" = "ad",
): DispatchDescriptor {
  const built = buildDispatchDescriptor({
    businessId: "biz-1",
    target: {
      grain,
      entityId: grain === "ad" ? "ad-1" : grain === "adset" ? "adset-1" : "camp-1",
      providerAccountId: "act_1",
      creativeId: "cr-1",
      parentId: "adset-1",
    },
    action,
    accountCurrency: "USD",
    issuedAt: "2026-08-11T11:59:00.000Z",
  });
  if (!built.ok) throw new Error(built.reason);
  return built.descriptor;
}

function readyPreflight(overrides: Partial<Extract<PreflightAnswer, { ok: true }>> = {}) {
  return {
    ok: true as const,
    target: {
      grain: "ad" as const,
      entityId: "ad-1",
      providerAccountId: "act_1",
      status: "ACTIVE",
    },
    verdict: "ready" as const,
    detail: "Target verified against persisted state.",
    checkedAt: "2026-08-11T11:59:00.000Z",
    dispatch: descriptor(),
    ...overrides,
  };
}

function mount(
  seedOverrides: Partial<MutationCeremonySeed> = {},
  rowOverrides: Partial<DecisionRow> = {},
  offeredActions?: readonly MutationAction[],
) {
  const preflight = vi.fn<MutationCeremonySeed["preflight"]>(
    async () => readyPreflight() as PreflightAnswer,
  );
  const dispatch = vi.fn<MutationCeremonySeed["dispatch"]>(async () => ({
    outcome: "verified",
    durable: true,
    reference: "attempt-1",
    detail: "Meta confirmed and we re-read it.",
  }));
  const seed: MutationCeremonySeed = {
    businessId: "biz-1",
    enabled: true,
    viewer: { isReviewer: false, demo: false, role: "collaborator" },
    preflight,
    dispatch,
    newMutationId: () => "11111111-1111-4111-8111-111111111111",
    now: () => NOW,
    ...seedOverrides,
  };
  render(
    <ZeroBasePortalHost>
      <MutationCeremonyPanel
        row={row(rowOverrides)}
        seed={seed}
        {...(offeredActions ? { offeredActions } : {})}
      />
    </ZeroBasePortalHost>,
  );
  return { preflight, dispatch };
}

async function reachConfirm(user: ReturnType<typeof userEvent.setup>, action = "pause") {
  await user.click(document.querySelector(`[data-mutation-action="${action}"]`) as HTMLElement);
  const dialogs = await screen.findAllByRole("dialog");
  return dialogs[dialogs.length - 1];
}

/* --------------------------------------------------------------- the flag */

describe("the flag is the outermost gate", () => {
  it("is off unless explicitly set to true", () => {
    const env = (value?: string) =>
      (value === undefined ? {} : { [MUTATION_UI_FLAG]: value }) as NodeJS.ProcessEnv;
    // Unset, empty, and every near-miss spelling are all off.
    expect(isMutationUiEnabled(env())).toBe(false);
    expect(isMutationUiEnabled(env(""))).toBe(false);
    expect(isMutationUiEnabled(env("1"))).toBe(false);
    expect(isMutationUiEnabled(env("TRUE"))).toBe(false);
    expect(isMutationUiEnabled(env("true"))).toBe(true);
  });

  it("is a server name, never a public one", () => {
    expect(MUTATION_UI_FLAG.startsWith("NEXT_PUBLIC_")).toBe(false);
  });

  it("renders zero controls and makes zero calls when the seed is absent", async () => {
    const preflight = vi.fn();
    const dispatch = vi.fn();
    render(
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
          /* mutation prop deliberately omitted — the server did not enable it */
        />
      </ZeroBasePortalHost>,
    );

    expect(document.querySelectorAll("[data-mutation-ceremony]").length).toBe(0);
    expect(document.querySelectorAll("[data-mutation-action]").length).toBe(0);
    // Nothing exists to call them; that is the point of absence over disabling.
    expect(preflight).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------------------- posture */

describe("posture refuses before anything is offered", () => {
  it("refuses a reviewer", () => {
    mount({ viewer: { isReviewer: true, demo: false, role: "admin" } });
    expect(document.querySelector("[data-mutation-denied]")!.textContent).toMatch(/Reviewer/);
    expect(document.querySelectorAll("[data-mutation-action]").length).toBe(0);
  });

  it("refuses the demo business", () => {
    mount({ viewer: { isReviewer: false, demo: true, role: "admin" } });
    expect(document.querySelectorAll("[data-mutation-action]").length).toBe(0);
  });

  it("refuses a guest", () => {
    mount({ viewer: { isReviewer: false, demo: false, role: "guest" } });
    expect(document.querySelectorAll("[data-mutation-action]").length).toBe(0);
  });

  it("refuses a held decision, whatever its label says", () => {
    mount({}, { held: true, heldReason: "No authorized action for this decision." });
    expect(document.querySelector("[data-mutation-denied]")!.textContent).toMatch(
      /No authorized action/,
    );
    expect(document.querySelectorAll("[data-mutation-action]").length).toBe(0);
  });

  it("withholds every control from a row with no grain identity", async () => {
    // An account-grain row, or one whose provider ids never resolved, has no
    // decision-bound key. Drawing a control here would be drawing one whose
    // only possible answer is `decision_not_actionable`.
    const { preflight } = mount({}, { decisionKey: null });
    expect(document.querySelector("[data-mutation-denied]")!.textContent).toMatch(
      /does not name a single campaign or ad set/,
    );
    expect(document.querySelectorAll("[data-mutation-action]").length).toBe(0);
    expect(preflight).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------ the offered verbs */

describe("only the verbs the caller was given are drawn", () => {
  it("draws exactly the server's own verb when the caller names one", () => {
    // The Decision Center passes `[operatorApply.action]`. A campaign or ad-set
    // card used to draw all four, so an operator was offered "duplicate" at a
    // grain that has no endpoint and the route answers `unsupported_action`.
    mount({}, {}, ["pause"]);
    expect(document.querySelectorAll("[data-mutation-action]").length).toBe(1);
    expect(document.querySelector('[data-mutation-action="pause"]')).not.toBeNull();
    for (const absent of ["resume", "bid", "duplicate"]) {
      expect(document.querySelector(`[data-mutation-action="${absent}"]`), absent).toBeNull();
    }
  });

  it("draws nothing at all when the caller names no verb", () => {
    mount({}, {}, []);
    expect(document.querySelectorAll("[data-mutation-action]").length).toBe(0);
  });
});

/* ------------------------------------------------------------ the ordering */

describe("the ordered state machine", () => {
  it("sends only the decision key and action to the preflight", async () => {
    const { preflight } = mount();
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-mutation-action="pause"]') as HTMLElement);
    await waitFor(() => expect(preflight).toHaveBeenCalled());
    // No account, no entity, no expected state.
    expect(Object.keys(preflight.mock.calls[0][0]).sort()).toEqual([
      "action",
      "businessId",
      "decisionKey",
    ]);
    // The row's grain identity, NOT its display id ("structure-ad-1"). This is
    // the law that changed: the panel used to send `row.id`, so every
    // card-level Apply came back 422 `decision_not_actionable`.
    expect(preflight.mock.calls[0][0]).toMatchObject({ decisionKey: "ad:ad-1", action: "pause" });
    expect(preflight.mock.calls[0][0].decisionKey).not.toBe("structure-ad-1");
  });

  it("sends the same decision-bound key at dispatch time as at the first check", async () => {
    const { preflight, dispatch } = mount();
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "pause" }));

    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(preflight.mock.calls[1][0].decisionKey).toBe("ad:ad-1");
  });

  it("preflights before it ever offers a confirmation", async () => {
    const { preflight, dispatch } = mount();
    const user = userEvent.setup();
    await reachConfirm(user);
    expect(preflight).toHaveBeenCalledTimes(1);
    // Confirmation reached, nothing dispatched yet.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("surfaces a server refusal by its code and never reaches a confirmation", async () => {
    const { dispatch } = mount({
      preflight: async () => ({
        ok: false,
        code: "provider_account_not_assigned",
        message: "The account behind this decision is not assigned to this business.",
      }),
    });
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-mutation-action="pause"]') as HTMLElement);

    await waitFor(() =>
      expect(
        document.querySelector('[data-mutation-refusal="provider_account_not_assigned"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("requires a re-check past 15 minutes rather than acting on an aged check", async () => {
    const { dispatch } = mount({
      preflight: async () => readyPreflight({ checkedAt: "2026-08-11T11:44:00.000Z" }),
    });
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-mutation-action="pause"]') as HTMLElement);

    await waitFor(() =>
      expect(document.querySelector('[data-mutation-step="stale"]')).not.toBeNull(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.querySelector("[data-mutation-recheck]")).not.toBeNull();
  });

  it("sends changed live state back for review instead of to a confirmation", async () => {
    const { dispatch } = mount({
      preflight: async () =>
        readyPreflight({ verdict: "drifted", detail: "The ad is already paused." }),
    });
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-mutation-action="pause"]') as HTMLElement);

    await waitFor(() =>
      expect(document.querySelector('[data-mutation-step="changed"]')!.textContent).toMatch(
        /already paused/,
      ),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("states the exact proven scope in the confirmation", async () => {
    mount();
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    const scope = within(dialog).getByText(/ad ad-1 in account act_1/);
    expect(scope.textContent).toMatch(/Currently ACTIVE/);
    // And says plainly that this was persisted state, not a live check.
    expect(scope.textContent).toMatch(/Meta was not contacted/);
  });
});

/* ----------------------------------------------------------- confirmation */

describe("confirmation level", () => {
  it("takes a typed phrase for resuming spend", async () => {
    const { dispatch } = mount({
      preflight: async () => readyPreflight({ dispatch: descriptor("resume", "ad") }),
    });
    const user = userEvent.setup();
    const dialog = await reachConfirm(user, "resume");

    // Confirm is unavailable until the phrase is typed.
    await user.click(within(dialog).getByRole("button", { name: "resume" }));
    expect(dispatch).not.toHaveBeenCalled();

    await user.type(within(dialog).getByRole("textbox"), "RESUME");
    await user.click(within(dialog).getByRole("button", { name: "resume" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  });

  it("takes an acknowledgement for pausing", async () => {
    const { dispatch } = mount();
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    // No text box at all: pause is reversible.
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "pause" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  });
});

/* --------------------------------------------------------------- dispatch */

describe("dispatch goes to the typed endpoint with the proven id", () => {
  it("builds the path from the server's endpoint and the server's id", async () => {
    const { dispatch } = mount();
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "pause" }));

    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch.mock.calls[0][0].path).toBe("/api/meta/ads/ad-1/pause");
    // No generic executor anywhere in the path.
    expect(dispatch.mock.calls[0][0].path).not.toMatch(/execute|dispatch/);
    expect(dispatch.mock.calls[0][0].mutationId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("posts the server's own concrete path, never one it assembled", async () => {
    const { dispatch } = mount();
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "pause" }));

    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    // Byte-identical to what the descriptor carried; nothing was recomputed.
    expect(dispatch.mock.calls[0][0].path).toBe(descriptor().path);
  });

  it("posts the handler's exact body, not a generic two-field one", async () => {
    const { dispatch } = mount();
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "pause" }));

    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    // This is what the acceptance review caught: the old client sent only
    // businessId and mutationId, which every handler refuses.
    expect(dispatch.mock.calls[0][0].body).toEqual({
      actionOrigin: "manual_operator_v1",
      manualConfirmation: "explicit_operator_confirmation",
      businessId: "biz-1",
      providerAccountId: "act_1",
      adId: "ad-1",
      creativeId: "cr-1",
    });
  });

  it("announces progress and the terminal outcome", async () => {
    mount();
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "pause" }));

    await waitFor(() =>
      expect(document.querySelector("[data-mutation-live]")!.textContent).toMatch(
        /Applied and verified/,
      ),
    );
    expect(document.querySelector("[data-mutation-live]")!.getAttribute("aria-live")).toBe("polite");
  });

  it("returns focus to the action that opened the confirmation when it is dismissed", async () => {
    mount();
    const user = userEvent.setup();
    const trigger = document.querySelector('[data-mutation-action="pause"]') as HTMLElement;
    await user.click(trigger);
    await screen.findAllByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

/* --------------------------------------------------------------- terminal */

describe("terminal outcomes", () => {
  async function terminal(answer: DispatchAnswer) {
    mount({ dispatch: async () => answer });
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "pause" }));
    await waitFor(() =>
      expect(document.querySelector('[data-mutation-step="terminal"]')).not.toBeNull(),
    );
  }

  it("offers a copyable receipt for a durable verified attempt", async () => {
    await terminal({ outcome: "verified", durable: true, reference: "a-1", detail: "ok" });
    expect(document.querySelector("[data-mutation-receipt]")).not.toBeNull();
  });

  it("offers no receipt when the attempt never reached a durable log", async () => {
    await terminal({ outcome: "verified", durable: false, reference: null, detail: "ok" });
    expect(document.querySelector("[data-mutation-receipt]")).toBeNull();
    expect(document.querySelector("[data-mutation-receipt-withheld]")).not.toBeNull();
  });

  it("offers no receipt under ambiguity, even when the attempt is durable", async () => {
    await terminal({
      outcome: "provider_outcome_ambiguous",
      durable: true,
      reference: "a-1",
      detail: "unknown",
    });
    // A receipt here invites reading "we do not know" as "it worked".
    expect(document.querySelector("[data-mutation-receipt]")).toBeNull();
  });

  it("permits a retry only after a clean refusal", async () => {
    await terminal({ outcome: "failed", durable: true, reference: "a-1", detail: "refused" });
    expect(document.querySelector("[data-mutation-retry]")).not.toBeNull();
  });

  it("forbids a retry under ambiguity", async () => {
    await terminal({
      outcome: "provider_outcome_ambiguous",
      durable: true,
      reference: null,
      detail: "unknown",
    });
    // The provider may already have applied it; retrying could double it.
    expect(document.querySelector("[data-mutation-retry]")).toBeNull();
    expect(document.querySelector("[data-mutation-retry-blocked]")!.textContent).toMatch(
      /reconciliation/,
    );
  });

  it("forbids a retry after a silent failure", async () => {
    await terminal({ outcome: "silent_failure", durable: true, reference: "a-1", detail: "?" });
    expect(document.querySelector("[data-mutation-retry]")).toBeNull();
  });

  it("names the outcome on the surface, not only in the announcement", async () => {
    await terminal({ outcome: "silent_failure", durable: true, reference: "a-1", detail: "?" });
    expect(
      document.querySelector('[data-mutation-outcome="silent_failure"]')!.textContent,
    ).toMatch(/verification failed/i);
  });
});

/* --------------------------------------------------------------- fixtures */

function recommendation(): MetaRecommendation {
  return {
    id: "ad:ad-1",
    level: "adset",
    type: "scale",
    lens: "performance",
    priority: "high",
    confidence: "high",
    decisionState: "act",
    decision: "Scale up",
    title: "Ad 1",
    why: "Because",
    summary: "Summary",
    recommendedAction: "Increase budget",
    expectedImpact: "More volume",
    evidence: [],
    timeframeContext: {
      coreVerdict: "Scale up",
      selectedRangeOverlay: "",
      historicalSupport: "",
      seasonalityFlag: "none",
      note: null,
    },
  } as unknown as MetaRecommendation;
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
  selected: "ad:ad-1",
};

/* ------------------------------------------- operator fields and validation */

describe("actions with operator choices collect and validate first", () => {
  function bidSeed() {
    const dispatchSpy = vi.fn<MutationCeremonySeed["dispatch"]>(async () => ({
      outcome: "verified",
      durable: true,
      reference: "a-1",
      detail: "ok",
    }));
    const preflightSpy = vi.fn<MutationCeremonySeed["preflight"]>(async () =>
      readyPreflight({
        target: { grain: "adset", entityId: "adset-1", providerAccountId: "act_1", status: "ACTIVE" },
        dispatch: descriptor("bid", "adset"),
      }),
    );
    mount({ preflight: preflightSpy, dispatch: dispatchSpy });
    return { preflight: preflightSpy, dispatch: dispatchSpy };
  }

  it("shows a bid form before any confirmation, in the account's currency", async () => {
    bidSeed();
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-mutation-action="bid"]') as HTMLElement);

    await waitFor(() =>
      expect(document.querySelector('[data-mutation-step="collect"]')).not.toBeNull(),
    );
    // No dialog yet: the operator has not been asked to confirm anything.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText(/Bid amount \(minor units, USD\)/)).toBeTruthy();
  });

  it("refuses to reach the confirmation with an empty amount", async () => {
    const { dispatch } = bidSeed();
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-mutation-action="bid"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector("[data-mutation-review]")).not.toBeNull());
    await user.click(document.querySelector("[data-mutation-review]") as HTMLElement);

    expect(document.querySelector("[data-mutation-problems]")!.textContent).toMatch(/required/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses a non-integer or zero amount before the confirmation", async () => {
    for (const bad of ["12.5", "0", "-3", "abc"]) {
      cleanup();
      const { dispatch } = bidSeed();
      const user = userEvent.setup();
      await user.click(document.querySelector('[data-mutation-action="bid"]') as HTMLElement);
      await waitFor(() => expect(document.querySelector("[data-mutation-review]")).not.toBeNull());
      await user.type(screen.getByLabelText(/Bid amount/), bad);
      await user.click(document.querySelector("[data-mutation-review]") as HTMLElement);

      expect(document.querySelector("[data-mutation-problems]"), bad).not.toBeNull();
      expect(dispatch, bad).not.toHaveBeenCalled();
    }
  });

  it("sends a valid amount as a number in the handler's own body", async () => {
    const { dispatch } = bidSeed();
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-mutation-action="bid"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector("[data-mutation-review]")).not.toBeNull());
    await user.type(screen.getByLabelText(/Bid amount/), "250");
    await user.click(document.querySelector("[data-mutation-review]") as HTMLElement);

    const dialogs = await screen.findAllByRole("dialog");
    const confirm = dialogs[dialogs.length - 1];
    // A bid starts money moving, so it takes a typed phrase.
    await user.type(within(confirm).getByRole("textbox"), "CHANGE BID");
    await user.click(within(confirm).getByRole("button", { name: "bid" }));

    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch.mock.calls[0][0].path).toBe("/api/meta/adsets/adset-1/apply-bid");
    expect(dispatch.mock.calls[0][0].body).toMatchObject({
      actionOrigin: "manual_operator_v1",
      manualConfirmation: "explicit_operator_confirmation",
      providerAccountId: "act_1",
      bidAmountMinor: 250,
    });
  });

  it("collects a destination for a duplicate and never asks to activate it", async () => {
    const dispatchSpy = vi.fn<MutationCeremonySeed["dispatch"]>(async () => ({
      outcome: "verified",
      durable: true,
      reference: "a-1",
      detail: "ok",
    }));
    mount({
      preflight: async () => readyPreflight({ dispatch: descriptor("duplicate", "ad") }),
      dispatch: dispatchSpy,
    });
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-mutation-action="duplicate"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector("[data-mutation-review]")).not.toBeNull());

    // The route refuses activation outright, so no toggle is offered and the
    // constraint is stated instead.
    expect(document.querySelector("[data-mutation-note]")!.textContent).toMatch(
      /always created paused/,
    );
    expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(0);

    await user.type(screen.getByLabelText(/Destination ad set/), "adset-2");
    await user.click(document.querySelector("[data-mutation-review]") as HTMLElement);
    const dialogs = await screen.findAllByRole("dialog");
    await user.click(within(dialogs[dialogs.length - 1]).getByRole("button", { name: "duplicate" }));

    await waitFor(() => expect(dispatchSpy).toHaveBeenCalled());
    expect(dispatchSpy.mock.calls[0][0].body).toMatchObject({ targetAdsetId: "adset-2" });
    expect(Object.keys(dispatchSpy.mock.calls[0][0].body)).not.toContain("activateAfterCreate");
  });
});

/* ------------------------------------------------ withheld rather than shown */

describe("an action the handler could not accept is withheld, not offered", () => {
  it("says why, and never reaches a confirmation", async () => {
    const dispatchSpy = vi.fn<MutationCeremonySeed["dispatch"]>();
    mount({
      preflight: async () => ({
        ok: false,
        kind: "withheld",
        code: "creative_identity_unavailable",
        message:
          "This ad's exact creative identity is not recorded, and the action endpoint requires it.",
      }),
      dispatch: dispatchSpy,
    });
    const user = userEvent.setup();
    await user.click(document.querySelector('[data-mutation-action="pause"]') as HTMLElement);

    await waitFor(() =>
      expect(
        document.querySelector('[data-mutation-refusal="creative_identity_unavailable"]'),
      ).not.toBeNull(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

/* -------------------------------------- a fresh preflight at dispatch time */

describe("the target is re-checked at dispatch, not only before confirmation", () => {
  it("runs preflight again after the operator confirms", async () => {
    const { preflight, dispatch } = mount();
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    expect(preflight).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole("button", { name: "pause" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    // Once to offer the action, once immediately before sending it.
    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when the re-check no longer says ready", async () => {
    let call = 0;
    const dispatchSpy = vi.fn<MutationCeremonySeed["dispatch"]>();
    mount({
      preflight: async () => {
        call += 1;
        return call === 1
          ? readyPreflight()
          : readyPreflight({ verdict: "drifted", detail: "The ad is already paused." });
      },
      dispatch: dispatchSpy,
    });
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "pause" }));

    await waitFor(() =>
      expect(document.querySelector('[data-mutation-step="changed"]')!.textContent).toMatch(
        /already paused/,
      ),
    );
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("sends nothing when the re-check refuses outright", async () => {
    let call = 0;
    const dispatchSpy = vi.fn<MutationCeremonySeed["dispatch"]>();
    mount({
      preflight: async () => {
        call += 1;
        return call === 1
          ? readyPreflight()
          : {
              ok: false,
              code: "target_ambiguous",
              message: "More than one warehouse row matches this identity.",
            };
      },
      dispatch: dispatchSpy,
    });
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "pause" }));

    await waitFor(() =>
      expect(document.querySelector('[data-mutation-refusal="target_ambiguous"]')).not.toBeNull(),
    );
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("dispatches the body from the FRESH descriptor, not the stale one", async () => {
    let call = 0;
    const dispatchSpy = vi.fn<MutationCeremonySeed["dispatch"]>(async () => ({
      outcome: "verified",
      durable: true,
      reference: "a-1",
      detail: "ok",
    }));
    mount({
      preflight: async () => {
        call += 1;
        return readyPreflight({
          dispatch: {
            ...descriptor(),
            // The account was re-resolved between the two checks.
            body: { ...descriptor().body, providerAccountId: call === 1 ? "act_stale" : "act_1" },
          },
        });
      },
      dispatch: dispatchSpy,
    });
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "pause" }));

    await waitFor(() => expect(dispatchSpy).toHaveBeenCalled());
    expect(dispatchSpy.mock.calls[0][0].body).toMatchObject({ providerAccountId: "act_1" });
  });

  it("keeps one mutation id across a retried attempt", async () => {
    const ids = ["a1111111-1111-4111-8111-111111111111", "b2222222-2222-4222-8222-222222222222"];
    let index = 0;
    let call = 0;
    const dispatchSpy = vi.fn<MutationCeremonySeed["dispatch"]>(async () => {
      call += 1;
      return call === 1
        ? { outcome: "failed", durable: true, reference: "a-1", detail: "Meta refused." }
        : { outcome: "verified", durable: true, reference: "a-1", detail: "ok" };
    });
    mount({ dispatch: dispatchSpy, newMutationId: () => ids[index++] });
    const user = userEvent.setup();
    const dialog = await reachConfirm(user);
    await user.click(within(dialog).getByRole("button", { name: "pause" }));
    await waitFor(() => expect(document.querySelector("[data-mutation-retry]")).not.toBeNull());

    await user.click(document.querySelector("[data-mutation-retry]") as HTMLElement);
    const again = await screen.findAllByRole("dialog");
    await user.click(within(again[again.length - 1]).getByRole("button", { name: "pause" }));

    await waitFor(() => expect(dispatchSpy).toHaveBeenCalledTimes(2));
    // A clean refusal left the attempt open, so the retry is the same attempt.
    expect(dispatchSpy.mock.calls[0][0].mutationId).toBe(ids[0]);
    expect(dispatchSpy.mock.calls[1][0].mutationId).toBe(ids[0]);
  });
});
