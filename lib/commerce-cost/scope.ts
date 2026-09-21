import type {
  CostDimensionValues,
  CostLineContext,
  CostOrderContext,
  CostScopeDimension,
  CostScopePredicate,
} from "@/src/types/commerce-cost";

/**
 * Scope matching for cost components.
 *
 * A predicate on a dimension the caller cannot supply does NOT match. An
 * unknown channel must not silently pull in a channel-specific cost, and it
 * must not silently drop one either — the family ends up with no owner, which
 * the resolver reports as unknown rather than as zero.
 */

/**
 * How specific each dimension is. The winner among equally-evidenced
 * components is the one that describes the narrower situation.
 */
const DIMENSION_SPECIFICITY: Readonly<Record<CostScopeDimension, number>> = {
  sku: 100,
  variant_id: 95,
  product_id: 80,
  collection: 60,
  product_tag: 58,
  supplier: 55,
  location: 50,
  order_tag: 45,
  customer_tag: 42,
  order_type: 40,
  payment_method: 35,
  shipping_method: 34,
  discount_code: 32,
  channel: 30,
  market: 28,
  metafield: 25,
};

function normalizeValues(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => String(value).trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function dimensionKey(predicate: CostScopePredicate): string {
  return predicate.key ? `${predicate.dimension}:${predicate.key}` : predicate.dimension;
}

/** Collapses order-level and line-level dimension values into one lookup. */
export function mergeDimensionValues(
  order: CostDimensionValues | undefined,
  line: CostDimensionValues | undefined,
): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const source of [order, line]) {
    if (!source) continue;
    for (const [dimension, values] of Object.entries(source)) {
      const normalized = normalizeValues(values as readonly string[] | undefined);
      if (normalized.length === 0) continue;
      const current = merged.get(dimension) ?? [];
      merged.set(dimension, [...current, ...normalized]);
    }
  }
  return merged;
}

/** Line identity is matched like any other dimension. */
export function scopeContextFor(
  order: CostOrderContext,
  line: CostLineContext,
): Map<string, string[]> {
  const merged = mergeDimensionValues(order.dimensions, line.dimensions);
  const identity: Array<[CostScopeDimension, string | null | undefined]> = [
    ["product_id", line.productId],
    ["variant_id", line.variantId],
    ["sku", line.sku],
  ];
  for (const [dimension, value] of identity) {
    const normalized = normalizeValues(value ? [value] : []);
    if (normalized.length === 0) continue;
    merged.set(dimension, [...(merged.get(dimension) ?? []), ...normalized]);
  }
  return merged;
}

export interface ScopeMatch {
  matched: boolean;
  /** Higher wins a tie between equally-evidenced components. */
  specificity: number;
  /** Dimensions the predicate needed but the context could not supply. */
  unknownDimensions: readonly string[];
}

export function matchScope(
  scope: readonly CostScopePredicate[],
  context: Map<string, string[]>,
): ScopeMatch {
  if (scope.length === 0) return { matched: true, specificity: 0, unknownDimensions: [] };

  let specificity = 0;
  const unknownDimensions: string[] = [];
  let matched = true;

  for (const predicate of scope) {
    const key = dimensionKey(predicate);
    // A keyed predicate is exact. Falling back from `metafield:bundle` to the
    // unkeyed `metafield` bucket can attach a supplier/product cost to the
    // wrong classification while still reporting a confident match.
    const contextValues = context.get(key) ?? [];
    const weight = DIMENSION_SPECIFICITY[predicate.dimension] ?? 20;

    if (contextValues.length === 0) {
      // The dimension is unknown here, so this component cannot be said to
      // apply. Reported, so the gap surfaces as unknown instead of as zero.
      matched = false;
      unknownDimensions.push(key);
      continue;
    }

    const wanted = normalizeValues(predicate.values);
    if (predicate.operator === "exists") {
      specificity += weight;
      continue;
    }
    const intersects = contextValues.some((value) => wanted.includes(value));
    if (predicate.operator === "in" ? !intersects : intersects) {
      matched = false;
      continue;
    }
    specificity += weight;
  }

  return { matched, specificity, unknownDimensions };
}

/**
 * Whether two scopes could ever describe the same line.
 *
 * Used by validation to spot a family that is both embedded in a host and
 * modelled separately. It answers "may overlap", never "does overlap": the
 * only definite answer available without data is disjointness on a shared
 * dimension.
 */
export function scopesMayOverlap(
  left: readonly CostScopePredicate[],
  right: readonly CostScopePredicate[],
): boolean {
  for (const leftPredicate of left) {
    for (const rightPredicate of right) {
      if (dimensionKey(leftPredicate) !== dimensionKey(rightPredicate)) continue;
      const leftValues = normalizeValues(leftPredicate.values);
      const rightValues = normalizeValues(rightPredicate.values);
      if (leftPredicate.operator === "in" && rightPredicate.operator === "in") {
        if (!leftValues.some((value) => rightValues.includes(value))) return false;
      }
      if (leftPredicate.operator === "in" && rightPredicate.operator === "not_in") {
        if (leftValues.length > 0 && leftValues.every((value) => rightValues.includes(value))) {
          return false;
        }
      }
      if (leftPredicate.operator === "not_in" && rightPredicate.operator === "in") {
        if (rightValues.length > 0 && rightValues.every((value) => leftValues.includes(value))) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Stable signature for "the same situation", used to spot duplicates.
 *
 * Separators are control characters, not punctuation, so a tag containing a
 * comma cannot make two different scopes look identical. `exists` ignores its
 * values when matching, so the signature ignores them too.
 */
export function scopeSignature(scope: readonly CostScopePredicate[]): string {
  return scope
    .map((predicate) =>
      [
        dimensionKey(predicate),
        predicate.operator,
        predicate.operator === "exists"
          ? ""
          : normalizeValues(predicate.values).slice().sort().join("\u0000"),
      ].join("\u0001"),
    )
    .sort()
    .join("\u0002");
}
