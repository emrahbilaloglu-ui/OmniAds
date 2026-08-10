import { QueryClient, QueryObserver, focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveTierZeroFreshnessState } from "@/components/states/useTierZeroFreshness";
import {
  QUERY_STALE_TIME_MS,
  isQueryRevalidationEnabled,
} from "@/lib/query-client";

/**
 * A tab left open overnight.
 *
 * The failure being guarded against is not a crash: it is a screen that keeps
 * showing yesterday's spend as though it were today's, with nothing on it
 * admitting the age. So this exercises the actual observer — focus goes away,
 * time passes, focus comes back — and asserts a real second fetch happened and
 * that the freshness reading moved with it.
 *
 * The flag test alone was not enough. `refetchOnWindowFocus: true` in a config
 * file proves the option is set, not that a stale tab revalidates.
 */
function makeClient() {
  // mount() is what subscribes the client to the focus manager. Without it the
  // options say "refetch on focus" and nothing ever does — which is exactly the
  // gap between the old flag-only test and this one.
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME_MS,
        refetchOnWindowFocus: isQueryRevalidationEnabled({}),
        refetchOnReconnect: true,
        refetchOnMount: false,
        retry: false,
      },
    },
  });
  client.mount();
  return client;
}

/** Lets the observer's async work settle without a real wall-clock wait. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("an idle tab revalidates when the operator comes back", () => {
  beforeEach(() => {
    focusManager.setFocused(true);
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it("fetches again on focus once the data is stale, and reports the newer as-of", async () => {
    const client = makeClient();
    let asOf = "2026-08-08T06:00:00.000Z";
    const fetches = vi.fn(async () => ({ asOf }));

    const observer = new QueryObserver(client, {
      queryKey: ["idle-tab", "spend"],
      queryFn: fetches,
    });
    const unsubscribe = observer.subscribe(() => {});
    await settle();
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().data?.asOf).toBe(
      "2026-08-08T06:00:00.000Z",
    );

    // The operator switches away. Overnight, the upstream data moves on.
    focusManager.setFocused(false);
    asOf = "2026-08-09T06:00:00.000Z";
    client.getQueryCache().find({ queryKey: ["idle-tab", "spend"] })!.state
      .dataUpdatedAt -= QUERY_STALE_TIME_MS + 1;

    focusManager.setFocused(true);
    await settle();

    expect(fetches).toHaveBeenCalledTimes(2);
    expect(observer.getCurrentResult().data?.asOf).toBe(
      "2026-08-09T06:00:00.000Z",
    );
    unsubscribe();
    client.unmount();
    client.clear();
  });

  it("does not refetch on focus while the data is still inside the stale window", async () => {
    // Otherwise every alt-tab is a round trip, and the revalidation policy
    // becomes a request storm rather than a freshness guarantee.
    const client = makeClient();
    const fetches = vi.fn(async () => ({ ok: true }));
    const observer = new QueryObserver(client, {
      queryKey: ["idle-tab", "fresh"],
      queryFn: fetches,
    });
    const unsubscribe = observer.subscribe(() => {});
    await settle();

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await settle();

    expect(fetches).toHaveBeenCalledTimes(1);
    unsubscribe();
    client.unmount();
    client.clear();
  });

  it("shows refreshing, not loading, while a stale tab revalidates", async () => {
    // The existing figures stay on screen and are labelled as the ones being
    // replaced. Dropping to "loading" would blank a screen that has valid data.
    const client = makeClient();
    let release: (() => void) | null = null;
    const fetches = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const observer = new QueryObserver(client, {
      queryKey: ["idle-tab", "states"],
      queryFn: fetches,
    });
    const unsubscribe = observer.subscribe(() => {});
    await settle();

    // First read in flight: no data yet, so the honest word is "loading".
    expect(
      deriveTierZeroFreshnessState({
        isLoading: observer.getCurrentResult().isLoading,
        isFetching: observer.getCurrentResult().isFetching,
      }),
    ).toBe("loading");

    release!();
    await settle();
    expect(
      deriveTierZeroFreshnessState({
        isLoading: observer.getCurrentResult().isLoading,
        isFetching: observer.getCurrentResult().isFetching,
      }),
    ).toBe("ready");

    focusManager.setFocused(false);
    client.getQueryCache().find({ queryKey: ["idle-tab", "states"] })!.state
      .dataUpdatedAt -= QUERY_STALE_TIME_MS + 1;
    focusManager.setFocused(true);
    await settle();

    expect(
      deriveTierZeroFreshnessState({
        isLoading: observer.getCurrentResult().isLoading,
        isFetching: observer.getCurrentResult().isFetching,
      }),
    ).toBe("refreshing");

    release!();
    await settle();
    unsubscribe();
    client.unmount();
    client.clear();
  });

  it("surfaces a failed revalidation as an error instead of silently keeping old figures", async () => {
    const client = makeClient();
    let shouldFail = false;
    const fetches = vi.fn(async () => {
      if (shouldFail) throw new Error("upstream down");
      return { ok: true };
    });
    const observer = new QueryObserver(client, {
      queryKey: ["idle-tab", "failing"],
      queryFn: fetches,
    });
    const unsubscribe = observer.subscribe(() => {});
    await settle();

    shouldFail = true;
    focusManager.setFocused(false);
    client.getQueryCache().find({ queryKey: ["idle-tab", "failing"] })!.state
      .dataUpdatedAt -= QUERY_STALE_TIME_MS + 1;
    focusManager.setFocused(true);
    await settle();

    const result = observer.getCurrentResult();
    expect(result.error).toBeInstanceOf(Error);
    // React Query keeps the last good data; the freshness contract is what
    // stops that from reading as current.
    expect(result.data).toEqual({ ok: true });
    expect(
      deriveTierZeroFreshnessState({
        isLoading: result.isLoading,
        isFetching: result.isFetching,
        error: result.error,
      }),
    ).toBe("error");
    unsubscribe();
    client.unmount();
    client.clear();
  });
});

describe("state precedence", () => {
  it("puts loading above everything, so an unknown is never dressed as a known", () => {
    expect(
      deriveTierZeroFreshnessState({
        isLoading: true,
        isFetching: true,
        error: new Error("x"),
        partialReason: "half",
      }),
    ).toBe("loading");
  });

  it("puts error above partial and refreshing", () => {
    expect(
      deriveTierZeroFreshnessState({
        isLoading: false,
        isFetching: true,
        error: new Error("x"),
        partialReason: "half",
      }),
    ).toBe("error");
  });

  it("puts partial above refreshing, so an incomplete total says so", () => {
    expect(
      deriveTierZeroFreshnessState({
        isLoading: false,
        isFetching: true,
        partialReason: "Google could not be read",
      }),
    ).toBe("partial");
  });
});
