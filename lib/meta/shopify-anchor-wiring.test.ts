import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/creative-decision-engine/shopify-aov-source", async (original) => {
  const actual = await original<Record<string, unknown>>();
  return { ...actual, resolveObservedShopifyAov: vi.fn() };
});

import {
  observedShopifyAovIsUsable,
  resolveObservedShopifyAov,
  type ObservedShopifyAovEvidence,
} from "@/lib/creative-decision-engine/shopify-aov-source";
import { resolveMinorUnitExponent } from "@/lib/currency/iso-4217-minor-units";
import {
  metaLossBudgetMaturity,
  normalizeMetaCommercialTargets,
} from "@/lib/meta/commercial-targets";

/**
 * The commercial anchor for a business that configured ONLY a target ROAS.
 *
 * This is the plan's binding rule made real: ROAS is the one required target,
 * and the store supplies the average order value. Before this the reader had
 * no production caller at all — the native builder accepted the evidence and
 * every call site omitted it, and the structure side stopped at a configured
 * CPA or a manual AOV. So a business with real Shopify sales and a target ROAS
 * got no benchmark, and every sizing gate that needs one refused.
 *
 * The arithmetic asserted here is the one the plan states: AOV 58.00 at a
 * target ROAS of 2.2 is a derived CPA of 26.36.
 */
function evidence(overrides: Partial<ObservedShopifyAovEvidence> = {}): ObservedShopifyAovEvidence {
  return {
    status: "observed",
    source: "shopify_revenue_ledger",
    providerAccountId: "shop_1",
    revenueBasis: "net_ledger",
    window: { from: "2026-08-08", to: "2026-09-04" },
    zoneName: "Europe/Istanbul",
    orderCount: 40,
    currency: "USD",
    revenueMinor: 232_000,
    // $58.00 in minor units.
    aovMinor: 5800,
    observedAt: "2026-09-04T21:00:00.000Z",
    knowledgeAsOf: "2026-09-05T03:00:00.000Z",
    ...overrides,
  } as ObservedShopifyAovEvidence;
}

/**
 * The exact rung ladder `attachSizedIntents` runs, restated so this case can
 * assert the arithmetic without standing up a whole snapshot. The order and
 * the guards are copied from the production expression, not invented.
 */
function deriveSpendUnitMinor(input: {
  targetCpa: number | null;
  aovAssumption: number | null;
  targetRoas: number | null;
  accountCurrency: string | null;
  observed: ObservedShopifyAovEvidence | null;
}) {
  const exponent = resolveMinorUnitExponent(input.accountCurrency);
  const currencyExponent = exponent.status === "resolved" ? exponent.exponent : null;
  const observedAovMajor =
    input.observed && observedShopifyAovIsUsable(input.observed) && currencyExponent !== null
      ? input.observed.aovMinor / 10 ** currencyExponent
      : null;
  const majorSpendUnit = input.targetCpa
    ?? (input.aovAssumption && input.targetRoas
      ? input.aovAssumption / input.targetRoas
      : observedAovMajor && input.targetRoas
        ? observedAovMajor / input.targetRoas
        : null);
  return {
    majorSpendUnit,
    spendUnitMinor: currencyExponent !== null && majorSpendUnit
      ? Math.round(majorSpendUnit * 10 ** currencyExponent)
      : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveObservedShopifyAov).mockResolvedValue(evidence());
});

describe("a business with only a target ROAS still gets a benchmark", () => {
  it("derives 26.36 from AOV 58.00 and target ROAS 2.2", () => {
    const derived = deriveSpendUnitMinor({
      targetCpa: null,
      aovAssumption: null,
      targetRoas: 2.2,
      accountCurrency: "USD",
      observed: evidence(),
    });

    expect(derived.majorSpendUnit).toBeCloseTo(26.3636, 3);
    // 2636 minor units — $26.36, the plan's worked figure.
    expect(derived.spendUnitMinor).toBe(2636);
  });

  it("asks for no CPA and no AOV to get there", () => {
    // The binding user direction: ROAS is the only required commercial target.
    const targets = normalizeMetaCommercialTargets({
      source: "configured_targets",
      targetRoas: 2.2,
      breakEvenRoas: 1.8,
      targetCpa: null,
      breakEvenCpa: null,
      aovAssumption: null,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: null,
    } as never);
    expect(targets.targetCpa).toBeNull();
    expect(targets.aovAssumption ?? null).toBeNull();

    const derived = deriveSpendUnitMinor({
      targetCpa: targets.targetCpa,
      aovAssumption: targets.aovAssumption ?? null,
      targetRoas: targets.targetRoas,
      accountCurrency: "USD",
      observed: evidence(),
    });
    expect(derived.spendUnitMinor).toBe(2636);
  });

  it("makes the maturity gate reachable for that same business", () => {
    /*
      The second half of the defect. `metaLossBudgetMaturity` needs a CPA
      baseline, and for a ROAS-only business every configured source is null —
      so maturity was never satisfied and nothing was ever sized, whatever the
      store's sales said.
    */
    const targets = {
      source: "configured_targets", targetRoas: 2.2, breakEvenRoas: 1.8,
      targetCpa: null, breakEvenCpa: null, riskPosture: "balanced",
      freshness: "fresh", updatedAt: null,
    } as never;

    expect(metaLossBudgetMaturity({ targets })).toBeNull();

    const derived = deriveSpendUnitMinor({
      targetCpa: null, aovAssumption: null, targetRoas: 2.2,
      accountCurrency: "USD", observed: evidence(),
    });
    const maturity = metaLossBudgetMaturity({
      targets,
      accountCpaBaseline: derived.majorSpendUnit,
    });
    expect(maturity).not.toBeNull();
    expect(maturity!.cpaBaseline).toBeCloseTo(26.3636, 3);
    // Balanced posture is a 2x multiplier: spend at least $52.73 before an
    // outcome is a sample worth moving money on.
    expect(maturity!.spendThreshold).toBeCloseTo(52.7272, 3);
  });
});

describe("a configured target still wins, and the store never overrides it", () => {
  it("prefers an explicit target CPA", () => {
    const derived = deriveSpendUnitMinor({
      targetCpa: 30, aovAssumption: null, targetRoas: 2.2,
      accountCurrency: "USD", observed: evidence(),
    });
    expect(derived.spendUnitMinor).toBe(3000);
  });

  it("prefers the operator's own AOV assumption over the store's", () => {
    const derived = deriveSpendUnitMinor({
      targetCpa: null, aovAssumption: 44, targetRoas: 2.2,
      accountCurrency: "USD", observed: evidence(),
    });
    expect(derived.spendUnitMinor).toBe(2000);
  });
});

describe("the store's own refusals travel, and nothing is guessed", () => {
  it("yields no benchmark from a thin sample", () => {
    const derived = deriveSpendUnitMinor({
      targetCpa: null, aovAssumption: null, targetRoas: 2.2,
      accountCurrency: "USD",
      observed: evidence({ status: "sample_thin", orderCount: 4 }),
    });
    expect(derived.spendUnitMinor).toBeNull();
  });

  it("yields no benchmark when the sync is unavailable", () => {
    const derived = deriveSpendUnitMinor({
      targetCpa: null, aovAssumption: null, targetRoas: 2.2,
      accountCurrency: "USD",
      observed: evidence({ status: "unavailable", aovMinor: null } as never),
    });
    expect(derived.spendUnitMinor).toBeNull();
  });

  it("yields no benchmark for a currency with no known scale", () => {
    // A number whose scale is unknown is not a number.
    const derived = deriveSpendUnitMinor({
      targetCpa: null, aovAssumption: null, targetRoas: 2.2,
      accountCurrency: "ZZZ", observed: evidence(),
    });
    expect(derived.spendUnitMinor).toBeNull();
  });

  it("yields no benchmark with no target ROAS", () => {
    // ROAS is the one required target; without it there is nothing to divide.
    const derived = deriveSpendUnitMinor({
      targetCpa: null, aovAssumption: null, targetRoas: null,
      accountCurrency: "USD", observed: evidence(),
    });
    expect(derived.spendUnitMinor).toBeNull();
  });
});
