/**
 * Assigned Meta account states — read-only decision-coverage evidence (D078 R4).
 *
 * Every serving/write surface intentionally resolves scope through
 * `is_selected` assignments, which is correct for authority — but it made a
 * deselected, still-assigned account invisible: it can keep spending, keep
 * receiving produced decision generations, and no operator surface could say
 * so. This module reads ALL assigned identities for a business (selected and
 * deselected alike) with the facts an operator needs to understand decision
 * coverage: identity, selection state, latest warehouse fact date, the
 * account's own last-14-observed-day spend in its own currency, and the
 * latest produced decision generation.
 *
 * This is evidence, never authority: a deselected account remains forbidden
 * as provider-mutation scope, is excluded from every write control, and
 * nothing here reselects or merges anything. General by construction — any
 * business, any deselected account with retained history.
 */
import { getDb } from "@/lib/db";

export type MetaAccountSelectionState = "selected" | "deselected_historical";

export interface MetaAssignedAccountState {
  providerAccountId: string;
  accountName: string | null;
  selectionState: MetaAccountSelectionState;
  accountCurrency: string | null;
  accountTimezone: string | null;
  /** Latest `meta_account_daily` fact date for this account, or null. */
  latestFactDate: string | null;
  /**
   * Spend over the account's own last 14 observed days (window ends at the
   * account's own latest fact date; account currency; never summed across
   * accounts).
   */
  spend14d: number | null;
  /** Latest produced native decision generation for this account, or null. */
  latestDecisionAsOf: string | null;
  latestDecisionRows: number | null;
  latestDecisionAuthorizedRows: number | null;
  /**
   * Whether the current read/write surfaces serve this account. By contract
   * this is exactly the selection state: deselected identities are read-only
   * historical evidence.
   */
  servedByCurrentSurfaces: boolean;
}

export const ASSIGNED_ACCOUNT_STATES_SQL = `
WITH assigned AS (
  SELECT
    pa.external_account_id AS provider_account_id,
    COALESCE(NULLIF(pa.account_name, ''), NULL) AS provider_account_name,
    assignment.is_selected,
    assignment.position,
    assignment.id AS assignment_id
  FROM business_provider_accounts assignment
  INNER JOIN provider_accounts pa
    ON pa.id = assignment.provider_account_ref_id
   AND pa.provider = 'meta'
  WHERE assignment.business_id = $1
    AND assignment.provider = 'meta'
), latest_fact AS (
  SELECT DISTINCT ON (provider_account_id)
    provider_account_id,
    account_name,
    account_currency,
    account_timezone,
    date AS latest_fact_date
  FROM meta_account_daily
  WHERE business_id = $1
  ORDER BY provider_account_id, date DESC, updated_at DESC
), spend14 AS (
  SELECT d.provider_account_id,
         SUM(d.spend)::float8 AS spend_14d
  FROM meta_account_daily d
  INNER JOIN latest_fact lf ON lf.provider_account_id = d.provider_account_id
  WHERE d.business_id = $1
    AND d.date > lf.latest_fact_date - 14
    AND d.date <= lf.latest_fact_date
  GROUP BY d.provider_account_id
), latest_generation AS (
  SELECT provider_account_id,
         MAX(as_of_date) AS latest_as_of
  FROM engine_v3_ad_decision_snapshots_daily
  WHERE business_id = $1
  GROUP BY provider_account_id
), generation_counts AS (
  SELECT s.provider_account_id,
         COUNT(*)::int AS generation_rows,
         COUNT(*) FILTER (WHERE s.authorized_action IS NOT NULL)::int
           AS authorized_rows
  FROM engine_v3_ad_decision_snapshots_daily s
  INNER JOIN latest_generation g
    ON g.provider_account_id = s.provider_account_id
   AND g.latest_as_of = s.as_of_date
  WHERE s.business_id = $1
  GROUP BY s.provider_account_id
)
SELECT
  assigned.provider_account_id,
  COALESCE(assigned.provider_account_name, NULLIF(lf.account_name, ''))
    AS account_name,
  assigned.is_selected,
  lf.account_currency,
  lf.account_timezone,
  lf.latest_fact_date::text AS latest_fact_date,
  spend14.spend_14d,
  g.latest_as_of::text AS latest_decision_as_of,
  gc.generation_rows,
  gc.authorized_rows
FROM assigned
LEFT JOIN latest_fact lf ON lf.provider_account_id = assigned.provider_account_id
LEFT JOIN spend14 ON spend14.provider_account_id = assigned.provider_account_id
LEFT JOIN latest_generation g
  ON g.provider_account_id = assigned.provider_account_id
LEFT JOIN generation_counts gc
  ON gc.provider_account_id = assigned.provider_account_id
ORDER BY assigned.is_selected DESC, assigned.position, assigned.assignment_id
`;

interface AssignedAccountStateDbRow {
  provider_account_id: string;
  account_name: string | null;
  is_selected: boolean;
  account_currency: string | null;
  account_timezone: string | null;
  latest_fact_date: string | null;
  spend_14d: number | string | null;
  latest_decision_as_of: string | null;
  generation_rows: number | string | null;
  authorized_rows: number | string | null;
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function readMetaAssignedAccountStates(
  businessId: string,
): Promise<MetaAssignedAccountState[]> {
  const rows = await getDb().query<AssignedAccountStateDbRow>(
    ASSIGNED_ACCOUNT_STATES_SQL,
    [businessId],
  );
  return rows.map((row) => ({
    providerAccountId: row.provider_account_id,
    accountName: row.account_name?.trim() || null,
    selectionState: row.is_selected ? "selected" : "deselected_historical",
    accountCurrency: row.account_currency?.trim().toUpperCase() || null,
    accountTimezone: row.account_timezone?.trim() || null,
    latestFactDate: row.latest_fact_date,
    spend14d: numberOrNull(row.spend_14d),
    latestDecisionAsOf: row.latest_decision_as_of,
    latestDecisionRows: numberOrNull(row.generation_rows),
    latestDecisionAuthorizedRows: numberOrNull(row.authorized_rows),
    servedByCurrentSurfaces: row.is_selected === true,
  }));
}

/**
 * Operator-facing policy line for one account state. Pure and general: the
 * same sentence template serves any business. A deselected account never
 * gets an action verb — the only next steps are explicit operator decisions.
 */
export function describeAccountStatePolicy(
  state: MetaAssignedAccountState,
): string {
  if (state.selectionState === "selected") {
    return "Selected — serving decisions; in write scope subject to every write gate.";
  }
  const spendNote =
    state.spend14d !== null && state.spend14d > 0
      ? ` It still recorded spend through ${state.latestFactDate ?? "an unknown date"}.`
      : "";
  const decisionNote =
    state.latestDecisionRows !== null && state.latestDecisionRows > 0
      ? ` ${state.latestDecisionRows} produced decision rows (latest ${state.latestDecisionAsOf ?? "unknown"}) are not served by any surface.`
      : "";
  return (
    "Deselected — read-only historical evidence; excluded from serving and from every write control." +
    spendNote +
    decisionNote +
    " Re-selecting it (or stopping its production) is an explicit operator decision."
  );
}
