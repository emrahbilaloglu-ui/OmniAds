// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useConfirmedShellBusinessId,
  useWorkspaceSyncState,
} from "./use-shell-signals";

const state = vi.hoisted(() => ({
  app: {
    selectedBusinessId: "biz_1" as string | null,
    businesses: [{ id: "biz_1" }] as Array<{ id: string }>,
    hasHydrated: true,
    authBootstrapStatus: "ready",
  },
  envelopeBusinessId: null as string | null,
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

vi.mock("@/components/workspace/workspace-context-provider", () => ({
  useOptionalWorkspaceContext: () =>
    state.envelopeBusinessId
      ? { business: { id: state.envelopeBusinessId } }
      : null,
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
  // Honour `enabled` the way react-query does: a disabled query has no data.
  // A mock that always answers would hide the whole point of the gate — the
  // pill must not report a sync age for a business the shell has not confirmed.
  useQuery: (options?: { enabled?: boolean }) =>
    options?.enabled === false
      ? { data: undefined }
      : {
          data: {
            state: "ready",
            latestSync: { finishedAt: "2026-08-17T08:00:00.000Z" },
          },
        },
}));

describe("workspace sync topbar state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T08:12:00.000Z"));
    state.active = null;
    state.envelopeBusinessId = null;
    state.app.selectedBusinessId = "biz_1";
    state.app.businesses = [{ id: "biz_1" }];
    state.app.hasHydrated = true;
    state.app.authBootstrapStatus = "ready";
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

/**
 * One business rule for the whole shell.
 *
 * The topbar switcher resolved its business from the server envelope while the
 * rail, the lane badges and this freshness pill resolved theirs from the
 * persisted store. Between localStorage rehydration and AuthBootstrap those are
 * different workspaces, so the chrome named two at once and rail links minted in
 * that window landed on the Meta scope refusal. These tests hold the single
 * resolution order that ended it.
 */
describe("the business the shell chrome is allowed to name", () => {
  beforeEach(() => {
    state.envelopeBusinessId = null;
    state.app.selectedBusinessId = "biz_1";
    state.app.businesses = [{ id: "biz_1" }];
    state.app.hasHydrated = true;
    state.app.authBootstrapStatus = "ready";
  });

  it("prefers the server-resolved envelope over a stale persisted selection", () => {
    state.envelopeBusinessId = "biz_envelope";
    state.app.selectedBusinessId = "biz_persisted";
    state.app.businesses = [{ id: "biz_persisted" }];

    const { result } = renderHook(() => useConfirmedShellBusinessId());

    expect(result.current).toBe("biz_envelope");
  });

  it("confirms nothing before auth bootstrap has finished", () => {
    state.app.authBootstrapStatus = "loading";

    const { result } = renderHook(() => useConfirmedShellBusinessId());

    // Not "biz_1". A value the shell has not confirmed must mint no link, no
    // query key and no badge — an unconfirmed scope is missing data.
    expect(result.current).toBeNull();
  });

  it("confirms nothing before the store has hydrated", () => {
    state.app.hasHydrated = false;

    const { result } = renderHook(() => useConfirmedShellBusinessId());

    expect(result.current).toBeNull();
  });

  it("refuses a persisted selection that is no longer in the membership list", () => {
    state.app.selectedBusinessId = "biz_revoked";
    state.app.businesses = [{ id: "biz_1" }];

    const { result } = renderHook(() => useConfirmedShellBusinessId());

    expect(result.current).toBeNull();
  });

  it("reports no sync age at all while the business is unconfirmed", () => {
    state.app.authBootstrapStatus = "loading";

    const { result } = renderHook(() => useWorkspaceSyncState());

    // The provider status queries are disabled without a confirmed business, so
    // the pill says unknown rather than reporting the previous workspace's age.
    expect(result.current).toEqual({
      tone: "unknown",
      label: "Synced —",
      freshnessState: "unknown",
    });
  });
});
