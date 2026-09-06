#!/usr/bin/env node
// Generalized point-in-time historical replay/backtest (2026-08-30).
//
// ONE bounded evidence phase: replay the CURRENT candidate decision engine and
// the CURRENT automatic campaign-context resolver across every materially
// different historical regime the retained six-business data supports, with
// explicit temporal integrity, and freeze the whole run into one hashed
// artifact. This runner deliberately reuses the production decision core —
// `decideCreative`, `resolveAccountDecisionProfile`, `WarehouseDataSource`,
// `stabilizeDecisionLabel`, the campaign-context resolver/job hysteresis, and
// `classifyCreativeDecisionOutcome` — it is NOT a second decision core.
//
// HARD RULE (label isolation): this module never reads either manual
// campaign-label table (current or history), never imports a
// manual-label reader, and its PRIMARY role inference is NAME-BLIND (campaign
// names nulled before feature building so name tokens cannot influence the
// inferred role). A production-parity secondary inference (names included,
// still zero manual labels) is computed only as a clearly labelled diagnostic
// of how much the compiled resolver leans on name tokens. No manual-label
// blind comparator is included at all (deliberately omitted).
//
// Temporal integrity: decision inputs at origin t0 come from the production
// as-of builders (`asOf = t0` throughout); targets resolve through the
// engine's own bitemporal `business_target_pack_history` read
// (effective_at <= t0 AND recorded_at <= t0); outcomes are evaluated strictly
// after t0 at horizons 1/3/7/14/28/60/90 where complete. Because
// `meta_creative_daily` rows are restated in place (updated_at long after the
// fact date), origins are explicitly partitioned into `pit_persisted`
// (engine-lifecycle rows computed near t0) versus `restated_retrospective`
// (runtime SQL over restated daily rows) — no silent lookahead claims.
//
// Phases:
//   extract  — ONE `REPEATABLE READ READ ONLY` production transaction through
//              the established read-only observation path; SELECT-only; then
//              offline pure analysis; writes the frozen artifact.
//   verify   — offline: recompute every derived section from the frozen
//              inputs in the artifact and require identical result hashes.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_CONTEXT_CONFIG,
  CAMPAIGN_CONTEXT_RESOLVER_VERSION,
  campaignFamilyKey,
  classifyCampaignContext,
  computeFamilyInheritance,
  type CampaignKind,
  type ContextConfidenceClass,
  type ContextResolution,
} from "@/lib/creative-decision-engine/campaign-context/resolver";
import {
  buildCampaignContextFeatures,
  computeCampaignLineage,
  addDaysUtc,
  diffDaysUtc,
  type CreativeDayRow,
  type CampaignMetaRow,
} from "@/lib/creative-decision-engine/campaign-context/data";
import {
  applyDailyHysteresis,
  type HysteresisState,
} from "@/lib/creative-decision-engine/jobs/campaign-context-job";
import type {
  CreativeCampaignContextEntry,
  CreativeCampaignLabelMap,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import {
  classifyCreativeDecisionOutcome,
  CREATIVE_OUTCOME_CLASSIFIER_VERSION,
} from "@/lib/creative-decision-engine/outcome-classifier";
import type { DecisionLabel } from "@/lib/creative-decision-engine/types";

export const PIT_REPLAY_CONTRACT_VERSION =
  "adsecute.meta.generalized-pit-replay.v3";

export const PIT_REPLAY_HORIZONS_DAYS = [1, 3, 7, 14, 28, 60, 90] as const;
export type PitHorizonDays = (typeof PIT_REPLAY_HORIZONS_DAYS)[number];

// Charter scope (identity is the business id; names verified against the DB,
// never trusted as identity). The seven account assignments are DISCOVERED
// from the database at extract time and cross-checked against this pin; a
// mismatch aborts the extraction.
export const PIT_REPLAY_BUSINESSES = [
  { name: "IwaStore", businessId: "f8a3b5ac-588c-462f-8702-11cd24ff3cd2" },
  { name: "Grandmix", businessId: "5dbc7147-f051-4681-a4d6-20617170074f" },
  { name: "Bilsem Zeka", businessId: "6c690fa4-6395-40b5-9755-e99b34d69bc3" },
  { name: "TheSwaf", businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3" },
  { name: "IwaTR", businessId: "b79683b4-6f87-48c0-a3ca-44d4356fef51" },
  { name: "ColorFullWorldsTR", businessId: "bc0c6178-7853-4f6f-b026-ef0222a4b9e7" },
] as const;

export const PIT_REPLAY_JSON_OUT =
  "docs/audits/generated/generalized-pit-replay-evidence-2026-08-30.json";

// Feature window the production context job uses (56d source window feeding
// the 28d feature window; identical constants).
const ROLE_SOURCE_WINDOW_DAYS = 56;
// Production freshness bound on consumed context (source.ts).
const ROLE_MAX_AGE_DAYS = 2;
// Decision-layer origin cadence: every supported day is the POPULATION; the
// SAMPLE is a deterministic biweekly Monday grid plus the final supported
// origin plus three consecutive-day pairs (for exact day-over-day flip
// measurement) at fixed quantiles. Full daily enumeration of the decision
// layer would be thousands of production as-of hydrations; the ROLE layer IS
// enumerated at full daily grain offline.
const DECISION_ORIGIN_STEP_DAYS = 14;
const CONSECUTIVE_PAIR_QUANTILES = [0.2, 0.5, 0.8] as const;

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Small deterministic helpers (exported for the focused tests)
// ---------------------------------------------------------------------------

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function toText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value === null || value === undefined) return null;
  return String(value);
}

function toNum(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toNumOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = toNum(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dayOf(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return toText(value)?.slice(0, 10) ?? null;
}

export function isIsoDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

// ---------------------------------------------------------------------------
// Frozen compact row shapes
// ---------------------------------------------------------------------------

/** Columnar creative-day tuple (contract v2 — COMPOSITE identity):
 * [businessId, accountId, campaignId, adsetId|null, creativeId, date, spend,
 *  conversions, revenue, firstSpendDate, restatedAfterDays|null].
 * `restatedAfterDays` is restatement METADATA (update-time lag past the fact
 * date); it never reconstructs an overwritten historical value and never
 * enters any decision, role, or outcome computation. */
export type CreativeDayTuple = [
  string, string, string, string | null, string, string, number, number,
  number, string, number | null,
];
export const TUPLE = {
  businessId: 0,
  accountId: 1,
  campaignId: 2,
  adsetId: 3,
  creativeId: 4,
  date: 5,
  spend: 6,
  conversions: 7,
  revenue: 8,
  firstSpendDate: 9,
  restatedAfterDays: 10,
} as const;

export interface PitTargetHistoryRow {
  businessId: string;
  id?: string | null;
  operation: "upsert" | "delete";
  effectiveAt: string;
  recordedAt: string;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
  breakEvenCpa: number | null;
  defaultRiskPosture: string;
}

export interface CampaignNamePoint {
  businessId: string;
  accountId: string;
  campaignId: string;
  date: string;
  campaignName: string | null;
}

export interface CampaignFirstSeenRow {
  businessId: string;
  accountId: string;
  campaignId: string;
  firstSeenDate: string;
}

// ---------------------------------------------------------------------------
// PIT filters + target selection (pure; leakage-tested)
// ---------------------------------------------------------------------------

/**
 * Composite (business, provider-account) grouping of the frozen tuples, each
 * bucket in FROZEN ARRAY ORDER. Same narrowing-only contract as
 * `CreativeDayTupleIndex` below: it is decided by exactly the fields
 * `creativeRowsUpTo`'s own identity guard tests, that guard still runs on
 * every visited tuple, and a single forward fill preserves the frozen order,
 * so the returned row array is element-for-element what the full scan
 * produced. (`roleTimelinesPrimaryNameBlind` re-derives to the frozen
 * artifact's hash, which asserts exactly that on real data.)
 */
type AccountTupleIndex = Map<string, CreativeDayTuple[]>;

/** Shared empty candidate set for a key the index has never seen. */
const NO_TUPLES: readonly CreativeDayTuple[] = [];

const accountTupleKey = (businessId: string, accountId: string) =>
  `${businessId}\u0000${accountId}`;

function buildAccountTupleIndex(
  tuples: readonly CreativeDayTuple[],
): AccountTupleIndex {
  const index: AccountTupleIndex = new Map();
  for (const t of tuples) {
    const key = accountTupleKey(t[0], t[1]);
    const bucket = index.get(key);
    if (bucket) bucket.push(t);
    else index.set(key, [t]);
  }
  return index;
}

/** Only rows whose FACT date is <= t0 (the replay's decision boundary),
 * scoped by the COMPOSITE (business, provider-account) identity.
 *
 * `index` is an optional pre-built grouping of the SAME `tuples` (see
 * `buildAccountTupleIndex`); it only narrows the candidate set this scan
 * walks. Omit it and the function behaves exactly as it always has. */
export function creativeRowsUpTo(
  tuples: readonly CreativeDayTuple[],
  businessId: string,
  accountId: string,
  t0: string,
  index?: AccountTupleIndex,
): CreativeDayRow[] {
  const windowStart = addDaysUtc(t0, -(ROLE_SOURCE_WINDOW_DAYS - 1));
  const rows: CreativeDayRow[] = [];
  const candidates = index
    ? (index.get(accountTupleKey(businessId, accountId)) ?? NO_TUPLES)
    : tuples;
  for (const t of candidates) {
    if (t[0] !== businessId || t[1] !== accountId) continue;
    const date = t[5];
    if (date > t0 || date < windowStart) continue;
    // PIT first-spend: the frozen firstSpendDate is min(date) over the
    // composite (business, account, creative) history; a first spend after
    // t0 cannot occur for a row dated <= t0, and min(date<=t0) === frozen
    // min whenever the row itself is <= t0 (min <= this row's date).
    rows.push({
      providerAccountId: t[1],
      campaignId: t[2],
      adsetId: t[3],
      creativeId: t[4],
      date,
      spend: t[6],
      firstSpendDate: t[9],
    });
  }
  return rows;
}

/** First qualifying relaunch date per composite creative: the RESUMPTION
 * date of the first >=14-day zero-spend gap in the fact timeline. A decision
 * row is a relaunch scenario ONLY when that date is at or before its origin
 * — evaluated strictly as of t0, never from lifetime knowledge. */
export const RELAUNCH_GAP_DAYS = 14;
export function firstRelaunchDates(
  tuples: readonly CreativeDayTuple[],
): Map<string, string> {
  const datesByCreative = new Map<string, string[]>();
  for (const t of tuples) {
    const key = `${t[0]}\u0000${t[1]}\u0000${t[4]}`;
    const list = datesByCreative.get(key);
    if (list) list.push(t[5]);
    else datesByCreative.set(key, [t[5]]);
  }
  const first = new Map<string, string>();
  for (const [key, dates] of datesByCreative) {
    const uniqueSorted = [...new Set(dates)].sort();
    for (let index = 1; index < uniqueSorted.length; index += 1) {
      if (diffDaysUtc(uniqueSorted[index], uniqueSorted[index - 1]) >= RELAUNCH_GAP_DAYS) {
        first.set(key, uniqueSorted[index]);
        break;
      }
    }
  }
  return first;
}

/** Latest name change-point at or before t0 per campaign (PIT names). */
export function campaignMetaAsOf(input: {
  namePoints: readonly CampaignNamePoint[];
  firstSeen: readonly CampaignFirstSeenRow[];
  businessId: string;
  accountId: string;
  t0: string;
  nameBlind: boolean;
}): Map<string, CampaignMetaRow> {
  const latestPoint = new Map<string, CampaignNamePoint>();
  for (const point of input.namePoints) {
    if (
      point.businessId !== input.businessId ||
      point.accountId !== input.accountId ||
      point.date > input.t0
    )
      continue;
    const current = latestPoint.get(point.campaignId);
    if (!current || current.date <= point.date) {
      latestPoint.set(point.campaignId, point);
    }
  }
  const meta = new Map<string, CampaignMetaRow>();
  for (const [campaignId, point] of latestPoint) {
    meta.set(campaignId, {
      providerAccountId: point.accountId,
      campaignId,
      campaignName: input.nameBlind ? null : point.campaignName,
      firstSeenDate: null,
    });
  }
  for (const row of input.firstSeen) {
    if (row.businessId !== input.businessId || row.accountId !== input.accountId) continue;
    const entry = meta.get(row.campaignId);
    // PIT rule: a first-seen after t0 is unknown at t0, never negative age.
    if (entry && row.firstSeenDate <= input.t0) {
      entry.firstSeenDate = row.firstSeenDate;
    }
  }
  return meta;
}

/** EXACT production reference instant for a date-only asOf: the engine's
 * `resolveTargetReferenceTime` maps `YYYY-MM-DD` to `T03:00:00.000Z` and the
 * target-history read compares effective_at/recorded_at against that exact
 * timestamp — NOT end-of-day. The mirror must match byte-for-byte. */
export function targetReferenceTimeUtc(asOfDate: string): string {
  return `${asOfDate}T03:00:00.000Z`;
}

/** Pure mirror of the engine's bitemporal target read
 * (READ_BUSINESS_TARGET_PACK_QUERY): the latest history row with
 * effective_at <= ref AND recorded_at <= ref at the production 03:00Z
 * reference instant, ordered effective_at DESC, recorded_at DESC, id DESC,
 * and only if that latest row is an upsert. */
export function targetPackAsOf(
  history: readonly PitTargetHistoryRow[],
  businessId: string,
  asOfDate: string,
): PitTargetHistoryRow | null {
  const cutoff = targetReferenceTimeUtc(asOfDate);
  const eligible = history
    .filter(
      (row) =>
        row.businessId === businessId &&
        row.effectiveAt <= cutoff &&
        row.recordedAt <= cutoff,
    )
    .sort((a, b) =>
      a.effectiveAt !== b.effectiveAt
        ? a.effectiveAt.localeCompare(b.effectiveAt)
        : a.recordedAt !== b.recordedAt
          ? a.recordedAt.localeCompare(b.recordedAt)
          : (a.id ?? "").localeCompare(b.id ?? ""),
    );
  const latest = eligible[eligible.length - 1] ?? null;
  if (!latest || latest.operation !== "upsert") return null;
  return latest;
}

/** Truth sources whose rows CLAIM the configured commercial target. Every
 * other source (account_baseline*, global_default, out-of-scope zeros) is a
 * fallback. A source-family string plus an equal value is NOT version proof
 * — see the two-layer verification below. */
export const TARGET_CLAIMING_TRUTH_SOURCES = [
  "commercial_truth",
  "commercial_truth_stale",
] as const;

/** Layer 1 — authoritative target-pack SELECTION/VERSION evidence: which
 * bitemporal history row was authoritative at the production 03:00Z
 * reference instant, and whether the evidence can prove that THIS version
 * was the one the engine consumed. Correction 2 froze no observed row
 * id/recordedAt per decision, so version consumption is
 * `source_version_unobservable` for every target-present origin and the
 * version-proven count is ZERO — never invented. */
export type TargetVersionConsumptionStatus =
  | "version_proven_exact"
  | "source_version_unobservable"
  | "no_versioned_target";

/** Layer 2 — per-decision effective-target CONSUMPTION over EVERY selected
 * decision row (never only target-claiming rows). Mixed served values are
 * NEVER called exact; the word "exact" is reserved for the (currently
 * unreachable) version-proven layer-1 status. */
export type TargetConsumptionClass =
  | "all_rows_value_singleton_matches_expected"
  | "mixed_sources_including_expected"
  | "mixed_target_sourced_values"
  | "target_sourced_wrong_value_only"
  | "fallback_only_no_target_claiming_rows"
  | "no_decision_rows"
  | "target_claiming_rows_without_versioned_target"
  | "no_versioned_target";

export function verifyTargetsAtOrigins(input: {
  targetHistory: readonly PitTargetHistoryRow[];
  rows: readonly ReplayDecisionRowCompact[];
}): {
  layer1SelectionVersion: {
    note: string;
    perOrigin: Array<{
      businessId: string;
      originDate: string;
      expectedRow: {
        id: string | null;
        effectiveAt: string;
        recordedAt: string;
        operation: string;
        targetRoas: number | null;
        breakEvenRoas: number | null;
      } | null;
      observedVersionProvenance: "not_frozen_in_evidence";
      versionConsumptionStatus: TargetVersionConsumptionStatus;
    }>;
    denominators: {
      originsChecked: number;
      versionProvenExact: number;
      sourceVersionUnobservable: number;
      noVersionedTarget: number;
    };
  };
  layer2Consumption: {
    note: string;
    perOrigin: Array<{
      businessId: string;
      originDate: string;
      expectedTargetRoas: number | null;
      rowCount: number;
      rowCountsByTruthSource: Record<string, number>;
      distinctValuesByTruthSource: Record<string, number[]>;
      allServedValues: number[];
      consumptionClass: TargetConsumptionClass;
    }>;
    denominators: {
      originsChecked: number;
      allRowsValueSingletonMatchesExpected: number;
      mixedSourcesIncludingExpected: number;
      mixedTargetSourcedValues: number;
      targetSourcedWrongValueOnly: number;
      fallbackOnlyNoTargetClaimingRows: number;
      noDecisionRows: number;
      targetClaimingRowsWithoutVersionedTarget: number;
      noVersionedTarget: number;
    };
  };
} {
  const claiming = new Set<string>(TARGET_CLAIMING_TRUTH_SOURCES);
  const byOrigin = new Map<string, ReplayDecisionRowCompact[]>();
  for (const row of input.rows) {
    const key = `${row.businessId}\u0000${row.originDate}`;
    const list = byOrigin.get(key);
    if (list) list.push(row);
    else byOrigin.set(key, [row]);
  }
  const layer1PerOrigin: ReturnType<typeof verifyTargetsAtOrigins>["layer1SelectionVersion"]["perOrigin"] = [];
  const layer2PerOrigin: ReturnType<typeof verifyTargetsAtOrigins>["layer2Consumption"]["perOrigin"] = [];
  for (const [key, rows] of [...byOrigin.entries()].sort()) {
    const [businessId, originDate] = key.split("\u0000");
    const expectedRow = targetPackAsOf(input.targetHistory, businessId, originDate);
    const expected = expectedRow?.targetRoas ?? null;

    // Layer 1: authoritative selection identity; consumption unprovable
    // because no observed row id/recordedAt was frozen per decision.
    layer1PerOrigin.push({
      businessId,
      originDate,
      expectedRow: expectedRow
        ? {
            id: expectedRow.id ?? null,
            effectiveAt: expectedRow.effectiveAt,
            recordedAt: expectedRow.recordedAt,
            operation: expectedRow.operation,
            targetRoas: expectedRow.targetRoas,
            breakEvenRoas: expectedRow.breakEvenRoas,
          }
        : null,
      observedVersionProvenance: "not_frozen_in_evidence",
      versionConsumptionStatus:
        expectedRow === null ? "no_versioned_target" : "source_version_unobservable",
    });

    // Layer 2: EVERY row counts. Distinct values and row counts by source.
    const rowCountsByTruthSource: Record<string, number> = {};
    const valuesByTruthSource = new Map<string, Set<number>>();
    const allServed = new Set<number>();
    for (const row of rows) {
      const source = row.truthSource ?? "no_truth_source_provenance";
      rowCountsByTruthSource[source] = (rowCountsByTruthSource[source] ?? 0) + 1;
      if (row.effectiveTargetRoas !== null) {
        allServed.add(row.effectiveTargetRoas);
        let set = valuesByTruthSource.get(source);
        if (!set) {
          set = new Set();
          valuesByTruthSource.set(source, set);
        }
        set.add(row.effectiveTargetRoas);
      }
    }
    const distinctValuesByTruthSource = Object.fromEntries(
      [...valuesByTruthSource.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([source, values]) => [source, [...values].sort((a, b) => a - b)]),
    );
    const allServedValues = [...allServed].sort((a, b) => a - b);
    const targetSourcedValues = [
      ...new Set(
        [...valuesByTruthSource.entries()]
          .filter(([source]) => claiming.has(source))
          .flatMap(([, values]) => [...values]),
      ),
    ].sort((a, b) => a - b);

    let consumptionClass: TargetConsumptionClass;
    if (expected === null) {
      consumptionClass =
        targetSourcedValues.length > 0
          ? "target_claiming_rows_without_versioned_target"
          : "no_versioned_target";
    } else if (rows.length === 0) {
      consumptionClass = "no_decision_rows";
    } else if (targetSourcedValues.length === 0) {
      consumptionClass = "fallback_only_no_target_claiming_rows";
    } else if (allServedValues.length === 1 && allServedValues[0] === expected) {
      // Strict: singleton across ALL served values from ALL rows.
      consumptionClass = "all_rows_value_singleton_matches_expected";
    } else if (
      targetSourcedValues.length === 1 &&
      targetSourcedValues[0] === expected
    ) {
      // Target-claiming rows agree with the expectation but OTHER rows
      // served different values (e.g. [0 fallback, expected target]) —
      // MIXED, never exact.
      consumptionClass = "mixed_sources_including_expected";
    } else if (targetSourcedValues.includes(expected)) {
      consumptionClass = "mixed_target_sourced_values";
    } else {
      consumptionClass = "target_sourced_wrong_value_only";
    }
    layer2PerOrigin.push({
      businessId,
      originDate,
      expectedTargetRoas: expected,
      rowCount: rows.length,
      rowCountsByTruthSource,
      distinctValuesByTruthSource,
      allServedValues,
      consumptionClass,
    });
  }
  const countL1 = (status: TargetVersionConsumptionStatus) =>
    layer1PerOrigin.filter((entry) => entry.versionConsumptionStatus === status).length;
  const countL2 = (cls: TargetConsumptionClass) =>
    layer2PerOrigin.filter((entry) => entry.consumptionClass === cls).length;
  return {
    layer1SelectionVersion: {
      note:
        "Authoritative bitemporal selection at the production 03:00Z instant. Observed per-decision row id/recordedAt was NOT frozen in this evidence, so version consumption is unobservable and the version-proven exact count is zero; a truth-source family string plus an equal value is not version proof.",
      perOrigin: layer1PerOrigin,
      denominators: {
        originsChecked: layer1PerOrigin.length,
        versionProvenExact: countL1("version_proven_exact"),
        sourceVersionUnobservable: countL1("source_version_unobservable"),
        noVersionedTarget: countL1("no_versioned_target"),
      },
    },
    layer2Consumption: {
      note:
        "Per-decision effective-target consumption over EVERY selected decision row. Mixed served values (e.g. [0 fallback, expected target]) are mixed — never exact.",
      perOrigin: layer2PerOrigin,
      denominators: {
        originsChecked: layer2PerOrigin.length,
        allRowsValueSingletonMatchesExpected: countL2(
          "all_rows_value_singleton_matches_expected",
        ),
        mixedSourcesIncludingExpected: countL2("mixed_sources_including_expected"),
        mixedTargetSourcedValues: countL2("mixed_target_sourced_values"),
        targetSourcedWrongValueOnly: countL2("target_sourced_wrong_value_only"),
        fallbackOnlyNoTargetClaimingRows: countL2(
          "fallback_only_no_target_claiming_rows",
        ),
        noDecisionRows: countL2("no_decision_rows"),
        targetClaimingRowsWithoutVersionedTarget: countL2(
          "target_claiming_rows_without_versioned_target",
        ),
        noVersionedTarget: countL2("no_versioned_target"),
      },
    },
  };
}

/** Strict per-origin temporal classification. The decision cutoff is the end
 * of the origin day UTC; EVERY contributing layer must be capture-proven at
 * or before it for the overall decision input to be PIT-safe. There is no
 * future allowance of any kind. A persisted lifecycle metric snapshot is a
 * SOURCE-LAYER characteristic and never implies overall PIT safety while the
 * role/context layer is rebuilt from restated daily facts or the hydration
 * path joins mutable tables. */
export function classifyOriginTemporal(input: {
  originDate: string;
  sourceMode: string;
  lifecycleComputedAt: string | null;
  roleLayerCaptureProven: boolean;
  metricLayerCaptureProven: boolean;
}): {
  decisionCutoffUtc: string;
  lifecycleSnapshotPersistedSameDay: boolean;
  overallClass: "pit_safe" | "restated_retrospective";
} {
  const decisionCutoffUtc = `${input.originDate}T23:59:59.999Z`;
  const computedAtIso =
    input.lifecycleComputedAt === null
      ? null
      : new Date(input.lifecycleComputedAt).toISOString();
  const lifecycleSnapshotPersistedSameDay =
    input.sourceMode === "lifecycle_same_day" &&
    computedAtIso !== null &&
    computedAtIso <= decisionCutoffUtc;
  return {
    decisionCutoffUtc,
    lifecycleSnapshotPersistedSameDay,
    overallClass:
      lifecycleSnapshotPersistedSameDay &&
      input.roleLayerCaptureProven &&
      input.metricLayerCaptureProven
        ? "pit_safe"
        : "restated_retrospective",
  };
}

/**
 * Composite (business, account, creative) grouping of the frozen creative-day
 * tuples, each bucket holding that key's tuples in FROZEN ARRAY ORDER.
 *
 * PERFORMANCE, not semantics. `outcomeAggregateFor` is a per-(decision,
 * horizon) question over ONE composite creative, and it answered it by
 * scanning the whole frozen tuple array — 89,433 tuples for every one of the
 * 108,556 (primary row x horizon) cells the analysis evaluates, about 9.7e9
 * tuple visits, which is where 225 of `analyzePitReplay`'s 226 seconds went.
 * The bucket a query needs is decided by exactly the three fields the scan's
 * own identity guard tests, so restricting the scan to that bucket cannot
 * change which tuples are summed.
 *
 * Two properties keep the indexed path BYTE-identical to the linear one, not
 * merely equal to rounding:
 *   1. Buckets are filled in a single forward pass, so a bucket preserves the
 *      frozen array's relative order and the floating-point ADDITION ORDER of
 *      the sum is unchanged. (`analysis` re-derives to the frozen artifact's
 *      hash, which is the assertion that proves this on real data.)
 *   2. The identity guard is still evaluated on every visited tuple, so the
 *      index can only ever narrow the candidate set, never widen it: were two
 *      distinct keys ever to collide into one bucket, the guard would reject
 *      the foreign tuples exactly as the full scan did.
 */
type CreativeDayTupleIndex = Map<string, CreativeDayTuple[]>;

const outcomeIndexKey = (
  businessId: string,
  providerAccountId: string,
  creativeId: string,
) => `${businessId}\u0000${providerAccountId}\u0000${creativeId}`;

function buildCreativeDayTupleIndex(
  tuples: readonly CreativeDayTuple[],
): CreativeDayTupleIndex {
  const index: CreativeDayTupleIndex = new Map();
  for (const t of tuples) {
    const key = outcomeIndexKey(t[0], t[1], t[4]);
    const bucket = index.get(key);
    if (bucket) bucket.push(t);
    else index.set(key, [t]);
  }
  return index;
}

/** Outcome aggregate strictly AFTER t0 (date > t0 AND date <= t0+h),
 * mirroring the established replay outcome SQL semantics.
 *
 * `index` is an optional pre-built grouping of the SAME `tuples` (see
 * `buildCreativeDayTupleIndex`); it only narrows the candidate set this scan
 * walks. Omit it and the function behaves exactly as it always has. */
export function outcomeAggregateFor(input: {
  tuples: readonly CreativeDayTuple[];
  index?: CreativeDayTupleIndex;
  businessId: string;
  providerAccountId: string;
  creativeId: string;
  t0: string;
  horizonDays: number;
}): {
  outcomeSpend: number;
  outcomePurchases: number;
  outcomeRevenue: number;
  outcomeRoas: number | null;
} {
  const end = addDaysUtc(input.t0, input.horizonDays);
  const candidates = input.index
    ? (input.index.get(
        outcomeIndexKey(
          input.businessId,
          input.providerAccountId,
          input.creativeId,
        ),
      ) ?? NO_TUPLES)
    : input.tuples;
  let spend = 0;
  let purchases = 0;
  let revenue = 0;
  for (const t of candidates) {
    if (
      t[0] !== input.businessId ||
      t[1] !== input.providerAccountId ||
      t[4] !== input.creativeId
    )
      continue;
    const date = t[5];
    if (date <= input.t0 || date > end) continue;
    spend += t[6];
    purchases += t[7];
    revenue += t[8];
  }
  return {
    outcomeSpend: spend,
    outcomePurchases: purchases,
    outcomeRevenue: revenue,
    outcomeRoas: spend > 0 ? revenue / spend : null,
  };
}

// ---------------------------------------------------------------------------
// Origin enumeration (deterministic; population + sample disclosed)
// ---------------------------------------------------------------------------

export interface OriginPlan {
  firstSupportedOrigin: string;
  lastSupportedOrigin: string;
  populationDays: number;
  sampledOrigins: string[];
  consecutivePairs: Array<[string, string]>;
  cadence: string;
}

export function enumerateDecisionOrigins(input: {
  firstDataDate: string;
  lastDataDate: string;
}): OriginPlan | null {
  const first = addDaysUtc(input.firstDataDate, 28);
  const last = input.lastDataDate;
  if (first > last) return null;
  const populationDays = diffDaysUtc(last, first) + 1;
  const sampled = new Set<string>();
  // First Monday at or after `first` (1970-01-05 was a Monday).
  let cursor = first;
  while (new Date(`${cursor}T00:00:00Z`).getUTCDay() !== 1) {
    cursor = addDaysUtc(cursor, 1);
  }
  for (; cursor <= last; cursor = addDaysUtc(cursor, DECISION_ORIGIN_STEP_DAYS)) {
    sampled.add(cursor);
  }
  sampled.add(first);
  sampled.add(last);
  const consecutivePairs: Array<[string, string]> = [];
  for (const quantile of CONSECUTIVE_PAIR_QUANTILES) {
    const offset = Math.floor((populationDays - 2) * quantile);
    const dayA = addDaysUtc(first, Math.max(0, offset));
    const dayB = addDaysUtc(dayA, 1);
    if (dayB <= last) {
      sampled.add(dayA);
      sampled.add(dayB);
      consecutivePairs.push([dayA, dayB]);
    }
  }
  return {
    firstSupportedOrigin: first,
    lastSupportedOrigin: last,
    populationDays,
    sampledOrigins: [...sampled].sort(),
    consecutivePairs,
    cadence: `population=every supported day (${populationDays}); sample=biweekly Mondays + first/last supported + ${consecutivePairs.length} consecutive-day pairs at quantiles ${CONSECUTIVE_PAIR_QUANTILES.join("/")}`,
  };
}

export function horizonSupport(input: {
  t0: string;
  lastDataDate: string;
}): Record<PitHorizonDays, boolean> {
  const support = {} as Record<PitHorizonDays, boolean>;
  for (const horizon of PIT_REPLAY_HORIZONS_DAYS) {
    support[horizon] = addDaysUtc(input.t0, horizon) <= input.lastDataDate;
  }
  return support;
}

// ---------------------------------------------------------------------------
// Automatic role inference — daily timeline through the REAL resolver + the
// REAL production hysteresis (job semantics), replayed from zero state.
// ---------------------------------------------------------------------------

export interface RoleDayState {
  date: string;
  publishedKind: CampaignKind | null;
  publishedClass: ContextConfidenceClass;
  rawKind: CampaignKind | null;
  rawClass: ContextConfidenceClass;
  suppressedFlip: boolean;
  kindBasis: "behavioral" | "family_inheritance";
}

export interface RoleTimeline {
  businessId: string;
  accountId: string;
  campaignId: string;
  /** Change-points only (state identical between points). */
  points: RoleDayState[];
  daysEvaluated: number;
  /** Contiguous runs of days the campaign was actually evaluated — recency
   * truth the change-point compaction would otherwise lose. */
  evaluatedRuns: Array<[string, string]>;
}

export function buildRoleTimelines(input: {
  tuples: readonly CreativeDayTuple[];
  namePoints: readonly CampaignNamePoint[];
  firstSeen: readonly CampaignFirstSeenRow[];
  businessId: string;
  accountId: string;
  days: readonly string[];
  nameBlind: boolean;
}): Map<string, RoleTimeline> {
  const timelines = new Map<string, RoleTimeline>();
  const hysteresis = new Map<string, HysteresisState>();
  const lastPublished = new Map<string, RoleDayState>();
  // Built ONCE for this account's whole day walk; the per-day row selection
  // below previously re-scanned every business's tuples for each of the ~545
  // days it evaluates. Narrowing only — the identity guard inside
  // `creativeRowsUpTo` still runs. @see `buildAccountTupleIndex`.
  const accountTupleIndex = buildAccountTupleIndex(input.tuples);
  for (const day of input.days) {
    const rows = creativeRowsUpTo(
      input.tuples,
      input.businessId,
      input.accountId,
      day,
      accountTupleIndex,
    );
    if (rows.length === 0) continue;
    const meta = campaignMetaAsOf({
      namePoints: input.namePoints,
      firstSeen: input.firstSeen,
      businessId: input.businessId,
      accountId: input.accountId,
      t0: day,
      nameBlind: input.nameBlind,
    });
    const lineage = computeCampaignLineage(rows);
    const features = buildCampaignContextFeatures({
      rows,
      meta,
      lineage,
      asOf: day,
    });
    const resolutions = new Map<string, ContextResolution>();
    for (const feature of features) {
      resolutions.set(
        feature.campaignId,
        classifyCampaignContext(feature, DEFAULT_CONTEXT_CONFIG),
      );
    }
    const inheritance = computeFamilyInheritance(
      [...resolutions.values()].map((resolution) => ({
        campaignId: resolution.campaignId,
        familyKey: campaignFamilyKey(resolution.campaignName),
        kind: resolution.kind,
        confidenceClass: resolution.confidenceClass,
      })),
    );
    const inheritedById = new Map(
      inheritance.map((outcome) => [outcome.campaignId, outcome]),
    );
    for (const feature of features) {
      const resolution = resolutions.get(feature.campaignId)!;
      const inherited = inheritedById.get(feature.campaignId) ?? null;
      const effectiveKind = inherited ? inherited.inheritedKind : resolution.kind;
      const effectiveClass: ContextConfidenceClass = inherited
        ? "medium"
        : resolution.confidenceClass;
      const outcome = applyDailyHysteresis(
        hysteresis.get(feature.campaignId) ?? null,
        effectiveKind,
        effectiveClass,
      );
      hysteresis.set(feature.campaignId, outcome.state);
      const state: RoleDayState = {
        date: day,
        publishedKind: outcome.publishedKind,
        publishedClass: outcome.publishedClass,
        rawKind: effectiveKind,
        rawClass: effectiveClass,
        suppressedFlip: outcome.suppressedFlip,
        kindBasis: inherited ? "family_inheritance" : "behavioral",
      };
      let timeline = timelines.get(feature.campaignId);
      if (!timeline) {
        timeline = {
          businessId: input.businessId,
          accountId: input.accountId,
          campaignId: feature.campaignId,
          points: [],
          daysEvaluated: 0,
          evaluatedRuns: [],
        };
        timelines.set(feature.campaignId, timeline);
      }
      timeline.daysEvaluated += 1;
      const lastRun = timeline.evaluatedRuns[timeline.evaluatedRuns.length - 1];
      if (lastRun && addDaysUtc(lastRun[1], 1) === day) {
        lastRun[1] = day;
      } else if (!lastRun || lastRun[1] < day) {
        timeline.evaluatedRuns.push([day, day]);
      }
      const previous = lastPublished.get(feature.campaignId);
      if (
        !previous ||
        previous.publishedKind !== state.publishedKind ||
        previous.publishedClass !== state.publishedClass ||
        previous.kindBasis !== state.kindBasis
      ) {
        timeline.points.push(state);
      }
      lastPublished.set(feature.campaignId, state);
    }
  }
  return timelines;
}

/** Last day the campaign was actually EVALUATED at or before t0 (from the
 * timeline's contiguous evaluated-day runs). */
export function lastEvaluatedDayAtOrBefore(
  timeline: RoleTimeline,
  t0: string,
): string | null {
  let last: string | null = null;
  for (const [start, end] of timeline.evaluatedRuns) {
    if (start > t0) break;
    last = end <= t0 ? end : t0;
  }
  return last;
}

/** Published role state at t0, freshness-bounded like production
 * (`CAMPAIGN_CONTEXT_MAX_AGE_DAYS`): served ONLY when the campaign was
 * actually evaluated within the age bound of t0. An unevaluated stale role
 * FAILS CLOSED to null (unresolved) — an unchanged-but-daily-recomputed
 * state stays served because its evaluated-run recency is fresh even though
 * its change-point date is old. */
export function roleStateAt(
  timeline: RoleTimeline | undefined,
  t0: string,
): RoleDayState | null {
  if (!timeline) return null;
  const lastEvaluated = lastEvaluatedDayAtOrBefore(timeline, t0);
  if (lastEvaluated === null || diffDaysUtc(t0, lastEvaluated) > ROLE_MAX_AGE_DAYS) {
    return null;
  }
  let winner: RoleDayState | null = null;
  for (const point of timeline.points) {
    if (point.date <= lastEvaluated) winner = point;
    else break;
  }
  return winner;
}

/** Trust mapping mirror of `readCampaignContextMap` (authority env unset =>
 * high demotes to medium; kind null => unknown/conflict). */
export function contextEntryFromRoleState(
  state: Pick<RoleDayState, "publishedKind" | "publishedClass"> | null,
): CreativeCampaignContextEntry {
  if (!state) {
    return {
      kind: null,
      testDimension: null,
      contextTrust: "unknown",
      inferenceConfidenceClass: "unknown",
      resolverAuthorityValidated: false,
    };
  }
  const confidenceClass = state.publishedClass;
  const trust =
    state.publishedKind === null
      ? confidenceClass === "conflict"
        ? ("conflict" as const)
        : ("unknown" as const)
      : confidenceClass === "high"
        ? ("medium" as const) // authority env unset: high demotes to medium
        : confidenceClass === "medium"
          ? ("medium" as const)
          : confidenceClass === "conflict"
            ? ("conflict" as const)
            : ("low" as const);
  return {
    kind: state.publishedKind,
    testDimension: null,
    contextTrust: trust,
    inferenceConfidenceClass: confidenceClass,
    resolverAuthorityValidated: false,
  };
}

// ---------------------------------------------------------------------------
// Operational-recovery pure model (LOCAL model only — never production)
// ---------------------------------------------------------------------------

export interface FenceScenarioResult {
  scenario: string;
  admitted: boolean;
  metric: "raw" | "effective";
  detail: string;
}

/** Deterministic model of the D077 fence semantics: admission refuses at
 * bytes >= budget; the effective metric subtracts ONLY proven reusable free
 * space and falls back to raw when proof is unavailable. Frozen production
 * constants; removable rows remain UNKNOWN pending the operator planner, so
 * reclaim scenarios are parameterized, clearly-labelled hypotheticals. */
export function simulateFenceRecovery(input: {
  rawBytes: number;
  budgetBytes: number;
  freeSpaceProofAvailable: boolean;
  provenReusableFreeBytes: number | null;
}): FenceScenarioResult[] {
  const overage = input.rawBytes - input.budgetBytes;
  const results: FenceScenarioResult[] = [];
  results.push({
    scenario: "current_state_raw_metric",
    admitted: input.rawBytes < input.budgetBytes,
    metric: "raw",
    detail: `raw ${input.rawBytes} vs budget ${input.budgetBytes} (over by ${overage})`,
  });
  if (!input.freeSpaceProofAvailable || input.provenReusableFreeBytes === null) {
    results.push({
      scenario: "effective_metric_without_proof",
      admitted: input.rawBytes < input.budgetBytes,
      metric: "raw",
      detail:
        "pgstattuple proof unavailable → effective metric falls back to RAW (fail-closed); admission unchanged",
    });
    return results;
  }
  const effective = input.rawBytes - Math.max(0, input.provenReusableFreeBytes);
  results.push({
    scenario: "effective_metric_with_proof",
    admitted: effective < input.budgetBytes,
    metric: "effective",
    detail: `effective ${effective} = raw − proven free ${input.provenReusableFreeBytes}; admits iff proven free > ${overage}`,
  });
  return results;
}

// ---------------------------------------------------------------------------
// Decision-row compaction + volatile-free hashing
// ---------------------------------------------------------------------------

export interface ReplayDecisionRowCompact {
  businessId: string;
  originDate: string;
  freshnessMode: "historical" | "wall_clock_stale";
  creativeId: string;
  campaignId: string | null;
  providerAccountId: string | null;
  label: DecisionLabel;
  rawLabel: DecisionLabel;
  preAuthorityLabel: DecisionLabel | null;
  authorityBlocker: string | null;
  blockedActionType: string | null;
  confidence: number;
  campaignKind: string | null;
  campaignRoleStatus: string | null;
  contextTrust: string | null;
  truthSource: string | null;
  effectiveTargetRoas: number | null;
  ratioToTarget: number | null;
  spend: number;
  purchases: number;
  roas: number | null;
  recent7dSpend: number | null;
  ageDays: number | null;
  effectiveStatus: string | null;
  dataFreshnessHours: number | null;
  badges: string[];
  inputHash: string;
}

/** Hash basis excludes every wall-clock volatile (generatedAt/computedAt). */
export function decisionResultHash(rows: readonly ReplayDecisionRowCompact[]): string {
  return sha256Canonical(
    rows.map((row) => [
      row.businessId,
      row.originDate,
      row.freshnessMode,
      row.creativeId,
      row.label,
      row.rawLabel,
      row.preAuthorityLabel,
      row.authorityBlocker,
      row.blockedActionType,
      Math.round(row.confidence),
      row.campaignKind,
      row.campaignRoleStatus,
      row.effectiveTargetRoas,
      row.ratioToTarget,
      row.inputHash,
    ]),
  );
}

// ---------------------------------------------------------------------------
// Offline aggregate analysis (pure; recomputed byte-identically by `verify`)
// ---------------------------------------------------------------------------

export interface PitReplayFrozenInputs {
  scope: {
    businesses: Array<{
      businessId: string;
      name: string;
      currency: string | null;
      timezone: string | null;
      engineEnabled: boolean;
    }>;
    accounts: Array<{
      businessId: string;
      providerAccountId: string;
      isSelected: boolean;
      accountCurrency: string | null;
      accountTimezone: string | null;
    }>;
  };
  targetHistory: PitTargetHistoryRow[];
  creativeDayTuples: CreativeDayTuple[];
  campaignNamePoints: CampaignNamePoint[];
  campaignFirstSeen: CampaignFirstSeenRow[];
  coverage: Array<{
    businessId: string;
    providerAccountId: string;
    isSelected: boolean;
    rowCount: number;
    minDate: string;
    maxDate: string;
    restatedRowCount: number;
  }>;
  originPlans: Record<string, OriginPlan | null>;
  perOriginDecisions: ReplayDecisionRowCompact[];
  perOriginMeta: Array<{
    businessId: string;
    originDate: string;
    decisionCutoffUtc: string;
    sourceMode: string;
    lifecycleComputedAt: string | null;
    inputCount: number;
    profilePreset: string;
    hardActionEligibility: unknown;
    thresholds: {
      commercialMaturitySpend: number | null;
      hardCutSpend: number | null;
      scaleMinPurchases: number | null;
    };
    determinismHashFirst: string;
    determinismHashSecond: string;
  }>;
}

/** Attribution-maturity embargo: `meta_creative_daily.conversions` is
 * Meta-attributed with a standard maximum 7-day click window and the frozen
 * per-row restatement evidence shows daily facts keep being rewritten after
 * the fact date. An outcome window is attribution-MATURE only when it ends
 * at least EMBARGO days before the last retained data day; immature windows
 * are excluded from every action-quality proxy. */
export const ATTRIBUTION_EMBARGO_DAYS = 7;
export function isOutcomeWindowMature(input: {
  t0: string;
  horizonDays: number;
  lastDataDate: string;
}): boolean {
  return (
    addDaysUtc(input.t0, input.horizonDays) <=
    addDaysUtc(input.lastDataDate, -ATTRIBUTION_EMBARGO_DAYS)
  );
}

const pairKey = (businessId: string, providerAccountId: string) =>
  `${businessId}\u0000${providerAccountId}`;

export function analyzePitReplay(inputs: PitReplayFrozenInputs) {
  // COMPOSITE selected identity: (businessId, providerAccountId) pairs — a
  // bare account-id set would silently merge identically-named accounts
  // across businesses.
  const selectedPairs = new Set(
    inputs.scope.accounts
      .filter((account) => account.isSelected)
      .map((account) => pairKey(account.businessId, account.providerAccountId)),
  );
  const accountCurrency = new Map(
    inputs.scope.accounts.map((account) => [
      pairKey(account.businessId, account.providerAccountId),
      account.accountCurrency,
    ]),
  );
  // Prove (do not assume) account-id/business cardinality from frozen data.
  const businessesByAccount = new Map<string, Set<string>>();
  for (const account of inputs.scope.accounts) {
    const set = businessesByAccount.get(account.providerAccountId) ?? new Set();
    set.add(account.businessId);
    businessesByAccount.set(account.providerAccountId, set);
  }
  const accountBusinessCardinality = {
    accountsAppearingUnderMultipleBusinesses: [...businessesByAccount.entries()]
      .filter(([, businesses]) => businesses.size > 1)
      .map(([accountId, businesses]) => ({
        providerAccountId: accountId,
        businessIds: [...businesses].sort(),
      })),
    note:
      "measured from the frozen scope; composite keys keep the replay correct even when an account id repeats across businesses",
  };
  const lastDataByBusiness = new Map<string, string>();
  for (const cov of inputs.coverage) {
    if (!selectedPairs.has(pairKey(cov.businessId, cov.providerAccountId))) continue;
    const current = lastDataByBusiness.get(cov.businessId);
    if (!current || cov.maxDate > current) {
      lastDataByBusiness.set(cov.businessId, cov.maxDate);
    }
  }

  // Support matrix: per business/account/origin-population × horizon.
  const supportMatrix: Array<{
    businessId: string;
    providerAccountId: string;
    isSelected: boolean;
    firstOrigin: string | null;
    lastOrigin: string | null;
    populationDays: number;
    accountPlanSampledOriginCount: number;
    businessExecutionSampledWithinAccountRange: number;
    executionGrain: string;
    horizonSupportedOriginDays: Record<string, number>;
    unsupportedReason: string | null;
  }> = [];
  for (const cov of inputs.coverage) {
    const plan = enumerateDecisionOrigins({
      firstDataDate: cov.minDate,
      lastDataDate: cov.maxDate,
    });
    const horizonSupportedOriginDays: Record<string, number> = {};
    for (const horizon of PIT_REPLAY_HORIZONS_DAYS) {
      horizonSupportedOriginDays[`h${horizon}`] = plan
        ? Math.max(0, plan.populationDays - horizon)
        : 0;
    }
    // Execution grain: decisions run once per BUSINESS origin (production
    // job grain). Account-level eligibility therefore counts the business
    // plan's sampled origins that fall inside THIS account's own supported
    // range; the account's OWN deterministic plan is reported separately
    // and never mixed with another account's range.
    const businessSampled =
      cov.isSelected
        ? (inputs.originPlans[cov.businessId]?.sampledOrigins ?? [])
        : [];
    const businessSampledWithinAccountRange = plan
      ? businessSampled.filter(
          (origin) =>
            origin >= plan.firstSupportedOrigin &&
            origin <= plan.lastSupportedOrigin,
        ).length
      : 0;
    supportMatrix.push({
      businessId: cov.businessId,
      providerAccountId: cov.providerAccountId,
      isSelected: cov.isSelected,
      firstOrigin: plan?.firstSupportedOrigin ?? null,
      lastOrigin: plan?.lastSupportedOrigin ?? null,
      populationDays: plan?.populationDays ?? 0,
      accountPlanSampledOriginCount: plan?.sampledOrigins.length ?? 0,
      businessExecutionSampledWithinAccountRange:
        businessSampledWithinAccountRange,
      executionGrain:
        "decisions execute once per business origin; deselected accounts execute zero decision origins",
      horizonSupportedOriginDays,
      unsupportedReason: plan
        ? null
        : "fewer than 29 days of retained daily facts (28d feature window cannot precede the first origin)",
    });
  }

  // -------- FAIL-CLOSED account partitioning ------------------------------
  // Headline metrics admit ONLY rows with a NON-NULL SELECTED provider
  // account. Null/unscoped rows and deselected-account rows are excluded and
  // reported in the appendix — never silently admitted.
  const isSelectedRow = (row: ReplayDecisionRowCompact) =>
    row.providerAccountId !== null &&
    selectedPairs.has(pairKey(row.businessId, row.providerAccountId));
  const historicalRows = inputs.perOriginDecisions.filter(
    (row) => row.freshnessMode === "historical",
  );
  const staleRows = inputs.perOriginDecisions.filter(
    (row) => row.freshnessMode === "wall_clock_stale",
  );
  const primary = historicalRows.filter(isSelectedRow);
  const staleMode = staleRows.filter(isSelectedRow);
  const appendix = {
    note:
      "Diagnostic-only rows excluded from EVERY headline metric, action count, proxy, and UI/state selection above: deselected-account rows and fail-closed unscoped (null provider-account) rows.",
    deselectedHistoricalRows: historicalRows.filter(
      (row) =>
        row.providerAccountId !== null &&
        !selectedPairs.has(pairKey(row.businessId, row.providerAccountId)),
    ).length,
    deselectedStaleRows: staleRows.filter(
      (row) =>
        row.providerAccountId !== null &&
        !selectedPairs.has(pairKey(row.businessId, row.providerAccountId)),
    ).length,
    unscopedHistoricalRowsExcluded: historicalRows.filter(
      (row) => row.providerAccountId === null,
    ).length,
    unscopedStaleRowsExcluded: staleRows.filter(
      (row) => row.providerAccountId === null,
    ).length,
  };

  const labelMix: Record<string, number> = {};
  const rawLabelMix: Record<string, number> = {};
  const blockerMix: Record<string, number> = {};
  const roleStatusMix: Record<string, number> = {};
  const trustMix: Record<string, number> = {};
  const byBusiness: Record<string, number> = {};
  const byAccount: Record<string, number> = {};
  let boundaryNearTarget = 0;
  for (const row of primary) {
    labelMix[row.label] = (labelMix[row.label] ?? 0) + 1;
    rawLabelMix[row.rawLabel] = (rawLabelMix[row.rawLabel] ?? 0) + 1;
    if (row.authorityBlocker) {
      blockerMix[row.authorityBlocker] = (blockerMix[row.authorityBlocker] ?? 0) + 1;
    }
    roleStatusMix[row.campaignRoleStatus ?? "null"] =
      (roleStatusMix[row.campaignRoleStatus ?? "null"] ?? 0) + 1;
    trustMix[row.contextTrust ?? "null"] =
      (trustMix[row.contextTrust ?? "null"] ?? 0) + 1;
    byBusiness[row.businessId] = (byBusiness[row.businessId] ?? 0) + 1;
    byAccount[pairKey(row.businessId, row.providerAccountId as string)] =
      (byAccount[pairKey(row.businessId, row.providerAccountId as string)] ?? 0) + 1;
    if (
      row.ratioToTarget !== null &&
      row.ratioToTarget >= 0.9 &&
      row.ratioToTarget <= 1.1
    ) {
      boundaryNearTarget += 1;
    }
  }
  const abstentionLabels = new Set(["test_more", "diagnose", "out_of_scope"]);
  const hardLabels = new Set(["cut", "scale", "refresh"]);
  const abstained = primary.filter((row) => abstentionLabels.has(row.label)).length;
  const hard = primary.filter((row) => hardLabels.has(row.label)).length;
  const heldHard = primary.filter((row) => row.blockedActionType !== null).length;
  const enabledHard = primary.filter(
    (row) => hardLabels.has(row.label) && row.blockedActionType === null,
  ).length;

  // Freshness-block rate: paired per (business, origin, creative) across the
  // two freshness modes over SELECTED rows only.
  const staleByKey = new Map<string, ReplayDecisionRowCompact>();
  for (const row of staleMode) {
    staleByKey.set(
      `${row.businessId}\u0000${row.providerAccountId}\u0000${row.originDate}\u0000${row.creativeId}`,
      row,
    );
  }
  let historicalEnabledHard = 0;
  let freshnessBlockedHard = 0;
  for (const row of primary) {
    const enabledHard = hardLabels.has(row.label) && row.blockedActionType === null;
    if (!enabledHard) continue;
    historicalEnabledHard += 1;
    const stale = staleByKey.get(
      `${row.businessId}\u0000${row.providerAccountId}\u0000${row.originDate}\u0000${row.creativeId}`,
    );
    const staleEnabledHard =
      stale !== undefined &&
      hardLabels.has(stale.label) &&
      stale.blockedActionType === null;
    if (!staleEnabledHard) freshnessBlockedHard += 1;
  }

  // Flip metrics over the SAMPLED grid (see the report's qualification: the
  // stabilization chain is grid-sampled, not a complete daily chain).
  const decisionsByKey = new Map<string, Map<string, ReplayDecisionRowCompact>>();
  for (const row of primary) {
    const key = `${row.businessId}\u0000${row.providerAccountId}\u0000${row.creativeId}`;
    let dates = decisionsByKey.get(key);
    if (!dates) {
      dates = new Map();
      decisionsByKey.set(key, dates);
    }
    dates.set(row.originDate, row);
  }
  let pairComparisons = 0;
  let pairFlips = 0;
  let gridComparisons = 0;
  let gridFlips = 0;
  for (const [businessId, plan] of Object.entries(inputs.originPlans)) {
    if (!plan) continue;
    for (const [dayA, dayB] of plan.consecutivePairs) {
      for (const dates of decisionsByKey.values()) {
        const a = dates.get(dayA);
        const b = dates.get(dayB);
        if (!a || !b || a.businessId !== businessId) continue;
        pairComparisons += 1;
        if (a.label !== b.label) pairFlips += 1;
      }
    }
    const ordered = plan.sampledOrigins;
    for (let index = 1; index < ordered.length; index += 1) {
      for (const dates of decisionsByKey.values()) {
        const a = dates.get(ordered[index - 1]);
        const b = dates.get(ordered[index]);
        if (!a || !b || a.businessId !== businessId) continue;
        gridComparisons += 1;
        if (a.label !== b.label) gridFlips += 1;
      }
    }
  }

  // -------- Outcomes: account-scoped, maturity-embargoed, deduplicated ----
  const outcomeCells: Array<{
    horizonDays: PitHorizonDays;
    label: string;
    realizedOutcome: string;
    severity: string;
    rule: string;
    count: number;
  }> = [];
  const outcomeCounter = new Map<string, number>();
  interface RuleAgg {
    cells: number;
    uniqueDecisions: Set<string>;
    uniqueCreatives: Set<string>;
    byHorizon: Record<string, number>;
  }
  const ruleAggregates = new Map<string, RuleAgg>();
  const confidenceBuckets = new Map<string, number>();
  let matureEvaluated = 0;
  let immatureEmbargoed = 0;
  let outcomeUnsupported = 0;
  // Built ONCE for the whole outcome sweep; every cell below asks about one
  // composite creative and previously re-scanned all of them. Narrowing only
  // — the identity guard inside the aggregate still runs. @see
  // `buildCreativeDayTupleIndex`.
  const creativeDayTupleIndex = buildCreativeDayTupleIndex(
    inputs.creativeDayTuples,
  );
  for (const row of primary) {
    const lastData = lastDataByBusiness.get(row.businessId);
    if (!lastData) continue;
    for (const horizon of PIT_REPLAY_HORIZONS_DAYS) {
      if (addDaysUtc(row.originDate, horizon) > lastData) {
        outcomeUnsupported += 1;
        continue;
      }
      if (!isOutcomeWindowMature({ t0: row.originDate, horizonDays: horizon, lastDataDate: lastData })) {
        immatureEmbargoed += 1;
        continue;
      }
      const aggregate = outcomeAggregateFor({
        tuples: inputs.creativeDayTuples,
        index: creativeDayTupleIndex,
        businessId: row.businessId,
        providerAccountId: row.providerAccountId as string,
        creativeId: row.creativeId,
        t0: row.originDate,
        horizonDays: horizon,
      });
      const classification = classifyCreativeDecisionOutcome({
        label: row.label,
        confidence: row.confidence,
        effectiveTargetRoas: row.effectiveTargetRoas ?? 0,
        baselineSpend: row.spend,
        baselinePurchases: row.purchases,
        baselineRoas: row.roas,
        outcomeSpend: aggregate.outcomeSpend,
        outcomePurchases: aggregate.outcomePurchases,
        outcomeRevenue: aggregate.outcomeRevenue,
        outcomeRoas: aggregate.outcomeRoas,
        outcomeWindowDays: horizon,
      });
      matureEvaluated += 1;
      const rule = String(
        (classification.evidence as { rule?: unknown }).rule ?? "unknown_rule",
      );
      const key = `${horizon}\u0000${row.label}\u0000${classification.realizedOutcome}\u0000${classification.severity}\u0000${rule}`;
      outcomeCounter.set(key, (outcomeCounter.get(key) ?? 0) + 1);
      let ruleAgg = ruleAggregates.get(rule);
      if (!ruleAgg) {
        ruleAgg = {
          cells: 0,
          uniqueDecisions: new Set(),
          uniqueCreatives: new Set(),
          byHorizon: {},
        };
        ruleAggregates.set(rule, ruleAgg);
      }
      ruleAgg.cells += 1;
      ruleAgg.uniqueDecisions.add(
        `${row.businessId}\u0000${row.providerAccountId}\u0000${row.originDate}\u0000${row.creativeId}`,
      );
      ruleAgg.uniqueCreatives.add(
        `${row.businessId}\u0000${row.providerAccountId}\u0000${row.creativeId}`,
      );
      ruleAgg.byHorizon[`h${horizon}`] = (ruleAgg.byHorizon[`h${horizon}`] ?? 0) + 1;
      if (classification.realizedOutcome !== "unknown") {
        const bucket = `${Math.min(4, Math.floor(Math.max(0, row.confidence) / 20)) * 20}-${Math.min(4, Math.floor(Math.max(0, row.confidence) / 20)) * 20 + 19}`;
        confidenceBuckets.set(
          `${bucket}\u0000${classification.realizedOutcome}`,
          (confidenceBuckets.get(`${bucket}\u0000${classification.realizedOutcome}`) ?? 0) + 1,
        );
      }
    }
  }
  for (const [key, count] of [...outcomeCounter.entries()].sort()) {
    const [horizon, label, realizedOutcome, severity, rule] = key.split("\u0000");
    outcomeCells.push({
      horizonDays: Number(horizon) as PitHorizonDays,
      label,
      realizedOutcome,
      severity,
      rule,
      count,
    });
  }
  const ruleDenominators = [...ruleAggregates.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rule, agg]) => ({
      rule,
      cells: agg.cells,
      uniqueDecisionOrigins: agg.uniqueDecisions.size,
      uniqueCreatives: agg.uniqueCreatives.size,
      byHorizon: agg.byHorizon,
    }));
  const confidenceCalibration = [...confidenceBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => {
      const [bucket, realizedOutcome] = key.split("\u0000");
      return { confidenceBucket: bucket, realizedOutcome, count };
    });

  const proxy = (predicate: (cell: (typeof outcomeCells)[number]) => boolean) =>
    outcomeCells.filter(predicate).reduce((sum, cell) => sum + cell.count, 0);
  const uniqueOf = (rule: string) => {
    const agg = ruleAggregates.get(rule);
    return {
      cells: agg?.cells ?? 0,
      uniqueDecisionOrigins: agg?.uniqueDecisions.size ?? 0,
      uniqueCreatives: agg?.uniqueCreatives.size ?? 0,
    };
  };
  // Classifier semantics (creative-outcome-classifier.v2): for NON-HARD
  // labels, "positive" means a MISSED hard-action opportunity was observed
  // (the rule names which), and "neutral" means the hold stayed consistent
  // with later evidence. Hard labels carry their own direction. Overlapping
  // horizon cells are CORRELATED duplicates of the same decisions — the
  // unique denominators are the honest scale.
  const proxies = {
    prematureCutProxy: proxy(
      (cell) => cell.label === "cut" && cell.rule === "cut_recovered_above_target",
    ),
    supportedCutProxy: proxy(
      (cell) => cell.label === "cut" && cell.rule === "cut_loss_continued",
    ),
    prematureScaleProxy: proxy(
      (cell) => cell.label === "scale" && cell.rule === "scale_failed_recent_hold",
    ),
    supportedScaleProxy: proxy(
      (cell) => cell.label === "scale" && cell.rule === "scale_held_above_target",
    ),
    missedScaleProxy: uniqueOf("non_hard_missed_scale_opportunity"),
    missedCutProxy: uniqueOf("non_hard_missed_cut_opportunity"),
    holdConsistentProxy: uniqueOf("non_hard_no_missed_hard_action"),
    unknownOutcomeCells: proxy((cell) => cell.realizedOutcome === "unknown"),
    note:
      "Observational proxies over ATTRIBUTION-MATURE classifier outcomes under the action NOT taken; horizon cells are correlated duplicates (unique denominators included); causal effect of taking the action is UNKNOWN (no controlled treatment).",
  };

  // -------- Strict temporal classification (F1) ---------------------------
  // Role/context features are rebuilt from restated `meta_creative_daily`
  // rows without capture-time versioning, and the lifecycle hydration path
  // itself joins mutable daily tables — so NO layer-complete capture proof
  // exists in this evidence for any origin.
  const ROLE_LAYER_CAPTURE_PROVEN = false;
  const METRIC_LAYER_CAPTURE_PROVEN = false;
  const originTemporal = inputs.perOriginMeta.map((meta) => {
    const classified = classifyOriginTemporal({
      originDate: meta.originDate,
      sourceMode: meta.sourceMode,
      lifecycleComputedAt: meta.lifecycleComputedAt,
      roleLayerCaptureProven: ROLE_LAYER_CAPTURE_PROVEN,
      metricLayerCaptureProven: METRIC_LAYER_CAPTURE_PROVEN,
    });
    return {
      businessId: meta.businessId,
      originDate: meta.originDate,
      decisionCutoffUtc: classified.decisionCutoffUtc,
      sourceMode: meta.sourceMode,
      lifecycleSnapshotPersistedSameDay: classified.lifecycleSnapshotPersistedSameDay,
      overallClass: classified.overallClass,
    };
  });
  const temporalCounts = {
    origins: originTemporal.length,
    overallPitSafe: originTemporal.filter((o) => o.overallClass === "pit_safe").length,
    overallRestatedRetrospective: originTemporal.filter(
      (o) => o.overallClass === "restated_retrospective",
    ).length,
    lifecycleSnapshotPersistedSameDay: originTemporal.filter(
      (o) => o.lifecycleSnapshotPersistedSameDay,
    ).length,
    roleLayerCaptureProven: ROLE_LAYER_CAPTURE_PROVEN,
    metricLayerCaptureProven: METRIC_LAYER_CAPTURE_PROVEN,
    note:
      "Overall PIT safety requires EVERY contributing layer (metrics, role/context, lifecycle) capture-proven at or before the origin's decision cutoff. This evidence cannot prove the role or metric layers for any origin, so the honest overall PIT-safe count is 0; lifecycleSnapshotPersistedSameDay is a SOURCE-LAYER characteristic only.",
  };

  // -------- Target verification (fail-closed statuses, F2) ----------------
  const targetVerification = verifyTargetsAtOrigins({
    targetHistory: inputs.targetHistory,
    rows: primary,
  });

  // -------- Scenario matrix (charter axes; explicit unsupported cells) ----
  const rowRef = (row: ReplayDecisionRowCompact) =>
    `${row.businessId}|${row.providerAccountId}|${row.originDate}|${row.creativeId}`;
  const rowCell = (
    axis: string,
    cell: string,
    predicate: (row: ReplayDecisionRowCompact) => boolean,
  ) => {
    const matches = primary.filter(predicate);
    const representative = matches
      .map(rowRef)
      .sort()[0] ?? null;
    return {
      axis,
      cell,
      supported: true as const,
      count: matches.length,
      representative,
    };
  };
  const fixedCell = (axis: string, cell: string, count: number, representative: string | null = null) => ({
    axis,
    cell,
    supported: true as const,
    count,
    representative,
  });
  const unsupportedCell = (axis: string, cell: string, reason: string) => ({
    axis,
    cell,
    supported: false as const,
    count: null,
    reason,
  });
  const thresholdsByOrigin = new Map(
    inputs.perOriginMeta.map((meta) => [
      `${meta.businessId}\u0000${meta.originDate}`,
      meta.thresholds,
    ]),
  );
  const near = (value: number | null, anchor: number | null, tolerance: number) =>
    value !== null && anchor !== null && anchor > 0 &&
    Math.abs(value - anchor) / anchor <= tolerance;
  // Origin-as-of relaunch: the first qualifying relaunch date must be at or
  // before the row's origin. (The lifetime-set variant leaked future gaps
  // into earlier origins — rejected and regression-tested.)
  const relaunchFirstDates = firstRelaunchDates(inputs.creativeDayTuples);
  const scenarioMatrix = [
    // Data state
    rowCell("dataState", "fresh_normalized", (row) => row.dataFreshnessHours !== null && row.dataFreshnessHours <= 6),
    rowCell("dataState", "freshness_unknown_null", (row) => row.dataFreshnessHours === null),
    rowCell("dataState", "partially_missing_metrics_roas_null_with_spend", (row) => row.spend > 0 && row.roas === null),
    fixedCell("dataState", "stale_wall_clock_selected_rows", staleMode.length),
    fixedCell("dataState", "attribution_immature_embargoed_cells", immatureEmbargoed),
    fixedCell("dataState", "restated_retrospective_origins", temporalCounts.overallRestatedRetrospective),
    fixedCell("dataState", "overall_pit_safe_origins", temporalCounts.overallPitSafe),
    fixedCell(
      "dataState",
      "no_eligible_input_origins",
      inputs.perOriginMeta.filter((meta) => meta.inputCount === 0).length,
    ),
    // Entity maturity / lifecycle
    rowCell("entityMaturity", "new_low_spend_lt_50", (row) => row.spend < 50),
    rowCell("entityMaturity", "learning_spend_50_250", (row) => row.spend >= 50 && row.spend < 250),
    rowCell("entityMaturity", "sampled_spend_250_1000", (row) => row.spend >= 250 && row.spend < 1000),
    rowCell("entityMaturity", "high_spend_1000_plus", (row) => row.spend >= 1000),
    rowCell("entityMaturity", "zero_purchase_spend_100_plus", (row) => row.spend >= 100 && row.purchases === 0),
    rowCell("entityMaturity", "young_age_lte_7d", (row) => row.ageDays !== null && row.ageDays <= 7),
    rowCell("entityMaturity", "paused_status_at_origin", (row) => row.effectiveStatus === "PAUSED"),
    rowCell("entityMaturity", "relaunched_after_14d_spend_gap_as_of_origin", (row) => {
      const firstRelaunch = relaunchFirstDates.get(
        `${row.businessId}\u0000${row.providerAccountId}\u0000${row.creativeId}`,
      );
      return firstRelaunch !== undefined && firstRelaunch <= row.originDate;
    }),
    unsupportedCell(
      "entityMaturity",
      "structurally_changed",
      "campaign/ad-set structural-change evidence is not frozen at decision-row grain in this bundle",
    ),
    // Inferred role context
    // Decision-row kind semantics require HIGH trust; with the resolver
    // authority gate closed, every consumed kind demotes to medium and
    // decision.campaignKind is null BY DESIGN — these cells measure the
    // authority-gated activation truth, not the role-layer distribution
    // (which lives in roleAnalysis at campaign grain).
    rowCell("inferredRole", "kind_semantics_active_main_requires_high_trust", (row) => row.campaignKind === "main"),
    rowCell("inferredRole", "kind_semantics_active_test_requires_high_trust", (row) => row.campaignKind === "test"),
    rowCell("inferredRole", "kind_semantics_active_mixed_requires_high_trust", (row) => row.campaignKind === "mixed"),
    rowCell("inferredRole", "role_resolved_consumed_at_medium_trust", (row) => row.campaignRoleStatus === "resolved"),
    rowCell("inferredRole", "role_unresolved_review_only", (row) => row.campaignRoleStatus !== "resolved"),
    rowCell("inferredRole", "context_conflict_trust", (row) => row.contextTrust === "conflict"),
    unsupportedCell(
      "inferredRole",
      "role_transition_points_all_accounts",
      "recorded in roleAnalysis.perAccount (transitions/suppressedFlipPoints), not at decision-row grain",
    ),
    // Decision boundary
    rowCell("decisionBoundary", "ratio_below_target_0_8_0_9", (row) => row.ratioToTarget !== null && row.ratioToTarget >= 0.8 && row.ratioToTarget < 0.9),
    rowCell("decisionBoundary", "ratio_at_target_0_9_1_1", (row) => row.ratioToTarget !== null && row.ratioToTarget >= 0.9 && row.ratioToTarget <= 1.1),
    rowCell("decisionBoundary", "ratio_above_target_1_1_1_25", (row) => row.ratioToTarget !== null && row.ratioToTarget > 1.1 && row.ratioToTarget <= 1.25),
    rowCell("decisionBoundary", "spend_within_10pct_commercial_maturity", (row) =>
      near(row.spend, thresholdsByOrigin.get(`${row.businessId}\u0000${row.originDate}`)?.commercialMaturitySpend ?? null, 0.1),
    ),
    rowCell("decisionBoundary", "spend_within_10pct_hard_cut_threshold", (row) =>
      near(row.spend, thresholdsByOrigin.get(`${row.businessId}\u0000${row.originDate}`)?.hardCutSpend ?? null, 0.1),
    ),
    rowCell("decisionBoundary", "purchases_within_1_of_scale_min", (row) => {
      const min = thresholdsByOrigin.get(`${row.businessId}\u0000${row.originDate}`)?.scaleMinPurchases ?? null;
      return min !== null && Math.abs(row.purchases - min) <= 1;
    }),
    rowCell("decisionBoundary", "confidence_45_55", (row) => row.confidence >= 45 && row.confidence <= 55),
    rowCell("decisionBoundary", "freshness_at_6h_cap", (row) => row.dataFreshnessHours === 6),
    // Action / result
    ...["cut", "scale", "refresh", "keep", "test_more", "diagnose", "out_of_scope"].map((label) =>
      rowCell("actionResult", `published_${label}`, (row) => row.label === label),
    ),
    rowCell("actionResult", "held_hard_action", (row) => row.blockedActionType !== null),
    // Stability
    fixedCell("stability", "consecutive_day_comparisons", pairComparisons),
    fixedCell("stability", "consecutive_day_flips", pairFlips),
    fixedCell("stability", "grid_comparisons", gridComparisons),
    fixedCell("stability", "grid_flips", gridFlips),
    unsupportedCell(
      "stability",
      "stale_to_fresh_transitions",
      "per-row raw freshness beyond the 6h historical cap is not frozen, so a stale→fresh transition cannot be derived from this bundle",
    ),
    // Business/account diversity
    // Currency/timezone are CURRENT account-identity attributes (latest
    // fact), not per-origin history — named accordingly.
    ...inputs.scope.accounts
      .filter((account) => account.isSelected)
      .map((account) =>
        rowCell(
          "diversity",
          `account_${account.providerAccountId}_current_currency_${account.accountCurrency ?? "unknown"}`,
          (row) =>
            row.businessId === account.businessId &&
            row.providerAccountId === account.providerAccountId,
        ),
      ),
    rowCell("diversity", "current_currency_TRY_rows", (row) =>
      accountCurrency.get(pairKey(row.businessId, row.providerAccountId ?? "")) === "TRY",
    ),
    rowCell("diversity", "current_currency_USD_rows", (row) =>
      accountCurrency.get(pairKey(row.businessId, row.providerAccountId ?? "")) === "USD",
    ),
  ];

  return {
    decisionLayer: {
      totalDecisionRows: primary.length,
      byBusiness,
      byAccount,
      labelMix,
      rawLabelMix,
      blockerMix,
      roleStatusMix,
      contextTrustMix: trustMix,
      abstentionRate: primary.length > 0 ? abstained / primary.length : null,
      hardActionCount: hard,
      heldHardActionCount: heldHard,
      boundaryNearTargetCount: boundaryNearTarget,
      staleModeRows: staleMode.length,
      staleModeEnabledHardActions: staleMode.filter(
        (row) => hardLabels.has(row.label) && row.blockedActionType === null,
      ).length,
      enabledHardActionCount: enabledHard,
      freshnessBlock: {
        historicalEnabledHardActions: historicalEnabledHard,
        blockedUnderWallClockStaleness: freshnessBlockedHard,
        freshnessBlockRate:
          historicalEnabledHard > 0
            ? freshnessBlockedHard / historicalEnabledHard
            : null,
        note:
          historicalEnabledHard === 0
            ? "no ENABLED hard action exists anywhere in the historical replay (every hard signal is context-held or hysteresis-suppressed), so staleness had nothing further to demote; stale-mode enabled hard actions are independently zero"
            : null,
      },
    },
    appendix,
    flipMetrics: {
      consecutiveDayComparisons: pairComparisons,
      consecutiveDayFlips: pairFlips,
      consecutiveDayFlipRate:
        pairComparisons > 0 ? pairFlips / pairComparisons : null,
      biweeklyGridComparisons: gridComparisons,
      biweeklyGridFlips: gridFlips,
      biweeklyGridFlipRate:
        gridComparisons > 0 ? gridFlips / gridComparisons : null,
      qualification:
        "The stabilization chain feeding these decisions is the SAMPLED origin grid, not a complete daily production chain; adjacent-pair flips measure single-step label agreement under that grid-chained prior state.",
    },
    outcomeLayer: {
      classifierVersion: CREATIVE_OUTCOME_CLASSIFIER_VERSION,
      attributionEmbargoDays: ATTRIBUTION_EMBARGO_DAYS,
      attributionEmbargoBasis:
        "meta_creative_daily.conversions is Meta-attributed (standard maximum 7-day click window) and the frozen restated_after_days evidence shows daily facts are rewritten after the fact date; outcome windows ending within the embargo of the last retained day are excluded from proxies as attribution-immature.",
      matureEvaluatedCells: matureEvaluated,
      immatureEmbargoedCells: immatureEmbargoed,
      unsupportedDecisionHorizonCells: outcomeUnsupported,
      cells: outcomeCells,
      ruleDenominators,
      confidenceCalibration,
      proxies,
    },
    temporalIntegrity: {
      originTemporal,
      temporalCounts,
      targetVerification,
      restatedRowShareByAccount: inputs.coverage.map((cov) => ({
        businessId: cov.businessId,
        providerAccountId: cov.providerAccountId,
        restatedShare:
          cov.rowCount > 0 ? cov.restatedRowCount / cov.rowCount : null,
      })),
    },
    scenarioMatrix,
    supportMatrix,
    accountBusinessCardinality,
  };
}

// ---------------------------------------------------------------------------
// Role-layer aggregate analysis (pure)
// ---------------------------------------------------------------------------

export function analyzeRoleTimelines(input: {
  primary: Map<string, Map<string, RoleTimeline>>;
  parity: Map<string, Map<string, RoleTimeline>>;
}) {
  const perAccount: Array<{
    businessId: string;
    accountId: string;
    campaigns: number;
    daysEvaluated: number;
    publishedKindPoints: Record<string, number>;
    transitions: number;
    suppressedFlipPoints: number;
    conflictPoints: number;
    nameBlindVsParityDisagreements: number;
    parityOnlyResolvedCampaigns: number;
  }> = [];
  for (const [scopeKey, timelines] of [...input.primary.entries()].sort()) {
    const [businessId, accountId] = scopeKey.split("\u0000");
    const parityTimelines = input.parity.get(scopeKey) ?? new Map();
    let transitions = 0;
    let suppressed = 0;
    let conflicts = 0;
    let daysEvaluated = 0;
    let disagreements = 0;
    let parityOnlyResolved = 0;
    const kindDays: Record<string, number> = {};
    for (const [campaignId, timeline] of timelines) {
      daysEvaluated += timeline.daysEvaluated;
      let previousKind: CampaignKind | null | "∅" = "∅";
      for (const point of timeline.points) {
        if (previousKind !== "∅" && point.publishedKind !== previousKind) {
          transitions += 1;
        }
        previousKind = point.publishedKind;
        if (point.suppressedFlip) suppressed += 1;
        if (point.publishedClass === "conflict") conflicts += 1;
        kindDays[point.publishedKind ?? "unresolved"] =
          (kindDays[point.publishedKind ?? "unresolved"] ?? 0) + 1;
      }
      const parityTimeline = parityTimelines.get(campaignId);
      const lastPrimary = timeline.points[timeline.points.length - 1] ?? null;
      const lastParity = parityTimeline?.points[parityTimeline.points.length - 1] ?? null;
      if (lastPrimary && lastParity && lastPrimary.publishedKind !== lastParity.publishedKind) {
        disagreements += 1;
      }
      if (lastPrimary?.publishedKind === null && lastParity?.publishedKind !== null && lastParity) {
        parityOnlyResolved += 1;
      }
    }
    perAccount.push({
      businessId,
      accountId,
      campaigns: timelines.size,
      daysEvaluated,
      publishedKindPoints: kindDays,
      transitions,
      suppressedFlipPoints: suppressed,
      conflictPoints: conflicts,
      nameBlindVsParityDisagreements: disagreements,
      parityOnlyResolvedCampaigns: parityOnlyResolved,
    });
  }
  return { resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION, perAccount };
}

// ---------------------------------------------------------------------------
// Extract phase (production RR/RO) — see file header for the safety contract.
// ---------------------------------------------------------------------------

async function runExtract() {
  const [{ getDb, runDbTransaction }, operational] = await Promise.all([
    import("@/lib/db"),
    import("@/scripts/_operational-runtime"),
  ]);
  const { WarehouseDataSource } = await import(
    "@/lib/creative-decision-engine/data-source"
  );
  const { decideCreative } = await import("@/lib/creative-decision-engine/engine");
  const { resolveAccountDecisionProfile } = await import(
    "@/lib/creative-decision-engine/account-decision-profile"
  );
  const { resolveEngineV3Flags } = await import(
    "@/lib/creative-decision-engine/feature-flags"
  );
  const {
    withCreativeCampaignLabelContext,
    applyCreativeCampaignLabelGuard,
  } = await import("@/lib/creative-decision-engine/campaign-label-guard");
  const { stabilizeDecisionLabel } = await import(
    "@/lib/creative-decision-engine/decision-stability"
  );
  const { composeDataHealth } = await import(
    "@/lib/creative-decision-engine/data-health"
  );
  const { ENGINE_VERSION } = await import("@/lib/creative-decision-engine/types");

  operational.configureOperationalScriptRuntime({ lane: "read_only_observation" });
  process.env.DB_QUERY_TIMEOUT_MS = "180000";

  const businessIds = PIT_REPLAY_BUSINESSES.map((b) => b.businessId);
  const startedAt = new Date().toISOString();

  const frozen = await operational.withOperationalStartupLogsSilenced(async () =>
    runDbTransaction(
      async () => {
        const db = getDb();
        await db.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        const [proofRow] = await db.query<Row>(
          `SELECT now()::text AS retrieved_at,
                  current_setting('application_name') AS application_name,
                  current_setting('transaction_isolation') AS transaction_isolation,
                  current_setting('transaction_read_only') AS transaction_read_only`,
        );
        if (toText(proofRow?.transaction_read_only) !== "on") {
          throw new Error(
            "PIT replay refuses to run outside a read-only transaction",
          );
        }
        if (toText(proofRow?.transaction_isolation) !== "repeatable read") {
          throw new Error("PIT replay requires REPEATABLE READ isolation");
        }

        const businessRows = await db.query<Row>(
          `SELECT id::text AS business_id, name, currency, timezone,
                  COALESCE(is_demo_business, FALSE) AS is_demo
             FROM businesses WHERE id = ANY($1::uuid[]) ORDER BY name`,
          [businessIds],
        );
        if (businessRows.length !== PIT_REPLAY_BUSINESSES.length) {
          throw new Error(
            "charter business set not fully present in the database",
          );
        }
        for (const pinned of PIT_REPLAY_BUSINESSES) {
          const found = businessRows.find(
            (row) => toText(row.business_id) === pinned.businessId,
          );
          if (!found || toText(found.name) !== pinned.name) {
            throw new Error(`business identity drift for ${pinned.businessId}`);
          }
          if (found.is_demo === true) {
            throw new Error(`demo business in charter scope: ${pinned.name}`);
          }
        }

        const accountRows = await db.query<Row>(
          `SELECT bpa.business_id, pa.external_account_id AS provider_account_id,
                  bpa.is_selected,
                  (SELECT d.account_currency FROM meta_account_daily d
                    WHERE d.business_id = bpa.business_id
                      AND d.provider_account_id = pa.external_account_id
                    ORDER BY d.date DESC LIMIT 1) AS account_currency,
                  (SELECT d.account_timezone FROM meta_account_daily d
                    WHERE d.business_id = bpa.business_id
                      AND d.provider_account_id = pa.external_account_id
                    ORDER BY d.date DESC LIMIT 1) AS account_timezone
             FROM business_provider_accounts bpa
             JOIN provider_accounts pa
               ON pa.id = bpa.provider_account_ref_id AND pa.provider = 'meta'
            WHERE bpa.provider = 'meta' AND bpa.business_id = ANY($1::text[])
            ORDER BY bpa.business_id, provider_account_id`,
          [businessIds],
        );
        if (accountRows.length !== 7) {
          throw new Error(
            `expected exactly 7 assigned meta accounts across the six businesses, found ${accountRows.length}`,
          );
        }

        const targetRows = await db.query<Row>(
          `SELECT business_id::text AS business_id, id::text AS id, operation,
                  effective_at::text AS effective_at,
                  recorded_at::text AS recorded_at,
                  target_roas, break_even_roas, target_cpa, break_even_cpa,
                  default_risk_posture
             FROM business_target_pack_history
            WHERE business_id = ANY($1::uuid[])
            ORDER BY business_id, effective_at, recorded_at, id`,
          [businessIds],
        );

        const tupleRows = await db.query<Row>(
          `WITH first_spend AS (
             SELECT provider_account_id, creative_id, MIN(date) AS first_spend_date
               FROM meta_creative_daily
              WHERE (business_ref_id::text = ANY($1) OR business_id = ANY($1))
                AND spend > 0 AND provider_account_id IS NOT NULL
              GROUP BY 1, 2)
           SELECT COALESCE(d.business_ref_id::text, d.business_id) AS business_id,
                  d.provider_account_id, d.campaign_id, d.adset_id, d.creative_id,
                  d.date::text AS date, d.spend,
                  COALESCE(d.conversions, 0) AS conversions,
                  COALESCE(d.revenue, 0) AS revenue,
                  fs.first_spend_date::text AS first_spend_date,
                  CASE WHEN d.updated_at IS NULL THEN NULL
                       ELSE GREATEST(0, EXTRACT(EPOCH FROM (d.updated_at - (d.date::timestamptz + INTERVAL '1 day'))) / 86400.0)
                  END AS restated_after_days
             FROM meta_creative_daily d
             JOIN first_spend fs
               ON fs.provider_account_id = d.provider_account_id
              AND fs.creative_id = d.creative_id
            WHERE (d.business_ref_id::text = ANY($1) OR d.business_id = ANY($1))
              AND d.spend > 0 AND d.campaign_id IS NOT NULL
              AND d.creative_id IS NOT NULL AND d.provider_account_id IS NOT NULL
            ORDER BY 1, 2, date, 3, 5`,
          [businessIds],
        );

        const namePointRows = await db.query<Row>(
          `WITH timeline AS (
             SELECT COALESCE(business_ref_id::text, business_id) AS business_id,
                    provider_account_id, campaign_id, date,
                    COALESCE(campaign_name_current, campaign_name_historical) AS campaign_name,
                    LAG(COALESCE(campaign_name_current, campaign_name_historical)) OVER (
                      PARTITION BY COALESCE(business_ref_id::text, business_id), provider_account_id, campaign_id ORDER BY date) AS previous_name,
                    ROW_NUMBER() OVER (
                      PARTITION BY COALESCE(business_ref_id::text, business_id), provider_account_id, campaign_id ORDER BY date) AS seq
               FROM meta_campaign_daily
              WHERE (business_ref_id::text = ANY($1) OR business_id = ANY($1))
                AND provider_account_id IS NOT NULL AND campaign_id IS NOT NULL)
           SELECT business_id, provider_account_id, campaign_id, date::text AS date, campaign_name
             FROM timeline
            WHERE seq = 1 OR campaign_name IS DISTINCT FROM previous_name
            ORDER BY business_id, provider_account_id, campaign_id, date`,
          [businessIds],
        );
        const firstSeenRows = await db.query<Row>(
          `SELECT COALESCE(business_ref_id::text, business_id) AS business_id,
                  provider_account_id, campaign_id, MIN(date)::text AS first_seen
             FROM meta_campaign_daily
            WHERE (business_ref_id::text = ANY($1) OR business_id = ANY($1))
              AND provider_account_id IS NOT NULL AND campaign_id IS NOT NULL
            GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
          [businessIds],
        );

        const contextCoverage = await db.query<Row>(
          `SELECT business_id,
                  COUNT(*) FILTER (WHERE provider_account_id IS NOT NULL)::int AS account_scoped_rows,
                  COUNT(*) FILTER (WHERE provider_account_id IS NULL)::int AS legacy_null_account_rows
             FROM engine_v3_campaign_context_daily
            WHERE business_id = ANY($1::text[]) GROUP BY 1 ORDER BY 1`,
          [businessIds],
        );
        const lifecycleCoverage = await db.query<Row>(
          `SELECT business_id, MIN(as_of_date)::text AS min_as_of,
                  MAX(as_of_date)::text AS max_as_of, COUNT(*)::int AS n
             FROM engine_v3_creative_lifecycle_daily
            WHERE business_id = ANY($1::text[]) GROUP BY 1 ORDER BY 1`,
          [businessIds],
        );

        // ---- assemble frozen inputs (pure shapes) --------------------------
        const accounts = accountRows.map((row) => ({
          businessId: toText(row.business_id) ?? "",
          providerAccountId: toText(row.provider_account_id) ?? "",
          isSelected: row.is_selected === true,
          accountCurrency: toText(row.account_currency),
          accountTimezone: toText(row.account_timezone),
        }));
        const tuples: CreativeDayTuple[] = tupleRows.map((row) => [
          toText(row.business_id) ?? "",
          toText(row.provider_account_id) ?? "",
          toText(row.campaign_id) ?? "",
          toText(row.adset_id),
          toText(row.creative_id) ?? "",
          dayOf(row.date) ?? "",
          toNum(row.spend),
          toNum(row.conversions),
          toNum(row.revenue),
          dayOf(row.first_spend_date) ?? "",
          toNumOrNull(row.restated_after_days),
        ]);
        const namePoints: CampaignNamePoint[] = namePointRows.map((row) => ({
          businessId: toText(row.business_id) ?? "",
          accountId: toText(row.provider_account_id) ?? "",
          campaignId: toText(row.campaign_id) ?? "",
          date: dayOf(row.date) ?? "",
          campaignName: toText(row.campaign_name),
        }));
        const firstSeen: CampaignFirstSeenRow[] = firstSeenRows.map((row) => ({
          businessId: toText(row.business_id) ?? "",
          accountId: toText(row.provider_account_id) ?? "",
          campaignId: toText(row.campaign_id) ?? "",
          firstSeenDate: dayOf(row.first_seen) ?? "",
        }));
        const targetHistory: PitTargetHistoryRow[] = targetRows.map((row) => ({
          businessId: toText(row.business_id) ?? "",
          id: toText(row.id),
          operation: (toText(row.operation) ?? "upsert") as "upsert" | "delete",
          effectiveAt: new Date(String(row.effective_at)).toISOString(),
          recordedAt: new Date(String(row.recorded_at)).toISOString(),
          targetRoas: toNumOrNull(row.target_roas),
          breakEvenRoas: toNumOrNull(row.break_even_roas),
          targetCpa: toNumOrNull(row.target_cpa),
          breakEvenCpa: toNumOrNull(row.break_even_cpa),
          defaultRiskPosture: toText(row.default_risk_posture) ?? "balanced",
        }));

        const coverage = accounts.map((account) => {
          const accountTuples = tuples.filter(
            (t) =>
              t[0] === account.businessId &&
              t[1] === account.providerAccountId,
          );
          const dates = accountTuples.map((t) => t[5]).sort();
          const restated = accountTuples.filter(
            (t) => t[10] !== null && (t[10] as number) > 3,
          ).length;
          return {
            businessId: account.businessId,
            providerAccountId: account.providerAccountId,
            isSelected: account.isSelected,
            rowCount: accountTuples.length,
            minDate: dates[0] ?? "",
            maxDate: dates[dates.length - 1] ?? "",
            restatedRowCount: restated,
          };
        });

        // ---- role timelines (pure, in-memory; needed for context maps),
        //      keyed by the COMPOSITE (business, account) pair --------------
        const primaryTimelines = new Map<string, Map<string, RoleTimeline>>();
        const parityTimelines = new Map<string, Map<string, RoleTimeline>>();
        for (const cov of coverage) {
          if (!cov.minDate || !cov.maxDate) continue;
          const days: string[] = [];
          for (
            let day = addDaysUtc(cov.minDate, 27);
            day <= cov.maxDate;
            day = addDaysUtc(day, 1)
          ) {
            days.push(day);
          }
          const key = `${cov.businessId}\u0000${cov.providerAccountId}`;
          primaryTimelines.set(
            key,
            buildRoleTimelines({
              tuples,
              namePoints,
              firstSeen,
              businessId: cov.businessId,
              accountId: cov.providerAccountId,
              days,
              nameBlind: true,
            }),
          );
          parityTimelines.set(
            key,
            buildRoleTimelines({
              tuples,
              namePoints,
              firstSeen,
              businessId: cov.businessId,
              accountId: cov.providerAccountId,
              days,
              nameBlind: false,
            }),
          );
        }

        // ---- decision-layer origins (sampled) through the REAL engine ------
        const originPlans: Record<string, OriginPlan | null> = {};
        const coverageByBusiness = new Map<string, { min: string; max: string }>();
        for (const cov of coverage) {
          if (!cov.isSelected || !cov.minDate) continue;
          const current = coverageByBusiness.get(cov.businessId);
          coverageByBusiness.set(cov.businessId, {
            min: current && current.min < cov.minDate ? current.min : cov.minDate,
            max: current && current.max > cov.maxDate ? current.max : cov.maxDate,
          });
        }
        for (const pinned of PIT_REPLAY_BUSINESSES) {
          const span = coverageByBusiness.get(pinned.businessId);
          originPlans[pinned.businessId] = span
            ? enumerateDecisionOrigins({
                firstDataDate: span.min,
                lastDataDate: span.max,
              })
            : null;
        }

        const dataSource = new WarehouseDataSource();
        const perOriginDecisions: ReplayDecisionRowCompact[] = [];
        const perOriginMeta: PitReplayFrozenInputs["perOriginMeta"] = [];
        const engineFlags = new Map<string, unknown>();
        const selectedPairKeys = new Set(
          accounts
            .filter((a) => a.isSelected)
            .map((a) => `${a.businessId}\u0000${a.providerAccountId}`),
        );
        const uiStates = new Map<string, Record<string, unknown>>();

        for (const pinned of PIT_REPLAY_BUSINESSES) {
          const plan = originPlans[pinned.businessId];
          if (!plan) continue;
          const flags = await resolveEngineV3Flags(pinned.businessId);
          engineFlags.set(pinned.businessId, flags);
          const previousLabels = new Map<
            string,
            { publishedLabel: DecisionLabel; rawLabel: DecisionLabel }
          >();
          const accountsOfBusiness = accounts
            .filter((account) => account.businessId === pinned.businessId)
            .map((account) => account.providerAccountId);
          const accountByCampaign = new Map<string, string | null>();
          for (const t of tuples) {
            if (t[0] !== pinned.businessId) continue;
            const existing = accountByCampaign.get(t[2]);
            if (existing === undefined) accountByCampaign.set(t[2], t[1]);
            else if (existing !== t[1]) accountByCampaign.set(t[2], null);
          }

          for (const originDate of plan.sampledOrigins) {
            const [sourceModeRow] = await db.query<Row>(
              `SELECT
                 (SELECT COUNT(*) FROM engine_v3_creative_lifecycle_daily
                   WHERE business_ref_id = $1::uuid AND engine_version = $3
                     AND as_of_date = $2::date) AS same_day_rows,
                 (SELECT MAX(computed_at)::text FROM engine_v3_creative_lifecycle_daily
                   WHERE business_ref_id = $1::uuid AND engine_version = $3
                     AND as_of_date = $2::date) AS same_day_computed_at,
                 (SELECT COUNT(*) FROM engine_v3_creative_lifecycle_daily
                   WHERE business_ref_id = $1::uuid AND engine_version = $3
                     AND as_of_date <= $2::date) AS rows_up_to`,
              [pinned.businessId, originDate, ENGINE_VERSION],
            );
            const sameDayRows = toNum(sourceModeRow?.same_day_rows);
            const rowsUpTo = toNum(sourceModeRow?.rows_up_to);
            const sourceMode =
              rowsUpTo === 0
                ? "runtime_sql_fallback"
                : sameDayRows > 0
                  ? "lifecycle_same_day"
                  : "lifecycle_carry_forward";
            const lifecycleComputedAt = toText(sourceModeRow?.same_day_computed_at);

            const profile = await resolveAccountDecisionProfile({
              businessId: pinned.businessId,
              asOf: originDate,
              dataSource,
              flags,
            });
            const rawHealth = await dataSource.getDataHealth({
              businessId: pinned.businessId,
              asOf: originDate,
            });
            const rawInputs = await dataSource.listCreativeInputs({
              businessId: pinned.businessId,
              asOf: originDate,
            });

            const campaignIds = [
              ...new Set(
                rawInputs
                  .map((input) => input.campaignId?.trim() ?? "")
                  .filter(Boolean),
              ),
            ].sort();
            // Account-scoped context: campaigns resolve against their own
            // account's replay timeline (missing account scope => unresolved,
            // mirroring production fail-closed behavior).
            // PER-ACCOUNT context maps: each decision input resolves its
            // own (business, account) scope and reads THAT account's role
            // timeline for its campaign — never a business-global
            // campaignId key (which would collapse colliding campaign ids
            // across accounts to unresolved).
            const contextMapsByAccount = new Map<
              string,
              Map<string, CreativeCampaignContextEntry>
            >();
            for (const accountId of accountsOfBusiness) {
              const scoped = primaryTimelines.get(
                `${pinned.businessId}\u0000${accountId}`,
              );
              const map = new Map<string, CreativeCampaignContextEntry>();
              for (const campaignId of campaignIds) {
                const timeline = scoped?.get(campaignId);
                map.set(
                  campaignId,
                  contextEntryFromRoleState(
                    timeline ? roleStateAt(timeline, originDate) : null,
                  ),
                );
              }
              contextMapsByAccount.set(accountId, map);
            }
            const emptyContextMap = new Map<string, CreativeCampaignContextEntry>();
            const contextMapFor = (input: {
              providerAccountId?: string | null;
              campaignId?: string | null;
            }) => {
              const resolvedAccount =
                input.providerAccountId ??
                (input.campaignId
                  ? (accountByCampaign.get(input.campaignId) ?? null)
                  : null);
              return resolvedAccount
                ? (contextMapsByAccount.get(resolvedAccount) ?? emptyContextMap)
                : emptyContextMap;
            };

            const normalizeLayer = (layer: (typeof rawHealth)["calibration"]) => ({
              ...layer,
              asOfDate: layer.asOfDate ?? originDate,
              sourceFreshnessHours:
                layer.sourceFreshnessHours === null ? null : 0,
              staleTier: "none" as const,
              note: layer.note
                ? `${layer.note}; historical replay freshness normalized`
                : "historical replay freshness normalized",
            });
            const decideOnce = (mode: "historical" | "wall_clock_stale") => {
              const health =
                mode === "historical"
                  ? composeDataHealth({
                      calibration: normalizeLayer(rawHealth.calibration),
                      lifecycle: normalizeLayer(rawHealth.lifecycle),
                      decisions: normalizeLayer(rawHealth.decisions),
                    })
                  : rawHealth;
              const inputs =
                mode === "historical"
                  ? rawInputs.map((input) => ({
                      ...input,
                      dataFreshnessHours:
                        input.dataFreshnessHours === null
                          ? null
                          : Math.min(input.dataFreshnessHours, 6),
                    }))
                  : rawInputs;
              return inputs.map((creativeInput) => {
                const scopedContextMap = contextMapFor(creativeInput);
                const withKind = withCreativeCampaignLabelContext(
                  creativeInput,
                  scopedContextMap,
                );
                const decision = applyCreativeCampaignLabelGuard({
                  decision: decideCreative(withKind, profile, health),
                  input: withKind,
                  campaignLabelsById: scopedContextMap,
                });
                return { input: withKind, decision };
              });
            };

            const buildCompact = (
              pass: ReturnType<typeof decideOnce>,
              mode: "historical" | "wall_clock_stale",
              priorLabels: ReadonlyMap<
                string,
                { publishedLabel: DecisionLabel; rawLabel: DecisionLabel }
              >,
            ) =>
              pass.map(({ input, decision }) => {
                const resolvedAccount =
                  input.providerAccountId ??
                  (input.campaignId
                    ? (accountByCampaign.get(input.campaignId) ?? null)
                    : null);
                const priorKey = priorStateKey(resolvedAccount, input.creativeId);
                const previous =
                  mode === "historical"
                    ? priorLabels.get(priorKey) ?? null
                    : null;
                const stabilized =
                  mode === "historical"
                    ? stabilizeDecisionLabel(decision, previous)
                    : { decision, rawLabel: decision.label };
                const contextEntry = input.campaignId
                  ? contextMapFor(input).get(input.campaignId)
                  : undefined;
                return {
                  compact: {
                    businessId: pinned.businessId,
                    originDate,
                    freshnessMode: mode,
                    creativeId: input.creativeId,
                    campaignId: input.campaignId ?? null,
                    providerAccountId:
                      input.providerAccountId ??
                      (input.campaignId
                        ? (accountByCampaign.get(input.campaignId) ?? null)
                        : null),
                    label: stabilized.decision.label,
                    rawLabel: stabilized.rawLabel,
                    preAuthorityLabel: stabilized.decision.preAuthorityLabel ?? null,
                    authorityBlocker: stabilized.decision.authorityBlocker ?? null,
                    blockedActionType: stabilized.decision.blockedActionType ?? null,
                    confidence: stabilized.decision.confidence,
                    campaignKind: stabilized.decision.campaignKind ?? null,
                    /*
                      D086 correction 8: the CANONICAL automatic role status
                      only. The removed fallback read a manual Test/Main label
                      status, which is exactly the authority this product no
                      longer has — a replay that silently substituted it would
                      have reported label-derived roles as inferred ones.
                    */
                    campaignRoleStatus: stabilized.decision.campaignRoleStatus ?? null,
                    contextTrust: contextEntry?.contextTrust ?? null,
                    truthSource: stabilized.decision.truthSource ?? null,
                    effectiveTargetRoas: stabilized.decision.effectiveTargetRoas,
                    ratioToTarget: stabilized.decision.ratioToTarget,
                    spend: input.spend,
                    purchases: input.purchases,
                    roas: input.roas,
                    recent7dSpend: input.recent7dSpend ?? null,
                    ageDays: input.ageDays ?? null,
                    effectiveStatus: input.effectiveStatus ?? null,
                    dataFreshnessHours: input.dataFreshnessHours,
                    badges: stabilized.decision.badges.map((badge) => badge.type),
                    inputHash: sha256Canonical({
                      creativeId: input.creativeId,
                      campaignId: input.campaignId ?? null,
                      spend: input.spend,
                      purchases: input.purchases,
                      roas: input.roas,
                      recent7dRoas: input.recent7dRoas,
                      targetRoas: input.targetRoas,
                      breakevenRoas: input.breakevenRoas,
                      campaignKind: withKindOf(input),
                    }),
                  } satisfies ReplayDecisionRowCompact,
                  decision: stabilized.decision,
                };
              });

            for (const mode of ["historical", "wall_clock_stale"] as const) {
              // Determinism: TWO full decide passes in the SAME snapshot with
              // IDENTICAL prior-state inputs and no mutation in between; the
              // hash covers the COMPLETE volatile-free compact result.
              const priorSnapshot = new Map(previousLabels);
              const first = decideOnce(mode);
              const second = decideOnce(mode);
              const firstBuilt = buildCompact(first, mode, priorSnapshot);
              const secondBuilt = buildCompact(second, mode, priorSnapshot);
              const firstRows = firstBuilt.map((entry) => entry.compact);
              const secondRows = secondBuilt.map((entry) => entry.compact);
              const firstHash = sha256Canonical(firstRows);
              const secondHash = sha256Canonical(secondRows);
              if (mode === "historical") {
                for (const row of firstRows) {
                  previousLabels.set(
                    priorStateKey(row.providerAccountId, row.creativeId),
                    { publishedLabel: row.label, rawLabel: row.rawLabel },
                  );
                }
                perOriginMeta.push({
                  businessId: pinned.businessId,
                  originDate,
                  decisionCutoffUtc: `${originDate}T23:59:59.999Z`,
                  sourceMode,
                  lifecycleComputedAt,
                  inputCount: rawInputs.length,
                  profilePreset: profile.preset,
                  hardActionEligibility: profile.hardActionEligibility,
                  thresholds: {
                    commercialMaturitySpend:
                      toNumOrNull(profile.thresholds.commercialMaturitySpend),
                    hardCutSpend: toNumOrNull(profile.thresholds.hardCutSpend),
                    scaleMinPurchases:
                      toNumOrNull(profile.thresholds.scaleMinPurchases),
                  },
                  determinismHashFirst: firstHash,
                  determinismHashSecond: secondHash,
                });
              }
              // Representative REAL replay states for the UI-truth suite:
              // FULL decisions frozen (volatile keys stripped), selected
              // accounts only, first deterministic match per category.
              for (const { compact, decision } of firstBuilt) {
                if (
                  compact.providerAccountId === null ||
                  !selectedPairKeys.has(
                    `${compact.businessId}\u0000${compact.providerAccountId}`,
                  )
                ) {
                  continue;
                }
                const categories: string[] = [];
                if (mode === "historical") {
                  if (compact.label === "keep") categories.push("fresh_keep_review_only");
                  if (compact.label === "cut") categories.push("published_hard_cut");
                  if (compact.blockedActionType !== null) categories.push("held_hard_action");
                  if (compact.campaignRoleStatus === "unresolved") categories.push("unresolved_role_row");
                  if (compact.campaignRoleStatus === "resolved") categories.push("resolved_role_row");
                  if (compact.dataFreshnessHours === null) categories.push("freshness_unknown_row");
                  if (compact.label === "diagnose") categories.push("diagnose_blocked_row");
                } else if (
                  compact.rawLabel === "cut" ||
                  compact.rawLabel === "scale" ||
                  compact.blockedActionType !== null
                ) {
                  categories.push("stale_mode_hard_signal_row");
                }
                for (const category of categories) {
                  if (!uiStates.has(category)) {
                    const frozenDecision = JSON.parse(
                      JSON.stringify(decision),
                    ) as Record<string, unknown>;
                    delete frozenDecision.generatedAt;
                    delete frozenDecision.computedAt;
                    uiStates.set(category, {
                      category,
                      businessId: compact.businessId,
                      originDate: compact.originDate,
                      freshnessMode: compact.freshnessMode,
                      creativeId: compact.creativeId,
                      campaignId: compact.campaignId,
                      providerAccountId: compact.providerAccountId,
                      overallTemporalClass: "restated_retrospective",
                      evidenceLayer: "deterministic_replay_fact",
                      decision: frozenDecision,
                      inputEcho: {
                        campaignKind: compact.campaignKind,
                        spend: compact.spend,
                        purchases: compact.purchases,
                        roas: compact.roas,
                        dataFreshnessHours: compact.dataFreshnessHours,
                        effectiveStatus: compact.effectiveStatus,
                      },
                    });
                  }
                }
              }
              perOriginDecisions.push(...firstRows);
            }
          }
        }

        return {
          proofs: {
            retrievedAt: toText(proofRow?.retrieved_at),
            applicationName: toText(proofRow?.application_name),
            transactionIsolation: toText(proofRow?.transaction_isolation),
            transactionReadOnly: toText(proofRow?.transaction_read_only),
          },
          scope: {
            businesses: businessRows.map((row) => ({
              businessId: toText(row.business_id) ?? "",
              name: toText(row.name) ?? "",
              currency: toText(row.currency),
              timezone: toText(row.timezone),
              engineEnabled: true,
            })),
            accounts,
          },
          targetHistory,
          creativeDayTuples: tuples,
          campaignNamePoints: namePoints,
          campaignFirstSeen: firstSeen,
          coverage,
          originPlans,
          perOriginDecisions,
          perOriginMeta,
          persistedInference: {
            note:
              "Only account-scoped rows are consumable by the D074 runtime (readCampaignContextMap requires a matching provider_account_id); legacy null-account rows reach no decision.",
            accountScopedRowsByBusiness: Object.fromEntries(
              contextCoverage.map((row) => [
                toText(row.business_id),
                toNum(row.account_scoped_rows),
              ]),
            ),
            legacyNullAccountRowsByBusiness: Object.fromEntries(
              contextCoverage.map((row) => [
                toText(row.business_id),
                toNum(row.legacy_null_account_rows),
              ]),
            ),
            lifecycleCoverage: lifecycleCoverage.map((row) => ({
              businessId: toText(row.business_id),
              minAsOf: dayOf(row.min_as_of),
              maxAsOf: dayOf(row.max_as_of),
              rows: toNum(row.n),
            })),
          },
          primaryTimelines,
          parityTimelines,
          uiTruthStates: [...uiStates.values()].sort((a, b) =>
            String(a.category).localeCompare(String(b.category)),
          ),
        };
      },
      { timeoutMs: 60 * 60 * 1000 },
    ),
  );

  // ---- offline pure analysis ----------------------------------------------
  const frozenInputs: PitReplayFrozenInputs = {
    scope: frozen.scope,
    targetHistory: frozen.targetHistory,
    creativeDayTuples: frozen.creativeDayTuples,
    campaignNamePoints: frozen.campaignNamePoints,
    campaignFirstSeen: frozen.campaignFirstSeen,
    coverage: frozen.coverage,
    originPlans: frozen.originPlans,
    perOriginDecisions: frozen.perOriginDecisions,
    perOriginMeta: frozen.perOriginMeta,
  };
  const roleAnalysis = analyzeRoleTimelines({
    primary: frozen.primaryTimelines,
    parity: frozen.parityTimelines,
  });

  // Compact role timelines (change-points + evaluated runs) for the artifact.
  const roleTimelinesCompact = compactRoleTimelines(frozen.primaryTimelines);

  const recoverySimulation = buildRecoverySimulationSection();

  // Representative unsupported-horizon and deselected references for the
  // UI-truth suite (informational; not decision rows).
  const firstBusiness = PIT_REPLAY_BUSINESSES[0].businessId;
  const lastData =
    frozen.coverage
      .filter((cov) => cov.businessId === firstBusiness && cov.isSelected)
      .map((cov) => cov.maxDate)
      .sort()
      .pop() ?? null;
  const unsupportedHorizonExample =
    lastData === null
      ? null
      : {
          businessId: firstBusiness,
          originDate: lastData,
          horizonDays: 90,
          reason: `window ends after the last retained data day ${lastData} (ingestion stopped at the D077 fence)`,
        };
  const deselectedReference = frozen.scope.accounts.find(
    (account) => !account.isSelected,
  ) ?? null;

  const uiTruthStates = {
    note:
      "Representative REAL replay states (full volatile-stripped decisions, selected accounts only, deterministic first match per category) for the server-owned presentation authority suite. Every state is a deterministic replay fact from a restated-retrospective origin; none is causal evidence.",
    states: frozen.uiTruthStates,
    unsupportedHorizonExample,
    deselectedReference: deselectedReference
      ? {
          businessId: deselectedReference.businessId,
          providerAccountId: deselectedReference.providerAccountId,
          note: "deselected-but-assigned account: read-only history scope; excluded from every headline metric",
        }
      : null,
  };

  const artifact = assemblePitReplayArtifact({
    startedAtUtc: startedAt,
    proofs: frozen.proofs,
    frozenInputs,
    persistedInference: frozen.persistedInference,
    roleTimelinesCompact,
    roleAnalysis,
    recoverySimulation,
    uiTruthStates,
    correctionLedger: [
      {
        revision: 1,
        generatedAtUtc: "2026-08-30T17:30:59.310Z",
        outcome:
          "REJECTED by independent acceptance (correction-1 findings: false complete-PIT classification, fail-open target cross-check with wrong cutoff, stale determinism record, incomplete deselected/unscoped isolation, missing scenario/maturity evidence, synthetic-only UI truth tests, role-freshness contract gap, provenance/self-verification gaps)",
      },
      {
        revision: 2,
        note: "offline proxy-semantics reanalysis of revision 1",
        outcome: "REJECTED together with revision 1",
      },
      {
        revision: 3,
        note: "correction-1 re-extraction",
        outcome:
          "REJECTED by independent acceptance (correction-2 findings: lifetime relaunch future-leak, set-inclusion target verification conflating truth sources, incomplete protected-section manifest with hashed-but-not-rederived sections, non-composite business/account/creative grain, capture-time test not evidence of PIT safety, incomplete declared source set, report/artifact count drift)",
      },
      {
        revision: 4,
        note: "correction-1 offline re-freeze of revision 3",
        outcome: "REJECTED together with revision 3",
      },
      {
        revision: 5,
        generatedAtUtc: startedAt,
        outcome:
          "current — correction-2 re-extraction (contract v2 composite business+account grain incl. frozen businessId tuples and composite prior-state/selection/outcome scoping, origin-as-of relaunch, strict truth-source target verification, complete protected-section manifest with full rederiving verification and an honest verification contract, extended declared source set, account-aware support matrix with explicit execution grain, per-row truthSource provenance)",
      },
    ],
  });

  const selfCheck = verifyPitReplayArtifact(artifact, { checkSourceFiles: true });
  if (!selfCheck.ok) {
    throw new Error(
      `freeze self-verification failed: ${selfCheck.failures.join("; ")}`,
    );
  }

  const outPath = resolve(PIT_REPLAY_JSON_OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(artifact));
  console.log(
    JSON.stringify(
      {
        phase: "extract",
        artifactHash: artifact.artifactHash,
        decisions: frozen.perOriginDecisions.length,
        origins: frozen.perOriginMeta.length,
        tuples: frozen.creativeDayTuples.length,
        uiTruthStateCount: frozen.uiTruthStates.length,
        perOriginDoubleRunMismatches: (
          artifact.determinism as { perOriginDoubleRunMismatches: number }
        ).perOriginDoubleRunMismatches,
      },
      null,
      1,
    ),
  );
}

function withKindOf(input: { campaignKind?: string | null }): string | null {
  return input.campaignKind ?? null;
}

export function buildRecoverySimulationSection() {
  return {
    note:
      "PURE LOCAL MODEL of the D077 fence semantics — nothing was executed against production. Removable rows are UNKNOWN pending the operator planner dry-run; the reclaim scenarios below are labelled hypotheticals of the admission rule only.",
    frozenConstants: {
      rawBytes: 5_368_750_080,
      budgetBytes: 5_368_709_120,
      overageBytes: 40_960,
      ingestionRefusedSinceUtc: "2026-08-22T14:53:48Z",
      measuredRefillRate: "~0.89 GiB per 4 days pre-stop (D075 class)",
    },
    scenarios: [
      ...simulateFenceRecovery({
        rawBytes: 5_368_750_080,
        budgetBytes: 5_368_709_120,
        freeSpaceProofAvailable: false,
        provenReusableFreeBytes: null,
      }),
      ...simulateFenceRecovery({
        rawBytes: 5_368_750_080,
        budgetBytes: 5_368_709_120,
        freeSpaceProofAvailable: true,
        provenReusableFreeBytes: 0,
      }).map((scenario) => ({
        ...scenario,
        scenario: `${scenario.scenario}__no_op_compaction`,
      })),
      ...simulateFenceRecovery({
        rawBytes: 5_368_750_080,
        budgetBytes: 5_368_709_120,
        freeSpaceProofAvailable: true,
        provenReusableFreeBytes: 41_961,
      }).map((scenario) => ({
        ...scenario,
        scenario: `${scenario.scenario}__hypothetical_free_space_just_over_overage`,
      })),
      ...simulateFenceRecovery({
        rawBytes: 5_368_750_080,
        budgetBytes: 5_368_709_120,
        freeSpaceProofAvailable: true,
        provenReusableFreeBytes: 40_960,
      }).map((scenario) => ({
        ...scenario,
        scenario: `${scenario.scenario}__hypothetical_free_space_exactly_overage_boundary`,
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Artifact assembly + self-verification (shared by extract/verify/tests)
//
// VERIFICATION CONTRACT (mathematically honest): a self-contained unsigned
// artifact cannot detect an adversary who rewrites ALL raw evidence and ALL
// hashes coherently. What `verify` actually proves is (a) internal
// self-consistency over an EXACT protected-section manifest, (b) semantic
// REDERIVATION of every genuinely derived section (analysis, role
// timelines/analysis, recovery model, target verification, scenario matrix)
// from the frozen raw inputs, and (c) equality of the declared
// execution/validation source set with the frozen source hashes. Raw
// extraction evidence (tuples, per-origin engine rows, persisted-inference
// counts, transaction proofs) is EXTRACTION-ATTESTED only; its external
// trust anchor is the artifact SHA-256 published in the audit report and
// task record OUTSIDE this file. UI-truth PROJECTION checks run in the
// focused test suite (which imports the server-owned presentation adapter);
// offline `verify` checks UI states only for consistency with the frozen
// decision rows — that boundary is deliberate and stated here.
// ---------------------------------------------------------------------------

/** Declared execution/validation source set — manually declared direct
 * dependencies of the replay + validation paths (NOT a transitive build
 * graph). */
export const PROVENANCE_SOURCE_FILES = [
  "scripts/creative-decision-center/generalized-pit-replay.ts",
  "scripts/creative-decision-center/generalized-pit-replay.test.ts",
  "lib/creative-decision-engine/engine.ts",
  "lib/creative-decision-engine/data-source.ts",
  "lib/creative-decision-engine/account-decision-profile.ts",
  "lib/creative-decision-engine/feature-flags.ts",
  "lib/creative-decision-engine/data-health.ts",
  "lib/creative-decision-engine/types.ts",
  "lib/creative-decision-engine/campaign-context/resolver.ts",
  "lib/creative-decision-engine/campaign-context/data.ts",
  "lib/creative-decision-engine/campaign-context/source.ts",
  "lib/creative-decision-engine/jobs/campaign-context-job.ts",
  "lib/creative-decision-engine/campaign-label-guard.ts",
  "lib/creative-decision-engine/outcome-classifier.ts",
  "lib/creative-decision-engine/decision-stability.ts",
  "lib/meta/canonical-decision-presentation.ts",
  "lib/db.ts",
  "scripts/_operational-runtime.ts",
] as const;

function sourceFileHashes(): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of PROVENANCE_SOURCE_FILES) {
    hashes[file] = createHash("sha256")
      .update(readFileSync(resolve(file)))
      .digest("hex");
  }
  return hashes;
}

const EXTRACTION_GRAINS = [
  { name: "scope", tables: ["businesses", "business_provider_accounts", "provider_accounts", "meta_account_daily"], grain: "business + assigned meta account (composite identity)" },
  { name: "targetHistory", tables: ["business_target_pack_history"], grain: "bitemporal target revision row (id frozen for tie-order)" },
  { name: "creativeDayTuples", tables: ["meta_creative_daily"], grain: "business+account+campaign+adset+creative+date, spend>0, with restated_after_days restatement metadata" },
  { name: "campaignNamePoints", tables: ["meta_campaign_daily"], grain: "account+campaign name change-points by fact date" },
  { name: "campaignFirstSeen", tables: ["meta_campaign_daily"], grain: "account+campaign first fact date" },
  { name: "persistedInference", tables: ["engine_v3_campaign_context_daily", "engine_v3_creative_lifecycle_daily"], grain: "account-scoped vs legacy-null context row counts; lifecycle coverage per business" },
  { name: "perOrigin", tables: ["engine_v3_creative_lifecycle_daily", "warehouse as-of builders"], grain: "sampled origin per business through the production engine chain (execution grain: one run per business origin)" },
] as const;

/** EXACT top-level artifact key manifest (order-independent). Missing or
 * extra keys are verification failures. */
export const PROTECTED_TOP_LEVEL_KEYS = [
  "contract",
  "generatedAtUtc",
  "correctionLedger",
  "labelIsolation",
  "verificationContract",
  "provenance",
  "persistedInference",
  "scope",
  "targetHistory",
  "coverage",
  "creativeDayTuples",
  "campaignNamePoints",
  "campaignFirstSeen",
  "originPlans",
  "perOriginDecisions",
  "perOriginMeta",
  "roleTimelinesPrimaryNameBlind",
  "analysis",
  "roleAnalysis",
  "recoverySimulation",
  "uiTruthStates",
  "determinism",
  "protectedSectionHashes",
  "artifactHash",
] as const;

/** Cascading-rehash adversarial case names — the focused suite maps each
 * name to its mutation and a contract test proves the map covers exactly
 * this list; the machine facts derive the count from it (never
 * hand-maintained). */
export const CASCADING_ATTACK_CASE_NAMES = [
  "roleAnalysis replaced with {tampered:true}",
  "primary role timelines emptied",
  "analysis count nudged (determinism hashes also recomputed)",
  "recovery scenarios emptied",
  "UI state label flipped away from its frozen row",
  "read-only proof flipped off",
  "name-blind contract flipped",
  "persisted inference negative count",
  "ledger order reversed",
  "ledger outcome emptied",
  "verification contract text weakened",
  "base verdict weakened",
  "source manifest entry dropped",
  "extra top-level key",
  "missing top-level key",
  "attested persisted count 0 -> 999 (anchored-tier attack A)",
  "fabricated ledger verdict text (anchored-tier attack B)",
  "fabricated UI reason and badges (anchored-tier attack B)",
] as const;

const VERIFICATION_CONTRACT_TEXT = {
  tier1SemanticVerifier:
    "rederives every genuinely derived section (analysis incl. two-layer target verification and scenario matrix, role timelines, role analysis, recovery model) from the frozen raw inputs, enforces the exact protected-section manifest, semantic invariants, and declared-source hash pinning, and RETURNS the list of extraction-attested sections it cannot rederive — those are never claimed as semantically verified",
  tier2AnchoredPackageVerifier:
    "computes the evidence file's byte SHA-256 and compares it to the external anchor embedded in the report's machine-checked block; any byte mutation of attested content followed by a complete internal rehash fails this tier because the file hash no longer matches the external anchor",
  notGuaranteed:
    "a coherent rewrite of BOTH the artifact and the external report/anchor cannot be detected without a cryptographic signature or task-record anchor; there is no signature",
  externalTrustAnchor:
    "the evidence-file SHA-256 embedded in the report's machine-facts block and recorded in the task record outside this file",
  extractionAttestedOnly: [
    "creativeDayTuples/campaignNamePoints/campaignFirstSeen/targetHistory/coverage raw rows",
    "perOriginDecisions/perOriginMeta engine outputs (incl. full UI decision payloads: reason/badges are NOT rederivable from frozen inputs)",
    "persistedInference counts (schema-checked only; positive values protected ONLY by the anchored package tier)",
    "correctionLedger text (authored audit evidence; protected ONLY by the anchored package tier)",
    "provenance transaction proofs (semantic-invariant-checked only)",
  ],
  uiProjectionBoundary:
    "offline verify checks each frozen UI state for consistency with its frozen decision row (identity/label/blockedActionType); full decision reason/badges are byte-anchored only; the server-owned presentation PROJECTION assertions run in the focused test suite, which imports lib/meta/canonical-decision-presentation.ts",
} as const;

/** Composite prior-decision-state key: creative IDs are only unique within
 * a provider account, so the stabilization chain must never collide across
 * accounts (or across businesses via the account pair). */
export function priorStateKey(
  providerAccountId: string | null,
  creativeId: string,
): string {
  return `${providerAccountId ?? ""}\u0000${creativeId}`;
}

export function roleDaysForCoverage(cov: {
  minDate: string;
  maxDate: string;
}): string[] {
  const days: string[] = [];
  if (!cov.minDate || !cov.maxDate) return days;
  for (
    let day = addDaysUtc(cov.minDate, 27);
    day <= cov.maxDate;
    day = addDaysUtc(day, 1)
  ) {
    days.push(day);
  }
  return days;
}

export function compactRoleTimelines(
  timelinesByScope: Map<string, Map<string, RoleTimeline>>,
) {
  return [...timelinesByScope.entries()].sort().map(([scopeKey, timelines]) => {
    const [businessId, accountId] = scopeKey.split("\u0000");
    return {
      businessId,
      accountId,
      campaigns: [...timelines.entries()]
        .sort()
        .map(([campaignId, timeline]) => ({
          campaignId,
          daysEvaluated: timeline.daysEvaluated,
          evaluatedRuns: timeline.evaluatedRuns,
          points: timeline.points,
        })),
    };
  });
}

/** Rebuild BOTH role-timeline families from the frozen raw inputs (the
 * verifier's rederivation path — never trusts stored timelines). */
export function rebuildRoleTimelines(inputs: PitReplayFrozenInputs): {
  primary: Map<string, Map<string, RoleTimeline>>;
  parity: Map<string, Map<string, RoleTimeline>>;
} {
  const primary = new Map<string, Map<string, RoleTimeline>>();
  const parity = new Map<string, Map<string, RoleTimeline>>();
  for (const cov of inputs.coverage) {
    const days = roleDaysForCoverage(cov);
    if (days.length === 0) continue;
    const key = `${cov.businessId}\u0000${cov.providerAccountId}`;
    const common = {
      tuples: inputs.creativeDayTuples,
      namePoints: inputs.campaignNamePoints,
      firstSeen: inputs.campaignFirstSeen,
      businessId: cov.businessId,
      accountId: cov.providerAccountId,
      days,
    };
    primary.set(key, buildRoleTimelines({ ...common, nameBlind: true }));
    parity.set(key, buildRoleTimelines({ ...common, nameBlind: false }));
  }
  return { primary, parity };
}

export function assemblePitReplayArtifact(input: {
  startedAtUtc: string;
  proofs: Record<string, unknown>;
  frozenInputs: PitReplayFrozenInputs;
  persistedInference: unknown;
  roleTimelinesCompact: unknown;
  roleAnalysis: unknown;
  recoverySimulation: unknown;
  uiTruthStates: unknown;
  correctionLedger: unknown[];
}) {
  const analysisFirst = analyzePitReplay(input.frozenInputs);
  const analysisSecond = analyzePitReplay(input.frozenInputs);
  const analysisHashFirst = sha256Canonical(analysisFirst);
  const analysisHashSecond = sha256Canonical(analysisSecond);
  if (analysisHashFirst !== analysisHashSecond) {
    throw new Error("pure analysis is non-deterministic — refusing to freeze");
  }
  const artifact: Record<string, unknown> = {
    contract: PIT_REPLAY_CONTRACT_VERSION,
    generatedAtUtc: input.startedAtUtc,
    correctionLedger: input.correctionLedger,
    labelIsolation: {
      manualLabelTablesRead: false,
      manualLabelComparatorIncluded: false,
      primaryInferenceNameBlind: true,
      note:
        "Neither manual campaign-label table (current or history) is read anywhere in this runner; primary role inference nulls campaign names before feature building; the production-parity secondary (names included) is a diagnostic only.",
    },
    // Deep-cloned: the artifact must never alias the compiled contract
    // object, or a mutation of the artifact would mutate the baseline the
    // verifier compares against.
    verificationContract: JSON.parse(
      JSON.stringify(VERIFICATION_CONTRACT_TEXT),
    ) as typeof VERIFICATION_CONTRACT_TEXT,
    provenance: {
      ...input.proofs,
      startedAtUtc: input.startedAtUtc,
      resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      outcomeClassifierVersion: CREATIVE_OUTCOME_CLASSIFIER_VERSION,
      horizonsDays: [...PIT_REPLAY_HORIZONS_DAYS],
      extractionGrains: JSON.parse(JSON.stringify(EXTRACTION_GRAINS)) as typeof EXTRACTION_GRAINS,
      sourceFileSha256AtFreeze: sourceFileHashes(),
      baseComparison: {
        baseSha: "babf158e150fd33057117b39b175da044ac62d2e",
        baseEngineReplaySupported: false,
        reason:
          "the candidate worktree changes the engine input contract itself; frozen candidate-shaped inputs are not valid base inputs, and exact isolated reproduction is not available — marked unsupported rather than approximated",
      },
    },
    persistedInference: input.persistedInference,
    scope: input.frozenInputs.scope,
    targetHistory: input.frozenInputs.targetHistory,
    coverage: input.frozenInputs.coverage,
    creativeDayTuples: input.frozenInputs.creativeDayTuples,
    campaignNamePoints: input.frozenInputs.campaignNamePoints,
    campaignFirstSeen: input.frozenInputs.campaignFirstSeen,
    originPlans: input.frozenInputs.originPlans,
    perOriginDecisions: input.frozenInputs.perOriginDecisions,
    perOriginMeta: input.frozenInputs.perOriginMeta,
    roleTimelinesPrimaryNameBlind: input.roleTimelinesCompact,
    analysis: analysisFirst,
    roleAnalysis: input.roleAnalysis,
    recoverySimulation: input.recoverySimulation,
    uiTruthStates: input.uiTruthStates,
    determinism: {
      pureAnalysisHashFirst: analysisHashFirst,
      pureAnalysisHashSecond: analysisHashSecond,
      perOriginDoubleRunMismatches: input.frozenInputs.perOriginMeta.filter(
        (meta) => meta.determinismHashFirst !== meta.determinismHashSecond,
      ).length,
    },
  };
  const protectedSectionHashes: Record<string, string> = {};
  for (const key of PROTECTED_TOP_LEVEL_KEYS) {
    if (key === "protectedSectionHashes" || key === "artifactHash") continue;
    protectedSectionHashes[key] = sha256Canonical(artifact[key]);
  }
  artifact.protectedSectionHashes = protectedSectionHashes;
  artifact.artifactHash = sha256Canonical(protectedSectionHashes);
  return artifact;
}

/** FULL fail-closed verification per the VERIFICATION CONTRACT above. */
export const EXTRACTION_ATTESTED_SECTIONS = [
  "scope",
  "targetHistory",
  "coverage",
  "creativeDayTuples",
  "campaignNamePoints",
  "campaignFirstSeen",
  "originPlans",
  "perOriginDecisions",
  "perOriginMeta",
  "persistedInference",
  "uiTruthStates",
  "correctionLedger",
  "provenance",
  "labelIsolation",
  "generatedAtUtc",
  "contract",
] as const;

/**
 * PRE-DEPLOY AUDIT — the verifier's rederivation memo.
 *
 * `verifyPitReplayArtifact` re-derives three sections from the artifact's
 * FROZEN INPUTS, and `analyzePitReplay` over the real 44 MB package costs
 * about ninety seconds. The adversarial suites call the verifier repeatedly
 * with artifacts that differ only in ATTESTED bytes — `persistedInference`,
 * `correctionLedger`, `uiTruthStates` — none of which is a frozen input, so
 * every one of those calls recomputed a byte-identical answer. That is where
 * this file's eleven-minute runtime came from.
 *
 * The memo is keyed by the canonical hash of the frozen inputs themselves, so
 * it can only return an answer for inputs that are byte-identical to the ones
 * it was computed from — the defining property of the pure function it wraps,
 * which the artifact's own double-run determinism proof asserts separately.
 * It stores three HASHES, not the analyses, so it cannot hand a caller a
 * mutable object either.
 *
 * It is used ONLY by the verifier. The freeze path's determinism proof calls
 * `analyzePitReplay` twice, directly and uncached, and must keep doing so:
 * caching there would make the second run trivially equal to the first and
 * turn a real proof into a tautology.
 */
const VERIFIER_REDERIVATION_MEMO = new Map<
  string,
  { analysisHash: string; compactTimelinesHash: string; roleAnalysisHash: string }
>();

export function verifyPitReplayArtifact(
  artifact: Record<string, unknown>,
  options?: { checkSourceFiles?: boolean },
): {
  ok: boolean;
  failures: string[];
  attestedSections: readonly string[];
  recomputedAnalysisHash: string;
} {
  const failures: string[] = [];

  // ---- exact protected manifest (missing/extra keys rejected) -----------
  const topKeys = Object.keys(artifact).sort().join(",");
  const expectedKeys = [...PROTECTED_TOP_LEVEL_KEYS].sort().join(",");
  if (topKeys !== expectedKeys) {
    failures.push(
      `top-level key manifest mismatch (got [${topKeys}] expected [${expectedKeys}])`,
    );
  }
  const storedHashes =
    (artifact.protectedSectionHashes as Record<string, string>) ?? {};
  for (const key of PROTECTED_TOP_LEVEL_KEYS) {
    if (key === "protectedSectionHashes" || key === "artifactHash") continue;
    if (!(key in artifact)) {
      failures.push(`protected section missing: ${key}`);
      continue;
    }
    if (storedHashes[key] !== sha256Canonical(artifact[key])) {
      failures.push(`protectedSectionHashes.${key} stale`);
    }
  }
  if (
    Object.keys(storedHashes).sort().join(",") !==
    [...PROTECTED_TOP_LEVEL_KEYS]
      .filter((key) => key !== "protectedSectionHashes" && key !== "artifactHash")
      .sort()
      .join(",")
  ) {
    failures.push("protectedSectionHashes key set mismatch");
  }
  if (artifact.artifactHash !== sha256Canonical(storedHashes)) {
    failures.push("artifactHash stale");
  }

  // ---- frozen inputs + full rederivation of derived sections ------------
  const frozenInputs = {
    scope: artifact.scope,
    targetHistory: artifact.targetHistory,
    creativeDayTuples: artifact.creativeDayTuples,
    campaignNamePoints: artifact.campaignNamePoints,
    campaignFirstSeen: artifact.campaignFirstSeen,
    coverage: artifact.coverage,
    originPlans: artifact.originPlans,
    perOriginDecisions: artifact.perOriginDecisions,
    perOriginMeta: artifact.perOriginMeta,
  } as unknown as PitReplayFrozenInputs;

  /*
    One rederivation per distinct set of frozen inputs. @see
    VERIFIER_REDERIVATION_MEMO for why this is sound and where it must NOT be
    used. The key is the inputs' own canonical hash, which costs about a
    tenth of a second against ninety seconds of analysis.
  */
  const frozenInputsKey = sha256Canonical(frozenInputs);
  let memo = VERIFIER_REDERIVATION_MEMO.get(frozenInputsKey);
  if (!memo) {
    const rebuiltForMemo = rebuildRoleTimelines(frozenInputs);
    memo = {
      analysisHash: sha256Canonical(analyzePitReplay(frozenInputs)),
      compactTimelinesHash: sha256Canonical(compactRoleTimelines(rebuiltForMemo.primary)),
      roleAnalysisHash: sha256Canonical(analyzeRoleTimelines({
        primary: rebuiltForMemo.primary,
        parity: rebuiltForMemo.parity,
      })),
    };
    VERIFIER_REDERIVATION_MEMO.set(frozenInputsKey, memo);
  }
  const recomputedAnalysisHash = memo.analysisHash;
  const storedAnalysisHash = sha256Canonical(artifact.analysis);
  if (recomputedAnalysisHash !== storedAnalysisHash) {
    failures.push("analysis does not re-derive from frozen inputs");
  }
  const determinism = (artifact.determinism as Record<string, unknown>) ?? {};
  if (determinism.pureAnalysisHashFirst !== storedAnalysisHash) {
    failures.push("determinism.pureAnalysisHashFirst stale");
  }
  if (determinism.pureAnalysisHashSecond !== storedAnalysisHash) {
    failures.push("determinism.pureAnalysisHashSecond stale");
  }
  const perOriginMeta =
    (artifact.perOriginMeta as Array<{
      determinismHashFirst: string;
      determinismHashSecond: string;
    }>) ?? [];
  const recountedMismatches = perOriginMeta.filter(
    (meta) => meta.determinismHashFirst !== meta.determinismHashSecond,
  ).length;
  if (determinism.perOriginDoubleRunMismatches !== recountedMismatches) {
    failures.push("determinism.perOriginDoubleRunMismatches stale");
  }
  if (recountedMismatches !== 0) {
    failures.push("per-origin double-run mismatches present");
  }

  // Role timelines + role analysis: REBUILT from frozen raw inputs, never
  // trusted from storage.
  if (
    memo.compactTimelinesHash !==
    sha256Canonical(artifact.roleTimelinesPrimaryNameBlind)
  ) {
    failures.push(
      "roleTimelinesPrimaryNameBlind does not re-derive from frozen inputs",
    );
  }
  if (memo.roleAnalysisHash !== sha256Canonical(artifact.roleAnalysis)) {
    failures.push("roleAnalysis does not re-derive from frozen inputs");
  }

  // Recovery model: pure constants — rederive and compare.
  if (
    sha256Canonical(buildRecoverySimulationSection()) !==
    sha256Canonical(artifact.recoverySimulation)
  ) {
    failures.push("recoverySimulation does not re-derive");
  }

  // UI states: consistency with frozen decision rows (projection assertions
  // live in the focused suite — see VERIFICATION CONTRACT).
  const uiStates =
    ((artifact.uiTruthStates as { states?: Array<Record<string, unknown>> })
      ?.states as Array<Record<string, unknown>>) ?? [];
  if (uiStates.length === 0) {
    failures.push("uiTruthStates.states empty");
  }
  const decisionRows =
    (artifact.perOriginDecisions as ReplayDecisionRowCompact[]) ?? [];
  const rowIndex = new Map(
    decisionRows.map((row) => [
      `${row.businessId}\u0000${row.providerAccountId}\u0000${row.originDate}\u0000${row.freshnessMode}\u0000${row.creativeId}`,
      row,
    ]),
  );
  for (const state of uiStates) {
    const key = `${state.businessId}\u0000${state.providerAccountId}\u0000${state.originDate}\u0000${state.freshnessMode}\u0000${state.creativeId}`;
    const row = rowIndex.get(key);
    if (!row) {
      failures.push(`uiTruthStates: no frozen decision row for ${String(state.category)}`);
      continue;
    }
    const decision = (state.decision as Record<string, unknown>) ?? {};
    if (decision.label !== row.label) {
      failures.push(`uiTruthStates.${String(state.category)}: label diverges from frozen row`);
    }
    if ((decision.blockedActionType ?? null) !== row.blockedActionType) {
      failures.push(
        `uiTruthStates.${String(state.category)}: blockedActionType diverges from frozen row`,
      );
    }
  }

  // ---- semantic invariants ---------------------------------------------
  const provenance = (artifact.provenance as Record<string, unknown>) ?? {};
  if (provenance.transactionReadOnly !== "on") {
    failures.push("provenance.transactionReadOnly must be 'on'");
  }
  if (provenance.transactionIsolation !== "repeatable read") {
    failures.push("provenance.transactionIsolation must be 'repeatable read'");
  }
  if (typeof provenance.applicationName !== "string" || !provenance.applicationName) {
    failures.push("provenance.applicationName missing");
  }
  const labelIsolation = (artifact.labelIsolation as Record<string, unknown>) ?? {};
  if (
    labelIsolation.manualLabelTablesRead !== false ||
    labelIsolation.manualLabelComparatorIncluded !== false ||
    labelIsolation.primaryInferenceNameBlind !== true
  ) {
    failures.push("labelIsolation contract violated");
  }
  const persisted = (artifact.persistedInference as Record<string, unknown>) ?? {};
  for (const field of [
    "accountScopedRowsByBusiness",
    "legacyNullAccountRowsByBusiness",
  ]) {
    const counts = persisted[field] as Record<string, unknown> | undefined;
    if (!counts || typeof counts !== "object") {
      failures.push(`persistedInference.${field} missing`);
      continue;
    }
    for (const [businessId, value] of Object.entries(counts)) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        failures.push(`persistedInference.${field}.${businessId} not a non-negative int`);
      }
    }
  }
  const ledger = artifact.correctionLedger;
  if (!Array.isArray(ledger) || ledger.length === 0) {
    failures.push("correctionLedger missing");
  } else {
    const revisions = ledger.map((entry) =>
      Number((entry as { revision?: unknown }).revision ?? Number.NaN),
    );
    if (revisions.some((revision) => !Number.isFinite(revision) || revision <= 0)) {
      failures.push("correctionLedger has a non-positive/non-numeric revision");
    } else if (
      revisions.some((revision, index) => index > 0 && revision <= revisions[index - 1])
    ) {
      failures.push("correctionLedger revisions not strictly increasing");
    }
    for (const entry of ledger) {
      const outcome = (entry as { outcome?: unknown }).outcome;
      if (typeof outcome !== "string" || outcome.length === 0) {
        failures.push("correctionLedger entry lacks an outcome");
        break;
      }
    }
  }
  if (
    sha256Canonical(artifact.verificationContract) !==
    sha256Canonical(VERIFICATION_CONTRACT_TEXT)
  ) {
    failures.push("verificationContract text drifted from the compiled contract");
  }
  const base = (provenance.baseComparison as Record<string, unknown>) ?? {};
  if (base.baseEngineReplaySupported !== false) {
    failures.push("baseComparison must remain honestly unsupported");
  }
  const frozenSourceHashes =
    (provenance.sourceFileSha256AtFreeze as Record<string, string>) ?? {};
  if (
    Object.keys(frozenSourceHashes).sort().join(",") !==
    [...PROVENANCE_SOURCE_FILES].sort().join(",")
  ) {
    failures.push("sourceFileSha256AtFreeze manifest mismatch");
  }
  if (options?.checkSourceFiles) {
    const current = sourceFileHashes();
    for (const file of PROVENANCE_SOURCE_FILES) {
      if (frozenSourceHashes[file] !== current[file]) {
        failures.push(`source drift since freeze: ${file}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    attestedSections: EXTRACTION_ATTESTED_SECTIONS,
    recomputedAnalysisHash,
  };
}

/** Tier-2 ANCHORED PACKAGE verification: the evidence file's byte SHA-256
 * must equal the external anchor embedded in the report's machine-checked
 * block. Protects attested bytes (persisted counts, ledger text, full UI
 * payloads) that the semantic tier honestly cannot rederive. A coherent
 * rewrite of BOTH files is out of scope (no signature). */
export function verifyAnchoredPackage(input: {
  artifactPath: string;
  reportPath: string;
}): {
  ok: boolean;
  failures: string[];
  computedEvidenceFileSha256: string;
  anchoredEvidenceFileSha256: string | null;
} {
  const failures: string[] = [];
  const computed = createHash("sha256")
    .update(readFileSync(input.artifactPath))
    .digest("hex");
  const report = readFileSync(input.reportPath, "utf8");
  const match = report.match(/"evidenceFileSha256Anchor":\s*"([0-9a-f]{64})"/);
  const anchored = match ? match[1] : null;
  if (anchored === null) {
    failures.push("report lacks the evidenceFileSha256Anchor in its machine-facts block");
  } else if (anchored !== computed) {
    failures.push(
      `evidence file bytes do not match the external anchor (computed ${computed}, anchored ${anchored})`,
    );
  }
  if (!report.includes("<!-- MACHINE-FACTS BEGIN")) {
    failures.push("report lacks the machine-facts block markers");
  }
  return {
    ok: failures.length === 0,
    failures,
    computedEvidenceFileSha256: computed,
    anchoredEvidenceFileSha256: anchored,
  };
}

// ---------------------------------------------------------------------------
// Verify phase (offline; no DB)
// ---------------------------------------------------------------------------

async function runVerify() {
  const artifact = JSON.parse(
    readFileSync(resolve(PIT_REPLAY_JSON_OUT), "utf8"),
  ) as Record<string, unknown>;
  const result = verifyPitReplayArtifact(artifact, { checkSourceFiles: true });
  console.log(
    JSON.stringify(
      {
        phase: "verify",
        tier: "semantic",
        ok: result.ok,
        failures: result.failures,
        attestedSectionsNotSemanticallyVerified: result.attestedSections,
        recomputedAnalysisHash: result.recomputedAnalysisHash,
        artifactHash: artifact.artifactHash,
      },
      null,
      1,
    ),
  );
  if (!result.ok) process.exitCode = 1;
}

/** Offline ATOMIC re-freeze: rebuilds the complete artifact — analysis,
 * determinism, every section/result hash — from the artifact's own frozen
 * inputs and retained result sections via the same assembly path the
 * extractor uses, appends a ledger revision, and self-verifies before
 * writing. No database access; frozen inputs are byte-unchanged. */
async function runRefreeze() {
  const artifactPath = resolve(PIT_REPLAY_JSON_OUT);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
  const provenance = artifact.provenance as Record<string, unknown>;
  const frozenInputs = {
    scope: artifact.scope,
    targetHistory: artifact.targetHistory,
    creativeDayTuples: artifact.creativeDayTuples,
    campaignNamePoints: artifact.campaignNamePoints,
    campaignFirstSeen: artifact.campaignFirstSeen,
    coverage: artifact.coverage,
    originPlans: artifact.originPlans,
    perOriginDecisions: artifact.perOriginDecisions,
    perOriginMeta: artifact.perOriginMeta,
  } as unknown as PitReplayFrozenInputs;
  const priorLedger = (artifact.correctionLedger as Array<{ revision: number }>) ?? [];
  const nextRevision =
    priorLedger.reduce((max, entry) => Math.max(max, Number(entry.revision) || 0), 0) + 1;
  const reassembled = assemblePitReplayArtifact({
    startedAtUtc: String(artifact.generatedAtUtc),
    proofs: {
      retrievedAt: provenance.retrievedAt,
      applicationName: provenance.applicationName,
      transactionIsolation: provenance.transactionIsolation,
      transactionReadOnly: provenance.transactionReadOnly,
    },
    frozenInputs,
    persistedInference: artifact.persistedInference,
    roleTimelinesCompact: artifact.roleTimelinesPrimaryNameBlind,
    roleAnalysis: artifact.roleAnalysis,
    recoverySimulation: buildRecoverySimulationSection(),
    uiTruthStates: artifact.uiTruthStates,
    correctionLedger: [
      ...priorLedger,
      {
        revision: nextRevision,
        outcome:
          process.env.PIT_REPLAY_REFREEZE_REASON ??
          "offline atomic re-freeze from unchanged frozen inputs",
      },
    ],
  });
  const selfCheck = verifyPitReplayArtifact(
    reassembled as unknown as Record<string, unknown>,
    { checkSourceFiles: true },
  );
  if (!selfCheck.ok) {
    throw new Error(`refreeze self-verification failed: ${selfCheck.failures.join("; ")}`);
  }
  writeFileSync(artifactPath, JSON.stringify(reassembled));
  console.log(
    JSON.stringify(
      {
        phase: "refreeze",
        revision: nextRevision,
        artifactHash: reassembled.artifactHash,
      },
      null,
      1,
    ),
  );
}

const REPORT_PATH = "docs/audits/GENERALIZED_PIT_REPLAY_2026-08-30.md";

/** Pure fail-closed v2→v3 row migration: businessId is derived from the
 * frozen scope ONLY when the account maps to exactly one business; a
 * missing or ambiguous mapping throws. Raw values are preserved. */
export function migrateNameRowsToV3(input: {
  scopeAccounts: Array<{ businessId: string; providerAccountId: string }>;
  namePoints: Array<Record<string, unknown>>;
  firstSeen: Array<Record<string, unknown>>;
}): {
  namePoints: Array<Record<string, unknown>>;
  firstSeen: Array<Record<string, unknown>>;
} {
  const businessesByAccount = new Map<string, Set<string>>();
  for (const account of input.scopeAccounts) {
    const set = businessesByAccount.get(account.providerAccountId) ?? new Set<string>();
    set.add(account.businessId);
    businessesByAccount.set(account.providerAccountId, set);
  }
  const businessFor = (accountId: string, context: string): string => {
    const set = businessesByAccount.get(accountId);
    if (!set || set.size === 0) {
      throw new Error(
        `v2→v3 migration FAIL-CLOSED: ${context} account ${accountId} has no business mapping in frozen scope`,
      );
    }
    if (set.size > 1) {
      throw new Error(
        `v2→v3 migration FAIL-CLOSED: ${context} account ${accountId} maps to multiple businesses (${[...set].sort().join(",")})`,
      );
    }
    return [...set][0];
  };
  return {
    namePoints: input.namePoints.map((point) => ({
      businessId: businessFor(String(point.accountId), "campaignNamePoints"),
      accountId: point.accountId,
      campaignId: point.campaignId,
      date: point.date,
      campaignName: point.campaignName,
    })),
    firstSeen: input.firstSeen.map((row) => ({
      businessId: businessFor(String(row.accountId), "campaignFirstSeen"),
      accountId: row.accountId,
      campaignId: row.campaignId,
      firstSeenDate: row.firstSeenDate,
    })),
  };
}

/** Offline fail-closed v2→v3 migration + refreeze. Adds businessId to the
 * frozen campaignNamePoints/campaignFirstSeen rows by mapping each
 * accountId through the frozen scope — ONLY when the account maps to
 * exactly one business; a missing or ambiguous mapping aborts. All raw
 * values and counts are preserved; the artifact is re-assembled (derived
 * sections rederive under the corrected code) and self-verified. ZERO
 * database access. */
async function runMigrateV3() {
  const artifactPath = resolve(PIT_REPLAY_JSON_OUT);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
  if (artifact.contract === PIT_REPLAY_CONTRACT_VERSION) {
    throw new Error("artifact is already contract v3 — refusing to double-migrate");
  }
  const scope = artifact.scope as {
    accounts: Array<{ businessId: string; providerAccountId: string }>;
  };
  const { namePoints, firstSeen } = migrateNameRowsToV3({
    scopeAccounts: scope.accounts,
    namePoints: artifact.campaignNamePoints as Array<Record<string, unknown>>,
    firstSeen: artifact.campaignFirstSeen as Array<Record<string, unknown>>,
  });
  const frozenInputs = {
    scope: artifact.scope,
    targetHistory: artifact.targetHistory,
    creativeDayTuples: artifact.creativeDayTuples,
    campaignNamePoints: namePoints,
    campaignFirstSeen: firstSeen,
    coverage: artifact.coverage,
    originPlans: artifact.originPlans,
    perOriginDecisions: artifact.perOriginDecisions,
    perOriginMeta: artifact.perOriginMeta,
  } as unknown as PitReplayFrozenInputs;
  const provenance = artifact.provenance as Record<string, unknown>;
  const priorLedger = artifact.correctionLedger as Array<{ revision: number }>;
  const rebuilt = rebuildRoleTimelines(frozenInputs);
  const reassembled = assemblePitReplayArtifact({
    startedAtUtc: String(artifact.generatedAtUtc),
    proofs: {
      retrievedAt: provenance.retrievedAt,
      applicationName: provenance.applicationName,
      transactionIsolation: provenance.transactionIsolation,
      transactionReadOnly: provenance.transactionReadOnly,
    },
    frozenInputs,
    persistedInference: artifact.persistedInference,
    roleTimelinesCompact: compactRoleTimelines(rebuilt.primary),
    roleAnalysis: analyzeRoleTimelines(rebuilt),
    recoverySimulation: buildRecoverySimulationSection(),
    uiTruthStates: artifact.uiTruthStates,
    correctionLedger: [
      ...priorLedger,
      {
        revision: 6,
        outcome:
          "Correction 2 (revision 5) REJECTED by independent acceptance: target 'exact' still reproduced the rejected [0, expected] mixed-value pattern by filtering to target-claiming rows (19 of 20 target-present origins were mixed; only 1 all-row singleton) with no observed row-id/version provenance frozen; attested sections (persisted counts, ledger text, full UI payloads) still passed cascading rehash and the claimed external file-SHA anchor was absent from the report; business/account grain remained incomplete (name points/first-seen/meta filter/context map/freshness-flip-denominator/UI keys); declared source set omitted lib/db.ts and scripts/_operational-runtime.ts; report claimed 16 cascading cases vs 15 in code",
      },
      {
        revision: 7,
        outcome:
          "current — Correction 3 OFFLINE migration/refreeze (zero DB reads): contract v3 with businessId on name/first-seen rows (fail-closed unique account→business mapping), two-layer target verification (authoritative selection/version evidence with version-proven count honestly zero + per-decision all-row consumption classes where [0, expected] is mixed, never exact), two-tier verification contract (semantic rederivation + anchored package file-SHA against the report's embedded anchor), completed composite keys (meta/context/freshness/flip/denominator/UI/rowRef), declared source set extended to include lib/db.ts and scripts/_operational-runtime.ts, generated cascading-case count",
      },
    ],
  });
  const selfCheck = verifyPitReplayArtifact(
    reassembled as unknown as Record<string, unknown>,
    { checkSourceFiles: true },
  );
  if (!selfCheck.ok) {
    throw new Error(`v3 migration self-verification failed: ${selfCheck.failures.join("; ")}`);
  }
  writeFileSync(artifactPath, JSON.stringify(reassembled));
  console.log(
    JSON.stringify(
      {
        phase: "migrate-v3",
        contract: reassembled.contract,
        artifactHash: reassembled.artifactHash,
        ledgerRevisions: (reassembled.correctionLedger as Array<{ revision: number }>).map(
          (entry) => entry.revision,
        ),
      },
      null,
      1,
    ),
  );
}

async function runVerifyPackage() {
  const result = verifyAnchoredPackage({
    artifactPath: resolve(PIT_REPLAY_JSON_OUT),
    reportPath: resolve(REPORT_PATH),
  });
  console.log(JSON.stringify({ phase: "verify-package", tier: "anchored", ...result }, null, 1));
  if (!result.ok) process.exitCode = 1;
}

/** Machine-verifiable report facts: every headline denominator the report
 * may quote, derived from the artifact. The focused suite regenerates this
 * block and fails when the report's embedded copy disagrees. */
export function buildReportFacts(artifact: Record<string, unknown>) {
  const analysis = artifact.analysis as ReturnType<typeof analyzePitReplay>;
  const uiStates =
    ((artifact.uiTruthStates as { states?: unknown[] })?.states ?? []) as unknown[];
  const ledger = (artifact.correctionLedger as Array<{ revision: number }>) ?? [];
  return {
    contract: artifact.contract,
    artifactHash: artifact.artifactHash,
    currentRevision: ledger.reduce(
      (max, entry) => Math.max(max, Number(entry.revision) || 0),
      0,
    ),
    origins: (artifact.perOriginMeta as unknown[]).length,
    decisionRowsAllModesAllAccounts: (artifact.perOriginDecisions as unknown[]).length,
    tuples: (artifact.creativeDayTuples as unknown[]).length,
    decisionLayer: analysis.decisionLayer,
    appendix: analysis.appendix,
    temporalCounts: analysis.temporalIntegrity.temporalCounts,
    targetVerification: {
      layer1SelectionVersion:
        analysis.temporalIntegrity.targetVerification.layer1SelectionVersion
          .denominators,
      layer2Consumption:
        analysis.temporalIntegrity.targetVerification.layer2Consumption
          .denominators,
    },
    cascadingAdversarialCaseCount: CASCADING_ATTACK_CASE_NAMES.length,
    sourceManifestFileCount: PROVENANCE_SOURCE_FILES.length,
    sourceManifestFiles: [...PROVENANCE_SOURCE_FILES],
    outcome: {
      matureEvaluatedCells: analysis.outcomeLayer.matureEvaluatedCells,
      immatureEmbargoedCells: analysis.outcomeLayer.immatureEmbargoedCells,
      unsupportedDecisionHorizonCells:
        analysis.outcomeLayer.unsupportedDecisionHorizonCells,
      proxies: analysis.outcomeLayer.proxies,
    },
    flipMetrics: analysis.flipMetrics,
    scenarioCells: analysis.scenarioMatrix.length,
    scenarioUnsupportedCells: analysis.scenarioMatrix.filter(
      (cell) => !cell.supported,
    ).length,
    relaunchAsOfRows:
      analysis.scenarioMatrix.find(
        (cell) => cell.cell === "relaunched_after_14d_spend_gap_as_of_origin",
      )?.count ?? null,
    supportMatrix: analysis.supportMatrix,
    accountBusinessCardinality: analysis.accountBusinessCardinality,
    roleAnalysisPerAccount: (artifact.roleAnalysis as { perAccount: unknown[] })
      .perAccount,
    uiTruthStateCount: uiStates.length,
    persistedInference: artifact.persistedInference,
  };
}

export const REPORT_FACTS_BEGIN = "<!-- MACHINE-FACTS BEGIN (generated by generalized-pit-replay.ts report-facts; do not hand-edit) -->";
export const REPORT_FACTS_END = "<!-- MACHINE-FACTS END -->";

export function renderReportFactsBlock(
  artifact: Record<string, unknown>,
  artifactFilePath: string,
): string {
  const facts = {
    ...buildReportFacts(artifact),
    evidenceFileSha256Anchor: createHash("sha256")
      .update(readFileSync(artifactFilePath))
      .digest("hex"),
    attestedSectionsNotSemanticallyVerified: EXTRACTION_ATTESTED_SECTIONS,
  };
  return `${REPORT_FACTS_BEGIN}\n\n\u0060\u0060\u0060json\n${JSON.stringify(facts, null, 1)}\n\u0060\u0060\u0060\n\n${REPORT_FACTS_END}`;
}

async function runReportFacts() {
  const artifact = JSON.parse(
    readFileSync(resolve(PIT_REPLAY_JSON_OUT), "utf8"),
  ) as Record<string, unknown>;
  process.stdout.write(
    `${renderReportFactsBlock(artifact, resolve(PIT_REPLAY_JSON_OUT))}\n`,
  );
}

const isMain =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1] as string)).href === import.meta.url;

if (isMain) {
  const phase = process.argv[2];
  const run =
    phase === "extract"
      ? runExtract
      : phase === "verify"
        ? runVerify
        : phase === "verify-package"
          ? runVerifyPackage
          : phase === "migrate-v3"
            ? runMigrateV3
            : phase === "refreeze"
              ? runRefreeze
              : phase === "report-facts"
                ? runReportFacts
                : null;
  if (!run) {
    console.error(
      "usage: generalized-pit-replay.ts extract | verify | verify-package | migrate-v3 | refreeze | report-facts",
    );
    process.exit(2);
  }
  run()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      process.exit(1);
    });
}
