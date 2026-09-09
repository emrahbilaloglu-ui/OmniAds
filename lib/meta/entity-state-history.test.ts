import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  META_FIELD_COVERAGE_SCHEDULE_INVALID,
  buildMetaEntityStateHash,
  buildMetaObservationRunHash,
  normalizeMetaEntityStateSchedule,
  normalizeMetaProviderUpdatedAt,
  normalizeMetaScheduleTimestamp,
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
    {
      // Parameterised form. The lineage as-of read is parameterised because it
      // deduplicates on logical identity, and a template-only mock would make
      // that read silently return nothing.
      query: vi.fn(async (text: string, params?: unknown[]) => {
        queries.push(text);
        void params;
        return rows;
      }),
      queries,
    },
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

  /*
    PR #272 review — `budget_shape_support` was mapped but never selected.

    The row type declared it, `toMetaEntityState` read `row.budget_shape_support`
    and the writers persisted it, but NEITHER projection branch of `stateSelect`
    asked for the column. Every read through `readMetaEntityStatesAsOf`
    therefore reported `budgetShapeSupport: undefined` no matter what the
    account actually held — a stored "unsupported_shape" read as "we never
    looked". Both branches are asserted here because only one of them was
    exercised by the case above.
  */
  it("selects budget_shape_support in the explicit-entityIds projection", async () => {
    const sql = createSqlMock([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await readMetaEntityStatesAsOf({
      businessId: "biz_1",
      providerAccountId: "act_1",
      entityType: "campaign",
      entityIds: ["campaign_1"],
      cutoff: "2026-07-12T04:00:00Z",
    });

    const query = sql.queries.join("\n");
    expect(query).toContain("budget_shape_support");
    // The branch under test, not the other one.
    expect(query).toContain("entity_id = ANY(");
  });

  it("selects budget_shape_support in the all-entities projection", async () => {
    const sql = createSqlMock([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    await readMetaEntityStatesAsOf({
      businessId: "biz_1",
      providerAccountId: "act_1",
      entityType: "campaign",
      entityIds: [],
      cutoff: "2026-07-12T04:00:00Z",
    });

    const query = sql.queries.join("\n");
    expect(query).toContain("budget_shape_support");
    expect(query).not.toContain("entity_id = ANY(");
  });

  it.each(["supported", "unsupported_shape"] as const)(
    "maps a non-null %s row through to the public budgetShapeSupport field",
    async (stored) => {
      const sql = createSqlMock([
        {
          id: "state_1",
          run_id: "run_1",
          business_ref_id: "biz_ref_1",
          business_id: "biz_1",
          provider_account_ref_id: "account_ref_1",
          provider_account_id: "act_1",
          entity_type: "campaign",
          entity_id: "campaign_1",
          campaign_id: "campaign_1",
          adset_id: null,
          ad_id: null,
          creative_id: null,
          entity_name: "Campaign one",
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
          budget_currency_exponent: 2,
          budget_currency_registry_version: "iso4217.minor-units.2026-09-01",
          budget_shape_support: stored,
          review_status: null,
          policy_status: null,
          policy_reasons_json: null,
          provider_updated_at: "2026-07-12T02:50:00.000Z",
          presence: "present",
          field_coverage_json: { status: true },
          observed_at: "2026-07-12T03:00:00.000Z",
          captured_at: "2026-07-12T03:00:02.000Z",
          run_completeness: "complete",
          state_hash: "d".repeat(64),
        },
      ]);
      vi.mocked(db.getDb).mockReturnValue(sql as never);

      const rows = await readMetaEntityStatesAsOf({
        businessId: "biz_1",
        providerAccountId: "act_1",
        entityType: "campaign",
        entityIds: ["campaign_1"],
        cutoff: "2026-07-12T04:00:00Z",
      });

      expect(rows[0]?.budgetShapeSupport).toBe(stored);
      // Lossless: the value is carried, not re-derived from anything else.
      expect(rows[0]?.budgetShapeSupport).not.toBeNull();
      expect(rows[0]?.budgetShapeSupport).not.toBeUndefined();
    },
  );

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
    // Parameterised now, so identity is asserted on the predicate shape and the
    // bound values rather than on interpolated text.
    expect(query).toContain("provider_account_id = $2");
    expect(query).toContain(
      "source_creative_id = $3 OR target_creative_id = $3",
    );
    expect(sql.query.mock.calls[0]?.[1]).toEqual([
      "biz_1",
      "act_1",
      "creative_1",
      "2026-07-12T04:00:00.000Z",
      20,
    ]);
    // The logical-identity dedupe. ~3.27 GB of this table is the same fact
    // recorded once per observation, and the collapse pass deliberately deletes
    // nothing — so a reader that returns them all reports one relationship
    // dozens of times and spends its LIMIT on a single fact.
    expect(query).toContain("DISTINCT ON");
    expect(query).toContain("lineage_type, source_ad_id, source_creative_id");
    // The OLDEST observation of each fact survives: lineage records when a
    // relationship was first seen.
    expect(query).toContain(
      "COALESCE(relationship_observed_at, observed_at) ASC",
    );
    // The EFFECTIVE observation instant, not the run's. An edge recorded on a
    // coalesced run carries that run's clocks for the foreign key's sake, so a
    // cutoff read on `observed_at` alone reveals a relationship at the kept
    // run's t1 that was not observed until t2.
    expect(query).toContain(
      "COALESCE(relationship_observed_at, observed_at) <= $4::timestamptz",
    );
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

/**
 * The schedule mapper, at the grain where the decision is actually taken.
 *
 * These are the pure half of the D083 Correction 3 contract: which of the three
 * nulls a value produces, and whether the hash agrees with the row it will be
 * stored beside. The other half — that an invalid value does NOT abort the
 * observation, and does NOT inherit the prior value through the carry lateral —
 * is decided by PostgreSQL and is proven in
 * `lib/meta/schedule-timestamp-normalization.db.test.ts`.
 */
describe("Meta schedule timestamp normalization", () => {
  function scheduleState(campaignStartTime: unknown) {
    return {
      ...stateHashInput(),
      entityType: "campaign" as const,
      entityId: "campaign_1",
      campaignId: "campaign_1",
      adsetId: null,
      campaignStartTime: campaignStartTime as string | null,
      campaignEndTime: null,
      fieldCoverage: { campaignStartTime: true, campaignEndTime: false },
    };
  }

  it("normalizes a valid provider timestamp to a canonical instant", () => {
    expect(
      normalizeMetaScheduleTimestamp("2026-09-07T10:00:00+0300"),
    ).toEqual({ outcome: "normalized", value: "2026-09-07T07:00:00.000Z" });
    // Already canonical: the same instant, unchanged.
    expect(
      normalizeMetaScheduleTimestamp("2026-09-07T07:00:00.000Z"),
    ).toEqual({ outcome: "normalized", value: "2026-09-07T07:00:00.000Z" });
  });

  it.each([
    "2026-02-30T00:00:00Z",
    "2026-02-29T00:00:00+0000",
    "2026-04-31T10:00:00+0300",
    "2026-09-07T10:00:00",
    "2026-09-07",
    "September 7, 2026",
    "2026-09-07T24:00:00Z",
    "2026-09-07T10:00:00+2400",
    "2026-09-07T10:00:00+03:60",
  ])("holds the schedule as unknown for invalid literal %s", (raw) => {
    expect(normalizeMetaScheduleTimestamp(raw)).toEqual({
      outcome: "invalid",
      value: null,
      reason: "unparsable",
    });
    const normalized = normalizeMetaEntityStateSchedule(scheduleState(raw));
    expect(normalized.campaignStartTime).toBeNull();
    expect(normalized.fieldCoverage.campaignStartTime).toBe(
      META_FIELD_COVERAGE_SCHEDULE_INVALID,
    );
    expect(buildMetaEntityStateHash(normalized)).not.toBe(
      buildMetaEntityStateHash(scheduleState(null)),
    );
  });

  it.each([
    ["2024-02-29T10:00:00+0000", "2024-02-29T10:00:00.000Z"],
    ["2026-09-07T10:00:00-0430", "2026-09-07T14:30:00.000Z"],
    ["2026-09-07T10:00:00+03:00", "2026-09-07T07:00:00.000Z"],
  ])("preserves a valid explicit provider offset %s", (raw, canonical) => {
    expect(normalizeMetaScheduleTimestamp(raw)).toEqual({
      outcome: "normalized",
      value: canonical,
    });
    const normalized = normalizeMetaEntityStateSchedule(scheduleState(raw));
    expect(normalized.fieldCoverage.campaignStartTime).toBe(true);
    expect(buildMetaEntityStateHash(normalized)).toBe(
      buildMetaEntityStateHash(scheduleState(canonical)),
    );
  });

  it("classifies every unusable provider value as an explicit unknown", () => {
    // An invalid string. PostgreSQL answers 'invalid input syntax for type
    // timestamp with time zone' and aborts the whole observation transaction.
    expect(normalizeMetaScheduleTimestamp("not-a-date")).toEqual({
      outcome: "invalid",
      value: null,
      reason: "unparsable",
    });
    // An empty string. Also a PostgreSQL error, not a null -- so it is a value
    // that arrived and cannot be written, never a measured absence.
    expect(normalizeMetaScheduleTimestamp("")).toEqual({
      outcome: "invalid",
      value: null,
      reason: "blank",
    });
    expect(normalizeMetaScheduleTimestamp("   ")).toEqual({
      outcome: "invalid",
      value: null,
      reason: "blank",
    });
    // An out-of-range date. PostgreSQL ACCEPTS the raw '99999-01-01', which is
    // the trap: JavaScript canonicalizes it to an expanded-year ISO string and
    // PostgreSQL refuses that form with 'time zone displacement out of range'.
    // The exact instant depends on the process timezone, but the expanded-year
    // shape and the normalizer's refusal do not.
    expect(new Date("99999-01-01").toISOString()).toMatch(
      /^\+\d{6}-\d{2}-\d{2}T/,
    );
    expect(normalizeMetaScheduleTimestamp("99999-01-01")).toEqual({
      outcome: "invalid",
      value: null,
      reason: "unrepresentable",
    });
  });

  it("separates a null the provider omitted from one it answered badly", () => {
    expect(normalizeMetaScheduleTimestamp(null)).toEqual({
      outcome: "absent",
      value: null,
    });
    expect(normalizeMetaScheduleTimestamp(undefined)).toEqual({
      outcome: "absent",
      value: null,
    });
    // A measured absence keeps whatever the mapper measured, and the input
    // object comes back untouched -- the contract for the common path.
    const measured = scheduleState(null);
    expect(normalizeMetaEntityStateSchedule(measured)).toBe(measured);
    expect(measured.fieldCoverage).toEqual({
      campaignStartTime: true,
      campaignEndTime: false,
    });
    // A value that arrived and cannot be written is NOT that. It produces a
    // different state, and it must not be handed back as the caller wrote it.
    const answered = scheduleState("not-a-date");
    const decided = normalizeMetaEntityStateSchedule(answered);
    expect(decided).not.toBe(answered);
    expect(decided.campaignStartTime).toBeNull();
    expect(answered.campaignStartTime).toBe("not-a-date");
  });

  it("keeps the three nulls distinct and never collapses them", () => {
    // Case 3 -- asked, answered, unusable.
    const invalid = normalizeMetaEntityStateSchedule(
      scheduleState("not-a-date"),
    );
    expect(invalid.campaignStartTime).toBeNull();
    expect(invalid.fieldCoverage.campaignStartTime).toBe(
      META_FIELD_COVERAGE_SCHEDULE_INVALID,
    );
    // Case 1 -- measured absence, untouched beside it.
    expect(invalid.fieldCoverage.campaignEndTime).toBe(false);
    // Case 2 -- not asked. The marker lib/api/meta.ts writes when the edge
    // refused the field survives normalization, because a null under it is
    // ABSENT rather than invalid. If this ever became invalid_not_retained the
    // read-side carry lateral would stop restoring the last observed schedule.
    const degraded = normalizeMetaEntityStateSchedule({
      ...scheduleState(null),
      fieldCoverage: { campaignStartTime: "degraded_not_observed" },
    });
    expect(degraded.fieldCoverage.campaignStartTime).toBe(
      "degraded_not_observed",
    );
    // ...and the three markers are three different values.
    expect(META_FIELD_COVERAGE_SCHEDULE_INVALID).not.toBe(
      "degraded_not_observed",
    );
    expect(META_FIELD_COVERAGE_SCHEDULE_INVALID).not.toBe(false);
  });

  it("is idempotent, so the hash and the persist path cannot disagree", () => {
    const once = normalizeMetaEntityStateSchedule(scheduleState("not-a-date"));
    const twice = normalizeMetaEntityStateSchedule(once);
    // Second pass sees a null, calls it absent, and leaves the marker standing.
    expect(twice).toBe(once);
    expect(twice.fieldCoverage.campaignStartTime).toBe(
      META_FIELD_COVERAGE_SCHEDULE_INVALID,
    );
    const normalized = normalizeMetaEntityStateSchedule(
      scheduleState("2026-09-07T10:00:00+0300"),
    );
    expect(normalized.campaignStartTime).toBe("2026-09-07T07:00:00.000Z");
    expect(normalizeMetaEntityStateSchedule(normalized)).toBe(normalized);
  });

  it("hashes the normalized row, not the raw provider string", () => {
    // The row is written from the normalized state and the hash is computed
    // from it, so the two must agree by construction. Same instant, two
    // spellings, one hash.
    expect(buildMetaEntityStateHash(scheduleState("2026-09-07T10:00:00+0300")))
      .toBe(
        buildMetaEntityStateHash(scheduleState("2026-09-07T07:00:00.000Z")),
      );
    // An explicit unknown is not the same state as the value it replaced, and
    // it is not the same state as a measured absence either -- otherwise the
    // delta writer would dedupe the unknown away against the last known value
    // and the row would never be appended at all.
    const known = buildMetaEntityStateHash(
      scheduleState("2026-09-07T07:00:00.000Z"),
    );
    const unknown = buildMetaEntityStateHash(scheduleState("not-a-date"));
    const absent = buildMetaEntityStateHash(scheduleState(null));
    expect(unknown).not.toBe(known);
    expect(unknown).not.toBe(absent);
  });

  it("moves the hash on the known -> invalid -> known transition", () => {
    const first = buildMetaEntityStateHash(
      scheduleState("2026-09-07T07:00:00.000Z"),
    );
    const broken = buildMetaEntityStateHash(scheduleState("not-a-date"));
    const restored = buildMetaEntityStateHash(
      scheduleState("2026-09-07T07:00:00.000Z"),
    );
    expect(broken).not.toBe(first);
    // The middle state is an EXPLICIT UNKNOWN, so its hash is the hash of the
    // row that will be stored -- null column, invalid marker -- and not the
    // hash of the raw string it arrived as. That agreement is what makes the
    // stored row and its stored hash describe the same values.
    expect(broken).toBe(
      buildMetaEntityStateHash({
        ...scheduleState(null),
        fieldCoverage: {
          campaignStartTime: META_FIELD_COVERAGE_SCHEDULE_INVALID,
          campaignEndTime: false,
        },
      }),
    );
    // Back to the same known value is back to the same state. The middle row
    // is a real appended observation, not a permanent demotion.
    expect(restored).toBe(first);
  });
});
