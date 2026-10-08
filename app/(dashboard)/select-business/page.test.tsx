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
    await mount();
    await confirmDelete();
    expect(screen.getByText("Business deleted.")).toBeTruthy();
    expect(useAppStore.getState().businesses.map((row) => row.id)).toEqual(["biz_2"]);
    expect(useAppStore.getState().selectedBusinessId).toBe("biz_2");
    expect(calls.filter((call) => call.url === "/api/businesses" && call.method === "GET")).toHaveLength(2);
  });

  it("keeps the workspace when the list still contains it despite HTTP success", async () => {
    const rows = [workspaceRow()];
    installFetch(rows);
    seedStore(rows);
    await mount();
    await confirmDelete();
    expect(screen.queryByText("Business deleted.")).toBeNull();
    expect(screen.getByText(/business list did not confirm removal/)).toBeTruthy();
    expect(useAppStore.getState().businesses).toHaveLength(1);
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
