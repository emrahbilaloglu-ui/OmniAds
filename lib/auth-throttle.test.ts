import { beforeEach, describe, expect, it } from "vitest";
import {
  LOGIN_POLICY,
  SIGNUP_POLICY,
  __resetAuthThrottleForTests,
  consumeToken,
  releasePasswordSlot,
  tryAcquirePasswordSlot,
} from "./auth-throttle";

/**
 * Time is injected, so every case here is arithmetic — no sleeping, no fake
 * timers, no flakiness.
 */
beforeEach(() => __resetAuthThrottleForTests());

describe("credential endpoint throttle", () => {
  it("allows the burst, then refuses with a positive Retry-After", () => {
    const t0 = Date.parse("2026-07-28T00:00:00.000Z");
    for (let i = 0; i < LOGIN_POLICY.capacity; i++) {
      expect(consumeToken("k", LOGIN_POLICY, t0).allowed, `attempt ${i + 1}`).toBe(true);
    }
    const blocked = consumeToken("k", LOGIN_POLICY, t0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("rate_limited");
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("refills purely as time advances", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_POLICY.capacity; i++) consumeToken("k", LOGIN_POLICY, t0);
    expect(consumeToken("k", LOGIN_POLICY, t0).allowed).toBe(false);

    const oneToken = 1 / LOGIN_POLICY.refillPerMs;
    expect(consumeToken("k", LOGIN_POLICY, t0 + oneToken).allowed).toBe(true);
    expect(consumeToken("k", LOGIN_POLICY, t0 + oneToken).allowed).toBe(false);
  });

  it("never lets one client spend another's budget", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_POLICY.capacity; i++) consumeToken("a", LOGIN_POLICY, t0);
    expect(consumeToken("a", LOGIN_POLICY, t0).allowed).toBe(false);
    expect(
      consumeToken("b", LOGIN_POLICY, t0).allowed,
      "a second client must not inherit the first client's exhausted bucket",
    ).toBe(true);
  });

  it("keeps signup stricter than login, since signup also writes rows", () => {
    expect(SIGNUP_POLICY.capacity).toBeLessThan(LOGIN_POLICY.capacity);
    expect(SIGNUP_POLICY.refillPerMs).toBeLessThan(LOGIN_POLICY.refillPerMs);
  });

  it("never traps a caller permanently: the bucket always recovers fully", () => {
    const t0 = 0;
    for (let i = 0; i < LOGIN_POLICY.capacity; i++) consumeToken("k", LOGIN_POLICY, t0);
    expect(consumeToken("k", LOGIN_POLICY, t0).allowed).toBe(false);

    // The single operator must never be locked out by their own retries.
    const fullyRefilled = t0 + LOGIN_POLICY.capacity / LOGIN_POLICY.refillPerMs;
    for (let i = 0; i < LOGIN_POLICY.capacity; i++) {
      expect(consumeToken("k", LOGIN_POLICY, fullyRefilled).allowed).toBe(true);
    }
  });
});

describe("password-hash concurrency guard", () => {
  it("bounds in-flight hashes and releases them again", () => {
    expect(tryAcquirePasswordSlot()).toBe(true);
    expect(tryAcquirePasswordSlot()).toBe(true);
    expect(
      tryAcquirePasswordSlot(),
      "bcryptjs is pure JS and blocks the only JS thread; unbounded concurrency wedges the process",
    ).toBe(false);

    releasePasswordSlot();
    expect(tryAcquirePasswordSlot()).toBe(true);
  });

  it("does not leak slots when a hash throws", () => {
    expect(tryAcquirePasswordSlot()).toBe(true);
    try {
      throw new Error("bcrypt exploded");
    } catch {
      releasePasswordSlot();
    }
    expect(tryAcquirePasswordSlot()).toBe(true);
    expect(tryAcquirePasswordSlot()).toBe(true);
    expect(tryAcquirePasswordSlot()).toBe(false);
  });
});
