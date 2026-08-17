/**
 * Storage for Merchant Center per-item state.
 *
 * A dimension, not a fact table: one row per (business, Google Ads account,
 * item id), overwritten in place by each read. `observed_at` is the only date
 * it carries, because item state has no history in this product — the screen
 * asks "is this item serving right now", and answering it from a stale row
 * dated three weeks ago would be worse than the em dash.
 *
 * REMOVAL IS NOT DELETION. An item that stops appearing in the read is NOT
 * deleted here; its row simply stops being refreshed and ages out of the read
 * below. Deleting would make "item vanished from the feed" indistinguishable
 * from "we never read this account", and only one of those is a fact.
 */

import { getDb } from "@/lib/db";
import { assertDbSchemaReady, isMissingRelationError } from "@/lib/db-schema-readiness";
import {
  deriveMerchantCenterFeedState,
  summarizeMerchantCenterFeed,
  type MerchantCenterFeedTallies,
  type MerchantCenterItemIssue,
  type MerchantCenterItemState,
} from "@/lib/google-ads/merchant-center-item-state";

export const MERCHANT_CENTER_ITEM_STATE_TABLE =
  "google_merchant_center_item_state";

/**
 * How old a stored read may be before the surface stops trusting it.
 *
 * A disapproval that landed this morning is the whole point of the column, so a
 * week-old snapshot is not "slightly stale", it is a different question. Past
 * this age the read returns nothing and every tile goes back to the em dash.
 */
export const MERCHANT_CENTER_STATE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

/** Do not re-hit the provider more often than this. */
export const MERCHANT_CENTER_STATE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface MerchantCenterFeedRead {
  /** Per-item state, keyed by `item_id`. Absent key means no row, i.e. `—`. */
  items: Map<string, MerchantCenterItemState>;
  tallies: MerchantCenterFeedTallies;
  /** The newest `observed_at` across the rows this read returned. */
  observedAt: string | null;
  /** Every distinct Merchant Center account behind these rows. */
  merchantCenterIds: string[];
}

function parseIssuesJson(value: unknown): MerchantCenterItemIssue[] {
  const raw =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    return [
      {
        code: typeof record.code === "string" ? record.code : null,
        severity: typeof record.severity === "string" ? record.severity : null,
        attribute:
          typeof record.attribute === "string" ? record.attribute : null,
        description:
          typeof record.description === "string" ? record.description : null,
      },
    ];
  });
}

/**
 * Persist one account's read.
 *
 * The whole read is written in ONE statement per chunk with an explicit
 * `observed_at`, so every row from a single read shares one timestamp. Letting
 * each row default to `now()` would smear a large feed across several seconds
 * and make "the newest observation" a per-row question.
 */
export async function upsertMerchantCenterItemStates(input: {
  businessId: string;
  providerAccountId: string;
  items: readonly MerchantCenterItemState[];
  observedAt?: Date;
}): Promise<{ written: number }> {
  if (input.items.length === 0) return { written: 0 };
  const sql = getDb();
  const observedAt = (input.observedAt ?? new Date()).toISOString();

  let written = 0;
  const CHUNK = 500;
  for (let offset = 0; offset < input.items.length; offset += CHUNK) {
    // Serialized to the record definition's own column names. `jsonb_to_recordset`
    // matches JSON keys to lower-cased SQL identifiers, so the camelCase view
    // model has to be spelled out here rather than passed through.
    const chunk = input.items.slice(offset, offset + CHUNK).map((item) => ({
      item_id: item.itemId,
      merchant_center_id: item.merchantCenterId,
      title: item.title,
      feed_label: item.feedLabel,
      language_code: item.languageCode,
      channel: item.channel,
      availability: item.availability,
      raw_status: item.rawStatus,
      state: item.state,
      issues: item.issues,
    }));
    await sql`
      WITH input_items AS (
        SELECT
          NULLIF(TRIM(record.item_id), '') AS item_id,
          NULLIF(TRIM(record.merchant_center_id), '') AS merchant_center_id,
          record.title AS product_title,
          record.feed_label AS feed_label,
          record.language_code AS language_code,
          record.channel AS channel,
          record.availability AS availability,
          record.raw_status AS raw_status,
          record.state AS feed_state,
          COALESCE(record.issues, '[]'::jsonb) AS issues_json
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS record(
          item_id text,
          merchant_center_id text,
          title text,
          feed_label text,
          language_code text,
          channel text,
          availability text,
          raw_status text,
          state text,
          issues jsonb
        )
      )
      INSERT INTO google_merchant_center_item_state (
        business_id,
        provider_account_id,
        merchant_center_id,
        item_id,
        product_title,
        feed_label,
        language_code,
        channel,
        availability,
        raw_status,
        feed_state,
        issues_json,
        first_seen_at,
        observed_at
      )
      SELECT
        ${input.businessId}::text,
        ${input.providerAccountId}::text,
        merchant_center_id,
        item_id,
        product_title,
        feed_label,
        language_code,
        channel,
        availability,
        raw_status,
        feed_state,
        issues_json,
        ${observedAt}::timestamptz,
        ${observedAt}::timestamptz
      FROM input_items
      WHERE item_id IS NOT NULL AND feed_state IS NOT NULL
      ON CONFLICT (business_id, provider_account_id, item_id) DO UPDATE SET
        merchant_center_id = EXCLUDED.merchant_center_id,
        product_title      = EXCLUDED.product_title,
        feed_label         = EXCLUDED.feed_label,
        language_code      = EXCLUDED.language_code,
        channel            = EXCLUDED.channel,
        availability       = EXCLUDED.availability,
        raw_status         = EXCLUDED.raw_status,
        feed_state         = EXCLUDED.feed_state,
        issues_json        = EXCLUDED.issues_json,
        first_seen_at      = COALESCE(
          google_merchant_center_item_state.first_seen_at,
          EXCLUDED.first_seen_at
        ),
        observed_at        = GREATEST(
          google_merchant_center_item_state.observed_at,
          EXCLUDED.observed_at
        ),
        updated_at         = now()
    `;
    written += chunk.length;
  }
  return { written };
}

/**
 * Read the stored state for a set of accounts.
 *
 * Returns null — never an empty-but-confident result — when the table is not
 * there, when the query fails, or when every stored row is older than
 * `MERCHANT_CENTER_STATE_MAX_AGE_MS`. Null is what makes the tiles print the em
 * dash, and it is the correct answer to "we could not look".
 *
 * A genuinely empty Merchant Center account is a different answer and is
 * reported as an empty map with real tallies, because the read succeeded.
 */
export async function readMerchantCenterFeedState(input: {
  businessId: string;
  providerAccountIds: readonly string[];
  now?: Date;
}): Promise<MerchantCenterFeedRead | null> {
  if (input.providerAccountIds.length === 0) return null;

  try {
    await assertDbSchemaReady({
      tables: [MERCHANT_CENTER_ITEM_STATE_TABLE],
      context: "merchant_center_item_state_read",
    });
  } catch {
    return null;
  }

  const sql = getDb();
  const accountIds = [...input.providerAccountIds];
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await sql`
      SELECT
        item_id,
        merchant_center_id,
        product_title,
        feed_label,
        language_code,
        channel,
        availability,
        raw_status,
        feed_state,
        issues_json,
        observed_at
      FROM google_merchant_center_item_state
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ANY(${accountIds}::text[])
    `) as Array<Record<string, unknown>>;
  } catch (error) {
    if (isMissingRelationError(error, [MERCHANT_CENTER_ITEM_STATE_TABLE])) {
      return null;
    }
    return null;
  }

  if (rows.length === 0) return null;

  const nowMs = (input.now ?? new Date()).getTime();
  const items = new Map<string, MerchantCenterItemState>();
  const merchantCenterIds = new Set<string>();
  let newestObservedAtMs = Number.NEGATIVE_INFINITY;
  let newestObservedAt: string | null = null;

  for (const row of rows) {
    const itemId = row.item_id == null ? null : String(row.item_id);
    if (!itemId) continue;
    const observedAtRaw = row.observed_at ? String(row.observed_at) : null;
    const observedAtMs = observedAtRaw ? new Date(observedAtRaw).getTime() : NaN;
    if (!Number.isFinite(observedAtMs)) continue;
    // Each row is aged on its own timestamp: one account refreshed today does
    // not make another account's month-old rows current.
    if (nowMs - observedAtMs > MERCHANT_CENTER_STATE_MAX_AGE_MS) continue;

    if (observedAtMs > newestObservedAtMs) {
      newestObservedAtMs = observedAtMs;
      newestObservedAt = observedAtRaw;
    }

    const issues = parseIssuesJson(row.issues_json);
    const rawStatus = row.raw_status == null ? null : String(row.raw_status);
    const merchantCenterId =
      row.merchant_center_id == null ? null : String(row.merchant_center_id);
    if (merchantCenterId) merchantCenterIds.add(merchantCenterId);

    items.set(itemId, {
      itemId,
      merchantCenterId,
      title: row.product_title == null ? null : String(row.product_title),
      feedLabel: row.feed_label == null ? null : String(row.feed_label),
      languageCode: row.language_code == null ? null : String(row.language_code),
      channel: row.channel == null ? null : String(row.channel),
      availability: row.availability == null ? null : String(row.availability),
      rawStatus,
      // Re-derived from the stored status and issues rather than trusting the
      // stored label, so a change to the state machine takes effect on the next
      // READ instead of waiting for every row to be re-synced.
      state: deriveMerchantCenterFeedState({ rawStatus, issues }),
      issues,
    });
  }

  if (items.size === 0) return null;

  return {
    items,
    tallies: summarizeMerchantCenterFeed([...items.values()]),
    observedAt: newestObservedAt,
    merchantCenterIds: [...merchantCenterIds].sort(),
  };
}

/** When this account was last read, or null if it never was. */
export async function readMerchantCenterLastObservedAt(input: {
  businessId: string;
  providerAccountId: string;
}): Promise<Date | null> {
  try {
    await assertDbSchemaReady({
      tables: [MERCHANT_CENTER_ITEM_STATE_TABLE],
      context: "merchant_center_item_state_freshness",
    });
    const sql = getDb();
    const rows = (await sql`
      SELECT MAX(observed_at) AS observed_at
      FROM google_merchant_center_item_state
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
    `) as Array<Record<string, unknown>>;
    const raw = rows[0]?.observed_at;
    if (!raw) return null;
    const parsed = new Date(String(raw));
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  } catch {
    return null;
  }
}
