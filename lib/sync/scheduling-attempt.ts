import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * The identity of one scheduling operation, carried into every row it creates.
 *
 * `syncScheduled: true` was proven by two weak facts: the partition's account id
 * is one this request committed, and its `created_at` falls after an app-side
 * clock reading. Neither is exact.
 *
 * A concurrent enqueue for the same account satisfies both without this request
 * having scheduled anything — so a request that enqueued nothing reports
 * success. And `created_at` is a DATABASE clock compared against an APPLICATION
 * clock: a few hundred milliseconds of skew makes a request's own work look
 * older than its own start, so a request that scheduled correctly reports a 202.
 *
 * An immutable attempt id stamped on the row answers the exact question — did
 * THIS operation create this work? — with no clock and no ambiguity. It is
 * propagated through AsyncLocalStorage so the enqueue path does not have to
 * thread it through every intermediate function that never needed to know.
 */
const schedulingAttemptStorage = new AsyncLocalStorage<string>();

/** Run `body` as one scheduling attempt and return its id alongside the result. */
export async function withSchedulingAttempt<T>(
  body: (attemptId: string) => Promise<T>,
): Promise<{ attemptId: string; result: T }> {
  const attemptId = randomUUID();
  const result = await schedulingAttemptStorage.run(attemptId, () =>
    body(attemptId),
  );
  return { attemptId, result };
}

/**
 * The attempt currently in scope, or null.
 *
 * Null is correct and common: work created by the worker's own planning, by a
 * cron tick, or by a recovery pass belongs to no user-facing scheduling
 * operation, and stamping it with one would be a lie.
 */
export function getCurrentSchedulingAttemptId(): string | null {
  return schedulingAttemptStorage.getStore() ?? null;
}
