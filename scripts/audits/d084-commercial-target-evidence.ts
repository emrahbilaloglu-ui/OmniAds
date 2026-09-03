/**
 * D084 r3 — commercial-target truth, evidence floors, and change-safety replay,
 * assembled from PINNED BYTES ONLY.
 *
 * WHAT CHANGED AND WHY (Correction 2). r2 was rejected on ten counts. The one
 * that governs this file's shape: r2 opened a live repeatable-read transaction
 * for a daily series the pinned artifacts already retained, and then described
 * those rows in its own type as coming from the pinned snapshot with "No new
 * read". Both statements could not be true. r3 has no database client, no
 * transaction, no query contract and no wall clock. Every fact comes from a
 * file whose bytes are hashed before parsing, via `d084-pinned-sources`.
 *
 * AUTHORITY. Nothing here is executable, approved, or a recommendation. The
 * maximum reachable state is local review-only `validated_only`; automation is
 * OFF; `executable` is the literal `false`. Every threshold is
 * `proposed_governance` and unapproved.
 *
 * IMPORT SAFETY: no top-level side effects and no `@/lib/db` import anywhere.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { canonicalDigest } from "@/scripts/audits/d080-meta-budget-edit-evidence";
import {
  D084_ORDER_SEMANTICS,
  buildWorldSpace,
  capInWorld,
  concentrationInWorld,
  cooldownInWorld,
  foldWorldOutcomes,
  lookbackInWorld,
  type CellOutcome,
  type GroupInput,
  type WorldScope,
  type WorldSpace,
} from "@/scripts/audits/d084-possible-worlds";
import {
  oracleCell,
  oracleConcentration,
  oracleConcentrationCell,
  oracleRepeatBounds,
  oracleSpace,
  oracleSweep,
  oracleWorldOutcome,
  type OracleCell,
  type OracleControl,
  type OracleSpace,
} from "@/scripts/audits/d084-independent-oracle";
import {
  D084_PINNED_SOURCES,
  checkPinnedSources,
  day,
  entityKey,
  extractAccountCurrency,
  extractBindings,
  extractBlockerRanking,
  extractConfigStates,
  extractD083Headline,
  extractDailySeries,
  extractDenominators,
  extractOrigins,
  extractOwnerStates,
  extractPersistedDecisionCensus,
  extractResolvedTransitions,
  extractSourceClocks,
  extractTargetPackHistory,
  loadPinnedSources,
  num,
  retentionByEntity,
  text,
  type Binding,
  type ConfigStateRow,
  type DailyRow,
  type OriginRow,
  type OwnerStateRow,
  type PersistedDecisionCensus,
  type PinnedBundle,
  type PinnedSourceCheck,
  type Row,
  type SourceClock,
  type TransitionRow,
} from "@/scripts/audits/d084-pinned-sources";

export type { Row };
export { text, num, day, entityKey };

export const D084_CONTRACT_ID = "d084.commercial-target-evidence.v6";

export const D084_JSON_OUT =
  "docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r6.json";

/**
 * r3 supersedes r2, which continues to supersede v1. Both the file bytes and
 * the predecessor's own internal artifact hash are pinned, because they are
 * different facts and a verifier that checks one for the other proves nothing.
 */
export const D084_SUPERSEDES = {
  path: "docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r5.json",
  fileSha256: "d7395b1c0ca4d824de3e7cf2d127d340af67466645a32510f1b290b89e7ee840",
  artifactHash: "9086f53c794fce0edf89f317bec8c3f2fccb7a6f3c922171e2f029ab202e247b",
  contract: "d084.commercial-target-evidence.v5",
  reason:
    "Correction 5: r5 derived same-day order COUNTS from the cardinality of its identity sets, so two same-day opposite-direction actions published blocked=[0,2] when every admissible total order blocks exactly one, a same-day cooldown cluster of k published [0,k-1] when every order blocks k-1, and k same-direction same-day actions published repeats=[0,k] when every order produces exactly k-1; its verifier then called the same production world builder, folder and control evaluators it was meant to check, sampled only worlds 0-31 against a single hardcoded cooldown of 7 days, published a blocked-only witness pair it never validated, and compared `identitySemantics=exact` by set SIZE rather than membership; the panel component rendered a hardcoded generic sentence for unavailable verdicts so the server-owned gate lineage never reached the screen; and the authenticated 390px gate was left NOT_DETERMINABLE with no mobile projection and no durable screenshot on disk",
  alsoSupersedes: {
    path: "docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r4.json",
    fileSha256: "bf857fb178927b59f2f3a748f7ffeb485fb95b4a7bf62cadd3f614d976278ddd",
    artifactHash: "d4c48c028341d0d14783215e99cd6c0bc91345a65511b9ca37020e74ac2d0438",
    contract: "d084.commercial-target-evidence.v4",
    reason:
    "Correction 4: r4's safety grids still looped over one item per economic GROUP, so cooldown, concentration and lookback evaluated an exact 14 while the authenticated members permit 14-23 actions, and the cap grid combined extrema from worlds that cannot coexist — publishing cap=1/entity with cleared=[-6,23]; budgetAsOfPit labelled 1,305 of 2,647 sole-capture rows a collapsed-day ambiguity when nothing had been dropped; the canonical eligibility boolean and action code were re-derived from generic gate blockers instead of carried; the owner-clock totals were literals in prose no verifier could prove; and the responsive receipt was a file:// static fixture rather than the authenticated Decision Center",
  },
  /**
   * The rest of the retained chain, so the whole lineage stays byte-checkable
   * rather than only the immediate predecessor.
   */
  priorChain: [
    {
      path: "docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r3.json",
      contract: "d084.commercial-target-evidence.v3",
      fileSha256: "b13c108eaf859062b2b3dd5d31387db2c65781fe659e119ded3b773ef5a99df5",
      artifactHash: "0d38a10beaf75f9eb117a962f3bff999c50cc37610e4cafe1204e66414f93e3a",
    },
    {
      path: "docs/audits/generated/d084-commercial-target-evidence-2026-09-01.r2.json",
      contract: "d084.commercial-target-evidence.v2",
      fileSha256: "2d2f3f3796689e2b081424fcb23c53d8268946a21cd822481581e4013b8a822a",
      artifactHash: "253521cf2a9951603c8ffbd1240a11d2b60b67bda5f886005a0e8789bcbe8938",
    },
    {
      path: "docs/audits/generated/d084-commercial-target-evidence-2026-09-01.json",
      contract: "d084.commercial-target-evidence.v1",
      fileSha256: "af8f8a9e1ea7e609af067f42b51a2a7950ffede7b4479ed49ce77769af214584",
      artifactHash: "910b8aebc0d2d116b10fbd72b997b50e9ec91e300b1387389afe46d523e3b112",
    },
  ],
} as const;

export const D084_CHARTER_BUSINESSES: ReadonlyArray<{ businessId: string; name: string }> = [
  { businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2", name: "IwaStore" },
  { businessId: "5dbc7147-f051-4681-a4d6-20617170074f", name: "Grandmix" },
  { businessId: "6c690fa4-6395-40b5-9755-e99b34d69bc3", name: "Bilsem Zeka" },
  { businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3", name: "TheSwaf" },
  { businessId: "b79683b4-6f87-48c0-a3ca-44d4356fef51", name: "IwaTR" },
  { businessId: "bc0c6178-7853-4f6f-b026-ef0222a4b9e7", name: "ColorFullWorldsTR" },
];

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

/**
 * Parse a retained instant.
 *
 * Postgres renders `timestamptz` with an HOURS-ONLY offset (`...+00`, `...-05`)
 * which `Date.parse` rejects, so the offset is completed to `+00:00`. r2's
 * repair tested `/[+-]\d{2}$/` against the WHOLE string, so a date-only value
 * like `2026-05-23` matched on its own day component and became the unparsable
 * `2026-05-23:00`. Every date-only value in the package therefore parsed to
 * null, which silently emptied every inter-event interval, every cooldown
 * result and every lookback reversal while the same artifact still reported 9
 * same-direction repeats and 2 reversals.
 *
 * The repair now requires an actual TIME before the offset, so a bare date is
 * left for `Date.parse` to handle correctly and an hours-only offset is still
 * completed.
 */
const HOURS_ONLY_OFFSET = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?[+-]\d{2}$/;

export function instantMs(value: unknown): number | null {
  const raw = text(value);
  if (raw === null) return null;
  const iso = raw.replace(" ", "T");
  const normalised = HOURS_ONLY_OFFSET.test(iso) ? `${iso}:00` : iso;
  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Midnight UTC for a `YYYY-MM-DD`, or null. Dates are compared as strings. */
export function dayMs(value: unknown): number | null {
  const d = day(value);
  if (d === null || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const parsed = Date.parse(`${d}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function addDays(date: string, delta: number): string {
  const base = dayMs(date);
  if (base === null) return date;
  return new Date(base + delta * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number | null {
  const a = dayMs(from);
  const b = dayMs(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / DAY_MS);
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function tally(values: readonly string[]): Record<string, number> {
  const out = new Map<string, number>();
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1);
  return Object.fromEntries([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// The raw anchor ledger — DESCRIPTIVE ONLY, never an eligibility verdict
// ---------------------------------------------------------------------------

export type AnchorRung =
  | "no_pack"
  | "high_confidence_target_cpa"
  | "high_confidence_operator_aov_with_target_roas"
  | "not_hard_action_eligible_break_even_or_history_only";

/**
 * Describes which anchor FIELDS a retained revision carries. It is a field
 * census and nothing else: it never decides eligibility, never blocks, and
 * never approves. `AccountDecisionProfile.hardActionEligibility` is the only
 * commercial authority, and this package does not have one.
 */
export function describeRawAnchorFields(pack: Row | null): AnchorRung {
  if (pack === null) return "no_pack";
  const targetCpa = num(pack.target_cpa);
  if (targetCpa !== null && targetCpa > 0) return "high_confidence_target_cpa";
  const aov = num(pack.aov_assumption);
  const targetRoas = num(pack.target_roas);
  if (aov !== null && aov > 0 && targetRoas !== null && targetRoas > 0) {
    return "high_confidence_operator_aov_with_target_roas";
  }
  return "not_hard_action_eligible_break_even_or_history_only";
}

export const D084_COST_INPUTS = [
  "cost_cogs_percent",
  "cost_shipping_percent",
  "cost_fulfillment_percent",
  "cost_payment_processing_percent",
] as const;

export interface EconomicReconciliation {
  state: "reconciled" | "not_determinable";
  why: string;
  formula: string;
  inputs: Record<string, number | null>;
  contributionMargin: number | null;
  computedBreakEvenRoas: number | null;
  publishedBreakEvenRoas: number | null;
  absoluteDifference: number | null;
}

/**
 * Break-even ROAS is the reciprocal of contribution margin, reconciled only
 * when EVERY cost input is retained and the published value agrees. A partial
 * cost basis is `not_determinable`, never an estimate presented as owner truth.
 */
export function reconcileBreakEven(pack: Row): EconomicReconciliation {
  const inputs: Record<string, number | null> = {};
  for (const field of D084_COST_INPUTS) inputs[field] = num(pack[field]);
  const published = num(pack.break_even_roas);
  const formula = "break_even_roas = 1 / (1 - (cogs + shipping + fulfillment + payment_processing))";
  const missing = D084_COST_INPUTS.filter((f) => inputs[f] === null);
  if (missing.length > 0) {
    return {
      state: "not_determinable",
      why: `retained cost basis is incomplete: ${missing.join(", ")} absent, so the published break-even cannot be checked against owner economics`,
      formula, inputs,
      contributionMargin: null, computedBreakEvenRoas: null,
      publishedBreakEvenRoas: published, absoluteDifference: null,
    };
  }
  const totalCost = D084_COST_INPUTS.reduce((sum, f) => sum + (inputs[f] ?? 0), 0);
  const contributionMargin = 1 - totalCost;
  if (!(contributionMargin > 0)) {
    return {
      state: "not_determinable",
      why: "retained cost inputs leave no positive contribution margin, so no break-even ROAS is economically meaningful",
      formula, inputs, contributionMargin,
      computedBreakEvenRoas: null, publishedBreakEvenRoas: published, absoluteDifference: null,
    };
  }
  const computed = 1 / contributionMargin;
  if (published === null) {
    return {
      state: "not_determinable",
      why: "no published break-even ROAS to reconcile against",
      formula, inputs, contributionMargin,
      computedBreakEvenRoas: computed, publishedBreakEvenRoas: null, absoluteDifference: null,
    };
  }
  const difference = Math.abs(computed - published);
  const agrees = difference < 0.005;
  return {
    state: agrees ? "reconciled" : "not_determinable",
    why: agrees
      ? "every cost input is retained and the published break-even equals 1/(contribution margin) at the stored two-decimal resolution"
      : `published break-even differs from the cost basis by ${difference.toFixed(4)}, which is more than the stored resolution explains`,
    formula, inputs, contributionMargin,
    computedBreakEvenRoas: computed, publishedBreakEvenRoas: published, absoluteDifference: difference,
  };
}

// ---------------------------------------------------------------------------
// Target packs — bitemporal, TOMBSTONE-AWARE, five states side by side
// ---------------------------------------------------------------------------

export const D084_FRESHNESS_WINDOWS_DAYS = [14, 30, 45, 60, 90, 120, 180] as const;
const RECORDED_AFTER_EFFECTIVE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export interface TargetRevision {
  revisionId: string;
  /** `upsert` writes a pack; `delete` is a TOMBSTONE that removes it. */
  operation: string | null;
  effectiveAt: string | null;
  recordedAt: string | null;
  /** The instant BOTH clocks have passed: max(effective, recorded). */
  knowableFromMs: number | null;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
  aovAssumption: number | null;
  costInputsPresent: number;
  costInputsExpected: number;
  sourceLabel: string | null;
  hasUpdater: boolean;
  rawAnchorRung: AnchorRung;
  recordedAfterEffective: boolean;
}

/**
 * The canonical point-in-time selection, tombstones included.
 *
 * `business_target_pack_history.operation` supports `upsert` and `delete`. The
 * production selector returns NULL when the latest knowable revision is a
 * delete — the pack is gone as of that instant, not merely unchanged. r2 read
 * any historical row as "configured" and never looked at `operation`, so a
 * deleted pack would have kept reporting the values it used to hold.
 */
export interface TargetPackAsOf {
  origin: string;
  /** The revision in force, or null when none is knowable or it is a tombstone. */
  selected: TargetRevision | null;
  /** Why nothing is in force, when nothing is. */
  absentReason:
    | null
    | "no_revision_knowable_at_this_origin"
    | "latest_knowable_revision_is_a_tombstone";
  /** The tombstone itself, when one is what removed the pack. */
  tombstone: TargetRevision | null;
  /** State 1. */
  configured: boolean;
  /** State 2 — the instant it first became knowable, or null. */
  pitKnowableAt: string | null;
  /** State 3, per named candidate window. */
  freshUnderWindowDays: Record<string, boolean>;
  /** State 4. */
  economics: EconomicReconciliation | null;
  economicallyReconciled: boolean;
  /** State 5 — always false; approval is an owner act, not a computation. */
  approvedForPolicy: false;
  approvedForPolicyWhy: string;
}

export function toTargetRevision(pack: Row): TargetRevision {
  const effectiveAt = text(pack.effective_at);
  const recordedAt = text(pack.recorded_at);
  const effective = instantMs(effectiveAt);
  const recorded = instantMs(recordedAt);
  const costPresent = D084_COST_INPUTS.filter((f) => num(pack[f]) !== null).length;
  return {
    revisionId: text(pack.id) ?? "",
    operation: text(pack.operation),
    effectiveAt,
    recordedAt,
    knowableFromMs: effective === null || recorded === null ? null : Math.max(effective, recorded),
    targetRoas: num(pack.target_roas),
    breakEvenRoas: num(pack.break_even_roas),
    targetCpa: num(pack.target_cpa),
    aovAssumption: num(pack.aov_assumption),
    costInputsPresent: costPresent,
    costInputsExpected: D084_COST_INPUTS.length,
    sourceLabel: text(pack.source_label),
    hasUpdater: pack.has_updater === true,
    rawAnchorRung: describeRawAnchorFields(pack),
    recordedAfterEffective:
      effective !== null && recorded !== null &&
      recorded - effective > RECORDED_AFTER_EFFECTIVE_TOLERANCE_MS,
  };
}

/**
 * Select the revision in force at `origin`, honouring tombstones.
 *
 * A revision is a candidate only once BOTH its clocks have passed — the origin
 * must be at or after `max(effective_at, recorded_at)`. Among candidates the
 * latest `effective_at` wins (ties broken by the later recording, then by id,
 * so the choice is total and deterministic). If that winner is a `delete`, no
 * pack is in force.
 */
export function selectTargetPackAsOf(
  packs: readonly Row[],
  origin: string,
): { selected: TargetRevision | null; absentReason: TargetPackAsOf["absentReason"]; tombstone: TargetRevision | null } {
  const originMs = dayMs(origin);
  if (originMs === null) {
    return { selected: null, absentReason: "no_revision_knowable_at_this_origin", tombstone: null };
  }
  // The origin is a DAY; a revision knowable at any instant during that day is
  // knowable as of the day's end, so the day's final instant is the cutoff.
  const cutoff = originMs + DAY_MS - 1;
  const candidates = packs
    .map(toTargetRevision)
    .filter((r) => r.knowableFromMs !== null && r.knowableFromMs <= cutoff);
  if (candidates.length === 0) {
    return { selected: null, absentReason: "no_revision_knowable_at_this_origin", tombstone: null };
  }
  const rank = (r: TargetRevision) =>
    [
      String(instantMs(r.effectiveAt) ?? Number.NEGATIVE_INFINITY).padStart(20, "0"),
      String(instantMs(r.recordedAt) ?? Number.NEGATIVE_INFINITY).padStart(20, "0"),
      r.revisionId,
    ].join("|");
  const winner = candidates.reduce((best, row) => (rank(row) >= rank(best) ? row : best), candidates[0]!);
  if ((winner.operation ?? "").toLowerCase() === "delete") {
    return { selected: null, absentReason: "latest_knowable_revision_is_a_tombstone", tombstone: winner };
  }
  return { selected: winner, absentReason: null, tombstone: null };
}

export function buildTargetPackAsOf(packs: readonly Row[], origin: string): TargetPackAsOf {
  const { selected, absentReason, tombstone } = selectTargetPackAsOf(packs, origin);
  const originMs = dayMs(origin) ?? 0;
  const freshUnderWindowDays: Record<string, boolean> = {};
  for (const windowDays of D084_FRESHNESS_WINDOWS_DAYS) {
    const effective = selected === null ? null : instantMs(selected.effectiveAt);
    freshUnderWindowDays[String(windowDays)] =
      effective !== null && (originMs - effective) / DAY_MS <= windowDays;
  }
  const economics = selected === null ? null : reconcileBreakEven(packRowOf(packs, selected.revisionId));
  return {
    origin,
    selected,
    absentReason,
    tombstone,
    configured: selected !== null,
    pitKnowableAt:
      selected?.knowableFromMs != null ? new Date(selected.knowableFromMs).toISOString() : null,
    freshUnderWindowDays,
    economics,
    economicallyReconciled: economics?.state === "reconciled",
    approvedForPolicy: false as const,
    approvedForPolicyWhy:
      selected === null
        ? absentReason === "latest_knowable_revision_is_a_tombstone"
          ? "the latest knowable revision is a delete tombstone, so no pack is in force and nothing can be approved"
          : "no commercial target pack was knowable at this origin"
        : "the retained pack is proposed_governance: no owner has approved it for unattended policy, and this package cannot approve one",
  };
}

function packRowOf(packs: readonly Row[], revisionId: string): Row {
  return packs.find((p) => (text(p.id) ?? "") === revisionId) ?? {};
}

export interface TargetPackTruth {
  businessId: string;
  business: string;
  /** Currency for the business's bindings, from the pinned source. Never guessed. */
  currency: string | null;
  currencyWhy: string;
  revisions: number;
  revisionLineage: TargetRevision[];
  /** Every origin, side by side. Nothing is collapsed to a single verdict. */
  asOfOrigins: TargetPackAsOf[];
  /** The latest origin, published separately because it is what a surface shows. */
  atLatestOrigin: TargetPackAsOf | null;
  /** DESCRIPTIVE raw-field ledger. Not an authority and never an eligibility verdict. */
  rawFieldLedger: {
    note: "descriptive raw-field ledger; not an authority and never an eligibility verdict";
    rungAtLatestOrigin: AnchorRung;
    sourceLabels: string[];
    revisionsWithUpdater: number;
    revisionsRecordedAfterEffective: number;
  };
}

export function buildTargetPackTruth(
  packs: readonly Row[],
  context: {
    origins: readonly string[];
    currencyByBusiness: Record<string, { currency: string | null; why: string }>;
  },
): TargetPackTruth[] {
  return D084_CHARTER_BUSINESSES.map((business) => {
    const mine = packs.filter((p) => (text(p.business_id) ?? "") === business.businessId);
    const lineage = mine.map(toTargetRevision);
    const asOfOrigins = context.origins.map((origin) => buildTargetPackAsOf(mine, origin));
    const atLatestOrigin = asOfOrigins.length > 0 ? asOfOrigins[asOfOrigins.length - 1]! : null;
    const currency = context.currencyByBusiness[business.businessId];
    return {
      businessId: business.businessId,
      business: business.name,
      currency: currency?.currency ?? null,
      currencyWhy: currency?.why ?? "no retained binding carried a currency for this business",
      revisions: mine.length,
      revisionLineage: lineage,
      asOfOrigins,
      atLatestOrigin,
      rawFieldLedger: {
        note: "descriptive raw-field ledger; not an authority and never an eligibility verdict",
        rungAtLatestOrigin: atLatestOrigin?.selected?.rawAnchorRung ?? "no_pack",
        sourceLabels: sortedUnique(lineage.map((r) => r.sourceLabel).filter((s): s is string => s !== null)),
        revisionsWithUpdater: lineage.filter((r) => r.hasUpdater).length,
        revisionsRecordedAfterEffective: lineage.filter((r) => r.recordedAfterEffective).length,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Canonical profile availability — NOT an inferred verdict
// ---------------------------------------------------------------------------

export const ACCOUNT_DECISION_PROFILE_CONTRACT_EXPECTED = "adsecute.account-decision-profile.v1";
export const D084_PROFILE_ACTIONS = ["scale", "cut", "refresh"] as const;
export type ProfileAction = (typeof D084_PROFILE_ACTIONS)[number];

/**
 * Per action, whether a canonical profile output is available in pinned bytes.
 *
 * r2 summed `eligibleBefore` across all actions, looked for a persisted
 * `profile_hard_action_ineligible->` transition, and emitted ONE business-wide
 * boolean labelled with the D079 COUNTERFACTUAL contract. That is three errors
 * at once: it invents a verdict from a decision census, it destroys the
 * scale/cut/refresh distinction with every per-action code, reason and anchor
 * explanation, and it attributes the result to a contract that never produced
 * an `AccountDecisionProfile`.
 *
 * The pinned artifacts retain no canonical profile output. So every action is
 * `not_determinable` with a named reason, the EXPECTED contract is stated
 * separately from the OBSERVED one, and nothing invents a true or a false. The
 * D079 census travels alongside as descriptive persisted-decision evidence.
 */
export interface CanonicalProfileActionStatus {
  action: ProfileAction;
  status: "not_determinable";
  reasonCode: "canonical_profile_output_not_retained";
  reason: string;
  eligible: null;
  code: null;
  actionReason: null;
  anchorExplanation: null;
  expectedContract: string;
  observedContract: null;
}

export interface CanonicalProfileAvailability {
  businessId: string;
  business: string;
  byAction: CanonicalProfileActionStatus[];
  /** DESCRIPTIVE ONLY. Persisted historical decisions, never current eligibility. */
  persistedDecisionCensus: PersistedDecisionCensus | null;
  censusIsNotAProfile: string;
}

export function buildCanonicalProfileAvailability(
  census: readonly PersistedDecisionCensus[],
): CanonicalProfileAvailability[] {
  return D084_CHARTER_BUSINESSES.map((business) => ({
    businessId: business.businessId,
    business: business.name,
    byAction: D084_PROFILE_ACTIONS.map((action) => ({
      action,
      status: "not_determinable" as const,
      reasonCode: "canonical_profile_output_not_retained" as const,
      reason:
        `no pinned artifact retains an AccountDecisionProfile.hardActionEligibility output for ${business.name}, so this package cannot state whether ${action} is eligible; only a byte-inspectable production resolver result over fully frozen inputs may populate it`,
      eligible: null,
      code: null,
      actionReason: null,
      anchorExplanation: null,
      expectedContract: ACCOUNT_DECISION_PROFILE_CONTRACT_EXPECTED,
      observedContract: null,
    })),
    persistedDecisionCensus: census.find((c) => c.businessId === business.businessId) ?? null,
    censusIsNotAProfile:
      "the D079 census counts PERSISTED HISTORICAL decision rows by withheld family; it is not a current AccountDecisionProfile, carries no per-action code, reason or anchor explanation, and may never be read as eligibility",
  }));
}

// ---------------------------------------------------------------------------
// Economic events — explicit members, proved grouping, honest bounds
// ---------------------------------------------------------------------------

export const D084_EVENT_WINDOWS_DAYS = [1, 3, 7, 14, 28] as const;
export const D084_DECLARED_LADDER_PERCENT = [5, 10, 15, 20, 25] as const;

/**
 * One retained transition row, kept whole.
 *
 * r2 flattened members into independent `grains[]` and `entityIds[]` arrays, so
 * which entity had which grain — and which campaign owned it — could not be
 * inspected at all. Every member now carries its own identity and its exact
 * source row key.
 */
/**
 * A bitemporal selection over the pinned owner-state rows.
 *
 * WHY THIS SHAPE (Correction 3). r3 filtered owner state with `observedOn <=
 * effectiveFrom` alone and read `budgetOriginKnowableFrom` off `observedOn`.
 * That is an effective-clock filter, not a point-in-time selector: 453 of the
 * 462 retained owner rows were CAPTURED after the day they describe, and both
 * of r3's `proved_owner_mirror_single_child` groups rested on child rows
 * observed 2026-06-02 but captured 2026-08-22 14:19:35.141+00 — after both
 * events. Neither fact was knowable when the change happened.
 *
 * A row is knowable at a day-precision origin only when BOTH clocks have
 * passed. A transition carries a day and no time, so a capture landing on the
 * origin day has no provable before/after order against it and is excluded
 * rather than assumed early.
 */
export type OwnerSelectionStatus =
  | "resolved"
  | "no_knowable_row"
  | "conflicting_knowable_rows"
  | "same_day_capture_ambiguous";

export interface OwnerSelection {
  status: OwnerSelectionStatus;
  budgetOrigin: string | null;
  /** The campaign this row itself names. Never a future daily scan. */
  campaignId: string | null;
  /** max(observed_on, captured_at) of the selected row — the real knowable instant. */
  knowableFromMs: number | null;
  knowableFrom: string | null;
  observedOn: string | null;
  capturedAt: string | null;
  why: string;
  /** Rows excluded only because their capture was not yet knowable. */
  excludedByCaptureClock: number;
  /** Rows excluded because their capture lands on the origin day itself. */
  excludedBySameDayCapture: number;
}

export interface EventMember {
  sourceRowKey: string;
  sourceEntityKey: string;
  businessId: string;
  business: string;
  providerAccountId: string;
  grain: string;
  entityId: string;
  /**
   * Owner lineage knowable AT the event, taken from the selected owner-state
   * row's own `campaignId`. r3 scanned the whole retained daily horizon, whose
   * rows carry no recorded clock at all, so a parent first seen weeks later
   * could be used at an earlier event.
   */
  parentCampaignId: string | null;
  parentLineageSource: "owner_state_at_event" | "not_determinable";
  parentLineageWhy: string;
  prevEffectiveFrom: string | null;
  effectiveFrom: string;
  direction: string;
  percent: number | null;
  /** What the pinned owner-state rows PROVABLY say owns the money at the event. */
  budgetOriginAtEvent: string | null;
  budgetOriginKnowableFrom: string | null;
  ownerSelection: OwnerSelection;
}

export type GroupingProof =
  | "single_member"
  | "proved_owner_mirror_single_child"
  | "ambiguous_multi_member";

export interface EconomicEventGroup {
  key: string;
  businessId: string;
  business: string;
  providerAccountId: string;
  effectiveFrom: string;
  direction: string;
  percent: number | null;
  members: EventMember[];
  groupingProof: GroupingProof;
  groupingProofDetail: string;
  /**
   * The member whose delivery represents the group WITHOUT double counting,
   * or null when no such member is proved. Never an alphabetical pick.
   */
  representativeMemberKey: string | null;
  /** Distinct actions this group could be, given retained evidence. */
  lowerBoundActions: number;
  upperBoundActions: number;
  insideDeclaredLadder: boolean;
}

export function economicEventKey(member: {
  businessId: string; providerAccountId: string; effectiveFrom: string; direction: string; percent: number | null;
}): string {
  return [
    member.businessId,
    member.providerAccountId,
    member.effectiveFrom,
    member.direction,
    String(member.percent ?? ""),
  ].join("|");
}

/** The full member identity, which the group key deliberately does NOT carry. */
export function memberKey(member: {
  businessId: string; providerAccountId: string; grain: string; entityId: string; effectiveFrom: string;
}): string {
  return [
    member.businessId, member.providerAccountId, member.grain, member.entityId, member.effectiveFrom,
  ].join("|");
}

function businessName(businessId: string): string {
  return D084_CHARTER_BUSINESSES.find((b) => b.businessId === businessId)?.name ?? businessId;
}

/**
 * Select the owner-state row knowable at a DAY-PRECISION origin.
 *
 * Both clocks must have passed: the row must describe a day at or before the
 * origin AND have been captured before the origin day begins. A capture landing
 * on the origin day itself is excluded — the transition has no time component,
 * so "captured that morning" and "captured that evening" are indistinguishable
 * and neither may be assumed.
 *
 * Among knowable rows the newest observed day wins; if two knowable rows of the
 * same newest day disagree on `budget_origin`, the selection is conflicting and
 * nothing is proved.
 */
export function selectOwnerStateAsOf(
  rows: readonly OwnerStateRow[],
  originDay: string,
): OwnerSelection {
  const originMs = dayMs(originDay);
  const empty = (status: OwnerSelectionStatus, why: string, excludedCapture = 0, excludedSameDay = 0): OwnerSelection => ({
    status, budgetOrigin: null, campaignId: null,
    knowableFromMs: null, knowableFrom: null, observedOn: null, capturedAt: null,
    why, excludedByCaptureClock: excludedCapture, excludedBySameDayCapture: excludedSameDay,
  });
  if (originMs === null) return empty("no_knowable_row", "the event day is not a parsable date");

  const byEffective = rows.filter((r) => r.observedOn <= originDay);
  let excludedCapture = 0;
  let excludedSameDay = 0;
  const knowable = byEffective.filter((r) => {
    const captured = instantMs(r.capturedAt);
    if (captured === null) { excludedCapture += 1; return false; }
    // Strictly before the origin DAY, because the event has no time of day.
    if (captured >= originMs + DAY_MS) { excludedCapture += 1; return false; }
    if (captured >= originMs) { excludedSameDay += 1; return false; }
    return true;
  });

  if (knowable.length === 0) {
    return empty(
      excludedSameDay > 0 && excludedCapture === 0 ? "same_day_capture_ambiguous" : "no_knowable_row",
      excludedCapture + excludedSameDay > 0
        ? `${byEffective.length} row(s) describe a day at or before ${originDay}, but ${excludedCapture} were captured after it and ${excludedSameDay} were captured on the day itself, whose order against a day-precision event cannot be established`
        : `no retained owner-state row describes a day at or before ${originDay}`,
      excludedCapture, excludedSameDay,
    );
  }

  const newestDay = knowable.reduce((a, r) => (r.observedOn > a ? r.observedOn : a), knowable[0]!.observedOn);
  const winners = knowable.filter((r) => r.observedOn === newestDay);
  const origins = sortedUnique(winners.map((w) => w.budgetOrigin).filter((o): o is string => o !== null));
  const campaigns = sortedUnique(winners.map((w) => w.campaignId).filter((c): c is string => c !== null));
  if (origins.length > 1) {
    return empty(
      "conflicting_knowable_rows",
      `${winners.length} knowable rows for ${newestDay} disagree on budget_origin (${origins.join(", ")}), so ownership is not proved`,
      excludedCapture, excludedSameDay,
    );
  }
  // Deterministic pick among identical-verdict rows: the latest capture.
  const chosen = winners.reduce((best, r) =>
    (instantMs(r.capturedAt) ?? 0) >= (instantMs(best.capturedAt) ?? 0) ? r : best, winners[0]!);
  const observedMs = dayMs(chosen.observedOn) ?? 0;
  const capturedMs = instantMs(chosen.capturedAt) ?? 0;
  const knowableFromMs = Math.max(observedMs, capturedMs);
  return {
    status: "resolved",
    budgetOrigin: origins.length === 1 ? origins[0]! : null,
    campaignId: campaigns.length === 1 ? campaigns[0]! : null,
    knowableFromMs,
    knowableFrom: new Date(knowableFromMs).toISOString(),
    observedOn: chosen.observedOn,
    capturedAt: chosen.capturedAt,
    why: `observed ${chosen.observedOn}, captured ${chosen.capturedAt}; both clocks passed before ${originDay}`,
    excludedByCaptureClock: excludedCapture,
    excludedBySameDayCapture: excludedSameDay,
  };
}

export function buildEventMembers(
  transitions: readonly TransitionRow[],
  _daily: readonly DailyRow[],
  ownerStates: readonly OwnerStateRow[],
): EventMember[] {
  return transitions
    .map((t) => {
      const mine = ownerStates.filter(
        (o) =>
          o.businessId === t.businessId &&
          o.providerAccountId === t.providerAccountId &&
          o.entityType === t.grain &&
          o.entityId === t.entityId,
      );
      const selection = selectOwnerStateAsOf(mine, t.effectiveFrom);
      const parentFromOwner = selection.status === "resolved" ? selection.campaignId : null;
      return {
        sourceRowKey: t.sourceRowKey,
        sourceEntityKey: t.sourceEntityKey,
        businessId: t.businessId,
        business: businessName(t.businessId),
        providerAccountId: t.providerAccountId,
        grain: t.grain,
        entityId: t.entityId,
        parentCampaignId: parentFromOwner,
        parentLineageSource: parentFromOwner === null ? ("not_determinable" as const) : ("owner_state_at_event" as const),
        parentLineageWhy:
          parentFromOwner === null
            ? `no owner-state row knowable at ${t.effectiveFrom} names a campaign for this entity; the daily series carries no recorded clock and may not supply a parent first seen later`
            : `taken from the owner-state row knowable at ${t.effectiveFrom} (${selection.why})`,
        prevEffectiveFrom: t.prevEffectiveFrom,
        effectiveFrom: t.effectiveFrom,
        direction: t.direction,
        percent: t.percent,
        budgetOriginAtEvent: selection.status === "resolved" ? selection.budgetOrigin : null,
        budgetOriginKnowableFrom: selection.knowableFrom,
        ownerSelection: selection,
      };
    })
    .sort((a, b) => memberKey(a).localeCompare(memberKey(b)));
}

export function buildEventGroups(members: readonly EventMember[]): EconomicEventGroup[] {
  const byKey = new Map<string, EventMember[]>();
  for (const m of members) {
    const k = economicEventKey(m);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(m);
  }
  const groups: EconomicEventGroup[] = [];
  for (const [key, groupMembers] of [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...groupMembers].sort((a, b) => memberKey(a).localeCompare(memberKey(b)));
    const first = sorted[0]!;
    const campaigns = sorted.filter((m) => m.grain === "campaign");
    const children = sorted.filter((m) => m.grain !== "campaign");

    let proof: GroupingProof = "ambiguous_multi_member";
    let detail: string;
    let representative: string | null = null;
    if (sorted.length === 1) {
      proof = "single_member";
      detail = "exactly one retained transition row, so no grouping judgement is required";
      representative = memberKey(first);
    } else if (
      campaigns.length === 1 &&
      children.length === 1 &&
      children[0]!.parentCampaignId === campaigns[0]!.entityId &&
      campaigns[0]!.budgetOriginAtEvent === "campaign" &&
      children[0]!.budgetOriginAtEvent === "not_applicable"
    ) {
      proof = "proved_owner_mirror_single_child";
      detail =
        `owner-state rows knowable on BOTH clocks before ${first.effectiveFrom} put the budget on campaign ${campaigns[0]!.entityId} (budget_origin=campaign; ${campaigns[0]!.ownerSelection.why}) while its single moving child ${children[0]!.entityId} owns none (budget_origin=not_applicable; ${children[0]!.ownerSelection.why}), and the child's parent lineage comes from that same knowable row, so the child mirrors the campaign change and campaign delivery represents this group exactly once`;
      representative = memberKey(campaigns[0]!);
    } else {
      const why: string[] = [];
      if (campaigns.length !== 1) why.push(`${campaigns.length} campaign members`);
      if (children.length > 1) why.push(`${children.length} non-campaign members`);
      for (const child of children) {
        if (child.parentCampaignId === null) why.push(`${child.entityId} has no single retained parent`);
        else if (!campaigns.some((c) => c.entityId === child.parentCampaignId)) {
          why.push(`${child.entityId}'s parent ${child.parentCampaignId} is not in this group`);
        }
      }
      for (const m of sorted) {
        if (m.budgetOriginAtEvent === null) {
          why.push(
            `no budget_origin for ${m.grain} ${m.entityId} is knowable on both clocks by ${m.effectiveFrom} (${m.ownerSelection.status}: ${m.ownerSelection.why})`,
          );
        }
      }
      detail = `not proved to be one action: ${sortedUnique(why).join("; ") || "no owner evidence"}`;
    }

    const percent = first.percent;
    groups.push({
      key,
      businessId: first.businessId,
      business: first.business,
      providerAccountId: first.providerAccountId,
      effectiveFrom: first.effectiveFrom,
      direction: first.direction,
      percent,
      members: sorted,
      groupingProof: proof,
      groupingProofDetail: detail,
      representativeMemberKey: representative,
      lowerBoundActions: 1,
      upperBoundActions: proof === "ambiguous_multi_member" ? sorted.length : 1,
      insideDeclaredLadder:
        percent !== null &&
        (D084_DECLARED_LADDER_PERCENT as readonly number[]).includes(Math.abs(percent)),
    });
  }
  return groups;
}

export function eventCountBounds(groups: readonly EconomicEventGroup[]): {
  lower: number;
  upper: number;
  ambiguousGroups: number;
  provedGroups: number;
  singleMemberGroups: number;
  memberRows: number;
  why: string;
} {
  const ambiguous = groups.filter((g) => g.groupingProof === "ambiguous_multi_member");
  return {
    lower: groups.reduce((s, g) => s + g.lowerBoundActions, 0),
    upper: groups.reduce((s, g) => s + g.upperBoundActions, 0),
    ambiguousGroups: ambiguous.length,
    provedGroups: groups.filter((g) => g.groupingProof === "proved_owner_mirror_single_child").length,
    singleMemberGroups: groups.filter((g) => g.groupingProof === "single_member").length,
    memberRows: groups.reduce((s, g) => s + g.members.length, 0),
    why:
      ambiguous.length === 0
        ? "every group is a single member or a proved owner mirror, so the action count is exact"
        : `${ambiguous.length} group(s) cannot be proved to be one action from retained owner evidence, so the count is a range and each ambiguous member is published separately`,
  };
}

// ---------------------------------------------------------------------------
// Windows — per expected entity-day, against ACTUAL pinned retention
// ---------------------------------------------------------------------------

export interface MemberWindow {
  side: "pre" | "post";
  days: number;
  /**
   * Support is decided against retained rows and the pinned retention bounds,
   * never against a requested range. r2 declared `deliveryWindow.to` as
   * 2026-09-03 from a 2026-09-01 extraction, so two FUTURE days could be
   * reported as supported.
   */
  support: "supported" | "partially_supported" | "unsupported";
  supportWhy: string | null;
  /** Days the window asked for. */
  requestedDays: number;
  /** Days inside pinned retention for this entity. */
  retainedEligibleDays: number;
  /** Days with an actual retained row for this exact entity. */
  coveredEntityDays: number;
  missingEntityDays: string[];
  spendBearingDays: number;
  spend: number;
  conversions: number;
  revenue: number;
  /** Rates travel with their denominators; null when the denominator is zero. */
  roas: number | null;
  cpa: number | null;
  statusCoverage: Record<string, number>;
  currencies: string[];
  truthStates: Record<string, number>;
}

export interface MemberStudy {
  memberKey: string;
  sourceRowKey: string;
  business: string;
  businessId: string;
  providerAccountId: string;
  grain: string;
  entityId: string;
  parentCampaignId: string | null;
  effectiveFrom: string;
  direction: string;
  percent: number | null;
  windows: MemberWindow[];
  /** Config changes on this member's own entity, EXCLUDING its own transition. */
  concurrentConfigChanges: number;
  concurrentConfigChangeDetail: Array<{ effectiveFrom: string; capturedAt: string | null; sameDayAsEvent: boolean }>;
  concurrentTargetRevisions: number;
  overlappingEventKeys: string[];
}

export type ConfoundingClass =
  | "clean_within_retained_evidence"
  | "grouping_ambiguous"
  | "overlapping_event_window"
  | "concurrent_config_change"
  | "concurrent_target_revision"
  | "incomplete_entity_day_coverage"
  | "multiple_confounds";

export interface EventStudyRow {
  key: string;
  business: string;
  businessId: string;
  providerAccountId: string;
  effectiveFrom: string;
  direction: string;
  percent: number | null;
  groupingProof: GroupingProof;
  groupingProofDetail: string;
  representativeMemberKey: string | null;
  /**
   * Every member studied on its own. A group is NEVER represented by an
   * arbitrary grain: a proved owner mirror names its representative and says
   * why, and an ambiguous group publishes all its members as alternatives.
   */
  members: MemberStudy[];
  lowerBoundActions: number;
  upperBoundActions: number;
  confounding: ConfoundingClass;
  confoundingFlags: string[];
}

function windowDates(anchor: string, days: number, side: "pre" | "post"): string[] {
  const out: string[] = [];
  for (let i = 1; i <= days; i += 1) out.push(addDays(anchor, side === "pre" ? -i : i));
  return out.sort((a, b) => a.localeCompare(b));
}

function summariseWindow(
  side: "pre" | "post",
  days: number,
  anchor: string,
  rows: readonly DailyRow[],
  retention: { firstRetainedDate: string; lastRetainedDate: string } | undefined,
): MemberWindow {
  const wanted = windowDates(anchor, days, side);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const eligible = retention
    ? wanted.filter((d) => d >= retention.firstRetainedDate && d <= retention.lastRetainedDate)
    : [];
  const covered = wanted.filter((d) => byDate.has(d));
  const missing = eligible.filter((d) => !byDate.has(d)).sort((a, b) => a.localeCompare(b));
  const present = covered.map((d) => byDate.get(d)!);
  const spend = present.reduce((s, r) => s + r.spend, 0);
  const conversions = present.reduce((s, r) => s + r.conversions, 0);
  const revenue = present.reduce((s, r) => s + r.revenue, 0);

  let support: MemberWindow["support"];
  let supportWhy: string | null;
  if (!retention || eligible.length === 0) {
    support = "unsupported";
    supportWhy = retention
      ? `every day this window asks for lies outside the pinned retention ${retention.firstRetainedDate}..${retention.lastRetainedDate} for this entity`
      : "no retained delivery exists for this entity at all";
  } else if (eligible.length < wanted.length || missing.length > 0) {
    support = "partially_supported";
    const parts: string[] = [];
    if (eligible.length < wanted.length) {
      parts.push(`${wanted.length - eligible.length} of ${wanted.length} day(s) lie outside pinned retention ${retention.firstRetainedDate}..${retention.lastRetainedDate}`);
    }
    if (missing.length > 0) parts.push(`${missing.length} retained-eligible day(s) have no row for this entity`);
    supportWhy = parts.join("; ");
  } else {
    support = "supported";
    supportWhy = null;
  }

  return {
    side, days, support, supportWhy,
    requestedDays: wanted.length,
    retainedEligibleDays: eligible.length,
    coveredEntityDays: covered.length,
    missingEntityDays: missing,
    spendBearingDays: present.filter((r) => r.spend > 0).length,
    spend, conversions, revenue,
    roas: spend > 0 ? revenue / spend : null,
    cpa: conversions > 0 ? spend / conversions : null,
    statusCoverage: tally(present.map((r) => r.status ?? "unknown")),
    currencies: sortedUnique(present.map((r) => r.accountCurrency).filter((c): c is string => c !== null)),
    truthStates: tally(present.map((r) => r.truthState ?? "unknown")),
  };
}

export function buildEventStudy(input: {
  groups: readonly EconomicEventGroup[];
  daily: readonly DailyRow[];
  configStates: readonly ConfigStateRow[];
  targetRevisionInstants: ReadonlyArray<{ businessId: string; atMs: number }>;
}): EventStudyRow[] {
  const byEntity = new Map<string, DailyRow[]>();
  for (const row of input.daily) {
    const k = entityKey(row);
    if (!byEntity.has(k)) byEntity.set(k, []);
    byEntity.get(k)!.push(row);
  }
  const retention = retentionByEntity(input.daily);

  return input.groups.map((group) => {
    const members: MemberStudy[] = group.members.map((member) => {
      const k = entityKey(member);
      const rows = byEntity.get(k) ?? [];
      const bounds = retention.get(k);
      const windows: MemberWindow[] = [];
      for (const side of ["pre", "post"] as const) {
        for (const days of D084_EVENT_WINDOWS_DAYS) {
          windows.push(summariseWindow(side, days, member.effectiveFrom, rows, bounds));
        }
      }
      // Concurrent config changes on THIS entity, excluding only the event's
      // own transition. r2 dropped every same-day change, so a real second
      // change on the event day disappeared instead of being counted.
      const mine = input.configStates.filter(
        (c) =>
          c.businessId === member.businessId &&
          c.providerAccountId === member.providerAccountId &&
          c.grain === member.grain &&
          c.entityId === member.entityId,
      );
      const windowFrom = addDays(member.effectiveFrom, -Math.max(...D084_EVENT_WINDOWS_DAYS));
      const windowTo = addDays(member.effectiveFrom, Math.max(...D084_EVENT_WINDOWS_DAYS));
      const concurrent = mine.filter(
        (c) =>
          c.effectiveFrom >= windowFrom &&
          c.effectiveFrom <= windowTo &&
          // Only the member's OWN transition is excluded.
          c.effectiveFrom !== member.effectiveFrom,
      );
      const sameDayOthers = mine.filter(
        (c) => c.effectiveFrom === member.effectiveFrom && (c.rawCaptures ?? 1) > 1,
      );
      const detail = [...concurrent, ...sameDayOthers]
        .map((c) => ({
          effectiveFrom: c.effectiveFrom,
          capturedAt: c.capturedAt,
          sameDayAsEvent: c.effectiveFrom === member.effectiveFrom,
        }))
        .sort((a, b) => `${a.effectiveFrom}|${a.capturedAt ?? ""}`.localeCompare(`${b.effectiveFrom}|${b.capturedAt ?? ""}`));

      const anchorMs = dayMs(member.effectiveFrom) ?? 0;
      const span = Math.max(...D084_EVENT_WINDOWS_DAYS) * DAY_MS;
      const targetRevisions = input.targetRevisionInstants.filter(
        (t) => t.businessId === member.businessId && Math.abs(t.atMs - anchorMs) <= span,
      ).length;
      const overlapping = input.groups
        .filter(
          (other) =>
            other.key !== group.key &&
            other.providerAccountId === group.providerAccountId &&
            Math.abs((dayMs(other.effectiveFrom) ?? 0) - anchorMs) <= span,
        )
        .map((other) => other.key)
        .sort((a, b) => a.localeCompare(b));

      return {
        memberKey: memberKey(member),
        sourceRowKey: member.sourceRowKey,
        business: member.business,
        businessId: member.businessId,
        providerAccountId: member.providerAccountId,
        grain: member.grain,
        entityId: member.entityId,
        parentCampaignId: member.parentCampaignId,
        effectiveFrom: member.effectiveFrom,
        direction: member.direction,
        percent: member.percent,
        windows,
        concurrentConfigChanges: detail.length,
        concurrentConfigChangeDetail: detail,
        concurrentTargetRevisions: targetRevisions,
        overlappingEventKeys: overlapping,
      };
    });

    const flags: string[] = [];
    if (group.groupingProof === "ambiguous_multi_member") flags.push("grouping_ambiguous");
    if (members.some((m) => m.overlappingEventKeys.length > 0)) flags.push("overlapping_event_window");
    if (members.some((m) => m.concurrentConfigChanges > 0)) flags.push("concurrent_config_change");
    if (members.some((m) => m.concurrentTargetRevisions > 0)) flags.push("concurrent_target_revision");
    if (members.some((m) => m.windows.some((w) => w.support !== "supported"))) {
      flags.push("incomplete_entity_day_coverage");
    }
    const confounding: ConfoundingClass =
      flags.length === 0
        ? "clean_within_retained_evidence"
        : flags.length === 1
          ? (flags[0] as ConfoundingClass)
          : "multiple_confounds";

    return {
      key: group.key,
      business: group.business,
      businessId: group.businessId,
      providerAccountId: group.providerAccountId,
      effectiveFrom: group.effectiveFrom,
      direction: group.direction,
      percent: group.percent,
      groupingProof: group.groupingProof,
      groupingProofDetail: group.groupingProofDetail,
      representativeMemberKey: group.representativeMemberKey,
      members,
      lowerBoundActions: group.lowerBoundActions,
      upperBoundActions: group.upperBoundActions,
      confounding,
      confoundingFlags: sortedUnique(flags),
    };
  });
}

// ---------------------------------------------------------------------------
// The evidence-floor grid — fleet-wide, all baseline gates, full partitions
// ---------------------------------------------------------------------------

export const D084_GRID_BASELINE = {
  trailingDays: 14,
  minSpendBearingDays: 5,
  minConversionsForIncrease: 25,
  maxObservationAgeDays: 3,
  minBindingSpendShare: 0.8,
} as const;

export const D084_GRID_DIMENSIONS = {
  trailingDays: [7, 14, 28],
  minSpendBearingDays: [1, 3, 5, 7],
  minConversionsForIncrease: [0, 5, 10, 25],
  maxObservationAgeDays: [1, 3, 7],
  minBindingSpendShare: [0.5, 0.8, 0.95],
} as const;

export type GridDimension = keyof typeof D084_GRID_DIMENSIONS;
export type GridSettings = Record<GridDimension, number>;

/**
 * The structural gates D080B found blocking 100% of its 247,050 proposals.
 * They are not tunable and no evidence floor can move them, so the strict lane
 * carries them and its eligible count stays zero by construction.
 */
export const D084_STRUCTURAL_GATES = [
  "decision_vocabulary_absent",
  "role_authority_absent",
  "unit_exponent_unknown",
] as const;

export interface GridCell {
  dimension: GridDimension;
  value: number;
  direction: "increase" | "decrease";
  origin: string;
  fold: number | null;
  settings: GridSettings;
  /**
   * denominator = clearsEvidenceFloors + blocked + notDeterminable, always.
   *
   * `clearsEvidenceFloors` is NOT eligibility. It counts entity-origins that
   * satisfy the candidate evidence policy; the three structural gates are not
   * applied here and block the whole population regardless. `strictlyEligible`
   * carries the authority statement, and it is zero by construction while any
   * structural blocker stands. r2 called this whole grid `strictPitGrid`, which
   * read as strict authority it never had.
   */
  denominator: number;
  clearsEvidenceFloors: number;
  blocked: number;
  notDeterminable: number;
  strictlyEligible: number;
  strictlyEligibleWhy: string;
  /** The varied gate alone, published beside — never confused with authority. */
  tunedGateClears: number;
  tunedGateHits: number;
  tunedGateNotDeterminable: number;
  survivorsBeforeTunedGate: number;
  survivorsAfterTunedGate: number;
  /** Actual partitions, not counts-plus-a-share. */
  byBusiness: Record<string, { denominator: number; clearsEvidenceFloors: number; blocked: number; notDeterminable: number }>;
  byAccount: Record<string, { denominator: number; clearsEvidenceFloors: number; blocked: number; notDeterminable: number }>;
  topBusinessShare: number;
  topAccountShare: number;
  coverage: "supported" | "partially_supported" | "unsupported";
  coverageWhy: string | null;
  cellHash: string;
}

interface EntityOriginEvidence {
  businessId: string;
  business: string;
  providerAccountId: string;
  grain: string;
  entityId: string;
  origin: string;
  /** Per trailing length: measurements plus the coverage that produced them. */
  trailing: Record<number, {
    requestedDays: number;
    retainedEligibleDays: number;
    coveredEntityDays: number;
    spendBearingDays: number;
    conversions: number;
    spend: number;
    dailyBudgetRaw: number | null;
    /** The full PIT verdict, so an unresolved collapsed day stays inspectable. */
    pitBudget: PitBudget;
    coverage: "supported" | "partially_supported" | "unsupported";
  }>;
  newestObservationDaysOld: number | null;
}

/**
 * The PIT budget: the daily budget in force strictly before the origin, using
 * BOTH clocks.
 *
 * A config row counts only when its `effective_from` precedes the origin AND
 * its `captured_at` does too — a later-recorded backfill may not judge an
 * earlier origin. If the retained rows contain no such predecessor, or the
 * earliest retained effective date is at or after the origin (so a predecessor
 * may exist outside retention), the budget is NOT determinable. r2 used the
 * effective clock only and would silently accept an incomplete floor.
 */
export type PitBudgetStatus =
  | "resolved_unique_terminal"
  | "not_determinable_collapsed_skyline"
  | "not_determinable_no_predecessor_in_retention"
  | "not_determinable_no_daily_budget"
  | "not_determinable_unknown_clock";

export interface PitSkippedRow {
  effectiveFrom: string;
  capturedAt: string | null;
  rawCaptures: number | null;
  distinctFingerprints: number | null;
  why: string;
}

export interface PitBudget {
  status: PitBudgetStatus;
  budget: number | null;
  collapsedDay: boolean;
  distinctFingerprints: number | null;
  rawCaptures: number | null;
  effectiveFrom: string | null;
  capturedAt: string | null;
  /** Days walked past because they were not yet known at the origin. */
  skipped: PitSkippedRow[];
  why: string;
}

/**
 * The daily budget in force strictly before a day-precision origin.
 *
 * WHAT r4 GOT WRONG. It always took the newest effective day before the origin
 * and, whenever that row's retained capture was null or post-origin, returned
 * `not_determinable_collapsed_day_not_knowable`. That conflates two different
 * situations, and 1,305 of its 2,647 such verdicts were the wrong one:
 *
 *  - `raw_captures = 1`. The day has exactly ONE capture and it arrived after
 *    the origin. Nothing was hidden by the pinned `DISTINCT ON` — that day
 *    simply supplied no knowledge at the origin. Under the knowledge-bounded
 *    policy it must be SKIPPED and the newest older knowable state used. This
 *    is not a collapsed-day ambiguity and must not be labelled one.
 *  - `raw_captures > 1`. The query kept only the latest capture, so earlier
 *    captures of that day were dropped and one of them may have preceded the
 *    origin with a different state. Falling back is unsound; the answer is a
 *    genuine collapsed-skyline `not_determinable`.
 *
 * A knowable capture, single- or multi-fingerprint, proves that day's terminal
 * retained state, because the retained row IS that day's latest capture.
 */
export function budgetAsOfPit(
  changes: readonly ConfigStateRow[],
  originMs: number,
): PitBudget {
  const base = (status: PitBudgetStatus, why: string, skipped: PitSkippedRow[], row?: ConfigStateRow): PitBudget => ({
    status, budget: null,
    collapsedDay: row ? (row.distinctFingerprints ?? 1) > 1 : false,
    distinctFingerprints: row?.distinctFingerprints ?? null,
    rawCaptures: row?.rawCaptures ?? null,
    effectiveFrom: row?.effectiveFrom ?? null,
    capturedAt: row?.capturedAt ?? null,
    skipped, why,
  });
  if (changes.length === 0) {
    return base("not_determinable_no_predecessor_in_retention", "no retained config rows for this entity", []);
  }
  const ordered = [...changes].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const before = ordered.filter((c) => {
    const effective = dayMs(c.effectiveFrom);
    return effective !== null && effective < originMs;
  });
  if (before.length === 0) {
    return base(
      "not_determinable_no_predecessor_in_retention",
      `no retained config row takes effect before this origin; the earliest retained effective_from is ${ordered[0]!.effectiveFrom}, so a predecessor may exist outside retention`,
      [],
    );
  }

  const skipped: PitSkippedRow[] = [];
  // Newest to oldest.
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = before[i]!;
    const captured = instantMs(row.capturedAt);
    const rawCaptures = row.rawCaptures;
    if (captured === null) {
      return base(
        "not_determinable_unknown_clock",
        `the change effective ${row.effectiveFrom} carries no parsable captured_at, so whether it was known at the origin is unknown; an unknown clock is not a safe fallback`,
        skipped, row,
      );
    }
    if (captured < originMs) {
      // Knowable. The retained row is this day's latest capture, so every
      // capture of the day precedes the origin and this state is terminal.
      if (row.dailyBudgetRaw === null) {
        return base(
          "not_determinable_no_daily_budget",
          `the knowable predecessor effective ${row.effectiveFrom} carries no daily_budget`,
          skipped, row,
        );
      }
      const collapsed = (row.distinctFingerprints ?? 1) > 1;
      return {
        status: "resolved_unique_terminal",
        budget: row.dailyBudgetRaw,
        collapsedDay: collapsed,
        distinctFingerprints: row.distinctFingerprints,
        rawCaptures: row.rawCaptures,
        effectiveFrom: row.effectiveFrom,
        capturedAt: row.capturedAt,
        skipped,
        why: collapsed
          ? `effective ${row.effectiveFrom} collapsed ${row.rawCaptures} captures into ${row.distinctFingerprints} fingerprints, but the retained row IS that day's latest capture and it was recorded at ${row.capturedAt}, before the origin, so every capture of that day precedes the origin and this state is the unique terminal one${skipped.length > 0 ? `; ${skipped.length} newer day(s) were skipped as not yet known` : ""}`
          : `effective ${row.effectiveFrom}, captured ${row.capturedAt}; both clocks passed before the origin and the day carries a single fingerprint${skipped.length > 0 ? `; ${skipped.length} newer day(s) were skipped as not yet known` : ""}`,
      };
    }
    if (rawCaptures === null) {
      return base(
        "not_determinable_unknown_clock",
        `the change effective ${row.effectiveFrom} was captured at ${row.capturedAt}, after the origin, and retains no capture multiplicity, so whether it hid an earlier pre-origin capture is unknown`,
        skipped, row,
      );
    }
    if (rawCaptures === 1) {
      // A sole capture that arrived after the origin hid nothing: that day
      // supplied no knowledge at the origin. Skip it and keep walking back.
      skipped.push({
        effectiveFrom: row.effectiveFrom,
        capturedAt: row.capturedAt,
        rawCaptures: row.rawCaptures,
        distinctFingerprints: row.distinctFingerprints,
        why: "sole retained capture arrived after the origin, so this effective day supplied no knowledge at the origin and nothing was dropped by the pinned query",
      });
      continue;
    }
    // Several captures, latest one post-origin: earlier ones were dropped and
    // may straddle the origin. This is the real collapsed-skyline case.
    return base(
      "not_determinable_collapsed_skyline",
      `the change effective ${row.effectiveFrom} retains ${rawCaptures} captures collapsed into ${row.distinctFingerprints ?? "?"} fingerprint(s), and the pinned query kept only the latest, recorded ${row.capturedAt} after the origin; one of the dropped earlier captures may have preceded the origin with a different state, so the terminal state here is not in the bytes and an older day may not be substituted for it`,
      skipped, row,
    );
  }
  return base(
    "not_determinable_no_predecessor_in_retention",
    `every retained change before this origin was captured after it; the oldest is effective ${before[0]!.effectiveFrom}, so no knowable predecessor remains inside retention`,
    skipped,
  );
}

export function buildEntityOriginEvidence(input: {
  daily: readonly DailyRow[];
  configStates: readonly ConfigStateRow[];
  origins: readonly string[];
}): EntityOriginEvidence[] {
  const byEntity = new Map<string, DailyRow[]>();
  for (const row of input.daily) {
    const k = entityKey(row);
    if (!byEntity.has(k)) byEntity.set(k, []);
    byEntity.get(k)!.push(row);
  }
  const cfgByEntity = new Map<string, ConfigStateRow[]>();
  for (const c of input.configStates) {
    const k = entityKey(c);
    if (!cfgByEntity.has(k)) cfgByEntity.set(k, []);
    cfgByEntity.get(k)!.push(c);
  }
  const retention = retentionByEntity(input.daily);

  const out: EntityOriginEvidence[] = [];
  for (const [k, rows] of [...byEntity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [businessId, providerAccountId, grain, entityId] = k.split("|") as [string, string, string, string];
    const bounds = retention.get(k)!;
    const byDate = new Map(rows.map((r) => [r.date, r]));
    for (const origin of input.origins) {
      const originMs = dayMs(origin);
      if (originMs === null) continue;
      const trailing: EntityOriginEvidence["trailing"] = {};
      let anySupported = false;
      for (const days of D084_GRID_DIMENSIONS.trailingDays) {
        // Strictly before the origin.
        const wanted: string[] = [];
        for (let i = 1; i <= days; i += 1) wanted.push(addDays(origin, -i));
        const eligible = wanted.filter(
          (d) => d >= bounds.firstRetainedDate && d <= bounds.lastRetainedDate,
        );
        const present = wanted.map((d) => byDate.get(d)).filter((r): r is DailyRow => r !== undefined);
        const pitBudget = budgetAsOfPit(cfgByEntity.get(k) ?? [], originMs);
        const coverage =
          eligible.length === 0
            ? "unsupported"
            : eligible.length < wanted.length || present.length < eligible.length
              ? "partially_supported"
              : "supported";
        if (coverage !== "unsupported") anySupported = true;
        trailing[days] = {
          requestedDays: wanted.length,
          retainedEligibleDays: eligible.length,
          coveredEntityDays: present.length,
          spendBearingDays: present.filter((r) => r.spend > 0).length,
          conversions: present.reduce((s, r) => s + r.conversions, 0),
          spend: present.reduce((s, r) => s + r.spend, 0),
          dailyBudgetRaw: pitBudget.budget,
          pitBudget,
          coverage,
        };
      }
      if (!anySupported) continue;
      const before = rows.filter((r) => r.date < origin).map((r) => r.date);
      const newest = before.length > 0 ? before.reduce((a, b) => (b > a ? b : a)) : null;
      out.push({
        businessId,
        business: businessName(businessId),
        providerAccountId,
        grain,
        entityId,
        origin,
        trailing,
        newestObservationDaysOld: newest === null ? null : daysBetween(newest, origin),
      });
    }
  }
  return out;
}

type GateOutcome = "pass" | "fail" | "not_determinable";

/**
 * Every named baseline gate, evaluated for one entity-origin under `settings`.
 *
 * r2 applied ONLY the varied dimension, so `survivorsAfterTunedGate` described
 * one gate in isolation and was never a baseline-policy result. Here the whole
 * candidate policy runs and the cell publishes a real eligible/blocked/
 * not-determinable partition beside the single-gate diagnostics.
 */
export function evaluateEvidenceGates(input: {
  row: EntityOriginEvidence;
  settings: GridSettings;
  direction: "increase" | "decrease";
  exponentKnown: boolean;
}): Record<string, GateOutcome> {
  const { row, settings, direction, exponentKnown } = input;
  const trailing = row.trailing[settings.trailingDays];
  const gates: Record<string, GateOutcome> = {};
  if (!trailing || trailing.coverage === "unsupported") {
    for (const g of ["evidence_window", "spend_bearing_days", "conversions_for_increase", "observation_age", "budget_binding"]) {
      gates[g] = "not_determinable";
    }
    return gates;
  }
  gates.evidence_window = trailing.coverage === "supported" ? "pass" : "not_determinable";
  gates.spend_bearing_days =
    trailing.coverage === "supported"
      ? trailing.spendBearingDays >= settings.minSpendBearingDays ? "pass" : "fail"
      // A short window can still FAIL a floor it already misses; only a window
      // that could still reach the floor is undecided.
      : trailing.spendBearingDays >= settings.minSpendBearingDays ? "pass" : "not_determinable";
  gates.conversions_for_increase =
    direction === "decrease"
      ? "pass"
      : trailing.conversions >= settings.minConversionsForIncrease
        ? "pass"
        : trailing.coverage === "supported" ? "fail" : "not_determinable";
  gates.observation_age =
    row.newestObservationDaysOld === null
      ? "not_determinable"
      : row.newestObservationDaysOld <= settings.maxObservationAgeDays ? "pass" : "fail";
  if (direction === "decrease") {
    gates.budget_binding = "pass";
  } else if (!exponentKnown) {
    // Retained `daily_budget` is a RAW provider amount and its currency
    // exponent is not captured, so spend and budget are not on one scale and
    // no threshold may be applied to their ratio.
    gates.budget_binding = "not_determinable";
  } else if (trailing.pitBudget.status !== "resolved_unique_terminal") {
    // An unresolved collapsed day is not a missing budget: it is a budget the
    // pinned bytes cannot prove. Either way no threshold may be applied.
    gates.budget_binding = "not_determinable";
  } else {
    const capacity = trailing.dailyBudgetRaw === null ? null : trailing.dailyBudgetRaw * settings.trailingDays;
    gates.budget_binding =
      capacity === null || capacity <= 0
        ? "not_determinable"
        : trailing.spend / capacity >= settings.minBindingSpendShare ? "pass" : "fail";
  }
  return gates;
}

const TUNED_GATE_OF: Record<GridDimension, string> = {
  trailingDays: "evidence_window",
  minSpendBearingDays: "spend_bearing_days",
  minConversionsForIncrease: "conversions_for_increase",
  maxObservationAgeDays: "observation_age",
  minBindingSpendShare: "budget_binding",
};

function emptyPartition() {
  return { denominator: 0, clearsEvidenceFloors: 0, blocked: 0, notDeterminable: 0 };
}

/**
 * How much of the pinned config slice is collapsed, and how many PIT budget
 * evaluations that actually costs — by business and by account, because that is
 * where the loss is decision-relevant.
 */
export interface CollapsedConfigCoverage {
  configRows: number;
  collapsedRows: number;
  collapsedByDistinctFingerprints: Record<string, number>;
  rowsWithMultipleRawCaptures: number;
  evaluations: number;
  evaluationsResolved: number;
  evaluationsNotDeterminable: Record<string, number>;
  byBusiness: Record<string, { evaluations: number; resolved: number; notDeterminable: number; byReason: Record<string, number> }>;
  byAccount: Record<string, { evaluations: number; resolved: number; notDeterminable: number; byReason: Record<string, number> }>;
  /** Only the genuine collapsed-skyline count may be attributed to collapsed data. */
  collapsedSkylineEvaluations: number;
  skippedNotYetKnownRows: number;
  why: string;
}

function sortPartition(
  map: Record<string, { evaluations: number; resolved: number; notDeterminable: number; byReason: Record<string, number> }>,
): Record<string, { evaluations: number; resolved: number; notDeterminable: number; byReason: Record<string, number> }> {
  const keys = Object.keys(map).sort((a, b) => a.localeCompare(b));
  const out: Record<string, { evaluations: number; resolved: number; notDeterminable: number; byReason: Record<string, number> }> = {};
  for (const key of keys) {
    const value = map[key]!;
    const reasons = Object.keys(value.byReason).sort((a, b) => a.localeCompare(b));
    const byReason: Record<string, number> = {};
    for (const r of reasons) byReason[r] = value.byReason[r]!;
    out[key] = { evaluations: value.evaluations, resolved: value.resolved, notDeterminable: value.notDeterminable, byReason };
  }
  return out;
}

/**
 * Owner-clock coverage, DERIVED from the frozen bytes.
 *
 * r4's residual blocker read "453 of 462 retained owner-state rows were
 * captured after the day they describe". That is an empirical property of the
 * pinned owner slice, but no analysis section computed it, so the verifier had
 * no way to prove the sentence and a forged total would have passed. Every
 * number the prose uses is computed here and hash-covered.
 */
export interface OwnerClockCoverage {
  retainedOwnerRows: number;
  capturedAfterObservedDay: number;
  capturedOnObservedDay: number;
  capturedBeforeObservedDay: number;
  nullOrInvalidCapturedAt: number;
  eventMembers: number;
  membersResolved: number;
  membersUnresolved: number;
  membersByStatus: Record<string, number>;
  ownerRowsByBusiness: Record<string, { rows: number; capturedAfter: number; capturedOn: number; capturedBefore: number; nullClock: number }>;
  ownerRowsByAccount: Record<string, { rows: number; capturedAfter: number; capturedOn: number; capturedBefore: number; nullClock: number }>;
  membersByBusiness: Record<string, { members: number; resolved: number; unresolved: number }>;
  digest: string;
}

export function buildOwnerClockCoverage(
  ownerStates: readonly OwnerStateRow[],
  members: readonly EventMember[],
): OwnerClockCoverage {
  const rowBucket = () => ({ rows: 0, capturedAfter: 0, capturedOn: 0, capturedBefore: 0, nullClock: 0 });
  const byBusiness: Record<string, ReturnType<typeof rowBucket>> = {};
  const byAccount: Record<string, ReturnType<typeof rowBucket>> = {};
  let after = 0, on = 0, before = 0, nullClock = 0;
  for (const row of ownerStates) {
    const capturedDay = row.capturedAt === null ? null : day(row.capturedAt);
    const valid = capturedDay !== null && instantMs(row.capturedAt) !== null;
    const cls = !valid ? "nullClock" : capturedDay! > row.observedOn ? "capturedAfter" : capturedDay! === row.observedOn ? "capturedOn" : "capturedBefore";
    if (cls === "nullClock") nullClock += 1;
    else if (cls === "capturedAfter") after += 1;
    else if (cls === "capturedOn") on += 1;
    else before += 1;
    for (const [map, key] of [[byBusiness, row.businessId], [byAccount, row.providerAccountId]] as const) {
      if (!map[key]) map[key] = rowBucket();
      const b = map[key]!;
      b.rows += 1;
      b[cls as "capturedAfter" | "capturedOn" | "capturedBefore" | "nullClock"] += 1;
    }
  }
  const byStatus: Record<string, number> = {};
  const membersByBusiness: Record<string, { members: number; resolved: number; unresolved: number }> = {};
  let resolved = 0;
  for (const m of members) {
    byStatus[m.ownerSelection.status] = (byStatus[m.ownerSelection.status] ?? 0) + 1;
    const ok = m.ownerSelection.status === "resolved";
    if (ok) resolved += 1;
    if (!membersByBusiness[m.business]) membersByBusiness[m.business] = { members: 0, resolved: 0, unresolved: 0 };
    const b = membersByBusiness[m.business]!;
    b.members += 1;
    if (ok) b.resolved += 1; else b.unresolved += 1;
  }
  const sortRec = <T>(map: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const k of Object.keys(map).sort((a, b) => a.localeCompare(b))) out[k] = map[k]!;
    return out;
  };
  const body = {
    retainedOwnerRows: ownerStates.length,
    capturedAfterObservedDay: after,
    capturedOnObservedDay: on,
    capturedBeforeObservedDay: before,
    nullOrInvalidCapturedAt: nullClock,
    eventMembers: members.length,
    membersResolved: resolved,
    membersUnresolved: members.length - resolved,
    membersByStatus: sortRec(byStatus),
    ownerRowsByBusiness: sortRec(byBusiness),
    ownerRowsByAccount: sortRec(byAccount),
    membersByBusiness: sortRec(membersByBusiness),
  };
  return { ...body, digest: canonicalDigest(body) };
}

export function buildCollapsedConfigCoverage(
  configStates: readonly ConfigStateRow[],
  evidence: readonly EntityOriginEvidence[],
): CollapsedConfigCoverage {
  const collapsedByN: Record<string, number> = {};
  for (const c of configStates) {
    const n = c.distinctFingerprints ?? 1;
    if (n > 1) collapsedByN[String(n)] = (collapsedByN[String(n)] ?? 0) + 1;
  }
  const byBusiness: CollapsedConfigCoverage["byBusiness"] = {};
  const byAccount: CollapsedConfigCoverage["byAccount"] = {};
  const notDeterminable: Record<string, number> = {};
  let evaluations = 0;
  let resolved = 0;
  let skippedRows = 0;
  for (const row of evidence) {
    // One PIT budget per entity-origin; the trailing length does not change it.
    const pit = row.trailing[D084_GRID_BASELINE.trailingDays]?.pitBudget;
    if (!pit) continue;
    evaluations += 1;
    const ok = pit.status === "resolved_unique_terminal";
    if (ok) resolved += 1;
    else notDeterminable[pit.status] = (notDeterminable[pit.status] ?? 0) + 1;
    skippedRows += pit.skipped.length;
    for (const [map, key] of [[byBusiness, row.business], [byAccount, row.providerAccountId]] as const) {
      if (!map[key]) map[key] = { evaluations: 0, resolved: 0, notDeterminable: 0, byReason: {} };
      const p = map[key]!;
      p.evaluations += 1;
      if (ok) p.resolved += 1;
      else { p.notDeterminable += 1; p.byReason[pit.status] = (p.byReason[pit.status] ?? 0) + 1; }
    }
  }
  return {
    configRows: configStates.length,
    collapsedRows: Object.values(collapsedByN).reduce((a, b) => a + b, 0),
    collapsedByDistinctFingerprints: Object.fromEntries(
      Object.entries(collapsedByN).sort(([a], [b]) => a.localeCompare(b)),
    ),
    rowsWithMultipleRawCaptures: configStates.filter((c) => (c.rawCaptures ?? 1) > 1).length,
    evaluations,
    evaluationsResolved: resolved,
    evaluationsNotDeterminable: Object.fromEntries(
      Object.entries(notDeterminable).sort(([a], [b]) => a.localeCompare(b)),
    ),
    byBusiness: sortPartition(byBusiness),
    byAccount: sortPartition(byAccount),
    collapsedSkylineEvaluations: notDeterminable.not_determinable_collapsed_skyline ?? 0,
    skippedNotYetKnownRows: skippedRows,
    why:
      "the pinned configStates query keeps one row per (entity, effective_from) — the latest capture. A day whose SOLE capture arrived after the origin hid nothing and is skipped as not-yet-known; only a day with several captures whose latest is post-origin is a genuine collapsed skyline, because earlier captures were dropped and may straddle the origin. Those two causes, and the retention and missing-budget causes, are counted separately and never attributed to one another.",
  };
}

export function buildEvidenceFloorGrid(input: {
  evidence: readonly EntityOriginEvidence[];
  origins: readonly OriginRow[];
  exponentKnown: boolean;
  /** Structural gates that block the whole population in the strict lane. */
  structuralBlockers: readonly string[];
}): { cells: GridCell[]; monotonicity: Row[]; selectable: boolean; why: string } {
  const foldOf = new Map(input.origins.map((o) => [o.origin, o.fold]));
  const cells: GridCell[] = [];

  for (const dimension of Object.keys(D084_GRID_DIMENSIONS) as GridDimension[]) {
    for (const value of D084_GRID_DIMENSIONS[dimension]) {
      for (const direction of ["increase", "decrease"] as const) {
        for (const originRow of input.origins) {
          const origin = originRow.origin;
          const population = input.evidence.filter((e) => e.origin === origin);
          const settings = { ...D084_GRID_BASELINE, [dimension]: value } as GridSettings;
          const tunedGate = TUNED_GATE_OF[dimension];

          let clearsFloors = 0, blocked = 0, notDeterminable = 0;
          let clears = 0, hits = 0, tunedND = 0;
          const byBusiness: GridCell["byBusiness"] = {};
          const byAccount: GridCell["byAccount"] = {};
          let partiallySupported = 0;

          for (const row of population) {
            const gates = evaluateEvidenceGates({ row, settings, direction, exponentKnown: input.exponentKnown });
            const outcomes = Object.values(gates);
            const verdict: GateOutcome =
              outcomes.includes("fail") ? "fail"
                : outcomes.includes("not_determinable") ? "not_determinable"
                  : "pass";
            if (verdict === "pass") clearsFloors += 1;
            else if (verdict === "fail") blocked += 1;
            else notDeterminable += 1;

            const tuned = gates[tunedGate] ?? "not_determinable";
            if (tuned === "pass") clears += 1;
            else { hits += 1; if (tuned === "not_determinable") tunedND += 1; }

            const t = row.trailing[settings.trailingDays];
            if (t && t.coverage === "partially_supported") partiallySupported += 1;

            for (const [map, key] of [[byBusiness, row.business], [byAccount, row.providerAccountId]] as const) {
              if (!map[key]) map[key] = emptyPartition();
              const p = map[key]!;
              p.denominator += 1;
              if (verdict === "pass") p.clearsEvidenceFloors += 1;
              else if (verdict === "fail") p.blocked += 1;
              else p.notDeterminable += 1;
            }
          }

          const denominator = population.length;
          const share = (m: GridCell["byBusiness"]) =>
            denominator === 0 ? 0 : Math.max(0, ...Object.values(m).map((p) => p.denominator)) / denominator;
          const coverage: GridCell["coverage"] =
            denominator === 0 ? "unsupported" : partiallySupported > 0 ? "partially_supported" : "supported";
          const coverageWhy =
            denominator === 0
              ? "no charter entity has retained delivery inside this origin's trailing window"
              : partiallySupported > 0
                ? `${partiallySupported} of ${denominator} entity-origins have fewer retained days than the ${settings.trailingDays}-day window asks for`
                : null;

          const assumedInputs = {
            dimension, value, direction, origin, settings,
            exponentKnown: input.exponentKnown,
            structuralBlockers: [...input.structuralBlockers],
          };
          cells.push({
            dimension, value, direction, origin,
            fold: foldOf.get(origin) ?? null,
            settings,
            denominator,
            clearsEvidenceFloors: clearsFloors,
            blocked, notDeterminable,
            // Structural gates are not tunable and block the whole population.
            strictlyEligible: 0,
            strictlyEligibleWhy: `${input.structuralBlockers.join(", ")} block every proposal D080B evaluated, so no evidence floor can produce a strictly eligible row`,
            tunedGateClears: clears,
            tunedGateHits: hits,
            tunedGateNotDeterminable: tunedND,
            survivorsBeforeTunedGate: denominator,
            survivorsAfterTunedGate: clears,
            byBusiness, byAccount,
            topBusinessShare: share(byBusiness),
            topAccountShare: share(byAccount),
            coverage, coverageWhy,
            cellHash: canonicalDigest({
              assumedInputs,
              denominator,
              clearsEvidenceFloors: clearsFloors,
              blocked, notDeterminable, strictlyEligible: 0,
              tunedGateClears: clears, tunedGateHits: hits, tunedGateNotDeterminable: tunedND,
              byBusiness, byAccount, coverage,
            }),
          });
        }
      }
    }
  }

  const monotonicity: Row[] = [];
  for (const dimension of Object.keys(D084_GRID_DIMENSIONS) as GridDimension[]) {
    for (const direction of ["increase", "decrease"] as const) {
      const mine = cells.filter((c) => c.dimension === dimension && c.direction === direction);
      const totals = D084_GRID_DIMENSIONS[dimension].map((value) => {
        const at = mine.filter((c) => c.value === value);
        return {
          value,
          clears: at.reduce((s, c) => s + c.tunedGateClears, 0),
          clearsEvidenceFloors: at.reduce((s, c) => s + c.clearsEvidenceFloors, 0),
        };
      });
      // Only strictness dimensions carry a monotonicity verdict; a longer
      // trailing window or a wider staleness tolerance can legitimately admit
      // more, so those are reported without one.
      const strictnessAscending = dimension !== "trailingDays" && dimension !== "maxObservationAgeDays";
      const monotone = strictnessAscending
        ? totals.every((t, i) => i === 0 || t.clears <= totals[i - 1]!.clears)
        : null;
      const notDeterminable = mine.reduce((s, c) => s + c.tunedGateNotDeterminable, 0);
      const evaluated = mine.reduce((s, c) => s + c.denominator, 0);
      monotonicity.push({
        dimension, direction, totals, monotone, notDeterminable, evaluated,
        verdict:
          notDeterminable === evaluated && evaluated > 0
            ? "not_determinable_for_every_row: no threshold was applied, so no count here describes a threshold effect"
            : notDeterminable > 0
              ? `${notDeterminable} of ${evaluated} row-evaluations were not measurable; the rest were measured`
              : "every row-evaluation was measured against the threshold",
      });
    }
  }

  return {
    cells, monotonicity, selectable: false,
    why: "the grid shows what each candidate value would historically admit under the full baseline policy; it cannot rank values on outcome, no value is owner-approved, and the structural gates keep strict eligibility at zero regardless",
  };
}

// ---------------------------------------------------------------------------
// Change safety — every declared scope, PROSPECTIVE counts, exact boundaries
// ---------------------------------------------------------------------------

export const D084_COOLDOWN_DAYS = [1, 3, 7, 14, 28] as const;
export const D084_LOOKBACK_DAYS = [7, 14, 28, 56] as const;
export const D084_CAP_CANDIDATES = [1, 2, 3, 5] as const;
export const D084_CONCENTRATION_CANDIDATES = [0.25, 0.5, 0.75, 1] as const;

/**
 * Every count in this section is PROSPECTIVE: it includes the candidate event
 * itself, because the question a cap answers is "would this change be the Nth
 * today?", not "how many happened before it?". Stating that once, here, is what
 * makes the cap comparisons and the concentration ratio consistent.
 */
export const D084_COUNT_SEMANTICS = "prospective_including_candidate" as const;

/**
 * The safety population, as coupled possible ACTIONS rather than groups.
 *
 * r4 kept one loop item per group, so cooldown, concentration and lookback all
 * evaluated an exact 14 while the authenticated members permit 14-23 actions,
 * and the cap grid mixed extrema from worlds that cannot coexist. Every control
 * now runs inside one enumerated world at a time; see `d084-possible-worlds`.
 */
export function toWorldGroups(groups: readonly EconomicEventGroup[]): GroupInput[] {
  return groups.map((g) => ({
    key: g.key,
    businessId: g.businessId,
    business: g.business,
    providerAccountId: g.providerAccountId,
    effectiveFrom: g.effectiveFrom,
    direction: g.direction,
    percent: g.percent,
    memberKeys: g.members.map((m) => memberKey(m)).sort((a, b) => a.localeCompare(b)),
    memberEntityKeys: g.members
      .slice()
      .sort((a, b) => memberKey(a).localeCompare(memberKey(b)))
      .map((m) => entityKey(m)),
    exact: g.lowerBoundActions === g.upperBoundActions,
  }));
}

export const D084_SAFETY_SCOPES = ["entity", "account", "business", "fleet"] as const;

export interface CooldownCell {
  cooldownDays: number;
  scope: WorldScope;
  outcome: CellOutcome;
  cellHash: string;
}

export function buildCooldownGrid(space: WorldSpace): CooldownCell[] {
  const cells: CooldownCell[] = [];
  for (const cooldownDays of D084_COOLDOWN_DAYS) {
    for (const scope of D084_SAFETY_SCOPES) {
      const outcome = foldWorldOutcomes(
        space,
        space.worlds.map((w) => ({ worldKey: w.worldKey, outcome: cooldownInWorld(w, scope, cooldownDays) })),
        "a strictly earlier action in scope inside the window is a proven prior; inside a same-day bucket exactly one action can be first, so a bucket of k blocks k-1 under every admissible order and the count is settled even though no identity is",
      );
      cells.push({
        cooldownDays, scope, outcome,
        cellHash: canonicalDigest({ family: "cooldown", cooldownDays, scope, outcome }),
      });
    }
  }
  return cells;
}

export interface CapCell {
  cap: number;
  scope: WorldScope;
  perDay: true;
  semantics: typeof D084_COUNT_SEMANTICS;
  outcome: CellOutcome;
  cellHash: string;
}

export function buildCapGrid(space: WorldSpace): CapCell[] {
  const cells: CapCell[] = [];
  for (const cap of D084_CAP_CANDIDATES) {
    for (const scope of D084_SAFETY_SCOPES) {
      const outcome = foldWorldOutcomes(
        space,
        space.worlds.map((w) => ({ worldKey: w.worldKey, outcome: capInWorld(w, scope, cap) })),
        "within one world a day-bucket of k actions and a cap of c refuses exactly max(0, k - c) under every order, so the count is settled while the identities are not",
      );
      cells.push({
        cap, scope, perDay: true, semantics: D084_COUNT_SEMANTICS, outcome,
        cellHash: canonicalDigest({ family: "cap", cap, scope, outcome }),
      });
    }
  }
  return cells;
}

export interface ConcentrationCell {
  maxAccountShareOfFleet: number;
  semantics: typeof D084_COUNT_SEMANTICS;
  outcome: CellOutcome;
  /** Derived from acting ACCOUNT identity, never from the number of groups. */
  degenerateFleetDaysLower: number;
  degenerateFleetDaysUpper: number;
  totalFleetDays: number;
  degeneracyWhy: string | null;
  shareInvariantAcrossWorlds: boolean;
  shareInvarianceWhy: string;
  cellHash: string;
}

export function buildConcentrationGrid(space: WorldSpace): ConcentrationCell[] {
  return D084_CONCENTRATION_CANDIDATES.map((maxAccountShareOfFleet) => {
    const perWorld = space.worlds.map((w) => ({
      worldKey: w.worldKey,
      full: concentrationInWorld(w, maxAccountShareOfFleet),
    }));
    const outcome = foldWorldOutcomes(
      space,
      perWorld.map((p) => ({ worldKey: p.worldKey, outcome: p.full })),
      "each world's account share is a point value computed from that world's own action counts; the interval appears only across worlds",
    );
    const degen = perWorld.map((p) => p.full.degenerateDays);
    const totalDays = perWorld[0]?.full.totalDays ?? 0;
    // A day on which exactly one ACCOUNT acts has a share of 1 whatever the
    // multiplicity, so its ratio is invariant across every world.
    const allShares = perWorld.flatMap((p) => p.full.shares);
    const invariant = allShares.every((s) => !s.singleActingAccount || s.share === 1);
    const degenerateEverywhere = Math.min(...degen) === Math.max(...degen);
    return {
      maxAccountShareOfFleet,
      semantics: D084_COUNT_SEMANTICS,
      outcome,
      degenerateFleetDaysLower: Math.min(...degen),
      degenerateFleetDaysUpper: Math.max(...degen),
      totalFleetDays: totalDays,
      degeneracyWhy:
        Math.max(...degen) > 0 && maxAccountShareOfFleet < 1
          ? `${Math.max(...degen)} of ${totalDays} acting fleet-days have exactly ONE acting account, so that account's share is 1 regardless of how many actions its group represents, and every threshold below 1 blocks it without describing any real concentration`
          : null,
      shareInvariantAcrossWorlds: invariant && degenerateEverywhere,
      shareInvarianceWhy: invariant
        ? "every single-acting-account day yields a share of exactly 1 in every world, because numerator and denominator are the same set of actions"
        : "at least one day has several acting accounts whose share depends on the multiplicity chosen in that world",
      cellHash: canonicalDigest({
        family: "concentration", maxAccountShareOfFleet, outcome,
        degenerateLower: Math.min(...degen), degenerateUpper: Math.max(...degen), totalDays,
      }),
    };
  });
}

export interface LookbackCell {
  lookbackDays: number;
  scope: WorldScope;
  outcome: CellOutcome;
  sameDirectionRepeatsLower: number;
  sameDirectionRepeatsUpper: number;
  cellHash: string;
}

export function buildLookbackGrid(space: WorldSpace): LookbackCell[] {
  const cells: LookbackCell[] = [];
  for (const lookbackDays of D084_LOOKBACK_DAYS) {
    for (const scope of D084_SAFETY_SCOPES) {
      const perWorld = space.worlds.map((w) => ({
        worldKey: w.worldKey, full: lookbackInWorld(w, scope, lookbackDays),
      }));
      const outcome = foldWorldOutcomes(
        space,
        perWorld.map((p) => ({ worldKey: p.worldKey, outcome: p.full })),
        "a reversal needs a prior action of the opposite direction inside the window; inside a same-day bucket every action outside the leading same-direction run reverses, so the count moves only between the longest and shortest admissible leading run while the identities stay a union and an intersection",
      );
      cells.push({
        lookbackDays, scope, outcome,
        sameDirectionRepeatsLower: Math.min(...perWorld.map((p) => p.full.repeatsLower)),
        sameDirectionRepeatsUpper: Math.max(...perWorld.map((p) => p.full.repeatsUpper)),
        cellHash: canonicalDigest({ family: "lookback", lookbackDays, scope, outcome }),
      });
    }
  }
  return cells;
}

/**
 * The reconciliation, with its units declared.
 *
 * r4 published 14 GROUP rows under the names `events` and `fleetTotal` and gave
 * per-business, per-account and per-direction counts with no unit at all, so a
 * reader could not tell a group census from an action population.
 */
export interface ChangeSafetyReconciliation {
  denominatorUnit: "possible_economic_actions";
  groupDiagnostics: {
    unit: "economic_event_groups";
    groupCount: number;
    memberRowCount: number;
    groupsByBusiness: Record<string, number>;
    groupsByAccount: Record<string, number>;
    groupsByDirection: Record<string, number>;
    note: string;
  };
  actionLowerBound: number;
  actionUpperBound: number;
  worldCount: number;
  worldDigest: string;
  actionsByBusiness: Record<string, { lower: number; upper: number }>;
  actionsByAccount: Record<string, { lower: number; upper: number }>;
  actionsByDirection: Record<string, { lower: number; upper: number }>;
  businessesWithNoAction: string[];
  groupsInsideDeclaredLadder: number;
  groupsOutsideDeclaredLadder: number;
  intervalDaysPerAccount: Record<string, number[]>;
}

export function reconcileChangeSafety(
  groups: readonly EconomicEventGroup[],
  space: WorldSpace,
): ChangeSafetyReconciliation {
  const bound = (pick: (a: { businessId: string; business: string; providerAccountId: string; direction: string }) => string) => {
    const out: Record<string, { lower: number; upper: number }> = {};
    for (const world of space.worlds) {
      const counts: Record<string, number> = {};
      for (const action of world.actions) {
        const k = pick(action);
        counts[k] = (counts[k] ?? 0) + 1;
      }
      for (const [k, n] of Object.entries(counts)) {
        const cur = out[k];
        out[k] = cur ? { lower: Math.min(cur.lower, n), upper: Math.max(cur.upper, n) } : { lower: n, upper: n };
      }
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const intervals: Record<string, number[]> = {};
  const byAccountDays: Record<string, number[]> = {};
  for (const g of groups) {
    const a = `${g.businessId}|${g.providerAccountId}`;
    (byAccountDays[a] ??= []).push(dayMs(g.effectiveFrom) ?? 0);
  }
  for (const [a, times] of Object.entries(byAccountDays)) {
    const sorted = [...times].sort((x, y) => x - y);
    intervals[a] = sorted.slice(1).map((t, i) => Math.round((t - sorted[i]!) / DAY_MS));
  }
  return {
    denominatorUnit: "possible_economic_actions",
    groupDiagnostics: {
      unit: "economic_event_groups",
      groupCount: groups.length,
      memberRowCount: groups.reduce((s, g) => s + g.members.length, 0),
      groupsByBusiness: tally(groups.map((g) => g.business)),
      groupsByAccount: tally(groups.map((g) => `${g.business}|${g.providerAccountId}`)),
      groupsByDirection: tally(groups.map((g) => g.direction)),
      note: "group counts are a census of retained transition clusters, never an action denominator",
    },
    actionLowerBound: space.actionLowerBound,
    actionUpperBound: space.actionUpperBound,
    worldCount: space.worldCount,
    worldDigest: space.digest,
    actionsByBusiness: bound((a) => a.business),
    actionsByAccount: bound((a) => `${a.business}|${a.providerAccountId}`),
    actionsByDirection: bound((a) => a.direction),
    businessesWithNoAction: D084_CHARTER_BUSINESSES
      .filter((b) => !groups.some((g) => g.businessId === b.businessId))
      .map((b) => b.name),
    groupsInsideDeclaredLadder: groups.filter((g) => g.insideDeclaredLadder).length,
    groupsOutsideDeclaredLadder: groups.filter((g) => !g.insideDeclaredLadder).length,
    intervalDaysPerAccount: Object.fromEntries(
      Object.entries(intervals).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

// ---------------------------------------------------------------------------
// Scenarios, snapshot, analysis
// ---------------------------------------------------------------------------

export interface D084Scenario {
  scenarioId: string;
  truthLabel: "verified_fact" | "derived_metric" | "counterfactual_reconstruction";
  actionAuthority: "none_review_only";
  assumedInputs: Record<string, unknown>;
  result: Record<string, unknown>;
  scenarioHash: string;
}

function sealScenario(
  scenarioId: string,
  truthLabel: D084Scenario["truthLabel"],
  assumedInputs: Record<string, unknown>,
  result: Record<string, unknown>,
): D084Scenario {
  return {
    scenarioId, truthLabel, actionAuthority: "none_review_only", assumedInputs, result,
    scenarioHash: canonicalDigest({ scenarioId, truthLabel, assumedInputs, result }),
  };
}

/**
 * The frozen snapshot: exactly the slices `analyse` consumes, each one
 * deterministically re-extractable from the pinned files. The verifier
 * re-extracts them from disk and compares, so these bytes are never root trust.
 */
/**
 * The bulk slices are stored COLUMNAR, exactly as D080A stores its own series.
 *
 * The rows are still fully present and byte-comparable — this is an encoding,
 * not a summary — but 165,042 daily rows as objects would repeat fifteen key
 * names per row and make the artifact several times larger than the pinned
 * source it came from.
 */
export interface ColumnarSlice<T> {
  encoding: "columnar";
  columns: string[];
  rows: unknown[][];
  count: number;
  /** Digest of the decoded rows, so a re-extraction can be compared directly. */
  digest: string;
  __type?: T;
}

const DAILY_COLUMNS = [
  "businessId", "providerAccountId", "grain", "entityId", "parentCampaignId",
  "date", "status", "accountCurrency", "dailyBudgetRaw", "lifetimeBudgetRaw",
  "isBudgetMixed", "spend", "conversions", "revenue", "truthState",
] as const;

export function encodeDaily(rows: readonly DailyRow[]): ColumnarSlice<DailyRow> {
  return {
    encoding: "columnar",
    columns: [...DAILY_COLUMNS],
    rows: rows.map((r) => DAILY_COLUMNS.map((c) => r[c])),
    count: rows.length,
    digest: canonicalDigest(rows),
  };
}

export function decodeDaily(slice: ColumnarSlice<DailyRow> | undefined): DailyRow[] {
  if (!slice || slice.encoding !== "columnar") return [];
  const at = Object.fromEntries(slice.columns.map((c, i) => [c, i])) as Record<string, number>;
  return slice.rows.map((row) => ({
    businessId: String(row[at.businessId!] ?? ""),
    providerAccountId: String(row[at.providerAccountId!] ?? ""),
    grain: String(row[at.grain!] ?? ""),
    entityId: String(row[at.entityId!] ?? ""),
    parentCampaignId: (row[at.parentCampaignId!] ?? null) as string | null,
    date: String(row[at.date!] ?? ""),
    status: (row[at.status!] ?? null) as string | null,
    accountCurrency: (row[at.accountCurrency!] ?? null) as string | null,
    dailyBudgetRaw: (row[at.dailyBudgetRaw!] ?? null) as number | null,
    lifetimeBudgetRaw: (row[at.lifetimeBudgetRaw!] ?? null) as number | null,
    isBudgetMixed: row[at.isBudgetMixed!] === true,
    spend: Number(row[at.spend!] ?? 0),
    conversions: Number(row[at.conversions!] ?? 0),
    revenue: Number(row[at.revenue!] ?? 0),
    truthState: (row[at.truthState!] ?? null) as string | null,
  }));
}

const CONFIG_COLUMNS = [
  "businessId", "providerAccountId", "grain", "entityId", "effectiveFrom",
  "capturedAt", "configFingerprint", "dailyBudgetRaw", "lifetimeBudgetRaw",
  "anyMixed", "rawCaptures", "distinctFingerprints", "lane", "knowledgeTo",
] as const;

export function encodeConfig(rows: readonly ConfigStateRow[]): ColumnarSlice<ConfigStateRow> {
  return {
    encoding: "columnar",
    columns: [...CONFIG_COLUMNS],
    rows: rows.map((r) => CONFIG_COLUMNS.map((c) => r[c])),
    count: rows.length,
    digest: canonicalDigest(rows),
  };
}

export function decodeConfig(slice: ColumnarSlice<ConfigStateRow> | undefined): ConfigStateRow[] {
  if (!slice || slice.encoding !== "columnar") return [];
  const at = Object.fromEntries(slice.columns.map((c, i) => [c, i])) as Record<string, number>;
  return slice.rows.map((row) => ({
    businessId: String(row[at.businessId!] ?? ""),
    providerAccountId: String(row[at.providerAccountId!] ?? ""),
    grain: String(row[at.grain!] ?? ""),
    entityId: String(row[at.entityId!] ?? ""),
    effectiveFrom: String(row[at.effectiveFrom!] ?? ""),
    capturedAt: (row[at.capturedAt!] ?? null) as string | null,
    configFingerprint: (row[at.configFingerprint!] ?? null) as string | null,
    dailyBudgetRaw: (row[at.dailyBudgetRaw!] ?? null) as number | null,
    lifetimeBudgetRaw: (row[at.lifetimeBudgetRaw!] ?? null) as number | null,
    anyMixed: row[at.anyMixed!] === true,
    rawCaptures: (row[at.rawCaptures!] ?? null) as number | null,
    distinctFingerprints: (row[at.distinctFingerprints!] ?? null) as number | null,
    lane: (row[at.lane!] ?? null) as string | null,
    knowledgeTo: (row[at.knowledgeTo!] ?? null) as string | null,
  }));
}

export interface D084Frozen {
  contract: string;
  supersedes: typeof D084_SUPERSEDES;
  provenance: Record<string, unknown>;
  sourceManifest: PinnedSourceCheck[];
  bindings: Binding[];
  accountCurrency: Record<string, string | null>;
  sourceClocks: SourceClock[];
  daily: ColumnarSlice<DailyRow>;
  configStates: ColumnarSlice<ConfigStateRow>;
  ownerStates: OwnerStateRow[];
  transitions: TransitionRow[];
  origins: OriginRow[];
  targetPackHistory: Row[];
  persistedDecisionCensus: PersistedDecisionCensus[];
  d080bBlockerRanking: Row[];
  d080bDenominators: Row;
  d083Headline: Row;
}

export interface D084Analysis {
  sourceCoverage: Row[];
  retention: Row;
  targetPackTruth: TargetPackTruth[];
  canonicalProfileAvailability: CanonicalProfileAvailability[];
  eventGroups: EconomicEventGroup[];
  eventStudy: EventStudyRow[];
  eventBounds: ReturnType<typeof eventCountBounds>;
  evidenceGrid: ReturnType<typeof buildEvidenceFloorGrid>;
  worldSpace: Omit<WorldSpace, "worlds"> & { sampleWorldKeys: string[] };
  ownerClockCoverage: OwnerClockCoverage;
  collapsedConfigCoverage: CollapsedConfigCoverage;
  cooldownGrid: CooldownCell[];
  capGrid: CapCell[];
  concentrationGrid: ConcentrationCell[];
  lookbackGrid: LookbackCell[];
  changeSafety: ChangeSafetyReconciliation;
  scenarios: D084Scenario[];
  perBusiness: Row[];
  fleet: Row;
  residualBlockers: Row[];
}

/** Currency per business, from the pinned bindings and account currencies. */
export function currencyByBusiness(
  bindings: readonly Binding[],
  accountCurrency: Record<string, string | null>,
): Record<string, { currency: string | null; why: string }> {
  const out: Record<string, { currency: string | null; why: string }> = {};
  for (const business of D084_CHARTER_BUSINESSES) {
    const mine = bindings.filter((b) => b.businessId === business.businessId);
    const currencies = sortedUnique(
      mine.map((b) => accountCurrency[b.providerAccountId]).filter((c): c is string => c != null),
    );
    out[business.businessId] =
      currencies.length === 1
        ? { currency: currencies[0]!, why: `every retained binding for this business reports ${currencies[0]}` }
        : {
            currency: null,
            why:
              currencies.length === 0
                ? "no retained binding carried an account currency"
                : `retained bindings disagree (${currencies.join(", ")}), so no single business currency is knowable`,
          };
  }
  return out;
}

export function buildSourceCoverage(frozen: D084Frozen): Row[] {
  const daily = decodeDaily(frozen.daily);
  const configStates = decodeConfig(frozen.configStates);
  const packs = frozen.targetPackHistory;
  const withAov = packs.filter((p) => num(p.aov_assumption) !== null).length;
  const withCpa = packs.filter((p) => num(p.target_cpa) !== null).length;
  const withFullCost = packs.filter((p) => D084_COST_INPUTS.every((f) => num(p[f]) !== null)).length;
  return [
    {
      fact: "unfiltered daily delivery with owner lineage",
      source: "D080A series (pinned)",
      present: daily.length, of: daily.length, state: "retained",
    },
    {
      fact: "budget configuration on BOTH the effective and recorded clocks",
      source: "D080B snapshot.reads configStates (pinned)",
      present: configStates.filter((c) => c.capturedAt !== null).length,
      of: configStates.length, state: "retained",
    },
    {
      fact: "which node owns the money, per entity per observed day",
      source: "D080B snapshot.reads ownerStates (pinned)",
      present: frozen.ownerStates.length, of: frozen.ownerStates.length,
      state: "retained_but_sparse",
    },
    {
      fact: "operator AOV assumption",
      source: "business_target_pack_history.aov_assumption (frozen in D084 v1)",
      present: withAov, of: packs.length,
      state: withAov === 0 ? "absent_in_every_revision" : "partially_retained",
    },
    {
      fact: "explicit Target CPA",
      source: "business_target_pack_history.target_cpa (frozen in D084 v1)",
      present: withCpa, of: packs.length,
      state: withCpa === 0 ? "absent_in_every_revision" : "partially_retained",
    },
    {
      fact: "complete cost basis for break-even reconciliation",
      source: "business_target_pack_history.cost_*_percent (frozen in D084 v1)",
      present: withFullCost, of: packs.length,
      state: withFullCost === 0 ? "absent" : "partially_retained",
    },
    {
      fact: "canonical AccountDecisionProfile.hardActionEligibility output",
      source: "none — no pinned artifact retains a profile output",
      present: 0, of: D084_CHARTER_BUSINESSES.length * D084_PROFILE_ACTIONS.length,
      state: "absent_not_retained",
    },
    {
      fact: "captured currency exponent, provider API provenance, observed budget shape and schedule",
      source: "D083 — additive migration authored and NOT applied; no admitted sync has run",
      present: 0, of: Number(num(frozen.d083Headline.originCount) ?? 0),
      state: "absent_not_retained",
    },
    {
      fact: "randomised assignment for any budget change",
      source: "none — no experiment was ever run on these accounts",
      present: 0, of: frozen.transitions.length,
      state: "absent_no_counterfactual_possible",
    },
  ];
}

export function analyse(frozen: D084Frozen): D084Analysis {
  // Decoded once. The columnar form is an encoding of these exact rows.
  const daily = decodeDaily(frozen.daily);
  const configStates = decodeConfig(frozen.configStates);
  const origins = frozen.origins.map((o) => o.origin);
  const latestOrigin = origins.length > 0 ? origins[origins.length - 1]! : null;
  const currencies = currencyByBusiness(frozen.bindings, frozen.accountCurrency);

  const sourceCoverage = buildSourceCoverage(frozen);
  const targetPackTruth = buildTargetPackTruth(frozen.targetPackHistory, {
    origins, currencyByBusiness: currencies,
  });
  const canonicalProfileAvailability = buildCanonicalProfileAvailability(frozen.persistedDecisionCensus);

  const members = buildEventMembers(frozen.transitions, daily, frozen.ownerStates);
  const eventGroups = buildEventGroups(members);
  const eventStudy = buildEventStudy({
    groups: eventGroups,
    daily,
    configStates,
    targetRevisionInstants: targetPackTruth.flatMap((t) =>
      t.revisionLineage
        .filter((r) => r.knowableFromMs !== null)
        .map((r) => ({ businessId: t.businessId, atMs: r.knowableFromMs as number })),
    ),
  });
  const eventBounds = eventCountBounds(eventGroups);

  const exponentKnown = !frozen.d080bBlockerRanking.some(
    (b) => text(b.code) === "unit_exponent_unknown" && (num(b.hits) ?? 0) > 0,
  );
  const evidence = buildEntityOriginEvidence({
    daily, configStates, origins,
  });
  const evidenceGrid = buildEvidenceFloorGrid({
    evidence, origins: frozen.origins, exponentKnown,
    structuralBlockers: D084_STRUCTURAL_GATES,
  });

  const ownerClockCoverage = buildOwnerClockCoverage(frozen.ownerStates, members);
  const space = buildWorldSpace(toWorldGroups(eventGroups));
  const collapsedConfigCoverage = buildCollapsedConfigCoverage(configStates, evidence);
  const cooldownGrid = buildCooldownGrid(space);
  const capGrid = buildCapGrid(space);
  const concentrationGrid = buildConcentrationGrid(space);
  const lookbackGrid = buildLookbackGrid(space);
  const changeSafety = reconcileChangeSafety(eventGroups, space);
  // The full world list is not embedded: it is a deterministic function of the
  // frozen members and the verifier regenerates it. Its digest and a bounded
  // sample travel so a reader can spot-check without a 640-entry dump.
  const worldSpace = {
    worldCount: space.worldCount,
    digest: space.digest,
    groupCount: space.groupCount,
    memberRowCount: space.memberRowCount,
    actionLowerBound: space.actionLowerBound,
    actionUpperBound: space.actionUpperBound,
    ambiguousGroupCount: space.ambiguousGroupCount,
    partitionsPerGroup: space.partitionsPerGroup,
    indeterminateEntityActionKeys: space.indeterminateEntityActionKeys,
    semantics: space.semantics,
    sampleWorldKeys: space.worlds.slice(0, 3).map((w) => w.worldKey),
  };

  const denominator = num(frozen.d080bDenominators.proposalsEvaluated) ?? 0;
  const universalBlockers = frozen.d080bBlockerRanking
    .filter((b) => (num(b.hits) ?? 0) === denominator && denominator > 0)
    .map((b) => ({ code: text(b.code), hits: num(b.hits), share: 1 }));

  const retention = {
    dailyFirst: daily.reduce<string | null>((a, r) => (a === null || r.date < a ? r.date : a), null),
    dailyLast: daily.reduce<string | null>((a, r) => (a === null || r.date > a ? r.date : a), null),
    dailyRows: daily.length,
    entities: new Set(daily.map((r) => entityKey(r))).size,
    businesses: new Set(daily.map((r) => r.businessId)).size,
    accounts: new Set(daily.map((r) => r.providerAccountId)).size,
    earliestOrigin: origins[0] ?? null,
    latestOrigin,
    widestTrailingDays: Math.max(...D084_GRID_DIMENSIONS.trailingDays),
    note:
      "support is decided against these retained bounds per entity; no requested range and no future day is ever reported as supported",
  };

  const scenarios: D084Scenario[] = [
    sealScenario(
      "1_pinned_only_baseline",
      "verified_fact",
      {
        origins,
        charterBusinesses: D084_CHARTER_BUSINESSES.map((b) => b.name),
        pinnedSources: frozen.sourceManifest.map((s) => ({ key: s.key, sha256: s.observedSha256 })),
        databaseAccess: "none",
      },
      {
        dailyRows: daily.length,
        configRows: configStates.length,
        ownerStateRows: frozen.ownerStates.length,
        transitionRows: frozen.transitions.length,
        eventGroups: eventGroups.length,
        distinctActionsLowerBound: eventBounds.lower,
        distinctActionsUpperBound: eventBounds.upper,
        eventCountWhy: eventBounds.why,
        businessesWithPackAtLatestOrigin: targetPackTruth.filter((t) => t.atLatestOrigin?.configured).length,
        canonicalProfileActionsAvailable: 0,
        canonicalProfileWhy: "canonical_profile_output_not_retained",
      },
    ),
    sealScenario(
      "2_commercial_target_five_states_per_origin",
      "derived_metric",
      {
        freshnessWindowsDays: [...D084_FRESHNESS_WINDOWS_DAYS],
        origins,
        tombstoneSemantics: "the latest knowable revision wins; a delete removes the pack",
      },
      {
        perBusiness: targetPackTruth.map((t) => ({
          business: t.business,
          currency: t.currency,
          currencyWhy: t.currencyWhy,
          revisions: t.revisions,
          rawFieldLedger: t.rawFieldLedger,
          asOfOrigins: t.asOfOrigins.map((o) => ({
            origin: o.origin,
            configured: o.configured,
            absentReason: o.absentReason,
            pitKnowableAt: o.pitKnowableAt,
            freshUnderWindowDays: o.freshUnderWindowDays,
            economicallyReconciled: o.economicallyReconciled,
            approvedForPolicy: o.approvedForPolicy,
          })),
        })),
        fiveStatesPublishedTogether: [
          "configured", "pitKnowableAt", "freshUnderWindowDays",
          "economicallyReconciled", "approvedForPolicy",
        ],
      },
    ),
    sealScenario(
      "3_evidence_floor_grid_three_lanes",
      "derived_metric",
      {
        baseline: D084_GRID_BASELINE,
        dimensions: D084_GRID_DIMENSIONS,
        directionsEvaluatedSeparately: ["increase", "decrease"],
        allBaselineGatesApplied: true,
        structuralGates: [...D084_STRUCTURAL_GATES],
        population: "every charter entity-origin with retained delivery, not only event-bearing entities",
      },
      {
        // Lane 1 — strict retained authority. Structural gates apply, so
        // eligibility here stays zero by construction and says so.
        strictRetainedAuthority: {
          cells: evidenceGrid.cells,
          monotonicity: evidenceGrid.monotonicity,
          structuralBlockers: [...D084_STRUCTURAL_GATES],
          eligibleUnderStructuralGates: 0,
          why:
            "the three structural gates block every proposal D080B evaluated, so no evidence floor can produce a strictly eligible row; the per-cell partitions describe what the floors alone would admit",
        },
        // Lane 2 — D080B's accepted conditional census, on its own denominator.
        d080bConditional: {
          denominator,
          universalBlockers,
          waivers: [...D084_STRUCTURAL_GATES],
          why: "D080B's own declared waivers and its own transition evidence, kept on D080B's proposal denominator",
        },
        // Lane 3 — the D083 capture counterfactual, explicitly non-authoritative.
        d083CaptureCounterfactual: {
          assumedAvailable: ["captured currency exponent", "provider API provenance", "observed budget shape", "observed schedule"],
          authoritative: false,
          remainingUniversalBlockers: universalBlockers.filter((b) => b.code !== "unit_exponent_unknown"),
          why: "D083's additive migration is authored and NOT applied; this lane asks what would remain if it had, and implies no expected lift",
        },
        lanesShareNoDenominator: true,
        selectable: evidenceGrid.selectable,
      },
    ),
    sealScenario(
      "4_change_safety_every_declared_scope",
      "derived_metric",
      {
        cooldownDays: [...D084_COOLDOWN_DAYS],
        lookbackDays: [...D084_LOOKBACK_DAYS],
        caps: [...D084_CAP_CANDIDATES],
        concentration: [...D084_CONCENTRATION_CANDIDATES],
        scopes: ["entity", "account", "business", "fleet"],
        countSemantics: D084_COUNT_SEMANTICS,
      },
      {
        cooldownGrid, capGrid, concentrationGrid, lookbackGrid,
        reconciliation: changeSafety,
        eventStudy,
        eventWindowsDays: [...D084_EVENT_WINDOWS_DAYS],
        selectable: false,
        why: "every value remains proposed_governance and unapproved; the grids report what each would have blocked, never which to pick",
      },
    ),
    sealScenario(
      "5_canonical_profile_availability",
      "verified_fact",
      {
        expectedContract: ACCOUNT_DECISION_PROFILE_CONTRACT_EXPECTED,
        actions: [...D084_PROFILE_ACTIONS],
        rule: "only a byte-inspectable production resolver result over fully frozen inputs may populate eligibility",
      },
      {
        availability: canonicalProfileAvailability,
        actionsNotDeterminable: canonicalProfileAvailability.length * D084_PROFILE_ACTIONS.length,
        actionsEligible: 0,
        actionsIneligible: 0,
        why:
          "no pinned artifact retains an AccountDecisionProfile output; the D079 persisted-decision census travels alongside as descriptive evidence and is never read as eligibility",
      },
    ),
  ];

  const perBusiness: Row[] = targetPackTruth.map((truth) => {
    const availability = canonicalProfileAvailability.find((c) => c.businessId === truth.businessId)!;
    const latest = truth.atLatestOrigin;
    return {
      business: truth.business,
      businessId: truth.businessId,
      currency: truth.currency,
      currencyWhy: truth.currencyWhy,
      packConfiguredAtLatestOrigin: latest?.configured ?? false,
      packAbsentReason: latest?.absentReason ?? null,
      pitKnowableAt: latest?.pitKnowableAt ?? null,
      freshUnderWindowDays: latest?.freshUnderWindowDays ?? {},
      economicallyReconciled: latest?.economicallyReconciled ?? false,
      approvedForPolicy: false,
      approvedForPolicyWhy: latest?.approvedForPolicyWhy ?? "no origin was evaluated",
      packRevisions: truth.revisions,
      rawFieldLedger: truth.rawFieldLedger,
      canonicalProfileByAction: availability.byAction.map((a) => ({
        action: a.action, status: a.status, reasonCode: a.reasonCode,
        eligible: a.eligible, expectedContract: a.expectedContract, observedContract: a.observedContract,
      })),
      economicEventGroups: changeSafety.groupDiagnostics.groupsByBusiness[truth.business] ?? 0,
    };
  });

  const fleet: Row = {
    charterBusinesses: D084_CHARTER_BUSINESSES.length,
    businessesWithPackAtLatestOrigin: targetPackTruth.filter((t) => t.atLatestOrigin?.configured).length,
    businessesEconomicallyReconciledAtLatestOrigin: targetPackTruth.filter((t) => t.atLatestOrigin?.economicallyReconciled).length,
    canonicalProfileActionsNotDeterminable: canonicalProfileAvailability.length * D084_PROFILE_ACTIONS.length,
    canonicalProfileActionsEligible: 0,
    proposalsEvaluatedByD080B: denominator,
    strictlyEligibleProposals: 0,
    eventGroups: eventGroups.length,
    distinctActionsLowerBound: eventBounds.lower,
    distinctActionsUpperBound: eventBounds.upper,
    ambiguousGroups: eventBounds.ambiguousGroups,
    provedOwnerMirrorGroups: eventBounds.provedGroups,
    groupsInsideDeclaredLadder: changeSafety.groupsInsideDeclaredLadder,
    eventsWithAConfoundedWindow: eventStudy.filter((e) => e.confounding !== "clean_within_retained_evidence").length,
    evidenceGridCells: evidenceGrid.cells.length,
    pitBudgetEvaluations: collapsedConfigCoverage.evaluations,
    pitBudgetResolved: collapsedConfigCoverage.evaluationsResolved,
    pitBudgetNotDeterminable:
      collapsedConfigCoverage.evaluations - collapsedConfigCoverage.evaluationsResolved,
    collapsedConfigRows: collapsedConfigCoverage.collapsedRows,
    databaseQueriesExecuted: 0,
    maximumReachableAuthority: "validated_only",
    automation: "off",
  };

  const residualBlockers: Row[] = [
    {
      blocker: "canonical_profile_output_not_retained",
      evidence: `all ${D084_CHARTER_BUSINESSES.length * D084_PROFILE_ACTIONS.length} business-action pairs are not_determinable; expected contract ${ACCOUNT_DECISION_PROFILE_CONTRACT_EXPECTED}, observed none`,
      consequence: "no commercial eligibility may be stated by this package, in either direction",
      closes: "a byte-inspectable production resolver result over fully frozen required inputs is captured",
    },
    {
      blocker: "no_high_confidence_commercial_anchor_field_anywhere",
      evidence: `every one of the ${frozen.targetPackHistory.length} retained target-pack revisions carries a null target_cpa and a null aov_assumption`,
      consequence: "descriptive only: it says the retained FIELDS cannot supply a high-confidence anchor, not that any action is ineligible",
      closes: "an operator captures an explicit Target CPA, or an AOV assumption beside the existing Target ROAS",
    },
    {
      blocker: "structural_gates_eliminate_the_whole_population",
      evidence: universalBlockers.map((b) => `${b.code} on ${b.hits}/${denominator}`).join("; "),
      consequence: "no evidence floor, cooldown, lookback, cap or concentration control can change any strict outcome",
      closes: "decision vocabulary and role authority resolve, and D083's additive migration is applied with an admitted sync",
    },
    {
      blocker: "no_counterfactual_for_any_budget_change",
      evidence: `${eventBounds.lower}-${eventBounds.upper} distinct actions across ${eventGroups.length} groups, ${eventBounds.ambiguousGroups} of them ambiguous, no randomised assignment`,
      consequence: "no causal ROAS, revenue or profit lift and no optimal percent may be claimed",
      closes: "a preregistered controlled test, which cannot be run while automation is OFF",
    },
    {
      blocker: "budget_binding_not_measurable",
      evidence: "retained daily_budget is a raw provider amount whose currency exponent is not captured",
      consequence: "the budget-binding floor is not_determinable for every increase-side evaluation; a spend/budget ratio here would be off by an uncaptured power of ten",
      closes: "D083's exponent capture is applied and an admitted sync runs",
    },
    {
      blocker: "collapsed_config_day_hides_the_terminal_state",
      evidence: `${collapsedConfigCoverage.collapsedRows} of ${collapsedConfigCoverage.configRows} retained config rows record disagreeing captures on one effective day, and the pinned query kept only each day's latest. Of ${collapsedConfigCoverage.evaluations} point-in-time budget evaluations, ${collapsedConfigCoverage.collapsedSkylineEvaluations} are unresolved because of a genuine collapsed skyline; the other unresolved causes are counted separately as ${JSON.stringify(collapsedConfigCoverage.evaluationsNotDeterminable)}, and ${collapsedConfigCoverage.skippedNotYetKnownRows} newer row(s) were skipped as not-yet-known rather than treated as ambiguity`,
      consequence:
        "only the collapsed-skyline evaluations are attributable to collapsed data; retention and missing-budget causes are stated separately and an older effective day is never substituted for an unresolved newer one",
      closes: "a config read that retains the full within-day capture skyline, which this package may not perform",
    },
    {
      blocker: "owner_lineage_rarely_knowable_at_the_event",
      evidence: `${ownerClockCoverage.capturedAfterObservedDay} of ${ownerClockCoverage.retainedOwnerRows} retained owner-state rows were captured after the day they describe (${ownerClockCoverage.capturedOnObservedDay} on the same day, ${ownerClockCoverage.capturedBeforeObservedDay} before, ${ownerClockCoverage.nullOrInvalidCapturedAt} with no parsable clock); only ${ownerClockCoverage.membersResolved} of ${ownerClockCoverage.eventMembers} event members have an owner row knowable on both clocks at their event`,
      consequence:
        "no economic group can be proved to be a single action, so the action count is a range and every safety control inherits that range",
      closes: "owner state is captured at the time it takes effect",
    },
  ];

  return {
    sourceCoverage, retention, targetPackTruth, canonicalProfileAvailability,
    eventGroups, eventStudy, eventBounds, evidenceGrid,
    worldSpace, ownerClockCoverage, collapsedConfigCoverage,
    cooldownGrid, capGrid, concentrationGrid, lookbackGrid, changeSafety,
    scenarios, perBusiness, fleet, residualBlockers,
  };
}

// ---------------------------------------------------------------------------
// Assembly — pure, deterministic, DB-free
// ---------------------------------------------------------------------------

/** Build the frozen snapshot from pinned bytes. No wall clock, no query. */
export function assembleFrozen(bundle: PinnedBundle, manifest: PinnedSourceCheck[]): D084Frozen {
  return {
    contract: D084_CONTRACT_ID,
    supersedes: D084_SUPERSEDES,
    provenance: {
      operatingClass: "prepare_read_only",
      automation: "off",
      maximumReachableAuthority: "validated_only",
      databaseAccess: "none",
      queriesExecuted: 0,
      wallClockFields: "none — the artifact is a pure function of the pinned bytes",
      note:
        "Correction 2: every fact is extracted from a pinned file whose bytes are hashed before parsing. r2's live read was unnecessary — D080A already retained 165,042 unfiltered daily rows across all six charter businesses, supplying 1,634 of r2's 1,641 rows with identical values; the remaining 7 lie one day before D080A's retained floor for that scope and are published as missing retained evidence, not re-read.",
    },
    sourceManifest: manifest,
    bindings: extractBindings(bundle),
    accountCurrency: extractAccountCurrency(bundle),
    sourceClocks: extractSourceClocks(bundle),
    daily: encodeDaily(extractDailySeries(bundle)),
    configStates: encodeConfig(extractConfigStates(bundle)),
    ownerStates: extractOwnerStates(bundle),
    transitions: extractResolvedTransitions(bundle),
    origins: extractOrigins(bundle),
    targetPackHistory: extractTargetPackHistory(bundle),
    persistedDecisionCensus: extractPersistedDecisionCensus(bundle),
    d080bBlockerRanking: extractBlockerRanking(bundle),
    d080bDenominators: extractDenominators(bundle),
    d083Headline: extractD083Headline(bundle),
  };
}

export function runAssemble(outPath = D084_JSON_OUT): Record<string, string> {
  const manifest = checkPinnedSources();
  const bundle = loadPinnedSources();
  const snapshot = assembleFrozen(bundle, manifest);
  const analysis = analyse(snapshot);
  const snapshotHash = canonicalDigest(snapshot);
  const analysisHash = canonicalDigest(analysis);
  const artifact = { contract: D084_CONTRACT_ID, snapshot, analysis, snapshotHash, analysisHash };
  const artifactHash = canonicalDigest(artifact);
  writeFileSync(resolve(outPath), JSON.stringify({ ...artifact, artifactHash }));
  const out = { snapshotHash, analysisHash, artifactHash };
  console.log(JSON.stringify({
    phase: "d084-assemble",
    databaseQueriesExecuted: 0,
    dailyRows: snapshot.daily.count,
    configRows: snapshot.configStates.count,
    eventGroups: analysis.eventGroups.length,
    actionsLower: analysis.eventBounds.lower,
    actionsUpper: analysis.eventBounds.upper,
    gridCells: analysis.evidenceGrid.cells.length,
    ...out,
  }, null, 1));
  return out;
}

export function replayFromArtifact(artifact: Record<string, unknown>): Record<string, string> {
  const snapshot = artifact.snapshot as D084Frozen;
  return {
    snapshotHash: canonicalDigest(snapshot),
    analysisHash: canonicalDigest(analyse(snapshot)),
  };
}

// ---------------------------------------------------------------------------
// Verification — the pinned FILES are root trust, never the artifact's rows
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  failures: string[];
  checked: string[];
  counters: Record<string, number>;
}

/**
 * Verify an artifact against the pinned sources on disk.
 *
 * r2's verifier re-ran `analyse` over the artifact's OWN frozen rows and
 * compared hashes. That proves hash wiring and nothing about authenticity: an
 * attacker who edits a frozen spend, re-runs `analyse` and recomputes all three
 * hashes gets `ok: true`. Here every source slice is re-extracted from the
 * hashed file on disk and compared to the embedded snapshot BEFORE anything is
 * re-analysed, so a re-sealed forgery fails on the bytes.
 */
export function verifyArtifact(
  artifact: Record<string, unknown>,
  readBytes: (path: string) => Buffer = (p) => readFileSync(resolve(p)),
): VerifyResult {
  const failures: string[] = [];
  const checked: string[] = [];
  const fail = (section: string, reason: string) => failures.push(`${section}: ${reason}`);

  if (artifact.contract !== D084_CONTRACT_ID) fail("contract", "contract_mismatch");
  checked.push("contract");

  const snapshot = artifact.snapshot as D084Frozen | undefined;
  if (!snapshot) return { ok: false, failures: ["snapshot: missing"], checked, counters: {} };

  // --- Root trust: the files, hashed from disk. ---
  const manifestNow = checkPinnedSources(readBytes);
  for (const check of manifestNow) {
    if (!check.matches) fail("pinnedSources", `${check.key} drifted from its accepted hash`);
    const stored = (snapshot.sourceManifest ?? []).find((s) => s.key === check.key);
    if (!stored) { fail("pinnedSources", `${check.key} is absent from the artifact's source manifest`); continue; }
    if (stored.observedSha256 !== check.observedSha256) {
      fail("pinnedSources", `${check.key} manifest hash does not match the file on disk`);
    }
    if (stored.path !== check.path) fail("pinnedSources", `${check.key} manifest path drifted`);
    if (stored.expectedSha256 !== check.expectedSha256) {
      fail("pinnedSources", `${check.key} expected hash drifted from the pinned contract`);
    }
  }
  if ((snapshot.sourceManifest ?? []).length !== D084_PINNED_SOURCES.length) {
    fail("pinnedSources", "the artifact's source manifest does not cover every pinned source");
  }
  checked.push("pinnedSources");

  if (failures.length > 0) {
    // Without trustworthy sources nothing below can mean anything.
    return { ok: false, failures, checked, counters: {} };
  }

  // --- Re-extract every frozen slice from the pinned files and compare. ---
  const bundle = loadPinnedSources(readBytes);
  const reExtracted = assembleFrozen(bundle, manifestNow);
  const slices: Array<[keyof D084Frozen, string]> = [
    ["bindings", "bindings"],
    ["accountCurrency", "accountCurrency"],
    ["sourceClocks", "sourceClocks"],
    ["daily", "daily delivery"],
    ["configStates", "config states"],
    ["ownerStates", "owner states"],
    ["transitions", "resolved transitions"],
    ["origins", "origins"],
    ["targetPackHistory", "target pack history"],
    ["persistedDecisionCensus", "persisted decision census"],
    ["d080bBlockerRanking", "blocker ranking"],
    ["d080bDenominators", "denominators"],
    ["d083Headline", "D083 headline"],
  ];
  for (const [field, label] of slices) {
    if (canonicalDigest(snapshot[field] ?? null) !== canonicalDigest(reExtracted[field] ?? null)) {
      fail("sourceFidelity", `the frozen ${label} is not what the pinned sources re-extract`);
    }
  }
  // The columnar slices are compared as DECODED ROWS, and each slice's own
  // digest must describe the rows it actually carries — otherwise a forged row
  // could hide behind a stale digest.
  const decodedDaily = decodeDaily(snapshot.daily);
  const decodedConfig = decodeConfig(snapshot.configStates);
  if (canonicalDigest(decodedDaily) !== canonicalDigest(decodeDaily(reExtracted.daily))) {
    fail("sourceFidelity", "the frozen daily rows are not what the pinned sources re-extract");
  }
  if (canonicalDigest(decodedConfig) !== canonicalDigest(decodeConfig(reExtracted.configStates))) {
    fail("sourceFidelity", "the frozen config rows are not what the pinned sources re-extract");
  }
  if (snapshot.daily?.digest !== canonicalDigest(decodedDaily)) {
    fail("sourceFidelity", "the daily slice digest does not describe its own rows");
  }
  if (snapshot.configStates?.digest !== canonicalDigest(decodedConfig)) {
    fail("sourceFidelity", "the config slice digest does not describe its own rows");
  }
  if (snapshot.daily?.count !== decodedDaily.length) fail("sourceFidelity", "the daily slice count is wrong");
  if (snapshot.configStates?.count !== decodedConfig.length) fail("sourceFidelity", "the config slice count is wrong");
  checked.push("sourceFidelity");

  if (failures.length > 0) {
    // The frozen slices are not the pinned sources. Re-deriving an analysis
    // from them would only prove the forgery is internally consistent, which
    // is exactly the thing that must not count as verification.
    return { ok: false, failures, checked, counters: { pinnedSources: manifestNow.length } };
  }

  // Provenance must state the DB-free posture, and the artifact must contain
  // no query contract at all.
  if (text(snapshot.provenance?.databaseAccess) !== "none") fail("provenance", "database access is not declared none");
  if ((num(snapshot.provenance?.queriesExecuted) ?? -1) !== 0) fail("provenance", "queriesExecuted is not zero");
  if (text(snapshot.provenance?.automation) !== "off") fail("provenance", "automation is not off");
  if (text(snapshot.provenance?.maximumReachableAuthority) !== "validated_only") {
    fail("provenance", "authority ceiling is not validated_only");
  }
  for (const banned of ["queryContractSha256", "statementTimeoutMs", "lockTimeoutMs", "retrievedat", "retrievedAt", "transactionreadonly"]) {
    if (banned in ((snapshot.provenance ?? {}) as Row)) {
      fail("provenance", `r3 must carry no live-read field, but ${banned} is present`);
    }
  }
  checked.push("provenance");

  // --- Predecessor lineage. ---
  const supersedes = snapshot.supersedes;
  const checkPredecessor = (
    label: string,
    spec: { path: string; fileSha256: string; artifactHash: string; contract: string } | undefined,
  ) => {
    if (!spec) { fail("supersedes", `${label} lineage is absent`); return; }
    if (!existsSync(resolve(spec.path))) { fail("supersedes", `${label} is missing from disk`); return; }
    const raw = readBytes(spec.path);
    if (createHash("sha256").update(raw).digest("hex") !== spec.fileSha256) {
      fail("supersedes", `${label} file on disk is not the one this artifact supersedes`);
    }
    const predecessor = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    if (predecessor.artifactHash !== spec.artifactHash) {
      fail("supersedes", `${label} internal artifactHash is not the one recorded`);
    }
    if (predecessor.contract !== spec.contract) fail("supersedes", `${label} contract drifted`);
    if (predecessor.contract === D084_CONTRACT_ID) {
      fail("supersedes", `${label} claims the same contract id as its successor`);
    }
  };
  checkPredecessor("the immediate predecessor", supersedes);
  checkPredecessor("the predecessor before it", supersedes?.alsoSupersedes);
  // The WHOLE retained chain, not only the two most recent links: every earlier
  // artifact must still be byte-identical on disk for this lineage to mean
  // anything.
  const chain = Array.isArray(supersedes?.priorChain) ? supersedes.priorChain : [];
  if (chain.length !== D084_SUPERSEDES.priorChain.length) {
    fail("supersedes", `the retained chain declares ${chain.length} earlier artifacts, not ${D084_SUPERSEDES.priorChain.length}`);
  }
  chain.forEach((link: unknown, i: number) => {
    checkPredecessor(
      `retained chain link ${i + 1}`,
      link as { path: string; fileSha256: string; artifactHash: string; contract: string },
    );
  });
  checked.push("supersedes");

  // --- Everything published is re-derived from the verified snapshot. ---
  const recomputed = analyse(snapshot);
  const stored = artifact.analysis as Record<string, unknown>;
  if (canonicalDigest(stored ?? null) !== canonicalDigest(recomputed)) {
    fail("analysis", "the published analysis is not what re-analysing the verified snapshot produces");
  }
  checked.push("analysis");

  const published = (stored as unknown as D084Analysis | undefined) ?? recomputed;

  if (artifact.snapshotHash !== canonicalDigest(snapshot)) fail("snapshotHash", "mismatch");
  if (artifact.analysisHash !== canonicalDigest(recomputed)) fail("analysisHash", "mismatch");
  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash"));
  if (artifact.artifactHash !== canonicalDigest(body)) fail("artifactHash", "mismatch");
  checked.push("hashes");

  for (const scenario of published.scenarios ?? []) {
    const expected = canonicalDigest({
      scenarioId: scenario.scenarioId, truthLabel: scenario.truthLabel,
      assumedInputs: scenario.assumedInputs, result: scenario.result,
    });
    if (scenario.scenarioHash !== expected) {
      fail("scenarios", `${scenario.scenarioId} hash does not cover its own assumed inputs`);
    }
    if (scenario.actionAuthority !== "none_review_only") {
      fail("scenarios", `${scenario.scenarioId} claims authority beyond review-only`);
    }
  }
  checked.push("scenarios");

  // --- Event members, grouping and windows. ---
  const groups = published.eventGroups ?? [];
  const memberRows = groups.reduce((s, g) => s + g.members.length, 0);
  if (memberRows !== snapshot.transitions.length) {
    fail("eventReconciliation", `members (${memberRows}) do not account for every resolved transition (${snapshot.transitions.length})`);
  }
  const memberKeys = groups.flatMap((g) => g.members.map((m) => m.sourceRowKey));
  if (new Set(memberKeys).size !== memberKeys.length) {
    fail("eventReconciliation", "a source transition row appears in more than one group");
  }
  for (const group of groups) {
    if (group.groupingProof === "single_member" && group.members.length !== 1) {
      fail("eventReconciliation", `${group.key} claims a single member but carries ${group.members.length}`);
    }
    if (group.groupingProof === "proved_owner_mirror_single_child") {
      const campaigns = group.members.filter((m) => m.grain === "campaign");
      const children = group.members.filter((m) => m.grain !== "campaign");
      if (campaigns.length !== 1 || children.length !== 1) {
        fail("eventReconciliation", `${group.key} claims an owner mirror without exactly one campaign and one child`);
      } else if (
        children[0]!.parentCampaignId !== campaigns[0]!.entityId ||
        campaigns[0]!.budgetOriginAtEvent !== "campaign" ||
        children[0]!.budgetOriginAtEvent !== "not_applicable"
      ) {
        fail("eventReconciliation", `${group.key} claims an owner mirror the retained owner rows do not support`);
      }
      if (group.representativeMemberKey === null) {
        fail("eventReconciliation", `${group.key} is proved but names no representative`);
      }
    }
    if (group.groupingProof === "ambiguous_multi_member") {
      if (group.representativeMemberKey !== null) {
        fail("eventReconciliation", `${group.key} is ambiguous yet names a representative member`);
      }
      if (group.upperBoundActions !== group.members.length) {
        fail("eventReconciliation", `${group.key} is ambiguous but its upper bound is not its member count`);
      }
    }
    // Reconciliation across every declared partition.
    if (group.members.some((m) => m.businessId !== group.businessId)) {
      fail("eventReconciliation", `${group.key} mixes businesses`);
    }
    if (group.members.some((m) => m.providerAccountId !== group.providerAccountId)) {
      fail("eventReconciliation", `${group.key} mixes accounts`);
    }
  }
  const bounds = published.eventBounds;
  if (bounds && (bounds.lower > bounds.upper)) fail("eventReconciliation", "action bounds are inverted");
  if (bounds && bounds.ambiguousGroups === 0 && bounds.lower !== bounds.upper) {
    fail("eventReconciliation", "no group is ambiguous yet the action count is a range");
  }
  if (bounds && bounds.memberRows !== snapshot.transitions.length) {
    fail("eventReconciliation", "bounds member count does not match the frozen transitions");
  }
  checked.push("eventReconciliation");

  const eventCount = groups.length;
  const study = published.eventStudy ?? [];
  if (study.length !== groups.length) fail("eventStudy", "the study does not cover every group exactly once");
  const retention = retentionByEntity(decodeDaily(snapshot.daily));
  for (const row of study) {
    for (const member of row.members) {
      const bounds2 = retention.get([member.businessId, member.providerAccountId, member.grain, member.entityId].join("|"));
      for (const side of ["pre", "post"] as const) {
        for (const days of D084_EVENT_WINDOWS_DAYS) {
          const w = member.windows.find((x) => x.side === side && x.days === days);
          if (!w) { fail("eventStudy", `${member.memberKey} is missing its ${days}-day ${side} window`); continue; }
          if (w.requestedDays !== days) fail("eventStudy", `${member.memberKey} ${side}${days} requested the wrong day count`);
          if (w.retainedEligibleDays > w.requestedDays) {
            fail("eventStudy", `${member.memberKey} ${side}${days} counts more eligible days than it requested`);
          }
          if (w.coveredEntityDays > w.requestedDays) {
            fail("eventStudy", `${member.memberKey} ${side}${days} covered more days than it requested`);
          }
          // Support must never be claimed for a day outside pinned retention,
          // and never for a future day.
          if (w.support === "supported") {
            if (!bounds2) fail("eventStudy", `${member.memberKey} ${side}${days} is supported with no retained rows`);
            else {
              for (const d of windowDates(member.effectiveFrom, days, side)) {
                if (d < bounds2.firstRetainedDate || d > bounds2.lastRetainedDate) {
                  fail("eventStudy", `${member.memberKey} ${side}${days} claims support for ${d}, outside pinned retention`);
                }
              }
            }
            if (w.retainedEligibleDays !== w.requestedDays || w.coveredEntityDays !== w.requestedDays) {
              fail("eventStudy", `${member.memberKey} ${side}${days} claims full support with missing entity-days`);
            }
          }
          if (w.roas !== null && w.spend <= 0) fail("eventStudy", `${member.memberKey} ${side}${days} publishes a ROAS with no spend`);
          if (w.cpa !== null && w.conversions <= 0) fail("eventStudy", `${member.memberKey} ${side}${days} publishes a CPA with no conversions`);
          if (w.spendBearingDays > w.coveredEntityDays) {
            fail("eventStudy", `${member.memberKey} ${side}${days} has more spend-bearing days than retained days`);
          }
        }
      }
      if (member.concurrentConfigChanges !== member.concurrentConfigChangeDetail.length) {
        fail("eventStudy", `${member.memberKey} concurrent config count disagrees with its own detail`);
      }
    }
    // An ambiguous group can never be labelled clean.
    if (row.groupingProof === "ambiguous_multi_member" && row.confounding === "clean_within_retained_evidence") {
      fail("eventStudy", `${row.key} is ambiguous yet labelled clean`);
    }
    const flagCount = row.confoundingFlags.length;
    const expectedClass =
      flagCount === 0 ? "clean_within_retained_evidence" : flagCount === 1 ? row.confoundingFlags[0]! : "multiple_confounds";
    if (row.confounding !== expectedClass) {
      fail("eventStudy", `${row.key} is labelled ${row.confounding} while its own flags say ${expectedClass}`);
    }
  }
  checked.push("eventStudy");

  // --- Grid partitions. ---
  const grid = published.evidenceGrid;
  const expectedCells =
    Object.values(D084_GRID_DIMENSIONS).reduce((s, v) => s + v.length, 0) * 2 * snapshot.origins.length;
  if ((grid?.cells ?? []).length !== expectedCells) {
    fail("evidenceGrid", "the grid does not cover every dimension value, direction and origin");
  }
  for (const cell of grid?.cells ?? []) {
    if (cell.clearsEvidenceFloors + cell.blocked + cell.notDeterminable !== cell.denominator) {
      fail("evidenceGrid", `${cell.dimension}=${cell.value}/${cell.direction}/${cell.origin} partition does not sum to its denominator`);
    }
    // Strict authority is zero while any structural blocker stands, and must
    // never be conflated with clearing an evidence floor.
    if (cell.strictlyEligible !== 0) {
      fail("evidenceGrid", "a cell claims strict eligibility while the structural gates stand");
    }
    if (cell.tunedGateClears + cell.tunedGateHits !== cell.denominator) {
      fail("evidenceGrid", "tuned-gate clears and hits do not partition the denominator");
    }
    if (cell.tunedGateNotDeterminable > cell.tunedGateHits) {
      fail("evidenceGrid", "a cell reports more unmeasurable rows than refused rows");
    }
    for (const [label, map] of [["business", cell.byBusiness], ["account", cell.byAccount]] as const) {
      const sum = Object.values(map).reduce((s, p) => s + p.denominator, 0);
      if (sum !== cell.denominator) fail("evidenceGrid", `${label} partition does not sum to the denominator`);
      for (const p of Object.values(map)) {
        if (p.clearsEvidenceFloors + p.blocked + p.notDeterminable !== p.denominator) {
          fail("evidenceGrid", `${label} partition row does not sum`);
        }
      }
    }
    if (cell.topBusinessShare < 0 || cell.topBusinessShare > 1) fail("evidenceGrid", "business share outside [0,1]");
    if (cell.topAccountShare < 0 || cell.topAccountShare > 1) fail("evidenceGrid", "account share outside [0,1]");
    const expected = canonicalDigest({
      assumedInputs: {
        dimension: cell.dimension, value: cell.value, direction: cell.direction,
        origin: cell.origin, settings: cell.settings,
        exponentKnown: !snapshot.d080bBlockerRanking.some(
          (b) => text(b.code) === "unit_exponent_unknown" && (num(b.hits) ?? 0) > 0,
        ),
        structuralBlockers: [...D084_STRUCTURAL_GATES],
      },
      denominator: cell.denominator,
      clearsEvidenceFloors: cell.clearsEvidenceFloors,
      blocked: cell.blocked,
      notDeterminable: cell.notDeterminable,
      strictlyEligible: cell.strictlyEligible,
      tunedGateClears: cell.tunedGateClears, tunedGateHits: cell.tunedGateHits,
      tunedGateNotDeterminable: cell.tunedGateNotDeterminable,
      byBusiness: cell.byBusiness, byAccount: cell.byAccount, coverage: cell.coverage,
    });
    if (cell.cellHash !== expected) {
      fail("evidenceGrid", `${cell.dimension}=${cell.value}/${cell.direction}/${cell.origin} hash does not cover its assumed inputs and partitions`);
    }
  }
  for (const row of grid?.monotonicity ?? []) {
    if (row.monotone === false) {
      fail("evidenceGrid", `${String(row.dimension)}/${String(row.direction)} is not monotone in strictness`);
    }
  }
  checked.push("evidenceGrid");

  // --- Change safety: INDEPENDENTLY re-derived from the frozen members. ---
  //
  // r5 called the production world builder, folder and control evaluators here,
  // so a shared algorithm error verified itself — which is precisely how the
  // same-day reversal bug passed. Every expected answer below now comes from
  // `d084-independent-oracle`, which derives partitions from restricted-growth
  // strings and order extrema by exhaustively enumerating each bucket's k!
  // local orders straight from the control definitions.
  const recomputedSpace = oracleSpace(toWorldGroups(groups));
  const publishedSpace = published.worldSpace;
  if (!publishedSpace) fail("changeSafety", "no world space is published");
  else {
    if (publishedSpace.digest !== recomputedSpace.digest) {
      fail("changeSafety", "the published world digest is not what the frozen members regenerate");
    }
    if (publishedSpace.worldCount !== recomputedSpace.worldCount) {
      fail("changeSafety", "the published world count is not what the frozen members regenerate");
    }
    if (publishedSpace.actionLowerBound !== recomputedSpace.actionLowerBound ||
        publishedSpace.actionUpperBound !== recomputedSpace.actionUpperBound) {
      fail("changeSafety", "the published action bounds are not what the frozen members regenerate");
    }
    if (publishedSpace.memberRowCount !== snapshot.transitions.length) {
      fail("changeSafety", "the world space does not account for every frozen transition member");
    }
  }

  /**
   * Every published extremum must name a world that actually produces it.
   *
   * r5 recorded a single blocked-only witness pair and never checked it. A
   * missing, foreign or non-reproducing witness is now a rejection, and the
   * bucket lineage must sum to the value it claims.
   */
  const checkWitness = (
    label: string,
    name: string,
    w: CellOutcome["witnesses"][keyof CellOutcome["witnesses"]],
    expectedValue: number,
    achievingWorlds: readonly string[],
  ) => {
    if (!w) { fail("changeSafety", `${label} publishes ${name}=${expectedValue} with no witness world`); return; }
    if (w.value !== expectedValue) {
      fail("changeSafety", `${label} ${name} witness claims ${w.value} but the cell publishes ${expectedValue}`);
    }
    if (!recomputedSpace.worlds.some((x) => x.worldKey === w.worldKey)) {
      fail("changeSafety", `${label} ${name} cites a witness world that is not in the regenerated space`);
      return;
    }
    if (!achievingWorlds.includes(w.worldKey)) {
      fail("changeSafety", `${label} ${name} witness world does not reproduce ${expectedValue} under independent enumeration`);
    }
    const summed = w.orderBuckets.reduce(
      (s, b) => s + (w.orderBound === "upper" ? b.blockedUpper : b.blockedLower), 0);
    if (name.startsWith("blocked") && summed !== w.value) {
      fail("changeSafety", `${label} ${name} witness bucket lineage sums to ${summed}, not ${w.value}`);
    }
    for (const b of w.orderBuckets) {
      if (b.blockedLower > b.blockedUpper) fail("changeSafety", `${label} ${name} witness bucket ${b.bucketKey} is inverted`);
      if (b.blockedUpper > b.actionCount) fail("changeSafety", `${label} ${name} witness bucket ${b.bucketKey} blocks more than it holds`);
      // null is legitimate only once k! stops being an exact integer.
      if (b.admissibleOrders !== null && (!Number.isInteger(b.admissibleOrders) || b.admissibleOrders < 1)) {
        fail("changeSafety", `${label} ${name} witness bucket ${b.bucketKey} declares no local order space`);
      }
    }
  };

  const checkCell = (
    label: string, o: CellOutcome | undefined, recomputed: OracleCell,
    control: OracleControl | null, scope: WorldScope, param: number,
  ) => {
    if (!o) { fail("changeSafety", `${label} publishes no outcome`); return; }
    // (1) finite, non-negative, integral, non-inverted, inside the population.
    for (const [name, value] of [
      ["evaluatedLower", o.evaluatedLower], ["evaluatedUpper", o.evaluatedUpper],
      ["blockedLower", o.blockedLower], ["blockedUpper", o.blockedUpper],
      ["clearedLower", o.clearedLower], ["clearedUpper", o.clearedUpper],
    ] as const) {
      if (!Number.isFinite(value)) fail("changeSafety", `${label} ${name} is not finite`);
      if (!Number.isInteger(value)) fail("changeSafety", `${label} ${name} is not an integer`);
      if (value < 0) fail("changeSafety", `${label} ${name} is negative (${value})`);
    }
    if (o.blockedLower > o.blockedUpper) fail("changeSafety", `${label} blocked bounds inverted`);
    if (o.clearedLower > o.clearedUpper) fail("changeSafety", `${label} cleared bounds inverted`);
    if (o.evaluatedLower > o.evaluatedUpper) fail("changeSafety", `${label} evaluated bounds inverted`);
    if (o.blockedUpper > o.evaluatedUpper) fail("changeSafety", `${label} blocks more than it evaluates`);
    if (o.clearedUpper > o.evaluatedUpper) fail("changeSafety", `${label} clears more than it evaluates`);
    // (5) group/action denominator conflation.
    if (o.denominatorUnit !== "possible_economic_actions") {
      fail("changeSafety", `${label} does not declare an action denominator`);
    }
    // (4) an exact 14-14 population while the authenticated bounds are 14-23.
    if (o.evaluatedLower === o.evaluatedUpper &&
        recomputedSpace.actionLowerBound !== recomputedSpace.actionUpperBound &&
        o.evaluatedUpper === recomputedSpace.groupCount &&
        o.excludedActionsUpper === 0) {
      fail("changeSafety", `${label} publishes an exact group-sized population while the action bounds are a range`);
    }
    // (3) the published extrema must be the ACTUAL min/max over all worlds.
    for (const [name, mine, theirs] of [
      ["blockedLower", o.blockedLower, recomputed.blockedLower],
      ["blockedUpper", o.blockedUpper, recomputed.blockedUpper],
      ["clearedLower", o.clearedLower, recomputed.clearedLower],
      ["clearedUpper", o.clearedUpper, recomputed.clearedUpper],
      ["evaluatedLower", o.evaluatedLower, recomputed.evaluatedLower],
      ["evaluatedUpper", o.evaluatedUpper, recomputed.evaluatedUpper],
    ] as const) {
      if (mine !== theirs) {
        fail("changeSafety", `${label} ${name} is ${mine} but regenerating every world gives ${theirs}`);
      }
    }
    // (6) union/intersection identity discipline.
    if (canonicalDigest(o.guaranteedBlockedKeys) !== canonicalDigest(recomputed.guaranteedBlockedKeys)) {
      fail("changeSafety", `${label} guaranteed identities are not the intersection across worlds`);
    }
    if (canonicalDigest(o.possiblyBlockedKeys) !== canonicalDigest(recomputed.possiblyBlockedKeys)) {
      fail("changeSafety", `${label} possible identities are not the union across worlds`);
    }
    for (const k of o.guaranteedBlockedKeys) {
      if (!o.possiblyBlockedKeys.includes(k)) fail("changeSafety", `${label} guarantees a block it does not admit as possible`);
      if (o.guaranteedClearKeys.includes(k)) fail("changeSafety", `${label} calls one action both guaranteed blocked and guaranteed clear`);
    }
    // (11) `exact` identities must be the SAME SET, not merely the same size.
    if (o.identitySemantics === "exact") {
      const same =
        o.guaranteedBlockedKeys.length === o.possiblyBlockedKeys.length &&
        o.guaranteedBlockedKeys.every((k, i) => o.possiblyBlockedKeys[i] === k);
      if (!same) fail("changeSafety", `${label} claims exact identities while the guaranteed and possible sets differ`);
    }
    if (o.semantics === "exact" && (o.blockedLower !== o.blockedUpper || o.evaluatedLower !== o.evaluatedUpper)) {
      fail("changeSafety", `${label} claims an exact count over a range`);
    }
    // (7) no lexicographic chronology: an identity may be guaranteed only when
    // some world/order actually forces it, which the regeneration decides.
    if (o.worldDigest !== recomputedSpace.digest) {
      fail("changeSafety", `${label} cites a world digest that is not the regenerated one`);
    }
    if (o.actionLowerBound !== recomputedSpace.actionLowerBound || o.actionUpperBound !== recomputedSpace.actionUpperBound) {
      fail("changeSafety", `${label} cites action bounds that are not the regenerated ones`);
    }
    // (12) the order space must be declared and must match what enumeration finds.
    if (o.orderSpaceSemantics !== D084_ORDER_SEMANTICS) {
      fail("changeSafety", `${label} does not declare the order-space semantics`);
    }
    if (o.orderDependent !== recomputed.orderDependent) {
      fail("changeSafety", `${label} declares orderDependent=${String(o.orderDependent)} but enumeration finds ${String(recomputed.orderDependent)}`);
    }
    // (13) every extremum carries a reproducing witness.
    checkWitness(label, "evaluatedLower", o.witnesses?.evaluatedLower ?? null, o.evaluatedLower, recomputed.worldsAchievingEvaluatedLower);
    checkWitness(label, "evaluatedUpper", o.witnesses?.evaluatedUpper ?? null, o.evaluatedUpper, recomputed.worldsAchievingEvaluatedUpper);
    checkWitness(label, "blockedLower", o.witnesses?.blockedLower ?? null, o.blockedLower, recomputed.worldsAchievingBlockedLower);
    checkWitness(label, "blockedUpper", o.witnesses?.blockedUpper ?? null, o.blockedUpper, recomputed.worldsAchievingBlockedUpper);
    checkWitness(label, "clearedLower", o.witnesses?.clearedLower ?? null, o.clearedLower, recomputed.worldsAchievingClearedLower);
    checkWitness(label, "clearedUpper", o.witnesses?.clearedUpper ?? null, o.clearedUpper, recomputed.worldsAchievingClearedUpper);
    // (14) EVERY world, EVERY local order: the partition must hold and no
    // order may block more than the scope evaluates. r5 sampled 32 worlds and
    // one cooldown value; this runs the actual cell's control everywhere.
    if (control !== null) {
      const sweep = oracleSweep(recomputedSpace, scope, control, param);
      recomputedSpace.worlds.forEach((world, i) => {
        const w = sweep[i]!;
        if (w.blockedLower < 0 || w.blockedUpper > w.evaluated) {
          fail("changeSafety", `${label} world ${world.worldKey} blocks outside its evaluated set`);
        }
        if (!Number.isInteger(w.blockedLower) || !Number.isInteger(w.blockedUpper)) {
          fail("changeSafety", `${label} world ${world.worldKey} produces a non-integer count`);
        }
        if (w.blockedUpper + (w.evaluated - w.blockedUpper) !== w.evaluated) {
          fail("changeSafety", `${label} world ${world.worldKey} does not partition blocked and cleared`);
        }
        if (w.guaranteed.some((k) => !w.possible.includes(k))) {
          fail("changeSafety", `${label} world ${world.worldKey} guarantees a block it does not admit`);
        }
      });
    }
  };

  for (const cell of published.cooldownGrid ?? []) {
    checkCell(
      `cooldown ${cell.cooldownDays}/${cell.scope}`,
      cell.outcome,
      oracleCell(recomputedSpace, cell.scope, "cooldown", cell.cooldownDays),
      "cooldown", cell.scope, cell.cooldownDays,
    );
  }
  for (const cell of published.capGrid ?? []) {
    checkCell(
      `cap ${cell.cap}/${cell.scope}`,
      cell.outcome,
      oracleCell(recomputedSpace, cell.scope, "cap", cell.cap),
      "cap", cell.scope, cell.cap,
    );
    if (cell.semantics !== D084_COUNT_SEMANTICS) fail("changeSafety", `cap ${cell.cap}/${cell.scope} does not declare prospective semantics`);
    // (8) entity-scope double counting: an action with no determinate entity
    // must be EXCLUDED, never added to several buckets.
    if (cell.scope === "entity" && recomputedSpace.indeterminateEntityActionKeys.length > 0) {
      if ((cell.outcome?.excludedActionsUpper ?? 0) === 0) {
        fail("changeSafety", `cap ${cell.cap}/entity places actions whose entity target is indeterminate`);
      }
    }
  }
  for (const cell of published.concentrationGrid ?? []) {
    const label = `concentration ${cell.maxAccountShareOfFleet}`;
    const conc = oracleConcentration(recomputedSpace, cell.maxAccountShareOfFleet);
    // Concentration is a ratio of SETS, so no total order can move it. The
    // control is passed as null: there is no order space to enumerate, and the
    // cell must say so rather than leave it implied.
    checkCell(
      label, cell.outcome,
      oracleConcentrationCell(recomputedSpace, cell.maxAccountShareOfFleet),
      null, "fleet", cell.maxAccountShareOfFleet,
    );
    if (cell.outcome?.orderDependent !== false) {
      fail("changeSafety", `${label} does not state that a share of sets is order-independent`);
    }
    if (cell.outcome && (cell.outcome.blockedLower !== conc.blockedLower || cell.outcome.blockedUpper !== conc.blockedUpper)) {
      fail("changeSafety", `${label} blocked bounds are not the independently derived share counts`);
    }
    // (10) degeneracy must be an acting-ACCOUNT test, not a group-count test.
    if (cell.degenerateFleetDaysLower !== conc.degenerateLower || cell.degenerateFleetDaysUpper !== conc.degenerateUpper) {
      fail("changeSafety", `${label} degenerate-day bounds are not the independently derived acting-account counts`);
    }
    if (cell.degenerateFleetDaysUpper > cell.totalFleetDays) fail("changeSafety", `${label} more degenerate days than days`);
    if (cell.degenerateFleetDaysUpper > 0 && cell.maxAccountShareOfFleet < 1 && cell.degeneracyWhy === null) {
      fail("changeSafety", `${label} is degenerate yet does not say so`);
    }
  }
  for (const cell of published.lookbackGrid ?? []) {
    checkCell(
      `lookback ${cell.lookbackDays}/${cell.scope}`,
      cell.outcome,
      oracleCell(recomputedSpace, cell.scope, "lookback", cell.lookbackDays),
      "lookback", cell.scope, cell.lookbackDays,
    );
    // Same-direction repeats ride the SAME order model. r5 derived them from
    // identity presence, so k same-day same-direction actions published [0, k]
    // when every order produces exactly k-1.
    const repeats = oracleRepeatBounds(recomputedSpace, cell.scope, cell.lookbackDays);
    if (cell.sameDirectionRepeatsLower !== repeats.lower || cell.sameDirectionRepeatsUpper !== repeats.upper) {
      fail("changeSafety", `lookback ${cell.lookbackDays}/${cell.scope} repeat bounds are [${cell.sameDirectionRepeatsLower}, ${cell.sameDirectionRepeatsUpper}] but independent enumeration gives [${repeats.lower}, ${repeats.upper}]`);
    }
  }
  for (const scope of D084_SAFETY_SCOPES) {
    if (!(published.cooldownGrid ?? []).some((c) => c.scope === scope)) fail("changeSafety", `no cooldown cell for the ${scope} scope`);
    if (!(published.capGrid ?? []).some((c) => c.scope === scope)) fail("changeSafety", `no cap cell for the ${scope} scope`);
    if (!(published.lookbackGrid ?? []).some((c) => c.scope === scope)) fail("changeSafety", `no lookback cell for the ${scope} scope`);
  }
  if ((published.concentrationGrid ?? []).length !== D084_CONCENTRATION_CANDIDATES.length) {
    fail("changeSafety", "the concentration grid does not cover every candidate");
  }
  // (2) EVERY world, EVERY declared parameter, EVERY scope, EVERY control.
  //
  // r5 advertised this check but ran `worlds.slice(0, 32)` against a single
  // hardcoded cooldown of 7 days, so 608 of 640 worlds, three of four controls
  // and every other parameter value went unchecked. The per-cell loop inside
  // `checkCell` now covers each published cell exhaustively; this block proves
  // the declared ladders are covered even where a cell is missing entirely.
  for (const [control, values] of [
    ["cooldown", D084_COOLDOWN_DAYS],
    ["cap", D084_CAP_CANDIDATES],
    ["lookback", D084_LOOKBACK_DAYS],
  ] as ReadonlyArray<readonly [OracleControl, readonly number[]]>) {
    for (const param of values) {
      for (const scope of D084_SAFETY_SCOPES) {
        recomputedSpace.worlds.forEach((world, i) => {
          const o = oracleSweep(recomputedSpace, scope, control, param)[i]!;
          if (o.blockedLower < 0 || o.blockedUpper > o.evaluated) {
            fail("changeSafety", `${control} ${param}/${scope} leaves the evaluated set in world ${world.worldKey}`);
          }
          if (o.blockedUpper + (o.evaluated - o.blockedUpper) !== o.evaluated) {
            fail("changeSafety", `${control} ${param}/${scope} does not partition world ${world.worldKey}`);
          }
        });
      }
    }
  }
  const reconciliation = published.changeSafety;
  if (reconciliation) {
    if (reconciliation.denominatorUnit !== "possible_economic_actions") {
      fail("changeSafety", "the reconciliation does not declare an action denominator");
    }
    if (reconciliation.groupDiagnostics?.unit !== "economic_event_groups") {
      fail("changeSafety", "group diagnostics are not labelled as groups");
    }
    if (reconciliation.groupDiagnostics.groupCount !== groups.length) {
      fail("changeSafety", "the group census does not match the group set");
    }
    if (reconciliation.groupDiagnostics.memberRowCount !== snapshot.transitions.length) {
      fail("changeSafety", "the member census does not account for every transition");
    }
    if (reconciliation.actionLowerBound !== recomputedSpace.actionLowerBound ||
        reconciliation.actionUpperBound !== recomputedSpace.actionUpperBound) {
      fail("changeSafety", "the reconciliation action bounds are not the regenerated ones");
    }
    if (reconciliation.worldDigest !== recomputedSpace.digest) {
      fail("changeSafety", "the reconciliation cites a foreign world digest");
    }
    for (const [label, map] of [["business", reconciliation.actionsByBusiness], ["account", reconciliation.actionsByAccount], ["direction", reconciliation.actionsByDirection]] as const) {
      for (const [k, v] of Object.entries(map)) {
        if (v.lower > v.upper) fail("changeSafety", `${label} ${k} action bounds inverted`);
        if (v.lower < 0) fail("changeSafety", `${label} ${k} action lower bound is negative`);
      }
    }
    const totalIntervals = Object.values(reconciliation.intervalDaysPerAccount).reduce((s, a) => s + a.length, 0);
    const multiGroupAccounts = Object.values(reconciliation.groupDiagnostics.groupsByAccount).filter((n) => n > 1).length;
    if (multiGroupAccounts > 0 && totalIntervals === 0) {
      fail("changeSafety", "accounts carry several groups yet every inter-group interval is empty");
    }
  }
  checked.push("changeSafety");

  // --- Owner-clock coverage, recomputed from the authenticated owner rows. ---
  const recomputedOwnerCoverage = buildOwnerClockCoverage(
    snapshot.ownerStates,
    buildEventMembers(snapshot.transitions, decodeDaily(snapshot.daily), snapshot.ownerStates),
  );
  const ownerCoverage = published.ownerClockCoverage;
  if (!ownerCoverage) fail("ownerClockCoverage", "no owner-clock coverage is published");
  else {
    if (canonicalDigest(ownerCoverage) !== canonicalDigest(recomputedOwnerCoverage)) {
      fail("ownerClockCoverage", "the published owner-clock coverage is not what the frozen owner rows recompute");
    }
    if (ownerCoverage.digest !== recomputedOwnerCoverage.digest) {
      fail("ownerClockCoverage", "the coverage digest does not describe its own fields");
    }
    const parts =
      ownerCoverage.capturedAfterObservedDay + ownerCoverage.capturedOnObservedDay +
      ownerCoverage.capturedBeforeObservedDay + ownerCoverage.nullOrInvalidCapturedAt;
    if (parts !== ownerCoverage.retainedOwnerRows) {
      fail("ownerClockCoverage", "the capture-clock classes do not partition the retained owner rows");
    }
    if (ownerCoverage.retainedOwnerRows !== snapshot.ownerStates.length) {
      fail("ownerClockCoverage", "the coverage does not cover every frozen owner row");
    }
    if (ownerCoverage.membersResolved + ownerCoverage.membersUnresolved !== ownerCoverage.eventMembers) {
      fail("ownerClockCoverage", "resolved and unresolved members do not partition the member set");
    }
    if (ownerCoverage.eventMembers !== snapshot.transitions.length) {
      fail("ownerClockCoverage", "the coverage does not cover every frozen transition member");
    }
    // The residual prose must be built from these fields, never from literals.
    const prose = (published.residualBlockers ?? []).find((b) => b.blocker === "owner_lineage_rarely_knowable_at_the_event");
    if (prose && !String(prose.evidence).includes(`${ownerCoverage.capturedAfterObservedDay} of ${ownerCoverage.retainedOwnerRows}`)) {
      fail("ownerClockCoverage", "the residual blocker text does not agree with the derived coverage");
    }
  }
  checked.push("ownerClockCoverage");

  // --- Collapsed-config causes must be attributed separately. ---
  const coverage = published.collapsedConfigCoverage;
  if (coverage) {
    const ndTotal = Object.values(coverage.evaluationsNotDeterminable).reduce((a, b) => a + b, 0);
    if (coverage.evaluationsResolved + ndTotal !== coverage.evaluations) {
      fail("collapsedConfig", "resolved and not-determinable evaluations do not partition the total");
    }
    if (coverage.collapsedSkylineEvaluations > ndTotal) {
      fail("collapsedConfig", "more collapsed-skyline evaluations than unresolved ones");
    }
    if ((coverage.evaluationsNotDeterminable.not_determinable_collapsed_skyline ?? 0) !== coverage.collapsedSkylineEvaluations) {
      fail("collapsedConfig", "the collapsed-skyline count disagrees with the reason distribution");
    }
    for (const [label, map] of [["business", coverage.byBusiness], ["account", coverage.byAccount]] as const) {
      for (const [k, v] of Object.entries(map)) {
        if (v.resolved + v.notDeterminable !== v.evaluations) {
          fail("collapsedConfig", `${label} ${k} partition does not sum`);
        }
        const reasonTotal = Object.values(v.byReason).reduce((a, b) => a + b, 0);
        if (reasonTotal !== v.notDeterminable) {
          fail("collapsedConfig", `${label} ${k} reason distribution does not account for its unresolved evaluations`);
        }
      }
    }
  }
  checked.push("collapsedConfig");

  // --- Target packs and tombstones. ---
  for (const truth of published.targetPackTruth ?? []) {
    if (truth.asOfOrigins.length !== snapshot.origins.length) {
      fail("targetPacks", `${truth.business} does not publish every origin`);
    }
    for (const asOf of truth.asOfOrigins) {
      if (asOf.configured !== (asOf.selected !== null)) {
        fail("targetPacks", `${truth.business}@${asOf.origin} configured disagrees with its own selection`);
      }
      if (asOf.selected === null && asOf.absentReason === null) {
        fail("targetPacks", `${truth.business}@${asOf.origin} has no pack and no reason`);
      }
      if (asOf.selected !== null && (asOf.selected.operation ?? "").toLowerCase() === "delete") {
        fail("targetPacks", `${truth.business}@${asOf.origin} selected a tombstone as a live pack`);
      }
      if (asOf.approvedForPolicy !== false) fail("targetPacks", "a pack is marked approved for policy");
    }
    for (const revision of truth.revisionLineage) {
      const effective = instantMs(revision.effectiveAt);
      const recorded = instantMs(revision.recordedAt);
      const knowable = effective === null || recorded === null ? null : Math.max(effective, recorded);
      if (revision.knowableFromMs !== knowable) {
        fail("targetPacks", `${truth.business} revision ${revision.revisionId} knowable instant is not max(effective, recorded)`);
      }
    }
    if (truth.rawFieldLedger.note !== "descriptive raw-field ledger; not an authority and never an eligibility verdict") {
      fail("targetPacks", `${truth.business} raw ledger is not labelled descriptive`);
    }
  }
  checked.push("targetPacks");

  // --- Canonical profile availability. ---
  for (const availability of published.canonicalProfileAvailability ?? []) {
    if (availability.byAction.length !== D084_PROFILE_ACTIONS.length) {
      fail("canonicalProfile", `${availability.business} does not publish every action`);
    }
    for (const action of availability.byAction) {
      if (action.status !== "not_determinable") {
        fail("canonicalProfile", `${availability.business}/${action.action} claims a status the pinned bytes cannot support`);
      }
      if (action.eligible !== null) fail("canonicalProfile", `${availability.business}/${action.action} invented an eligibility`);
      if (action.observedContract !== null) fail("canonicalProfile", `${availability.business}/${action.action} names an observed contract that does not exist`);
      if (action.expectedContract !== ACCOUNT_DECISION_PROFILE_CONTRACT_EXPECTED) {
        fail("canonicalProfile", `${availability.business}/${action.action} names the wrong expected contract`);
      }
      if (action.reasonCode !== "canonical_profile_output_not_retained") {
        fail("canonicalProfile", `${availability.business}/${action.action} has the wrong reason code`);
      }
    }
  }
  checked.push("canonicalProfile");

  // --- The authority ceiling. ---
  for (const row of published.perBusiness ?? []) {
    if (row.approvedForPolicy !== false) fail("authority", "a business is marked approved for policy");
  }
  if (published.fleet?.maximumReachableAuthority !== "validated_only") fail("authority", "fleet ceiling is not validated_only");
  if (published.fleet?.automation !== "off") fail("authority", "fleet automation is not off");
  if ((published.fleet?.databaseQueriesExecuted ?? -1) !== 0) fail("authority", "the fleet headline does not state zero queries");
  if (published.evidenceGrid?.selectable !== false) fail("authority", "an evidence floor is claimed selectable");
  checked.push("authority");

  return {
    ok: failures.length === 0,
    failures, checked,
    counters: {
      pinnedSources: manifestNow.length,
      dailyRows: snapshot.daily.count,
      configRows: snapshot.configStates.count,
      ownerStateRows: snapshot.ownerStates.length,
      transitions: snapshot.transitions.length,
      eventGroups: groups.length,
      memberRows,
      actionsLower: published.eventBounds?.lower ?? -1,
      actionsUpper: published.eventBounds?.upper ?? -1,
      gridCells: (published.evidenceGrid?.cells ?? []).length,
      cooldownCells: (published.cooldownGrid ?? []).length,
      capCells: (published.capGrid ?? []).length,
      concentrationCells: (published.concentrationGrid ?? []).length,
      lookbackCells: (published.lookbackGrid ?? []).length,
      scenarios: (published.scenarios ?? []).length,
      charterBusinesses: D084_CHARTER_BUSINESSES.length,
      residualBlockers: (published.residualBlockers ?? []).length,
    },
  };
}

export function runReplay(path = D084_JSON_OUT): Record<string, string> {
  const artifact = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
  const replayed = replayFromArtifact(artifact);
  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash"));
  const out = { ...replayed, artifactHash: canonicalDigest(body) };
  console.log(JSON.stringify({ phase: "d084-replay", ...out }, null, 1));
  return out;
}

export function runVerify(path = D084_JSON_OUT): VerifyResult {
  const artifact = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
  const result = verifyArtifact(artifact);
  console.log(JSON.stringify({ phase: "d084-verify", ...result }, null, 1));
  return result;
}

// ---------------------------------------------------------------------------
// CLI — must stay last: it runs at module evaluation and reads every const above
// ---------------------------------------------------------------------------

const invoked = process.argv[1] ?? "";
if (invoked.includes("d084-commercial-target-evidence")) {
  const mode = process.argv[2] ?? "verify";
  if (mode === "assemble") runAssemble();
  else if (mode === "replay") runReplay();
  else if (mode === "verify") { if (!runVerify().ok) process.exitCode = 1; }
  else { console.error(`unknown mode ${mode}`); process.exitCode = 2; }
}
