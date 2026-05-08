import { describe, expect, it } from "vitest";
import {
  buildDuplicateDerivedCandidates,
  buildAuditSummary,
  isExpectedNullProviderAccountRef,
} from "@/scripts/db-normalization-audit";

describe("db normalization audit", () => {
  it("treats the search_console not selected row as expected after legacy removal", () => {
    expect(
      isExpectedNullProviderAccountRef({
        legacyPhase: "removed",
        tableName: "provider_connections",
        refColumn: "provider_account_ref_id",
        provider: "search_console",
        providerAccountId: null,
        providerAccountName: "Not selected",
        businessRefId: "biz-1",
      }),
    ).toBe(true);
  });

  it("does not broaden the expected-null rule", () => {
    expect(
      isExpectedNullProviderAccountRef({
        legacyPhase: "compat_retained",
        tableName: "provider_connections",
        refColumn: "provider_account_ref_id",
        provider: "search_console",
        providerAccountId: null,
        providerAccountName: "Not selected",
        businessRefId: "biz-1",
      }),
    ).toBe(false);
    expect(
      isExpectedNullProviderAccountRef({
        legacyPhase: "removed",
        tableName: "provider_connections",
        refColumn: "provider_account_ref_id",
        provider: "search_console",
        providerAccountId: "acct-1",
        providerAccountName: "Not selected",
        businessRefId: "biz-1",
      }),
    ).toBe(false);
    expect(
      isExpectedNullProviderAccountRef({
        legacyPhase: "removed",
        tableName: "provider_connections",
        refColumn: "provider_account_ref_id",
        provider: "ga4",
        providerAccountId: null,
        providerAccountName: "Not selected",
        businessRefId: "biz-1",
      }),
    ).toBe(false);
  });

  it("counts expected null refs separately from blocking gaps", () => {
    const summary = buildAuditSummary({
      refCoverage: [
        {
          tableName: "provider_connections",
          refColumn: "provider_account_ref_id",
          totalRows: 1,
          nullRefRows: 1,
          populatedRefRows: 0,
          expectedNullRefRows: 1,
          blockingNullRefRows: 0,
        },
        {
          tableName: "meta_sync_runs",
          refColumn: "provider_account_ref_id",
          totalRows: 3,
          nullRefRows: 1,
          populatedRefRows: 2,
          expectedNullRefRows: 0,
          blockingNullRefRows: 1,
        },
      ],
      expectedNullRefs: [
        {
          tableName: "provider_connections",
          refColumn: "provider_account_ref_id",
          rowCount: 1,
          reason: "search_console_not_selected",
        },
      ],
      coreLegacyState: {
        legacyPhase: "removed",
        tables: [
          { tableName: "integrations", exists: false, rows: null },
          {
            tableName: "provider_account_assignments",
            exists: false,
            rows: null,
          },
          {
            tableName: "provider_account_snapshots",
            exists: false,
            rows: null,
          },
        ],
        providerConnectionsRows: 1,
        businessProviderAccountsRows: 1,
        snapshotRunsRows: 1,
        snapshotItemsRows: 1,
      },
    });

    expect(summary.tablesWithRefGaps).toBe(1);
    expect(summary.tablesWithBlockingRefGaps).toBe(1);
    expect(summary.providerRefGapTables).toBe(1);
    expect(summary.expectedNullRefTables).toBe(1);
    expect(summary.expectedNullRefRows).toBe(1);
    expect(summary.duplicateDerivedCandidateCount).toBe(0);
  });

  it("classifies duplicate and derived candidates across provider families", () => {
    const candidates = buildDuplicateDerivedCandidates({
      columns: [
        { tableName: "meta_campaign_daily", columnName: "bid_strategy_type" },
        { tableName: "meta_campaign_daily", columnName: "bid_strategy_label" },
        { tableName: "meta_campaign_daily", columnName: "manual_bid_amount" },
        { tableName: "meta_campaign_daily", columnName: "bid_value" },
        { tableName: "meta_campaign_daily", columnName: "bid_value_format" },
        { tableName: "google_ads_campaign_daily", columnName: "status" },
        { tableName: "google_ads_campaign_daily", columnName: "effective_status" },
        { tableName: "command_center_events", columnName: "payload_json" },
        { tableName: "shopify_order_snapshots", columnName: "raw_payload" },
        { tableName: "engine_v3_creative_lifecycle_daily", columnName: "creative_name_current" },
        { tableName: "engine_v3_creative_lifecycle_daily", columnName: "creative_name_historical" },
        { tableName: "meta_ads", columnName: "normalized_url" },
        { tableName: "meta_ads", columnName: "display_url" },
        { tableName: "meta_breakdown_daily", columnName: "breakdown_type" },
        { tableName: "meta_breakdown_daily", columnName: "breakdown_key" },
        { tableName: "meta_breakdown_daily", columnName: "breakdown_label" },
        { tableName: "google_ads_query_dictionary", columnName: "normalized_query" },
        { tableName: "google_ads_query_dictionary", columnName: "display_query" },
      ],
    });

    const byColumn = new Map(
      candidates.map((candidate) => [
        `${candidate.tableName}.${candidate.columnName}`,
        candidate,
      ]),
    );

    expect(
      byColumn.get("meta_campaign_daily.bid_strategy_label")?.classification,
    ).toBe("derived_label");
    expect(
      byColumn.get("meta_campaign_daily.bid_strategy_type")
        ?.recommendedCanonicalField,
    ).toBe("bid_strategy_type");
    expect(
      byColumn.get("meta_campaign_daily.manual_bid_amount")?.classification,
    ).toBe("compatibility_shadow");
    expect(
      byColumn.get("meta_campaign_daily.manual_bid_amount")?.removalRisk,
    ).toBe("medium");
    expect(
      byColumn.get("meta_campaign_daily.bid_value")
        ?.recommendedCanonicalField,
    ).toBe("bid_value + bid_value_format");
    expect(
      byColumn.get("google_ads_campaign_daily.status")?.classification,
    ).toBe("compatibility_shadow");
    expect(
      byColumn.get("google_ads_campaign_daily.effective_status")
        ?.classification,
    ).toBe("canonical");
    expect(
      byColumn.get("command_center_events.payload_json")?.classification,
    ).toBe("raw_payload");
    expect(
      byColumn.get("shopify_order_snapshots.raw_payload")?.classification,
    ).toBe("raw_payload");
    expect(
      byColumn.get(
        "engine_v3_creative_lifecycle_daily.creative_name_historical",
      )?.classification,
    ).toBe("historical_snapshot");
    expect(byColumn.get("meta_ads.display_url")?.classification).toBe(
      "display_alias",
    );
    expect(byColumn.has("meta_breakdown_daily.breakdown_label")).toBe(false);
    expect(byColumn.has("google_ads_query_dictionary.display_query")).toBe(false);
  });
});
