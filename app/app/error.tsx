"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  isRecoverableRouteLoadError,
  recoverRouteLoadOnce,
} from "@/lib/client/recoverable-route-error";

/**
 * Workspace error boundary for the route family operators actually browse.
 *
 * WHY THIS EXISTS SEPARATELY FROM `app/c/[businessId]/error.tsx`.
 *
 * `navHref` rewrites every rail and drawer link
 * from `/c/[businessId]/…` to `/app/…`, deliberately, so the business id stops
 * appearing in the URL. `app/app/[[...path]]/page.tsx` then dynamically imports
 * the SAME page modules out of `app/c/[businessId]/**` and renders them under
 * this segment's own `app/app/layout.tsx`.
 *
 * Route boundaries are not inherited across that jump: `app/app` is a sibling
 * of `app/c`, so the boundary at `app/c/[businessId]/error.tsx` covers the
 * `/c/**` spelling of a page and NOT the `/app/**` spelling of the very same
 * page. Without this file the higher-traffic half of the product — the half
 * every in-product link points at — still reached Next's default crash screen.
 * Two spellings of one page need two boundaries, or the covered one is the one
 * nobody opens.
 *
 * WHY THE AFFORDANCE DIFFERS.
 *
 * The `/c/**` boundary reads `businessId` off `useParams()` and offers that
 * workspace's own home. Here there is deliberately no id in the route — this
 * family is session-scoped — so `useParams()` has nothing to give and slicing
 * one out of the path would invent the scope this spelling exists to hide.
 * `/app/home` is the family's own leaf and is already what
 * `app/app/layout.tsx` sends an operator to when it has to re-resolve access
 * (`/select-business?next=/app/home`, `/login?next=/app/home`), so it is the
 * destination that agrees with the rest of the shell rather than a new guess.
 *
 * WHAT IT SHOWS. The same line as its sibling: the error's text is logged and
 * never rendered, and only `error.digest` — an opaque hash Next generates for
 * log correlation — reaches the DOM. A message caught here can carry account
 * names, ids, or a `cause` chain holding the request of a failed Graph fetch.
 *
 * WHAT IT STILL DOES NOT COVER. A throw inside `app/app/layout.tsx` itself
 * bubbles PAST this boundary to the parent, and there is no root
 * `app/error.tsx`. That hole is smaller than the one this closes and cannot be
 * closed from inside this segment.
 */
export default function WorkspaceRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const recoverableRouteLoad = isRecoverableRouteLoadError(error);

  useEffect(() => {
    console.error("[workspace-route-error]", {
      message: error.message,
      name: error.name,
      digest: error.digest ?? null,
      recoverableRouteLoad,
    });
    recoverRouteLoadOnce(error, "workspace-route-error-boundary");
  }, [error, recoverableRouteLoad]);

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
        <Button variant="outline" onClick={() => (window.location.href = "/app/home")}>
          Back to workspace home
        </Button>
      </div>
    </div>
  );
}
