// @vitest-environment jsdom

/**
 * The activation control, driven.
 *
 * The production defect this covers: two complete routes —
 * `POST /api/launchpad/meta/intents/[id]/activate` and its
 * `activation-approval` sibling — had no caller anywhere in the repository, and
 * the launch receipt ended with a flat sentence saying no activation control
 * was available. These tests drive the control that reaches them.
 *
 * SAFETY: `fetch` is stubbed at the network boundary for every test in this
 * file, so nothing leaves the process. The stub records what *would* have been
 * sent, which is how the authority fields are asserted.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LaunchpadActivationPanel,
  approvableScopes,
  describeBlockedHierarchy,
} from "@/components/launchpad/LaunchpadActivationPanel";
import { LaunchpadProgress } from "@/components/launchpad/LaunchpadProgress";

const BUSINESS = "22222222-2222-4222-8222-222222222222";
const INTENT = "11111111-1111-4111-8111-111111111111";
const APPROVER = "33333333-3333-4333-8333-333333333333";

let calls: Array<{ url: string; body: Record<string, unknown> }> = [];

function stub(response: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return {
        ok: response.ok === true,
        status: response.ok === true ? 200 : 409,
        json: async () => response,
      } as Response;
    }),
  );
}

function storedApproval(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: "meta.launch-activation-approval.v2",
    businessId: BUSINESS,
    providerAccountId: "act_1",
    launchIntentId: INTENT,
    requestFingerprint: "f".repeat(64),
    approvedOperation: "new_campaign",
    approvedScope: "hierarchy",
    approvedAssets: [{ creativeId: "crt_1", version: "v1" }],
    approvedCopy: { hash: "a".repeat(64) },
    approvedDestination: { campaignId: "cmp_1", adsetIds: ["as_1"] },
    approvedBy: APPROVER,
    approvedAt: "2026-09-05T09:00:00.000Z",
    expiresAt: "2026-09-06T09:00:00.000Z",
    revokedAt: null,
    policyVersion: "meta.activation-policy.v1",
    ...overrides,
  };
}

function panel(props: Partial<React.ComponentProps<typeof LaunchpadActivationPanel>> = {}) {
  return (
    <LaunchpadActivationPanel
      businessId={BUSINESS}
      intentId={INTENT}
      intentStatus="succeeded"
      operation="new_campaign"
      approval={null}
      activationReceipt={null}
      canMutate
      refusalReason={null}
      {...props}
    />
  );
}

function type(selector: string, value: string) {
  const input = document.querySelector(selector) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LaunchpadActivationPanel", () => {
  it("says operator-only when no approval is stored, and still offers Activate now", () => {
    stub({ ok: true });
    render(panel());

    expect(
      document.querySelector('[data-activation-approval="absent"]')?.textContent,
    ).toContain("operator only");
    // Activating does not depend on a stored approval — the operator's own
    // confirmation is the authority — so the control is present and enabled
    // once the phrase is typed.
    const run = document.querySelector("[data-activation-run]") as HTMLButtonElement;
    expect(run).not.toBeNull();
    expect(run.disabled).toBe(true);
    type("[data-activation-phrase]", "ACTIVATE");
    expect((document.querySelector("[data-activation-run]") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("offers hierarchy only for a new-campaign intent, and the ad alone otherwise", () => {
    expect(approvableScopes("new_campaign")).toEqual(["hierarchy"]);
    expect(approvableScopes("add_to_existing")).toEqual(["ad"]);

    stub({ ok: true });
    const { unmount } = render(panel({ operation: "add_to_existing" }));
    expect(document.body.textContent).toContain("the ad alone");
    expect(document.body.textContent).not.toContain("Scope for this launch is campaign");
    unmount();

    render(panel({ operation: "new_campaign" }));
    expect(document.body.textContent).toContain("campaign, ad set and ad");
  });

  it("posts the operator authority for an approval and no client-computed copy hash", async () => {
    stub({ ok: true, revoked: false });
    render(panel());

    type("[data-activation-asset-version]", "v7");
    type("[data-activation-ttl]", "12");
    type("[data-activation-approve-phrase]", "APPROVE");
    (document.querySelector("[data-activation-approve]") as HTMLButtonElement).click();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toBe(
      `/api/launchpad/meta/intents/${INTENT}/activation-approval`,
    );
    expect(calls[0]!.body).toEqual({
      businessId: BUSINESS,
      actionOrigin: "manual_operator_v1",
      manualConfirmation: "explicit_operator_confirmation",
      approvedScope: "hierarchy",
      approvedAssetVersion: "v7",
      ttlHours: 12,
    });
    /*
      Nothing in the product produces a copy hash, so a client that sent one
      would be inventing the binding the approval rests on. The route derives it
      from the intent's own creative set instead.
    */
    expect(Object.keys(calls[0]!.body)).not.toContain("approvedCopyHash");
  });

  it("revokes with an explicit revoke flag and keeps saying who approved what", async () => {
    stub({ ok: true, revoked: true });
    const { rerender } = render(panel({ approval: storedApproval() }));

    (document.querySelector("[data-activation-revoke]") as HTMLButtonElement).click();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({
      businessId: BUSINESS,
      actionOrigin: "manual_operator_v1",
      manualConfirmation: "explicit_operator_confirmation",
      revoke: true,
    });
    expect(
      document.querySelector("[data-activation-approval-outcome]")?.textContent,
    ).toContain("operator-only again");

    // The write sets `revokedAt` rather than clearing the column, so the reader
    // still shows the approver and when the approval was withdrawn.
    rerender(
      panel({
        approval: storedApproval({ revokedAt: "2026-09-05T11:30:00.000Z" }),
      }),
    );
    const shown = document.querySelector('[data-activation-approval="present"]')!;
    expect(shown.textContent).toContain(APPROVER);
    expect(shown.textContent).toContain("withdrawn 2026-09-05T11:30:00.000Z");
    expect(
      document.querySelector('[data-activation-approval-revoked]')?.textContent,
    ).toContain("operator-only again");
  });

  it("reports a blocked hierarchy as a blocked step and never calls the ad live", async () => {
    expect(
      describeBlockedHierarchy(
        [
          {
            grain: "campaign",
            entityId: "cmp_1",
            outcome: "activated",
            reason: null,
            verified: null,
            actionLogId: null,
            claimOutcome: null,
          },
        ],
        "adset",
      ),
    ).toBe("campaign is on, ad set is not");

    stub({
      ok: true,
      delivering: false,
      blockedAt: "adset",
      blockedReason: "effective_status_not_active",
      steps: [
        {
          grain: "campaign",
          entityId: "cmp_1",
          outcome: "activated",
          reason: null,
          verified: { status: "ACTIVE", effectiveStatus: "ACTIVE" },
          actionLogId: "log-campaign",
          claimOutcome: "activated",
        },
        {
          grain: "adset",
          entityId: "as_1",
          outcome: "blocked",
          reason: "effective_status_not_active",
          verified: { status: "ACTIVE", effectiveStatus: "CAMPAIGN_PAUSED" },
          actionLogId: "log-adset",
          claimOutcome: "refused",
        },
        {
          grain: "ad",
          entityId: "ad_1",
          outcome: "not_attempted",
          reason: null,
          verified: null,
          actionLogId: null,
          claimOutcome: null,
        },
      ],
    });
    render(panel());
    type("[data-activation-phrase]", "ACTIVATE");
    (document.querySelector("[data-activation-run]") as HTMLButtonElement).click();

    await waitFor(() =>
      expect(document.querySelector("[data-activation-receipt]")).not.toBeNull(),
    );
    const receipt = document.querySelector("[data-activation-receipt]")!;
    expect(receipt.getAttribute("data-activation-delivering")).toBe("false");
    expect(receipt.textContent).toContain("campaign is on, ad set is not");
    expect(receipt.textContent).toContain("effective_status_not_active");
    // The ad's own row is present and says it was never attempted. Nothing
    // anywhere in this receipt says delivering.
    expect(
      document.querySelector('[data-activation-step="ad"]')?.getAttribute(
        "data-activation-step-outcome",
      ),
    ).toBe("not_attempted");
    expect(receipt.textContent).not.toContain("Delivering");
    // Each step names the durable action-log row it was journalled in.
    expect(receipt.textContent).toContain("log log-adset");
  });

  it("counts the entities rather than naming a grain once, when a launch made several", async () => {
    /*
      A launch that created two ad sets and two ads reports one step per entity.
      Saying "ad set is on" when one of two is on would be the same lie the
      receipt itself used to tell by activating only the first of each grain.
    */
    const step = (
      grain: "campaign" | "adset" | "ad",
      entityId: string,
      outcome: string,
    ) => ({
      grain, entityId, outcome, reason: null, verified: null,
      actionLogId: null, claimOutcome: null,
    });
    expect(
      describeBlockedHierarchy(
        [
          step("campaign", "cmp_1", "activated"),
          step("adset", "as_1", "activated"),
          step("adset", "as_2", "blocked"),
          step("ad", "ad_1", "activated"),
          step("ad", "ad_2", "not_attempted"),
        ] as never,
        "adset",
      ),
    ).toBe("campaign, 1 of 2 ad sets and 1 of 2 ads are on, ad set is not");

    stub({
      ok: true,
      delivering: false,
      blockedAt: "adset",
      blockedReason: "adset_in_review",
      steps: [
        step("campaign", "cmp_1", "activated"),
        step("adset", "as_1", "activated"),
        step("adset", "as_2", "blocked"),
        step("ad", "ad_1", "activated"),
        step("ad", "ad_2", "not_attempted"),
      ],
    });
    render(panel());
    type("[data-activation-phrase]", "ACTIVATE");
    (document.querySelector("[data-activation-run]") as HTMLButtonElement).click();

    await waitFor(() =>
      expect(document.querySelector("[data-activation-receipt]")).not.toBeNull(),
    );
    const receipt = document.querySelector("[data-activation-receipt]")!;
    expect(receipt.getAttribute("data-activation-delivering")).toBe("false");
    // Three of five, said out loud — "not delivering" alone would cover both
    // this and a launch where nothing came on at all.
    expect(
      document.querySelector("[data-activation-coverage]")?.getAttribute(
        "data-activation-coverage",
      ),
    ).toBe("3/5");
    expect(receipt.textContent).toContain("3 of 5 entities this launch created are on");
    // Every identity has its own row, including the one nothing was sent to.
    expect(document.querySelectorAll("[data-activation-step]")).toHaveLength(5);
  });

  it("disables every control with the server's own sentence rather than hiding it", () => {
    stub({ ok: true });
    render(
      panel({
        canMutate: false,
        refusalReason: "Reviewer access is read-only for Launchpad writes.",
        approval: storedApproval(),
      }),
    );

    expect(document.querySelector("[data-activation-refusal]")?.textContent).toContain(
      "Reviewer access is read-only for Launchpad writes.",
    );
    for (const selector of [
      "[data-activation-run]",
      "[data-activation-approve]",
      "[data-activation-revoke]",
    ]) {
      const control = document.querySelector(selector) as HTMLButtonElement;
      expect(control, selector).not.toBeNull();
      expect(control.disabled, selector).toBe(true);
    }
  });

  it("does not read an unreadable intent as an intent with no approval", () => {
    stub({ ok: true });
    render(
      panel({
        approvalUnavailableReason:
          "The launch record could not be re-read, so its stored activation approval is not stated here.",
      }),
    );

    expect(document.querySelector('[data-activation-approval="absent"]')).toBeNull();
    expect(
      document.querySelector('[data-activation-approval="unknown"]')?.textContent,
    ).toContain("could not be re-read");
    // Approving needs the standing state; activating never did.
    expect(
      (document.querySelector("[data-activation-approve]") as HTMLButtonElement).disabled,
    ).toBe(true);
    type("[data-activation-phrase]", "ACTIVATE");
    expect(
      (document.querySelector("[data-activation-run]") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  /*
    Where the panel is allowed to appear, and where the old sentence stands.

    "No activation, undo, rollback, or retry control is available in this
    receipt" was true of the whole product and is now true only of a receipt
    that cannot be activated. A silent failure never proved anything exists —
    `activateLaunchIntent` refuses it with `intent_not_succeeded` — so it keeps
    the sentence, and a succeeded launch gets the control instead.

    (This law is about `LaunchpadProgress`, and belongs in that component's own
    test file; it lives here only because this pass owns this file and not that
    one.)
  */
  it("takes the place of the receipt banner only where the receipt can be activated", () => {
    const activatable = renderToStaticMarkup(
      <LaunchpadProgress
        loading={false}
        onDone={() => {}}
        activation={<div data-testid="activation-slot">Activate</div>}
        result={{
          ok: true,
          launchIntentId: INTENT,
          launchIntentStatus: "succeeded",
          campaignId: "cmp_1",
          adsetIds: ["adset_1"],
          adIds: ["ad_1"],
        }}
      />,
    );
    expect(activatable).toContain('data-testid="activation-slot"');
    expect(activatable).not.toContain("No activation, undo, rollback, or retry control");
    expect(activatable).toContain('data-testid="launchpad-intent-receipt"');

    const notActivatable = renderToStaticMarkup(
      <LaunchpadProgress
        loading={false}
        onDone={() => {}}
        activation={<div data-testid="activation-slot">Activate</div>}
        result={{
          ok: false,
          launchIntentId: INTENT,
          launchIntentStatus: "silent_failure",
          error: { code: "silent_failure", message: "Verification could not find the ad." },
        }}
      />,
    );
    expect(notActivatable).not.toContain('data-testid="activation-slot"');
    expect(notActivatable).toContain("No activation, undo, rollback, or retry control");
  });

  /*
    The Automation queue renders `data-read-only="true"` at 390px, so the launch
    receipt is the activation path that has to reach a phone. Both widths mount
    the same controls; nothing is dropped from the narrow one.
  */
  for (const width of [1280, 390]) {
    it(`mounts every control at ${width}`, () => {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
      stub({ ok: true });
      render(panel({ approval: storedApproval() }));

      expect(document.querySelector("[data-testid='launchpad-activation-panel']")).not.toBeNull();
      expect(document.querySelector("[data-activation-run]")).not.toBeNull();
      expect(document.querySelector("[data-activation-approve]")).not.toBeNull();
      expect(document.querySelector("[data-activation-revoke]")).not.toBeNull();
      expect(document.querySelector("[data-activation-phrase]")).not.toBeNull();
      expect(document.querySelector("[data-activation-ttl]")).not.toBeNull();
    });
  }
});
