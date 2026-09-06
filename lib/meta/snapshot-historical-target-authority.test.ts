import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
  assertDbSchemaReady: vi.fn(async () => ({ ready: true })),
}));
vi.mock("@/lib/business-commercial", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/business-commercial")>();
  return { ...actual, getBusinessCommercialTruthSnapshot: vi.fn() };
});
vi.mock("@/lib/creative-decision-engine/campaign-context/source", () => ({
  resolveCampaignContextMode: vi.fn(() => "automatic"),
  readCampaignContextLabelMap: vi.fn(async () => new Map([
    ["campaign-1", {
      kind: "main", contextTrust: "high", inferenceConfidenceClass: "high",
      resolverAuthorityValidated: true, provenance: { source: "system_inferred" },
    }],
  ])),
}));
vi.mock("@/lib/meta/empirical-outcome-integration", () => ({
  attachMetaEmpiricalOutcomeSummariesFromLogs: vi.fn(async (input) => input.recommendations),
}));
vi.mock("@/lib/meta/anomalies", () => ({
  readMetaAnomaliesForBusiness: vi.fn(async () => ({ anomalies: [] })),
}));
vi.mock("@/lib/meta/automation-control-plane", () => ({
  resolveEffectiveMetaModes: vi.fn(async () => null),
}));

import * as db from "@/lib/db";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import { readLatestMetaDecisionSnapshot } from "@/lib/meta/snapshot";
import { buildMetaDailyBrief } from "@/lib/meta/daily-brief";

const BUSINESS = "d8a30000-0000-4000-8000-0000000000b1";
const SNAPSHOT_DAY = "2026-09-03";
const CEILING = "2026-09-05";
const historyCalls: Array<{ text: string; params: unknown[] }> = [];
let historyRows: Record<string, unknown>[];
let historyError: Error | null;
let snapshotRows: Record<string, unknown>[];

function currentTarget(targetRoas: number | null) {
  vi.mocked(getBusinessCommercialTruthSnapshot).mockResolvedValue({
    targetPack: { targetRoas, updatedAt: "2026-09-05T02:00:00.000Z" },
    sectionMeta: { targetPack: { freshness: {
      status: "fresh", updatedAt: "2026-09-05T02:00:00.000Z",
    } } },
  } as Awaited<ReturnType<typeof getBusinessCommercialTruthSnapshot>>);
}

function read(snapshotDateCeiling: string | null = CEILING) {
  return readLatestMetaDecisionSnapshot({
    businessId: BUSINESS, providerAccountId: "act_1",
    startDate: "2026-09-01", endDate: CEILING, snapshotDateCeiling,
  });
}

// The snapshot reader, commercial normalization, action guard, target history
// reader and daily brief are real. Only storage and unrelated enrichments are
// replaced, so a historical read accidentally using current targets changes
// both the served action and the brief's actionable count.
beforeEach(() => {
  vi.clearAllMocks();
  historyCalls.length = 0;
  historyError = null;
  historyRows = [{
    target_roas: 2.2, target_cpa: null, aov_assumption: null,
    updated_at: "2026-09-03T02:00:00.000Z", operation: "upsert",
  }];
  snapshotRows = [{
    scope_type: "campaign", scope_id: "campaign-1", business_id: BUSINESS,
    snapshot_date: SNAPSHOT_DAY, rec_id: "scale-1", rec_type: "scale_for_volume",
    level: "campaign", decision_state: "act", confidence_score: 0.9,
    recommended_action: "Increase the budget", reasoning: "Mature scale signal",
    engine_version: "v1", created_at: "2026-09-03T03:00:00.000Z",
    decision_label: "scale", evidence: { items: [] }, target_value: 10,
  }];
  currentTarget(null);
  const query = async (text: string, params: unknown[] = []) => {
    if (text.includes("FROM meta_decision_snapshots_daily") && text.includes("WITH latest AS")) {
      return snapshotRows;
    }
    if (text.includes("FROM business_target_pack_history")) {
      historyCalls.push({ text, params });
      if (historyError) throw historyError;
      return historyRows;
    }
    return [];
  };
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...params: unknown[]) => query(
      strings.reduce((text, part, i) => text + part + (i < params.length ? `$${i + 1}` : ""), ""),
      params,
    ),
    { query },
  );
  vi.mocked(db.getDb).mockReturnValue(sql as ReturnType<typeof db.getDb>);
});

describe("historical snapshot commercial authority", () => {
  it("preserves a past ROAS-only action after the current target was removed", async () => {
    const result = await read();
    expect(result?.recommendations[0]).toMatchObject({ decisionState: "act", targetValue: 10 });
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
    expect(historyCalls).toHaveLength(1);
    // Use the selected snapshot, not the later ceiling or metric end date.
    expect(historyCalls[0].params).toEqual([
      BUSINESS, `${SNAPSHOT_DAY}T03:00:00.000Z`, `${SNAPSHOT_DAY}T03:00:00.000Z`,
    ]);
    expect(historyCalls[0].text).toContain("effective_at <= $2::timestamptz");
    expect(historyCalls[0].text).toContain("recorded_at <= $3::timestamptz");
  });

  it("keeps the historical daily brief's actionable count after current target removal", async () => {
    const result = await buildMetaDailyBrief({
      businessId: BUSINESS, providerAccountId: "act_1", asOf: CEILING,
    });
    expect(result.decisions.actionable).toBe(1);
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
    expect(historyCalls[0].params[1]).toBe(`${SNAPSHOT_DAY}T03:00:00.000Z`);
  });

  it("keeps current target authority for an uncapped read with a past metric range", async () => {
    expect((await read(null))?.recommendations[0].decisionState).toBe("watch");
    currentTarget(4.5);
    expect((await read(null))?.recommendations[0].decisionState).toBe("act");
    expect(getBusinessCommercialTruthSnapshot).toHaveBeenCalledTimes(2);
    expect(historyCalls).toEqual([]);
  });

  it.each(["absent", "deleted"])("withholds a past action for %s history even if a current ROAS exists", async (state) => {
    currentTarget(4.5);
    historyRows = state === "absent" ? [] : [{ ...historyRows[0], operation: "delete" }];
    const rec = (await read())?.recommendations[0];
    expect(rec).toMatchObject({
      decisionState: "watch", signalQuality: { hard_action_blocker: "commercial_target_missing" },
    });
    expect(rec?.targetValue).toBeUndefined();
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
  });

  it("withholds on a history read error and recovers using history without a current-target fallback", async () => {
    currentTarget(4.5);
    historyError = new Error("transient history read failure");
    expect((await read())?.recommendations[0]).toMatchObject({
      decisionState: "watch", signalQuality: { hard_action_blocker: "commercial_target_missing" },
    });
    historyError = null;
    expect((await read())?.recommendations[0].decisionState).toBe("act");
    expect(historyCalls).toHaveLength(2);
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
  });

  it("keeps invalid historical target provenance fail-closed", async () => {
    currentTarget(4.5);
    historyRows[0].updated_at = null;
    expect((await read())?.recommendations[0]).toMatchObject({
      decisionState: "watch", signalQuality: { hard_action_blocker: "commercial_target_unknown" },
    });
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
  });

  it("does not read target authority when no snapshot exists at the ceiling", async () => {
    snapshotRows = [];
    expect(await read()).toBeNull();
    expect(historyCalls).toEqual([]);
    expect(getBusinessCommercialTruthSnapshot).not.toHaveBeenCalled();
  });
});
