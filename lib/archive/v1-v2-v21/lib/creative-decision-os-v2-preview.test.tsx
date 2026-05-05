import React from "react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CreativeDecisionOsV2PreviewSurface } from "@/components/creatives/CreativeDecisionOsV2PreviewSurface";
import {
  CREATIVE_DECISION_OS_V2_PREVIEW_CONTRACT_VERSION,
  CREATIVE_DECISION_OS_V2_PREVIEW_FORBIDDEN_BUTTON_TEXT,
  CREATIVE_DECISION_OS_V2_PREVIEW_FORBIDDEN_INTERNAL_TEXT,
  buildCreativeDecisionOsV2PreviewSurfaceModel,
  type CreativeDecisionOsV2PreviewPayload,
  type CreativeDecisionOsV2PreviewRow,
  type CreativeDecisionOsV2PreviewSourceRow,
} from "@/lib/creative-decision-os-v2-preview";
import liveAudit from "@/docs/operator-policy/creative-segmentation-recovery/reports/v2-live-audit-2026-04-26/live-audit-sanitized.json";

const sourceRows = liveAudit.rows as CreativeDecisionOsV2PreviewSourceRow[];
const surface = buildCreativeDecisionOsV2PreviewSurfaceModel(sourceRows);
const preview: CreativeDecisionOsV2PreviewPayload = {
  contractVersion: CREATIVE_DECISION_OS_V2_PREVIEW_CONTRACT_VERSION,
  generatedAt: "2026-04-26T12:00:00.000Z",
  sourceDecisionOsGeneratedAt: "2026-04-26T11:00:00.000Z",
  businessId: "sanitized-business",
  rowCount: surface.rows.length,
  surface,
};

const requiredForbiddenButtonTerms = [
  "Auto-*",
  "Push live",
  "Push to review queue",
  "Apply",
  "Queue",
  "Scale now",
  "Cut now",
  "Approve",
  "Product-ready",
];

const contractV011Expectations = {
  version: "v0.1.1",
  laneLabels: [
    "Today Priority / Buyer Command Strip",
    "Ready for Buyer Confirmation",
    "Buyer Review",
    "Diagnose First",
    "Inactive Review",
  ],
  forbiddenButtonLanguage: requiredForbiddenButtonTerms,
  safetyInvariants: {
    commandCenter: "Do not create Command Center work items from v2 preview",
    queueApply: "Disabled for all v2 preview rows",
    v1DecisionOs: "Do not replace the current v1 creativeDecisionOs object",
  },
};

const readablePreviewFiles = [
  "app/(dashboard)/creatives/page.tsx",
  "app/(dashboard)/creatives/page.test.tsx",
  "app/api/creatives/decision-os-v2/preview/route.ts",
  "app/api/creatives/decision-os-v2/preview/route.test.ts",
  "components/creatives/CreativeDecisionOsV2PreviewSurface.tsx",
  "docs/operator-policy/creative-segmentation-recovery/reports/v2-readonly-ui-preview-2026-04-26/FOR_CHATGPT_REVIEW.md",
  "lib/creative-decision-os-v2-preview.ts",
  "lib/creative-decision-os-v2-preview.test.tsx",
  "src/services/data-service-ai.ts",
];

const activePreviewCodeFiles = readablePreviewFiles.filter((file) => /\.(tsx?|jsx?)$/.test(file));

function bucket(id: string) {
  const found = surface.buckets.find((item) => item.id === id);
  if (!found) throw new Error(`Missing bucket: ${id}`);
  return found;
}

function sourceRow(
  overrides: Partial<CreativeDecisionOsV2PreviewSourceRow>,
): CreativeDecisionOsV2PreviewSourceRow {
  const rowId = overrides.rowId ?? "row";
  return {
    rowId,
    creativeId: overrides.creativeId ?? rowId,
    campaignId: null,
    adSetId: null,
    currentDecision: null,
    v2PrimaryDecision: overrides.v2PrimaryDecision ?? "Protect",
    v2Actionability: overrides.v2Actionability ?? "review_only",
    v2Confidence: overrides.v2Confidence ?? 65,
    v2ReasonTags: overrides.v2ReasonTags ?? ["stable_read"],
    v2EvidenceSummary: overrides.v2EvidenceSummary ?? "Sanitized evidence summary.",
    v2RiskLevel: overrides.v2RiskLevel ?? "low",
    v2ProblemClass: overrides.v2ProblemClass ?? "creative",
    v2QueueEligible: false,
    v2ApplyEligible: false,
    v2BlockerReasons: overrides.v2BlockerReasons ?? [],
    spend: overrides.spend ?? 100,
    purchases: overrides.purchases ?? 2,
    impressions: overrides.impressions ?? 1000,
    roas: overrides.roas ?? 1.5,
    cpa: overrides.cpa ?? 20,
    recentRoas: overrides.recentRoas ?? 1.4,
    recentPurchases: overrides.recentPurchases ?? 1,
    longWindowRoas: overrides.longWindowRoas ?? 1.3,
    activeBenchmarkRoas: overrides.activeBenchmarkRoas ?? 1.2,
    activeBenchmarkCpa: overrides.activeBenchmarkCpa ?? 25,
    peerMedianSpend: overrides.peerMedianSpend ?? 200,
    activeStatus: overrides.activeStatus ?? true,
    campaignStatus: overrides.campaignStatus ?? "ACTIVE",
    adSetStatus: overrides.adSetStatus ?? "ACTIVE",
    campaignAdsetBlockerFlags: overrides.campaignAdsetBlockerFlags ?? [],
    trustSourceProvenanceFlags: overrides.trustSourceProvenanceFlags ?? [],
    changedFromCurrent: overrides.changedFromCurrent ?? false,
  };
}

function previewFromRows(
  rows: CreativeDecisionOsV2PreviewSourceRow[],
): CreativeDecisionOsV2PreviewPayload {
  const customSurface = buildCreativeDecisionOsV2PreviewSurfaceModel(rows);
  return {
    contractVersion: CREATIVE_DECISION_OS_V2_PREVIEW_CONTRACT_VERSION,
    generatedAt: "2026-04-27T12:00:00.000Z",
    sourceDecisionOsGeneratedAt: "2026-04-27T11:00:00.000Z",
    businessId: "sanitized-business",
    rowCount: customSurface.rows.length,
    surface: customSurface,
  };
}

describe("Creative Decision OS v2 preview surface model", () => {
  it("routes Scale, high-spend Cut, and active Refresh rows into Today Priority", () => {
    const todayPriority = bucket("today_priority");
    const scaleRow = surface.rows.find((row) => row.primaryDecision === "Scale");
    const highSpendCut = surface.rows
      .filter((row) => row.primaryDecision === "Cut")
      .sort((a, b) => (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0))[0];
    const activeRefresh = surface.rows
      .filter((row) => row.primaryDecision === "Refresh" && row.activeStatus === true)
      .sort((a, b) => (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0))[0];

    expect(scaleRow).toBeDefined();
    expect(highSpendCut).toBeDefined();
    expect(activeRefresh).toBeDefined();
    expect(todayPriority.rowIds).toContain(scaleRow?.rowId);
    expect(todayPriority.rowIds).toContain(highSpendCut?.rowId);
    expect(todayPriority.rowIds).toContain(activeRefresh?.rowId);
  });

  it("keeps Diagnose and inactive rows collapsed by default", () => {
    expect(bucket("diagnose_first").collapsedByDefault).toBe(true);
    expect(bucket("inactive_review").collapsedByDefault).toBe(true);
    expect(bucket("diagnose_first").rowIds.length).toBeGreaterThan(100);
    expect(bucket("inactive_review").rowIds.length).toBeGreaterThan(0);
  });

  it("sorts buyer urgency above confidence-only direct rows", () => {
    const todayPriorityRows = bucket("today_priority")
      .rowIds.map((rowId) => surface.rows.find((row) => row.rowId === rowId))
      .filter((row): row is CreativeDecisionOsV2PreviewRow => Boolean(row));
    const directRows = bucket("ready_for_buyer_confirmation")
      .rowIds.map((rowId) => surface.rows.find((row) => row.rowId === rowId))
      .filter((row): row is CreativeDecisionOsV2PreviewRow => Boolean(row));
    const scaleIndex = todayPriorityRows.findIndex((row) => row.primaryDecision === "Scale");
    const cutIndex = todayPriorityRows.findIndex((row) => row.primaryDecision === "Cut");

    expect(directRows.length).toBe(2);
    expect(scaleIndex).toBeGreaterThanOrEqual(0);
    expect(cutIndex).toBeGreaterThanOrEqual(0);
    expect(todayPriorityRows[0]?.primaryDecision).not.toBe("Protect");
    expect(todayPriorityRows[0]?.primaryDecision).not.toBe("Test More");
  });

  it("keeps review-only Scale and high-spend Cut above direct confirmation rows", () => {
    const deterministicSurface = buildCreativeDecisionOsV2PreviewSurfaceModel([
      sourceRow({
        rowId: "review-scale",
        v2PrimaryDecision: "Scale",
        v2Actionability: "review_only",
        v2RiskLevel: "medium",
        spend: 900,
        peerMedianSpend: 300,
      }),
      sourceRow({
        rowId: "high-spend-cut",
        v2PrimaryDecision: "Cut",
        v2Actionability: "review_only",
        v2RiskLevel: "high",
        spend: 4000,
        peerMedianSpend: 500,
      }),
      sourceRow({
        rowId: "direct-protect",
        v2PrimaryDecision: "Protect",
        v2Actionability: "direct",
        v2RiskLevel: "low",
        spend: 250,
        peerMedianSpend: 250,
      }),
      sourceRow({
        rowId: "direct-test-more",
        v2PrimaryDecision: "Test More",
        v2Actionability: "direct",
        v2RiskLevel: "low",
        spend: 300,
        peerMedianSpend: 250,
      }),
    ]);

    expect(
      deterministicSurface.buckets.find((item) => item.id === "today_priority")?.rowIds,
    ).toEqual(["high-spend-cut", "review-scale"]);
    expect(
      deterministicSurface.buckets.find((item) => item.id === "ready_for_buyer_confirmation")
        ?.rowIds,
    ).toEqual(["direct-test-more", "direct-protect"]);
    expect(
      deterministicSurface.buckets.find((item) => item.id === "diagnose_first")?.rowIds,
    ).toEqual([]);
  });

  it("keeps direct rows in confirmation unless they separately qualify for urgency", () => {
    const deterministicSurface = buildCreativeDecisionOsV2PreviewSurfaceModel([
      sourceRow({
        rowId: "direct-protect-default",
        v2PrimaryDecision: "Protect",
        v2Actionability: "direct",
        v2RiskLevel: "low",
        changedFromCurrent: false,
        spend: 250,
        peerMedianSpend: 250,
      }),
      sourceRow({
        rowId: "direct-test-more-default",
        v2PrimaryDecision: "Test More",
        v2Actionability: "direct",
        v2RiskLevel: "low",
        changedFromCurrent: false,
        spend: 300,
        peerMedianSpend: 250,
      }),
      sourceRow({
        rowId: "direct-cut-urgent",
        v2PrimaryDecision: "Cut",
        v2Actionability: "direct",
        v2RiskLevel: "high",
        spend: 3_000,
        peerMedianSpend: 400,
      }),
    ]);
    const todayPriority =
      deterministicSurface.buckets.find((item) => item.id === "today_priority")?.rowIds ?? [];
    const ready =
      deterministicSurface.buckets.find((item) => item.id === "ready_for_buyer_confirmation")
        ?.rowIds ?? [];

    expect(ready).toEqual([
      "direct-cut-urgent",
      "direct-test-more-default",
      "direct-protect-default",
    ]);
    expect(todayPriority).toEqual(["direct-cut-urgent"]);
    expect(todayPriority).not.toContain("direct-protect-default");
    expect(todayPriority).not.toContain("direct-test-more-default");
  });

  it("keeps Diagnose rows out of buyer confirmation and action-looking lanes", () => {
    const deterministicSurface = buildCreativeDecisionOsV2PreviewSurfaceModel([
      sourceRow({
        rowId: "diagnose-data-quality",
        v2PrimaryDecision: "Diagnose",
        v2Actionability: "diagnose",
        v2RiskLevel: "medium",
        v2ProblemClass: "data-quality",
        v2BlockerReasons: ["missing_source_evidence"],
      }),
      sourceRow({
        rowId: "direct-protect",
        v2PrimaryDecision: "Protect",
        v2Actionability: "direct",
      }),
    ]);

    expect(
      deterministicSurface.buckets.find((item) => item.id === "diagnose_first")?.rowIds,
    ).toEqual(["diagnose-data-quality"]);
    expect(
      deterministicSurface.buckets.find((item) => item.id === "ready_for_buyer_confirmation")
        ?.rowIds,
    ).toEqual(["direct-protect"]);
    expect(
      deterministicSurface.buckets.find((item) => item.id === "today_priority")?.rowIds,
    ).toEqual([]);
  });

  it("keeps v2 safety invariants visible in the preview model", () => {
    expect(surface.rows.some((row) => row.primaryDecision === ("Watch" as never))).toBe(false);
    expect(surface.rows.some((row) => row.primaryDecision === ("Scale Review" as never))).toBe(
      false,
    );
    expect(surface.rows.some((row) => row.queueEligible)).toBe(false);
    expect(surface.rows.some((row) => row.applyEligible)).toBe(false);
    expect(
      surface.rows.some((row) => row.primaryDecision === "Scale" && row.actionability === "direct"),
    ).toBe(false);
    expect(
      surface.rows.some((row) => row.primaryDecision === "Scale" && row.activeStatus === false),
    ).toBe(false);
  });
});

describe("CreativeDecisionOsV2PreviewSurface", () => {
  it("keeps required contract-forbidden terms in the rendered-output scan", () => {
    const missingTerms = requiredForbiddenButtonTerms.filter(
      (term) =>
        !CREATIVE_DECISION_OS_V2_PREVIEW_FORBIDDEN_BUTTON_TEXT.some((pattern) =>
          pattern.test(term),
        ),
    );

    expect(missingTerms).toEqual([]);
  });

  it("keeps the rendered safety model aligned with the PR79 v0.1.1 contract", () => {
    expect(contractV011Expectations.version).toBe("v0.1.1");
    expect(CREATIVE_DECISION_OS_V2_PREVIEW_CONTRACT_VERSION).toBe(
      "creative-decision-os-v2-preview.v0.1.1",
    );

    const laneLabels = surface.buckets.map((item) => item.label);
    for (const label of contractV011Expectations.laneLabels) {
      expect(laneLabels).toContain(label);
    }

    const missingForbiddenTerms = contractV011Expectations.forbiddenButtonLanguage.filter(
      (term) =>
        !CREATIVE_DECISION_OS_V2_PREVIEW_FORBIDDEN_BUTTON_TEXT.some((pattern) =>
          pattern.test(term),
        ),
    );
    expect(missingForbiddenTerms).toEqual([]);
    expect(surface.rows.some((row) => row.queueEligible || row.applyEligible)).toBe(false);
    expect(contractV011Expectations.safetyInvariants.commandCenter).toContain("Do not create");
    expect(contractV011Expectations.safetyInvariants.queueApply).toContain("Disabled");
    expect(contractV011Expectations.safetyInvariants.v1DecisionOs).toContain("Do not replace");
  });

  it("renders safe read-only text without forbidden button or internal artifact terms", () => {
    const html = renderToStaticMarkup(
      <CreativeDecisionOsV2PreviewSurface preview={preview} onOpenRow={() => undefined} />,
    );

    expect(html).toContain("Today Priority / Buyer Command Strip");
    expect(html).toContain("Ready for Buyer Confirmation");
    expect(html).toContain("Diagnose First");
    expect(html).not.toContain("Watch");
    expect(html).not.toContain("Scale Review");

    const violations = [
      ...CREATIVE_DECISION_OS_V2_PREVIEW_FORBIDDEN_BUTTON_TEXT,
      ...CREATIVE_DECISION_OS_V2_PREVIEW_FORBIDDEN_INTERNAL_TEXT,
      /labels this row/i,
      /JSON labels/i,
    ].filter((term) => term.test(html));
    expect(violations).toEqual([]);
  });

  it("explains the strict scale-ready count when no Scale row clears the evidence bar", () => {
    const noScalePreview = previewFromRows([
      sourceRow({
        rowId: "promising-protect",
        v2PrimaryDecision: "Protect",
        v2Actionability: "review_only",
        v2EvidenceSummary: "Strong long-window read, but recent evidence is not strong enough.",
      }),
      sourceRow({
        rowId: "test-more",
        v2PrimaryDecision: "Test More",
        v2Actionability: "review_only",
      }),
    ]);
    const html = renderToStaticMarkup(
      <CreativeDecisionOsV2PreviewSurface preview={noScalePreview} />,
    );

    expect(html).toContain("Scale-ready");
    expect(html).not.toContain("Scale-worthy");
    expect(html).toContain("No scale-ready creative cleared the evidence bar yet.");
    expect(html).toContain(
      "Promising creatives may still appear under Protect, Test More, or Today Priority",
    );
  });

  it("keeps Diagnose separate from buyer confirmation and avoids a no-op aggregate action", () => {
    const diagnosePreview = previewFromRows([
      sourceRow({
        rowId: "diagnose-row",
        v2PrimaryDecision: "Diagnose",
        v2Actionability: "diagnose",
        v2ProblemClass: "data-quality",
        v2BlockerReasons: ["missing_source_evidence"],
      }),
    ]);
    const html = renderToStaticMarkup(
      <CreativeDecisionOsV2PreviewSurface preview={diagnosePreview} />,
    );

    expect(html).toContain("Ready for Buyer Confirmation");
    expect(html).toContain("No direct confirmation candidates in this workspace.");
    expect(html).not.toMatch(/Apply|Queue|Push|Auto|Scale now|Cut now|Approve|Product-ready/i);
    expect(html).toContain(
      "Needs investigation before buyer action. This is not buyer confirmation.",
    );
    expect(html).toContain("Needs investigation before buyer action");
    expect(html).not.toMatch(/<button[^>]*>\s*<svg[\s\S]*?Investigate\s*<\/button>/);
  });

  it("renders distinct lane markers for priority, confirmation, review, investigation, and inactive sections", () => {
    const lanePreview = previewFromRows([
      sourceRow({
        rowId: "priority-cut",
        v2PrimaryDecision: "Cut",
        v2Actionability: "review_only",
        v2RiskLevel: "high",
        spend: 4000,
        peerMedianSpend: 500,
      }),
      sourceRow({
        rowId: "direct-protect",
        v2PrimaryDecision: "Protect",
        v2Actionability: "direct",
      }),
      sourceRow({
        rowId: "review-refresh",
        v2PrimaryDecision: "Refresh",
        v2Actionability: "review_only",
      }),
      sourceRow({
        rowId: "diagnose-row",
        v2PrimaryDecision: "Diagnose",
        v2Actionability: "diagnose",
        v2ProblemClass: "data-quality",
        v2BlockerReasons: ["missing_source_evidence"],
      }),
      sourceRow({
        rowId: "inactive-row",
        v2PrimaryDecision: "Refresh",
        v2Actionability: "review_only",
        activeStatus: false,
        campaignStatus: "PAUSED",
      }),
    ]);
    const html = renderToStaticMarkup(<CreativeDecisionOsV2PreviewSurface preview={lanePreview} />);

    expect(html).toContain("Highest urgency");
    expect(html).toContain("Review lanes");
    expect(html).toContain("Confirmation lane");
    expect(html).toContain("Decision review");
    expect(html).toContain("Investigation lane");
    expect(html).toContain("Muted lane");
    expect(html).toContain("border-l-emerald-500");
    expect(html).toContain("border-l-amber-500");
    expect(html).toContain("border-l-slate-400");
  });

  it("keeps the preview component read-only without DB, Meta, or Command Center wiring", () => {
    const source = readFileSync(
      "components/creatives/CreativeDecisionOsV2PreviewSurface.tsx",
      "utf8",
    );

    expect(source).not.toMatch(/@\/lib\/db|@\/lib\/meta|command-center/i);
    expect(source).not.toMatch(/\bfetch\s*\(|\bsql`|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  });
});

describe("Creative Decision OS v2 preview file hygiene", () => {
  it("keeps new preview source, test, and report files readable", () => {
    const compressedFiles = readablePreviewFiles.filter((file) => {
      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/).length;

      return text.length > 4000 && lines < 40;
    });

    expect(compressedFiles).toEqual([]);
  });

  it("keeps active preview code files from collapsing into generated-looking single-line output", () => {
    const unreadableFiles = activePreviewCodeFiles.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      const maxLineLength = Math.max(...lines.map((line) => line.length));
      const minExpectedLines = Math.ceil(text.length / 350);
      const isCompressed = text.length > 4000 && lines.length < Math.max(40, minExpectedLines);
      const hasHugeLine = maxLineLength > 200;

      return isCompressed || hasHugeLine
        ? [
            {
              file,
              lineCount: lines.length,
              maxLineLength,
              minExpectedLines,
            },
          ]
        : [];
    });

    expect(unreadableFiles).toEqual([]);
  });
});
