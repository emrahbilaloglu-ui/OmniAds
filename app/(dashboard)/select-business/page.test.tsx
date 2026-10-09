// @vitest-environment jsdom

/**
 * Where a workspace is renamed, and who may do it.
 *
 * Dashboard v2 draws no workspace name or currency field on any screen — its
 * Settings screen is Full name, Email, Interface language and Workspace
 * timezone — so the port left `PATCH /api/businesses/{id}` reachable by no
 * rendered surface at all. It lives here now, beside the delete ceremony, which
 * is the other workspace-level operation this page already owns.
 *
 * These assert the control exists for the role the route requires, is absent
 * for one it does not, calls that same route, and refuses a currency the
 * product does not offer before spending a request on it.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/select-business",
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * Stubbed because it cannot be rendered at all with a business selected:
 * `components/auth/onboarding-arc.tsx:92` calls `getProviderViewState` inside a
 * zustand selector, which builds a fresh object on every read, so zustand 5's
 * `useSyncExternalStore` re-renders without end ("Maximum update depth
 * exceeded"). That is a defect in the arc, not in this page, and it is not what
 * these tests are about.
 */
vi.mock("@/components/auth/onboarding-arc", () => ({
  AuthOnboardingArc: () => null,
}));

const { useAppStore } = await import("@/store/app-store");
const { useIntegrationsStore } = await import("@/store/integrations-store");
const SelectBusinessPage = (await import("@/app/(dashboard)/select-business/page")).default;

const originalFetch = globalThis.fetch;

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

let calls: Recorded[] = [];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
}

function workspaceRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "biz_1",
    name: "Workspace One",
    timezone: "UTC",
    timezoneSource: null,
    currency: "USD",
    isDemoBusiness: false,
    role: "admin",
    membershipStatus: "active",
    ...overrides,
  };
}

/** Installs a fetch that serves `/api/businesses` and records every call. */
function installFetch(rows: Array<Record<string, unknown>>, patch?: { ok: boolean; body: unknown }) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (method === "PATCH") {
      return jsonResponse(patch?.body ?? { business: rows[0] }, patch?.ok ?? true, patch?.ok === false ? 400 : 200);
    }
    if (method === "DELETE") return jsonResponse({status:"ok"});
    return jsonResponse({ businesses: rows, activeBusinessId: rows[0]?.id ?? null });
  }) as unknown as typeof fetch;
}

function seedStore(rows: Array<Record<string, unknown>>) {
  useAppStore.setState({
    businesses: rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      timezone: (row.timezone as string | null) ?? null,
      currency: String(row.currency),
      isDemoBusiness: Boolean(row.isDemoBusiness),
    })),
    selectedBusinessId: String(rows[0]?.id ?? ""),
    workspaceOwnerId: "user_1",
    workspaceResolved: true,
    hasHydrated: true,
  });
}

async function mount() {
  await act(async () => {
    render(React.createElement(SelectBusinessPage));
  });
}

beforeEach(() => {
  calls = [];
  useIntegrationsStore.getState().clearAllState();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  globalThis.fetch = originalFetch;
  useAppStore.getState().clearWorkspaceState();
});

describe("/select-business workspace edit", () => {
  it("offers the rename control to an admin of a real workspace", async () => {
    const rows = [workspaceRow()];
    installFetch(rows);
    seedStore(rows);
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect((screen.getByLabelText("Workspace name") as HTMLInputElement).value).toBe(
      "Workspace One",
    );
    expect((screen.getByLabelText("Currency") as HTMLSelectElement).value).toBe("USD");
  });

  it("shows no rename control to a collaborator, who the route would refuse", async () => {
    const rows = [workspaceRow({ role: "collaborator" })];
    installFetch(rows);
    seedStore(rows);
    await mount();

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    // Deleting has the same admin requirement as renaming. Offering a control
    // that always receives 403 made non-admin workspaces look broken.
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("shows no rename control on the demo workspace, exactly as delete does not", async () => {
    const rows = [workspaceRow({ isDemoBusiness: true })];
    installFetch(rows);
    seedStore(rows);
    await mount();

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("saves the new name and currency through the existing PATCH route", async () => {
    const rows = [workspaceRow()];
    installFetch(rows);
    seedStore(rows);
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "  Grandmix  " },
    });
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "EUR" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    });

    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(patch!.url).toBe("/api/businesses/biz_1");
    expect(patch!.body).toEqual({ name: "Grandmix", currency: "EUR" });
    // The list is re-read after the write; the page never claims a save on the
    // strength of the response alone.
    expect(calls.filter((call) => call.method === "GET" && call.url === "/api/businesses")).toHaveLength(
      2,
    );
  });

  it("refuses a currency the product does not offer without calling the route", async () => {
    // A workspace stored with something that is not an ISO 4217 code: the form
    // will not carry it forward, and will not save until a real one is chosen.
    const rows = [workspaceRow({ currency: "US" })];
    installFetch(rows);
    seedStore(rows);
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Currency") as HTMLSelectElement).value).toBe("");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    });

    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    expect(screen.getByText("Choose a supported currency.")).toBeTruthy();
  });

  it("surfaces the route's own refusal rather than claiming a save", async () => {
    const rows = [workspaceRow()];
    installFetch(rows, {
      ok: false,
      body: { error: "invalid_currency", message: "Currency must be a three-letter ISO 4217 code." },
    });
    seedStore(rows);
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    });

    expect(screen.getByText("Currency must be a three-letter ISO 4217 code.")).toBeTruthy();
  });
});

describe("/select-business workspace deletion", () => {
  async function confirmDelete() {
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    fireEvent.change(screen.getByLabelText("Type business name"), { target: { value: "Workspace One" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete business" })); });
  }

  it("keeps the workspace and browser data while a 202 is pending, then confirms the completed job and fresh list",async()=>{
    vi.useFakeTimers();
    const rows=[workspaceRow(),workspaceRow({id:"biz_2",name:"Workspace Two"})];
    let reads=0,completed=false;
    globalThis.fetch=((input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input),method=init?.method??"GET";
      calls.push({url,method,body:null});
      if(method==="DELETE") return jsonResponse({status:"queued",monitorTicket:"fixture-ticket"},true,202);
      if(url.endsWith("/deletion-status")) {reads++;completed=reads===2;return jsonResponse({status:completed?"ok":"running"});}
      if(method==="POST") return jsonResponse({status:"ok"});
      return jsonResponse({businesses:completed?[rows[1]]:rows});
    }) as typeof fetch;
    seedStore(rows);window.localStorage.setItem("creatives-briefing-selected:biz_1","keep-until-commit");
    await mount();await confirmDelete();
    expect(screen.getByRole("status").textContent).toContain("Deletion queued");
    expect(screen.queryByText("Business deleted.")).toBeNull();expect(useAppStore.getState().businesses).toHaveLength(2);
    expect(window.localStorage.getItem("creatives-briefing-selected:biz_1")).toBe("keep-until-commit");
    await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
    expect(screen.getByRole("status").textContent).toContain("Deleting all business records");
    expect(useAppStore.getState().businesses).toHaveLength(2);
    await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
    expect(screen.getByText("Business deleted.")).toBeTruthy();
    expect(useAppStore.getState().businesses.map(b=>b.id)).toEqual(["biz_2"]);
    expect(window.localStorage.getItem("creatives-briefing-selected:biz_1")).toBeNull();
    expect(calls.filter(c=>c.method==="DELETE")).toHaveLength(1);
  });

  it("confirms absence from a fresh list before clearing the current business", async () => {
    const rows = [workspaceRow(), workspaceRow({ id: "biz_2", name: "Workspace Two" })];
    let removed = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method, body: null });
      if (method === "DELETE") { removed = true; return jsonResponse({ status: "ok" }); }
      if (method === "POST") return jsonResponse({ status: "ok" });
      return jsonResponse({ businesses: removed ? [rows[1]] : rows });
    }) as typeof fetch;
    seedStore(rows);
    const prefixes = ["adsecute_active_platform_", "creatives-briefing-selected:", "adsecute:overview-layout:v1:", "creative-studio:assets:v1:"];
    for (const prefix of prefixes) {
      const suffix = prefix === "creative-studio:assets:v1:" ? ":account-one" : "";
      window.localStorage.setItem(prefix+"biz_1"+suffix,"owned-fixture");
      window.localStorage.setItem(prefix+"biz_2"+suffix,"foreign-fixture");
    }
    window.localStorage.setItem("creativesTableLayout","global-fixture");
    await mount();
    await confirmDelete();
    expect(screen.getByText("Business deleted.")).toBeTruthy();
    expect(useAppStore.getState().businesses.map((row) => row.id)).toEqual(["biz_2"]);
    expect(useAppStore.getState().selectedBusinessId).toBe("biz_2");
    expect(calls.filter((call) => call.url === "/api/businesses" && call.method === "GET")).toHaveLength(2);
    for (const prefix of prefixes) {
      const suffix = prefix === "creative-studio:assets:v1:" ? ":account-one" : "";
      expect(window.localStorage.getItem(prefix+"biz_1"+suffix)).toBeNull();
      expect(window.localStorage.getItem(prefix+"biz_2"+suffix)).toBe("foreign-fixture");
      window.localStorage.removeItem(prefix+"biz_2"+suffix);
    }
    expect(window.localStorage.getItem("creativesTableLayout")).toBe("global-fixture");
    window.localStorage.removeItem("creativesTableLayout");
  });

  it("keeps the workspace when the list still contains it despite HTTP success", async () => {
    const rows = [workspaceRow()];
    installFetch(rows);
    seedStore(rows);
    window.localStorage.setItem("creatives-briefing-selected:biz_1","keep-on-unconfirmed");
    await mount();
    await confirmDelete();
    expect(screen.queryByText("Business deleted.")).toBeNull();
    expect(screen.getByText(/business list did not confirm removal/)).toBeTruthy();
    expect(useAppStore.getState().businesses).toHaveLength(1);
    expect(window.localStorage.getItem("creatives-briefing-selected:biz_1")).toBe("keep-on-unconfirmed");
    window.localStorage.removeItem("creatives-briefing-selected:biz_1");
  });

  it("selects the next workspace from the fresh list when the cached next membership disappeared", async () => {
    const rows = [workspaceRow(), workspaceRow({ id: "biz_stale", name: "Old workspace" }), workspaceRow({ id: "biz_3", name: "Current workspace" })];
    let removed = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url: String(input), method, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      if (method === "DELETE") { removed = true; return jsonResponse({ status: "ok" }); }
      if (method === "POST") return jsonResponse({ status: "ok" });
      return jsonResponse({ businesses: removed ? [rows[2]] : rows });
    }) as typeof fetch;
    seedStore(rows);
    await mount();
    await confirmDelete();
    expect(useAppStore.getState().businesses.map((row) => row.id)).toEqual(["biz_3"]);
    expect(useAppStore.getState().selectedBusinessId).toBe("biz_3");
    expect(calls.find((call) => call.url === "/api/auth/switch-business")?.body).toEqual({ businessId: "biz_3" });
  });

  it("distinguishes a completed deletion from a failed switch to the next workspace", async () => {
    const rows = [workspaceRow(), workspaceRow({ id: "biz_2", name: "Workspace Two" })];
    let removed = false;
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") { removed = true; return jsonResponse({ status: "ok" }); }
      if (init?.method === "POST") return jsonResponse({}, false, 503);
      return jsonResponse({ businesses: removed ? [rows[1]] : rows });
    }) as typeof fetch;
    seedStore(rows);
    await mount();
    await confirmDelete();
    expect(screen.queryByText("Business deleted.")).toBeNull();
    expect(screen.getByText(/Business deleted, but switching/)).toBeTruthy();
    expect(useAppStore.getState().businesses.map((row) => row.id)).toEqual(["biz_2"]);
    expect(screen.queryByLabelText("Type business name")).toBeNull();
  });

  it("shows the server's specific protected-history refusal and keeps access", async () => {
    const rows = [workspaceRow()];
    const message = "This business has protected decision history. No data was deleted.";
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => init?.method === "DELETE"
      ? jsonResponse({ error: "protected_history", message }, false, 409)
      : jsonResponse({ businesses: rows })) as typeof fetch;
    seedStore(rows);
    await mount();
    await confirmDelete();
    expect(screen.getByText(message)).toBeTruthy();
    expect(useAppStore.getState().businesses).toHaveLength(1);
  });

  it("does not claim deletion when its confirming list cannot be read", async () => {
    const rows = [workspaceRow()];
    let removed = false;
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") { removed = true; return jsonResponse({ status: "ok" }); }
      return removed ? jsonResponse({}, false, 503) : jsonResponse({ businesses: rows });
    }) as typeof fetch;
    seedStore(rows);
    await mount();
    await confirmDelete();
    expect(screen.queryByText("Business deleted.")).toBeNull();
    expect(useAppStore.getState().businesses).toHaveLength(1);
  });
});
