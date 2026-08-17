import type { ProductRow } from "@/components/google-ads/google-ads-dashboard-support";
import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";

import {
  googleSearchRoasTone,
  type GoogleSearchExactChipTone,
} from "@/components/google-ads/google-search-exact-adapter";

/**
 * Pure view model for the canonical `Google Ads · Products` screen.
 *
 * The feed-health tiles and the Feed status column describe Merchant Center
 * state. `shopping_performance_view` — the only product resource this account
 * reads — serves item id, title and metrics and no approval or item-issue
 * field, so those facts render as the em dash inside the design's own shells
 * rather than being answered with a different question.
 */

const DASH = "—";

export type GoogleProductsExactValueTone = "ink" | "warning" | "danger";

export interface GoogleProductsExactIdentity {
  accountId?: string | null;
  currencyCode?: string | null;
  windowLabel?: string | null;
  syncLabel?: string | null;
}

export interface GoogleProductsExactTileViewModel {
  key: "serving" | "limited" | "disapproved" | "synced";
  label: string;
  value: string;
  valueTone: GoogleProductsExactValueTone;
  sub: string;
}

export interface GoogleProductsExactRowViewModel {
  key: string;
  name: string;
  sku: string;
  clicks: string;
  cost: string;
  value: string;
  roas: string;
  roasTone: GoogleSearchExactChipTone;
  issue: string;
  issueTone: GoogleSearchExactChipTone;
}

export interface GoogleProductsExactAllocationViewModel {
  key: string;
  label: string;
  items: string[];
}

export interface GoogleProductsExactViewModel {
  eyebrow: string;
  syncLabel: string;
  tiles: GoogleProductsExactTileViewModel[];
  rows: GoogleProductsExactRowViewModel[];
  allocation: GoogleProductsExactAllocationViewModel[];
}

export interface GoogleProductsExactInput {
  identity?: GoogleProductsExactIdentity;
  /** Null means the shopping report has not been read, not that it is empty. */
  products: ProductRow[] | null;
  advisorRecommendations: GoogleRecommendation[] | null;
  roasTarget: number | null;
  /** The pack's break-even ROAS, the design's second boundary. */
  roasBreakEven?: number | null;
  /**
   * Merchant Center feed evidence. Left null until a Merchant Center read
   * exists; the tiles keep their shells and print `—`.
   */
  feed?: {
    totalItemsInFeed?: number | null;
    limitedItemCount?: number | null;
    disapprovedItemCount?: number | null;
    syncedLabel?: string | null;
  } | null;
}

const ALLOCATION_LAYER: GoogleRecommendation["strategyLayer"] =
  "Shopping & Products";
const ALLOCATION_LIMIT = 4;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numeric(value: unknown): number {
  return finite(value) ?? 0;
}

function clean(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : DASH;
}

function currency(
  value: number | null,
  currencyCode: string | null | undefined,
  digits: 0 | 2,
): string {
  const code = currencyCode?.trim();
  if (value === null || !code) return DASH;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return DASH;
  }
}

function count(value: number | null): string {
  return value === null
    ? DASH
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

/**
 * The Feed status chip, restricted to what the account actually reports.
 *
 * `Hidden winner` is a server-assigned classification on the shopping report,
 * so it is served. `Serving` is the observable fact that the item took
 * impressions in the window. `Missing GTIN` and `Disapproved` are Merchant
 * Center item states this read cannot see, so an item that did not serve is
 * `—` rather than a guess at why.
 */
export function googleProductFeedStatus(row: ProductRow): {
  label: string;
  tone: GoogleSearchExactChipTone;
} {
  if (String(row.classification ?? "") === "hidden_winner") {
    return { label: "Hidden winner", tone: "auto" };
  }
  if (numeric(row.impressions) > 0 || numeric(row.clicks) > 0) {
    return { label: "Serving", tone: "positive" };
  }
  return { label: DASH, tone: "neutral" };
}

function eyebrowText(identity: GoogleProductsExactIdentity) {
  return `Google Ads · ${clean(identity.accountId)} · ${clean(
    identity.currencyCode,
  )} · ${clean(identity.windowLabel)} window`;
}

export function buildGoogleProductsExactViewModel(
  input: GoogleProductsExactInput,
): GoogleProductsExactViewModel {
  const identity = input.identity ?? {};
  const currencyCode = identity.currencyCode ?? null;
  const products = input.products ?? [];
  const feed = input.feed ?? null;

  const servingCount =
    input.products === null
      ? null
      : products.filter(
          (row) => numeric(row.impressions) > 0 || numeric(row.clicks) > 0,
        ).length;
  const feedTotal = finite(feed?.totalItemsInFeed);
  const limited = finite(feed?.limitedItemCount);
  const disapproved = finite(feed?.disapprovedItemCount);
  const syncedLabel = feed?.syncedLabel?.trim() || null;

  const tiles: GoogleProductsExactTileViewModel[] = [
    {
      key: "serving",
      label: "Products serving",
      value: count(servingCount),
      valueTone: "ink",
      sub: feedTotal === null ? DASH : `of ${count(feedTotal)} in feed`,
    },
    {
      key: "limited",
      label: "Limited",
      value: count(limited),
      // A tint is a warning. An unread count is not a warning.
      valueTone: limited === null ? "ink" : "warning",
      sub: "missing GTIN · price mismatch",
    },
    {
      key: "disapproved",
      label: "Disapproved",
      value: count(disapproved),
      valueTone: disapproved === null ? "ink" : "danger",
      sub: "blocks their listing groups",
    },
    {
      key: "synced",
      label: "Feed synced",
      value: syncedLabel ?? DASH,
      valueTone: "ink",
      sub: "Shopify → Merchant Center",
    },
  ];

  const rows: GoogleProductsExactRowViewModel[] = products.map((row, index) => {
    const roas = finite(row.roas);
    const status = googleProductFeedStatus(row);
    return {
      key: row.itemId ?? `${row.title ?? "product"}-${index}`,
      name: clean(row.title),
      sku: clean(row.itemId),
      clicks: count(finite(row.clicks)),
      cost: currency(finite(row.spend), currencyCode, 0),
      value: currency(finite(row.revenue), currencyCode, 0),
      roas: roas === null || roas <= 0 ? DASH : roas.toFixed(2),
      roasTone: googleSearchRoasTone(roas, input.roasTarget, input.roasBreakEven ?? null),
      issue: status.label,
      issueTone: status.tone,
    };
  });

  const allocation: GoogleProductsExactAllocationViewModel[] = (
    input.advisorRecommendations ?? []
  )
    .filter((item) => item.strategyLayer === ALLOCATION_LAYER)
    .sort((left, right) => (right.rankScore ?? 0) - (left.rankScore ?? 0))
    .slice(0, ALLOCATION_LIMIT)
    .map((item) => ({
      key: item.id,
      label: clean(item.title),
      items:
        item.reasonCodes.length > 0
          ? item.reasonCodes
          : [item.recommendedAction || item.summary].filter(
              (value): value is string => Boolean(value && value.trim()),
            ),
    }));

  return {
    eyebrow: eyebrowText(identity),
    syncLabel: clean(identity.syncLabel),
    tiles,
    rows,
    allocation,
  };
}
