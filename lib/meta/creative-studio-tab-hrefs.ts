/**
 * ITEM 17 — ONE href builder for every Creative Studio tab.
 *
 * The five Studio tabs are one screen with five bodies, so a tab hop must not
 * change what is being measured. Before this module there were two builders:
 *
 * - Assets, Copies and Inbox called `buildCreativeStudioTabHrefs`, which minted
 *   the account and the Studio's own `?start`/`?end` pair.
 * - Landing pages and Audiences called
 *   `dashboardHrefForRouteFamily(buildMetaScopedHref(...))`, which emits the
 *   business and the account and NO window at all.
 *
 * So Assets -> Landers carried the window and Landers -> Assets dropped it: the
 * operator walked one step sideways and the range silently reset to whatever
 * the destination's stored preference happened to be. That is worse than an
 * error, because both screens then print a caption naming their own range and
 * neither says the two disagree.
 *
 * Every tab now goes through this one function, and every href carries all
 * three facts a Studio body needs to reproduce the surface: the BUSINESS (when
 * the path does not already scope it), the ACCOUNT, and the WINDOW.
 *
 * THE WINDOW IS WRITTEN IN BOTH LIVE SPELLINGS, FROM ONE RESOLVED PAIR.
 *
 * `window`/`startDate`/`endDate` is the shell's spelling — it is what
 * `lib/dashboard/date-window-url.ts` writes when the operator moves the date
 * control, what `usePersistentDateRange` reads back, and the pair
 * `windowFromSearchParams` prefers. It is written here by
 * `applyDateWindowToParams`, the shell's own writer, so a link and a picker
 * move can never expand the same window by two different rules.
 *
 * `start`/`end` is the Creative Studio's older spelling
 * (`LEGACY_DATE_WINDOW_START_PARAM`), still read by `scopeFromSearchParams` on
 * the shares/briefs/creative-detail routes and adopted rather than overwritten
 * by `canonicalDateWindowParams`. Dropping it would silently un-window those
 * links. Both pairs are derived from the SAME resolved window in the same call,
 * so they cannot disagree at mint time, and every reader in this family
 * resolves through a resolver that prefers the canonical pair — so a picker
 * move that updates only the canonical pair still outranks the legacy one it
 * left behind.
 *
 * `window` is written as `custom`, always, and that is deliberate rather than
 * lazy. The dates ARE the window (rule 1 of `date-window-url.ts`): naming a
 * rolling preset instead would invite the destination to re-expand "7d"
 * against its own clock and land on two different days from the surface the
 * operator just left. `custom` is precisely the key that means "honour the
 * exact dates"; the picker still recovers and displays the preset's label,
 * because `readDateWindowFromParams` re-derives it from the dates.
 *
 * A HALF WINDOW IS NOT A WINDOW. One bound, an inverted pair or a malformed day
 * carries no window at all rather than being repaired into a plausible-looking
 * one — the same law `windowFromSearchParams` and `canonicalDateWindowParams`
 * already enforce on the reading side. A link that names no window lets the
 * destination keep the operator's own range, which is the honest fallback; a
 * link that names half a window would let a typo become the measured range.
 */
import type { CreativeStudioTabId } from "@/components/creatives/creative-studio-exact-types";
import {
  LEGACY_DATE_WINDOW_END_PARAM,
  LEGACY_DATE_WINDOW_START_PARAM,
  applyDateWindowToParams,
} from "@/lib/dashboard/date-window-url";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A bound is only a date if the calendar agrees: `2026-02-31` is not one. */
function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * The Studio tab paths, per route family.
 *
 * The three families are the three ways this screen is reachable: the
 * business-scoped canonical route, the session route, and the legacy
 * `/platforms/meta` route. A tab must stay inside the family it was clicked
 * from — a Copies link that jumps a `/c/:id` operator onto `/platforms/meta`
 * drops the server-verified business scope and lands them on the shell's
 * selected business instead, which can be a different one.
 */
function tabPaths(
  pathname: string | null,
  businessId: string,
): { paths: Record<CreativeStudioTabId, string>; pathScopesBusiness: boolean } {
  const inBusinessRoute = Boolean(pathname?.startsWith("/c/"));
  const inSessionRoute = Boolean(pathname?.startsWith("/app/"));
  const prefix = inBusinessRoute
    ? `/c/${encodeURIComponent(businessId)}/creative`
    : inSessionRoute
      ? "/app/creative"
      : null;
  if (!prefix) {
    return {
      pathScopesBusiness: false,
      paths: {
        assets: "/platforms/meta/creatives",
        copies: "/platforms/meta/copies",
        "landing-pages": "/platforms/meta/landing-pages",
        inbox: "/platforms/meta/creative-inbox",
        audiences: "/platforms/meta/audiences",
      },
    };
  }
  return {
    // The session route (`/app/creative/...`) resolves the business from the
    // session, and the `/c/:id` route from the path itself. Restating it in the
    // query on either would add a second, contradictable answer to a question
    // the route already answers.
    pathScopesBusiness: true,
    paths: {
      assets: `${prefix}/performance`,
      copies: `${prefix}/copies`,
      "landing-pages": `${prefix}/landing-pages`,
      inbox: `${prefix}/inbox`,
      audiences: `${prefix}/audiences`,
    },
  };
}

export interface CreativeStudioTabHrefInput {
  /** The route the operator is standing on; decides the family, not the scope. */
  pathname: string | null;
  businessId: string;
  providerAccountId: string;
  /** The window's first day. Empty (or half a pair) carries no window. */
  start: string;
  /** The window's last day. */
  end: string;
}

/**
 * The five tab hrefs for the surface the operator is standing on.
 *
 * Everything supplied is a REQUEST, never authority: `providerAccountId` on the
 * link is intersected with the workspace's assignments by
 * `resolveProviderAccountId` on the server before anything is read, and the
 * window is only ever a request for a range. This function decides no scope; it
 * makes the scope the operator already has survive one click.
 */
export function buildCreativeStudioTabHrefs(
  input: CreativeStudioTabHrefInput,
): Record<CreativeStudioTabId, string> {
  const businessId = input.businessId?.trim() ?? "";
  const providerAccountId = input.providerAccountId?.trim() ?? "";
  const start = input.start?.trim() ?? "";
  const end = input.end?.trim() ?? "";
  const { paths, pathScopesBusiness } = tabPaths(input.pathname, businessId);

  let params = new URLSearchParams();
  if (!pathScopesBusiness && businessId) params.set("businessId", businessId);
  if (providerAccountId) params.set("providerAccountId", providerAccountId);

  const hasWindow = isRealIsoDate(start) && isRealIsoDate(end) && start <= end;
  if (hasWindow) {
    // The shell's own writer, handed a `custom` selection so the two dates
    // travel verbatim. `start` is passed as the reference date only because the
    // signature demands one; a `custom` selection never consults a clock.
    params = applyDateWindowToParams(
      params,
      { rangePreset: "custom", customStart: start, customEnd: end },
      start,
    );
    params.set(LEGACY_DATE_WINDOW_START_PARAM, start);
    params.set(LEGACY_DATE_WINDOW_END_PARAM, end);
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return Object.fromEntries(
    Object.entries(paths).map(([tab, path]) => [tab, `${path}${suffix}`]),
  ) as Record<CreativeStudioTabId, string>;
}
