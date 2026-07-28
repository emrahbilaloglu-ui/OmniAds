/**
 * Inbound throttling for the unauthenticated credential endpoints.
 *
 * WHAT THIS DEFENDS, precisely: not password guessing. Passwords are hashed
 * with bcryptjs at cost 12 (lib/auth.ts), which caps an attacker at roughly
 * four guesses per second — brute force is already infeasible. The real exposure
 * is that bcryptjs is the PURE-JAVASCRIPT implementation, so every compare runs
 * on Node's single JS thread: a handful of concurrent anonymous POSTs to
 * /api/auth/login or /api/auth/signup starve the event loop and wedge the whole
 * dashboard. Production runs exactly one `web` container (docker-compose.yml
 * publishes 127.0.0.1:3000:3000, which structurally forbids a second replica),
 * and the autoheal sidecar only watches `worker`, so a wedged `web` stays wedged.
 *
 * WHY IT IS KEYED ON IP AND NEVER ON THE ACCOUNT: this product has one human
 * operator running live ad spend. A per-account lockout would let any stranger
 * who knows that email address lock the sole operator out of a dashboard
 * controlling real budgets — a strictly better attack than the one it prevents.
 * A correct password must always get through.
 *
 * WHY IN-PROCESS STATE IS CORRECT HERE: with one container there is nothing to
 * share, and adding Redis would be a new production dependency with its own
 * failure modes. If replicas ever appear, counters degrade gracefully (the
 * effective limit becomes per-replica) and the concurrency guard below stays
 * exactly right, because it bounds per-process CPU — which is the thing that
 * actually matters. The migration path is Postgres, already in the stack.
 *
 * Time is always injected, so tests advance it arithmetically instead of
 * sleeping.
 */

export interface ThrottlePolicy {
  capacity: number;
  refillPerMs: number;
}

export const LOGIN_POLICY: ThrottlePolicy = {
  capacity: 10,
  refillPerMs: 10 / (5 * 60_000),
};

export const SIGNUP_POLICY: ThrottlePolicy = {
  capacity: 3,
  refillPerMs: 3 / (60 * 60_000),
};

export interface ThrottleDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  reason: "ok" | "rate_limited";
}

interface Bucket {
  tokens: number;
  updatedMs: number;
}

/** Bounded: rotating source IPs must not grow this map without limit. */
const MAX_TRACKED_KEYS = 10_000;
const buckets = new Map<string, Bucket>();

function evictIfNeeded(nowMs: number, policy: ThrottlePolicy): void {
  if (buckets.size < MAX_TRACKED_KEYS) return;
  // A fully refilled bucket is indistinguishable from an absent one.
  const fullAfterMs = policy.capacity / policy.refillPerMs;
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.updatedMs > fullAfterMs) buckets.delete(key);
  }
  if (buckets.size >= MAX_TRACKED_KEYS) {
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  }
}

export function consumeToken(
  key: string,
  policy: ThrottlePolicy,
  nowMs: number,
): ThrottleDecision {
  evictIfNeeded(nowMs, policy);
  const previous = buckets.get(key) ?? { tokens: policy.capacity, updatedMs: nowMs };
  const elapsed = Math.max(0, nowMs - previous.updatedMs);
  const tokens = Math.min(policy.capacity, previous.tokens + elapsed * policy.refillPerMs);

  if (tokens < 1) {
    buckets.set(key, { tokens, updatedMs: nowMs });
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((1 - tokens) / policy.refillPerMs / 1000),
      ),
      reason: "rate_limited",
    };
  }

  buckets.set(key, { tokens: tokens - 1, updatedMs: nowMs });
  return { allowed: true, retryAfterSeconds: 0, reason: "ok" };
}

/**
 * The control that actually bounds the denial of service. A rate limit alone
 * does not stop fifty requests arriving in the same second; this does.
 */
const MAX_CONCURRENT_PASSWORD_OPS = 2;
let inFlight = 0;

export function tryAcquirePasswordSlot(): boolean {
  if (inFlight >= MAX_CONCURRENT_PASSWORD_OPS) return false;
  inFlight += 1;
  return true;
}

export function releasePasswordSlot(): void {
  inFlight = Math.max(0, inFlight - 1);
}

export function __resetAuthThrottleForTests(): void {
  buckets.clear();
  inFlight = 0;
}
