/**
 * CODEX B17 — a rejected revalidation must EVICT, not keep serving.
 *
 * `getCachedValue`'s stale-while-revalidate branch kicked off a background
 * reload and returned the stale value. When that reload produced a value
 * `shouldCache` rejected — the marker for "this generation is no longer
 * admissible" — the new value was simply not written, and the STALE entry
 * stayed in the store. So a generation revalidation had just found
 * inadmissible went on being served for the whole SWR window.
 *
 * A transient failure is a different thing and must keep behaving as it did:
 * "we could not check" is not "we checked and it is wrong".
 */
import { describe, expect, it, vi } from "vitest";

import { getCachedValue } from "@/lib/server-cache";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("stale-while-revalidate eviction", () => {
  it("stops serving a generation that revalidation rejects", async () => {
    const key = `evict-${Math.random().toString(36).slice(2)}`;
    // Admissible first, inadmissible afterwards.
    const loader = vi.fn<() => Promise<{ generation: string; admissible: boolean }>>()
      .mockResolvedValueOnce({ generation: "g1", admissible: true })
      .mockResolvedValue({ generation: "g2", admissible: false });
    const call = () =>
      getCachedValue({
        key,
        ttlMs: 0, // immediately stale, so the next read revalidates
        staleWhileRevalidateMs: 60_000,
        loader,
        evictStaleWhen: (value) => !value.admissible,
      });

    const first = await call();
    expect(first.value.generation).toBe("g1");

    // This read serves the stale g1 and revalidates in the background.
    const second = await call();
    expect(second.cacheState).toBe("stale");
    await tick();

    /*
      THE ASSERTION THIS FILE EXISTS FOR. Before the fix the entry survived and
      this third read served g1 again — a value the previous revalidation had
      already determined was inadmissible. It must now be a miss that loads.
    */
    const third = await call();
    expect(third.cacheState).toBe("miss");
    expect(third.value.generation).toBe("g2");
  });

  it("keeps the last known good value when revalidation THROWS", async () => {
    const key = `transient-${Math.random().toString(36).slice(2)}`;
    const loader = vi.fn<() => Promise<{ generation: string; admissible: boolean }>>()
      .mockResolvedValueOnce({ generation: "g1", admissible: true })
      .mockRejectedValue(new Error("network"));
    const call = () =>
      getCachedValue({
        key,
        ttlMs: 0,
        staleWhileRevalidateMs: 60_000,
        loader,
        evictStaleWhen: (value) => !value.admissible,
      });

    expect((await call()).value.generation).toBe("g1");
    const second = await call();
    expect(second.cacheState).toBe("stale");
    await tick();

    // Still stale-served, NOT evicted: a failure to check is not a verdict.
    const third = await call();
    expect(third.cacheState).toBe("stale");
    expect(third.value.generation).toBe("g1");
  });

  it("keeps serving while revalidation keeps succeeding", async () => {
    // The control: eviction must be caused by the rejection, not by staleness.
    const key = `keep-${Math.random().toString(36).slice(2)}`;
    const loader = vi.fn<() => Promise<{ generation: string; admissible: boolean }>>()
      .mockResolvedValue({ generation: "g1", admissible: true });
    const call = () =>
      getCachedValue({
        key,
        ttlMs: 60_000,
        staleWhileRevalidateMs: 60_000,
        loader,
        evictStaleWhen: (value) => !value.admissible,
      });

    expect((await call()).cacheState).toBe("miss");
    expect((await call()).cacheState).toBe("fresh");
    expect((await call()).value.generation).toBe("g1");
  });
});
