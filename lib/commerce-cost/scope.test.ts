/**
 * Unit tests for cost scope matching.
 *
 * Scope decides which cost component describes a given order line, so every
 * behaviour here is load-bearing for the numbers the product shows:
 *
 * - A predicate on a dimension the caller cannot supply must NOT match, and
 *   must be reported. Matching it would silently attach a foreign cost;
 *   dropping it quietly would report a missing cost as zero. Both are worse
 *   than saying "unknown", which is what `unknownDimensions` lets the resolver
 *   do.
 * - Specificity orders otherwise equal candidates, so a SKU-level rate must
 *   always outrank a channel-level one.
 * - `scopesMayOverlap` and `scopeSignature` feed validation, so the first must
 *   only ever claim disjointness it can prove, and the second must be stable
 *   across meaningless reorderings.
 *
 * These are pure functions: no fixtures, no resolver, no I/O.
 */
import { describe, expect, it } from "vitest";
import type {
  CostDimensionValues,
  CostLineContext,
  CostOrderContext,
  CostScopeDimension,
  CostScopePredicate,
} from "@/src/types/commerce-cost";
import {
  matchScope,
  mergeDimensionValues,
  scopeContextFor,
  scopeSignature,
  scopesMayOverlap,
} from "./scope";

// --- builders ---------------------------------------------------------------

const isIn = (dimension: CostScopeDimension, ...values: string[]): CostScopePredicate => ({
  dimension,
  operator: "in",
  values,
});

const notIn = (dimension: CostScopeDimension, ...values: string[]): CostScopePredicate => ({
  dimension,
  operator: "not_in",
  values,
});

const exists = (dimension: CostScopeDimension): CostScopePredicate => ({
  dimension,
  operator: "exists",
});

/** Keyed predicate, e.g. a single metafield namespace/key pair. */
const keyed = (
  dimension: CostScopeDimension,
  key: string,
  operator: CostScopePredicate["operator"],
  ...values: string[]
): CostScopePredicate => ({ dimension, key, operator, values });

/** A scope context is a plain lookup; built directly where the keys are keyed. */
const ctx = (entries: Array<[string, string[]]>): Map<string, string[]> => new Map(entries);

const order = (overrides: Partial<CostOrderContext> = {}): CostOrderContext => ({
  orderId: "order-1",
  occurredAt: "2026-09-10T09:00:00.000Z",
  occurredDate: "2026-09-10",
  currency: "TRY",
  ...overrides,
});

const line = (overrides: Partial<CostLineContext> = {}): CostLineContext => ({
  lineId: "line-1",
  quantity: 1,
  ...overrides,
});

/** Specificity of a single predicate against a context that supplies it. */
const weightOf = (dimension: CostScopeDimension): number =>
  matchScope([isIn(dimension, "x")], ctx([[dimension, ["x"]]])).specificity;

describe("matchScope", () => {
  it("treats an empty scope as store-wide with no specificity", () => {
    // A component with no scope is the fallback for everything, and must lose
    // every tie against a component that actually describes the line.
    expect(matchScope([], new Map())).toEqual({
      matched: true,
      specificity: 0,
      unknownDimensions: [],
    });
    expect(matchScope([], ctx([["channel", ["web"]]])).matched).toBe(true);
  });

  it("matches `in` case-insensitively and ignores surrounding whitespace", () => {
    // Channel and tag strings arrive from several platforms with inconsistent
    // casing and stray spaces; a cost must not hinge on that noise.
    const context = mergeDimensionValues({ channel: ["  WEB "] }, undefined);
    const result = matchScope([isIn("channel", " Web ")], context);
    expect(result.matched).toBe(true);
    expect(result.specificity).toBeGreaterThan(0);
    expect(result.unknownDimensions).toEqual([]);
  });

  it("does not match `in` when the supplied value is outside the set", () => {
    // A known-but-different channel is a definite non-match, not a gap: the
    // dimension must not be reported as unknown.
    const result = matchScope([isIn("channel", "pos")], ctx([["channel", ["web"]]]));
    expect(result.matched).toBe(false);
    expect(result.unknownDimensions).toEqual([]);
  });

  it("matches `not_in` only when the supplied value is outside the set", () => {
    const outside = matchScope([notIn("channel", "pos")], ctx([["channel", ["web"]]]));
    expect(outside.matched).toBe(true);
    expect(outside.specificity).toBe(weightOf("channel"));

    const inside = matchScope([notIn("channel", "pos")], ctx([["channel", ["pos"]]]));
    expect(inside.matched).toBe(false);
    expect(inside.unknownDimensions).toEqual([]);
  });

  it("excludes a line when any one of several values hits a `not_in` set", () => {
    // Order-level and line-level values merge into one entry, so an exclusion
    // has to consider all of them, not just the first.
    const context = mergeDimensionValues({ channel: ["web"] }, { channel: ["pos"] });
    expect(matchScope([notIn("channel", "pos")], context).matched).toBe(false);
  });

  it("matches `exists` on any supplied value and ignores the predicate's values", () => {
    const result = matchScope([exists("supplier")], ctx([["supplier", ["acme"]]]));
    expect(result.matched).toBe(true);
    expect(result.specificity).toBe(weightOf("supplier"));

    // `values` is documented as ignored by `exists`; stray values must not turn
    // a presence check into a membership check.
    const withStrayValues = matchScope(
      [{ dimension: "supplier", operator: "exists", values: ["someone-else"] }],
      ctx([["supplier", ["acme"]]]),
    );
    expect(withStrayValues.matched).toBe(true);
  });

  it("combines multiple predicates as AND", () => {
    const context = ctx([
      ["channel", ["web"]],
      ["market", ["tr"]],
    ]);
    expect(matchScope([isIn("channel", "web"), isIn("market", "tr")], context).matched).toBe(true);
    // One failing predicate sinks the whole scope even though the other passes.
    expect(matchScope([isIn("channel", "web"), isIn("market", "de")], context).matched).toBe(false);
    expect(matchScope([isIn("channel", "web"), notIn("market", "tr")], context).matched).toBe(false);
  });

  it("adds specificity across predicates", () => {
    // A two-dimension scope must outrank either dimension alone, so the weights
    // have to sum rather than take a maximum.
    const context = ctx([
      ["sku", ["sku-1"]],
      ["channel", ["web"]],
    ]);
    const both = matchScope([isIn("sku", "sku-1"), isIn("channel", "web")], context);
    expect(both.matched).toBe(true);
    expect(both.specificity).toBe(weightOf("sku") + weightOf("channel"));
    expect(both.specificity).toBeGreaterThan(weightOf("sku"));
  });

  it("orders identity dimensions above grouping dimensions", () => {
    // The relative order is the contract the resolver relies on; the absolute
    // numbers are an implementation detail.
    expect(weightOf("sku")).toBeGreaterThan(weightOf("variant_id"));
    expect(weightOf("variant_id")).toBeGreaterThan(weightOf("product_id"));
    expect(weightOf("product_id")).toBeGreaterThan(weightOf("collection"));
    expect(weightOf("collection")).toBeGreaterThan(weightOf("channel"));
  });

  it("ranks an unrecognised dimension below every known one", () => {
    // Stored structures can carry a dimension this build does not know about;
    // it gets a floor weight rather than zero or a crash.
    const unknownDimension = "loyalty_tier" as CostScopeDimension;
    const result = matchScope([isIn(unknownDimension, "gold")], ctx([[unknownDimension, ["gold"]]]));
    expect(result.matched).toBe(true);
    expect(result.specificity).toBeGreaterThan(0);
    expect(result.specificity).toBeLessThan(weightOf("metafield"));
  });

  it("only counts the specificity of predicates that actually passed", () => {
    // Specificity is only meaningful on a match; this pins the current
    // behaviour so a caller reading it on a non-match is not surprised.
    const context = ctx([
      ["sku", ["sku-1"]],
      ["channel", ["web"]],
    ]);
    const result = matchScope([isIn("sku", "sku-1"), isIn("channel", "pos")], context);
    expect(result.matched).toBe(false);
    expect(result.specificity).toBe(weightOf("sku"));
  });

  it("never matches `in` with no values, and always passes `not_in` with no values", () => {
    // Nothing rejects a value-less membership predicate upstream, so the
    // degenerate forms need defined behaviour: an empty allow-list selects
    // nothing, an empty deny-list excludes nothing.
    const context = ctx([["channel", ["web"]]]);
    expect(matchScope([{ dimension: "channel", operator: "in" }], context).matched).toBe(false);
    const emptyDeny = matchScope([{ dimension: "channel", operator: "not_in" }], context);
    expect(emptyDeny.matched).toBe(true);
    expect(emptyDeny.specificity).toBe(weightOf("channel"));
  });

  describe("keyed dimensions", () => {
    const keyedContext = ctx([
      ["metafield:bundle", ["kit"]],
      ["metafield:gift", ["yes"]],
    ]);

    it("matches only the entry under its own key", () => {
      expect(matchScope([keyed("metafield", "bundle", "in", "kit")], keyedContext).matched).toBe(
        true,
      );
      // The value "kit" exists in the context, but under a different key: a
      // metafield predicate must not be satisfied by a neighbouring metafield.
      const wrongKey = matchScope([keyed("metafield", "gift", "in", "kit")], keyedContext);
      expect(wrongKey.matched).toBe(false);
      expect(wrongKey.unknownDimensions).toEqual([]);
    });

    it("reports a key the context does not supply as unknown", () => {
      const result = matchScope([keyed("metafield", "warranty", "in", "yes")], keyedContext);
      expect(result.matched).toBe(false);
      expect(result.unknownDimensions).toEqual(["metafield:warranty"]);
    });

    it("does not let a keyed entry satisfy an unkeyed predicate", () => {
      const result = matchScope([isIn("metafield", "kit")], keyedContext);
      expect(result.matched).toBe(false);
      expect(result.unknownDimensions).toEqual(["metafield"]);
    });

    it("does not let a bare dimension answer a keyed predicate", () => {
      const bare = ctx([["metafield", ["kit"]]]);
      const result = matchScope([keyed("metafield", "bundle", "in", "kit")], bare);
      expect(result.matched).toBe(false);
      expect(result.unknownDimensions).toEqual(["metafield:bundle"]);
    });

    it("treats an explicitly null key as unkeyed", () => {
      const result = matchScope(
        [{ dimension: "metafield", operator: "in", values: ["kit"], key: null }],
        ctx([["metafield", ["kit"]]]),
      );
      expect(result.matched).toBe(true);
    });
  });

  describe("honesty about dimensions the context cannot supply", () => {
    // The whole point of `unknownDimensions`: the resolver turns these into an
    // explicit "unknown" rather than into a zero or a wrong attachment.
    it("refuses and reports an `in` predicate on an absent dimension", () => {
      const result = matchScope([isIn("channel", "web")], new Map());
      expect(result.matched).toBe(false);
      expect(result.unknownDimensions).toEqual(["channel"]);
      expect(result.specificity).toBe(0);
    });

    it("refuses and reports a `not_in` predicate on an absent dimension", () => {
      // Tempting to treat "we don't know the channel" as "not POS"; that would
      // quietly apply a cost the data cannot justify.
      const result = matchScope([notIn("channel", "pos")], new Map());
      expect(result.matched).toBe(false);
      expect(result.unknownDimensions).toEqual(["channel"]);
    });

    it("refuses and reports an `exists` predicate on an absent dimension", () => {
      const result = matchScope([exists("supplier")], new Map());
      expect(result.matched).toBe(false);
      expect(result.unknownDimensions).toEqual(["supplier"]);
    });

    it("reports every unsupplied dimension, not just the first", () => {
      const result = matchScope(
        [isIn("channel", "web"), exists("supplier"), notIn("market", "de")],
        new Map(),
      );
      expect(result.matched).toBe(false);
      expect(result.unknownDimensions).toEqual(["channel", "supplier", "market"]);
    });

    it("reports the gap even when the other predicates match", () => {
      const result = matchScope(
        [isIn("channel", "web"), isIn("supplier", "acme")],
        ctx([["channel", ["web"]]]),
      );
      expect(result.matched).toBe(false);
      expect(result.unknownDimensions).toEqual(["supplier"]);
      // The matching half still counted, which is why specificity alone is
      // never enough to pick a winner.
      expect(result.specificity).toBe(weightOf("channel"));
    });
  });
});

describe("mergeDimensionValues", () => {
  it("merges order-level and line-level values for the same dimension", () => {
    // A line can sit in an order-level market and carry its own supplier; both
    // must be matchable from one lookup.
    const merged = mergeDimensionValues({ market: ["TR"], channel: ["Web"] }, { supplier: ["Acme"] });
    expect(merged.get("market")).toEqual(["tr"]);
    expect(merged.get("channel")).toEqual(["web"]);
    expect(merged.get("supplier")).toEqual(["acme"]);
  });

  it("concatenates values when both levels name the same dimension", () => {
    const merged = mergeDimensionValues({ order_tag: ["Wholesale"] }, { order_tag: ["  urgent "] });
    expect(merged.get("order_tag")).toEqual(["wholesale", "urgent"]);
  });

  it("keeps repeats rather than de-duplicating", () => {
    // Matching is set-membership, so repeats are harmless; this pins the
    // current shape so a reader is not surprised by the array contents.
    const merged = mergeDimensionValues({ product_tag: ["Gift"] }, { product_tag: ["gift"] });
    expect(merged.get("product_tag")).toEqual(["gift", "gift"]);
  });

  it("keeps every value of a multi-valued dimension", () => {
    // Tags are the escape hatch for unforeseen distinctions, so a line with
    // three tags must stay matchable on all three.
    const merged = mergeDimensionValues(undefined, {
      product_tag: ["Fragile", "Heavy", "bundle-kit"],
    });
    expect(merged.get("product_tag")).toEqual(["fragile", "heavy", "bundle-kit"]);
  });

  it("drops empty and whitespace-only values", () => {
    const merged = mergeDimensionValues({ product_tag: ["", "  ", "Fragile"] }, undefined);
    expect(merged.get("product_tag")).toEqual(["fragile"]);
  });

  it("omits a dimension whose every value is blank instead of storing an empty entry", () => {
    // This is what keeps blank platform data honest: the dimension stays
    // absent, so a predicate on it reports unknown rather than producing a
    // false non-match against an empty list.
    const merged = mergeDimensionValues({ channel: ["", "   "] }, { channel: [] });
    expect(merged.has("channel")).toBe(false);
    expect(matchScope([isIn("channel", "web")], merged).unknownDimensions).toEqual(["channel"]);
  });

  it("returns an empty lookup when neither level supplies dimensions", () => {
    expect(mergeDimensionValues(undefined, undefined).size).toBe(0);
    expect(mergeDimensionValues({}, {}).size).toBe(0);
  });

  it("coerces non-string values", () => {
    // Dimension values arrive from JSON payloads where ids are often numbers;
    // they must still be matchable as strings.
    const fromJson = { variant_id: [1234] } as unknown as CostDimensionValues;
    const merged = mergeDimensionValues(fromJson, undefined);
    expect(merged.get("variant_id")).toEqual(["1234"]);
    expect(matchScope([isIn("variant_id", "1234")], merged).matched).toBe(true);
  });
});

describe("scopeContextFor", () => {
  it("makes line identity matchable like any other dimension", () => {
    const context = scopeContextFor(
      order(),
      line({ productId: "product-1", variantId: "variant-1", sku: "SKU-1" }),
    );
    expect(matchScope([isIn("product_id", "product-1")], context).matched).toBe(true);
    expect(matchScope([isIn("variant_id", "variant-1")], context).matched).toBe(true);
    // Identity is normalised too, so an operator-typed SKU in either casing
    // matches the platform's casing.
    expect(matchScope([isIn("sku", "sku-1")], context).matched).toBe(true);
    expect(matchScope([isIn("sku", " SKU-1 ")], context).matched).toBe(true);
  });

  it("skips null, undefined and blank identity fields", () => {
    // A line with no SKU must make a SKU-scoped cost report unknown: neither
    // matched, nor silently skipped.
    const context = scopeContextFor(order(), line({ productId: "product-1", variantId: null, sku: "" }));
    expect(context.has("variant_id")).toBe(false);
    expect(context.has("sku")).toBe(false);
    expect(matchScope([isIn("sku", "sku-1")], context).unknownDimensions).toEqual(["sku"]);
    expect(matchScope([exists("variant_id")], context).unknownDimensions).toEqual(["variant_id"]);
  });

  it("lets explicit dimensions and identity fields coexist", () => {
    const context = scopeContextFor(
      order({ dimensions: { channel: ["Web"], market: ["TR"] } }),
      line({ sku: "SKU-1", dimensions: { collection: ["Bedding"], product_tag: ["fragile"] } }),
    );
    const result = matchScope(
      [isIn("channel", "web"), isIn("collection", "bedding"), isIn("sku", "sku-1")],
      context,
    );
    expect(result.matched).toBe(true);
    expect(result.specificity).toBe(weightOf("channel") + weightOf("collection") + weightOf("sku"));
  });

  it("adds identity alongside an explicitly supplied value of the same dimension", () => {
    // The identity field appends rather than replaces, so a component scoped to
    // either id still matches — for example a parent product id supplied
    // explicitly for a bundle child.
    const context = scopeContextFor(
      order(),
      line({ productId: "product-child", dimensions: { product_id: ["product-parent"] } }),
    );
    expect(context.get("product_id")).toEqual(["product-parent", "product-child"]);
    expect(matchScope([isIn("product_id", "product-parent")], context).matched).toBe(true);
    expect(matchScope([isIn("product_id", "product-child")], context).matched).toBe(true);
  });

  it("supplies nothing for a line with no dimensions and no identity", () => {
    expect(scopeContextFor(order(), line()).size).toBe(0);
  });
});

describe("scopesMayOverlap", () => {
  it("proves disjointness for non-intersecting `in` sets on the same dimension", () => {
    expect(scopesMayOverlap([isIn("channel", "web")], [isIn("channel", "pos")])).toBe(false);
  });

  it("reports a possible overlap for intersecting `in` sets", () => {
    expect(scopesMayOverlap([isIn("channel", "web", "pos")], [isIn("channel", "pos", "app")])).toBe(
      true,
    );
  });

  it("proves disjointness when an `in` set sits entirely inside a `not_in` set", () => {
    const included = [isIn("channel", "pos")];
    const excluded = [notIn("channel", "pos", "app")];
    // Both argument orders must reach the same conclusion; validation calls
    // this with host and other in whichever order they were stored.
    expect(scopesMayOverlap(included, excluded)).toBe(false);
    expect(scopesMayOverlap(excluded, included)).toBe(false);
  });

  it("allows an overlap when an `in` set is only partly excluded", () => {
    // "web" survives the exclusion, so the two scopes can still meet.
    expect(scopesMayOverlap([isIn("channel", "web", "pos")], [notIn("channel", "pos")])).toBe(true);
    expect(scopesMayOverlap([notIn("channel", "pos")], [isIn("channel", "web", "pos")])).toBe(true);
  });

  it("cannot rule out an overlap across different dimensions", () => {
    // Nothing in a channel scope contradicts a market scope; a line can carry
    // both.
    expect(scopesMayOverlap([isIn("channel", "web")], [isIn("market", "tr")])).toBe(true);
  });

  it("treats empty scopes as possibly overlapping", () => {
    // A store-wide scope overlaps everything by construction.
    expect(scopesMayOverlap([], [])).toBe(true);
    expect(scopesMayOverlap([], [isIn("channel", "web")])).toBe(true);
    expect(scopesMayOverlap([isIn("channel", "web")], [])).toBe(true);
  });

  it("cannot rule out an overlap involving `exists`", () => {
    // `exists` constrains presence, not value, so it can never prove
    // disjointness.
    expect(scopesMayOverlap([exists("channel")], [isIn("channel", "web")])).toBe(true);
    expect(scopesMayOverlap([isIn("channel", "web")], [exists("channel")])).toBe(true);
    expect(scopesMayOverlap([exists("channel")], [notIn("channel", "web")])).toBe(true);
  });

  it("cannot rule out an overlap between two exclusions", () => {
    // Two deny-lists always share the values neither denies.
    expect(scopesMayOverlap([notIn("channel", "web")], [notIn("channel", "pos")])).toBe(true);
    expect(scopesMayOverlap([notIn("channel", "web")], [notIn("channel", "web")])).toBe(true);
  });

  it("proves disjointness for a value-less `in`, which selects nothing", () => {
    expect(
      scopesMayOverlap([{ dimension: "channel", operator: "in" }], [isIn("channel", "web")]),
    ).toBe(false);
  });

  it("keeps different keys of the same dimension independent", () => {
    // Two different metafields are two different dimensions, so no disjointness
    // can be proven from their values.
    expect(
      scopesMayOverlap(
        [keyed("metafield", "bundle", "in", "kit")],
        [keyed("metafield", "gift", "in", "kit")],
      ),
    ).toBe(true);
    expect(
      scopesMayOverlap([keyed("metafield", "bundle", "in", "kit")], [isIn("metafield", "box")]),
    ).toBe(true);
  });

  it("proves disjointness from a single contradicting dimension in a multi-predicate scope", () => {
    // Scopes are ANDs, so one contradiction is enough even when every other
    // dimension agrees.
    const left = [isIn("channel", "web"), isIn("market", "tr")];
    const right = [isIn("channel", "pos"), isIn("market", "tr")];
    expect(scopesMayOverlap(left, right)).toBe(false);
  });
});

describe("scopeSignature", () => {
  it("is independent of predicate order", () => {
    // Duplicate detection must not depend on the order an operator happened to
    // add predicates in.
    expect(scopeSignature([isIn("channel", "web"), isIn("market", "tr")])).toBe(
      scopeSignature([isIn("market", "tr"), isIn("channel", "web")]),
    );
  });

  it("is independent of value order, casing and whitespace", () => {
    expect(scopeSignature([isIn("channel", "web", "pos")])).toBe(
      scopeSignature([isIn("channel", " POS ", "Web")]),
    );
  });

  it("differs for different value sets", () => {
    expect(scopeSignature([isIn("channel", "web")])).not.toBe(
      scopeSignature([isIn("channel", "pos")]),
    );
    // A superset is a different situation, not the same one.
    expect(scopeSignature([isIn("channel", "web")])).not.toBe(
      scopeSignature([isIn("channel", "web", "pos")]),
    );
  });

  it("differs for different dimensions", () => {
    expect(scopeSignature([isIn("channel", "web")])).not.toBe(
      scopeSignature([isIn("market", "web")]),
    );
  });

  it("distinguishes operators on the same dimension and values", () => {
    // "only web" and "anything but web" are opposites; collapsing them would
    // hide a real conflict from validation.
    const included = scopeSignature([isIn("channel", "web")]);
    const excluded = scopeSignature([notIn("channel", "web")]);
    const present = scopeSignature([exists("channel")]);
    expect(new Set([included, excluded, present]).size).toBe(3);
  });

  it("distinguishes a keyed predicate from the bare dimension and from another key", () => {
    const bundle = scopeSignature([keyed("metafield", "bundle", "in", "kit")]);
    const gift = scopeSignature([keyed("metafield", "gift", "in", "kit")]);
    const bare = scopeSignature([isIn("metafield", "kit")]);
    expect(new Set([bundle, gift, bare]).size).toBe(3);
  });

  it("gives every empty scope the same signature", () => {
    // All store-wide components are "the same situation", which is how the
    // duplicate check catches two of them.
    expect(scopeSignature([])).toBe(scopeSignature([]));
    expect(scopeSignature([])).not.toBe(scopeSignature([isIn("channel", "web")]));
  });

  it("ignores values on an `exists` predicate, which matching ignores too", () => {
    // Documents current behaviour, not desired behaviour: matchScope ignores
    // `values` on an `exists` predicate, so these two scopes match identically
    // yet get different signatures. Reported as a suspected defect.
    expect(scopeSignature([exists("supplier")])).toBe(
      scopeSignature([{ dimension: "supplier", operator: "exists", values: ["acme"] }]),
    );
  });

  it("does not collide when a value itself contains a comma", () => {
    // Documents current behaviour: values are joined with "," so one value
    // containing a comma is indistinguishable from two values. Reported as a
    // suspected defect.
    expect(scopeSignature([isIn("product_tag", "a,b")])).not.toBe(
      scopeSignature([isIn("product_tag", "a", "b")]),
    );
  });
});
