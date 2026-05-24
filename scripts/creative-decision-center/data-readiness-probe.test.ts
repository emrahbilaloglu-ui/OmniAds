import { describe, expect, it } from "vitest";
import {
  DATA_READINESS_ACTION_REQUIREMENTS,
  buildDataReadinessProbeReport,
  evaluateActionReadiness,
  loadDataReadinessCoverageArtifact,
  normalizeCoverageArtifact,
  validateDataReadinessProbeReport,
} from "@/scripts/creative-decision-center/data-readiness-probe";

describe("creative decision center data readiness probe", () => {
  it("reports fixture-only provenance and read-only safety for the generated artifact", () => {
    const report = buildDataReadinessProbeReport(loadDataReadinessCoverageArtifact());

    expect(report.readOnly).toBe(true);
    expect(report.mutatesData).toBe(false);
    expect(report.sourceArtifact).toMatchObject({
      path: "docs/creative-decision-center/generated/data-readiness-coverage.json",
      source: "fixture",
      readOnly: true,
    });
    expect(report.liveEvidence).toMatchObject({
      status: "fixture_only",
      attempted: false,
      source: "fixture",
      missingEnv: ["DATABASE_URL"],
      rowCount: 35,
    });
    expect(validateDataReadinessProbeReport(report)).toEqual([]);
  });

  it("keeps delivery, policy, and launch actions blocked when required fields are only partial", () => {
    const report = buildDataReadinessProbeReport(loadDataReadinessCoverageArtifact());

    expect(
      Object.fromEntries(report.actions.map((entry) => [entry.action, entry.readinessStatus])),
    ).toMatchObject({
      fix_delivery: "blocked",
      fix_policy: "blocked",
      watch_launch: "blocked",
    });
    expect(report.actions.find((entry) => entry.action === "fix_delivery")).toMatchObject({
      partialFields: ["adStatus", "spend24h", "impressions24h"],
      coverageComplete: false,
    });
    expect(report.actions.find((entry) => entry.action === "fix_policy")).toMatchObject({
      partialFields: ["reviewStatus", "effectiveStatus", "disapprovalReason", "limitedReason"],
      coverageComplete: false,
    });
    expect(report.actions.find((entry) => entry.action === "watch_launch")).toMatchObject({
      partialFields: ["firstSeenAt", "firstSpendAt"],
      coverageComplete: false,
    });
  });

  it("caps high-confidence fatigue and scale or cut when support fields are partial", () => {
    const report = buildDataReadinessProbeReport(loadDataReadinessCoverageArtifact());

    expect(report.actions.find((entry) => entry.action === "high_confidence_fatigue")).toMatchObject({
      readinessStatus: "confidence_capped",
      partialFields: ["ctr", "cpm", "frequency"],
      coverageComplete: false,
    });
    expect(report.actions.find((entry) => entry.action === "high_confidence_scale_cut")).toMatchObject({
      readinessStatus: "confidence_capped",
      partialFields: ["dataFreshness", "targetSource", "benchmarkReliability"],
      coverageComplete: false,
    });
  });

  it("fails strict validation when a critical field is absent from the source artifact", () => {
    const artifact = normalizeCoverageArtifact({
      contractVersion: "test",
      source: "fixture",
      readOnly: true,
      liveStatus: {
        attempted: false,
        source: "fixture",
        readOnly: true,
        missingEnv: ["DATABASE_URL"],
        rowCount: 1,
      },
      coverage: [
        {
          field: "campaignStatus",
          presentRows: 1,
          totalRows: 1,
          coveragePct: 100,
          status: "ready",
        },
      ],
    });

    const report = buildDataReadinessProbeReport(artifact);
    expect(validateDataReadinessProbeReport(report)).toContain(
      "critical_field_absent_from_artifact:spend24h",
    );
    expect(report.actions.find((entry) => entry.action === "fix_delivery")).toMatchObject({
      readinessStatus: "blocked",
      fieldsMissingFromArtifact: ["adsetStatus", "adStatus", "spend24h", "impressions24h"],
    });
  });

  it("fails strict validation when an unsupported coverage field appears", () => {
    const artifact = normalizeCoverageArtifact({
      contractVersion: "test",
      source: "fixture",
      readOnly: true,
      liveStatus: {
        attempted: false,
        source: "fixture",
        readOnly: true,
        rowCount: 1,
      },
      coverage: [
        {
          field: "unexpectedMetric",
          presentRows: 1,
          totalRows: 1,
          coveragePct: 100,
          status: "ready",
        },
        ...[
          "campaignStatus",
          "adsetStatus",
          "adStatus",
          "spend24h",
          "impressions24h",
          "reviewStatus",
          "effectiveStatus",
          "disapprovalReason",
          "limitedReason",
          "firstSeenAt",
          "firstSpendAt",
          "ctr",
          "cpm",
          "frequency",
          "dataFreshness",
          "targetSource",
          "benchmarkReliability",
        ].map((field) => ({
          field,
          presentRows: 1,
          totalRows: 1,
          coveragePct: 100,
          status: "ready",
        })),
      ],
    });

    const report = buildDataReadinessProbeReport(artifact);
    expect(report.unknownCoverageFields).toEqual(["unexpectedMetric"]);
    expect(validateDataReadinessProbeReport(report)).toContain(
      "unknown_coverage_field:unexpectedMetric",
    );
  });

  it("keeps action requirements aligned with data readiness documentation fields", () => {
    const requirements = Object.fromEntries(
      DATA_READINESS_ACTION_REQUIREMENTS.map((entry) => [entry.action, entry.requiredFields]),
    );

    expect(requirements).toMatchObject({
      fix_delivery: ["campaignStatus", "adsetStatus", "adStatus", "spend24h", "impressions24h"],
      fix_policy: ["reviewStatus", "effectiveStatus", "disapprovalReason", "limitedReason"],
      watch_launch: ["firstSeenAt", "firstSpendAt"],
      high_confidence_fatigue: ["ctr", "cpm", "frequency"],
      high_confidence_scale_cut: ["dataFreshness", "targetSource", "benchmarkReliability"],
    });
  });

  it("returns only readiness coverage fields for a requirement", () => {
    const artifact = loadDataReadinessCoverageArtifact();
    const result = evaluateActionReadiness(artifact, DATA_READINESS_ACTION_REQUIREMENTS[0]);

    expect(Object.keys(result).sort()).toEqual([
      "action",
      "coverageComplete",
      "description",
      "fieldCoverage",
      "fieldsMissingFromArtifact",
      "missingFields",
      "partialFields",
      "readinessStatus",
      "readyFields",
      "reason",
      "requiredFields",
    ]);
    expect(result.action).toBe("fix_delivery");
    expect(result.readinessStatus).toBe("blocked");
  });
});
