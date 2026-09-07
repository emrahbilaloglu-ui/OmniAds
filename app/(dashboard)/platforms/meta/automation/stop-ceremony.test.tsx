// @vitest-environment jsdom
/**
 * The Meta Stop ceremony, on the body the route mounts.
 *
 * The surface had a direct engage/release pair: one click, a POST, and whatever
 * the payload said next. The ceremony WP13 asks for — a fresh persisted
 * preflight, a typed confirmation in both directions, and a status claim only a
 * server read-back may make — existed only in
 * `components/zero-base/_reference/meta-automation-view.tsx`, which no route
 * mounts.
 *
 * The states proven here are the ones a live harness cannot reach on demand: a
 * reading that is stale, a reading that failed, a read-back that answers the
 * other way. `playwright/tests/meta-runtime-automation-stop.spec.ts` proves the
 * wiring against the running server; this proves the decisions.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import { STOP_PREFLIGHT_MAX_AGE_MS } from "@/lib/zero-base/meta/automation-posture";

const mocks = vi.hoisted(() => ({
  fetchAccounts: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectedBusinessId: "biz_1" }),
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

/*
 * Real time, not a frozen clock.
 *
 * The freshness window is measured against `Date.now()` inside the resolver,
 * and `vi.setSystemTime` only takes effect with fake timers — which `waitFor`
 * cannot run under. Offsets from the real clock make every case exact without
 * needing either.
 */
const NOW = Date.now();

function controlPlane(input: {
  engaged?: boolean;
  observedAt?: string;
  sectionStatus?: "complete" | "unavailable" | "migration_required";
  sections?: boolean;
}): MetaAutomationControlPlane {
  const observedAt = input.observedAt ?? new Date(NOW - 30_000).toISOString();
  return {
    contractVersion: "meta-automation-control-plane.v1",
    businessId: "biz_1",
    providerAccountId: "act_1",
    globalKillSwitch: { engaged: false, reason: null },
    businessControl: {
      businessId: "biz_1",
      killSwitchEngaged: input.engaged === true,
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
      updatedAt: observedAt,
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
    ...(input.sections === false
      ? {}
      : {
          sections: {
            businessControl: {
              status: input.sectionStatus ?? "complete",
              errorCode:
                (input.sectionStatus ?? "complete") === "complete"
                  ? null
                  : "control_plane_read_failed",
              observedAt,
            },
          },
        }),
    activityLedger: [],
    decisionTypeModes: [],
  } as unknown as MetaAutomationControlPlane;
}

const ADMIN = buildAutomationViewerEnvelope({
  role: "admin",
  reviewerReadOnly: false,
  writeAuthority: "live",
});
const COLLABORATOR = buildAutomationViewerEnvelope({
  role: "collaborator",
  reviewerReadOnly: false,
  writeAuthority: "live",
});

/** A server that answers every read and records every POST. */
function wire(input?: {
  post?: () => Response;
  after?: () => MetaAutomationControlPlane;
}) {
  const posts: Array<{ url: string; body: unknown }> = [];
  let reads = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    request: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(request);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.startsWith("/api/meta/automation?")) {
      posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return (
        input?.post?.() ??
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (method === "POST") {
      return new Response(
        JSON.stringify({
          ok: true,
          readCompleteness: { proposals: "complete" },
          holds: { claimed: 0, reconcile: 0 },
          proposals: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith("/api/meta/automation/proposals")) {
      return new Response(
        JSON.stringify({
          ok: true,
          readCompleteness: { proposals: "complete" },
          holds: { claimed: 0, reconcile: 0 },
          proposals: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    reads += 1;
    return new Response(
      JSON.stringify({
        ok: true,
        automation: input?.after ? input.after() : controlPlane({}),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch);
  return {
    posts,
    reads: () => reads,
  };
}

function mount(
  payload: MetaAutomationControlPlane,
  viewer = ADMIN,
  stopEngageRefusalReason: string | null = null,
) {
  return render(
    <MetaAutomationPage
      businessId="biz_1"
      initialPayload={payload}
      providerAccountId="act_1"
      stopEngageRefusalReason={stopEngageRefusalReason}
      viewer={viewer}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchAccounts.mockResolvedValue([{ id: "act_1", name: "Solo" }]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the reading the confirmation is made against", () => {
  it("keeps the preflight evidence in attributes without exposing backend copy", () => {
    wire();
    const { container } = mount(controlPlane({}));

    const preflight = container.querySelector("[data-stop-preflight]")!;
    expect(preflight.getAttribute("data-stop-preflight")).toBe("complete");
    expect(preflight.getAttribute("data-stop-preflight-at")).toBe(
      new Date(NOW - 30_000).toISOString(),
    );
    expect(preflight.textContent).not.toContain("control-plane");
    expect(preflight.textContent).not.toContain("older than");
  });

  it("refuses a stale reading with a short recovery message", () => {
    wire();
    const stale = new Date(
      NOW - STOP_PREFLIGHT_MAX_AGE_MS - 1_000,
    ).toISOString();
    const { container } = mount(controlPlane({ observedAt: stale }));

    const blocked = container.querySelector("[data-stop-blocked]")!;
    expect(blocked.getAttribute("data-stop-blocked")).toBe("preflight_stale");
    expect(blocked.textContent).toContain(
      "Refresh before changing the emergency stop.",
    );
    expect(blocked.textContent).not.toContain(stale);
    // Present and refusing: the control never vanishes — and it stays in the
    // tab order, because `disabled` would put the reason out of keyboard
    // reach and the reason is why it is still on screen.
    const staleTrigger = container.querySelector(
      "[data-stop-trigger]",
    ) as HTMLButtonElement;
    expect(staleTrigger).not.toBeNull();
    expect(staleTrigger.disabled).toBe(false);
    expect(staleTrigger.getAttribute("aria-disabled")).toBe("true");
    expect(staleTrigger.hasAttribute("data-stop-refused")).toBe(true);
  });

  it("refuses an incomplete reading without exposing the server error code", () => {
    wire();
    const { container } = mount(controlPlane({ sectionStatus: "unavailable" }));

    const blocked = container.querySelector("[data-stop-blocked]")!;
    expect(blocked.getAttribute("data-stop-blocked")).toBe(
      "preflight_unavailable",
    );
    expect(blocked.textContent).toContain(
      "Refresh before changing the emergency stop.",
    );
    expect(blocked.textContent).not.toContain("control_plane_read_failed");
  });
});

describe("the role split matches the route", () => {
  /**
   * `app/api/meta/automation/route.ts` takes `collaborator` for
   * `engage_kill_switch` and `admin` for `release_kill_switch`. A surface
   * stricter than the route hides the emergency control from an operator the
   * server would have accepted.
   */
  it("lets a collaborator open the engage confirmation", () => {
    wire();
    const { container } = mount(controlPlane({}), COLLABORATOR);

    expect(container.querySelector("[data-stop-blocked]")).toBeNull();
    const trigger = container.querySelector(
      "[data-stop-trigger]",
    ) as HTMLButtonElement;
    expect(trigger.getAttribute("data-ctl")).toBe("gated:AUTO-01A engage");
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute("aria-disabled")).toBeNull();
  });

  it("refuses a collaborator the release, because releasing re-enables spend", () => {
    wire();
    const { container } = mount(controlPlane({ engaged: true }), COLLABORATOR);

    expect(
      container
        .querySelector("[data-stop-blocked]")
        ?.getAttribute("data-stop-blocked"),
    ).toBe("insufficient_role");
    const trigger = container.querySelector(
      "[data-stop-trigger]",
    ) as HTMLButtonElement;
    expect(trigger.getAttribute("data-ctl")).toBe("gated:AUTO-02 release");
    // Refused, and still reachable: `aria-disabled` holds the action while the
    // control keeps its place in the tab order so the reason can be read.
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.disabled).toBe(false);
  });
});

describe("the gate holds engage and never holds release", () => {
  it("refuses engage without exposing rollout details", () => {
    wire();
    const reason = "The Meta Stop is not enabled on this workspace yet.";
    const { container } = mount(controlPlane({}), ADMIN, reason);

    const blocked = container.querySelector("[data-stop-blocked]")!;
    expect(blocked.getAttribute("data-stop-blocked")).toBe("gate_closed");
    expect(blocked.textContent).toContain(
      "The emergency stop is unavailable right now.",
    );
    expect(blocked.textContent).not.toContain(reason);
  });

  it("leaves release open at the same gate setting", () => {
    wire();
    const { container } = mount(
      controlPlane({ engaged: true }),
      ADMIN,
      "The Meta Stop is not enabled on this workspace yet.",
    );

    expect(container.querySelector("[data-stop-blocked]")).toBeNull();
    const gatedTrigger = container.querySelector(
      "[data-stop-trigger]",
    ) as HTMLButtonElement;
    expect(gatedTrigger.disabled).toBe(false);
    expect(gatedTrigger.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("the typed confirmation is what sends the request", () => {
  it("opens without sending, refuses a wrong phrase, and sends on the right one", async () => {
    const server = wire();
    const { container } = mount(controlPlane({}));

    fireEvent.click(container.querySelector("[data-stop-trigger]")!);
    expect(
      container
        .querySelector("[data-stop-confirm]")
        ?.getAttribute("data-stop-confirm"),
    ).toBe("engage");
    // Opening the ceremony is not taking the action.
    expect(server.posts).toEqual([]);

    const submit = container.querySelector(
      "[data-stop-confirm-submit]",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(container.querySelector("[data-stop-confirm-input]")!, {
      target: { value: "STOP" },
    });
    expect(
      (
        container.querySelector(
          "[data-stop-confirm-submit]",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(server.posts).toEqual([]);

    fireEvent.change(container.querySelector("[data-stop-confirm-input]")!, {
      target: { value: "stop meta" },
    });
    // Case-insensitive, because the phrase is a confirmation and not a password.
    expect(
      (
        container.querySelector(
          "[data-stop-confirm-submit]",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    fireEvent.submit(container.querySelector("[data-stop-confirm]")!);
    await waitFor(() => expect(server.posts.length).toBe(1));
    expect(server.posts[0]!.body).toMatchObject({
      action: "engage_kill_switch",
    });
  });

  it("cancels without sending", () => {
    const server = wire();
    const { container } = mount(controlPlane({}));

    fireEvent.click(container.querySelector("[data-stop-trigger]")!);
    fireEvent.click(container.querySelector("[data-stop-confirm-cancel]")!);
    expect(container.querySelector("[data-stop-confirm]")).toBeNull();
    expect(server.posts).toEqual([]);
  });

  it("does not expose the server error message when a stop request fails", async () => {
    const rawMessage = "write_fence_rejected: control_plane_revision_conflict";
    wire({
      post: () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "write_fence_rejected", message: rawMessage },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    });
    const { container } = mount(controlPlane({}));

    fireEvent.click(container.querySelector("[data-stop-trigger]")!);
    fireEvent.change(container.querySelector("[data-stop-confirm-input]")!, {
      target: { value: "STOP META" },
    });
    fireEvent.submit(container.querySelector("[data-stop-confirm]")!);

    await waitFor(() =>
      expect(
        container.querySelector("[data-field='stop-error']"),
      ).not.toBeNull(),
    );
    expect(
      container.querySelector("[data-field='stop-error']")!.textContent,
    ).toBe("The emergency stop could not be changed. Refresh and try again.");
    expect(container.textContent).not.toContain(rawMessage);
  });
});

describe("only a read-back may announce an outcome", () => {
  it("says nothing about the outcome until the confirming read agrees", async () => {
    const server = wire({ after: () => controlPlane({ engaged: true }) });
    const { container } = mount(controlPlane({}));

    fireEvent.click(container.querySelector("[data-stop-trigger]")!);
    fireEvent.change(container.querySelector("[data-stop-confirm-input]")!, {
      target: { value: "STOP META" },
    });
    fireEvent.submit(container.querySelector("[data-stop-confirm]")!);

    await waitFor(() =>
      expect(container.querySelector("[data-stop-status]")).not.toBeNull(),
    );
    expect(
      container.querySelector("[data-stop-status]")!.textContent,
    ).toContain("Meta automation stopped.");
    expect(server.posts.length).toBe(1);
  });

  it("reports unknown when the read-back answers the other way", async () => {
    // The write returned 200 and the state did not change. Claiming either
    // outcome here would be a guess about whether spend is still running.
    const server = wire({ after: () => controlPlane({ engaged: false }) });
    const { container } = mount(controlPlane({}));

    fireEvent.click(container.querySelector("[data-stop-trigger]")!);
    fireEvent.change(container.querySelector("[data-stop-confirm-input]")!, {
      target: { value: "STOP META" },
    });
    fireEvent.submit(container.querySelector("[data-stop-confirm]")!);

    await waitFor(() =>
      expect(container.querySelector("[data-stop-unconfirmed]")).not.toBeNull(),
    );
    const message = container.querySelector(
      "[data-stop-unconfirmed]",
    )!.textContent!;
    expect(message).toContain("The change could not be confirmed");
    expect(message).not.toContain("read-back");
    expect(container.querySelector("[data-stop-status]")).toBeNull();
    expect(server.posts.length).toBe(1);
  });

  it("reports unknown when the confirming read itself fails", async () => {
    const server = wire({
      post: () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    // The re-read throws: `readAutomation` is caught and yields null.
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      request: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(request);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.startsWith("/api/meta/automation?")) {
        server.posts.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.startsWith("/api/meta/automation")) {
        throw new Error("the control plane could not be re-read");
      }
      return new Response(
        JSON.stringify({
          ok: true,
          readCompleteness: {},
          holds: {},
          proposals: [],
        }),
        { status: 200 },
      );
    }) as typeof fetch);

    const { container } = mount(controlPlane({}));
    fireEvent.click(container.querySelector("[data-stop-trigger]")!);
    fireEvent.change(container.querySelector("[data-stop-confirm-input]")!, {
      target: { value: "STOP META" },
    });
    fireEvent.submit(container.querySelector("[data-stop-confirm]")!);

    await waitFor(() =>
      expect(container.querySelector("[data-stop-unconfirmed]")).not.toBeNull(),
    );
    expect(
      container.querySelector("[data-stop-unconfirmed]")!.textContent,
    ).toContain("The change could not be confirmed");
    expect(container.querySelector("[data-stop-status]")).toBeNull();
  });
});

describe("nothing here reaches a provider", () => {
  it("posts only to the automation route and uses operator-facing preview copy", async () => {
    const server = wire({ after: () => controlPlane({ engaged: true }) });
    const { container } = mount(controlPlane({}));

    fireEvent.click(container.querySelector("[data-stop-trigger]")!);
    fireEvent.change(container.querySelector("[data-stop-confirm-input]")!, {
      target: { value: "STOP META" },
    });
    fireEvent.submit(container.querySelector("[data-stop-confirm]")!);
    await waitFor(() => expect(server.posts.length).toBe(1));

    for (const post of server.posts) {
      expect(post.url.startsWith("/api/meta/automation?")).toBe(true);
      expect(post.url).not.toMatch(/facebook|graph\./);
    }
    expect(container.textContent).toContain("Preview only");
    expect(container.textContent).not.toContain("dry run only");
  });
});

/**
 * The confirmation is made in ONE direction, against ONE reading.
 *
 * Both facts could move while the form was open. The phrase was derived from
 * the payload every render while the submitted action came from the direction
 * captured when the form opened, so a payload that moved underneath produced a
 * label reading "Type RESUME META to stop Meta automation for this business" —
 * and typing the phrase on screen submitted the other direction. The reading's
 * age could also cross the five-minute window while the operator typed, and
 * nothing re-renders when a clock passes a boundary, so the confirmation would
 * have been made against a reading the surface itself would now refuse.
 */
describe("a confirmation that was overtaken sends nothing", () => {
  /** Open the ceremony and type its phrase. Returns the container. */
  function openAndType(container: HTMLElement, phrase: string) {
    fireEvent.click(container.querySelector("[data-stop-trigger]")!);
    fireEvent.change(container.querySelector("[data-stop-confirm-input]")!, {
      target: { value: phrase },
    });
  }

  it("keeps the phrase and the copy in the direction the form was opened in", () => {
    wire();
    const { container, rerender } = mount(controlPlane({}));
    openAndType(container, "STOP META");

    // The payload moves underneath: something else stopped automation.
    rerender(
      <MetaAutomationPage
        businessId="biz_1"
        initialPayload={controlPlane({ engaged: true })}
        providerAccountId="act_1"
        stopEngageRefusalReason={null}
        viewer={ADMIN}
      />,
    );

    const form = container.querySelector("[data-stop-confirm]")!;
    expect(form.getAttribute("data-stop-confirm")).toBe("engage");
    // Every word still describes the direction being confirmed.
    expect(
      container
        .querySelector("[data-stop-confirm-input]")!
        .getAttribute("aria-label"),
    ).toBe("Type STOP META to confirm");
    expect(form.textContent).toContain("STOP META");
    expect(form.textContent).not.toContain("RESUME META");
    // And the typed phrase still enables the submit, because it is still the
    // phrase for this direction.
    expect(
      (
        container.querySelector(
          "[data-stop-confirm-submit]",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("refuses and sends nothing when the payload flipped direction while open", () => {
    const server = wire();
    const { container, rerender } = mount(controlPlane({}));
    openAndType(container, "STOP META");

    rerender(
      <MetaAutomationPage
        businessId="biz_1"
        initialPayload={controlPlane({ engaged: true })}
        providerAccountId="act_1"
        stopEngageRefusalReason={null}
        viewer={ADMIN}
      />,
    );
    fireEvent.submit(container.querySelector("[data-stop-confirm]")!);

    expect(
      server.posts,
      "a request was made for a state that had moved",
    ).toEqual([]);
    // Closed, and said why. A form that closes silently reads as a lost click.
    expect(container.querySelector("[data-stop-confirm]")).toBeNull();
    const aborted = container.querySelector("[data-stop-aborted]");
    expect(aborted).not.toBeNull();
    expect(aborted!.textContent).toContain("already stopped");
    expect(aborted!.textContent).toContain("nothing was sent");
  });

  it("refuses and sends nothing when the reading aged out after typing", () => {
    const server = wire();
    /*
     * A controllable clock, not fake timers: the resolver measures the
     * reading's age with `Date.now()`, and `waitFor` cannot run under fake
     * timers. Rendering happens at T0 with a fresh reading; the submit happens
     * after the window has passed, with no re-render in between — which is
     * exactly the case the render-time resolution cannot see.
     */
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { container } = mount(
      controlPlane({ observedAt: new Date(NOW - 30_000).toISOString() }),
    );

    // Fresh at open: the ceremony is offered and the phrase is accepted.
    expect(container.querySelector("[data-stop-blocked]")).toBeNull();
    openAndType(container, "STOP META");
    expect(
      (
        container.querySelector(
          "[data-stop-confirm-submit]",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    clock = NOW + STOP_PREFLIGHT_MAX_AGE_MS + 60_000;
    fireEvent.submit(container.querySelector("[data-stop-confirm]")!);

    expect(server.posts, "a stale confirmation reached the server").toEqual([]);
    expect(container.querySelector("[data-stop-confirm]")).toBeNull();
    const aborted = container.querySelector("[data-stop-aborted]");
    expect(aborted).not.toBeNull();
    expect(aborted!.textContent).toContain(
      "Refresh before changing the emergency stop.",
    );
    expect(aborted!.textContent).not.toContain("control plane");
  });

  it("still sends when nothing moved", () => {
    const server = wire();
    const { container } = mount(controlPlane({}));
    openAndType(container, "STOP META");
    fireEvent.submit(container.querySelector("[data-stop-confirm]")!);

    expect(server.posts).toHaveLength(1);
    expect(server.posts[0]!.body).toMatchObject({
      action: "engage_kill_switch",
    });
    expect(container.querySelector("[data-stop-aborted]")).toBeNull();
  });

  it("clears a previous abort notice when the ceremony is opened again", () => {
    wire();
    const { container, rerender } = mount(controlPlane({}));
    openAndType(container, "STOP META");
    rerender(
      <MetaAutomationPage
        businessId="biz_1"
        initialPayload={controlPlane({ engaged: true })}
        providerAccountId="act_1"
        stopEngageRefusalReason={null}
        viewer={ADMIN}
      />,
    );
    fireEvent.submit(container.querySelector("[data-stop-confirm]")!);
    expect(container.querySelector("[data-stop-aborted]")).not.toBeNull();

    // The trigger now offers RELEASE, which an admin may take.
    fireEvent.click(container.querySelector("[data-stop-trigger]")!);

    expect(container.querySelector("[data-stop-aborted]")).toBeNull();
    expect(
      container
        .querySelector("[data-stop-confirm]")!
        .getAttribute("data-stop-confirm"),
    ).toBe("release");
  });
});
