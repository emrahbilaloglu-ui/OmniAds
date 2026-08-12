// @vitest-environment jsdom

/**
 * Flow I rendering rules — Intelligence, History, Automation and the Meta stop.
 *
 * The assertions here are almost all about what must NOT be on screen: no edit
 * control on a guardrail the engine enforces, no success banner before a
 * read-back, no invented actor, no wording that implies the Meta stop reaches
 * Google. Each absence is a specific way an operator would be misled.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AutomationView } from "@/components/zero-base/meta/automation/automation-view";
import { HistoryView } from "@/components/zero-base/meta/history/history-view";
import { IntelligenceView } from "@/components/zero-base/meta/intelligence/intelligence-view";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import {
  FORBIDDEN_STOP_PHRASES,
  READ_ONLY_GUARDRAIL_IDS,
  buildProviderPostures,
  googlePosture,
  resolveStopCeremony,
  type GoogleConnectionRead,
  type StopCeremonyInput,
} from "@/lib/zero-base/meta/automation-posture";
import { AutomationClient } from "@/components/zero-base/meta/automation/automation-client";

afterEach(cleanup);

const GUARDRAILS = {
  dailyAutoActionCap: 3,
  perActionSpendCeilingMinor: 5000,
  minimumConfidence: "high",
  cooldownMinutes: 60,
  maxEvidenceAgeHours: 24,
};

function ceremony(overrides: Partial<StopCeremonyInput> = {}): StopCeremonyInput {
  return {
    intent: "engage",
    viewer: { role: "admin", isReviewer: false, demo: false },
    currentlyEngaged: false,
    readBack: null,
    ...overrides,
  };
}

function renderAutomation(overrides: Partial<StopCeremonyInput> = {}, onEngage?: () => void) {
  return render(
    <ZeroBasePortalHost>
      <AutomationView
        postures={buildProviderPostures({ google: { read: true, connected: true }, meta: { state: "degraded", reason: "Token refresh failing." } })}
        guardrails={GUARDRAILS}
        ceremony={ceremony(overrides)}
        onEngage={onEngage}
      />
    </ZeroBasePortalHost>,
  );
}

/* ------------------------------------------------------------- intelligence */

describe("intelligence names each source state separately", () => {
  const sources = [
    { key: "insights", label: "Ad insights", state: "serving" as const, reason: null, observedAt: "09:12" },
    {
      key: "attribution",
      label: "Attribution",
      state: "partial" as const,
      reason: "Two of five ad sets missing a conversion window.",
      observedAt: "09:12",
    },
    {
      key: "creative",
      label: "Creative metadata",
      state: "degraded" as const,
      reason: "Token needs reconnecting.",
      observedAt: null,
    },
  ];

  it("prints the state as a word, not only as a colour", () => {
    render(<IntelligenceView sources={sources} />);
    expect(screen.getByText("Partial")).toBeTruthy();
    expect(screen.getByText("Degraded")).toBeTruthy();
  });

  it("gives each impaired source its own reason", () => {
    render(<IntelligenceView sources={sources} />);
    // Folding these into one "some data missing" line would hide that the
    // remedies differ — one is a wait, the other is a reconnect.
    expect(screen.getByText(/missing a conversion window/)).toBeTruthy();
    expect(screen.getByText(/Token needs reconnecting/)).toBeTruthy();
  });

  it("says an observation time was not recorded rather than leaving a blank", () => {
    render(<IntelligenceView sources={sources} />);
    expect(screen.getByText("Not recorded")).toBeTruthy();
  });

  it("shows an unavailable surface with its reason instead of an empty table", () => {
    render(<IntelligenceView sources={[]} unavailableReason="Meta account not connected." />);
    expect(screen.getByText(/Meta account not connected/)).toBeTruthy();
    expect(document.querySelectorAll("[data-source-state]").length).toBe(0);
  });
});

/* ------------------------------------------------------------------ history */

describe("history keeps replay and actor gaps visible", () => {
  const rows = [
    { id: "h1", occurredAt: "08:00", action: "Pause ad", outcome: "Verified", actor: "ada@example.com", replayed: false },
    { id: "h2", occurredAt: "09:00", action: "Resume ad", outcome: "Verified", actor: null, replayed: true },
  ];

  it("marks the window as replayed and offers no way to dismiss it", () => {
    render(<HistoryView rows={rows} />);
    const banner = document.querySelector("[data-replay-banner]");
    expect(banner).not.toBeNull();
    // A dismissible caveat is one a later reader will never see.
    expect(banner!.querySelectorAll("button").length).toBe(0);
  });

  it("does not mark a window that was recorded at the time", () => {
    render(<HistoryView rows={[rows[0]]} />);
    expect(document.querySelector("[data-replay-banner]")).toBeNull();
  });

  it("names an unrecorded actor rather than attributing it to the system", () => {
    render(<HistoryView rows={rows} />);
    const unknown = document.querySelector('[data-actor="h2"]')!;
    expect(unknown.getAttribute("data-actor-known")).toBe("no");
    expect(unknown.textContent).toMatch(/Actor not recorded/);
    expect(unknown.textContent).not.toMatch(/system/i);
  });

  it("passes a recorded actor through unchanged", () => {
    render(<HistoryView rows={rows} />);
    expect(document.querySelector('[data-actor="h1"]')!.textContent).toBe("ada@example.com");
  });
});

/* ------------------------------------------------- provider posture and stop */

describe("Google is always drawn and never stoppable", () => {
  it("keeps the Google row present when Meta is the degraded provider", () => {
    renderAutomation();
    expect(document.querySelector('[data-provider-state="google"]')).not.toBeNull();
    expect(document.querySelector("[data-google-unaffected]")!.textContent).toMatch(/unaffected/);
  });

  it("offers exactly one stoppable provider, and it is Meta", () => {
    renderAutomation();
    expect(document.querySelectorAll("[data-stoppable]").length).toBe(1);
    expect(document.querySelector('[data-stoppable="meta"]')).not.toBeNull();
    expect(document.querySelector('[data-not-stoppable="google"]')).not.toBeNull();
  });

  it("uses no wording that would imply the stop reaches further than Meta", () => {
    renderAutomation();
    const text = document.body.textContent!.toLowerCase();
    for (const phrase of FORBIDDEN_STOP_PHRASES) {
      expect(text, phrase).not.toContain(phrase);
    }
  });

  it("states the stop's scope next to the control", () => {
    renderAutomation();
    expect(document.querySelector("[data-stop-scope]")!.textContent).toMatch(/this business only/);
  });
});

describe("the stop refuses before it acts", () => {
  it("blocks a reviewer and renders no trigger at all", () => {
    renderAutomation({ viewer: { role: "admin", isReviewer: true, demo: false } });
    expect(document.querySelector('[data-stop-blocked="reviewer"]')).not.toBeNull();
    expect(document.querySelector("[data-stop-trigger]")).toBeNull();
  });

  it("blocks the demo business", () => {
    renderAutomation({ viewer: { role: "admin", isReviewer: false, demo: true } });
    expect(document.querySelector('[data-stop-blocked="demo"]')).not.toBeNull();
    expect(document.querySelector("[data-stop-trigger]")).toBeNull();
  });

  it("blocks a non-admin", () => {
    renderAutomation({ viewer: { role: "collaborator", isReviewer: false, demo: false } });
    expect(document.querySelector('[data-stop-blocked="insufficient_role"]')).not.toBeNull();
  });

  it("refuses when the current state could not be read", () => {
    renderAutomation({ currentlyEngaged: null });
    expect(document.querySelector('[data-stop-blocked="state_unavailable"]')).not.toBeNull();
  });
});

describe("no status banner before the read-back", () => {
  it("shows none while the ceremony is still at confirm", () => {
    renderAutomation();
    expect(document.querySelector("[data-stop-status]")).toBeNull();
    expect(document.querySelector("[data-stop-unconfirmed]")).toBeNull();
  });

  it("still shows none right after the operator confirms", async () => {
    const onEngage = vi.fn();
    renderAutomation({}, onEngage);
    const user = userEvent.setup();

    await user.click(document.querySelector("[data-stop-trigger]") as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "STOP META");
    await user.click(within(dialog).getByRole("button", { name: "Stop Meta automation" }));

    expect(onEngage).toHaveBeenCalledTimes(1);
    // The request was submitted; nobody has observed the resulting state yet,
    // and "stopped" here would tell an operator spend had halted.
    expect(document.querySelector("[data-stop-status]")).toBeNull();
  });

  it("reports success only once a read-back agreed", () => {
    renderAutomation({ readBack: { engaged: true, readAt: "2026-08-11T12:00:00Z" } });
    const banner = document.querySelector("[data-stop-status]");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toMatch(/Confirmed by read-back/);
  });

  it("says the outcome is unknown when the read-back disagrees", () => {
    renderAutomation({ readBack: { engaged: false, readAt: "2026-08-11T12:00:00Z" } });
    expect(document.querySelector("[data-stop-status]")).toBeNull();
    expect(document.querySelector("[data-stop-unconfirmed]")!.textContent).toMatch(/unknown/);
  });
});

describe("guardrails render with zero edit affordances", () => {
  it("draws AUTO-05 through AUTO-10", () => {
    renderAutomation();
    const ids = [...document.querySelectorAll("[data-guardrail-value]")].map((node) =>
      node.getAttribute("data-guardrail-value"),
    );
    expect(ids).toEqual([...READ_ONLY_GUARDRAIL_IDS]);
  });

  it("offers no control that would imply a buyer can change a server-enforced cap", () => {
    renderAutomation();
    const section = screen.getByRole("region", { name: "Guardrails" });
    expect(section.querySelectorAll("input, select, textarea, button").length).toBe(0);
    expect(section.querySelectorAll("[contenteditable]").length).toBe(0);
  });

  it("says not configured rather than printing a plausible default", () => {
    render(
      <ZeroBasePortalHost>
        <AutomationView
          postures={buildProviderPostures({ google: { read: true, connected: true }, meta: { state: "serving", reason: null } })}
          guardrails={{}}
          ceremony={ceremony()}
        />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector('[data-guardrail-value="AUTO-07"]')!.textContent).toBe(
      "Not configured",
    );
  });
});


/* ------------------------------------------- Google posture is read, not assumed */

describe("Google posture comes from an actual read", () => {
  it("reports a connected provider as serving", () => {
    expect(googlePosture({ read: true, connected: true }).state).toBe("serving");
  });

  it("reports a disconnected provider as unavailable, not healthy", () => {
    const posture = googlePosture({ read: true, connected: false });
    expect(posture.state).toBe("unavailable");
    expect(posture.reason).toMatch(/not connected/);
  });

  it("reports an unreadable provider as unknown, never as serving", () => {
    // A hard-coded "Serving" here is a health claim about a provider nobody
    // queried — the exact fabrication the separate-systems rule forbids.
    const posture = googlePosture({ read: false, reason: "integration status is unavailable" });
    expect(posture.state).toBe("unknown");
    expect(posture.state).not.toBe("serving");
    expect(posture.reason).toMatch(/integration status is unavailable/);
  });

  it("says Google is unaffected in every one of those cases", () => {
    const reads: GoogleConnectionRead[] = [
      { read: true, connected: true },
      { read: true, connected: false },
      { read: false, reason: "down" },
    ];
    for (const read of reads) {
      expect(googlePosture(read).reason).toMatch(/unaffected/);
    }
  });

  it("marks Google's row as a connection claim, never a control-plane one", () => {
    const rows = buildProviderPostures({
      meta: { state: "serving", reason: null },
      google: { read: true, connected: true },
    });
    expect(rows.find((row) => row.provider === "google")?.basis).toBe("connection_only");
    expect(rows.find((row) => row.provider === "meta")?.basis).toBe("automation_control_plane");
  });

  it("keeps the row present and unstoppable when Meta is healthy and Google is unavailable", () => {
    const rows = buildProviderPostures({
      meta: { state: "serving", reason: null },
      google: { read: true, connected: false },
    });
    const google = rows.find((row) => row.provider === "google")!;
    expect(google.state).toBe("unavailable");
    expect(google.stoppable).toBe(false);
  });
});

describe("the view prints Unknown rather than a health word", () => {
  it("renders the unknown state for an unreadable Google", () => {
    render(
      <ZeroBasePortalHost>
        <AutomationView
          postures={buildProviderPostures({
            meta: { state: "serving", reason: null },
            google: { read: false, reason: "integration status is unavailable" },
          })}
          guardrails={GUARDRAILS}
          ceremony={ceremony()}
        />
      </ZeroBasePortalHost>,
    );
    const google = document.querySelector('[data-provider-state="google"]')!;
    expect(google.textContent).toMatch(/Unknown/);
    expect(google.textContent).not.toMatch(/Serving/);
  });
});

/* ------------------------------------------- an unreadable read-back is unknown */

describe("read-back that could not be performed", () => {
  it("claims neither outcome", () => {
    const state = resolveStopCeremony(
      ceremony({ readBack: { engaged: null, readAt: "t", error: "HTTP 503" } }),
    );
    expect(state.showStatusBanner).toBe(false);
    expect(state.statusMessage).toMatch(/could not be read back/);
    expect(state.statusMessage).toMatch(/HTTP 503/);
    expect(state.statusMessage).toMatch(/unknown/);
  });
});

/* ------------------------------------------------- engage and release for real */

describe("the stop actually calls the authority and reads it back", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function client(intent: "engage" | "release" = "engage") {
    render(
      <ZeroBasePortalHost>
        <AutomationClient
          businessId="biz-1"
          providerAccountId="act_1"
          postures={buildProviderPostures({
            meta: { state: "serving", reason: null },
            google: { read: true, connected: true },
          })}
          guardrails={GUARDRAILS}
          ceremony={ceremony({ intent, currentlyEngaged: intent === "release" })}
        />
      </ZeroBasePortalHost>,
    );
  }

  async function confirm(user: ReturnType<typeof userEvent.setup>, phrase: string, label: string) {
    await user.click(document.querySelector("[data-stop-trigger]") as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), phrase);
    await user.click(within(dialog).getByRole("button", { name: label }));
  }

  it("posts the engage action, then reads the state back in a SEPARATE request", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return {
        ok: true,
        status: 200,
        json: async () => ({ automation: { businessControl: { killSwitchEngaged: true } } }),
      } as Response;
    }) as typeof fetch;

    client();
    await confirm(userEvent.setup(), "STOP META", "Stop Meta automation");

    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/api/meta/automation");
    // The POST returns a control plane of its own; using it to confirm itself
    // is not an observation of state.
    expect(calls[1].method).toBe("GET");
    await waitFor(() =>
      expect(document.querySelector("[data-stop-status]")!.textContent).toMatch(
        /Confirmed by read-back/,
      ),
    );
  });

  it("sends the release action when the stop is already engaged", async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") bodies.push(String(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ automation: { businessControl: { killSwitchEngaged: false } } }),
      } as Response;
    }) as typeof fetch;

    client("release");
    await confirm(userEvent.setup(), "RESUME META", "Resume");

    await waitFor(() => expect(bodies.length).toBe(1));
    expect(bodies[0]).toContain("release_kill_switch");
    await waitFor(() =>
      expect(document.querySelector("[data-stop-status]")!.textContent).toMatch(/running again/),
    );
  });

  it("claims nothing when the read-back disagrees with the intent", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      // The write was accepted, but the state did not move.
      json: async () => ({ automation: { businessControl: { killSwitchEngaged: false } } }),
    })) as unknown as typeof fetch;

    client();
    await confirm(userEvent.setup(), "STOP META", "Stop Meta automation");

    await waitFor(() =>
      expect(document.querySelector("[data-stop-unconfirmed]")!.textContent).toMatch(/unknown/),
    );
    expect(document.querySelector("[data-stop-status]")).toBeNull();
  });

  it("says unknown when the confirming read itself fails", async () => {
    let first = true;
    globalThis.fetch = vi.fn(async () => {
      if (first) {
        first = false;
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    client();
    await confirm(userEvent.setup(), "STOP META", "Stop Meta automation");

    await waitFor(() =>
      expect(document.querySelector("[data-stop-unconfirmed]")!.textContent).toMatch(
        /could not be read back/,
      ),
    );
    expect(document.querySelector("[data-stop-status]")).toBeNull();
  });

  it("reports a refused write as a failure that changed nothing", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: "Business STOP release was withheld." } }),
    })) as unknown as typeof fetch;

    client();
    await confirm(userEvent.setup(), "STOP META", "Stop Meta automation");

    await waitFor(() =>
      expect(document.querySelector("[data-stop-failed]")!.textContent).toMatch(
        /withheld[\s\S]*Nothing was changed/,
      ),
    );
    expect(document.querySelector("[data-stop-status]")).toBeNull();
  });

  it("makes no request at all until the typed confirmation is complete", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    client();
    const user = userEvent.setup();
    await user.click(document.querySelector("[data-stop-trigger]") as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Stop Meta automation" }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
