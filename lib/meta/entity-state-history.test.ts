import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMetaEntityStateHash,
  buildMetaObservationRunHash,
  normalizeMetaProviderUpdatedAt,
  persistMetaEntityObservation,
  readMetaCreativeLineageAsOf,
  readMetaEntityStatesAsOf,
  readMetaEntityTombstonesAsOf,
  readMetaEntityTruthAsOf,
  resolveMetaEntityObservedAt,
} from "@/lib/meta/entity-state-history";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const db = await import("@/lib/db");

function joinTemplate(strings: TemplateStringsArray, values: unknown[]) {
  return strings.reduce((statement, part, index) => {
    const value = index < values.length ? String(values[index]) : "";
    return `${statement}${part}${value}`;
  }, "");
}

function createSqlMock(rows: unknown[] = []) {
  const queries: string[] = [];
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(joinTemplate(strings, values));
      return rows;
    }),
    { query: vi.fn(), queries },
  );
  return sql;
}

function stateHashInput() {
  return {
    businessId: "biz_1",
    providerAccountId: "act_1",
    entityType: "adset" as const,
    entityId: "adset_1",
    campaignId: "campaign_1",
    adsetId: "adset_1",
    adId: null,
    creativeId: null,
    entityName: "Prospecting",
    configuredStatus: "ACTIVE",
    effectiveStatus: "ACTIVE",
    learningStatus: "LEARNING",
    learningSource: "inferred" as const,
    campaignDailyBudgetRaw: "10000",
    campaignLifetimeBudgetRaw: null,
    adsetDailyBudgetRaw: null,
    adsetLifetimeBudgetRaw: null,
    budgetCurrency: "USD",
    budgetOrigin: "campaign" as const,
    reviewStatus: null,
    policyStatus: null,
    policyReasons: null,
    providerUpdatedAt: "2026-07-12T02:50:00.000Z",
    presence: "present" as const,
    fieldCoverage: { status: true, budget: { campaign: true, adset: false } },
  };
}

describe("Meta entity state history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.runDbTransaction).mockImplementation(
      async (fn: () => Promise<unknown>) => fn(),
    );
  });

  it("uses provider update time when valid and response time otherwise", () => {
    expect(
      resolveMetaEntityObservedAt({
        providerUpdatedAt: "2026-07-10T03:00:00Z",
        responseObservedAt: "2026-07-12T03:00:00Z",
        capturedAt: "2026-07-12T03:00:01Z",
      }),
    ).toBe("2026-07-10T03:00:00.000Z");
    expect(
      resolveMetaEntityObservedAt({
        providerUpdatedAt: "2026-08-01T03:00:00Z",
        responseObservedAt: "2026-07-12T03:00:00Z",
        capturedAt: "2026-07-12T03:00:01Z",
      }),
    ).toBe("2026-07-12T03:00:00.000Z");
    expect(
      normalizeMetaProviderUpdatedAt(
        "not-a-date",
        "2026-07-12T03:00:01Z",
      ),
    ).toBeNull();
  });

  it("rejects failed collection receipts that try to persist entity state", async () => {
    await expect(
      persistMetaEntityObservation({
        businessId: "biz_1",
        providerAccountId: "act_1",
        entityType: "campaign",
        endpoint: "campaign_configs",
        observedAt: "2026-07-12T03:00:00Z",
        capturedAt: "2026-07-12T03:00:01Z",
        completeness: "failed",
        pageCount: 0,
        providerRowCount: 0,
        error: { kind: "http_failure" },
        states: [
          {
            ...stateHashInput(),
            entityType: "campaign",
            entityId: "campaign_1",
            campaignId: "campaign_1",
            adsetId: null,
            learningStatus: null,
            learningSource: "not_observed",
            budgetOrigin: "not_applicable",
            observedAt: "2026-07-12T03:00:00Z",
          },
        ],
      }),
    ).rejects.toThrow("Failed observations cannot persist state rows");
    expect(db.getDb).not.toHaveBeenCalled();
  });

  it("builds deterministic state hashes with sorted object keys", () => {
    const first = buildMetaEntityStateHash(stateHashInput());
    const second = buildMetaEntityStateHash({
      ...stateHashInput(),
      fieldCoverage: { budget: { adset: false, campaign: true }, status: true },
    });
    const changed = buildMetaEntityStateHash({
      ...stateHashInput(),
      effectiveStatus: "PAUSED",
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("binds observation identity and capture time into the run hash", () => {
    const base = {
      businessId: "biz_1",
      providerAccountId: "act_1",
      entityType: "campaign" as const,
      endpoint: "/campaigns",
      observedAt: "2026-07-12T03:00:00Z",
      capturedAt: "2026-07-12T03:00:02Z",
      completeness: "complete" as const,
      pageCount: 2,
      rowCount: 42,
      payloadHash: "a".repeat(64),
    };
    const first = buildMetaObservationRunHash(base);
    const second = buildMetaObservationRunHash({
      ...base,
      capturedAt: "2026-07-12T03:00:03Z",
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it("reads latest state with tenant, account and dual-time cutoff isolation", async () => {
    const sql = createSqlMock([
      {
        id: "state_1",
        run_id: "run_1",
        business_ref_id: "biz_ref_1",
        business_id: "biz_1",
        provider_account_ref_id: "account_ref_1",
        provider_account_id: "act_1",
        entity_type: "ad",
        entity_id: "ad_1",
        campaign_id: "campaign_1",
        adset_id: "adset_1",
        ad_id: "ad_1",
        creative_id: "creative_1",
        entity_name: "Ad one",
        configured_status: "ACTIVE",
        effective_status: "ACTIVE",
        learning_status: null,
        learning_source: "not_observed",
        campaign_daily_budget_raw: "10000",
        campaign_lifetime_budget_raw: null,
        adset_daily_budget_raw: null,
        adset_lifetime_budget_raw: null,
        budget_currency: "USD",
        budget_origin: "campaign",
        review_status: null,
        policy_status: null,
        policy_reasons_json: null,
        provider_updated_at: "2026-07-12T02:50:00.000Z",
        presence: "present",
        field_coverage_json: { status: true },
        observed_at: "2026-07-12T03:00:00.000Z",
        captured_at: "2026-07-12T03:00:02.000Z",
        run_completeness: "partial",
        state_hash: "b".repeat(64),
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await readMetaEntityStatesAsOf({
      businessId: "biz_1",
      providerAccountId: "act_1",
      entityType: "ad",
      entityIds: ["ad_1", "ad_1", ""],
      cutoff: "2026-07-12T04:00:00Z",
    });

    expect(rows[0]).toMatchObject({
      businessId: "biz_1",
      providerAccountId: "act_1",
      entityType: "ad",
      entityId: "ad_1",
      runCompleteness: "partial",
      stateHash: "b".repeat(64),
    });
    const query = sql.queries.join("\n");
    expect(query).toContain("business_id = biz_1");
    expect(query).toContain("provider_account_id = act_1");
    expect(query).toContain("entity_type = ad");
    expect(query).toContain("observed_at <= 2026-07-12T04:00:00.000Z");
    expect(query).toContain("captured_at <= 2026-07-12T04:00:00.000Z");
    expect(query).toContain(
      "run_completeness IN ('complete', 'partial', 'point_lookup')",
    );
  });

  it("reads only explicit tombstones and exposes the latest truth event", async () => {
    const tombstoneSql = createSqlMock([
      {
        id: "tombstone_1",
        run_id: "run_1",
        business_ref_id: "biz_ref_1",
        business_id: "biz_1",
        provider_account_ref_id: "account_ref_1",
        provider_account_id: "act_1",
        entity_type: "ad",
        entity_id: "ad_1",
        reason: "explicit_not_found",
        provider_evidence_json: { status: 404 },
        observed_at: "2026-07-12T03:00:00.000Z",
        captured_at: "2026-07-12T03:00:01.000Z",
        run_completeness: "point_lookup",
        tombstone_hash: "c".repeat(64),
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(tombstoneSql as never);

    const tombstones = await readMetaEntityTombstonesAsOf({
      businessId: "biz_1",
      providerAccountId: "act_1",
      entityType: "ad",
      cutoff: "2026-07-12T04:00:00Z",
    });
    expect(tombstones[0]).toMatchObject({
      reason: "explicit_not_found",
      runCompleteness: "point_lookup",
    });
    expect(tombstoneSql.queries.join("\n")).toContain(
      "reason IN ('explicit_deleted', 'explicit_not_found')",
    );

    const truthSql = createSqlMock([
      {
        event_kind: "tombstone",
        event_id: "tombstone_1",
        entity_id: "ad_1",
        observed_at: "2026-07-12T03:00:00.000Z",
        captured_at: "2026-07-12T03:00:01.000Z",
        evidence_hash: "c".repeat(64),
        tombstone_reason: "explicit_not_found",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(truthSql as never);
    const truth = await readMetaEntityTruthAsOf({
      businessId: "biz_1",
      providerAccountId: "act_1",
      entityType: "ad",
      cutoff: "2026-07-12T04:00:00Z",
    });
    expect(truth[0]).toMatchObject({
      eventKind: "tombstone",
      entityId: "ad_1",
      tombstoneReason: "explicit_not_found",
    });
    const truthQuery = truthSql.queries.join("\n");
    expect(truthQuery).toContain("UNION ALL");
    expect(truthQuery).toContain("(event_kind = 'tombstone') DESC");
  });

  it("scopes creative lineage to the account, cutoff and selected creative", async () => {
    const sql = createSqlMock([
      {
        id: "edge_1",
        business_ref_id: "biz_ref_1",
        business_id: "biz_1",
        provider_account_ref_id: "account_ref_1",
        provider_account_id: "act_1",
        source_ad_id: "ad_1",
        source_creative_id: "creative_1",
        target_ad_id: "ad_2",
        target_creative_id: "creative_1",
        lineage_type: "reuse_same_creative",
        evidence_source: "observation_run",
        observation_run_id: "run_1",
        observation_run_entity_type: "creative",
        observation_run_completeness: "complete",
        action_log_id: null,
        action_type: null,
        action_status: null,
        action_verified_at: null,
        evidence_json: { matchedCreativeId: true },
        observed_at: "2026-07-12T03:00:00.000Z",
        captured_at: "2026-07-12T03:00:01.000Z",
        lineage_hash: "d".repeat(64),
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const rows = await readMetaCreativeLineageAsOf({
      businessId: "biz_1",
      providerAccountId: "act_1",
      creativeId: "creative_1",
      cutoff: "2026-07-12T04:00:00Z",
      limit: 20,
    });

    expect(rows[0]).toMatchObject({
      lineageType: "reuse_same_creative",
      sourceCreativeId: "creative_1",
      targetCreativeId: "creative_1",
      observationRunEntityType: "creative",
      observationRunCompleteness: "complete",
      actionType: null,
      actionStatus: null,
      actionVerifiedAt: null,
    });
    const query = sql.queries.join("\n");
    expect(query).toContain("provider_account_id = act_1");
    expect(query).toContain(
      "source_creative_id = creative_1 OR target_creative_id = creative_1",
    );
    expect(query).toContain("LIMIT 20");
  });

  it("rejects invalid cutoff and limits before a DB query", async () => {
    const sql = createSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await expect(
      readMetaEntityStatesAsOf({
        businessId: "biz_1",
        providerAccountId: "act_1",
        entityType: "campaign",
        cutoff: "not-a-date",
      }),
    ).rejects.toThrow("cutoff must be a valid timestamp");
    await expect(
      readMetaCreativeLineageAsOf({
        businessId: "biz_1",
        providerAccountId: "act_1",
        cutoff: "2026-07-12T04:00:00Z",
        limit: 0,
      }),
    ).rejects.toThrow("limit must be a positive integer");
    expect(sql).not.toHaveBeenCalled();
  });
});
