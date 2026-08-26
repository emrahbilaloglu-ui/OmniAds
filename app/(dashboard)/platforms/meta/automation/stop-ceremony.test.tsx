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
function wire(input?: { post?: () => Response; after?: () => MetaAutomationControlPlane }) {
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
  it("states the reading's status, its instant, and the window that refuses it", () => {
    wire();
    const { container } = mount(controlPlane({}));

    const preflight = container.querySelector("[data-stop-preflight]")!;
    expect(preflight.getAttribute("data-stop-preflight")).toBe("complete");
    expect(preflight.getAttribute("data-stop-preflight-at")).toBe(
      new Date(NOW - 30_000).toISOString(),
    );
    expect(preflight.textContent).toContain(
      `older than ${Math.round(STOP_PREFLIGHT_MAX_AGE_MS / 60000)} minutes is refused`,
    );
  });

  it("refuses a reading older than the window, and names the instant", () => {
    wire();
    const stale = new Date(NOW - STOP_PREFLIGHT_MAX_AGE_MS - 1_000).toISOString();
    const { container } = mount(controlPlane({ observedAt: stale }));

    const blocked = container.querySelector("[data-stop-blocked]")!;
    expect(blocked.getAttribute("data-stop-blocked")).toBe("preflight_stale");
    expect(blocked.textContent).toContain(stale);
    // Present and refusing: the control never vanishes.
    expect(container.querySelector("[data-stop-trigger]")).not.toBeNull();
    expect(
      (container.querySelector("[data-stop-trigger]") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("refuses a reading that did not complete, and names the server's error code", () => {
    wire();
    const { container } = mount(
      controlPlane({ sectionStatus: "unavailable" }),
    );

    const blocked = container.querySelector("[data-stop-blocked]")!;
    expect(blocked.getAttribute("data-stop-blocked")).toBe("preflight_unavailable");
    expect(blocked.textContent).toContain("control_plane_read_failed");
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
    const trigger = container.querySelector("[data-stop-trigger]") as HTMLButtonElement;
    expect(trigger.getAttribute("data-ctl")).toBe("gated:AUTO-01A engage");
    expect(trigger.disabled).toBe(false);
  });

  it("refuses a collaborator the release, because releasing re-enables spend", () => {
    wire();
    const { container } = mount(controlPlane({ engaged: true }), COLLABORATOR);

    expect(
      container.querySelector("[data-stop-blocked]")?.getAttribute("data-stop-blocked"),
    ).toBe("insufficient_role");
    const trigger = container.querySelector("[data-stop-trigger]") as HTMLButtonElement;
    expect(trigger.getAttribute("data-ctl")).toBe("gated:AUTO-02 release");
    expect(trigger.disabled).toBe(true);
  });
});

describe("the gate holds engage and never holds release", () => {
  it("refuses engage with the server's own sentence", () => {
    wire();
    const reason = "The Meta Stop is not enabled on this workspace yet.";
    const { container } = mount(controlPlane({}), ADMIN, reason);

    const blocked = container.querySelector("[data-stop-blocked]")!;
    expect(blocked.getAttribute("data-stop-blocked")).toBe("gate_closed");
    expect(blocked.textContent).toContain(reason);
  });

  it("leaves release open at the same gate setting", () => {
    wire();
    const { container } = mount(
      controlPlane({ engaged: true }),
      ADMIN,
      "The Meta Stop is not enabled on this workspace yet.",
    );

    expect(container.querySelector("[data-stop-blocked]")).toBeNull();
    expect(
      (container.querySelector("[data-stop-trigger]") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("the typed confirmation is what sends the request", () => {
  it("opens without sending, refuses a wrong phrase, and sends on the right one", async () => {
    const server = wire();
    const { container } = mount(controlPlane({}));

    fireEvent.click(container.querySelector("[data-stop-trigger]")!);
    expect(container.querySelector("[data-stop-confirm]")?.getAttribute(
      "data-stop-confirm",
    )).toBe("engage");
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
      (container.querySelector("[data-stop-confirm-submit]") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(server.posts).toEqual([]);

    fireEvent.change(container.querySelector("[data-stop-confirm-input]")!, {
      target: { value: "stop meta" },
    });
    // Case-insensitive, because the phrase is a confirmation and not a password.
    expect(
      (container.querySelector("[data-stop-confirm-submit]") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.submit(container.querySelector("[data-stop-confirm]")!);
    await waitFor(() => expect(server.posts.length).toBe(1));
    expect(server.posts[0]!.body).toMatchObject({ action: "engage_kill_switch" });
  });

  it("cancels without sending", () => {
    const server = wire();
    const { container } = mount(controlPlane({}));

    fireEvent.click(container.querySelector("[data-stop-trigger]")!);
    fireEvent.click(container.querySelector("[data-stop-confirm-cancel]")!);
    expect(container.querySelector("[data-stop-confirm]")).toBeNull();
    expect(server.posts).toEqual([]);
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
    // The claim carries its own evidence.
    expect(container.querySelector("[data-stop-status]")!.textContent).toContain(
      "Confirmed by read-back at",
    );
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
    const message = container.querySelector("[data-stop-unconfirmed]")!.textContent!;
    expect(message).toContain("does not confirm");
    expect(message).not.toContain("Confirmed by read-back");
    expect(container.querySelector("[data-stop-status]")).toBeNull();
    expect(server.posts.length).toBe(1);
  });

  it("reports unknown when the confirming read itself fails", async () => {
    const server = wire({ post: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) });
    // The re-read throws: `readAutomation` is caught and yields null.
    vi.spyOn(globalThis, "fetch").mockImplementation((async (
      request: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(request);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.startsWith("/api/meta/automation?")) {
        server.posts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.startsWith("/api/meta/automation")) {
        throw new Error("the control plane could not be re-read");
      }
      return new Response(
        JSON.stringify({ ok: true, readCompleteness: {}, holds: {}, proposals: [] }),
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
    expect(container.querySelector("[data-stop-unconfirmed]")!.textContent).toContain(
      "could not be read back",
    );
    expect(container.querySelector("[data-stop-status]")).toBeNull();
  });
});

describe("nothing here reaches a provider", () => {
  it("posts only to the automation control plane, and states dry-run only", async () => {
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
    expect(container.textContent).toContain("dry run only");
  });
});
