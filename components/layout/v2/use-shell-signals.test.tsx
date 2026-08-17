// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceSyncState } from "./use-shell-signals";

const state = vi.hoisted(() => ({
  app: {
    selectedBusinessId: "biz_1" as string | null,
    hasHydrated: true,
    authBootstrapStatus: "ready",
  },
  active: null as {
    surface: "reports";
    state: "loading" | "refreshing" | "ready" | "partial" | "error";
    asOf: string | null;
    businessId: string | null;
    retryKey: string | null;
  } | null,
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (value: typeof state.app) => unknown) =>
    selector(state.app),
}));

vi.mock("@/store/tier-zero-freshness-store", () => ({
  useTierZeroFreshnessStore: (
    selector: (value: { active: typeof state.active }) => unknown,
  ) => selector({ active: state.active }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    getQueryCache: () => ({ subscribe: () => () => {}, findAll: () => [] }),
  }),
  useQuery: () => ({
    data: {
      state: "ready",
      latestSync: { finishedAt: "2026-08-17T08:00:00.000Z" },
    },
  }),
}));

describe("workspace sync topbar state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T08:12:00.000Z"));
    state.active = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the active business surface as the static topbar freshness source", () => {
    state.active = {
      surface: "reports",
      state: "ready",
      asOf: "2026-08-17T08:00:00.000Z",
      businessId: "biz_1",
      retryKey: null,
    };

    const { result } = renderHook(() => useWorkspaceSyncState());

    expect(result.current).toEqual({
      tone: "fresh",
      label: "Synced 12m ago",
      freshnessState: "ready",
    });
    expect("onRefresh" in result.current).toBe(false);
  });

  it.each([
    ["loading", "syncing", "Syncing now"],
    ["refreshing", "syncing", "Syncing now"],
    ["partial", "attention", "Sync needs attention"],
    ["error", "attention", "Sync needs attention"],
  ] as const)(
    "maps %s without exposing a refresh control",
    (surfaceState, tone, label) => {
      state.active = {
        surface: "reports",
        state: surfaceState,
        asOf: null,
        businessId: "biz_1",
        retryKey: "tier0:reports",
      };

      const { result } = renderHook(() => useWorkspaceSyncState());

      expect(result.current).toEqual({
        tone,
        label,
        freshnessState: surfaceState,
      });
    },
  );

  it("ignores a surface snapshot owned by another business", () => {
    state.active = {
      surface: "reports",
      state: "error",
      asOf: null,
      businessId: "biz_2",
      retryKey: "tier0:reports",
    };

    const { result } = renderHook(() => useWorkspaceSyncState());

    expect(result.current).toEqual({
      tone: "fresh",
      label: "Synced 12m ago",
      freshnessState: "ready",
    });
  });
});
