"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  isRecoverableRouteLoadError,
  recoverRouteLoadOnce,
} from "@/lib/client/recoverable-route-error";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const recoverableRouteLoad = isRecoverableRouteLoadError(error);

  useEffect(() => {
    console.error("[dashboard-error]", {
      message: error.message,
      name: error.name,
      digest: error.digest ?? null,
      recoverableRouteLoad,
    });
    recoverRouteLoadOnce(error, "dashboard-error-boundary");
  }, [error, recoverableRouteLoad]);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 rounded-xl border bg-card p-6">
      <h2 className="text-lg font-semibold">
        {recoverableRouteLoad ? "Refreshing this page" : "This page is temporarily unavailable"}
      </h2>
      <p className="text-sm text-muted-foreground">
        {recoverableRouteLoad
          ? "A stale app asset was detected after an update. The page will reload once automatically."
          : "We could not load this section right now. Please try again."}
      </p>
      <div className="flex gap-2">
        <Button onClick={() => (recoverableRouteLoad ? window.location.reload() : reset())}>
          {recoverableRouteLoad ? "Reload page" : "Try again"}
        </Button>
        <Button variant="outline" onClick={() => (window.location.href = "/overview")}>
          Back to overview
        </Button>
      </div>
    </div>
  );
}
