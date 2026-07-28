import { describe, expect, it } from "vitest";
import {
  classifyMetaSyncFailure,
  shouldDeadLetterMetaFailure,
} from "./meta-error-classification";

const MAX_ATTEMPTS = 6;

function classifyAndRoute(message: string, attemptCount: number) {
  const classification = classifyMetaSyncFailure({ message });
  return {
    errorClass: classification.errorClass,
    terminal: classification.terminal,
    actionRequired: classification.actionRequired,
    deadLetter: shouldDeadLetterMetaFailure({
      errorClass: classification.errorClass,
      terminal: classification.terminal,
      attemptCount,
      maxAttempts: MAX_ATTEMPTS,
    }),
  };
}

/**
 * "transient" is the classifier's DEFAULT for any message it does not
 * recognise, and it used to be on the always-retryable list. That made
 * META_PARTITION_MAX_ATTEMPTS unreachable for every unknown failure: a
 * deterministic 400, an out-of-memory, or a permanently oversized partition
 * retried forever behind an hour-long backoff and never entered the dead-letter
 * count the admin surface alarms on. The day silently never landed.
 */
describe("unknown Meta failures become visible instead of retrying forever", () => {
  it("dead-letters a repeating unclassified failure once the attempts run out", () => {
    const early = classifyAndRoute("Meta request failed with status 400", 1);
    const final = classifyAndRoute("Meta request failed with status 400", 5);

    expect(early.errorClass).toBe("transient");
    expect(early.deadLetter, "early attempts must still retry").toBe(false);
    expect(
      final.deadLetter,
      "a failure that repeats to the attempt cap must become visible",
    ).toBe(true);
  });

  it("dead-letters an out-of-memory rather than looping on it", () => {
    expect(classifyAndRoute("JavaScript heap out of memory", 5).deadLetter).toBe(true);
  });

  it("still never dead-letters a quota failure, which genuinely resolves itself", () => {
    const quota = classifyAndRoute("(#17) User request limit reached", 5);
    expect(quota.errorClass).toBe("quota");
    expect(quota.deadLetter).toBe(false);
  });

  it("still never dead-letters a lease conflict", () => {
    expect(
      shouldDeadLetterMetaFailure({
        errorClass: "lease_conflict",
        terminal: false,
        attemptCount: 5,
        maxAttempts: MAX_ATTEMPTS,
      }),
    ).toBe(false);
  });
});

/**
 * The account-checkpoint rule matched the bare substring "checkpoint" and sat
 * above every database rule — and our own table is named meta_sync_checkpoints.
 * So an ordinary Postgres error was diagnosed as a Facebook account checkpoint:
 * terminal, dead-lettered on the first attempt, and flagged actionRequired,
 * telling the operator to go clear a checkpoint that does not exist.
 */
describe("database errors are not diagnosed as Facebook account checkpoints", () => {
  const databaseErrors = [
    'duplicate key value violates unique constraint "meta_sync_checkpoints_pkey"',
    'column "checkpoint_hash" of relation "meta_sync_checkpoints" does not exist',
    'null value in column "checkpoint_id" violates not-null constraint',
  ];

  for (const message of databaseErrors) {
    it(`does not send the operator to Facebook for: ${message.slice(0, 46)}…`, () => {
      const routed = classifyAndRoute(message, 1);
      expect(routed.errorClass).not.toBe("account_checkpoint");
      expect(
        routed.actionRequired,
        "a schema error is not something the operator fixes on facebook.com",
      ).toBe(false);
      expect(routed.terminal, "a database error is retryable, not terminal").toBe(false);
    });
  }

  it("still recognises a genuine Facebook checkpoint as terminal and actionable", () => {
    const routed = classifyAndRoute(
      "Your account has been checkpointed, log in to www.facebook.com to continue",
      1,
    );
    expect(routed.errorClass).toBe("account_checkpoint");
    expect(routed.terminal).toBe(true);
    expect(routed.actionRequired).toBe(true);
    expect(routed.deadLetter).toBe(true);
  });

  it("still recognises an invalid token as terminal", () => {
    const routed = classifyAndRoute(
      "Error validating access token: Session has expired",
      1,
    );
    expect(routed.errorClass).toBe("invalid_token");
    expect(routed.terminal).toBe(true);
  });
});
