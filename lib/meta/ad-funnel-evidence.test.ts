import { describe, expect, it } from "vitest";
import {
  aggregateMetaAdFunnelEvidence,
  type MetaAdFunnelEvidenceDay,
} from "./ad-funnel-evidence";

function day(overrides: Partial<MetaAdFunnelEvidenceDay> = {}): MetaAdFunnelEvidenceDay {
  return {
    adId: "ad_1",
    adsetId: "set_1",
    date: "2026-09-20",
    spend: 120.15,
    revenue: 0,
    impressions: 1000,
    linkClicks: 20,
    conversions: 0,
    payloadJson: {
      actions: [
        { action_type: "link_click", value: "20" },
        { action_type: "landing_page_view", value: "16" },
        { action_type: "add_to_cart", value: "4" },
        { action_type: "initiate_checkout", value: "2" },
      ],
    },
    providerZeroReceiptVerified: false,
    ...overrides,
  };
}

describe("exact-Ad selected-window funnel evidence", () => {
  it("preserves LPV, cart and checkout with a measured purchase zero", () => {
    const [row] = aggregateMetaAdFunnelEvidence([day()]);
    expect(row).toMatchObject({
      id: "ad_1", impressions: 1000, linkClicks: 20,
      landingPageViews: 16, addToCart: 4, initiateCheckout: 2,
      purchases: 0, purchasesObserved: true,
    });
  });

  it("admits an omitted zero-action list only with its exact source receipt", () => {
    const absent = day({
      date: "2026-09-21", spend: 5, impressions: 100,
      linkClicks: 0, payloadJson: {},
    });
    const [unverified] = aggregateMetaAdFunnelEvidence([day(), absent]);
    expect(unverified).toMatchObject({
      impressions: 1100, linkClicks: null, linkClicksObserved: false,
      landingPageViews: null, addToCart: null,
      initiateCheckout: null, purchases: null, purchasesObserved: false,
      purchaseValue: null, roas: null,
    });
    const [verified] = aggregateMetaAdFunnelEvidence([
      day(), { ...absent, providerZeroReceiptVerified: true },
    ]);
    expect(verified).toMatchObject({
      linkClicks: 20, landingPageViews: 16, addToCart: 4,
      initiateCheckout: 2, purchases: 0, purchasesObserved: true,
    });
  });

  it("holds a contradictory purchase scalar and malformed action instead of inventing zero", () => {
    const [mismatch] = aggregateMetaAdFunnelEvidence([
      day({ conversions: 1 }),
    ]);
    expect(mismatch?.purchases).toBeNull();
    const [malformed] = aggregateMetaAdFunnelEvidence([
      day({ payloadJson: { actions: { purchase: 0 } }, providerZeroReceiptVerified: true }),
    ]);
    expect(malformed).toMatchObject({ purchases: null, landingPageViews: null });
  });

  it("does not merge an Ad's distinct ad sets into one displayed ROAS", () => {
    const rows = aggregateMetaAdFunnelEvidence([
      day(), day({ adsetId: "set_2", date: "2026-09-21", spend: 60 }),
    ]);
    expect(rows.map((row) => row.adsetId)).toEqual(["set_1", "set_2"]);
    expect(rows.map((row) => row.purchases)).toEqual([0, 0]);
  });
});
