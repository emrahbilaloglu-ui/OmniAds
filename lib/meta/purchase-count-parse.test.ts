import { describe, expect, it } from "vitest";
import {
  buildAdDayAuthoritativePurchasesSql,
  parseMetaPurchaseActions,
  resolveAdDayAuthoritativePurchases,
} from "./purchase-count-parse";
import { buildMetaAdDayProviderZeroReceiptSql } from "./ad-day-provider-zero-receipt";
import { META_BULK_CORE_INSIGHTS_FIELDS } from "@/lib/api/meta";

describe("ad-day purchase evidence", () => {
  it("uses an explicit complete provider receipt for an omitted actions key", () => {
    expect(parseMetaPurchaseActions(undefined)).toBeNull();
    expect(parseMetaPurchaseActions(undefined, { absentActions: "provider_zero" })).toBe(0);
    expect(parseMetaPurchaseActions(null, { absentActions: "provider_zero" })).toBeNull();
    expect(resolveAdDayAuthoritativePurchases({
      storedConversions: 0, payloadJson: { ad_id: "ad-1" },
    })).toBeNull();
    expect(resolveAdDayAuthoritativePurchases({
      storedConversions: 0, payloadJson: { ad_id: "ad-1" },
      providerZeroReceiptVerified: true,
    })).toBe(0);
    expect(resolveAdDayAuthoritativePurchases({
      storedConversions: 0, payloadJson: { actions: null },
      providerZeroReceiptVerified: true,
    })).toBeNull();
    expect(resolveAdDayAuthoritativePurchases({
      storedConversions: 0, payloadJson: { actions: undefined },
      providerZeroReceiptVerified: true,
    })).toBeNull();
    expect(resolveAdDayAuthoritativePurchases({
      storedConversions: 0, payloadJson: [], providerZeroReceiptVerified: true,
    })).toBeNull();
    expect(resolveAdDayAuthoritativePurchases({
      storedConversions: 2, payloadJson: { ad_id: "ad-1" },
      providerZeroReceiptVerified: true,
    })).toBeNull();
  });

  it("keeps measured zero and alias counts separate without addition", () => {
    expect(parseMetaPurchaseActions([])).toBe(0);
    expect(parseMetaPurchaseActions([{ action_type: "link_click", value: "12" }])).toBe(0);
    expect(parseMetaPurchaseActions([
      { action_type: "purchase", value: "2" },
      { action_type: "omni_purchase", value: "2" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" },
    ])).toBe(2);
    expect(parseMetaPurchaseActions([
      { action_type: "purchase", value: "2" },
      { action_type: "omni_purchase", value: "3" },
    ])).toBeNull();
    expect(parseMetaPurchaseActions([
      { action_type: "purchase", value: "1" },
      { action_type: "purchase", value: "1" },
    ])).toBeNull();
    expect(resolveAdDayAuthoritativePurchases({
      storedConversions: 0,
      payloadJson: { actions: [{ action_type: "purchase", value: "1" }] },
    })).toBeNull();
  });

  it("refuses malformed counts and requires a published source chain in SQL", () => {
    expect(META_BULK_CORE_INSIGHTS_FIELDS.split(",")).toContain("actions");
    expect(parseMetaPurchaseActions([{ action_type: "purchase", value: "1.5" }])).toBeNull();
    expect(parseMetaPurchaseActions([{ action_type: "purchase", value: 1 }])).toBeNull();
    expect(parseMetaPurchaseActions([{ action_type: "purchase", value: "9007199254740992" }])).toBeNull();
    const receipt = buildMetaAdDayProviderZeroReceiptSql({
      qualifier: "d", cutoffSql: "$5::timestamptz",
    });
    expect(receipt).toContain("source.payload_json @> jsonb_build_array(d.payload_json)");
    expect(receipt).toContain("source_row.payload = d.payload_json");
    expect(receipt).toContain("manifest.fetch_status = 'completed'");
    expect(receipt).toContain("slice.id = pointer.active_slice_version_id");
    expect(receipt).toContain("manifest.id = slice.manifest_id");
    expect(receipt).toContain("observation.run_id = manifest.run_id");
    expect(receipt).toContain("observation.observed_at <= manifest.completed_at");
    expect(receipt).toContain("pointer.published_by_run_id = d.source_run_id");
    expect(receipt).toContain("source.fetched_at <= manifest.completed_at");
    expect(receipt).toContain("manifest.completed_at <= slice.published_at");
    expect(receipt).toContain("slice.published_at <= pointer.published_at");
    expect(receipt).toContain("source.request_context->>'source' = 'bulk_core_sync'");
    expect(receipt).toContain("'actions' = ANY(string_to_array(source.request_context->>'fields', ','))");
    const purchases = buildAdDayAuthoritativePurchasesSql({
      qualifier: "d", providerZeroProofSql: "source_receipt.verified",
    });
    expect(purchases).toContain("NOT (d.payload_json ? 'actions')");
    expect(purchases).toContain("COALESCE(source_receipt.verified, FALSE)");
    expect(() => buildMetaAdDayProviderZeroReceiptSql({
      qualifier: "d; DROP TABLE", cutoffSql: "$5::timestamptz",
    })).toThrow();
  });
});
