import { describe, expect, it } from "vitest";
import {
  classifyMetaDecisionOutcomeStatus,
  metaEmpiricalOutcomeSummaryKey,
  summarizeMetaDecisionOutcomesByKey,
  summarizeMetaDecisionOutcomes,
} from "@/lib/meta/empirical-outcomes";

function rows(statuses: string[]) {
  return statuses.map((outcomeStatus) => ({
    actionType: "outcome",
    outcomeStatus,
  }));
}

function controlledRows(statuses: string[], invalidReceiptIndex = -1) {
  return statuses.map((outcomeStatus, index) => {
    const recommendationFingerprint = `fingerprint-${index}`;
    const recId = `rec-${index}`;
    const experimentId = "experiment-1";
    const assignmentId = `assignment-${index}`;
    return {
      recommendationFingerprint,
      recId,
      treatmentReceiptValidated: index !== invalidReceiptIndex,
      causalAssignmentValidated: true,
      causalEstimateValidated: true,
      actionType: "outcome",
      outcomeStatus,
      payloadJson: {
        evidenceClass: "controlled_causal",
        causalDesign: {
          contractVersion: "meta-controlled-causal-design.v1",
          method: "randomized_controlled_trial",
          experimentId,
          assignmentId,
          estimateId: `estimate-${index}`,
        },
        treatmentReceipt: {
          contractVersion: "meta-treatment-receipt.v1",
          actionLogId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          recommendationFingerprint,
          recId,
          experimentId,
          assignmentId,
          status: "success",
          verificationStatus: "verified",
          executedAt: "2026-07-01T10:00:00.000Z",
          verifiedAt: "2026-07-01T10:05:00.000Z",
        },
      },
    };
  });
}

describe("Meta empirical outcomes", () => {
  it("builds stable type and decision-label summary keys", () => {
    expect(
      metaEmpiricalOutcomeSummaryKey({
        recType: "adset_scale_budget",
        decisionLabel: "scale",
      }),
    ).toBe("adset_scale_budget::scale");
    expect(
      metaEmpiricalOutcomeSummaryKey({
        recType: "adset_scale_budget",
        decisionLabel: null,
      }),
    ).toBe("adset_scale_budget::*");
  });

  it("normalizes outcome status vocabulary", () => {
    expect(classifyMetaDecisionOutcomeStatus("profitable")).toBe("positive");
    expect(classifyMetaDecisionOutcomeStatus("regressed")).toBe("negative");
    expect(classifyMetaDecisionOutcomeStatus("mixed")).toBe("neutral");
    expect(classifyMetaDecisionOutcomeStatus(null)).toBe("unknown");
  });

  it("summarizes persisted outcomes by recommendation type and decision label", () => {
    const summaries = summarizeMetaDecisionOutcomesByKey(
      [
        {
          rec_type: "adset_scale_budget",
          decision_label: "scale",
          action_type: "outcome",
          outcome_status: "positive",
        },
        {
          rec_type: "adset_scale_budget",
          decision_label: "scale",
          action_type: "outcome",
          outcome_status: "negative",
        },
        {
          rec_type: "adset_cut_spend",
          decision_label: "cut",
          action_type: "preflight",
          outcome_status: "positive",
        },
      ],
      { minSampleSize: 2 },
    );

    expect(summaries["adset_scale_budget::scale"]).toMatchObject({
      sampleSize: 2,
      judgedSampleSize: 2,
      positiveCount: 1,
      negativeCount: 1,
      confidenceBand: "low",
    });
    expect(summaries["adset_cut_spend::cut"]).toMatchObject({
      sampleSize: 0,
      judgedSampleSize: 0,
      confidenceBand: "insufficient_sample",
    });
  });

  it("ignores non-outcome action logs", () => {
    const summary = summarizeMetaDecisionOutcomes(
      [
        { actionType: "preflight", outcomeStatus: "success" },
        { actionType: "execute", outcomeStatus: "success" },
        { action_type: "rollback", outcomeStatus: "success" },
        { action_type: "outcome", outcome_status: "negative" },
      ],
      { minSampleSize: 2 },
    );

    expect(summary).toMatchObject({
      sampleSize: 1,
      judgedSampleSize: 1,
      positiveCount: 0,
      negativeCount: 1,
      precision: 0,
      negativeRate: 1,
      confidenceBand: "insufficient_sample",
      autoEligible: false,
    });
  });

  it("requires enough sample before emitting a confidence band", () => {
    const summary = summarizeMetaDecisionOutcomes(
      rows(["positive", "positive", "negative"]),
      {
        minSampleSize: 5,
      },
    );

    expect(summary).toMatchObject({
      sampleSize: 3,
      judgedSampleSize: 3,
      positiveCount: 2,
      negativeCount: 1,
      confidenceBand: "insufficient_sample",
      autoEligible: false,
    });
  });

  it("requires enough judged outcomes before auto eligibility", () => {
    const summary = summarizeMetaDecisionOutcomes(
      rows([
        "positive",
        "neutral",
        "neutral",
        "neutral",
        "neutral",
        "unknown",
        "unknown",
        "unknown",
        "unknown",
        "unknown",
      ]),
      { minSampleSize: 10 },
    );

    expect(summary).toMatchObject({
      sampleSize: 10,
      judgedSampleSize: 1,
      positiveCount: 1,
      negativeCount: 0,
      precision: 1,
      negativeRate: 0,
      confidenceBand: "insufficient_sample",
      autoEligible: false,
    });
  });

  it("keeps 10+ positive observational outcomes review-only even when the operator acted", () => {
    const summary = summarizeMetaDecisionOutcomes(
      Array.from({ length: 12 }, () => ({
        actionType: "outcome",
        outcomeStatus: "positive",
        payloadJson: {
          evidenceClass: "observational_pre_post",
          operatorActed: true,
          treatmentReceipt: null,
        },
      })),
      { minSampleSize: 10 },
    );

    expect(summary).toMatchObject({
      sampleSize: 12,
      judgedSampleSize: 12,
      positiveCount: 12,
      negativeCount: 0,
      precision: 1,
      negativeRate: 0,
      confidenceBand: "high",
      controlledCausal: {
        claimedSampleSize: 0,
        sampleSize: 0,
        judgedSampleSize: 0,
        confidenceBand: "insufficient_sample",
        validTreatmentReceiptCount: 0,
        validatedAssignmentCount: 0,
        validatedEstimateCount: 0,
      },
      autoEligible: false,
    });
  });

  it("allows only receipt-backed controlled causal outcomes to reach auto eligibility", () => {
    const summary = summarizeMetaDecisionOutcomes(
      controlledRows(Array.from({ length: 10 }, () => "positive")),
      { minSampleSize: 10 },
    );

    expect(summary.controlledCausal).toMatchObject({
      claimedSampleSize: 10,
      sampleSize: 10,
      judgedSampleSize: 10,
      positiveCount: 10,
      negativeCount: 0,
      precision: 1,
      negativeRate: 0,
      confidenceBand: "high",
      validTreatmentReceiptCount: 10,
      invalidTreatmentReceiptCount: 0,
      validatedAssignmentCount: 10,
      invalidAssignmentCount: 0,
      validatedEstimateCount: 10,
      invalidEstimateCount: 0,
      duplicateAssignmentCount: 0,
      reusedTreatmentReceiptCount: 0,
      reusedEstimateCount: 0,
    });
    expect(summary.autoEligible).toBe(true);
  });

  it("excludes invalid treatment receipts from the causal sample floor", () => {
    const summary = summarizeMetaDecisionOutcomes(
      controlledRows(
        Array.from({ length: 10 }, () => "positive"),
        0,
      ),
      { minSampleSize: 10 },
    );

    expect(summary.controlledCausal).toMatchObject({
      claimedSampleSize: 10,
      sampleSize: 9,
      judgedSampleSize: 9,
      validTreatmentReceiptCount: 9,
      invalidTreatmentReceiptCount: 1,
      confidenceBand: "insufficient_sample",
    });
    expect(summary.autoEligible).toBe(false);
  });

  it("fails closed when a high-confidence causal batch contains one malformed claim", () => {
    const valid = controlledRows(
      Array.from({ length: 10 }, () => "positive"),
    );
    const malformed = controlledRows(["positive"])[0]!;
    const summary = summarizeMetaDecisionOutcomes(
      [
        ...valid,
        {
          ...malformed,
          recommendationFingerprint: "does-not-match-receipt",
        },
      ],
      { minSampleSize: 10 },
    );

    expect(summary.controlledCausal).toMatchObject({
      claimedSampleSize: 11,
      sampleSize: 10,
      judgedSampleSize: 10,
      confidenceBand: "high",
    });
    expect(summary.autoEligible).toBe(false);
  });

  it("keeps payload-only causal claims out until assignment and estimate registries validate them", () => {
    const claimed = controlledRows(
      Array.from({ length: 10 }, () => "positive"),
    ).map((row) => ({
      ...row,
      causalAssignmentValidated: false,
      causalEstimateValidated: false,
    }));
    const summary = summarizeMetaDecisionOutcomes(claimed, {
      minSampleSize: 10,
    });

    expect(summary.controlledCausal).toMatchObject({
      claimedSampleSize: 10,
      sampleSize: 0,
      judgedSampleSize: 0,
      invalidAssignmentCount: 10,
      invalidEstimateCount: 10,
      confidenceBand: "insufficient_sample",
    });
    expect(summary.autoEligible).toBe(false);
  });

  it("does not let duplicate assignments or reused treatment receipts inflate the causal sample", () => {
    const source = controlledRows(
      Array.from({ length: 10 }, () => "positive"),
    );
    const first = source[0]!;
    const duplicates = source.map((row, index) =>
      index === 0
        ? row
        : {
            ...row,
            payloadJson: first.payloadJson,
            recommendationFingerprint: first.recommendationFingerprint,
            recId: first.recId,
          },
    );
    const summary = summarizeMetaDecisionOutcomes(duplicates, {
      minSampleSize: 10,
    });

    expect(summary.controlledCausal).toMatchObject({
      claimedSampleSize: 10,
      sampleSize: 1,
      judgedSampleSize: 1,
      duplicateAssignmentCount: 9,
      confidenceBand: "insufficient_sample",
    });
    expect(summary.autoEligible).toBe(false);
  });

  it("rejects one verified treatment receipt reused across distinct assignments", () => {
    const source = controlledRows(
      Array.from({ length: 10 }, () => "positive"),
    );
    const firstReceipt = source[0]!.payloadJson.treatmentReceipt;
    const reused = source.map((row) => ({
      ...row,
      payloadJson: {
        ...row.payloadJson,
        treatmentReceipt: {
          ...row.payloadJson.treatmentReceipt,
          actionLogId: firstReceipt.actionLogId,
        },
      },
    }));
    const summary = summarizeMetaDecisionOutcomes(reused, {
      minSampleSize: 10,
    });

    expect(summary.controlledCausal).toMatchObject({
      claimedSampleSize: 10,
      sampleSize: 1,
      judgedSampleSize: 1,
      duplicateAssignmentCount: 0,
      reusedTreatmentReceiptCount: 9,
      confidenceBand: "insufficient_sample",
    });
    expect(summary.autoEligible).toBe(false);
  });

  it("rejects one finalized control estimate reused across distinct observations", () => {
    const source = controlledRows(
      Array.from({ length: 10 }, () => "positive"),
    );
    const firstEstimateId = source[0]!.payloadJson.causalDesign.estimateId;
    const reused = source.map((row) => ({
      ...row,
      payloadJson: {
        ...row.payloadJson,
        causalDesign: {
          ...row.payloadJson.causalDesign,
          estimateId: firstEstimateId,
        },
      },
    }));
    const summary = summarizeMetaDecisionOutcomes(reused, {
      minSampleSize: 10,
    });

    expect(summary.controlledCausal).toMatchObject({
      claimedSampleSize: 10,
      sampleSize: 1,
      judgedSampleSize: 1,
      duplicateAssignmentCount: 0,
      reusedTreatmentReceiptCount: 0,
      reusedEstimateCount: 9,
      confidenceBand: "insufficient_sample",
    });
    expect(summary.autoEligible).toBe(false);
  });

  it("applies the existing precision and negative-rate calibration to causal rows", () => {
    const summary = summarizeMetaDecisionOutcomes(
      controlledRows([
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "negative",
        "negative",
      ]),
      { minSampleSize: 10 },
    );

    expect(summary.controlledCausal).toMatchObject({
      judgedSampleSize: 10,
      precision: 0.8,
      negativeRate: 0.2,
      confidenceBand: "medium",
    });
    expect(summary.autoEligible).toBe(false);
  });

  it("does not let unknown outcomes dilute the negative-rate gate", () => {
    const summary = summarizeMetaDecisionOutcomes(
      rows([
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "negative",
        "negative",
        ...Array.from({ length: 990 }, () => "unknown"),
      ]),
      { minSampleSize: 10 },
    );

    expect(summary).toMatchObject({
      sampleSize: 1000,
      judgedSampleSize: 10,
      positiveCount: 8,
      negativeCount: 2,
      precision: 0.8,
      negativeRate: 0.2,
      confidenceBand: "medium",
      autoEligible: false,
    });
  });

  it("keeps weak precision below auto eligibility", () => {
    const summary = summarizeMetaDecisionOutcomes(
      rows([
        "positive",
        "positive",
        "positive",
        "negative",
        "negative",
        "negative",
        "negative",
        "negative",
        "negative",
        "negative",
      ]),
      { minSampleSize: 10 },
    );

    expect(summary.confidenceBand).toBe("low");
    expect(summary.autoEligible).toBe(false);
  });
});
