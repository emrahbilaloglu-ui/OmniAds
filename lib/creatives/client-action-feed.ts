import { getDb } from "@/lib/db";
import type { SharedClientAction } from "@/components/creatives/shareCreativeTypes";

/**
 * Builds the buyer-facing "What we did and why" action feed for a Client Panel share.
 *
 * Source of truth is the real persisted Meta write ledger (meta_ads_action_log). We only
 * surface rows that (a) actually succeeded and (b) map to a fixed, client-safe phrase. There
 * are no invented counts, dates, or outcomes: every field traces back to a real row.
 *
 * We deliberately do NOT union the operator automation activity ledger — that surface carries
 * internal, operator-only language and is not client-safe.
 */

type ActionLogFeedRow = {
  id: string;
  action: string;
  status: string;
  creative_id: string | null;
  requested_at: string;
  payload_request: unknown;
};

/**
 * The action column of meta_ads_action_log only ever holds these verbs. Bid changes are NOT
 * stored under their own verb — they are persisted as action='launch_adset' with
 * payload_request.operation==='apply_bid' (see lib/meta/entity-action-routes.ts). So there is
 * intentionally no 'apply_bid' key here; the mislabel guard below disambiguates launch_adset.
 */
const ACTION_PHRASES: Record<string, string> = {
  pause: "Paused an underperforming ad",
  resume: "Resumed a paused ad",
  duplicate: "Scaled a strong performer into a new ad set",
  launch_campaign: "Launched a new campaign",
  launch_adset: "Launched a new ad set",
  launch_ad: "Launched a new ad",
};

const LAUNCH_ADSET_BID_PHRASE = "Adjusted bidding on an ad set";

/**
 * Generic, class-keyed client-safe rationale. Keyed by the resolved action class ('apply_bid'
 * is a virtual class derived from the launch_adset bid branch). Every phrase is non-empty so
 * the row survives the share store's sanitize step (which drops actions with a blank why).
 */
const WHY_BY_CLASS: Record<string, string> = {
  pause: "We stopped spend on a creative that was not delivering efficient results.",
  resume: "We brought a creative back once performance conditions supported it again.",
  duplicate: "We put more delivery behind a creative that was already performing well.",
  launch_campaign: "We opened a new campaign to pursue additional demand.",
  launch_adset: "We added a new ad set to test or expand delivery.",
  apply_bid: "We tuned the bid to improve delivery efficiency.",
  launch_ad: "We put a fresh creative live to keep the account performing.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isUndefinedTableError(error: unknown): boolean {
  return isRecord(error) && error.code === "42P01";
}

/**
 * Mirrors the safeRead guard in lib/meta/automation-control-plane.ts: a missing table
 * (Postgres 42P01) yields an empty feed rather than throwing. Any other read error also
 * degrades to an empty feed — the Client Panel simply hides the section honestly.
 */
async function safeReadRows(reader: () => Promise<ActionLogFeedRow[]>): Promise<ActionLogFeedRow[]> {
  try {
    return await reader();
  } catch (error) {
    if (isUndefinedTableError(error)) return [];
    return [];
  }
}

function resolveActionClass(row: ActionLogFeedRow): string | null {
  if (row.action === "launch_adset") {
    const payload = isRecord(row.payload_request) ? row.payload_request : null;
    return payload?.operation === "apply_bid" ? "apply_bid" : "launch_adset";
  }
  return row.action in ACTION_PHRASES ? row.action : null;
}

function resolveWhat(row: ActionLogFeedRow, actionClass: string): string {
  if (actionClass === "apply_bid") return LAUNCH_ADSET_BID_PHRASE;
  return ACTION_PHRASES[actionClass];
}

export async function buildBuyerClientActions({
  businessId,
  sinceDays = 30,
  limit = 10,
}: {
  businessId: string;
  sinceDays?: number;
  limit?: number;
}): Promise<SharedClientAction[]> {
  const trimmedBusinessId = businessId.trim();
  if (!trimmedBusinessId) return [];

  const rows = await safeReadRows(async () => {
    const sql = getDb();
    return (await sql`
      SELECT id, action, status, creative_id, requested_at, payload_request
      FROM meta_ads_action_log
      WHERE business_id = ${trimmedBusinessId}
        AND status IN ('success', 'failure', 'silent_failure')
        AND requested_at > NOW() - (${sinceDays}||' days')::interval
      ORDER BY requested_at DESC
      LIMIT 30
    `) as ActionLogFeedRow[];
  });

  const seen = new Set<string>();
  const actions: SharedClientAction[] = [];

  for (const row of rows) {
    // Keep only real successes — failures and silent failures are not client outcomes.
    if (row.status !== "success") continue;

    const actionClass = resolveActionClass(row);
    // Drop rows whose action isn't in the fixed client-safe dictionary.
    if (!actionClass) continue;

    // De-dupe by row id.
    if (row.id && seen.has(row.id)) continue;
    if (row.id) seen.add(row.id);

    actions.push({
      id: row.id ?? null,
      what: resolveWhat(row, actionClass),
      why: WHY_BY_CLASS[actionClass],
      date: row.requested_at,
      outcome: "Done",
      outcomeTone: "positive",
    });
  }

  return actions
    .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
    .slice(0, Math.max(0, limit));
}
