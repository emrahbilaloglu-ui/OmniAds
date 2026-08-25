/**
 * The rollback lever, in the direction it was missing.
 *
 * `compatibility.ts` answers one half of the question: a request arrives at a
 * preserved LEGACY path, and the mode decides whether it stays there or moves
 * to the canonical URL. That half has always worked.
 *
 * The other half did not exist. A request that arrives at the CANONICAL family
 * — `/app/**`, and therefore `/c/:businessId/**`, which `resolvePublicRouteRedirect`
 * rewrites into it — was never asked the question at all. `app/app/layout.tsx`
 * read the predicate only to report it in an envelope; nothing refused, nothing
 * fell back. So with the mode at its default of `off`, the canonical UI served
 * every surface anyway and the documented rollback rolled nothing back.
 *
 * This module is that missing half, and it is DERIVED rather than written:
 * `COMPATIBILITY_TABLE` already states, for every changed legacy path, which
 * canonical URL replaced it. Inverting that gives, for every canonical URL,
 * the legacy owner that still renders it. A second hand-maintained router
 * would be a second opinion about the same fact, and the first time the two
 * disagreed the rollback would send an operator to the wrong screen.
 *
 * ## Why a fallback and not a 404
 *
 * The obvious reading of "off" is "refuse", and it is wrong here. `off` is an
 * incident lever: the point is that the product keeps working on the bodies it
 * worked on before. `app/(dashboard)/platforms/meta/launchpad/page.tsx` already
 * says this in as many words — *"`off` is the rollback, and a rollback that
 * still forwards to the canonical route is not one"* — and falls through to the
 * legacy body. This makes the canonical family behave the same way round.
 *
 * ## Why there is no loop
 *
 * Both halves consult the SAME predicate, so they can never both want to move:
 *
 *   enabled  → legacy path redirects to canonical; canonical renders.  One hop.
 *   disabled → canonical redirects to legacy; legacy renders.          One hop.
 *
 * A loop needs the two halves to disagree, and they cannot: `canonicalEnabled`
 * below is the only rule either side uses. `canonical-fallback.test.ts` proves
 * this against the real table rather than asserting it here.
 *
 * ## Surfaces with no legacy owner
 *
 * Eight canonical paths never existed before the canonical UI, so there is
 * nothing to fall back TO — Account Intelligence, Briefs, the Shares ledger and
 * five others. Sending those to a neighbouring legacy screen would answer a
 * question about one surface with another surface's data, which is the defect
 * D6 and D8 both exist to prevent. They resolve to `rolled-back` instead: the
 * route says plainly that this surface exists only in the new console and that
 * the workspace is currently rolled back. A named refusal, not a redirect and
 * not a blank page.
 */
import { COMPATIBILITY_TABLE } from "@/lib/zero-base/compatibility";
import {
  isZeroBaseUiEnabledForBusiness,
  type ZeroBaseRolloutConfig,
} from "@/lib/zero-base/rollout";

/**
 * The canonical template a `/app` sub-path corresponds to.
 *
 * A TEMPLATE, not a concrete path: `reports/[reportId]`, never `reports/rep_1`.
 * The distinction matters because a concrete path finds no entry and would
 * quietly resolve to `rolled-back` — a surface that HAS a legacy owner being
 * refused instead of redirected. The call site has just dispatched on the path,
 * so it knows which template matched; `canonical-fallback.test.ts` pins the
 * concrete-path behaviour so the contract is written down rather than assumed.
 */
export function canonicalTemplateForAppPath(appPath: string): string {
  return `/c/[businessId]/${appPath.replace(/^\/+/, "")}`;
}

/**
 * Two legacy paths can share one canonical destination, and the fallback has to
 * pick one.
 *
 * Both live cases are a hub and one of its tabs collapsing into a single
 * canonical screen — `/insights` with `/insights/analytics`, `/platforms/google`
 * with `/platforms/google/pulse`. The hub is the honest landing place: it is
 * where the operator would have started, and it still reaches the tab. Chosen
 * by shortest path so the rule is mechanical rather than a list that has to be
 * maintained alongside the registry.
 */
function preferredLegacyRoute(routes: readonly string[]): string {
  return [...routes].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
}

/** Canonical template → the preserved legacy route that still renders it. */
export const CANONICAL_FALLBACK_BY_TEMPLATE: ReadonlyMap<string, string> = (() => {
  const byCanonical = new Map<string, string[]>();
  for (const target of COMPATIBILITY_TABLE) {
    // Business-scoped only. `/ops/**` and `/me/**` are not in the `/app`
    // family, and the `/settings` split asks rather than resolving to one.
    if (target.scope !== "business") continue;
    if (target.canonicalUrls.length !== 1) continue;
    const canonical = target.canonicalUrls[0]!;
    byCanonical.set(canonical, [...(byCanonical.get(canonical) ?? []), target.route]);
  }
  return new Map(
    [...byCanonical.entries()].map(([canonical, routes]) => [
      canonical,
      preferredLegacyRoute(routes),
    ]),
  );
})();

export type CanonicalFallback =
  /** The canonical owner renders. Nothing changes. */
  | { kind: "canonical" }
  /** Move, exactly once, to the preserved legacy owner. */
  | {
      kind: "legacy";
      destination: string;
      reason: "mode-off" | "not-enabled";
    }
  /**
   * Rolled back, and this surface has no earlier body to roll back to. The
   * route states that rather than redirecting to a different screen.
   */
  | { kind: "rolled-back"; reason: "mode-off" | "not-enabled" };

/**
 * Is the canonical UI presented for this business?
 *
 * The single rule both directions use. Presentation only: every branch here has
 * already passed authorization, a `false` renders a different body rather than
 * refusing anything, and a `true` grants nothing that was not already allowed.
 */
export function canonicalEnabled(
  config: ZeroBaseRolloutConfig,
  businessId: string | null,
): boolean {
  return isZeroBaseUiEnabledForBusiness(config, businessId);
}

function withSearch(path: string, search: string | undefined): string {
  const query = (search ?? "").replace(/^\?/, "");
  return query ? `${path}?${query}` : path;
}

/**
 * Fill `[businessId]` and any other dynamic segment in a legacy route.
 *
 * A legacy route may carry its own parameters — `/reports/[reportId]` — and the
 * caller knows them because it just resolved the canonical path. A segment with
 * no value is a route that cannot be built, and that resolves to `rolled-back`
 * rather than to a URL with a literal `[reportId]` in it.
 */
function fillLegacyRoute(
  route: string,
  params: Readonly<Record<string, string>>,
): string | null {
  let ok = true;
  const filled = route.replace(/\[([^\]]+)\]/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") {
      ok = false;
      return "";
    }
    return encodeURIComponent(value);
  });
  return ok ? filled : null;
}

/**
 * What a request to `/app/<appPath>` should do under the current rollout mode.
 *
 * `businessId` is the session's active business, already authorized by the
 * caller. It is used for the allowlist decision and never disclosed: this
 * function returns a legacy path, and a legacy path carries no tenant id.
 */
export function resolveCanonicalFallback(input: {
  /**
   * The `/app` sub-path AS A TEMPLATE, e.g. `meta/decisions` or
   * `reports/[reportId]`. The caller has just dispatched on this path, so it
   * knows which template matched; passing the concrete path instead would find
   * no reverse entry and refuse a surface that has a perfectly good legacy
   * owner.
   */
  appPath: string;
  config: ZeroBaseRolloutConfig;
  businessId: string | null;
  /** Dynamic segments the caller already resolved, e.g. `{ reportId }`. */
  params?: Readonly<Record<string, string>>;
  /** The original query string, preserved verbatim across the hop. */
  search?: string;
}): CanonicalFallback {
  if (canonicalEnabled(input.config, input.businessId)) return { kind: "canonical" };

  const reason = input.config.uiMode === "off" ? "mode-off" : "not-enabled";
  const legacyRoute = CANONICAL_FALLBACK_BY_TEMPLATE.get(
    canonicalTemplateForAppPath(input.appPath),
  );
  if (!legacyRoute) return { kind: "rolled-back", reason };

  const destination = fillLegacyRoute(legacyRoute, input.params ?? {});
  if (!destination) return { kind: "rolled-back", reason };

  return { kind: "legacy", destination: withSearch(destination, input.search), reason };
}
