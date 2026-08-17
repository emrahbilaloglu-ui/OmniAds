import { describe, expect, it } from "vitest";

import {
  buildCommercialTruthExactModel,
  type CommercialTruthAdapterInput,
} from "@/components/commercial-truth/commercial-truth-exact-adapter";

function input(
  overrides: Partial<CommercialTruthAdapterInput> = {},
): CommercialTruthAdapterInput {
  return {
    business: { name: "Grandmix", currency: "USD", timezone: "Europe/Istanbul" },
    targetPack: {
      targetRoas: 3.8,
      breakEvenRoas: 2.5,
      targetCpa: 24,
      aovAssumption: 58,
      costStructure: {
        cogsPercent: 0.38,
        shippingPercent: 0.08,
        paymentProcessingPercent: 0.03,
      },
      updatedAt: "2026-08-02T09:00:00.000Z",
    },
    costModel: {
      cogsPercent: 0.4,
      shippingPercent: 0.1,
      feePercent: 0.04,
      fixedCost: 12000,
    },
    window: { spend: 26000, revenue: 100000 },
    campaigns: [
      {
        id: "c1",
        name: "Prospecting — Broad US",
        platform: "Meta",
        level: "Campaign",
        spend: 21900,
        revenue: 112128,
        roas: 5.12,
      },
      {
        id: "c2",
        name: "Retargeting 7d — DPA",
        platform: "Meta",
        level: "Ad set",
        spend: 12300,
        revenue: 23862,
        roas: 1.94,
      },
      {
        id: "c3",
        name: "PMax — Evergreen",
        platform: "Google",
        level: "Campaign",
        spend: 18940,
        revenue: 71214,
        roas: 3.76,
      },
    ],
    history: [
      {
        id: "h1",
        at: "2026-08-02T09:00:00.000Z",
        changes: ["Target ROAS updated"],
        sourceLabel: "Q3 margin push",
        actor: "Emrah B.",
      },
    ],
    pack: {
      canEdit: true,
      saving: false,
      dirty: false,
      error: null,
      lastUpdatedActor: "Emrah B.",
    },
    ...overrides,
  };
}

describe("buildCommercialTruthExactModel", () => {
  it("renders the design's eight target-pack fields in order, from the pack", () => {
    const model = buildCommercialTruthExactModel(input());
    expect(model.fields.map((field) => field.label)).toEqual([
      "Target ROAS",
      "Breakeven ROAS",
      "Gross margin",
      "AOV floor",
      "Shipping cost",
      "Payment fees",
      "CPA ceiling",
      "Fixed costs / mo",
    ]);
    // Pack override wins over the live cost model for every shared number.
    expect(model.fields[2].value).toBe("62%");
    expect(model.fields[4].value).toBe("8%");
    expect(model.fields[5].value).toBe("3%");
    // The monthly fixed base only exists on the cost model.
    expect(model.fields[7].value).toBe("$12,000");
    // Only the two ROAS anchors carry the design's accent border.
    expect(model.fields.filter((field) => field.accent).map((field) => field.id)).toEqual([
      "targetRoas",
      "breakevenRoas",
    ]);
  });

  it("never invents an anchor: a pack without targets bands nothing", () => {
    const model = buildCommercialTruthExactModel(
      input({
        targetPack: {
          targetRoas: null,
          breakEvenRoas: null,
          targetCpa: null,
          aovAssumption: null,
          costStructure: null,
          updatedAt: null,
        },
      }),
    );
    expect(model.fields[0].value).toBe("—");
    expect(model.bands.every((band) => band.range === "—")).toBe(true);
    expect(model.bands.every((band) => band.count === 0)).toBe(true);
    expect(model.spendRows.every((row) => row.verdict === "—")).toBe(true);
    expect(model.totals.targetRoas).toBe("—");
  });

  it("bands rows on the design's ladder, mid = max(breakeven, target x 0.85)", () => {
    const model = buildCommercialTruthExactModel(input());
    // target 3.80, mid 3.23, breakeven 2.50.
    expect(model.bands.map((band) => `${band.name}:${band.count}`)).toEqual([
      "Above target:1",
      "Near target:1",
      "Above breakeven:0",
      "Below breakeven:1",
    ]);
    expect(model.bands[0].range).toBe("ROAS ≥ 3.80");
    expect(model.bands[1].range).toBe("3.23 – 3.80");
    expect(model.spendRows[0].verdict).toBe("Scale");
    expect(model.spendRows[1].verdict).toBe("Cut");
    expect(model.spendRows[2].verdict).toBe("Hold");
  });

  it("blends Meta and Google spend into one labeled total", () => {
    const model = buildCommercialTruthExactModel(input());
    expect(model.spendRows).toHaveLength(3);
    expect(model.spendRows.map((row) => row.platform)).toEqual(["Meta", "Meta", "Google"]);
    expect(model.spendRows[2].logo).toBe("/platform-logos/googleAds.svg");
    expect(model.totals.spend).toBe("$53,140");
    expect(model.totals.roas).toBe("3.90");
    expect(model.totals.delta).toBe("+0.10");
  });

  it("uses a live draft so the preview re-labels on a keystroke", () => {
    // target 6.00 moves mid to 5.10, so the 5.12 row drops out of "Above target".
    const model = buildCommercialTruthExactModel(input({ draft: { targetRoas: 6 } }));
    expect(model.bands[0].count).toBe(0);
    expect(model.spendRows[0].verdict).toBe("Hold");
    expect(model.spendRows[2].verdict).toBe("Watch / Trim");
    expect(model.totals.targetRoas).toBe("6.00");
  });

  it("keeps the revenue split's five design segments and dashes what is unknown", () => {
    const model = buildCommercialTruthExactModel(input());
    expect(model.segments.map((segment) => segment.key)).toEqual([
      "COGS",
      "Shipping",
      "Fees",
      "Ad spend",
      "Contribution",
    ]);
    expect(model.segments.map((segment) => segment.value)).toEqual([
      "$38",
      "$8",
      "$3",
      "$26",
      "$25",
    ]);

    const withoutWindow = buildCommercialTruthExactModel(
      input({ window: { spend: null, revenue: null } }),
    );
    expect(withoutWindow.segments[3].value).toBe("—");
    expect(withoutWindow.segments[4].value).toBe("—");
  });

  it("dashes the scenario basis rather than assuming a cost model", () => {
    const model = buildCommercialTruthExactModel(
      input({
        targetPack: {
          targetRoas: 3.8,
          breakEvenRoas: 2.5,
          targetCpa: null,
          aovAssumption: null,
          costStructure: null,
          updatedAt: null,
        },
        costModel: null,
      }),
    );
    expect(model.scenario.variableCostRatio).toBeNull();
    expect(model.scenario.fixedCost).toBeNull();
    expect(model.scenario.variableCostSubLabel).toBe("—");
    expect(model.scenario.contributionSubLabel).toBe("—");
  });

  it("reports coverage and the unlabeled remainder from real rows", () => {
    const model = buildCommercialTruthExactModel(
      input({
        campaigns: [
          ...input().campaigns,
          {
            id: "c4",
            name: "EU Prospecting",
            platform: "Meta",
            level: "Campaign",
            spend: 6050,
            revenue: null,
            roas: null,
          },
        ],
      }),
    );
    expect(model.coverage).toBe("labeled coverage 90% — the rest is unlabeled");
    expect(model.unlabeledSpend).toBe("$6,050");
    expect(model.spendRows[3].verdict).toBe("Fix setup");
  });

  it("names the pack's last editor from the history actor", () => {
    expect(buildCommercialTruthExactModel(input()).pack.lastUpdated).toBe(
      "last updated Aug 2 by Emrah B.",
    );
    const anonymous = buildCommercialTruthExactModel(
      input({
        pack: {
          canEdit: false,
          saving: false,
          dirty: false,
          error: null,
          lastUpdatedActor: null,
        },
      }),
    );
    expect(anonymous.pack.lastUpdated).toBe("last updated Aug 2 by —");
  });

  it("dashes workspace stats it was not given", () => {
    const model = buildCommercialTruthExactModel(
      input({ business: { name: null, currency: null, timezone: null } }),
    );
    expect(model.stats.map((stat) => stat.value)).toEqual(["—", "—", "—"]);
  });

  it("draws the scenario chip in the same notation the money cells use", () => {
    const usd = buildCommercialTruthExactModel(input());
    // The cells print "$21,900"; the chip must not print "USD" beside them.
    expect(usd.currencySymbol).toBe("$");
    expect(usd.spendRows[0].spend.startsWith(usd.currencySymbol)).toBe(true);

    // A currency whose symbol is not its code proves the chip follows the
    // formatter rather than printing the raw ISO code beside formatted cells.
    const euro = buildCommercialTruthExactModel(
      input({ business: { name: "Grandmix", currency: "EUR", timezone: "Europe/Berlin" } }),
    );
    expect(euro.currencyCode).toBe("EUR");
    expect(euro.currencySymbol).toBe("€");
    expect(euro.spendRows[0].spend).toContain(euro.currencySymbol);

    // And where the formatter itself prints the code, the chip prints the same.
    const lira = buildCommercialTruthExactModel(
      input({ business: { name: "Grandmix", currency: "TRY", timezone: "Europe/Istanbul" } }),
    );
    expect(lira.spendRows[0].spend).toContain(lira.currencySymbol);
  });
});
