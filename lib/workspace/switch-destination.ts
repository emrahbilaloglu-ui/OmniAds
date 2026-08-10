/**
 * Where a business switch lands.
 *
 * Switching clients while looking at one client's report, creative or provider
 * account must not carry that identifier into the new tenant — at best it
 * 404s, at worst it looks like the record exists in both. The rule is: keep the
 * surface, drop everything that named a specific record.
 *
 * Everything here is pure string work so the shell can compute the destination
 * before the session write lands.
 */

/** Query keys that name a record in the business being left. */
const NON_TRANSFERABLE_PARAMS = [
  "account",
  "decision",
  "entity",
  "creative",
  "report",
  "callback",
  "state",
  "code",
] as const;

/**
 * Detail patterns and the collection each falls back to.
 *
 * Order matters: the longest pattern must be tested first so
 * `/reports/x/edit` is not matched by the bare `/reports/x` rule.
 */
const DETAIL_FALLBACKS: ReadonlyArray<{ pattern: RegExp; collection: string }> = [
  { pattern: /^\/reports\/[^/]+\/(?:edit|print)$/, collection: "/reports" },
  { pattern: /^\/reports\/new$/, collection: "/reports" },
  { pattern: /^\/reports\/[^/]+$/, collection: "/reports" },
  { pattern: /^\/creative\/[^/]+$/, collection: "/creative/inbox" },
  {
    pattern: /^\/manage\/integrations\/callback\/[^/]+$/,
    collection: "/manage/integrations",
  },
];

/** Collection segments that are themselves leaves, not report/creative IDs. */
const CREATIVE_COLLECTIONS = new Set([
  "briefs",
  "copies",
  "inbox",
  "landing-pages",
  "performance",
  "shares",
]);

export const ACCOUNT_RESET_ANNOUNCEMENT =
  "Account selection was reset — it belonged to the previous client.";

export interface SwitchDestination {
  /** Path to navigate to, always inside the new business. */
  path: string;
  /** True when a detail route fell back to its collection. */
  resetToCollection: boolean;
  /** Query keys removed because they named the previous client's records. */
  droppedParams: string[];
  /** Screen-reader announcement, or null when nothing was dropped. */
  announcement: string | null;
}

function splitClientPath(path: string): { businessId: string; rest: string } | null {
  const match = /^\/c\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) return null;
  return { businessId: match[1]!, rest: match[2] ?? "" };
}

function fallbackFor(rest: string): string | null {
  for (const { pattern, collection } of DETAIL_FALLBACKS) {
    if (!pattern.test(rest)) continue;
    // `/creative/inbox` looks like a detail route but is a collection leaf.
    if (collection === "/creative/inbox") {
      const segment = rest.slice("/creative/".length);
      if (CREATIVE_COLLECTIONS.has(segment)) return null;
    }
    return collection;
  }
  return null;
}

/**
 * @param currentPath canonical path being viewed, e.g. `/c/biz_1/reports/r_9`
 * @param currentSearch query string, with or without a leading `?`
 * @param nextBusinessId the business being switched to
 */
export function resolveSwitchDestination(input: {
  currentPath: string;
  currentSearch?: string;
  nextBusinessId: string;
}): SwitchDestination {
  const { currentPath, currentSearch = "", nextBusinessId } = input;

  const parsed = splitClientPath(currentPath);
  // Agency, Ops and unknown surfaces have no per-client equivalent to preserve.
  if (!parsed) {
    return {
      path: `/c/${nextBusinessId}/home`,
      resetToCollection: false,
      droppedParams: [],
      announcement: null,
    };
  }

  const fallback = fallbackFor(parsed.rest);
  const rest = fallback ?? (parsed.rest === "" ? "/home" : parsed.rest);

  const params = new URLSearchParams(
    currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch,
  );
  const droppedParams: string[] = [];
  for (const key of NON_TRANSFERABLE_PARAMS) {
    if (params.has(key)) {
      droppedParams.push(key);
      params.delete(key);
    }
  }

  const query = params.toString();
  return {
    path: `/c/${nextBusinessId}${rest}${query ? `?${query}` : ""}`,
    resetToCollection: fallback !== null,
    droppedParams,
    announcement: droppedParams.includes("account") ? ACCOUNT_RESET_ANNOUNCEMENT : null,
  };
}

/**
 * Query-cache keys to evict on switch. The old business's cached responses must
 * not be readable for even one frame after the scope changes.
 */
export function shouldEvictQueryKeyOnSwitch(
  key: readonly unknown[],
  previousBusinessId: string,
): boolean {
  return key.some((part) => part === previousBusinessId);
}
