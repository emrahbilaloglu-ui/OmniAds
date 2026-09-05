import { describe, expect, it } from "vitest";

import {
  metaWriteFailureAnswer,
  metaWriteTerminalAnswer,
} from "@/lib/meta/write-outcome";

/**
 * The defect this file pins: a verified, read-back, journalled pause was
 * presented to the operator as "Outcome unknown — do not retry", because the
 * route answered `{ ok: true }` and the ceremony correctly refused to infer an
 * outcome from it.
 */
describe("the terminal answer a Meta write route gives the ceremony", () => {
  it("reports a journalled success as verified, with the log id as its receipt", () => {
    expect(
      metaWriteTerminalAnswer({
        dryRun: false,
        logStatus: "success",
        logId: "log-1",
      }),
    ).toEqual({ outcome: "verified", durable: true, reference: "log-1" });
  });

  it("keeps a rehearsal distinct from an application", () => {
    // Not `verified`: nothing reached Meta. Not `failed`: the guardrail did
    // exactly its job.
    expect(
      metaWriteTerminalAnswer({ dryRun: true, logStatus: "success", logId: "log-2" }),
    ).toEqual({ outcome: "dry_run", durable: true, reference: "log-2" });
  });

  it("carries a silent failure through as itself", () => {
    expect(
      metaWriteTerminalAnswer({
        dryRun: false,
        logStatus: "silent_failure",
        logId: "log-3",
      }).outcome,
    ).toBe("silent_failure");
  });

  it("reports a refused write as failed", () => {
    expect(
      metaWriteTerminalAnswer({ dryRun: false, logStatus: "failure", logId: "log-4" })
        .outcome,
    ).toBe("failed");
  });

  it("stays ambiguous when nothing durable settled the attempt", () => {
    // The one reading that forbids a retry, and the only honest one when no
    // terminal row exists.
    for (const logStatus of [null, undefined, "running", "unexpected"]) {
      const answer = metaWriteTerminalAnswer({
        dryRun: false,
        logStatus,
        logId: "log-5",
      });
      expect(answer.outcome).toBe("provider_outcome_ambiguous");
      expect(answer.durable).toBe(false);
    }
  });

  it("never claims a receipt it does not have", () => {
    expect(
      metaWriteTerminalAnswer({ dryRun: false, logStatus: "success", logId: null }),
    ).toEqual({ outcome: "verified", durable: false, reference: null });
  });

  it("separates a refused write from an unresolved one", () => {
    expect(
      metaWriteFailureAnswer({ providerOutcome: "definite_failure", logId: "log-6" }),
    ).toEqual({ outcome: "failed", durable: true, reference: "log-6" });
    const ambiguous = metaWriteFailureAnswer({
      providerOutcome: "outcome_ambiguous",
      logId: "log-7",
    });
    // Ambiguity is never durable: there is nothing settled to quote, and a
    // receipt would invite "we do not know" to be read as "it worked".
    expect(ambiguous).toEqual({
      outcome: "provider_outcome_ambiguous",
      durable: false,
      reference: "log-7",
    });
  });
});
