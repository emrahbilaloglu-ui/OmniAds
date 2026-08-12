/**
 * WP-27A — the server compatibility page every changed legacy path becomes.
 *
 * Each of the 46 shims is three lines: import the preserved legacy body, name
 * the route, export what this returns. All of the behaviour lives here so the
 * shims cannot drift from each other, and so "what does a legacy URL do now"
 * has one answer to read.
 *
 * ## Why the legacy body moved to its own module
 *
 * Fifteen canonical `/ops/**` pages mount the legacy `/admin/**` page module
 * directly — that is how the migration avoided duplicating operational logic.
 * If `app/admin/x/page.tsx` became a shim in place, `/ops/x` would import the
 * shim, the shim would redirect to `/ops/x`, and the two would bounce forever.
 * So each legacy body is preserved at `legacy-page.tsx` and both sides import
 * *that*: the canonical page mounts the body, the shim decides. The loop is
 * removed by construction rather than by being careful.
 *
 * ## Ordering
 *
 * `off` returns the legacy body before a session is read, before the database
 * is touched, before anything that can throw. That is what makes rollback a
 * flag change rather than a deploy.
 *
 * Every other mode resolves the actor first — session, staff status, active
 * business, membership and role through the same authorizer the canonical
 * pages use — and only then asks whether to move. A redirect issued before
 * that would answer "does this tenant exist" with a `Location` header.
 */
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { authorizeBusiness } from "@/lib/access/authorize-business";
import { isSuperadmin } from "@/lib/admin-auth";
import {
  compatibilityTargetFor,
  decideCompatibility,
  type CompatibilityActor,
  type CompatibilityDecision,
  type CompatibilityTarget,
} from "@/lib/zero-base/compatibility";
import { readZeroBaseRolloutConfig } from "@/lib/zero-base/rollout";
import { recordCompatibilityDecision } from "@/lib/zero-base/compatibility-observability";
import { SettingsChooser } from "@/components/zero-base/compatibility/settings-chooser";

/** Next passes both of these as promises. */
export interface LegacyPageProps {
  params?: Promise<Record<string, string | string[] | undefined>>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/** Only single-valued segments can key a canonical URL. */
async function resolveParams(props: LegacyPageProps): Promise<Record<string, string>> {
  const raw = (await props.params) ?? {};
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") resolved[key] = value;
  }
  return resolved;
}

/**
 * The original query, rebuilt from what Next parsed.
 *
 * Old bookmarks carry ranges, cursors and OAuth `code`/`state`; dropping them
 * would turn a working link into a different page. Repeated keys are preserved
 * in order, because `?provider=a&provider=b` is not the same request as one of
 * them.
 */
async function resolveSearch(props: LegacyPageProps): Promise<string> {
  const raw = (await props.searchParams) ?? {};
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") query.append(key, value);
    else if (Array.isArray(value)) for (const item of value) query.append(key, item);
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

/** Resolves exactly the facts the decision needs, and nothing else. */
export async function resolveCompatibilityActor(
  target: CompatibilityTarget,
): Promise<CompatibilityActor> {
  const session = await getSessionFromCookies();
  if (!session) return { kind: "anonymous" };

  // Read from the users table, the same source the admin API guard uses —
  // never inferred from an email pattern.
  const superadmin = await isSuperadmin(session.user.id);
  const activeBusinessId = session.activeBusinessId;

  if (target.scope !== "business") {
    return { kind: "authenticated", superadmin, activeBusinessId, businessAccess: "none" };
  }

  if (!activeBusinessId) {
    return { kind: "authenticated", superadmin, activeBusinessId: null, businessAccess: "none" };
  }

  // The same authorizer the canonical page would use, so the shim is not a
  // softer door into the same data.
  const outcome = await authorizeBusiness({ session, businessId: activeBusinessId });
  const businessAccess =
    outcome.kind === "authorized"
      ? "authorized"
      : outcome.kind === "insufficient_role"
        ? "forbidden"
        : outcome.kind === "schema_unavailable"
          ? "unavailable"
          : "not-found";

  return { kind: "authenticated", superadmin, activeBusinessId, businessAccess } as const;
}

/**
 * Turns a decision into what the page actually does.
 *
 * `forbidden` and `unavailable` render the preserved legacy body rather than
 * refusing. The shim decides *presentation*, and when the canonical surface
 * cannot be presented to this actor the honest fallback is what they already
 * have today — it neither grants access the legacy page would have refused nor
 * removes access it would have allowed. `not-found` does refuse, because it
 * covers a revoked or foreign membership, where rendering anything would be a
 * cross-tenant answer.
 */
function applyDecision(
  decision: CompatibilityDecision,
  legacy: () => ReactNode,
): ReactNode {
  switch (decision.kind) {
    case "legacy":
      return legacy();
    case "redirect":
      // Next's `redirect` is a 307 by default in a server component: temporary,
      // method-preserving and never cached by the browser as permanent.
      redirect(decision.destination);
    // eslint-disable-next-line no-fallthrough
    case "login":
      redirect(decision.destination);
    // eslint-disable-next-line no-fallthrough
    case "select-business":
      redirect("/select-business");
    // eslint-disable-next-line no-fallthrough
    case "not-found":
      notFound();
    // eslint-disable-next-line no-fallthrough
    case "forbidden":
    case "unavailable":
      return legacy();
    case "chooser":
      return <SettingsChooser destinations={decision.destinations} />;
  }
}

/**
 * Builds the server page for one changed legacy path.
 *
 * @param route  the legacy path exactly as the route registry spells it
 * @param Legacy the preserved legacy body, mounted unchanged
 */
/**
 * A preserved legacy body.
 *
 * Some of them do not render at all — a handful of legacy pages are themselves
 * a `redirect()` to a sibling, which types as `void`. That behaviour is part of
 * what `off` has to reproduce, so the signature admits it rather than forcing
 * those pages to be rewritten into something they were not.
 */
export type LegacyBodyComponent = (props: never) => ReactNode | void;

export function compatibilityPage(route: string, Legacy: LegacyBodyComponent) {
  const target = compatibilityTargetFor(route);

  return async function CompatibilityPage(props: LegacyPageProps) {
    const config = readZeroBaseRolloutConfig();
    // The body is mounted exactly as it was, props untouched.
    const LegacyBody = Legacy as unknown as (props: LegacyPageProps) => ReactNode;
    const renderLegacy = () => <LegacyBody {...props} />;

    // Rollback path: nothing above this line can fail.
    if (config.uiMode === "off") {
      recordCompatibilityDecision({ route, mode: "off", scope: target.scope, decision: "legacy" });
      return renderLegacy();
    }

    const [params, search, actor] = await Promise.all([
      resolveParams(props),
      resolveSearch(props),
      resolveCompatibilityActor(target),
    ]);

    const decision = decideCompatibility({ target, config, actor, params, search });
    recordCompatibilityDecision({
      route,
      mode: config.uiMode,
      scope: target.scope,
      decision: decision.kind,
    });
    return applyDecision(decision, renderLegacy);
  };
}
