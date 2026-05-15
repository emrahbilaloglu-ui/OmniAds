import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendMetaDecisionActionOutcomeLog,
  readMetaDecisionActionOutcomeLogs,
  readMetaDecisionActionOutcomeLogsForRecommendationTypes,
} from "@/lib/meta/decision-outcomes";
import * as db from "@/lib/db";
import * as schemaReadiness from "@/lib/db-schema-readiness";
import * as providerRefs from "@/lib/provider-account-reference-store";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn(async () => undefined),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  ensureProviderAccountReferenceIds: vi.fn(async () => new Map([["act_1", "provider-ref-1"]])),
  resolveBusinessReferenceIds: vi.fn(async () => new Map([["biz_1", "business-ref-1"]])),
}));

describe("Meta decision outcome storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends outcome logs with canonical business and provider refs", async () => {
    const calls: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      calls.push(strings.join(" "));
      return [{ id: "outcome-1" }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const id = await appendMetaDecisionActionOutcomeLog({
      businessId: "biz_1",
      providerAccountId: "act_1",
      recommendationFingerprint: "fingerprint-1",
      recId: "rec-1",
      recType: "adset_scale_budget",
      decisionLabel: "scale",
      decisionFamily: "scale",
      actionType: "outcome",
      outcomeStatus: "positive",
      summary: "CPA held after budget increase.",
      payloadJson: { cpa_delta_pct: -0.12 },
      occurredAt: "2026-05-15T10:00:00.000Z",
    });

    expect(id).toBe("outcome-1");
    expect(schemaReadiness.assertDbSchemaReady).toHaveBeenCalledWith({
      tables: ["meta_decision_action_outcome_logs"],
      context: "meta_decision_outcome_storage",
    });
    expect(providerRefs.resolveBusinessReferenceIds).toHaveBeenCalledWith(["biz_1"]);
    expect(providerRefs.ensureProviderAccountReferenceIds).toHaveBeenCalledWith({
      provider: "meta",
      accounts: [{ externalAccountId: "act_1" }],
    });
    const query = calls.join("\n");
    expect(query).toContain("INSERT INTO meta_decision_action_outcome_logs");
    expect(query).toContain("business_ref_id");
    expect(query).toContain("provider_account_ref_id");
    expect(query).toContain("recommendation_fingerprint");
    expect(query).toContain("payload_json");
  });

  it("reads logs by recommendation fingerprint or rec id with a bounded limit", async () => {
    const calls: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      calls.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await readMetaDecisionActionOutcomeLogs({
      businessId: "biz_1",
      providerAccountId: "act_1",
      recommendationFingerprint: "fingerprint-1",
      recId: "rec-1",
      limit: 999,
    });

    const query = calls.join("\n");
    expect(query).toContain("FROM meta_decision_action_outcome_logs");
    expect(query).toContain("recommendation_fingerprint =");
    expect(query).toContain("rec_id =");
    expect(sql.mock.calls.at(-1)?.at(-1)).toBe(500);
  });

  it("reads outcome logs for recommendation types only", async () => {
    const calls: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      calls.push(strings.join(" "));
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await readMetaDecisionActionOutcomeLogsForRecommendationTypes({
      businessId: "biz_1",
      recTypes: ["adset_scale_budget", "adset_scale_budget", "adset_cut_spend"],
      limit: 50,
    });

    const query = calls.join("\n");
    expect(query).toContain("FROM meta_decision_action_outcome_logs");
    expect(query).toContain("action_type = 'outcome'");
    expect(query).toContain("rec_type = ANY(");
    expect(sql.mock.calls.at(-1)?.at(-2)).toEqual(["adset_scale_budget", "adset_cut_spend"]);
    expect(sql.mock.calls.at(-1)?.at(-1)).toBe(50);
  });
});
