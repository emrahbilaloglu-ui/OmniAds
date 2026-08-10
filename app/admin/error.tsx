"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Admin error boundary.
 *
 * Without one, a render error here falls through to Next's unstyled crash
 * screen — on the console an operator opens precisely when something is already
 * broken. This is an operator-only surface, so it shows the cause and the
 * digest: the person reading it is the person who has to fix it, and hiding the
 * reason from them only costs a round of guessing.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin-error]", {
      message: error.message,
      name: error.name,
      digest: error.digest ?? null,
    });
  }, [error]);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 rounded-xl border bg-card p-6">
      <h2 className="text-lg font-semibold">This admin page failed to load</h2>
      <p className="text-sm text-muted-foreground">
        The console itself hit an error. The cause is below so it can be acted on directly.
      </p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs">
        {error.message || "No error message was provided."}
      </pre>
      {error.digest ? (
        <p className="text-xs text-muted-foreground">
          Digest <span className="font-mono">{error.digest}</span> — use this to find the
          matching server log entry.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button onClick={() => reset()}>Try again</Button>
        <Button variant="outline" onClick={() => (window.location.href = "/admin")}>
          Back to admin
        </Button>
      </div>
    </div>
  );
}
