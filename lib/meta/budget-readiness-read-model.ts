/**
 * D086 — server-owned readiness read model for the three retention blockers D085
 * r16 left open.
 *
 * Display-only, exactly like the D077 model it sits beside: consumers render these
 * facts verbatim. It never plans, never captures, never writes, never calls a
 * provider, and returns nothing executable. A read failure is an explicit UNKNOWN
 * state — never an empty, ready-looking default.
 *
 * ACCOUNT-SCOPED, AND READY MEANS VALID.
 *
 * Correction 1 rejected r1's version of this file for two related reasons. It took
 * a business id only, so a business with two provider accounts (TheSwaf has two)
 * could have its accounts aggregated into one readiness verdict. And its READY
 * predicates were `count(*)` over a handful of non-null columns, which would have
 * called a dimension ready on partial, stale, malformed, foreign-account or legacy
 * rows. Both are fixed by the same move: every read is scoped to one resolved
 * provider account, and every candidate row is judged by the CANONICAL validator
 * in `budget-readiness-retention` rather than by a second rule invented here.
 */
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  D086_BUDGET_ENDPOINTS,
  D086_CAPABILITY_PROBE_SQL,
  D086_REQUIRED_RUN_COLUMNS,
  D086_REQUIRED_RECEIPT_COLUMNS,
  D086_REQUIRED_STATE_COLUMNS,
  D086_REQUIRED_TOMBSTONE_COLUMNS,
  D086_REQUIRED_PARTITION_COLUMNS,
  D086_REQUIRED_RAW_OBSERVATION_COLUMNS,
  D086_COHORT_LANE,
  D086_COHORT_SCOPES,
  D086_INDEX_CATALOG_SQL,
  D086_REQUIRED_INDEXES,
  classifyIndexCatalog,
  D086_PROFILE_ACTIONS,
  D086_REQUIRED_PROFILE_COLUMNS,
  D086_REQUIRED_ROLE_COLUMNS,
  D086_RETENTION_CONTRACT,
  classifyBudgetUniverse,
  classifyRetainedBudgetFact,
  classifyRetainedProfile,
  qualifyRoleAuthorityRow,
} from "@/lib/meta/budget-readiness-retention";
import { buildCanonicalBudgetFact } from "@/lib/meta/budget-fact";
import { toBudgetObservation } from "@/lib/meta/budget-observation-projection";

export const BUDGET_READINESS_CONTRACT = "d086.budget-readiness-read-model.v9" as const;

/** How many retained rows a dimension samples. Bounded so the read stays cheap. */
export const D086_READINESS_SAMPLE = 500;

/** A retained profile older than this is stale for serve-time purposes. */
export const D086_PROFILE_MAX_AGE_MS = 12 * 3_600_000;

type ReadinessDb = {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<T[]>;
};

/**
 * `forward_only_after_deploy` is a distinct state on purpose. It means the rules
 * exist and are tested, the schema change is prepared, and nothing can accrue until
 * a deploy AND an operator clearing the ingestion fence. It is not "pending" and it
 * must never be read as something that will close on its own.
 *
 * `partial` is the honest middle: some exact rows qualify, but the account-scoped
 * denominator is incomplete. It is never rounded up to ready.
 */
export type ReadinessStatus =
  | "ready"
  | "partial"
  | "forward_only_after_deploy"
  | "unavailable"
  | "unknown";

export interface ReadinessDimension {
  key: "budget_fact_retention" | "profile_output_retention" | "role_authority_retention";
  /** The D085 residual blocker this dimension would close. */
  closesBlocker: string;
  status: ReadinessStatus;
  /** What was actually measured, in the operator's words. */
  evidence: string;
  /** Where the measurement came from. */
  source: string;
  /** The freshest retained observation this dimension depends on, or null. */
  asOf: string | null;
  /**
   * Qualifying out of examined, and the TOTAL latest-per-identity population.
   * A bounded sample can never justify whole-account readiness, so truncation
   * is visible rather than rounded away.
   */
  coverage: {
    qualifying: number;
    examined: number;
    /** `null` when the total could not be measured as a non-negative integer. */
    population: number | null;
    /** Identities whose top-rank rows disagree. Never adjudicated here. */
    conflicts: number;
    /** True when the population exceeds what was examined. */
    truncated: boolean;
    /**
     * The budget universe, when the dimension has one. READY requires every
     * APPLICABLE row to qualify, `ownerUnknown` to be zero and `conflicts` to be
     * zero — a proven non-owner row neither qualifies nor poisons.
     */
    universe?: {
      /** Every latest-per-identity row retained, before any classification. */
      retainedRows: number;
      applicable: number;
      provenNonApplicable: number;
      ownerUnknown: number;
      /** Owners the evidence implies exist but does not contain. */
      uncoveredApplicable: number;
      /** Parent/child pairs whose ownership claims cannot both be true. */
      hierarchyContradictions: number;
      /** Whether a complete, successful observation run covers both grains. */
      completeRunAttested: boolean;
      /** What the manifest says the complete run enumerated. */
      expectedCampaigns: number | null;
      expectedAdsets: number | null;
      observedCampaigns: number;
      observedAdsets: number;
      /** The sync cohort both endpoints named, when they agreed. */
      cohortId: string | null;
      /** Identities the manifest reconstructed, per grain. */
      manifestCampaignMembers: number | null;
      manifestAdsetMembers: number | null;
    };
  } | null;
  /** The single blocker a reader should act on, or null when ready. */
  blocker: string | null;
  /** What must happen, in order, for this dimension to become ready. */
  preconditions: readonly string[];
}

export interface BudgetReadinessReadModel {
  contract: typeof BUDGET_READINESS_CONTRACT;
  businessId: string;
  /** The exact resolved provider account every dimension was measured for. */
  providerAccountId: string | null;
  /** Why no single account resolved, when that is the case. */
  scopeBlocker: string | null;
  /** The resolver compiled into this build; role authority requires it exactly. */
  compiledResolverVersion: string;
  dimensions: readonly ReadinessDimension[];
  /** Every dimension's blocker, deduplicated — the operator's whole list. */
  blockers: readonly string[];
}

/**
 * The scope a readiness read runs in. It comes from the AUTHORIZED ROUTE's own
 * resolution, never from a row and never from a client parameter.
 */
export interface BudgetReadinessScope {
  businessId: string;
  /**
   * The single assigned provider account. `null` when the route could not resolve
   * exactly one — which is a fail-closed scope blocker, not an invitation to
   * aggregate every account the business owns.
   */
  providerAccountId: string | null;
  nowIso: string;
  /**
   * Pass `campaignContextAuthorityResolverVersion()` so route readiness and
   * runtime authority cannot drift. A parameter, so a replay stays pure.
   */
  approvedResolverVersion: string | null;
  /**
   * The EXTERNAL profile identity, when the caller holds it. Absent means
   * agreement cannot be checked, which is reported — never assumed.
   */
  expectedProfileInputFingerprint?: string | null;
  expectedProfileSourceFingerprint?: string | null;
}

/*
  D086 correction 8: `D086_BUDGET_LATEST_SQL` is REMOVED.

  It read `meta_campaign_config_history` / `meta_adset_config_history`, whose
  only writer records transitions and never stamps the D086 source run id.
  Correction 7 stopped executing it; r8 kept exporting it, kept probing its
  columns and kept certifying its shape in tests — dead proof for a statement
  nothing runs. The executed budget read is `D086_STATE_BUDGET_SQL` below.
*/

export const D086_PROFILE_LATEST_SQL = `
  WITH ranked AS (
    SELECT contract, profile_contract, business_id, provider_account_id, action,
           engine_epoch, engine_version, input_fingerprint, source_fingerprint,
           eligible, blocker_code, as_of_date::text AS as_of_date, effective_at, recorded_at,
           rank() OVER (PARTITION BY action ORDER BY recorded_at DESC, effective_at DESC) AS clock_rank
      FROM engine_v3_account_profile_output
     WHERE business_id = $1 AND provider_account_id = $2
  ), top_rank AS (
    SELECT * FROM ranked WHERE clock_rank = 1
  ), per_identity AS (
    SELECT action, count(*) AS tied_rows,
           count(DISTINCT (contract, profile_contract, business_id, provider_account_id,
                           engine_epoch, engine_version, input_fingerprint, source_fingerprint,
                           eligible, blocker_code, as_of_date, effective_at,
                           recorded_at)) AS distinct_truths
      FROM top_rank GROUP BY action
  )
  SELECT t.*, p.tied_rows, p.distinct_truths,
         (SELECT count(*) FROM per_identity) AS population_total
    FROM top_rank t JOIN per_identity p ON p.action = t.action
   ORDER BY t.action
` as const;

/**
 * Legacy migration evidence, business-scoped, with its own atomic total.
 *
 * This branch is NOT account authority and says so wherever it appears. Its
 * population travels with the rows for the same reason the others' do.
 */
export const D086_LEGACY_ROLE_SQL = `
  WITH sampled AS (
    SELECT provider_account_id, resolver_version, confidence_class, kind_source,
           as_of_date::text AS as_of_date
      FROM engine_v3_campaign_context_daily
     WHERE business_id = $1
     ORDER BY as_of_date DESC
     LIMIT $2
  )
  SELECT s.*,
         (SELECT count(*) FROM engine_v3_campaign_context_daily WHERE business_id = $1)
           AS population_total
    FROM sampled s
` as const;

export const D086_ROLE_LATEST_SQL = `
  WITH ranked AS (
    SELECT contract, business_id, provider_account_id, campaign_id,
           as_of_date::text AS as_of_date, inferred_kind, kind_source, resolver_version,
           confidence_class, evidence_hash, input_hash, effective_at, recorded_at, provenance,
           rank() OVER (PARTITION BY campaign_id
                        ORDER BY as_of_date DESC, recorded_at DESC) AS clock_rank
      FROM engine_v3_campaign_role_authority
     WHERE business_id = $1 AND provider_account_id = $2
  ), top_rank AS (
    SELECT * FROM ranked WHERE clock_rank = 1
  ), per_identity AS (
    SELECT campaign_id, count(*) AS tied_rows,
           count(DISTINCT (contract, business_id, provider_account_id, as_of_date,
                           inferred_kind, kind_source, resolver_version, confidence_class,
                           evidence_hash, input_hash, effective_at, recorded_at,
                           provenance)) AS distinct_truths
      FROM top_rank GROUP BY campaign_id
  )
  SELECT t.*, p.tied_rows, p.distinct_truths,
         (SELECT count(*) FROM per_identity) AS population_total
    FROM top_rank t JOIN per_identity p ON p.campaign_id = t.campaign_id
   ORDER BY t.as_of_date DESC, t.campaign_id
   LIMIT $3
` as const;

/**
 * THE COMPLETE-RUN ATTESTATION.
 *
 * Correction 5's root finding: r5 had no authoritative universe at all. It
 * inferred "the account's budget owners" from whatever rows happened to be in
 * config history, so a campaign deferring to its ad-sets and an ad-set deferring
 * back to that campaign counted as TWO proven non-owners and one unrelated row
 * became the entire applicable population — a concrete false READY. Presence of
 * a complementary row can never prove ownership.
 *
 * This reuses the canonical `meta_entity_observation_runs` manifest, which
 * already records, per business + provider account + entity type: whether the
 * run COMPLETED, whether its enumeration was `complete`, how many rows it
 * enumerated, when it was captured, and its snapshot identity. No parallel
 * census is invented; the missing piece was binding the retained budget rows to
 * that run and reconciling the counts, which is what this query and the checks
 * around it add.
 */
/**
 * The BUDGET FACT SOURCE: real observation state history, not config history.
 *
 * r7 read `meta_*_config_history`, whose only writer records TRANSITIONS and
 * never stamps the D086 `source_run_id` — so no retained row could ever attest,
 * and r7's own PostgreSQL evidence was hand-written INSERT fixtures rather than
 * anything a deploy would produce. This reads the rows the real capture path
 * writes, and hands them to the canonical D083 boundary.
 */
export const D086_STATE_BUDGET_SQL = `
  WITH scoped AS (
    SELECT state.entity_type                              AS grain,
           -- Carried so the canonical scope validation can REFUSE a row that
           -- is not this account's, rather than trusting the WHERE clause alone.
           state.business_id,
           state.provider_account_id,
           state.entity_id,
           state.campaign_id,
           state.presence,
           state.run_completeness,
           state.configured_status,
           state.effective_status,
           state.budget_origin,
           state.budget_currency,
           -- The D083 capture columns. r7's read omitted them, so every fact
           -- it built failed the captured-exponent gate by omission rather
           -- than by evidence.
           state.budget_currency_exponent,
           state.budget_currency_registry_version,
           state.budget_shape_support,
           state.campaign_start_time,
           state.campaign_end_time,
           state.adset_start_time,
           state.adset_end_time,
           state.provider_api_version,
           state.state_hash,
           state.id::text                                 AS observation_id,
           state.campaign_daily_budget_raw,
           state.campaign_lifetime_budget_raw,
           state.adset_daily_budget_raw,
           state.adset_lifetime_budget_raw,
           state.field_coverage_json,
           state.provider_updated_at,
           state.observed_at,
           state.captured_at,
           state.created_at,
           state.id,
           state.run_id::text                             AS run_id,
           run.source_snapshot_id,
           run.payload_hash,
           run.run_hash,
           to_char(state.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS observed_on
      FROM meta_entity_state_history state
      JOIN meta_entity_observation_runs run ON run.id = state.run_id
     WHERE state.business_id = $1
       AND state.provider_account_id = $2
       AND state.entity_type IN ('campaign', 'adset')
       AND state.captured_at <= $3::timestamptz
  ), clock_groups AS (
    /*
      EVERY AUTHORITY-RELEVANT FACT, so a same-clock disagreement is visible.

      r8's tuple stopped at the amounts and statuses, so two rows at one clock
      that disagreed about the currency EXPONENT, the registry version, the
      captured shape, the schedule, the provider API version or the run they
      came from coalesced as one truth and the heap chose which to believe.
      Physical identity and created_at are deliberately absent: every row
      differs on those, so including them would make every clock a conflict.
    */
    SELECT grain, entity_id, captured_at,
           count(DISTINCT (campaign_id, presence, run_completeness,
                           configured_status, effective_status,
                           budget_origin, budget_currency,
                           budget_currency_exponent, budget_currency_registry_version,
                           budget_shape_support,
                           campaign_daily_budget_raw, campaign_lifetime_budget_raw,
                           adset_daily_budget_raw, adset_lifetime_budget_raw,
                           campaign_start_time, campaign_end_time,
                           adset_start_time, adset_end_time,
                           provider_api_version, state_hash,
                           run_id, source_snapshot_id))
             AS distinct_truths
      FROM scoped
     GROUP BY grain, entity_id, captured_at
  ), ranked AS (
    SELECT s.*, g.distinct_truths,
           rank() OVER (PARTITION BY s.grain, s.entity_id
                        ORDER BY s.captured_at DESC, s.created_at DESC, s.id DESC)
             AS clock_rank
      FROM scoped s
      JOIN clock_groups g
        ON g.grain = s.grain AND g.entity_id = s.entity_id
       AND g.captured_at = s.captured_at
  ), latest AS (
    /*
      THE CURRENT INVENTORY. An entity whose latest word is an absence has left
      the account's scope: it is not a budget owner, it is not an applicable
      denominator, and counting it made a real scope exit look like a
      reconciliation failure. The manifest enumerates presence the same way.
    */
    SELECT * FROM ranked WHERE clock_rank = 1 AND presence = 'present'
  ), counted AS (
    /*
      THE CURRENT POPULATION, not the row history.

      r8 took count(*) OVER () inside the rank CTE, BEFORE clock_rank = 1, so
      the "population" was every historical state row this account ever wrote.
      One ordinary changed capture made the total exceed the retained identities
      and the account became permanently PARTIAL through a measurement that
      was never about measurement. It is counted over the LATEST set, in the
      same statement and therefore the same snapshot.
    */
    SELECT latest.*, count(*) OVER () AS population_total FROM latest
  )
  /*
    The clocks leave as TEXT. The driver hands back a Date for a timestamptz,
    and the canonical projector reads exact provider strings — a Date arrived as
    a null instant, so every fact resolved to "budget not observed" while the
    rows plainly carried budgets.
  */
  SELECT grain, business_id, provider_account_id, entity_id, campaign_id, presence, run_completeness,
         configured_status, effective_status, budget_origin, budget_currency,
         budget_currency_exponent, budget_currency_registry_version,
         budget_shape_support,
         campaign_start_time::text  AS campaign_start_time,
         campaign_end_time::text    AS campaign_end_time,
         adset_start_time::text     AS adset_start_time,
         adset_end_time::text       AS adset_end_time,
         provider_api_version, state_hash, observation_id,
         campaign_daily_budget_raw, campaign_lifetime_budget_raw,
         adset_daily_budget_raw, adset_lifetime_budget_raw,
         field_coverage_json,
         provider_updated_at::text  AS provider_updated_at,
         observed_at::text          AS observed_at,
         captured_at::text          AS captured_at,
         created_at::text           AS created_at,
         id::text                   AS id,
         run_id, source_snapshot_id, payload_hash, run_hash, observed_on,
         distinct_truths, population_total
    FROM counted ORDER BY grain, entity_id LIMIT $4
` as const;

/** The account time zone the point-in-time cutoff needs, from captured evidence. */
export const D086_ACCOUNT_TIMEZONE_SQL = `
  SELECT COALESCE(
           (SELECT pa.timezone
              FROM business_provider_accounts bpa
              JOIN provider_accounts pa ON pa.id = bpa.provider_account_ref_id
             WHERE bpa.business_id = $1
               AND bpa.provider_account_id = $2
               AND pa.timezone IS NOT NULL
             LIMIT 1),
           (SELECT snap.account_timezone
              FROM meta_raw_snapshots snap
             WHERE snap.business_id = $1
               AND snap.provider_account_id = $2
               AND snap.account_timezone IS NOT NULL
             ORDER BY snap.created_at DESC
             LIMIT 1)
         ) AS account_timezone
` as const;

export const D086_COMPLETE_RUN_SQL = `
  WITH attempts AS (
    /*
      EVERY capture attempt, whatever its outcome and whatever endpoint it hit.

      r7 selected runs and filtered to complete + right endpoint + no error
      INSIDE the selection, so a wrong-endpoint, partial or failed capture
      simply vanished and every one of them was reported as "no run" — and an
      older complete run silently won over a newer failed attempt. The attempts
      are admitted here unfiltered precisely so the newest one can be judged.

      The receipt, not the run, is the occurrence: the observation writer
      coalesces identical truth onto an existing run, so a run can be the
      content of many captures and cannot itself carry the cohort.
    */
    SELECT rc.entity_type,
           rc.endpoint,
           rc.partition_id::text                AS partition_id,
           rc.capture_status,
           rc.run_id::text                      AS run_id,
           rc.source_snapshot_id,
           rc.source_snapshot_ref_id::text      AS source_snapshot_ref_id,
           rc.provider_row_count,
           rc.run_reused,
           rc.captured_at,
           rc.observed_at,
           rc.id,
           /*
             THE COHORT'S OWN PROVENANCE, VALIDATED — never filtered.

             r8's partition id was a bare UUID and its snapshot id an arbitrary
             string: no reference, no scope check, no lane check, nothing tying
             the snapshot to the partition or the endpoint. A fabricated or
             foreign cohort attested as a real one. These are LEFT JOINs and
             boolean verdicts precisely so a bad receipt REFUSES with its own
             cause rather than disappearing and letting an older success win.
           */
           (part.id IS NOT NULL)                                    AS partition_present,
           (part.id IS NOT NULL
              AND part.business_id = $1
              AND part.provider_account_id = $2)                    AS partition_scope_ok,
           (part.id IS NOT NULL
              AND part.lane = $4
              AND part.scope = ANY($5::text[]))                     AS partition_lane_ok,
           COALESCE(obs.any_occurrence, FALSE)                      AS snapshot_present,
           COALESCE(obs.partition_ok, FALSE)                        AS snapshot_partition_ok,
           COALESCE(obs.endpoint_ok, FALSE)                         AS snapshot_endpoint_ok,
           COALESCE(obs.exact_ok, FALSE)                            AS snapshot_occurrence_ok
      FROM meta_entity_observation_receipts rc
      LEFT JOIN meta_sync_partitions part
        ON part.id = rc.partition_id
      /*
        A LATERAL AGGREGATE, not a join.

        Raw snapshots are CONTENT-addressed: an unchanged payload captured again
        reuses the same row and gains a second occurrence receipt. A plain join
        on snapshot_id therefore FANS OUT — one capture receipt became several,
        the tie counter read 2 where there was no tie, and membership counted
        every entity twice. One row per receipt, with the verdicts aggregated.
      */
      LEFT JOIN LATERAL (
        SELECT TRUE                                                  AS any_occurrence,
               bool_or(o.partition_id = rc.partition_id)             AS partition_ok,
               bool_or(o.endpoint_name = rc.endpoint)                AS endpoint_ok,
               bool_or(o.partition_id = rc.partition_id
                       AND o.endpoint_name = rc.endpoint)            AS exact_ok
          FROM meta_raw_snapshot_observations o
         WHERE o.snapshot_id = rc.source_snapshot_ref_id
           AND o.business_id = $1
           AND o.provider_account_id = $2
        HAVING count(*) > 0
      ) obs ON TRUE
     WHERE rc.business_id = $1
       AND rc.provider_account_id = $2
       AND rc.entity_type IN ('campaign', 'adset')
       AND rc.captured_at <= $3::timestamptz
  ), attempt_groups AS (
    -- A grouped aggregate, because PostgreSQL does not implement
    -- count(DISTINCT ...) as a window function (SQLSTATE 0A000).
    SELECT entity_type, captured_at,
           count(*) AS tied_at_clock,
           count(DISTINCT (run_id, endpoint, partition_id, capture_status,
                           provider_row_count, source_snapshot_id,
                           source_snapshot_ref_id, run_reused))
             AS tied_distinct_truths
      FROM attempts
     GROUP BY entity_type, captured_at
  ), newest AS (
    SELECT a.*, g.tied_at_clock, g.tied_distinct_truths,
           rank() OVER (PARTITION BY a.entity_type
                        ORDER BY a.captured_at DESC, a.id DESC) AS attempt_rank
      FROM attempts a
      JOIN attempt_groups g
        ON g.entity_type = a.entity_type
       AND g.captured_at = a.captured_at
  ), chosen AS (
    /*
      The NEWEST attempt per grain, joined to the run whose content it recorded.

      The run's heartbeat-effective clocks are applied as a cutoff predicate:
      content whose latest sighting is after the as-of instant is not knowable
      at that instant. These are the exact expressions
      idx_meta_entity_observation_runs_d086_effective indexes.
    */
    SELECT n.entity_type, n.endpoint, n.partition_id, n.capture_status,
           n.run_id, n.source_snapshot_id, n.source_snapshot_ref_id,
           n.provider_row_count, n.run_reused,
           n.partition_present, n.partition_scope_ok, n.partition_lane_ok,
           n.snapshot_present, n.snapshot_partition_ok, n.snapshot_endpoint_ok,
           n.snapshot_occurrence_ok,
           n.captured_at AS receipt_captured_at,
           n.tied_at_clock, n.tied_distinct_truths,
           run.completeness,
           run.row_count,
           run.manifest_kind,
           run.endpoint                            AS run_endpoint,
           (run.error_json IS NULL)                AS run_succeeded,
           run.captured_at                         AS payload_captured_at,
           COALESCE(run.last_captured_at, run.captured_at) AS effective_captured_at,
           LEAST(COALESCE(run.last_seen_at, run.observed_at),
                 COALESCE(run.last_captured_at, run.captured_at))
                                                   AS effective_observed_at
      FROM newest n
      LEFT JOIN meta_entity_observation_runs run
        ON run.id = n.run_id::uuid
       AND run.business_id = $1
       AND run.provider_account_id = $2
       /*
         IMMUTABLE clocks, because history must not be rewritten.

         r8 gated readability on COALESCE(last_captured_at, captured_at) and the
         heartbeat-effective LEAST(...). Those columns MOVE: a later identical
         re-observation advances them. A receipt written before a historical
         cutoff therefore became unreadable at that cutoff as soon as any
         heartbeat landed after it, erasing evidence that demonstrably existed.
         The payload clocks cannot move, so they are what the cutoff uses.
       */
       AND run.captured_at <= $3::timestamptz
       AND run.observed_at <= $3::timestamptz
     WHERE n.attempt_rank = 1
  ), members AS (
    /*
      EXACT MEMBERSHIP, reconstructed per chosen run — not a row count.

      Full/legacy runs: the run's own immutable present payload.
      Delta runs: the latest complete-lane present row per entity at or before
      the run's PAYLOAD capture clock, restricted to the run's own endpoint,
      which is the same scope unit the writer diffs against. Absent
      (scope-exit) winners drop their entity, so a stale present row is never
      resurrected past an explicit exit.
    */
    SELECT c.entity_type, c.run_id, m.entity_id, m.member_run_id
      FROM chosen c
      JOIN LATERAL (
        SELECT state.entity_id, state.run_id::text AS member_run_id
          FROM meta_entity_state_history state
         WHERE c.manifest_kind IS DISTINCT FROM 'delta'
           AND state.run_id::text = c.run_id
           AND state.business_id = $1
           AND state.provider_account_id = $2
           AND state.entity_type = c.entity_type
           AND state.presence = 'present'
           AND state.captured_at <= $3::timestamptz
        UNION ALL
        /*
          A GENUINE DELTA inherits its unchanged members from the base chain, so
          the contributing run id travels with each member. r8 then demanded
          every member carry the NEWEST run id, which no real delta can satisfy.
        */
        SELECT latest.entity_id, latest.member_run_id
          FROM (
            SELECT DISTINCT ON (state.entity_id)
                   state.entity_id, state.presence,
                   state.run_id::text AS member_run_id
              FROM meta_entity_state_history state
             WHERE c.manifest_kind = 'delta'
               AND state.business_id = $1
               AND state.provider_account_id = $2
               AND state.entity_type = c.entity_type
               AND state.run_completeness = 'complete'
               AND state.captured_at <= c.payload_captured_at
               AND EXISTS (
                 SELECT 1 FROM meta_entity_observation_runs scope_run
                  WHERE scope_run.id = state.run_id
                    AND scope_run.endpoint = c.run_endpoint
               )
             ORDER BY state.entity_id, state.captured_at DESC,
                      state.created_at DESC, state.id DESC
          ) latest
         WHERE latest.presence = 'present'
      ) m ON TRUE
  ), tombstoned AS (
    /*
      EXPLICIT DELETION, read from the tombstone table itself.

      r7 never read meta_entity_tombstones; its "tombstone" case only flipped a
      state row's presence, which is the scope-exit path and a different fact.
      A tombstone recorded at or after the manifest's own capture supersedes
      that manifest's claim that the entity was present.
    */
    SELECT DISTINCT mem.entity_type, mem.run_id, mem.entity_id
      FROM members mem
      JOIN chosen c
        ON c.entity_type = mem.entity_type AND c.run_id = mem.run_id
      JOIN meta_entity_tombstones t
        ON t.business_id = $1
       AND t.provider_account_id = $2
       AND t.entity_type = mem.entity_type
       AND t.entity_id = mem.entity_id
       AND t.captured_at <= $3::timestamptz
       AND t.captured_at >= c.payload_captured_at
  ), live_members AS (
    SELECT mem.*
      FROM members mem
     WHERE NOT EXISTS (
       SELECT 1 FROM tombstoned tb
        WHERE tb.entity_type = mem.entity_type
          AND tb.run_id = mem.run_id
          AND tb.entity_id = mem.entity_id
     )
  )
  SELECT c.entity_type, c.run_id, c.endpoint, c.run_endpoint, c.completeness,
         c.capture_status, c.row_count, c.provider_row_count, c.run_reused,
         c.source_snapshot_id, c.partition_id, c.run_succeeded, c.manifest_kind,
         c.partition_present, c.partition_scope_ok, c.partition_lane_ok,
         c.snapshot_present, c.snapshot_partition_ok, c.snapshot_endpoint_ok,
         c.snapshot_occurrence_ok,
         (SELECT array_agg(DISTINCT lm.member_run_id) FROM live_members lm
           WHERE lm.entity_type = c.entity_type AND lm.run_id = c.run_id)
                                                              AS member_run_ids,
         c.effective_captured_at AS captured_at,
         c.receipt_captured_at,
         c.tied_at_clock, c.tied_distinct_truths,
         (SELECT count(*) FROM live_members lm
           WHERE lm.entity_type = c.entity_type AND lm.run_id = c.run_id)
                                                              AS persisted_members,
         (SELECT count(*) FROM tombstoned tb
           WHERE tb.entity_type = c.entity_type AND tb.run_id = c.run_id)
                                                              AS tombstoned_members,
         (SELECT array_agg(lm.entity_id ORDER BY lm.entity_id) FROM live_members lm
           WHERE lm.entity_type = c.entity_type AND lm.run_id = c.run_id)
                                                              AS member_ids
    FROM chosen c
   ORDER BY c.entity_type
` as const;

export interface CompleteRunAttestation {
  attested: boolean;
  blocker: string | null;
  /** The one sync cohort both endpoints must share: the core sync partition. */
  cohortId: string | null;
  runs: Record<"campaign" | "adset", {
    runId: string;
    /** The endpoint the RECEIPT recorded — what was actually called. */
    endpoint: string;
    /** The endpoint the run carries. A disagreement is a linkage fault. */
    runEndpoint: string;
    completeness: string;
    captureStatus: string;
    manifestKind: string | null;
    expectedRows: number | null;
    persistedMembers: number | null;
    tombstonedMembers: number;
    /** The exact reconstructed identities, sorted. Never a count alone. */
    memberIds: readonly string[];
    capturedAt: string | null;
    receiptCapturedAt: string | null;
    snapshotId: string | null;
    cohortId: string | null;
    runReused: boolean;
    succeeded: boolean;
    tiedAtClock: number;
    tiedDistinctTruths: number;
    /** The cohort's own provenance, validated against the real seams. */
    partitionPresent: boolean;
    partitionScopeOk: boolean;
    partitionLaneOk: boolean;
    snapshotPresent: boolean;
    snapshotPartitionOk: boolean;
    snapshotEndpointOk: boolean;
    snapshotOccurrenceOk: boolean;
    /** Every run that contributed a member — the manifest's own chain. */
    memberRunIds: readonly string[];
  } | null>;
}

/** The capture outcomes that are not a full, usable inventory, and their causes. */
const D086_CAPTURE_STATUS_BLOCKER: Record<string, string> = {
  failed: "capture_failed",
  partial: "capture_partial",
  point_lookup: "capture_not_full_scan",
};

/**
 * Judge the manifest. Total, fail-closed, CAUSE-SPECIFIC and FRESHNESS-AWARE.
 *
 * The newest attempt per grain is the only one judged. If that attempt failed,
 * was partial, or hit the wrong endpoint, readiness says so by name — it does
 * not fall back to an older success, and it does not report every distinct
 * cause as "no run".
 */
export function attestCompleteRun(rows: readonly Record<string, unknown>[]): CompleteRunAttestation {
  const runs: CompleteRunAttestation["runs"] = { campaign: null, adset: null };
  for (const row of rows) {
    const type = text(row.entity_type);
    if (type !== "campaign" && type !== "adset") continue;
    const ids = Array.isArray(row.member_ids)
      ? (row.member_ids as unknown[]).filter((v): v is string => typeof v === "string").slice().sort()
      : [];
    runs[type] = {
      runId: text(row.run_id),
      endpoint: text(row.endpoint),
      runEndpoint: row.run_endpoint === null || row.run_endpoint === undefined
        ? "" : text(row.run_endpoint),
      completeness: row.completeness === null || row.completeness === undefined
        ? "" : text(row.completeness),
      captureStatus: text(row.capture_status),
      manifestKind: row.manifest_kind === null || row.manifest_kind === undefined
        ? null : text(row.manifest_kind),
      expectedRows: parsePopulationTotal(row.row_count),
      persistedMembers: parsePopulationTotal(row.persisted_members),
      tombstonedMembers: parsePopulationTotal(row.tombstoned_members) ?? 0,
      memberIds: Object.freeze(ids),
      capturedAt: toIso(row.captured_at),
      receiptCapturedAt: toIso(row.receipt_captured_at),
      snapshotId: row.source_snapshot_id === null || row.source_snapshot_id === undefined
        ? null : text(row.source_snapshot_id),
      cohortId: row.partition_id === null || row.partition_id === undefined
        ? null : text(row.partition_id),
      runReused: row.run_reused === true || row.run_reused === "t",
      succeeded: row.run_succeeded === true || row.run_succeeded === "t",
      tiedAtClock: parsePopulationTotal(row.tied_at_clock) ?? 1,
      tiedDistinctTruths: parsePopulationTotal(row.tied_distinct_truths) ?? 1,
      partitionPresent: isTrue(row.partition_present),
      partitionScopeOk: isTrue(row.partition_scope_ok),
      partitionLaneOk: isTrue(row.partition_lane_ok),
      snapshotPresent: isTrue(row.snapshot_present),
      snapshotPartitionOk: isTrue(row.snapshot_partition_ok),
      snapshotEndpointOk: isTrue(row.snapshot_endpoint_ok),
      snapshotOccurrenceOk: isTrue(row.snapshot_occurrence_ok),
      memberRunIds: Object.freeze(
        Array.isArray(row.member_run_ids)
          ? (row.member_run_ids as unknown[]).filter((v): v is string => typeof v === "string")
          : [],
      ),
    };
  }

  const fail = (blocker: string) => ({ attested: false, blocker, cohortId: null, runs });

  for (const type of ["campaign", "adset"] as const) {
    const run = runs[type];
    // No capture at all for this grain is its own distinct fact.
    if (!run) return fail(`budget_universe_no_${type}_capture`);
    // The endpoint that was actually CALLED, before anything else is believed.
    if (run.endpoint !== D086_BUDGET_ENDPOINTS[type]) {
      return fail(`budget_universe_${type}_endpoint_mismatch`);
    }
    // The outcome of the newest attempt, named.
    const statusBlocker = D086_CAPTURE_STATUS_BLOCKER[run.captureStatus];
    if (statusBlocker) return fail(`budget_universe_${type}_${statusBlocker}`);
    if (run.captureStatus !== "complete") {
      return fail(`budget_universe_${type}_capture_status_unknown`);
    }
    // The receipt named a run; the run must exist, be readable at the cutoff,
    // and agree with the receipt about which endpoint it holds.
    if (run.runEndpoint === "") return fail(`budget_universe_${type}_run_unreadable`);
    if (run.runEndpoint !== run.endpoint) {
      return fail(`budget_universe_${type}_receipt_run_endpoint_disagreement`);
    }
    /*
      THE COHORT'S PROVENANCE, before anything it claims is believed.

      Each cause is separate because each sends an operator somewhere else: an
      absent partition is a write that never linked, a foreign one is a scope
      fault, a lane mismatch is the wrong sync entirely, and a snapshot that
      belongs to another partition or endpoint is a payload this capture did not
      read. r8 checked none of them.
    */
    if (!run.partitionPresent) return fail(`budget_universe_${type}_partition_absent`);
    if (!run.partitionScopeOk) return fail(`budget_universe_${type}_partition_scope_mismatch`);
    if (!run.partitionLaneOk) return fail(`budget_universe_${type}_partition_lane_mismatch`);
    if (!run.snapshotPresent) return fail(`budget_universe_${type}_snapshot_absent`);
    if (!run.snapshotPartitionOk) {
      return fail(`budget_universe_${type}_snapshot_partition_mismatch`);
    }
    if (!run.snapshotEndpointOk) {
      return fail(`budget_universe_${type}_snapshot_endpoint_mismatch`);
    }
    // Both facts can be true of DIFFERENT occurrences of a shared snapshot; the
    // one this capture read has to be a single occurrence carrying both.
    if (!run.snapshotOccurrenceOk) {
      return fail(`budget_universe_${type}_snapshot_occurrence_mismatch`);
    }
    if (!run.succeeded) return fail(`budget_universe_${type}_run_failed`);
    if (run.completeness !== "complete") return fail(`budget_universe_${type}_run_incomplete`);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(run.runId)) {
      return fail("budget_universe_run_identity");
    }
    // A same-clock materially different attempt is a CONFLICT, never a pick.
    if (run.tiedAtClock > 1 && run.tiedDistinctTruths > 1) {
      return fail("budget_universe_manifest_conflict");
    }
    if (run.expectedRows === null) return fail("budget_universe_expected_count");
    // An explicit deletion after the manifest's capture makes that manifest
    // stale. Named separately so it is never read as an arithmetic slip.
    if (run.tombstonedMembers > 0) return fail(`budget_universe_${type}_membership_tombstoned`);
    // The manifest's own count must equal the identities actually reconstructed.
    if (run.persistedMembers === null || run.persistedMembers !== run.expectedRows) {
      return fail("budget_universe_persisted_count_mismatch");
    }
    if (run.memberIds.length !== run.expectedRows) {
      return fail("budget_universe_persisted_count_mismatch");
    }
  }

  /*
    ONE EXPLICIT COHORT, never timestamp proximity. The two endpoints produce
    separate payloads, so their snapshot identities legitimately differ — but
    both captures must name the same core sync partition.
  */
  const campaignCohort = runs.campaign!.cohortId;
  const adsetCohort = runs.adset!.cohortId;
  if (campaignCohort === null || adsetCohort === null) {
    return fail("budget_universe_cohort_absent");
  }
  if (campaignCohort !== adsetCohort) return fail("budget_universe_cohort_mismatch");

  return { attested: true, blocker: null, cohortId: campaignCohort, runs };
}

/**
 * A TOTAL, fail-closed count contract.
 *
 * r3 used `Number(value)` plus `population > examined`, so "garbage", `-1`, `0`
 * and `null` all produced READY — and `-1` was even published as the population.
 * Anything that is not a non-negative safe integer is a measurement failure.
 */
export function parsePopulationTotal(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) && asNumber >= 0 ? asNumber : null;
  }
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * A DB failure becomes a stable code, never raw exception text on a surface.
 * A driver message can carry a connection string, a statement, or row data.
 */
/** The capability probe, re-exported so the PostgreSQL seam runs the real one. */
export { D086_CAPABILITY_PROBE_SQL as D086_CAPABILITY_PROBE_SQL_FOR_SEAM } from "@/lib/meta/budget-readiness-retention";

export function sanitiseReadFailure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,20}$/.test(code)) return `db_error_${code.toLowerCase()}`;
  return "db_error_unavailable";
}

const unknownDimension = (
  key: ReadinessDimension["key"],
  closesBlocker: string,
  detail: string,
): ReadinessDimension => ({
  key,
  closesBlocker,
  status: "unknown",
  evidence: `measurement_failed:${detail}`,
  source: "d086_readiness_probe",
  asOf: null,
  coverage: null,
  blocker: "readiness_measurement_unavailable",
  preconditions: Object.freeze(["repeat the readiness measurement"]),
});

const scopeBlockedDimension = (
  key: ReadinessDimension["key"],
  closesBlocker: string,
  reason: string,
): ReadinessDimension => ({
  key,
  closesBlocker,
  status: "unavailable",
  evidence:
    `No single assigned provider account resolved for this business (${reason}), so no `
    + "account-scoped measurement exists. Readiness is never aggregated across accounts.",
  source: "route_scope_resolution",
  asOf: null,
  coverage: null,
  blocker: "readiness_scope_unresolved",
  preconditions: Object.freeze(["resolve exactly one assigned provider account for this business"]),
});

function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTrue(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Status from a fail-closed coverage rule, shared by every dimension.
 *
 * READY requires that EVERY examined row qualified. One malformed, stale or
 * foreign row in the account-scoped sample makes the dimension `partial` — the
 * dimension describes an input, and an input with a known-bad member is not ready.
 */
/**
 * The status of a dimension, from counts that are all fail-closed.
 *
 * `forward_only_after_deploy` means what it says: nothing has accrued, because
 * the schema or the ingestion is absent. r3 also used it when rows EXISTED but
 * every one failed validation — an observed invalid state reported as if it were
 * waiting for a deploy. Those are `partial` (some usable) or `unavailable` (none
 * usable, but rows are there), and an unmeasurable population is `unknown`.
 */
export interface CoverageCounts {
  /** Applicable owners that passed the retained validator. */
  qualifying: number;
  /** Applicable owners examined. Never the whole retained sample. */
  examined: number;
  /** `null` when the total could not be parsed as a non-negative safe integer. */
  population: number | null;
  conflicts: number;
  /** Rows retained at all, so "none applicable" is not read as "none exist". */
  retainedRows?: number;
  /** Applicable owners the evidence implies but does not contain. */
  uncoveredApplicable?: number;
  /** Rows whose ownership was never captured. */
  ownerUnknown?: number;
}

export function coverageStatus(counts: CoverageCounts): ReadinessStatus {
  const { qualifying, examined, population, conflicts } = counts;
  const retainedRows = counts.retainedRows ?? examined;
  const uncoveredApplicable = counts.uncoveredApplicable ?? 0;
  const ownerUnknown = counts.ownerUnknown ?? 0;

  /*
    PRECEDENCE, in one place, measurement first.

    r4 branched on ownership and conflicts before checking whether the population
    was measurable at all, so an unmeasurable total reported `partial` while the
    contract said `unknown`. A count you cannot trust cannot support any verdict
    about what it counts — including a negative one.
  */
  if (retainedRows > 0) {
    if (population === null) return "unknown";
    if (population < examined) return "unknown";
  } else if (population !== null && population > 0) {
    // The population says rows exist, but none reached this sample.
    return "unknown";
  }

  // Then the states that make the population itself unsafe to reason about.
  if (conflicts > 0) return "partial";
  if (uncoveredApplicable > 0) return "partial";
  if (ownerUnknown > 0) return "partial";

  if (examined === 0) {
    /*
      Forward-only is ONLY for genuinely absent accrual. Rows that exist but are
      not applicable owners are an observed state, not a wait for a deploy.
    */
    return retainedRows > 0 ? "unavailable" : "forward_only_after_deploy";
  }
  if (qualifying === 0) return "unavailable";
  if (qualifying !== examined) return "partial";
  // TRUNCATION IS NOT READINESS: unexamined members are unknown, not passing.
  if (population === null || population > examined) return "partial";
  return "ready";
}

/** A persisted numeric column, or null. `Number(null)` is 0 and must not pass. */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read the three readiness dimensions for one business AND one provider account.
 *
 * SELECT-only by construction: every statement below is a read, and the caller
 * supplies the connection. Nothing here is parameterised by a clock — `nowIso` is
 * an argument so a replay and a live read agree.
 */
export async function readBudgetReadiness(
  db: ReadinessDb,
  scope: BudgetReadinessScope,
): Promise<BudgetReadinessReadModel> {
  const dimensions: ReadinessDimension[] = [];
  const businessId = text(scope.businessId);
  const providerAccountId = text(scope.providerAccountId);

  // --- scope first: no account, no measurement --------------------------------
  if (businessId.length === 0 || providerAccountId.length === 0) {
    const reason = businessId.length === 0 ? "no business in scope" : "no single assigned account";
    return {
      contract: BUDGET_READINESS_CONTRACT,
      businessId,
      providerAccountId: null,
      scopeBlocker: "readiness_scope_unresolved",
      compiledResolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      dimensions: Object.freeze([
        scopeBlockedDimension("budget_fact_retention", "currency_exponent_not_captured", reason),
        scopeBlockedDimension("profile_output_retention", "canonical_profile_output_not_retained", reason),
        scopeBlockedDimension("role_authority_retention", "automatic_role_authority_absent", reason),
      ]),
      blockers: Object.freeze(["readiness_scope_unresolved"]),
    };
  }

  // --- capability: which prepared migrations does this database actually have?
  let capability: {
    partitionColumns: number; rawObservationColumns: number;
    profileColumns: number; roleColumns: number;
    runColumns: number; receiptColumns: number; stateColumns: number; tombstoneColumns: number;
  } | null = null;
  let indexCatalog: ReturnType<typeof classifyIndexCatalog> | null = null;
  try {
    const rows = await db.query<Record<string, unknown>>(D086_CAPABILITY_PROBE_SQL, [
      // $1 is the PARTITION contract now: the config-history seams were dead
      // capability, probed and then ignored.
      [...D086_REQUIRED_PARTITION_COLUMNS],
      [...D086_REQUIRED_PROFILE_COLUMNS],
      [...D086_REQUIRED_ROLE_COLUMNS],
      [...D086_REQUIRED_RUN_COLUMNS],
      [...D086_REQUIRED_RECEIPT_COLUMNS],
      [...D086_REQUIRED_STATE_COLUMNS],
      [...D086_REQUIRED_TOMBSTONE_COLUMNS],
      [...D086_REQUIRED_RAW_OBSERVATION_COLUMNS],
    ]);
    capability = {
      partitionColumns: toCount(rows[0]?.partition_columns),
      rawObservationColumns: toCount(rows[0]?.raw_observation_columns),
      // COMPLETE column sets, not table existence: r3's profile table existed
      // without `profile_contract`, so the query failed SQLSTATE 42703 while
      // capability reported the seam as present.
      profileColumns: toCount(rows[0]?.profile_columns),
      roleColumns: toCount(rows[0]?.role_columns),
      // The universe prerequisites. r7 probed NONE of these, so a partially
      // deployed schema produced a driver exception the surface labelled as a
      // generic read failure instead of a precise, forward-only blocker.
      runColumns: toCount(rows[0]?.run_columns),
      receiptColumns: toCount(rows[0]?.receipt_columns),
      stateColumns: toCount(rows[0]?.state_columns),
      tombstoneColumns: toCount(rows[0]?.tombstone_columns),
    };
    indexCatalog = classifyIndexCatalog(
      await db.query<{ indexname?: unknown; indexdef?: unknown }>(
        D086_INDEX_CATALOG_SQL,
        [D086_REQUIRED_INDEXES.map((index) => index.indexName)],
      ),
    );
  } catch {
    capability = null;
    indexCatalog = null;
  }

  /*
    WHICH prerequisite is missing, by name.

    A generic "incomplete" answer sends an operator looking at the wrong table.
    Each seam reports its own shortfall, and the index gate reports whether an
    index is absent or present-but-unusable for the order the query writes.
  */
  const universeShortfalls: string[] = capability === null ? [] : [
    ["sync partitions", capability.partitionColumns, D086_REQUIRED_PARTITION_COLUMNS.length],
    ["raw snapshot observations", capability.rawObservationColumns,
      D086_REQUIRED_RAW_OBSERVATION_COLUMNS.length],
    ["observation runs", capability.runColumns, D086_REQUIRED_RUN_COLUMNS.length],
    ["capture receipts", capability.receiptColumns, D086_REQUIRED_RECEIPT_COLUMNS.length],
    ["entity state history", capability.stateColumns, D086_REQUIRED_STATE_COLUMNS.length],
    ["entity tombstones", capability.tombstoneColumns, D086_REQUIRED_TOMBSTONE_COLUMNS.length],
  ].flatMap(([label, have, need]) =>
    have === need ? [] : [`${label as string}: ${have as number} of ${need as number} columns`]);
  if (indexCatalog !== null && !indexCatalog.satisfied) {
    for (const name of indexCatalog.missing) universeShortfalls.push(`index absent: ${name}`);
    for (const name of indexCatalog.unusable) universeShortfalls.push(`index unusable: ${name}`);
  }
  const budgetColumnsComplete = capability !== null && universeShortfalls.length === 0;

  // --- A: budget-fact retention -----------------------------------------------
  if (capability === null) {
    dimensions.push(unknownDimension(
      "budget_fact_retention", "currency_exponent_not_captured", "capability_probe_failed",
    ));
  } else if (!budgetColumnsComplete) {
    dimensions.push({
      key: "budget_fact_retention",
      closesBlocker: "currency_exponent_not_captured",
      status: "forward_only_after_deploy",
      evidence:
        "The universe prerequisites are not fully deployed, so no capture can be attested here: "
        + `${universeShortfalls.join("; ")}. Readiness is forward-only until they are.`,
      source: "information_schema.columns + pg_indexes (runs, receipts, state, tombstones)",
      asOf: null,
      coverage: { qualifying: 0, examined: 0, population: 0, conflicts: 0, truncated: false },
      blocker: "currency_exponent_not_captured",
      preconditions: Object.freeze([
        "deploy the prepared additive receipt table and its indexes",
        "clear the ingestion fence so an admitted sync writes a capture receipt",
      ]),
    });
  } else {
    try {
      /*
        LATEST PER IDENTITY, judged by the RETAINED classifier.

        The query is the exported contract above — parenthesised CTEs, so it is
        valid SQL, and `rank()` over the clock pair so one superseded row cannot
        poison a fresh current one and a tie is visible. The classifier reads the
        STORED unit provenance, and verifies it only against the frozen registry
        version the row itself cites.
      */
      /*
        ONE STATEMENT, ONE SNAPSHOT.

        r3 read the sample and the population as two statements, so a concurrent
        append between them could combine two snapshots into one verdict. The
        window total travels with the rows now.
      */
      const stateRows = await db.query<Record<string, unknown>>(D086_STATE_BUDGET_SQL,
        [businessId, providerAccountId, scope.nowIso, D086_READINESS_SAMPLE]);
      const rawTotal =
        stateRows.length === 0 ? 0 : parsePopulationTotal(stateRows[0]?.population_total);

      /*
        THE CANONICAL BOUNDARY, not a parallel one.

        D083's `buildCanonicalBudgetFact` owns owner mode, raw amount, currency,
        exponent, schedule and provenance. r7 re-decided all six from config
        history with its own classifier. Here the retained rows are projected by
        the SHARED mapper and every judgment is the canonical function's.
      */
      const timeZone = text(
        (await db.query<Record<string, unknown>>(
          D086_ACCOUNT_TIMEZONE_SQL, [businessId, providerAccountId],
        ))[0]?.account_timezone ?? "",
      );
      const observations = stateRows
        .map((row) => toBudgetObservation(
          { ...row, entity_type: row.grain },
          // The ROW's own scope, so a foreign row is refused by the canonical
          // scope check instead of being silently adopted into this account.
          {
            businessId: row.business_id === undefined || row.business_id === null
              ? businessId : text(row.business_id),
            providerAccountId:
              row.provider_account_id === undefined || row.provider_account_id === null
                ? providerAccountId : text(row.provider_account_id),
          },
        ))
        .filter((observation): observation is NonNullable<typeof observation> => observation !== null);
      const observationsByKey = new Map<string, typeof observations>();
      for (const observation of observations) {
        const key = `${observation.entityGrain}|${observation.entityId}`;
        const list = observationsByKey.get(key) ?? [];
        list.push(observation);
        observationsByKey.set(key, list);
      }
      const asOf = scope.nowIso.slice(0, 10);
      const factFor = (grain: "campaign" | "adset", entityId: string, parentId: string | null) =>
        buildCanonicalBudgetFact({
          businessId,
          providerAccountId,
          entityGrain: grain,
          entityId,
          parentCampaignId: grain === "adset" ? parentId : null,
          pit: { asOf, timeZone, requireRecordedByCutoff: true },
          entityObservations: observationsByKey.get(`${grain}|${entityId}`) ?? [],
          parentObservations:
            grain === "adset" && parentId
              ? (observationsByKey.get(`campaign|${parentId}`) ?? [])
              : [],
        });

      // The shape the passes below read. Every budget judgment on it came from
      // the canonical fact; nothing here re-decides one.
      const rows = stateRows.map((row) => {
        const grain = text(row.grain) as "campaign" | "adset";
        const entityId = text(row.entity_id);
        const parentId = grain === "adset" ? text(row.campaign_id) : "";
        const fact = factFor(grain, entityId, parentId || null);
        return {
          grain,
          entity_id: entityId,
          parent_campaign_id: parentId,
          /*
            The canonical fact names the owner GRAIN. D086's universe vocabulary
            is a translation of that one fact, never a second derivation: an
            entity is applicable when it is itself the owner, proven non-owner
            when the other grain is, and unknown when D083 could not resolve it.
          */
          budget_owner_mode:
            fact.ownerGrain === "campaign" ? "campaign_budget_optimization"
              : fact.ownerGrain === "adset" ? "adset_budget"
                // A campaign the canonical fact refuses for `budget_field_none`
                // has no budget field of its own — the ad-set-budget shape. It
                // still has to PROVE that below: every observed child must
                // actually own one, or this becomes uncovered or contradictory.
                : grain === "campaign" && fact.blockers.includes("budget_field_none")
                  ? "adset_budget"
                  // An ad-set whose PARENT is not in the evidence deferred
                  // upward to something this universe cannot see. Naming it as
                  // deferring lets the pairwise proof below report it as an
                  // uncovered applicable owner rather than as an unknown one.
                  : grain === "adset"
                    && (fact.blockers.includes("owner_unresolved_hierarchy")
                      || fact.blockers.includes("parent_campaign_identity_absent"))
                    ? "campaign_budget_optimization"
                    : "unknown",
          // A row the canonical scope check refused is not this account's, and
          // must be reported as that rather than as an uncaptured owner.
          out_of_scope: fact.blockers.some((blocker) => blocker.startsWith("scope_")),
          source_run_id: text(row.run_id),
          source_snapshot_id: row.source_snapshot_id ?? null,
          captured_at: row.captured_at,
          distinct_truths: row.distinct_truths,
          fact,
        };
      });

      // --- the authoritative universe, before anything is inferred from rows ---
      const attestation = attestCompleteRun(
        await db.query<Record<string, unknown>>(D086_COMPLETE_RUN_SQL,
          [businessId, providerAccountId, scope.nowIso,
            D086_COHORT_LANE, [...D086_COHORT_SCOPES]]),
      );

      let conflicts = 0;
      let latest: string | null = null;
      const reasons = new Map<string, number>();
      const seen = new Set<string>();
      const latestRows: Array<{ grain: string; row: (typeof rows)[number] }> = [];

      // --- pass 1: latest per identity, ties at the top rank held as conflicts -
      for (const row of rows) {
        const capturedAt = toIso(row.captured_at);
        if (capturedAt && (latest === null || capturedAt > latest)) latest = capturedAt;
        const identity = `${row.grain}:${row.entity_id}`;
        const distinctTruths = parsePopulationTotal(row.distinct_truths) ?? 2;
        if (distinctTruths > 1) {
          if (!seen.has(identity)) {
            conflicts += 1;
            reasons.set("retained_budget_top_rank_conflict",
              (reasons.get("retained_budget_top_rank_conflict") ?? 0) + 1);
          }
          seen.add(identity);
          continue;
        }
        if (seen.has(identity)) continue;
        seen.add(identity);
        latestRows.push({ grain: row.grain, row });
      }
      const retainedRows = latestRows.length + conflicts;

      /*
        --- RAW population first, BEFORE any subtraction ----------------------

        r5 computed `Math.max(0, total - provenNonApplicable)`, which clamped
        away the proof that the measured total was SMALLER than the rows actually
        retained — turning a measurement failure into a substantive `unavailable`
        verdict. The raw total is judged against the raw retained count here, and
        nothing is subtracted until it has passed.
      */
      let measurementBlocker: string | null = null;
      if (retainedRows > 0) {
        if (rawTotal === null) measurementBlocker = "budget_population_unmeasurable";
        else if (rawTotal < retainedRows) measurementBlocker = "budget_population_inconsistent";
      } else if (rawTotal !== null && rawTotal > 0) {
        measurementBlocker = "budget_population_inconsistent";
      }

      /*
        --- COHERENT RUN: one admitted observation, not a cross-run merge ------

        r5 claimed rows came from one snapshot and never checked. A CBO campaign
        from one run plus its ad-set from the NEXT day's run produced READY. Every
        row must carry the attested run id for its own grain, and any non-null
        snapshot identities within a grain must agree.
      */
      let coherenceBlocker: string | null = null;
      if (attestation.attested && retainedRows > 0) {
        const snapshotsByGrain = new Map<string, Set<string>>();
        for (const { grain, row } of latestRows) {
          /*
            THE MANIFEST'S CHAIN, not its newest run id.

            r8 required every latest row to carry the attested run's id. A real
            delta stores only changed, new and exited states, so its unchanged
            members keep the BASE run's id — and a genuine delta could never be
            READY. The manifest already reconstructs its own membership over the
            correct endpoint and complete lane; the contributing run ids come
            back with it, and a row from outside that chain is what is incoherent.
          */
          const manifest = attestation.runs[grain as "campaign" | "adset"];
          const chain = manifest
            ? new Set<string>([manifest.runId, ...manifest.memberRunIds])
            : null;
          if (!chain || !chain.has(text(row.source_run_id))) {
            coherenceBlocker = "budget_owner_run_incoherent";
            break;
          }
          /*
            SNAPSHOTS ARE PER RUN, so only rows from the ATTESTED run can be
            compared with the attested run's snapshot. r8 demanded that every
            row within a grain cite ONE snapshot; a real delta's unchanged
            members legitimately carry the base run's snapshot, so that rule
            refused every genuine delta. A row from the attested run that cites
            a different snapshot is still incoherent — that is a cross-run merge.
          */
          const snapshot = row.source_snapshot_id === null || row.source_snapshot_id === undefined
            ? null : text(row.source_snapshot_id);
          if (manifest && text(row.source_run_id) === manifest.runId && snapshot !== null) {
            const set = snapshotsByGrain.get(grain) ?? new Set<string>();
            set.add(snapshot);
            snapshotsByGrain.set(grain, set);
          }
        }
        if (coherenceBlocker === null) {
          for (const [, set] of snapshotsByGrain) {
            if (set.size > 1) { coherenceBlocker = "budget_owner_snapshot_incoherent"; break; }
          }
        }
      }

      /*
        --- EXACT MEMBERSHIP RECONCILIATION -----------------------------------

        r6 called this "identity reconciliation" and compared two integers, so a
        sample with the right CARDINALITY over entirely different entities
        attested. The reconstructed identity SET must equal the retained set.
      */
      let reconciliationBlocker: string | null = null;
      const observedIds = { campaign: [] as string[], adset: [] as string[] };
      for (const { grain, row } of latestRows) {
        if (grain === "campaign" || grain === "adset") observedIds[grain].push(text(row.entity_id));
      }
      const observedByGrain = {
        campaign: observedIds.campaign.length,
        adset: observedIds.adset.length,
      };
      if (attestation.attested) {
        for (const type of ["campaign", "adset"] as const) {
          const expectedIds = attestation.runs[type]?.memberIds ?? [];
          const seenIds = observedIds[type].slice().sort();
          if (seenIds.length !== expectedIds.length
            || seenIds.some((id, i) => id !== expectedIds[i])) {
            reconciliationBlocker = seenIds.length === expectedIds.length
              ? "budget_universe_membership_identity_mismatch"
              : "budget_universe_count_mismatch";
            break;
          }
        }
      }

      /*
        --- SNAPSHOT BINDING, row-to-MANIFEST ---------------------------------

        r6 only checked whether config rows within one grain disagreed with each
        other; it never bound a row's snapshot to the manifest's. A non-null row
        snapshot must equal its own grain's run snapshot. Null on either side is
        explicitly permitted — the column is nullable by contract — and proves
        nothing either way, which is why the cohort binding above is what ties
        the two endpoints together.
      */
      if (attestation.attested && coherenceBlocker === null) {
        for (const { grain, row } of latestRows) {
          const manifest = attestation.runs[grain as "campaign" | "adset"];
          // Only the ATTESTED run's own rows can be bound to its snapshot. A
          // delta's inherited members were captured by an earlier run and cite
          // that run's payload, which is correct, not a mismatch.
          if (!manifest || text(row.source_run_id) !== manifest.runId) continue;
          const rowSnapshot = row.source_snapshot_id === null || row.source_snapshot_id === undefined
            ? null : text(row.source_snapshot_id);
          const runSnapshot = manifest.snapshotId ?? null;
          if (rowSnapshot !== null && runSnapshot !== null && rowSnapshot !== runSnapshot) {
            coherenceBlocker = "budget_universe_snapshot_mismatch";
            break;
          }
        }
      }

      /*
        --- OWNERSHIP, proven against the coherent run ------------------------

        A campaign deferring to its ad-sets is non-applicable only when EVERY
        observed child of that campaign is itself an ad-set-budget owner. An
        ad-set deferring to its campaign is non-applicable only when that campaign
        is present in the same run and is a CBO owner. A campaign saying
        `adset_budget` whose child says `campaign_budget_optimization` is a
        CONTRADICTION — r5 counted that pair as two proven non-owners.
      */
      const campaignMode = new Map<string, string>();
      const childrenByCampaign = new Map<string, Array<{ id: string; mode: string }>>();
      for (const { grain, row } of latestRows) {
        if (grain === "campaign") campaignMode.set(text(row.entity_id), text(row.budget_owner_mode));
        else if (grain === "adset") {
          const parent = text(row.parent_campaign_id);
          const list = childrenByCampaign.get(parent) ?? [];
          list.push({ id: text(row.entity_id), mode: text(row.budget_owner_mode) });
          childrenByCampaign.set(parent, list);
        }
      }

      let qualifying = 0;
      let applicable = 0;
      let provenNonApplicable = 0;
      let ownerUnknown = 0;
      let uncoveredApplicable = 0;
      let hierarchyContradictions = 0;

      for (const { grain, row } of latestRows) {
        const universeClass = classifyBudgetUniverse({
          entityGrain: grain, budgetOwnerMode: row.budget_owner_mode,
        });
        if (universeClass === "owner_unknown") {
          ownerUnknown += 1;
          if (row.out_of_scope) {
            reasons.set("budget_row_out_of_scope", (reasons.get("budget_row_out_of_scope") ?? 0) + 1);
            continue;
          }
          reasons.set("budget_owner_mode_uncaptured", (reasons.get("budget_owner_mode_uncaptured") ?? 0) + 1);
          continue;
        }
        if (universeClass === "proven_non_applicable") {
          if (grain === "campaign") {
            // Deferring to its ad-sets: every observed child must actually own one.
            const children = childrenByCampaign.get(text(row.entity_id)) ?? [];
            const contradicting = children.filter((c) => c.mode !== "adset_budget");
            if (children.length === 0) {
              uncoveredApplicable += 1;
              reasons.set("budget_owner_universe_unproven",
                (reasons.get("budget_owner_universe_unproven") ?? 0) + 1);
            } else if (contradicting.length > 0) {
              hierarchyContradictions += 1;
              reasons.set("budget_owner_hierarchy_contradiction",
                (reasons.get("budget_owner_hierarchy_contradiction") ?? 0) + 1);
            } else {
              provenNonApplicable += 1;
            }
          } else {
            // Deferring to its campaign: that campaign must be here and be CBO.
            const parentMode = campaignMode.get(text(row.parent_campaign_id));
            if (parentMode === undefined) {
              uncoveredApplicable += 1;
              reasons.set("budget_owner_universe_unproven",
                (reasons.get("budget_owner_universe_unproven") ?? 0) + 1);
            } else if (parentMode !== "campaign_budget_optimization") {
              hierarchyContradictions += 1;
              reasons.set("budget_owner_hierarchy_contradiction",
                (reasons.get("budget_owner_hierarchy_contradiction") ?? 0) + 1);
            } else {
              provenNonApplicable += 1;
            }
          }
          continue;
        }
        applicable += 1;
        /*
          THE CANONICAL VERDICT. `intentReady` is D083's own statement that the
          owner, the raw amount, the captured unit, the schedule and the
          provenance are all proven for this entity at this cutoff. Its blockers
          are reported verbatim rather than restated in a local vocabulary.
        */
        if (row.fact.intentReady) qualifying += 1;
        else for (const b of row.fact.blockers) reasons.set(b, (reasons.get(b) ?? 0) + 1);
      }

      /*
        --- STATUS, in one precedence order ----------------------------------
        Measurement, then universe attestation, then coherence, then
        reconciliation, then ownership, then the ratio.
      */
      /*
        THE CAUSE, IN PRECEDENCE ORDER.

        r6 omitted ownerUnknown, uncoveredApplicable and ordinary retained-row
        conflicts here and then fell back to `currency_exponent_not_captured` —
        so an uncaptured owner mode and a missing parent were both reported as a
        currency problem. Every state now names itself.
      */
      const universeBlocker = measurementBlocker
        ?? (attestation.attested ? null : attestation.blocker)
        ?? coherenceBlocker
        ?? reconciliationBlocker
        ?? (conflicts > 0 ? "retained_budget_top_rank_conflict" : null)
        ?? (hierarchyContradictions > 0 ? "budget_owner_hierarchy_contradiction" : null)
        ?? (ownerUnknown > 0 ? "budget_owner_mode_uncaptured" : null)
        ?? (uncoveredApplicable > 0 ? "budget_owner_universe_unproven" : null);

      const status: ReadinessStatus = measurementBlocker !== null
        ? "unknown"
        : universeBlocker !== null
          ? (retainedRows > 0 ? "partial" : "forward_only_after_deploy")
          : coverageStatus({
            qualifying,
            examined: applicable,
            population: rawTotal === null ? null : rawTotal - provenNonApplicable,
            conflicts,
            retainedRows,
            uncoveredApplicable,
            ownerUnknown,
          });
      dimensions.push({
        key: "budget_fact_retention",
        closesBlocker: "currency_exponent_not_captured",
        status,
        evidence: retainedRows === 0
          ? "The capture path is deployed but no entity observation has been retained for this "
            + "account yet."
          : `${qualifying} of ${applicable} APPLICABLE budget owners carry a complete, valid, `
            + `action-bearing retained fact`
            + (rawTotal === null ? "; the population could not be measured" : ` (retained population ${rawTotal})`)
            + `; universe: applicable ${applicable}, proven non-owner ${provenNonApplicable}, `
            + `owner uncaptured ${ownerUnknown}, applicable owner missing ${uncoveredApplicable}, `
            + `hierarchy contradictions ${hierarchyContradictions}, conflicts ${conflicts}`
            + `; complete-run attestation ${attestation.attested ? "present" : "ABSENT"}`
            + (universeBlocker ? `; withheld by ${universeBlocker}` : "")
            + (status === "ready" ? "." : (reasons.size > 0 ? `. Leading refusals: ${topReasons(reasons)}.` : ".")),
        source:
          "meta_entity_state_history (latest per grain and entity, account-scoped), "
          + "attested by meta_entity_observation_receipts + meta_entity_observation_runs",
        asOf: latest,
        coverage: {
          qualifying,
          // EXAMINED is the applicable-owner denominator, so the published ratio
          // and the verdict describe the same population.
          examined: applicable,
          population: rawTotal,
          conflicts,
          truncated: rawTotal !== null && rawTotal - provenNonApplicable > applicable,
          universe: {
            retainedRows, applicable, provenNonApplicable, ownerUnknown, uncoveredApplicable,
            hierarchyContradictions,
            completeRunAttested: attestation.attested,
            expectedCampaigns: attestation.runs.campaign?.expectedRows ?? null,
            expectedAdsets: attestation.runs.adset?.expectedRows ?? null,
            observedCampaigns: observedByGrain.campaign,
            observedAdsets: observedByGrain.adset,
            cohortId: attestation.cohortId,
            manifestCampaignMembers: attestation.runs.campaign?.memberIds.length ?? null,
            manifestAdsetMembers: attestation.runs.adset?.memberIds.length ?? null,
          },
        },
        /*
          The LEADING refusal, not a default. The currency blocker is published
          only when missing or invalid unit provenance is genuinely what refused
          the applicable owners.
        */
        blocker: status === "ready"
          ? null
          : (universeBlocker ?? leadingRefusal(reasons) ?? "currency_exponent_not_captured"),
        preconditions: status === "ready"
          ? Object.freeze([])
          : Object.freeze(["clear the ingestion fence so an admitted sync can accrue unit-bearing observations"]),
      });
    } catch (error) {
      dimensions.push(unknownDimension(
        "budget_fact_retention", "currency_exponent_not_captured", sanitiseReadFailure(error),
      ));
    }
  }

  // --- B: profile-output retention --------------------------------------------
  if (capability === null) {
    dimensions.push(unknownDimension(
      "profile_output_retention", "canonical_profile_output_not_retained", "capability_probe_failed",
    ));
  } else if (capability.profileColumns !== D086_REQUIRED_PROFILE_COLUMNS.length) {
    dimensions.push({
      key: "profile_output_retention",
      closesBlocker: "canonical_profile_output_not_retained",
      status: "forward_only_after_deploy",
      evidence:
        `The profile seam is incomplete: ${capability.profileColumns} of `
        + `${D086_REQUIRED_PROFILE_COLUMNS.length} required columns exist. Nothing retains the `
        + "resolver's own hard-action verdict in a readable shape, so commercial eligibility "
        + "cannot be stated in either direction for any business-action pair.",
      source: "information_schema.columns (profile seam)",
      asOf: null,
      coverage: { qualifying: 0, examined: 0, population: 0, conflicts: 0, truncated: false },
      blocker: "canonical_profile_output_not_retained",
      preconditions: Object.freeze([
        "deploy the prepared engine_v3_account_profile_output table",
        "run one engine pass that projects the existing profile result into it",
      ]),
    });
  } else {
    try {
      /*
        THE LATEST CANDIDATE PER ACTION, and agreement is REQUIRED.

        This surface holds no external fingerprint expectation, so every row
        classifies as `profile_identity_agreement_unavailable` — evidence, not
        readiness. r2 passed `null` and read the resulting `usable: true` as
        proof, which turned an unchecked identity into a verified verdict.
      */
      const rows = await db.query<Record<string, unknown>>(D086_PROFILE_LATEST_SQL,
        [businessId, providerAccountId]);
      let qualifying = 0;
      let conflicts = 0;
      let latest: string | null = null;
      const reasons = new Map<string, number>();
      const actionsSeen = new Set<string>();
      const seenActions = new Set<string>();
      for (const row of rows) {
        const recordedAt = toIso(row.recorded_at);
        if (recordedAt && (latest === null || recordedAt > latest)) latest = recordedAt;
        const identity = text(row.action);
        const distinctTruths = parsePopulationTotal(row.distinct_truths) ?? 2;
        if (distinctTruths > 1) {
          if (!seenActions.has(identity)) {
            conflicts += 1;
            reasons.set("retained_profile_top_rank_conflict",
              (reasons.get("retained_profile_top_rank_conflict") ?? 0) + 1);
          }
          seenActions.add(identity);
          continue;
        }
        if (seenActions.has(identity)) continue;
        seenActions.add(identity);
        if (row.business_id !== businessId || row.provider_account_id !== providerAccountId) {
          reasons.set("retained_profile_scope_mismatch", (reasons.get("retained_profile_scope_mismatch") ?? 0) + 1);
          continue;
        }
        const verdict = classifyRetainedProfile(
          {
            contract: row.contract ?? null,
            profileContract: row.profile_contract ?? null,
            engineEpoch: row.engine_epoch ?? null,
            engineVersion: row.engine_version ?? null,
            action: row.action ?? null,
            inputFingerprint: row.input_fingerprint ?? null,
            sourceFingerprint: row.source_fingerprint ?? null,
            // The raw persisted value, NOT coerced: a malformed boolean must
            // fail rather than become `false` and look like a withholding.
            eligible: row.eligible,
            blockerCode: row.blocker_code ?? null,
            asOfDate: row.as_of_date ?? null,
            effectiveAt: toIso(row.effective_at),
            recordedAt,
          },
          {
            inputFingerprint: scope.expectedProfileInputFingerprint ?? null,
            sourceFingerprint: scope.expectedProfileSourceFingerprint ?? null,
            nowIso: scope.nowIso,
            maxAgeMs: D086_PROFILE_MAX_AGE_MS,
          },
        );
        if (verdict.usable) {
          qualifying += 1;
          if ((D086_PROFILE_ACTIONS as readonly unknown[]).includes(row.action)) {
            actionsSeen.add(row.action as string);
          }
        } else {
          reasons.set(verdict.reason, (reasons.get(verdict.reason) ?? 0) + 1);
        }
      }
      const allActionsCovered = D086_PROFILE_ACTIONS.every((a) => actionsSeen.has(a));
      const examined = seenActions.size;
      const total = rows.length === 0 ? 0 : parsePopulationTotal(rows[0]?.population_total);
      let status = coverageStatus({ qualifying, examined, population: total, conflicts });
      if (status === "ready" && !allActionsCovered) status = "partial";
      dimensions.push({
        key: "profile_output_retention",
        closesBlocker: "canonical_profile_output_not_retained",
        status,
        evidence: examined === 0
          ? "The retention table exists but no engine pass has projected a verdict for this account yet."
          : `${qualifying} of ${examined} latest-per-action verdicts are usable`
            + `; actions covered: ${[...actionsSeen].sort().join(", ") || "none"}`
            + (reasons.size > 0 ? `. Leading refusals: ${topReasons(reasons)}.` : "."),
        source: "engine_v3_account_profile_output (latest per action, account-scoped)",
        asOf: latest,
        coverage: { qualifying, examined, population: total, conflicts, truncated: total !== null && total > examined },
        blocker: status === "ready" ? null : "canonical_profile_output_not_retained",
        preconditions: status === "ready"
          ? Object.freeze([])
          : Object.freeze([
            "run one engine pass that projects a verdict for every hard action",
            "supply the external input and source fingerprints so identity agreement can be checked",
          ]),
      });
    } catch (error) {
      dimensions.push(unknownDimension(
        "profile_output_retention", "canonical_profile_output_not_retained", sanitiseReadFailure(error),
      ));
    }
  }

  // --- C: role-authority retention --------------------------------------------
  if (capability === null) {
    dimensions.push(unknownDimension(
      "role_authority_retention", "automatic_role_authority_absent", "capability_probe_failed",
    ));
  } else if (capability.roleColumns === D086_REQUIRED_ROLE_COLUMNS.length) {
    /*
      THE AUTHORITY TABLE IS THE AUTHORITY, latest per campaign.

      r1 computed this capability and then ignored it. r2 read every historical
      row, so an aged row permanently forced `partial`. `DISTINCT ON (campaign_id)`
      takes the current row per campaign, and the population is counted
      separately so a truncated sample cannot read as whole-account readiness.
    */
    try {
      const rows = await db.query<Record<string, unknown>>(D086_ROLE_LATEST_SQL,
        [businessId, providerAccountId, D086_READINESS_SAMPLE]);
      const total = rows.length === 0 ? 0 : parsePopulationTotal(rows[0]?.population_total);
      let qualifying = 0;
      let conflicts = 0;
      let latest: string | null = null;
      const reasons = new Map<string, number>();
      const seen = new Set<string>();
      for (const row of rows) {
        const asOf = text(row.as_of_date);
        if (asOf && (latest === null || asOf > latest)) latest = asOf;
        const identity = text(row.campaign_id);
        const distinctTruths = parsePopulationTotal(row.distinct_truths) ?? 2;
        if (distinctTruths > 1) {
          if (!seen.has(identity)) {
            conflicts += 1;
            reasons.set("role_top_rank_conflict", (reasons.get("role_top_rank_conflict") ?? 0) + 1);
          }
          seen.add(identity);
          continue;
        }
        if (seen.has(identity)) continue;
        seen.add(identity);
        const verdict = qualifyRoleAuthorityRow(
          {
            contract: row.contract ?? null,
            businessId: row.business_id ?? null,
            providerAccountId: row.provider_account_id ?? null,
            campaignId: row.campaign_id ?? null,
            asOfDate: row.as_of_date ?? null,
            inferredKind: row.inferred_kind ?? null,
            kindSource: row.kind_source ?? null,
            resolverVersion: row.resolver_version ?? null,
            confidenceClass: row.confidence_class ?? null,
            evidenceHash: row.evidence_hash ?? null,
            inputHash: row.input_hash ?? null,
            effectiveAt: toIso(row.effective_at),
            recordedAt: toIso(row.recorded_at),
            provenance: row.provenance ?? null,
          },
          {
            expectedScope: { businessId, providerAccountId },
            compiledResolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
            approvedResolverVersion: scope.approvedResolverVersion,
            cutoffIso: scope.nowIso,
          },
        );
        if (verdict.qualified) qualifying += 1;
        else for (const b of verdict.blockers) reasons.set(b, (reasons.get(b) ?? 0) + 1);
      }
      const examined = seen.size;
      const status = coverageStatus({ qualifying, examined, population: total, conflicts });
      dimensions.push({
        key: "role_authority_retention",
        closesBlocker: "automatic_role_authority_absent",
        status,
        evidence: examined === 0
          ? "The authority table exists but no qualifying role row has been retained for this account yet."
          : `${qualifying} of ${examined} latest-per-campaign authority rows qualify`
            + (total === null ? "; the population could not be measured" : ` (population ${total})`)
            + (conflicts > 0 ? `; ${conflicts} campaigns have conflicting rows at the top clock rank` : "")
            + (reasons.size > 0 ? `. Leading refusals: ${topReasons(reasons)}` : "")
            + ". Every non-qualifying row stays visible as review-only.",
        source: "engine_v3_campaign_role_authority (latest per campaign, account-scoped)",
        asOf: latest,
        coverage: { qualifying, examined, population: total, conflicts, truncated: total !== null && total > examined },
        blocker: status === "ready" ? null : "automatic_role_authority_absent",
        preconditions: status === "ready"
          ? Object.freeze([])
          : Object.freeze([
            "clear the ingestion fence so the compiled resolver can accrue rows",
            "arm the process-local resolver authority gate for that exact compiled version",
          ]),
      });
    } catch (error) {
      dimensions.push(unknownDimension(
        "role_authority_retention", "automatic_role_authority_absent", sanitiseReadFailure(error),
      ));
    }
  } else {
    /*
      LEGACY IS MIGRATION EVIDENCE, NEVER AUTHORITY.

      Without the authority table there is nothing that could qualify, so the
      legacy daily table is measured only to say how far the migration has to
      travel. This branch can never return `ready`.
    */
    try {
      const rows = await db.query<Record<string, unknown>>(D086_LEGACY_ROLE_SQL,
        [businessId, D086_READINESS_SAMPLE]);
      const legacyTotal = rows.length === 0 ? 0 : parsePopulationTotal(rows[0]?.population_total);
      let latest: string | null = null;
      let accountScoped = 0;
      let compiledVersion = 0;
      for (const row of rows) {
        const asOf = text(row.as_of_date);
        if (asOf && (latest === null || asOf > latest)) latest = asOf;
        if (text(row.provider_account_id).length > 0) accountScoped += 1;
        if (text(row.resolver_version) === CAMPAIGN_CONTEXT_RESOLVER_VERSION) compiledVersion += 1;
      }
      dimensions.push({
        key: "role_authority_retention",
        closesBlocker: "automatic_role_authority_absent",
        status: "forward_only_after_deploy",
        evidence:
          `No authority table exists, so no retained row can carry runtime authority. `
          + `BUSINESS-level migration evidence only: of ${rows.length} legacy daily rows sampled`
          + (legacyTotal === null ? " (population unmeasurable)" : ` from a population of ${legacyTotal}`)
          + `, ${accountScoped} carry a provider account and ${compiledVersion} carry the compiled `
          + "resolver version. Legacy rows are never authority-bearing, and this count is not "
          + "account-scoped.",
        source:
          "engine_v3_campaign_context_daily (BUSINESS-level legacy migration evidence, "
          + "not account authority)",
        asOf: latest,
        /*
          The real population, atomically. r4 published `rows.length` — a 500-row
          LIMIT — as the whole population with `truncated: false`, so TheSwaf's
          758 legacy rows would have been shown as 500 of 500.
        */
        coverage: {
          qualifying: 0,
          examined: rows.length,
          population: legacyTotal,
          conflicts: 0,
          truncated: legacyTotal !== null && legacyTotal > rows.length,
        },
        blocker: "automatic_role_authority_absent",
        preconditions: Object.freeze([
          "deploy the prepared engine_v3_campaign_role_authority table",
          "deploy the compiled name-neutral resolver so version and provider-account scope are written",
          "clear the ingestion fence so the resolver can accrue rows",
          "arm the process-local resolver authority gate for that exact compiled version",
        ]),
      });
    } catch (error) {
      dimensions.push(unknownDimension(
        "role_authority_retention", "automatic_role_authority_absent", sanitiseReadFailure(error),
      ));
    }
  }

  return {
    contract: BUDGET_READINESS_CONTRACT,
    businessId,
    providerAccountId,
    scopeBlocker: null,
    compiledResolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    dimensions: Object.freeze(dimensions),
    blockers: Object.freeze(
      [...new Set(dimensions.map((d) => d.blocker).filter((b): b is string => b !== null))].sort(),
    ),
  };
}

/** A timestamp column may arrive as a Date or a string; both become one ISO instant. */
function toIso(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The single most frequent refusal, so the published blocker is the real cause. */
function leadingRefusal(reasons: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [code, count] of reasons) {
    if (count > bestCount || (count === bestCount && best !== null && code < best)) {
      best = code; bestCount = count;
    }
  }
  return best;
}

function topReasons(reasons: Map<string, number>): string {
  return [...reasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([code, count]) => `${code} (${count})`)
    .join(", ") || "none recorded";
}

/** Re-exported so a consumer cannot drift from the contract it renders. */
export { D086_RETENTION_CONTRACT };
