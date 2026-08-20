import { describe, expect, it } from "vitest";

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
});
