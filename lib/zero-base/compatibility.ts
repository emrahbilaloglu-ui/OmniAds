/**
 * WP-27A — the compatibility decision, as data rather than as 46 opinions.
 *
 * Every changed legacy path is wrapped by a server page that asks this module
 * one question: given the rollout mode and who is asking, does this request
 * render the preserved legacy body or move to the canonical URL? The table is
 * derived from `CHANGED_MAPPINGS`, so a mapping cannot be added to the route
 * registry and quietly miss a shim — the count is asserted, not hoped for.
 *
 * Two orderings carry the whole safety argument.
 *
 * **`off` is answered before anything else.** Rollback has to be a flag change
 * that cannot fail: no session read, no database, no authorization, nothing
 * that could throw between the flag and the legacy body. That is what makes
 * `ZERO_BASE_UI_MODE=off` an incident response rather than a deploy.
 *
 * **Nothing redirects before authorization.** A redirect that runs first would
 * answer "does this business exist" and "may I see it" with a `Location`
 * header, for anyone who can type a URL. So the actor is resolved, membership
 * and role are checked, and dynamic ids are resolved, and only then does the
 * mode decide. An unauthenticated caller goes to login carrying where they
 * were headed; an out-of-scope one gets the same not-found a direct canonical
 * request would give them, which is the point — the two must be
 * indistinguishable.
 *
 * The redirect is a 307 and always exactly one hop: destinations are canonical
 * URLs, and a canonical URL is never itself a legacy path, so a shim cannot
 * hand off to another shim. `noLoop` proves that against the table instead of
 * asserting it in prose.
 */
import {
  CHANGED_MAPPINGS,
  UNIQUE_CHANGED_PATHS,
  type LeafId,
} from "@/lib/zero-base/route-registry";
import { isPublicPagePath } from "@/lib/public-page-prefixes";
import {
  isZeroBaseUiEnabledForBusiness,
  isZeroBaseUiEnabledForInternal,
  type ZeroBaseRolloutConfig,
} from "@/lib/zero-base/rollout";

/**
 * What has to be true before a path may move.
 *
 * Derived from the canonical URL, never hand-listed: `/ops/**` is staff-only,
 * `/me/**` needs a session and no business, `/c/[businessId]/**` needs an
 * authorized membership, and a path with two canonical destinations is the
 * split that has to ask rather than choose.
 */
export type CompatibilityScope = "ops" | "account" | "business" | "split";

export interface CompatibilityTarget {
  /** The legacy path, exactly as the registry spells it. */
  readonly route: string;
  readonly scope: CompatibilityScope;
  /** One destination, or two for the split. */
  readonly canonicalUrls: readonly string[];
  readonly leaves: readonly LeafId[];
  /**
   * Reachable today without an account.
   *
   * `/select-language` is the one: it is public at the edge and its canonical
   * home `/me/language` is not, so an anonymous visitor must keep getting the
   * page rather than a trip to login they never needed before.
   */
  readonly publicToday: boolean;
}

function scopeFor(canonicalUrls: readonly string[]): CompatibilityScope {
  if (canonicalUrls.length > 1) return "split";
  const url = canonicalUrls[0]!;
  if (url.startsWith("/ops")) return "ops";
  if (url.startsWith("/me/")) return "account";
  if (url.startsWith("/c/")) return "business";
  throw new Error(`compatibility: no scope rule for canonical URL ${url}`);
}

export const COMPATIBILITY_TABLE: readonly CompatibilityTarget[] = UNIQUE_CHANGED_PATHS.map(
  (route) => {
    const records = CHANGED_MAPPINGS.filter((mapping) => mapping.route === route);
    const generatedCanonicalUrls = [...new Set(records.map((record) => record.canonicalUrl))];
    // Dashboard v2 restores Audiences as the fifth Creative Studio view. The
    // archived zero-base package predates that exact screen and marked the
    // legacy URL as merged into Meta Intelligence. Keep the generated package
    // immutable, but route this one compatibility spelling to the live screen
    // registry contract used by every other Creative Studio tab.
    //
    // Ratified as `docs/adr-004-meta-audiences-destination.md` (Accepted
    // 2026-08-22). The generated `mode: "merged"` record is a dated screen
    // inventory, not an instruction, and it loses to the visual authority on
    // the question of which screens exist — see
    // `docs/adr-005-visual-vs-vendored-authority.md` rule 4. Do NOT resolve the
    // divergence by editing `generated-contracts.ts`; it is vendored, and the
    // master plan's §17.1 forbids hand-editing it. Removing this override is
    // the documented rollback for ADR-004.
    const canonicalUrls =
      route === "/platforms/meta/audiences"
        ? ["/c/[businessId]/creative/audiences"]
        : generatedCanonicalUrls;
    return {
      route,
      scope: scopeFor(canonicalUrls),
      canonicalUrls,
      leaves: [...new Set(records.map((record) => record.leaf))],
      publicToday: isPublicPagePath(route),
    };
  },
);

const TARGET_BY_ROUTE = new Map(COMPATIBILITY_TABLE.map((target) => [target.route, target]));

export function compatibilityTargetFor(route: string): CompatibilityTarget {
  const target = TARGET_BY_ROUTE.get(route);
  if (!target) throw new Error(`compatibility: ${route} is not a changed legacy path`);
  return target;
}

/**
 * Who is asking, reduced to only what the decision needs.
 *
 * Deliberately not the session object. This module must not be able to read a
 * token, an email or a tenant name, so it cannot leak one into a destination
 * or a log line.
 */
export type CompatibilityActor =
  | { kind: "anonymous" }
  | {
      kind: "authenticated";
      /** Staff, for `/ops/**`. */
      superadmin: boolean;
      /** The session's active business, already proven to belong to this actor. */
      activeBusinessId: string | null;
      /** How the shared authorizer answered for that business. */
      businessAccess: "authorized" | "not-found" | "forbidden" | "unavailable" | "none";
    };

export type CompatibilityDecision =
  /** Render the preserved legacy body. */
  | { kind: "legacy"; reason: "mode-off" | "not-enabled" }
  | { kind: "redirect"; destination: string }
  /** Sign in first, then come back here. */
  | { kind: "login"; destination: string }
  /** Signed in, but no business is selected to move to. */
  | { kind: "select-business" }
  /** Indistinguishable from "this business does not exist". */
  | { kind: "not-found" }
  /** Authenticated and in scope, but the leaf needs a higher role. */
  | { kind: "forbidden" }
  /** Schema not migrated: an explicit unavailable, never an empty page. */
  | { kind: "unavailable" }
  /** `/settings` asks rather than guessing which half was meant. */
  | { kind: "chooser"; destinations: readonly string[] };

export interface CompatibilityInput {
  target: CompatibilityTarget;
  config: ZeroBaseRolloutConfig;
  actor: CompatibilityActor;
  /** Resolved dynamic segments, e.g. `{ reportId: "rep_1" }`. */
  params?: Readonly<Record<string, string>>;
  /** The original query string, with or without `?`. Never re-encoded. */
  search?: string;
}

/**
 * `/c/[businessId]/reports/[reportId]` + ids → a real URL.
 *
 * A route parameter always wins over the session's business, and the reason is
 * `/admin/businesses/[businessId]` → `/ops/businesses/[businessId]`: there the
 * id in the path is the tenant a staff operator is looking *at*, not the one
 * they are working *in*. Substituting the session's business would silently
 * redirect an admin away from the business they asked for and into their own —
 * a wrong page that looks like it worked. The session's business fills
 * `[businessId]` only for client-scoped URLs, where the path carries no such
 * segment to take it from.
 */
export function fillCanonicalUrl(
  template: string,
  businessId: string | null,
  params: Readonly<Record<string, string>>,
): string {
  return template.replace(/\[([^\]]+)\]/g, (_match, name: string) => {
    const fromPath = params[name];
    if (fromPath !== undefined && fromPath !== "") return encodeURIComponent(fromPath);
    if (name === "businessId") {
      if (!businessId) throw new Error("compatibility: canonical URL needs a business id");
      return encodeURIComponent(businessId);
    }
    throw new Error(`compatibility: canonical URL needs a value for [${name}]`);
  });
}

function withSearch(path: string, search: string | undefined): string {
  const query = (search ?? "").replace(/^\?/, "");
  return query ? `${path}?${query}` : path;
}

/** Login, carrying where the caller was actually trying to go. */
export function loginDestination(path: string, search: string | undefined): string {
  return `/login?next=${encodeURIComponent(withSearch(path, search))}`;
}

/**
 * Is the canonical UI presented for this request?
 *
 * Presentation only. Every one of these branches has already passed
 * authorization; a `false` here renders the legacy body, it does not refuse
 * anything, and a `true` grants nothing that was not already permitted.
 */
function canonicalUiEnabled(
  scope: CompatibilityScope,
  config: ZeroBaseRolloutConfig,
  businessId: string | null,
): boolean {
  switch (scope) {
    case "ops":
    case "account":
    case "split":
      // Staff and account surfaces belong to the person, not to a client, so
      // they follow the internal gate: `internal` and `on`, never `allowlist`
      // alone — an allowlist names businesses and these have none.
      return isZeroBaseUiEnabledForInternal(config);
    case "business":
      return isZeroBaseUiEnabledForBusiness(config, businessId);
  }
}

export function decideCompatibility(input: CompatibilityInput): CompatibilityDecision {
  const { target, config, actor } = input;
  const params = input.params ?? {};

  // 1 · Rollback, before anything that could fail.
  if (config.uiMode === "off") return { kind: "legacy", reason: "mode-off" };

  // 2 · Who is asking. Nothing below may run for an unknown caller.
  if (actor.kind === "anonymous") {
    // A path that is public today stays public: its canonical destination
    // needs an account, so moving an anonymous visitor there would turn a
    // working page into a login wall the cutover was not meant to build.
    if (target.publicToday) return { kind: "legacy", reason: "not-enabled" };
    return { kind: "login", destination: loginDestination(target.route, input.search) };
  }

  // 3 · Scope, membership and role — the same answers a direct canonical
  //     request would get, so the shim is not a softer door.
  if (target.scope === "ops" && !actor.superadmin) return { kind: "not-found" };

  let businessId: string | null = null;
  if (target.scope === "business") {
    switch (actor.businessAccess) {
      case "none":
        // Signed in with nothing selected: choose a business, do not guess.
        return { kind: "select-business" };
      case "not-found":
        return { kind: "not-found" };
      case "forbidden":
        return { kind: "forbidden" };
      case "unavailable":
        return { kind: "unavailable" };
      case "authorized":
        if (!actor.activeBusinessId) return { kind: "select-business" };
        businessId = actor.activeBusinessId;
        break;
    }
  }

  // 4 · Presentation. Everything above has already been decided.
  if (!canonicalUiEnabled(target.scope, config, businessId)) {
    return { kind: "legacy", reason: "not-enabled" };
  }

  // 5 · The split asks; it does not pick a half on the caller's behalf.
  if (target.scope === "split") {
    return {
      kind: "chooser",
      destinations: target.canonicalUrls.map((url) =>
        url.includes("[businessId]") && actor.activeBusinessId
          ? fillCanonicalUrl(url, actor.activeBusinessId, params)
          : url,
      ),
    };
  }

  // 6 · Dynamic ids last, so a malformed one refuses rather than redirects.
  let destination: string;
  try {
    destination = fillCanonicalUrl(target.canonicalUrls[0]!, businessId, params);
  } catch {
    return { kind: "not-found" };
  }
  return { kind: "redirect", destination: withSearch(destination, input.search) };
}

/**
 * No shim can hand off to another shim.
 *
 * Proved against the table rather than stated: if any canonical destination
 * were itself a changed legacy path, a redirect would land on a second
 * redirect, and "exactly one hop" would be a claim rather than a property.
 */
export function canonicalDestinationsThatAreLegacyPaths(): string[] {
  const legacy = new Set(UNIQUE_CHANGED_PATHS);
  return COMPATIBILITY_TABLE.flatMap((target) => target.canonicalUrls).filter((url) =>
    legacy.has(url),
  );
}
