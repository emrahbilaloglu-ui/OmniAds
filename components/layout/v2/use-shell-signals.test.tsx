// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useConfirmedShellBusinessId,
  useWorkspaceSyncState,
} from "./use-shell-signals";
import { SYNC_AGE_UNKNOWN_LABEL } from "@/lib/provider-sync-vocabulary";

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
    errorCode?: string | null;
  } | null,
  runRetry: vi.fn(),
  queryOptions: [] as Array<{
    queryKey?: readonly unknown[];
    enabled?: boolean;
    retry?: unknown;
    refetchOnWindowFocus?: unknown;
    refetchOnReconnect?: unknown;
  }>,
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
    selector: (value: {
      active: typeof state.active;
      runRetry: typeof state.runRetry;
    }) => unknown,
  ) => selector({ active: state.active, runRetry: state.runRetry }),
}));

vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQueryClient: () => ({
    getQueryCache: () => ({ subscribe: () => () => {}, findAll: () => [] }),
  }),
  // Honour `enabled` the way react-query does: a disabled query has no data.
  // A mock that always answers would hide the whole point of the gate — the
  // pill must not report a sync age for a business the shell has not confirmed.
  useQuery: (options?: (typeof state.queryOptions)[number]) => {
    if (options) state.queryOptions.push(options);
    return options?.enabled === false
      ? { data: undefined }
      : {
          data: {
            state: "ready",
            latestSync: { finishedAt: "2026-08-17T08:00:00.000Z" },
          },
        };
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
    state.queryOptions.length = 0;
    state.runRetry.mockReset();
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

    const { result } = renderHook(() =>
      useWorkspaceSyncState({ providerStatusEnabled: false }),
    );

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
  ] as const)(
    "maps %s without inventing a refresh control",
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

  it.each(["partial", "error"] as const)(
    "offers the real registered retry for %s",
    (surfaceState) => {
      state.active = {
        surface: "reports",
        state: surfaceState,
        asOf: null,
        businessId: "biz_1",
        retryKey: "tier0:reports",
        errorCode: surfaceState === "error" ? "source_read_failed" : null,
      };

      const { result } = renderHook(() => useWorkspaceSyncState());

      expect(result.current).toMatchObject({
        tone: "attention",
        label: "Sync needs attention",
        freshnessState: surfaceState,
        ...(surfaceState === "error"
          ? { errorCode: "source_read_failed" }
          : {}),
      });
      expect(result.current.onRetry).toBeTypeOf("function");
      result.current.onRetry?.();
      expect(state.runRetry).toHaveBeenCalledWith("tier0:reports");
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

  it("disables both provider status reads before a route-owned surface reports", () => {
    const { result } = renderHook(() =>
      useWorkspaceSyncState({ providerStatusEnabled: false }),
    );

    const providerQueries = state.queryOptions.filter((options) =>
      ["meta-status", "google-ads-status"].includes(
        String(options.queryKey?.[0]),
      ),
    );
    expect(providerQueries).toHaveLength(2);
    expect(providerQueries.every((options) => options.enabled === false)).toBe(
      true,
    );
    expect(result.current).toEqual({
      tone: "unknown",
      label: SYNC_AGE_UNKNOWN_LABEL,
      freshnessState: "unknown",
    });
  });

  it("keeps provider fallback on by default and makes both reads one-shot", () => {
    renderHook(() => useWorkspaceSyncState());

    const providerQueries = state.queryOptions.filter((options) =>
      ["meta-status", "google-ads-status"].includes(
        String(options.queryKey?.[0]),
      ),
    );
    expect(providerQueries).toHaveLength(2);
    for (const options of providerQueries) {
      expect(options).toMatchObject({
        enabled: true,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      });
    }
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
      label: SYNC_AGE_UNKNOWN_LABEL,
      freshnessState: "unknown",
    });
  });
});
