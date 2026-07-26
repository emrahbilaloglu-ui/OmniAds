import { resolveSearchConsoleContext } from "@/lib/search-console";

/**
 * Selection authority for a Search Console property.
 *
 * Both selection writers accepted any syntactically valid URL and wrote it
 * straight onto the canonical connection as the selected property. Nothing
 * proved the connected token could actually see that site, so a typo, a stale
 * bookmark, or a deliberately supplied third-party domain became the business's
 * selected property — and every later sync then ran against a site the token has
 * no permission for, failing in a way that reads as a provider outage.
 *
 * The list is fetched LIVE at selection time rather than from a cache. A cached
 * list from before a permission change is exactly the evidence that must not
 * authorise a new selection, and the request happens once, when a human clicks
 * save.
 */

export type SearchConsoleSelectionRefusal =
  | { kind: "listing_failed"; status: number; detail: string }
  | { kind: "not_accessible"; requested: string; accessibleCount: number };

/**
 * Canonical comparison form.
 *
 * Search Console reports `sc-domain:example.com` and `https://example.com/`
 * as distinct properties, so the scheme and the trailing slash are load-bearing
 * and must NOT be normalised away. Only case and surrounding whitespace are.
 */
export function normalizeSearchConsoleSiteIdentity(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

export async function assertSearchConsoleSiteAccessible(input: {
  businessId: string;
  siteUrl: string;
}): Promise<{ ok: true; siteUrl: string } | { ok: false; refusal: SearchConsoleSelectionRefusal }> {
  const context = await resolveSearchConsoleContext({
    businessId: input.businessId,
    requireSite: false,
  });

  const response = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | { siteEntry?: Array<{ siteUrl?: unknown }> }
    | null;

  if (!response.ok) {
    // An unreadable list is not permission to select. Failing closed here costs
    // a retry; failing open writes an unverifiable property into the canonical
    // connection.
    return {
      ok: false,
      refusal: {
        kind: "listing_failed",
        status: response.status || 502,
        detail:
          typeof (payload as { error?: { message?: unknown } } | null)?.error?.message === "string"
            ? String((payload as { error: { message: string } }).error.message)
            : "Could not list Search Console properties.",
      },
    };
  }

  const accessible = (payload?.siteEntry ?? [])
    .map((entry) => (typeof entry.siteUrl === "string" ? entry.siteUrl : ""))
    .filter(Boolean);
  const wanted = normalizeSearchConsoleSiteIdentity(input.siteUrl);
  const match = accessible.find(
    (candidate) => normalizeSearchConsoleSiteIdentity(candidate) === wanted,
  );
  if (!match) {
    return {
      ok: false,
      refusal: {
        kind: "not_accessible",
        requested: input.siteUrl,
        accessibleCount: accessible.length,
      },
    };
  }
  // Store the provider's exact spelling, not the caller's.
  return { ok: true, siteUrl: match };
}
