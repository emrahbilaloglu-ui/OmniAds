/**
 * Compatibility shim for `/platforms/meta/launchpad` (WP-27A).
 *
 * The legacy body is preserved verbatim at `./legacy-page` and mounted
 * unchanged whenever the canonical UI is not being presented — which is what
 * makes `ZERO_BASE_UI_MODE=off` a rollback rather than a redeploy. Every other
 * decision, and the ordering that keeps it safe, lives in one module.
 *
 * @see lib/zero-base/compatibility-page.tsx
 *
 * ## The one thing this route decides for itself: `?handoff=`
 *
 * A Launchpad handoff can only be consumed by the canonical route. The consume
 * is a server-side, single-use, session-scoped read
 * (`landLaunchpadHandoff`), and the preserved legacy body is a client
 * component with no session, no assignment-verified account and no way to burn
 * a token — so a handoff reference arriving here would previously have been
 * dropped on the floor in every rollout mode that renders the legacy body
 * (`off`, `internal`, a non-allowlisted business under `allowlist`, and a
 * `schema_unavailable` authorization under `on`). The operator would land on a
 * blank wizard and read it as success.
 *
 * So when — and only when — a handoff reference is present, this route carries
 * the whole query to the canonical route and lets THAT route re-verify and
 * consume it. That is a redirect, not a grant: it moves the request to the one
 * place that can check it, and every check still happens there.
 *
 * If no business can be resolved for the session, the redirect has no
 * destination. The request then falls through to the ordinary compatibility
 * decision, and the legacy body states plainly that the reference could not be
 * consumed rather than opening a wizard that carries nothing.
 */
import { redirect } from "next/navigation";

import { getSessionFromCookies } from "@/lib/auth";
import { readZeroBaseRolloutConfig } from "@/lib/zero-base/rollout";
import {
  compatibilityPage,
  type LegacyPageProps,
} from "@/lib/zero-base/compatibility-page";
import { loginUrlFor } from "@/lib/zero-base/auth-routing";
import LegacyBody from "./legacy-page";

// The shim reads the session before deciding, so this segment is never static.
export const dynamic = "force-dynamic";

const CompatibilityLaunchpadPage = compatibilityPage(
  "/platforms/meta/launchpad",
  LegacyBody,
);

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The original query, rebuilt from what Next parsed.
 *
 * Rebuilt rather than forwarded as a string so repeated keys keep their order
 * and nothing is silently dropped.
 */
function serializeQuery(
  raw: Record<string, string | string[] | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") query.append(key, value);
    else if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    }
  }
  return query.toString();
}

export default async function MetaLaunchpadCompatibilityPage(
  props: LegacyPageProps,
) {
  const raw = (await props.searchParams) ?? {};
  const handoff = firstValue(raw.handoff)?.trim();
  // `off` is the rollback, and a rollback that still forwards to the
  // canonical route is not one. Under `off` the reference falls through to
  // the legacy body, which states that it could not be consumed — an honest
  // refusal beats a redirect that quietly leaves the mode the operator rolled
  // back to. The mode is read from the one module that owns it, never
  // re-derived here.
  const rolledBack = readZeroBaseRolloutConfig().uiMode === "off";
  if (handoff && !rolledBack) {
    const query = serializeQuery(raw);
    const session = await getSessionFromCookies();
    if (!session) {
      // The reference rides through the login round-trip in `next`, exactly as
      // the ordinary compatibility path preserves a query. Dropping it here
      // would spend the operator's sign-in and then land them on a Launchpad
      // that had forgotten what they clicked. It is still only a reference:
      // `next` is sanitized on the way back and the canonical route verifies
      // every part of the handoff itself.
      redirect(
        loginUrlFor(
          query
            ? `/platforms/meta/launchpad?${query}`
            : "/platforms/meta/launchpad",
        ),
      );
    }
    const businessId = session.activeBusinessId;
    if (businessId) {
      // The reference travels unchanged: it is still only a reference, and the
      // canonical route still has to verify every part of it.
      redirect(`/c/${businessId}/meta/launchpad?${query}`);
    }
  }
  return CompatibilityLaunchpadPage(props);
}
