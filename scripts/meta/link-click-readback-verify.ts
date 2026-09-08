/**
 * READ BACK what the link-click repair wrote, and say whether the band pair is
 * now good enough for the 14/14 contract.
 *
 * This is the second half of the repair, and it is deliberately a separate
 * command: a backfill that grades its own homework from the rows it happens to
 * still hold in memory proves nothing about what landed. Everything reported
 * here is re-read from `meta_ad_daily` after the fact.
 *
 * ── What "complete enough" means, exactly ────────────────────────────────────
 * Native-Ad hydration first derives an AUTHORITATIVE row value. A stored
 * positive count remains measured. A stored zero is measured only when the
 * same row's `payload_json.actions` corroborates Meta's zero encoding: the
 * array omits `link_click`, or it contains exactly one string value that the
 * strict parser reads as zero. A missing, malformed, duplicate, non-string, or
 * positive contradiction makes that stored zero unknown.
 *
 * Unknown link clicks block a band only on a DECISION-BEARING day — a day with
 * impressions, spend, clicks, conversions, or revenue. A wholly inert row is
 * still in the storage census but does not create a denominator gap. Finally,
 * `admitCompositeBand` requires a positive authoritative total in BOTH the
 * recent band and the directly preceding band. This verifier uses the same
 * authoritative-value and decision-bearing SQL expressions, and separately
 * reports:
 *
 *   - storage NULLs on decision-bearing days (`rowsStillAbsent`), split into
 *     rows with no stored actions payload and rows the repair can inspect;
 *   - stored zeros the shared classifier refuses (`rowsUnverifiedZero`), with
 *     the no-actions and positive-contradiction subsets named separately;
 *   - ads whose two authoritative band totals are both complete and positive.
 *
 * ── Rows the repair cannot close ─────────────────────────────────────────────
 * A row whose `payload_json` carries no `actions` array holds no link-click
 * measurement anywhere in the database. `rowsUnmeasurableFromStorage` names
 * storage-NULL rows in that state; closing them needs a re-sync through the
 * authoritative sync path. `rowsSuspectUnprovableZero` names the corresponding
 * legacy stored-zero state. Neither can be repaired from the stored payload.
 *
 * Read-only. This command issues SELECTs and nothing else.
 *
 * Usage:
 *   node --import tsx scripts/meta/link-click-readback-verify.ts \
 *     --business <businessId> [--account act_123 ...] [--as-of YYYY-MM-DD] \
 *     [--band-days 14] [--receipt <path>] [--require-complete]
 */
import { readFileSync } from "node:fs";

import { configureOperationalScriptRuntime } from "../_operational-runtime";
import {
  AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL,
  AD_DAY_DECISION_BEARING_ACTIVITY_SQL,
} from "@/lib/creative-decision-engine/data-source";

import {
  LINK_CLICK_REPAIR_BOUNDS,
  LinkClickRepairUsageError,
  planLinkClickRepairScope,
  type LinkClickRepairDb,
  type LinkClickRepairResult,
  type LinkClickRepairScope,
} from "./link-click-repair-backfill";

export interface LinkClickVerifyOptions {
  businessId: string;
  providerAccountIds: string[] | null;
  asOfDate: string;
  bandDays: number;
  receiptPath: string | null;
  requireComplete: boolean;
  /**
   * The point-in-time the readback reads AS OF.
   *
   * THE READBACK MUST COUNT THE SAME POPULATION THE ENGINE WILL READ. It
   * counted every row in the window, so a band could be reported complete on
   * the strength of rows decision hydration refuses — a provisional capture, a
   * failed validation, or a row recorded after the cutoff — and, symmetrically,
   * a band could be reported incomplete because of rows that are not part of
   * the decision's population at all. The repair already applies these four
   * predicates (`LINK_CLICK_REPAIR_PAGE_SQL`); the verifier that certifies the
   * repair applies them too, or it is certifying a different table.
   */
  admissibilityCutoff: string;
  /**
   * The minimum number of ads whose two bands are BOTH usable before an
   * account counts as complete. Projection completeness alone says the rows
   * are present; this says a decision can actually be reached from them.
   */
  minUsableBandPairs: number;
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new LinkClickRepairUsageError(`${flag} requires a value.`);
  }
  return value;
}

/** Strict argv parsing, for the same reason the repair command parses strictly. */
export function parseLinkClickVerifyArgs(
  argv: string[],
  today: () => string = () => new Date().toISOString().slice(0, 10),
): LinkClickVerifyOptions {
  let businessId: string | null = null;
  const providerAccountIds: string[] = [];
  let asOfDate: string | null = null;
  let bandDays: number = LINK_CLICK_REPAIR_BOUNDS.bandDaysDefault;
  let receiptPath: string | null = null;
  let requireComplete = false;
  let minUsableBandPairs = 1;

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
      case "--band-days": {
        const raw = takeValue(argv, index, "--band-days");
        if (!/^\d+$/.test(raw)) {
          throw new LinkClickRepairUsageError(
            `--band-days must be an integer; received ${JSON.stringify(raw)}.`,
          );
        }
        bandDays = Number.parseInt(raw, 10);
        index += 1;
        break;
      }
      case "--receipt":
        receiptPath = takeValue(argv, index, "--receipt");
        index += 1;
        break;
      case "--min-usable-band-pairs": {
        const raw = argv[index + 1];
        index += 1;
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(
            `--min-usable-band-pairs must be an integer >= 1; received ${JSON.stringify(raw)}.`,
          );
        }
        minUsableBandPairs = parsed;
        break;
      }
      case "--require-complete":
        requireComplete = true;
        break;
      default:
        throw new LinkClickRepairUsageError(`Unknown argument ${JSON.stringify(arg)}.`);
    }
  }

  if (!businessId || !businessId.trim()) {
    throw new LinkClickRepairUsageError("--business <businessId> is required.");
  }
  // Validated eagerly so a bad date fails before a connection is opened.
  planLinkClickRepairScope({ asOfDate: asOfDate ?? today(), bandDays });

  return {
    businessId: businessId.trim(),
    providerAccountIds: providerAccountIds.length > 0 ? providerAccountIds : null,
    asOfDate: asOfDate ?? today(),
    bandDays,
    receiptPath,
    requireComplete,
    /*
      END OF THE AS-OF DAY, UTC — derived exactly as the repair derives it
      (`parseLinkClickRepairArgs`), and deliberately not a flag. Two commands
      that certify each other must not be able to disagree about which rows
      exist, and a flag is a way for them to disagree.
    */
    admissibilityCutoff: `${asOfDate ?? today()}T23:59:59.999Z`,
    minUsableBandPairs,
  };
}

/**
 * `count(*)` and `SUM(bigint)` both come back as strings from node-postgres.
 * Parsing them here, strictly, keeps a silent `NaN` out of every downstream
 * comparison — a `NaN === 0` is false, which would report an incomplete band as
 * complete.
 */
function requireCount(raw: unknown, column: string): number {
  const text = raw == null ? "" : String(raw);
  if (!/^-?\d+$/.test(text)) {
    throw new Error(
      `link_click_verify_unparseable_count: ${column}=${JSON.stringify(raw)}`,
    );
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`link_click_verify_unsafe_count: ${column}=${JSON.stringify(raw)}`);
  }
  return parsed;
}

export const LINK_CLICK_VERIFY_BAND_SQL = `
    WITH scoped AS (
      SELECT
        d.provider_account_id,
        d.date,
        d.link_clicks AS stored_link_clicks,
        ${AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL} AS link_clicks,
        /*
          THE SAME PREDICATE HYDRATION USES, IMPORTED RATHER THAN RESTATED.

          ad_band_aggregates in HYDRATE_AD_DECISION_INPUTS_QUERY counts a
          missing link-click reading against a band only on a DECISION-BEARING
          day, so a wholly inert day — no impressions, no spend, no clicks, no
          conversions, no revenue — with a NULL reading is not a gap and the
          engine admits the band. This verifier counted every NULL, so it
          reported a band as incomplete and a pair as unusable that the engine
          accepts: a readback that fails on rows the decision never looks at is
          measuring a different table than the one the verdict comes from.
        */
        ${AD_DAY_DECISION_BEARING_ACTIVITY_SQL} AS decision_bearing,
        COALESCE(jsonb_typeof(d.payload_json->'actions') = 'array', false) AS actions_present,
        CASE
          WHEN jsonb_typeof(d.payload_json->'actions') = 'array'
          THEN (
            SELECT COUNT(*)
            FROM jsonb_array_elements(d.payload_json->'actions') AS a
            WHERE a->>'action_type' = 'link_click'
          )
          ELSE 0
        END AS payload_link_click_entry_count,
        CASE
          WHEN jsonb_typeof(d.payload_json->'actions') = 'array'
          THEN (
            SELECT CASE
              WHEN jsonb_typeof(a->'value') = 'string' THEN a->>'value'
              ELSE NULL
            END
            FROM jsonb_array_elements(d.payload_json->'actions') AS a
            WHERE a->>'action_type' = 'link_click'
            LIMIT 1
          )
        END AS payload_link_click_string_value
      FROM meta_ad_daily AS d
      WHERE d.business_id = $1
        AND d.date BETWEEN $2::date AND $3::date
        AND ($4::text[] IS NULL OR d.provider_account_id = ANY($4::text[]))
        -- THE SAME FOUR PREDICATES DECISION HYDRATION AND THE REPAIR APPLY.
        -- Counting a row the engine will never read makes this readback a
        -- report about a different table than the one the verdict comes from.
        AND d.truth_state = 'finalized'
        AND d.validation_status = 'passed'
        AND d.created_at <= $9::timestamptz
        AND d.updated_at <= $9::timestamptz
    ),
    banded AS (
      SELECT
        scoped.*,
        CASE
          WHEN date BETWEEN $5::date AND $6::date THEN 'recent14'
          WHEN date BETWEEN $7::date AND $8::date THEN 'prior14'
        END AS band
      FROM scoped
    )
    SELECT
      provider_account_id,
      band,
      count(*)::text AS rows_expected,
      count(*) FILTER (WHERE stored_link_clicks IS NOT NULL)::text AS rows_present,
      -- ABSENT means "absent on a day the decision reads". An inert NULL row
      -- is counted in rows_expected and blocks nothing, exactly as hydration
      -- treats it.
      count(*) FILTER (WHERE stored_link_clicks IS NULL AND decision_bearing)::text
        AS rows_absent,
      count(*) FILTER (
        WHERE stored_link_clicks IS NULL
          AND decision_bearing
          AND NOT actions_present
      )::text AS rows_unmeasurable,
      count(*) FILTER (
        WHERE stored_link_clicks = 0
          AND link_clicks IS NULL
          AND decision_bearing
      )::text AS rows_unverified_zero,
      count(*) FILTER (
        WHERE stored_link_clicks = 0
          AND decision_bearing
          AND NOT actions_present
      )::text
        AS rows_suspect_unprovable_zero,
      count(*) FILTER (
        WHERE stored_link_clicks = 0
          AND decision_bearing
          AND actions_present
          AND payload_link_click_entry_count = 1
          AND CASE
            WHEN payload_link_click_string_value ~ '^[0-9]+$'
              THEN payload_link_click_string_value::numeric
                BETWEEN 1 AND 9007199254740991
            ELSE FALSE
          END
      )::text AS rows_fabricated_zero_remaining,
      COALESCE(SUM(link_clicks), 0)::text AS link_clicks_total
    FROM banded
    WHERE band IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;

export const LINK_CLICK_VERIFY_AD_PAIR_SQL = `
    WITH scoped AS (
      SELECT
        d.provider_account_id,
        d.ad_id,
        d.date,
        ${AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL} AS link_clicks,
        -- Same shared predicate as the band statement above, for the same
        -- reason: an inert NULL day must not make an ad's band pair unusable
        -- when hydration would admit it.
        ${AD_DAY_DECISION_BEARING_ACTIVITY_SQL} AS decision_bearing
      FROM meta_ad_daily AS d
      WHERE d.business_id = $1
        AND d.date BETWEEN $2::date AND $3::date
        AND ($4::text[] IS NULL OR d.provider_account_id = ANY($4::text[]))
        -- THE SAME FOUR PREDICATES DECISION HYDRATION AND THE REPAIR APPLY.
        -- Counting a row the engine will never read makes this readback a
        -- report about a different table than the one the verdict comes from.
        AND d.truth_state = 'finalized'
        AND d.validation_status = 'passed'
        AND d.created_at <= $9::timestamptz
        AND d.updated_at <= $9::timestamptz
    ),
    banded AS (
      SELECT
        scoped.*,
        CASE
          WHEN date BETWEEN $5::date AND $6::date THEN 'recent14'
          WHEN date BETWEEN $7::date AND $8::date THEN 'prior14'
        END AS band
      FROM scoped
    ),
    per_ad AS (
      SELECT
        provider_account_id,
        ad_id,
        count(*) FILTER (WHERE band = 'recent14') AS recent_rows,
        count(*) FILTER (
          WHERE band = 'recent14' AND link_clicks IS NULL AND decision_bearing
        ) AS recent_absent,
        COALESCE(SUM(link_clicks) FILTER (WHERE band = 'recent14'), 0) AS recent_total,
        count(*) FILTER (WHERE band = 'prior14') AS prior_rows,
        count(*) FILTER (
          WHERE band = 'prior14' AND link_clicks IS NULL AND decision_bearing
        ) AS prior_absent,
        COALESCE(SUM(link_clicks) FILTER (WHERE band = 'prior14'), 0) AS prior_total
      FROM banded
      WHERE band IS NOT NULL
      GROUP BY 1, 2
    )
    SELECT
      provider_account_id,
      count(*)::text AS ads_in_window,
      count(*) FILTER (WHERE recent_rows > 0 AND prior_rows > 0)::text AS ads_in_both_bands,
      count(*) FILTER (
        WHERE recent_rows > 0 AND prior_rows > 0
          AND recent_absent = 0 AND prior_absent = 0
          AND recent_total > 0 AND prior_total > 0
      )::text AS ads_with_usable_band_pair,
      count(*) FILTER (
        WHERE recent_rows > 0 AND prior_rows > 0
          AND (recent_absent > 0 OR prior_absent > 0)
      )::text AS ads_blocked_by_absence,
      count(*) FILTER (
        WHERE recent_rows > 0 AND prior_rows > 0
          AND recent_absent = 0 AND prior_absent = 0
          AND (recent_total = 0 OR prior_total = 0)
      )::text AS ads_blocked_by_zero_total
    FROM per_ad
    GROUP BY 1
    ORDER BY 1
  `;

export interface LinkClickVerifyBandReadback {
  band: "prior14" | "recent14";
  startDate: string;
  endDate: string;
  rowsExpected: number;
  /** Rows with a non-null stored value; this storage count is not an authority count. */
  rowsPresent: number;
  /** Storage-NULL rows on decision-bearing days. */
  rowsStillAbsent: number;
  /** Storage-NULL/no-actions rows that need a provider re-sync. */
  rowsUnmeasurableFromStorage: number;
  /** Decision-bearing stored zeros the shared authority classifier refuses. */
  rowsUnverifiedZero: number;
  /** No-actions subset of `rowsUnverifiedZero`. */
  rowsSuspectUnprovableZero: number;
  /** Strict positive-payload subset of `rowsUnverifiedZero`. */
  rowsFabricatedZeroRemaining: number;
  /** Sum of authoritative row values; unknown rows do not contribute. */
  linkClicksTotal: number;
  /** From the repair receipt when one is supplied, else null. */
  rowsPlannedByRepair: number | null;
  rowsWrittenByRepair: number | null;
  bandComplete: boolean;
  incompleteReasons: string[];
}

export interface LinkClickVerifyAccountReadback {
  providerAccountId: string;
  bands: LinkClickVerifyBandReadback[];
  adsInWindow: number;
  adsInBothBands: number;
  adsWithUsableBandPair: number;
  adsBlockedByAbsence: number;
  adsBlockedByZeroTotal: number;
  bandPairCompleteEnoughFor14x14: boolean;
}

export interface LinkClickVerifyResult {
  businessId: string;
  scope: LinkClickRepairScope;
  /** The as-of instant these counts were taken at; part of the scope. */
  admissibilityCutoff: string;
  providerAccountIdsRequested: string[] | null;
  receiptPath: string | null;
  accounts: LinkClickVerifyAccountReadback[];
  totals: {
    rowsExpected: number;
    rowsPresent: number;
    rowsStillAbsent: number;
    rowsUnmeasurableFromStorage: number;
    rowsUnverifiedZero: number;
    rowsSuspectUnprovableZero: number;
    rowsFabricatedZeroRemaining: number;
    rowsWrittenByRepair: number | null;
    adsWithUsableBandPair: number;
  };
  allBandsComplete: boolean;
}

interface BandRow {
  provider_account_id: string;
  band: "prior14" | "recent14";
  rows_expected: string;
  rows_present: string;
  rows_absent: string;
  rows_unmeasurable: string;
  rows_unverified_zero: string;
  rows_suspect_unprovable_zero: string;
  rows_fabricated_zero_remaining: string;
  link_clicks_total: string;
}

interface AdPairRow {
  provider_account_id: string;
  ads_in_window: string;
  ads_in_both_bands: string;
  ads_with_usable_band_pair: string;
  ads_blocked_by_absence: string;
  ads_blocked_by_zero_total: string;
}

/**
 * Pull the repair's own claim for one account/band out of a receipt.
 *
 * The receipt is only trusted for what it CLAIMS, never for what is true: the
 * counts beside it in the output are re-read from the table. Comparing the two
 * is the whole point — a receipt that says 4,354 written beside a readback that
 * still shows 4,354 absent is the interesting case, and it is only visible when
 * both numbers are printed.
 */
export function receiptClaimFor(
  receipt: LinkClickRepairResult | null,
  providerAccountId: string,
  band: "prior14" | "recent14",
): { rowsPlanned: number; rowsWritten: number } | null {
  if (!receipt) return null;
  const account = receipt.accounts.find(
    (entry) => entry.providerAccountId === providerAccountId,
  );
  if (!account) return null;
  const bandReport = account.bands.find((entry) => entry.band === band);
  if (!bandReport) return null;
  return {
    rowsPlanned: bandReport.rowsPlanned,
    rowsWritten: bandReport.rowsWritten,
  };
}

/** The reasons a band is not complete, named rather than summarised as a boolean. */
export function bandIncompleteReasons(input: {
  rowsStillAbsent: number;
  rowsUnmeasurableFromStorage: number;
  rowsUnverifiedZero: number;
  rowsSuspectUnprovableZero: number;
  rowsFabricatedZeroRemaining: number;
}): string[] {
  const counts = Object.values(input);
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("link_click_verify_inconsistent_reason_counts: nonnegative safe integers required");
  }
  if (input.rowsUnmeasurableFromStorage > input.rowsStillAbsent) {
    throw new Error(
      "link_click_verify_inconsistent_reason_counts: unmeasurable rows exceed absent rows",
    );
  }
  const classifiedUnverifiedZeros =
    input.rowsSuspectUnprovableZero + input.rowsFabricatedZeroRemaining;
  if (classifiedUnverifiedZeros > input.rowsUnverifiedZero) {
    throw new Error(
      "link_click_verify_inconsistent_reason_counts: zero-reason subsets exceed unverified zeros",
    );
  }

  const reasons: string[] = [];
  const repairable = input.rowsStillAbsent - input.rowsUnmeasurableFromStorage;
  if (repairable > 0) {
    reasons.push(`${repairable}_absent_rows_repairable_from_stored_payload`);
  }
  if (input.rowsUnmeasurableFromStorage > 0) {
    reasons.push(
      `${input.rowsUnmeasurableFromStorage}_absent_rows_need_provider_resync`,
    );
  }
  if (input.rowsFabricatedZeroRemaining > 0) {
    reasons.push(
      `${input.rowsFabricatedZeroRemaining}_rows_still_store_a_fabricated_zero`,
    );
  }
  if (input.rowsSuspectUnprovableZero > 0) {
    reasons.push(
      `${input.rowsSuspectUnprovableZero}_rows_store_an_uncorroborated_zero`,
    );
  }
  const invalidZeroProvenance =
    input.rowsUnverifiedZero - classifiedUnverifiedZeros;
  if (invalidZeroProvenance > 0) {
    reasons.push(
      `${invalidZeroProvenance}_rows_store_zero_with_invalid_provenance`,
    );
  }
  return reasons;
}

export async function runLinkClickReadbackVerify(input: {
  db: LinkClickRepairDb;
  options: LinkClickVerifyOptions;
  receipt?: LinkClickRepairResult | null;
}): Promise<LinkClickVerifyResult> {
  const { db, options } = input;
  const scope = planLinkClickRepairScope({
    asOfDate: options.asOfDate,
    bandDays: options.bandDays,
  });
  const receipt = input.receipt ?? null;
  if (receipt) {
    // A receipt from a different window would silently attribute another run's
    // writes to this one.
    const mismatch =
      receipt.businessId !== options.businessId ||
      receipt.scope.windowStartDate !== scope.windowStartDate ||
      receipt.scope.windowEndDate !== scope.windowEndDate ||
      /*
        THE CUTOFF IS PART OF THE SCOPE. Two runs over the same dates but
        different as-of instants saw different populations, so the receipt's
        planned/written counts do not describe the rows this readback counts.
      */
      receipt.admissibilityCutoff !== options.admissibilityCutoff;
    if (mismatch) {
      throw new Error(
        `link_click_verify_receipt_scope_mismatch: receipt covers ${receipt.businessId} ${receipt.scope.windowStartDate}..${receipt.scope.windowEndDate} as of ${receipt.admissibilityCutoff}, verifier covers ${options.businessId} ${scope.windowStartDate}..${scope.windowEndDate} as of ${options.admissibilityCutoff}`,
      );
    }
  }

  const params = [
    options.businessId,
    scope.windowStartDate,
    scope.windowEndDate,
    options.providerAccountIds,
    scope.recent.startDate,
    scope.recent.endDate,
    scope.prior.startDate,
    scope.prior.endDate,
    options.admissibilityCutoff,
  ];
  const bandRows = await db.query<BandRow>(LINK_CLICK_VERIFY_BAND_SQL, params);
  const adPairRows = await db.query<AdPairRow>(LINK_CLICK_VERIFY_AD_PAIR_SQL, params);

  const adPairByAccount = new Map(
    adPairRows.map((row) => [row.provider_account_id, row]),
  );
  /*
    AN EXPLICITLY REQUESTED ACCOUNT MAY NOT VANISH.

    The account list came only from the rows the two queries returned, so an
    account that was asked for and answered with NOTHING — every row
    provisional, every validation failed, every row recorded after the cutoff,
    or simply no rows at all — dropped out of the report entirely. Asked about
    A and B, the verifier then answered about A alone, and `allBandsComplete`
    became a claim about a narrower question than the one it was asked. B is
    kept, with empty bands, which `bandComplete` already refuses.
  */
  const accountIds = Array.from(
    new Set([
      ...(options.providerAccountIds ?? []),
      ...bandRows.map((row) => row.provider_account_id),
      ...adPairRows.map((row) => row.provider_account_id),
    ]),
  ).sort((left, right) => left.localeCompare(right));

  const accounts: LinkClickVerifyAccountReadback[] = accountIds.map((accountId) => {
    const bands: LinkClickVerifyBandReadback[] = (
      [scope.prior, scope.recent] as const
    ).map((band) => {
      const row = bandRows.find(
        (entry) => entry.provider_account_id === accountId && entry.band === band.key,
      );
      const rowsExpected = row ? requireCount(row.rows_expected, "rows_expected") : 0;
      const rowsPresent = row ? requireCount(row.rows_present, "rows_present") : 0;
      const rowsStillAbsent = row ? requireCount(row.rows_absent, "rows_absent") : 0;
      const rowsUnmeasurableFromStorage = row
        ? requireCount(row.rows_unmeasurable, "rows_unmeasurable")
        : 0;
      const rowsUnverifiedZero = row
        ? requireCount(row.rows_unverified_zero, "rows_unverified_zero")
        : 0;
      const rowsSuspectUnprovableZero = row
        ? requireCount(row.rows_suspect_unprovable_zero, "rows_suspect_unprovable_zero")
        : 0;
      const rowsFabricatedZeroRemaining = row
        ? requireCount(
            row.rows_fabricated_zero_remaining,
            "rows_fabricated_zero_remaining",
          )
        : 0;
      const linkClicksTotal = row
        ? requireCount(row.link_clicks_total, "link_clicks_total")
        : 0;
      const claim = receiptClaimFor(receipt, accountId, band.key);
      const incompleteReasons = bandIncompleteReasons({
        rowsStillAbsent,
        rowsUnmeasurableFromStorage,
        rowsUnverifiedZero,
        rowsSuspectUnprovableZero,
        rowsFabricatedZeroRemaining,
      });
      // A band with no rows at all is not "complete": there is nothing for the
      // comparison to stand on, and calling it complete would let an empty
      // window pass a gate.
      const bandComplete = rowsExpected > 0 && incompleteReasons.length === 0;
      return {
        band: band.key,
        startDate: band.startDate,
        endDate: band.endDate,
        rowsExpected,
        rowsPresent,
        rowsStillAbsent,
        rowsUnmeasurableFromStorage,
        rowsUnverifiedZero,
        rowsSuspectUnprovableZero,
        rowsFabricatedZeroRemaining,
        linkClicksTotal,
        rowsPlannedByRepair: claim ? claim.rowsPlanned : null,
        rowsWrittenByRepair: claim ? claim.rowsWritten : null,
        bandComplete,
        incompleteReasons:
          rowsExpected === 0 ? ["band_has_no_rows_in_scope"] : incompleteReasons,
      };
    });
    const pair = adPairByAccount.get(accountId);
    const adsWithUsableBandPairForAccount = pair
      ? requireCount(pair.ads_with_usable_band_pair, "ads_with_usable_band_pair")
      : 0;
    return {
      providerAccountId: accountId,
      bands,
      adsInWindow: pair ? requireCount(pair.ads_in_window, "ads_in_window") : 0,
      adsInBothBands: pair ? requireCount(pair.ads_in_both_bands, "ads_in_both_bands") : 0,
      adsWithUsableBandPair: adsWithUsableBandPairForAccount,
      adsBlockedByAbsence: pair
        ? requireCount(pair.ads_blocked_by_absence, "ads_blocked_by_absence")
        : 0,
      adsBlockedByZeroTotal: pair
        ? requireCount(pair.ads_blocked_by_zero_total, "ads_blocked_by_zero_total")
        : 0,
      /*
        PROJECTION COMPLETENESS IS NOT DECISION REACHABILITY (Codex B14).

        This asked only whether both bands were complete — every expected row
        present, none unmeasurable, none a fabricated zero. An account can
        satisfy all of that and still have NO ad whose two bands both carry a
        positive link-click total, which is what `admitCompositeBand` actually
        requires. The whole window can be measured, every measurement can be
        zero, and the 14/14 contract is still unreachable for every ad in it.
        Reported as "complete", that is a release acceptance signal that says
        the repair worked while no decision can use it.

        So completeness now also requires an explicit, nonzero number of ads
        whose band PAIR is usable.
      */
      bandPairCompleteEnoughFor14x14:
        bands.every((band) => band.bandComplete) &&
        adsWithUsableBandPairForAccount >= options.minUsableBandPairs,
    };
  });

  const allBands = accounts.flatMap((account) => account.bands);
  const sum = (pick: (band: LinkClickVerifyBandReadback) => number) =>
    allBands.reduce((total, band) => total + pick(band), 0);
  const rowsWrittenByRepair = receipt
    ? sum((band) => band.rowsWrittenByRepair ?? 0)
    : null;

  return {
    businessId: options.businessId,
    scope,
    admissibilityCutoff: options.admissibilityCutoff,
    providerAccountIdsRequested: options.providerAccountIds,
    receiptPath: options.receiptPath,
    accounts,
    totals: {
      rowsExpected: sum((band) => band.rowsExpected),
      rowsPresent: sum((band) => band.rowsPresent),
      rowsStillAbsent: sum((band) => band.rowsStillAbsent),
      rowsUnmeasurableFromStorage: sum((band) => band.rowsUnmeasurableFromStorage),
      rowsUnverifiedZero: sum((band) => band.rowsUnverifiedZero),
      rowsSuspectUnprovableZero: sum((band) => band.rowsSuspectUnprovableZero),
      rowsFabricatedZeroRemaining: sum((band) => band.rowsFabricatedZeroRemaining),
      rowsWrittenByRepair,
      adsWithUsableBandPair: accounts.reduce(
        (total, account) => total + account.adsWithUsableBandPair,
        0,
      ),
    },
    allBandsComplete:
      accounts.length > 0 &&
      accounts.every((account) => account.bandPairCompleteEnoughFor14x14),
  };
}

export const LINK_CLICK_VERIFY_USAGE = `usage: node --import tsx scripts/meta/link-click-readback-verify.ts \\
  --business <businessId> [--account act_123 ...] [--as-of YYYY-MM-DD]
  [--band-days ${LINK_CLICK_REPAIR_BOUNDS.bandDaysDefault}] [--receipt <path>] [--require-complete]`;

async function main() {
  configureOperationalScriptRuntime();
  let options: LinkClickVerifyOptions;
  try {
    options = parseLinkClickVerifyArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof LinkClickRepairUsageError) {
      console.error(error.message);
      console.error(LINK_CLICK_VERIFY_USAGE);
      process.exit(1);
    }
    throw error;
  }

  const receipt = options.receiptPath
    ? (JSON.parse(readFileSync(options.receiptPath, "utf8")) as LinkClickRepairResult)
    : null;

  const { getDb } = await import("@/lib/db");
  // Resolved per call, like the repair's adapter: a captured handle is a
  // pooled connection frozen at import time, not the one the caller is on.
  const db: LinkClickRepairDb = {
    query: <TRow,>(text: string, values: unknown[]) =>
      getDb().query(text, values) as Promise<TRow[]>,
  };

  const result = await runLinkClickReadbackVerify({ db, options, receipt });
  console.log(JSON.stringify(result, null, 2));

  if (options.requireComplete && !result.allBandsComplete) {
    console.error(
      "\nlink_click_readback_incomplete: at least one band is not complete enough for the 14/14 contract.",
    );
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("link-click-readback-verify.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
