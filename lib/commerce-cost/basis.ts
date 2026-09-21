import {
  COST_LINE_BASES,
  type CommerceCostComponent,
  type CostBase,
  type CostBasis,
  type CostBomComponent,
  type CostLineContext,
  type CostOrderContext,
  type CostRateTableRow,
} from "@/src/types/commerce-cost";
import { roundMoney } from "./money";
import { matchScope } from "./scope";

/**
 * Turning a basis into an amount.
 *
 * Nothing here invents a number. A percentage of a base the caller did not
 * supply, a rate table with no matching row and an unweighed parcel all return
 * null with a reason, which the resolver reports as unknown.
 */

export interface BasisAmount {
  /** In `currency`. Null when the basis could not be evaluated. */
  amount: number | null;
  currency: string;
  /** Whether the amount covers the whole order or just this line. */
  level: "order" | "line";
  estimated: boolean;
  reasons: string[];
}

export type BasisLevel = "order" | "line" | "period";

export function basisLevel(basis: CostBasis): BasisLevel {
  switch (basis.kind) {
    case "period_amount":
      return "period";
    case "amount_per_unit":
    case "amount_per_line":
    case "bom":
      return "line";
    case "amount_per_order":
      return "order";
    case "rate_table":
      return basis.level === "unit" ? "line" : "order";
    case "percent_of_base":
    case "percent_plus_fixed":
    case "margin_input":
      return COST_LINE_BASES.includes(basis.base) ? "line" : "order";
  }
}

function baseAmount(
  base: CostBase,
  order: CostOrderContext,
  line: CostLineContext | null,
): { value: number | null; currency: string } {
  const fromLine = COST_LINE_BASES.includes(base);
  const source = fromLine ? line?.bases : order.bases;
  const value = source?.[base];
  return {
    value: typeof value === "number" && Number.isFinite(value) ? value : null,
    currency: order.currency,
  };
}

function lookupRateRow(
  rows: readonly CostRateTableRow[],
  context: Map<string, string[]>,
  weightKg: number | null | undefined,
): { row: CostRateTableRow | null; reasons: string[] } {
  const reasons: string[] = [];
  for (const row of rows) {
    if (row.when && row.when.length > 0 && !matchScope(row.when, context).matched) continue;
    if (row.weightMaxKg !== null && row.weightMaxKg !== undefined) {
      if (typeof weightKg !== "number" || !Number.isFinite(weightKg)) {
        reasons.push("weight_unknown");
        continue;
      }
      if (weightKg > row.weightMaxKg) continue;
    }
    return { row, reasons };
  }
  return { row: null, reasons };
}

export interface BomChildCost {
  /** Already in the reporting currency. */
  amount: number | null;
  estimated: boolean;
  reasons: string[];
}

export interface BasisDependencies {
  reportingCurrency: string;
  /** Resolves one unit of a BOM child, in the reporting currency. */
  resolveChildUnitCost?: (child: CostBomComponent, depth: number) => BomChildCost;
  /** Converts a BOM amount stated in the host component currency. */
  convertStatedBomAmount?: (amount: number) => BomChildCost;
  depth?: number;
}

const MAX_BOM_DEPTH = 8;

/**
 * Evaluates a component for one line.
 *
 * Order-level bases return the whole order amount with `level: "order"`; the
 * caller allocates it across the lines the component applies to.
 */
export function evaluateBasis(args: {
  component: CommerceCostComponent;
  order: CostOrderContext;
  line: CostLineContext | null;
  scopeContext: Map<string, string[]>;
  deps: BasisDependencies;
}): BasisAmount {
  const { component, order, line, scopeContext, deps } = args;
  const basis = component.basis;
  const level = basisLevel(basis);
  const quantity = line?.quantity ?? 0;
  const reasons: string[] = [];

  if (level === "period") {
    return {
      amount: null,
      currency: component.currency,
      level: "order",
      estimated: false,
      reasons: ["period_component_not_order_scoped"],
    };
  }

  switch (basis.kind) {
    case "amount_per_unit":
      return {
        amount: roundMoney(basis.amount * quantity),
        currency: component.currency,
        level: "line",
        estimated: false,
        reasons,
      };

    case "amount_per_line":
      return {
        amount: roundMoney(basis.amount),
        currency: component.currency,
        level: "line",
        estimated: false,
        reasons,
      };

    case "amount_per_order":
      return {
        amount: roundMoney(basis.amount),
        currency: component.currency,
        level: "order",
        estimated: false,
        reasons,
      };

    case "percent_of_base": {
      const { value, currency } = baseAmount(basis.base, order, line);
      if (value === null) {
        return {
          amount: null,
          currency,
          level: level === "line" ? "line" : "order",
          estimated: false,
          reasons: [`base_unavailable:${basis.base}`],
        };
      }
      return {
        amount: roundMoney((value * basis.percent) / 100),
        currency,
        level: level === "line" ? "line" : "order",
        estimated: false,
        reasons,
      };
    }

    case "percent_plus_fixed": {
      const { value, currency } = baseAmount(basis.base, order, line);
      // The two halves are in different currencies only in pathological
      // setups; refusing beats silently adding unlike money.
      if (currency.toUpperCase() !== component.currency.toUpperCase()) {
        return {
          amount: null,
          currency,
          level: level === "line" ? "line" : "order",
          estimated: false,
          reasons: ["percent_plus_fixed_currency_mismatch"],
        };
      }
      if (value === null) {
        return {
          amount: null,
          currency,
          level: level === "line" ? "line" : "order",
          estimated: false,
          reasons: [`base_unavailable:${basis.base}`],
        };
      }
      const fixed =
        basis.fixedPer === "unit" ? basis.fixedAmount * quantity : basis.fixedAmount;
      return {
        amount: roundMoney((value * basis.percent) / 100 + fixed),
        currency,
        level: level === "line" ? "line" : "order",
        estimated: false,
        reasons,
      };
    }

    case "rate_table": {
      if (basis.rows.length === 0) {
        const fallback = basis.fallbackAmount;
        const hasFallback = typeof fallback === "number" && Number.isFinite(fallback);
        return {
          // An empty table falls back exactly the way a no-match does: rounded,
          // and multiplied by quantity when the table is priced per unit.
          amount: !hasFallback
            ? null
            : basis.level === "unit"
              ? roundMoney(fallback * quantity)
              : roundMoney(fallback),
          currency: component.currency,
          level: level === "line" ? "line" : "order",
          estimated: false,
          reasons: hasFallback ? ["rate_table_empty", "rate_table_fallback"] : ["rate_table_empty"],
        };
      }
      const weight = basis.level === "unit" ? line?.weightKg : order.weightKg;
      const { row, reasons: lookupReasons } = lookupRateRow(basis.rows, scopeContext, weight);
      if (!row) {
        const fallback = basis.fallbackAmount;
        const amount =
          typeof fallback === "number" && Number.isFinite(fallback) ? roundMoney(fallback) : null;
        return {
          amount: amount === null ? null : basis.level === "unit" ? roundMoney(amount * quantity) : amount,
          currency: component.currency,
          level: level === "line" ? "line" : "order",
          estimated: false,
          reasons: [...lookupReasons, amount === null ? "rate_table_no_match" : "rate_table_fallback"],
        };
      }
      return {
        amount: basis.level === "unit" ? roundMoney(row.amount * quantity) : roundMoney(row.amount),
        currency: component.currency,
        level: level === "line" ? "line" : "order",
        estimated: false,
        reasons: lookupReasons,
      };
    }

    case "bom": {
      const depth = deps.depth ?? 0;
      if (depth >= MAX_BOM_DEPTH) {
        return {
          amount: null,
          currency: deps.reportingCurrency,
          level: "line",
          estimated: false,
          reasons: ["bom_depth_exceeded"],
        };
      }
      if (basis.components.length === 0) {
        return {
          amount: null,
          currency: deps.reportingCurrency,
          level: "line",
          estimated: false,
          reasons: ["bom_empty"],
        };
      }
      let total = 0;
      let estimated = false;
      for (const child of basis.components) {
        if (typeof child.amount === "number" && Number.isFinite(child.amount)) {
          const stated =
            component.currency.toUpperCase() === deps.reportingCurrency.toUpperCase()
              ? { amount: child.amount, estimated: false, reasons: [] }
              : deps.convertStatedBomAmount?.(child.amount);
          if (!stated || stated.amount === null) {
            return {
              amount: null,
              currency: deps.reportingCurrency,
              level: "line",
              estimated: false,
              reasons: [
                ...reasons,
                "bom_stated_amount_currency_unresolved",
                ...(stated?.reasons ?? []),
              ],
            };
          }
          total += stated.amount * child.quantity;
          estimated = estimated || stated.estimated;
          reasons.push(...stated.reasons);
          continue;
        }
        const resolved = deps.resolveChildUnitCost?.(child, depth + 1);
        if (!resolved || resolved.amount === null) {
          return {
            amount: null,
            currency: deps.reportingCurrency,
            level: "line",
            estimated: false,
            // Keep what earlier children already explained; the refusal is not
            // a reason to lose the audit trail.
            reasons: [...reasons, "bom_child_unresolved", ...(resolved?.reasons ?? [])],
          };
        }
        total += resolved.amount * child.quantity;
        estimated = estimated || resolved.estimated;
        reasons.push(...resolved.reasons);
      }
      const waste = basis.wastePercent ?? 0;
      const unit = total * (1 + waste / 100);
      return {
        // BOM children are resolved in the reporting currency already.
        amount: roundMoney(unit * quantity),
        currency: deps.reportingCurrency,
        level: "line",
        estimated,
        reasons,
      };
    }

    case "margin_input": {
      const { value, currency } = baseAmount(basis.base, order, line);
      if (value === null) {
        return {
          amount: null,
          currency,
          level: level === "line" ? "line" : "order",
          estimated: false,
          reasons: [`base_unavailable:${basis.base}`],
        };
      }
      return {
        amount: roundMoney(value * (1 - basis.marginPercent / 100)),
        currency,
        level: level === "line" ? "line" : "order",
        estimated: false,
        reasons: ["implied_from_margin"],
      };
    }

    case "period_amount":
      return {
        amount: null,
        currency: component.currency,
        level: "order",
        estimated: false,
        reasons: ["period_component_not_order_scoped"],
      };
  }
}

export function allocationWeight(
  driver: "revenue" | "units" | "orders" | "weight" | "equal",
  line: CostLineContext,
): number {
  switch (driver) {
    case "revenue": {
      const value = line.bases?.line_net_sales ?? line.bases?.line_gross_sales ?? null;
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
    }
    case "units":
      return Number.isFinite(line.quantity) && line.quantity > 0 ? line.quantity : 0;
    case "weight": {
      const weight = line.weightKg;
      return typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? weight : 0;
    }
    case "orders":
    case "equal":
      return 1;
  }
}
