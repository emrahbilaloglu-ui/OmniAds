/**
 * The Merchant Center read path: provider → warehouse.
 *
 * READ ONLY, AND STRUCTURALLY SO. Nothing in this module can change anything in
 * Google Ads or Merchant Center: the single provider call it makes is
 * `googleAds:search`, a GAQL SELECT, through the shared `executeGaqlQuery`. The
 * screen it feeds says so out loud — "the fix lives in Merchant Center, never
 * edited here" — and there is no code here that could make that sentence false.
 * That is also why this file adds no confirmation ceremony and no action-log
 * entry: those guard provider WRITES, and there is no write to guard.
 *
 * It does write to OUR warehouse, so it sits behind the same lane admission
 * every other Google warehouse writer uses (`assertSyncLaneEnabled("google_sync")`,
 * as in `lib/google-ads/warehouse.ts`). Global kill switch off means this does
 * not run either.
 */

import { executeGaqlQuery } from "@/lib/google-ads-gaql";
import { buildMerchantCenterItemStateQuery } from "@/lib/google-ads/query-builders";
import {
  parseShoppingProductRow,
  type MerchantCenterItemState,
} from "@/lib/google-ads/merchant-center-item-state";
import {
  MERCHANT_CENTER_STATE_REFRESH_INTERVAL_MS,
  readMerchantCenterLastObservedAt,
  upsertMerchantCenterItemStates,
} from "@/lib/google-ads/merchant-center-warehouse";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";

export type MerchantCenterRefreshOutcome =
  | "refreshed"
  | "skipped_fresh"
  | "lane_disabled"
  | "unavailable";

export interface MerchantCenterRefreshResult {
  outcome: MerchantCenterRefreshOutcome;
  itemCount: number;
  written: number;
  /**
   * Why the read produced nothing, in the provider's own words. Surfaces may
   * print it; they may never turn it into a feed state.
   */
  reason: string | null;
  merchantCenterIds: string[];
}

/**
 * Refresh one Google Ads account's Merchant Center item state.
 *
 * `unavailable` is a first-class, expected outcome, not an error. The
 * `shopping_product` resource only answers for an account that is actually
 * linked to a Merchant Center account and whose grant covers it; an account
 * running only Search campaigns returns nothing, and an API version or
 * developer-token tier without the resource rejects the query outright. In all
 * three cases the right result is that no row is written and the surface keeps
 * printing the em dash — never a fabricated "everything is serving".
 */
export async function refreshMerchantCenterItemState(input: {
  businessId: string;
  providerAccountId: string;
  /** Refresh even if the stored read is still inside its interval. */
  force?: boolean;
  limit?: number;
  source?: string;
  now?: Date;
}): Promise<MerchantCenterRefreshResult> {
  const empty = {
    itemCount: 0,
    written: 0,
    merchantCenterIds: [] as string[],
  };

  try {
    assertSyncLaneEnabled("google_sync");
  } catch (error) {
    return {
      ...empty,
      outcome: "lane_disabled",
      reason: error instanceof Error ? error.message : "Sync lane is disabled.",
    };
  }

  const now = input.now ?? new Date();
  if (!input.force) {
    const lastObservedAt = await readMerchantCenterLastObservedAt({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
    });
    if (
      lastObservedAt &&
      now.getTime() - lastObservedAt.getTime() <
        MERCHANT_CENTER_STATE_REFRESH_INTERVAL_MS
    ) {
      return { ...empty, outcome: "skipped_fresh", reason: null };
    }
  }

  const namedQuery = buildMerchantCenterItemStateQuery(input.limit ?? 5000);
  let rows: Array<Record<string, unknown>>;
  try {
    const result = await executeGaqlQuery({
      businessId: input.businessId,
      customerId: input.providerAccountId,
      query: namedQuery.query,
      queryName: namedQuery.name,
      queryFamily: namedQuery.family,
      source: input.source ?? "merchant_center_item_state",
    });
    rows = (result.results ?? []) as Array<Record<string, unknown>>;
  } catch (error) {
    // A rejected query is the provider declining to answer. It is never
    // evidence about any item's approval state, so nothing is written and
    // nothing already stored is invalidated.
    return {
      ...empty,
      outcome: "unavailable",
      reason:
        error instanceof Error
          ? error.message
          : "The Merchant Center item-state query failed.",
    };
  }

  const items: MerchantCenterItemState[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const parsed = parseShoppingProductRow(row);
    if (!parsed) continue;
    // One row per item id. The resource can return an item once per feed label
    // or language; the first is kept rather than merging two states into a
    // third one the provider never sent.
    if (seen.has(parsed.itemId)) continue;
    seen.add(parsed.itemId);
    items.push(parsed);
  }

  if (items.length === 0) {
    return {
      ...empty,
      outcome: "unavailable",
      reason:
        "The Google Ads account returned no Merchant Center products; it may not be linked to a Merchant Center account.",
    };
  }

  const { written } = await upsertMerchantCenterItemStates({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    items,
    observedAt: now,
  });

  return {
    outcome: "refreshed",
    itemCount: items.length,
    written,
    reason: null,
    merchantCenterIds: [
      ...new Set(
        items
          .map((item) => item.merchantCenterId)
          .filter((id): id is string => Boolean(id)),
      ),
    ].sort(),
  };
}
