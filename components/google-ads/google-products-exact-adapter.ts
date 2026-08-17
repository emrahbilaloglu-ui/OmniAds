import type { ProductRow } from "@/components/google-ads/google-ads-dashboard-support";

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

export type GoogleProductsExactAllocationKey =
  | "isolate"
  | "scale"
  | "reduce"
  | "hidden";

export interface GoogleProductsExactAllocationViewModel {
  key: GoogleProductsExactAllocationKey;
  label: string;
  /** Product names. Empty means the bucket has no product behind it. */
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
  roasTarget: number | null;
  /** The pack's break-even ROAS, the design's second boundary. */
  roasBreakEven?: number | null;
  /**
   * Merchant Center feed evidence. Null when no Merchant Center read has landed
   * for this account; the tiles keep their shells and print `—`.
   */
  feed?: {
    totalItemsInFeed?: number | null;
    servingItemCount?: number | null;
    limitedItemCount?: number | null;
    disapprovedItemCount?: number | null;
    /** Pre-formatted label. Wins over `syncedAt` when both are supplied. */
    syncedLabel?: string | null;
    /** ISO timestamp of the newest Merchant Center observation. */
    syncedAt?: string | null;
  } | null;
  /**
   * Clock for the `Feed synced` tile's relative label, so the mapping stays a
   * pure function of its inputs under test.
   */
  nowMs?: number;
}

/**
 * The design's four allocation buckets, in its own order (model line 3846).
 *
 * The card reads product allocation, so its chips are product names and its
 * labels are these four fixed bucket titles. Three of them are the product
 * classifications the server already assigns in `analyzeProducts`
 * (lib/google-ads/tab-analysis.ts:143-149 — `scale_product`, `hidden_winner`,
 * `underperforming_product`, `stable_product`).
 *
 * Nothing the shopping report serves names a hero-isolation candidate:
 * `stable_product` is the residual bucket and answers a different question.
 * That bucket therefore keeps its shell and prints the em dash rather than
 * being filled with an advisor sentence, which is a different content model.
 */
const ALLOCATION_BUCKETS: ReadonlyArray<{
  key: GoogleProductsExactAllocationKey;
  label: string;
  classification: string | null;
}> = [
  {
    key: "isolate",
    label: "Isolate into a hero campaign",
    classification: null,
  },
  { key: "scale", label: "Scale", classification: "scale_product" },
  { key: "reduce", label: "Reduce", classification: "underperforming_product" },
  { key: "hidden", label: "Hidden winners", classification: "hidden_winner" },
];

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
 * The `Feed synced` tile's relative label.
 *
 * Deliberately the same shape the design prints — `26m ago` — and deliberately
 * coarse: the tile answers "is this read recent enough to act on", and a
 * seconds-accurate answer would only invite the reader to trust a snapshot more
 * precisely than a six-hourly refresh deserves.
 */
function relativeSyncedLabel(syncedAt: string, nowMs: number): string {
  const observedMs = Date.parse(syncedAt);
  if (!Number.isFinite(observedMs)) return DASH;
  const elapsedMinutes = Math.floor((nowMs - observedMs) / 60_000);
  if (elapsedMinutes < 0) return DASH;
  if (elapsedMinutes < 1) return "just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  return `${Math.floor(elapsedHours / 24)}d ago`;
}

/**
 * The Feed status chip.
 *
 * Merchant Center state, when a Merchant Center read supplied it, IS the answer
 * to this column — it is what the design's `Missing GTIN` and `Disapproved`
 * chips are, and the screen's own footnote says the fix for a disapproval lives
 * there. It therefore outranks the performance proxies below it: an item that
 * took impressions yesterday and is disapproved today is disapproved, and
 * saying `Serving` because the metrics agree with last week would be the one
 * lie this column can tell.
 *
 * Below that, unchanged: `Hidden winner` is the shopping report's own
 * classification and `Serving` is the observable fact that the item took
 * impressions in the window. An item with no Merchant Center row and no
 * impressions is `—`, never a guess at why.
 */
export function googleProductFeedStatus(row: ProductRow): {
  label: string;
  tone: GoogleSearchExactChipTone;
} {
  switch (row.feedState) {
    case "disapproved":
      return { label: "Disapproved", tone: "negative" };
    case "limited":
      return {
        // The provider's own words when it gave them, its state when it did not.
        label: row.feedStatusLabel?.trim() || "Limited",
        tone: "warning",
      };
    case "serving":
      return { label: "Serving", tone: "positive" };
    default:
      break;
  }
  if (String(row.classification ?? "") === "hidden_winner") {
    return { label: "Hidden winner", tone: "auto" };
  }
  if (numeric(row.impressions) > 0 || numeric(row.clicks) > 0) {
    return { label: "Serving", tone: "positive" };
  }
  return { label: DASH, tone: "neutral" };
}

/**
 * A product's own served identity, never a substituted one: the shopping
 * report's title, else its item id, else the em dash.
 */
function productLabel(row: ProductRow): string {
  const title = row.title?.trim();
  if (title) return title;
  const itemId = row.itemId?.trim();
  return itemId ? itemId : DASH;
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

  const feedTotal = finite(feed?.totalItemsInFeed);
  const feedServing = finite(feed?.servingItemCount);
  const limited = finite(feed?.limitedItemCount);
  const disapproved = finite(feed?.disapprovedItemCount);

  // "Products serving · of N in feed" is one sentence about the feed, so once a
  // Merchant Center read supplies it, the numerator is its serving tally. With
  // no such read the tile falls back to the only serving fact this product has
  // — items that took traffic in the window — and its sub-line stays the em
  // dash, so the number is never read as a fraction of a denominator nobody
  // supplied.
  const servingCount =
    feedServing !== null
      ? feedServing
      : input.products === null
        ? null
        : products.filter(
            (row) => numeric(row.impressions) > 0 || numeric(row.clicks) > 0,
          ).length;

  const syncedAt = feed?.syncedAt?.trim() || null;
  const syncedLabel =
    feed?.syncedLabel?.trim() ||
    (syncedAt ? relativeSyncedLabel(syncedAt, input.nowMs ?? Date.now()) : null);

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

  // The bucket list is fixed at four. A bucket with no product behind it keeps
  // its shell and renders empty, which the card prints as the em dash; it is
  // never dropped and never refilled from a different source. Served rows are
  // not capped, so a bucket names every product the classification covers.
  const allocation: GoogleProductsExactAllocationViewModel[] =
    ALLOCATION_BUCKETS.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      items:
        bucket.classification === null
          ? []
          : products
              .filter(
                (row) =>
                  String(row.classification ?? "") === bucket.classification,
              )
              .map(productLabel),
    }));

  return {
    eyebrow: eyebrowText(identity),
    syncLabel: clean(identity.syncLabel),
    tiles,
    rows,
    allocation,
  };
}
