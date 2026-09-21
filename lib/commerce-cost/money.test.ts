import { describe, expect, it } from "vitest";

import {
  allocateMoney,
  convertMoney,
  periodDays,
  proratePeriodAmount,
  roundMoney,
  sameMoney,
} from "./money";

/** Minor units, so an assertion never fails on a float representation gap
 * that the money contract does not care about. The `+ 0` normalises -0 to 0,
 * which `toBe` (Object.is) would otherwise treat as a different value. */
function toMinor(value: number): number {
  return Math.round(value * 100) + 0;
}

function sumMinor(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + toMinor(value), 0);
}

describe("roundMoney", () => {
  it("absorbs binary float artefacts that would otherwise leak a stray cent", () => {
    // 0.1 + 0.2 is 0.30000000000000004; a resolver that carried that forward
    // would show 0.30000000000000004 in a cost breakdown.
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(0.07 * 3)).toBe(0.21);
    expect(roundMoney(1.13 * 3)).toBe(3.39);
  });

  it("rounds the exact half up, including the halves float stores just below", () => {
    // 1.005 and 2.675 are stored slightly BELOW their decimal value, so plain
    // Math.round(value * 100) gives 1.00 and 2.67. The Number.EPSILON nudge is
    // there to recover the intended half-up result; this is what it buys.
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(0.005)).toBe(0.01);
    expect(roundMoney(0.015)).toBe(0.02);
    expect(roundMoney(100.555)).toBe(100.56);
  });

  it("keeps values that are already at cent precision byte-identical", () => {
    // Re-rounding is common (allocate, convert, then round again) and must be
    // idempotent or repeated passes would drift.
    for (const value of [0, 1, 12.34, -12.34, 0.01, 999.99, 1_000_000.5]) {
      expect(roundMoney(value)).toBe(value);
      expect(roundMoney(roundMoney(value))).toBe(roundMoney(value));
    }
  });

  it("rounds negatives away from zero, so a reversal keeps its magnitude", () => {
    // A refund is a negative amount, and it must give back the same cent the
    // sale took. Rounding halves toward +Infinity would shrink it.
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(-2.675)).toBe(-2.68);
    expect(roundMoney(-0.015)).toBe(-0.02);
    expect(roundMoney(-0.006)).toBe(-0.01);
    // Symmetry: the magnitude never depends on the sign.
    for (const value of [1.005, 2.675, 0.015, 12.345, 999.995]) {
      expect(roundMoney(-value)).toBe(-roundMoney(value));
    }
  });

  it("drops sub-cent dust to zero", () => {
    expect(roundMoney(0.001)).toBe(0);
    expect(roundMoney(0.004)).toBe(0);
    expect(roundMoney(0.006)).toBe(0.01);
    // A negative sub-cent normalises to a plain 0, so identity comparisons and
    // snapshots downstream cannot see a stray negative zero.
    expect(Object.is(roundMoney(-0.004), 0)).toBe(true);
    expect(roundMoney(-0.004) === 0).toBe(true);
  });

  it("still rounds at magnitudes a real ad account can reach", () => {
    expect(roundMoney(1_000_000_000_000.005)).toBe(1_000_000_000_000.01);
    expect(roundMoney(123_456_789.987)).toBe(123_456_789.99);
  });

  it("propagates non-finite input instead of inventing a number", () => {
    // Callers gate on Number.isFinite themselves (see convertMoney); roundMoney
    // must not quietly turn NaN into 0.
    expect(roundMoney(Number.NaN)).toBeNaN();
    expect(roundMoney(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(roundMoney(Number.NEGATIVE_INFINITY)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("sameMoney", () => {
  it("treats sub-cent differences as the same money", () => {
    // Two paths to the same cost (allocated vs. recomputed) differ in the last
    // float bits; that must not read as a discrepancy.
    expect(sameMoney(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameMoney(1, 1.004)).toBe(true);
    expect(sameMoney(1.23, 1.2349)).toBe(true);
    expect(sameMoney(10.001, 9.999)).toBe(true);
    expect(sameMoney(-0, 0)).toBe(true);
    expect(sameMoney(5, 5)).toBe(true);
  });

  it("rejects a difference of a full half-cent or more", () => {
    // 0.005 is the exclusive bound: at exactly half a cent the two amounts are
    // no longer the same money.
    expect(sameMoney(0, 0.005)).toBe(false);
    expect(sameMoney(0, 0.0049999)).toBe(true);
    expect(sameMoney(0, -0.005)).toBe(false);
    expect(sameMoney(1, 1.01)).toBe(false);
    expect(sameMoney(100, 99.99)).toBe(false);
  });

  it("is float-tolerant at the boundary rather than exact", () => {
    // 1.005 - 1 evaluates to 0.004999999999999893, one bit under the bound, so
    // this pair compares equal even though the decimals differ by exactly half
    // a cent. The tolerance is fuzzy by nature; callers must not rely on the
    // boundary being decimal-exact.
    expect(1.005 - 1).toBeLessThan(0.005);
    expect(sameMoney(1, 1.005)).toBe(true);
  });

  it("is symmetric", () => {
    expect(sameMoney(1.2349, 1.23)).toBe(sameMoney(1.23, 1.2349));
    expect(sameMoney(1.01, 1)).toBe(sameMoney(1, 1.01));
  });

  it("never reports non-finite amounts as equal", () => {
    // Math.abs(NaN) and Infinity - Infinity both give NaN, and NaN < 0.005 is
    // false, so a corrupt amount can never pass a reconciliation check.
    expect(sameMoney(Number.NaN, Number.NaN)).toBe(false);
    expect(sameMoney(Number.NaN, 1)).toBe(false);
    expect(sameMoney(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(false);
    expect(sameMoney(Number.POSITIVE_INFINITY, 1)).toBe(false);
  });
});

describe("allocateMoney", () => {
  it("returns nothing to allocate for an empty weight list", () => {
    // No lines means the caller has nowhere to put the cost; it must not get a
    // phantom element back.
    expect(allocateMoney(10, [])).toEqual([]);
    expect(allocateMoney(0, [])).toEqual([]);
  });

  it("gives a single line the whole rounded amount", () => {
    expect(allocateMoney(10, [1])).toEqual([10]);
    expect(allocateMoney(10, [0])).toEqual([10]);
    expect(allocateMoney(1.005, [3])).toEqual([1.01]);
  });

  it("spreads an amount that does not divide evenly and keeps the total", () => {
    // 10 over three equal lines is the canonical largest-remainder case: the
    // stray cent goes to the first line, never to nobody.
    expect(allocateMoney(10, [1, 1, 1])).toEqual([3.34, 3.33, 3.33]);
    expect(sumMinor(allocateMoney(10, [1, 1, 1]))).toBe(1000);
  });

  it("places single cents deterministically when every line rounds to zero", () => {
    // One cent across four lines: three lines legitimately get nothing. The
    // alternative (rounding each to 0.01) would invent three cents of cost.
    expect(allocateMoney(0.01, [1, 1, 1, 1])).toEqual([0.01, 0, 0, 0]);
    expect(allocateMoney(0.03, [1, 1, 1, 1, 1])).toEqual([0.01, 0.01, 0.01, 0, 0]);
  });

  it("respects weight ratios", () => {
    expect(allocateMoney(1, [1, 2, 3])).toEqual([0.17, 0.33, 0.5]);
    expect(allocateMoney(100, [1, 3])).toEqual([25, 75]);
  });

  it("gives zero-weight lines nothing while positive weights exist", () => {
    // A line with no qty/revenue must not absorb cost that belongs to lines
    // that actually drove it.
    expect(allocateMoney(10, [0, 1, 1])).toEqual([0, 5, 5]);
    expect(allocateMoney(5, [1, 0])).toEqual([5, 0]);
  });

  it("falls back to an equal split when no weight is usable", () => {
    // The documented fallback: the cost exists, so it still has to land. This
    // covers all-zero, negative, and non-finite weight vectors.
    expect(allocateMoney(10, [0, 0, 0])).toEqual([3.34, 3.33, 3.33]);
    expect(allocateMoney(10, [-1, -2])).toEqual([5, 5]);
    expect(allocateMoney(10, [Number.NaN, Number.NaN])).toEqual([5, 5]);
    expect(allocateMoney(10, [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toEqual([5, 5]);
  });

  it("ignores a non-finite weight rather than letting it swallow the amount", () => {
    // Infinity/NaN are clamped to 0, so a corrupt weight yields nothing for
    // that line instead of NaN shares for all of them.
    expect(allocateMoney(10, [Number.POSITIVE_INFINITY, 1])).toEqual([0, 10]);
    expect(allocateMoney(10, [Number.NaN, 1, 1])).toEqual([0, 5, 5]);
  });

  it("allocates negative amounts (refunds) without losing the sign or a cent", () => {
    // The remainder walk runs backwards for negatives; the total must still be
    // exact. Note the leftover cent lands on a different index than for the
    // mirrored positive amount, because flooring biases negatives downward.
    expect(allocateMoney(-10, [1, 1, 1])).toEqual([-3.33, -3.33, -3.34]);
    expect(allocateMoney(-0.01, [1, 1, 1, 1])).toEqual([0, 0, 0, -0.01]);
    expect(sumMinor(allocateMoney(-10, [1, 1, 1]))).toBe(-1000);
  });

  it("marks skipped lines of a negative allocation with a negative zero", () => {
    // 0 * negativeTotal is -0 and Math.floor keeps it, so a zero-weight line of
    // a refund comes back as -0. It compares === 0 but not Object.is 0, which
    // matters for snapshot and Object.is based assertions downstream.
    const allocated = allocateMoney(-10, [0, 1, 1]);
    expect(allocated[0] === 0).toBe(true);
    expect(Object.is(allocated[0], -0)).toBe(true);
    expect(sumMinor(allocated)).toBe(-1000);
  });

  it("rounds the amount before splitting it", () => {
    // Otherwise sub-cent input dust would be distributed and the result would
    // not sum to roundMoney(amount).
    expect(sumMinor(allocateMoney(10.004, [1, 1, 1]))).toBe(1000);
    expect(sumMinor(allocateMoney(10.006, [1, 1, 1]))).toBe(1001);
    expect(allocateMoney(0.004, [1, 1])).toEqual([0, 0]);
  });

  it("returns one entry per weight, always", () => {
    // Callers zip the result back onto their line array by index.
    for (const weights of [[1], [1, 1], [0, 0, 0], [1, 0, 3, 0, 5], [2, 2, 2, 2, 2, 2, 2]]) {
      expect(allocateMoney(7.77, weights)).toHaveLength(weights.length);
    }
  });

  it("stays exact at large values", () => {
    expect(allocateMoney(1_000_000_000, [1, 1, 1])).toEqual([
      333_333_333.34, 333_333_333.33, 333_333_333.33,
    ]);
    expect(sumMinor(allocateMoney(999_999.99, [7, 11, 13]))).toBe(99_999_999);
  });

  it("never loses or invents a cent, over many amounts and weight vectors", () => {
    // The single invariant the whole module exists for: an order-level cost
    // spread over lines adds back up to exactly what was spread. A property
    // loop rather than examples, because the failures here are arithmetic
    // corner cases nobody picks by hand.
    const amounts: number[] = [
      0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.1, 0.33, 0.99, 1, 1.01, 1.005, 2.675, 3.33,
      9.99, 10, 33.335, 99.995, 100, 1234.56, 1_234_567.89, 7, 13.13, 0.004, 0.006,
      -0.01, -0.02, -0.07, -1, -1.005, -9.99, -10, -33.335, -1_234_567.89, -0.004,
    ];
    // A spread of irregular magnitudes and mantissas, to hit remainders of
    // every size between 0 and weights.length - 1.
    for (let index = 0; index < 120; index += 1) {
      amounts.push((index * 7919) / 100 - 500 + (index % 13) / 100);
    }

    const weightVectors: number[][] = [
      [1],
      [1, 1],
      [1, 2],
      [1, 1, 1],
      [2, 3],
      [0, 1],
      [1, 0],
      [0, 0],
      [0, 0, 0, 0],
      [3, 5, 7, 11],
      [1, 0, 0, 0],
      [5, 0, 5, 0, 5],
      [0.1, 0.2, 0.7],
      [1e6, 1, 1],
      [1, 1e-6],
      [2, 2, 2, 2, 2, 2, 2],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [Number.NaN, 1, 2],
      [-1, -1, -1],
    ];

    for (const amount of amounts) {
      const expectedMinor = toMinor(roundMoney(amount));
      for (const weights of weightVectors) {
        const allocated = allocateMoney(amount, weights);
        expect(allocated).toHaveLength(weights.length);
        // Exact in minor units...
        expect(sumMinor(allocated)).toBe(expectedMinor);
        // ...and still exact once summed as floats and re-rounded, which is
        // how a reconciliation check actually compares the two sides.
        expect(sameMoney(allocated.reduce((sum, value) => sum + value, 0), roundMoney(amount))).toBe(
          true,
        );
        // Every share is itself cent-precise; a leftover fraction would show
        // up as an unroundable number in a breakdown. `+ 0` normalises the -0
        // that a skipped line of a negative allocation produces, since the
        // sign of zero is not what this assertion is about.
        for (const share of allocated) {
          expect(roundMoney(share) + 0).toBe(share + 0);
        }
      }
    }
  });

  it("keeps a positive allocation non-negative and a negative one non-positive", () => {
    // A share that flips sign would read as a credit on one line and a charge
    // on another out of a single cost.
    for (const weights of [[1, 1, 1], [0, 1, 5], [3, 0, 0], [1, 2, 3, 4, 5]]) {
      for (const share of allocateMoney(0.07, weights)) expect(share).toBeGreaterThanOrEqual(0);
      for (const share of allocateMoney(-0.07, weights)) expect(share).toBeLessThanOrEqual(0);
    }
  });
});

describe("convertMoney", () => {
  it("needs no rate when the currency already matches", () => {
    expect(convertMoney(123.456, "TRY", "TRY")).toBe(123.46);
    expect(convertMoney(0, "USD", "USD")).toBe(0);
  });

  it("matches the currency pair case-insensitively", () => {
    // Provider payloads are inconsistent about currency casing; a lowercase
    // "try" against reporting "TRY" must not be treated as a conversion.
    expect(convertMoney(10, "try", "TRY")).toBe(10);
    expect(convertMoney(10, "TRY", "try")).toBe(10);
    expect(convertMoney(10, "Try", "tRy")).toBe(10);
  });

  it("reads the rate table with an upper-cased key", () => {
    expect(convertMoney(100, "usd", "TRY", { USD: 34.5 })).toBe(3450);
    expect(convertMoney(100, "USD", "TRY", { USD: 34.5 })).toBe(3450);
  });

  it("falls back to the key exactly as given when the upper-cased one is absent", () => {
    // The `?? rates?.[from]` fallback: a lowercase table key still resolves so
    // long as `from` is spelled the same way.
    expect(convertMoney(100, "usd", "TRY", { usd: 34.5 })).toBe(3450);
  });

  it("returns null when the table key casing does not line up", () => {
    // Asymmetry worth knowing: lookup tries UPPER then the literal `from`, so
    // an upper-cased `from` can never reach a lower-cased table key.
    expect(convertMoney(100, "USD", "TRY", { usd: 34.5 })).toBeNull();
  });

  it("returns null for a missing rate instead of mixing currencies", () => {
    // The documented contract: the caller reports the family unavailable
    // rather than adding USD into a TRY sum at an implied rate of 1.
    expect(convertMoney(100, "USD", "TRY")).toBeNull();
    expect(convertMoney(100, "USD", "TRY", {})).toBeNull();
    expect(convertMoney(100, "USD", "TRY", { EUR: 40 })).toBeNull();
  });

  it("refuses a rate that cannot produce a real amount", () => {
    // Zero or negative rates come from bad seed data; using them would zero out
    // or sign-flip real cost.
    expect(convertMoney(100, "USD", "TRY", { USD: 0 })).toBeNull();
    expect(convertMoney(100, "USD", "TRY", { USD: -34.5 })).toBeNull();
    expect(convertMoney(100, "USD", "TRY", { USD: Number.NaN })).toBeNull();
    expect(convertMoney(100, "USD", "TRY", { USD: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("ignores a rate entry that is not a number at all", () => {
    // The Record type says number, but the table is built from untyped JSON.
    const rates = { USD: "34.5" } as unknown as Record<string, number>;
    expect(convertMoney(100, "USD", "TRY", rates)).toBeNull();
  });

  it("does not resolve a rate off the object prototype", () => {
    // "constructor"/"toString" as a currency code must not find a function.
    expect(convertMoney(100, "toString", "TRY", {})).toBeNull();
    expect(convertMoney(100, "constructor", "TRY", { USD: 34.5 })).toBeNull();
  });

  it("prefers a pinned fixedRate over the live table", () => {
    // A contracted/locked rate on the component beats whatever the table says.
    expect(convertMoney(100, "USD", "TRY", { USD: 34.5 }, 30)).toBe(3000);
    expect(convertMoney(100, "USD", "TRY", undefined, 30)).toBe(3000);
  });

  it("ignores an unusable fixedRate and falls back to the table", () => {
    // A 0/negative/NaN pin is bad data, not an instruction to zero the cost.
    expect(convertMoney(100, "USD", "TRY", { USD: 34.5 }, 0)).toBe(3450);
    expect(convertMoney(100, "USD", "TRY", { USD: 34.5 }, -30)).toBe(3450);
    expect(convertMoney(100, "USD", "TRY", { USD: 34.5 }, Number.NaN)).toBe(3450);
    expect(convertMoney(100, "USD", "TRY", { USD: 34.5 }, Number.POSITIVE_INFINITY)).toBe(3450);
    expect(convertMoney(100, "USD", "TRY", { USD: 34.5 }, null)).toBe(3450);
    // With no table behind it there is nothing to fall back to.
    expect(convertMoney(100, "USD", "TRY", undefined, 0)).toBeNull();
  });

  it("does not apply a fixedRate to a same-currency amount", () => {
    // The same-currency short circuit runs first, so a stale pin cannot
    // re-scale an amount that is already in the reporting currency.
    expect(convertMoney(100, "TRY", "TRY", { TRY: 2 }, 2)).toBe(100);
  });

  it("rounds the converted amount to cents", () => {
    expect(convertMoney(1234.567, "USD", "TRY", { USD: 1.5 })).toBe(1851.85);
    expect(convertMoney(33.333, "USD", "TRY", { USD: 0.03 })).toBe(1);
    expect(convertMoney(0.001, "USD", "TRY", { USD: 1 })).toBe(0);
  });

  it("converts negative amounts (refunds) as-is", () => {
    expect(convertMoney(-100, "USD", "TRY", { USD: 34.5 })).toBe(-3450);
    expect(convertMoney(-123.456, "TRY", "TRY")).toBe(-123.46);
  });

  it("returns null for a non-finite amount before looking at anything else", () => {
    // Guards the same-currency path too, so NaN cannot pass through unchecked.
    expect(convertMoney(Number.NaN, "TRY", "TRY")).toBeNull();
    expect(convertMoney(Number.POSITIVE_INFINITY, "TRY", "TRY")).toBeNull();
    expect(convertMoney(Number.NEGATIVE_INFINITY, "USD", "TRY", { USD: 34.5 })).toBeNull();
    expect(convertMoney(Number.NaN, "USD", "TRY", undefined, 30)).toBeNull();
  });
});

describe("periodDays", () => {
  it("uses a fixed year fraction for a month so windows stay comparable", () => {
    // Deliberately not a calendar month: the same subscription cost must
    // prorate identically in February and in March.
    expect(periodDays("day")).toBe(1);
    expect(periodDays("week")).toBe(7);
    expect(periodDays("month")).toBe(365 / 12);
    expect(periodDays("year")).toBe(365);
  });

  it("keeps twelve months equal to one year exactly", () => {
    // If this drifts, a monthly and a yearly component covering the same span
    // would disagree.
    expect(periodDays("month") * 12).toBe(periodDays("year"));
    expect(periodDays("week") * 52).toBeLessThan(periodDays("year"));
  });
});

describe("proratePeriodAmount", () => {
  it("prorates each period over a window", () => {
    expect(proratePeriodAmount(10, "day", 3)).toBe(30);
    expect(proratePeriodAmount(70, "week", 1)).toBe(10);
    expect(proratePeriodAmount(100, "month", 30)).toBe(98.63);
    expect(proratePeriodAmount(100, "year", 30)).toBe(8.22);
  });

  it("returns the whole amount when the window is exactly one period", () => {
    // The identity case: proration must not shave a cent off a full period.
    expect(proratePeriodAmount(10, "day", 1)).toBe(10);
    expect(proratePeriodAmount(70, "week", 7)).toBe(70);
    expect(proratePeriodAmount(100, "month", periodDays("month"))).toBe(100);
    expect(proratePeriodAmount(365, "year", 365)).toBe(365);
    expect(proratePeriodAmount(-30, "month", periodDays("month"))).toBe(-30);
  });

  it("handles a fractional window", () => {
    expect(proratePeriodAmount(100, "day", 0.5)).toBe(50);
    expect(proratePeriodAmount(100, "month", 1)).toBe(3.29);
  });

  it("prorates negative amounts", () => {
    expect(proratePeriodAmount(-100, "month", 30)).toBe(-98.63);
    expect(proratePeriodAmount(-10, "day", 3)).toBe(-30);
  });

  it("returns zero for a zero amount rather than null", () => {
    // A real zero-cost component is still a resolved cost, not missing data.
    expect(proratePeriodAmount(0, "day", 5)).toBe(0);
    expect(proratePeriodAmount(0, "month", 30)).toBe(0);
  });

  it("returns null for a non-positive window", () => {
    // A zero-length or inverted window means the caller's date range is broken;
    // a 0 here would silently understate cost instead of surfacing that.
    expect(proratePeriodAmount(100, "month", 0)).toBeNull();
    expect(proratePeriodAmount(100, "month", -1)).toBeNull();
    expect(proratePeriodAmount(100, "day", -0.5)).toBeNull();
    expect(proratePeriodAmount(100, "day", -0)).toBeNull();
  });

  it("returns null for non-finite input on either side", () => {
    expect(proratePeriodAmount(Number.NaN, "month", 30)).toBeNull();
    expect(proratePeriodAmount(Number.POSITIVE_INFINITY, "month", 30)).toBeNull();
    expect(proratePeriodAmount(Number.NEGATIVE_INFINITY, "day", 1)).toBeNull();
    expect(proratePeriodAmount(100, "month", Number.NaN)).toBeNull();
    expect(proratePeriodAmount(100, "month", Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rounds the prorated amount to cents", () => {
    // Sub-cent daily rates must not leak a long float into a cost breakdown.
    expect(proratePeriodAmount(0.0001, "day", 1)).toBe(0);
    expect(proratePeriodAmount(1, "year", 3)).toBe(0.01);
    const prorated = proratePeriodAmount(1234.56, "month", 17);
    expect(prorated).not.toBeNull();
    expect(roundMoney(prorated!)).toBe(prorated);
  });

  it("splits a window into parts that add back up to the whole", () => {
    // How a recurring cost is actually consumed: two adjacent windows must not
    // together exceed the period's own amount by more than rounding.
    const first = proratePeriodAmount(100, "month", 10)!;
    const second = proratePeriodAmount(100, "month", 20.416666666666668)!;
    expect(sameMoney(first + second, 100)).toBe(true);
  });
});
