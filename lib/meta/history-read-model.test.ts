import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const db = await import("@/lib/db");
const {
  META_HISTORY_READ_SQL,
  buildMetaHistoryReadSql,
  readMetaHistoryAccounts,
  readMetaHistoryJournal,
  redactMetaHistoryDetail,
} = await import("@/lib/meta/history-read-model");
const { decodeMetaHistoryCursor } = await import("@/lib/meta/history-contract");
const { toHistoryPage } = await import("@/lib/zero-base/meta/history-adapter");

const queryMock = vi.fn();

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    source_key: "meta_ads_action_log",
    source_id: "log_1",
    source_id_kind: "persisted_uuid",
    kind: "writes",
    occurred_at: "2026-07-10T10:00:00.000Z",
    title: "Pause | Summer ad",
    summary: null,
    entity_type: "ad",
    entity_id: "ad_1",
    entity_name: "Summer ad",
    label: "cut",
    status_raw: "verified_success",
    actor_id: "user_1",
    actor_name: "Operator",
    actor_availability: "available",
    account_scope_basis: "exact_entity_key",
    attribution: "provider_write_log",
    correlation_status: "keyed",
    correlation_key: "rec_1",
    correlation_reason: null,
    replay_date: "2026-07-10",
    engine_version: "meta-v1",
    detail_json: {
      request: {
        access_token: "secret-token",
        endpoint: "/ad_1?access_token=secret-token",
      },
      verification: { status: "PAUSED" },
    },
    ...overrides,
  };
}

const baseQuery = {
  businessId: "business_1",
  providerAccountId: "act_1",
  kind: null,
  entity: null,
  label: null,
  outcome: null,
  from: null,
  to: null,
  q: null,
  cursor: null,
  limit: 2,
} as const;

describe("Meta History read model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.getDb).mockReturnValue({ query: queryMock } as never);
  });

  it("reads only assigned Meta accounts and preserves unknown currency", async () => {
    queryMock.mockResolvedValueOnce([
      { id: "act_1", name: "Primary", currency: "eur", timezone: "Europe/Berlin" },
      { id: "act_2", name: null, currency: null, timezone: null },
    ]);

    await expect(readMetaHistoryAccounts("business_1")).resolves.toEqual([
      { id: "act_1", name: "Primary", currency: "EUR", timezone: "Europe/Berlin" },
      { id: "act_2", name: null, currency: null, timezone: null },
    ]);
    expect(queryMock.mock.calls[0]?.[1]).toEqual(["business_1"]);
  });

  it("returns typed entries, redacts payload secrets, and emits the next tuple cursor", async () => {
    queryMock.mockResolvedValue([
      historyRow(),
      historyRow({
        source_key: "engine_v3_decision_events",
        source_id: "event_1",
        kind: "label_flips",
        occurred_at: "2026-07-09T10:00:00.000Z",
        title: "Decision changed",
        entity_type: "creative",
        entity_id: "creative_1",
        entity_name: "Hook test",
        label: "scale",
        status_raw: "recorded",
        actor_id: null,
        actor_name: null,
        actor_availability: "not_applicable",
        account_scope_basis: "unique_creative_key",
        attribution: "engine_transition",
        correlation_key: "snapshot_1",
        replay_date: "2026-07-09",
        engine_version: "v3-test",
        detail_json: { previousLabel: "keep", currentLabel: "scale" },
      }),
      historyRow({
        source_id: "log_older",
        occurred_at: "2026-07-08T10:00:00.000Z",
      }),
    ]);

    const payload = await readMetaHistoryJournal({
      query: baseQuery,
      account: { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    });

    expect(payload.mode).toBe("read_only");
    expect(payload.scope).toMatchObject({
      businessId: "business_1",
      providerAccountId: "act_1",
      currency: "EUR",
    });
    expect(payload.entries).toHaveLength(2);
    expect(payload.page).toMatchObject({ returned: 2, total: null });
    expect(payload.entries[0]).toMatchObject({
      id: "meta_ads_action_log:log_1",
      status: "verified_success",
      identity: { canonicalDecisionId: null, sourceId: "log_1" },
      correlation: { status: "keyed", key: "rec_1" },
    });
    expect(payload.entries[0]?.detail).toMatchObject({
      request: {
        access_token: "[redacted]",
        endpoint: "/ad_1?access_token=[redacted]",
      },
    });
    expect(payload.identityContract.grouping).toBe("persisted_source_rows");
    expect(payload.identityContract.canonicalDecisionIdAvailable).toBe(false);
    expect(payload.page.nextCursor).toBeTruthy();
    expect(decodeMetaHistoryCursor(payload.page.nextCursor as string)).toEqual({
      occurredAt: "2026-07-09T10:00:00.000Z",
      source: "engine_v3_decision_events",
      sourceId: "event_1",
    });
    expect(queryMock.mock.calls[0]?.[1]).toEqual([
      "business_1",
      "act_1",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      3,
      // No outcome filter selected: the predicate is fully disabled rather
      // than defaulting to a group, so an unrecognised status stays visible.
      null,
      false,
      // The slice floor. The read starts bounded and widens only if the page
      // comes back short, so a full page never scans the whole journal.
      expect.any(String),
    ]);
  });

  it("keeps source provenance while the History adapter removes storage vocabulary", async () => {
    queryMock.mockResolvedValue([
      historyRow({
        source_key: "engine_v3_decision_outcomes_daily",
        source_id: "outcome_1",
        kind: "outcomes",
        title: "7-day outcome",
        summary: "Persisted correlational outcome for keep.",
        entity_type: "creative",
        entity_id: "creative_1",
        entity_name: "Summer video",
        label: "keep",
        status_raw: "positive",
        actor_id: null,
        actor_name: null,
        actor_availability: "not_applicable",
        account_scope_basis: "unique_creative_key",
        attribution: "correlational_outcome",
        correlation_status: "keyed",
        correlation_key: "snapshot_1",
      }),
      historyRow({
        source_key: "engine_v3_decision_events",
        source_id: "event_1",
        kind: "label_flips",
        title: "Data Disabled",
        summary: "Transition persisted after nightly evaluation.",
        entity_type: "creative",
        entity_id: "creative_2",
        entity_name: "Hook test",
        label: null,
        status_raw: "recorded",
        actor_id: null,
        actor_name: null,
        actor_availability: "not_applicable",
        account_scope_basis: "unique_creative_key",
        attribution: "engine_transition",
        correlation_status: "unavailable",
        correlation_key: null,
      }),
      historyRow({
        source_key: "meta_decision_action_outcome_logs",
        source_id: "action_outcome_1",
        kind: "writes",
        title: "Rollback",
        summary: "Writer stage completed normally.",
        entity_type: "ad",
        entity_id: "ad_1",
        entity_name: "Summer ad",
        label: null,
        status_raw: "verified_success",
        actor_id: null,
        actor_name: null,
        actor_availability: "not_applicable",
        account_scope_basis: "exact_entity_key",
        attribution: "provider_write_log",
        correlation_status: "keyed",
        correlation_key: "rec_1",
      }),
      historyRow({
        source_id: "older_log",
        occurred_at: "2026-07-08T10:00:00.000Z",
      }),
    ]);

    const payload = await readMetaHistoryJournal({
      query: { ...baseQuery, limit: 3 },
      account: { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    });
    const page = toHistoryPage(payload);

    expect(payload.entries.map((item) => item.provenance.source)).toEqual([
      "engine_v3_decision_outcomes_daily",
      "engine_v3_decision_events",
      "meta_decision_action_outcome_logs",
    ]);
    expect(page.rows.map(({ action, summary }) => ({ action, summary }))).toEqual([
      {
        action: "7-day outcome | Summer video",
        summary: "Performance outcome recorded for this recommendation.",
      },
      {
        action: "Decision data unavailable | Hook test",
        summary: null,
      },
      {
        action: "Change verified | Summer ad",
        summary: null,
      },
    ]);
  });

  it("keeps workflow and provider-attempt rows emitted by the SQL contract", async () => {
    queryMock.mockResolvedValue([
      historyRow({
        source_key: "decision_workflow_events",
        source_id: "workflow_1",
        kind: "decisions",
        title: "Workflow acknowledge",
        summary: "seasonal_expected",
        entity_type: "recommendation",
        entity_id: "ad:ad_1",
        entity_name: null,
        label: "acknowledged",
        status_raw: "recorded",
        actor_id: "user_1",
        actor_name: "Operator",
        actor_availability: "available",
        account_scope_basis: "direct_provider_account_id",
        attribution: "workflow_object",
        correlation_status: "unavailable",
        correlation_key: null,
        replay_date: null,
        engine_version: null,
      }),
      historyRow({
        source_key: "meta_ads_action_mutation_attempt_events",
        source_id: "attempt_1",
        kind: "writes",
        title: "Provider write attempted",
        summary: null,
        entity_type: "ad",
        entity_id: "ad_1",
        entity_name: null,
        label: "pause",
        status_raw: "pending",
        actor_id: null,
        actor_name: null,
        actor_availability: "not_applicable",
        account_scope_basis: "direct_provider_account_id",
        attribution: "provider_write_log",
        correlation_status: "unavailable",
        correlation_key: null,
        replay_date: null,
        engine_version: null,
      }),
    ]);

    const payload = await readMetaHistoryJournal({
      query: baseQuery,
      account: { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    });

    expect(payload.entries).toHaveLength(2);
    expect(payload.entries.map((item) => [item.provenance.source, item.kind])).toEqual([
      ["decision_workflow_events", "decisions"],
      ["meta_ads_action_mutation_attempt_events", "writes"],
    ]);
    expect(payload.entries[0]).toMatchObject({
      entity: { type: "recommendation", id: "ad:ad_1" },
      provenance: {
        accountScopeBasis: "direct_provider_account_id",
        attribution: "workflow_object",
      },
    });
    expect(payload.entries[1]).toMatchObject({
      entity: { type: "ad", id: "ad_1" },
      provenance: {
        accountScopeBasis: "direct_provider_account_id",
        attribution: "provider_write_log",
      },
    });
  });

  it("preserves partial success instead of normalizing it to unknown", async () => {
    queryMock.mockResolvedValue([
      historyRow({
        source_id: "partial_1",
        status_raw: "partially_succeeded",
      }),
    ]);

    const payload = await readMetaHistoryJournal({
      query: { ...baseQuery, limit: 1 },
      account: { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    });

    expect(payload.entries[0]?.status).toBe("partially_succeeded");
  });

  it("drops rows whose provenance vocabulary is outside the public contract", async () => {
    queryMock.mockResolvedValue([
      historyRow({ source_id: "valid_1" }),
      historyRow({
        source_id: "bad_scope",
        account_scope_basis: "guessed_account",
      }),
      historyRow({
        source_id: "bad_attribution",
        attribution: "backend_process",
      }),
    ]);

    const payload = await readMetaHistoryJournal({
      query: { ...baseQuery, limit: 3 },
      account: { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    });

    expect(payload.entries.map((item) => item.identity.sourceId)).toEqual(["valid_1"]);
  });

  it("keeps observed configuration and state changes in the public journal", async () => {
    queryMock.mockResolvedValue([
      historyRow({
        source_key: "meta_adset_config_history",
        source_id: "config_1",
        kind: "external_changes",
        title: "Ad set configuration changed | Prospecting",
        entity_type: "adset",
        entity_id: "adset_1",
        entity_name: "Prospecting",
        label: null,
        status_raw: "observed",
        actor_id: null,
        actor_name: null,
        actor_availability: "not_applicable",
        account_scope_basis: "direct_provider_account_id",
        attribution: "provider_config_history",
        correlation_status: "unavailable",
        correlation_key: null,
      }),
      historyRow({
        source_key: "meta_entity_state_history",
        source_id: "state_1",
        kind: "external_changes",
        title: "Ad status changed | Summer ad",
        entity_type: "ad",
        entity_id: "ad_1",
        entity_name: "Summer ad",
        label: "paused",
        status_raw: "observed",
        actor_id: null,
        actor_name: null,
        actor_availability: "not_applicable",
        account_scope_basis: "direct_provider_account_id",
        attribution: "provider_state_history",
        correlation_status: "unavailable",
        correlation_key: null,
      }),
    ]);

    const payload = await readMetaHistoryJournal({
      query: baseQuery,
      account: { id: "act_1", name: "Primary", currency: "EUR", timezone: "UTC" },
    });

    expect(payload.entries).toHaveLength(2);
    expect(payload.entries.map((item) => item.status)).toEqual([
      "observed",
      "observed",
    ]);
    expect(payload.entries.map((item) => item.provenance.attribution)).toEqual([
      "provider_config_history",
      "provider_state_history",
    ]);
  });

  it("withholds monetary values when the account currency is unavailable", async () => {
    queryMock.mockResolvedValue([
      historyRow({
        source_key: "engine_v3_decision_snapshots_daily",
        source_id: "snapshot_1",
        kind: "decisions",
        entity_type: "creative",
        entity_id: "creative_1",
        account_scope_basis: "unique_creative_key",
        attribution: "engine_snapshot",
        correlation_status: "unavailable",
        correlation_key: null,
        correlation_reason: "Date-free identity unavailable.",
        detail_json: { spend: 123.45 },
      }),
    ]);

    const payload = await readMetaHistoryJournal({
      query: { ...baseQuery, limit: 40 },
      account: { id: "act_1", name: "Primary", currency: null, timezone: null },
    });

    expect(payload.entries[0]?.money).toEqual([
      {
        label: "Spend at decision",
        amount: null,
        currency: null,
        availability: "currency_unavailable",
        attribution: "meta_attributed",
      },
    ]);
  });

  it("defensively windows an oversized 1500-row result to one 40-row cursor page", async () => {
    const rows = Array.from({ length: 1_500 }, (_, index) =>
      historyRow({
        source_id: `log_${index + 1}`,
        occurred_at: new Date(
          Date.parse("2026-07-10T10:00:00.000Z") - index * 60_000,
        ).toISOString(),
      }),
    );
    queryMock.mockResolvedValue(rows);

    const payload = await readMetaHistoryJournal({
      query: { ...baseQuery, limit: 40 },
      account: {
        id: "act_1",
        name: "Primary",
        currency: "EUR",
        timezone: "UTC",
      },
    });

    expect(payload.entries).toHaveLength(40);
    expect(payload.entries[0]?.identity.sourceId).toBe("log_1");
    expect(payload.entries.at(-1)?.identity.sourceId).toBe("log_40");
    expect(payload.page.nextCursor).toBeTruthy();
    expect(decodeMetaHistoryCursor(payload.page.nextCursor as string)).toEqual({
      occurredAt: rows[39]?.occurred_at,
      source: "meta_ads_action_log",
      sourceId: "log_40",
    });
    // limit + 1 is the over-read that proves another page exists; it is no
    // longer the last parameter now that the outcome predicate follows it.
    expect(queryMock.mock.calls[0]?.[1]?.at(-4)).toBe(41);
    // A full first slice answers the read outright; it must not widen.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("never correlates journals with text or fingerprint substring matching", () => {
    expect(META_HISTORY_READ_SQL).toContain("HAVING COUNT(DISTINCT provider_account_id) = 1");
    expect(META_HISTORY_READ_SQL).toContain("scoped.rec_id = action_log.rec_id_origin");
    expect(META_HISTORY_READ_SQL).toContain("snapshot.id = event.decision_snapshot_id");
    expect(META_HISTORY_READ_SQL).not.toMatch(/recommendation_fingerprint\s+(?:LIKE|ILIKE)/i);
    expect(META_HISTORY_READ_SQL).not.toContain("payload_json::text");
    expect(META_HISTORY_READ_SQL).toContain(
      "$3::text IS NOT NULL OR kind <> 'structures'",
    );
  });

  it("uses grain-specific unnamed labels instead of provider ids in titles", () => {
    for (const label of [
      "Unnamed campaign",
      "Unnamed ad set",
      "Unnamed ad",
      "Unnamed creative",
    ]) {
      expect(META_HISTORY_READ_SQL).toContain(`'${label}'`);
    }

    expect(META_HISTORY_READ_SQL).not.toContain(
      "COALESCE(resolved.entity_name, resolved.entity_id)",
    );
    expect(META_HISTORY_READ_SQL).not.toMatch(
      /COALESCE\(campaign\.campaign_name_current, campaign\.campaign_name_historical, campaign\.campaign_id\)/,
    );
    expect(META_HISTORY_READ_SQL).not.toMatch(
      /COALESCE\(adset\.adset_name_current, adset\.adset_name_historical, adset\.adset_id\)/,
    );
    expect(META_HISTORY_READ_SQL).not.toContain(
      "COALESCE(entity_state.entity_name, entity_state.entity_id)",
    );
  });

  it("omits only unavailable optional workflow sources without dropping the core journal", () => {
    const sql = buildMetaHistoryReadSql({
      includeCreativeBriefs: false,
      includeLaunchIntents: false,
    });

    expect(sql).not.toContain("FROM meta_creative_briefs brief");
    expect(sql).not.toContain("FROM meta_launch_intents intent");
    expect(sql).toContain("FROM meta_ads_action_log action_log");
    expect(sql).toContain("FROM engine_v3_decision_snapshots_daily snapshot");
    expect(sql).toContain("FROM meta_campaign_dimensions campaign");
  });

  it("redacts nested credentials and truncates oversized payload values", () => {
    const detail = redactMetaHistoryDetail({
      authorization: "Bearer abc",
      nested: {
        refresh_token: "refresh",
        url: "https://example.test/?access_token=secret&x=1",
      },
      long: "x".repeat(5_000),
    }) as Record<string, unknown>;

    expect(detail.authorization).toBe("[redacted]");
    expect(detail.nested).toEqual({
      refresh_token: "[redacted]",
      url: "https://example.test/?access_token=[redacted]&x=1",
    });
    expect(String(detail.long)).toHaveLength(4_000);
  });
});

describe("the journal read is bounded before it is widened", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.getDb).mockReturnValue({ query: queryMock } as never);
  });

  const account = {
    id: "act_1",
    name: "Primary",
    currency: "EUR",
    timezone: "UTC",
  };

  it("widens the slice when a page comes back short, and proves the end", async () => {
    // Two rows for a page of 40: the read cannot tell "that is everything" from
    // "the slice was too narrow", so it has to look further before saying so.
    queryMock.mockResolvedValue([historyRow({ source_id: "log_1" })]);

    await readMetaHistoryJournal({
      query: { ...baseQuery, limit: 40 },
      account,
    });

    const floors = queryMock.mock.calls.map((call) => (call[1] as unknown[]).at(-1));
    expect(floors.length).toBeGreaterThan(1);
    // Each slice reaches strictly further back than the last...
    for (let index = 1; index < floors.length - 1; index += 1) {
      expect(
        Date.parse(String(floors[index])),
        `slice ${index} must reach further back than slice ${index - 1}`,
      ).toBeLessThan(Date.parse(String(floors[index - 1])));
    }
    // ...and the last one is unbounded, so "nothing older" is proven, not assumed.
    expect(floors.at(-1)).toBeNull();
  });

  it("never widens past a from-date the caller asked for", async () => {
    queryMock.mockResolvedValue([]);

    await readMetaHistoryJournal({
      query: { ...baseQuery, limit: 40, from: "2026-08-01" },
      account,
    });

    // Widening past an explicit floor would read rows the caller excluded.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect((queryMock.mock.calls[0]?.[1] as unknown[]).at(-1)).toBe("2026-08-01");
  });
});
