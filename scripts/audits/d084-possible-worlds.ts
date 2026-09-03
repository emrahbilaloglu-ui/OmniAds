/**
 * D084 r5 — the coupled possible-action-world model.
 *
 * WHY THIS FILE EXISTS. r4 gave every safety grid interval fields but kept
 * looping over one item per economic GROUP. Cooldown, concentration and
 * lookback therefore evaluated an exact population of 14 while the
 * source-authenticated members permit 14-23 economic actions, and the cap grid
 * combined extrema drawn from worlds that cannot coexist. That produced a
 * published cell no arithmetic can justify:
 *
 *   cap=1, scope=entity: evaluated=[14,23] blocked=[0,20] cleared=[-6,23]
 *
 * `clearedLower` was `evaluatedLower - blockedUpper` — the fewest actions in
 * one world minus the most blocked in a different world. A count of actions
 * cannot be negative.
 *
 * The repair is a single representation used by all four safety families:
 * enumerate the admissible worlds ONCE from the frozen member rows, evaluate
 * each control inside each world where `blocked + cleared = evaluated` holds by
 * construction, and take minima and maxima over that one complete set.
 *
 * SEMANTICS, stated so nothing here is mistaken for something else. A
 * "possible economic action" is one block of a set partition of a group's
 * retained transition members. It models how many distinct operator decisions
 * those provider-side rows could represent. It is NOT a provider mutation
 * count, NOT an operator click, and NOT a mirrored observation: the bytes
 * cannot distinguish those, which is exactly why the count is a range.
 */

import { createHash } from "node:crypto";

export type WorldScope = "entity" | "account" | "business" | "fleet";

/** One block of one partition: a single possible economic action. */
export interface PossibleAction {
  /** Canonical identity: the group key and the SORTED member keys of its block. */
  actionKey: string;
  groupKey: string;
  memberKeys: string[];
  businessId: string;
  business: string;
  providerAccountId: string;
  day: string;
  direction: string;
  percent: number | null;
  /**
   * The entity this action targets, when the block's members agree.
   *
   * A block merging members of different entities has no determinate target:
   * the bytes cannot say which entity a single merged decision aimed at. r4
   * added the whole group's multiplicity range to EVERY candidate entity
   * bucket, which counts one possible action several times over.
   */
  entityKey: string | null;
  entityIndeterminateWhy: string | null;
}

export interface PossibleWorld {
  worldKey: string;
  actions: PossibleAction[];
}

export interface GroupInput {
  key: string;
  businessId: string;
  business: string;
  providerAccountId: string;
  effectiveFrom: string;
  direction: string;
  percent: number | null;
  /** Sorted member identities, from the frozen transition rows. */
  memberKeys: string[];
  memberEntityKeys: string[];
  /** True when the group is proved to be exactly one action. */
  exact: boolean;
}

/** Every set partition of `items`, deterministically ordered. */
export function setPartitions<T>(items: readonly T[]): T[][][] {
  if (items.length === 0) return [[]];
  const [first, ...rest] = items;
  const out: T[][][] = [];
  for (const partition of setPartitions(rest)) {
    // `first` joins each existing block...
    for (let i = 0; i < partition.length; i += 1) {
      const copy = partition.map((block) => [...block]);
      copy[i]!.unshift(first as T);
      out.push(copy);
    }
    // ...or starts its own.
    out.push([[first as T], ...partition.map((block) => [...block])]);
  }
  return out;
}

function actionOf(group: GroupInput, block: readonly string[]): PossibleAction {
  const memberKeys = [...block].sort((a, b) => a.localeCompare(b));
  const entities = new Set(
    memberKeys.map((m) => group.memberEntityKeys[group.memberKeys.indexOf(m)]).filter((e): e is string => e !== undefined),
  );
  const determinate = entities.size === 1;
  return {
    actionKey: `${group.key}::${memberKeys.join("+")}`,
    groupKey: group.key,
    memberKeys,
    businessId: group.businessId,
    business: group.business,
    providerAccountId: group.providerAccountId,
    day: group.effectiveFrom,
    direction: group.direction,
    percent: group.percent,
    entityKey: determinate ? Array.from(entities)[0]! : null,
    entityIndeterminateWhy: determinate
      ? null
      : `this block merges members across ${entities.size} entities (${Array.from(entities).sort().join(", ")}), and the retained rows cannot say which one a single merged decision targeted`,
  };
}

/** Every admissible partition of one group, as candidate action sets. */
export function groupPartitions(group: GroupInput): PossibleAction[][] {
  if (group.exact || group.memberKeys.length <= 1) {
    return [[actionOf(group, group.memberKeys)]];
  }
  return setPartitions(group.memberKeys)
    .map((partition) => partition.map((block) => actionOf(group, block)))
    .map((actions) => actions.sort((a, b) => a.actionKey.localeCompare(b.actionKey)))
    .sort((a, b) => a.map((x) => x.actionKey).join("|").localeCompare(b.map((x) => x.actionKey).join("|")));
}

export interface WorldSpace {
  worlds: PossibleWorld[];
  worldCount: number;
  digest: string;
  groupCount: number;
  memberRowCount: number;
  actionLowerBound: number;
  actionUpperBound: number;
  ambiguousGroupCount: number;
  partitionsPerGroup: Record<string, number>;
  /** Actions whose entity target cannot be determined, in any world. */
  indeterminateEntityActionKeys: string[];
  semantics: string;
}

/**
 * Enumerate the complete world space.
 *
 * The space is the Cartesian product of each group's admissible partitions.
 * With seven two-member groups (2 partitions each) and one three-member group
 * (5 partitions), that is 2^7 x 5 = 640 worlds — small enough to prove
 * exhaustively rather than sample. The size is DERIVED here, never assumed:
 * a bound guards against an accidental explosion instead of a hardcoded count.
 */
export const D084_MAX_WORLDS = 200_000;

export function buildWorldSpace(groups: readonly GroupInput[]): WorldSpace {
  const ordered = [...groups].sort((a, b) => a.key.localeCompare(b.key));
  const perGroup = ordered.map((g) => groupPartitions(g));
  const partitionsPerGroup: Record<string, number> = {};
  ordered.forEach((g, i) => { partitionsPerGroup[g.key] = perGroup[i]!.length; });

  const projected = perGroup.reduce((n, p) => n * p.length, 1);
  if (projected > D084_MAX_WORLDS) {
    throw new Error(
      `D084 refuses to enumerate ${projected} worlds; the exhaustive proof is only honest while the space is small`,
    );
  }

  let worlds: PossibleWorld[] = [{ worldKey: "", actions: [] }];
  for (const options of perGroup) {
    const next: PossibleWorld[] = [];
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
    ambiguousGroupCount: ordered.filter((g) => !g.exact && g.memberKeys.length > 1).length,
    partitionsPerGroup,
    indeterminateEntityActionKeys: indeterminate.slice().sort((a, b) => a.localeCompare(b)),
    semantics:
      "one possible economic action is one block of a set partition of a group's retained transition members; it models how many distinct operator decisions those provider-side rows could represent, and is not a provider mutation count, an operator click, or a mirrored observation",
  };
}

export function scopeKeyOf(action: PossibleAction, scope: WorldScope): string | null {
  if (scope === "entity") return action.entityKey;
  if (scope === "account") return `${action.businessId}|${action.providerAccountId}`;
  if (scope === "business") return action.businessId;
  return "fleet";
}

/**
 * One same-day, same-scope order bucket.
 *
 * WHY BUCKETS. Two actions on DIFFERENT days already have a settled order, and
 * two actions under different scope keys never see each other. The only thing
 * the retained rows leave open is the relative order INSIDE one (scope, day)
 * bucket, because no transition row carries an action time. So the space of
 * admissible total orders factorises exactly into the buckets, and the extrema
 * of an additive count compose by summation with no slack.
 */
export interface OrderBucketLineage {
  bucketKey: string;
  scopeKey: string;
  day: string;
  /** k: actions sharing this scope and day. */
  actionCount: number;
  /** m: distinct directions inside the bucket. */
  distinctDirections: number;
  /** Actions this bucket blocks under EVERY order because of earlier days. */
  determinedBlocked: number;
  blockedLower: number;
  blockedUpper: number;
  /** k! — this bucket's local order space; null once it exceeds exact integers. */
  admissibleOrders: number | null;
  orderIndependent: boolean;
}

/**
 * One world's outcome for one control.
 *
 * r5 published `blockedGuaranteed` / `blockedMax` and derived them from the
 * CARDINALITY of the guaranteed and possible identity sets. Those are two
 * different questions, and conflating them published counts no total order can
 * produce: two same-day opposite-direction actions came out as blocked=[0,2]
 * when every admissible order blocks exactly one — the first action has no
 * prior and the second is the only reversal. The fields are now honest counts
 * derived from admissible ORDERS, kept separate from the identity sets.
 */
export interface WorldOutcome {
  evaluated: number;
  /** Fewest blocked over all admissible total orders of this world. */
  blockedLower: number;
  /** Most blocked over all admissible total orders of this world. */
  blockedUpper: number;
  /** Blocked under EVERY admissible order (an intersection, not a count). */
  blockedIdentitiesGuaranteed: string[];
  /** Blocked under SOME admissible order (a union, not a count). */
  blockedIdentitiesPossible: string[];
  /** Every action this scope actually placed in this world. */
  presentIdentities: string[];
  /** Actions excluded because this scope cannot place them. */
  excluded: number;
  /** The bucket decomposition whose bounds sum to blockedLower/blockedUpper. */
  orderBuckets: OrderBucketLineage[];
  /** Product of k! over the buckets; null when it exceeds exact integers. */
  orderSpaceSize: number | null;
  orderSemantics: "order_independent" | "order_dependent";
}

export interface CellOutcome {
  denominatorUnit: "possible_economic_actions";
  identityUnit: "possible_economic_action_key";
  /** Authenticated group diagnostics, never a denominator. */
  groupCount: number;
  memberRowCount: number;
  actionLowerBound: number;
  actionUpperBound: number;
  worldCount: number;
  worldDigest: string;
  semantics: "exact" | "bounded" | "not_determinable";
  identitySemantics: "exact" | "possible_only" | "not_determinable";
  evaluatedLower: number;
  evaluatedUpper: number;
  blockedLower: number;
  blockedUpper: number;
  clearedLower: number;
  clearedUpper: number;
  guaranteedBlockedKeys: string[];
  possiblyBlockedKeys: string[];
  guaranteedClearKeys: string[];
  /**
   * A reproducible witness for EVERY published extremum.
   *
   * r5 published one `minWitnessWorldKey`/`maxWitnessWorldKey` pair, recorded
   * only when the BLOCKED extrema moved. A cell could therefore publish an
   * evaluated or cleared bound with no witness at all, and the verifier never
   * checked the two it did publish. Every bound now names the world that
   * produces it, which order bound of that world it took, and the bucket
   * lineage that sums to the value.
   */
  witnesses: CellWitnesses;
  /** The order space, kept visibly distinct from the partition-world space. */
  orderSpaceSemantics: string;
  orderDependent: boolean;
  excludedActionsLower: number;
  excludedActionsUpper: number;
  why: string;
}

export interface CellWitness {
  worldKey: string;
  value: number;
  /** Which bound of that world's local order space produced the value. */
  orderBound: "lower" | "upper" | "order_independent";
  orderBuckets: OrderBucketLineage[];
}

export interface CellWitnesses {
  evaluatedLower: CellWitness | null;
  evaluatedUpper: CellWitness | null;
  blockedLower: CellWitness | null;
  blockedUpper: CellWitness | null;
  clearedLower: CellWitness | null;
  clearedUpper: CellWitness | null;
}

/**
 * Fold per-world outcomes into one cell.
 *
 * Every published bound is an ACTUAL minimum or maximum over the same complete
 * world set, and `cleared` is computed inside each world before folding —
 * never as algebra across worlds. That alone makes a negative cleared count
 * unreachable.
 */
export function foldWorldOutcomes(
  space: WorldSpace,
  outcomes: ReadonlyArray<{ worldKey: string; outcome: WorldOutcome }>,
  why: string,
): CellOutcome {
  if (outcomes.length === 0) {
    return {
      denominatorUnit: "possible_economic_actions",
      identityUnit: "possible_economic_action_key",
      groupCount: space.groupCount, memberRowCount: space.memberRowCount,
      actionLowerBound: space.actionLowerBound, actionUpperBound: space.actionUpperBound,
      worldCount: space.worldCount, worldDigest: space.digest,
      semantics: "not_determinable", identitySemantics: "not_determinable",
      evaluatedLower: 0, evaluatedUpper: 0,
      blockedLower: 0, blockedUpper: 0, clearedLower: 0, clearedUpper: 0,
      guaranteedBlockedKeys: [], possiblyBlockedKeys: [], guaranteedClearKeys: [],
      witnesses: {
        evaluatedLower: null, evaluatedUpper: null,
        blockedLower: null, blockedUpper: null,
        clearedLower: null, clearedUpper: null,
      },
      orderSpaceSemantics: D084_ORDER_SEMANTICS,
      orderDependent: false,
      excludedActionsLower: 0, excludedActionsUpper: 0,
      why: "no admissible world places any action at this scope",
    };
  }
  // Per world, blocked ranges over [guaranteed, max]; cleared is its complement
  // INSIDE that world, so both stay in [0, evaluated].
  let blockedLower = Number.POSITIVE_INFINITY;
  let blockedUpper = Number.NEGATIVE_INFINITY;
  let clearedLower = Number.POSITIVE_INFINITY;
  let clearedUpper = Number.NEGATIVE_INFINITY;
  let evaluatedLower = Number.POSITIVE_INFINITY;
  let evaluatedUpper = Number.NEGATIVE_INFINITY;
  let excludedLower = Number.POSITIVE_INFINITY;
  let excludedUpper = Number.NEGATIVE_INFINITY;
  const witnesses: CellWitnesses = {
    evaluatedLower: null, evaluatedUpper: null,
    blockedLower: null, blockedUpper: null,
    clearedLower: null, clearedUpper: null,
  };
  const witnessOf = (
    worldKey: string, value: number, bound: CellWitness["orderBound"], outcome: WorldOutcome,
  ): CellWitness => ({ worldKey, value, orderBound: bound, orderBuckets: outcome.orderBuckets });
  let orderDependent = false;
  // Plain sorted arrays: the intersection is explicit and the target has no
  // downlevel iteration for Sets.
  let guaranteed: string[] | null = null;
  const possible: string[] = [];
  let presentEverywhere: string[] | null = null;
  const intersect = (a: string[], b: readonly string[]): string[] => a.filter((k) => b.includes(k));
  let everyWorldSameCount = true;
  let firstBlocked: number | null = null;

  for (const { worldKey, outcome } of outcomes) {
    // Both are now ORDER extrema of this world, not identity-set cardinalities.
    const lo = outcome.blockedLower;
    const hi = outcome.blockedUpper;
    if (outcome.orderSemantics === "order_dependent") orderDependent = true;
    if (lo < blockedLower) { blockedLower = lo; witnesses.blockedLower = witnessOf(worldKey, lo, "lower", outcome); }
    if (hi > blockedUpper) { blockedUpper = hi; witnesses.blockedUpper = witnessOf(worldKey, hi, "upper", outcome); }
    // The complement is taken INSIDE this world, so both stay in [0, evaluated]
    // and no bound is ever algebra across worlds that cannot coexist.
    if (outcome.evaluated - hi < clearedLower) {
      clearedLower = outcome.evaluated - hi;
      witnesses.clearedLower = witnessOf(worldKey, clearedLower, "upper", outcome);
    }
    if (outcome.evaluated - lo > clearedUpper) {
      clearedUpper = outcome.evaluated - lo;
      witnesses.clearedUpper = witnessOf(worldKey, clearedUpper, "lower", outcome);
    }
    if (outcome.evaluated < evaluatedLower) {
      evaluatedLower = outcome.evaluated;
      witnesses.evaluatedLower = witnessOf(worldKey, outcome.evaluated, "order_independent", outcome);
    }
    if (outcome.evaluated > evaluatedUpper) {
      evaluatedUpper = outcome.evaluated;
      witnesses.evaluatedUpper = witnessOf(worldKey, outcome.evaluated, "order_independent", outcome);
    }
    excludedLower = Math.min(excludedLower, outcome.excluded);
    excludedUpper = Math.max(excludedUpper, outcome.excluded);
    if (lo !== hi) everyWorldSameCount = false;
    if (firstBlocked === null) firstBlocked = lo;
    else if (lo !== firstBlocked) everyWorldSameCount = false;

    guaranteed =
      guaranteed === null
        ? [...outcome.blockedIdentitiesGuaranteed]
        : intersect(guaranteed, outcome.blockedIdentitiesGuaranteed);
    for (const k of outcome.blockedIdentitiesPossible) if (!possible.includes(k)) possible.push(k);
    presentEverywhere =
      presentEverywhere === null
        ? [...outcome.presentIdentities]
        : intersect(presentEverywhere, outcome.presentIdentities);
  }

  const guaranteedKeys = (guaranteed ?? []).slice().sort((a, b) => a.localeCompare(b));
  const possibleKeys = possible.slice().sort((a, b) => a.localeCompare(b));
  // Guaranteed clear: the action exists in EVERY admissible world and is never
  // possibly blocked in any of them.
  const guaranteedClearKeys = (presentEverywhere ?? [])
    .filter((k) => !possible.includes(k))
    .sort((a, b) => a.localeCompare(b));

  const countExact = blockedLower === blockedUpper && evaluatedLower === evaluatedUpper && everyWorldSameCount;
  // r5 compared LENGTHS, so a guaranteed set and a possible set of equal size
  // but different membership was published as `exact`. Compare the sets.
  const identityExact =
    guaranteedKeys.length === possibleKeys.length &&
    guaranteedKeys.every((k, i) => possibleKeys[i] === k);
  return {
    denominatorUnit: "possible_economic_actions",
    identityUnit: "possible_economic_action_key",
    groupCount: space.groupCount, memberRowCount: space.memberRowCount,
    actionLowerBound: space.actionLowerBound, actionUpperBound: space.actionUpperBound,
    worldCount: space.worldCount, worldDigest: space.digest,
    semantics: countExact ? "exact" : "bounded",
    identitySemantics: identityExact ? "exact" : "possible_only",
    evaluatedLower, evaluatedUpper,
    blockedLower, blockedUpper,
    clearedLower, clearedUpper,
    guaranteedBlockedKeys: guaranteedKeys,
    possiblyBlockedKeys: possibleKeys,
    guaranteedClearKeys,
    witnesses,
    orderSpaceSemantics: D084_ORDER_SEMANTICS,
    orderDependent,
    excludedActionsLower: excludedLower,
    excludedActionsUpper: excludedUpper,
    why,
  };
}

// ---------------------------------------------------------------------------
// The four controls, evaluated INSIDE each world
// ---------------------------------------------------------------------------

function dayMsOf(day: string): number { return Date.parse(`${day}T00:00:00.000Z`); }
function gapDays(from: string, to: string): number {
  return Math.round((dayMsOf(to) - dayMsOf(from)) / 86_400_000);
}

/**
 * The order space, named once so nothing confuses it with the world space.
 *
 * The PARTITION world space answers "how many economic actions do these rows
 * represent?". The ORDER space answers "in what sequence did the ones sharing a
 * day happen?". They are independent sources of uncertainty and are published
 * with separate counts and digests.
 */
export const D084_ORDER_SEMANTICS =
  "no retained transition row carries an action time, so actions sharing a scope and a day have an unknown relative order; actions on different days are already ordered by day and actions under different scope keys never interact, so the admissible total orders factorise exactly into (scope, day) buckets and an additive count's extrema compose by summation with no slack" as const;

/**
 * The independent oracle ENUMERATES k! local orders, so it refuses a bucket
 * bigger than this. Production does not: its per-bucket result is closed-form
 * and costs O(k), so it stays correct at any k and simply reports `null` for a
 * local order-space size that no longer fits an exact integer.
 */
export const D084_MAX_BUCKET = 8;

interface OrderBucket {
  bucketKey: string;
  scopeKey: string;
  day: string;
  actions: PossibleAction[];
}

function bucketsOf(inScope: ReadonlyArray<{ action: PossibleAction; key: string }>): OrderBucket[] {
  const map = new Map<string, OrderBucket>();
  for (const { action, key } of inScope) {
    const bucketKey = `${key}|${action.day}`;
    if (!map.has(bucketKey)) map.set(bucketKey, { bucketKey, scopeKey: key, day: action.day, actions: [] });
    map.get(bucketKey)!.actions.push(action);
  }
  for (const b of map.values()) b.actions.sort((x, y) => x.actionKey.localeCompare(y.actionKey));
  return Array.from(map.values()).sort((a, b) => a.bucketKey.localeCompare(b.bucketKey));
}

/** k!, or null once it stops being an exact integer (k >= 19). */
function factorial(n: number): number | null {
  let out = 1;
  for (let i = 2; i <= n; i += 1) {
    out *= i;
    if (!Number.isSafeInteger(out)) return null;
  }
  return out;
}

/** One bucket's contribution: exact order extrema plus the identity sets. */
interface BucketVerdict {
  lineage: OrderBucketLineage;
  guaranteed: string[];
  possible: string[];
}

function composeBuckets(
  evaluated: number,
  excluded: number,
  present: string[],
  verdicts: readonly BucketVerdict[],
): WorldOutcome {
  let lower = 0;
  let upper = 0;
  let orderSpaceSize: number | null = 1;
  let orderDependent = false;
  const guaranteed: string[] = [];
  const possible: string[] = [];
  for (const v of verdicts) {
    lower += v.lineage.blockedLower;
    upper += v.lineage.blockedUpper;
    if (!v.lineage.orderIndependent) orderDependent = true;
    if (orderSpaceSize !== null && v.lineage.admissibleOrders !== null) {
      const next: number = orderSpaceSize * v.lineage.admissibleOrders;
      orderSpaceSize = Number.isSafeInteger(next) ? next : null;
    } else {
      orderSpaceSize = null;
    }
    for (const k of v.guaranteed) if (!guaranteed.includes(k)) guaranteed.push(k);
    for (const k of v.possible) if (!possible.includes(k)) possible.push(k);
  }
  return {
    evaluated,
    blockedLower: lower,
    blockedUpper: upper,
    blockedIdentitiesGuaranteed: guaranteed.sort((a, b) => a.localeCompare(b)),
    blockedIdentitiesPossible: possible.sort((a, b) => a.localeCompare(b)),
    presentIdentities: present,
    excluded,
    orderBuckets: verdicts.map((v) => v.lineage),
    orderSpaceSize,
    orderSemantics: orderDependent ? "order_dependent" : "order_independent",
  };
}

/** Actions this scope can place, plus the ones it cannot. */
function placed(world: PossibleWorld, scope: WorldScope) {
  const inScope: Array<{ action: PossibleAction; key: string }> = [];
  let excluded = 0;
  for (const action of world.actions) {
    const key = scopeKeyOf(action, scope);
    if (key === null) { excluded += 1; continue; }
    inScope.push({ action, key });
  }
  return { inScope, excluded };
}

/**
 * Cooldown inside one world.
 *
 * A strictly earlier action in the same scope inside the window is a proven
 * prior. A same-day peer has no retained action time, so it is only a possible
 * prior — and at most `k - 1` members of a same-day cluster of `k` can be
 * blocked, because one of them had to be first.
 */
export function cooldownInWorld(
  world: PossibleWorld, scope: WorldScope, cooldownDays: number,
): WorldOutcome {
  const { inScope, excluded } = placed(world, scope);
  const verdicts: BucketVerdict[] = bucketsOf(inScope).map((bucket) => {
    const k = bucket.actions.length;
    // An earlier-day prior is settled by the day order, so it blocks under
    // every order. It is identical for every member of a bucket (same scope,
    // same day), but it is computed per action rather than assumed uniform.
    const determined = bucket.actions.filter((a) =>
      inScope.some((p) => {
        if (scopeKeyOf(p.action, scope) !== bucket.scopeKey) return false;
        if (!(p.action.day < a.day)) return false;
        const gap = gapDays(p.action.day, a.day);
        return gap >= 0 && gap < cooldownDays;
      }),
    );
    const determinedKeys = determined.map((a) => a.actionKey);
    const rest = bucket.actions.filter((a) => !determinedKeys.includes(a.actionKey));
    // Same-day: exactly ONE action in the bucket has no same-day predecessor.
    // Which one is free, so the count moves only when the free slot can be
    // spent on an already-determined action.
    const sameDayCounts = cooldownDays >= 1 && k >= 1;
    const lower = !sameDayCounts ? determinedKeys.length : rest.length >= 1 ? k - 1 : k;
    const upper = !sameDayCounts ? determinedKeys.length : determinedKeys.length >= 1 ? k : k - 1;
    return {
      lineage: {
        bucketKey: bucket.bucketKey, scopeKey: bucket.scopeKey, day: bucket.day,
        actionCount: k,
        distinctDirections: new Set(bucket.actions.map((a) => a.direction)).size,
        determinedBlocked: determinedKeys.length,
        blockedLower: lower, blockedUpper: upper,
        admissibleOrders: factorial(k),
        orderIndependent: lower === upper,
      },
      // An action with no earlier-day prior can always be placed first, so it
      // is never GUARANTEED blocked even when the count says one must be.
      guaranteed: determinedKeys,
      possible: sameDayCounts && k >= 2
        ? bucket.actions.map((a) => a.actionKey)
        : determinedKeys,
    };
  });
  return composeBuckets(inScope.length, excluded, inScope.map((p) => p.action.actionKey), verdicts);
}

/**
 * Per-day caps inside one world.
 *
 * With `k` actions in a day-bucket and a cap of `c`, exactly `max(0, k - c)`
 * are refused under EVERY admissible order — the count is settled — while
 * WHICH ones are refused is not, because no retained row carries an action
 * time. r4 assigned ordinals by lexicographic key and named the losers.
 */
export function capInWorld(world: PossibleWorld, scope: WorldScope, cap: number): WorldOutcome {
  const { inScope, excluded } = placed(world, scope);
  const verdicts: BucketVerdict[] = bucketsOf(inScope).map((bucket) => {
    const k = bucket.actions.length;
    const over = Math.max(0, k - cap);
    // Every order refuses the same NUMBER — the last k-c — but an action is
    // guaranteed refused only when the whole bucket is, i.e. when no order can
    // put it inside the allowance.
    const allGuaranteed = over === k && k > 0;
    return {
      lineage: {
        bucketKey: bucket.bucketKey, scopeKey: bucket.scopeKey, day: bucket.day,
        actionCount: k,
        distinctDirections: new Set(bucket.actions.map((a) => a.direction)).size,
        determinedBlocked: over,
        blockedLower: over, blockedUpper: over,
        admissibleOrders: factorial(k),
        orderIndependent: true,
      },
      guaranteed: allGuaranteed ? bucket.actions.map((a) => a.actionKey) : [],
      possible: over > 0 ? bucket.actions.map((a) => a.actionKey) : [],
    };
  });
  return composeBuckets(inScope.length, excluded, inScope.map((p) => p.action.actionKey), verdicts);
}

/**
 * Account concentration inside one world.
 *
 * The share is computed from THIS world's own action counts, so it is a point
 * value per world and an interval only across worlds. Degeneracy is keyed to
 * the number of acting ACCOUNTS on the day, not the number of groups: a day on
 * which one account acts has a share of 1 whatever the multiplicity.
 */
export function concentrationInWorld(
  world: PossibleWorld, maxShare: number,
): WorldOutcome & { degenerateDays: number; totalDays: number; shares: Array<{ day: string; account: string; share: number; numerator: number; denominator: number; singleActingAccount: boolean }> } {
  const byDay = new Map<string, PossibleAction[]>();
  for (const action of world.actions) {
    if (!byDay.has(action.day)) byDay.set(action.day, []);
    byDay.get(action.day)!.push(action);
  }
  const guaranteed: string[] = [];
  const shares: Array<{ day: string; account: string; share: number; numerator: number; denominator: number; singleActingAccount: boolean }> = [];
  let degenerateDays = 0;
  for (const [day, dayActions] of Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const byAccount = new Map<string, PossibleAction[]>();
    for (const a of dayActions) {
      const key = `${a.businessId}|${a.providerAccountId}`;
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key)!.push(a);
    }
    const singleActingAccount = byAccount.size === 1;
    if (singleActingAccount) degenerateDays += 1;
    for (const [account, mine] of Array.from(byAccount.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      const share = mine.length / dayActions.length;
      shares.push({ day, account, share, numerator: mine.length, denominator: dayActions.length, singleActingAccount });
      if (share > maxShare) for (const a of mine) guaranteed.push(a.actionKey);
    }
  }
  // Concentration is a ratio of SETS, so no total order can change it. The
  // lineage says so explicitly rather than leaving it implied.
  const lineage: OrderBucketLineage[] = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, dayActions]) => ({
      bucketKey: `fleet|${day}`, scopeKey: "fleet", day,
      actionCount: dayActions.length,
      distinctDirections: new Set(dayActions.map((a) => a.direction)).size,
      determinedBlocked: dayActions.filter((a) => guaranteed.includes(a.actionKey)).length,
      blockedLower: dayActions.filter((a) => guaranteed.includes(a.actionKey)).length,
      blockedUpper: dayActions.filter((a) => guaranteed.includes(a.actionKey)).length,
      admissibleOrders: factorial(dayActions.length),
      orderIndependent: true,
    }));
  const sorted = guaranteed.slice().sort((a, b) => a.localeCompare(b));
  return {
    evaluated: world.actions.length,
    blockedLower: guaranteed.length,
    blockedUpper: guaranteed.length,
    blockedIdentitiesGuaranteed: sorted,
    blockedIdentitiesPossible: sorted.slice(),
    presentIdentities: world.actions.map((a) => a.actionKey),
    excluded: 0,
    orderBuckets: lineage,
    orderSpaceSize: 1,
    orderSemantics: "order_independent",
    degenerateDays,
    totalDays: byDay.size,
    shares,
  };
}

/**
 * A reversal needs a PRIOR action of the opposite direction inside the window.
 *
 * THE ORDER ARGUMENT, because this is where r5 was wrong. Inside one bucket,
 * order a sequence and let L be the length of its leading same-direction run.
 * Every action inside that run has only same-direction predecessors, so none
 * of them reverses; the action at L+1 differs from the run, so it does; and
 * every action after it has at least two directions behind it, so whatever its
 * own direction, one of them differs. Exactly `k - L` actions reverse. L is
 * maximised by leading with the largest direction group and minimised at 1, so
 * the count moves between those two and never touches the identity sets.
 */
export function lookbackInWorld(
  world: PossibleWorld, scope: WorldScope, lookbackDays: number,
): WorldOutcome & { repeatsLower: number; repeatsUpper: number } {
  const { inScope, excluded } = placed(world, scope);
  const priorsOf = (a: PossibleAction, key: string) =>
    inScope.filter((p) => {
      if (p.key !== key || p.action.actionKey === a.actionKey) return false;
      if (!(p.action.day < a.day)) return false;
      const gap = gapDays(p.action.day, a.day);
      return gap >= 0 && gap <= lookbackDays;
    });

  let repeatsLower = 0;
  let repeatsUpper = 0;
  const verdicts: BucketVerdict[] = bucketsOf(inScope).map((bucket) => {
    const k = bucket.actions.length;
    const directions = Array.from(new Set(bucket.actions.map((a) => a.direction))).sort();
    const m = directions.length;

    // --- reversal ---
    const determined = bucket.actions.filter((a) =>
      priorsOf(a, bucket.scopeKey).some((p) => p.action.direction !== a.direction));
    const determinedKeys = determined.map((a) => a.actionKey);
    const rest = bucket.actions.filter((a) => !determinedKeys.includes(a.actionKey));
    const restPerDirection = directions.map((d) => rest.filter((a) => a.direction === d).length);
    const lower = m >= 2
      ? determinedKeys.length + rest.length - Math.max(0, ...restPerDirection)
      : determinedKeys.length;
    const upper = m >= 2
      ? (determinedKeys.length >= 1 ? k : k - 1)
      : determinedKeys.length;

    // --- same-direction repeats, on the same order model ---
    // In every order exactly one member of each direction group escapes, so
    // `k - m` same-day repeats happen no matter what; only WHICH member is
    // spared moves, and it moves the count only across the determined split.
    const repDetermined = bucket.actions.filter((a) =>
      priorsOf(a, bucket.scopeKey).some((p) => p.action.direction === a.direction));
    const repDeterminedKeys = repDetermined.map((a) => a.actionKey);
    const repRest = bucket.actions.filter((a) => !repDeterminedKeys.includes(a.actionKey));
    const freeableDirections = directions.filter((d) => repRest.some((a) => a.direction === d));
    const freeableWithoutDetermined = freeableDirections.filter(
      (d) => !repDetermined.some((a) => a.direction === d));
    repeatsLower += repDeterminedKeys.length + repRest.length - freeableDirections.length;
    repeatsUpper += repDeterminedKeys.length + repRest.length - freeableWithoutDetermined.length;

    return {
      lineage: {
        bucketKey: bucket.bucketKey, scopeKey: bucket.scopeKey, day: bucket.day,
        actionCount: k, distinctDirections: m,
        determinedBlocked: determinedKeys.length,
        blockedLower: lower, blockedUpper: upper,
        admissibleOrders: factorial(k),
        orderIndependent: lower === upper,
      },
      // Any action with no earlier-day reversal can lead its own run, so it is
      // never guaranteed; any action with a differently-directed peer in the
      // bucket can be pushed past one, so it is possible.
      guaranteed: determinedKeys,
      possible: determinedKeys.concat(
        rest.filter((a) => bucket.actions.some((p) => p.direction !== a.direction)).map((a) => a.actionKey),
      ),
    };
  });

  return {
    ...composeBuckets(inScope.length, excluded, inScope.map((p) => p.action.actionKey), verdicts),
    repeatsLower,
    repeatsUpper,
  };
}
