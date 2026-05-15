import { describe, expect, it } from "vitest";
import {
  applyTestCohortRefreshOverride,
  TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM,
  TEST_COHORT_REFRESH_TO_CUT_REASON_PREFIX,
} from "../test-cohort-semantic";

describe("applyTestCohortRefreshOverride", () => {
  it("transforms Test cohort refresh decisions into cut decisions", () => {
    const result = applyTestCohortRefreshOverride({
      campaignKind: "test",
      label: "refresh",
      reason: "fatigued creative needs iteration",
    });

    expect(result).toEqual({
      label: "cut",
      reason: `${TEST_COHORT_REFRESH_TO_CUT_REASON_PREFIX} fatigued creative needs iteration`,
      labelTransform: TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM,
    });
  });

  it("does not transform Main, Mixed, or unlabeled refresh decisions", () => {
    for (const campaignKind of ["main", "mixed", null] as const) {
      const result = applyTestCohortRefreshOverride({
        campaignKind,
        label: "refresh",
        reason: "fatigued creative needs iteration",
      });

      expect(result).toEqual({
        label: "refresh",
        reason: "fatigued creative needs iteration",
        labelTransform: null,
      });
    }
  });

  it("does not transform non-refresh Test decisions", () => {
    const result = applyTestCohortRefreshOverride({
      campaignKind: "test",
      label: "keep",
      reason: "near scale but still under evidence floor",
    });

    expect(result).toEqual({
      label: "keep",
      reason: "near scale but still under evidence floor",
      labelTransform: null,
    });
  });

  it("is idempotent when a decision already carries the transform marker", () => {
    const result = applyTestCohortRefreshOverride({
      campaignKind: "test",
      label: "cut",
      reason: `${TEST_COHORT_REFRESH_TO_CUT_REASON_PREFIX} fatigued creative needs iteration`,
      labelTransform: TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM,
    });

    expect(result).toEqual({
      label: "cut",
      reason: `${TEST_COHORT_REFRESH_TO_CUT_REASON_PREFIX} fatigued creative needs iteration`,
      labelTransform: TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM,
    });
  });

  it("does not double-prefix when prior post-processing already added text before the marker", () => {
    const reason = `[soft-only - cut blocked] ${TEST_COHORT_REFRESH_TO_CUT_REASON_PREFIX} fatigued creative needs iteration`;
    const result = applyTestCohortRefreshOverride({
      campaignKind: "test",
      label: "test_more",
      reason,
      labelTransform: TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM,
    });

    expect(result).toEqual({
      label: "test_more",
      reason,
      labelTransform: TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM,
    });
  });
});
