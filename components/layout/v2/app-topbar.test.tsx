// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceContextProvider } from "@/components/workspace/workspace-context-provider";
import type { WorkspaceContextEnvelope } from "@/lib/workspace/workspace-context";

const state = vi.hoisted(() => ({
  pathname: "/c/business_A/meta/decisions",
  replace: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  selectBusiness: vi.fn(),
  fetch: vi.fn(),
  pickerProps: [] as Array<Record<string, unknown>>,
  businesses: [
    {
      id: "business_A",
      name: "Business A",
      timezone: "Europe/Istanbul",
      currency: "TRY",
    },
    {
      id: "business_B",
      name: "Business B",
      timezone: "America/New_York",
      currency: "USD",
    },
  ],
  selectedBusinessId: "business_B" as string | null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({
    replace: state.replace,
    refresh: state.refresh,
    push: state.push,
  }),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (value: {
      businesses: typeof state.businesses;
      selectedBusinessId: string | null;
      selectBusiness: typeof state.selectBusiness;
      hasHydrated: boolean;
      authBootstrapStatus: "ready";
    }) => unknown,
  ) =>
    selector({
      businesses: state.businesses,
      selectedBusinessId: state.selectedBusinessId,
      selectBusiness: state.selectBusiness,
      hasHydrated: true,
      authBootstrapStatus: "ready",
    }),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (value: { language: "en" }) => unknown) =>
    selector({ language: "en" }),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "28d",
      customStart: "",
      customEnd: "",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/components/date-range/DateRangePicker", () => ({
  DateRangePicker: (props: Record<string, unknown>) => {
    state.pickerProps.push(props);
    return <div data-testid="date-range-picker" />;
  },
  getTodayIsoForTimeZone: (timeZone: string) => `today@${timeZone}`,
}));

vi.mock("@/components/layout/v2/use-shell-signals", () => ({
  useWorkspaceSyncState: () => ({
    tone: "fresh",
    label: "Synced 12m ago",
    freshnessState: "ready",
  }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("@/lib/auth-diagnostics", () => ({ logClientAuthEvent: vi.fn() }));

import {
  AppTopbar,
  scopedBusinessSwitchDestination,
} from "@/components/layout/v2/app-topbar";

const envelopeA: WorkspaceContextEnvelope = {
  actor: {
    userId: "user_1",
    name: "Operator",
    language: "en",
    membershipRole: "admin",
    reviewerReadOnly: false,
    demo: false,
  },
  mode: "client",
  business: {
    id: "business_A",
    name: "Business A",
    configuredCurrency: "TRY",
    businessTimezone: "Europe/Istanbul",
  },
  provider: null,
  evidence: {
    windowLabel: null,
    snapshotAt: null,
    sourceUpdatedAt: null,
    freshness: "unknown",
  },
  proof: { currency: "configured-only", timezone: "unknown" },
  rollout: { zeroBaseEnabled: true, mutationUiEnabled: false },
};

function renderTopbar() {
  return render(
    <WorkspaceContextProvider value={envelopeA}>
      <AppTopbar userName="Operator" onOpenNav={vi.fn()} />
    </WorkspaceContextProvider>,
  );
}

describe("business-scoped Dashboard v2 topbar", () => {
  beforeEach(() => {
    state.pathname = "/c/business_A/meta/decisions";
    state.selectedBusinessId = "business_B";
    state.replace.mockReset();
    state.refresh.mockReset();
    state.push.mockReset();
    state.selectBusiness.mockReset();
    state.fetch.mockReset();
    state.fetch.mockResolvedValue({ ok: true });
    state.pickerProps.length = 0;
    vi.stubGlobal("fetch", state.fetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("paints route A and resolves its date clock even when the session store says B", () => {
    const { container } = renderTopbar();
    const trigger = container.querySelector(".adv-topbar > .adv-btn");

    expect(trigger).toHaveTextContent("Business A");
    expect(trigger).not.toHaveTextContent("Business B");
    expect(state.pickerProps[0]).toMatchObject({
      referenceDate: "today@Europe/Istanbul",
      timeZoneLabel: "Europe/Istanbul",
    });
  });

  it("posts first and then navigates A to the equivalent B route without optimistic store drift", async () => {
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Business B/ }));

    await waitFor(() => {
      expect(state.replace).toHaveBeenCalledWith(
        "/c/business_B/meta/decisions",
      );
    });
    expect(state.fetch).toHaveBeenCalledWith("/api/auth/switch-business", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessId: "business_B" }),
    });
    expect(state.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      state.replace.mock.invocationCallOrder[0]!,
    );
    expect(state.selectBusiness).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("keeps route A and the store unchanged when the scoped switch is rejected", async () => {
    state.fetch.mockResolvedValue({ ok: false });
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Business B/ }));

    await waitFor(() => expect(state.fetch).toHaveBeenCalledOnce());
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
    expect(state.selectBusiness).not.toHaveBeenCalled();
    expect(state.selectedBusinessId).toBe("business_B");
  });

  it("keeps readable /app switching on the existing session-refresh path", async () => {
    state.pathname = "/app/meta/decisions";
    state.selectedBusinessId = "business_A";
    renderTopbar();

    fireEvent.click(screen.getByRole("button", { name: /Business B/ }));

    await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
    expect(state.selectBusiness).toHaveBeenCalledWith("business_B");
    expect(state.replace).not.toHaveBeenCalled();
  });

  it("builds scoped destinations without carrying A's provider query state", () => {
    expect(
      scopedBusinessSwitchDestination(
        "/c/business_A/google/advisor",
        "business B",
      ),
    ).toBe("/c/business%20B/google/advisor");
    expect(scopedBusinessSwitchDestination("/c/business_A", "business_B")).toBe(
      "/c/business_B/home",
    );
    expect(scopedBusinessSwitchDestination("/app/home", "business_B")).toBeNull();
  });
});
