import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The legacy preview.
 *
 * The defect this suite exists to prevent: `business_cost_models` declares
 * cogs/shipping/fee/fixed as `NOT NULL DEFAULT 0`, so every business has a row
 * of zeros the moment one is created. Reading those zeros as stated costs would
 * preview a brand new business as one whose product, shipping and payment costs
 * are all free — and a free cost is pure profit.
 */

const state: {
  costModel: Record<string, unknown> | null;
  targetPack: Record<string, unknown> | null;
  costModelReady: boolean;
  targetPackReady: boolean;
} = {
  costModel: null,
  targetPack: null,
  costModelReady: true,
  targetPackReady: true,
};

vi.mock("@/lib/db", () => {
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("commerce-cost-legacy-preview-cost-model")) {
      return state.costModel ? [state.costModel] : [];
    }
    if (text.includes("commerce-cost-legacy-preview-target-pack")) {
      return state.targetPack ? [state.targetPack] : [];
    }
    return [];
  });
  return { getDb: vi.fn(() => sql) };
});

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async (input: { tables: string[] }) => {
    const ready = input.tables.includes("business_cost_models")
      ? state.costModelReady
      : state.targetPackReady;
    return { ready, missingTables: ready ? [] : input.tables, checkedAt: "2026-09-17T00:00:00.000Z" };
  }),
  isMissingRelationError: vi.fn(
    (error: unknown) => (error as { code?: string } | null)?.code === "42P01",
  ),
}));

const preview = await import("@/lib/business-commerce-cost-preview");

const INPUT = {
  businessId: "11111111-1111-4111-8111-111111111111",
  reportingCurrency: "TRY",
  recordedAt: "2026-09-17T09:00:00.000Z",
  effectiveFrom: "2026-09-17T09:00:00.000Z",
};

function costModelRow(overrides: Record<string, unknown> = {}) {
  return {
    cogs_percent: 0,
    shipping_percent: 0,
    fee_percent: 0,
    fixed_monthly_cost: 0,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function targetPackRow(overrides: Record<string, unknown> = {}) {
  return {
    cost_cogs_percent: null,
    cost_shipping_percent: null,
    cost_fulfillment_percent: null,
    cost_payment_processing_percent: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  state.costModel = null;
  state.targetPack = null;
  state.costModelReady = true;
  state.targetPackReady = true;
  vi.clearAllMocks();
});

describe("a legacy zero is not a stated zero", () => {
  it("treats an all-zero cost model as nothing stated, not as costs of zero", async () => {
    state.costModel = costModelRow();

    const result = await preview.buildCostStructurePreview(INPUT);

    // The whole row is the column default. Previewing it would tell a new
    // business its costs are zero.
    expect(result.source).toBe("empty");
    expect(result.structure.components).toEqual([]);
    expect(result.ambiguousLegacyZeros).toEqual([
      "business_cost_models.cogs_percent",
      "business_cost_models.shipping_percent",
      "business_cost_models.fee_percent",
      "business_cost_models.fixed_monthly_cost",
    ]);
  });

  it("keeps the stated figures and drops only the ambiguous zeros", async () => {
    state.costModel = costModelRow({ cogs_percent: 0.35, shipping_percent: 0 });

    const result = await preview.buildCostStructurePreview(INPUT);

    expect(result.source).toBe("legacy_preview");
    const families = result.structure.components.map((entry) => entry.family);
    expect(families).toContain("product_purchase");
    // Shipping was zero in a column that defaults to zero: unstated, so no
    // component claims shipping is free.
    expect(families).not.toContain("outbound_shipping");
    expect(result.ambiguousLegacyZeros).toContain("business_cost_models.shipping_percent");
    expect(result.ambiguousLegacyZeros).not.toContain("business_cost_models.cogs_percent");
  });

  it("keeps a target-pack zero, because that column is nullable and 0 was typed", async () => {
    state.targetPack = targetPackRow({ cost_shipping_percent: 0 });

    const result = await preview.buildCostStructurePreview(INPUT);

    expect(result.source).toBe("legacy_preview");
    const shipping = result.structure.components.find(
      (entry) => entry.family === "outbound_shipping",
    );
    expect(shipping, "an operator stated shipping costs nothing").toBeTruthy();
    expect(result.ambiguousLegacyZeros).toEqual([]);
  });

  it("does not report ambiguity for a figure that was never zero", async () => {
    state.costModel = costModelRow({
      cogs_percent: 0.4,
      shipping_percent: 0.1,
      fee_percent: 0.03,
      fixed_monthly_cost: 30_000,
    });

    const result = await preview.buildCostStructurePreview(INPUT);
    expect(result.ambiguousLegacyZeros).toEqual([]);
    expect(result.structure.components.length).toBeGreaterThan(0);
  });

  it("reads a numeric arriving as a string as the same fact", async () => {
    state.costModel = costModelRow({ cogs_percent: "0.35" });

    const result = await preview.buildCostStructurePreview(INPUT);
    expect(result.source).toBe("legacy_preview");
    expect(result.ambiguousLegacyZeros).not.toContain("business_cost_models.cogs_percent");
  });

  it("reads a zero arriving as a string as ambiguous too", async () => {
    state.costModel = costModelRow({ cogs_percent: "0" });

    const result = await preview.buildCostStructurePreview(INPUT);
    expect(result.ambiguousLegacyZeros).toContain("business_cost_models.cogs_percent");
  });
});

describe("what the preview claims about itself", () => {
  it("is never confirmed and never carries a stored version", async () => {
    state.costModel = costModelRow({ cogs_percent: 0.35 });

    const result = await preview.buildCostStructurePreview(INPUT);

    expect(result.structure.confirmed).toBe(false);
    expect(result.structure.origin).toBe("legacy_import");
    // Version 0 is "never saved". The first save assigns 1.
    expect(result.structure.version).toBe(0);
  });

  it("produces an honest empty draft when there is nothing to preview", async () => {
    const result = await preview.buildCostStructurePreview(INPUT);

    expect(result.source).toBe("empty");
    expect(result.structure).toMatchObject({
      businessId: INPUT.businessId,
      version: 0,
      confirmed: false,
      reportingCurrency: "TRY",
      components: [],
    });
  });

  it("reports an unreadable legacy source instead of calling it absent", async () => {
    state.costModelReady = false;
    state.targetPack = targetPackRow({ cost_cogs_percent: 0.3 });

    const result = await preview.buildCostStructurePreview(INPUT);

    // The preview is honestly thinner, and says which source it could not read.
    expect(result.unreadableSources).toEqual(["business_cost_models"]);
    expect(result.source).toBe("legacy_preview");
  });

  it("reports both sources as unreadable without pretending the business has no costs", async () => {
    state.costModelReady = false;
    state.targetPackReady = false;

    const result = await preview.buildCostStructurePreview(INPUT);

    expect(result.unreadableSources).toEqual([
      "business_cost_models",
      "business_target_packs",
    ]);
    expect(result.source).toBe("empty");
    expect(result.structure.components).toEqual([]);
  });
});

describe("the ambiguous-zero column list matches what is actually read", () => {
  it("names every cost-model column the reader can flag", async () => {
    state.costModel = costModelRow();
    const result = await preview.buildCostStructurePreview(INPUT);

    expect([...preview.AMBIGUOUS_ZERO_COLUMNS].sort()).toEqual(
      [...result.ambiguousLegacyZeros].sort(),
    );
  });
});
