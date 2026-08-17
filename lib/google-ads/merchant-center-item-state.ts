/**
 * Merchant Center per-item state, and the state machine that reads it.
 *
 * WHY THIS RESOURCE AND NOT THE CONTENT API. The design's `Limited`,
 * `Disapproved` and `Feed synced` tiles and the Products table's `Feed status`
 * column all describe Merchant Center item state. The obvious source is the
 * Content API's `productstatuses.list`, and it is the wrong one for this repo:
 * it needs `https://www.googleapis.com/auth/content`, a scope the Google grant
 * in `lib/oauth/google-config.ts` does not request, so every connected business
 * would have to re-consent before a single row could be read.
 *
 * The Google Ads API carries the same facts on the `shopping_product` resource
 * — `merchant_center_id`, `status`, `issues[]`, `availability` — under
 * `https://www.googleapis.com/auth/adwords`, which every connected business has
 * already granted. Same OAuth client, same developer token, same GAQL
 * executor, same customer id. That is the entire reason this module reads a
 * Google Ads resource to answer a Merchant Center question.
 *
 * NOTHING IN HERE INFERS. Every state is a value the provider sent. A status
 * this module does not recognise is `unknown`, an item the read never returned
 * has no row at all, and both render the em dash upstream. The one thing this
 * module may not do is decide that an item is fine because nothing said it was
 * broken.
 */

import { asString } from "@/lib/google-ads/normalizers";

/**
 * The item's serving state, in the vocabulary the design's column prints.
 *
 * - `serving`      — the provider says ELIGIBLE and named no blocking issue.
 * - `limited`      — ELIGIBLE_LIMITED: it serves, but something is degrading it.
 * - `disapproved`  — NOT_ELIGIBLE, or an issue whose severity is DISAPPROVED.
 * - `unknown`      — the provider returned the item but no status this module
 *                    recognises. Never collapsed into `serving`.
 */
export type MerchantCenterFeedState =
  | "serving"
  | "limited"
  | "disapproved"
  | "unknown";

export interface MerchantCenterItemIssue {
  /** The provider's own error code, verbatim. */
  code: string | null;
  /** DISAPPROVED | DEMOTED | UNKNOWN, verbatim. */
  severity: string | null;
  /** The feed attribute the provider blamed, verbatim. */
  attribute: string | null;
  /** The provider's own short description. Never authored here. */
  description: string | null;
}

export interface MerchantCenterItemState {
  /** `shopping_product.item_id` — the join key to the shopping report. */
  itemId: string;
  /** `shopping_product.merchant_center_id`. The authoritative linkage. */
  merchantCenterId: string | null;
  title: string | null;
  feedLabel: string | null;
  languageCode: string | null;
  channel: string | null;
  /** IN_STOCK | OUT_OF_STOCK | PREORDER, verbatim, or null. */
  availability: string | null;
  /** The provider's raw status enum, kept so a future reader can re-derive. */
  rawStatus: string | null;
  state: MerchantCenterFeedState;
  issues: MerchantCenterItemIssue[];
}

export interface MerchantCenterFeedTallies {
  totalItemsInFeed: number;
  servingItemCount: number;
  limitedItemCount: number;
  disapprovedItemCount: number;
  unknownItemCount: number;
}

/** A severity the provider uses to mean "this item is blocked outright". */
const DISAPPROVING_SEVERITIES = new Set(["DISAPPROVED"]);
/** A severity the provider uses to mean "this item serves, but worse". */
const DEMOTING_SEVERITIES = new Set(["DEMOTED"]);

function upperOrNull(value: unknown): string | null {
  const text = asString(value);
  return text ? text.trim().toUpperCase() : null;
}

/**
 * `shopping_product.status` → this module's state, with no widening.
 *
 * The enum is `ShoppingProductStatusEnum.ShoppingProductStatus`. UNSPECIFIED
 * and UNKNOWN are the provider telling us it does not know, which is not the
 * same sentence as "eligible", so they map to `unknown` and print the em dash.
 */
export function merchantCenterStateFromStatus(
  rawStatus: string | null,
): MerchantCenterFeedState {
  switch (rawStatus) {
    case "ELIGIBLE":
      return "serving";
    case "ELIGIBLE_LIMITED":
      return "limited";
    case "NOT_ELIGIBLE":
      return "disapproved";
    default:
      return "unknown";
  }
}

/**
 * The state machine.
 *
 * Status is the provider's own verdict and leads. The issue list can only make
 * the verdict WORSE, never better: a DISAPPROVED issue on an item the status
 * called eligible is a contradiction, and the safe reading of a contradiction
 * is the one that does not tell an operator their blocked item is fine.
 *
 * Symmetrically, an empty issue list may not promote `unknown` to `serving`.
 * "No issues were returned" and "the item is eligible" are different facts, and
 * only the second one is worth printing.
 */
export function deriveMerchantCenterFeedState(input: {
  rawStatus: string | null;
  issues: MerchantCenterItemIssue[];
}): MerchantCenterFeedState {
  const fromStatus = merchantCenterStateFromStatus(input.rawStatus);
  const severities = input.issues.map((issue) => issue.severity ?? "");

  if (severities.some((severity) => DISAPPROVING_SEVERITIES.has(severity))) {
    return "disapproved";
  }
  if (
    fromStatus === "serving" &&
    severities.some((severity) => DEMOTING_SEVERITIES.has(severity))
  ) {
    return "limited";
  }
  return fromStatus;
}

function parseIssue(value: unknown): MerchantCenterItemIssue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const code = asString(record.errorCode ?? record.error_code);
  const severity = upperOrNull(record.adsSeverity ?? record.ads_severity);
  const attribute = asString(record.attributeName ?? record.attribute_name);
  const description = asString(record.description);
  if (!code && !severity && !attribute && !description) return null;
  return { code, severity, attribute, description };
}

/**
 * One `shopping_product` row → one item state, or null.
 *
 * Null when the row carries no item id: without it there is nothing to join to
 * the shopping report, and a state with no subject is worse than no state.
 */
export function parseShoppingProductRow(
  row: Record<string, unknown>,
): MerchantCenterItemState | null {
  const product =
    (row.shoppingProduct ?? row.shopping_product) &&
    typeof (row.shoppingProduct ?? row.shopping_product) === "object"
      ? ((row.shoppingProduct ?? row.shopping_product) as Record<string, unknown>)
      : null;
  if (!product) return null;

  const itemId = asString(product.itemId ?? product.item_id);
  if (!itemId) return null;

  const rawIssues = product.issues;
  const issues = Array.isArray(rawIssues)
    ? rawIssues
        .map(parseIssue)
        .filter((issue): issue is MerchantCenterItemIssue => issue !== null)
    : [];
  const rawStatus = upperOrNull(product.status);

  return {
    itemId,
    merchantCenterId: asString(
      product.merchantCenterId ?? product.merchant_center_id,
    ),
    title: asString(product.title),
    feedLabel: asString(product.feedLabel ?? product.feed_label),
    languageCode: asString(product.languageCode ?? product.language_code),
    channel: upperOrNull(product.channel),
    availability: upperOrNull(product.availability),
    rawStatus,
    state: deriveMerchantCenterFeedState({ rawStatus, issues }),
    issues,
  };
}

/**
 * Collapse the read into the four numbers the design's tiles print.
 *
 * `totalItemsInFeed` is the row count of the read, which is the honest reading
 * of "of N in feed": N is how many items the Merchant Center account actually
 * returned, not an estimate and not the shopping report's row count.
 */
export function summarizeMerchantCenterFeed(
  items: readonly MerchantCenterItemState[],
): MerchantCenterFeedTallies {
  let serving = 0;
  let limited = 0;
  let disapproved = 0;
  let unknown = 0;
  for (const item of items) {
    if (item.state === "serving") serving += 1;
    else if (item.state === "limited") limited += 1;
    else if (item.state === "disapproved") disapproved += 1;
    else unknown += 1;
  }
  return {
    totalItemsInFeed: items.length,
    servingItemCount: serving,
    limitedItemCount: limited,
    disapprovedItemCount: disapproved,
    unknownItemCount: unknown,
  };
}

/**
 * The chip label for one item, in the design's own register.
 *
 * The design's Feed status column mixes a state (`Serving`, `Disapproved`) with
 * a reason (`Missing GTIN`), and the split is not accidental: a disapproval is
 * total, so the state IS the message, while a limitation is partial and the
 * operator needs to know which attribute is dragging the item down.
 *
 * The reason is therefore only ever the provider's own `description` — this
 * module never composes a sentence out of an error code. When the provider
 * demotes an item without saying why, the label falls back to `Limited`, which
 * is still a fact it sent.
 */
export function merchantCenterFeedStatusLabel(
  item: MerchantCenterItemState,
): string | null {
  return merchantCenterFeedStatusLabelImpl(item);
}

/**
 * Join item state onto the shopping report's rows.
 *
 * The join key is the item id, which is the same `segments.product_item_id`
 * both sides are keyed on — `shopping_product.item_id` and the shopping
 * report's offer id are the one identifier Merchant Center and Google Ads
 * genuinely share.
 *
 * A row with no matching item state is returned UNCHANGED, with none of the
 * feed keys present. That absence is the signal: the Feed status column reads
 * it as "no Merchant Center row" and prints the em dash. Writing
 * `feedState: "unknown"` onto every unmatched row would look identical in the
 * column and would quietly claim we looked this item up and could not tell,
 * which is a different and false statement.
 */
export function attachMerchantCenterState<
  Row extends Record<string, unknown>,
>(
  rows: readonly Row[],
  items: ReadonlyMap<string, MerchantCenterItemState> | null,
): Row[] {
  if (!items || items.size === 0) return [...rows];
  return rows.map((row) => {
    const candidate =
      typeof row.itemId === "string" && row.itemId.trim().length > 0
        ? row.itemId.trim()
        : typeof row.productItemId === "string"
          ? row.productItemId.trim()
          : "";
    const item = candidate ? items.get(candidate) : undefined;
    if (!item) return row;
    return {
      ...row,
      // `feedState` is the machine-readable fact; `feedStatusLabel` is the
      // provider's own words for the chip. Neither is ever synthesized for an
      // item the Merchant Center read did not return.
      feedState: item.state,
      feedStatusLabel: merchantCenterFeedStatusLabelImpl(item),
      feedAvailability: item.availability,
      feedIssues: item.issues,
      merchantCenterId: item.merchantCenterId,
    };
  });
}

function merchantCenterFeedStatusLabelImpl(
  item: MerchantCenterItemState,
): string | null {
  switch (item.state) {
    case "serving":
      return "Serving";
    case "disapproved":
      return "Disapproved";
    case "limited": {
      const described = item.issues.find(
        (issue) =>
          issue.description !== null && issue.description.trim().length > 0,
      );
      const description = described?.description?.trim();
      // A whole paragraph would break the chip's one-line geometry. The design's
      // own reasons are two or three words, so a provider string that long is
      // printable and a longer one is not; the state is then the honest label.
      return description && description.length <= 32 ? description : "Limited";
    }
    default:
      // `unknown` has no honest label. The caller renders the em dash.
      return null;
  }
}
