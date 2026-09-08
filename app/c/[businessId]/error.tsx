"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  isRecoverableRouteLoadError,
  recoverRouteLoadOnce,
} from "@/lib/client/recoverable-route-error";

/**
 * Per-business workspace error boundary.
 *
 * `app/c/**` is a SIBLING of `app/(dashboard)/**`, not a descendant, so
 * `app/(dashboard)/error.tsx` never covered it and there is no root
 * `app/error.tsx` to fall back on. Every route in this tree — meta, google,
 * creative, analytics, reports, home, manage, klaviyo — therefore had no
 * bounded error state at all: a throw anywhere below reached Next's default
 * crash screen, inside a shell whose chrome had already painted.
 *
 * WHY THIS SEGMENT AND NOT `app/c/error.tsx`
 *
 * A segment's `error.tsx` wraps that segment's page and everything nested
 * below it, but NOT the segment's own `layout.tsx` — a layout's throw bubbles
 * to the PARENT boundary. That is the whole trade-off, and it cuts both ways:
 *
 *  - Placed here, `app/c/[businessId]/layout.tsx` stays mounted while this
 *    renders, so the bounded state appears inside `UnifiedDashboardClientShell`
 *    with the rail, topbar and workspace switcher intact. Placed at `app/c/`,
 *    the shell would be unmounted and the operator would land on a bare page
 *    with no navigation out except the browser — which is the "blank shell"
 *    outcome this boundary exists to prevent.
 *  - Placed here, `businessId` is a parameter of THIS segment, so `useParams()`
 *    returns the id the router actually resolved. At `app/c/` the id would have
 *    to be re-derived by string-slicing `usePathname()` — inventing scope from
 *    the URL, which the surfaces below deliberately refuse to do.
 *
 * The cost, stated plainly: a throw inside `app/c/[businessId]/layout.tsx`
 * itself — the access resolution, `listUserBusinesses`, or either
 * `readProviderScopeCatalog` call — is NOT caught here. It bubbles past this
 * boundary, and with no `app/c/error.tsx` and no root `app/error.tsx` it still
 * reaches Next's default screen. Closing that needs a second boundary above
 * this one; it is a strictly smaller hole than the one this file closes, and
 * it is not fixable from inside this segment.
 *
 * WHAT IT SHOWS
 *
 * The error's text is logged and never rendered. `lib/api/meta.ts` strips
 * credential-bearing query parameters (`access_token` among them) from the
 * URLs it puts into its own receipts, but a boundary cannot know that the
 * error it caught came through that path — an undici `TypeError: fetch failed`
 * carries its request in `cause`, and this is a business-scoped surface where
 * an unfiltered message can also carry account names and ids. `app/admin`
 * prints the cause because its only audience is the operator who has to fix
 * it; this tree is not that surface, so it holds the same line as
 * `app/(dashboard)/error.tsx` and prints nothing from the error but its digest,
 * which is an opaque hash Next generates for log correlation.
 */
export default function ClientWorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams<{ businessId?: string | string[] }>();
  const businessId = readBusinessId(params?.businessId);
  const recoverableRouteLoad = isRecoverableRouteLoadError(error);

  useEffect(() => {
    console.error("[client-workspace-error]", {
      message: error.message,
      name: error.name,
      digest: error.digest ?? null,
      recoverableRouteLoad,
    });
    recoverRouteLoadOnce(error, "client-workspace-error-boundary");
  }, [error, recoverableRouteLoad]);

  /*
   * The dashboard boundary's second affordance is "Back to overview" →
   * `/overview`. That is the wrong destination from here:
   * `lib/zero-base/generated-contracts.ts` records `/overview` as a legacy
   * redirect route FOR the `L-C-HOME` leaf `/c/[businessId]/home`, so sending
   * an operator there is a detour through the family they were just ejected
   * from. This shell's answer is the leaf itself, scoped to the business the
   * router resolved. When that id is missing the link is not guessed: the
   * workspace chooser is the honest destination, and it is already the
   * fallback `app/app/layout.tsx` redirects to when no business is active.
   */
  const homeHref = businessId
    ? `/c/${encodeURIComponent(businessId)}/home`
    : "/select-business";

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 rounded-xl border bg-card p-6">
      <h2 className="text-lg font-semibold">
        {recoverableRouteLoad ? "Refreshing this page" : "This page is temporarily unavailable"}
      </h2>
      <p className="text-sm text-muted-foreground">
        {recoverableRouteLoad
          ? "A stale app asset was detected after an update. The page will reload once automatically."
          : "We could not load this part of the workspace right now. The rest of it is still available."}
      </p>
      {error.digest ? (
        <p className="text-xs text-muted-foreground">
          Reference <span className="font-mono">{error.digest}</span> — quote this to match the
          server log entry.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button onClick={() => (recoverableRouteLoad ? window.location.reload() : reset())}>
          {recoverableRouteLoad ? "Reload page" : "Try again"}
        </Button>
        <Button variant="outline" onClick={() => (window.location.href = homeHref)}>
          {businessId ? "Back to workspace home" : "Choose a workspace"}
        </Button>
      </div>
    </div>
  );
}

/**
 * `useParams()` types a dynamic segment as `string | string[]`. `[businessId]`
 * is a single segment so the array arm is unreachable in this route, but a
 * value that is neither is treated as absent rather than coerced — a link
 * built from `String(undefined)` would point at `/c/undefined/home`.
 */
function readBusinessId(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) {
    return value[0];
  }
  return null;
}
