import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildShadowReportProbeReport,
  loadShadowComparisonArtifact,
  loadShadowReportDoc,
  normalizeShadowComparisonArtifact,
  parseShadowReportDoc,
  validateShadowReportProbeReport,
} from "@/scripts/creative-decision-center/shadow-report-probe";
import type { ShadowComparisonRow } from "@/scripts/creative-decision-center/shadow-report-probe";

const baseRow: ShadowComparisonRow = {
  creativeId: "synthetic-1",
  creativeName: "Synthetic",
  familyId: "synthetic-family",
  beforePrimaryDecision: "keep_in_test",
  beforeOperatorBucket: "test_more",
  beforeUserLabel: "Test More",
  v2PrimaryDecision: "Test More",
  afterBuyerAction: "diagnose_data",
  afterProblemClass: "data_quality",
  afterActionability: "diagnose",
  afterPriorityBand: "medium",
  afterConfidenceBand: "low",
  topReasonTag: "synthetic_probe_fixture",
  missingData: [],
  decisionChanged: true,
  changeType: "fallback_due_to_missing_data",
  riskLevel: "medium",
  notes: "Synthetic test row.",
};

function makeSyntheticArtifact(
  rowOverrides: Partial<ShadowComparisonRow> = {},
  summaryOverrides: Record<string, unknown> = {},
) {
  return normalizeShadowComparisonArtifact({
    summary: {
      totalCreativesCompared: 1,
      unchangedDecisions: 0,
      saferMoreSpecific: 0,
      aggressiveChanges: 0,
      fallbackDueToMissingData: 1,
      conflictCount: 0,
      diagnoseDataRate: 100,
      highConfidenceRate: 0,
      top10Disagreements: [],
      ...summaryOverrides,
    },
    rows: [{ ...baseRow, ...rowOverrides }],
  });
}

describe("creative decision center shadow report probe", () => {
  it("reports fixture-only provenance and read-only safety for the generated shadow artifact", () => {
    const report = buildShadowReportProbeReport(
      loadShadowComparisonArtifact(),
      loadShadowReportDoc(),
    );

    expect(report.readOnly).toBe(true);
    expect(report.mutatesData).toBe(false);
    expect(report.sourceArtifact).toMatchObject({
      path: "docs/creative-decision-center/generated/before-after-shadow.json",
      readOnly: true,
      rowCount: 35,
      summaryTotal: 35,
    });
    expect(report.liveComparison).toMatchObject({
      status: "not_run",
      productionBehaviorChanged: false,
    });
    expect(validateShadowReportProbeReport(report)).toEqual([]);
  });

  it("keeps shadow summary values aligned with the checked-in report markdown", () => {
    const report = buildShadowReportProbeReport(
      loadShadowComparisonArtifact(),
      loadShadowReportDoc(),
    );

    expect(report.summary.rowCountMatchesSummary).toBe(true);
    expect(report.summary.artifact).toMatchObject({
      totalCreativesCompared: 35,
      unchangedDecisions: 2,
      saferMoreSpecific: 25,
      aggressiveChanges: 2,
      fallbackDueToMissingData: 3,
      conflictCount: 0,
      diagnoseDataRate: 22.86,
      highConfidenceRate: 22.86,
    });
    expect(report.summaryParity).toMatchObject({
      docsMatchArtifact: true,
      differences: [],
      unsupportedDocSummaryLabels: ["Less aggressive"],
      nonZeroUnsupportedDocSummaryLabels: [],
    });
  });

  it("fails strict validation when a doc-only summary label becomes non-zero", () => {
    const artifact = makeSyntheticArtifact();
    const parsedDoc = parseShadowReportDoc(`
## Live Status

| Item | Value |
|---|---:|
| Live snapshot comparison | Not run |
| Production behavior changed | No |

## Shadow Summary

| Metric | Value |
|---|---:|
| Total creatives compared | 1 |
| Less aggressive | 2 |
`);
    const report = buildShadowReportProbeReport(artifact, parsedDoc);

    expect(report.summaryParity.unsupportedDocSummaryLabels).toEqual(["Less aggressive"]);
    expect(report.summaryParity.nonZeroUnsupportedDocSummaryLabels).toEqual([
      { label: "Less aggressive", value: 2 },
    ]);
    expect(validateShadowReportProbeReport(report)).toContain(
      "non_zero_unsupported_doc_summary_label:Less aggressive:2",
    );
  });

  it("keeps the allowed artifact conflict and invariant checks clean", () => {
    const report = buildShadowReportProbeReport(
      loadShadowComparisonArtifact(),
      loadShadowReportDoc(),
    );

    expect(Object.fromEntries(report.dangerousConflicts.map((entry) => [entry.name, entry.count])))
      .toMatchObject({
        before_scale_or_protect_after_cut: 0,
        before_cut_or_kill_after_scale: 0,
      });
    expect(Object.fromEntries(report.invariantViolations.map((entry) => [entry.name, entry.count])))
      .toMatchObject({
        row_level_brief_variation: 0,
        high_confidence_with_missing_data: 0,
      });
  });

  it("fails strict validation for synthetic row-level brief variation and high confidence with missing data", () => {
    const artifact = makeSyntheticArtifact({
      afterBuyerAction: "brief_variation",
      afterConfidenceBand: "high",
      missingData: ["benchmarkReliability"],
    });
    const report = buildShadowReportProbeReport(artifact, null);

    expect(validateShadowReportProbeReport(report)).toEqual(
      expect.arrayContaining([
        "row_level_brief_variation:1",
        "high_confidence_with_missing_data:1",
      ]),
    );
  });

  it("fails strict validation for synthetic dangerous before and after conflicts", () => {
    const beforeScaleArtifact = makeSyntheticArtifact({
      beforePrimaryDecision: "scale_hard",
      beforeOperatorBucket: "scale",
      afterBuyerAction: "cut",
    });
    const beforeCutArtifact = makeSyntheticArtifact({
      beforePrimaryDecision: "cut_now",
      beforeOperatorBucket: "cut",
      afterBuyerAction: "scale",
    });

    expect(
      validateShadowReportProbeReport(buildShadowReportProbeReport(beforeScaleArtifact, null)),
    ).toContain("before_scale_or_protect_after_cut:1");
    expect(
      validateShadowReportProbeReport(buildShadowReportProbeReport(beforeCutArtifact, null)),
    ).toContain("before_cut_or_kill_after_scale:1");
  });

  it("fails strict validation when the artifact summary no longer matches row count", () => {
    const artifact = makeSyntheticArtifact({}, { totalCreativesCompared: 2 });
    const report = buildShadowReportProbeReport(artifact, null);

    expect(report.summary.rowCountMatchesSummary).toBe(false);
    expect(validateShadowReportProbeReport(report)).toContain("row_count_summary_mismatch");
  });

  it("parses the report markdown live status and summary without using runtime code", () => {
    const markdown = readFileSync(
      "docs/creative-decision-center/03-before-after-shadow-report.md",
      "utf8",
    );
    const parsed = parseShadowReportDoc(markdown);

    expect(parsed).toMatchObject({
      liveComparisonStatus: "not_run",
      productionBehaviorChanged: false,
      summary: {
        totalCreativesCompared: 35,
        conflictCount: 0,
        highConfidenceRate: 22.86,
      },
    });
  });

  it("does not import or call decision-engine or write-path APIs", () => {
    const source = readFileSync(
      "scripts/creative-decision-center/shadow-report-probe.ts",
      "utf8",
    );

    expect(source).not.toMatch(
      /decideCreative|finalizeDecision|enforceHardActionEligibility|applyCreativeCampaignLabelGuard|DecisionOutput|DecisionLabel|GateContext|AccountDecisionProfile|CreativeInput/,
    );
    expect(source).not.toMatch(
      /writeFile|appendFile|createWriteStream|mkdir|rmSync|unlinkSync|copyFileSync|fetch\(|http\.|https\.|process\.env\.DATABASE_URL|getDb|drizzle|new Pool|postgres/,
    );
    expect(source).not.toMatch(/from "@\/lib|from "@\/app|from "@\/components/);
  });
});
