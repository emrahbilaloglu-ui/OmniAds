/**
 * Named stage timings for the native decision job.
 *
 * `engine_v3_job_runs.duration_ms` is whole-job only, and this job is the whole
 * chain's cost. Measured over seven days of production:
 *
 *     calibration        p50  2.0s   p95   3.0s   max   5.0s   (1,058 runs)
 *     DECISIONS          p50 67.5s   p95 120.5s   max 188.5s   (1,903 runs)
 *     operator response  p50  0.4s   p95   0.6s   max   1.4s   (1,903 runs)
 *
 * and 23 decision runs FAILED at a p50 of 61.6s with no error code recorded.
 * A single number for a two-minute job cannot name the slow read, so "which
 * query times out?" has had no measurable answer. These stages are that answer.
 */
import { describe, expect, it } from "vitest";

import { createNativeAdDecisionStageTimer } from "@/lib/creative-decision-engine/jobs/ad-decisions-job";

/** A clock the test drives, so no case depends on real elapsed time. */
function fakeClock(steps: number[]) {
  let index = 0;
  return () => steps[Math.min(index++, steps.length - 1)] ?? 0;
}

describe("the native decision stage timer", () => {
  it("records elapsed milliseconds per named stage", async () => {
    const timer = createNativeAdDecisionStageTimer(fakeClock([0, 1_200, 1_200, 1_250]));

    await timer.measure("hydrate_inputs", async () => "rows");
    await timer.measure("resolve_profiles", async () => "groups");

    expect(timer.timings).toEqual({ hydrate_inputs: 1_200, resolve_profiles: 50 });
  });

  it("ADDS across repeat visits instead of overwriting them", async () => {
    // `read_previous_labels` runs once per profile-group scope. Keeping only the
    // last visit would report a fraction of the time actually spent there, and
    // the stages would then not account for the whole-job duration.
    const timer = createNativeAdDecisionStageTimer(
      fakeClock([0, 100, 100, 400, 400, 1_000]),
    );

    for (let group = 0; group < 3; group += 1) {
      await timer.measure("read_previous_labels", async () => group);
    }

    expect(timer.timings.read_previous_labels).toBe(100 + 300 + 600);
  });

  it("records the stage that threw, because the failing runs are the point", async () => {
    const timer = createNativeAdDecisionStageTimer(fakeClock([0, 30_000]));

    await expect(
      timer.measure("hydrate_inputs", async () => {
        throw new Error("statement timeout");
      }),
    ).rejects.toThrow("statement timeout");

    expect(timer.timings).toEqual({ hydrate_inputs: 30_000 });
  });

  it("returns the stage's own value untouched", async () => {
    const timer = createNativeAdDecisionStageTimer(fakeClock([0, 1]));
    const hydration = { inputs: [1, 2, 3], receipts: [] };

    await expect(timer.measure("hydrate_inputs", async () => hydration)).resolves.toBe(
      hydration,
    );
  });

  it("times a synchronous stage the same way", () => {
    const timer = createNativeAdDecisionStageTimer(fakeClock([0, 5]));
    expect(timer.measureSync("compute_decisions", () => 42)).toBe(42);
    expect(timer.timings.compute_decisions).toBe(5);
  });

  it("starts empty, so an untouched stage is absent rather than zero", () => {
    // Absent means "this run never reached the stage". A zero would claim it
    // ran instantly, which is a different statement about a failed run.
    const timer = createNativeAdDecisionStageTimer(fakeClock([0]));
    expect(timer.timings).toEqual({});
    expect(timer.timings.persist ?? null).toBeNull();
  });
});
