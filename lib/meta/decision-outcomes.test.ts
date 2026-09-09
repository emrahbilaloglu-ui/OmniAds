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
  /*
    ROUND 22, ITEM 1: the bindings view of the same store. `refIds` is what the
    id-only helper returns; `timezones` is what the binding actually holds
    afterwards, which writers now stamp their rows from. Mocked here as the
    identity of what was passed, because these suites are not about the binding
    rule -- lib/provider-account-timezone-authority.db.test.ts proves that
    against a real PostgreSQL.
  */
  ensureProviderAccountReferenceBindings: vi.fn(
    async ({
      accounts,
    }: {
      accounts: Array<{ externalAccountId: string; timezone?: string | null }>;
    }) => ({
      refIds: new Map(
        accounts.map(
          (account) =>
            [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const,
        ),
      ),
      timezones: new Map(
        accounts
          .filter((account) => (account.timezone ?? "").trim().length > 0)
          .map((account) => [account.externalAccountId, String(account.timezone)] as const),
      ),
    }),
  ),
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
      // ROUND 9 ITEM 6: both are required now — an unscoped read pooled every
      // account and every day into one confidence signal.
      providerAccountId: "act_1",
      occurredBefore: new Date("2026-09-06T07:00:00.000Z"),
      recTypes: ["adset_scale_budget", "adset_scale_budget", "adset_cut_spend"],
      limit: 50,
    });

    const query = calls.join("\n");
    /*
      ROUND 9 ITEM 6. The account filter was `null matches everything` and there
      was NO temporal filter, so a request for one account and one window was
      answered with every account's outcomes and with outcomes recorded after
      the window. Both are now unconditional predicates.
    */
    expect(query).toContain("outcome_log.provider_account_id =");
    expect(query).not.toContain("::text IS NULL OR outcome_log.provider_account_id");
    /*
      ROUND 10 ITEM 4. The bound is an absolute `timestamptz`, not
      `(date + 1)` — that form is cast using the DB SESSION timezone, so the
      end of "the served day" moved with the connection rather than with the
      advertiser.
    */
    expect(query).toContain("outcome_log.occurred_at <");
    expect(query).toContain("::timestamptz");
    expect(query).not.toContain("::date + 1");
    // The EFFECTIVE time, never the insertion time.
    expect(query).not.toContain("outcome_log.created_at <");
    expect(query).toContain("FROM meta_decision_action_outcome_logs");
    expect(query).toContain("action_type = 'outcome'");
    expect(query).toContain("rec_type = ANY(");
    expect(query).toContain("FROM meta_ads_action_log action_log");
    expect(query).toContain("AS treatment_receipt_validated");
    expect(query).toContain("FALSE AS causal_assignment_validated");
    expect(query).toContain("FALSE AS causal_estimate_validated");
    expect(query).toContain("action_log.status = 'success'");
    expect(query).toContain("action_log.verified_at IS NOT NULL");
    expect(query).toContain(
      "COALESCE(action_log.payload_request->>'dry_run', 'false') = 'false'",
    );
    expect(sql.mock.calls.at(-1)?.at(-2)).toEqual(["adset_scale_budget", "adset_cut_spend"]);
    expect(sql.mock.calls.at(-1)?.at(-1)).toBe(50);
  });
});

describe("an unusable scope reads nothing at all", () => {
  it.each([
    [
      "an empty account",
      {
        providerAccountId: "",
        occurredBefore: new Date("2026-09-06T07:00:00.000Z"),
      },
    ],
    [
      "an unresolvable window",
      { providerAccountId: "act_1", occurredBefore: new Date(Number.NaN) },
    ],
  ])("returns no rows on %s", async (_name, scope) => {
    const sql = vi.fn(async () => []);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await readMetaDecisionActionOutcomeLogsForRecommendationTypes({
      businessId: "biz_1",
      recTypes: ["adset_scale_budget"],
      ...scope,
    });

    expect(rows).toEqual([]);
    // A scope this call cannot establish must not become a wider query.
    expect(sql).not.toHaveBeenCalled();
  });
});
