import { describe, expect, it, vi } from "vitest";

import { getCachedValue } from "@/lib/server-cache";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("server cache conditional writes", () => {
  it("does not cache a fail-closed value", async () => {
    const key = `conditional-cache-miss-${crypto.randomUUID()}`;
    let calls = 0;
    const read = () =>
      getCachedValue({
        key,
        ttlMs: 60_000,
        loader: async () => ({
          status: calls++ === 0 ? "unavailable" : "available",
        }),
        shouldCache: (value) => value.status === "available",
      });

    expect((await read()).value.status).toBe("unavailable");
    expect((await read()).value.status).toBe("available");
    expect(calls).toBe(2);
  });

  it("does not replace a stale available value with a failed refresh", async () => {
    const key = `conditional-cache-stale-${crypto.randomUUID()}`;
    let nextStatus = "available";
    const read = () =>
      getCachedValue({
        key,
        ttlMs: 1,
        staleWhileRevalidateMs: 10_000,
        loader: async () => ({ status: nextStatus }),
        shouldCache: (value) => value.status === "available",
      });

    expect((await read()).value.status).toBe("available");
    await wait(5);
    nextStatus = "unavailable";
    expect((await read()).value.status).toBe("available");
    await wait(5);
    expect((await read()).value.status).toBe("available");
  });

  it("reaps expired generation-scoped entries when new keys are written", async () => {
    const oldKey = `native-job-old-${crypto.randomUUID()}`;
    const newKey = `native-job-new-${crypto.randomUUID()}`;
    await getCachedValue({
      key: oldKey,
      ttlMs: 1_000,
      staleWhileRevalidateMs: 1_000,
      loader: async () => "old generation",
    });
    const store = (globalThis as typeof globalThis & {
      __omniadsServerCache?: {
        entries: Map<string, unknown>;
      };
    }).__omniadsServerCache;
    expect(store?.entries.has(oldKey)).toBe(true);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 61_000);
      await getCachedValue({
        key: newKey,
        ttlMs: 1_000,
        loader: async () => "new generation",
      });
      expect(store?.entries.has(oldKey)).toBe(false);
      expect(store?.entries.has(newKey)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
