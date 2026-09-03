/**
 * D084 r6 — the INDEPENDENT verification oracle.
 *
 * WHY THIS FILE EXISTS. r5's verifier called `buildWorldSpace`,
 * `foldWorldOutcomes`, `cooldownInWorld`, `capInWorld`, `concentrationInWorld`
 * and `lookbackInWorld` — the very functions that assembled the artifact — and
 * then declared the artifact verified when they agreed with themselves. A
 * shared algorithm error self-verified, which is exactly how the same-day
 * reversal bug survived: `blocked=[0,2]` for two same-day opposite-direction
 * actions was regenerated identically and passed.
 *
 * This module re-derives every answer from the frozen member rows using
 * DIFFERENT algorithms:
 *
 *   - partitions come from restricted-growth strings, not recursive insertion;
 *   - order extrema come from EXHAUSTIVELY ENUMERATING each bucket's k! local
 *     orders and evaluating each control from its definition ("is there a
 *     qualifying action before me in this order?"), not from a closed form.
 *
 * It imports types and the group-input shape. It imports no decision
 * arithmetic. If production and this module ever disagree, the artifact fails.
 *
 * SCOPE OF THE ORDER PROOF. Enumerating every total order of all 23 actions is
 * 23! and impossible. Enumerating every order INSIDE each (scope, day) bucket
 * is exact, because actions on different days are already ordered by day and
 * actions under different scope keys never see each other — so the admissible
 * total orders factorise into the buckets and an additive count's extrema add.
 * That factorisation claim is itself proved separately, in the tests, by a
 * whole-set total-order brute force over small fixtures.
 */

import { createHash } from "node:crypto";
import type { GroupInput, WorldScope } from "./d084-possible-worlds";

export type OracleControl = "cooldown" | "cap" | "lookback" | "repeat";

export interface OracleAction {
  actionKey: string;
  groupKey: string;
  day: string;
  direction: string;
  businessId: string;
  providerAccountId: string;
  entityKey: string | null;
}

export interface OracleWorld {
  worldKey: string;
  actions: OracleAction[];
}

export interface OracleSpace {
  worlds: OracleWorld[];
  worldCount: number;
  digest: string;
  groupCount: number;
  memberRowCount: number;
  actionLowerBound: number;
  actionUpperBound: number;
  indeterminateEntityActionKeys: string[];
}

export interface OracleCell {
  evaluatedLower: number;
  evaluatedUpper: number;
  blockedLower: number;
  blockedUpper: number;
  clearedLower: number;
  clearedUpper: number;
  guaranteedBlockedKeys: string[];
  possiblyBlockedKeys: string[];
  guaranteedClearKeys: string[];
  excludedActionsLower: number;
  excludedActionsUpper: number;
  /** World keys that actually produce each extremum, for witness checking. */
  worldsAchievingBlockedLower: string[];
  worldsAchievingBlockedUpper: string[];
  worldsAchievingClearedLower: string[];
  worldsAchievingClearedUpper: string[];
  worldsAchievingEvaluatedLower: string[];
  worldsAchievingEvaluatedUpper: string[];
  orderDependent: boolean;
}

// ---------------------------------------------------------------------------
// Partitions, by restricted-growth strings
// ---------------------------------------------------------------------------

/**
 * Every set partition of `n` items as a restricted-growth string.
 *
 * `a[0] = 0` and `a[i] <= 1 + max(a[0..i-1])`. This is a different derivation
 * from production's "insert the head into each block, or start a new one"
 * recursion; the two must nevertheless agree on the SET of partitions, which
 * is the property being cross-checked.
 */
function restrictedGrowthStrings(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  const current = new Array<number>(n).fill(0);
  const walk = (i: number, maxSoFar: number): void => {
    if (i === n) { out.push([...current]); return; }
    for (let v = 0; v <= maxSoFar + 1; v += 1) {
      current[i] = v;
      walk(i + 1, Math.max(maxSoFar, v));
    }
  };
  walk(1, 0);
  return out;
}

/**
 * The canonical action name, re-implemented rather than imported.
 *
 * The naming convention is part of the published contract, so the oracle
 * restates it. A production rename would surface here as a disagreement, which
 * is the intended behaviour for a verifier that trusts nothing.
 */
function nameAction(groupKey: string, block: readonly string[]): string {
  return `${groupKey}::${[...block].sort((a, b) => a.localeCompare(b)).join("+")}`;
}

function partitionsOfGroup(group: GroupInput): OracleAction[][] {
  const members = [...group.memberKeys];
  const entityOf = (m: string): string | undefined =>
    group.memberEntityKeys[group.memberKeys.indexOf(m)];
  const build = (blocks: string[][]): OracleAction[] =>
    blocks
      .map((block) => {
        const entities = Array.from(
          new Set(block.map(entityOf).filter((e): e is string => e !== undefined)),
        );
        return {
          actionKey: nameAction(group.key, block),
          groupKey: group.key,
          day: group.effectiveFrom,
          direction: group.direction,
          businessId: group.businessId,
          providerAccountId: group.providerAccountId,
          entityKey: entities.length === 1 ? entities[0]! : null,
        };
      })
      .sort((a, b) => a.actionKey.localeCompare(b.actionKey));

  if (group.exact || members.length <= 1) return [build([members])];

  const seen = new Set<string>();
  const out: OracleAction[][] = [];
  for (const rgs of restrictedGrowthStrings(members.length)) {
    const blocks: string[][] = [];
    rgs.forEach((b, i) => {
      while (blocks.length <= b) blocks.push([]);
      blocks[b]!.push(members[i]!);
    });
    const actions = build(blocks);
    const key = actions.map((a) => a.actionKey).join("+");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(actions);
  }
  return out.sort((a, b) =>
    a.map((x) => x.actionKey).join("|").localeCompare(b.map((x) => x.actionKey).join("|")));
}

export function oracleSpace(groups: readonly GroupInput[]): OracleSpace {
  const ordered = [...groups].sort((a, b) => a.key.localeCompare(b.key));
  const perGroup = ordered.map(partitionsOfGroup);
  let worlds: OracleWorld[] = [{ worldKey: "", actions: [] }];
  for (const options of perGroup) {
    const next: OracleWorld[] = [];
    for (const world of worlds) {
      for (const option of options) {
        next.push({
          worldKey: `${world.worldKey}|${option.map((a) => a.actionKey).join("+")}`,
          actions: [...world.actions, ...option],
        });
      }
    }
    worlds = next;
  }
  worlds = worlds
    .map((w) => ({ worldKey: w.worldKey.replace(/^\|/, ""), actions: w.actions }))
    .sort((a, b) => a.worldKey.localeCompare(b.worldKey));

  const counts = worlds.map((w) => w.actions.length);
  const indeterminate: string[] = [];
  for (const world of worlds) {
    for (const action of world.actions) {
      if (action.entityKey === null && !indeterminate.includes(action.actionKey)) {
        indeterminate.push(action.actionKey);
      }
    }
  }
  return {
    worlds,
    worldCount: worlds.length,
    digest: createHash("sha256").update(worlds.map((w) => w.worldKey).join("\n")).digest("hex"),
    groupCount: ordered.length,
    memberRowCount: ordered.reduce((s, g) => s + g.memberKeys.length, 0),
    actionLowerBound: Math.min(...counts),
    actionUpperBound: Math.max(...counts),
    indeterminateEntityActionKeys: indeterminate.sort((a, b) => a.localeCompare(b)),
  };
}

// ---------------------------------------------------------------------------
// Order extrema, by exhaustive enumeration
// ---------------------------------------------------------------------------

export function oracleScopeKey(action: OracleAction, scope: WorldScope): string | null {
  if (scope === "entity") return action.entityKey;
  if (scope === "account") return `${action.businessId}|${action.providerAccountId}`;
  if (scope === "business") return action.businessId;
  return "fleet";
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items];
    const [head] = rest.splice(i, 1);
    for (const tail of permutations(rest)) out.push([head as T, ...tail]);
  }
  return out;
}

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const dayGap = (from: string, to: string): number =>
  Math.round((dayMs(to) - dayMs(from)) / 86_400_000);

/** The control predicates, written from their definitions. */
function isBlocked(
  control: OracleControl,
  subject: OracleAction,
  before: readonly OracleAction[],
  param: number,
  indexInBucket: number,
): boolean {
  if (control === "cap") return indexInBucket > param;
  return before.some((p) => {
    const gap = dayGap(p.day, subject.day);
    if (control === "cooldown") return gap >= 0 && gap < param;
    if (gap < 0 || gap > param) return false;
    return control === "lookback"
      ? p.direction !== subject.direction
      : p.direction === subject.direction;
  });
}

/** One world, one control: exhaustive per-bucket order enumeration. */
export function oracleWorldOutcome(
  world: OracleWorld,
  scope: WorldScope,
  control: OracleControl,
  param: number,
  maxBucket = 8,
): {
  evaluated: number;
  excluded: number;
  blockedLower: number;
  blockedUpper: number;
  guaranteed: string[];
  possible: string[];
  present: string[];
  orderDependent: boolean;
} {
  const inScope: Array<{ action: OracleAction; key: string }> = [];
  let excluded = 0;
  for (const action of world.actions) {
    const key = oracleScopeKey(action, scope);
    if (key === null) { excluded += 1; continue; }
    inScope.push({ action, key });
  }

  const buckets = new Map<string, { key: string; day: string; actions: OracleAction[] }>();
  for (const { action, key } of inScope) {
    const id = `${key}|${action.day}`;
    if (!buckets.has(id)) buckets.set(id, { key, day: action.day, actions: [] });
    buckets.get(id)!.actions.push(action);
  }

  let lower = 0;
  let upper = 0;
  let orderDependent = false;
  const guaranteed: string[] = [];
  const possible: string[] = [];

  for (const bucket of Array.from(buckets.values())) {
    if (bucket.actions.length > maxBucket) {
      throw new Error(`the oracle refuses to enumerate ${bucket.actions.length}! local orders`);
    }
    // Everything in scope on a STRICTLY earlier day precedes this bucket under
    // every admissible order, so it is a fixed prefix.
    const prefix = inScope
      .filter((p) => p.key === bucket.key && p.action.day < bucket.day)
      .map((p) => p.action)
      .sort((a, b) => a.day.localeCompare(b.day));

    let bucketLower = Number.POSITIVE_INFINITY;
    let bucketUpper = Number.NEGATIVE_INFINITY;
    let intersection: string[] | null = null;
    const union: string[] = [];

    for (const order of permutations(bucket.actions)) {
      const blockedHere: string[] = [];
      order.forEach((subject, i) => {
        const before = [...prefix, ...order.slice(0, i)];
        if (isBlocked(control, subject, before, param, i + 1)) blockedHere.push(subject.actionKey);
      });
      bucketLower = Math.min(bucketLower, blockedHere.length);
      bucketUpper = Math.max(bucketUpper, blockedHere.length);
      intersection = intersection === null
        ? [...blockedHere]
        : intersection.filter((k) => blockedHere.includes(k));
      for (const k of blockedHere) if (!union.includes(k)) union.push(k);
    }
    if (!Number.isFinite(bucketLower)) { bucketLower = 0; bucketUpper = 0; }
    lower += bucketLower;
    upper += bucketUpper;
    if (bucketLower !== bucketUpper) orderDependent = true;
    for (const k of intersection ?? []) if (!guaranteed.includes(k)) guaranteed.push(k);
    for (const k of union) if (!possible.includes(k)) possible.push(k);
  }

  return {
    evaluated: inScope.length,
    excluded,
    blockedLower: lower,
    blockedUpper: upper,
    guaranteed: guaranteed.sort((a, b) => a.localeCompare(b)),
    possible: possible.sort((a, b) => a.localeCompare(b)),
    present: inScope.map((p) => p.action.actionKey),
    orderDependent,
  };
}

/**
 * Per-(space, scope, control, param) memo.
 *
 * The verifier asks for the same world sweep from three places — the cell
 * comparison, the per-cell exhaustive check and the ladder sweep. Enumerating
 * 640 worlds x k! orders three times over is pure waste; the results are pure
 * functions of the key, so they are cached per space object.
 */
const sweepCache = new WeakMap<OracleSpace, Map<string, ReturnType<typeof oracleWorldOutcome>[]>>();

export function oracleSweep(
  space: OracleSpace, scope: WorldScope, control: OracleControl, param: number,
): ReturnType<typeof oracleWorldOutcome>[] {
  let perSpace = sweepCache.get(space);
  if (!perSpace) { perSpace = new Map(); sweepCache.set(space, perSpace); }
  const key = `${scope}|${control}|${param}`;
  const hit = perSpace.get(key);
  if (hit) return hit;
  const rows = space.worlds.map((w) => oracleWorldOutcome(w, scope, control, param));
  perSpace.set(key, rows);
  return rows;
}

/** Fold every world of the space into one independently derived cell. */
export function oracleCell(
  space: OracleSpace,
  scope: WorldScope,
  control: OracleControl,
  param: number,
): OracleCell {
  let evaluatedLower = Number.POSITIVE_INFINITY;
  let evaluatedUpper = Number.NEGATIVE_INFINITY;
  let blockedLower = Number.POSITIVE_INFINITY;
  let blockedUpper = Number.NEGATIVE_INFINITY;
  let clearedLower = Number.POSITIVE_INFINITY;
  let clearedUpper = Number.NEGATIVE_INFINITY;
  let excludedLower = Number.POSITIVE_INFINITY;
  let excludedUpper = Number.NEGATIVE_INFINITY;
  let guaranteed: string[] | null = null;
  const possible: string[] = [];
  let presentEverywhere: string[] | null = null;
  let orderDependent = false;
  const achieving = {
    blockedLower: [] as string[], blockedUpper: [] as string[],
    clearedLower: [] as string[], clearedUpper: [] as string[],
    evaluatedLower: [] as string[], evaluatedUpper: [] as string[],
  };
  const rows = oracleSweep(space, scope, control, param)
    .map((o, i) => ({ w: space.worlds[i]!, o }));

  if (rows.length === 0 || rows.every((r) => r.o.evaluated === 0 && r.o.excluded === 0)) {
    if (rows.length === 0) {
      return {
        evaluatedLower: 0, evaluatedUpper: 0, blockedLower: 0, blockedUpper: 0,
        clearedLower: 0, clearedUpper: 0,
        guaranteedBlockedKeys: [], possiblyBlockedKeys: [], guaranteedClearKeys: [],
        excludedActionsLower: 0, excludedActionsUpper: 0,
        worldsAchievingBlockedLower: [], worldsAchievingBlockedUpper: [],
        worldsAchievingClearedLower: [], worldsAchievingClearedUpper: [],
        worldsAchievingEvaluatedLower: [], worldsAchievingEvaluatedUpper: [],
        orderDependent: false,
      };
    }
  }

  for (const { w, o } of rows) {
    if (o.orderDependent) orderDependent = true;
    evaluatedLower = Math.min(evaluatedLower, o.evaluated);
    evaluatedUpper = Math.max(evaluatedUpper, o.evaluated);
    blockedLower = Math.min(blockedLower, o.blockedLower);
    blockedUpper = Math.max(blockedUpper, o.blockedUpper);
    clearedLower = Math.min(clearedLower, o.evaluated - o.blockedUpper);
    clearedUpper = Math.max(clearedUpper, o.evaluated - o.blockedLower);
    excludedLower = Math.min(excludedLower, o.excluded);
    excludedUpper = Math.max(excludedUpper, o.excluded);
    guaranteed = guaranteed === null ? [...o.guaranteed] : guaranteed.filter((k) => o.guaranteed.includes(k));
    for (const k of o.possible) if (!possible.includes(k)) possible.push(k);
    presentEverywhere = presentEverywhere === null
      ? [...o.present]
      : presentEverywhere.filter((k) => o.present.includes(k));
  }
  for (const { w, o } of rows) {
    if (o.blockedLower === blockedLower) achieving.blockedLower.push(w.worldKey);
    if (o.blockedUpper === blockedUpper) achieving.blockedUpper.push(w.worldKey);
    if (o.evaluated - o.blockedUpper === clearedLower) achieving.clearedLower.push(w.worldKey);
    if (o.evaluated - o.blockedLower === clearedUpper) achieving.clearedUpper.push(w.worldKey);
    if (o.evaluated === evaluatedLower) achieving.evaluatedLower.push(w.worldKey);
    if (o.evaluated === evaluatedUpper) achieving.evaluatedUpper.push(w.worldKey);
  }

  return {
    evaluatedLower, evaluatedUpper, blockedLower, blockedUpper, clearedLower, clearedUpper,
    guaranteedBlockedKeys: (guaranteed ?? []).sort((a, b) => a.localeCompare(b)),
    possiblyBlockedKeys: possible.sort((a, b) => a.localeCompare(b)),
    guaranteedClearKeys: (presentEverywhere ?? [])
      .filter((k) => !possible.includes(k))
      .sort((a, b) => a.localeCompare(b)),
    excludedActionsLower: excludedLower, excludedActionsUpper: excludedUpper,
    worldsAchievingBlockedLower: achieving.blockedLower,
    worldsAchievingBlockedUpper: achieving.blockedUpper,
    worldsAchievingClearedLower: achieving.clearedLower,
    worldsAchievingClearedUpper: achieving.clearedUpper,
    worldsAchievingEvaluatedLower: achieving.evaluatedLower,
    worldsAchievingEvaluatedUpper: achieving.evaluatedUpper,
    orderDependent,
  };
}

/** Repeat bounds, folded the same way. */
export function oracleRepeatBounds(
  space: OracleSpace, scope: WorldScope, lookbackDays: number,
): { lower: number; upper: number } {
  let lower = Number.POSITIVE_INFINITY;
  let upper = Number.NEGATIVE_INFINITY;
  for (const o of oracleSweep(space, scope, "repeat", lookbackDays)) {
    lower = Math.min(lower, o.blockedLower);
    upper = Math.max(upper, o.blockedUpper);
  }
  return { lower: Number.isFinite(lower) ? lower : 0, upper: Number.isFinite(upper) ? upper : 0 };
}

/**
 * Concentration as a full cell, so witnesses can be checked like any other.
 *
 * There is no order space here: the share is |actions of one account on a day|
 * over |actions on that day|, a ratio of SETS. Permuting the day changes
 * neither, so every world's count is a point value and `orderDependent` is
 * false by construction rather than by assertion.
 */
export function oracleConcentrationCell(space: OracleSpace, maxShare: number): OracleCell {
  const rows = space.worlds.map((world) => {
    const byDay = new Map<string, OracleAction[]>();
    for (const a of world.actions) {
      if (!byDay.has(a.day)) byDay.set(a.day, []);
      byDay.get(a.day)!.push(a);
    }
    const blocked: string[] = [];
    for (const dayActions of byDay.values()) {
      const byAccount = new Map<string, OracleAction[]>();
      for (const a of dayActions) {
        const k = `${a.businessId}|${a.providerAccountId}`;
        if (!byAccount.has(k)) byAccount.set(k, []);
        byAccount.get(k)!.push(a);
      }
      for (const mine of byAccount.values()) {
        if (mine.length / dayActions.length > maxShare) for (const a of mine) blocked.push(a.actionKey);
      }
    }
    return {
      worldKey: world.worldKey,
      evaluated: world.actions.length,
      blocked: blocked.sort((a, b) => a.localeCompare(b)),
      present: world.actions.map((a) => a.actionKey),
    };
  });

  const evaluatedLower = Math.min(...rows.map((r) => r.evaluated));
  const evaluatedUpper = Math.max(...rows.map((r) => r.evaluated));
  const blockedLower = Math.min(...rows.map((r) => r.blocked.length));
  const blockedUpper = Math.max(...rows.map((r) => r.blocked.length));
  const clearedLower = Math.min(...rows.map((r) => r.evaluated - r.blocked.length));
  const clearedUpper = Math.max(...rows.map((r) => r.evaluated - r.blocked.length));
  let guaranteed: string[] | null = null;
  const possible: string[] = [];
  let present: string[] | null = null;
  for (const r of rows) {
    guaranteed = guaranteed === null ? [...r.blocked] : guaranteed.filter((k) => r.blocked.includes(k));
    for (const k of r.blocked) if (!possible.includes(k)) possible.push(k);
    present = present === null ? [...r.present] : present.filter((k) => r.present.includes(k));
  }
  return {
    evaluatedLower, evaluatedUpper, blockedLower, blockedUpper, clearedLower, clearedUpper,
    guaranteedBlockedKeys: (guaranteed ?? []).sort((a, b) => a.localeCompare(b)),
    possiblyBlockedKeys: possible.sort((a, b) => a.localeCompare(b)),
    guaranteedClearKeys: (present ?? []).filter((k) => !possible.includes(k)).sort((a, b) => a.localeCompare(b)),
    excludedActionsLower: 0, excludedActionsUpper: 0,
    worldsAchievingBlockedLower: rows.filter((r) => r.blocked.length === blockedLower).map((r) => r.worldKey),
    worldsAchievingBlockedUpper: rows.filter((r) => r.blocked.length === blockedUpper).map((r) => r.worldKey),
    worldsAchievingClearedLower: rows.filter((r) => r.evaluated - r.blocked.length === clearedLower).map((r) => r.worldKey),
    worldsAchievingClearedUpper: rows.filter((r) => r.evaluated - r.blocked.length === clearedUpper).map((r) => r.worldKey),
    worldsAchievingEvaluatedLower: rows.filter((r) => r.evaluated === evaluatedLower).map((r) => r.worldKey),
    worldsAchievingEvaluatedUpper: rows.filter((r) => r.evaluated === evaluatedUpper).map((r) => r.worldKey),
    orderDependent: false,
  };
}

/** Concentration, order-independent by construction: a ratio of sets. */
export function oracleConcentration(
  space: OracleSpace, maxShare: number,
): { blockedLower: number; blockedUpper: number; degenerateLower: number; degenerateUpper: number; totalDays: number } {
  let blockedLower = Number.POSITIVE_INFINITY;
  let blockedUpper = Number.NEGATIVE_INFINITY;
  let degenerateLower = Number.POSITIVE_INFINITY;
  let degenerateUpper = Number.NEGATIVE_INFINITY;
  let totalDays = 0;
  for (const world of space.worlds) {
    const byDay = new Map<string, OracleAction[]>();
    for (const a of world.actions) {
      if (!byDay.has(a.day)) byDay.set(a.day, []);
      byDay.get(a.day)!.push(a);
    }
    totalDays = byDay.size;
    let blocked = 0;
    let degenerate = 0;
    for (const dayActions of byDay.values()) {
      const byAccount = new Map<string, number>();
      for (const a of dayActions) {
        const k = `${a.businessId}|${a.providerAccountId}`;
        byAccount.set(k, (byAccount.get(k) ?? 0) + 1);
      }
      if (byAccount.size === 1) degenerate += 1;
      for (const n of byAccount.values()) {
        if (n / dayActions.length > maxShare) blocked += n;
      }
    }
    blockedLower = Math.min(blockedLower, blocked);
    blockedUpper = Math.max(blockedUpper, blocked);
    degenerateLower = Math.min(degenerateLower, degenerate);
    degenerateUpper = Math.max(degenerateUpper, degenerate);
  }
  return {
    blockedLower: Number.isFinite(blockedLower) ? blockedLower : 0,
    blockedUpper: Number.isFinite(blockedUpper) ? blockedUpper : 0,
    degenerateLower: Number.isFinite(degenerateLower) ? degenerateLower : 0,
    degenerateUpper: Number.isFinite(degenerateUpper) ? degenerateUpper : 0,
    totalDays,
  };
}
