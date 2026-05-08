import { describe, expect, it } from "vitest";
import {
  deriveMetaAnalysisStatus,
  didMetaAnalysisRefetchProduceUsableData,
  metaAnalysisRunRangeMatches,
} from "@/lib/meta/analysis-state";

const range = {
  businessId: "biz",
  startDate: "2026-04-01",
  endDate: "2026-04-21",
};

function recommendations(
  system: "snapshot_fallback" | "demo" = "snapshot_fallback",
  overrides: Record<string, unknown> = {},
) {
  return {
    status: "ok",
    ...range,
    summary: {} as never,
    recommendations: [],
    sourceModel: "snapshot_heuristics",
    analysisSource: {
      system,
      decisionOsAvailable: false,
      ...(system === "snapshot_fallback"
        ? { fallbackReason: "meta_engine_v1_snapshot" }
        : {}),
    },
    ...overrides,
  } as never;
}

describe("deriveMetaAnalysisStatus", () => {
  it("returns not_run before manual analysis has data", () => {
    const status = deriveMetaAnalysisStatus({
      ...range,
      recommendationsIsFetching: false,
    });

    expect(status.state).toBe("not_run");
    expect(status.decisionOsLabel).toBe("Archived");
    expect(status.recommendationSource).toBe("none");
    expect(status.presentationMode).toBe("no_guidance");
    expect(status.message).toContain("Run analysis");
  });

  it("returns running while recommendations fetch", () => {
    const status = deriveMetaAnalysisStatus({
      ...range,
      recommendationsIsFetching: true,
    });

    expect(status.state).toBe("running");
    expect(status.decisionOsStatus).toBe("archived");
    expect(status.presentationMode).toBe("loading");
    expect(status.isAnalysisRunning).toBe(true);
  });

  it("labels snapshot fallback recommendations with the fallback reason", () => {
    const status = deriveMetaAnalysisStatus({
      ...range,
      recommendationsData: recommendations("snapshot_fallback"),
      recommendationsIsFetching: false,
    });

    expect(status.state).toBe("recommendation_fallback");
    expect(status.decisionOsStatus).toBe("archived");
    expect(status.recommendationSourceLabel).toBe("Snapshot fallback");
    expect(status.detailReasons).toContain("meta_engine_v1_snapshot");
  });

  it("labels demo recommendations as context instead of no guidance", () => {
    const status = deriveMetaAnalysisStatus({
      ...range,
      recommendationsData: recommendations("demo", {
        recommendations: [{ id: "rec-1" }],
      }),
      recommendationsIsFetching: false,
    });

    expect(status.state).toBe("not_run");
    expect(status.decisionOsStatus).toBe("archived");
    expect(status.recommendationSource).toBe("demo");
    expect(status.presentationMode).toBe("demo_context");
    expect(status.presentationModeLabel).toBe("Demo context");
    expect(status.message).toContain("demo recommendation context");
  });

  it("returns safe error state without exposing raw errors", () => {
    const status = deriveMetaAnalysisStatus({
      ...range,
      recommendationsError: new Error("database password leaked"),
      recommendationsIsFetching: false,
    });

    expect(status.state).toBe("error");
    expect(status.safeErrorMessage).toBe(
      "Analysis could not complete safely. Run analysis again for this range.",
    );
    expect(status.safeErrorMessage).not.toContain("password");
  });

  it("returns error when a response does not match the selected range", () => {
    const status = deriveMetaAnalysisStatus({
      ...range,
      recommendationsIsFetching: false,
      recommendationsData: recommendations("snapshot_fallback", {
        businessId: "other-biz",
      }),
    });

    expect(status.state).toBe("error");
    expect(status.rangeMismatch).toBe(true);
    expect(status.decisionOsStatus).toBe("mismatch");
    expect(status.message).toContain("does not match");
  });

  it("does not false-mismatch ISO timestamp dates against date-only current params", () => {
    const status = deriveMetaAnalysisStatus({
      ...range,
      recommendationsIsFetching: false,
      recommendationsData: recommendations("snapshot_fallback", {
        startDate: "2026-04-01T00:00:00.000Z",
        endDate: "2026-04-21T23:59:59.999Z",
      }),
    });

    expect(status.rangeMismatch).toBe(false);
    expect(status.decisionOsStatus).toBe("archived");
  });

  it("does not treat refetch error results as successful analysis", () => {
    expect(
      didMetaAnalysisRefetchProduceUsableData({
        recommendationsResult: {
          status: "error",
          error: new Error("failed"),
          data: recommendations("snapshot_fallback"),
        },
        expectedRange: range,
      }),
    ).toBe(false);
  });

  it("treats a successful usable refetch response as a successful analysis", () => {
    expect(
      didMetaAnalysisRefetchProduceUsableData({
        recommendationsResult: {
          status: "success",
          data: recommendations("snapshot_fallback"),
        },
        expectedRange: range,
      }),
    ).toBe(true);
  });

  it("does not treat usable recommendations from a previous date range as successful analysis", () => {
    expect(
      didMetaAnalysisRefetchProduceUsableData({
        recommendationsResult: {
          status: "success",
          data: recommendations("snapshot_fallback", {
            startDate: "2026-03-01",
            endDate: "2026-03-21",
          }),
        },
        expectedRange: range,
      }),
    ).toBe(false);
  });

  it("does not stamp success when a usable same-run refetch payload is mismatched", () => {
    expect(
      didMetaAnalysisRefetchProduceUsableData({
        recommendationsResult: {
          status: "success",
          data: recommendations("snapshot_fallback", {
            startDate: "2026-04-02",
          }),
        },
        expectedRange: range,
      }),
    ).toBe(false);
  });

  it("does not treat usable refetch data with missing range fields as successful analysis", () => {
    const dataWithoutBusinessId = Object.fromEntries(
      Object.entries(
        recommendations("snapshot_fallback") as Record<string, unknown>,
      ).filter(([key]) => key !== "businessId"),
    );

    expect(
      didMetaAnalysisRefetchProduceUsableData({
        recommendationsResult: {
          status: "success",
          data: dataWithoutBusinessId as never,
        },
        expectedRange: range,
      }),
    ).toBe(false);
  });

  it("normalizes refetch response dates before comparing the active range", () => {
    expect(
      didMetaAnalysisRefetchProduceUsableData({
        recommendationsResult: {
          status: "success",
          data: recommendations("snapshot_fallback", {
            startDate: "2026-04-01T00:00:00.000Z",
            endDate: "2026-04-21T23:59:59.999Z",
          }),
        },
        expectedRange: range,
      }),
    ).toBe(true);
  });

  it("matches the active analysis range with normalized dates", () => {
    expect(
      metaAnalysisRunRangeMatches(
        {
          businessId: "biz",
          startDate: "2026-04-01T00:00:00.000Z",
          endDate: "2026-04-21T23:59:59.999Z",
        },
        range,
      ),
    ).toBe(true);
  });

  it("rejects stale analyze completions after the active range changes", () => {
    expect(
      metaAnalysisRunRangeMatches(
        {
          businessId: "biz",
          startDate: "2026-04-08",
          endDate: "2026-04-21",
        },
        range,
      ),
    ).toBe(false);
  });

  it("rejects stale analyze completions after the active business changes", () => {
    expect(
      metaAnalysisRunRangeMatches(
        {
          businessId: "other-biz",
          startDate: "2026-04-01",
          endDate: "2026-04-21",
        },
        range,
      ),
    ).toBe(false);
  });
});
