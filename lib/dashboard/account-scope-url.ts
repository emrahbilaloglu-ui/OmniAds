import { DATE_WINDOW_PARAMS } from "@/lib/dashboard/date-window-url";

/**
 * The query that survives a provider-account switch, and nothing else.
 *
 * Same reasoning as `businessSwitchQuery`, one level down. A selected row, an
 * open inspector, a cursor, an entity filter and a Launchpad handoff reference
 * are all facts about the account being LEFT. In the next account they name
 * nothing — or, on a business that happens to hold both, they name something
 * that exists and must not be shown, which is the plan's rollback trigger 3.
 *
 * An **allowlist**, deliberately. A blocklist has to enumerate every
 * account-scoped parameter in the tree and stays correct only until someone
 * adds the next one. An allowlist is wrong only about parameters we chose to
 * keep, and there are exactly two kinds:
 *
 * - the date window, which names days rather than accounts, so the operator
 *   keeps measuring the same period across the switch;
 * - `businessId`, and only when the URL already stated one — a legacy link's
 *   body reads that parameter, and dropping it would re-scope the page. It is
 *   never introduced onto a URL that did not carry it.
 *
 * `providerAccountId` is then set to the new account.
 */
export function accountSwitchQuery(
  currentQuery: string,
  providerAccountId: string,
): URLSearchParams {
  const current = new URLSearchParams(currentQuery);
  const next = new URLSearchParams();
  for (const key of DATE_WINDOW_PARAMS) {
    const value = current.get(key)?.trim() ?? "";
    if (value) next.set(key, value);
  }
  const businessId = current.get("businessId")?.trim() ?? "";
  if (businessId) next.set("businessId", businessId);
  const account = providerAccountId.trim();
  if (account) next.set("providerAccountId", account);
  return next;
}
