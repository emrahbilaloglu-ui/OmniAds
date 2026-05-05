import { describe, expect, it } from "vitest";
import {
  buildCreativeDecisionCenterV21Snapshot,
  buildValidatedCreativeDecisionCenterV21Snapshot,
  emptyCreativeDecisionCenterActionBoard,
} from "@/lib/creative-decision-center/snapshot-builder";
import { validateDecisionCenterSnapshot } from "@/lib/creative-decision-center/validators";
import type { CreativeDecisionOsSnapshot } from "@/lib/creative-decision-os-snapshots";

function snapshot(
  overrides: Partial<CreativeDecisionOsSnapshot> = {},
): CreativeDecisionOsSnapshot {
  return {
    snapshotId: "snap_1",
    surface: "creative",
    businessId: "biz",
    scope: {
      analysisScope: "account",
      analysisScopeId: null,
      analysisScopeLabel: "Account-wide",
      benchmarkScope: "account",
      benchmarkScopeId: null,
      benchmarkScopeLabel: "Account-wide",
    },
    decisionAsOf: "2026-04-30",
    generatedAt: "2026-04-30T00:00:00.000Z",
    generatedBy: null,
    sourceWindow: {
      analyticsStartDate: null,
      analyticsEndDate: null,
      reportingStartDate: null,
      reportingEndDate: null,
      decisionWindowStartDate: null,
      decisionWindowEndDate: null,
      decisionWindowLabel: null,
    },
    versions: {
      operatorDecisionVersion: "creative-decision-os.v1",
      policyVersion: null,
      instructionVersion: null,
    },
    inputHash: null,
    evidenceHash: null,
    summaryCounts: {},
    status: "ready",
    error: null,
    payload: {
      contractVersion: "creative-decision-os.v1",
      engineVersion: "creative-decision-os.v1",
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      decisionAsOf: "2026-04-30",
      analyticsWindow: {
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        role: "analysis_only",
      },
      decisionWindows: {
        primary30d: {
          key: "primary30d",
          label: "primary 30d",
          startDate: "2026-04-01",
          endDate: "2026-04-30",
          days: 30,
          role: "decision_authority",
        },
      },
      creatives: [{ creativeId: "creative_1" }],
      summary: { totalCreatives: 1 },
    } as never,
    ...overrides,
  };
}

describe("Creative Decision Center V2.1 empty snapshot builder", () => {
  it("builds a valid empty additive decisionCenter snapshot", () => {
    const decisionCenter = buildCreativeDecisionCenterV21Snapshot({
      snapshot: snapshot(),
      generatedAt: "2026-04-30T01:00:00.000Z",
    });

    expect(decisionCenter.contractVersion).toBe("creative-decision-center.v2.1");
    expect(decisionCenter.generatedAt).toBe("2026-04-30T01:00:00.000Z");
    expect(decisionCenter.inputCoverageSummary.totalCreatives).toBe(1);
    expect(decisionCenter.rowDecisions).toEqual([]);
    expect(decisionCenter.aggregateDecisions).toEqual([]);
    expect(decisionCenter.todayBrief).toEqual([]);
    expect(decisionCenter.actionBoard).toEqual(emptyCreativeDecisionCenterActionBoard());
    expect(validateDecisionCenterSnapshot(decisionCenter)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("builds validated row decisions when live rows are enabled", () => {
    const decisionCenter = buildCreativeDecisionCenterV21Snapshot({
      snapshot: snapshot({
        payload: {
          contractVersion: "creative-decision-os.v1",
          engineVersion: "creative-decision-os.v1",
          businessId: "biz",
          startDate: "2026-04-01",
          endDate: "2026-04-30",
          generatedAt: "2026-04-30T00:00:00.000Z",
          decisionAsOf: "2026-04-30",
          analyticsWindow: { startDate: "2026-04-01", endDate: "2026-04-30", role: "analysis_only" },
          decisionWindows: {
            primary30d: {
              key: "primary30d",
              label: "primary 30d",
              startDate: "2026-04-01",
              endDate: "2026-04-30",
              days: 30,
              role: "decision_authority",
            },
          },
          summary: { totalCreatives: 1 },
          commercialTruthCoverage: {
            missingInputs: [],
            configuredSections: { targetPack: true },
          },
          creatives: [
            {
              creativeId: "creative_scale",
              familyId: "family_1",
              creativeAgeDays: 20,
              spend: 1600,
              purchases: 8,
              impressions: 20000,
              roas: 1.7,
              cpa: 35,
              ctr: 1.2,
              decisionSignals: [],
              primaryAction: "promote_to_scaling",
              benchmarkReliability: "medium",
              relativeBaseline: { medianSpend: 500, weightedRoas: 1, weightedCpa: 50 },
              benchmark: {
                metrics: {
                  roas: { benchmark: 1 },
                  cpa: { benchmark: 50 },
                },
              },
              economics: { targetRoas: 1, targetCpa: 50 },
              fatigue: { status: "none" },
              deliveryContext: {
                activeDelivery: true,
                pausedDelivery: false,
                campaignStatus: "ACTIVE",
                adSetStatus: "ACTIVE",
              },
              trust: {},
            },
          ],
          families: [
            {
              familyId: "family_1",
              provenance: { confidence: "medium" },
            },
          ],
          supplyPlan: [
            {
              familyId: "family_1",
              priority: "medium",
              creativeIds: ["creative_scale"],
              summary: "Create a backup variation.",
              reasons: ["Winner needs a backup."],
            },
          ],
        } as never,
      }),
      generatedAt: "2026-04-30T01:00:00.000Z",
      enableRows: true,
    });

    expect(decisionCenter.rowDecisions).toHaveLength(1);
    expect(decisionCenter.rowDecisions[0]?.buyerAction).toBe("scale");
    expect(decisionCenter.actionBoard.scale).toEqual(["creative_scale"]);
    expect(decisionCenter.aggregateDecisions[0]?.action).toBe("brief_variation");
    expect(decisionCenter.todayBrief.length).toBeGreaterThan(0);
    expect(validateDecisionCenterSnapshot(decisionCenter)).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("fails open to null when there is no ready legacy snapshot", () => {
    expect(
      buildValidatedCreativeDecisionCenterV21Snapshot({ snapshot: null }),
    ).toBeNull();
    expect(
      buildValidatedCreativeDecisionCenterV21Snapshot({
        snapshot: snapshot({ status: "error", payload: null }),
      }),
    ).toBeNull();
  });
});
