/**
 * AN UNMEASURED EDIT AGE MUST NOT AUTHORISE SPEND.
 *
 * ── ROUND 12 ────────────────────────────────────────────────────────────────
 * Round 11 scoped the config-history window to the entity's own provider
 * account and bounded it by that account's calendar, then asserted — in a code
 * comment, in `entity-signals-backfill.sql-scope.test.ts` and in
 * `docs/meta-decision-center/DATA_READINESS.md` — that an account with no
 * trusted timezone FAILS CLOSED. It did not. The old test proved only that no
 * SQL ran; nothing proved the resulting decision was held, and it was not:
 *
 *   - `qualityStatusFor` calls a pack "ready" at ANY THREE non-null signals out
 *     of six, and `lastSignificantEditAt` is one of the six. A learning state,
 *     a frequency p80 and a CTR decay reach "ready" without it.
 *   - `blocksPurchaseHardAction` tests `daysSinceSignificantEdit != null && < 7`
 *     and `recentEditCooldownActive` tests the same field the same way. Null is
 *     not `< 7`, so a never-measured edit age passed both.
 *
 * So the withheld window produced a signal that LOOKED complete and authorised
 * purchase-budget Scale / Cut / Refresh.
 *
 * ## What these tests assert, and why they run end to end
 *
 * Every case below drives the REAL `runMetaSignalsBackfillForBusiness` against
 * a mocked database, captures the signals it actually writes, and feeds those
 * exact signals into the REAL decision builders. A predicate-only test would
 * have passed throughout the defect: the bug was never in one function, it was
 * in the seam between a producer that wrote null for two different reasons and
 * consumers that could only read one of them.
 *
 * The distinction under test is:
 *
 *   (a) trusted zone + successful account-scoped read + ZERO significant edits
 *       = known history. Still ready, still authorises. Absence of an edit is
 *       an observation, not a failure.
 *   (b) missing/invalid zone, missing account binding, or a read that threw
 *       = unavailable authority. Holds, however complete everything else looks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true })),
  assertDbSchemaReady: vi.fn(async () => ({ ready: true })),
}));

/*
  The signal WRITER is the capture point. The backfill's return value reports
  only counts, and counts cannot show which of the two nulls was written — the
  whole subject of this file — so the real signals are taken off the write.
*/
const written: MetaEntityDecisionSignal[][] = [];
vi.mock("@/lib/meta/entity-signals", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/meta/entity-signals")>();
  return {
    ...actual,
    upsertMetaEntityDecisionSignalsDaily: vi.fn(
      async (signals: MetaEntityDecisionSignal[]) => {
        written.push(signals);
        return { rowsWritten: signals.length };
      },
    ),
  };
});

/**
 * One ad set and its parent campaign, both delivering on the as-of day.
 *
 * The metrics are deliberately those of a STRONG SCALE CANDIDATE — 28 days of
 * delivery, ROAS well over the account p75, 20 purchases — so that when a case
 * ends in "no hard action" the reason can only be the authority. A weak fixture
 * would be held for its own numbers and prove nothing.
 */
const AS_OF = "2026-09-05";
const BUSINESS = "biz_1";

/**
 * One delivering day.
 *
 * The daily spend sits just UNDER the daily budget on purpose. Spending well
 * over it makes `computeMonthlyPacing` report `overpaced`, which is its own
 * independent veto inside `blocksPurchaseHardAction` — and a fixture held for
 * that reason would make every refusal below pass without the authority gate
 * doing anything at all.
 */
function dailyRow(over: Record<string, unknown> = {}) {
  return {
    adsetId: "adset_1",
    campaignId: "cmp_1",
    providerAccountId: "act_1",
    date: AS_OF,
    spend: 90,
    impressions: 3_000,
    clicks: 60,
    reach: 2_300,
    frequency: 1.3,
    conversions: 3,
    revenue: 360,
    dailyBudget: 100,
    lifetimeBudget: null,
    ...over,
  };
}

vi.mock("@/lib/meta/warehouse", () => ({
  getMetaCampaignDailyRange: vi.fn(async () => []),
  getMetaAdSetDailyRange: vi.fn(async () => {
    // 28 delivering days, so learning state and creative age are populated and
    // the pack is genuinely "ready" on its other signals.
    const rows = [];
    for (let back = 27; back >= 0; back -= 1) {
      const day = new Date(Date.UTC(2026, 8, 5) - back * 86_400_000)
        .toISOString()
        .slice(0, 10);
      rows.push(dailyRow({ date: day }));
    }
    return rows;
  }),
  getMetaAdDailyRange: vi.fn(async () => []),
  getMetaBreakdownDailyRange: vi.fn(async () => []),
}));

import * as db from "@/lib/db";
import type { MetaAdSetData } from "@/lib/api/meta";
import { buildMetaAdsetRecommendations } from "@/lib/meta/adset-decisions";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import { runMetaSignalsBackfillForBusiness } from "@/lib/meta/entity-signals-backfill";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import type { MetaCalibrationContext } from "@/lib/meta/recommendations";
import {
  META_RECENT_EDIT_AUTHORITY_KEY,
  metaRecentEditAuthority,
} from "@/lib/meta/recent-edit-authority";
import {
  maybeA1MathFloor,
  maybeB1CappedBidRaise,
  maybeC1ControlledScale,
} from "@/lib/meta/scenario-emitters/high-priority";

/** A significant edit: a budget change well over the 20% threshold. */
function configHistoryRows(input: { capturedAt: string }) {
  return [
    {
      entity_id: "adset_1",
      captured_at: "2026-07-10T12:00:00.000Z",
      daily_budget: 100,
      lifetime_budget: null,
      bid_strategy_type: "lowest_cost",
      optimization_goal: "OFFSITE_CONVERSIONS",
      custom_event_type: "PURCHASE",
      promoted_object_json: null,
    },
    {
      entity_id: "adset_1",
      captured_at: input.capturedAt,
      daily_budget: 400,
      lifetime_budget: null,
      bid_strategy_type: "lowest_cost",
      optimization_goal: "OFFSITE_CONVERSIONS",
      custom_event_type: "PURCHASE",
      promoted_object_json: null,
    },
  ];
}

/**
 * ── ROUND 13 ────────────────────────────────────────────────────────────────
 * The as-of day closes at 07:00Z on the 6th in Los Angeles (PDT), and that
 * instant is what the receipt is measured against. A capture written at
 * 12:00Z on the 5th is ~19h old there — inside `classifyStaleTier`'s "none"
 * band (<=36h) and therefore fresh.
 */
const FRESH_CAPTURED_AT = "2026-09-05T12:00:00.000Z";
/** ~3 days before the cutoff: past "none" and past "warning" as well. */
const STALE_CAPTURED_AT = "2026-09-02T12:00:00.000Z";

/** Every tagged-template statement the run issued, with its bound values. */
const taggedCalls: Array<{ text: string; values: unknown[] }> = [];
/** Every `sql.query(text, params)` statement the run issued. */
const queryTexts: string[] = [];
const queryCalls = () => queryTexts;
/** The bound arrays the config-history query was actually given. */
const queryParams: unknown[][] = [];
function boundParamsForConfigHistory() {
  const index = queryTexts.findIndex((text) => text.includes("_config_history"));
  if (index < 0) return null;
  const params = queryParams[index] ?? [];
  return {
    starts: params[3] as string[] | undefined,
    ends: params[4] as string[] | undefined,
  };
}

interface Harness {
  timezone?: string | null;
  /** Rows the config-history read returns, when it is allowed to succeed. */
  history?: ReturnType<typeof configHistoryRows>;
  /** Make the config-history query throw, leaving every other read intact. */
  failHistory?: boolean;
  /**
   * The latest current-config capture receipt at/before the knowledge bound.
   * `undefined` uses a fresh complete one; `null` means none exists at all.
   */
  receipt?: {
    capture_status?: string;
    captured_at?: string;
    observed_at?: string;
    has_error?: boolean;
    provider_row_count?: number;
    sync_run_id?: string | null;
  } | null;
  /** ROUND 14: the exact sync attempt the receipt is bound to. */
  syncRun?: {
    status?: string;
    started_at?: string | null;
    finished_at?: string | null;
    partition_id?: string;
    business_id?: string;
    provider_account_id?: string;
  } | null;
  /** The receipt's partition status, so a dead-letter can be exercised. */
  partitionStatus?: string;
  /** ROUND 14: the observation run the receipt points at. */
  observationRun?: {
    manifest_kind?: string | null;
    completeness?: string;
    /** ROUND 15: the FULL logical provider scope, on both lanes. */
    row_count?: number;
    has_error?: boolean;
    observed_at?: string;
    captured_at?: string;
    scope_ok?: boolean;
  } | null;
  /** The reconstructed logical manifest. Defaults to exactly `adset_1`. */
  manifestEntityIds?: string[];
}

const SYNC_RUN_ID = "00000000-0000-4000-8000-0000000000aa";
const PARTITION_ID = "00000000-0000-4000-8000-0000000000bb";
const OBSERVATION_RUN_ID = "00000000-0000-4000-8000-000000000001";

function harness(options: Harness = {}) {
  const receipt =
    options.receipt === null
      ? null
      : {
          capture_status: options.receipt?.capture_status ?? "complete",
          captured_at: options.receipt?.captured_at ?? FRESH_CAPTURED_AT,
          observed_at:
            options.receipt?.observed_at ??
            options.receipt?.captured_at ??
            FRESH_CAPTURED_AT,
          has_error: options.receipt?.has_error ?? false,
          provider_row_count: options.receipt?.provider_row_count ?? 1,
          sync_run_id:
            options.receipt?.sync_run_id === undefined
              ? SYNC_RUN_ID
              : options.receipt.sync_run_id,
        };
  const syncRun =
    options.syncRun === null
      ? null
      : {
          status: options.syncRun?.status ?? "succeeded",
          /*
            ROUND 15: the attempt's lifecycle must CONTAIN the receipt
            occurrence (12:00Z) and finish strictly before the knowledge bound
            (20:00Z on the current-day default).
          */
          started_at:
            options.syncRun?.started_at === undefined
              ? new Date(
                  new Date(
                    options.receipt?.captured_at ?? FRESH_CAPTURED_AT,
                  ).getTime() - 3_600_000,
                ).toISOString()
              : options.syncRun.started_at,
          /*
            Finished AT the occurrence clock. The attempt must contain the
            receipt and finish strictly before the knowledge bound; deriving the
            finish from the occurrence satisfies both for every case, including
            a receipt written 1 ms before the bound.
          */
          finished_at:
            options.syncRun?.finished_at === undefined
              ? options.receipt?.captured_at ?? FRESH_CAPTURED_AT
              : options.syncRun.finished_at,
          partition_id: options.syncRun?.partition_id ?? PARTITION_ID,
          business_id: options.syncRun?.business_id ?? BUSINESS,
          provider_account_id: options.syncRun?.provider_account_id ?? "act_1",
        };
  const observationRun =
    options.observationRun === null
      ? null
      : {
          manifest_kind: options.observationRun?.manifest_kind ?? null,
          completeness: options.observationRun?.completeness ?? "complete",
          row_count:
            options.observationRun?.row_count ??
            (options.manifestEntityIds ?? ["adset_1"]).length,
          has_error: options.observationRun?.has_error ?? false,
          observed_at: options.observationRun?.observed_at ?? FRESH_CAPTURED_AT,
          captured_at: options.observationRun?.captured_at ?? FRESH_CAPTURED_AT,
          scope_ok: options.observationRun?.scope_ok ?? true,
        };
  const manifestEntityIds = options.manifestEntityIds ?? ["adset_1"];

  const answer = (text: string) => {
    if (text.includes("meta_entity_observation_receipts")) {
      return receipt == null
        ? []
        : [
            {
              capture_status: receipt.capture_status,
              observed_at: receipt.observed_at,
              captured_at: receipt.captured_at,
              provider_row_count: receipt.provider_row_count,
              page_count: 1,
              has_error: receipt.has_error,
              run_id: OBSERVATION_RUN_ID,
              partition_id: PARTITION_ID,
              source_snapshot_id: "snap_1",
              sync_run_id: receipt.sync_run_id,
              sync_run_status: receipt.sync_run_id == null ? null : syncRun?.status ?? null,
              sync_run_started_at:
                receipt.sync_run_id == null ? null : syncRun?.started_at ?? null,
              sync_run_finished_at:
                receipt.sync_run_id == null ? null : syncRun?.finished_at ?? null,
              sync_run_partition_id:
                receipt.sync_run_id == null ? null : syncRun?.partition_id ?? null,
              sync_run_business_id:
                receipt.sync_run_id == null ? null : syncRun?.business_id ?? null,
              sync_run_provider_account_id:
                receipt.sync_run_id == null
                  ? null
                  : syncRun?.provider_account_id ?? null,
              partition_status: options.partitionStatus ?? "succeeded",
            },
          ];
    }
    // The run validation read, discriminated by its computed `scope_ok`.
    if (text.includes("scope_ok")) {
      return observationRun == null ? [] : [observationRun];
    }
    // The manifest reconstruction read.
    if (text.includes("meta_entity_state_history")) {
      return manifestEntityIds.map((entity_id) => ({ entity_id }));
    }
    return [];
  };

  const query = vi.fn(async (text: string, _params: unknown[] = []) => {
    queryTexts.push(text);
    queryParams.push(_params);
    if (text.includes("provider_accounts")) {
      return options.timezone == null
        ? []
        : [{ provider_account_id: "act_1", timezone: options.timezone }];
    }
    if (text.includes("_config_history")) {
      if (options.failHistory) throw new Error("config history read failed");
      /*
        THE MOCK HONOURS THE QUERY'S OWN PREDICATES.

        Returning every fixture row regardless of the window would make the
        predecessor assertions vacuous: they would pass whether or not the SQL
        actually reaches before `start_inclusive`. So the bound bounds are read
        off the parameters, the in-window rows are filtered by them, and the
        pre-window row is included ONLY when the statement contains the
        predecessor arm.
      */
      const rows = options.history ?? [];
      const startInclusive = (_params[3] as string[] | undefined)?.[0];
      const endExclusive = (_params[4] as string[] | undefined)?.[0];
      if (!startInclusive || !endExclusive) return rows;
      const start = new Date(startInclusive).getTime();
      const end = new Date(endExclusive).getTime();
      const inWindow = rows.filter((row) => {
        const at = new Date(row.captured_at).getTime();
        return at >= start && at < end;
      });
      const hasPredecessorArm = text.includes(
        "captured_at < requested_entities.start_inclusive",
      );
      if (!hasPredecessorArm) return inWindow;
      const predecessor = rows
        .filter((row) => new Date(row.captured_at).getTime() < start)
        .sort(
          (left, right) =>
            new Date(right.captured_at).getTime() -
            new Date(left.captured_at).getTime(),
        )[0];
      return predecessor ? [predecessor, ...inWindow] : inWindow;
    }
    return answer(text);
  });

  /*
    `entity-state-history.ts` reads through the TAGGED TEMPLATE form, not
    `sql.query`, so the base callable has to answer too.
  */
  const tagged = async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    const text =
      typeof strings === "string" ? strings : Array.from(strings).join(" ? ");
    taggedCalls.push({ text, values });
    return answer(text);
  };

  vi.mocked(db.getDb).mockReturnValue(
    Object.assign(tagged, { query }) as never,
  );
}

/** Run the real backfill and return the ad-set signal it actually wrote. */
async function adsetSignalFromBackfill(
  now?: Date,
): Promise<MetaEntityDecisionSignal> {
  written.length = 0;
  await runMetaSignalsBackfillForBusiness(BUSINESS, AS_OF, {
    // ROUND 14: the single evaluation instant. Defaulted to a moment INSIDE the
    // as-of provider-local day so the ordinary cases exercise the current-day
    // branch (`min(now, dayEnd)`) rather than the historical one.
    now: now ?? new Date("2026-09-05T20:00:00.000Z"),
  });
  const signals = written.flat().filter((s) => s.scopeType === "adset");
  expect(
    signals.length,
    "the backfill must produce an ad-set signal, or every assertion below is vacuous",
  ).toBe(1);
  return signals[0]!;
}

const adset: MetaAdSetData = {
  id: "adset_1",
  accountId: "act_1",
  name: "Scale candidate",
  campaignId: "cmp_1",
  status: "ACTIVE",
  budgetLevel: "adset",
  dailyBudget: 100,
  lifetimeBudget: null,
  optimizationGoal: "OFFSITE_CONVERSIONS",
  customEventType: "PURCHASE",
  bidStrategyType: null,
  bidStrategyLabel: null,
  manualBidAmount: null,
  bidValue: null,
  bidValueFormat: null,
  isBudgetMixed: false,
  isConfigMixed: false,
  spend: 600,
  purchases: 20,
  revenue: 2_400,
  roas: 4,
  cpa: 30,
  ctr: 2,
  cpm: 30,
  impressions: 20_000,
  clicks: 400,
} as MetaAdSetData;

const purchaseContext: MetaCalibrationContext = {
  thresholds: {
    source: "calibrated",
    hardCutSpend: 200,
    minRequiredSample: 8,
    metrics: {
      ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
      roas_28d: { p10: 0.5, p25: 1.2, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
      cpa_28d: { p10: 40, p25: 60, p50: 90, p75: 120, p90: 180, sampleSize: 20 },
    },
  },
  scope: {
    type: "campaign",
    id: "cmp_1",
    snapshotDate: AS_OF,
    cohort: "purchase",
  },
  cohort: "purchase",
};

const commercialTargets = {
  source: "configured_targets" as const,
  targetRoas: 2.2,
  breakEvenRoas: 1.5,
  targetCpa: null,
  breakEvenCpa: null,
  riskPosture: "balanced" as const,
  freshness: "fresh" as const,
  updatedAt: "2026-09-01T00:00:00.000Z",
  metaAttributedAov: { aovMean: 180, purchaseCount: 60 },
};

/** Every purchase-budget hard action the ad-set path can propose. */
const HARD_ACTIONS = new Set([
  "scale_budget",
  "cut_budget",
  "reduce_budget",
  "increase_budget",
  "decrease_budget",
  "pause_adset",
  "refresh_creative",
]);

function hardActions(signal: MetaEntityDecisionSignal) {
  return buildMetaAdsetRecommendations({
    adsets: [adset],
    campaigns: [],
    calibrationContext: purchaseContext,
    commercialTargets,
    entitySignalsByAdsetId: { adset_1: signal },
  } as never).filter(
    (rec) =>
      rec.decisionState === "act" ||
      HARD_ACTIONS.has(String(rec.type)) ||
      rec.recommendedAction != null,
  );
}

/** The `act`-lane subset — the decisions that authorise a provider change. */
function actLane(signal: MetaEntityDecisionSignal) {
  return buildMetaAdsetRecommendations({
    adsets: [adset],
    campaigns: [],
    calibrationContext: purchaseContext,
    commercialTargets,
    entitySignalsByAdsetId: { adset_1: signal },
  } as never).filter((rec) => rec.decisionState === "act");
}

beforeEach(() => {
  vi.clearAllMocks();
  written.length = 0;
  taggedCalls.length = 0;
  queryTexts.length = 0;
  queryParams.length = 0;
});

describe("unavailable authority holds every purchase-budget hard action", () => {
  it("1 — a MISSING provider timezone: otherwise-ready signal, no act lane", async () => {
    harness({ timezone: null });
    const signal = await adsetSignalFromBackfill();

    /*
      THE PACK IS OTHERWISE READY. This is the whole point of the case: the
      defect was not that a poor signal slipped through, it was that a signal
      indistinguishable from a good one did. If `qualityStatus` were not
      "ready", the old gate would have caught it and there would be no defect.
    */
    expect(signal.qualityStatus).toBe("ready");
    expect(signal.lastSignificantEditAt).toBeNull();
    expect(signal.daysSinceSignificantEdit).toBeNull();

    // The recorded authority is what makes the two nulls readable.
    expect(metaRecentEditAuthority(signal)).toEqual({
      status: "unavailable",
      reason: "provider_timezone_untrusted",
      timeZone: null,
    });
    expect(actLane(signal)).toHaveLength(0);
  });

  it("2 — an INVALID provider timezone reaches the same held result", async () => {
    // A fixed offset cannot express a DST rule; an abbreviation is ambiguous
    // across regions. Neither is a calendar, so neither is an authority.
    for (const timezone of ["+03:00", "PST", "Mars/Olympus", "   "]) {
      vi.clearAllMocks();
      harness({ timezone });
      const signal = await adsetSignalFromBackfill();

      expect(signal.qualityStatus, timezone).toBe("ready");
      expect(metaRecentEditAuthority(signal).status, timezone).toBe(
        "unavailable",
      );
      expect(metaRecentEditAuthority(signal).reason, timezone).toBe(
        "provider_timezone_untrusted",
      );
      expect(actLane(signal), timezone).toHaveLength(0);
    }
  });

  it("3 — a config-history read FAILURE is not an empty history", async () => {
    /*
      The zone is perfectly good here; the query threw. Before this round the
      catch returned an empty map, which is byte-identical to a clean account —
      so a database outage read as "no recent edits" and authorised spend.
    */
    harness({ timezone: "America/Los_Angeles", failHistory: true });
    const signal = await adsetSignalFromBackfill();

    expect(signal.qualityStatus).toBe("ready");
    expect(metaRecentEditAuthority(signal)).toEqual({
      status: "unavailable",
      reason: "config_history_read_failed",
      timeZone: null,
    });
    expect(actLane(signal)).toHaveLength(0);
  });
});

describe("a read that found nothing is not a read that failed", () => {
  it("4 — trusted zone + successful EMPTY history is ready, null edit and all", async () => {
    /*
      THE CASE THIS FIX MUST NOT BREAK, and the reason the authority is a
      separate field rather than a re-reading of `lastSignificantEditAt`.

      An account with a trusted zone whose 60-day window genuinely contains no
      significant configuration change writes exactly the same three nulls as
      the three unavailable cases above. Treating the null itself as failure
      would hold every well-behaved, stable ad set in the product — a blanket
      indecision guard rather than a fix.
    */
    harness({ timezone: "America/Los_Angeles", history: [] });
    const signal = await adsetSignalFromBackfill();

    expect(signal.lastSignificantEditAt).toBeNull();
    expect(signal.daysSinceSignificantEdit).toBeNull();
    // Same nulls as case 1 — and the opposite authority.
    expect(metaRecentEditAuthority(signal)).toEqual({
      status: "ready",
      reason: "observed",
      timeZone: "America/Los_Angeles",
    });
    expect(actLane(signal).length).toBeGreaterThan(0);
  });

  it("distinguishes the two nulls on the persisted record alone", async () => {
    // The signals differ ONLY in the authority record, which is what has to
    // survive the round trip through `source_json`.
    harness({ timezone: "America/Los_Angeles", history: [] });
    const ready = await adsetSignalFromBackfill();
    vi.clearAllMocks();
    harness({ timezone: null });
    const unavailable = await adsetSignalFromBackfill();

    expect(ready.lastSignificantEditAt).toBe(unavailable.lastSignificantEditAt);
    expect(ready.daysSinceSignificantEdit).toBe(
      unavailable.daysSinceSignificantEdit,
    );
    expect(ready.qualityStatus).toBe(unavailable.qualityStatus);
    // Serialised exactly as it will be stored, so this is the DB contract too.
    expect(
      JSON.parse(JSON.stringify(ready.sourceJson))[
        META_RECENT_EDIT_AUTHORITY_KEY
      ],
    ).toEqual({
      status: "ready",
      reason: "observed",
      time_zone: "America/Los_Angeles",
    });
    expect(
      JSON.parse(JSON.stringify(unavailable.sourceJson))[
        META_RECENT_EDIT_AUTHORITY_KEY
      ],
    ).toEqual({
      status: "unavailable",
      reason: "provider_timezone_untrusted",
      time_zone: null,
    });
  });
});

describe("5 — a real, measured edit age still governs", () => {
  it("BLOCKS when the last significant edit is under 7 provider-local days", async () => {
    // 2026-09-02 12:00Z is 05:00 on the 2nd in Los Angeles: 3 local days back.
    harness({
      timezone: "America/Los_Angeles",
      history: configHistoryRows({ capturedAt: "2026-09-02T12:00:00.000Z" }),
    });
    const signal = await adsetSignalFromBackfill();

    expect(metaRecentEditAuthority(signal).status).toBe("ready");
    expect(signal.daysSinceSignificantEdit).toBe(3);
    // Authority READY and the veto still applies: the new gate did not replace
    // the cooldown, it only stopped an unmeasured age from skipping it.
    expect(actLane(signal)).toHaveLength(0);
  });

  it("ALLOWS when the last significant edit is 7 or more days old", async () => {
    // 2026-08-20 is 16 local days before the as-of day.
    harness({
      timezone: "America/Los_Angeles",
      history: configHistoryRows({ capturedAt: "2026-08-20T12:00:00.000Z" }),
    });
    const signal = await adsetSignalFromBackfill();

    expect(metaRecentEditAuthority(signal).status).toBe("ready");
    expect(signal.daysSinceSignificantEdit).toBeGreaterThanOrEqual(7);
    expect(actLane(signal).length).toBeGreaterThan(0);
    expect(hardActions(signal).length).toBeGreaterThan(0);
  });
});

describe("6 — the campaign / high-priority path holds on the same authority", () => {
  /*
    `maybeC1ControlledScale` emits `decisionState: "act"` and is gated on the
    same `daysSinceSignificantEdit` field with the same null-passes semantics,
    so the identical defect lived on the campaign side. `maybeA2StructuralRebuild`
    and `maybeA5PostLearningUnderperformer` are the other two `act` emitters and
    carry the same guard; the watch and test emitters deliberately do not.
  */
  const campaignWindow = {
    selected: {
      roas: 3.4,
      purchases: 20,
      spend: 2_000,
      revenue: 6_800,
      cpa: 100,
      ctr: 2,
      cpm: 30,
      impressions: 60_000,
      clicks: 1_200,
      frequency: 1.4,
      /*
        ── ROUND 20 ────────────────────────────────────────────────────────
        The currency is load-bearing, not decoration. Round 19 made budget
        conversion read the ISO 4217 exponent instead of dividing every
        provider amount by 100, and that resolver REFUSES an absent or unknown
        code rather than assuming two decimals. This fixture had no currency,
        so `budgetAmount` correctly returned null, C1 returned null -- and the
        positive control below silently stopped controlling anything, leaving
        the two authority refusals in this block passing vacuously.
      */
      currency: "USD",
      dailyBudget: 200,
      lifetimeBudget: null,
      isBudgetMixed: false,
      ageDays: 40,
      activeDayCount: 40,
      firstDeliveryDate: "2026-07-27",
      asOfDate: AS_OF,
      id: "cmp_1",
      name: "Scale candidate",
      status: "ACTIVE",
      objective: "OUTCOME_SALES",
    },
  } as never;

  function campaignSignal(
    over: Partial<MetaEntityDecisionSignal>,
  ): MetaEntityDecisionSignal {
    return {
      businessId: BUSINESS,
      providerAccountId: "act_1",
      scopeType: "campaign",
      scopeId: "cmp_1",
      asOfDate: AS_OF,
      learningState: "OPTIMAL_LEARNING_DONE",
      daysAtLearningState: 20,
      lastSignificantEditAt: null,
      daysSinceSignificantEdit: null,
      recentChangeCooldownUntil: null,
      creativeAgeDays: 40,
      creativeAgeDaysMax: 40,
      frequencyP80: null,
      ctrDecayPct: null,
      sourceJson: {},
      qualityStatus: "ready",
      ...over,
    };
  }

  const emit = (signals: MetaEntityDecisionSignal) =>
    maybeC1ControlledScale({
      window: campaignWindow,
      context: purchaseContext,
      cohort: "purchase",
      commercialTargets,
      signals,
    } as never);

  it("emits controlled scale when the authority is ready and no edit was found", () => {
    // The control. Without it the two refusals below could be caused by the
    // fixture's own numbers rather than by the authority.
    const rec = emit(
      campaignSignal({
        sourceJson: {
          [META_RECENT_EDIT_AUTHORITY_KEY]: {
            status: "ready",
            reason: "observed",
            time_zone: "America/Los_Angeles",
          },
        },
      }),
    );
    expect(rec?.type).toBe("scenario_c1_controlled_scale");
    expect(rec?.decisionState).toBe("act");
  });

  it("HOLDS controlled scale when the authority is unavailable", () => {
    for (const reason of [
      "provider_timezone_untrusted",
      "provider_account_unresolved",
      "config_history_read_failed",
    ]) {
      const rec = emit(
        campaignSignal({
          sourceJson: {
            [META_RECENT_EDIT_AUTHORITY_KEY]: {
              status: "unavailable",
              reason,
              time_zone: null,
            },
          },
        }),
      );
      expect(rec, reason).toBeNull();
    }
  });

  it("HOLDS a signal written before the authority existed", () => {
    /*
      COMPATIBILITY, DECIDED IN THE HOLDING DIRECTION. A row persisted by an
      earlier build carries no authority record. That is not evidence the
      authority was ready — it is evidence nobody wrote one — so it reads as
      `not_recorded` and holds. The backfill rewrites the current as-of day on
      every run, so such a row self-heals on the next cycle; defaulting the
      other way would preserve the exact defect this module closes.
    */
    const rec = emit(campaignSignal({ sourceJson: { age_days: 40 } }));
    expect(rec).toBeNull();
    expect(
      metaRecentEditAuthority(campaignSignal({ sourceJson: {} })).reason,
    ).toBe("not_recorded");
  });

  it("HOLDS a malformed or self-contradictory authority record", () => {
    // "ready" with no zone is a contradiction: the zone is the one thing that
    // makes the window computable. Untrusted evidence, so it holds.
    for (const record of [
      { status: "ready", reason: "observed", time_zone: null },
      { status: "ready", reason: "config_history_read_failed", time_zone: "UTC" },
      { status: "ready", reason: "invented_reason", time_zone: "UTC" },
      "ready",
      [],
    ]) {
      const rec = emit(
        campaignSignal({
          sourceJson: { [META_RECENT_EDIT_AUTHORITY_KEY]: record },
        }),
      );
      expect(rec, JSON.stringify(record)).toBeNull();
    }
  });
});

/*
  ══ ROUND 13 ════════════════════════════════════════════════════════════════

  A SUCCESSFUL SELECT AGAINST A TRANSITION-ONLY TABLE IS NOT AN OBSERVATION.

  `meta_adset_config_history` is appended to only when a COMPLETE capture sees
  a CHANGE. So zero rows is written identically by three different worlds:

      "nothing changed"      "we never looked"      "we looked and failed"

  Round 12 recorded the query not throwing (`readOk: true`) as `observed`, which
  is the first of those three asserted over the other two. The cases below drive
  the real backfill with the durable capture receipt varied and everything else
  held constant, so the ONLY thing that differs between an authorised account
  and a held one is whether a complete, fresh, entity-bearing observation of the
  current config actually exists.
*/
describe("READY requires a real current-config observation receipt", () => {
  const REFUSALS: Array<[name: string, options: Harness, reason: string]> = [
    [
      "no receipt at all — the account was never captured",
      { receipt: null },
      "observation_receipt_missing",
    ],
    [
      "a PARTIAL capture, which writes no transitions of its own",
      { receipt: { capture_status: "partial", captured_at: FRESH_CAPTURED_AT } },
      "observation_capture_not_complete",
    ],
    [
      "a FAILED capture",
      { receipt: { capture_status: "failed", captured_at: FRESH_CAPTURED_AT } },
      "observation_capture_not_complete",
    ],
    [
      "a POINT_LOOKUP capture, which never enumerates the account",
      { receipt: { capture_status: "point_lookup", captured_at: FRESH_CAPTURED_AT } },
      "observation_capture_not_complete",
    ],
    [
      "a STALE complete capture, past the source-freshness contract",
      { receipt: { capture_status: "complete", captured_at: STALE_CAPTURED_AT } },
      "observation_receipt_stale",
    ],
    [
      // ROUND 14: membership, not "is anything known". The capture enumerated
      // the account and this entity was not in it.
      "a complete capture the entity was ABSENT from",
      { manifestEntityIds: ["adset_other"] },
      "entity_absent_from_observation",
    ],
    [
      /*
        ROUND 14: a scope exit recorded after the applicable re-observation
        REMOVES the entity from the manifest, so an exited entity surfaces as
        absent from the capture rather than as a separate truth event. The old
        `readMetaEntityTruthAsOf` reading — a tombstone winning over a state —
        is gone with the reader it belonged to.
      */
      "a complete capture in which the entity had EXITED",
      { manifestEntityIds: ["adset_other"] },
      "entity_absent_from_observation",
    ],
    [
      "an observation run whose manifest is EMPTY while an entity is requested",
      { manifestEntityIds: [] },
      "observation_manifest_unusable",
    ],
    [
      "a manifest whose size disagrees with the receipt's provider row count",
      { manifestEntityIds: ["adset_1"], receipt: { provider_row_count: 40 } },
      "observation_manifest_unusable",
    ],
    [
      "an observation run captured by a DIFFERENT endpoint or account",
      { observationRun: { scope_ok: false } },
      "observation_manifest_unusable",
    ],
    [
      "an observation run that is PARTIAL",
      { observationRun: { completeness: "partial" } },
      "observation_manifest_unusable",
    ],
    [
      "an observation run that is POINT_LOOKUP",
      { observationRun: { completeness: "point_lookup" } },
      "observation_manifest_unusable",
    ],
    /* ── ROUND 14, CONTRACT 1: THE EXACT SYNC ATTEMPT ────────────────────── */
    [
      "a LEGACY receipt written before sync_run_id existed",
      { receipt: { sync_run_id: null } },
      "sync_run_unlinked",
    ],
    [
      "an attempt row that no longer exists",
      { syncRun: null },
      "sync_run_missing",
    ],
    [
      "an attempt bound to a DIFFERENT partition — retries cannot cross-bind",
      { syncRun: { partition_id: "00000000-0000-4000-8000-0000000000cc" } },
      "sync_run_mismatched",
    ],
    [
      "an attempt bound to a different account",
      { syncRun: { provider_account_id: "act_2" } },
      "sync_run_mismatched",
    ],
    [
      "an attempt that FAILED after committing this complete receipt",
      { syncRun: { status: "failed" } },
      "sync_run_not_succeeded",
    ],
    [
      "an attempt still RUNNING",
      { syncRun: { status: "running", finished_at: null } },
      "sync_run_not_succeeded",
    ],
    [
      "an attempt that was CANCELLED",
      { syncRun: { status: "cancelled" } },
      "sync_run_not_succeeded",
    ],
    [
      "a succeeded attempt with no terminal finish clock",
      { syncRun: { finished_at: null } },
      "sync_run_unfinished",
    ],
    [
      "a dead-lettered partition",
      { partitionStatus: "dead_letter" },
      "sync_partition_dead_letter",
    ],
  ];

  it.each(REFUSALS)(
    "holds every purchase hard action on %s",
    async (_name, options, reason) => {
      harness({ timezone: "America/Los_Angeles", history: [], ...options });
      const signal = await adsetSignalFromBackfill();

      /*
        THE TRANSITION READ SUCCEEDED AND RETURNED ZERO ROWS in every one of
        these, and the pack is otherwise ready. Under Round 12 that was
        `observed` and the ad set scaled. The receipt is the only difference.
      */
      expect(signal.qualityStatus).toBe("ready");
      expect(signal.lastSignificantEditAt).toBeNull();
      expect(metaRecentEditAuthority(signal).status).toBe("unavailable");
      expect(metaRecentEditAuthority(signal).reason).toBe(reason);
      expect(actLane(signal)).toHaveLength(0);
    },
  );

  it("never steps over a newer non-complete capture to reach an older good one", async () => {
    /*
      The reader takes the newest attempt WHATEVER its outcome and then demands
      completeness, rather than selecting the newest COMPLETE attempt. The
      difference is a broken sync: filtering inside the ordering would reach
      back past this morning's failure to yesterday's success and keep
      authorising changes for as long as the failures continued.

      Asserted on the statement, because a mock cannot show a row that a
      correct query would never have looked at.
    */
    harness({ timezone: "America/Los_Angeles", history: [] });
    await adsetSignalFromBackfill();
    const receiptRead = taggedCalls.find((call) =>
      call.text.includes("meta_entity_observation_receipts"),
    );
    expect(receiptRead, "the receipt read must happen").toBeTruthy();
    expect(receiptRead!.text).toContain("ORDER BY receipt.captured_at DESC");
    // Status is NOT a predicate: the newest row wins and is judged afterwards.
    expect(receiptRead!.text).not.toContain("capture_status = ");
    expect(receiptRead!.text).not.toContain("capture_status IN");
    /*
      ROUND 14. The sync-run and partition joins must be LEFT, for the same
      reason: an INNER join on a succeeded run would let the query walk back
      past a newer failure to an older success, which is the fallback this
      contract forbids.
    */
    expect(receiptRead!.text).toContain("LEFT JOIN meta_sync_runs run");
    expect(receiptRead!.text).not.toContain("JOIN meta_sync_runs run ON run.id = receipt.sync_run_id\n    WHERE");
    expect(receiptRead!.text).not.toContain("run.status = ");
  });

  it("binds the receipt to the SAME account the window is scoped to", async () => {
    // CROSS-ACCOUNT EXCLUSION. Another account's capture cannot attest this
    // one's configuration, so the account is a bound predicate, not a filter
    // applied afterwards.
    harness({ timezone: "America/Los_Angeles", history: [] });
    await adsetSignalFromBackfill();
    const receiptRead = taggedCalls.find((call) =>
      call.text.includes("meta_entity_observation_receipts"),
    )!;
    expect(receiptRead.text).toContain("provider_account_id = ");
    expect(receiptRead.text).toContain("entity_type = ");
    expect(receiptRead.text).toContain("endpoint = ");
    expect(receiptRead.values).toContain("act_1");
    // The endpoint that actually attests an ad set's current config.
    expect(receiptRead.values).toContain("adset_configs");
  });

  it("a receipt for a DIFFERENT account leaves this one unobserved", async () => {
    /*
      The account-scoped query finds nothing, which is the correct answer: a
      capture of act_2 is not evidence about act_1. Modelled by answering the
      scoped read with no rows, which is what the real predicate produces.
    */
    harness({ timezone: "America/Los_Angeles", history: [], receipt: null });
    const signal = await adsetSignalFromBackfill();
    expect(metaRecentEditAuthority(signal).reason).toBe(
      "observation_receipt_missing",
    );
    expect(actLane(signal)).toHaveLength(0);
  });

  it("a fresh COMPLETE receipt with the entity present makes zero transitions a real no-edit", async () => {
    /*
      THE CASE THIS MUST NOT BREAK. A genuinely complete observation that saw
      this exact ad set and recorded no configuration change is a KNOWN no-edit
      result, and it must still authorise. Without this control the seven
      refusals above would be satisfied by a gate that simply never says yes.
    */
    harness({ timezone: "America/Los_Angeles", history: [] });
    const signal = await adsetSignalFromBackfill();

    expect(metaRecentEditAuthority(signal)).toEqual({
      status: "ready",
      reason: "observed",
      timeZone: "America/Los_Angeles",
    });
    expect(signal.lastSignificantEditAt).toBeNull();
    expect(actLane(signal).length).toBeGreaterThan(0);
  });
});

describe("the predecessor is inside the comparison, not outside it", () => {
  /*
    ── ROUND 13, DEFECT 2 ────────────────────────────────────────────────────
    `findLastSignificantEditAt` compares ADJACENT returned rows. The window was
    [asOf-60d, endExclusive), so a config set 90 days ago and changed 2 days ago
    returned exactly ONE row, had nothing to be compared against, and reported
    NO recent edit — lifting the cooldown on the most recently edited entities
    in the account, which is the precise opposite of what it is for.
  */
  const PREDECESSOR = {
    entity_id: "adset_1",
    captured_at: "2026-06-07T12:00:00.000Z", // asOf - 90d
    daily_budget: 100,
    lifetime_budget: null,
    bid_strategy_type: "lowest_cost",
    optimization_goal: "OFFSITE_CONVERSIONS",
    custom_event_type: "PURCHASE",
    promoted_object_json: null,
  };
  const RECENT_TRANSITION = {
    ...PREDECESSOR,
    captured_at: "2026-09-03T12:00:00.000Z", // asOf - 2 local days
    daily_budget: 400, // +300%, far past the 20% significance threshold
  };

  it("fetches the latest row BEFORE the window, one per exact account and entity", async () => {
    harness({ timezone: "America/Los_Angeles", history: [] });
    await adsetSignalFromBackfill();
    const call = queryCalls().find((text) => text.includes("_config_history"));
    expect(call, "the config-history read must run").toBeTruthy();
    // The in-window arm, unchanged.
    expect(call!).toContain("captured_at >= requested_entities.start_inclusive");
    // And the predecessor arm: strictly before the window, exactly one row.
    expect(call!).toContain("captured_at < requested_entities.start_inclusive");
    expect(call!).toContain("UNION ALL");
    // Still account-scoped on BOTH arms — two predicates, not one.
    expect(
      call!.split("provider_account_id = requested_entities.provider_account_id")
        .length - 1,
    ).toBe(2);
  });

  it("reports daysSince = 2 and HOLDS the action", async () => {
    harness({
      timezone: "America/Los_Angeles",
      history: [PREDECESSOR, RECENT_TRANSITION],
    });
    const signal = await adsetSignalFromBackfill();

    expect(metaRecentEditAuthority(signal).status).toBe("ready");
    expect(signal.daysSinceSignificantEdit).toBe(2);
    expect(actLane(signal)).toHaveLength(0);
  });

  it("would MISS the same edit with the predecessor withheld, which is the defect", async () => {
    /*
      NON-VACUITY. The same recent transition, alone — exactly what the old
      query returned. One row cannot be compared with anything, so no edit is
      found and the ad set scales two days after a 4x budget change.
    */
    harness({ timezone: "America/Los_Angeles", history: [RECENT_TRANSITION] });
    const signal = await adsetSignalFromBackfill();

    expect(signal.daysSinceSignificantEdit).toBeNull();
    expect(actLane(signal).length).toBeGreaterThan(0);
  });

  it("never reports the predecessor ITSELF as the recent edit", async () => {
    // It is comparison context only. With no in-window transition the answer is
    // "no edit in the window", not "an edit 90 days ago".
    harness({ timezone: "America/Los_Angeles", history: [PREDECESSOR] });
    const signal = await adsetSignalFromBackfill();

    expect(signal.lastSignificantEditAt).toBeNull();
    expect(signal.daysSinceSignificantEdit).toBeNull();
    expect(metaRecentEditAuthority(signal).status).toBe("ready");
    expect(actLane(signal).length).toBeGreaterThan(0);
  });
});

describe("a persisted timezone is validated on the READ side too", () => {
  /*
    ── ROUND 13, DEFECT 3 ────────────────────────────────────────────────────
    `metaRecentEditAuthority` accepted ANY non-empty `time_zone` string as
    READY. The producer validates before it writes, but a reader that trusts
    the column re-opens the hole from the other side: a row written by an older
    build, a repair script or by hand could carry a fixed offset or an
    abbreviation — neither of which is a calendar — and read as authorised.
  */
  const INVALID = ["+03:00", "-0700", "PST", "EST5EDT", "Mars/Olympus", "   ", ""];

  function signalWithZone(zone: unknown): MetaEntityDecisionSignal {
    return {
      businessId: BUSINESS,
      providerAccountId: "act_1",
      scopeType: "adset",
      scopeId: "adset_1",
      asOfDate: AS_OF,
      learningState: "OPTIMAL_LEARNING_DONE",
      daysAtLearningState: 20,
      lastSignificantEditAt: null,
      daysSinceSignificantEdit: null,
      recentChangeCooldownUntil: null,
      creativeAgeDays: 40,
      creativeAgeDaysMax: 40,
      frequencyP80: 1.3,
      ctrDecayPct: 0,
      sourceJson: {
        [META_RECENT_EDIT_AUTHORITY_KEY]: {
          status: "ready",
          reason: "observed",
          time_zone: zone,
        },
      },
      qualityStatus: "ready",
    };
  }

  it.each(INVALID)("parses %s as malformed rather than ready", (zone) => {
    const authority = metaRecentEditAuthority(signalWithZone(zone));
    expect(authority.status).toBe("unavailable");
    expect(authority.reason).toBe("malformed");
    expect(authority.timeZone).toBeNull();
  });

  it("holds an AD-SET purchase hard action on every invalid zone", () => {
    for (const zone of INVALID) {
      expect(actLane(signalWithZone(zone)), zone).toHaveLength(0);
    }
  });

  it("holds the CAMPAIGN path on every invalid zone", () => {
    const campaignScaleWindow = {
      selected: {
        id: "cmp_1",
        name: "Scale candidate",
        status: "ACTIVE",
        objective: "OUTCOME_SALES",
        currency: "USD",
        roas: 3.4,
        purchases: 20,
        spend: 2_000,
        revenue: 6_800,
        cpa: 100,
        ctr: 2,
        cpm: 30,
        impressions: 60_000,
        clicks: 1_200,
        frequency: 1.4,
        dailyBudget: 20_000,
        lifetimeBudget: null,
        isBudgetMixed: false,
        ageDays: 40,
        activeDayCount: 40,
        firstDeliveryDate: "2026-07-27",
        asOfDate: AS_OF,
      },
    } as never;
    for (const zone of INVALID) {
      const rec = maybeC1ControlledScale({
        window: campaignScaleWindow,
        context: purchaseContext,
        cohort: "purchase",
        commercialTargets,
        signals: { ...signalWithZone(zone), scopeType: "campaign", scopeId: "cmp_1" },
      } as never);
      expect(rec, zone).toBeNull();
    }
    /*
      THE CONTROL, in the same test so it cannot drift from the window above.
      Without it every refusal here would be satisfied by a fixture that never
      emits — which is exactly how a vacuous refusal hides a missing guard.
    */
    const valid = maybeC1ControlledScale({
      window: campaignScaleWindow,
      context: purchaseContext,
      cohort: "purchase",
      commercialTargets,
      signals: {
        ...signalWithZone("America/Los_Angeles"),
        scopeType: "campaign",
        scopeId: "cmp_1",
      },
    } as never);
    expect(valid?.type).toBe("scenario_c1_controlled_scale");
  });

  it("still accepts a real IANA zone, so the refusals discriminate", () => {
    for (const zone of ["America/Los_Angeles", "Europe/Istanbul", "UTC"]) {
      expect(metaRecentEditAuthority(signalWithZone(zone)).status, zone).toBe(
        "ready",
      );
    }
    expect(actLane(signalWithZone("America/Los_Angeles")).length).toBeGreaterThan(0);
  });
});

describe("B1 and A1 — the two act emitters that had no edit check at all", () => {
  /*
    ── ROUND 13, DEFECT 4 ────────────────────────────────────────────────────
    `maybeB1CappedBidRaise` raises a BID CAP and `maybeA1MathFloor` proposes
    changing the OPTIMIZATION EVENT — a learning reset. Both emit
    decisionState "act", and neither consulted the recent-edit age in any form.
  */
  function campaignRow(over: Record<string, unknown> = {}) {
    return {
      id: "cmp_1",
      name: "Capped winner",
      status: "ACTIVE",
      objective: "OUTCOME_SALES",
      currency: "USD",
      bidStrategyType: "cost_cap",
      bidValue: 5_000,
      bidValueFormat: "currency",
      manualBidAmount: null,
      dailyBudget: 50_000,
      lifetimeBudget: null,
      isBudgetMixed: false,
      spend: 1_000,
      purchases: 20,
      revenue: 6_800,
      roas: 3.4,
      cpa: 100,
      ctr: 2,
      cpm: 30,
      impressions: 60_000,
      clicks: 1_200,
      frequency: 1.4,
      ageDays: 40,
      activeDayCount: 40,
      firstDeliveryDate: "2026-07-27",
      asOfDate: AS_OF,
      ...over,
    };
  }
  const window = {
    selected: campaignRow(),
    last30: campaignRow({ spend: 1_000 }),
    last90: campaignRow(),
    last7: campaignRow(),
  } as never;

  function campaignSignalWith(
    authority: unknown,
    over: Partial<MetaEntityDecisionSignal> = {},
  ): MetaEntityDecisionSignal {
    return {
      businessId: BUSINESS,
      providerAccountId: "act_1",
      scopeType: "campaign",
      scopeId: "cmp_1",
      asOfDate: AS_OF,
      // LEARNING (not OPTIMAL_LEARNING_DONE) is what A1 requires.
      learningState: "LEARNING",
      daysAtLearningState: 5,
      lastSignificantEditAt: null,
      daysSinceSignificantEdit: null,
      recentChangeCooldownUntil: null,
      creativeAgeDays: 40,
      creativeAgeDaysMax: 40,
      frequencyP80: null,
      ctrDecayPct: null,
      sourceJson: { [META_RECENT_EDIT_AUTHORITY_KEY]: authority },
      qualityStatus: "ready",
      ...over,
    };
  }

  const READY = {
    status: "ready",
    reason: "observed",
    time_zone: "America/Los_Angeles",
  };
  const UNAVAILABLE = {
    status: "unavailable",
    reason: "observation_receipt_missing",
    time_zone: null,
  };

  const b1 = (signals: MetaEntityDecisionSignal) =>
    maybeB1CappedBidRaise({
      window,
      context: purchaseContext,
      cohort: "purchase",
      commercialTargets,
      signals,
    } as never);

  const a1 = (signals: MetaEntityDecisionSignal) =>
    maybeA1MathFloor({
      window,
      context: purchaseContext,
      cohort: "purchase",
      commercialTargets,
      signals,
    } as never);

  it("B1 ACTS on a complete READY authority with no edit found", () => {
    // The positive control the guard must preserve.
    const rec = b1(campaignSignalWith(READY));
    expect(rec?.type).toBe("scenario_b1_capped_winner_bid_raise");
    expect(rec?.decisionState).toBe("act");
  });

  it("B1 HOLDS on unavailable authority", () => {
    expect(b1(campaignSignalWith(UNAVAILABLE))).toBeNull();
    // And on a signal that predates the contract entirely.
    expect(b1(campaignSignalWith(undefined))).toBeNull();
  });

  it("B1 HOLDS on a real edit under 7 days", () => {
    expect(
      b1(campaignSignalWith(READY, { daysSinceSignificantEdit: 3 })),
    ).toBeNull();
    // 7 days is the boundary and is allowed.
    expect(
      b1(campaignSignalWith(READY, { daysSinceSignificantEdit: 7 }))?.type,
    ).toBe("scenario_b1_capped_winner_bid_raise");
  });

  it("A1 ACTS on a complete READY authority with no edit found", () => {
    const rec = a1(campaignSignalWith(READY));
    expect(rec?.type).toBe("scenario_a1_math_floor_unmet");
    expect(rec?.decisionState).toBe("act");
  });

  it("A1 HOLDS on unavailable authority", () => {
    expect(a1(campaignSignalWith(UNAVAILABLE))).toBeNull();
    expect(a1(campaignSignalWith(undefined))).toBeNull();
  });

  it("A1 HOLDS on a real edit under 7 days", () => {
    expect(
      a1(campaignSignalWith(READY, { daysSinceSignificantEdit: 1 })),
    ).toBeNull();
    expect(
      a1(campaignSignalWith(READY, { daysSinceSignificantEdit: 7 }))?.type,
    ).toBe("scenario_a1_math_floor_unmet");
  });
});

describe("the knowledge clock and the freshness clock are one contract", () => {
  /*
    ── ROUND 14, CONTRACT 3 ──────────────────────────────────────────────────
    Two separate bugs, and they interact:

      - the bound was the provider-local DAY END, which on the current day is
        in the FUTURE. Evidence was admitted that had not happened yet, and an
        age measured back from a future instant is inflated;
      - freshness was measured from `capturedAt`, the ingestion clock, so a
        replay persisted today of an observation Meta answered in March read as
        fresh. `observedAt` is when the provider was actually read.

    Los Angeles on 2026-09-05: the day ends at 07:00Z on the 6th. Evaluating at
    20:00Z on the 5th, the knowledge bound is 20:00Z — not 07:00Z tomorrow.
  */
  const EVAL_NOW = new Date("2026-09-05T20:00:00.000Z");

  it("measures age from observedAt to the KNOWLEDGE bound, not to provider midnight", async () => {
    /*
      35 hours before the knowledge bound is fresh. Measured to the provider
      day end instead it would be 46 hours and stale, so this case fails on the
      old bound as well as on the old clock.
    */
    harness({
      timezone: "America/Los_Angeles",
      history: [],
      receipt: { observed_at: "2026-09-04T09:00:00.000Z", captured_at: "2026-09-04T09:05:00.000Z" },
    });
    const signal = await adsetSignalFromBackfill(EVAL_NOW);
    expect(metaRecentEditAuthority(signal).status).toBe("ready");
    expect(actLane(signal).length).toBeGreaterThan(0);
  });

  it("HOLDS an old provider observation newly persisted today", async () => {
    // The replay case. `capturedAt` is minutes old; `observedAt` is months old.
    // Measuring from `capturedAt` called this fresh.
    harness({
      timezone: "America/Los_Angeles",
      history: [],
      receipt: {
        observed_at: "2026-06-01T09:00:00.000Z",
        captured_at: "2026-09-05T19:59:00.000Z",
      },
    });
    const signal = await adsetSignalFromBackfill(EVAL_NOW);
    expect(metaRecentEditAuthority(signal).reason).toBe(
      "observation_receipt_stale",
    );
    expect(actLane(signal)).toHaveLength(0);
  });

  it("EXCLUDES evidence exactly at the bound and admits 1 ms before it", async () => {
    const atBound = "2026-09-05T20:00:00.000Z";
    harness({
      timezone: "America/Los_Angeles",
      history: [],
      receipt: { observed_at: atBound, captured_at: atBound },
    });
    const held = await adsetSignalFromBackfill(EVAL_NOW);
    expect(metaRecentEditAuthority(held).reason).toBe("receipt_clock_invalid");
    expect(actLane(held)).toHaveLength(0);

    vi.clearAllMocks();
    const justInside = "2026-09-05T19:59:59.999Z";
    harness({
      timezone: "America/Los_Angeles",
      history: [],
      receipt: { observed_at: justInside, captured_at: justInside },
    });
    const ready = await adsetSignalFromBackfill(EVAL_NOW);
    expect(metaRecentEditAuthority(ready).status).toBe("ready");
    expect(actLane(ready).length).toBeGreaterThan(0);
  });

  it("HOLDS a receipt whose clocks are in the future (negative age)", async () => {
    harness({
      timezone: "America/Los_Angeles",
      history: [],
      receipt: {
        observed_at: "2026-09-06T02:00:00.000Z",
        captured_at: "2026-09-06T02:00:00.000Z",
      },
    });
    const signal = await adsetSignalFromBackfill(EVAL_NOW);
    expect(metaRecentEditAuthority(signal).reason).toBe("receipt_clock_invalid");
    expect(actLane(signal)).toHaveLength(0);
  });

  it("HOLDS a provider-local day that has not begun", async () => {
    // Evaluated before the as-of day starts in Los Angeles (07:00Z on the 5th).
    harness({ timezone: "America/Los_Angeles", history: [] });
    const signal = await adsetSignalFromBackfill(
      new Date("2026-09-04T12:00:00.000Z"),
    );
    expect(metaRecentEditAuthority(signal).reason).toBe(
      "provider_local_day_in_future",
    );
    expect(actLane(signal)).toHaveLength(0);
  });

  it("uses ONE evaluation instant for the whole run", async () => {
    /*
      Both entities of one account must be judged against the same "now". The
      seam is the injected instant; if any layer read the wall clock instead,
      two entities could disagree about whether the same receipt was fresh.
    */
    harness({ timezone: "America/Los_Angeles", history: [] });
    const first = await adsetSignalFromBackfill(EVAL_NOW);
    const second = await adsetSignalFromBackfill(EVAL_NOW);
    expect(metaRecentEditAuthority(first)).toEqual(
      metaRecentEditAuthority(second),
    );
  });
});

describe("diagnostic and watch output survives an unavailable authority", () => {
  /*
    THE ANTI-BLANKET-HOLD CONTROL. This round adds refusals to five `act`
    emitters. If those refusals had been applied to the emitter set as a whole,
    an account with a broken sync would go SILENT rather than held — the
    operator would lose the diagnosis along with the action, which is strictly
    worse than the defect.
  */
  function campaignSignalUnavailable(
    over: Partial<MetaEntityDecisionSignal> = {},
  ): MetaEntityDecisionSignal {
    return {
      businessId: BUSINESS,
      providerAccountId: "act_1",
      scopeType: "campaign",
      scopeId: "cmp_1",
      asOfDate: AS_OF,
      learningState: "LEARNING_LIMITED",
      daysAtLearningState: 5,
      lastSignificantEditAt: null,
      daysSinceSignificantEdit: null,
      recentChangeCooldownUntil: null,
      creativeAgeDays: 40,
      creativeAgeDaysMax: 40,
      frequencyP80: null,
      ctrDecayPct: null,
      sourceJson: {
        [META_RECENT_EDIT_AUTHORITY_KEY]: {
          status: "unavailable",
          reason: "sync_run_not_succeeded",
          time_zone: null,
        },
      },
      qualityStatus: "ready",
      ...over,
    };
  }

  it("still emits the tracking diagnosis when hard-action authority is gone", async () => {
    const { emitHighPriorityCampaignScenario } = await import(
      "@/lib/meta/scenario-emitters/high-priority"
    );
    const rec = emitHighPriorityCampaignScenario({
      window: {
        selected: {
          id: "cmp_1",
          name: "Broken sync",
          status: "ACTIVE",
          objective: "OUTCOME_SALES",
          currency: "USD",
          roas: 0.7,
          spend: 800,
          purchases: 2,
          revenue: 560,
          cpa: 400,
          ctr: 1,
          cpm: 30,
          impressions: 30_000,
          clicks: 300,
          frequency: 1.4,
          dailyBudget: 20_000,
          lifetimeBudget: null,
          isBudgetMixed: false,
          ageDays: 40,
          activeDayCount: 40,
          firstDeliveryDate: "2026-07-27",
          asOfDate: AS_OF,
        },
      },
      context: purchaseContext,
      cohort: "purchase",
      commercialTargets,
      signals: campaignSignalUnavailable({
        trackingQualityStatus: "lpv_drop_suspected",
        sourceJson: {
          [META_RECENT_EDIT_AUTHORITY_KEY]: {
            status: "unavailable",
            reason: "sync_run_not_succeeded",
            time_zone: null,
          },
          tracking_quality: {
            link_clicks: 500,
            landing_page_views: 100,
            landing_page_view_rate: 0.2,
          },
        },
      }),
    } as never);
    // A DIAGNOSIS, not an act: the operator still learns what is wrong.
    expect(rec).not.toBeNull();
    expect(rec?.decisionState).not.toBe("act");
  });
});

describe("ONE knowledge bound governs the change window and the authority", () => {
  /*
    ── ROUND 15, DEFECT 1 ────────────────────────────────────────────────────
    The config-history window derived its own end from
    `providerLocalDayEndExclusive` — the FULL provider-local day — while the
    receipt authority used `min(evaluationNow, dayEnd)`. On the current day
    those are different instants: Los Angeles on 2026-09-05 ends at 07:00Z on
    the 6th, but at 20:00Z on the 5th only twenty of its hours have happened.

    So a transition row captured at 22:00Z on the 5th — a replay, a clock skew,
    or an out-of-order writer — entered the 60-day change window and moved
    `daysSinceSignificantEdit`, while the receipt evidence that was supposed to
    justify reading it excluded that very instant. One decision, two bounds.
  */
  const EVAL_NOW = new Date("2026-09-05T20:00:00.000Z");
  const PREDECESSOR = {
    entity_id: "adset_1",
    captured_at: "2026-06-07T12:00:00.000Z",
    daily_budget: 100,
    lifetime_budget: null,
    bid_strategy_type: "lowest_cost",
    optimization_goal: "OFFSITE_CONVERSIONS",
    custom_event_type: "PURCHASE",
    promoted_object_json: null,
  };
  /** After `evaluationNow`, still inside the provider-local day. */
  const FUTURE_TRANSITION = {
    ...PREDECESSOR,
    captured_at: "2026-09-05T22:00:00.000Z",
    daily_budget: 400,
  };

  it("a transition captured AFTER now cannot move daysSinceSignificantEdit", async () => {
    harness({
      timezone: "America/Los_Angeles",
      history: [PREDECESSOR, FUTURE_TRANSITION],
    });
    const signal = await adsetSignalFromBackfill(EVAL_NOW);

    // Under the old bound this read as a 4x budget change today and HELD.
    expect(signal.lastSignificantEditAt).toBeNull();
    expect(signal.daysSinceSignificantEdit).toBeNull();
    expect(metaRecentEditAuthority(signal).status).toBe("ready");
    // THE NO-EDIT ACT CONTROL: a genuinely quiet window still authorises.
    expect(actLane(signal).length).toBeGreaterThan(0);
  });

  it("the same transition DOES govern once the clock has reached it", async () => {
    /*
      The discriminating half. Nothing about the row changed — only the
      evaluation instant. If the window were still bounded by the provider day
      end, both cases would read the same and the case above would prove
      nothing.
    */
    harness({
      timezone: "America/Los_Angeles",
      history: [PREDECESSOR, FUTURE_TRANSITION],
      receipt: { captured_at: "2026-09-05T23:00:00.000Z" },
    });
    const signal = await adsetSignalFromBackfill(
      new Date("2026-09-05T23:30:00.000Z"),
    );
    expect(signal.daysSinceSignificantEdit).toBe(0);
    expect(actLane(signal)).toHaveLength(0);
  });

  it("binds the SAME instant into the config-history query itself", async () => {
    harness({ timezone: "America/Los_Angeles", history: [] });
    await adsetSignalFromBackfill(EVAL_NOW);
    const historyCall = queryCalls().findIndex((text) =>
      text.includes("_config_history"),
    );
    expect(historyCall).toBeGreaterThanOrEqual(0);
    // The bound the query was given is the knowledge bound, not provider
    // midnight. Asserted on the parameter, which is what Postgres actually saw.
    const ends = boundParamsForConfigHistory()?.ends;
    expect(ends?.[0]).toBe("2026-09-05T20:00:00.000Z");
    expect(ends?.[0]).not.toBe("2026-09-06T07:00:00.000Z");
  });

  it("a COMPLETED historical day keeps its own full day end", async () => {
    // Evaluated well after the as-of day closed: the bound is the day end, not
    // a clamp to "now", so a historical recomputation stays point-in-time.
    harness({
      timezone: "America/Los_Angeles",
      history: [],
      receipt: { captured_at: "2026-09-06T06:00:00.000Z" },
    });
    await adsetSignalFromBackfill(new Date("2026-09-20T00:00:00.000Z"));
    expect(boundParamsForConfigHistory()?.ends?.[0]).toBe(
      "2026-09-06T07:00:00.000Z",
    );
  });
});

describe("the exact sync attempt is point-in-time safe", () => {
  /*
    ── ROUND 15, DEFECT 3 ────────────────────────────────────────────────────
    A success recorded AFTER the cutoff cannot authorise a decision AT the
    cutoff: the work it attests happened outside the point in time being
    reconstructed. On a historical recomputation that would let today's
    successful sync retroactively authorise an old day.
  */
  const EVAL_NOW = new Date("2026-09-05T20:00:00.000Z");

  it("HOLDS when the attempt finished exactly at the knowledge bound", async () => {
    harness({
      timezone: "America/Los_Angeles",
      history: [],
      syncRun: { finished_at: "2026-09-05T20:00:00.000Z" },
    });
    const signal = await adsetSignalFromBackfill(EVAL_NOW);
    expect(metaRecentEditAuthority(signal).reason).toBe(
      "sync_run_finished_after_knowledge",
    );
    expect(actLane(signal)).toHaveLength(0);
  });

  it("is eligible when the attempt finished 1 ms before the bound", async () => {
    harness({
      timezone: "America/Los_Angeles",
      history: [],
      syncRun: { finished_at: "2026-09-05T19:59:59.999Z" },
    });
    const signal = await adsetSignalFromBackfill(EVAL_NOW);
    expect(metaRecentEditAuthority(signal).status).toBe("ready");
    expect(actLane(signal).length).toBeGreaterThan(0);
  });

  it("HOLDS a receipt whose occurrence falls outside its own attempt", async () => {
    /*
      CROSS-ATTEMPT TIMESTAMPS. The partition is shared, so a receipt could be
      bound to a run that was not doing this work. A receipt captured before its
      attempt started, or after it finished, is that mismatch.
    */
    for (const syncRun of [
      // The attempt started after the receipt was captured.
      { started_at: "2026-09-05T15:00:00.000Z", finished_at: "2026-09-05T16:00:00.000Z" },
      // The attempt finished before the receipt was captured.
      { started_at: "2026-09-05T08:00:00.000Z", finished_at: "2026-09-05T09:00:00.000Z" },
      // No start clock at all.
      { started_at: null, finished_at: "2026-09-05T13:00:00.000Z" },
    ]) {
      vi.clearAllMocks();
      harness({ timezone: "America/Los_Angeles", history: [], syncRun });
      const signal = await adsetSignalFromBackfill(EVAL_NOW);
      expect(
        metaRecentEditAuthority(signal).reason,
        JSON.stringify(syncRun),
      ).toBe("sync_run_lifecycle_mismatch");
      expect(actLane(signal), JSON.stringify(syncRun)).toHaveLength(0);
    }
  });
});
