/**
 * Money helpers for the cost resolver.
 *
 * Every amount is carried in minor units while it is being divided, so an
 * order-level cost spread over lines adds back up to exactly the amount that
 * was spread. Allocation that loses or invents a cent turns into a profit
 * discrepancy nobody can explain.
 */

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return value;
  // Half away from zero, so a refund of -1.005 keeps its full magnitude
  // instead of quietly shrinking the way Math.round would. `+ 0` normalises
  // the negative zero that would otherwise fail an identity comparison.
  // The nudge has to happen before scaling: 2.675 is stored just below its
  // decimal value, and at 267.5 the epsilon is far too small to recover it.
  const scaled = Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100;
  return (value < 0 ? -scaled : scaled) + 0;
}

/** True when two amounts are the same money at cent precision. */
export function sameMoney(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.005;
}

/**
 * Splits `amount` across `weights` with the largest-remainder method.
 *
 * The result always sums to `roundMoney(amount)`. Non-positive or absent total
 * weight falls back to an equal split, because a cost that exists still has to
 * land somewhere.
 */
export function allocateMoney(amount: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  // A non-finite amount has no shares. Without this guard the remainder loop
  // below can never reach zero and spins forever.
  if (!Number.isFinite(amount)) return weights.map(() => Number.NaN);
  const totalMinor = Math.round(roundMoney(amount) * 100);
  const safeWeights = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
  const shares =
    totalWeight > 0
      ? safeWeights.map((weight) => (weight / totalWeight) * totalMinor)
      : safeWeights.map(() => totalMinor / safeWeights.length);

  const floored = shares.map((share) => Math.floor(share));
  let remainder = totalMinor - floored.reduce((sum, value) => sum + value, 0);
  const order = shares
    .map((share, index) => ({ index, fraction: share - Math.floor(share) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);

  const result = [...floored];
  // A negative amount leaves a negative remainder; walk the same order back.
  const step = remainder >= 0 ? 1 : -1;
  let cursor = 0;
  while (remainder !== 0 && order.length > 0) {
    const target = order[cursor % order.length]!.index;
    result[target] = result[target]! + step;
    remainder -= step;
    cursor += 1;
  }

  return result.map((minor) => minor / 100);
}

/**
 * Converts to the reporting currency.
 *
 * `rates` holds units of the reporting currency per 1 unit of the keyed
 * currency. A missing rate returns null: the caller reports the family as
 * unavailable rather than mixing currencies into one sum.
 */
export function convertMoney(
  amount: number,
  from: string,
  to: string,
  rates?: Readonly<Record<string, number>>,
  fixedRate?: number | null,
): number | null {
  if (!Number.isFinite(amount)) return null;
  if (from.toUpperCase() === to.toUpperCase()) return roundMoney(amount);
  if (typeof fixedRate === "number" && Number.isFinite(fixedRate) && fixedRate > 0) {
    return roundMoney(amount * fixedRate);
  }
  const rate = rates?.[from.toUpperCase()] ?? rates?.[from];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return roundMoney(amount * rate);
}

const PERIOD_DAYS = {
  day: 1,
  week: 7,
  // Calendar-month proration would make the same monthly cost land differently
  // in February and March. A fixed year fraction keeps windows comparable.
  month: 365 / 12,
  year: 365,
} as const;

/** Days of a period, used to prorate a recurring amount into a window. */
export function periodDays(period: keyof typeof PERIOD_DAYS): number {
  return PERIOD_DAYS[period];
}

export function proratePeriodAmount(
  amount: number,
  period: keyof typeof PERIOD_DAYS,
  windowDays: number,
): number | null {
  if (!Number.isFinite(amount) || !Number.isFinite(windowDays) || windowDays <= 0) return null;
  return roundMoney((amount / PERIOD_DAYS[period]) * windowDays);
}
