// @vitest-environment jsdom

/**
 * Who may write on Automation, what survives a reload, and which controls are
 * allowed to exist on the canonical screen.
 *
 * Three laws live here because they fail as one thing on the real surface: an
 * operator looking at a screen that offers an action it cannot perform, a
 * promise it cannot keep, or a state it has not proven.
 *
 * 1. VIEWER ENVELOPE. Every control was gated on `businessId &&
 *    providerAccountId` alone. A resolved ad account is not write authority: a
 *    guest, a reviewer and a demo session all got live Approve / Modify /
 *    Dismiss / + New rule / rule toggle, and learned about the refusal from the
 *    403 that landed after the click. The server decides this once and the
 *    surface restates it — including the code, which the client never
 *    re-derives.
 *
 * 2. LEDGER COMPLETENESS. It was client session state only, so a refresh reset
 *    it and the screen went back to promising "every outcome lands in the
 *    ledger with a receipt" with nothing behind the sentence.
 *
 * 3. THE APPROVED EXCEPTION. The account selector and the Retry controls are
 *    allowed to exist, but ONLY in a multi-account unresolved state and in an
 *    unavailable/error state. The canonical happy path draws neither.
 */
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";

const mocks = vi.hoisted(() => ({
  fetchAccounts: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectedBusinessId: "store_business" }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
}));
vi.mock("@/lib/meta/history-client", () => ({
  fetchMetaHistoryAccounts: mocks.fetchAccounts,
}));

const MetaAutomationPage = (await import("./automation-view")).default;
const { buildAutomationViewerEnvelope } = await import("./viewer-envelope");

const OBSERVED_AT = "2026-08-18T09:00:00.000Z";

/** A payload whose every read completed, including the activity ledger. */
function controlPlane(
  overrides: Partial<MetaAutomationControlPlane> = {},
): MetaAutomationControlPlane {
  return {
    contractVersion: "meta-automation-control-plane.v1",
    businessId: "biz_1",
    providerAccountId: "act_1",
    globalKillSwitch: { engaged: false, reason: null },
    businessControl: {
      businessId: "biz_1",
      killSwitchEngaged: false,
      killSwitchReason: null,
      autoExecutionEnabled: false,
      readinessTier: "manual_review",
      guardrails: {
        dailyAutoActionCap: 3,
        perActionSpendCeilingMinor: 5000,
        perActionSpendCeilingCurrency: "EUR",
        notificationPolicy: "every_auto_action",
        maxBudgetIncreasePct: 15,
        maxDailyBudgetChangeMinor: null,
        requireCampaignLabel: true,
        requireCommercialAnchor: true,
        requireLivePreflight: true,
        requireRollbackPlan: true,
        dryRunOnly: true,
        minRoasFloor: null,
        quietHours: null,
      },
      updatedAt: OBSERVED_AT,
      updatedBy: "user_1",
      source: "persisted",
    },
    execution: {
      autoExecutionAllowed: false,
      writeEndpointsBlocked: false,
      blockedReasons: [],
    },
    promotionRecords: [],
    readCompleteness: {
      promotionRecords: "complete",
      businessControl: "complete",
      activityLedger: "complete",
      rules: "complete",
    },
    activityLedger: [],
    decisionTypeModes: [],
    ...overrides,
  } as MetaAutomationControlPlane;
}

function proposalRow() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    actionLabel: "Pause ad set",
    proposedAction: "pause",
    entityLabel: "Retargeting 7d",
    reason: "ROAS below breakeven.",
    evidenceLabel: "frees $680/d",
    primaryCaption: "Approve & apply",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

interface Wire {
  calls: Array<{ url: string; method: string }>;
}

/**
 * A server that answers both reads. `queue` and `post` let a test change one
 * answer without restating the rest of the wire.
 */
function wireServer(input?: {
  queue?: () => Response;
  post?: () => Response;
  automation?: () => Response;
}): Wire {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    request: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(request);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    if (method === "POST") {
      return (
        input?.post?.() ??
        new Response(
          JSON.stringify({
            ok: true,
            readCompleteness: { proposals: "complete" },
            holds: { claimed: 0, reconcile: 0 },
            proposals: [],
            ledgerCompleteness: "complete",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      );
    }
    if (url.startsWith("/api/meta/automation/proposals")) {
      return (
        input?.queue?.() ??
        new Response(
          JSON.stringify({
            ok: true,
            readCompleteness: { proposals: "complete" },
            holds: { claimed: 0, reconcile: 0 },
            proposals: [proposalRow()],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      );
    }
    return (
      input?.automation?.() ??
      new Response(
        JSON.stringify({ ok: true, automation: controlPlane() }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    );
  }) as typeof fetch);
  return { calls };
}

const LIVE_COLLABORATOR = buildAutomationViewerEnvelope({
  role: "collaborator",
  reviewerReadOnly: false,
  writeAuthority: "live",
});

function footnote(container: HTMLElement) {
  return container.querySelector("[data-field='queue-footnote']");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchAccounts.mockResolvedValue([{ id: "act_1", name: "Solo" }]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Automation refusal copy", () => {
  /**
   * The surface duplicates three sentences the routes own, because importing
   * them would drag `next/server` into a `"use client"` bundle. Duplication is
   * fine; SILENT duplication is not — if the route reworded its refusal and the
   * screen kept the old sentence, the operator would be shown a reason the
   * server no longer gives. Compared as SOURCE TEXT so nothing server-only is
   * loaded into this environment.
   */
  const literal = (path: string, name: string) => {
    const source = readFileSync(path, "utf8");
    const match = new RegExp(`${name}\\s*=\\s*\\n?\\s*"([^"]*)"`).exec(source);
    expect(match, `${name} not found in ${path}`).not.toBeNull();
    return match![1];
  };

  it("restates the routes' own sentences character for character", () => {
    const surface =
      "app/(dashboard)/platforms/meta/automation/viewer-envelope.ts";
    const routeDemo = "app/api/meta/automation/demo-write-authority.ts";

    expect(literal(surface, "AUTOMATION_DEMO_REFUSAL")).toBe(
      literal(routeDemo, "AUTOMATION_DEMO_WRITE_REFUSAL"),
    );
    expect(literal(surface, "AUTOMATION_UNVERIFIED_REFUSAL")).toBe(
      literal(routeDemo, "AUTOMATION_UNVERIFIED_WRITE_REFUSAL"),
    );

    const guard = readFileSync("lib/meta/reviewer-write-guard.ts", "utf8");
    const reviewer = /message:\s*"([^"]*read-only[^"]*)"/.exec(guard);
    expect(reviewer).not.toBeNull();
    expect(literal(surface, "AUTOMATION_REVIEWER_REFUSAL")).toBe(reviewer![1]);
  });
});

describe("Automation viewer envelope precedence", () => {
  it("names the refusal the operator would actually hit first", () => {
    // A reviewer on the demo workspace is told about reviewer access, because
    // `rejectIfReviewerReadOnly` is the gate that answers first.
    const reviewerOnDemo = buildAutomationViewerEnvelope({
      role: "admin",
      reviewerReadOnly: true,
      writeAuthority: "demo",
    });

    expect(reviewerOnDemo.reasonCode).toBe("reviewer_read_only");
    expect(reviewerOnDemo.demo).toBe(true);
    expect(reviewerOnDemo.canMutate).toBe(false);
  });

  it("does not turn an unforwarded role into permission or into a refusal", () => {
    // The preserved legacy mount. Nothing established, nothing claimed: the
    // routes still refuse on their own authority, and inventing a refusal here
    // would remove a control that mount has always shown on no evidence.
    const legacy = buildAutomationViewerEnvelope({
      role: undefined,
      reviewerReadOnly: undefined,
      writeAuthority: "not_established",
    });

    expect(legacy.role).toBeNull();
    expect(legacy.canMutate).toBe(true);
    expect(legacy.reason).toBeNull();
    expect(legacy.reasonCode).toBeNull();
  });

  it("keeps a reason and a code in exact lockstep with canMutate", () => {
    for (const role of ["admin", "collaborator", "guest"] as const) {
      for (const reviewerReadOnly of [true, false]) {
        for (const authority of [
          "live",
          "demo",
          "unverified",
          "not_established",
        ] as const) {
          const envelope = buildAutomationViewerEnvelope({
            role,
            reviewerReadOnly,
            writeAuthority: authority,
          });
          // Non-null exactly when a write is unavailable, in both directions.
          expect(envelope.canMutate).toBe(envelope.reason === null);
          expect(envelope.canMutate).toBe(envelope.reasonCode === null);
        }
      }
    }
  });
});

describe("Automation viewer envelope", () => {
  const refusals = [
    {
      label: "a reviewer",
      viewer: buildAutomationViewerEnvelope({
        role: "admin",
        reviewerReadOnly: true,
        writeAuthority: "live",
      }),
      code: "reviewer_read_only",
    },
    {
      label: "a demo workspace",
      viewer: buildAutomationViewerEnvelope({
        role: "admin",
        reviewerReadOnly: false,
        writeAuthority: "demo",
      }),
      code: "demo_business_read_only",
    },
    {
      label: "a guest",
      viewer: buildAutomationViewerEnvelope({
        role: "guest",
        reviewerReadOnly: false,
        writeAuthority: "live",
      }),
      code: "insufficient_role",
    },
    {
      label: "an unverifiable workspace",
      viewer: buildAutomationViewerEnvelope({
        role: "admin",
        reviewerReadOnly: false,
        writeAuthority: "unverified",
      }),
      code: "demo_status_unverified",
    },
  ];

  for (const refusal of refusals) {
    it(`issues no network write when ${refusal.label} clicks a queue control`, async () => {
      const wire = wireServer();
      const { container } = render(
        <MetaAutomationPage
          businessId="biz_1"
          // The account IS resolved. That is the whole point: resolving an
          // account used to be the only condition these controls had.
          providerAccountId="act_1"
          initialPayload={controlPlane()}
          viewer={refusal.viewer}
        />,
      );

      const approve = await waitFor(() => {
        const found = container.querySelector<HTMLButtonElement>(
          "[data-control='approve']",
        );
        expect(found).not.toBeNull();
        return found!;
      });

      for (const control of ["approve", "modify", "dismiss"]) {
        const button = container.querySelector<HTMLButtonElement>(
          `[data-control='${control}']`,
        );
        expect(button, control).not.toBeNull();
        expect(button!.disabled, control).toBe(true);
        fireEvent.click(button!);
      }
      fireEvent.click(approve);

      // Real provider write count for this test: zero, and it is zero because
      // nothing left the browser — not because a route refused it.
      expect(wire.calls.filter((call) => call.method === "POST")).toHaveLength(0);

      // + New rule answers to the same authority. Matched by its caption
      // because `aria-expanded` is also on Modify, and matching that instead
      // is how this assertion first passed while proving nothing.
      const newRule = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "+ New rule");
      expect(newRule).toBeDefined();
      expect(newRule!.disabled).toBe(true);
      expect(newRule!.getAttribute("aria-disabled")).toBe("true");

      // The server's own sentence and the server's own code, restated.
      const stated = container.querySelector("[data-field='viewer-refusal']");
      expect(stated).not.toBeNull();
      expect(stated!.textContent).toBe(refusal.viewer.reason);
      expect(stated!.getAttribute("data-reason-code")).toBe(refusal.code);
    });
  }

  it("keeps the queue live for a viewer the server permits", async () => {
    const wire = wireServer();
    const { container } = render(
      <MetaAutomationPage
        businessId="biz_1"
        providerAccountId="act_1"
        initialPayload={controlPlane()}
        viewer={LIVE_COLLABORATOR}
      />,
    );

    const approve = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        "[data-control='approve']",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(approve.disabled).toBe(false);
    expect(container.querySelector("[data-field='viewer-refusal']")).toBeNull();

    fireEvent.click(approve);
    await waitFor(() => {
      expect(wire.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    });
  });
});

describe("Automation ledger completeness after a reload", () => {
  it("rebuilds the promise from the served read model, not from session state", async () => {
    wireServer();
    // A fresh mount is exactly what a refresh produces: no session state at all.
    const { container } = render(
      <MetaAutomationPage
        businessId="biz_1"
        providerAccountId="act_1"
        initialPayload={controlPlane()}
        viewer={LIVE_COLLABORATOR}
      />,
    );

    await waitFor(() => {
      expect(footnote(container)?.getAttribute("data-ledger-evidence")).toBe(
        "complete",
      );
    });
    expect(footnote(container)?.textContent).toContain(
      "lands in the ledger with a receipt",
    );
  });

  it("makes no promise after a reload whose activity read did not complete", async () => {
    const broken = controlPlane({
      readCompleteness: {
        promotionRecords: "complete",
        businessControl: "complete",
        activityLedger: "unavailable",
        rules: "complete",
      },
    });
    wireServer({
      automation: () =>
        new Response(JSON.stringify({ ok: true, automation: broken }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const { container } = render(
      <MetaAutomationPage
        businessId="biz_1"
        providerAccountId="act_1"
        initialPayload={broken}
        viewer={LIVE_COLLABORATOR}
      />,
    );

    await waitFor(() => {
      expect(footnote(container)?.getAttribute("data-ledger-evidence")).toBe(
        "no_evidence",
      );
    });
    // Neither claim is made: nothing proves the ledger works, and no decision
    // was made here to have failed.
    expect(footnote(container)?.textContent).not.toContain("every outcome");
    expect(footnote(container)?.textContent).not.toContain(
      "could not be written to the activity ledger",
    );
  });

  it("treats a response that is not JSON as unknown, never as a receipt trail", async () => {
    wireServer({
      post: () =>
        new Response("<html>502 upstream</html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
    });
    const { container } = render(
      <MetaAutomationPage
        businessId="biz_1"
        providerAccountId="act_1"
        initialPayload={controlPlane()}
        viewer={LIVE_COLLABORATOR}
      />,
    );

    const approve = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        "[data-control='approve']",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(approve);

    await waitFor(() => {
      expect(footnote(container)?.getAttribute("data-ledger-evidence")).toBe(
        "unavailable",
      );
    });
    expect(footnote(container)?.textContent).not.toContain("every outcome");
  });

  it("does not let a queue refetch restore a promise a decision already broke", async () => {
    let postDone = false;
    wireServer({
      // The real `proposal_outcome_unknown` shape: a dispatch went out, no
      // provider result came back, the row is held for reconciliation, and the
      // ledger answer travels with the refusal.
      post: () => {
        postDone = true;
        return new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "proposal_outcome_unknown",
              message:
                "This approval was dispatched and no provider result came back.",
            },
            proposalStatus: "reconcile",
            ledgerCompleteness: "unavailable",
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      },
      queue: () =>
        postDone
          ? // The refetch the Retry control runs, and it fails too.
            new Response("gateway", { status: 502 })
          : new Response(
              JSON.stringify({
                ok: true,
                readCompleteness: { proposals: "complete" },
                holds: { claimed: 0, reconcile: 0 },
                proposals: [proposalRow()],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
    });

    const { container } = render(
      <MetaAutomationPage
        businessId="biz_1"
        providerAccountId="act_1"
        initialPayload={controlPlane()}
        viewer={LIVE_COLLABORATOR}
      />,
    );

    const approve = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        "[data-control='approve']",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(approve);

    await waitFor(() => {
      expect(footnote(container)?.getAttribute("data-ledger-evidence")).toBe(
        "unavailable",
      );
    });

    const retry = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        "[data-control='retry-queue']",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(retry);

    // A failed read is not evidence that the ledger recovered. The withdrawn
    // promise stays withdrawn, and the queue stays unproven rather than empty.
    await waitFor(() => {
      expect(container.querySelector("[data-holds='unreadable']")).not.toBeNull();
    });
    expect(
      container
        .querySelector("[data-testid='confirmation-empty']")
        ?.getAttribute("data-proven-empty"),
    ).toBe("false");
    expect(footnote(container)?.getAttribute("data-ledger-evidence")).toBe(
      "unavailable",
    );
    expect(footnote(container)?.textContent).not.toContain("every outcome");
  });

  it("clears the withdrawn promise when the account changes", async () => {
    wireServer({
      post: () =>
        new Response(
          JSON.stringify({
            ok: true,
            readCompleteness: { proposals: "complete" },
            holds: { claimed: 0, reconcile: 0 },
            proposals: [],
            ledgerCompleteness: "unavailable",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });
    const { container, rerender } = render(
      <MetaAutomationPage
        businessId="biz_1"
        providerAccountId="act_1"
        initialPayload={controlPlane()}
        viewer={LIVE_COLLABORATOR}
      />,
    );

    const approve = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>(
        "[data-control='approve']",
      );
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.click(approve);
    await waitFor(() => {
      expect(footnote(container)?.getAttribute("data-ledger-evidence")).toBe(
        "unavailable",
      );
    });

    // "The last decision" is a fact about one business and one ad account.
    // Carrying it into another scope would report a failure that never
    // happened there.
    rerender(
      <MetaAutomationPage
        businessId="biz_1"
        providerAccountId="act_2"
        initialPayload={controlPlane()}
        viewer={LIVE_COLLABORATOR}
      />,
    );

    await waitFor(() => {
      expect(footnote(container)?.getAttribute("data-ledger-evidence")).toBe(
        "complete",
      );
    });
  });
});

describe("Automation account selector and Retry, the approved exception", () => {
  it("draws neither on the canonical resolved screen", async () => {
    wireServer();
    const { container } = render(
      <MetaAutomationPage
        businessId="biz_1"
        providerAccountId="act_1"
        initialPayload={controlPlane()}
        viewer={LIVE_COLLABORATOR}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector("[data-control='approve']"),
      ).not.toBeNull();
    });

    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("[data-control='retry-read']")).toBeNull();
    expect(container.querySelector("[data-control='retry-queue']")).toBeNull();
    expect(container.querySelector("[data-field='read-error']")).toBeNull();
  });

  it("draws both where several assigned accounts leave the scope unresolved", async () => {
    mocks.fetchAccounts.mockResolvedValue([
      { id: "act_1", name: "One" },
      { id: "act_2", name: "Two" },
    ]);
    wireServer();
    const { container } = render(
      <MetaAutomationPage
        businessId="biz_1"
        providerAccountId={null}
        viewer={LIVE_COLLABORATOR}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("select")).not.toBeNull();
    });
    expect(container.querySelector("[data-control='retry-read']")).not.toBeNull();
    expect(
      container.querySelector("[data-field='read-error']")?.getAttribute(
        "data-reason",
      ),
    ).toBe("provider_account_scope_unresolved");
  });

  it("draws the Retry where the section read itself failed", async () => {
    wireServer({
      automation: () => new Response("gateway", { status: 502 }),
      queue: () => new Response("gateway", { status: 502 }),
    });
    const { container } = render(
      <MetaAutomationPage
        businessId="biz_1"
        providerAccountId="act_1"
        viewer={LIVE_COLLABORATOR}
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector("[data-control='retry-read']"),
      ).not.toBeNull();
    });
    expect(container.querySelector("[data-control='retry-queue']")).not.toBeNull();
    // A failure, not a picker: the account resolved, so nothing here is a
    // choice the operator can make.
    expect(container.querySelector("select")).toBeNull();
  });
});
