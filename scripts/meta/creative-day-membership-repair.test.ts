import { describe, expect, it } from "vitest";
import { assertCreativeDayRepairReadback, buildCreativeDayRepairPlan } from "./creative-day-membership-repair";
import type { MetaAdDailyRow, MetaCreativeDailyRow } from "@/lib/meta/warehouse-types";
import type { MetaInsightRecord } from "@/lib/meta/creatives-types";

const day = "2026-09-21";
const cutoff = "2026-09-24T00:00:00.000Z";
const account = "act_123";
const business = "biz-1";
function ad(id: string, spend: number, campaignId = "cmp-1", adsetId = "set-1") {
  return {
    businessId: business, providerAccountId: account, date: day,
    campaignId, adsetId, adId: id, adNameCurrent: id, adNameHistorical: id,
    adStatus: "ACTIVE", accountTimezone: "Europe/Istanbul", accountCurrency: "USD",
    spend, impressions: 100, clicks: 5, reach: 80, frequency: null,
    conversions: 0, revenue: 0, roas: 0, cpa: null, ctr: 5, cpc: spend / 5,
    linkClicks: 4, outboundClicks: 3, sourceSnapshotId: "snapshot-1",
    sourceRunId: "source-run-1", finalizedAt: "2026-09-22T00:00:00.000Z",
    truthState: "finalized", validationStatus: "passed",
    createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z",
    payloadJson: { actions: [{ action_type: "link_click", value: "4" },
      { action_type: "landing_page_view", value: "2" }],
      outbound_clicks: [{ action_type: "outbound_click", value: "3" }] },
  } as MetaAdDailyRow;
}
function insight(id: string, spend: number): MetaInsightRecord {
  return { ad_id: id, date_start: day, spend: String(spend), impressions: "100", clicks: "5" };
}
function old(creativeId: string, spend: number) {
  return {
    businessId: business, providerAccountId: account, date: day,
    campaignId: "cmp-1", adsetId: "set-1", adId: "ad-1", creativeId,
    creativeName: "Old", headline: null, primaryText: null,
    destinationUrl: null, thumbnailUrl: null, assetType: "image",
    accountTimezone: "Europe/Istanbul", accountCurrency: "USD",
    spend, impressions: 100, clicks: 5, reach: 80, frequency: null,
    conversions: 0, revenue: 0, roas: 0, cpa: null, ctr: 5, cpc: spend / 5,
    linkClicks: 4, sourceSnapshotId: "snapshot-1",
    createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z",
    payloadJson: { real_ad_id: "ad-1", associated_ads_count: 1,
      objective: "OUTCOME_SALES" },
  } as MetaCreativeDailyRow;
}
function plan(input: {
  adRows?: MetaAdDailyRow[]; oldRows?: MetaCreativeDailyRow[];
  providerRows?: MetaInsightRecord[]; identities?: [string, string][];
}) {
  return buildCreativeDayRepairPlan({ businessId: business, accountId: account,
    day, cutoff, adRows: input.adRows ?? [], oldRows: input.oldRows ?? [],
    providerRows: input.providerRows ?? [],
    sourceLineageBySnapshot: new Map([["snapshot-1", {
      id: "snapshot-1", businessId: business, providerAccountId: account,
      startDate: day, endDate: day, endpointName: "ad_insights_bulk",
      status: "fetched", payloadHash: "source-hash-1",
    }]]),
    identityByAdDay: new Map((input.identities ?? []).map(([adId, creativeId]) =>
      [JSON.stringify([account, day, adId]), creativeId])) });
}

describe("creative-day historical membership repair", () => {
  it("rebuilds a shared creative from both TheSwaf-like Ads without certifying config", () => {
    const result = plan({ adRows: [ad("ad-1", 23.61), ad("ad-2", 24.35)],
      oldRows: [old("creative-1", 45.5)],
      providerRows: [insight("ad-1", 23.61), insight("ad-2", 24.35)],
      identities: [["ad-1", "creative-1"], ["ad-2", "creative-1"]] });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.next.spend).toBeCloseTo(47.96);
    expect(result.groups[0]!.next.payloadJson).toMatchObject({
      source_ad_ids: ["ad-1", "ad-2"], source_ad_ids_complete: true,
      source_membership_scope: "decision_bearing_ad_days",
      source_identity_version: "meta-creative-membership.v2",
      associated_ads_count: 2, historical_config_provenance: "unverified",
      landing_page_views: 4,
    });
    expect(result.manifest.changes).toHaveLength(1);
  });

  it("names economic-only membership when a zero-only Ad has an unproved different parent", () => {
    const zeroOnly = { ...ad("ad-zero", 0, "cmp-other", "set-other"),
      impressions: 0, clicks: 0, reach: 0, linkClicks: null, outboundClicks: null,
      payloadJson: {} } as MetaAdDailyRow;
    const result = plan({ adRows: [ad("ad-1", 23.61), zeroOnly],
      providerRows: [insight("ad-1", 23.61),
        { ad_id: "ad-zero", date_start: day, spend: "0", impressions: "0", clicks: "0" }],
      identities: [["ad-1", "creative-1"]] });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.manifest.counts.zeroOnlyAdRows).toBe(1);
    expect(result.groups[0]!.next.payloadJson).toMatchObject({
      source_ad_ids: ["ad-1"], source_ad_ids_complete: true,
      source_membership_scope: "decision_bearing_ad_days",
      source_parent_grain_complete: true,
    });
  });

  it("nulls ambiguous parent and payload config for cross-campaign creative", () => {
    const result = plan({ adRows: [ad("ad-1", 23.61), ad("ad-2", 24.35, "cmp-2", "set-2")],
      oldRows: [old("creative-1", 45.5)],
      providerRows: [insight("ad-1", 23.61), insight("ad-2", 24.35)],
      identities: [["ad-1", "creative-1"], ["ad-2", "creative-1"]] });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.groups[0]!.next).toMatchObject({ campaignId: null, adsetId: null,
      parentComplete: false });
    expect(result.groups[0]!.next.payloadJson).toMatchObject({ objective: null,
      source_parent_grain_complete: false, source_campaign_ids: ["cmp-1", "cmp-2"] });
  });

  it("blocks a Grandmix-like switched Ad rather than borrowing current identity", () => {
    const result = plan({ adRows: [ad("ad-1", 23.61), ad("ad-2", 24.35)],
      oldRows: [old("creative-1", 45.5)],
      providerRows: [insight("ad-1", 23.61), insight("ad-2", 24.35)],
      identities: [["ad-1", "creative-1"]] });
    expect(result).toMatchObject({ status: "blocked" });
    if (result.status !== "blocked") return;
    expect(result.blockers).toContain("historical_creative_identity_unprovable:ad-2");
  });

  it("does not erase an existing receipt-backed config certificate during membership repair", () => {
    const certified = { ...old("creative-1", 23.61), payloadJson: {
      historical_config_provenance: "provider_receipt_day_bracketed",
      historical_config_proof: { objective: "OUTCOME_SALES" },
    } } as MetaCreativeDailyRow;
    const result = plan({ adRows: [ad("ad-1", 23.61)], oldRows: [certified],
      providerRows: [insight("ad-1", 23.61)],
      identities: [["ad-1", "creative-1"]] });
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.blockers).toContain("certified_config_requires_separate_revalidation:creative-1");
  });

  it("blocks missing original snapshot lineage even when current Meta scope matches", () => {
    const broken = { ...ad("ad-1", 23.61), sourceSnapshotId: null } as MetaAdDailyRow;
    const result = plan({ adRows: [broken], providerRows: [insight("ad-1", 23.61)],
      identities: [["ad-1", "creative-1"]] });
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.blockers).toContain("ad_fact_source_snapshot_lineage_incomplete:ad-1");
  });

  it("records provider restatement without replacing finalized warehouse economics", () => {
    const result = plan({ adRows: [ad("ad-1", 23.61), ad("ad-2", 24.35)],
      oldRows: [old("wrong-creative", 45.5)],
      providerRows: [insight("ad-1", 23.61), insight("ad-2", 99)],
      identities: [["ad-1", "creative-1"], ["ad-2", "creative-1"]] });
    expect(result).toMatchObject({ status: "ready" });
    if (result.status !== "ready") return;
    expect(result.manifest.providerRestatements).toEqual([{
      reason: "provider_report_restatement_observed", adId: "ad-2",
      warehouse: { spend: 24.35, impressions: 100, clicks: 5 },
      provider: { spend: 99, impressions: 100, clicks: 5 },
    }]);
    expect(result.groups[0]!.next.spend).toBeCloseTo(47.96);
  });

  it("repairs only source-backed account timezone and currency and verifies their readback", () => {
    const legacy = { ...old("creative-1", 23.61), accountTimezone: "UTC",
      accountCurrency: "EUR" } as MetaCreativeDailyRow;
    const result = plan({ adRows: [ad("ad-1", 23.61)], oldRows: [legacy],
      providerRows: [insight("ad-1", 23.61)],
      identities: [["ad-1", "creative-1"]] });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.groups[0]!.next).toMatchObject({
      accountTimezone: "Europe/Istanbul", accountCurrency: "USD",
    });
    expect(result.manifest.changes[0]).toMatchObject({
      old: { accountTimezone: "UTC", accountCurrency: "EUR" },
      next: { accountTimezone: "Europe/Istanbul", accountCurrency: "USD" },
    });
    const repaired = { ...legacy, ...result.groups[0]!.next,
      payloadJson: result.groups[0]!.next.payloadJson } as MetaCreativeDailyRow;
    expect(() => assertCreativeDayRepairReadback([legacy], result))
      .toThrow("creative_day_repair_readback_mismatch:creative-1");
    expect(() => assertCreativeDayRepairReadback([repaired], result)).not.toThrow();
  });

  it("carries only single-Ad measured frequency and clears stale grouped fatigue", () => {
    const measured = { ...ad("ad-1", 23.61), frequency: 1.25 } as MetaAdDailyRow;
    const stale = { ...old("creative-1", 23.61), frequency: 9,
      payloadJson: { frequency: 9, metric_presence: { frequency: true } },
    } as MetaCreativeDailyRow;
    const single = plan({ adRows: [measured], oldRows: [stale],
      providerRows: [insight("ad-1", 23.61)],
      identities: [["ad-1", "creative-1"]] });
    expect(single.status).toBe("ready");
    if (single.status !== "ready") return;
    expect(single.groups[0]!.next).toMatchObject({ frequency: 1.25,
      payloadJson: { frequency: 1.25, metric_presence: { frequency: true } } });
    expect(() => assertCreativeDayRepairReadback([{
      ...stale, ...single.groups[0]!.next, frequency: 9,
    } as MetaCreativeDailyRow], single)).toThrow("creative_day_repair_readback_mismatch:creative-1");

    const grouped = plan({ adRows: [measured,
      { ...ad("ad-2", 24.35), frequency: 2 } as MetaAdDailyRow],
      oldRows: [stale],
      providerRows: [insight("ad-1", 23.61), insight("ad-2", 24.35)],
      identities: [["ad-1", "creative-1"], ["ad-2", "creative-1"]] });
    expect(grouped.status).toBe("ready");
    if (grouped.status !== "ready") return;
    expect(grouped.groups[0]!.next).toMatchObject({ frequency: null,
      payloadJson: { frequency: null, metric_presence: { frequency: false } } });
  });

  it("blocks mixed Ad-day account context before certifying creative-day membership", () => {
    const result = plan({
      adRows: [ad("ad-1", 23.61), { ...ad("ad-2", 24.35), accountTimezone: "UTC" }],
      providerRows: [insight("ad-1", 23.61), insight("ad-2", 24.35)],
      identities: [["ad-1", "creative-1"], ["ad-2", "creative-1"]],
    });
    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") return;
    expect(result.blockers).toContain("account_context_missing_or_mixed");
  });

  it("records the complete stale preimage and does no writes on an identical rerun", () => {
    const sources = { adRows: [ad("ad-1", 23.61)],
      providerRows: [insight("ad-1", 23.61)],
      identities: [["ad-1", "creative-1"]] as [string, string][] };
    const first = plan({ ...sources, oldRows: [old("stale-creative", 23.61)] });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.manifest.changes.find((change) => change.kind === "delete"))
      .toMatchObject({ creativeId: "stale-creative", old: {
        spend: 23.61, payloadJson: { objective: "OUTCOME_SALES" } } });
    const repaired = { ...old("creative-1", 23.61), ...first.groups[0]!.next,
      payloadJson: first.groups[0]!.next.payloadJson } as MetaCreativeDailyRow;
    const second = plan({ ...sources, oldRows: [repaired] });
    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    expect(second.manifest.changes).toEqual([]);
    expect(second.groups[0]!.needsWrite).toBe(false);
    expect(() => assertCreativeDayRepairReadback([repaired], second)).not.toThrow();
    expect(() => assertCreativeDayRepairReadback([{ ...repaired, spend: 1 }], second))
      .toThrow("creative_day_repair_readback_mismatch:creative-1");
    expect(() => assertCreativeDayRepairReadback([{ ...repaired, roas: 3 }], second))
      .toThrow("creative_day_repair_readback_mismatch:creative-1");
    expect(() => assertCreativeDayRepairReadback([repaired,
      old("concurrent-positive-creative", 1)], second))
      .toThrow("creative_day_repair_unexpected_positive_row:concurrent-positive-creative");
  });
});
