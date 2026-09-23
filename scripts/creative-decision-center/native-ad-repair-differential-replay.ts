/**
 * BOUNDED, READ-ONLY differential replay for the Meta native ad repair.
 *
 * ── What this is, and what it deliberately is not ────────────────────────────
 * This is NOT a native decision job replay. Producing decisions means running
 * `runAdDecisionsJob`, which writes snapshots, evaluations and receipts; there
 * is no read-only mode for it and inventing one would mean a second decision
 * producer. So this measures the REPAIRED INPUTS and the PURE DECISION
 * TRANSFORMS against the same retained rows the job would read, and it says so
 * in its output. It cannot prove the integrated job.
 *
 * It is also NOT a challenger. It proposes no threshold, no alternative
 * resolver and no promotion; the resolver is untouched. It answers one
 * question: on rows we actually retained, what do the readers in this tree see
 * that the pre-repair semantics did not? Nothing here is deployed. The objective
 * dimension reads the same field-level source SQL used by native calibration
 * and decision hydration at the historical cutoff.
 *
 * The existing research replays cannot answer that:
 *   - generalized-pit-replay.ts and exact-pit-confirmatory-replay.ts import
 *     only types/constants and carry their own frozen logic.
 *   - native-ad-grain-paired-replay.ts reads the STALE top-level funnel keys
 *     and coerces link_clicks through numberOrZero, so it reproduces both
 *     defects the repair removed.
 *   - current-engine-historical-replay.ts exercises the campaign-role guard at
 *     CREATIVE grain only, and reports sourceMode runtime_sql_fallback.
 * None of them is modified here. Editing a frozen research artifact so that it
 * agrees with a new implementation destroys the only thing it was keeping.
 *
 * ── Timeliness and source auditability, kept apart ──────────────────────────
 * Every ad-day is classified against the selected evaluation run's cutoff:
 *
 *   admissible_at_cutoff  The retained input's clocks precede the chosen run.
 *   restated_after_cutoff The input exists now but arrived after that run.
 *   unresolved_by_reader  This reader returned no value; another retained
 *                         source may still exist or await an approved repair.
 *
 * These labels speak to this reader's availability, not provider provenance or whether a
 * configuration field was valid for the entire report day. Auditability is
 * reported separately; neither axis upgrades the other.
 *
 * Nothing here invents an objective, a role, a status, a target or a ThruPlay
 * figure. Where this reader cannot resolve one, the output says why and stops.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 * Refuses to run unless the session is already read-only, contains no DML, and
 * writes no artifact unless asked. Bounded by business, date range and a row
 * ceiling.
 *
 * Usage:
 *   PGOPTIONS="-c default_transaction_read_only=on" \
 *   node --import tsx scripts/creative-decision-center/native-ad-repair-differential-replay.ts \
 *     --business <businessId> --startDate 2026-08-25 --endDate 2026-09-20 \
 *     [--maxRows 50000] [--out <path>] [--write 0]
 */
import { writeFileSync } from "node:fs";

import { AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL } from "@/lib/creative-decision-engine/data-source";
import {
  buildMetaConfigFieldSourceSql,
  type MetaConfigFieldReadiness,
} from "@/lib/meta/config-field-source-contract";
import { buildMetaFunnelStageSql } from "@/lib/meta/funnel-stage-parse";
import { parseMetaLinkClicksFromActions } from "@/lib/meta/link-click-parse";
import {
  classifyAdDayLinkClick,
  emptyActionTally,
  isWritingAction,
  requiresProviderResync,
  type LinkClickRepairAction,
} from "@/scripts/meta/link-click-repair-backfill";
import { projectMetaDecisionSemantics } from "@/lib/meta/decision-semantics";
import { adAction } from "@/lib/meta/decisions-os-presentation";

import {
  pinReadOnlySnapshot,
  ReadOnlySnapshotError,
  type PinnedReadOnlySnapshot,
} from "./read-only-snapshot";
import { configureOperationalScriptRuntime } from "../_operational-runtime";

export class DifferentialReplayUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DifferentialReplayUsageError";
  }
}

/** Every ceiling in one object, so "is this bounded?" is one read. */
export const DIFFERENTIAL_REPLAY_BOUNDS = {
  maxRowsDefault: 50_000,
  maxRowsCeiling: 250_000,
  maxRangeDays: 120,
  queryTimeoutMsDefault: 120_000,
} as const;

/**
 * TIMELINESS only — whether the input was already visible at the run's cutoff.
 *
 * These were once called exact_pit / restated, which read as provenance claims.
 * They never were: the test is purely `provenance <= cutoff` over warehouse
 * clocks and never asks whether a receipt exists. Auditability is the separate
 * AuditabilityClass axis, so these names now say only what they measure.
 */
export type EvidenceClass =
  | "admissible_at_cutoff"
  | "restated_after_cutoff"
  | "unresolved_by_reader";

/**
 * The only config source_kind that is a provider config observation.
 * `warehouse_daily` rows are restated from ad-level Insights (see the objective
 * block below) and carry no config authority.
 */
export const CONFIG_RECEIPT_SOURCE_KIND = "provider_config_receipt";

/**
 * Whose semantics the `repaired` column is.
 *
 * Nothing in this differential is deployed, so neither value means "live". The
 * distinction is narrower and it matters more: does the reader in this tree
 * actually behave this way, or is this a gate that has only been proposed?
 */
export type RepairedSemanticsProvenance =
  | "reader_implemented_in_tree"
  | "proposed_gate_not_implemented";

/**
 * How far a resolved value can be traced back toward the provider.
 *
 * This is a SECOND, INDEPENDENT axis, not a third rung under the timeliness
 * classes. The two do not order into one scale: a typed row observed inside the
 * day it describes is timely but unauditable, while a payload-backed row
 * restated a week later is auditable but not timely. Neither dominates.
 *
 * The NAMES are deliberately borrowed from the vocabulary that already exists
 * at lib/creative-decision-engine/simulation/input-manifest.ts:15-21
 * (SimulationProvenanceClass). Minting a parallel set would leave the codebase
 * with two competing taxonomies for one idea, which is the divergence this whole
 * area keeps paying for.
 *
 *   exact_observation      read out of a retained verbatim provider payload.
 *   bitemporal_observation a typed row that REACHES a retained receipt through
 *                          its observation run; auditable, but its own clock may
 *                          be a carry-forward rather than a per-day sighting.
 *   persisted_input        a typed row with no reachable receipt at all.
 *   none                   nothing resolved.
 */
export type AuditabilityClass =
  | "exact_observation"
  | "bitemporal_observation"
  | "persisted_input"
  | "none";

export interface DimensionReport {
  dimension: string;
  /** Never call a proposed gate a repair: see RepairedSemanticsProvenance. */
  repairedSemantics: RepairedSemanticsProvenance;
  /** What the pre-repair semantics resolved. */
  baselineResolved: number;
  /** What the current production semantics resolves. */
  repairedResolved: number;
  /** Rows the repair newly resolves. */
  gained: number;
  /** Rows the repair stops resolving because the old answer was fabricated. */
  withdrawn: number;
  /** Rows where both resolve but disagree. */
  disagreed: number;
  byEvidenceClass: Record<EvidenceClass, number>;
  /** Independent of byEvidenceClass: see AuditabilityClass. */
  byAuditability: Record<AuditabilityClass, number>;
  /**
   * Resolved by a contemporaneous TYPED source that holds no raw receipt.
   * Counted apart from repairedResolved so a receipt-only gate reporting 0
   * cannot be read as "no evidence exists".
   */
  typedContemporaneousResolved: number;
  /** Named unresolved cases, including true source absence and pending authority. */
  missingDataControls: Record<string, number>;
  /**
   * Which production reader "repaired" means, when more than one reads the
   * same field differently. Absent when one reader is the only reader.
   */
  readerScope?: string;
}

export interface DifferentialReplayReceipt {
  mode: "read_only_differential_replay";
  scope: { businessId: string; startDate: string; endDate: string };
  bounds: { maxRows: number; queryTimeoutMs: number };
  /** What this receipt may and may not be read as. */
  claim: {
    provesIntegratedNativeJob: false;
    provesPointInTimeValidity: "only_for_rows_admissible_at_cutoff";
    resolverChanged: false;
    /** Nothing measured here is deployed; check each dimension's provenance. */
    readerSemanticsDeployed: false;
    /**
     * Each kind of evidence named separately, because they are not the same
     * claim and a reader must not add them up into one.
     */
    evidenceLanes: {
      /** SQL readers from this tree, run over retained rows. */
      readerDimensions: "current_tree_readers_over_retained_rows";
      /**
       * The current tree's served-semantics transforms, applied to PERSISTED
       * held rows. The label and held action are the persisted ones — no
       * decision is recomputed — and the surrounding context (badges, role,
       * source authority, hard-action eligibility) is fixed by this runner,
       * not read from the row.
       */
      decisionSemantics: "current_tree_pure_transforms_over_persisted_held_rows_with_fixed_context";
      decisionsRecomputed: false;
      integratedPersistedJob: false;
      providerMutation: "none_no_provider_client_in_this_runner";
      databaseWrites: "none_read_only_transaction";
    };
    /**
     * True only when every query ran inside one pinned read-only REPEATABLE
     * READ transaction (see `snapshot`). A receipt built from rows handed in
     * directly cannot make that claim.
     */
    consistentSnapshot: boolean;
  };
  /** The one MVCC snapshot every query read, or null when built from rows. */
  snapshot: PinnedReadOnlySnapshot | null;
  /**
   * The one run this differential is measured against. `null` means no
   * successful run covers the cohort, so nothing can be exact_pit.
   */
  pitAnchor: { asOfDate: string; cutoff: string } | null;
  adDaysExamined: number;
  /** Either population hit the ceiling. See `truncation` for which. */
  truncatedByMaxRows: boolean;
  /**
   * Per population. Held decisions are bounded separately from ad-days, and a
   * truncated held set used to be reported as complete because this flag was
   * derived from the ad-days alone.
   */
  truncation: { adDays: boolean; heldDecisions: boolean };
  /**
   * How much of the payload was still settling. Reported, never used to
   * classify: an ad-day final at its first consuming run was never restated,
   * while the rest were still moving inside Meta's attribution window.
   */
  payloadSettling: {
    finalAtFirstConsumingRun: number;
    restatedAfterFirstConsumingRun: number;
    noConsumingRunFound: number;
  };
  dimensions: DimensionReport[];
  /** Objective values by the native field-source contract's allowed use. */
  objectiveSourceReadiness: Record<MetaConfigFieldReadiness, number>;
  /**
   * Gains the CURRENT reader does not make, which a bounded DB backfill could.
   * Kept out of the dimensions so no figure there reports unshipped work.
   */
  backfillPotential: {
    linkClicks: {
      /** The shared classifier this potential is computed with. */
      contract: "classifyAdDayLinkClick";
      wouldWrite: number;
      wouldWriteAndExactPit: number;
      requiresProviderResync: number;
      byAction: Record<LinkClickRepairAction, number>;
    };
  };
  decisionSemantics: {
    heldRowsExamined: number;
    /** Held rows by the engine epoch that persisted them; not all epochs mean the same. */
    heldRowsByEngineVersion: Record<string, number>;
    baseline: Record<string, number>;
    repaired: Record<string, number>;
    /** Asserted on every row: the repair grants no execution. */
    authorityUnchanged: {
      authorizedActionNonNullBefore: number;
      providerMutationOfferedAfter: number;
      decisionStateNotBlockedAfter: number;
    };
  };
}

interface ParsedArgs {
  businessId: string;
  startDate: string;
  endDate: string;
  /** The evaluation run to measure against; null selects the latest in range. */
  asOf: string | null;
  maxRows: number;
  outPath: string | null;
  write: boolean;
  queryTimeoutMs: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDateOrNull(value: string): string | null {
  if (!ISO_DATE.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return null;
  // Date.parse rolls 2026-02-31 forward, which would silently move the window.
  return new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new DifferentialReplayUsageError(`--${name} requires a value.`);
  }
  return value;
}

export function parseDifferentialReplayArgs(argv: string[]): ParsedArgs {
  const businessId = flagValue(argv, "business")?.trim();
  if (!businessId) {
    throw new DifferentialReplayUsageError(
      "--business is required: this replay never runs across every business.",
    );
  }
  const startRaw = flagValue(argv, "startDate");
  const endRaw = flagValue(argv, "endDate");
  if (!startRaw || !endRaw) {
    throw new DifferentialReplayUsageError(
      "--startDate and --endDate are required.",
    );
  }
  const startDate = isoDateOrNull(startRaw);
  const endDate = isoDateOrNull(endRaw);
  if (!startDate || !endDate) {
    throw new DifferentialReplayUsageError(
      "--startDate and --endDate must be real ISO dates.",
    );
  }
  if (startDate > endDate) {
    throw new DifferentialReplayUsageError("--startDate is after --endDate.");
  }
  const spanDays =
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) /
      86_400_000 +
    1;
  if (spanDays > DIFFERENTIAL_REPLAY_BOUNDS.maxRangeDays) {
    throw new DifferentialReplayUsageError(
      `range is ${spanDays} days; the ceiling is ${DIFFERENTIAL_REPLAY_BOUNDS.maxRangeDays}.`,
    );
  }
  /*
    The evaluation run. A decision was produced by ONE run reading its whole
    trailing window at once, so that run's start is the only cutoff that
    describes what the decision could have used. Omitted, the latest successful
    run at or before --endDate is chosen and named in the receipt.
  */
  const asOfRaw = flagValue(argv, "asOf");
  const asOf = asOfRaw === null ? null : isoDateOrNull(asOfRaw);
  if (asOfRaw !== null && asOf === null) {
    throw new DifferentialReplayUsageError("--asOf must be a real ISO date.");
  }
  if (asOf !== null && asOf < endDate) {
    throw new DifferentialReplayUsageError(
      `--asOf ${asOf} precedes --endDate ${endDate}: that run never saw the later ad-days.`,
    );
  }
  const maxRowsRaw = flagValue(argv, "maxRows");
  const maxRows = maxRowsRaw
    ? Number(maxRowsRaw)
    : DIFFERENTIAL_REPLAY_BOUNDS.maxRowsDefault;
  if (
    !Number.isInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > DIFFERENTIAL_REPLAY_BOUNDS.maxRowsCeiling
  ) {
    throw new DifferentialReplayUsageError(
      `--maxRows must be an integer in [1, ${DIFFERENTIAL_REPLAY_BOUNDS.maxRowsCeiling}].`,
    );
  }
  return {
    businessId,
    startDate,
    endDate,
    asOf,
    maxRows,
    outPath: flagValue(argv, "out"),
    // Writing an artifact into the tree is opt-in, so a measurement run cannot
    // change the repository as a side effect.
    write: flagValue(argv, "write") === "1",
    queryTimeoutMs: DIFFERENTIAL_REPLAY_BOUNDS.queryTimeoutMsDefault,
  };
}

/** data-source.ts:751 — the engine's default trailing window. */
export const REPLAY_ENGINE_WINDOW_DAYS = 90;

/**
 * The point-in-time anchor is the ORIGINAL job run, not the wall clock.
 *
 * The question a repair differential has to answer is "could the job that
 * actually produced a decision from this ad-day have seen this input?" — so the
 * cutoff is that run's own start, recovered from engine_v3_job_runs. An input
 * whose provenance precedes it is evidence the job had and did not use; an
 * input that arrived later is a counterfactual about today's warehouse and is
 * reported as restated, never as a missed opportunity.
 *
 * WHICH run matters, and two wrong answers are easy.
 *
 * Anchoring ad-day D to the run stamped as_of_date D is wrong: live runs for D
 * start at ~03:06 UTC on D itself, before ad-day D exists, so admissible-at-cutoff becomes
 * structurally impossible for everything read out of the payload and the zero
 * measures the join rather than the repair.
 *
 * Anchoring D to the FIRST run that could consume it once complete is also
 * wrong, though less obviously. A run reads a 90-day window in one pass, so a
 * decision is a statement about the window as it stood at that run's start —
 * and Meta keeps restating a day's insights through its attribution window.
 * Judging each ad-day against the earliest run that touched it therefore counts
 * ordinary settling as restatement: on the live TheSwaf cohort it reports 125 of
 * 925 inputs admissible at cutoff where one evaluation run reports far more.
 *
 * So the anchor is ONE evaluation run, named in the receipt (--asOf, default the
 * latest successful run at or before --endDate), and the ad-day range must lie
 * inside that run's trailing window or the run never saw it. A cohort with no
 * successful run has no anchor, and every row is restated by construction.
 */
export const REPLAY_PIT_ANCHOR_SQL = `
  SELECT as_of_date::text AS as_of_date, started_at AS pit_cutoff
  FROM engine_v3_job_runs
  WHERE job_name = 'engine_v3_native_ad_decisions_shadow_job'
    AND business_id = $1
    AND status = 'success'
    AND as_of_date >= $2::date
    AND as_of_date <= COALESCE($4::date, $3::date)
    AND ($4::date IS NULL OR as_of_date = $4::date)
  ORDER BY as_of_date DESC, started_at ASC
  LIMIT 1
`;


/** Built from the production contract, so baseline and repaired cannot drift. */
const FUNNEL_SQL = buildMetaFunnelStageSql({
  payloadExpression: "d.payload_json",
  lateralAlias: "funnel_actions",
  stages: ["landing_page_view", "add_to_cart", "initiate_checkout"],
});

/**
 * One bounded row per spending ad-day, carrying BOTH semantics side by side.
 *
 * The baseline expressions are the pre-repair ones verbatim: the top-level
 * payload keys for funnel stages, the stored link_clicks column read as a
 * number, the newest config at the evaluation cutoff regardless of the day, and
 * the campaign/creative pair as meta_creative_daily collapsed it. They are kept
 * here rather than deleted because a differential needs the thing it differs
 * from, and reading them from the frozen research replay would import its stale
 * link-click coercion with them.
 */
export const REPLAY_AD_DAY_SQL = `
  SELECT
    d.provider_account_id,
    d.campaign_id,
    d.ad_id,
    d.date::text AS date,
    d.spend,
    ((d.date + 1)::timestamp AT TIME ZONE COALESCE(NULLIF(BTRIM(d.account_timezone), ''), 'UTC')) AS local_day_end,
    d.created_at AS row_created_at,
    d.updated_at AS row_updated_at,
    first_run.started_at AS first_consuming_run_started_at,

    -- Funnel, pre-repair: top-level keys that meta_ad_daily has never carried.
    (NULLIF(d.payload_json->>'landing_page_views', ''))::numeric AS baseline_lpv,
    (NULLIF(d.payload_json->>'add_to_cart', ''))::numeric AS baseline_atc,
    (NULLIF(d.payload_json->>'initiate_checkout', ''))::numeric AS baseline_ic,

    -- Funnel, current production contract.
    ${FUNNEL_SQL.valueSql("landing_page_view")} AS repaired_lpv,
    ${FUNNEL_SQL.stateSql("landing_page_view")} AS repaired_lpv_state,
    ${FUNNEL_SQL.valueSql("add_to_cart")} AS repaired_atc,
    ${FUNNEL_SQL.valueSql("initiate_checkout")} AS repaired_ic,

    /*
      Link clicks, three separate things that must not be conflated:
        - the stored column, which is what the pre-repair reader took;
        - what TODAY's production reader resolves from it (D095: a stored zero is
          a measurement only when the same row's actions corroborate it);
        - the raw entries, which say what a DB backfill could still recover.
      (No backticks in this block: it sits inside a template literal.)
      The reader expression is imported, not restated. It is the Refresh
      BAND reader only: the resolver's cumulative link-click total still sums
      the raw column with nulls folded to zero, and native calibration still
      reads the raw column, so today one row CAN be classified three ways and
      this dimension speaks for the band path alone (see readerScope). It reads
      unqualified link_clicks and payload_json; only meta_ad_daily exposes
      those here, because every lateral below projects a narrow column list.
    */
    d.link_clicks AS baseline_link_clicks,
    ${AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL} AS reader_link_clicks,
    jsonb_path_query_array(
      d.payload_json,
      '$.actions[*] ? (@.action_type == "link_click")'
    ) AS raw_link_click_entries,
    (jsonb_typeof(d.payload_json->'actions') IS NOT DISTINCT FROM 'array') AS actions_present,

    -- Objective: newest-at-cutoff (pre-repair) vs as-of the provider-local day,
    -- each carrying the source_kind that decides whether it is evidence at all.
    cutoff_cfg.objective AS baseline_objective,
    asof_receipt.objective AS receipt_objective,
    asof_receipt.captured_at AS receipt_objective_captured_at,
    asof_receipt.created_at AS receipt_objective_created_at,
    /*
      Whether the receipt was observed INSIDE the provider-local day, or is the
      newest earlier one carried forward.

      Both readings have to be kept, because config_history is a change log: a
      later real API observation that finds the config unchanged coalesces into
      the existing row rather than appending one, so requiring a same-day
      capture would call healthy unchanged days unknown. But carrying an older
      receipt forward is only sound if something proves the config was observed
      AGAIN on the later day, and this table cannot say that — a day-level
      observation heartbeat (meta_raw_snapshot_observations) or field-level
      normalized provenance would be needed, and neither is wired here. So a
      carried receipt is reported separately and resolves nothing, rather than
      being silently promoted or silently discarded.
    */
    (asof_receipt.captured_at >= (d.date::timestamp AT TIME ZONE COALESCE(NULLIF(BTRIM(d.account_timezone), ''), 'UTC')))
      AS receipt_objective_same_day,
    typed_witness.objective AS typed_witness_objective,
    typed_witness.updated_at AS typed_witness_observed_at,
    asof_any.objective AS asof_objective,
    asof_any.source_kind AS asof_objective_source_kind,

    -- Creative: collapsed creative-day row vs as-of state history.
    collapsed.creative_id AS baseline_creative_id,
    collapsed.campaign_id AS baseline_creative_campaign_id,
    asof_state.creative_id AS repaired_creative_id,
    asof_state.observed_at AS repaired_creative_observed_at,
    asof_state.captured_at AS repaired_creative_captured_at,
    asof_state.presence AS repaired_creative_presence,
    asof_state.has_coverage AS repaired_creative_has_coverage
  FROM meta_ad_daily d
  /*
    Secondary, reported but never used to classify: the first successful run that
    could have consumed this ad-day once it was complete. The gap between this
    and the evaluation cutoff is how much of the payload was still settling.
  */
  LEFT JOIN LATERAL (
    SELECT r.started_at
    FROM engine_v3_job_runs r
    WHERE r.job_name = 'engine_v3_native_ad_decisions_shadow_job'
      AND r.business_id = $1
      AND r.status = 'success'
      AND r.as_of_date >= d.date
      AND r.as_of_date <= d.date + ${REPLAY_ENGINE_WINDOW_DAYS}
      AND r.started_at >= ((d.date + 1)::timestamp AT TIME ZONE COALESCE(NULLIF(BTRIM(d.account_timezone), ''), 'UTC'))
    ORDER BY r.started_at
    LIMIT 1
  ) first_run ON TRUE
  ${FUNNEL_SQL.lateralSql}
  /*
    The pre-repair reader: newest config at the EVALUATION cutoff, with no bound
    tying it to the ad-day. That missing day bound is the future-config leak
    itself, so it is reproduced deliberately — but the cutoff is bound to the
    resolved run rather than left open, because an unbounded read would also
    import config written after the run and overstate the leak.
  */
  LEFT JOIN LATERAL (
    SELECT c.objective
    FROM meta_campaign_config_history c
    WHERE c.business_id = $1
      AND c.provider_account_id = d.provider_account_id
      AND c.campaign_id = d.campaign_id
      AND ($5::timestamptz IS NULL OR c.captured_at < $5::timestamptz)
    ORDER BY c.captured_at DESC, c.created_at DESC, c.id DESC
    LIMIT 1
  ) cutoff_cfg ON TRUE
  /*
    A genuine provider config receipt, as-of the provider-local day. The source
    filter belongs HERE, not in the caller: ordering by captured_at DESC and
    taking one row from the unfiltered table lets a newer restated row mask a real receipt
    underneath it, so a JS-side check on the winner would report "no receipt"
    for a campaign that has one.
  */
  LEFT JOIN LATERAL (
    SELECT c.objective, c.captured_at, c.created_at
    FROM meta_campaign_config_history c
    WHERE c.business_id = $1
      AND c.provider_account_id = d.provider_account_id
      AND c.campaign_id = d.campaign_id
      AND c.source_kind = '${CONFIG_RECEIPT_SOURCE_KIND}'
      AND c.captured_at < ((d.date + 1)::timestamp AT TIME ZONE COALESCE(NULLIF(BTRIM(d.account_timezone), ''), 'UTC'))
    ORDER BY c.captured_at DESC, c.created_at DESC, c.id DESC
    LIMIT 1
  ) asof_receipt ON TRUE
  /*
    The contemporaneous TYPED witness for objective, at its strictest.

    meta_creative_daily.objective comes from the nested live edge value
    ad?.campaign?.objective (creatives-row-mappers.ts:748) and holds no raw
    receipt. Its upsert sets objective = COALESCE(EXCLUDED.objective, existing)
    while advancing updated_at unconditionally, so a same-day updated_at alone
    proves nothing; requiring created_at AND updated_at inside the same
    provider-local day does, because then every write to that row happened
    within that day. Two further guards, both needed: ad_id on that table is a
    creative hash rather than a provider ad id, and one creative in the affected
    set maps to several campaigns while the writer coalesces the campaign
    relation on merge — so the row must carry a single ad and its real_ad_id must
    independently resolve to this campaign at ad grain.
  */
  LEFT JOIN LATERAL (
    SELECT cd.objective, cd.created_at, cd.updated_at
    FROM meta_creative_daily cd
    WHERE cd.business_id = $1
      AND cd.provider_account_id = d.provider_account_id
      AND cd.campaign_id = d.campaign_id
      AND cd.date = d.date
      AND cd.spend > 0
      AND NULLIF(BTRIM(cd.objective), '') IS NOT NULL
      AND cd.created_at >= (d.date::timestamp AT TIME ZONE COALESCE(NULLIF(BTRIM(cd.account_timezone), ''), 'UTC'))
      AND cd.updated_at <  ((d.date + 1)::timestamp AT TIME ZONE COALESCE(NULLIF(BTRIM(cd.account_timezone), ''), 'UTC'))
      AND COALESCE((cd.payload_json->>'associated_ads_count')::int, 1) <= 1
      AND EXISTS (
        SELECT 1 FROM meta_ad_daily anchor
        WHERE anchor.business_id = cd.business_id
          AND anchor.provider_account_id = cd.provider_account_id
          AND anchor.date = cd.date
          AND anchor.ad_id = cd.payload_json->>'real_ad_id'
          AND anchor.campaign_id = d.campaign_id)
    ORDER BY cd.updated_at DESC
    LIMIT 1
  ) typed_witness ON TRUE
  /* The same read WITHOUT the filter, only to name what is there instead. */
  LEFT JOIN LATERAL (
    SELECT c.objective, c.source_kind
    FROM meta_campaign_config_history c
    WHERE c.business_id = $1
      AND c.provider_account_id = d.provider_account_id
      AND c.campaign_id = d.campaign_id
      AND c.captured_at < ((d.date + 1)::timestamp AT TIME ZONE COALESCE(NULLIF(BTRIM(d.account_timezone), ''), 'UTC'))
    ORDER BY c.captured_at DESC, c.created_at DESC, c.id DESC
    LIMIT 1
  ) asof_any ON TRUE
  /*
    The pre-repair ad-grain creative source is meta_ad_dimensions, NOT
    meta_creative_daily. That table's ad_id column holds a synthetic creative
    slug (for example creative_1des8be) rather than a provider ad id, so it
    cannot be joined at ad grain at all: on this cohort 650 creative-day rows
    exist and 0 of 610 spending ad-days match on (account, date, ad_id).
    Reporting it as the baseline would credit the repair with resolving
    something the old reader never attempted, so the collapse defect is measured
    at its own grain elsewhere and not conflated with this dimension.
  */
  LEFT JOIN LATERAL (
    SELECT dim.creative_id, dim.campaign_id
    FROM meta_ad_dimensions dim
    WHERE dim.business_id = $1
      AND dim.provider_account_id = d.provider_account_id
      AND dim.ad_id = d.ad_id
    LIMIT 1
  ) collapsed ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      h.creative_id,
      h.observed_at,
      h.captured_at,
      h.presence,
      (h.field_coverage_json->>'creativeId' = 'true') AS has_coverage
    FROM meta_entity_state_history h
    WHERE h.business_id = $1
      AND h.provider_account_id = d.provider_account_id
      AND h.entity_type = 'ad'
      AND h.observed_at < ((d.date + 1)::timestamp AT TIME ZONE COALESCE(NULLIF(BTRIM(d.account_timezone), ''), 'UTC'))
      AND h.entity_id = d.ad_id
    ORDER BY h.observed_at DESC, h.captured_at DESC, h.id DESC
    LIMIT 1
  ) asof_state ON TRUE
  WHERE d.business_id = $1
    AND d.date BETWEEN $2::date AND $3::date
    AND d.spend > 0
    AND d.truth_state = 'finalized'
    AND d.validation_status = 'passed'
  ORDER BY d.date, d.provider_account_id, d.ad_id
  /* One more than asked, so an exactly-full page is not reported as truncated. */
  LIMIT ($4::int + 1)
`;

/**
 * Native objective source, resolved with the production field-source contract.
 * The bounded ad-day CTE has the same filter, order, and ceiling as the main
 * query so every row is compared to the same retained input. The contract
 * itself owns all receipt admission, typed-witness, and cutoff rules.
 */
const REPLAY_OBJECTIVE_SOURCE = buildMetaConfigFieldSourceSql({
  businessParam: "$1::text",
  scopeStartParam: "$2",
  scopeEndParam: "$3",
  evaluationCutoffParam: "$5",
  dayExpression: "d.date",
  timezoneExpression: "d.account_timezone",
  accountExpression: "d.provider_account_id",
  campaignExpression: "d.campaign_id",
  accountScopeSql: "SELECT DISTINCT provider_account_id FROM config_scope",
  campaignScopeSql: "SELECT DISTINCT campaign_id FROM config_scope WHERE campaign_id IS NOT NULL",
  scopeRelationSql: "SELECT provider_account_id, campaign_id, date, account_timezone FROM config_scope",
  aliasPrefix: "replay_objective_cfg",
});

export const REPLAY_OBJECTIVE_SOURCE_SQL = `
  WITH ad_days AS MATERIALIZED (
    SELECT d.provider_account_id, d.campaign_id, d.ad_id, d.date,
           d.account_timezone
    FROM meta_ad_daily d
    WHERE d.business_id = $1
      AND d.date BETWEEN $2::date AND $3::date
      AND d.spend > 0
      AND d.truth_state = 'finalized'
      AND d.validation_status = 'passed'
    ORDER BY d.date, d.provider_account_id, d.ad_id
    LIMIT ($4::int + 1)
  ),
  config_scope AS MATERIALIZED (
    SELECT DISTINCT provider_account_id, campaign_id, date, account_timezone
    FROM ad_days
    WHERE campaign_id IS NOT NULL
  ),
  ${REPLAY_OBJECTIVE_SOURCE.withSql}
  SELECT d.provider_account_id, d.campaign_id, d.ad_id, d.date::text AS date,
         ${REPLAY_OBJECTIVE_SOURCE.valueSql("objective")} AS objective_source_value,
         ${REPLAY_OBJECTIVE_SOURCE.tierSql("objective")} AS objective_source_tier,
         ${REPLAY_OBJECTIVE_SOURCE.readinessSql("objective")} AS objective_source_readiness,
         ${REPLAY_OBJECTIVE_SOURCE.sourceClassSql("objective")} AS objective_source_class,
         ${REPLAY_OBJECTIVE_SOURCE.pitClassSql("objective")} AS objective_source_pit_class
  FROM ad_days d
  ${REPLAY_OBJECTIVE_SOURCE.lateralSql}
  ORDER BY d.date, d.provider_account_id, d.ad_id
`;

/**
 * Persisted rows the role guard held, for the pure-transform differential.
 *
 * ORDERED on a total key before the LIMIT. Without it the bounded read was
 * whatever subset the planner happened to return first, so two runs of the
 * same replay could examine different held rows and a truncated population
 * could be reported as if it were the whole of it. `id` is the primary key and
 * breaks every remaining tie.
 */
export const REPLAY_HELD_DECISION_SQL = `
  SELECT label, blocked_action_type, authority_blocker, authorized_action,
         engine_version
  FROM engine_v3_ad_decision_snapshots_daily
  WHERE business_id = $1
    AND as_of_date BETWEEN $2::date AND $3::date
    AND authority_blocker = 'campaign_context'
  ORDER BY as_of_date, provider_account_id, decision_entity_id,
           scope_type, scope_id, engine_version, id
  LIMIT ($4::int + 1)
`;

type Row = Record<string, unknown>;

const text = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : null;
const num = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const instant = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

function emptyDimension(
  dimension: string,
  repairedSemantics: RepairedSemanticsProvenance = "reader_implemented_in_tree",
): DimensionReport {
  return {
    dimension,
    repairedSemantics,
    byAuditability: {
      exact_observation: 0,
      bitemporal_observation: 0,
      persisted_input: 0,
      none: 0,
    },
    typedContemporaneousResolved: 0,
    baselineResolved: 0,
    repairedResolved: 0,
    gained: 0,
    withdrawn: 0,
    disagreed: 0,
    byEvidenceClass: {
      admissible_at_cutoff: 0,
      restated_after_cutoff: 0,
      unresolved_by_reader: 0,
    },
    missingDataControls: {},
  };
}

/**
 * Classify one dimension on one ad-day.
 *
 * `repairedProvenance` is the observation instant of the input the repaired path
 * actually used. Null means this reader used nothing; it does not establish
 * that the provider or another retained source supplied nothing.
 */
function classify(
  report: DimensionReport,
  input: {
    baselineResolved: boolean;
    repairedResolved: boolean;
    baselineValue: string | number | null;
    repairedValue: string | number | null;
    repairedProvenance: number | null;
    pitCutoff: number | null;
    missingControl: string | null;
    /** Auditability of the repaired value; ignored when nothing resolved. */
    auditability?: AuditabilityClass;
  },
): void {
  if (input.baselineResolved) report.baselineResolved += 1;
  if (input.repairedResolved) report.repairedResolved += 1;
  if (!input.baselineResolved && input.repairedResolved) report.gained += 1;
  if (input.baselineResolved && !input.repairedResolved) report.withdrawn += 1;
  if (
    input.baselineResolved &&
    input.repairedResolved &&
    String(input.baselineValue) !== String(input.repairedValue)
  ) {
    report.disagreed += 1;
  }

  const evidence: EvidenceClass = !input.repairedResolved
    ? "unresolved_by_reader"
    : input.pitCutoff !== null &&
        input.repairedProvenance !== null &&
        input.repairedProvenance <= input.pitCutoff
      ? "admissible_at_cutoff"
      : "restated_after_cutoff";
  report.byEvidenceClass[evidence] += 1;
  report.byAuditability[
    input.repairedResolved ? (input.auditability ?? "persisted_input") : "none"
  ] += 1;

  if (input.missingControl) {
    report.missingDataControls[input.missingControl] =
      (report.missingDataControls[input.missingControl] ?? 0) + 1;
  }
}

export function buildDifferentialFromRows(
  adDayRows: readonly Row[],
  heldRows: readonly Row[],
  scope: {
    businessId: string;
    startDate: string;
    endDate: string;
    pitAnchor?: { asOfDate: string; cutoff: string } | null;
    snapshot?: PinnedReadOnlySnapshot | null;
  },
  bounds: { maxRows: number; queryTimeoutMs: number },
): DifferentialReplayReceipt {
  /*
    Backfill potential is computed with the BACKFILL's own classifier, not a
    second opinion about the same rows. The contract differs from a bare strict
    parse in a way that matters: an actions array that was returned and does not
    list link_click is Meta's measured-zero encoding, so it is a writable
    fill_measured_zero rather than an unrecoverable refusal. Restating that rule
    here would have the runner contradict the tool whose potential it reports.
  */
  const backfill = {
    contract: "classifyAdDayLinkClick" as const,
    wouldWrite: 0,
    wouldWriteAndExactPit: 0,
    requiresProviderResync: 0,
    byAction: emptyActionTally(),
  };
  let finalAtFirstConsumingRun = 0;
  let restatedAfterFirstConsumingRun = 0;
  let noConsumingRunFound = 0;
  const lpv = emptyDimension("funnel_landing_page_view");
  /*
    Scoped, because the claim would otherwise be false. The band reader applies
    D095; the resolver's cumulative total (SUM of the column with nulls folded to
    zero) and native calibration (the raw column) do not yet. A reviewer reading
    "repaired" here must not conclude every decision path refuses a fabricated
    zero.
  */
  const linkClicks: DimensionReport = {
    ...emptyDimension("link_clicks"),
    readerScope:
      "refresh_band_reader_only_resolver_cumulative_and_calibration_still_read_the_raw_column",
  };
  const objective = emptyDimension("campaign_objective_field_source");
  const objectiveSourceReadiness: Record<MetaConfigFieldReadiness, number> = {
    decision_authority: 0,
    review_only: 0,
    none: 0,
  };
  const creative = emptyDimension("ad_creative_attribution");

  /*
    Queries fetch maxRows + 1, so a population exactly the size of the ceiling
    is not misreported as truncated.
  */
  const truncation = {
    adDays: adDayRows.length > bounds.maxRows,
    heldDecisions: heldRows.length > bounds.maxRows,
  };
  const truncatedByMaxRows = truncation.adDays || truncation.heldDecisions;
  const adDays = adDayRows.slice(0, bounds.maxRows);
  const heldInScope = heldRows.slice(0, bounds.maxRows);

  /*
    ONE cutoff for the whole differential, taken from the resolved anchor rather
    than carried on every row: a per-row copy is a second source of truth for the
    same instant, and the two would eventually disagree.
  */
  const pitCutoff =
    scope.pitAnchor === null || scope.pitAnchor === undefined
      ? null
      : Date.parse(scope.pitAnchor.cutoff);

  for (const row of adDays) {
    /*
      BOTH clocks, matching the job's own admissibility predicate
      (created_at <= cutoff AND updated_at <= cutoff). Taking the later of the
      two is the instant at which the row became fully visible, so a row
      created before the cutoff but restated after it is correctly restated
      rather than credited as evidence the run had.
    */
    const createdAt = instant(row.row_created_at);
    const updatedAt = instant(row.row_updated_at);
    const rowProvenance =
      createdAt === null || updatedAt === null
        ? null
        : Math.max(createdAt, updatedAt);

    /*
      A fact read from a joined table is only visible once BOTH it and the
      ad-day row it hangs off are visible, and each table has more than one
      information clock: a config row carries captured_at (observation) and
      created_at (write), a state observation carries observed_at and
      captured_at. The instant the whole fact became usable is the latest of
      them, so provenance is a max over all of them and the ad-day row.
    */
    const provenanceWith = (...clocks: (number | null)[]): number | null => {
      const all = [rowProvenance, ...clocks];
      return all.some((clock) => clock === null)
        ? null
        : Math.max(...(all as number[]));
    };
    const actionsPresent = row.actions_present === true;

    const firstConsuming = instant(row.first_consuming_run_started_at);
    if (firstConsuming === null) noConsumingRunFound += 1;
    else if (rowProvenance !== null && rowProvenance <= firstConsuming) {
      finalAtFirstConsumingRun += 1;
    } else restatedAfterFirstConsumingRun += 1;

    // Funnel. The payload is the input, so its provenance is the ad-day row.
    const repairedLpvState = text(row.repaired_lpv_state);
    classify(lpv, {
      baselineResolved: num(row.baseline_lpv) !== null,
      repairedResolved: repairedLpvState === "measured",
      baselineValue: num(row.baseline_lpv),
      repairedValue: num(row.repaired_lpv),
      repairedProvenance: rowProvenance,
      pitCutoff,
      /*
        The funnel is read out of meta_ad_daily.payload_json, which retains the
        provider's insights row verbatim — its 18 top-level keys match the raw
        ad_insights_bulk element keys exactly — so a resolved stage is traceable
        to the retained payload.
      */
      auditability: "exact_observation",
      missingControl: actionsPresent ? null : "actions_array_absent",
    });

    /*
      Link clicks. THREE things, and conflating any two of them produces a
      number that overstates the shipped repair.

      Baseline is the stored column taken at face value, which is what the
      pre-repair reader did. Repaired is what TODAY's production reader
      resolves: D095 says a stored zero is a measurement only when that row's
      own actions corroborate it (no link_click entry, or one exact zero entry),
      and a positive stored value is unaffected by the old NOT NULL DEFAULT 0
      fabrication and stays a measurement. So the shipped effect of the repair
      in this dimension is mostly a WITHDRAWAL of uncorroborated legacy zeros,
      not a gain.

      The gain from the raw payload is real but NOT YET REALIZED: the reader
      does not recover a positive count from `actions` when the column is null;
      only the bounded DB backfill will. Counting it here would report work that
      has not happened, so it goes in its own `backfillPotential` block.
    */
    const entries = Array.isArray(row.raw_link_click_entries)
      ? (row.raw_link_click_entries as { action_type?: unknown; value?: unknown }[])
      : [];
    const parsed = parseMetaLinkClicksFromActions(entries);
    const storedLinkClicks = num(row.baseline_link_clicks);
    const readerLinkClicks = num(row.reader_link_clicks);
    classify(linkClicks, {
      baselineResolved: storedLinkClicks !== null,
      repairedResolved: readerLinkClicks !== null,
      baselineValue: storedLinkClicks,
      repairedValue: readerLinkClicks,
      repairedProvenance: rowProvenance,
      pitCutoff,
      /*
        D095 corroborates a stored zero from the row's own actions array, which
        is raw. A stored POSITIVE is accepted on the column alone, so when the
        payload carries no actions there is nothing raw behind it.
      */
      auditability: actionsPresent ? "exact_observation" : "persisted_input",
      missingControl:
        readerLinkClicks !== null
          ? null
          : storedLinkClicks === null
            ? actionsPresent
              ? "link_clicks_column_null_actions_retained"
              : "link_clicks_column_null_actions_absent"
            : storedLinkClicks === 0
              ? actionsPresent
                ? "legacy_zero_uncorroborated_by_retained_actions"
                : "legacy_zero_no_actions_array"
              : "stored_positive_not_resolved_by_reader",
    });

    // Backfill potential, via the backfill's own contract.
    const repairAction = classifyAdDayLinkClick({
      storedLinkClicks: storedLinkClicks,
      actionsPresent,
      linkClickValues: entries.map((entry) => entry?.value),
    }).action;
    backfill.byAction[repairAction] += 1;
    if (isWritingAction(repairAction)) {
      backfill.wouldWrite += 1;
      if (pitCutoff !== null && rowProvenance !== null && rowProvenance <= pitCutoff) {
        backfill.wouldWriteAndExactPit += 1;
      }
    }
    if (requiresProviderResync(repairAction)) backfill.requiresProviderResync += 1;

    /*
      The old reader took a config-history value with no field provenance. The
      repaired value below is produced by the same receipt/witness SQL contract
      as native calibration and hydration, evaluated at the selected run cutoff.
      A present value with review_only readiness is evidence for a recommendation,
      not execution authority; no replay result changes that separation.
    */
    const baselineObjective = text(row.baseline_objective);
    const sourceTier = text(row.objective_source_tier);
    const sourceClass = text(row.objective_source_class);
    const sourceReadiness = text(row.objective_source_readiness);
    const sourcePitClass = text(row.objective_source_pit_class);
    const repairedObjective = pitCutoff === null
      ? null
      : text(row.objective_source_value);
    if (
      repairedObjective !== null &&
      (sourcePitClass !== "as_of_known" ||
        !["decision_authority", "review_only"].includes(sourceReadiness ?? "") ||
        sourceClass === null ||
        sourceClass === "none")
    ) {
      throw new Error(
        `Objective source contract returned an inadmissible value for ${String(row.provider_account_id)}/${String(row.campaign_id)}/${String(row.date)}.`,
      );
    }
    const typedWitnessObjective = text(row.typed_witness_objective);
    const asofObjective = text(row.asof_objective);
    const asofObjectiveSourceKind = text(row.asof_objective_source_kind);
    classify(objective, {
      baselineResolved: baselineObjective !== null,
      repairedResolved: repairedObjective !== null,
      baselineValue: baselineObjective,
      repairedValue: repairedObjective,
      // The contract refuses evidence arriving after the cutoff. The ad-day
      // metrics must also have existed then for this row to be admissible.
      repairedProvenance: rowProvenance,
      pitCutoff,
      auditability: sourceClass === "typed_unlinked"
        ? "persisted_input"
        : "exact_observation",
      missingControl:
        repairedObjective !== null
          ? null
          : sourceTier === "observed_absent"
            ? "objective_provider_observed_absent"
            : pitCutoff === null
              ? "objective_no_successful_run_anchor"
              : typedWitnessObjective !== null
                ? "objective_typed_witness_not_admitted_at_cutoff"
                : asofObjective !== null &&
                    asofObjectiveSourceKind !== CONFIG_RECEIPT_SOURCE_KIND
                  ? `objective_derived_history_unverified_${asofObjectiveSourceKind ?? "unknown"}`
                  : "objective_no_admissible_field_source",
    });
    if (repairedObjective !== null && sourceClass === "typed_unlinked") {
      objective.typedContemporaneousResolved += 1;
    }
    const readiness = repairedObjective !== null &&
      (sourceReadiness === "decision_authority" || sourceReadiness === "review_only")
      ? sourceReadiness
      : "none";
    objectiveSourceReadiness[readiness] += 1;

    // Creative. Absence evidence resolves nothing, by contract.
    const presence = text(row.repaired_creative_presence);
    const hasCoverage = row.repaired_creative_has_coverage === true;
    const repairedCreative =
      presence === "present" && hasCoverage ? text(row.repaired_creative_id) : null;
    classify(creative, {
      baselineResolved: text(row.baseline_creative_id) !== null,
      repairedResolved: repairedCreative !== null,
      baselineValue: text(row.baseline_creative_id),
      repairedValue: repairedCreative,
      repairedProvenance: provenanceWith(
        instant(row.repaired_creative_observed_at),
        instant(row.repaired_creative_captured_at),
      ),
      pitCutoff,
      /*
        CORRECTION. This was briefly classified as having no reachable receipt,
        on the grounds that meta_entity_state_history has no source_snapshot_id
        column. It does not — but the lineage exists one hop further out, through
        run_id -> meta_entity_observation_runs.source_snapshot_id ->
        meta_raw_snapshots, and it resolves: on a live sample every one of 1,207
        ad state rows reached an existing ad_configs snapshot (115,699 runs,
        all carrying a snapshot id).

        So the value is auditable, but bitemporal rather than same-day: this
        table's observed_at is the PROVIDER's own updated_time, not our sighting,
        and 97% of rows are observed more than a day before they are captured.
        That is why the timeliness axis takes the max over observed_at AND
        captured_at — the captured clock is the one that says when a run could
        have read the row.
      */
      auditability: "bitemporal_observation",
      missingControl:
        presence === null
          ? "no_state_observation"
          : repairedCreative === null
            ? "absence_evidence_only"
            : null,
    });
  }

  // Decision semantics: the production pure transforms over persisted held rows.
  const baseline: Record<string, number> = {};
  const repaired: Record<string, number> = {};
  let authorizedActionNonNullBefore = 0;
  let providerMutationOfferedAfter = 0;
  let decisionStateNotBlockedAfter = 0;
  const heldRowsByEngineVersion: Record<string, number> = {};

  for (const row of heldInScope) {
    const held = text(row.blocked_action_type);
    const epoch = text(row.engine_version) ?? "unknown";
    heldRowsByEngineVersion[epoch] = (heldRowsByEngineVersion[epoch] ?? 0) + 1;
    if (text(row.authorized_action) !== null) authorizedActionNonNullBefore += 1;

    // Pre-repair: every campaign_context hold served one sentence and one lane.
    const baselineKey = `held=${held} lane=blocked code=resolve_campaign_role`;
    baseline[baselineKey] = (baseline[baselineKey] ?? 0) + 1;

    const classification = projectMetaDecisionSemantics({
      sourceLabel: text(row.label),
      legacyBuyerAction: text(row.label),
      badgeCodes: ["campaign_context_unresolved"],
      blockerCodes: ["campaign_context"],
      heldAction: held,
      authorityBlocker: text(row.authority_blocker),
      lifecycleRole: null,
    } as never);
    const action = adAction(
      {
        classification: { ...classification, lifecycleRole: { value: null } },
        parentChain: { ad: { id: "ad" } },
        sourceAuthority: null,
      } as never,
      { scale: false, cut: false, refresh: false } as never,
    );
    const repairedKey = `held=${held} lane=${action.lane} code=${action.action.code}`;
    repaired[repairedKey] = (repaired[repairedKey] ?? 0) + 1;

    if (action.action.providerMutation !== null) providerMutationOfferedAfter += 1;
    if (classification.decisionState !== "blocked") decisionStateNotBlockedAfter += 1;
  }

  return {
    mode: "read_only_differential_replay",
    scope: {
      businessId: scope.businessId,
      startDate: scope.startDate,
      endDate: scope.endDate,
    },
    bounds,
    claim: {
      provesIntegratedNativeJob: false,
      provesPointInTimeValidity: "only_for_rows_admissible_at_cutoff",
      resolverChanged: false,
      readerSemanticsDeployed: false,
      evidenceLanes: {
        readerDimensions: "current_tree_readers_over_retained_rows",
        decisionSemantics:
          "current_tree_pure_transforms_over_persisted_held_rows_with_fixed_context",
        decisionsRecomputed: false,
        integratedPersistedJob: false,
        providerMutation: "none_no_provider_client_in_this_runner",
        databaseWrites: "none_read_only_transaction",
      },
      consistentSnapshot: scope.snapshot != null,
    },
    snapshot: scope.snapshot ?? null,
    pitAnchor: scope.pitAnchor ?? null,
    adDaysExamined: adDays.length,
    truncatedByMaxRows,
    truncation,
    payloadSettling: {
      finalAtFirstConsumingRun,
      restatedAfterFirstConsumingRun,
      noConsumingRunFound,
    },
    dimensions: [lpv, linkClicks, objective, creative],
    objectiveSourceReadiness,
    backfillPotential: { linkClicks: backfill },
    decisionSemantics: {
      heldRowsExamined: heldInScope.length,
      heldRowsByEngineVersion,
      baseline,
      repaired,
      authorityUnchanged: {
        authorizedActionNonNullBefore,
        providerMutationOfferedAfter,
        decisionStateNotBlockedAfter,
      },
    },
  };
}

/**
 * Refuses to run in a session that is not already read-only.
 *
 * The guarantee belongs at the session, not in this file's good intentions: a
 * read-only transaction default makes every statement here incapable of writing
 * whatever a future edit does. The file also contains no DML, which its test
 * asserts separately.
 */
export async function assertSessionIsReadOnly(
  query: (text: string) => Promise<Row[]>,
): Promise<void> {
  const rows = await query("SHOW default_transaction_read_only");
  const value = String(
    rows[0]?.default_transaction_read_only ?? rows[0]?.DEFAULT_TRANSACTION_READ_ONLY ?? "",
  ).toLowerCase();
  if (value !== "on") {
    throw new DifferentialReplayUsageError(
      'this replay runs only in a read-only session. Start it with PGOPTIONS="-c default_transaction_read_only=on".',
    );
  }
}

/**
 * Every read of one differential, inside ONE pinned read-only snapshot.
 *
 * The caller must run this as the body of a fresh transaction. The anchor run,
 * the ad-days judged against it, the objective sources those ad-days resolve
 * and the persisted held decisions used to be read through the pool, one
 * autocommit snapshot each, while the sync jobs kept writing — so a coverage
 * check could pass or fail on rows that arrived between two statements, and
 * the receipt joined four different moments as if they were one.
 *
 * Usage problems are THROWN (as DifferentialReplayUsageError) rather than
 * ending the process from inside an open transaction.
 */
export async function executeDifferentialReplay(
  query: (text: string, values?: unknown[]) => Promise<Row[]>,
  args: ParsedArgs,
  log: (line: string) => void = () => {},
): Promise<DifferentialReplayReceipt> {
  const snapshot = await pinReadOnlySnapshot(query);

  /*
    Resolve the evaluation run FIRST. Its start is the only cutoff the ad-day
    query is allowed to classify against, and the receipt names it so a reader
    can check which historical run the differential is a statement about.
  */
  const anchorRows = await query(REPLAY_PIT_ANCHOR_SQL, [
    args.businessId,
    args.startDate,
    args.endDate,
    args.asOf,
  ]);
  const anchorRow = anchorRows[0];
  const pitAnchor =
    anchorRow === undefined
      ? null
      : {
          asOfDate: String(anchorRow.as_of_date),
          cutoff: new Date(anchorRow.pit_cutoff as string | number | Date).toISOString(),
        };
  if (pitAnchor === null) {
    log(
      args.asOf
        ? `No successful native run for as_of_date ${args.asOf}; every row will be restated.`
        : `No successful native run in ${args.startDate}..${args.endDate}; every row will be restated.`,
    );
  } else {
    /*
      The run reads a trailing window, so an ad-day older than that window was
      never in scope and cannot be judged against this run at all.
    */
    const windowStart = new Date(
      Date.parse(`${pitAnchor.asOfDate}T00:00:00Z`) -
        (REPLAY_ENGINE_WINDOW_DAYS - 1) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    if (args.startDate < windowStart) {
      throw new DifferentialReplayUsageError(
        `--startDate ${args.startDate} predates the ${REPLAY_ENGINE_WINDOW_DAYS}-day window of run ${pitAnchor.asOfDate} (starts ${windowStart}).`,
      );
    }
  }

  const replayValues = [
    args.businessId,
    args.startDate,
    args.endDate,
    args.maxRows,
    pitAnchor?.cutoff ?? null,
  ];
  const adDayRows = await query(REPLAY_AD_DAY_SQL, replayValues);
  const objectiveSourceRows = pitAnchor === null
    ? []
    : await query(REPLAY_OBJECTIVE_SOURCE_SQL, replayValues);
  const rowKey = (row: Row) => [
    row.provider_account_id,
    row.campaign_id,
    row.ad_id,
    row.date,
  ].map((part) => String(part ?? "")).join("\u0000");
  const objectiveSourceByKey = new Map<string, Row>();
  for (const row of objectiveSourceRows) {
    const key = rowKey(row);
    if (objectiveSourceByKey.has(key)) {
      throw new Error(`Duplicate objective source row for ${key}.`);
    }
    objectiveSourceByKey.set(key, row);
  }
  /*
    Both reads share the snapshot and the same total order and ceiling, so a
    mismatch here is a real defect in one of them — no longer a sync write
    that landed between two statements.
  */
  if (pitAnchor !== null && objectiveSourceByKey.size !== adDayRows.length) {
    throw new Error(
      `Objective source coverage mismatch: ${objectiveSourceByKey.size} source rows for ${adDayRows.length} ad-days.`,
    );
  }
  const joinedAdDayRows = adDayRows.map((row) => {
    const source = objectiveSourceByKey.get(rowKey(row));
    if (pitAnchor !== null && !source) {
      throw new Error(`Objective source missing for ${rowKey(row)}.`);
    }
    return { ...row, ...source };
  });
  const heldRows = await query(REPLAY_HELD_DECISION_SQL, [
    args.businessId,
    args.startDate,
    args.endDate,
    args.maxRows,
  ]);

  return buildDifferentialFromRows(
    joinedAdDayRows,
    heldRows,
    {
      businessId: args.businessId,
      startDate: args.startDate,
      endDate: args.endDate,
      pitAnchor,
      snapshot,
    },
    { maxRows: args.maxRows, queryTimeoutMs: args.queryTimeoutMs },
  );
}

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  let args: ParsedArgs;
  try {
    args = parseDifferentialReplayArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }
  if (!process.env.DB_QUERY_TIMEOUT_MS?.trim()) {
    process.env.DB_QUERY_TIMEOUT_MS = String(args.queryTimeoutMs);
  }

  const { getDb, runDbTransaction } = await import("@/lib/db");
  let receipt: DifferentialReplayReceipt;
  try {
    receipt = await runDbTransaction(
      () =>
        executeDifferentialReplay(
          async (text, values = []) => (await getDb().query(text, values)) as Row[],
          args,
          (line) => console.error(line),
        ),
      { timeoutMs: args.queryTimeoutMs },
    );
  } catch (error) {
    if (error instanceof DifferentialReplayUsageError || error instanceof ReadOnlySnapshotError) {
      console.error(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }

  const report = JSON.stringify(receipt, null, 2);
  if (args.write && args.outPath) writeFileSync(args.outPath, `${report}\n`, "utf8");
  console.log(report);
  console.error(
    [
      "",
      "READ-ONLY DIFFERENTIAL, one pinned REPEATABLE READ snapshot. Nothing was written to the",
      "database, no provider was contacted and no decision was regenerated.",
      "Reader dimensions: current-tree readers over retained rows. Decision semantics: current-tree",
      "pure transforms over PERSISTED held rows with runner-fixed context — not a recomputed decision.",
      "This does NOT prove the integrated native decision job. Only inputs admissible at the selected",
      "run cutoff could have been seen by that run; this alone does not establish provider provenance",
      "or full-day config validity. Restated rows are counterfactuals. Unresolved rows may have other",
      "retained sources.",
      receipt.truncatedByMaxRows
        ? `ROW CEILING REACHED at --maxRows ${args.maxRows}: adDays=${receipt.truncation.adDays} heldDecisions=${receipt.truncation.heldDecisions}.`
        : "Row ceiling not reached.",
      args.write && args.outPath ? `Receipt written to ${args.outPath}` : "No artifact written (pass --write 1 --out <path>).",
    ].join("\n"),
  );
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("native-ad-repair-differential-replay.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
