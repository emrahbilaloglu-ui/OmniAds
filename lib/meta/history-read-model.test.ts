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
    queryMock.mockResolvedValueOnce([
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
    ]);
  });

  it("withholds monetary values when the account currency is unavailable", async () => {
    queryMock.mockResolvedValueOnce([
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
    queryMock.mockResolvedValueOnce(rows);

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
    expect(queryMock.mock.calls[0]?.[1]?.at(-1)).toBe(41);
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
