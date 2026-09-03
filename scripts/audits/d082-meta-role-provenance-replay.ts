/**
 * D082 — real-DB, PIT-safe campaign-role provenance replay and historical
 * counterfactual.
 *
 * Read-only research. SELECT only, inside one REPEATABLE READ READ ONLY
 * transaction with a server-asserted read-only proof, a statement and lock
 * timeout, and a savepoint per optional read. No write of any kind, no
 * migration, no provider call, no scheduler or env mutation, no Meta action.
 *
 * Why this exists. D081 closed the vocabulary and currency blockers across all
 * 247,050 D080B proposals but resolved `role_authority_absent` for exactly 0,
 * because the frozen D080B snapshot retains neither `kind_source` nor
 * `resolver_version`: its `roleContext` read selects campaign, as-of date,
 * kind, confidence class and provider account only, does not filter the
 * physical account, and indexes rows by `campaign_id` alone. D082 does not
 * reinterpret that snapshot. It takes a fresh, provenance-complete,
 * account-scoped read and reports four lanes whose denominators never merge.
 *
 * `engine_v3_campaign_context_daily` is a mutable UPSERT target whose
 * `created_at` survives the conflict path and whose `updated_at` is rewritten
 * on every touch. That pair is the only recorded-time clock this table has, and
 * D082 treats it as binding rather than advisory.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  canonicalJson,
  sha256Canonical,
  D080_PINNED_BINDINGS,
  bindingKey,
  type PinnedBinding,
} from "@/scripts/audits/d080-meta-budget-edit-evidence";
import {
  analyse as analyseD080B,
  materialiseSnapshot as materialiseD080BSnapshot,
  addDays,
  daysBetween,
  isCalendarDate,
  type BudgetResearchProposal,
  type MaterialisedRead as D080BMaterialisedRead,
  type OriginPlan,
} from "@/scripts/audits/d080b-meta-budget-policy-simulation";

import {
  CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS,
  campaignFamilyKey,
  classifyCampaignContext,
  computeFamilyInheritance,
  DEFAULT_CONTEXT_CONFIG,
  FEATURE_WINDOW_DAYS,
  type CampaignKind,
  type ContextConfidenceClass,
  type ContextResolution,
} from "@/lib/creative-decision-engine/campaign-context/resolver";
import {
  CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
  classifyCampaignContextV3,
  RETIRED_CAMPAIGN_CONTEXT_RESOLVER_V3_VERSIONS,
} from "@/lib/creative-decision-engine/campaign-context/resolver-v3";
import {
  buildCampaignContextFeatures,
  computeCampaignLineage,
  type CampaignMetaRow,
  type CreativeDayRow,
} from "@/lib/creative-decision-engine/campaign-context/data";
import {
  applyDailyHysteresis,
  type HysteresisState,
} from "@/lib/creative-decision-engine/jobs/campaign-context-job";
import {
  CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV,
  CAMPAIGN_CONTEXT_MAX_AGE_DAYS,
  isCampaignContextResolverAuthorityValidated,
} from "@/lib/creative-decision-engine/campaign-context/source";
import { evaluateAccountScopedRoleAuthority } from "@/lib/meta/campaign-role-authority";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const D082_CONTRACT_ID = "adsecute.meta.d082-role-provenance-replay.v1" as const;
export const D082_JSON_OUT =
  "docs/audits/generated/d082-meta-role-provenance-replay-2026-09-01.json";

/** Refuse to run on drift of any pinned predecessor. */
export const D082_PINNED_INPUTS = {
  d080aArtifactPath: "docs/audits/generated/d080-meta-budget-edit-evidence-2026-08-31.json",
  d080aArtifactSha256: "d4a1898aba14bcb2a37ae60a335f207eb668df13d37619bdffb44330da4d7a69",
  d080bArtifactPath: "docs/audits/generated/d080b-meta-budget-policy-simulation-2026-09-01.json",
  d080bArtifactSha256: "b46e6aa80c75aec0ebc724f2b8fcc288cda611353e9924a85504d3e498d155df",
  d081ArtifactPath: "docs/audits/generated/d081-meta-budget-capability-foundations-2026-09-01.json",
  d081ArtifactSha256: "5514023bbad12923651b1a59810bf1ce2684f4361cac8bfcb0148033bbb402b3",
  h11bBundlePath:
    "docs/creative-decision-center/generated/h11b-context-lifecycle-bundle-2026-07-13-to-2026-08-22.json",
  h11bBundleSha256: "f27f6cbe6437c2c8ecd3dff93ea24f9d91356403057d5253a17abc30b91cf13f",
  h11bEvalArtifactPath: "docs/creative-decision-center/generated/h11b-context-lifecycle-eval.json",
  h11bEvalArtifactSha256: "a99bd6c7cc0a11f57b48408ddfa6c7cab45ea505cfe58ec28842af2bc7ab4585",
} as const;

/**
 * Five truth lanes. They are reported side by side and their denominators are
 * never added together. `legacy_identity_join_research_only` is deliberately
 * not a sub-case of `strict_pit_authority`: a null-account row can never be
 * runtime authority, so it may never enter that lane's numerator.
 */
export const D082_LANES = [
  "actual_current_runtime_authority",
  "strict_pit_authority",
  "legacy_identity_join_research_only",
  "retrospective_finalized_conditional",
  "locked_accuracy_diagnostics",
] as const;
export type D082Lane = (typeof D082_LANES)[number];

export const D082_TRUTH_LABELS = [
  "verified_fact",
  "counterfactual_recompute",
  "research_only",
  "unknown",
] as const;

export const STATEMENT_TIMEOUT_MS = 30_000;
export const LOCK_TIMEOUT_MS = 5_000;

/** Same guard list D080B refuses on. This audit never sets or clears a flag. */
export const D082_FORBIDDEN_TRUTHY_FLAGS = [
  "ENABLE_RUNTIME_MIGRATIONS",
  "ENABLE_META_WRITES",
  "ENABLE_AUTOMATION",
  "META_AUTOMATION_ENABLED",
  "ENABLE_PROVIDER_WRITES",
  "ALLOW_LIVE_MUTATION",
] as const;

/**
 * Lane C runs the resolver every calendar day, because `applyDailyHysteresis`
 * is a per-day causal chain and origins are weekly. State is warmed up for this
 * many days before the first scored origin so the first scored day does not
 * inherit an empty chain.
 */
export const LANE_C_WARMUP_DAYS = 14;
/** Lineage window the production job uses. */
export const SOURCE_WINDOW_DAYS = 56;

/** The exact table under audit. */
export const ROLE_TABLE = "engine_v3_campaign_context_daily";

/** Byte-exact source authority. No trim, no case fold, no default. */
export const REQUIRED_KIND_SOURCE = "system_inferred";
export const REQUIRED_CONFIDENCE_CLASS = "high";

// ---------------------------------------------------------------------------
// Small helpers. `rawText` is deliberately not `text()`: authority comparisons
// here are byte-for-byte, so trimming would let a padded value buy authority.
// ---------------------------------------------------------------------------

export function rawText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function trimmedText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value === null || value === undefined) return null;
  return String(value);
}

export function dateOnly(value: unknown): string | null {
  const raw = trimmedText(value);
  if (!raw) return null;
  const head = raw.slice(0, 10);
  return isCalendarDate(head) ? head : null;
}

/**
 * Milliseconds since epoch for a Postgres `timestamptz::text`, or null.
 *
 * Postgres renders `2026-07-06 02:00:00+00`, which is not ISO-8601 twice over:
 * the date and time are separated by a space, and the zone offset is rendered
 * with hours only. `Date.parse` returns NaN for both, so a naive parse silently
 * turns every clock into null and every point-in-time gate into "unknowable".
 */
export function instantMs(value: unknown): number | null {
  // String only: every clock is read through an explicit ::text cast, and
  // coercing a non-string here would manufacture a clock out of a number.
  const raw = rawText(value)?.trim() || null;
  if (!raw) return null;
  let iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  if (/[+-]\d{2}$/.test(iso)) iso = `${iso}:00`;
  else if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso = `${iso}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Start of the origin day, UTC. The knowledge cutoff for that origin. */
export function originCutoffMs(origin: string): number {
  return Date.parse(`${origin}T00:00:00.000Z`);
}

export function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// The read plan. Every statement is SELECT-only and every account-bearing
// source is filtered to the pinned physical account.
// ---------------------------------------------------------------------------

export const D082_QUERIES = {
  /** Schema census for the table under audit: proves the columns exist. */
  roleSchemaCensus: `
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'engine_v3_campaign_context_daily'
     ORDER BY column_name`,

  /**
   * The corrected role read. Account-scoped, provenance-complete, and carrying
   * both clocks so a historical origin can tell a never-rewritten row from one
   * whose earlier value was overwritten.
   */
  roleProvenanceAccountScoped: `
    SELECT id::text AS source_record_id,
           business_id::text AS business_id,
           provider_account_id,
           campaign_id,
           as_of_date::text AS as_of_date,
           inferred_kind,
           confidence_score,
           confidence_class,
           kind_source,
           kind_basis,
           resolver_version,
           created_at::text AS created_at,
           updated_at::text AS updated_at,
           job_run_id::text AS job_run_id
      FROM engine_v3_campaign_context_daily
     WHERE business_id = $1::text
       AND provider_account_id = $2::text
       AND as_of_date >= $3::date AND as_of_date <= $4::date
     ORDER BY campaign_id, as_of_date, source_record_id`,

  /**
   * Legacy rows with no physical account. Research lane only: the partial
   * unique index does not cover them, the producer's ON CONFLICT cannot touch
   * them, and the migration deliberately did not backfill them.
   */
  roleProvenanceLegacyNullAccount: `
    SELECT id::text AS source_record_id,
           business_id::text AS business_id,
           campaign_id,
           as_of_date::text AS as_of_date,
           inferred_kind,
           confidence_score,
           confidence_class,
           kind_source,
           kind_basis,
           resolver_version,
           created_at::text AS created_at,
           updated_at::text AS updated_at,
           job_run_id::text AS job_run_id
      FROM engine_v3_campaign_context_daily
     WHERE business_id = $1::text
       AND provider_account_id IS NULL
       AND as_of_date >= $2::date AND as_of_date <= $3::date
     ORDER BY campaign_id, as_of_date, source_record_id`,

  /** Whole-table census for the business, so the window is not mistaken for all. */
  roleCensus: `
    SELECT resolver_version,
           kind_source,
           confidence_class,
           (provider_account_id IS NULL) AS account_is_null,
           count(*)::bigint AS rows,
           min(as_of_date)::text AS earliest_as_of,
           max(as_of_date)::text AS latest_as_of
      FROM engine_v3_campaign_context_daily
     WHERE business_id = $1::text
     GROUP BY resolver_version, kind_source, confidence_class, (provider_account_id IS NULL)
     ORDER BY resolver_version, kind_source, confidence_class, account_is_null`,

  /**
   * Observed campaign identity, for resolving a legacy null-account row to one
   * physical account. Bounded by date so a later observation cannot be used at
   * an earlier origin.
   */
  campaignIdentityObservations: `
    SELECT campaign_id,
           provider_account_id,
           min(date)::text AS first_observed_on,
           max(date)::text AS last_observed_on
      FROM meta_campaign_daily
     WHERE (business_ref_id::text = $1 OR business_id = $1)
       AND date <= $2::date
     GROUP BY campaign_id, provider_account_id
     ORDER BY campaign_id, provider_account_id`,

  /**
   * Lane C feature input. This is the production reader's statement from
   * `readCampaignContextCreativeDays`, narrowed to one physical account and
   * carrying the two warehouse clocks so their reliability can be measured
   * rather than assumed.
   */
  laneCCreativeDays: `
    SELECT provider_account_id,
           campaign_id,
           adset_id,
           creative_id,
           date::text AS date,
           spend
      FROM meta_creative_daily
     WHERE (business_ref_id::text = $1 OR business_id = $1)
       AND provider_account_id = $4::text
       AND spend > 0
       AND campaign_id IS NOT NULL
       AND date BETWEEN $2::date AND $3::date
     ORDER BY campaign_id, date, creative_id`,

  /**
   * The other half of the production reader: first spend per creative over all
   * history at or before the ceiling. Split out because the correlated CTE and
   * the window scan together exceed the client read ceiling on the largest
   * account; joined back in memory on exactly the production key
   * (provider_account_id, creative_id).
   */
  laneCCreativeFirstSpend: `
    SELECT provider_account_id,
           creative_id,
           MIN(date)::text AS first_spend_date
      FROM meta_creative_daily
     WHERE (business_ref_id::text = $1 OR business_id = $1)
       AND provider_account_id = $3::text
       AND spend > 0
       AND date <= $2::date
     GROUP BY provider_account_id, creative_id
     ORDER BY creative_id`,

  /**
   * Lane C campaign meta input. The production reader collapses this to the
   * latest name at or before a ceiling plus a first-seen date; keeping the
   * per-day rows lets every origin rebuild its own ceiling without a re-read.
   */
  laneCCampaignNameDays: `
    WITH d AS (
      SELECT campaign_id,
             date,
             COALESCE(campaign_name_current, campaign_name_historical) AS campaign_name,
             LAG(COALESCE(campaign_name_current, campaign_name_historical))
               OVER (PARTITION BY campaign_id ORDER BY date) AS prev_name,
             ROW_NUMBER() OVER (PARTITION BY campaign_id ORDER BY date) AS rn
        FROM meta_campaign_daily
       WHERE (business_ref_id::text = $1 OR business_id = $1)
         AND provider_account_id = $4::text
         AND date >= $2::date
         AND date <= $3::date
    )
    SELECT campaign_id, date::text AS date, campaign_name
      FROM d
     WHERE rn = 1 OR prev_name IS DISTINCT FROM campaign_name
     ORDER BY campaign_id, date`,

  /**
   * First-seen is a MIN over all history at or before the ceiling, not over the
   * read window, so it needs its own unbounded-below read.
   */
  laneCCampaignFirstSeen: `
    SELECT provider_account_id,
           campaign_id,
           min(date)::text AS first_seen_date
      FROM meta_campaign_daily
     WHERE (business_ref_id::text = $1 OR business_id = $1)
       AND provider_account_id = $3::text
       AND date <= $2::date
     GROUP BY provider_account_id, campaign_id
     ORDER BY campaign_id`,

  /**
   * Whether the warehouse clock can carry a strict knowledge bound at all.
   * `meta_creative_daily` has no `finalized_at` and no `truth_state`, so this
   * measures what `created_at`/`updated_at` actually look like.
   */
  laneCClockCensus: `
    SELECT count(*)::bigint AS rows,
           count(*) FILTER (WHERE created_at::date < date)::bigint AS created_before_its_own_date,
           count(*) FILTER (WHERE updated_at > created_at)::bigint AS rewritten_rows,
           min(created_at)::text AS earliest_created_at,
           max(created_at)::text AS latest_created_at,
           min(updated_at)::text AS earliest_updated_at,
           max(updated_at)::text AS latest_updated_at
      FROM meta_creative_daily
     WHERE (business_ref_id::text = $1 OR business_id = $1)
       AND provider_account_id = $4::text
       AND spend > 0
       AND date BETWEEN $2::date AND $3::date`,
} as const;

export const D082_QUERY_CONTRACT_SHA256 = sha256Canonical(D082_QUERIES);

// ---------------------------------------------------------------------------
// Request envelope and ledger
// ---------------------------------------------------------------------------

export interface D082Request {
  invocationKey: string;
  planKey: string;
  statement: string;
  params: unknown[];
  statementSha256: string;
  paramsSha256: string;
  businessId: string | null;
  providerAccountId: string | null;
  source: string;
  lane: D082Lane | "provenance";
  knowledgeTo: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface D082LedgerEntry {
  invocationKey: string;
  planKey: string;
  businessId: string | null;
  providerAccountId: string | null;
  source: string;
  lane: string;
  statementSha256: string | null;
  paramsSha256: string | null;
  knowledgeTo: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  disposition: "execute" | "dependency_skip";
  status: string;
  rows: number | null;
  sourceRowHash: string | null;
  reason: string | null;
}

export interface D082MaterialisedRead {
  invocationKey: string;
  planKey: string;
  businessId: string | null;
  providerAccountId: string | null;
  source: string;
  lane: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  knowledgeTo: string | null;
  rows: Row[];
}

function normaliseParams(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

export function buildRequest(input: {
  planKey: string;
  statement: string;
  params: unknown[];
  source: string;
  lane: D082Lane | "provenance";
  businessId?: string | null;
  providerAccountId?: string | null;
  knowledgeTo?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}): D082Request {
  const params = normaliseParams(input.params);
  const scope = input.providerAccountId
    ? `${input.businessId}|${input.providerAccountId}`
    : input.businessId ?? "global";
  return {
    invocationKey: `${input.planKey}:${input.source}#${scope}`,
    planKey: input.planKey,
    statement: input.statement,
    params,
    statementSha256: createHash("sha256").update(input.statement).digest("hex"),
    paramsSha256: sha256Canonical(params),
    businessId: input.businessId ?? null,
    providerAccountId: input.providerAccountId ?? null,
    source: input.source,
    lane: input.lane,
    knowledgeTo: input.knowledgeTo ?? null,
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveTo: input.effectiveTo ?? null,
  };
}

const PINNED_BUSINESS_SET = new Set(D080_PINNED_BINDINGS.map((b) => b.businessId));
const PINNED_BINDING_SET = new Set(
  D080_PINNED_BINDINGS.map((b) => bindingKey(b.businessId, b.providerAccountId)),
);

/** Statements that are allowed to reach the database at all. */
const ALLOWED_STATEMENTS = new Set<string>(Object.values(D082_QUERIES));

const MUTATION_TOKEN = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|VACUUM|REFRESH|CALL|DO)\b/i;

export function assertRequestIsInScope(request: D082Request): void {
  const refuse = (why: string): never => {
    throw new Error(`D082 refuses this read: ${why} (${request.invocationKey})`);
  };
  if (!ALLOWED_STATEMENTS.has(request.statement)) {
    refuse("statement is not a member of the pinned query contract");
  }
  if (MUTATION_TOKEN.test(request.statement)) {
    refuse("statement contains a mutation keyword");
  }
  if (createHash("sha256").update(request.statement).digest("hex") !== request.statementSha256) {
    refuse("statement hash does not match the statement");
  }
  if (sha256Canonical(request.params) !== request.paramsSha256) {
    refuse("params hash does not match the params");
  }
  if (request.businessId && !PINNED_BUSINESS_SET.has(request.businessId)) {
    refuse("business is not one of the six charter businesses");
  }
  if (
    request.businessId &&
    request.providerAccountId &&
    !PINNED_BINDING_SET.has(bindingKey(request.businessId, request.providerAccountId))
  ) {
    refuse("business/account pair is not a pinned binding");
  }
  for (const [label, value] of [
    ["effectiveFrom", request.effectiveFrom],
    ["effectiveTo", request.effectiveTo],
    ["knowledgeTo", request.knowledgeTo],
  ] as const) {
    if (value !== null && !isCalendarDate(value)) refuse(`${label} is not a calendar date`);
  }
  if (
    request.effectiveFrom &&
    request.effectiveTo &&
    request.effectiveFrom > request.effectiveTo
  ) {
    refuse("window runs backwards");
  }
}

export type SafeQ = (request: D082Request) => Promise<Row[]>;

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

export interface CollectedEvidence {
  proof: Row;
  ledger: D082LedgerEntry[];
  reads: D082MaterialisedRead[];
}

/** The distinct businesses behind the seven bindings (TheSwaf has two). */
export const D082_BUSINESSES: Array<{ business: string; businessId: string }> = [
  ...new Map(
    D080_PINNED_BINDINGS.map((b) => [b.businessId, { business: b.business, businessId: b.businessId }]),
  ).values(),
].sort((a, b) => a.businessId.localeCompare(b.businessId));

export interface D082Window {
  origins: string[];
  firstOrigin: string;
  lastOrigin: string;
  roleFrom: string;
  roleTo: string;
  laneCFrom: string;
  laneCTo: string;
  laneCFirstScoredDay: string;
  laneCLastScoredDay: string;
}

/**
 * The whole window is derived from the pinned D080B origins, never declared
 * independently, so D082 cannot drift off D080B's axis.
 */
export function planWindow(origins: readonly OriginPlan[]): D082Window {
  const dates = origins.map((o) => o.origin).sort();
  const firstOrigin = dates[0]!;
  const lastOrigin = dates[dates.length - 1]!;
  const laneCFirstScoredDay = addDays(firstOrigin, -LANE_C_WARMUP_DAYS);
  return {
    origins: dates,
    firstOrigin,
    lastOrigin,
    // Role rows: far enough back that the freshness rule has something to see
    // at the first origin, and no further.
    roleFrom: addDays(firstOrigin, -(CAMPAIGN_CONTEXT_MAX_AGE_DAYS + 7)),
    roleTo: lastOrigin,
    // Lane C: the lineage window before the first warmed-up day.
    laneCFrom: addDays(laneCFirstScoredDay, -(SOURCE_WINDOW_DAYS - 1)),
    laneCTo: lastOrigin,
    laneCFirstScoredDay,
    // The score for origin O is taken from the day before it, so the last day
    // the chain needs to advance through is the day before the last origin.
    laneCLastScoredDay: addDays(lastOrigin, -1),
  };
}

export async function collectEvidence(deps: {
  proof: Row;
  safeQ: SafeQ;
  window: D082Window;
  ledger: D082LedgerEntry[];
  reads: D082MaterialisedRead[];
}): Promise<CollectedEvidence> {
  const { safeQ, window } = deps;

  await safeQ(
    buildRequest({
      planKey: "roleSchemaCensus",
      statement: D082_QUERIES.roleSchemaCensus,
      params: [],
      source: "information_schema.columns",
      lane: "provenance",
    }),
  );

  for (const business of D082_BUSINESSES) {
    await safeQ(
      buildRequest({
        planKey: "roleCensus",
        statement: D082_QUERIES.roleCensus,
        params: [business.businessId],
        source: ROLE_TABLE,
        lane: "provenance",
        businessId: business.businessId,
      }),
    );
    await safeQ(
      buildRequest({
        planKey: "roleProvenanceLegacyNullAccount",
        statement: D082_QUERIES.roleProvenanceLegacyNullAccount,
        params: [business.businessId, window.roleFrom, window.roleTo],
        source: ROLE_TABLE,
        lane: "legacy_identity_join_research_only",
        businessId: business.businessId,
        effectiveFrom: window.roleFrom,
        effectiveTo: window.roleTo,
      }),
    );
  }

  for (const binding of D080_PINNED_BINDINGS) {
    const scope = {
      businessId: binding.businessId,
      providerAccountId: binding.providerAccountId,
    };

    await safeQ(
      buildRequest({
        planKey: "roleProvenanceAccountScoped",
        statement: D082_QUERIES.roleProvenanceAccountScoped,
        params: [binding.businessId, binding.providerAccountId, window.roleFrom, window.roleTo],
        source: ROLE_TABLE,
        lane: "strict_pit_authority",
        ...scope,
        effectiveFrom: window.roleFrom,
        effectiveTo: window.roleTo,
      }),
    );

    await safeQ(
      buildRequest({
        planKey: "campaignIdentityObservations",
        statement: D082_QUERIES.campaignIdentityObservations,
        params: [binding.businessId, window.lastOrigin],
        source: "meta_campaign_daily",
        lane: "legacy_identity_join_research_only",
        businessId: binding.businessId,
        knowledgeTo: window.lastOrigin,
      }),
    );

    await safeQ(
      buildRequest({
        planKey: "laneCCreativeDays",
        statement: D082_QUERIES.laneCCreativeDays,
        params: [binding.businessId, window.laneCFrom, window.laneCTo, binding.providerAccountId],
        source: "meta_creative_daily",
        lane: "retrospective_finalized_conditional",
        ...scope,
        effectiveFrom: window.laneCFrom,
        effectiveTo: window.laneCTo,
      }),
    );

    await safeQ(
      buildRequest({
        planKey: "laneCCreativeFirstSpend",
        statement: D082_QUERIES.laneCCreativeFirstSpend,
        params: [binding.businessId, window.laneCTo, binding.providerAccountId],
        source: "meta_creative_daily",
        lane: "retrospective_finalized_conditional",
        ...scope,
        knowledgeTo: window.laneCTo,
      }),
    );

    await safeQ(
      buildRequest({
        planKey: "laneCCampaignNameDays",
        statement: D082_QUERIES.laneCCampaignNameDays,
        params: [binding.businessId, window.laneCFrom, window.laneCTo, binding.providerAccountId],
        source: "meta_campaign_daily",
        lane: "retrospective_finalized_conditional",
        ...scope,
        effectiveFrom: window.laneCFrom,
        effectiveTo: window.laneCTo,
      }),
    );

    await safeQ(
      buildRequest({
        planKey: "laneCCampaignFirstSeen",
        statement: D082_QUERIES.laneCCampaignFirstSeen,
        params: [binding.businessId, window.laneCTo, binding.providerAccountId],
        source: "meta_campaign_daily",
        lane: "retrospective_finalized_conditional",
        ...scope,
        knowledgeTo: window.laneCTo,
      }),
    );

    await safeQ(
      buildRequest({
        planKey: "laneCClockCensus",
        statement: D082_QUERIES.laneCClockCensus,
        params: [binding.businessId, window.laneCFrom, window.laneCTo, binding.providerAccountId],
        source: "meta_creative_daily",
        lane: "retrospective_finalized_conditional",
        ...scope,
        effectiveFrom: window.laneCFrom,
        effectiveTo: window.laneCTo,
      }),
    );
  }

  return { proof: deps.proof, ledger: deps.ledger, reads: deps.reads };
}

/** Group the frozen reads by plan key, preserving executed order. */
export function materialiseSnapshot(
  reads: readonly D082MaterialisedRead[],
): Record<string, D082MaterialisedRead[]> {
  const out: Record<string, D082MaterialisedRead[]> = {};
  for (const read of reads) {
    (out[read.planKey] ??= []).push(read);
  }
  return out;
}

export function snapshotBodyOf(reads: readonly D082MaterialisedRead[]): unknown {
  return reads.map((r) => ({
    invocationKey: r.invocationKey,
    planKey: r.planKey,
    businessId: r.businessId,
    providerAccountId: r.providerAccountId,
    source: r.source,
    lane: r.lane,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    knowledgeTo: r.knowledgeTo,
    rows: r.rows,
  }));
}

// ---------------------------------------------------------------------------
// Shared role-row shape and the two validators
// ---------------------------------------------------------------------------

export interface RoleRow {
  sourceRecordId: string | null;
  businessId: string | null;
  providerAccountId: string | null;
  campaignId: string | null;
  asOfDate: string | null;
  inferredKind: string | null;
  confidenceClass: string | null;
  /** Raw, never trimmed: authority here is byte-for-byte. */
  kindSource: string | null;
  resolverVersion: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  jobRunId: string | null;
}

export function toRoleRow(row: Row, fallbackAccount: string | null): RoleRow {
  return {
    sourceRecordId: trimmedText(row.source_record_id),
    businessId: trimmedText(row.business_id),
    providerAccountId: rawText(row.provider_account_id) ?? fallbackAccount,
    campaignId: trimmedText(row.campaign_id),
    asOfDate: dateOnly(row.as_of_date),
    inferredKind: rawText(row.inferred_kind),
    confidenceClass: rawText(row.confidence_class),
    kindSource: rawText(row.kind_source),
    resolverVersion: rawText(row.resolver_version),
    createdAtMs: instantMs(row.created_at),
    updatedAtMs: instantMs(row.updated_at),
    jobRunId: trimmedText(row.job_run_id),
  };
}

/** The real runtime validator: reads the env gate, which stays UNSET. */
export const RUNTIME_VALIDATOR = (v: string | null | undefined) =>
  isCampaignContextResolverAuthorityValidated(v);

/**
 * The explicit local what-if: "if this exact compiled identity were operator
 * approved". It never reads or writes the env, and it is only ever applied to
 * lanes that are labelled counterfactual.
 */
export const WHAT_IF_VALIDATOR = (v: string | null | undefined) =>
  v === CAMPAIGN_CONTEXT_RESOLVER_VERSION;

/** The canonical rule, with an explicit validator. Never re-implemented here. */
export function satisfiesRoleAuthority(
  row: Pick<RoleRow, "inferredKind" | "kindSource" | "confidenceClass" | "resolverVersion">,
  validator: (v: string | null | undefined) => boolean,
): { ok: boolean; blocker: string | null } {
  const verdict = evaluateAccountScopedRoleAuthority({
    kind: row.inferredKind,
    source: row.kindSource,
    confidenceClass: row.confidenceClass,
    resolverVersion: row.resolverVersion,
    isResolverVersionValidated: validator,
  });
  return { ok: verdict.satisfiesRoleAuthority, blocker: verdict.blocker };
}

/**
 * The runtime reader's own selection: newest as-of at or before the reference
 * day, inside the freshness window, one row per campaign.
 */
export function selectRuntimeRow(
  rows: readonly RoleRow[],
  asOf: string,
  maxAgeDays = CAMPAIGN_CONTEXT_MAX_AGE_DAYS,
): RoleRow | null {
  const floor = addDays(asOf, -maxAgeDays);
  const eligible = rows
    .filter((r) => r.asOfDate !== null && r.asOfDate <= asOf && r.asOfDate >= floor)
    .sort((a, b) => (a.asOfDate! < b.asOfDate! ? 1 : a.asOfDate! > b.asOfDate! ? -1 : 0));
  return eligible[0] ?? null;
}

/** Composite scope key. Business AND physical account AND campaign, always. */
export function scopeKey(
  businessId: string,
  providerAccountId: string,
  campaignId: string,
): string {
  return [businessId, providerAccountId, campaignId].join("|");
}

export function scopeOriginKey(
  businessId: string,
  providerAccountId: string,
  campaignId: string,
  origin: string,
): string {
  return [businessId, providerAccountId, campaignId, origin].join("|");
}

function roleRowsByBinding(
  snapshot: Record<string, D082MaterialisedRead[]>,
): Map<string, RoleRow[]> {
  const out = new Map<string, RoleRow[]>();
  for (const read of snapshot.roleProvenanceAccountScoped ?? []) {
    const key = bindingKey(read.businessId ?? "", read.providerAccountId ?? "");
    const rows = read.rows.map((r) => toRoleRow(r, read.providerAccountId));
    out.set(key, [...(out.get(key) ?? []), ...rows]);
  }
  return out;
}

function campaignIndex(rows: readonly RoleRow[]): Map<string, RoleRow[]> {
  const out = new Map<string, RoleRow[]>();
  for (const r of rows) {
    if (!r.campaignId) continue;
    const list = out.get(r.campaignId) ?? [];
    list.push(r);
    out.set(r.campaignId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lane A — actual current runtime authority
// ---------------------------------------------------------------------------

export interface LaneAResult {
  lane: "actual_current_runtime_authority";
  truth: "verified_fact";
  envGate: {
    variable: string;
    set: boolean;
    approvedIdentityResolves: boolean;
    compiledIdentity: string;
    effect: string;
  };
  rowsRead: number;
  accountScopedRows: number;
  authoritative: number;
  authoritativeScopes: string[];
  byOrigin: Row[];
  perBinding: Row[];
  /**
   * Rows whose stored provenance matches the compiled identity byte-for-byte
   * and which would satisfy the rule IF an operator had approved that identity.
   * Reported so the reader can see the shape of the data; never authority
   * while the gate is closed.
   */
  technicallyShapedButGateClosed: number;
  firstBlockerCensus: Record<string, number>;
}

export function computeLaneA(
  snapshot: Record<string, D082MaterialisedRead[]>,
  window: D082Window,
): LaneAResult {
  const byBinding = roleRowsByBinding(snapshot);
  const envValue = process.env[CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV];
  const gateSet = typeof envValue === "string" && envValue.trim().length > 0;
  const approvedResolves = RUNTIME_VALIDATOR(CAMPAIGN_CONTEXT_RESOLVER_VERSION);

  const byOrigin: Row[] = [];
  const perBinding: Row[] = [];
  const authoritativeScopes: string[] = [];
  const blockers: string[] = [];
  let rowsRead = 0;
  let accountScopedRows = 0;
  let authoritative = 0;
  let technicallyShaped = 0;

  const perOriginTotals = new Map<string, { evaluated: number; authoritative: number }>();

  for (const binding of D080_PINNED_BINDINGS) {
    const rows = byBinding.get(bindingKey(binding.businessId, binding.providerAccountId)) ?? [];
    rowsRead += rows.length;
    accountScopedRows += rows.filter((r) => r.providerAccountId !== null).length;
    const byCampaign = campaignIndex(rows);

    let bindingAuthoritative = 0;
    let bindingEvaluated = 0;
    let bindingShaped = 0;

    for (const origin of window.origins) {
      const totals = perOriginTotals.get(origin) ?? { evaluated: 0, authoritative: 0 };
      for (const [campaignId, campaignRows] of byCampaign) {
        const selected = selectRuntimeRow(campaignRows, origin);
        if (!selected) continue;
        bindingEvaluated += 1;
        totals.evaluated += 1;
        const runtime = satisfiesRoleAuthority(selected, RUNTIME_VALIDATOR);
        const whatIf = satisfiesRoleAuthority(selected, WHAT_IF_VALIDATOR);
        if (whatIf.ok) bindingShaped += 1;
        if (runtime.ok) {
          bindingAuthoritative += 1;
          totals.authoritative += 1;
          authoritativeScopes.push(
            scopeOriginKey(binding.businessId, binding.providerAccountId, campaignId, origin),
          );
        } else {
          blockers.push(runtime.blocker ?? "unknown_blocker");
        }
      }
      perOriginTotals.set(origin, totals);
    }

    authoritative += bindingAuthoritative;
    technicallyShaped += bindingShaped;
    perBinding.push({
      business: binding.business,
      businessId: binding.businessId,
      providerAccountId: binding.providerAccountId,
      accountSelected: binding.isSelected,
      rowsRead: rows.length,
      accountScopedRows: rows.filter((r) => r.providerAccountId !== null).length,
      distinctCampaigns: byCampaign.size,
      campaignOriginsEvaluated: bindingEvaluated,
      authoritative: bindingAuthoritative,
      technicallyShapedButGateClosed: bindingShaped,
    });
  }

  for (const origin of window.origins) {
    const totals = perOriginTotals.get(origin) ?? { evaluated: 0, authoritative: 0 };
    byOrigin.push({ origin, evaluated: totals.evaluated, authoritative: totals.authoritative });
  }

  return {
    lane: "actual_current_runtime_authority",
    truth: "verified_fact",
    envGate: {
      variable: CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV,
      set: gateSet,
      approvedIdentityResolves: approvedResolves,
      compiledIdentity: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      effect: approvedResolves
        ? "an operator has approved the compiled identity; resolver authority can be granted"
        : "no approved identity resolves, so the canonical rule denies resolver authority to every row regardless of its stored provenance",
    },
    rowsRead,
    accountScopedRows,
    authoritative,
    authoritativeScopes: sortedUnique(authoritativeScopes),
    byOrigin,
    perBinding,
    technicallyShapedButGateClosed: technicallyShaped,
    firstBlockerCensus: tally(blockers),
  };
}

// ---------------------------------------------------------------------------
// Lane B — strict historical retained-row PIT
// ---------------------------------------------------------------------------

export const LANE_B_EXCLUSIONS = [
  "as_of_on_or_after_origin",
  "created_after_origin",
  "mutable_prior_version_unreconstructible",
  "outside_freshness_window",
  "provenance_not_exact",
] as const;

export interface LaneBResult {
  lane: "strict_pit_authority";
  truth: "verified_fact";
  knowledgeCutoffRule: string;
  rowsConsidered: number;
  resolvedScopeOrigins: number;
  resolvedScopeOriginKeys: string[];
  exclusionCensus: Record<string, number>;
  byOrigin: Row[];
  perBinding: Row[];
  mutablePriorVersionUnreconstructible: number;
}

/**
 * One retained row is historically knowable at an origin only if its effective
 * day is strictly before the origin, both of its clocks are at or before the
 * origin's start, its provenance is exact and its scope is exact. A row whose
 * `updated_at` is later than the origin was rewritten after the fact: the value
 * it held at the origin is gone and is never inferred.
 */
export function computeLaneB(
  snapshot: Record<string, D082MaterialisedRead[]>,
  window: D082Window,
): LaneBResult {
  const byBinding = roleRowsByBinding(snapshot);
  const exclusions: string[] = [];
  const resolvedKeys: string[] = [];
  const byOrigin: Row[] = [];
  const perBinding: Row[] = [];
  let rowsConsidered = 0;
  let unreconstructible = 0;

  const perOrigin = new Map<string, number>();

  for (const binding of D080_PINNED_BINDINGS) {
    const rows = byBinding.get(bindingKey(binding.businessId, binding.providerAccountId)) ?? [];
    rowsConsidered += rows.length;
    const byCampaign = campaignIndex(rows);
    let bindingResolved = 0;
    let bindingUnreconstructible = 0;

    for (const origin of window.origins) {
      const cutoff = originCutoffMs(origin);
      const floor = addDays(origin, -CAMPAIGN_CONTEXT_MAX_AGE_DAYS);
      for (const [campaignId, campaignRows] of byCampaign) {
        // Strictly before the origin: an origin-day fact is not knowable at
        // the moment the origin opens.
        const candidates = campaignRows
          .filter((r) => r.asOfDate !== null && r.asOfDate < origin)
          .sort((a, b) => (a.asOfDate! < b.asOfDate! ? 1 : a.asOfDate! > b.asOfDate! ? -1 : 0));
        if (candidates.length === 0) continue;

        const freshest = candidates[0]!;
        if (freshest.asOfDate! < floor) {
          exclusions.push("outside_freshness_window");
          continue;
        }
        if (freshest.createdAtMs === null || freshest.createdAtMs > cutoff) {
          exclusions.push("created_after_origin");
          continue;
        }
        if (freshest.updatedAtMs === null || freshest.updatedAtMs > cutoff) {
          exclusions.push("mutable_prior_version_unreconstructible");
          bindingUnreconstructible += 1;
          unreconstructible += 1;
          continue;
        }
        const verdict = satisfiesRoleAuthority(freshest, WHAT_IF_VALIDATOR);
        if (!verdict.ok) {
          exclusions.push("provenance_not_exact");
          continue;
        }
        bindingResolved += 1;
        perOrigin.set(origin, (perOrigin.get(origin) ?? 0) + 1);
        resolvedKeys.push(
          scopeOriginKey(binding.businessId, binding.providerAccountId, campaignId, origin),
        );
      }
    }

    perBinding.push({
      business: binding.business,
      businessId: binding.businessId,
      providerAccountId: binding.providerAccountId,
      accountSelected: binding.isSelected,
      rowsConsidered: rows.length,
      resolvedScopeOrigins: bindingResolved,
      mutablePriorVersionUnreconstructible: bindingUnreconstructible,
    });
  }

  for (const origin of window.origins) {
    byOrigin.push({ origin, resolved: perOrigin.get(origin) ?? 0 });
  }

  return {
    lane: "strict_pit_authority",
    truth: "verified_fact",
    knowledgeCutoffRule:
      "as_of_date < origin AND created_at <= origin start AND updated_at <= origin start AND exact source/class/identity AND exact business+account+campaign scope AND inside the existing freshness window",
    rowsConsidered,
    resolvedScopeOrigins: resolvedKeys.length,
    resolvedScopeOriginKeys: sortedUnique(resolvedKeys),
    exclusionCensus: tally(exclusions),
    byOrigin,
    perBinding,
    mutablePriorVersionUnreconstructible: unreconstructible,
  };
}

// ---------------------------------------------------------------------------
// Lane B (research annex) — legacy null-account identity-join census
// ---------------------------------------------------------------------------

export interface LegacyCensusResult {
  lane: "legacy_identity_join_research_only";
  truth: "research_only";
  note: string;
  rows: number;
  distinctCampaigns: number;
  identityResolved: number;
  identityAmbiguous: number;
  identityAbsentBeforeOrigin: number;
  identityCrossBusinessRefused: number;
  provenanceExactAfterJoin: number;
  byBusiness: Row[];
}

/**
 * Legacy rows carry no physical account. The migration deliberately did not
 * backfill them: they were computed with business-wide normalisation. They can
 * never be runtime authority, so this census exists only to say how much
 * history would even be addressable if someone tried, and it refuses any
 * identity that is later than the origin, absent, or not unique.
 */
export function computeLegacyCensus(
  snapshot: Record<string, D082MaterialisedRead[]>,
  window: D082Window,
): LegacyCensusResult {
  // campaign -> accounts observed strictly before each origin
  const observationsByBusiness = new Map<
    string,
    Map<string, Array<{ account: string; firstObservedOn: string }>>
  >();
  for (const read of snapshot.campaignIdentityObservations ?? []) {
    const businessId = read.businessId ?? "";
    const perCampaign = observationsByBusiness.get(businessId) ?? new Map();
    for (const raw of read.rows) {
      const campaignId = trimmedText(raw.campaign_id);
      const account = trimmedText(raw.provider_account_id);
      const firstObservedOn = dateOnly(raw.first_observed_on);
      if (!campaignId || !account || !firstObservedOn) continue;
      const list = perCampaign.get(campaignId) ?? [];
      if (!list.some((e: { account: string }) => e.account === account)) {
        list.push({ account, firstObservedOn });
      }
      perCampaign.set(campaignId, list);
    }
    observationsByBusiness.set(businessId, perCampaign);
  }

  let rows = 0;
  let identityResolved = 0;
  let identityAmbiguous = 0;
  let identityAbsent = 0;
  let provenanceExact = 0;
  const campaigns = new Set<string>();
  const byBusiness: Row[] = [];

  for (const read of snapshot.roleProvenanceLegacyNullAccount ?? []) {
    const businessId = read.businessId ?? "";
    const perCampaign = observationsByBusiness.get(businessId) ?? new Map();
    const legacyRows = read.rows.map((r) => toRoleRow(r, null));
    rows += legacyRows.length;

    let bResolved = 0;
    let bAmbiguous = 0;
    let bAbsent = 0;
    let bExact = 0;

    for (const row of legacyRows) {
      if (!row.campaignId || !row.asOfDate) continue;
      campaigns.add(`${businessId}|${row.campaignId}`);
      // The origin this row would first be consulted at.
      const origin = window.origins.find((o) => o > row.asOfDate!) ?? null;
      if (!origin) {
        bAbsent += 1;
        identityAbsent += 1;
        continue;
      }
      const observed = (perCampaign.get(row.campaignId) ?? []).filter(
        (e: { firstObservedOn: string }) => e.firstObservedOn < origin,
      );
      if (observed.length === 0) {
        bAbsent += 1;
        identityAbsent += 1;
        continue;
      }
      if (observed.length > 1) {
        bAmbiguous += 1;
        identityAmbiguous += 1;
        continue;
      }
      bResolved += 1;
      identityResolved += 1;
      if (satisfiesRoleAuthority(row, WHAT_IF_VALIDATOR).ok) {
        bExact += 1;
        provenanceExact += 1;
      }
    }

    byBusiness.push({
      businessId,
      rows: legacyRows.length,
      identityResolved: bResolved,
      identityAmbiguous: bAmbiguous,
      identityAbsentBeforeOrigin: bAbsent,
      provenanceExactAfterJoin: bExact,
    });
  }

  return {
    lane: "legacy_identity_join_research_only",
    truth: "research_only",
    note: "A null-account row can never be runtime authority. The partial unique index does not cover it, the producer's ON CONFLICT cannot touch it, and the D033 account-scope migration deliberately did not backfill it. This census is addressability, not authority.",
    rows,
    distinctCampaigns: campaigns.size,
    identityResolved,
    identityAmbiguous,
    identityAbsentBeforeOrigin: identityAbsent,
    identityCrossBusinessRefused: 0,
    provenanceExactAfterJoin: provenanceExact,
    byBusiness,
  };
}

// ---------------------------------------------------------------------------
// Lane C — retrospective name-neutral counterfactual
// ---------------------------------------------------------------------------

export interface LaneCOutcome {
  businessId: string;
  providerAccountId: string;
  campaignId: string;
  origin: string;
  publishedKind: CampaignKind | null;
  publishedClass: ContextConfidenceClass;
  kindBasis: "behavioral" | "family_inheritance";
  suppressedFlip: boolean;
  wouldSatisfyAuthority: boolean;
}

export interface LaneCResult {
  lane: "retrospective_finalized_conditional";
  truth: "counterfactual_recompute";
  temporalContract: string;
  boundaryGuards: Row;
  whyConditional: string;
  resolverIdentityBound: string;
  sourceBound: string;
  persisted: false;
  scoredDays: number;
  warmupDays: number;
  firstScoredDay: string;
  campaignOriginsScored: number;
  wouldSatisfyAuthority: number;
  scoredScopeOriginKeys: string[];
  resolvedScopeOriginKeys: string[];
  byOrigin: Row[];
  perBinding: Row[];
  publishedClassCensus: Record<string, number>;
  publishedKindCensus: Record<string, number>;
  nameNeutrality: {
    hardTuplesChecked: number;
    hardTuplesChangedByRemovingTheName: number;
    verdict: string;
  };
  clockCensus: Row[];
}

interface LaneCBindingInput {
  binding: PinnedBinding;
  creativeRows: CreativeDayRow[];
  nameDays: Array<{ campaignId: string; date: string; campaignName: string | null }>;
  firstSeen: Map<string, string>;
}

function laneCInputs(snapshot: Record<string, D082MaterialisedRead[]>): LaneCBindingInput[] {
  const out: LaneCBindingInput[] = [];
  for (const binding of D080_PINNED_BINDINGS) {
    const key = bindingKey(binding.businessId, binding.providerAccountId);
    // The production reader joins first spend on (provider_account_id,
    // creative_id); the two halves are read separately here and joined on
    // exactly that key.
    const firstSpendByCreative = new Map<string, string>();
    for (const read of snapshot.laneCCreativeFirstSpend ?? []) {
      if (bindingKey(read.businessId ?? "", read.providerAccountId ?? "") !== key) continue;
      for (const r of read.rows) {
        const creativeId = trimmedText(r.creative_id);
        const first = dateOnly(r.first_spend_date);
        if (creativeId && first) firstSpendByCreative.set(creativeId, first);
      }
    }
    const creativeRows: CreativeDayRow[] = [];
    for (const read of snapshot.laneCCreativeDays ?? []) {
      if (bindingKey(read.businessId ?? "", read.providerAccountId ?? "") !== key) continue;
      for (const r of read.rows) {
        const campaignId = trimmedText(r.campaign_id);
        const creativeId = trimmedText(r.creative_id);
        const date = dateOnly(r.date);
        if (!campaignId || !creativeId || !date) continue;
        const firstSpendDate = firstSpendByCreative.get(creativeId);
        // The production reader inner-joins first spend, so a creative with no
        // first-spend row is absent there and must be absent here too.
        if (!firstSpendDate) continue;
        creativeRows.push({
          providerAccountId: trimmedText(r.provider_account_id),
          campaignId,
          adsetId: trimmedText(r.adset_id),
          creativeId,
          date,
          spend: Number(r.spend ?? 0),
          firstSpendDate,
        });
      }
    }
    const nameDays: Array<{ campaignId: string; date: string; campaignName: string | null }> = [];
    for (const read of snapshot.laneCCampaignNameDays ?? []) {
      if (bindingKey(read.businessId ?? "", read.providerAccountId ?? "") !== key) continue;
      for (const r of read.rows) {
        const campaignId = trimmedText(r.campaign_id);
        const date = dateOnly(r.date);
        if (!campaignId || !date) continue;
        nameDays.push({ campaignId, date, campaignName: trimmedText(r.campaign_name) });
      }
    }
    const firstSeen = new Map<string, string>();
    for (const read of snapshot.laneCCampaignFirstSeen ?? []) {
      if (bindingKey(read.businessId ?? "", read.providerAccountId ?? "") !== key) continue;
      for (const r of read.rows) {
        const campaignId = trimmedText(r.campaign_id);
        const first = dateOnly(r.first_seen_date);
        if (campaignId && first) firstSeen.set(campaignId, first);
      }
    }
    out.push({ binding, creativeRows, nameDays, firstSeen });
  }
  return out;
}

/**
 * The production reader collapses names to "latest at or before the ceiling".
 * `firstSeenDate` is a MIN over all history at or before the ceiling, and a MIN
 * is monotone: if a campaign has any row at or before `day`, the global minimum
 * is itself at or before `day` and equals the day-bounded minimum. So the one
 * wide first-seen read is point-in-time safe for every earlier ceiling, and no
 * later fact can leak through it.
 */
function metaAtCeiling(
  input: LaneCBindingInput,
  ceiling: string,
): { meta: Map<string, CampaignMetaRow>; firstSeenClamped: number } {
  const latest = new Map<string, { date: string; name: string | null }>();
  for (const row of input.nameDays) {
    if (row.date > ceiling) continue;
    const current = latest.get(row.campaignId);
    if (!current || row.date >= current.date) {
      latest.set(row.campaignId, { date: row.date, name: row.campaignName });
    }
  }
  const out = new Map<string, CampaignMetaRow>();
  let firstSeenClamped = 0;
  for (const [campaignId, entry] of latest) {
    // First-seen is a MIN over all history at or before a ceiling, and a MIN is
    // monotone: a campaign that has any row at or before `ceiling` has its
    // global minimum at or before `ceiling` too, so the one wide read is safe
    // for every earlier ceiling. The clamp is a fail-closed guard on that
    // argument rather than a correction, and its counter is published so a
    // silent violation cannot hide.
    const firstSeen = input.firstSeen.get(campaignId) ?? null;
    const safeFirstSeen = firstSeen !== null && firstSeen > ceiling ? null : firstSeen;
    if (firstSeen !== safeFirstSeen) firstSeenClamped += 1;
    out.set(campaignId, {
      providerAccountId: input.binding.providerAccountId,
      campaignId,
      campaignName: entry.name,
      firstSeenDate: safeFirstSeen,
    });
  }
  return { meta: out, firstSeenClamped };
}

/**
 * The canonical daily pipeline, run in memory. Feature building, resolving,
 * family inheritance and hysteresis all come from the production modules; only
 * the row transport and the sequential state are local, and nothing is written.
 */
export function computeLaneC(
  snapshot: Record<string, D082MaterialisedRead[]>,
  window: D082Window,
): LaneCResult {
  const inputs = laneCInputs(snapshot);
  // The temporal contract, in one line: the score published for origin O is the
  // outcome of the daily chain on O-1. The chain therefore never ingests a row
  // dated O before producing O's score.
  const originScoredOnDay = new Map(window.origins.map((origin) => [addDays(origin, -1), origin]));
  const outcomes: LaneCOutcome[] = [];
  const perBinding: Row[] = [];
  let hardTuplesChecked = 0;
  let hardTuplesChanged = 0;
  let scoredDays = 0;
  let firstSpendAfterScoringDay = 0;
  let firstSeenAfterCeiling = 0;

  for (const input of inputs) {
    const state = new Map<string, HysteresisState>();
    let bindingScored = 0;
    let bindingAuthority = 0;

    let day = window.laneCFirstScoredDay;
    let dayCount = 0;
    while (day <= window.laneCLastScoredDay) {
      const scoredOrigin = originScoredOnDay.get(day) ?? null;
      const lineageFloor = addDays(day, -(SOURCE_WINDOW_DAYS - 1));
      // `<= day` is the production reader's own bound at asOf = day. Because
      // `day` is at most O-1 whenever an origin is scored, every row admitted
      // here is dated strictly before that origin.
      const inWindow = input.creativeRows.filter(
        (r) =>
          r.date >= lineageFloor &&
          r.date <= day &&
          // Fail-closed guard on the first-spend monotonicity argument: a
          // creative in this window always first spent at or before `day`.
          r.firstSpendDate <= day,
      );
      firstSpendAfterScoringDay += input.creativeRows.filter(
        (r) => r.date >= lineageFloor && r.date <= day && r.firstSpendDate > day,
      ).length;
      if (inWindow.length > 0) {
        const { meta, firstSeenClamped: clamped } = metaAtCeiling(input, day);
        firstSeenAfterCeiling += clamped;
        const lineage = computeCampaignLineage(inWindow);
        const features = buildCampaignContextFeatures({ rows: inWindow, meta, lineage, asOf: day });

        const resolutions = new Map<string, ContextResolution>();
        for (const feature of features) {
          resolutions.set(feature.campaignId, classifyCampaignContext(feature, DEFAULT_CONTEXT_CONFIG));
        }
        const inheritance = computeFamilyInheritance(
          [...resolutions.values()].map((resolution) => ({
            campaignId: resolution.campaignId,
            familyKey: campaignFamilyKey(resolution.campaignName),
            kind: resolution.kind,
            confidenceClass: resolution.confidenceClass,
          })),
        );
        const inheritedById = new Map(inheritance.map((o) => [o.campaignId, o]));

        for (const feature of features) {
          const resolution = resolutions.get(feature.campaignId)!;
          const inherited = inheritedById.get(feature.campaignId) ?? null;
          const effectiveKind = inherited ? inherited.inheritedKind : resolution.kind;
          const effectiveClass: ContextConfidenceClass = inherited ? "medium" : resolution.confidenceClass;
          const kindBasis = inherited ? "family_inheritance" : "behavioral";

          const hysteresis = applyDailyHysteresis(
            state.get(feature.campaignId) ?? null,
            effectiveKind,
            effectiveClass,
          );
          state.set(feature.campaignId, hysteresis.state);

          if (scoredOrigin === null) continue;

          // The counterfactual row is bound to the exact automatic source the
          // resolver emits and the exact compiled identity. Nothing else.
          const wouldSatisfy = satisfiesRoleAuthority(
            {
              inferredKind: hysteresis.publishedKind,
              kindSource: REQUIRED_KIND_SOURCE,
              confidenceClass: hysteresis.publishedClass,
              resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
            },
            WHAT_IF_VALIDATOR,
          ).ok;

          if (wouldSatisfy) {
            bindingAuthority += 1;
            // Name neutrality is measured on exactly the tuples that carry
            // hard authority: re-resolve with the name removed and compare.
            hardTuplesChecked += 1;
            const nameless = classifyCampaignContext(
              { ...feature, campaignName: null },
              DEFAULT_CONTEXT_CONFIG,
            );
            if (nameless.kind !== resolution.kind || nameless.confidenceClass !== resolution.confidenceClass) {
              hardTuplesChanged += 1;
            }
          }

          bindingScored += 1;
          outcomes.push({
            businessId: input.binding.businessId,
            providerAccountId: input.binding.providerAccountId,
            campaignId: feature.campaignId,
            origin: scoredOrigin,
            publishedKind: hysteresis.publishedKind,
            publishedClass: hysteresis.publishedClass,
            kindBasis,
            suppressedFlip: hysteresis.suppressedFlip,
            wouldSatisfyAuthority: wouldSatisfy,
          });
        }
      }
      dayCount += 1;
      day = addDays(day, 1);
    }
    scoredDays = Math.max(scoredDays, dayCount);

    perBinding.push({
      business: input.binding.business,
      businessId: input.binding.businessId,
      providerAccountId: input.binding.providerAccountId,
      accountSelected: input.binding.isSelected,
      creativeDayRows: input.creativeRows.length,
      campaignOriginsScored: bindingScored,
      wouldSatisfyAuthority: bindingAuthority,
    });
  }

  const byOrigin: Row[] = window.origins.map((origin) => {
    const rows = outcomes.filter((o) => o.origin === origin);
    return {
      origin,
      scored: rows.length,
      wouldSatisfyAuthority: rows.filter((o) => o.wouldSatisfyAuthority).length,
    };
  });

  const clockCensus: Row[] = [];
  for (const read of snapshot.laneCClockCensus ?? []) {
    for (const r of read.rows) {
      clockCensus.push({
        businessId: read.businessId,
        providerAccountId: read.providerAccountId,
        rows: Number(r.rows ?? 0),
        createdBeforeItsOwnDate: Number(r.created_before_its_own_date ?? 0),
        rewrittenRows: Number(r.rewritten_rows ?? 0),
      });
    }
  }

  return {
    lane: "retrospective_finalized_conditional",
    truth: "counterfactual_recompute",
    temporalContract:
      "A score published for origin O is the outcome of the canonical daily chain on O-1. The chain advances one calendar day at a time from the warm-up start to the day before the last origin; on each day it admits only creative rows and campaign names dated at or before that day, builds features, resolves, applies family inheritance and advances daily hysteresis, and publishes the day's outcome as the score for O = day + 1. No row dated on an origin can therefore reach that origin's score, and the first row that can is dated O-1.",
    boundaryGuards: {
      firstSpendAfterScoringDay,
      firstSeenAfterCeiling,
      note: "Both counters must be zero. First spend and first seen are MIN aggregates read once at the wide ceiling; a MIN is monotone, so for any campaign or creative present at or before an earlier day the wide value equals the day-bounded value. These counters are the fail-closed guard on that argument, not a correction to it.",
    },
    whyConditional:
      "meta_creative_daily, the table the canonical feature builder reads, carries only created_at and updated_at on an upserted daily row: no finalized_at and no truth_state. Feature eligibility is therefore bounded by effective date only, which is a retrospective finalized reconstruction and not a strict knowledge-time replay.",
    resolverIdentityBound: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    sourceBound: REQUIRED_KIND_SOURCE,
    persisted: false,
    scoredDays,
    warmupDays: LANE_C_WARMUP_DAYS,
    firstScoredDay: window.laneCFirstScoredDay,
    campaignOriginsScored: outcomes.length,
    wouldSatisfyAuthority: outcomes.filter((o) => o.wouldSatisfyAuthority).length,
    scoredScopeOriginKeys: sortedUnique(
      outcomes.map((o) =>
        [scopeOriginKey(o.businessId, o.providerAccountId, o.campaignId, o.origin),
         o.publishedKind ?? "null", o.publishedClass].join("~"),
      ),
    ),
    resolvedScopeOriginKeys: sortedUnique(
      outcomes
        .filter((o) => o.wouldSatisfyAuthority)
        .map((o) => scopeOriginKey(o.businessId, o.providerAccountId, o.campaignId, o.origin)),
    ),
    byOrigin,
    perBinding,
    publishedClassCensus: tally(outcomes.map((o) => o.publishedClass)),
    publishedKindCensus: tally(outcomes.map((o) => o.publishedKind ?? "null")),
    nameNeutrality: {
      hardTuplesChecked,
      hardTuplesChangedByRemovingTheName: hardTuplesChanged,
      verdict:
        hardTuplesChanged === 0
          ? "no hard-authoritative tuple changed when the campaign name was removed"
          : "a hard-authoritative tuple changed when the campaign name was removed, which contradicts name neutrality",
    },
    clockCensus,
  };
}

/**
 * The Lane C temporal contract, exercised on the real snapshot rather than
 * asserted in prose. Each control is run by rebuilding one binding's Lane C
 * with a single fact injected at a chosen date, so a regression that let an
 * origin-day fact reach an origin's score would change these rows and fail
 * verification.
 *
 * The binding is chosen deterministically (fewest creative rows among bindings
 * that actually score something, then by binding key) so the controls stay
 * cheap and reproducible.
 */
export function computeLaneCTemporalControls(
  snapshot: Record<string, D082MaterialisedRead[]>,
  window: D082Window,
): Row {
  const readsFor = (planKey: string, key: string) =>
    (snapshot[planKey] ?? []).filter(
      (r) => bindingKey(r.businessId ?? "", r.providerAccountId ?? "") === key,
    );

  const candidates = D080_PINNED_BINDINGS.map((binding) => {
    const key = bindingKey(binding.businessId, binding.providerAccountId);
    const rows = readsFor("laneCCreativeDays", key).reduce((a, r) => a + r.rows.length, 0);
    return { binding, key, rows };
  })
    .filter((c) => c.rows > 0)
    .sort((a, b) => a.rows - b.rows || a.key.localeCompare(b.key));

  const chosen = candidates[0];
  if (!chosen || window.origins.length < 3) {
    return {
      status: "not_runnable",
      why: "no binding carries Lane C rows, or the origin axis is too short to hold an origin and a successor",
    };
  }

  const only = (extra: Partial<Record<string, D082MaterialisedRead[]>> = {}) => ({
    laneCCreativeDays: readsFor("laneCCreativeDays", chosen.key),
    laneCCreativeFirstSpend: readsFor("laneCCreativeFirstSpend", chosen.key),
    laneCCampaignNameDays: readsFor("laneCCampaignNameDays", chosen.key),
    laneCCampaignFirstSeen: readsFor("laneCCampaignFirstSeen", chosen.key),
    ...extra,
  });

  // The second origin: warm-up has run, and a successor origin exists.
  const origin = window.origins[1]!;
  const nextOrigin = window.origins[2]!;
  const dayBefore = addDays(origin, -1);

  const at = (result: LaneCResult, o: string) =>
    result.scoredScopeOriginKeys.filter((k) => k.includes(`|${o}~`)).sort();

  const baseline = computeLaneC(only(), window);

  const CONTROL_CAMPAIGN = "d082-temporal-control-campaign";
  const injectedRows = (start: string): Row[] => {
    const rows: Row[] = [];
    const startMs = Date.parse(`${start}T00:00:00.000Z`);
    for (let c = 0; c < 8; c += 1) {
      for (let d = 0; d < 6; d += 1) {
        rows.push({
          provider_account_id: chosen.binding.providerAccountId,
          campaign_id: CONTROL_CAMPAIGN,
          adset_id: `d082-control-adset-${c % 3}`,
          creative_id: `d082-control-creative-${c}`,
          date: new Date(startMs + d * 86_400_000).toISOString().slice(0, 10),
          spend: 55,
        });
      }
    }
    return rows;
  };
  const injectedFirstSpend = (start: string): Row[] =>
    Array.from({ length: 8 }, (_, c) => ({
      provider_account_id: chosen.binding.providerAccountId,
      creative_id: `d082-control-creative-${c}`,
      first_spend_date: start,
    }));

  const withCreativeInjection = (start: string) => {
    const creativeReads = readsFor("laneCCreativeDays", chosen.key);
    const firstSpendReads = readsFor("laneCCreativeFirstSpend", chosen.key);
    return computeLaneC(
      only({
        laneCCreativeDays: creativeReads.map((r, i) =>
          i === 0 ? { ...r, rows: [...r.rows, ...injectedRows(start)] } : r,
        ),
        laneCCreativeFirstSpend: firstSpendReads.map((r, i) =>
          i === 0 ? { ...r, rows: [...r.rows, ...injectedFirstSpend(start)] } : r,
        ),
      }),
      window,
    );
  };

  const onOrigin = withCreativeInjection(origin);
  const dayBeforeOrigin = withCreativeInjection(dayBefore);
  const has = (result: LaneCResult, o: string) =>
    at(result, o).some((k) => k.includes(CONTROL_CAMPAIGN));

  // A blanket rename, so the control does not depend on one campaign's name
  // happening to be load-bearing.
  const renameAt = (bindingCandidate: { binding: PinnedBinding; key: string }, date: string) => {
    const nameReads = (snapshot.laneCCampaignNameDays ?? []).filter(
      (r) => bindingKey(r.businessId ?? "", r.providerAccountId ?? "") === bindingCandidate.key,
    );
    const campaigns = new Set<string>();
    for (const read of nameReads) {
      for (const row of read.rows) {
        const campaignId = trimmedText(row.campaign_id);
        if (campaignId) campaigns.add(campaignId);
      }
    }
    const renames: Row[] = [...campaigns].sort().map((campaignId) => ({
      campaign_id: campaignId,
      date,
      campaign_name: "d082 control TEST creative lab",
    }));
    const scopedReads = (planKey: string) =>
      (snapshot[planKey] ?? []).filter(
        (r) => bindingKey(r.businessId ?? "", r.providerAccountId ?? "") === bindingCandidate.key,
      );
    return computeLaneC(
      {
        laneCCreativeDays: scopedReads("laneCCreativeDays"),
        laneCCreativeFirstSpend: scopedReads("laneCCreativeFirstSpend"),
        laneCCampaignFirstSeen: scopedReads("laneCCampaignFirstSeen"),
        laneCCampaignNameDays: nameReads.map((r, idx) =>
          idx === 0 ? { ...r, rows: [...r.rows, ...renames] } : r,
        ),
      },
      window,
    );
  };

  const baselineFor = (bindingCandidate: { binding: PinnedBinding; key: string }) => {
    const scopedReads = (planKey: string) =>
      (snapshot[planKey] ?? []).filter(
        (r) => bindingKey(r.businessId ?? "", r.providerAccountId ?? "") === bindingCandidate.key,
      );
    return computeLaneC(
      {
        laneCCreativeDays: scopedReads("laneCCreativeDays"),
        laneCCreativeFirstSpend: scopedReads("laneCCreativeFirstSpend"),
        laneCCampaignNameDays: scopedReads("laneCCampaignNameDays"),
        laneCCampaignFirstSeen: scopedReads("laneCCampaignFirstSeen"),
      },
      window,
    );
  };

  /**
   * A rename only moves a score where the naming family is actually load-
   * bearing, and on real data most campaigns sit far from that boundary. So the
   * rename site is searched for rather than assumed: the first binding/origin,
   * in deterministic order, at which a rename dated O-1 provably changes the
   * score at O. That site is then used to show the same rename dated O is inert.
   * Without this search the control would pass while proving nothing.
   */
  const RENAME_SITE_BUDGET = 24;
  let sitesTried = 0;
  let renameSite: {
    candidate: { binding: PinnedBinding; key: string; rows: number };
    origin: string;
    baseline: LaneCResult;
    dayBefore: LaneCResult;
  } | null = null;
  outer: for (const candidate of candidates) {
    const candidateBaseline = baselineFor(candidate);
    for (let index = 1; index <= window.origins.length - 2; index += 1) {
      if (sitesTried >= RENAME_SITE_BUDGET) break outer;
      sitesTried += 1;
      const candidateOrigin = window.origins[index]!;
      const renamed = renameAt(candidate, addDays(candidateOrigin, -1));
      const before = JSON.stringify(at(candidateBaseline, candidateOrigin));
      if (JSON.stringify(at(renamed, candidateOrigin)) !== before) {
        renameSite = {
          candidate,
          origin: candidateOrigin,
          baseline: candidateBaseline,
          dayBefore: renamed,
        };
        break outer;
      }
    }
  }

  const sameAtOrigin = (result: LaneCResult) =>
    JSON.stringify(at(result, origin)) === JSON.stringify(at(baseline, origin));

  const controls: Row[] = [
    {
      control: "creative_row_dated_on_the_origin",
      injectedAt: origin,
      visibleAtOrigin: has(onOrigin, origin),
      visibleAtNextOrigin: has(onOrigin, nextOrigin),
      originTuplesUnchanged: sameAtOrigin(onOrigin),
      expectation:
        "absent from the origin it is dated on, present once the daily chain advances to a later origin",
      pass:
        has(onOrigin, origin) === false &&
        has(onOrigin, nextOrigin) === true &&
        sameAtOrigin(onOrigin) === true,
      nonVacuous: has(onOrigin, nextOrigin) === true,
    },
    {
      control: "creative_row_dated_the_day_before_the_origin",
      injectedAt: dayBefore,
      visibleAtOrigin: has(dayBeforeOrigin, origin),
      visibleAtNextOrigin: has(dayBeforeOrigin, nextOrigin),
      originTuplesUnchanged: sameAtOrigin(dayBeforeOrigin),
      expectation: "positive control: the last knowable day is visible at the origin",
      pass: has(dayBeforeOrigin, origin) === true,
      nonVacuous: has(dayBeforeOrigin, origin) === true,
    },
  ];

  if (renameSite) {
    const site = renameSite;
    const onOriginRename = renameAt(site.candidate, site.origin);
    const atSite = (result: LaneCResult) =>
      JSON.stringify(at(result, site.origin));
    const baselineAtSite = atSite(site.baseline);
    controls.push(
      {
        control: "campaign_rename_dated_on_the_origin",
        binding: site.candidate.key,
        origin: site.origin,
        injectedAt: site.origin,
        originTuplesUnchanged: atSite(onOriginRename) === baselineAtSite,
        hardAuthorityUnchanged:
          JSON.stringify(onOriginRename.resolvedScopeOriginKeys) ===
          JSON.stringify(site.baseline.resolvedScopeOriginKeys),
        expectation: "an origin-day rename cannot reach that origin's score",
        pass: atSite(onOriginRename) === baselineAtSite,
        // The same rename one day earlier does move this site, which is what
        // makes the inertness above a real constraint.
        nonVacuous: atSite(site.dayBefore) !== baselineAtSite,
      },
      {
        control: "campaign_rename_dated_the_day_before_the_origin",
        binding: site.candidate.key,
        origin: site.origin,
        injectedAt: addDays(site.origin, -1),
        originTuplesChanged: atSite(site.dayBefore) !== baselineAtSite,
        hardAuthorityUnchanged:
          JSON.stringify(site.dayBefore.resolvedScopeOriginKeys) ===
          JSON.stringify(site.baseline.resolvedScopeOriginKeys),
        expectation:
          "positive control: the same rename one day earlier does reach the origin, and even then may only move non-authoritative evidence",
        pass: atSite(site.dayBefore) !== baselineAtSite,
        nonVacuous: atSite(site.dayBefore) !== baselineAtSite,
      },
    );
  } else {
    controls.push({
      control: "campaign_rename_boundary",
      pass: false,
      nonVacuous: false,
      sitesTried,
      why: "no binding/origin was found within the search budget at which a rename dated O-1 changes the score at O, so the rename boundary cannot be demonstrated non-vacuously on this snapshot",
    });
  }

  return {
    status: "runnable",
    binding: {
      business: chosen.binding.business,
      businessId: chosen.binding.businessId,
      providerAccountId: chosen.binding.providerAccountId,
      creativeDayRows: chosen.rows,
      selectedDeterministicallyBy: "fewest creative-day rows among bindings that score, then binding key",
    },
    origin,
    nextOrigin,
    dayBefore,
    baselineScoredAtOrigin: at(baseline, origin).length,
    renameSite: renameSite
      ? { binding: renameSite.candidate.key, origin: renameSite.origin, sitesTried }
      : { binding: null, origin: null, sitesTried },
    controls,
    allPass: controls.every((c) => c.pass === true),
    allNonVacuous: controls.every((c) => c.nonVacuous === true),
  };
}

// ---------------------------------------------------------------------------
// Lane D — locked accuracy diagnostics against the frozen H11B package
// ---------------------------------------------------------------------------

/**
 * Predeclared and frozen before any number was looked at. `openAuthorityGate`
 * defaults false and may only become true when every one of these is met.
 */
export const D082_ACCURACY_GATE = {
  minLabeledValidationObservations: 30,
  minOverallAccuracy: 0.9,
  minPerClassRecall: 0.8,
  minHighConfidencePrecision: 0.95,
  maxSingleBusinessTruthShare: 0.6,
  requireIndependentUnreusedHoldout: true,
} as const;

export interface LaneDResult {
  lane: "locked_accuracy_diagnostics";
  truth: "research_only";
  comparator: Row;
  protocol: Row;
  manualLabelsAreEvaluationOnly: true;
  candidate: Row;
  disclosures: string[];
  gate: { checks: Row[]; openAuthorityGate: boolean; verdict: string };
}

interface BundleCreativeRowLite {
  businessId: string;
  accountId: string;
  campaignId: string;
  adsetId: string | null;
  creativeId: string;
  date: string;
  spend: number;
  firstSpendDate: string;
}

interface ScoredAnchor {
  businessName: string;
  accountId: string;
  campaignId: string;
  anchor: string;
  manualKind: string | null;
  truthDate: string | null;
  predictedKind: string | null;
  confidenceClass: string | null;
}

/**
 * The H11B anchor protocol, reproduced over the frozen bundle. This is harness
 * code, not resolver code: lineage, features and classification all come from
 * the production modules, exactly as the H11B runner calls them, and no
 * hysteresis or family inheritance is applied because the comparator evaluates
 * the resolver's own classification at a point.
 */
function scoreAnchor(
  bundle: Record<string, unknown>,
  businessId: string,
  businessName: string,
  accountId: string,
  anchor: string,
): ScoredAnchor[] {
  const creativeRows = (bundle.creativeRows ?? []) as BundleCreativeRowLite[];
  const nameRows = (bundle.nameRows ?? []) as Array<{
    businessId: string;
    accountId: string;
    campaignId: string;
    date: string;
    campaignName: string | null;
  }>;
  const firstSeenRows = (bundle.firstSeenRows ?? []) as Array<{
    businessId: string;
    accountId: string;
    campaignId: string;
    firstSeenDate: string;
  }>;
  const labels = (bundle.labels ?? []) as Array<{
    businessId: string;
    accountId: string | null;
    campaignId: string;
    campaignKind: string;
    labeledAtDate: string | null;
    updatedAtDate: string | null;
  }>;

  const sourceStart = addDays(anchor, -(SOURCE_WINDOW_DAYS - 1));
  const rows: CreativeDayRow[] = creativeRows
    .filter(
      (r) =>
        r.businessId === businessId &&
        r.accountId === accountId &&
        r.date >= sourceStart &&
        r.date <= anchor,
    )
    .map((r) => ({
      providerAccountId: r.accountId,
      campaignId: r.campaignId,
      adsetId: r.adsetId,
      creativeId: r.creativeId,
      date: r.date,
      spend: Number(r.spend ?? 0),
      firstSpendDate: r.firstSpendDate,
    }));
  if (rows.length === 0) return [];

  const latestName = new Map<string, { date: string; name: string | null }>();
  for (const row of nameRows) {
    if (row.businessId !== businessId || row.accountId !== accountId) continue;
    if (row.date > anchor) continue;
    const current = latestName.get(row.campaignId);
    if (!current || row.date >= current.date) {
      latestName.set(row.campaignId, { date: row.date, name: row.campaignName });
    }
  }
  const meta = new Map<string, CampaignMetaRow>();
  for (const [campaignId, entry] of latestName) {
    meta.set(campaignId, {
      providerAccountId: accountId,
      campaignId,
      campaignName: entry.name,
      firstSeenDate: null,
    });
  }
  for (const row of firstSeenRows) {
    if (row.businessId !== businessId || row.accountId !== accountId) continue;
    if (row.firstSeenDate > anchor) continue;
    const existing = meta.get(row.campaignId);
    if (existing) existing.firstSeenDate = row.firstSeenDate;
    else
      meta.set(row.campaignId, {
        providerAccountId: accountId,
        campaignId: row.campaignId,
        campaignName: null,
        firstSeenDate: row.firstSeenDate,
      });
  }

  const lineage = computeCampaignLineage(rows);
  const features = buildCampaignContextFeatures({ rows, meta, lineage, asOf: anchor });

  const labelByCampaign = new Map(
    labels
      .filter((l) => l.businessId === businessId && (l.accountId === null || l.accountId === accountId))
      .map((l) => [l.campaignId, l]),
  );

  return features.map((feature) => {
    const label = labelByCampaign.get(feature.campaignId) ?? null;
    const resolution = classifyCampaignContext(feature, DEFAULT_CONTEXT_CONFIG);
    const truthCandidates = label
      ? [label.labeledAtDate, label.updatedAtDate].filter((v): v is string => v !== null).sort()
      : [];
    return {
      businessName,
      accountId,
      campaignId: feature.campaignId,
      anchor,
      manualKind: label?.campaignKind ?? null,
      truthDate: truthCandidates.length ? truthCandidates[truthCandidates.length - 1]! : null,
      predictedKind: resolution.kind,
      confidenceClass: resolution.confidenceClass,
    };
  });
}

/**
 * One observation per campaign per fold: for a labeled campaign, the anchor
 * closest to its truth stamp inside the truth window; for an unlabeled one, the
 * last anchor at which it has features. This is the H11B selection rule.
 */
function collectFold(
  bundle: Record<string, unknown>,
  anchors: readonly string[],
  truthWindowDays: number,
): { observations: ScoredAnchor[]; staleTruthExcluded: number; featurelessLabeled: number } {
  const businesses = (bundle.businesses ?? []) as Array<{
    businessId: string;
    name: string;
    providerAccountId: string;
  }>;
  const byCampaign = new Map<string, ScoredAnchor[]>();
  for (const anchor of anchors) {
    for (const business of businesses) {
      for (const row of scoreAnchor(
        bundle,
        business.businessId,
        business.name,
        business.providerAccountId,
        anchor,
      )) {
        const key = `${row.accountId}|${row.campaignId}`;
        const list = byCampaign.get(key) ?? [];
        list.push(row);
        byCampaign.set(key, list);
      }
    }
  }

  const observations: ScoredAnchor[] = [];
  let stale = 0;
  for (const rows of byCampaign.values()) {
    const labeled = rows[0]!.manualKind !== null;
    if (!labeled) {
      observations.push(rows.reduce((best, r) => (r.anchor > best.anchor ? r : best)));
      continue;
    }
    const truthDate = rows[0]!.truthDate;
    if (truthDate === null) {
      stale += 1;
      continue;
    }
    const inWindow = rows.filter(
      (r) => Math.abs(daysBetween(r.anchor, truthDate)) <= truthWindowDays,
    );
    if (inWindow.length === 0) {
      stale += 1;
      continue;
    }
    observations.push(
      inWindow.reduce((best, r) => {
        const bestDistance = Math.abs(daysBetween(best.anchor, truthDate));
        const rowDistance = Math.abs(daysBetween(r.anchor, truthDate));
        if (rowDistance < bestDistance) return r;
        if (rowDistance === bestDistance && r.anchor > best.anchor) return r;
        return best;
      }),
    );
  }

  const labelCount = ((bundle.labels ?? []) as unknown[]).length;
  const seenLabeled = observations.filter((o) => o.manualKind !== null).length;
  return {
    observations: observations.sort((a, b) =>
      `${a.accountId}|${a.campaignId}`.localeCompare(`${b.accountId}|${b.campaignId}`),
    ),
    staleTruthExcluded: stale,
    featurelessLabeled: Math.max(0, labelCount - seenLabeled - stale),
  };
}

function confusion(observations: readonly ScoredAnchor[]) {
  const labeled = observations.filter((o) => o.manualKind !== null);
  const correct = labeled.filter((o) => o.predictedKind === o.manualKind).length;
  const kinds = ["main", "test", "mixed"] as const;
  const perClass: Row[] = kinds.map((kind) => {
    const actual = labeled.filter((o) => o.manualKind === kind);
    const predicted = labeled.filter((o) => o.predictedKind === kind);
    const hit = actual.filter((o) => o.predictedKind === kind).length;
    return {
      kind,
      support: actual.length,
      predicted: predicted.length,
      recall: actual.length ? Number((hit / actual.length).toFixed(4)) : null,
      precision: predicted.length ? Number((hit / predicted.length).toFixed(4)) : null,
    };
  });
  const high = labeled.filter((o) => o.confidenceClass === "high");
  const highCorrect = high.filter((o) => o.predictedKind === o.manualKind).length;
  const byBusiness = tally(labeled.map((o) => o.businessName));
  const maxShare = labeled.length ? Math.max(...Object.values(byBusiness)) / labeled.length : 1;
  return {
    observations: observations.length,
    labeledObservations: labeled.length,
    accuracy: labeled.length ? Number((correct / labeled.length).toFixed(4)) : null,
    perClass,
    highConfidenceLabeled: high.length,
    highConfidencePrecision: high.length ? Number((highCorrect / high.length).toFixed(4)) : null,
    truthByBusiness: byBusiness,
    maxSingleBusinessTruthShare: Number(maxShare.toFixed(4)),
  };
}

export function computeLaneD(
  bundle: Record<string, unknown>,
  protocol: Record<string, unknown>,
): LaneDResult {
  const trainAnchors = (protocol.trainAnchors ?? []) as string[];
  const validationAnchors = (protocol.validationAnchors ?? []) as string[];
  const truthWindowDays = Number(protocol.truthWindowDays ?? 0);

  const folds: Row[] = [];
  for (const [foldName, anchors] of [
    ["train", trainAnchors],
    ["validation", validationAnchors],
  ] as const) {
    const collected = collectFold(bundle, anchors, truthWindowDays);
    folds.push({
      fold: foldName,
      anchors: [...anchors],
      ...confusion(collected.observations),
      staleTruthExcluded: collected.staleTruthExcluded,
      featurelessLabeled: collected.featurelessLabeled,
    });
  }

  const validation = folds.find((f) => f.fold === "validation") ?? {};
  const perClassRecalls = ((validation.perClass as Row[]) ?? [])
    .map((c) => c.recall as number | null)
    .filter((r): r is number => r !== null);

  const checks: Row[] = [
    {
      check: "minLabeledValidationObservations",
      required: D082_ACCURACY_GATE.minLabeledValidationObservations,
      observed: validation.labeledObservations ?? 0,
      pass:
        Number(validation.labeledObservations ?? 0) >=
        D082_ACCURACY_GATE.minLabeledValidationObservations,
    },
    {
      check: "minOverallAccuracy",
      required: D082_ACCURACY_GATE.minOverallAccuracy,
      observed: validation.accuracy ?? null,
      pass:
        (validation.accuracy as number | null) !== null &&
        Number(validation.accuracy) >= D082_ACCURACY_GATE.minOverallAccuracy,
    },
    {
      check: "minPerClassRecall",
      required: D082_ACCURACY_GATE.minPerClassRecall,
      observed: perClassRecalls.length ? Math.min(...perClassRecalls) : null,
      pass:
        perClassRecalls.length === 3 &&
        Math.min(...perClassRecalls) >= D082_ACCURACY_GATE.minPerClassRecall,
    },
    {
      check: "minHighConfidencePrecision",
      required: D082_ACCURACY_GATE.minHighConfidencePrecision,
      observed: validation.highConfidencePrecision ?? null,
      pass:
        (validation.highConfidencePrecision as number | null) !== null &&
        Number(validation.highConfidencePrecision) >=
          D082_ACCURACY_GATE.minHighConfidencePrecision,
    },
    {
      check: "maxSingleBusinessTruthShare",
      required: D082_ACCURACY_GATE.maxSingleBusinessTruthShare,
      observed: validation.maxSingleBusinessTruthShare ?? null,
      pass:
        (validation.maxSingleBusinessTruthShare as number | null) !== null &&
        Number(validation.maxSingleBusinessTruthShare) <=
          D082_ACCURACY_GATE.maxSingleBusinessTruthShare,
    },
    {
      check: "requireIndependentUnreusedHoldout",
      required: true,
      observed: false,
      pass: false,
      why: "The H11B holdout was already consumed by the D076 challenger evaluation and is consumed again here to re-evaluate a changed algorithm. Reused truth can refute, but it cannot license promotion, so this check fails by construction and is disclosed rather than waived.",
    },
  ];

  const openAuthorityGate = checks.every((c) => c.pass === true);

  return {
    lane: "locked_accuracy_diagnostics",
    truth: "research_only",
    comparator: {
      bundle: D082_PINNED_INPUTS.h11bBundlePath,
      bundleFileSha256: D082_PINNED_INPUTS.h11bBundleSha256,
      bundleInternalHash: String(bundle.bundleHash ?? ""),
      evalProtocol: D082_PINNED_INPUTS.h11bEvalArtifactPath,
      evalProtocolFileSha256: D082_PINNED_INPUTS.h11bEvalArtifactSha256,
      protocolBundleHash: String(protocol.bundleHash ?? ""),
      protocolBindsToBundle: String(protocol.bundleHash ?? "") === String(bundle.bundleHash ?? ""),
      labels: ((bundle.labels ?? []) as unknown[]).length,
    },
    protocol: {
      trainAnchors,
      validationAnchors,
      truthWindowDays,
      source: "transcribed from the frozen H11B evaluation artifact, not restated by this audit",
    },
    manualLabelsAreEvaluationOnly: true,
    candidate: {
      candidateId: "current_v2_name_neutral",
      resolverIdentity: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      folds,
    },
    disclosures: [
      "Manual labels are evaluation evidence only. They are never a runtime input, never a tie-break, and no manual Test/Main/Mixed label is restored, consulted or inferred from by any other lane in this package.",
      "meta_campaign_labels stores only the current label plus timestamps, with no versioned history, so the role an operator believed on a historical day cannot be reconstructed. Truth is anchored by the label's own stamp inside the frozen truth window, not by the decision day.",
      "Truth is sparse and uneven: the frozen bundle carries a small number of labels across seven accounts, so per-class support is small and one business can dominate a class. The per-business truth share is published rather than smoothed away.",
      "Both stored H11 and H11B evaluation packages were produced under now-retired resolver identities. Their recorded candidate and gate numbers do not describe the current name-neutral algorithm and are deliberately not quoted; this lane recomputes against the frozen inputs instead.",
      "The v3 lifecycle challenger is not re-evaluated here. Its lifecycle feature builder lives in a module that executes a CLI on import, so importing it would run that script; duplicating the builder to avoid that would create the second core this programme forbids. v3 remains REJECTED under D076 and is unchanged by this audit.",
      "This lane applies no family inheritance and no daily hysteresis, matching the comparator's point-classification protocol. It therefore measures the resolver, not the published post-hysteresis role.",
      "This is a post-hoc re-evaluation on reused evidence. It can refute, but it cannot promote.",
    ],
    gate: {
      checks,
      openAuthorityGate,
      verdict: openAuthorityGate
        ? "every predeclared gate met"
        : "at least one predeclared gate is not met, so the authority gate stays closed",
    },
  };
}
// ---------------------------------------------------------------------------
// Proposal-level impact, without causal fiction
// ---------------------------------------------------------------------------

/** Closed by D081 and already accepted. Never re-derived or re-argued here. */
export const D081_CLOSED_BLOCKERS = ["decision_vocabulary_absent", "unit_exponent_unknown"] as const;
export const ROLE_BLOCKER = "role_authority_absent" as const;

export interface ProposalImpactResult {
  denominators: Row;
  joinability: Row;
  perLane: Row[];
  breakdowns: Row;
  blockerCensusAfterRoleOverlay: Row;
  funnelAfterRoleOverlay: Row[];
  exposure: Row;
}

/** The campaign identity a role can actually be joined to, or null. */
export function proposalCampaignIdentity(p: BudgetResearchProposal): string | null {
  return p.entityGrain === "campaign" ? p.entityId : p.campaignId;
}

function laneResolvedSet(keys: readonly string[]): Set<string> {
  return new Set(keys);
}

export function computeProposalImpact(input: {
  proposals: readonly BudgetResearchProposal[];
  origins: readonly OriginPlan[];
  laneA: LaneAResult;
  laneB: LaneBResult;
  laneC: LaneCResult;
}): ProposalImpactResult {
  const foldByOrigin = new Map(input.origins.map((o) => [o.origin, o.fold]));
  const lanes: Array<{ lane: string; truth: string; resolved: Set<string> }> = [
    {
      lane: "actual_current_runtime_authority",
      truth: "verified_fact",
      resolved: laneResolvedSet(input.laneA.authoritativeScopes),
    },
    {
      lane: "strict_pit_authority",
      truth: "verified_fact",
      resolved: laneResolvedSet(input.laneB.resolvedScopeOriginKeys),
    },
    {
      lane: "retrospective_finalized_conditional",
      truth: "counterfactual_recompute",
      resolved: laneResolvedSet(input.laneC.resolvedScopeOriginKeys),
    },
  ];

  let joinable = 0;
  let unjoinable = 0;
  const unjoinableByGrain: string[] = [];

  const perLane: Row[] = [];
  const breakdowns: Row = {};
  const censusAfter: Record<string, number> = {};
  const funnelAfter: Row[] = [];

  // One pass per lane; the proposal set itself is shared and never mutated.
  for (const lane of lanes) {
    let roleResolvable = 0;
    let roleStillBlocked = 0;
    let zeroResidual = 0;
    const byBusiness: Record<string, number> = {};
    const byAccount: Record<string, number> = {};
    const bySelected: Record<string, number> = {};
    const byGrain: Record<string, number> = {};
    const byFold: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};
    const byRole: Record<string, number> = {};

    for (const p of input.proposals) {
      const identity = proposalCampaignIdentity(p);
      const key = identity
        ? scopeOriginKey(p.businessId, p.providerAccountId, identity, p.originDate)
        : null;
      const resolved = key !== null && lane.resolved.has(key);
      if (resolved) {
        roleResolvable += 1;
        byBusiness[p.business] = (byBusiness[p.business] ?? 0) + 1;
        byAccount[p.providerAccountId] = (byAccount[p.providerAccountId] ?? 0) + 1;
        bySelected[String(p.accountSelected)] = (bySelected[String(p.accountSelected)] ?? 0) + 1;
        byGrain[p.entityGrain] = (byGrain[p.entityGrain] ?? 0) + 1;
        byFold[`fold_${foldByOrigin.get(p.originDate) ?? "unknown"}`] =
          (byFold[`fold_${foldByOrigin.get(p.originDate) ?? "unknown"}`] ?? 0) + 1;
        byOrigin[p.originDate] = (byOrigin[p.originDate] ?? 0) + 1;
        byRole[p.automaticRole ?? "null"] = (byRole[p.automaticRole ?? "null"] ?? 0) + 1;
      } else {
        roleStillBlocked += 1;
      }

      // D081's two accepted overlays, plus this lane's role outcome.
      const residual = p.blockers.filter(
        (b) =>
          !(D081_CLOSED_BLOCKERS as readonly string[]).includes(b) &&
          !(b === ROLE_BLOCKER && resolved),
      );
      if (residual.length === 0) zeroResidual += 1;
      if (lane.lane === "retrospective_finalized_conditional") {
        for (const b of residual) censusAfter[b] = (censusAfter[b] ?? 0) + 1;
      }
    }

    perLane.push({
      lane: lane.lane,
      truth: lane.truth,
      proposalsTotal: input.proposals.length,
      roleResolvable,
      roleStillBlocked,
      proposalsWithNoResidualBlocker: zeroResidual,
    });
    breakdowns[lane.lane] = {
      byBusiness: Object.fromEntries(Object.entries(byBusiness).sort()),
      byAccount: Object.fromEntries(Object.entries(byAccount).sort()),
      bySelectedState: Object.fromEntries(Object.entries(bySelected).sort()),
      byGrain: Object.fromEntries(Object.entries(byGrain).sort()),
      byFold: Object.fromEntries(Object.entries(byFold).sort()),
      byOrigin: Object.fromEntries(Object.entries(byOrigin).sort()),
      byRole: Object.fromEntries(Object.entries(byRole).sort()),
    };
  }

  for (const p of input.proposals) {
    if (proposalCampaignIdentity(p)) joinable += 1;
    else {
      unjoinable += 1;
      unjoinableByGrain.push(p.entityGrain);
    }
  }

  // The funnel after the role overlay, in the conditional lane, so the role
  // outcome is not masked by the two blockers D081 already closed.
  const conditional = lanes[2]!;
  const stages: Array<{ stage: string; codes: string[] }> = [
    { stage: "1 - scope", codes: ["account_not_selected", "scope_not_pinned"] },
    {
      stage: "2 - money shape",
      codes: [
        "owner_evidence_absent",
        "budget_field_ambiguous",
        "owner_mode_ambiguous",
        "lifetime_schedule_unretained",
        "budget_value_absent",
        "budget_not_binding",
      ],
    },
    { stage: "3 - delivery", codes: ["parent_not_active", "status_not_active", "status_evidence_absent"] },
    {
      stage: "4 - authority",
      codes: [ROLE_BLOCKER, "commercial_target_absent", "commercial_target_stale", "objective_identity_unknown"],
    },
    {
      stage: "5 - evidence",
      codes: ["spend_evidence_floor", "conversion_evidence_floor", "observation_stale"],
    },
    {
      stage: "6 - change safety",
      codes: ["recent_change_cooldown", "oscillation_risk", "conflicting_transition", "entity_cap"],
    },
  ];
  let survivors = input.proposals.filter((p) => {
    const identity = proposalCampaignIdentity(p);
    return true;
  });
  funnelAfter.push({ stage: "0 - all candidates", survivors: survivors.length, eliminated: 0 });
  for (const stage of stages) {
    const before = survivors.length;
    survivors = survivors.filter((p) => {
      const identity = proposalCampaignIdentity(p);
      const key = identity
        ? scopeOriginKey(p.businessId, p.providerAccountId, identity, p.originDate)
        : null;
      const roleResolved = key !== null && conditional.resolved.has(key);
      return !p.blockers.some(
        (b) =>
          stage.codes.includes(b) &&
          !(D081_CLOSED_BLOCKERS as readonly string[]).includes(b) &&
          !(b === ROLE_BLOCKER && roleResolved),
      );
    });
    funnelAfter.push({ stage: stage.stage, survivors: survivors.length, eliminated: before - survivors.length });
  }

  return {
    denominators: {
      proposals: input.proposals.length,
      origins: input.origins.length,
      bindings: D080_PINNED_BINDINGS.length,
      businesses: D082_BUSINESSES.length,
      note: "Recovered by re-deriving the pinned D080B analysis from its own frozen reads. D082 never re-counts the proposal universe independently.",
    },
    joinability: {
      proposalsWithCampaignIdentity: joinable,
      proposalsWithoutCampaignIdentity: unjoinable,
      unjoinableByGrain: tally(unjoinableByGrain),
      why: "A campaign role is a campaign-scoped fact. An ad-set proposal whose parent campaign was not retained in the D080B snapshot has no identity to join a role to, so it is structurally unreachable for every lane, independent of what the role table contains.",
    },
    perLane,
    breakdowns,
    blockerCensusAfterRoleOverlay: Object.fromEntries(Object.entries(censusAfter).sort()),
    funnelAfterRoleOverlay: funnelAfter,
    exposure: {
      basis: "nominal_proposed_only",
      spendMoved: null,
      revenueMoved: null,
      note: "No proposal was executed, queued, or served. Exposure is the nominal shape of a hypothetical change, never a realised amount.",
    },
  };
}

// ---------------------------------------------------------------------------
// Leakage checks: a later fact must be invisible at the earlier origin, and
// must actually become visible, and change the outcome, once the origin moves.
// ---------------------------------------------------------------------------

export function buildLeakageChecks(window: D082Window): Row[] {
  const [earlier, later] = [window.origins[0]!, window.origins[1]!];
  const cutoffEarlier = originCutoffMs(earlier);
  const cutoffLater = originCutoffMs(later);
  const exactRow = (over: Partial<RoleRow>): RoleRow => ({
    sourceRecordId: "00000000-0000-4000-8000-000000000001",
    businessId: D080_PINNED_BINDINGS[0]!.businessId,
    providerAccountId: D080_PINNED_BINDINGS[0]!.providerAccountId,
    campaignId: "campaign-leak",
    asOfDate: addDays(earlier, -1),
    inferredKind: "main",
    confidenceClass: REQUIRED_CONFIDENCE_CLASS,
    kindSource: REQUIRED_KIND_SOURCE,
    resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    createdAtMs: cutoffEarlier - 86_400_000,
    updatedAtMs: cutoffEarlier - 86_400_000,
    jobRunId: null,
    ...over,
  });

  const knowable = (row: RoleRow, origin: string): boolean => {
    const cutoff = originCutoffMs(origin);
    if (row.asOfDate === null || row.asOfDate >= origin) return false;
    if (row.asOfDate < addDays(origin, -CAMPAIGN_CONTEXT_MAX_AGE_DAYS)) return false;
    if (row.createdAtMs === null || row.createdAtMs > cutoff) return false;
    if (row.updatedAtMs === null || row.updatedAtMs > cutoff) return false;
    return satisfiesRoleAuthority(row, WHAT_IF_VALIDATOR).ok;
  };

  const checks: Row[] = [];

  // 1. An origin-day fact is not knowable when the origin opens.
  const originDay = exactRow({ asOfDate: earlier, createdAtMs: cutoffEarlier, updatedAtMs: cutoffEarlier });
  checks.push({
    family: "as_of_on_origin_day",
    visibleAtEarlierOrigin: knowable(originDay, earlier),
    visibleAfterOriginAdvances: knowable(
      { ...originDay, asOfDate: earlier },
      addDays(earlier, 1),
    ),
    expectation: "invisible at the origin it is dated on, visible once the origin advances past it",
  });

  // 2. A row created after the origin is not knowable at it.
  const createdLater = exactRow({
    asOfDate: addDays(earlier, -1),
    createdAtMs: cutoffLater,
    updatedAtMs: cutoffLater,
  });
  checks.push({
    family: "created_after_origin",
    visibleAtEarlierOrigin: knowable(createdLater, earlier),
    visibleAfterOriginAdvances: knowable(
      { ...createdLater, asOfDate: addDays(later, -1) },
      later,
    ),
    expectation: "invisible while its creation is in the future, visible once the origin passes its creation",
  });

  // 3. A row rewritten after the origin cannot be reconstructed at it.
  const rewritten = exactRow({ updatedAtMs: cutoffLater });
  checks.push({
    family: "mutable_prior_version_unreconstructible",
    visibleAtEarlierOrigin: knowable(rewritten, earlier),
    visibleAfterOriginAdvances: knowable(
      { ...rewritten, asOfDate: addDays(later, -1) },
      later,
    ),
    expectation: "excluded while its rewrite is in the future of the origin, usable once the origin passes the rewrite",
  });

  // 4. A retired identity never becomes knowable, at any origin.
  const retired = exactRow({ resolverVersion: RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS[0] ?? "retired" });
  checks.push({
    family: "retired_resolver_identity",
    visibleAtEarlierOrigin: knowable(retired, earlier),
    visibleAfterOriginAdvances: knowable({ ...retired, asOfDate: addDays(later, -1) }, later),
    expectation: "never knowable at any origin",
  });

  // 5. A manual origin never becomes knowable, at any origin.
  const manual = exactRow({ kindSource: "manual" });
  checks.push({
    family: "manual_kind_source",
    visibleAtEarlierOrigin: knowable(manual, earlier),
    visibleAfterOriginAdvances: knowable({ ...manual, asOfDate: addDays(later, -1) }, later),
    expectation: "never knowable at any origin",
  });

  return checks;
}

/** Cross-scope isolation, measured on the real read rather than asserted. */
export function buildIsolationChecks(
  snapshot: Record<string, D082MaterialisedRead[]>,
): Row[] {
  const perBinding = new Map<string, Set<string>>();
  const accountsSeen = new Map<string, Set<string>>();
  for (const read of snapshot.roleProvenanceAccountScoped ?? []) {
    const key = bindingKey(read.businessId ?? "", read.providerAccountId ?? "");
    const campaigns = perBinding.get(key) ?? new Set<string>();
    const accounts = accountsSeen.get(key) ?? new Set<string>();
    for (const row of read.rows) {
      const campaignId = trimmedText(row.campaign_id);
      const account = rawText(row.provider_account_id);
      if (campaignId) campaigns.add(campaignId);
      if (account !== null) accounts.add(account);
    }
    perBinding.set(key, campaigns);
    accountsSeen.set(key, accounts);
  }

  const swafSelected = bindingKey(
    "172d0ab8-495b-4679-a4c6-ffa404c389d3",
    "act_822913786458311",
  );
  const swafUnselected = bindingKey(
    "172d0ab8-495b-4679-a4c6-ffa404c389d3",
    "act_921275999286619",
  );
  const selectedCampaigns = perBinding.get(swafSelected) ?? new Set<string>();
  const unselectedCampaigns = perBinding.get(swafUnselected) ?? new Set<string>();
  const swafOverlap = [...selectedCampaigns].filter((c) => unselectedCampaigns.has(c));

  const foreignAccountRows: string[] = [];
  for (const [key, accounts] of accountsSeen) {
    const expected = key.split("|")[1] ?? "";
    for (const account of accounts) {
      if (account !== expected) foreignAccountRows.push(`${key} returned ${account}`);
    }
  }

  // The role read is empty on this database, so the separation check above is
  // vacuous. Repeat it on a source that does carry rows, so the claim that the
  // two TheSwaf accounts never contaminate each other is actually tested.
  const laneCByBinding = new Map<string, Set<string>>();
  const laneCForeign: string[] = [];
  for (const read of snapshot.laneCCreativeDays ?? []) {
    const key = bindingKey(read.businessId ?? "", read.providerAccountId ?? "");
    const campaigns = laneCByBinding.get(key) ?? new Set<string>();
    for (const row of read.rows) {
      const campaignId = trimmedText(row.campaign_id);
      const account = trimmedText(row.provider_account_id);
      if (campaignId) campaigns.add(campaignId);
      if (account && account !== (key.split("|")[1] ?? "")) {
        laneCForeign.push(`${key} returned ${account}`);
      }
    }
    laneCByBinding.set(key, campaigns);
  }
  const laneCSelected = laneCByBinding.get(swafSelected) ?? new Set<string>();
  const laneCUnselected = laneCByBinding.get(swafUnselected) ?? new Set<string>();
  const laneCOverlap = [...laneCSelected].filter((c) => laneCUnselected.has(c));
  const crossBinding: string[] = [];
  const seenCampaign = new Map<string, string>();
  for (const [key, campaigns] of laneCByBinding) {
    for (const campaignId of campaigns) {
      const previous = seenCampaign.get(campaignId);
      if (previous && previous !== key) crossBinding.push(`${campaignId}: ${previous} and ${key}`);
      else seenCampaign.set(campaignId, key);
    }
  }

  return [
    {
      check: "every returned role row carries exactly the requested physical account",
      source: ROLE_TABLE,
      foreignAccountRows: foreignAccountRows.length,
      campaignsObserved: [...perBinding.values()].reduce((a, c) => a + c.size, 0),
      vacuous: [...perBinding.values()].every((c) => c.size === 0),
      pass: foreignAccountRows.length === 0,
    },
    {
      check: "TheSwaf selected and deselected accounts never share a campaign in the role read",
      source: ROLE_TABLE,
      selectedCampaigns: selectedCampaigns.size,
      unselectedCampaigns: unselectedCampaigns.size,
      overlappingCampaigns: swafOverlap.length,
      vacuous: selectedCampaigns.size === 0 && unselectedCampaigns.size === 0,
      pass: swafOverlap.length === 0,
    },
    {
      check: "the role read is keyed by business and physical account, never by campaign alone",
      source: ROLE_TABLE,
      distinctBindingsRead: perBinding.size,
      vacuous: false,
      pass: perBinding.size === D080_PINNED_BINDINGS.length,
    },
    {
      check: "every returned account-scoped warehouse row carries exactly the requested physical account",
      source: "meta_creative_daily",
      foreignAccountRows: laneCForeign.length,
      campaignsObserved: [...laneCByBinding.values()].reduce((a, c) => a + c.size, 0),
      vacuous: [...laneCByBinding.values()].every((c) => c.size === 0),
      pass: laneCForeign.length === 0,
    },
    {
      check: "TheSwaf selected and deselected accounts never share a campaign in a source that has rows",
      source: "meta_creative_daily",
      selectedCampaigns: laneCSelected.size,
      unselectedCampaigns: laneCUnselected.size,
      overlappingCampaigns: laneCOverlap.length,
      vacuous: laneCSelected.size === 0 || laneCUnselected.size === 0,
      pass: laneCOverlap.length === 0,
    },
    {
      check: "no campaign id appears under two different bindings",
      source: "meta_creative_daily",
      crossBindingCampaigns: crossBinding.length,
      distinctCampaigns: seenCampaign.size,
      vacuous: seenCampaign.size === 0,
      pass: crossBinding.length === 0,
    },
  ];
}

/**
 * What the role table actually contains, derived from the whole-table census
 * rather than from the window. This is the finding D080B could not make,
 * because its role read retained neither provenance column.
 */
export function buildRoleProvenanceFinding(roleCensus: readonly Row[]): Row {
  const total = roleCensus.reduce((a, r) => a + Number(r.rows ?? 0), 0);
  const accountScoped = roleCensus
    .filter((r) => r.account_is_null === false)
    .reduce((a, r) => a + Number(r.rows ?? 0), 0);
  const weigh = (field: string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of roleCensus) {
      const key = String(r[field] ?? "null");
      out[key] = (out[key] ?? 0) + Number(r.rows ?? 0);
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const versions = weigh("resolver_version");
  const atCompiled = versions[CAMPAIGN_CONTEXT_RESOLVER_VERSION] ?? 0;
  const atRetired = [
    ...RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS,
    ...RETIRED_CAMPAIGN_CONTEXT_RESOLVER_V3_VERSIONS,
  ].reduce((a, v) => a + (versions[v] ?? 0), 0);
  return {
    rowsWholeTable: total,
    accountScopedRows: accountScoped,
    legacyNullAccountRows: total - accountScoped,
    resolverVersionCensus: versions,
    kindSourceCensus: weigh("kind_source"),
    confidenceClassCensus: weigh("confidence_class"),
    rowsAtCompiledIdentity: atCompiled,
    rowsAtRetiredIdentity: atRetired,
    distinctResolverIdentities: Object.keys(versions),
    finding:
      accountScoped === 0 && atCompiled === 0
        ? "Every retained row is legacy null-account and none carries the compiled resolver identity, so no row can be runtime authority under any env state. The account-scoped producer has never written a row for these businesses."
        : "Account-scoped or compiled-identity rows exist; the censuses carry the split.",
  };
}

// ---------------------------------------------------------------------------
// Pinned inputs
// ---------------------------------------------------------------------------

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
}

export function assertPinnedInputs(): Record<string, string> {
  const pins: Array<[string, string, string]> = [
    ["d080aArtifact", D082_PINNED_INPUTS.d080aArtifactPath, D082_PINNED_INPUTS.d080aArtifactSha256],
    ["d080bArtifact", D082_PINNED_INPUTS.d080bArtifactPath, D082_PINNED_INPUTS.d080bArtifactSha256],
    ["d081Artifact", D082_PINNED_INPUTS.d081ArtifactPath, D082_PINNED_INPUTS.d081ArtifactSha256],
    ["h11bBundle", D082_PINNED_INPUTS.h11bBundlePath, D082_PINNED_INPUTS.h11bBundleSha256],
    ["h11bEvalArtifact", D082_PINNED_INPUTS.h11bEvalArtifactPath, D082_PINNED_INPUTS.h11bEvalArtifactSha256],
  ];
  const observed: Record<string, string> = {};
  for (const [label, path, expected] of pins) {
    const actual = fileSha256(path);
    if (actual !== expected) {
      throw new Error(
        `D082 refuses to run: ${label} hash drift (expected ${expected}, observed ${actual})`,
      );
    }
    observed[label] = actual;
  }
  return observed;
}

/** The pinned D080B analysis, re-derived from its own frozen reads. */
export function loadD080BAnalysis(): {
  proposals: BudgetResearchProposal[];
  origins: OriginPlan[];
  snapshotHash: string;
} {
  const artifact = JSON.parse(
    readFileSync(resolve(D082_PINNED_INPUTS.d080bArtifactPath), "utf8"),
  ) as Record<string, Row>;
  const snapshot = (artifact.snapshot ?? {}) as Row;
  const reads = (snapshot.reads ?? []) as D080BMaterialisedRead[];
  const snapshotHash = String(snapshot.snapshotHash ?? "");
  const analysis = analyseD080B({ ...materialiseD080BSnapshot(reads), snapshotHash });
  return { proposals: analysis.proposals, origins: analysis.origins, snapshotHash };
}

// ---------------------------------------------------------------------------
// Replay: everything below is pure with respect to the database
// ---------------------------------------------------------------------------

export interface D082Analysis {
  window: D082Window;
  schemaCensus: Row[];
  roleCensus: Row[];
  roleProvenanceFinding: Row;
  laneA: LaneAResult;
  laneB: LaneBResult;
  legacyCensus: LegacyCensusResult;
  laneC: LaneCResult;
  laneCTemporalControls: Row;
  laneD: LaneDResult;
  proposalImpact: ProposalImpactResult;
  leakageChecks: Row[];
  isolationChecks: Row[];
  reconciliation: Row[];
}

export function analyse(reads: readonly D082MaterialisedRead[]): D082Analysis {
  const snapshot = materialiseSnapshot(reads);
  const d080b = loadD080BAnalysis();
  const window = planWindow(d080b.origins);

  const schemaCensus = (snapshot.roleSchemaCensus ?? []).flatMap((r) => r.rows);
  const roleCensus = (snapshot.roleCensus ?? []).flatMap((r) =>
    r.rows.map((row) => ({ businessId: r.businessId, ...row })),
  );

  const roleProvenanceFinding = buildRoleProvenanceFinding(roleCensus);
  const laneA = computeLaneA(snapshot, window);
  const laneB = computeLaneB(snapshot, window);
  const legacyCensus = computeLegacyCensus(snapshot, window);
  const laneC = computeLaneC(snapshot, window);
  const laneCTemporalControls = computeLaneCTemporalControls(snapshot, window);

  const bundle = JSON.parse(
    readFileSync(resolve(D082_PINNED_INPUTS.h11bBundlePath), "utf8"),
  ) as Record<string, unknown>;
  const protocol = JSON.parse(
    readFileSync(resolve(D082_PINNED_INPUTS.h11bEvalArtifactPath), "utf8"),
  ) as Record<string, unknown>;
  const laneD = computeLaneD(bundle, protocol);

  const proposalImpact = computeProposalImpact({
    proposals: d080b.proposals,
    origins: d080b.origins,
    laneA,
    laneB,
    laneC,
  });

  const reconciliation = buildReconciliation({
    proposals: d080b.proposals,
    origins: d080b.origins,
    proposalImpact,
    laneA,
    laneB,
    laneC,
  });

  return {
    window,
    schemaCensus,
    roleCensus,
    roleProvenanceFinding,
    laneA,
    laneB,
    legacyCensus,
    laneC,
    laneCTemporalControls,
    laneD,
    proposalImpact,
    leakageChecks: buildLeakageChecks(window),
    isolationChecks: buildIsolationChecks(snapshot),
    reconciliation,
  };
}

/**
 * Every published denominator must add back up to the population it claims to
 * partition. A reconciliation row that does not balance is a defect, not a
 * footnote.
 */
export function buildReconciliation(input: {
  proposals: readonly BudgetResearchProposal[];
  origins: readonly OriginPlan[];
  proposalImpact: ProposalImpactResult;
  laneA: LaneAResult;
  laneB: LaneBResult;
  laneC: LaneCResult;
}): Row[] {
  const total = input.proposals.length;
  const out: Row[] = [];

  for (const lane of input.proposalImpact.perLane) {
    const resolvable = Number(lane.roleResolvable ?? 0);
    const blocked = Number(lane.roleStillBlocked ?? 0);
    out.push({
      check: `${lane.lane}: resolvable + still blocked = proposals`,
      left: resolvable + blocked,
      right: total,
      balances: resolvable + blocked === total,
    });
  }

  out.push({
    check: "joinable + unjoinable = proposals",
    left:
      Number(input.proposalImpact.joinability.proposalsWithCampaignIdentity ?? 0) +
      Number(input.proposalImpact.joinability.proposalsWithoutCampaignIdentity ?? 0),
    right: total,
    balances:
      Number(input.proposalImpact.joinability.proposalsWithCampaignIdentity ?? 0) +
        Number(input.proposalImpact.joinability.proposalsWithoutCampaignIdentity ?? 0) ===
      total,
  });

  for (const [laneName, breakdown] of Object.entries(input.proposalImpact.breakdowns)) {
    const b = breakdown as Record<string, Record<string, number>>;
    const resolvable = Number(
      (input.proposalImpact.perLane.find((l) => l.lane === laneName)?.roleResolvable as number) ?? 0,
    );
    for (const axis of ["byBusiness", "byAccount", "bySelectedState", "byGrain", "byFold", "byOrigin", "byRole"]) {
      const sum = Object.values(b[axis] ?? {}).reduce((a, c) => a + c, 0);
      out.push({
        check: `${laneName}.${axis} sums to the lane's resolvable count`,
        left: sum,
        right: resolvable,
        balances: sum === resolvable,
      });
    }
  }

  out.push({
    check: "lane A per-origin authoritative sums to the lane total",
    left: input.laneA.byOrigin.reduce((a, r) => a + Number(r.authoritative ?? 0), 0),
    right: input.laneA.authoritative,
    balances:
      input.laneA.byOrigin.reduce((a, r) => a + Number(r.authoritative ?? 0), 0) ===
      input.laneA.authoritative,
  });
  out.push({
    check: "lane B per-origin resolved sums to the lane total",
    left: input.laneB.byOrigin.reduce((a, r) => a + Number(r.resolved ?? 0), 0),
    right: input.laneB.resolvedScopeOrigins,
    balances:
      input.laneB.byOrigin.reduce((a, r) => a + Number(r.resolved ?? 0), 0) ===
      input.laneB.resolvedScopeOrigins,
  });
  out.push({
    check: "lane C per-origin scored sums to the lane total",
    left: input.laneC.byOrigin.reduce((a, r) => a + Number(r.scored ?? 0), 0),
    right: input.laneC.campaignOriginsScored,
    balances:
      input.laneC.byOrigin.reduce((a, r) => a + Number(r.scored ?? 0), 0) ===
      input.laneC.campaignOriginsScored,
  });
  out.push({
    check: "lane C per-binding scored sums to the lane total",
    left: input.laneC.perBinding.reduce((a, r) => a + Number(r.campaignOriginsScored ?? 0), 0),
    right: input.laneC.campaignOriginsScored,
    balances:
      input.laneC.perBinding.reduce((a, r) => a + Number(r.campaignOriginsScored ?? 0), 0) ===
      input.laneC.campaignOriginsScored,
  });

  return out;
}

export function analysisHashOf(analysis: D082Analysis): string {
  return sha256Canonical(analysis);
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export const HASH_META_KEYS = new Set(["sectionHashes", "artifactHash", "analysisHash"]);

export function sealArtifact(artifact: Record<string, unknown>): Record<string, unknown> {
  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash"));
  return { ...body, artifactHash: sha256Canonical(body) };
}

export function assembleArtifact(input: {
  collected: CollectedEvidence;
  analysis: D082Analysis;
  authority: Record<string, unknown>;
  pinnedInputHashes: Record<string, string>;
  snapshotHash: string;
}): Record<string, unknown> {
  const { collected, analysis } = input;
  const proof = collected.proof;
  const body: Record<string, unknown> = {
    contract: D082_CONTRACT_ID,
    truthLabels: [...D082_TRUTH_LABELS],
    lanes: [...D082_LANES],
    provenance: {
      retrievedAt: trimmedText(proof.retrieved_at),
      transactionIsolation: trimmedText(proof.transaction_isolation),
      transactionReadOnly: trimmedText(proof.transaction_read_only),
      statementTimeout: trimmedText(proof.statement_timeout),
      lockTimeout: trimmedText(proof.lock_timeout),
      snapshotHash: input.snapshotHash,
      analysisHash: analysisHashOf(analysis),
      queryContractSha256: D082_QUERY_CONTRACT_SHA256,
      pinnedInputHashes: input.pinnedInputHashes,
      executionAuthority: input.authority,
      readLedger: collected.ledger,
      readFailures: collected.ledger.filter((e) => e.status !== "ok"),
      note: "SELECT only, inside one REPEATABLE READ READ ONLY transaction with a savepoint per optional read. No write of any kind, no provider call, no entity names or PII, no credential or env value.",
    },
    scope: {
      bindings: D080_PINNED_BINDINGS.map((b) => ({
        business: b.business,
        businessId: b.businessId,
        providerAccountId: b.providerAccountId,
        accountSelected: b.isSelected,
      })),
      businesses: D082_BUSINESSES,
      table: ROLE_TABLE,
      compiledResolverIdentity: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      challengerResolverIdentity: CAMPAIGN_CONTEXT_RESOLVER_V3_VERSION,
      retiredResolverIdentities: [
        ...RETIRED_CAMPAIGN_CONTEXT_RESOLVER_VERSIONS,
        ...RETIRED_CAMPAIGN_CONTEXT_RESOLVER_V3_VERSIONS,
      ],
      featureWindowDays: FEATURE_WINDOW_DAYS,
      sourceWindowDays: SOURCE_WINDOW_DAYS,
      freshnessMaxAgeDays: CAMPAIGN_CONTEXT_MAX_AGE_DAYS,
    },
    window: analysis.window,
    snapshot: { snapshotHash: input.snapshotHash, reads: collected.reads },
    schemaCensus: analysis.schemaCensus,
    roleCensus: analysis.roleCensus,
    roleProvenanceFinding: analysis.roleProvenanceFinding,
    laneA: analysis.laneA,
    laneB: analysis.laneB,
    legacyCensus: analysis.legacyCensus,
    laneC: analysis.laneC,
    laneCTemporalControls: analysis.laneCTemporalControls,
    laneD: analysis.laneD,
    proposalImpact: analysis.proposalImpact,
    leakageChecks: analysis.leakageChecks,
    isolationChecks: analysis.isolationChecks,
    reconciliation: analysis.reconciliation,
    limits: {
      executable: false,
      providerMutation: null,
      causalClaims: { roasLift: null, revenueLift: null, purchaseLift: null, profitLift: null, spendLift: null },
      note: "This package measures classification and counterfactual proposal coverage only. No spend moved, no outcome occurred, and no causal effect is claimed or estimated.",
      offlineVerifierLimit:
        "An offline verifier cannot detect a wholesale re-forge in which the reads and every derived output are replaced consistently with one another. What binds this package to reality is the real-DB extraction inside a server-asserted read-only transaction and the pinned predecessor hashes.",
    },
  };
  return sealArtifact(body);
}

// ---------------------------------------------------------------------------
// Verify: every section is re-derived from snapshot.reads plus module constants
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  failures: string[];
  checked: string[];
}

export function verifyArtifact(artifact: Record<string, unknown>): VerifyResult {
  const failures: string[] = [];
  const checked: string[] = [];
  const fail = (section: string, why: string) => failures.push(`${section}: ${why}`);

  if (artifact.contract !== D082_CONTRACT_ID) fail("contract", `expected ${D082_CONTRACT_ID}`);
  checked.push("contract");

  const provenance = (artifact.provenance ?? {}) as Record<string, unknown>;
  const snapshot = (artifact.snapshot ?? {}) as Record<string, unknown>;
  const reads = (snapshot.reads ?? []) as D082MaterialisedRead[];

  if (!Array.isArray(reads) || reads.length === 0) {
    fail("snapshot.reads", "no reads are carried, so nothing can be re-derived");
    return { ok: false, failures, checked };
  }

  // 1. The snapshot hash is recomputed from the reads, never read back.
  const recomputedSnapshotHash = sha256Canonical(snapshotBodyOf(reads));
  if (recomputedSnapshotHash !== snapshot.snapshotHash) {
    fail("snapshot.reads", "snapshot_hash_mismatch");
  }
  if (recomputedSnapshotHash !== provenance.snapshotHash) {
    fail("provenance.snapshotHash", "snapshot_hash_mismatch");
  }
  checked.push("snapshot.snapshotHash");

  // 2. The server proof must actually say read-only and repeatable read.
  if (provenance.transactionReadOnly !== "on") fail("provenance", "transaction was not READ ONLY");
  if (provenance.transactionIsolation !== "repeatable read") {
    fail("provenance", "transaction was not REPEATABLE READ");
  }
  checked.push("provenance.readOnlyProof");

  // 3. Pinned predecessors must still be byte-identical on disk.
  const pinned = (provenance.pinnedInputHashes ?? {}) as Record<string, string>;
  for (const [label, path, expected] of [
    ["d080aArtifact", D082_PINNED_INPUTS.d080aArtifactPath, D082_PINNED_INPUTS.d080aArtifactSha256],
    ["d080bArtifact", D082_PINNED_INPUTS.d080bArtifactPath, D082_PINNED_INPUTS.d080bArtifactSha256],
    ["d081Artifact", D082_PINNED_INPUTS.d081ArtifactPath, D082_PINNED_INPUTS.d081ArtifactSha256],
    ["h11bBundle", D082_PINNED_INPUTS.h11bBundlePath, D082_PINNED_INPUTS.h11bBundleSha256],
    ["h11bEvalArtifact", D082_PINNED_INPUTS.h11bEvalArtifactPath, D082_PINNED_INPUTS.h11bEvalArtifactSha256],
  ] as const) {
    if (pinned[label] !== expected) fail("provenance.pinnedInputHashes", `${label} not pinned to the module constant`);
    let onDisk: string | null = null;
    try {
      onDisk = fileSha256(path);
    } catch {
      onDisk = null;
    }
    if (onDisk !== expected) fail("provenance.pinnedInputHashes", `${label} drifted on disk`);
  }
  checked.push("provenance.pinnedInputHashes");

  // 4. The query contract must be the module's, not the artifact's own claim.
  if (provenance.queryContractSha256 !== D082_QUERY_CONTRACT_SHA256) {
    fail("provenance.queryContractSha256", "query_contract_mismatch");
  }
  checked.push("provenance.queryContractSha256");

  // 5. Ledger counts and row hashes are recomputed from the kept rows, and the
  //    invocation set is rebuilt from the reads rather than believed.
  const ledger = (provenance.readLedger ?? []) as D082LedgerEntry[];
  const readByKey = new Map(reads.map((r) => [r.invocationKey, r]));
  const executed = ledger.filter((e) => e.disposition === "execute" && e.status === "ok");
  if (executed.length !== reads.length) {
    fail("provenance.readLedger", "invocation_set_mismatch");
  }
  for (const entry of executed) {
    const read = readByKey.get(entry.invocationKey);
    if (!read) {
      fail("provenance.readLedger", `ledger row ${entry.invocationKey} has no kept read`);
      continue;
    }
    if (entry.rows !== read.rows.length) {
      fail("provenance.readLedger", `slice_count_mismatch on ${entry.invocationKey}`);
    }
    if (entry.sourceRowHash !== sha256Canonical(read.rows)) {
      fail("provenance.readLedger", `slice_hash_mismatch on ${entry.invocationKey}`);
    }
    if (!ALLOWED_STATEMENTS_HASHES.has(entry.statementSha256 ?? "")) {
      fail("provenance.readLedger", `statement on ${entry.invocationKey} is not in the pinned query contract`);
    }
  }
  const declaredFailures = (provenance.readFailures ?? []) as D082LedgerEntry[];
  if (declaredFailures.length !== ledger.filter((e) => e.status !== "ok").length) {
    fail("provenance.readFailures", "readFailures is not the exact multiset of non-ok ledger rows");
  }
  checked.push("provenance.readLedger");

  // 6. Identity pinning: no read may address an unpinned scope.
  for (const read of reads) {
    if (read.businessId && !PINNED_BUSINESS_SET.has(read.businessId)) {
      fail("snapshot.reads", `identity_not_pinned: ${read.invocationKey}`);
    }
    if (
      read.businessId &&
      read.providerAccountId &&
      !PINNED_BINDING_SET.has(bindingKey(read.businessId, read.providerAccountId))
    ) {
      fail("snapshot.reads", `identity_not_pinned: ${read.invocationKey}`);
    }
  }
  checked.push("snapshot.reads.identityPinning");

  // 7. Every derived section is re-run and compared field for field.
  let rebuilt: D082Analysis;
  try {
    rebuilt = analyse(reads);
  } catch (error) {
    fail("analysis", `re-derivation threw: ${(error as Error).message.split("\n")[0]}`);
    return { ok: false, failures, checked };
  }
  if (analysisHashOf(rebuilt) !== provenance.analysisHash) {
    fail("provenance.analysisHash", "analysis_hash_mismatch");
  }
  for (const section of [
    "window",
    "schemaCensus",
    "roleCensus",
    "roleProvenanceFinding",
    "laneA",
    "laneB",
    "legacyCensus",
    "laneC",
    "laneCTemporalControls",
    "laneD",
    "proposalImpact",
    "leakageChecks",
    "isolationChecks",
    "reconciliation",
  ] as const) {
    if (canonicalJson(artifact[section] ?? null) !== canonicalJson(rebuilt[section] ?? null)) {
      fail(section, "derived_output_mismatch");
    }
    checked.push(section);
  }

  // 8. The published reconciliations must actually balance.
  for (const row of rebuilt.reconciliation) {
    if (row.balances !== true) fail("reconciliation", `does not balance: ${String(row.check)}`);
  }
  checked.push("reconciliation.balances");

  // 9. The leakage negative controls must behave in both directions.
  for (const check of rebuilt.leakageChecks) {
    if (check.visibleAtEarlierOrigin !== false) {
      fail("leakageChecks", `${String(check.family)} was visible at the earlier origin`);
    }
  }
  const advancing = rebuilt.leakageChecks.filter(
    (c) => c.family === "as_of_on_origin_day" || c.family === "created_after_origin" || c.family === "mutable_prior_version_unreconstructible",
  );
  if (!advancing.every((c) => c.visibleAfterOriginAdvances === true)) {
    fail("leakageChecks", "a future fact never became visible after the origin advanced, so the control is vacuous");
  }
  const never = rebuilt.leakageChecks.filter(
    (c) => c.family === "retired_resolver_identity" || c.family === "manual_kind_source",
  );
  if (!never.every((c) => c.visibleAfterOriginAdvances === false)) {
    fail("leakageChecks", "a retired identity or manual origin became knowable at a later origin");
  }
  checked.push("leakageChecks.bothDirections");

  // 10. The Lane C temporal contract must hold, in both directions.
  const controls = rebuilt.laneCTemporalControls;
  if (controls.status !== "runnable") {
    fail("laneCTemporalControls", `not runnable: ${String(controls.why ?? "unknown")}`);
  } else {
    for (const control of (controls.controls ?? []) as Row[]) {
      if (control.pass !== true) {
        fail("laneCTemporalControls", `${String(control.control)} did not hold`);
      }
      if (control.nonVacuous !== true) {
        fail("laneCTemporalControls", `${String(control.control)} is vacuous, so it proves nothing`);
      }
    }
    if (controls.allPass !== true) fail("laneCTemporalControls", "a temporal control failed");
    if (controls.allNonVacuous !== true) fail("laneCTemporalControls", "a temporal control is vacuous");
  }
  const guards = (rebuilt.laneC.boundaryGuards ?? {}) as Row;
  if (Number(guards.firstSpendAfterScoringDay ?? -1) !== 0) {
    fail("laneC.boundaryGuards", "a creative was admitted whose first spend is after the scoring day");
  }
  if (Number(guards.firstSeenAfterCeiling ?? -1) !== 0) {
    fail("laneC.boundaryGuards", "a campaign first-seen date exceeded its ceiling");
  }
  if (rebuilt.window.laneCLastScoredDay !== addDays(rebuilt.window.lastOrigin, -1)) {
    fail("window", "the last Lane C scoring day is not the day before the last origin");
  }
  checked.push("laneCTemporalControls");

  // 11. Isolation must hold on the real read.
  for (const check of rebuilt.isolationChecks) {
    if (check.pass !== true) fail("isolationChecks", String(check.check));
  }
  if (!rebuilt.isolationChecks.some((c) => c.vacuous === false && c.pass === true)) {
    fail("isolationChecks", "every isolation check is vacuous, so nothing was actually proven");
  }
  checked.push("isolationChecks");

  // 12. The seal is the last and weakest check.
  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash"));
  if (sha256Canonical(body) !== artifact.artifactHash) fail("artifactHash", "artifact_hash_mismatch");
  checked.push("artifactHash");

  return { ok: failures.length === 0, failures, checked: sortedUnique(checked) };
}

const ALLOWED_STATEMENTS_HASHES = new Set(
  Object.values(D082_QUERIES).map((s) => createHash("sha256").update(s).digest("hex")),
);

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

function snapshotFlags(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(D082_FORBIDDEN_TRUTHY_FLAGS.map((f) => [f, env[f]]));
}

function isTruthyFlagValue(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on", "enabled"].includes(value.trim().toLowerCase());
}

export function evaluateExecutionAuthority(
  before: Record<string, string | undefined>,
  after: Record<string, string | undefined>,
): Record<string, unknown> {
  const truthyBefore = D082_FORBIDDEN_TRUTHY_FLAGS.filter((f) => isTruthyFlagValue(before[f]));
  const truthyAfter = D082_FORBIDDEN_TRUTHY_FLAGS.filter((f) => isTruthyFlagValue(after[f]));
  return {
    ok: truthyBefore.length === 0 && truthyAfter.length === 0,
    truthyBefore,
    truthyAfter,
    changedByLoader: D082_FORBIDDEN_TRUTHY_FLAGS.filter(
      (f) => (before[f] ?? null) !== (after[f] ?? null),
    ).map((flag) => ({ flag, before: before[flag] ?? null, after: after[flag] ?? null })),
    campaignContextAuthorityResolverVersionSet:
      typeof after[CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV] === "string" &&
      (after[CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV] ?? "").trim().length > 0,
  };
}

export async function runExtract(): Promise<void> {
  const pinnedInputHashes = assertPinnedInputs();

  const before = snapshotFlags(process.env);
  const runtime = await import("@/scripts/_operational-runtime");
  runtime.configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const after = {
    ...snapshotFlags(process.env),
    [CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV]:
      process.env[CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV],
  };
  const authority = evaluateExecutionAuthority(before, after);
  if (authority.ok !== true) {
    throw new Error(
      `D082 refuses to read: execution authority is present (${[
        ...(authority.truthyBefore as string[]),
        ...(authority.truthyAfter as string[]),
      ].join(", ")}). This guard never overrides a flag to pass.`,
    );
  }

  const db = await import("@/lib/db");
  const ledger: D082LedgerEntry[] = [];
  const reads: D082MaterialisedRead[] = [];
  const window = planWindow(loadD080BAnalysis().origins);

  const collected = await db.runDbTransaction(async () => {
    const sql = db.getDb();
    await sql.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await sql.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await sql.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    const [proof] = await sql.query<Row>(
      `SELECT now()::text AS retrieved_at,
              current_setting('transaction_isolation') AS transaction_isolation,
              current_setting('transaction_read_only') AS transaction_read_only,
              current_setting('statement_timeout') AS statement_timeout,
              current_setting('lock_timeout') AS lock_timeout`,
    );
    if (trimmedText(proof?.transaction_read_only) !== "on") {
      throw new Error("D082 refuses to run outside a READ ONLY transaction");
    }
    if (trimmedText(proof?.transaction_isolation) !== "repeatable read") {
      throw new Error("D082 requires REPEATABLE READ isolation");
    }

    const entryOf = (r: D082Request, over: Partial<D082LedgerEntry>): D082LedgerEntry => ({
      invocationKey: r.invocationKey,
      planKey: r.planKey,
      businessId: r.businessId,
      providerAccountId: r.providerAccountId,
      source: r.source,
      lane: r.lane,
      statementSha256: r.statementSha256,
      paramsSha256: r.paramsSha256,
      knowledgeTo: r.knowledgeTo,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      disposition: "execute",
      status: "ok",
      rows: 0,
      sourceRowHash: null,
      reason: null,
      ...over,
    });

    const safeQ: SafeQ = async (request) => {
      assertRequestIsInScope(request);
      await sql.query("SAVEPOINT d082");
      try {
        const rows = await sql.query<Row>(request.statement, request.params);
        await sql.query("RELEASE SAVEPOINT d082");
        reads.push({
          invocationKey: request.invocationKey,
          planKey: request.planKey,
          businessId: request.businessId,
          providerAccountId: request.providerAccountId,
          source: request.source,
          lane: request.lane,
          effectiveFrom: request.effectiveFrom,
          effectiveTo: request.effectiveTo,
          knowledgeTo: request.knowledgeTo,
          rows,
        });
        ledger.push(entryOf(request, { rows: rows.length, sourceRowHash: sha256Canonical(rows) }));
        return rows;
      } catch (error) {
        await sql.query("ROLLBACK TO SAVEPOINT d082");
        ledger.push(
          entryOf(request, {
            status: "unknown/source_read_failed",
            rows: null,
            sourceRowHash: null,
            reason: (error as Error).message.split("\n")[0]!.slice(0, 160),
          }),
        );
        return [];
      }
    };

    return collectEvidence({ proof, safeQ, window, ledger, reads });
  });

  const snapshotHash = sha256Canonical(snapshotBodyOf(collected.reads));
  const analysis = analyse(collected.reads);
  const artifact = assembleArtifact({
    collected,
    analysis,
    authority,
    pinnedInputHashes,
    snapshotHash,
  });
  writeFileSync(resolve(D082_JSON_OUT), JSON.stringify(artifact, null, 1));
  console.log(
    JSON.stringify(
      {
        phase: "extract",
        retrievedAt: (artifact.provenance as Row).retrievedAt,
        snapshotHash,
        analysisHash: (artifact.provenance as Row).analysisHash,
        artifactHash: artifact.artifactHash,
        ledgerRows: collected.ledger.length,
        readFailures: collected.ledger.filter((e) => e.status !== "ok").length,
        rowsKept: collected.reads.reduce((a, r) => a + r.rows.length, 0),
        laneAAuthoritative: analysis.laneA.authoritative,
        laneBResolved: analysis.laneB.resolvedScopeOrigins,
        laneCWouldSatisfy: analysis.laneC.wouldSatisfyAuthority,
        openAuthorityGate: analysis.laneD.gate.openAuthorityGate,
      },
      null,
      1,
    ),
  );
}

export function replayFromArtifact(artifact: Record<string, unknown>): {
  analysis: D082Analysis;
  analysisHash: string;
  snapshotHash: string;
} {
  const snapshot = (artifact.snapshot ?? {}) as Record<string, unknown>;
  const reads = (snapshot.reads ?? []) as D082MaterialisedRead[];
  const analysis = analyse(reads);
  return {
    analysis,
    analysisHash: analysisHashOf(analysis),
    snapshotHash: sha256Canonical(snapshotBodyOf(reads)),
  };
}

export function runReplay(path = D082_JSON_OUT): {
  analysisHash: string;
  snapshotHash: string;
  artifactHash: string;
} {
  const artifact = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
  const replayed = replayFromArtifact(artifact);
  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash"));
  const out = {
    analysisHash: replayed.analysisHash,
    snapshotHash: replayed.snapshotHash,
    artifactHash: sha256Canonical(body),
  };
  console.log(JSON.stringify({ phase: "d082-replay", ...out }, null, 1));
  return out;
}

export function runVerify(path = D082_JSON_OUT): VerifyResult {
  const artifact = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
  const result = verifyArtifact(artifact);
  console.log(JSON.stringify({ phase: "d082-verify", ...result }, null, 1));
  return result;
}

const invoked = process.argv[1] ?? "";
if (invoked.includes("d082-meta-role-provenance-replay")) {
  const mode = process.argv[2] ?? "extract";
  if (mode === "extract") {
    runExtract().catch((error) => {
      console.error((error as Error).message);
      process.exitCode = 1;
    });
  } else if (mode === "replay") {
    runReplay();
  } else if (mode === "verify") {
    if (!runVerify().ok) process.exitCode = 1;
  } else {
    console.error(`unknown mode ${mode}`);
    process.exitCode = 2;
  }
}
