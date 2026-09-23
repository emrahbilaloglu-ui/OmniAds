/**
 * REPAIR the ad-grain link-click column from the row's OWN stored payload.
 *
 * ── The defect this repairs ──────────────────────────────────────────────────
 * `lib/api/meta.ts` is the only production writer of `meta_ad_daily.link_clicks`
 * (`upsertMetaAdDailyRows` and `replaceMetaAdDailySlice` are both fed from the
 * `adRows` it builds). For every ad-day it has ever written it supplied a
 * literal `0` — a number typed on the provider's behalf, not a measurement —
 * and the ON CONFLICT clause read
 * `COALESCE(EXCLUDED.link_clicks, 0, meta_ad_daily.link_clicks)`, whose middle
 * literal made the "keep what is stored" arm unreachable. The correction
 * changed the bind to `null` and the merge to two arguments, which stopped the
 * fabrication going forward and left the column NULL.
 *
 * Forward-only accrual is NOT closure. The engine's fatigue verdict needs the
 * equal, disjoint, directly adjacent 14/14 pair, and
 * `admitCompositeBand` in `lib/creative-decision-engine/jobs/ad-decisions-job.ts`
 * rejects a band with `ad_<label>_window_link_clicks_unavailable` unless the
 * band's link-click total is finite and positive. A forward-only fix cannot
 * produce a usable pair until BOTH bands have accrued, and the preceding band
 * would still be the fabricated zeros. Measured on production through the
 * read-only tunnel on 2026-09-07, for the band pair ending 2026-09-06:
 *
 *     band      rows  absent  fill(count)  fill(zero)  unmeasurable  fabricated-0
 *     prior14   5367    2521         1557         538           426          1692
 *     recent14  5383    5383         3182        1172          1029             0
 *
 * ── Why no provider call ─────────────────────────────────────────────────────
 * The measurement is already in the database. The ad-level insights request
 * asks for `actions` (see the field list in `lib/api/meta.ts`), and
 * `target.payloadJson = row` stores that whole insight row, so ~81% of the
 * rows whose column is NULL carry their own `{"action_type":"link_click",
 * "value":"141"}` entry inside `payload_json`. This command projects that
 * stored measurement into the column. It contacts Meta never, spends no API
 * quota, and cannot invent a number the row did not already carry.
 *
 * The residual — a row whose `payload_json` has no `actions` array at all —
 * is NOT repairable from storage and is reported as such rather than filled.
 * A dated provider re-read is an investigation path, not a guaranteed repair:
 * on 2026-09-22 all 93 such TheSwaf rows in one two-band preview were returned
 * again with matching spend/impressions and still no `actions` array. Meta
 * separately returned `inline_link_clicks: "0"`, but that is a distinct field
 * whose attribution scope has not been established as interchangeable with
 * this column's `actions.link_click` source. The authoritative sync path
 * (`syncMetaRepairRange`) requests the same `actions` field, so merely
 * re-queuing those days has no demonstrated ability to close this residual.
 *
 * ── Why this is not a second owner of the table ──────────────────────────────
 * D066 makes `meta_ad_daily` fact storage owned by authoritative insights sync,
 * and `lib/meta/ad-daily-write-ownership.test.ts` pins that. This command does
 * not introduce a competing source of truth: every value it writes is read out
 * of the authoritative payload the authoritative writer itself persisted on
 * that same row. It writes exactly ONE column — `link_clicks` — and
 * `assertSingleColumnRepairStatement` fails the run if a future edit widens the
 * SET list: never a fact column, never `truth_state`, never `truth_version`,
 * and, contrary to what this header used to claim, never `updated_at` either.
 * `LINK_CLICK_REPAIR_UPDATE_SQL` does not set it and no trigger on this table
 * does. That omission is deliberate and load-bearing, not an oversight: the
 * repair, decision hydration and the readback verifier all admit a row on
 * `created_at <= cutoff AND updated_at <= cutoff`, so stamping `updated_at`
 * with the repair clock would push every repaired row out of the very
 * population the repair exists to complete. It does not round-trip the row through `upsertMetaAdDailyRows`
 * precisely because that would rewrite forty fact columns to repair one.
 *
 * ── Bounds ───────────────────────────────────────────────────────────────────
 * Dry run by default; `--execute`, `ADSECUTE_LINK_CLICK_REPAIR_EXECUTE=1`, and
 * the reviewed dry-run manifest hash are all required before a single row is
 * written. One business per run, an
 * explicit account list or every account with rows in the window, a window that
 * is always the two-band pair (so "filled only the recent band" is not a
 * reachable state), a hard row ceiling, keyset pagination with a strictly
 * advancing cursor, a page-count ceiling derived from the row ceiling, and a
 * bounded retry with a bounded total backoff.
 *
 * Usage:
 *   node --import tsx scripts/meta/link-click-repair-backfill.ts \
 *     --business <businessId> [--account act_123 ...] [--as-of YYYY-MM-DD] \
 *     [--admissibility-cutoff YYYY-MM-DDTHH:mm:ss.sssZ] \
 *     [--band-days 14] [--max-rows 5000] [--page-size 500] [--max-attempts 3] \
 *     [--skip-measured-zero] [--allow-partial] [--receipt-out <path>] \
 *     [--execute --expected-manifest-hash <sha256>]
 */
import { parseMetaLinkClickValue } from "@/lib/meta/link-click-parse";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { configureOperationalScriptRuntime } from "../_operational-runtime";

/** Thrown for anything the operator can fix by re-typing the command. */
export class LinkClickRepairUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkClickRepairUsageError";
  }
}

/**
 * Every ceiling in one place, so "is this bounded?" is answerable by reading a
 * single object rather than by auditing the parser.
 */
export const LINK_CLICK_REPAIR_BOUNDS = {
  bandDaysDefault: 14,
  bandDaysMin: 1,
  bandDaysMax: 28,
  maxRowsDefault: 5_000,
  maxRowsMin: 1,
  maxRowsCeiling: 50_000,
  pageSizeDefault: 500,
  pageSizeMin: 1,
  pageSizeCeiling: 2_000,
  maxAttemptsDefault: 3,
  maxAttemptsMin: 1,
  maxAttemptsCeiling: 5,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 2_000,
  maxAccounts: 100,
} as const;

/** The environment lock that must accompany `--execute`. */
export const LINK_CLICK_REPAIR_EXECUTE_ENV = "ADSECUTE_LINK_CLICK_REPAIR_EXECUTE";
export const LINK_CLICK_REPAIR_MANIFEST_CONTRACT =
  "adsecute.meta-link-click-repair-manifest.v1" as const;

export interface LinkClickRepairOptions {
  businessId: string;
  /** Null means "every provider account with rows in the window". */
  providerAccountIds: string[] | null;
  asOfDate: string;
  bandDays: number;
  /**
   * The point-in-time the repair reads AS OF.
   *
   * The scan applies the SAME four-predicate admissibility contract decision
   * hydration applies — finalized, validation passed, and both row clocks at
   * or before this instant — so the repair cannot rewrite a row the engine
   * will never read: a provisional capture, a failed validation, or a row
   * recorded after the cutoff the decision was taken at.
   */
  admissibilityCutoff: string;
  maxRows: number;
  pageSize: number;
  maxAttempts: number;
  execute: boolean;
  /** Reviewed dry-run plan identity; required by the CLI in execute mode. */
  expectedManifestHash: string | null;
  /** Refuse to write a plan that hit the row ceiling unless this is set. */
  allowPartial: boolean;
  /** Skip the "actions array present, no link_click entry" -> 0 inference. */
  skipMeasuredZero: boolean;
  receiptOutPath: string | null;
}

export interface LinkClickRepairBand {
  key: "prior14" | "recent14";
  startDate: string;
  endDate: string;
}

export interface LinkClickRepairScope {
  /** Inclusive first day of the pair — the prior band's start. */
  windowStartDate: string;
  /** Inclusive last day of the pair — the recent band's end, i.e. `asOfDate`. */
  windowEndDate: string;
  prior: LinkClickRepairBand;
  recent: LinkClickRepairBand;
}

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Midnight UTC of a `YYYY-MM-DD`, or null when it is not one. */
function parseIsoDateMs(value: string): number | null {
  if (!ISO_DATE.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return null;
  // Date.parse accepts 2026-02-31 and rolls it forward; a rolled date would
  // silently move the whole window, so the round trip has to agree.
  return new Date(parsed).toISOString().slice(0, 10) === value ? parsed : null;
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The two equal, disjoint, directly adjacent bands, from the as-of day
 * backwards.
 *
 * The pair IS the scope: there is no free-form `--start`/`--end`, because a
 * range that covers only the recent band would leave the comparison impossible
 * and `admitCompositeBand` would still withhold. Adjacency is arithmetic here
 * for the same reason it is arithmetic there — `prior.endDate` is the calendar
 * day before `recent.startDate`, with no overlap and no gap.
 */
export function planLinkClickRepairScope(input: {
  asOfDate: string;
  bandDays: number;
}): LinkClickRepairScope {
  const asOfMs = parseIsoDateMs(input.asOfDate);
  if (asOfMs === null) {
    throw new LinkClickRepairUsageError(
      `--as-of must be a real YYYY-MM-DD date; received ${JSON.stringify(input.asOfDate)}.`,
    );
  }
  const { bandDaysMin, bandDaysMax } = LINK_CLICK_REPAIR_BOUNDS;
  if (
    !Number.isInteger(input.bandDays) ||
    input.bandDays < bandDaysMin ||
    input.bandDays > bandDaysMax
  ) {
    throw new LinkClickRepairUsageError(
      `--band-days must be an integer in [${bandDaysMin}, ${bandDaysMax}]; received ${JSON.stringify(input.bandDays)}.`,
    );
  }
  const recentEndMs = asOfMs;
  const recentStartMs = recentEndMs - (input.bandDays - 1) * MS_PER_DAY;
  const priorEndMs = recentStartMs - MS_PER_DAY;
  const priorStartMs = priorEndMs - (input.bandDays - 1) * MS_PER_DAY;
  return {
    windowStartDate: toIsoDate(priorStartMs),
    windowEndDate: toIsoDate(recentEndMs),
    prior: {
      key: "prior14",
      startDate: toIsoDate(priorStartMs),
      endDate: toIsoDate(priorEndMs),
    },
    recent: {
      key: "recent14",
      startDate: toIsoDate(recentStartMs),
      endDate: toIsoDate(recentEndMs),
    },
  };
}

/** Which band a date falls in, or null when it is outside the pair. */
export function bandKeyForDate(
  scope: LinkClickRepairScope,
  date: string,
): "prior14" | "recent14" | null {
  if (date >= scope.recent.startDate && date <= scope.recent.endDate) {
    return "recent14";
  }
  if (date >= scope.prior.startDate && date <= scope.prior.endDate) {
    return "prior14";
  }
  return null;
}

function requireIntegerFlag(
  raw: string,
  flag: string,
  min: number,
  max: number,
): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new LinkClickRepairUsageError(
      `${flag} must be an integer; received ${JSON.stringify(raw)}.`,
    );
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new LinkClickRepairUsageError(
      `${flag} must be in [${min}, ${max}]; received ${value}.`,
    );
  }
  return value;
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new LinkClickRepairUsageError(`${flag} requires a value.`);
  }
  return value;
}

/**
 * Strict argv parsing. An unknown flag is an error rather than a shrug: a
 * mistyped `--max-row` that silently kept the default would let an operator
 * believe a bound was applied that was not.
 */
export function parseLinkClickRepairArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  today: () => string = () => new Date().toISOString().slice(0, 10),
): LinkClickRepairOptions {
  const bounds = LINK_CLICK_REPAIR_BOUNDS;
  let businessId: string | null = null;
  const providerAccountIds: string[] = [];
  let asOfDate: string | null = null;
  let admissibilityCutoff: string | null = null;
  let bandDays: number = bounds.bandDaysDefault;
  let maxRows: number = bounds.maxRowsDefault;
  let pageSize: number = bounds.pageSizeDefault;
  let maxAttempts: number = bounds.maxAttemptsDefault;
  let execute = false;
  let expectedManifestHash: string | null = null;
  let allowPartial = false;
  let skipMeasuredZero = false;
  let receiptOutPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--business":
        businessId = takeValue(argv, index, "--business");
        index += 1;
        break;
      case "--account":
        providerAccountIds.push(takeValue(argv, index, "--account"));
        index += 1;
        break;
      case "--as-of":
        asOfDate = takeValue(argv, index, "--as-of");
        index += 1;
        break;
      case "--admissibility-cutoff":
        admissibilityCutoff = takeValue(argv, index, "--admissibility-cutoff");
        index += 1;
        break;
      case "--band-days":
        bandDays = requireIntegerFlag(
          takeValue(argv, index, "--band-days"),
          "--band-days",
          bounds.bandDaysMin,
          bounds.bandDaysMax,
        );
        index += 1;
        break;
      case "--max-rows":
        maxRows = requireIntegerFlag(
          takeValue(argv, index, "--max-rows"),
          "--max-rows",
          bounds.maxRowsMin,
          bounds.maxRowsCeiling,
        );
        index += 1;
        break;
      case "--page-size":
        pageSize = requireIntegerFlag(
          takeValue(argv, index, "--page-size"),
          "--page-size",
          bounds.pageSizeMin,
          bounds.pageSizeCeiling,
        );
        index += 1;
        break;
      case "--max-attempts":
        maxAttempts = requireIntegerFlag(
          takeValue(argv, index, "--max-attempts"),
          "--max-attempts",
          bounds.maxAttemptsMin,
          bounds.maxAttemptsCeiling,
        );
        index += 1;
        break;
      case "--receipt-out":
        receiptOutPath = takeValue(argv, index, "--receipt-out");
        index += 1;
        break;
      case "--expected-manifest-hash":
        expectedManifestHash = takeValue(argv, index, "--expected-manifest-hash");
        index += 1;
        break;
      case "--execute":
        execute = true;
        break;
      case "--allow-partial":
        allowPartial = true;
        break;
      case "--skip-measured-zero":
        skipMeasuredZero = true;
        break;
      default:
        throw new LinkClickRepairUsageError(`Unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  if (!businessId || !businessId.trim()) {
    throw new LinkClickRepairUsageError(
      "--business <businessId> is required; this command never runs across every business.",
    );
  }
  if (providerAccountIds.length > bounds.maxAccounts) {
    throw new LinkClickRepairUsageError(
      `--account may be repeated at most ${bounds.maxAccounts} times; received ${providerAccountIds.length}.`,
    );
  }
  const duplicateAccount = providerAccountIds.find(
    (value, position) => providerAccountIds.indexOf(value) !== position,
  );
  if (duplicateAccount) {
    throw new LinkClickRepairUsageError(
      `--account ${JSON.stringify(duplicateAccount)} was passed twice.`,
    );
  }
  if (pageSize > maxRows) {
    // Not fatal arithmetic, but a page larger than the ceiling means the very
    // first page can overshoot the bound the operator asked for.
    pageSize = maxRows;
  }
  // Validated here so a bad --as-of fails before anything opens a connection.
  planLinkClickRepairScope({ asOfDate: asOfDate ?? today(), bandDays });
  if (admissibilityCutoff !== null) {
    const parsed = Date.parse(admissibilityCutoff);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(admissibilityCutoff)
      || !Number.isFinite(parsed)
      || new Date(parsed).toISOString() !== admissibilityCutoff) {
      throw new LinkClickRepairUsageError(
        "--admissibility-cutoff must be an exact UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ).",
      );
    }
  }

  if (execute && env[LINK_CLICK_REPAIR_EXECUTE_ENV] !== "1") {
    throw new LinkClickRepairUsageError(
      `--execute also requires ${LINK_CLICK_REPAIR_EXECUTE_ENV}=1. Two independent gestures are deliberate: this process resolves DATABASE_URL from .env.local, which in this repository points at PRODUCTION.`,
    );
  }
  if (execute && !/^[a-f0-9]{64}$/.test(expectedManifestHash ?? "")) {
    throw new LinkClickRepairUsageError(
      "--execute requires --expected-manifest-hash <64-character lowercase SHA-256> from the reviewed dry run.",
    );
  }
  if (!execute && expectedManifestHash !== null) {
    throw new LinkClickRepairUsageError(
      "--expected-manifest-hash is accepted only with --execute.",
    );
  }

  return {
    businessId: businessId.trim(),
    providerAccountIds: providerAccountIds.length > 0 ? providerAccountIds : null,
    asOfDate: asOfDate ?? today(),
    bandDays,
    /*
      Report day and warehouse knowledge cutoff are separate clocks. The
      historical default retains prior preview behavior; an explicit later
      cutoff admits finalized rows that arrived after the report day for a
      present-day restatement. The receipt names the exact cutoff used.
    */
    admissibilityCutoff:
      admissibilityCutoff ?? `${asOfDate ?? today()}T23:59:59.999Z`,
    maxRows,
    pageSize,
    maxAttempts,
    execute,
    expectedManifestHash,
    allowPartial,
    skipMeasuredZero,
    receiptOutPath,
  };
}

/**
 * The page-count ceiling. Derived from the row ceiling rather than configured,
 * so no flag combination can buy more pages than rows.
 */
export function maxPageCountFor(maxRows: number, pageSize: number): number {
  return Math.ceil(maxRows / Math.max(1, pageSize)) + 1;
}

export type LinkClickRepairAction =
  /** `payload_json` has no `actions` array: nothing was measured, nothing is written. */
  | "unmeasurable_no_actions_payload"
  /** Column NULL, payload carries a `link_click` entry: write the entry's count. */
  | "fill_measured_count"
  /** Column NULL, actions array present with no `link_click` entry: write 0. */
  | "fill_measured_zero"
  /** Payload proves measured zero, but the operator asked not to write it. */
  | "skipped_measured_zero"
  /** Column 0, payload proves a positive count: the stored 0 is a fabrication. */
  | "correct_fabricated_zero"
  /** Stored value already equals the payload's. */
  | "already_consistent"
  /** Stored positive disagrees with the payload; a human decides, not this script. */
  | "conflict_stored_measurement"
  /** Stored 0 with no actions array: a fabrication we cannot disprove row-locally. */
  | "stored_zero_unprovable"
  /** Stored positive with no actions array: nothing to corroborate it against. */
  | "stored_positive_unverifiable"
  /** The `link_click` entry's value is not a non-negative integer. */
  | "malformed_actions_value";

export interface LinkClickRepairClassification {
  action: LinkClickRepairAction;
  /** The value to write, or null when this row is not written. */
  writeValue: number | null;
  /** What the payload says the count is, when it says anything at all. */
  derived: number | null;
}

/**
 * Decide, for one ad-day, what the stored payload authorizes.
 *
 * ABSENT vs MEASURED ZERO is the whole point of this function.
 *
 *  - `actionsPresent === false` means `payload_json` carries no `actions` array.
 *    Nothing about link clicks was observed for that row, so the column stays
 *    NULL. Writing 0 here would be the exact fabrication this repair exists to
 *    undo, one layer down.
 *  - `actionsPresent === true` with no `link_click` entry is a MEASURED ZERO.
 *    Meta's `actions` breakdown omits action types whose count is zero, so an
 *    array that was returned and does not list `link_click` is the provider
 *    saying "zero" in its own encoding. This is still the riskiest inference in
 *    the file, which is why it is a separately named action, separately
 *    counted, and switchable off with `--skip-measured-zero`.
 *
 * Nothing here ever lowers a stored positive: a stored measurement that the
 * payload contradicts is reported as a conflict and left alone.
 */
export function classifyAdDayLinkClick(input: {
  storedLinkClicks: number | null;
  actionsPresent: boolean;
  /** Raw string values of each entry; non-string JSON values arrive as null. */
  linkClickValues: unknown[];
  skipMeasuredZero?: boolean;
}): LinkClickRepairClassification {
  const stored = input.storedLinkClicks;

  if (!input.actionsPresent) {
    if (stored === null) {
      return { action: "unmeasurable_no_actions_payload", writeValue: null, derived: null };
    }
    if (stored === 0) {
      return { action: "stored_zero_unprovable", writeValue: null, derived: null };
    }
    return { action: "stored_positive_unverifiable", writeValue: null, derived: null };
  }

  let derived: number | null = null;
  if (input.linkClickValues.length > 0) {
    // More than one entry is a payload shape this code has never seen; the
    // production sample on 2026-09-07 had exactly one per row. Rather than pick
    // one, refuse and report.
    if (input.linkClickValues.length > 1) {
      return { action: "malformed_actions_value", writeValue: null, derived: null };
    }
    // The SAME parser forward ingestion uses (Codex B16): one definition of
    // what a link-click measurement is, so a value one path admits is not a
    // value the other calls malformed.
    const parsed = parseMetaLinkClickValue(input.linkClickValues[0]);
    if (!parsed.ok) {
      return { action: "malformed_actions_value", writeValue: null, derived: null };
    }
    derived = parsed.value;
  } else {
    if (input.skipMeasuredZero) {
      if (stored === null) {
        return {
          action: "skipped_measured_zero",
          writeValue: null,
          derived: 0,
        };
      }
      if (stored === 0) {
        return { action: "already_consistent", writeValue: null, derived: 0 };
      }
      return {
        action: "conflict_stored_measurement",
        writeValue: null,
        derived: 0,
      };
    }
    derived = 0;
  }

  if (stored === null) {
    return {
      action: derived > 0 ? "fill_measured_count" : "fill_measured_zero",
      writeValue: derived,
      derived,
    };
  }
  if (stored === derived) {
    return { action: "already_consistent", writeValue: null, derived };
  }
  if (stored === 0 && derived > 0) {
    return { action: "correct_fabricated_zero", writeValue: derived, derived };
  }
  return { action: "conflict_stored_measurement", writeValue: null, derived };
}

/** Every action name, so a report can print a complete, stable tally. */
export const LINK_CLICK_REPAIR_ACTIONS: LinkClickRepairAction[] = [
  "fill_measured_count",
  "fill_measured_zero",
  "skipped_measured_zero",
  "correct_fabricated_zero",
  "already_consistent",
  "unmeasurable_no_actions_payload",
  "stored_zero_unprovable",
  "stored_positive_unverifiable",
  "conflict_stored_measurement",
  "malformed_actions_value",
];

export function emptyActionTally(): Record<LinkClickRepairAction, number> {
  const tally = {} as Record<LinkClickRepairAction, number>;
  for (const action of LINK_CLICK_REPAIR_ACTIONS) tally[action] = 0;
  return tally;
}

/** An action that results in a write. */
export function isWritingAction(action: LinkClickRepairAction): boolean {
  return (
    action === "fill_measured_count" ||
    action === "fill_measured_zero" ||
    action === "correct_fabricated_zero"
  );
}

/** Rows whose stored payload cannot establish a trustworthy measurement. */
export function requiresProviderResync(action: LinkClickRepairAction): boolean {
  return (
    action === "unmeasurable_no_actions_payload" ||
    action === "stored_zero_unprovable" ||
    action === "malformed_actions_value"
  );
}

export interface LinkClickRepairCursor {
  providerAccountId: string;
  date: string;
  adId: string;
}

/**
 * Keyset ordering over the unique index
 * `(business_id, provider_account_id, date, ad_id)`.
 *
 * The cursor MUST advance strictly. A repeated page — from a mis-typed
 * comparison, or a row whose key sorts equal to the cursor — is the shape a
 * runaway takes, and it would look like healthy progress in the log.
 */
export function cursorAdvanced(
  previous: LinkClickRepairCursor | null,
  next: LinkClickRepairCursor,
): boolean {
  if (!previous) return true;
  if (next.providerAccountId !== previous.providerAccountId) {
    return next.providerAccountId > previous.providerAccountId;
  }
  if (next.date !== previous.date) return next.date > previous.date;
  return next.adId > previous.adId;
}

/**
 * The only statement in this file that mutates a row.
 *
 * The projection, source-snapshot and raw-actions pre-image guards make a
 * concurrent authoritative sync safe: if the owner changed any reviewed
 * evidence between this command's read and write, the row is not updated. The
 * executor treats that RETURNING gap as a manifest drift and rolls the whole
 * transaction back rather than committing a partial reviewed plan.
 */
export const LINK_CLICK_REPAIR_UPDATE_SQL = `
    UPDATE meta_ad_daily AS d
    SET link_clicks = v.new_link_clicks
    FROM (
      SELECT *
      FROM unnest(
        $2::text[], $3::date[], $4::text[], $5::bigint[], $6::bigint[],
        $7::uuid[], $8::text[]
      ) AS t(
        provider_account_id, date, ad_id, new_link_clicks, pre_image,
        source_snapshot_id, actions_pre_image
      )
    ) AS v
    WHERE d.business_id = $1
      AND d.provider_account_id = v.provider_account_id
      AND d.date = v.date
      AND d.ad_id = v.ad_id
      AND d.link_clicks IS NOT DISTINCT FROM v.pre_image
      AND d.source_snapshot_id IS NOT DISTINCT FROM v.source_snapshot_id
      AND COALESCE((d.payload_json->'actions')::text, '') = v.actions_pre_image
      AND d.truth_state = 'finalized'
      AND d.validation_status = 'passed'
      AND d.created_at <= $9::timestamptz
      AND d.updated_at <= $9::timestamptz
    RETURNING d.provider_account_id, d.date::text AS date, d.ad_id
  `;

/**
 * Fails the run if the SET list ever grows past the one repaired column.
 *
 * This is the mechanical half of "this is not a second owner of the table". A
 * future edit that adds `truth_version` or a fact column to the SET list turns
 * a projection repair into a competing writer, and D066 would be violated by a
 * diff nobody read closely. Here it just stops.
 */
export function assertSingleColumnRepairStatement(statement: string): void {
  const match = /\bSET\b([\s\S]*?)\bFROM\b/i.exec(statement);
  if (!match) {
    throw new Error("link_click_repair_statement_shape_unrecognized");
  }
  const assigned = match[1]!
    .split(",")
    .map((clause) => clause.trim().split(/\s*=/)[0]!.trim())
    .filter((name) => name.length > 0);
  const expected = ["link_clicks"];
  const matches =
    assigned.length === expected.length &&
    assigned.every((name, position) => name === expected[position]);
  if (!matches) {
    throw new Error(
      `link_click_repair_statement_writes_unexpected_columns: ${JSON.stringify(assigned)}`,
    );
  }
}

/**
 * The candidate page. `link_clicks IS NULL OR link_clicks = 0` is the only
 * repairable shape: a stored positive is a measurement this command never
 * touches, so it is not even fetched.
 *
 * `$4::text[]` is NULL for "every account in the window"; `= ANY(NULL)` would
 * match nothing, so the null check is explicit.
 */
export const LINK_CLICK_REPAIR_PAGE_SQL = `
    SELECT
      d.provider_account_id,
      d.date::text AS date,
      d.ad_id,
      d.source_snapshot_id::text AS source_snapshot_id,
      COALESCE((d.payload_json->'actions')::text, '') AS actions_pre_image,
      d.link_clicks::text AS stored_link_clicks,
      COALESCE(jsonb_typeof(d.payload_json->'actions') = 'array', false) AS actions_present,
      CASE
        WHEN jsonb_typeof(d.payload_json->'actions') = 'array'
        THEN ARRAY(
          SELECT CASE
            WHEN jsonb_typeof(a->'value') = 'string' THEN a->>'value'
            ELSE NULL
          END
          FROM jsonb_array_elements(d.payload_json->'actions') AS a
          WHERE a->>'action_type' = 'link_click'
        )
        ELSE ARRAY[]::text[]
      END AS link_click_values
    FROM meta_ad_daily AS d
    WHERE d.business_id = $1
      AND d.date BETWEEN $2::date AND $3::date
      AND ($4::text[] IS NULL OR d.provider_account_id = ANY($4::text[]))
      AND (d.link_clicks IS NULL OR d.link_clicks = 0)
      -- THE SAME ADMISSIBILITY CONTRACT DECISION HYDRATION APPLIES.
      --
      -- The repair selected any row in the window, so it could rewrite a row
      -- the engine will never read: a provisional capture, one whose
      -- validation failed, or one recorded after the cutoff the decision was
      -- taken at. Repairing an inadmissible row is at best wasted work and at
      -- worst a silent edit to a capture that is still being reconciled.
      -- These are the same four predicates as the ad-day admission in
      -- HYDRATE_AD_DECISION_INPUTS_QUERY.
      AND d.truth_state = 'finalized'
      AND d.validation_status = 'passed'
      AND d.created_at <= $9::timestamptz
      AND d.updated_at <= $9::timestamptz
      AND (
        $5::text IS NULL
        OR (d.provider_account_id, d.date, d.ad_id) > ($5::text, $6::date, $7::text)
      )
    ORDER BY d.provider_account_id, d.date, d.ad_id
    LIMIT $8
  `;

interface PageRow {
  provider_account_id: string;
  date: string;
  ad_id: string;
  source_snapshot_id?: string | null;
  actions_pre_image: string;
  stored_link_clicks: string | null;
  actions_present: boolean;
  link_click_values: unknown[];
}

export interface LinkClickRepairBandReport {
  band: "prior14" | "recent14";
  startDate: string;
  endDate: string;
  candidatesExamined: number;
  rowsPlanned: number;
  rowsWritten: number;
  rowsSkippedByPreImageDrift: number;
  actions: Record<LinkClickRepairAction, number>;
}

export interface LinkClickRepairAccountReport {
  providerAccountId: string;
  bands: LinkClickRepairBandReport[];
}

export interface LinkClickRepairResult {
  mode: "dry_run" | "execute";
  businessId: string;
  scope: LinkClickRepairScope;
  /**
   * The as-of instant this run read the table at.
   *
   * Recorded on the receipt because it is part of the scope: two runs over the
   * same dates at different cutoffs saw different populations, and the
   * readback verifier refuses a receipt whose cutoff is not its own rather
   * than attributing one population's counts to another's.
   */
  admissibilityCutoff: string;
  providerAccountIdsRequested: string[] | null;
  bounds: {
    maxRows: number;
    pageSize: number;
    maxPages: number;
    maxAttempts: number;
  };
  pagesRead: number;
  candidatesExamined: number;
  rowsPlanned: number;
  rowsWritten: number;
  rowsSkippedByPreImageDrift: number;
  /** True when the row ceiling stopped the scan before the window was exhausted. */
  truncatedByMaxRows: boolean;
  accounts: LinkClickRepairAccountReport[];
  actions: Record<LinkClickRepairAction, number>;
  /** Rows whose stored payload cannot repair; provider re-read may also omit actions. */
  residualNeedingProviderResync: number;
  manifestContract: typeof LINK_CLICK_REPAIR_MANIFEST_CONTRACT;
  manifestHash: string;
  /** Hash supplied by the reviewed dry run, present only for an execute. */
  reviewedManifestHash: string | null;
  manifest: Array<{
    providerAccountId: string;
    date: string;
    adId: string;
    field: "link_clicks";
    oldValue: number | null;
    newValue: number;
    source: {
      kind: "meta_ad_daily.payload_json.actions";
      sourceSnapshotId: string | null;
      actionsSha256: string;
    };
    reason: LinkClickRepairAction;
  }>;
}

/** Minimal shape this command needs from a database client. */
export interface LinkClickRepairDb {
  query<TRow>(text: string, values: unknown[]): Promise<TRow[]>;
  /**
   * Runs `fn` inside ONE transaction on ONE pinned client.
   *
   * Required before any write. The executor previously issued
   * `BEGIN` / `UPDATE` / `COMMIT` as separate `getDb().query` calls, and a pool
   * hands out a different client per query — so the `BEGIN` could open on one
   * connection, the updates run outside any transaction on others, and the
   * `COMMIT` close an empty transaction somewhere else entirely. A failure
   * part-way then left the earlier batches permanently applied, which is the
   * opposite of what the surrounding validate-before-write exists to
   * guarantee.
   *
   * The `tx` handed to `fn` is the ONLY handle that may be used inside it.
   * Absent here, the repair refuses to execute rather than writing unpinned.
   */
  transaction?<T>(fn: (tx: LinkClickRepairDb) => Promise<T>): Promise<T>;
}

/**
 * Retryable errors, deliberately narrow.
 *
 * The code list mirrors `isConnectionDbError` in `lib/db.ts`, which is not
 * exported; it is restated rather than imported so this file does not reach
 * into another module's private helper. A syntax error, a permission error or
 * a constraint violation is NOT retried — repeating them buys nothing and
 * multiplies load on a database that just said no.
 */
export function isRetryableRepairError(error: unknown): boolean {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    code === "08001" ||
    code === "08006" ||
    code === "53300" ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    message.includes("Connection terminated unexpectedly") ||
    message.includes("terminating connection") ||
    message.includes("connection closed") ||
    message.includes("timeout exceeded when trying to connect")
  );
}

/** Bounded exponential backoff, capped by `retryMaxDelayMs`. */
export function retryDelayMsFor(attempt: number): number {
  const { retryBaseDelayMs, retryMaxDelayMs } = LINK_CLICK_REPAIR_BOUNDS;
  return Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** Math.max(0, attempt - 1));
}

async function withBoundedRetry<T>(
  label: string,
  maxAttempts: number,
  run: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isRetryableRepairError(error) || attempt === maxAttempts) break;
      await sleep(retryDelayMsFor(attempt));
    }
  }
  throw new Error(
    `link_click_repair_${label}_failed_after_${maxAttempts}_attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function emptyBandReport(band: LinkClickRepairBand): LinkClickRepairBandReport {
  return {
    band: band.key,
    startDate: band.startDate,
    endDate: band.endDate,
    candidatesExamined: 0,
    rowsPlanned: 0,
    rowsWritten: 0,
    rowsSkippedByPreImageDrift: 0,
    actions: emptyActionTally(),
  };
}

/** Strict `bigint`-as-text to number, refusing anything that is not one. */
export function parseStoredLinkClicks(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`link_click_repair_unparseable_stored_value: ${JSON.stringify(raw)}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`link_click_repair_unsafe_stored_value: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Read candidates page by page, classify each one, and (only under `--execute`)
 * write the rows the stored payload authorizes.
 *
 * A complete bounded plan is validated before any write. Its field-level
 * manifest makes the source and old/new value of every proposed edit visible.
 */
export async function runLinkClickRepair(input: {
  db: LinkClickRepairDb;
  options: LinkClickRepairOptions;
  sleep?: (ms: number) => Promise<void>;
}): Promise<LinkClickRepairResult> {
  const { db, options } = input;
  if (options.execute && !/^[a-f0-9]{64}$/.test(options.expectedManifestHash ?? "")) {
    throw new Error(
      "link_click_repair_manifest_hash_required: execute requires the reviewed dry-run SHA-256. Nothing was written.",
    );
  }
  if (!options.execute && options.expectedManifestHash !== null) {
    throw new Error(
      "link_click_repair_manifest_hash_without_execute: a reviewed hash is valid only for execute mode.",
    );
  }
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  assertSingleColumnRepairStatement(LINK_CLICK_REPAIR_UPDATE_SQL);

  const scope = planLinkClickRepairScope({
    asOfDate: options.asOfDate,
    bandDays: options.bandDays,
  });
  const maxPages = maxPageCountFor(options.maxRows, options.pageSize);

  const accounts = new Map<string, LinkClickRepairAccountReport>();
  const totals = emptyActionTally();
  let cursor: LinkClickRepairCursor | null = null;
  let pagesRead = 0;
  let candidatesExamined = 0;
  let rowsPlanned = 0;
  let rowsWritten = 0;
  let rowsSkippedByPreImageDrift = 0;
  let residualNeedingProviderResync = 0;
  let truncatedByMaxRows = false;
  /*
    THE IMMUTABLE PLAN. Accumulated across every page, frozen before execution,
    and executed from as the single source of what to write.
  */
  const plannedWrites: {
    providerAccountId: string;
    date: string;
    adId: string;
    value: number;
    preImage: number | null;
    band: "prior14" | "recent14";
    sourceSnapshotId: string | null;
    actionsPreImage: string;
    actionsSha256: string;
    reason: LinkClickRepairAction;
  }[] = [];

  const bandReportFor = (
    providerAccountId: string,
    bandKey: "prior14" | "recent14",
  ) => {
    let account = accounts.get(providerAccountId);
    if (!account) {
      account = {
        providerAccountId,
        bands: [emptyBandReport(scope.prior), emptyBandReport(scope.recent)],
      };
      accounts.set(providerAccountId, account);
    }
    const report = account.bands.find((entry) => entry.band === bandKey);
    if (!report) {
      throw new Error(`link_click_repair_unknown_band: ${bandKey}`);
    }
    return report;
  };

  while (pagesRead < maxPages) {
    const remaining = options.maxRows - candidatesExamined;
    if (remaining <= 0) {
      truncatedByMaxRows = true;
      break;
    }
    const limit = Math.min(options.pageSize, remaining);
    const page = await withBoundedRetry(
      "page_read",
      options.maxAttempts,
      () =>
        db.query<PageRow>(LINK_CLICK_REPAIR_PAGE_SQL, [
          options.businessId,
          scope.windowStartDate,
          scope.windowEndDate,
          options.providerAccountIds,
          cursor?.providerAccountId ?? null,
          cursor?.date ?? null,
          cursor?.adId ?? null,
          limit,
          options.admissibilityCutoff,
        ]),
      sleep,
    );
    pagesRead += 1;
    if (page.length === 0) break;

    const last = page[page.length - 1]!;
    const nextCursor: LinkClickRepairCursor = {
      providerAccountId: last.provider_account_id,
      date: last.date,
      adId: last.ad_id,
    };
    if (!cursorAdvanced(cursor, nextCursor)) {
      throw new Error(
        `link_click_repair_cursor_did_not_advance: ${JSON.stringify(nextCursor)}`,
      );
    }
    cursor = nextCursor;

    const writes: {
      providerAccountId: string;
      date: string;
      adId: string;
      value: number;
      preImage: number | null;
      band: "prior14" | "recent14";
      sourceSnapshotId: string | null;
      actionsPreImage: string;
      actionsSha256: string;
      reason: LinkClickRepairAction;
    }[] = [];

    for (const row of page) {
      candidatesExamined += 1;
      const bandKey = bandKeyForDate(scope, row.date);
      if (!bandKey) {
        // The page predicate already restricts to the pair, so this is a
        // contradiction rather than a case: fail loudly instead of dropping it.
        throw new Error(`link_click_repair_row_outside_band_pair: ${row.date}`);
      }
      const report = bandReportFor(row.provider_account_id, bandKey);
      report.candidatesExamined += 1;
      const stored = parseStoredLinkClicks(row.stored_link_clicks);
      const classification = classifyAdDayLinkClick({
        storedLinkClicks: stored,
        actionsPresent: row.actions_present,
        linkClickValues: row.link_click_values ?? [],
        skipMeasuredZero: options.skipMeasuredZero,
      });
      report.actions[classification.action] += 1;
      totals[classification.action] += 1;
      if (requiresProviderResync(classification.action)) {
        residualNeedingProviderResync += 1;
      }
      if (isWritingAction(classification.action) && classification.writeValue !== null) {
        report.rowsPlanned += 1;
        rowsPlanned += 1;
        writes.push({
          providerAccountId: row.provider_account_id,
          date: row.date,
          adId: row.ad_id,
          value: classification.writeValue,
          preImage: stored,
          band: bandKey,
          sourceSnapshotId: row.source_snapshot_id ?? null,
          actionsPreImage: row.actions_pre_image,
          actionsSha256: createHash("sha256").update(row.actions_pre_image).digest("hex"),
          reason: classification.action,
        });
      }
    }

    /*
      NOTHING IS WRITTEN HERE (Codex B11).

      This block used to execute the page's writes immediately. A run that then
      hit `--max-rows` had ALREADY mutated every earlier page, so a refusal
      that was supposed to protect a partial repair arrived after the partial
      repair had happened. The plan is now accumulated in full, validated once,
      and only then executed — so a truncated run changes nothing at all.
    */
    plannedWrites.push(...writes);

    if (page.length < limit) break;
    if (candidatesExamined >= options.maxRows) {
      /*
        The ceiling stopped the scan. Whether that actually truncated anything
        is a question with an exact answer, so ask it rather than assume: one
        bounded LIMIT 1 probe from the cursor. Assuming truncation would refuse
        a complete run whose candidate count happened to land exactly on the
        ceiling; assuming completeness would let a truncated repair through.
      */
      const probe = await withBoundedRetry(
        "truncation_probe",
        options.maxAttempts,
        () =>
          db.query<PageRow>(LINK_CLICK_REPAIR_PAGE_SQL, [
            options.businessId,
            scope.windowStartDate,
            scope.windowEndDate,
            options.providerAccountIds,
            nextCursor.providerAccountId,
            nextCursor.date,
            nextCursor.adId,
            1,
            // The probe reads the SAME population the page read does; omitting
            // the cutoff here left the statement one parameter short.
            options.admissibilityCutoff,
          ]),
        sleep,
      );
      truncatedByMaxRows = probe.length > 0;
      break;
    }
  }

  if (pagesRead >= maxPages && !truncatedByMaxRows) {
    throw new Error(
      `link_click_repair_page_ceiling_reached: ${pagesRead} pages at page-size ${options.pageSize}`,
    );
  }

  /*
    ── PLAN COMPLETE. VALIDATE, THEN EXECUTE. ────────────────────────────────

    The scan above mutates nothing. Everything it decided to write is in
    `plannedWrites`, which is frozen here so no later step can extend or edit
    what was validated.

    THE ORDER IS THE POINT. Writes used to happen page by page inside the scan,
    so a run that hit `--max-rows` had already repaired every earlier page by
    the time the truncation refusal was raised — the guard fired after the
    damage it existed to prevent. A truncated plan now writes NOTHING: the
    refusal happens here, before the first mutation.

    The execution is driven from the frozen plan and from nothing else, and it
    runs inside one transaction so a failure part-way leaves the window as it
    was rather than half-repaired.
  */
  const frozenPlan = Object.freeze(plannedWrites.map((write) => Object.freeze({ ...write })));
  const manifest: LinkClickRepairResult["manifest"] = frozenPlan.map((write) => ({
    providerAccountId: write.providerAccountId,
    date: write.date,
    adId: write.adId,
    field: "link_clicks",
    oldValue: write.preImage,
    newValue: write.value,
    source: {
      kind: "meta_ad_daily.payload_json.actions",
      sourceSnapshotId: write.sourceSnapshotId,
      actionsSha256: write.actionsSha256,
    },
    reason: write.reason,
  }));
  /*
    Bind the reviewed plan to its whole read scope, not only its row array. Two
    businesses or knowledge cutoffs can legitimately produce byte-identical
    edits; their approvals are not interchangeable.
  */
  const manifestHash = createHash("sha256").update(JSON.stringify({
    contract: LINK_CLICK_REPAIR_MANIFEST_CONTRACT,
    businessId: options.businessId,
    scope,
    admissibilityCutoff: options.admissibilityCutoff,
    providerAccountIds: options.providerAccountIds,
    skipMeasuredZero: options.skipMeasuredZero,
    manifest,
  })).digest("hex");
  /*
    THE REFUSAL MOVES HERE, ahead of the first mutation.

    `assertPlanIsNotSilentlyPartial` still exists and the CLI still calls it,
    but it ran on the RETURNED result — which, under the per-page writer, was
    after the writes it was meant to prevent. Raising it here is what makes a
    truncated execute a genuine no-op.
  */
  if (options.execute && truncatedByMaxRows && !options.allowPartial) {
    throw new Error(
      `link_click_repair_plan_truncated_by_max_rows: examined ${candidatesExamined} candidates at the --max-rows ceiling of ${options.maxRows}. Nothing was written. Raise --max-rows so the whole band pair is covered, or pass --allow-partial to accept an incomplete repair.`,
    );
  }

  /*
    The execute recomputes the entire plan, then proves it is byte-for-byte the
    plan that was reviewed. A matching scope with a changed row, source, or
    value is a different manifest and writes nothing.

    The same lock applies to programmatic callers. Otherwise a second entry
    point could bypass the reviewed dry-run requirement enforced by the CLI.
  */
  if (
    options.execute &&
    options.expectedManifestHash !== manifestHash
  ) {
    throw new Error(
      `link_click_repair_manifest_hash_mismatch: expected ${options.expectedManifestHash}, recomputed ${manifestHash}. Nothing was written.`,
    );
  }

  if (options.execute && frozenPlan.length > 0) {
    await runLinkClickRepairPlan({
      db,
      options,
      plan: frozenPlan,
      onWritten: (write) => {
        const report = bandReportFor(write.providerAccountId, write.band);
        report.rowsWritten += 1;
        rowsWritten += 1;
      },
      onDrifted: (write) => {
        const report = bandReportFor(write.providerAccountId, write.band);
        report.rowsSkippedByPreImageDrift += 1;
        rowsSkippedByPreImageDrift += 1;
      },
    });
  }

  return {
    mode: options.execute ? "execute" : "dry_run",
    businessId: options.businessId,
    scope,
    admissibilityCutoff: options.admissibilityCutoff,
    providerAccountIdsRequested: options.providerAccountIds,
    bounds: {
      maxRows: options.maxRows,
      pageSize: options.pageSize,
      maxPages,
      maxAttempts: options.maxAttempts,
    },
    pagesRead,
    candidatesExamined,
    rowsPlanned,
    rowsWritten,
    rowsSkippedByPreImageDrift,
    truncatedByMaxRows,
    accounts: Array.from(accounts.values()).sort((left, right) =>
      left.providerAccountId.localeCompare(right.providerAccountId),
    ),
    actions: totals,
    residualNeedingProviderResync,
    manifestContract: LINK_CLICK_REPAIR_MANIFEST_CONTRACT,
    manifestHash,
    reviewedManifestHash: options.execute ? options.expectedManifestHash : null,
    manifest,
  };
}


/**
 * Executes a FROZEN repair plan, in batches, inside one transaction.
 *
 * Separate from the scan on purpose: the scan decides, this writes, and the
 * validation between them is what makes a truncated run a no-op instead of a
 * half-finished repair. The pre-image guard travels with every row; any
 * concurrent drift aborts and rolls back the complete reviewed plan.
 */
async function runLinkClickRepairPlan(input: {
  db: LinkClickRepairDb;
  options: LinkClickRepairOptions;
  plan: readonly {
    providerAccountId: string;
    date: string;
    adId: string;
    value: number;
    preImage: number | null;
    band: "prior14" | "recent14";
    sourceSnapshotId: string | null;
    actionsPreImage: string;
  }[];
  onWritten: (write: { providerAccountId: string; band: "prior14" | "recent14" }) => void;
  onDrifted: (write: { providerAccountId: string; band: "prior14" | "recent14" }) => void;
}): Promise<void> {
  const { db, options, plan } = input;
  if (typeof db.transaction !== "function") {
    throw new Error(
      "link_click_repair_no_transaction_boundary: executing requires a client-pinned transaction; refusing to write through a pool handle.",
    );
  }
  await db.transaction(async (tx) => {
    for (let offset = 0; offset < plan.length; offset += options.pageSize) {
      const batch = plan.slice(offset, offset + options.pageSize);
      /*
        NO STATEMENT-LEVEL RETRY IN HERE.

        Every batch used to be wrapped in `withBoundedRetry`. Inside a
        transaction that is worse than useless: PostgreSQL puts an aborted
        transaction into a state where every subsequent statement fails with
        25P02 until it is rolled back, so a retry cannot succeed and only
        obscures the original error. A failure propagates, the transaction
        rolls back whole, and the operator re-runs the command.
      */
      const updated = await tx.query<{
        provider_account_id: string;
        date: string;
        ad_id: string;
      }>(LINK_CLICK_REPAIR_UPDATE_SQL, [
        options.businessId,
        batch.map((write) => write.providerAccountId),
        batch.map((write) => write.date),
        batch.map((write) => write.adId),
        batch.map((write) => write.value),
        batch.map((write) => write.preImage),
        batch.map((write) => write.sourceSnapshotId),
        batch.map((write) => write.actionsPreImage),
        options.admissibilityCutoff,
      ]);
      const updatedKeys = new Set(
        updated.map((row) => [row.provider_account_id, row.date, row.ad_id].join("\u0000")),
      );
      const drifted = batch.filter((write) => {
        const key = [write.providerAccountId, write.date, write.adId].join("\u0000");
        return !updatedKeys.has(key);
      });
      if (drifted.length > 0) {
        for (const write of drifted) input.onDrifted(write);
        throw new Error(
          `link_click_repair_preimage_drift: ${drifted.length} reviewed row(s) changed before apply; the complete transaction was rolled back. Re-run dry-run and review a new manifest.`,
        );
      }
      for (const write of batch) input.onWritten(write);
    }
  });
}

/**
 * A truncated plan is refused in execute mode.
 *
 * Writing the first `maxRows` candidates of a two-band window fills whichever
 * band sorts first and leaves the other one short, which is precisely the
 * "filled only the recent band" failure this command exists to avoid. Raising
 * `--max-rows` is the fix; `--allow-partial` is the deliberate override.
 */
export function assertPlanIsNotSilentlyPartial(
  result: LinkClickRepairResult,
  options: LinkClickRepairOptions,
): void {
  if (!options.execute) return;
  if (!result.truncatedByMaxRows) return;
  if (options.allowPartial) return;
  throw new Error(
    `link_click_repair_plan_truncated_by_max_rows: examined ${result.candidatesExamined} candidates at the --max-rows ceiling of ${options.maxRows}. Raise --max-rows so the whole band pair is covered, or pass --allow-partial to accept an incomplete repair.`,
  );
}

export const LINK_CLICK_REPAIR_USAGE = `usage: node --import tsx scripts/meta/link-click-repair-backfill.ts \\
  --business <businessId> [--account act_123 ...] [--as-of YYYY-MM-DD]
  [--admissibility-cutoff YYYY-MM-DDTHH:mm:ss.sssZ]
  [--band-days ${LINK_CLICK_REPAIR_BOUNDS.bandDaysDefault}] [--max-rows ${LINK_CLICK_REPAIR_BOUNDS.maxRowsDefault}] [--page-size ${LINK_CLICK_REPAIR_BOUNDS.pageSizeDefault}] [--max-attempts ${LINK_CLICK_REPAIR_BOUNDS.maxAttemptsDefault}]
  [--skip-measured-zero] [--allow-partial] [--receipt-out <path>]
  [--execute --expected-manifest-hash <sha256>]

Dry run by default. --execute additionally requires ${LINK_CLICK_REPAIR_EXECUTE_ENV}=1 and the reviewed dry-run manifest hash.`;

async function main() {
  configureOperationalScriptRuntime();
  let options: LinkClickRepairOptions;
  try {
    options = parseLinkClickRepairArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof LinkClickRepairUsageError) {
      console.error(error.message);
      console.error(LINK_CLICK_REPAIR_USAGE);
      process.exit(1);
    }
    throw error;
  }

  const { getDb, runDbTransaction } = await import("@/lib/db");
  /*
    RESOLVED PER CALL, not captured once.

    `getDb()` returns the transaction-pinned client when one is bound by
    `runDbTransaction` (it reads an AsyncLocalStorage store), and the pool
    otherwise. Capturing the handle once — as this did — meant the writes ran
    on pooled connections even inside a transaction, so the `BEGIN` and the
    `UPDATE`s could land on different clients.
  */
  const db: LinkClickRepairDb = {
    query: <TRow,>(text: string, values: unknown[]) =>
      getDb().query(text, values) as Promise<TRow[]>,
    transaction: <T,>(fn: (tx: LinkClickRepairDb) => Promise<T>) =>
      runDbTransaction(() => fn(db)),
  };

  const result = await runLinkClickRepair({ db, options });
  assertPlanIsNotSilentlyPartial(result, options);

  const report = JSON.stringify(result, null, 2);
  if (options.receiptOutPath) {
    writeFileSync(options.receiptOutPath, `${report}\n`, "utf8");
  }
  console.log(report);
  if (!options.execute) {
    console.log(
      `\nDRY RUN — nothing was written. ${result.rowsPlanned} row(s) would be repaired; ${result.residualNeedingProviderResync} row(s) lack trustworthy stored actions evidence. A dated provider re-read may still omit actions; inspect its field scope before treating those rows as repairable.`,
    );
  }
}

// `import.meta.url` is undefined under the CJS test transform, so this runs the
// CLI only when the file is the process entrypoint and never when it is
// imported by a test.
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("link-click-repair-backfill.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
