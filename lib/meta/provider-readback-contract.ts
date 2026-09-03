/**
 * D085 — provider preflight and INDEPENDENT read-back.
 *
 * The governing rule, from the live-execution-safety reference: "A mutation
 * echo, cached value, empty object, or non-null response does not qualify."
 * So this module is built so a mutation response *cannot* reach the
 * classifier: `classifyReadback` accepts only a freshly observed projection
 * and an explicit attempt outcome. There is no parameter through which a
 * provider write reply could be passed off as proof.
 *
 * D085 sends no mutation. Every real D085 receipt therefore classifies as
 * `not_attempted`, and the other branches are proved by mocked contract tests
 * rather than by a live write.
 *
 * NOTHING HERE CALLS A PROVIDER. The module defines the shape of a preflight
 * GET and the arithmetic of comparing two projections; the caller performs any
 * actual read.
 */

import { createHash } from "node:crypto";

import type { BudgetField, BudgetOwnerGrain, BudgetOwnerMode } from "@/lib/meta/budget-intent-contract";
import { normalizeProviderAccountIdentity } from "@/lib/provider-assignment-authorization";
import { META_OPTIMIZATION_GOALS } from "@/lib/meta/funnel-cohort";

/**
 * The effective statuses the Meta read paths in this repository already use.
 *
 * Sourced from `lib/meta/creatives-fetchers.ts` and
 * `lib/launchpad/meta-validation.ts` rather than invented here: a second,
 * divergent list would be a new vocabulary, which is exactly what D085 must
 * not create.
 */
export const META_EFFECTIVE_STATUSES: readonly string[] = [
  "ACTIVE", "PAUSED", "ARCHIVED", "DELETED", "DISAPPROVED",
  "PENDING_REVIEW", "PREAPPROVED", "PENDING_BILLING_INFO",
  "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES",
];

/** A Meta provider entity id is a numeric string. */
const META_ENTITY_ID = /^[0-9]{1,32}$/;

/**
 * ONE strict canonical ISO instant.
 *
 * `Date.parse` rolls `2026-02-30T00:00:00.000Z` into March, so an impossible
 * observation proved freshness. This round-trips the calendar components and
 * requires an explicit timezone.
 */
export function strictInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, ys, ms_, ds, hs, mins, ss, frac, zone] = m;
  const y = Number(ys), mo = Number(ms_), d = Number(ds);
  const h = Number(hs), mi = Number(mins), sec = Number(ss);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  // Round-trip the DATE part in UTC to reject rollover (e.g. 2026-02-30).
  const utcDay = Date.UTC(y, mo - 1, d);
  const back = new Date(utcDay);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  let offsetMs = 0;
  if (zone !== "Z") {
    const sign = zone!.startsWith("-") ? -1 : 1;
    const oh = Number(zone!.slice(1, 3)), om = Number(zone!.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMs = sign * (oh * 3_600_000 + om * 60_000);
  }
  const ms = utcDay + h * 3_600_000 + mi * 60_000 + sec * 1000 + Number((frac ?? "0").padEnd(3, "0")) - offsetMs;
  return Number.isFinite(ms) ? ms : null;
}

export const META_PROVIDER_READBACK_CONTRACT = "meta.provider-readback.v4" as const;
export const META_PROVIDER_READBACK_REJECTED_VERSIONS = [
  "meta.provider-readback.v1",
  "meta.provider-readback.v2",
  "meta.provider-readback.v3",
] as const;

/**
 * The smallest normalized projection that proves the approved fields.
 *
 * Per the read-back matrix: identity, the mutated field in provider units,
 * status, owner mode and schedule. Anything wider invites a false mismatch on
 * an unrelated field; anything narrower cannot prove the write landed on the
 * right entity.
 */
export const PREFLIGHT_PROJECTION_FIELDS = [
  "providerAccountId",
  "entityGrain",
  "entityId",
  "parentCampaignId",
  "budgetField",
  "budgetMinorUnits",
  "ownerMode",
  "effectiveStatus",
  "scheduleStart",
  "scheduleEnd",
  "optimizationGoal",
] as const;
export type PreflightProjectionField = (typeof PREFLIGHT_PROJECTION_FIELDS)[number];

export interface PreflightProjection {
  providerAccountId: string;
  entityGrain: BudgetOwnerGrain;
  entityId: string;
  parentCampaignId: string | null;
  budgetField: BudgetField;
  /** Authoritative raw provider minor units. Never a display value. */
  budgetMinorUnits: number | null;
  ownerMode: BudgetOwnerMode;
  effectiveStatus: string | null;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  optimizationGoal: string | null;
}

/**
 * The outcome of one bounded provider GET.
 *
 * `not_attempted` is first-class and is the honest answer whenever no read was
 * safely available — it must never be silently upgraded by an absent error.
 */
export type PreflightAttemptOutcome =
  | { status: "not_attempted"; why: string }
  | { status: "succeeded"; observedAt: string; projection: PreflightProjection }
  | { status: "failed"; why: string; retryable: boolean }
  | { status: "stale"; why: string; observedAt: string; ageSeconds: number };

/** How long a preflight read may be trusted before it must be taken again. */
export const PREFLIGHT_MAX_AGE_SECONDS = 300;

/**
 * Why a read could not be used, independent of whether it "succeeded".
 *
 * The first pass had no such concept: a caller asserted `succeeded` and the
 * comparison believed it. These are the contract's OWN findings.
 */
export const PREFLIGHT_REJECTIONS = [
  "clock_missing",
  "clock_unparseable",
  "clock_in_future",
  "read_stale",
  "projection_incomplete",
  "projection_invalid",
] as const;
export type PreflightRejection = (typeof PREFLIGHT_REJECTIONS)[number];

export interface PreflightComparison {
  contractVersion: typeof META_PROVIDER_READBACK_CONTRACT;
  /** The caller's claimed status, plus what this contract independently found. */
  outcome: PreflightAttemptOutcome["status"] | "rejected";
  claimedStatus: PreflightAttemptOutcome["status"];
  rejections: PreflightRejection[];
  /** Age of the read at the evaluation instant; null when it cannot be derived. */
  ageSeconds: number | null;
  fresh: boolean;
  projectionComplete: boolean;
  /** Fields whose observed value differs from the dry-run baseline. */
  driftedFields: PreflightProjectionField[];
  driftDetail: Array<{ field: PreflightProjectionField; baseline: unknown; observed: unknown }>;
  matchesBaseline: boolean;
  why: string;
}

/** The server-owned evaluation clock. A caller cannot omit it. */
export interface PreflightClock {
  /** ISO instant the comparison is made at. */
  evaluatedAt: string;
  /** Defaults to {@link PREFLIGHT_MAX_AGE_SECONDS}; must be finite and > 0. */
  maxAgeSeconds?: number;
}

/** The one strict instant parser. Kept as a named alias for call sites. */
function parseInstant(value: unknown): number | null {
  return strictInstant(value);
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * A real calendar day, or null.
 *
 * `Date.parse` silently rolls `2026-02-30` over to March 2nd, so a malformed
 * flight would validate. This round-trips the components and refuses anything
 * the calendar did not actually contain.
 */
export function strictCalendarDay(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(ms)) return null;
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

/**
 * Validate a projection structurally and semantically.
 *
 * Nullability survives ONLY where entity semantics prove the field is not
 * required: a campaign has no parent, and a daily budget has no flight. Every
 * other absence, and every impossible amount, is a rejection.
 */
export function validateProjection(p: PreflightProjection): {
  complete: boolean; problems: string[];
} {
  const problems: string[] = [];

  // Runtime membership, not the TypeScript type. External data is not typed.
  const GRAINS = ["campaign", "adset"];
  const FIELDS = ["daily_budget", "lifetime_budget"];
  const OWNER_MODES = ["campaign_budget_optimization", "adset_budget", "unknown", "not_applicable"];

  // CANONICAL IDENTITY, reusing the repository's own shapes. r3 accepted
  // "not-an-account" and "not-an-adset" as complete.
  if (!nonEmpty(p.providerAccountId)) {
    problems.push("providerAccountId is missing");
  } else if (normalizeProviderAccountIdentity("meta", p.providerAccountId) !== p.providerAccountId.trim()
             || !/^act_[0-9]{1,32}$/.test(p.providerAccountId.trim())) {
    problems.push(`providerAccountId ${JSON.stringify(p.providerAccountId)} is not a canonical Meta account id`);
  }
  if (!nonEmpty(p.entityId)) {
    problems.push("entityId is missing");
  } else if (!META_ENTITY_ID.test(p.entityId.trim())) {
    problems.push(`entityId ${JSON.stringify(p.entityId)} is not a Meta provider entity id`);
  }
  if (!GRAINS.includes(p.entityGrain as string)) problems.push(`entityGrain ${JSON.stringify(p.entityGrain)} is not a budget-owning grain`);
  if (!FIELDS.includes(p.budgetField as string)) problems.push(`budgetField ${JSON.stringify(p.budgetField)} is not a supported budget field`);
  if (!OWNER_MODES.includes(p.ownerMode as string)) problems.push(`ownerMode ${JSON.stringify(p.ownerMode)} is not a known owner mode`);

  // The amount is the whole point of the read: null is never acceptable, and
  // provider minor units are non-negative integers.
  if (p.budgetMinorUnits === null || p.budgetMinorUnits === undefined) {
    problems.push("budgetMinorUnits is null, so the read proves no amount");
  } else if (typeof p.budgetMinorUnits !== "number" || !Number.isFinite(p.budgetMinorUnits)) {
    problems.push("budgetMinorUnits is not a finite number");
  } else if (!Number.isInteger(p.budgetMinorUnits)) {
    problems.push("budgetMinorUnits is fractional, but minor units are whole");
  } else if (p.budgetMinorUnits < 0) {
    problems.push("budgetMinorUnits is negative");
  }

  // OWNER-MODE / GRAIN COHERENCE. Neither `unknown` nor `not_applicable` ever
  // proves who owns a budget, and an owner mode from the wrong grain is a
  // contradiction rather than a detail.
  if (p.ownerMode === "unknown") {
    problems.push("ownerMode is unknown, so budget ownership is undetermined");
  } else if (p.ownerMode === "not_applicable") {
    problems.push("ownerMode is not_applicable, so this entity owns no budget and no amount can be proved for it");
  } else if (p.ownerMode === "campaign_budget_optimization" && p.entityGrain !== "campaign") {
    problems.push("campaign_budget_optimization is a campaign owner mode but the entity is an ad set");
  } else if (p.ownerMode === "adset_budget" && p.entityGrain !== "adset") {
    problems.push("adset_budget is an ad-set owner mode but the entity is a campaign");
  }

  if (!nonEmpty(p.effectiveStatus)) {
    problems.push("effectiveStatus is missing");
  } else if (!META_EFFECTIVE_STATUSES.includes(String(p.effectiveStatus).trim().toUpperCase())) {
    problems.push(`effectiveStatus ${JSON.stringify(p.effectiveStatus)} is not a status this repository recognises`);
  }

  // An ad set carries an optimization goal and a parent; a campaign carries
  // neither in this projection.
  if (p.entityGrain === "adset") {
    if (!nonEmpty(p.optimizationGoal)) {
      problems.push("optimizationGoal is missing for an ad set");
    } else if (!META_OPTIMIZATION_GOALS.includes(String(p.optimizationGoal).trim().toUpperCase())) {
      problems.push(`optimizationGoal ${JSON.stringify(p.optimizationGoal)} is not a goal this repository recognises`);
    }
    if (!nonEmpty(p.parentCampaignId)) {
      problems.push("parentCampaignId is missing for an ad set");
    } else if (!META_ENTITY_ID.test(String(p.parentCampaignId).trim())) {
      problems.push(`parentCampaignId ${JSON.stringify(p.parentCampaignId)} is not a Meta provider entity id`);
    }
  } else if (p.entityGrain === "campaign") {
    if (p.parentCampaignId !== null) problems.push("a campaign must not carry a parentCampaignId");
    if (p.optimizationGoal !== null) problems.push("a campaign must not carry an ad-set optimization goal in this projection");
  }

  // A lifetime budget needs a REAL, forward-ordered flight. A daily budget has
  // none, and carrying one is itself a contradiction.
  if (p.budgetField === "lifetime_budget") {
    const start = strictCalendarDay(p.scheduleStart);
    const end = strictCalendarDay(p.scheduleEnd);
    if (start === null) problems.push(`scheduleStart ${JSON.stringify(p.scheduleStart)} is not a valid calendar day for a lifetime budget`);
    if (end === null) problems.push(`scheduleEnd ${JSON.stringify(p.scheduleEnd)} is not a valid calendar day for a lifetime budget`);
    if (start !== null && end !== null && end < start) {
      problems.push(`the lifetime flight ends (${p.scheduleEnd}) before it starts (${p.scheduleStart})`);
    }
  } else if (p.budgetField === "daily_budget") {
    if (p.scheduleStart !== null || p.scheduleEnd !== null) {
      problems.push("a daily budget must not carry a lifetime flight");
    }
  }
  return { complete: problems.length === 0, problems };
}

/** Type-safe field read: the field union is exactly `keyof PreflightProjection`. */
function projectionValue(p: PreflightProjection, field: PreflightProjectionField): unknown {
  return p[field];
}

/**
 * Type-tagged so no value can collide with another's rendering.
 *
 * Every branch carries its own prefix, so the string "null" renders as
 * `s:null` while an actual null renders as `null:` — they can never be
 * mistaken for one another, and no raw control byte is needed to keep them
 * apart.
 */
function normalize(value: unknown): string {
  if (value === null || value === undefined) return "null:";
  if (typeof value === "number") return Number.isFinite(value) ? `n:${value}` : "nan:";
  return `s:${String(value)}`;
}

export function comparePreflight(
  baseline: PreflightProjection,
  attempt: PreflightAttemptOutcome,
  clock: PreflightClock,
): PreflightComparison {
  const rejections: PreflightRejection[] = [];
  const problems: string[] = [];
  const base = {
    contractVersion: META_PROVIDER_READBACK_CONTRACT,
    claimedStatus: attempt.status,
    driftedFields: [] as PreflightProjectionField[],
    driftDetail: [] as PreflightComparison["driftDetail"],
  };

  // A caller that did not read cannot match, whatever it claims.
  if (attempt.status !== "succeeded") {
    return {
      ...base,
      outcome: attempt.status,
      rejections: [],
      ageSeconds: null,
      fresh: false,
      projectionComplete: false,
      matchesBaseline: false,
      why:
        attempt.status === "not_attempted"
          ? `no preflight read was attempted: ${attempt.why}`
          : attempt.status === "stale"
            ? `the caller reported a stale read: ${attempt.why}`
            : `the preflight read failed: ${attempt.why}`,
    };
  }

  // --- the contract's OWN freshness finding, never the caller's claim ---
  const evaluatedAtMs = parseInstant(clock.evaluatedAt);
  const observedAtMs = parseInstant(attempt.observedAt);
  const ceiling = clock.maxAgeSeconds ?? PREFLIGHT_MAX_AGE_SECONDS;
  let ageSeconds: number | null = null;

  if (evaluatedAtMs === null) {
    rejections.push("clock_missing");
    problems.push("the evaluation clock is missing or unparseable");
  }
  if (observedAtMs === null) {
    rejections.push("clock_unparseable");
    problems.push(`observedAt ${JSON.stringify(attempt.observedAt)} is not a parseable instant`);
  }
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    rejections.push("clock_missing");
    problems.push(`maxAgeSeconds ${String(ceiling)} is not a positive finite bound`);
  }
  if (evaluatedAtMs !== null && observedAtMs !== null) {
    ageSeconds = (evaluatedAtMs - observedAtMs) / 1000;
    if (ageSeconds < 0) {
      rejections.push("clock_in_future");
      problems.push(`the read is dated ${Math.abs(Math.round(ageSeconds))}s in the future`);
    } else if (Number.isFinite(ceiling) && ceiling > 0 && ageSeconds > ceiling) {
      rejections.push("read_stale");
      problems.push(`the read is ${Math.round(ageSeconds)}s old, past the ${ceiling}s ceiling`);
    }
  }

  // --- the contract's OWN completeness finding ---
  const observedValidity = validateProjection(attempt.projection);
  const baselineValidity = validateProjection(baseline);
  if (!observedValidity.complete) {
    rejections.push("projection_incomplete");
    problems.push(...observedValidity.problems.map((x) => `observed projection: ${x}`));
  }
  if (!baselineValidity.complete) {
    rejections.push("projection_invalid");
    problems.push(...baselineValidity.problems.map((x) => `baseline projection: ${x}`));
  }

  // --- field-by-field drift ---
  const drifted: PreflightProjectionField[] = [];
  const detail: PreflightComparison["driftDetail"] = [];
  for (const field of PREFLIGHT_PROJECTION_FIELDS) {
    const a = projectionValue(baseline, field);
    const b = projectionValue(attempt.projection, field);
    if (normalize(a) !== normalize(b)) {
      drifted.push(field);
      detail.push({ field, baseline: a, observed: b });
    }
  }

  const fresh = rejections.every((r) => r !== "clock_missing" && r !== "clock_unparseable" && r !== "clock_in_future" && r !== "read_stale");
  const projectionComplete = observedValidity.complete && baselineValidity.complete;
  // MATCH REQUIRES ALL FOUR: a real read, a fresh valid clock, a complete
  // valid projection, and equality. The first pass required only the last.
  const matches = fresh && projectionComplete && drifted.length === 0;

  return {
    ...base,
    outcome: rejections.length > 0 ? "rejected" : "succeeded",
    rejections: PREFLIGHT_REJECTIONS.filter((r) => rejections.includes(r)),
    ageSeconds,
    fresh,
    projectionComplete,
    driftedFields: drifted,
    driftDetail: detail,
    matchesBaseline: matches,
    why: matches
      ? `a fresh (${Math.round(ageSeconds ?? 0)}s old), complete provider read reproduces the baseline on every projected field`
      : problems.concat(drifted.length > 0 ? [`state drifted on ${drifted.join(", ")}`] : []).join("; "),
  };
}

// ---------------------------------------------------------------------------
// Independent read-back classification
// ---------------------------------------------------------------------------

export type ReadbackClassification =
  | "confirmed"
  | "definite_mismatch"
  | "ambiguous"
  | "not_attempted";

/**
 * Whether a mutation was actually sent.
 *
 * This is deliberately NOT the provider's reply. A reply can say "success"
 * after a write that never landed, and a timeout can follow a write that did.
 */
export type MutationAttempt =
  | { sent: false; why: string }
  | { sent: true; transport: "completed" | "timeout" | "transport_error" };

export interface ReadbackVerdict {
  contractVersion: typeof META_PROVIDER_READBACK_CONTRACT;
  classification: ReadbackClassification;
  /** True only for `confirmed`: the one state that may be called applied. */
  provesApplied: boolean;
  /** Rollback is refused whenever the landed state is unknown. */
  rollbackPermitted: boolean;
  rollbackRefusalWhy: string | null;
  mismatchedFields: PreflightProjectionField[];
  why: string;
}

/**
 * Classify a read-back WITHOUT trusting any mutation response.
 *
 * The inputs are: whether a write was actually dispatched, what transport
 * outcome it had, the projection we expected, and a *fresh independent read*.
 * There is no argument for the provider's own success payload, by design.
 */
export function classifyReadback(input: {
  attempt: MutationAttempt;
  expected: PreflightProjection;
  observed: PreflightAttemptOutcome;
  /** Server-owned. Without it a caller could confirm from an ancient read. */
  clock: PreflightClock;
}): ReadbackVerdict {
  const base = {
    contractVersion: META_PROVIDER_READBACK_CONTRACT,
    provesApplied: false,
    mismatchedFields: [] as PreflightProjectionField[],
  };

  // No write was sent. This is D085's only real state, and a subsequent GET —
  // however healthy — is preflight evidence, never write proof.
  if (!input.attempt.sent) {
    return {
      ...base,
      classification: "not_attempted",
      rollbackPermitted: false,
      rollbackRefusalWhy: "nothing was written, so there is nothing to roll back",
      why: `no provider mutation was dispatched: ${input.attempt.why}. A preflight or unchanged read cannot be relabelled as write success.`,
    };
  }

  // A write was sent but the state cannot be read: the landed state is
  // unknown, so this is ambiguous and rollback must be refused. Compensating
  // blind can double-apply a write that already succeeded.
  const comparison = comparePreflight(input.expected, input.observed, input.clock);

  // A read the CONTRACT rejected — stale, future-dated, unparseable, or
  // structurally incomplete — cannot distinguish "did not land" from "landed
  // and something else moved". It is ambiguous, never a mismatch and never
  // proof. The first pass returned `confirmed` here.
  if (input.observed.status === "succeeded" && comparison.rejections.length > 0) {
    return {
      ...base,
      classification: "ambiguous",
      rollbackPermitted: false,
      rollbackRefusalWhy:
        "the read that would have proved the landed state was itself rejected, so the state is unknown; freeze writes for this scope and re-read from a fresh session",
      why: `the provider read was rejected by the read-back contract (${comparison.rejections.join(", ")}): ${comparison.why}`,
    };
  }

  if (input.observed.status !== "succeeded") {
    return {
      ...base,
      classification: "ambiguous",
      rollbackPermitted: false,
      rollbackRefusalWhy:
        "the landed state is unknown; a compensating write could double-apply a mutation that already succeeded. Freeze writes for this scope and re-read from a fresh session before any recovery.",
      why: `a mutation was dispatched (transport: ${input.attempt.transport}) but the independent read did not succeed (${input.observed.status}), so whether it landed is unknown`,
    };
  }

  if (comparison.matchesBaseline) {
    return {
      ...base,
      classification: "confirmed",
      provesApplied: true,
      rollbackPermitted: true,
      rollbackRefusalWhy: null,
      why: "a fresh independent read reproduces the expected projection exactly on every field",
    };
  }

  // A transport failure plus a mismatch is still ambiguous: the write may have
  // landed partially, or another operator may have changed the entity.
  if (input.attempt.transport !== "completed") {
    return {
      ...base,
      classification: "ambiguous",
      mismatchedFields: comparison.driftedFields,
      rollbackPermitted: false,
      rollbackRefusalWhy:
        "the transport did not complete and the observed state differs from expected; the difference cannot be attributed to this write",
      why: `transport ${input.attempt.transport} with observed differences on ${comparison.driftedFields.join(", ")}`,
    };
  }

  return {
    ...base,
    classification: "definite_mismatch",
    mismatchedFields: comparison.driftedFields,
    rollbackPermitted: true,
    rollbackRefusalWhy: null,
    why: `the transport completed and a fresh independent read differs from expected on ${comparison.driftedFields.join(", ")}`,
  };
}

/** A stable fingerprint of the exact projection a future read-back must match. */
export function readbackFingerprint(projection: PreflightProjection): string {
  const canonical = PREFLIGHT_PROJECTION_FIELDS
    .map((f) => `${f}=${normalize(projectionValue(projection, f))}`)
    .join("|");
  return `${META_PROVIDER_READBACK_CONTRACT}:${createHash("sha256").update(canonical).digest("hex")}`;
}

/*
  CANONICAL KEY SETS — D085 Correction 8.

  Exported from the contract that OWNS each type, so the exact-schema layer
  cannot drift from the interface it is meant to describe. Each set is followed
  by a compile-time guard: adding or removing a field on the interface without
  updating the set is a type error, not a silently permissive schema.
*/
export const PREFLIGHT_PROJECTION_KEYS = [
  "providerAccountId", "entityGrain", "entityId", "parentCampaignId", "budgetField",
  "budgetMinorUnits", "ownerMode", "effectiveStatus", "scheduleStart", "scheduleEnd",
  "optimizationGoal",
] as const;
const _projectionKeyGuard: Record<keyof PreflightProjection, true> = {
  providerAccountId: true, entityGrain: true, entityId: true, parentCampaignId: true,
  budgetField: true, budgetMinorUnits: true, ownerMode: true, effectiveStatus: true,
  scheduleStart: true, scheduleEnd: true, optimizationGoal: true,
};
void _projectionKeyGuard;

export const PREFLIGHT_COMPARISON_KEYS = [
  "contractVersion", "outcome", "claimedStatus", "rejections", "ageSeconds", "fresh",
  "projectionComplete", "driftedFields", "driftDetail", "matchesBaseline", "why",
] as const;
const _comparisonKeyGuard: Record<keyof PreflightComparison, true> = {
  contractVersion: true, outcome: true, claimedStatus: true, rejections: true,
  ageSeconds: true, fresh: true, projectionComplete: true, driftedFields: true,
  driftDetail: true, matchesBaseline: true, why: true,
};
void _comparisonKeyGuard;

/** Exact keys per discriminated-union variant of a raw provider attempt. */
export const PREFLIGHT_ATTEMPT_VARIANTS = {
  not_attempted: { required: ["status", "why"] as readonly string[] },
  succeeded: { required: ["status", "observedAt", "projection"] as readonly string[] },
  failed: { required: ["status", "why", "retryable"] as readonly string[] },
  stale: { required: ["status", "why", "observedAt", "ageSeconds"] as readonly string[] },
} as const;

export const PREFLIGHT_DRIFT_DETAIL_KEYS = ["field", "baseline", "observed"] as const;
