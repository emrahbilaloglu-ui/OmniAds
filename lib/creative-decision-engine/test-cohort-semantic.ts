import type { MetaCampaignKind } from "@/lib/meta/campaign-label-types";
import type { DecisionLabel, DecisionLabelTransform } from "./types";

export const TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM =
  "test_cohort_refresh_to_cut" satisfies DecisionLabelTransform;

export const TEST_COHORT_REFRESH_TO_CUT_REASON_PREFIX =
  "[test_cohort: refresh->cut]";

export interface TestCohortRefreshOverrideInput {
  campaignKind: MetaCampaignKind | null | undefined;
  label: DecisionLabel;
  reason: string;
  labelTransform?: DecisionLabelTransform | null;
}

export interface TestCohortRefreshOverrideResult {
  label: DecisionLabel;
  reason: string;
  labelTransform: DecisionLabelTransform | null;
}

function withReasonPrefix(reason: string) {
  return reason.includes(TEST_COHORT_REFRESH_TO_CUT_REASON_PREFIX)
    ? reason
    : `${TEST_COHORT_REFRESH_TO_CUT_REASON_PREFIX} ${reason}`;
}

export function applyTestCohortRefreshOverride(
  input: TestCohortRefreshOverrideInput,
): TestCohortRefreshOverrideResult {
  const alreadyTransformed =
    input.labelTransform === TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM;
  const shouldTransform =
    alreadyTransformed ||
    (input.campaignKind === "test" && input.label === "refresh");

  if (!shouldTransform) {
    return {
      label: input.label,
      reason: input.reason,
      labelTransform: null,
    };
  }

  return {
    label: input.label === "refresh" ? "cut" : input.label,
    reason: withReasonPrefix(input.reason),
    labelTransform: TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM,
  };
}
